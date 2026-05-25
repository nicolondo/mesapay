import Link from "next/link";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getRestaurantMenuTags } from "@/lib/menuTags";
import { TagsClient } from "./TagsClient";

export const dynamic = "force-dynamic";

export default async function TagsSettingsPage() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const tags = await getRestaurantMenuTags(restaurantId);

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <Link
        href="/operator/settings"
        className="font-mono text-[11px] tracking-[0.14em] uppercase text-op-muted hover:text-ink"
      >
        ← Configuración
      </Link>
      <div className="font-display text-3xl mt-2 mb-1">Etiquetas de platos</div>
      <p className="text-sm text-op-muted mb-6">
        Marca tus platos con etiquetas como “De la casa” o “Picante”. Aparecen
        como chips al lado del nombre tanto para el cliente como en cocina.
      </p>

      <TagsClient initial={tags} />
    </div>
  );
}
