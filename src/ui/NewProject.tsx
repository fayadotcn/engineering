"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Plus, Loader2 } from "lucide-react";
import { toast } from "./primitives";

export function NewProject() {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const lock = useRef(false);

  const create = async () => {
    if (!name.trim() || lock.current) return;
    lock.current = true;
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
    } catch (error) { toast.error(error instanceof Error ? error.message : "项目创建失败"); lock.current = false; setBusy(false); }
  };

  return (
    <form className="cost-new-project-form" onSubmit={e => { e.preventDefault(); void create(); }}>
        <label htmlFor="project-name">工程名称</label>
        <input
          id="project-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="工程名称，如：三亚航院一期安装工程"
          aria-label="工程名称"
          maxLength={120}
          required
          disabled={busy}
          autoFocus
        />
        <footer><a className="cost-btn" href="/">返回工程列表</a>
        <button
          type="submit"
          disabled={!name.trim() || busy}
          className="cost-btn primary !h-10 !px-5"
        >
          {busy ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}{busy ? "正在创建…" : "创建工程"}
        </button>
        </footer>
    </form>
  );
}
