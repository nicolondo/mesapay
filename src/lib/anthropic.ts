import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env, requireAnthropicKey } from "./env";

/**
 * Anthropic client + small surface for the features we use today.
 *
 * Today: bank-certification OCR for Kushki onboarding. The bank cert is a
 * Colombian "certificación bancaria" — usually a 1-page PDF or photo with
 * bank name, account number, account type, holder name and ID. We send it
 * to Claude with a strict JSON schema and a cacheable system prompt so each
 * call is cheap (cost: ~$0.01-0.02 with Haiku).
 */

let client: Anthropic | null = null;
export function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: requireAnthropicKey() });
  }
  return client;
}

const BankCertSchema = z.object({
  bankName: z.string().min(1).nullable(),
  accountType: z.enum(["ahorros", "corriente", "unknown"]),
  accountNumber: z.string().min(1).nullable(),
  holderName: z.string().min(1).nullable(),
  holderDocType: z.enum(["CC", "CE", "NIT", "PA", "unknown"]),
  holderDocNumber: z.string().min(1).nullable(),
  confidence: z.number().min(0).max(1),
  notes: z.string().optional(),
});

export type BankCertExtraction = z.infer<typeof BankCertSchema>;

// Menu import — extract dishes from a PDF / photo. The model decides
// categories + items + tags; the operator reviews before we touch the DB.
// Tags are now configured per restaurant; we accept any non-empty slug
// here and filter at the import-preview step so the operator sees only
// tags that match their registry.
const CategoryKind = z.enum([
  "starter",
  "main",
  "side",
  "drink",
  "dessert",
  "other",
]);

const ExtractedMenuItem = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable(),
  // Always in cents to match Prisma. Bank-cert OCR taught us model
  // returns either "$25.000" or 25000 — we ask for cents directly.
  priceCents: z.number().int().min(0).max(100_000_000),
  categorySlug: z.string().min(1).max(60),
  tags: z.array(z.string().min(1).max(32)).default([]),
  // For HTML imports: the absolute URL of the dish photo when one is
  // visible near the item in the source page. Server-side we download
  // these to UPLOAD_DIR and rewrite to local paths before sending to the
  // client.
  photoUrl: z.string().url().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.8),
});

const ExtractedCategory = z.object({
  slug: z.string().min(1).max(60),
  label: z.string().min(1).max(80),
  kind: CategoryKind,
  sortOrder: z.number().int().min(0).max(100).default(0),
  // Subcategoría (un solo nivel): slug de la categoría PADRE cuando la carta
  // tiene estructura de dos niveles (ej. vinos: "Vino Tinto" → cepas; bebidas:
  // "Gaseosas / Jugos"). null/omitido = categoría de nivel superior.
  // `.optional()` (no `.default`) para que los demás importadores planos
  // (Cluvi/Justo/Shopify) no tengan que setearlo.
  parentSlug: z.string().max(60).nullable().optional(),
});

const MenuExtractionSchema = z.object({
  categories: z.array(ExtractedCategory).default([]),
  items: z.array(ExtractedMenuItem).default([]),
  notes: z.string().optional(),
});

export type ExtractedMenuItemType = z.infer<typeof ExtractedMenuItem>;
export type ExtractedCategoryType = z.infer<typeof ExtractedCategory>;
export type MenuExtraction = z.infer<typeof MenuExtractionSchema>;

