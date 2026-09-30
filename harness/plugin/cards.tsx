import { useState } from "react";
import type { ProjectActivity } from "./activity";
import { gistOf, summaryLine } from "./activity";

/**
 * 对话里的操作卡：Agent 与导入产出的结果直接变成可点的界面，
 * 而不是让用户自己去右侧面板里找。
 */

const WarnIcon = () => <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 3 2 20h20L12 3z" /><path d="M12 9v5M12 17h.01" /></svg>;
const OkIcon = () => <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></svg>;
const SpinIcon = () => <svg className="installation-spin" width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9" /></svg>;
const DocIcon = () => <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M6 2h8l4 4v16H6z" /><path d="M14 2v4h4" /></svg>;
const NextIcon = () => <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>;

const SHEET_LABEL: Record<string, string> = { BOQ: "清单", QUOTATION: "询价", GENERIC: "其他" };

export type CardHandlers = {
  /** 打开资料列映射视图，让人核对低置信度的列 */
  onReviewMapping: () => void;
  /** 批准或取消暂停中的导入 */
  onConfirm: (approve: boolean) => Promise<void>;
  /** 打开工作区并定位到某个结果视图 */
  onFocusView: (viewId: string) => void;
  /** 把下一步交给 Agent（对话即造价） */
  onSend: (text: string) => void;
};

export function ActivityCards({ activity, importing, importingFile, progress, handlers }: {
  activity: ProjectActivity | null;
  importing: boolean;
  importingFile: string;
  progress: string;
  handlers: CardHandlers;
}) {
  const [busy, setBusy] = useState(false);
  if (importing) {
    return <section className="installation-card busy" role="status">
      <header><SpinIcon />{progress || "正在识别文件…"}</header>
      {importingFile && <p className="installation-card-note">「{importingFile}」</p>}
    </section>;
  }
  if (!activity) return null;

  const { confirm, import: imported, result } = activity;

  if (confirm) {
    const low = imported?.sheets.filter((s) => s.lowColumns > 0) ?? [];
    const approve = async () => { setBusy(true); try { await handlers.onConfirm(true); } finally { setBusy(false); } };
    return <section className="installation-card warn" role="status">
      <header><WarnIcon />导入需要你确认</header>
      <p className="installation-card-lead">{imported?.filename ? `「${imported.filename}」` : ""}有 {low.length || 1} 张表的列映射不够确定</p>
      <p className="installation-card-note clamp">{confirm.description}</p>
      <div className="installation-card-actions">
        <button className="primary" disabled={busy} onClick={() => void approve()}>直接采用</button>
        <button disabled={busy} onClick={handlers.onReviewMapping}>检查映射</button>
      </div>
    </section>;
  }

  const importedAt = imported?.status === "DONE" ? Date.parse(imported.at) : 0;
  const resultAt = result && result.views.length ? Date.parse(result.at) : 0;

  if (resultAt && resultAt >= importedAt && result) {
    const gist = gistOf(result.summary);
    return <section className="installation-card">
      <header><OkIcon />本次结果</header>
      {gist && <p className="installation-card-lead">{gist}</p>}
      <div className="installation-card-views">
        {result.views.map((view) => <button key={view.id} onClick={() => handlers.onFocusView(view.id)}>
          <span>{view.title}</span>
          {view.rows !== undefined && <em>{view.rows} 项</em>}
          <NextIcon />
        </button>)}
      </div>
    </section>;
  }

  if (importedAt && imported) {
    const sheets = imported.sheets.map((s) => `${s.sheetName}（${SHEET_LABEL[s.type] ?? s.type} ${s.rowCount} 行）`).join("、");
    const unpriced = imported.totals ? Math.max(0, imported.totals.pricable - imported.totals.priced) : 0;
    return <section className="installation-card">
      <header><DocIcon />已导入「{imported.filename}」</header>
      <p className="installation-card-lead">{summaryLine(imported.summary)}</p>
      {sheets && <p className="installation-card-note clamp">{sheets}</p>}
      {unpriced > 0 && <p className="installation-card-note">有 {unpriced} 项还没有综合单价</p>}
      <div className="installation-card-actions">
        <button onClick={() => handlers.onFocusView("view:boq")}>查看清单</button>
        {unpriced > 0 && <button className="primary" onClick={() => handlers.onSend("补齐缺价项")}>补齐缺价</button>}
      </div>
    </section>;
  }

  return null;
}
