# Auditoría técnica de MESAPAY

Fecha: 8 de septiembre de 2026. Revisión local: `6786dc7`.

## Dictamen

MESAPAY tiene una base funcional amplia y decisiones acertadas: PostgreSQL, importes enteros, snapshots de pedidos, validación con Zod, cifrado autenticado de credenciales, separación de proveedores de pago y módulos de negocio identificables. Sin embargo, su crecimiento funcional ha superado la consolidación de los controles comunes de autorización, estados, concurrencia y despliegue.

Mi recomendación es corregir primero los riesgos de dinero, aislamiento entre restaurantes y pérdida de datos antes de ampliar módulos o aumentar considerablemente el volumen. Conservaría Next.js y PostgreSQL y evolucionaría hacia un monolito modular con servicios de dominio compartidos. La necesidad inmediata es consistencia de reglas y operación verificable.

## Alcance y evidencia

Se inventariaron 685 archivos TypeScript/TSX en `src`, aproximadamente 143.705 líneas incluyendo pruebas y comentarios, 235 rutas API y 81 modelos Prisma. Se inspeccionaron en profundidad rutas seleccionadas de autenticación, contexto de restaurante, pedidos, pagos, webhooks, inventario, importaciones, despliegue, internacionalización y partes de contabilidad, facturación y frontend. No es una revisión línea por línea de todos los módulos.

Se ejecutaron pruebas locales y comprobaciones aisladas del código original, sustituyendo base de datos, sesión y proveedores por simulaciones en memoria. Estas últimas prueban decisiones del código, no la configuración efectiva del servidor ni una explotación sobre producción. No se ejecutaron cobros, escrituras sobre bases reales, despliegues ni solicitudes a servicios internos. Tampoco se inspeccionaron valores de secretos.

| Comprobación | Resultado |
| --- | --- |
| `npm test` | 31 archivos; 267 pruebas aprobadas |
| `npx tsc --noEmit --incremental false` | Aprobado |
| `npm run lint` | Falla: 1.280 errores y 6.498 advertencias; incluye copias bajo `.claude/worktrees` |
| `npx eslint src --format json` | 50 errores, 23 advertencias; 30 archivos con errores |
| Paridad de catálogos | 4.930 claves en cada idioma; ninguna clave española ausente en inglés o portugués |
| `node scripts/i18n-audit.mjs` | Cero claves estáticas faltantes; referencias dinámicas requieren otra comprobación |
| Build, E2E y carga con PostgreSQL | No ejecutados en esta auditoría |

Los resultados de lint no equivalen al mismo número de fallos funcionales. Sirven para mostrar que la barrera de calidad actualmente no está limpia y que el comando general incluye ruido ajeno al árbol principal.

## Prioridades

P0: corregir con urgencia por permitir alteraciones de pagos, acceso entre restaurantes o cambios destructivos de datos. P1: corregir antes de escalar operación. P2: consolidación, rendimiento y mantenibilidad.

### 1. P0 — Pagos de demostración aprobados desde una ruta pública

**Evidencia:** [pay/route.ts:15](/Users/nicolas/Documents/APPS/MESAPAY/src/app/api/tenant/[slug]/pay/route.ts:15) admite `demo_card` y `demo_nequi`. En [la rama de aprobación:298](/Users/nicolas/Documents/APPS/MESAPAY/src/app/api/tenant/[slug]/pay/route.ts:298) crea un pago `approved` sin consultar una pasarela. No verifica entorno, modo de pruebas ni configuración de medios del restaurante para esa rama.

**Reproducción aislada:** con restaurante y pedido simulados válidos, una petición `demo_card` sin sesión devolvió HTTP 200, `paid: true` y creó un pago aprobado. No se invocó `auth()`.

**Impacto:** si esta ruta se sirve como está escrita, conocer el pedido permite registrarlo como pagado sin recibir dinero. Ocultar el botón en la interfaz no restringe la API.

**Corrección:** impedir métodos simulados en producción desde el servidor; separar demostraciones de los datos operativos; validar que el método esté habilitado. Añadir una prueba de integración que garantice cero escrituras financieras ante intentos de usar métodos demo en producción.

### 2. P0 — Operaciones de personal sin comprobar pertenencia al restaurante

