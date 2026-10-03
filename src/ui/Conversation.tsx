"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  AlertTriangle, ArrowDown, ArrowUpRight, BarChart3, Check, CheckCircle2, FileSpreadsheet, Loader2, PanelLeftClose, Paperclip,
  PencilLine, Receipt, SendHorizonal, Sparkles, X, XCircle,
} from "lucide-react";
import { useStore } from "./store";
import { isBusy, isDirty } from "./busy";
import { toast } from "./primitives";
import type { ConvBlock } from "./runEvents";

/** 工具名 → 用户可读的一步动作（用户只看高层步骤，不看内部实现） */
const TOOL_LABEL: Record<string, string> = {
  "file.inspect": "识别表格结构",
  "file.ingest": "导入表格数据",
  "boq.read": "读取工程清单",
  "boq.update": "修改清单行",
  "boq.compare": "全面检查清单",
  "boq.search": "检索清单项",
  "boq.filter": "筛选清单行",
  "boq.findSameItemDifferentPrice": "查相同项不同单价",
  "boq.findPriceAnomalies": "查单价异常",
  "boq.findDuplicateItems": "查重复清单项",
  "boq.findArithmeticMismatches": "合价算术校验",
  "boq.findFeatureMismatch": "比对项目特征",
  "boq.compareFiles": "两版清单对审",
  "material.matchLibrary": "匹配材料库价格",
  "material.fillFromLibrary": "写回主材暂估价",
  "material.search": "查询材料价格",
  "material.getPriceHistory": "查询价格走势",
  "material.compareQuotation": "匹配询价材料",
  "material.applyQuotation": "询价写回清单",
  "cost.calculate": "汇总清单金额",
  "cost.aggregate": "汇总清单金额",
  "cost.feeSummary": "汇总项目费用",
  "cost.measureFees": "计取系数措施费",
  "cost.composition": "分析成本构成",
  "cost.materialBreakdown": "分析材料类别占比",
  "cost.professionalBreakdown": "分析各专业占比",
  "quota.match": "匹配定额子目",
  "quota.calculate": "定额测算组价",
  "quota.applyCalc": "写回综合单价",
  "quota.setItemQuota": "调整组价方案",
  "spec.search": "检索定额说明",
  "quantity.calculate": "计算工程量表达式",
  "quantity.adjust": "按目标总价调整",
  "excel.read": "读取表格文件",
  "excel.mapColumns": "核对列映射",
  "excel.write": "写回源 Excel",
  "report.exportExcel": "生成成果 Excel",
  "report.exportCompare": "导出对审报告",
  "quota.search": "检索定额子目",
  "file.read": "读取项目文件",
  "file.search": "检索项目文件",
  "project.read": "读取项目台账",
  "project.create": "创建项目",
  "project.setFact": "记录计价条件",
  "project.summary": "汇总项目概况",
};
const toolLabel = (t: string) => TOOL_LABEL[t] ?? t;

/** 快捷指令：autopilot 走服务端确定性管线（绕开 LLM，步骤固定可控） */
const QUICK: { label: string; auto?: boolean }[] = [
  { label: "一键智能报价", auto: true },
  { label: "汇总项目费用" },
  { label: "查缺价项并补价" },
  { label: "检查相同项不同单价" },
];

/** 行内标记（markdown v2）：`code`、[链接](http)、**加粗**、数量词（金额/项数/百分比）自动加粗。 */
const NUM_RE = /(\d[\d,]*(?:\.\d+)?\s*(?:元|项|条|个|处|%|步|份|册|行|倍))/g;
const NUM_FULL = /^\d[\d,]*(?:\.\d+)?\s*(?:元|项|条|个|处|%|步|份|册|行|倍)$/;
const LINK_RE = /(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
const LINK_FULL = /^\[([^\]]+)\]\((https?:[^)]+)\)$/;

