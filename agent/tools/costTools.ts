import { z } from "zod";
import { registerTool } from "./registry";
import { listBoq, updateBoqItems } from "@boq/service";
import { aggregateByCategory, aggregateByDiscipline, projectTotals } from "@cost-engine/aggregate";
import { adjustToTarget } from "@cost-engine/adjust";
import { analyzeCostComposition } from "@cost-engine/costComposition";
import { D, decStr, fmtMoney, round3, sum, withTax } from "@cost-engine/money";
import { feeSummary, feeCompliance, compareDeclared } from "@cost-engine/fees";
import { getFact, getFacts, setFact, parseRateValue, parseAreaValue, parseAmountValue, loadFeeParams } from "@project/facts";
import type { DiffRow } from "@shared/types";

registerTool({
  name: "cost.calculate",
  description: "确定性金额计算：合价=工程量×单价，可选税率换算含税总价",
  implemented: true,
  schema: z.object({
    taxRate: z.number().optional().describe("税率，如 0.09"),
  }),
  handler: async (ctx, args: { taxRate?: number }) => {
    const items = await listBoq(ctx.projectId);
    const t = projectTotals(items);
    const taxFact = (await getFact(ctx.projectId, "税率"))?.value;
    const tax = args.taxRate ?? parseRateValue(taxFact) ?? 0;
    const excl = D(t.totalAmount);
    return {
      observation: {
        ...t,
        taxRate: decStr(tax),
        exclTax: excl.toFixed(2),
        inclTax: tax ? withTax(excl, tax).toString() : null,
      },
      message: `不含税合价 ${fmtMoney(excl)} 元${tax ? `，含税 ${fmtMoney(withTax(excl, tax))} 元（税率 ${D(tax).mul(100)}%）` : ""}`,
    };
  },
});

registerTool({
  name: "cost.aggregate",
  description: "金额汇总（分部分项合计）",
  implemented: true,
  schema: z.object({}),
  handler: async (ctx) => {
    const items = await listBoq(ctx.projectId);
    const leaf = items.filter((i) => !i.isHeader && i.name.trim());
    return {
      observation: {
        total: sum(leaf.map((i) => i.totalPrice)).toFixed(2),
        count: leaf.length,
      },
    };
  },
});

