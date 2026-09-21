"use client";
import { useEffect, useRef, useState } from "react";
import { useStore, type ConvBlock } from "./store";
import {
  AnomalyTable, BoqTable, Breakdown, DiffView, DocumentView, ExportResult,
  FactList, FileCompareView, FileList, OverviewView, QuotaResult, QuotationMatch,
  ReceiptsView,
} from "./views";
import type { WorkspaceView } from "@shared/types";
import { toast } from "./primitives";
import {
  ArrowLeft, ArrowUp, Check, ChevronDown, ChevronRight, CircleCheck, CircleX,
  Download, FileSpreadsheet, Loader2, Paperclip, Receipt, ShieldQuestion, Sparkles, Wrench, X,
} from "lucide-react";

const TOOL_LABEL: Record<string, string> = {
  "file.ingest": "解析文件",
  "boq.findSameItemDifferentPrice": "相同项不同价",
  "boq.findPriceAnomalies": "单价异常检查",
  "boq.findFeatureMismatch": "特征一致性检查",
  "boq.findDuplicateItems": "重复项检查",
  "boq.compare": "全面检查",
  "boq.update": "修改清单",
  "boq.read": "读取清单",
  "boq.search": "搜索清单",
  "material.compareQuotation": "匹配询价",
  "material.applyQuotation": "写回询价",
  "material.search": "搜索材料",
  "material.getPriceHistory": "价格历史",
  "material.matchLibrary": "材料库匹配",
  "material.fillFromLibrary": "材料库补价",
  "boq.compareFiles": "清单对审",
  "quota.match": "匹配定额",
  "quota.calculate": "定额组价",
  "project.setFact": "写入项目事实",
  "cost.calculate": "金额计算",
  "cost.aggregate": "金额汇总",
  "cost.professionalBreakdown": "专业占比",
  "cost.materialBreakdown": "材料占比",
  "quantity.adjust": "工程量反算",
  "excel.write": "写回源文件",
  "report.exportExcel": "导出 Excel",
  "project.read": "读取项目",
  "project.summary": "项目汇总",
};

function RevertButton({ receiptId }: { receiptId: string }) {
  const s = useStore();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  if (done) return <span className="text-[11px] text-neutral-300">已撤销</span>;
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const res = await fetch(`/api/receipts/${receiptId}/revert`, { method: "POST" });
        if (res.ok) {
          setDone(true);
          toast.success("已撤销该修改");
          await s.reloadBoq();
        } else {
          toast.error("撤销失败 — 该回执可能已被撤销或不可撤销");
        }
        setBusy(false);
      }}
      className="invisible rounded border border-neutral-200 px-1.5 py-0 text-[10.5px] text-neutral-500 hover:border-neutral-400 hover:text-neutral-800 group-hover:visible disabled:opacity-40"
    >
      撤销
    </button>
  );
}

