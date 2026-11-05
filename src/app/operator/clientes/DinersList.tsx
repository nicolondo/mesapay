"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatDate, formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import { dinerListHref, type DinerListParams, type DinerSort } from "@/lib/dinerList";
import type { DinerListPage, DinerListRow } from "@/lib/dinerListQueries";
import {
  EmptyState,
  ListPagination,
  SearchBox,
  SelectField,
  Td,
  Th,
  useListNavigation,
} from "@/components/billingCustomers/ListControls";

/**
 * Pestaña "Comensales registrados": las personas que crearon su cuenta desde
 * la carta de este restaurante. Misma mecánica que los clientes de
 * facturación —búsqueda, orden y página en la URL, resueltos en el
 * servidor— y cada fila lleva a la ficha del comensal (descuento y
 * facturas). La búsqueda es por nombre, correo o cédula, completos o en
 * parte: reemplaza al buscador viejo de "cédula o correo exactos".
 */
export function DinersList({
  list,
  params,
  currency,
  header,
  tabs,
}: {
  list: DinerListPage;
  params: DinerListParams;
  currency: string;
  header: ReactNode;
  tabs: ReactNode;
}) {
  const t = useTranslations("opCustomers");
  const locale = useLocale() as Locale;
  const money = (cents: number) => formatMoney(cents, { currency, locale });
  const date = (iso: string) => formatDate(iso, { locale, timeStyle: undefined });
  const nav = useListNavigation();
  const sortOptions: { value: DinerSort; label: string }[] = [
    { value: "spend", label: t("sortSpend") },
    { value: "recent", label: t("sortRecent") },
    { value: "name", label: t("sortName") },
  ];
  const clearLink = (
    <Link href={dinerListHref({ sort: params.sort })} prefetch={false} scroll={false} className="mp-btn mp-btn--ghost mp-btn--sm">
      {t("clearSearch")}
    </Link>
  );

  return (
    <>
      {header}
      {tabs}
      <section aria-labelledby="diners-title" className="@container">
        <h2 id="diners-title" className="sr-only">
          {t("listTitle")}
        </h2>
        {list.allCount === 0 ? (
          <EmptyState title={t("emptyTitle")} body={t("empty")} />
        ) : (
          <>
            <div className="mb-3 flex flex-col gap-3 @2xl:flex-row @2xl:items-end">
              <div className="min-w-0 @2xl:flex-1">
                <div aria-hidden className="hidden @2xl:block font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted mb-1">
                  {t("searchShort")}
                </div>
                <SearchBox
                  id="diners-search"
                  label={t("dinersSearchLabel")}
                  placeholder={t("dinersSearchPlaceholder")}
                  value={params.q}
                  onSearch={(q) => nav.go(dinerListHref({ ...params, q, page: 1 }), "replace")}
                />
              </div>
              <SelectField
                id="diners-sort"
                label={t("sortLabel")}
                value={params.sort}
                options={sortOptions}
                onChange={(sort) => nav.go(dinerListHref({ ...params, sort, page: 1 }))}
                className="@2xl:w-56"
              />
            </div>
            <div className="mb-3 flex min-h-9 flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-op-muted tabular" aria-live="polite">
                {t("dinersSummary", { count: list.total, withOrders: list.summary.withOrders, amount: money(list.summary.totalCents) })}
              </span>
              {params.q && list.rows.length > 0 && clearLink}
            </div>
            <div aria-busy={nav.pending} className={`transition-opacity duration-150 ${nav.pending ? "opacity-55" : ""}`}>
              {list.rows.length === 0 ? (
                <EmptyState title={t("dinersNoResults")} action={clearLink} />
              ) : (
                <>
                  <DinerTable rows={list.rows} money={money} date={date} />
                  <DinerCards rows={list.rows} money={money} date={date} />
                </>
              )}
              <ListPagination
                from={list.from}
                to={list.to}
                total={list.total}
                prevHref={list.page > 1 ? dinerListHref({ ...params, page: list.page - 1 }) : null}
                nextHref={list.page < list.pageCount ? dinerListHref({ ...params, page: list.page + 1 }) : null}
              />
            </div>
          </>
        )}
      </section>
    </>
  );
}

