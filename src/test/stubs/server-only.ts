// Stub de `server-only` para vitest.
//
// `server-only` es un paquete-centinela de Next.js: en el build de la app
// se resuelve a un módulo vacío en el servidor y a uno que LANZA en el
// cliente. En vitest no existe (no está en node_modules), así que cualquier
// módulo que lo importe —`src/lib/kds/autoFireTickets.ts`, por ejemplo—
// rompe el test que lo cargue, directa o transitivamente.
//
// Los tests unitarios lo venían resolviendo con `vi.mock("server-only")`
// archivo por archivo. Eso no alcanza para la suite de integración, que
// carga rutas enteras y no puede saber de antemano qué módulo `server-only`
// va a aparecer por el camino: fue lo que dejó CI en rojo desde #440.
//
// Con el alias en las dos configs, importar `server-only` bajo vitest
// resuelve acá y no hace nada — que es exactamente lo que hace en el
// servidor de verdad.
export {};
