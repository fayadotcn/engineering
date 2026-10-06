"use client";
import { AlertTriangle } from "lucide-react";
import { toast as sonnerToast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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

/**
 * 确认门（破坏性/写操作前的二次确认）。
 * 用 AlertDialog 而不是 Dialog：语义上是「需要用户明确应答」的中断式确认，
 * Radix 会给 role="alertdialog"、打开时把焦点落在取消动作上、并禁用外部点击关闭
 * —— 这些是 Dialog 不提供的。对外 props 与视觉保持原样。
 */
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
    <AlertDialog open={open} onOpenChange={(o) => { if (!o && !busy) onCancel(); }}>
      <AlertDialogContent className="gap-0 p-6 sm:max-w-[380px]">
        <AlertDialogHeader className="gap-0 text-left">
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
              <AlertDialogTitle className="text-sm font-semibold">{title}</AlertDialogTitle>
              {description && (
                <AlertDialogDescription className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {description}
                </AlertDialogDescription>
              )}
            </div>
          </div>
        </AlertDialogHeader>
        <div className="dlg-actions">
          <AlertDialogCancel asChild>
            <Button variant="outline" size="sm" disabled={busy}>取消</Button>
          </AlertDialogCancel>
          <Button
            size="sm"
            variant={danger ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "处理中…" : confirmText}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
