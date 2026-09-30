"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";

/** Business requests stay inside the professional panel's own origin. */
export function HarnessBridge() {
  const pathname = usePathname();
  useEffect(() => {
    if (window.parent === window) return;
    const origin = new URLSearchParams(location.search).get("harnessOrigin") ?? sessionStorage.getItem("installation:harnessOrigin");
    if (origin !== "http://127.0.0.1:3210") return;
    sessionStorage.setItem("installation:harnessOrigin", origin);
    document.body.classList.add("harness-embedded");
    let disposed = false;
    const catalog = async () => {
      try {
        const res = await fetch("/api/projects");
        if (!res.ok) return;
        const projects = await res.json();
        if (!disposed) window.parent.postMessage({ type: "installation:catalog", projectId: pathname.match(/^\/p\/([^/]+)$/)?.[1], projects: projects.map((p: { id: string; name: string; harnessSessionId: string; _count: { boqItems: number; files: number } }) => ({ id: p.id, name: p.name, sessionId: p.harnessSessionId, rows: p._count.boqItems, files: p._count.files })) }, origin);
      } catch { /* The professional page reports its own load errors. */ }
    };
    const receive = async (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== window.parent) return;
      if (event.data?.type === "installation:theme") {
        document.documentElement.dataset.theme = event.data.dark ? "dark" : "light";
        return;
      }
      if (event.data?.type === "installation:upload") {
        const { projectId, files, requestId } = event.data;
        if (pathname !== `/p/${projectId}` || !Array.isArray(files) || !files.every(file => file instanceof File)) return;
        try {
          const { useStore } = await import("./store");
          if (useStore.getState().running) throw new Error("请先完成当前导入或映射确认");
          const previousError = useStore.getState().blocks.filter(b => b.type === "error").at(-1);
          for (const file of files) {
            await useStore.getState().upload(file);
            const error = useStore.getState().blocks.filter(b => b.type === "error").at(-1);
            if (error && error !== previousError) throw new Error(error.text);
          }
          window.parent.postMessage({ type: "installation:uploadFinished", requestId, ok: true }, origin);
        } catch (error) { window.parent.postMessage({ type: "installation:uploadFinished", requestId, ok: false, text: error instanceof Error ? error.message : "导入失败" }, origin); }
        return;
      }
      if (event.data?.type !== "installation:linkSession") return;
      const { projectId, sessionId, requestId } = event.data;
      if (typeof projectId !== "string" || typeof sessionId !== "string") return;
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ harnessSessionId: sessionId }) });
        if (!res.ok) throw new Error((await res.json()).error ?? "会话关联保存失败");
        window.parent.postMessage({ type: "installation:sessionLinked", requestId, ok: true }, origin);
        void catalog();
      } catch (error) { window.parent.postMessage({ type: "installation:sessionLinked", requestId, ok: false, text: error instanceof Error ? error.message : "会话关联保存失败" }, origin); }
    };
    window.addEventListener("message", receive);
    void catalog();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void catalog(); }, 8000);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener("message", receive); };
  }, [pathname]);
  return null;
}
