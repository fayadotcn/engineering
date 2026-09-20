import { z } from "zod";
import { prisma } from "@database/client";
import { registerTool, type ToolResult } from "./registry";
import { listBoq } from "@boq/service";
import { getFacts } from "@project/facts";
import { projectTotals } from "@cost-engine/aggregate";
import { FILE_KIND_LABEL, type FileKind } from "@shared/types";
import { storage } from "@file/storage";
import { parseWorkbook } from "@file/excel";
import { classifyFile } from "@file/classify";
import { importBoqFromSheets } from "@boq/service";
import { importQuotationsFromSheets } from "@material/service";
import { setFact } from "@project/facts";

const PROVINCES = /海南|四川|广东|广西|湖南|湖北|北京|上海|天津|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|贵州|云南|陕西|甘肃|青海|新疆|西藏|宁夏|内蒙古/;

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
        facts: facts.map((f) => `${f.key}=${f.value}(${f.source})`),
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
      message: `清单 ${t.itemCount} 项，已定价 ${t.pricedCount} 项，合价 ${t.totalAmount} 元`,
    };
  },
});

registerTool({
  name: "project.create",
  description: "创建新项目",
  implemented: true,
  schema: z.object({ name: z.string().describe("项目名称") }),
  handler: async (ctx, args: { name: string }) => {
    const ws = await prisma.workspace.findFirst();
    const p = await prisma.project.create({
      data: { name: args.name, workspaceId: ws!.id },
    });
    return { observation: { projectId: p.id, name: p.name } };
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
    const files = await prisma.projectFile.findMany({
      where: {
        projectId: ctx.projectId,
        OR: [
          { filename: { contains: args.query } },
          { kind: { contains: args.query.toUpperCase() } },
        ],
      },
    });
    return { observation: files.map((f) => ({ id: f.id, filename: f.filename, kind: f.kind })) };
  },
});

/**
 * file.ingest: parse an uploaded file, classify it, import rows, extract facts.
 * Runs inside the agent runtime so the whole ingest is traced.
 */
registerTool({
  name: "file.ingest",
  description: "解析上传的文件：识别类型（清单/询价/甲供材等），导入数据并提取项目事实",
  implemented: true,
  schema: z.object({ fileId: z.string() }),
  handler: async (ctx, args: { fileId: string }): Promise<ToolResult> => {
    const file = await prisma.projectFile.findUnique({ where: { id: args.fileId } });
    if (!file || file.projectId !== ctx.projectId) throw new Error("文件不存在");
    await ctx.emit("activity", { text: `正在解析 ${file.filename}` });

    const buffer = await storage.get(file.storageKey);
    let sheets = null;
    try {
      sheets = parseWorkbook(buffer);
    } catch {
      sheets = null;
    }
    const { kind, confidence } = classifyFile(file.filename, sheets, file.mime);

    let imported = 0;
    let headers = 0;
    if (sheets) {
      await ctx.emit("activity", { text: "识别到表格结构，正在导入数据" });
      const { count, headers: h } = await importBoqFromSheets(
        ctx.projectId,
        file.id,
        sheets
      );
      imported += count;
      headers += h;
      imported += await importQuotationsFromSheets(ctx.projectId, file.id, sheets);
    }

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
      classifyConfidence: confidence,
    };
    await prisma.projectFile.update({
      where: { id: file.id },
      data: { kind, status: sheets ? "PARSED" : "FAILED", meta: JSON.stringify(meta) },
    });

    // fact extraction — FILE_EXTRACTED, never INFERRED masquerading
    const province = file.filename.match(PROVINCES)?.[0];
    if (province)
      await setFact(ctx.projectId, {
        factType: "REGION",
        key: "地区",
        value: province,
        source: "FILE_EXTRACTED",
        sourceFileId: file.id,
        agentRunId: ctx.runId,
      });
    if (kind === "MATERIAL_QUOTATION")
      await setFact(ctx.projectId, {
        factType: "PRICE_FILE",
        key: "价格文件",
        value: file.filename,
        source: "FILE_EXTRACTED",
        sourceFileId: file.id,
        agentRunId: ctx.runId,
      });

    return {
      observation: {
        filename: file.filename,
        kind,
        kindLabel: FILE_KIND_LABEL[kind],
        imported,
        sectionHeaders: headers,
        sheets: meta.sheets,
      },
      views: [{ kind: "boqTable", id: "view:boq", title: "工程量清单" }],
      receipts: [
        {
          actionType: "FILE_IMPORT",
          summary: `导入 ${file.filename}：识别为「${FILE_KIND_LABEL[kind]}」，导入 ${imported} 行`,
          before: {},
          after: { kind, imported },
        },
      ],
      message: `已解析「${file.filename}」→ 识别为**${FILE_KIND_LABEL[kind]}**，导入 ${imported} 行数据${
        province ? `，提取事实：地区=${province}` : ""
      }`,
    };
  },
});
