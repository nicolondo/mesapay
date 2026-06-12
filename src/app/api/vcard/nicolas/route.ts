import { CONTACT } from "@/app/nicolas/contact";

/**
 * vCard de Nicolás — al abrirla, iOS y Android ofrecen "Añadir a contactos".
 * Es la vía universal de "guardar en el teléfono" (no requiere certificados
 * de Apple Wallet ni cuenta issuer de Google Wallet).
 */
export async function GET() {
  // ORG y NOTE llevan palabras clave del negocio a propósito: la búsqueda de
  // contactos de iOS/Android indexa empresa y notas, así quien guardó el
  // contacto lo encuentra buscando "QR", "menú", "carta" o "restaurante"
  // aunque no recuerde el nombre de Nicolás ni el de MESAPAY.
  const vcard = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${CONTACT.lastName};${CONTACT.firstName};;;`,
    `FN:${CONTACT.fullName}`,
    `ORG:${CONTACT.org} - Menú y pagos con QR`,
    "TITLE:Gerente General",
    `TEL;TYPE=CELL,VOICE:${CONTACT.phoneE164}`,
    `EMAIL;TYPE=INTERNET,WORK:${CONTACT.email}`,
    `URL:${CONTACT.site}`,
    `URL;TYPE=Tarjeta:${CONTACT.cardUrl}`,
    "NOTE:Carta digital y pagos con QR para restaurantes. Los clientes piden y " +
      "pagan desde la mesa sin app y el pedido pasa directo a la cocina. " +
      `Web: ${CONTACT.siteDisplay} · Tarjeta: ${CONTACT.cardUrlDisplay}`,
    "END:VCARD",
  ].join("\r\n");

  return new Response(vcard, {
    headers: {
      "content-type": "text/vcard; charset=utf-8",
      "content-disposition": 'attachment; filename="nicolas-londono-mesapay.vcf"',
      "cache-control": "public, max-age=3600",
    },
  });
}
