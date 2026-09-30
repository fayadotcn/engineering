import type { NextConfig } from "next";
import { HARNESS_ORIGIN } from "./shared/cors";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client", "exceljs", "pdfjs-dist"],
  outputFileTracingRoot: __dirname,
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Harness 主入口（3210）直接读项目状态：导入摘要、待确认与结果卡片都走这条通道。
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: HARNESS_ORIGIN },
          { key: "Access-Control-Allow-Methods", value: "GET,POST,PATCH,DELETE,OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "content-type" },
          { key: "Vary", value: "Origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
