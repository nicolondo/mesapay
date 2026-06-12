import { CONTACT } from "@/app/nicolas/contact";

/**
 * vCard de Nicolás — al abrirla, iOS y Android ofrecen "Añadir a contactos".
 * Es la vía universal de "guardar en el teléfono" (no requiere certificados
 * de Apple Wallet ni cuenta issuer de Google Wallet).
 */
export async function GET() {
  const vcard = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${CONTACT.lastName};${CONTACT.firstName};;;`,
    `FN:${CONTACT.fullName}`,
    `ORG:${CONTACT.org}`,
    "TITLE:Gerente General",
    `TEL;TYPE=CELL,VOICE:${CONTACT.phoneE164}`,
    `EMAIL;TYPE=INTERNET,WORK:${CONTACT.email}`,
    `URL:${CONTACT.site}`,
    `URL;TYPE=Tarjeta:${CONTACT.cardUrl}`,
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
