import { z } from "zod";
import { registerTool } from "./registry";
import { listBoq, updateBoqItems } from "@boq/service";
import {
  findArithmeticMismatches,
  findDuplicateItems,
  findFeatureMismatch,
  findPriceAnomalies,
  findSameItemDifferentPrice,
} from "@cost-engine/compare";
import { fmtMoney } from "@cost-engine/money";
import type { AnomalyRow, DiffRow, WorkspaceView } from "@shared/types";

const ANOMALY_LABEL: Record<string, string> = {
  SAME_ITEM_DIFF_PRICE: "相同项不同单价",
  PRICE_ANOMALY: "综合单价异常",
  FEATURE_MISMATCH: "项目特征不一致",
  DUPLICATE: "重复清单项",
  ARITHMETIC: "合价算术校验",
};

function anomalyView(anomalyType: string, rows: AnomalyRow[]): WorkspaceView {
  return {
    kind: "anomalyTable",
    id: `view:anomaly:${anomalyType}`,
    title: ANOMALY_LABEL[anomalyType] ?? "异常项",
    anomalyType: anomalyType as never,
    rows,
  };
}

registerTool({
  name: "boq.read",
  description: "读取项目工程量清单（在工作区打开清单表）",
  implemented: true,
  schema: z.object({}),
  handler: async (ctx) => {
    const items = await listBoq(ctx.projectId);
    return {
      observation: { count: items.filter((i) => !i.isHeader).length },
      views: [{ kind: "boqTable", id: "view:boq", title: "工程量清单" }],
    };
  },
});

registerTool({
  name: "boq.search",
  description: "按关键词搜索清单项（名称/编码/项目特征）",
  implemented: true,
  schema: z.object({ query: z.string() }),
  handler: async (ctx, args: { query: string }) => {
    const items = await listBoq(ctx.projectId);
    const q = args.query.toLowerCase();
    const hits = items.filter(
      (i) =>
        !i.isHeader &&
        (i.name.toLowerCase().includes(q) ||
          i.code.includes(args.query) ||
          i.rawFeature.toLowerCase().includes(q))
    );
    return {
      observation: hits.slice(0, 30).map((i) => ({
        id: i.id,
        code: i.code,
        name: i.name,
        unit: i.unit,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
      })),
    };
  },
});

registerTool({
  name: "boq.filter",
  description: "按条件过滤清单项并在工作区展示",
  implemented: true,
  schema: z.object({
    discipline: z.string().optional(),
    query: z.string().optional(),
    onlyItems: z.boolean().optional(),
  }),
  handler: async (ctx, args) => {
    return {
      observation: { applied: true },
      views: [
        {
          kind: "boqTable",
          id: "view:boq",
          title: "工程量清单",
          filter: args as never,
        },
      ],
    };
  },
});

registerTool({
  name: "boq.findSameItemDifferentPrice",
  description: "检查相同清单项（语义相同：同类别/材质/规格/连接方式/系统）但综合单价不同的项，工程量为0自动忽略",
  implemented: true,
  schema: z.object({}),
  handler: async (ctx) => {
    const items = await listBoq(ctx.projectId);
    const rows = findSameItemDifferentPrice(items);
    return {
      observation: { count: rows.length, groups: rows.map((r) => r.label).slice(0, 20) },
      views: [anomalyView("SAME_ITEM_DIFF_PRICE", rows)],
      message: rows.length
        ? `发现 ${rows.length} 组相同项不同单价`
        : "未发现相同项不同单价",
    };
  },
});

registerTool({
  name: "boq.findPriceAnomalies",
  description: "检查综合单价异常：同语义组内偏离中位价超过阈值（默认15%）",
  implemented: true,
  schema: z.object({ ratio: z.number().optional() }),
  handler: async (ctx, args: { ratio?: number }) => {
    const items = await listBoq(ctx.projectId);
    const rows = findPriceAnomalies(items, { anomalyRatio: args.ratio });
    return {
      observation: { count: rows.length },
      views: [anomalyView("PRICE_ANOMALY", rows)],
      message: rows.length
        ? `发现 ${rows.length} 组综合单价异常`
        : "未发现单价异常",
    };
  },
});

registerTool({
  name: "boq.findFeatureMismatch",
  description: "检查编码/名称相同但项目特征语义不一致的清单项",
  implemented: true,
  schema: z.object({}),
  handler: async (ctx) => {
    const items = await listBoq(ctx.projectId);
    const rows = findFeatureMismatch(items);
    return {
      observation: { count: rows.length },
      views: [anomalyView("FEATURE_MISMATCH", rows)],
      message: rows.length
        ? `发现 ${rows.length} 组项目特征不一致`
        : "未发现项目特征不一致",
    };
  },
});

