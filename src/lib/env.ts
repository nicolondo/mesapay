import { z } from "zod";

/**
 * Centralized env access. Reads process.env once on first import, validates
 * with zod, and exposes a typed `env` object. Throws at boot if anything
 * required is missing — fail fast instead of surprising us at request time.
 *
 * Add new vars here (not directly via process.env elsewhere) so we keep one
 * inventory of secrets and their shapes.
 */

const schema = z.object({
  // Core
  DATABASE_URL: z.string().url(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_PUBLIC_BASE_URL: z.string().url().optional(),
  APP_BASE_DOMAIN: z.string().optional(),
  UPLOAD_DIR: z.string().optional(),

  // Master encryption key for at-rest secrets (sub-merchant private keys
  // etc.). Hex-encoded 32 bytes = 64 hex chars. Generate with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  // Optional in dev/test; required as soon as we store an encrypted secret.
  MESAPAY_SECRET_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex chars (32 bytes)")
    .optional(),

  // Kushki — controls which provider implementation we use.
  // mock = in-process fakes, sandbox/production hit Kushki real APIs.
  KUSHKI_MODE: z.enum(["mock", "sandbox", "production"]).default("mock"),
  KUSHKI_PARTNER_API_KEY: z.string().optional(),
  KUSHKI_PARTNER_PRIVATE_KEY: z.string().optional(),
  KUSHKI_WEBHOOK_SECRET: z.string().optional(),
  // Credencial del Cloud Terminal API (datáfono físico vía cloud). Se
  // manda como header X-BP-AUTH. Sin esto el push al datáfono real no
  // funciona (mock no la necesita).
  KUSHKI_BP_AUTH: z.string().optional(),
  // Business code del comercio en el Cloud Terminal (lo emite Kushki).
  // Va en el cuerpo del push. Configurable desde el backend (.env del VPS).
  KUSHKI_BP_BUSINESS_CODE: z.string().optional(),
  // Override del host del Cloud Terminal. Default por modo
  // (prod → https://cloudt.kushkipagos.com). Útil si Kushki da otro host.
  KUSHKI_CLOUD_TERMINAL_URL: z.string().url().optional(),
  // Override de los paths del Cloud Terminal (usar {serial} como
  // placeholder). Permite ajustar el endpoint exacto sin redeploy una vez
  // confirmado el contrato. Defaults en cloudTerminal.ts.
  KUSHKI_CLOUD_TERMINAL_PATH: z.string().optional(),
  KUSHKI_CLOUD_TERMINAL_CANCEL_PATH: z.string().optional(),
  // Clave privada de la cuenta de plataforma para cobros de suscripción.
  // Requerida en sandbox/production; no necesaria en mode=mock.
  KUSHKI_BILLING_PRIVATE_KEY: z.string().optional(),
  // Clave PÚBLICA de la cuenta de plataforma para tokenizar en el browser.
  // Segura de exponer al cliente. Requerida en sandbox/production.
  KUSHKI_BILLING_PUBLIC_KEY: z.string().optional(),

  // Anthropic — bank-certification OCR.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-haiku-4-5"),

  // Cron auth — shared secret in `x-cron-secret` header for cron endpoints.
  CRON_SECRET: z.string().optional(),

  // Web Push (VAPID). Generated once with:
  //   node -e "const w=require('web-push');const k=w.generateVAPIDKeys();
  //     console.log('PUBLIC='+k.publicKey);console.log('PRIVATE='+k.privateKey)"
  // The public key is exposed to the browser (NEXT_PUBLIC_) so the
  // service worker can subscribe; the private key stays on the
  // server. VAPID_SUBJECT is a mailto: URL the push services use to
  // reach us about abuse / quota.
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:hola@mesapay.co"),
});

type EnvShape = z.infer<typeof schema>;

let cached: EnvShape | null = null;

function parseEnv(): EnvShape {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export const env = new Proxy({} as EnvShape, {
  get(_t, prop: string) {
    return parseEnv()[prop as keyof EnvShape];
  },
});

/**
 * Some operations (encrypting a new secret, calling Kushki production) have
 * hard prerequisites. Use these guards to fail with a clear message instead
 * of a cryptic "cipher init failed" error.
 */
export function requireSecretKey(): string {
  const v = env.MESAPAY_SECRET_KEY;
  if (!v) {
    throw new Error(
      "MESAPAY_SECRET_KEY is not set. Generate one with:\n" +
        "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n" +
        "and put it in /opt/mesapay/shared/.env.production",
    );
  }
  return v;
}

export function requireKushkiKey(): string {
  const v = env.KUSHKI_PARTNER_API_KEY;
  if (!v) {
    throw new Error(
      "KUSHKI_PARTNER_API_KEY is not set. KUSHKI_MODE=mock is fine for development;\n" +
        "set the key when switching to sandbox/production.",
    );
  }
  return v;
}

export function requireAnthropicKey(): string {
  const v = env.ANTHROPIC_API_KEY;
  if (!v) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to the env so OCR can run.",
    );
  }
  return v;
}
