// Mesero view of Salón — same data + same component as /operator/serve.
// Layout chrome differs (bottom nav vs top nav); the floor logic is
// identical. The default export comes from the operator page; we just
// re-declare `dynamic` here because Next.js's compile-time route-
// segment parser can't follow re-exports.
export { default } from "../../operator/serve/page";
export const dynamic = "force-dynamic";
