import type { BoqItemDTO, BoqSemanticFeature, QuotationItemDTO } from "@shared/types";
import { normUnit } from "./semantic";

// Quotation (询价) <-> BOQ item matching. Deterministic scoring; the agent
// only decides apply/skip — the score itself is computed here.

const norm = (s: string) =>
  s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toUpperCase()
    .replace(/[^\p{Script=Han}A-Z0-9.X×*+-]/gu, "");

// 规格比对归一化：公称直径前缀与裸数字等价（DN100 ≡ Φ100 ≡ 100），
// 尺寸分隔符统一 x（4*25 ≡ 4×25 ≡ 4x25 ≡ 4X25）。
export const specNorm = (s: string) =>
  norm(s)
    .replace(/^(?:DN|DE|Φ|φ)/, "")
    .replace(/[*×X]/g, "x");

function scorePair(boq: BoqItemDTO, q: QuotationItemDTO): number {
  const bf = boq.features ?? {};
  const qf = q.features ?? {};
  let score = 0;

  // spec / diameter match is the strongest signal for 安装材料
  const bSpec = bf.diameter ?? bf.specification;
  const qSpec = qf.diameter ?? qf.specification ?? q.spec;
  if (bSpec && qSpec) {
    if (specNorm(bSpec) === specNorm(qSpec)) score += 45;
    else return 0; // spec conflict -> different material
  }

  const bn = norm(boq.name);
  const qn = norm(q.materialName);
  if (qn && bn.includes(qn)) score += 30;
  else if (bf.material && qn.includes(norm(bf.material))) score += 25;
  else if (bf.category && qn.includes(norm(bf.category))) score += 12;

  if (bf.material && qf.material && bf.material === qf.material) score += 10;
  if (bf.system && qf.system && bf.system === qf.system) score += 5;
  if (q.brand && bf.brand && norm(q.brand) === norm(bf.brand)) score += 10;
  if (boq.unit && q.unit && normUnit(boq.unit) === normUnit(q.unit)) score += 5;

  // token overlap tiebreaker
  const bt = new Set(bf.tokens ?? []);
  const overlap = (qf.tokens ?? []).filter((t) => bt.has(t)).length;
  score += Math.min(overlap * 2, 10);

  return Math.min(score, 100);
}

export interface MatchResult {
  quotationItemId: string;
  materialName: string;
  spec: string;
  brand: string;
  price: string;
  matchedBoqItemIds: string[];
  matchedNames: string[];
  confidence: number;
  status: "MATCHED" | "UNMATCHED" | "LOW_CONFIDENCE";
}

export function matchQuotations(
  boqItems: BoqItemDTO[],
  quotes: QuotationItemDTO[],
  threshold = 60
): { rows: MatchResult[]; unmatched: QuotationItemDTO[] } {
  const leaf = boqItems.filter((i) => !i.isHeader && i.name.trim());
  const rows: MatchResult[] = [];
  const unmatched: QuotationItemDTO[] = [];

  for (const q of quotes) {
    const scored = leaf
      .map((b) => ({ b, s: scorePair(b, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    const top = scored[0];
    if (!top || top.s < 30) {
      unmatched.push(q);
      rows.push({
        quotationItemId: q.id,
        materialName: q.materialName,
        spec: q.spec,
        brand: q.brand,
        price: q.price,
        matchedBoqItemIds: [],
        matchedNames: [],
        confidence: top?.s ?? 0,
        status: "UNMATCHED",
      });
      continue;
    }
    const matches = scored.filter((x) => x.s >= Math.max(threshold, top.s - 15));
    rows.push({
      quotationItemId: q.id,
      materialName: q.materialName,
      spec: q.spec,
      brand: q.brand,
      price: q.price,
      matchedBoqItemIds: matches.map((m) => m.b.id),
      matchedNames: [...new Set(matches.map((m) => m.b.name))].slice(0, 4),
      confidence: top.s,
      status: top.s >= threshold ? "MATCHED" : "LOW_CONFIDENCE",
    });
  }
  return { rows, unmatched };
}

export const emptyFeature = (): BoqSemanticFeature => ({});
