import { z } from "zod";
import type Decimal from "decimal.js";
import { registerTool } from "./registry";
import { listBoq } from "@boq/service";
import { listQuotations } from "@material/service";
import { calcQuota, matchQuota, top2Quota, mainPriceKey, lineFromQuota, planPrice, quotaLaborTotals, hasMatchEvidence, nameBigrams, refreshItemFeatures, quotaMaterials } from "@cost-engine/quota";
import { specNorm, specCompatible } from "@cost-engine/match";
import { getQuotaLibrary } from "@quota/service";
import { findLibraryPrice, getPricePrefs } from "@dataset/service";
import { getFact, setFact, parseRateValue } from "@project/facts";
import { D, fmtMoney } from "@cost-engine/money";
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
      const sameSpec = !!(
        spec && qSpec &&
        // 与 matchQuotations 同一归一化口径：DN前缀/×÷*分隔符等价 + 复合芯段覆盖
        specCompatible(spec, qSpec)
      );
      const nameHit = !!(
        q.materialName &&
        (it.name.includes(q.materialName) ||
          (f.material && q.materialName.includes(f.material)))
      );
      // 名称必须命中——同规格不同材料（DN100 钢管 vs DN100 塑料管）只差规格不能取价；
      // 询价有规格时再加严：规格也得一致，防错价比缺价更糟
      return nameHit && (sameSpec || !qSpec);
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

/** 辅助未计价材料取价（管件/法兰/配件/法兰盘…）：定额用料表 materials[] 里
 *  首主材之外的材料名 → 项目询价 → 材料库（置信<60 不取，错价比缺价更糟）。 */
async function resolveMatPrices(
  chosen: { item: BoqItemDTO; q: import("@quota/library").QuotaEntry }[],
  quotes: QuoteList,
  pricePrefs: PricePrefs
): Promise<{ matPrices: Record<string, number>; matLibCount: number }> {
  const matPrices: Record<string, number> = {};
  let matLibCount = 0;
  const names = new Set<string>();
  for (const { q } of chosen) {
    const mats = quotaMaterials(q);
    const pm = q.detail?.mainMaterial;
    const pi = mats.findIndex((m) => pm && (m.name === pm || m.name.includes(pm) || pm.includes(m.name)));
    mats.forEach((m, i) => { if (i !== (pi >= 0 ? pi : 0)) names.add(m.name); });
  }
  for (const name of names) {
    const qh = quotes.find((qt) =>
      qt.materialName && (qt.materialName === name || name.includes(qt.materialName) || qt.materialName.includes(name)));
    if (qh && !D(qh.price).isZero()) { matPrices[name] = Number(qh.price); continue; }
    const lh = await findLibraryPrice(name, "", pricePrefs);
    if (lh && lh.score >= 60 && !D(lh.price).isZero()) { matPrices[name] = lh.price; matLibCount++; }
  }
  return { matPrices, matLibCount };
}

/** 定额说明章节正文：按定额 detail.fb（册）+ detail.chapter（章）用 bigram 桥接
 *  SpecSection.book/title 同源词汇（都出自定额体系），取交集命中节的正文合并。 */
async function specTextsFor(quotas: import("@quota/library").QuotaEntry[]): Promise<Record<string, string>> {
  const { prisma } = await import("@database/client");
  const secs = await prisma.specSection.findMany({ select: { book: true, title: true, content: true } });
  const out: Record<string, string> = {};
  for (const q of quotas) {
    const fb = q.detail?.fb ?? "", ch = q.detail?.chapter ?? "";
    if (!fb && !ch) continue;
    const key = `${fb}|${ch}`;
    if (key in out) continue;
    const fbB = nameBigrams(fb), chB = nameBigrams(ch);
    const hit = secs.filter((s) => {
      let fbHit = 0, chHit = 0;
      const sB = nameBigrams(s.book), tB = nameBigrams(s.title);
      for (const b of fbB) if (sB.has(b)) fbHit++;
      for (const b of chB) if (tB.has(b) || s.content.includes(b)) chHit++;
      return fbHit >= 1 && chHit >= 1;
    });
    out[key] = hit.map((s) => s.content).join("\n").slice(0, 30000);
  }
  return out;
}

