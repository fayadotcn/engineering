import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client", "exceljs", "pdfjs-dist"],
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
