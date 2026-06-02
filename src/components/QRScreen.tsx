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

    // Contador para detectar estado disconnected prolongado
    stuckInterval = setInterval(() => {
      setStuckSeconds((s) => s + 1);
    }, 1000);

    return () => {
      clearInterval(pollTimer);
      if (stuckInterval) clearInterval(stuckInterval);
    };
  }, [onConnected]);

  // Resetear contador cuando hay actividad
  useEffect(() => {
    setStuckSeconds(0);
  }, [updatedAt]);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-2xl font-bold text-gray-800">Conectar número</h1>
      <p className="text-sm text-gray-500 text-center max-w-xs">
        Abre WhatsApp en tu teléfono, ve a{" "}
        <strong>Dispositivos vinculados</strong> y escanea el código QR.
      </p>

      {/* QR image */}
      <div className="bg-white rounded-2xl shadow-md p-6 flex flex-col items-center gap-4">
        {qrPng ? (
          <img
            src={qrPng}
            alt="Código QR de WhatsApp"
            className="w-64 h-64"
          />
        ) : (
          <div className="w-64 h-64 flex items-center justify-center bg-gray-100 rounded-xl">
            <div className="w-8 h-8 border-4 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
          </div>
        )}

        {/* Estado */}
        <div className="flex items-center gap-2">
          {status === "qr" && (
            <>
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
              <span className="text-sm text-amber-600">Esperando escaneo...</span>
            </>
          )}
          {status === "connecting" && (
            <>
              <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
              <span className="text-sm text-blue-600">Conectando...</span>
            </>
          )}
          {status === "disconnected" && (
            <>
              <div className="w-4 h-4 border-2 border-gray-400 border-t-gray-600 rounded-full animate-spin" />
              <span className="text-sm text-gray-500">Iniciando bot...</span>
            </>
          )}
        </div>
      </div>

      {/* Mensaje de error si lleva más de 30s en disconnected sin QR */}
      {status === "disconnected" && !qrPng && stuckSeconds > 30 && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 max-w-xs text-center">
          <p className="text-sm text-red-600">
            El bot tardó más de lo esperado en iniciar.
            <br />
            Recarga la página o revisa la consola del servidor.
          </p>
        </div>
      )}
    </div>
  );
}
