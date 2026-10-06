"use client";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import type { UsageMatchRow, WorkspaceView } from "@shared/types";

import { Tip, TipEl } from "./shared";

/* ---------------- 历史工程定额套用经验 ---------------- */

const FLAG_STYLE: Record<string, BadgeVariant> = {
  common: "success",
  rare: "secondary",
  suspect: "warning",
};
const FLAG_LABEL: Record<string, string> = {
  common: "共识",
  rare: "低频",
  suspect: "存疑",
};
const FLAG_TIP: Record<string, string> = {
  common: "≥2 个独立项目都这么套",
  rare: "仅个别项目用过",
  suspect: "孤例且已有更常见套法——疑似错套，仅参考",
};

function FlagBadge({ flag }: { flag: string }) {
  return (
    <TipEl tip={FLAG_TIP[flag] ?? flag}>
      <Badge size="xs" variant={FLAG_STYLE[flag] ?? "secondary"}>{FLAG_LABEL[flag] ?? flag}</Badge>
    </TipEl>
  );
}

export function UsageMatch({ view }: { view: Extract<WorkspaceView, { kind: "quotaUsage" }> }) {
  return (
    <div className="view-content">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{view.rows.length} 个清单项 / 名称模式</Badge>
        <span className="text-2xs text-muted-foreground">
          历史工程实际套法（宏业工程文件语料）——编号为宏业库口径仅作参考，组价需按定额名检索库内对应子目
        </span>
      </div>
      <div className="xl-sheet overflow-auto rounded-lg">
      <table className="xl-table">
        <thead>
          <tr>
            <th className="xl-rn"></th>
            <th className="w-48">清单项</th>
            <th>历史套用（按项目数排序）</th>
            <th>常见组合套用</th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((r: UsageMatchRow, ri) => (
            <tr key={ri}>
              <td className="xl-rn">{ri + 1}</td>
              <td className="max-w-48">
                <Tip tip={r.itemName}>
                  <span className="block truncate">{r.itemName}</span>
                </Tip>
                <div className="flex gap-1">
                  {r.unit && <span className="text-2xs text-muted-foreground">{r.unit}</span>}
                  {r.fuzzy && (
                    <TipEl tip="名称未精确命中，来自相近名称模式桶">
                      <Badge size="xs" variant="secondary">近似</Badge>
                    </TipEl>
                  )}
                </div>
              </td>
              <td>
                <div className="space-y-1">
                  {r.quotas.map((q, qi) => (
                    <div key={qi} className="flex items-baseline gap-2">
                      <span className="mono shrink-0">{q.applied || q.code}</span>
                      <span className="truncate text-muted-foreground">
                        <Tip tip={q.name}>{q.name}</Tip>
                      </span>
                      {q.conv > 0 && (
                        <TipEl tip={`历史上有 ${q.conv} 次换算套用`}>
                          <Badge size="xs" variant="secondary">换</Badge>
                        </TipEl>
                      )}
                      <span className="mono shrink-0 text-2xs text-muted-foreground">×{q.uses} / {q.projects}项目</span>
                      <FlagBadge flag={q.flag} />
                      {q.specs.length > 0 && (
                        <span className="shrink-0 text-2xs text-muted-foreground/80">
                          {q.specs.slice(0, 3).join(",")}
                        </span>
                      )}
                    </div>
                  ))}
                  {!r.quotas.length && <span className="text-muted-foreground">—</span>}
                </div>
              </td>
              <td>
                <div className="space-y-1">
                  {r.combos.map((c, ci) => (
                    <div key={ci} className="flex items-baseline gap-2">
                      <span className="truncate text-muted-foreground">
                        <Tip tip={c.lines.map((l) => `${l.applied || l.code} ${l.name}`).join(" ＋ ")}>
                          {c.lines.map((l) => `${l.applied || l.code}${l.conv ? "换" : ""}`).join(" + ")}
                        </Tip>
                      </span>
                      <span className="mono shrink-0 text-2xs text-muted-foreground">×{c.uses} / {c.projects}项目</span>
                      <FlagBadge flag={c.flag} />
                    </div>
                  ))}
                  {!r.combos.length && <span className="text-muted-foreground">—</span>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {!view.rows.length && (
        <EmptyState
          title="没有历史套用记录"
          hint="经验库来自宏业工程文件语料；对未匹配项先跑定额匹配，或用 quota.usage 按名称检索。"
        />
      )}
    </div>
  );
}
