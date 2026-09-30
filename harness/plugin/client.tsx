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
import { confirmRun, fetchActivity, streamRun, uploadProjectFile, type ProjectActivity } from "./activity";

export const inject = ["slots", "layout", "sessions", "uiWorkspace", "conversation", "theme", "sidebarRightTabs", "sidebarRight"];
declare module "@deepseek-ai/dsh-api-session-controller/client" {
  interface SessionReferenceSourceMap { installationPanel: unknown }
}
type Project = { id: string; name: string; sessionId: string; files: number; rows: number };

/** 专业工作区在右侧面板里的 tab 类型：一个工程 = 一个会话 = 一个工作区 tab。 */
const WORKSPACE_KIND = "installation-workspace";
const WORKSPACE_ID = "@zaojia/installation-harness:workspace";

function Icon({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 21V4h11v17M15 9h5v12M8 8h3M8 12h3M8 16h3M2 21h20" /></svg>;
}

export function apply(ctx: Context) {
  const origin = "http://127.0.0.1:3211";
  // attention 只记录"哪个工程有待确认事项"，由用户决定何时看；它从不切换用户视图。
  const state = createSnapshotStore<{ projects: Project[]; activeId: string | null; attention: string | null; error: string | null; opening: string | null; activity: ProjectActivity | null }>({ projects: [], activeId: null, attention: null, error: null, opening: null, activity: null });
  const useProjects = () => useSyncExternalStore(state.subscribe, state.getSnapshot);
  const frames = new Map<Window, "home" | "data" | "workspace">();
  const projectFrames = new Map<string, Window>();
  const readyFrames = new Set<Window>();
  const runningProjects = new Map<string, boolean>();

  /** 卡片状态：Agent 一轮结束、导入结束、确认后都刷新一次；不轮询。 */
  const refreshActivity = async (projectId: string) => {
    const activity = await fetchActivity(origin, projectId);
    if (!activity || state.getSnapshot().activeId !== projectId) return;
    state.update(s => {
      s.activity = activity;
      // 待确认优先于面板的临时上报：面板没打开时也要能提示
      s.attention = activity.confirm ? projectId : (s.attention === projectId ? null : s.attention);
    });
  };

  const openWorkspace = () => ctx.sidebarRight.openTab(WORKSPACE_KIND);
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
        state.update(s => { s.activeId = project.id; s.activity = null; });
        localStorage.setItem("installation:activeProject", project.id);
        ctx.uiWorkspace.openSession(sessionId);
        ctx.layout.selectPanel(null);
        // 不再强制收起右栏：每个会话自带布局，用户开过就保持开着。
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
      if (event.data?.type === "installation:catalog" && Array.isArray(event.data.projects)) {
        theme(source);
        state.update(s => { s.projects = event.data.projects; });
        const target = frames.get(source) === "home" ? event.data.projectId : undefined;
        const restore = restoring ? localStorage.getItem("installation:activeProject") : null;
        const shouldRestore = restoring;
        restoring = false;
        const project = state.getSnapshot().projects.find(p => p.id === (target ?? restore));
        if (project && (shouldRestore || (target && state.getSnapshot().activeId !== project.id))) await openProject(project, source);
        return;
      }
      // 工作区就绪后才投递"点卡片要定位到哪"的目标，否则目标视图尚未重放出来。
      if (event.data?.type === "installation:ready") {
        if (projectFrames.get(event.data.projectId) !== source) return;
        readyFrames.add(source);
        taskState(event.data.projectId, runningProjects.get(event.data.projectId) ?? false);
        deliverFocus();
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
    const filtered = s.projects.filter(p => p.name.toLowerCase().includes(query.trim().toLowerCase()));
    return <div className="installation-projects"><div className="installation-project-label">我的工程 <span>{s.projects.length}</span></div><input aria-label="搜索工程" placeholder="搜索工程…" value={query} onChange={e => setQuery(e.target.value)} />{filtered.map(p => <button key={p.id} aria-current={s.activeId === p.id ? "page" : undefined} className={s.activeId === p.id ? "active" : ""} disabled={!!s.opening} onClick={() => void openProject(p)}><Icon size={16} /><span>{p.name}<small>{s.opening === p.id ? "正在打开…" : `${p.files} 份资料 · ${p.rows} 行清单`}</small></span></button>)}{!filtered.length && <p className="installation-list-empty">{query.trim() ? "没有匹配的工程" : "新建工程，开始导入资料"}</p>}{s.error && <p role="alert" className="installation-error">{s.error}</p>}</div>;
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
      };
    }, [projectId]);
    if (!project) return <div className="installation-project-empty"><Icon size={26} /><h2>先选择一个工程</h2><p>工作区跟随当前会话所属的工程。</p></div>;
    return <iframe ref={ref} src={`${origin}/p/${encodeURIComponent(project.id)}?embedded=1&harnessOrigin=${encodeURIComponent(location.origin)}`} title={`${project.name} · 造价数据`} onLoad={() => { if (ref.current?.contentWindow) theme(ref.current.contentWindow); }} style={{ width: "100%", height: "100%", border: 0, display: "block", background: "var(--dsw-alias-bg-base)" }} />;
  }
  ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: WORKSPACE_ID }, ProjectPane)), "installation: workspace tab body");

  // 造价产品没有"工作区（文件夹）"这个概念，Harness 对空白会话的工作区门禁在此不适用。
  // 这个适配层只做两件事：一条极薄的工程 header，加上把原生对话固定为 active 相位。
  // 没有第二套导航、没有 chat/data 互斥、没有 iframe。
  function CostConversation({ sessionId, useSession, renderFactorySlot }: PropsRuntime<"main.conversation"> & PropsRenderFactories) {
    const session = useSession(s => s);
    const s = useProjects();
    const project = s.projects.find(p => p.sessionId === sessionId);
    const projectId = project?.id;
    const running = session?.running ?? false;
    // 一轮结束刷新卡片：工具产出的视图此时已经落库，不需要轮询
    useEffect(() => {
      if (!projectId) return;
      taskState(projectId, running);
      if (running) return;
      void refreshActivity(projectId);
      refreshFrames(projectId);
    }, [projectId, running]);
    if (!project) return <div className="installation-project-empty"><Icon size={28} /><h2>先新建或选择工程</h2><p>每个工程都有独立的 Agent 对话、资料和计价记录。</p><button className="installation-create" onClick={createPanel}>＋ 新建工程</button></div>;
    const attention = s.attention === project.id;
    // 卡片已经占住对话下方的位置时不再叠欢迎语：它不是"空会话"了，硬叠加还会压住输入框
    const activity = s.activity;
    const hasCard = !!activity && (!!activity.confirm || !!activity.import || !!activity.result?.views.length);
    return <div className="installation-conversation">
      <header className="installation-conversation-header"><div><strong title={project.name}>{project.name}</strong><small>{running ? "助手正在处理" : "工程对话"}</small></div><button className={`installation-workspace-toggle${attention ? " attention" : ""}`} onClick={openWorkspace} title="打开造价工作区">{attention ? "核对导入" : "打开工作区"}</button></header>
      {session?.blank && !hasCard && <div className="installation-welcome"><Icon size={28} /><h2>开始这份工程的造价工作</h2><p>把清单或询价表拖进来，或直接说要核对什么。<br />结果会显示在右侧的造价工作区里。</p></div>}
      {renderFactorySlot("conversation.content", { variant: "embedded", phase: session?.openState === "loading" ? "settling" : "active", hero: false })}
    </div>;
  }
  ctx.slots.inject("main.conversation", () => ctx.slots.register({ name: "main.conversation", priority: -100 }, CostConversation));

  /**
   * 对话下方的操作卡区。
   *
   * 导入直接写业务接口，不再先把右侧面板顶开——绝大多数时候用户不该看到映射页面，
   * 只有低置信度时才由卡片给出「检查映射」这一个出口。Agent 结果同样在这里变成可点的入口。
   */
  function ProjectContext({ sessionId }: PropsRuntime<"conversation.input.dock">) {
    const s = useProjects();
    const project = s.projects.find(p => p.sessionId === sessionId);
    const fileRef = useRef<HTMLInputElement>(null);
    const [importing, setImporting] = useState(false);
    const [importingFile, setImportingFile] = useState("");
    const [progress, setProgress] = useState("");
    const [error, setError] = useState("");
    const projectId = project?.id;

    useEffect(() => {
      setImporting(false); setImportingFile(""); setProgress(""); setError("");
    }, [projectId]);

    const upload = async (files: File[]) => {
      if (!projectId || !files.length || importing) return;
      setImporting(true); setError("");
      try {
        for (const file of files) {
          setImportingFile(file.name); setProgress(`正在上传「${file.name}」`);
          const outcome = await uploadProjectFile(origin, projectId, file);
          if (outcome.kind === "error") { setError(outcome.message); continue; }
          if (outcome.kind === "duplicate") { setProgress(`「${outcome.filename}」与已导入文件内容相同，已跳过`); continue; }
          setProgress("正在识别表格结构…");
          let awaitingConfirm = false;
          await streamRun(origin, outcome.runId, event => {
            const payload = event.payload;
            if (event.type === "tool_started") {
              const tool = String(payload.tool ?? "");
              setProgress(tool === "file.inspect" ? "正在识别表格结构…" : tool === "file.ingest" ? "正在导入数据…" : "正在汇总项目…");
            } else if (event.type === "activity" || event.type === "activity_live") {
              setProgress(String(payload.text ?? "正在处理…"));
            } else if (event.type === "confirm_request") {
              awaitingConfirm = true;
              setProgress("有列映射需要你确认");
            } else if (event.type === "error") {
              setError(String(payload.text ?? "导入失败"));
            }
          }, () => awaitingConfirm);
          await refreshActivity(projectId);
          refreshFrames(projectId);
        }
      } catch (error) {
        setError(error instanceof Error ? error.message : "导入失败，请重试");
        await refreshActivity(projectId);
      } finally {
        setImporting(false); setImportingFile(""); setProgress("");
      }
    };

    if (!project) return <div className="installation-context muted">选择工程后，对话将自动使用该工程的资料和计价条件。</div>;

    const handlers = {
      onReviewMapping: () => { if (projectId) focusProject(projectId, { viewId: s.activity?.import?.mappingViewId ?? "view:files" }); },
      onConfirm: async (approve: boolean) => {
        const runId = s.activity?.confirm?.runId;
        if (!runId || !projectId) return;
        const outcome = await confirmRun(origin, runId, approve);
        if (!outcome.ok) { setError(outcome.message ?? "操作失败"); return; }
        await refreshActivity(projectId);
        refreshFrames(projectId);
        if (!approve) return;
        // 批准后 run 继续跑：接着把"正在导入"跟到底，否则确认一下就没有下文了
        setImporting(true); setProgress("正在导入数据…");
        try {
          await streamRun(origin, runId, event => {
            const payload = event.payload;
            if (event.type === "tool_started") setProgress(String(payload.tool ?? "").startsWith("file.ingest") ? "正在导入数据…" : "正在汇总项目…");
            else if (event.type === "error") setError(String(payload.text ?? "导入失败"));
          });
          await refreshActivity(projectId);
          refreshFrames(projectId);
        } catch (error) {
          setError(error instanceof Error ? error.message : "导入失败，请重试");
          await refreshActivity(projectId);
        } finally {
          setImporting(false); setProgress(""); setImportingFile("");
        }
      },
      onFocusView: (viewId: string) => { if (projectId) focusProject(projectId, { viewId }); },
      onSend: (text: string) => { void ctx.sessions.scope(sessionId)!.conversation.send(text).catch(error => setError(error instanceof Error ? error.message : "任务发送失败")); },
    };

    return <div className="installation-context">
      <input ref={fileRef} type="file" accept=".xls,.xlsx,.csv,.pdf" multiple hidden onChange={e => { void upload(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
      <ActivityCards activity={s.activity} importing={importing} importingFile={importingFile} progress={progress} handlers={handlers} />
      <div className="installation-quick-tasks"><button disabled={importing} onClick={() => fileRef.current?.click()}>{importing ? "正在导入…" : `导入资料 · 已有 ${project.files} 份`}</button></div>
      {error && <p role="alert" className="installation-error">{error}</p>}
    </div>;
  }
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({ name: "conversation.input.dock", id: "installation-context", order: -100 }, ProjectContext));
  ctx.slots.inject("conversation.hero.workspace", () => ctx.slots.register({ name: "conversation.hero.workspace", priority: -100 }, () => <span className="installation-hero-hint">安装工程 · 清单接入 / 定额组价 / 造价审核</span>));
  ctx.effect(() => {
    const style = document.createElement("style");
    style.textContent = `
      .installation-sidebar{display:flex;flex-direction:column;height:100%;box-sizing:border-box;padding:12px;background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-primary);font-size:13px}.installation-sidebar-brand{display:flex;align-items:center;justify-content:space-between;min-height:46px;margin-bottom:12px}.installation-sidebar-brand button{display:flex;align-items:center;gap:9px;background:none;border:0;color:inherit;cursor:pointer;padding:6px}.installation-sidebar-brand strong{font-size:17px;font-weight:600}.installation-sidebar-brand>button:last-child{font-size:24px;color:var(--dsw-alias-label-tertiary)}.installation-sidebar-list{flex:1;min-height:0;overflow-y:auto}.installation-sidebar .installation-projects{padding:6px 0 20px}.installation-create{display:flex;align-items:center;justify-content:center;gap:7px;min-height:38px;padding:8px 12px;border:0;border-radius:6px;color:white;background:var(--dsw-alias-button-info-fill);font:inherit;font-size:13px;cursor:pointer;margin-bottom:12px}.installation-create span{font-size:18px;line-height:1}.installation-library{display:flex;align-items:center;gap:9px;padding:12px 8px;border:0;border-radius:6px;background:none;color:inherit;font:inherit;cursor:pointer}.installation-library:hover{background:var(--dsw-alias-interactive-bg-hover)}.installation-sidebar.rail{padding:12px 8px}.installation-sidebar.rail .installation-sidebar-brand{justify-content:center}.installation-sidebar.rail .installation-create{padding:8px}.installation-sidebar.rail .installation-rail{margin:16px 10px}.installation-sidebar.rail .installation-library{justify-content:center;padding-inline:0}.installation-project-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:18px;padding:28px;color:var(--dsw-alias-label-tertiary);text-align:center}.installation-project-empty h2{font-size:20px;font-weight:500;color:var(--dsw-alias-label-primary)}.installation-project-empty p{font-size:13px;line-height:1.8;max-width:280px}
      .installation-conversation-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 22px;font-size:12px;color:var(--dsw-alias-label-secondary);flex-shrink:0}.installation-conversation-header strong{font-weight:500;font-size:13px;color:var(--dsw-alias-label-primary);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
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
      .installation-welcome{position:absolute;top:26%;left:28px;right:28px;text-align:center;pointer-events:none;color:var(--dsw-alias-label-tertiary)}.installation-welcome svg{margin:0 auto 18px;opacity:.55}.installation-welcome h2{font-size:20px;font-weight:500;line-height:1.6;color:var(--dsw-alias-label-primary);margin:0 0 12px}.installation-welcome p{font-size:12px;line-height:1.8;margin:0;max-width:340px;margin-inline:auto}
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
    `;
    document.head.append(style);
    return () => style.remove();
  });
}
