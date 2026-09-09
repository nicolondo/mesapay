"use client";
import { useTranslations } from "next-intl";

/** Never expose a provider's raw response or a server's hardcoded language. */
export function useApiError() {
  const t = useTranslations("apiErrors");
  return (body: { error?: unknown }, fallback?: string) => {
    const code = typeof body.error === "string" ? body.error : "";
    return code && t.has(code) ? t(code) : fallback ?? t("generic");
  };
}
