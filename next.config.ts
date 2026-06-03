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
  },
  async rewrites() {
    return [
      // Servir el index.html de /public/mockups/ cuando el user entra a
      // /mockups o /mockups/ (Next.js no resuelve index.html automáticamente
      // en directorios bajo /public/).
      { source: "/mockups", destination: "/mockups/index.html" },
      { source: "/mockups/", destination: "/mockups/index.html" }
    ];
  }
};

export default nextConfig;
