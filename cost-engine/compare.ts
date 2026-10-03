import Decimal from "decimal.js";
import { D, decStr, lineTotal, maxD, median, minD } from "./money";
import { featureCompatible, groupKey, normUnit } from "./semantic";
import { isPricableItem, type AnomalyRow, type BoqItemDTO } from "@shared/types";

// Candidate Grouping -> Feature Comparison -> Price Comparison.
// Never plain string matching.

export interface CompareOptions {
  /** items with quantity 0 are ignored (per spec: 工程量为0的不用管) */
  skipZeroQuantity?: boolean;
  /** price deviation ratio vs median to flag anomaly, default 0.15 */
  anomalyRatio?: number;
  onlyPriced?: boolean;
}

const eligible = (it: BoqItemDTO, opts: CompareOptions) =>
  !it.isHeader &&
  it.name.trim().length > 0 &&
  !(opts.skipZeroQuantity !== false && D(it.quantity).isZero()) &&
  !(opts.onlyPriced !== false && D(it.unitPrice).isZero());

function toRowItem(it: BoqItemDTO) {
  return {
    id: it.id,
    code: it.code,
    name: it.name,
    feature: it.rawFeature,
    unit: it.unit,
    quantity: it.quantity,
    unitPrice: it.unitPrice,
    sectionPath: it.sectionPath,
  };
}

function label(it: BoqItemDTO): string {
  const f = it.features;
  const bits = [
    f.category,
    f.material,
    f.diameter ?? f.specification,
    f.power,
    f.connectionMethod,
    f.system,
  ].filter(Boolean);
  return bits.length ? bits.join(" · ") : it.name;
}

export function groupCandidates(
  items: BoqItemDTO[],
  opts: CompareOptions = {}
): Map<string, BoqItemDTO[]> {
  const groups = new Map<string, BoqItemDTO[]>();
  for (const it of items) {
    if (!eligible(it, opts)) continue;
    const key = groupKey(it.name, it.unit, it.features);
    const arr = groups.get(key) ?? [];
    arr.push(it);
    groups.set(key, arr);
  }
  return groups;
}

/** 相同项不同单价: same semantic item priced differently. */
export function findSameItemDifferentPrice(
  items: BoqItemDTO[],
  opts: CompareOptions = {}
): AnomalyRow[] {
  const rows: AnomalyRow[] = [];
  for (const [key, group] of groupCandidates(items, opts)) {
    if (group.length < 2) continue;
    const prices = [...new Set(group.map((g) => decStr(D(g.unitPrice))))];
    if (prices.length < 2) continue;

    // Feature comparison: drop pairs that genuinely differ in features
    const conflicts = new Set<string>();
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++) {
        const c = featureCompatible(group[i].features, group[j].features);
        c.conflicts.forEach((x) => conflicts.add(x));
      }
    const priceDs = group.map((g) => D(g.unitPrice));
    const spread = maxD(priceDs).minus(minD(priceDs));
    rows.push({
      groupKey: key,
      label: label(group[0]),
      items: group.map(toRowItem),
      prices,
      spread: spread.toString(),
      reason:
        conflicts.size > 0
          ? `特征存在差异但仍疑似同项: ${[...conflicts].join("；")}`
          : "语义特征一致，综合单价不一致",
    });
  }
  return rows.sort((a, b) => D(b.spread ?? 0).cmp(D(a.spread ?? 0)));
}

/** 综合单价异常: within same-semantic group, price deviates from median > ratio. */
export function findPriceAnomalies(
  items: BoqItemDTO[],
  opts: CompareOptions = {}
): AnomalyRow[] {
  const ratio = D(opts.anomalyRatio ?? 0.15);
  const rows: AnomalyRow[] = [];
  for (const [key, group] of groupCandidates(items, opts)) {
    if (group.length < 3) continue; // need a meaningful baseline
    const med = median(group.map((g) => D(g.unitPrice)));
    if (med.isZero()) continue;
    const bad = group.filter((g) =>
      D(g.unitPrice).minus(med).abs().div(med).gt(ratio)
    );
    if (!bad.length) continue;
    rows.push({
      groupKey: key,
      label: label(group[0]),
      items: group.map(toRowItem),
      prices: [...new Set(group.map((g) => decStr(D(g.unitPrice))))],
      reason: `组内中位价 ${med.toFixed(2)}，偏离超过 ${ratio.mul(100).toFixed(0)}%`,
    });
  }
  return rows;
}

