import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/ui/primitives", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() }, ConfirmDialog: vi.fn(), EmptyState: vi.fn(), Modal: vi.fn(() => null) }));
const store = vi.hoisted(() => ({ items: [] as BoqItemDTO[], boqQuery: "", patchItem: vi.fn(), setBoqQuery: vi.fn(), running: false, agentRunning: false, importRunning: false }));
vi.mock("../src/ui/store", () => ({ useStore: () => store }));
import { TooltipProvider } from "../src/components/ui/tooltip";
import { BoqTable } from "../src/ui/views";
import type { BoqItemDTO } from "@shared/types";

/** 复刻 layout.tsx 的根环境：应用里所有视图都在 TooltipProvider 之内。 */
const render = (el: React.ReactElement) => renderToStaticMarkup(React.createElement(TooltipProvider, null, el));


afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("按计价口径开放编辑：普通项的量价、总额项的合价，零工程量的总额项保持可见", () => {
  vi.stubGlobal("React", React);
  const item: BoqItemDTO = {
    id: "fee", projectId: "p", fileId: null, sheetName: "措施", rowIndex: 2, code: "", name: "安全文明施工费",
    rawFeature: "", unit: "", quantity: "0", unitPrice: "0", mainMaterialPrice: "0", laborUnitPrice: "0", machineUnitPrice: "0", pricingPlan: [], totalPrice: "1500",
    feeType: "总价措施", sectionPath: "", isHeader: false, sortOrder: 0, discipline: "OTHER", features: {},
  };
  store.items = [item, { ...item, id: "pipe", feeType: "分部分项", name: "管道", quantity: "10", unitPrice: "50", totalPrice: "500" }];
  const html = render(React.createElement(BoqTable));
  const rows = html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1].match(/<tr[\s\S]*?<\/tr>/g)!;
  expect(rows[0]).not.toContain("opacity-45");
  expect(rows[0].match(/tabindex="0"/g)).toHaveLength(1);
  expect(rows[0]).toMatch(/tabindex="0"[\s\S]*?<span class="relative">1,500\.00<\/span><\/td>/);
  expect(rows[1].match(/tabindex="0"/g)).toHaveLength(2);
  expect(rows[1]).toContain("工程量×综合单价自动计算");
});

it("Ctrl+C 复制到 Excel：总额计价行与未定价行的综合单价留白（与导出件同口径）", async () => {
  const { copyRowsToExcel } = await import("../src/ui/views/boq/clipboard");
  const writeText = vi.fn();
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const lump: BoqItemDTO = {
    id: "fee", projectId: "p", fileId: null, sheetName: "措施", rowIndex: 2, code: "", name: "安全文明施工费",
    rawFeature: "", unit: "", quantity: "0", unitPrice: "0", mainMaterialPrice: "0", laborUnitPrice: "0", machineUnitPrice: "0", pricingPlan: [], totalPrice: "1500",
    feeType: "总价措施", sectionPath: "", isHeader: false, sortOrder: 0, discipline: "OTHER", features: {},
  };
  const unpriced: BoqItemDTO = { ...lump, id: "p1", feeType: "分部分项", name: "未定价管", unit: "m", quantity: "10", unitPrice: "0", totalPrice: "0" };
  const priced: BoqItemDTO = { ...unpriced, id: "p2", name: "已定价管", unitPrice: "50", totalPrice: "500" };
  await copyRowsToExcel([lump, unpriced, priced]);
  const tsv: string = writeText.mock.calls[0][0];
  const lines = tsv.split("\n");
  expect(lines[0].split("\t")[5]).toBe("综合单价");
  // 总额行：综合单价格留空（不是结构性 0）
  expect(lines[1].split("\t")[5]).toBe("");
  // 未定价分部分项行：同样留空，粘回时不会把 0 当真价覆盖
  expect(lines[2].split("\t")[5]).toBe("");
  expect(lines[3].split("\t")[5]).toBe("50");
});
