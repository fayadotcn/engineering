import { prisma } from "@database/client";
import { listBoq } from "@boq/service";
import { listQuotations } from "@material/service";
import { getFacts } from "@project/facts";
import { projectTotals } from "@cost-engine/aggregate";
import { fromJson } from "@shared/json";
import { FILE_KIND_LABEL, type FileKind } from "@shared/types";

// Context Resolver: everything the planner sees before deciding.
// Facts first — the agent reads the ledger instead of re-guessing.

export interface RunContext {
  projectId: string;
  projectName: string;
  files: { id: string; filename: string; kind: string; status: string }[];
  facts: { key: string; value: string; source: string }[];
  boq: { itemCount: number; pricedCount: number; totalAmount: string };
  quotationCount: number;
  recentChanges: string[]; // recent receipts incl. user edits in workspace
  history: { role: string; text: string }[];
}

export async function resolveContext(
  projectId: string,
  historyLimit = 6
): Promise<RunContext> {
  const [project, items, quotes, facts, receipts, runs] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, include: { files: true } }),
    listBoq(projectId),
    listQuotations(projectId),
    getFacts(projectId),
    prisma.actionReceipt.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
    prisma.agentRun.findMany({
      where: { projectId, status: "DONE" },
      orderBy: { createdAt: "desc" },
      take: historyLimit,
      include: { events: { where: { type: "message" }, orderBy: { seq: "asc" }, take: 4 } },
    }),
  ]);
  if (!project) throw new Error("项目不存在");
  return {
    projectId,
    projectName: project.name,
    files: project.files.map((f) => ({
      id: f.id,
      filename: f.filename,
      kind: FILE_KIND_LABEL[f.kind as FileKind] ?? f.kind,
      status: f.status,
    })),
    facts: facts.map((f) => ({ key: f.key, value: f.value, source: f.source })),
    boq: projectTotals(items),
    quotationCount: quotes.length,
    recentChanges: receipts.map((r) => `${r.createdBy}:${r.summary}`),
    history: runs
      .reverse()
      .flatMap((r) => [
        { role: "user", text: r.userMessage },
        ...(r.summary ? [{ role: "assistant", text: r.summary }] : []),
      ]),
  };
}
