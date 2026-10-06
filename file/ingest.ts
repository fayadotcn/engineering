import { prisma } from "@database/client";
import { storage } from "./storage";
import { parseWorkbook, colLetter } from "./excel";
import { classifyFile } from "./classify";
import { ensureInspection, mergeFileMeta, toSheetMappings, SHEET_TYPE_LABEL } from "./inspection";
import { importBoqFromSheets, deleteByFile } from "@boq/service";
import { importQuotationsFromSheets } from "@material/service";
import { setFact } from "@project/facts";
import { REGION_RE } from "@dataset/priceParse";
import { COLUMN_ROLE_LABEL, type ColumnRole } from "@shared/types";
import { toJson } from "@shared/json";

/** Check ownership before inspection can read storage or cache a mapping. */
export async function inspectProjectFile(projectId: string, fileId: string) {
  const owned = await prisma.projectFile.findUnique({ where: { id: fileId } });
  if (!owned || owned.projectId !== projectId) throw new Error("文件不存在");
  return ensureInspection(fileId);
}

/** Import policy lives with file ingestion; the Agent only presents the confirmation. */
export async function describeFileImport(projectId: string, fileId: string): Promise<string | null> {
  const { file, mapping, isPdf } = await inspectProjectFile(projectId, fileId);
  if (isPdf || !mapping) return null;
  // 确认门只盯会真正导数据的类型；COMPARE/APPROVAL/FACTS/GENERIC 不导入，
  // 识别结果本身已展示在「列映射」视图，无需列级确认
  const targets = Object.values(mapping).filter(
    (s) =>
      s.type === "BOQ" || s.type === "QUOTATION" ||
      s.type === "PENDING_QUOTE" || s.type === "MATERIAL_PRICE"
  );
  if (!targets.length) return null;
  // needsConfirm 是识别阶段给出的"必须让人看一眼"（例如模板类型与本文件证据冲突）。
  // 它必须是确认门的输入，否则 templateHit 会把这条表直接放行。
  const certain = (s: { templateHit: boolean; userEdited: boolean; minConfidence: number; needsConfirm?: boolean }) =>
    !s.needsConfirm && (s.templateHit || s.userEdited || s.minConfidence >= 0.9);
  if (targets.every(certain)) return null;
  // 低置信 sheet 标记待确认，用户可在「列映射」视图里修正后再批准。
  // 合并写：入口 meta 是快照，并发 PATCH 的列改动不能被整写覆盖
  const uncertain = targets.filter((s) => !certain(s)).map((s) => s.sheetName);
  await mergeFileMeta(file.id, (meta) => {
    for (const name of uncertain)
      if (meta.mapping?.[name]) meta.mapping[name].needsConfirm = true;
  });
  const parts = targets
    .filter((s) => !certain(s))
    .map((s) => {
      const low: string[] = [];
      let high = 0;
      for (const [role, col] of Object.entries(s.columns)) {
        const conf = s.confidence[role] ?? 0.9;
        if (conf >= 0.9) { high++; continue; }
        const label = COLUMN_ROLE_LABEL[role as ColumnRole] ?? role;
        const bare = /裸「单价」/.test(s.evidence[role] ?? "") ? "（裸「单价」按综合单价处理，" : "（";
        low.push(`${label}=${colLetter(col)}列${bare}置信 ${Math.round(conf * 100)}%）`);
      }
      const segs: string[] = [];
      if (s.typeConfidence < 0.9)
        segs.push(`类型拿不准（${s.typeEvidence}），暂按「${SHEET_TYPE_LABEL[s.type]}」处理，可在右侧改类型`);
      // 0 行表必须在批准前说清楚：列映射看着有行、导完却是空的，是数据静默丢失
      if (
        s.itemsToImport === 0 &&
        (s.type === "BOQ" || s.type === "PENDING_QUOTE" || s.type === "QUOTATION" || s.type === "MATERIAL_PRICE")
      )
        segs.push("⚠ 按当前映射将导入 0 行（有数据但没认出名称/数量列），请先在右侧列映射里指认名称列再确认");
      segs.push(...low);
      if (high) segs.push(`另 ${high} 列置信≥90%`);
      return `表「${s.sheetName}」(${SHEET_TYPE_LABEL[s.type]})：${segs.join("；")}`;
    });
  return `将按识别出的列映射导入「${file.filename}」：${parts.join("；")}（置信 ≥90% 的列只报数量）。可在右侧「列映射」视图调整并保存后再点「确认执行」。`.slice(0, 400);

}