registerTool({
  name: "cost.feeSummary",
  description: "费用汇总（取费）：分部分项费 → 措施费 → 暂列金额 → 规费 → 税金 → 含税造价。费率取项目事实台账",
  implemented: true,
  schema: z.object({}),
  handler: async (ctx) => {
    const items = await listBoq(ctx.projectId);
    const fees = await loadFeeParams(ctx.projectId);
    const r = feeSummary(items, fees);

    // 申报核对按文件配对：「文件汇总:{filename}」事实只代表那份文件的申报口径，
    // 用同一文件的清单行算 feeSummary 再对——多文件时逐文件核对，不混池比较。
    const { prisma } = await import("@database/client");
    const [facts, files] = await Promise.all([
      getFacts(ctx.projectId),
      prisma.projectFile.findMany({ where: { projectId: ctx.projectId }, select: { id: true, filename: true } }),
    ]);
    const declaredCheck: { file: string; checks: { label: string; declared: number; computed: number; diff: number; pct: number; note?: string }[] }[] = [];
    const seenSummary = new Set<string>();
    for (const f of facts.filter((x) => x.key.startsWith("文件汇总:") && !seenSummary.has(x.key) && seenSummary.add(x.key))) {
      const filename = f.key.slice("文件汇总:".length);
      const fileId = files.find((x) => x.filename === filename)?.id;
      const fileItems = fileId ? items.filter((i) => i.fileId === fileId) : [];
      if (!fileItems.length) continue;
      try {
        const checks = compareDeclared(feeSummary(fileItems, fees).rows, JSON.parse(f.value));
        if (checks.length) declaredCheck.push({ file: filename, checks });
      } catch { /* 事实 JSON 异常就跳过核对 */ }
    }
    const driftNotes = declaredCheck
      .map((d) => {
        const drift = d.checks.filter((c) => Math.abs(c.pct) > 0.01);
        if (!drift.length) return `「${d.file}」与申报口径一致（差≤1%）`;
        return `「${d.file}」口径差异：${drift.map((c) => `${c.label}${c.diff > 0 ? "+" : ""}${fmtMoney(c.diff)}（${(c.pct * 100).toFixed(1)}%）`).join("、")}`;
      })
      .filter(Boolean);

    // 费用符合性检查：不可竞争费漏计/税率口径/暂列金额/最高限价超限
    const ceilingFact = facts.find((x) => /最高限价|招标控制价|控制价|限价/.test(x.key));
    const ceilingNum = ceilingFact ? parseAmountValue(ceilingFact.value) : null;
    const issues = feeCompliance(items, fees, { ceiling: ceilingNum !== null ? D(ceilingNum) : null, summary: r });
    const errCount = issues.filter((x) => x.level === "error").length;

    // 造价指标（单方造价）：台账「建筑面积」>0 时给出 元/㎡ 口径——指标分析的最低骨架
    const areaFact = facts.find((x) => /面积/.test(x.key));
    const area = parseAreaValue(areaFact?.value);
    const indicators =
      area !== null && area > 0
        ? [
            { label: "建筑面积", value: `${D(area).toFixed(0)} ㎡` },
            { label: "单方造价(含税)", value: `${D(r.grandTotal).div(area).toFixed(2)} 元/㎡` },
            { label: "单方造价(税前)", value: `${D(r.preTax).div(area).toFixed(2)} 元/㎡` },
          ]
        : undefined;

    return {
      observation: {
        grandTotal: r.grandTotal, preTax: r.preTax, unpricedCount: r.unpricedCount,
        rows: r.rows.map((x) => ({ name: x.name, rate: x.rate, amount: x.amount })),
        declaredCheck: declaredCheck.length ? declaredCheck : undefined,
        indicators,
        issues: issues.length ? issues : undefined,
      },
      views: [
        {
          kind: "feeSummary", id: `view:fees:${ctx.runId}`, title: "费用汇总表",
          rows: r.rows, grandTotal: r.grandTotal, unpricedCount: r.unpricedCount,
          indicators, issues,
        },
      ],
      message: `含税工程造价 ${fmtMoney(r.grandTotal)} 元（税前 ${fmtMoney(r.preTax)} 元）${indicators ? `；单方造价 ${D(r.grandTotal).div(area!).toFixed(2)} 元/㎡` : ""}${r.unpricedCount ? `；注意 ${r.unpricedCount} 项未定价` : ""}${issues.length ? `；费用符合性：${issues.length} 项问题${errCount ? `（含 ${errCount} 项错误）` : ""}` : ""}${driftNotes.length ? `；${driftNotes.join("；")}` : ""}`,
    };
  },
});

