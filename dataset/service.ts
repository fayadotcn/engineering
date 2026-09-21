import { prisma } from "@database/client";
import { storage } from "@file/storage";
import { parseWorkbook } from "@file/excel";
import { parseQuotaWorkbook } from "./quotaParse";
import { parseSemanticFeature } from "@cost-engine/semantic";
import { toJson } from "@shared/json";
import { D, round2 } from "@cost-engine/money";

// 全局数据集：材料价格库 / 定额库 / 通用数据。
// 与项目内上传文件的区别——数据集跨项目共享，由后台统一管理，
// Agent 工具（定额测算/材料搜索/价格历史）直接消费这些库。

export type DatasetKind = "MATERIAL_PRICE" | "QUOTA" | "GENERIC";

export const DATASET_KIND_LABEL: Record<DatasetKind, string> = {
  MATERIAL_PRICE: "材料价格库",
  QUOTA: "定额库",
  GENERIC: "通用数据",
};

const num = (s: string) => {
  const n = Number(String(s).replace(/,/g, ""));
  return isNaN(n) ? 0 : n;
};

export async function createDataset(
  kind: DatasetKind,
  filename: string,
  buffer: Buffer
): Promise<{ id: string; rowCount: number; status: string }> {
  const ext = filename.match(/\.[^.]+$/)?.[0] ?? "";
  const storageKey = await storage.put(buffer, ext || ".bin");

  const ds = await prisma.dataset.create({
    data: {
      kind,
      name: filename.replace(/\.(xlsx?|csv|pdf)$/i, ""),
      filename,
      storageKey,
      sizeBytes: buffer.length,
      status: "PARSED",
    },
  });

  try {
    let rowCount = 0;
    const meta: Record<string, unknown> = {};

    if (kind === "QUOTA") {
      const rows = parseQuotaWorkbook(buffer);
      if (rows.length) {
        await prisma.quotaRow.createMany({
          data: rows.map((r) => ({
            datasetId: ds.id,
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
          })),
        });
      }
      rowCount = rows.length;
      meta.note = rows.length
        ? "定额子目已导入，匹配特征已从名称自动解析"
        : "未识别到定额表头（需要 定额编号/子目名称/人工费 等列）";
    } else {
      const sheets = parseWorkbook(buffer);
      meta.sheets = sheets.map((s) => ({ name: s.sheetName, type: s.type, rows: s.rows.length }));
      if (kind === "MATERIAL_PRICE") {
        const data = [];
        for (const sheet of sheets) {
          for (const row of sheet.rows) {
            const name = (row.cells.materialName || row.cells.name || "").trim();
            if (!name || !row.isItem) continue;
            const price = num(row.cells.price ?? row.cells.unitPrice ?? "");
            if (!price) continue;
            const spec = (row.cells.spec ?? "").trim();
            data.push({
              datasetId: ds.id,
              name,
              spec,
              unit: row.cells.unit ?? "",
              brand: row.cells.brand ?? "",
              price: round2(D(price)),
              features: toJson(parseSemanticFeature(`${name} ${spec}`, "")),
              raw: toJson(row.cells),
            });
          }
        }
        if (data.length) await prisma.materialPrice.createMany({ data });
        rowCount = data.length;
        meta.note = rowCount ? "" : "未识别到材料价格行（需要 名称/单价 等列）";
      } else {
        // GENERIC：只存文件与结构画像，不导行
        rowCount = sheets.reduce((n, s) => n + s.rows.length, 0);
      }
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
      columns: ["名称", "规格", "单位", "品牌", "价格", "价格类型"],
      rows: rows.map((r) => [r.name, r.spec, r.unit, r.brand, r.price.toString(), r.priceType]),
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
  return { kind: ds.kind, columns: [], rows: [], total: ds.rowCount };
}

export async function setDatasetActive(id: string, active: boolean) {
  const ds = await prisma.dataset.update({ where: { id }, data: { active } });
  return { id: ds.id, active: ds.active };
}

export async function deleteDataset(id: string) {
  const ds = await prisma.dataset.findUnique({ where: { id } });
  if (!ds) return false;
  await prisma.materialPrice.deleteMany({ where: { datasetId: id } });
  await prisma.quotaRow.deleteMany({ where: { datasetId: id } });
  await prisma.dataset.delete({ where: { id } });
  await storage.delete(ds.storageKey).catch(() => {});
  return true;
}

/** 只读启用中的数据集（active=false 的数据保留但不参与匹配） */
const ACTIVE_DATASET = { OR: [{ datasetId: null }, { dataset: { active: true } }] };

/** 全局材料价格库检索（供 Agent 工具消费） */
export async function searchMaterialPrices(query: string, limit = 30) {
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
  return rows.map((r) => ({
    name: r.name,
    spec: r.spec,
    unit: r.unit,
    brand: r.brand,
    price: r.price.toString(),
    priceType: r.priceType,
    source: r.dataset?.name ?? "材料库",
    features: JSON.parse(r.features || "{}"),
  }));
}

/** 主材价模糊查找（定额测算用）：名称命中 + 规格尽量一致 */
export async function findLibraryPrice(name: string, spec: string): Promise<number | null> {
  const rows = await prisma.materialPrice.findMany({
    where: { AND: [ACTIVE_DATASET, { name: { contains: name.slice(0, 6) } }] },
    take: 50,
  });
  const norm = (s: string) => s.replace(/\s/g, "").replace(/X/gi, "x").toUpperCase();
  const ns = norm(spec);
  for (const r of rows) {
    const rs = norm(r.spec);
    if (ns && rs && ns === rs) return Number(r.price);
  }
  for (const r of rows) {
    if (norm(r.name) === norm(name) || r.name.includes(name) || name.includes(r.name))
      return Number(r.price);
  }
  return rows.length && !ns ? Number(rows[0].price) : null;
}

/** 为清单项在材料库里找最佳价（返回行与置信度，供缺价补价预览） */
export async function matchLibraryForItem(item: {
  name: string;
  unit?: string;
  features?: { material?: string; diameter?: string; specification?: string };
}): Promise<{ row: { id: string; name: string; spec: string; unit: string; brand: string; price: string; source: string }; score: number } | null> {
  const key = (item.features?.material ?? item.name).slice(0, 6);
  const rows = await prisma.materialPrice.findMany({
    where: { AND: [ACTIVE_DATASET, { name: { contains: key } }] },
    include: { dataset: { select: { name: true } } },
    take: 50,
  });
  if (!rows.length) return null;
  const norm = (s: string) => s.replace(/\s/g, "").replace(/X/gi, "x").toUpperCase();
  const spec = norm(item.features?.diameter ?? item.features?.specification ?? "");
  let best: (typeof rows)[number] | null = null;
  let score = 0;
  for (const r of rows) {
    const rs = norm(r.spec);
    let s = 40; // 名称命中基础分
    if (spec && rs === spec) s += 50;
    else if (spec && rs && (rs.includes(spec) || spec.includes(rs))) s += 30;
    else if (!spec) s += 20;
    if (r.unit && item.unit && r.unit === item.unit) s += 10;
    if (s > score) { score = s; best = r; }
  }
  if (!best) return null;
  return {
    row: {
      id: best.id, name: best.name, spec: best.spec, unit: best.unit,
      brand: best.brand, price: best.price.toString(),
      source: best.dataset?.name ?? "材料库",
    },
    score,
  };
}
