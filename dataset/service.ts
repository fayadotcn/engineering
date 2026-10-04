import { prisma } from "@database/client";
import { storage } from "@file/storage";
import { parseWorkbook } from "@file/excel";
import { parseQuotaWorkbook, type ParsedQuotaRow } from "./quotaParse";
import { parseSemanticFeature } from "@cost-engine/semantic";
import { fromJson, toJson } from "@shared/json";
import { D } from "@cost-engine/money";
import { createHash } from "node:crypto";
import {
  applySheetPatch,
  inspectWithTemplates,
  toSheetMappings,
  type SheetMeta,
} from "@file/inspection";
import {
  buildPriceRows,
  LABOR_UNIT,
  normalizePeriod,
  normalizePriceType,
  periodKey,
  type PriceDefaults,
} from "./priceParse";
import {
  applicableBrands,
  pickBestPriceRow,
  specTokens,
  type PriceCandidate,
  type PricePrefs,
} from "./priceMatch";
import { getFacts } from "@project/facts";

// 全局数据集：材料价格库 / 定额库 / 通用数据。
// 与项目内上传文件的区别——数据集跨项目共享，由后台统一管理，
// Agent 工具（定额测算/材料搜索/价格历史）直接消费这些库。
// 材料价格库走「识别 → 列映射确认 → ingest」两段式（同 file.inspect/file.ingest
// 确认门）：综合单价表不会自动进价格库（unitPrice 五要素组价结果 ≠ 材料价）。

export type DatasetKind = "MATERIAL_PRICE" | "QUOTA" | "GENERIC";

export const DATASET_KIND_LABEL: Record<DatasetKind, string> = {
  MATERIAL_PRICE: "材料价格库",
  QUOTA: "定额库",
  GENERIC: "通用数据",
};

/** Dataset.meta JSON：结构画像 + 列映射（Record<sheetName, SheetMeta>）+ 默认值 */
interface DatasetMetaJson {
  sheets?: {
    name: string;
    type: string;
    headerRow?: number;
    rows: number;
    columns?: string[];
  }[];
  mapping?: Record<string, SheetMeta>;
  defaults?: PriceDefaults;
  note?: string;
  [k: string]: unknown;
}

// 与 priceMatch.norm 同口径：分隔符 ×÷* 归一为 X（原写法 x→X 被 toUpperCase 抵消）
const norm = (s: string | null | undefined): string =>
  String(s ?? "").replace(/\s/g, "").toUpperCase().replace(/[×*]/g, "X");

const quotaRowsData = (rows: ParsedQuotaRow[], datasetId: string) =>
  rows.map((r) => ({
    datasetId,
    code: r.code,
    name: r.name,
    unit: r.unit,
    unitScale: r.unitScale,
    labor: r.labor,
    material: r.material,
    machine: r.machine,
    mainQtyPerUnit: r.mainQtyPerUnit,
    matchKeys: toJson(r.matchKeys),
    raw: toJson(r.raw),
  }));

const quotaNote = (n: number) =>
  n
    ? "定额子目已导入，匹配特征已从名称自动解析"
    : "未识别到定额表头（需要 定额编号/子目名称/人工费 等列）";

