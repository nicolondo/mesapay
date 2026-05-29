import { NextResponse } from "next/server";

/**
 * Apple Pay domain association — Apple bate este path para verificar
 * que controlamos el dominio antes de habilitar Apple Pay. Lo servimos
 * desde public/.well-known/ y además exponemos este route handler como
 * fallback por si nginx o Next deciden bloquear archivos dotfile.
 *
 * El contenido es el token que Kushki nos dio para nuestro Apple Pay
 * Merchant ID. Si Kushki rota el token o cambiamos de PSP, regenerar
 * este archivo + actualizar el route handler.
 *
 * Cache largo en headers — Apple bate este endpoint a baja frecuencia
 * y el contenido no cambia hasta que rotemos credenciales.
 */
const TOKEN =
  "7b2276657273696f6e223a312c227073704964223a2241354133373439304333444143333934343432324639314642333932324246323637323445344434393541443838344531364637364342384332303534444533222c22637265617465644f6e223a313736383331383632373139347d";

export function GET() {
  return new NextResponse(TOKEN, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
}
