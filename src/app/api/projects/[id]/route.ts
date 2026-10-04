import { NextResponse } from "next/server";
import { loadProjectPayload } from "@project/payload";
import { prisma } from "@database/client";
import { z } from "zod";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const payload = await loadProjectPayload(id);
  if (!payload) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(payload);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = z.object({ name: z.string().trim().min(1).max(120) }).strict().safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "工程名称不能为空" }, { status: 400 });
  if (!await prisma.project.findUnique({ where: { id } })) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  await prisma.project.update({ where: { id }, data: parsed.data });
  return NextResponse.json({ ok: true });
}
