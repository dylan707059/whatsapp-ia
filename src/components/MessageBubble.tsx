interface Props {
  role: "user" | "assistant" | "human";
  content: string;
  createdAt: number;
}

function formatTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString("es", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

export default function MessageBubble({ role, content, createdAt }: Props) {
  const isIncoming = role === "user";

  return (
    <div className={`flex ${isIncoming ? "justify-start" : "justify-end"} mb-2`}>
      <div
        className={`
          max-w-[75%] px-3 py-2 rounded-2xl text-sm leading-relaxed
          ${isIncoming
            ? "bg-white border border-gray-200 text-gray-800 rounded-bl-sm"
            : role === "assistant"
              ? "bg-emerald-500 text-white rounded-br-sm"
              : "bg-amber-400 text-white rounded-br-sm"
          }
        `}
      >
        <p className="whitespace-pre-wrap break-words">{content}</p>
        <p className={`text-[10px] mt-1 ${isIncoming ? "text-gray-400" : "text-white/70"}`}>
          {formatTime(createdAt)}
          {role === "human" && (
            <span className="ml-1 font-medium">(manual)</span>
          )}
        </p>
      </div>
    </div>
  );
}
