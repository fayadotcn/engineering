// Shared domain types. No runtime deps — safe on client and server.

export type Discipline =
  | "ELECTRICAL"
  | "PLUMBING"
  | "FIRE"
  | "HVAC"
  | "WEAK_CURRENT"
  | "OTHER";

export type FileKind =
  | "BOQ_TENDER"
  | "BOQ_WINNING"
  | "BOQ_SETTLEMENT"
  | "MATERIAL_QUOTATION"
  | "OWNER_SUPPLIED"
  | "CONTRACT"
  | "CHANGE"
  | "VISA"
  | "DRAWING"
  | "UNKNOWN";

export type FactSource =
  | "USER_PROVIDED"
  | "FILE_EXTRACTED"
  | "CONTRACT_DEFINED"
  | "HISTORICAL"
  | "INFERRED"
  | "MARKET_REFERENCE";

/** Structured engineering semantics parsed from 项目名称 + 项目特征. */
export interface BoqSemanticFeature {
  system?: string; // 消防 | 给排水 | 电气 | 暖通 ...
  category?: string; // 管道 | 电缆 | 桥架 | 阀门 | 配电箱 ...
  material?: string; // 镀锌钢管 | PPR | YJV ...
  specification?: string; // raw spec token(s): DN100, 4x25+1x16, 100x200
  diameter?: string; // DN100 / Φ108 normalized
  connectionMethod?: string; // 沟槽 | 螺纹 | 焊接 | 法兰 | 热熔 | 卡压 ...
  installationMethod?: string; // 明装 | 暗装 | 吊装 | 埋地 ...
  location?: string; // 室内 | 室外 | 地下 ...
  height?: string;
  pressure?: string; // PN1.6 / 1.6MPa
  power?: string; // 设备额定功率：Pe=60kW / 功率15kW / 315kVA → "60kW"/"15kW"/"315kVA"
  fireRating?: string;
  brand?: string;
  technicalRequirement?: string;
  tokens?: string[]; // residual normalized tokens
}

/** 清单费用口径：分部分项 | 单价措施 | 总价措施 | 其他项目（计价表体系分层）。 */
export type FeeType = "分部分项" | "单价措施" | "总价措施" | "其他项目";

/** 组价方案行：一个清单项 = 若干定额子目组合（管道+试压+冲洗…）。
 *  金额均为「每清单单位」口径（定额单位倍数已折算）。 */
export interface PricingPlanLine {
  quotaCode: string;
  quotaName: string;
  /** 每清单单位：人工/辅材/机械/管理费利润 */
  labor: string;
  materialAux: string;
  machine: string;
  fee: string;
  /** 主材费 = 主材价 × 耗量；无主材要求时 null */
  mainMaterialName: string | null;
  mainQty: string | null;
  mainPrice: string | null;
  /** 该行小计（每清单单位） */
  subtotal: string;
  /** 建议增列：工作内容缺口推断的配套子目，人工确认前不计入测算价 */
  suggested?: boolean;
  /** 人工指定（quota.setItemQuota 写入） */
  manual?: boolean;
  /** 该行承担的工作内容/建议理由 */
  scope?: string;
}

/** Serialized BoqItem shape sent to client (Decimals -> strings). */
export interface BoqItemDTO {
  id: string;
  projectId: string;
  fileId: string | null;
  sheetName: string;
  rowIndex: number;
  code: string;
  name: string;
  rawFeature: string;
  unit: string;
  quantity: string;
  /** 工程量计算式原文（如 "3层×12个+15"）；空/缺 = 直接填数，非空 = 由计算式得出，复核可查 */
  quantityExpr?: string;
  /** 综合单价（人材机管利五要素组价结果），材料价/询价绝不能直接写入 */
  unitPrice: string;
  /** 主材/设备暂估价（询价/信息价），是组价输入而非综合单价 */
  mainMaterialPrice: string;
  /** 来源表分解列：人工费单价（每清单单位）；0 = 源表无此列 */
  laborUnitPrice: string;
  /** 来源表分解列：机械费单价（每清单单位）；0 = 源表无此列 */
  machineUnitPrice: string;
  /** 组价方案（多定额子目组合）；空数组=未组价，综合单价是原清单价/手工价 */
  pricingPlan: PricingPlanLine[];
  totalPrice: string;
  /** 原始单元格（表头标签/列字母 → 文本）+ __nonNumeric/__derived 标记 */
  rawCells?: Record<string, unknown>;
  feeType: FeeType;
  sectionPath: string;
  /** 单项/单位工程（多单位工程项目），空 = 未区分 */
  unitProject?: string;
  /** 单价为含税价（源表「含税单价」列），汇总时不再叠增值税 */
  taxIncluded?: boolean;
  isHeader: boolean;
  sortOrder: number;
  discipline: Discipline;
  features: BoqSemanticFeature;
}

