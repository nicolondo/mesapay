"use server";

import { cookies } from "next/headers";
import { isLocale, LOCALE_COOKIE } from "./config";

/**
 * Server action que persiste la preferencia de idioma en una cookie.
 * La llama el LocaleSwitcher; luego el cliente hace router.refresh()
 * para re-renderizar con el nuevo catálogo.
 */
export async function setLocale(locale: string) {
  if (!isLocale(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365, // 1 año
    sameSite: "lax",
  });
}
