#!/usr/bin/env bash
# harness-team.test.sh — la capa del equipo sobre la versión bajada (T3, T6, T7, T8 y T9, con T2
# fundida en T9): el GitHub de juguete con DOS repos (la copia pública y el repo privado del equipo), cada uno con su
# control de acceso.
#
# Lo que no se puede perder:
#   T7 · `install --version latest --team <org>/<repo>` deja los dos archivos de la capa y su manifiesto en ~/.tycon/harness;
#        `explain` del árbol instalado lee el perfil del equipo con origen «perfil» (ado.org, engram, el buzón prendido por
#        su llave); `doctor --json` sin fail; el estado guarda `team` con el commit; `--dry-run` nombra la capa sin escribir;
#        una máquina YA instalada vuelve a apilar la capa que el estado recuerda (sin --team).
#   T8 · sin acceso al repo del equipo (sin permiso · un permiso que ve sólo la copia, con 404 o con 403 · falta aceptar la
#        invitación): 1 SIN escribir ni registrar nada (HOME idéntica por hash, startup.log incluido), con UNA acción que
#        nombra los dos repos y cuál no se ve; el valor del permiso no aparece en nada de lo escrito.
#   T3 · el comprimido del repo del equipo se verifica por el árbol: cortado o alterado se rechaza sin dejar nada; lo bajado
#        queda en ~/.tycon/team/<commit>/ con manifiesto, y la segunda vez con el mismo commit no se vuelve a pedir.
#   T6 · un commit nuevo del repo del equipo con el perfil ilegible, con una clave inventada, con un token o con install.home:
#        la versión pública nueva se instala con la capa ANTERIOR (arrastrada), el aviso nombra archivo · clave · motivo, y
#        la configuración de la máquina no queda rota (tycon-config.js validate sale 0).
#   T9 · (con T2) update: la punta del repo del equipo se apila sobre la versión nueva; el campo `team` sobrevive a update,
#        startup y rollback; sin acceso, la capa instalada se arrastra y se dice; una versión pública que trae una ruta de la
#        capa no se instala, queda anotada como fallida y no se vuelve a bajar.
#   T9P · las plantillas de un paquete que sólo acepta la versión nueva se apilan con su código antes del aplicador.
#   T9F · el reintento con el código nuevo: sin guion, tiempo agotado, salida distinta de 0, respuesta ilegible y «apilé»
#         sin la entrada del estado dan `failed` sin tocar el estado; team-after-swap.js sale 2 con una entrada ilegible.
#   T10 · un commit SÓLO del equipo llega en el arranque fuera de la ventana, dentro de harness/: atómico como
#        transacción (un archivo que no se puede reemplazar deja todo como estaba), lo que ya no viene se borra sólo con su
#        blob, lo editado a mano no se pisa, el aplicador de ESE arranque lee el perfil nuevo; una punta rechazada no se
#        revalida; dentro de la ventana, cero pedidos.
#   T11 · doctor: la línea de la capa, lo editado y lo faltante como aviso (nunca fail), la capa declarada y ausente,
#        el motivo del último refresco fallido, el paquete del equipo que falta; sin capa, ninguna línea nueva.
#   T12 · rollback sigue a la capa del árbol que queda; uninstall conserva y nombra ~/.tycon/team y copia lo editado a
#        kept-…/ (también desde la copia fija de arranque); sin capa, la línea de siempre.
#
#   TPN · el perfil con su nombre actual, team-profile.json: install --team con el repo del equipo que ya lo renombró deja
#        team-profile.json (y no el de antes) y explain lo lee con origen «perfil»; con el nombre de antes, el plan avisa
#        cómo renombrarlo; con los dos, el refresco deja sólo el nuevo y explain lee el nuevo.
#
#   T33 · la capa con el mapa de renombres real sobre una versión que no lo trae: install sale 0 y la
#        máquina traduce una variable vieja, un subcomando viejo y un archivo de estado viejo igual que el árbol interno; el
#        commit que saca el mapa (su retiro) lo borra en el refresco y deja de traducirlos.
#
# Laboratorio: scripts/tests/lib/harness-lab.sh (harness_lab_team_repo / harness_lab_team_server). Nunca ~/.claude ni el
# checkout real. 🔴 Sin pipes sobre el comando medido. El perfil del laboratorio (TYCON_PROFILE) se VACÍA: la variable le
# ganaría al árbol y el perfil que se mide es el de la capa.
#
# Uso: bash scripts/tests/harness-team.test.sh [--only T3|T6|T7|T8|T9|T9N|T9P|T9F|T10|T11|T12|T33|TPN]
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
export TYCON_UPDATE_APPLY=auto
# La llave del buzón se busca en el árbol instalado, que es lo que se mide acá (T7: la que apila la capa del equipo). Quien
# corre esta suite puede traer TYCON_MAILBOX_JSON apuntando a otro lado: las portables la ponen en un archivo que no
# existe, a propósito, y con ella heredada T7 daría «buzón: prendida (perfil; llave AUSENTE)» en una máquina vacía, adentro
# de la copia y en el interno. En una máquina de verdad nadie la define.
unset TYCON_MAILBOX_JSON
# Lo mismo con el interruptor del buzón que pone el corredor de suites: T7 mide justo que el buzón quede prendido por la
# llave de la capa, y con TYCON_MAILBOX=0 heredado daría «apagada (env)». TYCON_NO_UPLOAD_RUNS=1 queda: estas
# instalaciones de laboratorio no tienen por qué subir nada.
unset TYCON_MAILBOX TYCON_SUITE_RUNNER
ONLY=""; [ "${1:-}" = "--only" ] && ONLY="${2:-}"
corre() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
BASE="$(mktemp -d)"
# nunca dentro del repo bajo prueba ni de una HOME de verdad (el nombre del repo interno no se escribe: T52 de export-real)
case "$BASE" in "$RAIZ"*|*agent-skills*|*/.claude*) echo "❌ harness-team: el laboratorio cayó en ${BASE}"; exit 1 ;; esac
trap 'rm -rf "$BASE"; kill $(jobs -p) 2>/dev/null' EXIT
j() { python3 -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print($2)" "$1" 2>/dev/null; }
jtxt() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
ESTADO() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"; }
estado() { j "$(ESTADO)" "$1"; }
TYCON_DIR() { printf '%s' "$LAB_HOME/.tycon"; }
NEW() { printf '%s' "$LAB_HOME/.tycon/harness"; }
pedidos() { local n; n="$(grep -c -- "$1" "$LAB_RELEASE_LOG" 2>/dev/null)"; printf '%s' "${n:-0}"; }
explain_key() { # explain_key <árbol> <sección> <clave> → «valor origen»
  node "$1/scripts/lib/tycon-config.js" explain --json 2>/dev/null | python3 -c '
import json,sys
d=json.load(sys.stdin); s,c=sys.argv[1],sys.argv[2]; print("%s %s" % (json.dumps(d["valores"][s][c]), d["origenes"]["%s.%s" % (s,c)]))' "$2" "$3"
}
explain_integration() { node "$1/scripts/lib/tycon-config.js" explain --json 2>/dev/null | jtxt "d['integraciones']['$2']"; }
# la máquina sin arnés + el servidor con los DOS repos + una versión pública publicada; el perfil del laboratorio, vacío
lab_team() { # lab_team <dir>
  harness_lab_create "$1"
  export TYCON_PROFILE=
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.08.1
  harness_lab_team_repo
  harness_lab_team_server
  harness_lab_release_fresh_home
}
instala_team() { INSTALL_OUT="$(harness install --version latest --team "$LAB_TEAM" --yes 2>&1)"; INSTALL_RC=$?; }
team_head() { harness_lab_team_head; }
# edita el perfil del repo del equipo de juguete y publica
publica_perfil() { # publica_perfil '<json>' "<mensaje>"
  printf '%s\n' "$1" > "$LAB_AUTHOR_TEAM/perfil-equipo.json"
  harness_lab_team_publish "$2"
}

# ───────────────────────────────────────────── T7 ─────────────────────────────────────────────────────────────────────
if corre T7; then
  echo "T7 · install --team: la capa apilada, explain con origen perfil, el buzón prendido, doctor sin fail, team en el estado"
  lab_team "$BASE/lab7"
  H0="$(harness_lab_home_hash)"
  OUT="$(harness install --version latest --team "$LAB_TEAM" --dry-run 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "--dry-run sale 0" || mal "--dry-run rc $RC: $OUT"
  case "$OUT" in *"capa del equipo $LAB_TEAM @ "*"2 archivo(s) (equipo-lab; pide el arnés 2026.10.01.1 o posterior)"*"perfil-equipo.json, scripts/metrics/corridas-buzon.json"*) ok "el plan nombra la capa, su declaración y sus dos archivos" ;; *) mal "el plan no nombra la capa: $OUT" ;; esac
  [ "$(harness_lab_home_hash)" = "$H0" ] && ok "--dry-run no escribió nada" || mal "--dry-run escribió"
  instala_team
  [ "$INSTALL_RC" = 0 ] && ok "install --version latest --team sale 0" || mal "install --team salió $INSTALL_RC: $INSTALL_OUT"
  case "$INSTALL_OUT" in *"capa del equipo $LAB_TEAM @ "*"apilada en $(NEW)"*) ok "la salida cuenta la capa apilada" ;; *) mal "la salida no cuenta la capa: $INSTALL_OUT" ;; esac
  [ -f "$(NEW)/perfil-equipo.json" ] && [ -f "$(NEW)/scripts/metrics/corridas-buzon.json" ] && [ -f "$(NEW)/.tycon-team.json" ] && ok "los dos archivos de la capa y .tycon-team.json están en ~/.tycon/harness" || mal "falta algo de la capa: $(ls -a "$(NEW)" 2>/dev/null | tr '\n' ' ')"
  cmp -s "$(NEW)/perfil-equipo.json" "$LAB_AUTHOR_TEAM/perfil-equipo.json" && ok "el perfil apilado es byte a byte el del repo del equipo" || mal "el perfil apilado difiere del repo del equipo"
  case "$(explain_key "$(NEW)" ado org)" in *acme*" perfil") ok "explain: ado.org del equipo con origen perfil" ;; *) mal "explain ado.org: $(explain_key "$(NEW)" ado org)" ;; esac
  [ "$(explain_key "$(NEW)" integraciones engram)" = "true perfil" ] && ok "explain: engram prendida con origen perfil" || mal "engram: $(explain_key "$(NEW)" integraciones engram)"
  [ "$(explain_key "$(NEW)" packs default)" = "\"all\" perfil" ] && ok "explain: packs.default all con origen perfil" || mal "packs.default: $(explain_key "$(NEW)" packs default)"
  case "$(explain_integration "$(NEW)" mailbox)" in *"prendida (perfil; llave presente)"*) ok "el buzón queda prendido por su llave (la de la capa)" ;; *) mal "buzón: $(explain_integration "$(NEW)" mailbox)" ;; esac
  [ "$(estado "d['team']['repo']")" = "$LAB_TEAM" ] && [ "$(estado "d['team']['commit']")" = "$(team_head)" ] && [ "$(estado "d['team']['files']")" = 2 ] && [ "$(estado "d['team']['name']")" = equipo-lab ] && ok "el estado guarda team: repo, commit, 2 archivos, nombre" || mal "team en el estado: $(estado "d.get('team')")"
  [ "$(estado "d['channel']")" = latest ] && [ "$(estado "d['policy']['apply']")" = auto ] && ok "la política del estado es la del perfil del equipo (latest · auto): se releyó después de apilar" || mal "política del estado: $(estado "d.get('channel')") $(estado "d.get('policy')")"
  JSON="$(harness_release doctor --json 2>/dev/null)"
  [ "$(printf '%s' "$JSON" | jtxt "len(d['fail'])")" = 0 ] && ok "doctor --json sin fail" || mal "doctor fail: $(printf '%s' "$JSON" | jtxt "d['fail']")"
  case "$(printf '%s' "$JSON" | jtxt "' '.join(d['warn'])")" in *"perfil-equipo.json: de más"*|*"corridas-buzon.json: de más"*|*".tycon-team.json: de más"*) mal "doctor cuenta la capa «de más»" ;; *) ok "doctor no cuenta la capa como «de más»" ;; esac
  OUT="$(harness_release startup 2>&1)"
  case "$OUT" in *"canal vigente cambió"*) mal "el arranque siguiente dice que el canal cambió: $OUT" ;; *) ok "el arranque siguiente no anuncia un cambio de canal" ;; esac
  # una máquina YA instalada: sin --team, la capa que el estado recuerda se vuelve a apilar
  harness_lab_publish_stable 2026.10.08.2
  OUT="$(harness_release install --version latest --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "install --version latest sobre la máquina instalada sale 0 (sin --team)" || mal "reinstalar: rc $RC: $OUT"
  [ -f "$(NEW)/perfil-equipo.json" ] && [ "$(estado "d['team']['commit']")" = "$(team_head)" ] && [ "$(estado "d['version']['number']")" = 2026.10.08.2 ] && ok "…la versión nueva trae la capa que el estado recordaba" || mal "la reinstalación perdió la capa: $(estado "d.get('team')")"
  # `install --team` SOLO (sin --version ni --repo) sobre la máquina bajada toma el camino de la versión bajada (el
  # desvío de harness.js), no la instalación desde un clon
  # (la punta nueva apaga nightly: una clave que el laboratorio no fija por variable —TYCON_CODEX=0 le ganaría a codex—)
  publica_perfil '{ "ado": { "org": "https://dev.azure.com/acme" }, "integrations": { "engram": true, "nightly": false, "mailbox": true }, "update": { "channel": "latest", "apply": "auto" }, "packs": { "default": "all" }, "install": { "profile": "full" } }' "nightly apagada"
  OUT="$(harness_release install --team "$LAB_TEAM" --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "install --team solo (sin --version) sale 0 sobre la máquina bajada" || mal "install --team solo: rc $RC: $OUT"
  case "$OUT" in *"versión bajada, sin git"*) ok "…por el camino de la versión bajada" ;; *) mal "install --team solo no tomó el camino de la versión bajada: $OUT" ;; esac
  [ "$(estado "d['team']['commit']")" = "$(team_head)" ] && [ "$(explain_key "$(NEW)" integraciones nightly)" = "false perfil" ] && ok "…y apiló la punta nueva del equipo (nightly apagada, origen perfil)" || mal "install --team solo no apiló la punta nueva: $(estado "d.get('team')") nightly=$(explain_key "$(NEW)" integraciones nightly)"
  # la máquina bajada que PERDIÓ su árbol (~/.tycon/harness borrado) se reinstala con la capa que el estado recuerda:
  # sin mirar el estado con tree_missing, la capa se perdería para siempre
  rm -rf "$(NEW)"
  OUT="$(harness install --version latest --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "sin el árbol: install --version latest sale 0" || mal "sin el árbol: rc $RC: $OUT"
  [ -f "$(NEW)/perfil-equipo.json" ] && [ "$(estado "d['team']['commit']")" = "$(team_head)" ] && ok "…y vuelve con la capa que el estado recordaba" || mal "sin el árbol perdió la capa: $(estado "d.get('team')")"
  # el archivo de la máquina roto, con «auto» en el perfil del equipo: no frena la actualización, se DICE que no se usa
  harness_lab_release_fresh_home
  printf '{ roto\n' > "$LAB_HOME/.claude/tycon.json"
  instala_team
  case "$INSTALL_OUT" in *"el perfil del equipo fija la actualización automática: lo ilegible ("*") no se usa"*) ok "con la configuración de la máquina rota y «auto» en el perfil, install dice que lo ilegible no se usa" ;; *) mal "no dice lo ilegible (rc $INSTALL_RC): $INSTALL_OUT" ;; esac
  [ "$INSTALL_RC" = 0 ] && [ "$(estado "d['policy']['channel']")" = latest ] && ok "…y sigue con el canal del perfil" || mal "con la configuración rota: rc $INSTALL_RC, canal $(estado "d.get('policy')")"
  rm -f "$LAB_HOME/.claude/tycon.json"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T7m ────────────────────────────────────────────────────────────────────
