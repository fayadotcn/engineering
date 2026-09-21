import { listProjects } from "@project/service";
import { NewProject } from "@/ui/NewProject";
import { Database, FileSpreadsheet } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function Home() {
  const projects = await listProjects();
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col px-6 pb-16 pt-28">
      <div className="fadein">
        <div className="flex items-center justify-between">
          <p
            className="text-[12px] font-medium tracking-wide"
            style={{ color: "var(--brand-accent)" }}
          >
            Agent Native 造价工作台
          </p>
          <a
            href="/admin"
            className="flex items-center gap-1.5 rounded-full border border-neutral-200 px-3 py-1.5 text-[12px] text-neutral-500 transition-colors hover:bg-[var(--hover)] hover:text-neutral-700"
          >
            <Database size={12} /> 数据管理
          </a>
        </div>
        <h1 className="mt-2 text-[30px] font-medium leading-tight tracking-tight">
          对话即造价
        </h1>
        <p className="mt-2 max-w-md text-[13.5px] leading-6 text-neutral-500">
          用自然语言完成清单检查、询价写回、定额测算与导出 ——
          每一次修改都有回执，可追溯、可撤销。
        </p>
      </div>

      <div className="mt-8">
        <NewProject />
      </div>

      <div className="mt-10 space-y-2">
        {projects.map((p) => (
          <a
            key={p.id}
            href={`/p/${p.id}`}
            className="group flex items-center gap-3 rounded-xl border border-neutral-200 bg-[var(--surface)] px-4 py-3 transition-all duration-150 hover:border-neutral-300 hover:shadow-[var(--shadow-md)]"
          >
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
              style={{ background: "var(--brand-soft)", color: "var(--brand-accent)" }}
            >
              <FileSpreadsheet size={15} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[13.5px]">{p.name}</span>
            <span className="shrink-0 text-[11.5px] text-neutral-400">
              {p._count.boqItems} 项 · {p._count.files} 文件
            </span>
          </a>
        ))}
        {!projects.length && (
          <div className="rounded-xl border border-dashed border-neutral-300 px-4 py-10 text-center text-[12.5px] text-neutral-400">
            还没有项目，先创建一个。
          </div>
        )}
      </div>
    </main>
  );
}
