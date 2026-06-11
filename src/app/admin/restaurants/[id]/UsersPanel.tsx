"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

type Role = "operator" | "terminal" | "mesero" | "kitchen" | "bar" | "comercial";
type User = {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  createdAt: string;
};

const ROLE_TINT: Record<Role, string> = {
  operator: "bg-terracotta/15 text-terracotta",
  terminal: "bg-ink/15 text-ink",
  mesero: "bg-[#2E6B4C]/15 text-[#1E5339]",
  kitchen: "bg-[#C98A2E]/15 text-[#8F6828]",
  bar: "bg-[#7C4A8A]/15 text-[#5C3568]",
  comercial: "bg-[#1A5FAD]/15 text-[#1A5FAD]",
};

export function UsersPanel({
  restaurantId,
  initialUsers,
}: {
  restaurantId: string;
  initialUsers: User[];
}) {
  const t = useTranslations("opAdmin");
  const ROLE_LABEL: Record<Role, string> = {
    operator: t("roleOperator"),
    terminal: t("roleTerminal"),
    mesero: t("roleMesero"),
    kitchen: t("roleKitchen"),
    bar: t("roleBar"),
    comercial: t("roleComercial"),
  };
  const router = useRouter();
  const [, startTx] = useTransition();
  const [users, setUsers] = useState<User[]>(initialUsers);
  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("operator");
  // comercial users are global (no restaurant). We still pass restaurantId
  // in the body but the API ignores it for global roles.

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Acciones por usuario: cambiar contraseña inline + enviar reset por correo
  const [pwdFor, setPwdFor] = useState<string | null>(null);
  const [pwdValue, setPwdValue] = useState("");
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ userId: string; msg: string; ok: boolean } | null>(null);

  async function savePassword(id: string) {
    setRowBusy(id);
    setNotice(null);
    const res = await fetch(`/api/admin/users/${id}/password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: pwdValue }),
    });
    setRowBusy(null);
    if (!res.ok) {
      setNotice({ userId: id, msg: t("usersPwdFailed"), ok: false });
      return;
    }
    setPwdFor(null);
    setPwdValue("");
    setNotice({ userId: id, msg: t("usersPwdSaved"), ok: true });
  }

  async function sendReset(id: string, userEmail: string) {
    if (!confirm(t("usersResetConfirm", { email: userEmail }))) return;
    setRowBusy(id);
    setNotice(null);
    const res = await fetch(`/api/admin/users/${id}/reset-email`, { method: "POST" });
    const j = await res.json().catch(() => ({}));
    setRowBusy(null);
    if (!res.ok || !j.sent) {
      setNotice({ userId: id, msg: t("usersResetFailed"), ok: false });
      return;
    }
    setNotice({ userId: id, msg: t("usersResetSent"), ok: true });
  }

  async function createUser() {
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: email.trim(),
        name: name.trim() || undefined,
        password,
        role,
        restaurantId,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(humanError(j, t));
      return;
    }
    const j = await res.json();
    setUsers((u) => [...u, { ...j.user, createdAt: j.user.createdAt }]);
    setEmail("");
    setName("");
    setPassword("");
    setRole("operator");
    setShowForm(false);
    startTx(() => router.refresh());
  }

  async function deleteUser(id: string, label: string) {
    if (!confirm(t("usersDeleteConfirm", { label }))) return;
    const res = await fetch(`/api/admin/users/${id}`, { method: "DELETE" });
    if (!res.ok) {
      alert(t("usersDeleteFailed"));
      return;
    }
    setUsers((u) => u.filter((x) => x.id !== id));
    startTx(() => router.refresh());
  }

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
          {t("usersTitle")}
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="h-7 px-3 rounded-full bg-ink text-bone text-[11px] font-medium"
        >
          {showForm ? t("usersClose") : t("usersCreate")}
        </button>
      </div>

      {users.length === 0 ? (
        <div className="text-sm text-op-muted">{t("usersNone")}</div>
      ) : (
        <ul className="divide-y divide-op-border">
          {users.map((u) => (
            <li key={u.id} className="py-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <div className="font-medium truncate">
                      {u.name ?? u.email}
                    </div>
                    <span
                      className={
                        "px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium " +
                        ROLE_TINT[u.role as Role]
                      }
                    >
                      {ROLE_LABEL[u.role as Role]}
                    </span>
                  </div>
                  <div className="font-mono text-[11px] text-op-muted truncate">
                    {u.email}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      setPwdFor(pwdFor === u.id ? null : u.id);
                      setPwdValue("");
                      setNotice(null);
                    }}
                    className="text-[11px] text-op-muted hover:text-op-text hover:underline"
                  >
                    {t("usersPwdBtn")}
                  </button>
                  <button
                    type="button"
                    onClick={() => sendReset(u.id, u.email)}
                    disabled={rowBusy === u.id}
                    className="text-[11px] text-op-muted hover:text-op-text hover:underline disabled:opacity-50"
                  >
                    {t("usersResetBtn")}
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteUser(u.id, u.name ?? u.email)}
                    className="text-[11px] text-danger hover:underline"
                  >
                    {t("usersDelete")}
                  </button>
                </div>
              </div>
              {pwdFor === u.id && (
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="password"
                    value={pwdValue}
                    onChange={(e) => setPwdValue(e.target.value)}
                    placeholder={t("usersPwdPlaceholder")}
                    autoComplete="new-password"
                    className="h-9 px-3 rounded-lg border border-op-border bg-op-bg text-sm flex-1 max-w-xs focus:outline-none focus:border-terracotta"
                  />
                  <button
                    type="button"
                    onClick={() => savePassword(u.id)}
                    disabled={pwdValue.length < 8 || rowBusy === u.id}
                    className="h-9 px-4 rounded-full bg-ink text-bone text-[11px] font-medium disabled:opacity-50"
                  >
                    {t("usersPwdSave")}
                  </button>
                </div>
              )}
              {notice?.userId === u.id && (
                <div className={"mt-1 text-[11px] " + (notice.ok ? "text-[#1E5339]" : "text-danger")}>
                  {notice.msg}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {showForm && (
        <div className="mt-4 pt-4 border-t border-op-border space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label={t("userFieldEmail")} value={email} onChange={setEmail} type="email" />
            <Field label={t("userFieldName")} value={name} onChange={setName} />
            <Field
              label={t("userFieldPassword")}
              value={password}
              onChange={setPassword}
              type="password"
            />
            <label className="block">
              <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
                {t("userFieldRole")}
              </span>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                className="mt-1 w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
              >
                <option value="operator">{t("roleOperatorOption")}</option>
                <option value="mesero">{t("roleMeseroOption")}</option>
                <option value="kitchen">{t("roleKitchenOption")}</option>
                <option value="bar">{t("roleBarOption")}</option>
                <option value="terminal">{t("roleTerminalOption")}</option>
                {/* comercial is a global role — created from /admin/comisiones */}
              </select>
            </label>
          </div>
          {err && <div className="text-danger text-sm">{err}</div>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={createUser}
              disabled={
                busy ||
                !email.trim() ||
                password.length < 8 ||
                !role
              }
              className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-50"
            >
              {busy ? t("creating") : t("createUser")}
            </button>
            <span className="text-[11px] text-op-muted">
              {t("userSigninHint")}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
        {label}
      </span>
      <input
        type={type ?? "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta"
      />
    </label>
  );
}

function humanError(
  j: { error?: string },
  t: ReturnType<typeof useTranslations<"opAdmin">>,
): string {
  switch (j.error) {
    case "email_taken":
      return t("errEmailTaken");
    case "restaurant_required":
      return t("errRestaurantRequired");
    case "restaurant_not_found":
      return t("errRestaurantNotFound");
    default:
      return j.error ?? t("errCreateUser");
  }
}
