import { getTranslations } from "next-intl/server";
import { EntryForm } from "../../EntryForm";
import { loadComprobantesContext } from "../../gate";

export const dynamic = "force-dynamic";

/**
 * Edición de un comprobante manual. El servidor sólo acepta el PUT si es
 * manual y su mes (viejo y nuevo) está abierto; acá se muestra el formulario
 * y el error llega por código si no aplica.
 */
export default async function EditarComprobantePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const tSettings = await getTranslations("opSettings");
  const ctx = await loadComprobantesContext();
  if (ctx === "no_restaurant") {
    return <div className="p-6">{tSettings("noRestaurant")}</div>;
  }
  return (
    <div className="p-6 max-w-4xl mx-auto w-full">
      <EntryForm mode="edit" entryId={id} currency={ctx.currency} />
    </div>
  );
}
