import { z } from "zod";
import { registerTool } from "./registry";
import { listBoq, updateBoqItems } from "@boq/service";
import { listQuotations } from "@material/service";
import { searchMaterialPrices, matchLibraryForItem } from "@dataset/service";
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
    // 全局材料价格库（后台数据集）作为第二来源
    const lib = await searchMaterialPrices(args.query, 20);
    return {
      observation: {
        project: hits.slice(0, 30),
        library: lib,
        note: lib.length ? `材料库另有 ${lib.length} 条参考价` : "",
      },
    };
  },
});

registerTool({
  name: "material.getPriceHistory",
  description: "材料询价价格历史：同名称+规格材料在项目历次询价文件中的价格轨迹",
  implemented: true,
  schema: z.object({ materialName: z.string().optional() }),
  handler: async (ctx, args: { materialName?: string }) => {
    const { prisma } = await import("@database/client");
    const quotes = await prisma.quotationItem.findMany({
      where: { projectId: ctx.projectId },
      include: { file: { select: { filename: true, createdAt: true } } },
      orderBy: { createdAt: "asc" },
    });
    const norm = (s: string) => s.replace(/\s/g, "").toUpperCase();
    const q = args.materialName ? norm(args.materialName) : null;
    const groups = new Map<string, { name: string; spec: string; points: { price: string; file: string; date: string }[] }>();
    for (const it of quotes) {
      if (q && !norm(it.materialName).includes(q)) continue;
      const key = `${norm(it.materialName)}|${norm(it.spec)}`;
      const g = groups.get(key) ?? { name: it.materialName, spec: it.spec, points: [] };
      g.points.push({
        price: it.price.toString(),
        file: it.file?.filename ?? "手工录入",
        date: (it.file?.createdAt ?? it.createdAt).toISOString().slice(0, 10),
      });
      groups.set(key, g);
    }
    let filtered = groups;
    let note = "";
    if (q && groups.size === 0) {
      // 过滤词没命中任何材料名 —— 回退展示全部，避免误导为空
      filtered = new Map();
      for (const it of quotes) {
        const key = `${norm(it.materialName)}|${norm(it.spec)}`;
        const g = filtered.get(key) ?? { name: it.materialName, spec: it.spec, points: [] };
        g.points.push({
          price: it.price.toString(),
          file: it.file?.filename ?? "手工录入",
          date: (it.file?.createdAt ?? it.createdAt).toISOString().slice(0, 10),
        });
        filtered.set(key, g);
      }
      note = `未找到「${args.materialName}」，以下为全部询价材料`;
    }
    // 全局材料库价格作为参考点并入轨迹
    const libRows = await searchMaterialPrices(args.materialName ?? "", 50);
    for (const r of libRows) {
      const key = `${norm(r.name)}|${norm(r.spec)}`;
      if (q && !norm(r.name).includes(q)) continue;
      const g = filtered.get(key) ?? { name: r.name, spec: r.spec, points: [] };
      if (!g.points.some((p) => p.price === r.price && p.file.startsWith("材料库")))
        g.points.push({ price: r.price, file: `材料库·${r.source}`, date: r.priceType });
      filtered.set(key, g);
    }
    const changed = [...filtered.values()].filter(
      (g) => new Set(g.points.map((p) => p.price)).size > 1
    );
    return {
      observation: {
        materials: filtered.size,
        priceChanged: changed.length,
        detail: [...filtered.values()].slice(0, 30),
      },
      message: `${note ? note + "；" : ""}共 ${filtered.size} 种材料有询价记录，${changed.length} 种存在多次不同价格`,
    };
  },
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

// 缺价补价：未定价清单项 × 全局材料库。两步——matchLibrary 出预览表，
// fillFromLibrary 确认后写回（复用 quotationMatch / diff 视图）。
registerTool({
  name: "material.matchLibrary",
  description: "用全局材料价格库为未定价清单项找参考价，输出匹配预览（不写数据）",
  implemented: true,
  schema: z.object({}),
  handler: async (ctx) => {
    const items = await listBoq(ctx.projectId);
    const unpriced = items.filter((i) => !i.isHeader && Number(i.unitPrice) === 0);
    const rows = [];
    const misses: typeof unpriced = [];
    for (const it of unpriced) {
      const m = await matchLibraryForItem(it);
      if (!m || m.score < 60) { misses.push(it); continue; }
      rows.push({
        quotationItemId: `lib:${it.id}`,
        materialName: it.name,
        spec: it.features?.diameter ?? it.features?.specification ?? "",
        brand: m.row.brand,
        price: m.row.price,
        matchedBoqItemIds: [it.id],
        matchedNames: [`${m.row.name} ${m.row.spec} ¥${m.row.price}（${m.row.source}）`],
        confidence: m.score,
        status: m.score >= 80 ? ("MATCHED" as const) : ("LOW_CONFIDENCE" as const),
      });
    }
    return {
      observation: { unpriced: unpriced.length, matched: rows.length, missed: misses.length },
      views: rows.length
        ? [{
            kind: "quotationMatch" as const,
            id: "view:lib-match",
            title: "材料库补价预览",
            rows,
            unmatched: misses.map((i) => ({
              id: i.id, materialName: i.name, spec: "", unit: i.unit,
              brand: "", price: "0", sheetName: "", features: {},
            })),
          }]
        : [],
      message: rows.length
        ? `材料库匹配到 ${rows.length}/${unpriced.length} 个未定价项，确认后可批量写回（说「确认补价」）`
        : `未定价 ${unpriced.length} 项在材料库中没有命中`,
    };
  },
});

registerTool({
  name: "material.fillFromLibrary",
  description: "把材料库匹配价写回未定价清单项的综合单价（需确认，生成 Diff 与回执）",
  implemented: true,
  confirm: () => "将把材料库匹配价写回全部未定价清单项的综合单价",
  schema: z.object({}),
  handler: async (ctx) => {
    const items = await listBoq(ctx.projectId);
    const unpriced = items.filter((i) => !i.isHeader && Number(i.unitPrice) === 0);
    const patches: { id: string; unitPrice: string }[] = [];
    const misses: string[] = [];
    for (const it of unpriced) {
      const m = await matchLibraryForItem(it);
      if (!m || m.score < 60) { misses.push(it.name); continue; }
      patches.push({ id: it.id, unitPrice: m.row.price });
    }
    if (!patches.length)
      return { observation: { applied: 0 }, message: "没有可写回的匹配价" };

    const { before, after } = await updateBoqItems(
      ctx.projectId,
      patches.map((p) => ({ id: p.id, patch: { unitPrice: p.unitPrice } }))
    );
    const diffRows: DiffRow[] = [];
    for (const b of before) {
      const a = after.find((x) => x.id === b.id)!;
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
    return {
      observation: { applied: patches.length, missed: misses.length },
      views: [
        { kind: "diff", id: `view:diff:${ctx.runId}`, title: "材料库补价 Diff", receiptId: "", rows: diffRows },
        { kind: "boqTable", id: "view:boq", title: "工程量清单" },
      ],
      receipts: [{
        actionType: "PRICE_APPLY",
        summary: `材料库补价：${patches.length} 项写入综合单价（${misses.length} 项未命中）`,
        before: before.map((b) => ({ id: b.id, name: b.name, unitPrice: b.unitPrice })),
        after: after.map((a) => ({ id: a.id, name: a.name, unitPrice: a.unitPrice })),
      }],
      message: `已用材料库价格为 ${patches.length} 个清单项补价${misses.length ? `；${misses.length} 项未命中，需另行询价` : ""}`,
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
  confirm: () => "将把已匹配的询价写回清单综合单价（生成 Diff 与可撤销回执）",
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
