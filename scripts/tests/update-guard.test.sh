#!/usr/bin/env bash
# update-guard.test.sh — red de la actualización del freno de producción sin contraseña.
#
# Qué cuida: el permiso de sudo acotado deja correr como root, sin contraseña, UN guion sin argumentos
# (/opt/tycon/setup/update-guard.sh). Ese guion es lo único que la persona no ve correr, así que tiene que hacer sólo lo
# que una persona aceptaría a ciegas: poner al día el freno con la versión publicada y verificada contra GitHub, sólo hacia
# adelante, y sólo si la máquina tiene la marca de root que deja el instalador con la contraseña y la organización eligió
# «solo». Lo demás frena sin tocar /opt/tycon.
#
#   T28-T36, T63 — el guion: sin argumentos, entorno descartado, sólo la versión bajada, origen fijado, red, árbol, sólo
#                  avanza, registro e idempotencia, candado.
#   T37-T41      — el instalador: --allow-auto-update (guion, regla validada con visudo, dueños) y --remove-auto-update.
#   T43          — la guía produccion-con-permiso.md nombra el riesgo.
#   T55-T57, T60-T62 — lo que eligió la organización (guard.update) y la marca de root.
#
# 🔴 Nada acá toca el sistema de verdad: raíz de sistema falsa (TYCON_PROD_ROOT), HOME falso, «GitHub» de juguete
#    (scripts/tests/fixtures/toy-release-server.js), /etc/sudoers.d dentro de la raíz falsa y visudo -cf sobre archivos
#    temporales.
#
# Correr: bash scripts/tests/update-guard.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALADOR="$AQUI/scripts/production/install-guard.sh"
GUION="$AQUI/scripts/production/update-guard.sh"
PLANTILLA="$AQUI/scripts/production/sudoers.tycon-guard.template"
AVISO="$AQUI/scripts/hooks/guard-update-notice.js"
GUIA="$AQUI/guides/produccion-con-permiso.md"
TMP="$(mktemp -d)"
SRV_PID=""
trap '[ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null; rm -rf "$TMP"' EXIT
source "$AQUI/scripts/tests/lib/fake-home.sh"
fake_home_create "$TMP/home-suite"
fallos=0; pasaron=0
ok(){ echo "✅ update-guard: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ update-guard: $1"; fallos=$((fallos+1)); }
YO="$(id -un)"

mkdir -p "$TMP/bin"
printf '#!/usr/bin/env bash\necho "doble de sqlcmd"; exit 0\n' > "$TMP/bin/sqlcmd"; chmod +x "$TMP/bin/sqlcmd"
TEST_PATH="$TMP/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# la huella de todo lo que hay en una raíz falsa: «intacto» = la misma huella antes y después
# los permisos de un archivo, en macOS (stat -f) y en Linux (stat -c), donde corre la CI pública
#   (primero la de Linux: en macOS falla sin imprimir nada; al revés, en Linux `stat -f` imprime aunque falle)
modo(){ [ "$1" = -- ] && shift; stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }
foto(){ ( cd "$1" 2>/dev/null && find . \( -type f -o -type l \) -print0 | sort -z | xargs -0 shasum 2>/dev/null; find . -print | sort ) | shasum | cut -d' ' -f1; }

# ── la versión bajada: un repo que sirve el «GitHub» de juguete y una ~/.tycon/harness con su manifiesto ────────────────
CASA="$TMP/casa"; ARNES="$CASA/.tycon/harness"; ESTADO="$CASA/.tycon/state/harness-state.json"
SRC="$TMP/src"; BARE="$TMP/bare.git"; SRV="$TMP/srv"
mkdir -p "$CASA/.tycon/state" "$SRC" "$SRV"
ARCHIVOS_ARNES="$(sed -n '/^ARCHIVOS=(/,/^)/p' "$INSTALADOR" | grep '^  scripts/' | tr -d ' ')"
for f in $ARCHIVOS_ARNES scripts/production/install-guard.sh scripts/production/update-guard.sh scripts/production/origin-moves.json scripts/production/sudoers.tycon-guard.template; do
  [ -f "$AQUI/$f" ] || continue
  mkdir -p "$SRC/$(dirname "$f")"; cp "$AQUI/$f" "$SRC/$f"
done
# fechas fijas y sin mantenimiento automático: los commits del laboratorio no dependen del reloj
G(){ GIT_AUTHOR_DATE="2026-10-22T10:00:00Z" GIT_COMMITTER_DATE="2026-10-22T10:00:00Z" git -C "$SRC" -c maintenance.auto=false -c user.name=Lab -c user.email=lab@example.com "$@"; }
G init -q -b main >/dev/null 2>&1; G add -A >/dev/null; G commit -q -m "versión 1" >/dev/null
C1="$(G rev-parse HEAD)"
git clone -q --bare "$SRC" "$BARE"
printf '{ "auth": "none" }\n' > "$SRV/control.json"
node "$AQUI/scripts/tests/fixtures/toy-release-server.js" --repo "$BARE" --org lab-org --name arnes-lab --git "$(command -v git)" --control "$SRV/control.json" --log "$SRV/requests.log" --port-file "$SRV/ports.env" &
SRV_PID=$!
for i in $(seq 1 100); do [ -f "$SRV/ports.env" ] && break; sleep 0.1; done
API="$(sed -n 's/^API=//p' "$SRV/ports.env" 2>/dev/null)"
[ -n "$API" ] || no "el servidor de versiones de juguete no arrancó"

