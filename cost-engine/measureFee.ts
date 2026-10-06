import Decimal from "decimal.js";
import { D, sum } from "./money";

// 四川2020 安装工程措施费系数计取（确定性计算，不经过模型）。
// 数据源：Dataset「四川2020措施费系数」(ps_fy+ps_fl 官方费率表)。
// 口径：
//  - 脚手架搭拆费：各分册按 定额人工费(册) × 费率 平费率计取
//  - 超高增加费：按「操作物高度」选档，仅计该册定额人工费
//  - 高层建筑增加费：按「檐口高度」选最小满足档
//  - 系统调整费：仅当台账显式启用；基数按专业对应册（采暖→5H、通风空调→5I）
//  - 特殊环境增加费（同时进行/洞库/高原等）：显式启用才计
// 费率行带 人工/材料/机械 占比拆分，供费用构成的专业呈现。

export interface MeasureFeeRate {
  fyid: number;
  name: string;
  /** 分册代码 5B/5G/5H/5I/5F…；"通用"=不限册 */
  book: string;
  category: "脚手架搭拆费" | "超高增加费" | "高层建筑增加费" | "系统调整费" | "特殊环境增加费" | "其他措施费" | string;
  /** 计算基数公式原文（如 定额人工费WG*费率/100） */
  base: string;
  baseWithMachine: boolean;
  tiers: {
    tier: string;
    rate: number;
    laborPct: number | null;
    materialPct: number | null;
    machinePct: number | null;
  }[];
}

export interface MeasureFeeSettings {
  /** 檐口高度（m）→ 高层建筑增加费档位 */
  eaveHeight?: number | null;
  /** 操作物高度（m）→ 超高增加费档位 */
  workHeight?: number | null;
  /** 启用的系统调整费名称片段，如 ["采暖","通风空调"] */
  systemAdjust?: string[];
  /** 启用的特殊环境费名称片段 */
  specialEnv?: string[];
}

export interface MeasureFeeLine {
  name: string;
  book: string;
  category: string;
  tier: string;
  /** 基数描述，如 "定额人工费(5G) 12,345.67" */
  basis: string;
  rate: string;
  amount: string;
  /** 占比拆分金额（元），null=该要素无占比 */
  laborPart: string | null;
  materialPart: string | null;
  machinePart: string | null;
}

export interface MeasureFeeResult {
  lines: MeasureFeeLine[];
  total: string;
  skipped: { name: string; reason: string }[];
}

/** 档位文本 → 数值区间（上限含）："檐口高度30m以下"→[0,30]; "5m<操作物高度…≤8m"→(5,8]; "…5m以上"→(5,∞) */
function tierRange(tier: string): { lo: number; hi: number; loExclusive: boolean } | null {
  const between = tier.match(/(\d+(?:\.\d+)?)\s*m?\s*<\s*操作物高度[^≤]*≤\s*(\d+(?:\.\d+)?)\s*m/i);
  if (between) return { lo: +between[1], hi: +between[2], loExclusive: true };
  const below = tier.match(/(\d+(?:\.\d+)?)\s*m\s*以下/i);
  if (below) return { lo: 0, hi: +below[1], loExclusive: false };
  const above = tier.match(/(\d+(?:\.\d+)?)\s*m\s*以上/i);
  if (above) return { lo: +above[1], hi: Infinity, loExclusive: true };
  return null;
}

/** 分档费率选档：高度落在区间内；多档命中取最紧（hi 最小）的档 */
function pickTier(tiers: MeasureFeeRate["tiers"], height: number) {
  let best: MeasureFeeRate["tiers"][number] | null = null;
  let bestHi = Infinity;
  for (const t of tiers) {
    const r = tierRange(t.tier);
    if (!r) continue;
    const inRange = r.loExclusive ? height > r.lo : height >= r.lo;
    if (inRange && height <= r.hi && r.hi < bestHi) {
      best = t;
      bestHi = r.hi;
    }
  }
  return best;
}

/** 系统调整费名称 → 适用分册（SC21：采暖工程系统调整费在 CK，空调水/通风空调在 CK/CG；5H/5I=旧库） */
const SYSTEM_BOOK: [RegExp, string[]][] = [
  [/采暖/, ["CK", "5H"]],
  [/通风空调|空调水/, ["CG", "CK", "5I"]],
];

