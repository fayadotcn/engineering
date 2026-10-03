import type { FileKind } from "@shared/types";
import type { ParsedSheet } from "./excel";

// File kind classification: content signals beat filename signals.

const FILENAME_RULES: [RegExp, FileKind][] = [
  [/询价|报价|询回|价格表/, "MATERIAL_QUOTATION"],
  [/甲供|甲供材/, "OWNER_SUPPLIED"],
  [/结算/, "BOQ_SETTLEMENT"],
  [/中标|投标/, "BOQ_WINNING"],
  [/招标|清单|财评|送审/, "BOQ_TENDER"],
  [/合同/, "CONTRACT"],
  [/变更/, "CHANGE"],
  [/签证/, "VISA"],
  [/图|图纸|drawing/i, "DRAWING"],
];

/**
 * 文件阶段/期次推断（文件名）：招标→投标→清标→进度→变更→报审→结算→财评
 * 对应真实造价流转顺序；period 是 YYYY-MM（进度申报/结算期），
 * 「本期 vs 上期」对审靠它对齐。推断不出留空。
 */
export function inferFileStage(filename: string): { stage: string; period: string } {
  const pm = filename.match(/(20\d{2})\s*[年\-/.]\s*(\d{1,2})\s*月?/);
  const period = pm ? `${pm[1]}-${pm[2].padStart(2, "0")}` : "";
  const stage =
    /结算|决算/.test(filename) ? "结算"
    : /进度|产值|计量|支付证书|期中|申报/.test(filename) ? "进度"
    : /变更|签证|洽商/.test(filename) ? "变更"
    : /财评|财政评审|评审/.test(filename) ? "财评"
    : /清标|对审|对比分析/.test(filename) ? "清标"
    : /报审|送审|报验/.test(filename) ? "报审"
    : /中标|定标/.test(filename) ? "中标"
    : /投标/.test(filename) ? "投标"
    : /招标|清单|控制价|拦标|预算|概算/.test(filename) ? "招标"
    : "";
  return { stage, period };
}

export function classifyFile(
  filename: string,
  sheets: ParsedSheet[] | null,
  mime: string
): { kind: FileKind; confidence: number } {
  if (sheets?.length) {
    const hasBoq = sheets.some(
      (s) => (s.type === "BOQ" || s.type === "PENDING_QUOTE") && s.rows.some((r) => r.isItem)
    );
    const hasQuote = sheets.some(
      (s) => (s.type === "QUOTATION" || s.type === "MATERIAL_PRICE") && s.rows.some((r) => r.isItem)
    );
    if (hasBoq && !hasQuote) {
      const fromName = FILENAME_RULES.find(([re]) => re.test(filename))?.[1];
      if (fromName && fromName.startsWith("BOQ"))
        return { kind: fromName, confidence: 0.9 };
      return { kind: "BOQ_TENDER", confidence: 0.85 };
    }
    if (hasQuote && !hasBoq) return { kind: "MATERIAL_QUOTATION", confidence: 0.9 };
    if (hasBoq && hasQuote) return { kind: "BOQ_TENDER", confidence: 0.6 };
  }
  const byName = FILENAME_RULES.find(([re]) => re.test(filename));
  if (byName) return { kind: byName[1], confidence: 0.6 };
  if (/pdf/i.test(mime) || /\.pdf$/i.test(filename))
    return { kind: "CONTRACT", confidence: 0.3 };
  return { kind: "UNKNOWN", confidence: 0 };
}
