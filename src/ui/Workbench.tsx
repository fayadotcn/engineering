"use client";
import { useEffect, useRef, useState } from "react";
import { useStore, type ConvBlock } from "./store";
import {
  AnomalyTable, BoqTable, Breakdown, DiffView, DocumentView, ExportResult,
  FactList, FileCompareView, FileList, QuotaResult, QuotationMatch,
} from "./views";
import type { WorkspaceView } from "@shared/types";
import {
  ArrowUp, Check, FileSpreadsheet, Loader2, Paperclip, Receipt, Wrench, X,
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
          await s.reloadBoq();
        }
        setBusy(false);
      }}
      className="invisible rounded border border-neutral-200 px-1.5 py-0 text-[10.5px] text-neutral-500 hover:border-neutral-400 hover:text-neutral-800 group-hover:visible disabled:opacity-40"
    >
      撤销
    </button>
  );
}

function Block({ b }: { b: ConvBlock }) {
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
        <div className="flex max-w-[85%] items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-[13px]">
          <FileSpreadsheet size={14} className="text-neutral-400" />
          {b.filename}
        </div>
      </div>
    );
  if (b.type === "agent")
    return (
      <div className="fadein whitespace-pre-wrap px-1 text-[13px] leading-relaxed text-neutral-800">
        {b.text}
      </div>
    );
  if (b.type === "activity")
    return (
      <div className="fadein flex items-center gap-2 px-1 text-[12px] text-neutral-500">
        {b.live ? (
          <Loader2 size={11} className="pulse text-neutral-400" />
        ) : (
          <Check size={11} className="text-neutral-300" />
        )}
        {b.text}
      </div>
    );
  if (b.type === "tool")
    return (
      <div className="fadein flex items-center gap-1.5 px-1">
        <span
          className={
            "flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] " +
            (b.status === "running"
              ? "border-neutral-200 text-neutral-500"
              : b.status === "OK"
                ? "border-neutral-200 bg-neutral-50 text-neutral-600"
                : "border-red-200 bg-red-50 text-red-600")
          }
        >
          <Wrench size={10} />
          {TOOL_LABEL[b.tool] ?? b.tool}
          {b.status === "running" ? "…" : b.ms != null ? ` ${b.ms}ms` : ""}
        </span>
      </div>
    );
  if (b.type === "receipt")
    return (
      <div className="fadein group flex items-center gap-2 px-1 text-[12px] text-neutral-500">
        <Receipt size={11} className="text-neutral-400" />
        <span className="truncate">{b.summary}</span>
        <RevertButton receiptId={b.receiptId} />
      </div>
    );
  return (
    <div className="fadein flex items-center gap-2 px-1 text-[12px] text-red-600">
      <X size={11} /> {b.text}
    </div>
  );
}

function ViewRenderer({ view }: { view: WorkspaceView }) {
  switch (view.kind) {
    case "boqTable":
      return <BoqTable />;
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
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void s.init(projectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [s.blocks.length]);

  const send = () => {
    const t = input.trim();
    if (!t) return;
    setInput("");
    void s.send(t);
  };

  const activeView = s.views.find((v) => v.id === s.activeViewId) ?? s.views[s.views.length - 1];
  const factChips = s.facts.filter((f) => ["地区", "税率", "价格文件", "电缆品牌"].includes(f.key));

  return (
    <div className="flex h-screen">
      {/* left: Agent conversation */}
      <div
        className="flex w-[400px] shrink-0 flex-col border-r border-neutral-200 bg-white"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files?.[0];
          if (f) void s.upload(f);
        }}
      >
        <div className="border-b border-neutral-100 px-4 py-3">
          <div className="text-[13px] font-medium">{s.projectName || "…"}</div>
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

        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {!s.blocks.length && (
            <div className="mt-16 space-y-4 px-2">
              <p className="text-[13px] text-neutral-500">
                上传清单 / 询价 Excel，然后直接告诉我做什么。
              </p>
              <div className="space-y-1.5">
                {[
                  "检查相同项不同单价，工程量为0的不用管",
                  "把询价文件里的材料价格更新到当前项目",
                  "分析电缆、桥架、管道、阀门各占多少",
                  "导出修改后的清单",
                ].map((t) => (
                  <button
                    key={t}
                    onClick={() => void s.send(t)}
                    className="block w-full rounded-md border border-neutral-150 border-neutral-200 px-3 py-2 text-left text-[12.5px] text-neutral-600 hover:border-neutral-300 hover:bg-neutral-50"
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}
          {s.blocks.map((b, i) => (
            <Block key={i} b={b} />
          ))}
          {s.running && !s.blocks.some((b) => b.type === "activity" && b.live) && (
            <div className="flex items-center gap-2 px-1 text-[12px] text-neutral-400">
              <Loader2 size={11} className="animate-spin" /> 思考中
            </div>
          )}
        </div>

        <div className="border-t border-neutral-100 p-3">
          <div className="flex items-end gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 focus-within:border-neutral-400">
            <button
              onClick={() => fileRef.current?.click()}
              className="pb-0.5 text-neutral-400 hover:text-neutral-600"
              title="上传文件"
            >
              <Paperclip size={15} />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.pdf,.csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void s.upload(f);
                e.target.value = "";
              }}
            />
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={Math.min(4, Math.max(1, input.split("\n").length))}
              placeholder="告诉我要做什么…"
              className="flex-1 resize-none bg-transparent text-[13px] outline-none placeholder:text-neutral-400"
            />
            <button
              onClick={send}
              disabled={!input.trim() || s.running}
              className="flex h-6 w-6 items-center justify-center rounded-md bg-neutral-900 text-white hover:bg-neutral-700 disabled:opacity-30"
            >
              {s.running ? <Loader2 size={12} className="animate-spin" /> : <ArrowUp size={13} />}
            </button>
          </div>
        </div>
      </div>

      {/* right: dynamic workspace */}
      <div className="flex min-w-0 flex-1 flex-col bg-[var(--bg)]">
        {s.views.length > 0 && (
          <div className="flex items-center gap-px overflow-x-auto border-b border-neutral-200 bg-white px-2">
            {s.views.map((v) => (
              <button
                key={v.id}
                onClick={() => s.setActiveView(v.id)}
                className={
                  "whitespace-nowrap border-b-2 px-3 py-2 text-[12px] " +
                  (v.id === activeView?.id
                    ? "border-neutral-900 font-medium text-neutral-900"
                    : "border-transparent text-neutral-500 hover:text-neutral-800")
                }
              >
                {v.title}
              </button>
            ))}
          </div>
        )}
        <div className="min-h-0 flex-1">
          {activeView ? (
            <ViewRenderer key={activeView.id + s.boqVersion} view={activeView} />
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
