import type { RunContext } from "./context";
import type { ToolResult } from "./tools/registry";

// Planner produces steps. A step is either a static {tool,args} or a
// dynamic function that can inspect previous observations — this is the
// agent loop for the rule engine (plan -> act -> observe -> next act).

export interface PlanStep {
  tool: string;
  args: Record<string, unknown>;
  /** terse activity line shown while the tool runs */
  activity?: string;
}

export type StepOrFn =
  | PlanStep
  | ((results: ToolResult[]) => Promise<PlanStep | null> | PlanStep | null);

export interface Plan {
  steps: StepOrFn[];
  /** final agent message when no steps produced a message */
  fallbackMessage?: string;
}

export interface Planner {
  name: string;
  plan(ctx: RunContext, message: string, extra?: Record<string, unknown>): Promise<Plan>;
}

const MATERIAL_CATEGORIES = [
  "电缆", "电线", "桥架", "管道", "阀门", "灯具", "配电箱柜", "母线",
  "支架", "设备", "喷淋设备", "消防设备", "开关插座", "套管", "保温",
  "管件", "接线盒", "电缆附件", "土方", "防腐刷油",
];

const CAPABILITIES = `我可以直接执行这些造价任务：
• 检查清单：相同项不同单价、综合单价异常、项目特征不一致、重复项
• 询价处理：把询价文件价格匹配并写回清单，未询到的自动标记
• 金额分析：各专业占比、电缆/桥架/管道/阀门等材料类别占比
• 工程量反算：总价控制到目标值（含税可指定税率），只调工程量
• 修改与导出：改单价/工程量，展示 Diff，导出或写回 Excel
直接说出目标即可，例如「检查相同项不同单价」「把询价写回清单」。`;

export class RulePlanner implements Planner {
  name = "rule";

