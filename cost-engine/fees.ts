import Decimal from "decimal.js";
import { D, round2, sum } from "./money";
import type { BoqItemDTO } from "@shared/types";

// 费用汇总（取费）：分部分项 → 措施 → 其他项目 → 规费 → 税前 → 税金 → 含税造价。
// 纯函数、确定性。
// 专业口径：
//  - 分部分项/措施/其他项目按清单费用口径分层；导入了措施表/其他项目表就用真值，
//    没导入才用费率估算并注明。
//  - 规费基数是「定额人工费」（四川安装口径），不是分部分项费——
//    定额测算后台账里有 定额人工费 时才用真基数，否则退回简化口径并显著标注。
//  - 费率全部来自项目事实台账，未设置的计 0 并在行内注明，绝不静默套默认值。

export interface FeeParams {
  /** 措施项目费率（基数：分部分项工程费），如 0.03 */
  measureRate: Decimal;
  /** 规费费率（基数：定额人工费），如 0.28 */
  regulationRate: Decimal;
  /** 暂列金额率（基数：分部分项工程费），如 0.05 */
  provisionalRate: Decimal;
  /** 暂列金额固定值（>0 时优先于暂列金额率） */
  provisionalAmount: Decimal;
  /** 增值税率；未确认税率时为 0，汇总明确提示 */
  taxRate: Decimal;
  /** 附加税率（城建+教育附加等，基数：增值税额）；未设置计 0，不产生行 */
  addonRate: Decimal;
  /** 定额人工费合计（定额测算写入台账）；null = 未测算，规费退回简化口径 */
  laborBase: Decimal | null;
  /** 官方系数措施费合计（cost.measureFees 计取写入台账）：脚手架/超高/高层增加费等 */
  coeffMeasureFee: Decimal;
  /** 各费率是否来自台账（false=未设置，行内注明） */
  set: { measure: boolean; regulation: boolean; provisional: boolean; tax: boolean };
}

export interface FeeRow {
  seq: string;
  name: string;
  /** 计算基础/表达式描述 */
  basis: string;
  /** 费率显示文本，无费率行为 null */
  rate: string | null;
  amount: string;
  /** 层级：section(一/二/三) | subtotal(小计) | total(总计) | leaf */
  level: "leaf" | "subtotal" | "total";
  note?: string;
}

export interface FeeSummary {
  rows: FeeRow[];
  /** 含税工程造价（大写行金额） */
  grandTotal: string;
  /** 税前造价 */
  preTax: string;
  unpricedCount: number;
}

const pct = (rate: Decimal): string => `${rate.mul(100).toDecimalPlaces(2).toString()}%`;

