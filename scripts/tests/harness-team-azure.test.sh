#!/usr/bin/env bash
# harness-team-azure.test.sh — la capa del equipo desde AZURE DEVOPS sobre la versión bajada (story 8.25, tanda A1a-azure: la
# fuente de TYCON). Mismo laboratorio que harness-team.test.sh (la copia pública en el GitHub de juguete) más un Azure DevOps de
# juguete (scripts/tests/fixtures/toy-azure-server.js) que atiende el repo del equipo.
#
# Lo que no se puede perder:
#   TZ7  · `install --version latest --team https://dev.azure.com/<org>/<proyecto>/_git/<repo>` con el PAT guardado
#          (`azure.token`): la capa apilada, `explain` con origen «perfil», el estado con `team` (host azure, la URL), doctor sin
#          fail; `update` lleva la punta nueva del equipo a la versión nueva.
#   TZ8  · sin credencial: 1 SIN escribir, con las dos formas de ponerla (el PAT con config set azure.token · el gestor de git);
#          un PAT que no vale: 1 y lo dice (Azure contesta la página de login a los dos); el valor del PAT no aparece en nada
#          escrito ni en el registro del servidor; sin permiso de lectura (403) y repo que no existe (404), dichos; nunca «sin red».
#   TZ9  · `update` con el PAT quitado: la capa instalada se arrastra y se dice; con una lista del árbol cortada o un item
#          alterado, la punta no entra y la instalada sigue.
#   TZ13 · la mudanza con la clave `team` del clon = la URL de Azure: el plan la nombra, sin credencial no arranca (1, HOME
#          idéntica), con el PAT la capa queda en ~/.tycon/harness y el perfil del clon no se funde.
#
# El PAT de juguete se guarda directo en ~/.tycon/config.json (harness_lab_team_azure_pat), como lo dejaría `config set
# azure.token`; el gestor de credenciales de la máquina real queda afuera (TYCON_AZURE_GIT_CREDENTIAL=0).
#
# Uso: bash scripts/tests/harness-team-azure.test.sh [--only TZ7|TZ8|TZ9|TZ13]
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
export TYCON_UPDATE_APPLY=auto
ONLY=""; [ "${1:-}" = "--only" ] && ONLY="${2:-}"
corre() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
# el PAT de juguete se guarda por el comando real (`config set azure.token`, en harness_lab_team_azure_pat); si ese comando falla,
# acá queda como MAL con su causa — sin esto la prueba seguía y fallaba más abajo con un mensaje que no apuntaba al origen
# (revisor de fallos silenciosos, vuelta 2)
pat_guardado() { harness_lab_team_azure_pat "$@" || { mal "no pude guardar el PAT por config set azure.token (la causa, arriba): lo que sigue de esta prueba no vale"; return 1; }; }
BASE="$(mktemp -d)"
case "$BASE" in "$RAIZ"*|*agent-skills*|*/.claude*) echo "❌ harness-team-azure: el laboratorio cayó en ${BASE}"; exit 1 ;; esac
trap 'rm -rf "$BASE"; kill $(jobs -p) 2>/dev/null' EXIT
j() { python3 -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print($2)" "$1" 2>/dev/null; }
jtxt() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
ESTADO() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"; }
estado() { j "$(ESTADO)" "$1"; }
TYCON_DIR() { printf '%s' "$LAB_HOME/.tycon"; }
NEW() { printf '%s' "$LAB_HOME/.tycon/harness"; }
explain_key() { # explain_key <árbol> <sección> <clave> → «valor origen»
  node "$1/scripts/lib/tycon-config.js" explain --json 2>/dev/null | python3 -c '
import json,sys
d=json.load(sys.stdin); s,c=sys.argv[1],sys.argv[2]; print("%s %s" % (json.dumps(d["valores"][s][c]), d["origenes"]["%s.%s" % (s,c)]))' "$2" "$3"
}
azure_pedidos() { local n; n="$(grep -c -- "$1" "$LAB_AZURE_LOG" 2>/dev/null)"; printf '%s' "${n:-0}"; }
lab_azure() { # lab_azure <dir>
  harness_lab_create "$1"
  export TYCON_PROFILE=
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.08.1
  harness_lab_team_repo
  harness_lab_team_azure_server
  harness_lab_release_fresh_home
}
instala_az() { INSTALL_OUT="$(harness install --version latest --team "$LAB_TEAM_URL" --yes 2>&1)"; INSTALL_RC=$?; }
team_head() { harness_lab_team_head; }
publica_perfil() { printf '%s\n' "$1" > "$LAB_AUTHOR_TEAM/perfil-equipo.json"; harness_lab_team_publish "$2"; }

# ───────────────────────────────────────────── TZ7 ────────────────────────────────────────────────────────────────────
if corre TZ7; then
  echo "TZ7 · install --team <URL de Azure DevOps> con el PAT guardado: la capa apilada, origen perfil, team con host azure; update lleva la punta nueva"
  lab_azure "$BASE/lab7"
  pat_guardado
  H0="$(harness_lab_home_hash)"
  OUT="$(harness install --version latest --team "$LAB_TEAM_URL" --dry-run 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "--dry-run sale 0" || mal "--dry-run rc $RC: $OUT"
  case "$OUT" in *"capa del equipo $LAB_TEAM_URL @ "*"2 archivo(s)"*) ok "el plan nombra la capa por su URL de Azure y sus dos archivos" ;; *) mal "el plan no nombra la capa: $OUT" ;; esac
  [ "$(harness_lab_home_hash)" = "$H0" ] && ok "--dry-run no escribió nada" || mal "--dry-run escribió"
  instala_az
  [ "$INSTALL_RC" = 0 ] && ok "install --team <Azure> sale 0" || mal "install salió $INSTALL_RC: $INSTALL_OUT"
  [ -f "$(NEW)/perfil-equipo.json" ] && [ -f "$(NEW)/scripts/metrics/corridas-buzon.json" ] && [ -f "$(NEW)/.tycon-team.json" ] && ok "los dos archivos de la capa y su manifiesto en ~/.tycon/harness" || mal "falta algo de la capa: $(ls -a "$(NEW)" 2>/dev/null | tr '\n' ' ')"
  cmp -s "$(NEW)/perfil-equipo.json" "$LAB_AUTHOR_TEAM/perfil-equipo.json" && ok "el perfil apilado es byte a byte el del repo del equipo (bajado item por item)" || mal "el perfil apilado difiere"
  case "$(explain_key "$(NEW)" ado org)" in *acme*" perfil") ok "explain: ado.org con origen perfil" ;; *) mal "explain ado.org: $(explain_key "$(NEW)" ado org)" ;; esac
  [ "$(explain_key "$(NEW)" integraciones engram)" = "true perfil" ] && ok "explain: engram prendida con origen perfil" || mal "engram: $(explain_key "$(NEW)" integraciones engram)"
  [ "$(estado "d['team']['repo']")" = "$LAB_TEAM_URL" ] && [ "$(estado "d['team']['host']")" = azure ] && [ "$(estado "d['team']['commit']")" = "$(team_head)" ] && [ "$(estado "d['team']['files']")" = 2 ] && ok "el estado guarda team: la URL, host azure, el commit, 2 archivos" || mal "team en el estado: $(estado "d.get('team')")"
  [ "$(j "$(NEW)/.tycon-team.json" "d['host']")" = azure ] && ok "el manifiesto apilado dice host azure" || mal "manifiesto: $(cat "$(NEW)/.tycon-team.json")"
  JSON="$(harness_release doctor --json 2>/dev/null)"
  [ "$(printf '%s' "$JSON" | jtxt "len(d['fail'])")" = 0 ] && ok "doctor --json sin fail" || mal "doctor fail: $(printf '%s' "$JSON" | jtxt "d['fail']")"
  [ "$(azure_pedidos "/refs?filter=heads/main")" -ge 1 ] && [ "$(azure_pedidos "/trees/")" -ge 1 ] && [ "$(azure_pedidos "/items?path=")" -ge 2 ] && ok "pidió a Azure la ref, el árbol y los items (nunca un comprimido)" || mal "pedidos a Azure: $(cat "$LAB_AZURE_LOG" | cut -c1-120)"
  [ "$(azure_pedidos "/tarball/")" = 0 ] && [ "$(azure_pedidos "zip")" = 0 ] && ok "…sin zip ni comprimido" || mal "pidió un comprimido a Azure"
  grep -q -- "$LAB_AZURE_PAT" "$LAB_AZURE_LOG" && mal "el PAT en claro en el registro del servidor" || ok "el registro del servidor no trae el PAT en claro"
  # update: la punta nueva del equipo sobre la versión pública nueva
  publica_perfil '{ "ado": { "org": "https://dev.azure.com/acme" }, "integrations": { "engram": true, "nightly": false, "mailbox": true }, "update": { "channel": "latest", "apply": "auto" }, "packs": { "default": "all" }, "install": { "profile": "full" } }' "nightly apagada"
  harness_lab_publish_stable 2026.10.08.2
  OUT="$(harness_release update --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "update sale 0" || mal "update rc $RC: $OUT"
  [ "$(estado "d['team']['commit']")" = "$(team_head)" ] && [ "$(explain_key "$(NEW)" integraciones nightly)" = "false perfil" ] && ok "la punta nueva del equipo quedó en la versión nueva (nightly apagada, origen perfil)" || mal "la punta nueva no quedó: $(estado "d.get('team')") nightly=$(explain_key "$(NEW)" integraciones nightly)"
  kill "$LAB_RELEASE_PROCESS" "$LAB_AZURE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── TZ8 ────────────────────────────────────────────────────────────────────
