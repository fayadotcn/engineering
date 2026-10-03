import type { RunContext } from "./context";
import type { ToolResult } from "./tools/registry";
import { REGION_RE } from "@dataset/priceParse";
import { parseRateValue, parseAreaValue } from "@project/facts";
import { autopilotPlan } from "./autopilot";
import { D } from "@cost-engine/money";

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
  /** final agent message when no step was emitted (动态定位全部落空时的兜底说明) */
  fallbackMessage?: string;
  /** 恒追加的尾注（如「缺费率跳过写回」「税率取默认」——步骤执行了也要提示） */
  tailNote?: string;
}

export interface Planner {
  name: string;
  plan(ctx: RunContext, message: string, extra?: Record<string, unknown>): Promise<Plan>;
}

/** 从消息里提取调价/改价的范围词（「把电缆的单价」→"电缆"）；无范围词返回 "" */
const scopeWordOf = (m: string): string =>
  m
    .match(/([一-龥A-Za-z]{2,12}?)(?:的)?(?:单价|综合单价|工程量|数量|价格)/)?.[1]
    ?.replace(/^(把|将|对|请|所有|全部|整个|统一|综合|清单项?|各项|项目|相同项?|同项|相同|各)+/, "") ?? "";

/** 范围词过滤清单项：类别词走语义 category（容错「配电箱/配电箱柜」级差异），否则名称/特征子串 */
const scopeFilter = <T extends { name: string; rawFeature: string; features: { category?: string } }>(
  items: T[],
  scope: string
): T[] => {
  if (!scope) return items;
  const cats = MATERIAL_CATEGORIES.filter((c) => scope.includes(c.replace(/柜|设备/, "")));
  return items.filter(
    (i) =>
      cats.some((c) => {
        const fc = i.features.category ?? "";
        return !!fc && (fc === c || fc.includes(c) || c.includes(fc));
      }) ||
      i.name.includes(scope) ||
      i.rawFeature.includes(scope)
  );
};

const MATERIAL_CATEGORIES = [
  "电缆", "电线", "桥架", "管道", "阀门", "灯具", "配电箱柜", "母线",
  "支架", "设备", "喷淋设备", "消防设备", "开关插座", "套管", "保温",
  "管件", "接线盒", "电缆附件", "土方", "防腐刷油",
];

