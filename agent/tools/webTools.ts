import { z } from "zod";
import { registerTool } from "./registry";
import { askModel } from "../llm";

// 联网检索兜底：本地定额手册（spec.search）查不到口径时的第二信源。
// DuckDuckGo lite 端点无需 API key；只读不回写，不受确认门约束。
// 网络不可达时退化到模型自带知识（配置了模型才有），口径仍标注为参考性。

const stripTags = (s: string) =>
  s.replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();

function unwrapDdgHref(href: string): string {
  try {
    const u = new URL(href.startsWith("//") ? `https:${href}` : href, "https://duckduckgo.com");
    return u.searchParams.get("uddg") ?? u.toString();
  } catch {
    return href;
  }
}

export function parseDdgLite(html: string, limit = 5) {
  const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)]
    .filter((m) => /class\s*=\s*["']?result-link/.test(m[1]))
    .map((m) => ({ text: m[2], href: m[1].match(/href\s*=\s*["']([^"']+)/)?.[1] ?? "" }));
  const snippets = [...html.matchAll(/<td[^>]+class=["']?result-snippet["']?[^>]*>([\s\S]*?)<\/td>/g)];
  return links.slice(0, limit).map((m, i) => ({
    title: stripTags(m.text),
    url: unwrapDdgHref(m.href),
    snippet: stripTags(snippets[i]?.[1] ?? ""),
  })).filter((r) => r.title && /^https?:/.test(r.url));
}

export async function webSearch(query: string, limit = 5) {
  const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseDdgLite(await res.text(), limit);
}

registerTool({
  name: "web.search",
  description:
    "联网检索造价信息（定额口径/计算规则/材料价/规范条文）——本地定额手册 spec.search 查不到时的兜底信源；联网失败时自动退化到模型自带知识作答（有配置模型时）。结果只供参考，不写回任何数据",
  implemented: true,
  schema: z.object({
    query: z.string().describe("检索词，如「四川2020定额 卫生器具 计算规则」「UPVC管 DN100 综合单价」"),
    limit: z.number().optional(),
  }),
  handler: async (_ctx, args: { query: string; limit?: number }) => {
    try {
      const results = await webSearch(args.query, args.limit ?? 5);
      return {
        observation: { query: args.query, results },
        message: results.length
          ? `联网检索到 ${results.length} 条结果（仅供参考，定额口径以本地定额说明为准）`
          : "联网没有检索到相关结果",
      };
    } catch (e) {
      // 断网退化链：web 失败 → 模型自带知识（配置了模型才走）→ 都不可用才报失败
      const answer = await askModel(
        `你是安装工程造价专家，熟悉中国各省份清单计价定额体系（尤其四川2020定额）。` +
        `用户查不到本地资料时向你提问，请基于你的专业知识直接作答。` +
        `要求：给出结论和依据要点；拿不准的明确说「不确定」；不要编造具体定额编号/条文号；中文简洁。`,
        args.query
      );
      if (answer) {
        return {
          observation: { query: args.query, results: [], source: "llm-knowledge", answer },
          message: "联网检索失败，以下为模型自带知识作答（参考性，定额口径仍以本地定额说明手册为准）",
        };
      }
      return {
        observation: { query: args.query, results: [], error: String(e) },
        message: "联网检索失败且未配置模型知识兜底，可先查本地定额手册或人工核实",
      };
    }
  },
});
