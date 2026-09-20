import { parseWorkbook } from "../file/excel";
import { classifyFile } from "../file/classify";
import { readFileSync } from "fs";

for (const f of [
  "电线电缆询价.xlsx",
  "水电安装.xls",
  "海南分部分项.xlsx",
  "机电询价.xlsx",
]) {
  try {
    const buf = readFileSync("C:/Users/home/Desktop/" + f);
    const sheets = parseWorkbook(buf);
    const cls = classifyFile(f, sheets, "");
    console.log("===", f, "->", cls.kind, cls.confidence);
    for (const s of sheets.slice(0, 3))
      console.log(
        "  sheet:", s.sheetName, s.type,
        "hdr@" + (s.headerRow + 1),
        "cols:", JSON.stringify(s.columns),
        "rows:", s.rows.length,
        "items:", s.rows.filter((r) => r.isItem).length
      );
  } catch (e) {
    console.log("===", f, "ERROR", String(e).slice(0, 120));
  }
}
