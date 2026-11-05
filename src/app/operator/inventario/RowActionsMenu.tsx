"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { InvIcon, type InventoryIconName } from "./InventoryIcons";
import { firstEnabledIndex, menuKeyAction, placeMenu } from "./menuNavigation";

export type RowMenuItem = {
  key: string;
  label: string;
  icon?: InventoryIconName;
  /** Navega (Link) en vez de ejecutar una acción. */
  href?: string;
  onSelect?: () => void;
  disabled?: boolean;
  tone?: "danger";
  /** Línea divisoria antes del ítem (agrupa acciones destructivas). */
  separatorBefore?: boolean;
};

/**
 * Menú «⋯» de acciones de una fila (patrón WAI-ARIA menu button): botón con
 * aria-haspopup/aria-expanded, menú en un portal con posición fija (la
 * tabla puede tener scroll horizontal y recortaría un menú absoluto),
 * flechas/Home/End para recorrerlo, Esc o clic afuera para cerrarlo. Si la
 * página se desplaza o cambia de tamaño, el menú sigue a su botón; se
 * cierra solo cuando el botón sale de la pantalla.
 */
export function RowActionsMenu({ label, items, className = "" }: { label: string; items: RowMenuItem[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  const menuId = useId();
  const enabled = items.map((item) => !item.disabled);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setPos(null);
    if (restoreFocus) buttonRef.current?.focus({ preventScroll: true });
  }, []);

  /** Ubica el menú junto al botón; false si el botón ya no está a la vista. */
  const reposition = useCallback(() => {
    const button = buttonRef.current;
    const menu = menuRef.current;
    if (!button || !menu) return true;
    const anchor = button.getBoundingClientRect();
    if (anchor.bottom < 0 || anchor.top > window.innerHeight) return false;
    const next = placeMenu(anchor, { width: menu.offsetWidth, height: menu.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
    setPos((current) => (current && current.top === next.top && current.left === next.left ? current : next));
    return true;
  }, []);

  // Medir y ubicar antes de pintar: el primer frame sale invisible.
  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, reposition]);

  // Al quedar ubicado, el foco entra al primer ítem habilitado.
  const placed = open && pos !== null;
  const firstEnabled = firstEnabledIndex(enabled);
  useEffect(() => {
    if (placed && firstEnabled >= 0) itemRefs.current[firstEnabled]?.focus({ preventScroll: true });
  }, [placed, firstEnabled]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close(false);
    };
    const follow = (event?: Event) => {
      if (event && menuRef.current?.contains(event.target as Node)) return;
      if (!reposition()) close(false);
    };
    const onScroll = (event: Event) => follow(event);
    const onResize = () => follow();
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, close, reposition]);

  function onMenuKeyDown(event: React.KeyboardEvent) {
    const current = itemRefs.current.findIndex((el) => el === document.activeElement);
    const result = menuKeyAction(event.key, current, enabled);
    if (result.type === "none") return;
    if (result.type === "focus") {
      event.preventDefault();
      itemRefs.current[result.index]?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "Escape") event.preventDefault();
    close(result.restoreFocus);
  }

  function onButtonKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
    }
  }

  function select(item: RowMenuItem) {
    if (item.disabled) return;
    // El foco vuelve al botón ANTES de abrir la hoja: así el diálogo lo
    // recuerda y lo devuelve al cerrarse.
    close(true);
    item.onSelect?.();
  }

  const itemCls = (item: RowMenuItem) =>
    "mp-rowmenu__item" + (item.tone === "danger" ? " mp-rowmenu__item--danger" : "");

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={onButtonKeyDown}
        className={"mp-rowmenu__button " + className}
      >
        <InvIcon name="more" size={20} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={label}
            onKeyDown={onMenuKeyDown}
            className="mp-rowmenu"
            style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}
          >
            {items.map((item, index) => (
              <div key={item.key} role="none">
                {item.separatorBefore && <div role="separator" className="mp-rowmenu__sep" />}
                {item.href && !item.disabled ? (
                  <Link
                    ref={(el) => { itemRefs.current[index] = el; }}
                    href={item.href}
                    role="menuitem"
                    tabIndex={-1}
                    className={itemCls(item)}
                    onClick={() => close(false)}
                  >
                    {item.icon && <InvIcon name={item.icon} />}
                    <span>{item.label}</span>
                  </Link>
                ) : (
                  <button
                    ref={(el) => { itemRefs.current[index] = el; }}
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    disabled={item.disabled}
                    aria-disabled={item.disabled || undefined}
                    className={itemCls(item)}
                    onClick={() => select(item)}
                  >
                    {item.icon && <InvIcon name={item.icon} />}
                    <span>{item.label}</span>
                  </button>
                )}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