function buildMenuSystem(allowedTagSlugs: string[]): string {
  // Inject the restaurant's current tag registry into the prompt so the
  // model picks from THEIR slugs rather than the legacy hardcoded five.
  // Empty list → instruct the model to leave tags empty.
  const tagsRule =
    allowedTagSlugs.length > 0
      ? `- tags: usa SOLO estos slugs (lista cerrada de este restaurante): ${allowedTagSlugs
          .map((s) => `"${s}"`)
          .join(
            ", ",
          )}. Solo si se ve claro en la carta. Si no estás seguro, omite el tag. Default: [].`
      : "- tags: este restaurante no tiene etiquetas configuradas. Devuelve siempre [].";
  const tagsExample = allowedTagSlugs.length > 0 ? allowedTagSlugs : ["firma"];
  return `Eres un asistente que extrae la información estructurada de una carta de restaurante (Colombia).
Devuelve SOLO un objeto JSON con esta forma exacta — sin Markdown, sin texto adicional:

{
  "categories": [
    {
      "slug": "para-empezar",            // kebab-case, sin tildes, sin espacios
      "label": "Para empezar",            // como aparece en la carta o un nombre claro
      "kind": "starter" | "main" | "side" | "drink" | "dessert" | "other",
      "sortOrder": 0,                     // 0..N en el orden que aparecen
      "parentSlug": null                  // o el slug del grupo PADRE (un nivel)
    }
  ],
  "items": [
    {
      "name": "Ceviche de corvina",
      "description": "Corvina curada en limón…" | null,
      "priceCents": 3800000,             // en CENTAVOS de peso colombiano: $38.000 -> 3800000
      "categorySlug": "para-empezar",
      "tags": ${JSON.stringify(tagsExample)},  // 0..N de la lista permitida abajo
      "photoUrl": "https://restaurante.com/imgs/ceviche.jpg" | null,
      "confidence": 0.9                   // 0..1, qué tan seguro estás de este plato
    }
  ],
  "notes": "opcional, 1 frase"
}

Reglas estrictas:
- priceCents en CENTAVOS, multiplica por 100 el precio. "$25.000" -> 2500000.
- Si no hay precio claro, omite el plato.
- categorySlug debe coincidir con un slug en "categories". Crea categorías si la carta no las tiene explícitas — agrúpalas por sentido común (entradas, principales, postres, bebidas, etc.).
- parentSlug (jerarquía, OPCIONAL — UN SOLO NIVEL): si la carta tiene grupos con subgrupos claros, crea UNA categoría por grupo (nivel superior, parentSlug null) y UNA por subgrupo con parentSlug = slug del grupo. Ejemplos: una carta de vinos con secciones "VINOS TINTOS / BLANCOS / ROSADOS / ESPUMANTES / CAVAS" y dentro cepas (Cabernet Sauvignon, Malbec, Carmenère, Chardonnay…) → crea "Vino Tinto" (parentSlug null) y "Cabernet Sauvignon" (parentSlug "vino-tinto"), etc.; o "Bebidas" con "Gaseosas / Jugos / Cervezas". Los items van SIEMPRE en la subcategoría (la hoja, p.ej. la cepa), nunca directo en el grupo padre. Una subcategoría NO puede tener su propia subcategoría. Si la carta es plana (sin subgrupos), deja parentSlug null en todas.
- kind: starter (entradas), main (fuertes), side (acompañamientos), drink (bebidas), dessert (postres), other.
${tagsRule}
- description: tal cual aparece, o null si no hay.
- photoUrl: si en el HTML hay una etiqueta <img src="..."> de la foto del plato cerca del nombre y precio, incluye la URL ABSOLUTA (http o https). Si no hay foto o no estás seguro de cuál corresponde, null. NO inventes URLs. NO uses data: URIs. Solo aplica a HTML — en PDFs/imágenes deja null.
- Si la carta tiene varias páginas / fotos, procesa todo.
- Si algo no se entiende, baja la confidence y mete una nota en "notes".`;
}

