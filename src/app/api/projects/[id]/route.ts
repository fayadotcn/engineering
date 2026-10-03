import { NextResponse } from "next/server";
import { getProject } from "@project/service";
import { toFactDTO } from "@database/serialize";
import { FILE_KIND_LABEL, type FileKind } from "@shared/types";
import { fromJson } from "@shared/json";
import { prisma } from "@database/client";
import { z } from "zod";

// 回执的 before/after 快照里都带行 id，提出来让清单表能把「这行被改过」标在行号上
const rowIdsOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((r) => (r as { id?: unknown })?.id).filter((x): x is string => typeof x === "string") : [];

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await getProject(id);
  if (!p) return NextResponse.json({ error: "not found" }, { status: 404 });
  const receipts = await prisma.actionReceipt.findMany({
    where: { projectId: id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  // REVERT 回执把被撤销的那条 id 记在 toolCallId 上，面板据此显示「已撤销」而非「不可撤销」
  const revertedIds = new Set(receipts.filter((r) => r.actionType === "REVERT" && r.toolCallId).map((r) => r.toolCallId as string));
  return NextResponse.json({
    id: p.id,
    name: p.name,
    files: p.files.map((f) => ({
      id: f.id,
      filename: f.filename,
      kind: f.kind,
      kindLabel: FILE_KIND_LABEL[f.kind as FileKind] ?? f.kind,
      status: f.status,
      stage: f.stage,
      period: f.period,
      sizeBytes: f.sizeBytes,
      createdAt: f.createdAt,
    })),
    facts: p.facts.map(toFactDTO),
    artifacts: p.artifacts.map((a) => ({
      id: a.id,
      label: a.label,
      kind: a.kind,
      createdAt: a.createdAt,
    })),
    receipts: receipts.map((r) => ({
      id: r.id,
      actionType: r.actionType,
      summary: r.summary,
      reversible: r.reversible,
      reverted: revertedIds.has(r.id),
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      affectedIds: [...new Set([...rowIdsOf(fromJson(r.before, [])), ...rowIdsOf(fromJson(r.after, []))])],
    })),
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = z.object({ name: z.string().trim().min(1).max(120) }).strict().safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "工程名称不能为空" }, { status: 400 });
  if (!await prisma.project.findUnique({ where: { id } })) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  await prisma.project.update({ where: { id }, data: parsed.data });
  return NextResponse.json({ ok: true });
}