registerTool({
  name: "boq.findDuplicateItems",
  description: "检查重复清单项（编码+语义特征一致）",
  implemented: true,
  schema: z.object({}),
  handler: async (ctx) => {
    const items = await listBoq(ctx.projectId);
    const rows = findDuplicateItems(items);
    return {
      observation: { count: rows.length },
      views: [anomalyView("DUPLICATE", rows)],
      message: rows.length ? `发现 ${rows.length} 组疑似重复项` : "未发现重复项",
    };
  },
});

registerTool({
  name: "boq.findArithmeticMismatches",
  description: "清标算术校验：检查可计价行的合价是否等于 工程量×综合单价，不符说明源表算错或公式断链",
  implemented: true,
  schema: z.object({}),
  handler: async (ctx) => {
    const items = await listBoq(ctx.projectId);
    const rows = findArithmeticMismatches(items);
    const n = rows[0]?.items.length ?? 0;
    return {
      observation: { count: n, totalDiff: rows[0]?.spread ?? "0" },
      views: [anomalyView("ARITHMETIC", rows)],
      message: rows.length ? `发现 ${n} 项合价与量×价不符（差异合计 ${fmtMoney(rows[0].spread ?? 0)} 元）` : "合价算术校验通过",
    };
  },
});

registerTool({
  name: "boq.compare",
  description: "对比清单：相同项不同价 + 单价异常 + 特征不一致 + 合价算术校验（一次全查）",
  implemented: true,
  schema: z.object({}),
  handler: async (ctx) => {
    const items = await listBoq(ctx.projectId);
    const a = findSameItemDifferentPrice(items);
    const b = findPriceAnomalies(items);
    const c = findFeatureMismatch(items);
    const d = findArithmeticMismatches(items);
    const arith = d[0]?.items.length ?? 0;
    return {
      observation: { sameItemDiffPrice: a.length, priceAnomalies: b.length, featureMismatch: c.length, arithmeticMismatch: arith },
      views: [
        anomalyView("SAME_ITEM_DIFF_PRICE", a),
        anomalyView("PRICE_ANOMALY", b),
        anomalyView("FEATURE_MISMATCH", c),
        anomalyView("ARITHMETIC", d),
      ],
      message: `全面检查完成：相同项不同价 ${a.length} 组，单价异常 ${b.length} 组，特征不一致 ${c.length} 组，合价算术不符 ${arith} 项`,
    };
  },
});

registerTool({
  name: "boq.compareFiles",
  description: "两版清单对审：按编码/语义对齐，输出价差/量差/独有项与总价差额；自动按文件阶段配对（招标vs中标/结算、上期vs本期进度），两份都带汇总表时附申报口径对比",
  implemented: true,
  schema: z.object({
    fileAId: z.string().optional().describe("基准文件；缺省按阶段/期次自动配对取基准侧"),
    fileBId: z.string().optional().describe("对比文件；缺省按阶段/期次自动配对取对比侧"),
  }),
  handler: async (ctx, args: { fileAId?: string; fileBId?: string }) => {
    const { prisma } = await import("@database/client");
    const { getFact } = await import("@project/facts");
    const { compareBoqSets, compareSummary, compareDeclaredFees, pickComparePair } = await import("@cost-engine/fileCompare");
    const files = await prisma.projectFile.findMany({
      where: { projectId: ctx.projectId, kind: { startsWith: "BOQ" }, status: "PARSED" },
      orderBy: { createdAt: "asc" },
    });
    if (files.length < 2 && !args.fileAId && !args.fileBId)
      return { observation: { error: "需要两份清单文件才能对审，请再上传一版（如中标/结算/进度申报清单）" } };
    const [autoA, autoB] = files.length >= 2 ? pickComparePair(files) : [files[0], files[0]];
    const fileA = args.fileAId ? files.find((f) => f.id === args.fileAId) : autoA;
    const fileB = args.fileBId ? files.find((f) => f.id === args.fileBId) : autoB;
    if (!fileA || !fileB || fileA.id === fileB.id)
      return { observation: { error: "文件选择无效" } };

    const items = await listBoq(ctx.projectId);
    const a = items.filter((i) => i.fileId === fileA.id);
    const b = items.filter((i) => i.fileId === fileB.id);
    const rows = compareBoqSets(a, b);
    const summary = compareSummary(rows);

    // 申报口径对比：两份文件都有「文件汇总」事实时，费用口径差 + 单位工程差一并给出
    const declaredUnits = async (filename: string) => {
      const f = await getFact(ctx.projectId, `文件汇总:${filename}`);
      if (!f) return null;
      try { return JSON.parse(f.value) as Record<string, unknown>[]; } catch { return null; }
    };
    const [unitsA, unitsB] = await Promise.all([declaredUnits(fileA.filename), declaredUnits(fileB.filename)]);
    const declared = unitsA && unitsB ? compareDeclaredFees(unitsA, unitsB) : null;
    const declaredTotal = declared?.labels.find((l) => l.label === "合计");

    const stageTag = (f: { stage: string; period: string }) =>
      [f.stage, f.period].filter(Boolean).join("·");
    return {
      observation: {
        fileA: fileA.filename, fileB: fileB.filename,
        stageA: stageTag(fileA) || undefined, stageB: stageTag(fileB) || undefined,
        ...summary,
        declared: declared ?? undefined,
      },
      views: [
        {
          kind: "fileCompare",
          id: `view:filecmp:${fileA.id.slice(-4)}-${fileB.id.slice(-4)}`,
          title: `对审 ${fileA.filename} ↔ ${fileB.filename}`,
          labelA: fileA.filename,
          labelB: fileB.filename,
          fileAId: fileA.id,
          fileBId: fileB.id,
          stageA: fileA.stage || undefined,
          periodA: fileA.period || undefined,
          stageB: fileB.stage || undefined,
          periodB: fileB.period || undefined,
          rows,
          summary,
          declared: declared ?? undefined,
        },
      ],
      message:
        `对审完成：${fileA.filename}${stageTag(fileA) ? `（${stageTag(fileA)}）` : ""} vs ${fileB.filename}${stageTag(fileB) ? `（${stageTag(fileB)}）` : ""} — 一致 ${summary.same} 项，` +
        `价差 ${summary.priceDiff} 项，量差 ${summary.qtyDiff} 项` +
        (summary.qtyOver15 ? `（其中 ${summary.qtyOver15} 项量差>15%，按 GB50500 应重新组价）` : "") +
        `，仅A ${summary.onlyA} 项，仅B ${summary.onlyB} 项，清单合价差 ${fmtMoney(summary.totalDelta)} 元` +
        (declaredTotal ? `；申报合计 ${fmtMoney(declaredTotal.a)} → ${fmtMoney(declaredTotal.b)}（差 ${fmtMoney(declaredTotal.diff)}）` : ""),
    };
  },
});

