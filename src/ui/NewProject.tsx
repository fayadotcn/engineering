"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Plus, Loader2 } from "lucide-react";
import { toast } from "./primitives";

export function NewProject() {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  useEffect(() => {
    const origin = new URLSearchParams(location.search).get("harnessOrigin");
    if (origin) sessionStorage.setItem("installation:harnessOrigin", origin);
  }, []);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    const p = await res.json();
    if (!res.ok || !p.id) throw new Error(p.error ?? "项目创建失败");
    router.push(`/p/${p.id}`);
    } catch (error) { toast.error(error instanceof Error ? error.message : "项目创建失败"); setBusy(false); }
  };

  return (
    <div className="cost-create-project">
      <div className="flex w-full min-w-0 items-center gap-2 rounded-md border border-neutral-200 bg-white">
        <Plus size={17} className="ml-3 shrink-0 text-neutral-400" />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && create()}
          placeholder="工程名称，如：三亚航院一期安装工程"
          aria-label="工程名称"
          maxLength={120}
          className="composer-input h-10 min-w-0 flex-1 px-2 text-[13.5px]"
        />
        <button
          onClick={create}
          disabled={!name.trim() || busy}
          className="cost-btn primary !h-10 !px-5"
        >
          {busy ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}创建工程
        </button>
      </div>
    </div>
  );
}
