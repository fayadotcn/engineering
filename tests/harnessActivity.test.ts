import { afterEach, expect, it, vi } from "vitest";
import { streamRun } from "../harness/plugin/activity";

afterEach(() => vi.unstubAllGlobals());

it("对话导入卡在确认门停下，结束事件不必等待服务端关闭连接", async () => {
  const events = [{ type: "confirm_request", payload: {} }, { type: "run_finished", payload: {} }];
  const cancel = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""))); }, cancel }) })));
  const seen: string[] = [];
  await streamRun("http://localhost", "r1", e => seen.push(e.type), () => seen.includes("confirm_request"));
  expect(seen).toEqual(["confirm_request"]);
  expect(cancel).toHaveBeenCalledOnce();
});

it("导入进度意外结束时向操作界面报告失败", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, body: new ReadableStream({ start(c) { c.close(); } }) })));
  await expect(streamRun("http://localhost", "r1", () => {})).rejects.toThrow("连接中断");
});
