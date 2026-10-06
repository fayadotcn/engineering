import { listBoq } from "@boq/service";
import { top2Quota, hasMatchEvidence, nameBigrams, refreshItemFeatures } from "@cost-engine/quota";
import { isPricableItem } from "@shared/types";
import { usageItemKey, usageSpecTags } from "@cost-engine/usageKey";
import { getQuotaLibrary } from "./service";
import { specHints } from "./spec";
import { usageForKeys, usageForItem } from "./usage";

export async function matchProjectQuotas(projectId: string) {

  const items = await listBoq(projectId);
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
  // 通道三「经验套用」：历史工程（宏业 GCFX 语料）实际怎么套。
  // 语料定额码是宏业库编码、不入 QuotaRow——只作处置参考，不参与自动组价。
  const usageKeys = unmatched.map((r) => ({
    itemKey: usageItemKey(r.item.name, r.item.unit, r.item.rawFeature),
    specTags: usageSpecTags(r.item.name, r.item.rawFeature),
  }));
  const usageMap = await usageForKeys(usageKeys);
  const usageFuzzy = new Set<string>();

  const shown = [];
  for (const r of unmatched.slice(0, 25)) {
    const ref = unmatchedHints.get(r.item.name);
    const borrow = ref ? borrowFor(ref.title, r.item.name) : [];
    const itemKey = usageItemKey(r.item.name, r.item.unit, r.item.rawFeature);
    let usage = usageMap.get(itemKey);
    if (!usage) {
      const fuzzy = await usageForItem(r.item.name, r.item.unit, r.item.rawFeature);
      if (fuzzy) {
        usage = { quotas: fuzzy.quotas, combos: fuzzy.combos };
        usageMap.set(itemKey, usage);
        usageFuzzy.add(itemKey);
      }
    }
    const hasUsage = !!(usage?.quotas.length || usage?.combos.length);
    const disposition = hasUsage ? "usage" : !ref ? "outOfScope" : borrow.length ? "borrowable" : "estimateOnly";
    const d = r.best.detail;
    const reason = !r.best.q ? "库内无候选子目" :
      d?.materialConflict ? "候选材质不合（同材料组异材）" :
      d?.bandMiss ? "清单规格超出定额档位" :
      d?.domainPenalty ? "仅其他分册有弱候选" :
      !hasMatchEvidence(d) ? "特征证据不足（类别/材质/规格未对上）" : "得分不足";
    shown.push({
      item: r.item.name,
      disposition,
      reason,
      bestScore: r.best.s,
      ...(r.best.q ? { nearest: `${r.best.q.code} ${r.best.q.name}` } : {}),
      ...(ref ? { specRef: `${ref.book} · ${ref.title}` } : {}),
      ...(borrow.length ? { borrow } : {}),
      ...(usage?.quotas.length ? {
        usage: usage.quotas.slice(0, 3).map((q) =>
          `${q.applied || q.code}${q.conv ? "(换算)" : ""} ${q.name}　×${q.uses}/${q.projects}项目 ${q.flag === "common" ? "共识" : q.flag === "suspect" ? "存疑" : "低频"}`),
      } : {}),
      ...(usage?.combos.length ? {
        usageCombos: usage.combos.slice(0, 2).map((c) =>
          `${c.lines.map((l) => l.applied || l.code).join("+")} ${c.lines.map((l) => l.name.split(" ").pop() ?? l.name).join("+")}　×${c.uses}/${c.projects}项目`),
      } : {}),
    });
  }
  const disp = { usage: 0, borrowable: 0, estimateOnly: 0, outOfScope: 0 };
  for (const u of unmatched) {
    const uh = usageMap.get(usageItemKey(u.item.name, u.item.unit, u.item.rawFeature));
    if (uh?.quotas.length || uh?.combos.length) {
      disp.usage++;
      continue;
    }
    const ref = unmatchedHints.get(u.item.name);
    if (!ref) disp.outOfScope++;
    else {
      const bs = nameBigrams(ref.title);
      const has = lib.some((e) => [...bs].some((b) => e.detail?.fb?.includes(b) || e.detail?.chapter?.includes(b)));
      if (has) disp.borrowable++; else disp.estimateOnly++;
    }
  }

  return { leaf, matched, ambiguous, unmatched, inherited, ambRefs, shown, disp, usageMap, usageKeys, usageFuzzy };
}
