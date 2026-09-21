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
    <div className="composer-shell !p-2">
      <div className="flex items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
          placeholder="新项目名称，如：三亚航院一期四标段安装工程"
          className="composer-input h-10 flex-1 px-3 text-[13.5px]"
        />
        <button
          onClick={create}
          disabled={!name.trim() || busy}
          className="h-10 shrink-0 rounded-full px-5 text-[13px] font-medium transition-all enabled:active:translate-y-px disabled:cursor-not-allowed"
          style={{
            background: !name.trim() || busy ? "var(--hover)" : "var(--brand-accent)",
            color: !name.trim() || busy ? "var(--ink-4)" : "var(--brand-on-accent)",
          }}
        >
          创建项目
        </button>
      </div>
    </div>
  );
}