export async function extractMenuFromDocument(
  source: Source,
  // List of tag slugs the operator has configured for this restaurant.
  // Optional for back-compat (callers that haven't been wired yet fall
  // back to the legacy hardcoded five so behaviour doesn't change).
  allowedTagSlugs: string[] = ["firma", "popular", "veg", "spicy", "nuevo"],
): Promise<MenuExtraction> {
  const c = getClient();
  const systemPrompt = buildMenuSystem(allowedTagSlugs);

  let content: Anthropic.Messages.ContentBlockParam[];

  if (source.kind === "html") {
    // Trim down obvious noise (scripts, styles, comments) and cap length
    // so we don't blow through the context window on huge marketing
    // pages. The menu items rarely live in script tags.
    // We DO keep <img> tags so Claude can match dish names to nearby
    // photos and return absolute photoUrls — but we resolve relative
    // src/data-src to absolute first (relative paths are useless to us
    // once we leave the original URL's context).
    const baseUrl = source.sourceUrl;
    const resolveSrc = (raw: string): string | null => {
      if (!raw) return null;
      if (raw.startsWith("data:")) return null;
      try {
        return baseUrl ? new URL(raw, baseUrl).toString() : raw;
      } catch {
        return null;
      }
    };
    const normalisedImgs = source.text.replace(
      /<img\b[^>]*>/gi,
      (tag) => {
        // Lazy-loaded images often hide the real src in data-src or
        // data-original. Try those if src is empty / placeholder.
        const srcMatch =
          /\bsrc=["']([^"']+)["']/i.exec(tag)?.[1] ??
          /\bdata-src=["']([^"']+)["']/i.exec(tag)?.[1] ??
          /\bdata-original=["']([^"']+)["']/i.exec(tag)?.[1];
        const resolved = srcMatch ? resolveSrc(srcMatch) : null;
        if (!resolved) return " ";
        const altMatch = /\balt=["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
        return `<img src="${resolved}" alt="${altMatch}">`;
      },
    );
    const cleaned = normalisedImgs
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 250_000);
    const prefix = source.sourceUrl
      ? `Esta es la página web del restaurante (${source.sourceUrl}). Extrae la carta:\n\n`
      : "Esta es la página web del restaurante. Extrae la carta:\n\n";
    content = [{ type: "text", text: prefix + cleaned }];
  } else {
    const base64 = source.data.toString("base64");
    content =
      source.kind === "pdf"
        ? [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: base64,
              },
            },
            // En PDFs no hay fotos descargables ni HTML, así que pedimos
            // un JSON más compacto omitiendo photoUrl y confidence. Eso
            // reduce ~30% el output y deja max_tokens libre para cartas
            // muy largas.
            {
              type: "text",
              text:
                "Extrae toda la carta del restaurante.\n\n" +
                'Importante: en cada item de "items" devuelve SOLO los campos ' +
                "name, description, priceCents, categorySlug y tags. " +
                "NO incluyas photoUrl ni confidence (los completaremos del lado servidor).",
            },
          ]
        : [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: source.mimeType as
                  | "image/png"
                  | "image/jpeg"
                  | "image/webp"
                  | "image/gif",
                data: base64,
              },
            },
            {
              type: "text",
              text:
                "Extrae toda la carta del restaurante.\n\n" +
                "Importante: en cada item de \"items\" devuelve SOLO los campos " +
                "name, description, priceCents, categorySlug y tags. " +
                "NO incluyas photoUrl ni confidence.",
            },
          ];
  }

  // Use streaming. The Anthropic SDK refuses non-streaming calls when
  // the estimated completion exceeds 10 minutes — which a 25+ page
  // carta with max_tokens=32k can easily trigger ("Streaming is
  // required for operations that may take longer than 10 minutes").
  // We don't surface progress to the diner; we just consume the
  // stream to completion and treat the final message identically to
  // the old non-streaming response.
  const stream = c.messages.stream({
    // Big output budget. A dense carta (e.g. 14 tall pages with 200+
    // platos) can blow past 32k tokens of JSON. 64k is the Haiku 4.5
    // and Sonnet 4.5 cap; combined with the "skip photoUrl/confidence"
    // hint above it leaves plenty of headroom while keeping the bill
    // bounded (we never use more than we emit).
    model: env.ANTHROPIC_MODEL,
    max_tokens: 64_000,
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content }],
  });
  const resp = await stream.finalMessage();

  // If the model genuinely ran out of room (stop_reason="max_tokens"),
  // the JSON is mid-emit and JSON.parse will fail. We log that case so
  // the notes returned to the client point at the real cause rather
  // than a generic parse error.
  const truncated = resp.stop_reason === "max_tokens";

  const text = resp.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      categories: [],
      items: [],
      notes: truncated
        ? "La carta tiene tantos platos que la IA se quedó sin espacio. Divide el PDF en 2 partes (ej. bebidas aparte de comida) y súbelas por separado."
        : `model returned non-JSON: ${text.slice(0, 200)}`,
    };
  }
  const result = MenuExtractionSchema.safeParse(parsed);
  if (!result.success) {
    return {
      categories: [],
      items: [],
      notes: `schema mismatch: ${result.error.issues[0]?.message}`,
    };
  }
  return result.data;
}

const RutSchema = z.object({
  // Razón social del comercio (persona jurídica) o nombre completo del
  // representante (persona natural). Lo usamos como "legalName".
  legalName: z.string().min(1).nullable(),
  // NIT en personas jurídicas, cédula en naturales. Dígitos solamente.
  taxId: z.string().min(1).nullable(),
  // Si la DIAN nos da DV (dígito de verificación) lo capturamos aparte
  // para no confundir el match con el banco más adelante.
  taxIdDV: z.string().min(1).nullable(),
  // Datos secundarios que aparecen en el RUT y queremos pre-llenar.
  contactEmail: z.string().email().nullable(),
  contactPhone: z.string().min(6).nullable(),
  confidence: z.number().min(0).max(1),
  notes: z.string().optional(),
});

export type RutExtraction = z.infer<typeof RutSchema>;