  async plan(
    ctx: RunContext,
    message: string,
    extra?: Record<string, unknown>
  ): Promise<Plan> {
    const m = message.trim();

    // file ingest (triggered by upload)
    if (extra?.ingestFileId) {
      return {
        steps: [
          { tool: "file.ingest", args: { fileId: extra.ingestFileId }, activity: "正在解析文件" },
          { tool: "project.summary", args: {} },
        ],
      };
    }

    // 导出 / 写回
    if (/写回|回写|更新到源文件|更新到.*文件/.test(m))
      return { steps: [{ tool: "excel.write", args: {}, activity: "正在写回源文件" }] };
    if (/导出|生成.*excel|下载/i.test(m))
      return {
        steps: [{ tool: "report.exportExcel", args: {}, activity: "正在导出 Excel" }],
      };

    // 工程量反算: 总价控制到 X
    const target = m.match(/(?:控制|调|调整|降|到|为)\D{0,6}([\d,]+\.?\d{0,2})/);
    if (/总价|含税|总额|造价/.test(m) && target) {
      const targetTotal = Number(target[1].replace(/,/g, ""));
      const inclTax = /含税/.test(m);
      const taxFact = ctx.facts.find((f) => f.key === "税率")?.value;
      const taxRate = inclTax ? Number(taxFact ?? 0.09) : 0;
      return {
        steps: [
          {
            tool: "quantity.adjust",
            args: { targetTotal, taxRate, apply: true },
            activity: `正在按目标总价 ${targetTotal} 反算工程量${inclTax ? `（含税，税率 ${taxRate}）` : ""}`,
          },
        ],
        fallbackMessage: inclTax && !taxFact
          ? `已按含税口径处理，税率取默认 9%（项目台账未记录税率，可用「税率设为x%」写入事实）`
          : undefined,
      };
    }

    // 询价: 更新/写回/填价 → compare + apply；只"匹配/看看" → compare
    if (/询价|报价/.test(m)) {
      const apply = /更新|写回|填|套用|应用|代入|填入/.test(m);
      const steps: StepOrFn[] = [
        { tool: "material.compareQuotation", args: {}, activity: "正在匹配询价材料" },
      ];
      if (apply)
        steps.push({ tool: "material.applyQuotation", args: {}, activity: "正在写回询价到清单" });
      return { steps };
    }

    // 统一单价: 相同项统一为最低价/均价/指定价
    if (/统一|改为|调成|调整为/.test(m) && /单价|价格/.test(m)) {
      const mode = /最低|最小/.test(m) ? "min" : /平均|均值/.test(m) ? "mean" : "min";
      return {
        steps: [
          { tool: "boq.findSameItemDifferentPrice", args: {}, activity: "正在分组比较" },
          async (results): Promise<PlanStep | null> => {
            const obs = results[0]?.observation as { groups?: string[] };
            if (!obs?.groups?.length) return null;
            const { listBoq } = await import("@boq/service");
            const { findSameItemDifferentPrice } = await import("@cost-engine/compare");
            const items = await listBoq(ctx.projectId);
            const rows = findSameItemDifferentPrice(items);
            const patches: { id: string; unitPrice: string }[] = [];
            for (const r of rows) {
              const prices = r.items.map((i) => Number(i.unitPrice));
              const target =
                mode === "min"
                  ? Math.min(...prices)
                  : prices.reduce((a, b) => a + b, 0) / prices.length;
              for (const it of r.items)
                patches.push({ id: it.id, unitPrice: target.toFixed(2) });
            }
            return {
              tool: "boq.update",
              args: { patches, reason: `相同项统一为${mode === "min" ? "最低价" : "平均价"}` },
              activity: "正在统一单价并生成 Diff",
            };
          },
        ],
      };
    }

    // 检查类
    if (/相同项|同项不同价|相同清单|不同单价/.test(m))
      return {
        steps: [
          { tool: "boq.findSameItemDifferentPrice", args: {}, activity: "正在做语义分组与单价比较" },
        ],
      };
    if (/单价异常|价格异常|偏高|偏低|偏离/.test(m))
      return {
        steps: [{ tool: "boq.findPriceAnomalies", args: {}, activity: "正在比较组内单价" }],
      };
    if (/重复/.test(m))
      return {
        steps: [{ tool: "boq.findDuplicateItems", args: {}, activity: "正在查重" }],
      };
    if (/项目特征|特征.*(不一致|对比|比较)/.test(m))
      return {
        steps: [{ tool: "boq.findFeatureMismatch", args: {}, activity: "正在比较项目特征" }],
      };
    if (/检查|查一下|体检|全查|审核/.test(m))
      return { steps: [{ tool: "boq.compare", args: {}, activity: "正在全面检查清单" }] };

    // 占比分析
    if (/占比|分布|分别占|分析/.test(m)) {
      const cats = MATERIAL_CATEGORIES.filter((c) => m.includes(c.replace(/柜|设备/, "")));
      if (/专业|各专业/.test(m))
        return {
          steps: [{ tool: "cost.professionalBreakdown", args: {}, activity: "正在按专业汇总金额" }],
        };
      return {
        steps: [
          {
            tool: "cost.materialBreakdown",
            args: { categories: cats.length ? cats : undefined },
            activity: "正在按材料类别汇总金额",
          },
        ],
      };
    }

    // 事实/台账
    if (/事实|台账|项目信息|已知信息/.test(m))
      return { steps: [{ tool: "project.read", args: {}, activity: "正在读取项目台账" }] };

    // 总价/汇总
    if (/总价|总金额|合计|多少钱|汇总|概况/.test(m))
      return {
        steps: [{ tool: "cost.calculate", args: {}, activity: "正在汇总金额" }],
      };

    // 打开清单
    if (/清单|表格|看看|打开|显示/.test(m))
      return { steps: [{ tool: "boq.read", args: {}, activity: "正在打开清单" }] };

    return { steps: [], fallbackMessage: CAPABILITIES };
  }
}
