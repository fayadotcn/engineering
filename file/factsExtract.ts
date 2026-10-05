import type { ParsedSheet } from "./excel";
import { D } from "@cost-engine/money";

/**
 * FACTS 表取数（表-03/04/13/扉页 → 台账事实，设计 docs/restructure-design.md §3.4）。
 * 纯函数：解析 ParsedSheet[]（整本工作簿一起给——表-03 的单位工程名单
 * 按顺序与表-04 配对），产出待写台账的事实行；写库在 ingest 侧做。
 */

export interface ExtractedFact {
  /** 台账 key，如 税率 / 文件汇总:xxx.xls / 招标人 */
  key: string;
  /** 台账 value；金额/费率统一为数字字符串，多行汇总用 JSON */
  value: string;
  factType: string;
  /** 证据文字，给行内 note/复核用 */
  note?: string;
}

const num = (s: string | undefined): number | null => {
  if (!s) return null;
  const v = Number(String(s).replace(/[,，\s元]/g, ""));
  return Number.isFinite(v) ? v : null;
};

/** 行内标签单元格右侧的第一个数值（汇总表口径：标签 | … | 金额） */
const amountRightOf = (raw: string[], labelIdx: number): number | null => {
  for (let i = labelIdx + 1; i < raw.length; i++) {
    const v = num(raw[i]);
    if (v !== null) return v;
    if (raw[i] && raw[i].trim().length > 12) break; // 跨到下一个文本块就停，防串列
  }
  return null;
};

/** 表-04 行标签 → 归一化字段名（也服务通用键值汇总页兜底，别名覆盖「分部分项合价/含税工程造价」等写法） */
const TABLE04_LABELS: [RegExp, string][] = [
  [/分部分项工程费|分部分项及单价措施|分部分项合价|分部分项费(?!率)/, "分部分项工程费"],
  [/单价措施项目费/, "单价措施项目费"],
  [/总价措施项目费/, "总价措施项目费"],
  [/安全文明施工/, "安全文明施工费"],
  [/措施项目费/, "措施项目费"],
  [/暂列金额/, "暂列金额"],
  [/其他项目费/, "其他项目费"],
  [/附加税/, "附加税"],
  [/规费/, "规费"],
  [/税金|销项增值税|增值税|销项税额/, "税金"],
  [/人工费调整/, "人工费调整"],
  [/税前工程造价|税前造价|税前总价/, "税前造价"],
  [/合计|总计|投标报价|招标控制价|含税工程造价|含税总价|含税造价|工程造价/, "合计"],
];

interface UnitSummary {
  sheet: string;
  unitName: string;
  items: Record<string, number>;
}

/** 表-03/工程项目汇总：单位工程名单（有序，供与表-04配对）+ 各自合价 */
function unitListFromSummarySheet(sheet: ParsedSheet): { name: string; total: number }[] {
  const nameCol = sheet.columns.name ?? 1;
  const out: { name: string; total: number }[] = [];
  for (const r of sheet.rows) {
    const name = (r.raw[nameCol] ?? "").trim();
    if (!name || /合\s*计|总\s*计|序号|名称|汇总/.test(name)) continue;
    const total = amountRightOf(r.raw, nameCol);
    if (total === null) continue;
    out.push({ name, total });
  }
  return out;
}

/** 表-04：标签→金额抽取；单位工程名由表-03 序号序配给。
 *  kvMode=通用键值页模式：费率/系数标签不当金额行——否则「规费费率|18.75」会把费率
 *  当规费金额吸进对账；「税率」「人工费调整系数」同理。 */
function summaryFromTable04(sheet: ParsedSheet, kvMode = false): Record<string, number> {
  const items: Record<string, number> = {};
  for (const r of sheet.rows) {
    // 标签可能在任意前导单元格（序号列、名称列、整行合并）
    for (let i = 0; i < r.raw.length; i++) {
      const cell = (r.raw[i] ?? "").trim();
      if (!cell || cell.length > 60) continue;
      if (kvMode && /[%％率]|系数/.test(cell)) continue;
      const hit = TABLE04_LABELS.find(([re]) => re.test(cell));
      if (!hit) continue;
      const amt = amountRightOf(r.raw, i);
      if (amt === null) break;
      if (items[hit[1]] === undefined) items[hit[1]] = amt;
      break;
    }
  }
  return items;
}

const isTable03 = (n: string) => /表\s*[-—_]?\s*0?3(?!\d)|单项工程.{0,8}汇总|工程项目.{0,8}汇总/.test(n);
const isTable04 = (n: string) => /表\s*[-—_]?\s*0?4(?!\d)|单位工程.{0,8}汇总/.test(n);
const isTable13 = (n: string) => /表\s*[-—_]?\s*13(?!\d)|规费.{0,6}税金|税金.{0,6}规费/.test(n);

