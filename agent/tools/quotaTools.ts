import { z } from "zod";
import { registerTool } from "./registry";
import { listBoq } from "@boq/service";
import { listQuotations } from "@material/service";
import { calcQuota, matchQuota, top2Quota, mainPriceKey, lineFromQuota, planPrice, quotaLaborTotals } from "@cost-engine/quota";
import { getQuotaLibrary } from "@quota/service";
import { findLibraryPrice, getPricePrefs } from "@dataset/service";
import { getFact, setFact, parseRateValue } from "@project/facts";
import { D } from "@cost-engine/money";
import { isPricableItem } from "@shared/types";
import type { BoqItemDTO, DiffRow } from "@shared/types";

type QuoteList = Awaited<ReturnType<typeof listQuotations>>;
type PricePrefs = Awaited<ReturnType<typeof getPricePrefs>>;

/**
 * 主材价求解（quota.calculate / applyCalc 共用）：项目询价按 material+spec 优先，
 * 未命中回退全局材料库（含品牌/地区/期次偏好打分）。
 * 置信 <60 不取——错价比缺价更糟：缺价会标 needsMainPrice 留给询价环节。
 */
async function resolveMainPrices(
  leaf: BoqItemDTO[],
  quotes: QuoteList,
  pricePrefs: PricePrefs
): Promise<{
  mainPrices: Record<string, number>;
  libCount: number;
  libOffBrand: number;
}> {
  const mainPrices: Record<string, number> = {};
  let libCount = 0, libOffBrand = 0;
  for (const it of leaf) {
    const f = it.features ?? {};
    const spec = f.diameter ?? f.specification ?? "";
    const hit = quotes.find((q) => {
      const qf = q.features ?? {};
      const qSpec = qf.diameter ?? qf.specification ?? q.spec;
      const sameSpec =
        spec && qSpec && spec.replace(/X/gi, "x") === qSpec.replace(/X/gi, "x");
      const nameHit =
        q.materialName &&
        (it.name.includes(q.materialName) ||
          (f.material && q.materialName.includes(f.material)));
      return sameSpec || (nameHit && sameSpec !== false && !qSpec);
    });
    if (hit && !D(hit.price).isZero()) {
      mainPrices[mainPriceKey(it)] = Number(hit.price);
      continue;
    }
    const libHit = await findLibraryPrice(f.material ?? it.name, spec, pricePrefs);
    if (libHit && libHit.score >= 60 && !D(libHit.price).isZero()) {
      mainPrices[mainPriceKey(it)] = libHit.price;
      libCount++;
      if (libHit.notes.some((n) => n.includes("非指定"))) libOffBrand++;
    }
  }
  return { mainPrices, libCount, libOffBrand };
}

registerTool({
  name: "quota.search",
  description: "检索内置定额库（按名称/编码/类别关键词）",
  implemented: true,
  schema: z.object({ query: z.string() }),
  handler: async (_ctx, args: { query: string }) => {
    const q = args.query.toLowerCase();
    const lib = await getQuotaLibrary();
    const hits = lib.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.code.toLowerCase().includes(q) ||
        (e.match.category ?? "").includes(args.query)
    );
    return {
      observation: hits.map((e) => ({
        code: e.code, name: e.name, unit: e.unit,
        labor: e.labor, material: e.material, machine: e.machine,
      })),
    };
  },
});

