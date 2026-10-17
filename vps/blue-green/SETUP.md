# Blue/Green deploy — one-time VPS setup

After this is in place, every `git push origin main` triggers a zero-
downtime deploy via the existing webhook on `:9000`. The new color is
built, health-checked, then nginx hot-reloads to it; the old color
drains in-flight requests for 100s before shutting down. The active color
is also enabled in systemd so it starts again after a server reboot.

These steps run **once** on the VPS. Everything in this directory
(`vps/blue-green/`) is already in the repo — you just copy / wire it up.

> **Before you start:** make a backup of the current `/opt/mesapay/`
> tree and dump the database. You're rewiring the live service.

## 0. Prerequisites

- `deploy` user can `sudo systemctl` and `sudo nginx -s reload` without
  password. If not, add a sudoers rule:
  ```
  deploy ALL=(ALL) NOPASSWD: /bin/systemctl restart mesapay@*, /bin/systemctl stop mesapay@*, /bin/systemctl start mesapay@*, /usr/sbin/nginx -t, /usr/sbin/nginx -s reload, /usr/bin/tee /etc/nginx/mesapay-active.conf
  ```
  Also grant boot-state changes for these **two exact units** (avoid a wildcard):
  ```
  deploy ALL=(root) NOPASSWD: /bin/systemctl enable mesapay@blue.service, /bin/systemctl enable mesapay@green.service, /bin/systemctl disable mesapay@blue.service, /bin/systemctl disable mesapay@green.service
  ```
  Place in `/etc/sudoers.d/mesapay`, then `sudo visudo -c`. Existing installations
  can put only the additional rule in `/etc/sudoers.d/mesapay-boot` without
  replacing their existing deployment permissions.

## 1. Stop the current single-process service

```bash
sudo systemctl stop mesapay      # whatever the current unit is called
sudo systemctl disable mesapay   # we'll replace it with mesapay@blue/@green
```

Keep the file around (`/etc/systemd/system/mesapay.service`) for now in
case you need to roll back.

## 2. Lay out the new directory tree

```bash
cd /opt/mesapay
sudo mkdir -p releases scripts shared/uploads
sudo chown -R deploy:deploy /opt/mesapay
```

If the existing `current/` is a symlink, leave it as-is for the moment.
We'll switch over after the first blue/green deploy succeeds.

## 3. Move shared secrets + per-color overrides

```bash
# Your existing .env.production stays here (already on the VPS):
ls /opt/mesapay/shared/.env.production

# Copy the per-color env files from the repo:
cp vps/blue-green/env.blue  /opt/mesapay/shared/.env.blue
cp vps/blue-green/env.green /opt/mesapay/shared/.env.green
```

## 4. Install the systemd unit template

```bash
sudo cp vps/blue-green/mesapay@.service /etc/systemd/system/mesapay@.service
sudo systemctl daemon-reload
```

Verify it parses:
```bash
sudo systemctl cat mesapay@blue.service
```

## 5. Configure nginx

Edit `/etc/nginx/sites-available/mesapay` (the existing vhost). Replace
the single `proxy_pass` line with the upstream pattern. The relevant
chunk should look like:

```nginx
upstream mesapay_app {
    include /etc/nginx/mesapay-active.conf;
    keepalive 16;
}

server {
    listen 443 ssl;
    server_name mesapay.co www.mesapay.co;
    # ... your existing ssl_certificate lines ...

    # Stay on the safer side for big PDF uploads (45 MB cap on the app).
    client_max_body_size 50M;

    location / {
        proxy_pass http://mesapay_app;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # SSE: keep long-lived event streams open.
        proxy_read_timeout 600s;
        proxy_buffering off;
    }
}
```

Install the initial upstream config (defaults to blue / port 3300):
```bash
sudo cp vps/blue-green/nginx-upstream.conf /etc/nginx/mesapay-active.conf
sudo nginx -t        # must pass
sudo nginx -s reload
```

## 6. Install the activate script

```bash
mkdir -p /opt/mesapay/scripts
cp vps/blue-green/activate.sh /opt/mesapay/scripts/activate.sh
chmod +x /opt/mesapay/scripts/activate.sh
```

## 7. First boot — start blue manually

The first run can't use the script because we need an initial release
to symlink. Do this once:

```bash
# Create the first release from the current code
GIT_HASH=$(cd /opt/mesapay/repo && git rev-parse --short HEAD)
RELEASE_DIR=/opt/mesapay/releases/$GIT_HASH
mkdir -p "$RELEASE_DIR"
rsync -a --delete --exclude=node_modules --exclude=.next --exclude=.git \
  /opt/mesapay/repo/ "$RELEASE_DIR/"
cd "$RELEASE_DIR"
ln -sf /opt/mesapay/shared/.env.production .env.production
ln -sfn /opt/mesapay/shared/uploads public/uploads
npm ci --prefer-offline --no-audit --no-fund
npx prisma generate
npm run build

# Point the blue symlink + start the service
ln -sfn "$RELEASE_DIR" /opt/mesapay/blue
sudo systemctl enable --now mesapay@blue.service

# Confirm it's serving
curl -i http://127.0.0.1:3300/api/health

# Mark blue as the active color
echo blue > /opt/mesapay/active-color
```

At this point nginx is already pointing at port 3300 (blue) thanks to
step 5. Verify the public site works:

