/**
 * Origen público (esquema + host) con el que el navegador ve a MESAPAY.
 *
 * Nunca se deriva de `req.url`: en producción `next start` corre detrás de
 * nginx y arma `req.url` con su host interno. Una redirección construida con
 * `new URL(path, req.url)` salía como `https://localhost:3301/...`, y lo
 * mismo pasaba con los links de los correos y los callbacks de pago.
 *
 * El host público llega en los headers:
 *   - nginx manda `Host $host` y `X-Forwarded-Proto $scheme`, pero NO manda
 *     `X-Forwarded-Host`;
 *   - Next copia `Host` a `x-forwarded-host` y completa `x-forwarded-proto`
 *     cuando no vienen (`base-server`), así que en la práctica están los dos.
 *
 * Para redirigir no hace falta nada de esto: `redirectTo` (./redirect.ts)
 * manda un `Location` relativo que el navegador resuelve contra la URL
 * pública. Este módulo es para las URLs ABSOLUTAS: correos, QR impresos,
 * callbacks que un tercero (Kushki, el banco) usa para volver.
 */

/** Lo que se puede leer como headers: un `Request` o un `Headers` (p. ej. `await headers()`). */
export type HeaderSource = Request | Pick<Headers, "get">;

/** `host[:puerto]` o `[ipv6][:puerto]`. Descarta basura en un header manipulado. */
const HOST_RE = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

const DEFAULT_ORIGIN = "https://mesapay.co";

function headersOf(source: HeaderSource): Pick<Headers, "get"> {
  return "headers" in source ? source.headers : source;
}

/** Primer valor de un header que puede venir como lista (`a, b`) tras varios proxies. */
function firstValue(headers: Pick<Headers, "get">, name: string): string | null {
  const first = headers.get(name)?.split(",")[0]?.trim();
  return first ? first : null;
}

function isLocalHost(host: string): boolean {
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return name === "localhost" || name.endsWith(".localhost") || name === "127.0.0.1" || name === "[::1]";
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Origen configurado, sin request: APP_PUBLIC_BASE_URL → NEXTAUTH_URL → mesapay.co. */
function configuredOrigin(): string {
  const fromEnv = process.env.APP_PUBLIC_BASE_URL || process.env.NEXTAUTH_URL;
  return fromEnv ? trimSlash(fromEnv) : DEFAULT_ORIGIN;
}

/**
 * Origen público del request según los headers del proxy.
 * `x-forwarded-host` → `host`; esquema de `x-forwarded-proto`, y si no
 * viene, `http` para localhost y `https` para todo lo demás. Sin ningún
 * host válido cae al origen configurado; jamás a `req.url`.
 */
export function publicOrigin(source: HeaderSource): string {
  const headers = headersOf(source);
  const host = [firstValue(headers, "x-forwarded-host"), firstValue(headers, "host")].find(
    (value): value is string => value !== null && HOST_RE.test(value),
  );
  if (!host) return configuredOrigin();
  const proto = firstValue(headers, "x-forwarded-proto")?.toLowerCase();
  const scheme = proto === "http" || proto === "https" ? proto : isLocalHost(host) ? "http" : "https";
  return `${scheme}://${host.toLowerCase()}`;
}

let warnedMissingBase = false;

/**
 * Origen canónico para URLs que salen del request (correos, QR, callbacks
 * de pago): APP_PUBLIC_BASE_URL manda; si no está, el origen público del
 * request; sin request, NEXTAUTH_URL o mesapay.co.
 */
export function appOrigin(source?: HeaderSource | null): string {
  const fromEnv = process.env.APP_PUBLIC_BASE_URL;
  if (fromEnv) return trimSlash(fromEnv);
  if (process.env.NODE_ENV === "production" && !warnedMissingBase) {
    warnedMissingBase = true;
    console.error("public_origin_env_missing", { detail: "APP_PUBLIC_BASE_URL no está definida; las URLs públicas se derivan de los headers del request o de NEXTAUTH_URL" });
  }
  return source ? publicOrigin(source) : configuredOrigin();
}
