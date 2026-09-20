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

export function classifyFile(
  filename: string,
  sheets: ParsedSheet[] | null,
  mime: string
): { kind: FileKind; confidence: number } {
  if (sheets?.length) {
    const hasBoq = sheets.some((s) => s.type === "BOQ" && s.rows.some((r) => r.isItem));
    const hasQuote = sheets.some(
      (s) => s.type === "QUOTATION" && s.rows.some((r) => r.isItem)
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
