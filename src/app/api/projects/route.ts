import { NextResponse } from "next/server";
import { createProject, listProjects } from "@project/service";

export async function GET() {
  return NextResponse.json(await listProjects());
}

export async function POST(req: Request) {
  const { name } = await req.json();
  if (!name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
  const p = await createProject(name.trim());
  return NextResponse.json(p);
}