# baja la punta de main del repo a ~/.tycon/harness, con su manifiesto y el estado, como la deja el actualizador;
# $1 = commit (por defecto la punta). El perfil del equipo NO está en la versión: llega aparte (la capa del equipo).
bajar(){
  local c="${1:-$(G rev-parse HEAD)}" t perfil=""
  [ -f "$ARNES/team-profile.json" ] && perfil="$(cat "$ARNES/team-profile.json")"
  rm -rf "$ARNES"; mkdir -p "$ARNES"
  git -C "$SRC" archive "$c" | tar -x -C "$ARNES"
  t="$(G rev-parse "$c^{tree}")"
  G ls-tree -r "$c" | python3 -c '
import sys, json
files = []
for line in sys.stdin:
    meta, path = line.rstrip("\n").split("\t"); mode, typ, sha = meta.split()
    files.append({"mode": mode, "path": path, "blob": sha})
json.dump({"schema": 1, "version": sys.argv[4], "ref": "main", "commit": sys.argv[2], "tree": sys.argv[3], "files": files}, open(sys.argv[1], "w"), indent=1)' "$ARNES/.tycon-release.json" "$c" "$t" "2026.10.22.$(G rev-list --count "$c")"
  printf '{ "schema": 1, "mode": "managed", "source": "public", "tree": "%s", "sources": [ { "name": "harness", "kind": "release", "url": "https://github.com/lab-org/arnes-lab", "repo": "lab-org/arnes-lab", "ref": "main", "commit": "%s", "tree": "%s", "version": "x" } ], "channel": "latest", "version": { "number": "x" }, "managed": [] }\n' "$ARNES" "$c" "$t" > "$ESTADO"
  [ -n "$perfil" ] && printf '%s\n' "$perfil" > "$ARNES/team-profile.json"
  return 0
}
perfil(){ # $1 = valor de guard.update («-» = sin la clave, «ROTO» = JSON ilegible)
  case "$1" in
    -) printf '{ "ado": { "org": "https://dev.azure.com/lab-org" } }\n' > "$ARNES/team-profile.json" ;;
    ROTO) printf '{ roto' > "$ARNES/team-profile.json" ;;
    *) printf '{ "ado": { "org": "https://dev.azure.com/lab-org" }, "guard": { "update": "%s" } }\n' "$1" > "$ARNES/team-profile.json" ;;
  esac
}
# una versión nueva: cambia el freno (o, con $1 = otro, un archivo que no es del freno) y la publica en el repo de juguete
publicar(){
  if [ "${1:-}" = otro ]; then printf 'nota %s\n' "$RANDOM" >> "$SRC/README.md"; else printf '\n// versión nueva %s\n' "$RANDOM" >> "$SRC/scripts/hooks/prod-access-guard.js"; fi
  G add -A >/dev/null; G commit -q -m "versión nueva" >/dev/null; git -C "$SRC" push -q "$BARE" main 2>/dev/null
}
SYS="$TMP/sys"
inst(){ # el instalador con contraseña (la persona delante), sobre la raíz falsa; $@ = opciones
  mkdir -p "$SYS/Library/Application Support/ClaudeCode" "$SYS/opt" "$SYS/etc/sudoers.d"
  TYCON_PROD_TEST_PATH="$TEST_PATH" TYCON_PROD_NODE_LOCAL=1 TYCON_PROD_ROOT="$SYS" TYCON_PROD_HARNESS="$ARNES" TYCON_PROD_STATE="$ESTADO" \
    TYCON_RELEASE_API="$API" TYCON_PROD_ACCEPT_ORIGIN=1 HOME="$CASA" bash "$INSTALADOR" --no-sudo "$@" >"$TMP/inst.out" 2>&1
}
SETUP="$SYS/opt/tycon/setup"
upd(){ # el guion, como lo correría sudo: sin argumentos; $@ = argumentos de prueba (T28)
  TYCON_PROD_TEST_PATH="$TEST_PATH" TYCON_PROD_NODE_LOCAL=1 TYCON_PROD_ROOT="$SYS" TYCON_PROD_HARNESS="$ARNES" TYCON_PROD_STATE="$ESTADO" \
    TYCON_RELEASE_API="$API" HOME="$CASA" bash "$SETUP/update-guard.sh" "$@" >"$TMP/upd.out" 2>&1
}
dice(){ grep -q -- "$1" "$TMP/upd.out"; }
salida(){ tr '\n' ' ' < "$TMP/upd.out" | cut -c1-400; }

bajar; perfil auto
if [ ! -f "$GUION" ]; then no "update-guard.sh no existe todavía ($GUION)"; fi