type RowProps = { rows: DinerListRow[]; money: (c: number) => string; date: (iso: string) => string };

function DinerBadges({ diner }: { diner: DinerListRow }) {
  const t = useTranslations("opCustomers");
  if (diner.discountPct == null && !diner.disabled) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1.5">
      {diner.discountPct != null && (
        <span className="inline-flex items-center rounded-full border border-ok/25 bg-ok/10 px-2 py-0.5 text-[11px] text-[color-mix(in_srgb,var(--ok)_80%,var(--op-text))]">
          {t("discountBadge", { pct: diner.discountPct })}
        </span>
      )}
      {diner.disabled && (
        <span className="inline-flex items-center rounded-full border border-danger/25 bg-danger/10 px-2 py-0.5 text-[11px] text-[color-mix(in_srgb,var(--danger)_85%,var(--op-text))]">
          {t("blockedBadge")}
        </span>
      )}
    </span>
  );
}

function DinerTable({ rows, money, date }: RowProps) {
  const t = useTranslations("opCustomers");
  return (
    <div className="hidden @4xl:block overflow-hidden rounded-2xl border border-op-border bg-op-surface">
      <table className="w-full text-sm">
        <thead className="bg-op-bg">
          <tr>
            <Th>{t("colDiner")}</Th>
            <Th>{t("cedula")}</Th>
            <Th>{t("colEmail")}</Th>
            <Th>{t("colRegistered")}</Th>
            <Th align="right">{t("statOrders")}</Th>
            <Th align="right">{t("statTotal")}</Th>
            <Th align="right">
              <span className="sr-only">{t("colActions")}</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id} className="border-t border-op-border transition-colors hover:bg-op-bg/50">
              <Td className="min-w-[11rem] max-w-[16rem]">
                <span className="block font-medium break-words">{d.name ?? d.email}</span>
                <DinerBadges diner={d} />
              </Td>
              <Td className="font-mono text-[13px] whitespace-nowrap">{d.cedula ?? <span className="text-op-muted">{"—"}</span>}</Td>
              <Td className="w-full max-w-0">
                <span className="block truncate" title={d.email}>
                  {d.email}
                </span>
              </Td>
              <Td className="whitespace-nowrap text-op-muted">{date(d.createdAt)}</Td>
              <Td align="right" className="font-mono tabular">{d.orders}</Td>
              <Td align="right" className="font-mono tabular whitespace-nowrap">
                {d.orders === 0 ? <span className="text-op-muted">{"—"}</span> : money(d.totalCents)}
              </Td>
              <Td align="right">
                <Link
                  href={`/operator/clientes/${d.id}`}
                  prefetch={false}
                  aria-label={t("viewFor", { name: d.name ?? d.email })}
                  className="mp-btn mp-btn--secondary mp-btn--sm"
                >
                  {t("view")}
                </Link>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DinerCards({ rows, money, date }: RowProps) {
  const t = useTranslations("opCustomers");
  return (
    <ul className="@4xl:hidden grid grid-cols-1 gap-2 @2xl:grid-cols-2">
      {rows.map((d) => (
        <li key={d.id}>
          <Link
            href={`/operator/clientes/${d.id}`}
            prefetch={false}
            className="flex h-full items-start justify-between gap-3 rounded-2xl border border-op-border bg-op-surface p-4 active:bg-op-bg/60 hover:border-op-border-2"
          >
            <span className="min-w-0">
              <span className="block font-medium break-words leading-snug">{d.name ?? d.email}</span>
              <span className="mt-0.5 block text-xs text-op-muted break-all">
                {d.cedula ? `${d.cedula} · ` : ""}
                {d.email}
              </span>
              <DinerBadges diner={d} />
            </span>
            <span className="shrink-0 text-right">
              {d.orders === 0 ? (
                <>
                  <span className="block text-xs text-op-muted">{t("noOrdersYet")}</span>
                  <span className="block text-[11px] text-op-muted">{t("registeredOn", { date: date(d.createdAt) })}</span>
                </>
              ) : (
                <>
                  <span className="block font-semibold tabular">{money(d.totalCents)}</span>
                  <span className="block text-[11px] text-op-muted">{t("ordersCount", { count: d.orders })}</span>
                </>
              )}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
