import { Skeleton } from "@/components/ui/skeleton";

/**
 * 工程工作台骨架屏。
 * 此前 /p/[id] 走的是根级 loading.tsx 的「居中转圈」，与真实双栏工作台结构完全不同，
 * 每次打开工程都会从居中加载态跳变成双栏（布局跳变）。这里用与真实布局同构的骨架，
 * 尺寸/圆角都取刻度值，数据到位后视觉上只是"填内容"而不是"换布局"。
 */
export default function Loading() {
  return (
    <main className="wb conv-open">
      <aside className="wb-conv" aria-hidden="true">
        <div className="flex h-full flex-col gap-3 p-4">
          <Skeleton className="h-8 w-36" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="mt-auto h-24 w-full rounded-xl" />
        </div>
      </aside>
      <div className="wb-main">
        <div className="wb-header">
          <div className="wb-top">
            <Skeleton className="h-6 w-52" />
            <div className="ml-auto flex items-center gap-2">
              <Skeleton className="h-8 w-8 rounded-md" />
              <Skeleton className="h-8 w-28 rounded-md" />
              <Skeleton className="h-8 w-24 rounded-md" />
            </div>
          </div>
          <div className="wb-nav">
            <Skeleton className="my-3 h-4 w-16" />
            <Skeleton className="my-3 ml-4 h-4 w-16" />
            <Skeleton className="my-3 ml-4 h-4 w-16" />
          </div>
        </div>
        <section className="wb-body" role="status" aria-live="polite">
          <span className="sr-only">正在读取工程资料</span>
          <Skeleton className="h-9 w-64" />
          <Skeleton className="mt-4 h-28 w-full rounded-xl" />
          <div className="mt-4 grid grid-cols-3 gap-3">
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
          </div>
        </section>
      </div>
    </main>
  );
}
