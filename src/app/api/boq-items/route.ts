import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { toJson } from "@shared/json";
import { toBoqDTO } from "@database/serialize";
import { D, lineTotal, round2, round3 } from "@cost-engine/money";
import { inferDiscipline, parseSemanticFeature } from "@cost-engine/semantic";
import { z } from "zod";

const create = z.object({
  projectId: z.string().min(1),
  name: z.string().trim().min(1).max(500),
  code: z.string().max(100).optional(),
  unit: z.string().max(20).optional(),
  quantity: z.string().optional(),
  quantityExpr: z.string().max(500).optional(),
  unitPrice: z.string().optional(),
  mainMaterialPrice: z.string().optional(),
  /** 总额计价行（总价措施/其他项目）的合价 */
  totalPrice: z.string().optional(),
  feeType: z.enum(["分部分项", "单价措施", "总价措施", "其他项目"]).optional(),
  /** 复制行锚点：新行紧随该源行，沿用其表名/分部/专业归属 */
  insertAfter: z.string().optional(),
  /** 复制时透传的原文特征与人材机分解/组价方案，保证复制品与原行一致可复核 */
  rawFeature: z.string().max(4000).optional(),
  laborUnitPrice: z.string().optional(),
  machineUnitPrice: z.string().optional(),
  pricingPlan: z.string().max(40000).optional(),
}).strict();

// 手工补录一行清单（导入漏项的常见补救）。回执 after 带整行快照，
// 撤销 = 删除该行；删除行的撤销 = 原样重建 —— 两个方向都可回滚。
export async function POST(req: Request) {
  const parsed = create.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "补录内容无效" }, { status: 400 });
  const body = parsed.data;
  const project = await prisma.project.findUnique({ where: { id: body.projectId }, select: { id: true } });
  if (!project) return NextResponse.json({ error: "工程不存在" }, { status: 404 });

  const lumpSum = body.feeType === "总价措施" || body.feeType === "其他项目";
  const qty = lumpSum ? D(0) : round3(D(body.quantity ?? "0"));
  const price = lumpSum ? D(0) : round2(D(body.unitPrice ?? "0"));
  const mainMat = round2(D(body.mainMaterialPrice ?? "0"));
  const labor = round2(D(body.laborUnitPrice ?? "0"));
  const machine = round2(D(body.machineUnitPrice ?? "0"));
  const total = lumpSum ? round2(D(body.totalPrice ?? "0")) : lineTotal(qty, price);
  if (!qty.isFinite() || qty.lt(0) || !price.isFinite() || price.lt(0) || !mainMat.isFinite() || mainMat.lt(0)
    || !labor.isFinite() || labor.lt(0) || !machine.isFinite() || machine.lt(0) || !total.isFinite() || total.lt(0))
    return NextResponse.json({ error: "工程量、单价与金额必须为非负有效数字" }, { status: 400 });

  // 复制行：insertAfter 锚定源行 —— 列表排序是（文件导入序 → sortOrder），所以新行
  // 必须带走源行的 fileId 才能落在它下面；后移也只应发生在源行所属文件的范围内。
  const src = body.insertAfter ? await prisma.boqItem.findUnique({ where: { id: body.insertAfter } }) : null;
  if (body.insertAfter && (!src || src.projectId !== project.id))
    return NextResponse.json({ error: "源行不存在" }, { status: 404 });
  const max = src ? null : await prisma.boqItem.aggregate({ where: { projectId: project.id }, _max: { sortOrder: true } });
  const plan = body.pricingPlan?.trim().startsWith("[") ? body.pricingPlan : "[]";
  const txResult = await prisma.$transaction([
    ...(src ? [prisma.boqItem.updateMany({ where: { projectId: project.id, fileId: src.fileId, sortOrder: { gt: src.sortOrder } }, data: { sortOrder: { increment: 1 } } })] : []),
    prisma.boqItem.create({
      data: {
        projectId: project.id,
        fileId: src?.fileId ?? null,
        sheetName: src?.sheetName ?? "手工补录",
        sectionPath: src?.sectionPath ?? "",
        rowIndex: -1,
        code: body.code ?? "",
        name: body.name,
        rawFeature: body.rawFeature ?? "",
        unit: body.unit ?? "",
        quantity: qty,
        quantityExpr: body.quantityExpr ?? "",
        unitPrice: price,
        mainMaterialPrice: mainMat,
        laborUnitPrice: labor,
        machineUnitPrice: machine,
        pricingPlan: plan,
        totalPrice: total,
        feeType: body.feeType ?? "分部分项",
        features: toJson(parseSemanticFeature(body.name, body.rawFeature ?? "")),
        discipline: src?.discipline ?? inferDiscipline(body.name, "", ""),
        sortOrder: src ? src.sortOrder + 1 : (max!._max.sortOrder ?? -1) + 1,
      },
    }),
    prisma.actionReceipt.create({
      data: {
        projectId: project.id,
        actionType: "USER_EDIT",
        summary: src ? `用户在工作区复制清单行「${body.name}」` : `用户在工作区补录清单行「${body.name}」`,
        before: toJson([]),
        createdBy: "user",
      },
    }),
  ]);
  const item = txResult[txResult.length - 2] as Awaited<ReturnType<typeof prisma.boqItem.create>>;
  const receipt = txResult[txResult.length - 1] as Awaited<ReturnType<typeof prisma.actionReceipt.create>>;
  // 回执 after 需要新行 id —— create 与 receipt 同事务写入后补记快照
  await prisma.actionReceipt.update({ where: { id: receipt.id }, data: { after: toJson([toBoqDTO(item)]) } });
  // 回执 id 一并返回，前端 toast 可直接给「撤销」入口
  return NextResponse.json({ item: toBoqDTO(item), receiptId: receipt.id });
}
