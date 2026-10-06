import { nameBigrams } from "@cost-engine/quota";
import type { QuotaEntry } from "./library";

/** 定额说明章节正文：按定额 detail.fb（册）+ detail.chapter（章）用 bigram 桥接
 *  SpecSection.book/title 同源词汇（都出自定额体系），取交集命中节的正文合并。 */
export async function specTextsFor(quotas: QuotaEntry[]): Promise<Record<string, string>> {
  const { prisma } = await import("@database/client");
  const secs = await prisma.specSection.findMany({ select: { book: true, title: true, content: true, source: true } });
  const out: Record<string, string> = {};
  // 语料权重：2020定额说明为主依据，2015手册为参考，GB清单项库不参与章节正文匹配
  const srcW = (s: string) => (s === "sc2020" ? 3 : s === "sc2015" ? 1.6 : 0.3);
  for (const q of quotas) {
    const fb = q.detail?.fb ?? "", ch = q.detail?.chapter ?? "";
    if (!fb && !ch) continue;
    const key = `${fb}|${ch}`;
    if (key in out) continue;
    const fbB = nameBigrams(fb), chB = nameBigrams(ch);
    // 命中节排序：册名 bigram 权重最高、章节标题次之、正文命中仅作弱证据。
    // 「设备|安装|工程」这类泛词会让机械/热力册误命中（5G消防章曾拉到 C.A 册正文，
    // 30k 截断把真正的 C.J.1 条文挤掉）——按相关性定序、只取前几节再截断。
    const hit = secs
      .map((s) => {
        const sB = nameBigrams(s.book), tB = nameBigrams(s.title);
        let fbHit = 0, chHit = 0, titleHit = 0;
        for (const b of fbB) if (sB.has(b)) fbHit++;
        for (const b of chB) {
          if (tB.has(b)) { chHit++; titleHit++; }
          else if (s.content.includes(b)) chHit++;
        }
        const sc = (fbHit * 2 + titleHit * 2 + Math.min(chHit - titleHit, 4) * 0.25) * srcW(s.source);
        return { s, ok: fbHit >= 1 && chHit >= 1, sc };
      })
      .filter((h) => h.ok)
      .sort((a, b) => b.sc - a.sc || a.s.book.localeCompare(b.s.book, "zh") || a.s.title.localeCompare(b.s.title, "zh"))
      .slice(0, 3)
      .map((h) => h.s);
    // 同一章节 2020/2015 版条文常近乎相同——按内容签名去重，避免挤占截断额度
    const seen = new Set<string>();
    out[key] = hit
      .filter((s) => { const sig = s.content.slice(0, 200); if (seen.has(sig)) return false; seen.add(sig); return true; })
      .map((s) => s.content).join("\n").slice(0, 30000);
  }
  return out;
}
/** 定额手册核查方向：按名称 bigram 在 SpecSection 标题/册名里定位「该查哪册哪章」。
 *  未匹配项给出查询方向、歧义项给出条文依据位置——local 手册查不到再交 web.search。 */
