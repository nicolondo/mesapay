# Pulso — Asistente de negocio con IA (diseño)

**Fecha:** 2026-06-08
**Estado:** aprobado para escribir plan de implementación
**Producto:** chat de IA donde el dueño del comercio (y el admin de grupo)
le pregunta en lenguaje natural sobre su negocio y un agente Claude responde
consultando los datos reales del restaurante.

---

## 1. Objetivo y alcance

Un chat conversacional ("**Pulso**") que responde preguntas de inteligencia
de negocio sobre UN restaurante o un GRUPO de sedes, por ejemplo:

- ¿Cuáles son los platos que más/menos se venden?
- ¿Qué busca más la gente en la carta? ¿Qué buscan y no encuentran?
- ¿Qué días y a qué horas tengo más movimiento? ¿Y los valles?
- ¿Quién es mi mejor mesero? ¿Cómo se comparan?
- ¿Con cuántos meseros puedo manejar la operación, por franja?
- ¿En qué días/horas la cocina no da abasto?
- ¿Cuánto pierdo en cancelaciones y cortesías?
- ¿Cómo viene la tendencia de ventas? ¿Estoy creciendo?

**Audiencia (decidido):** dueño/operador (su restaurante) + admin de grupo
(multi-sucursal). **Sin acceso de meseros.**

**Disponibilidad (decidido):** plan `trial` o `pro` (el enum `Plan` es
`trial | basic | pro`; "Premium" = `pro`, "Esencial" = `basic` queda fuera),
**con override por comercio** desde el admin (forzar on/off independiente del
plan).

**Modelo:** Claude **Sonnet**. **Límite:** 50 mensajes/día por comercio,
**parametrizable desde el admin** (default global 50, override por comercio).

**Solo lectura.** El agente nunca modifica datos.

### Fuera de alcance (YAGNI v1)
Acciones/mutaciones, acceso de meseros, gráficos elaborados (solo tablas/números
simples), voz, análisis de clientes recurrentes (los comensales no tienen
identidad confiable), cross-sell/market-basket.

---

## 2. Arquitectura

```
Operator/GroupAdmin (UI chat /operator/insights, /group/insights)
        │  POST mensaje (stream)
        ▼
/api/operator/insights/chat   ──►  Agente (loop de tool-use, Anthropic SDK)
        │                              system prompt + catálogo de tools
        │                              ┌─ Claude pide tool(s)
        │                              ▼
        │                          executeTool(name, input, SCOPE)   ← scope del server
        │                              ▼  (SQL agregado, Prisma)
        │                          JSON compacto  ──► de vuelta a Claude
        │                              ▼
        ▼  texto en streaming      respuesta final redactada
   persistencia (AiConversation / AiMessage)
```

- **Loop de agente** server-side con `@anthropic-ai/sdk` (ya integrado en
  `src/lib/anthropic.ts`). Cliente Sonnet, `tools` = catálogo, `tool_choice:auto`.
  Iteramos: mientras Claude devuelva `tool_use`, ejecutamos la tool y le
  devolvemos `tool_result`, hasta que produce el texto final.
- **Streaming** del texto final al cliente (Next streaming / SSE) para UX.
- **Prompt caching** del system prompt + definiciones de tools (son fijos por
  request) para bajar costo/latencia.
- **El scope (`restaurantId` o `restaurantId[]` del grupo) se inyecta SIEMPRE
  desde la sesión autenticada del lado del server.** El modelo nunca lo pasa,
  nunca escribe SQL, nunca ve datos de otro comercio. Esta es la frontera de
  seguridad multi-tenant.

### Helper nuevo
`src/lib/ai/insightsAgent.ts` — orquesta el loop (build de system prompt,
ejecución de tools, manejo de errores y límite de iteraciones). Reusa
`getClient()` de `src/lib/anthropic.ts` (extraer/exponer si hace falta).

---

## 3. Catálogo de herramientas (tools)

Cada tool es una **función TypeScript pura** con input **Zod**, que recibe el
`scope` (resuelto en el server) y devuelve **agregados compactos** (top-N,
buckets) — **nunca filas crudas** (acota tokens + privacidad). Viven en
`src/lib/ai/tools/` con un registry que expone (a) el JSON-schema para Claude
y (b) el ejecutor.

Rango de fechas estándar en cada tool: `{ from, to }` (o presets: `7d/30d/90d/
mtd/qtd`), **clampeado** server-side (máx. ~13 meses). Todas filtran por scope.

