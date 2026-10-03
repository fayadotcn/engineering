import { D } from "./money";
import { groupKey } from "./semantic";
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
}

function alignKey(it: BoqItemDTO): string {
  if (it.code.trim()) return `C:${it.code.trim()}`;
  return `S:${groupKey(it.name, it.unit, it.features)}`;
}

export function compareBoqSets(a: BoqItemDTO[], b: BoqItemDTO[]): FileCompareRow[] {
  const leaf = (xs: BoqItemDTO[]) => xs.filter((i) => !i.isHeader && i.name.trim());
  const mapA = new Map<string, BoqItemDTO>();
  const mapB = new Map<string, BoqItemDTO>();
  for (const it of leaf(a)) mapA.set(alignKey(it), it);
  for (const it of leaf(b)) mapB.set(alignKey(it), it);

  const keys = new Set([...mapA.keys(), ...mapB.keys()]);
  const rows: FileCompareRow[] = [];
  for (const key of keys) {
    const ia = mapA.get(key);
    const ib = mapB.get(key);
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
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const sum = (units: Record<string, unknown>[], k: string) => units.reduce((a, u) => a + num(u[k]), 0);
  const labels = DECLARED_LABELS.map((label) => {
    const a = sum(unitsA, label);
    const b = sum(unitsB, label);
    return { label, a, b, diff: b - a };
  }).filter((r) => r.a !== 0 || r.b !== 0);

  const byName = new Map<string, { a?: number; b?: number }>();
  const put = (u: Record<string, unknown>, side: "a" | "b") => {
    const name = String(u.unit ?? u.name ?? "").trim();
    if (!name) return;
    const cur = byName.get(name) ?? {};
    cur[side] = (cur[side] ?? 0) + num(u["合计"]);
    byName.set(name, cur);
  };
  for (const u of unitsA) put(u, "a");
  for (const u of unitsB) put(u, "b");
  const units = [...byName.entries()].map(([name, v]) => {
    const a = v.a ?? 0;
    const b = v.b ?? 0;
    return {
      name, a, b, diff: b - a,
      side: v.a !== undefined && v.b !== undefined ? ("both" as const) : v.a !== undefined ? ("a" as const) : ("b" as const),
    };
  });
  return { labels, units };
}