# ── T37 · InstallGuard_AllowAutoUpdate_InstallsScriptAndRule ────────────────────────────────────────────────────────
if inst --allow-auto-update; then
  REGLA="$SYS/etc/sudoers.d/tycon-guard"
  if [ -f "$SETUP/update-guard.sh" ] && [ "$(modo -- "$SETUP/update-guard.sh")" = 755 ] && [ -f "$REGLA" ] \
     && grep -q "^$YO ALL=(root) NOPASSWD: /opt/tycon/setup/update-guard.sh \"\"$" "$REGLA" && [ "$(modo -- "$REGLA")" = 440 ]; then
    ok "T37 · --allow-auto-update deja el guion (755) y la regla escrita desde la plantilla con el usuario puesto (440)"
  else no "T37 · falta el guion o la regla: $(ls -l "$SETUP" 2>&1 | tr '\n' ' ') — regla: $(cat "$REGLA" 2>&1)"; fi
else no "T37 · --allow-auto-update con la organización en «auto» falló: $(grep '⛔' "$TMP/inst.out" | head -2 | tr '\n' ' ') $(tail -2 "$TMP/inst.out" | tr '\n' ' ')"; fi

# ── T56 · InstallGuard_AllowAutoUpdate_WritesAndRemovesMarker (la mitad que escribe) ────────────────────────────────
MARCA="$SYS/opt/tycon/production/auto-update.json"
if [ -f "$MARCA" ] && [ "$(modo -- "$MARCA")" = 644 ] && python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$MARCA" 2>/dev/null; then
  ok "T56a · la marca de root auto-update.json queda escrita (644)"
else no "T56a · falta la marca $MARCA o no es JSON"; fi

# ── T28 · UpdateGuard_AnyArgument_Exit2 ──────────────────────────────────────────────────────────────────────────────
F0="$(foto "$SYS")"
for a in "--from x" "--change-origin" "-x" ""; do
  if [ -z "$a" ]; then upd ""; else upd $a; fi; rc=$?
  if [ "$rc" = 2 ] && [ "$(foto "$SYS")" = "$F0" ]; then ok "T28 · con el argumento «${a}» sale 2 sin tocar nada"
  else no "T28 · con «${a}» salió $rc o cambió /opt — $(salida)"; fi
done

# ── T36 · UpdateGuard_LogsAndIsIdempotent ─────────────────────────────────────────────────────────────────────────────
publicar; bajar
LOG="$SYS/opt/tycon/production/update-log.jsonl"
if upd && [ -f "$LOG" ] && [ "$(wc -l < "$LOG" | tr -d ' ')" = 1 ] && cmp -s "$ARNES/scripts/hooks/prod-access-guard.js" "$SYS/opt/tycon/hooks/prod-access-guard.js"; then
  ok "T36a · con una versión nueva actualiza el freno y deja un renglón en update-log.jsonl"
else no "T36a · rc=$? — $(salida) — log: $(cat "$LOG" 2>&1 | head -2)"; fi
if python3 - "$LOG" "$YO" <<'PY' 2>/dev/null
import json, sys
r = json.loads(open(sys.argv[1]).read().splitlines()[-1])
assert r.get("from") and r.get("to") and r["from"] != r["to"] and r.get("user") == sys.argv[2] and r.get("at")
assert r.get("to_version") and r.get("from_version")
PY
then ok "T36b · el renglón trae de y a qué versión, el usuario y la hora"
else no "T36b · el renglón no trae lo pedido: $(tail -1 "$LOG" 2>&1)"; fi
[ "$(modo -- "$LOG" 2>/dev/null)" = 644 ] && ok "T36c · update-log.jsonl queda 644" || no "T36c · el registro no quedó 644"
F1="$(foto "$SYS")"
if upd && dice "sin versión nueva" && [ "$(foto "$SYS")" = "$F1" ]; then ok "T36d · una segunda corrida sin versión nueva no cambia nada y lo dice"
else no "T36d · la segunda corrida: $(salida)"; fi

# ── T29 · UpdateGuard_IgnoresEnvironment ──────────────────────────────────────────────────────────────────────────────
mkdir -p "$TMP/hostil"
for p in python3 git node; do printf '#!/bin/sh\ntouch "%s/usado-%s"\nexit 0\n' "$TMP/hostil" "$p" > "$TMP/hostil/$p"; chmod +x "$TMP/hostil/$p"; done
F1="$(foto "$SYS")"
PATH="$TMP/hostil:$PATH" TYCON_PROD_ACCEPT_ORIGIN=1 TYCON_ADO_ORG="https://dev.azure.com/ajena" TYCON_PROD_ORIGIN_MOVES="$TMP/mudanzas-ajenas.json" upd; rc=$?
if [ "$rc" = 0 ] && dice "sin versión nueva" && [ -z "$(ls "$TMP/hostil" | grep usado-)" ] && [ "$(foto "$SYS")" = "$F1" ]; then
  ok "T29 · con variables TYCON_* y un PATH hostiles el resultado es el mismo y no se usa nada del PATH"
