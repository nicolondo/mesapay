"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  AddressAutocomplete,
  type AddressValue,
} from "@/components/AddressAutocomplete";

export function NewRestaurantClient() {
  const router = useRouter();
  const tl = useTranslations("location");
  const tg = useTranslations("opGroup");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [serviceMode, setServiceMode] = useState<"table" | "counter">("table");
  const [location, setLocation] = useState<AddressValue>({
    address: "",
    city: "",
    country: "",
    countryName: "",
    placeId: "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Auto-generar slug del nombre mientras el usuario no lo edite a
  // mano. Una vez que toca el slug input, dejamos su versión.
  function setNameAndSlug(value: string) {
    setName(value);
    if (!slugTouched) {
      setSlug(autoSlug(value));
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!name.trim() || !slug.trim()) {
      setErr(tg("missingData"));
      return;
    }
    setBusy(true);
    const res = await fetch("/api/group/restaurants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        slug: slug.trim(),
        serviceMode,
        address: location.address,
        city: location.city,
        country: location.country,
        countryName: location.countryName,
        placeId: location.placeId,
      }),
    });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(j.message ?? j.error ?? tg("createRestaurantFailed"));
      return;
    }
    // Después de crear, volvemos al landing — desde ahí el group_admin
    // puede impersonar al nuevo restaurante para configurarlo.
    router.push("/group");
    router.refresh();
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-2xl border border-op-border bg-op-surface p-5 space-y-4"
    >
      <div>
        <label className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1.5 block">
          {tg("fieldName")}
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setNameAndSlug(e.target.value)}
          maxLength={80}
          placeholder={tg("namePlaceholder")}
          className={inputCls}
          autoFocus
        />
      </div>

      <div>
        <label className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1.5 block">
          {tg("fieldUrlId")}
        </label>
        <div className="flex items-center gap-2">
          <span className="text-op-muted text-sm">{tg("urlPrefix")}</span>
          <input
            type="text"
            value={slug}
            onChange={(e) => {
              setSlug(autoSlug(e.target.value));
              setSlugTouched(true);
            }}
            maxLength={40}
            placeholder={tg("slugPlaceholder")}
            className={inputCls + " flex-1"}
          />
        </div>
        <div className="text-[10px] text-op-muted mt-1">{tg("slugHint")}</div>
      </div>

      <div>
        <label className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-2 block">
          {tg("serviceMode")}
        </label>
        <div className="flex gap-2 flex-wrap">
          {(
            [
              {
                value: "table" as const,
                label: tg("serviceModeTableLabel"),
                desc: tg("serviceModeTableDesc"),
              },
              {
                value: "counter" as const,
                label: tg("serviceModeCounterLabel"),
                desc: tg("serviceModeCounterDesc"),
              },
            ]
          ).map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setServiceMode(o.value)}
              className={
                "flex-1 min-w-[140px] text-left rounded-xl border p-3 transition-colors " +
                (serviceMode === o.value
                  ? "border-ink bg-ink/5"
                  : "border-op-border hover:border-op-text/30")
              }
            >
              <div className="font-medium text-sm">{o.label}</div>
              <div className="text-[11px] text-op-muted mt-0.5">{o.desc}</div>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-2">
          {tl("section")}
        </div>
        <AddressAutocomplete
          labelAddress={tl("address")}
          addressPlaceholder={tl("addressPlaceholder")}
          labelCity={tl("city")}
          cityPlaceholder={tl("cityPlaceholder")}
          labelCountry={tl("country")}
          countryPlaceholder={tl("countryPlaceholder")}
          onChange={setLocation}
        />
      </div>

      {err && <div className="text-danger text-xs">{err}</div>}

      <div className="flex items-center justify-end gap-3">
        <button
          type="submit"
          disabled={busy || !name.trim() || !slug.trim()}
          className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
        >
          {busy ? tg("creatingRestaurant") : tg("createRestaurantCta")}
        </button>
      </div>
    </form>
  );
}

function autoSlug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

const inputCls =
  "w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta";