# una máquina MUDADA a ~/.tycon (migrate --to-home, con Claude Code) suma la capa del
# equipo con `install --version latest --team`: el guardia («vive en la casa propia: se instaló sin Claude Code»)
# no tiene que frenarla con 2 sin escribir, porque no hay otro camino (update no tiene --team; migrate --team es sólo desde un clon)
if corre T7m; then
  echo "T7m · una máquina ya mudada a ~/.tycon suma la capa del equipo con install --version latest --team"
  harness_lab_create "$BASE/lab7m"
  export TYCON_PROFILE=
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.08.1
  harness_lab_team_repo
  harness_lab_team_server
  OUT="$(harness install --profile full --yes 2>&1)" || mal "la instalación desde el clon falló: $(printf '%s' "$OUT" | tail -2 | tr '\n' ' ')"
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ -f "$LAB_HOME/.tycon/state/harness-state.json" ] && ok "la máquina se mudó a ~/.tycon (sin repo del equipo)" || mal "migrate rc $RC: $OUT"
  MST() { printf '%s' "$LAB_HOME/.tycon/state/harness-state.json"; }
  case "$(j "$(MST)" "','.join(d.get('tools') or [])")" in *claude*) ok "…con Claude Code enchufado (su estado lo dice)" ;; *) mal "tools tras la mudanza: $(j "$(MST)" "d.get('tools')")" ;; esac
  OUT="$(harness_release install --version latest --team "$LAB_TEAM" --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "install --version latest --team sobre la máquina mudada sale 0" || mal "install --team en la máquina mudada: rc $RC: $OUT"
  case "$OUT" in *"se instaló sin Claude Code"*) mal "la frena el guardia de «sin Claude Code»" ;; *) ok "…sin el freno de «se instaló sin Claude Code»" ;; esac
  [ -f "$(NEW)/perfil-equipo.json" ] && [ -f "$(NEW)/.tycon-team.json" ] && ok "la capa quedó en ~/.tycon/harness" || mal "sin la capa: $(ls -a "$(NEW)" 2>/dev/null | tr '\n' ' ')"
  [ "$(j "$(MST)" "d['team']['commit']")" = "$(team_head)" ] && ok "el estado de la casa propia guarda team con el commit" || mal "team en el estado: $(j "$(MST)" "d.get('team')")"
  case "$(j "$(MST)" "','.join(d.get('tools') or [])")" in *claude*) ok "…y Claude Code sigue enchufado" ;; *) mal "tools tras install: $(j "$(MST)" "d.get('tools')")" ;; esac
  # desde un clon, en cambio, no se instala encima (partiría el estado en dos): 2, sin escribir, con el camino que corresponde
  H0="$(harness_lab_home_hash)"
  OUT="$(harness install --profile full --yes 2>&1)"; RC=$?
  [ "$RC" = 2 ] && [ "$(harness_lab_home_hash)" = "$H0" ] && ok "install desde un clon sobre la máquina mudada sale 2 sin escribir" || mal "install desde un clon: rc $RC: $OUT"
  case "$OUT" in *"se mudó"*"install --version latest"*) ok "…y dice que se instala con la versión bajada (y --team para la capa)" ;; *) mal "el mensaje no da el camino: $OUT" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T8 ─────────────────────────────────────────────────────────────────────
if corre T8; then
  echo "T8 · sin acceso al repo del equipo: 1 sin escribir nada, una acción que nombra los dos repos; el permiso nunca escrito"
  lab_team "$BASE/lab8"
  sin_acceso() { # sin_acceso <rótulo> <control json> [<permiso a guardar>]
    harness_lab_release_fresh_home
    harness_lab_release_control "$2"
    if [ -n "${3:-}" ]; then printf '%s' "$3" | harness config set github.token >/dev/null 2>&1; fi
    local h0 out rc
    h0="$(harness_lab_home_hash)"
    out="$(harness install --version latest --team "$LAB_TEAM" --yes 2>&1)"; rc=$?
    [ "$rc" = 1 ] && ok "$1: install sale 1" || mal "$1: rc $rc: $out"
    case "$out" in *"capa del equipo ($LAB_TEAM)"*"el repo $LAB_TEAM no está o no se ve"*) ok "$1: nombra el repo del equipo que no se ve" ;; *) mal "$1: no nombra el repo que no se ve: $out" ;; esac
    case "$out" in *"Contents: read sobre los repos $LAB_RELEASE_ORG/$LAB_RELEASE_NAME y $LAB_TEAM"*) ok "$1: la acción nombra los dos repos" ;; *) mal "$1: la acción no nombra los dos repos: $out" ;; esac
    [ "$(harness_lab_home_hash)" = "$h0" ] && ok "$1: HOME idéntica (ni estado, ni registro, ni ~/.tycon)" || mal "$1: escribió algo"
    [ -d "$(TYCON_DIR)/harness" ] && mal "$1: dejó ~/.tycon/harness" || ok "$1: nada instalado"
    SIN_ACCESO_OUT="$out"
  }
  # (a) sin permiso guardado: la copia se ve sin permiso, el repo del equipo no
  sin_acceso "sin permiso" "{ \"auth\": \"none\", \"auth_by_repo\": { \"$LAB_TEAM\": \"token:permiso-equipo-8\" } }"
  case "$SIN_ACCESO_OUT" in *"la probable: sin permiso guardado"*) ok "sin permiso: la causa probable es «sin permiso guardado»" ;; *) mal "sin permiso: causa: $SIN_ACCESO_OUT" ;; esac
  # (b) un permiso que ve SÓLO la copia: GitHub contesta 404 o 403 — las dos son «sin acceso»
  for st in 404 403; do
    sin_acceso "permiso que ve sólo la copia ($st)" "{ \"auth\": \"token:permiso-publico-8\", \"auth_by_repo\": { \"$LAB_TEAM\": \"token:permiso-equipo-8\" }, \"blind_status\": $st }" permiso-publico-8
    case "$SIN_ACCESO_OUT" in *"($st)"*) ok "…dice el código ($st)" ;; *) mal "no dice $st: $SIN_ACCESO_OUT" ;; esac
    case "$SIN_ACCESO_OUT" in *"el permiso vale pero no ve el repo $LAB_TEAM"*) ok "…y la causa probable: el permiso no ve el repo del equipo" ;; *) mal "causa: $SIN_ACCESO_OUT" ;; esac
    case "$SIN_ACCESO_OUT" in *permiso-publico-8*) mal "el valor del permiso aparece en la salida" ;; *) ok "el valor del permiso no aparece en la salida" ;; esac
    FOUND="$(grep -rl -- permiso-publico-8 "$LAB_HOME" 2>/dev/null | grep -v '/config.json$' || true)"
    [ -z "$FOUND" ] && ok "el valor del permiso no está en nada escrito salvo su archivo" || mal "el permiso aparece en: $FOUND"
  done
  # (c) falta aceptar la invitación
  sin_acceso "invitación pendiente" "{ \"auth\": \"token:permiso-publico-8\", \"auth_by_repo\": { \"$LAB_TEAM\": \"invited:permiso-publico-8\" } }" permiso-publico-8
  case "$SIN_ACCESO_OUT" in *"falta aceptar la invitación"*) ok "invitación: la acción lo dice" ;; *) mal "invitación: $SIN_ACCESO_OUT" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T3 ─────────────────────────────────────────────────────────────────────
if corre T3; then
  echo "T3 · el comprimido del repo del equipo: verificado por el árbol, cortado y alterado rechazados, caché por commit"
  lab_team "$BASE/lab3"
  for caso in truncate tamper; do
    harness_lab_release_fresh_home
    harness_lab_release_control "{ \"auth\": \"none\", \"$caso\": true, \"${caso}_repos\": [\"$LAB_TEAM\"] }"
    instala_team
    [ "$INSTALL_RC" = 1 ] && ok "$caso: install sale 1" || mal "$caso: rc $INSTALL_RC: $INSTALL_OUT"
    case "$caso:$INSTALL_OUT" in truncate:*"capa del equipo ($LAB_TEAM)"*"comprimido"*|tamper:*"no coincide con el commit"*) ok "$caso: el motivo nombra la capa y el comprimido/el árbol" ;; *) mal "$caso: motivo: $INSTALL_OUT" ;; esac
    [ -d "$(TYCON_DIR)/team" ] && mal "$caso: dejó ~/.tycon/team" || ok "$caso: no dejó caché"
    [ -d "$(TYCON_DIR)/harness" ] && mal "$caso: dejó ~/.tycon/harness" || ok "$caso: no dejó versión instalada"
    [ -z "$(ls -A "$(TYCON_DIR)/incoming" 2>/dev/null)" ] && ok "$caso: incoming/ vacío" || mal "$caso: incoming/ con restos: $(ls -A "$(TYCON_DIR)/incoming")"
  done
  harness_lab_release_fresh_home
  harness_lab_release_control '{ "auth": "none" }'
  instala_team
  [ "$INSTALL_RC" = 0 ] && ok "sano: install sale 0" || mal "sano: rc $INSTALL_RC: $INSTALL_OUT"
  HEAD12="$(team_head | cut -c1-12)"
  [ -f "$(TYCON_DIR)/team/$HEAD12/.tycon-team.json" ] && [ -f "$(TYCON_DIR)/team/$HEAD12/perfil-equipo.json" ] && ok "la caché ~/.tycon/team/<commit>/ con su manifiesto" || mal "sin caché: $(ls -R "$(TYCON_DIR)/team" 2>/dev/null | tr '\n' ' ')"
  [ "$(j "$(TYCON_DIR)/team/$HEAD12/.tycon-team.json" "d['commit']")" = "$(team_head)" ] && [ "$(j "$(TYCON_DIR)/team/$HEAD12/.tycon-team.json" "len(d['files'])")" = 2 ] && ok "el manifiesto de la caché: el commit y los 2 archivos con su blob" || mal "manifiesto de la caché: $(cat "$(TYCON_DIR)/team/$HEAD12/.tycon-team.json")"
  N1="$(pedidos "/repos/$LAB_TEAM/tarball/")"
  harness_lab_publish_stable 2026.10.08.2
  OUT="$(harness_release update --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "update a la versión pública nueva sale 0 (mismo commit del equipo)" || mal "update rc $RC: $OUT"
  N2="$(pedidos "/repos/$LAB_TEAM/tarball/")"
  [ "$N2" = "$N1" ] && ok "la segunda vez con el mismo commit no pide el comprimido del equipo (${N1} pedido(s) antes y después)" || mal "volvió a pedir el comprimido del equipo: $N1 → $N2"
  [ -f "$(NEW)/perfil-equipo.json" ] && [ "$(estado "d['team']['commit']")" = "$(team_head)" ] && ok "…y la capa quedó en la versión nueva, desde la caché" || mal "la capa no quedó: $(estado "d.get('team')")"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T6 ─────────────────────────────────────────────────────────────────────
if corre T6; then
  echo "T6 · un perfil nuevo que no vale no se apila: queda la capa anterior, el aviso nombra archivo · clave · motivo, la configuración no se rompe"
  lab_team "$BASE/lab6"
  instala_team
  [ "$INSTALL_RC" = 0 ] && ok "la capa sana instalada" || mal "install: rc $INSTALL_RC: $INSTALL_OUT"
  GOOD="$(team_head)"
  cp "$(NEW)/perfil-equipo.json" "$BASE/lab6/perfil-bueno.json"
  n=1
  while IFS='|' read -r rotulo perfil patron; do
    n=$((n+1))
    publica_perfil "$perfil" "perfil $rotulo"
    harness_lab_publish_stable "2026.10.08.$n"
    OUT="$(harness_release update --yes 2>&1)"; RC=$?
    [ "$RC" = 0 ] && ok "$rotulo: update de la versión pública sale 0 (la capa no la frena)" || mal "$rotulo: update rc $RC: $OUT"
    case "$OUT" in *"capa del equipo:"*"perfil-equipo.json"*) ok "$rotulo: el aviso nombra el archivo" ;; *) mal "$rotulo: el aviso no nombra el archivo: $OUT" ;; esac
    case "$OUT" in *$patron*) ok "$rotulo: el aviso dice la clave o el motivo («${patron}»)" ;; *) mal "$rotulo: el aviso no dice «${patron}»: $OUT" ;; esac
    case "$OUT" in *"sigue en $(printf '%s' "$GOOD" | cut -c1-7)"*) ok "$rotulo: …y que sigue la capa anterior" ;; *) mal "$rotulo: no dice que sigue la anterior: $OUT" ;; esac
    cmp -s "$(NEW)/perfil-equipo.json" "$BASE/lab6/perfil-bueno.json" && ok "$rotulo: el perfil instalado es el ANTERIOR (byte a byte)" || mal "$rotulo: el perfil instalado cambió"
    [ "$(estado "d['team']['commit']")" = "$GOOD" ] && ok "$rotulo: el estado sigue en el commit bueno" || mal "$rotulo: el estado: $(estado "d.get('team')")"
    [ "$(estado "d['version']['number']")" = "2026.10.08.$n" ] && ok "$rotulo: la versión pública sí se actualizó" || mal "$rotulo: versión: $(estado "d['version']['number']")"
    node "$(NEW)/scripts/lib/tycon-config.js" validate >/dev/null 2>&1 && ok "$rotulo: tycon-config.js validate sale 0 (la configuración no quedó rota)" || mal "$rotulo: validate salió $?"
  done <<'CASOS'
