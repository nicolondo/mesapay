"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { fmtCOP } from "@/lib/format";
import {
  COUNTRIES,
  DEFAULT_COUNTRY_CODE,
  findCountryByCode,
  type Country,
} from "@/lib/countries";

type MenuLayout = "list" | "grid" | "editorial";

type Tenant = {
  slug: string;
  name: string;
  tagline: string | null;
  serviceMode: "table" | "counter";
};
type Category = { id: string; slug: string; label: string };
type ModifierDef = {
  id: string;
  label: string;
  type: "radio" | "checkbox";
  opts: string[];
  default?: string;
};
type MenuItem = {
  id: string;
  categoryId: string;
  name: string;
  description: string;
  priceCents: number;
  tags: string[];
  photoUrl: string | null;
  modifiers: ModifierDef[] | null;
  ratingAvg: number;
  ratingCount: number;
};
type CartLine = {
  key: string; // id + JSON(selections)
  menuItemId: string;
  name: string;
  priceCents: number;
  qty: number;
  selections: Record<string, string>;
  notes?: string;
};
type ActiveOrder = {
  id: string;
  shortCode: string;
  subtotalCents: number;
  status: string;
  itemCount: number;
  roundCount: number;
  items: { id: string; name: string; qty: number; priceCents: number }[];
};

const TAG_STYLES: Record<string, string> = {
  firma: "bg-[#B8893B]/12 text-[#8F6828]",
  popular: "bg-ink/10 text-ink",
  veg: "bg-[#5C6B3B]/15 text-[#42502A]",
  spicy: "bg-terracotta/15 text-terracotta",
  nuevo: "bg-[#2E6B4C]/15 text-[#1E5339]",
};
const TAG_LABEL: Record<string, string> = {
  firma: "De la casa",
  popular: "Favorito",
  veg: "Vegetariano",
  spicy: "Picante",
  nuevo: "Nuevo",
};

