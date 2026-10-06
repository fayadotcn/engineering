"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";

export function NewProject() {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  const lock = useRef(false);

  const create = async () => {
    if (!name.trim() || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    const p = await res.json();
    if (!res.ok || !p.id) throw new Error(p.error ?? "项目创建失败");
    router.push(`/p/${p.id}`);
    } catch (error) { setError(error instanceof Error ? error.message : "项目创建失败"); lock.current = false; setBusy(false); }
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
          placeholder="例如：三亚航院一期安装工程"
          aria-describedby="project-name-hint"
          aria-label="工程名称"
          maxLength={120}
          required
          disabled={busy}
          autoFocus
        />
        <p id="project-name-hint" className="form-hint">使用容易辨认的名称，之后也可以修改。</p>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <footer>
        <Button
          type="submit"
          size="default"
          disabled={!name.trim() || busy}
        >
          {busy ? <Loader2 size={14} className="spin" /> : null}{busy ? "正在创建…" : "创建并进入工程"}{!busy && <ArrowRight size={14} />}
        </Button>
        </footer>
    </form>
  );
}