else no "T29 · rc=$rc, usados: $(ls "$TMP/hostil" | grep usado- | tr '\n' ' ') — $(salida)"; fi

# ── T30 · UpdateGuard_TakesVerifiedReleaseNotClone ────────────────────────────────────────────────────────────────────
CLON="$TMP/clon"; rm -rf "$CLON"; git clone -q "$BARE" "$CLON"; cp "$ARNES/team-profile.json" "$CLON/"
printf '\n// retocado en el clon\n' >> "$CLON/scripts/hooks/prod-access-guard.js"
F1="$(foto "$SYS")"
TYCON_PROD_TEST_PATH="$TEST_PATH" TYCON_PROD_NODE_LOCAL=1 TYCON_PROD_ROOT="$SYS" TYCON_PROD_HARNESS="$CLON" TYCON_PROD_STATE="$ESTADO" \
  TYCON_RELEASE_API="$API" HOME="$CASA" bash "$SETUP/update-guard.sh" >"$TMP/upd.out" 2>&1; rc=$?
if [ "$rc" != 0 ] && dice "versión bajada" && [ "$(foto "$SYS")" = "$F1" ]; then ok "T30 · un clon no se instala: sólo la versión bajada y verificada"
else no "T30 · con un clon salió $rc — $(salida)"; fi

# ── T35 · UpdateGuard_Downgrade_Refuses ───────────────────────────────────────────────────────────────────────────────
ANTERIOR="$(G rev-parse HEAD)"; publicar otro; bajar
upd >/dev/null 2>&1 || no "T35 · no pudo poner al día la versión con un cambio fuera del freno: $(salida)"
bajar "$ANTERIOR"   # la versión anterior, con el mismo freno que la punta: la verificación la aceptaría
F1="$(foto "$SYS")"
if ! upd && dice "sólo avanza" && [ "$(foto "$SYS")" = "$F1" ]; then ok "T35 · una versión publicada anterior a la instalada no se instala («sólo avanza»)"
else no "T35 · la anterior: $(salida)"; fi
bajar

# ── T63 · UpdateGuard_ConcurrentRun_SecondRefuses ─────────────────────────────────────────────────────────────────────
CANDADO="$SYS/opt/tycon/production/update.lock"
mkdir -p "$CANDADO"; printf '%s\n' "$$" > "$CANDADO/pid"
F1="$(foto "$SYS")"
if ! upd && dice "ya hay una actualización corriendo" && [ "$(foto "$SYS")" = "$F1" ]; then ok "T63a · con otra corrida viva, la segunda sale sin tocar nada"
else no "T63a · con el candado vivo: $(salida)"; fi
printf '999999\n' > "$CANDADO/pid"
if upd && [ ! -e "$CANDADO" ]; then ok "T63b · un candado de un proceso que ya no existe se libera solo"
else no "T63b · con el candado viejo: $(salida)"; fi
rm -rf "$CANDADO"

# ── T34 · UpdateGuard_TreeMismatch_Refuses ────────────────────────────────────────────────────────────────────────────
publicar; bajar
cp "$ARNES/scripts/hooks/prod-access-guard.js" "$TMP/guarda.js"; printf 'X' >> "$ARNES/scripts/hooks/prod-access-guard.js"
F1="$(foto "$SYS")"
if ! upd && dice "NO es la publicada" && [ "$(foto "$SYS")" = "$F1" ]; then ok "T34 · un byte cambiado en la versión bajada frena sin tocar /opt"
else no "T34 · con un byte cambiado: $(salida)"; fi
cp "$TMP/guarda.js" "$ARNES/scripts/hooks/prod-access-guard.js"

# ── T33 · UpdateGuard_NoNetwork_FailsClosed ───────────────────────────────────────────────────────────────────────────
F1="$(foto "$SYS")"
API_BIEN="$API"; API="http://127.0.0.1:9"
if ! upd && dice "GitHub" && [ "$(foto "$SYS")" = "$F1" ]; then ok "T33 · sin el servidor de versiones falla cerrado"
else no "T33 · sin red: $(salida)"; fi
API="$API_BIEN"

# ── T32 · UpdateGuard_OriginChanged_Refuses ───────────────────────────────────────────────────────────────────────────
FIJADO="$SYS/opt/tycon/production/trusted-origin.json"; cp "$FIJADO" "$TMP/fijado.bak"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); d["url"]="https://github.com/otra-org/otro"; d["org"]="github:otra-org/otro"; d["repo"]="otra-org/otro"; json.dump(d, open(sys.argv[1],"w"))' "$FIJADO"
F1="$(foto "$SYS")"
if ! upd && dice "origen" && [ "$(foto "$SYS")" = "$F1" ]; then ok "T32 · con el origen fijado distinto no instala ni pregunta"
else no "T32 · origen cambiado: $(salida)"; fi
cp "$TMP/fijado.bak" "$FIJADO"

