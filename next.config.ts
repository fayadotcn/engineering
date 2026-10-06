import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const nextConfig = (phase: string): NextConfig => ({
  // 开发与正式构建独立输出，避免运行中的服务读到另一套 webpack 文件。
  distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next",
  serverExternalPackages: ["@prisma/client", "exceljs", "pdfjs-dist"],
  outputFileTracingRoot: __dirname,
  devIndicators: false,
  webpack: (config, { dev }) => {
    // dev.db / storage/ / .verify/ / fixtures 的产物全在项目树内：
    // 每次写库、上传文件、跑 e2e 都触发 watcher 失效→整页重编译，越用越慢。
    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        ignored: [
          "**/node_modules/**",
          "**/.git/**",
          "**/.next/**",
          "**/.next-dev/**",
          "**/prisma/dev.db*",
          "**/storage/**",
          "**/.verify/**",
          "**/fixtures/out/**",
        ],
      };
    }
    return config;
  },
});

export default nextConfig;