export async function createDataset(
  kind: DatasetKind,
  filename: string,
  buffer: Buffer,
  defaults?: PriceDefaults
): Promise<{ id: string; rowCount: number; status: string; duplicate?: boolean }> {
  // 同 kind 同内容重复上传不新建（数据集是整表替换语义）
  const contentHash = createHash("sha1").update(buffer).digest("hex");
  const dup = await prisma.dataset.findFirst({ where: { kind, contentHash } });
  if (dup)
    return {
      id: dup.id,
      rowCount: dup.rowCount,
      status: dup.status,
      duplicate: true,
    };

  const ext = filename.match(/\.[^.]+$/)?.[0] ?? "";
  const storageKey = await storage.put(buffer, ext || ".bin");

  const ds = await prisma.dataset.create({
    data: {
      kind,
      name: filename.replace(/\.(xlsx?|csv|pdf)$/i, ""),
      filename,
      storageKey,
      sizeBytes: buffer.length,
      contentHash,
      // 材料价格库先 PENDING：识别列映射存 meta，确认（或高置信自动放行）后 ingest 导行
      status: kind === "MATERIAL_PRICE" ? "PENDING" : "PARSED",
    },
  });

  try {
    if (kind === "MATERIAL_PRICE") {
      const meta: DatasetMetaJson = {};
      meta.mapping = await inspectWithTemplates(buffer, filename);
      meta.defaults = {
        brand: defaults?.brand?.trim() || undefined,
        region: defaults?.region?.trim() || undefined,
        period: normalizePeriod(defaults?.period) || undefined,
        priceType: normalizePriceType(defaults?.priceType) || undefined,
      };
      const targets = Object.values(meta.mapping).filter(
        (s) => s.type === "QUOTATION" || s.type === "MATERIAL_PRICE"
      );
      if (targets.length) {
        // 确认门（同 file.ingest）：模板命中/人工改过/置信≥0.9 才自动放行；
        // needsConfirm 是识别阶段的"必须让人看一眼"，不能因为模板命中就被跳过
        const certain = (s: { templateHit: boolean; userEdited: boolean; minConfidence: number; needsConfirm?: boolean }) =>
          !s.needsConfirm && (s.templateHit || s.userEdited || s.minConfidence >= 0.9);
        if (targets.every(certain)) {
          await prisma.dataset.update({
            where: { id: ds.id },
            data: { meta: toJson(meta) },
          });
          const r = await ingestDataset(ds.id);
          return r ?? { id: ds.id, rowCount: 0, status: "FAILED" };
        }
        for (const s of targets)
          if (!certain(s))
            s.needsConfirm = true;
      } else {
        meta.note =
          "未识别到询价表结构，请在列映射里确认表类型（综合单价表不会自动进价格库）";
      }
      await prisma.dataset.update({
        where: { id: ds.id },
        data: { meta: toJson(meta), status: "PENDING" },
      });
      return { id: ds.id, rowCount: 0, status: "PENDING" };
    }

    let rowCount = 0;
    const meta: DatasetMetaJson = {};

    if (kind === "QUOTA") {
      const rows = parseQuotaWorkbook(buffer);
      if (rows.length)
        await prisma.quotaRow.createMany({ data: quotaRowsData(rows, ds.id) });
      rowCount = rows.length;
      meta.note = quotaNote(rowCount);
    } else {
      // GENERIC：只存文件与结构画像，不导行
      const sheets = parseWorkbook(buffer);
      meta.sheets = sheets.map((s) => ({
        name: s.sheetName,
        type: s.type,
        rows: s.rows.length,
      }));
      rowCount = sheets.reduce((n, s) => n + s.rows.length, 0);
    }

    await prisma.dataset.update({
      where: { id: ds.id },
      data: { rowCount, meta: toJson(meta), status: "PARSED" },
    });
    return { id: ds.id, rowCount, status: "PARSED" };
  } catch (e) {
    await prisma.dataset.update({
      where: { id: ds.id },
      data: {
        status: "FAILED",
        meta: toJson({ error: e instanceof Error ? e.message : String(e) }),
      },
    });
    return { id: ds.id, rowCount: 0, status: "FAILED" };
  }
}

/**
 * 数据集导入/重导：按 meta.mapping 当前状态解析文件导行（幂等：先清行再导）。
 * MATERIAL_PRICE 走 buildPriceRows（只消费 QUOTATION sheet，BOQ 跳过留痕）；
 * QUOTA 幂等重导；GENERIC 只刷新结构画像。
 */
