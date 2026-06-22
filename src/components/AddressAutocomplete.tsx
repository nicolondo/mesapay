"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "next-intl";

/**
 * Campo de dirección con autocompletado de Google Places + ciudad + país.
 *
 * Reutiliza el patrón de carga lazy del script de Maps (ver
 * InvoiceRequestPanel). Es agnóstico de i18n: los textos (labels /
 * placeholders) llegan por props, así que pasa el guardarraíl sin
 * literales. Sirve para los dos estilos de formulario del repo:
 *   - Server action (FormData): pasá `nameAddress/nameCity/nameCountry`
 *     y los inputs llevan ese `name` para que FormData los recoja.
 *   - Form controlado en React: usá `onChange` para leer los valores.
 *
 * El país se guarda como ISO-3166-1 alpha-2 (CO, MX, …) para filtrar
 * estable; el nombre visible se deriva con Intl.DisplayNames en el
 * idioma activo. Al elegir una dirección, autocompleta ciudad y país.
 */

// Fallback de países cuando no se pasan `countryCodes` desde el server
// (LATAM + US + ES). Las pantallas de alta de restaurante pasan la lista
// de países HABILITADOS en config, así el <select> solo ofrece esos.
const DEFAULT_COUNTRY_CODES = [
  "CO", "MX", "BR", "US", "AR", "CL", "PE", "EC",
  "CR", "PA", "UY", "BO", "PY", "VE", "GT", "DO", "ES",
];

export type AddressValue = {
  address: string;
  city: string;
  country: string; // ISO alpha-2
  countryName: string;
  placeId: string;
};

export function AddressAutocomplete({
  labelAddress,
  addressPlaceholder,
  labelCity,
  cityPlaceholder,
  labelCountry,
  countryPlaceholder,
  defaultAddress = "",
  defaultCity = "",
  defaultCountry = "",
  required = false,
  requiredCountry = false,
  countryCodes,
  onChange,
  nameAddress,
  nameCity,
  nameCountry,
  nameCountryName,
  namePlaceId,
}: {
  labelAddress: string;
  addressPlaceholder?: string;
  labelCity: string;
  cityPlaceholder?: string;
  labelCountry: string;
  countryPlaceholder?: string;
  defaultAddress?: string;
  defaultCity?: string;
  defaultCountry?: string;
  required?: boolean;
  /** Marca solo el país como obligatorio (sin forzar dirección/ciudad). */
  requiredCountry?: boolean;
  /** Si se pasa, el <select> solo ofrece estos países (ISO-2). */
  countryCodes?: string[];
  onChange?: (v: AddressValue) => void;
  nameAddress?: string;
  nameCity?: string;
  nameCountry?: string;
  nameCountryName?: string;
  namePlaceId?: string;
}) {
  const options =
    countryCodes && countryCodes.length > 0
      ? countryCodes
      : DEFAULT_COUNTRY_CODES;
  const locale = useLocale();
  const [address, setAddress] = useState(defaultAddress);
  const [city, setCity] = useState(defaultCity);
  const [country, setCountry] = useState(defaultCountry);
  const [placeId, setPlaceId] = useState("");
  const addressRef = useRef<HTMLInputElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acRef = useRef<any>(null);

  // Nombre de país localizado (Colombia / Colômbia / Colombia).
  const regionNames = useMemo(() => {
    try {
      return new Intl.DisplayNames([locale], { type: "region" });
    } catch {
      return null;
    }
  }, [locale]);
  const countryLabel = (code: string) =>
    (regionNames?.of(code) ?? code) || code;
  const countryName = country ? countryLabel(country) : "";

  // Emitimos cambios al padre sin bucles: onChange en ref.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    onChangeRef.current?.({ address, city, country, countryName, placeId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, city, country, placeId]);

  // Lazy-load del script de Places + attach al input de dirección.
  useEffect(() => {
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!apiKey) return;

    function attach() {
      const w = window as unknown as { google?: typeof google };
      if (!addressRef.current || !w.google?.maps?.places) return;
      const ac = new w.google.maps.places.Autocomplete(addressRef.current, {
        types: ["address"],
        fields: ["address_components", "formatted_address", "place_id"],
      });
      ac.addListener("place_changed", () => {
        const place = ac.getPlace();
        const comps = place.address_components ?? [];
        let route = "";
        let streetNumber = "";
        let cityVal = "";
        let countryIso = "";
        for (const c of comps) {
          if (c.types.includes("street_number")) streetNumber = c.long_name;
          else if (c.types.includes("route")) route = c.long_name;
          else if (
            c.types.includes("locality") ||
            c.types.includes("postal_town") ||
            c.types.includes("administrative_area_level_2")
          ) {
            if (!cityVal) cityVal = c.long_name;
          } else if (c.types.includes("country")) {
            countryIso = (c.short_name || "").toUpperCase();
          }
        }
        const composed =
          place.formatted_address ??
          [route, streetNumber].filter(Boolean).join(" ");
        if (composed) setAddress(composed);
        if (cityVal) setCity(cityVal);
        if (countryIso) setCountry(countryIso);
        if (place.place_id) setPlaceId(place.place_id);
      });
      acRef.current = ac;
    }

    const w = window as unknown as { google?: typeof google };
    if (w.google?.maps?.places) {
      attach();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-google-maps="true"]',
    );
    if (existing) {
      existing.addEventListener("load", attach);
      return () => existing.removeEventListener("load", attach);
    }
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      apiKey,
    )}&libraries=places&language=${encodeURIComponent(locale)}`;
    script.async = true;
    script.defer = true;
    script.dataset.googleMaps = "true";
    script.onload = attach;
    document.head.appendChild(script);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      const w = window as unknown as { google?: typeof google };
      if (acRef.current && w.google?.maps?.event) {
        w.google.maps.event.clearInstanceListeners(acRef.current);
        acRef.current = null;
      }
    };
  }, []);

  const fieldCls =
    "mt-1 w-full h-11 rounded-xl border border-hairline bg-bone px-3 text-sm focus:outline-none focus:border-ink";
  const labelCls =
    "font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted";

  return (
    <div className="space-y-3">
      <label className="block">
        <span className={labelCls}>{labelAddress}</span>
        <input
          ref={addressRef}
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder={addressPlaceholder}
          required={required}
          autoComplete="off"
          {...(nameAddress ? { name: nameAddress } : {})}
          className={fieldCls}
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className={labelCls}>{labelCity}</span>
          <input
            type="text"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder={cityPlaceholder}
            required={required}
            {...(nameCity ? { name: nameCity } : {})}
            className={fieldCls}
          />
        </label>
        <label className="block">
          <span className={labelCls}>{labelCountry}</span>
          <select
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            required={required || requiredCountry}
            {...(nameCountry ? { name: nameCountry } : {})}
            className={fieldCls}
          >
            <option value="">{countryPlaceholder ?? "—"}</option>
            {options.map((code) => (
              <option key={code} value={code}>
                {countryLabel(code)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {/* Hidden inputs para formularios con server action (FormData). */}
      {nameCountryName && (
        <input type="hidden" name={nameCountryName} value={countryName} />
      )}
      {namePlaceId && (
        <input type="hidden" name={namePlaceId} value={placeId} />
      )}
    </div>
  );
}
