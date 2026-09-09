import { redirect } from "next/navigation";

/**
 * Alta del comensal sin restaurante: ya no existe.
 *
 * La cuenta del comensal es de UN comercio, así que crearla exige saber
 * cuál — el alta real vive en `/t/<slug>/cuenta/registro`. Acá solo queda
 * la redirección a la pantalla que explica que hay que escanear el QR del
 * restaurante, para no romper los enlaces viejos que apuntan a /signup.
 *
 * OJO: /signup/restaurant (el alta de RESTAURANTES, que es otra cosa) no se
 * toca.
 */
export default function SignUpWithoutTenant() {
  redirect("/cuenta/entrar");
}
