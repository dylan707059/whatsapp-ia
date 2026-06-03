"use client";

import { useRouter } from "next/navigation";

interface Props {
  phone: string;
  onDisconnect: () => void;
}

export default function DashboardHeader({ phone, onDisconnect }: Props) {
  const router = useRouter();

  async function handleDisconnect() {
    if (!confirm("¿Desconectar WhatsApp? Tendrás que escanear el QR de nuevo.")) return;

    await fetch("/api/connection/disconnect", { method: "POST" });
    onDisconnect();
  }

  async function handleLogout() {
    if (!confirm("¿Cerrar sesión?")) return;

    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="h-14 bg-white border-b border-gray-200 flex items-center justify-between px-4 shrink-0">
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-emerald-500" />
        <span className="font-semibold text-gray-800">Agente WhatsApp</span>
        <span className="text-xs text-gray-400 ml-2">+{phone}</span>
      </div>

      <div className="flex items-center gap-4">
        <button
          onClick={handleDisconnect}
          className="text-xs text-red-500 hover:text-red-700 hover:underline transition-colors"
        >
          Desconectar
        </button>
        <button
          onClick={handleLogout}
          className="text-xs text-gray-500 hover:text-gray-800 hover:underline transition-colors"
        >
          Cerrar sesión
        </button>
      </div>
    </header>
  );
}
