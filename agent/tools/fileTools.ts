import { z } from "zod";
import { prisma } from "@database/client";
import { registerTool, type ToolResult } from "./registry";
import { FILE_KIND_LABEL, type FileKind } from "@shared/types";
import { mappingToView, SHEET_TYPE_LABEL } from "@file/inspection";
import { describeFileImport, inspectProjectFile, ingestProjectFile } from "@file/ingest";

registerTool({
  name: "file.read",
  description: "读取项目文件元信息或解析状态",
  implemented: true,
  schema: z.object({ fileId: z.string().optional() }),
  handler: async (ctx, args: { fileId?: string }) => {
    const files = await prisma.projectFile.findMany({
      where: { projectId: ctx.projectId, ...(args.fileId ? { id: args.fileId } : {}) },
      orderBy: { createdAt: "desc" },
    });
    return {
      observation: files.map((f) => ({
        id: f.id,
        filename: f.filename,
        kind: FILE_KIND_LABEL[f.kind as FileKind] ?? f.kind,
        status: f.status,
        sizeBytes: f.sizeBytes,
      })),
      views: [{ kind: "fileList", id: "view:files", title: "项目文件" }],
    };
  },
});

registerTool({
  name: "file.search",
  description: "按文件名/类型查找项目文件",
  implemented: true,
  schema: z.object({ query: z.string() }),
  handler: async (ctx, args: { query: string }) => {
    // 中文标签也要能搜：kind 是英文枚举，「询价」应命中 MATERIAL_QUOTATION
    const kindHits = Object.entries(FILE_KIND_LABEL)
      .filter(([, label]) => label.includes(args.query))
      .map(([k]) => k);
    const files = await prisma.projectFile.findMany({
      where: {
        projectId: ctx.projectId,
        OR: [
          { filename: { contains: args.query } },
          { kind: { contains: args.query.toUpperCase() } },
          ...(kindHits.length ? [{ kind: { in: kindHits } }] : []),
        ],
      },
    });
    return { observation: files.map((f) => ({ id: f.id, filename: f.filename, kind: f.kind })) };
  },
});

// SHEET_TYPE_LABEL 由 @file/inspection 提供（8 类全量中文标签）

/**
 * file.inspect: 识别上传表格的列映射（不写数据），把 columnMapping 视图推到工作区。
 */
registerTool({
  name: "file.inspect",
  description: "识别上传文件的表格结构与列映射（不导入数据），在右侧打开「列映射」视图供核对",
  implemented: true,
  schema: z.object({ fileId: z.string() }),
  handler: async (ctx, args: { fileId: string }): Promise<ToolResult> => {

    const { file, mapping, isPdf } = await inspectProjectFile(ctx.projectId, args.fileId);
    if (isPdf || !mapping) return { observation: { pdf: true, filename: file.filename } };
    const sheets = Object.values(mapping);
    const obs = sheets.map((s) => ({
      sheetName: s.sheetName,
      type: s.type,
      columns: Object.fromEntries(
        Object.entries(s.columns).map(([k, v]) => [k, v + 1])
      ),
      minConfidence: s.minConfidence,
      templateHit: s.templateHit,
    }));
    const summary = sheets
      .map(
        (s) =>
          `${s.sheetName}（${SHEET_TYPE_LABEL[s.type]}，置信 ${Math.round(s.minConfidence * 100)}%）`
      )
      .join("、");
    return {
      observation: { filename: file.filename, sheets: obs },
      views: [mappingToView(file, mapping)],
      message: `识别到 ${sheets.length} 个工作表${sheets.length ? `：${summary}` : ""}`,
    };

  },
});

/**
 * file.ingest: parse an uploaded file, classify it, import rows, extract facts.
 * Runs inside the agent runtime so the whole ingest is traced.
 */
registerTool({
  name: "file.ingest",
  description: "解析上传的文件：识别类型（清单/询价/甲供材等），导入数据并提取项目事实。导入前先调用 file.inspect 识别列映射",
  implemented: true,
  schema: z.object({ fileId: z.string() }),
  confirm: (args: { fileId: string }, ctx) => describeFileImport(ctx.projectId, args.fileId),
  handler: async (ctx, args: { fileId: string }): Promise<ToolResult> => {
    const {
      file, kind, imported, headers, nonNumericQty, derivedUnitPrice, arithMismatch,
      laborPriceCol, pdfPages, sheets, province, extractedKeys, skipped,
    } = await ingestProjectFile(ctx.projectId, args.fileId, {
      agentRunId: ctx.runId,
      onProgress: (text) => ctx.emit("activity", { text }),
    });
    // 非导入类表的说明：让用户知道这些表被认出但没进清单（对比表→对审，其余→资料）
    const skippedNote = skipped.length
      ? `；另识别到${skipped
          .map((s) => `表「${s.sheetName}」为${SHEET_TYPE_LABEL[s.type]}，未导入`)
          .join("、")}${
          skipped.some((s) => s.type === "COMPARE") ? "，对比表可在「资料」里发起文件对审" : ""
        }`
      : "";

    const views = [
      ...(imported ? [{ kind: "boqTable" as const, id: "view:boq", title: "工程量清单" }] : []),
      ...(pdfPages
        ? [{
            kind: "document" as const,
            id: `view:doc:${file.id}`,
            title: file.filename,
            pages: pdfPages,
          }]
        : []),
    ];
    return {
      observation: {
        filename: file.filename,
        kind,
        kindLabel: FILE_KIND_LABEL[kind],
        imported,
        sectionHeaders: headers,
        sheets,
        pdfPages: pdfPages?.length,
      },
      views,
      receipts: [
        {
          actionType: "FILE_IMPORT",
          summary: `导入 ${file.filename}：识别为「${FILE_KIND_LABEL[kind]}」，导入 ${imported} 行`,
          before: {},
          after: { kind, imported },
          reversible: false,
        },
      ],
      message: kind.startsWith("BOQ_")
        ? `已解析「${file.filename}」→ 识别为**${FILE_KIND_LABEL[kind]}**，导入 ${imported} 行数据${
            province ? `，提取事实：地区=${province}` : ""
          }${extractedKeys.length ? `，汇总表取数 ${extractedKeys.length} 项进台账${extractedKeys.includes("税率") ? "（含推导税率）" : ""}` : ""}${
            nonNumericQty ? `；${nonNumericQty} 行工程量非数值已保留原文` : ""}${
            derivedUnitPrice ? `；${derivedUnitPrice} 项综合单价由 合价÷工程量 推导` : ""
          }${laborPriceCol ? "；检测到人工/机械单价列，已提取为成本分量（「成本构成分析」可直接使用）" : ""}${
            arithMismatch ? `；${arithMismatch} 项「合价≠量×价」，疑似源表断链或改量忘改价，可「合价算术校验」逐条核对` : ""}${skippedNote}`
        : `已解析「${file.filename}」→ 识别为**${FILE_KIND_LABEL[kind]}**，${
            imported ? `登记 ${imported} 行价格数据，材料取价时会自动参考` : "已登记为项目资料，不参与清单组价"
          }${province ? `，提取事实：地区=${province}` : ""}${skippedNote}`,
    };

  },
});
