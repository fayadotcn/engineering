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