export function computeMeasureFees(
  rates: MeasureFeeRate[],
  laborByBook: Record<string, Decimal>,
  settings: MeasureFeeSettings = {},
): MeasureFeeResult {
  const lines: MeasureFeeLine[] = [];
  const skipped: { name: string; reason: string }[] = [];

  const emit = (f: MeasureFeeRate, book: string, tier: MeasureFeeRate["tiers"][number], base: Decimal) => {
    const amount = base.mul(tier.rate);
    const part = (pct: number | null) => (pct === null ? null : amount.mul(pct).div(100).toFixed(2));
    lines.push({
      name: f.name, book, category: f.category, tier: tier.tier,
      basis: `${f.baseWithMachine ? "定额人工费+机械费" : "定额人工费"}(${book === "通用" ? "全部册" : book}) ${base.toFixed(2)}`,
      rate: `${(tier.rate * 100).toFixed(2).replace(/\.?0+$/, "")}%`,
      amount: amount.toFixed(2),
      laborPart: part(tier.laborPct),
      materialPart: part(tier.materialPct),
      machinePart: part(tier.machinePct),
    });
  };

  for (const f of rates) {
    const books = f.book === "通用"
      ? Object.keys(laborByBook).filter((b) => laborByBook[b].gt(0))
      : [f.book];

    if (f.category === "系统调整费") {
      const hit = (settings.systemAdjust ?? []).some((s) => f.name.includes(s));
      if (!hit) { skipped.push({ name: f.name, reason: "未启用（台账「系统调整费」可开启）" }); continue; }
      const target = SYSTEM_BOOK.find(([re]) => re.test(f.name))?.[1] ?? books;
      for (const b of target) {
        const base = laborByBook[b];
        if (!base?.gt(0)) { skipped.push({ name: `${f.name}(${b})`, reason: "该册无定额人工费（未测算或无此册子目）" }); continue; }
        const tier = f.tiers[0];
        if (tier) emit(f, b, tier, base);
      }
      continue;
    }

    if (f.category === "特殊环境增加费") {
      const hit = (settings.specialEnv ?? []).some((s) => f.name.includes(s));
      if (!hit) { skipped.push({ name: f.name, reason: "未启用（台账「特殊环境费」可开启）" }); continue; }
      for (const b of books) {
        const base = laborByBook[b];
        if (base?.gt(0) && f.tiers[0]) emit(f, b, f.tiers[0], base);
      }
      continue;
    }

    for (const b of books) {
      const base = laborByBook[b];
      if (!base?.gt(0)) continue; // 该册无子目即不产生该册措施费

      if (f.category === "超高增加费") {
        const h = settings.workHeight;
        if (!h) { skipped.push({ name: f.name, reason: "未设置「操作物高度」" }); break; }
        const tier = f.tiers.length === 1 && !tierRange(f.tiers[0].tier)
          ? f.tiers[0]
          : pickTier(f.tiers, h);
        if (!tier) { skipped.push({ name: `${f.name}(${b})`, reason: `操作物高度 ${h}m 未达起计档` }); continue; }
        // 「5m以上」单档：高度未达起计点则不计
        const r = tierRange(tier.tier);
        if (r && (r.loExclusive ? h <= r.lo : h < r.lo)) { skipped.push({ name: `${f.name}(${b})`, reason: `操作物高度 ${h}m 未达起计点` }); continue; }
        emit(f, b, tier, base);
      } else if (f.category === "高层建筑增加费") {
        const h = settings.eaveHeight;
        if (!h) { skipped.push({ name: f.name, reason: "未设置「檐口高度」" }); break; }
        const tier = pickTier(f.tiers, h);
        if (!tier) { skipped.push({ name: `${f.name}(${b})`, reason: `檐口高度 ${h}m 超出费率档或低于起计点` }); continue; }
        emit(f, b, tier, base);
      } else {
        // 脚手架搭拆费等平费率：有该册人工费即计
        if (f.tiers[0]) emit(f, b, f.tiers[0], base);
      }
    }
  }

  return { lines, total: sum(lines.map((l) => l.amount)).toFixed(2), skipped };
}