ilegible|{ roto|ilegible
clave inventada|{ "integrations": { "engram": true }, "inventada": { "x": 1 } }|inventada
con un token|{ "integrations": { "engram": true }, "github": { "token": "un-valor-cualquiera" } }|token
con install.home|{ "integrations": { "engram": true, "nightly": true, "mailbox": true }, "install": { "home": "tycon", "profile": "full" } }|install.home
CASOS
  # un perfil sano de vuelta: la capa nueva entra
  publica_perfil '{ "ado": { "org": "https://dev.azure.com/acme" }, "integrations": { "engram": true, "nightly": false, "mailbox": true }, "update": { "channel": "latest", "apply": "auto" }, "packs": { "default": "all" }, "install": { "profile": "full" } }' "perfil sano otra vez"
  harness_lab_publish_stable 2026.10.08.9
  OUT="$(harness_release update --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado "d['team']['commit']")" = "$(team_head)" ] && [ "$(explain_key "$(NEW)" integraciones nightly)" = "false perfil" ] && ok "un perfil sano de vuelta: la capa nueva entra (nightly apagada, origen perfil)" || mal "la capa sana nueva no entró: rc $RC $(estado "d.get('team')") $OUT"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T9 (con T2) ────────────────────────────────────────────────────────────
if corre T9; then
  echo "T9 · update: la punta del equipo sobre la versión nueva; team sobrevive a update/startup/rollback; sin acceso se arrastra; la colisión queda fallida"
  lab_team "$BASE/lab9"
  instala_team
  [ "$INSTALL_RC" = 0 ] && ok "instalada con la capa" || mal "install: rc $INSTALL_RC: $INSTALL_OUT"
  C0="$(team_head)"
  # (a) versión pública nueva + commit nuevo del equipo: la capa nueva en la versión nueva
  publica_perfil '{ "ado": { "org": "https://dev.azure.com/acme" }, "integrations": { "engram": true, "nightly": false, "mailbox": true }, "update": { "channel": "latest", "apply": "auto" }, "packs": { "default": "all" }, "install": { "profile": "full" } }' "nightly apagada"
  C1="$(team_head)"
  harness_lab_publish_stable 2026.10.08.2
  OUT="$(harness_release update --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "update sale 0" || mal "update rc $RC: $OUT"
  [ "$(estado "d['team']['commit']")" = "$C1" ] && [ "$(explain_key "$(NEW)" integraciones nightly)" = "false perfil" ] && ok "la capa nueva ($(printf '%s' "$C1" | cut -c1-7)) quedó en la versión nueva" || mal "la capa nueva no quedó: $(estado "d.get('team')") nightly=$(explain_key "$(NEW)" integraciones nightly)"
  [ -f "$(TYCON_DIR)/previous/.tycon-team.json" ] && [ "$(j "$(TYCON_DIR)/previous/.tycon-team.json" "d['commit']")" = "$C0" ] && ok "previous/ conserva la capa anterior ($(printf '%s' "$C0" | cut -c1-7))" || mal "previous/ sin la capa anterior"
  # (T2) el campo sobrevive a startup y a rollback (no se pierde); un estado sin team se lee como siempre
  harness_release startup >/dev/null 2>&1
  [ "$(estado "d['team']['commit']")" = "$C1" ] && ok "T2: team sobrevive a startup" || mal "T2: startup perdió team: $(estado "d.get('team')")"
  OUT="$(harness_release rollback 2>&1)"; RC=$?
  [ "$(estado "d.get('team') is not None")" = True ] && ok "T2: team sobrevive a rollback (rc $RC)" || mal "T2: rollback perdió team: $OUT"
  OUT="$(harness_release rollback 2>&1)"; RC=$?   # de vuelta a la versión nueva
  [ "$(estado "d['version']['number']")" = 2026.10.08.2 ] && ok "T2: vuelta a 2026.10.08.2 (rc $RC)" || mal "T2: no volvió: $(estado "d['version']['number']") $OUT"
  python3 - "$(ESTADO)" <<'PY'
import json,sys
f=sys.argv[1]; d=json.load(open(f)); d.pop('team', None); json.dump(d, open(f,'w'), indent=2)
PY
  OUT="$(harness_release doctor --json 2>/dev/null)"
  [ "$(printf '%s' "$OUT" | jtxt "len(d['fail'])")" = 0 ] && ok "T2: un estado SIN team se lee como hoy (doctor sin fail)" || mal "T2: estado sin team: $(printf '%s' "$OUT" | jtxt "d['fail']")"
  python3 - "$(ESTADO)" "$LAB_TEAM" "$C1" <<'PY'
import json,sys
f,repo,commit=sys.argv[1:4]; d=json.load(open(f)); d['team']={'repo':repo,'ref':'main','commit':commit,'tree':None,'etag':None,'name':'equipo-lab','files':2,'applied_at':None}; json.dump(d, open(f,'w'), indent=2)
PY
  # (b) sin acceso al repo del equipo: la capa instalada se arrastra a la versión nueva y se dice
  harness_lab_release_control "{ \"auth\": \"none\", \"auth_by_repo\": { \"$LAB_TEAM\": \"token:otro-permiso-9\" } }"
  harness_lab_publish_stable 2026.10.08.3
  OUT="$(harness_release update --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "sin acceso: update sale 0 (la pública se instala)" || mal "sin acceso: rc $RC: $OUT"
  case "$OUT" in *"capa del equipo: sin acceso"*"sigue en $(printf '%s' "$C1" | cut -c1-7)"*) ok "…y dice que la capa sigue en $(printf '%s' "$C1" | cut -c1-7)" ;; *) mal "no dice que la capa sigue: $OUT" ;; esac
  [ -f "$(NEW)/perfil-equipo.json" ] && [ "$(estado "d['team']['commit']")" = "$C1" ] && [ "$(estado "d['version']['number']")" = 2026.10.08.3 ] && ok "la capa arrastrada está en 2026.10.08.3" || mal "la capa no se arrastró: $(estado "d.get('team')") $(ls -a "$(NEW)" | tr '\n' ' ')"
  harness_lab_release_control '{ "auth": "none" }'
  # (c) una versión pública que trae una ruta de la capa: no se instala, queda fallida, no se vuelve a bajar
  harness_lab_publish_stable 2026.10.08.4 perfil-equipo.json '{ "integrations": { "engram": false } }'
  OUT="$(harness_release update --yes 2>&1)"; RC=$?
  [ "$RC" = 2 ] && ok "colisión: update sale 2" || mal "colisión: rc $RC: $OUT"
  case "$OUT" in *"trae perfil-equipo.json"*"choca con la capa del equipo"*) ok "…nombrando la ruta que choca" ;; *) mal "no nombra la ruta: $OUT" ;; esac
  [ "$(estado "d['version']['number']")" = 2026.10.08.3 ] && [ "$(estado "d['failed']['reason']")" = team-collision ] && ok "la máquina quedó en 2026.10.08.3 y la versión anotada como fallida (team-collision)" || mal "estado tras la colisión: $(estado "d['version']['number']") $(estado "d.get('failed')")"
  [ -z "$(ls -A "$(TYCON_DIR)/incoming" 2>/dev/null)" ] && ok "incoming/ vacío tras la colisión" || mal "incoming/ con restos"
  N1="$(pedidos "tarball/")"
  OUT="$(harness_release update 2>&1)"; RC=$?
  case "$OUT" in *"ya falló"*"no se reintenta"*) ok "el arranque siguiente no la vuelve a bajar (ya falló)" ;; *) mal "volvió a intentar: rc $RC $OUT" ;; esac
  [ "$(pedidos "tarball/")" = "$N1" ] && ok "…sin pedir ningún comprimido" || mal "pidió comprimidos: $N1 → $(pedidos "tarball/")"
  # (d) el choque se mira ANTES de bajar la capa también en install: una máquina nueva contra la versión que trae
  # perfil-equipo.json sale 1 sin pedir el comprimido del equipo ni dejar caché
  harness_lab_release_fresh_home
  rm -rf "$(TYCON_DIR)/team"
  N1="$(pedidos "/repos/$LAB_TEAM/tarball/")"
  instala_team
  [ "$INSTALL_RC" = 1 ] && ok "install --team contra una versión que trae una ruta de la capa sale 1" || mal "install colisión: rc $INSTALL_RC: $INSTALL_OUT"
  case "$INSTALL_OUT" in *"trae perfil-equipo.json"*"choca con la capa del equipo"*) ok "…nombrando la ruta que choca" ;; *) mal "install colisión no nombra la ruta: $INSTALL_OUT" ;; esac
  [ "$(pedidos "/repos/$LAB_TEAM/tarball/")" = "$N1" ] && ok "…sin pedir el comprimido del equipo (el choque se mira antes de bajar)" || mal "pidió el comprimido del equipo pese al choque"
  [ -d "$(TYCON_DIR)/team" ] && mal "install colisión dejó caché en ~/.tycon/team" || ok "…y sin dejar caché"
  [ -d "$(TYCON_DIR)/harness" ] && mal "install colisión instaló igual" || ok "…ni versión instalada"
  # (e) ni la punta del equipo ni la capa instalada sirven: la versión nueva NO se instala
  rm -f "$LAB_AUTHOR_TREE/perfil-equipo.json"   # la versión siguiente ya no trae la ruta de la capa
  harness_lab_publish_stable 2026.10.08.5 CHANGES "sin la ruta de la capa"
  harness_lab_release_fresh_home
  instala_team
  [ "$INSTALL_RC" = 0 ] && ok "(e) instalada con la capa" || mal "(e) install: rc $INSTALL_RC: $INSTALL_OUT"
  printf '{ "integrations": { "engram": true }, "editado": 1 }\n' > "$(NEW)/perfil-equipo.json"   # la capa instalada, editada a mano
  harness_lab_release_control "{ \"auth\": \"none\", \"auth_by_repo\": { \"$LAB_TEAM\": \"token:otro-permiso-9e\" } }"
  harness_lab_publish_stable 2026.10.08.6
  OUT="$(harness_release update --yes 2>&1)"; RC=$?
  [ "$RC" = 2 ] && ok "(e) repo del equipo mudo + capa instalada editada: update sale 2" || mal "(e) rc $RC: $OUT"
  case "$OUT" in *"no se instala hasta que"*) ok "(e) …y dice que la versión nueva no se instala hasta que haya capa" ;; *) mal "(e) no lo dice: $OUT" ;; esac
  [ "$(estado "d['version']['number']")" = 2026.10.08.5 ] && ok "(e) la máquina quedó en 2026.10.08.5" || mal "(e) versión: $(estado "d['version']['number']")"
  harness_lab_release_control '{ "auth": "none" }'
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T9N ────────────────────────────────────────────────────────────────────
# Una versión nueva que acepta en la capa una ruta que la instalada no conoce: quien valida la punta del equipo al instalar
# es el código que corre (el de la versión instalada), que la rechaza y arrastra la capa vieja. Sin más, la versión nueva
# queda con una capa vieja hasta otro arranque, y si la versión nueva saca piezas que trae la capa, la máquina se
# queda sin ellas. Después del cambio, la capa se vuelve a intentar con el código de la versión nueva, en la misma corrida.
if corre T9N; then
  echo "T9N · update: la punta que sólo acepta la versión nueva se apila en la misma ejecución, con el código de esa versión"
  lab_team "$BASE/lab9n"
  instala_team
  [ "$INSTALL_RC" = 0 ] && ok "instalada con la capa" || mal "install: rc $INSTALL_RC: $INSTALL_OUT"
  C0="$(team_head)"
  # la versión nueva: su lista cerrada de la capa acepta notes/<nombre>.md; la instalada no
  TEAM_NEW="$(python3 - "$LAB_AUTHOR_TREE/scripts/setup/harness/team.js" <<'PY'
import sys
t = open(sys.argv[1], encoding='utf-8').read()
a = 'const LAYER_PATTERNS = Object.freeze([\n'
assert t.count(a) == 1, 'LAYER_PATTERNS no está una sola vez'
sys.stdout.write(t.replace(a, a + '  new RegExp(`^notes/${SEG}\\\\.md$`),\n'))
PY
)"
  [ -n "$TEAM_NEW" ] && ok "la versión nueva acepta notes/<nombre>.md" || mal "no pude armar el team.js de la versión nueva"
  harness_lab_publish_stable 2026.10.08.2 scripts/setup/harness/team.js "$TEAM_NEW"
  mkdir -p "$LAB_AUTHOR_TEAM/notes" && printf '# una nota del equipo\n' > "$LAB_AUTHOR_TEAM/notes/extra.md"
  harness_lab_team_publish "una ruta que sólo la versión nueva acepta"
  C1="$(team_head)"
  OUT="$(harness_release update --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "update sale 0" || mal "update rc $RC: $OUT"
  [ "$(estado "d['version']['number']")" = 2026.10.08.2 ] && ok "la versión nueva quedó instalada" || mal "versión: $(estado "d['version']['number']")"
  [ "$(estado "d['team']['commit']")" = "$C1" ] && [ -f "$(NEW)/notes/extra.md" ] && [ "$(j "$(NEW)/.tycon-team.json" "d['commit']")" = "$C1" ] \
    && ok "la capa nueva ($(printf '%s' "$C1" | cut -c1-7)) quedó apilada en la misma ejecución" \
    || mal "la capa quedó en $(estado "d.get('team',{}).get('commit','—')[:7]") (la vieja era $(printf '%s' "$C0" | cut -c1-7)); notes/extra.md: $([ -f "$(NEW)/notes/extra.md" ] && echo está || echo falta) · $OUT"
  case "$OUT" in *"con el código de la versión nueva"*) ok "…y lo dice" ;; *) mal "no dice que la capa se apiló con el código de la versión nueva: $OUT" ;; esac
  # una punta que tampoco acepta la versión nueva: la capa sigue arrastrada, la versión se instala y se dice por qué
  mkdir -p "$LAB_AUTHOR_TEAM/nadie" && printf 'x\n' > "$LAB_AUTHOR_TEAM/nadie/acepta.md"
  harness_lab_team_publish "una ruta que ninguna versión acepta"
  harness_lab_publish_stable 2026.10.08.3
  OUT="$(harness_release update --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado "d['version']['number']")" = 2026.10.08.3 ] && ok "una punta que nadie acepta: la versión nueva igual se instala (rc 0)" || mal "punta inválida: rc $RC $(estado "d['version']['number']"): $OUT"
  [ "$(estado "d['team']['commit']")" = "$C1" ] && [ -f "$(NEW)/notes/extra.md" ] && ok "…la capa sigue en $(printf '%s' "$C1" | cut -c1-7)" || mal "…la capa cambió: $(estado "d.get('team')")"
  case "$OUT" in *"nadie/acepta.md"*) ok "…y dice la ruta que la versión nueva tampoco acepta" ;; *) mal "no dice la ruta rechazada: $OUT" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T9P ────────────────────────────────────────────────────────────────────
