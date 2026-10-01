import { expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ runs: vi.fn(), files: vi.fn() }));
vi.mock("@database/client", () => ({ prisma: {
  agentRun: { updateMany: vi.fn(), findMany: db.runs },
  projectFile: { findMany: db.files },
} }));
import { GET } from "../src/app/api/projects/[id]/runs/route";

it("刷新重放使用已保存的类型和单价角色，不还原历史识别映射", async () => {
  db.runs.mockResolvedValue([{ id: "r1", userMessage: "导入", status: "DONE", events: [
    { seq: 1, type: "workspace_patch", payload: JSON.stringify({ view: { id: "view:mapping:f1", kind: "columnMapping", fileId: "f1", sheets: [{ type: "QUOTATION", columns: { price: 4 } }] } }) },
  ] }]);
  db.files.mockResolvedValue([{ id: "f1", filename: "验收.xlsx", status: "PARSED", meta: JSON.stringify({ mapping: {
    明细: { sheetName: "明细", type: "BOQ", columns: { unitPrice: 4 }, userEdited: true },
  } }) }]);
  const response = await GET(new Request("http://localhost/api/projects/p1/runs"), { params: Promise.resolve({ id: "p1" }) });
  const view = (await response.json())[0].events[0].payload.view;
  expect(view.fileStatus).toBe("PARSED");
  expect(view.sheets[0]).toMatchObject({ type: "BOQ", columns: { unitPrice: 4 }, userEdited: true });
});
