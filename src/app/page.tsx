import { listProjects } from "@project/service";
import { SiteHeader } from "@/ui/shell/SiteHeader";
import { ProjectDirectory } from "@/ui/ProjectDirectory";
import { QuickCreate } from "@/ui/QuickCreate";

export const dynamic = "force-dynamic";

export default async function Home() {
  const projects = await listProjects();
  return <>
    <SiteHeader />
    <main id="main-content" className="cost-home">
      <section className="cost-home-hero">
        <h1>让造价，回到简单。</h1>
        <p>上传清单，说出需求。从第一份资料到最终报价，井然有序。</p>
        <QuickCreate />
      </section>
      <ProjectDirectory projects={projects.map(p => ({ id: p.id, name: p.name, files: p._count.files, rows: p._count.boqItems, updatedAt: p.updatedAt.toISOString() }))} />
      <footer className="cost-home-footer">
        <p>工程数据保存在本机。为稳妥起见，请将安装包放在固态硬盘目录，避免机械盘访问超时。</p>
      </footer>
    </main>
  </>;
}
