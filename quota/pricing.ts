import type Decimal from "decimal.js";
import { listBoq, updateBoqItems } from "@boq/service";
import { listQuotations } from "@material/service";
import { calcQuota, top2Quota, mainPriceKey, lineFromQuota, planPrice, quotaLaborTotals, hasMatchEvidence, refreshItemFeatures, quotaMaterials, primaryMaterialOf, PSEUDO_MAT } from "@cost-engine/quota";
import { specCompatible } from "@cost-engine/match";
import { findLibraryPrice, getPricePrefs } from "@dataset/service";
import { specTokens } from "@dataset/priceMatch";
import { getFact, setFact, parseRateValue } from "@project/facts";
import { D } from "@cost-engine/money";
import { isPricableItem, type BoqItemDTO } from "@shared/types";
import { getQuotaLibrary } from "./service";
import { specTextsFor } from "./spec";
import type { QuotaEntry } from "./library";

type QuoteList = Awaited<ReturnType<typeof listQuotations>>;
type PricePrefs = Awaited<ReturnType<typeof getPricePrefs>>;

/**
 * 主材价求解（quota.calculate / applyCalc 共用）：项目询价按 material+spec 优先，
 * 未命中回退全局材料库（含品牌/地区/期次偏好打分）。
 * 置信 <60 不取——错价比缺价更糟：缺价会标 needsMainPrice 留给询价环节。
 *
 * 库检索多路取词：定额子目声明的主材名（quotaMats）> 清单特征材质 > 清单名。
 * 清单特征是常解析错的口径（大便器→「陶瓷砖」、BV线→「铜」、地板→假 DN 档），
 * 而定额用料表的主材名是造价师真实的取价依据；三路各打分，取最高分命中。
 */
async function resolveMainPrices(
  leaf: BoqItemDTO[],
  quotes: QuoteList,
  pricePrefs: PricePrefs,
  quotaMats?: Map<string, { name: string; unit: string }>
): Promise<{
  mainPrices: Record<string, number>;
  libCount: number;
  libOffBrand: number;
}> {
  const mainPrices: Record<string, number> = {};
  let libCount = 0, libOffBrand = 0;
  // 同词同规格不重复查库（插座×8、同规格电缆×N 共享一次检索）
  type LibHit = Awaited<ReturnType<typeof findLibraryPrice>>;
  const cache = new Map<string, Promise<LibHit>>();
  const lookup = (term: string, spec: string, opts?: { material?: string; unit?: string; extraSpecText?: string }) => {
    const k = `${term}|${spec}|${opts?.material ?? ""}|${opts?.unit ?? ""}`;
    let p = cache.get(k);
    if (!p) { p = findLibraryPrice(term, spec, pricePrefs, opts); cache.set(k, p); }
    return p;
  };
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
    // 三路取词去重：定额主材名（权威）→ 特征材质 → 清单名；伪材料名/泛称「主材」不作检索词
    const qm = quotaMats?.get(it.id);
    const terms: { term: string; material: string; unit?: string }[] = [];
    for (const t of [
      qm ? { term: qm.name, material: qm.name, unit: qm.unit || it.unit } : null,
      f.material ? { term: f.material, material: f.material, unit: it.unit } : null,
      { term: it.name, material: f.material ?? "", unit: it.unit },
    ]) {
      if (!t || !t.term.trim() || t.term.trim() === "主材" || PSEUDO_MAT.test(t.term.trim())) continue;
      if (terms.some((x) => x.term === t.term)) continue;
      terms.push(t);
    }
    let best: LibHit = null;
    for (const t of terms) {
      const r = await lookup(t.term, spec, { material: t.material, unit: t.unit, extraSpecText: it.name });
      if (r && (!best || r.score > best.score)) best = r;
    }
    // 带规格全低于阈值的最后一搏：去规格重查，但只接受本身不带型号段的行
    // （「综合」档库行如装配式U形轻钢龙骨）；带规格的行查不到就是对不上，不能用错档价
    if (spec && (!best || best.score < 60)) {
      for (const t of terms) {
        const r = await lookup(t.term, "", { material: t.material, unit: t.unit, extraSpecText: it.name });
        if (r && r.score >= 60 && ![...specTokens(`${r.name} ${r.spec}`)].length &&
          (!best || best.score < 60 || r.score > best.score)) best = r;
      }
    }
    if (best && best.score >= 60 && !D(best.price).isZero()) {
      mainPrices[mainPriceKey(it)] = best.price;
      libCount++;
      if (best.notes.some((n) => n.includes("非指定"))) libOffBrand++;
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
    // 伪材料名（其他材料费/水/损耗…）不取价——不是可询价材料，也别计入缺价名单
    if (PSEUDO_MAT.test(name.trim())) continue;
    const qh = quotes.find((qt) =>
      qt.materialName && (qt.materialName === name || name.includes(qt.materialName) || qt.materialName.includes(name)));
    if (qh && !D(qh.price).isZero()) { matPrices[name] = Number(qh.price); continue; }
    const lh = await findLibraryPrice(name, "", pricePrefs, { material: name });
    if (lh && lh.score >= 60 && !D(lh.price).isZero()) { matPrices[name] = lh.price; matLibCount++; }
  }
  return { matPrices, matLibCount };
}

