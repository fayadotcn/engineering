/**
 * 语义特征重算：解析规则升级后（如新增 power 字段），
 * 库里存量的 BoqItem.features / QuotationItem.features 仍是旧解析结果。
 * 幂等重跑：同输入同输出，可按需多次执行。
 * 用法：npx tsx scripts/reparse-features.ts
 */
import { prisma } from "@database/client";
import { parseSemanticFeature } from "@cost-engine/semantic";
import { toJson } from "@shared/json";

async function main() {
  const boq = await prisma.boqItem.findMany({
    select: { id: true, name: true, rawFeature: true, features: true },
  });
  let updated = 0, skipped = 0;
  for (const it of boq) {
    const next = toJson(parseSemanticFeature(it.name, it.rawFeature ?? ""));
    // 特征未变跳过写库——重复执行应为零写入的纯校验
    if (it.features === next) { skipped++; continue; }
    await prisma.boqItem.update({
      where: { id: it.id },
      data: { features: next },
    });
    updated++;
  }
  const quotes = await prisma.quotationItem.findMany({
    select: { id: true, materialName: true, spec: true, features: true },
  });
  let qUpdated = 0, qSkipped = 0;
  for (const q of quotes) {
    const next = toJson(
      parseSemanticFeature(`${q.materialName} ${q.spec ?? ""}`, "")
    );
    if (q.features === next) { qSkipped++; continue; }
    await prisma.quotationItem.update({
      where: { id: q.id },
      data: { features: next },
    });
    qUpdated++;
  }
  const prices = await prisma.materialPrice.findMany({
    select: { id: true, name: true, spec: true, features: true },
  });
  let pUpdated = 0, pSkipped = 0;
  for (const p of prices) {
    const next = toJson(parseSemanticFeature(`${p.name} ${p.spec ?? ""}`, ""));
    if (p.features === next) { pSkipped++; continue; }
    await prisma.materialPrice.update({
      where: { id: p.id },
      data: { features: next },
    });
    pUpdated++;
  }
  console.log(
    `re-parsed ${updated} BoqItems (${skipped} unchanged), ${qUpdated} QuotationItems (${qSkipped} unchanged), ${pUpdated} MaterialPrices (${pSkipped} unchanged)`
  );
}

main().finally(() => prisma.$disconnect());
