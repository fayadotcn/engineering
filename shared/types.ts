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
  /** 综合单价（人材机管利五要素组价结果），材料价/询价绝不能直接写入 */
  unitPrice: string;
  /** 主材/设备暂估价（询价/信息价），是组价输入而非综合单价 */
  mainMaterialPrice: string;
  /** 组价方案（多定额子目组合）；空数组=未组价，综合单价是原清单价/手工价 */
  pricingPlan: PricingPlanLine[];
  totalPrice: string;
  feeType: FeeType;
  sectionPath: string;
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
  createdBy: string;
  createdAt: string;
}

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
      anomalyType: "SAME_ITEM_DIFF_PRICE" | "PRICE_ANOMALY" | "FEATURE_MISMATCH" | "DUPLICATE";
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
      mode: "discipline" | "material";
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
      rows: FileCompareRow[];
      summary: {
        total: number; same: number; priceDiff: number;
        qtyDiff: number; onlyA: number; onlyB: number; totalDelta: string;
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
  | { kind: "fileList"; id: string; title: string };

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
