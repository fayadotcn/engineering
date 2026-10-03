"use client";
import type { Dispatch, SetStateAction } from "react";
import type { BoqItemDTO } from "@shared/types";
import { Modal } from "../../primitives";
import { fmtMoney } from "../shared";
import { ADJ_FIELD, type AdjForm } from "./constants";

/** 多选批量调价弹窗 */
export function BatchAdjustDialog({ adjRows, saving, adjForm, setAdjForm, onClose, onSubmit }: {
  adjRows: BoqItemDTO[] | null;
  saving: boolean;
  adjForm: AdjForm;
  setAdjForm: Dispatch<SetStateAction<AdjForm>>;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  return (
    <Modal open={!!adjRows} label="批量调整清单行" width={400} onClose={saving ? () => {} : onClose}>
      <div className="dlg-title">批量调整 {adjRows?.length ?? 0} 行清单</div>
      <p className="dlg-desc">对所选清单行统一调整，合价会跟着联动；一次调整记一条操作记录，可整体撤销。</p>
      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => { e.preventDefault(); void onSubmit(); }}
      >
        <div className="grid grid-cols-2 gap-3">
          <label className="cost-field">
            <span>调整字段</span>
            <select
              value={adjForm.field}
              onChange={(e) => setAdjForm(f => ({ ...f, field: e.target.value as typeof f.field }))}
              className="cost-input lg w-full"
            >
              <option value="unitPrice">综合单价</option>
              <option value="quantity">工程量</option>
              <option value="mainMaterialPrice">主材暂估价</option>
            </select>
          </label>
          <label className="cost-field">
            <span>方式</span>
            <select
              value={adjForm.mode}
              onChange={(e) => setAdjForm(f => ({ ...f, mode: e.target.value as typeof f.mode }))}
              className="cost-input lg w-full"
            >
              <option value="percent">按百分比增减</option>
              <option value="value">统一设为该值</option>
            </select>
          </label>
        </div>
        <label className="cost-field">
          <span>{adjForm.mode === "percent" ? "增减百分比（%）— 下浮填负数" : "目标值"}</span>
          <input
            autoFocus
            value={adjForm.value}
            onChange={(e) => setAdjForm(f => ({ ...f, value: e.target.value }))}
            placeholder={adjForm.mode === "percent" ? "如：-5（下浮 5%）" : "如：52.30"}
            inputMode="decimal"
            className="cost-input lg w-full"
          />
        </label>
        {adjForm.mode === "percent" && adjForm.value.trim() && Number.isFinite(Number(adjForm.value)) && (
          Number(adjForm.value) <= -100
            ? <p className="text-[11.5px] text-[var(--danger)]">下浮不能超过 100%（会得到负值）</p>
            : <p className="text-[11.5px] text-neutral-400">
                即 {ADJ_FIELD[adjForm.field]} ×{(1 + Number(adjForm.value) / 100).toFixed(4)}
                {adjRows?.length ? `，以首行「${adjRows[0].name}」为例：${fmtMoney(Number(adjRows[0][adjForm.field]))} → ${fmtMoney(Number(adjRows[0][adjForm.field]) * (1 + Number(adjForm.value) / 100))} 元` : ""}
              </p>
        )}
        <div className="dlg-actions">
          <button type="button" className="cost-btn" disabled={saving} onClick={() => onClose()}>取消</button>
          <button
            type="submit"
            disabled={saving || !adjForm.value.trim() || !Number.isFinite(Number(adjForm.value)) || (adjForm.mode === "percent" && Number(adjForm.value) <= -100)}
            className="cost-btn primary"
          >
            {saving ? "应用中…" : `应用到 ${adjRows?.length ?? 0} 行`}
          </button>
        </div>
      </form>
    </Modal>
  );
}
