"use client";

import { useEffect, useRef, type ReactNode, type CSSProperties } from "react";

/** Native modal semantics provide focus containment, Escape and an inert background. */
export function AppDialog({
  label,
  onClose,
  children,
  className = "",
  style,
  mobileOnly = false,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  mobileOnly?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
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
  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      aria-label={label}
      className={`mp-dialog ${className}`}
      style={style}
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
