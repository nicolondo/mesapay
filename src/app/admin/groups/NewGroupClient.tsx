"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

export function NewGroupClient({
  ungroupedRestaurants,
}: {
  ungroupedRestaurants: { id: string; name: string; slug: string }[];
}) {
  const t = useTranslations("opAdminGroups");
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [selectedRestaurants, setSelectedRestaurants] = useState<Set<string>>(
    new Set(),
  );
  const [restaurantSearch, setRestaurantSearch] = useState("");
  const [createAdmin, setCreateAdmin] = useState(false);
  const [adminEmail, setAdminEmail] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Filtro accent-insensitive sobre name + slug. NFD descompone los
  // acentos en caracter base + diacritic; el regex saca los
  // diacritics (range U+0300-U+036F). Resultado: "delirio" matchea
  // tanto "Delirio" como "Delírío", y "cafe" matchea "Café".
  const normalizedSearch = useMemo(
    () =>
      restaurantSearch
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, ""),
    [restaurantSearch],
  );
  const filteredRestaurants = useMemo(() => {
    if (!normalizedSearch) return ungroupedRestaurants;
    return ungroupedRestaurants.filter((r) => {
      const haystack = (r.name + " " + r.slug)
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "");
      return haystack.includes(normalizedSearch);
    });
  }, [ungroupedRestaurants, normalizedSearch]);

  function autoSlug(s: string) {
    return s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  }

  function setNameAndSlug(v: string) {
    setName(v);
    if (!slugTouched) setSlug(autoSlug(v));
  }

  function toggleRestaurant(id: string) {
    setSelectedRestaurants((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function create() {
    setErr(null);
    if (!name.trim() || !slug.trim()) {
      setErr(t("nameSlugRequired"));
      return;
    }
    if (createAdmin) {
      if (!adminEmail.trim() || !adminPassword) {
        setErr(t("adminCredsRequired"));
        return;
      }
      if (adminPassword.length < 6) {
        setErr(t("passwordTooShort"));
        return;
      }
    }
    setBusy(true);
    const res = await fetch("/api/admin/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        slug: slug.trim(),
        restaurantIds: Array.from(selectedRestaurants),
        ...(createAdmin && {
          adminEmail: adminEmail.trim().toLowerCase(),
          adminName: adminName.trim() || undefined,
          adminPassword,
        }),
      }),
    });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(j.message ?? t("createGroupFailed"));
      return;
    }
    // Reset
    setName("");
    setSlug("");
    setSlugTouched(false);
    setSelectedRestaurants(new Set());
    setCreateAdmin(false);
    setAdminEmail("");
    setAdminName("");
    setAdminPassword("");
    router.refresh();
  }

  return (
    <section className="rounded-2xl border border-op-border bg-op-surface p-5 space-y-4">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
        {t("createGroup")}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label={t("fieldName")}>
          <input
            type="text"
            value={name}
            onChange={(e) => setNameAndSlug(e.target.value)}
            maxLength={160}
            placeholder={t("namePlaceholder")}
            className={inputCls}
          />
        </Field>
        <Field label={t("fieldSlug")}>
          <input
            type="text"
            value={slug}
            onChange={(e) => {
              setSlug(autoSlug(e.target.value));
              setSlugTouched(true);
            }}
            maxLength={40}
            placeholder={t("slugPlaceholder")}
            className={inputCls}
          />
        </Field>
      </div>

      {ungroupedRestaurants.length > 0 && (
        <div>
          <div className="flex items-baseline justify-between gap-2 mb-2 flex-wrap">
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
              {t("assignRestaurants")}
            </div>
            {/* Contador: cuando hay filtro activo, mostrar el match vs
                total para que sepan que la lista esta filtrada. */}
            <div className="font-mono text-[10px] text-op-muted">
              {normalizedSearch
                ? t("filteredCount", {
                    shown: filteredRestaurants.length,
                    total: ungroupedRestaurants.length,
                  })
                : t("ungroupedCount", { count: ungroupedRestaurants.length })}
            </div>
          </div>
          <div className="relative mb-2">
            <input
              type="search"
              value={restaurantSearch}
              onChange={(e) => setRestaurantSearch(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="w-full h-10 pl-9 pr-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta"
            />
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              className="absolute left-3 top-1/2 -translate-y-1/2 text-op-muted pointer-events-none"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-64 overflow-auto rounded-lg border border-op-border p-2 bg-op-bg/30">
            {filteredRestaurants.length === 0 ? (
              <div className="col-span-full text-center text-xs text-op-muted py-6">
                {t("noSearchResults", { query: restaurantSearch.trim() })}
              </div>
            ) : (
              filteredRestaurants.map((r) => (
                <label
                  key={r.id}
                  className={
                    "flex items-center gap-2 rounded-md p-2 cursor-pointer border " +
                    (selectedRestaurants.has(r.id)
                      ? "border-ink bg-ink/5"
                      : "border-transparent hover:bg-op-bg")
                  }
                >
                  <input
                    type="checkbox"
                    checked={selectedRestaurants.has(r.id)}
                    onChange={() => toggleRestaurant(r.id)}
                    className="accent-ink"
                  />
                  <div className="min-w-0">
                    <div className="text-sm truncate">{r.name}</div>
                    <div className="font-mono text-[10px] text-op-muted">
                      /{r.slug}
                    </div>
                  </div>
                </label>
              ))
            )}
          </div>
          <div className="text-[10px] text-op-muted mt-1">
            {selectedRestaurants.size > 0
              ? t("selectedCount", { count: selectedRestaurants.size })
              : t("onlyUngrouped")}
          </div>
        </div>
      )}

      <div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={createAdmin}
            onChange={(e) => setCreateAdmin(e.target.checked)}
            className="accent-ink"
          />
          <span className="text-sm">
            {t("createGroupAdmin")}
          </span>
        </label>
        {createAdmin && (
          <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label={t("fieldName")}>
              <input
                type="text"
                value={adminName}
                onChange={(e) => setAdminName(e.target.value)}
                placeholder={t("adminNamePlaceholder")}
                className={inputCls}
              />
            </Field>
            <Field label={t("fieldEmail")}>
              <input
                type="email"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                placeholder={t("adminEmailPlaceholder")}
                className={inputCls}
              />
            </Field>
            <Field label={t("fieldPassword")}>
              <input
                type="password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                placeholder={t("passwordPlaceholder")}
                className={inputCls}
              />
            </Field>
          </div>
        )}
      </div>

      {err && <div className="text-xs text-danger">{err}</div>}

      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={create}
          disabled={busy || !name.trim() || !slug.trim()}
          className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
        >
          {busy ? t("creating") : t("createGroupCta")}
        </button>
      </div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
        {label}
      </div>
      {children}
    </label>
  );
}

const inputCls =
  "w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta";
