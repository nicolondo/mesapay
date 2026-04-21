"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";

export default function SignUp() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [marketingOptIn, setMarketingOptIn] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: name.trim() || undefined,
        email: email.trim(),
        phone: phone.trim() || undefined,
        password,
        marketingOptIn,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "No pudimos crear tu cuenta.");
      setBusy(false);
      return;
    }
    await signIn("credentials", { email, password, redirect: false });
    router.push("/me");
    router.refresh();
  }

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16 bg-bone">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm bg-paper rounded-2xl p-7 border border-hairline"
      >
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted mb-2">
          MESAPAY
        </div>
        <h1 className="font-display text-3xl tracking-[-0.015em] mb-2">
          Crea tu cuenta
        </h1>
        <p className="text-sm text-muted mb-6">
          Guarda tus órdenes y paga más rápido en cualquier restaurante con
          MESAPAY.
        </p>

        <label className="block font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-1">
          Nombre
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full h-11 px-3 rounded-lg border border-hairline bg-ivory mb-4 focus:outline-none focus:border-terracotta"
        />

        <label className="block font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-1">
          Correo
        </label>
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full h-11 px-3 rounded-lg border border-hairline bg-ivory mb-4 focus:outline-none focus:border-terracotta"
        />

        <label className="block font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-1">
          Celular (opcional)
        </label>
        <input
          type="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+57 300 123 4567"
          className="w-full h-11 px-3 rounded-lg border border-hairline bg-ivory mb-4 focus:outline-none focus:border-terracotta"
        />

        <label className="block font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-1">
          Contraseña
        </label>
        <input
          type="password"
          required
          minLength={6}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full h-11 px-3 rounded-lg border border-hairline bg-ivory mb-4 focus:outline-none focus:border-terracotta"
        />

        <label className="flex items-start gap-2 mb-5 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={marketingOptIn}
            onChange={(e) => setMarketingOptIn(e.target.checked)}
            className="mt-0.5 accent-terracotta"
          />
          <span className="text-muted leading-snug">
            Quiero recibir ofertas y novedades de restaurantes aliados.
          </span>
        </label>

        {err && <div className="text-danger text-sm mb-4">{err}</div>}

        <button
          type="submit"
          disabled={busy}
          className="w-full h-11 rounded-lg bg-ink text-bone font-medium disabled:opacity-60"
        >
          {busy ? "Creando…" : "Crear cuenta"}
        </button>

        <div className="mt-5 text-sm text-muted text-center">
          ¿Ya tienes cuenta?{" "}
          <Link href="/signin" className="text-terracotta underline">
            Ingresa
          </Link>
        </div>
      </form>
    </main>
  );
}