# ── T31 · UpdateGuard_NoTrustedOrigin_Refuses ─────────────────────────────────────────────────────────────────────────
mv "$FIJADO" "$TMP/fijado.fuera"
F1="$(foto "$SYS")"
if ! upd && dice "primera instalación" && [ "$(foto "$SYS")" = "$F1" ]; then ok "T31 · sin origen fijado: «la primera instalación pide contraseña»"
else no "T31 · sin origen fijado: $(salida)"; fi
mv "$TMP/fijado.fuera" "$FIJADO"

# ── T57 · UpdateGuard_ProfilePassword_Refuses ─────────────────────────────────────────────────────────────────────────
perfil password; F1="$(foto "$SYS")"
if ! upd && dice "con la contraseña" && [ "$(foto "$SYS")" = "$F1" ]; then ok "T57 · con la marca y el perfil en «password» se niega y lo dice"
else no "T57 · perfil en password: $(salida)"; fi

# ── T62 · UpdateGuard_ProfileMissingOrUnreadable_Refuses ──────────────────────────────────────────────────────────────
for v in - ROTO; do
  perfil "$v"; F1="$(foto "$SYS")"
  if ! upd && { dice "con la contraseña" || dice "no pude leer lo que eligió la organización"; } && [ "$(foto "$SYS")" = "$F1" ]; then ok "T62 · con el perfil «${v}» (sin la clave / ilegible) se niega con su motivo"
  else no "T62 · perfil «${v}»: $(salida)"; fi
done
perfil ROTO; upd; dice "no pude leer lo que eligió la organización" && ok "T62c · el perfil ilegible se nombra como ilegible" || no "T62c · ilegible sin decirlo: $(salida)"

# ── T60 · AutoUpdate_BrokenValue_TreatedAsPassword (el guion y el aviso) ──────────────────────────────────────────────
perfil si; F1="$(foto "$SYS")"
if ! upd && dice "roto" && dice "con la contraseña" && [ "$(foto "$SYS")" = "$F1" ]; then ok "T60a · guard.update «si» en el perfil: el guion lo trata como «password»"
else no "T60a · con «si» el guion: $(salida)"; fi
if [ -f "$AVISO" ]; then
  s="$(TYCON_PROD_ROOT="$SYS" TYCON_GUIDES_DIR="$ARNES" HOME="$CASA" node "$AVISO" 2>&1)"
  if grep -q "roto" <<< "$s" && grep -q -- "--remove-auto-update" <<< "$s"; then ok "T60b · el aviso dice que el valor está roto y lo trata como «con la contraseña» (pide sacar el permiso)"
  else no "T60b · el aviso con «si»: $(printf '%s' "$s" | tr '\n' ' ' | cut -c1-300)"; fi
else no "T60b · el aviso no existe todavía ($AVISO)"; fi

# ── T61 · UpdateGuard_ProfileAutoWithoutMarker_DoesNotEnable ──────────────────────────────────────────────────────────
perfil auto; mv "$MARCA" "$TMP/marca.fuera"; F1="$(foto "$SYS")"
if ! upd && dice "no tiene el permiso" && [ "$(foto "$SYS")" = "$F1" ]; then ok "T61 · el perfil en «auto» sin la marca de root no habilita nada"
else no "T61 · sin marca: $(salida)"; fi
mv "$TMP/marca.fuera" "$MARCA"

MARCA_VISTA=""; [ -f "$MARCA" ] && MARCA_VISTA=1
# ── T41 + T56b · InstallGuard_RemoveAutoUpdate_RemovesBoth / el marcador se borra ─────────────────────────────────────
if inst --remove-auto-update && [ ! -e "$SYS/etc/sudoers.d/tycon-guard" ] && [ ! -e "$SETUP/update-guard.sh" ]; then ok "T41 · --remove-auto-update saca la regla y el guion"
else no "T41 · después de sacar: $(ls "$SYS/etc/sudoers.d" "$SETUP" 2>&1 | tr '\n' ' ') — $(tail -2 "$TMP/inst.out" | tr '\n' ' ')"; fi
[ -n "$MARCA_VISTA" ] && [ ! -e "$MARCA" ] && ok "T56b · --remove-auto-update borra la marca de root" || no "T56b · la marca sigue después de sacar el permiso"

# ── T40 · InstallGuard_NoFlag_InstallsNothingExtra ────────────────────────────────────────────────────────────────────
if inst && [ ! -e "$SYS/etc/sudoers.d/tycon-guard" ] && [ ! -e "$SETUP/update-guard.sh" ] && [ ! -e "$MARCA" ] && [ -f "$SYS/opt/tycon/hooks/prod-access-guard.js" ]; then
  ok "T40 · sin la opción el instalador hace lo de siempre: ni guion, ni regla, ni marca"
else no "T40 · sin la opción: $(ls "$SYS/etc/sudoers.d" "$SETUP" 2>&1 | tr '\n' ' ') — $(grep '⛔' "$TMP/inst.out" | head -1)"; fi

