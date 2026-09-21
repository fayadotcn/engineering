import { prisma } from "@database/client";
import { toFactDTO } from "@database/serialize";
import type { CostFactDTO, FactSource } from "@shared/types";

// Cost Fact Ledger: project-level facts the agent reads before every task.
// INFERRED facts are tagged — never silently treated as user truth.

export async function getFacts(projectId: string): Promise<CostFactDTO[]> {
  const rows = await prisma.costFact.findMany({
    where: { projectId },
    orderBy: [{ factType: "asc" }, { createdAt: "desc" }],
  });
  return rows.map(toFactDTO);
}

export async function getFact(
  projectId: string,
  key: string
): Promise<CostFactDTO | null> {
  const row = await prisma.costFact.findFirst({
    where: { projectId, key },
    orderBy: { createdAt: "desc" },
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
  const row = await prisma.costFact.create({
    data: {
      projectId,
      factType: input.factType,
      key: input.key,
      value: input.value,
      source: input.source,
      sourceFileId: input.sourceFileId,
      confidence: input.confidence ?? (input.source === "INFERRED" ? 0.6 : 1),
      createdBy: input.createdBy ?? "agent",
      agentRunId: input.agentRunId,
    },
  });
  return toFactDTO(row);
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
  if (!raw) return null;
  const v = Number(String(raw).replace(/[%\s]/g, ""));
  if (!Number.isFinite(v)) return null;
  return Math.abs(v) > 1 ? v / 100 : v;
}

/** 金额事实归一化：「50万」→ 500000，「5000元」→ 5000。 */
export function parseAmountValue(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = String(raw).replace(/[,，\s元]/g, "");
  const wan = s.match(/^([\d.]+)万$/);
  const v = wan ? Number(wan[1]) * 10000 : Number(s);
  return Number.isFinite(v) ? v : null;
}

/** 加载取费参数（台账事实 → FeeParams），供 cost.feeSummary 工具与报告导出共用。 */
export async function loadFeeParams(projectId: string): Promise<import("@cost-engine/fees").FeeParams> {
  const { D } = await import("@cost-engine/money");
  const rate = async (key: string) => {
    const f = await getFact(projectId, key);
    const v = parseRateValue(f?.value);
    return { v: D(v ?? 0), set: v !== null };
  };
  const [measure, regulation, provRate, provFact, taxF, laborFact, coeffFact] = await Promise.all([
    rate("措施费率"), rate("规费费率"), rate("暂列金额率"),
    getFact(projectId, "暂列金额"), getFact(projectId, "税率"),
    getFact(projectId, "定额人工费"), getFact(projectId, "系数措施费"),
  ]);
  const provAmt = parseAmountValue(provFact?.value);
  const tax = parseRateValue(taxF?.value);
  const labor = laborFact ? Number(laborFact.value) : null;
  const coeff = coeffFact ? Number(coeffFact.value) : null;
  return {
    measureRate: measure.v, regulationRate: regulation.v,
    provisionalRate: provRate.v, provisionalAmount: D(provAmt ?? 0),
    taxRate: D(tax ?? 0.09),
    laborBase: labor !== null && Number.isFinite(labor) && labor > 0 ? D(labor) : null,
    coeffMeasureFee: coeff !== null && Number.isFinite(coeff) && coeff > 0 ? D(coeff) : D(0),
    set: { measure: measure.set, regulation: regulation.set, provisional: provRate.set || provAmt !== null, tax: tax !== null },
  };
}