registerTool({
  name: "quota.match",
  description: "为清单项匹配定额子目（语义特征匹配，非字符串）",
  implemented: true,
  schema: z.object({ query: z.string().optional() }),
  handler: async (ctx) => {
    const items = await listBoq(ctx.projectId);
    const leaf = items.filter((i) => isPricableItem(i));
    const lib = await getQuotaLibrary();
    // top2 候选 + 存疑判定在 service.top2Quota：分差小且基价不同才算「拿不准」
    const rows = leaf.map((item) => ({ item, ...top2Quota(item, lib) }));
    const matched = rows.filter((r) => r.best.q && r.best.s >= 50);
    const ambiguous = matched.filter((r) => r.ambiguous);
    return {
      observation: {
        total: leaf.length,
        matched: matched.length,
        ambiguous: ambiguous.length,
        pairs: matched.slice(0, 30).map((r) => ({
          item: r.item.name, quota: r.best.q!.name, score: r.best.s,
          ...(r.ambiguous ? { alt: `${r.alt.q!.code} ${r.alt.q!.name}`, altScore: r.alt.s, ambiguous: true } : {}),
        })),
      },
      message: `定额匹配：${matched.length}/${leaf.length} 项匹配到子目` +
        (ambiguous.length ? `；${ambiguous.length} 项存在得分相近且基价不同的备选子目（存疑），可用 spec.search 查定额说明核实` : ""),
    };
  },
});

registerTool({
  name: "spec.search",
  description: "检索《四川2020定额说明及计算规则》条文：定额适用范围/包含与不包含内容/工程量计算规则/换算系数。定额匹配存疑、算量口径不明、子目归属不清时调用",
  implemented: true,
  schema: z.object({
    query: z.string().describe("检索词，如「沟槽连接」「风管 支架」「脚手架 系数」"),
    book: z.string().optional().describe("限定册，如 通风空调/消防/给排水"),
  }),
  handler: async (_ctx, args: { query: string; book?: string }) => {
    const { prisma } = await import("@database/client");
    const secs = await prisma.specSection.findMany({
      where: args.book ? { book: { contains: args.book } } : undefined,
    });
    // 关键词：空格/顿号切分 + 对整串做 2~4 字滑窗（"沟槽连接管道"→沟槽/连接/管道…）
    const terms = new Set<string>();
    for (const w of args.query.split(/[\s,，、]+/).filter(Boolean)) {
      terms.add(w);
      for (let len = 2; len <= Math.min(4, w.length); len++)
        for (let i = 0; i + len <= w.length; i++) terms.add(w.slice(i, i + len));
    }
    const scored = secs
      .map((s) => {
        let sc = 0;
        for (const k of terms) {
          const occ = (s.content.split(k).length - 1) + (s.title.includes(k) ? 6 : 0) + (s.book.includes(k) ? 3 : 0);
          sc += Math.min(occ, 8) * k.length; // 长词权重高
        }
        return { s, sc };
      })
      .filter((x) => x.sc > 0)
      .sort((a, b) => b.sc - a.sc)
      .slice(0, 3);
    const hits = scored.map(({ s }) => {
      // 截取首个关键词附近的条文片段
      let idx = -1;
      // 用最长的词定位摘录起点，最可能落在关键句
      for (const k of [...terms].sort((a, b) => b.length - a.length)) {
        idx = s.content.indexOf(k);
        if (idx >= 0) break;
      }
      const start = Math.max(0, (idx < 0 ? 0 : idx - 60));
      return {
        book: s.book, title: s.title,
        excerpt: s.content.slice(start, start + 700),
      };
    });
    return {
      observation: { total: secs.length, hits },
      views: hits.length
        ? [{
            kind: "specResult" as const,
            id: `spec-${Date.now()}`,
            title: `定额说明：${args.query}`,
            query: args.query,
            hits,
          }]
        : [],
      message: hits.length
        ? `查到 ${hits.length} 条相关定额说明（${hits.map((h) => h.title).join("、")}）`
        : "定额说明中未找到相关条文",
    };
  },
});

