// 一次性导入：清单计价专家N10 本地 SQLite 库 → Dataset + QuotaRow
// 数据源（真四川2020清单定额，DE_SC21；注意 DE_SC20 是四川2000定额——历史误标事故）:
//   ZY_N3QD_SC21.DB3 / ZY_ZJXQDB2022_SC21.DB3  {p}_zy  清单编码(xmbh)↔定额编号(debh) 映射
//   DE_SC21.DB3       {p}_de 定额明细(人材机/基价/管理费glf/利润lr)  {p}_yl 用料
//                     zh_cl 材料  {p}_fb 分册  {p}_ml 章节树(含「(编码:03xxxx)」清单映射与 zjsm 章节工作内容)
//   AZ 安装册无 _zy 表——xmbh 全部由 {p}_ml.mc 的「(编码：NNNNN)」标注按 zjbh 前缀派生
// 用法: npx tsx scripts/import-sc2020-quota.ts [az|tj|sz|all]
import { DatabaseSync } from "node:sqlite";
import { prisma } from "@database/client";
import { parseSemanticFeature } from "@cost-engine/semantic";

const N10 = "C:/Program Files/清单计价专家N10/DATABASE";
const DE_DB = `${N10}/DE_SC21.DB3`;
const ZY_DBS = [`${N10}/ZY_N3QD_SC21.DB3`, `${N10}/ZY_ZJXQDB2022_SC21.DB3`];

/** 分册表前缀 → 中文标签（fl=配合比附录、jx=机械台班单价表，非定额子目不导入） */
const BOOKS: Record<string, string> = {
  az: "安装", tj: "土建（含装饰）", sz: "市政", fg: "仿古", yl: "园林绿化",
  fw: "房屋维修加固", gd: "轨道交通", lj: "绿色建筑", bp: "爆破", gz: "构筑物",
  gl: "综合管廊", zp: "装配式", pg: "排水设施养护", dw: "道路养护", gg: "轨道维护", ld: "路灯维护",
};
/** 旧误标 2000 库遗留、SC21 无对应册的数据集名 → 导入后删除 */
const STALE_DATASETS = [
  "四川省2020建设工程工程量清单计价定额·装饰（N10导入）",
  "四川省2020建设工程工程量清单计价定额·房屋修缮（N10导入）",
];

interface DeRow {
  debh: string; xmmc: string; dw: string;
  jj: number | null; rgf: number | null; clf: number | null; jxf: number | null;
  glf: number | null; lr: number | null;
  gcnr: string | null; zjbh: string | null; qtsm: string | null; jsgz: string | null;
}
interface MlRow { zjbh: string; mc: string; zjsm: string | null; ksdebh: string | null; jsdebh: string | null }

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

