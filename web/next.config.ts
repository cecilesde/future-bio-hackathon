import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A stray package-lock.json in the home dir makes Next emit a workspace-root
  // inference warning. It is cosmetic and the build handles it correctly, so we
  // do not override turbopack.root here (doing so crashed the dev server).
};

export default nextConfig;
