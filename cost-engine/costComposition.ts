import Decimal from "decimal.js";
import { D, round2 } from "@cost-engine/money";
import { isPricableItem, type BoqItemDTO, type CostCompositionRow } from "@shared/types";

// 人材机成本构成分析（P2 成本模型）：把每个可计价清单项的合价拆成
// 人工费 / 材料费 / 机械费 / 管利及其他 四个分量。
//
// 分量来源按可信度排序：
// 1) pricingPlan（定额组价方案）——四分量齐全，material = 辅材 + 主材价×耗量；
//    方案行标了主材名但缺主材价 → 材料费不完整，margin 置空（错价不如不估）。
// 2) 导入的人材机分解列（laborUnitPrice/machineUnitPrice，综合单价分析表口径）——
//    人工/机械已知；有主材暂估价时材料=主材价×量（辅材未知，并入 other），
//    否则材料整份未知，合价差额全进 other。
// 3) 仅主材暂估价 → 材料已知一角，其余全进 other。
// 4) 什么都没有 → 全额进 other，coverage.none 计数。
//
// other = 合价 − 已知分量，恒可计算，保证四分量加总=合价。
// 对组价项它恰是管利；对未分解项它是「材料+管利」的混合剩余——
// 口径诚实性靠 coverage/source 标注，不靠猜拆分。
// 人材机三分量都已知才算 directCost / margin；margin<0 即成本倒挂（报价比成本还低）。

export interface CostCompositionResult {
  rows: CostCompositionRow[];
  totals: {
    revenue: string;
    coveredRevenue: string;
    labor: string;
    material: string;
    machine: string;
    other: string;
    /** margin 可算口径（人材机齐全的子集）的收入/毛利/毛利率% */
    marginRevenue: string;
    margin: string;
    marginRate: string | null;
  };
  coverage: { plan: number; imported: number; partial: number; none: number; inverted: number };
}

interface Parts {
  labor: Decimal | null;
  material: Decimal | null;
  machine: Decimal | null;
  source: CostCompositionRow["source"];
}

// rawCells 兜底用的表头同义词（与 file/excel.ts COLUMN_SYNONYMS 的 labor/machine 对齐，
// 刻意收窄在「单价/费」形态，避免误扫到备注列）。
const LABOR_KEY = /人工单价|人工费单价|人工.*单价|单价.*人工|^人工费$|^人工$/i;
const MACHINE_KEY = /机械单价|机械费单价|机械.*单价|^机械费$|^机械$/i;

/** 分解列字段为 0 时回扫 rawCells——成本字段上线前导入的旧数据，
 *  人工/机械单价只存在整行原文里（键=表头标签，重名带 "(C)" 后缀）。 */
function legacyCostColumns(item: BoqItemDTO): { labor: Decimal; machine: Decimal } {
  const labor = D(item.laborUnitPrice ?? 0);
  const machine = D(item.machineUnitPrice ?? 0);
  if (labor.gt(0) || machine.gt(0) || !item.rawCells) return { labor, machine };
  const pick = (re: RegExp): Decimal => {
    for (const [k, v] of Object.entries(item.rawCells!)) {
      const label = k.replace(/\([A-Z]+\)$/, "").replace(/\s+/g, "");
      if (!re.test(label)) continue;
      const first = String(v ?? "").split("\n")[0].replace(/[,\s]/g, "");
      const n = Number(first);
      if (first !== "" && Number.isFinite(n) && n > 0) return D(n);
    }
    return D(0);
  };
  return { labor: pick(LABOR_KEY), machine: pick(MACHINE_KEY) };
}

function partsFromPlan(item: BoqItemDTO, qty: Decimal): Parts | null {
  const lines = (item.pricingPlan ?? []).filter((l) => !l.suggested);
  if (!lines.length) return null;
  let labor = D(0), aux = D(0), machine = D(0), main = D(0);
  let mainUnknown = false;
  for (const l of lines) {
    // 旧库里的 pricingPlan 行可能缺字段（字段上线前写入的方案）——缺省按 0，绝不让分析整表抛错
    labor = labor.plus(D(l.labor ?? 0));
    aux = aux.plus(D(l.materialAux ?? 0));
    machine = machine.plus(D(l.machine ?? 0));
    if (l.mainMaterialName) {
      if (l.mainQty && l.mainPrice) main = main.plus(D(l.mainQty).mul(D(l.mainPrice)));
      else mainUnknown = true; // 需要主材但没有价：材料费不完整
    }
  }
  return {
    labor: labor.mul(qty),
    material: mainUnknown ? null : aux.plus(main).mul(qty),
    machine: machine.mul(qty),
    source: "quotaPlan",
  };
}

