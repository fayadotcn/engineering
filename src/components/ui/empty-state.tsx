import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function EmptyState({ icon, title, hint, action, size = "default" }: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
  size?: "default" | "lg";
}) {
  return <div className={cn("flex min-w-0 flex-col items-center justify-center gap-3 px-5 py-8 text-center", size === "lg" ? "min-h-88" : "min-h-52")}>
    {icon && <span className="mb-2 flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">{icon}</span>}
    <h3 className={cn("font-medium text-foreground", size === "lg" ? "text-base" : "text-sm")}>{title}</h3>
    {hint && <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    {action && <div className="mt-2">{action}</div>}
  </div>;
}
