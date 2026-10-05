import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BoqItemDTO, WorkspaceView } from "@shared/types";

vi.mock("../src/ui/primitives", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() }, ConfirmDialog: () => null, Modal: () => null,
  EmptyState: ({ title, hint }: { title: string; hint?: string }) => React.createElement("p", null, title, hint),
}));
const state = vi.hoisted(() => ({
  items: [] as BoqItemDTO[], files: [] as { id: string; filename: string; status: string; kindLabel: string }[],
  blocks: [] as unknown[], views: [] as WorkspaceView[], closedViewIds: [] as string[], facts: [], receipts: [],
  boqQuery: "", boqOnlyUnpriced: false, running: false, agentRunning: false, importRunning: false, saving: false,
  projectId: "project", patchItem: vi.fn(), setBoqQuery: vi.fn(), setActiveView: vi.fn(), replaceView: vi.fn(), init: vi.fn(),
  summary: { itemCount: 0, pricedCount: 0, pricableCount: 0, disciplines: [] as { key: string; label: string; amount: string; share: number; count: number }[], missingSettings: [] as string[], fees: { unpricedCount: 0, preTax: "0", grandTotal: "0", rows: [] as { seq: string; name: string; basis: string; rate: string | null; amount: string; level: "leaf" | "subtotal" | "total"; note?: string }[] } },
  ready: true, projectName: "工程", activeViewId: "view:boq", pendingViewId: null,
}));
vi.mock("../src/ui/store", () => ({ useStore: Object.assign(() => state, { setState: vi.fn() }), FIXED_VIEWS: new Set(["view:overview", "view:files", "view:boq", "view:facts", "view:receipts", "view:prices"]) }));
import { TooltipProvider } from "../src/components/ui/tooltip";
import { BoqTable, ExportResult, FeeSummaryView, FileCompareView, FileList, PriceComposition, QuotaResult, QuotationMatch, displayFeature } from "../src/ui/views";
import { PricingSettings } from "../src/ui/PricingSettings";
import { CostOverview } from "../src/ui/CostOverview";
import { PriceRowsPanel } from "../src/ui/admin/PriceRowsPanel";
import { ColumnMappingView } from "../src/ui/views/ColumnMappingView";
import { DatasetManager } from "../src/ui/admin/DatasetManager";
import { Workbench } from "../src/ui/Workbench";

/** 复刻 layout.tsx 的根环境：应用里所有视图都在 TooltipProvider 之内。 */
const render = (el: React.ReactElement) => renderToStaticMarkup(React.createElement(TooltipProvider, null, el));