const CAPABILITIES = `我可以直接执行这些造价任务：
• 检查清单：相同项不同单价、综合单价异常、项目特征不一致、重复项、合价算术校验、单位不一致、一码多名、非标/缺编码、负量价缺单位等数据质量、费用符合性（不可竞争费/限价）
• 询价处理：把询价文件价格匹配并写回清单，未询到的自动标记；可查材料价格库与历史价
• 甲供材核对：发包人供货表与清单主材价核对，标重复计价并可确认后扣减
• 金额分析：各专业占比、单位工程费用汇总、单方造价指标、电缆/桥架/管道/阀门等材料类别占比
• 成本构成：人材机费用占比、毛利与成本倒挂项（报价低于成本）
• 总价反算：总价控制到目标值（含税可指定税率），默认按比例调综合单价
• 定额测算：匹配定额子目并组价，与清单价对比偏差；可查定额说明与计算规则
• 两版清单对审：招标/中标/结算的价差、量差、独有项与总额差
• 工程量计算：「算一下 3层×12个+15」直接求值，可写回清单项
• 报告：生成造价分析报告 Excel（汇总/费用/占比/成本构成/综合单价分析/主要材料/甲供材/台账/异常）
• 修改与导出：改单价/工程量、补录/删除清单项，展示 Diff，导出或写回 Excel（写回留痕可复算）
• 撤销：「撤销上一次操作」「撤销刚才的改价」回退到操作前状态（确认门）
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

    // 内联台账写入（「管理费率设为5%」类）——一条消息可同时带台账写入与任务指令
    const factMatches = [...m.matchAll(
      /(税率|地区|电缆品牌|电线品牌|品牌|管理费率|利润率|价格日期|人工费调整系数|措施费率|规费费率|暂列金额率|暂列金额|建筑面积|檐口高度|操作物高度)\s*(?:设为|设置为|是|为|=|:|：)\s*([^\s，。,；;]+)/g
    )];

    // 一键报价：UI 按钮走 extra.autopilot（绕过 LLM，确定性管线）；
    // 纯文本「一键报价/自动报价」同样落到这条管线。
    if (extra?.autopilot || /一键|全自动|智能报价|自动.{0,4}(报价|组价|测算)|帮我.{0,4}报价/.test(m)) {
      const p = autopilotPlan(ctx);
      // autopilot 消息里的费率/台账赋值一并先写入——autopilot 的 applyCalc 门会重查台账
      const covered = new Set(prefSteps.map((s) => String(s.args.key)));
      const factSteps: PlanStep[] = factMatches
        .filter((fm) => !covered.has(fm[1]))
        .map((fm) => ({
          tool: "project.setFact",
          args: { key: fm[1], value: fm[2] },
          activity: `正在写入台账：${fm[1]} = ${fm[2]}`,
        }));
      // fallbackMessage 只讲「缺费率跳过写回」——内联写入了的费率视同已齐，不再误导
      const inlineKeys = new Set(factSteps.map((s) => String(s.args.key)));
      const stillMissing = ["管理费率", "利润率"].some(
        (k) => !ctx.facts.some((f) => f.key === k && f.value.trim() !== "") && !inlineKeys.has(k)
      );
      return {
        steps: [...prefSteps, ...factSteps, ...p.steps],
        // 空清单走兜底；缺费率是并行尾注（管线照常跑，只跳过写回），内联写入已补齐时撤下
        fallbackMessage: !ctx.boq.itemCount ? p.fallbackMessage : undefined,
        tailNote: ctx.boq.itemCount && stillMissing ? p.fallbackMessage : undefined,
      };
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

    // 补录清单项：「补录 灭火器 20个 单价85」——尾部按「数量+单位+单价」解析；
    // 带计价类型词时按对应 feeType 落行：「补录总价措施 安全文明施工费 12000元」直填合价
    const addM = m.match(/(?:补录|新增|添加)\s*(?:一|1)?\s*(?:条|项|个)?\s*(?:清单项?)?[：:，,]?\s*(.+)/);
    if (addM) {
      let rest = addM[1].trim();
      let feeType: string | undefined;
      const typeM = rest.match(/^(总价措施|其他项目|单价措施|分部分项)\s*[，,]?\s*(.*)$/);
      if (typeM && typeM[2]) {
        feeType = typeM[1];
        rest = typeM[2].trim();
      }
      const tail = rest.match(/^(.*?)[，,\s]+(\d+(?:\.\d+)?)\s*(个|台|套|米|m|㎡|m2|m²|立方米|m3|m³|项|根|块|组|盏|座|樘|条|只|处|点|kg|公斤|t|吨|km|工日|台班)\s*[，,]?\s*(?:单价|综合单价)?\s*(\d+(?:\.\d+)?)\s*元?\s*$/);
      if (tail) {
        return {
          steps: [{ tool: "boq.addItem", args: { name: tail[1].trim(), quantity: tail[2], unit: tail[3], unitPrice: tail[4], ...(feeType ? { feeType } : {}) }, activity: `正在补录「${tail[1].trim()}」` }],
        };
      }
      // 总额计价行没有量价结构——「补录总价措施 安全文明施工费 12000」尾部只有一个金额
      const lump = rest.match(/^(.*?)[，,\s]+(\d+(?:\.\d+)?)\s*(万)?\s*元?\s*$/);
      if (lump) {
        if (!feeType) feeType = /措施|文明|安全|临设|雨季|夜间|赶工|二次搬运/.test(lump[1]) ? "总价措施" : "其他项目";
        const amt = lump[3] ? D(lump[2]).mul(10000).toString() : lump[2];
        return {
          steps: [{ tool: "boq.addItem", args: { name: lump[1].trim(), totalPrice: amt, feeType }, activity: `正在补录「${lump[1].trim()}」` }],
        };
      }
      return { steps: [], fallbackMessage: "补录格式：补录 名称，数量单位，单价。例如「补录 灭火器 20个 单价85元」；总额计价项如「补录总价措施 安全文明施工费 12000元」" };
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
    if (factMatches.length) {
      return {
        steps: factMatches.map((fm) => ({
          tool: "project.setFact",
          args: { key: fm[1], value: fm[2] },
          activity: `正在写入台账：${fm[1]} = ${fm[2]}`,
        })),
      };
    }

    // 清单筛选：「只看电缆项」「筛选给排水的清单」「显示消防专业」→ boq.filter 切视图筛选
    const filterM = m.match(/(?:只看|仅看|筛选|过滤|显示|列出)(?:一下|下)?(?:所有|全部)?([一-龥A-Za-z0-9]{1,15}?)(?:的)?(?:清单|项|条目|行|项目)?\s*$/);
    // 「只看未定价/没组价的项」——定价状态筛选走 unpriced 标志（「未定价」含「价」会被排除词拦掉，先截）
    if (filterM && /未定价|未报价|没定价|没组价|未组价|待定价|缺价/.test(filterM[1]))
      return { steps: [{ tool: "boq.filter", args: { unpriced: true, onlyItems: true }, activity: "正在筛选未定价项" }] };
    if (filterM && !/价格|单价|价|费用|汇总|合计|定额|编码|特征|名称|异常|问题|报告|差异|文件/.test(filterM[1])) {
      const scope = filterM[1].trim();
      const DISC_WORDS: [string, string][] = [
        ["电气|配电|桥架|电缆|照明|电线", "ELECTRICAL"],
        ["给排水|给水|排水|管道|卫生器具|水泵", "PLUMBING"],
        ["消防|喷淋|消火栓|火灾报警|灭火", "FIRE"],
        ["暖通|通风|空调|防排烟|风管|风机", "HVAC"],
        ["弱电|智能化|安防|监控|综合布线|网络", "WEAK_CURRENT"],
      ];
      const disc = DISC_WORDS.find(([re]) => new RegExp(re).test(scope))?.[1];
      const reset = /^全部|所有|完整|原始/.test(scope);
      const compute = async (): Promise<PlanStep | null> => {
        // 「显示全部」= 清筛选复位；专业词走 discipline；其他按名称/编码模糊筛选
        const filter = reset ? { onlyItems: false, unpriced: false } : disc ? { discipline: disc, onlyItems: true } : { query: scope, onlyItems: true };
        if (!reset && !disc) {
          const { listBoq } = await import("@boq/service");
          if (!scopeFilter(await listBoq(ctx.projectId), scope).length) return null;
        }
        return { tool: "boq.filter", args: filter, activity: reset ? "正在恢复完整清单" : `正在筛选「${scope}」` };
      };
      return { steps: [compute], fallbackMessage: `清单中没有匹配「${scope}」的项` };
    }

    // 撤销：定位最近一条可撤销回执（可按摘要关键词过滤），确认门后执行回退。
    // 「撤销筛选/恢复显示全部」是筛选复位，不是数据操作撤销。
    const undoM = m.match(/(?:撤销|撤回|回退|恢复|undo)(?:一下|了)?(.*)$/i);
    if (undoM) {
      const tail = (undoM[1] ?? "").trim();
      if (/筛选|过滤|全部|显示|完整/.test(tail))
        return { steps: [{ tool: "boq.filter", args: { onlyItems: false, unpriced: false }, activity: "正在恢复完整清单" }] };
      const query = tail.replace(/^(?:刚才|上一次|上次|最近|刚刚|的|把|将)+/, "").replace(/(?:的)?(?:操作|修改|改动|记录|动作|步骤)$/, "").trim() || undefined;
      const compute = async (): Promise<PlanStep | null> => {
        const { prisma } = await import("@database/client");
        const receipts = await prisma.actionReceipt.findMany({
          where: { projectId: ctx.projectId, reversible: true },
          orderBy: { createdAt: "desc" },
          take: 50,
          select: { id: true, summary: true },
        });
        // 摘要措辞与口语词不同（「改价」对「修改…清单项」）——同义词兜底匹配
        const SYN: [RegExp, RegExp][] = [
          [/改价|调价|单价|价格|合价|修改|工程量|补编码|编码/, /修改|暂估价|写回|组价/],
          [/删除|删掉|去除|恢复删除/, /删除|清除/],
          [/补录|新增|补项|添加/, /补录|新增/],
          [/取价|询价|暂估价|材料价|补价/, /暂估价|询价|取价|材料库/],
          [/组价|定额|测算|套定额/, /组价|定额/],
          [/写回|回写/, /写回/],
          [/甲供/, /甲供/],
        ];
        const hit = query
          ? receipts.find((r) => r.summary.includes(query)) ??
            receipts.find((r) => SYN.some(([q, s]) => q.test(query) && s.test(r.summary)))
          : receipts[0];
        if (!hit) return null;
        return { tool: "receipt.undo", args: { receiptId: hit.id, summary: hit.summary }, activity: `正在撤销「${hit.summary}」` };
      };
      return { steps: [compute], fallbackMessage: query ? `没有可撤销的「${query}」操作记录` : "没有可撤销的操作记录" };
    }

    // 删除清单项：先按名称/编码关键词定位，确认门后删除（回执全字段快照可撤销）。
    // 「删掉重复项/删除文件」不交这条路——删谁有歧义，留给人工或显式清单项关键词。
    const delM = m.match(/(?:删除|删掉|去除|去掉)(?:把|将|一下)?([一-龥A-Za-z0-9]{2,12}?)(?:的)?(?:清单|项目|条目|行|项)?\s*(?:清单项|项|行|条目)?\s*$/);
    if (delM && !/重复|文件|记录|回执|台账|事实|项目$/.test(delM[1])) {
      const kw = delM[1];
      return {
        steps: [
          { tool: "boq.search", args: { query: kw }, activity: `正在定位「${kw}」清单项` },
          (results: ToolResult[]) => {
            const hits = (results.at(-1)?.observation ?? []) as { id: string }[];
            if (!hits.length) return null;
            return {
              tool: "boq.deleteItems",
              args: { ids: hits.slice(0, 50).map((h) => h.id), reason: `删除「${kw}」相关项` },
              activity: `正在删除 ${Math.min(hits.length, 50)} 个清单项`,
            };
          },
        ],
        fallbackMessage: `清单中没有找到名称/编码/特征含「${kw}」的项`,
      };
    }

    // 导出 / 写回（询价写回走 material 路径，不在此拦截）
    // 对审报告导出要在通用导出之前：「导出对审报告」也含「导出」
    if (/导出|生成|下载/.test(m) && /对审|对比报告/.test(m))
      return {
        steps: [{ tool: "report.exportCompare", args: {}, activity: "正在导出对审报告" }],
      };
    if (/写回|回写|更新到源文件|更新到.*文件/.test(m) && !/询价|报价/.test(m))
      return { steps: [{ tool: "excel.write", args: {}, activity: "正在写回源文件" }] };
    if (/导出|生成.*excel|下载/i.test(m))
      return {
        steps: [
          // 「检查清单并导出」：先跑综合检查再导出，报告自带异常摘要页
          ...(/检查|核查|清标|排查/.test(m)
            ? [{ tool: "boq.compare", args: {}, activity: "正在综合检查清单" }]
            : []),
          { tool: "report.exportExcel", args: {}, activity: "正在导出 Excel" },
        ],
      };

    // 措施费系数计取（脚手架/超高/高层增加费，川标官方费率表）
    if (/措施费|脚手架|超高增加|高层.*增加费|檐口|操作物高度|系统调整费|系数.*计取/.test(m))
      return { steps: [{ tool: "cost.measureFees", args: {}, activity: "正在按川标系数计取措施费" }] };

    // 工程量反算: 总价控制到 X（「500万」「1.2亿」要按中文金额单位放大）。
    // 必须在「费用汇总」之前——「含税总价控制到500万」含「含税总价」字样，
    // 但动词+金额决定了它是反算不是汇总。
    const target = m.match(/(?:控制|调|调整|降|到|为)\D{0,6}([\d,]+(?:\.\d+)?)\s*(亿|万|千)?/);
    const perArea = /单方|每平(?:米|方)|元\s*[/／]\s*(?:㎡|平)/.test(m);
    if (perArea && target) {
      if (/合理|合适|怎么样|如何|高吗|贵吗|便宜/.test(m))
        return { steps: [{ tool: "cost.feeSummary", args: {}, activity: "正在汇总费用与单方造价" }] };
      // 「单方造价控制到500元/㎡」→ 目标总价 = 单方价 × 建筑面积；无面积事实无法换算
      const area = parseAreaValue(ctx.facts.find((f) => /面积/.test(f.key))?.value);
      if (!area || area <= 0)
        return { steps: [], fallbackMessage: "按单方造价反算需要建筑面积——请在计价设置填写「建筑面积（㎡）」，或回复「建筑面积设为12000」" };
      const unit = Number(target[1].replace(/,/g, ""));
      return {
        steps: [{
          tool: "quantity.adjust",
          args: { targetTotal: Number((unit * area).toFixed(2)), apply: true },
          activity: `正在按单方造价 ${unit} 元/㎡ × ${area}㎡ 反算综合单价`,
        }],
      };
    }
    if (/总价|含税|总额|造价/.test(m) && target && !perArea) {
      const mult = target[2] === "亿" ? 1e8 : target[2] === "万" ? 1e4 : target[2] === "千" ? 1e3 : 1;
      const targetTotal = D(target[1].replace(/,/g, "")).mul(mult).toNumber();
      const inclTax = /含税/.test(m);
      const taxFact = ctx.facts.find((f) => f.key === "税率")?.value;
      // 台账值须走 parseRateValue 归一化——「9%」直接 Number() 得 NaN
      const taxRate = inclTax ? (parseRateValue(taxFact) ?? 0.09) : 0;
      return {
        steps: [
          {
            tool: "quantity.adjust",
            args: { targetTotal, taxRate, apply: true },
            activity: `正在按目标总价 ${targetTotal} 反算工程量${inclTax ? `（含税，税率 ${taxRate}）` : ""}`,
          },
        ],
        tailNote: inclTax && parseRateValue(taxFact) === null
          ? `已按含税口径处理，税率取默认 9%（项目台账未记录税率，可用「税率设为x%」写入事实）`
          : undefined,
      };
    }

    // 总价按比例调整：「总价下浮5%」「含税报价整体上浮3个点」——
    // 先取当前总价算目标值，再走 quantity.adjust（默认调综合单价，合规）。
    // 必须在「费用汇总」之前：「含税总价下浮5%」也含「含税总价」字样。
    const pctM = m.match(/(下浮|上浮|下调|上调|降低|提高|优惠|让利)\s*(\d+(?:\.\d+)?)\s*(?:%|％|个点|点)/);
    if (pctM && /总价|造价|报价|总额|含税|清单/.test(m)) {
      const dir = /下|降|优惠|让利/.test(pctM[1]) ? -1 : 1;
      const pct = Number(pctM[2]);
      const inclTax = /含税/.test(m);
      const taxFact = ctx.facts.find((f) => f.key === "税率")?.value;
      const taxRate = inclTax ? (parseRateValue(taxFact) ?? 0.09) : 0;
      // 「电缆造价下浮5%」：材料类别词直接修饰 造价/费用/报价 → 只调该类别项单价，
      // 而非整体总价（「含税报价/总造价」剥前缀后不在类别词表，仍走整体路径）。
      const feeW = m.match(/([一-龥A-Za-z]{2,8}?)(?:的)?(?:造价|费用|报价)/)?.[1]
        ?.replace(/^(把|将|对|请|所有|全部|整个|统一|综合|清单项?|各项|项目|该|本|总|含税)+/, "") ?? "";
      if (feeW && MATERIAL_CATEGORIES.some((c) => feeW.includes(c.replace(/柜|设备/, "")))) {
        return {
          steps: [
            async (): Promise<PlanStep | null> => {
              const { listBoq } = await import("@boq/service");
              const { isPricableItem } = await import("@shared/types");
              const items = await listBoq(ctx.projectId);
              const leaf = items.filter((i) => !i.isHeader && i.name.trim());
              const pool = scopeFilter(
                leaf.filter((i) => isPricableItem(i) && !Number.isNaN(Number(i.totalPrice))),
                feeW
              );
              if (!pool.length) return null;
              const subtotal = pool.reduce((a, i) => a + Number(i.totalPrice), 0);
              const allTotal = leaf.reduce((a, i) => a + Number(i.totalPrice), 0);
              const targetTotal = Number((allTotal + (subtotal * dir * pct) / 100).toFixed(2));
              return {
                tool: "quantity.adjust",
                args: { targetTotal, taxRate, allowedItemIds: pool.map((i) => i.id), apply: true },
                activity: `正在将「${feeW}」项综合单价${pctM[1]} ${pct}%`,
              };
            },
          ],
          fallbackMessage: `没有找到「${feeW}」的可计价清单项`,
        };
      }
      return {
        steps: [
          { tool: "cost.calculate", args: {}, activity: "正在取当前总价" },
          async (results): Promise<PlanStep | null> => {
            const obs = results[0]?.observation as { exclTax?: string; inclTax?: string | null } | undefined;
            const excl = Number(obs?.exclTax);
            const base = inclTax ? (obs?.inclTax ? Number(obs.inclTax) : excl * (1 + taxRate)) : excl;
            if (!Number.isFinite(base) || !(base > 0)) return null;
            const targetTotal = Number((base * (1 + (dir * pct) / 100)).toFixed(2));
            return {
              tool: "quantity.adjust",
              args: { targetTotal, taxRate, apply: true },
              activity: `正在按${pctM[1]} ${pct}% 反算（目标 ${targetTotal}）`,
            };
          },
        ],
      };
    }

    // 范围化比例调整：「电缆单价下浮5%」「管道工程量上浮3个点」——
    // 锁定范围的项按比例调，数学上等价于把目标总价设成 现合计+范围合计×pct，
    // 复用 quantity.adjust 的残差分分钱吸收与确认门。
    const scopePctM = m.match(/(下浮|上浮|下调|上调|降低|提高|优惠|让利)\s*(\d+(?:\.\d+)?)\s*(?:%|％|个点|点)/);
    if (
      scopePctM &&
      /单价|综合单价|工程量|数量/.test(m) &&
      !/总价|造价|总额|含税|控制|调到|调到|到\s*\d/.test(m)
    ) {
      const dir = /下|降|优惠|让利/.test(scopePctM[1]) ? -1 : 1;
      const pct = Number(scopePctM[2]);
      const modeQty = /工程量|数量/.test(m) && !/单价|价格/.test(m);
      const scope = scopeWordOf(m);
      return {
        steps: [
          async (): Promise<PlanStep | null> => {
            const { listBoq } = await import("@boq/service");
            const { isPricableItem } = await import("@shared/types");
            const items = await listBoq(ctx.projectId);
            const leaf = items.filter((i) => !i.isHeader && i.name.trim());
            const pool = scopeFilter(
              leaf.filter((i) => isPricableItem(i) && !Number.isNaN(Number(i.totalPrice))),
              scope
            );
            if (!pool.length) return null;
            const subtotal = pool.reduce((a, i) => a + Number(i.totalPrice), 0);
            const allTotal = leaf.reduce((a, i) => a + Number(i.totalPrice), 0);
            const targetTotal = Number((allTotal + (subtotal * dir * pct) / 100).toFixed(2));
            const allowedItemIds = scope ? pool.map((i) => i.id) : undefined;
            return {
              tool: "quantity.adjust",
              args: {
                targetTotal,
                mode: modeQty ? "quantity" : "price",
                ...(allowedItemIds ? { allowedItemIds } : {}),
                apply: true,
              },
              activity: `正在将${scope ?? "全部"}项${modeQty ? "工程量" : "综合单价"}${scopePctM[1]} ${pct}%`,
            };
          },
        ],
        fallbackMessage: scope ? `没有找到「${scope}」的可计价清单项` : undefined,
      };
    }

    // 费用汇总/取费（无目标金额时）：分部分项→措施→规费→税金→含税造价
    // 「各单位工程费用汇总」例外——那是按单位工程分组，不是全项目取费口径
    if (!/单位工程|单项工程/.test(m) && /费用汇总|取费|造价汇总|汇总表|含税总价|总价是多少|总造价|费用构成|单方造价|单方指标|造价指标|每平(?:米|方)|元\s*[/／]\s*(?:㎡|平)/.test(m))
      return { steps: [{ tool: "cost.feeSummary", args: {}, activity: "正在汇总费用" }] };

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

    // 人工组价：「镀锌钢管 定额改为 5H0332」「消防管 增列定额 5G0110」「XX 清除组价方案」
    // ——存疑匹配的专业处置出口。必须在「定额测算」之前：这些句式也含「定额」
    const quotaM = m.match(/([一-龥A-Za-z0-9]{1,20}?)(?:的)?(?:定额|组价)?(?:改|换|设)(?:为|成)?\s*[：:=""]?\s*(?:定额|定额编号)?\s*([0-9A-Za-z][\w-]{2,15})\s*$/);
    const appendM = !quotaM && m.match(/([一-龥A-Za-z0-9]{1,20}?)(?:的)?(?:定额|子目|组价方案)?(?:增列|追加|加套|补套|增加)(?:定额|子目)?\s*[：:=""]?\s*([0-9A-Za-z][\w-]{2,15})\s*$/);
    const clearM = !quotaM && !appendM && m.match(/([一-龥A-Za-z0-9]{1,20}?)(?:的)?(?:清除|清空|移除)(?:其|它的)?(?:组价|组价方案|定额方案|定额)\s*$/);
    // 「XX的编码/单价/费率改为…」各有专用路由——scope 尾词在这些字段上时不应落入定额改派
    const quotaFieldTail = /编码|单价|价格|合价|工程量|数量|费率|税率|名称|特征$/;
    if ((quotaM || appendM || clearM) && !(quotaM && quotaFieldTail.test(quotaM[1])) && !(appendM && quotaFieldTail.test(appendM[1])) && !(clearM && quotaFieldTail.test(clearM[1]))) {
      const mm = (quotaM ?? appendM ?? clearM) as RegExpMatchArray;
      const scope = mm[1].replace(/^(把|将|对|请|所有|全部|整个|清单项?|各项|项目)+/, "").trim();
      const code = clearM ? undefined : mm[2];
      const mode = appendM ? "append" : "replace";
      const clear = !!clearM;
      const compute = async (): Promise<PlanStep | null> => {
        const { listBoq } = await import("@boq/service");
        const items = (await listBoq(ctx.projectId)).filter((i) => !i.isHeader && i.name.trim());
        const pool = scopeFilter(items, scope);
        if (!pool.length) return null;
        return {
          tool: "quota.setItemQuota",
          args: clear ? { itemIds: pool.map((i) => i.id), clear: true } : { itemIds: pool.map((i) => i.id), quotaCode: code, mode },
          activity: clear ? `正在清除组价方案` : `正在${mode === "append" ? "增列" : "套用"}定额 ${code}`,
        };
      };
      return { steps: [compute], fallbackMessage: scope ? `没有匹配「${scope}」的清单项` : "没有可组价的清单项" };
    }

    // 定额库检索：「定额库里有什么支吊架子目」「查一下DN150的定额」——查子目不走整单匹配
    if (/定额|子目/.test(m) && /查|搜|找|检索|有没有|有哪些|有什么|列出|看看/.test(m) && !/测算|组价|写回|说明|规则|费率|怎么|改为|增列|清除/.test(m)) {
      const q = m
        .replace(/查一下|查|搜|找|检索|看看|看|一下|下|定额库|定额|子目|有没有|有哪些|有什么|列出|的|吗|呢|啊|吧|？|\?|，|,|、|里|中|内|请|帮我/g, " ")
        .replace(/\s+/g, " ").trim();
      return {
        steps: [{ tool: "quota.search", args: { query: q || m.slice(0, 30) }, activity: "正在检索定额库子目" }],
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

    // 材料/询价检索：「材料库里有没有镀锌钢管」「电缆价格多少」「查一下配电箱的报价」→ material.search
    if (/价格|单价|报价|多少钱|价格库|材料库|询价表|信息价|市场价/.test(m) &&
        /查|搜|找|检索|有没有|有哪些|有什么|多少|看看/.test(m) &&
        !/测算|组价|写回|补价|补全|补齐|改|设|调|汇总|检查|清标|导出|删除|撤销|异常|偏差|符合/.test(m)) {
      const q = m
        .replace(/查一下|查|搜|找|检索|看看|看|一下|下|价格库|材料库|询价表|信息价|市场价|有没有|有哪些|有什么|多少|多少钱|的|吗|呢|啊|吧|？|\?|，|,|、|里|中|内|请|帮我|价格|单价|报价|现在|当前|是/g, " ")
        .replace(/\s+/g, " ").trim();
      return {
        steps: [{ tool: "material.search", args: { query: q || m.slice(0, 30) }, activity: "正在检索询价与材料价格库" }],
      };
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

    // 甲供材核对/扣减：发包人供货表与清单主材计价勾稽；
    // 「扣减/清零/扣除/不要计价」是写路径（确认门），其余话术只核对
    if (/甲供|发包人供|发包人提供|业主供货|甲供材/.test(m)) {
      if (/扣减|清零|扣除|不计价|不要计价|去掉.*价|扣掉/.test(m))
        return {
          steps: [{ tool: "material.clearOwnerSuppliedPrice", args: {}, activity: "正在扣减甲供材重复计价" }],
        };
      return {
        steps: [{ tool: "material.checkOwnerSupplied", args: {}, activity: "正在核对甲供材与清单计价" }],
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

    // 主材暂估价设值：「电缆主材暂估价设为45元」「桥架主材价统一为32」——写 mainMaterialPrice 不动综合单价
    const mainPriceM = m.match(/(?:暂估价|主材价)/) && m.match(/(?:改为|调成|调整为|调到|调为|统一为|统一调成|统一改为|设为)\s*[¥￥]?\s*([\d,]+(?:\.\d+)?)/);
    if (mainPriceM) {
      const scope = m.match(/([一-龥A-Za-z]{2,12}?)(?:的)?(?:暂估价|主材价)/)?.[1]
        ?.replace(/^(把|将|对|请|所有|全部|整个|统一|清单项?|各项|项目)+/, "") ?? "";
      const v = Number(mainPriceM[1].replace(/,/g, ""));
      if (!Number.isFinite(v) || v < 0) return { steps: [], fallbackMessage: "主材暂估价必须是非负数值" };
      const compute = async (): Promise<PlanStep | null> => {
        const { listBoq } = await import("@boq/service");
        const { isPricableItem } = await import("@shared/types");
        const items = (await listBoq(ctx.projectId)).filter((i) => !i.isHeader && i.name.trim() && isPricableItem(i));
        const pool = scopeFilter(items, scope);
        if (!pool.length) return null;
        return {
          tool: "boq.update",
          args: { patches: pool.map((i) => ({ id: i.id, mainMaterialPrice: v.toFixed(2) })), reason: `主材暂估价设为 ${v.toFixed(2)}${scope ? `（范围：${scope}）` : ""}` },
          activity: "正在写回主材暂估价",
        };
      };
      return { steps: [compute], fallbackMessage: scope ? `没有匹配「${scope}」的可计价清单项` : "没有可写主材价的清单项" };
    }

    // 工程量修改：「管道工程量改为100」「电缆数量改为 3×12+5」——
    // 纯数字直写 quantity；计算式走求值并把原文写进 quantityExpr 留痕（量×价重算合价）
    const qtySetM = m.match(/([一-龥A-Za-z0-9]{1,20}?)(?:的)?(?:工程量|数量)(?:改|设|调)(?:为|成|到|整为|整成)?\s*[：:]?\s*(.+?)\s*$/);
    if (qtySetM && !/单价|价格|合价|总价|费率|税率/.test(m)) {
      const scope = qtySetM[1].replace(/^(把|将|对|请|所有|全部|整个|清单项?|各项|项目)+/, "");
      const rawVal = qtySetM[2].replace(/[""'"'「『」』]/g, "").replace(/\s*(米|㎡|m|个|台|套|项|根|盏|座|樘)\s*$/, "").trim();
      const numVal = Number(rawVal.replace(/,/g, ""));
      let qtyVal = "";
      let exprVal: string | undefined;
      if (Number.isFinite(numVal)) {
        if (numVal < 0) return { steps: [], fallbackMessage: "工程量必须是非负数值" };
        qtyVal = String(numVal);
      } else {
        const { evalExpr } = await import("@cost-engine/calcExpr");
        try { qtyVal = String(evalExpr(rawVal)); exprVal = rawVal; }
        catch { return { steps: [], fallbackMessage: `工程量计算式无效：${rawVal}` }; }
      }
      const compute = async (): Promise<PlanStep | null> => {
        const { listBoq } = await import("@boq/service");
        const { isPricableItem } = await import("@shared/types");
        const items = (await listBoq(ctx.projectId)).filter((i) => !i.isHeader && i.name.trim() && isPricableItem(i));
        const pool = scopeFilter(items, scope);
        if (!pool.length) return null;
        return {
          tool: "boq.update",
          args: { patches: pool.map((i) => ({ id: i.id, quantity: qtyVal, ...(exprVal ? { quantityExpr: exprVal } : {}) })), reason: `工程量设为 ${rawVal}${scope ? `（范围：${scope}）` : ""}` },
          activity: "正在更新工程量",
        };
      };
      return { steps: [compute], fallbackMessage: scope ? `没有匹配「${scope}」的可计价清单项` : "没有可修改的清单项" };
    }

    // 名称/项目特征修正：「把X的名称改为Y」「给X的特征补上沟槽连接」——特征不符检查的处置通道。
    // 须在改价路由之前：特征文本可能含「单价/价格」字样，先到先判
    const nameFeatM = m.match(/([一-龥A-Za-z0-9]{1,20}?)(?:的)?(项目特征|特征|名称)(?:改|设|补|填写)(?:为|成|上|到|充)\s*[：:=""]?(.+?)\s*[""」』]?$/);
    if (nameFeatM) {
      const scope = nameFeatM[1].replace(/^(把|将|对|请|所有|全部|整个|清单项?|各项|项目)+/, "");
      const field = nameFeatM[2] === "名称" ? "name" : "rawFeature";
      const val = nameFeatM[3].replace(/[""'"'「『」』]+/g, "").trim();
      if (val) {
        const compute = async (): Promise<PlanStep | null> => {
          const { listBoq } = await import("@boq/service");
          const items = (await listBoq(ctx.projectId)).filter((i) => !i.isHeader && i.name.trim());
          const pool = scopeFilter(items, scope);
          if (!pool.length) return null;
          return {
            tool: "boq.update",
            args: { patches: pool.map((i) => ({ id: i.id, [field]: val })), reason: `${nameFeatM[2]}设为「${val}」${scope ? `（范围：${scope}）` : ""}` },
            activity: `正在更新${nameFeatM[2]}`,
          };
        };
        return { steps: [compute], fallbackMessage: scope ? `没有匹配「${scope}」的清单项` : "没有可修改的清单项" };
      }
    }

    // 改价/统一单价: 「电缆单价改为5元」（范围+指定值）、「相同项统一为最低价/均价」
    if (/统一|改为|调成|调整为|调到|调为|设为/.test(m) && /单价|价格|综合单价/.test(m)) {
      const setM = m.match(/(?:改为|调成|调整为|调到|调为|统一为|统一调成|统一改为|设为)\s*[¥￥]?\s*([\d,]+(?:\.\d+)?)/);
      const mode = /最低|最小/.test(m) ? "min" : /平均|均值/.test(m) ? "mean" : "min";
      const scope = scopeWordOf(m);
      const computePatches = async (): Promise<PlanStep | null> => {
        const { listBoq } = await import("@boq/service");
        const { isPricableItem } = await import("@shared/types");
        const items = (await listBoq(ctx.projectId)).filter(
          (i) => !i.isHeader && i.name.trim() && isPricableItem(i)
        );
        const pool = scopeFilter(items, scope);
        if (!pool.length) return null;
        const patches: { id: string; unitPrice: string }[] = [];
        if (setM) {
          // 指定值口径：范围内所有可计价项直接设价（不要求先在差异组里）
          const v = Number(setM[1].replace(/,/g, ""));
          if (!Number.isFinite(v)) return null;
          for (const it of pool) patches.push({ id: it.id, unitPrice: v.toFixed(2) });
        } else {
          const { findSameItemDifferentPrice } = await import("@cost-engine/compare");
          const inPool = new Set(pool.map((i) => i.id));
          for (const r of findSameItemDifferentPrice(items)) {
            const targetItems = scope ? r.items.filter((i) => inPool.has(i.id)) : r.items;
            if (!targetItems.length) continue;
            const prices = r.items.map((i) => Number(i.unitPrice));
            const target =
              mode === "min" ? Math.min(...prices) : prices.reduce((a, b) => a + b, 0) / prices.length;
            for (const it of targetItems) patches.push({ id: it.id, unitPrice: target.toFixed(2) });
          }
        }
        if (!patches.length) return null;
        return {
          tool: "boq.update",
          args: {
            patches,
            reason: setM
              ? `${scope || "全部"}单价设为 ${setM[1]}`
              : `相同项统一为${mode === "min" ? "最低价" : "平均价"}${scope ? `（范围：${scope}）` : ""}`,
          },
          activity: "正在更新单价并生成 Diff",
        };
      };
      return {
        steps: setM
          ? [computePatches]
          : [
              { tool: "boq.findSameItemDifferentPrice", args: {}, activity: "正在分组比较" },
              computePatches,
            ],
        fallbackMessage: scope ? `没有可更新的「${scope}」清单项` : undefined,
      };
    }

    // 费用符合性检查（不可竞争费漏计/税率口径/暂列金额/限价超限）
    if (/符合性|不可竞争费|最高限价|招标控制价|限价|规费.{0,4}(漏|缺|没|未)|税金.{0,4}(漏|缺|没|未)|安全文明/.test(m))
      return {
        steps: [{ tool: "cost.feeSummary", args: {}, activity: "正在做费用符合性检查" }],
      };

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
    if (/单位.{0,4}(不一致|不符|不统一|不同|错)|量纲/.test(m))
      return {
        steps: [{ tool: "boq.findUnitInconsistencies", args: {}, activity: "正在查单位不一致" }],
      };
    // 编码修正：「把配电箱的编码改为 031001006001」「给X补编码 Y」——缺/错编码检查的处置通道
    const codeSetM =
      m.match(/([一-龥A-Za-z]{1,20}?)(?:的)?(?:项目)?编码.{0,3}(?:改|设|补)(?:为|成|上|到)?\s*([A-Za-z0-9]{4,24})/) ??
      // 「给电缆补编码031…」「把X改编码为Y」——动词在编码前
      m.match(/([一-龥A-Za-z]{1,20}?)(?:的)?(?:项目)?(?:补|改|设)(?:上|为|成|到)?编码\s*([A-Za-z0-9]{4,24})/);
    if (codeSetM) {
      const scope = codeSetM[1].replace(/^(把|将|对|请|所有|全部|整个|清单项?|各项|项目)+/, "");
      const codeVal = codeSetM[2];
      const compute = async (): Promise<PlanStep | null> => {
        const { listBoq } = await import("@boq/service");
        const items = (await listBoq(ctx.projectId)).filter((i) => !i.isHeader && i.name.trim());
        const pool = scopeFilter(items, scope);
        if (!pool.length) return null;
        return {
          tool: "boq.update",
          args: { patches: pool.map((i) => ({ id: i.id, code: codeVal })), reason: `编码修正为 ${codeVal}${scope ? `（范围：${scope}）` : ""}` },
          activity: "正在写回编码",
        };
      };
      return { steps: [compute], fallbackMessage: scope ? `没有匹配「${scope}」的清单项` : "没有可修正编码的清单项" };
    }
    if (/编码.{0,4}(格式|规范|非[标国]|缺位|位数)|非标编码|自编(码|编码)|编码.{0,8}\d+位|编码.{0,4}(是|有)(几|多少)位/.test(m))
      return {
        steps: [{ tool: "boq.findInvalidCodes", args: {}, activity: "正在查非标编码" }],
      };
    if (/(缺|没|未|无).{0,3}编码|编码.{0,3}(缺|空|漏)/.test(m))
      return {
        steps: [{ tool: "boq.findMissingCodes", args: {}, activity: "正在查缺编码项" }],
      };
    if (/(负|负数).{0,4}(单价|价|工程量|量)|缺.{0,3}单位|单位.{0,3}(缺|空|漏)|数据质量|脏数据/.test(m))
      return {
        steps: [{ tool: "boq.findDataIssues", args: {}, activity: "正在查数据质量问题" }],
      };
    if (/编码.{0,4}(重复|错用|不一致|不同|错|唯一)|一码多/.test(m))
      return {
        steps: [{ tool: "boq.findCodeNameMismatch", args: {}, activity: "正在查一码多名" }],
      };
    if (/算术|验算|合价.{0,4}(不符|不[等一]致|错|校验|验算)|量.{0,2}价.{0,4}(不符|错|校验|合价)|算错|计算错误|清标/.test(m))
      return {
        steps: [{ tool: "boq.findArithmeticMismatches", args: {}, activity: "正在做合价算术校验" }],
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

    // 单位工程费用汇总（须在占比/总价通配之前拦截「各单位工程…占比/汇总」）
    if (/单位工程|单项工程/.test(m) && /汇总|合计|多少|占比|费用|造价|金额/.test(m))
      return {
        steps: [{ tool: "cost.unitSummary", args: {}, activity: "正在按单位工程汇总金额" }],
      };

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

    // 文件列表：「有哪些文件/上传了什么/文件里有什么」→ file.read 出 fileList 视图
    if (/文件/.test(m) && /哪些|什么|列表|所有|全部|看看|几个|多少/.test(m))
      return { steps: [{ tool: "file.read", args: {}, activity: "正在列出项目文件" }] };

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
