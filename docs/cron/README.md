# Crons de MESAPAY (systemd timers)

Cada job es una ruta `POST /api/cron/<nombre>` protegida por el header
`x-cron-secret` (= `CRON_SECRET` del `.env.production`). El servidor sólo
tiene la ruta; el disparo lo hace un `systemd timer` con `curl`.

| Timer | Ruta | Frecuencia | Qué hace |
|---|---|---|---|
| `mesapay-dian-emit` | `/api/cron/dian-emit` | cada 5 min | Emite a la DIAN los `DianDocument` en `to_send` (y los `error` con backoff vencido). Red de seguridad de la emisión automática de facturas. |
| `mesapay-backups-daily` | `/api/cron/backups-daily` | diario 04:00 | Copia de seguridad `auto` de cada comercio (tabla `RestaurantBackup`) + purga de las vencidas (7 días). Ver `docs/backups.md`. |
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
