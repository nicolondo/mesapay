/**
 * Mapa de cobertura: cada pantalla (`page.tsx`) de las superficies que usan
 * los comercios, su equipo y sus comensales → los artículos que la explican.
 *
 * Carpetas cubiertas: src/app/operator, src/app/mesero, src/app/t/[slug],
 * src/app/r, src/app/p y src/app/terminal. La clave es la ruta tal como la
 * arma Next a partir de la carpeta ("/operator/orders/[id]").
 *
 * Una pantalla sin artículo propio (vista de impresión, redirección, retorno
 * técnico de un banco) se marca `{ internal: "motivo" }`.
 *
 * El test `help.test.ts` exige que TODA página de esas carpetas esté acá:
 * una pantalla nueva sin ayuda rompe la CI hasta que alguien la mapee a un
 * artículo (o explique por qué no lo necesita). Y que todo slug exista en el
 * outline.
 */
export type HelpCoverage = readonly string[] | { readonly internal: string };

export const HELP_COVERAGE: Record<string, HelpCoverage> = {
  /* ── Panel del restaurante: inicio y configuración general ── */
  "/operator": ["conocer-el-panel", "la-caja"],
  "/operator/settings": ["por-donde-empezar"],
  "/operator/settings/identidad": ["identidad-del-comercio"],
  "/operator/settings/usuarios": ["usuarios-y-roles"],
  "/operator/settings/meseros": ["mesas-por-mesero", "comisiones-de-meseros"],
  "/operator/settings/staff-policies": ["permisos-propinas-y-turnos"],
  "/operator/settings/suscripcion": ["suscripcion"],
  "/operator/ayuda": { internal: "Es el propio centro de ayuda." },
  "/operator/ayuda/[categoria]": { internal: "Es el propio centro de ayuda." },
  "/operator/ayuda/[categoria]/[slug]": { internal: "Es el propio centro de ayuda." },

  /* ── Salón y pedidos ── */
  "/operator/tables": [
    "tomar-un-pedido-desde-mesas",
    "la-pantalla-mesas",
    "crear-mesas-e-imprimir-qr",
    "corregir-un-pedido",
    "cobrar-una-cuenta",
    "pagos-pendientes-del-comensal",
    "imprimir-la-precuenta",
    "factura-manual",
  ],
  "/operator/tables/print": ["crear-mesas-e-imprimir-qr"],
  "/operator/kitchen": ["tablero-de-cocina-y-bar", "tablet-de-cocina-y-bar"],
  "/operator/bar": ["tablero-de-cocina-y-bar", "tablet-de-cocina-y-bar"],
  "/operator/serve": [
    "salon-entregar-platos-y-llamadas",
    "cobrar-en-efectivo",
    "cobrar-con-datafono",
    "pagos-pendientes-del-comensal",
  ],
  "/operator/orders": ["buscar-y-revisar-ordenes", "imprimir-y-enviar-facturas"],
  "/operator/orders/[id]": [
    "buscar-y-revisar-ordenes",
    "cobrar-una-cuenta",
    "cobros-reembolsos-y-conciliacion",
  ],
  "/operator/orders/[id]/precuenta": ["imprimir-la-precuenta"],
  "/operator/reservas": ["reservas"],
  "/operator/settings/reservas": ["reservas"],
  "/operator/settings/mesas": ["reservas"],
  "/operator/settings/salon": ["reservas"],
  "/operator/settings/estaciones": ["estaciones-de-preparacion", "como-imprimir-las-comandas"],
  "/operator/settings/etiquetas": ["etiquetas-de-platos"],
  "/operator/print/[station]": ["como-imprimir-las-comandas"],

  /* ── Cobro y caja ── */
  "/operator/payments": ["cobros-reembolsos-y-conciliacion"],
  "/operator/reports": ["abrir-y-cerrar-el-turno", "la-caja"],
  "/operator/reports/ventas": ["analizar-las-ventas"],
  "/operator/reports/no-cobrados": ["cortesias-y-productos-no-cobrados"],
  "/operator/reports/gastos-representacion": ["cortesias-y-productos-no-cobrados"],
  "/operator/shifts": ["abrir-y-cerrar-el-turno"],
  "/operator/shifts/[id]": ["abrir-y-cerrar-el-turno"],
  "/operator/clientes": ["clientes-de-facturacion", "cobrar-a-credito", "descuentos-para-clientes"],
  "/operator/clientes/[id]": ["descuentos-para-clientes"],
  "/terminal": ["cobrar-con-datafono", "datafonos"],

  /* ── App del mesero ── */
  "/mesero": { internal: "Solo redirige a Salón." },
  "/mesero/mesas": ["mesas-y-ficha-en-la-app", "por-que-no-puedo-cobrar-o-mover"],
  "/mesero/salon": ["salon-en-la-app", "entrar-e-instalar-la-app"],
  "/mesero/pedir/[tableId]": ["pedir-desde-la-app"],
  "/mesero/cobrar/[orderId]": [
    "cobrar-desde-la-app",
    "dividir-la-cuenta",
    "por-que-no-puedo-cobrar-o-mover",
  ],
  "/mesero/cobrar/[orderId]/done": ["cobrar-desde-la-app"],
  "/mesero/cobros": {
    internal:
      "La lista de cobros del panel filtrada a la sección del mesero; no tiene pestaña ni enlace dentro de la app.",
  },
  "/mesero/precuenta/[id]": ["mesas-y-ficha-en-la-app"],
  "/mesero/yo": ["mis-mesas", "turno-del-mesero"],
  "/mesero/ayuda": { internal: "Es el propio centro de ayuda (versión del mesero)." },
  "/mesero/ayuda/[categoria]/[slug]": {
    internal: "Es el propio centro de ayuda (versión del mesero).",
  },

  /* ── Lo que ve el comensal ── */
  "/t/[slug]": ["el-qr-de-la-mesa"],
  "/t/[slug]/menu": ["el-qr-de-la-mesa", "la-carta-del-comensal", "como-pide-el-comensal"],
  "/t/[slug]/order/[orderId]": ["como-pide-el-comensal", "resenas-de-platos"],
  // La misma pantalla de cobro la usa el equipo desde "Cobrar la cuenta".
  "/t/[slug]/pay/[orderId]": [
    "como-paga-el-comensal",
    "factura-del-comensal",
    "cobrar-una-cuenta",
    "dividir-la-cuenta",
    "cobrar-a-credito",
  ],
  "/t/[slug]/pay/[orderId]/cash": ["como-paga-el-comensal"],
  "/t/[slug]/pay/[orderId]/terminal": ["como-paga-el-comensal"],
  "/t/[slug]/pay/[orderId]/pending": ["como-paga-el-comensal"],
  "/t/[slug]/pay/[orderId]/done": ["como-paga-el-comensal", "factura-del-comensal"],
  "/t/[slug]/pay/[orderId]/3ds-return": {
    internal: "Retorno técnico de la verificación del banco: resuelve el pago y redirige.",
  },
  "/t/[slug]/pay/[orderId]/pse-return": {
    internal: "Retorno técnico de PSE: resuelve el pago y redirige.",
  },
  "/t/[slug]/cuenta": ["cuenta-del-comensal"],
  "/t/[slug]/cuenta/entrar": ["cuenta-del-comensal"],
  "/t/[slug]/cuenta/registro": ["cuenta-del-comensal"],
  "/t/[slug]/cuenta/enlace/[token]": ["cuenta-del-comensal"],
  "/r/[slug]": ["reservas-del-comensal"],
  "/r/[slug]/reserva/[code]": ["reservas-del-comensal"],
  "/r/[slug]/reserva/[code]/deposit-return": {
    internal: "Retorno técnico de PSE del depósito de una reserva: redirige.",
  },
  "/r/[slug]/pago/[token]": ["links-de-pago"],
  "/r/[slug]/pago/[token]/return": {
    internal: "Retorno técnico de PSE de un link de pago: redirige.",
  },
  "/p/[slug]": ["pedidos-para-llevar"],
  "/p/[slug]/[orderId]/status": ["pedidos-para-llevar"],
  "/operator/ratings": ["resenas-de-platos"],

  /* ── Carta y producción ── */
  "/operator/menu": [
    "crear-la-carta",
    "organizar-la-carta",
    "modificadores",
    "agotar-archivar-o-eliminar-un-plato",
  ],
  "/operator/menu/import": ["importar-la-carta"],
  "/operator/menus": ["organizar-la-carta"],
  "/operator/settings/traducciones": ["traducir-la-carta"],
  "/operator/settings/insumos": ["insumos-y-proveedores"],
  "/operator/settings/proveedores": ["insumos-y-proveedores"],
  "/operator/recetas": ["recetas-y-food-cost", "sub-recetas-y-produccion"],
  "/operator/produccion": ["sub-recetas-y-produccion"],
  "/operator/inventario": ["inventario-del-dia-a-dia", "conteo-de-inventario"],
  "/operator/compras": ["ordenes-de-compra", "cargar-facturas-de-compra"],

  /* ── Facturación ── */
  "/operator/settings/impuestos": ["impuesto-de-ventas"],
  "/operator/settings/facturacion-dian": [
    "resolucion-de-facturacion",
    "activar-la-facturacion-electronica",
  ],
  "/operator/facturas": ["solicitudes-de-factura", "emision-automatica-de-facturas"],
  "/operator/facturas/notas-credito": ["notas-credito"],

  /* ── Contabilidad y reportes ── */
  "/operator/contabilidad": [
    "como-funciona-la-contabilidad",
    "registrar-gastos",
    "pyg-y-libros-del-mes",
    "plan-de-cuentas",
    "cerrar-el-mes-contable",
    "conciliacion-bancaria",
    "activos-fijos-y-diferidos",
    "presupuestos-y-centros-de-costos",
    "impuestos-y-retenciones",
  ],
  "/operator/contabilidad/cierre": ["cerrar-el-mes-contable"],
  "/operator/contabilidad/comprobantes": ["comprobantes-contables"],
  "/operator/contabilidad/comprobantes/nuevo": ["comprobantes-contables"],
  "/operator/contabilidad/comprobantes/[id]": ["comprobantes-contables"],
  "/operator/contabilidad/comprobantes/[id]/editar": ["comprobantes-contables"],
  "/operator/contabilidad/diferidos": ["activos-fijos-y-diferidos"],
  "/operator/contabilidad/diferidos/[id]": ["activos-fijos-y-diferidos"],
  "/operator/reportes": ["como-funciona-la-contabilidad"],
  "/operator/reportes/libro-diario": ["libros-y-estados-financieros"],
  "/operator/reportes/libro-mayor": ["libros-y-estados-financieros"],
  "/operator/reportes/balance-prueba": ["libros-y-estados-financieros"],
  "/operator/reportes/estado-resultado": ["libros-y-estados-financieros"],
  "/operator/reportes/estado-situacion": ["libros-y-estados-financieros"],
  "/operator/reportes/impuestos": ["impuestos-y-retenciones"],
  "/operator/reportes/impuestos-detallados": ["impuestos-y-retenciones"],
  "/operator/reportes/exogena": ["informacion-exogena"],
  "/operator/reportes/cartera": ["cartera"],
  "/operator/reportes/cartera/[kind]/[partnerId]": ["cartera"],
  "/operator/reportes/comisiones": ["reporte-de-comisiones"],
  "/operator/insights": ["pulso"],

  /* ── Equipo y nómina ── */
  "/operator/horarios": ["crear-el-equipo", "turnos-y-asistencia"],
  "/operator/horarios/kiosko": ["kiosko-de-asistencia"],
  "/operator/nomina": ["liquidar-la-nomina"],

  /* ── Pagos en línea ── */
  "/operator/settings/pagos": ["activar-pagos-en-linea", "medios-de-pago-en-linea"],
  "/operator/wallet": ["wallet-y-transferencias"],
  "/operator/settings/bonos": ["bonos-empresariales"],
  "/operator/bonos": ["bonos-empresariales"],
  "/operator/bonos/[id]": ["bonos-empresariales", "links-de-pago"],
  "/operator/bonos/reporte": ["corte-de-bonos"],

  /* ── Impresión y equipos ── */
  "/operator/settings/impresoras": [
    "instalar-el-agente-de-impresion",
    "impresoras-de-red",
    "cuando-no-imprime",
  ],
  "/operator/settings/datafonos": ["datafonos"],
  "/operator/settings/backups": ["copias-de-seguridad"],
};
