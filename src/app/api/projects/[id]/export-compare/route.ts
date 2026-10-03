import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { buildCompareReport } from "@file/compareReport";

/** 一键导出两版清单对审报告 xlsx（确定性管道，不走模型）：与 report.exportCompare 同一份组装口径。
 *  ?a=<fileId>&b=<fileId> 指定对审对；缺省按阶段/期次自动配对。 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await prisma.project.findUnique({ where: { id }, select: { name: true } });
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  const url = new URL(req.url);
  const built = await buildCompareReport(id, {
    fileAId: url.searchParams.get("a") ?? undefined,
    fileBId: url.searchParams.get("b") ?? undefined,
  });
  if ("error" in built) return NextResponse.json({ error: built.error }, { status: 400 });
  return new NextResponse(new Uint8Array(built.out), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(built.filename)}`,
      "Content-Length": String(built.out.length),
    },
  });
}
