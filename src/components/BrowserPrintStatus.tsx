"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import type { BrowserPrintOutcome } from "@/lib/printInBrowser";

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
 */
export function BrowserPrintStatus({
  state,
  linkClassName = "underline",
  sameTab = false,
}: {
  state: BrowserPrintState;
  linkClassName?: string;
  sameTab?: boolean;
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
  switch (state.step) {
    case "preparing":
      return <>{t("preparing")}</>;
    case "sent":
      return <>{t("sent")}</>;
    case "tab":
      return state.href ? (
        <>
          {t("fallbackBlocked")}
          {" "}
          {link(state.href)}
        </>
      ) : (
        <>{t("fallbackTab")}</>
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