if corre TZ8; then
  echo "TZ8 · sin credencial de Azure, PAT que no vale, sin permiso de lectura, repo que no existe: 1 sin escribir y dicho con la acción"
  lab_azure "$BASE/lab8"
  sin_acceso() { # sin_acceso <rótulo> <control> [<pat a guardar>]
    harness_lab_release_fresh_home
    harness_lab_team_azure_control "$2"
    [ -n "${3:-}" ] && pat_guardado "$3"
    local h0 out rc
    h0="$(harness_lab_home_hash)"
    out="$(harness install --version latest --team "$LAB_TEAM_URL" --yes 2>&1)"; rc=$?
    [ "$rc" = 1 ] && ok "$1: install sale 1" || mal "$1: rc $rc: $out"
    case "$out" in *"sin red"*) mal "$1: dijo «sin red»: $out" ;; *) ok "$1: no lo confunde con «sin red»" ;; esac
    [ "$(harness_lab_home_hash)" = "$h0" ] && ok "$1: HOME idéntica (nada escrito ni registrado)" || mal "$1: escribió algo"
    [ -d "$(TYCON_DIR)/harness" ] && mal "$1: dejó ~/.tycon/harness" || ok "$1: nada instalado"
    SIN_ACCESO_OUT="$out"
  }
  # (a) sin credencial: ni PAT guardado ni gestor → las dos formas de ponerla
  sin_acceso "sin credencial" '{ "pat": "pat-lab" }'
  case "$SIN_ACCESO_OUT" in *"sin credencial de Azure DevOps para $LAB_TEAM_URL"*) ok "sin credencial: lo dice, nombrando el repo del equipo" ;; *) mal "sin credencial: $SIN_ACCESO_OUT" ;; esac
  case "$SIN_ACCESO_OUT" in *"config set azure.token"*"gestor de credenciales"*) ok "…con las dos formas de ponerla" ;; *) mal "sin las dos formas: $SIN_ACCESO_OUT" ;; esac
  # (b) un PAT que no vale: Azure contesta la página de login (302), igual que a un anónimo
  sin_acceso "PAT que no vale" '{ "pat": "pat-lab" }' pat-que-no-vale-8
  case "$SIN_ACCESO_OUT" in *"PAT guardado"*"no vale"*"302"*) ok "PAT que no vale: lo dice (el PAT guardado, 302)" ;; *) mal "PAT que no vale: $SIN_ACCESO_OUT" ;; esac
  case "$SIN_ACCESO_OUT" in *pat-que-no-vale-8*) mal "el valor del PAT aparece en la salida" ;; *) ok "el valor del PAT no aparece en la salida" ;; esac
  FOUND="$(grep -rl -- pat-que-no-vale-8 "$LAB_HOME" 2>/dev/null | grep -v '/config.json$' || true)"
  [ -z "$FOUND" ] && ok "el valor del PAT no está en nada escrito salvo su archivo" || mal "el PAT aparece en: $FOUND"
  grep -q -- pat-que-no-vale-8 "$LAB_AZURE_LOG" && mal "el PAT en claro en el registro del servidor" || ok "…ni en el registro del servidor"
  # el modo se lee con node: en Linux `stat -f` es otra cosa (el sistema de archivos) y sale 0 con «File: …» (170 #12521)
  [ "$(node -e 'process.stdout.write((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$LAB_HOME/.tycon/config.json" 2>/dev/null)" = 600 ] && ok "config.json queda 0600" ||mal "config.json: $(stat -f '%Lp' "$LAB_HOME/.tycon/config.json" 2>/dev/null)"
  # (c) vale pero sin permiso de lectura: 403
  sin_acceso "sin permiso de lectura" '{ "pat": "pat-lab", "blind": true }' pat-lab
  case "$SIN_ACCESO_OUT" in *"permiso de lectura (Code: Read)"*) ok "403: dice que falta el permiso de lectura" ;; *) mal "403: $SIN_ACCESO_OUT" ;; esac
  # (d) el repo no existe: 404
  sin_acceso "repo que no existe" '{ "pat": "pat-lab", "missing_repo": true }' pat-lab
  case "$SIN_ACCESO_OUT" in *"no existe en acme/proyecto"*) ok "404: dice que el repo no existe en el proyecto" ;; *) mal "404: $SIN_ACCESO_OUT" ;; esac
  kill "$LAB_RELEASE_PROCESS" "$LAB_AZURE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── TZ9 ────────────────────────────────────────────────────────────────────
