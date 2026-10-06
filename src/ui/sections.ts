import type { WorkspaceView } from "@shared/types";

/** 工作区一级分区。视图只是分区下的内容，分区是唯一的顶级导航层级。 */
export type SectionId = "overview" | "boq" | "files" | "results" | "settings";

export const SECTIONS: { id: SectionId; label: string; home: string }[] = [
  { id: "overview", label: "概况", home: "view:overview" },
  { id: "boq", label: "清单", home: "view:boq" },
  { id: "files", label: "资料", home: "view:files" },
  { id: "results", label: "成果", home: "empty:results" },
  { id: "settings", label: "设置", home: "view:facts" },
];

const SECTION_OF: Record<WorkspaceView["kind"], SectionId> = {
  overview: "overview",
  boqTable: "boq",
  fileList: "files",
  columnMapping: "files",
  document: "files",
  priceLibrary: "files",
  factList: "settings",
  receipts: "settings",
  quotaResult: "results",
  quotaUsage: "results",
  quotationMatch: "results",
  specResult: "results",
  anomalyTable: "results",
  fileCompare: "results",
  diff: "results",
  feeSummary: "results",
  measureFee: "results",
  costComposition: "results",
  breakdown: "results",
  exportResult: "results",
};

export const sectionOf = (kind: WorkspaceView["kind"]): SectionId => SECTION_OF[kind];

/** 工作区常驻视图：每个工程都有，不能关闭。 */
export const FIXED_VIEWS = new Set(["view:overview", "view:files", "view:boq", "view:facts", "view:receipts", "view:prices"]);

export function seedViews(facts: Extract<WorkspaceView, { kind: "factList" }>["facts"]): WorkspaceView[] {
  return [
    { kind: "overview", id: "view:overview", title: "工程概况" },
    { kind: "boqTable", id: "view:boq", title: "工程清单" },
    { kind: "fileList", id: "view:files", title: "项目文件" },
    { kind: "priceLibrary", id: "view:prices", title: "共享价格库" },
    { kind: "factList", id: "view:facts", title: "计价设置", facts },
    { kind: "receipts", id: "view:receipts", title: "操作记录" },
  ];
}

/** 同类同名的成果只有最新一份有意义：旧快照会被新结果取代。 */
export const resultKey = (v: WorkspaceView) => `${v.kind}|${v.title}`;
