"use client";
import { DISCIPLINE_COLOR } from "./colors";

/* ---------------- 概况页仪表盘图形：纯 SVG，零依赖 ----------------
   r=15.9155 → 周长≈100，stroke-dasharray 直接写百分比。 */

const R = 15.9155;

/** 专业金额占比环形图。中心放总价，点扇区可下钻到该专业清单。 */
export function DisciplineDonut({
  slices,
  center,
  sub,
  onSelect,
}: {
  slices: { key: string; label: string; amount: string; share: number }[];
  /** 中心大字（如 941.9 万） */
  center: string;
  /** 中心小字说明 */
  sub?: string;
  onSelect?: (key: string) => void;
}) {
  let acc = 0;
  return (
    <div className="donut">
      <svg viewBox="0 0 42 42" role="img" aria-label="各专业费用占比">
        <circle cx="21" cy="21" r={R} fill="none" stroke="var(--chart-track)" strokeWidth="5" />
        {slices.map((s) => {
          const pct = Math.max(s.share * 100, 0);
          const offset = 25 - acc;
          acc += pct;
          return (
            <circle
              key={s.key}
              cx="21" cy="21" r={R} fill="none"
              stroke={DISCIPLINE_COLOR[s.key] ?? DISCIPLINE_COLOR.OTHER}
              strokeWidth="5"
              strokeDasharray={`${pct} ${100 - pct}`}
              strokeDashoffset={offset}
              className={onSelect ? "donut-seg" : undefined}
              onClick={onSelect ? () => onSelect(s.key) : undefined}
            >
              <title>{`${s.label} ${s.share > 0 && s.share < 0.005 ? "<1" : Math.round(s.share * 100)}%`}</title>
            </circle>
          );
        })}
      </svg>
      <div className="donut-center"><strong>{center}</strong>{sub && <small>{sub}</small>}</div>
    </div>
  );
}

/** 定价进度环：已报价项 / 可计价项。 */
export function ProgressRing({ pct, done }: { pct: number; done?: boolean }) {
  const p = Math.min(Math.max(pct, 0), 100);
  return (
    <div className="cost-progress-ring" role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} aria-label="定价进度">
      <svg viewBox="0 0 42 42">
        <circle cx="21" cy="21" r={R} fill="none" stroke="var(--chart-track)" strokeWidth="5" />
        <circle
          cx="21" cy="21" r={R} fill="none"
          stroke={done ? "var(--success-soft-fg)" : "var(--primary)"}
          strokeWidth="5" strokeLinecap="round"
          strokeDasharray={`${p} ${100 - p}`}
          strokeDashoffset="25"
        />
      </svg>
      <div className="ring-center"><strong>{p}<small>%</small></strong></div>
    </div>
  );
}
