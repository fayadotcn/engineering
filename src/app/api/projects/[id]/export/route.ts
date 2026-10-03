import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { buildProjectExport } from "@boq/export";

/** 一键导出当前清单为 xlsx（确定性管道，不走模型）：与 report.exportExcel 同一份组装口径 */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await prisma.project.findUnique({ where: { id }, select: { name: true } });
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  const built = await buildProjectExport(id);
  if (!built) return NextResponse.json({ error: "清单为空，没有可导出的内容" }, { status: 400 });
  const filename = `${project.name}_清单_${new Date().toISOString().slice(0, 10)}.xlsx`;
  return new NextResponse(new Uint8Array(built.out), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Content-Length": String(built.out.length),
    },
  });
}
