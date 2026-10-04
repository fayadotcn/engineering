import { listProjects } from "@project/service";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProjectDirectory } from "@/ui/ProjectDirectory";
import { SiteHeader } from "@/ui/shell/SiteHeader";

export const dynamic = "force-dynamic";

export default async function Home() {
  const projects = await listProjects();
  return (
    <>
      <SiteHeader />
      <main className="cost-home">
        <div className="fadein">
          <header className="cost-home-heading"><div><h1>工程项目</h1><p>打开工程，告诉助手你想完成什么。</p></div><Button asChild><a href="/new"><Plus size={14} />新建工程</a></Button></header>
        </div>

        <ProjectDirectory projects={projects.map(p => ({ id: p.id, name: p.name, files: p._count.files, rows: p._count.boqItems, updatedAt: p.updatedAt.toISOString() }))} />
        <footer className="cost-home-footer">项目资料与每次计价修改均保留在工程内</footer>
      </main>
    </>
  );
}
