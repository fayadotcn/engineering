import { D } from "./money";
import { featureCompatible, groupKey, normUnit } from "./semantic";
import type { BoqItemDTO } from "@shared/types";

// 两版清单对审（招标 vs 中标 / 中标 vs 结算）：
// 优先按编码对齐，无编码按语义组键对齐。

export interface FileCompareRow {
  key: string;
  code: string;
  name: string;
  status: "SAME" | "PRICE_DIFF" | "QTY_DIFF" | "BOTH_DIFF" | "ONLY_A" | "ONLY_B";
  aId?: string;
  bId?: string;
  aQty?: string;
  bQty?: string;
  aPrice?: string;
  bPrice?: string;
  aTotal?: string;
  bTotal?: string;
  qtyDelta?: string;
  priceDelta?: string;
  totalDelta?: string;
  /** 量差绝对值超基准量 15%（GB50500：工程量偏差超15%应重新组价/调整综合单价） */
  qtyOver15?: boolean;
  /** 五统一符合性：对齐成功的两行名称原文不一致（去空白/全半角归一后） */
  nameMismatch?: boolean;
  /** 五统一符合性：归一后单位仍不一致（m vs km 量纲错；米≡m 归一不算） */
  unitMismatch?: boolean;
  /** 五统一符合性：项目特征语义冲突明细（空数组=无冲突，字段不出） */
  featureConflict?: string[];
}

function alignKey(it: BoqItemDTO): string {
  if (it.code.trim()) return `C:${it.code.trim()}`;
  return `S:${groupKey(it.name, it.unit, it.features)}`;
}

const upKey = (it: BoqItemDTO) => (it.unitProject ?? "").trim().replace(/\s+/g, "");

