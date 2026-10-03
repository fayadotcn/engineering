import type { RunContext } from "./context";
import type { ToolResult } from "./tools/registry";
import { REGION_RE } from "@dataset/priceParse";
import { autopilotPlan } from "./autopilot";

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
• 成本构成：人材机费用占比、毛利与成本倒挂项（报价低于成本）
• 工程量反算：总价控制到目标值（含税可指定税率），只调工程量
• 定额测算：匹配定额子目并组价，与清单价对比偏差
• 两版清单对审：招标/中标/结算的价差、量差、独有项与总额差
• 工程量计算：「算一下 3层×12个+15」直接求值，可写回清单项
• 报告：生成造价分析报告 Excel（汇总/占比/台账/异常）
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

    // 内联价格偏好：「用上上品牌测算」「按海南价补价」「按2024年6月信息价组价」→ 先写台账再执行
    const prefSteps: PlanStep[] = [];
    const brandM = m.match(/(?:用|按|以|要)([一-龥A-Za-z0-9]{2,8}?)(?:品牌|牌(?=的))(?=的|价|测|算|组|补|，|,|$)/);
    if (brandM && !/^(铜|铝|钢|铁|金|银|锡|铅|木|瓷|塑|砖|石)$/.test(brandM[1])) {
      const cat = MATERIAL_CATEGORIES.find((c) => m.includes(c.replace(/柜|设备/, "")));
      prefSteps.push({ tool: "project.setFact", args: { key: cat ? `${cat}品牌` : "品牌", value: brandM[1] }, activity: `记录品牌偏好:${brandM[1]}` });
    }
    const regionM = m.match(
      new RegExp(`(${REGION_RE.source}|${"[一-龥]{2,7}地区"})(?:的)?(?=价|信息价|测|算|组|补|报)`)
    );
    if (regionM) prefSteps.push({ tool: "project.setFact", args: { key: "地区", value: regionM[1] }, activity: `记录地区偏好:${regionM[1]}` });
    const periodM = m.match(/(20\d{2})\s*年?\s*(\d{1,2})\s*月?(?:的)?(?=价|信息价|测|算|组|补)/);
    if (periodM && !(periodM.index! + periodM[0].length < m.length && /\d/.test(m[periodM.index! + periodM[0].length])))
      prefSteps.push({ tool: "project.setFact", args: { key: "价格期", value: `${periodM[1]}-${periodM[2].padStart(2, "0")}` }, activity: `记录价格期偏好` });

    // 一键报价：UI 按钮走 extra.autopilot（绕过 LLM，确定性管线）；
    // 纯文本「一键报价/自动报价」同样落到这条管线。
    if (extra?.autopilot || /一键|全自动|智能报价|自动.{0,4}(报价|组价|测算)|帮我.{0,4}报价/.test(m)) {
      const p = autopilotPlan(ctx);
      return { steps: [...prefSteps, ...p.steps], fallbackMessage: p.fallbackMessage };
    }

    // 组价写回（必须在「写回源文件」「定额测算」「定额|组价」之前拦截：
    // 只说「写回组价/把测算写回」时意图是 applyCalc，不是预览也不是写回 Excel）
    if (!/源文件|excel|原表/i.test(m) && /(组价|测算|定额|综合单价).{0,4}(写回|写入|写进|套用|落)|(写回|写入|写进|套用).{0,4}(组价|测算|定额|综合单价)|套用定额价/.test(m)) {
      return {
        steps: [
          { tool: "quota.calculate", args: {}, activity: "正在按定额测算综合单价" },
          { tool: "quota.applyCalc", args: {}, activity: "正在把组价写回清单" },
        ],
      };
    }

    // file ingest (triggered by upload)
    if (extra?.ingestFileId) {
      return {
        steps: [
          { tool: "file.inspect", args: { fileId: extra.ingestFileId }, activity: "正在识别表格结构" },
          { tool: "file.ingest", args: { fileId: extra.ingestFileId }, activity: "正在导入数据" },
          { tool: "project.summary", args: {} },
        ],
      };
    }

    // 写事实: "税率设为9%" / "电缆品牌是上上" / "措施费率=3%，规费费率2%"（一条消息可写多项）
    const factMatches = [...m.matchAll(
      /(税率|地区|电缆品牌|电线品牌|品牌|管理费率|利润率|价格日期|人工费调整系数|措施费率|规费费率|暂列金额率|暂列金额)\s*(?:设为|设置为|是|为|=|:|：)\s*([^\s，。,；;]+)/g
    )];
    if (factMatches.length) {
      return {
        steps: factMatches.map((fm) => ({
          tool: "project.setFact",
          args: { key: fm[1], value: fm[2] },
          activity: `正在写入台账：${fm[1]} = ${fm[2]}`,
        })),
      };
    }

    // 导出 / 写回（询价写回走 material 路径，不在此拦截）
    if (/写回|回写|更新到源文件|更新到.*文件/.test(m) && !/询价|报价/.test(m))
      return { steps: [{ tool: "excel.write", args: {}, activity: "正在写回源文件" }] };
    if (/导出|生成.*excel|下载/i.test(m))
      return {
        steps: [{ tool: "report.exportExcel", args: {}, activity: "正在导出 Excel" }],
      };

    // 措施费系数计取（脚手架/超高/高层增加费，川标官方费率表）
    if (/措施费|脚手架|超高增加|高层.*增加费|檐口|操作物高度|系统调整费|系数.*计取/.test(m))
      return { steps: [{ tool: "cost.measureFees", args: {}, activity: "正在按川标系数计取措施费" }] };

    // 费用汇总/取费（无目标金额时）：分部分项→措施→规费→税金→含税造价
    if (/费用汇总|取费|造价汇总|汇总表|含税总价|总价是多少|总造价|费用构成/.test(m))
      return { steps: [{ tool: "cost.feeSummary", args: {}, activity: "正在汇总费用" }] };

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

    // 两版清单对审
    if (/对审|对比.*清单|清单.*对比|中标.*结算|结算.*对比|两个文件|两版/.test(m))
      return {
        steps: [{ tool: "boq.compareFiles", args: {}, activity: "正在对齐两版清单" }],
      };

    // 查定额说明/计算规则（必须在「定额测算」之前：「查定额说明」也含"定额"）
    if (/定额说明|计算规则|规范|条文|依据|册说明|章说明|怎么计算|怎么算|如何计算|如何算|计算方法|计算方式/.test(m)) {
      const q = m
        .replace(/查一下|查|看|找|检索|一下|的|定额说明|计算规则|规范|条文|依据|册说明|章说明|四川|2020|怎么计算|怎么算|如何计算|如何算|计算方法|计算方式|请问|吗|呢/g, " ")
        .replace(/\s+/g, " ").trim();
      return {
        steps: [{ tool: "spec.search", args: { query: q || m.slice(0, 30) }, activity: "正在检索定额说明及计算规则" }],
      };
    }

    // 定额测算: "按四川2020定额测算" / "定额组价" / "测算一下"
    if (/定额|组价|测算/.test(m)) {
      return {
        steps: [
          ...prefSteps,
          { tool: "quota.match", args: {}, activity: "正在匹配定额子目" },
          { tool: "quota.calculate", args: {}, activity: "正在按定额测算综合单价" },
        ],
      };
    }

    // 生成分析报告
    if (/报告|报表/.test(m) && /生成|出|做|导/.test(m))
      return {
        steps: [{ tool: "report.generate", args: {}, activity: "正在生成分析报告" }],
      };

    // 工程量计算式: "算一下 3层×12个+15" / "12.5*(2+3) 等于多少"
    // 捕获段允许中文/字母（单位词），求值时由 evalExpr 剥离
    const exprMatch = m.match(/[\d(（][\d+\-*/×÷()（）.%\s一-龥a-zA-Z]*[\d)）%一-龥a-zA-Z]/);
    if (/计算|算一下|算|求|等于|是多少/.test(m) && exprMatch && /[+\-*/×÷(（]|\d\s*[)%]?\s*[+\-*/×÷]|层|个|米|根|段|处|台|套/.test(m)) {
      return {
        steps: [
          {
            tool: "quantity.calculate",
            args: { expression: exprMatch[0].trim(), label: m.slice(0, 40) },
            activity: "正在计算工程量",
          },
        ],
      };
    }

    // （组价写回已在上方优先拦截——保留此注释防止误以为遗漏）

    // 缺价补价（专业闭环）：材料库补主材暂估价 → 定额测算 → 组价写回综合单价
    if (/补价|补齐|缺价|未定价|没价|套价/.test(m)) {
      const apply = /补|填|写|套/.test(m) && !/预览|看看|查/.test(m);
      const steps: StepOrFn[] = [
        ...prefSteps,
        { tool: "material.matchLibrary", args: {}, activity: "正在用材料库匹配未定价项主材价" },
      ];
      if (apply)
        steps.push(
          { tool: "material.fillFromLibrary", args: {}, activity: "正在写回主材暂估价" },
          { tool: "quota.calculate", args: {}, activity: "正在按定额组价" },
          { tool: "quota.applyCalc", args: {}, activity: "正在把组价写回清单" }
        );
      return { steps };
    }

    // 材料价格历史
    if (/价格历史|历史价|历次询价|价格走势|价格轨迹/.test(m)) {
      const nameMatch = m.match(
        /([一-龥A-Za-z0-9x×*+\-]{2,20}?)的?(?:价格历史|历史价|价格走势|价格轨迹|历次询价)/
      );
      let materialName = nameMatch?.[1]
        ?.replace(/^(查一下|查|看一下|看看|帮我|请|把|的)+/, "")
        .replace(/(材料|物料)$/, "");
      if (materialName && /^(全部|所有|各种|各种类)/.test(materialName)) materialName = "";
      return {
        steps: [
          {
            tool: "material.getPriceHistory",
            args: materialName ? { materialName } : {},
            activity: "正在汇总历次询价价格",
          },
        ],
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

    // 人材机成本构成/毛利分析（须在通配「分析」之前拦截）
    if (/人材机|工料机|成本构成|成本分析|成本占比|毛利|直接成本|直接费/.test(m))
      return {
        steps: [{ tool: "cost.composition", args: {}, activity: "正在分析人材机成本构成" }],
      };

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
