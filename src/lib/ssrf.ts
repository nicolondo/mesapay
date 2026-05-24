import { lookup } from "dns/promises";

/**
 * Defensive guard against Server-Side Request Forgery. Used when the
 * server fetches a URL provided by an untrusted caller (e.g. "import
 * menu from this URL"). Without this an attacker could ask us to fetch
 * http://localhost:3300/admin/... or http://169.254.169.254/latest/meta-data
 * and leak internal data.
 *
 * Returns "ok" when the URL is safe to fetch, or an error string with a
 * short reason. Always resolve and check the IP — DNS rebinding attacks
 * use a public domain that points to a private IP.
 */

const PRIVATE_HOSTNAMES = new Set([
  "localhost",
  "0.0.0.0",
  "::",
  "::1",
]);

export type SsrfCheck =
  | { ok: true }
  | { ok: false; reason: string };

export async function checkUrlSafe(urlStr: string): Promise<SsrfCheck> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return { ok: false, reason: "URL inválida." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "Solo http(s)." };
  }
  const hostname = url.hostname.toLowerCase();
  if (PRIVATE_HOSTNAMES.has(hostname)) {
    return { ok: false, reason: "Hostname privado." };
  }
  // If the hostname is already an IP literal, check that directly.
  if (isIpLiteral(hostname)) {
    if (isPrivateIp(hostname)) {
      return { ok: false, reason: "IP privada." };
    }
    return { ok: true };
  }
  // Resolve and check the actual IP — protects against DNS rebinding.
  try {
    const { address } = await lookup(hostname);
    if (isPrivateIp(address)) {
      return { ok: false, reason: "Hostname apunta a IP privada." };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "No pudimos resolver el dominio." };
  }
}

function isIpLiteral(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
}

function isPrivateIp(ip: string): boolean {
  // IPv6 loopback / link-local
  if (ip === "::1") return true;
  if (ip.toLowerCase().startsWith("fe80:")) return true;
  if (ip.toLowerCase().startsWith("fc") || ip.toLowerCase().startsWith("fd")) {
    return true; // unique local addresses
  }
  // IPv4
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + AWS/GCP metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}
