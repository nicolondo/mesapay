"use client";

import { useState } from "react";

export function RatingInline({
  orderItemId,
  tenantSlug,
  existing,
  defaultGuestName,
}: {
  orderItemId: string;
  tenantSlug: string;
  existing: { stars: number; comment: string | null } | null;
  defaultGuestName: string | null;
}) {
  const [stars, setStars] = useState<number>(existing?.stars ?? 0);
  const [comment, setComment] = useState<string>(existing?.comment ?? "");
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(!!existing);

  if (saved) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted">
        <Stars stars={stars} size={16} />
        <span>¡Gracias por tu calificación!</span>
      </div>
    );
  }

  async function submit(finalStars: number) {
    if (!finalStars) return;
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/tenant/${tenantSlug}/ratings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orderItemId,
        stars: finalStars,
        comment: comment.trim() || undefined,
        guestName: defaultGuestName ?? undefined,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      if (res.status === 409) {
        // Someone else at the table rated this item. Treat as saved.
        setSaved(true);
        return;
      }
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "No se pudo guardar.");
      return;
    }
    setSaved(true);
  }

  function onStarClick(n: number) {
    setStars(n);
    if (!expanded) setExpanded(true);
  }

  return (
    <div className="rounded-lg border border-hairline bg-ivory px-3 py-2">
      <div className="flex items-center gap-3">
        <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-muted">
          ¿Qué te pareció?
        </div>
        <StarInput value={stars} onChange={onStarClick} disabled={busy} />
      </div>
      {expanded && (
        <div className="mt-2">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={500}
            rows={2}
            placeholder="Cuéntanos algo (opcional)"
            className="w-full px-2 py-1.5 rounded border border-hairline bg-paper text-sm"
          />
          {err && <div className="text-danger text-xs mt-1">{err}</div>}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => submit(stars)}
              disabled={busy || !stars}
              className="h-8 px-4 rounded-full bg-terracotta text-paper text-xs font-medium disabled:opacity-60"
            >
              {busy ? "Enviando…" : "Enviar"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StarInput({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = n <= value;
        return (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            disabled={disabled}
            aria-label={`${n} estrella${n === 1 ? "" : "s"}`}
            className="p-0.5 active:scale-95 transition-transform disabled:opacity-60"
          >
            <StarIcon filled={filled} />
          </button>
        );
      })}
    </div>
  );
}

export function Stars({ stars, size = 14 }: { stars: number; size?: number }) {
  return (
    <div className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <StarIcon key={n} filled={n <= stars} size={size} />
      ))}
    </div>
  );
}

function StarIcon({ filled, size = 18 }: { filled: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "#C9532E" : "none"}
      stroke={filled ? "#C9532E" : "#8F867C"}
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 2.8l2.9 6.1 6.6.7-4.9 4.6 1.3 6.6L12 17.7 6.1 20.8l1.3-6.6L2.5 9.6l6.6-.7L12 2.8z" />
    </svg>
  );
}
