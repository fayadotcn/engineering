import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const state = vi.hoisted(() => ({
  status: "RUNNING",
  pendingAction: "{}",
  events: [] as { type: string; payload: Record<string, unknown>; status: string }[],
  failPlan: false,
  confirm: false,
  failConfirmEvent: false,
  invalidArgs: false,
}));
vi.mock("@database/client", () => {
  const agentRun = {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async () => ({ id: "r1" })),
    updateMany: vi.fn(async () => ({ count: 0 })),
    update: vi.fn(async ({ data }) => {
      state.status = data.status;
      state.pendingAction = data.pendingAction ?? state.pendingAction;
      return {};
    }),
  };
  const tx = { agentRun, agentEvent: { aggregate: vi.fn(async () => ({ _max: { seq: 0 } })) } };
  return { prisma: { ...tx, $transaction: vi.fn(async (fn) => fn(tx)) } };
});
vi.mock("@agent/events", () => ({
  makeEmitter: () => async (type: string, payload: Record<string, unknown>) => {
    if (type === "confirm_request" && state.failConfirmEvent) throw new Error("事件落库失败");
    state.events.push({ type, payload, status: state.status });
  },
}));
vi.mock("@agent/context", () => ({ resolveContext: vi.fn(async () => ({ projectId: "p1" })) }));
vi.mock("@agent/llm", () => ({ modelConfig: () => null, runLLMLoop: vi.fn() }));
vi.mock("@agent/planner", () => ({
  RulePlanner: class {
    async plan() {
      if (state.failPlan) throw new Error("规划失败");
      return { steps: [{ tool: "test.write", args: state.invalidArgs ? {} : { value: "10" } }] };
    }
  },
}));
vi.mock("@agent/executor", () => ({ executeTool: vi.fn(async () => ({ observation: {}, message: "执行完成" })) }));
vi.mock("@agent/tools/registry", () => ({
  getTool: () => ({
    implemented: true,
    schema: z.object({ value: z.string() }),
    get confirm() { return state.confirm ? () => "写回价格" : undefined; },
  }),
}));
vi.mock("@agent/pending", () => ({
  waitForConfirm: vi.fn(async () => false),
  resolveConfirm: vi.fn(() => true),
}));

import { prisma } from "@database/client";
import { createAgentRun } from "@agent/runs";
import { startRun } from "@agent/runtime";
import { executeTool } from "@agent/executor";
import { resolveConfirm } from "@agent/pending";

const resetInitialization = () => {
  delete (globalThis as { __runInitialization?: Promise<void> }).__runInitialization;
};
beforeEach(() => {
  vi.clearAllMocks();
  resetInitialization();
  Object.assign(state, {
    status: "RUNNING", pendingAction: "{}", events: [], failPlan: false,
    confirm: false, failConfirmEvent: false, invalidArgs: false,
  });
});
afterEach(resetInitialization);

describe("任务启动与收口", () => {
  it("并发首次请求全部等待同一次启动清理，再创建任务", async () => {
    let release!: (value: { count: number }) => void;
    vi.mocked(prisma.agentRun.updateMany).mockImplementationOnce(() =>
      new Promise(resolve => { release = resolve; }) as never);
    const first = createAgentRun({ projectId: "p1", message: "x", planner: "rule" });
    const second = createAgentRun({ projectId: "p2", message: "y", planner: "rule" });
    expect(prisma.agentRun.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.agentRun.create).not.toHaveBeenCalled();
    release({ count: 0 });
    await Promise.all([first, second]);
    expect(prisma.agentRun.create).toHaveBeenCalledTimes(2);
  });

  it("启动清理失败不创建任务；下一次请求可以重试", async () => {
    vi.mocked(prisma.agentRun.updateMany).mockRejectedValueOnce(new Error("清理失败"));
    const input = { projectId: "p1", message: "x", planner: "rule" };
    await expect(createAgentRun(input)).rejects.toThrow("清理失败");
    expect(prisma.agentRun.create).not.toHaveBeenCalled();
    await createAgentRun(input);
    expect(prisma.agentRun.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.agentRun.create).toHaveBeenCalledTimes(1);
  });

  it.each(["DONE", "FAILED", "CANCELLED"])("收到 %s 结束事件时数据库已处于该终态", async (status) => {
    state.failPlan = status === "FAILED";
    state.confirm = status === "CANCELLED";
    await startRun({ projectId: "p1", message: "x" });
    await vi.waitFor(() => {
      expect(state.events.find(e => e.type === "run_finished")).toMatchObject({ payload: { status }, status });
    });
    expect(state.pendingAction).toBe("{}");
    if (status === "CANCELLED") expect(executeTool).not.toHaveBeenCalled();
  });

  it("确认事件写入失败会清理 resolver，业务工具未执行", async () => {
    state.confirm = true;
    state.failConfirmEvent = true;
    await startRun({ projectId: "p1", message: "x" });
    await vi.waitFor(() => expect(state.status).toBe("FAILED"));
    expect(resolveConfirm).toHaveBeenCalledWith("r1", false);
    expect(executeTool).not.toHaveBeenCalled();
    expect(state.pendingAction).toBe("{}");
  });

  it("无效工具参数交给执行器报错，不弹无意义确认", async () => {
    state.confirm = true;
    state.invalidArgs = true;
    await startRun({ projectId: "p1", message: "x" });
    await vi.waitFor(() => expect(state.status).toBe("DONE"));
    expect(state.events.some(e => e.type === "confirm_request")).toBe(false);
    expect(executeTool).toHaveBeenCalledOnce();
  });
});
