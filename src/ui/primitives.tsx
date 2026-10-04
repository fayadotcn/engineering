"use client";
import { AlertTriangle } from "lucide-react";
import { toast as sonnerToast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";

export { cn };

/* ---------------- Toast ----------------
   sonner 承载（shadcn 标准件）；此处保留 toast.info/success/error 旧 API 门面，
   调用点零改动。右下堆叠，自动消散。 */

interface ToastAction { label: string; onClick: () => void }

export const toast = {
  info: (t: string, action?: ToastAction) =>
    sonnerToast(t, { duration: action ? 10000 : 4200, action }),
  success: (t: string, action?: ToastAction) =>
    sonnerToast.success(t, { duration: action ? 10000 : 4200, action }),
  error: (t: string, action?: ToastAction) =>
    sonnerToast.error(t, { duration: action ? 10000 : 6000, action }),
};

export function Toaster() {
  return <SonnerToaster position="bottom-right" visibleToasts={5} gap={8} />;
}

/* ---------------- Modal / ConfirmDialog ----------------
   Radix Dialog 承载：遮罩 + Esc/点外关闭 + 焦点圈定。 */

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
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        aria-label={label}
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] gap-0 overflow-auto break-words p-6 sm:max-w-none"
        style={{ width, maxWidth: "calc(100vw - 2rem)" }}
      >
        <DialogTitle className="sr-only">{label ?? "对话框"}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
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
    <Modal open={open} label={title} onClose={busy ? () => {} : onCancel} width={380}>
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={
            danger
              ? { background: "var(--destructive-soft)", color: "var(--destructive-soft-fg)" }
              : { background: "var(--warning-soft)", color: "var(--warning-soft-fg)" }
          }
        >
          <AlertTriangle size={15} />
        </span>
        <div className="min-w-0 flex-1 break-words">
          <div className="dlg-title">{title}</div>
          {description && (
            <div className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{description}</div>
          )}
        </div>
      </div>
      <div className="dlg-actions">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
          取消
        </Button>
        <Button
          size="sm"
          variant={danger ? "destructive" : "default"}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? "处理中…" : confirmText}
        </Button>
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
        <span className="mb-1 flex h-11 w-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          {icon}
        </span>
      )}
      <div className="text-[12.5px] font-medium text-foreground">{title}</div>
      {hint && <div className="max-w-sm px-4 text-[11.5px] leading-relaxed text-muted-foreground">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