**Evidencia:** [cobro de efectivo:107](/Users/nicolas/Documents/APPS/MESAPAY/src/app/api/tenant/[slug]/pay/route.ts:107) verifica `operator`, `mesero` o `platform_admin`, pero no compara el restaurante de la sesión/contexto activo con el del pedido. [Cortesías:43](/Users/nicolas/Documents/APPS/MESAPAY/src/app/api/tenant/[slug]/orders/[orderId]/comp/route.ts:43) repite el patrón. Comprobar que el pedido pertenece al slug recibido no demuestra que el usuario tenga permiso sobre ese restaurante.

**Reproducción aislada:** un usuario `operator` de restaurante A pudo crear un pago de efectivo aprobado para restaurante B y quedó registrado como cobrador. En el helper real, [meseroNeedsShiftToCharge:40](/Users/nicolas/Documents/APPS/MESAPAY/src/lib/meseroShift.ts:40) los operadores no requieren la comprobación de turno, por lo que ese helper no resuelve el problema.

**Corrección:** un guard compartido que resuelva identidad vigente, permiso para la acción, restaurante activo y recurso. La impersonación del administrador debe ser explícita y trazable. Probar cada acción con un usuario de otro restaurante y exigir rechazo antes de cualquier escritura. Este criterio coincide con la recomendación de [OWASP de validar autorización en cada petición](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).

### 3. P0 — El despliegue acepta pérdida de datos antes de validar el nuevo build

**Evidencia:** [activate.sh:65](/Users/nicolas/Documents/APPS/MESAPAY/vps/blue-green/activate.sh:65) ejecuta `prisma db push --accept-data-loss --skip-generate` antes de `npm run build`, mientras la versión anterior sigue sirviendo. No hay directorio de migraciones versionadas en el árbol revisado.

**Impacto:** un cambio incompatible puede modificar o eliminar datos aunque el build posterior falle. Cambiar el enlace a la versión anterior no restaura el esquema ni los datos. El mecanismo blue/green protege el intercambio de procesos, pero no revierte esas modificaciones.

**Corrección:** migraciones SQL versionadas y revisadas, cambios compatibles por etapas, validaciones antes del despliegue y restauraciones ensayadas. Retirar la aceptación automática de pérdida de datos. El riesgo descrito corresponde al script versionado; no se comprobó si el VPS usa exactamente esa versión.

### 4. P1 — Se pueden añadir platos a un pedido ya pagado

**Evidencia:** [orders/route.ts:80](/Users/nicolas/Documents/APPS/MESAPAY/src/app/api/tenant/[slug]/orders/route.ts:80) recupera la orden y valida restaurante/mesa, pero no rechaza estados cerrados. Después crea una ronda y recalcula importes manteniendo `paid` si ya estaba pagada.

**Reproducción aislada:** una orden pagada de 10.000 unidades internas aceptó un plato de 10.000; devolvió HTTP 200, guardó subtotal 20.000 y conservó estado `paid`.

**Impacto:** consumo adicional sin deuda correctamente representada, inconsistencias con facturas y con `stockConsumedAt`, y preparación de platos sobre cuentas cerradas. También debe rechazarse la ampliación de pedidos cancelados.

**Corrección:** transiciones explícitas y verificadas dentro de la operación atómica. Un pedido pagado se mantiene cerrado; una ampliación debe crear una nueva cuenta o seguir una operación de reapertura diseñada y auditada. Probar también dos rondas concurrentes: actualmente `count + 1` compite con la unicidad de `(orderId, seq)`.

### 5. P1 — El total persistido pierde los impuestos añadidos

**Evidencia:** [orderTotals.ts:177](/Users/nicolas/Documents/APPS/MESAPAY/src/lib/orderTotals.ts:177) calcula si está pagada incluyendo `taxCents`, pero [la escritura:183](/Users/nicolas/Documents/APPS/MESAPAY/src/lib/orderTotals.ts:183) guarda solamente `subtotalCents + tipsTotalCents`.

**Reproducción aislada:** subtotal 10.000, impuesto añadido 1.900 y pago 11.900: la orden quedó `paid`, pero `totalCents` terminó en 10.000. Son unidades internas del código, no una recomendación de tarifa tributaria.

**Otros caminos inconsistentes:** la creación de rondas suma todos los ítems sin excluir cancelados y sobrescribe `totalCents` con el subtotal; la cancelación pública de ítems tiene otro cálculo propio. Existen varios escritores de la misma regla.

**Corrección:** una sola función de cálculo para líneas activas, impuestos añadidos, propinas, pagos y devoluciones. Definir y probar invariantes, entre ellos `total = subtotal + impuestos añadidos + propinas` y `0 <= propina <= importe del pago`. Los esquemas de cobro revisados no validan esa última relación.

