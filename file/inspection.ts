import { prisma } from "@database/client";
import type { ProjectFile } from "@prisma/client";
import { storage } from "./storage";
import { applyTypeHint, inspectWorkbook, type SheetInspection, type SheetMapping } from "./excel";
import { fromJson, toJson } from "@shared/json";
import type { WorkspaceView } from "@shared/types";
import { reconcilePriceRole } from "@shared/mapping";

// 文件列映射的读取/缓存层：inspectWorkbook 的识别结果持久化在
// ProjectFile.meta.mapping，ImportTemplate 命中直接套用已确认映射。

export interface SheetMeta extends SheetInspection {
  userEdited: boolean;
  needsConfirm: boolean;
  /** 按当前映射确认导入后会落库的清单行数（0 = 该表不会导入任何行） */
  itemsToImport?: number;
}

interface FileMetaJson {
  sheets?: { name: string; type: string; headerRow: number; rows: number; columns: string[] }[];
  pages?: string[];
  classifyConfidence?: number;
  mapping?: Record<string, SheetMeta>;
  [k: string]: unknown;
}

export async function ensureInspection(
  fileId: string
): Promise<{ file: ProjectFile; mapping: Record<string, SheetMeta> | null; isPdf: boolean }> {
  const file = await prisma.projectFile.findUnique({ where: { id: fileId } });
  if (!file) throw new Error("文件不存在");
  const isPdf = /\.pdf$/i.test(file.filename) || file.mime.includes("pdf");
  if (isPdf) return { file, mapping: null, isPdf: true };

  const meta = fromJson<FileMetaJson>(file.meta, {});
  if (meta.mapping) {
    // 老文件的识别结果没有 itemsToImport（该提示上线前的数据）：补算一次并落库，
    // 否则「将导入 0 行」的预警对存量文件永不生效
    if (Object.values(meta.mapping).some((s) => s.itemsToImport === undefined)) {
      // 存储块可能已被清理（撤销删除等）——补算失败不能影响识别结果本身
      try {
        const buffer = await storage.get(file.storageKey);
        meta.mapping = await withImportCounts(buffer, meta.mapping);
        await prisma.projectFile.update({ where: { id: file.id }, data: { meta: toJson(meta) } });
      } catch { /* 保留旧识别结果 */ }
    }
    return { file, mapping: meta.mapping, isPdf: false };
  }

  const buffer = await storage.get(file.storageKey);
  // 只有项目文件需要「将导入 N 行」预报（数据集不做清单导入，14k 行定额表不必白算）
  const mapping = await withImportCounts(buffer, await inspectWithTemplates(buffer, file.filename));
  meta.mapping = mapping;
  await prisma.projectFile.update({
    where: { id: file.id },
    data: { meta: toJson(meta) },
  });
  return { file, mapping, isPdf: false };
}

/** 类型判定达到这个置信度，才算"本文件自己说得清楚"，可以顶掉模板记录的类型。 */
const TYPE_CERTAIN = 0.9;
export const SHEET_TYPE_LABEL = {
  BOQ: "清单",
  QUOTATION: "询价表",
  GENERIC: "忽略",
  COMPARE: "对比表",
  APPROVAL: "报审资料",
  PENDING_QUOTE: "待报价清单",
  FACTS: "汇总/说明表",
  MATERIAL_PRICE: "材料价格表",
} as const;

export interface TemplateRecord {
  sheetType: string;
  columns: string;
  useCount: number;
}

/**
 * 把一条已确认模板套到本文件的识别结果上。
 *
 * 模板管的是"人确认过的列角色"；类型是每份文件自己的判断。模板类型与本文件证据
 * 冲突且本文件足够确定时，以本文件为准并要求人工过一眼——否则一条被固化错的模板
 * 会连带 templateHit 绕过确认门，把招标清单静默导成询价表（清单永远进不来）。
 */
