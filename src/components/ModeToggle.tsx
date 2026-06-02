"use client";

interface Props {
  conversationId: number;
  mode: "AI" | "HUMAN";
  onToggle: (newMode: "AI" | "HUMAN") => void;
}

export default function ModeToggle({ conversationId, mode, onToggle }: Props) {
  async function handleToggle() {
    const newMode = mode === "AI" ? "HUMAN" : "AI";

    await fetch(`/api/mode/${conversationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: newMode })
    });

    onToggle(newMode);
  }

  return (
    <button
      onClick={handleToggle}
      className={`
        px-3 py-1 rounded-full text-xs font-semibold transition-colors
        ${mode === "AI"
          ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
          : "bg-amber-100 text-amber-700 hover:bg-amber-200"
        }
      `}
    >
      {mode === "AI" ? "IA activa" : "Modo HUMAN"}
    </button>
  );
}
