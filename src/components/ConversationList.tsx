"use client";

import type { ConversationWithPreview } from "@/lib/types";
import { jidToDisplay } from "@/lib/types";

interface Props {
  conversations: ConversationWithPreview[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}

function relativeTime(unixSeconds: number | null): string {
  if (!unixSeconds) return "";
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60)    return "ahora";
  if (diff < 3600)  return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
  return `hace ${Math.floor(diff / 86400)} d`;
}

export default function ConversationList({ conversations, selectedId, onSelect }: Props) {
  if (conversations.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <p className="text-sm text-gray-400 text-center">
          Sin conversaciones aún.
          <br />
          Esperando mensajes entrantes.
        </p>
      </div>
    );
  }

  return (
    <ul className="flex-1 overflow-y-auto">
      {conversations.map((conv) => (
        <li key={conv.id}>
          <button
            onClick={() => onSelect(conv.id)}
            className={`
              w-full text-left px-4 py-3 border-b border-gray-100
              hover:bg-gray-50 transition-colors
              ${selectedId === conv.id ? "bg-gray-100" : ""}
            `}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="font-medium text-sm text-gray-900 truncate max-w-[130px]">
                {conv.name || jidToDisplay(conv.phone)}
              </span>
              <span className="text-[10px] text-gray-400 ml-2 shrink-0">
                {relativeTime(conv.last_message_at)}
              </span>
            </div>

            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-gray-400 truncate flex-1">
                {conv.last_message_preview ?? "Sin mensajes"}
              </p>
              <span
                className={`
                  shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-semibold
                  ${conv.mode === "AI"
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-amber-100 text-amber-700"
                  }
                `}
              >
                {conv.mode}
              </span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
