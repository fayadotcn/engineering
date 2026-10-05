"use client";
import type { Dispatch, SetStateAction } from "react";
import type { BoqItemDTO } from "@shared/types";
import { Modal } from "../../primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtMoney } from "../shared";
import { ADJ_FIELD, type AdjForm } from "./constants";

/* 字段容器：<Label> 自带 flex 横排 + gap-2 + font-medium，这里抹平回 .cost-field 的
   竖向堆叠原视觉——行距仍由 .cost-field > span 的 margin-bottom 控制，故 gap-0。 */
const FIELD = "cost-field flex-col items-stretch gap-0 font-normal leading-normal";

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
          <Label className={FIELD}>
            <span>调整字段</span>
            <Select value={adjForm.field} onValueChange={(v) => setAdjForm(f => ({ ...f, field: v as typeof f.field }))}>
              <SelectTrigger size="sm" className="w-full"><SelectValue>{ADJ_FIELD[adjForm.field]}</SelectValue></SelectTrigger>
              <SelectContent>
                {Object.entries(ADJ_FIELD).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}
              </SelectContent>
            </Select>
          </Label>
          <Label className={FIELD}>
            <span>方式</span>
            <Select value={adjForm.mode} onValueChange={(v) => setAdjForm(f => ({ ...f, mode: v as typeof f.mode }))}>
              <SelectTrigger size="sm" className="w-full"><SelectValue>{adjForm.mode === "percent" ? "按百分比增减" : "统一设为该值"}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectItem value="percent">按百分比增减</SelectItem>
                <SelectItem value="value">统一设为该值</SelectItem>
              </SelectContent>
            </Select>
          </Label>
        </div>
        <Label className={FIELD}>
          <span>{adjForm.mode === "percent" ? "增减百分比（%）— 下浮填负数" : "目标值"}</span>
          <Input
            autoFocus
            value={adjForm.value}
            onChange={(e) => setAdjForm(f => ({ ...f, value: e.target.value }))}
            placeholder={adjForm.mode === "percent" ? "如：-5（下浮 5%）" : "如：52.30"}
            inputMode="decimal"
            className="w-full"
          />
        </Label>
        {adjForm.mode === "percent" && adjForm.value.trim() && Number.isFinite(Number(adjForm.value)) && (
          Number(adjForm.value) <= -100
            ? <p className="text-2xs text-[var(--destructive)]">下浮不能超过 100%（会得到负值）</p>
            : <p className="text-2xs text-muted-foreground">
                即 {ADJ_FIELD[adjForm.field]} ×{(1 + Number(adjForm.value) / 100).toFixed(4)}
                {adjRows?.length ? `，以首行「${adjRows[0].name}」为例：${fmtMoney(Number(adjRows[0][adjForm.field]))} → ${fmtMoney(Number(adjRows[0][adjForm.field]) * (1 + Number(adjForm.value) / 100))} 元` : ""}
              </p>
        )}
        <div className="dlg-actions">
          <Button type="button" variant="outline" disabled={saving} onClick={() => onClose()}>取消</Button>
          <Button
            type="submit"
            disabled={saving || !adjForm.value.trim() || !Number.isFinite(Number(adjForm.value)) || (adjForm.mode === "percent" && Number(adjForm.value) <= -100)}
          >
            {saving ? "应用中…" : `应用到 ${adjRows?.length ?? 0} 行`}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
