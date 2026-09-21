import { z } from "zod";
import { registerTool } from "./registry";
import { listBoq } from "@boq/service";
import { listQuotations } from "@material/service";
import { calcQuota, matchQuota, top2Quota, mainPriceKey, getQuotaLibrary } from "@quota/service";
import { findLibraryPrice } from "@dataset/service";
import { getFact, parseRateValue } from "@project/facts";
import { D } from "@cost-engine/money";

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
    const leaf = items.filter((i) => !i.isHeader && i.name.trim());
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
  schema: z.object({
    mgmtRate: z.number().optional().describe("管理费率，缺省读台账否则0.16"),
    profitRate: z.number().optional().describe("利润率，缺省读台账否则0.09"),
  }),
  handler: async (ctx, args: { mgmtRate?: number; profitRate?: number }) => {
    const [items, quotes] = await Promise.all([
      listBoq(ctx.projectId),
      listQuotations(ctx.projectId),
    ]);
    const leaf = items.filter((i) => !i.isHeader && i.name.trim());

    // 主材价来源：询价表按 material+spec 匹配
    const mainPrices: Record<string, number> = {};
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
      if (hit && !D(hit.price).isZero()) mainPrices[mainPriceKey(it)] = Number(hit.price);
      else {
        // 项目询价没命中 → 回退到全局材料价格库（后台上传的数据集）
        const libPrice = await findLibraryPrice(f.material ?? it.name, spec);
        if (libPrice !== null && !D(libPrice).isZero())
          mainPrices[mainPriceKey(it)] = libPrice;
      }
    }

    const mgmtFact = (await getFact(ctx.projectId, "管理费率"))?.value;
    const profitFact = (await getFact(ctx.projectId, "利润率"))?.value;
    const mgmtRate =
      args.mgmtRate ?? parseRateValue(mgmtFact) ?? 0.16;
    const profitRate =
      args.profitRate ?? parseRateValue(profitFact) ?? 0.09;

    const lib = await getQuotaLibrary();
    const rows = calcQuota(leaf, { mainPrices, mgmtRate, profitRate, lib });
    const done = rows.filter((r) => r.quotaCode);
    const needMain = done.filter((r) => r.needsMainPrice).length;
    const deviant = done.filter(
      (r) => r.deviation !== null && Math.abs(Number(r.deviation)) > 20
    );
    return {
      observation: {
        total: leaf.length,
        matched: done.length,
        needsMainPrice: needMain,
        deviationOver20pct: deviant.length,
        mgmtRate, profitRate,
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
        (needMain ? `，${needMain} 项缺主材价（主材费未计）` : "") +
        (deviant.length ? `，${deviant.length} 项测算价与清单价偏差>20%` : ""),
    };
  },
});
