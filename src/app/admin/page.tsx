import { listDatasets } from "@dataset/service";
import { DatasetManager } from "@/ui/admin/DatasetManager";
import { ArrowLeft, Database } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const datasets = await listDatasets();
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col px-6 pb-16 pt-16">
      <a
        href="/"
        className="mb-6 flex w-fit items-center gap-1.5 text-[12.5px] text-neutral-500 transition-colors hover:text-neutral-800"
      >
        <ArrowLeft size={13} /> 返回项目
      </a>

      <div className="flex items-center gap-3">
        <span
          className="flex h-9 w-9 items-center justify-center rounded-lg"
          style={{ background: "var(--brand-soft)", color: "var(--brand-accent)" }}
        >
          <Database size={17} />
        </span>
        <div>
          <h1 className="text-[20px] font-medium tracking-tight">数据管理</h1>
          <p className="mt-0.5 text-[12.5px] text-neutral-500">
            上传全局共享数据 —— 所有项目的 Agent 都能使用这些库做测算与匹配
          </p>
        </div>
      </div>

      <DatasetManager initial={datasets} />
    </main>
  );
}
