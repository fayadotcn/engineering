import { listDatasets } from "@dataset/service";
import { DatasetManager } from "@/ui/admin/DatasetManager";
import { ThemeToggle } from "@/ui/ThemeToggle";
import { ArrowLeft, Database } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const datasets = await listDatasets();
  return (
    <main className="cost-library mx-auto flex min-h-screen w-full max-w-4xl flex-col px-6 pb-16 pt-16">
      <div className="mb-6 flex items-center justify-between">
        <a
          href="/"
          className="cost-back flex w-fit items-center gap-1.5 text-[12.5px] text-neutral-500 transition-colors hover:text-neutral-800"
        >
          <ArrowLeft size={13} /> 返回项目
        </a>
        <ThemeToggle className="wb-theme" />
      </div>

      <div className="flex items-center gap-3">
        <span
          className="flex h-9 w-9 items-center justify-center rounded-lg"
          style={{ background: "var(--brand-soft)", color: "var(--brand-ink)" }}
        >
          <Database size={17} />
        </span>
        <div>
          <h1 className="text-[20px] font-medium tracking-tight">材料与定额库</h1>
          <p className="mt-0.5 text-[12.5px] text-neutral-500">
            管理各工程共用的材料价格、消耗量定额和参考资料。
          </p>
        </div>
      </div>

      <DatasetManager initial={datasets} />
    </main>
  );
}