| Tool | Responde | Fuente principal |
|---|---|---|
| `sales_overview` | ventas, # órdenes, ticket prom., comensales, **vs período anterior** | Order/Payment (status pagado, `paidAt`/`settledAt`) |
| `revenue_trend` | serie temporal (día/sem/mes) + crecimiento % | Order.paidAt + Payment.amountCents |
| `top_dishes` | más/menos vendidos (qty o ingreso) + tendencia + **rating prom.** | OrderItem (no cancelados) + DishRating |
| `category_breakdown` | ventas por categoría/menú (comida/vinos/bebidas) | OrderItem → MenuItem → Category/Menu |
| `traffic_by_time` | tráfico por **día-de-semana × hora** (picos y valles) | Order.placedAt/paidAt (en tz del comercio) |
| `tables_turnover` | rotación, tiempo de ocupación, vueltas por mesa/turno | Order (createdAt→paidAt) + Table |
| `payment_mix` | desglose por método de pago + **propinas** | Payment.method/tipCents (aprobados) |
| `staff_performance` | por mesero: ventas, # mesas, ticket, **propinas**, tiempo de servicio | Payment.collectedByUserId + Order + User |
| `staffing_estimate` | carga por franja vs meseros activos → cuántos meseros | Order(volumen por hora) + Shift(userId) |
| `kitchen_bottlenecks` | prep time (`preparationStartedAt`→`servedAt`) vs target, por estación/día/hora; % sobre target | OrderItem + MenuItem.prepMinutes |
| `cancellations` | **cancelaciones vs cortesías (comps)**, por hora/motivo, $ perdido | OrderItem/Round (`cancelledAt`, `cancellationKind`, `cancellationReason`) |
| `top_searches` | términos más buscados + **% sin resultados** | **SearchEvent (dato nuevo)** |
| `reservations_insights` | reservas, **no-shows**, depósitos, ocupación | Reservation (status, depositStatus) |

**Multi-sucursal:** toda tool acepta `scope = { kind:"restaurant", id } |
{ kind:"group", restaurantIds:[…] }`. En modo grupo devuelve **breakdown por
sede + agregado**. El admin de grupo elige el scope en la UI; el set de
`restaurantIds` se resuelve del grupo en el server (nunca del modelo).

**Timezone:** "horas/días pico" se calculan en la zona horaria del comercio.
No hay campo `timezone` en `Restaurant` → lo derivamos de `country` (CO →
`America/Bogota`, MX → `America/Mexico_City`, default `America/Bogota`).
*Mejora opcional:* agregar `Restaurant.timezone String?` explícito (no bloquea v1).

Cada ejecución de tool se loguea en `AuditEvent` (nombre, scope, input, ms,
filas, ¿error?) para debug y tracking de costo.

---

## 4. Modelo de datos (Prisma)

### 4.1 Búsquedas del comensal (dato nuevo)
```
model SearchEvent {
  id           String   @id @default(cuid())
  restaurantId String
  restaurant   Restaurant @relation(...)
  term         String   // normalizado: lower, sin acentos, trim
  rawTerm      String   // lo que tecleó (para debug)
  resultCount  Int      // # de matches que vio
  hadResults   Boolean  // resultCount > 0
  locale       String?  // es/en/pt
  createdAt    DateTime @default(now())
  @@index([restaurantId, createdAt])
  @@index([restaurantId, term])
}
```
Captura: el buscador del menú (`MenuClient`) hace `POST /api/tenant/[slug]/
search-log` con **debounce ~800ms** al pausar de escribir (mínimo 2 chars).
Fire-and-forget, sin PII, no bloquea la UI. Server normaliza `term` y descarta
si está vacío.

### 4.2 Persistencia del chat
```
model AiConversation {
  id           String   @id @default(cuid())
  restaurantId String?  // null si es scope de grupo
  groupId      String?
  userId       String   // dueño/admin
  title        String   // autogenerado del primer mensaje
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  messages     AiMessage[]
  @@index([restaurantId, userId])
  @@index([groupId, userId])
}

model AiMessage {
  id             String   @id @default(cuid())
  conversationId String
  conversation   AiConversation @relation(...)
  role           String   // "user" | "assistant"
  content        String   // texto (markdown ligero)
  toolCalls      Json?    // tools usadas + inputs (para transparencia/debug)
  createdAt      DateTime @default(now())
  @@index([conversationId, createdAt])
}
```

### 4.3 Flags de feature y límite
- Gating por plan: `plan ∈ {trial, pro}` (helper `aiInsightsEnabled(restaurant)`).
- Override por comercio: `Restaurant.aiInsightsEnabled Boolean?` (null = según
  plan; true/false = forzar). Editable en `/admin/restaurants/[id]`.
