"use client";

import { useMemo, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { fmtCOP } from "@/lib/format";

type Category = { id: string; slug: string; label: string };
type Item = {
  id: string;
  categoryId: string;
  name: string;
  description: string;
  priceCents: number;
  photoUrl: string | null;
  prepMinutes: number;
};

export function PickupClient({
  tenant,
  tableId,
  defaults,
  categories,
  items,
}: {
  tenant: {
    slug: string;
    name: string;
    tagline: string | null;
    maxEtaMinutes: number | null;
  };
  tableId: string;
  defaults: { name: string; phone: string };
  categories: Category[];
  items: Item[];
}) {
  const router = useRouter();
  const [cart, setCart] = useState<Record<string, number>>({});
  const [name, setName] = useState(defaults.name);
  const [phone, setPhone] = useState(defaults.phone);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [eta, setEta] = useState<{
    minutes: number;
    loading: boolean;
    saturated: boolean;
    closed: boolean;
  }>({ minutes: 0, loading: false, saturated: false, closed: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const byCategory = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const it of items) {
      const arr = m.get(it.categoryId) ?? [];
      arr.push(it);
      m.set(it.categoryId, arr);
    }
    return m;
  }, [items]);

  const cartItems = useMemo(
    () =>
      Object.entries(cart)
        .filter(([, qty]) => qty > 0)
        .map(([id, qty]) => {
          const it = items.find((x) => x.id === id)!;
          return { ...it, qty };
        }),
    [cart, items],
  );

  const subtotal = cartItems.reduce(
    (s, it) => s + it.priceCents * it.qty,
    0,
  );
  const cartCount = cartItems.reduce((s, it) => s + it.qty, 0);

  function setQty(id: string, qty: number) {
    setCart((c) => ({ ...c, [id]: Math.max(0, qty) }));
  }

  // Pull a live ETA whenever the cart changes and the checkout sheet is open.
  // Done server-side so the queue count is authoritative.
  useEffect(() => {
    if (!checkoutOpen || cartItems.length === 0) return;
    let cancelled = false;
    setEta((e) => ({ ...e, loading: true }));
    const payload = {
      items: cartItems.map((it) => ({ menuItemId: it.id, qty: it.qty })),
    };
    fetch(`/api/tenant/${tenant.slug}/pickup/eta`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j) return;
        setEta({
          minutes: j.etaMinutes,
          loading: false,
          saturated: !!j.saturated,
          closed: !j.open,
        });
      })
      .catch(() => {
        if (!cancelled) setEta((e) => ({ ...e, loading: false }));
      });
    return () => {
      cancelled = true;
    };
  }, [checkoutOpen, cartItems, tenant.slug]);

  async function startCheckout() {
    if (cartItems.length === 0) return;
    setCheckoutOpen(true);
  }

  async function placeAndPay(method: "demo_card" | "demo_nequi") {
    if (!name.trim()) {
      setErr("Necesitamos tu nombre para llamarte.");
      return;
    }
    setBusy(true);
    setErr(null);
    const body = {
      tableId,
      pickupName: name.trim(),
      pickupPhone: phone.trim() || undefined,
      method,
      items: cartItems.map((it) => ({
        menuItemId: it.id,
        qty: it.qty,
      })),
    };
    const res = await fetch(`/api/tenant/${tenant.slug}/pickup/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      if (j.error === "saturated") {
        setErr(
          `Cocina saturada (ETA ${j.etaMinutes ?? "?"} min, tope ${
            j.maxEtaMinutes ?? "?"
          } min). Intenta de nuevo en unos minutos.`,
        );
      } else if (j.error === "closed") {
        setErr("Cerramos por ahora. Vuelve en el próximo horario de atención.");
      } else {
        setErr(j.error ?? "No pudimos procesar tu pedido.");
      }
      return;
    }
    const j = await res.json();
    router.push(`/p/${tenant.slug}/${j.orderId}/status`);
  }

  return (
    <main className="flex-1 bg-bone pb-40">
      <header className="sticky top-0 z-20 bg-bone/95 backdrop-blur border-b border-hairline">
        <div className="max-w-3xl mx-auto px-5 py-4">
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-terracotta">
            Pedido para recoger
          </div>
          <div className="font-display text-2xl mt-1">{tenant.name}</div>
          {tenant.tagline && (
            <div className="text-sm text-muted">{tenant.tagline}</div>
          )}
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-5 py-6">
        {categories.map((c) => {
          const list = byCategory.get(c.id) ?? [];
          if (list.length === 0) return null;
          return (
            <section key={c.id} className="mb-8">
              <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted mb-3">
                {c.label}
              </div>
              <ul className="space-y-2">
                {list.map((it) => {
                  const qty = cart[it.id] ?? 0;
                  return (
                    <li
                      key={it.id}
                      className="rounded-xl border border-hairline bg-paper p-3 flex items-start gap-3"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-medium">{it.name}</div>
                        {it.description && (
                          <div className="text-xs text-muted mt-0.5 line-clamp-2">
                            {it.description}
                          </div>
                        )}
                        <div className="font-mono text-xs text-ink mt-1 tabular">
                          {fmtCOP(it.priceCents)}
                        </div>
                      </div>
                      <div className="shrink-0 flex items-center gap-2">
                        {qty === 0 ? (
                          <button
                            onClick={() => setQty(it.id, 1)}
                            className="h-9 px-3 rounded-full border border-ink text-ink text-sm font-medium"
                          >
                            Agregar
                          </button>
                        ) : (
                          <div className="flex items-center gap-1 bg-ink text-bone rounded-full h-9 px-1">
                            <button
                              onClick={() => setQty(it.id, qty - 1)}
                              className="w-7 h-7 rounded-full hover:bg-bone/10 flex items-center justify-center"
                              aria-label="Menos"
                            >
                              −
                            </button>
                            <span className="w-6 text-center font-mono tabular text-sm">
                              {qty}
                            </span>
                            <button
                              onClick={() => setQty(it.id, qty + 1)}
                              className="w-7 h-7 rounded-full hover:bg-bone/10 flex items-center justify-center"
                              aria-label="Más"
                            >
                              +
                            </button>
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>

      {cartCount > 0 && !checkoutOpen && (
        <div className="fixed bottom-0 left-0 right-0 border-t border-hairline bg-bone/95 backdrop-blur z-30">
          <div className="max-w-3xl mx-auto px-5 py-3 flex items-center justify-between gap-3">
            <div>
              <div className="font-mono text-[10px] tracking-wider uppercase text-muted">
                {cartCount} {cartCount === 1 ? "ítem" : "ítems"}
              </div>
              <div className="font-display text-xl tabular">
                {fmtCOP(subtotal)}
              </div>
            </div>
            <button
              onClick={startCheckout}
              className="h-12 px-6 rounded-full bg-ink text-bone text-sm font-medium"
            >
              Continuar a pagar →
            </button>
          </div>
        </div>
      )}

      {checkoutOpen && (
        <div className="fixed inset-0 z-40 bg-ink/40 flex items-end md:items-center justify-center">
          <div className="w-full md:max-w-md bg-bone rounded-t-3xl md:rounded-3xl border border-hairline shadow-xl max-h-[92vh] overflow-y-auto">
            <div className="p-5 border-b border-hairline flex items-center justify-between">
              <div className="font-display text-xl">Recogida</div>
              <button
                onClick={() => setCheckoutOpen(false)}
                className="text-muted text-sm"
              >
                Volver
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div
                className={
                  "rounded-xl border p-3 " +
                  (eta.saturated || eta.closed
                    ? "border-danger/40 bg-danger/5"
                    : "border-hairline bg-paper")
                }
              >
                <div className="font-mono text-[10px] tracking-wider uppercase text-muted">
                  Tiempo estimado de espera
                </div>
                <div className="font-display text-3xl tabular mt-1">
                  {eta.loading ? "…" : `${eta.minutes} min`}
                </div>
                <div className="text-[11px] text-muted mt-1">
                  {eta.closed
                    ? "Cerramos por ahora. Vuelve en el próximo horario."
                    : eta.saturated
                      ? `Cocina saturada${
                          tenant.maxEtaMinutes
                            ? ` (tope ${tenant.maxEtaMinutes} min)`
                            : ""
                        }. No podemos recibir más pedidos en este momento.`
                      : "Basado en las órdenes que están en cocina ahora."}
                </div>
              </div>

              <label className="block">
                <span className="font-mono text-[10px] tracking-wider uppercase text-muted">
                  Tu nombre
                </span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={40}
                  className="mt-1 w-full h-11 px-3 rounded-lg border border-hairline bg-paper focus:outline-none focus:border-terracotta"
                  placeholder="Para llamarte cuando esté lista"
                />
              </label>

              <label className="block">
                <span className="font-mono text-[10px] tracking-wider uppercase text-muted">
                  Celular (opcional)
                </span>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  maxLength={24}
                  placeholder="+57 300 123 4567"
                  className="mt-1 w-full h-11 px-3 rounded-lg border border-hairline bg-paper focus:outline-none focus:border-terracotta"
                />
              </label>

              <div className="rounded-xl border border-hairline bg-paper p-3">
                <div className="font-mono text-[10px] tracking-wider uppercase text-muted mb-2">
                  Tu pedido
                </div>
                <ul className="divide-y divide-hairline">
                  {cartItems.map((it) => (
                    <li
                      key={it.id}
                      className="py-1.5 flex items-center justify-between text-sm"
                    >
                      <span className="truncate">
                        {it.qty}× {it.name}
                      </span>
                      <span className="font-mono tabular">
                        {fmtCOP(it.priceCents * it.qty)}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 pt-2 border-t border-hairline flex items-baseline justify-between">
                  <span className="font-mono text-[10px] tracking-wider uppercase text-muted">
                    Total
                  </span>
                  <span className="font-display text-2xl tabular">
                    {fmtCOP(subtotal)}
                  </span>
                </div>
              </div>

              {err && <div className="text-danger text-sm">{err}</div>}

              <div className="space-y-2">
                <button
                  onClick={() => placeAndPay("demo_card")}
                  disabled={busy || eta.saturated || eta.closed}
                  className="w-full h-12 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
                >
                  {busy ? "Procesando…" : `Pagar con tarjeta · ${fmtCOP(subtotal)}`}
                </button>
                <button
                  onClick={() => placeAndPay("demo_nequi")}
                  disabled={busy || eta.saturated || eta.closed}
                  className="w-full h-12 rounded-full border border-hairline bg-paper text-ink text-sm font-medium disabled:opacity-60"
                >
                  Pagar con Nequi
                </button>
                <div className="text-[11px] text-muted text-center mt-1">
                  Tu orden entra a cocina solo cuando el pago aprueba.
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
