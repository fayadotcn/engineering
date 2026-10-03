import { prisma } from "@database/client";
import { toFactDTO } from "@database/serialize";
import { normalizePeriod } from "@dataset/priceParse";
import type { CostFactDTO, FactSource } from "@shared/types";

// Cost Fact Ledger: project-level facts the agent reads before every task.
// INFERRED facts are tagged — never silently treated as user truth.

export async function getFacts(projectId: string): Promise<CostFactDTO[]> {
  const rows = await prisma.costFact.findMany({
    where: { projectId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return rows.map(toFactDTO);
}

export async function getFact(
  projectId: string,
  key: string
): Promise<CostFactDTO | null> {
  const row = await prisma.costFact.findFirst({
    where: { projectId, key },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return row ? toFactDTO(row) : null;
}

export async function setFact(
  projectId: string,
  input: {
    factType: string;
    key: string;
    value: string;
    source: FactSource;
    sourceFileId?: string;
    confidence?: number;
    createdBy?: string;
    agentRunId?: string;
  }
): Promise<CostFactDTO> {
  validatePricingFact(input.key, input.value);
  const row = await prisma.costFact.create({
    data: {
      projectId,
      factType: pricingFactType(input.key) ?? input.factType,
      key: input.key,
      // 价格期归一化落库：「2024年6月」「2024.6」→「2024-06」，季度→「2024-Q2」，期次排序/偏好匹配才有统一口径
      value: input.key === "价格期" ? normalizePeriod(input.value) : input.value,
      source: input.source,
      sourceFileId: input.sourceFileId,
      confidence: input.confidence ?? (input.source === "INFERRED" ? 0.6 : 1),
      createdBy: input.createdBy ?? "agent",
      agentRunId: input.agentRunId,
    },
  });
  return toFactDTO(row);
}

export function pricingFactType(key: string): string | null {
  if (key === "地区") return "REGION";
  if (/品牌/.test(key)) return "BRAND";
  if (/费率|利润率|税率|暂列金额率/.test(key)) return "RATE";
  return null;
}

/** Applied at each fact write boundary; consumers only read normalized values. */
export function validatePricingFact(key: string, value: string): void {
  if (!value.trim()) return;
  if (/费率|利润率|税率|暂列金额率|调整系数/.test(key)) {
    const rate = parseRateValue(value);
    if (rate === null || rate < 0 || rate > 1) throw new Error(`${key}应为 0%–100% 的有效费率`);
  } else if (key === "暂列金额") {
    const amount = parseAmountValue(value);
    if (amount === null || amount < 0) throw new Error("暂列金额应为非负金额");
  } else if (["檐口高度", "操作物高度"].includes(key) && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
    throw new Error(`${key}应为非负米数`);
  } else if (/面积/.test(key)) {
    const area = parseAreaValue(value);
    if (area === null || area < 0) throw new Error(`${key}应为非负平方米数`);
  } else if (key === "价格期" && !/^20\d{2}-(0[1-9]|1[0-2]|Q[1-4])$/.test(normalizePeriod(value))) {
    throw new Error("价格期请填写 YYYY-MM 或季度（如 2024-Q2、2024年6月）");
  } else if (key === "价格类型" && !["INFO", "MARKET", "SUPPLY", "LABOR", "信息价", "市场价", "供应价", "人工价"].includes(value)) {
    throw new Error("价格类型应为信息价、市场价、供应价或人工价");
  }
}

/** Facts as a compact map for the planner/system context. */
export async function factMap(projectId: string): Promise<Map<string, CostFactDTO>> {
  const facts = await getFacts(projectId);
  const map = new Map<string, CostFactDTO>();
  for (const f of facts) if (!map.has(f.key)) map.set(f.key, f);
  return map;
}

/**
 * 费率事实归一化：「9%」/「9」/「0.09」→ 0.09。>1 视为百分数，≤1 视为小数。
 * 返回 null 表示无法解析（消费方按未设置处理，绝不 NaN）。
 */
export function parseRateValue(raw: string | null | undefined): number | null {
  if (!raw?.trim()) return null;
  const text = raw.trim();
  const v = Number(text.replace(/[%％\s]/g, ""));
  if (!Number.isFinite(v)) return null;
  return /[%％]/.test(text) || Math.abs(v) > 1 ? v / 100 : v;
}

/** 金额事实归一化：「50万」→ 500000，「1.2亿」→ 120000000，「5000元」→ 5000。 */
export function parseAmountValue(raw: string | null | undefined): number | null {
  if (!raw?.trim()) return null;
  const s = String(raw).replace(/[,，\s元]/g, "");
  const yi = s.match(/^(-?[\d.]+)亿$/);
  const wan = s.match(/^(-?[\d.]+)万$/);
  const v = yi ? Number(yi[1]) * 1e8 : wan ? Number(wan[1]) * 10000 : Number(s);
  return Number.isFinite(v) ? v : null;
}

/** 面积事实归一化：「12000㎡」/「1.2万平米」→ 12000。 */
export function parseAreaValue(raw: string | null | undefined): number | null {
  if (!raw?.trim()) return null;
  const s = String(raw).replace(/平方米|平米|㎡|m²|m2/gi, "");
  return parseAmountValue(s);
}

/** 加载取费参数（台账事实 → FeeParams），供 cost.feeSummary 工具与报告导出共用。 */
export async function loadFeeParams(projectId: string): Promise<import("@cost-engine/fees").FeeParams> {
  const { D } = await import("@cost-engine/money");
  const rate = async (key: string) => {
    const f = await getFact(projectId, key);
    const v = parseRateValue(f?.value);
    return { v: D(v ?? 0), set: v !== null };
  };
  const [measure, regulation, provRate, provFact, taxF, addonF, laborFact, coeffFact, laborAdj] = await Promise.all([
    rate("措施费率"), rate("规费费率"), rate("暂列金额率"),
    getFact(projectId, "暂列金额"), getFact(projectId, "税率"), getFact(projectId, "附加税率"),
    getFact(projectId, "定额人工费"), getFact(projectId, "系数措施费"), rate("人工费调整系数"),
  ]);
  const provAmt = parseAmountValue(provFact?.value);
  const tax = parseRateValue(taxF?.value);
  const addon = parseRateValue(addonF?.value);
  const labor = parseAmountValue(laborFact?.value);
  const coeff = parseAmountValue(coeffFact?.value);
  return {
    measureRate: measure.v, regulationRate: regulation.v,
    provisionalRate: provRate.v, provisionalAmount: D(provAmt ?? 0),
    taxRate: D(tax ?? 0),
    addonRate: D(addon ?? 0),
    laborBase: labor !== null && Number.isFinite(labor) && labor > 0 ? D(labor) : null,
    laborAdjustRate: laborAdj.v,
    coeffMeasureFee: coeff !== null && Number.isFinite(coeff) && coeff > 0 ? D(coeff) : D(0),
    set: { measure: measure.set, regulation: regulation.set, provisional: provRate.set || provAmt !== null, tax: tax !== null },
  };
}
