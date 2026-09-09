"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Icon, type IconName } from "@/components/ui/Icon";

export type SettingsItem = {
  href: string;
  title: string;
  subtitle: string;
  badge: string;
  tint: string;
};
const groups: { key: string; icon: IconName; paths: string[] }[] = [
  {
    key: "business",
    icon: "business",
    paths: [
      "identidad",
      "pagos",
      "wallet",
      "facturacion-dian",
      "suscripcion",
      "proveedores",
    ],
  },
  {
    key: "team",
    icon: "serve",
    paths: ["usuarios", "meseros", "staff-policies"],
  },
  {
    key: "service",
    icon: "tables",
    paths: [
      "estaciones",
      "impresoras",
      "datafonos",
      "reservas",
      "mesas",
      "salon",
    ],
  },
  { key: "menu", icon: "menu", paths: ["etiquetas", "traducciones"] },
];
export function SettingsDirectory({ items }: { items: SettingsItem[] }) {
  const t = useTranslations("workspaceUi");
  const [query, setQuery] = useState("");
  const normalize = (v: string) =>
    v
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase();
  const filtered = items.filter((i) =>
    normalize(`${i.title} ${i.subtitle} ${i.badge}`).includes(
      normalize(query.trim()),
    ),
  );
  return (
    <>
      <div className="mp-directory-toolbar">
        <label className="mp-search-field">
          <Icon name="search" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t("searchSettings")}
            placeholder={t("searchSettings")}
          />
        </label>
        <span className="text-sm text-op-muted" role="status">
          {t("settingsCount", { count: filtered.length })}
        </span>
      </div>
      {filtered.length === 0 && (
        <div className="mp-empty-state">
          <Icon name="search" />
          <h2>{t("noSections")}</h2>
          <button
            className="mp-btn mp-btn--secondary"
            onClick={() => setQuery("")}
          >
            {t("clearSearch")}
          </button>
        </div>
      )}
      <div className="mp-settings-grid">
        {groups.map((group) => {
          const entries = filtered.filter(
            (i) =>
              group.paths.includes(i.href.split("/").at(-1)!) ||
              (group.key === "service" &&
                !groups.some((g) =>
                  g.paths.includes(i.href.split("/").at(-1)!),
                )),
          );
          if (!entries.length) return null;
          return (
            <section key={group.key} aria-labelledby={`settings-${group.key}`}>
              <h2 id={`settings-${group.key}`} className="mp-section-heading">
                <Icon name={group.icon} />
                {t(`group_${group.key}`)}
              </h2>
              <div className="mp-settings-list">
                {entries.map((i) => (
                  <Link key={i.href} href={i.href} className="mp-setting-row">
                    <div className="min-w-0">
                      <h3>{i.title}</h3>
                      <p>{i.subtitle}</p>
                      <span className={`mp-setting-badge ${i.tint}`}>
                        {i.badge}
                      </span>
                    </div>
                    <Icon name="arrow" className="shrink-0 text-op-muted" />
                  </Link>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
