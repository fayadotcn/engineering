import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { toJson } from "@shared/json";
import { createBoqItem } from "@boq/service";
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

  // 行创建 + 回执同事务——任一步失败不留无审计的孤儿行
  try {
    const { item, receipt } = await prisma.$transaction(async (tx) => {
      const item = await createBoqItem(project.id, body, tx);
      const receipt = await tx.actionReceipt.create({
        data: {
          projectId: project.id,
          actionType: "USER_EDIT",
          summary: body.insertAfter ? `用户在工作区复制清单行「${body.name}」` : `用户在工作区补录清单行「${body.name}」`,
          before: toJson([]),
          after: toJson([item]),
          createdBy: "user",
        },
      });
      return { item, receipt };
    });
    // 回执 id 一并返回，前端 toast 可直接给「撤销」入口
    return NextResponse.json({ item, receiptId: receipt.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "补录失败";
    return NextResponse.json({ error: msg }, { status: msg === "源行不存在" ? 404 : 400 });
  }
}
