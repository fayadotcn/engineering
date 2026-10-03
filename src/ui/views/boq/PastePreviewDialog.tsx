"use client";
import { Modal } from "../../primitives";
import type { PastePlanRow } from "./constants";

/** Ctrl+V 粘回预览弹窗：确认后才写入 */
export function PastePreviewDialog({ pastePlan, saving, onClose, onSubmit }: {
  pastePlan: PastePlanRow[] | null;
  saving: boolean;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  return (
    <Modal open={!!pastePlan} label="粘贴更新清单行" width={440} onClose={saving ? () => {} : onClose}>
      <div className="dlg-title">粘贴更新 {pastePlan?.length ?? 0} 行清单</div>
      <p className="dlg-desc">按选中顺序把剪贴板里的工程量/综合单价写回对应行，名称与编码不受影响；一次粘贴记一条操作记录，可整体撤销。</p>
      <div className="mt-3 max-h-56 overflow-y-auto rounded-lg border border-neutral-200">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="bg-[var(--sidebar)] text-left text-neutral-500">
              <th className="px-2.5 py-1.5 font-medium">项目</th>
              <th className="px-2 py-1.5 font-medium text-right">工程量</th>
              <th className="px-2 py-1.5 font-medium text-right">综合单价</th>
              <th className="px-2.5 py-1.5 font-medium text-right">主材暂估价</th>
            </tr>
          </thead>
          <tbody>
            {pastePlan?.map(({ it, patch }) => (
              <tr key={it.id} className="border-t border-neutral-100">
                <td className="max-w-40 truncate px-2.5 py-1.5" title={it.name}>{it.name}</td>
                {(["quantity", "unitPrice", "mainMaterialPrice"] as const).map((f) => (
                  <td key={f} className="px-2 py-1.5 text-right">
                    {patch[f] !== undefined
                      ? <><span className="text-neutral-400 line-through">{it[f]}</span> <span className="font-medium text-[var(--brand-ink)]">{patch[f]}</span></>
                      : <span className="text-neutral-300">—</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="dlg-actions">
        <button type="button" className="cost-btn" disabled={saving} onClick={() => onClose()}>取消</button>
        <button type="button" disabled={saving} onClick={() => void onSubmit()} className="cost-btn primary">
          {saving ? "写入中…" : `确认写入 ${pastePlan?.length ?? 0} 行`}
        </button>
      </div>
    </Modal>
  );
}
