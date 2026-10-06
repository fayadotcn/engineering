import { z } from "zod";
import { registerTool } from "./registry";
import { getQuotaLibrary } from "@quota/service";
import { matchProjectQuotas } from "@quota/matching";
import { searchSpecs, specTextsFor, qdItemsFor } from "@quota/spec";
import { searchUsage, usageSummary } from "@quota/usage";
import { previewProjectPricing, applyProjectPricing, setItemQuota } from "@quota/pricing";
import { fmtMoney } from "@cost-engine/money";
import { parseSemanticFeature } from "@cost-engine/semantic";
import { scoreQuotaDetail, quotaMaterials } from "@cost-engine/quota";
import type { BoqItemDTO, DiffRow, UsageMatchRow } from "@shared/types";

registerTool({
  name: "quota.search",
  description: "语义检索定额库：查询词按清单项特征（类别/材质/规格DN/连接方式）打分排序，也支持名称/编号/类别字面命中。返回行人材机为每定额单位口径，报价须按 unitScale 折算并计入 unpricedMaterials 全部未计价材料（主材+管件/法兰等）",
  implemented: true,
  schema: z.object({ query: z.string() }),
  handler: async (_ctx, args: { query: string }) => {
    const q = args.query.trim();
    const lib = await getQuotaLibrary();
    // 与 quota.match 同一语义口径：查询词当一条伪清单项做特征打分。
    // 定额名写「公称直径 65mm以内」而不是「DN65」——纯整串 includes 永远够不到
    // （历史事故：模型连查三次「镀锌钢管 DN65」0 命中，误报定额库无该子目）。
    const probe = {
      name: q, rawFeature: "", unit: "", sectionPath: "", discipline: "OTHER",
      features: parseSemanticFeature(q, ""),
    } as BoqItemDTO;
    const literal = q.toLowerCase();
    const scored = lib
      .map((e) => ({
        e,
        s: scoreQuotaDetail(probe, e).score,
        literal:
          e.name.toLowerCase().includes(literal) ||
          e.code.toLowerCase().includes(literal) ||
          (e.match.category ?? "").includes(q),
      }))
      .filter((h) => h.s > 0 || h.literal);
    const hits = scored
      // 语义分定序；同分按编号——多数据集/内置混排时结果可复现
      .sort((a, b) =>
        b.s - a.s || Number(b.literal) - Number(a.literal) ||
        a.e.code.localeCompare(b.e.code) || a.e.name.localeCompare(b.e.name, "zh"))
      .slice(0, 30);
    // 定额说明上下文：组价完整性看「已含/不含/另行/按设计」条文
    // （沟槽管件另行执行管件连接子目、法兰数量按设计图纸用…）。
    // 首选命中子目自身章节的说明（对口分册），词检索命中作补充。
    const NORM_SENT = /不含|未含|另计|另行|包括|已含|系数|按实|按设计|以\s*["“](个|套|10)/;
    const texts = await specTextsFor(hits.slice(0, 5).map((h) => h.e));
    const relatedSpecs: { ref: string; rules: string }[] = [];
    for (const key of Object.keys(texts)) {
      const rules = (texts[key] ?? "")
        .split(/[。；;\n]/).map((s) => s.trim())
        .filter((s) => NORM_SENT.test(s)).slice(0, 5).join("；").slice(0, 360);
      // 相邻章节常映射到同一节条文（室外/室内/燃气章 → 同一册说明）——按内容去重
      if (rules && !relatedSpecs.some((r) => r.rules === rules))
        relatedSpecs.push({ ref: key.replace(/\|/g, " / "), rules });
    }
    const { hits: specHits } = await searchSpecs({ query: q });
    for (const h of specHits) {
      const ref = `${h.book} / ${h.title}`;
      if (relatedSpecs.some((r) => r.ref === ref)) continue;
      const rules = h.excerpt
        .split(/[。；;\n]/).map((s) => s.trim())
        .filter((s) => NORM_SENT.test(s)).join("；").slice(0, 320);
      if (rules) relatedSpecs.push({ ref, rules });
      if (relatedSpecs.length >= 3) break;
    }
    relatedSpecs.splice(3);
    // GB 清单项工程内容：命中子目的 xmbh 清单编码 → 清单库工程内容/计算规则/项目特征。
    // 组价完整性核对依据——清单工程内容列出的工序必须在组价方案里有着落。
    const { prisma } = await import("@database/client");
    const mkRows = await prisma.quotaRow.findMany({
      where: { code: { in: hits.slice(0, 8).map((h) => h.e.code) } },
      select: { code: true, matchKeys: true },
    });
    const xmbhs = mkRows.flatMap((r) => {
      try { return String(JSON.parse(r.matchKeys ?? "{}").xmbh ?? "").split(",").filter(Boolean); }
      catch { return []; }
    });
    const gbItems = (await qdItemsFor(xmbhs)).map((g) => ({
      quotaCodes: mkRows.filter((r) => (r.matchKeys ?? "").includes(g.code)).map((r) => r.code),
      ref: `GB清单 ${g.title}`,
      content: g.content.slice(0, 500),
    }));
    return {
      observation: hits.map(({ e }) => ({
        code: e.code, name: e.name, unit: e.unit, unitScale: e.unitScale,
        labor: e.labor, material: e.material, machine: e.machine,
        // 未计价材料全量（主材+管件/法兰/型钢等辅助件），qtyPerUnit 已折算每清单单位。
        // 报价口径必须含 Σ含量×单价——只报人材机会把消防管件这类未计价材料丢掉。
        unpricedMaterials: quotaMaterials(e).map((m) => ({
          name: m.name, unit: m.unit, qtyPerUnit: m.qtyPerUnit,
        })),
        mainMaterial: e.detail?.mainMaterial ?? null,
      })),
      gbItems,
      ...(relatedSpecs.length ? { relatedSpecs } : {}),
      message: hits.length
        ? scored.length > hits.length
          ? `按语义相关度返回前 ${hits.length} 条（共 ${scored.length} 条命中）`
          : undefined
        : `定额库中未检索到「${q}」相关子目——可换短关键词重试，或用 quota.usage 查历史工程套用经验`,
    };
  },
});


registerTool({
  name: "quota.match",
  description: "为清单项匹配定额子目（语义特征+名称命中匹配，非字符串）",
  implemented: true,
  schema: z.object({ query: z.string().optional() }),
  handler: async (ctx) => {
    const { leaf, matched, ambiguous, unmatched, inherited, ambRefs, shown, disp, usageMap, usageKeys, usageFuzzy } = await matchProjectQuotas(ctx.projectId);
    // 经验套用视图：未匹配项 + 命中的历史套用候选（编码为宏业库口径，仅处置参考）
    const usageRows: UsageMatchRow[] = [];
    for (const [i, r] of unmatched.entries()) {
      const hit = usageKeys[i]?.itemKey ? usageMap.get(usageKeys[i].itemKey) : undefined;
      if (!hit) continue;
      usageRows.push({
        itemName: r.item.name, unit: r.item.unit,
        fuzzy: usageFuzzy.has(usageKeys[i].itemKey),
        quotas: hit.quotas, combos: hit.combos,
      });
      if (usageRows.length >= 60) break;
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
      views: usageRows.length ? [{
        kind: "quotaUsage" as const,
        id: `view:usage:${ctx.projectId}`,
        title: "历史工程套用经验（未匹配项）",
        rows: usageRows,
      }] : [],
      message: `定额匹配：${matched.length}/${leaf.length} 项直接匹配` +
        (inherited.length ? `；${inherited.length} 项可继承同名项已确认组价` : "") +
        (ambiguous.length ? `；${ambiguous.length} 项存疑（备选子目已附定额手册条文位置，spec.search 可查原文）` : "") +
        (unmatched.length
          ? `；${unmatched.length} 项无直接子目：历史套用可参考 ${disp.usage}（flag=共识/低频/存疑，明细见经验视图，编号为宏业口径不入库，选定额时需按名称检索库内对应子目再 setItemQuota）` +
            `、借套换算 ${disp.borrowable}、补充单价/暂估 ${disp.estimateOnly}、覆盖域外 ${disp.outOfScope}。借套项确认后用 setItemQuota 指定，暂估项走市场询价不进定额人工费基数`
          : ""),
    };

  },
});

// 历史工程定额套用经验库：800+ 个宏业 GCFX 工程文件解析沉淀。
// flag 口径：common=≥2个独立项目共识 | rare=低频 | suspect=孤例且桶内已有共识（疑似错套）。
registerTool({
  name: "quota.usage",
  description: "查历史工程定额套用经验库（从 D 盘 800+ 宏业计价文件解析的清单→定额套用频次，按多项目共识排序；编码为宏业口径仅作参考）",
  implemented: true,
  schema: z.object({
    query: z.string().describe("清单名称关键词，如「刚性防水套管」「防火阀」「镀锌钢管」"),
  }),
  handler: async (_ctx, args: { query: string }) => {
    const [buckets, summary] = await Promise.all([searchUsage(args.query), usageSummary()]);
    const rows: UsageMatchRow[] = buckets.map((b) => ({
      itemName: b.itemName,
      unit: b.key.split("|")[1] ?? "",
      quotas: b.quotas,
      combos: b.combos,
    }));
    return {
      observation: {
        query: args.query,
        corpus: summary,
        buckets: buckets.length,
        hits: buckets.slice(0, 15).map((b) => ({
          item: b.itemName,
          quotas: b.quotas.slice(0, 3).map((q) => `${q.applied || q.code} ${q.name}　×${q.uses}/${q.projects}项目 ${q.flag}`),
          combos: b.combos.slice(0, 2).map((c) => `${c.lines.map((l) => l.applied || l.code).join("+")}　×${c.uses}/${c.projects}项目`),
        })),
      },
      views: rows.length ? [{
        kind: "quotaUsage" as const,
        id: `view:usage:q:${args.query}`,
        title: `套用经验：${args.query}`,
        query: args.query,
        rows,
      }] : [],
      message: buckets.length
        ? `经验库命中 ${buckets.length} 个名称模式（语料共 ${summary.buckets} 桶/${summary.stats} 条套用/${summary.combos} 种组合），常见套法见视图`
        : `经验库中没有「${args.query}」相关套用记录（语料共 ${summary.buckets} 个名称模式）`,
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
    const { total, hits } = await searchSpecs(args);
    return {
      observation: { total, hits },
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
    const { leaf, rows, done, needMain, deviant, laborBase, mgmtRate, profitRate, missingRates, libCount, libOffBrand, matLibCount } = await previewProjectPricing(ctx.projectId, ctx.runId);
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
    const { applied, skipped, before, after, mgmtRate, profitRate } = await applyProjectPricing(ctx.projectId, args);
    if (!applied) return {
      observation: { applied: 0, skipped: skipped.length },
      message: skipped.length
        ? `${skipped.length} 项测算缺主材价，属不完整单价，未写回——先补主材暂估价（询价/材料库）再组价`
        : "没有可写回的测算结果，请先运行定额测算",
    };
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
      observation: { applied, skippedIncomplete: skipped.length, mgmtRate, profitRate },
      views: [
        { kind: "diff", id: `view:diff:${ctx.runId}`, title: "组价写回 Diff", receiptId: "", rows: diffRows },
        { kind: "boqTable", id: "view:boq", title: "工程量清单" },
      ],
      receipts: [{
        actionType: "PRICE_APPLY",
        summary: `定额组价写回：${applied} 项综合单价（管理费 ${mgmtRate * 100}%/利润 ${profitRate * 100}%）${skipped.length ? `，${skipped.length} 项缺主材价未写` : ""}`,
        before: before.map((b) => ({ id: b.id, name: b.name, unitPrice: b.unitPrice, pricingPlan: b.pricingPlan })),
        after: after.map((a) => ({ id: a.id, name: a.name, unitPrice: a.unitPrice, pricingPlan: a.pricingPlan })),
      }],
      message: `已把定额测算综合单价写回 ${applied} 项${skipped.length ? `；${skipped.length} 项缺主材价跳过` : ""}`,
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
    quotaCode: z.string().describe("定额编号，如 CJ0016").optional(),
    mode: z.enum(["replace", "append"]).optional().describe("replace=替换主项（默认）；append=增列到组价方案"),
    clear: z.boolean().optional().describe("true=清除该项组价方案（恢复清单原价不变，仅清方案）"),
  }),
  confirm: (a: { quotaCode?: string; mode?: string; clear?: boolean; itemIds?: string[]; itemId?: string }) => {
    const n = (a.itemIds?.length ?? 0) + (a.itemId ? 1 : 0);
    return a.clear ? `将清除 ${n} 个清单项的组价方案` : `将把定额 ${a.quotaCode} ${a.mode === "append" ? "增列到" : "设为"} ${n} 个清单项的组价方案，综合单价按方案合计重算`;
  },
  handler: async (ctx, args: { itemId?: string; itemIds?: string[]; quotaCode?: string; mode?: "replace" | "append"; clear?: boolean }) => {
    const result = await setItemQuota(ctx.projectId, args);
    if (result.kind === "error") return {
      observation: { error: result.error, ...(result.skipped !== undefined ? { skipped: result.skipped } : {}) },
      ...(result.message ? { message: result.message } : {}),
    };
    if (result.kind === "cleared") {
      const { targets, before, after } = result;
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
    const { q, rows, noMainItems, before, after } = result;
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
