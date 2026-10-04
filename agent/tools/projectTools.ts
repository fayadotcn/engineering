import { z } from "zod";
import { prisma } from "@database/client";
import { registerTool, type ToolResult } from "./registry";
import { listBoq } from "@boq/service";
import { getFacts } from "@project/facts";
import { projectTotals } from "@cost-engine/aggregate";
import { fmtMoney } from "@cost-engine/money";
import { FILE_KIND_LABEL, type FileKind } from "@shared/types";
import { storage } from "@file/storage";
import { parseWorkbook } from "@file/excel";
import { classifyFile } from "@file/classify";
import { ensureInspection, mappingToView, toSheetMappings, SHEET_TYPE_LABEL } from "@file/inspection";
import { COLUMN_ROLE_LABEL, type ColumnRole } from "@shared/types";
import { colLetter } from "@file/excel";
import { importBoqFromSheets, deleteByFile } from "@boq/service";
import { importQuotationsFromSheets } from "@material/service";
import { setFact } from "@project/facts";
import { REGION_RE } from "@dataset/priceParse";
import { fromJson, toJson } from "@shared/json";

registerTool({
  name: "project.read",
  description: "读取当前项目基本信息、文件列表、事实台账与清单统计",
  implemented: true,
  schema: z.object({}),
  handler: async (ctx) => {
    const p = await prisma.project.findUnique({
      where: { id: ctx.projectId },
      include: { files: true },
    });
    if (!p) throw new Error("项目不存在");
    const items = await listBoq(ctx.projectId);
    const facts = await getFacts(ctx.projectId);
    const currentFacts = facts.filter((fact, index) => facts.findIndex(f => f.key === fact.key) === index);
    const recentChanges = await prisma.actionReceipt.findMany({ where: { projectId: ctx.projectId }, orderBy: { createdAt: "desc" }, take: 10, select: { summary: true, createdBy: true, createdAt: true } });
    const totals = projectTotals(items);
    return {
      observation: {
        name: p.name,
        files: p.files.map((f) => ({
          id: f.id,
          filename: f.filename,
          kind: f.kind,
          kindLabel: FILE_KIND_LABEL[f.kind as FileKind] ?? f.kind,
          status: f.status,
        })),
        facts: currentFacts.map((f) => ({ key: f.key, value: f.value, source: f.source, confidence: f.confidence })),
        recentChanges: recentChanges.map(r => ({ ...r, createdAt: r.createdAt.toISOString() })),
        ...totals,
      },
      views: [
        { kind: "boqTable", id: "view:boq", title: "工程量清单" },
        { kind: "fileList", id: "view:files", title: "项目文件" },
        { kind: "factList", id: "view:facts", title: "项目事实台账", facts },
      ],
    };
  },
});

registerTool({
  name: "project.summary",
  description: "项目汇总：总金额、各专业金额、已定价/未定价条目数",
  implemented: true,
  schema: z.object({}),
  handler: async (ctx) => {
    const items = await listBoq(ctx.projectId);
    const t = projectTotals(items);
    return {
      observation: t,
      message: `清单 ${t.itemCount} 行（可计价 ${t.pricableCount} 项，已定价 ${t.pricedCount} 项），合价 ${fmtMoney(t.totalAmount)} 元`,
    };
  },
});

registerTool({
  name: "project.create",
  description: "创建新项目",
  implemented: true,
  schema: z.object({ name: z.string().describe("项目名称") }),
  handler: async (ctx, args: { name: string }) => {
    // 走领域服务：名称校验 + ensureDefaultWorkspace（无工作区不再裸 .id 崩）
    // + 事务内创建+回执——「每个写动作产生 ActionReceipt」红线不绕过
    const { createProject } = await import("@project/service");
    const p = await createProject(args.name);
    return { observation: { projectId: p.id, name: p.name } };
  },
});

