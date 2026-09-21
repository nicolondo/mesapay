// Catálogo del hub «Todos los reportes» (/operator/reportes): TODO lo que el
// comercio puede consultar, por categoría, como dato puro. Cada entrada lleva
// el namespace y las claves i18n de su nombre y su línea de detalle — la
// página traduce. El test verifica que las rutas existan como páginas, que
// las pestañas pedidas por `?tab=` sean reales y que las claves estén en los
// tres catálogos.
import { contabilidadTabHref } from "@/lib/erp/contabilidadTabs";

/** Namespaces con textos del hub (comerciales reusan los de su reporte). */
export type ReportNs = "opReportes" | "opCartera" | "opComisiones";

export type ReportCatalogItem = {
  href: string;
  ns: ReportNs;
  nameKey: string;
  descKey: string;
};

export type ReportCatalogCategory = {
  key: "contables" | "financieros" | "tributarios" | "comerciales" | "operativos";
  ns: ReportNs;
  labelKey: string;
  items: ReportCatalogItem[];
};

const rep = (href: string, name: string, desc: string): ReportCatalogItem => ({
  href,
  ns: "opReportes",
  nameKey: name,
  descKey: desc,
});

export const REPORT_CATALOG: readonly ReportCatalogCategory[] = [
  {
    key: "contables",
    ns: "opReportes",
    labelKey: "catContables",
    items: [
      rep("/operator/reportes/libro-diario", "rDiario", "rDiarioDesc"),
      rep("/operator/reportes/libro-mayor", "rMayor", "rMayorDesc"),
      rep("/operator/reportes/balance-prueba", "rBalance", "rBalanceDesc"),
      rep("/operator/contabilidad/comprobantes", "rComprobantes", "rComprobantesDesc"),
    ],
  },
  {
    key: "financieros",
    ns: "opReportes",
    labelKey: "catFinancieros",
    items: [
      rep("/operator/reportes/estado-situacion", "rEsf", "rEsfDesc"),
      rep("/operator/reportes/estado-resultado", "rEr", "rErDesc"),
    ],
  },
  {
    key: "tributarios",
    ns: "opReportes",
    labelKey: "catTributarios",
    items: [
      rep("/operator/reportes/impuestos", "rImpuestos", "rImpuestosDesc"),
      rep(
        "/operator/reportes/impuestos-detallados",
        "rImpuestosDetallados",
        "rImpuestosDetalladosDesc",
      ),
      rep("/operator/reportes/exogena", "rExogena", "rExogenaDesc"),
    ],
  },
  {
    key: "comerciales",
    ns: "opReportes",
    labelKey: "catComerciales",
    items: [
      { href: "/operator/reportes/cartera", ns: "opCartera", nameKey: "hubName", descKey: "hubDesc" },
      {
        href: "/operator/reportes/comisiones",
        ns: "opComisiones",
        nameKey: "hubName",
        descKey: "hubDesc",
      },
    ],
  },
  {
    // Lo operativo no sale del libro contable: cierre de turno y las
    // pestañas de la página de contabilidad que se arman desde la operación.
    key: "operativos",
    ns: "opReportes",
    labelKey: "catOperativos",
    items: [
      rep("/operator/reports", "rShiftClose", "rShiftCloseDesc"),
      rep(contabilidadTabHref("pnl"), "rPnl", "rPnlDesc"),
      rep(contabilidadTabHref("books"), "rBooks", "rBooksDesc"),
    ],
  },
];
