import { listProjects } from "@project/service";
import { NewProject } from "@/ui/NewProject";

export const dynamic = "force-dynamic";

export default async function Home() {
  const projects = await listProjects();
  return (
    <main className="mx-auto max-w-2xl px-6 pt-24">
      <h1 className="text-lg font-medium tracking-tight">造价 Agent</h1>
      <p className="mt-1 text-[13px] text-neutral-500">
        对话即造价 — 用自然语言完成清单检查、询价写回、金额分析与导出。
      </p>

      <div className="mt-10">
        <NewProject />
      </div>

      <div className="mt-10 space-y-px">
        {projects.map((p) => (
          <a
            key={p.id}
            href={`/p/${p.id}`}
            className="flex items-center justify-between rounded-md border border-transparent px-3 py-2.5 text-[13px] hover:border-neutral-200 hover:bg-white"
          >
            <span>{p.name}</span>
            <span className="text-xs text-neutral-400">
              {p._count.boqItems} 项 · {p._count.files} 文件
            </span>
          </a>
        ))}
        {!projects.length && (
          <p className="px-3 py-6 text-xs text-neutral-400">还没有项目，先创建一个。</p>
        )}
      </div>
    </main>
  );
}
