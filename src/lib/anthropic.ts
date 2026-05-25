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
function getClient(): Anthropic {
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
      "sortOrder": 0                      // 0..N en el orden que aparecen
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