# ── T55 + T60c · InstallGuard_AllowAutoUpdate_RefusesUnlessOrgSaysAuto ────────────────────────────────────────────────
for v in password - ROTO si; do
  perfil "$v"; rm -rf "$SYS"
  if ! inst --allow-auto-update && [ ! -e "$SYS/opt/tycon" ] && [ ! -e "$SYS/etc/sudoers.d/tycon-guard" ] && grep -q "organización" "$TMP/inst.out"; then
    ok "T55 · con el perfil «${v}», --allow-auto-update no instala nada y dice qué eligió la organización"
  else no "T55 · perfil «${v}»: $(grep '⛔' "$TMP/inst.out" | head -1) — $(ls "$SYS/opt" 2>&1)"; fi
done
grep -q "roto" "$TMP/inst.out" && ok "T60c · el instalador dice que el valor «si» está roto" || no "T60c · el instalador no dijo que el valor está roto: $(grep '⛔' "$TMP/inst.out" | head -1)"

# ── T38 · InstallGuard_AllowAutoUpdate_RejectsUnsafeAncestors ─────────────────────────────────────────────────────────
perfil auto
rm -rf "$SYS"; mkdir -p "$SYS/opt/tycon/setup"; chmod 777 "$SYS/opt/tycon"
if ! inst --allow-auto-update && [ ! -e "$SYS/etc/sudoers.d/tycon-guard" ] && [ ! -e "$MARCA" ] && grep -q "escribir" "$TMP/inst.out"; then ok "T38a · una carpeta escribible por otros en el camino del guion: ninguna regla puesta"
else no "T38a · con /opt/tycon escribible por otros: $(grep '⛔' "$TMP/inst.out" | head -1)"; fi
rm -rf "$SYS"; mkdir -p "$SYS/opt" "$TMP/setup-ajeno"; mkdir -p "$SYS/opt/tycon"; ln -s "$TMP/setup-ajeno" "$SYS/opt/tycon/setup"
if ! inst --allow-auto-update && [ ! -e "$SYS/etc/sudoers.d/tycon-guard" ] && [ ! -e "$MARCA" ] && grep -q "enlace" "$TMP/inst.out"; then ok "T38b · un enlace simbólico en el camino del guion: ninguna regla puesta"
else no "T38b · con setup como enlace: $(grep '⛔' "$TMP/inst.out" | head -1)"; fi

# ── T39 · InstallGuard_InvalidRule_NothingMoved ───────────────────────────────────────────────────────────────────────
if [ -x /usr/sbin/visudo ]; then
  rm -rf "$SYS"
  # una versión con la plantilla rota a propósito (y publicada: el instalador sólo copia lo verificado)
  printf '__USER__ ALL=(root NOPASSWD: /opt/tycon/setup/update-guard.sh\n' > "$SRC/scripts/production/sudoers.tycon-guard.template"
  G add -A >/dev/null; G commit -q -m "plantilla rota" >/dev/null; git -C "$SRC" push -q "$BARE" main 2>/dev/null; bajar
  if ! inst --allow-auto-update && [ -z "$(ls -A "$SYS/etc/sudoers.d" 2>/dev/null)" ] && [ ! -e "$MARCA" ] && grep -q "no valida" "$TMP/inst.out"; then
    ok "T39 · una regla que no valida no se mueve a sudoers.d y lo dice"
  else no "T39 · regla rota: $(ls -A "$SYS/etc/sudoers.d" 2>&1) — $(grep '⛔' "$TMP/inst.out" | head -1)"; fi
  git -C "$SRC" checkout -q HEAD~1 -- scripts/production/sudoers.tycon-guard.template; G add -A >/dev/null; G commit -q -m "plantilla sana" >/dev/null; git -C "$SRC" push -q "$BARE" main 2>/dev/null; bajar
else echo "⏭  update-guard: T39 salteada — no hay /usr/sbin/visudo en esta máquina (la regla no se puede validar sin él)"; fi

# ── T64-T69 · lo que encontró la primera vuelta de revisión: root no tiene que tomar nada que el usuario cambie ───────
rm -rf "$SYS"; bajar; perfil auto
inst --allow-auto-update || no "T64 · no se pudo preparar la máquina con el permiso: $(grep '⛔' "$TMP/inst.out" | head -1)"
publicar; bajar

# T64 · UpdateGuard_SymlinkInDownloadedVersion_Refuses
F1="$(foto "$SYS")"; ENL="$ARNES/scripts/hooks/prod-access-guard.js"
cp "$ENL" "$CASA/real.js"; rm -f "$ENL"; ln -s "$CASA/real.js" "$ENL"
if ! upd && dice "enlace" && [ "$(foto "$SYS")" = "$F1" ]; then ok "T64a · un enlace dentro de la versión bajada (con el contenido bueno) frena sin tocar /opt"
else no "T64a · con un enlace en la versión bajada: $(salida)"; fi
rm -f "$ENL"; cp "$CASA/real.js" "$ENL"
mv "$ARNES" "$CASA/harness-real"; ln -s "$CASA/harness-real" "$ARNES"
if ! upd && dice "enlace" && [ "$(foto "$SYS")" = "$F1" ]; then ok "T64b · la carpeta de la versión bajada como enlace frena sin tocar /opt"
else no "T64b · con la carpeta como enlace: $(salida)"; fi
rm -f "$ARNES"; mv "$CASA/harness-real" "$ARNES"