registerTool({
  name: "quota.calculate",
  description: "按定额测算综合单价：人工+辅材+机械+主材耗量×主材价+管理费利润，与清单价对比偏差",
  implemented: true,
  schema: z.object({}),
  handler: async (ctx) => {
    const [items, quotes] = await Promise.all([
      listBoq(ctx.projectId),
      listQuotations(ctx.projectId),
    ]);
    const leaf = items.filter((i) => isPricableItem(i));
    const pricePrefs = await getPricePrefs(ctx.projectId);
    const { mainPrices, libCount, libOffBrand } = await resolveMainPrices(
      leaf, quotes, pricePrefs
    );

    const mgmtFact = (await getFact(ctx.projectId, "管理费率"))?.value;
    const profitFact = (await getFact(ctx.projectId, "利润率"))?.value;
    const mgmtRate =
      parseRateValue(mgmtFact) ?? 0;
    const profitRate =
      parseRateValue(profitFact) ?? 0;
    const missingRates = [parseRateValue(mgmtFact) === null ? "管理费率" : "", parseRateValue(profitFact) === null ? "利润率" : ""].filter(Boolean);

    const lib = await getQuotaLibrary();
    const rows = calcQuota(leaf, { mainPrices, mgmtRate, profitRate, lib });
    const done = rows.filter((r) => r.quotaCode);
    const needMain = done.filter((r) => r.needsMainPrice).length;
    const deviant = done.filter(
      (r) => r.deviation !== null && Math.abs(Number(r.deviation)) > 20
    );
    // 定额人工费合计 → 台账（规费基数是人工费而非分部分项费，四川安装口径）
    // 同时按定额分册(5G/5H/5I…)存明细——措施费系数(脚手架/超高/高层)按册取人工费基数
    const { total: laborBase, byBook: laborByBook } = quotaLaborTotals(done);
    if (done.length) {
      await setFact(ctx.projectId, {
        factType: "取费基数",
        key: "定额人工费",
        value: laborBase,
        source: "INFERRED",
        confidence: 0.7,
        createdBy: "agent",
        agentRunId: ctx.runId,
      });
      await setFact(ctx.projectId, {
        factType: "取费基数",
        key: "定额人工费明细",
        value: JSON.stringify(laborByBook),
        source: "INFERRED",
        confidence: 0.7,
        createdBy: "agent",
        agentRunId: ctx.runId,
      });
    }
    return {
      observation: {
        total: leaf.length,
        matched: done.length,
        needsMainPrice: needMain,
        deviationOver20pct: deviant.length,
        laborBase,
        mgmtRate, profitRate, missingRates,
      },
      views: [
        {
          kind: "quotaResult",
          id: "view:quota",
          title: "定额测算",
          rows,
          mgmtRate,
          profitRate,
        },
      ],
      message:
        `定额测算完成：${done.length}/${leaf.length} 项匹配子目` +
        (missingRates.length ? `；${missingRates.join("、")}未确认，暂按零测算` : "") +
        (needMain ? `，${needMain} 项缺主材价（测算价不含主材费，属不完整单价）` : "") +
        (libCount
          ? `，${libCount} 项主材价取材料库` +
            (libOffBrand ? `（${libOffBrand} 项异品牌兜底）` : "")
          : "") +
        (deviant.length ? `，${deviant.length} 项测算价与清单价偏差>20%` : ""),
    };
  },
});

