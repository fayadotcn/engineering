import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@/ui/primitives";
import { HarnessBridge } from "@/ui/HarnessBridge";

export const metadata: Metadata = {
  title: "安装造价工作台",
  description: "DeepSeek Harness 安装工程造价工作台：资料、清单、主材询价、定额组价与费用审核",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <HarnessBridge />
        {children}
        <Toaster />
      </body>
    </html>
  );
}
