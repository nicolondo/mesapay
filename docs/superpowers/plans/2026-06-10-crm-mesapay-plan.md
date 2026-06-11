# CRM MESAPAY — Plan de implementación (Fases 1–4)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
> Spec aprobado: `docs/superpowers/specs/2026-06-10-crm-mesapay-design.md` (leerlo SIEMPRE primero).

**Goal:** CRM móvil-primero dentro de MESAPAY para comerciales y gerentes comerciales.
**Branch:** `feat/crm-mesapay`. **Gates por fase:** `npm test` verde · paridad i18n es/en/pt ·
`npm run lint` sin errores nuevos · `npm run build` · revisión móvil (clases responsive, bottom
sheets, tap targets ≥44px, paginación).

**Patrones canónicos del repo (leer antes de codear, NO reinventar):**
- Scoping/roles server-side: `src/app/comercial/page.tsx` + `src/lib/ai/scope.ts`.
- API admin con zod+audit: `src/app/api/admin/restaurants/[id]/salesrep/route.ts`.
- Bottom nav móvil PWA: layout del mesero (`src/app/mesero/` o grep "bottom nav"); manifest por
  rol: grep "manifest" (MP MESERO).
- Bottom sheets: grep "Sheet" en `src/app/t/[slug]` (CashSheet, etc.).
- Cifrado: `src/lib/crypto.ts` (encrypt/decrypt AES). Push: `src/lib/push.ts`.
- Uploads: `src/app/api/operator/uploads/route.ts`. Cron protegido: grep "cron" o "x-cron-secret"
  (recordatorios de vencimiento ya existen).
- i18n: SIEMPRE next-intl, claves en `messages/es.json` → en/pt con paridad; archivos nuevos al
  MIGRATED de `eslint.config.mjs`. Dinero/fechas: `@/lib/format` / `@/lib/bogota`.

⚠️ NUNCA `git add -A`/`.`/`-u` (árbol con cambios ajenos). ⚠️ NUNCA `prisma db push/migrate`
(solo `validate` + `generate`). Commits con paths explícitos. No push (lo hace el controlador).

---

## FASE 1 · Núcleo

### Tarea 1.1 — Schema completo
`prisma/schema.prisma`:
- `enum Role` + `gerente_comercial` (comentario: gerente de equipo comercial; ve y gestiona los
  comerciales con managerId=él y sus leads; además opera su propio pipeline).
- `User`: `countryCode String?`, `managerId String?`, relación self `manager User? @relation("SalesTeam", fields:[managerId], references:[id], onDelete:SetNull)` + `team User[] @relation("SalesTeam")` + relaciones inversas de los modelos CRM que lo referencien.
- `enum CrmStage { nuevo contactado demo_agendada demo_realizada propuesta_enviada negociacion ganado perdido }`
- Modelos (con relaciones e índices; campos exactos del spec §3): `CrmLead`, `CrmContact`,
  `CrmActivity`, `CrmAppointment`, `CrmDocument`, `CrmEmailTemplate` (attachmentIds String[]),
  `CrmEmailAccount`, `CrmCountry`, `CrmCity`.
  - `CrmLead.stage CrmStage @default(nuevo)`; `priority String @default("b")`;
    `assignedTo User @relation("CrmAssigned"...)`; `createdBy User @relation("CrmCreated"...)`;
    `restaurantId String?` (+relación a Restaurant, SetNull); índices del spec.
  - `CrmActivity.type String` (note|call|whatsapp|email|visit|stage_change|appointment).
  - `CrmAppointment.status String @default("scheduled")` (scheduled|done|cancelled).
  - `CrmDocument.scope String @default("global")`; `CrmEmailTemplate.scope` igual.
`npx prisma validate && npx prisma generate`. Commit: `schema(crm): modelos núcleo + rol gerente_comercial`.

### Tarea 1.2 — Datasets de ciudades + helpers puros (TDD)
- `src/data/cities/co.json` y `mx.json`: `{ "country": "CO", "main": ["Bogotá","Medellín","Cali","Barranquilla","Cartagena"], "cities": ["..."] }`.
  Obtener listas COMPLETAS de municipios (CO: DANE ~1.120; MX: INEGI ~2.470) descargando un
  dataset público con WebFetch (hay datasets en GitHub raw, datos.gov.co, etc.). Si no se logra
  una fuente completa confiable, fallback: lista curada de ≥150 ciudades por país (las de
  cualquier relevancia comercial) y anotar en el JSON `"complete": false`. Para MX main:
  ["Ciudad de México","Guadalajara","Monterrey","Puebla","Tijuana"].
- `src/lib/crm/phone.ts` + test: `normalizePhone(raw, countryCode)` → E.164 (+57/+52; si ya trae
  +código se respeta; strip de no-dígitos; null si <7 dígitos) y `waLink(e164)` → `https://wa.me/<digits>`.
- `src/lib/crm/cityOrder.ts` + test: `orderCities(cities, mainNames)` → main primero (en el orden
  dado), resto alfabético es-CO (localeCompare con sensitivity base).
