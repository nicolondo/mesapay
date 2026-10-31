# Crons de MESAPAY (systemd timers)

Cada job es una ruta `POST /api/cron/<nombre>` protegida por el header
`x-cron-secret` (= `CRON_SECRET` del `.env.production`). El servidor sólo
tiene la ruta; el disparo lo hace un `systemd timer` con `curl`.

| Timer | Ruta | Frecuencia | Qué hace |
|---|---|---|---|
| `mesapay-dian-emit` | `/api/cron/dian-emit` | cada 5 min | Emite a la DIAN los `DianDocument` en `to_send` (y los `error` con backoff vencido). Red de seguridad de la emisión automática de facturas. |
| `mesapay-backups-daily` | `/api/cron/backups-daily` | diario 04:00 | Copia de seguridad `auto` de cada comercio (tabla `RestaurantBackup`) + purga de las vencidas (7 días). Ver `docs/backups.md`. |
| `mesapay-accounting-daily` | `/api/cron/accounting-daily` | diario 05:30 (hora de Colombia) | Regenera los asientos-resumen de los meses **abiertos** de cada comercio con el módulo de contabilidad (no suspendido): desde el primer mes con actividad hasta el mes en curso. No toca meses cerrados ni comprobantes manuales; lock por comercio compartido con el botón «Generar / actualizar asientos» y con el cierre de mes. Ver `src/lib/erp/autoJournal.ts`. |
| `mesapay-pgdump` | — (script local, sin ruta) | diario 03:30 | `pg_dump` completo de la base + `tar.gz` de los uploads en `/var/backups/mesapay`, retención 14 días. Respaldo de desastre; ver `docs/backups.md`. |

Instalación de un par `.service` + `.timer`:

```bash
sudo cp docs/cron/mesapay-dian-emit.service docs/cron/mesapay-dian-emit.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mesapay-dian-emit.timer
# Ver que quedó programado y qué devolvió la última corrida:
systemctl list-timers mesapay-dian-emit.timer
journalctl -u mesapay-dian-emit.service -n 20
```

Probar a mano (mismo comando que corre el timer):

```bash
curl -sS -X POST -H "x-cron-secret: $(grep -m1 '^CRON_SECRET=' /opt/mesapay/shared/.env.production | cut -d= -f2-)" https://mesapay.co/api/cron/dian-emit
# → {"ok":true,"scanned":3,"accepted":3,"pending":0,"rejected":0,"error":0,"blocked":0,"skipped":0,"truncated":false}
```

### `mesapay-accounting-daily` (asientos automáticos)

Va después del deploy que trae la ruta `/api/cron/accounting-daily` (antes
de eso el curl devuelve 404). La hora va con zona en el `OnCalendar`
(`05:30:00 America/Bogota`), así que no depende de la zona del VPS.

```bash
sudo cp docs/cron/mesapay-accounting-daily.service docs/cron/mesapay-accounting-daily.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemd-analyze calendar "*-*-* 05:30:00 America/Bogota"   # próxima corrida
sudo systemctl enable --now mesapay-accounting-daily.timer
systemctl list-timers mesapay-accounting-daily.timer
# Correrlo ya (mismo comando que el timer) y ver qué devolvió:
sudo systemctl start mesapay-accounting-daily.service
journalctl -u mesapay-accounting-daily.service -n 20
# → {"ok":true,"restaurants":1,"done":1,"busy":0,"failed":0,"pending":0,"truncated":false,
#    "months":{"ok":3,"error":0,"numbered":0,"closed":0,"invalid":0},"ms":4210,"runs":[…]}
```

En `runs` va el detalle por comercio y por mes: `ok` (regenerado, con
cuántos asientos), `error` (el mes falló y la corrida siguió con el
siguiente), `numbered` (mes reabierto con comprobantes numerados: no se
regenera solo; queda para el botón) y `busy` (otro proceso tenía el lock del
comercio; entra al día siguiente).
