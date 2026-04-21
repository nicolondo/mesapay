import { NextResponse, type NextRequest } from "next/server";

// Subdomain → tenant slug routing.
// - admin.mesapay.co             → platform admin UI (future; for now: 404 or landing)
// - <slug>.mesapay.co            → tenant storefront / operator UI
// - mesapay.co                   → marketing + signup
// - localhost with ?tenant=slug  → dev shortcut (no wildcard DNS required)
const PLATFORM_HOST = process.env.APP_BASE_DOMAIN ?? "mesapay.co";
const PLATFORM_HOSTS = new Set<string>([
  PLATFORM_HOST,
  "www." + PLATFORM_HOST,
  "localhost",
  "localhost:3000",
  "localhost:3300",
  "127.0.0.1",
  "127.0.0.1:3300",
]);

export function middleware(req: NextRequest) {
  const host = (req.headers.get("host") ?? "").toLowerCase();
  const url = req.nextUrl;

  // Dev helper: ?tenant=casa-teresita to override subdomain locally
  const devTenant = url.searchParams.get("tenant");
  if (devTenant) {
    const res = NextResponse.next();
    res.headers.set("x-tenant-slug", devTenant);
    return res;
  }

  if (PLATFORM_HOSTS.has(host)) {
    return NextResponse.next();
  }

  // Extract subdomain: slug.mesapay.co → "slug"
  const baseHost = PLATFORM_HOST.split(":")[0];
  const hostNoPort = host.split(":")[0];
  if (hostNoPort.endsWith("." + baseHost)) {
    const sub = hostNoPort.slice(0, -("." + baseHost).length);
    if (sub === "admin") {
      const res = NextResponse.rewrite(new URL("/admin" + url.pathname + url.search, req.url));
      return res;
    }
    const res = NextResponse.rewrite(new URL("/t/" + sub + url.pathname + url.search, req.url));
    res.headers.set("x-tenant-slug", sub);
    return res;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/|favicon.ico|api/auth|images/).*)"],
};
