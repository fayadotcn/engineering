import { z } from "zod";
import { registerTool } from "./registry";
import { listBoq } from "@boq/service";
import { listQuotations } from "@material/service";
import { calcQuota, matchQuota, mainPriceKey, getQuotaLibrary } from "@quota/service";
import { findLibraryPrice } from "@dataset/service";
import { getFact } from "@project/facts";
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
    const matches = leaf.map((i) => matchQuota(i, 50, lib));
    const matched = matches.filter((m) => m.quota);
    return {
      observation: {
        total: leaf.length,
        matched: matched.length,
        pairs: matched.slice(0, 30).map((m) => ({
          item: m.item.name, quota: m.quota!.name, score: m.score,
        })),
      },
      message: `定额匹配：${matched.length}/${leaf.length} 项匹配到子目`,
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
      args.mgmtRate ?? (mgmtFact ? Number(mgmtFact.replace("%", "")) / 100 : 0.16);
    const profitRate =
      args.profitRate ?? (profitFact ? Number(profitFact.replace("%", "")) / 100 : 0.09);

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
