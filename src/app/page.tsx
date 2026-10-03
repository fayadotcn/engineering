import { listProjects } from "@project/service";
import { Database, ArrowUpRight, Layers3, Plus } from "lucide-react";
import { ProjectDirectory } from "@/ui/ProjectDirectory";
import { ThemeToggle } from "@/ui/ThemeToggle";

export const dynamic = "force-dynamic";

export default async function Home() {
  const projects = await listProjects();
  return (
    <main className="cost-home">
      <div className="fadein">
        <div className="flex items-center justify-between">
          <p
            className="text-[12.5px] font-semibold tracking-wide"
            style={{ color: "var(--ink-1)" }}
          >
            <span className="flex items-center gap-2.5"><span className="brand-tile"><Layers3 size={15} /></span>安装工程造价</span>
          </p>
          <div className="flex items-center gap-1.5">
            <ThemeToggle className="wb-theme" />
            <a
              href="/admin"
              className="flex items-center gap-1.5 rounded-full border border-[var(--hairline)] px-3 py-1.5 text-[12px] text-neutral-500 transition-colors hover:border-[var(--hairline-strong)] hover:bg-[var(--hover)] hover:text-neutral-700"
            >
              <Database size={12} /> 材料与定额库 <ArrowUpRight size={12} />
            </a>
          </div>
        </div>
        <header className="cost-home-heading"><div><h1>工程项目</h1><p>打开工程，告诉助手你想完成什么。</p></div><a href="/new" className="cost-btn primary"><Plus size={14} />新建工程</a></header>
      </div>

      <ProjectDirectory projects={projects.map(p => ({ id: p.id, name: p.name, files: p._count.files, rows: p._count.boqItems, updatedAt: p.updatedAt.toISOString() }))} />
      <footer className="cost-home-footer">项目资料与每次计价修改均保留在工程内</footer>
    </main>
  );
}
