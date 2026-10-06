import * as React from "react";

import { cn } from "@/lib/utils";

/* 控件高度三档，与 Button 尺寸刻度对齐：
   xs 28px（表格单元格内联编辑）· default 32px（常规表单/工具栏）· lg 36px（整页表单的主字段）。
   注意 data-slot 统一为 input，尺寸走 prop 而不是调用点用 className 覆盖。 */
const SIZE = {
  xs: "h-7 px-2 text-xs",
  default: "h-8 px-2.5",
  lg: "h-9 px-3",
} as const;

function Input({
  className,
  type,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"input">, "size"> & { size?: keyof typeof SIZE }) {
  return (
    <input
      type={type}
      data-slot="input"
      data-size={size}
      className={cn(
        "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input w-full min-w-0 rounded-md border bg-transparent text-sm transition-[color,border-color,box-shadow] duration-[var(--dur-base)] outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        SIZE[size],
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  );
}

export { Input };
