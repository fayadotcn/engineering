import { NextResponse } from "next/server";
import { getProject } from "@project/service";
import { toFactDTO } from "@database/serialize";
import { FILE_KIND_LABEL, type FileKind } from "@shared/types";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await getProject(id);
  if (!p) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({
    id: p.id,
    name: p.name,
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
  });
}
