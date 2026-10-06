import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["ioredis", "bcryptjs", "@prisma/client"],
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
