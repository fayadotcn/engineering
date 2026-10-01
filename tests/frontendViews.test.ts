import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BoqItemDTO, WorkspaceView } from "@shared/types";

vi.mock("../src/ui/primitives", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() }, ConfirmDialog: () => null,
  EmptyState: ({ title, hint }: { title: string; hint?: string }) => React.createElement("p", null, title, hint),
}));
const state = vi.hoisted(() => ({
  items: [] as BoqItemDTO[], files: [] as { id: string; filename: string; status: string; kindLabel: string }[],
  blocks: [] as unknown[], views: [] as WorkspaceView[], closedViewIds: [] as string[], facts: [], receipts: [],
  boqQuery: "", boqOnlyUnpriced: false, running: false, agentRunning: false, importRunning: false, saving: false,
  projectId: "project", patchItem: vi.fn(), setBoqQuery: vi.fn(), setActiveView: vi.fn(), replaceView: vi.fn(), init: vi.fn(),
  summary: { itemCount: 0, pricedCount: 0, pricableCount: 0, disciplines: [], missingSettings: [] as string[], fees: { unpricedCount: 0, preTax: "0", grandTotal: "0" } },
  ready: true, projectName: "工程", activeViewId: "view:boq", pendingViewId: null,
}));
vi.mock("../src/ui/store", () => ({ useStore: Object.assign(() => state, { setState: vi.fn() }) }));
import { BoqTable, ExportResult, FeeSummaryView, FileCompareView, FileList, QuotaResult, QuotationMatch } from "../src/ui/views";
import { PricingSettings } from "../src/ui/PricingSettings";
import { CostOverview } from "../src/ui/CostOverview";
import { PriceRowsPanel } from "../src/ui/admin/PriceRowsPanel";
import { ColumnMappingView } from "../src/ui/views/ColumnMappingView";
import { DatasetManager } from "../src/ui/admin/DatasetManager";
import { Workbench } from "../src/ui/Workbench";

const item: BoqItemDTO = {
  id: "pipe", projectId: "project", fileId: "file", sheetName: "清单", rowIndex: 3, code: "030101", name: "给水管道", rawFeature: "DN50",
  unit: "m", quantity: "10", unitPrice: "0", mainMaterialPrice: "0", pricingPlan: [], totalPrice: "0", feeType: "分部分项", sectionPath: "",
  isHeader: false, sortOrder: 0, discipline: "PLUMBING", features: {},
};

beforeEach(() => {
  vi.stubGlobal("React", React);
  state.items = []; state.files = []; state.blocks = []; state.views = []; state.closedViewIds = [];
  state.boqQuery = ""; state.boqOnlyUnpriced = false; state.importRunning = false;
  state.summary.itemCount = 0; state.summary.missingSettings = []; state.summary.fees.unpricedCount = 0;
  state.activeViewId = "view:boq";
});
afterEach(() => vi.unstubAllGlobals());

it("工作区只有三个主要入口，测算归成果且可直接切换结果", () => {
  state.items = [item];
  state.activeViewId = "quota";
  state.views = [
    { kind: "boqTable", id: "view:boq", title: "工程清单" },
    { kind: "quotationMatch", id: "match", title: "材料匹配", rows: [], unmatched: [] },
    { kind: "quotaResult", id: "quota", title: "测算结果", rows: [], mgmtRate: 0, profitRate: 0 },
  ];
  const html = renderToStaticMarkup(React.createElement(Workbench, { projectId: "project" }));
  const nav = html.match(/<nav[\s\S]*?<\/nav>/)![0];
  expect(nav.split("<details")[0].match(/<button/g)).toHaveLength(3);
  expect(nav).toMatch(/aria-current="page" class="active">成果/);
  expect(nav).toContain("计价设置");
  expect(html).toContain('class="cost-view-switch"');
  expect(html).toContain("材料匹配</option>");
  expect(html).not.toContain("关闭当前结果");
});

it("清单页的待导入提示引导核对，不直接批准看不到的映射", () => {
  state.views = [
    { kind: "boqTable", id: "view:boq", title: "工程清单" },
    { kind: "columnMapping", id: "view:mapping:file", fileId: "file", filename: "资料.xlsx", sheets: [] },
  ] as WorkspaceView[];
  state.blocks = [{ type: "confirm", runId: "run", confirmId: "confirm", fileId: "file", description: "核对资料.xlsx" }];
  const html = renderToStaticMarkup(React.createElement(Workbench, { projectId: "project" }));
  expect(html).toContain("核对并导入");
  expect(html).not.toContain(">确认导入</button>");
});