const tableExists = (db: DatabaseSync, name: string) =>
  (db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND lower(name)=lower(?)").get(name) as { c: number }).c > 0;

async function importBook(zys: DatabaseSync[], de: DatabaseSync, p: string, label: string) {
  // 1) 清单编码映射: debh → Set<xmbh>
  //    a) {p}_zy 表（各 zy 库取第一个非空的）
  const codeMap = new Map<string, Set<string>>();
  for (const zy of zys) {
    if (!tableExists(zy, `${p}_zy`)) continue;
    const rows = zy.prepare(`SELECT debh, xmbh FROM ${p}_zy WHERE xmbh != '' AND debh != ''`).all() as { debh: string; xmbh: string }[];
    if (!rows.length) continue;
    for (const r of rows) {
      if (!codeMap.has(r.debh)) codeMap.set(r.debh, new Set());
      codeMap.get(r.debh)!.add(r.xmbh.trim());
    }
    break;
  }

  // 2) 材料主表 + 用料
  const clMap = new Map<string, { clmc: string; cldw: string }>();
  for (const c of de.prepare("SELECT clbh, clmc, cldw FROM zh_cl").all() as { clbh: string; clmc: string; cldw: string }[])
    clMap.set(c.clbh, { clmc: c.clmc ?? "", cldw: c.cldw ?? "" });
  const ylMap = new Map<string, { clbh: string; clyl: number }[]>();
  if (tableExists(de, `${p}_yl`)) {
    for (const y of de.prepare(`SELECT debh, clbh, clyl FROM ${p}_yl`).all() as { debh: string; clbh: string; clyl: number }[]) {
      if (!ylMap.has(y.debh)) ylMap.set(y.debh, []);
      ylMap.get(y.debh)!.push(y);
    }
  }

  // 3) 分册名 + 章节树（mc 含「(编码：030901001)」清单标注 + zjsm 章节工作内容）
  const fbMap = new Map<string, string>();
  for (const f of de.prepare(`SELECT fbid, fbmc FROM ${p}_fb`).all() as { fbid: string; fbmc: string }[])
    fbMap.set(f.fbid, f.fbmc);
  const mlRows = tableExists(de, `${p}_ml`)
    ? de.prepare(`SELECT zjbh, mc, zjsm, ksdebh, jsdebh FROM ${p}_ml ORDER BY length(zjbh), zjbh`).all() as unknown as MlRow[]
    : [];
  const chapterOf = (zjbh: string | null): string => {
    if (!zjbh) return "";
    const parts: string[] = [];
    for (const m of mlRows)
      if (m.zjbh && zjbh.startsWith(m.zjbh) && m.mc) parts.push(m.mc.replace(/\s*（?编码：?[\d，,、\s]+）?\s*/g, "").trim());
    return parts.join(" > ");
  };
  // b) xmbh 兜底：章节名「(编码：030901001)」→ 该节点覆盖的定额（zjbh 前缀或 debh 区间）
  //    安装册 AZ 没有 _zy 表，全靠这条路径拿到清单编码
  const mlCode: { zjbh: string; code: string }[] = [];
  for (const m of mlRows) {
    const mc = m.mc ?? "";
    for (const mm of mc.matchAll(/编码：?([\d，,、\s]+)/g))
      for (const c of mm[1].split(/[，,、\s]+/).filter((x) => /^\d{6,12}$/.test(x)))
        mlCode.push({ zjbh: m.zjbh, code: c });
  }
  const mlSmOf = (zjbh: string | null): string => {
    if (!zjbh) return "";
    let sm = "";
    for (const m of mlRows) if (m.zjbh && zjbh.startsWith(m.zjbh) && m.zjsm) sm = m.zjsm;
    return sm;
  };

  const des = de.prepare(`SELECT * FROM ${p}_de ORDER BY fid`).all() as unknown as DeRow[];
  console.log(`${p}_de(${label}) 定额子目: ${des.length} 条`);

  // 4) Dataset（幂等：同名先删后建）
  const DS_NAME = `四川省2020建设工程工程量清单计价定额·${label}（N10导入）`;
  const old = await prisma.dataset.findFirst({ where: { name: DS_NAME } });
  if (old) {
    await prisma.quotaRow.deleteMany({ where: { datasetId: old.id } });
    await prisma.dataset.delete({ where: { id: old.id } });
  }
  const ds = await prisma.dataset.create({
    data: {
      kind: "QUOTA",
      name: DS_NAME,
      filename: "ZY_N3QD_SC21/ZY_ZJXQDB2022_SC21 + DE_SC21",
      storageKey: `n10://DATABASE/SC21/${p}`,
      status: "PARSED",
      rowCount: des.length,
      meta: JSON.stringify({
        source: "清单计价专家N10",
        edition: "四川2020",
        book: p,
        divisions: [...fbMap.values()],
        note: "DE_SC21 真2020清单定额（SC20=四川2000定额，勿混用）；含清单编码映射与未计价材料耗量",
      }),
    },
  });

  // 5) 逐条转换 + 批量入库
  let withMain = 0, withXmbh = 0;
  const rows = des.map((r) => {
    const scale = unitScale(r.dw);
    const bu = baseUnit(r.dw);

    const yls = (ylMap.get(r.debh) ?? [])
      .map((y) => ({ ...y, cl: clMap.get(y.clbh) }))
      .filter((y) => y.cl?.clmc);
    const materials = yls.map((y) => ({
      name: y.cl!.clmc,
      unit: y.cl!.cldw ?? "",
      qtyPerUnit: Number((y.clyl / scale).toFixed(4)),
    }));
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
    const codes = new Set(codeMap.get(r.debh) ?? []);
    // 章节树编码兜底：zjbh 前缀命中的 ml 节点（取最深=最后匹配的）
    if (r.zjbh) {
      for (const m of mlCode) if (r.zjbh.startsWith(m.zjbh)) codes.add(m.code);
    }
    if (codes.size) withXmbh++;
    const matchKeys: Record<string, string> = {};
    if (f.category) matchKeys.category = f.category;
    if (f.material) matchKeys.material = f.material;
    if (f.diameter) matchKeys.diameter = f.diameter;
    if (f.specification) matchKeys.spec = f.specification;
    if (f.connectionMethod) matchKeys.connection = f.connectionMethod;
    if (f.system) matchKeys.system = f.system;
    if (mainName) matchKeys.keywords = mainName;
    if (codes.size) matchKeys.xmbh = [...codes].join(",");

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
        // SC21 特有：定额带的管理费/利润单价与条文附注
        glf: r.glf ?? 0, lr: r.lr ?? 0,
        qtsm: r.qtsm ?? "", jsgz: r.jsgz ?? "", mlsm: mlSmOf(r.zjbh),
      }),
      materials: JSON.stringify(materials),
    };
  });

  for (let i = 0; i < rows.length; i += 500)
    await prisma.quotaRow.createMany({ data: rows.slice(i, i + 500) });

  console.log(`  导入完成: ${rows.length} 条 | 含主材耗量 ${withMain} | 含清单编码映射 ${withXmbh} | Dataset: ${ds.id}`);
}

async function main() {
  const only = process.argv[2];
  const de = new DatabaseSync(DE_DB, { readOnly: true });
  const zys = ZY_DBS.map((f) => new DatabaseSync(f, { readOnly: true }));
  const books = Object.entries(BOOKS)
    .filter(([p]) => tableExists(de, `${p}_de`))
    .filter(([p]) => !only || only === "all" || p === only);
  for (const [p, label] of books) await importBook(zys, de, p, label);
  // 旧 2000 库遗留数据集（SC21 无对应册，避免双版本并存污染匹配）
  for (const name of STALE_DATASETS) {
    const old = await prisma.dataset.findFirst({ where: { name } });
    if (old) {
      await prisma.quotaRow.deleteMany({ where: { datasetId: old.id } });
      await prisma.dataset.delete({ where: { id: old.id } });
      console.log(`删除遗留数据集: ${name}`);
    }
  }
  zys.forEach((z) => z.close());
  de.close();
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