function ConfirmCard({ b }: { b: Extract<ConvBlock, { type: "confirm" }> }) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const decide = async (approve: boolean) => {
    setBusy(approve ? "approve" : "reject");
    await fetch(`/api/runs/${b.runId}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approve }),
    });
    // decided 状态由 SSE 的 confirm_resolved 事件回写
    setBusy(null);
  };
  const pending = !b.decided;
  return (
    <div className="fadein rounded-xl border px-3 py-2.5" style={{ borderColor: "color-mix(in srgb, var(--warning-soft-fg) 32%, transparent)", background: "var(--warning-soft-bg)" }}>
      <div className="flex items-start gap-2">
        <ShieldQuestion size={14} className="mt-0.5 shrink-0" style={{ color: "var(--warning-soft-fg)" }} />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-neutral-800">需要确认</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-neutral-600">{b.description}</div>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2 pl-6">
        {pending ? (
          <>
            <button
              onClick={() => decide(true)}
              disabled={!!busy}
              className="rounded-md bg-neutral-900 px-3 py-1 text-[12px] text-white hover:bg-neutral-700 disabled:opacity-40"
            >
              {busy === "approve" ? "执行中…" : "确认执行"}
            </button>
            <button
              onClick={() => decide(false)}
              disabled={!!busy}
              className="rounded-md border border-neutral-300 px-3 py-1 text-[12px] text-neutral-600 hover:bg-[var(--surface)] disabled:opacity-40"
            >
              取消
            </button>
          </>
        ) : (
          <span className="text-[11.5px] text-neutral-400">
            {b.decided === "approved" ? "已确认执行" : "已取消"}
          </span>
        )}
      </div>
    </div>
  );
}

/* ---------------- Manus 式任务卡 ----------------
   同一 run 的 activity/thought/tool/confirm/receipt 聚合成一张卡：
   标题栏状态 + 竖向步骤时间线 + 工具步可展开看参数与结果。 */

function ToolStep({ b }: { b: Extract<ConvBlock, { type: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(b.args || b.resultMsg);
  return (
    <div>
      <button
        onClick={() => hasDetail && setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-[12px] transition-colors enabled:hover:bg-[var(--hover)]"
      >
        {b.status === "running" ? (
          <Loader2 size={12} className="spin shrink-0 text-neutral-400" />
        ) : b.status === "ERROR" ? (
          <CircleX size={12} className="shrink-0 text-red-500" />
        ) : (
          <Wrench size={11} className="shrink-0 text-neutral-400" />
        )}
        <span className={b.status === "ERROR" ? "text-red-600" : "text-neutral-700"}>
          {TOOL_LABEL[b.tool] ?? b.tool}
        </span>
        <span className="mono text-[10.5px] text-neutral-400">
          {b.status === "running" ? "…" : b.ms != null ? `${b.ms}ms` : ""}
        </span>
        {hasDetail && (
          <ChevronRight
            size={11}
            className={`ml-auto shrink-0 text-neutral-300 transition-transform ${open ? "rotate-90" : ""}`}
          />
        )}
      </button>
      {open && hasDetail && (
        <div className="mb-1 ml-5 space-y-1 rounded-md bg-[var(--sidebar)] px-2.5 py-2 text-[11px]">
          {b.args && (
            <div>
              <div className="text-[10px] text-neutral-400">参数</div>
              <div className="mono break-all text-neutral-600">{b.args}</div>
            </div>
          )}
          {b.resultMsg && (
            <div>
              <div className="text-[10px] text-neutral-400">结果</div>
              <div className="whitespace-pre-wrap text-neutral-600">{b.resultMsg}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TaskStep({ b }: { b: ConvBlock }) {
  if (b.type === "activity")
    return (
      <div className="flex items-center gap-2 px-1 py-1 text-[12px] text-neutral-500">
        {b.live ? (
          <Loader2 size={11} className="spin shrink-0 text-[var(--brand-accent)]" />
        ) : (
          <Check size={11} className="shrink-0 text-neutral-300" />
        )}
        {b.text}
      </div>
    );
  if (b.type === "thought")
    return (
      <div className="flex items-start gap-2 px-1 py-1 text-[12px] leading-relaxed text-neutral-500">
        <Sparkles size={11} className="mt-1 shrink-0 text-[var(--brand-accent)]" />
        <span className="whitespace-pre-wrap">{b.text}</span>
      </div>
    );
  if (b.type === "tool") return <ToolStep b={b} />;
  if (b.type === "confirm") return <div className="py-0.5"><ConfirmCard b={b} /></div>;
  if (b.type === "receipt")
    return (
      <div className="group flex items-center gap-2 px-1 py-1 text-[12px] text-neutral-500">
        <Receipt size={11} className="shrink-0 text-neutral-400" />
        <span className="truncate">{b.summary}</span>
        <RevertButton receiptId={b.receiptId} />
      </div>
    );
  if (b.type === "error")
    return (
      <div className="flex items-center gap-2 px-1 py-1 text-[12px] text-red-600">
        <X size={11} /> {b.text}
      </div>
    );
  return null;
}

function TaskCard({ steps, live }: { steps: ConvBlock[]; live: boolean }) {
  const [open, setOpen] = useState(true);
  const toolCount = steps.filter((s) => s.type === "tool").length;
  const failed =
    steps.some((s) => s.type === "error") ||
    steps.some((s) => s.type === "tool" && s.status === "ERROR");
  const liveActivity = [...steps]
    .reverse()
    .find((s): s is Extract<ConvBlock, { type: "activity" }> => s.type === "activity" && s.live);
  const doneSteps = steps.filter(
    (s) => (s.type === "tool" && s.status !== "running") || s.type === "receipt"
  ).length;

  return (
    <div className="fadein overflow-hidden rounded-xl border border-neutral-200 bg-[var(--surface)]">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--hover)]"
      >
        {live ? (
          <Loader2 size={13} className="spin shrink-0 text-[var(--brand-accent)]" />
        ) : failed ? (
          <CircleX size={13} className="shrink-0 text-red-500" />
        ) : (
          <CircleCheck size={13} className="shrink-0 text-[var(--success-soft-fg)]" />
        )}
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-neutral-800">
          {live ? liveActivity?.text ?? "任务进行中" : failed ? "执行异常" : "任务完成"}
        </span>
        <span className="shrink-0 text-[11px] text-neutral-400">
          {live ? `${doneSteps}/${toolCount || "…"} 步` : `${toolCount} 步`}
        </span>
        <ChevronDown
          size={13}
          className={`shrink-0 text-neutral-400 transition-transform ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {open && (
        <div className="relative space-y-0.5 border-t border-neutral-100 px-2 py-2">
          <div className="pointer-events-none absolute bottom-3 left-[15px] top-3 w-px bg-neutral-100" />
          {steps.map((b, i) => (
            <div key={i} className="relative">
              <TaskStep b={b} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 把同一 run 的过程块聚合为任务卡；user/upload/agent 消息保持独立 */
type RenderItem =
  | { kind: "single"; block: ConvBlock }
  | { kind: "task"; runId: string; steps: ConvBlock[] };

function groupBlocks(blocks: ConvBlock[]): RenderItem[] {
  const out: RenderItem[] = [];
  let task: { runId: string; steps: ConvBlock[] } | null = null;
  for (const b of blocks) {
    if (b.type === "user" || b.type === "upload" || b.type === "agent") {
      if (task) out.push({ kind: "task", runId: task.runId, steps: task.steps });
      task = null;
      out.push({ kind: "single", block: b });
      continue;
    }
    const rid = "runId" in b ? (b.runId ?? "") : "";
    if (!task || task.runId !== rid) {
      if (task) out.push({ kind: "task", runId: task.runId, steps: task.steps });
      task = { runId: rid, steps: [] };
    }
    task.steps.push(b);
  }
  if (task) out.push({ kind: "task", runId: task.runId, steps: task.steps });
  return out;
}

/* Agent 消息 markdown-lite：**粗体**、- 列表、`代码`、### 小节 */
function MdLite({ text }: { text: string }) {
  const lines = text.split("\n");
  const inline = (s: string, key: number) => {
    const parts = s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    return (
      <span key={key}>
        {parts.map((p, i) =>
          p.startsWith("**") && p.endsWith("**") ? (
            <b key={i} className="font-medium text-neutral-900">{p.slice(2, -2)}</b>
          ) : p.startsWith("`") && p.endsWith("`") ? (
            <code key={i} className="mono rounded bg-neutral-100 px-1 text-[11.5px]">{p.slice(1, -1)}</code>
          ) : (
            p
          )
        )}
      </span>
    );
  };
  return (
    <div className="text-[13px] leading-relaxed text-neutral-800">
      {lines.map((l, i) => {
        const t = l.trim();
        if (/^#{1,4}\s/.test(t))
          return <div key={i} className="mt-2 first:mt-0 text-[13px] font-medium text-neutral-900">{inline(t.replace(/^#{1,4}\s/, ""), i)}</div>;
        if (/^[-•]\s/.test(t) || /^\d+[.、)]\s/.test(t))
          return (
            <div key={i} className="flex gap-1.5 pl-1">
              <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-neutral-300" />
              <span>{inline(t.replace(/^[-•]\s|^\d+[.、)]\s/, ""), i)}</span>
            </div>
          );
        if (!t) return <div key={i} className="h-2" />;
        return <div key={i}>{inline(l, i)}</div>;
      })}
    </div>
  );
}

function Block({ b }: { b: ConvBlock }) {
  const [copied, setCopied] = useState(false);
  if (b.type === "user")
    return (
      <div className="fadein flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-neutral-900 px-3 py-2 text-[13px] leading-relaxed text-white">
          {b.text}
        </div>
      </div>
    );
  if (b.type === "upload")
    return (
      <div className="fadein flex justify-end">
        <div className="flex max-w-[85%] items-center gap-2 rounded-lg border border-neutral-200 bg-[var(--surface)] px-3 py-2 text-[13px]">
          {b.uploading ? (
            <Loader2 size={14} className="spin text-[var(--brand-accent)]" />
          ) : (
            <FileSpreadsheet size={14} className="text-neutral-400" />
          )}
          <span className="truncate">{b.filename}</span>
          {b.uploading && <span className="text-[11px] text-neutral-400">上传中</span>}
        </div>
      </div>
    );
  if (b.type === "agent")
    return (
      <div className="fadein group/msg relative px-1">
        <MdLite text={b.text} />
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(b.text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="absolute -right-1 -top-1 rounded px-1.5 py-0.5 text-[10.5px] text-neutral-300 opacity-0 transition-opacity hover:bg-[var(--hover)] hover:text-neutral-600 group-hover/msg:opacity-100"
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
    );
  return null;
}

function ViewRenderer({ view }: { view: WorkspaceView }) {
  switch (view.kind) {
    case "boqTable":
      return <BoqTable />;
    case "overview":
      return <OverviewView />;
    case "receipts":
      return <ReceiptsView />;
    case "anomalyTable":
      return <AnomalyTable view={view} />;
    case "quotationMatch":
      return <QuotationMatch view={view} />;
    case "breakdown":
      return <Breakdown view={view} />;
    case "quotaResult":
      return <QuotaResult view={view} />;
    case "fileCompare":
      return <FileCompareView view={view} />;
    case "document":
      return <DocumentView view={view} />;
    case "diff":
      return <DiffView view={view} />;
    case "factList":
      return <FactList />;
    case "exportResult":
      return <ExportResult view={view} />;
    case "fileList":
      return <FileList />;
  }
}

export function Workbench({ projectId }: { projectId: string }) {
  const s = useStore();
  const [input, setInput] = useState("");
  const [dragging, setDragging] = useState(false);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [panelW, setPanelW] = useState(400);
  useEffect(() => {
    const v = Number(localStorage.getItem("conv-panel-w"));
    if (v >= 320 && v <= 560) setPanelW(v);
  }, []);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const dragW = useRef<{ x: number; w: number } | null>(null);

  useEffect(() => {
    void s.init(projectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // 智能跟随：用户上翻阅读时不强制拉到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottom.current) el.scrollTo({ top: el.scrollHeight });
  }, [s.blocks]);

  // 左栏宽度拖拽（记录到 localStorage）
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragW.current) return;
      const w = Math.max(320, Math.min(560, dragW.current.w + e.clientX - dragW.current.x));
      setPanelW(w);
    };
    const up = () => {
      if (dragW.current) localStorage.setItem("conv-panel-w", String(panelW));
      dragW.current = null;
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [panelW]);

  const send = () => {
    const t = input.trim();
    if (!t) return;
    setInput("");
    void s.send(t);
  };

  const activeView = s.views.find((v) => v.id === s.activeViewId) ?? s.views[s.views.length - 1];
  const factChips = s.facts.filter((f) =>
    ["地区", "税率", "价格文件", "电缆品牌", "管理费率", "利润率"].includes(f.key)
  );

  return (
    <div className="flex h-screen">
      {/* left: Agent conversation */}
      <div
        className={`relative flex shrink-0 flex-col border-r border-neutral-200 bg-[var(--surface)] transition-colors ${dragging ? "drop-armed" : ""}`}
        style={{ width: panelW }}
        onDragOver={(e) => {
          e.preventDefault();
          if (e.dataTransfer.types.includes("Files")) setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const fs = [...(e.dataTransfer.files ?? [])];
          fs.forEach((f) => void s.upload(f));
        }}
      >
        {dragging && <div className="drop-overlay">松开上传文件（可多选）</div>}
        {/* 宽度拖拽手柄 */}
        <div
          className="absolute -right-[3px] top-0 z-20 h-full w-[6px] cursor-col-resize hover:bg-[var(--brand-soft)]"
          onMouseDown={(e) => {
            dragW.current = { x: e.clientX, w: panelW };
            document.body.style.cursor = "col-resize";
            e.preventDefault();
          }}
        />
        <div className="border-b border-neutral-100 px-4 py-3">
          <div className="flex items-center gap-2">
            <a
              href="/"
              className="icon-btn -ml-1.5 flex h-6 w-6"
              title="返回项目列表"
            >
              <ArrowLeft size={13} />
            </a>
            {s.ready ? (
              <div className="truncate text-[13px] font-medium">{s.projectName || "未命名项目"}</div>
            ) : (
              <div className="skeleton h-4 w-32" />
            )}
          </div>
          {factChips.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {factChips.map((f) => (
                <span
                  key={f.id}
                  className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10.5px] text-neutral-500"
                  title={f.source === "INFERRED" ? "推断值" : undefined}
                >
                  {f.key} {f.value}
                  {f.source === "INFERRED" && <span className="text-amber-600">*</span>}
                </span>
              ))}
            </div>
          )}
        </div>

        <div
          ref={scrollRef}
          className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
          onScroll={(e) => {
            const el = e.currentTarget;
            const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            nearBottom.current = near;
            setScrolledUp(!near);
          }}
        >
          {!s.blocks.length && (
            <div className="mt-16 space-y-4 px-2">
              <p className="text-[13px] leading-relaxed text-neutral-500">
                上传清单 / 询价 Excel，然后直接告诉我做什么。
                <span className="mt-1 block text-[11.5px] text-neutral-400">
                  文件也可以直接拖进来
                </span>
              </p>
              <div className="space-y-1.5">
                {[
                  "检查相同项不同单价，工程量为0的不用管",
                  "把询价文件里的材料价格更新到当前项目",
                  "按定额测算综合单价，对比偏差",
                  "分析电缆、桥架、管道、阀门各占多少",
                ].map((t) => (
                  <button
                    key={t}
                    onClick={() => void s.send(t)}
                    className="block w-full rounded-xl border border-neutral-200 px-3 py-2 text-left text-[12.5px] text-neutral-600 transition-colors hover:border-neutral-300 hover:bg-[var(--hover)]"
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}
          {(() => {
            const groups = groupBlocks(s.blocks);
            const lastTaskIdx = groups.reduce((n, g, i) => (g.kind === "task" ? i : n), -1);
            return groups.map((g, i) =>
              g.kind === "single" ? (
                <Block key={i} b={g.block} />
              ) : (
                <TaskCard key={i} steps={g.steps} live={s.running && i === lastTaskIdx} />
              )
            );
          })()}
          {s.running && !s.blocks.some((b) => b.type === "activity" && b.live) && (
            <div className="flex items-center gap-2 px-1 text-[12px] text-neutral-400">
              <Loader2 size={11} className="animate-spin" /> 思考中
            </div>
          )}
        </div>
        {scrolledUp && (
          <button
            onClick={() => {
              scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
              nearBottom.current = true;
              setScrolledUp(false);
            }}
            className="fadein absolute bottom-28 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-neutral-200 bg-[var(--surface)] px-3 py-1.5 text-[11.5px] text-neutral-500 shadow-[var(--shadow-md)] transition-colors hover:text-neutral-800"
          >
            ↓ 回到最新
          </button>
        )}

        <div className="p-3">
          <div className="composer-shell">
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".xlsx,.xls,.pdf,.csv"
              className="hidden"
              onChange={(e) => {
                [...(e.target.files ?? [])].forEach((f) => void s.upload(f));
                e.target.value = "";
              }}
            />
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={Math.min(5, Math.max(1, input.split("\n").length))}
              placeholder="发消息，或拖入 Excel / PDF…"
              className="composer-input max-h-32 min-h-[30px] w-full resize-none px-2 py-1 text-[13.5px] leading-6"
            />
            <div className="mt-0.5 flex items-center justify-between px-0.5">
              <button
                onClick={() => fileRef.current?.click()}
                className="icon-btn h-8 w-8"
                title="上传 Excel / PDF"
              >
                <Paperclip size={15} />
              </button>
              <button
                onClick={send}
                disabled={!input.trim() || s.running}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-all active:translate-y-px"
                style={{
                  background: !input.trim() || s.running ? "var(--hover)" : "var(--brand-accent)",
                  color: !input.trim() || s.running ? "var(--ink-4)" : "var(--brand-on-accent)",
                }}
                title="发送"
              >
                {s.running ? <Loader2 size={13} className="animate-spin" /> : <ArrowUp size={15} strokeWidth={2.2} />}
              </button>
            </div>
          </div>
          <p className="mt-1.5 text-center text-[10.5px] text-neutral-400">
            Enter 发送 · Shift+Enter 换行 · 所有修改均有回执可撤销
          </p>
        </div>
      </div>

      {/* right: dynamic workspace */}
      <div className="flex min-w-0 flex-1 flex-col bg-[var(--bg)]">
        {s.views.length > 0 && (
          <div className="flex items-center gap-px overflow-x-auto border-b border-neutral-200 bg-[var(--surface)] px-2">
            {s.views.map((v) => (
              <div
                key={v.id}
                className={
                  "group/tab flex items-center whitespace-nowrap border-b-2 " +
                  (v.id === activeView?.id
                    ? "border-[var(--brand-accent)]"
                    : "border-transparent hover:border-neutral-300")
                }
              >
                <button
                  onClick={() => s.setActiveView(v.id)}
                  className={
                    "px-3 py-2 pr-1.5 text-[12px] transition-colors " +
                    (v.id === activeView?.id
                      ? "font-medium text-neutral-900"
                      : "text-neutral-500 hover:text-neutral-800")
                  }
                >
                  {v.title}
                </button>
                {s.views.length > 1 && (
                  <button
                    onClick={() => s.closeView(v.id)}
                    className="mr-1.5 flex h-4 w-4 items-center justify-center rounded text-neutral-300 opacity-0 transition-opacity hover:bg-neutral-200 hover:text-neutral-600 group-hover/tab:opacity-100"
                    title="关闭"
                  >
                    <X size={10} />
                  </button>
                )}
              </div>
            ))}
            <div className="ml-auto flex items-center gap-1 pr-1.5">
              {s.items.length > 0 && (
                <button
                  onClick={() => void s.send("导出修改后的清单")}
                  disabled={s.running}
                  className="icon-btn flex h-6 items-center gap-1 rounded-md px-2 text-[11px] disabled:opacity-40"
                  title="导出清单 Excel"
                >
                  <Download size={12} /> 导出
                </button>
              )}
            </div>
          </div>
        )}
        <div className="min-h-0 flex-1">
          {activeView ? (
            <ViewRenderer key={activeView.id} view={activeView} />
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <FileSpreadsheet size={28} className="mx-auto text-neutral-300" />
                <p className="mt-3 text-xs text-neutral-400">
                  工作区 — Agent 的结果会动态展示在这里
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
