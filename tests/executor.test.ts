import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

// executeTool 行为测试：未知工具/参数校验/异常不拖垮 run、
// 回执先持久化再把 receiptId 挂到 diff 视图。

const db = vi.hoisted(() => ({ receipts: [] as Record<string, unknown>[] }));
vi.mock("@database/client", () => ({
  prisma: {
    toolCall: { create: vi.fn(async () => ({ id: "tc1" })) },
    actionReceipt: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        db.receipts.push(data);
        return { id: `rec${db.receipts.length}` };
      }),
    },
  },
}));

import { registerTool } from "../agent/tools/registry";
import { executeTool } from "../agent/executor";

const events: { type: string; payload: unknown }[] = [];
const ctx = {
  projectId: "p1", runId: "r1", userId: "u",
  emit: vi.fn(async (t: string, payload: unknown) => { events.push({ type: t, payload }); }),
};

registerTool({
  name: "test.echo",
  description: "t",
  implemented: true,
  schema: z.object({ v: z.string() }),
  handler: async (_c, a: { v: string }) => ({ observation: { got: a.v }, message: "ok" }),
});
registerTool({
  name: "test.boom",
  description: "t",
  implemented: true,
  schema: z.object({}),
  handler: async () => { throw new Error("炸了"); },
});
registerTool({
  name: "test.write",
  description: "t",
  implemented: true,
  schema: z.object({}),
  handler: async () => ({
    observation: { done: 1 },
    receipts: [{ actionType: "BOQ_UPDATE", summary: "改价", before: [{ id: "x" }], after: [{ id: "x", p: 2 }] }],
    views: [{ kind: "diff", id: "d1", title: "t", receiptId: "", rows: [] }],
  }),
});
registerTool({
  name: "test.todo",
  description: "t",
  implemented: false,
  schema: z.object({}),
});

const finished = () => events.filter((e) => e.type === "tool_finished").at(-1)!.payload as { status: string };

describe("executeTool", () => {
  it("未知工具 → ERROR 观察，不抛", async () => {
    const r = await executeTool(ctx as never, "no.such.tool", {});
    expect((r.observation as { error: string }).error).toContain("未知工具");
    expect(finished().status).toBe("ERROR");
  });
  it("未实现工具 → ERROR", async () => {
    const r = await executeTool(ctx as never, "test.todo", {});
    expect((r.observation as { error: string }).error).toContain("尚未实现");
  });
  it("参数校验失败 → ERROR，handler 不被调用", async () => {
    const r = await executeTool(ctx as never, "test.echo", { v: 123 });
    expect((r.observation as { error: string }).error).toContain("参数校验失败");
  });
  it("handler 抛异常 → 收成 ERROR 观察，run 不崩", async () => {
    const r = await executeTool(ctx as never, "test.boom", {});
    expect((r.observation as { error: string }).error).toBe("炸了");
    expect(finished().status).toBe("ERROR");
  });
  it("正常工具 → OK + 回执落库 + diff 视图挂 receiptId", async () => {
    events.length = 0; db.receipts.length = 0;
    const r = await executeTool(ctx as never, "test.write", {});
    expect(r.observation).toMatchObject({ done: 1 });
    expect(finished().status).toBe("OK");
    expect(db.receipts.length).toBe(1);
    expect(events.some((e) => e.type === "receipt")).toBe(true);
    const patch = events.find((e) => e.type === "workspace_patch")!.payload as { view: { receiptId?: string } };
    expect(patch.view.receiptId).toBe("rec1");
  });
});

describe("toolSchemasForLLM", () => {
  it("describe() 文案透传到参数 schema——LLM 看得到字段语义", async () => {
    const { registerTool, toolSchemasForLLM } = await import("../agent/tools/registry");
    registerTool({
      name: "test.schema",
      description: "schema 测试",
      implemented: true,
      schema: z.object({
        mode: z.enum(["a", "b"]).optional().describe("a=甲方式；b=乙方式"),
        ids: z.array(z.string()).describe("目标行 id"),
      }),
    });
    const t = toolSchemasForLLM().find((x) => x.name === "test__schema")!;
    const props = (t.parameters as { properties: Record<string, { description?: string; enum?: string[] }> }).properties;
    expect(props.mode.description).toBe("a=甲方式；b=乙方式");
    expect(props.mode.enum).toEqual(["a", "b"]);
    expect(props.ids.description).toBe("目标行 id");
  });
});