### 6. P1 — Cobros concurrentes y errores de red pueden dejar estados financieros incoherentes

**Evidencia:** [kushki-charge/route.ts:89](/Users/nicolas/Documents/APPS/MESAPAY/src/app/api/tenant/[slug]/pay/kushki-charge/route.ts:89) convierte todos los pendientes de la orden en rechazados; valida saldo ignorando pendientes; crea otro pago y llama al proveedor. Ante cualquier excepción del proveedor, [línea 181](/Users/nicolas/Documents/APPS/MESAPAY/src/app/api/tenant/[slug]/pay/kushki-charge/route.ts:181), lo marca rechazado.

**Impacto:** dos intentos pueden pasar la comprobación del mismo saldo. Un timeout no demuestra que el proveedor haya rechazado el cargo. Marcar un pendiente como rechazado localmente tampoco cancela un cobro que ya está en vuelo. Son riesgos derivados del flujo; no se generaron cargos concurrentes reales.

**Corrección:** intención de pago con identificador estable, reserva atómica de saldo, idempotencia por operación y estados para resultado desconocido. Conciliar con el proveedor antes de liberar un intento incierto. Evitar mantener un bloqueo SQL durante una llamada de red: reservar en una transacción corta y completar en otra. Aplicar el mismo enfoque a devoluciones, cuyo importe acumulado también se calcula desde una lectura previa.

### 7. P1 — El inventario puede perder actualizaciones concurrentes

**Evidencia:** [stock.ts:177](/Users/nicolas/Documents/APPS/MESAPAY/src/lib/erp/stock.ts:177) lee el nivel y después escribe `level.qtyBase + signedQty` y `level.totalValueCents + signedValueCents` como valores absolutos. Los llamadores revisados usan transacciones sin aislamiento explícito o bloqueo previo del insumo.

**Reproducción simulada de intercalado:** dos movimientos leen saldo 100 y descuentan 10 y 20. Se registraron movimientos por −30, pero el saldo final resultó 80 en vez de 70. La simulación demuestra el problema de leer y sobrescribir; una prueba adicional con PostgreSQL debe verificar el aislamiento efectivo del entorno.

