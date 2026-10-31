/**
 * Registro estático del contenido de la ayuda: los 33 archivos
 * `<idioma>/<categoria>.json`, importados uno por uno para que el bundler los
 * resuelva en el build (nada se lee del disco en tiempo de ejecución).
 *
 * Lo importan sólo el servidor (`src/lib/help/content.ts`) y los tests: el
 * contenido nunca viaja entero al navegador. En la etapa 2 nadie necesita
 * tocar este archivo: los JSON ya existen, sólo se llenan sus `articles`.
 */
import type { Locale } from "@/i18n/config";
import type { HelpCategoryId } from "./categories";
import type { HelpCategoryContent } from "./types";

import esPrimerosPasos from "./es/primeros-pasos.json";
import esSalonYPedidos from "./es/salon-y-pedidos.json";
import esCobroYCaja from "./es/cobro-y-caja.json";
import esAppDelMesero from "./es/app-del-mesero.json";
import esExperienciaDelComensal from "./es/experiencia-del-comensal.json";
import esCartaYProduccion from "./es/carta-y-produccion.json";
import esFacturacion from "./es/facturacion.json";
import esContabilidadYReportes from "./es/contabilidad-y-reportes.json";
import esEquipoYNomina from "./es/equipo-y-nomina.json";
import esPagosEnLinea from "./es/pagos-en-linea.json";
import esImpresionYEquipos from "./es/impresion-y-equipos.json";
import enPrimerosPasos from "./en/primeros-pasos.json";
import enSalonYPedidos from "./en/salon-y-pedidos.json";
import enCobroYCaja from "./en/cobro-y-caja.json";
import enAppDelMesero from "./en/app-del-mesero.json";
import enExperienciaDelComensal from "./en/experiencia-del-comensal.json";
import enCartaYProduccion from "./en/carta-y-produccion.json";
import enFacturacion from "./en/facturacion.json";
import enContabilidadYReportes from "./en/contabilidad-y-reportes.json";
import enEquipoYNomina from "./en/equipo-y-nomina.json";
import enPagosEnLinea from "./en/pagos-en-linea.json";
import enImpresionYEquipos from "./en/impresion-y-equipos.json";
import ptPrimerosPasos from "./pt/primeros-pasos.json";
import ptSalonYPedidos from "./pt/salon-y-pedidos.json";
import ptCobroYCaja from "./pt/cobro-y-caja.json";
import ptAppDelMesero from "./pt/app-del-mesero.json";
import ptExperienciaDelComensal from "./pt/experiencia-del-comensal.json";
import ptCartaYProduccion from "./pt/carta-y-produccion.json";
import ptFacturacion from "./pt/facturacion.json";
import ptContabilidadYReportes from "./pt/contabilidad-y-reportes.json";
import ptEquipoYNomina from "./pt/equipo-y-nomina.json";
import ptPagosEnLinea from "./pt/pagos-en-linea.json";
import ptImpresionYEquipos from "./pt/impresion-y-equipos.json";

/** Los JSON se validan en `help.test.ts`; acá sólo se les pone el tipo. */
const typed = (c: unknown) => c as HelpCategoryContent;

export const HELP_CONTENT: Record<Locale, Record<HelpCategoryId, HelpCategoryContent>> = {
  es: {
    "primeros-pasos": typed(esPrimerosPasos),
    "salon-y-pedidos": typed(esSalonYPedidos),
    "cobro-y-caja": typed(esCobroYCaja),
    "app-del-mesero": typed(esAppDelMesero),
    "experiencia-del-comensal": typed(esExperienciaDelComensal),
    "carta-y-produccion": typed(esCartaYProduccion),
    facturacion: typed(esFacturacion),
    "contabilidad-y-reportes": typed(esContabilidadYReportes),
    "equipo-y-nomina": typed(esEquipoYNomina),
    "pagos-en-linea": typed(esPagosEnLinea),
    "impresion-y-equipos": typed(esImpresionYEquipos),
  },
  en: {
    "primeros-pasos": typed(enPrimerosPasos),
    "salon-y-pedidos": typed(enSalonYPedidos),
    "cobro-y-caja": typed(enCobroYCaja),
    "app-del-mesero": typed(enAppDelMesero),
    "experiencia-del-comensal": typed(enExperienciaDelComensal),
    "carta-y-produccion": typed(enCartaYProduccion),
    facturacion: typed(enFacturacion),
    "contabilidad-y-reportes": typed(enContabilidadYReportes),
    "equipo-y-nomina": typed(enEquipoYNomina),
    "pagos-en-linea": typed(enPagosEnLinea),
    "impresion-y-equipos": typed(enImpresionYEquipos),
  },
  pt: {
    "primeros-pasos": typed(ptPrimerosPasos),
    "salon-y-pedidos": typed(ptSalonYPedidos),
    "cobro-y-caja": typed(ptCobroYCaja),
    "app-del-mesero": typed(ptAppDelMesero),
    "experiencia-del-comensal": typed(ptExperienciaDelComensal),
    "carta-y-produccion": typed(ptCartaYProduccion),
    facturacion: typed(ptFacturacion),
    "contabilidad-y-reportes": typed(ptContabilidadYReportes),
    "equipo-y-nomina": typed(ptEquipoYNomina),
    "pagos-en-linea": typed(ptPagosEnLinea),
    "impresion-y-equipos": typed(ptImpresionYEquipos),
  },
};
