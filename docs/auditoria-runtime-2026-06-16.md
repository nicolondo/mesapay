# Auditoría de errores del sistema — MESAPAY (2026-06-16)

Análisis de errores con **Playwright** (crawl de runtime en producción) + análisis
estático (tests, lint, typecheck, build). Hecho de forma autónoma.

## Resumen ejecutivo

**El sistema está sano en runtime. 0 errores críticos.** El crawl recorrió 73
rutas × 2 viewports (móvil + escritorio) en `https://mesapay.co` y no encontró
ningún 500, ninguna excepción JS sin capturar, ningún "Application error", y
ninguna pantalla rota. Todas las rutas autenticadas redirigen correctamente a
`/signin` (la barrera de auth funciona) y los menús públicos de comensal cargan
bien.

**Único hallazgo real:** un *warning* (no un error) de Google Maps en
`/signup/restaurant`. No rompe nada.

**Limitación importante:** no se pudo probar la superficie **autenticada**
(operator / admin / group / comercial / mesero / terminal) porque requiere login
y base de datos, y `.env.local` apunta a la **DB de producción** — entrar ahí o
escribir datos sin supervisión es inseguro. Ahí es donde más probablemente se
escondan bugs reales. Ver "Próximo paso #1".

---

## Metodología

| Capa | Herramienta | Cobertura |
|------|-------------|-----------|
| Runtime (lo que ve el usuario) | Playwright crawl `e2e/crawl.mjs` | 73 rutas, móvil+escritorio, solo-GET, sin login ni formularios |
| Unit | `vitest` (240 tests) | lógica pura (crm, ai-tools, comisiones, formato…) |
| Estático | `eslint`, `tsc`, `next build` | todo el código de `src/` (incl. páginas autenticadas) |

El crawl es **read-only**: solo navega (GET), nunca envía formularios ni inicia
sesión. Seguro contra producción. Reproducible con `npm run crawl`.

---

## 1. Crawl de runtime (producción)

**0 CRITICAL · 36 WARNING.** De los 36 warnings, **32 son 404 esperados** de mis
sondas deliberadas de rutas inexistentes (`/t/__no_such_slug__`,
`/this-route-does-not-exist`, slugs falsos) — comportamiento **correcto** (404,
no 500). Los 4 restantes son el mismo par de warnings en una sola página:

### 🟡 `/signup/restaurant` — Google Maps (advisory, no rompe)
Dos warnings de la API de Google Maps al cargar el autocompletado de dirección:
1. *"Google Maps JavaScript API has been loaded directly without `loading=async`"* — best-practice de performance.
2. *"`google.maps.places.Autocomplete` is not available to new customers… use `PlaceAutocompleteElement`"* — la API está **deprecada para clientes nuevos** de Google Cloud, pero **sigue funcionando** y "no está programada para discontinuarse".

**Impacto:** ninguno funcional hoy — el autocompletado funciona. Es deuda técnica.
**Archivo:** `src/components/AddressAutocomplete.tsx` (carga el script en ~L157).
**Por qué no lo arreglé de una:** cambiar el loader a `loading=async` obliga a
migrar a `google.maps.importLibrary("places")`; hacerlo mal rompe el campo de
dirección del **formulario de registro** (superficie de conversión). Necesita
prueba interactiva, mejor con vos despierto. Recomendación en la sección final.

### ✅ Lo que SÍ se validó como sano
- Landing `/`, `/signin`, `/signup`, `/signup/restaurant`, `/nicolas` → 200, sin errores.
- Menú de comensal real: `/t/chefburger` y `/t/casa-teresita` → **200, sin un solo warning**.
- Slugs inexistentes → **404 limpio** (no 500).
- Las **~55 rutas autenticadas** (operator/admin/group/comercial/mesero/terminal/bar/cocina) → **todas redirigen a `/signin`** sin error. Esto confirma, entre otras cosas, que el cambio reciente del *app-shell* del panel de operador **no rompió la barrera de auth**.

---

## 2. Análisis estático