const patchSchema = z.object({
  id: z.string(),
  unitPrice: z.string().optional(),
  quantity: z.string().optional(),
  totalPrice: z.string().optional().describe("仅总价措施/其他项目可直接修改合价，其他项请改工程量或综合单价"),
  name: z.string().optional(),
  rawFeature: z.string().optional(),
});

registerTool({
  name: "boq.update",
  description: "修改清单项（综合单价/工程量/名称/项目特征），总价措施和其他项目可直接改合价，生成修改回执与 Diff",
  implemented: true,
  schema: z.object({
    patches: z.array(patchSchema),
    reason: z.string().optional(),
  }),
  confirm: (a: { patches: unknown[]; reason?: string }) =>
    `将修改 ${a.patches.length} 个清单项${a.reason ? `（${a.reason}）` : ""}，按各项计价口径更新金额`,
  handler: async (ctx, args: { patches: z.infer<typeof patchSchema>[]; reason?: string }) => {
    if (args.patches.some(p => p.totalPrice !== undefined)) {
      const items = await listBoq(ctx.projectId);
      if (args.patches.some(p => p.totalPrice !== undefined && items.some(i => i.id === p.id && i.feeType !== "总价措施" && i.feeType !== "其他项目")))
        throw new Error("分部分项和单价措施的合价由工程量×综合单价自动计算");
    }
    const { before, after } = await updateBoqItems(
      ctx.projectId,
      args.patches.map((p) => {
        const { id, ...patch } = p;
        return { id, patch };
      })
    );
    const diffRows: DiffRow[] = [];
    for (const b of before) {
      const a = after.find((x) => x.id === b.id);
      if (!a) continue;
      for (const field of ["unitPrice", "quantity", "totalPrice", "name", "rawFeature"] as const) {
        if (b[field] !== a[field])
          diffRows.push({
            itemId: b.id,
            code: b.code,
            name: b.name,
            field,
            before: String(b[field]),
            after: String(a[field]),
          });
      }
    }
    const viewId = `view:diff:${ctx.runId}`;
    return {
      observation: { updated: after.length, changedFields: diffRows.length },
      views: [
        { kind: "diff", id: viewId, title: "修改前后对比", receiptId: "", rows: diffRows },
        { kind: "boqTable", id: "view:boq", title: "工程量清单" },
      ],
      receipts: [
        {
          actionType: "BOQ_UPDATE",
          summary: `修改 ${after.length} 个清单项（${diffRows.length} 处字段变化）${args.reason ? "：" + args.reason : ""}`,
          before,
          after,
        },
      ],
      message: `已修改 ${after.length} 个清单项，共 ${diffRows.length} 处变化，已生成 Diff 与回执`,
    };
  },
});
