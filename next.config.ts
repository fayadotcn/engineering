import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client", "exceljs"],
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
