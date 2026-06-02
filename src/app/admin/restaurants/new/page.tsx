import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { registerRestaurant } from "@/lib/registerRestaurant";

async function submit(formData: FormData) {
  "use server";
  const t = await getTranslations("opAdmin");
  const session = await auth();
  if (session?.user?.role !== "platform_admin") {
    redirect(
      "/admin/restaurants/new?err=" + encodeURIComponent(t("errNotAuthorized")),
    );
  }

  const restaurantName = String(formData.get("restaurantName") ?? "").trim();
  const restaurantSlug = String(formData.get("restaurantSlug") ?? "").trim();
  const ownerName = String(formData.get("ownerName") ?? "").trim();
  const ownerEmail = String(formData.get("ownerEmail") ?? "").trim();
  const ownerPassword = String(formData.get("ownerPassword") ?? "");

  if (
    !restaurantName ||
    !restaurantSlug ||
    !ownerName ||
    !ownerEmail ||
    ownerPassword.length < 6
  ) {
    redirect(
      "/admin/restaurants/new?err=" +
        encodeURIComponent(t("errFillAllFields")),
    );
  }

  const res = await registerRestaurant({
    restaurantName,
    restaurantSlug,
    ownerName,
    ownerEmail,
    ownerPassword,
  });
  if (!res.ok) {
    redirect("/admin/restaurants/new?err=" + encodeURIComponent(res.error));
  }
  redirect(
    "/admin/restaurants?ok=" + encodeURIComponent(res.restaurantSlug),
  );
}

export default async function NewRestaurantPage({
  searchParams,
}: {
  searchParams: Promise<{ err?: string; ok?: string }>;
}) {
  const sp = await searchParams;
  const t = await getTranslations("opAdmin");

  return (
    <div className="flex-1 p-6 max-w-2xl mx-auto w-full">
      <Link
        href="/admin/restaurants"
        className="font-mono text-[10px] tracking-wider uppercase text-op-muted hover:text-op-text"
      >
        {t("detailBack")}
      </Link>
      <div className="font-display text-3xl mt-2 mb-1">{t("newTitle")}</div>
      <div className="text-sm text-op-muted mb-6">
        {t("newIntro")}
      </div>

      {sp.err && (
        <div className="mb-4 rounded-lg border border-danger/30 bg-danger/10 text-danger px-3 py-2 text-sm">
          {sp.err}
        </div>
      )}

      <form
        action={submit}
        className="bg-op-surface border border-op-border rounded-2xl p-6 space-y-4"
      >
        <Field label={t("fieldRestaurantName")} name="restaurantName" required />
        <div>
          <Field
            label={t("fieldSlug")}
            name="restaurantSlug"
            required
            hint={t("fieldSlugHint")}
          />
        </div>

        <div className="h-px bg-op-border my-6" />

        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-op-muted">
          {t("ownerSection")}
        </div>
        <Field label={t("fieldFullName")} name="ownerName" required />
        <Field label={t("fieldEmail")} name="ownerEmail" type="email" required />
        <Field
          label={t("fieldInitialPassword")}
          name="ownerPassword"
          type="text"
          required
          hint={t("fieldInitialPasswordHint")}
        />

        <div className="pt-2 flex gap-2">
          <button
            type="submit"
            className="flex-1 h-11 rounded-xl bg-ink text-bone text-sm font-medium"
          >
            {t("createRestaurant")}
          </button>
          <Link
            href="/admin/restaurants"
            className="h-11 px-4 rounded-xl border border-op-border text-sm inline-flex items-center"
          >
            {t("cancel")}
          </Link>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  name,
  type = "text",
  required,
  hint,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
        {label}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        className="mt-1 w-full h-11 px-3 rounded-lg border border-op-border bg-op-bg focus:outline-none focus:border-terracotta"
      />
      {hint && (
        <span className="block mt-1 text-xs text-op-muted">{hint}</span>
      )}
    </label>
  );
}