const BANK_CERT_SYSTEM = `Eres un asistente que extrae datos de una "certificación bancaria" colombiana.
Devuelve SOLO un objeto JSON con esta forma exacta — sin Markdown, sin texto adicional:

{
  "bankName": string | null,             // ej. "Bancolombia", "Davivienda"
  "accountType": "ahorros" | "corriente" | "unknown",
  "accountNumber": string | null,        // dígitos, sin espacios ni puntos
  "holderName": string | null,           // razón social o nombre del titular
  "holderDocType": "CC" | "CE" | "NIT" | "PA" | "unknown",
  "holderDocNumber": string | null,      // sin dígito de verificación
  "confidence": number,                  // 0..1 — qué tan seguro estás
  "notes": string                        // opcional, máx 1 frase
}

Reglas:
- Si un campo no se ve claramente, ponlo en null y baja la confianza.
- accountNumber: solo dígitos (quita guiones, puntos y espacios).
- bankName: usa el nombre comercial del banco, no abreviaturas oficiales.
- Si el documento no parece una certificación bancaria, devuelve todos los campos en null con confidence 0 y nota explicando.`;

type DocumentSource =
  | { kind: "image"; data: Buffer; mimeType: string }
  | { kind: "pdf"; data: Buffer };

type Source =
  | DocumentSource
  // HTML content from a fetched URL. Used by the menu importer when the
  // restaurant has the carta on their website. Bank cert / RUT OCR don't
  // make sense from HTML so they don't accept this variant.
  | { kind: "html"; text: string; sourceUrl?: string };

/**
 * Read a bank certification (PDF or image) and return structured fields.
 * The caller is responsible for storing the original file; this just
 * extracts the data so the operator can verify it in a form.
 */
export async function extractBankCertificate(
  source: DocumentSource,
): Promise<BankCertExtraction> {
  const c = getClient();
  const base64 = source.data.toString("base64");

  // Anthropic accepts images directly and PDFs via the documents block.
  // We pick the right shape based on mime type.
  const content: Anthropic.Messages.ContentBlockParam[] =
    source.kind === "pdf"
      ? [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: base64,
            },
          },
          {
            type: "text",
            text: "Extrae los campos de la certificación bancaria.",
          },
        ]
      : [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: source.mimeType as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
              data: base64,
            },
          },
          {
            type: "text",
            text: "Extrae los campos de la certificación bancaria.",
          },
        ];

  const resp = await c.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 512,
    // Cache the system prompt — it's identical every call, so we only pay
    // full price on first request of the rolling 5-min cache window.
    system: [
      {
        type: "text",
        text: BANK_CERT_SYSTEM,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content,
      },
    ],
  });

  const text = resp.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  // Claude sometimes wraps JSON in ```json blocks despite the prompt.
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      bankName: null,
      accountType: "unknown",
      accountNumber: null,
      holderName: null,
      holderDocType: "unknown",
      holderDocNumber: null,
      confidence: 0,
      notes: `model returned non-JSON: ${text.slice(0, 200)}`,
    };
  }

  const result = BankCertSchema.safeParse(parsed);
  if (!result.success) {
    return {
      bankName: null,
      accountType: "unknown",
      accountNumber: null,
      holderName: null,
      holderDocType: "unknown",
      holderDocNumber: null,
      confidence: 0,
      notes: `schema mismatch: ${result.error.issues[0]?.message}`,
    };
  }
  return result.data;
}

const RUT_SYSTEM = `Eres un asistente que extrae datos de un RUT colombiano (Registro Único Tributario emitido por la DIAN).
Devuelve SOLO un objeto JSON con esta forma exacta — sin Markdown, sin texto adicional:

{
  "legalName": string | null,           // razón social de la empresa, o nombre completo si es persona natural
  "taxId": string | null,               // NIT o cédula, SOLO dígitos (sin DV, sin guiones, sin puntos)
  "taxIdDV": string | null,             // dígito de verificación (1 dígito) si aparece, si no null
  "contactEmail": string | null,        // si aparece un correo, si no null
  "contactPhone": string | null,        // si aparece teléfono, dígitos + + opcional al inicio
  "confidence": number,                 // 0..1 — qué tan seguro estás
  "notes": string                       // opcional, máx 1 frase
}

Reglas:
- Si un campo no se ve claramente, ponlo en null y baja la confianza.
- taxId: solo dígitos, sin DV. Si en el documento aparece "900123456-7", taxId="900123456" y taxIdDV="7".
- legalName: si es persona jurídica, la razón social; si es natural, el nombre completo del contribuyente.
- Si el documento no parece un RUT, devuelve todos los campos en null con confidence 0.`;

