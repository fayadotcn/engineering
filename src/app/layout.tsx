import type { Metadata } from "next";
import { Inter, Noto_Serif_SC } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/ui/primitives";
import { TooltipProvider } from "@/components/ui/tooltip";

/* 只取 Latin 子集（含 tabular figures）：本项目数字密集，Inter 的等宽数字比系统字体整齐；
   中文仍走系统字体——CJK webfont 动辄数 MB，不值得为一点点字形差异付这个代价。 */
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
/* 大标题衬线：思源宋体（公文标题气质）。chinese-simplified 不在可预加载子集里，
   preload:false 让 full css 生效——CJK 按 unicode-range 分片，浏览器只拉用到的片；
   只服务 --font-display 的 hero/页级标题，正文不加载。加载失败静默落到系统衬线栈。 */
const notoSerif = Noto_Serif_SC({ preload: false, variable: "--font-noto-serif", display: "swap" });

export const metadata: Metadata = {
  title: "安装造价工作台",
  description: "安装工程造价工作台：资料、清单、主材询价、定额组价与费用审核",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className={`${inter.variable} ${notoSerif.variable}`} suppressHydrationWarning>
      <body>
        {/* 首帧前落定 data-theme：未选过时默认浅色（蓝白政府风是产品默认面貌），
            选过 auto 才跟系统偏好；深色/跟随系统仍可手动切换。监听系统偏好与跨页签同步。 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `!function(){var m=matchMedia("(prefers-color-scheme: dark)");function a(){var c="light";try{c=localStorage.getItem("cost-theme")||"light"}catch(e){}document.documentElement.dataset.theme=c==="dark"||c==="auto"&&m.matches?"dark":"light"}a();try{m.addEventListener("change",a);addEventListener("storage",function(e){e.key==="cost-theme"&&a()})}catch(e){}}()`,
          }}
        />
        {/* Radix Tooltip 必须有 Provider 祖先；工作区各视图的说明性提示统一走 Tooltip */}
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster />
      </body>
    </html>
  );
}
