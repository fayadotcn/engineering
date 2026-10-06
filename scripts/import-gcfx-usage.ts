// 导入宏业工程定额套用经验语料 → UsageStat/UsageCombo（整表重建，幂等）
// 用法: npx tsx scripts/import-gcfx-usage.ts [corpusDir=storage/gcfx-corpus]
// 前置: 先跑 extract-gcfx-quota.ts 生成 usage.jsonl
import fs from "node:fs";
import path from "node:path";
import { importUsageCorpus, usageSummary, type UsageItemRecord } from "../quota/usage";

const DIR = process.argv[2] ?? "storage/gcfx-corpus";

async function main() {
  const file = path.join(DIR, "usage.jsonl");
  if (!fs.existsSync(file)) {
    console.error(`未找到 ${file}——先运行 scripts/extract-gcfx-quota.ts 生成语料`);
    process.exit(1);
  }
  const items: UsageItemRecord[] = fs.readFileSync(file, "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  console.log(`读取清单项 ${items.length} 条，聚合导入中…`);
  const t0 = Date.now();
  const r = await importUsageCorpus(items);
  console.log(`导入完成：${r.buckets} 个名称桶 → UsageStat ${r.stats} 行 + UsageCombo ${r.combos} 行（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  console.log(await usageSummary());
}
main();