# Lo mismo que T9N con una ruta real de la capa: las plantillas de un paquete (packs/<p>/templates/). La versión
# instalada no las acepta y la nueva sí; la capa con el paquete se apila con el código nuevo ANTES del aplicador: el
# aplicador de esa misma corrida ya ve las plantillas (LAB_APPLIER_SEES).
if corre T9P; then
  echo "T9P · update: las plantillas de un paquete que sólo acepta la versión nueva llegan antes de enlazar las piezas"
  lab_team "$BASE/lab9p"
  TEAM_ORIG="$(cat "$LAB_AUTHOR_TREE/scripts/setup/harness/team.js")"
  TEAM_OLD="$(python3 - "$LAB_AUTHOR_TREE/scripts/setup/harness/team.js" <<'PY'
import sys
lines = open(sys.argv[1], encoding='utf-8').read().split('\n')
hit = [i for i, l in enumerate(lines) if l.lstrip().startswith('new RegExp(`^packs/${SEG}/templates/')]
assert len(hit) == 1, 'la línea de las plantillas no está una sola vez'
del lines[hit[0]]
sys.stdout.write('\n'.join(lines))
PY
)"
  [ -n "$TEAM_OLD" ] && ok "la versión instalada no acepta packs/<p>/templates/" || mal "no pude armar el team.js de la versión instalada"
  # una capa con paquetes pide el cargador de paquetes en la versión: va el pipeline de esta rama, sin sus pruebas
  mkdir -p "$LAB_AUTHOR_TREE/skills/tycon-pipeline"
  cp -R "$RAIZ/skills/tycon-pipeline/scripts" "$LAB_AUTHOR_TREE/skills/tycon-pipeline/"
  rm -rf "$LAB_AUTHOR_TREE/skills/tycon-pipeline/scripts/tests"
  printf -- '---\nname: publica-juguete\ndescription: skill pública de juguete\n---\n' > "$LAB_AUTHOR_TREE/skills/tycon-pipeline/SKILL.md"
  harness_lab_publish_stable 2026.10.08.2 scripts/setup/harness/team.js "$TEAM_OLD"
  instala_team
  [ "$INSTALL_RC" = 0 ] && ok "instalada (sin plantillas) con la capa" || mal "install: rc $INSTALL_RC: $INSTALL_OUT"
  PLANTILLA="packs/equipolab/templates/plantilla.json"
  mkdir -p "$LAB_AUTHOR_TEAM/packs/equipolab/templates" "$LAB_AUTHOR_TEAM/packs/equipolab/agents"
  printf '{ "name": "equipolab", "description": "paquete del equipo de juguete", "reviewers": [ { "agent": "rev-equipolab", "group": "base", "when": { "detection": "codeModified" }, "surface": { "paths": ["**/*.ts"] }, "depth": "standard", "prefixes": ["JUG"] } ] }\n' > "$LAB_AUTHOR_TEAM/packs/equipolab/pack.json"
  printf -- '---\nname: rev-equipolab\ndescription: revisor del equipo de juguete\n---\nRevisa cosas del equipo.\n' > "$LAB_AUTHOR_TEAM/packs/equipolab/agents/rev-equipolab.md"
  printf '{ "plantilla": true }\n' > "$LAB_AUTHOR_TEAM/$PLANTILLA"
  harness_lab_team_publish "un paquete con plantillas"
  C1="$(team_head)"
  harness_lab_publish_stable 2026.10.08.3 scripts/setup/harness/team.js "$TEAM_ORIG"
  OUT="$(LAB_APPLIER_SEES="$PLANTILLA" harness_release update --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado "d['version']['number']")" = 2026.10.08.3 ] && ok "update sale 0 con la versión nueva" || mal "update rc $RC $(estado "d['version']['number']"): $OUT"
  [ "$(estado "d['team']['commit']")" = "$C1" ] && [ -f "$(NEW)/$PLANTILLA" ] && [ -f "$(NEW)/packs/equipolab/pack.json" ] \
    && ok "el paquete con sus plantillas quedó apilado en la misma ejecución" \
    || mal "la capa quedó en $(estado "d.get('team',{}).get('commit','—')[:7]"); plantilla: $([ -f "$(NEW)/$PLANTILLA" ] && echo está || echo falta) · $OUT"
  RUN9P="$(grep "^run check=0" "$(dirname "$(ESTADO)")/lab-applier.log" 2>/dev/null | tail -n 1)"
  case "$RUN9P" in *"sees=1"*) ok "el aplicador de esa corrida ya ve las plantillas (la capa llegó antes de enlazar)" ;; *) mal "el aplicador no vio las plantillas: $RUN9P" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T9F ────────────────────────────────────────────────────────────────────
# Las ramas de falla del reintento con el código nuevo (refreshTeamWithNewCode): sin el guion, con el tiempo agotado,
# con una salida distinta de 0, con una respuesta ilegible y con «apilé» sin la entrada del estado. Cada una devuelve
# `failed`, no deja el estado tocado y dice por qué y que se reintenta. Y team-after-swap.js: sale 2 con una entrada que
# no se lee, y 0 con su línea JSON con una que sí. Sin red ni laboratorio: árboles de juguete con su propio guion.
if corre T9F; then
  echo "T9F · el reintento con el código nuevo: cada rama de falla y la entrada de team-after-swap.js"
  F9="$BASE/t9f"; mkdir -p "$F9"
  OUT="$(node - "$RAIZ" "$F9" <<'JS' 2>&1
const fs = require('fs'); const path = require('path');
const [root, base] = process.argv.slice(2);
const R = require(path.join(root, 'scripts', 'setup', 'harness', 'release.js'));
const home = path.join(base, 'home'); fs.mkdirSync(home, { recursive: true });
const ctx = { home, env: { HOME: home, PATH: process.env.PATH }, tree: root };
// a toy installed tree whose team-after-swap.js is the given body (null: the tree does not bring it)
let n = 0;
function tree(body) {
  const dir = path.join(base, `tree-${++n}`);
  fs.mkdirSync(path.join(dir, 'scripts', 'setup', 'harness'), { recursive: true });
  if (body !== null) fs.writeFileSync(path.join(dir, 'scripts', 'setup', 'harness', 'team-after-swap.js'), body);
  return dir;
}
const cases = [
  ['sin el guion', null, {}, /no se pudo evaluar con el código de la versión nueva \(la versión instalada no trae scripts.setup.harness.team-after-swap\.js\)/],
  ['tiempo agotado', 'setTimeout(() => {}, 60000);', { timeoutMs: 300 }, /se acabó el tiempo \(0 s\)/],
  ['sale distinto de 0', 'process.stderr.write("se rompió\\n"); process.exit(3);', {}, /salió 3: se rompió/],
  ['respuesta ilegible', 'process.stdout.write("esto no es json\\n");', {}, /salió 0 sin una respuesta que se lea/],
  ['apilé sin la entrada', 'process.stdout.write(JSON.stringify({ result: { status: "refreshed", lines: [] }, team: null, log: [] }) + "\\n");', {}, /dijo que apiló la capa pero no devolvió su entrada del estado/],
];
for (const [name, body, opts, want] of cases) {
  const state = { team: { repo: 'acme/equipo', commit: 'c0' } };
  const before = JSON.stringify(state);
  const logged = [];
  const r = R.refreshTeamWithNewCode(ctx, state, tree(body), Object.assign({ log: (l) => logged.push(l) }, opts));
  const text = (r.lines || []).join(' ');
  const okCase = r.status === 'failed' && want.test(text) && /se vuelve a intentar en el próximo arranque/.test(text) && JSON.stringify(state) === before && logged.some((l) => want.test(l)) && !r.answered;
  console.log(`${okCase ? 'OK' : 'MAL'} ${name}: ${r.status} · ${text} · estado ${JSON.stringify(state)}`);
}
JS
)"
  while IFS= read -r line; do
    case "$line" in "OK "*) ok "refreshTeamWithNewCode, ${line#OK }" ;; "MAL "*) mal "refreshTeamWithNewCode, ${line#MAL }" ;; *) mal "salida inesperada: $line" ;; esac
  done <<< "$OUT"
  SWAP="$RAIZ/scripts/setup/harness/team-after-swap.js"
  for entrada in '' 'no es json' '{"home":"x"}'; do
    SALIDA="$(printf '%s' "$entrada" | node "$SWAP" 2>&1)"; RC=$?
    [ "$RC" = 2 ] && ok "team-after-swap.js con la entrada «${entrada}» sale 2 (${SALIDA})" || mal "team-after-swap.js con «${entrada}»: rc $RC: $SALIDA"
  done
  # a readable entry without a team: one JSON line with result, team and log, exit 0; nothing written in the toy HOME
  SALIDA="$(printf '{"home":"%s","state":{}}' "$F9/home-swap" | HOME="$F9/home-swap" node "$SWAP" 2>/dev/null)"; RC=$?
  LINEA="$(printf '%s' "$SALIDA" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read().strip().split("\n")[-1]); print(sorted(d.keys()) == ["log","result","team"] and isinstance(d["result"].get("status"), str))' 2>/dev/null)"
  [ "$RC" = 0 ] && [ "$LINEA" = True ] && ok "team-after-swap.js con un estado sin capa sale 0 con su línea JSON (result, team, log)" || mal "team-after-swap.js con estado sin capa: rc $RC: $SALIDA"
fi

# ── ayudantes de T10-T12 ──────────────────────────────────────────────────────────────────────────────────
ventana() { # ventana now|none — la última mirada a la red: recién (dentro de la ventana) o nunca (fuera)
  python3 - "$(ESTADO)" "$1" <<'PY'
import json,sys,datetime
f,m=sys.argv[1:3]; d=json.load(open(f, encoding='utf-8'))
d['last_fetch']=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z') if m=='now' else None
d['last_fetch_failed']=None
json.dump(d, open(f,'w', encoding='utf-8'), indent=2)
PY
}
lineas() { local n; n="$(wc -l < "$LAB_RELEASE_LOG" 2>/dev/null)"; printf '%s' "${n// /}"; }
team_pedidos() { local n; n="$(grep -c -- "/repos/$LAB_TEAM/" "$LAB_RELEASE_LOG" 2>/dev/null)"; printf '%s' "${n:-0}"; }
applier_ultima() { tail -n 1 "$(dirname "$(ESTADO)")/lab-applier.log" 2>/dev/null; }
# las corridas del aplicador de juguete que escriben (las de --check se anotan en otro lado)
aplicador_corridas() { local n; n="$(grep -c '^run check=0' "$(dirname "$(ESTADO)")/lab-applier.log" 2>/dev/null)"; echo "${n:-0}"; }
STARTUP_LOG() { printf '%s' "$(dirname "$(ESTADO)")/harness/startup.log"; }
sha7() { printf '%s' "$1" | cut -c1-7; }
aviso() { estado "d.get('notice') or ''"; }
PERFIL_SIN_NIGHTLY='{ "ado": { "org": "https://dev.azure.com/acme" }, "integrations": { "engram": true, "nightly": false, "mailbox": true }, "update": { "channel": "latest", "apply": "auto" }, "packs": { "default": "all" }, "install": { "profile": "full" } }'
PERFIL_CON_NIGHTLY='{ "ado": { "org": "https://dev.azure.com/acme" }, "integrations": { "engram": true, "nightly": true, "mailbox": true }, "update": { "channel": "latest", "apply": "auto" }, "packs": { "default": "all" }, "install": { "profile": "full" } }'
LLAVE_2='{ "_que_es": "la llave de JUGUETE del buzón (laboratorio): no abre nada", "cuenta": "labcorridas", "contenedor": "corridas", "sas": "sv=lab&sig=juguete-2", "vence": "2099-01-01" }'

