"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Icon } from "@/components/ui/Icon";

export default function OperatorError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("workspaceUi");
  return (
    <div className="mp-page">
      <div className="mp-panel mp-empty-state" role="alert">
        <Icon name="help" />
        <h1 className="text-xl font-semibold text-op-text">
          {t("errorTitle")}
        </h1>
        <p className="max-w-md leading-relaxed">{t("errorDescription")}</p>
        <div className="flex flex-wrap justify-center gap-3">
          <button onClick={reset} className="mp-btn mp-btn--primary">
            {t("retry")}
          </button>
          <Link href="/operator" className="mp-btn mp-btn--secondary">
            {t("back")}
          </Link>
        </div>
      </div>
    </div>
  );
}
