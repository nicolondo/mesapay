"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function ProfileForm({
  initial,
}: {
  initial: { name: string; phone: string; marketingOptIn: boolean };
}) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [phone, setPhone] = useState(initial.phone);
  const [marketingOptIn, setMarketingOptIn] = useState(initial.marketingOptIn);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [, startTx] = useTransition();

  const dirty =
    name.trim() !== initial.name ||
    phone.trim() !== initial.phone ||
    marketingOptIn !== initial.marketingOptIn;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setMsg(null);
    const res = await fetch("/api/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: name.trim() || null,
        phone: phone.trim() || null,
        marketingOptIn,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "No pudimos guardar.");
      return;
    }
    setMsg("Perfil actualizado.");
    startTx(() => router.refresh());
  }

  return (
    <form
      onSubmit={save}
      className="rounded-2xl border border-hairline bg-paper p-5 space-y-4"
    >
      <label className="block">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
          Nombre
        </span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          className="mt-1 w-full h-10 px-3 rounded-lg border border-hairline bg-ivory focus:outline-none focus:border-terracotta"
        />
      </label>
      <label className="block">
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
          Celular
        </span>
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+57 300 123 4567"
          className="mt-1 w-full h-10 px-3 rounded-lg border border-hairline bg-ivory focus:outline-none focus:border-terracotta"
        />
      </label>
      <label className="flex items-start gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          checked={marketingOptIn}
          onChange={(e) => setMarketingOptIn(e.target.checked)}
          className="mt-0.5 accent-terracotta"
        />
        <span className="text-muted leading-snug">
          Recibir ofertas y novedades de restaurantes aliados.
        </span>
      </label>
      {err && <div className="text-danger text-xs">{err}</div>}
      {msg && <div className="text-[#1E5339] text-xs">{msg}</div>}
      <button
        type="submit"
        disabled={busy || !dirty}
        className="h-10 px-4 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
      >
        {busy ? "Guardando…" : "Guardar"}
      </button>
    </form>
  );
}