# ───────────────────────────────────────────── T10 ────────────────────────────────────────────────────────────────────
if corre T10; then
  echo "T10 · un cambio SÓLO del equipo: la capa se refresca dentro de harness/ en el arranque fuera de la ventana; lo editado no se pisa"
  lab_team "$BASE/lab10"
  export LAB_APPLIER_INTEG=1 TYCON_STARTUP_DETACH=0
  publica_perfil "$PERFIL_SIN_NIGHTLY" "nightly apagada al empezar"
  instala_team
  [ "$INSTALL_RC" = 0 ] && ok "instalada con la capa (nightly apagada)" || mal "install: rc $INSTALL_RC: $INSTALL_OUT"
  C0="$(team_head)"
  # (a) un commit nuevo del equipo (prende nightly, saca la llave) y un arranque DENTRO de la ventana: no se pide nada
  printf '%s\n' "$PERFIL_CON_NIGHTLY" > "$LAB_AUTHOR_TEAM/perfil-equipo.json"
  rm -f "$LAB_AUTHOR_TEAM/scripts/metrics/corridas-buzon.json"
  harness_lab_team_publish "prende nightly, saca la llave"
  C1="$(team_head)"
  ventana now
  N0="$(lineas)"
  harness_release startup >/dev/null 2>&1
  [ "$(lineas)" = "$N0" ] && ok "(a) dentro de la ventana: cero pedidos a la red" || mal "(a) dentro de la ventana pidió $(( $(lineas) - N0 )) cosa(s)"
  [ "$(estado "d['team']['commit']")" = "$C0" ] && ok "(a) …y la capa sigue en $(sha7 "$C0")" || mal "(a) la capa cambió dentro de la ventana"
  # (b) fuera de la ventana: el perfil nuevo en harness/, la llave borrada (tenía su blob), el manifiesto y el estado al día,
  # y el aplicador de ESE arranque ya lee nightly prendida
  ventana none
  OUT="$(harness_release startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "(b) el arranque sale 0" || mal "(b) startup rc $RC: $OUT"
  cmp -s "$(NEW)/perfil-equipo.json" "$LAB_AUTHOR_TEAM/perfil-equipo.json" && ok "(b) el perfil de harness/ es el del commit nuevo (byte a byte)" || mal "(b) el perfil no se refrescó"
  [ ! -e "$(NEW)/scripts/metrics/corridas-buzon.json" ] && ok "(b) la llave que el commit nuevo ya no trae, borrada (conservaba su blob)" || mal "(b) la llave sigue en harness/"
  [ "$(j "$(NEW)/.tycon-team.json" "d['commit']")" = "$C1" ] && [ "$(j "$(NEW)/.tycon-team.json" "len(d['files'])")" = 1 ] && ok "(b) .tycon-team.json con el commit nuevo y 1 archivo" || mal "(b) manifiesto: $(cat "$(NEW)/.tycon-team.json" 2>/dev/null)"
  [ "$(estado "d['team']['commit']")" = "$C1" ] && [ "$(estado "d['team']['files']")" = 1 ] && ok "(b) state.team con el commit nuevo" || mal "(b) state.team: $(estado "d.get('team')")"
  [ "$(estado "d['version']['number']")" = 2026.10.08.1 ] && ok "(b) la versión pública no cambió" || mal "(b) versión: $(estado "d['version']['number']")"
  case "$(applier_ultima)" in *"TYCON_INTEG_NIGHTLY=1"*) ok "(b) el aplicador de ese mismo arranque leyó nightly prendida" ;; *) mal "(b) el aplicador no leyó el perfil nuevo: $(applier_ultima)" ;; esac
  [ -z "$(find "$(NEW)" -maxdepth 3 -name '.tycon-team.tmp-*' 2>/dev/null)" ] && ok "(b) ningún temporal del refresco quedó en harness/" || mal "(b) quedaron temporales: $(find "$(NEW)" -name '.tycon-team.tmp-*')"
  # (c) otro arranque fuera de la ventana sin commit nuevo: un solo pedido al repo del equipo (la ref), ningún comprimido
  ventana none
  T0="$(team_pedidos)"; Z0="$(pedidos "/repos/$LAB_TEAM/tarball/")"
  harness_release startup >/dev/null 2>&1
  [ "$(( $(team_pedidos) - T0 ))" = 1 ] && ok "(c) sin commit nuevo: un solo pedido al repo del equipo (la ref)" || mal "(c) pidió $(( $(team_pedidos) - T0 )) cosas al repo del equipo"
  [ "$(pedidos "/repos/$LAB_TEAM/tarball/")" = "$Z0" ] && ok "(c) …ningún comprimido" || mal "(c) pidió el comprimido"
  # (d) el perfil editado a mano + un commit que vuelve a traer la llave y cambia el perfil: el editado no se pisa
  EDITADO='{ "integrations": { "engram": true, "nightly": true } }'
  printf '%s\n' "$EDITADO" > "$(NEW)/perfil-equipo.json"
  printf '%s\n' "$PERFIL_SIN_NIGHTLY" > "$LAB_AUTHOR_TEAM/perfil-equipo.json"
  mkdir -p "$LAB_AUTHOR_TEAM/scripts/metrics" && printf '%s\n' "$LLAVE_2" > "$LAB_AUTHOR_TEAM/scripts/metrics/corridas-buzon.json"
  harness_lab_team_publish "la llave de vuelta y nightly apagada"
  C2="$(team_head)"
  ventana none
  harness_release startup >/dev/null 2>&1
  [ "$(cat "$(NEW)/perfil-equipo.json")" = "$EDITADO" ] && ok "(d) el perfil editado a mano no se pisó" || mal "(d) el perfil editado se pisó"
  cmp -s "$(NEW)/scripts/metrics/corridas-buzon.json" "$LAB_AUTHOR_TEAM/scripts/metrics/corridas-buzon.json" && ok "(d) …la llave nueva sí entró" || mal "(d) la llave nueva no entró"
  case "$(aviso)" in *"perfil-equipo.json"*"editado"*) ok "(d) el aviso de la sesión nombra el archivo editado" ;; *) mal "(d) el aviso no nombra el editado: $(aviso)" ;; esac
  [ "$(estado "d['team']['commit']")" = "$C2" ] && ok "(d) state.team en el commit nuevo (el editado queda «editado» contra su manifiesto)" || mal "(d) state.team: $(estado "d.get('team')")"
  # …la llave editada a mano y un commit que la saca: no se borra, queda en `kept` del manifiesto
  printf '{ "editada": "a mano" }\n' > "$(NEW)/scripts/metrics/corridas-buzon.json"
  rm -f "$LAB_AUTHOR_TEAM/scripts/metrics/corridas-buzon.json"
  harness_lab_team_publish "saca la llave otra vez"
  C3="$(team_head)"
  ventana none
  harness_release startup >/dev/null 2>&1
  [ "$(cat "$(NEW)/scripts/metrics/corridas-buzon.json" 2>/dev/null)" = '{ "editada": "a mano" }' ] && ok "(d) la llave editada a mano que el commit nuevo saca NO se borró" || mal "(d) la llave editada se borró"
  case "$(aviso)" in *"corridas-buzon.json"*) ok "(d) …y el aviso la nombra" ;; *) mal "(d) el aviso no nombra la llave: $(aviso)" ;; esac
  [ "$(j "$(NEW)/.tycon-team.json" "' '.join(d.get('kept') or [])")" = scripts/metrics/corridas-buzon.json ] && ok "(d) …y queda en «kept» del manifiesto" || mal "(d) kept: $(j "$(NEW)/.tycon-team.json" "d.get('kept')")"
  [ "$(estado "d['team']['commit']")" = "$C3" ] && ok "(d) state.team en $(sha7 "$C3")" || mal "(d) state.team: $(estado "d.get('team')")"
  rm -f "$(NEW)/scripts/metrics/corridas-buzon.json"; printf '%s\n' "$PERFIL_SIN_NIGHTLY" > "$(NEW)/perfil-equipo.json"
  # (e) el repo del equipo sin acceso con un commit nuevo: nada cambia, el aviso dice «sigue en» y last_error lo guarda
  printf '%s\n' "$PERFIL_CON_NIGHTLY" > "$LAB_AUTHOR_TEAM/perfil-equipo.json"
  harness_lab_team_publish "nightly prendida, con el repo sin acceso"
  harness_lab_release_control "{ \"auth\": \"none\", \"auth_by_repo\": { \"$LAB_TEAM\": \"token:otro-permiso-10\" } }"
  ventana none
  OUT="$(harness_release startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "(e) repo del equipo sin acceso: el arranque sale 0" || mal "(e) rc $RC: $OUT"
  [ "$(estado "d['team']['commit']")" = "$C3" ] && cmp -s "$(NEW)/perfil-equipo.json" <(printf '%s\n' "$PERFIL_SIN_NIGHTLY") && ok "(e) nada cambió en harness/ ni en el commit del estado" || mal "(e) algo cambió: $(estado "d.get('team')")"
  case "$(aviso)" in *"capa del equipo"*"sigue en $(sha7 "$C3")"*) ok "(e) el aviso dice que la capa sigue en $(sha7 "$C3")" ;; *) mal "(e) aviso: $(aviso)" ;; esac
  [ -n "$(estado "(d['team'].get('last_error') or {}).get('reason','')")" ] && ok "(e) state.team.last_error guarda el motivo" || mal "(e) sin last_error: $(estado "d.get('team')")"
  harness_lab_release_control '{ "auth": "none" }'
  # (f) `update --check` no toca la capa; `update` (al día, aplica) la trae, lo dice y sale 0
  # …y el aplicador corre SÓLO en el update que refrescó la capa: un revisor que la capa mudó de carpeta queda con su
  # enlace viejo colgado hasta la sesión siguiente si nadie vuelve a enlazar
  C4="$(team_head)"
  A0="$(aplicador_corridas)"
  harness_release update --check >/dev/null 2>&1
  [ "$(estado "d['team']['commit']")" = "$C3" ] && ok "(f) update --check no tocó la capa" || mal "(f) --check tocó la capa: $(estado "d.get('team')")"
  harness_release update --dry-run >/dev/null 2>&1
  [ "$(estado "d['team']['commit']")" = "$C3" ] && ok "(f) update --dry-run tampoco" || mal "(f) --dry-run tocó la capa: $(estado "d.get('team')")"
  [ "$(aplicador_corridas)" = "$A0" ] && ok "(f) …y ninguno de los dos corrió el aplicador" || mal "(f) --check o --dry-run corrieron el aplicador $(( $(aplicador_corridas) - A0 )) vez/veces"
  OUT="$(harness_release update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado "d['team']['commit']")" = "$C4" ] && ok "(f) update al día trajo la capa nueva ($(sha7 "$C4")) y salió 0" || mal "(f) update: rc $RC $(estado "d.get('team')") $OUT"
  case "$OUT" in *"capa del equipo"*"$(sha7 "$C3")"*"$(sha7 "$C4")"*) ok "(f) …y lo dice (de $(sha7 "$C3") a $(sha7 "$C4"))" ;; *) mal "(f) update no lo dice: $OUT" ;; esac
  [ "$(estado "d['team'].get('last_error')")" = None ] && ok "(f) un refresco sano limpia last_error" || mal "(f) last_error sigue: $(estado "d['team'].get('last_error')")"
  [ "$(( $(aplicador_corridas) - A0 ))" = 1 ] && ok "(f) T22 Update_RefrescaLaCapa_VuelveAEnlazar @story-2.63 @ac-18: el update que refrescó la capa corrió el aplicador una vez" || mal "(f) T22: el update que refrescó la capa corrió el aplicador $(( $(aplicador_corridas) - A0 )) vez/veces (esperaba 1)"
  A1="$(aplicador_corridas)"
  harness_release update >/dev/null 2>&1
  [ "$(aplicador_corridas)" = "$A1" ] && ok "(f) T22: un update sin nada nuevo no corre el aplicador" || mal "(f) T22: un update sin nada nuevo corrió el aplicador $(( $(aplicador_corridas) - A1 )) vez/veces"
  # …y si el aplicador falla, update lo dice en una línea, sale 0 (la capa entró) y no anota piezas nuevas
  publica_perfil "$PERFIL_CON_NIGHTLY" "nightly prendida, con el aplicador fallando"
  C4b="$(team_head)"
  P0="$(estado "json.dumps(d.get('managed'), sort_keys=True)")"
  OUT="$(LAB_APPLIER_FAIL=1 harness_release update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado "d['team']['commit']")" = "$C4b" ] && ok "(f) T22: con el aplicador fallando, la capa entró y update salió 0" || mal "(f) T22: aplicador fallando: rc $RC $(estado "d.get('team')")"
  case "$OUT" in *"el aplicador falló"*) ok "(f) T22: …y lo dice en una línea" ;; *) mal "(f) T22: update no dice que el aplicador falló: $OUT" ;; esac
  [ "$(estado "json.dumps(d.get('managed'), sort_keys=True)")" = "$P0" ] && ok "(f) T22: …y no anotó piezas de un aplicador que falló" || mal "(f) T22: anotó piezas con el aplicador fallando"
  # (g) política ask y una versión pública nueva sin aplicar: la capa nueva entra igual
  publica_perfil "$PERFIL_SIN_NIGHTLY" "nightly apagada (ask)"
  C5="$(team_head)"
  harness_lab_publish_stable 2026.10.08.2
  ventana none
  TYCON_UPDATE_APPLY=ask harness_release startup >/dev/null 2>&1
  [ "$(estado "d['version']['number']")" = 2026.10.08.1 ] && ok "(g) con ask la versión pública nueva no se aplicó" || mal "(g) la pública se aplicó: $(estado "d['version']['number']")"
  [ "$(estado "d['team']['commit']")" = "$C5" ] && cmp -s "$(NEW)/perfil-equipo.json" "$LAB_AUTHOR_TEAM/perfil-equipo.json" && ok "(g) …y la capa nueva entró igual" || mal "(g) la capa no entró: $(estado "d.get('team')")"
  # de acá en adelante con «ask»: la versión pública 2026.10.08.2 espera y cada arranque mide SÓLO el refresco en el lugar
  export TYCON_UPDATE_APPLY=ask
  # (h) el estado con team y harness/ sin capa (el árbol que quedó no la traía): el arranque la vuelve a traer
  rm -f "$(NEW)/.tycon-team.json" "$(NEW)/perfil-equipo.json"
  ventana none
  harness_release startup >/dev/null 2>&1
  [ -f "$(NEW)/perfil-equipo.json" ] && [ "$(j "$(NEW)/.tycon-team.json" "d['commit']")" = "$C5" ] && ok "(h) sin capa en harness/: el arranque la vuelve a traer" || mal "(h) no la trajo: $(ls -a "$(NEW)" | tr '\n' ' ')"
  # (i) un manifiesto local que nombra version.json con su blob real: el refresco NO lo borra (sólo la lista cerrada)
  python3 - "$(NEW)/.tycon-team.json" "$(git hash-object "$(NEW)/version.json")" <<'PY'