```bash
curl -i https://mesapay.co/api/health
```

## 8. Update the webhook to call the new activate.sh

Wherever the GitHub webhook on `:9000` is wired (probably
`mesapay-webhook.service`), point its script to:

```
/opt/mesapay/scripts/activate.sh
```

The script handles build → health check → enable candidate for boot → swap →
drain → stop and disable the old color. If health, boot enablement or the nginx
swap fails, traffic stays on the old color. A cleanup failure after a successful
swap can still return non-zero while the new color is already serving; inspect
nginx, `active-color`, `current`, and both systemd units before taking action.

`activate.sh` is an installed copy: a Git push alone does **not** update
`/opt/mesapay/scripts/activate.sh`. When updating this script, install the new
sudoers rule first, validate it with `visudo`, then back up and atomically replace
the installed script. Check `bash -n` before replacement and hold the same
`/opt/mesapay/shared/deploy.lock` used by deployments.

After every deployment, confirm that only the active unit is enabled:

```bash
cat /opt/mesapay/active-color
cat /etc/nginx/mesapay-active.conf
systemctl is-enabled mesapay@blue.service mesapay@green.service
```

Run the isolated deployment regression tests locally or in CI (no server required):

```bash
python3 vps/blue-green/test_activate.py
```

## 9. Smoke-test the zero-downtime path

From your laptop, in one terminal:
```bash
while true; do curl -s -o /dev/null -w "%{http_code} " https://mesapay.co/; sleep 0.5; done
```

In another, push any tiny change. You should see a continuous stream
of `200`s through the whole deploy. If you ever see a `502`, capture
the timing and check `journalctl -u mesapay@green.service -n 100`.

---

## How rollback works

If a deploy ships broken code:

```bash
set -e

# 1. Find the previous release in /opt/mesapay/releases/
ls -lt /opt/mesapay/releases/

# 2. Point the inactive color at it
ln -sfn /opt/mesapay/releases/<old-hash> /opt/mesapay/green
sudo systemctl restart mesapay@green.service
curl --fail http://127.0.0.1:3301/api/health
sudo systemctl enable mesapay@green.service

# 3. Swap nginx only after health and enable both succeed
echo "server 127.0.0.1:3301;" | sudo tee /etc/nginx/mesapay-active.conf
sudo nginx -t
sudo nginx -s reload
echo green > /opt/mesapay/active-color
# Let existing requests finish before stopping the old instance.
sleep 100
sudo systemctl stop mesapay@blue.service
sudo systemctl disable mesapay@blue.service
```

Also update `/opt/mesapay/current` to the selected release. If nginx validation
or reload fails, restore the previous upstream and preserve the previous active
unit's boot configuration. Apply the inverse colors when rolling back to blue.

## How database migrations interact with this

Schema changes apply ONCE during `npx prisma migrate deploy` in step 2 of
`activate.sh` — while the OLD color is still serving. That means the
OLD color must keep working against the NEW schema for the ~10s
between push and the swap.

**Safe:** adding nullable columns, adding tables, adding indexes,
renaming via shadow-column-then-drop.

**Unsafe — needs a multi-deploy expand-contract:** dropping columns,
renaming columns in place, adding NOT NULL without a default.

Pattern we've been using (e.g. `Category.menuId String?` then a
backfill helper) is already expand-contract compatible.

## Files reference

- `vps/blue-green/mesapay@.service` → `/etc/systemd/system/mesapay@.service`
- `vps/blue-green/env.blue` → `/opt/mesapay/shared/.env.blue`
- `vps/blue-green/env.green` → `/opt/mesapay/shared/.env.green`
- `vps/blue-green/nginx-upstream.conf` → `/etc/nginx/mesapay-active.conf`
- `vps/blue-green/activate.sh` → `/opt/mesapay/scripts/activate.sh`
- `vps/blue-green/sudoers-boot` → `/etc/sudoers.d/mesapay-boot` (root:root, 0440; validate with `visudo`)


## Adoptar migraciones en una instalación existente

El baseline `20260908000000_baseline` representa el esquema de `d56288f` (Claude, incluida la cola de impresión). No se ejecuta sobre tablas existentes ni se marca como aplicado sin comparar primero el esquema.

1. Crear un backup y comprobar su restauración en una base aislada.
2. Comparar la base restaurada con ese baseline mediante `prisma migrate diff`; revisar todas las diferencias. Si la instalación está en una revisión anterior, migrar esos cambios de manera explícita y conservar los datos de comensales/órdenes.
3. **Sólo si coincide**, ejecutar `prisma migrate resolve --applied 20260908000000_baseline` sobre la instalación que se adopta.
4. Revisar las migraciones siguientes, ensayarlas sobre la copia restaurada y luego ejecutar `prisma migrate deploy` durante el despliegue autorizado.

No se usa `db push --accept-data-loss`. Revertir el color devuelve el código anterior, pero no revierte SQL: las migraciones deben mantener compatibilidad con la versión que sigue sirviendo durante el cambio.

El despliegue se serializa antes de instalar dependencias. Ejecuta pruebas, lint y build antes de cambiar el esquema; readiness comprueba los campos y triggers de pagos/sesiones. El cron `POST /api/cron/stock-consumption`, con `x-cron-secret`, debe estar programado para recuperar trabajo pendiente y señalar pagos sin resultado tras 30 minutos.
