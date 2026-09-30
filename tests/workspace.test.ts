import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/ui/primitives", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
import { useStore } from "../src/ui/store";

function fixture(items: unknown[] = []) {
  let seq = 1;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    json: async () => url.endsWith("/runs")
      ? [{ id: "run-1", userMessage: "查看清单", events: [{ seq, type: "workspace_patch", payload: { view: { kind: "boqTable", id: "result", title: "清单结果" } } }] }]
      : url.endsWith("/boq") ? items : url.endsWith("/summary") ? {} : { name: "工程", files: [], facts: [], receipts: [] },
  })));
  return { next: () => { seq++; } };
}

afterEach(() => vi.unstubAllGlobals());

describe("专业结果与工程对话联动", () => {
  it("打开工程先展示总览，历史结果仍可查看", async () => {
    fixture(); await useStore.getState().init("project-1");
    expect(useStore.getState().activeViewId).toBe("view:overview");
    expect(useStore.getState().views.some(v => v.id === "result")).toBe(true);
  });

  it("常驻对象视图始终在列：总览、项目文件、项目事实台账", async () => {
    fixture(); await useStore.getState().init("project-1");
    const ids = useStore.getState().views.map(v => v.id);
    expect(ids).toContain("view:overview");
    expect(ids).toContain("view:files");
    expect(ids).toContain("view:facts");
    expect(ids).toContain("view:receipts");
  });

  it("Agent 推送的对象视图与常驻视图同 id，不会出现两个重复标签", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith("/runs")
        ? [{
            id: "run-1", userMessage: "读取项目",
            events: [{ seq: 1, type: "workspace_patch", payload: { view: { kind: "fileList", id: "view:files", title: "项目文件" } } },
                     { seq: 2, type: "workspace_patch", payload: { view: { kind: "factList", id: "view:facts", title: "项目事实台账", facts: [] } } }],
          }]
        : url.endsWith("/boq") ? [] : url.endsWith("/summary") ? {} : { name: "工程", files: [], facts: [], receipts: [] },
    })));
    await useStore.getState().init("project-1");
    const ids = useStore.getState().views.map(v => v.id);
    expect(ids.filter(id => id === "view:files")).toHaveLength(1);
    expect(ids.filter(id => id === "view:facts")).toHaveLength(1);
  });

  it("没有新结果时，轮询保留用户正在看的页面", async () => {
    fixture(); await useStore.getState().init("project-1");
    useStore.getState().setActiveView("view:receipts");
    await useStore.getState().init("project-1", true);
    expect(useStore.getState().activeViewId).toBe("view:receipts");
  });

  it("尚无成果时选中的成果入口不会被刷新拉回总览", async () => {
    fixture(); await useStore.getState().init("project-1");
    useStore.getState().setActiveView("empty:results");
    await useStore.getState().init("project-1", true);
    expect(useStore.getState().activeViewId).toBe("empty:results");
  });

  it("关闭的临时结果不被刷新重新打开，常驻清单不可关闭", async () => {
    fixture(); await useStore.getState().init("project-1");
    useStore.getState().closeView("result");
    useStore.getState().closeView("view:boq");
    await useStore.getState().init("project-1", true);
    expect(useStore.getState().views.some(v => v.id === "result")).toBe(false);
    expect(useStore.getState().views.some(v => v.id === "view:boq")).toBe(true);
  });

  it("刷新读取期间的导航仍以用户最新选择为准", async () => {
    fixture(); await useStore.getState().init("project-1");
    const loading = useStore.getState().init("project-1", true);
    useStore.getState().setActiveView("view:facts");
    await loading;
    expect(useStore.getState().activeViewId).toBe("view:facts");
  });

  it("有未保存修改时导航先等待用户决定，不直接丢掉草稿", async () => {
    fixture(); await useStore.getState().init("project-1");
    useStore.getState().setActiveView("view:facts");
    useStore.setState({ settingsDirty: true });
    useStore.getState().setActiveView("view:boq");
    expect(useStore.getState().activeViewId).toBe("view:facts");
    expect(useStore.getState().pendingViewId).toBe("view:boq");
  });

  it("已结束任务中的未决确认不再作为可批准事项重放", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith("/runs") ? [{ id: "failed", status: "FAILED", userMessage: "导入", events: [{ type: "confirm_request", payload: { confirmId: "expired", tool: "file.ingest", description: "核对" } }] }] : url.endsWith("/boq") ? [] : { name: "工程" } })));
    await useStore.getState().init("project-1");
    expect(useStore.getState().blocks.find(b => b.type === "confirm")).toMatchObject({ decided: "rejected" });
  });

  it("导入遇到确认门停止收流，批准后重放旧确认不会再暂停", async () => {
    fixture(); await useStore.getState().init("project-1");
    const event = { seq: 1, type: "confirm_request", payload: { confirmId: "c1", tool: "file.ingest", description: "核对" } };
    const body = (events: unknown[]) => new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""))); } });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, body: body([event]) })));
    useStore.setState({ running: true });
    await useStore.getState().streamRun("import-1");
    expect(useStore.getState().running).toBe(false);
    expect(useStore.getState().blocks.filter(b => b.type === "confirm" && !b.decided)).toHaveLength(1);
    useStore.setState(s => ({ blocks: s.blocks.map(b => b.type === "confirm" ? { ...b, decided: "approved" as const } : b), running: true }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, body: body([event, { seq: 2, type: "run_finished", payload: { status: "DONE" } }]) })));
    await useStore.getState().streamRun("import-1");
    expect(useStore.getState().blocks.filter(b => b.type === "confirm" && !b.decided)).toHaveLength(0);
    expect(useStore.getState().running).toBe(false);
  });

  it("Agent 产出新结果不抢走用户正在看的页面，只把它排进结果列表", async () => {
    const data = fixture(); await useStore.getState().init("project-1");
    useStore.getState().setActiveView("view:receipts");
    data.next(); await useStore.getState().init("project-1", true);
    expect(useStore.getState().activeViewId).toBe("view:receipts");
    expect(useStore.getState().views.some(v => v.id === "result")).toBe(true);
  });

  it("实时事件同样不切换视图：结果只入列", async () => {
    fixture(); await useStore.getState().init("project-1");
    useStore.getState().setActiveView("view:receipts");
    useStore.getState().handleEvent({ seq: 99, type: "workspace_patch", payload: { view: { kind: "boqTable", id: "fresh", title: "新结果" } } }, "run-1");
    expect(useStore.getState().activeViewId).toBe("view:receipts");
    expect(useStore.getState().views.some(v => v.id === "fresh")).toBe(true);
  });

  it("当前没有任何打开的结果时，新结果才补位", async () => {
    fixture(); await useStore.getState().init("project-1");
    useStore.setState({ activeViewId: null });
    useStore.getState().handleEvent({ seq: 100, type: "workspace_patch", payload: { view: { kind: "boqTable", id: "fresh", title: "新结果" } } }, "run-1");
    expect(useStore.getState().activeViewId).toBe("fresh");
  });

  it("列映射这类流程中间的视图即使面板为空也不抢位", async () => {
    fixture(); await useStore.getState().init("project-1");
    useStore.setState({ activeViewId: null });
    useStore.getState().handleEvent({
      seq: 101,
      type: "workspace_patch",
      payload: { view: { kind: "columnMapping", id: "view:mapping:f1", title: "列映射：水电.xls", fileId: "f1", filename: "水电.xls", fileStatus: "PARSED", sheets: [] } },
    }, "run-1");
    expect(useStore.getState().activeViewId).toBeNull();
    expect(useStore.getState().views.some(v => v.id === "view:mapping:f1")).toBe(true);
  });

  it("已经通过导入事件展示的结果，轮询不会再次跳转", async () => {
    const data = fixture(); await useStore.getState().init("project-1");
    data.next(); useStore.getState().handleEvent({ seq: 2, type: "workspace_patch", payload: { view: { kind: "boqTable", id: "result", title: "清单结果" } } }, "run-1");
    useStore.getState().setActiveView("view:receipts");
    await useStore.getState().init("project-1", true);
    expect(useStore.getState().activeViewId).toBe("view:receipts");
  });
});
