import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client";
import type {} from "@deepseek-ai/dsh-client-ui-theme/client";
import type {} from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { PropsRuntime, PropsRenderFactories, PropsRenderSlots } from "@deepseek-ai/dsh-client-ui-slots";

export const inject = ["slots", "layout", "sessions", "uiWorkspace", "conversation", "theme"];
declare module "@deepseek-ai/dsh-api-session-controller/client" {
  interface SessionReferenceSourceMap { installationPanel: unknown }
}
type Project = { id: string; name: string; sessionId: string; files: number; rows: number };
function Icon({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 21V4h11v17M15 9h5v12M8 8h3M8 12h3M8 16h3M2 21h20" /></svg>;
}

export function apply(ctx: Context) {
  const origin = "http://127.0.0.1:3211";
  const state = createSnapshotStore<{ projects: Project[]; activeId: string | null; dataProjectId: string | null; error: string | null; opening: string | null }>({ projects: [], activeId: null, dataProjectId: null, error: null, opening: null });
  const useProjects = () => useSyncExternalStore(state.subscribe, state.getSnapshot);
  const frames = new Map<Window, "home" | "data" | "project">();
  const projectFrames = new Map<string, Window>();
  const theme = (frame: Window) => frame.postMessage({ type: "installation:theme", dark: ctx.theme.getTheme().active.colorScheme === "dark" }, origin);
  const requestLink = (source: Window, projectId: string, sessionId: SessionId) => new Promise<void>((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { window.removeEventListener("message", receive); reject(new Error("项目会话关联未保存，请重试")); }, 15000);
    const receive = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== source || event.data?.type !== "installation:sessionLinked" || event.data.requestId !== requestId) return;
      clearTimeout(timer); window.removeEventListener("message", receive);
      event.data.ok ? resolve() : reject(new Error(event.data.text ?? "项目会话关联保存失败"));
    };
    window.addEventListener("message", receive);
    source.postMessage({ type: "installation:linkSession", projectId, sessionId, requestId }, origin);
  });
  const openProject = async (project: Project, source = frames.keys().next().value as Window | undefined) => {
    const navigation = ctx.layout.beginNavigation();
    state.update(s => { s.opening = project.id; s.error = null; });
    try {
      let sessionId = project.sessionId as SessionId;
      if (!sessionId) {
        if (!source) throw new Error("项目目录正在加载，请稍后重试");
        sessionId = await ctx.sessions.create();
        await requestLink(source, project.id, sessionId);
        state.update(s => { const p = s.projects.find(p => p.id === project.id); if (p) p.sessionId = sessionId; });
      } else await ctx.sessions.create({ sessionId });
      if (navigation.aborted) return;
      await ctx.sessions.using(sessionId, { source: "installationPanel" }, async ref => {
        await ref.ready;
        if (navigation.aborted) return;
        state.update(s => { s.activeId = project.id; s.dataProjectId = null; });
        localStorage.setItem("installation:activeProject", project.id);
        ctx.uiWorkspace.openSession(sessionId);
        ctx.layout.selectPanel(null);
        ctx.layout.closeRightbar();
      });
    } catch (error) { state.update(s => { s.error = error instanceof Error ? error.message : "项目打开失败"; }); }
    finally { state.update(s => { if (s.opening === project.id) s.opening = null; }); }
  };

  function Frame({ path, role }: { path: string; role: "home" | "data" | "project" }) {
    const ref = useRef<HTMLIFrameElement>(null);
    useEffect(() => {
      const source = ref.current?.contentWindow;
      if (source) frames.set(source, role);
      const projectId = role === "project" ? decodeURIComponent(path.slice(3)) : undefined;
      if (source && projectId) projectFrames.set(projectId, source);
      return () => { if (source) frames.delete(source); if (projectId) projectFrames.delete(projectId); };
    }, []);
    return <iframe ref={ref} src={`${origin}${path}?embedded=1&harnessOrigin=${encodeURIComponent(location.origin)}`} title={role === "project" ? "项目专业数据" : role === "data" ? "材料与定额库" : "工程项目"} onLoad={() => { if (ref.current?.contentWindow) theme(ref.current.contentWindow); }} style={{ width: "100%", height: "100%", border: 0, display: "block", background: "var(--dsw-alias-bg-base)" }} />;
  }
  ctx.effect(() => {
    let restoring = true;
    const receive = async (event: MessageEvent) => {
      if (event.origin !== origin || !frames.has(event.source as Window)) return;
      const source = event.source as Window;
      if (event.data?.type === "installation:catalog" && Array.isArray(event.data.projects)) {
        theme(source);
        state.update(s => { s.projects = event.data.projects; });
        const target = frames.get(source) === "home" ? event.data.projectId : undefined;
        const restore = restoring ? localStorage.getItem("installation:activeProject") : null;
        restoring = false;
        const project = state.getSnapshot().projects.find(p => p.id === (target ?? restore));
        if (project) await openProject(project, source);
        return;
      }
      if (event.data?.type === "installation:showData") {
        const projectId = event.data.projectId;
        if (projectFrames.get(projectId) === source && state.getSnapshot().activeId === projectId) state.update(s => { s.dataProjectId = projectId; });
        return;
      }
      if (event.data?.type !== "installation:task") return;
      const { projectId, text } = event.data;
      const project = state.getSnapshot().projects.find(p => p.id === projectId);
      if (!project || typeof text !== "string" || !text.trim() || text.length > 8000) return;
      try {
        await openProject(project, source);
        const updated = state.getSnapshot().projects.find(p => p.id === projectId)!;
        if (!updated.sessionId || state.getSnapshot().error) throw new Error(state.getSnapshot().error ?? "会话未就绪");
        await ctx.sessions.scope(updated.sessionId as SessionId)!.conversation.send(text);
        source.postMessage({ type: "installation:taskFinished", projectId }, origin);
      } catch (error) { source.postMessage({ type: "installation:taskError", projectId, text: error instanceof Error ? error.message : "任务发送失败" }, origin); }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  });
  ctx.on("theme/change", () => { for (const frame of frames.keys()) theme(frame); });

  for (const [key, label, path, role] of [["installation", "工程项目", "/", "home"], ["installation-create", "新建工程", "/new", "home"], ["installation-data", "材料与定额库", "/admin", "data"]] as const) {
    ctx.slots.inject("main", () => {
      const dispose = ctx.slots.register({ name: "main", key }, () => <Frame path={path} role={role} />);
      if (key === "installation") ctx.layout.selectPanel("installation" as Parameters<typeof ctx.layout.selectPanel>[0]);
      return dispose;
    });
    ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name: "sidebar.panellist", id: key, order: -100, label }, Icon));
  }
  ctx.slots.inject("sidebar.brand.name", () => ctx.slots.register({ name: "sidebar.brand.name", priority: -100 }, () => <span>安装造价</span>));
  ctx.slots.inject("sidebar.brand.mark", () => ctx.slots.register({ name: "sidebar.brand.mark", priority: -100 }, Icon));
  ctx.slots.inject("conversation.hero.brand.mark", () => ctx.slots.register({ name: "conversation.hero.brand.mark", priority: -100 }, Icon));
  function Projects({ wide, expandSidebar }: PropsRuntime<"sidebar.workspaces">) {
    const s = useProjects();
    const [query, setQuery] = useState("");
    if (!wide) return <button className="installation-rail" title="工程项目" onClick={expandSidebar}><Icon /></button>;
    return <div className="installation-projects"><div className="installation-project-label">我的工程 <span>{s.projects.length}</span></div><input aria-label="搜索工程" placeholder="搜索工程…" value={query} onChange={e => setQuery(e.target.value)} />{s.projects.filter(p => p.name.includes(query.trim())).map(p => <button key={p.id} className={s.activeId === p.id ? "active" : ""} disabled={s.opening === p.id} onClick={() => void openProject(p)}><Icon size={16} /><span>{p.name}<small>{s.opening === p.id ? "正在打开…" : `${p.files} 份资料 · ${p.rows} 行清单`}</small></span></button>)}{s.error && <p role="alert" className="installation-error">{s.error}</p>}</div>;
  }
  ctx.slots.inject("sidebar.workspaces", () => ctx.slots.register({ name: "sidebar.workspaces", priority: -100 }, Projects));
  const createPanel = () => ctx.layout.selectPanel("installation-create" as Parameters<typeof ctx.layout.selectPanel>[0]);
  function EngineeringSidebar({ collapsed, renderSlot }: PropsRuntime<"sidebar"> & PropsRenderSlots<"sidebar.workspaces" | "sidebar.settings">) {
    const wide = !collapsed;
    return <aside className={`installation-sidebar ${wide ? "wide" : "rail"}`}>
      <div className="installation-sidebar-brand"><button aria-label={wide ? "工程总览" : "展开工程栏"} onClick={() => wide ? ctx.layout.selectPanel("installation" as Parameters<typeof ctx.layout.selectPanel>[0]) : ctx.layout.toggleSidebar()}><Icon size={21} />{wide && <strong>安装造价</strong>}</button>{wide && <button title="折叠工程栏" aria-label="折叠工程栏" onClick={() => ctx.layout.toggleSidebar()}>‹</button>}</div>
      <button className="installation-create" aria-label="新建工程" title="新建工程" onClick={createPanel}><span>＋</span>{wide && "新建工程"}</button>
      <div className="installation-sidebar-list">{renderSlot("sidebar.workspaces", { wide, expandSidebar: () => ctx.layout.toggleSidebar() })}</div>
      <button className="installation-library" title="材料与定额库" aria-label="材料与定额库" onClick={() => ctx.layout.selectPanel("installation-data" as Parameters<typeof ctx.layout.selectPanel>[0])}><Icon size={17} />{wide && "材料与定额库"}</button>
      {renderSlot("sidebar.settings", { wide })}
    </aside>;
  }
  ctx.slots.inject("sidebar", () => ctx.slots.register({ name: "sidebar", children: {
    "sidebar.brand.mark": { kind: "single", scope: "root" }, "sidebar.brand.name": { kind: "single", scope: "root" }, "sidebar.toggle.badge": { kind: "single", scope: "root" },
    "sidebar.panellist": { kind: "list", scope: "root" }, "sidebar.workspaces": { kind: "single", scope: "root" }, "sidebar.settings": { kind: "single", scope: "root" }, "sidebar.footer.action": { kind: "list", scope: "root" },
  } }, EngineeringSidebar));

  // Keep Harness's transcript, composer, approvals and model controls, while the
  // cost project supplies context in place of the coding workspace picker.
  function CostConversation({ sessionId, useSession, renderFactorySlot }: PropsRuntime<"main.conversation"> & PropsRenderFactories) {
    const session = useSession(s => s);
    const s = useProjects();
    const project = s.projects.find(p => p.sessionId === sessionId);
    if (!project) return <div className="installation-project-empty"><Icon size={28} /><h2>先新建或选择工程</h2><p>每个工程都有独立的 Agent 对话、资料和计价记录。</p><button className="installation-create" onClick={createPanel}>＋ 新建工程</button></div>;
    const data = s.dataProjectId === project.id;
    return <div className="installation-conversation" data-view={data ? "data" : "chat"}>
      <header className="installation-conversation-header"><strong title={project.name}>{project.name}</strong><button className="installation-open-results" onClick={() => state.update(draft => { draft.dataProjectId = data ? null : project.id; })}>{data ? "返回造价对话" : "清单与结果"}</button></header>
      <div className="installation-chat-surface" hidden={data}>
        {session?.blank && <div className="installation-welcome"><Icon size={28} /><h2>开始这份工程的造价工作</h2><p>导入资料，或直接告诉我需要核对什么。<br />清单和计价成果可在「清单与结果」中查看。</p></div>}
        {renderFactorySlot("conversation.content", { variant: "embedded", phase: session?.openState === "loading" ? "settling" : "active", hero: false })}
      </div>
      <div className="installation-data-surface" hidden={!data}><Frame key={project.id} path={`/p/${encodeURIComponent(project.id)}`} role="project" /></div>
    </div>;
  }
  ctx.slots.inject("main.conversation", () => ctx.slots.register({ name: "main.conversation", priority: -100 }, CostConversation));
  function ProjectContext({ sessionId }: PropsRuntime<"conversation.input.dock">) {
    const s = useProjects();
    const project = s.projects.find(p => p.sessionId === sessionId);
    const fileRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState("");
    const stopUploadListener = useRef<(() => void) | null>(null);
    useEffect(() => {
      setUploading(false); setUploadError("");
      return () => { stopUploadListener.current?.(); stopUploadListener.current = null; };
    }, [project?.id]);
    const upload = async (files: File[]) => {
      if (!project || !files.length || uploading) return;
      const source = projectFrames.get(project.id);
      if (!source) { setUploadError("工程资料正在加载，请稍后重试"); return; }
      state.update(draft => { draft.dataProjectId = project.id; });
      setUploading(true); setUploadError("");
      const requestId = crypto.randomUUID();
      const receive = (event: MessageEvent) => {
        if (event.origin !== origin || event.source !== source || event.data?.type !== "installation:uploadFinished" || event.data.requestId !== requestId) return;
        window.removeEventListener("message", receive); setUploading(false);
        stopUploadListener.current = null;
        if (!event.data.ok) setUploadError(event.data.text ?? "导入失败，请重试");
      };
      window.addEventListener("message", receive);
      stopUploadListener.current = () => window.removeEventListener("message", receive);
      source.postMessage({ type: "installation:upload", projectId: project.id, files, requestId }, origin);
    };
    if (!project) return <div className="installation-context muted">选择工程后，对话将自动使用该工程的资料和计价条件。</div>;
    return <div className="installation-context"><div><Icon size={15} /><strong>{project.name}</strong><span>{project.files} 份资料</span></div><input ref={fileRef} type="file" accept=".xls,.xlsx,.csv,.pdf" multiple hidden onChange={e => { void upload(Array.from(e.target.files ?? [])); e.target.value = ""; }} /><div className="installation-quick-tasks"><button disabled={uploading} onClick={() => fileRef.current?.click()}>{uploading ? "正在导入，请核对列映射…" : "导入资料"}</button>{["预览缺价项", "测算综合单价", "审核清单"].map(text => <button key={text} disabled={uploading} onClick={() => void ctx.sessions.scope(sessionId)!.conversation.send(text).catch(() => {})}>{text}</button>)}</div>{uploadError && <p role="alert" className="installation-error">{uploadError}</p>}</div>;
  }
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({ name: "conversation.input.dock", id: "installation-context", order: -100 }, ProjectContext));
  ctx.slots.inject("conversation.hero.workspace", () => ctx.slots.register({ name: "conversation.hero.workspace", priority: -100 }, () => <span className="installation-hero-hint">安装工程 · 清单接入 / 定额组价 / 造价审核</span>));
  ctx.effect(() => {
    const style = document.createElement("style");
    style.textContent = `
      .installation-sidebar{display:flex;flex-direction:column;height:100%;box-sizing:border-box;padding:12px;background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-primary);font-size:13px}.installation-sidebar-brand{display:flex;align-items:center;justify-content:space-between;min-height:46px;margin-bottom:12px}.installation-sidebar-brand button{display:flex;align-items:center;gap:9px;background:none;border:0;color:inherit;cursor:pointer;padding:6px}.installation-sidebar-brand strong{font-size:17px;font-weight:600}.installation-sidebar-brand>button:last-child{font-size:24px;color:var(--dsw-alias-label-tertiary)}.installation-sidebar-list{flex:1;min-height:0;overflow-y:auto}.installation-sidebar .installation-projects{padding:6px 0 20px}.installation-create{display:flex;align-items:center;justify-content:center;gap:7px;min-height:38px;padding:8px 12px;border:0;border-radius:6px;color:white;background:var(--dsw-alias-button-info-fill);font:inherit;font-size:13px;cursor:pointer;margin-bottom:12px}.installation-create span{font-size:18px;line-height:1}.installation-library{display:flex;align-items:center;gap:9px;padding:12px 8px;border:0;border-radius:6px;background:none;color:inherit;font:inherit;cursor:pointer}.installation-library:hover{background:var(--dsw-alias-interactive-bg-hover)}.installation-sidebar.rail{padding:12px 8px}.installation-sidebar.rail .installation-sidebar-brand{justify-content:center}.installation-sidebar.rail .installation-create{padding:8px}.installation-sidebar.rail .installation-rail{margin:16px 10px}.installation-sidebar.rail .installation-library{justify-content:center;padding-inline:0}.installation-project-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:18px;padding:28px;color:var(--dsw-alias-label-tertiary);text-align:center}.installation-project-empty h2{font-size:21px;font-weight:500;color:var(--dsw-alias-label-primary)}.installation-project-empty p{font-size:13px;line-height:1.8}
      .installation-conversation{display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;position:relative;background:var(--dsw-alias-bg-base)}
      .installation-conversation-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 24px;font-size:13px;color:var(--dsw-alias-label-secondary)}.installation-conversation-header strong{font-weight:500;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.installation-conversation-header button{flex-shrink:0}
      .installation-chat-surface{display:flex;flex-direction:column;flex:1;min-height:0;position:relative}.installation-data-surface{flex:1;min-height:0;min-width:0}.installation-chat-surface[hidden],.installation-data-surface[hidden]{display:none}
      .installation-conversation [data-conversation-scroll]{justify-content:flex-end}.installation-welcome{position:absolute;top:30%;left:28px;right:28px;text-align:center;pointer-events:none;color:var(--dsw-alias-label-tertiary)}.installation-welcome svg{margin:0 auto 18px;opacity:.55}.installation-welcome h2{font-size:20px;font-weight:500;line-height:1.6;color:var(--dsw-alias-label-primary);margin:0 0 12px}.installation-welcome p{font-size:12px;line-height:1.8;margin:0;max-width:320px;margin-inline:auto}
      .installation-conversation .installation-context{padding:12px 20px}
      .installation-projects{padding:12px 12px 20px;font-size:13px;color:var(--dsw-alias-label-primary)}
      .installation-project-label{display:flex;justify-content:space-between;color:var(--dsw-alias-label-tertiary);font-size:11px;margin:12px 8px}
      .installation-projects input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:transparent;border-radius:6px;padding:8px 10px;font:inherit;font-size:12px;margin-bottom:12px;color:inherit}
      .installation-projects>button{display:flex;gap:10px;align-items:flex-start;width:100%;padding:12px 9px;border:0;border-radius:7px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit;margin-bottom:3px}
      .installation-projects>button:hover,.installation-projects>button.active{background:var(--dsw-alias-interactive-bg-hover)}
      .installation-projects>button svg{margin-top:2px;flex-shrink:0;opacity:.6}.installation-projects small{display:block;font-size:10px;color:var(--dsw-alias-label-tertiary);margin-top:6px}.installation-projects span{min-width:0;overflow-wrap:anywhere}
      .installation-error{font-size:12px;color:#aa4f49;margin:12px 8px}.installation-rail{border:0;background:transparent;color:inherit;margin:16px;cursor:pointer}
      .installation-context{padding:12px 4px;color:var(--dsw-alias-label-secondary);font-size:12px}.installation-context>div:first-child{display:flex;align-items:center;gap:8px}.installation-context strong{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.installation-context span{font-size:10px;color:var(--dsw-alias-label-tertiary);margin-left:auto;white-space:nowrap}
      .installation-quick-tasks{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.installation-quick-tasks button,.installation-open-results{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 9px;background:transparent;color:inherit;font:inherit;font-size:11px;cursor:pointer}.installation-quick-tasks button:hover,.installation-open-results:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .installation-hero-hint{font-size:12px;color:var(--dsw-alias-label-tertiary)}.installation-context.muted{color:var(--dsw-alias-label-tertiary)}
    `;
    document.head.append(style);
    return () => style.remove();
  });
}
