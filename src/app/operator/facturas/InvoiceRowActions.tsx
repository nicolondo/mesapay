"use client";

import Link from "next/link";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { menuButtonKeyResult, menuKeyResult, menuOpensUp } from "@/lib/ui/menuKeys";

/**
 * Acciones de una fila de Facturas: UNA acción principal a la vista y el
 * resto en un menú «⋯». Es la pieza que comparten la tabla (escritorio) y
 * la lista (celular), y la que recibe acciones nuevas sin tocar la fila:
 * `primary` es cualquier control ya armado (un botón, un enlace) y `items`
 * la lista del menú.
 *
 * Menú accesible (patrón «menu button» de WAI-ARIA, `lib/ui/menuKeys.ts`):
 * el botón «⋯» lleva `aria-haspopup`/`aria-expanded`; al abrir, el foco va
 * al primer ítem (↑ sobre el botón abre en el último); ↑ ↓ Inicio Fin y la
 * inicial recorren los ítems; Esc cierra y devuelve el foco al botón; Tab o
 * un click afuera cierran. Abre hacia arriba si abajo no entra.
 *
 * El menú está SIEMPRE en el HTML (oculto con `hidden` mientras está
 * cerrado): los enlaces se pueden probar sin abrirlo y no hay salto al
 * abrir.
 */
export type RowMenuItem = {
  id: string;
  label: string;
  /** Navegación: enlace interno, o `external` para abrir en otra pestaña. */
  href?: string;
  external?: boolean;
  /** Acción en la misma pantalla (imprimir, reenviar, reintentar…). */
  onSelect?: () => void;
  /** Acción en curso: se muestra con su texto de espera y no se repite. */
  busy?: boolean;
  /** Acción que deshace o anula algo: va en rojo y separada del resto. */
  tone?: "danger";
  icon?: ReactNode;
};

export type RowActionSize = "xs" | "sm";

const SIZE: Record<RowActionSize, string> = {
  xs: "mp-btn--xs",
  sm: "mp-btn--sm",
};

/** Clases del botón de la acción principal, para el tamaño dado. */
export function primaryActionClass(size: RowActionSize, tone?: "danger"): string {
  return `mp-btn ${tone === "danger" ? "mp-btn--danger" : "mp-btn--secondary"} ${SIZE[size]}`;
}

export function InvoiceRowActions({
  primary,
  items,
  menuLabel,
  size = "xs",
}: {
  primary?: ReactNode;
  items: RowMenuItem[];
  /** Nombre accesible del botón «⋯» («Más acciones para FESM7845»). */
  menuLabel: string;
  size?: RowActionSize;
}) {
  return (
    <div className="flex shrink-0 items-center justify-end gap-1.5">
      {primary}
      {items.length > 0 && <RowActionMenu items={items} label={menuLabel} size={size} />}
    </div>
  );
}

export function RowActionMenu({
  items,
  label,
  size = "xs",
}: {
  items: RowMenuItem[];
  label: string;
  size?: RowActionSize;
}) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef<"first" | "last">("first");
  const menuId = useId();
  const triggerId = useId();

  const menuItems = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  function openMenu(where: "first" | "last") {
    focusOnOpen.current = where;
    setOpen(true);
  }

  function close(restoreFocus: boolean) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  // Al abrir: hacia dónde (sin saltos: antes de pintar) y foco al ítem.
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = triggerRef.current?.getBoundingClientRect();
    const menu = menuRef.current;
    if (anchor && menu) {
      setUp(
        menuOpensUp({
          anchorTop: anchor.top,
          anchorBottom: anchor.bottom,
          menuHeight: menu.offsetHeight,
          viewportHeight: window.innerHeight,
        }),
      );
    }
    const list = menuItems();
    (focusOnOpen.current === "last" ? list[list.length - 1] : list[0])?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  function onMenuKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const list = menuItems();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const r = menuKeyResult(
      e.key,
      index,
      list.length,
      items.map((i) => i.label),
    );
    if (r.kind === "focus") {
      e.preventDefault();
      list[r.index]?.focus();
    } else if (r.kind === "close") {
      // Tab no se frena: con el foco ya en el botón «⋯», el navegador sigue
      // al próximo control de la página (el menú no es una trampa de foco).
      if (r.via === "escape") e.preventDefault();
      close(true);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={label}
        title={label}
        onClick={() => (open ? close(false) : openMenu("first"))}
        onKeyDown={(e) => {
          if (open) return;
          const where = menuButtonKeyResult(e.key);
          if (where) {
            e.preventDefault();
            openMenu(where);
          }
        }}
        className={`mp-btn mp-btn--secondary mp-btn--icon ${SIZE[size]}`}
      >
        <MoreIcon />
      </button>
      <div
        ref={menuRef}
        id={menuId}
        role="menu"
        aria-labelledby={triggerId}
        hidden={!open}
        onKeyDown={onMenuKeyDown}
        className={
          "absolute right-0 z-30 w-max min-w-[13.5rem] max-w-[min(18rem,calc(100vw-2rem))] rounded-xl border border-op-border bg-op-surface p-1 text-left shadow-lg " +
          (up ? "bottom-full mb-1.5" : "top-full mt-1.5")
        }
      >
        {items.map((item, i) => (
          <MenuEntry
            key={item.id}
            item={item}
            separated={item.tone === "danger" && i > 0}
            onDone={(restore) => close(restore)}
          />
        ))}
      </div>
    </div>
  );
}

const ITEM_CLASS =
  "flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm leading-snug outline-none hover:bg-op-bg focus-visible:bg-op-bg focus:bg-op-bg";

function MenuEntry({
  item,
  separated,
  onDone,
}: {
  item: RowMenuItem;
  separated: boolean;
  onDone: (restoreFocus: boolean) => void;
}) {
  const tone = item.tone === "danger" ? " text-danger" : " text-op-text";
  const body = (
    <>
      <span aria-hidden className="flex w-4 shrink-0 justify-center text-op-muted">
        {item.icon}
      </span>
      <span className="min-w-0 break-words">{item.label}</span>
    </>
  );
  // Espacio también activa un enlace del menú (Enter ya lo hace solo).
  const onLinkKey = (e: KeyboardEvent<HTMLAnchorElement>) => {
    if (e.key === " ") {
      e.preventDefault();
      e.currentTarget.click();
    }
  };
  let entry: ReactNode;
  if (item.href && item.external) {
    entry = (
      <a
        role="menuitem"
        tabIndex={-1}
        href={item.href}
        target="_blank"
        rel="noreferrer"
        onClick={() => onDone(true)}
        onKeyDown={onLinkKey}
        className={ITEM_CLASS + tone}
      >
        {body}
      </a>
    );
  } else if (item.href) {
    entry = (
      <Link
        role="menuitem"
        tabIndex={-1}
        href={item.href}
        prefetch={false}
        onClick={() => onDone(false)}
        onKeyDown={onLinkKey}
        className={ITEM_CLASS + tone}
      >
        {body}
      </Link>
    );
  } else {
    entry = (
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-disabled={item.busy || undefined}
        onClick={() => {
          if (item.busy) return;
          onDone(true);
          item.onSelect?.();
        }}
        className={ITEM_CLASS + tone + (item.busy ? " cursor-progress opacity-60" : "")}
      >
        {body}
      </button>
    );
  }
  return (
    <>
      {separated && <div role="separator" className="mx-1 my-1 h-px bg-op-border" />}
      {entry}
    </>
  );
}

function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="1.9" />
      <circle cx="12" cy="12" r="1.9" />
      <circle cx="19" cy="12" r="1.9" />
    </svg>
  );
}
