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
  if (meta.mapping) return { file, mapping: meta.mapping, isPdf: false };

  const buffer = await storage.get(file.storageKey);
  const mapping = await inspectWithTemplates(buffer, file.filename);
  meta.mapping = mapping;
  await prisma.projectFile.update({
    where: { id: file.id },
    data: { meta: toJson(meta) },
  });
  return { file, mapping, isPdf: false };
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
    // 文件名辅助信号先纠偏；模板命中仍以模板为准
    let cur = applyTypeHint(raw, filename);
    if (cur.fingerprint) {
      const tpl = await prisma.importTemplate.findUnique({
        where: { fingerprint: cur.fingerprint },
      });
      if (tpl) {
        const tplCols = fromJson<Record<string, number>>(tpl.columns, {});
        const conf: Record<string, number> = {};
        const ev: Record<string, string> = {};
        for (const k of Object.keys(tplCols)) {
          conf[k] = 1;
          ev[k] = `命中已确认模板（已用 ${tpl.useCount} 次）`;
        }
        cur = {
          ...cur,
          type: (tpl.sheetType as SheetInspection["type"]) ?? cur.type,
          columns: tplCols,
          confidence: conf,
          evidence: ev,
          templateHit: true,
          minConfidence: Object.keys(tplCols).length ? 1 : 0,
          typeConfidence: 1,
          typeEvidence: `命中已确认模板（已用 ${tpl.useCount} 次）`,
        };
      }
    }
    mapping[cur.sheetName] = { ...cur, userEdited: false, needsConfirm: false };
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
    type?: "BOQ" | "QUOTATION" | "GENERIC";
  }
): void {
  if (body.type && ["BOQ", "QUOTATION", "GENERIC"].includes(body.type)) {
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
  const confs = Object.keys(sheet.columns).map((k) => sheet.confidence[k] ?? 0.9);
  sheet.minConfidence = confs.length ? Math.min(...confs) : 0;
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
    };
  return out;
}