export async function specHints(queries: string[]) {
  if (!queries.length) return new Map<string, { book: string; title: string }>();
  const { prisma } = await import("@database/client");
  const secs = await prisma.specSection.findMany({ select: { book: true, title: true, content: true, source: true } });
  // 分册体量作决胜项：主手册（建筑与装饰等）章节多于仿古/修缮册，同分指到更通用的册；
  // 2020 定额说明优先于 2015 手册（同分时主用版条文为先）
  const bookSize = new Map<string, number>();
  for (const s of secs) bookSize.set(s.book, (bookSize.get(s.book) ?? 0) + 1);
  const out = new Map<string, { book: string; title: string }>();
  for (const q of queries) {
    const bs = nameBigrams(q);
    let titleBest: { book: string; title: string; tW: number } | null = null;
    let bodyBest: { book: string; title: string; cW: number } | null = null;
    for (const s of secs) {
      const size = bookSize.get(s.book) ?? 0;
      let tHit = 0;
      for (const b of bs) if (`${s.title} ${s.book}`.includes(b)) tHit++;
      const tW = tHit * 100 + size + (s.source === "sc2020" ? 50 : s.source === "sc2015" ? 25 : 0);
      if (tHit && (!titleBest || tW > titleBest.tW))
        titleBest = { book: s.book, title: s.title, tW };
      let cHit = 0;
      for (const b of bs) if (s.content.includes(b)) cHit++;
      const cW = cHit * 100 + size + (s.source === "sc2020" ? 50 : s.source === "sc2015" ? 25 : 0);
      if (cHit && (!bodyBest || cW > bodyBest.cW))
        bodyBest = { book: s.book, title: s.title, cW };
    }
    const best = titleBest ?? bodyBest;
    if (best) out.set(q, { book: best.book, title: best.title });
  }
  return out;
}
export async function searchSpecs(args: { query: string; book?: string }) {

  const { prisma } = await import("@database/client");
  const secs = await prisma.specSection.findMany({
    where: args.book ? { book: { contains: args.book } } : undefined,
  });
  // 关键词：空格/顿号切分 + 对整串做 2~4 字滑窗（"沟槽连接管道"→沟槽/连接/管道…）
  const terms = new Set<string>();
  for (const w of args.query.split(/[\s,，、]+/).filter(Boolean)) {
    terms.add(w);
    for (let len = 2; len <= Math.min(4, w.length); len++)
      for (let i = 0; i + len <= w.length; i++) terms.add(w.slice(i, i + len));
  }
  // 语料权重：2020定额说明(3) > 2015手册参考(1.6) > GB清单项库(1)
  const srcW = (s: string) => (s === "sc2020" ? 3 : s === "sc2015" ? 1.6 : 1);
  const scored = secs
    .map((s) => {
      let sc = 0;
      for (const k of terms) {
        const occ = (s.content.split(k).length - 1) + (s.title.includes(k) ? 6 : 0) + (s.book.includes(k) ? 3 : 0);
        sc += Math.min(occ, 8) * k.length; // 长词权重高
      }
      return { s, sc: sc * srcW(s.source) };
    })
    .filter((x) => x.sc > 0)
    // 同分按册/标题定序——同一检索词多次命中结果可复现
    .sort((a, b) => b.sc - a.sc || a.s.book.localeCompare(b.s.book, "zh") || a.s.title.localeCompare(b.s.title, "zh"))
    .slice(0, 3);
  const SRC_TAG: Record<string, string> = { sc2020: "20定额说明", sc2015: "15定额手册", qd: "GB清单项" };
  const hits = scored.map(({ s }) => {
    // 截取首个关键词附近的条文片段
    let idx = -1;
    // 用最长的词定位摘录起点，最可能落在关键句
    for (const k of [...terms].sort((a, b) => b.length - a.length)) {
      idx = s.content.indexOf(k);
      if (idx >= 0) break;
    }
    const start = Math.max(0, (idx < 0 ? 0 : idx - 60));
    return {
      book: s.book, title: s.title,
      source: s.source, sourceLabel: SRC_TAG[s.source] ?? s.source,
      excerpt: s.content.slice(start, start + 700),
    };
  });

  return { total: secs.length, hits };
}

/** 清单编码 → GB 清单项规范条目（工程内容/计算规则/项目特征，source=qd）。
 *  组价完整性核对用：定额组价方案应覆盖清单项工程内容列出的工序。 */
export async function qdItemsFor(codes: string[]): Promise<{ code: string; title: string; content: string }[]> {
  const wanted = [...new Set(codes.map((c) => c.trim()).filter((c) => /^\d{6,12}$/.test(c)))];
  if (!wanted.length) return [];
  const { prisma } = await import("@database/client");
  const secs = await prisma.specSection.findMany({
    where: { source: "qd", OR: wanted.map((c) => ({ title: { startsWith: c } })) },
    select: { title: true, content: true },
  });
  return wanted
    .map((c) => secs.find((s) => s.title.startsWith(c)))
    .filter((s): s is { title: string; content: string } => !!s)
    .map((s) => ({ code: s.title.split(" ")[0], title: s.title, content: s.content }));
}