/** 可计价项：分部分项/单价措施才走「量×综合单价」；总价措施/其他项目是总额计价行，单价为 0 属正常（不算未定价）。 */
export const isPricableItem = (
  i: Pick<BoqItemDTO, "isHeader" | "name" | "feeType">
): boolean =>
  !i.isHeader && !!i.name.trim() &&
  (i.feeType ?? "分部分项") !== "总价措施" &&
  (i.feeType ?? "分部分项") !== "其他项目";

export interface QuotationItemDTO {
  id: string;
  fileId?: string | null;
  materialName: string;
  spec: string;
  unit: string;
  brand: string;
  price: string;
  sheetName: string;
  features: BoqSemanticFeature;
  createdAt?: string;
}

export interface CostFactDTO {
  id: string;
  factType: string;
  key: string;
  value: string;
  source: FactSource;
  confidence: number;
  createdBy: string;
  createdAt: string;
}

export interface ReceiptDTO {
  id: string;
  actionType: string;
  summary: string;
  reversible: boolean;
  /** 该记录已被撤销（存在指向它的 REVERT 回执） */
  reverted?: boolean;
  /** 该笔回执触及的清单行 id（before/after 快照并集），供行级改动痕迹用 */
  affectedIds?: string[];
  createdBy: string;
  createdAt: string;
}

/* ---------------- 列映射角色（file/excel.ts 与列映射视图共用） ---------------- */

export type ColumnRole =
  | "seq" | "code" | "name" | "feature" | "unit" | "quantity"
  | "unitPrice" | "totalPrice" | "materialName" | "spec" | "brand"
  | "price" | "laborPrice" | "machinePrice"
  | "region" | "period" | "priceType";

export const COLUMN_ROLES: ColumnRole[] = [
  "seq", "code", "name", "feature", "unit", "quantity",
  "unitPrice", "totalPrice", "materialName", "spec", "brand",
  "price", "laborPrice", "machinePrice",
  "region", "period", "priceType",
];

export const COLUMN_ROLE_LABEL: Record<ColumnRole, string> = {
  seq: "序号",
  code: "项目编码",
  name: "名称",
  feature: "项目特征",
  unit: "单位",
  quantity: "工程量",
  unitPrice: "综合单价",
  totalPrice: "合价",
  materialName: "材料名称",
  spec: "规格型号",
  brand: "品牌",
  price: "材料单价(主材)",
  laborPrice: "人工单价",
  machinePrice: "机械单价",
  region: "地区",
  period: "价格期",
  priceType: "价格类型",
};

/* ---------------- Workspace views ---------------- */

