import * as XLSX from "xlsx";
import { parseSemanticFeature } from "@cost-engine/semantic";

// 定额库专用解析：定额表的列名与清单/询价都不同
// （定额编号 / 子目名称 / 计量单位 / 人工费 / 材料费 / 机械费 / 主材耗量），
// 通用 BOQ 解析器不认识这些表头，所以这里直接读原始网格做列映射。

export interface ParsedQuotaRow {
  code: string;
  name: string;
  unit: string;
  unitScale: number;
  labor: number;
  material: number;
  machine: number;
  mainQtyPerUnit: number;
  matchKeys: Record<string, string>;
  raw: Record<string, string>;
}

const COL_PATTERNS: Record<string, RegExp> = {
  code: /定额编号|定额号|子目编号|子目号|编号|编码/,
  name: /子目名称|项目名称|定额名称|名称/,
  unit: /计量单位|单位/,
  labor: /人工费|人工/,
  material: /材料费|辅材费|材料/,
  machine: /机械费|机械/,
  mainQty: /主材耗量|主材含量|耗量|含量|主材/,
  basePrice: /基价|综合单价|合价/,
};

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  return String(v).trim();
}

const num = (s: string) => {
  const n = Number(s.replace(/,/g, ""));
  return isNaN(n) ? 0 : n;
};

// 定额单位倍数：10m → 10，100m → 100，台/个/m → 1
function unitScale(unit: string): number {
  const m = unit.match(/^(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 1;
}

export function parseQuotaWorkbook(buffer: Buffer): ParsedQuotaRow[] {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const out: ParsedQuotaRow[] = [];

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const grid: string[][] = (XLSX.utils
      .sheet_to_json(ws, { header: 1, raw: true, defval: "" }) as unknown[][])
      .map((r) => r.map(cellText));
    if (!grid.length) continue;

    // 在前 15 行里找定额表头（至少要命中 编号+名称+人工费 三个特征列）
    let headerIdx = -1;
    let cols: Record<string, number> = {};
    for (let i = 0; i < Math.min(15, grid.length); i++) {
      const map: Record<string, number> = {};
      grid[i].forEach((cell, ci) => {
        if (!cell) return;
        for (const [key, re] of Object.entries(COL_PATTERNS)) {
          if (map[key] === undefined && re.test(cell)) map[key] = ci;
        }
      });
      if (map.code !== undefined && map.name !== undefined && map.labor !== undefined) {
        headerIdx = i;
        cols = map;
        break;
      }
    }
    if (headerIdx < 0) continue;

    for (let i = headerIdx + 1; i < grid.length; i++) {
      const row = grid[i];
      const code = (row[cols.code] ?? "").trim();
      const name = (row[cols.name] ?? "").trim();
      if (!name || !code) continue;
      if (/^(定额|子目)?编号|名称|说明|注[:：]/.test(name)) continue;

      const unit = (row[cols.unit] ?? "").trim();
      const scale = unitScale(unit);
      // 消耗量定额惯例：耗量列是"每定额单位"（10m 管 → 10.2），
      // 引擎约定是"每清单单位"（1.02）。耗量 ≥ 倍数时判定为定额单位口径，归一化。
      const rawQty = cols.mainQty !== undefined ? num(row[cols.mainQty] ?? "") : 0;
      const mainQtyPerUnit = !rawQty ? 1 : rawQty >= scale ? rawQty / scale : rawQty;
      const f = parseSemanticFeature(`${name} ${unit}`, "");
      const matchKeys: Record<string, string> = {};
      if (f.category) matchKeys.category = f.category;
      if (f.material) matchKeys.material = f.material;
      if (f.diameter) matchKeys.diameter = f.diameter;
      if (f.specification) matchKeys.spec = f.specification;
      if (f.connectionMethod) matchKeys.connection = f.connectionMethod;
      if (f.system) matchKeys.system = f.system;

      out.push({
        code,
        name,
        unit,
        unitScale: scale,
        labor: num(row[cols.labor] ?? ""),
        material: num(row[cols.material] ?? ""),
        machine: num(row[cols.machine] ?? ""),
        mainQtyPerUnit,
        matchKeys,
        raw: Object.fromEntries(
          Object.entries(cols).map(([k, ci]) => [k, row[ci] ?? ""])
        ),
      });
    }
  }
  return out;
}