// 组价写回：定额测算综合单价 → 清单综合单价。缺主材价的项测算不完整，
// 默认跳过（必须先补主材暂估价或另行询价），includeIncomplete 时才强写。
registerTool({
  name: "quota.applyCalc",
  description: "把定额测算综合单价写回清单项（需确认；缺主材价的不完整测算默认跳过，生成 Diff 与回执）",
  implemented: true,
  schema: z.object({
    includeIncomplete: z.boolean().optional().describe("true=连缺主材价的不完整测算也写回（不推荐）"),
    onlyItemIds: z.array(z.string()).optional().describe("只写回这些清单项"),
  }),
  confirm: (a: { includeIncomplete?: boolean }) =>
    `将把定额测算综合单价写回清单${a.includeIncomplete ? "（含缺主材价的不完整项）" : "（缺主材价项跳过）"}`,
  handler: async (ctx, args: { includeIncomplete?: boolean; onlyItemIds?: string[] }) => {
    for (const key of ["管理费率", "利润率"]) {
      if (parseRateValue((await getFact(ctx.projectId, key))?.value) === null) throw new Error(`${key}尚未确认，请先在计价设置中填写（确实不计时填 0%）再写回组价`);
    }
    const [items, quotes] = await Promise.all([
      listBoq(ctx.projectId),
      listQuotations(ctx.projectId),
    ]);
    const leaf = items.filter((i) => isPricableItem(i));
    const pricePrefs = await getPricePrefs(ctx.projectId);
    const { mainPrices } = await resolveMainPrices(leaf, quotes, pricePrefs);
    const mgmtRate = parseRateValue((await getFact(ctx.projectId, "管理费率"))?.value) ?? 0;
    const profitRate = parseRateValue((await getFact(ctx.projectId, "利润率"))?.value) ?? 0;
    const lib = await getQuotaLibrary();
    const rows = calcQuota(leaf, { mainPrices, mgmtRate, profitRate, lib });
    const allowed = args.onlyItemIds ? new Set(args.onlyItemIds) : null;
    const writable = rows.filter(
      (r) => r.quotaCode && r.calcPrice &&
        (args.includeIncomplete || !r.needsMainPrice) &&
        (!allowed || allowed.has(r.itemId))
    );
    const skipped = rows.filter((r) => r.quotaCode && r.needsMainPrice && !args.includeIncomplete);
    if (!writable.length)
      return {
        observation: { applied: 0, skipped: skipped.length },
        message: skipped.length
          ? `${skipped.length} 项测算缺主材价，属不完整单价，未写回——先补主材暂估价（询价/材料库）再组价`
          : "没有可写回的测算结果，请先运行定额测算",
      };
    const { updateBoqItems } = await import("@boq/service");
    const { before, after } = await updateBoqItems(
      ctx.projectId,
      writable.map((r) => ({
        id: r.itemId,
        // 综合单价=组价方案合计；pricingPlan 只落已确认行（suggested 不计入）
        patch: { unitPrice: r.calcPrice!, pricingPlan: (r.plan ?? []).filter((l) => !l.suggested) },
      }))
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
      observation: { applied: writable.length, skippedIncomplete: skipped.length, mgmtRate, profitRate },
      views: [
        { kind: "diff", id: `view:diff:${ctx.runId}`, title: "组价写回 Diff", receiptId: "", rows: diffRows },
        { kind: "boqTable", id: "view:boq", title: "工程量清单" },
      ],
      receipts: [{
        actionType: "PRICE_APPLY",
        summary: `定额组价写回：${writable.length} 项综合单价（管理费 ${mgmtRate * 100}%/利润 ${profitRate * 100}%）${skipped.length ? `，${skipped.length} 项缺主材价未写` : ""}`,
        before: before.map((b) => ({ id: b.id, name: b.name, unitPrice: b.unitPrice, pricingPlan: b.pricingPlan })),
        after: after.map((a) => ({ id: a.id, name: a.name, unitPrice: a.unitPrice, pricingPlan: a.pricingPlan })),
      }],
      message: `已把定额测算综合单价写回 ${writable.length} 项${skipped.length ? `；${skipped.length} 项缺主材价跳过` : ""}`,
    };
  },
});