export interface ImportOptions {
  agentRunId?: string;
  onProgress?: (text: string) => Promise<void>;
}

/** Replace source rows transactionally, persist inspection metadata, and extract facts. */
export async function ingestProjectFile(projectId: string, fileId: string, options: ImportOptions = {}) {

  const insp = await inspectProjectFile(projectId, fileId);
  const file = insp.file;
  await options.onProgress?.(`正在解析 ${file.filename}`);

  const buffer = await storage.get(file.storageKey);
  const isPdf = insp.isPdf;
  let sheets = null;
  if (!isPdf) {
    try {
      sheets = insp.mapping
        ? parseWorkbook(buffer, { mapping: toSheetMappings(insp.mapping) })
        : parseWorkbook(buffer);
    } catch (error) {
      await prisma.projectFile.update({ where: { id: file.id }, data: { status: "FAILED" } });
      throw new Error(`表格解析失败：${error instanceof Error ? error.message : "文件格式无效"}`);
    }
  }
  let { kind, confidence } = classifyFile(file.filename, sheets, file.mime);

  let imported = 0;
  let headers = 0;
  let nonNumericQty = 0;
  let derivedUnitPrice = 0;
  let arithMismatch = 0;
  let laborPriceCol = false;
  let pdfPages: string[] | null = null;
  if (sheets) {
    await options.onProgress?.("识别到表格结构，正在导入数据");
    // 重导幂等：清旧行与写新行同一事务——写入失败时旧数据也不会丢（否则重导=数据销毁）
    const r = await prisma.$transaction(async (tx) => {
      await deleteByFile(file.id, tx);
      const boq = await importBoqFromSheets(projectId, file.id, sheets, tx);
      const quotes = await importQuotationsFromSheets(projectId, file.id, sheets, tx);
      return { ...boq, quotes };
    });
    imported += r.count + r.quotes;
    headers += r.headers;
    nonNumericQty = r.nonNumericQty;
    derivedUnitPrice = r.derivedUnitPrice;
    arithMismatch = r.arithMismatch;
    laborPriceCol = r.laborPriceCol;
  } else if (isPdf) {
    await options.onProgress?.("正在提取 PDF 文本层");
    const { extractPdfText, detectBoqLines } = await import("@file/pdf");
    pdfPages = await extractPdfText(buffer);
    const boqLines = detectBoqLines(pdfPages);
    // 重导幂等与 Excel 路径一致：清旧行+写新行同事务（本轮没识别出清单行时
    // 也要清掉旧行，不留陈旧数据；写入失败旧数据不丢）
    if (boqLines.length >= 5) {
      await options.onProgress?.(`识别到 ${boqLines.length} 条清单行，正在导入`);
      const { parseSemanticFeature, inferDiscipline } = await import("@cost-engine/semantic");
      const { round2, round3 } = await import("@cost-engine/money");
      const { toJson } = await import("@shared/json");
      await prisma.$transaction(async (tx) => {
        await deleteByFile(file.id, tx);
        await tx.boqItem.createMany({
          data: boqLines.map((l, i) => ({
            projectId: projectId,
            fileId: file.id,
            sheetName: "PDF文本层",
            rowIndex: l.line,
            code: l.code,
            name: l.name,
            rawFeature: l.feature,
            unit: l.unit,
            quantity: round3(l.quantity),
            unitPrice: round2(l.unitPrice),
            // 保留源表合价真值（与 Excel 口径一致）；量×价不符由「合价算术校验」检出
            totalPrice: round2(l.totalPrice),
            sortOrder: i,
            discipline: inferDiscipline(l.name, l.feature, ""),
            features: toJson(parseSemanticFeature(l.name, l.feature)),
          })),
        });
      });
      imported = boqLines.length;
      kind = "BOQ_TENDER";
      confidence = 0.7;
    } else {
      // 识别不出清单行也清掉旧行（重导幂等）
      await deleteByFile(file.id);
    }
  }

  // 模板学习：确认过/人工改过的映射按表头指纹沉淀，下次同构表直接命中。
  // 模板写失败不该把已完成的导入报失败——它是辅助沉淀，容错放行
  const mapping = insp.mapping;
  try {
    if (mapping) {
      for (const s of Object.values(mapping)) {
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
  } catch { /* 模板沉淀失败不阻断导入 */ }

  const metaSheets =
    sheets?.map((s) => ({
      name: s.sheetName,
      type: s.type,
      headerRow: s.headerRow + 1,
      rows: s.rows.length,
      columns: Object.entries(s.columns)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}:${(v as number) + 1}`),
    })) ?? [];
  // 合并写：确认门开着时用户可能已 PATCH 过列映射——整写会丢人工改动；
  // fresh mapping 存在就保留它（重导按用户口径），只清已消费 sheet 的确认标记
  await mergeFileMeta(
    file.id,
    (m) => {
      m.sheets = metaSheets;
      if (pdfPages) m.pages = pdfPages;
      m.classifyConfidence = confidence;
      if (mapping) {
        if (m.mapping) for (const s of Object.values(m.mapping)) s.needsConfirm = false;
        else m.mapping = mapping;
      }
    },
    { kind, status: sheets || pdfPages ? "PARSED" : "FAILED" }
  );
  // fact extraction — FILE_EXTRACTED, never INFERRED masquerading
  // 重导幂等：清掉本文件上一轮提取的事实再重抽
  await prisma.costFact.deleteMany({
    where: { projectId: projectId, sourceFileId: file.id },
  });
  let extractedKeys: string[] = [];
  const province = file.filename.match(REGION_RE)?.[0];
  if (province)
    await setFact(projectId, {
      factType: "REGION",
      key: "地区",
      value: province,
      source: "FILE_EXTRACTED",
      sourceFileId: file.id,
      agentRunId: options.agentRunId,
    });
  // FACTS 表取数：表-04 推税率、单位工程汇总真值、扉页字段
  if (sheets?.length) {
    const { extractFileFacts } = await import("@file/factsExtract");
    const extracted = extractFileFacts(sheets, file.filename);
    extractedKeys = extracted.map((f) => f.key);
    for (const f of extracted) {
      try {
        await setFact(projectId, {
          factType: f.factType,
          key: f.key,
          value: f.value,
          source: "FILE_EXTRACTED",
          sourceFileId: file.id,
          agentRunId: options.agentRunId,
        });
      } catch {
        /* 校验不过的事实跳过，不拖垮导入 */
      }
    }
  }
  if (kind === "MATERIAL_QUOTATION")
    await setFact(projectId, {
      factType: "PRICE_FILE",
      key: "价格文件",
      value: file.filename,
      source: "FILE_EXTRACTED",
      sourceFileId: file.id,
      agentRunId: options.agentRunId,
    });

  return {
    file, kind, imported, headers, nonNumericQty, derivedUnitPrice, arithMismatch,
    laborPriceCol, pdfPages, sheets: metaSheets, province, extractedKeys,
    skipped: (sheets ?? []).filter((s) => s.type === "COMPARE" || s.type === "APPROVAL" || s.type === "FACTS"),
  };
}
