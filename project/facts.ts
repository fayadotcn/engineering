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
