import { describe, expect, it } from "vitest";
import type { AgentEventDTO } from "@shared/types";
import { reduceEvent, replayRuns, type RunState } from "../src/ui/runEvents";

const empty = (): RunState => ({ blocks: [], views: [], receipts: [], activeViewId: "view:boq", lastViewEvent: null, modelDown: null });
const ev = (seq: number, type: string, payload: Record<string, unknown>) => ({ seq, type, payload }) as AgentEventDTO;
const fold = (events: AgentEventDTO[], s = empty()) => events.reduce((acc, e) => ({ ...acc, ...reduceEvent(acc, e, "r1") }), s);

describe("Agent 事件归约", () => {
  it("流式思考同一 streamId 原位更新，最终答复到达后移除预览", () => {
    const s = fold([
      ev(0, "thought_delta", { text: "正在" }),
      ev(1, "thought_delta", { text: "正在分析" }),
      ev(2, "message", { text: "完成" }),
    ]);
    expect(s.blocks).toEqual([{ type: "agent", text: "完成", runId: "r1" }]);
  });

  it("工具结束更新对应的运行中块", () => {
    const s = fold([ev(0, "tool_started", { tool: "boq.read" }), ev(1, "tool_finished", { tool: "boq.read", status: "OK", ms: 1200 })]);
    expect(s.blocks).toEqual([expect.objectContaining({ type: "tool", status: "OK", ms: 1200 })]);
  });

  it("成果视图入列并在对话中留一张卡片；不抢用户当前页面", () => {
    const view = { kind: "feeSummary", id: "fee", title: "费用汇总表" };
    const s = fold([ev(0, "workspace_patch", { view }), ev(1, "workspace_patch", { view })]);
    expect(s.views).toHaveLength(1);
    expect(s.blocks.filter((b) => b.type === "view")).toHaveLength(1);
    expect(s.activeViewId).toBe("view:boq");
  });

  it("列映射等流程视图不出卡片，也不补位当前页面", () => {
    const s = fold([ev(0, "workspace_patch", { view: { kind: "columnMapping", id: "view:mapping:f", fileId: "f", filename: "a.xlsx", sheets: [] } })], { ...empty(), activeViewId: "empty:results" });
    expect(s.blocks).toHaveLength(0);
    expect(s.activeViewId).toBe("empty:results");
  });

  it("确认请求去重，决议后标记结果", () => {
    const s = fold([
      ev(0, "confirm_request", { confirmId: "c", tool: "boq.update", description: "改 2 项" }),
      ev(1, "confirm_request", { confirmId: "c", tool: "boq.update", description: "改 2 项" }),
      ev(2, "confirm_resolved", { confirmId: "c", approved: true }),
    ]);
    expect(s.blocks).toEqual([expect.objectContaining({ type: "confirm", decided: "approved" })]);
  });

  it("模型降级标记在下一轮模型产出思考时解除", () => {
    const s = fold([
      ev(0, "model_fallback", { reason: "402" }),
      ev(1, "thought", { text: "我来分析" }),
    ]);
    expect(s.modelDown).toBeNull();
    const s2 = fold([ev(0, "model_fallback", { reason: "402" })]);
    expect(s2.modelDown).toBe("402");
  });
});

describe("历史回放", () => {
  it("导入任务显示为上传块，结束的任务不再保留可批准的确认", () => {
    const { blocks } = replayRuns([{
      id: "r1", userMessage: "分析并导入文件「清单.xlsx」", status: "FAILED",
      events: [ev(0, "activity", { text: "正在分析" }), ev(1, "confirm_request", { confirmId: "c", tool: "file.ingest", description: "核对", args: { fileId: "f" } })],
    }]);
    expect(blocks[0]).toEqual({ type: "upload", filename: "清单.xlsx", runId: "r1" });
    expect(blocks.find((b) => b.type === "activity")).toMatchObject({ live: false });
    expect(blocks.find((b) => b.type === "confirm")).toMatchObject({ decided: "rejected", fileId: "f" });
  });

  it("已下线的旧会话只保留结果视图，不回放成对话", () => {
    const { blocks, views } = replayRuns([{
      id: "old", userMessage: "Harness: 汇总", status: "DONE", legacy: true,
      events: [ev(0, "message", { text: "旧消息" }), ev(1, "workspace_patch", { view: { kind: "feeSummary", id: "fee", title: "费用汇总表" } })],
    }]);
    expect(blocks).toHaveLength(0);
    expect(views.map((v) => v.id)).toEqual(["fee"]);
  });
});