/** 相同编码/名称 但项目特征语义不一致。 */
export function findFeatureMismatch(items: BoqItemDTO[]): AnomalyRow[] {
  const byCodeName = new Map<string, BoqItemDTO[]>();
  for (const it of items) {
    if (it.isHeader || !it.name.trim()) continue;
    const key = it.code
      ? `C:${it.code.trim()}`
      : `N:${it.name.trim()}|${it.unit}`;
    const arr = byCodeName.get(key) ?? [];
    arr.push(it);
    byCodeName.set(key, arr);
  }
  const rows: AnomalyRow[] = [];
  for (const [key, group] of byCodeName) {
    if (group.length < 2) continue;
    const conflicts = new Set<string>();
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++) {
        const c = featureCompatible(group[i].features, group[j].features);
        c.conflicts.forEach((x) => conflicts.add(x));
      }
    if (!conflicts.size) continue;
    rows.push({
      groupKey: key,
      label: group[0].name,
      items: group.map(toRowItem),
      prices: [...new Set(group.map((g) => decStr(D(g.unitPrice))))],
      reason: `编码/名称相同但项目特征不一致: ${[...conflicts].join("；")}`,
    });
  }
  return rows;
}

/**
 * 算术校验（清标第一查）：可计价行的「合价」应等于 工程量×综合单价。
 * 导入时源表合价按原值保留（可能是暂估/让利率后的数），与量×价不符说明
 * 源表公式断链、改量忘改价或抄写错误——清标时必须逐条曝光。
 * 容差取 max(0.02 元, 期望值的 0.1%)：分分钱舍入噪声不报。
 */
export function findArithmeticMismatches(
  items: BoqItemDTO[],
  opts: { relTol?: number; absTol?: number } = {}
): AnomalyRow[] {
  const rel = D(opts.relTol ?? 0.001);
  const abs = D(opts.absTol ?? 0.02);
  const bad: { it: BoqItemDTO; expected: Decimal; diff: Decimal }[] = [];
  for (const it of items) {
    if (!isPricableItem(it)) continue;
    const qty = D(it.quantity), price = D(it.unitPrice);
    if (qty.isZero() || price.isZero()) continue; // 未报价/零量行不是算术错误
    const expected = lineTotal(qty, price);
    const diff = D(it.totalPrice).minus(expected);
    if (diff.abs().gt(Decimal.max(abs, expected.abs().mul(rel))))
      bad.push({ it, expected, diff });
  }
  if (!bad.length) return [];
  const totalDiff = bad.reduce((a, x) => a.plus(x.diff.abs()), D(0));
  return [
    {
      groupKey: "ARITHMETIC",
      label: `合价≠量×价（${bad.length} 项）`,
      items: bad.map((x) => toRowItem(x.it)),
      prices: bad.map((x) => decStr(x.expected)),
      spread: totalDiff.toString(),
      reason: `源表合价与「工程量×综合单价」不符，差异合计 ${totalDiff.toFixed(2)} 元——疑似源表公式断链、改量忘改价或抄写错误，请核对原始 Excel`,
    },
  ];
}

/**
 * 单位不一致：同语义组（名称/类别/材质/规格一致，不计单位）内出现不同量纲，
 * 如电缆一部分用 m 一部分用 km——量纲错位会让合价差 1000 倍，清标必须曝光。
 * 同义单位（米≡m、平米≡㎡）经 normUnit 归一，不算不一致。
 */
export function findUnitInconsistencies(items: BoqItemDTO[]): AnomalyRow[] {
  const groups = new Map<string, BoqItemDTO[]>();
  for (const it of items) {
    if (it.isHeader || !it.name.trim() || !it.unit.trim()) continue;
    if (D(it.quantity).isZero()) continue;
    const key = groupKey(it.name, "", it.features); // 不计单位
    const arr = groups.get(key) ?? [];
    arr.push(it);
    groups.set(key, arr);
  }
  const rows: AnomalyRow[] = [];
  for (const [key, group] of groups) {
    const units = [...new Set(group.map((g) => normUnit(g.unit)).filter(Boolean))];
    if (units.length < 2) continue;
    rows.push({
      groupKey: key,
      label: label(group[0]),
      items: group.map(toRowItem),
      prices: [...new Set(group.map((g) => decStr(D(g.unitPrice))))],
      reason: `同语义清单项单位不一致（${units.join(" / ")}），疑似量纲或编制口径错误`,
    });
  }
  return rows;
}

/**
 * 一码多名：同一项目编码对应不同名称——GB50500 清单编码应唯一，
 * 同码异物说明编码错用/复制错行，结算对审会按编码对不上量。
 */
export function findCodeNameMismatch(items: BoqItemDTO[]): AnomalyRow[] {
  const byCode = new Map<string, BoqItemDTO[]>();
  for (const it of items) {
    if (it.isHeader || !it.name.trim() || !it.code.trim()) continue;
    const key = it.code.trim().replace(/\s+/g, "");
    const arr = byCode.get(key) ?? [];
    arr.push(it);
    byCode.set(key, arr);
  }
  const rows: AnomalyRow[] = [];
  for (const [code, group] of byCode) {
    const names = [...new Set(group.map((g) => g.name.trim().replace(/\s+/g, "")))];
    if (names.length < 2) continue;
    rows.push({
      groupKey: `CODE:${code}`,
      label: code,
      items: group.map(toRowItem),
      prices: [...new Set(group.map((g) => decStr(D(g.unitPrice))))],
      reason: `同一项目编码对应 ${names.length} 个不同名称（${names.join(" / ")}），清单编码应唯一，疑似编码错用`,
    });
  }
  return rows;
}

