import { NextResponse } from "next/server";

/**
 * Apple Pay domain association — Apple bate este path para verificar
 * que controlamos el dominio antes de habilitar Apple Pay. Lo servimos
 * desde public/.well-known/ y además exponemos este route handler como
 * fallback por si nginx o Next deciden bloquear archivos dotfile.
 *
 * El contenido es el token que Kushki nos dio para nuestro Apple Pay
 * Merchant ID (hex de `{"version":1,"pspId":"E39F…705D","createdOn":…}`).
 * Kushki emite un archivo DISTINTO por ambiente (pruebas/UAT y
 * producción) y el dominio se registra en Kushki Console → Configuración →
 * Integraciones → Apple Pay. Si Kushki rota el token o cambiamos de PSP,
 * actualizar public/.well-known/ y esta constante juntos (el test lo exige).
 *
 * 2026-10-28: el dueño recibió de Kushki el archivo con createdOn
 * 1763752386727; reemplaza al de createdOn 1768318627194 (mayo, ver git).
 * Mismo pspId (A5A3…4DE3): era el archivo de PRUEBAS.
 *
 * 2026-10-31: Kushki entregó el archivo de PRODUCCIÓN (pspId E39F…705D,
 * createdOn 1763752422865). En esta ruta cabe uno solo y la plataforma ya
 * cobra en modo producción, así que queda el de producción. Si hiciera
 * falta volver a validar el dominio en pruebas, el de pruebas está en git.
 *
 * Cache largo en headers — Apple bate este endpoint a baja frecuencia
 * y el contenido no cambia hasta que rotemos credenciales.
 */
const TOKEN =
  "7b2276657273696f6e223a312c227073704964223a2245333946453835443137314232463931373338394635323836464441464546384334464241344444444630314231303046314146363742304438433737303544222c22637265617465644f6e223a313736333735323432323836357d";

export function GET() {
  return new NextResponse(TOKEN, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
}