it("资料只有文档时，总览引导补清单，不显示可直接生成成果", () => {
  state.files = [{ id: "file", filename: "施工说明.pdf", kindLabel: "文档", status: "PARSED" }];
  const html = renderToStaticMarkup(React.createElement(CostOverview));
  expect(html).toContain("还需要导入工程清单");
  expect(html).not.toContain("生成费用汇总");
});

it("搜索无结果时保留筛选提示和清除入口", () => {
  state.items = [item]; state.boqQuery = "不存在的材料";
  const html = renderToStaticMarkup(React.createElement(BoqTable));
  expect(html).toContain("没有符合筛选条件的清单项");
  expect(html).toContain("清除筛选");
  expect(html).not.toContain("<td>给水管道</td>");
});

it("专业工具给出的专业筛选在清单结果中生效", () => {
  state.items = [item];
  const html = renderToStaticMarkup(React.createElement(BoqTable, { view: { kind: "boqTable", id: "view:boq", title: "消防清单", filter: { discipline: "FIRE" } } }));
  expect(html).toContain("没有符合筛选条件的清单项");
  expect(html).toContain('value="FIRE" selected=""');
});

it("未定价筛选排除正常的零单价总额项", () => {
  state.items = [item, { ...item, id: "fee", name: "安全文明施工费", feeType: "总价措施", totalPrice: "1000" }];
  state.boqOnlyUnpriced = true;
  const html = renderToStaticMarkup(React.createElement(BoqTable));
  expect(html).toContain("给水管道");
  expect(html).not.toContain("安全文明施工费");
  expect(html).toContain('aria-pressed="true"');
});

it("关闭过的映射仍有资料入口，待确认不再误显示待解析", () => {
  state.files = [{ id: "file", filename: "报价.xlsx", kindLabel: "询价表", status: "UPLOADED" }];
  state.closedViewIds = ["view:mapping:file"];
  state.blocks = [{ type: "confirm", runId: "run", confirmId: "confirm", description: "核对报价.xlsx", fileId: "file" }];
  const html = renderToStaticMarkup(React.createElement(FileList));
  expect(html).toContain("待核对");
  expect(html).toContain("核对表格");
});

it("概况只突出一个下一步，费用和操作记录默认折叠", () => {
  state.summary.itemCount = 2; state.summary.fees.unpricedCount = 1;
  const html = renderToStaticMarkup(React.createElement(CostOverview));
  expect(html).toContain("现在做这一步");
  expect(html).toContain("自动测算");
  expect(html.match(/class="cost-btn primary"/g)).toHaveLength(1);
  expect(html).toMatch(/<details class="cost-fact-details"><summary>查看费用明细/);
  expect(html).toMatch(/<details class="cost-fact-details"><summary>查看操作记录/);
  expect(html).not.toContain("cost-workflow");
});

it("清单默认六列，保留规格提示和金额编辑规则", () => {
  state.items = [item];
  const html = renderToStaticMarkup(React.createElement(BoqTable));
  const head = html.match(/<thead[\s\S]*?<\/thead>/)![0];
  expect(head.match(/<th(?:\s|>)/g)).toHaveLength(6);
  expect(head).not.toContain("项目编码");
  expect(html).toContain("DN50");
  expect(html).toMatch(/<details class="cost-simple-more"><summary>更多筛选/);
  expect(html).toContain("点击数量或单价即可修改");
});

it("测算默认显示建议价与原价，五项成本构成按需展开", () => {
  const view: Extract<WorkspaceView, { kind: "quotaResult" }> = {
    kind: "quotaResult", id: "quota", title: "测算", mgmtRate: 0, profitRate: 0,
    rows: [{ itemId: "pipe", name: "给水管道", quotaCode: "5H-001", calcPrice: "15", listPrice: "0", needsMainPrice: true, deviation: null } as never],
  };
  const html = renderToStaticMarkup(React.createElement(QuotaResult, { view }));
  const head = html.match(/<thead>[\s\S]*?<\/thead>/)![0];
  expect(head.match(/<th(?:\s|>)/g)).toHaveLength(6);
  expect(head).toContain("建议单价");
  expect(head).not.toContain("辅材");
  expect(html).toContain("未含缺失材料价");
  expect(html).toContain("查看明细");
});

it("价格库默认四项业务信息，其他筛选在折叠区", () => {
  const html = renderToStaticMarkup(React.createElement(PriceRowsPanel, { datasetId: "dataset" }));
  const head = html.match(/<thead>[\s\S]*?<\/thead>/)![0];
  expect(head.match(/<th(?:\s|>)/g)).toHaveLength(6);
  expect(head).not.toContain("品牌");
  expect(html).toMatch(/<details class="cost-simple-more"><summary>更多筛选和信息/);
});

