import { NextResponse } from "next/server";
import { getProject } from "@project/service";
import { toFactDTO } from "@database/serialize";
import { FILE_KIND_LABEL, type FileKind } from "@shared/types";
import { prisma } from "@database/client";
import { z } from "zod";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await getProject(id);
  if (!p) return NextResponse.json({ error: "not found" }, { status: 404 });
  const receipts = await prisma.actionReceipt.findMany({
    where: { projectId: id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return NextResponse.json({
    id: p.id,
    name: p.name,
    harnessSessionId: p.harnessSessionId,
    files: p.files.map((f) => ({
      id: f.id,
      filename: f.filename,
      kind: f.kind,
      kindLabel: FILE_KIND_LABEL[f.kind as FileKind] ?? f.kind,
      status: f.status,
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
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
    })),
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = z.object({ harnessSessionId: z.string().regex(/^session-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i) }).strict().safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "会话 ID 无效" }, { status: 400 });
  if (!await prisma.project.findUnique({ where: { id } })) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  await prisma.project.update({ where: { id }, data: parsed.data });
  return NextResponse.json({ ok: true });
}