registerTool({
  name: "project.setFact",
  description: "写入项目事实台账（税率/地区/品牌/价格日期/管理费费率等），来源标记为用户提供",
  implemented: true,
  schema: z.object({
    key: z.string().describe("事实名，如 税率 / 电缆品牌 / 管理费率"),
    value: z.string().describe("事实值，如 9% / 上上"),
    factType: z.string().optional(),
  }),
  handler: async (ctx, args: { key: string; value: string; factType?: string }) => {
    const factType =
      args.factType ??
      (/税率/.test(args.key) ? "TAX_RATE"
        : /地区|省|市/.test(args.key) ? "REGION"
        : /价格期|价格日期|信息价|价期/.test(args.key) ? "PRICE_DATE"
        : /品牌/.test(args.key) ? "BRAND"
        : /费率|单价/.test(args.key) ? "RATE"
        : "CUSTOM");
    const f = await setFact(ctx.projectId, {
      factType,
      key: args.key,
      value: args.value,
      source: "USER_PROVIDED",
      createdBy: "user",
      agentRunId: ctx.runId,
    });
    const facts = await getFacts(ctx.projectId);
    return {
      observation: { key: f.key, value: f.value, source: f.source },
      views: [{ kind: "factList", id: "view:facts", title: "项目事实台账", facts }],
      receipts: [
        {
          actionType: "FACT_SET",
          summary: `写入事实：${f.key} = ${f.value}（用户提供）`,
          before: {},
          after: { key: f.key, value: f.value },
          reversible: false,
        },
      ],
      message: `已记入台账：${f.key} = ${f.value}`,
    };
  },
});

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
    // 先校验归属，避免给别的项目文件算映射
    const owned = await prisma.projectFile.findUnique({ where: { id: args.fileId } });
    if (!owned || owned.projectId !== ctx.projectId) throw new Error("文件不存在");
    const { file, mapping, isPdf } = await ensureInspection(args.fileId);
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
  confirm: async (args: { fileId: string }) => {
    const { file, mapping, isPdf } = await ensureInspection(args.fileId);
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
    // 低置信 sheet 标记待确认，用户可在「列映射」视图里修正后再批准
    const meta = fromJson<{ mapping?: Record<string, { needsConfirm?: boolean }> }>(file.meta, {});
    for (const s of targets)
      if (!certain(s) && meta.mapping?.[s.sheetName])
        meta.mapping[s.sheetName].needsConfirm = true;
    await prisma.projectFile.update({
      where: { id: file.id },
      data: { meta: JSON.stringify(meta) },
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
        segs.push(...low);
        if (high) segs.push(`另 ${high} 列置信≥90%`);
        return `表「${s.sheetName}」(${SHEET_TYPE_LABEL[s.type]})：${segs.join("；")}`;
      });
    return `将按识别出的列映射导入「${file.filename}」：${parts.join("；")}（置信 ≥90% 的列只报数量）。可在右侧「列映射」视图调整并保存后再点「确认执行」。`.slice(0, 400);
  },
  handler: async (ctx, args: { fileId: string }): Promise<ToolResult> => {
    const insp = await ensureInspection(args.fileId);
    const file = insp.file;
    if (file.projectId !== ctx.projectId) throw new Error("文件不存在");
    await ctx.emit("activity", { text: `正在解析 ${file.filename}` });

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
      await ctx.emit("activity", { text: "识别到表格结构，正在导入数据" });
      // 重导幂等：清旧行与写新行同一事务——写入失败时旧数据也不会丢（否则重导=数据销毁）
      const r = await prisma.$transaction(async (tx) => {
        await deleteByFile(file.id, tx);
        const boq = await importBoqFromSheets(ctx.projectId, file.id, sheets, tx);
        const quotes = await importQuotationsFromSheets(ctx.projectId, file.id, sheets, tx);
        return { ...boq, quotes };
      });
      imported += r.count + r.quotes;
      headers += r.headers;
      nonNumericQty = r.nonNumericQty;
      derivedUnitPrice = r.derivedUnitPrice;
      arithMismatch = r.arithMismatch;
      laborPriceCol = r.laborPriceCol;
    } else if (isPdf) {
      await ctx.emit("activity", { text: "正在提取 PDF 文本层" });
      const { extractPdfText, detectBoqLines } = await import("@file/pdf");
      pdfPages = await extractPdfText(buffer);
      const boqLines = detectBoqLines(pdfPages);
      // 重导幂等与 Excel 路径一致：清旧行+写新行同事务（本轮没识别出清单行时
      // 也要清掉旧行，不留陈旧数据；写入失败旧数据不丢）
      if (boqLines.length >= 5) {
        await ctx.emit("activity", { text: `识别到 ${boqLines.length} 条清单行，正在导入` });
        const { parseSemanticFeature, inferDiscipline } = await import("@cost-engine/semantic");
        const { round2, round3 } = await import("@cost-engine/money");
        const { toJson } = await import("@shared/json");
        await prisma.$transaction(async (tx) => {
          await deleteByFile(file.id, tx);
          await tx.boqItem.createMany({
            data: boqLines.map((l, i) => ({
              projectId: ctx.projectId,
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

    const meta = {
      sheets:
        sheets?.map((s) => ({
          name: s.sheetName,
          type: s.type,
          headerRow: s.headerRow + 1,
          rows: s.rows.length,
          columns: Object.entries(s.columns)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k}:${(v as number) + 1}`),
        })) ?? [],
      pages: pdfPages ?? undefined,
      classifyConfidence: confidence,
      ...(mapping ? { mapping } : {}),
    };
    await prisma.projectFile.update({
      where: { id: file.id },
      data: {
        kind,
        status: sheets || pdfPages ? "PARSED" : "FAILED",
        meta: JSON.stringify(meta),
      },
    });

    // fact extraction — FILE_EXTRACTED, never INFERRED masquerading
    // 重导幂等：清掉本文件上一轮提取的事实再重抽
    await prisma.costFact.deleteMany({
      where: { projectId: ctx.projectId, sourceFileId: file.id },
    });
    let extractedKeys: string[] = [];
    const province = file.filename.match(REGION_RE)?.[0];
    if (province)
      await setFact(ctx.projectId, {
        factType: "REGION",
        key: "地区",
        value: province,
        source: "FILE_EXTRACTED",
        sourceFileId: file.id,
        agentRunId: ctx.runId,
      });
    // FACTS 表取数：表-04 推税率、单位工程汇总真值、扉页字段
    if (sheets?.length) {
      const { extractFileFacts } = await import("@file/factsExtract");
      const extracted = extractFileFacts(sheets, file.filename);
      extractedKeys = extracted.map((f) => f.key);
      for (const f of extracted) {
        try {
          await setFact(ctx.projectId, {
            factType: f.factType,
            key: f.key,
            value: f.value,
            source: "FILE_EXTRACTED",
            sourceFileId: file.id,
            agentRunId: ctx.runId,
          });
        } catch {
          /* 校验不过的事实跳过，不拖垮导入 */
        }
      }
    }
    if (kind === "MATERIAL_QUOTATION")
      await setFact(ctx.projectId, {
        factType: "PRICE_FILE",
        key: "价格文件",
        value: file.filename,
        source: "FILE_EXTRACTED",
        sourceFileId: file.id,
        agentRunId: ctx.runId,
      });

    // 非导入类表的说明：让用户知道这些表被认出但没进清单（对比表→对审，其余→资料）
    const skipped = (sheets ?? []).filter(
      (s) => s.type === "COMPARE" || s.type === "APPROVAL" || s.type === "FACTS"
    );
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
        sheets: meta.sheets,
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
