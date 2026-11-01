#!/usr/bin/env bash
# Blue/green deploy of the Code Mode gateway on the VPS. Called by
# .github/workflows/deploy-gateway.yml on a self-hosted runner; never by hand
# against production without reading docs first.
#
# One deploy = one release directory, started in the IDLE slot, health-checked on
# the loopback port of that slot, and only then pointed at by
# /srv/codemode/current (+ the nginx upstream, once the vhost is enabled). The
# slot that was live stays up, so a rollback is two symlink/sed writes and a
# reload: no restart, no downtime.
#
# The CODEMODE_* variables are overrides so the script can be rehearsed on a
# scratch root (see apps/gateway/README.md). Production runs it with the
# defaults.

set -euo pipefail

ROOT=${CODEMODE_ROOT:-/srv/codemode}
ENVDIR=${CODEMODE_ENVDIR:-/home/hermes/deploy/env}
CONF=${CODEMODE_NGINX_CONF:-/etc/nginx/sites-available/mcp.wefaber.net}
ENABLED=${CODEMODE_NGINX_ENABLED:-/etc/nginx/sites-enabled/mcp.wefaber.net}
PUBLIC_URL=${CODEMODE_PUBLIC_URL:-https://mcp.wefaber.net}
BUN=${CODEMODE_BUN:-/opt/bun/bun}
# systemd: production, one codemode-gateway@<slot> unit per slot.
# direct:  rehearsal only, the process is started with setsid and tracked by pid.
SLOT_RUNNER=${CODEMODE_SLOT_RUNNER:-systemd}
KEEP_RELEASES=${CODEMODE_KEEP_RELEASES:-5}

REPO=${GITHUB_WORKSPACE:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)}
RELEASE="$ROOT/releases/$(date -u +%Y%m%d-%H%M%S)-$(git -C "$REPO" rev-parse --short=8 HEAD)"
STEP=preflight
SWITCHED=0
SUCCESS=0

log() { printf '\n== %s\n' "$*"; }
die() { printf '::error::%s\n' "$*" >&2; exit 1; }

# The slot this deploy will use is the one NOT pointed at by `current`.
LIVE=$(basename -- "$(readlink "$ROOT/current" 2>/dev/null || echo blue)")
case "$LIVE" in
  blue | green) ;;
  *) LIVE=blue ;;  # first run: nothing is live yet
esac
IDLE=$([ "$LIVE" = blue ] && echo green || echo blue)
OLD_TARGET=$(readlink "$ROOT/current" 2>/dev/null || true)

port_of() {
  local file="$ENVDIR/codemode-gateway-$1.env"
  [ -f "$file" ] || die "falta $file (define PORT del slot $1)"
  local port
  port=$(sed -nE 's/^PORT=([0-9]+).*/\1/p' "$file" | head -1)
  [ -n "$port" ] || die "$file no define PORT"
  printf '%s' "$port"
}

slot_pidfile() { printf '%s/.rehearsal-%s.pid' "$ROOT" "$1"; }

start_slot() {
  local slot=$1
  if [ "$SLOT_RUNNER" = systemd ]; then
    sudo -n systemctl restart "codemode-gateway@$slot.service"
  else
    local pidfile; pidfile=$(slot_pidfile "$slot")
    [ -f "$pidfile" ] && kill "$(cat "$pidfile")" 2>/dev/null || true
    set -a
    # shellcheck disable=SC1090
    . "$ENVDIR/codemode-gateway.env"
    # shellcheck disable=SC1090
    . "$ENVDIR/codemode-gateway-$slot.env"
    set +a
    setsid "$BUN" "$ROOT/$slot/apps/gateway/src/index.ts" >"$ROOT/.rehearsal-$slot.log" 2>&1 &
    echo $! >"$pidfile"
  fi
}

switch_nginx() {  # rewrite the upstream port; no-op while the vhost is not enabled
  local port=$1
  [ -L "$ENABLED" ] || { log "nginx no habilitado: el upstream queda como está"; return 0; }
  sudo -n sed -E -i "s#^([[:space:]]*server 127\.0\.0\.1:)[0-9]+;#\1${port};#" "$CONF"
  sudo -n nginx -t || die "nginx -t rechaza $CONF"
  sudo -n systemctl reload nginx
}

point_current() {  # atomic symlink swap on the same filesystem
  local target=$1 tmp="$ROOT/.current.$$"
  ln -sfn "$target" "$tmp"
  mv -Tf "$tmp" "$ROOT/current"
}

wait_healthy() {
  local port=$1 what=$2 body code attempt
  for attempt in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/$what" || true)
    if [ "$code" = 200 ]; then
      body=$(curl -s "http://127.0.0.1:$port/$what" || true)
      case "$body" in
        *'"ok":true'*) return 0 ;;
      esac
      printf '   /%s responde 200 pero sin ok:true: %.120s\n' "$what" "$body"
    fi
    sleep 1
  done
  printf '   /%s no quedó sano en 30s (último código: %s)\n' "$what" "${code:-sin respuesta}" >&2
  return 1
}