registerTool({
  name: "quota.search",
  description: "检索内置定额库（按名称/编码/类别关键词）",
  implemented: true,
  schema: z.object({ query: z.string() }),
  handler: async (_ctx, args: { query: string }) => {
    const q = args.query.toLowerCase();
    const lib = await getQuotaLibrary();
    const hits = lib
      .filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.code.toLowerCase().includes(q) ||
          (e.match.category ?? "").includes(args.query)
      )
      // 编号定序——多数据集/内置混排时结果可复现
      .sort((a, b) => a.code.localeCompare(b.code) || a.name.localeCompare(b.name, "zh"));
    return {
      observation: hits.map((e) => ({
        code: e.code, name: e.name, unit: e.unit,
        labor: e.labor, material: e.material, machine: e.machine,
      })),
    };
  },
});

/** 定额手册核查方向：按名称 bigram 在 SpecSection 标题/册名里定位「该查哪册哪章」。
 *  未匹配项给出查询方向、歧义项给出条文依据位置——local 手册查不到再交 web.search。 */
async function specHints(queries: string[]) {
  if (!queries.length) return new Map<string, { book: string; title: string }>();
  const { prisma } = await import("@database/client");
  const secs = await prisma.specSection.findMany({ select: { book: true, title: true, content: true } });
  // 分册体量作决胜项：主手册（建筑与装饰等）章节多于仿古/修缮册，同分指到更通用的册
  const bookSize = new Map<string, number>();
  for (const s of secs) bookSize.set(s.book, (bookSize.get(s.book) ?? 0) + 1);
  const out = new Map<string, { book: string; title: string }>();
  for (const q of queries) {
    const bs = nameBigrams(q);
    let titleBest: { book: string; title: string; hit: number; size: number } | null = null;
    let bodyBest: { book: string; title: string; hit: number; size: number } | null = null;
    for (const s of secs) {
      const size = bookSize.get(s.book) ?? 0;
      let tHit = 0;
      for (const b of bs) if (`${s.title} ${s.book}`.includes(b)) tHit++;
      if (tHit && (!titleBest || tHit > titleBest.hit || (tHit === titleBest.hit && size > titleBest.size)))
        titleBest = { book: s.book, title: s.title, hit: tHit, size };
      let cHit = 0;
      for (const b of bs) if (s.content.includes(b)) cHit++;
      if (cHit && (!bodyBest || cHit > bodyBest.hit || (cHit === bodyBest.hit && size > bodyBest.size)))
        bodyBest = { book: s.book, title: s.title, hit: cHit, size };
    }
    const best = titleBest ?? bodyBest;
    if (best) out.set(q, { book: best.book, title: best.title });
  }
  return out;
}

