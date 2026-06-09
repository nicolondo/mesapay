"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import Link from "next/link";
import { fmtCOP } from "@/lib/format";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";
import { useVisibleEventSource } from "@/lib/useVisibleEventSource";
import {
  COUNTRIES,
  DEFAULT_COUNTRY_CODE,
  findCountryByCode,
  type Country,
} from "@/lib/countries";
import type { MenuTag } from "@/lib/menuTags";
import { CallWaiterFab } from "./CallWaiterFab";

type MenuLayout = "list" | "grid" | "editorial";

type Tenant = {
  slug: string;
  name: string;
  tagline: string | null;
  serviceMode: "table" | "counter";
  // Logo del comercio para el header del menú. Null cae al logo
  // MESAPAY (resuelto via /lib/branding.ts).
  logoUrl?: string | null;
};
type Category = { id: string; slug: string; label: string; menuId: string };
type MenuTab = {
  id: string;
  slug: string;
  label: string;
  description: string | null;
};
type ModOpt = { label: string; priceDeltaCents?: number };
type ModifierDef = {
  id: string;
  label: string;
  type: "radio" | "checkbox";
  opts: ModOpt[];
  default?: string;
};

// A selection value is either a single label (radio) or a list of
// labels (checkbox). Empty arrays mean "nothing picked" for an
// optional checkbox modifier.
type SelectionValue = string | string[];
type Selections = Record<string, SelectionValue>;
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
  // Effective price per unit, already including any modifier deltas
  // the diner picked. Server recomputes from raw selections + the
  // live menu when the round is sent.
  priceCents: number;
  qty: number;
  selections: Selections;
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

// Style palette for the built-in tag slugs. Custom tags created by the
// operator fall back to a neutral pill — keeps the diner-side visual
// language calm regardless of how many tags the restaurant defines.
const TAG_STYLES: Record<string, string> = {
  firma: "bg-[#B8893B]/12 text-[#8F6828]",
  popular: "bg-ink/10 text-ink",
  veg: "bg-[#5C6B3B]/15 text-[#42502A]",
  spicy: "bg-terracotta/15 text-terracotta",
  nuevo: "bg-[#2E6B4C]/15 text-[#1E5339]",
};
const NEUTRAL_TAG_STYLE = "bg-paper text-muted border border-hairline";

/**
 * Render a cart line's selections as a readable list of groups for the
 * "Tu pedido" sheet. Each group reads like "Adicion: Pollo, Carne"
 * — we need the modifier definitions from the menu item to know the
 * group label ("Adicion") since `selections` only carries IDs.
 *
 * Falls back to a flat list of values when the menu item isn't found
 * (defensive — shouldn't happen but keeps the cart usable instead of
 * blank if the items prop drifts from the cart).
 */
function formatLineSelections(
  selections: Selections,
  item: MenuItem | undefined,
): string[] {
  if (!selections || Object.keys(selections).length === 0) return [];
  if (!item?.modifiers) {
    // No modifier defs to look up labels — flatten what we have.
    const out: string[] = [];
    for (const v of Object.values(selections)) {
      if (typeof v === "string" && v.trim()) out.push(v);
      else if (Array.isArray(v)) {
        const labels = v.filter((x) => typeof x === "string" && x.trim());
        if (labels.length > 0) out.push(labels.join(", "));
      }
    }
    return out;
  }
  const out: string[] = [];
  // Iterate modifier defs (not selections) so the order matches the
  // sheet's display order — diner reads "Adición: ..." in the same
  // sequence they saw it on the plate.
  for (const m of item.modifiers) {
    const sel = selections[m.id];
    if (sel == null) continue;
    const labels =
      typeof sel === "string" ? [sel] : Array.isArray(sel) ? sel : [];
    const cleaned = labels.filter((x) => typeof x === "string" && x.trim());
    if (cleaned.length === 0) continue;
    out.push(`${m.label}: ${cleaned.join(", ")}`);
  }
  return out;
}

/**
 * Normalize a string for forgiving menu search. Goals:
 *  - Accents and ñ shouldn't matter: "café" finds "Cafe", "piña" finds "pina".
 *  - Punctuation shouldn't matter: "Sangría, espumosa" matches "sangria espumosa".
 *  - Common Spanish letter swaps shouldn't matter:
 *      pescado ↔ pezcado    (soft c / z → s)
 *      cafe    ↔ kafe       (hard c / qu → k)
 *      vaso    ↔ baso       (b / v → b)
 *      ola     ↔ hola       (silent h dropped)
 *      yegua   ↔ llegua     (ll / y → i)
 *  - Whitespace collapses to single spaces.
 *
 * The transformation runs on both the query and the haystack, so any
 * collision is symmetric — typing "vaka" finds "vaca" because both
 * normalize to "baka". For a Colombian carta the false-positive rate
 * is small enough that we'd rather over-match than reject a typo.
 */
function fuzzyNormalize(s: string): string {
  let out = s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // strip combining accents
  out = out
    .replace(/ñ/g, "n")
    .replace(/[^a-z0-9 ]+/g, " "); // punctuation → space
  // Order matters here. Digraphs first so we don't shred them.
  out = out
    .replace(/qu/g, "k") // qu always sounds like k: quilo → kilo
    .replace(/ll/g, "i") // ll sounds like i/y: llave → iave
    // Soft c (before e/i/y) sounds like s; hard c (everywhere else)
    // sounds like k. Splitting the rule keeps "cafe" → "kafe" and
    // "cesta" → "sesta" both correct.
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/z/g, "s")
    .replace(/[bv]/g, "b")
    .replace(/h/g, "") // silent h: huevo → uevo, hola → ola
    .replace(/y/g, "i")
    .replace(/\s+/g, " ")
    .trim();
  return out;
}