# T66 · UpdateGuard_DoesNotRecopySqlcmd (antes de actualizar: el sqlcmd del PATH cambia)
cp "$SYS/opt/tycon/bin/sqlcmd" "$TMP/sqlcmd.antes"
printf '#!/usr/bin/env bash\necho "sqlcmd cambiado por el usuario"; exit 0\n' > "$TMP/bin/sqlcmd"
# T65 · UpdateGuard_PlantedPythonModuleInCwd_NotLoaded (la actualización corre desde una carpeta con un json.py plantado)
PLANTADO="$TMP/plantado"; mkdir -p "$PLANTADO"
printf 'open(%s, "w").write("cargado")\n' "'$TMP/json-plantado-cargado'" > "$PLANTADO/json.py"
RENGLONES="$(wc -l < "$SYS/opt/tycon/production/update-log.jsonl" 2>/dev/null | tr -d ' ' || echo 0)"
( cd "$PLANTADO" && upd ); rc=$?
if [ "$rc" = 0 ] && dice "se actualizó solo" && [ "$(wc -l < "$SYS/opt/tycon/production/update-log.jsonl" | tr -d ' ')" -gt "${RENGLONES:-0}" ] && [ ! -e "$TMP/json-plantado-cargado" ]; then
  ok "T65a · la actualización corre desde una carpeta con un json.py plantado y no lo carga"
else no "T65a · rc=$rc, plantado cargado: $([ -e "$TMP/json-plantado-cargado" ] && echo sí || echo no) — $(salida)"; fi
# (la misma actualización, que corrió: lo dice T65a)
cmp -s "$SYS/opt/tycon/bin/sqlcmd" "$TMP/sqlcmd.antes" && ok "T66 · la actualización sin contraseña no vuelve a copiar sqlcmd del PATH del usuario" || no "T66 · /opt/tycon/bin/sqlcmd cambió en la actualización sin contraseña"

# T71 · UpdateGuard_NoSqlcmdInOpt_Refuses
publicar; bajar; mv "$SYS/opt/tycon/bin/sqlcmd" "$TMP/sqlcmd.fuera"
if ! upd && dice "sqlcmd" && [ ! -e "$SYS/opt/tycon/bin/sqlcmd" ]; then ok "T71 · sin sqlcmd de root, la actualización sin contraseña frena en vez de copiarlo del usuario"
else no "T71 · sin sqlcmd: $(salida)"; fi
mv "$TMP/sqlcmd.fuera" "$SYS/opt/tycon/bin/sqlcmd"

# T70 · UpdateGuard_InvalidInstalledRecord_Refuses
INST_REL="$SYS/opt/tycon/production/installed-release.json"; cp "$INST_REL" "$TMP/instalada.bak"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); d["commit"]="no-es-un-commit"; json.dump(d, open(sys.argv[1],"w"))' "$INST_REL"
F1="$(foto "$SYS")"
if ! upd && dice "ilegible" && [ "$(foto "$SYS")" = "$F1" ]; then ok "T70 · una constancia de lo instalado con un commit inválido frena (no apaga «sólo avanza»)"
else no "T70 · constancia inválida: $(salida)"; fi
cp "$TMP/instalada.bak" "$INST_REL"

# T67 · UpdateGuard_InstallerChanged_AsksForPassword (la versión nueva trae otro instalador)
cp "$SETUP/install-guard.sh" "$TMP/instalador.antes"
printf '\n# instalador nuevo %s\n' "$RANDOM" >> "$SRC/scripts/production/install-guard.sh"
G add -A >/dev/null; G commit -q -m "instalador nuevo" >/dev/null; git -C "$SRC" push -q "$BARE" main 2>/dev/null; bajar
F1="$(foto "$SYS")"
if ! upd && dice "contraseña" && [ "$(foto "$SYS")" = "$F1" ] && cmp -s "$SETUP/install-guard.sh" "$TMP/instalador.antes"; then
  ok "T67a · una versión con otro instalador no se instala sola: pide la contraseña y no renueva nada"
else no "T67a · con otro instalador: $(salida)"; fi
( cd "$PLANTADO" && inst ); rc=$?
if [ "$rc" = 0 ] && [ ! -e "$TMP/json-plantado-cargado" ]; then ok "T65b · tampoco lo carga el instalador con contraseña"
else no "T65b · rc=$rc — $(grep '⛔' "$TMP/inst.out" | head -1)"; fi
cmp -s "$SETUP/install-guard.sh" "$ARNES/scripts/production/install-guard.sh" && ok "T67b · una reinstalación con contraseña pone al día la copia de root del instalador" || no "T67b · la reinstalación con contraseña no puso al día /opt/tycon/setup/install-guard.sh"
# T65c · las rutas relativas se resuelven antes de pararse en /
if ( cd "$CASA" && TYCON_PROD_TEST_PATH="$TEST_PATH" TYCON_PROD_NODE_LOCAL=1 TYCON_PROD_ROOT="$SYS" TYCON_PROD_HARNESS=".tycon/harness" TYCON_PROD_STATE="$ESTADO" \
     TYCON_RELEASE_API="$API" TYCON_PROD_ACCEPT_ORIGIN=1 HOME="$CASA" bash "$INSTALADOR" --no-sudo >"$TMP/inst.out" 2>&1 ); then ok "T65c · el instalador con la carpeta del arnés relativa sigue andando (se resuelve antes del cd /)"
