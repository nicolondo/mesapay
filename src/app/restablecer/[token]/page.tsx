import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { hashResetToken } from "@/lib/passwordReset";
import { ResetPasswordClient } from "./ResetPasswordClient";

export const dynamic = "force-dynamic";

export default async function RestablecerPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const t = await getTranslations("resetPwd");

  const record = await db.passwordResetToken.findUnique({
    where: { tokenHash: hashResetToken(token) },
    select: { usedAt: true, expiresAt: true },
  });

  const valid = !!record && !record.usedAt && record.expiresAt > new Date();

  return (
    <main className="min-h-dvh bg-op-bg flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-op-border bg-op-surface p-6 space-y-4">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-op-muted">
          MESAPAY
        </div>
        {valid ? (
          <ResetPasswordClient token={token} />
        ) : (
          <div className="space-y-4">
            <h1 className="font-display text-2xl tracking-[-0.015em]">
              {t("invalidTitle")}
            </h1>
            <p className="text-sm text-op-muted">{t("invalidBody")}</p>
            <Link
              href="/signin"
              className="inline-flex items-center justify-center w-full py-3.5 rounded-xl bg-ink text-bone text-sm font-medium min-h-[44px]"
            >
              {t("goLogin")}
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