const item: BoqItemDTO = {
  id: "pipe", projectId: "project", fileId: "file", sheetName: "清单", rowIndex: 3, code: "030101", name: "给水管道", rawFeature: "DN50",
  unit: "m", quantity: "10", unitPrice: "0", mainMaterialPrice: "0", laborUnitPrice: "0", machineUnitPrice: "0", pricingPlan: [], totalPrice: "0", feeType: "分部分项", sectionPath: "",
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

it("工作区五个分区；成果按类只列最新一份，可直接切换", () => {
  state.items = [item];
  state.activeViewId = "quota";
  state.views = [
    { kind: "boqTable", id: "view:boq", title: "工程清单" },
    { kind: "quotationMatch", id: "match", title: "材料匹配", rows: [], unmatched: [] },
    { kind: "quotaResult", id: "quota-old", title: "测算结果", rows: [], mgmtRate: 0, profitRate: 0 },
    { kind: "quotaResult", id: "quota", title: "测算结果", rows: [], mgmtRate: 0, profitRate: 0 },
  ];
  const html = render(React.createElement(Workbench, { projectId: "project" }));
  const nav = html.match(/<nav class="wb-nav"[\s\S]*?<\/nav>/)![0];
  expect(nav.match(/<button/g)).toHaveLength(5);
  for (const label of ["概况", "清单", "资料", "成果", "设置"]) expect(nav).toContain(label);
  expect(nav).toMatch(/aria-current="page" class="active">[\s\S]*?成果/);
  const list = html.match(/<nav class="results-list"[\s\S]*?<\/nav>/)![0];
  expect(list.match(/aria-label="移除测算结果"/g)).toHaveLength(1);
  expect(list).toContain("材料匹配");
  expect(html).toContain("重新生成");
  expect(html).not.toContain("较早生成的快照");
});

it("清单页的待导入提示引导核对，不直接批准看不到的映射", () => {
  state.items = [item];
  state.views = [
    { kind: "boqTable", id: "view:boq", title: "工程清单" },
    { kind: "columnMapping", id: "view:mapping:file", fileId: "file", filename: "资料.xlsx", sheets: [] },
  ] as WorkspaceView[];
  state.blocks = [{ type: "confirm", runId: "run", confirmId: "confirm", fileId: "file", description: "核对资料.xlsx" }];
  const html = render(React.createElement(Workbench, { projectId: "project" }));
  expect(html).toContain("核对并导入");
  expect(html).not.toContain(">确认导入</button>");
});

it("资料只有文档时，总览引导补清单，不显示可直接生成成果", () => {
  state.files = [{ id: "file", filename: "施工说明.pdf", kindLabel: "文档", status: "PARSED" }];
  const html = render(React.createElement(CostOverview));
  expect(html).toContain("还需要导入工程清单");
  expect(html).not.toContain("生成费用汇总");
});

it("搜索无结果时保留筛选提示和清除入口", () => {
  state.items = [item]; state.boqQuery = "不存在的材料";
  const html = render(React.createElement(BoqTable));
  expect(html).toContain("没有符合筛选条件的清单项");
  expect(html).toContain("清除筛选");
  expect(html).not.toContain("<td>给水管道</td>");
});

it("专业工具给出的专业筛选在清单结果中生效", () => {
  state.items = [item];
  const html = render(React.createElement(BoqTable, { view: { kind: "boqTable", id: "view:boq", title: "消防清单", filter: { discipline: "FIRE" } } }));
  expect(html).toContain("没有符合筛选条件的清单项");
  // 专业筛选已从原生 select 换成 Radix Select：值体现在 combobox 触发器上，
  // 且收起态必须显示专业名（SelectValue 不给 children 时服务端渲染是空白）
  expect(html).toMatch(/role="combobox"[^>]*aria-label="筛选清单专业"/);
  expect(html).toMatch(/data-slot="select-value"[^>]*>消防</);
});

it("未定价筛选排除正常的零单价总额项", () => {
  state.items = [item, { ...item, id: "fee", name: "安全文明施工费", feeType: "总价措施", totalPrice: "1000" }];
  state.boqOnlyUnpriced = true;
  const html = render(React.createElement(BoqTable));
  expect(html).toContain("给水管道");
  expect(html).not.toContain("安全文明施工费");
  expect(html).toContain('aria-pressed="true"');
});

it("关闭过的映射仍有资料入口，待确认不再误显示待解析", () => {
  state.files = [{ id: "file", filename: "报价.xlsx", kindLabel: "询价表", status: "UPLOADED" }];
  state.closedViewIds = ["view:mapping:file"];
  state.blocks = [{ type: "confirm", runId: "run", confirmId: "confirm", description: "核对报价.xlsx", fileId: "file" }];
  const html = render(React.createElement(FileList));
  expect(html).toContain("待核对");
  expect(html).toContain("核对表格");
});

it("概况只突出一个下一步，费用和操作记录默认折叠", () => {
  state.summary.itemCount = 2; state.summary.fees.unpricedCount = 1;
  const html = render(React.createElement(CostOverview));
  expect(html).toContain("现在做这一步");
  expect(html).toContain("一键报价");
  expect(html.match(/data-variant="default"/g)).toHaveLength(1);
  expect(html).toMatch(/<details class="cost-fact-details"><summary>查看费用明细/);
  expect(html).toMatch(/<details class="cost-fact-details"><summary>查看操作记录/);
  expect(html).not.toContain("cost-workflow");
});

it("概况仪表盘：有清单时出专业环形图与费用瀑布，可下钻", () => {
  state.summary.itemCount = 10;
  state.summary.pricableCount = 10;
  state.summary.pricedCount = 6;
  state.summary.fees.grandTotal = "10632100.02";
  state.summary.disciplines = [
    { key: "ELECTRICAL", label: "电气", amount: "6000000", share: 0.59, count: 6 },
    { key: "PLUMBING", label: "给排水", amount: "3000000", share: 0.3, count: 4 },
  ];
  state.summary.fees.rows = [
    { seq: "一", name: "分部分项工程费", basis: "", rate: null, amount: "9477335.43", level: "leaf" },
    { seq: "二", name: "措施项目费", basis: "", rate: null, amount: "276884.77", level: "leaf" },
    { seq: "五", name: "税前工程造价", basis: "", rate: null, amount: "9754220.20", level: "subtotal" },
    { seq: "六", name: "增值税", basis: "", rate: null, amount: "877879.82", level: "leaf" },
    { seq: "七", name: "含税工程造价", basis: "", rate: null, amount: "10632100.02", level: "total" },
  ];
  const html = render(React.createElement(CostOverview));
  expect(html).toContain("dash-charts");
  expect(html).toContain('aria-label="各专业费用占比"');
  expect(html).toContain("1063.2万"); // 环形图中心万元缩写
  expect(html).toContain("税前"); // 瀑布图列名
  expect(html).toContain("59%"); // 专业图例百分比
  expect(html).toContain('role="progressbar"'); // 定价进度环
});

it("清单默认展开编码与特征列，保留规格提示和金额编辑规则", () => {
  state.items = [item];
  const html = render(React.createElement(BoqTable));
  const head = html.match(/<thead[\s\S]*?<\/thead>/)![0];
  // 造价专业默认口径：项目编码/项目特征是判定与对审的依据，默认就要可见（此前埋在「更多筛选」里）
  expect(head.match(/<th(?:\s|>)/g)).toHaveLength(8);
  expect(head).toContain("项目编码");
  expect(head).toContain("项目特征");
  // 表头术语固定为「综合单价」「合价」——综合单价是五要素组价结果，绝不能显示成「单价」
  expect(head).toContain("综合单价");
  expect(head).toContain("合价");
  expect(head).not.toContain("单价（元）");
  expect(head).not.toContain("金额（元）");
  expect(html).toContain("DN50");
  expect(html).toMatch(/<details class="cost-simple-more"><summary>更多筛选/);
  expect(html).toContain("点击数量、单价或金额即可修改");
});

it("金额列内嵌数据条，大额项一眼可见", () => {
  state.items = [
    { ...item, id: "a", name: "大额电缆", unitPrice: "1000", quantity: "100", totalPrice: "100000" },
    { ...item, id: "b", name: "小额配件", unitPrice: "500", quantity: "100", totalPrice: "50000" },
  ];
  const html = render(React.createElement(BoqTable));
  expect(html).toContain("width:50%");
  expect(html).toContain("width:100%");
  expect(html).toContain("inset-y-0");
});

it("行号悬停能回查来源文件和表内行号", () => {
  state.files = [{ id: "file", filename: "水电安装.xls", status: "PARSED", kindLabel: "招标清单" }];
  state.items = [item];
  const html = render(React.createElement(BoqTable));
  expect(html).toContain('title="来源：水电安装.xls · 清单 · 第 4 行"');
});

it("总额计价行的单价列显示占位符而不是 0.00", () => {
  state.items = [{ ...item, id: "fee", name: "安全文明施工费", feeType: "总价措施", unit: "项", quantity: "1", unitPrice: "0", totalPrice: "50000" }];
  const html = render(React.createElement(BoqTable));
  expect(html).toContain("总额计价行没有单价");
  expect(html).toContain("50,000.00");
});

it("组价过的清单项在常规模式就有构成入口，展开能复核到每条子目", () => {
  const priced: BoqItemDTO = {
    ...item, id: "p1", name: "镀锌钢管 DN50", unitPrice: "107.40", totalPrice: "1074",
    pricingPlan: [
      { quotaCode: "5H-0123", quotaName: "镀锌钢管安装 DN50", labor: "28.00", materialAux: "5.40", machine: "2.00", fee: "9.10", mainMaterialName: "镀锌钢管 DN50", mainQty: "1.02", mainPrice: "45.00", subtotal: "90.40" },
      { quotaCode: "5H-0310", quotaName: "管道水压试验", labor: "10.00", materialAux: "1.50", machine: "1.00", fee: "4.50", mainMaterialName: null, mainQty: null, mainPrice: null, subtotal: "17.00" },
      { quotaCode: "5H-0456", quotaName: "管道消毒冲洗", labor: "12.00", materialAux: "2.10", machine: "0", fee: "3.50", mainMaterialName: null, mainQty: null, mainPrice: null, subtotal: "17.60", suggested: true, scope: "工作内容含冲洗消毒" },
    ],
  };
  state.items = [priced];
  const html = render(React.createElement(BoqTable));
  expect(html).toContain("组价×2");
  expect(html).toContain("aria-expanded");
  const comp = render(React.createElement(PriceComposition, { item: priced }));
  expect(comp).toContain("综合单价构成");
  expect(comp).toContain("5H-0123");
  expect(comp).toContain("镀锌钢管 DN50");
  expect(comp).toContain("107.40");
  expect(comp).toContain("与综合单价一致");
  expect(comp).toContain("建议增列");
  expect(comp).toContain("管道消毒冲洗");
  expect(comp).toContain("让助手核对组价");
});

it("测算默认显示建议价与原价，五项成本构成按需展开", () => {
  const view: Extract<WorkspaceView, { kind: "quotaResult" }> = {
    kind: "quotaResult", id: "quota", title: "测算", mgmtRate: 0, profitRate: 0,
    rows: [{ itemId: "pipe", name: "给水管道", quotaCode: "5H-001", calcPrice: "15", listPrice: "0", needsMainPrice: true, deviation: null } as never],
  };
  const html = render(React.createElement(QuotaResult, { view }));
  const head = html.match(/<thead>[\s\S]*?<\/thead>/)![0];
  expect(head.match(/<th(?:\s|>)/g)).toHaveLength(6);
  expect(head).toContain("建议单价");
  expect(head).not.toContain("辅材");
  expect(html).toContain("未含缺失材料价");
  expect(html).toContain("查看明细");
});

it("价格库默认四项业务信息，其他筛选在折叠区", () => {
  const html = render(React.createElement(PriceRowsPanel, { datasetId: "dataset" }));
  const head = html.match(/<thead>[\s\S]*?<\/thead>/)![0];
  expect(head.match(/<th(?:\s|>)/g)).toHaveLength(6);
  expect(head).not.toContain("品牌");
  expect(html).toMatch(/<details class="cost-simple-more"><summary>更多筛选和信息/);
});

it("数据管理的可选参数与停用删除默认折叠", () => {
  const html = render(React.createElement(DatasetManager, { initial: [{
    id: "dataset", kind: "MATERIAL_PRICE", kindLabel: "材料价格", name: "价格表", filename: "价格.xlsx", status: "PARSED", active: true, rowCount: 3, createdAt: "2026-10-01",
  }] }));
  expect(html).toContain("打开数据");
  expect(html).toMatch(/<details class="cost-simple-more mt-2.5"><summary>补充地区、日期或品牌（可选）/);
  expect(html).toMatch(/<details class="cost-simple-more cost-dataset-more"><summary>更多/);
});

it("费用汇总与材料匹配默认隐藏计算基础和评分列", () => {
  const fee = render(React.createElement(FeeSummaryView, { view: { kind: "feeSummary", id: "fee", title: "汇总", rows: [], grandTotal: "0", unpricedCount: 1 } as never }));
  expect(fee.match(/<thead>[\s\S]*?<\/thead>/)![0]).not.toContain("计算基础");
  expect(fee).toContain("总价尚不完整");
  const quotation = render(React.createElement(QuotationMatch, { view: { kind: "quotationMatch", id: "match", title: "材料", rows: [], unmatched: [] } }));
  expect(quotation.match(/<thead>[\s\S]*?<\/thead>/)![0]).not.toContain("匹配评分");
  expect(quotation).toContain("暂无材料价匹配结果");
});

it("费用汇总用瀑布图呈现各费用怎么累加到含税总价", () => {
  const rows = [
    { seq: "一", name: "分部分项工程费", basis: "Σ 合价", rate: null, amount: "800000", level: "leaf" },
    { seq: "二", name: "措施项目费", basis: "", rate: null, amount: "0", level: "leaf" },
    { seq: "三", name: "其他项目费", basis: "", rate: null, amount: "30000", level: "leaf" },
    { seq: "四", name: "规费", basis: "", rate: "8%", amount: "20000", level: "leaf" },
    { seq: "五", name: "税前工程造价", basis: "一+二+三+四", rate: null, amount: "850000", level: "subtotal" },
    { seq: "六", name: "增值税", basis: "", rate: "9%", amount: "76500", level: "leaf" },
    { seq: "七", name: "含税工程造价", basis: "五+六", rate: null, amount: "926500", level: "total" },
  ];
  const html = render(React.createElement(FeeSummaryView, {
    view: { kind: "feeSummary", id: "fee", title: "汇总", rows, grandTotal: "926500", unpricedCount: 0 } as never,
  }));
  expect(html).toContain("80.0万");                    // 分部分项缩写金额
  expect(html).toContain("86.3%");                    // 分部分项占含税造价比例
  expect(html).toContain("未计");                     // 措施费为 0 的列标出「未计」
  expect(html).toContain("border-dashed");            // 水位连接线
  // 税金的浮段叠在税前水位上：bottom = 850000 / 926500 ≈ 91.7%，height ≈ 8.3%
  expect(html).toMatch(/bottom:91\.7[0-9]*%;height:8\.[0-9]+%/);
});

it("两版相同清单显示明确结果和版本来源", () => {
  const view: Extract<WorkspaceView, { kind: "fileCompare" }> = {
    kind: "fileCompare", id: "compare", title: "对审", labelA: "招标清单.xlsx", labelB: "复核清单.xlsx", rows: [],
    summary: { total: 0, same: 0, onlyA: 0, onlyB: 0, priceDiff: 0, qtyDiff: 0, totalDelta: "0" },
  };
  const html = render(React.createElement(FileCompareView, { view }));
  expect(html).toContain("两版清单没有差异");
  expect(html).toContain("A：招标清单.xlsx"); expect(html).toContain("B：复核清单.xlsx");
});

it("定额工作内容使用键盘可达的展开按钮", () => {
  const view: Extract<WorkspaceView, { kind: "quotaResult" }> = {
    kind: "quotaResult", id: "quota", title: "测算", mgmtRate: 0, profitRate: 0,
    rows: [{ itemId: "pipe", name: "给水管道", quotaCode: "5H-001", quotaName: "管道安装", quotaGcnr: "安装、试压", listPrice: "0", deviation: null } as never],
  };
  const html = render(React.createElement(QuotaResult, { view }));
  expect(html).toContain('<button aria-label="查看给水管道的定额工作内容" aria-expanded="false"');
});

it("导入期间计价条件所有输入都被锁定", () => {
  state.importRunning = true;
  expect(render(React.createElement(PricingSettings))).toContain('<fieldset disabled=""');
});

it("导出入口有文件名和下载语义，长文件名容器可收缩", () => {
  const filename = `${"安装工程".repeat(20)}.xlsx`;
  const html = render(React.createElement(ExportResult, { view: { kind: "exportResult", id: "export", title: "导出", artifactId: "artifact", filename, summary: "2 行" } }));
  expect(html).toContain(`download="${filename}"`);
  expect(html).toContain(`aria-label="下载${filename}"`);
  expect(html).toContain("w-full max-w-80");
});

it("价格库初始加载说明状态，搜索控件有标签", () => {
  const html = render(React.createElement(PriceRowsPanel, { datasetId: "dataset" }));
  expect(html).toContain("正在读取价格数据");
  expect(html).toContain('aria-label="搜索价格行"');
  expect(html).toContain('aria-label="筛选品牌"');
});

it("映射列与类型控件有可区分的标签，多行表头使用专用布局", () => {
  const view: Extract<WorkspaceView, { kind: "columnMapping" }> = {
    kind: "columnMapping", id: "view:mapping:file", title: "映射", fileId: "file", filename: "报价.xlsx", fileStatus: "UPLOADED",
    sheets: [{ sheetName: "价格表", type: "QUOTATION", headerCells: ["名称"], colCount: 1, rowCount: 2, sample: [["管道"]], columns: { name: 0 }, confidence: {}, evidence: {}, minConfidence: 1, typeConfidence: 1, typeEvidence: "报价", templateHit: false, userEdited: false } as never],
  };
  const html = render(React.createElement(ColumnMappingView, { view }));
  expect(html).toContain('aria-label="价格表的表格类型"');
  expect(html).toContain('aria-label="价格表的A列角色"');
  expect(html).toContain('class="xl-table mapping-table"');
});

it("名称列副标题剥离编号与重复的名称字段", () => {
  const raw = "1、名称：配电箱 H01-1APz\n2、型号规格：Pe=60kW/详见系统图\n3、安装方式：挂墙明装/底边距地1.5m\n4、含端子接线";
  const shown = displayFeature(raw, "配电箱");
  expect(shown).toBe("H01-1APz · 型号规格：Pe=60kW/详见系统图 · 安装方式：挂墙明装/底边距地1.5m · 含端子接线");
  expect(displayFeature("DN50 沟槽连接", "镀锌钢管")).toBe("DN50 沟槽连接"); // 干净原文不动
  expect(displayFeature("1、名称：给水管道", "给水管道")).toBe("1、名称：给水管道"); // 只剩名称段时回退原文
  state.items = [{ ...item, name: "配电箱", rawFeature: raw }];
  const html = render(React.createElement(BoqTable));
  expect(html).toContain("H01-1APz · 型号规格：Pe=60kW");
  expect(html).not.toContain(">1、名称：");
});
