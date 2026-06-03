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
    <div
      style={{
        display: "flex",
        justifyContent: isIncoming ? "flex-start" : "flex-end",
        marginBottom: 2
      }}
    >
      <div
        style={{
          maxWidth: "58%",
          padding: "8px 12px",
          borderRadius: "var(--radius)",
          fontSize: 13.5,
          lineHeight: 1.5,
          wordWrap: "break-word",
          border: "1px solid var(--border)",
          background: isIncoming ? "var(--bubble-in)" : "var(--bubble-out)",
          color: "var(--text)"
        }}
      >
        <div style={{ whiteSpace: "pre-wrap" }}>{content}</div>
        <div
          style={{
            fontSize: 10.5,
            color: "var(--text-dim)",
            marginTop: 4,
            display: "flex",
            alignItems: "center",
            gap: 6,
            justifyContent: isIncoming ? "flex-start" : "flex-end"
          }}
        >
          {role === "human" && (
            <span
              style={{
                fontWeight: 600,
                color: "var(--warning)",
                fontSize: 9.5
              }}
              title="Mensaje enviado manualmente desde el dashboard"
            >
              MANUAL
            </span>
          )}
          {role === "assistant" && !isIncoming && (
            <span
              style={{
                fontWeight: 600,
                color: "var(--success)",
                fontSize: 9.5
              }}
              title="Mensaje automático del bot"
            >
              AUTO
            </span>
          )}
          <span>{formatTime(createdAt)}</span>
        </div>
      </div>
    </div>
  );
}
