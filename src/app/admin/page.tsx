import { listDatasets } from "@dataset/service";
import { DatasetManager } from "@/ui/admin/DatasetManager";
import { SiteHeader } from "@/ui/shell/SiteHeader";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const datasets = await listDatasets();
  return (
    <>
      <SiteHeader />
      <main id="main-content" className="cost-library">
        <header className="page-heading"><span className="page-eyebrow">共享专业数据</span><h1>材料与定额库</h1><p>整理一次，各工程共用。管理材料价格、消耗量定额与参考资料。</p></header>

        <DatasetManager initial={datasets} />
      </main>
    </>
  );
}
