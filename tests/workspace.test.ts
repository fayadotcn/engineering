import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/ui/primitives", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
import { useStore } from "../src/ui/store";

function fixture() {
  let seq = 1;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    json: async () => url.endsWith("/runs")
      ? [{ id: "run-1", userMessage: "查看清单", events: [{ seq, type: "workspace_patch", payload: { view: { kind: "boqTable", id: "result", title: "清单结果" } } }] }]
      : url.endsWith("/boq") ? [] : url.endsWith("/summary") ? {} : { name: "工程", files: [], facts: [], receipts: [] },
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
  it("没有新结果时，轮询保留用户正在看的页面", async () => {
    fixture(); await useStore.getState().init("project-1");
    useStore.getState().setActiveView("view:receipts");
    await useStore.getState().init("project-1", true);
    expect(useStore.getState().activeViewId).toBe("view:receipts");
  });
  it("同一结果更新后自动展示，后续轮询不反复抢走页面", async () => {
    const data = fixture(); await useStore.getState().init("project-1");
    data.next(); await useStore.getState().init("project-1", true);
    expect(useStore.getState().activeViewId).toBe("result");
    useStore.getState().setActiveView("view:receipts");
    await useStore.getState().init("project-1", true);
    expect(useStore.getState().activeViewId).toBe("view:receipts");
  });
  it("已经通过导入事件展示的结果，轮询不会再次跳转", async () => {
    const data = fixture(); await useStore.getState().init("project-1");
    data.next(); useStore.getState().handleEvent({ seq: 2, type: "workspace_patch", payload: { view: { kind: "boqTable", id: "result", title: "清单结果" } } }, "run-1");
    useStore.getState().setActiveView("view:receipts");
    await useStore.getState().init("project-1", true);
    expect(useStore.getState().activeViewId).toBe("view:receipts");
  });
});
