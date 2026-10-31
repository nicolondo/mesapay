"use client";

// Navegación de los gráficos (drill-down): un clic en una barra, una celda o
// un punto navega a otra URL dentro de una transición, y el marco que
// envuelve los gráficos baja la opacidad mientras llega la página nueva
// (se conserva lo que había: sin esqueleto ni salto de diseño).
//
// Los enlaces son <a href> de verdad: abrir en otra pestaña, copiar el
// enlace o navegar con el teclado funcionan igual.
import { createContext, useContext, useTransition, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";

type Nav = { navigate: (href: string) => void; pending: boolean };

const ChartNavContext = createContext<Nav>({
  navigate: (href) => {
    window.location.assign(href);
  },
  pending: false,
});

export function ChartNavProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const navigate = (href: string) => startTransition(() => router.push(href, { scroll: false }));
  return <ChartNavContext.Provider value={{ navigate, pending }}>{children}</ChartNavContext.Provider>;
}

export function useChartNav(): Nav {
  return useContext(ChartNavContext);
}

/** ¿El clic pide otra pestaña/ventana? Entonces se deja al navegador. */
function isModified(e: MouseEvent) {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
}

export function ChartLink({
  href,
  children,
  onClick,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const { navigate } = useChartNav();
  return (
    <a
      href={href}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || isModified(e)) return;
        e.preventDefault();
        navigate(href);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

/** Marco que se atenúa durante la navegación (mantiene el render anterior). */
export function PendingFrame({ children, className }: { children: ReactNode; className?: string }) {
  const { pending } = useChartNav();
  return (
    <div className={`mp-viz-frame${className ? ` ${className}` : ""}`} data-pending={pending || undefined} aria-busy={pending || undefined}>
      {children}
    </div>
  );
}
