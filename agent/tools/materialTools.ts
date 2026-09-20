import { z } from "zod";
import { registerTool } from "./registry";
import { listBoq, updateBoqItems } from "@boq/service";
import { listQuotations } from "@material/service";
import { matchQuotations } from "@cost-engine/match";
import type { DiffRow } from "@shared/types";

registerTool({
  name: "material.search",
  description: "搜索询价材料或清单材料",
  implemented: true,
  schema: z.object({ query: z.string() }),
  handler: async (ctx, args: { query: string }) => {
    const quotes = await listQuotations(ctx.projectId);
    const q = args.query.toLowerCase();
    const hits = quotes.filter(
      (x) =>
        x.materialName.toLowerCase().includes(q) ||
        x.spec.toLowerCase().includes(q) ||
        x.brand.toLowerCase().includes(q)
    );
    return { observation: hits.slice(0, 30) };
  },
});

registerTool({
  name: "material.getPriceHistory",
  description: "材料价格历史（规划中）",
  implemented: false,
  schema: z.object({ materialName: z.string() }),
});

registerTool({
  name: "material.compareQuotation",
  description: "将询价文件中的材料与当前清单匹配，输出匹配表；未询到价的清单材料单独列出",
  implemented: true,
  schema: z.object({ threshold: z.number().optional() }),
  handler: async (ctx, args: { threshold?: number }) => {
    const [items, quotes] = await Promise.all([
      listBoq(ctx.projectId),
      listQuotations(ctx.projectId),
    ]);
    if (!quotes.length)
      return { observation: { error: "项目内没有询价数据，请先上传询价文件" } };
    const { rows, unmatched } = matchQuotations(items, quotes, args.threshold ?? 60);
    const matched = rows.filter((r) => r.status === "MATCHED");
    return {
      observation: {
        quotationItems: quotes.length,
        matched: matched.length,
        lowConfidence: rows.filter((r) => r.status === "LOW_CONFIDENCE").length,
        unmatched: unmatched.length,
      },
      views: [
        {
          kind: "quotationMatch",
          id: "view:quote-match",
          title: "询价匹配结果",
          rows,
          unmatched,
        },
      ],
      message: `询价 ${quotes.length} 条：匹配 ${matched.length} 条，未询到价 ${unmatched.length} 条已标记`,
    };
  },
});

registerTool({
  name: "material.applyQuotation",
  description: "将已匹配的询价写回清单综合单价/材料价，未匹配的自动标记，生成修改回执与 Diff",
  implemented: true,
  schema: z.object({
    minConfidence: z.number().optional(),
    onlyItemIds: z.array(z.string()).optional(),
  }),
  handler: async (ctx, args: { minConfidence?: number; onlyItemIds?: string[] }) => {
    const [items, quotes] = await Promise.all([
      listBoq(ctx.projectId),
      listQuotations(ctx.projectId),
    ]);
    const { rows } = matchQuotations(items, quotes, args.minConfidence ?? 60);
    const allowed = args.onlyItemIds ? new Set(args.onlyItemIds) : null;

    const itemById = new Map(items.map((i) => [i.id, i]));
    const patches: { id: string; unitPrice: string }[] = [];
    for (const r of rows) {
      if (r.status !== "MATCHED") continue;
      for (const id of r.matchedBoqItemIds) {
        if (allowed && !allowed.has(id)) continue;
        const it = itemById.get(id);
        if (!it || Number(it.quantity) === 0) continue; // 工程量为0的不用管
        patches.push({ id, unitPrice: r.price });
      }
    }
    // dedupe: last write wins (same item may match multiple quotes)
    const byId = new Map<string, string>();
    patches.forEach((p) => byId.set(p.id, p.unitPrice));
    const finalPatches = [...byId.entries()].map(([id, unitPrice]) => ({
      id,
      patch: { unitPrice },
    }));

    const { before, after } = await updateBoqItems(ctx.projectId, finalPatches);
    const diffRows: DiffRow[] = [];
    for (const b of before) {
      const a = after.find((x) => x.id === b.id)!;
      if (b.unitPrice !== a.unitPrice)
        diffRows.push({
          itemId: b.id, code: b.code, name: b.name,
          field: "unitPrice", before: b.unitPrice, after: a.unitPrice,
        });
      if (b.totalPrice !== a.totalPrice)
        diffRows.push({
          itemId: b.id, code: b.code, name: b.name,
          field: "totalPrice", before: b.totalPrice, after: a.totalPrice,
        });
    }
    const skipped = rows.filter((r) => r.status !== "MATCHED");
    return {
      observation: {
        applied: finalPatches.length,
        skippedQuotes: skipped.map((s) => s.materialName),
      },
      views: [
        {
          kind: "diff",
          id: `view:diff:${ctx.runId}`,
          title: "询价写回 Diff",
          receiptId: "",
          rows: diffRows,
        },
        { kind: "boqTable", id: "view:boq", title: "工程量清单" },
      ],
      receipts: [
        {
          actionType: "PRICE_APPLY",
          summary: `询价写回：${finalPatches.length} 项更新单价，${skipped.length} 条询价未应用`,
          before: before.map((b) => ({ id: b.id, name: b.name, unitPrice: b.unitPrice })),
          after: after.map((a) => ({ id: a.id, name: a.name, unitPrice: a.unitPrice })),
        },
      ],
      message: `已将询价写回 ${finalPatches.length} 个清单项；${skipped.length} 条未匹配的询价已在匹配表中标出`,
    };
  },
});
