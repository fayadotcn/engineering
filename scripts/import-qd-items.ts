// 一次性导入：宏业清单项目库（XM_N3QD.db3）→ SpecSection(source=qd)
// 这是 GB50500 口径的清单编码级规范条目：debh=清单编码、xmmc=项目名称、
//   gcnr=工程内容（组价必须覆盖的工序清单）、jsgz=工程量计算规则、xmtz=项目特征。
// title 用「清单编码 项目名称」，检索时按编码前缀或名称命中。
// 用法: npx tsx scripts/import-qd-items.ts
import { DatabaseSync } from "node:sqlite";
import { prisma } from "@database/client";

const XM_DB = "C:/Program Files (x86)/宏业软件/工程总承包计价专家/DAT/XM_N3QD.db3";

const BOOKS: Record<string, string> = {
  az: "安装", tj: "房屋建筑", sz: "市政", fg: "仿古", yl: "园林绿化",
  ks: "矿山", gd: "轨道交通", gz: "构筑物", bp: "爆破",
};

interface QdRow { debh: string; xmmc: string; dw: string; gcnr: string; jsgz: string; xmtz: string }

const clean = (s: string | null) => String(s ?? "").replace(/\r/g, "").split("\n").map((x) => x.trim()).filter(Boolean).join("；");

async function main() {
  const db = new DatabaseSync(XM_DB, { readOnly: true });
  // 项目特征描述示例：xmbh(12位) → 描述文本
  const tzMap = new Map<string, string[]>();
  try {
    for (const r of db.prepare("SELECT Xmbh, Xmtz FROM xmtz_ms WHERE Xmtz != ''").all() as { Xmbh: string; Xmtz: string }[]) {
      const key = String(r.Xmbh).slice(0, 9);
      if (!tzMap.has(key)) tzMap.set(key, []);
      tzMap.get(key)!.push(clean(r.Xmtz));
    }
  } catch { /* xmtz_ms 可选 */ }

  const secs: { book: string; title: string; content: string }[] = [];
  for (const [p, label] of Object.entries(BOOKS)) {
    const has = (db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name=?").get(`${p}_de`) as { c: number }).c;
    if (!has) continue;
    const rows = db.prepare(`SELECT debh, xmmc, dw, gcnr, jsgz, xmtz FROM ${p}_de ORDER BY fid`).all() as unknown as QdRow[];
    for (const r of rows) {
      const parts: string[] = [];
      if (clean(r.gcnr)) parts.push(`工程内容：${clean(r.gcnr)}`);
      if (clean(r.jsgz)) parts.push(`计算规则：${clean(r.jsgz)}`);
      if (clean(r.xmtz)) parts.push(`项目特征：${clean(r.xmtz)}`);
      const tz = tzMap.get(r.debh.slice(0, 9));
      if (tz?.length) parts.push(`特征描述示例：${tz.join("；").slice(0, 800)}`);
      if (!parts.length) continue;
      secs.push({
        book: `GB清单·${label}`,
        title: `${r.debh.trim()} ${r.xmmc.trim()}`,
        content: parts.join("\n"),
      });
    }
    console.log(`${p}_de(${label}): ${rows.length} 条`);
  }
  db.close();

  await prisma.specSection.deleteMany({ where: { source: "qd" } });
  await prisma.specSection.createMany({
    data: secs.map((s, i) => ({ book: s.book, title: s.title, content: s.content.slice(0, 4000), source: "qd", orderIdx: i })),
  });
  console.log(`已入库 ${secs.length} 条 (source=qd)`);
  const s = secs.find((x) => x.title.startsWith("031001001"));
  if (s) console.log(`\n[${s.book}] ${s.title}\n${s.content.slice(0, 300)}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
