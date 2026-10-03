// 学习本地真实造价表格：跑 inspectWorkbook，归纳各类型文件的表结构。
// 用法: npx tsx scripts/learn-real-files.ts <文件1> [文件2...]
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { inspectWorkbook } from "../file/excel";

for (const p of process.argv.slice(2)) {
  console.log("\n" + "═".repeat(70));
  console.log("📄 " + basename(p));
  try {
    const sheets = inspectWorkbook(readFileSync(p));
    for (const s of sheets) {
      console.log(`  ▸ [${s.sheetName}] type=${s.type} conf=${s.typeConfidence.toFixed(2)} rows=${s.rowCount} cols=${s.colCount}`);
      console.log(`    表头: ${s.headerCells.slice(0, 12).join(" | ")}`);
      const roles = Object.entries(s.columns).map(([k, v]) => `${v}→${k}`).join("，");
      if (roles) console.log(`    角色: ${roles}`);
      if (s.typeEvidence) console.log(`    依据: ${s.typeEvidence.slice(0, 120)}`);
      const first = s.sample.slice(0, 3).map(r => r.slice(0, 8).join("|")).join("\n          ");
      if (first) console.log(`    样本: ${first}`);
    }
  } catch (e) {
    console.log("  ✗ 解析失败: " + (e as Error).message.slice(0, 120));
  }
}