export function MenuClient({
  tenant,
  tableId,
  tableQrToken,
  initialWaiterCalled = false,
  locationLabel,
  menus = [],
  menuTags = [],
  categories,
  items,
  activeOrder,
  pickup,
  operatorMode = false,
  postSendHref = "/operator/serve",
  dockBottomClass = "bottom-4",
  modalBottomReserveRem = 0,
}: {
  tenant: Tenant;
  tableId: string;
  // QR token de la mesa — necesario para el endpoint by-table del
  // FAB "Llamar mesero" (funciona con o sin orden activa). Opcional
  // para back-compat con consumers que no lo pasan (ej: /p/[slug]
  // pickup, mesero/pedir cuando todavía no se ha resuelto la mesa);
  // si falta, el FAB no se renderea.
  tableQrToken?: string;
  // Estado inicial del FAB — true si ya hay llamada pendiente (sea
  // a nivel de orden o de mesa) cuando se cargó la página.
  initialWaiterCalled?: boolean;
  locationLabel: string;
  // Top-level menus (Carta, Vinos, etc.). Optional / single-element
  // means no tab strip is rendered. Server always sends at least one
  // entry once ensureDefaultMenu() has run.
  menus?: MenuTab[];
  // Registro de etiquetas del restaurante (slug → label + emoji).
  // Si llega vacío no se renderiza ningún chip de etiqueta.
  menuTags?: MenuTag[];
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
  // Server-verified flag: this view is being driven by a logged-in
  // operator taking a pedido on behalf of a diner who doesn't have a
  // phone handy. Disables the "Yo soy …" sheet prompt, swaps the
  // bottom-dock copy, and after sending bounces back to staff land
  // instead of the diner-side order-tracking page.
  operatorMode?: boolean;
  // Destino post-envío en operatorMode. Operator/admin → /operator/serve
  // (default). Mesero → /mesero/salon (el operator layout está gated
  // y un mesero rebotaría a /). Puede ser cualquier URL absoluta.
  postSendHref?: string;
  // Cuando el menú se renderiza dentro de un layout con bottom nav
  // (caso /mesero/pedir/[id]), el dock fijo "Enviar a cocina" choca
  // con la nav. Empujarlo hacia arriba via clase Tailwind. Default
  // "bottom-4" mantiene el comportamiento histórico.
  dockBottomClass?: string;
  // Espacio reservado al fondo de los modales fullscreen del menú
  // (carta, "Tu pedido", item detail) para no quedar tapados por la
  // bottom nav. iOS pone la nav al ras del viewport y los modales
  // con items-end llegaban hasta abajo, ocultando el botón principal.
  // En PWA mesero pasamos ~5rem.
  modalBottomReserveRem?: number;
}) {
  const router = useRouter();
  const tMenu = useTranslations("menu");
  // Idioma activo del comensal (cookie MESAPAY_LOCALE) — lo adjuntamos al
  // beacon de captura de búsquedas para que Pulso pueda segmentar términos
  // por idioma. Es solo telemetría; no afecta el render.
  const locale = useLocale();
  // Active top-level menu tab. Hidden entirely when there's only one
  // menu (default case). Falls back to first menu id if anything is off.
  const [activeMenuId, setActiveMenuId] = useState<string>(
    menus[0]?.id ?? "",
  );
  const showMenuTabs = menus.length > 1;
  // Categories shown in the chip strip + sections, scoped to the
  // active menu when tabs are visible. When there's a single menu, the
  // filter is a no-op so legacy single-menu restaurants render the
  // same as before.
  const scopedCategories = showMenuTabs
    ? categories.filter((c) => c.menuId === activeMenuId)
    : categories;
  const [activeCat, setActiveCat] = useState<string>(
    scopedCategories[0]?.slug ?? "",
  );
  // Popup con la lista vertical de todas las categorías (atajo de salto).
  const [showCatList, setShowCatList] = useState(false);
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
  const chipsScrollerRef = useRef<HTMLDivElement>(null);
  const chipRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  // While true, scroll-spy ignores natural scroll updates — used during
  // the smooth-scroll triggered by clicking a chip so the active chip
  // doesn't flicker through every intermediate section. We use a token
  // counter (instead of Date.now) so the linter doesn't flag impurity.
  const spyMuteTokenRef = useRef<number>(0);

  function scrollToCategory(slug: string) {
    const el = document.getElementById(`cat-${slug}`);
    if (!el) return;
    const headerH = headerRef.current?.getBoundingClientRect().height ?? 0;
    const y = window.scrollY + el.getBoundingClientRect().top - headerH - 12;
    // Mute scroll-spy for the duration of the smooth scroll. Smooth
    // scroll typically finishes within ~600ms; 900ms gives us comfort.
    const myToken = ++spyMuteTokenRef.current;
    window.scrollTo({ top: y, behavior: "smooth" });
    setTimeout(() => {
      // Only clear if no newer mute superseded ours.
      if (spyMuteTokenRef.current === myToken) {
        spyMuteTokenRef.current = 0;
      }
    }, 900);
  }

  // Keep the active chip visible in the horizontal strip — when the
  // current section changes via scroll-spy, slide the matching chip into
  // view so the user can see the label of the section they're reading.
  function ensureChipVisible(slug: string) {
    const chip = chipRefs.current.get(slug);
    const scroller = chipsScrollerRef.current;
    if (!chip || !scroller) return;
    const chipRect = chip.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const pad = 16;
    if (chipRect.left < scrollerRect.left + pad) {
      scroller.scrollBy({
        left: chipRect.left - scrollerRect.left - pad,
        behavior: "smooth",
      });
    } else if (chipRect.right > scrollerRect.right - pad) {
      scroller.scrollBy({
        left: chipRect.right - scrollerRect.right + pad,
        behavior: "smooth",
      });
    }
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
    else if (operatorMode) {
      // El mesero/operator está tomando el pedido por el cliente. En
      // vez de pedirle un nombre (no es relevante para reportes y
      // genera un sheet extra), atamos los items a un guest "Mesero"
      // por defecto. Sirve también de marcador en la cuenta de quién
      // ingresó cada ronda. No tocamos localStorage para no
      // contaminar futuras sesiones del mismo dispositivo si lo
      // usara un comensal.
      setGuestName("Mesero");
    } else if (!isPickup) {
      // Cliente sin nombre guardado → pedirle que se identifique.
      setShowNameSheet(true);
    }
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
    // First-load fix: opening the name sheet auto-focuses its input,
    // which on mobile makes Safari/Chrome push the underlying page up
    // so the input + soft keyboard fit. After dismissing the sheet the
    // page is left scrolled a few hundred pixels down — confusing on a
    // brand-new visit where the diner expects to land at the top of the
    // carta. We snap back on the next microtask, once React has
    // unmounted the sheet and the keyboard has retracted.
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    });
  }

  // Live-refresh the "pedido abierto en esta mesa" banner when another
  // diner at the same table sends or updates a round. Visibility-aware:
  // los diners dejan la carta abierta en segundo plano por largos ratos;
  // cerrar el SSE mientras está oculta libera el socket (HTTP/1.1 cap).
  useVisibleEventSource(
    `/api/tenant/${tenant.slug}/events`,
    (es) => es.addEventListener("message", () => router.refresh()),
    () => router.refresh(),
  );

  // Scroll-spy: as the user scrolls through the menu, highlight the chip
  // that matches the section they're currently reading. We find the
  // section whose top has just passed the trigger line (just below the
  // sticky header) — that's "the one whose title the user can see at the
  // top of the visible area". rAF-throttled so it stays cheap on long
  // menus (some restaurants have 200+ items, 25+ sections).
  //
  // We use a ref instead of comparing against `activeCat` directly: the
  // effect only re-binds on category changes (we don't want every chip
  // tap to tear down the scroll listener), so the closure would
  // otherwise see a stale activeCat — that produced an annoying bug
  // where scrolling down then back to the top wouldn't re-activate
  // "Entrada" because the stale closure still thought it was active.
  const activeCatRef = useRef(activeCat);
  activeCatRef.current = activeCat;
  useEffect(() => {
    if (scopedCategories.length === 0) return;
    let rafId: number | null = null;
    function evaluate() {
      rafId = null;
      if (spyMuteTokenRef.current !== 0) return;
      const headerH = headerRef.current?.getBoundingClientRect().height ?? 0;
      let bestSlug: string | null = null;
      // Hard override at the very top of the page: when the user
      // hasn't scrolled (or just scrolled back to the top), the active
      // chip should always be the first category — regardless of how
      // the trigger-line maths plays out. Without this, a carta whose
      // first category has few items (e.g. Malbec with one wine) sees
      // BOTH its title AND the next one above the trigger line at
      // scrollY=0, and the "closest to trigger from above" tiebreak
      // picks the SECOND. The result: you scroll back to the top, see
      // Malbec on screen, but the chip says the next category. Fixed
      // by short-circuiting the algorithm in this exact range.
      if (window.scrollY < 16) {
        bestSlug = scopedCategories[0]?.slug ?? null;
      } else {
        // Trigger line about a third of the way down the visible
        // content area (capped at 200px). Earlier we used header+16,
        // which only activated a section AFTER its title had nearly
        // left the screen — so the user would be reading "Molcajete"
        // content while the chip still said "Tartar". With the line
        // lower, a section becomes active the moment its title
        // crosses into the upper third of the viewport, which
        // matches where the eye lands.
        const viewportH = window.innerHeight;
        const triggerY =
          headerH + Math.min(200, (viewportH - headerH) * 0.33);
        // DOM iteration order may differ from `categories` array
        // order (filtered, hidden sections, etc.). We track the
        // highest `top` value still ≤ triggerY across all rendered
        // sections rather than breaking early on the array order —
        // more robust to changes.
        let bestTop = -Infinity;
        for (const c of scopedCategories) {
          const el = document.getElementById(`cat-${c.slug}`);
          if (!el) continue;
          const top = el.getBoundingClientRect().top;
          if (top - triggerY <= 0 && top > bestTop) {
            bestTop = top;
            bestSlug = c.slug;
          }
        }
        // Edge case: top of page, before any section has crossed yet —
        // default to the first one so the chip strip isn't blank.
        if (!bestSlug) bestSlug = scopedCategories[0]?.slug ?? null;
      }
      if (bestSlug && bestSlug !== activeCatRef.current) {
        setActiveCat(bestSlug);
        ensureChipVisible(bestSlug);
      }
    }
    function onScroll() {
      if (rafId != null) return;
      rafId = requestAnimationFrame(evaluate);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    // Run once on mount in case we land somewhere other than the top.
    evaluate();
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (rafId != null) cancelAnimationFrame(rafId);
    };
    // We intentionally don't depend on activeCat — the effect would
    // re-bind every chip click. evaluate() reads it via closure freshly
    // each frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedCategories]);

  const itemsByCat = useMemo(() => {
    const q = fuzzyNormalize(query);
    const map = new Map<string, MenuItem[]>();
    // Only the categories of the currently-active menu — items whose
    // category lives in a different menu just don't get a bucket and
    // are filtered out implicitly below.
    for (const c of scopedCategories) map.set(c.id, []);
    for (const it of items) {
      if (q) {
        // Match against name + description with the same fuzzy
        // normalization applied — strips accents/punctuation and
        // collapses common Spanish letter swaps so "pezcado" still
        // finds "Pescado al ajillo", "limon" finds "Limón", etc.
        const hay = fuzzyNormalize(`${it.name} ${it.description ?? ""}`);
        if (!hay.includes(q)) continue;
      }
      map.get(it.categoryId)?.push(it);
    }
    return map;
  }, [items, scopedCategories, query]);

  const searching = query.trim().length > 0;
  const visibleCount = searching
    ? Array.from(itemsByCat.values()).reduce((s, arr) => s + arr.length, 0)
    : 0;

  // Captura de búsquedas del comensal para la herramienta `top_searches`
  // de Pulso. Fire-and-forget con debounce: cuando el comensal pausa de
  // escribir (≥2 chars) mandamos el término normalizado del lado servidor,
  // el conteo de resultados que está viendo y su idioma. No bloquea ni
  // altera el comportamiento de búsqueda — cualquier fallo se traga en
  // silencio para nunca romper la carta.
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) return;
    const id = setTimeout(() => {
      const url = `/api/tenant/${tenant.slug}/search-log`;
      const payload = JSON.stringify({
        term,
        resultCount: visibleCount,
        locale,
      });
      try {
        if (
          typeof navigator !== "undefined" &&
          typeof navigator.sendBeacon === "function"
        ) {
          navigator.sendBeacon(
            url,
            new Blob([payload], { type: "application/json" }),
          );
        } else {
          // sendBeacon ausente (algunos navegadores viejos / entornos):
          // fetch con keepalive sobrevive a la navegación igual que el beacon.
          fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: payload,
            keepalive: true,
          }).catch(() => {});
        }
      } catch {
        // best-effort: nunca rompemos la búsqueda del comensal
      }
    }, 800);
    return () => clearTimeout(id);
  }, [query, visibleCount, tenant.slug, locale]);

  // Flat ordered list of currently-visible items, used by the detail
  // sheet for swipe navigation (left = next, right = prev). The order
  // mirrors the rendered list — categories in their sortOrder, items
  // within each category in their sortOrder. Filtering shrinks the
  // pool so swipes only move between dishes the user can see.
  const flatVisibleItems = useMemo(() => {
    const out: MenuItem[] = [];
    for (const c of scopedCategories) {
      const arr = itemsByCat.get(c.id) ?? [];
      for (const it of arr) out.push(it);
    }
    return out;
  }, [scopedCategories, itemsByCat]);

  const openItemIndex = openItem
    ? flatVisibleItems.findIndex((it) => it.id === openItem.id)
    : -1;
  const prevItem =
    openItemIndex > 0 ? flatVisibleItems[openItemIndex - 1] : null;
  const nextItem =
    openItemIndex >= 0 && openItemIndex < flatVisibleItems.length - 1
      ? flatVisibleItems[openItemIndex + 1]
      : null;

  /**
   * Close the sheet and scroll the page back to the dish the diner was
   * looking at. They might have opened it from anywhere in a long carta
   * and swiped through three more — we want them to land on the *last*
   * one viewed, not the one they originally tapped.
   *
   * We read the current openItem via a ref so the stale-closure inside
   * the popstate listener (registered once at mount with [] deps) can
   * still see the latest swiped-to dish. Without the ref a back-gesture
   * after swiping would close the sheet but read openItem=null and
   * skip the scroll entirely.
   */
  const openItemRef = useRef(openItem);
  openItemRef.current = openItem;
  function closeItemSheet() {
    const closedId = openItemRef.current?.id ?? null;
    setOpenItem(null);
    if (!closedId) return;
    // Two layers of stomp-protection here, because this single
    // operation has been flaky for months:
    //
    //   1. The browser's automatic scroll restoration kicks in on
    //      history.back() (which fires for the device back-gesture
    //      path). It snaps the page to where scrollY was when we
    //      pushed the sheet entry — i.e. the dish the diner
    //      *originally* tapped — overwriting whatever we just did
    //      with scrollIntoView. We pre-emptively turn that off on
    //      mount (see effect below); here we also re-disable it
    //      defensively in case some other navigation flipped it on.
    //   2. Even with restoration off, the browser still runs its
    //      own layout pass after popstate. If we scroll inside the
    //      same frame the dish sheet unmounted, the new layout
    //      isn't finalised yet and the scroll lands at the wrong
    //      offset. We chain two rAFs + a 0ms timeout so we're
    //      guaranteed to run AFTER React paints + AFTER the browser
    //      finishes any post-popstate work.
    if (typeof window !== "undefined" && "scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual";
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(() => {
          const el = document.getElementById(`menu-item-${closedId}`);
          if (!el) return;
          el.scrollIntoView({ behavior: "auto", block: "center" });
        }, 0);
      });
    });
  }

  // Wire the device / browser back button to the sheet so a swipe-back
  // gesture (iOS) or hardware back (Android) closes the modal instead
  // of leaving the carta entirely. We push a sentinel history entry
  // when a dish opens and consume it on close; swiping between dishes
  // doesn't touch history (one back = exit the modal, regardless of
  // how many dishes the diner browsed inside it).
  const sheetHistoryActiveRef = useRef(false);
  const skipNextPopRef = useRef(false);
  useEffect(() => {
    if (openItem && !sheetHistoryActiveRef.current) {
      window.history.pushState({ mesapaySheet: true }, "");
      sheetHistoryActiveRef.current = true;
    } else if (!openItem && sheetHistoryActiveRef.current) {
      sheetHistoryActiveRef.current = false;
      // If the close came from a popstate (back button) the history
      // entry is already gone — skip the explicit back() to avoid
      // double-popping the previous page.
      if (skipNextPopRef.current) {
        skipNextPopRef.current = false;
      } else {
        window.history.back();
      }
    }
  }, [openItem]);
  // Take over scroll restoration once at mount. Without this the
  // browser snaps the page back to where scrollY was when the dish
  // sheet first opened, fighting against our scrollIntoView in
  // closeItemSheet and landing the diner on the dish they originally
  // tapped instead of the last one they swiped to. Setting this to
  // "manual" stays in effect for the life of the document.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("scrollRestoration" in window.history)) return;
    const original = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    return () => {
      window.history.scrollRestoration = original;
    };
  }, []);
  useEffect(() => {
    function onPop() {
      if (sheetHistoryActiveRef.current) {
        skipNextPopRef.current = true;
        closeItemSheet();
      }
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const subtotal = cart.reduce((s, l) => s + l.priceCents * l.qty, 0);
  const totalQty = cart.reduce((s, l) => s + l.qty, 0);

  function quickAdd(item: MenuItem) {
    // Quick-add can only fire when there's nothing to choose. If any
    // modifier needs the diner's input (radio with no default, or any
    // checkbox at all — since those let the diner add extras like
    // "+camarón"), we open the sheet so they can decide.
    const mods = item.modifiers ?? [];
    const needsInput = mods.some(
      (m) => m.type === "checkbox" || !m.default,
    );
    if (needsInput) {
      setOpenItem(item);
      return;
    }
    const selections: Selections = {};
    for (const m of mods) {
      if (m.default) selections[m.id] = m.default;
    }
    addToCart(item, selections, 1);
  }

  function addToCart(
    item: MenuItem,
    selections: Selections,
    qty = 1,
    notes?: string,
  ) {
    // Snapshot the price the diner is seeing — includes whatever
    // modifier deltas they picked. The server still recomputes from
    // the live menu at send time as a guardrail.
    const priceCents = effectiveItemPrice(item, selections);
    const key =
      item.id + "::" + JSON.stringify(selections) + "::" + (notes ?? "");
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
          priceCents,
          qty,
          selections,
          notes,
        },
      ];
    });
  }

  /**
   * Sum the price deltas of whatever options the diner selected so the
   * cart line shows the price they'll actually pay (e.g. "Tacos +
   * Camarón = $48.000"). Mirrors the server's
   * computeSelectionsPriceDelta logic.
   */
  function effectiveItemPrice(
    item: MenuItem,
    selections: Selections,
  ): number {
    let total = item.priceCents;
    for (const m of item.modifiers ?? []) {
      const v = selections[m.id];
      if (v == null) continue;
      const labels = typeof v === "string" ? [v] : v;
      for (const lab of labels) {
        const opt = m.opts.find((o) => o.label === lab);
        if (opt?.priceDeltaCents) total += opt.priceDeltaCents;
      }
    }
    return Math.max(0, total);
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
    // try/finally para que setSubmitting(false) siempre corra — sin
    // esto, una network error / deploy en curso / cualquier throw
    // dejaba el botón eternamente en "Enviando…".
    let orderId: string | null = null;
    try {
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
      if (!res.ok) {
        alert("No pudimos enviar el pedido. Intenta de nuevo.");
        return;
      }
      const json = await res.json();
      orderId = json.orderId;
    } catch (err) {
      console.error("[sendToKitchen]", err);
      alert(tMenu("sendError"));
      return;
    } finally {
      setSubmitting(false);
    }
    if (!orderId) return;
    try {
      localStorage.removeItem(cartKey);
    } catch {}
    setCart([]);
    if (operatorMode) {
      // After the waiter sends the pedido they should be back at their
      // own work surface, not stuck on a customer order-tracking view.
      // postSendHref viene del server según el rol — operator →
      // /operator/serve, mesero → /mesero/salon.
      router.push(postSendHref);
      return;
    }
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
    <div
      className="flex flex-1 flex-col pb-36"
      style={
        // CSS var consumida por los modales del menú (cart sheet,
        // item sheet, etc.) para reservar espacio inferior cuando
        // viven dentro de un layout con bottom nav (PWA mesero).
        // Cascade por DOM tree — los modales son descendientes de
        // este div aunque visualmente sean fixed.
        {
          "--menu-modal-bottom-reserve": `${modalBottomReserveRem}rem`,
        } as React.CSSProperties
      }
    >
      {operatorMode && (
        <div className="bg-ink text-bone px-5 py-2 text-xs flex items-center justify-between gap-3">
          <span>
            <span className="font-mono tracking-wider uppercase opacity-70 mr-2">
              {tMenu("waiterMode")}
            </span>
            {tMenu.rich("takingOrderAt", {
              location: locationLabel,
              b: (chunks) => <strong>{chunks}</strong>,
            })}
          </span>
          <Link
            href="/operator/tables"
            className="font-mono text-[10px] tracking-wider uppercase underline opacity-80"
          >
            {tMenu("backToTables")}
          </Link>
        </div>
      )}
      {/* Header */}
      <header
        ref={headerRef}
        className="sticky top-0 z-20 bg-bone/90 backdrop-blur border-b border-hairline"
      >
        <div className="max-w-2xl mx-auto px-5 pt-3 pb-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              {/* Logo del comercio. Fallback al logo MESAPAY si no
                  subieron uno (resolveLogoSrc encapsula la lógica). */}
              <img
                src={
                  tenant.logoUrl && tenant.logoUrl.trim()
                    ? tenant.logoUrl
                    : "/icons/icon-192.png"
                }
                alt={tenant.name}
                className="w-9 h-9 rounded-lg object-contain bg-paper border border-hairline shrink-0"
              />
              <div className="min-w-0 leading-tight">
                <div className="font-mono text-[9px] tracking-[0.16em] uppercase text-muted truncate">
                  {locationLabel} · {tenant.name}
                </div>
                <h1 className="font-display text-xl tracking-[-0.015em] leading-tight">
                  {tMenu("title")}
                </h1>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {/* Desktop: el selector vive en el cluster del header.
                  En móvil se mueve abajo (ver bloque sm:hidden) para no
                  apretar la fila de íconos. */}
              <span className="hidden sm:inline-flex">
                <LocaleSwitcher />
              </span>
              <LayoutSwitcher layout={layout} onChange={changeLayout} />
              {/* Llamar al mesero — siempre visible cuando es modo
                  mesa (sin pickup). El endpoint by-table maneja
                  ambos casos: si hay orden activa marca needsWaiter
                  ahí; si no, marca Table.waiterCalledAt. FAB compact
                  (w-9 h-9) para no robar espacio al header. */}
              {!isPickup && tableQrToken && (
                <CallWaiterFab
                  tenantSlug={tenant.slug}
                  qrToken={tableQrToken}
                  initialCalled={initialWaiterCalled}
                />
              )}
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
          <div className="mt-2.5 flex items-center gap-2">
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
                      {tMenu("iAm")} ·{" "}
                      <span className="text-ink font-medium">{guestName}</span>
                    </>
                  ) : (
                    <span className="text-terracotta">{tMenu("tellUsName")}</span>
                  )}
                </span>
              </button>
            )}
            <div className="relative flex-1 min-w-0">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={tMenu("searchPlaceholder")}
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
                  aria-label={tMenu("clearSearch")}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-ink/5 text-ink-3 flex items-center justify-center text-base leading-none hover:bg-ink/10"
                >
                  ×
                </button>
              )}
            </div>
            {/* Idioma (móvil): chip compacto al final de la fila del
                buscador. En desktop el selector vive en el header. */}
            <span className="sm:hidden shrink-0">
              <LocaleSwitcher />
            </span>
          </div>

          {/* Top-level menu tabs (Carta, Vinos, Bebidas...). Hidden
              when there's only one menu so most restaurants don't
              see any new chrome. */}
          {showMenuTabs && (
            <div className="mt-3 flex gap-2 -mx-5 px-5 overflow-x-auto scroll-hide">
              {menus.map((m) => {
                const active = m.id === activeMenuId;
                return (
                  <button
                    key={m.id}
                    onClick={() => {
                      setActiveMenuId(m.id);
                      // Reset the chip selection + scroll to top of
                      // the new menu so the diner starts fresh.
                      window.scrollTo({ top: 0, behavior: "auto" });
                    }}
                    className={
                      "shrink-0 px-5 h-10 rounded-full text-sm font-display tracking-[-0.01em] border-2 transition-colors " +
                      (active
                        ? "bg-ink text-bone border-ink"
                        : "bg-paper text-ink border-hairline")
                    }
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
          )}

          {/* Category chips + opener de la lista completa (a la derecha) */}
          <div className="mt-3 flex items-center gap-2 -mx-5 px-5">
            <div
              ref={chipsScrollerRef}
              className="flex gap-2 overflow-x-auto scroll-hide flex-1 min-w-0"
            >
              {scopedCategories.map((c) => (
                <button
                  key={c.id}
                  ref={(el) => {
                    if (el) chipRefs.current.set(c.slug, el);
                    else chipRefs.current.delete(c.slug);
                  }}
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
            {scopedCategories.length > 1 && (
              <button
                type="button"
                onClick={() => setShowCatList(true)}
                aria-label={tMenu("allCategoriesAria")}
                className="shrink-0 w-9 h-9 inline-flex items-center justify-center rounded-full border border-hairline bg-paper text-ink-3"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <line x1="5.5" y1="4" x2="13" y2="4" />
                  <line x1="5.5" y1="8" x2="13" y2="8" />
                  <line x1="5.5" y1="12" x2="13" y2="12" />
                  <circle cx="2.5" cy="4" r="0.9" fill="currentColor" stroke="none" />
                  <circle cx="2.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
                  <circle cx="2.5" cy="12" r="0.9" fill="currentColor" stroke="none" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Popup: lista vertical de todas las categorías. Tocar una salta a
          su sección (reusa scrollToCategory + scroll-spy). */}
      {showCatList && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center"
          onClick={() => setShowCatList(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="bg-paper w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl max-h-[72vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-hairline">
              <h2 className="font-display text-xl">
                {tMenu("categoriesTitle")}
              </h2>
              <button
                type="button"
                onClick={() => setShowCatList(false)}
                aria-label={tMenu("close")}
                className="w-9 h-9 -mr-2 inline-flex items-center justify-center rounded-full text-ink-3 hover:bg-ink/5"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <line x1="5" y1="5" x2="15" y2="15" />
                  <line x1="15" y1="5" x2="5" y2="15" />
                </svg>
              </button>
            </div>
            <div className="overflow-y-auto p-2">
              {scopedCategories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    setActiveCat(c.slug);
                    setShowCatList(false);
                    scrollToCategory(c.slug);
                  }}
                  className={
                    "w-full text-left px-4 h-12 rounded-xl flex items-center text-[15px] transition-colors " +
                    (activeCat === c.slug
                      ? "bg-ink text-bone"
                      : "text-ink hover:bg-ink/5")
                  }
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Menu by category */}
      <div className="max-w-2xl w-full mx-auto px-5 mt-4 space-y-10">
        {searching && visibleCount === 0 && (
          <div className="py-16 text-center text-muted text-sm">
            {tMenu.rich("noResults", {
              query,
              q: (chunks) => (
                <span className="text-ink font-medium">“{chunks}”</span>
              ),
            })}
          </div>
        )}
        {scopedCategories.map((c) => {
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
                      menuTags={menuTags}
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
                      menuTags={menuTags}
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
          // Keying by id remounts the sheet when the diner swipes —
          // selections/qty/notes auto-reset to the new item's defaults
          // instead of leaking across plates.
          key={openItem.id}
          item={openItem}
          hasPrev={!!prevItem}
          hasNext={!!nextItem}
          onPrev={() => prevItem && setOpenItem(prevItem)}
          onNext={() => nextItem && setOpenItem(nextItem)}
          onClose={closeItemSheet}
          onAdd={(sel, qty, notes) => {
            addToCart(openItem, sel, qty, notes);
            closeItemSheet();
          }}
        />
      )}

      {/* Sticky bottom dock: active order + cart.
          IMPORTANT: don't use `transform` to center this — a transformed
          ancestor becomes the containing block for any descendant
          position:fixed, which would trap the cart modal inside this dock
          instead of the viewport. Use auto margins to center instead. */}
      {!openItem && (cart.length > 0 || activeOrder) && (
        <div
          className={
            "fixed inset-x-0 mx-auto z-30 w-[calc(100%-2rem)] max-w-xl flex gap-2 items-stretch " +
            dockBottomClass
          }
        >
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
                {tMenu("orderLabel")} · {activeOrder.shortCode}
              </div>
              <div className="text-sm font-medium truncate mt-0.5">
                {tMenu("itemsCount", { count: activeOrder.itemCount })}
                {" · "}
                {fmtCOP(activeOrder.subtotalCents)}
              </div>
            </button>
          )}
          {cart.length > 0 && (
            <CartBar
              lines={cart}
              menuItems={items}
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
          menuItems={items}
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
  menuItems,
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
  // Used to resolve modifier labels for each line — `selections` only
  // carries IDs and option labels, not the human-friendly group name
  // ("Adicion") that we want to render in the cart.
  menuItems: MenuItem[];
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
  const t = useTranslations("menu");
  // O(1) lookup by id so the render loop doesn't scan items per line.
  const itemById = useMemo(() => {
    const m = new Map<string, MenuItem>();
    for (const it of menuItems) m.set(it.id, it);
    return m;
  }, [menuItems]);
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
            {appendingTo ? t("addToCode", { code: appendingTo }) : t("yourOrder")}
          </div>
          <div className={(split ? "text-sm font-medium" : "font-display text-xl") + " truncate mt-0.5"}>
            {t("itemsCount", { count: totalQty })} · {fmtCOP(subtotal)}
          </div>
        </div>
        {!split && (
          <span className="shrink-0 font-medium underline underline-offset-4">
            {t("viewOrder")}
          </span>
        )}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-end md:items-center justify-center" style={{ paddingBottom: "var(--menu-modal-bottom-reserve, 0px)" }}
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
                    {t("yourOrder")}
                  </h3>
                  {appendingTo && (
                    <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mt-1">
                      {t("willAddToOrder", { code: appendingTo })}
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
                {lines.map((l) => {
                  const item = itemById.get(l.menuItemId);
                  const groups = formatLineSelections(l.selections, item);
                  return (
                  <li key={l.key} className="py-3 flex items-start gap-3">
                    <div className="flex-1">
                      <div className="font-medium">{l.name}</div>
                      {groups.length > 0 && (
                        // One line per modifier group. The old " · "
                        // separator squashed everything together so a
                        // two-group selection like "Adición: Carne,
                        // Pollo · Picante: Fuerte" was hard to scan;
                        // the diner now reads each label on its own
                        // line.
                        <div className="text-xs text-muted mt-0.5 space-y-0.5">
                          {groups.map((g, i) => (
                            // Dash prefix makes the list feel like a
                            // proper bullet ticket instead of two
                            // unrelated lines under the dish name.
                            <div key={i}>- {g}</div>
                          ))}
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
                      {t("removeLine")}
                    </button>
                  </li>
                  );
                })}
              </ul>
              {!appendingTo && showServingMode && (
                <div className="mt-5">
                  <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
                    {t("servingModeQuestion")}
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
                      <div className="text-sm font-medium">{t("asReadyTitle")}</div>
                      <div className="text-[11px] text-muted mt-0.5">
                        {t("asReadyDesc")}
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
                      <div className="text-sm font-medium">{t("togetherTitle")}</div>
                      <div className="text-[11px] text-muted mt-0.5">
                        {t("togetherDesc")}
                      </div>
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="shrink-0 border-t border-hairline bg-paper px-6 py-4">
              <div className="flex items-center justify-between">
                <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
                  {appendingTo ? t("thisRound") : t("subtotal")}
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
                    ? t("preparingPayment")
                    : t("sending")
                  : prepay
                    ? t("goToPay")
                    : appendingTo
                      ? t("addToKitchen")
                      : t("sendToKitchen")}
              </button>
              <p className="text-xs text-muted-2 text-center mt-2">
                {prepay ? t("prepayHint") : t("addMoreHint")}
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
  const t = useTranslations("menu");
  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-end md:items-center justify-center" style={{ paddingBottom: "var(--menu-modal-bottom-reserve, 0px)" }}
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
                {t("tableOrder")}
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
              {t("subtotal")}
            </div>
            <div className="font-display text-2xl">
              {fmtCOP(order.subtotalCents)}
            </div>
          </div>
          <Link
            href={`/t/${tenantSlug}/order/${order.id}`}
            className="mt-5 w-full h-12 rounded-full bg-ink text-bone font-medium inline-flex items-center justify-center"
          >
            {t("orderDetailCta")}
          </Link>
          <p className="text-xs text-muted-2 text-center mt-3">
            {t("liveStatusHint")}
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
  const t = useTranslations("menu");
  const opts: { id: MenuLayout; label: string; icon: React.ReactNode }[] = [
    { id: "list", label: t("layoutList"), icon: <IconList /> },
    { id: "grid", label: t("layoutGrid"), icon: <IconGrid /> },
    { id: "editorial", label: t("layoutEditorial"), icon: <IconEditorial /> },
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

function ItemTags({
  tags,
  registry,
}: {
  tags: string[];
  registry: MenuTag[];
}) {
  if (!tags.length || registry.length === 0) return null;
  // Render only tags that exist in the current registry — keeps the
  // diner UI tidy when the operator renames or deletes a tag without
  // mass-editing every item.
  const lookup = new Map(registry.map((t) => [t.slug, t]));
  const visible = tags
    .map((t) => lookup.get(t))
    .filter((t): t is MenuTag => Boolean(t));
  if (visible.length === 0) return null;
  return (
    <div className="flex gap-1.5 flex-wrap">
      {visible.map((t) => (
        <span
          key={t.slug}
          className={
            "px-2 h-5 inline-flex items-center gap-1 rounded-full text-[10px] font-medium " +
            (TAG_STYLES[t.slug] ?? NEUTRAL_TAG_STYLE)
          }
        >
          {t.emoji && <span aria-hidden>{t.emoji}</span>}
          {t.label}
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
  const t = useTranslations("menu");
  const dim = size === "sm" ? "w-8 h-8" : "w-10 h-10";
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onAdd();
      }}
      aria-label={t("addToOrder")}
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
  menuTags,
  onOpen,
  onQuickAdd,
}: {
  item: MenuItem;
  menuTags: MenuTag[];
  onOpen: () => void;
  onQuickAdd: () => void;
}) {
  const t = useTranslations("menu");
  // id used by the sheet's close handler to scroll back to this exact
  // row, plus a scroll-margin so the sticky header doesn't cover it.
  return (
    <li
      id={`menu-item-${item.id}`}
      className="py-4 scroll-mt-28"
    >
      <div className="flex gap-4 items-center">
        <button
          onClick={onOpen}
          className="w-20 h-20 shrink-0 rounded-xl bg-cream bg-cover bg-center block self-start"
          style={
            item.photoUrl
              ? { backgroundImage: `url(${item.photoUrl})` }
              : undefined
          }
          aria-label={t("viewDetail")}
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
              <ItemTags tags={item.tags} registry={menuTags} />
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
  const t = useTranslations("menu");
  return (
    <div id={`menu-item-${item.id}`} className="flex flex-col scroll-mt-28">
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
            {t("houseSpecial")}
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
  menuTags,
  onOpen,
  onQuickAdd,
}: {
  item: MenuItem;
  index: number;
  menuTags: MenuTag[];
  onOpen: () => void;
  onQuickAdd: () => void;
}) {
  // Every 3rd card is a big hero; the rest are list rows.
  const isHero = index % 3 === 0;
  if (!isHero) {
    return (
      <ul className="divide-y divide-hairline border-t border-hairline -mt-3 first:mt-0">
        <ItemRowList
          item={item}
          menuTags={menuTags}
          onOpen={onOpen}
          onQuickAdd={onQuickAdd}
        />
      </ul>
    );
  }
  return (
    <div id={`menu-item-${item.id}`} className="flex flex-col scroll-mt-28">
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
            <ItemTags tags={item.tags.slice(0, 2)} registry={menuTags} />
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
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onClose,
  onAdd,
}: {
  item: MenuItem;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onAdd: (sel: Selections, qty: number, notes?: string) => void;
}) {
  const t = useTranslations("menu");
  const [selections, setSelections] = useState<Selections>(() => {
    const d: Selections = {};
    for (const m of item.modifiers ?? []) {
      if (m.default) {
        // checkbox default seeds as a one-element array so we can keep
        // toggling more options on; radio stays a string.
        d[m.id] = m.type === "checkbox" ? [m.default] : m.default;
      } else if (m.type === "checkbox") {
        // Empty array for an unset checkbox modifier — distinguishes
        // "no selection yet" from "modifier doesn't apply".
        d[m.id] = [];
      }
    }
    return d;
  });
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState("");

  function isOptSelected(modId: string, optLabel: string): boolean {
    const v = selections[modId];
    if (v == null) return false;
    if (typeof v === "string") return v === optLabel;
    return v.includes(optLabel);
  }
  function toggleOpt(mod: ModifierDef, optLabel: string) {
    setSelections((prev) => {
      const next = { ...prev };
      if (mod.type === "radio") {
        next[mod.id] = optLabel; // replace
      } else {
        const cur = prev[mod.id];
        const arr = Array.isArray(cur) ? cur : cur ? [cur as string] : [];
        next[mod.id] = arr.includes(optLabel)
          ? arr.filter((x) => x !== optLabel)
          : [...arr, optLabel];
      }
      return next;
    });
  }

  // Effective unit price reflects the diner's current picks. Updates
  // live as they tap options so the Add button doesn't lie about the
  // amount the cart will pick up.
  let unitPrice = item.priceCents;
  for (const m of item.modifiers ?? []) {
    const v = selections[m.id];
    if (v == null) continue;
    const labels = typeof v === "string" ? [v] : v;
    for (const lab of labels) {
      const opt = m.opts.find((o) => o.label === lab);
      if (opt?.priceDeltaCents) unitPrice += opt.priceDeltaCents;
    }
  }
  unitPrice = Math.max(0, unitPrice);

  // Horizontal swipe to flip between dishes. We only commit on
  // touchend so vertical scrolling inside the sheet isn't hijacked.
  // The ratio check (|dx| must dominate |dy| by 1.2x) keeps diagonal
  // scrolls from triggering false swipes; the 60px threshold weeds
  // out tiny accidental drags.
  const touchStartRef = useRef<{
    x: number;
    y: number;
    scrollTop: number;
  } | null>(null);
  // Ref al contenedor scrolleable para saber si estamos arriba de todo:
  // el swipe-down solo cierra cuando scrollTop === 0 (si no, es scroll).
  const sheetScrollRef = useRef<HTMLDivElement | null>(null);
  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    touchStartRef.current = {
      x: t.clientX,
      y: t.clientY,
      scrollTop: sheetScrollRef.current?.scrollTop ?? 0,
    };
  }
  function onTouchEnd(e: React.TouchEvent) {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    // Swipe DOWN para cerrar: gesto vertical hacia abajo, dominante sobre el
    // horizontal, y solo si el contenido estaba arriba de todo al empezar
    // (si no, el usuario está scrolleando y no queremos cerrar).
    if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.2 && start.scrollTop <= 0) {
      onClose();
      return;
    }
    // Swipe horizontal para cambiar de plato.
    if (Math.abs(dx) < 60) return;
    if (Math.abs(dx) < Math.abs(dy) * 1.2) return;
    if (dx < 0 && hasNext) onNext();
    else if (dx > 0 && hasPrev) onPrev();
  }

  return (
    <div
      // Full-screen on mobile (no transparent gap above the photo) and
      // a centred card on desktop. The mobile sheet stops behaving
      // like a "bottom drawer" — diners expect a takeover view, not a
      // sliver of carta visible at the top.
      className="fixed inset-0 z-50 bg-black/40 md:flex md:items-center md:justify-center" style={{ paddingBottom: "var(--menu-modal-bottom-reserve, 0px)" }}
      onClick={onClose}
    >
      <div
        ref={sheetScrollRef}
        className="relative bg-paper w-full h-[100dvh] md:h-auto md:max-w-xl md:max-h-[92dvh] md:rounded-3xl overflow-auto slide-up"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {/* Barrita de agarre (solo móvil): indica que se puede deslizar
            hacia abajo para cerrar. Flota sobre la foto, no bloquea taps. */}
        <div className="md:hidden absolute top-2 left-1/2 -translate-x-1/2 z-20 h-1.5 w-10 rounded-full bg-white/75 shadow pointer-events-none" />
        {item.photoUrl && (
          <div
            // Square photo, full width. On a 390px phone that's a
            // 390×390 hero — much bigger and more appetising than the
            // old 224px landscape strip.
            className="aspect-square w-full bg-cover bg-center bg-cream"
            style={{ backgroundImage: `url(${item.photoUrl})` }}
          />
        )}
        <div className="p-6">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-1 -ml-2">
              {/* Prev / next chevrons. On mobile the diner mainly uses
                  swipe; the buttons are kept for desktop and as a hint
                  that more dishes are reachable from this sheet. */}
              <button
                type="button"
                onClick={onPrev}
                disabled={!hasPrev}
                aria-label={t("prevDish")}
                className="w-9 h-9 rounded-full text-ink-3 flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed hover:bg-cream"
              >
                ‹
              </button>
              <button
                type="button"
                onClick={onNext}
                disabled={!hasNext}
                aria-label={t("nextDish")}
                className="w-9 h-9 rounded-full text-ink-3 flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed hover:bg-cream"
              >
                ›
              </button>
            </div>
            <button
              onClick={onClose}
              className="w-9 h-9 rounded-full border border-hairline text-ink-3 flex items-center justify-center"
              aria-label={t("close")}
            >
              ×
            </button>
          </div>
          <div className="flex items-start justify-between gap-4 mt-2">
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
          </div>
          <p className="text-ink-3 mt-3 leading-relaxed">{item.description}</p>

          {item.modifiers?.map((m) => (
            <div key={m.id} className="mt-6">
              <div className="flex items-baseline justify-between mb-2">
                <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
                  {m.label}
                </div>
                <div className="font-mono text-[10px] tracking-wider uppercase text-muted-2">
                  {m.type === "checkbox" ? t("modifierMany") : t("modifierOne")}
                </div>
              </div>
              <div className="flex gap-2 flex-wrap">
                {m.opts.map((opt) => {
                  const active = isOptSelected(m.id, opt.label);
                  const delta = opt.priceDeltaCents ?? 0;
                  return (
                    <button
                      key={opt.label}
                      onClick={() => toggleOpt(m, opt.label)}
                      className={
                        "h-9 px-3 rounded-full text-sm border inline-flex items-center gap-1.5 " +
                        (active
                          ? "bg-ink text-bone border-ink"
                          : "bg-ivory text-ink border-hairline")
                      }
                    >
                      <span>{opt.label}</span>
                      {delta !== 0 && (
                        <span
                          className={
                            "font-mono text-[11px] " +
                            (active ? "text-bone/80" : "text-muted")
                          }
                        >
                          {delta > 0 ? "+" : "−"}
                          {fmtCOP(Math.abs(delta))}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="mt-6">
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
              {t("kitchenNotes")}
            </div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder={t("notesPlaceholder")}
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
              {t("addWithPrice", { price: fmtCOP(unitPrice * qty) })}
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
  const t = useTranslations("menu");
  const [value, setValue] = useState(initial);
  const trimmed = value.trim();
  const canSave = trimmed.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-end md:items-center justify-center" style={{ paddingBottom: "var(--menu-modal-bottom-reserve, 0px)" }}
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
            {t("atThisTable")}
          </div>
          <h3 className="font-display text-3xl tracking-[-0.015em] mt-1">
            {t("whatToCallYou")}
          </h3>
          <p className="text-sm text-ink-3 mt-2 leading-relaxed">
            {t("nameSubtitle")}
          </p>
          <input
            autoFocus
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={40}
            placeholder={t("namePlaceholder")}
            className="mt-5 w-full h-12 px-4 rounded-xl border border-hairline bg-ivory text-base focus:outline-none focus:border-terracotta"
          />
          <div className="mt-5 flex gap-3">
            {canCancel && (
              <button
                type="button"
                onClick={onClose}
                className="h-11 px-5 rounded-full border border-hairline font-medium text-ink-3"
              >
                {t("cancel")}
              </button>
            )}
            <button
              type="submit"
              disabled={!canSave}
              className="flex-1 h-11 rounded-full bg-ink text-bone font-medium disabled:opacity-50"
            >
              {t("save")}
            </button>
          </div>
          <p className="text-xs text-muted-2 mt-3">
            {t("namePrivacy")}
          </p>
        </form>
      </div>
    </div>
  );
}

type PickupMethod =
  | "kushki_apple_pay"
  | "demo_card"
  | "demo_nequi";

function PickupCheckoutSheet({
  tenantSlug,
  tableId,
  cart,
  menuItems,
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
  menuItems: MenuItem[];
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
  const t = useTranslations("menu");
  const itemById = useMemo(() => {
    const m = new Map<string, MenuItem>();
    for (const it of menuItems) m.set(it.id, it);
    return m;
  }, [menuItems]);
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

  useEffect(() => {
    const w = window as unknown as { ApplePaySession?: { canMakePayments?: () => boolean } };
    setHasApplePay(!!w.ApplePaySession?.canMakePayments?.());
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
      setErr(t("errNeedName"));
      return;
    }
    const localNumber = phone.replace(/[^\d]/g, "");
    if (localNumber.length < 5) {
      setErr(t("errNeedPhone"));
      return;
    }
    setBusy(method);
    setErr(null);

    // Kushki methods need a token from the JS SDK. Until we wire it in
    // production, mock mode accepts a placeholder; live mode would fail
    // gracefully if the SDK isn't loaded.
    let token: string | undefined;
    if (method === "kushki_apple_pay") {
      if (kushkiPublicKey && !isMockMode) {
        // TODO: integrate Kushki JS SDK and tokenize here.
        setBusy(null);
        setErr(t("errApplePayInactive"));
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
          t("errSaturated", {
            eta: j.etaMinutes ?? "?",
            max: j.maxEtaMinutes ?? "?",
          }),
        );
      } else if (j.error === "closed") {
        setErr(t("errClosed"));
      } else if (j.error === "charge_declined") {
        setErr(j.message ?? t("errDeclined"));
      } else {
        setErr(j.error ?? t("errGeneric"));
      }
      return;
    }
    const j = await res.json();
    onSuccess(j.orderId);
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center"
      style={{ paddingBottom: "var(--menu-modal-bottom-reserve, 0px)" }}
    >
      <div className="w-full md:max-w-md bg-bone rounded-t-3xl md:rounded-3xl border border-hairline shadow-xl max-h-[92dvh] overflow-y-auto">
        <div className="p-5 border-b border-hairline flex items-center justify-between">
          <div className="font-display text-xl">{t("pickupTitle")}</div>
          <button
            onClick={onClose}
            className="text-muted text-sm"
            disabled={!!busy}
          >
            {t("back")}
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
              {t("etaLabel")}
            </div>
            <div className="font-display text-3xl tabular mt-1">
              {eta.loading ? "…" : `${eta.minutes} min`}
            </div>
            <div className="text-[11px] text-muted mt-1">
              {eta.closed
                ? t("etaClosedShort")
                : eta.saturated
                  ? t("etaSaturatedInfo", {
                      cap: maxEtaMinutes ? t("etaCap", { min: maxEtaMinutes }) : "",
                    })
                  : t("etaNormal")}
            </div>
          </div>

          <label className="block">
            <span className="font-mono text-[10px] tracking-wider uppercase text-muted">
              {t("yourName")}
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              className="mt-1 w-full h-11 px-3 rounded-lg border border-hairline bg-paper focus:outline-none focus:border-terracotta"
              placeholder={t("pickupNamePlaceholder")}
            />
          </label>

          <div className="block">
            <span className="font-mono text-[10px] tracking-wider uppercase text-muted">
              {t("mobile")}
            </span>
            <div className="mt-1 flex items-stretch gap-2">
              <button
                type="button"
                onClick={() => setShowCountry(true)}
                className="shrink-0 h-11 px-3 rounded-lg border border-hairline bg-paper flex items-center gap-2 text-sm"
                aria-label={t("countryCodeAria")}
              >
                <span className="text-base leading-none">{country.flag}</span>
                <span className="font-mono tabular">+{country.dial}</span>
                <span className="text-muted text-xs leading-none">{"▾"}</span>
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
              {t("yourOrder")}
            </div>
            <ul className="divide-y divide-hairline">
              {cart.map((l) => {
                const item = itemById.get(l.menuItemId);
                const groups = formatLineSelections(l.selections, item);
                return (
                <li
                  key={l.key}
                  className="py-1.5 flex items-start justify-between gap-3 text-sm"
                >
                  <div className="min-w-0">
                    <div className="truncate">
                      {l.qty}× {l.name}
                    </div>
                    {groups.length > 0 && (
                      <div className="text-[11px] text-muted space-y-0.5">
                        {groups.map((g, i) => (
                          <div key={i} className="truncate">
                            - {g}
                          </div>
                        ))}
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
                );
              })}
            </ul>
            <div className="mt-2 pt-2 border-t border-hairline flex items-baseline justify-between">
              <span className="font-mono text-[10px] tracking-wider uppercase text-muted">
                {t("total")}
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
                  ? t("processing")
                  : t("payApple", { price: fmtCOP(subtotal) })}
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
                    ? t("processing")
                    : t("demoCard", { price: fmtCOP(subtotal) })}
                </button>
                <button
                  onClick={() => placeAndPay("demo_nequi")}
                  disabled={!!busy || eta.saturated || eta.closed}
                  className="w-full h-12 rounded-full border border-hairline bg-paper text-ink text-sm font-medium disabled:opacity-60"
                >
                  {busy === "demo_nequi" ? t("processing") : t("demoNequi")}
                </button>
                <div className="text-[11px] text-muted-2 text-center pt-1">
                  {t("demoHint")}
                </div>
              </>
            )}
            <div className="text-[11px] text-muted text-center mt-1">
              {t("paymentApprovalHint")}
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
  const t = useTranslations("menu");
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
            <div className="font-display text-lg">{t("countryPickerTitle")}</div>
            <button
              type="button"
              onClick={onClose}
              className="w-8 h-8 rounded-full border border-hairline text-ink-3"
              aria-label={t("close")}
            >
              ×
            </button>
          </div>
          <input
            autoFocus
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("countrySearchPlaceholder")}
            className="w-full h-10 px-3 rounded-lg border border-hairline bg-paper text-sm focus:outline-none focus:border-terracotta"
          />
        </div>
        <ul className="overflow-y-auto flex-1">
          {list.length === 0 && (
            <li className="py-8 text-center text-sm text-muted">
              {t("noCountry")}
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

