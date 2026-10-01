import { expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ waiting: vi.fn(), recent: vi.fn(), events: vi.fn() }));
vi.mock("@database/client", () => ({ prisma: {
  project: { findUnique: vi.fn(async () => ({ id: "p1" })) },
  agentRun: { findFirst: db.waiting, findMany: db.recent },
  agentEvent: { findMany: db.events },
  toolCall: { findFirst: vi.fn(async () => null) },
} }));
import { GET } from "../src/app/api/projects/[id]/activity/route";

it("连续上传时，待确认入口定位到待确认文件，不会串到较新的成功导入", async () => {
  const waiting = { id: "waiting", planner: "import", status: "AWAITING_CONFIRM", createdAt: new Date("2026-09-30T00:00:00Z"), userMessage: "分析并导入文件「待核对.xlsx」", summary: "", pendingAction: JSON.stringify({ confirmId: "c1", tool: "file.ingest", description: "核对待确认文件" }) };
  db.waiting.mockResolvedValue(waiting);
  db.recent.mockResolvedValue([{ ...waiting, id: "done", status: "DONE", userMessage: "分析并导入文件「已成功.xlsx」" }, waiting]);
  db.events.mockImplementation(async ({ where }: { where: { runId: string } }) => [{ type: "workspace_patch", payload: JSON.stringify({ view: { id: `mapping:${where.runId}`, kind: "columnMapping", filename: where.runId, sheets: [] } }) }]);
  const response = await GET(new Request("http://localhost/api/projects/p1/activity"), { params: Promise.resolve({ id: "p1" }) });
  const activity = await response.json();
  expect(activity.confirm.runId).toBe("waiting");
  expect(activity.import.mappingViewId).toBe("mapping:waiting");
  expect(activity.import.filename).toBe("待核对.xlsx");
});
