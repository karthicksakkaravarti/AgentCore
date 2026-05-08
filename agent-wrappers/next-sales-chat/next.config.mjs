import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentCoreEntry = path.resolve(__dirname, "../../agent-core/dist/index.js");

/** @type {import("next").NextConfig} */
const nextConfig = {
  webpack(config) {
    config.resolve ??= {};
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "@agent-core/core": agentCoreEntry,
    };
    return config;
  },
};

export default nextConfig;