// 措施费系数计取（四川2020 官方费率表）：脚手架搭拆费按册平费率、
// 超高/高层增加费按操作物高度/檐口高度选档，基数=定额测算的分册定额人工费。
// 计取结果写台账「系数措施费」，费用汇总表自动采用。
registerTool({
  name: "cost.measureFees",
  description: "措施费系数计取（四川2020官方费率）：脚手架搭拆/超高/高层建筑增加费按分册定额人工费×费率档计取。需先「定额测算」产生分册人工费基数；檐口高度/操作物高度取台账",
  implemented: true,
  schema: z.object({
    eaveHeight: z.number().optional().describe("檐口高度(m)，缺省读台账「檐口高度」"),
    workHeight: z.number().optional().describe("操作物高度(m)，缺省读台账「操作物高度」"),
    systemAdjust: z.array(z.string()).optional().describe("启用的系统调整费，如 ['采暖','通风空调']"),
    specialEnv: z.array(z.string()).optional().describe("启用的特殊环境费，如 ['洞库','同时进行']"),
  }),
  handler: async (ctx, args: { eaveHeight?: number; workHeight?: number; systemAdjust?: string[]; specialEnv?: string[] }) => {
    const { computeMeasureFees } = await import("@cost-engine/measureFee");
    const { getMeasureFeeRates } = await import("@dataset/service");
    const rates = await getMeasureFeeRates();
    if (!rates.length)
      return { observation: { error: "措施费系数库未导入或已停用（后台数据集「四川2020措施费系数」）" } };

    const laborFact = await getFact(ctx.projectId, "定额人工费明细");
    let laborByBook: Record<string, ReturnType<typeof D>> = {};
    try {
      const raw = JSON.parse(laborFact?.value ?? "{}") as Record<string, string>;
      laborByBook = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, D(v)]));
    } catch { /* empty */ }
    if (!Object.values(laborByBook).some((v) => v.gt(0)))
      return { observation: { error: "无分册定额人工费基数——请先「定额测算」" } };

    const num = async (key: string) => {
      const f = await getFact(ctx.projectId, key);
      const v = Number(String(f?.value ?? "").replace(/[m米\s]/g, ""));
      return Number.isFinite(v) && v > 0 ? v : null;
    };
    const list = async (key: string) =>
      String((await getFact(ctx.projectId, key))?.value ?? "")
        .split(/[,，、\s]+/).filter(Boolean).filter((s) => !/^(0|否|无|false)$/i.test(s));

    const settings = {
      eaveHeight: args.eaveHeight ?? (await num("檐口高度")),
      workHeight: args.workHeight ?? (await num("操作物高度")),
      systemAdjust: args.systemAdjust ?? (await list("系统调整费")),
      specialEnv: args.specialEnv ?? (await list("特殊环境费")),
    };
    const r = computeMeasureFees(rates, laborByBook, settings);

    // 总是写台账：total=0 也要落，否则上一轮的旧值残留会被 feeSummary 继续叠加
    await setFact(ctx.projectId, {
      factType: "取费基数", key: "系数措施费", value: r.total,
      source: "INFERRED", confidence: 0.8, createdBy: "agent", agentRunId: ctx.runId,
    });
    await setFact(ctx.projectId, {
      factType: "取费基数", key: "系数措施费明细",
      value: JSON.stringify(r.lines.map((l) => ({ name: l.name, book: l.book, amount: l.amount }))),
      source: "INFERRED", confidence: 0.8, createdBy: "agent", agentRunId: ctx.runId,
    });

    return {
      observation: {
        lines: r.lines.length, total: r.total,
        laborByBook: Object.fromEntries(Object.entries(laborByBook).map(([k, v]) => [k, v.toFixed(2)])),
        settings, skipped: r.skipped.length,
      },
      views: [{
        kind: "measureFee", id: `view:mfee:${ctx.runId}`, title: "措施费计取（四川2020系数）",
        rows: r.lines, total: r.total, skipped: r.skipped,
      }],
      message: D(r.total).gt(0)
        ? `措施费计取：${r.lines.length} 项合计 ${fmtMoney(r.total)} 元（已写入台账「系数措施费」，费用汇总表自动采用）` +
          (r.skipped.length ? `；${r.skipped.length} 项未计取（檐口/操作高度或系统调整费未设置）` : "")
        : `措施费计取：无可计取项（台账「系数措施费」已清为 0）` +
          (r.skipped.length ? `；${r.skipped.length} 项未计取（檐口/操作高度或系统调整费未设置）` : ""),
    };
  },
});

