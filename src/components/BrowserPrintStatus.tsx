"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import type { BrowserPrintOutcome } from "@/lib/printInBrowser";

/** La pantalla de Configuración donde se elige la impresora de facturas. */
export const PRINTER_SETTINGS_HREF = "/operator/settings/impresoras";

/**
 * Estado del respaldo "imprimir desde el navegador" (cuando el local no
 * tiene impresora de facturas), tal como se le cuenta al que apretó el
 * botón: preparando (el iframe oculto está cargando el documento), enviada
 * (ya salió el diálogo de impresión), pestaña (el navegador no dejó
 * imprimir embebido y el documento se abrió aparte, como antes; `href`
 * queda cuando además bloqueó esa pestaña) o error (no cargó: 404, sesión
 * vencida…; `href` para abrirlo a mano).
 */
export type BrowserPrintState =
  | { step: "preparing" }
  | { step: "sent" }
  | { step: "tab"; href: string | null }
  | { step: "error"; href: string };

/** Traduce el resultado del helper al estado que se muestra. */
export function browserPrintStateFrom(
  outcome: BrowserPrintOutcome,
  fallbackHref: string,
): BrowserPrintState {
  switch (outcome.kind) {
    case "printed":
      return { step: "sent" };
    case "tab":
      return { step: "tab", href: outcome.blocked ? fallbackHref : null };
    case "failed":
      return { step: "error", href: fallbackHref };
  }
}

/**
 * Texto inline (va dentro del aviso que ya muestra cada botón) con el
 * estado de arriba y, cuando hace falta, el link para abrir el documento
 * imprimible a mano.
 *
 * `sameTab`: en la PWA del mesero no hay pestañas (un `target="_blank"`
 * saca al mesero a un navegador sin su sesión), así que el link navega
 * in-app, igual que "Ver precuenta" ahí mismo.
 *
 * `setup`: cuando se cayó al navegador porque el local NO tiene impresora
 * de facturas, el aviso dice cómo arreglarlo de fondo — imprimir por el
 * agente, como las comandas, en vez de por el driver de Windows (que
 * pagina y corta la factura larga en dos tiras). "link" (quien puede
 * entrar a Configuración) lleva a Impresoras de red; "ask" (el mesero) le
 * dice a quién pedírselo.
 */
export function BrowserPrintStatus({
  state,
  linkClassName = "underline",
  sameTab = false,
  setup = null,
}: {
  state: BrowserPrintState;
  linkClassName?: string;
  sameTab?: boolean;
  setup?: "link" | "ask" | null;
}) {
  const t = useTranslations("browserPrint");
  const link = (href: string) =>
    sameTab ? (
      <Link href={href} className={linkClassName}>
        {t("openLink")}
      </Link>
    ) : (
      <a href={href} target="_blank" rel="noreferrer" className={linkClassName}>
        {t("openLink")}
      </a>
    );
  const hint =
    setup === "link" ? (
      <>
        {" "}
        <Link href={PRINTER_SETTINGS_HREF} className={linkClassName}>
          {t("setupLink")}
        </Link>
      </>
    ) : setup === "ask" ? (
      <>
        {" "}
        {t("setupAsk")}
      </>
    ) : null;
  switch (state.step) {
    case "preparing":
      return <>{t("preparing")}</>;
    case "sent":
      return (
        <>
          {t("sent")}
          {hint}
        </>
      );
    case "tab":
      return state.href ? (
        <>
          {t("fallbackBlocked")}
          {" "}
          {link(state.href)}
          {hint}
        </>
      ) : (
        <>
          {t("fallbackTab")}
          {hint}
        </>
      );
    case "error":
      return (
        <>
          {t("failed")}
          {" "}
          {link(state.href)}
        </>
      );
  }
}
