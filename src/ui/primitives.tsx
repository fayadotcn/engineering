"use client";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { AlertTriangle, CircleCheck, CircleX, Info, X } from "lucide-react";

const cn = (...xs: (string | false | undefined)[]) => xs.filter(Boolean).join(" ");

/* ---------------- Toast ----------------
   全局轻提示：操作反馈、错误浮层。右下堆叠，4s 自动消散。 */

type ToastKind = "info" | "success" | "error";
interface ToastItem { id: number; kind: ToastKind; text: string; action?: { label: string; onClick: () => void } }

interface ToastState {
  toasts: ToastItem[];
  push(kind: ToastKind, text: string, action?: ToastItem["action"]): void;
  dismiss(id: number): void;
}

let seq = 0;
export const useToast = create<ToastState>((set) => ({
  toasts: [],
  push(kind, text, action) {
    const id = ++seq;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, text, action }] }));
    // 可操作的提示多留几秒：撤销入口要留够用户反应时间
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), action ? 10000 : 4200);
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

export const toast = {
  info: (t: string, action?: ToastItem["action"]) => useToast.getState().push("info", t, action),
  success: (t: string, action?: ToastItem["action"]) => useToast.getState().push("success", t, action),
  error: (t: string, action?: ToastItem["action"]) => useToast.getState().push("error", t, action),
};

const TOAST_STYLE: Record<ToastKind, { icon: React.ReactNode; cls: string }> = {
  info: { icon: <Info size={14} />, cls: "text-neutral-600" },
  success: { icon: <CircleCheck size={14} style={{ color: "var(--success-soft-fg)" }} />, cls: "" },
  error: { icon: <CircleX size={14} className="text-red-600" />, cls: "" },
};

export function Toaster() {
  const { toasts, dismiss } = useToast();
  if (!toasts.length) return null;
  return (
    <div className="cost-toaster pointer-events-none fixed bottom-5 right-5 z-[80] flex w-72 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          className="toast-in pointer-events-auto flex items-start gap-2.5 rounded-[14px] border border-neutral-200 bg-[var(--surface)] px-3.5 py-3 shadow-[var(--shadow-lg)]"
        >
          <span className="mt-px shrink-0">{TOAST_STYLE[t.kind].icon}</span>
          <span className="min-w-0 flex-1 break-words text-[12.5px] leading-relaxed text-neutral-700">{t.text}</span>
          {t.action && (
            <button
              onClick={() => { t.action!.onClick(); dismiss(t.id); }}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-[var(--brand-ink)] hover:bg-[var(--hover)]"
            >
              {t.action.label}
            </button>
          )}
          <button
            onClick={() => dismiss(t.id)}
            aria-label="关闭提示"
            className="shrink-0 rounded p-0.5 text-neutral-300 hover:text-neutral-600"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

/* ---------------- Modal / ConfirmDialog ----------------
   替代原生 confirm()：遮罩 + 卡片 + Esc/点外关闭。 */

export function Modal({
  open,
  onClose,
  children,
  width = 380,
  label,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  label?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (open && dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, [open]);
  if (!open) return null;
  return (
    <dialog ref={ref} aria-label={label} className="cost-modal" style={{ width }} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === e.currentTarget) { const rect = e.currentTarget.getBoundingClientRect(); if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) onClose(); } }}>{children}</dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmText = "确认",
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmText?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal open={open} label={title} onClose={busy ? () => {} : onCancel}>
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={
            danger
              ? { background: "var(--danger-soft-bg)", color: "var(--danger-soft-fg)" }
              : { background: "var(--warning-soft-bg)", color: "var(--warning-soft-fg)" }
          }
        >
          <AlertTriangle size={15} />
        </span>
        <div className="min-w-0 flex-1 break-words">
          <div className="dlg-title">{title}</div>
          {description && (
            <div className="mt-1 text-[12.5px] leading-relaxed text-neutral-500">{description}</div>
          )}
        </div>
      </div>
      <div className="dlg-actions">
        <button onClick={onCancel} disabled={busy} className="cost-btn">
          取消
        </button>
        <button
          onClick={onConfirm}
          disabled={busy}
          className={cn("cost-btn primary", danger && "danger")}
        >
          {busy ? "处理中…" : confirmText}
        </button>
      </div>
    </Modal>
  );
}

/* ---------------- EmptyState ---------------- */

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-40 flex-col items-center justify-center gap-2.5 text-center">
      {icon && (
        <span className="mb-1 flex h-11 w-11 items-center justify-center rounded-[14px] text-neutral-400" style={{ background: "var(--sidebar)", boxShadow: "inset 0 0 0 1px var(--hairline)" }}>
          {icon}
        </span>
      )}
      <div className="text-[12.5px] font-medium text-neutral-500">{title}</div>
      {hint && <div className="max-w-sm px-4 text-[11.5px] leading-relaxed text-neutral-400">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export { cn };
