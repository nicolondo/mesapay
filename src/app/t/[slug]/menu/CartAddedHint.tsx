"use client";
import { useTranslations } from "next-intl";
import { isCartHintVisible, type CartHintPhase } from "./cartHint";

/**
 * Burbuja «¡Agregado! Toca aquí abajo…» que apunta al botón del carrito.
 *
 * Se monta DENTRO de la columna del botón del carrito (posición relativa) y
 * flota encima de ella, así el pico queda siempre centrado sobre ese botón —
 * también en el dock partido, donde el carrito es la mitad derecha. El cuerpo
 * es más ancho que esa mitad: con `align="end"` se apoya en el borde derecho y
 * se extiende hacia la izquierda, sin salirse del dock.
 *
 * No intercepta toques (`pointer-events-none`): nunca tapa ni bloquea nada.
 * La región `role="status"` queda montada aunque no haya aviso, para que el
 * lector de pantalla anuncie el texto cuando aparece.
 */
export function CartAddedHint({
  phase,
  align,
  prepay,
}: {
  phase: CartHintPhase;
  /** `center`: el carrito ocupa todo el dock. `end`: dock partido, carrito a la derecha. */
  align: "center" | "end";
  /** Mostrador / para llevar: se paga antes de que cocina lo vea. */
  prepay: boolean;
}) {
  const t = useTranslations("menu");
  const visible = isCartHintVisible(phase);
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-x-0 bottom-full"
    >
      {visible && (
        <div
          data-cart-hint={phase}
          data-cart-hint-align={align}
          className={
            (phase === "leaving" ? "cart-hint-out" : "cart-hint-in") +
            // En flujo (no absoluto) para que la región tenga el tamaño real
            // de la burbuja. Con `justify-end` el cuerpo, más ancho que la
            // columna, desborda hacia la izquierda (flexbox alinea "unsafe").
            " relative flex pb-[18px] " +
            (align === "end" ? "justify-end" : "justify-center")
          }
        >
          <div className="flex w-[min(22rem,calc(100vw-2rem))] shrink-0 items-start gap-3 rounded-2xl bg-terracotta-2 px-4 py-3 text-paper shadow-[0_12px_32px_rgba(26,22,19,0.3)]">
            <span
              aria-hidden="true"
              className="mt-px grid size-6 shrink-0 place-items-center rounded-full bg-paper text-terracotta-2"
            >
              <svg viewBox="0 0 16 16" className="size-3.5" fill="none">
                <path
                  d="M3.5 8.5l3 3 6-7"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <p className="min-w-0">
              <span className="block text-[17px] font-semibold leading-tight">
                {t("cartHintTitle")}
              </span>
              <span className="mt-0.5 block text-[15px] leading-snug text-balance">
                {t(prepay ? "cartHintPay" : "cartHintSend")}
              </span>
            </p>
          </div>
          {/* Pico: centrado en la columna del carrito, apuntando hacia abajo. */}
          <span
            aria-hidden="true"
            data-cart-hint-arrow=""
            className="absolute bottom-[10px] left-1/2 size-4 -translate-x-1/2 rotate-45 rounded-[3px] bg-terracotta-2"
          />
        </div>
      )}
    </div>
  );
}

/**
 * Anillo terracota que late alrededor del botón del carrito mientras dura el
 * aviso. Va adentro del botón (que es `relative`) para moverse con su
 * animación de entrada. Con reduced-motion queda fijo, sin latido.
 */
export function CartHintRing({ phase }: { phase: CartHintPhase }) {
  if (!isCartHintVisible(phase)) return null;
  return (
    <span
      aria-hidden="true"
      data-cart-hint-ring=""
      className={
        "cart-hint-ring pointer-events-none absolute -inset-1 rounded-[20px] border-2 border-terracotta" +
        (phase === "leaving" ? " cart-hint-out" : "")
      }
    />
  );
}