- Límite diario: `PlatformConfig.aiDailyMessageLimit Int @default(50)` (default
  global) + `Restaurant.aiDailyMessageLimit Int?` (override por comercio,
  editable en admin). Conteo de mensajes del usuario por (restaurante/grupo, día).

---

## 5. UI

- **`/operator/insights`** (operador) y **`/group/insights`** (admin de grupo).
- Chat: lista de mensajes (markdown ligero), input, **respuesta en streaming**,
  estado "pensando / consultando datos…" mientras corren tools.
- **Preguntas sugeridas** (chips) al abrir: "Mis platos más vendidos este mes",
  "Días y horas de más movimiento", "¿Quién es mi mejor mesero?", "¿Cuándo se
  satura la cocina?".
- Las tools que devuelven números/tablas se pueden renderizar como **tarjetitas**
  bajo la respuesta (opcional v1; mínimo: texto).
- **Grupo:** selector de scope (todas las sedes / una sede) arriba del chat.
- **Historial:** lista de conversaciones previas (sidebar/dropdown), retomar.
- **i18n:** el chrome vía `next-intl` (es/en/pt, paridad). Claude **responde en
  el idioma del operador** (instrucción en el system prompt con el locale).
- Entrada en el nav "Pulso / Asistente", visible solo si el feature está
  habilitado para el comercio.

---

## 6. Seguridad, costo y límites

- **Scoping:** `restaurantId`/`restaurantIds` SIEMPRE del server (sesión). El
  admin de grupo solo accede a las sedes de su grupo (validado server-side).
- **Inyección de prompt:** las tools son el ÚNICO camino a datos; el modelo no
  ejecuta SQL. Inputs validados por Zod, rangos clampeados. Solo lectura.
- **Límite de iteraciones** del loop (ej. 6 tool-calls/mensaje) para evitar
  loops o costo runaway.
- **Rate limit:** 50 mensajes/día por comercio (config). Al exceder → mensaje
  claro ("alcanzaste el límite de hoy"), sin llamar a la API.
- **Costo:** tools devuelven agregados chicos; prompt caching del system+tools;
  historial acotado (últimos N mensajes en contexto).
- **Auditoría:** tool-calls logueadas en `AuditEvent`.

---

## 7. Testing

- **TDD de cada tool** contra un dataset sembrado determinístico (son funciones
  puras de agregación → fácil de testear con números esperados).
- **Test de scoping:** un usuario del comercio A nunca obtiene datos de B; el
  admin de grupo solo ve sus sedes.
- **Loop de agente** con cliente Anthropic **mockeado**: dado un `tool_use`,
  ejecuta la tool correcta, maneja `tool_result`, corta en el límite de
  iteraciones, y maneja errores de tool (devuelve error al modelo, no rompe).
- **Search-log:** normalización del término + debounce + descarte de vacíos.
- **Rate limit:** bloquea al mensaje 51 del día.

---

## 8. Componentes (unidades con un propósito claro)

| Unidad | Qué hace | Depende de |
|---|---|---|
| `src/lib/ai/tools/*` | una función pura por métrica (input Zod → JSON) | Prisma |
| `src/lib/ai/toolRegistry.ts` | expone JSON-schema (para Claude) + ejecutor | tools/* |
| `src/lib/ai/insightsAgent.ts` | loop de tool-use, system prompt, errores, límite | anthropic.ts, registry |
| `src/lib/ai/scope.ts` | resuelve scope (restaurante/grupo) desde la sesión | auth, db |
| `src/lib/ai/aiAccess.ts` | gating por plan + override + límite diario | db, platformConfig |
| `/api/operator/insights/chat` | endpoint de chat (stream) + persistencia | agent, scope, aiAccess |
| `/api/tenant/[slug]/search-log` | captura de búsquedas | db |
| `/operator/insights`, `/group/insights` | UI de chat | endpoint |
| schema: `SearchEvent`, `AiConversation`, `AiMessage`, flags | persistencia | — |

---

## 9. Preguntas abiertas / a confirmar en implementación
- Valores exactos de `Restaurant.plan` ya confirmados (`trial/basic/pro`).
- ¿Renderizado de tablas/tarjetas en v1 o solo texto? (mínimo texto; tarjetas si
  el tiempo lo permite).
- Si más adelante se quiere un overview siempre-presente (enfoque híbrido),
  se suma sin reescribir las tools.