export async function ingestDataset(
  id: string
): Promise<{ id: string; rowCount: number; status: string } | null> {
  const ds = await prisma.dataset.findUnique({ where: { id } });
  if (!ds) return null;
  const meta = fromJson<DatasetMetaJson>(ds.meta, {});
  try {
    const buffer = await storage.get(ds.storageKey);

    if (ds.kind === "MATERIAL_PRICE") {
      const sheets = parseWorkbook(buffer, {
        mapping: meta.mapping ? toSheetMappings(meta.mapping) : undefined,
      });
      const { rows, skippedBoqSheets, skippedNoPrice } = buildPriceRows(
        sheets,
        meta.defaults ?? {},
        ds.filename
      );
      // 整表替换：重导幂等——删旧写新同事务，写失败不丢旧数据
      await prisma.$transaction(async (tx) => {
        await tx.materialPrice.deleteMany({ where: { datasetId: id } });
        if (rows.length)
          await tx.materialPrice.createMany({
            data: rows.map((r) => ({
              datasetId: id,
              name: r.name,
              spec: r.spec,
              unit: r.unit,
              brand: r.brand,
              price: r.price,
              priceType: r.priceType,
              region: r.region,
              period: r.period,
              features: r.features,
              raw: r.raw,
            })),
          });
      });
      meta.sheets = sheets.map((s) => ({
        name: s.sheetName,
        type: s.type,
        headerRow: s.headerRow + 1,
        rows: s.rows.length,
        columns: Object.entries(s.columns)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}:${(v as number) + 1}`),
      }));
      const notes: string[] = [];
      if (skippedBoqSheets.length)
        notes.push(
          `${skippedBoqSheets.length}张清单式表跳过：${skippedBoqSheets.join("、")}（综合单价≠材料价）`
        );
      if (skippedNoPrice) notes.push(`${skippedNoPrice} 行无价格跳过`);
      if (!rows.length && !skippedBoqSheets.length)
        notes.push("未识别到材料价格行（需要 名称/单价 等列）");
      meta.note = notes.join("；");

      // 模板学习（同 file.ingest）：确认过/人工改过的映射按表头指纹沉淀，下次同构表直接命中。
      // 模板写失败不该把已成功导入的行标成 FAILED——它是辅助沉淀，容错放行
      try {
        if (meta.mapping) {
          for (const s of Object.values(meta.mapping)) {
            if (!s.fingerprint) continue;
            if (s.templateHit) {
              await prisma.importTemplate.updateMany({
                where: { fingerprint: s.fingerprint },
                data: { useCount: { increment: 1 } },
              });
            } else if (s.type !== "GENERIC" && (s.needsConfirm || s.userEdited)) {
              await prisma.importTemplate.upsert({
                where: { fingerprint: s.fingerprint },
                create: {
                  fingerprint: s.fingerprint,
                  headerText: s.headerCells.join(" | "),
                  sheetType: s.type,
                  columns: toJson(s.columns),
                  useCount: 1,
                },
                update: {
                  headerText: s.headerCells.join(" | "),
                  sheetType: s.type,
                  columns: toJson(s.columns),
                  useCount: { increment: 1 },
                },
              });
            }
            s.needsConfirm = false;
          }
        }
      } catch { /* 模板沉淀失败不阻断导入结果 */ }

      await prisma.dataset.update({
        where: { id },
        data: { status: "PARSED", rowCount: rows.length, meta: toJson(meta) },
      });
      return { id, rowCount: rows.length, status: "PARSED" };
    }

    if (ds.kind === "QUOTA") {
      const rows = parseQuotaWorkbook(buffer);
      await prisma.$transaction(async (tx) => {
        await tx.quotaRow.deleteMany({ where: { datasetId: id } });
        if (rows.length)
          await tx.quotaRow.createMany({ data: quotaRowsData(rows, id) });
      });
      meta.note = quotaNote(rows.length);
      await prisma.dataset.update({
        where: { id },
        data: { status: "PARSED", rowCount: rows.length, meta: toJson(meta) },
      });
      return { id, rowCount: rows.length, status: "PARSED" };
    }

    // GENERIC：只刷新结构画像
    const sheets = parseWorkbook(buffer);
    meta.sheets = sheets.map((s) => ({
      name: s.sheetName,
      type: s.type,
      rows: s.rows.length,
    }));
    await prisma.dataset.update({
      where: { id },
      data: { meta: toJson(meta), status: "PARSED" },
    });
    return { id, rowCount: ds.rowCount, status: "PARSED" };
  } catch (e) {
    await prisma.dataset.update({
      where: { id },
      data: {
        status: "FAILED",
        meta: toJson({
          ...meta,
          error: e instanceof Error ? e.message : String(e),
        }),
      },
    });
    return { id, rowCount: 0, status: "FAILED" };
  }
}

/** 数据集列映射视图数据：meta.mapping 不存在时先识别落库 */
export async function getDatasetMapping(id: string) {
  const ds = await prisma.dataset.findUnique({ where: { id } });
  if (!ds) return null;
  const meta = fromJson<DatasetMetaJson>(ds.meta, {});
  if (!meta.mapping) {
    const buffer = await storage.get(ds.storageKey);
    meta.mapping = await inspectWithTemplates(buffer, ds.filename);
    await prisma.dataset.update({
      where: { id },
      data: { meta: toJson(meta) },
    });
  }
  return {
    id: ds.id,
    filename: ds.filename,
    name: ds.name,
    kind: ds.kind,
    status: ds.status,
    defaults: meta.defaults ?? {},
    sheets: Object.values(meta.mapping),
  };
}

/** 管理员手工修正某 sheet 的列映射/类型（与文件 PATCH /mapping 同一套 applySheetPatch） */
export async function saveDatasetMapping(
  id: string,
  sheetName: string,
  columns?: Record<string, number | null>,
  type?: Parameters<typeof applySheetPatch>[1]["type"]
) {
  const ds = await prisma.dataset.findUnique({ where: { id } });
  if (!ds) return null;
  const meta = fromJson<DatasetMetaJson>(ds.meta, {});
  if (!meta.mapping) {
    const buffer = await storage.get(ds.storageKey);
    meta.mapping = await inspectWithTemplates(buffer, ds.filename);
  }
  const sheet = meta.mapping[sheetName];
  if (!sheet) return null;
  applySheetPatch(sheet, { columns, type });
  await prisma.dataset.update({ where: { id }, data: { meta: toJson(meta) } });
  return getDatasetMapping(id);
}

/** 价格行 DTO（列表/编辑共用） */
const priceRowDTO = (r: {
  id: string;
  name: string;
  spec: string;
  unit: string;
  brand: string;
  price: unknown;
  priceType: string;
  region: string;
  period: string;
  updatedAt: Date;
}) => ({
  id: r.id,
  name: r.name,
  spec: r.spec,
  unit: r.unit,
  brand: r.brand,
  price: String(r.price),
  priceType: r.priceType,
  region: r.region,
  period: r.period,
  updatedAt: r.updatedAt.toISOString(),
});

/** 价格库行分页检索 + 维度去重值（facets 给筛选下拉用） */
export async function listPriceRows(
  datasetId: string,
  q: {
    q?: string;
    brand?: string;
    region?: string;
    period?: string;
    priceType?: string;
    page?: number;
    pageSize?: number;
  }
) {
  const ds = await prisma.dataset.findUnique({ where: { id: datasetId } });
  if (!ds) return null;
  const page = Math.max(1, Math.floor(q.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(q.pageSize ?? 50)));
  const where = {
    datasetId,
    ...(q.q
      ? {
          OR: [
            { name: { contains: q.q } },
            { spec: { contains: q.q } },
            { brand: { contains: q.q } },
          ],
        }
      : {}),
    ...(q.brand ? { brand: { contains: q.brand } } : {}),
    ...(q.region ? { region: { contains: q.region } } : {}),
    ...(q.period ? { period: { contains: q.period } } : {}),
    ...(q.priceType ? { priceType: { contains: q.priceType } } : {}),
  };
  const [total, rows, brands, regions, periods, priceTypes] = await Promise.all([
    prisma.materialPrice.count({ where }),
    prisma.materialPrice.findMany({
      where,
      orderBy: [{ period: "desc" }, { createdAt: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.materialPrice.groupBy({ by: ["brand"], where: { datasetId } }),
    prisma.materialPrice.groupBy({ by: ["region"], where: { datasetId } }),
    prisma.materialPrice.groupBy({ by: ["period"], where: { datasetId } }),
    prisma.materialPrice.groupBy({ by: ["priceType"], where: { datasetId } }),
  ]);
  return {
    total,
    page,
    pageSize,
    rows: rows.map(priceRowDTO),
    // facets 是全数据集去重值，不随筛选变化（前端筛选项契约）；期次降序便于选最新
    facets: {
      brands: brands.map((g) => g.brand).filter(Boolean).sort((a, b) => a.localeCompare(b, "zh")),
      regions: regions.map((g) => g.region).filter(Boolean).sort((a, b) => a.localeCompare(b, "zh")),
      periods: periods
        .map((g) => g.period)
        .filter(Boolean)
        .sort((a, b) => periodKey(b) - periodKey(a) || b.localeCompare(a)),
      priceTypes: priceTypes.map((g) => g.priceType).filter(Boolean).sort(),
    },
  };
}

/** 单行改价/改属性：name/spec 变了要重算语义特征（匹配依据） */
export async function updatePriceRow(
  datasetId: string,
  rowId: string,
  patch: {
    name?: string;
    spec?: string;
    unit?: string;
    brand?: string;
    price?: number | string;
    priceType?: string;
    region?: string;
    period?: string;
  }
) {
  const row = await prisma.materialPrice.findUnique({ where: { id: rowId } });
  if (!row || row.datasetId !== datasetId) return null;
  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) data.name = patch.name.trim();
  if (patch.spec !== undefined) data.spec = patch.spec.trim();
  if (patch.unit !== undefined) data.unit = patch.unit.trim();
  if (patch.brand !== undefined) data.brand = patch.brand.trim();
  if (patch.price !== undefined) data.price = D(patch.price);
  if (patch.region !== undefined) data.region = patch.region.trim();
  if (patch.period !== undefined) data.period = normalizePeriod(patch.period);
  if (patch.priceType !== undefined) {
    const t = normalizePriceType(patch.priceType);
    if (t) data.priceType = t; // 空/无法归一化保留原值
  }
  if (patch.name !== undefined || patch.spec !== undefined) {
    const name = (data.name as string) ?? row.name;
    const spec = (data.spec as string) ?? row.spec;
    data.features = toJson(parseSemanticFeature(`${name} ${spec}`, ""));
  }
  const updated = await prisma.materialPrice.update({
    where: { id: rowId },
    data,
  });
  return priceRowDTO(updated);
}

/** 手工补录一行（路由层已校验 name 非空、price 为有限数字）；归一化口径同导入 */
export async function createPriceRow(
  datasetId: string,
  input: {
    name: string;
    spec?: string;
    unit?: string;
    brand?: string;
    price: number | string;
    priceType?: string;
    region?: string;
    period?: string;
  }
) {
  const ds = await prisma.dataset.findUnique({ where: { id: datasetId } });
  if (!ds || ds.kind !== "MATERIAL_PRICE") return null;
  const name = input.name.trim();
  const spec = (input.spec ?? "").trim();
  const unit = (input.unit ?? "").trim();
  const row = await prisma.materialPrice.create({
    data: {
      datasetId,
      name,
      spec,
      unit,
      brand: (input.brand ?? "").trim(),
      price: Number(input.price),
      priceType:
        normalizePriceType(input.priceType) ||
        (LABOR_UNIT.test(unit) ? "LABOR" : "MARKET"),
      region: (input.region ?? "").trim(),
      period: normalizePeriod(input.period),
      features: toJson(parseSemanticFeature(`${name} ${spec}`, "")),
      raw: toJson({ __manual: true }),
    },
  });
  const rowCount = await prisma.materialPrice.count({ where: { datasetId } });
  await prisma.dataset.update({ where: { id: datasetId }, data: { rowCount } });
  return priceRowDTO(row);
}

/** 删行：校验归属数据集后删除并回写 rowCount */
export async function deletePriceRow(datasetId: string, rowId: string) {
  const row = await prisma.materialPrice.findUnique({ where: { id: rowId } });
  if (!row || row.datasetId !== datasetId) return false;
  await prisma.materialPrice.delete({ where: { id: rowId } });
  const rowCount = await prisma.materialPrice.count({ where: { datasetId } });
  await prisma.dataset.update({ where: { id: datasetId }, data: { rowCount } });
  return true;
}

/**
 * 项目价格偏好（台账事实 → PricePrefs）：
 * BRAND 事实 → 品牌偏好（「电缆品牌=上上」→ appliesTo=电缆）；
 * REGION 事实 → 地区；「价格期/价格日期/信息价」key → 期次；「价格类型」→ priceType。
 */
export async function getPricePrefs(projectId: string): Promise<PricePrefs> {
  const facts = await getFacts(projectId);
  const prefs: PricePrefs = { brands: [] };
  const brands = prefs.brands!;
  const seen = new Set<string>();
  for (const f of facts) {
    if (seen.has(f.key)) continue;
    seen.add(f.key);
    if (!f.value.trim()) continue;
    if (f.factType === "BRAND") {
      brands.push({
        appliesTo: f.key.replace(/品牌|主材|材料|的/g, ""),
        value: f.value,
      });
    } else if (f.factType === "REGION" && !prefs.region) {
      prefs.region = f.value;
    } else if (/价格期|价格日期|信息价/.test(f.key) && !prefs.period) {
      prefs.period = normalizePeriod(f.value) || undefined;
    } else if (f.key === "价格类型" && !prefs.priceType) {
      prefs.priceType = normalizePriceType(f.value) || undefined;
    }
  }
  return prefs;
}

export async function listDatasets() {
  const rows = await prisma.dataset.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { materialPrices: true, quotaRows: true } },
    },
  });
  return rows.map((d) => ({
    id: d.id,
    kind: d.kind,
    kindLabel: DATASET_KIND_LABEL[d.kind as DatasetKind] ?? d.kind,
    name: d.name,
    filename: d.filename,
    status: d.status,
    active: d.active,
    rowCount: d.rowCount,
    materialRows: d._count.materialPrices,
    quotaRows: d._count.quotaRows,
    createdAt: d.createdAt.toISOString(),
  }));
}

export async function getDatasetRows(id: string, limit = 200) {
  const ds = await prisma.dataset.findUnique({ where: { id } });
  if (!ds) return null;
  if (ds.kind === "MATERIAL_PRICE") {
    const rows = await prisma.materialPrice.findMany({
      where: { datasetId: id },
      take: limit,
      orderBy: { createdAt: "asc" },
    });
    return {
      kind: ds.kind,
      columns: ["名称", "规格", "单位", "品牌", "价格", "类型", "地区", "期次"],
      rows: rows.map((r) => [
        r.name,
        r.spec,
        r.unit,
        r.brand,
        r.price.toString(),
        r.priceType,
        r.region,
        r.period,
      ]),
      total: await prisma.materialPrice.count({ where: { datasetId: id } }),
    };
  }
  if (ds.kind === "QUOTA") {
    const rows = await prisma.quotaRow.findMany({
      where: { datasetId: id },
      take: limit,
      orderBy: { createdAt: "asc" },
    });
    return {
      kind: ds.kind,
      columns: ["定额编号", "子目名称", "单位", "人工费", "材料费", "机械费", "主材耗量"],
      rows: rows.map((r) => [
        r.code, r.name, r.unit,
        r.labor.toString(), r.material.toString(), r.machine.toString(),
        String(r.mainQtyPerUnit),
      ]),
      total: await prisma.quotaRow.count({ where: { datasetId: id } }),
    };
  }
  if (ds.kind === "GENERIC" && ds.meta.includes('"MEASURE_FEE"')) {
    try {
      const meta = JSON.parse(ds.meta) as { fees?: { name: string; book: string; category: string; base: string; tiers: { tier: string; rate: number }[] }[] };
      const fees = meta.fees ?? [];
      return {
        kind: ds.kind,
        columns: ["费用项目", "分册", "类别", "计算基数", "费率档"],
        rows: fees.slice(0, limit).map((f) => [
          f.name, f.book, f.category, f.base,
          f.tiers.map((t) => `${t.tier}:${(t.rate * 100).toFixed(2).replace(/\.?0+$/, "")}%`).join(" / "),
        ]),
        total: fees.length,
      };
    } catch { /* fallthrough */ }
  }
  return { kind: ds.kind, columns: [], rows: [], total: ds.rowCount };
}

export async function setDatasetActive(id: string, active: boolean) {
  const ds = await prisma.dataset.update({ where: { id }, data: { active } });
  return { id: ds.id, active: ds.active };
}

// 措施费系数库（四川2020 ps_fy/ps_fl 导入，GENERIC Dataset 的 meta.fees）
// 停用数据集 → 返回空数组，措施费计取自然跳过。
export async function getMeasureFeeRates() {
  const ds = await prisma.dataset.findFirst({
    where: { active: true, meta: { contains: '"MEASURE_FEE"' } },
  });
  if (!ds) return [];
  try {
    const meta = JSON.parse(ds.meta) as { fees?: import("@cost-engine/measureFee").MeasureFeeRate[] };
    return meta.fees ?? [];
  } catch {
    return [];
  }
}

export async function deleteDataset(id: string) {
  const ds = await prisma.dataset.findUnique({ where: { id } });
  if (!ds) return false;
  await prisma.$transaction(async (tx) => {
    await tx.materialPrice.deleteMany({ where: { datasetId: id } });
    await tx.quotaRow.deleteMany({ where: { datasetId: id } });
    await tx.dataset.delete({ where: { id } });
  });
  await storage.delete(ds.storageKey).catch(() => {});
  return true;
}

/** 只读启用中的数据集（active=false 的数据保留但不参与匹配） */
const ACTIVE_DATASET = { OR: [{ datasetId: null }, { dataset: { active: true } }] };

/** MaterialPrice 行 → 打分候选 */
const toCandidate = (r: {
  id: string;
  name: string;
  spec: string;
  unit: string;
  brand: string;
  price: unknown;
  priceType: string;
  region: string;
  period: string;
  createdAt: Date;
  dataset?: { name: string } | null;
}): PriceCandidate => ({
  id: r.id,
  name: r.name,
  spec: r.spec,
  unit: r.unit,
  brand: r.brand,
  price: Number(r.price),
  priceType: r.priceType,
  region: r.region,
  period: r.period,
  source: r.dataset?.name ?? "材料库",
  createdAt: r.createdAt.toISOString(),
});

/**
 * 候选取数三路 OR：名称前缀键 + 规格词根（型号式报价行无「材料名称」列，
 * 单靠 name contains 会整库漏掉）+ 特征材质（features JSON 子串）。
 */
const priceCandidateWhere = (name: string, spec?: string, material?: string) => {
  const key = name.slice(0, 6);
  const or: Record<string, unknown>[] = [{ name: { contains: key } }];
  // 查询侧同步归一（存储侧 ingest 已落 x 分隔符）——「4×35」查询命中「4x35」行
  const specCompact = String(spec ?? "").replace(/\s/g, "").replace(/[×*]/g, "x");
  if (specCompact) or.push({ spec: { contains: specCompact.slice(0, 20) } });
  for (const t of [...specTokens(spec)].filter((t) => t.length >= 3).slice(0, 4))
    or.push({ spec: { contains: t } });
  const mf = material ?? parseSemanticFeature(name, "").material;
  if (mf) or.push({ features: { contains: `"material":"${mf}"` } });
  return { AND: [ACTIVE_DATASET, { OR: or }] };
};

/** 全局材料价格库检索（供 Agent 工具消费）；价格偏好（品牌/地区）参与排序 */
export async function searchMaterialPrices(
  query: string,
  limit = 30,
  prefs?: PricePrefs
) {
  const q = query.trim();
  const rows = await prisma.materialPrice.findMany({
    where: {
      AND: [
        ACTIVE_DATASET,
        q ? { OR: [
          { name: { contains: q } },
          { spec: { contains: q } },
          { brand: { contains: q } },
        ] } : {},
      ],
    },
    include: { dataset: { select: { name: true } } },
    take: limit,
    orderBy: { createdAt: "desc" },
  });
  const out = rows.map((r) => ({
    name: r.name,
    spec: r.spec,
    unit: r.unit,
    brand: r.brand,
    price: r.price.toString(),
    priceType: r.priceType,
    region: r.region,
    period: r.period,
    source: r.dataset?.name ?? "材料库",
    features: fromJson(r.features, {}),
  }));
  // 排序：适用品牌命中 > 地区命中 > 期次新→旧（无偏好时纯期次排序，「最新优先」恒定生效）
  const brands = applicableBrands(prefs, q);
  const brandHit = (rb: string) => {
    const x = norm(rb);
    if (!x) return false;
    return brands.some((b) => {
      const nb = norm(b);
      return x === nb || x.includes(nb) || nb.includes(x);
    });
  };
  const pr = norm(prefs?.region);
  const regionHit = (rr: string) => {
    const x = norm(rr);
    return !!x && !!pr && (x.includes(pr) || pr.includes(x));
  };
  out.sort(
    (a, b) =>
      (brandHit(b.brand) ? 2 : 0) +
      (regionHit(b.region) ? 1 : 0) -
      ((brandHit(a.brand) ? 2 : 0) + (regionHit(a.region) ? 1 : 0)) ||
      periodKey(b.period) - periodKey(a.period)
  );
  return out;
}

/** 主材价查找（定额测算用）：名称候选 → pickBestPriceRow 打分（含品牌/地区/期次偏好） */
export async function findLibraryPrice(
  name: string,
  spec: string,
  prefs?: PricePrefs
): Promise<{
  price: number;
  name: string;
  spec: string;
  brand: string;
  period: string;
  region: string;
  priceType: string;
  source: string;
  score: number;
  notes: string[];
} | null> {
  const rows = await prisma.materialPrice.findMany({
    where: priceCandidateWhere(name, spec),
    include: { dataset: { select: { name: true } } },
    // 同分候选的裁决依赖输入顺序——固定排序保证匹配结果可复现
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 80,
  });
  const pick = pickBestPriceRow(rows.map(toCandidate), { name, spec }, prefs);
  if (!pick) return null;
  const r = pick.row;
  return {
    price: r.price,
    name: r.name,
    spec: r.spec,
    brand: r.brand,
    period: r.period,
    region: r.region,
    priceType: r.priceType,
    source: r.source ?? "材料库",
    score: pick.score,
    notes: pick.notes,
  };
}

/** 为清单项在材料库里找最佳价（返回行与置信度，供缺价补价预览） */
export async function matchLibraryForItem(
  item: {
    name: string;
    unit?: string;
    features?: { material?: string; diameter?: string; specification?: string };
  },
  prefs?: PricePrefs
): Promise<{
  row: {
    id: string;
    name: string;
    spec: string;
    unit: string;
    brand: string;
    price: string;
    source: string;
    region: string;
    period: string;
  };
  score: number;
  notes: string[];
} | null> {
  const spec = item.features?.diameter ?? item.features?.specification;
  const rows = await prisma.materialPrice.findMany({
    where: priceCandidateWhere(
      item.features?.material ?? item.name,
      [item.features?.diameter, item.features?.specification]
        .filter(Boolean)
        .join(" "),
      item.features?.material
    ),
    include: { dataset: { select: { name: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 100,
  });
  const pick = pickBestPriceRow(
    rows.map(toCandidate),
    {
      name: item.name,
      spec,
      unit: item.unit,
      material: item.features?.material,
    },
    prefs
  );
  if (!pick) return null;
  const r = pick.row;
  return {
    row: {
      id: r.id ?? "",
      name: r.name,
      spec: r.spec,
      unit: r.unit,
      brand: r.brand,
      price: String(r.price),
      source: r.source ?? "材料库",
      region: r.region,
      period: r.period,
    },
    score: pick.score,
    notes: pick.notes,
  };
}
