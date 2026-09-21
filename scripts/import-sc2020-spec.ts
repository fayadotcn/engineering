// 提取《2020定额说明及计算规则.pdf》→ SpecSection 条文库
// 结构：册("A房屋建筑与装饰工程说明及计算规则"/"C.G通风空调工程")
//       → 分部("A土石方工程"/"C.G.1通风空调设备及部件") → 说明 + 工程量计算规则
// 用法: npx tsx scripts/import-sc2020-spec.ts
import { readFileSync } from "fs";
import { prisma } from "@database/client";
import { extractPdfText } from "@file/pdf";

const PDF = "C:/Program Files/清单计价专家N10/HELP/2020定额说明及计算规则.pdf";

const PAGE_HEADER = /^20\d{2}\s*定额说明及计算规则\s*\d*$/;
const TOC_LEADER = /\.{6,}/;
// 册级：双字母前缀(C.G通风空调工程) 或 带"说明及计算规则"后缀(A房屋建筑与装饰工程…)
const BOOK_RE = /^[A-Z]\.[A-Z]\s*[一-龥、]+\s*工程\s*$|^[A-Z]?\s*[一-龥、]+工程\s*说明及计算规/;
// 分部级：C.G.1通风空调设备及部件 | A土石方工程
const DIV_DOT_RE = /^[A-Z]\.[A-Z]\.\d+\s*[一-龥、\s]+/;
const DIV_RE = /^[A-Z][一-龥、]{2,25}工程$/;
// 节内小标题
const SUB_RE = /^(册说明|分册说明|说明|工程量计算规则|建筑面积计算规则)$/;

async function main() {
  const pages = await extractPdfText(readFileSync(PDF));
  console.log(`PDF ${pages.length} 页`);

  interface Sec { book: string; title: string; content: string[] }
  const secs: Sec[] = [];
  let book = "总说明";
  let cur: Sec | null = null;
  const push = () => {
    if (cur && cur.content.join("").length > 30) secs.push(cur);
    cur = null;
  };
  const startSec = (title: string) => { push(); cur = { book, title, content: [] }; };

  for (let pi = 0; pi < pages.length; pi++) {
    for (const raw of pages[pi].split("\n")) {
      let line = raw.trim();
      if (!line || PAGE_HEADER.test(line)) continue;
      line = line.replace(/^\d{1,3}\s+/, ""); // 粘连页码
      const sq = line.replace(/\s+/g, ""); // PDF 文本碎片带空格，标题判定用压扁文本
      if (!sq || TOC_LEADER.test(sq)) continue; // 目录行：压扁后是连续点线+页码

      if (BOOK_RE.test(sq)) {
        push();
        book = sq;
        cur = { book, title: "册说明", content: [] };
        continue;
      }
      if (DIV_DOT_RE.test(sq) || DIV_RE.test(sq)) {
        startSec(sq);
        continue;
      }
      if (SUB_RE.test(sq)) {
        // 分部内的"工程量计算规则"等：并入当前节，标题留痕
        if (cur) cur.content.push(`【${sq}】`);
        else cur = { book, title: sq, content: [] };
        continue;
      }
      if (!cur) cur = { book, title: "册说明", content: [] };
      // 逐字散排的页：CJK 字符间的空格是排版噪声，压掉；拉丁/数字间保留
      cur.content.push(
        line
          .replace(/([一-龥，。、；：（）【】《》""])\s+/g, "$1")
          .replace(/\s+([一-龥，。、；：（）【】《》""])/g, "$1")
      );
    }
  }
  push();

  console.log(`分节 ${secs.length} 个`);
  console.log("册:", [...new Set(secs.map((s) => s.book))].slice(0, 20).join(" | "));

  await prisma.specSection.deleteMany({});
  await prisma.specSection.createMany({
    data: secs.map((s, i) => ({
      book: s.book,
      title: s.title,
      content: s.content.join("\n").slice(0, 12000),
      orderIdx: i,
    })),
  });
  console.log("已入库", secs.length, "条");
  for (const s of secs.filter((x) => /通风|管道|消防/.test(x.title)).slice(0, 3))
    console.log(`\n[${s.book}] ${s.title}\n${s.content.join("\n").slice(0, 150)}…`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
