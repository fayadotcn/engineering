import { prisma } from "../database/client";
import { fromJson, toJson } from "../shared/json";
import { reconcilePriceRole } from "../shared/mapping";

/**
 * 修复被固化成询价表的清单模板。
 *
 * 项目编码是清单专有角色——材料询价表不会带清单编码。一条 sheetType=QUOTATION
 * 却映射了 code 角色的模板是自相矛盾的，而且 templateHit 会让它绕过确认门，
 * 把招标清单静默导成询价（清单永远进不来）。这里把它改回 BOQ 并对齐单价角色。
 *
 * 用法：tsx scripts/repair-import-templates.ts [--apply]
 */
const BOQ_ONLY_ROLES = ["code"];

async function main() {
  const apply = process.argv.includes("--apply");
  const templates = await prisma.importTemplate.findMany();
  let found = 0;
  for (const t of templates) {
    const columns = fromJson<Record<string, number>>(t.columns, {});
    if (t.sheetType !== "QUOTATION") continue;
    if (!BOQ_ONLY_ROLES.some((role) => columns[role] !== undefined)) continue;
    const { columns: next, moved } = reconcilePriceRole("BOQ", columns, t.headerText.split("|").map((s) => s.trim()));
    console.log(`模板 ${t.fingerprint.slice(0, 12)}（已用 ${t.useCount} 次）`);
    console.log(`  表头：${t.headerText}`);
    console.log(`  改动：sheetType QUOTATION → BOQ${moved ? `，单价角色 ${moved}` : ""}`);
    if (apply) {
      await prisma.importTemplate.update({
        where: { id: t.id },
        data: { sheetType: "BOQ", columns: toJson(next) },
      });
    }
    found++;
  }
  console.log(found === 0 ? "没有需要修复的模板" : apply ? `已修复 ${found} 条` : `发现 ${found} 条待修复（加 --apply 执行）`);
}

void main().finally(() => prisma.$disconnect());
