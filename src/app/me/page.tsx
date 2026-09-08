import { redirect } from "next/navigation";

/**
 * "Mi cuenta" global: ya no existe.
 *
 * Mostraba las órdenes de la persona en TODOS los restaurantes MESAPAY,
 * porque la identidad del comensal era global. Desde que el registro es por
 * comercio, esa pantalla vive dentro del comercio: `/t/<slug>/cuenta`.
 *
 * La ruta se conserva redirigiendo (y no borrada) por los marcadores y
 * correos viejos que apuntan acá.
 */
export default function MyAccountWithoutTenant() {
  redirect("/cuenta/entrar");
}