function InlineMd({ text }: { text: string }) {
  return <>{text.split(/(`[^`\n]+`)/g).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      return <code key={i} className="conv-code">{part.slice(1, -1)}</code>;
    return <Fragment key={i}>{part.split(LINK_RE).map((seg, j) => {
      const link = seg.match(LINK_FULL);
      if (link) return <a key={j} className="conv-link" href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
      return <Fragment key={j}>{seg.split(/(\*\*[^*\n]+\*\*)/g).map((p2, k) =>
        p2.startsWith("**") && p2.endsWith("**") && p2.length > 4
          ? <strong key={k}>{p2.slice(2, -2)}</strong>
          : <Fragment key={k}>{p2.split(NUM_RE).map((n, m) =>
              NUM_FULL.test(n) ? <b key={m} className="conv-num">{n}</b> : n)}</Fragment>)}</Fragment>;
    })}</Fragment>;
  })}</>;
}

/* 按「；」把工具拼出来的流水句拆成独立子句（括号内的分号不拆），
   每个子句一行、配语义图标——回复立刻有了扫描节奏。 */
function splitClauses(line: string): string[] {
  const out: string[] = [];
  let depth = 0, buf = "";
  for (const ch of line) {
    if ("（(《「".includes(ch)) depth++;
    if ("）)》」".includes(ch)) depth = Math.max(0, depth - 1);
    if ((ch === "；" || ch === ";") && depth === 0) {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

type Tone = "ok" | "warn" | "next" | "dot";
const WARN_RE = /注意|未定价|未命中|未匹配|缺|需另行|失败|错误|警告|风险|取消|不可|异常/;
const NEXT_RE = /^(下一步|回复|到「|建议|可以|请|若|打开|接下来)/;
const OK_RE = /^(已|完成|一致|通过|成功|共|保存|导入|写入|生成)/;
const toneOf = (line: string): Tone =>
  WARN_RE.test(line) ? "warn" : NEXT_RE.test(line) ? "next" : OK_RE.test(line) ? "ok" : "dot";

const TONE_ICON = { ok: CheckCircle2, warn: AlertTriangle, next: ArrowUpRight } as const;

/** 一行事实：图标 + 文案。默认小圆点，不抢眼但有节律。 */
function FactRow({ line }: { line: string }) {
  const tone = toneOf(line);
  const Icon = tone !== "dot" ? TONE_ICON[tone] : null;
  return <div className={`conv-fact t-${tone}`}>{Icon && <Icon size={12} />}<span><InlineMd text={line} /></span></div>;
}

/* markdown v2 块级解析：```代码块 | GFM 表格 | > 引用 | --- 分隔线 | # 标题 |
   有序/无序列表 | 普通行（按「；」分句 → 带语义图标的事实行） */

const isTableRow = (t: string) => t.trimStart().startsWith("|") && t.includes("|", 1);
const splitTableRow = (t: string) => t.trim().replace(/^\|+|\|+$/g, "").split("|").map((c) => c.trim());
const isTableSep = (t: string) => {
  const cells = splitTableRow(t);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
};

/** 把回复文本解析成排版节点数组（不含容器）。 */
function parseNodes(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const lines = text.split("\n");
  let list: { t: string; k: number }[] | null = null;
  let listOl = false;
  const flush = () => {
    if (!list?.length) return;
    const El = listOl ? "ol" : "ul";
    out.push(<El key={`l${out.length}`} className="conv-md-list">{list.map((li) => <li key={li.k}><InlineMd text={li.t} /></li>)}</El>);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimEnd();
    if (/^\s*```/.test(t)) {
      flush();
      const buf: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i]);
      out.push(<pre key={i} className="conv-pre"><code>{buf.join("\n")}</code></pre>);
      continue;
    }
    if (isTableRow(t) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush();
      const head = splitTableRow(t);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i].trimEnd())) rows.push(splitTableRow(lines[i++].trimEnd()));
      i--;
      out.push(<div key={i} className="conv-table-wrap"><table className="conv-table">
        <thead><tr>{head.map((h, hi) => <th key={hi}><InlineMd text={h} /></th>)}</tr></thead>
        <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci}><InlineMd text={c} /></td>)}</tr>)}</tbody>
      </table></div>);
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(t)) { flush(); out.push(<hr key={i} className="conv-md-hr" />); continue; }
    if (/^\s*>\s?/.test(t)) {
      flush();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      i--;
      out.push(<div key={i} className="conv-md-quote">{buf.map((q, qi) => <div key={qi} className="conv-md-p">{q.trim() ? <InlineMd text={q} /> : null}</div>)}</div>);
      continue;
    }
    const head = t.match(/^#{1,4}\s+(.+)/);
    if (head) { flush(); out.push(<div key={i} className="conv-md-h"><InlineMd text={head[1]} /></div>); continue; }
    const bullet = t.match(/^\s*[-*•]\s+(.+)/);
    const ordered = !bullet && t.match(/^\s*\d+[.、)]\s+(.+)/);
    if (bullet || ordered) {
      const m = bullet ?? (ordered || null);
      if (!m) continue;
      const ol = Boolean(ordered);
      if (list && listOl !== ol) flush();
      (list ??= []).push({ t: m[1], k: i });
      listOl = ol;
      continue;
    }
    flush();
    const clauses = splitClauses(t);
    if (!clauses.length) { out.push(<div key={i} className="conv-md-p" />); continue; }
    clauses.forEach((c, ci) => out.push(<FactRow key={`${i}-${ci}`} line={c} />));
  }
  flush();
  return out;
}

/** 助手回复：短回复直接排；长回复只露前几行，其余收成一行「展开」——
   参考 Manus 的克制感：先给结论，细节一点再展开。 */
function AgentText({ text }: { text: string }) {
  const nodes = parseNodes(text);
  if (nodes.length <= 7) return <div className="conv-text">{nodes}</div>;
  return (
    <div className="conv-text">
      {nodes.slice(0, 4)}
      <details className="conv-more">
        <summary>展开其余 {nodes.length - 4} 行</summary>
        {nodes.slice(4)}
      </details>
    </div>
  );
}

type ProcessBlock = Extract<ConvBlock, { type: "activity" | "thought" | "tool" | "receipt" | "view" }>;
const isProcess = (b: ConvBlock): b is ProcessBlock => b.type === "activity" || b.type === "thought" || b.type === "tool" || b.type === "receipt" || b.type === "view";

function Step({ b }: { b: ProcessBlock }) {
  const s = useStore();
  switch (b.type) {
    case "activity":
      return <li className={b.live ? "live" : ""}>{b.live ? <Loader2 size={12} className="spin" /> : <CheckCircle2 size={12} />}<span>{b.text}</span></li>;
    case "thought":
      return <li className="thought"><span>{b.text}</span></li>;
    case "view": {
      const exists = s.views.some((v) => v.id === b.viewId);
      return <li className="view-step">
        <button disabled={!exists} title={exists ? "在工作区查看" : "该结果已关闭"} onClick={() => s.setActiveView(b.viewId)}>
          <BarChart3 size={12} /><span>{b.title}</span>{exists && <ArrowUpRight size={11} />}
        </button>
      </li>;
    }
    case "tool":
      return <li className={b.status === "ERROR" ? "err" : b.status === "running" ? "live" : ""}>
        {b.status === "running" ? <Loader2 size={12} className="spin" /> : b.status === "ERROR" ? <XCircle size={12} /> : <CheckCircle2 size={12} />}
        <span>{toolLabel(b.tool)}{b.status === "ERROR" && b.resultMsg ? `：${b.resultMsg}` : ""}</span>
        {b.ms !== undefined && b.ms >= 1000 && <em>{(b.ms / 1000).toFixed(1)}s</em>}
      </li>;
    case "receipt":
      return <li className="receipt"><Receipt size={12} /><span>{b.summary}</span></li>;
  }
}

/** 一次运行的过程收进一张卡片：进行中亮头显示实时步骤，结束后折叠成一行摘要。 */
function Process({ steps, live }: { steps: ProcessBlock[]; live: boolean }) {
  const visible = steps.filter((b) => !(b.type === "thought" && !b.text.trim()));
  if (!visible.length) return null;
  if (live) return (
    <div className="conv-run live">
      <div className="conv-run-head"><Loader2 size={12} className="spin" /><span>正在处理 · {visible.length} 步</span></div>
      <ol className="conv-steps">{visible.map((b, i) => <Step key={i} b={b} />)}</ol>
    </div>
  );
  const failed = visible.some((b) => b.type === "tool" && b.status === "ERROR");
  const changes = visible.filter((b) => b.type === "receipt").length;
  const views = visible.filter((b) => b.type === "view").length;
  return <details className="conv-run">
    <summary>{failed ? <XCircle size={12} className="err" /> : <CheckCircle2 size={12} />}处理过程 · {visible.length} 步{changes ? ` · ${changes} 处修改` : ""}{views ? ` · ${views} 个视图` : ""}</summary>
    <ol className="conv-steps">{visible.map((b, i) => <Step key={i} b={b} />)}</ol>
  </details>;
}

function Blocks() {
  const s = useStore();
  const blocked = isBusy(s) || isDirty(s);
  const liveRun = s.agentRunning || s.running ? [...s.blocks].reverse().find((b) => "runId" in b && b.runId)?.runId : undefined;

  /* 按"轮次"分组：用户消息/上传靠右自成一格；其间的助手侧内容（过程、回复、确认、成果、报错）
     收进同一列、共用一个头像——避免一段任务被拆成一屏互不相干的碎块。 */
  type Item =
    | { kind: "user" | "upload"; b: ConvBlock; i: number }
    | { kind: "turn"; blocks: { b: ConvBlock; i: number }[] };
  const items: Item[] = [];
  let cur: { b: ConvBlock; i: number }[] | null = null;
  s.blocks.forEach((b, i) => {
    if (b.type === "user" || b.type === "upload") {
      if (cur) { items.push({ kind: "turn", blocks: cur }); cur = null; }
      items.push({ kind: b.type, b, i });
      return;
    }
    (cur ??= []).push({ b, i });
  });
  if (cur) items.push({ kind: "turn", blocks: cur });

  const out: React.ReactNode[] = items.map((item, idx) => {
    if (item.kind === "user")
      return <div key={item.i} className="conv-user"><p>{item.b.type === "user" ? item.b.text : ""}</p></div>;
    if (item.kind === "upload" && item.b.type === "upload")
      return <div key={item.i} className="conv-upload"><FileSpreadsheet size={14} /><span title={item.b.filename}>{item.b.filename}</span>{item.b.uploading ? <Loader2 size={12} className="spin" /> : <Check size={12} />}</div>;
    if (item.kind !== "turn") return null;

    const lastTurn = idx === items.length - 1;
    const body: React.ReactNode[] = [];
    /* 同一 run 的过程块与产出的视图合并成一张过程卡（视图是卡内可点步骤，
       不再把流程切成"过程卡/视图卡"交替的一屏碎片）。 */
    const emittedRuns = new Set<string>();
    for (let k = 0; k < item.blocks.length; k++) {
      const { b, i } = item.blocks[k];
      if (isProcess(b)) {
        const rid = b.runId;
        if (emittedRuns.has(rid)) continue;
        emittedRuns.add(rid);
        const steps = item.blocks.filter((x) => isProcess(x.b) && x.b.runId === rid).map((x) => x.b as ProcessBlock);
        const tail = item.blocks[item.blocks.length - 1];
        const atEnd = lastTurn && isProcess(tail.b) && tail.b.runId === rid;
        const live = steps.some((x) => (x.type === "activity" || x.type === "thought") && x.live) || (rid === liveRun && atEnd);
        body.push(<Process key={i} steps={steps} live={live} />);
        continue;
      }
      switch (b.type) {
        case "agent":
          body.push(<AgentText key={i} text={b.text} />);
          break;
        case "confirm": {
          const mapping = b.fileId ? s.views.find((v) => v.kind === "columnMapping" && v.fileId === b.fileId) : undefined;
          body.push(<div key={i} className={`conv-confirm ${b.decided ?? ""}`} role="status">
            <strong>{b.decided === "approved" ? "已批准" : b.decided === "rejected" ? "已取消" : "需要你确认"}</strong>
            <p>{b.description}</p>
            {!b.decided && <div className="conv-confirm-actions">
              <button className="cost-btn" disabled={blocked} onClick={() => void s.confirmImport(b.runId, false)}><X size={12} />取消</button>
              {/* 导入必须先看到识别出的列映射再批准：对话里只给核对入口，批准在映射页上 */}
              {b.fileId
                ? <button className="cost-btn primary" onClick={() => s.setActiveView(mapping?.id ?? "view:files")}>核对表格<ArrowUpRight size={12} /></button>
                : <button className="cost-btn primary" disabled={blocked} onClick={() => void s.confirmImport(b.runId, true)}><Check size={12} />确认执行</button>}
            </div>}
          </div>);
          break;
        }
        case "error":
          body.push(<div key={i} className="conv-error" role="alert">{b.text}</div>);
          break;
      }
    }
    if (!body.length) return null;
    return <div key={`t${idx}`} className="conv-turn"><span className="conv-avatar" aria-hidden="true"><Sparkles size={11} /></span><div className="conv-turn-body">{body}</div></div>;
  });

  // 任务已发出但首个过程事件还没到达：给一个"正在看资料"的等待气泡，消除空白焦虑
  const last = s.blocks[s.blocks.length - 1];
  const awaiting = (s.agentRunning || s.running) && (!last || last.type === "user" || last.type === "upload");
  if (awaiting) out.push(<div key="__awaiting" className="conv-turn conv-waiting"><span className="conv-avatar" aria-hidden="true"><Sparkles size={11} /></span><div className="conv-text"><span className="conv-typing"><i /><i /><i /></span> 正在处理…</div></div>);
  return <>{out}</>;
}

export const FOCUS_COMPOSER = "cost:focus-composer";

export function Conversation({ onCollapse }: { onCollapse?: () => void }) {
  const s = useStore();
  const [text, setText] = useState("");
  const [jump, setJump] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const busy = isBusy(s) || !s.ready;
  const dirty = isDirty(s);

  // 新块到达时滚到底部（用户上翻查看历史时不抢，改出「有新内容」浮签）
  const nearBottom = useRef(true);
  useEffect(() => {
    if (nearBottom.current) {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
      setJump(false);
    } else {
      setJump(true);
    }
  }, [s.blocks]);

  useEffect(() => {
    const focus = () => { inputRef.current?.focus(); inputRef.current?.select(); };
    window.addEventListener(FOCUS_COMPOSER, focus);
    return () => window.removeEventListener(FOCUS_COMPOSER, focus);
  }, []);

  const send = (t: string, auto?: boolean) => {
    const msg = t.trim();
    if (!msg || busy) return;
    if (dirty) { toast.info("先保存或取消当前编辑，再发消息"); return; }
    setText("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    nearBottom.current = true;
    void s.send(msg, auto ? { autopilot: true } : undefined);
  };

  return (
    <div className="conv">
      <div className="conv-head">
        <span className="conv-title"><Sparkles size={14} />造价助手</span>
        <span className="conv-hint">{s.agentRunning ? "处理中…" : s.importRunning ? "导入中…" : ""}</span>
        {onCollapse && <button className="icon-btn" onClick={onCollapse} title="收起对话" aria-label="收起对话"><PanelLeftClose size={15} /></button>}
      </div>
      {s.modelDown && (
        <div className="conv-banner" role="status" title={s.modelDown}>
          <AlertTriangle size={12} />
          <span>模型暂不可用，当前为固定任务模式。检查 .env 模型配置或账户额度后自动恢复。</span>
        </div>
      )}
      <div className="conv-list-wrap">
      <div ref={listRef} className="conv-list" onScroll={(e) => {
        const el = e.currentTarget;
        nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        if (nearBottom.current) setJump(false);
      }}>
        {s.blocks.length === 0 && s.ready && (
          <div className="conv-welcome">
            <span className="conv-welcome-icon"><Sparkles size={18} /></span>
            <h3>造价助手</h3>
            <p>把清单、询价表拖进来，或直接说想做的事。修改数据前我会先请你确认，每一步都留痕、可撤销。</p>
            <div className="conv-quick">{QUICK.map((q) => <button key={q.label} className={q.auto ? "primary" : ""} disabled={busy || dirty} onClick={() => send(q.label, q.auto)}>{q.label}</button>)}</div>
          </div>
        )}
        <Blocks />
      </div>
      {jump && (
        <button className="conv-jump fadein" onClick={() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }); setJump(false); }}>
          <ArrowDown size={12} /> 有新内容
        </button>
      )}
      </div>
      <div className={`conv-compose${dirty ? " blocked" : ""}`}>
        <input ref={fileRef} type="file" accept=".xls,.xlsx,.csv,.pdf" multiple hidden
          onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ""; void (async () => { for (const f of fs) await useStore.getState().upload(f); })(); }} />
        <textarea
          ref={inputRef}
          value={text}
          rows={1}
          placeholder={dirty ? "先保存或取消当前编辑" : "说想做的事，如：把电缆按上上牌报价"}
          disabled={busy}
          aria-label="给造价助手发消息"
          onChange={(e) => {
            setText(e.target.value);
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); }
            if (e.key === "Escape") setText("");
          }}
        />
        <div className="conv-compose-bar">
          <button className="icon-btn" title="上传清单 / 询价表 / 资料" aria-label="上传文件" disabled={busy || dirty} onClick={() => fileRef.current?.click()}><Paperclip size={15} /></button>
          <span>{dirty ? <><PencilLine size={11} />有未保存的修改</> : busy && s.ready ? <><Loader2 size={11} className="spin" />{s.saving ? "正在保存" : "正在处理"}</> : "Enter 发送 · Shift+Enter 换行"}</span>
          <button className="conv-send" title="发送" aria-label="发送" disabled={busy || dirty || !text.trim()} onClick={() => send(text)}><SendHorizonal size={14} /></button>
        </div>
      </div>
    </div>
  );
}
