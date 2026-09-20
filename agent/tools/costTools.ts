import { z } from "zod";
import { registerTool } from "./registry";
import { listBoq, updateBoqItems } from "@boq/service";
import { aggregateByCategory, aggregateByDiscipline, projectTotals } from "@cost-engine/aggregate";
import { adjustQuantitiesToTarget } from "@cost-engine/adjust";
import { D, decStr, sum, withTax } from "@cost-engine/money";
import { getFact } from "@project/facts";
import type { DiffRow } from "@shared/types";

registerTool({
  name: "cost.calculate",
  description: "确定性金额计算：合价=工程量×单价，可选税率换算含税总价",
  implemented: true,
  schema: z.object({
    taxRate: z.number().optional().describe("税率，如 0.09"),
  }),
  handler: async (ctx, args: { taxRate?: number }) => {
    const items = await listBoq(ctx.projectId);
    const t = projectTotals(items);
    const taxFact = (await getFact(ctx.projectId, "税率"))?.value;
    const tax = args.taxRate ?? (taxFact ? Number(taxFact) : 0);
    const excl = D(t.totalAmount);
    return {
      observation: {
        ...t,
        taxRate: decStr(tax),
        exclTax: excl.toFixed(2),
        inclTax: tax ? withTax(excl, tax).toString() : null,
      },
      message: `不含税合价 ${excl.toFixed(2)} 元${tax ? `，含税 ${withTax(excl, tax).toFixed(2)} 元（税率 ${D(tax).mul(100)}%）` : ""}`,
    };
  },
});

registerTool({
  name: "cost.aggregate",
  description: "金额汇总（分部分项合计）",
  implemented: true,
  schema: z.object({}),
  handler: async (ctx) => {
    const items = await listBoq(ctx.projectId);
    const leaf = items.filter((i) => !i.isHeader && i.name.trim());
    return {
      observation: {
        total: sum(leaf.map((i) => i.totalPrice)).toFixed(2),
        count: leaf.length,
      },
    };
  },
});

registerTool({
  name: "cost.professionalBreakdown",
  description: "专业金额占比分析：电气/给排水/消防/暖通/弱电 各占安装工程总金额多少",
  implemented: true,
  schema: z.object({}),
  handler: async (ctx) => {
    const items = await listBoq(ctx.projectId);
    const { slices, total } = aggregateByDiscipline(items);
    return {
      observation: { slices, total: total.toFixed(2) },
      views: [
        {
          kind: "breakdown",
          id: "view:breakdown:discipline",
          title: "专业金额占比",
          mode: "discipline",
          slices,
          total: total.toFixed(2),
        },
      ],
      message: `总金额 ${total.toFixed(2)} 元：` +
        slices.slice(0, 5).map((s) => `${s.label} ${(s.share * 100).toFixed(1)}%`).join("，"),
    };
  },
});

registerTool({
  name: "cost.materialBreakdown",
  description: "材料类别金额占比：电缆/桥架/管道/阀门等分别占总金额多少",
  implemented: true,
  schema: z.object({
    categories: z.array(z.string()).optional().describe("只看这些类别，如 ['电缆','桥架','管道','阀门']"),
  }),
  handler: async (ctx, args: { categories?: string[] }) => {
    const items = await listBoq(ctx.projectId);
    const { slices, total } = aggregateByCategory(items, args.categories);
    return {
      observation: { slices, total: total.toFixed(2) },
      views: [
        {
          kind: "breakdown",
          id: "view:breakdown:material",
          title: args.categories?.length ? `${args.categories.join("/")} 金额占比` : "材料类别金额占比",
          mode: "material",
          slices,
          total: total.toFixed(2),
        },
      ],
      message:
        `总金额 ${total.toFixed(2)} 元：` +
        slices.slice(0, 6).map((s) => `${s.label} ${(s.share * 100).toFixed(1)}%`).join("，"),
    };
  },
});

registerTool({
  name: "quantity.calculate",
  description: "工程量计算（规划中：按定额规则/图纸工程量计算式）",
  implemented: false,
  schema: z.object({ itemId: z.string().optional() }),
});