// Default model for the Pulso insights assistant. Override with the
// ANTHROPIC_INSIGHTS_MODEL env var (e.g. claude-sonnet-4-5-20251101).
export const INSIGHTS_MODEL =
  process.env.ANTHROPIC_INSIGHTS_MODEL ?? "claude-sonnet-4-5";

export async function extractRutData(source: DocumentSource): Promise<RutExtraction> {
  const c = getClient();
  const base64 = source.data.toString("base64");

  const content: Anthropic.Messages.ContentBlockParam[] =
    source.kind === "pdf"
      ? [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: base64,
            },
          },
          { type: "text", text: "Extrae los campos del RUT." },
        ]
      : [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: source.mimeType as
                | "image/png"
                | "image/jpeg"
                | "image/webp"
                | "image/gif",
              data: base64,
            },
          },
          { type: "text", text: "Extrae los campos del RUT." },
        ];

  const resp = await c.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 512,
    system: [
      {
        type: "text",
        text: RUT_SYSTEM,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content }],
  });

  const text = resp.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      legalName: null,
      taxId: null,
      taxIdDV: null,
      contactEmail: null,
      contactPhone: null,
      confidence: 0,
      notes: `model returned non-JSON: ${text.slice(0, 200)}`,
    };
  }

  const result = RutSchema.safeParse(parsed);
  if (!result.success) {
    return {
      legalName: null,
      taxId: null,
      taxIdDV: null,
      contactEmail: null,
      contactPhone: null,
      confidence: 0,
      notes: `schema mismatch: ${result.error.issues[0]?.message}`,
    };
  }
  return result.data;
}

// ── Factura de compra de proveedor (ERP A2.5) ───────────────────────────────
// Lee la factura del proveedor (PDF/imagen) para armar una orden de compra
// en borrador que el operador revisa. La IA SOLO lee; nada se persiste sin
// confirmación. Todo en centavos.

