#!/usr/bin/env bash
# ============================================================================
# RESPALDO DE DESASTRE DE MESAPAY EN EL VPS — base de datos + archivos subidos.
#
# Copia CANÓNICA (versionada) de /opt/mesapay/shared/mesapay-pgdump.sh. La
# dispara docs/cron/mesapay-pgdump.timer a las 03:30. Ver docs/backups.md.
#
# Produce, en $BACKUP_DIR (por defecto /var/backups/mesapay):
#   mesapay-AAAAMMDD-HHMM.dump            → pg_dump --format=custom (pg_restore)
#   mesapay-uploads-AAAAMMDD-HHMM.tar.gz  → árbol completo de $UPLOADS_DIR
# Los dos con la MISMA marca de tiempo: al restaurar, filas y bytes quedan
# alineados. Retención: $RETENTION_DAYS días (14).
#
# Esto NO es lo mismo que la copia por comercio de la app (tabla
# RestaurantBackup, Configuración → Copias de seguridad): esa vive DENTRO de
# la misma base y sirve para que un comercio deshaga un error propio. Si se
# pierde el disco del VPS se pierde con él. Este script es lo que queda.
#
# DATABASE_URL se lee con un grep PUNTUAL del .env.production. NUNCA se
# sourcea ese archivo: en 2026-09 contuvo un heredoc auto-replicante que
# creció a 106 MB y tumbó el deploy. Un `source` acá lo habría ejecutado.
#
# Uso:
#   bash mesapay-pgdump.sh                        # base + uploads + rotación
#   MESAPAY_BACKUP_ONLY=base    bash mesapay-pgdump.sh
#   MESAPAY_BACKUP_ONLY=uploads bash mesapay-pgdump.sh
#   MESAPAY_SKIP_RETENTION=1    bash mesapay-pgdump.sh   # no borra nada viejo
#   bash mesapay-pgdump.sh --verificar             # lista el último dump (pg_restore -l)
#
# Variables (todas opcionales):
#   MESAPAY_BACKUP_DIR      /var/backups/mesapay
#   MESAPAY_RETENTION_DAYS  14
#   MESAPAY_ENV_FILE        /opt/mesapay/shared/.env.production
#   MESAPAY_UPLOADS_DIR     /opt/mesapay/shared/uploads
#   MESAPAY_BACKUP_ONLY     todo | base | uploads
#   MESAPAY_SKIP_RETENTION  0 | 1
#   DATABASE_URL            si viene en el entorno, gana al archivo
#   PG_DUMP / PG_RESTORE    binarios (por si Postgres corre en Docker:
#                           PG_DUMP="docker exec -i mesapay-db pg_dump")
# ============================================================================
set -euo pipefail

BACKUP_DIR="${MESAPAY_BACKUP_DIR:-/var/backups/mesapay}"
RETENTION_DAYS="${MESAPAY_RETENTION_DAYS:-14}"
ENV_FILE="${MESAPAY_ENV_FILE:-/opt/mesapay/shared/.env.production}"
UPLOADS_DIR="${MESAPAY_UPLOADS_DIR:-/opt/mesapay/shared/uploads}"
ONLY="${MESAPAY_BACKUP_ONLY:-todo}"          # todo | base | uploads
SKIP_RETENTION="${MESAPAY_SKIP_RETENTION:-0}"
PG_DUMP="${PG_DUMP:-pg_dump}"
PG_RESTORE="${PG_RESTORE:-pg_restore}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] mesapay-pgdump: $*"; }
fail() { log "ERROR: $*" >&2; exit 1; }

# ── DATABASE_URL: grep puntual, sin source ──────────────────────────────────
resolver_database_url() {
  if [[ -n "${DATABASE_URL:-}" ]]; then echo "$DATABASE_URL"; return; fi
  [[ -f "$ENV_FILE" ]] || fail "no existe $ENV_FILE y DATABASE_URL no viene en el entorno"
  local valor
  valor="$(grep -m1 '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'"'"'\r' || true)"
  [[ -n "$valor" ]] || fail "no hay DATABASE_URL= en $ENV_FILE"
  limpiar_url_prisma "$valor"
}

# ── La URL de Prisma trae parámetros que libpq NO entiende ─────────────────
# `?schema=public`, `connection_limit`, `pool_timeout`, `pgbouncer`… son de
# Prisma; pg_dump los rechaza ("invalid URI query parameter: schema"). Se
# quitan de la query string y se deja el resto (sslmode, connect_timeout…).
limpiar_url_prisma() {
  local url="$1" base query
  [[ "$url" == *\?* ]] || { printf '%s' "$url"; return; }
  base="${url%%\?*}"
  query="$( (printf '%s' "${url#*\?}" | tr '&' '\n' \
    | grep -Ev '^(schema|connection_limit|pool_timeout|pgbouncer|statement_cache_size|socket_timeout)=' || true) \
    | paste -sd '&' -)"
  if [[ -n "$query" ]]; then printf '%s?%s' "$base" "$query"; else printf '%s' "$base"; fi
}

