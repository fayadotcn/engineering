import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client";
import type {} from "@deepseek-ai/dsh-client-ui-theme/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";
import type {} from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { PropsRuntime, PropsRenderFactories, PropsRenderSlots } from "@deepseek-ai/dsh-client-ui-slots";
import { ActivityCards } from "./cards";
import { fetchActivity, streamRun, uploadProjectFile, type ProjectActivity } from "./activity";
import { HARNESS_THEME } from "../../shared/harnessTheme";

export const inject = ["slots", "layout", "sessions", "uiWorkspace", "conversation", "theme", "sidebarRightTabs", "sidebarRight"];
declare module "@deepseek-ai/dsh-api-session-controller/client" {
  interface SessionReferenceSourceMap { installationPanel: unknown }
}
type Project = { id: string; name: string; sessionId: string; files: number; rows: number };
type ImportProgress = { running: boolean; filename: string; progress: string; error: string };

/** 专业工作区在右侧面板里的 tab 类型：一个工程 = 一个会话 = 一个工作区 tab。 */
const WORKSPACE_KIND = "installation-workspace";
const WORKSPACE_ID = "@zaojia/installation-harness:workspace";

function Icon({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 21V4h11v17M15 9h5v12M8 8h3M8 12h3M8 16h3M2 21h20" /></svg>;
}

export function apply(ctx: Context) {
  const origin = "http://127.0.0.1:3211";
  const state = createSnapshotStore<{ projects: Project[]; activeId: string | null; error: string | null; opening: string | null; activities: Record<string, ProjectActivity>; imports: Record<string, ImportProgress>; panes: Record<string, { title: string; busy: boolean }> }>({ projects: [], activeId: null, error: null, opening: null, activities: {}, imports: {}, panes: {} });
  const useProjects = () => useSyncExternalStore(state.subscribe, state.getSnapshot);
  const frames = new Map<Window, "home" | "data" | "workspace">();
  const projectFrames = new Map<string, Window>();
  const readyFrames = new Set<Window>();
  const runningProjects = new Map<string, boolean>();
  const activityVersion = new Map<string, number>();
  const sendingProjects = new Set<string>();

  /** 卡片状态：Agent 一轮结束、导入结束、确认后都刷新一次；不轮询。 */
  const refreshActivity = async (projectId: string) => {
    const version = (activityVersion.get(projectId) ?? 0) + 1;
    activityVersion.set(projectId, version);
    const activity = await fetchActivity(origin, projectId);
    if (activity && activityVersion.get(projectId) === version) state.update(s => { s.activities[projectId] = activity; });
  };

  const openWorkspace = () => {
    const sessionId = ctx.sidebarRight.mounted.getSnapshot();
    const existing = sessionId && ctx.sidebarRight.tabsIn(sessionId).find(tab => tab.kind === WORKSPACE_KIND);
    if (!existing) { ctx.sidebarRight.openTab(WORKSPACE_KIND); return; }
    ctx.sidebarRight.focus(existing.id);
    if (!ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded();
  };
  // 结果卡片要"点一下就到那一行"：面板挂载后再投递目标，否则视图还不存在。
  let focusTarget: { projectId: string; viewId?: string; boqQuery?: string } | null = null;
  const deliverFocus = () => {
    if (!focusTarget) return;
    const source = projectFrames.get(focusTarget.projectId);
    if (!source || !readyFrames.has(source)) return;
    source.postMessage({ type: "installation:focus", ...focusTarget }, origin);
    focusTarget = null;
  };
  const focusProject = (projectId: string, target: { viewId?: string; boqQuery?: string }) => {
    openWorkspace();
    focusTarget = { projectId, ...target };
    deliverFocus();
  };
  /** 导入/确认后让已打开的面板立刻重载，不必等它自己那 8 秒轮询。 */
  const refreshFrames = (projectId: string) => {
    const source = projectFrames.get(projectId);
    if (source && readyFrames.has(source)) source.postMessage({ type: "installation:refresh", projectId }, origin);
  };
  const taskState = (projectId: string, running: boolean) => {
    runningProjects.set(projectId, running);
    projectFrames.get(projectId)?.postMessage({ type: "installation:taskState", projectId, running }, origin);
  };
  const theme = (frame: Window) => {
    const computed = getComputedStyle(document.body);
    const values = Object.fromEntries(Object.entries(HARNESS_THEME).map(([key, token]) => [key, computed.getPropertyValue(token).trim()]));
    frame.postMessage({ type: "installation:theme", dark: ctx.theme.getTheme().active.colorScheme === "dark", values }, origin);
  };
  const openProject = async (project: Project) => {
    const navigation = ctx.layout.beginNavigation();
    state.update(s => { s.opening = project.id; s.error = null; });
    try {
      let sessionId = project.sessionId as SessionId;
      if (!sessionId) {
        sessionId = await ctx.sessions.create();
        const response = await fetch(`${origin}/api/projects/${encodeURIComponent(project.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ harnessSessionId: sessionId }) });
        if (!response.ok) throw new Error((await response.json()).error ?? "工程会话关联保存失败");
        state.update(s => { const p = s.projects.find(p => p.id === project.id); if (p) p.sessionId = sessionId; });
      } else await ctx.sessions.create({ sessionId });
      if (navigation.aborted) return;
      await ctx.sessions.using(sessionId, { source: "installationPanel" }, async ref => {
        await ref.ready;
        if (navigation.aborted) return;
        state.update(s => { s.activeId = project.id; });
        localStorage.setItem("installation:activeProject", project.id);
        ctx.uiWorkspace.openSession(sessionId);
        ctx.layout.selectPanel(null);
        // 工程从对话开始，清单与结果由用户按需打开。
      });
    } catch (error) { state.update(s => { s.error = error instanceof Error ? error.message : "项目打开失败"; }); }
    finally { state.update(s => { if (s.opening === project.id) s.opening = null; }); }
  };

  /** 全局面板（工程目录 / 新建工程 / 材料与定额库）承载的非项目页面。 */
  function Frame({ path, role }: { path: string; role: "home" | "data" }) {
    const ref = useRef<HTMLIFrameElement>(null);
    useEffect(() => {
      const source = ref.current?.contentWindow;
      if (source) frames.set(source, role);
      return () => { if (source) frames.delete(source); };
    }, []);
    return <iframe ref={ref} src={`${origin}${path}?embedded=1&harnessOrigin=${encodeURIComponent(location.origin)}`} title={role === "data" ? "材料与定额库" : "工程项目"} onLoad={() => { if (ref.current?.contentWindow) theme(ref.current.contentWindow); }} style={{ width: "100%", height: "100%", border: 0, display: "block", background: "var(--dsw-alias-bg-base)" }} />;
  }

  ctx.effect(() => {
    let restoring = true;
    const receive = async (event: MessageEvent) => {
      if (event.origin !== origin || !frames.has(event.source as Window)) return;
      const source = event.source as Window;
      if (event.data?.type === "installation:activityChanged" && projectFrames.get(event.data.projectId) === source) {
        await refreshActivity(event.data.projectId);
        return;
      }
      if (event.data?.type === "installation:workspaceState" && projectFrames.get(event.data.projectId) === source) {
        if (typeof event.data.title === "string") state.update(s => { s.panes[event.data.projectId] = { title: event.data.title, busy: !!event.data.busy }; });
        return;
      }
      if (event.data?.type === "installation:catalog" && Array.isArray(event.data.projects)) {
        theme(source);
        state.update(s => { s.projects = event.data.projects; });
        const target = frames.get(source) === "home" ? event.data.projectId : undefined;
        const restore = restoring ? localStorage.getItem("installation:activeProject") : null;
        const shouldRestore = restoring;
        restoring = false;
        const project = state.getSnapshot().projects.find(p => p.id === (target ?? restore));
        if (project && (shouldRestore || (target && state.getSnapshot().activeId !== project.id))) await openProject(project);
        return;
      }
      // 工作区就绪后才投递"点卡片要定位到哪"的目标，否则目标视图尚未重放出来。
      if (event.data?.type === "installation:ready") {
        if (projectFrames.get(event.data.projectId) !== source) return;
        readyFrames.add(source);
        taskState(event.data.projectId, runningProjects.get(event.data.projectId) ?? false);
        source.postMessage({ type: "installation:importState", projectId: event.data.projectId, running: state.getSnapshot().imports[event.data.projectId]?.running ?? false }, origin);
        deliverFocus();
        return;
      }
      if (event.data?.type !== "installation:task") return;
      const { projectId, text } = event.data;
      const project = state.getSnapshot().projects.find(p => p.id === projectId);
      if (!project || typeof text !== "string" || !text.trim() || text.length > 8000) return;
      if (sendingProjects.has(projectId) || runningProjects.get(projectId) || state.getSnapshot().imports[projectId]?.running) {
        source.postMessage({ type: "installation:taskError", projectId, text: "当前工程正在处理任务，请完成后再发送" }, origin);
        return;
      }
      sendingProjects.add(projectId);
      try {
        if (state.getSnapshot().activeId !== project.id) await openProject(project);
        const updated = state.getSnapshot().projects.find(p => p.id === projectId)!;
        if (!updated.sessionId || state.getSnapshot().error) throw new Error(state.getSnapshot().error ?? "会话未就绪");
        await ctx.sessions.scope(updated.sessionId as SessionId)!.conversation.send(text);
        source.postMessage({ type: "installation:taskFinished", projectId }, origin);
      } catch (error) { source.postMessage({ type: "installation:taskError", projectId, text: error instanceof Error ? error.message : "任务发送失败" }, origin); }
      finally { sendingProjects.delete(projectId); }
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
    if (!wide) return <button className="installation-rail" title="工程项目" aria-label="展开工程项目" onClick={expandSidebar}><Icon /></button>;
    const filtered = s.projects.filter(p => p.name.toLowerCase().includes(query.trim().toLowerCase()));
    return <div className="installation-projects"><div className="installation-project-label">我的工程 <span>{s.projects.length}</span></div>{(s.projects.length > 6 || query) && <input aria-label="搜索工程" placeholder="搜索工程…" value={query} onChange={e => setQuery(e.target.value)} />}{filtered.map(p => <button key={p.id} aria-current={s.activeId === p.id ? "page" : undefined} className={s.activeId === p.id ? "active" : ""} disabled={!!s.opening} onClick={() => { ctx.layout.toggleSidebar(); void openProject(p); }}><Icon size={16} /><span>{p.name}<small>{s.opening === p.id ? "正在打开…" : `${p.files} 份资料 · ${p.rows} 行清单`}</small></span></button>)}{!filtered.length && <p className="installation-list-empty">{query.trim() ? "没有匹配的工程" : "新建工程，开始导入资料"}</p>}{s.error && <p role="alert" className="installation-error">{s.error}</p>}</div>;
  }
  ctx.slots.inject("sidebar.workspaces", () => ctx.slots.register({ name: "sidebar.workspaces", priority: -100 }, Projects));
  const createPanel = () => ctx.layout.selectPanel("installation-create" as Parameters<typeof ctx.layout.selectPanel>[0]);
  function EngineeringSidebar({ collapsed, renderSlot }: PropsRuntime<"sidebar"> & PropsRenderSlots<"sidebar.workspaces" | "sidebar.settings">) {
    const { activeId } = useProjects();
    const panel = useSyncExternalStore(ctx.layout.panelInfo.subscribe, ctx.layout.panelInfo.getSnapshot);
    const working = !!activeId && panel.activePanelId === null;
    // 工程列表只在选工程时展开，工作时把宽度留给对话和专业数据。
    useEffect(() => {
      if (working && !collapsed) ctx.layout.toggleSidebar();
    }, [working, activeId]);
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

  // 专业工作区是右侧面板的一个 tab 类型，与对话同屏并列，而不是另一个应用。
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: WORKSPACE_ID,
    kind: WORKSPACE_KIND,
    title: () => "造价工作区",
    guide: [{ id: WORKSPACE_KIND, order: 10, title: () => "造价工作区", description: () => "当前工程的清单、资料与造价成果" }],
  }), "installation: workspace tab type");

  /** 面板内容跟随所属会话的工程；分屏/浮动/全屏/宽度都由右侧面板原生提供。 */
  function ProjectPane({ sessionId }: PropsRuntime<"sidebar.right.pane.tab">) {
    const s = useProjects();
    const project = s.projects.find(p => p.sessionId === sessionId);
    const ref = useRef<HTMLIFrameElement>(null);
    const projectId = project?.id;
    useEffect(() => {
      const source = ref.current?.contentWindow;
      if (!source || !projectId) return;
      frames.set(source, "workspace");
      projectFrames.set(projectId, source);
      return () => {
        frames.delete(source);
        readyFrames.delete(source);
        if (projectFrames.get(projectId) === source) projectFrames.delete(projectId);
        state.update(s => { delete s.panes[projectId]; });
      };
    }, [projectId]);
    if (!project) return <div className="installation-project-empty"><Icon size={26} /><h2>先选择一个工程</h2><p>工作区跟随当前会话所属的工程。</p></div>;
    return <iframe ref={ref} src={`${origin}/p/${encodeURIComponent(project.id)}?embedded=1&harnessOrigin=${encodeURIComponent(location.origin)}`} title={`${project.name} · 造价数据`} onLoad={() => { if (ref.current?.contentWindow) theme(ref.current.contentWindow); }} style={{ width: "100%", height: "100%", border: 0, display: "block", background: "var(--dsw-alias-bg-base)" }} />;
  }
  ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: WORKSPACE_ID }, ProjectPane)), "installation: workspace tab body");

  // 造价产品没有"工作区（文件夹）"这个概念，Harness 对空白会话的工作区门禁在此不适用。
  // 工程 header 与原生对话组合，空会话在输入框前展示可操作的起点。
  // 没有第二套导航、没有 chat/data 互斥、没有 iframe。
  function CostConversation({ sessionId, useSession, renderFactorySlot }: PropsRuntime<"main.conversation"> & PropsRenderFactories) {
    const session = useSession(s => s);
    const s = useProjects();
    const project = s.projects.find(p => p.sessionId === sessionId);
    const projectId = project?.id;
    const running = session?.running ?? false;
    // 首屏只展开对话，点击清单或结果卡片后再打开专业面板。
    useEffect(() => {
      if (projectId && sessionId === ctx.sidebarRight.mounted.getSnapshot() && ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded();
    }, [projectId, sessionId]);
    // 一轮结束刷新卡片：工具产出的视图此时已经落库，不需要轮询
    useEffect(() => {
      if (!projectId) return;
      taskState(projectId, running);
      if (running) return;
      void refreshActivity(projectId);
      refreshFrames(projectId);
    }, [projectId, running]);
    if (!project) return <div className="installation-project-empty"><Icon size={28} /><h2>先新建或选择工程</h2><p>每个工程都有独立的 Agent 对话、资料和计价记录。</p><button className="installation-create" onClick={createPanel}>＋ 新建工程</button></div>;
    const attention = !!s.activities[project.id]?.confirm;
    const activity = s.activities[project.id];
    return <div className="installation-conversation">
      <header className="installation-conversation-header"><div><button className="installation-project-switch" aria-label={`切换工程，当前为${project.name}`} onClick={() => ctx.layout.toggleSidebar()}><strong title={project.name}>{project.name}</strong><span aria-hidden="true">⌄</span></button><small>{running ? "助手正在处理" : `${project.rows} 行清单`}</small></div><button className={`installation-workspace-toggle${attention ? " attention" : ""}`} onClick={() => focusProject(project.id, { viewId: attention ? activity?.import?.mappingViewId ?? "view:files" : "view:boq" })}>{attention ? "核对导入" : "查看清单"}<span aria-hidden="true"> →</span></button></header>
      {renderFactorySlot("conversation.content", { variant: "embedded", phase: session?.openState === "loading" ? "settling" : session?.blank && !running ? "hero" : "active", hero: false })}
    </div>;
  }
  ctx.slots.inject("main.conversation", () => ctx.slots.register({ name: "main.conversation", priority: -100 }, CostConversation));

  /** 对话与工作区共享导入进度；切换工程不会丢失仍在执行的任务。 */
  function ProjectContext({ sessionId, useSession }: PropsRuntime<"conversation.input.dock">) {
    const s = useProjects();
    const agentBusy = useSession(session => session?.running ?? false);
    const blank = useSession(session => session?.blank ?? false);
    const project = s.projects.find(p => p.sessionId === sessionId);
    const fileRef = useRef<HTMLInputElement>(null);
    if (!project) return null;
    const projectId = project.id;
    const imported = s.imports[projectId];
    const activity = s.activities[projectId] ?? null;
    const busy = !!imported?.running || !!s.panes[projectId]?.busy || agentBusy;
    const hasCard = !!activity && (!!activity.confirm || activity.import?.status === "DONE" || !!activity.result?.views.length);
    const showStart = blank && !hasCard && !imported?.running && !agentBusy;
    const updateImport = (patch: Partial<ImportProgress>) => {
      const previous = state.getSnapshot().imports[projectId] as ImportProgress | undefined;
      const next = { ...(previous ?? { running: false, filename: "", progress: "", error: "" }), ...patch };
      state.update(s => { s.imports[projectId] = next; });
      if (previous?.running !== next.running) projectFrames.get(projectId)?.postMessage({ type: "installation:importState", projectId, running: next.running }, origin);
    };

    const upload = async (files: File[]) => {
      if (!files.length || busy || state.getSnapshot().imports[projectId]?.running) return;
      updateImport({ running: true, error: "", progress: "" });
      try {
        for (const file of files) {
          updateImport({ filename: file.name, progress: `正在上传「${file.name}」` });
          const outcome = await uploadProjectFile(origin, projectId, file);
          if (outcome.kind === "error") { updateImport({ error: outcome.message }); continue; }
          if (outcome.kind === "duplicate") { updateImport({ progress: `「${outcome.filename}」已导入，跳过重复文件` }); continue; }
          let awaitingConfirm = false;
          await streamRun(origin, outcome.runId, event => {
            const payload = event.payload;
            if (event.type === "tool_started") {
              const tool = String(payload.tool ?? "");
              updateImport({ progress: tool === "file.inspect" ? "正在识别表格结构…" : tool === "file.ingest" ? "正在导入数据…" : "正在汇总项目…" });
            } else if (event.type === "activity" || event.type === "activity_live") {
              updateImport({ progress: String(payload.text ?? "正在处理…") });
            } else if (event.type === "confirm_request") {
              awaitingConfirm = true;
            } else if (event.type === "error") {
              updateImport({ error: String(payload.text ?? "导入失败") });
            }
          }, () => awaitingConfirm);
          updateImport({ progress: "" });
          await refreshActivity(projectId);
          refreshFrames(projectId);
        }
      } catch (error) {
        updateImport({ error: error instanceof Error ? error.message : "导入失败，请重试", progress: "" });
      } finally {
        updateImport({ running: false, filename: "" });
        await refreshActivity(projectId);
        refreshFrames(projectId);
      }
    };

    const handlers = {
      onReviewMapping: () => focusProject(projectId, { viewId: activity?.import?.mappingViewId ?? "view:files" }),
      onFocusView: (viewId: string) => focusProject(projectId, { viewId }),
      onSend: (text: string) => {
        if (busy) return;
        void ctx.sessions.scope(sessionId)!.conversation.send(text).catch(error => updateImport({ error: error instanceof Error ? error.message : "任务发送失败" }));
      },
    };

    return <div className="installation-context">
      <input ref={fileRef} type="file" accept=".xls,.xlsx,.csv,.pdf" multiple hidden onChange={e => { void upload(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
      {showStart && <section className="installation-start"><h2>{project.rows ? "这份清单，需要我帮你做什么？" : "上传清单，开始造价"}</h2><p>{project.rows ? "直接说出你的目标，或从下面选一项。" : "支持 Excel、询价表和 PDF，上传后自动整理。"}</p><div className="installation-start-actions">{project.rows ? <><button disabled={busy} onClick={() => handlers.onSend("帮我给工程清单报价：查材料价、匹配定额并计算，先展示结果，需要修改清单时请求我的确认。")}>帮我测算报价</button><button disabled={busy} onClick={() => handlers.onSend("全面检查清单")}>检查清单问题</button><button disabled={busy} onClick={() => handlers.onSend("生成费用汇总表，说明计价条件缺项")}>汇总工程费用</button></> : <button className="primary" disabled={busy} onClick={() => fileRef.current?.click()}>＋ 导入工程资料</button>}</div></section>}
      <ActivityCards activity={activity} importing={!!imported?.running || agentBusy} importingFile={imported?.running ? imported.filename : ""} progress={imported?.running ? imported.progress : "正在处理你的任务…"} handlers={handlers} />
      {(!showStart || project.rows > 0 || project.files > 0) && <div className="installation-quick-tasks"><button disabled={busy} onClick={() => fileRef.current?.click()}>＋ 添加资料</button>{project.files > 0 && <button onClick={() => focusProject(projectId, { viewId: "view:files" })}>查看 {project.files} 份资料</button>}</div>}
      {!imported?.running && imported?.progress && <p className="installation-card-note" role="status">{imported.progress}</p>}
      {imported?.error && <p role="alert" className="installation-error">{imported.error}</p>}
    </div>;
  }
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({ name: "conversation.input.dock", id: "installation-context", order: -100 }, ProjectContext));
  ctx.slots.inject("conversation.hero.workspace", () => ctx.slots.register({ name: "conversation.hero.workspace", priority: -100 }, () => <span className="installation-hero-hint">安装工程 · 清单接入 / 定额组价 / 造价审核</span>));
  ctx.effect(() => {
    const style = document.createElement("style");
    style.textContent = `
      .installation-sidebar{display:flex;flex-direction:column;height:100%;box-sizing:border-box;padding:12px;background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-primary);font-size:13px}.installation-sidebar-brand{display:flex;align-items:center;justify-content:space-between;min-height:46px;margin-bottom:12px}.installation-sidebar-brand button{display:flex;align-items:center;gap:9px;background:none;border:0;color:inherit;cursor:pointer;padding:6px}.installation-sidebar-brand strong{font-size:17px;font-weight:600}.installation-sidebar-brand>button:last-child{font-size:24px;color:var(--dsw-alias-label-tertiary)}.installation-sidebar-list{flex:1;min-height:0;overflow-y:auto}.installation-sidebar .installation-projects{padding:6px 0 20px}.installation-create{display:flex;align-items:center;justify-content:center;gap:7px;min-height:38px;padding:8px 12px;border:0;border-radius:6px;color:white;background:var(--dsw-alias-button-info-fill);font:inherit;font-size:13px;cursor:pointer;margin-bottom:12px}.installation-create span{font-size:18px;line-height:1}.installation-library{display:flex;align-items:center;gap:9px;padding:12px 8px;border:0;border-radius:6px;background:none;color:inherit;font:inherit;cursor:pointer}.installation-library:hover{background:var(--dsw-alias-interactive-bg-hover)}.installation-sidebar.rail{padding:12px 8px}.installation-sidebar.rail .installation-sidebar-brand{justify-content:center}.installation-sidebar.rail .installation-create{padding:8px}.installation-sidebar.rail .installation-rail{margin:16px 10px}.installation-sidebar.rail .installation-library{justify-content:center;padding-inline:0}.installation-project-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:18px;padding:28px;color:var(--dsw-alias-label-tertiary);text-align:center}.installation-project-empty h2{font-size:20px;font-weight:500;color:var(--dsw-alias-label-primary)}.installation-project-empty p{font-size:13px;line-height:1.8;max-width:280px}
      .installation-conversation-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 22px;font-size:12px;color:var(--dsw-alias-label-secondary);flex-shrink:0}.installation-conversation-header strong{font-weight:500;font-size:13px;color:var(--dsw-alias-label-primary);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
      .installation-project-switch{display:inline-flex;align-items:center;gap:7px;min-width:0;max-width:100%;padding:3px 0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}.installation-project-switch:hover{color:var(--dsw-alias-label-primary)}.installation-project-switch>span{flex-shrink:0;color:var(--dsw-alias-label-tertiary)}
      .installation-workspace-toggle{flex-shrink:0;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 10px;background:transparent;color:inherit;font:inherit;font-size:11px;cursor:pointer}.installation-workspace-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.installation-workspace-toggle.attention{border-color:color-mix(in srgb,#b17c2b 45%,transparent);color:#b17c2b}
      @keyframes installation-spin{to{transform:rotate(360deg)}}.installation-spin{animation:installation-spin .9s linear infinite}
      .installation-card{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:12px;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-bg-base) 94%,var(--dsw-alias-label-primary))}
      .installation-card header{display:flex;align-items:center;gap:7px;font-weight:500;font-size:12px;color:var(--dsw-alias-label-primary)}.installation-card header svg{flex-shrink:0;opacity:.75}
      .installation-card-lead{margin-top:7px;line-height:1.7;color:var(--dsw-alias-label-primary)}
      .installation-card-note{margin-top:5px;line-height:1.7;font-size:11px;color:var(--dsw-alias-label-tertiary)}
      .installation-card-note.clamp{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
      .installation-card-actions{display:flex;gap:8px;margin-top:10px}.installation-card-actions button{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:5px 10px;background:transparent;color:inherit;font:inherit;font-size:11px;cursor:pointer}.installation-card-actions button:hover{background:var(--dsw-alias-interactive-bg-hover)}.installation-card-actions button.primary{border-color:transparent;background:var(--dsw-alias-button-info-fill);color:#fff}.installation-card-actions button:disabled{opacity:.5;cursor:default}
      .installation-card-views{display:flex;flex-direction:column;gap:6px;margin-top:9px}.installation-card-views button{display:flex;align-items:center;gap:8px;width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:7px 10px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;text-align:left;cursor:pointer}.installation-card-views button:hover{background:var(--dsw-alias-interactive-bg-hover)}.installation-card-views button span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.installation-card-views button em{flex-shrink:0;font-style:normal;color:var(--dsw-alias-label-tertiary)}.installation-card-views button svg{flex-shrink:0;opacity:.6}
      .installation-card.warn{border-color:color-mix(in srgb,#b17c2b 45%,transparent)}.installation-card.warn header{color:#b17c2b}
      .installation-conversation{display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;position:relative;background:var(--dsw-alias-bg-base)}
      .installation-conversation [data-composer-seat]{margin-top:auto}
      .installation-start{max-width:640px;margin:0 auto 24px;padding:24px 8px;text-align:center;color:var(--dsw-alias-label-primary)}.installation-start h2{font-size:22px;font-weight:500;line-height:1.5;margin:0 0 12px}.installation-start p{font-size:13px;line-height:1.8;margin:0;color:var(--dsw-alias-label-tertiary)}.installation-start-actions{display:flex;justify-content:center;flex-wrap:wrap;gap:8px;margin-top:20px}.installation-start-actions button{border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:10px 14px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}.installation-start-actions button:hover{background:var(--dsw-alias-interactive-bg-hover)}.installation-start-actions button.primary{background:var(--dsw-alias-button-info-fill);color:white;border-color:transparent}.installation-start-actions button:disabled{opacity:.5;cursor:default}
      .installation-projects{padding:12px 12px 20px;font-size:13px;color:var(--dsw-alias-label-primary)}
      .installation-project-label{display:flex;justify-content:space-between;color:var(--dsw-alias-label-tertiary);font-size:11px;margin:12px 8px}
      .installation-projects input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:transparent;border-radius:6px;padding:8px 10px;font:inherit;font-size:12px;margin-bottom:12px;color:inherit}
      .installation-projects>button{display:flex;gap:10px;align-items:flex-start;width:100%;padding:12px 9px;border:0;border-radius:7px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit;margin-bottom:3px}
      .installation-projects>button:hover,.installation-projects>button.active{background:var(--dsw-alias-interactive-bg-hover)}
      .installation-projects>button svg{margin-top:2px;flex-shrink:0;opacity:.6}.installation-projects small{display:block;font-size:10px;color:var(--dsw-alias-label-tertiary);margin-top:6px}.installation-projects span{min-width:0;overflow-wrap:anywhere}
      .installation-error{font-size:12px;color:#aa4f49;margin:12px 8px}.installation-rail{border:0;background:transparent;color:inherit;margin:16px;cursor:pointer}
      .installation-context{padding:8px 4px;color:var(--dsw-alias-label-secondary);font-size:12px}
      .installation-card details{margin-top:8px}.installation-card summary{cursor:pointer;font-size:11px;color:var(--dsw-alias-label-secondary)}.installation-card-actions{flex-wrap:wrap}.installation-conversation-header>div{display:flex;align-items:center;gap:12px;min-width:0}.installation-conversation-header small{font-size:11px;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}.installation-list-empty{padding:12px 8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}.installation-projects>button.active{box-shadow:inset 2px 0 var(--dsw-alias-button-info-fill)}
      .installation-quick-tasks{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.installation-quick-tasks button{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 9px;background:transparent;color:inherit;font:inherit;font-size:11px;cursor:pointer}.installation-quick-tasks button:hover{background:var(--dsw-alias-interactive-bg-hover)}.installation-quick-tasks button:disabled{opacity:.5;cursor:default}.installation-quick-tasks button.attention{border-color:color-mix(in srgb,#b17c2b 45%,transparent);color:#b17c2b}
      .installation-hero-hint{font-size:12px;color:var(--dsw-alias-label-tertiary)}.installation-context.muted{color:var(--dsw-alias-label-tertiary)}
      .installation-conversation-header{min-height:52px;border-bottom:1px solid var(--dsw-alias-border-l2);padding:10px 18px;flex-wrap:wrap}.installation-conversation-header>div{flex:1;flex-wrap:wrap;gap:4px 12px}.installation-workspace-toggle{max-width:55%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;border:0;font-size:12px}
      .installation-context{padding:4px 0}.installation-card{background:transparent;border:0;border-left:2px solid var(--dsw-alias-border-l2);border-radius:0;padding:2px 12px;margin-bottom:8px}.installation-card.warn{border-left-color:#b17c2b}.installation-card-lead{margin-top:4px}.installation-card-actions{margin-top:7px}.installation-card-actions button{display:inline-flex;align-items:center;gap:6px}.installation-card-views{gap:2px;max-height:160px;overflow:auto;margin-top:6px}.installation-card-views button{padding:6px 0;border:0;border-radius:0}.installation-card-views button:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .installation-quick-tasks{align-items:center;gap:16px;margin-top:6px}.installation-quick-tasks span{font-size:11px;color:var(--dsw-alias-label-tertiary)}.installation-quick-tasks button{border:0;padding:6px 0;font-size:12px}.installation-error{margin:6px 0}
      .installation-conversation-header strong{display:block;min-width:0;max-width:100%}.installation-card-lead,.installation-card-note,.installation-error{overflow-wrap:anywhere}.installation-projects button:disabled{opacity:.55;cursor:default}.installation-error{color:light-dark(#a44742,#f0aaa4)}
      .installation-sidebar button:focus-visible,.installation-conversation button:focus-visible,.installation-context button:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill);outline-offset:2px}.installation-projects input:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill);outline-offset:1px}
      @media(max-width:520px){.installation-conversation-header{padding:10px 12px}.installation-workspace-toggle{max-width:100%}.installation-card-views button{flex-wrap:wrap}.installation-card-views button em{margin-left:22px}.installation-start h2{font-size:19px}.installation-start-actions{gap:6px}.installation-start-actions button{padding:9px 10px}}
      @media(max-height:600px){.installation-start{margin-bottom:8px;padding:8px}.installation-start h2{font-size:18px;margin-bottom:6px}.installation-start-actions{margin-top:12px}}
      @media(prefers-reduced-motion:reduce){.installation-spin{animation:none}.installation-sidebar *{transition:none}}
    `;
    document.head.append(style);
    return () => style.remove();
  });
}