import json,sys
f,b=sys.argv[1:3]; d=json.load(open(f)); d['files'].append({'path':'version.json','mode':'100644','blob':b}); json.dump(d, open(f,'w'), indent=1)
PY
  publica_perfil "$PERFIL_CON_NIGHTLY" "nightly prendida (i)"
  ventana none
  harness_release startup >/dev/null 2>&1
  [ -f "$(NEW)/version.json" ] && ok "(i) version.json sigue: el refresco sólo borra rutas de la lista cerrada" || mal "(i) el refresco borró version.json"
  [ "$(estado "d['team']['commit']")" = "$(team_head)" ] && ok "(i) …y la capa nueva entró" || mal "(i) state.team: $(estado "d.get('team')")"
  # (j) un commit que cambia update.channel: la política se relee después del refresco
  publica_perfil '{ "ado": { "org": "https://dev.azure.com/acme" }, "integrations": { "engram": true, "nightly": true, "mailbox": true }, "update": { "channel": "stable", "apply": "auto" }, "packs": { "default": "all" }, "install": { "profile": "full" } }' "canal stable"
  ventana none
  harness_release startup >/dev/null 2>&1
  [ "$(estado "d['channel']")" = stable ] && ok "(j) state.channel pasó a stable en el mismo arranque" || mal "(j) state.channel: $(estado "d.get('channel')")"
  K0="$(grep -c 'canal vigente cambió' "$(STARTUP_LOG)" 2>/dev/null)"
  ventana now
  harness_release startup >/dev/null 2>&1
  [ "$(grep -c 'canal vigente cambió' "$(STARTUP_LOG)" 2>/dev/null)" = "$K0" ] && ok "(j) el arranque siguiente no dice «el canal cambió»" || mal "(j) el arranque siguiente dijo que el canal cambió"
  # (k) la llave borrada a mano con la misma punta: repuesta desde la caché, sin bajar nada
  publica_perfil "$PERFIL_CON_NIGHTLY" "canal latest otra vez" && printf '%s\n' "$LLAVE_2" > "$LAB_AUTHOR_TEAM/scripts/metrics/corridas-buzon.json" && harness_lab_team_publish "la llave de vuelta (k)"
  ventana none
  harness_release startup >/dev/null 2>&1
  [ -f "$(NEW)/scripts/metrics/corridas-buzon.json" ] && ok "(k) la llave está (commit con la llave)" || mal "(k) la llave no entró"
  rm -f "$(NEW)/scripts/metrics/corridas-buzon.json"
  Z0="$(pedidos "/repos/$LAB_TEAM/tarball/")"; T0="$(team_pedidos)"
  ventana none
  harness_release startup >/dev/null 2>&1
  cmp -s "$(NEW)/scripts/metrics/corridas-buzon.json" "$LAB_AUTHOR_TEAM/scripts/metrics/corridas-buzon.json" && ok "(k) la llave borrada a mano, repuesta con la misma punta" || mal "(k) la llave no se repuso"
  [ "$(pedidos "/repos/$LAB_TEAM/tarball/")" = "$Z0" ] && [ "$(( $(team_pedidos) - T0 ))" -le 1 ] && ok "(k) …desde la caché (ningún comprimido; a lo sumo la ref)" || mal "(k) pidió de más: comprimidos ${Z0} → $(pedidos "/repos/$LAB_TEAM/tarball/"), pedidos $(( $(team_pedidos) - T0 ))"
  # (l) una punta rechazada (clave inventada): se dice, queda en rejected y el arranque siguiente no la revalida
  GOOD="$(team_head)"
  publica_perfil '{ "integrations": { "engram": true }, "inventada": { "x": 1 } }' "perfil con clave inventada"
  BAD="$(team_head)"
  ventana none
  harness_release startup >/dev/null 2>&1
  case "$(aviso)" in *"capa del equipo"*"inventada"*"sigue en $(sha7 "$GOOD")"*) ok "(l) el aviso dice el motivo y que sigue en $(sha7 "$GOOD")" ;; *) mal "(l) aviso: $(aviso)" ;; esac
  [ "$(estado "(d['team'].get('rejected') or {}).get('commit')")" = "$BAD" ] && ok "(l) state.team.rejected recuerda la punta rechazada" || mal "(l) rejected: $(estado "d['team'].get('rejected')")"
  T0="$(team_pedidos)"
  ventana none
  harness_release startup >/dev/null 2>&1
  [ "$(( $(team_pedidos) - T0 ))" = 1 ] && ok "(l) el arranque siguiente no la revalida: un solo pedido (la ref)" || mal "(l) revalidó: $(( $(team_pedidos) - T0 )) pedidos"
  case "$(aviso)" in *"inventada"*) ok "(l) …y el aviso sigue diciendo el motivo" ;; *) mal "(l) el aviso se perdió: $(aviso)" ;; esac
  # (m) la mirada a la copia pública bloqueada (sin permiso) y un commit sano del equipo: la capa entra igual
  publica_perfil "$PERFIL_SIN_NIGHTLY" "perfil sano (m)"
  harness_lab_release_control "{ \"auth\": \"token:solo-otro-11\", \"auth_by_repo\": { \"$LAB_TEAM\": \"none\" } }"
  ventana none
  harness_release startup >/dev/null 2>&1
  [ "$(estado "d['team']['commit']")" = "$(team_head)" ] && ok "(m) sin poder mirar la copia pública, la capa nueva entró" || mal "(m) la capa no entró: $(estado "d.get('team')")"
  [ "$(estado "d['team'].get('rejected')")" = None ] && ok "(m) …y rejected se limpió" || mal "(m) rejected sigue"
  harness_lab_release_control '{ "auth": "none" }'
  # (n) un archivo que no se puede reemplazar (un directorio en lugar de la llave): la transacción deja todo como estaba
  printf '%s\n' "$LLAVE_2" > "$LAB_AUTHOR_TEAM/scripts/metrics/corridas-buzon.json"
  harness_lab_team_publish "la llave (n0)"
  ventana none; harness_release startup >/dev/null 2>&1
  PREV="$(estado "d['team']['commit']")"
  cp "$(NEW)/perfil-equipo.json" "$BASE/lab10/perfil-n.json"; cp "$(NEW)/.tycon-team.json" "$BASE/lab10/manifiesto-n.json"
  rm -f "$(NEW)/scripts/metrics/corridas-buzon.json"; mkdir -p "$(NEW)/scripts/metrics/corridas-buzon.json"; printf 'x\n' > "$(NEW)/scripts/metrics/corridas-buzon.json/tapon"
  printf '%s\n' "$PERFIL_CON_NIGHTLY" > "$LAB_AUTHOR_TEAM/perfil-equipo.json"
  printf '{ "cuenta": "labcorridas", "contenedor": "corridas", "sas": "sv=lab&sig=juguete-3", "vence": "2099-01-01" }\n' > "$LAB_AUTHOR_TEAM/scripts/metrics/corridas-buzon.json"
  harness_lab_team_publish "perfil y llave nuevos (n)"
  ventana none
  harness_release startup >/dev/null 2>&1
  cmp -s "$(NEW)/perfil-equipo.json" "$BASE/lab10/perfil-n.json" && ok "(n) el perfil quedó el de antes (la transacción repuso lo ya cambiado)" || mal "(n) el perfil quedó a medias"
  cmp -s "$(NEW)/.tycon-team.json" "$BASE/lab10/manifiesto-n.json" && [ "$(estado "d['team']['commit']")" = "$PREV" ] && ok "(n) el manifiesto y el estado siguen en $(sha7 "$PREV")" || mal "(n) el manifiesto o el estado cambiaron"
  [ -z "$(find "$(NEW)" -maxdepth 4 -name '.tycon-team.tmp-*' 2>/dev/null)" ] && ok "(n) ningún temporal quedó" || mal "(n) quedaron temporales: $(find "$(NEW)" -name '.tycon-team.tmp-*')"
  case "$(aviso)" in *"no pude reemplazar"*"corridas-buzon.json"*) ok "(n) el aviso dice qué no pudo reemplazar" ;; *) mal "(n) aviso: $(aviso)" ;; esac
  case "$(estado "(d['team'].get('last_error') or {}).get('reason','')")" in *"corridas-buzon.json"*) ok "(n) last_error lo guarda" ;; *) mal "(n) last_error: $(estado "d['team'].get('last_error')")" ;; esac
  rm -rf "$(NEW)/scripts/metrics/corridas-buzon.json"
  # (o) harness/ en otro commit que el estado: el arranque los iguala, sin red
  python3 - "$(ESTADO)" "$C0" <<'PY'
import json,sys
f,c=sys.argv[1:3]; d=json.load(open(f)); d['team']['commit']=c; json.dump(d, open(f,'w'), indent=2)
PY
  ventana now
  N0="$(lineas)"
  harness_release startup >/dev/null 2>&1
  [ "$(estado "d['team']['commit']")" = "$(j "$(NEW)/.tycon-team.json" "d['commit']")" ] && ok "(o) el estado quedó con el commit de harness/" || mal "(o) estado $(estado "d['team']['commit']") ≠ harness/"
  [ "$(lineas)" = "$N0" ] && ok "(o) …sin pedir nada (dentro de la ventana)" || mal "(o) pidió a la red"
  # ── casos de regresión, cada uno con la prueba que lo confirma ──
  ventana none; harness_release startup >/dev/null 2>&1   # la punta de (n), ya sin el tapón
  [ "$(estado "d['team']['commit']")" = "$(team_head)" ] && ok "(n') sin el tapón, el arranque siguiente trae la punta" || mal "(n') no la trajo: $(estado "d.get('team')")"
  canal_cambio() { local n; n="$(grep -c 'canal vigente cambió' "$(STARTUP_LOG)" 2>/dev/null)"; printf '%s' "${n:-0}"; }
  # (p) el perfil borrado a mano y repuesto desde la caché: la política se relee (sin perfil el canal sería stable)
  rm -f "$(NEW)/perfil-equipo.json"
  ventana none; harness_release startup >/dev/null 2>&1
  [ -f "$(NEW)/perfil-equipo.json" ] && [ "$(estado "d['channel']")" = latest ] && ok "(p) perfil repuesto desde la caché y state.channel el del perfil (latest)" || mal "(p) state.channel $(estado "d.get('channel')"), perfil $([ -f "$(NEW)/perfil-equipo.json" ] && echo está || echo falta)"
  K0="$(canal_cambio)"; ventana now; harness_release startup >/dev/null 2>&1
  [ "$(canal_cambio)" = "$K0" ] && ok "(p) …y el arranque siguiente no dice «el canal cambió»" || mal "(p) el arranque siguiente dijo que el canal cambió"
  # (q · R-1) una versión pública nueva que NO se puede bajar no congela la capa: el arranque la refresca igual
  export TYCON_UPDATE_APPLY=auto
  harness_lab_release_control "{ \"auth\": \"none\", \"truncate\": true, \"truncate_repos\": [\"$LAB_RELEASE_ORG/$LAB_RELEASE_NAME\"] }"
  harness_lab_publish_stable 2026.10.08.3
  publica_perfil "$PERFIL_SIN_NIGHTLY" "nightly apagada (q)"
  ventana none; harness_release startup >/dev/null 2>&1
  [ "$(estado "d['version']['number']")" = 2026.10.08.1 ] && [ "$(estado "d['team']['commit']")" = "$(team_head)" ] && ok "(q) la versión nueva no se pudo bajar y la capa nueva entró igual" || mal "(q) versión $(estado "d['version']['number']"), capa $(estado "d['team']['commit']") (punta $(sha7 "$(team_head)"))"
  # (r · C-1) `update` con un perfil nuevo que cambia el canal relee la política (como el arranque)
  publica_perfil '{ "ado": { "org": "https://dev.azure.com/acme" }, "integrations": { "engram": true, "nightly": false, "mailbox": true }, "update": { "channel": "stable", "apply": "auto" }, "packs": { "default": "all" }, "install": { "profile": "full" } }' "canal stable (r)"
  harness_release update >/dev/null 2>&1
  [ "$(estado "d['team']['commit']")" = "$(team_head)" ] && [ "$(estado "d['channel']")" = stable ] && ok "(r) update trajo el perfil nuevo y state.channel pasó a stable" || mal "(r) capa $(estado "d['team']['commit']"), state.channel $(estado "d.get('channel')")"
  K0="$(canal_cambio)"; ventana now; harness_release startup >/dev/null 2>&1
  [ "$(canal_cambio)" = "$K0" ] && ok "(r) …y el arranque siguiente no dice «el canal cambió»" || mal "(r) el arranque siguiente dijo que el canal cambió"
  harness_lab_release_control '{ "auth": "none" }'
  unset LAB_APPLIER_INTEG TYCON_STARTUP_DETACH
  export TYCON_UPDATE_APPLY=auto
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T11 ────────────────────────────────────────────────────────────────────
if corre T11; then
  echo "T11 · doctor: la línea de la capa, lo editado y lo faltante como aviso, la capa que falta, el paquete del equipo; sin capa, nada"
  lab_team "$BASE/lab11"
  instala_team
  [ "$INSTALL_RC" = 0 ] && ok "instalada con la capa" || mal "install: rc $INSTALL_RC: $INSTALL_OUT"
  doc() { DOC="$(harness_release doctor --json 2>/dev/null)"; }
  dk() { printf '%s' "$DOC" | jtxt "$1"; }
  doc
  case "$(dk "' | '.join(d['ok'])")" in *"capa del equipo equipo-lab ($LAB_TEAM) @ $(sha7 "$(team_head)"): 2 archivo(s), todo en su lugar"*) ok "la línea ok: nombre, repo, commit, cuenta y «todo en su lugar»" ;; *) mal "sin la línea de la capa: $(dk "d['ok']")" ;; esac
  case "$(dk "' | '.join(d['warn'])")" in *"paquete de revisores del equipo"*"todavía no está en esta máquina"*) ok "la línea del paquete que falta (integraciones del perfil prendidas, sin packs/clients)" ;; *) mal "sin la línea del paquete: $(dk "d['warn']")" ;; esac
  [ "$(dk "len(d['fail'])")" = 0 ] && ok "sin fail" || mal "fail: $(dk "d['fail']")"
  # con el paquete en el árbol, la línea del paquete no aparece
  mkdir -p "$(NEW)/packs/clients" && printf '{}\n' > "$(NEW)/packs/clients/pack.json"
  doc
  case "$(dk "' | '.join(d['warn'])")" in *"paquete de revisores del equipo"*) mal "con packs/clients presente sigue la línea del paquete" ;; *) ok "con packs/clients presente, ninguna línea del paquete" ;; esac
  rm -rf "$(NEW)/packs/clients"
  # el motivo del último refresco fallido
  python3 - "$(ESTADO)" <<'PY'
