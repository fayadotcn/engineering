import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof React>(),
  useEffect: (effect: () => void) => effect(),
  useRef: () => ({ current: null }),
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}));
const projectFixture = vi.hoisted(() => ({ rows: 0 }));
vi.mock("@deepseek-ai/dsh-client-store", () => ({ createSnapshotStore: (initial: object) => {
  const snapshot = { ...initial, activeId: "p1", projects: [{ id: "p1", sessionId: "s1", name: "工程", files: 0, rows: projectFixture.rows }] };
  return { subscribe: vi.fn(), getSnapshot: () => snapshot, update: (fn: (s: object) => void) => fn(snapshot) };
} }));
// 客户端 Cordis 使用独立类型环境；在测试运行时载入，避免混入服务端 Context。
const clientModule = "../harness/plugin/client";
const { apply } = await import(clientModule) as { apply: (ctx: Context) => void };

afterEach(() => vi.unstubAllGlobals());
function enter(existing: boolean, collapsed = true, activePanelId: string | null = null, expanded = false, rows = 0) {
  projectFixture.rows = rows;
  vi.stubGlobal("React", React);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
  const components = new Map<string, (props: unknown) => unknown>();
  const sidebarRight = { mounted: { getSnapshot: () => "s1" }, tabsIn: () => existing ? [{ id: "workspace", kind: "installation-workspace" }] : [], focus: vi.fn(), isExpanded: () => expanded, toggleExpanded: vi.fn(), openTab: vi.fn() };
  const layout = { selectPanel: vi.fn(), toggleSidebar: vi.fn(), panelInfo: { subscribe: vi.fn(), getSnapshot: () => ({ activePanelId }) } };
  const ctx = { effect: vi.fn(), on: vi.fn(),
    slots: { inject: (_: unknown, fn: () => void) => fn(), register: (meta: { name: string }, component: (props: unknown) => unknown) => { components.set(meta.name, component); return vi.fn(); } },
    layout, sidebarRight,
  } as unknown as Context;
  apply(ctx);
  components.get("sidebar")!({ collapsed, renderSlot: () => null });
  const conversation = components.get("main.conversation")!({ sessionId: "s1", useSession: () => ({ running: false, blank: false }), renderFactorySlot: () => null }) as React.ReactElement<{ children: React.ReactElement[] }>;
  const header = conversation.props.children[0] as React.ReactElement<{ children: React.ReactElement[] }>;
  const button = header.props.children[1] as React.ReactElement<{ onClick: () => void }>;
  const start = components.get("conversation.input.dock")!({ sessionId: "s1", useSession: (selector: (s: object) => unknown) => selector({ running: false, blank: true }) }) as React.ReactElement;
  return { ...sidebarRight, collapseNavigation: layout.toggleSidebar, viewBoq: button.props.onClick, start };
}

it("进入工程先显示对话，用户查看清单时才创建工作区", () => {
  const panel = enter(false);
  expect(panel.openTab).not.toHaveBeenCalled();
  expect(panel.toggleExpanded).not.toHaveBeenCalled();
  panel.viewBoq();
  expect(panel.openTab).toHaveBeenCalledWith("installation-workspace");
});

it("已有工作区时恢复原面板，不在分屏或浮动布局中重复创建", () => {
  const panel = enter(true);
  expect(panel.focus).not.toHaveBeenCalled();
  panel.viewBoq();
  expect(panel.focus).toHaveBeenCalledWith("workspace");
  expect(panel.toggleExpanded).toHaveBeenCalledOnce();
  expect(panel.openTab).not.toHaveBeenCalled();
});

it("进入工程收起已展开的数据面板，保留原有工作区供再次打开", () => {
  const panel = enter(true, true, null, true);
  expect(panel.toggleExpanded).toHaveBeenCalledOnce();
  expect(panel.openTab).not.toHaveBeenCalled();
  expect(panel.focus).not.toHaveBeenCalled();
});

it("进入工程收起工程列表，让对话和工作区占据主要宽度", () => {
  expect(enter(true, false).collapseNavigation).toHaveBeenCalledOnce();
  expect(enter(true, true).collapseNavigation).not.toHaveBeenCalled();
});

it("工程目录和资料库页面保留展开的工程列表", () => {
  expect(enter(true, false, "installation").collapseNavigation).not.toHaveBeenCalled();
});

it("空工程在输入框前提供导入起点，已有清单提供三个具体任务", () => {
  const empty = renderToStaticMarkup(enter(false).start);
  expect(empty).toContain("上传清单，开始造价");
  expect(empty).toContain("导入工程资料");
  expect(empty).not.toContain("添加资料");
  const withBoq = renderToStaticMarkup(enter(false, true, null, false, 20).start);
  expect(withBoq).toContain("帮我测算报价");
  expect(withBoq).toContain("检查清单问题");
  expect(withBoq).toContain("汇总工程费用");
});
