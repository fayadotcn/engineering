import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
          "**/prisma/dev.db*",
          "**/storage/**",
          "**/.verify/**",
          "**/fixtures/out/**",
        ],
      };
    }
    return config;
  },
};

export default nextConfig;
