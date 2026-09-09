import { getTranslations } from "next-intl/server";

export default async function Loading() {
  const t = await getTranslations("workspaceUi");
  return (
    <div
      className="mp-page"
      role="status"
      aria-label={t("loading")}
      aria-busy="true"
    >
      <span className="sr-only">{t("loading")}</span>
      <div aria-hidden="true" className="animate-pulse space-y-6">
        <div className="h-4 w-32 rounded bg-op-border" />
        <div className="h-8 w-2/3 max-w-sm rounded bg-op-border" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-28 rounded-2xl bg-op-surface border border-op-border"
            />
          ))}
        </div>
        <div className="h-72 rounded-2xl bg-op-surface border border-op-border" />
      </div>
    </div>
  );
}