export function applyTemplateToSheet(
  fresh: SheetInspection,
  tpl: TemplateRecord
): { sheet: SheetInspection; needsConfirm: boolean } {
  const tplType = tpl.sheetType as SheetInspection["type"];
  const conflict = tplType !== fresh.type && fresh.typeConfidence >= TYPE_CERTAIN;
  const type = conflict ? fresh.type : tplType;
  // 类型变了，裸「单价」的角色要跟着走（清单=综合单价，询价表=材料价）
  const priceRole =
    type === tplType
      ? { columns: fromJson<Record<string, number>>(tpl.columns, {}), moved: null as null | string }
      : reconcilePriceRole(type, fromJson<Record<string, number>>(tpl.columns, {}), fresh.headerCells);
  const columns = priceRole.columns;
  const conf: Record<string, number> = {};
  const ev: Record<string, string> = {};
  for (const k of Object.keys(columns)) {
    conf[k] = conflict ? 0.5 : 1;
    ev[k] = conflict
      ? `命中模板，但模板类型「${SHEET_TYPE_LABEL[tplType]}」与本文件判断冲突，请核对`
      : `命中已确认模板（已用 ${tpl.useCount} 次）`;
  }
  if (priceRole.moved) {
    const role = priceRole.moved === "price→unitPrice" ? "unitPrice" : "price";
    conf[role] = conflict ? 0.5 : 1;
    ev[role] = `随类型对齐（${priceRole.moved}）`;
  }
  return {
    needsConfirm: conflict,
    sheet: {
      ...fresh,
      type,
      columns,
      confidence: conf,
      evidence: ev,
      templateHit: true,
      minConfidence: conflict ? 0.5 : Object.keys(columns).length ? 1 : 0,
      typeConfidence: conflict ? fresh.typeConfidence : 1,
      typeEvidence: conflict
        ? `模板记的是「${SHEET_TYPE_LABEL[tplType]}」（已用 ${tpl.useCount} 次），但本文件${fresh.typeEvidence}，更像「${SHEET_TYPE_LABEL[fresh.type]}」；已按本文件处理`
        : `命中已确认模板（已用 ${tpl.useCount} 次）`,
    },
  };
}

/**
 * 识别工作簿全部 sheet：applyTypeHint 文件名纠偏 + ImportTemplate 指纹查找。
 * 项目文件（ensureInspection）与全局数据集（dataset/service）共用同一套识别。
 */
export async function inspectWithTemplates(
  buffer: Buffer,
  filename: string
): Promise<Record<string, SheetMeta>> {
  const inspections = inspectWorkbook(buffer);
  const mapping: Record<string, SheetMeta> = {};
  for (const raw of inspections) {
    // 文件名辅助信号先纠偏；模板命中仍以模板的列角色为准
    const fresh = applyTypeHint(raw, filename);
    let cur: SheetInspection = fresh;
    let needsConfirm = false;
    if (fresh.fingerprint) {
      const tpl = await prisma.importTemplate.findUnique({
        where: { fingerprint: fresh.fingerprint },
      });
      if (tpl) ({ sheet: cur, needsConfirm } = applyTemplateToSheet(fresh, tpl));
    }
    mapping[cur.sheetName] = { ...cur, userEdited: false, needsConfirm };
  }
  return mapping;
}

/**
 * 用与正式导入完全相同的解析路径（parseWorkbook + importableRowCount）算出
 * 每张表「将导入 N 行」。识别结果里带上它，列映射视图才能在确认前红标 0 行表。
 * 解析失败不阻断识别——只是没有这个提示。
 */
export async function withImportCounts(
  buffer: Buffer,
  mapping: Record<string, SheetMeta>
): Promise<Record<string, SheetMeta>> {
  try {
    const { parseWorkbook } = await import("@file/excel");
    const { importableRowCount } = await import("@boq/ingestRules");
    const sheets = parseWorkbook(buffer, { mapping: toSheetMappings(mapping) });
    const counts = new Map<string, number>();
    for (const s of sheets) counts.set(s.sheetName, importableRowCount(s));
    for (const meta of Object.values(mapping))
      meta.itemsToImport = counts.get(meta.sheetName) ?? 0;
  } catch {
    // 解析失败：保留 undefined，视图退回只显示源表行数
  }
  return mapping;
}

/**
 * 用户在「列映射」视图的手工修改落到一个 sheet 上：
 * 一列只能一个角色，null = 取消该角色；改类型时 price↔unitPrice 角色随类型对齐。
 * 项目文件 PATCH /mapping 与数据集 PATCH /datasets/[id]/mapping 共用。
 */