/** 表-13（规费、税金项目计价表）行标签分类 */
type FeeTaxKind = "规费" | "规费子项" | "税金" | "附加税";
const feeTaxKind = (cell: string): FeeTaxKind | null => {
  const t = cell.replace(/\s/g, "");
  if (/^附加税|城市维护|教育费附加|地方教育附加/.test(t)) return "附加税";
  if (/销项增值税|增值税|^税金/.test(t)) return "税金";
  if (/^规费$/.test(t)) return "规费";
  if (/社会保险|养老保险|失业保险|医疗保险|工伤保险|生育保险|住房公积金|工程排污|意外伤害|危险作业|大病/.test(t)) return "规费子项";
  return null;
};

interface FeeTaxSheet {
  sheet: string;
  /** 规费费率（%，子项行无总率时按子项费率求和） */
  regRate: number | null;
  /** 规费金额（元，用于推定额人工费基数） */
  regAmount: number | null;
  regBasis: string;
  taxRate: number | null;
  addonRate: number | null;
}

/**
 * 表-13 费率抽取：行「规费|计算基础|费率%|金额」→ regRate/regAmount/regBasis；
 * 规费父行费率空时向下求「社会保险费/住房公积金」等子项行之和。
 * 「销项增值税」→ taxRate（表-13 明示优于表-04 反推）；「附加税」→ addonRate。
 */
function ratesFromTable13(sheet: ParsedSheet): FeeTaxSheet {
  const rows: { kind: FeeTaxKind; rate: number | null; amount: number | null; basis: string }[] = [];
  for (const r of sheet.rows) {
    let kind: FeeTaxKind | null = null;
    let labelIdx = -1;
    for (let i = 0; i < r.raw.length; i++) {
      const cell = (r.raw[i] ?? "").trim();
      if (!cell || cell.length > 40) continue;
      kind = feeTaxKind(cell);
      if (kind) { labelIdx = i; break; }
    }
    if (!kind) continue;
    // 标签右侧：第一个文本块是计算基数；数值里 ≤100 的是费率，>100 的末位是金额
    let basis = "";
    let rate: number | null = null;
    let amount: number | null = null;
    for (let j = labelIdx + 1; j < r.raw.length; j++) {
      const cell = (r.raw[j] ?? "").trim();
      if (!cell) continue;
      const v = num(cell);
      if (v === null) { if (!basis) basis = cell.slice(0, 60); continue; }
      if (v > 0 && v <= 100 && rate === null) { rate = v; continue; }
      if (v > 100) amount = v; // 金额列取最大数值（费率不可能>100）
    }
    rows.push({ kind, rate, amount, basis });
  }

  const reg = rows.find((r) => r.kind === "规费");
  const subs = rows.filter((r) => r.kind === "规费子项");
  const tax = rows.find((r) => r.kind === "税金");
  const addon = rows.find((r) => r.kind === "附加税");
  const sumOr = (nums: (number | null)[]) => {
    const vals = nums.filter((n): n is number => n !== null);
    return vals.length ? vals.reduce((a, b) => a.add(b), D(0)).toNumber() : null;
  };
  return {
    sheet: sheet.sheetName,
    regRate: reg?.rate ?? sumOr(subs.map((s) => s.rate)),
    regAmount: reg?.amount ?? sumOr(subs.map((s) => s.amount)),
    regBasis: reg?.basis ?? subs.find((s) => s.basis)?.basis ?? "",
    taxRate: tax?.rate ?? null,
    addonRate: addon?.rate ?? null,
  };
}

