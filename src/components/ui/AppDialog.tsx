"use client";

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
import { useVisualViewport } from "@/lib/useVisualViewport";
import { centerInVisualViewport } from "@/lib/visualViewport";

/** Margen entre el popup centrado y el borde del viewport visual (px). */
const CENTER_MARGIN = 12;

/**
 * Native modal semantics provide focus containment, Escape and an inert background.
 *
 * `placement`:
 *   - "default": el `<dialog>` se ubica como siempre, según el CSS de cada
 *     uso (hoja inferior, drawer lateral, centrado con `margin: auto`…).
 *   - "center": popup centrado en el VIEWPORT VISUAL, no en el de layout.
 *     En iOS el teclado achica el viewport visual sin mover el de layout,
 *     así que un centrado clásico queda tapado. Acá se reposiciona con
 *     `useVisualViewport` (fixed, `top = offsetTop + …`), se limita a
 *     `max-height = alto visible − 2·margen` con scroll interno y se
 *     centra horizontalmente con ancho `min(100vw − 32px, 28rem)`.
 */
export function AppDialog({
  label,
  onClose,
  children,
  className = "",
  style,
  mobileOnly = false,
  placement = "default",
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  mobileOnly?: boolean;
  placement?: "default" | "center";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  const centered = placement === "center";
  const viewport = useVisualViewport(centered);
  // Alto real del diálogo ya renderizado, para centrarlo. Cero hasta la
  // primera medición: ese frame se pinta invisible para no verlo saltar.
  const [dialogHeight, setDialogHeight] = useState(0);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    const media = window.matchMedia("(min-width: 768px)");
    const resize = () => {
      if (mobileOnly && media.matches) closeRef.current();
    };
    media.addEventListener("change", resize);
    return () => {
      media.removeEventListener("change", resize);
      dialog.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [mobileOnly]);
  useEffect(() => {
    if (!centered) return;
    const dialog = ref.current!;
    // ResizeObserver cubre tanto el showModal (display none → block) como
    // cambios de contenido (un error que aparece, un botón que cambia).
    const observer = new ResizeObserver(() =>
      setDialogHeight(dialog.offsetHeight),
    );
    observer.observe(dialog);
    return () => observer.disconnect();
  }, [centered]);

  let placementStyle: CSSProperties | undefined;
  if (centered) {
    if (viewport && dialogHeight > 0) {
      const box = centerInVisualViewport({
        offsetTop: viewport.offsetTop,
        height: viewport.height,
        dialogHeight,
        margin: CENTER_MARGIN,
      });
      placementStyle = {
        position: "fixed",
        top: box.top,
        bottom: "auto",
        left: 0,
        right: 0,
        margin: "0 auto",
        width: `min(calc(100vw - ${CENTER_MARGIN * 2 + 8}px), 28rem)`,
        maxHeight: box.maxHeight,
        overflowY: "auto",
      };
    } else {
      placementStyle = { visibility: "hidden" };
    }
  }

  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      aria-label={label}
      aria-modal="true"
      className={`mp-dialog ${className}`}
      style={placementStyle ? { ...placementStyle, ...style } : style}
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const controls = Array.from(
          e.currentTarget.querySelectorAll<HTMLElement>(
            'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
        const first = controls[0];
        const last = controls.at(-1);
        if (!first || !last) {
          e.preventDefault();
          e.currentTarget.focus();
          return;
        }
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === e.currentTarget)
        ) {
          e.preventDefault();
          last.focus();
        } else if (
          !e.shiftKey &&
          (document.activeElement === last ||
            document.activeElement === e.currentTarget)
        ) {
          e.preventDefault();
          first.focus();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      {children}
    </dialog>
  );
}
