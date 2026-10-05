"use client";
import type { Dispatch, SetStateAction } from "react";
import { Modal } from "../../primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FEE_TYPE_HINT } from "../../terms";
import { cn } from "../shared";
import type { AddForm } from "./constants";

/* 字段容器：<Label> 自带 flex 横排 + gap-2 + font-medium，这里抹平回 .cost-field 的
   竖向堆叠原视觉——行距仍由 .cost-field > span 的 margin-bottom 控制，故 gap-0。 */
const FIELD = "cost-field flex-col items-stretch gap-0 font-normal leading-normal";

/** 手工补录清单行弹窗 */
export function AddRowDialog({ addOpen, saving, addForm, setAddForm, addLumpSum, addQtyPreview, unitProjects, onClose, onSubmit }: {
  addOpen: boolean;
  saving: boolean;
  addForm: AddForm;
  setAddForm: Dispatch<SetStateAction<AddForm>>;
  addLumpSum: boolean;
  addQtyPreview: string | null;
  unitProjects: string[];
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  return (
    <Modal open={addOpen} label="补录清单行" width={430} onClose={saving ? () => {} : onClose}>
      <div className="dlg-title">补录清单行</div>
      <p className="dlg-desc">清单里漏掉的项目手工补上，计入清单总额；此操作会记入操作记录，可一键撤销。</p>
      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => { e.preventDefault(); void onSubmit(); }}
      >
        <Label className={FIELD}>
          <span>项目名称 <i className="not-italic" style={{ color: "var(--destructive)" }}>*</i></span>
          <Input
            autoFocus
            value={addForm.name}
            onChange={(e) => setAddForm(f => ({ ...f, name: e.target.value }))}
            placeholder="如：UPVC排水管 DN110"
            className="w-full"
          />
        </Label>
        <div className="grid grid-cols-2 gap-3">
          <Label className={FIELD}>
            <span>费用类别</span>
            <Select value={addForm.feeType} onValueChange={(v) => setAddForm(f => ({ ...f, feeType: v }))}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue>{FEE_TYPE_HINT[addForm.feeType as keyof typeof FEE_TYPE_HINT] ?? addForm.feeType}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {Object.entries(FEE_TYPE_HINT).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}
              </SelectContent>
            </Select>
          </Label>
          <Label className={FIELD}>
            <span>项目编码（选填）</span>
            <Input
              value={addForm.code}
              onChange={(e) => setAddForm(f => ({ ...f, code: e.target.value }))}
              placeholder="如：031001006"
              className="w-full"
            />
          </Label>
        </div>
        <Label className={FIELD}>
          <span>项目特征（选填）</span>
          <Input
            value={addForm.feature}
            onChange={(e) => setAddForm(f => ({ ...f, feature: e.target.value }))}
            placeholder="如：DN100 沟槽连接 室内消防——影响定额/询价匹配"
            className="w-full"
          />
        </Label>
        {unitProjects.length > 0 && (
          <Label className={FIELD}>
            <span>单位工程（选填）</span>
            <Input
              value={addForm.unitProject}
              onChange={(e) => setAddForm(f => ({ ...f, unitProject: e.target.value }))}
              placeholder="归属单位工程"
              list="boq-unitprojects"
              className="w-full"
            />
            <datalist id="boq-unitprojects">
              {unitProjects.map((u) => <option key={u} value={u} />)}
            </datalist>
          </Label>
        )}
        {addLumpSum ? (
          <Label className={FIELD}>
            <span>金额（元）</span>
            <Input
              value={addForm.totalPrice}
              onChange={(e) => setAddForm(f => ({ ...f, totalPrice: e.target.value }))}
              placeholder="如：5000"
              inputMode="decimal"
              className="w-full"
            />
          </Label>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            <Label className={FIELD}>
              <span>单位</span>
              <Input
                value={addForm.unit}
                onChange={(e) => setAddForm(f => ({ ...f, unit: e.target.value }))}
                placeholder="m / 个 / 套"
                className="w-full"
              />
            </Label>
            <Label className={FIELD}>
              <span>工程量</span>
              <Input
                value={addForm.quantity}
                onChange={(e) => setAddForm(f => ({ ...f, quantity: e.target.value }))}
                placeholder="可输 3×12+5"
                inputMode="decimal"
                className="w-full"
              />
              {addQtyPreview && <span className={cn("mt-0.5 block text-2xs", addQtyPreview === "计算式无效" ? "text-[var(--destructive)]" : "text-muted-foreground")}>{addQtyPreview}</span>}
            </Label>
            <Label className={FIELD}>
              <span>综合单价（元）</span>
              <Input
                value={addForm.unitPrice}
                onChange={(e) => setAddForm(f => ({ ...f, unitPrice: e.target.value }))}
                placeholder="选填"
                inputMode="decimal"
                className="w-full"
              />
            </Label>
          </div>
        )}
        <div className="dlg-actions">
          <Button type="button" variant="outline" onClick={() => onClose()} disabled={saving}>
            取消
          </Button>
          <Button type="submit" disabled={saving || !addForm.name.trim()}>
            {saving ? "保存中…" : "补录到清单"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