const PurchaseInvoiceLine = z.object({
  description: z.string().min(1),
  // Cantidad de la línea (unidades de la presentación facturada).
  quantity: z.number().positive(),
  // Texto libre de la presentación tal como aparece ("caja x24", "bulto
  // 50 kg", "und", "L"). El operador la mapea a la del catálogo.
  unit: z.string().nullable(),
  unitPriceCents: z.number().int().nonnegative().nullable(),
  lineTotalCents: z.number().int().nonnegative().nullable(),
  // Tarifa de impuesto como texto ("0", "5", "19"), null si no se ve.
  taxPct: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

const PurchaseInvoiceSchema = z.object({
  // Tipo de documento: en una "cuenta de cobro" el proveedor es el acreedor
  // ("debe a:"), no quien la emite arriba. .catch(null) evita que un valor
  // inesperado del modelo tumbe toda la extracción.
  documentType: z
    .enum(["factura", "cuenta_de_cobro", "otro"])
    .nullable()
    .catch(null),
  supplierNit: z.string().nullable(),
  supplierName: z.string().nullable(),
  supplierInvoiceNumber: z.string().nullable(),
  issueDate: z.string().nullable(), // YYYY-MM-DD
  currency: z.enum(["COP", "MXN", "unknown"]),
  lines: z.array(PurchaseInvoiceLine),
  // Totales IMPRESOS en la factura (en centavos), para validar concordancia
  // con lo calculado desde las líneas. null si no se ven. .catch(null) tolera
  // valores raros sin tumbar la extracción.
  invoiceSubtotalCents: z.number().nullable().catch(null),
  invoiceTaxCents: z.number().nullable().catch(null),
  invoiceTotalCents: z.number().nullable().catch(null),
  confidence: z.number().min(0).max(1),
  notes: z.string().optional(),
});

export type PurchaseInvoiceLineType = z.infer<typeof PurchaseInvoiceLine>;
export type PurchaseInvoiceExtraction = z.infer<typeof PurchaseInvoiceSchema>;

// Schema RAW del modelo: montos en PESOS como número LITERAL (admite
// decimales). El ×100 a centavos lo hace el CÓDIGO — el modelo se equivocaba
// multiplicando por 100 valores con centavos decimales ("232.499,82" ->
// 23.249.982 -> ×100 = basura). Pidiéndole el número literal y convirtiendo
// acá con Math.round(pesos×100), el decimal se maneja bien.
const RawInvoiceLine = z.object({
  description: z.string().min(1),
  quantity: z.number().positive(),
  unit: z.string().nullable(),
  unitPrice: z.number().nonnegative().nullable().catch(null),
  lineTotal: z.number().nonnegative().nullable().catch(null),
  taxPct: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});
const RawInvoiceSchema = z.object({
  documentType: z
    .enum(["factura", "cuenta_de_cobro", "otro"])
    .nullable()
    .catch(null),
  supplierNit: z.string().nullable(),
  supplierName: z.string().nullable(),
  supplierInvoiceNumber: z.string().nullable(),
  issueDate: z.string().nullable(),
  currency: z.enum(["COP", "MXN", "unknown"]),
  lines: z.array(RawInvoiceLine),
  invoiceSubtotal: z.number().nullable().catch(null),
  invoiceTax: z.number().nullable().catch(null),
  invoiceTotal: z.number().nullable().catch(null),
  confidence: z.number().min(0).max(1),
  notes: z.string().optional(),
});

/** Pesos (literal, con decimales) → centavos enteros. null pasa como null. */
function pesosFieldToCents(p: number | null): number | null {
  return p == null || !isFinite(p) ? null : Math.round(p * 100);
}

const PURCHASE_INVOICE_SYSTEM = `Eres un asistente que extrae los datos de un DOCUMENTO DE COMPRA de un proveedor a un restaurante (Colombia/México). El documento puede ser una FACTURA o una CUENTA DE COBRO.
Devuelve SOLO un objeto JSON con esta forma exacta — sin Markdown, sin texto adicional:

{
  "documentType": "factura" | "cuenta_de_cobro" | "otro",  // tipo de documento
  "supplierNit": string | null,          // NIT/RFC/cédula del PROVEEDOR (acreedor, a quien se paga), SOLO dígitos, sin DV ni guiones
  "supplierName": string | null,         // razón social o nombre del proveedor (acreedor)
  "supplierInvoiceNumber": string | null,// número/consecutivo de la factura
  "issueDate": "YYYY-MM-DD" | null,       // fecha de la factura
  "currency": "COP" | "MXN" | "unknown",
  "lines": [
    {
      "description": string,             // nombre del producto/insumo como aparece
      "quantity": number,                // cantidad facturada (puede tener decimales)
      "unit": string | null,             // presentación tal cual ("caja x24", "bulto 50 kg", "und", "L", "kg")
      "unitPrice": number | null,        // precio UNITARIO en PESOS, número LITERAL con decimales. "$12.500" -> 12500 ; "13.025,21" -> 13025.21
      "lineTotal": number | null,        // total de la línea en PESOS (número literal con decimales)
      "taxPct": string | null,           // tarifa de impuesto de la línea ("0","5","19"), null si no se ve
      "confidence": number               // 0..1 qué tan seguro de ESTA línea
    }
  ],
  "invoiceSubtotal": number | null,       // SUBTOTAL impreso (sin IVA), en PESOS literal, null si no se ve
  "invoiceTax": number | null,            // IVA total impreso, en PESOS literal, null si no se ve
  "invoiceTotal": number | null,          // TOTAL a pagar impreso, en PESOS literal, null si no se ve
  "confidence": number,                   // 0..1 confianza global
  "notes": string                         // opcional, 1 frase (ej. "foto borrosa en el total")
}

Reglas estrictas:
- TODOS los montos en PESOS como número LITERAL. NUNCA multipliques por 100 ni conviertas a centavos — devuelve el número tal como está impreso. Interpreta el formato local del número: en Colombia el PUNTO separa miles y la COMA los decimales ("232.499,82" -> 232499.82 ; "$12.500" -> 12500 ; "1.250,50" -> 1250.50); en México es al revés ("232,499.82" -> 232499.82). El decimal (centavos) es OBLIGATORIO conservarlo cuando aparece.
- documentType: "cuenta_de_cobro" si el documento se titula "CUENTA DE COBRO" o lo emite una persona natural sin factura electrónica; "factura" si es una factura de venta/compra; "otro" en cualquier otro caso.
- PROVEEDOR = a quién se le PAGA (el acreedor/beneficiario). En una FACTURA es quien la emite. En una CUENTA DE COBRO es quien aparece después de "DEBE A:" — NO quien debe (el restaurante que paga, que suele ir arriba o antes de "debe a"). supplierName y supplierNit son SIEMPRE los del acreedor (a quien se le paga), nunca los del restaurante.
- supplierNit: el del PROVEEDOR (acreedor), NO el del restaurante que compra/debe. Solo dígitos, sin dígito de verificación.
- quantity: la cantidad facturada de esa línea. Si la línea dice "2 cajas", quantity=2 y unit="caja".
- unit: cópialo tal como aparece; no lo normalices.
- Ignora líneas que no sean productos (subtotales, IVA, totales, notas) DENTRO de "lines". Solo insumos comprados en "lines".
- taxPct por línea: la tarifa de IVA de esa línea ("0","5","19" CO; "0","8","16" MX). unitPrice/lineTotal son el NETO de la línea (sin IVA) cuando la factura discrimina IVA.
- invoiceSubtotal/invoiceTax/invoiceTotal: cópialos de los TOTALES impresos de la factura (no los sumes tú), en pesos literales, null si no se ven. Sirven para validar.
- Si un monto no se ve claro, ponlo en null y baja la confidence de esa línea.
- Si el documento no parece un documento de compra (factura ni cuenta de cobro), devuelve documentType "otro", lines vacío y confidence 0.`;

/**
 * Lee una factura de compra (PDF o imagen). El caller guarda el archivo
 * original; esto solo extrae los datos para que el operador los revise
 * antes de crear la orden de compra.
 */
export async function extractPurchaseInvoice(
  source: DocumentSource,
): Promise<PurchaseInvoiceExtraction> {
  const c = getClient();
  const base64 = source.data.toString("base64");
  const instruction =
    "Extrae los datos de este documento de compra (factura o cuenta de cobro).";
  const content: Anthropic.Messages.ContentBlockParam[] =
    source.kind === "pdf"
      ? [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: base64 },
          },
          { type: "text", text: instruction },
        ]
      : [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: source.mimeType as
                | "image/png"
                | "image/jpeg"
                | "image/webp"
                | "image/gif",
              data: base64,
            },
          },
          { type: "text", text: instruction },
        ];

  const empty: PurchaseInvoiceExtraction = {
    documentType: null,
    supplierNit: null,
    supplierName: null,
    supplierInvoiceNumber: null,
    issueDate: null,
    currency: "unknown",
    lines: [],
    invoiceSubtotalCents: null,
    invoiceTaxCents: null,
    invoiceTotalCents: null,
    confidence: 0,
    notes: "",
  };

  const resp = await c.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: PURCHASE_INVOICE_SYSTEM,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content }],
  });

  const text = resp.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { ...empty, notes: `model returned non-JSON: ${text.slice(0, 200)}` };
  }
  const result = RawInvoiceSchema.safeParse(parsed);
  if (!result.success) {
    return { ...empty, notes: `schema mismatch: ${result.error.issues[0]?.message}` };
  }
  const r = result.data;
  // Convertir PESOS → CENTAVOS acá (no el modelo): maneja bien los decimales.
  // Se valida contra el schema de salida (centavos) antes de devolver.
  return PurchaseInvoiceSchema.parse({
    documentType: r.documentType,
    supplierNit: r.supplierNit,
    supplierName: r.supplierName,
    supplierInvoiceNumber: r.supplierInvoiceNumber,
    issueDate: r.issueDate,
    currency: r.currency,
    lines: r.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      unitPriceCents: pesosFieldToCents(l.unitPrice),
      lineTotalCents: pesosFieldToCents(l.lineTotal),
      taxPct: l.taxPct,
      confidence: l.confidence,
    })),
    invoiceSubtotalCents: pesosFieldToCents(r.invoiceSubtotal),
    invoiceTaxCents: pesosFieldToCents(r.invoiceTax),
    invoiceTotalCents: pesosFieldToCents(r.invoiceTotal),
    confidence: r.confidence,
    notes: r.notes ?? "",
  });
}

