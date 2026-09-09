import { lookup } from "node:dns/promises";
import { isIP, BlockList } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable, Transform, pipeline } from "node:stream";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";

const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [ip, prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const) blockedV4.addSubnet(ip, prefix, "ipv4");
for (const [ip, prefix] of [["::",128],["::1",128],["::ffff:0:0",96],["64:ff9b::",96],["64:ff9b:1::",48],["100::",64],["2001::",32],["2001:db8::",32],["2002::",16],["fc00::",7],["fe80::",10],["ff00::",8]] as const) blockedV6.addSubnet(ip,prefix,"ipv6");

export function isPublicIp(value: string): boolean {
  const ip = value.replace(/^\[|\]$/g, "");
  const family = isIP(ip);
  return !!family && !(family === 4 ? blockedV4 : blockedV6).check(ip, family === 4 ? "ipv4" : "ipv6");
}

async function resolvePublicUrl(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("unsafe_url");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(a => !isPublicIp(a.address))) throw new Error("private_address");
  return { url, addresses };
}

export type SsrfCheck = { ok: true } | { ok: false; reason: string };
export async function checkUrlSafe(value: string): Promise<SsrfCheck> {
  try { await resolvePublicUrl(value); return { ok: true }; }
  catch { return { ok: false, reason: "unsafe_url" }; }
}

/** Each hop is validated BEFORE connecting; DNS is pinned to validated addresses. */
export async function fetchPublicUrl(value: string, init: RequestInit = {}): Promise<Response> {
  if (init.method && init.method !== "GET") throw new Error("unsupported_method");
  let current = value;
  const deadline = AbortSignal.timeout(30_000);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  for (let hop = 0; hop <= 5; hop++) {
    const { url, addresses } = await resolvePublicUrl(current);
    signal.throwIfAborted();
    const headers = Object.fromEntries(new Headers(init.headers));
    // Never forward credentials from callers to imported sites or redirects.
    delete headers.authorization; delete headers.cookie; delete headers.host;
    headers["accept-encoding"] = "identity";
    const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        headers, signal,
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        },
      }, resolve);
      request.on("error", reject);
      request.end();
    });
    if ([301,302,303,307,308].includes(response.statusCode ?? 0) && response.headers.location) {
      response.destroy();
      current = new URL(response.headers.location, url).href;
      continue;
    }
    const outHeaders = new Headers();
    for (const [key, val] of Object.entries(response.headers)) {
      if (val != null && !["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key)) outHeaders.set(key, Array.isArray(val) ? val.join(", ") : val);
    }
    const encoding = response.headers["content-encoding"];
    let received = 0;
    const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      callback(received > 20 * 1024 * 1024 ? new Error("response_too_large") : null, chunk);
    } });
    const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : null;
    // pipeline forwards source/decompression errors and cancels upstream on abort.
    if (decoder) pipeline(response, decoder, bounded, () => {});
    else pipeline(response, bounded, () => {});
    const status = response.statusCode ?? 502;
    const noBody = [204, 304].includes(status);
    if (noBody) bounded.destroy();
    const result = new Response(noBody ? null : Readable.toWeb(bounded) as ReadableStream<Uint8Array>, { status, headers: outHeaders });
    Object.defineProperty(result, "url", { value: url.href });
    return result;
  }
  throw new Error("too_many_redirects");
}
