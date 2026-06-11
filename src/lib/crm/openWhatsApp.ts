import { waAppLink, waLink } from "./phone";

/**
 * Open WhatsApp for the given E.164 phone number.
 *
 * Strategy:
 * 1. Navigate the current window to the native `whatsapp://` scheme.
 * 2. If the WhatsApp app is installed it will take over and the window will
 *    blur or become hidden — cancel the fallback timer.
 * 3. If nothing handles the scheme within 1.5 s, open wa.me in a new tab.
 *
 * Works on both desktop and mobile.
 */
export function openWhatsApp(e164: string, text?: string): void {
  const app = waAppLink(e164, text);
  const web = waLink(e164, text);

  const timer = setTimeout(() => {
    cleanup();
    window.open(web, "_blank", "noopener,noreferrer");
  }, 1500);

  const cancel = () => {
    clearTimeout(timer);
    cleanup();
  };

  const onHide = () => {
    if (document.hidden) cancel();
  };

  function cleanup() {
    window.removeEventListener("blur", cancel);
    document.removeEventListener("visibilitychange", onHide);
  }

  window.addEventListener("blur", cancel);
  document.addEventListener("visibilitychange", onHide);

  window.location.href = app;
}
