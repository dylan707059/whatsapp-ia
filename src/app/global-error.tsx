"use client";

import { useEffect } from "react";

export default function GlobalError({ error }: { error: Error }) {
  useEffect(() => {
    // Chunks viejos en cache después de un redeploy → recargar para obtener HTML fresco
    if (
      error.name === "ChunkLoadError" ||
      error.message.includes("Loading chunk") ||
      error.message.includes("Failed to fetch")
    ) {
      window.location.reload();
    }
  }, [error]);

  return (
    <html lang="es">
      <body style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "sans-serif", color: "#666" }}>
        <p>Cargando...</p>
      </body>
    </html>
  );
}