export type WorkspaceView =
  | {
      kind: "boqTable";
      id: string;
      title: string;
      filter?: { discipline?: Discipline; query?: string; onlyItems?: boolean };
    }
  | {
      kind: "anomalyTable";
      id: string;
      title: string;
      anomalyType:
        | "SAME_ITEM_DIFF_PRICE"
        | "PRICE_ANOMALY"
        | "FEATURE_MISMATCH"
        | "DUPLICATE"
        | "ARITHMETIC"
        | "UNIT_INCONSISTENT"
        | "CODE_MISMATCH"
        | "INVALID_CODE"
        | "MISSING_CODE"
        | "DATA_QUALITY"
        | "OWNER_SUPPLIED";
      rows: AnomalyRow[];
    }
  | {
      kind: "quotationMatch";
      id: string;
      title: string;
      rows: QuotationMatchRow[];
      unmatched: QuotationItemDTO[];
    }
  | {
      kind: "breakdown";
      id: string;
      title: string;
      mode: "discipline" | "material" | "unit";
      slices: BreakdownSlice[];
      total: string;
    }
  | {
      kind: "diff";
      id: string;
      title: string;
      receiptId: string;
      rows: DiffRow[];
    }
  | {
      kind: "quotaResult";
      id: string;
      title: string;
      rows: QuotaResultRow[];
      mgmtRate: number;
      profitRate: number;
    }
  | {
      kind: "fileCompare";
      id: string;
      title: string;
      labelA: string;
      labelB: string;
      /** 两版文件 id——供导出对审报告等确定性操作复用同一配对 */
      fileAId?: string;
      fileBId?: string;
      stageA?: string;
      periodA?: string;
      stageB?: string;
      periodB?: string;
      rows: FileCompareRow[];
      summary: {
        total: number; same: number; priceDiff: number;
        qtyDiff: number; onlyA: number; onlyB: number; totalDelta: string;
      };
      /** 两版都带单位工程汇总表时的申报口径对比（费用行 + 单位工程行） */
      declared?: {
        labels: { label: string; a: number; b: number; diff: number }[];
        units: { name: string; a: number; b: number; diff: number; side: "both" | "a" | "b" }[];
      };
    }
  | {
      kind: "document";
      id: string;
      title: string;
      pages: string[];
    }
  | { kind: "factList"; id: string; title: string; facts: CostFactDTO[] }
  | {
      kind: "feeSummary";
      id: string;
      title: string;
      rows: {
        seq: string; name: string; basis: string;
        rate: string | null; amount: string;
        level: "leaf" | "subtotal" | "total"; note?: string;
      }[];
      grandTotal: string;
      unpricedCount: number;
      /** 造价指标（单方造价等）；建筑面积事实缺省时不出 */
      indicators?: { label: string; value: string }[];
      /** 费用符合性检查问题（不可竞争费漏计/税率口径/暂列金额/限价超限） */
      issues?: { level: "error" | "warn"; label: string; detail: string }[];
    }
  | {
      kind: "costComposition";
      id: string;
      title: string;
      rows: CostCompositionRow[];
      totals: {
        revenue: string; coveredRevenue: string;
        labor: string; material: string; machine: string; other: string;
        /** 毛利可算口径（人材机三部分都已知的行）的收入/毛利/毛利率 */
        marginRevenue: string; margin: string; marginRate: string | null;
      };
      coverage: { plan: number; imported: number; partial: number; none: number; inverted: number };
    }
  | {
      kind: "measureFee";
      id: string;
      title: string;
      rows: {
        name: string; book: string; category: string; tier: string;
        basis: string; rate: string; amount: string;
        laborPart: string | null; materialPart: string | null; machinePart: string | null;
      }[];
      total: string;
      skipped: { name: string; reason: string }[];
    }
  | { kind: "overview"; id: string; title: string }
  | { kind: "receipts"; id: string; title: string }
  | {
      kind: "specResult";
      id: string;
      title: string;
      query: string;
      hits: { book: string; title: string; excerpt: string }[];
    }
  | {
      kind: "exportResult";
      id: string;
      title: string;
      artifactId: string;
      filename: string;
      summary: string;
    }
  | { kind: "fileList"; id: string; title: string }
  | { kind: "priceLibrary"; id: string; title: string }
  | {
      kind: "columnMapping";
      id: string;
      title: string;
      fileId: string;
      filename: string;
      fileStatus: string;
      sheets: {
        sheetName: string;
        type:
          | "BOQ" | "QUOTATION" | "GENERIC"
          | "COMPARE" | "APPROVAL" | "PENDING_QUOTE" | "FACTS" | "MATERIAL_PRICE";
        headerRow: number;
        headerCells: string[];
        sample: string[][];
        colCount: number;
        rowCount: number;
        columns: Record<string, number>;
        confidence: Record<string, number>;
        evidence: Record<string, string>;
        fingerprint: string | null;
        templateHit: boolean;
        userEdited: boolean;
        minConfidence: number;
        typeConfidence: number;
        typeEvidence: string;
      }[];
    };

export interface AnomalyRow {
  groupKey: string;
  label: string;
  items: {
    id: string;
    code: string;
    name: string;
    feature: string;
    unit: string;
    quantity: string;
    unitPrice: string;
    sectionPath: string;
  }[];
  prices: string[];
  spread?: string; // max-min
  reason: string;
}

export interface QuotationMatchRow {
  quotationItemId: string;
  materialName: string;
  spec: string;
  brand: string;
  price: string;
  matchedBoqItemIds: string[];
  matchedNames: string[];
  confidence: number;
  status: "MATCHED" | "UNMATCHED" | "LOW_CONFIDENCE";
}

