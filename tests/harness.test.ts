import { beforeEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";

const mocks = vi.hoisted(() => ({
  project: vi.fn(), file: vi.fn(), run: vi.fn(), update: vi.fn(), emit: vi.fn(), execute: vi.fn(), approval: vi.fn(),
}));
vi.mock("@database/client", () => ({ prisma: { project: { findUnique: mocks.project, findFirst: mocks.project }, projectFile: { findFirst: mocks.file }, agentRun: { create: mocks.run, update: mocks.update } } }));
vi.mock("@agent/events", () => ({ makeEmitter: () => mocks.emit }));
vi.mock("@agent/executor", () => ({ executeTool: mocks.execute }));
import "@agent/tools";
import { apply } from "../harness/plugin/host";

const tools = new Map<string, ToolDefinition>();
const ctx = { on: vi.fn(), tools: { register: (def: ToolDefinition) => tools.set(def.name, def) }, approval: { request: mocks.approval } } as unknown as Context;
const execution = (name: string, signal = new AbortController().signal) => ({ name, callId: "test", agent: {}, signal, deferContext: vi.fn(), concludeTurn: vi.fn() } as unknown as ToolRunContext);
const call = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => tools.get(name)!.execute(args, execution(name, signal));

beforeEach(() => {
  vi.resetAllMocks(); tools.clear();
  mocks.project.mockResolvedValue({ id: "p1" }); mocks.file.mockResolvedValue({ id: "f1" });
  mocks.run.mockResolvedValue({ id: "r1" }); mocks.update.mockResolvedValue({}); mocks.emit.mockResolvedValue(undefined);
  mocks.execute.mockResolvedValue({ observation: { count: 2 }, message: "已读取清单", views: [{ id: "view:boq", kind: "boqTable", title: "工程量清单" }] });
  mocks.approval.mockResolvedValue("allowed-once");
  apply(ctx, { businessUrl: "http://127.0.0.1:3211" });
});

describe("Harness 安装造价插件", () => {
  it("项目上下文按会话绑定，用户无需在对话里填写项目 ID", async () => {
    const root = new Context();
    await root.plugin(SystemPrompt);
    await root.plugin(ToolRuntime, { mode: "native" });
    try {
      apply(root, { businessUrl: "http://127.0.0.1:3211" });
      const agent = { id: "session-cost" } as never;
      const assembly = await root.systemPrompt.assemble({ agent, scope: agent });
      expect(mocks.project).toHaveBeenCalledWith(expect.objectContaining({ where: { harnessSessionId: "session-cost" } }));
      expect(assembly.sections.find(s => s.name === "installation:project")?.text).toContain('"id":"p1"');
    } finally { await root.fiber.dispose(); }
  });
  it("通过官方原生工具运行时验证输出并交给模型", async () => {
    const root = new Context();
    await root.plugin(SystemPrompt);
    await root.plugin(ToolRuntime, { mode: "native" });
    try {
      apply(root, { businessUrl: "http://127.0.0.1:3211" });
      const result = await root.tools.execute({ name: "installation__boq__read", arguments: { projectId: "p1" }, callId: "test" as never, signal: new AbortController().signal });
      expect(result.isError).toBe(false);
      expect(result.content).toEqual([{ type: "text", text: expect.stringContaining('"count":2') }]);
    } finally { await root.fiber.dispose(); }
  });
  it("业务工具注册为原生工具，并要求明确项目 ID", () => {
    expect(tools.size).toBeGreaterThan(40);
    for (const [name, def] of tools) {
      if (["installation__listProjects", "installation__createProject"].includes(name)) continue;
      expect((def.parameters as { required: string[] }).required).toContain("projectId");
      expect(def.output.render).toBeTypeOf("function");
    }
  });
  it("读取工具通过现有执行器落库，并返回专业结果地址", async () => {
    const result = await call("installation__boq__read", { projectId: "p1" }) as { panelUrl: string };
    expect(result.panelUrl).toBe("http://127.0.0.1:3211/p/p1");
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", runId: "r1" }), "boq.read", {});
    expect(mocks.approval).not.toHaveBeenCalled();
  });
  it("用户拒绝写入时不执行工具、不创建成功记录", async () => {
    mocks.approval.mockResolvedValue("denied");
    await expect(call("installation__quota__applyCalc", { projectId: "p1" })).rejects.toThrow("用户未批准");
    expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
  });
  it("跨项目文件在确认门前被拒绝", async () => {
    mocks.file.mockResolvedValue(null);
    await expect(call("installation__file__ingest", { projectId: "p1", fileId: "other" })).rejects.toThrow("不属于");
    expect(mocks.approval).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("业务失败不会作为成功结果返回给模型", async () => {
    mocks.execute.mockResolvedValue({ observation: { error: "缺少工程量" } });
    await expect(call("installation__boq__read", { projectId: "p1" })).rejects.toThrow("缺少工程量");
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }));
  });
  it("已停止的调用不会进入业务执行器", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(call("installation__boq__read", { projectId: "p1" }, controller.signal)).rejects.toThrow();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