export function compareBoqSets(a: BoqItemDTO[], b: BoqItemDTO[]): FileCompareRow[] {
  const leaf = (xs: BoqItemDTO[]) => xs.filter((i) => !i.isHeader && i.name.trim());
  // 同一文件里编码会重复（多单位工程各自含同一条清单）——先按对齐键分组，
  // 组内按单位工程名定序后按下标配对：两版文件单位工程排列顺序不同
  // （A 先 1#楼后 2#楼、B 反过来）时不会出现跨楼栋错配；同名单位工程
  // 内部仍靠出现序对齐同码重复行。单位工程空的行排在最前。
  const grouped = (xs: BoqItemDTO[]) => {
    const map = new Map<string, BoqItemDTO[]>();
    for (const it of xs) {
      const k = alignKey(it);
      const arr = map.get(k) ?? [];
      arr.push(it);
      map.set(k, arr);
    }
    for (const arr of map.values())
      arr.sort((x, y) => upKey(x).localeCompare(upKey(y), "zh"));
    return map;
  };
  const mapA = grouped(leaf(a));
  const mapB = grouped(leaf(b));

  // 组内配对：有单位工程归属时严格同归属配对——A 的 1#楼行绝不该和
  // B 的 2#楼行比量价差，同归属数量不等时剩余进 ONLY_*（那才是真差异）；
  // 两边都没有单位工程时退回顺序配对（老数据兼容）。
  const pairUp = (listA: BoqItemDTO[], listB: BoqItemDTO[]) => {
    const pairs: [BoqItemDTO | undefined, BoqItemDTO | undefined][] = [];
    const usedB = new Set<number>();
    const anyUp = [...listA, ...listB].some((i) => upKey(i));
    for (const ia of listA) {
      const j = anyUp
        ? listB.findIndex((ib, idx) => !usedB.has(idx) && upKey(ib) === upKey(ia))
        : listB.findIndex((_, idx) => !usedB.has(idx));
      if (j < 0) { pairs.push([ia, undefined]); continue; }
      usedB.add(j);
      pairs.push([ia, listB[j]]);
    }
    for (let idx = 0; idx < listB.length; idx++)
      if (!usedB.has(idx)) pairs.push([undefined, listB[idx]]);
    return pairs;
  };

  const keys = new Set([...mapA.keys(), ...mapB.keys()]);
  const rows: FileCompareRow[] = [];
  for (const key of keys) {
    for (const [ia, ib] of pairUp(mapA.get(key) ?? [], mapB.get(key) ?? [])) {
      const name = ia?.name ?? ib?.name ?? "";
      const code = ia?.code ?? ib?.code ?? "";
      if (ia && ib) {
      const qtyDiff = !D(ia.quantity).eq(D(ib.quantity));
      const priceDiff = !D(ia.unitPrice).eq(D(ib.unitPrice));
      const status = qtyDiff && priceDiff ? "BOTH_DIFF" : qtyDiff ? "QTY_DIFF" : priceDiff ? "PRICE_DIFF" : "SAME";
      // GB50500：量差超基准量 15% 是调价触发线（应重新组价，不能沿用原综合单价）
      const qtyOver15 =
        qtyDiff && !D(ia.quantity).isZero() &&
        D(ib.quantity).minus(ia.quantity).abs().div(D(ia.quantity).abs()).gt(0.15);
      // 五统一符合性：编码/语义能对齐但名称原文、单位、项目特征不响应招标口径
      const nameMismatch =
        ia.name.trim().replace(/\s+/g, "") !== ib.name.trim().replace(/\s+/g, "");
      const unitMismatch = normUnit(ia.unit) !== normUnit(ib.unit);
      const featureConflict = featureCompatible(ia.features, ib.features).conflicts;
      rows.push({
        key, code, name, status,
        aId: ia.id, bId: ib.id,
        aQty: ia.quantity, bQty: ib.quantity,
        aPrice: ia.unitPrice, bPrice: ib.unitPrice,
        aTotal: ia.totalPrice, bTotal: ib.totalPrice,
        qtyDelta: qtyDiff ? D(ib.quantity).minus(ia.quantity).toString() : undefined,
        priceDelta: priceDiff ? D(ib.unitPrice).minus(ia.unitPrice).toString() : undefined,
        totalDelta: D(ib.totalPrice).minus(ia.totalPrice).toString(),
        qtyOver15: qtyOver15 || undefined,
        nameMismatch: nameMismatch || undefined,
        unitMismatch: unitMismatch || undefined,
        featureConflict: featureConflict.length ? featureConflict : undefined,
      });
    } else {
      const it = ia ?? ib!;
      rows.push({
        key, code, name,
        status: ia ? "ONLY_A" : "ONLY_B",
        aId: ia?.id, bId: ib?.id,
        aQty: ia?.quantity, bQty: ib?.quantity,
        aPrice: ia?.unitPrice, bPrice: ib?.unitPrice,
        aTotal: ia?.totalPrice, bTotal: ib?.totalPrice,
        totalDelta: ia ? D(ia.totalPrice).neg().toString() : D(ib!.totalPrice).toString(),
      });
      }
    }
  }
  const order = { ONLY_B: 0, ONLY_A: 1, BOTH_DIFF: 2, PRICE_DIFF: 3, QTY_DIFF: 4, SAME: 5 };
  return rows.sort((x, y) => order[x.status] - order[y.status]);
}

/** 造价流转顺序：招标→投标→清标→进度→变更→报审→结算→财评；对审默认「最早阶段 ↔ 最晚阶段」。
 *  stage 为空视为最靠前——文件名不带阶段词的通常就是原始清单/招标版（如「X工程清单.xls」）。 */
export const COMPARE_STAGE_ORDER = ["招标", "投标", "清标", "进度", "变更", "报审", "结算", "财评"];
const stageRank = (s: string) => (!s ? -1 : Math.max(0, COMPARE_STAGE_ORDER.indexOf(s)));