import json,sys
f=sys.argv[1]; d=json.load(open(f)); d['team']['last_error']={'at':'2026-10-09T08:00:00.000Z','reason':'motivo-de-prueba-11'}; json.dump(d, open(f,'w'), indent=2)
PY
  doc
  case "$(dk "' | '.join(d['warn'])")" in *"capa del equipo"*"motivo-de-prueba-11"*) ok "last_error: aviso con el motivo" ;; *) mal "sin aviso de last_error: $(dk "d['warn']")" ;; esac
  # un archivo editado y uno borrado: avisos con su ruta, nunca fail
  printf '{ "integrations": { "engram": true } }\n' > "$(NEW)/perfil-equipo.json"
  rm -f "$(NEW)/scripts/metrics/corridas-buzon.json"
  doc
  case "$(dk "' | '.join(d['warn'])")" in *"perfil-equipo.json"*"editado"*) ok "el editado: aviso con su ruta" ;; *) mal "sin aviso del editado: $(dk "d['warn']")" ;; esac
  case "$(dk "' | '.join(d['warn'])")" in *"scripts/metrics/corridas-buzon.json"*"falta"*) ok "el faltante: aviso con su ruta" ;; *) mal "sin aviso del faltante: $(dk "d['warn']")" ;; esac
  case "$(dk "' | '.join(d['ok'])")" in *"todo en su lugar"*) mal "dice «todo en su lugar» con la capa incompleta" ;; *) ok "no dice «todo en su lugar» con la capa incompleta" ;; esac
  [ "$(dk "len(d['fail'])")" = 0 ] && ok "…y ningún fail (la capa no frena la salud)" || mal "fail: $(dk "d['fail']")"
  # un refresco que quedó a medias (el pendiente nombra el blob del perfil que hay en disco): «a medio refrescar», no «editado»,
  # y el pendiente no cuenta «de más»
  printf '{ "schema": 1, "commit": "%s", "files": [{ "path": "perfil-equipo.json", "blob": "%s" }] }\n' "$(printf '5%.0s' $(seq 1 40))" "$(git hash-object "$(NEW)/perfil-equipo.json")" > "$(NEW)/.tycon-team.pending.json"
  doc
  case "$(dk "' | '.join(d['warn'])")" in *"perfil-equipo.json quedó a medio refrescar"*) ok "el perfil a medio refrescar se dice como tal" ;; *) mal "sin la línea «a medio refrescar»: $(dk "d['warn']")" ;; esac
  case "$(dk "' | '.join(d['warn'])")" in *"perfil-equipo.json editado"*) mal "lo llama «editado a mano»" ;; *) ok "…y no lo llama «editado a mano»" ;; esac
  case "$(dk "' | '.join(d['warn'])")" in *".tycon-team.pending.json: de más"*) mal "el pendiente cuenta «de más»" ;; *) ok "el pendiente no cuenta «de más»" ;; esac
  printf '{ roto\n' > "$(NEW)/.tycon-team.pending.json"
  doc
  case "$(dk "' | '.join(d['warn'])")" in *".tycon-team.pending.json) no se puede leer"*) ok "un pendiente ilegible se dice" ;; *) mal "el pendiente ilegible no se dice: $(dk "d['warn']")" ;; esac
  rm -f "$(NEW)/.tycon-team.pending.json"
  # un manifiesto con una entrada sin forma: doctor legible, sin fail
  python3 - "$(NEW)/.tycon-team.json" <<'PY'
import json,sys
f=sys.argv[1]; d=json.load(open(f)); d['files'].append(None); json.dump(d, open(f,'w'), indent=1)
PY
  doc
  [ -n "$DOC" ] && [ "$(dk "len(d['fail'])")" = 0 ] && ok "un .tycon-team.json con una entrada null: doctor --json legible y sin fail" || mal "con la entrada null: $(printf '%s' "$DOC" | head -c 300)"
  # las líneas de la capa no hacen red: doctor (sin --fetch) no le pide nada al servidor
  N0="$(wc -l < "$LAB_RELEASE_LOG" | tr -d ' ')"; doc
  [ "$(wc -l < "$LAB_RELEASE_LOG" | tr -d ' ')" = "$N0" ] && ok "doctor no le pide nada a la red" || mal "doctor pidió a la red"
  # en modo desarrollador, ninguna línea de la capa: la misma máquina —capa declarada y rota, que en modo normal da
  # su aviso— leída por las líneas de doctor de la versión bajada con el estado en `developer`
  DEVN="$(node -e '
    const R = require(process.argv[1]);
    const st = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
    const count = (mode) => R.doctorItems({ home: process.argv[3], env: process.env, opts: {} }, Object.assign({}, st, { mode })).filter((i) => /capa del equipo|paquete de revisores del equipo/.test(i.text)).length;
    process.stdout.write(`${count(st.mode || "managed")} ${count("developer")}\n`);' "$(NEW)/scripts/setup/harness/release.js" "$(ESTADO)" "$LAB_HOME" 2>&1)"
  case "$DEVN" in "0 0"|*[!0-9\ ]*) mal "modo desarrollador: la medición no sirve o no hay línea que comparar ($DEVN)" ;; *" 0") ok "modo desarrollador: ninguna línea de la capa (en modo normal, ${DEVN%% *})" ;; *) mal "modo desarrollador muestra líneas de la capa: $DEVN" ;; esac
  # el estado con team y harness/ sin capa
  rm -f "$(NEW)/.tycon-team.json" "$(NEW)/perfil-equipo.json"
  doc
  case "$(dk "' | '.join(d['warn'])")" in *"capa del equipo"*"$LAB_TEAM"*"no está en esta versión"*) ok "la capa declarada y ausente: aviso" ;; *) mal "sin aviso de la capa ausente: $(dk "d['warn']")" ;; esac
  # una máquina SIN capa: ninguna línea que nombre la capa ni el paquete
  harness_lab_release_fresh_home
  OUT="$(harness install --version latest --profile full --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "máquina sin capa instalada" || mal "install sin capa: rc $RC: $OUT"
  doc
  case "$DOC" in *"capa del equipo"*|*"paquete de revisores del equipo"*) mal "una máquina sin capa ve líneas de la capa: $(dk "d['warn']") $(dk "d['ok']")" ;; *) ok "sin capa: ninguna línea de la capa ni del paquete" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T12 ────────────────────────────────────────────────────────────────────
if corre T12; then
  echo "T12 · rollback sigue a la capa del árbol que queda; uninstall conserva y nombra ~/.tycon/team y nunca borra lo editado"
  lab_team "$BASE/lab12"
  instala_team
  [ "$INSTALL_RC" = 0 ] && ok "instalada con la capa" || mal "install: rc $INSTALL_RC: $INSTALL_OUT"
  C0="$(team_head)"
  publica_perfil "$PERFIL_SIN_NIGHTLY" "commit dos del equipo"
  C1="$(team_head)"
  harness_lab_publish_stable 2026.10.08.2
  OUT="$(harness_release update --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado "d['team']['commit']")" = "$C1" ] && ok "update: versión nueva con la capa $(sha7 "$C1")" || mal "update: rc $RC $(estado "d.get('team')") $OUT"
  OUT="$(harness_release rollback 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado "d['version']['number']")" = 2026.10.08.1 ] && ok "rollback a 2026.10.08.1" || mal "rollback: rc $RC $OUT"
  [ "$(estado "d['team']['commit']")" = "$C0" ] && [ "$(j "$(NEW)/.tycon-team.json" "d['commit']")" = "$C0" ] && ok "…y state.team es la capa del árbol que quedó ($(sha7 "$C0"))" || mal "state.team tras rollback: $(estado "d.get('team')")"
  OUT="$(harness_release rollback 2>&1)"; RC=$?
  [ "$(estado "d['team']['commit']")" = "$C1" ] && [ "$(estado "d['version']['number']")" = 2026.10.08.2 ] && ok "rollback otra vez: de vuelta a 2026.10.08.2 con $(sha7 "$C1")" || mal "segundo rollback: $(estado "d.get('team')") $OUT"
  # uninstall con la MISMA ruta de la capa editada distinta en harness/ y en previous/: las dos se conservan sin pisarse
  printf '{ "integrations": { "engram": true, "nightly": true } }\n' > "$(NEW)/perfil-equipo.json"
  printf '{ "integrations": { "engram": false } }\n' > "$(TYCON_DIR)/previous/perfil-equipo.json"
  OUT="$(harness_release uninstall --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ ! -d "$(NEW)" ] && ok "uninstall --yes sale 0 y quita harness/" || mal "uninstall: rc $RC $OUT"
  case "$OUT" in *"deja:"*"$(TYCON_DIR)/team"*) ok "la línea «deja» nombra ~/.tycon/team" ;; *) mal "no nombra ~/.tycon/team: $OUT" ;; esac
  [ -d "$(TYCON_DIR)/team" ] && ok "~/.tycon/team quedó" || mal "~/.tycon/team se borró"
  KEPT="$(ls -d "$(TYCON_DIR)"/team/kept-* 2>/dev/null | head -n 1)"
  [ -n "$KEPT" ] && [ "$(cat "$KEPT/harness/perfil-equipo.json" 2>/dev/null)" = '{ "integrations": { "engram": true, "nightly": true } }' ] && [ "$(cat "$KEPT/previous/perfil-equipo.json" 2>/dev/null)" = '{ "integrations": { "engram": false } }' ] && ok "los dos editados quedaron en $(basename "${KEPT:-kept}")/{harness,previous}/ sin pisarse" || mal "lo editado no se conservó: $(ls -R "$(TYCON_DIR)/team" 2>/dev/null | tr '\n' ' ')"
  case "$OUT" in *"kept-"*"perfil-equipo.json"*) ok "…y la salida lo nombra" ;; *) mal "la salida no nombra lo conservado: $OUT" ;; esac
  case "$(basename "${KEPT:-x}")" in *:*) mal "la carpeta lleva «:» (Windows no lo admite)" ;; *) ok "el nombre de la carpeta no lleva «:»" ;; esac
  # uninstall por la COPIA FIJA de arranque (no trae scripts/lib/): sale 0 y conserva el editado
  harness_lab_release_fresh_home
  instala_team
  [ "$INSTALL_RC" = 0 ] && ok "instalada otra vez con la capa" || mal "install: rc $INSTALL_RC: $INSTALL_OUT"
  BOOT="$(dirname "$(ESTADO)")/harness/bootstrap.js"
  [ -f "$BOOT" ] && ok "la copia fija de arranque está ($BOOT)" || mal "no está la copia fija en $BOOT"
  printf '{ "integrations": { "engram": true, "mailbox": false } }\n' > "$(NEW)/perfil-equipo.json"
  OUT="$(node "$BOOT" uninstall --yes < /dev/null 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "uninstall por la copia fija sale 0" || mal "uninstall por la copia fija: rc $RC: $OUT"
  KEPT="$(ls -d "$(TYCON_DIR)"/team/kept-* 2>/dev/null | head -n 1)"
  [ -n "$KEPT" ] && [ "$(cat "$KEPT/harness/perfil-equipo.json" 2>/dev/null)" = '{ "integrations": { "engram": true, "mailbox": false } }' ] && ok "…y conserva el editado" || mal "por la copia fija no se conservó el editado: $(ls -R "$(TYCON_DIR)/team" 2>/dev/null | tr '\n' ' ') · $OUT"
  # uninstall que NO puede copiar lo editado (~/.tycon/team es un archivo): lo dice y no quita ese árbol
  harness_lab_release_fresh_home
  instala_team
  printf '{ "integrations": { "engram": true, "nightly": false } }\n' > "$(NEW)/perfil-equipo.json"
  rm -rf "$(TYCON_DIR)/team"; printf 'no soy una carpeta\n' > "$(TYCON_DIR)/team"
  OUT="$(harness_release uninstall --yes 2>&1)"; RC=$?
  case "$OUT" in *"no pude conservar"*"$(NEW)"*"sin quitar"*) ok "sin poder copiar lo editado, uninstall lo dice y nombra el árbol que deja" ;; *) mal "no lo dice: $OUT" ;; esac
  [ "$(cat "$(NEW)/perfil-equipo.json" 2>/dev/null)" = '{ "integrations": { "engram": true, "nightly": false } }' ] && ok "…y el editado sigue en harness/ (no se borró)" || mal "el editado se perdió"
  rm -f "$(TYCON_DIR)/team"
  # rollback a una versión SIN capa: queda el repo sin commit
  harness_lab_release_fresh_home
  OUT="$(harness install --version latest --profile full --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "máquina sin capa instalada (2026.10.08.2)" || mal "install sin capa: rc $RC: $OUT"
  harness_lab_publish_stable 2026.10.08.3
  OUT="$(harness_release install --version latest --team "$LAB_TEAM" --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado "d['team']['commit']")" = "$C1" ] && ok "install --team sobre una máquina sin capa: la capa en 2026.10.08.3" || mal "install --team: rc $RC $(estado "d.get('team')") $OUT"
  OUT="$(harness_release rollback 2>&1)"; RC=$?
  [ "$(estado "d['version']['number']")" = 2026.10.08.2 ] && [ ! -e "$(NEW)/.tycon-team.json" ] && ok "rollback a la versión sin capa" || mal "rollback sin capa: $(estado "d['version']['number']") $OUT"
  [ "$(estado "d['team']['repo']")" = "$LAB_TEAM" ] && [ "$(estado "d['team']['commit']")" = None ] && ok "…state.team queda con el repo y sin commit (el arranque la trae)" || mal "state.team: $(estado "d.get('team')")"
  OUT="$(harness_release rollback 2>&1)"
  [ "$(estado "d['team']['commit']")" = "$C1" ] && ok "…y el rollback de vuelta la recupera" || mal "rollback de vuelta: $(estado "d.get('team')")"
  # una máquina sin capa: la línea «deja» de siempre
  harness_lab_release_fresh_home
  OUT="$(harness install --version latest --profile full --yes 2>&1)"
  OUT="$(harness_release uninstall --yes 2>&1)"; RC=$?
  case "$OUT" in *"deja: $(TYCON_DIR)/config.json (el permiso de GitHub) y $(TYCON_DIR)/third-party (la caché de skills de terceros) — borralos a mano si no los querés"*) ok "sin capa: la línea «deja» de hoy" ;; *) mal "sin capa, la línea «deja» cambió: $OUT" ;; esac
  case "$OUT" in *"/team"*|*"kept-"*) mal "sin capa nombra la capa: $OUT" ;; *) ok "sin capa: nada de la capa en la salida" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T33 ───────────────────────────────────────────────────