registerTool({
  name: "cost.composition",
  description:
    "人材机成本构成分析：把清单合价拆成人工费/材料费/机械费/管利及其他，算直接成本、毛利与成本倒挂项。分量来源：定额组价方案 > 源表人材机分解列 > 主材暂估价",
  implemented: true,
  schema: z.object({}),
  handler: async (ctx) => {
    // 需要 rawCells：分解列字段为 0 的旧数据靠整行原文兜底找回人工/机械单价
    const items = await listBoq(ctx.projectId);
    const r = analyzeCostComposition(items);
    const { totals: t, coverage: c } = r;
    const share = (v: string) =>
      D(t.revenue).isZero() ? "0.0" : D(v).div(D(t.revenue)).mul(100).toFixed(1);
    return {
      observation: { totals: t, coverage: c, rowCount: r.rows.length },
      views: [
        {
          kind: "costComposition",
          id: "view:costComposition",
          title: "人材机成本构成",
          rows: r.rows,
          totals: t,
          coverage: c,
        },
      ],
      message:
        `分部分项合价 ${fmtMoney(t.revenue)} 元：` +
        `人工 ${share(t.labor)}%｜材料 ${share(t.material)}%｜机械 ${share(t.machine)}%｜管利及未分解 ${share(t.other)}%。` +
        `成本口径覆盖 ${c.plan + c.imported + c.partial}/${r.rows.length} 项` +
        `（组价方案 ${c.plan}、源表分解列 ${c.imported}、仅主材价 ${c.partial}）` +
        (t.marginRate !== null ? `；可算口径毛利 ${fmtMoney(t.margin)} 元（${t.marginRate}%）` : "") +
        (c.inverted ? `；⚠ ${c.inverted} 项人材机成本高于合价（倒挂）` : "") +
        (c.none ? `；${c.none} 项无成本数据，可先定额测算补充` : ""),
    };
  },
});

registerTool({
  name: "cost.professionalBreakdown",
  description: "专业金额占比分析：电气/给排水/消防/暖通/弱电 各占安装工程总金额多少",
  implemented: true,
  schema: z.object({}),
  handler: async (ctx) => {
    const items = await listBoq(ctx.projectId);
    const { slices, total } = aggregateByDiscipline(items);
    return {
      observation: { slices, total: total.toFixed(2) },
      views: [
        {
          kind: "breakdown",
          id: "view:breakdown:discipline",
          title: "专业金额占比",
          mode: "discipline",
          slices,
          total: total.toFixed(2),
        },
      ],
      message: `总金额 ${fmtMoney(total)} 元：` +
        slices.slice(0, 5).map((s) => `${s.label} ${(s.share * 100).toFixed(1)}%`).join("，"),
    };
  },
});

registerTool({
  name: "cost.unitSummary",
  description: "单位工程费用汇总：按单位工程归属汇总清单合价与占比（多单位工程项目的标准交付口径；费率分摊不在此列）",
  implemented: true,
  schema: z.object({}),
  handler: async (ctx) => {
    const items = await listBoq(ctx.projectId);
    const { aggregateByUnitProject } = await import("@cost-engine/aggregate");
    const { slices, total } = aggregateByUnitProject(items);
    const untagged = slices.find((s) => s.key === "未注明单位工程");
    return {
      observation: { slices, total: total.toFixed(2) },
      views: [
        {
          kind: "breakdown",
          id: "view:breakdown:unit",
          title: "单位工程费用汇总",
          mode: "unit",
          slices,
          total: total.toFixed(2),
        },
      ],
      message: `清单合价 ${fmtMoney(total)} 元按单位工程分 ${slices.length} 块：` +
        slices.slice(0, 5).map((s) => `${s.label} ${fmtMoney(s.amount)} 元（${(s.share * 100).toFixed(1)}%）`).join("，") +
        (untagged && untagged.count ? `；${untagged.count} 项未注明单位工程归属` : ""),
    };
  },
});

registerTool({
  name: "cost.materialBreakdown",
  description: "材料类别金额占比：电缆/桥架/管道/阀门等分别占总金额多少",
  implemented: true,
  schema: z.object({
    categories: z.array(z.string()).optional().describe("只看这些类别，如 ['电缆','桥架','管道','阀门']"),
  }),
  handler: async (ctx, args: { categories?: string[] }) => {
    const items = await listBoq(ctx.projectId);
    const { slices, total } = aggregateByCategory(items, args.categories);
    return {
      observation: { slices, total: total.toFixed(2) },
      views: [
        {
          kind: "breakdown",
          id: "view:breakdown:material",
          title: args.categories?.length ? `${args.categories.join("/")} 金额占比` : "材料类别金额占比",
          mode: "material",
          slices,
          total: total.toFixed(2),
        },
      ],
      message:
        `总金额 ${fmtMoney(total)} 元：` +
        slices.slice(0, 6).map((s) => `${s.label} ${(s.share * 100).toFixed(1)}%`).join("，"),
    };
  },
});

