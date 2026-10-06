import { z } from "zod";
import { prisma } from "@database/client";
import { registerTool } from "./registry";
import { listBoq } from "@boq/service";
import { getFacts } from "@project/facts";
import { projectTotals } from "@cost-engine/aggregate";
import { fmtMoney } from "@cost-engine/money";
import { FILE_KIND_LABEL, type FileKind } from "@shared/types";
import { setFact } from "@project/facts";

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
  description:
    "写入项目事实台账（税率/地区/品牌/价格日期/管理费费率等），来源标记为用户提供。" +
    "「人工费调整系数」是调增倍数不是费率：用户说「人工费×4」写 3（调增 300%），说「调增15%」写 15% 或 0.15",
  implemented: true,
  schema: z.object({
    key: z.string().describe("事实名，如 税率 / 电缆品牌 / 管理费率"),
    value: z.string().describe("事实值，如 9% / 上上；人工费调整系数写调增倍数（人工费×4 → 写 3）"),
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
