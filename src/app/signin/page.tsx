"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";

export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignIn />
    </Suspense>
  );
}

function SignIn() {
  const router = useRouter();
  const search = useSearchParams();
  const callbackUrl = search.get("callbackUrl") ?? "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const res = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });
    setBusy(false);
    if (res?.error) {
      setErr("Email o contraseña incorrectos.");
      return;
    }
    router.push(callbackUrl);
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
          Bienvenido de vuelta
        </h1>

        <label className="block font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-1">
          Correo
        </label>
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full h-11 px-3 rounded-lg border border-hairline bg-ivory text-ink mb-4 focus:outline-none focus:border-terracotta"
        />

        <label className="block font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-1">
          Contraseña
        </label>
        <input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full h-11 px-3 rounded-lg border border-hairline bg-ivory text-ink mb-5 focus:outline-none focus:border-terracotta"
        />

        {err && <div className="text-danger text-sm mb-4">{err}</div>}

        <button
          type="submit"
          disabled={busy}
          className="w-full h-11 rounded-lg bg-ink text-bone font-medium disabled:opacity-60"
        >
          {busy ? "Ingresando…" : "Ingresar"}
        </button>

        <div className="mt-5 text-sm text-muted text-center">
          ¿No tienes cuenta?{" "}
          <Link href="/signup" className="text-terracotta underline">
            Crea una
          </Link>
        </div>

        <div className="mt-7 pt-5 border-t border-hairline text-[11px] text-muted-2 leading-relaxed">
          <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-2">
            Cuentas de prueba
          </div>
          <div>
            <code className="font-mono">cliente@mesapay.co</code> · cliente
          </div>
          <div>
            <code className="font-mono">mesero@casateresita.co</code> · operador
          </div>
          <div>
            <code className="font-mono">admin@mesapay.co</code> · admin
          </div>
          <div className="mt-1">
            Contraseña: <code className="font-mono">mesapay123</code>
          </div>
        </div>
      </form>
    </main>
  );
}