# ── Verificación: el último dump se puede leer entero ──────────────────────
if [[ "${1:-}" == "--verificar" ]]; then
  ultimo="$(ls -1t "$BACKUP_DIR"/mesapay-*.dump 2>/dev/null | head -n1 || true)"
  [[ -n "$ultimo" ]] || fail "no hay ningún mesapay-*.dump en $BACKUP_DIR"
  log "listando $ultimo (pg_restore -l)"
  n="$($PG_RESTORE -l "$ultimo" | grep -c 'TABLE DATA' || true)"
  log "OK: $n tablas con datos en el dump"
  ultimo_tar="$(ls -1t "$BACKUP_DIR"/mesapay-uploads-*.tar.gz 2>/dev/null | head -n1 || true)"
  if [[ -n "$ultimo_tar" ]]; then
    log "archivos en $(basename "$ultimo_tar"): $(tar -tzf "$ultimo_tar" | grep -vc '/$')"
  fi
  exit 0
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M)"

# ── 1) Base de datos (escritura atómica: .tmp → verificación → rename) ─────
if [[ "$ONLY" == "todo" || "$ONLY" == "base" ]]; then
  url="$(resolver_database_url)"
  destino="$BACKUP_DIR/mesapay-$STAMP.dump"
  log "volcando la base → $(basename "$destino")"
  # --format=custom: comprimido y restaurable por partes con pg_restore.
  # --no-owner/--no-privileges: restaurable en un clúster con otro rol.
  $PG_DUMP --format=custom --no-owner --no-privileges --dbname="$url" --file="$destino.tmp"
  $PG_RESTORE -l "$destino.tmp" >/dev/null || fail "el dump salió ilegible: $destino.tmp (se conserva para diagnóstico)"
  mv "$destino.tmp" "$destino"
  chmod 600 "$destino"
  log "base OK — $(du -h "$destino" | cut -f1)"
fi

# ── 2) Archivos subidos (logos, fotos, documentos) ─────────────────────────
if [[ "$ONLY" == "todo" || "$ONLY" == "uploads" ]]; then
  if [[ ! -d "$UPLOADS_DIR" ]]; then
    log "AVISO: $UPLOADS_DIR no existe — no hay uploads que respaldar"
  else
    kb_arbol="$(du -sk "$UPLOADS_DIR" | cut -f1)"
    kb_libres="$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}')"
    log "uploads: $(find "$UPLOADS_DIR" -type f | wc -l | tr -d ' ') archivo(s), $(( kb_arbol / 1024 )) MB — libres $(( kb_libres / 1024 )) MB"
    # Llenar el disco tumba producción entera: mejor no escribir que escribir a ciegas.
    if (( kb_libres < kb_arbol * 3 )); then
      fail "poco espacio en $BACKUP_DIR: NO se escribe el respaldo de uploads"
    fi
    destino="$BACKUP_DIR/mesapay-uploads-$STAMP.tar.gz"
    log "empaquetando uploads → $(basename "$destino")"
    # -C "$UPLOADS_DIR" . ⇒ rutas RELATIVAS: restaurar es extraer sobre la raíz.
    tar -czf "$destino.tmp" -C "$UPLOADS_DIR" .
    tar -tzf "$destino.tmp" >/dev/null || fail "el tar salió ilegible: $destino.tmp"
    mv "$destino.tmp" "$destino"
    chmod 600 "$destino"
    log "uploads OK — $(du -h "$destino" | cut -f1)"
  fi
fi

# ── 3) Rotación: nunca deja una familia sin NINGUNA copia ──────────────────
rotar() { # $1 = patrón
  local patron="$1" vivos
  vivos="$(find "$BACKUP_DIR" -maxdepth 1 -name "$patron" -type f | wc -l | tr -d ' ')"
  if (( vivos <= 1 )); then
    log "rotación: sólo queda $vivos copia de '$patron' — no se borra nada"
    return
  fi
  find "$BACKUP_DIR" -maxdepth 1 -name "$patron" -type f -mtime "+$RETENTION_DAYS" -print -delete \
    | sed "s|^|[$(date '+%Y-%m-%d %H:%M:%S')] mesapay-pgdump: rotado (>${RETENTION_DAYS}d): |"
}
if [[ "$SKIP_RETENTION" == "1" ]]; then
  log "rotación OMITIDA (MESAPAY_SKIP_RETENTION=1)"
else
  rotar 'mesapay-*.dump'
  rotar 'mesapay-uploads-*.tar.gz'
fi

log "OK"
