import { parseWorkbook } from "../file/excel";
import { readFileSync } from "fs";

const buf = readFileSync("C:/Users/home/Desktop/电线电缆询价.xlsx");
const sheets = parseWorkbook(buf);
for (const s of sheets) {
  console.log("sheet:", s.sheetName, s.type);
  for (const r of s.rows.filter((x) => x.isItem).slice(0, 4)) {
    console.log("  ", JSON.stringify({
      name: r.cells.materialName || r.cells.name,
      spec: r.cells.spec,
      unit: r.cells.unit,
      price: r.cells.price,
      qty: r.cells.quantity,
    }));
  }
}
const buf2 = readFileSync("C:/Users/home/Desktop/机电询价.xlsx");
for (const s of parseWorkbook(buf2).slice(0, 2)) {
  console.log("sheet:", s.sheetName, s.type);
  for (const r of s.rows.filter((x) => x.isItem).slice(0, 3)) {
    console.log("  ", JSON.stringify({
      code: r.cells.code, name: r.cells.name,
      feature: (r.cells.feature ?? "").slice(0, 80),
      unit: r.cells.unit, qty: r.cells.quantity,
    }));
  }
}