/** Calculation and writeback share the same loaded inputs and calculation path. */
async function loadPricingRates(projectId: string) {
  const [mgmtFact, profitFact] = await Promise.all([
    getFact(projectId, "管理费率"), getFact(projectId, "利润率"),
  ]);
  const mgmtRate = parseRateValue(mgmtFact?.value);
  const profitRate = parseRateValue(profitFact?.value);
  return {
    mgmtRate: mgmtRate ?? 0,
    profitRate: profitRate ?? 0,
    missingRates: [mgmtRate === null ? "管理费率" : "", profitRate === null ? "利润率" : ""].filter(Boolean),
  };
}

async function calculateProjectPricing(projectId: string, rates?: Awaited<ReturnType<typeof loadPricingRates>>) {
  const [items, quotes] = await Promise.all([
    listBoq(projectId),
    listQuotations(projectId),
  ]);
  const leaf = refreshItemFeatures(items.filter((i) => isPricableItem(i)));
  const pricePrefs = await getPricePrefs(projectId);
  const { mgmtRate, profitRate, missingRates } = rates ?? await loadPricingRates(projectId);

  const lib = await getQuotaLibrary();
  // 一遍打分三处用：辅助材料取价、定额说明章节定位、测算本体——别各扫一遍 2 万行库。
  // 主材取价在匹配之后：定额用料表的主材名是比清单特征更权威的检索词。
  const matches = new Map(leaf.map((it) => [it.id, top2Quota(it, lib)]));
  const chosen: { item: BoqItemDTO; q: QuotaEntry }[] = [];
  const quotaMats = new Map<string, { name: string; unit: string }>();
  for (const it of leaf) {
    const b = matches.get(it.id)!.best;
    if (b.q && b.s >= 50 && hasMatchEvidence(b.detail)) {
      chosen.push({ item: it, q: b.q });
      const pm = primaryMaterialOf(b.q);
      if (pm && pm.name !== "主材") quotaMats.set(it.id, pm);
    }
  }
  const { mainPrices, libCount, libOffBrand } = await resolveMainPrices(
    leaf, quotes, pricePrefs, quotaMats
  );
  const { matPrices, matLibCount } = await resolveMatPrices(chosen, quotes, pricePrefs);
  const specTexts = await specTextsFor(chosen.map((c) => c.q));
  const rows = calcQuota(leaf, { mainPrices, matPrices, specTexts, mgmtRate, profitRate, lib, matches });

  return { leaf, rows, mgmtRate, profitRate, missingRates, libCount, libOffBrand, matLibCount };
}

