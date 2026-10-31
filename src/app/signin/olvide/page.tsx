import { ForgotPasswordClient } from "./ForgotPasswordClient";

export const metadata = {
  referrer: "no-referrer",
  robots: { index: false, follow: false },
} as const;

/** "Olvidé mi contraseña" del personal. El comensal tiene su propio flujo. */
export default function ForgotPasswordPage() {
  return (
    <main className="min-h-dvh bg-op-bg flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-op-border bg-op-surface p-6 space-y-4">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-op-muted">
          {"MESAPAY"}
        </div>
        <ForgotPasswordClient />
      </div>
    </main>
  );
}
