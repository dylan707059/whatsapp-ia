"use client";

import { useEffect, useState } from "react";

interface StatusResponse {
  status: string;
  qrPng?: string;
  phone?: string;
  updatedAt?: number;
}

interface Props {
  onConnected: (phone: string) => void;
}

export default function QRScreen({ onConnected }: Props) {
  const [status, setStatus] = useState<string>("disconnected");
  const [qrPng, setQrPng] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [stuckSeconds, setStuckSeconds] = useState(0);

  useEffect(() => {
    let stuckInterval: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      try {
        const res = await fetch("/api/connection/status");
        const data = await res.json() as StatusResponse;

        setStatus(data.status);
        setUpdatedAt(data.updatedAt ?? null);

        if (data.status === "qr" && data.qrPng) {
          setQrPng(data.qrPng);
          setStuckSeconds(0);
        } else if (data.status === "connected" && data.phone) {
          onConnected(data.phone);
          return;
        }
      } catch {}
    };

    const pollTimer = setInterval(poll, 2000);
    poll();

    stuckInterval = setInterval(() => {
      setStuckSeconds((s) => s + 1);
    }, 1000);

    return () => {
      clearInterval(pollTimer);
      if (stuckInterval) clearInterval(stuckInterval);
    };
  }, [onConnected]);

  useEffect(() => {
    setStuckSeconds(0);
  }, [updatedAt]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "32px 20px",
        gap: 24
      }}
    >
      {/* Logo Eclipse */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            width: 32, height: 32, borderRadius: 7,
            background: "var(--accent)",
            color: "#fff",
            display: "grid", placeItems: "center",
            fontWeight: 700, fontSize: 14
          }}
        >
          E
        </div>
        <span style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", letterSpacing: "-0.01em" }}>
          Eclipse
        </span>
      </div>

      <div style={{ textAlign: "center", maxWidth: 340 }}>
        <h1
          style={{
            margin: 0,
            fontSize: 22,
            fontWeight: 600,
            color: "var(--text)",
            letterSpacing: "-0.01em"
          }}
        >
          Conectar WhatsApp
        </h1>
        <p style={{ margin: "10px 0 0", fontSize: 13.5, color: "var(--text-muted)", lineHeight: 1.55 }}>
          Abrí WhatsApp en tu teléfono, andá a{" "}
          <strong style={{ color: "var(--text)" }}>Ajustes → Dispositivos vinculados</strong>{" "}
          y escaneá el código.
        </p>
      </div>

      {/* QR card */}
      <div
        style={{
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: 24,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 16
        }}
      >
        {qrPng ? (
          <div
            style={{
              background: "#fff",
              padding: 16,
              borderRadius: 10
            }}
          >
            <img
              src={qrPng}
              alt="Código QR de WhatsApp"
              style={{ width: 256, height: 256, display: "block" }}
            />
          </div>
        ) : (
          <div
            style={{
              width: 288, height: 288,
              display: "grid", placeItems: "center",
              background: "var(--bg-elev-2)",
              borderRadius: 10
            }}
          >
            <div
              style={{
                width: 28, height: 28,
                border: "3px solid var(--border-strong)",
                borderTopColor: "var(--accent)",
                borderRadius: "50%",
                animation: "spin 0.8s linear infinite"
              }}
            />
          </div>
        )}

        {/* Estado */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {status === "qr" && (
            <>
              <span
                className="pulse-dot"
                style={{
                  width: 8, height: 8, borderRadius: "50%",
                  background: "var(--warning)"
                }}
              />
              <span style={{ fontSize: 13, color: "var(--warning)" }}>
                Esperando escaneo...
              </span>
            </>
          )}
          {status === "connecting" && (
            <>
              <span
                className="pulse-dot"
                style={{
                  width: 8, height: 8, borderRadius: "50%",
                  background: "var(--accent)"
                }}
              />
              <span style={{ fontSize: 13, color: "var(--accent)" }}>
                Conectando...
              </span>
            </>
          )}
          {status === "disconnected" && (
            <>
              <div
                style={{
                  width: 14, height: 14,
                  border: "2px solid var(--border-strong)",
                  borderTopColor: "var(--text-muted)",
                  borderRadius: "50%",
                  animation: "spin 0.8s linear infinite"
                }}
              />
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
                Iniciando bot...
              </span>
            </>
          )}
        </div>
      </div>

      {status === "disconnected" && !qrPng && stuckSeconds > 30 && (
        <div
          style={{
            background: "var(--danger-soft)",
            border: "1px solid var(--danger)",
            borderRadius: "var(--radius)",
            padding: "12px 16px",
            maxWidth: 320,
            textAlign: "center"
          }}
        >
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--danger)" }}>
            El bot tardó más de lo esperado en iniciar.
            <br />
            Recargá la página o revisá los logs del servidor.
          </p>
        </div>
      )}

      <style jsx>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
