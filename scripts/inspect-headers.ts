import * as XLSX from "xlsx";
import { readFileSync } from "fs";

for (const f of ["电线电缆询价.xlsx", "机电询价.xlsx", "水电安装.xls"]) {
  const buf = readFileSync("C:/Users/home/Desktop/" + f);
  const wb = XLSX.read(buf, { type: "buffer" });
  console.log("========", f);
  for (const sn of wb.SheetNames.slice(0, 4)) {
    const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[sn], {
      header: 1, defval: "",
    });
    console.log("-- sheet:", sn);
    rows.slice(0, 4).forEach((r, i) => console.log(`   r${i}:`, JSON.stringify(r).slice(0, 300)));
  }
}
