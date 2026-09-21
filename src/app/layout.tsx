import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@/ui/primitives";

export const metadata: Metadata = {
  title: "造价 Agent",
  description: "对话即造价 — Agent Native 安装工程造价",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
