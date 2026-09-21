// 一次性导入：清单计价专家N10 本地 SQLite 库 → Dataset + QuotaRow
// 数据源:
//   ZY_N8QD_SC20.DB3  az_zy  清单编码(xmbh)↔定额编号(debh) 映射
//   DE_SC20.DB3       az_de  定额明细(人材机/基价)  az_yl 用料  zh_cl 材料  az_fb 分册
// 用法: npx tsx scripts/import-sc2020-quota.ts
import { DatabaseSync } from "node:sqlite";
import { prisma } from "@database/client";
import { parseSemanticFeature } from "@cost-engine/semantic";

const N10 = "C:/Program Files/清单计价专家N10/DATABASE";
const ZY_DB = `${N10}/ZY_N8QD_SC20.DB3`;
const DE_DB = `${N10}/DE_SC20.DB3`;

/** 专业册映射：表前缀 → 专业名（fl=配合比附录非定额子目，不导入） */
const BOOKS: Record<string, string> = {
  az: "安装", fg: "仿古", tj: "土建", sz: "市政", zs: "装饰", wx: "房屋修缮",
};

interface DeRow {
  debh: string; xmmc: string; dw: string;
  jj: number | null; rgf: number | null; clf: number | null; jxf: number | null;
  gcnr: string | null; zjbh: string | null;
}