registerTool({
  name: "quantity.adjust",
  description: "工程量反算：总价控制到目标值（可含税），单价不动，只按比例调整允许项工程量并保留三位小数",
  implemented: true,
  schema: z.object({
    targetTotal: z.number().describe("目标总价"),
    taxRate: z.number().optional().describe("目标价为含税价时的税率，如 0.09"),
    allowedItemIds: z.array(z.string()).optional().describe("只允许调整这些清单项；缺省=全部有量有价项"),
    apply: z.boolean().optional().describe("true=直接写回，false=仅试算"),
  }),
  handler: async (ctx, args) => {
    const items = await listBoq(ctx.projectId);
    const taxFact = (await getFact(ctx.projectId, "税率"))?.value;
    const tax = args.taxRate ?? (taxFact ? Number(taxFact) : 0);
    const r = adjustQuantitiesToTarget(items, {
      targetTotal: args.targetTotal,
      taxRate: tax,
      allowedItemIds: args.allowedItemIds,
    });
    if (!r.ok && !r.adjustments.length)
      return { observation: { ok: false, reason: r.reason } };

    const beforeMap = new Map(items.map((i) => [i.id, i]));
    const diffRows: DiffRow[] = r.adjustments.map((a) => {
      const it = beforeMap.get(a.itemId)!;
      return {
        itemId: a.itemId, code: it.code, name: it.name,
        field: "quantity", before: a.beforeQty.toString(), after: a.afterQty.toString(),
      };
    });

    if (!args.apply) {
      return {
        observation: {
          ok: r.ok,
          beforeTotal: r.beforeTotal.toFixed(2),
          afterTotal: r.afterTotal.toFixed(2),
          residual: r.residual.toFixed(4),
          adjustedItems: r.adjustments.length,
          preview: diffRows.slice(0, 20),
        },
        views: [
          {
            kind: "diff",
            id: `view:diff:${ctx.runId}`,
            title: `工程量反算试算（目标 ${args.targetTotal}）`,
            receiptId: "",
            rows: diffRows,
          },
        ],
        message: `试算完成：调整 ${r.adjustments.length} 项工程量，总价 ${r.beforeTotal.toFixed(2)} → ${r.afterTotal.toFixed(2)} 元（不含税口径），残差 ${r.residual.toFixed(4)}。确认后可写回`,
      };
    }

    const { before, after } = await updateBoqItems(
      ctx.projectId,
      r.adjustments.map((a) => ({ id: a.itemId, patch: { quantity: a.afterQty.toString() } }))
    );
    return {
      observation: {
        ok: r.ok,
        applied: after.length,
        afterTotal: r.afterTotal.toFixed(2),
        residual: r.residual.toFixed(4),
      },
      views: [
        { kind: "diff", id: `view:diff:${ctx.runId}`, title: "工程量反算 Diff", receiptId: "", rows: diffRows },
        { kind: "boqTable", id: "view:boq", title: "工程量清单" },
      ],
      receipts: [
        {
          actionType: "QUANTITY_ADJUST",
          summary: `工程量反算：${r.adjustments.length} 项调量，总价 ${r.beforeTotal.toFixed(2)} → ${r.afterTotal.toFixed(2)}（目标 ${args.targetTotal}${tax ? " 含税" : ""}）`,
          before: r.adjustments.map((a) => ({
            id: a.itemId,
            name: beforeMap.get(a.itemId)?.name,
            quantity: a.beforeQty.toString(),
          })),
          after: r.adjustments.map((a) => ({
            id: a.itemId,
            name: beforeMap.get(a.itemId)?.name,
            quantity: a.afterQty.toString(),
          })),
        },
      ],
      message: `已写回 ${r.adjustments.length} 项工程量，调整后总价 ${r.afterTotal.toFixed(2)} 元（不含税），残差 ${r.residual.toFixed(4)} 元`,
    };
  },
});

// quota.* 已实现于 quotaTools.ts