/** 缺省对审对：按（阶段序 → 期次 → 上传时间）排序取首末——招标vs结算、上期vs本期都能落到正确方向 */
export function pickComparePair<T extends { stage: string; period: string; createdAt: Date }>(files: T[]): [T, T] {
  const sorted = [...files].sort(
    (x, y) =>
      stageRank(x.stage) - stageRank(y.stage) ||
      (x.period || "").localeCompare(y.period || "") ||
      x.createdAt.getTime() - y.createdAt.getTime()
  );
  return [sorted[0], sorted[sorted.length - 1]];
}

export function compareSummary(rows: FileCompareRow[]) {
  const count = (s: FileCompareRow["status"]) => rows.filter((r) => r.status === s).length;
  const deltaSum = rows.reduce((a, r) => a.plus(D(r.totalDelta ?? 0)), D(0));
  return {
    total: rows.length,
    same: count("SAME"),
    priceDiff: count("PRICE_DIFF") + count("BOTH_DIFF"),
    qtyDiff: count("QTY_DIFF") + count("BOTH_DIFF"),
    qtyOver15: rows.filter((r) => r.qtyOver15).length,
    /** 五统一符合性：名称/单位/特征任一不符的对齐行数 */
    compliance: rows.filter((r) => r.nameMismatch || r.unitMismatch || r.featureConflict?.length).length,
    onlyA: count("ONLY_A"),
    onlyB: count("ONLY_B"),
    totalDelta: deltaSum.toFixed(2),
  };
}

/* ---------------- 申报口径对审（文件汇总事实两两配对） ---------------- */

export interface DeclaredFeeDiff {
  label: string;
  a: number;
  b: number;
  diff: number;
}

export interface DeclaredUnitDiff {
  name: string;
  a: number;
  b: number;
  diff: number;
  /** both=两版都有该单位工程；a/b=独有 */
  side: "both" | "a" | "b";
}

export interface DeclaredCompare {
  labels: DeclaredFeeDiff[];
  units: DeclaredUnitDiff[];
}

const DECLARED_LABELS = ["分部分项工程费", "措施项目费", "其他项目费", "规费", "税金", "合计"];

/**
 * 「本期 vs 上期」申报口径对比：输入两份「文件汇总:{filename}」事实的 JSON
 * （每行一个单位工程：{unit, 分部分项工程费, …, 合计}），输出费用口径差
 * + 按单位工程名对齐的合计差（找出是哪个单位工程在动）。
 */
export function compareDeclaredFees(
  unitsA: Record<string, unknown>[],
  unitsB: Record<string, unknown>[]
): DeclaredCompare {
  // 金额口径同样走 Decimal——裸 float 累加会在多单位工程求和时积出分位噪声
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const sum = (units: Record<string, unknown>[], k: string) => units.reduce((a, u) => a.plus(num(u[k])), D(0));
  const labels = DECLARED_LABELS.map((label) => {
    const a = sum(unitsA, label);
    const b = sum(unitsB, label);
    return { label, a: a.toNumber(), b: b.toNumber(), diff: b.minus(a).toNumber() };
  }).filter((r) => r.a !== 0 || r.b !== 0);

  const byName = new Map<string, { a?: ReturnType<typeof D>; b?: ReturnType<typeof D> }>();
  const put = (u: Record<string, unknown>, side: "a" | "b") => {
    const name = String(u.unit ?? u.name ?? "").trim();
    if (!name) return;
    const cur = byName.get(name) ?? {};
    cur[side] = (cur[side] ?? D(0)).plus(num(u["合计"]));
    byName.set(name, cur);
  };
  for (const u of unitsA) put(u, "a");
  for (const u of unitsB) put(u, "b");
  const units = [...byName.entries()].map(([name, v]) => {
    const a = v.a ?? D(0);
    const b = v.b ?? D(0);
    return {
      name, a: a.toNumber(), b: b.toNumber(), diff: b.minus(a).toNumber(),
      side: v.a !== undefined && v.b !== undefined ? ("both" as const) : v.a !== undefined ? ("a" as const) : ("b" as const),
    };
  });
  return { labels, units };
}
