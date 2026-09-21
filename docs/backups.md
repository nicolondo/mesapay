# Respaldos de MESAPAY

Hay **dos capas** y no son intercambiables:

| Capa | Qué | Cuándo | Dónde queda | Retención | Quién restaura |
| --- | --- | --- | --- | --- | --- |
| **Copia por comercio** (app) | Snapshot JSON de todas las tablas del comercio | manual (Configuración → Copias de seguridad) y automática 04:00 | tabla `RestaurantBackup`, en la misma base | 7 días | el dueño del comercio, desde el panel |
| **Respaldo de desastre** (VPS) | `pg_dump` completo de la base + `tar.gz` de los uploads | 03:30 | `/var/backups/mesapay/` | 14 días | nosotros, a mano, con `pg_restore` |

> La copia por comercio vive **dentro** de la base que respalda. Si se pierde
> el disco del VPS se pierde con ella. Es un "deshacer" del comercio (cargó
> mal una carta, borró un mes de asientos, importó insumos dos veces), no un
> respaldo ante la pérdida del servidor. Para eso está la segunda capa.

## 1. Copia por comercio (dentro de la app)

Código en `src/lib/backups/`:

- `tables.ts` — **qué se respalda**. La lista sale del DMMF de Prisma, no se
  escribe a mano: entra todo modelo con `restaurantId` y todo hijo colgado de
  uno de esos por una relación obligatoria (`OrderItem → Order`,
  `JournalLine → JournalEntry`, `PurchaseOrderItem → PurchaseOrder`, …). **Un
  modelo nuevo con `restaurantId` entra solo**, sin tocar nada. Lo único
  manual es `EXCLUDED_MODELS`, y cada exclusión lleva su porqué:
  - `RestaurantBackup` (no se respalda a sí mismo), `PlatformEvent` (log
    regenerable y enorme);
  - sesiones y tokens (`DinerSession`, `DinerMagicLink`,
    `PasswordResetToken`, `PushSubscription`);
  - acceso y plataforma (`User`, `MembershipPayment`, `BillingSubscription`,
    `CommissionEntry`, `CrmLead`, `AuditEvent`);
  - credenciales y alta de pagos (`KushkiDocument`, `KushkiWebhookEvent`,
    `DianConfig`).
- `snapshot.ts` — lee cada tabla en lotes de 1000 y la serializa a JSON
  (fechas ISO, Decimal/BigInt como string, Bytes en base64, Json tal cual).
- `restore.ts` — la restauración, en **una transacción** (timeout 10 min):
  1. la copia tiene que ser de ese comercio;
  2. **guardia de cobertura**: si hoy existe una tabla del comercio que la
     copia no trae, aborta con `backup_missing_tables` (nombrando cuáles).
     Nunca se restaura a medias — esa tabla se borraría sin reinsertarse;
  3. guarda una copia `pre_restore` del estado actual, ANTES de tocar nada;
  4. desactiva los **triggers de usuario** de las tablas que recarga
     (`reserve_payment`, `order_event`; ver `triggers.ts`): el snapshot es
     consistente por construcción y esos triggers están hechos para
     operaciones incrementales, no para recargar un estado completo. Las FKs
     y los CHECK siguen activos — si un CHECK falla, la copia trae una fila
     inválida y debe abortar. Los triggers vuelven a su estado al final (y
     solos si la transacción se revierte: el ALTER es transaccional);
  5. borra hijos→padres, inserta padres→hijos (orden topológico calculado
     de las FKs), saneando referencias a filas que ya no existen (un turno
     abierto por un usuario borrado se omite; un cobro cuyo cobrador ya no
     existe queda con esa columna en null);
  6. actualiza la fila `Restaurant` con lo que trae la copia **salvo**
     identidad (`id`, `slug`), credenciales Kushki, datos bancarios y el
     contrato con la plataforma (plan, suspensión, grupo, comercial,
     módulos): ver `RESTAURANT_SKIPPED_COLUMNS`. `invoiceNextNumber` nunca
     baja (los consecutivos ya emitidos quedan quemados). La fila nunca se
     borra.
- `retention.ts` — 7 días, automáticas y manuales.
- `service.ts` — crear / listar (sin el payload) / borrar / corrida diaria.

**No incluye**: archivos subidos (logo, fotos de platos, documentos: viven en
`/opt/mesapay/shared/uploads`), usuarios del panel y contraseñas, llaves y
certificados. Al restaurar, las sesiones de los comensales identificados se
cierran (cuelgan de `Diner`, que se reemplaza); vuelven a entrar con su clave.

### Rutas y UI

- `GET/POST /api/operator/backups` — lista / crea una copia `manual` (máx. 5
  vigentes por comercio → `429 too_many`).
- `DELETE /api/operator/backups/[id]` — borra.
- `POST /api/operator/backups/[id]` con `{ "action": "restore", "confirm":
  "RESTAURAR" }` — restaura. Sin la palabra exacta → `400 confirm_required`.
- Roles: `operator`, `platform_admin` (impersonando), `group_admin`.
- Pantalla: `/operator/settings/backups` (Configuración → Copias de seguridad).
  Sin botón de descarga, igual que en zenith: la copia es para restaurar.