const median = (nums: number[]): number | null => {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** 税率推导：税金 ÷（分部分项+措施+其他+规费）。取各表-04 的中位数，过滤离谱值 */
function deriveTaxRate(units: UnitSummary[]): number | null {
  const rates = units
    .map((u) => {
      const base =
        (u.items["分部分项工程费"] ?? 0) +
        (u.items["措施项目费"] ?? 0) +
        (u.items["其他项目费"] ?? 0) +
        (u.items["规费"] ?? 0);
      const tax = u.items["税金"];
      if (!base || tax === undefined) return null;
      const r = tax / base;
      // 增值税率合理域 3%~13%（安装工程一般 9%/13%）
      return r >= 0.025 && r <= 0.135 ? r : null;
    })
    .filter((r): r is number => r !== null)
    .sort((a, b) => a - b);
  return rates.length ? rates[Math.floor(rates.length / 2)] : null;
}

/** 扉页/表头类 sheet：标签:值 字段（工程名称/招标人/施工单位…） */
const HEADER_FIELD_RE = /^(工程名称|项目名称|招标人|投标人|建设单位|施工单位|造价咨询(?:单位|企业)?|法定代表人|编制人|审核人|编制时间|招标控制价|投标总价)\s*[:：]?\s*(.*)$/;

function headerFields(sheet: ParsedSheet): ExtractedFact[] {
  const out: ExtractedFact[] = [];
  for (const r of sheet.rows.slice(0, 30)) {
    for (let i = 0; i < r.raw.length; i++) {
      const m = (r.raw[i] ?? "").trim().match(HEADER_FIELD_RE);
      if (!m) continue;
      let value = m[2].trim();
      if (!value) {
        for (let j = i + 1; j < r.raw.length; j++) {
          if ((r.raw[j] ?? "").trim()) { value = r.raw[j].trim(); break; }
        }
      }
      value = value.replace(/【.*】/, "").trim();
      if (!value || value.length > 80) continue;
      const key = m[1] === "项目名称" ? "工程名称" : m[1];
      if (!out.some((f) => f.key === key))
        out.push({ key, value, factType: "FILE_EXTRACTED", note: sheet.sheetName });
    }
  }
  return out;
}

/** 计价口径散文行：「地区=马来西亚；税率6%；管理费率5%」这类 key=value / 连写口径。
 *  数值键允许「税率6%」无分隔写法；文本键（地区/品牌/期次）必须带分隔符，防误吸正文。
 *  值原样留痕——归一化在消费端（parseRateValue/parseCoefficientValue/parseAmountValue/
 *  normalizePeriod）与写库校验（validatePricingFact）完成。 */
const PROSE_NUM_RE =
  /(附加税率|规费费率|管理费率|措施费率|暂列金额率|利润率|人工费调整系数|建筑面积|檐口高度|操作物高度|暂列金额|(?<!材料|土地)增值税征收率|(?<!材料|土地)增值税率|(?<!增值税|营业税|消费税)征收率|(?<!增值|消费|营业|印花|关税|城建税|城建|建设|所得|房产)税率)\s*[=:：为]?\s*(-?[\d,]+(?:\.\d+)?\s*(?:%|％|倍|亿元|万元|亿|万|元|㎡|m2|平方米)?)/g;
const PROSE_TXT_RE =
  /(地区|品牌|价格期|价格日期)\s*[=:：]\s*([^\s，。；;、（）()]{1,30})/g;
// 别名归一：增值税率/征收率就是本域「税率」口径（一般计税销项税 / 简易计税征收率）。
// 「材料增值税率13%」（材料发票税率）与「土地增值税率」（土增税）不是工程税率——
// 靠 材料/土地 前缀挡掉，「销项增值税率」「本工程增值税率」照常入税率。
const PROSE_KEY_ALIAS: Record<string, string> = {
  增值税率: "税率", 增值税征收率: "税率", 征收率: "税率",
};

/** 散文式口径行取数：扫描 FACTS 表全部单元格的 key=value 写法。have=已抽到的键（结构化取数优先）。 */
function proseFacts(sheet: ParsedSheet, have: Set<string>): ExtractedFact[] {
  const out: ExtractedFact[] = [];
  const seen = new Set<string>();
  const push = (key: string, value: string) => {
    const v = value.trim();
    if (!v || seen.has(key) || have.has(key)) return;
    seen.add(key);
    out.push({ key, value: v, factType: "FILE_EXTRACTED", note: `${sheet.sheetName} 口径文字` });
  };
  for (const r of sheet.rows) {
    for (const cell of r.raw ?? []) {
      const text = (cell ?? "").trim();
      if (!text) continue;
      for (const m of text.matchAll(PROSE_NUM_RE)) push(PROSE_KEY_ALIAS[m[1]] ?? m[1], m[2]);
      for (const m of text.matchAll(PROSE_TXT_RE)) push(m[1], m[2]);
    }
  }
  return out;
}

/**
 * 整本工作簿 → 台账事实行。
 * 产出：表-04 派生「税率」（可直消费 loadFeeParams）；
 * 「文件汇总:{filename}」JSON（各单位工程分部分项/措施/其他/规费/税金/合计真值，
 * 供 feeSummary 校验与「本期 vs 上期」对审）；扉页标签字段。
 */
export function extractFileFacts(sheets: ParsedSheet[], filename: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const factsSheets = sheets.filter((s) => s.type === "FACTS");
  if (!factsSheets.length) return facts;

  // 单位工程名单（表-03 顺序即表-04 顺序：软件按单位工程顺序导出 1 组 3 表）
  const units: { name: string; total: number }[] = [];
  for (const s of factsSheets) if (isTable03(s.sheetName)) units.push(...unitListFromSummarySheet(s));

  const summaries: UnitSummary[] = [];
  let table04Idx = 0;
  for (const s of factsSheets) {
    if (isTable04(s.sheetName)) {
      const items = summaryFromTable04(s);
      if (Object.keys(items).length) {
        summaries.push({
          sheet: s.sheetName,
          unitName: units[table04Idx]?.name ?? s.unitProject ?? "",
          items,
        });
        table04Idx++;
      }
    }
  }

  // 通用键值汇总页兜底：非表-04/13 的 FACTS 表（「口径与汇总」「编制说明」「费用汇总」）
  // 里「标签|金额」键值行按同一张标签表归一。只在表-04 无产出时合成——结构表存在时
  // 再叠加会让 compareDeclared 的跨单位工程求和重复计数。
  if (!summaries.length) {
    const seenSig = new Set<string>();
    for (const s of factsSheets) {
      if (isTable04(s.sheetName) || isTable13(s.sheetName)) continue;
      const items = summaryFromTable04(s, true);
      const keys = Object.keys(items);
      // 至少一个合计类键 + 一个分量键才算汇总页——孤行「税金|3000」不合成
      const hasTotal = keys.some((k) => k === "合计" || k === "税前造价");
      const hasPart = keys.some((k) => k !== "合计" && k !== "税前造价");
      if (!hasTotal || !hasPart) continue;
      const sig = keys.sort().map((k) => `${k}=${items[k]}`).join("|");
      if (seenSig.has(sig)) continue; // 多页重复同口径汇总 → 去重防对账翻倍
      seenSig.add(sig);
      summaries.push({ sheet: s.sheetName, unitName: s.unitProject ?? s.sheetName, items });
    }
  }

  // 表-13 规费税金计价表：费率明示优先于表-04 反推；基数文字进 note
  const t13 = factsSheets.filter((s) => isTable13(s.sheetName)).map(ratesFromTable13);
  const explicitTax = median(t13.map((t) => t.taxRate).filter((v): v is number => v !== null));
  // 表-13 费率列是百分数（9 即 9%），deriveTaxRate 返回小数——统一到小数口径
  const taxRate = explicitTax !== null ? explicitTax / 100 : deriveTaxRate(summaries);
  if (taxRate !== null)
    facts.push({
      key: "税率",
      value: (Math.round(taxRate * 10000) / 100).toFixed(2),
      factType: "RATE",
      note: explicitTax !== null
        ? `表-13「${t13.find((t) => t.taxRate !== null)?.sheet}」销项增值税费率`
        : `由 ${summaries.length} 张单位工程汇总表「税金÷税前造价」推得`,
    });

  const regRate = median(t13.map((t) => t.regRate).filter((v): v is number => v !== null));
  const regBasis = t13.find((t) => t.regBasis)?.regBasis ?? "";
  if (regRate !== null)
    facts.push({
      key: "规费费率",
      value: regRate.toFixed(2),
      factType: "RATE",
      note: `表-13 规费费率${regBasis ? `（计算基数：${regBasis}）` : ""}`,
    });
  // 定额人工费 = 规费金额 ÷ 规费费率——规费的真实基数，feeSummary 用它计费
  const laborBase = median(
    t13
      .filter((t) => t.regAmount !== null && t.regRate !== null && t.regRate > 0)
      .map((t) => D(t.regAmount!).div(D(t.regRate!).div(100)).toNumber())
  );
  if (laborBase !== null)
    facts.push({
      key: "定额人工费",
      value: laborBase.toFixed(2),
      factType: "FILE_EXTRACTED",
      note: `表-13 规费金额÷费率反推（基数：${regBasis || "定额人工费"}）`,
    });
  const addonRate = median(t13.map((t) => t.addonRate).filter((v): v is number => v !== null));
  if (addonRate !== null)
    facts.push({
      key: "附加税率",
      value: addonRate.toFixed(2),
      factType: "RATE",
      note: "表-13 附加税费率",
    });

  if (summaries.length)
    facts.push({
      key: `文件汇总:${filename}`,
      value: JSON.stringify(
        summaries.map((u) => ({ sheet: u.sheet, unit: u.unitName, ...u.items }))
      ),
      factType: "FILE_EXTRACTED",
      note: `${summaries.length} 张汇总表真值（分部分项/措施/规费/税金/合计），供取费校验与对审`,
    });

  for (const s of factsSheets) facts.push(...headerFields(s));

  // 散文式口径行（「税率6%；管理费率5%」）——编制说明/口径页的费率、
  // 系数、地区事实从这里进台账；结构化取数已产出的键不再重复写
  const have = new Set(facts.map((f) => f.key));
  for (const s of factsSheets) {
    const fs = proseFacts(s, have);
    for (const f of fs) have.add(f.key);
    facts.push(...fs);
  }

  return facts;
}
