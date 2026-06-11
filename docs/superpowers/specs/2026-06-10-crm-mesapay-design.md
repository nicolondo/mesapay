# CRM MESAPAY — diseño (a la medida, dentro de la app)

**Fecha:** 2026-06-10 · **Estado:** presentado a Nicolás, pendiente de aprobación final
**Decisión previa:** se descartó seguir en Kommo a largo plazo; el CRM propio se justifica porque
cierra el loop *lead → ganado → restaurante creado → comisión recurrente automática* (módulo de
comisiones ya en producción) y porque el flujo comercial de MESAPAY es muy específico.

## 1 · Principios

- **Dentro de MESAPAY**: mismo Next.js/Prisma/auth. Reusa: roles (`comercial` ya existe), portal
  `/comercial`, auditoría (`recordAuditEvent`), push PWA, uploads, cifrado AES (`src/lib/crypto.ts`),
  i18n es/en/pt (obligatorio).
- **Simple**: 4 pantallas. Crear un lead toma <30 segundos. La home dice qué hacer hoy.
- **Scope server-side innegociable**: comercial ve solo lo suyo; gerente ve su equipo; admin todo.
  Mismo patrón blindado del módulo de comisiones.

## 2 · Roles y jerarquía

- `comercial` (existe): sus leads, sus citas, sus comisiones.
- **`gerente_comercial` (nuevo)** + `User.managerId String?`: ve/reasigna leads de su equipo
  (`managerId = él`), crea/edita/desactiva comerciales SOLO de su equipo, y además opera su propio
  pipeline como un comercial normal. Jerarquía de exactamente 2 niveles (YAGNI).
- `platform_admin`: todo + configuración global.
- `User.countryCode String?`: país del comercial → al crear lead, el país queda bloqueado a ese.
  Gerente/admin eligen entre países activos.

## 3 · Modelo de datos (Prisma)

```
CrmLead       { id, name, countryCode, cityId?, address?, zone?, businessType?,
                stage (enum abajo), priority (a|b|c), source, planProposed?, unitsCount?,
                assignedToUserId (→User), createdByUserId, nextActionAt?, lastActivityAt?,
                lostReason?, notes?, restaurantId? (cuando se gana), createdAt, updatedAt
                @@index([assignedToUserId, stage]) @@index([assignedToUserId, nextActionAt]) }
CrmContact    { id, leadId, name, role?, phone? (E.164), email?, isPrimary, notes? }
CrmActivity   { id, leadId, userId, type (note|call|whatsapp|email|visit|stage_change|appointment),
                content, meta Json?, createdAt  @@index([leadId, createdAt]) }
CrmAppointment{ id, leadId, userId, title, startsAt, endsAt, notes?, remindedAt?, status }
CrmDocument   { id, name, fileUrl, mime, size, scope (global|user), ownerUserId?, createdAt }
CrmEmailTemplate { id, name, subject, bodyHtml (variables {{nombre}} {{comercio}} {{ciudad}}),
                attachmentIds (CrmDocument[]), scope (global|user), ownerUserId? }
CrmEmailAccount  { userId @unique, fromName, email, smtpHost, smtpPort, smtpUser,
                   smtpPassEnc (AES), verifiedAt? }
CrmCountry    { code @id (ISO-2), name, enabled }
CrmCity       { id, countryCode, name, isMain (top-5 del país), @@index([countryCode, name]) }
```

Etapas (enum `CrmStage`, espejo de Kommo validado): `nuevo → contactado → demo_agendada →
demo_realizada → propuesta_enviada → negociacion → ganado | perdido` (perdido exige `lostReason`).

## 4 · Requerimientos de Nicolás (verbatim → solución)

1. Comerciales con credenciales y vista restringida → portal `/comercial`, scope por sesión.
2. Gerentes con comerciales debajo + crear comerciales → rol `gerente_comercial` + `managerId`.
3. Teléfonos → link `https://wa.me/<E.164>` que abre WhatsApp; el clic registra CrmActivity
   tipo whatsapp.
4. Varios contactos por lead → `CrmContact` 1-N, uno principal.
5. Config de países; al activar se cargan todas las ciudades → `/admin` activa `CrmCountry` y
   siembra `CrmCity` desde dataset estático en el repo (CO ~1.120 municipios DANE,
   MX ~2.470 INEGI; países nuevos = agregar JSON).
6. Form de lead: 5 ciudades principales primero, resto alfabético → `isMain` + combobox con
   búsqueda. Principales por defecto — CO: Bogotá, Medellín, Cali, Barranquilla, Cartagena;
   MX: CDMX, Guadalajara, Monterrey, Puebla, Tijuana (editables por admin).
7. Comercial con país → campo país bloqueado en el form.
8. Visibilidad: comercial=propio, gerente=equipo → cláusulas where server-side, jamás del cliente.
9. Gerente también crea leads como comercial → su propio pipeline + tab "Mi equipo".
10. Lead creado queda asignado al creador → `assignedToUserId = session.user.id` por defecto;
    reasignación solo gerente (dentro del equipo) o admin, auditada.