- `src/lib/crm/scope.ts` + test: `crmVisibleUserIds(user:{id,role,…}, teamIds:string[])` →
  comercial:[id] · gerente:[id,...teamIds] · platform_admin:null (sin filtro). Test puro.
- `src/lib/crm/dupes.ts` + test: `normalizeLeadName(s)` (lower, sin acentos, sin sufijos s.a.s/restaurante) para detección de duplicados.
Commit: `feat(crm): datasets ciudades + helpers puros (tested)`.

### Tarea 1.3 — Países/ciudades: config admin + seeding
- `GET/POST /api/admin/crm/countries` (platform_admin): GET lista países del dataset con
  enabled; POST `{code, enabled}` → upsert `CrmCountry`; al habilitar, sembrar `CrmCity` desde el
  JSON (skipDuplicates), marcando `isMain`. Audit.
- `GET /api/crm/cities?country=CO&q=` (roles crm): devuelve hasta 50 ciudades: las isMain primero,
  luego match alfabético de `q`. Para el form.
- UI admin: card "CRM · Países" en `/admin/configuracion` (o página `/admin/crm` si no existe un
  lugar natural — seguir el patrón de cards existente), toggle por país + contador de ciudades.
Commit: `feat(crm): países y ciudades configurables con seeding`.

### Tarea 1.4 — API leads + contactos (scoping + duplicados + import)
`src/lib/crm/access.ts`: helper server `getCrmContext(session)` → rol crm válido
(comercial|gerente_comercial|platform_admin), `visibleUserIds` (gerente: query team), país del
usuario. 403 si no aplica.
- `GET/POST /api/crm/leads`: GET con filtros (stage, q, assignedTo dentro del scope, paginación
  cursor `take 30`); POST crea (zod), `assignedToUserId=session` (gerente/admin pueden pasar otro
  DENTRO de su scope), país: si `user.countryCode` → forzado server-side; teléfono del contacto
  principal normalizado; warning de duplicados: si `?checkDupes=1` retorna posibles antes de crear
  (por normalizeLeadName o phone en scope visible).
- `GET/PATCH /api/crm/leads/[id]`: solo si `assignedToUserId ∈ visibleUserIds`. PATCH campos +
  `stage` (si pasa a `perdido` exige lostReason; si `ganado` → ver Fase 4); cambio de etapa
  registra `CrmActivity stage_change`; `nextActionAt` editable. Reasignar: solo gerente/admin
  dentro de scope, audit.
- `POST /api/crm/leads/[id]/contacts` + `PATCH/DELETE /api/crm/contacts/[id]` (scope vía lead).
- `POST /api/crm/leads/[id]/activities`: crea nota/llamada/whatsapp/visita (+ actualiza
  `lastActivityAt`, opcional `nextActionAt`).
- `POST /api/crm/import`: CSV (multipart o texto) columnas nombre,ciudad,telefono,email,zona,
  prioridad,notas → crea leads asignados al usuario; reporta creados/saltados(duplicados).
Tests puros donde aplique (parsing CSV mínimo). Commit: `feat(crm): API leads/contactos/actividades con scoping + import`.

### Tarea 1.5 — UI núcleo móvil-primero
Bajo `/comercial` (el layout existente se expande):
- **Shell**: bottom nav fija (Hoy[placeholder F2] · Pipeline · Calendario[placeholder F2] · Más)
  visible <1024px; sidebar simple en desktop. Manifest PWA "MP COMERCIAL" siguiendo el patrón
  por-rol existente. Tap targets ≥44px. El home actual de comisiones pasa a vivir en "Más →
  Mis comisiones" (ruta existente intacta, solo se enlaza).
- **Pipeline** `/comercial/crm`: móvil = chips de etapa scrolleables + lista paginada (cursor);
  desktop ≥1024px = kanban simple por columnas. Card de lead: nombre, ciudad, prioridad,
  botones WhatsApp/llamar (wa.me / tel:), tiempo desde última actividad. FAB "+".
- **Crear lead** (bottom sheet o página móvil): nombre, teléfono (inputmode=tel, prefijo país),
  ciudad (combobox: 5 main primero + búsqueda server), país bloqueado si user.countryCode,
  prioridad. Al guardar con posible duplicado → confirmación.
- **Ficha de lead** `/comercial/crm/[id]`: header con etapa (bottom sheet para cambiarla),
  contactos (cards con acciones wa/tel/mail, agregar contacto), timeline (actividades, paginado),
  agregar nota/actividad rápida + setear "próxima acción" (fecha), datos del comercio (editar).
  Click en WhatsApp registra activity type whatsapp (POST fire-and-forget) y abre wa.me.
- **Equipo (gerente)** `/comercial/equipo`: lista de su equipo (crear comercial — reusar el
  endpoint POST /api/admin/users? NO: ese es platform_admin. Crear
  `POST /api/crm/team` (gerente_comercial): crea User role comercial con managerId=él,
  countryCode, commissionBps; PATCH para editar/desactivar — gates: solo su equipo, audit) +
  selector "ver leads de X" en el pipeline.
- i18n namespace `crm` (es→en/pt paridad) + MIGRATED globs.
Commit(s): `feat(crm): shell móvil + pipeline`, `feat(crm): ficha de lead + timeline`,
`feat(crm): equipo del gerente`.

