import { redirect } from "next/navigation";

/**
 * Landing de /admin. Abre directo en Restaurantes (es lo primero que el admin
 * usa al entrar). El dashboard de KPIs vive ahora en /admin/resumen — el link
 * "Resumen" sigue en la nav.
 */
export default function AdminIndex() {
  redirect("/admin/restaurants");
}
