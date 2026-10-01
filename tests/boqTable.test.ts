import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/ui/primitives", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() }, ConfirmDialog: vi.fn(), EmptyState: vi.fn() }));
const store = vi.hoisted(() => ({ items: [] as BoqItemDTO[], boqQuery: "", patchItem: vi.fn(), setBoqQuery: vi.fn(), running: false, agentRunning: false, importRunning: false }));
vi.mock("../src/ui/store", () => ({ useStore: () => store }));
import { BoqTable } from "../src/ui/views";
import type { BoqItemDTO } from "@shared/types";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("按计价口径开放编辑：普通项的量价、总额项的合价，零工程量的总额项保持可见", () => {
  vi.stubGlobal("React", React);
  const item: BoqItemDTO = {
    id: "fee", projectId: "p", fileId: null, sheetName: "措施", rowIndex: 2, code: "", name: "安全文明施工费",
    rawFeature: "", unit: "", quantity: "0", unitPrice: "0", mainMaterialPrice: "0", pricingPlan: [], totalPrice: "1500",
    feeType: "总价措施", sectionPath: "", isHeader: false, sortOrder: 0, discipline: "OTHER", features: {},
  };
  store.items = [item, { ...item, id: "pipe", feeType: "分部分项", name: "管道", quantity: "10", unitPrice: "50", totalPrice: "500" }];
  const html = renderToStaticMarkup(React.createElement(BoqTable));
  const rows = html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1].match(/<tr[\s\S]*?<\/tr>/g)!;
  expect(rows[0]).not.toContain("opacity-45");
  expect(rows[0].match(/tabindex="0"/g)).toHaveLength(1);
  expect(rows[0]).toMatch(/tabindex="0"[^>]*>1,500\.00<\/td>/);
  expect(rows[1].match(/tabindex="0"/g)).toHaveLength(2);
  expect(rows[1]).toContain("工程量×综合单价自动计算");
});