export interface BreakdownSlice {
  key: string;
  label: string;
  amount: string;
  share: number; // 0..1
  count: number;
}

export interface DiffRow {
  itemId: string;
  code: string;
  name: string;
  field: string;
  before: string;
  after: string;
}

export interface FileCompareRow {
  key: string;
  code: string;
  name: string;
  status: "SAME" | "PRICE_DIFF" | "QTY_DIFF" | "BOTH_DIFF" | "ONLY_A" | "ONLY_B";
  aId?: string;
  bId?: string;
  aQty?: string;
  bQty?: string;
  aPrice?: string;
  bPrice?: string;
  aTotal?: string;
  bTotal?: string;
  qtyDelta?: string;
  priceDelta?: string;
  totalDelta?: string;
  /** 量差超基准量15%（GB50500：应重新组价） */
  qtyOver15?: boolean;
  /** 五统一：对齐行名称原文不一致 */
  nameMismatch?: boolean;
  /** 五统一：单位量纲不一致（归一后仍不同） */
  unitMismatch?: boolean;
  /** 五统一：项目特征语义冲突明细 */
  featureConflict?: string[];
}

/** 人材机成本构成行：金额均为合价口径；null = 该分量未知（混入 other）。 */
export interface CostCompositionRow {
  itemId: string;
  code: string;
  name: string;
  unit: string;
  quantity: string;
  revenue: string;
  labor: string | null;
  material: string | null;
  machine: string | null;
  /** 管利 + 未分解部分（= 合价 - 已知分量） */
  other: string;
  /** 人材机直接费（三部分均已知才可算） */
  directCost: string | null;
  /** 毛利 = 合价 - 人材机；marginRate 为百分比 */
  margin: string | null;
  marginRate: string | null;
  source: "quotaPlan" | "imported" | "partial" | "none";
  /** 直接费 > 合价：成本倒挂 */
  inverted: boolean;
}

export interface QuotaResultRow {
  itemId: string;
  code: string;
  name: string;
  quantity: string;
  listPrice: string;
  quotaCode: string | null;
  quotaName: string | null;
  labor: string | null;
  materialAux: string | null;
  machine: string | null;
  mainMaterial: string | null;
  fee: string | null;
  calcPrice: string | null;
  deviation: string | null;
  needsMainPrice: boolean;
  quotaGcnr?: string | null;
  quotaFb?: string | null;
  quotaChapter?: string | null;
  quotaBase?: string | null;
  quotaMainName?: string | null;
  /** 存在得分相近且基价不同的备选子目 */
  ambiguous?: boolean;
  altQuota?: string | null;
  /** 组价方案：第1行主项（计入测算价），suggested 行为工作内容缺口的建议增列 */
  plan?: PricingPlanLine[];
}

/* ---------------- Agent events (SSE wire + persisted) ---------------- */

export type AgentEventType =
  | "activity"
  | "activity_live" // 原地更新当前 live activity 的文本（心跳，不落库）
  | "thought"
  | "thought_delta"
  | "message"
  | "tool_started"
  | "tool_finished"
  | "workspace_patch"
  | "receipt"
  | "confirm_request"
  | "confirm_resolved"
  | "model_fallback" // 模型不可用 → 降级规则引擎（前端据此显示模式横幅）
  | "run_finished"
  | "error";

export interface AgentEventDTO {
  seq: number;
  type: AgentEventType;
  payload: Record<string, unknown>;
}

export const FILE_KIND_LABEL: Record<FileKind, string> = {
  BOQ_TENDER: "招标清单",
  BOQ_WINNING: "中标清单",
  BOQ_SETTLEMENT: "结算清单",
  MATERIAL_QUOTATION: "材料询价",
  OWNER_SUPPLIED: "甲供材",
  CONTRACT: "合同",
  CHANGE: "变更",
  VISA: "签证",
  DRAWING: "图纸",
  UNKNOWN: "未识别",
};

export const DISCIPLINE_LABEL: Record<Discipline, string> = {
  ELECTRICAL: "电气",
  PLUMBING: "给排水",
  FIRE: "消防",
  HVAC: "暖通",
  WEAK_CURRENT: "弱电智能化",
  OTHER: "其他",
};
