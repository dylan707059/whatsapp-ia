import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@whiskeysockets/baileys",
    "better-sqlite3",
    "pino"
  ],
  async headers() {
    return [
      {
        // Evita que el browser cachee el HTML — los chunks cambian en cada deploy
        source: "/((?!_next/static|_next/image|favicon.ico).*)",
        headers: [{ key: "Cache-Control", value: "no-cache, must-revalidate" }]
      }
    ];
  }
};

export default nextConfig;