it("数据管理的可选参数与停用删除默认折叠", () => {
  const html = renderToStaticMarkup(React.createElement(DatasetManager, { initial: [{
    id: "dataset", kind: "MATERIAL_PRICE", kindLabel: "材料价格", name: "价格表", filename: "价格.xlsx", status: "PARSED", active: true, rowCount: 3, createdAt: "2026-10-01",
  }] }));
  expect(html).toContain("打开数据");
  expect(html).toMatch(/<details class="cost-simple-more mt-2.5"><summary>补充地区、日期或品牌（可选）/);
  expect(html).toMatch(/<details class="cost-simple-more cost-dataset-more"><summary>更多/);
});

it("费用汇总与材料匹配默认隐藏计算基础和评分列", () => {
  const fee = renderToStaticMarkup(React.createElement(FeeSummaryView, { view: { kind: "feeSummary", id: "fee", title: "汇总", rows: [], grandTotal: "0", unpricedCount: 1 } as never }));
  expect(fee.match(/<thead>[\s\S]*?<\/thead>/)![0]).not.toContain("计算基础");
  expect(fee).toContain("总价尚不完整");
  const quotation = renderToStaticMarkup(React.createElement(QuotationMatch, { view: { kind: "quotationMatch", id: "match", title: "材料", rows: [], unmatched: [] } }));
  expect(quotation.match(/<thead>[\s\S]*?<\/thead>/)![0]).not.toContain("匹配评分");
  expect(quotation).toContain("暂无材料价匹配结果");
});

it("两版相同清单显示明确结果和版本来源", () => {
  const view: Extract<WorkspaceView, { kind: "fileCompare" }> = {
    kind: "fileCompare", id: "compare", title: "对审", labelA: "招标清单.xlsx", labelB: "复核清单.xlsx", rows: [],
    summary: { total: 0, same: 0, onlyA: 0, onlyB: 0, priceDiff: 0, qtyDiff: 0, totalDelta: "0" },
  };
  const html = renderToStaticMarkup(React.createElement(FileCompareView, { view }));
  expect(html).toContain("两版清单没有差异");
  expect(html).toContain("A：招标清单.xlsx"); expect(html).toContain("B：复核清单.xlsx");
});

it("定额工作内容使用键盘可达的展开按钮", () => {
  const view: Extract<WorkspaceView, { kind: "quotaResult" }> = {
    kind: "quotaResult", id: "quota", title: "测算", mgmtRate: 0, profitRate: 0,
    rows: [{ itemId: "pipe", name: "给水管道", quotaCode: "5H-001", quotaName: "管道安装", quotaGcnr: "安装、试压", listPrice: "0", deviation: null } as never],
  };
  const html = renderToStaticMarkup(React.createElement(QuotaResult, { view }));
  expect(html).toContain('<button aria-label="查看给水管道的定额工作内容" aria-expanded="false"');
});

it("导入期间计价条件所有输入都被锁定", () => {
  state.importRunning = true;
  expect(renderToStaticMarkup(React.createElement(PricingSettings))).toContain('<fieldset disabled=""');
});

it("导出入口有文件名和下载语义，长文件名容器可收缩", () => {
  const filename = `${"安装工程".repeat(20)}.xlsx`;
  const html = renderToStaticMarkup(React.createElement(ExportResult, { view: { kind: "exportResult", id: "export", title: "导出", artifactId: "artifact", filename, summary: "2 行" } }));
  expect(html).toContain(`download="${filename}"`);
  expect(html).toContain(`aria-label="下载${filename}"`);
  expect(html).toContain("w-full max-w-80");
});

it("价格库初始加载说明状态，搜索控件有标签", () => {
  const html = renderToStaticMarkup(React.createElement(PriceRowsPanel, { datasetId: "dataset" }));
  expect(html).toContain("正在读取价格数据");
  expect(html).toContain('aria-label="搜索价格行"');
  expect(html).toContain('aria-label="筛选品牌"');
});

it("映射列与类型控件有可区分的标签，多行表头使用专用布局", () => {
  const view: Extract<WorkspaceView, { kind: "columnMapping" }> = {
    kind: "columnMapping", id: "view:mapping:file", title: "映射", fileId: "file", filename: "报价.xlsx", fileStatus: "UPLOADED",
    sheets: [{ sheetName: "价格表", type: "QUOTATION", headerCells: ["名称"], colCount: 1, rowCount: 2, sample: [["管道"]], columns: { name: 0 }, confidence: {}, evidence: {}, minConfidence: 1, typeConfidence: 1, typeEvidence: "报价", templateHit: false, userEdited: false } as never],
  };
  const html = renderToStaticMarkup(React.createElement(ColumnMappingView, { view }));
  expect(html).toContain('aria-label="价格表的表格类型"');
  expect(html).toContain('aria-label="价格表的A列角色"');
  expect(html).toContain('class="xl-table mapping-table"');
});