registerTool({
  name: "quantity.calculate",
  description: "工程量计算式求值（如 3层×12个+15、(12.5+3)*2），可写入指定清单项的工程量",
  implemented: true,
  schema: z.object({
    expression: z.string().describe("工程量计算式，支持 +-*/×÷()%、中文单位词自动剥离"),
    itemId: z.string().optional().describe("给定则把结果写入该清单项工程量（三位小数）"),
    label: z.string().optional().describe("计算说明"),
  }),
  confirm: (a: { itemId?: string; expression?: string }) =>
    a.itemId ? `将把计算结果写入清单项工程量：${a.expression}` : null,
  handler: async (ctx, args: { expression: string; itemId?: string; label?: string }) => {
    const { evalExpr } = await import("@cost-engine/calcExpr");
    let value: number;
    try {
      value = evalExpr(args.expression);
    } catch (e) {
      return { observation: { error: `计算式无效：${e instanceof Error ? e.message : e}` } };
    }
    const qty = round3(value);

    if (!args.itemId) {
      const label = args.label && !args.label.includes(args.expression) ? `${args.label}：` : "";
      return {
        observation: { expression: args.expression, result: qty.toString() },
        message: `${label}${args.expression} = ${qty.toString()}`,
      };
    }

    const { before, after } = await updateBoqItems(ctx.projectId, [
      { id: args.itemId, patch: { quantity: qty.toString(), quantityExpr: args.expression } },
    ]);
    const b = before[0];
    const a = after[0];
    if (!a) return { observation: { error: "清单项不存在" } };
    return {
      observation: { itemId: args.itemId, before: b?.quantity, after: a.quantity },
      views: [
        {
          kind: "diff",
          id: `view:diff:${ctx.runId}`,
          title: "工程量写入",
          receiptId: "",
          rows: [{
            itemId: a.id, code: a.code, name: a.name, field: "quantity",
            before: String(b?.quantity ?? ""), after: String(a.quantity),
          }],
        },
      ],
      receipts: [{
        actionType: "BOQ_UPDATE",
        summary: `工程量计算写回：${a.name} ${args.expression} = ${qty}`,
        before, after,
      }],
      message: `${a.name} 工程量已更新：${b?.quantity} → ${qty}（${args.expression}）`,
    };
  },
});