else no "T65c · con ruta relativa: $(grep '⛔' "$TMP/inst.out" | head -1)"; fi

# T68 · UpdateGuard_OfficialMoveStillRefuses
FIJADO="$SYS/opt/tycon/production/trusted-origin.json"; cp "$FIJADO" "$TMP/fijado68.bak"
printf '{"url": "https://dev.azure.com/lab-org/proj/_git/arnes", "org": "https://dev.azure.com/lab-org", "fijado": "2026-10-01T00:00:00Z"}\n' > "$FIJADO"
printf '{"moves": [{"from": {"azure_path": "proj/_git/arnes"}, "to": {"github_repo": "lab-org/arnes-lab"}, "message": "mudanza oficial de laboratorio"}]}\n' > "$TMP/mudanzas68.json"
cp "$TMP/mudanzas68.json" "$SETUP/origin-moves.json"
publicar; bajar; F1="$(foto "$SYS")"
if ! upd && dice "mudanza oficial" && [ "$(foto "$SYS")" = "$F1" ]; then ok "T68a · una mudanza oficial de origen no se acepta sin contraseña"
else no "T68a · con una mudanza oficial: $(salida)"; fi
if TYCON_PROD_TEST_PATH="$TEST_PATH" TYCON_PROD_NODE_LOCAL=1 TYCON_PROD_ROOT="$SYS" TYCON_PROD_HARNESS="$ARNES" TYCON_PROD_STATE="$ESTADO" \
     TYCON_RELEASE_API="$API" TYCON_PROD_ACCEPT_ORIGIN=0 TYCON_PROD_ORIGIN_MOVES="$TMP/mudanzas68.json" HOME="$CASA" bash "$INSTALADOR" --no-sudo >"$TMP/inst.out" 2>&1 \
   && grep -q "mudanza oficial de laboratorio" "$TMP/inst.out"; then ok "T68b · con contraseña la misma mudanza se acepta"
else no "T68b · con contraseña: $(grep '⛔' "$TMP/inst.out" | head -1)"; fi

# T69 · GuardUpdate_SameReadingInInstallerAndNotice (perfil con BOM y espacios alrededor del valor)
printf '\xef\xbb\xbf{ "ado": { "org": "https://dev.azure.com/lab-org" }, "guard": { "update": " auto " } }\n' > "$ARNES/team-profile.json"
js="$(node -e 'const c = require(process.argv[1]).cargar({ env: {}, arnes: process.argv[2] }); process.stdout.write(String(c.valores.guard.update))' "$AQUI/scripts/lib/tycon-config.js" "$ARNES" 2>&1)"
rm -rf "$SYS"
if inst --allow-auto-update; then inst_lee=auto; else inst_lee="no-auto: $(grep '⛔' "$TMP/inst.out" | head -1)"; fi
if [ "$js" = auto ] && [ "$inst_lee" = auto ]; then ok "T69 · el instalador y el lector del aviso leen igual un valor con BOM y espacios («auto»)"
else no "T69 · el lector dice «${js}», el instalador «${inst_lee}»"; fi
perfil auto

# ── la plantilla: sin comodines y con la ruta de root, sin argumentos ─────────────────────────────────────────────────
if [ -f "$PLANTILLA" ] && grep -q '^__USER__ ALL=(root) NOPASSWD: /opt/tycon/setup/update-guard.sh ""$' "$PLANTILLA" && ! grep -v '^#' "$PLANTILLA" | grep '\*' >/dev/null; then
  ok "T37b · la plantilla deja correr sólo /opt/tycon/setup/update-guard.sh, sin argumentos ni comodines"
else no "T37b · la plantilla no es la esperada: $(cat "$PLANTILLA" 2>&1 | tr '\n' ' ')"; fi

# ── T43 · Guide_ProduccionConPermiso_NamesTheRisk ─────────────────────────────────────────────────────────────────────
for frase in "--allow-auto-update" "cualquier programa que corra con tu usuario" "sin una persona" "--remove-auto-update"; do
  grep -qi -- "$frase" "$GUIA" && ok "T43 · la guía dice «${frase}»" || no "T43 · la guía no dice «${frase}»"
done
if grep -q "Actualizar el freno pide \`sudo\`" "$GUIA"; then no "T43 · la guía conserva la viñeta vieja «Actualizar el freno pide sudo»"; else ok "T43 · la viñeta vieja se reemplazó"; fi

echo "— update-guard: $pasaron ok, $fallos fallos —"
[ "$fallos" -eq 0 ]
