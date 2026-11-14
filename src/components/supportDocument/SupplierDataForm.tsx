"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { MunicipioAutocomplete } from "@/components/MunicipioAutocomplete";
import { DIAN_COUNTRIES } from "@/lib/dian/supportDocument/countries";
import { inputCls, labelCls, type ApiError, type SupportDocSupplierView } from "./shared";

/**
 * Datos del VENDEDOR que exige la DIAN para el documento soporte. Se guardan
 * en el proveedor (sirven para todos sus gastos y compras). Residente:
 * documento (se informa como NIT, con DV calculado), municipio DANE, código
 * postal y dirección. No residente: país, ciudad y documento.
 */
export function SupplierDataForm({
  supplier,
  onSaved,
  onCancel,
}: {
  supplier: SupportDocSupplierView;
  onSaved: (s: SupportDocSupplierView) => void;
  onCancel?: () => void;
}) {
  const t = useTranslations("opSupportDoc");
  // Abrir el formulario ya es decir "a este proveedor se le genera documento
  // soporte"; se puede desmarcar si fue un error.
  const [notObligated, setNotObligated] = useState(true);
  const [name, setName] = useState(supplier.name);
  const [personType, setPersonType] = useState(supplier.personType ?? "");
  const [taxIdType, setTaxIdType] = useState(supplier.taxIdType ?? "CC");
  const [taxId, setTaxId] = useState(supplier.taxId ?? "");
  const [resident, setResident] = useState(!supplier.countryCode);
  const [city, setCity] = useState<{ code: string; label?: string | null } | null>(
    supplier.cityCode ? { code: supplier.cityCode, label: supplier.cityLabel } : null,
  );
  const [postalCode, setPostalCode] = useState(supplier.postalCode ?? "");
  const [address, setAddress] = useState(supplier.address ?? "");
  const [countryCode, setCountryCode] = useState(supplier.countryCode ?? "US");
  const [foreignCity, setForeignCity] = useState(supplier.foreignCityName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/operator/support-documents/suppliers/${supplier.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notObligatedToInvoice: notObligated,
          name: name.trim(),
          personType: personType || null,
          taxIdType,
          taxId: taxId.trim() || null,
          address: address.trim() || null,
          cityCode: resident ? (city?.code ?? null) : null,
          postalCode: resident ? postalCode.trim() || null : null,
          countryCode: resident ? null : countryCode,
          foreignCityName: resident ? null : foreignCity.trim() || null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as ApiError & { supplier?: SupportDocSupplierView };
      if (!res.ok || !data.supplier) {
        setError(data.detail?.includes("name_taken") ? t("errors.name_taken") : t("errors.supplier_form"));
        return;
      }
      onSaved(data.supplier);
    } catch {
      setError(t("errors.network"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-op-border bg-op-bg p-4 space-y-3">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={notObligated}
          onChange={(e) => setNotObligated(e.target.checked)}
        />
        <span>{t("supplierFlagLabel")}</span>
      </label>

      <div>
        <label className={labelCls} htmlFor="ds-name">{t("fieldName")}</label>
        <input id="ds-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={labelCls} htmlFor="ds-person">{t("fieldPersonType")}</label>
          <select id="ds-person" className={inputCls} value={personType} onChange={(e) => setPersonType(e.target.value)}>
            <option value="">{t("choose")}</option>
            <option value="natural">{t("personNatural")}</option>
            <option value="juridica">{t("personJuridica")}</option>
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="ds-residency">{t("fieldResidency")}</label>
          <select
            id="ds-residency"
            className={inputCls}
            value={resident ? "co" : "abroad"}
            onChange={(e) => setResident(e.target.value === "co")}
          >
            <option value="co">{t("resident")}</option>
            <option value="abroad">{t("nonResident")}</option>
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="ds-doctype">{t("fieldDocType")}</label>
          <select id="ds-doctype" className={inputCls} value={taxIdType} onChange={(e) => setTaxIdType(e.target.value)}>
            <option value="CC">{t("docCC")}</option>
            <option value="NIT">{t("docNIT")}</option>
            <option value="CE">{t("docCE")}</option>
            <option value="PA">{t("docPA")}</option>
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="ds-doc">{t("fieldDocNumber")}</label>
          <input id="ds-doc" className={inputCls} value={taxId} onChange={(e) => setTaxId(e.target.value)} />
        </div>
      </div>
      {resident && <p className="text-[11px] text-op-muted -mt-1">{t("fieldDocNumberHint")}</p>}

      {resident ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <span className={labelCls}>{t("fieldCity")}</span>
            <MunicipioAutocomplete
              placeholder={t("fieldCityPlaceholder")}
              value={city}
              onChange={(m) => setCity(m ? { code: m.code, label: m.label } : null)}
              inputClassName={inputCls}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="ds-postal">{t("fieldPostalCode")}</label>
            <input
              id="ds-postal"
              inputMode="numeric"
              maxLength={6}
              className={inputCls}
              value={postalCode}
              onChange={(e) => setPostalCode(e.target.value.replace(/\D/g, ""))}
            />
            <p className="text-[11px] text-op-muted mt-1">{t("fieldPostalHint")}</p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls} htmlFor="ds-country">{t("fieldCountry")}</label>
            <select id="ds-country" className={inputCls} value={countryCode} onChange={(e) => setCountryCode(e.target.value)}>
              {DIAN_COUNTRIES.filter((c) => c.code !== "CO").map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="ds-fcity">{t("fieldForeignCity")}</label>
            <input id="ds-fcity" className={inputCls} value={foreignCity} onChange={(e) => setForeignCity(e.target.value)} />
          </div>
        </div>
      )}

      <div>
        <label className={labelCls} htmlFor="ds-address">{t("fieldAddress")}</label>
        <input id="ds-address" className={inputCls} value={address} onChange={(e) => setAddress(e.target.value)} />
        <p className="text-[11px] text-op-muted mt-1">{t("fieldAddressHint")}</p>
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button type="button" className="mp-btn mp-btn--ghost mp-btn--sm" onClick={onCancel} disabled={busy}>
            {t("cancel")}
          </button>
        )}
        <button type="button" className="mp-btn mp-btn--primary mp-btn--sm" onClick={save} disabled={busy || !name.trim()}>
          {busy ? t("saving") : t("saveSupplier")}
        </button>
      </div>
    </div>
  );
}