/**
 * 缺编码检查：分部分项/单价措施（量×价计价的可计价行）编码为空。
 * GB50500 清单项目必须有编码；总价措施/其他项目本就常无编码，不报。
 */
export function findMissingCodes(items: BoqItemDTO[]): AnomalyRow[] {
  const missing = items.filter(
    (it) => isPricableItem(it) && !it.isHeader && it.name.trim() && !it.code.trim()
  );
  if (!missing.length) return [];
  return [{
    groupKey: "MISSING_CODE",
    label: "缺编码",
    items: missing.map(toRowItem),
    prices: [...new Set(missing.map((g) => decStr(D(g.unitPrice))))],
    reason: `${missing.length} 项可计价清单缺项目编码——GB50500 要求逐项编码，对审/评标无法按码对量`,
  }];
}

/**
 * 编码格式校验：GB50500 清单项目编码应为 12 位数字（附录 9 位 + 顺序码 3 位）。
 * 非空但非 12 位纯数字的编码（自编补码、缺位、混入字母）单列提示——
 * 对审/评标按编码对量时非标编码对不上，应人工确认是否为约定补码。
 */
export function findInvalidCodes(items: BoqItemDTO[]): AnomalyRow[] {
  const bad = items.filter(
    (it) => !it.isHeader && it.name.trim() && it.code.trim() && !/^\d{12}$/.test(it.code.trim().replace(/\s+/g, ""))
  );
  if (!bad.length) return [];
  return [{
    groupKey: "INVALID_CODE",
    label: "非标编码",
    items: bad.map(toRowItem),
    prices: [...new Set(bad.map((g) => decStr(D(g.unitPrice))))],
    reason: `${bad.length} 项编码非 12 位国标数字编码（GB50500 应为 附录9位+顺序码3位），疑似自编/错录，对审按编码对量时会漏配`,
  }];
}

/** 重复项: code+name+unit identical AND semantic features identical. */
export function findDuplicateItems(items: BoqItemDTO[]): AnomalyRow[] {
  const rows: AnomalyRow[] = [];
  for (const [key, group] of groupCandidates(items, { onlyPriced: false, skipZeroQuantity: false })) {
    const exact = new Map<string, BoqItemDTO[]>();
    for (const it of group) {
      if (!it.code) continue;
      // 同编码在不同单位工程各列一条是正常做法——重复检测限同一单位工程内
      const k = `${it.unitProject ?? ""}|${it.code}|${key}`;
      const arr = exact.get(k) ?? [];
      arr.push(it);
      exact.set(k, arr);
    }
    for (const [k, g] of exact) {
      if (g.length < 2) continue;
      rows.push({
        groupKey: k,
        label: g[0].name,
        items: g.map(toRowItem),
        prices: [...new Set(g.map((x) => decStr(D(x.unitPrice))))],
        reason: "相同编码且语义特征一致，疑似重复清单项",
      });
    }
  }
  return rows;
}

/**
 * 数据质量检查：可计价行上的硬伤——负综合单价（必错）、负工程量（结算核减需确认）、
 * 缺计量单位（量纲缺失无法计价复核）。总额计价行不在此列（没有量价结构）。
 */
export function findDataIssues(items: BoqItemDTO[]): AnomalyRow[] {
  const negPrice = items.filter((it) => isPricableItem(it) && !it.isHeader && D(it.unitPrice).lt(0));
  const negQty = items.filter((it) => isPricableItem(it) && !it.isHeader && D(it.quantity).lt(0));
  const noUnit = items.filter((it) => isPricableItem(it) && !it.isHeader && it.name.trim() && !it.unit.trim());
  const rows: AnomalyRow[] = [];
  if (negPrice.length)
    rows.push({
      groupKey: "DATA:NEG_PRICE",
      label: "负综合单价",
      items: negPrice.map(toRowItem),
      prices: negPrice.map((g) => decStr(D(g.unitPrice))),
      reason: `${negPrice.length} 项综合单价为负——综合单价不可能为负，源表数据错误或应改核减口径`,
    });
  if (negQty.length)
    rows.push({
      groupKey: "DATA:NEG_QTY",
      label: "负工程量",
      items: negQty.map(toRowItem),
      prices: negQty.map((g) => decStr(D(g.unitPrice))),
      reason: `${negQty.length} 项工程量为负——清单行负量通常是结算核减口径，请确认是否应并入对应正量行`,
    });
  if (noUnit.length)
    rows.push({
      groupKey: "DATA:NO_UNIT",
      label: "缺计量单位",
      items: noUnit.map(toRowItem),
      prices: noUnit.map((g) => decStr(D(g.unitPrice))),
      reason: `${noUnit.length} 项可计价清单缺计量单位——GB50500 五项要素必填，缺单位无法复核量纲`,
    });
  return rows;
}