if corre TZ9; then
  echo "TZ9 · update: sin credencial se arrastra la instalada y se dice; una lista cortada o un item alterado no entran"
  lab_azure "$BASE/lab9"
  pat_guardado
  instala_az
  [ "$INSTALL_RC" = 0 ] && ok "instalada con la capa de Azure" || mal "install: rc $INSTALL_RC: $INSTALL_OUT"
  C0="$(team_head)"
  # (a) el PAT quitado: la versión pública nueva entra con la capa instalada arrastrada, dicho
  rm -f "$LAB_HOME/.tycon/config.json"
  harness_lab_publish_stable 2026.10.08.2
  OUT="$(harness_release update --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "sin credencial: update sale 0 (la pública se instala)" || mal "sin credencial: rc $RC: $OUT"
  case "$OUT" in *"capa del equipo: sin acceso"*"sin credencial de Azure DevOps"*"sigue en $(printf '%s' "$C0" | cut -c1-7)"*) ok "…y dice que falta la credencial y que la capa sigue en $(printf '%s' "$C0" | cut -c1-7)" ;; *) mal "no lo dice: $OUT" ;; esac
  [ -f "$(NEW)/perfil-equipo.json" ] && [ "$(estado "d['team']['commit']")" = "$C0" ] && [ "$(estado "d['version']['number']")" = 2026.10.08.2 ] && ok "la capa arrastrada está en 2026.10.08.2" || mal "la capa no se arrastró: $(estado "d.get('team')")"
  pat_guardado
  # (b) la lista del árbol cortada: la punta no entra; la instalada sigue
  publica_perfil '{ "ado": { "org": "https://dev.azure.com/acme" }, "integrations": { "engram": true, "nightly": false, "mailbox": true }, "update": { "channel": "latest", "apply": "auto" }, "packs": { "default": "all" }, "install": { "profile": "full" } }' "nightly apagada"
  harness_lab_team_azure_control '{ "pat": "pat-lab", "truncated_tree": true }'
  harness_lab_publish_stable 2026.10.08.3
  OUT="$(harness_release update --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado "d['team']['commit']")" = "$C0" ] && ok "lista cortada: la punta no entra y la instalada sigue (rc 0)" || mal "lista cortada: rc $RC team=$(estado "d.get('team')") $OUT"
  case "$OUT" in *"no da el árbol del commit"*) ok "…diciendo que la lista no da el árbol del commit" ;; *) mal "no lo dice: $OUT" ;; esac
  # (c) un item alterado: la punta no entra; la instalada sigue
  harness_lab_team_azure_control '{ "pat": "pat-lab", "tamper_item": "perfil-equipo.json" }'
  harness_lab_publish_stable 2026.10.08.4
  OUT="$(harness_release update --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado "d['team']['commit']")" = "$C0" ] && ok "item alterado: la punta no entra y la instalada sigue" || mal "item alterado: rc $RC team=$(estado "d.get('team')") $OUT"
  case "$OUT" in *"no es el blob"*) ok "…diciendo que el archivo no es el blob declarado" ;; *) mal "no lo dice: $OUT" ;; esac
  # (d) todo sano otra vez: la punta nueva entra
  harness_lab_team_azure_control '{ "pat": "pat-lab" }'
  harness_lab_publish_stable 2026.10.08.5
  OUT="$(harness_release update --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado "d['team']['commit']")" = "$(team_head)" ] && [ "$(explain_key "$(NEW)" integraciones nightly)" = "false perfil" ] && ok "sano otra vez: la punta nueva entra" || mal "la punta no entró: rc $RC $(estado "d.get('team')") $OUT"
  kill "$LAB_RELEASE_PROCESS" "$LAB_AZURE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── TZ13 ───────────────────────────────────────────────────────────────────