export async function previewProjectPricing(projectId: string, agentRunId?: string) {
  const calculation = await calculateProjectPricing(projectId);
  const { rows } = calculation;
  const done = rows.filter((r) => r.quotaCode);
  const needMain = done.filter((r) => r.needsMainPrice).length;
  const deviant = done.filter(
    (r) => r.deviation !== null && Math.abs(Number(r.deviation)) > 20
  );
  // 定额人工费合计 → 台账（规费基数是人工费而非分部分项费，四川安装口径）
  // 同时按定额分册(5G/5H/5I…)存明细——措施费系数(脚手架/超高/高层)按册取人工费基数
  const { total: laborBase, byBook: laborByBook } = quotaLaborTotals(done);
  if (done.length) {
    await setFact(projectId, {
      factType: "取费基数",
      key: "定额人工费",
      value: laborBase,
      source: "INFERRED",
      confidence: 0.7,
      createdBy: "agent",
      agentRunId,
    });
    await setFact(projectId, {
      factType: "取费基数",
      key: "定额人工费明细",
      value: JSON.stringify(laborByBook),
      source: "INFERRED",
      confidence: 0.7,
      createdBy: "agent",
      agentRunId,
    });
  }

  return { ...calculation, done, needMain, deviant, laborBase };
}

export interface ApplyPricingInput {
  includeIncomplete?: boolean;
  onlyItemIds?: string[];
}

export async function applyProjectPricing(projectId: string, args: ApplyPricingInput = {}) {
  const rates = await loadPricingRates(projectId);
  if (rates.missingRates.length)
    throw new Error(`${rates.missingRates[0]}尚未确认，请先在计价设置中填写（确实不计时填 0%）再写回组价`);
  const calculation = await calculateProjectPricing(projectId, rates);
  const { rows, mgmtRate, profitRate } = calculation;
  const allowed = args.onlyItemIds ? new Set(args.onlyItemIds) : null;
  const writable = rows.filter(
    (r) => r.quotaCode && r.calcPrice &&
      (args.includeIncomplete || !r.needsMainPrice) &&
      (!allowed || allowed.has(r.itemId))
  );
  const skipped = rows.filter((r) => r.quotaCode && r.needsMainPrice && !args.includeIncomplete);
  if (!writable.length) return { applied: 0, skipped, before: [], after: [], mgmtRate, profitRate };
  const { before, after } = await updateBoqItems(
    projectId,
    writable.map((r) => ({
      id: r.itemId,
      // 综合单价=组价方案合计；pricingPlan 只落已确认行（suggested 不计入）
      patch: { unitPrice: r.calcPrice!, pricingPlan: (r.plan ?? []).filter((l) => !l.suggested) },
    }))
  );

  return { applied: writable.length, skipped, before, after, mgmtRate, profitRate };
}

export interface SetItemQuotaInput {
  itemId?: string;
  itemIds?: string[];
  quotaCode?: string;
  mode?: "replace" | "append";
  clear?: boolean;
}

export async function setItemQuota(projectId: string, args: SetItemQuotaInput) {
  const ids = [...new Set([...(args.itemIds ?? []), ...(args.itemId ? [args.itemId] : [])])];
  if (!ids.length) return { kind: "error" as const, error: "未指定清单项" };
  const items = await listBoq(projectId);
  const targets = ids.map((id) => items.find((x) => x.id === id)).filter((x): x is BoqItemDTO => !!x);
  if (!targets.length) return { kind: "error" as const, error: "清单项不存在" };

  if (args.clear) {
    const { before, after } = await updateBoqItems(projectId,
      targets.map((it) => ({ id: it.id, patch: { pricingPlan: [] } })));
    return { kind: "cleared" as const, targets, before, after };
  }

  const lib = await getQuotaLibrary();
  const q = lib.find((e) => e.code === args.quotaCode);
  if (!q) return { kind: "error" as const, error: `定额库中无 ${args.quotaCode}，可用 quota.search 检索` };

  const { mgmtRate, profitRate, missingRates } = await loadPricingRates(projectId);
  if (missingRates.length)
    throw new Error(`${missingRates[0]}尚未确认，请先填写计价设置再人工组价`);
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
    return { kind: "error" as const, error: `主材「${q.detail?.mainMaterial}」缺价`, skipped: noMainItems.length, message: `全部目标项缺主材「${q.detail?.mainMaterial}」暂估价，未写入——请先补主材暂估价再组价` };

  const { before, after } = await updateBoqItems(projectId, patches);

  return { kind: "applied" as const, q, rows, noMainItems, before, after };
}
