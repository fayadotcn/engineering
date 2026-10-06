// 一次性导入：四川2015定额手册（CHM 解包出的 htm）→ SpecSection(source=sc2015)
// 解包：hh.exe -decompile <目标目录> "HELP/2015定额说明及计算规则.CHM"（纯 ASCII 路径，中文路径会静默失败）
// 用法: npx tsx scripts/import-sc2015-spec.ts [chm解包目录，默认 C:/tmp/chm15]
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { prisma } from "@database/client";

const ROOT = process.argv[2] ?? "C:/tmp/chm15";
const BOOK_SUFFIX = "说明及计算规则";

function htmlToText(buf: Buffer): string {
  let t = new TextDecoder("gb18030").decode(buf);
  t = t.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(style|script|xml)[\s\S]*?<\/\1>/gi, "")
    .replace(/<o:p>?\s*<\/o:p>/gi, "")
    .replace(/<\/(p|tr|div|h\d|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&[a-z#0-9]+;/gi, " ");
  return t.split(/\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 1 && !/^[\d\s.\-_*#=|]+$/.test(s))
    .join("\n");
}

interface Sec { book: string; title: string; content: string }
const secs: Sec[] = [];

function collect(dir: string, book: string) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name.endsWith(".files") || name === "图片") continue;
      // 子目录 = 分册（如「C.J 消防工程」）——册名取子目录名
      collect(full, name);
      continue;
    }
    if (!/\.html?$/i.test(name) || /^filelist|header|index/i.test(name)) continue;
    const content = htmlToText(readFileSync(full));
    if (content.length < 30) continue;
    secs.push({ book, title: name.replace(/\.html?$/i, "").trim(), content });
  }
}

async function main() {
  for (const name of readdirSync(ROOT)) {
    const full = join(ROOT, name);
    if (!statSync(full).isDirectory()) continue;
    // 顶层目录：「C 通用安装工程说明及计算规则」→ 册名去后缀；无后缀的目录直接以其名
    const book = name.endsWith(BOOK_SUFFIX) ? name.slice(0, -BOOK_SUFFIX.length).trim() : name;
    collect(full, book);
  }
  console.log(`分节 ${secs.length} 个`);
  console.log("册:", [...new Set(secs.map((s) => s.book))].join(" | "));

  await prisma.specSection.deleteMany({ where: { source: "sc2015" } });
  await prisma.specSection.createMany({
    data: secs.map((s, i) => ({ book: s.book, title: s.title, content: s.content.slice(0, 12000), source: "sc2015", orderIdx: i })),
  });
  console.log("已入库", secs.length, "条 (source=sc2015)");
  const cj = secs.find((s) => /消防/.test(s.book) && /水灭火/.test(s.title));
  if (cj) console.log(`\n[${cj.book}] ${cj.title}\n${cj.content.slice(0, 200)}…`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
