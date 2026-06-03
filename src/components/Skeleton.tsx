"use client";

interface Props {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  style?: React.CSSProperties;
}

export function Skeleton({ width = "100%", height = 12, radius = 4, style }: Props) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: radius,
        background: "linear-gradient(90deg, var(--bg-elev-2) 0%, var(--bg-hover) 50%, var(--bg-elev-2) 100%)",
        backgroundSize: "200% 100%",
        animation: "skel-shimmer 1.4s ease-in-out infinite",
        ...style
      }}
    >
      <style jsx>{`
        @keyframes skel-shimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}

/** Esqueleto de una fila de conversación en la lista. */
export function ChatRowSkeleton() {
  return (
    <div style={{ padding: "9px 14px", display: "flex", gap: 11, alignItems: "center" }}>
      <Skeleton width={32} height={32} radius={6} />
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
          <Skeleton width="50%" height={11} />
          <Skeleton width={28} height={9} style={{ marginLeft: "auto" }} />
        </div>
        <Skeleton width="80%" height={10} />
      </div>
    </div>
  );
}

/** Esqueleto de un mensaje (alternando lado). */
export function MessageBubbleSkeleton({ side = "in" as "in" | "out" }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: side === "in" ? "flex-start" : "flex-end",
        marginBottom: 2
      }}
    >
      <Skeleton
        width={`${30 + Math.random() * 25}%`}
        height={42}
        radius={6}
        style={{ minWidth: 100 }}
      />
    </div>
  );
}