### Gate Fase 1 + review de fase.

---

## FASE 2 · Enfoque

### Tarea 2.1 — Pantalla "Hoy" `/comercial/hoy` (nuevo home del CRM)
Server component con 4 bandejas (todas dentro del scope, cada una `take 20` + contador):
1. Sin contactar: stage=nuevo y sin actividades.
2. Esperando respuesta: lastActivityAt < now-3d y stage ∈ contactado..negociacion (param N=3d
   constante por ahora).
3. Seguimientos vencidos: nextActionAt <= now.
4. Citas de hoy (CrmAppointment del día, tz America/Bogota).
Cards con acciones directas (wa/tel) y swipe-friendly. Bottom nav "Hoy" apunta aquí.

### Tarea 2.2 — Citas + calendario
- `GET/POST /api/crm/appointments` + `PATCH /api/crm/appointments/[id]` (scope por userId; gerente
  ve las del equipo). Crear desde la ficha del lead.
- `/comercial/calendario`: vista lista-por-día (móvil) + grilla semanal (desktop). Crear/editar
  en bottom sheet.
- Recordatorio push: `GET /api/cron/crm-reminders` (header x-cron-secret, mismo patrón cron
  existente): citas que empiezan en ≤30min sin remindedAt → push al userId (lib push existente)
  → marca remindedAt. Registrar también activity `appointment` al crear.
Commits por tarea. Gate Fase 2.

---

## FASE 3 · Correo

### Tarea 3.1 — Documentos
- `GET/POST /api/crm/documents` (+DELETE): sube vía patrón uploads existente (PDF/imagen ≤15MB),
  scope global (solo admin crea globales) o user. UI: "Más → Documentos" lista + subir (móvil ok).
### Tarea 3.2 — Cuenta de correo del comercial
- `CrmEmailAccount` CRUD `GET/PUT /api/crm/email-account` (propio usuario): smtpHost/Port/User +
  password → `encrypt()` AES. Botón "Enviar correo de prueba" (`POST .../test`) usando nodemailer
  (dependencia nueva: `npm i nodemailer @types/nodemailer` — commitear package.json+lock) →
  setea verifiedAt si OK. UI en "Más → Mi correo" con ayuda para Gmail app-password (i18n).
### Tarea 3.3 — Plantillas + envío
- `CrmEmailTemplate` CRUD (`/api/crm/templates`): subject/bodyHtml con variables {{nombre}}
  {{comercio}} {{ciudad}} {{comercial}}, adjuntos = ids de CrmDocument. scope global|user.
- `src/lib/crm/templateRender.ts` + test: render de variables (escape básico).
- `POST /api/crm/leads/[id]/send-email`: { templateId|subject+body, contactId } → valida cuenta
  verificada, render, adjuntos desde fileUrl, envía nodemailer desde la cuenta del comercial,
  registra CrmActivity email (meta: subject, to). Errores SMTP → mensaje claro.
- UI: desde la ficha → "Enviar plantilla" (sheet: elegir plantilla+contacto, preview).
Gate Fase 3.

---

## FASE 4 · Cierre

### Tarea 4.1 — Ganado → restaurante + comisión
Al pasar a `ganado` (PATCH stage): sheet/flow "Crear restaurante": nombre, slug (sugerido), plan,
mensualidad → `POST /api/crm/leads/[id]/convert` (gerente o admin… decisión: también comercial,
auditado): crea Restaurant (campos mínimos + country/city del lead), setea
`salesRepUserId = lead.assignedToUserId`, guarda `lead.restaurantId`, activity stage_change.
Si ya existe restaurante vinculado → solo linkear. Reusar lógica/validaciones del registro de
restaurantes existente (grep registerRestaurant).
### Tarea 4.2 — Métricas del gerente
`/comercial/equipo` suma tarjetas por comercial (rango 30d): leads nuevos, contactados (≥1
activity), demos (stage alcanzó demo_*), ganados, tasa conversión, tiempo medio 1ª respuesta
(createdAt→primera activity). Queries agregadas server-side.
### Tarea 4.3 — Export + migración Kommo
- `GET /api/crm/leads/export` (CSV del scope, audit).
- `scripts/crm_migrate_kommo.py`: usa el cliente de `~/.claude/skills/kommo-crm/scripts`
  (KommoClient) para leer leads+contactos+notas+etapa y POSTear al CRM vía API local con un
  token admin (o inserción directa con prisma vía `npx tsx scripts/crm_migrate_kommo.ts` —
  elegir lo más simple: script TS con Prisma directo, mapeando etapas Kommo→CrmStage y
  asignación por "Comercial asignado"). NO ejecutarlo contra prod en el build (solo dejarlo listo).
Gate Fase 4 + review final integral.

---

## Verificación final (después de Fase 4)
1. `npm test` (todos los suites) · paridad i18n · lint sin nuevos · build.
2. Reviewer integral (seguridad scoping multi-rol, money-adjacent: ninguna, SMTP secrets, mobile).
3. PR único `feat/crm-mesapay` → main con changelog por fase. SIN merge (espera aprobación).
