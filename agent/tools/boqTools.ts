import { z } from "zod";
import { registerTool } from "./registry";
import { listBoq, updateBoqItems } from "@boq/service";
import {
  findArithmeticMismatches,
  findCodeNameMismatch,
  findDataIssues,
  findDuplicateItems,
  findFeatureMismatch,
  findInvalidCodes,
  findMissingCodes,
  findPriceAnomalies,
  findSameItemDifferentPrice,
  findUnitInconsistencies,
} from "@cost-engine/compare";
import { fmtMoney } from "@cost-engine/money";
import type { AnomalyRow, DiffRow, WorkspaceView } from "@shared/types";

const ANOMALY_LABEL: Record<string, string> = {
  SAME_ITEM_DIFF_PRICE: "相同项不同单价",
  PRICE_ANOMALY: "综合单价异常",
  FEATURE_MISMATCH: "项目特征不一致",
  DUPLICATE: "重复清单项",
  ARITHMETIC: "合价算术校验",
  UNIT_INCONSISTENT: "单位不一致",
  CODE_MISMATCH: "一码多名",
  INVALID_CODE: "非标编码",
  MISSING_CODE: "缺编码",
  DATA_QUALITY: "数据质量",
  OWNER_SUPPLIED: "甲供材核对",
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
          i.rawFeature.toLowerCase().includes(q) ||
          i.sectionPath.toLowerCase().includes(q) ||
          (i.unitProject ?? "").toLowerCase().includes(q))
    );
    return {
      observation: hits.slice(0, 30).map((i) => ({
        id: i.id,
        code: i.code,
        name: i.name,
        unit: i.unit,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        sectionPath: i.sectionPath || undefined,
        unitProject: i.unitProject || undefined,
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
  name: "boq.findUnitInconsistencies",
  description: "检查同语义清单项单位不一致（如一部分 m 一部分 km）——量纲错位会让合价数量级出错",
  implemented: true,
  schema: z.object({}),
  handler: async (ctx) => {
    const items = await listBoq(ctx.projectId);
    const rows = findUnitInconsistencies(items);
    return {
      observation: { count: rows.length },
      views: [anomalyView("UNIT_INCONSISTENT", rows)],
      message: rows.length ? `发现 ${rows.length} 组单位不一致` : "未发现单位不一致",
    };
  },
});

registerTool({
  name: "boq.findCodeNameMismatch",
  description: "检查一码多名：同一项目编码对应不同名称——GB50500 清单编码应唯一",
  implemented: true,
  schema: z.object({}),
  handler: async (ctx) => {
    const items = await listBoq(ctx.projectId);
    const rows = findCodeNameMismatch(items);
    return {
      observation: { count: rows.length },
      views: [anomalyView("CODE_MISMATCH", rows)],
      message: rows.length ? `发现 ${rows.length} 组一码多名` : "未发现一码多名",
    };
  },
});

registerTool({
  name: "boq.findInvalidCodes",
  description: "检查清单项目编码格式——GB50500 应为 12 位数字（附录9位+顺序码3位），非标/自编编码对审会漏配",
  implemented: true,
  schema: z.object({}),
  handler: async (ctx) => {
    const items = await listBoq(ctx.projectId);
    const rows = findInvalidCodes(items);
    const n = rows[0]?.items.length ?? 0;
    return {
      observation: { count: n },
      views: [anomalyView("INVALID_CODE", rows)],
      message: n ? `发现 ${n} 项非标编码` : "未发现非标编码",
    };
  },
});

registerTool({
  name: "boq.findMissingCodes",
  description: "检查可计价清单项（分部分项/单价措施）缺项目编码——GB50500 要求逐项编码，缺编码对审无法按码对量",
  implemented: true,
  schema: z.object({}),
  handler: async (ctx) => {
    const items = await listBoq(ctx.projectId);
    const rows = findMissingCodes(items);
    const n = rows[0]?.items.length ?? 0;
    return {
      observation: { count: n },
      views: [anomalyView("MISSING_CODE", rows)],
      message: n ? `发现 ${n} 项清单缺编码` : "未发现缺编码项",
    };
  },
});

registerTool({
  name: "boq.findDataIssues",
  description: "数据质量检查：可计价清单行上的负综合单价/负工程量/缺计量单位——源表硬伤逐项列出",
  implemented: true,
  schema: z.object({}),
  handler: async (ctx) => {
    const items = await listBoq(ctx.projectId);
    const rows = findDataIssues(items);
    const n = rows.reduce((s, r) => s + r.items.length, 0);
    return {
      observation: { count: n, groups: rows.length },
      views: [anomalyView("DATA_QUALITY", rows)],
      message: n ? `发现 ${n} 项数据质量问题（${rows.map((r) => r.label).join("、")}）` : "未发现数据质量问题",
    };
  },
});

registerTool({
  name: "boq.compare",
  description: "对比清单：相同项不同价 + 单价异常 + 特征不一致 + 合价算术校验 + 单位不一致 + 一码多名 + 非标编码（一次全查）",
  implemented: true,
  schema: z.object({}),
  handler: async (ctx) => {
    const items = await listBoq(ctx.projectId);
    const a = findSameItemDifferentPrice(items);
    const b = findPriceAnomalies(items);
    const c = findFeatureMismatch(items);
    const d = findArithmeticMismatches(items);
    const e = findUnitInconsistencies(items);
    const f = findCodeNameMismatch(items);
    const g = findInvalidCodes(items);
    const h = findMissingCodes(items);
    const dp = findDuplicateItems(items);
    const dq = findDataIssues(items);
    const arith = d[0]?.items.length ?? 0;
    const invalid = g[0]?.items.length ?? 0;
    const missing = h[0]?.items.length ?? 0;
    const dup = dp.reduce((n, r) => n + r.items.length, 0);
    const dataIssues = dq.reduce((n, r) => n + r.items.length, 0);
    return {
      observation: { sameItemDiffPrice: a.length, priceAnomalies: b.length, featureMismatch: c.length, arithmeticMismatch: arith, unitInconsistent: e.length, codeMismatch: f.length, invalidCode: invalid, missingCode: missing, duplicate: dp.length, dataQuality: dq.length },
      views: [
        anomalyView("SAME_ITEM_DIFF_PRICE", a),
        anomalyView("PRICE_ANOMALY", b),
        anomalyView("FEATURE_MISMATCH", c),
        anomalyView("ARITHMETIC", d),
        anomalyView("UNIT_INCONSISTENT", e),
        anomalyView("CODE_MISMATCH", f),
        anomalyView("INVALID_CODE", g),
        anomalyView("MISSING_CODE", h),
        anomalyView("DUPLICATE", dp),
        anomalyView("DATA_QUALITY", dq),
      ],
      message: `全面检查完成：相同项不同价 ${a.length} 组，单价异常 ${b.length} 组，特征不一致 ${c.length} 组，合价算术不符 ${arith} 项，单位不一致 ${e.length} 组，一码多名 ${f.length} 组，非标编码 ${invalid} 项，缺编码 ${missing} 项，重复项 ${dup} 项，数据质量 ${dataIssues} 项`,
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
        (summary.compliance ? `；五统一符合性不符 ${summary.compliance} 项（名称/单位/特征）` : "") +
        (declaredTotal ? `；申报合计 ${fmtMoney(declaredTotal.a)} → ${fmtMoney(declaredTotal.b)}（差 ${fmtMoney(declaredTotal.diff)}）` : ""),
    };
  },
});

const patchSchema = z.object({
  id: z.string(),
  unitPrice: z.string().optional(),
  quantity: z.string().optional(),
  quantityExpr: z.string().optional().describe("工程量计算式原文，如 3层×12个+15"),
  mainMaterialPrice: z.string().optional().describe("主材暂估价"),
  laborUnitPrice: z.string().optional(),
  machineUnitPrice: z.string().optional(),
  totalPrice: z.string().optional().describe("仅总价措施/其他项目可直接修改合价，其他项请改工程量或综合单价"),
  name: z.string().optional(),
  code: z.string().optional().describe("项目编码修正（缺/错编码的处置通道）"),
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
      for (const field of ["unitPrice", "quantity", "quantityExpr", "mainMaterialPrice", "laborUnitPrice", "machineUnitPrice", "totalPrice", "name", "code", "rawFeature"] as const) {
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

registerTool({
  name: "boq.addItem",
  description: "补录一行清单（导入漏项/零星项补救）。分部分项/单价措施给工程量+综合单价（合价自动算）；总价措施/其他项目直接给合价。生成回执，可撤销",
  implemented: true,
  schema: z.object({
    name: z.string().min(1).describe("项目名称"),
    code: z.string().optional().describe("项目编码"),
    unit: z.string().optional().describe("计量单位"),
    quantity: z.string().optional().describe("工程量（支持计算式结果数值）"),
    quantityExpr: z.string().optional().describe("工程量计算式原文，如 3层×12个+15"),
    unitPrice: z.string().optional().describe("综合单价"),
    mainMaterialPrice: z.string().optional().describe("主材暂估价"),
    laborUnitPrice: z.string().optional().describe("人工单价"),
    machineUnitPrice: z.string().optional().describe("机械单价"),
    totalPrice: z.string().optional().describe("合价（仅总价措施/其他项目直填）"),
    feeType: z.enum(["分部分项", "单价措施", "总价措施", "其他项目"]).optional(),
    rawFeature: z.string().optional().describe("项目特征"),
    unitProject: z.string().optional().describe("归属单位工程（多单位工程项目）"),
    insertAfter: z.string().optional().describe("插入锚点行 id：新行紧随该行并沿用其文件/分部/专业"),
  }),
  confirm: (a: { name: string }) => `将补录清单项「${a.name}」（操作可撤销）`,
  handler: async (ctx, args) => {
    const { createBoqItem } = await import("@boq/service");
    let item;
    try {
      item = await createBoqItem(ctx.projectId, args);
    } catch (e) {
      return { observation: { error: e instanceof Error ? e.message : "补录失败" } };
    }
    const lumpSum = item.feeType === "总价措施" || item.feeType === "其他项目";
    const priceDesc = lumpSum
      ? `合价 ${item.totalPrice}`
      : `${item.quantity}${item.unit} × 综合单价 ${item.unitPrice} = 合价 ${item.totalPrice}`;
    return {
      observation: { itemId: item.id, name: item.name, totalPrice: item.totalPrice },
      views: [{ kind: "boqTable", id: "view:boq", title: "工程量清单" }],
      receipts: [{
        actionType: "BOQ_UPDATE",
        summary: `补录清单项「${item.name}」（${priceDesc}）`,
        before: [],
        after: [item],
      }],
      message: `已补录「${item.name}」：${priceDesc}，可在操作记录撤销`,
    };
  },
});

registerTool({
  name: "boq.deleteItems",
  description: "删除指定清单项（需确认；回执含全字段快照，可在操作记录里撤销恢复）。删除标题行会连同其子项一起消失的风险由用户确认时权衡",
  implemented: true,
  schema: z.object({
    ids: z.array(z.string().min(1)).min(1).max(500).describe("要删除的清单项 id 列表"),
    reason: z.string().optional(),
  }),
  confirm: (a: { ids: string[] }) => `将删除 ${a.ids.length} 个清单项（操作可撤销）`,
  handler: async (ctx, args: { ids: string[]; reason?: string }) => {
    const { prisma } = await import("@database/client");
    const ids = [...new Set(args.ids)];
    const items = await prisma.boqItem.findMany({
      where: { id: { in: ids }, projectId: ctx.projectId },
    });
    if (items.length !== ids.length)
      return { observation: { error: "部分清单项不存在或不属于当前项目，请刷新后重试" } };
    await prisma.boqItem.deleteMany({ where: { id: { in: ids } } });
    // before 落原始行（非 DTO）：revert 的 recreate 路径按这些字段原样重建
    return {
      observation: { deleted: items.length },
      views: [{ kind: "boqTable", id: "view:boq", title: "工程量清单" }],
      receipts: [{
        actionType: "BOQ_DELETE",
        summary: `删除 ${items.length} 个清单项${args.reason ? `（${args.reason}）` : ""}：${items.slice(0, 5).map((i) => i.name).join("、")}${items.length > 5 ? " 等" : ""}`,
        before: items,
        after: [],
      }],
      message: `已删除 ${items.length} 个清单项，可在「操作记录」中撤销`,
    };
  },
});
