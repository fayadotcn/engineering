import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/ui/primitives";
import { TooltipProvider } from "@/components/ui/tooltip";

/* 只取 Latin 子集（含 tabular figures）：本项目数字密集，Inter 的等宽数字比系统字体整齐；
   中文仍走系统字体——CJK webfont 动辄数 MB，不值得为一点点字形差异付这个代价。 */
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "安装造价工作台",
  description: "安装工程造价工作台：资料、清单、主材询价、定额组价与费用审核",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className={inter.variable} suppressHydrationWarning>
      <body>
        {/* 首帧前落定 data-theme，避免深色用户看到一次浅色闪烁；
            同时挂系统偏好与跨页签同步监听（auto 档才受系统变化影响） */}
        <script
          dangerouslySetInnerHTML={{
            __html: `!function(){var m=matchMedia("(prefers-color-scheme: dark)");function a(){var c="auto";try{c=localStorage.getItem("cost-theme")||"auto"}catch(e){}document.documentElement.dataset.theme=c==="dark"||c==="auto"&&m.matches?"dark":"light"}a();try{m.addEventListener("change",a);addEventListener("storage",function(e){e.key==="cost-theme"&&a()})}catch(e){}}()`,
          }}
        />
        {/* Radix Tooltip 必须有 Provider 祖先；工作区各视图的说明性提示统一走 Tooltip */}
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster />
      </body>
    </html>
  );
}
