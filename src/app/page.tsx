import { listProjects } from "@project/service";
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
        <header className="cost-home-heading"><div><h1>工程项目</h1><p>打开工程，告诉助手你想完成什么。</p></div><a href="/new" className="cost-btn primary">＋ 新建工程</a></header>
      </div>

      <ProjectDirectory projects={projects.map(p => ({ id: p.id, name: p.name, files: p._count.files, rows: p._count.boqItems, updatedAt: p.updatedAt.toISOString() }))} />
      <footer className="cost-home-footer">项目资料与每次计价修改均保留在工程内</footer>
    </main>
  );
}
