"use client";

import { useState } from "react";

type Role = "operator" | "mesero" | "kitchen" | "bar" | "terminal";

type User = {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  assignedTableNumbers: number[];
  createdAt: string | Date;
};

const ROLE_LABELS: Record<Role, string> = {
  operator: "Operador (dueño)",
  mesero: "Mesero",
  kitchen: "Cocina",
  bar: "Bar",
  terminal: "Datáfono",
};

const ROLE_TINTS: Record<Role, string> = {
  operator: "bg-terracotta/15 text-terracotta",
  mesero: "bg-ink/10 text-ink",
  kitchen: "bg-[#C98A2E]/15 text-[#8F6828]",
  bar: "bg-[#5B6FB2]/15 text-[#3F549B]",
  terminal: "bg-ok/15 text-ok",
};

export function UsuariosClient({
  initialUsers,
  currentUserId,
}: {
  initialUsers: User[];
  currentUserId?: string;
}) {
  const [users, setUsers] = useState<User[]>(initialUsers);
  const [showCreate, setShowCreate] = useState(false);

  function onCreated(u: User) {
    setUsers((prev) => [...prev, u]);
    setShowCreate(false);
  }
  function onUpdated(u: User) {
    setUsers((prev) => prev.map((x) => (x.id === u.id ? u : x)));
  }
  function onDeleted(id: string) {
    setUsers((prev) => prev.filter((x) => x.id !== id));
  }

  // Agrupados por rol para que el operador encuentre rápido.
  const grouped: Record<Role, User[]> = {
    operator: [],
    mesero: [],
    kitchen: [],
    bar: [],
    terminal: [],
  };
  for (const u of users) grouped[u.role].push(u);

  return (
    <div className="space-y-6">
      {/* Crear nuevo */}
      <div className="rounded-2xl border border-op-border bg-op-surface p-5">
        {showCreate ? (
          <CreateForm
            onCancel={() => setShowCreate(false)}
            onCreated={onCreated}
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="w-full h-11 rounded-full bg-ink text-bone text-sm font-medium hover:bg-ink/90"
          >
            + Nuevo usuario
          </button>
        )}
      </div>

      {/* Lista agrupada */}
      {(Object.keys(grouped) as Role[]).map((role) =>
        grouped[role].length > 0 ? (
          <div key={role} className="space-y-2">
            <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted px-1">
              {ROLE_LABELS[role]} · {grouped[role].length}
            </div>
            {grouped[role].map((u) => (
              <UserCard
                key={u.id}
                user={u}
                isSelf={u.id === currentUserId}
                onUpdated={onUpdated}
                onDeleted={onDeleted}
              />
            ))}
          </div>
        ) : null,
      )}

      {users.length === 0 && (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center">
          <div className="font-display text-lg mb-1">Aún no hay usuarios</div>
          <p className="text-sm text-op-muted">
            Agrega tu primer mesero, cocina o datáfono.
          </p>
        </div>
      )}
    </div>
  );
}

function CreateForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (u: User) => void;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("mesero");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const r = await fetch("/api/operator/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        name: name.trim() || undefined,
        password,
        role,
      }),
    });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setErr(j.message || j.error || "No se pudo crear");
      return;
    }
    const j = await r.json();
    onCreated(j.user as User);
    setEmail("");
    setName("");
    setPassword("");
    setRole("mesero");
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="font-display text-lg">Nuevo usuario</div>

      <Field label="Nombre">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Juan Pérez"
          maxLength={80}
          className={inputCls}
        />
      </Field>

      <Field label="Email" required>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="juan@restaurante.com"
          autoComplete="off"
          className={inputCls}
        />
      </Field>

      <Field label="Contraseña" required hint="Mínimo 6 caracteres">
        <input
          type="text"
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••"
          autoComplete="new-password"
          className={inputCls}
        />
      </Field>

      <Field label="Rol" required>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          className={inputCls}
        >
          <option value="mesero">Mesero</option>
          <option value="kitchen">Cocina</option>
          <option value="bar">Bar</option>
          <option value="terminal">Datáfono</option>
          <option value="operator">Operador (dueño)</option>
        </select>
      </Field>

      {err && <div className="text-xs text-danger">{err}</div>}

      <div className="flex items-center justify-end gap-3 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="h-10 px-4 rounded-full bg-op-bg border border-op-border text-sm font-medium hover:bg-op-surface"
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={busy}
          className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
        >
          {busy ? "Creando…" : "Crear"}
        </button>
      </div>
    </form>
  );
}