- **Unit tests:** `vitest` → **240/240 pasan** (28 archivos).
- **TypeScript:** `tsc --noEmit` → **limpio**.
- **Build:** `next build` → **compila OK**.
- **ESLint:** estaba en 239 problemas, pero **~150 eran del directorio `reference/`** (un bundle de prototipo de Claude Design, NO importado por la app, NO se despliega). Lo excluí del lint (junto con `e2e/`), dejando **76 problemas reales**, todos de baja severidad y ninguno user-facing:
  - 20 `react-hooks/set-state-in-effect` — advisories de performance de React (mayormente `setState` de init en effects; benignos).
  - 13 `@typescript-eslint/no-explicit-any` — strictness (en tooling de IA y tests).
  - 11 `@typescript-eslint/no-unused-vars` — limpieza.
  - 11 `react-hooks/purity` — **mayormente falsos positivos**: `new Date()` en *server components* (se renderiza una vez en el server, no hay hydration). Solo 2 son reales y menores → ver abajo.
  - 5 directivas `eslint-disable` obsoletas — limpieza.
  - 5 `@next/next/no-img-element` + 1 `no-page-custom-font` — best-practice.
  - 4 `react-hooks/refs` — patrón intencional "latest-value ref" (`ref.current = value` en render); inofensivo.

### 🟡 Nits reales de hidratación (baja prioridad)
`Date.now()` llamado **durante el render** en dos *client components*, lo que puede
causar un pequeño desajuste SSR/CSR (un número de "minutos" o un "hoy" que se
autocorrige al hidratar):
- `src/app/operator/tables/MesasGrid.tsx:326` — "minutos desde que se pagó".
- `src/app/operator/reservas/ReservasBoard.tsx:122` — cálculo de "hoy" (Bogotá).

No rompen nada; se podrían envolver en `useState`/`useEffect` para limpiar el warning.

---

## 3. Lo que NO se pudo auditar (gap real)

La superficie **autenticada** — que es la más compleja y donde más probablemente
haya bugs (incluido el reciente refactor del *app-shell* de operador):

- `/operator/*` (carta, cocina, bar, salón, pagos, settings, wallet, reportes…)
- `/admin/*`, `/group/*`, `/comercial/*`
- `/mesero/*`, `/terminal`
- Flujos dinámicos: pago de comensal `/t/[slug]/pay/[orderId]`, factura `/factura/[id]`, reserva `/r/[slug]/reserva/[code]`.

No se probaron porque requieren login + DB, y el único `DATABASE_URL` disponible
en este equipo apunta a **producción** (`.env.local` → `187.124.91.12`). Entrar o
escribir datos en prod sin supervisión no es seguro.

---

## Recomendaciones priorizadas

1. **Montar entorno local para E2E autenticado** (alto valor). Levantar una DB
   local (Docker o Postgres en `:5433` como dice `.env`), `npm run db:seed`
   (cuentas con password `mesapay123`) y correr el smoke autenticado ya escrito:
   `PLAYWRIGHT_BASE_URL=http://localhost:3300 npx playwright test operator-smoke`.
   Ese spec recorre 12 páginas de operador y verifica que el header quede fijo al
   scrollear (guard del fix de iOS). Con esto cubrimos la mitad del sistema que
   hoy es ciega.
2. **Migrar Google Maps** en `AddressAutocomplete.tsx`: `loading=async` +
   `importLibrary("places")` y eventualmente `PlaceAutocompleteElement`. Con
   prueba del campo de dirección en `/signup/restaurant`.
3. **Nits de hidratación** en `MesasGrid` y `ReservasBoard` (mover `Date.now()`
   fuera del render).
4. Considerar **borrar `reference/`** del repo si ya no se usa (es el prototipo
   de diseño); de momento queda excluido del lint.

## Cómo re-ejecutar

```bash
npm run crawl                          # crawl read-only de https://mesapay.co
npm run crawl -- http://localhost:3300 # contra un local
```
Reporte → `e2e/reports/crawl-<stamp>.md` (gitignored). Ver `e2e/README.md`.