// 人工选定定额：存疑匹配/未匹配项的专业处置出口。
// replace=替换主项子目；append=增列配套子目（冲洗/支吊架/试压等）。
// 综合单价 = 组价方案合计，写回 pricingPlan + unitPrice（确认门）。
registerTool({
  name: "quota.setItemQuota",
  description: "人工为清单项指定定额子目：replace 替换主项（处置存疑匹配），append 增列配套子目（冲洗/支吊架/试压等）。综合单价按组价方案合计重算",
  implemented: true,
  schema: z.object({
    itemId: z.string().describe("清单项 id"),
    quotaCode: z.string().describe("定额编号，如 5H0332"),
    mode: z.enum(["replace", "append"]).optional().describe("replace=替换主项（默认）；append=增列到组价方案"),
    clear: z.boolean().optional().describe("true=清除该项组价方案（恢复清单原价不变，仅清方案）"),
  }),
  confirm: (a: { quotaCode?: string; mode?: string; clear?: boolean }) =>
    a.clear ? "将清除该清单项的组价方案" : `将把定额 ${a.quotaCode} ${a.mode === "append" ? "增列到组价方案" : "设为主项定额"}，综合单价按方案合计重算`,
  handler: async (ctx, args: { itemId: string; quotaCode: string; mode?: "replace" | "append"; clear?: boolean }) => {
    const items = await listBoq(ctx.projectId);
    const it = items.find((x) => x.id === args.itemId);
    if (!it) return { observation: { error: "清单项不存在" } };
    const { updateBoqItems } = await import("@boq/service");

    if (args.clear) {
      const { before, after } = await updateBoqItems(ctx.projectId, [
        { id: it.id, patch: { pricingPlan: [] } },
      ]);
      return {
        observation: { cleared: true },
        receipts: [{
          actionType: "BOQ_UPDATE",
          summary: `清除组价方案：${it.name}（综合单价保留 ${it.unitPrice}）`,
          before, after,
        }],
        message: `已清除「${it.name}」的组价方案，综合单价保留现值 ${it.unitPrice}`,
      };
    }

    const lib = await getQuotaLibrary();
    const q = lib.find((e) => e.code === args.quotaCode);
    if (!q) return { observation: { error: `定额库中无 ${args.quotaCode}，可用 quota.search 检索` } };

    for (const key of ["管理费率", "利润率"]) {
      if (parseRateValue((await getFact(ctx.projectId, key))?.value) === null) throw new Error(`${key}尚未确认，请先填写计价设置再人工组价`);
    }
    if (Number(it.mainMaterialPrice ?? 0) <= 0 && q.detail?.mainMaterial) throw new Error(`主材「${q.detail.mainMaterial}」缺价，请先补主材暂估价再写回完整综合单价`);

    const mgmtRate = parseRateValue((await getFact(ctx.projectId, "管理费率"))?.value) ?? 0;
    const profitRate = parseRateValue((await getFact(ctx.projectId, "利润率"))?.value) ?? 0;

    // 主材价沿用清单项主材暂估价
    const ownMain = Number(it.mainMaterialPrice ?? 0);
    const line = lineFromQuota(it, q, {
      mgmtRate, profitRate,
      mainPrice: ownMain > 0 ? ownMain : undefined,
      manual: true,
    });

    const existing = (it.pricingPlan ?? []).filter((l) => !l.suggested);
    const plan =
      args.mode === "append" ? [...existing, line] : [line];
    const price = planPrice(plan);

    const { before, after } = await updateBoqItems(ctx.projectId, [
      { id: it.id, patch: { unitPrice: price.toFixed(2), pricingPlan: plan } },
    ]);
    const a = after[0];
    return {
      observation: {
        itemId: it.id, quota: `${q.code} ${q.name}`, mode: args.mode ?? "replace",
        planLines: plan.length, unitPrice: price.toFixed(2),
        needsMainPrice: ownMain <= 0 && !!q.detail?.mainMaterial,
      },
      views: [
        {
          kind: "diff", id: `view:diff:${ctx.runId}`, title: "组价方案更新", receiptId: "",
          rows: [{
            itemId: it.id, code: it.code, name: it.name, field: "unitPrice",
            before: it.unitPrice, after: a?.unitPrice ?? "",
          }],
        },
        { kind: "boqTable", id: "view:boq", title: "工程量清单" },
      ],
      receipts: [{
        actionType: "PRICE_APPLY",
        summary: `人工组价：${it.name} ${args.mode === "append" ? "增列" : "套用"} ${q.code} ${q.name}，综合单价 ${it.unitPrice} → ${price.toFixed(2)}（方案 ${plan.length} 条）`,
        before, after,
      }],
      message: `「${it.name}」组价方案已更新（${plan.length} 条子目），综合单价 ${it.unitPrice} → ${price.toFixed(2)}` +
        (ownMain <= 0 && q.detail?.mainMaterial ? `；注意该子目主材「${q.detail.mainMaterial}」暂无暂估价` : ""),
    };
  },
});
