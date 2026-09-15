import { describe, expect, it } from "vitest";
import { renderDianInvoiceEmail, resolveDianRecipient } from "./invoiceEmail";

const CUFE =
  "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

const base = {
  brandName: "Son y Melona",
  invoiceNumber: "FESM6482",
  issuedAt: new Date("2026-09-14T20:04:05.000Z"),
  cufe: CUFE,
  totalCents: 12_345_600,
  invoiceUrl: "https://mesapay.co/factura/abc123",
  verifyUrl: `https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=${CUFE}`,
  attachmentName: "adFESM6482.zip",
};

describe("resolveDianRecipient — a quién va la factura electrónica", () => {
  it("la personalizada manda sobre la genérica", () => {
    expect(
      resolveDianRecipient({
        invoiceRequestEmail: "contador@empresa.com",
        simpleInvoiceEmail: "comensal@gmail.com",
        orderSimpleInvoiceEmail: "otro@gmail.com",
      }),
    ).toBe("contador@empresa.com");
  });

  it("sin solicitud personalizada, el correo con el que se emitió la factura", () => {
    expect(
      resolveDianRecipient({
        simpleInvoiceEmail: "comensal@gmail.com",
        orderSimpleInvoiceEmail: "otro@gmail.com",
      }),
    ).toBe("comensal@gmail.com");
  });

  it("cae a lo que el comensal dejó en el checkout", () => {
    expect(
      resolveDianRecipient({ orderSimpleInvoiceEmail: "otro@gmail.com" }),
    ).toBe("otro@gmail.com");
  });

  it("nadie pidió factura ⇒ null (no es un error, es que no hay a quién)", () => {
    expect(resolveDianRecipient({})).toBeNull();
    // Vacíos y espacios en blanco no cuentan como destinatario: mandar a ""
    // sería un rebote garantizado.
    expect(
      resolveDianRecipient({ simpleInvoiceEmail: "   ", orderSimpleInvoiceEmail: "" }),
    ).toBeNull();
  });

  it("un correo con espacios alrededor se manda limpio", () => {
    expect(
      resolveDianRecipient({ invoiceRequestEmail: "  contador@empresa.com " }),
    ).toBe("contador@empresa.com");
  });
});

describe("renderDianInvoiceEmail — lo que el adquiriente tiene que ver", () => {
  it("lleva número, fecha, total, CUFE y el enlace a la representación gráfica", async () => {
    const mail = await renderDianInvoiceEmail({ ...base, locale: "es" });
    for (const fragment of [
      base.invoiceNumber,
      base.cufe,
      base.invoiceUrl,
      base.verifyUrl,
    ]) {
      expect(mail.html).toContain(fragment);
      expect(mail.text).toContain(fragment);
    }
    // El total va formateado, no en centavos.
    expect(mail.html).toContain("123.456");
    expect(mail.html).not.toContain("12345600");
    // Fecha en hora Colombia: 20:04 UTC del 14 es todavía el 14 en Bogotá.
    expect(mail.text).toContain("2026");
  });

  it("es trilingüe y sale en el idioma del COMENSAL", async () => {
    const es = await renderDianInvoiceEmail({ ...base, locale: "es" });
    const en = await renderDianInvoiceEmail({ ...base, locale: "en" });
    const pt = await renderDianInvoiceEmail({ ...base, locale: "pt" });
    expect(es.subject).toContain("factura electrónica");
    expect(en.subject).toContain("electronic invoice");
    expect(pt.subject).toContain("nota fiscal");
    // Ninguno puede quedarse con una clave sin traducir.
    for (const mail of [es, en, pt]) {
      expect(mail.subject).toContain(base.brandName);
      expect(mail.subject).toContain(base.invoiceNumber);
      expect(mail.html).not.toContain("emailDianInvoice.");
    }
    expect(es.html).toContain('lang="es"');
    expect(pt.html).toContain('lang="pt"');
  });

  it("sin locale cae a español (los webhooks no tienen cookie de idioma)", async () => {
    const mail = await renderDianInvoiceEmail({ ...base, locale: null });
    expect(mail.html).toContain('lang="es"');
  });

  it("sin adjunto no promete un archivo que no va", async () => {
    // Si el acuse de la DIAN no se pudo recuperar el correo sale igual,
    // pero prometerle un XML al cliente que no está adjunto es peor que
    // no mencionarlo.
    const conSobre = await renderDianInvoiceEmail({ ...base, locale: "es" });
    const sinSobre = await renderDianInvoiceEmail({
      ...base,
      attachmentName: null,
      locale: "es",
    });
    expect(conSobre.html).toContain("adFESM6482.zip");
    expect(sinSobre.html).not.toContain("adFESM6482.zip");
    expect(sinSobre.text).not.toContain("adFESM6482.zip");
    // Lo esencial sigue estando.
    expect(sinSobre.html).toContain(base.cufe);
    expect(sinSobre.html).toContain(base.invoiceUrl);
  });

  it("el nombre del comercio se escapa: no puede inyectar HTML en el correo", async () => {
    const mail = await renderDianInvoiceEmail({
      ...base,
      brandName: 'Bar <script>alert("x")</script>',
      locale: "es",
    });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
  });
});

describe("renderDianInvoiceEmail — datos del emisor", () => {
  it("muestra dirección, ciudad y teléfono cuando vienen en el snapshot", async () => {
    const { html, text } = await renderDianInvoiceEmail({
      ...base,
      issuerAddress: "Vía Las Palmas Km 17, Mall Indiana LC 112",
      issuerCity: "Envigado, Antioquia",
      issuerPhone: "+57 320 123 4567",
    });
    expect(html).toContain("Vía Las Palmas Km 17, Mall Indiana LC 112");
    expect(html).toContain("Envigado, Antioquia");
    expect(html).toContain("Tel: +57 320 123 4567");
    expect(text).toContain("Tel: +57 320 123 4567");
    // El emisor va ANTES del número de factura, como en la tirilla.
    expect(text.indexOf("Envigado")).toBeLessThan(text.indexOf("FESM6482"));
  });

  it("sin datos del emisor no deja renglones vacíos ni un 'Tel:' huérfano", async () => {
    const { html, text } = await renderDianInvoiceEmail({
      ...base,
      issuerAddress: null,
      issuerCity: "   ",
      issuerPhone: undefined,
    });
    expect(html).not.toContain("Tel:");
    expect(text).not.toContain("Tel:");
    expect(text).not.toMatch(/\n\n\n/);
  });

  it("escapa HTML en la dirección: nada del comercio se interpreta como markup", async () => {
    const { html } = await renderDianInvoiceEmail({
      ...base,
      issuerAddress: "Cra 6 <b>24A</b> Sur",
    });
    expect(html).toContain("Cra 6 &lt;b&gt;24A&lt;/b&gt; Sur");
    expect(html).not.toContain("<b>24A</b>");
  });
});
