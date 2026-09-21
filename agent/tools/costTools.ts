import { z } from "zod";
import { registerTool } from "./registry";
import { listBoq, updateBoqItems } from "@boq/service";
import { aggregateByCategory, aggregateByDiscipline, projectTotals } from "@cost-engine/aggregate";
import { adjustQuantitiesToTarget } from "@cost-engine/adjust";
import { D, decStr, round3, sum, withTax } from "@cost-engine/money";
import { feeSummary } from "@cost-engine/fees";
import { getFact, parseRateValue, parseAmountValue } from "@project/facts";
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
    const tax = args.taxRate ?? parseRateValue(taxFact) ?? 0;
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
  name: "cost.feeSummary",
  description: "费用汇总（取费）：分部分项费 → 措施费 → 暂列金额 → 规费 → 税金 → 含税造价。费率取项目事实台账",
  implemented: true,
  schema: z.object({}),
  handler: async (ctx) => {
    const items = await listBoq(ctx.projectId);
    const rate = async (key: string) => {
      const f = await getFact(ctx.projectId, key);
      const v = parseRateValue(f?.value);
      return { v: D(v ?? 0), set: v !== null };
    };
    const measure = await rate("措施费率");
    const regulation = await rate("规费费率");
    const provRate = await rate("暂列金额率");
    const provFact = await getFact(ctx.projectId, "暂列金额");
    const provAmtVal = parseAmountValue(provFact?.value);
    const taxF = await getFact(ctx.projectId, "税率");
    const taxRateVal = parseRateValue(taxF?.value);
    const tax = { v: D(taxRateVal ?? 0.09), set: taxRateVal !== null };
    const r = feeSummary(items, {
      measureRate: measure.v, regulationRate: regulation.v,
      provisionalRate: provRate.v, provisionalAmount: D(provAmtVal ?? 0),
      taxRate: tax.v,
      set: { measure: measure.set, regulation: regulation.set, provisional: provRate.set || provAmtVal !== null, tax: tax.set },
    });
    return {
      observation: {
        grandTotal: r.grandTotal, preTax: r.preTax, unpricedCount: r.unpricedCount,
        rows: r.rows.map((x) => ({ name: x.name, rate: x.rate, amount: x.amount })),
      },
      views: [
        {
          kind: "feeSummary", id: `view:fees:${ctx.runId}`, title: "费用汇总表",
          rows: r.rows, grandTotal: r.grandTotal, unpricedCount: r.unpricedCount,
        },
      ],
      message: `含税工程造价 ${r.grandTotal} 元（税前 ${r.preTax} 元）${r.unpricedCount ? `；注意 ${r.unpricedCount} 项未定价` : ""}`,
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
  description: "工程量计算式求值（如 3层×12个+15、(12.5+3)*2），可写入指定清单项的工程量",
  implemented: true,
  schema: z.object({
    expression: z.string().describe("工程量计算式，支持 +-*/×÷()%、中文单位词自动剥离"),
    itemId: z.string().optional().describe("给定则把结果写入该清单项工程量（三位小数）"),
    label: z.string().optional().describe("计算说明"),
  }),
  confirm: (a: { itemId?: string; expression?: string }) =>
    a.itemId ? `将把计算结果写入清单项工程量：${a.expression}` : null,
  handler: async (ctx, args: { expression: string; itemId?: string; label?: string }) => {
    const { evalExpr } = await import("@cost-engine/calcExpr");
    let value: number;
    try {
      value = evalExpr(args.expression);
    } catch (e) {
      return { observation: { error: `计算式无效：${e instanceof Error ? e.message : e}` } };
    }
    const qty = round3(value);

    if (!args.itemId) {
      const label = args.label && !args.label.includes(args.expression) ? `${args.label}：` : "";
      return {
        observation: { expression: args.expression, result: qty.toString() },
        message: `${label}${args.expression} = ${qty.toString()}`,
      };
    }

    const { before, after } = await updateBoqItems(ctx.projectId, [
      { id: args.itemId, patch: { quantity: qty.toString() } },
    ]);
    const b = before[0];
    const a = after[0];
    if (!a) return { observation: { error: "清单项不存在" } };
    return {
      observation: { itemId: args.itemId, before: b?.quantity, after: a.quantity },
      views: [
        {
          kind: "diff",
          id: `view:diff:${ctx.runId}`,
          title: "工程量写入",
          receiptId: "",
          rows: [{
            itemId: a.id, code: a.code, name: a.name, field: "quantity",
            before: String(b?.quantity ?? ""), after: String(a.quantity),
          }],
        },
      ],
      receipts: [{
        actionType: "BOQ_UPDATE",
        summary: `工程量计算写回：${a.name} ${args.expression} = ${qty}`,
        before, after,
      }],
      message: `${a.name} 工程量已更新：${b?.quantity} → ${qty}（${args.expression}）`,
    };
  },
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
  confirm: (a: { apply?: boolean; targetTotal?: number }) =>
    a.apply ? `将按目标总价 ${a.targetTotal} 反算工程量并写回清单（单价不变）` : null,
  handler: async (ctx, args) => {
    const items = await listBoq(ctx.projectId);
    const taxFact = (await getFact(ctx.projectId, "税率"))?.value;
    const tax = args.taxRate ?? parseRateValue(taxFact) ?? 0;
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
