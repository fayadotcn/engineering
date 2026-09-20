"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function NewProject() {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    const p = await res.json();
    router.push(`/p/${p.id}`);
  };

  return (
    <div className="flex gap-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && create()}
        placeholder="新项目名称，如：三亚航院一期四标段安装工程"
        className="h-9 flex-1 rounded-md border border-neutral-200 bg-white px-3 text-[13px] outline-none placeholder:text-neutral-400 focus:border-neutral-400"
      />
      <button
        onClick={create}
        disabled={!name.trim() || busy}
        className="h-9 rounded-md bg-neutral-900 px-4 text-[13px] text-white hover:bg-neutral-700 disabled:opacity-40"
      >
        创建
      </button>
    </div>
  );
}