// ── Importación masiva de insumos (ERP inventory) ───────────────────────────

const InventoryImportRow = z.object({
  name: z.string(),
  measureKind: z.enum(["mass", "volume", "count"]).catch("count"),
  category: z.string().nullable().catch(null),
  quantity: z.number().nullable().catch(null),
  unit: z.string().nullable().catch(null),
  unitPriceCents: z.number().nullable().catch(null),
  presentationNote: z.string().nullable().catch(null),
  confidence: z.number().min(0).max(1).catch(0.5),
});

const InventoryImportSchema = z.object({
  currency: z.enum(["COP", "MXN", "unknown"]).catch("unknown"),
  rows: z.array(InventoryImportRow),
  notes: z.string().optional(),
});

export type InventoryImportRowType = z.infer<typeof InventoryImportRow>;
export type InventoryImportExtraction = z.infer<typeof InventoryImportSchema>;

const INVENTORY_IMPORT_SYSTEM = `Eres un asistente que extrae un CATÁLOGO DE INSUMOS de un restaurante (Colombia/México) desde un archivo: foto, PDF, o el texto de una planilla Excel/CSV.
Devuelve SOLO un objeto JSON con esta forma exacta — sin Markdown, sin texto adicional:

{
  "currency": "COP" | "MXN" | "unknown",
  "rows": [
    {
      "name": string,                 // nombre LIMPIO del insumo, SIN la unidad/tamaño
      "measureKind": "mass" | "volume" | "count",
      "category": string | null,      // categoría corta sugerida
      "quantity": number | null,      // existencia inicial (en la unidad de "unit")
      "unit": string | null,          // unidad tal cual ("kg","g","L","ml","botella","und","caja")
      "unitPriceCents": number | null,// costo UNITARIO en CENTAVOS
      "presentationNote": string | null, // tamaño/presentación detectado ("botella 750 ml","bulto 25 kg")
      "confidence": number            // 0..1
    }
  ],
  "notes": string                     // opcional, 1 frase
}

Reglas estrictas:
- LIMPIAR EL NOMBRE: si el nombre trae la unidad o el tamaño ("Harina 25kg","Aceite Girasol 1L"), QUÍTALO del nombre (name="Harina" / "Aceite Girasol") y ponlo en unit/presentationNote.
- measureKind: masa (kg/g/lb/@) → "mass"; volumen (L/ml/cc) → "volume"; conteo (und/botella/caja/bulto/paquete/lata/docena) → "count".
- REGLA DE EMBOTELLADOS / LICOR (IMPORTANTE): si el producto es una BEBIDA o LICOR embotellado/enlatado y el nombre dice "750 ml","1 L","330 ml", ESO NO ES LA UNIDAD DE MEDIDA — es una BOTELLA/LATA (1 unidad) de ese tamaño. Entonces measureKind="count", unit="botella" (o "lata"), presentationNote="botella 750 ml". El licor y las bebidas embotelladas se cuentan por unidades, NO por volumen.
- unitPriceCents: costo unitario en CENTAVOS. "$12.500" -> 1250000. "1.250,50" -> 125050. null si no está.
- quantity: la existencia inicial si la planilla trae una columna de stock/cantidad; null si no.
- category: sugiere una categoría corta (Proteínas, Lácteos, Licores, Empaques, Verduras…). Filas que NO son productos (encabezados, subtotales, totales, separadores) → NO las incluyas en "rows".
- Todos los montos en CENTAVOS. Si un dato no se ve, ponlo en null.`;