**Corrección:** bloquear el saldo del insumo antes de calcular su valorización, o usar control de versión con reintentos. Una actualización aritmética atómica puede resolver cantidad, pero el costo promedio exige proteger conjuntamente cantidad y valor. Mantener orden estable de bloqueos cuando intervengan varios insumos. PostgreSQL documenta que [Read Committed permite anomalías entre lecturas y actualizaciones complejas](https://www.postgresql.org/docs/current/transaction-iso.html).

### 8. P1 — Eventos de todo el restaurante accesibles sin sesión ni permiso de mesa

**Evidencia:** [events/route.ts:7](/Users/nicolas/Documents/APPS/MESAPAY/src/app/api/tenant/[slug]/events/route.ts:7) acepta un slug y suscribe al bus completo del restaurante. Publica identificadores de pedidos, pagos y otros eventos operativos. [La cancelación pública de ítems](/Users/nicolas/Documents/APPS/MESAPAY/src/app/api/tenant/[slug]/order-items/[id]/route.ts:5) comprueba restaurante y estado, pero no posesión del pedido o mesa. La página pública del pedido permite consultar sus líneas con el identificador.

**Impacto:** terceros pueden observar actividad y obtener identificadores que otras rutas tratan como suficiente contexto. La dificultad de adivinar un ID deja de ayudar cuando se entrega en un canal público.

**Corrección:** mantener la experiencia sin registro mediante una sesión de invitado o credencial firmada, limitada a mesa/pedido y con caducidad. Separar el canal del cliente del canal operativo del personal y publicar únicamente datos mínimos autorizados.

### 9. P1 — Desactivar usuarios o cambiar permisos no invalida sus JWT existentes

**Evidencia:** [auth.ts:74](/Users/nicolas/Documents/APPS/MESAPAY/src/auth.ts:74) comprueba `disabledAt` al iniciar sesión; [callbacks:90](/Users/nicolas/Documents/APPS/MESAPAY/src/auth.ts:90) mantienen rol/restaurante en el token sin revalidarlos. El cambio de contraseña tampoco establece una versión de sesión que esos callbacks verifiquen. CRM sí tiene controles adicionales en su guard, pero eso no cubre todas las rutas.

**Impacto:** la baja de un empleado no garantiza la pérdida inmediata de los permisos que ya tenía en su sesión.

**Corrección:** invalidación mediante versión de sesión, consulta de identidad vigente para operaciones sensibles o sesiones revocables. Centralizar la política y probar desactivación, traslado de restaurante, degradación de rol y cambio de contraseña.

### 10. P1 — Firma opcional e idempotencia incompleta en webhooks de suscripción

**Evidencia:** [kushki-subscription/route.ts:148](/Users/nicolas/Documents/APPS/MESAPAY/src/app/api/webhooks/kushki-subscription/route.ts:148) continúa procesando cuando no existe secreto, sin limitar ese comportamiento a desarrollo. La duplicación se comprueba con una lectura previa; [MembershipPayment](/Users/nicolas/Documents/APPS/MESAPAY/prisma/schema.prisma:540) no tiene restricción única para la referencia del proveedor. [applyRecurringCharge:159](/Users/nicolas/Documents/APPS/MESAPAY/src/lib/billing/subscription.ts:159) inserta y extiende vigencia sin una reclamación única del evento.

**Impacto:** si falta el secreto, se aceptan cambios de suscripción no autenticados; entregas concurrentes pueden generar registros duplicados. El primer riesgo depende de la configuración real, que no se inspeccionó.

**Corrección:** rechazar eventos financieros sin autenticación configurada, separar handshake de procesamiento y reclamar cada evento mediante una restricción única y transacción. Los webhooks generales sí tienen parte de estas defensas, aunque [webhookHandler.ts:49](/Users/nicolas/Documents/APPS/MESAPAY/src/lib/payments/webhookHandler.ts:49) separa lectura, creación, despacho y marcado final: conviene consolidar su tratamiento de concurrencia y reintentos.

### 11. P1 — El filtro SSRF acepta loopback IPv6 y comprueba redirecciones demasiado tarde

**Evidencia:** [ssrf.ts:39](/Users/nicolas/Documents/APPS/MESAPAY/src/lib/ssrf.ts:39) usa el hostname de `URL`, que conserva corchetes para IPv6; el filtro no normaliza ese formato ni las IPv4 mapeadas. En [menuImportImages.ts:51](/Users/nicolas/Documents/APPS/MESAPAY/src/lib/menuImportImages.ts:51), `fetch` sigue redirecciones automáticamente y valida la URL final después de realizar la solicitud.

**Reproducción aislada:** `checkUrlSafe` devolvió `{ok:true}` para loopback IPv6 y una IPv4 loopback mapeada en IPv6. No se realizó ninguna conexión de red.

**Corrección:** normalización robusta de direcciones, restricción de rangos no públicos, validación de cada redirección antes de seguirla y resolución DNS consistente con la conexión efectiva. Añadir controles de salida de red. Revisar los importadores específicos, que reutilizan el patrón.

### 12. P1 — Códigos cortos aleatorios con espacio pequeño y unicidad global

**Evidencia:** [orders/route.ts:38](/Users/nicolas/Documents/APPS/MESAPAY/src/app/api/tenant/[slug]/orders/route.ts:38) genera cinco letras posibles por 9.000 números: 45.000 combinaciones. [Order.shortCode](/Users/nicolas/Documents/APPS/MESAPAY/prisma/schema.prisma:1067) es único en toda la plataforma. La inserción no reintenta colisiones.

**Impacto:** las colisiones pueden causar errores de creación mucho antes de agotar el espacio. Con 1.000 códigos existentes de ese espacio, el siguiente sorteo tiene aproximadamente 2,22 % de probabilidad de colisionar. No se midió la ocupación real.

**Corrección:** secuencia por restaurante/día o identificador legible con ámbito e índice coherentes. Si se conserva generación aleatoria, ampliar espacio y reintentar conflictos de unicidad de forma acotada.

### 13. P2 — Reglas de acceso inconsistentes entre interfaz y API

[El layout de operador](/Users/nicolas/Documents/APPS/MESAPAY/src/app/operator/layout.tsx:29) admite `group_admin`; [getErpContext](/Users/nicolas/Documents/APPS/MESAPAY/src/lib/erp/access.ts:26) admite solamente operador y administrador de plataforma. Eso permite presentar superficies cuyas acciones luego se rechazan, salvo que se quiera explícitamente una política de solo lectura que debe expresarse en ambos lados.

La suspensión se muestra en el layout, pero las rutas operativas revisadas no comparten una verificación equivalente. Debe definirse qué operaciones siguen permitidas para terminar servicios o consultar datos y aplicar la misma política en el servidor. Una pantalla de bloqueo no sustituye al permiso de API.

### 14. P2 — Eventos y trabajo diferido dependen del proceso

[events.ts](/Users/nicolas/Documents/APPS/MESAPAY/src/lib/events.ts:66) conserva suscriptores en un `Map` local y dispara consumo de inventario con `setImmediate`. Distintas instancias no comparten eventos y durante blue/green las conexiones antiguas pueden permanecer en un proceso distinto al que recibe nuevas escrituras. No hay historial de eventos para recuperar los perdidos.

Hay una defensa útil: el consumo reclama atómicamente `stockConsumedAt` y un cron recupera pendientes. Sin embargo, [el barrido](/Users/nicolas/Documents/APPS/MESAPAY/src/lib/erp/consumption.ts:273) se limita a las últimas 48 horas y a 500 órdenes; un fallo persistente puede dejar trabajos fuera de su ventana.

**Mejora:** eventos distribuidos para las pantallas y outbox/cola durable para inventario, emails y facturación. El outbox registra trabajo pendiente en la misma transacción del cambio de negocio. Medir antigüedad del pendiente más viejo y permitir recuperación sin perder eventos por una ventana temporal.

### 15. P2 — Pruebas y despliegue no cubren los fallos de mayor costo

La suite aprobada se concentra en CRM, ciudades, herramientas de IA, comisiones, impuestos y utilidades. No hay pruebas dedicadas de los caminos críticos de pago y stock descritos. [El E2E existente](/Users/nicolas/Documents/APPS/MESAPAY/e2e/operator-smoke.spec.ts:87) se centra en carga de pantallas y errores de consola. No se encontró un pipeline de CI versionado en `.github`; puede existir automatización fuera del repositorio, pero el script de activación revisado no ejecuta la suite ni lint.

**Mejora:** PostgreSQL desechable en integración y escenarios de aislamiento entre restaurantes, pagos divididos, dos cobros simultáneos, timeout con aprobación tardía, webhook repetido, devolución parcial, stock concurrente y pedido cerrado. Después, E2E de pedir → preparar → servir → pagar → cerrar caja. Limpiar el alcance de lint para excluir worktrees antiguos, resolver los 50 errores del código principal y convertir esos checks en requisito del despliegue.

### 16. P2 — Frontend grande y experiencia operativa poco protegida por pruebas

Archivos especialmente grandes: [ComprasClient.tsx](/Users/nicolas/Documents/APPS/MESAPAY/src/app/operator/compras/ComprasClient.tsx) tiene 5.303 líneas; [MenuClient.tsx](/Users/nicolas/Documents/APPS/MESAPAY/src/app/t/[slug]/menu/MenuClient.tsx), 3.310; [PayClient.tsx](/Users/nicolas/Documents/APPS/MESAPAY/src/app/t/[slug]/pay/[orderId]/PayClient.tsx), 2.641. El tamaño no prueba lentitud, pero concentra estados, solicitudes y reglas que son difíciles de verificar por separado.

**Mejora:** dividir por flujo: intención de pago, selección de método, seguimiento y comprobante; en compras, listado, edición, recepción, pagos y conciliación. Crear componentes compartidos para dinero, confirmaciones, estados de petición y errores. Cargar funcionalidades pesadas cuando se abran y medir payloads, interacciones y consultas antes de optimizar.

El [viewport global](/Users/nicolas/Documents/APPS/MESAPAY/src/app/layout.tsx:80) deshabilita el zoom mediante `maximumScale: 1` y `userScalable: false`. Retiraría esa restricción y validaría accesibilidad con teclado, lector de pantalla y ampliación. Estas observaciones proceden del código; no se realizó una auditoría visual o de usabilidad con usuarios.

### 17. P2 — Buen avance de i18n, pero país e idioma siguen mezclados en algunos flujos

Los tres catálogos tienen todas las claves y la auditoría estática pasa. Es una fortaleza real. Aun así, [pay/route.ts:87](/Users/nicolas/Documents/APPS/MESAPAY/src/app/api/tenant/[slug]/pay/route.ts:87) y otras respuestas de API incluyen mensajes españoles y formato `es-CO`. [La vista de pedido](/Users/nicolas/Documents/APPS/MESAPAY/src/app/t/[slug]/order/[orderId]/page.tsx:5) sigue importando `fmtCOP`. El guard de lint usa `jsx-text-only`, por lo que no cubre todos esos casos.

**Mejora:** completar errores de API y textos derivados, mantener códigos de error estables con traducción en la capa de presentación y probar las tres lenguas. Definir moneda y zona horaria por establecimiento; un país como México puede necesitar más de una zona. Para rendimiento, revisar el catálogo heredado por el proveedor i18n raíz: cada JSON pesa aproximadamente 246–257 KB sin comprimir. Seleccionar namespaces por superficie y medir el ahorro real; no se midió la transferencia de navegador.

### 18. P2 — Recuperación, observabilidad y seguridad de archivos necesitan consolidación

El [health check](/Users/nicolas/Documents/APPS/MESAPAY/src/app/api/health/route.ts:17) verifica `SELECT 1`, útil para conectividad, pero no prueba compatibilidad del esquema ni flujos esenciales. No se encontró instrumentación de métricas/trazas o procedimientos versionados de restauración periódica; podrían estar configurados externamente. El README principal sigue siendo el de la plantilla y menciona un puerto distinto al script de desarrollo.

Añadiría identificadores de correlación, alertas de cargos inciertos, duplicaciones, discrepancias de caja, fallos de cron y retrasos de inventario/facturación. Documentaría instalación, configuración sin secretos, backups, restauración, conciliación y responsabilidades operativas. Mediría latencia p95, conexiones DB/SSE y duración de consultas con datos representativos antes de prometer capacidad.

No se encontró rate limiting en los handlers y autenticación revisados; verificar si existe en el proxy y definir límites por IP, usuario y restaurante para login, registro, importaciones e IA.

En [uploads/route.ts:79](/Users/nicolas/Documents/APPS/MESAPAY/src/app/api/operator/uploads/route.ts:79), los SVG se guardan originales después de un filtro textual reconocido como incompleto. Requiere sanitización estructural o conversión a raster y una política de entrega segura, idealmente desde un origen de archivos separado. No se demostró una explotación de SVG. Las imágenes raster sí pasan por Sharp, que comprime y elimina metadatos: conservaría ese comportamiento.

## Plan de trabajo recomendado

| Orden | Entregable | Criterio de aceptación |
| --- | --- | --- |
| 1 | Cerrar métodos demo y autorización cruzada; asegurar despliegue | Intentos no autorizados producen rechazo sin cambios; ninguna migración acepta pérdida de datos automáticamente |
| 2 | Consolidar estados y cálculo de órdenes | No se modifican pedidos pagados; importes coherentes al añadir/cancelar líneas y dividir pagos |
| 3 | Intenciones de pago, webhooks y conciliación | Reintentos no duplican operaciones; timeout permanece incierto hasta verificar proveedor |
| 4 | Concurrencia de inventario y códigos de pedido | Movimientos y saldos coinciden bajo carga; conflictos de código no se traducen en errores de pedido |
| 5 | Sesiones revocables, invitado por mesa y SSRF | Personal desactivado pierde acceso; invitado no observa otras mesas; destinos privados se rechazan antes de conectar |
| 6 | CI, regresiones de negocio y operación | Checks limpios obligatorios; restauración ensayada; alertas de trabajos pendientes y errores financieros |
| 7 | Separación de módulos, UX e internacionalización | Flujos pequeños y testeables, zoom habilitado, mensajes/moneda/zona coherentes y métricas de rendimiento conocidas |

La ampliación de contabilidad, nómina y emisión fiscal debe ir acompañada de fixtures revisados por especialistas del dominio. Esta auditoría no certifica exactitud tributaria, contable o laboral de esos módulos.

## Qué conservaría

- PostgreSQL y el modelo relacional; los importes enteros evitan una categoría importante de errores de dinero.
- Snapshots de precios y nombres en pedidos para conservar contexto histórico.
- Validación de pertenencia ya presente en muchas rutas de operador y en la impersonación de grupos: extender ese patrón a todos los caminos.
- AES-256-GCM para credenciales, hash de contraseñas y hash de tokens de recuperación; añadir revocación y rotación de claves con versionado.
- Centralización de movimientos de inventario y registro de movimientos; corregir la concurrencia de su saldo derivado.
- Separación de proveedor de pagos, logs de transacciones, módulos y catálogos i18n.
- Blue/green como base operativa, con migraciones y eventos compatibles entre versiones.

No se modificó código de aplicación durante esta auditoría. El único archivo añadido al proyecto es este informe.
