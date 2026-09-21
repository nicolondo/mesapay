import { getTranslations } from "next-intl/server";
import { EntryForm } from "../EntryForm";
import { loadComprobantesContext } from "../gate";

export const dynamic = "force-dynamic";

/** Alta de un comprobante manual (asiento libre). */
export default async function NuevoComprobantePage() {
  const tSettings = await getTranslations("opSettings");
  const ctx = await loadComprobantesContext();
  if (ctx === "no_restaurant") {
    return <div className="p-6">{tSettings("noRestaurant")}</div>;
  }
  return (
    <div className="p-6 max-w-4xl mx-auto w-full">
      <EntryForm mode="create" currency={ctx.currency} />
    </div>
  );
}