export function feeSummary(items: BoqItemDTO[], params: FeeParams): FeeSummary {
  const leaf = items.filter((i) => !i.isHeader && i.name.trim());
  const byType = (t: string) => leaf.filter((i) => (i.feeType ?? "分部分项") === t);
  const priced = byType("分部分项").concat(byType("单价措施"));
  const unpricedCount = priced.filter((i) => D(i.unitPrice).isZero()).length;

  // 含税价清单（源表「含税单价」列）：单价已含增值税，不进税前基数、不再叠税。
  // 它们的合价在税金之后直接并入含税造价，行内注明口径。
  const taxableParts = byType("分部分项").filter((i) => !i.taxIncluded);
  const taxInclParts = byType("分部分项").filter((i) => i.taxIncluded);
  const taxInclTotal = sum(taxInclParts.map((i) => i.totalPrice));
  const boqTotal = sum(taxableParts.map((i) => i.totalPrice));
  const measureItems = byType("单价措施").concat(byType("总价措施"));
  const otherItems = byType("其他项目");
  const importedMeasure = sum(measureItems.map((i) => i.totalPrice));
  const importedOther = sum(otherItems.map((i) => i.totalPrice));

  // 措施费构成：导入的措施清单真值 + 官方系数计取（脚手架/超高/高层，cost.measureFees 写台账）；
  // 两者皆无才退费率估算并注明
  const coeffFee = params.coeffMeasureFee;
  const hasMeasure = measureItems.length > 0 || coeffFee.gt(0);
  const hasOther = otherItems.length > 0;
  const measure = round2(hasMeasure
    ? importedMeasure.plus(coeffFee)
    : boqTotal.mul(params.measureRate));
  // 其他项目费：导入了其他项目表用真值；否则暂列金额估算
  const other = round2(hasOther
    ? importedOther
    : params.provisionalAmount.gt(0)
      ? params.provisionalAmount
      : boqTotal.mul(params.provisionalRate));
  // 规费：定额人工费为真实基数（测算后可用）；否则退回简化口径并标注
  const laborBase = params.laborBase;
  const regulation = round2(laborBase !== null && laborBase.gt(0)
    ? laborBase.mul(params.regulationRate)
    : boqTotal.mul(params.regulationRate));
  const preTax = boqTotal.plus(measure).plus(other).plus(regulation);
  const tax = round2(preTax.mul(params.taxRate));
  // 附加税（城建税+教育费附加+地方教育附加）：基数是增值税额，表-13 明示费率时计取
  const addon = round2(tax.mul(params.addonRate));
  const grandTotal = preTax.plus(tax).plus(addon).plus(taxInclTotal);

  const unset = (flag: boolean, hint: string) => (flag ? undefined : `未设置，按 0 计（可用「${hint}」写入台账）`);
  const rows: FeeRow[] = [
    {
      seq: "一", name: "分部分项工程费", basis: `Σ 分部分项合价（${byType("分部分项").length} 项）`,
      rate: null, amount: boqTotal.toFixed(2), level: "leaf",
      note: [
        unpricedCount ? `含 ${unpricedCount} 项未定价` : "",
        taxInclParts.length ? `另 ${taxInclParts.length} 项含税单价（合价 ${taxInclTotal.toFixed(2)} 元）不计入税前基数，见下方含税价清单行` : "",
      ].filter(Boolean).join("；") || undefined,
    },
    {
      seq: "二", name: "措施项目费",
      basis: [
        measureItems.length ? `Σ 措施清单合价（${measureItems.length} 项）` : "",
        coeffFee.gt(0) ? `系数措施费 ${coeffFee.toFixed(2)}（脚手架/超高/高层等，川标费率）` : "",
      ].filter(Boolean).join(" + ") || "分部分项工程费 × 费率（估算）",
      rate: hasMeasure ? null : pct(params.measureRate),
      amount: measure.toFixed(2), level: "leaf",
      note: hasMeasure
        ? [
            measureItems.length ? "按导入的措施项目清单计价表" : "",
            coeffFee.gt(0) ? "含「措施费计取」结果" : "",
          ].filter(Boolean).join("；") || undefined
        : unset(params.set.measure, "措施费率设为x% 或先做「措施费计取」") ?? "费率估算口径",
    },
    {
      seq: "三", name: "其他项目费",
      basis: hasOther
        ? `Σ 其他项目清单合价（${otherItems.length} 项）`
        : params.provisionalAmount.gt(0) ? "暂列金额（固定值）" : "分部分项工程费 × 暂列金额率（估算）",
      rate: hasOther ? null : params.provisionalAmount.gt(0) ? null : pct(params.provisionalRate),
      amount: other.toFixed(2), level: "leaf",
      note: hasOther
        ? "按导入的其他项目清单计价表（暂列金额/暂估价/计日工/总承包服务费）"
        : unset(params.set.provisional, "暂列金额率设为x% 或 暂列金额设为x元"),
    },
    {
      seq: "四", name: "规费",
      basis: laborBase !== null && laborBase.gt(0)
        ? `定额人工费 ${laborBase.toFixed(2)} × 费率`
        : "分部分项工程费 × 费率（简化基数）",
      rate: pct(params.regulationRate), amount: regulation.toFixed(2), level: "leaf",
      note: laborBase !== null && laborBase.gt(0)
        ? "基数为定额测算汇总的定额人工费（四川安装口径）"
        : params.set.regulation
          ? "简化口径：以分部分项费为基数；运行「定额测算」后自动改用定额人工费"
          : unset(false, "规费费率设为x%"),
    },
    {
      seq: "五", name: "税前工程造价", basis: "一 + 二 + 三 + 四",
      rate: null, amount: preTax.toFixed(2), level: "subtotal",
    },
    {
      seq: "六", name: "增值税", basis: "税前工程造价 × 税率",
      rate: pct(params.taxRate), amount: tax.toFixed(2), level: "leaf",
      note: params.set.tax ? undefined : "税率未确认，暂按 0 计；请在计价设置中填写适用税率",
    },
    ...(params.addonRate.gt(0) && addon.gt(0)
      ? [{
          seq: "六·附", name: "附加税", basis: "增值税 × 附加税率",
          rate: pct(params.addonRate), amount: addon.toFixed(2), level: "leaf" as const,
          note: "城建税/教育费附加/地方教育附加（表-13 口径）",
        }]
      : []),
    ...(taxInclParts.length
      ? [{
          seq: "六·补", name: "含税价清单（单价已含税，不重复计税）",
          basis: `Σ 含税价清单合价（${taxInclParts.length} 项）`,
          rate: null, amount: taxInclTotal.toFixed(2), level: "leaf" as const,
          note: "源表单价为含税价，税金已在单价内",
        }]
      : []),
    {
      seq: "七", name: "含税工程造价", basis: taxInclParts.length ? "五 + 六 + 含税价清单" : addon.gt(0) ? "五 + 六 + 附加税" : "五 + 六",
      rate: null, amount: grandTotal.toFixed(2), level: "total",
    },
  ];
  return { rows, grandTotal: grandTotal.toFixed(2), preTax: preTax.toFixed(2), unpricedCount };
}

