import type { ReactNode } from "react";

/**
 * Franja de impersonación: el aviso de seguridad que le recuerda al admin
 * que está viendo la app como otro usuario. La comparten los shells de
 * operador (/operator) y de grupo (/group), así que cualquier ajuste de
 * alto o de estilo se hace acá y aplica en los dos.
 *
 * Diseño: UNA sola línea en cualquier ancho (nada de `flex-wrap`, que en
 * el celular la partía en tres renglones). La franja no pone padding
 * vertical: su alto lo define el padding del propio enlace de salida, que
 * conserva un área táctil cómoda. El nombre del comercio se trunca con
 * elipsis cuando no cabe. El contraste terracota/bone se mantiene — es un
 * aviso, no debe pasar desapercibido.
 */
export function ImpersonationBar({
  label,
  name,
  exitLabel,
  exitAction,
  children,
}: {
  /** Palabra clave del aviso, en mayúsculas ("Impersonando", "Grupo"…). */
  label: string;
  /** Nombre del comercio o grupo que se está viendo. */
  name: string;
  /** Texto de la acción de salida ("Dejar de impersonar", "Volver al admin"…). */
  exitLabel: string;
  /** Server action que limpia la cookie de impersonación. */
  exitAction: (formData: FormData) => void | Promise<void>;
  /** Controles extra que caben en la misma línea (p. ej. el switcher de local). */
  children?: ReactNode;
}) {
  return (
    <div className="print:hidden shrink-0 overflow-hidden bg-terracotta text-bone px-3 md:px-6 flex items-center gap-2 min-w-0">
      <span className="shrink-0 font-mono text-[10px] leading-none tracking-wider uppercase opacity-80">
        {label}
      </span>
      {/* Con switcher de local en pantallas angostas no caben los dos: manda
          el control (y el nombre sigue a la vista en la cabecera de abajo). */}
      <strong
        className={`min-w-0 flex-1 truncate text-[11px] leading-tight font-semibold ${
          children ? "hidden md:block" : "block"
        }`}
      >
        {name}
      </strong>
      {children}
      <form action={exitAction} className="shrink-0">
        <button
          type="submit"
          className="-mr-2 rounded px-2 py-2 text-[11px] leading-tight font-semibold underline whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bone"
        >
          {exitLabel}
        </button>
      </form>
    </div>
  );
}