function itemParts(item: BoqItemDTO): Parts {
  const qty = D(item.quantity);
  const plan = partsFromPlan(item, qty);
  if (plan) return plan;

  const { labor: laborU, machine: machineU } = legacyCostColumns(item);
  const mainMat = D(item.mainMaterialPrice ?? 0);
  if (laborU.gt(0) || machineU.gt(0)) {
    // 分解表口径：人/机为已知列值（0 即真无该项费用）；
    // 材料仅在有主材暂估价时按主材估一角，缺辅材——剩余并入 other。
    return {
      labor: laborU.mul(qty),
      material: mainMat.gt(0) ? mainMat.mul(qty) : null,
      machine: machineU.mul(qty),
      source: "imported",
    };
  }
  if (mainMat.gt(0)) {
    return { labor: null, material: mainMat.mul(qty), machine: null, source: "partial" };
  }
  return { labor: null, material: null, machine: null, source: "none" };
}

export function analyzeCostComposition(items: BoqItemDTO[]): CostCompositionResult {
  const rows: CostCompositionRow[] = [];
  const t = {
    revenue: D(0), covered: D(0),
    labor: D(0), material: D(0), machine: D(0), other: D(0),
    marginRevenue: D(0), margin: D(0),
  };
  const coverage = { plan: 0, imported: 0, partial: 0, none: 0, inverted: 0 };

  for (const item of items) {
    if (!isPricableItem(item)) continue; // 总价措施/其他项目是总额计价行，不分解
    const revenue = D(item.totalPrice);
    const p = itemParts(item);
    const known = [p.labor, p.material, p.machine]
      .filter((x): x is Decimal => x !== null)
      .reduce((a, x) => a.plus(x), D(0));
    const other = revenue.minus(known);
    const directCost =
      p.labor !== null && p.material !== null && p.machine !== null
        ? p.labor.plus(p.material).plus(p.machine)
        : null;
    const margin = directCost !== null ? revenue.minus(directCost) : null;
    const inverted = margin !== null && margin.lt(0);

    t.revenue = t.revenue.plus(revenue);
    t.labor = t.labor.plus(p.labor ?? 0);
    t.material = t.material.plus(p.material ?? 0);
    t.machine = t.machine.plus(p.machine ?? 0);
    t.other = t.other.plus(other);
    if (p.source !== "none") t.covered = t.covered.plus(revenue);
    coverage[p.source === "quotaPlan" ? "plan" : p.source]++;
    if (inverted) coverage.inverted++;
    if (margin !== null) {
      t.marginRevenue = t.marginRevenue.plus(revenue);
      t.margin = t.margin.plus(margin);
    }

    rows.push({
      itemId: item.id,
      code: item.code,
      name: item.name,
      unit: item.unit,
      quantity: item.quantity,
      revenue: round2(revenue).toFixed(2),
      labor: p.labor === null ? null : round2(p.labor).toFixed(2),
      material: p.material === null ? null : round2(p.material).toFixed(2),
      machine: p.machine === null ? null : round2(p.machine).toFixed(2),
      other: round2(other).toFixed(2),
      directCost: directCost === null ? null : round2(directCost).toFixed(2),
      margin: margin === null ? null : round2(margin).toFixed(2),
      marginRate:
        margin === null || revenue.isZero()
          ? null
          : margin.div(revenue).mul(100).toFixed(1),
      source: p.source,
      inverted,
    });
  }

  return {
    rows,
    totals: {
      revenue: round2(t.revenue).toFixed(2),
      coveredRevenue: round2(t.covered).toFixed(2),
      labor: round2(t.labor).toFixed(2),
      material: round2(t.material).toFixed(2),
      machine: round2(t.machine).toFixed(2),
      other: round2(t.other).toFixed(2),
      marginRevenue: round2(t.marginRevenue).toFixed(2),
      margin: round2(t.margin).toFixed(2),
      marginRate: t.marginRevenue.isZero()
        ? null
        : t.margin.div(t.marginRevenue).mul(100).toFixed(1),
    },
    coverage,
  };
}
