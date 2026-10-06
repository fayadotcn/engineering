"use client";
import { EmptyState } from "@/components/ui/empty-state";
import { BarChart3, Download, RefreshCw, X } from "lucide-react";
import type { WorkspaceView } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { useStore } from "../store";
import { isBusy, isDirty } from "../busy";
import { resultKey, sectionOf } from "../sections";
import { ViewRenderer } from "./ViewRenderer";

const KIND_LABEL: Partial<Record<WorkspaceView["kind"], string>> = {
  quotaResult: "定额测算",
  quotationMatch: "材料匹配",
  specResult: "定额说明",
  anomalyTable: "清单检查",
  fileCompare: "两版对审",
  diff: "修改明细",
  feeSummary: "费用汇总",
  measureFee: "措施费",
  costComposition: "成本构成",
  breakdown: "占比分析",
  exportResult: "导出文件",
};

/**
 * 「重新生成」任务文案：成果都是快照，重新生成 = 按原口径再跑一遍。
 * 文案对着 planner 的触发词写，确定性视图 id 相同 → 新结果原位覆盖旧视图。
 */
function regenTask(v: WorkspaceView): string | null {
  switch (v.kind) {
    case "anomalyTable": return `重新检查${v.title}`;
    case "fileCompare": return `重新对审「${v.labelA}」与「${v.labelB}」`;
    case "quotaResult": return "重新测算定额组价";
    case "quotationMatch": return "重新检查缺价项";
    case "feeSummary": return "重新汇总项目费用";
    case "measureFee": return "重新计算措施费";
    case "costComposition": return "重新分析成本构成";
    case "breakdown": return v.mode === "discipline" ? "重新分析各专业金额占比" : "重新分析材料类别金额占比";
    default: return null;
  }
}

const QUICK_RESULTS = [
  { label: "费用汇总", task: "生成费用汇总表，说明计价条件缺项" },
  { label: "检查清单", task: "全面检查清单" },
  { label: "定额测算", task: "测算定额组价，先展示结果" },
  { label: "专业占比", task: "分析各专业金额占比" },
];

/** 成果分区：左侧每类成果只列最新一份，右侧显示内容。旧快照随新结果自动退场。 */
export function ResultsPanel({ projectId, onUpload }: { projectId: string; onUpload: () => void }) {
  const s = useStore();
  const blocked = isBusy(s) || isDirty(s) || !!s.loadingError;
  const all = s.views.filter((v) => sectionOf(v.kind) === "results");
  const latest = new Map<string, WorkspaceView>();
  for (const v of all) { latest.delete(resultKey(v)); latest.set(resultKey(v), v); }
  const list = [...latest.values()].reverse();
  const active = all.find((v) => v.id === s.activeViewId) ?? list[0];
  const newest = active && latest.get(resultKey(active));

  const remove = (v: WorkspaceView) => {
    const next = list.find((x) => resultKey(x) !== resultKey(v));
    for (const x of all) if (resultKey(x) === resultKey(v)) s.closeView(x.id, next?.id ?? "empty:results");
  };

  if (!list.length) return <div className="flex flex-1 items-center justify-center">
    <EmptyState
      icon={<BarChart3 size={22} />}
      title="还没有成果"
      hint={s.items.length ? "向助手提出测算、检查或汇总任务，结果会出现在这里。也可以直接生成：" : "先上传工程清单，再生成成果。"}
      action={s.items.length > 0
        ? <div className="cost-actions justify-center">{QUICK_RESULTS.map((q) => <Button key={q.label} variant="outline" size="sm" disabled={blocked} onClick={() => void s.send(q.task)}>{q.label}</Button>)}</div>
        : <Button onClick={onUpload}>上传清单</Button>}
    />
  </div>;

  const regen = active && regenTask(active);
  return <div className="results">
    <nav className="results-list" aria-label="成果列表">
      <div className="results-list-heading"><span>报价成果</span><small>{list.length}</small></div>
      {list.map((v) => {
        const current = active && resultKey(active) === resultKey(v);
        return <div key={v.id} className={current ? "active" : ""}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="default" className="min-w-0 flex-1 justify-start" onClick={() => s.setActiveView(v.id)} aria-current={current ? "page" : undefined}>
                <BarChart3 size={14} /><span>{v.title}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{v.title}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" className="results-close" aria-label={`移除${v.title}`} onClick={() => remove(v)}><X size={12} /></Button>
            </TooltipTrigger>
            <TooltipContent side="right">移除此成果</TooltipContent>
          </Tooltip>
        </div>;
      })}
    </nav>
    {active && <section className="results-detail">
      <header className="results-head">
        <div><small>{KIND_LABEL[active.kind] ?? "成果"}</small><h3>{active.title}</h3></div>
        <div className="cost-actions">
          {regen && <Tooltip>
            {/* 按钮禁用时自身收不到指针事件，触发层放在外层 span 上，提示才不至于消失 */}
            <TooltipTrigger asChild>
              <div className="inline-flex">
                <Button variant="outline" size="sm" disabled={blocked} onClick={() => void s.send(regen)}><RefreshCw size={13} />重新生成</Button>
              </div>
            </TooltipTrigger>
            <TooltipContent>成果是生成时的快照；清单或计价设置变化后可重新生成</TooltipContent>
          </Tooltip>}
          {active.kind === "fileCompare" && active.fileAId && active.fileBId
            ? <Button size="sm" asChild><a href={`/api/projects/${projectId}/export-compare?a=${active.fileAId}&b=${active.fileBId}`} download><Download size={13} />导出对审报告</a></Button>
            : s.items.length > 0 && <Button variant="outline" size="sm" asChild><a href={`/api/projects/${projectId}/export`} download><Download size={13} />导出清单 Excel</a></Button>}
        </div>
      </header>
      {newest && newest.id !== active.id && <p className="cost-info">这是较早生成的快照，已有更新的结果。<button className="cost-link" onClick={() => s.setActiveView(newest.id)}>查看最新</button></p>}
      <ViewRenderer view={active} onUpload={onUpload} />
    </section>}
  </div>;
}