/**
 * Lee un archivo (foto/PDF o texto de una planilla) y extrae un catálogo
 * de insumos para revisar. `instructions` son indicaciones libres del
 * operador para interpretar columnas/campos (se respetan por encima de
 * las heurísticas). El caller NO persiste el archivo — se procesa y se
 * revisa; reintentar = re-procesar con otras instrucciones.
 */
export async function extractInventoryImport(
  source: DocumentSource | { kind: "text"; text: string },
  instructions?: string | null,
): Promise<InventoryImportExtraction> {
  const c = getClient();
  const content: Anthropic.Messages.ContentBlockParam[] = [];
  if (source.kind === "text") {
    content.push({
      type: "text",
      text: "Contenido de la planilla (tabulado):\n\n" + source.text.slice(0, 200_000),
    });
  } else if (source.kind === "pdf") {
    content.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: source.data.toString("base64") },
    });
  } else {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: source.mimeType as
          | "image/png"
          | "image/jpeg"
          | "image/webp"
          | "image/gif",
        data: source.data.toString("base64"),
      },
    });
  }
  const instr = (instructions ?? "").trim();
  content.push({
    type: "text",
    text:
      "Extrae el catálogo de insumos de este archivo." +
      (instr
        ? "\n\nInstrucciones adicionales del usuario (respétalas): " + instr.slice(0, 4000)
        : ""),
  });

  const empty: InventoryImportExtraction = { currency: "unknown", rows: [], notes: "" };

  const resp = await c.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 16_000, // catálogos largos
    system: [
      { type: "text", text: INVENTORY_IMPORT_SYSTEM, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content }],
  });

  const text = resp.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { ...empty, notes: `model returned non-JSON: ${text.slice(0, 200)}` };
  }
  const result = InventoryImportSchema.safeParse(parsed);
  if (!result.success) {
    return { ...empty, notes: `schema mismatch: ${result.error.issues[0]?.message}` };
  }
  return result.data;
}