const unitScale = (dw: string) => {
  const m = String(dw).match(/^(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 1;
};
const baseUnit = (dw: string) => String(dw).replace(/^\d+(?:\.\d+)?/, "").trim();

/** 最长公共子串长度（用于主材名 vs 定额名称的重合度） */
function lcsLen(a: string, b: string): number {
  let best = 0;
  for (let i = 0; i < a.length; i++)
    for (let j = i + 2; j <= a.length; j++)
      if (b.includes(a.slice(i, j)) && j - i > best) best = j - i;
  return best;
}

async function importBook(zy: DatabaseSync, de: DatabaseSync, p: string, label: string) {
  // 1) 清单编码映射: debh → Set<xmbh(9位)>（该专业 zy 表可能不存在）
  const codeMap = new Map<string, Set<string>>();
  const hasZy = zy.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name=?").get(`${p}_zy`) as { c: number };
  if (hasZy.c) {
    for (const r of zy.prepare(`SELECT debh, xmbh FROM ${p}_zy WHERE xmbh != '' AND debh != ''`).all() as { debh: string; xmbh: string }[]) {
      if (!codeMap.has(r.debh)) codeMap.set(r.debh, new Set());
      codeMap.get(r.debh)!.add(r.xmbh.trim());
    }
  }

  // 2) 材料主表
  const clMap = new Map<string, { clmc: string; cldw: string }>();
  for (const c of de.prepare("SELECT clbh, clmc, cldw FROM zh_cl").all() as { clbh: string; clmc: string; cldw: string }[])
    clMap.set(c.clbh, { clmc: c.clmc ?? "", cldw: c.cldw ?? "" });

  // 3) 用料: debh → yl rows（部分专业可能无用料表）
  const ylMap = new Map<string, { clbh: string; clyl: number }[]>();
  const hasYl = de.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name=?").get(`${p}_yl`) as { c: number };
  if (hasYl.c) {
    for (const y of de.prepare(`SELECT debh, clbh, clyl FROM ${p}_yl`).all() as { debh: string; clbh: string; clyl: number }[]) {
      if (!ylMap.has(y.debh)) ylMap.set(y.debh, []);
      ylMap.get(y.debh)!.push(y);
    }
  }

  // 4) 分册名: fbid → fbmc；章节树: zjbh → mc（目录节点，按编码前缀挂到定额上）
  const fbMap = new Map<string, string>();
  for (const f of de.prepare(`SELECT fbid, fbmc FROM ${p}_fb`).all() as { fbid: string; fbmc: string }[])
    fbMap.set(f.fbid, f.fbmc);
  const mlRows = de.prepare(`SELECT zjbh, mc FROM ${p}_ml ORDER BY length(zjbh), zjbh`).all() as { zjbh: string; mc: string }[];
  const chapterOf = (zjbh: string | null): string => {
    if (!zjbh) return "";
    // zjbh 逐级前缀匹配目录树：5H010101 → 5H01(章) → 5H0101(节)
    const parts: string[] = [];
    for (const m of mlRows)
      if (m.zjbh && zjbh.startsWith(m.zjbh) && m.mc) parts.push(m.mc);
    return parts.join(" > ");
  };

  const des = de.prepare(`SELECT * FROM ${p}_de ORDER BY fid`).all() as unknown as DeRow[];
  console.log(`${p}_de(${label}) 定额子目: ${des.length} 条`);

  // 5) Dataset 记录（幂等：同名数据集先删后建）
  const DS_NAME = `四川省2020建设工程工程量清单计价定额·${label}（N10导入）`;
  const old = await prisma.dataset.findFirst({ where: { name: DS_NAME } });
  if (old) {
    // 关系默认 SetNull——必须先删行再删集，否则行成孤儿仍参与匹配
    await prisma.quotaRow.deleteMany({ where: { datasetId: old.id } });
    await prisma.dataset.delete({ where: { id: old.id } });
  }
  const ds = await prisma.dataset.create({
    data: {
      kind: "QUOTA",
      name: DS_NAME,
      filename: "ZY_N8QD_SC20.DB3 + DE_SC20.DB3",
      storageKey: `n10://DATABASE/SC20/${p}`,
      status: "PARSED",
      rowCount: des.length,
      meta: JSON.stringify({
        source: "清单计价专家N10",
        edition: "四川2020",
        book: p,
        divisions: [...fbMap.values()],
        note: "含清单编码映射与主材耗量",
      }),
    },
  });

  // 6) 逐条转换 + 批量入库
  let withMain = 0;
  const rows = des.map((r) => {
    const scale = unitScale(r.dw);
    const bu = baseUnit(r.dw);

    // 主材挑选：与子目名称重合度最高 → 单位与定额基单位一致 → 耗量最大
    const yls = (ylMap.get(r.debh) ?? [])
      .map((y) => ({ ...y, cl: clMap.get(y.clbh) }))
      .filter((y) => y.cl?.clmc);
    let mainName = "";
    let mainQty = 0;
    if (yls.length) {
      const ranked = yls
        .map((y) => ({
          ...y,
          score: lcsLen(y.cl!.clmc, r.xmmc) * 100 + (y.cl!.cldw === bu ? 30 : 0) + Math.min(y.clyl, 20),
        }))
        .sort((a, b) => b.score - a.score)[0];
      mainName = ranked.cl!.clmc;
      mainQty = ranked.clyl / scale;
      withMain++;
    }

    const f = parseSemanticFeature(`${r.xmmc} ${r.dw}`, "");
    const codes = codeMap.get(r.debh);
    const matchKeys: Record<string, string> = {};
    if (f.category) matchKeys.category = f.category;
    if (f.material) matchKeys.material = f.material;
    if (f.diameter) matchKeys.diameter = f.diameter;
    if (f.specification) matchKeys.spec = f.specification;
    if (f.connectionMethod) matchKeys.connection = f.connectionMethod;
    if (f.system) matchKeys.system = f.system;
    if (mainName) matchKeys.keywords = mainName;
    if (codes?.size) matchKeys.xmbh = [...codes].join(",");

    return {
      datasetId: ds.id,
      code: r.debh,
      name: r.xmmc,
      unit: r.dw,
      unitScale: scale,
      labor: r.rgf ?? 0,
      material: r.clf ?? 0,
      machine: r.jxf ?? 0,
      mainQtyPerUnit: mainQty ? Number(mainQty.toFixed(4)) : 1,
      matchKeys: JSON.stringify(matchKeys),
      raw: JSON.stringify({
        jj: r.jj, zjbh: r.zjbh, gcnr: r.gcnr ?? "",
        fb: fbMap.get(r.debh.slice(0, 2)) ?? "",
        chapter: chapterOf(r.zjbh),
        mainMaterial: mainName,
      }),
    };
  });

  for (let i = 0; i < rows.length; i += 500)
    await prisma.quotaRow.createMany({ data: rows.slice(i, i + 500) });

  console.log(`  导入完成: ${rows.length} 条 | 含主材耗量 ${withMain} 条 | 含清单编码映射 ${rows.filter((r) => JSON.parse(r.matchKeys).xmbh).length} 条 | Dataset: ${ds.id}`);
}

async function main() {
  const only = process.argv[2]; // npx tsx scripts/import-sc2020-quota.ts [az|tj|sz|zs|fg|wx|all]
  const zy = new DatabaseSync(ZY_DB, { readOnly: true });
  const de = new DatabaseSync(DE_DB, { readOnly: true });
  const books = Object.entries(BOOKS).filter(([p]) => !only || only === "all" || p === only);
  for (const [p, label] of books) await importBook(zy, de, p, label);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