/** 费用符合性检查的一条问题（不可竞争费漏计、税率口径、暂列金额一致性、限价超限）。 */
export interface ComplianceIssue {
  level: "error" | "warn";
  label: string;
  detail: string;
}

/**
 * 费用符合性检查（清标「不可竞争费无缺漏项」+ 限价口径）：
 *  - 增值税率未计取 / 非建筑业常规口径（一般计税 9%、简易计税 3%）
 *  - 规费未计取（不可竞争费）
 *  - 总价措施表缺安全文明施工费（不可竞争费）
 *  - 措施费整体缺位（无措施清单、无系数计取、无费率）
 *  - 台账暂列金额与其他项目表暂列金额行不一致
 *  - 含税造价超过最高投标限价/招标控制价
 *  - 清单存在未定价项（总价不完整）
 */
export function feeCompliance(
  items: BoqItemDTO[],
  params: FeeParams,
  opts: { ceiling?: Decimal | null; summary?: FeeSummary } = {}
): ComplianceIssue[] {
  const s = opts.summary ?? feeSummary(items, params);
  const leaf = items.filter((i) => !i.isHeader && i.name.trim());
  const byType = (t: string) => leaf.filter((i) => (i.feeType ?? "分部分项") === t);
  const taxableParts = byType("分部分项").filter((i) => !i.taxIncluded);
  const boqTotal = sum(taxableParts.map((i) => i.totalPrice));
  const issues: ComplianceIssue[] = [];
  const push = (level: "error" | "warn", label: string, detail: string) =>
    issues.push({ level, label, detail });
  if (!boqTotal.gt(0)) return issues;

  const taxRate = params.taxRate;
  if (taxRate.isZero())
    push("warn", "增值税未计取", "税率未设置按 0 计——税金是不可竞争费，缺项会导致含税造价偏低");
  else if (!taxRate.eq(0.09) && !taxRate.eq(0.03))
    push("warn", "税率口径异常", `当前税率 ${pct(taxRate)}，非常规建筑业口径（一般计税 9%、简易计税 3%），请确认计税方式`);

  if (params.regulationRate.isZero())
    push("warn", "规费未计取", "规费费率未设置按 0 计——规费是不可竞争费，缺项会被评标扣分或结算核减");

  const lumpMeasures = byType("总价措施");
  if (lumpMeasures.length) {
    const hasSafety = lumpMeasures.some((i) => /安全文明|文明施工|环境保护|临时设施/.test(i.name));
    if (!hasSafety)
      push("warn", "安全文明施工费缺项", `总价措施表 ${lumpMeasures.length} 项中未见安全文明施工费类行——不可竞争费缺漏`);
  } else if (params.measureRate.isZero() && params.coeffMeasureFee.lte(0)) {
    push("warn", "措施费未计取", "既无措施项目清单，也未设置措施费率/系数计取——措施费整体缺位");
  }

  const provisional = params.provisionalAmount;
  const otherItems = byType("其他项目");
  if (provisional.gt(0)) {
    const provRow = otherItems.find((i) => /暂列金额|暂列金/.test(i.name));
    if (!provRow)
      push("warn", "暂列金额未入表", `台账暂列金额 ${provisional.toFixed(2)} 元，但其他项目表无暂列金额行——以台账值计入，请核对招标给定值`);
    else {
      const diff = D(provRow.totalPrice).minus(provisional);
      if (diff.abs().gt(Decimal.max(1, provisional.mul(0.001))))
        push("warn", "暂列金额不一致", `其他项目表暂列金额 ${D(provRow.totalPrice).toFixed(2)} 元 ≠ 台账给定值 ${provisional.toFixed(2)} 元（差 ${diff.toFixed(2)} 元）——暂列金额应按招标文件给定值填报`);
    }
  }

  const ceiling = opts.ceiling ?? null;
  if (ceiling !== null && ceiling.gt(0)) {
    const diff = D(s.grandTotal).minus(ceiling);
    if (diff.gt(0))
      push("error", "超过最高投标限价", `含税造价 ${s.grandTotal} 元 超最高限价 ${ceiling.toFixed(2)} 元（超 ${diff.toFixed(2)} 元）——按招标文件可能被否决投标`);
  }

  if (s.unpricedCount > 0)
    push("warn", "清单未定价", `${s.unpricedCount} 项分部分项/单价措施未报价，总价不完整`);
  return issues;
}

