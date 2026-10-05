import { cn } from "@/lib/utils";

/**
 * 骨架屏。
 * 皮肤取自 styles/base.css 的 .skl（shimmer 渐变扫光），语义上比 shadcn 默认的
 * animate-pulse 更贴合「数据正在到达」。该类只由本组件消费，业务代码请用 <Skeleton>。
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("skl", className)}
      {...props}
    />
  );
}

export { Skeleton };