# El mapa de renombres en la capa: la versión de juguete NO lo trae (como la copia pública) y la capa trae el mapa
# REAL. La máquina instalada trata una variable vieja, un subcomando viejo y un archivo de estado viejo igual que el árbol
# interno; el día del retiro (un commit que lo saca del repo del equipo) el refresco lo borra y deja de traducirlos.
#
# 🔴 En la copia pública el mapa real NO viaja (lo trae la capa: es lo que mide esta prueba). Ahí la prueba declara lo que
# necesita: un mapa de juguete con los mismos tres tipos, y como referencia un árbol con el lector de la copia y ese mapa al
# lado (lo que en el interno es el propio repo). Sin esto, daría rojo sobre la copia, pidiendo un archivo que no existe.
MAPA_T33="$RAIZ/scripts/lib/renames.json"
mapa_old() { # mapa_old <kind> <new> [<where>] — el nombre viejo, leído del mapa de la prueba (ninguno escrito a mano acá)
  python3 - "$MAPA_T33" "$1" "$2" "${3:-}" <<'PY'
import json,sys
f,k,n,w=sys.argv[1:5]
for e in json.load(open(f, encoding='utf-8'))['entries']:
    if e.get('kind')==k and e.get('new')==n and (not w or e.get('where')==w):
        print(e['old']); break
PY
}
sondas() { # sondas <árbol> — tres líneas: la variable vieja leída, el subcomando viejo igual al nuevo (sí/no), el estado leído
  # sin TF_BUILD: en Azure el lector agrega un aviso por cada nombre viejo usado (lo que se mide acá es la traducción, no
  # el aviso)
  local t="$1" a b
  env -u TF_BUILD -u TYCON_TODAY "$OLD_VAR=2026-01-02" HOME="$LAB_HOME" node -e 'const L = require(process.argv[1] + "/scripts/lib/legacy-names.js"); process.stdout.write(String(L.readEnv("TYCON_TODAY")) + "\n")' "$t" 2>&1
  a="$(env -u TF_BUILD HOME="$LAB_HOME" node "$t/scripts/lib/tycon-config.js" "$OLD_SUB" 2>&1; echo "rc=$?")"
  b="$(env -u TF_BUILD HOME="$LAB_HOME" node "$t/scripts/lib/tycon-config.js" validate 2>&1; echo "rc=$?")"
  [ "$a" = "$b" ] && echo "subcomando viejo: igual al nuevo" || echo "subcomando viejo: distinto"
  env -u TF_BUILD HOME="$LAB_HOME" node -e 'const L = require(process.argv[1] + "/scripts/lib/legacy-names.js"); process.stdout.write(L.resolveFile(process.argv[2]) + "\n")' "$t" "$NEW_STATE" 2>&1
}
if corre T33; then
  echo "T33 · el mapa de renombres en la capa: la máquina instalada traduce los nombres viejos como el interno"
  NEW_STATE='~/.claude/.tycon-pipeline/findings-seal.json'
  REF_T33="$RAIZ"
  if [ ! -f "$MAPA_T33" ]; then
    # la copia pública: el mapa de juguete y el árbol de referencia (el lector de ESTE árbol con el mapa al lado)
    echo "  (la copia pública no trae el mapa real: T33 corre con un mapa de juguete y su árbol de referencia)"
    MAPA_T33="$BASE/t33-renames.json"
    printf '%s\n' '{ "retire_after": "2026-11-17", "entries": [' \
      '  { "kind": "env", "old": "TYCON_LAB_PREVIOUS_TODAY", "new": "TYCON_TODAY", "batch": "LAB" },' \
      '  { "kind": "subcommand", "old": "lab-previous-validate", "new": "validate", "where": "scripts/lib/tycon-config.js", "batch": "LAB" },' \
      '  { "kind": "state-file", "old": "~/.claude/.tycon-pipeline/lab-previous-seal.json", "new": "~/.claude/.tycon-pipeline/findings-seal.json", "batch": "LAB" }' \
      '] }' > "$MAPA_T33"
    REF_T33="$BASE/t33-ref"
    mkdir -p "$REF_T33/scripts/setup"
    cp -R "$RAIZ/scripts/lib" "$REF_T33/scripts/lib" && cp -R "$RAIZ/scripts/setup/harness" "$REF_T33/scripts/setup/harness" && cp "$MAPA_T33" "$REF_T33/scripts/lib/renames.json" \
      || mal "no pude armar el árbol de referencia de T33 en ${REF_T33}"
  fi
  OLD_VAR="$(mapa_old env TYCON_TODAY)"; OLD_SUB="$(mapa_old subcommand validate scripts/lib/tycon-config.js)"
  OLD_STATE="$(mapa_old state-file "$NEW_STATE")"
  [ -n "$OLD_VAR" ] && [ -n "$OLD_SUB" ] && [ -n "$OLD_STATE" ] && ok "los tres nombres viejos salen del mapa" || mal "el mapa no trae los tres: «${OLD_VAR}» «${OLD_SUB}» «${OLD_STATE}»"
  harness_lab_create "$BASE/lab33"
  export TYCON_PROFILE= TYCON_STARTUP_DETACH=0
  harness_lab_release_server
  # la versión, como la copia pública: sin el mapa
  rm -f "$LAB_AUTHOR_TREE/scripts/lib/renames.json"
  # el aplicador de juguete vive en la ruta del real y el mapa nombra una opción del real (`link`): la máquina exige que el
  # nombre nuevo esté en el texto de ese guion de la versión, así que el de juguete lo nombra, como el real
  for f in scripts/install-tycon-hooks.sh scripts/install-tycon-hooks.ps1; do
    [ -f "$LAB_AUTHOR_TREE/$f" ] && printf '\n# (laboratorio, T33) el aplicador real acepta --link: el mapa de renombres lo nombra\n' >> "$LAB_AUTHOR_TREE/$f"
  done
  harness_lab_git "$LAB_AUTHOR_TREE" add -A >/dev/null
  harness_lab_git "$LAB_AUTHOR_TREE" commit -q -m "la versión sin el mapa, como la copia" >/dev/null
  harness_lab_git "$LAB_AUTHOR_TREE" push -q origin main >/dev/null 2>&1
  harness_lab_publish_stable 2026.10.08.1
  harness_lab_team_repo
  mkdir -p "$LAB_AUTHOR_TEAM/scripts/lib"
  cp "$MAPA_T33" "$LAB_AUTHOR_TEAM/scripts/lib/renames.json"
  harness_lab_team_publish "el mapa de renombres en la capa"
  harness_lab_team_server
  harness_lab_release_fresh_home
  instala_team
  [ "$INSTALL_RC" = 0 ] && ok "install --team con el mapa en la capa sale 0" || mal "install: rc $INSTALL_RC: $INSTALL_OUT"
  cmp -s "$(NEW)/scripts/lib/renames.json" "$MAPA_T33" && ok "el mapa apilado es el de la capa, byte a byte" || mal "el mapa no quedó en $(NEW)/scripts/lib/renames.json"
  [ "$(j "$(NEW)/.tycon-team.json" "len(d['files'])")" = 3 ] && ok "la capa: perfil, llave y mapa" || mal "manifiesto de la capa: $(cat "$(NEW)/.tycon-team.json" 2>/dev/null)"
  # el archivo de estado viejo, sin el nuevo
  mkdir -p "$LAB_HOME/.claude/.tycon-pipeline"
  printf '{ "lab": true }\n' > "$LAB_HOME/${OLD_STATE#\~/}"; rm -f "$LAB_HOME/${NEW_STATE#\~/}"
  INTERNO="$(sondas "$REF_T33")"; MAQUINA="$(sondas "$(NEW)")"
  case "$INTERNO" in "2026-01-02"*"igual al nuevo"*"$LAB_HOME/${OLD_STATE#\~/}") ok "el interno traduce los tres (la referencia)" ;; *) mal "la referencia del interno no es la esperada: $INTERNO" ;; esac
  [ "$MAQUINA" = "$INTERNO" ] && ok "la máquina con el mapa en la capa se comporta como el interno" || mal "la máquina difiere del interno:
$MAQUINA
--- interno:
$INTERNO"
  # el día del retiro: un commit que saca el mapa del repo del equipo; el refresco lo borra y los nombres viejos dejan de andar
  rm -f "$LAB_AUTHOR_TEAM/scripts/lib/renames.json"
  harness_lab_team_publish "el retiro del mapa"
  ventana none
  OUT="$(harness_release startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ ! -e "$(NEW)/scripts/lib/renames.json" ] && ok "(retiro) el refresco borra el mapa de la máquina" || mal "(retiro) rc $RC, el mapa sigue: $OUT"
  SIN="$(sondas "$(NEW)")"
  # el control tiene que fallar por lo que mide, no por un error de la sonda: la variable vieja
  # no se lee (undefined), el estado se busca en su nombre nuevo, y ninguna traza de Node en la salida
  case "$SIN" in "undefined"*"subcomando viejo: distinto"*"$LAB_HOME/${NEW_STATE#\~/}") ok "(control) sin el mapa la máquina ya no traduce los nombres viejos" ;; *) mal "(control) sin el mapa no da lo esperado: $SIN" ;; esac
  case "$SIN" in *"at Module."*|*"node:internal"*|*"Error: Cannot find module"*) mal "(control) la sonda tiró: $SIN" ;; *) ok "(control) …sin trazas de error en las sondas" ;; esac
  case "$SIN" in *"subcomando viejo: distinto"*) ok "(control) …el subcomando viejo deja de andar" ;; *) mal "(control) el subcomando viejo sigue: $SIN" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── TPN ────────────────────────────────────────────────────────────────────
if corre TPN; then
  echo "TPN · el perfil del equipo con su nombre de hoy (team-profile.json), con el de antes y con los dos"
  lab_team "$BASE/labpn"
  # (a) con el nombre viejo (el repo de juguete nace así): el plan avisa en una línea cómo renombrarlo
  OUT="$(harness install --version latest --team "$LAB_TEAM" --dry-run 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "(a) --dry-run con perfil-equipo.json sale 0" || mal "(a) --dry-run rc $RC: $OUT"
  case "$OUT" in *"perfil-equipo.json, scripts/metrics/corridas-buzon.json — aviso: el perfil del equipo usa el nombre de antes (perfil-equipo.json): sigue andando; para pasarlo al nuevo, git mv perfil-equipo.json team-profile.json"*) ok "(a) el plan avisa cómo renombrarlo, en la misma línea" ;; *) mal "(a) el plan no avisa: $OUT" ;; esac
  # (b) el repo del equipo renombra el perfil: install --team deja team-profile.json y no el viejo
  harness_lab_git "$LAB_AUTHOR_TEAM" mv perfil-equipo.json team-profile.json >/dev/null
  harness_lab_team_publish "el perfil pasa a team-profile.json"
  OUT="$(harness install --version latest --team "$LAB_TEAM" --dry-run 2>&1)"
  case "$OUT" in *"capa del equipo $LAB_TEAM @ "*"— aviso"*) mal "(b) el plan avisa con el nombre nuevo: $OUT" ;; *"capa del equipo $LAB_TEAM @ "*"2 archivo(s)"*"scripts/metrics/corridas-buzon.json, team-profile.json"*) ok "(b) el plan nombra team-profile.json, sin aviso" ;; *) mal "(b) el plan no nombra team-profile.json: $OUT" ;; esac
  instala_team
  [ "$INSTALL_RC" = 0 ] && ok "(b) install --team con team-profile.json sale 0" || mal "(b) install rc $INSTALL_RC: $INSTALL_OUT"
  [ -f "$(NEW)/team-profile.json" ] && [ ! -e "$(NEW)/perfil-equipo.json" ] && ok "(b) ~/.tycon/harness tiene team-profile.json y no el de antes" || mal "(b) los perfiles en el árbol: $(ls "$(NEW)" | tr '\n' ' ')"
  cmp -s "$(NEW)/team-profile.json" "$LAB_AUTHOR_TEAM/team-profile.json" && ok "(b) el perfil apilado es byte a byte el del repo del equipo" || mal "(b) el perfil apilado difiere"
  case "$(explain_key "$(NEW)" ado org)" in *acme*" perfil") ok "(b) explain: ado.org del equipo con origen perfil" ;; *) mal "(b) explain ado.org: $(explain_key "$(NEW)" ado org)" ;; esac
  [ "$(explain_key "$(NEW)" integraciones engram)" = "true perfil" ] && ok "(b) explain: engram prendida con origen perfil" || mal "(b) engram: $(explain_key "$(NEW)" integraciones engram)"
  case "$(node "$(NEW)/scripts/lib/tycon-config.js" explain 2>&1)" in *"aviso: "*"perfil"*) mal "(b) explain avisa con el nombre nuevo" ;; *) ok "(b) explain no avisa con el nombre nuevo" ;; esac
  [ "$(estado "d['channel']")" = latest ] && [ "$(estado "d['policy']['apply']")" = auto ] && ok "(b) la política del estado es la del perfil nuevo (latest · auto)" || mal "(b) política: $(estado "d.get('channel')") $(estado "d.get('policy')")"
  JSON="$(harness_release doctor --json 2>/dev/null)"
  [ "$(printf '%s' "$JSON" | jtxt "len(d['fail'])")" = 0 ] && ok "(b) doctor --json sin fail" || mal "(b) doctor fail: $(printf '%s' "$JSON" | jtxt "d['fail']")"
  case "$(printf '%s' "$JSON" | jtxt "' '.join(d['warn'])")" in *"team-profile.json: de más"*) mal "(b) doctor cuenta el perfil «de más»" ;; *) ok "(b) doctor no cuenta team-profile.json como «de más»" ;; esac
  # (c) los dos en el repo del equipo (con el viejo distinto): el refresco deja sólo el nuevo, y vale el nuevo
  printf '%s\n' '{ "ado": { "org": "https://dev.azure.com/viejo" }, "integrations": { "engram": false } }' > "$LAB_AUTHOR_TEAM/perfil-equipo.json"
  harness_lab_team_publish "vuelve el de antes, al lado del nuevo"
  export TYCON_STARTUP_DETACH=0
  ventana none
  OUT="$(harness_release startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "(c) el arranque con los dos nombres en la capa sale 0" || mal "(c) startup rc $RC: $OUT"
  [ "$(estado "d['team']['commit']")" = "$(team_head)" ] && ok "(c) la capa se refrescó al commit con los dos" || mal "(c) la capa no se refrescó: $(estado "d.get('team')") — $OUT"
  [ -f "$(NEW)/team-profile.json" ] && [ ! -e "$(NEW)/perfil-equipo.json" ] && ok "(c) con los dos, el de antes no se apila" || mal "(c) los perfiles en el árbol: $(ls "$(NEW)" | tr '\n' ' ')"
  case "$(explain_key "$(NEW)" ado org)" in *acme*" perfil") ok "(c) vale el nuevo (ado.org del nuevo)" ;; *) mal "(c) explain ado.org: $(explain_key "$(NEW)" ado org)" ;; esac
  OUT="$(harness_release install --version latest --team "$LAB_TEAM" --dry-run 2>&1)"
  case "$OUT" in *"aviso: el perfil del equipo está con los dos nombres: vale team-profile.json"*) ok "(c) el plan avisa que están los dos y que vale el nuevo" ;; *) mal "(c) el plan no avisa de los dos: $OUT" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

echo
if [ "$FALLOS" = 0 ]; then echo "harness-team: todo verde"; else echo "harness-team: $FALLOS fallo(s)"; exit 1; fi