function UserCard({
  user,
  isSelf,
  onUpdated,
  onDeleted,
}: {
  user: User;
  isSelf: boolean;
  onUpdated: (u: User) => void;
  onDeleted: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user.name ?? "");
  const [email, setEmail] = useState(user.email);
  const [role, setRole] = useState<Role>(user.role);
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  const dirty =
    name !== (user.name ?? "") ||
    email !== user.email ||
    role !== user.role ||
    newPassword.length > 0;

  function reset() {
    setName(user.name ?? "");
    setEmail(user.email);
    setRole(user.role);
    setNewPassword("");
    setMsg(null);
  }

  async function save() {
    if (!dirty) return;
    setBusy(true);
    setMsg(null);
    const payload: {
      name?: string | null;
      email?: string;
      role?: Role;
      password?: string;
    } = {};
    if (name !== (user.name ?? "")) {
      payload.name = name.trim() || null;
    }
    if (email !== user.email) payload.email = email;
    if (role !== user.role) payload.role = role;
    if (newPassword.length > 0) payload.password = newPassword;

    const r = await fetch(`/api/operator/users/${user.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setMsg({ kind: "error", text: j.message || j.error || "No se pudo guardar" });
      return;
    }
    const j = await r.json();
    onUpdated(j.user as User);
    setNewPassword("");
    setMsg({ kind: "ok", text: "Guardado." });
    setEditing(false);
  }

  async function remove() {
    if (
      !confirm(
        `¿Eliminar a ${user.name || user.email}? Esta acción no se puede deshacer.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setMsg(null);
    const r = await fetch(`/api/operator/users/${user.id}`, {
      method: "DELETE",
    });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setMsg({ kind: "error", text: j.message || j.error || "No se pudo eliminar" });
      return;
    }
    onDeleted(user.id);
  }

  const displayName = user.name?.trim() || user.email;

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-5">
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
        <div className="min-w-0 flex items-center gap-2 flex-wrap">
          <div className="font-display text-lg truncate">{displayName}</div>
          {isSelf && (
            <span className="font-mono text-[9px] tracking-wider uppercase text-op-muted">
              (tú)
            </span>
          )}
        </div>
        <span
          className={
            "px-2.5 h-6 inline-flex items-center rounded-full text-[10px] font-medium " +
            ROLE_TINTS[user.role]
          }
        >
          {ROLE_LABELS[user.role]}
        </span>
      </div>

      {!editing ? (
        <>
          <div className="font-mono text-[11px] text-op-muted truncate mb-3">
            {user.email}
          </div>
          {user.role === "mesero" && user.assignedTableNumbers.length > 0 && (
            <div className="text-[11px] text-op-muted mb-3">
              Atiende mesas:{" "}
              <span className="font-mono">
                {user.assignedTableNumbers.join(", ")}
              </span>
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={remove}
              disabled={busy || isSelf}
              title={isSelf ? "No puedes eliminar tu propio usuario" : undefined}
              className="h-8 px-3 rounded-full text-[11px] font-medium text-danger hover:bg-danger/10 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Eliminar
            </button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="h-8 px-3 rounded-full bg-op-bg border border-op-border text-[11px] font-medium hover:bg-op-surface"
            >
              Editar
            </button>
          </div>
        </>
      ) : (
        <div className="space-y-3">
          <Field label="Nombre">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              className={inputCls}
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="off"
              className={inputCls}
            />
          </Field>
          <Field
            label="Nueva contraseña"
            hint="Déjalo vacío para mantener la actual"
          >
            <input
              type="text"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="••••••"
              autoComplete="new-password"
              minLength={6}
              className={inputCls}
            />
          </Field>
          <Field label="Rol" hint={isSelf ? "No puedes cambiar tu propio rol" : undefined}>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              disabled={isSelf}
              className={inputCls + " disabled:opacity-60"}
            >
              <option value="mesero">Mesero</option>
              <option value="kitchen">Cocina</option>
              <option value="bar">Bar</option>
              <option value="terminal">Datáfono</option>
              <option value="operator">Operador (dueño)</option>
            </select>
          </Field>

          {msg && (
            <div
              className={
                "text-xs " + (msg.kind === "ok" ? "text-ok" : "text-danger")
              }
            >
              {msg.text}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                reset();
                setEditing(false);
              }}
              className="h-9 px-4 rounded-full bg-op-bg border border-op-border text-xs font-medium hover:bg-op-surface"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy || !dirty}
              className="h-9 px-5 rounded-full bg-ink text-bone text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? "Guardando…" : "Guardar"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
        {label}
        {required && <span className="text-danger ml-1">*</span>}
      </div>
      {children}
      {hint && <div className="text-[10px] text-op-muted mt-1">{hint}</div>}
    </label>
  );
}

const inputCls =
  "w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40";
