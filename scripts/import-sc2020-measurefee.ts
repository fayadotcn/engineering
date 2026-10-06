// 一次性导入：四川2020 安装措施费系数 → Dataset(meta JSON)
// 数据源 DE_SC21.DB3（真2020清单定额；SC20=四川2000定额，历史误标）:
//   ps_fy  措施费项目字典：fyid → fymc 名称(尾部带册码「… CK」「…(CA)」) + jsgs 计算基数公式
//   ps_fl  费率档：fyid → 档位(檐口高度/操作物高度分档或平费率) + fl费率% + rg/cl/jx 人材机占比%
// 用法: npx tsx scripts/import-sc2020-measurefee.ts
import { DatabaseSync } from "node:sqlite";
import { prisma } from "@database/client";

const DE_DB = "C:/Program Files/清单计价专家N10/DATABASE/DE_SC21.DB3";

interface PsFy { fyid: number; fymc: string; jsgs: string | null }
interface PsFl { fyid: number; flmc: string; fl: number | null; rg: number | null; cl: number | null; jx: number | null }

const categoryOf = (name: string): string => {
  if (/脚手架/.test(name)) return "脚手架搭拆费";
  if (/超高/.test(name)) return "超高增加费";
  if (/高层/.test(name)) return "高层建筑增加费";
  if (/系统调整/.test(name)) return "系统调整费";
  if (/同时进行|洞库|高原|行车行人|超层/.test(name)) return "特殊环境增加费";
  return "其他措施费";
};
const bookOf = (name: string): string => {
  // SC21 fymc 尾部带册码：「脚手架搭拆费 CK」「脚手架搭拆费(起重设备安装… CA)」「建筑物超高增加费(CD)」
  const m = name.match(/[（(][^（）()]*?([A-Z]{2})\s*[）)]\s*$/) ?? name.match(/\s([A-Z]{2})\s*$/);
  return m ? m[1] : "通用";
};

async function main() {
  const de = new DatabaseSync(DE_DB);
  const fyRows = de.prepare("SELECT fyid, fymc, jsgs FROM ps_fy").all() as unknown as PsFy[];
  const flRows = de.prepare("SELECT fyid, flmc, fl, rg, cl, jx FROM ps_fl").all() as unknown as PsFl[];
  de.close();

  const tiersByFyid = new Map<number, PsFl[]>();
  for (const r of flRows) {
    if (!tiersByFyid.has(r.fyid)) tiersByFyid.set(r.fyid, []);
    tiersByFyid.get(r.fyid)!.push(r);
  }

  const fees = fyRows.map((fy) => ({
    fyid: fy.fyid,
    name: fy.fymc,
    book: bookOf(fy.fymc),
    category: categoryOf(fy.fymc),
    // 计算基数公式原文（如 "定额人工费WG*费率/100"），基数恒为定额人工费(或+机械费)
    base: fy.jsgs ?? "定额人工费*费率/100",
    baseWithMachine: /机械费/.test(fy.jsgs ?? ""),
    tiers: (tiersByFyid.get(fy.fyid) ?? []).map((t) => ({
      tier: t.flmc,
      rate: (t.fl ?? 0) / 100,
      laborPct: t.rg, materialPct: t.cl, machinePct: t.jx,
    })),
  }));

  const ds = await prisma.dataset.upsert({
    where: { id: "sc2020-measure-fee" },
    update: { meta: JSON.stringify({ type: "MEASURE_FEE", fees }), rowCount: fees.length },
    create: {
      id: "sc2020-measure-fee",
      kind: "GENERIC", name: "四川2020措施费系数", filename: "DE_SC21.ps_fy+ps_fl",
      storageKey: "n10/DE_SC21", rowCount: fees.length,
      meta: JSON.stringify({ type: "MEASURE_FEE", fees }),
    },
  });
  console.log(`导入完成：${fees.length} 个措施费项目 → Dataset ${ds.id}`);
  for (const f of fees.slice(0, 12))
    console.log(`  ${f.book} ${f.name} [${f.category}] ${f.tiers.length}档 base=${f.base}`);
}

main().finally(() => prisma.$disconnect());