export function applySheetPatch(
  sheet: SheetMeta,
  body: {
    columns?: Record<string, number | null>;
    type?: SheetInspection["type"];
  }
): void {
  if (body.type && SHEET_TYPE_LABEL[body.type] !== undefined) {
    sheet.type = body.type;
    sheet.typeConfidence = 1;
    sheet.typeEvidence = "用户指定";
    // type-only 请求（API/LLM）：单价角色随类型对齐；用户显式给了 columns 就以用户为准
    if (!body.columns) {
      const { columns, moved } = reconcilePriceRole(
        body.type,
        sheet.columns,
        sheet.headerCells
      );
      if (moved) {
        const role = moved === "price→unitPrice" ? "unitPrice" : "price";
        const from = moved === "price→unitPrice" ? "price" : "unitPrice";
        delete sheet.confidence[from];
        delete sheet.evidence[from];
        sheet.confidence[role] = 1;
        sheet.evidence[role] = "用户指定类型，单价角色随之调整";
        sheet.columns = columns;
      }
    }
  }

  if (body.columns) {
    const next = { ...sheet.columns };
    for (const [role, col] of Object.entries(body.columns)) {
      if (col === null) {
        delete next[role];
        delete sheet.confidence[role];
        delete sheet.evidence[role];
        continue;
      }
      // 列索引必须落在表头范围内——越界/非整数写进去，重导时会静默读出空列
      if (!Number.isInteger(col) || col < 0 || col >= sheet.headerCells.length) continue;
      // 一列只能一个角色：清掉指向同列的其他角色
      for (const [r, c] of Object.entries(next))
        if (c === col && r !== role) {
          delete next[r];
          delete sheet.confidence[r];
          delete sheet.evidence[r];
        }
      next[role] = col;
      sheet.confidence[role] = 1;
      sheet.evidence[role] = "用户指定";
    }
    sheet.columns = next;
  }

  sheet.userEdited = true;
  // 人已经看过这张表了，"需要核对"这个标记就该消失，否则改完还会一直拦着重导
  sheet.needsConfirm = false;
  const confs = Object.keys(sheet.columns).map((k) => sheet.confidence[k] ?? 0.9);
  sheet.minConfidence = confs.length ? Math.min(...confs) : 0;
}

/**
 * 文件 meta 合并写：入口读的 meta 只是快照，ingest/确认门执行期间并发的
 * mapping PATCH 若被整写覆盖会静默丢人工改动（与数据集 mergeDatasetMeta 同口径）。
 * 事务内重读最新 meta 再打补丁；data 是同次写入的标量字段。
 */
export async function mergeFileMeta(
  fileId: string,
  mutate: (meta: FileMetaJson) => void,
  data: Record<string, unknown> = {}
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const fresh = await tx.projectFile.findUnique({ where: { id: fileId }, select: { meta: true } });
    if (!fresh) return;
    const meta = fromJson<FileMetaJson>(fresh.meta, {});
    mutate(meta);
    await tx.projectFile.update({ where: { id: fileId }, data: { ...data, meta: toJson(meta) } });
  });
}

export function mappingToView(
  file: ProjectFile,
  mapping: Record<string, SheetMeta>
): WorkspaceView {
  return {
    kind: "columnMapping",
    id: `view:mapping:${file.id}`,
    title: `列映射：${file.filename}`,
    fileId: file.id,
    filename: file.filename,
    fileStatus: file.status,
    sheets: Object.values(mapping).map((s) => ({
      sheetName: s.sheetName,
      type: s.type,
      headerRow: s.headerRow,
      headerCells: s.headerCells,
      sample: s.sample,
      colCount: s.colCount,
      rowCount: s.rowCount,
      columns: s.columns,
      confidence: s.confidence,
      evidence: s.evidence,
      fingerprint: s.fingerprint,
      templateHit: s.templateHit,
      userEdited: s.userEdited,
      minConfidence: s.minConfidence,
      typeConfidence: s.typeConfidence,
      typeEvidence: s.typeEvidence,
      itemsToImport: s.itemsToImport,
    })),
  };
}

export function toSheetMappings(
  mapping: Record<string, SheetMeta>
): Record<string, SheetMapping> {
  const out: Record<string, SheetMapping> = {};
  for (const [name, s] of Object.entries(mapping))
    out[name] = {
      type: s.type,
      headerRow: s.headerRow,
      merged: s.merged,
      columns: s.columns,
      taxIncluded: s.taxIncluded,
      unitProject: s.unitProject,
      dataEndRow: s.dataEndRow,
      headerSpan: s.headerSpan,
    };
  return out;
}
