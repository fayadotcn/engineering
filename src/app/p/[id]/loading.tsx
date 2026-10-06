import { Skeleton } from "@/components/ui/skeleton";

/**
 * 工程工作台骨架屏：与对话式主界面同构——顶栏 + 居中对话列。
 * 数据到位后视觉上只是"填内容"而不是"换布局"。
 */
export default function Loading() {
  return (
    <main className="wb">
      <header className="wb-top" aria-hidden="true">
        <Skeleton className="h-7 w-24 rounded-md" />
        <Skeleton className="h-8 w-44 rounded-full" />
        <div className="ml-3 hidden gap-2 min-[761px]:flex">
          <Skeleton className="h-8 w-16 rounded-full" />
          <Skeleton className="h-8 w-16 rounded-full" />
          <Skeleton className="h-8 w-16 rounded-full" />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Skeleton className="h-8 w-8 rounded-full" />
          <Skeleton className="h-8 w-24 rounded-full" />
        </div>
      </header>
      <section className="wb-conv-col" role="status" aria-live="polite">
        <span className="sr-only">正在读取工程资料</span>
        <div className="conv conv-empty" aria-hidden="true">
          <div className="conv-list-wrap">
            <div className="conv-list items-center">
              <Skeleton className="mt-2 h-4 w-28" />
              <Skeleton className="mt-4 h-10 w-80 max-w-full" />
              <Skeleton className="mt-3 h-4 w-64 max-w-full" />
            </div>
          </div>
          <Skeleton className="mb-5 h-16 w-full rounded-full" />
        </div>
      </section>
    </main>
  );
}