registerTool({
  name: "quantity.adjust",
  description: "总价反算：把清单总价控制到目标值（可含税）。默认按比例调整综合单价（下浮/上浮，总价控制的合规手段，工程量不动）；mode=quantity 时才调工程量",
  implemented: true,
  schema: z.object({
    targetTotal: z.number().describe("目标总价"),
    mode: z.enum(["price", "quantity"]).optional().describe("price=调综合单价（默认，合规）；quantity=调工程量（改变图纸口径，慎用）"),
    taxRate: z.number().optional().describe("目标价为含税价时的税率，如 0.09"),
    allowedItemIds: z.array(z.string()).optional().describe("只允许调整这些清单项；缺省=全部有量有价项"),
    apply: z.boolean().optional().describe("true=直接写回，false=仅试算"),
  }),
  confirm: (a: { apply?: boolean; targetTotal?: number; mode?: string }) =>
    a.apply
      ? `将按目标总价 ${a.targetTotal} 反算并写回清单（${a.mode === "quantity" ? "调工程量，单价不变——会改变图纸口径" : "调综合单价，工程量不变"}）`
      : null,
  handler: async (ctx, args) => {
    const items = await listBoq(ctx.projectId);
    // 目标价默认税前口径；仅调用方显式声明含税（taxRate>0）才做价税分离——
    // 若兜底台账税率，税前意图会被静默当含税反算，结果少 ~9%
    const tax = args.taxRate ?? 0;
    const field = args.mode === "quantity" ? "quantity" : "price";
    const fieldLabel = field === "quantity" ? "工程量" : "综合单价";
    const r = adjustToTarget(items, {
      targetTotal: args.targetTotal,
      taxRate: tax,
      allowedItemIds: args.allowedItemIds,
      field,
    });
    if (!r.ok && !r.adjustments.length)
      return { observation: { ok: false, reason: r.reason } };

    const beforeMap = new Map(items.map((i) => [i.id, i]));
    const diffRows: DiffRow[] = r.adjustments.map((a) => {
      const it = beforeMap.get(a.itemId)!;
      return {
        itemId: a.itemId, code: it.code, name: it.name,
        field, before: a.before.toString(), after: a.after.toString(),
      };
    });
    const scalePct = r.beforeTotal.isZero()
      ? "0"
      : r.afterTotal.div(r.beforeTotal).minus(1).mul(100).toFixed(2);

    if (!args.apply) {
      return {
        observation: {
          ok: r.ok,
          mode: field,
          beforeTotal: r.beforeTotal.toFixed(2),
          afterTotal: r.afterTotal.toFixed(2),
          residual: r.residual.toFixed(4),
          adjustedItems: r.adjustments.length,
          preview: diffRows.slice(0, 20),
        },
        views: [
          {
            kind: "diff",
            id: `view:diff:${ctx.runId}`,
            title: `总价反算试算（目标 ${args.targetTotal}，调${fieldLabel}）`,
            receiptId: "",
            rows: diffRows,
          },
        ],
        message: `试算完成：${fieldLabel}整体${Number(scalePct) >= 0 ? "上浮" : "下浮"} ${Math.abs(Number(scalePct))}%，调整 ${r.adjustments.length} 项，总价 ${fmtMoney(r.beforeTotal)} → ${fmtMoney(r.afterTotal)} 元（不含税口径），残差 ${r.residual.toFixed(4)}。确认后可写回`,
      };
    }

    const patchKey = field === "quantity" ? "quantity" : "unitPrice";
    const { before, after } = await updateBoqItems(
      ctx.projectId,
      r.adjustments.map((a) => ({ id: a.itemId, patch: { [patchKey]: a.after.toString() } }))
    );
    return {
      observation: {
        ok: r.ok,
        mode: field,
        applied: after.length,
        afterTotal: r.afterTotal.toFixed(2),
        residual: r.residual.toFixed(4),
      },
      views: [
        { kind: "diff", id: `view:diff:${ctx.runId}`, title: `总价反算 Diff（调${fieldLabel}）`, receiptId: "", rows: diffRows },
        { kind: "boqTable", id: "view:boq", title: "工程量清单" },
      ],
      receipts: [
        {
          actionType: "PRICE_ADJUST",
          summary: `总价反算：${r.adjustments.length} 项调${fieldLabel}（${Number(scalePct) >= 0 ? "+" : ""}${scalePct}%），总价 ${fmtMoney(r.beforeTotal)} → ${fmtMoney(r.afterTotal)}（目标 ${args.targetTotal}${tax ? " 含税" : ""}）`,
          before: r.adjustments.map((a) => ({
            id: a.itemId,
            name: beforeMap.get(a.itemId)?.name,
            [patchKey]: a.before.toString(),
          })),
          after: r.adjustments.map((a) => ({
            id: a.itemId,
            name: beforeMap.get(a.itemId)?.name,
            [patchKey]: a.after.toString(),
          })),
        },
      ],
      message: `已写回 ${r.adjustments.length} 项${fieldLabel}（${Number(scalePct) >= 0 ? "上浮" : "下浮"} ${Math.abs(Number(scalePct))}%），调整后总价 ${fmtMoney(r.afterTotal)} 元（不含税），残差 ${r.residual.toFixed(4)} 元`,
    };
  },
});

// quota.* 已实现于 quotaTools.ts
