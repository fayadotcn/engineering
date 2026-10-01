"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { HARNESS_THEME } from "@shared/harnessTheme";

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
    const receive = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== window.parent) return;
      if (event.data?.type === "installation:theme") {
        document.documentElement.dataset.theme = event.data.dark ? "dark" : "light";
        for (const key of Object.keys(HARNESS_THEME)) {
          const value = event.data.values?.[key];
          if (typeof value === "string" && value.trim()) document.documentElement.style.setProperty(key, value);
        }
        return;
      }
    };
    window.addEventListener("message", receive);
    void catalog();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void catalog(); }, 8000);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener("message", receive); };
  }, [pathname]);
  return null;
}