11. Documentos + plantillas con adjuntos enviados DESDE el correo del comercial →
    `CrmDocument` + `CrmEmailTemplate` + `CrmEmailAccount` (SMTP por usuario, password cifrada
    AES, botón "probar envío"; Gmail requiere app-password — documentado en la UI). Envío con
    nodemailer; cada envío queda como CrmActivity email. Si no hay cuenta configurada, el CTA
    de enviar lleva a configurarla.
12. Calendario de citas → `CrmAppointment` + vista semana/mes + recordatorio push (infra PWA
    existente) ~30 min antes.
13. Visualización de pendientes/enfoque → pantalla **Hoy**: bandejas "Sin contactar" (stage
    nuevo sin actividades), "Esperando respuesta" (última actividad nuestra > N días sin
    respuesta registrada), "Seguimientos vencidos" (nextActionAt <= hoy), "Citas de hoy".
    `nextActionAt` se pide al cerrar cada actividad ("¿próximo paso?").

## 5 · Agregados para completitud (sin perder simpleza)

- Kanban de pipeline + lista filtrable. Timeline completo por lead.
- **Ganado → crear Restaurante** en MESAPAY con `salesRepUserId` = el comercial → comisiones
  automáticas (loop completo).
- Import CSV/Excel (los 46 prospectos de Medellín día 1) + **migración desde Kommo** vía API
  (leads, contactos, notas, etapas).
- Duplicados: warning al crear si nombre normalizado o teléfono ya existen (en el scope visible).
- Métricas de gerente: leads nuevos / contactados / demos / conversión / tiempo de primera
  respuesta, por comercial. Nada más en v1.
- Trilingüe, auditoría en reasignar/borrar/exportar.

## 5b · UX móvil — REQUISITO DE PRIMERA CLASE (pedido explícito de Nicolás)

Los comerciales pasan más tiempo en la calle que en oficina. **El CRM se diseña móvil-primero;
el desktop es la adaptación, no al revés.** Compromisos concretos (verificables en cada PR):

- **PWA instalable** "MP COMERCIAL" (mismo patrón que MP MESERO: manifest por rol, ícono,
  splash, push). El comercial la instala como app en su celular.
- **Bottom nav de 4 tabs** (zona del pulgar): Hoy · Pipeline · Calendario · Más.
  FAB "+" para crear lead rápido: nombre + teléfono + ciudad → listo (3 campos, <30 s).
- **Pipeline en móvil = lista con chips de etapa** (scroll horizontal de etapas arriba), NO
  kanban de columnas (no funciona en 390px). Kanban solo ≥1024px. Cambio de etapa por
  bottom sheet.
- **Acciones de contacto a un tap y con dedo grande**: fila de botones WhatsApp (`wa.me`),
  Llamar (`tel:`) y Correo en la card del lead y en la ficha. Tap targets ≥44px en todo el CRM.
- **Formularios móviles**: bottom sheets (patrón existente del repo), teclado numérico para
  teléfonos (`inputmode=tel`), combobox de ciudad con búsqueda optimizada táctil, prefijo
  telefónico automático según el país del lead.
- **Safe-areas y viewport**: reutilizar los fixes ya hechos para la PWA del mesero
  (safe-area-inset solo standalone, fix dvh first-paint).
- **Performance en red celular**: server components + paginación/scroll infinito en listas
  (nunca cargar todos los leads), skeletons, imágenes mínimas. La pantalla "Hoy" debe abrir
  útil en <2 s en 4G.
- **Gate de calidad por fase**: ningún PR del CRM se mergea sin revisión visual a 390px
  (viewport iPhone) de cada pantalla nueva. Es parte de la verificación, junto a test/lint/build.
- **Fuera de v1**: offline-first con sincronización (complejidad alta; los comerciales operan
  con datos móviles). La PWA degrada con un mensaje claro sin conexión. Candidato v2.

## 6 · Fuera de alcance v1 (explícito)

Automatizaciones/workflows, tracking de apertura, telefonía, scoring IA, >2 niveles de jerarquía,
campos custom, API pública, multi-empresa. v2 candidato: Pulso sobre el CRM.

## 7 · Fases (cada una un PR desplegable)

1. **Núcleo**: schema completo, rol gerente + managerId, países/ciudades + datasets + config
   admin, CRUD leads/contactos con scoping y país bloqueado, pipeline kanban/lista, wa.me links
   con registro de actividad, timeline/notas, import CSV, duplicados.
2. **Enfoque**: pantalla Hoy + nextActionAt, citas + calendario + push, reasignación de equipo.
3. **Correo**: documentos, plantillas con variables y adjuntos, CrmEmailAccount (SMTP cifrado +
   verificación), envío + log en timeline.
4. **Cierre**: ganado→crear restaurante→comisión, métricas de gerente, migración Kommo,
   export CSV.

## 8 · Decisiones técnicas y riesgos

- **SMTP por comercial**: nodemailer (dependencia nueva). Riesgo deliverability/credenciales:
  password cifrada con la master key existente; "probar envío" obligatorio antes de poder usar.
- **Datasets de ciudades** en `src/data/cities/{co,mx}.json` — sin dependencia de APIs externas.
- **Kommo sigue vivo** hasta que Fases 1–2 estén en producción; la migración trae el histórico.
- Teléfonos siempre normalizados a E.164 al guardar (input con prefijo del país del lead).
```
