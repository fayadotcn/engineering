"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Plus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
        {/* <Label> 自带 font-medium/leading-none：这里保持 .cost-new-project-form label 的原字重与行高 */}
        <Label htmlFor="project-name" className="font-normal leading-normal">工程名称</Label>
        <Input
          id="project-name"
          size="lg"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="工程名称，如：三亚航院一期安装工程"
          aria-label="工程名称"
          maxLength={120}
          required
          disabled={busy}
          autoFocus
        />
        <footer><Button variant="outline" asChild><a href="/">返回工程列表</a></Button>
        <Button
          type="submit"
          size="lg"
          disabled={!name.trim() || busy}
        >
          {busy ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}{busy ? "正在创建…" : "创建工程"}
        </Button>
        </footer>
    </form>
  );
}