/** 申报核对行：源表（表-04 汇总）申报值与本次计算的差异 */
export interface DeclaredCheck {
  label: string;
  declared: number;
  computed: number;
  diff: number;
  pct: number;
  /** 差异含未计取分量（费率未设置）时的说明 */
  note?: string;
}

/**
 * 表-04 汇总真值 vs 本次取费结果。
 * units 是台账「文件汇总:*」事实的 JSON 数组（每单位工程一行，
 * 字段：分部分项工程费/措施项目费/其他项目费/规费/税金/合计）。
 * 比对在「分部分项+措施」合并层与规费/税金/合计层做——
 * 表-08 合并表的 feeType 归属与表-04 不一定同口径，总价核对是造价师的对账层。
 * 只产出 declared>0 的行（源表没有的口径不判差）。
 */
export function compareDeclared(
  rows: FeeRow[],
  units: Record<string, unknown>[]
): DeclaredCheck[] {
  const sum = (k: string) =>
    units.reduce((a, u) => a + (typeof u[k] === "number" ? (u[k] as number) : 0), 0);
  const bySeq = new Map(rows.map((x) => [x.seq, Number(x.amount)]));
  const rowBySeq = new Map(rows.map((x) => [x.seq, x]));
  // 费率未设置的行无法重算——申报 vs 0 不是口径差异，是配置缺口；跳过该行
  // 并在税金/合计上注明差异含未计取分量
  const uncomputable = (seqs: string[]) =>
    seqs.some((s) => /未设置|未确认/.test(rowBySeq.get(s)?.note ?? ""));
  const hasAddonRow = rowBySeq.has("六·附");
  const pairs: { label: string; declared: number; computed: number; skip?: boolean; note?: string }[] = [
    {
      label: "分部分项+措施项目费",
      declared: sum("分部分项工程费") + sum("措施项目费"),
      computed: (bySeq.get("一") ?? 0) + (bySeq.get("二") ?? 0),
    },
    {
      label: "规费", declared: sum("规费"), computed: bySeq.get("四") ?? 0,
      skip: uncomputable(["四"]),
    },
    // 表-04 的「税金」口径含附加税（部分文件另列附加税行）；计算侧 六=增值税、六·附=附加税。
    // 附加税率未设置时不产出六·附行——该分量无法计算，从申报侧剔除同口径比较
    {
      label: "税金",
      declared: sum("税金") + (hasAddonRow ? sum("附加税") : 0),
      computed: (bySeq.get("六") ?? 0) + (bySeq.get("六·附") ?? 0),
      skip: uncomputable(["六"]),
      note: uncomputable(["四"]) ? "基数不含规费（规费费率未设置），差异含该部分" : undefined,
    },
    {
      label: "合计", declared: sum("合计"), computed: bySeq.get("七") ?? 0,
      note: uncomputable(["四", "六"]) ? "差异含未计取的规费/税金（费率未设置）" : undefined,
    },
  ];
  return pairs
    .filter((p) => p.declared > 0 && !p.skip)
    .map((p) => {
      const diff = p.computed - p.declared;
      return {
        label: p.label, declared: p.declared, computed: p.computed,
        diff, pct: diff / p.declared,
        ...(p.note ? { note: p.note } : {}),
      };
    });
}