if corre TZ13; then
  echo "TZ13 · la mudanza con la clave team del clon = la URL de Azure: el plan la nombra; sin credencial no arranca; con el PAT la capa queda y el perfil no se funde"
  harness_lab_create "$BASE/lab13"
  export TYCON_PROFILE=
  printf '{ "ado": { "org": "https://dev.azure.com/acme" }, "integrations": { "clockify": true, "engram": true, "nightly": true }, "update": { "channel": "latest", "apply": "auto", "source": "internal" }, "packs": { "default": "all" }, "install": { "profile": "full" } }\n' > "$LAB_TREE/perfil-equipo.json"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.08.1
  harness_lab_team_repo
  harness_lab_team_azure_server
  harness install --yes >"$BASE/lab13/install.out" 2>&1 || mal "la instalación desde el clon falló: $(tail -3 "$BASE/lab13/install.out" | tr '\n' ' ')"
  harness_lab_team_set_clone_key "$LAB_TEAM_URL"
  H0="$(harness_lab_home_hash)"
  # (a) sin credencial: la mudanza no arranca y dice las dos formas
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 1 ] && ok "sin credencial: migrate sale 1" || mal "sin credencial: rc $RC: $OUT"
  case "$OUT" in *"sin credencial de Azure DevOps para $LAB_TEAM_URL"*"config set azure.token"*) ok "…diciendo qué falta y cómo ponerla" ;; *) mal "no lo dice: $OUT" ;; esac
  [ "$(harness_lab_home_hash)" = "$H0" ] && ok "…sin escribir nada" || mal "sin credencial escribió"
  # (b) con el PAT: el plan nombra la capa por su URL y dice que el perfil no se funde
  pat_guardado
  H0="$(harness_lab_home_hash)"
  OUT="$(harness migrate --to-home --dry-run 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "--dry-run sale 0" || mal "--dry-run rc $RC: $OUT"
  case "$OUT" in *"capa del equipo $LAB_TEAM_URL @ "*"2 archivo(s)"*) ok "el plan nombra la capa por su URL de Azure" ;; *) mal "el plan no nombra la capa: $OUT" ;; esac
  case "$OUT" in *"perfil del equipo: viaja en la capa del equipo ($LAB_TEAM_URL), no se funde"*) ok "…y que el perfil viaja en la capa" ;; *) mal "no dice que el perfil no se funde: $OUT" ;; esac
  [ "$(harness_lab_home_hash)" = "$H0" ] && ok "--dry-run no escribió nada" || mal "--dry-run escribió"
  # (c) la mudanza entera
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "migrate --to-home sale 0" || mal "migrate rc $RC: $OUT"
  NEWT="$LAB_HOME/.tycon/harness"
  [ -f "$NEWT/perfil-equipo.json" ] && [ -f "$NEWT/.tycon-team.json" ] && ok "la capa está en ~/.tycon/harness" || mal "falta la capa en $NEWT"
  case "$(explain_key "$NEWT" ado org)" in *acme*" perfil") ok "explain del árbol nuevo: ado.org con origen perfil" ;; *) mal "ado.org: $(explain_key "$NEWT" ado org)" ;; esac
  case "$(explain_key "$NEWT" integraciones clockify)" in "false apagado") ok "clockify (sólo en el perfil del clon) no se fundió" ;; *) mal "clockify: $(explain_key "$NEWT" integraciones clockify)" ;; esac
  STATE="$LAB_HOME/.tycon/state/harness-state.json"
  [ "$(j "$STATE" "d['team']['repo']")" = "$LAB_TEAM_URL" ] && [ "$(j "$STATE" "d['team']['host']")" = azure ] && [ "$(j "$STATE" "d['team']['commit']")" = "$(team_head)" ] && ok "el estado mudado trae team con la URL de Azure y el commit" || mal "team en el estado: $(j "$STATE" "d.get('team')")"
  kill "$LAB_RELEASE_PROCESS" "$LAB_AZURE_PROCESS" 2>/dev/null
fi

echo
if [ "$FALLOS" = 0 ]; then echo "harness-team-azure: todo verde"; else echo "harness-team-azure: $FALLOS fallo(s)"; exit 1; fi
