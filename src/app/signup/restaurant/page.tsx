"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";

function slugifyClient(s: string) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

export default function RestaurantSignUp() {
  const router = useRouter();
  const [restaurantName, setRestaurantName] = useState("");
  const [restaurantSlug, setRestaurantSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [serviceMode, setServiceMode] = useState<"table" | "counter">("table");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function onRestaurantNameChange(v: string) {
    setRestaurantName(v);
    if (!slugTouched) setRestaurantSlug(slugifyClient(v));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const slug = slugifyClient(restaurantSlug);
    const res = await fetch("/api/auth/register-restaurant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        restaurantName,
        restaurantSlug: slug,
        serviceMode,
        name,
        email,
        password,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "No pudimos crear tu restaurante.");
      setBusy(false);
      return;
    }
    await signIn("credentials", { email, password, redirect: false });
    router.push("/operator");
    router.refresh();
  }

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16 bg-bone">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md bg-paper rounded-2xl p-7 border border-hairline"
      >
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted mb-2">
          MESAPAY · Onboarding
        </div>
        <h1 className="font-display text-3xl tracking-[-0.015em] mb-2">
          Registra tu restaurante
        </h1>
        <p className="text-sm text-muted mb-6">
          Creamos tu cuenta de operador, tu restaurante, una mesa inicial y
          categorías básicas. Listo para imprimir el primer QR.
        </p>

        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
          Restaurante
        </div>

        <label className="block font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-1">
          Nombre del restaurante
        </label>
        <input
          type="text"
          required
          value={restaurantName}
          onChange={(e) => onRestaurantNameChange(e.target.value)}
          placeholder="La Cocina de Mamá"
          className="w-full h-11 px-3 rounded-lg border border-hairline bg-ivory mb-4 focus:outline-none focus:border-terracotta"
        />

        <label className="block font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-1">
          Identificador
        </label>
        <div className="flex items-center gap-2 mb-1">
          <input
            type="text"
            required
            value={restaurantSlug}
            onChange={(e) => {
              setSlugTouched(true);
              setRestaurantSlug(slugifyClient(e.target.value));
            }}
            placeholder="la-cocina-de-mama"
            className="flex-1 h-11 px-3 rounded-lg border border-hairline bg-ivory font-mono text-sm focus:outline-none focus:border-terracotta"
          />
        </div>
        <p className="text-xs text-muted-2 mb-5">
          Tu URL será{" "}
          <code className="font-mono">
            mesapay.co/t/{restaurantSlug || "..."}
          </code>
          .
        </p>

        <label className="block font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
          Modo de servicio
        </label>
        <div className="grid grid-cols-2 gap-2 mb-5">
          <button
            type="button"
            onClick={() => setServiceMode("table")}
            className={
              "rounded-lg border px-3 py-3 text-left transition-colors " +
              (serviceMode === "table"
                ? "border-terracotta bg-terracotta/5 ring-1 ring-terracotta/30"
                : "border-hairline bg-ivory hover:border-terracotta/50")
            }
          >
            <div className="text-sm font-medium">Con mesas</div>
            <div className="text-[11px] text-muted-2 mt-0.5">
              Restaurante tradicional
            </div>
          </button>
          <button
            type="button"
            onClick={() => setServiceMode("counter")}
            className={
              "rounded-lg border px-3 py-3 text-left transition-colors " +
              (serviceMode === "counter"
                ? "border-terracotta bg-terracotta/5 ring-1 ring-terracotta/30"
                : "border-hairline bg-ivory hover:border-terracotta/50")
            }
          >
            <div className="text-sm font-medium">Mostrador</div>
            <div className="text-[11px] text-muted-2 mt-0.5">
              Food truck, carrito, para llevar
            </div>
          </button>
        </div>

        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2 mt-2">
          Tu cuenta
        </div>

        <label className="block font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-1">
          Nombre
        </label>
        <input
          type="text"
          required
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
          disabled={busy || !restaurantName || !restaurantSlug}
          className="w-full h-11 rounded-lg bg-ink text-bone font-medium disabled:opacity-60"
        >
          {busy ? "Creando…" : "Crear restaurante"}
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
