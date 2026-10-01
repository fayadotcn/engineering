import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { ActivityCards, type CardHandlers } from "../harness/plugin/cards";
import type { ProjectActivity } from "../harness/plugin/activity";

afterEach(() => vi.unstubAllGlobals());
const handlers: CardHandlers = { onReviewMapping: vi.fn(), onFocusView: vi.fn(), onSend: vi.fn() };
function render(activity: ProjectActivity) {
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(React.createElement(ActivityCards, { activity, importing: false, importingFile: "", progress: "", handlers }));
}

it("对话确认入口引导到工作区核对，不提供绕过未保存映射的直接批准", () => {
  const html = render({ confirm: { runId: "r1", confirmId: "c1", tool: "file.ingest", description: "核对列映射" }, import: null, result: null });
  expect(html).toContain("核对并确认导入");
  expect(html.match(/<button/g)).toHaveLength(1);
});

it("结果入口直接显示，失败的任务不标成完成", () => {
  const html = render({ confirm: null, import: null, result: { runId: "r1", status: "FAILED", at: "2026-09-30T00:00:00Z", summary: "测算未完成，请补充主材价格", views: [{ id: "v1", kind: "quotaResult", title: "组价明细" }] } });
  expect(html).toContain("任务尚未完成");
  expect(html).toContain("组价明细");
  expect(html).not.toContain("<details");
});

it("多份结果只突出最新一份，其余结果保留可点击入口", () => {
  const html = render({ confirm: null, import: null, result: { runId: "r1", status: "DONE", at: "2026-10-01T00:00:00Z", summary: "清单已经完成测算和费用汇总", views: [{ id: "v1", kind: "quotaResult", title: "组价明细" }, { id: "v2", kind: "feeSummary", title: "费用汇总" }] } });
  expect(html).toContain("查看费用汇总");
  expect(html.match(/class="primary"/g)).toHaveLength(1);
  expect(html).toContain("<details><summary>其他结果（1）");
  expect(html).toContain("组价明细");
});

it("导入只有询价或文档时，下一步查看资料而非空清单", () => {
  const html = render({ confirm: null, result: null, import: { runId: "r1", status: "DONE", at: "2026-10-01T00:00:00Z", filename: "施工说明.pdf", mappingViewId: null, summary: "施工说明已保存", totals: null, sheets: [] } });
  expect(html).toContain("查看资料");
  expect(html).not.toContain("查看清单");
});