registerTool({
  name: "quota.match",
  description: "为清单项匹配定额子目（语义特征+名称命中匹配，非字符串）",
  implemented: true,
  schema: z.object({ query: z.string().optional() }),
  handler: async (ctx) => {
    const items = await listBoq(ctx.projectId);
    const leaf = refreshItemFeatures(items.filter((i) => isPricableItem(i)));
    const lib = await getQuotaLibrary();
    // top2 候选 + 存疑判定在 service.top2Quota：分差小且基价不同才算「拿不准」
    const rows = leaf.map((item) => ({ item, ...top2Quota(item, lib) }));
    const matched = rows.filter((r) => r.best.q && r.best.s >= 50 && hasMatchEvidence(r.best.detail));
    const ambiguous = matched.filter((r) => r.ambiguous);
    let unmatched = rows.filter((r) => !matched.includes(r));

    // 通道一「继承」：同项目同名项已有确认组价方案 → 直接复用，不参与未匹配处置
    // （清单里同名项大量重复出现是常态，人工确认过一次就不该每次从零打分）
    const planByName = new Map<string, number>();
    for (const it of leaf) {
      const plan = (it.pricingPlan ?? []).filter((l) => !l.suggested);
      if (plan.length && !planByName.has(it.name.trim())) planByName.set(it.name.trim(), plan.length);
    }
    const inherited = unmatched.filter((r) => planByName.has(r.item.name.trim()) && !(r.item.pricingPlan ?? []).some((l) => !l.suggested));
    const inheritedNames = new Set(inherited.map((r) => r.item.name));
    unmatched = unmatched.filter((r) => !inheritedNames.has(r.item.name));

    // 手册核查方向：歧义项定位共享章节的条文；未匹配项按名称找该查哪册哪章
    const ambChapters = [...new Set(ambiguous.map((r) => r.best.q?.detail?.chapter ?? "").filter(Boolean))];
    const unmatchedHints = await specHints(unmatched.map((r) => r.item.name));
    const ambRefs = await specHints(ambChapters);

    // 通道二「借套」：手册章名 → 同分册/同章的定额子目候选（借套换算，非直接匹配）
    // fb/章名与手册章名同源（都出自定额体系词汇），跨词表靠 bigram 桥接
    const borrowFor = (title: string, itemName: string) => {
      const bs = nameBigrams(title);
      const ib = nameBigrams(itemName);
      return lib
        .map((e) => {
          let fbHit = 0, chHit = 0, nmHit = 0;
          for (const b of bs) {
            if (e.detail?.fb?.includes(b)) fbHit++;
            if (e.detail?.chapter?.includes(b)) chHit++;
          }
          for (const b of ib) if (e.name.includes(b)) nmHit++;
          // 同册同章内名称相近的排前——借套的「套」就在名字上
          return { e, rank: fbHit * 3 + chHit * 2 + nmHit * 4 };
        })
        .filter((c) => c.rank > 0)
        .sort((a, b) => b.rank - a.rank || a.e.code.localeCompare(b.e.code))
        .slice(0, 3)
        .map((c) => `${c.e.code} ${c.e.name}`);
    };
    const shown = unmatched.slice(0, 25).map((r) => {
      const ref = unmatchedHints.get(r.item.name);
      const borrow = ref ? borrowFor(ref.title, r.item.name) : [];
      const disposition = !ref ? "outOfScope" : borrow.length ? "borrowable" : "estimateOnly";
      const d = r.best.detail;
      const reason = !r.best.q ? "库内无候选子目" :
        d?.materialConflict ? "候选材质不合（同材料组异材）" :
        d?.bandMiss ? "清单规格超出定额档位" :
        d?.domainPenalty ? "仅其他分册有弱候选" :
        !hasMatchEvidence(d) ? "特征证据不足（类别/材质/规格未对上）" : "得分不足";
      return {
        item: r.item.name,
        disposition,
        reason,
        bestScore: r.best.s,
        ...(r.best.q ? { nearest: `${r.best.q.code} ${r.best.q.name}` } : {}),
        ...(ref ? { specRef: `${ref.book} · ${ref.title}` } : {}),
        ...(borrow.length ? { borrow } : {}),
      };
    });
    const disp = { borrowable: 0, estimateOnly: 0, outOfScope: 0 };
    for (const u of unmatched) {
      const ref = unmatchedHints.get(u.item.name);
      if (!ref) disp.outOfScope++;
      else {
        const bs = nameBigrams(ref.title);
        const has = lib.some((e) => [...bs].some((b) => e.detail?.fb?.includes(b) || e.detail?.chapter?.includes(b)));
        if (has) disp.borrowable++; else disp.estimateOnly++;
      }
    }

    return {
      observation: {
        total: leaf.length,
        matched: matched.length,
        ambiguous: ambiguous.length,
        inherited: inherited.length,
        unmatched: unmatched.length,
        dispositions: disp,
        pairs: matched.slice(0, 30).map((r) => ({
          item: r.item.name, quota: r.best.q!.name, score: r.best.s,
          ...(r.ambiguous ? { alt: `${r.alt.q!.code} ${r.alt.q!.name}`, altScore: r.alt.s, ambiguous: true } : {}),
        })),
        ...(ambRefs.size ? {
          specRefs: [...ambRefs.entries()].map(([chapter, ref]) => ({ chapter, spec: `${ref.book} · ${ref.title}` })),
        } : {}),
        ...(inherited.length ? {
          inheritedItems: [...new Set(inherited.map((r) => r.item.name))].slice(0, 10),
        } : {}),
        unmatchedHints: shown,
      },
      message: `定额匹配：${matched.length}/${leaf.length} 项直接匹配` +
        (inherited.length ? `；${inherited.length} 项可继承同名项已确认组价` : "") +
        (ambiguous.length ? `；${ambiguous.length} 项存疑（备选子目已附定额手册条文位置，spec.search 可查原文）` : "") +
        (unmatched.length
          ? `；${unmatched.length} 项无直接子目：借套换算 ${disp.borrowable}、补充单价/暂估 ${disp.estimateOnly}、覆盖域外 ${disp.outOfScope}。借套项确认后用 setItemQuota 指定，暂估项走市场询价不进定额人工费基数`
          : ""),
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
      // 同分按册/标题定序——同一检索词多次命中结果可复现
      .sort((a, b) => b.sc - a.sc || a.s.book.localeCompare(b.s.book, "zh") || a.s.title.localeCompare(b.s.title, "zh"))
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
            // 同检索词复用同一视图 id：再次检索原地刷新而不是堆叠重复标签页
            id: `view:spec:${args.query}`,
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
    const leaf = refreshItemFeatures(items.filter((i) => isPricableItem(i)));
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
    // 一遍打分三处用：辅助材料取价、定额说明章节定位、测算本体——别各扫一遍 2 万行库
    const matches = new Map(leaf.map((it) => [it.id, top2Quota(it, lib)]));
    const chosen: { item: BoqItemDTO; q: import("@quota/library").QuotaEntry }[] = [];
    for (const it of leaf) {
      const b = matches.get(it.id)!.best;
      if (b.q && b.s >= 50 && hasMatchEvidence(b.detail)) chosen.push({ item: it, q: b.q });
    }
    const { matPrices, matLibCount } = await resolveMatPrices(chosen, quotes, pricePrefs);
    const specTexts = await specTextsFor(chosen.map((c) => c.q));
    const rows = calcQuota(leaf, { mainPrices, matPrices, specTexts, mgmtRate, profitRate, lib, matches });
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
        (needMain ? `，${needMain} 项缺材料价（测算价不含该材料费，属不完整单价）` : "") +
        (libCount || matLibCount
          ? `，材料库取价：主材 ${libCount} 项` +
            (matLibCount ? `、辅材 ${matLibCount} 种` : "") +
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
  description: "把定额测算综合单价写回清单项（需确认；缺主材价的不完整测算默认跳过，生成 Diff 与回执）。前置条件：台账须有「管理费率」「利润率」事实——用户报出数值时先用 project.setFact 写入（确实不计写 0%），缺失会直接报错",
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
    const leaf = refreshItemFeatures(items.filter((i) => isPricableItem(i)));
    const pricePrefs = await getPricePrefs(ctx.projectId);
    const { mainPrices } = await resolveMainPrices(leaf, quotes, pricePrefs);
    const mgmtRate = parseRateValue((await getFact(ctx.projectId, "管理费率"))?.value) ?? 0;
    const profitRate = parseRateValue((await getFact(ctx.projectId, "利润率"))?.value) ?? 0;
    const lib = await getQuotaLibrary();
    const matches = new Map(leaf.map((it) => [it.id, top2Quota(it, lib)]));
    const chosen: { item: BoqItemDTO; q: import("@quota/library").QuotaEntry }[] = [];
    for (const it of leaf) {
      const b = matches.get(it.id)!.best;
      if (b.q && b.s >= 50 && hasMatchEvidence(b.detail)) chosen.push({ item: it, q: b.q });
    }
    const { matPrices } = await resolveMatPrices(chosen, quotes, pricePrefs);
    const specTexts = await specTextsFor(chosen.map((c) => c.q));
    const rows = calcQuota(leaf, { mainPrices, matPrices, specTexts, mgmtRate, profitRate, lib, matches });
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
  description: "人工为清单项指定定额子目：replace 替换主项（处置存疑匹配），append 增列配套子目（冲洗/支吊架/试压等）。综合单价按组价方案合计重算。前置条件同 quota.applyCalc（需管理费率/利润率事实），且定额主材缺价时会报错",
  implemented: true,
  schema: z.object({
    itemId: z.string().optional().describe("清单项 id（单项时用这个）"),
    itemIds: z.array(z.string()).optional().describe("批量指定清单项 id（与 itemId 二选一或并用）"),
    quotaCode: z.string().describe("定额编号，如 5H0332").optional(),
    mode: z.enum(["replace", "append"]).optional().describe("replace=替换主项（默认）；append=增列到组价方案"),
    clear: z.boolean().optional().describe("true=清除该项组价方案（恢复清单原价不变，仅清方案）"),
  }),
  confirm: (a: { quotaCode?: string; mode?: string; clear?: boolean; itemIds?: string[]; itemId?: string }) => {
    const n = (a.itemIds?.length ?? 0) + (a.itemId ? 1 : 0);
    return a.clear ? `将清除 ${n} 个清单项的组价方案` : `将把定额 ${a.quotaCode} ${a.mode === "append" ? "增列到" : "设为"} ${n} 个清单项的组价方案，综合单价按方案合计重算`;
  },
  handler: async (ctx, args: { itemId?: string; itemIds?: string[]; quotaCode?: string; mode?: "replace" | "append"; clear?: boolean }) => {
    const ids = [...new Set([...(args.itemIds ?? []), ...(args.itemId ? [args.itemId] : [])])];
    if (!ids.length) return { observation: { error: "未指定清单项" } };
    const items = await listBoq(ctx.projectId);
    const targets = ids.map((id) => items.find((x) => x.id === id)).filter((x): x is BoqItemDTO => !!x);
    if (!targets.length) return { observation: { error: "清单项不存在" } };
    const { updateBoqItems } = await import("@boq/service");

    if (args.clear) {
      const { before, after } = await updateBoqItems(ctx.projectId,
        targets.map((it) => ({ id: it.id, patch: { pricingPlan: [] } })));
      return {
        observation: { cleared: targets.length },
        receipts: [{
          actionType: "BOQ_UPDATE",
          summary: `清除组价方案：${targets.map((t) => t.name).slice(0, 5).join("、")}${targets.length > 5 ? ` 等${targets.length}项` : ""}`,
          before, after,
        }],
        message: `已清除 ${targets.length} 个清单项的组价方案，综合单价保留现值`,
      };
    }

    const lib = await getQuotaLibrary();
    const q = lib.find((e) => e.code === args.quotaCode);
    if (!q) return { observation: { error: `定额库中无 ${args.quotaCode}，可用 quota.search 检索` } };

    for (const key of ["管理费率", "利润率"]) {
      if (parseRateValue((await getFact(ctx.projectId, key))?.value) === null) throw new Error(`${key}尚未确认，请先填写计价设置再人工组价`);
    }

    const mgmtRate = parseRateValue((await getFact(ctx.projectId, "管理费率"))?.value) ?? 0;
    const profitRate = parseRateValue((await getFact(ctx.projectId, "利润率"))?.value) ?? 0;
    // 主材价沿用清单项主材暂估价；该子目本身没有主材（材料费已含基价）时不加，防重复计
    const expectsMain = q.detail === undefined || quotaMaterials(q).length > 0 || !!q.detail.mainMaterial;

    const patches: { id: string; patch: { unitPrice: string; pricingPlan: unknown[] } }[] = [];
    const rows: { it: BoqItemDTO; price: Decimal; planLen: number }[] = [];
    const noMainItems: BoqItemDTO[] = [];
    for (const it of targets) {
      const ownMainD = D(it.mainMaterialPrice ?? "0");
      const hasMain = ownMainD.isFinite() && ownMainD.gt(0);
      // 红线：子目有主材但清单项无暂估价 → 写出的综合单价不完整，跳过该项不写
      if (expectsMain && !hasMain) { noMainItems.push(it); continue; }
      const line = lineFromQuota(it, q, {
        mgmtRate, profitRate,
        mainPrice: hasMain && expectsMain ? ownMainD.toNumber() : undefined,
        manual: true,
      });
      const existing = (it.pricingPlan ?? []).filter((l) => !l.suggested);
      const plan = args.mode === "append" ? [...existing, line] : [line];
      const price = planPrice(plan);
      patches.push({ id: it.id, patch: { unitPrice: price.toFixed(2), pricingPlan: plan } });
      rows.push({ it, price, planLen: plan.length });
    }
    if (!patches.length)
      return { observation: { error: `主材「${q.detail?.mainMaterial}」缺价`, skipped: noMainItems.length }, message: `全部目标项缺主材「${q.detail?.mainMaterial}」暂估价，未写入——请先补主材暂估价再组价` };

    const { before, after } = await updateBoqItems(ctx.projectId, patches);
    const first = rows[0];
    const multi = rows.length > 1;
    return {
      observation: {
        count: rows.length, quota: `${q.code} ${q.name}`, mode: args.mode ?? "replace",
        skippedNoMainPrice: noMainItems.length,
        items: rows.map((r) => ({ itemId: r.it.id, unitPrice: r.price.toFixed(2) })),
      },
      views: [
        {
          kind: "diff", id: `view:diff:${ctx.runId}`, title: "组价方案更新", receiptId: "",
          rows: rows.map((r) => ({
            itemId: r.it.id, code: r.it.code, name: r.it.name, field: "unitPrice",
            before: r.it.unitPrice, after: r.price.toFixed(2),
          })),
        },
        { kind: "boqTable", id: "view:boq", title: "工程量清单" },
      ],
      receipts: [{
        actionType: "PRICE_APPLY",
        summary: multi
          ? `人工组价：${rows.length} 项套用 ${q.code} ${q.name}（${args.mode === "append" ? "增列" : "替换主项"}）`
          : `人工组价：${first.it.name} ${args.mode === "append" ? "增列" : "套用"} ${q.code} ${q.name}，综合单价 ${fmtMoney(first.it.unitPrice)} → ${fmtMoney(first.price)}（方案 ${first.planLen} 条）`,
        before, after,
      }],
      message: multi
        ? `已对 ${rows.length} 个清单项${args.mode === "append" ? "增列" : "套用"}定额 ${q.code} ${q.name}，综合单价按方案合计重算` +
          (noMainItems.length ? `；${noMainItems.length} 项缺主材「${q.detail?.mainMaterial}」暂估价未写入` : "")
        : `「${first.it.name}」组价方案已更新（${first.planLen} 条子目），综合单价 ${fmtMoney(first.it.unitPrice)} → ${fmtMoney(first.price)}` +
          (noMainItems.length ? `；另有 ${noMainItems.length} 项缺主材暂估价未写入` : ""),
    };
  },
});
