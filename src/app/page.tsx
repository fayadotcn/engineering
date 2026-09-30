import { listProjects } from "@project/service";
import { NewProject } from "@/ui/NewProject";
import { Database, ArrowUpRight, Layers3 } from "lucide-react";
import { ProjectDirectory } from "@/ui/ProjectDirectory";

export const dynamic = "force-dynamic";

export default async function Home() {
  const projects = await listProjects();
  return (
    <main className="cost-home">
      <div className="fadein">
        <div className="flex items-center justify-between">
          <p
            className="text-[12px] font-medium tracking-wide"
            style={{ color: "var(--brand-accent)" }}
          >
            <span className="flex items-center gap-2"><Layers3 size={18} />安装工程造价</span>
          </p>
          <a
            href="/admin"
            className="flex items-center gap-1.5 rounded-full border border-neutral-200 px-3 py-1.5 text-[12px] text-neutral-500 transition-colors hover:bg-[var(--hover)] hover:text-neutral-700"
          >
            <Database size={12} /> 材料与定额库 <ArrowUpRight size={12} />
          </a>
        </div>
        <h1 className="mt-9 text-[24px] font-semibold leading-tight tracking-tight">
          工程项目
        </h1>
        <p className="mt-3 max-w-xl text-[14px] leading-7 text-neutral-500">
          选择工程，在同一工作台中核对资料、沟通任务和查看计价结果。
        </p>
      </div>

      <div className="cost-home-stats"><div><strong>{projects.length}</strong><span>工程项目</span></div><div><strong>{projects.reduce((n, p) => n + p._count.files, 0)}</strong><span>项目资料</span></div><div><strong>{projects.reduce((n, p) => n + p._count.boqItems, 0)}</strong><span>清单数据行</span></div><p>清单 → 主材询价 → 定额组价 → 费用汇总 → 审核输出</p></div>
      <div className="mt-7">
        <NewProject />
      </div>
      <ProjectDirectory projects={projects.map(p => ({ id: p.id, name: p.name, files: p._count.files, rows: p._count.boqItems, updatedAt: p.updatedAt.toISOString() }))} />
      <footer className="cost-home-footer">项目资料与每次计价修改均保留在工程内</footer>
    </main>
  );
}
