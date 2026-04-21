"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";

export default function SignUp() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, email, password }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "No pudimos crear tu cuenta.");
      setBusy(false);
      return;
    }
    await signIn("credentials", { email, password, redirect: false });
    router.push("/");
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
        <h1 className="font-display text-3xl tracking-[-0.015em] mb-6">
          Crea tu cuenta
        </h1>

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
          Contraseña
        </label>
        <input
          type="password"
          required
          minLength={6}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full h-11 px-3 rounded-lg border border-hairline bg-ivory mb-5 focus:outline-none focus:border-terracotta"
        />

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