# Runs on any non-zero exit, including a die() from a `cmd || die` (which does not
# trigger an ERR trap). SUCCESS marks the happy path so a clean run is a no-op.
on_exit() {
  local code=$?
  [ "$SUCCESS" = 1 ] && return 0
  [ "$code" -eq 0 ] && return 0
  trap - EXIT
  printf '\n::error::deploy falló en "%s" (exit %s). Rollback al slot %s.\n' "$STEP" "$code" "$LIVE" >&2
  # Por qué no arrancó: las últimas líneas del slot, antes de apagarlo.
  if [ "$SLOT_RUNNER" = systemd ]; then
    sudo -n journalctl -u "codemode-gateway@$IDLE.service" -n 8 --no-pager 2>&1 | sed 's/^/   /' >&2 || true
  elif [ -f "$ROOT/.rehearsal-$IDLE.log" ]; then
    tail -8 "$ROOT/.rehearsal-$IDLE.log" | sed 's/^/   /' >&2 || true
  fi
  if [ "$SWITCHED" = 1 ]; then
    point_current "$OLD_TARGET" || true
    switch_nginx "$(port_of "$LIVE")" || true
  fi
  # El slot anterior sigue corriendo: para volver no se reinicia nada.
  if [ "$SLOT_RUNNER" = systemd ]; then
    sudo -n systemctl stop "codemode-gateway@$IDLE.service" || true
  else
    local pidfile; pidfile=$(slot_pidfile "$IDLE")
    [ -f "$pidfile" ] && kill "$(cat "$pidfile")" 2>/dev/null || true
  fi
  if [ -d "$RELEASE" ]; then rm -rf "$RELEASE"; fi
  exit "$code"
}
trap on_exit EXIT

log 1/7 preflight
[ -x "$BUN" ] || die "no existe $BUN"
[ -d "$REPO/apps/gateway" ] || die "$REPO no parece el repo codemode"
[ -f "$ENVDIR/codemode-gateway.env" ] || die "falta $ENVDIR/codemode-gateway.env (WCM_GATEWAY_SECRET)"
grep -q '^WCM_GATEWAY_SECRET=' "$ENVDIR/codemode-gateway.env" || die "codemode-gateway.env no define WCM_GATEWAY_SECRET"
[ -d "$ROOT/data" ] && [ -w "$ROOT/data" ] || die "$ROOT/data no existe o no es escribible por $(id -un)"
IDLE_PORT=$(port_of "$IDLE")
if [ "$SLOT_RUNNER" = systemd ]; then
  sudo -n true || die "no hay sudo sin contraseña para el usuario $(id -un)"
  # La unit es la del repo: si falta en el host, se instala (idempotente).
  sudo -n install -o root -g root -m 644 "$REPO/apps/gateway/deploy/codemode-gateway@.service" \
    /etc/systemd/system/codemode-gateway@.service
  sudo -n systemctl daemon-reload
fi
printf '   live=%s idle=%s puerto=%s release=%s\n' "$LIVE" "$IDLE" "$IDLE_PORT" "$(basename "$RELEASE")"

log 2/7 preparar el release
mkdir -p "$RELEASE"
rsync -a --delete --exclude .git --exclude node_modules "$REPO/" "$RELEASE/"
(cd "$RELEASE" && "$BUN" install --frozen-lockfile)

log 3/7 apuntar el slot ocioso al release
ln -sfn "$RELEASE" "$ROOT/.$IDLE.$$"
mv -Tf "$ROOT/.$IDLE.$$" "$ROOT/$IDLE"

log 4/7 arrancar el slot $IDLE
STEP="arranque del slot $IDLE"
start_slot "$IDLE"

log 5/7 health check real del slot ocioso en 127.0.0.1:$IDLE_PORT
STEP="health check del slot $IDLE"
wait_healthy "$IDLE_PORT" health || die "el slot $IDLE no responde /health"
wait_healthy "$IDLE_PORT" ready || die "el slot $IDLE no responde /ready (base de datos)"
printf '   /health y /ready en 200 con ok:true\n'

log 6/7 switch a $IDLE
STEP="switch a $IDLE"
SWITCHED=1
point_current "$ROOT/$IDLE"
switch_nginx "$IDLE_PORT"
printf '   current -> %s ; upstream -> 127.0.0.1:%s\n' "$(readlink "$ROOT/current")" "$IDLE_PORT"

log 7/7 verificación pública
STEP="verificación pública"
if [ -L "$ENABLED" ]; then
  for attempt in 1 2 3 4 5; do
    if curl -fsS -m 10 "$PUBLIC_URL/health" | grep -q '"ok":true'; then
      printf '   %s/health responde ok:true (intento %s)\n' "$PUBLIC_URL" "$attempt"
      break
    fi
    [ "$attempt" = 5 ] && die "$PUBLIC_URL/health no confirma el switch"
    sleep 3
  done
else
  printf '   %s sigue en el Worker de wegraf (D1 sin cortar); verificado solo en loopback\n' "$PUBLIC_URL"
fi

SUCCESS=1
printf '\nDeploy ok: %s en el slot %s (puerto %s). El slot %s sigue arriba para rollback.\n' \
  "$(basename "$RELEASE")" "$IDLE" "$IDLE_PORT" "$LIVE"

# Podar releases viejos, nunca los que un slot o `current` siguen usando.
KEEP_PATHS=""
for keep in blue green current; do
  target=$(readlink -f "$ROOT/$keep" 2>/dev/null || true)
  [ -n "$target" ] && KEEP_PATHS="$KEEP_PATHS $target"
done
idx=0
while IFS= read -r dir; do
  idx=$((idx + 1))
  [ "$idx" -le "$KEEP_RELEASES" ] && continue
  case " $KEEP_PATHS " in
    *" $dir "*) continue ;;
  esac
  rm -rf "$dir"
done < <(find "$ROOT/releases" -maxdepth 1 -mindepth 1 -type d -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
