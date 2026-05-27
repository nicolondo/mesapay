import { env, requireKushkiKey } from "../../env";
import type { ZodType } from "zod";

/**
 * Low-level HTTP wrapper for the Kushki Partner REST API.
 *
 * Only used when KUSHKI_MODE is "sandbox" or "production". The mock provider
 * never touches this — it's pure in-process fakes (see ./mock.ts).
 *
 * The exact base URLs and authentication scheme will be tightened once we
 * receive partner credentials. The shape here matches Kushki's documented
 * REST API (https://api-docs.kushkipagos.com/) with the `Private-Merchant-Id`
 * header pattern.
 */

const BASE_URL = {
  sandbox: "https://api-uat.kushkipagos.com",
  production: "https://api.kushkipagos.com",
} as const;

function baseUrl(): string {
  if (env.KUSHKI_MODE === "mock") {
    throw new Error("kushkiFetch must not be called in mock mode");
  }
  return BASE_URL[env.KUSHKI_MODE];
}

export class KushkiHttpError extends Error {
  constructor(
    public status: number,
    public body: string,
    public url: string,
  ) {
    super(`kushki ${status} on ${url}: ${body.slice(0, 200)}`);
  }
}

type FetchOpts = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  // Auth schemes que Kushki acepta:
  //   - partner: header Private-Merchant-Id con la master key del partner
  //   - submerchant: header Private-Merchant-Id con la private key del local
  //     (uso típico: charges, push a datáfono, wallet, dispersiones)
  //   - submerchant_public: header Public-Merchant-Id con la public key del
  //     local (uso: endpoints de TOKENIZACIÓN — transfer/v1/tokens para PSE,
  //     card/v1/tokens para tarjetas, etc. Kushki separa porque el browser
  //     SDK puede invocarlos sin exponer la private key.)
  auth:
    | { kind: "partner" }
    | { kind: "submerchant"; privateKey: string }
    | { kind: "submerchant_public"; publicKey: string };
  /** When provided, response is validated through this zod schema. */
  schema?: ZodType<unknown>;
  retries?: number;
};

export async function kushkiFetch<T>(
  path: string,
  opts: FetchOpts,
): Promise<T> {
  const url = baseUrl() + path;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.auth.kind === "partner") {
    headers["Private-Merchant-Id"] = requireKushkiKey();
  } else if (opts.auth.kind === "submerchant") {
    headers["Private-Merchant-Id"] = opts.auth.privateKey;
  } else {
    headers["Public-Merchant-Id"] = opts.auth.publicKey;
  }

  const init: RequestInit = {
    method: opts.method ?? "POST",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  };

  const maxAttempts = (opts.retries ?? 2) + 1;
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, init);
      const text = await res.text();
      if (!res.ok) {
        // Retry transient 5xx; surface 4xx immediately.
        if (res.status >= 500 && attempt < maxAttempts) {
          await sleep(250 * 2 ** (attempt - 1));
          continue;
        }
        throw new KushkiHttpError(res.status, text, url);
      }
      const parsed: unknown = text ? JSON.parse(text) : {};
      if (opts.schema) {
        const result = opts.schema.safeParse(parsed);
        if (!result.success) {
          throw new Error(
            `kushki ${url} response did not match schema: ${result.error.issues[0]?.message}`,
          );
        }
        return result.data as T;
      }
      return parsed as T;
    } catch (err) {
      lastErr = err;
      if (err instanceof KushkiHttpError && err.status < 500) throw err;
      if (attempt === maxAttempts) throw err;
      await sleep(250 * 2 ** (attempt - 1));
    }
  }
  throw lastErr ?? new Error("kushki request failed");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
