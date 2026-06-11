"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { CALLING_CODES } from "@/lib/crm/phone";

// ── Types ──────────────────────────────────────────────────────────────────

type City = { id: string; name: string; isMain: boolean };
type Country = { code: string; name: string; enabled: boolean };
type DupeLead = { id: string; name: string; countryCode: string; stage: string };

// Phone prefix select options (derived from authoritative CALLING_CODES)
const PHONE_PREFIX_OPTIONS = Object.entries(CALLING_CODES).map(([cc, code]) => ({
  cc,
  label: `+${code}`,
  digits: code,
}));

// ── Component ──────────────────────────────────────────────────────────────

export function CrmNewLeadSheet({
  userCountryCode,
  onClose,
  onCreated,
}: {
  userCountryCode: string | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useTranslations("crm");

  // Form state
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  // selectedPrefixCc: the country code for the phone prefix select.
  // Defaults to the lead's country (or first option if no country yet).
  const [selectedPrefixCc, setSelectedPrefixCc] = useState<string>(
    userCountryCode?.toUpperCase() ?? PHONE_PREFIX_OPTIONS[0]?.cc ?? "CO",
  );
  const [contactName, setContactName] = useState("");
  const [cityId, setCityId] = useState("");
  const [citySearch, setCitySearch] = useState("");
  const [cities, setCities] = useState<City[]>([]);
  const [showCityDropdown, setShowCityDropdown] = useState(false);
  const [countryCode, setCountryCode] = useState(userCountryCode ?? "");
  const [countries, setCountries] = useState<Country[]>([]);
  const [priority, setPriority] = useState<"a" | "b" | "c">("b");
  const [unitsCount, setUnitsCount] = useState("");
  const [notes, setNotes] = useState("");

  // Dupe state
  const [dupes, setDupes] = useState<DupeLead[]>([]);
  const [showDupeConfirm, setShowDupeConfirm] = useState(false);

  const [, startTransition] = useTransition();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const citySearchRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  // Lock body scroll when open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  // Fetch countries (if no locked country)
  useEffect(() => {
    if (userCountryCode) return;
    fetch("/api/crm/countries?enabledOnly=1")
      .then((r) => r.json())
      .then((j) => setCountries(j.countries ?? []))
      .catch(() => {});
  }, [userCountryCode]);

  // Fetch cities when countryCode changes or search changes
  const fetchCities = useCallback(
    async (q: string, cc: string) => {
      if (!cc) return;
      const params = new URLSearchParams({ country: cc });
      if (q) params.set("q", q);
      try {
        const res = await fetch(`/api/crm/cities?${params.toString()}`);
        const json = await res.json();
        setCities(json.cities ?? []);
      } catch {
        // ignore
      }
    },
    [],
  );

  useEffect(() => {
    if (countryCode) {
      // fetchCities is async and updates state asynchronously — not sync setState in effect
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchCities("", countryCode);
    }
    // fetchCities is stable (useCallback with empty deps)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countryCode]);

  function handleCitySearch(val: string) {
    setCitySearch(val);
    setCityId("");
    setShowCityDropdown(true);
    if (citySearchRef.current) clearTimeout(citySearchRef.current);
    citySearchRef.current = setTimeout(() => {
      fetchCities(val, countryCode);
    }, 300);
  }

  function selectCity(city: City) {
    setCityId(city.id);
    setCitySearch(city.name);
    setShowCityDropdown(false);
  }

  // ── Submit logic ──────────────────────────────────────────────────────

  async function doCreate(force = false) {
    setSubmitting(true);
    setError(null);
    try {
      const prefixDigits = CALLING_CODES[selectedPrefixCc] ?? "";
      const rawPhone = phone.startsWith("+")
        ? phone
        : prefixDigits
          ? `+${prefixDigits}${phone.replace(/\D/g, "")}`
          : phone.replace(/\D/g, "");

      const body = {
        name: name.trim(),
        countryCode: userCountryCode ? undefined : countryCode || undefined,
        cityId: cityId || undefined,
        priority,
        unitsCount: unitsCount ? parseInt(unitsCount, 10) : undefined,
        notes: notes.trim() || undefined,
        contact:
          contactName.trim() || rawPhone
            ? {
                name: contactName.trim() || name.trim(),
                phone: rawPhone || undefined,
              }
            : undefined,
      };

      // Check dupes first (unless forced)
      if (!force) {
        const dupeRes = await fetch("/api/crm/leads?checkDupes=1", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const dupeJson = await dupeRes.json();
        if (dupeJson.dupes && dupeJson.dupes.length > 0) {
          setDupes(dupeJson.dupes);
          setShowDupeConfirm(true);
          setSubmitting(false);
          return;
        }
      }

      // Actually create
      const res = await fetch("/api/crm/leads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "error");
        setSubmitting(false);
        return;
      }

      startTransition(() => {
        onCreated();
      });
    } catch {
      setError("network_error");
      setSubmitting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await doCreate(false);
  }

  // ── Render ─────────────────────────────────────────────────────────────

  if (showDupeConfirm) {
    return (
      <Overlay onClose={onClose}>
        <SheetContent innerRef={sheetRef}>
          <SheetHandle />
          <div className="px-4 pb-6 pt-2 space-y-4">
            <div className="font-display text-xl">{t("dupesTitle")}</div>
            <p className="text-sm text-op-muted">{t("dupesDesc")}</p>
            <ul className="space-y-2">
              {dupes.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center justify-between text-sm border border-op-border rounded-xl px-3 py-2"
                >
                  <span className="font-medium">{d.name}</span>
                  <span className="font-mono text-[10px] uppercase text-op-muted">
                    {d.stage}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex gap-3">
              <button
                onClick={() => setShowDupeConfirm(false)}
                className="flex-1 py-3 rounded-xl border border-op-border text-sm font-medium min-h-[44px]"
              >
                {t("dupesCancel")}
              </button>
              <button
                onClick={() => {
                  setShowDupeConfirm(false);
                  doCreate(true);
                }}
                disabled={submitting}
                className="flex-1 py-3 rounded-xl bg-terracotta text-white text-sm font-medium disabled:opacity-50 min-h-[44px]"
              >
                {t("dupesConfirm")}
              </button>
            </div>
          </div>
        </SheetContent>
      </Overlay>
    );
  }

  return (
    <Overlay onClose={onClose}>
      <SheetContent innerRef={sheetRef}>
        <SheetHandle />
        <div className="flex items-center justify-between px-4 py-3 border-b border-op-border">
          <div className="font-display text-xl">{t("newLeadTitle")}</div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-op-muted hover:text-op-text min-h-[44px] min-w-[44px] flex items-center justify-center"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
              <path
                fillRule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="overflow-y-auto flex-1">
          <div className="px-4 py-4 space-y-4 pb-6">
            {/* Country (locked or selector) */}
            {userCountryCode ? (
              <div>
                <FieldLabel>{t("fieldCountry")}</FieldLabel>
                <div className="text-sm text-op-muted border border-op-border rounded-xl px-3 py-2.5 bg-op-bg">
                  {userCountryCode}
                </div>
              </div>
            ) : (
              <div>
                <FieldLabel>{t("fieldCountry")}</FieldLabel>
                <select
                  required
                  value={countryCode}
                  onChange={(e) => {
                    setCountryCode(e.target.value);
                    setCityId("");
                    setCitySearch("");
                  }}
                  className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
                >
                  <option value={""}>{"—"}</option>
                  {countries.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Business name */}
            <div>
              <FieldLabel required>{t("fieldName")}</FieldLabel>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
              />
            </div>

            {/* Phone */}
            <div>
              <FieldLabel>{t("fieldPhone")}</FieldLabel>
              <div className="flex gap-2 items-center">
                <select
                  aria-label={t("phonePrefixLabel")}
                  value={selectedPrefixCc}
                  onChange={(e) => setSelectedPrefixCc(e.target.value)}
                  className="font-mono text-sm text-op-muted border border-op-border rounded-xl px-2 py-2.5 bg-op-bg whitespace-nowrap min-h-[44px] focus:outline-none focus:ring-1 focus:ring-terracotta"
                >
                  {PHONE_PREFIX_OPTIONS.map((opt) => (
                    <option key={opt.cc} value={opt.cc}>{opt.label}</option>
                  ))}
                </select>
                <input
                  type="tel"
                  inputMode="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="flex-1 px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
                />
              </div>
            </div>

            {/* Contact name */}
            <div>
              <FieldLabel>{t("fieldContactName")}</FieldLabel>
              <input
                type="text"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
              />
            </div>

            {/* City combobox */}
            <div className="relative">
              <FieldLabel>{t("fieldCity")}</FieldLabel>
              <input
                type="text"
                value={citySearch}
                onChange={(e) => handleCitySearch(e.target.value)}
                onFocus={() => setShowCityDropdown(true)}
                placeholder={t("cityPlaceholder")}
                autoComplete="off"
                className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
              />
              {showCityDropdown && cities.length > 0 && (
                <ul className="absolute z-50 left-0 right-0 top-full mt-1 max-h-52 overflow-y-auto rounded-xl border border-op-border bg-op-surface shadow-lg">
                  {cities.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onMouseDown={() => selectCity(c)}
                        className={
                          "w-full text-left px-4 py-3 text-sm hover:bg-op-bg min-h-[44px] " +
                          (c.isMain ? "font-medium" : "")
                        }
                      >
                        {c.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Priority */}
            <div>
              <FieldLabel>{t("fieldPriority")}</FieldLabel>
              <div className="flex gap-2">
                {(["a", "b", "c"] as const).map((p) => {
                  const labels: Record<string, string> = {
                    a: t("priorityA"),
                    b: t("priorityB"),
                    c: t("priorityC"),
                  };
                  const colors: Record<string, string> = {
                    a: "border-rose-400 bg-rose-50 text-rose-700",
                    b: "border-amber-400 bg-amber-50 text-amber-700",
                    c: "border-slate-300 bg-slate-50 text-slate-600",
                  };
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPriority(p)}
                      className={
                        "flex-1 py-2.5 rounded-xl border-2 text-sm font-medium min-h-[44px] transition-all " +
                        (priority === p
                          ? colors[p]
                          : "border-op-border text-op-muted hover:border-op-text")
                      }
                    >
                      {labels[p]}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Number of restaurants */}
            <div>
              <FieldLabel>{t("fieldUnitsCount")}</FieldLabel>
              <input
                type="number"
                min="1"
                value={unitsCount}
                onChange={(e) => setUnitsCount(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
              />
            </div>

            {/* Notes */}
            <div>
              <FieldLabel>{t("fieldNotes")}</FieldLabel>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta resize-none"
              />
            </div>

            {error && (
              <p className="text-sm text-terracotta">{error}</p>
            )}

            <button
              type="submit"
              disabled={submitting || !name.trim()}
              className="w-full py-3.5 rounded-xl bg-terracotta text-white font-medium disabled:opacity-50 min-h-[44px]"
            >
              {submitting ? t("creating") : t("submitCreate")}
            </button>
          </div>
        </form>
      </SheetContent>
    </Overlay>
  );
}

// ── Sheet primitives ───────────────────────────────────────────────────────

function Overlay({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end"
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      {children}
    </div>
  );
}

function SheetContent({
  innerRef,
  children,
}: {
  innerRef: React.RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}) {
  return (
    <div
      ref={innerRef}
      className="relative z-10 bg-op-surface rounded-t-2xl max-h-[90dvh] flex flex-col shadow-xl"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {children}
    </div>
  );
}

function SheetHandle() {
  return (
    <div className="flex justify-center pt-3 pb-1">
      <div className="w-10 h-1 rounded-full bg-op-border" />
    </div>
  );
}

function FieldLabel({
  children,
  required,
}: {
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <label className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
      {children}
      {required && <span className="text-terracotta ml-0.5">{"*"}</span>}
    </label>
  );
}
