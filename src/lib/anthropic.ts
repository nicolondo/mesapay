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

type Source =
  | { kind: "image"; data: Buffer; mimeType: string }
  | { kind: "pdf"; data: Buffer };

/**
 * Read a bank certification (PDF or image) and return structured fields.
 * The caller is responsible for storing the original file; this just
 * extracts the data so the operator can verify it in a form.
 */
export async function extractBankCertificate(
  source: Source,
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
