"use client";
import type { Dispatch, SetStateAction } from "react";
import { Modal } from "../../primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "../shared";
import type { AddForm } from "./constants";

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
        <label className="cost-field">
          <span>项目名称 <i className="not-italic" style={{ color: "var(--destructive)" }}>*</i></span>
          <Input
            autoFocus
            value={addForm.name}
            onChange={(e) => setAddForm(f => ({ ...f, name: e.target.value }))}
            placeholder="如：UPVC排水管 DN110"
            className="w-full"
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="cost-field">
            <span>费用类别</span>
            <select
              value={addForm.feeType}
              onChange={(e) => setAddForm(f => ({ ...f, feeType: e.target.value }))}
              className="cost-input lg w-full"
            >
              <option value="分部分项">分部分项（量×价）</option>
              <option value="单价措施">单价措施（量×价）</option>
              <option value="总价措施">总价措施（只填金额）</option>
              <option value="其他项目">其他项目（只填金额）</option>
            </select>
          </label>
          <label className="cost-field">
            <span>项目编码（选填）</span>
            <Input
              value={addForm.code}
              onChange={(e) => setAddForm(f => ({ ...f, code: e.target.value }))}
              placeholder="如：031001006"
              className="w-full"
            />
          </label>
        </div>
        <label className="cost-field">
          <span>项目特征（选填）</span>
          <Input
            value={addForm.feature}
            onChange={(e) => setAddForm(f => ({ ...f, feature: e.target.value }))}
            placeholder="如：DN100 沟槽连接 室内消防——影响定额/询价匹配"
            className="w-full"
          />
        </label>
        {unitProjects.length > 0 && (
          <label className="cost-field">
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
          </label>
        )}
        {addLumpSum ? (
          <label className="cost-field">
            <span>金额（元）</span>
            <Input
              value={addForm.totalPrice}
              onChange={(e) => setAddForm(f => ({ ...f, totalPrice: e.target.value }))}
              placeholder="如：5000"
              inputMode="decimal"
              className="w-full"
            />
          </label>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            <label className="cost-field">
              <span>单位</span>
              <Input
                value={addForm.unit}
                onChange={(e) => setAddForm(f => ({ ...f, unit: e.target.value }))}
                placeholder="m / 个 / 套"
                className="w-full"
              />
            </label>
            <label className="cost-field">
              <span>工程量</span>
              <Input
                value={addForm.quantity}
                onChange={(e) => setAddForm(f => ({ ...f, quantity: e.target.value }))}
                placeholder="可输 3×12+5"
                inputMode="decimal"
                className="w-full"
              />
              {addQtyPreview && <span className={cn("mt-0.5 block text-[11px]", addQtyPreview === "计算式无效" ? "text-[var(--destructive)]" : "text-muted-foreground")}>{addQtyPreview}</span>}
            </label>
            <label className="cost-field">
              <span>综合单价（元）</span>
              <Input
                value={addForm.unitPrice}
                onChange={(e) => setAddForm(f => ({ ...f, unitPrice: e.target.value }))}
                placeholder="选填"
                inputMode="decimal"
                className="w-full"
              />
            </label>
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