export function MenuClient({
  tenant,
  tableId,
  locationLabel,
  categories,
  items,
  activeOrder,
  pickup,
}: {
  tenant: Tenant;
  tableId: string;
  locationLabel: string;
  categories: Category[];
  items: MenuItem[];
  activeOrder: ActiveOrder | null;
  pickup?: {
    defaultName: string;
    defaultPhone: string;
    maxEtaMinutes: number | null;
    kushkiReady: boolean;
    kushkiPublicKey: string | null;
    isMockMode: boolean;
  } | null;
}) {
  const router = useRouter();
  const [activeCat, setActiveCat] = useState<string>(categories[0]?.slug ?? "");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [openItem, setOpenItem] = useState<MenuItem | null>(null);
  const [showActiveSheet, setShowActiveSheet] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [layout, setLayout] = useState<MenuLayout>("list");
  const [guestName, setGuestName] = useState<string>("");
  const [showNameSheet, setShowNameSheet] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [query, setQuery] = useState("");
  const [servingMode, setServingMode] = useState<"asReady" | "together">(
    "asReady",
  );
  const [showPickupSheet, setShowPickupSheet] = useState(false);
  const isPickup = !!pickup;
  // Counter-mode tenants (food trucks, mostrador) have no mains-together
  // semantics — items are prepared and handed over as they're ready. Hide the
  // picker and lock the mode to "asReady". Pickup orders behave the same way —
  // each item goes out when it's ready.
  const isCounter = tenant.serviceMode === "counter" || isPickup;
  const headerRef = useRef<HTMLElement>(null);

  function scrollToCategory(slug: string) {
    const el = document.getElementById(`cat-${slug}`);
    if (!el) return;
    const headerH = headerRef.current?.getBoundingClientRect().height ?? 0;
    const y = window.scrollY + el.getBoundingClientRect().top - headerH - 12;
    window.scrollTo({ top: y, behavior: "smooth" });
  }

  const nameKey = `mesapay.guestName.${tableId}`;
  const cartKey = `mesapay.cart.${tableId}`;
  const CART_TTL_MS = 6 * 60 * 60 * 1000; // discard carts older than 6h

  useEffect(() => {
    const savedLayout = localStorage.getItem("mesapay.menuLayout");
    if (
      savedLayout === "list" ||
      savedLayout === "grid" ||
      savedLayout === "editorial"
    ) {
      setLayout(savedLayout);
    }
    const savedName = localStorage.getItem(nameKey);
    if (savedName) setGuestName(savedName);
    else if (!isPickup) setShowNameSheet(true);
    try {
      const raw = localStorage.getItem(cartKey);
      if (raw) {
        const parsed = JSON.parse(raw) as { t?: number; cart?: CartLine[] };
        if (
          parsed &&
          Array.isArray(parsed.cart) &&
          typeof parsed.t === "number" &&
          Date.now() - parsed.t < CART_TTL_MS
        ) {
          setCart(parsed.cart);
        } else {
          localStorage.removeItem(cartKey);
        }
      }
    } catch {
      localStorage.removeItem(cartKey);
    }
    setHydrated(true);
  }, [nameKey, cartKey, CART_TTL_MS]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      if (cart.length === 0) {
        localStorage.removeItem(cartKey);
      } else {
        localStorage.setItem(cartKey, JSON.stringify({ t: Date.now(), cart }));
      }
    } catch {}
  }, [cart, cartKey, hydrated]);

  function changeLayout(next: MenuLayout) {
    setLayout(next);
    try {
      localStorage.setItem("mesapay.menuLayout", next);
    } catch {}
  }

  function saveGuestName(raw: string) {
    const name = raw.trim().slice(0, 40);
    if (!name) return;
    setGuestName(name);
    try {
      localStorage.setItem(nameKey, name);
    } catch {}
    setShowNameSheet(false);
  }

  // Live-refresh the "pedido abierto en esta mesa" banner when another
  // diner at the same table sends or updates a round.
  useEffect(() => {
    const es = new EventSource(`/api/tenant/${tenant.slug}/events`);
    es.addEventListener("message", () => {
      router.refresh();
    });
    return () => es.close();
  }, [tenant.slug, router]);

  const itemsByCat = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, MenuItem[]>();
    for (const c of categories) map.set(c.id, []);
    for (const it of items) {
      if (q) {
        const hay = `${it.name} ${it.description ?? ""}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      map.get(it.categoryId)?.push(it);
    }
    return map;
  }, [items, categories, query]);

  const searching = query.trim().length > 0;
  const visibleCount = searching
    ? Array.from(itemsByCat.values()).reduce((s, arr) => s + arr.length, 0)
    : 0;

  const subtotal = cart.reduce((s, l) => s + l.priceCents * l.qty, 0);
  const totalQty = cart.reduce((s, l) => s + l.qty, 0);

  function quickAdd(item: MenuItem) {
    // If every modifier has a default, we can add straight to the cart.
    // Otherwise open the detail sheet so the user can pick.
    const mods = item.modifiers ?? [];
    const allHaveDefaults = mods.every((m) => m.default);
    if (!allHaveDefaults) {
      setOpenItem(item);
      return;
    }
    const selections: Record<string, string> = {};
    for (const m of mods) {
      if (m.default) selections[m.id] = m.default;
    }
    addToCart(item, selections, 1);
  }

  function addToCart(item: MenuItem, selections: Record<string, string>, qty = 1, notes?: string) {
    const key = item.id + "::" + JSON.stringify(selections) + "::" + (notes ?? "");
    setCart((prev) => {
      const ix = prev.findIndex((l) => l.key === key);
      if (ix >= 0) {
        const next = [...prev];
        next[ix] = { ...next[ix], qty: next[ix].qty + qty };
        return next;
      }
      return [
        ...prev,
        {
          key,
          menuItemId: item.id,
          name: item.name,
          priceCents: item.priceCents,
          qty,
          selections,
          notes,
        },
      ];
    });
  }

  function removeLine(key: string) {
    setCart((prev) => prev.filter((l) => l.key !== key));
  }
  function setQty(key: string, qty: number) {
    setCart((prev) =>
      prev
        .map((l) => (l.key === key ? { ...l, qty } : l))
        .filter((l) => l.qty > 0),
    );
  }

  async function sendToKitchen() {
    if (!cart.length) return;
    if (isPickup) {
      setShowPickupSheet(true);
      return;
    }
    if (!guestName) {
      setShowNameSheet(true);
      return;
    }
    setSubmitting(true);
    const res = await fetch(`/api/tenant/${tenant.slug}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tableId,
        orderId: activeOrder?.id,
        guestName,
        // Only meaningful on the first round — subsequent rounds inherit
        // whatever the order was created with.
        servingMode: activeOrder ? undefined : servingMode,
        items: cart.map((l) => ({
          menuItemId: l.menuItemId,
          qty: l.qty,
          selections: l.selections,
          notes: l.notes,
        })),
      }),
    });
    setSubmitting(false);
    if (!res.ok) {
      alert("No pudimos enviar el pedido. Intenta de nuevo.");
      return;
    }
    const { orderId } = await res.json();
    try {
      localStorage.removeItem(cartKey);
    } catch {}
    setCart([]);
    // Counter-mode is prepay: skip the shared-bill view and send the diner
    // straight to checkout. The kitchen only sees the order after the
    // payment route flips the round from "open" to "placed".
    router.push(
      isCounter
        ? `/t/${tenant.slug}/pay/${orderId}`
        : `/t/${tenant.slug}/order/${orderId}`,
    );
  }

  return (
    <div className="flex flex-1 flex-col pb-36">
      {/* Header */}
      <header
        ref={headerRef}
        className="sticky top-0 z-20 bg-bone/90 backdrop-blur border-b border-hairline"
      >
        <div className="max-w-2xl mx-auto px-5 pt-5 pb-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-mono text-[9px] tracking-[0.16em] uppercase text-muted">
                {locationLabel} · {tenant.name}
              </div>
              <h1 className="font-display text-3xl tracking-[-0.015em]">
                La carta
              </h1>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <LayoutSwitcher layout={layout} onChange={changeLayout} />
              {activeOrder && (
                <Link
                  href={`/t/${tenant.slug}/order/${activeOrder.id}`}
                  className="h-9 px-3 rounded-full bg-ink text-bone font-mono text-[10px] tracking-[0.14em] uppercase inline-flex items-center"
                >
                  {activeOrder.shortCode}
                </Link>
              )}
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            {hydrated && !isPickup && (
              <button
                onClick={() => setShowNameSheet(true)}
                className="shrink-0 inline-flex items-center gap-2 h-10 pl-1 pr-3 rounded-full border border-hairline bg-paper text-[12px]"
              >
                <span className="w-8 h-8 rounded-full bg-terracotta text-paper font-display text-[13px] inline-flex items-center justify-center">
                  {guestName ? guestName.charAt(0).toUpperCase() : "?"}
                </span>
                <span className="text-ink-3 truncate max-w-[120px]">
                  {guestName ? (
                    <>
                      Yo soy · <span className="text-ink font-medium">{guestName}</span>
                    </>
                  ) : (
                    <span className="text-terracotta">Dinos tu nombre</span>
                  )}
                </span>
              </button>
            )}
            <div className="relative flex-1 min-w-0">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar en el menú"
                className="w-full h-10 pl-9 pr-9 rounded-full border border-hairline bg-paper text-sm focus:outline-none focus:border-terracotta"
              />
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted pointer-events-none"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" strokeLinecap="round" />
              </svg>
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Borrar búsqueda"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-ink/5 text-ink-3 flex items-center justify-center text-base leading-none hover:bg-ink/10"
                >
                  ×
                </button>
              )}
            </div>
          </div>

          {/* Category chips */}
          <div className="mt-3 flex gap-2 overflow-x-auto scroll-hide -mx-5 px-5">
            {categories.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  setActiveCat(c.slug);
                  scrollToCategory(c.slug);
                }}
                className={
                  "shrink-0 px-4 h-9 rounded-full text-[13px] font-medium border transition-colors " +
                  (activeCat === c.slug
                    ? "bg-ink text-bone border-ink"
                    : "bg-paper text-ink-3 border-hairline")
                }
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Menu by category */}
      <div className="max-w-2xl w-full mx-auto px-5 mt-4 space-y-10">
        {searching && visibleCount === 0 && (
          <div className="py-16 text-center text-muted text-sm">
            No encontramos nada para{" "}
            <span className="text-ink font-medium">“{query}”</span>.
          </div>
        )}
        {categories.map((c) => {
          const rows = itemsByCat.get(c.id) ?? [];
          if (!rows.length) return null;
          return (
            <section key={c.id} id={`cat-${c.slug}`} className="scroll-mt-28">
              <div className="flex items-baseline justify-between mb-3">
                <div className="font-display text-2xl">{c.label}</div>
                <div className="font-mono text-[10px] tracking-[0.1em] text-muted">
                  {String(rows.length).padStart(2, "0")}
                </div>
              </div>
              {layout === "list" && (
                <ul className="divide-y divide-hairline border-t border-hairline">
                  {rows.map((it) => (
                    <ItemRowList
                      key={it.id}
                      item={it}
                      onOpen={() => setOpenItem(it)}
                      onQuickAdd={() => quickAdd(it)}
                    />
                  ))}
                </ul>
              )}
              {layout === "grid" && (
                <div className="grid grid-cols-2 gap-4 gap-y-6">
                  {rows.map((it) => (
                    <ItemCardGrid
                      key={it.id}
                      item={it}
                      onOpen={() => setOpenItem(it)}
                      onQuickAdd={() => quickAdd(it)}
                    />
                  ))}
                </div>
              )}
              {layout === "editorial" && (
                <div className="flex flex-col gap-6">
                  {rows.map((it, i) => (
                    <ItemCardEditorial
                      key={it.id}
                      item={it}
                      index={i}
                      onOpen={() => setOpenItem(it)}
                      onQuickAdd={() => quickAdd(it)}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {/* Item detail sheet */}
      {openItem && (
        <ItemSheet
          item={openItem}
          onClose={() => setOpenItem(null)}
          onAdd={(sel, qty, notes) => {
            addToCart(openItem, sel, qty, notes);
            setOpenItem(null);
          }}
        />
      )}

      {/* Sticky bottom dock: active order + cart.
          IMPORTANT: don't use `transform` to center this — a transformed
          ancestor becomes the containing block for any descendant
          position:fixed, which would trap the cart modal inside this dock
          instead of the viewport. Use auto margins to center instead. */}
      {!openItem && (cart.length > 0 || activeOrder) && (
        <div className="fixed bottom-4 inset-x-0 mx-auto z-30 w-[calc(100%-2rem)] max-w-xl flex gap-2 items-stretch">
          {activeOrder && (
            <button
              type="button"
              onClick={() => setShowActiveSheet(true)}
              className={
                (cart.length > 0 ? "flex-1 min-w-0 basis-0" : "w-full") +
                " bg-paper border border-hairline text-ink rounded-2xl shadow-[0_10px_40px_rgba(0,0,0,0.18)] px-4 py-3 slide-up text-left flex flex-col justify-center"
              }
            >
              <div className="font-mono text-[9px] tracking-[0.16em] uppercase text-muted truncate">
                Pedido · {activeOrder.shortCode}
              </div>
              <div className="text-sm font-medium truncate mt-0.5">
                {activeOrder.itemCount} {activeOrder.itemCount === 1 ? "item" : "items"}
                {" · "}
                {fmtCOP(activeOrder.subtotalCents)}
              </div>
            </button>
          )}
          {cart.length > 0 && (
            <CartBar
              lines={cart}
              subtotal={subtotal}
              totalQty={totalQty}
              onQty={setQty}
              onRemove={removeLine}
              submitting={submitting}
              onSend={sendToKitchen}
              appendingTo={activeOrder?.shortCode ?? null}
              split={!!activeOrder}
              servingMode={servingMode}
              onServingModeChange={setServingMode}
              showServingMode={!isCounter}
              prepay={isCounter}
            />
          )}
        </div>
      )}

      {/* Active-order detail sheet */}
      {activeOrder && showActiveSheet && (
        <ActiveOrderSheet
          order={activeOrder}
          tenantSlug={tenant.slug}
          onClose={() => setShowActiveSheet(false)}
        />
      )}

      {/* Guest-name bottom sheet */}
      {showNameSheet && !isPickup && (
        <GuestNameSheet
          initial={guestName}
          canCancel={!!guestName}
          onSave={saveGuestName}
          onClose={() => {
            if (guestName) setShowNameSheet(false);
          }}
        />
      )}

      {/* Pickup checkout sheet (prepay before kitchen) */}
      {showPickupSheet && pickup && (
        <PickupCheckoutSheet
          tenantSlug={tenant.slug}
          tableId={tableId}
          cart={cart}
          subtotal={subtotal}
          defaultName={pickup.defaultName}
          defaultPhone={pickup.defaultPhone}
          maxEtaMinutes={pickup.maxEtaMinutes}
          kushkiReady={pickup.kushkiReady}
          kushkiPublicKey={pickup.kushkiPublicKey}
          isMockMode={pickup.isMockMode}
          onClose={() => setShowPickupSheet(false)}
          onSuccess={(orderId) => {
            try {
              localStorage.removeItem(cartKey);
            } catch {}
            setCart([]);
            router.push(`/p/${tenant.slug}/${orderId}/status`);
          }}
        />
      )}
    </div>
  );
}

function CartBar({
  lines,
  subtotal,
  totalQty,
  onQty,
  onRemove,
  submitting,
  onSend,
  appendingTo,
  split,
  servingMode,
  onServingModeChange,
  showServingMode,
  prepay,
}: {
  lines: CartLine[];
  subtotal: number;
  totalQty: number;
  onQty: (key: string, qty: number) => void;
  onRemove: (key: string) => void;
  submitting: boolean;
  onSend: () => void;
  appendingTo: string | null;
  split: boolean;
  servingMode: "asReady" | "together";
  onServingModeChange: (m: "asReady" | "together") => void;
  showServingMode: boolean;
  prepay: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          (split ? "flex-1 min-w-0 basis-0 px-4 py-3" : "w-full px-5 py-4") +
          " bg-ink text-bone rounded-2xl shadow-[0_10px_40px_rgba(0,0,0,0.3)] flex items-center gap-3 slide-up text-left"
        }
      >
        <div className="flex-1 min-w-0">
          <div className="font-mono text-[9px] tracking-[0.16em] uppercase opacity-60 truncate">
            {appendingTo ? `Añadir · ${appendingTo}` : "Tu pedido"}
          </div>
          <div className={(split ? "text-sm font-medium" : "font-display text-xl") + " truncate mt-0.5"}>
            {totalQty} {totalQty === 1 ? "item" : "items"} · {fmtCOP(subtotal)}
          </div>
        </div>
        {!split && (
          <span className="shrink-0 font-medium underline underline-offset-4">
            Ver pedido
          </span>
        )}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/40 flex items-end md:items-center justify-center"
          onClick={() => setOpen(false)}
        >
          <div
            className="bg-paper text-ink w-full max-w-xl max-h-[88dvh] rounded-t-3xl md:rounded-3xl overflow-hidden slide-up flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 pt-6 pb-4 flex-1 overflow-auto">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-display text-3xl tracking-[-0.015em]">
                    Tu pedido
                  </h3>
                  {appendingTo && (
                    <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mt-1">
                      Se añadirá al pedido {appendingTo}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => setOpen(false)}
                  className="w-9 h-9 rounded-full border border-hairline"
                >
                  ×
                </button>
              </div>
              <ul className="mt-5 divide-y divide-hairline border-t border-hairline">
                {lines.map((l) => (
                  <li key={l.key} className="py-3 flex items-start gap-3">
                    <div className="flex-1">
                      <div className="font-medium">{l.name}</div>
                      {Object.entries(l.selections).length > 0 && (
                        <div className="text-xs text-muted mt-0.5">
                          {Object.values(l.selections).join(" · ")}
                        </div>
                      )}
                      {l.notes && (
                        <div className="text-xs text-muted-2 italic mt-0.5">
                          “{l.notes}”
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => onQty(l.key, l.qty - 1)}
                        className="w-7 h-7 rounded-full bg-ivory border border-hairline"
                      >
                        −
                      </button>
                      <span className="font-mono w-4 text-center">{l.qty}</span>
                      <button
                        onClick={() => onQty(l.key, l.qty + 1)}
                        className="w-7 h-7 rounded-full bg-ivory border border-hairline"
                      >
                        +
                      </button>
                    </div>
                    <div className="font-mono text-sm w-20 text-right tabular">
                      {fmtCOP(l.priceCents * l.qty)}
                    </div>
                    <button
                      onClick={() => onRemove(l.key)}
                      className="text-muted-2 text-xs ml-1"
                    >
                      Eliminar
                    </button>
                  </li>
                ))}
              </ul>
              {!appendingTo && showServingMode && (
                <div className="mt-5">
                  <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
                    ¿Cómo quieres que salga?
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => onServingModeChange("asReady")}
                      className={
                        "text-left rounded-xl border px-3 py-3 " +
                        (servingMode === "asReady"
                          ? "border-terracotta bg-terracotta/10"
                          : "border-hairline bg-ivory")
                      }
                    >
                      <div className="text-sm font-medium">Lo que vaya saliendo</div>
                      <div className="text-[11px] text-muted mt-0.5">
                        Cada plato llega apenas está listo.
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => onServingModeChange("together")}
                      className={
                        "text-left rounded-xl border px-3 py-3 " +
                        (servingMode === "together"
                          ? "border-terracotta bg-terracotta/10"
                          : "border-hairline bg-ivory")
                      }
                    >
                      <div className="text-sm font-medium">Fuertes juntos</div>
                      <div className="text-[11px] text-muted mt-0.5">
                        Entradas y bebidas salen apenas estén listas; los fuertes salen todos juntos.
                      </div>
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="shrink-0 border-t border-hairline bg-paper px-6 py-4">
              <div className="flex items-center justify-between">
                <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
                  {appendingTo ? "Esta ronda" : "Subtotal"}
                </div>
                <div className="font-display text-2xl">{fmtCOP(subtotal)}</div>
              </div>
              <button
                onClick={onSend}
                disabled={submitting}
                className="mt-3 w-full h-12 rounded-full bg-terracotta text-paper font-medium disabled:opacity-60"
              >
                {submitting
                  ? prepay
                    ? "Preparando pago…"
                    : "Enviando…"
                  : prepay
                    ? "Ir a pagar"
                    : appendingTo
                      ? "Añadir a cocina"
                      : "Enviar a cocina"}
              </button>
              <p className="text-xs text-muted-2 text-center mt-2">
                {prepay
                  ? "Tu pedido pasa a la cocina apenas confirmemos el pago."
                  : "Podrás añadir más platos durante la comida."}
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ActiveOrderSheet({
  order,
  tenantSlug,
  onClose,
}: {
  order: ActiveOrder;
  tenantSlug: string;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-40 bg-black/40 flex items-end md:items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-paper text-ink w-full max-w-xl max-h-[88dvh] rounded-t-3xl md:rounded-3xl overflow-auto slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6">
          <div className="flex items-start justify-between">
            <div>
              <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
                Pedido de la mesa
              </div>
              <h3 className="font-display text-3xl tracking-[-0.015em]">
                {order.shortCode}
              </h3>
            </div>
            <button
              onClick={onClose}
              className="w-9 h-9 rounded-full border border-hairline"
            >
              ×
            </button>
          </div>
          <ul className="mt-5 divide-y divide-hairline border-t border-hairline">
            {order.items.map((i) => (
              <li key={i.id} className="py-3 flex justify-between gap-3">
                <div className="flex-1">
                  <div className="text-sm">
                    {i.qty}× {i.name}
                  </div>
                </div>
                <div className="font-mono text-sm tabular">
                  {fmtCOP(i.priceCents * i.qty)}
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-5 pt-4 border-t border-hairline flex items-center justify-between">
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
              Subtotal
            </div>
            <div className="font-display text-2xl">
              {fmtCOP(order.subtotalCents)}
            </div>
          </div>
          <Link
            href={`/t/${tenantSlug}/order/${order.id}`}
            className="mt-5 w-full h-12 rounded-full bg-ink text-bone font-medium inline-flex items-center justify-center"
          >
            Ir al detalle del pedido
          </Link>
          <p className="text-xs text-muted-2 text-center mt-3">
            Desde allí puedes ver el estado en vivo y pagar.
          </p>
        </div>
      </div>
    </div>
  );
}

function LayoutSwitcher({
  layout,
  onChange,
}: {
  layout: MenuLayout;
  onChange: (l: MenuLayout) => void;
}) {
  const opts: { id: MenuLayout; label: string; icon: React.ReactNode }[] = [
    { id: "list", label: "Lista", icon: <IconList /> },
    { id: "grid", label: "Cuadrícula", icon: <IconGrid /> },
    { id: "editorial", label: "Editorial", icon: <IconEditorial /> },
  ];
  return (
    <div className="inline-flex bg-paper border border-hairline rounded-full p-0.5">
      {opts.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          aria-label={o.label}
          title={o.label}
          className={
            "w-8 h-8 rounded-full inline-flex items-center justify-center transition-colors " +
            (layout === o.id ? "bg-ink text-bone" : "text-ink-3 hover:text-ink")
          }
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}
function IconList() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
function IconGrid() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
function IconEditorial() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2" width="12" height="6" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2 11h12M2 14h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function MenuStars({
  avg,
  count,
}: {
  avg: number;
  count: number;
}) {
  if (!count) return null;
  const rounded = Math.round(avg);
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted">
      <span className="inline-flex items-center gap-0.5">
        {[1, 2, 3, 4, 5].map((n) => {
          const filled = n <= rounded;
          return (
            <svg
              key={n}
              width="12"
              height="12"
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
        })}
      </span>
      <span className="font-mono tabular">
        {avg.toFixed(1)}
        <span className="text-muted-2"> · {count}</span>
      </span>
    </span>
  );
}

function ItemTags({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <div className="flex gap-1.5 flex-wrap">
      {tags.map((t) => (
        <span
          key={t}
          className={
            "px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium " +
            (TAG_STYLES[t] ?? "bg-paper text-muted")
          }
        >
          {TAG_LABEL[t] ?? t}
        </span>
      ))}
    </div>
  );
}

function QuickAddButton({
  onAdd,
  size = "md",
}: {
  onAdd: () => void;
  size?: "sm" | "md";
}) {
  const dim = size === "sm" ? "w-8 h-8" : "w-10 h-10";
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onAdd();
      }}
      aria-label="Añadir al pedido"
      className={
        dim +
        " shrink-0 rounded-full bg-ink text-bone flex items-center justify-center text-lg leading-none active:scale-95 transition-transform"
      }
    >
      +
    </button>
  );
}

function ItemRowList({
  item,
  onOpen,
  onQuickAdd,
}: {
  item: MenuItem;
  onOpen: () => void;
  onQuickAdd: () => void;
}) {
  return (
    <li className="py-4">
      <div className="flex gap-4 items-center">
        <button
          onClick={onOpen}
          className="w-20 h-20 shrink-0 rounded-xl bg-cream bg-cover bg-center block self-start"
          style={
            item.photoUrl
              ? { backgroundImage: `url(${item.photoUrl})` }
              : undefined
          }
          aria-label="Ver detalle"
        />
        <button onClick={onOpen} className="flex-1 min-w-0 text-left self-start">
          <div className="font-display text-lg leading-tight">{item.name}</div>
          <div className="font-mono text-sm tabular text-muted mt-0.5">
            {fmtCOP(item.priceCents)}
          </div>
          {item.ratingCount > 0 && (
            <div className="mt-1">
              <MenuStars avg={item.ratingAvg} count={item.ratingCount} />
            </div>
          )}
          {item.description && (
            <div className="text-sm text-muted line-clamp-2 mt-1">
              {item.description}
            </div>
          )}
          {item.tags.length > 0 && (
            <div className="mt-2">
              <ItemTags tags={item.tags} />
            </div>
          )}
        </button>
        <div className="shrink-0">
          <QuickAddButton onAdd={onQuickAdd} size="sm" />
        </div>
      </div>
    </li>
  );
}

function ItemCardGrid({
  item,
  onOpen,
  onQuickAdd,
}: {
  item: MenuItem;
  onOpen: () => void;
  onQuickAdd: () => void;
}) {
  return (
    <div className="flex flex-col">
      <button
        onClick={onOpen}
        className="relative w-full aspect-square rounded-2xl bg-cream bg-cover bg-center overflow-hidden"
        style={
          item.photoUrl ? { backgroundImage: `url(${item.photoUrl})` } : undefined
        }
        aria-label={item.name}
      >
        {item.tags.includes("firma") && (
          <div className="absolute top-2 left-2 bg-ink/85 text-paper font-mono text-[9px] tracking-[0.12em] uppercase px-1.5 py-0.5 rounded">
            De la casa
          </div>
        )}
      </button>
      <div className="mt-2 flex items-start gap-2">
        <button onClick={onOpen} className="text-left flex-1 min-w-0">
          <div className="font-display text-base leading-tight truncate">
            {item.name}
          </div>
          <div className="font-mono text-xs text-muted tabular mt-0.5">
            {fmtCOP(item.priceCents)}
          </div>
          {item.ratingCount > 0 && (
            <div className="mt-1">
              <MenuStars avg={item.ratingAvg} count={item.ratingCount} />
            </div>
          )}
        </button>
        <QuickAddButton onAdd={onQuickAdd} size="sm" />
      </div>
    </div>
  );
}

function ItemCardEditorial({
  item,
  index,
  onOpen,
  onQuickAdd,
}: {
  item: MenuItem;
  index: number;
  onOpen: () => void;
  onQuickAdd: () => void;
}) {
  // Every 3rd card is a big hero; the rest are list rows.
  const isHero = index % 3 === 0;
  if (!isHero) {
    return (
      <ul className="divide-y divide-hairline border-t border-hairline -mt-3 first:mt-0">
        <ItemRowList item={item} onOpen={onOpen} onQuickAdd={onQuickAdd} />
      </ul>
    );
  }
  return (
    <div className="flex flex-col">
      <button
        onClick={onOpen}
        className="w-full aspect-[4/3] rounded-2xl bg-cream bg-cover bg-center overflow-hidden"
        style={
          item.photoUrl ? { backgroundImage: `url(${item.photoUrl})` } : undefined
        }
        aria-label={item.name}
      />
      <div className="mt-3 flex items-center gap-3">
        <button onClick={onOpen} className="text-left flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-3 mb-1">
            <ItemTags tags={item.tags.slice(0, 2)} />
            <div className="font-mono text-sm tabular shrink-0">
              {fmtCOP(item.priceCents)}
            </div>
          </div>
          <div className="font-display text-2xl leading-tight tracking-[-0.015em]">
            {item.name}
          </div>
          {item.ratingCount > 0 && (
            <div className="mt-1.5">
              <MenuStars avg={item.ratingAvg} count={item.ratingCount} />
            </div>
          )}
          {item.description && (
            <div className="text-sm text-muted mt-1.5 leading-relaxed">
              {item.description}
            </div>
          )}
        </button>
        <QuickAddButton onAdd={onQuickAdd} size="sm" />
      </div>
    </div>
  );
}

function ItemSheet({
  item,
  onClose,
  onAdd,
}: {
  item: MenuItem;
  onClose: () => void;
  onAdd: (sel: Record<string, string>, qty: number, notes?: string) => void;
}) {
  const [selections, setSelections] = useState<Record<string, string>>(() => {
    const d: Record<string, string> = {};
    for (const m of item.modifiers ?? []) {
      if (m.default) d[m.id] = m.default;
    }
    return d;
  });
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState("");

  return (
    <div
      className="fixed inset-0 z-40 bg-black/40 flex items-end md:items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-paper w-full max-w-xl max-h-[92dvh] rounded-t-3xl md:rounded-3xl overflow-auto slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        {item.photoUrl && (
          <div
            className="h-56 w-full bg-cover bg-center bg-cream"
            style={{ backgroundImage: `url(${item.photoUrl})` }}
          />
        )}
        <div className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-display text-3xl tracking-[-0.015em] leading-tight">
                {item.name}
              </h2>
              <div className="font-mono text-base mt-2 tabular">
                {fmtCOP(item.priceCents)}
              </div>
              {item.ratingCount > 0 && (
                <div className="mt-2">
                  <MenuStars avg={item.ratingAvg} count={item.ratingCount} />
                </div>
              )}
            </div>
            <button
              onClick={onClose}
              className="w-9 h-9 rounded-full border border-hairline text-ink-3 flex items-center justify-center"
              aria-label="Cerrar"
            >
              ×
            </button>
          </div>
          <p className="text-ink-3 mt-3 leading-relaxed">{item.description}</p>

          {item.modifiers?.map((m) => (
            <div key={m.id} className="mt-6">
              <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
                {m.label}
              </div>
              <div className="flex gap-2 flex-wrap">
                {m.opts.map((opt) => {
                  const active = selections[m.id] === opt;
                  return (
                    <button
                      key={opt}
                      onClick={() =>
                        setSelections((s) => ({ ...s, [m.id]: opt }))
                      }
                      className={
                        "h-9 px-3 rounded-full text-sm border " +
                        (active
                          ? "bg-ink text-bone border-ink"
                          : "bg-ivory text-ink border-hairline")
                      }
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="mt-6">
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
              Notas para la cocina
            </div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Alergias, preferencias…"
              className="w-full px-3 py-2 rounded-lg border border-hairline bg-ivory text-sm focus:outline-none focus:border-terracotta"
            />
          </div>

          <div className="mt-6 flex items-center gap-4">
            <div className="flex items-center gap-2 bg-ivory border border-hairline rounded-full h-11 px-2">
              <button
                onClick={() => setQty((q) => Math.max(1, q - 1))}
                className="w-8 h-8 rounded-full hover:bg-cream"
              >
                −
              </button>
              <div className="font-mono w-6 text-center tabular">{qty}</div>
              <button
                onClick={() => setQty((q) => q + 1)}
                className="w-8 h-8 rounded-full hover:bg-cream"
              >
                +
              </button>
            </div>
            <button
              onClick={() => onAdd(selections, qty, notes || undefined)}
              className="flex-1 h-11 rounded-full bg-ink text-bone font-medium"
            >
              Añadir · {fmtCOP(item.priceCents * qty)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function GuestNameSheet({
  initial,
  canCancel,
  onSave,
  onClose,
}: {
  initial: string;
  canCancel: boolean;
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const trimmed = value.trim();
  const canSave = trimmed.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-end md:items-center justify-center"
      onClick={canCancel ? onClose : undefined}
    >
      <div
        className="bg-paper text-ink w-full max-w-md rounded-t-3xl md:rounded-3xl slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) onSave(trimmed);
          }}
          className="p-6"
        >
          <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">
            En esta mesa
          </div>
          <h3 className="font-display text-3xl tracking-[-0.015em] mt-1">
            ¿Cómo te llamamos?
          </h3>
          <p className="text-sm text-ink-3 mt-2 leading-relaxed">
            Así tus amigos pueden ver qué pediste tú y qué pidieron ellos.
          </p>
          <input
            autoFocus
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={40}
            placeholder="Tu nombre o apodo"
            className="mt-5 w-full h-12 px-4 rounded-xl border border-hairline bg-ivory text-base focus:outline-none focus:border-terracotta"
          />
          <div className="mt-5 flex gap-3">
            {canCancel && (
              <button
                type="button"
                onClick={onClose}
                className="h-11 px-5 rounded-full border border-hairline font-medium text-ink-3"
              >
                Cancelar
              </button>
            )}
            <button
              type="submit"
              disabled={!canSave}
              className="flex-1 h-11 rounded-full bg-ink text-bone font-medium disabled:opacity-50"
            >
              Guardar
            </button>
          </div>
          <p className="text-xs text-muted-2 mt-3">
            Solo se muestra a quienes comparten tu mesa. No creamos una cuenta.
          </p>
        </form>
      </div>
    </div>
  );
}

type PickupMethod =
  | "kushki_apple_pay"
  | "kushki_google_pay"
  | "demo_card"
  | "demo_nequi";

function PickupCheckoutSheet({
  tenantSlug,
  tableId,
  cart,
  subtotal,
  defaultName,
  defaultPhone,
  maxEtaMinutes,
  kushkiReady,
  kushkiPublicKey,
  isMockMode,
  onClose,
  onSuccess,
}: {
  tenantSlug: string;
  tableId: string;
  cart: CartLine[];
  subtotal: number;
  defaultName: string;
  defaultPhone: string;
  maxEtaMinutes: number | null;
  kushkiReady: boolean;
  kushkiPublicKey: string | null;
  isMockMode: boolean;
  onClose: () => void;
  onSuccess: (orderId: string) => void;
}) {
  const parsed = useMemo(() => splitDefaultPhone(defaultPhone), [defaultPhone]);
  const [name, setName] = useState(defaultName);
  const [countryCode, setCountryCode] = useState(parsed.countryCode);
  const [phone, setPhone] = useState(parsed.local);
  const [showCountry, setShowCountry] = useState(false);
  const country =
    findCountryByCode(countryCode) ?? findCountryByCode(DEFAULT_COUNTRY_CODE)!;
  const [eta, setEta] = useState<{
    minutes: number;
    loading: boolean;
    saturated: boolean;
    closed: boolean;
  }>({ minutes: 0, loading: true, saturated: false, closed: false });
  const [busy, setBusy] = useState<PickupMethod | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hasApplePay, setHasApplePay] = useState(false);
  const [hasGooglePay, setHasGooglePay] = useState(false);

  useEffect(() => {
    const w = window as unknown as { ApplePaySession?: { canMakePayments?: () => boolean } };
    setHasApplePay(!!w.ApplePaySession?.canMakePayments?.());
    setHasGooglePay(true);
  }, []);

  // Aggregate qty by menuItemId for ETA (ETA only needs items+qty, not modifiers).
  useEffect(() => {
    if (cart.length === 0) return;
    let cancelled = false;
    setEta((e) => ({ ...e, loading: true }));
    const agg = new Map<string, number>();
    for (const l of cart) agg.set(l.menuItemId, (agg.get(l.menuItemId) ?? 0) + l.qty);
    const payload = {
      items: Array.from(agg.entries()).map(([menuItemId, qty]) => ({
        menuItemId,
        qty,
      })),
    };
    fetch(`/api/tenant/${tenantSlug}/pickup/eta`, {
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
  }, [cart, tenantSlug]);

  async function placeAndPay(method: PickupMethod) {
    if (!name.trim()) {
      setErr("Necesitamos tu nombre para llamarte.");
      return;
    }
    const localNumber = phone.replace(/[^\d]/g, "");
    if (localNumber.length < 5) {
      setErr("Escribe tu número de celular para avisarte cuando esté listo.");
      return;
    }
    setBusy(method);
    setErr(null);

    // Kushki methods need a token from the JS SDK. Until we wire it in
    // production, mock mode accepts a placeholder; live mode would fail
    // gracefully if the SDK isn't loaded.
    let token: string | undefined;
    if (method === "kushki_apple_pay" || method === "kushki_google_pay") {
      if (kushkiPublicKey && !isMockMode) {
        // TODO: integrate Kushki JS SDK and tokenize here.
        setBusy(null);
        setErr("Apple/Google Pay aún no está activado para este restaurante.");
        return;
      }
      token = `mock-token-${Date.now()}`;
    }

    const body: Record<string, unknown> = {
      tableId,
      pickupName: name.trim(),
      pickupPhone: `+${country.dial} ${localNumber}`,
      method,
      items: cart.map((l) => ({
        menuItemId: l.menuItemId,
        qty: l.qty,
        selections: l.selections,
        notes: l.notes,
      })),
    };
    if (token) body.token = token;

    const res = await fetch(`/api/tenant/${tenantSlug}/pickup/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(null);
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
      } else if (j.error === "charge_declined") {
        setErr(j.message ?? "El pago fue rechazado por el banco.");
      } else {
        setErr(j.error ?? "No pudimos procesar tu pedido.");
      }
      return;
    }
    const j = await res.json();
    onSuccess(j.orderId);
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center">
      <div className="w-full md:max-w-md bg-bone rounded-t-3xl md:rounded-3xl border border-hairline shadow-xl max-h-[92dvh] overflow-y-auto">
        <div className="p-5 border-b border-hairline flex items-center justify-between">
          <div className="font-display text-xl">Recogida</div>
          <button
            onClick={onClose}
            className="text-muted text-sm"
            disabled={!!busy}
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
                      maxEtaMinutes ? ` (tope ${maxEtaMinutes} min)` : ""
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

          <div className="block">
            <span className="font-mono text-[10px] tracking-wider uppercase text-muted">
              Celular
            </span>
            <div className="mt-1 flex items-stretch gap-2">
              <button
                type="button"
                onClick={() => setShowCountry(true)}
                className="shrink-0 h-11 px-3 rounded-lg border border-hairline bg-paper flex items-center gap-2 text-sm"
                aria-label="Código de país"
              >
                <span className="text-base leading-none">{country.flag}</span>
                <span className="font-mono tabular">+{country.dial}</span>
                <span className="text-muted text-xs leading-none">▾</span>
              </button>
              <input
                type="tel"
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                maxLength={20}
                placeholder="300 123 4567"
                className="flex-1 min-w-0 h-11 px-3 rounded-lg border border-hairline bg-paper focus:outline-none focus:border-terracotta"
              />
            </div>
          </div>

          <div className="rounded-xl border border-hairline bg-paper p-3">
            <div className="font-mono text-[10px] tracking-wider uppercase text-muted mb-2">
              Tu pedido
            </div>
            <ul className="divide-y divide-hairline">
              {cart.map((l) => (
                <li
                  key={l.key}
                  className="py-1.5 flex items-start justify-between gap-3 text-sm"
                >
                  <div className="min-w-0">
                    <div className="truncate">
                      {l.qty}× {l.name}
                    </div>
                    {Object.values(l.selections).length > 0 && (
                      <div className="text-[11px] text-muted truncate">
                        {Object.values(l.selections).join(" · ")}
                      </div>
                    )}
                    {l.notes && (
                      <div className="text-[11px] text-muted-2 italic truncate">
                        “{l.notes}”
                      </div>
                    )}
                  </div>
                  <span className="font-mono tabular shrink-0">
                    {fmtCOP(l.priceCents * l.qty)}
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
            {kushkiReady && hasApplePay && (
              <button
                onClick={() => placeAndPay("kushki_apple_pay")}
                disabled={!!busy || eta.saturated || eta.closed}
                className="w-full h-12 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
              >
                {busy === "kushki_apple_pay"
                  ? "Procesando…"
                  : ` Pay · ${fmtCOP(subtotal)}`}
              </button>
            )}
            {kushkiReady && hasGooglePay && (
              <button
                onClick={() => placeAndPay("kushki_google_pay")}
                disabled={!!busy || eta.saturated || eta.closed}
                className="w-full h-12 rounded-full border border-hairline bg-paper text-ink text-sm font-medium disabled:opacity-60"
              >
                {busy === "kushki_google_pay"
                  ? "Procesando…"
                  : `G Pay · ${fmtCOP(subtotal)}`}
              </button>
            )}
            {isMockMode && !kushkiReady && (
              <>
                <button
                  onClick={() => placeAndPay("demo_card")}
                  disabled={!!busy || eta.saturated || eta.closed}
                  className="w-full h-12 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
                >
                  {busy === "demo_card"
                    ? "Procesando…"
                    : `Demo tarjeta · ${fmtCOP(subtotal)}`}
                </button>
                <button
                  onClick={() => placeAndPay("demo_nequi")}
                  disabled={!!busy || eta.saturated || eta.closed}
                  className="w-full h-12 rounded-full border border-hairline bg-paper text-ink text-sm font-medium disabled:opacity-60"
                >
                  {busy === "demo_nequi" ? "Procesando…" : `Demo Nequi`}
                </button>
                <div className="text-[11px] text-muted-2 text-center pt-1">
                  Modo demo. Activa Kushki para Apple/Google Pay.
                </div>
              </>
            )}
            <div className="text-[11px] text-muted text-center mt-1">
              Tu orden entra a cocina solo cuando el pago aprueba.
            </div>
          </div>
        </div>
      </div>
      {showCountry && (
        <CountryPicker
          selected={country.code}
          onSelect={(c) => {
            setCountryCode(c.code);
            setShowCountry(false);
          }}
          onClose={() => setShowCountry(false)}
        />
      )}
    </div>
  );
}

// Best-effort parse of a stored profile phone like "+57 300 123 4567" into
// a country + local number. Unknown or bare numbers default to Colombia
// and are shown as-is in the input.
function splitDefaultPhone(raw: string): {
  countryCode: string;
  local: string;
} {
  const s = raw.trim();
  if (!s) return { countryCode: DEFAULT_COUNTRY_CODE, local: "" };
  if (s.startsWith("+")) {
    const digits = s.slice(1).replace(/[^\d\s-]/g, "");
    const compact = digits.replace(/[^\d]/g, "");
    // Try longest dial first so "1" (US) doesn't eat "52" (MX) etc.
    const sorted = [...COUNTRIES].sort((a, b) => b.dial.length - a.dial.length);
    for (const c of sorted) {
      if (compact.startsWith(c.dial)) {
        return {
          countryCode: c.code,
          local: compact.slice(c.dial.length),
        };
      }
    }
  }
  return { countryCode: DEFAULT_COUNTRY_CODE, local: s };
}

function CountryPicker({
  selected,
  onSelect,
  onClose,
}: {
  selected: string;
  onSelect: (c: Country) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const list = q
    ? COUNTRIES.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.dial.includes(q.replace(/^\+/, "")) ||
          c.code.toLowerCase().includes(q),
      )
    : COUNTRIES;
  return (
    <div
      className="fixed inset-0 z-[60] bg-ink/50 flex items-end md:items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-md bg-bone rounded-t-3xl md:rounded-3xl border border-hairline shadow-xl flex flex-col max-h-[85dvh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-hairline">
          <div className="flex items-center justify-between mb-3">
            <div className="font-display text-lg">Código de país</div>
            <button
              type="button"
              onClick={onClose}
              className="w-8 h-8 rounded-full border border-hairline text-ink-3"
              aria-label="Cerrar"
            >
              ×
            </button>
          </div>
          <input
            autoFocus
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar país o código"
            className="w-full h-10 px-3 rounded-lg border border-hairline bg-paper text-sm focus:outline-none focus:border-terracotta"
          />
        </div>
        <ul className="overflow-y-auto flex-1">
          {list.length === 0 && (
            <li className="py-8 text-center text-sm text-muted">
              No encontramos ese país.
            </li>
          )}
          {list.map((c) => {
            const active = c.code === selected;
            return (
              <li key={c.code}>
                <button
                  type="button"
                  onClick={() => onSelect(c)}
                  className={
                    "w-full flex items-center gap-3 px-4 py-3 text-left text-sm border-b border-hairline/60 " +
                    (active ? "bg-terracotta/10" : "hover:bg-paper")
                  }
                >
                  <span className="text-lg leading-none">{c.flag}</span>
                  <span className="flex-1 truncate">{c.name}</span>
                  <span className="font-mono tabular text-muted">
                    +{c.dial}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

