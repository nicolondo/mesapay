import Link from "next/link";
import { NewRestaurantClient } from "./NewRestaurantClient";

export const dynamic = "force-dynamic";

/**
 * Wizard para crear un restaurante nuevo dentro del grupo. Auth
 * la gestiona el layout (/group/layout.tsx). Form chico — sólo
 * nombre + slug + modo de servicio. Todo lo demás (identidad,
 * pagos, menú) se configura después desde el operator del nuevo
 * local.
 */
export default function NewRestaurantPage() {
  return (
    <div className="flex-1 p-4 md:p-6 max-w-2xl mx-auto w-full">
      <Link
        href="/group"
        className="font-mono text-[10px] tracking-wider uppercase text-op-muted hover:text-op-text"
      >
        ← Grupo
      </Link>
      <div className="font-display text-3xl tracking-[-0.015em] mt-2 mb-1">
        Nuevo restaurante
      </div>
      <p className="text-sm text-op-muted mb-6">
        El restaurante queda dentro de tu grupo. Después podés
        asignarle razón social, crear usuarios, configurar identidad
        y pagos desde el operator del local.
      </p>
      <NewRestaurantClient />
    </div>
  );
}
