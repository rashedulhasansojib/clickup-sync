import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Produce a self-contained server bundle for Docker:
  // .next/standalone/apps/web/server.js + traced node_modules.
  output: "standalone",

  // Root file tracing at the monorepo root so the standalone output includes
  // workspace files (e.g. the @ma/shared package). Without this, tracing is
  // rooted at apps/web and can drop hoisted/workspace deps.
  outputFileTracingRoot: path.join(__dirname, "../../"),

  // @ma/shared ships TS source consumed directly by the web app.
  transpilePackages: ["@ma/shared"],
};

export default nextConfig;
