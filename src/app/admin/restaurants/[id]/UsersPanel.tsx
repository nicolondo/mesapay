"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Role = "operator" | "terminal" | "mesero" | "kitchen" | "bar";
type User = {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  createdAt: string;
};

const ROLE_LABEL: Record<Role, string> = {
  operator: "Operador",
  terminal: "Datáfono",
  mesero: "Mesero",
  kitchen: "Cocina",
  bar: "Bar",
};
const ROLE_TINT: Record<Role, string> = {
  operator: "bg-terracotta/15 text-terracotta",
  terminal: "bg-ink/15 text-ink",
  mesero: "bg-[#2E6B4C]/15 text-[#1E5339]",
  kitchen: "bg-[#C98A2E]/15 text-[#8F6828]",
  bar: "bg-[#7C4A8A]/15 text-[#5C3568]",
};

export function UsersPanel({
  restaurantId,
  initialUsers,
}: {
  restaurantId: string;
  initialUsers: User[];
}) {
  const router = useRouter();
  const [, startTx] = useTransition();
  const [users, setUsers] = useState<User[]>(initialUsers);
  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("operator");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
      setErr(humanError(j));
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
    if (!confirm(`¿Eliminar a ${label}? No podrá volver a iniciar sesión.`))
      return;
    const res = await fetch(`/api/admin/users/${id}`, { method: "DELETE" });
    if (!res.ok) {
      alert("No pudimos eliminar el usuario.");
      return;
    }
    setUsers((u) => u.filter((x) => x.id !== id));
    startTx(() => router.refresh());
  }

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
          Usuarios
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="h-7 px-3 rounded-full bg-ink text-bone text-[11px] font-medium"
        >
          {showForm ? "Cerrar" : "+ Crear usuario"}
        </button>
      </div>

      {users.length === 0 ? (
        <div className="text-sm text-op-muted">Sin usuarios asignados.</div>
      ) : (
        <ul className="divide-y divide-op-border">
          {users.map((u) => (
            <li
              key={u.id}
              className="py-2 flex items-center justify-between gap-3 text-sm"
            >
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
              <button
                type="button"
                onClick={() => deleteUser(u.id, u.name ?? u.email)}
                className="text-[11px] text-danger hover:underline shrink-0"
              >
                Eliminar
              </button>
            </li>
          ))}
        </ul>
      )}

      {showForm && (
        <div className="mt-4 pt-4 border-t border-op-border space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Email" value={email} onChange={setEmail} type="email" />
            <Field label="Nombre" value={name} onChange={setName} />
            <Field
              label="Contraseña (mínimo 8)"
              value={password}
              onChange={setPassword}
              type="password"
            />
            <label className="block">
              <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
                Rol
              </span>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                className="mt-1 w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
              >
                <option value="operator">
                  Operador — acceso completo (cocina, salón, menú, configuración…)
                </option>
                <option value="mesero">
                  Mesero — app móvil con bottom-nav (Salón / Cobros / Mesas)
                </option>
                <option value="kitchen">
                  Cocina — solo el tablero de cocina, sin nav
                </option>
                <option value="bar">
                  Bar — solo el tablero del bar, sin nav
                </option>
                <option value="terminal">
                  Datáfono — grilla de mesas para cobrar con Smart POS
                </option>
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
              {busy ? "Creando…" : "Crear usuario"}
            </button>
            <span className="text-[11px] text-op-muted">
              El usuario podrá iniciar sesión en /signin con estos datos.
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

function humanError(j: { error?: string }): string {
  switch (j.error) {
    case "email_taken":
      return "Ese email ya está registrado.";
    case "restaurant_required":
      return "Faltó el restaurante.";
    case "restaurant_not_found":
      return "El restaurante no existe.";
    default:
      return j.error ?? "No pudimos crear el usuario.";
  }
}