### Corrida automática

`POST /api/cron/backups-daily` (header `x-cron-secret`) → `runDailyBackups()`:
una copia `auto` por comercio si no tiene una de las últimas 20 h, y después la
purga de vencidas. Timer: `docs/cron/mesapay-backups-daily.{service,timer}` a
las 04:00.

```bash
sudo cp docs/cron/mesapay-backups-daily.service docs/cron/mesapay-backups-daily.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mesapay-backups-daily.timer
systemctl list-timers mesapay-backups-daily.timer
journalctl -u mesapay-backups-daily.service -n 20
# A mano:
curl -sS -m 1800 -X POST -H "x-cron-secret: $(grep -m1 '^CRON_SECRET=' /opt/mesapay/shared/.env.production | cut -d= -f2-)" https://mesapay.co/api/cron/backups-daily
# → {"ok":true,"restaurants":12,"created":12,"skipped":0,"failed":0,"purged":9}
```

### Cobertura al crear una tabla nueva

Nada que hacer si la tabla tiene `restaurantId` o cuelga por relación
obligatoria de una que lo tiene: entra sola y `tables.test.ts` lo verifica.
Si la tabla **no debe** restaurarse (credenciales, plataforma, log), agregarla
a `EXCLUDED_MODELS` con su porqué. Una copia hecha antes de la migración no
podrá restaurarse después (la guardia de cobertura la rechaza): es lo
esperado, y a las 04:00 hay una copia nueva.

## 2. Respaldo de desastre del VPS (`pg_dump` + uploads)

Script: `docs/cron/mesapay-pgdump.sh` (copia canónica de
`/opt/mesapay/shared/mesapay-pgdump.sh`). Produce, con la misma marca de
tiempo:

- `/var/backups/mesapay/mesapay-AAAAMMDD-HHMM.dump` — `pg_dump --format=custom`
  (comprimido, restaurable por partes con `pg_restore`);
- `/var/backups/mesapay/mesapay-uploads-AAAAMMDD-HHMM.tar.gz` — el árbol de
  `/opt/mesapay/shared/uploads` con rutas relativas.

Escritura atómica (`.tmp` → verificación → `mv`), rotación a 14 días que nunca
deja una familia sin copia, y se niega a escribir el tar si no hay 3× de
holgura en disco. `DATABASE_URL` se lee con `grep '^DATABASE_URL='` del
`.env.production`: **nunca se sourcea ese archivo** (contuvo un heredoc
auto-replicante que tumbó un deploy).

### Instalar

```bash
sudo install -m 700 -o deploy -g deploy docs/cron/mesapay-pgdump.sh /opt/mesapay/shared/mesapay-pgdump.sh
sudo install -d -m 700 -o deploy -g deploy /var/backups/mesapay
sudo cp docs/cron/mesapay-pgdump.service docs/cron/mesapay-pgdump.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mesapay-pgdump.timer
# Primera corrida a mano y verificación:
sudo -u deploy bash /opt/mesapay/shared/mesapay-pgdump.sh
sudo -u deploy bash /opt/mesapay/shared/mesapay-pgdump.sh --verificar
```

Si Postgres corre en Docker en vez de local, apuntar los binarios:
`PG_DUMP="docker exec -i <contenedor> pg_dump" PG_RESTORE="docker exec -i <contenedor> pg_restore"`
(en el `.service`, con `Environment=`).

### Restaurar un `.dump` (destructivo: sólo para recuperación de desastre)

```bash
# 1. Parar la app (los dos colores) para que nadie escriba durante el restore.
sudo systemctl stop mesapay@blue.service mesapay@green.service

# 2. Base nueva y vacía, y restaurar el dump en ella. --clean --if-exists
#    permite también restaurar SOBRE la base existente, pero una base nueva
#    deja la vieja intacta por si algo sale mal.
URL="$(grep -m1 '^DATABASE_URL=' /opt/mesapay/shared/.env.production | cut -d= -f2- | tr -d '"')"
createdb --maintenance-db="$URL" mesapay_restore
pg_restore --no-owner --no-privileges --jobs=4 \
  --dbname="${URL%/*}/mesapay_restore" \
  /var/backups/mesapay/mesapay-AAAAMMDD-HHMM.dump

# 3. Uploads del MISMO sello de tiempo (filas y bytes alineados).
sudo -u deploy tar -xzf /var/backups/mesapay/mesapay-uploads-AAAAMMDD-HHMM.tar.gz -C /opt/mesapay/shared/uploads

# 4. Apuntar DATABASE_URL a mesapay_restore (o renombrar las bases con
#    ALTER DATABASE ... RENAME TO) y levantar el color activo.
sudo systemctl start "mesapay@$(cat /opt/mesapay/active-color).service"
```

Restaurar **siempre el par de la misma marca de tiempo**: un dump de anteayer
con los uploads de hoy deja filas apuntando a archivos que no existen (o al
revés). Un respaldo que nunca se restauró no es un respaldo: probar
`--verificar` después de instalar y, de vez en cuando, un `pg_restore` completo
a una base de prueba.
