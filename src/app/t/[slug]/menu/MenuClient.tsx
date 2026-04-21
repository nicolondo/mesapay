"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { fmtCOP } from "@/lib/format";

type Tenant = { slug: string; name: string; tagline: string | null };
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
  tableNumber,
  categories,
  items,
}: {
  tenant: Tenant;
  tableId: string;
  tableNumber: number;
  categories: Category[];
  items: MenuItem[];
}) {
  const router = useRouter();
  const [activeCat, setActiveCat] = useState<string>(categories[0]?.slug ?? "");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [openItem, setOpenItem] = useState<MenuItem | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const itemsByCat = useMemo(() => {
    const map = new Map<string, MenuItem[]>();
    for (const c of categories) map.set(c.id, []);
    for (const it of items) {
      map.get(it.categoryId)?.push(it);
    }
    return map;
  }, [items, categories]);

  const subtotal = cart.reduce((s, l) => s + l.priceCents * l.qty, 0);
  const totalQty = cart.reduce((s, l) => s + l.qty, 0);

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
    setSubmitting(true);
    const res = await fetch(`/api/tenant/${tenant.slug}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tableId,
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
    router.push(`/t/${tenant.slug}/order/${orderId}`);
  }

  return (
    <div className="flex flex-1 flex-col pb-36">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-bone/90 backdrop-blur border-b border-hairline">
        <div className="max-w-2xl mx-auto px-5 pt-5 pb-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-mono text-[9px] tracking-[0.16em] uppercase text-muted">
                Mesa {tableNumber} · {tenant.name}
              </div>
              <h1 className="font-display text-3xl tracking-[-0.015em]">
                La carta
              </h1>
            </div>
          </div>
          {/* Category chips */}
          <div className="mt-4 flex gap-2 overflow-x-auto scroll-hide -mx-5 px-5">
            {categories.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  setActiveCat(c.slug);
                  document.getElementById(`cat-${c.slug}`)?.scrollIntoView({
                    behavior: "smooth",
                    block: "start",
                  });
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
        {categories.map((c) => {
          const rows = itemsByCat.get(c.id) ?? [];
          if (!rows.length) return null;
          return (
            <section key={c.id} id={`cat-${c.slug}`} className="scroll-mt-28">
              <div className="font-display text-2xl mb-3">{c.label}</div>
              <ul className="divide-y divide-hairline border-t border-hairline">
                {rows.map((it) => (
                  <li key={it.id}>
                    <button
                      onClick={() => setOpenItem(it)}
                      className="w-full text-left py-4 flex gap-4"
                    >
                      {it.photoUrl ? (
                        <div
                          className="w-20 h-20 rounded-xl bg-cream shrink-0 bg-cover bg-center"
                          style={{ backgroundImage: `url(${it.photoUrl})` }}
                        />
                      ) : (
                        <div className="w-20 h-20 rounded-xl bg-cream shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-3">
                          <div className="font-display text-lg leading-tight">
                            {it.name}
                          </div>
                          <div className="font-mono text-sm tabular shrink-0">
                            {fmtCOP(it.priceCents)}
                          </div>
                        </div>
                        <div className="text-sm text-muted line-clamp-2 mt-1">
                          {it.description}
                        </div>
                        {it.tags.length > 0 && (
                          <div className="flex gap-1.5 mt-2">
                            {it.tags.map((t) => (
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
                        )}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
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

      {/* Cart bar */}
      {cart.length > 0 && !openItem && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 w-[calc(100%-2rem)] max-w-xl">
          <div className="bg-ink text-bone rounded-2xl shadow-[0_10px_40px_rgba(0,0,0,0.3)] px-5 py-4 flex items-center gap-4 slide-up">
            <div className="flex-1">
              <div className="font-mono text-[10px] tracking-[0.16em] uppercase opacity-60">
                Tu pedido
              </div>
              <div className="font-display text-xl">
                {totalQty} {totalQty === 1 ? "item" : "items"} · {fmtCOP(subtotal)}
              </div>
            </div>
            <button
              onClick={() => {
                const el = document.getElementById("cart-drawer");
                el?.scrollIntoView();
              }}
            >
              <CartDrawer
                lines={cart}
                onQty={setQty}
                onRemove={removeLine}
                subtotal={subtotal}
                submitting={submitting}
                onSend={sendToKitchen}
              />
            </button>
          </div>
        </div>
      )}
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
        className="bg-paper w-full max-w-xl max-h-[92vh] rounded-t-3xl md:rounded-3xl overflow-auto slide-up"
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

function CartDrawer({
  lines,
  onQty,
  onRemove,
  subtotal,
  submitting,
  onSend,
}: {
  lines: CartLine[];
  onQty: (key: string, qty: number) => void;
  onRemove: (key: string) => void;
  subtotal: number;
  submitting: boolean;
  onSend: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className="font-medium underline underline-offset-4"
      >
        Ver pedido
      </span>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/40 flex items-end md:items-center justify-center"
          onClick={() => setOpen(false)}
        >
          <div
            className="bg-paper text-ink w-full max-w-xl max-h-[88vh] rounded-t-3xl md:rounded-3xl overflow-auto slide-up"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6">
              <div className="flex items-start justify-between">
                <h3 className="font-display text-3xl tracking-[-0.015em]">
                  Tu pedido
                </h3>
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
              <div className="mt-5 pt-4 border-t border-hairline flex items-center justify-between">
                <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
                  Subtotal
                </div>
                <div className="font-display text-2xl">{fmtCOP(subtotal)}</div>
              </div>
              <button
                onClick={onSend}
                disabled={submitting}
                className="mt-5 w-full h-12 rounded-full bg-terracotta text-paper font-medium disabled:opacity-60"
              >
                {submitting ? "Enviando…" : "Enviar a cocina"}
              </button>
              <p className="text-xs text-muted-2 text-center mt-3">
                Podrás añadir más platos durante la comida.
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
