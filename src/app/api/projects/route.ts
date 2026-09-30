import { NextResponse } from "next/server";
import { createProject, listProjects } from "@project/service";
import { z } from "zod";

export async function GET() {
  return NextResponse.json(await listProjects());
}

export async function POST(req: Request) {
  const input = z.object({ name: z.string().trim().min(1).max(120) }).strict().safeParse(await req.json().catch(() => null));
  if (!input.success) return NextResponse.json({ error: "工程名称应为 1–120 个字符" }, { status: 400 });
  const p = await createProject(input.data.name);
  return NextResponse.json(p);
}
