"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ArrowRight, FileSpreadsheet, FileText, Loader2, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AUTO_PROJECT_NAME } from "@shared/types";
import { armPendingStart } from "./store";

/** 首页 hero 主输入：描述造价任务或先丢清单文件，回车即建工程并直达对话。
 *  工程名是哨兵占位名，首个 run 结束后由 runtime 按内容自动命名；
 *  消息与文件经 armPendingStart 交接给 Workbench（File 过不了 URL）。 */
export function QuickCreate() {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const lock = useRef(false);

  /* 拖文件直达输入区：与回形针同一入口（.xls/.xlsx/.csv/.pdf，与后端口径一致） */
  const ACCEPT = /\.(xlsx?|csv|pdf)$/i;
  const addFiles = (list: FileList | File[] | null) => {
    const ok = [...(list ?? [])].filter((f) => ACCEPT.test(f.name));
    if (ok.length) setFiles((cur) => [...cur, ...ok]);
    if (list && [...list].length !== ok.length) setError("目前支持 Excel / CSV / PDF 文件");
    else setError("");
  };

  const go = async () => {
    const message = text.trim();
    if ((!message && !files.length) || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: AUTO_PROJECT_NAME }),
      });
      const p = await res.json();
      if (!res.ok || !p.id) throw new Error(p.error ?? "项目创建失败");
      armPendingStart(p.id, { message, files });
      router.push(`/p/${p.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "项目创建失败");
      lock.current = false;
      setBusy(false);
    }
  };

  return <div className="home-start">
    <div
      className="home-create"
      onDragOver={(e) => { e.preventDefault(); }}
      onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void go(); } }}
        placeholder="描述你的造价任务，比如「给这份清单组价」"
        aria-label="造价任务"
        maxLength={500}
        disabled={busy}
        autoFocus
      />
      <input
        ref={fileRef}
        type="file"
        accept=".xls,.xlsx,.csv,.pdf"
        multiple
        hidden
        onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
      />
      <Button variant="ghost" size="icon-sm" aria-label="上传附件" disabled={busy} onClick={() => fileRef.current?.click()}><Paperclip size={16} /></Button>
      <Button size="icon" aria-label="开始任务" disabled={busy || (!text.trim() && !files.length)} onClick={() => void go()}>
        {busy ? <Loader2 size={16} className="spin" /> : <ArrowRight size={16} />}
      </Button>
    </div>
    {files.length > 0 && <ul className="home-files">
      {files.map((f, i) => <li key={`${f.name}-${i}`}>
        {f.name.toLowerCase().endsWith(".pdf") ? <FileText size={12} aria-hidden="true" /> : <FileSpreadsheet size={12} aria-hidden="true" />}<span>{f.name}</span>
        <button type="button" aria-label={`移除 ${f.name}`} onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}><X size={11} /></button>
      </li>)}
    </ul>}
    {error && <p className="home-create-error" role="alert">{error}</p>}
  </div>;
}
