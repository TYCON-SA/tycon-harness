#!/usr/bin/env bash
# harness-release.test.sh — la instalación `release`: una versión BAJADA de GitHub como archivos, sin git (story 8.23,
# tanda B · T8 a T16).
#
# Lo que no se puede perder:
#   T9  · `update --check` en una instalación `release` mira la API —la ref del canal (`mirror/sync` con barra), y su
#         `version.json` con If-None-Match— y decide POR NÚMERO: `mirror/sync` mayor → 3; menor o ausente → lee `main`
#         (0 al día, con la nota); `stable` lee `main`; el segundo pedido lleva el ETag y no baja nada; pasa por el proxy
#         de HTTP_PROXY; un proxy mudo es «proxy sin respuesta»; una IP no ruteable es «sin red» dentro del tope; 401,
#         404 y el límite de la API son 2, cada uno con su motivo.
#   T11 · la credencial es SIEMPRE el permiso pegado una vez (`config set github.token`, por stdin): con una guardada
#         en git y un permiso, usa el permiso y nunca la guardada; sin permiso y el repo privado, `install` sale 1 y
#         `update` 2 con UNA acción (crear el permiso, el enlace, pegarlo); un 404 nombra las tres causas y, con
#         `/user`, cuál es la probable; git NUNCA se invoca (un `git` testigo en el PATH); el valor del permiso no aparece
#         en NADA de lo escrito (estado, registros, salidas, settings) salvo su archivo, que queda 0600.
#
# Laboratorio: scripts/tests/lib/harness-lab.sh (la máquina sin arnés + el servidor de juguete). Nunca ~/.claude ni el
# checkout real. 🔴 Sin pipes sobre el comando medido.
#
#   HP  · (2026-10-14) la carpeta global de hooks de git en la versión bajada, sin que el dev corra nada: con la
#         política auto el arranque la pone, la anota y lo dice una vez en el aviso; con ask el aviso la pide y la pone
#         `update --yes`; sin el pre-push del arnés en su lugar no la pone; si la persona la sacó, el arranque no la vuelve
#         a poner.
#
# Uso: bash scripts/tests/harness-release.test.sh [--only T9|T11|HP]
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
# la política de la máquina de juguete: aplicar sin preguntar (`update --yes` sin terminal exige `auto`); lo de `ask`
# —la pregunta, el aviso de «disponible»— lo miden las suites de la 8.13 y vale igual para la versión bajada
export TYCON_UPDATE_APPLY=auto
ONLY=""; [ "${1:-}" = "--only" ] && ONLY="${2:-}"
corre() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
BASE="$(mktemp -d)"
node "$RAIZ/scripts/tests/lib/lab-guard.js" "$BASE" harness-release || exit 1
trap 'rm -rf "$BASE"; kill $(jobs -p) 2>/dev/null' EXIT
j() { python3 -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print($2)" "$1" 2>/dev/null; }
ESTADO() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"; }
estado() { j "$(ESTADO)" "$1"; }
LOG() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness/startup.log"; }
TYCON_DIR() { printf '%s' "$LAB_HOME/.tycon"; }
# el nombre del lugar del arnés se lee de su definición, no se escribe (T36 de mirror-pipeline: coincide con el repo público)
PLACE_NAME="$(node -p "require('$RAIZ/scripts/setup/harness/tycon-home.js').PLACE_NAME")"
# por la API: sin las rutas públicas (sin TYCON_RELEASE_GIT, la salvaguarda de public-git.js): el camino de antes de la
# story 8.34, que sigue siendo el de una máquina con permiso y el respaldo de una sin permiso cuando github.com no contesta
por_api() { ( unset TYCON_RELEASE_GIT; "$@" ); }
# el número de peticiones del servidor que matchean un patrón (en su registro)
pedidos() { local n; n="$(grep -c -- "$1" "$LAB_RELEASE_LOG" 2>/dev/null)"; printf '%s' "${n:-0}"; }
# instala la versión `latest` en una HOME fresca; deja en INSTALL_OUT y INSTALL_RC lo que salió
instala() {
  harness_lab_release_fresh_home
  INSTALL_OUT="$(harness install --version "${1:-latest}" --yes 2>&1)"; INSTALL_RC=$?
}

# ───────────────────────────────────────────── T9 ─────────────────────────────────────────────
if corre T9; then
  echo "T9 · update --check por la API: la ref del canal, el número, el ETag, el proxy, la red y los motivos"
  harness_lab_create "$BASE/lab9"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  instala 2026.10.07.1
  [ "$INSTALL_RC" = 0 ] && ok "install --version 2026.10.07.1 sale 0" || mal "install --version salió $INSTALL_RC: $INSTALL_OUT"
  [ "$(estado "d['sources'][0]['kind']")" = release ] && ok "el estado dice kind: release" || mal "el estado no dice release: $(harness_lab_state)"
  [ "$(estado "d['version']['number']")" = 2026.10.07.1 ] && ok "versión instalada 2026.10.07.1" || mal "versión instalada: $(estado "d['version']['number']")"
  [ -f "$(TYCON_DIR)/harness/version.json" ] && ok "el árbol quedó en ~/.tycon/harness" || mal "no hay ~/.tycon/harness/version.json"

  # al día en stable (main sin cambios): 0, y por la API el segundo pedido de version.json lleva el ETag y no pide el
  # comprimido (sin permiso se mira por info/refs: lo cuenta release-api-count.test.sh, story 8.34)
  : > "$LAB_RELEASE_LOG"
  # (2026-10-15, una máquina del equipo en Windows) la falla que anotaron arranques viejos se borra con una mirada sana a
  # mano; si no, doctor y cada sesión seguían diciendo «no se pudo actualizar» con el arnés al día
  falla="$(node -e "console.log(require(process.argv[1]).paths(process.argv[2]).failuresFile)" "$LAB_HOME/.tycon/harness/scripts/setup/harness/state.js" "$LAB_HOME")"
  mkdir -p "$(dirname "$falla")"
  printf '{"since":"2026-10-14T14:38:47.224Z","count":4,"reason":"EPERM","last":"2026-10-15T09:00:00.000Z","kind":"update"}\n' > "$falla"
  out="$(por_api harness_release update --check 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "al día: --check sale 0 ($out)" || mal "al día: --check salió $rc: $out"
  [ ! -e "$falla" ] && ok "al día: la mirada sana a mano borró la falla vieja de los arranques" || mal "la falla vieja quedó después de un --check sano: $falla"
  out="$(por_api harness_release update --check 2>&1)"; rc=$?
  [ "$(pedidos '"ifNoneMatch":"\\"')" -ge 1 ] && ok "el segundo pedido de version.json lleva If-None-Match (304 barato)" || mal "ningún pedido llevó If-None-Match: $(harness_lab_release_log)"
  [ "$(( $(pedidos tarball) + $(pedidos tar.gz) ))" = 0 ] && ok "--check no baja ningún comprimido" || mal "--check pidió el comprimido"
  [ "$(pedidos 'git/ref/heads/main')" -ge 1 ] && ok "pidió la ref de main (stable)" || mal "no pidió git/ref/heads/main: $(harness_lab_release_log)"

  # stable: una versión nueva en main → 3 con el número
  harness_lab_publish_stable 2026.10.07.2
  out="$(harness_release update --check 2>&1)"; rc=$?
  [ "$rc" = 3 ] && ok "versión nueva en main: --check sale 3" || mal "versión nueva: --check salió $rc: $out"
  case "$out" in *2026.10.07.2*) ok "dice el número nuevo" ;; *) mal "no dice 2026.10.07.2: $out" ;; esac
  case "$out" in *undefined*|*"[object"*) mal "la línea de lo disponible trae un hueco: $out" ;; *) ok "la línea de lo disponible está entera (sin undefined)" ;; esac

  # latest: mirror/sync MAYOR que main → 3 por la ref con barra; MENOR → lee main (nota); AUSENTE → lee main
  # (T44 de la story del arnés mantenido en su repo público: con un público que no tiene esa rama, o que la dejó
  #  atrás, el canal de versiones sigue `main` — donde cada merge por pedido sube el número. Lo mismo, con una
  #  instalación por git, lo fija harness-channel.test.sh, casos (7) y (8).)
  harness_release channel latest >/dev/null 2>&1
  : > "$LAB_RELEASE_LOG"
  harness_lab_publish_sync 2026.10.07.5
  out="$(por_api harness_release update --check 2>&1)"; rc=$?
  [ "$rc" = 3 ] && ok "latest con mirror/sync mayor: 3" || mal "latest mayor: salió $rc: $out"
  [ "$(pedidos 'git/ref/heads/mirror/sync')" -ge 1 ] && ok "pidió la ref con barra (git/ref/heads/mirror/sync)" || mal "no pidió mirror/sync: $(harness_lab_release_log)"
  case "$out" in *2026.10.07.5*) ok "dice 2026.10.07.5" ;; *) mal "no dice 2026.10.07.5: $out" ;; esac
  harness_lab_publish_sync 2026.10.07.1
  out="$(harness_release update --check 2>&1)"; rc=$?
  [ "$rc" = 3 ] && ok "latest con mirror/sync menor que main: lee main (3 por la 2026.10.07.2)" || mal "latest menor: salió $rc: $out"
  case "$out" in *"latest lee main"*) ok "dice que latest lee main" ;; *) mal "no dice «latest lee main»: $out" ;; esac
  harness_lab_delete_sync
  out="$(harness_release update --check 2>&1)"; rc=$?
  [ "$rc" = 3 ] && ok "latest sin mirror/sync: lee main" || mal "latest sin sync: salió $rc: $out"
  case "$out" in *"no tiene mirror/sync"*) ok "dice que el remoto no tiene mirror/sync" ;; *) mal "no lo dice: $out" ;; esac
  # volver a stable sobre una instalación bajada: no hay clon que mirar; lo dice y no se queja de git
  out="$(harness_release channel stable 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "channel stable sale 0 sin clon" || mal "channel stable salió $rc: $out"
  case "$out" in *"próximo update"*) ok "dice que lo dirá el próximo update" ;; *) mal "no lo dice: $out" ;; esac
  case "$out" in *"not a git"*|*"fatal:"*|*"no es un clon"*) mal "channel stable se quejó de git: $out" ;; *) ok "sin quejas de git" ;; esac

  # proxy: HTTP_PROXY → pasa por el proxy de juguete; NO_PROXY lo saca; un proxy mudo es «proxy sin respuesta»
  : > "$LAB_RELEASE_LOG"
  out="$(HTTP_PROXY="$LAB_RELEASE_PROXY" harness_release update --check 2>&1)"; rc=$?
  [ "$rc" = 3 ] && [ "$(pedidos '"via_proxy":true')" -ge 1 ] && ok "con HTTP_PROXY los pedidos pasan por el proxy" || mal "proxy: rc=$rc, pedidos por proxy $(pedidos '"via_proxy":true'): $out"
  t0=$(date +%s)
  out="$(HTTP_PROXY="$LAB_RELEASE_MUTE_PROXY" TYCON_UPDATE_NETWORK_BUDGET_S=4 harness_release update --check 2>&1)"; rc=$?
  t1=$(date +%s)
  [ "$rc" = 2 ] && ok "proxy mudo: --check sale 2" || mal "proxy mudo: salió $rc: $out"
  case "$out" in *"proxy sin respuesta"*) ok "dice «proxy sin respuesta»" ;; *) mal "no dice «proxy sin respuesta»: $out" ;; esac
  [ $((t1 - t0)) -le 15 ] && ok "dentro del tope ($((t1 - t0)) s)" || mal "tardó $((t1 - t0)) s"

  # sin red: una IP no ruteable, dentro del tope
  t0=$(date +%s)
  out="$(TYCON_RELEASE_API=http://10.255.255.1:9 TYCON_UPDATE_NETWORK_BUDGET_S=4 por_api harness_release update --check 2>&1)"; rc=$?
  t1=$(date +%s)
  [ "$rc" = 2 ] && ok "sin red: --check sale 2" || mal "sin red: salió $rc: $out"
  case "$out" in *"sin red"*) ok "dice «sin red»" ;; *) mal "no dice «sin red»: $out" ;; esac
  [ $((t1 - t0)) -le 15 ] && ok "dentro del tope ($((t1 - t0)) s)" || mal "tardó $((t1 - t0)) s"

  # 401 (el permiso guardado no vale), 404 (repo privado sin permiso) y el límite de la API: 2 con su motivo
  printf 'clave-que-no-vale' | harness_release config set github.token >/dev/null 2>&1
  harness_lab_release_control '{ "auth": "token:la-buena" }'
  out="$(harness_release update --check 2>&1)"; rc=$?
  [ "$rc" = 2 ] && ok "401: --check sale 2" || mal "401: salió $rc: $out"
  case "$out" in *"venció"*|*"revoc"*) ok "dice que el permiso venció o se revocó" ;; *) mal "401 sin su motivo: $out" ;; esac
  harness_release config unset github.token >/dev/null 2>&1
  out="$(harness_release update --check 2>&1)"; rc=$?
  [ "$rc" = 2 ] && ok "404 sin permiso: --check sale 2" || mal "404: salió $rc: $out"
  case "$out" in *"sin permiso"*) ok "dice «sin permiso»" ;; *) mal "404 sin su motivo: $out" ;; esac
  harness_lab_release_control '{ "auth": "none", "ratelimit": true }'
  out="$(por_api harness_release update --check 2>&1)"; rc=$?
  [ "$rc" = 2 ] && ok "límite de la API: --check sale 2" || mal "límite: salió $rc: $out"
  case "$out" in *"GitHub limita las consultas"*"hasta las"*) ok "dice que GitHub limita las consultas, y hasta qué hora" ;; *) mal "límite sin su motivo: $out" ;; esac
  harness_lab_release_control '{ "auth": "none" }'
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T11 ────────────────────────────────────────────
if corre T11; then
  echo "T11 · la credencial: siempre el permiso pegado; git nunca; el valor nunca escrito"
  harness_lab_create "$BASE/lab11"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  harness_lab_git_witness
  LAB_PERMIT="permiso-de-laboratorio-$(date +%s)"   # no es un secreto: el detector de la copia pública lo toma por uno si se llama TOKEN
  # una credencial «guardada» en git (un helper que la contesta) y el repo privado que pide la buena
  printf '#!/bin/sh\n[ "$1" = get ] && printf "username=x\\npassword=la-guardada-de-git\\n"\nexit 0\n' > "$LAB_BIN/git-credential-lab"; chmod +x "$LAB_BIN/git-credential-lab"
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=lab
  harness_lab_release_control "{ \"auth\": \"token:$LAB_PERMIT\" }"

  # sin permiso: install sale 1 con UNA acción (crear el permiso, el enlace, pegarlo) y no escribe nada
  harness_lab_release_fresh_home
  antes="$(harness_lab_home_hash)"
  out="$(harness install --version latest --yes 2>&1)"; rc=$?
  [ "$rc" = 1 ] && ok "sin permiso y repo privado: install sale 1" || mal "install sin permiso salió $rc: $out"
  case "$out" in *"config set github.token"*) ok "la acción: pegarlo con config set github.token" ;; *) mal "no dice la acción: $out" ;; esac
  case "$out" in *"github.com/settings/"*) ok "trae el enlace para crearlo" ;; *) mal "sin el enlace: $out" ;; esac
  case "$out" in *"sin permiso"*"no ve el repo"*"invitaci"*) ok "nombra las tres causas del 404" ;; *) mal "no nombra las tres causas: $out" ;; esac
  [ "$(harness_lab_home_hash)" = "$antes" ] && ok "no escribió nada" || mal "install sin permiso escribió en la HOME"
  [ ! -d "$(TYCON_DIR)/harness" ] && ok "sin ~/.tycon/harness" || mal "dejó ~/.tycon/harness"

  # el permiso, pegado por stdin: queda 0600, y la instalación lo usa (y NUNCA la guardada de git)
  printf '%s' "$LAB_PERMIT" | harness config set github.token >/dev/null 2>&1; rc=$?
  [ "$rc" = 0 ] && ok "config set github.token sale 0" || mal "config set salió $rc"
  perm="$(python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777)[2:])' "$(TYCON_DIR)/config.json" 2>/dev/null)"
  [ "$perm" = 600 ] && ok "config.json queda 0600" || mal "config.json con permisos $perm"
  : > "$LAB_RELEASE_LOG"
  out="$(harness install --version latest --yes 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "con el permiso, install sale 0" || mal "install con permiso salió $rc: $out"
  sha="$(printf '%s' "$LAB_PERMIT" | shasum -a 256 | cut -c1-64)"
  [ "$(pedidos "\"auth_sha256\":\"$sha\"")" -ge 1 ] && ok "los pedidos a la API llevan el permiso pegado" || mal "ningún pedido llevó el permiso: $(harness_lab_release_log)"
  guardada="$(printf '%s' "la-guardada-de-git" | shasum -a 256 | cut -c1-64)"
  [ "$(pedidos "$guardada")" = 0 ] && ok "la credencial guardada de git nunca viajó" || mal "viajó la guardada de git"
  [ "$(grep -c '"host":"codeload".*"auth":true' "$LAB_RELEASE_LOG")" = 0 ] && ok "la bajada a codeload va sin la credencial" || mal "la credencial viajó a codeload"
  # git nunca invocado por el mecanismo
  [ ! -s "$LAB_GIT_WITNESS_LOG" ] && ok "git no se invocó ni una vez" || mal "git se invocó: $(head -3 "$LAB_GIT_WITNESS_LOG")"
  # 404 con /user 200: la causa probable es la invitación
  harness_lab_release_control "{ \"auth\": \"invited:$LAB_PERMIT\" }"
  out="$(harness_release update --check 2>&1)"; rc=$?
  [ "$rc" = 2 ] && ok "404 con /user 200: --check sale 2" || mal "invitación: salió $rc: $out"
  case "$out" in *"invitaci"*"probable"*|*"probable"*"invitaci"*) ok "dice que la causa probable es la invitación" ;; *) mal "no señala la invitación: $out" ;; esac
  harness_lab_release_control "{ \"auth\": \"token:$LAB_PERMIT\" }"
  harness_release doctor >/dev/null 2>&1
  harness_release update --check >/dev/null 2>&1
  harness_release startup >/dev/null 2>&1
  # el valor del permiso en NADA de lo escrito, salvo su archivo
  hits="$(grep -rl -- "$LAB_PERMIT" "$LAB_HOME" 2>/dev/null | grep -v "/\.tycon/config\.json$")"
  [ -z "$hits" ] && ok "el permiso no aparece en nada escrito (estado, registros, settings)" || mal "el permiso aparece en: $hits"
  [ -z "$(grep -l -- "$LAB_PERMIT" "$LAB_RELEASE_LOG" 2>/dev/null)" ] && ok "ni en el registro del servidor" || mal "el permiso quedó en el registro del servidor"
  salidas="$(harness_release doctor 2>&1; harness_release version 2>&1; harness_release update --check 2>&1)"
  case "$salidas" in *"$LAB_PERMIT"*) mal "el permiso aparece en una salida" ;; *) ok "ni en las salidas de doctor, version y update" ;; esac
  unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T8 ─────────────────────────────────────────────
if corre T8; then
  echo "T8 · release al lado de tree: la máquina con clon no cambia; install --version sobre ella sale 2; latest y un número que no está"
  harness_lab_create "$BASE/lab8"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  harness_lab_pull_tree
  # la máquina con clon: install de siempre, y después install --version → 2 sin escribir
  out="$(harness install --yes 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "la máquina con clon instala como siempre" || mal "install (clon) salió $rc: $out"
  [ "$(estado "d['sources'][0].get('kind','tree')")" = tree ] && ok "su estado sigue siendo tree" || mal "el estado del clon no es tree"
  antes="$(harness_lab_home_hash)"
  out="$(harness install --version latest --yes 2>&1)"; rc=$?
  [ "$rc" = 2 ] && ok "install --version sobre una máquina con clon sale 2" || mal "install --version sobre el clon salió $rc: $out"
  case "$out" in *"migrate --to-home"*) ok "y manda a la mudanza (tanda D)" ;; *) mal "no nombra migrate --to-home: $out" ;; esac
  [ "$(harness_lab_home_hash)" = "$antes" ] && ok "no escribió nada" || mal "install --version sobre el clon escribió en la HOME"
  [ ! -e "$(TYCON_DIR)" ] && ok "sin ~/.tycon" || mal "creó ~/.tycon"
  # update, rollback y doctor del clon: como siempre (sus suites de la 8.13 lo miden entero; acá, que salen como antes)
  harness update --check >/dev/null 2>&1; rc=$?; [ "$rc" = 0 ] && ok "update --check del clon sale 0 (al día)" || mal "update --check del clon salió $rc"
  harness doctor >/dev/null 2>&1; rc=$?; [ "$rc" = 0 ] && ok "doctor del clon sale 0" || mal "doctor del clon salió $rc"
  # la máquina nueva: latest, y un número que no está
  harness_lab_release_fresh_home
  out="$(harness install --version latest --yes 2>&1)"; rc=$?
  [ "$rc" = 0 ] && [ "$(estado "d['version']['number']")" = 2026.10.07.1 ] && ok "install --version latest instala la punta del canal (2026.10.07.1)" || mal "latest: rc=$rc versión $(estado "d['version']['number']"): $out"
  [ -z "$(grep -E 'incoming/|previous/' "$(ESTADO)")" ] && ok "el estado no nombra incoming/ ni previous/" || mal "el estado nombra incoming/ o previous/"
  # los enlaces de hoy, al árbol nuevo (AC 8): el lugar y agent-skills apuntan a ~/.tycon/harness
  for l in "$PLACE_NAME" agent-skills; do
    if [ -L "$LAB_HOME/.claude/$l" ] && [ "$(cd "$LAB_HOME/.claude/$l" 2>/dev/null && pwd -P)" = "$(cd "$(TYCON_DIR)/harness" && pwd -P)" ]; then ok "el enlace ~/.claude/$l apunta a ~/.tycon/harness"; else mal "el enlace ~/.claude/$l falta o apunta a otro lado: $(readlink "$LAB_HOME/.claude/$l" 2>/dev/null)"; fi
  done
  harness_lab_release_fresh_home
  out="$(harness install --version 2026.10.07.9 --yes 2>&1)"; rc=$?
  [ "$rc" = 2 ] && ok "un número que no está: sale 2" || mal "número ausente: salió $rc: $out"
  case "$out" in *"2026.10.07.9 no está"*"busqué"*) ok "dice entre qué números buscó" ;; *) mal "no dice el rango: $out" ;; esac
  [ ! -d "$(TYCON_DIR)/harness" ] && ok "no instaló nada" || mal "dejó ~/.tycon/harness"
  # --dry-run: dice qué instalaría y no escribe nada; sin --yes y sin terminal: sale 2 sin escribir; --repo explícito
  antes="$(harness_lab_home_hash)"
  out="$(harness install --version latest --dry-run 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "install --version --dry-run sale 0" || mal "--dry-run salió $rc: $out"
  case "$out" in *"se instalaría la versión 2026.10.07.1"*) ok "dice qué instalaría" ;; *) mal "no dice qué instalaría: $out" ;; esac
  [ "$(harness_lab_home_hash)" = "$antes" ] && [ ! -d "$(TYCON_DIR)/harness" ] && ok "--dry-run no escribió nada" || mal "--dry-run escribió"
  out="$(harness install --version latest 2>&1 </dev/null)"; rc=$?
  [ "$rc" = 2 ] && ok "sin --yes y sin terminal: sale 2" || mal "sin --yes salió $rc: $out"
  case "$out" in *"sin \`--yes\` y sin terminal"*) ok "y lo dice" ;; *) mal "no lo dice: $out" ;; esac
  [ "$(harness_lab_home_hash)" = "$antes" ] && ok "y no escribió nada" || mal "sin --yes escribió"
  out="$(harness install --version latest --repo "$LAB_RELEASE_ORG/$LAB_RELEASE_NAME" --yes 2>&1)"; rc=$?
  [ "$rc" = 0 ] && [ "$(estado "d['sources'][0]['repo']")" = "$LAB_RELEASE_ORG/$LAB_RELEASE_NAME" ] && ok "--repo <org/nombre> explícito instala y queda en el estado" || mal "--repo: rc=$rc repo=$(estado "d['sources'][0]['repo']"): $out"
  out="$(harness_lab_release_fresh_home; harness install --version latest --repo "sin-barra" --yes 2>&1)"; rc=$?
  [ "$rc" = 2 ] && ok "--repo sin la forma org/nombre: sale 2" || mal "--repo mal formado salió $rc: $out"
  # la punta del canal con un número sin la forma YYYY.MM.DD.N: no se instala (sería el nombre de una carpeta) y lo dice
  harness_lab_publish_stable raro
  harness_lab_release_fresh_home
  out="$(harness install --version latest --yes 2>&1)"; rc=$?
  [ "$rc" = 2 ] && ok "la punta con un número sin forma: sale 2" || mal "número sin forma: salió $rc: $out"
  case "$out" in *"raro"*"sin forma"*|*"sin forma"*"raro"*) ok "dice que «raro» no tiene forma" ;; *) mal "no lo dice: $out" ;; esac
  [ ! -d "$(TYCON_DIR)/harness" ] && ok "y no escribió nada" || mal "escribió ~/.tycon/harness con la versión sin forma"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T10 ────────────────────────────────────────────
if corre T10; then
  echo "T10 · bajar el comprimido DEL commit: cambiado → no coincide y nada queda; la rama movida → usa el commit pedido; corte a mitad"
  harness_lab_create "$BASE/lab10"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  instala latest
  [ "$INSTALL_RC" = 0 ] && ok "instalada 2026.10.07.1" || mal "install salió $INSTALL_RC: $INSTALL_OUT"
  harness_lab_publish_stable 2026.10.07.2
  harness_lab_release_control '{ "auth": "none", "tamper": true }'
  out="$(harness_release update --yes 2>&1)"; rc=$?
  [ "$rc" != 0 ] && ok "un archivo cambiado en el comprimido: update no instala (rc=$rc)" || mal "update instaló un comprimido cambiado: $out"
  case "$out" in *"no coincide"*) ok "dice «no coincide»" ;; *) mal "no dice «no coincide»: $out" ;; esac
  [ "$(estado "d['version']['number']")" = 2026.10.07.1 ] && ok "sigue en 2026.10.07.1" || mal "la versión cambió: $(estado "d['version']['number']")"
  [ -z "$(ls -A "$(TYCON_DIR)/incoming" 2>/dev/null)" ] && ok "incoming/ quedó vacía: nada a medias" || mal "quedó algo en incoming/: $(ls -A "$(TYCON_DIR)/incoming")"
  harness_lab_release_control '{ "auth": "none", "truncate": true }'
  out="$(harness_release update --yes 2>&1)"; rc=$?
  [ "$rc" != 0 ] && ok "comprimido cortado a mitad: update no instala (rc=$rc)" || mal "update instaló un comprimido cortado: $out"
  case "$out" in *cortado*|*ilegible*) ok "dice que está cortado" ;; *) mal "no lo dice: $out" ;; esac
  [ -z "$(ls -A "$(TYCON_DIR)/incoming" 2>/dev/null)" ] && ok "sin carpeta a medias" || mal "quedó algo en incoming/"
  # la rama se mueve mientras se baja: la ref dice OTRO commit, pero el comprimido es el del commit pedido (el que se miró)
  sha2="$(harness_lab_remote_head main)"
  harness_lab_publish_stable 2026.10.07.3
  harness_lab_release_control "{ \"auth\": \"none\", \"ref_moved_to\": \"$sha2\" }"
  out="$(harness_release update --yes 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "update aplica (rc=0): $out" || mal "update salió $rc: $out"
  [ "$(estado "d['version']['number']")" = 2026.10.07.2 ] && [ "$(estado "d['sources'][0]['commit']")" = "$sha2" ] && ok "instaló el commit que miró (2026.10.07.2, $sha2), no la punta que se movió" || mal "versión $(estado "d['version']['number']") commit $(estado "d['sources'][0]['commit']") (esperado 2026.10.07.2 $sha2)"
  harness_lab_release_control '{ "auth": "none" }'
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T12 ────────────────────────────────────────────
if corre T12; then
  echo "T12 · el cambio con diario: versión sana; salud roja vuelve y failed; terceros desde la caché sin red"
  harness_lab_create "$BASE/lab12"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  # el enlace del lugar ya apunta a OTRA carpeta válida: install lo fuerza a ~/.tycon/harness (pase adversarial de la B)
  harness_lab_release_fresh_home
  mkdir -p "$BASE/lab12-otro-clon/.git"
  ln -s "$BASE/lab12-otro-clon" "$LAB_HOME/.claude/$PLACE_NAME"
  INSTALL_OUT="$(harness install --version latest --yes 2>&1)"; INSTALL_RC=$?
  [ "$INSTALL_RC" = 0 ] && ok "instalada 2026.10.07.1" || mal "install salió $INSTALL_RC: $INSTALL_OUT"
  [ "$(cd "$LAB_HOME/.claude/$PLACE_NAME" 2>/dev/null && pwd -P)" = "$(cd "$(TYCON_DIR)/harness" && pwd -P)" ] && ok "el enlace del lugar que apuntaba a otro clon ahora apunta a ~/.tycon/harness" || mal "el enlace del lugar sigue en $(readlink "$LAB_HOME/.claude/$PLACE_NAME")"
  harness_lab_publish_stable 2026.10.07.2
  out="$(harness_release update --yes 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "update --yes aplica: $out" || mal "update salió $rc: $out"
  [ "$(estado "d['version']['number']")" = 2026.10.07.2 ] && ok "versión 2026.10.07.2 en el estado" || mal "versión $(estado "d['version']['number']")"
  [ "$(j "$(TYCON_DIR)/harness/.tycon-release.json" "d['version']")" = 2026.10.07.2 ] && ok "harness/ trae su manifiesto con la versión" || mal "harness/.tycon-release.json no dice 2026.10.07.2"
  [ "$(j "$(TYCON_DIR)/previous/.tycon-release.json" "d['version']")" = 2026.10.07.1 ] && ok "previous/ es la 2026.10.07.1" || mal "previous/ no es la anterior"
  [ ! -e "$(TYCON_DIR)/swap.json" ] && ok "sin diario al terminar" || mal "quedó swap.json"
  # el respaldo en shell volvió a previous/ sin tocar el estado (se simula con los dos rename a mano): el arranque
  # siguiente toma lo que hay en harness/ como la verdad y deja la versión caída como failed (pase adversarial de la B)
  T="$(TYCON_DIR)"
  mv "$T/harness" "$T/harness.tmp" && mv "$T/previous" "$T/harness" && mv "$T/harness.tmp" "$T/previous"
  node "$LAB_HOME/.claude/.tycon-pipeline/harness/bootstrap.js" startup >/dev/null 2>&1
  [ "$(estado "d['version']['number']")" = 2026.10.07.1 ] && ok "tras la vuelta atrás del shell, el estado dice lo que hay en harness/ (2026.10.07.1)" || mal "el estado dice $(estado "d['version']['number']") con harness/ en 2026.10.07.1"
  [ "$(estado "d['failed']['commit']")" = 2026.10.07.2 ] && ok "y la 2026.10.07.2 queda como failed (no se reintenta sola)" || mal "failed: $(estado "d['failed']")"
  grep -q "el respaldo volvió atrás" "$(LOG)" && ok "el registro lo dice" || mal "el registro no habla de la vuelta atrás: $(tail -3 "$(LOG)")"
  # se deshace a mano y el arranque vuelve a reconciliar: la verdad es harness/
  mv "$T/harness" "$T/harness.tmp" && mv "$T/previous" "$T/harness" && mv "$T/harness.tmp" "$T/previous"
  node "$LAB_HOME/.claude/.tycon-pipeline/harness/bootstrap.js" startup >/dev/null 2>&1
  [ "$(estado "d['version']['number']")" = 2026.10.07.2 ] && ok "deshecho a mano, el estado vuelve a 2026.10.07.2" || mal "estado en $(estado "d['version']['number']")"
  # una versión con un hook que deniega todo: la salud no pasa, vuelve y failed
  harness_lab_publish_stable 2026.10.07.3 scripts/hooks/lab-hook.js 'process.exit(2);'
  out="$(harness_release update --yes 2>&1)"; rc=$?
  [ "$rc" = 1 ] && ok "salud roja: update sale 1" || mal "salud roja: salió $rc: $out"
  case "$out" in *"no quedó sana"*"volvió sola a 2026.10.07.2"*) ok "dice que volvió sola a 2026.10.07.2" ;; *) mal "no lo dice: $out" ;; esac
  [ "$(estado "d['version']['number']")" = 2026.10.07.2 ] && ok "el estado volvió a 2026.10.07.2" || mal "estado en $(estado "d['version']['number']")"
  [ "$(j "$(TYCON_DIR)/harness/.tycon-release.json" "d['version']")" = 2026.10.07.2 ] && ok "harness/ es la 2026.10.07.2 otra vez" || mal "harness/ no volvió"
  [ "$(estado "d['failed']['commit']")" = 2026.10.07.3 ] && ok "failed registra la 2026.10.07.3" || mal "failed: $(estado "d['failed']")"
  out="$(harness_release update 2>&1)"; rc=$?
  case "$out" in *"ya falló"*) ok "no se reintenta sola ($out)" ;; *) mal "reintentó la fallida: $out" ;; esac
  # terceros: un manifiesto de juguete que declara una skill del mismo repo; dos actualizaciones con el mismo manifiesto, la segunda sin red
  tp_commit="$(harness_lab_remote_head main)"
  tp_tree="$(harness_lab_git "$LAB_REMOTE_TREE" rev-parse "$tp_commit:skills/tycon-pipeline")"
  # la clave es `third_party`, la del manifiesto real (no `thirdParty`, la del lector); dos skills del MISMO commit → un
  # solo comprimido
  entry_tp() { printf '{ "name": "%s", "install": "download", "origin": "https://github.com/%s/%s", "commit": "%s", "path": "skills/tycon-pipeline", "tree": "%s", "target": "%s", "license": "MIT" }' "$1" "$LAB_RELEASE_ORG" "$LAB_RELEASE_NAME" "$tp_commit" "$tp_tree" "$2"; }
  manifest="{ \"retirement\": \"done\", \"third_party\": [ $(entry_tp lab-third skills/lab-third), $(entry_tp lab-third-2 skills/lab-third-2) ] }"
  harness_lab_publish_stable 2026.10.07.4 scripts/hooks/lab-hook.js 'process.exit(0);'   # el hook sano otra vez
  harness_lab_publish_stable 2026.10.07.5 scripts/publishing/third-party-skills.json "$manifest"
  : > "$LAB_RELEASE_LOG"
  out="$(harness_release update --yes 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "update con terceros aplica" || mal "update con terceros salió $rc: $out"
  [ -f "$(TYCON_DIR)/harness/skills/lab-third/SKILL.md" ] && [ -f "$(TYCON_DIR)/harness/skills/lab-third-2/SKILL.md" ] && ok "las dos skills de terceros quedaron en harness/skills/" || mal "falta skills/lab-third*: $out · $(tail -3 "$(LOG)")"
  [ "$(pedidos "tar.gz/$tp_commit")" = 1 ] && ok "las dos salieron de UN comprimido del origen" || mal "pidió el comprimido $(pedidos "tar.gz/$tp_commit") veces"
  harness_lab_publish_stable 2026.10.07.6
  : > "$LAB_RELEASE_LOG"
  out="$(harness_release update --yes 2>&1)"; rc=$?
  [ "$rc" = 0 ] && [ -f "$(TYCON_DIR)/harness/skills/lab-third/SKILL.md" ] && ok "la segunda vez también está" || mal "segunda: rc=$rc"
  [ "$(( $(pedidos "tarball/$tp_commit") + $(pedidos "tar.gz/$tp_commit") ))" = 0 ] && ok "y salió de la caché, sin pedirla otra vez" || mal "volvió a bajar la de terceros"
  # la caché se verifica por los bytes, no por su manifiesto: un archivo tocado en la caché se vuelve a bajar
  cache_skill="$(ls -d "$(TYCON_DIR)"/third-party/*/skills__lab-third | head -1)"
  printf 'pisado\n' >> "$cache_skill/SKILL.md"
  harness_lab_publish_stable 2026.10.07.7
  : > "$LAB_RELEASE_LOG"
  out="$(harness_release update --yes 2>&1)"; rc=$?
  [ "$rc" = 0 ] && [ "$(pedidos "tar.gz/$tp_commit")" -ge 1 ] && ok "la caché tocada no se usó: volvió a bajar del origen" || mal "la caché tocada se usó igual (rc=$rc, pedidos $(pedidos "tar.gz/$tp_commit"))"
  grep -q pisado "$(TYCON_DIR)/harness/skills/lab-third/SKILL.md" && mal "la skill instalada trae el archivo pisado" || ok "la skill instalada es la del árbol declarado"
  # ── story 8.23, tanda G (pase adversarial, clase 12 + revisores de la vuelta 2): con la versión AL DÍA, `update` repone
  # lo que falta o está mal de terceros (desde la caché, sin red), y la verificación del aplicador los ve por la caché ──
  TP="$RAIZ/scripts/publishing/install-third-party.js"
  M12="$BASE/lab12/manifest-check.json"
  printf '{ "retirement": "done", "own": [], "derived": [], "third_party": [ { "target": "skills/lab-third", "install": "download", "license": "MIT", "license_source": "LICENSE del origen (laboratorio)", "used_by": [], "why": "laboratorio", "origin": "https://github.com/%s/%s", "commit": "%s", "path": "skills/tycon-pipeline", "tree": "%s", "omit": [] } ] }\n' "$LAB_RELEASE_ORG" "$LAB_RELEASE_NAME" "$tp_commit" "$tp_tree" > "$M12"
  REPO12="$LAB_HOME/.claude/agent-skills"
  out="$(node "$TP" --repo "$REPO12" --manifest "$M12" --check 2>&1)"
  [ -z "$out" ] && ok "la verificación del aplicador, por la CACHÉ de la bajada: con la skill entera, calla" || mal "con la skill entera dijo: «${out}»"
  printf 'contenido mal\n' >> "$(TYCON_DIR)/harness/skills/lab-third/SKILL.md"
  out="$(node "$TP" --repo "$REPO12" --manifest "$M12" --check 2>&1)"
  case "$out" in *"lab-third"*"no da el árbol declarado"*"harness.js update"*) ok "con el contenido mal, lo nombra por la caché y manda a harness.js update" ;; *) mal "con el contenido mal: «${out}»" ;; esac
  : > "$LAB_RELEASE_LOG"
  out="$(harness_release update --yes 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ! grep -q "contenido mal" "$(TYCON_DIR)/harness/skills/lab-third/SKILL.md" && ok "update AL DÍA repone la skill con el contenido mal (desde la caché)" || mal "update al día no la repuso: rc $rc: $out · $(tail -2 "$(TYCON_DIR)/harness/skills/lab-third/SKILL.md")"
  case "$out" in *"skills de terceros que faltaban (skills/lab-third)"*repuestas*) ok "…y lo dice" ;; *) mal "update no dice qué repuso: $out" ;; esac
  [ "$(( $(pedidos "tarball/$tp_commit") + $(pedidos "tar.gz/$tp_commit") ))" = 0 ] && ok "…sin pedir el comprimido (la caché estaba bien)" || mal "al día volvió a bajar el comprimido"
  rm -rf "$(TYCON_DIR)/harness/skills/lab-third"
  out="$(harness_release update --yes 2>&1)"; rc=$?
  [ "$rc" = 0 ] && [ -f "$(TYCON_DIR)/harness/skills/lab-third/SKILL.md" ] && ok "update AL DÍA repone la skill que falta entera" || mal "update al día no repuso la que faltaba: rc $rc: $out"
  [ -f "$(TYCON_DIR)/harness/skills/lab-third-2/SKILL.md" ] && ok "…y no toca la que estaba bien" || mal "lab-third-2 desapareció"
  out="$(harness_release update --yes 2>&1)"
  case "$out" in *"que faltaban"*) mal "con todo entero, update igual dice que repuso: $out" ;; *) ok "con todo entero, update al día no repone nada" ;; esac
  # `only`: la que está bien no se vuelve a copiar (el registro no la nombra otra vez)
  N_COPIAS="$(grep -c "skills/lab-third-2 desde la caché" "$(LOG)")"
  rm -rf "$(TYCON_DIR)/harness/skills/lab-third"
  harness_release update --yes >/dev/null 2>&1
  [ "$(grep -c "skills/lab-third-2 desde la caché" "$(LOG)")" = "$N_COPIAS" ] && [ -f "$(TYCON_DIR)/harness/skills/lab-third/SKILL.md" ] && ok "al día repone SÓLO lo que falta: la otra skill no se vuelve a copiar (only)" || mal "al día volvió a copiar la que estaba bien ($N_COPIAS → $(grep -c "skills/lab-third-2 desde la caché" "$(LOG)"))"
  # sin manifiesto en la caché, el contenido distinto NO se puede saber sin red: al día sólo cuenta lo que falta entero
  rm -rf "$(TYCON_DIR)"/third-party/*/skills__lab-third
  printf 'contenido mal\n' >> "$(TYCON_DIR)/harness/skills/lab-third/SKILL.md"
  : > "$LAB_RELEASE_LOG"
  out="$(harness_release update --yes 2>&1)"; rc=$?
  [ "$rc" = 0 ] && [ "$(( $(pedidos "tarball/$tp_commit") + $(pedidos "tar.gz/$tp_commit") ))" = 0 ] && grep -q "contenido mal" "$(TYCON_DIR)/harness/skills/lab-third/SKILL.md" && ok "sin caché, al día (update sale 0, sin pedir el comprimido) no toca una skill presente con otro contenido: no puede saberlo sin red" || mal "sin caché, al día: rc $rc, pedidos $(( $(pedidos "tarball/$tp_commit") + $(pedidos "tar.gz/$tp_commit") )), contenido $(tail -1 "$(TYCON_DIR)/harness/skills/lab-third/SKILL.md"): $out"
  case "$out" in *"que faltaban"*) mal "sin caché dijo que repuso algo: $out" ;; *) ok "…y no dice que repuso nada" ;; esac
  # el filtro del manifiesto: un destino fuera del árbol y un commit sin forma de sha se dicen y no se tocan
  manifest_malo="{ \"retirement\": \"done\", \"third_party\": [ $(entry_tp lab-third skills/lab-third), { \"name\": \"fuera\", \"install\": \"download\", \"origin\": \"https://github.com/$LAB_RELEASE_ORG/$LAB_RELEASE_NAME\", \"commit\": \"$tp_commit\", \"path\": \"skills/tycon-pipeline\", \"tree\": \"$tp_tree\", \"target\": \"../fuera-del-arbol\", \"license\": \"MIT\" }, { \"name\": \"sin-sha\", \"install\": \"download\", \"origin\": \"https://github.com/$LAB_RELEASE_ORG/$LAB_RELEASE_NAME\", \"commit\": \"abc\", \"path\": \"skills/tycon-pipeline\", \"tree\": \"$tp_tree\", \"target\": \"skills/sin-sha\", \"license\": \"MIT\" } ] }"
  harness_lab_publish_stable 2026.10.07.8 scripts/publishing/third-party-skills.json "$manifest_malo"
  out="$(harness_release update --yes 2>&1)"; rc=$?
  [ "$rc" = 0 ] && [ "$(estado "d['version']['number']")" = 2026.10.07.8 ] && ok "con un manifiesto que trae entradas malas, la versión se instala igual" || mal "update con entradas malas: rc $rc: $out"
  case "$out" in *"../fuera-del-arbol"*"no es un destino dentro del árbol"*) ok "…el destino fuera del árbol se dice y no se toca" ;; *) mal "no dice el destino fuera del árbol: $out" ;; esac
  case "$out" in *"skills/sin-sha"*"no tiene forma de sha"*) ok "…y el commit sin forma de sha también" ;; *) mal "no dice el commit sin forma: $out" ;; esac
  [ ! -e "$(TYCON_DIR)/fuera-del-arbol" ] && [ ! -e "$(TYCON_DIR)/harness/skills/sin-sha" ] && [ -z "$(ls "$(TYCON_DIR)/incoming" 2>/dev/null)" ] && ok "…y nada se escribió fuera del árbol ni para esas entradas" || mal "se escribió algo para las entradas malas: $(ls "$(TYCON_DIR)" "$(TYCON_DIR)/incoming" 2>/dev/null | tr '\n' ' ')"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T13 ────────────────────────────────────────────
if corre T13; then
  echo "T13 · un corte entre los dos rename se repara en el arranque siguiente desde el diario"
  harness_lab_create "$BASE/lab13"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  instala latest
  harness_lab_publish_stable 2026.10.07.2
  harness_release update --yes >/dev/null 2>&1
  # el corte: harness/ ya salió a previous-nueva, incoming/<v> todavía no entró — se simula con el diario en «harness-out»
  T="$(TYCON_DIR)"
  rm -rf "$T/trash"; mkdir -p "$T/incoming"
  mv "$T/harness" "$T/incoming/2026.10.07.9" && printf '{ "version": "2026.10.07.9", "files": [] , "commit": "x", "tree": "y" }\n' > "$T/incoming/2026.10.07.9/.tycon-release.json"
  printf '{ "schema": 1, "stage": "harness-out", "incoming": "%s", "version": "2026.10.07.9", "harness": "%s", "previous": "%s" }\n' "$T/incoming/2026.10.07.9" "$T/harness" "$T/previous" > "$T/swap.json"
  out="$(node "$LAB_HOME/.claude/.tycon-pipeline/harness/bootstrap.js" startup 2>&1)"; rc=$?
  [ -d "$T/harness" ] && ok "el arranque (bootstrap.js) completó el cambio: harness/ está" || mal "harness/ no está tras el arranque: $out"
  [ ! -e "$T/swap.json" ] && ok "el diario se sacó" || mal "queda swap.json"
  grep -q "reparaci" "$(LOG)" && ok "el registro dice que reparó" || mal "el registro no dice reparación: $(tail -3 "$(LOG)")"
  # harness/ borrada a mano, con previous/: el arranque vuelve a la anterior (diario «harness-out» sin incoming)
  rm -rf "$T/harness"
  printf '{ "schema": 1, "stage": "harness-out", "incoming": "%s", "version": "x", "harness": "%s", "previous": "%s" }\n' "$T/incoming/nada" "$T/harness" "$T/previous" > "$T/swap.json"
  node "$LAB_HOME/.claude/.tycon-pipeline/harness/bootstrap.js" startup >/dev/null 2>&1
  [ -d "$T/harness" ] && [ ! -e "$T/swap.json" ] && ok "sin la nueva, el arranque deshizo: previous → harness" || mal "no deshizo: $(ls "$T")"
  # por el respaldo en shell (sin node en el camino de la reparación)
  mv "$T/harness" "$T/incoming/2026.10.07.9"
  printf '{ "schema": 1, "stage": "harness-out", "incoming": "%s", "version": "2026.10.07.9", "harness": "%s", "previous": "%s" }\n' "$T/incoming/2026.10.07.9" "$T/harness" "$T/previous" > "$T/swap.json"
  bash "$LAB_HOME/.claude/.tycon-pipeline/harness/bootstrap-fallback.sh" >/dev/null 2>&1
  [ -d "$T/harness" ] && [ ! -e "$T/swap.json" ] && ok "el respaldo en shell también repara desde el diario" || mal "el respaldo en shell no reparó: $(ls "$T")"
  grep -q "respaldo en shell" "$(LOG)" && ok "y lo dice en el registro" || mal "el respaldo no dejó su línea"
  # el corte justo DESPUÉS de escribir «previous-cleared» (o «start») pero antes del primer rename: harness/ ya no está
  # y la etapa es la vieja; bootstrap.js y el respaldo en shell lo completan igual
  mv "$T/harness" "$T/incoming/2026.10.07.9"
  printf '{ "schema": 1, "stage": "previous-cleared", "incoming": "%s", "version": "2026.10.07.9", "harness": "%s", "previous": "%s" }\n' "$T/incoming/2026.10.07.9" "$T/harness" "$T/previous" > "$T/swap.json"
  node "$LAB_HOME/.claude/.tycon-pipeline/harness/bootstrap.js" startup >/dev/null 2>&1
  [ -d "$T/harness" ] && [ ! -e "$T/swap.json" ] && ok "«previous-cleared» con harness/ ausente: bootstrap.js completó el cambio" || mal "previous-cleared no se reparó: $(ls "$T")"
  mv "$T/harness" "$T/incoming/2026.10.07.9"
  printf '{ "schema": 1, "stage": "start", "incoming": "%s", "version": "2026.10.07.9", "harness": "%s", "previous": "%s" }\n' "$T/incoming/2026.10.07.9" "$T/harness" "$T/previous" > "$T/swap.json"
  bash "$LAB_HOME/.claude/.tycon-pipeline/harness/bootstrap-fallback.sh" >/dev/null 2>&1
  [ -d "$T/harness" ] && [ ! -e "$T/swap.json" ] && ok "«start» con harness/ ausente: el respaldo en shell completó el cambio" || mal "start no se reparó en shell: $(ls "$T")"
  # sin node en el PATH el respaldo no sabe si harness.js arranca: no vuelve a nada, y lo dice
  mkdir -p "$T/previous"
  before="$(ls "$T/harness" | wc -l | tr -d ' ')"
  PATH="/usr/bin:/bin" bash "$LAB_HOME/.claude/.tycon-pipeline/harness/bootstrap-fallback.sh" >/dev/null 2>&1
  [ "$(ls "$T/harness" | wc -l | tr -d ' ')" = "$before" ] && [ -d "$T/previous" ] && ok "sin node, el respaldo no volvió a previous/" || mal "sin node el respaldo movió carpetas: $(ls "$T")"
  grep -q "node no está en el PATH" "$(LOG)" && ok "y dice que node no está en el PATH" || mal "no dice que falta node: $(tail -2 "$(LOG)")"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T17 ────────────────────────────────────────────
if corre T17; then
  echo "T17 · doctor en release: cada archivo contra su manifiesto; lo de terceros no es «de más»; sin git; sin red salvo --fetch"
  harness_lab_create "$BASE/lab17"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  instala latest
  T="$(TYCON_DIR)"
  out="$(harness_release doctor 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "doctor sale 0 sobre la instalación sana" || mal "doctor salió $rc: $out"
  case "$out" in *"2026.10.07.1"*"stable"*|*"stable"*"2026.10.07.1"*) ok "dice la versión y el canal" ;; *) mal "no dice versión y canal: $out" ;; esac
  case "$out" in *"sin versión anterior"*) ok "dice que no hay previous/" ;; *) mal "no habla de previous/: $out" ;; esac
  case "$out" in *"son los del manifiesto"*) ok "los archivos son los del manifiesto" ;; *) mal "no compara con el manifiesto: $out" ;; esac
  # un archivo editado y uno de más: aviso con la ruta, sin rojo
  printf '// editado a mano\n' >> "$T/harness/README.md"
  printf 'x\n' > "$T/harness/scripts/de-mas.txt"
  out="$(harness_release doctor 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "editado y de más: doctor sigue en 0 (avisos)" || mal "doctor salió $rc: $out"
  case "$out" in *"README.md: editado en la carpeta del arnés"*) ok "nombra el editado con su ruta" ;; *) mal "no nombra README.md editado: $out" ;; esac
  case "$out" in *"scripts/de-mas.txt: de más"*) ok "nombra el de más con su ruta" ;; *) mal "no nombra de-mas.txt: $out" ;; esac
  rm -f "$T/harness/scripts/de-mas.txt"
  # lo de terceros no cuenta como de más
  mkdir -p "$T/harness/skills/lab-third"; printf '# tercero\n' > "$T/harness/skills/lab-third/SKILL.md"
  printf '{ "retirement": "done", "thirdParty": [ { "name": "lab-third", "install": "download", "target": "skills/lab-third" } ] }\n' > "$T/harness/scripts/publishing/third-party-skills.json"
  out="$(harness_release doctor 2>&1)"
  case "$out" in *"lab-third"*) mal "lo de terceros se contó como de más: $out" ;; *) ok "lo de terceros no se cuenta como de más" ;; esac
  # sin git en el PATH, doctor corre igual; sin --fetch no sale a la red
  : > "$LAB_RELEASE_LOG"
  mkdir -p "$BASE/bin-sin-git"; for b in node python3 bash sh; do p="$(command -v $b)"; [ -n "$p" ] && ln -sf "$p" "$BASE/bin-sin-git/$b"; done
  out="$(PATH="$BASE/bin-sin-git" harness_release doctor 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "sin git en el PATH, doctor sale 0" || mal "sin git: doctor salió $rc: $out"
  case "$out" in *"falta git"*) mal "pide git: $out" ;; *) ok "no pide git" ;; esac
  [ "$(( $(pedidos repos) + $(pedidos info/refs) ))" = 0 ] && ok "sin --fetch no sale a la red" || mal "doctor salió a la red sin --fetch"
  out="$(harness_release doctor --fetch 2>&1)"
  [ "$(pedidos 'info/refs')" -ge 1 ] && ok "--fetch sí mira la red (info/refs: sin permiso no gasta la API)" || mal "--fetch no miró la red"
  case "$out" in *"red: "*) ok "y dice qué vio" ;; *) mal "no dice qué vio: $out" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T18 ────────────────────────────────────────────
if corre T18; then
  echo "T18 · los avisos sobre una instalación release: ninguno corre git sobre ~/.tycon; leen el clon declarado o callan; ninguno rojo"
  harness_lab_create "$BASE/lab18"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  instala latest
  T="$(TYCON_DIR)"
  harness_lab_git_witness
  # los avisos REALES del repo bajo prueba, apuntados al árbol bajado (TYCON_GUIDES_DIR) y con la HOME de juguete
  avisos="scripts/hooks/branch-guard-notice.js scripts/hooks/dependencies-notice.js scripts/hooks/dashboard-notice.js scripts/hooks/produccion-notice.js skills/tycon-pipeline/scripts/lib/guides-heal.js"
  corre_avisos() { # corre_avisos <etiqueta>
    local a out rc
    for a in $avisos; do
      [ -f "$RAIZ/$a" ] || continue
      out="$(TYCON_GUIDES_DIR="$T/harness" TYCON_EVAL_SANDBOX= node "$RAIZ/$a" 2>&1 </dev/null)"; rc=$?
      [ "$rc" = 0 ] && ok "$1 $(basename "$a") sale 0" || mal "$1 $(basename "$a") salió $rc: $out"
      case "$out" in *"not a git"*|*"no es un clon"*|*"no es un repo"*|*"no pude leer lo publicado"*|*"fatal:"*) mal "$1 $(basename "$a") se quejó del git: $out" ;; *) ok "$1 $(basename "$a") no se queja de git" ;; esac
    done
  }
  corre_avisos "sin clon declarado:"
  [ -z "$(grep -- "/.tycon/" "$LAB_GIT_WITNESS_LOG" 2>/dev/null)" ] && ok "ningún aviso corrió git sobre ~/.tycon" || mal "git sobre ~/.tycon: $(grep -- "/.tycon/" "$LAB_GIT_WITNESS_LOG" | head -3)"
  # una ruta que no vale no se guarda: relativa, inexistente o sin .git
  for bad in "relativa/clon" "$BASE/no-existe" "$LAB_HOME"; do
    out="$(printf '%s' "$bad" | harness_release config set paths.maintained 2>&1)"; rc=$?
    [ "$rc" = 2 ] && ok "paths.maintained rechaza «$(basename "$bad")» (${out})" || mal "paths.maintained aceptó «${bad}» (rc=${rc})"
  done
  # con el clon que la máquina mantiene declarado: los que miran el repo lo leen
  printf '%s' "$LAB_TREE" | harness_release config set paths.maintained >/dev/null 2>&1
  : > "$LAB_GIT_WITNESS_LOG"
  corre_avisos "con paths.maintained:"
  [ -z "$(grep -- "/.tycon/" "$LAB_GIT_WITNESS_LOG" 2>/dev/null)" ] && ok "tampoco ahora git sobre ~/.tycon" || mal "git sobre ~/.tycon: $(grep -- "/.tycon/" "$LAB_GIT_WITNESS_LOG" | head -3)"
  [ "$(node -e 'const h=require(process.argv[1]);process.stdout.write(String(h.maintainedDir(process.env.HOME, "x")))' "$RAIZ/scripts/setup/harness/tycon-home.js")" = "$LAB_TREE" ] && ok "maintainedDir devuelve el clon declarado" || mal "maintainedDir no devuelve paths.maintained"
  # y con el clon de MANTENIMIENTO declarado (de ahí leen la noche los avisos: scripts/lib/night-data.js; su lectura
  # la prueba scripts/tests/night-notices.test.js): tampoco git sobre ~/.tycon, ni queja
  printf '%s' "$LAB_TREE" | harness_release config set paths.maintainers >/dev/null 2>&1
  : > "$LAB_GIT_WITNESS_LOG"
  corre_avisos "con paths.maintainers:"
  [ -z "$(grep -- "/.tycon/" "$LAB_GIT_WITNESS_LOG" 2>/dev/null)" ] && ok "con el clon de mantenimiento declarado, tampoco git sobre ~/.tycon" || mal "git sobre ~/.tycon: $(grep -- "/.tycon/" "$LAB_GIT_WITNESS_LOG" | head -3)"
  harness_release config unset paths.maintainers >/dev/null 2>&1
  # el consejo «git pull» del instalador y de pipeline.js (AC 18): sobre una instalación release dice harness.js update.
  # El tramo del instalador sólo se imprime cuando falta un control en el disco: se ejercita su rama a mano, con el
  # estado release de esta máquina
  out="$(bash -c 'SCRIPT_DIR="$1"; HOME="$2"; _tcg_root="$(cd "$SCRIPT_DIR/.." && pwd)"; _state_file="$(node -e "process.stdout.write(require(process.argv[1]).stateDir())" "$SCRIPT_DIR/setup/harness/tycon-home.js" 2>/dev/null)/harness-state.json"; if grep -q "\"kind\":[[:space:]]*\"release\"" "$_state_file" 2>/dev/null; then echo "     node $_tcg_root/scripts/setup/harness.js update"; else echo "     git -C x pull --ff-only && git -C $_tcg_root pull --ff-only"; fi' _ "$T/harness/scripts" "$LAB_HOME")"
  case "$out" in *"harness.js update"*) ok "el consejo del instalador en release dice harness.js update" ;; *) mal "el consejo del instalador sigue diciendo git pull: $out" ;; esac
  grep -q 'harness.js update; en un clon, git pull' "$RAIZ/skills/tycon-pipeline/scripts/pipeline.js" && ok "el consejo de pipeline.js nombra harness.js update antes que git pull" || mal "pipeline.js sigue aconsejando sólo git pull"
  grep -q '"kind":\[\[:space:\]\]\*"release"' "$RAIZ/scripts/install-tycon-hooks.sh" && ok "el instalador decide el consejo por la forma de la instalación" || mal "el instalador no mira la forma de la instalación"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T19 ────────────────────────────────────────────
if corre T19; then
  echo "T19 · el respaldo en shell en release: con harness.js roto vuelve a previous/ y aplica, sin git ni bajar nada; sin previous/, el aviso"
  harness_lab_create "$BASE/lab19"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  instala latest
  T="$(TYCON_DIR)"
  harness_lab_git_witness
  : > "$LAB_RELEASE_LOG"
  # sin previous/ y con harness.js roto: el respaldo no baja nada, aplica con lo que hay y deja el aviso con el comando
  cp "$T/harness/scripts/setup/harness.js" "$BASE/harness.js.sano"
  printf "'use strict';\nfunction roto( {\n" > "$T/harness/scripts/setup/harness.js"
  out="$(bash "$LAB_HOME/.claude/.tycon-pipeline/harness/bootstrap-fallback.sh" 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "el respaldo sale 0" || mal "el respaldo salió $rc: $out"
  grep -q "install --version" "$(LOG)" && ok "sin previous/: el registro deja el comando install --version" || mal "el registro no nombra install --version: $(tail -2 "$(LOG)")"
  [ ! -s "$LAB_GIT_WITNESS_LOG" ] && ok "git no se invocó" || mal "el respaldo invocó git: $(head -2 "$LAB_GIT_WITNESS_LOG")"
  [ "$(( $(pedidos tarball) + $(pedidos tar.gz) ))" = 0 ] && ok "no bajó nada" || mal "el respaldo pidió un comprimido"
  cp "$BASE/harness.js.sano" "$T/harness/scripts/setup/harness.js"
  # con previous/: vuelve a ella y aplica desde ~/.tycon/harness
  harness_lab_publish_stable 2026.10.07.2
  harness_release update --yes >/dev/null 2>&1
  printf "'use strict';\nfunction roto( {\n" > "$T/harness/scripts/setup/harness.js"
  : > "$LAB_GIT_WITNESS_LOG"
  antes_app="$(grep -c '^run ' "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log" 2>/dev/null || echo 0)"
  out="$(bash "$LAB_HOME/.claude/.tycon-pipeline/harness/bootstrap-fallback.sh" 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "el respaldo sale 0" || mal "el respaldo salió $rc: $out"
  [ "$(j "$T/harness/.tycon-release.json" "d['version']")" = 2026.10.07.1 ] && ok "volvió a previous/ (la .1 es harness/ otra vez)" || mal "harness/ es $(j "$T/harness/.tycon-release.json" "d['version']")"
  [ -d "$T/trash/"failed-* ] 2>/dev/null && ok "la rota quedó apartada en trash/" || mal "la versión rota no se apartó: $(ls "$T")"
  despues_app="$(grep -c '^run ' "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log" 2>/dev/null || echo 0)"
  [ "$despues_app" -gt "$antes_app" ] && ok "corrió el aplicador de ~/.tycon/harness" || mal "el aplicador no corrió ($antes_app → $despues_app)"
  [ ! -s "$LAB_GIT_WITNESS_LOG" ] && ok "sin git" || mal "invocó git: $(head -2 "$LAB_GIT_WITNESS_LOG")"
  grep -q "volv" "$(LOG)" && ok "el registro dice que volvió" || mal "el registro no lo dice: $(tail -2 "$(LOG)")"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T14 ────────────────────────────────────────────
if corre T14; then
  echo "T14 · la previous/ vieja se aparta en el cambio y se borra en el arranque siguiente; nombrada por el estado o un enchufe, no"
  harness_lab_create "$BASE/lab14"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  instala latest
  harness_lab_publish_stable 2026.10.07.2
  harness_release update --yes >/dev/null 2>&1
  harness_lab_publish_stable 2026.10.07.3
  T="$(TYCON_DIR)"
  out="$(harness_release update --yes 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "tercera versión aplicada" || mal "update salió $rc: $out"
  [ "$(j "$T/previous/.tycon-release.json" "d['version']")" = 2026.10.07.2 ] && ok "previous/ es la 2026.10.07.2" || mal "previous/ no es la .2"
  n="$(ls "$T/trash" 2>/dev/null | wc -l | tr -d ' ')"
  [ "$n" = 1 ] && ok "la previous/ vieja (.1) se apartó a trash/ durante el cambio, no se borró" || mal "trash/ tiene $n entradas"
  apartada="$T/trash/$(ls "$T/trash")"
  harness_release startup >/dev/null 2>&1
  [ ! -e "$apartada" ] && ok "el arranque siguiente la borró" || mal "el arranque no borró $apartada"
  # nombrada por un enchufe: no se borra
  harness_lab_publish_stable 2026.10.07.4
  harness_release update --yes >/dev/null 2>&1
  apartada="$T/trash/$(ls "$T/trash")"
  python3 - "$TYCON_SETTINGS_PATH" "$apartada" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d.setdefault("hooks",{}).setdefault("SessionStart",[]).append({"hooks":[{"type":"command","command":"node "+sys.argv[2]+"/scripts/hooks/lab-hook.js"}]}); json.dump(d,open(p,"w"),indent=2)
PY
  harness_release startup >/dev/null 2>&1
  [ -d "$apartada" ] && ok "nombrada por settings.json: no se borra" || mal "se borró una carpeta que un enchufe nombra"
  grep -q "no se borra: lo nombra" "$(LOG)" && ok "y el registro dice quién la nombra" || mal "el registro no lo dice"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T15 ────────────────────────────────────────────
if corre T15; then
  echo "T15 · rollback: el cambio al revés sin bajar nada; sin previous/, dice install --version; hold"
  harness_lab_create "$BASE/lab15"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  instala latest
  out="$(harness_release rollback 2>&1)"; rc=$?
  [ "$rc" = 2 ] && ok "sin previous/: rollback sale 2" || mal "rollback sin previous salió $rc: $out"
  case "$out" in *"install --version"*) ok "y dice install --version <n>" ;; *) mal "no lo dice: $out" ;; esac
  harness_lab_publish_stable 2026.10.07.2
  harness_release update --yes >/dev/null 2>&1
  : > "$LAB_RELEASE_LOG"
  out="$(harness_release rollback 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "rollback sale 0: $out" || mal "rollback salió $rc: $out"
  [ "$(estado "d['version']['number']")" = 2026.10.07.1 ] && ok "volvió a 2026.10.07.1" || mal "versión $(estado "d['version']['number']")"
  [ "$(j "$(TYCON_DIR)/harness/.tycon-release.json" "d['version']")" = 2026.10.07.1 ] && ok "harness/ es la .1" || mal "harness/ no es la .1"
  [ "$(( $(pedidos tarball) + $(pedidos tar.gz) ))" = 0 ] && ok "no bajó nada" || mal "rollback pidió un comprimido"
  [ -n "$(estado "d['hold']")" ] && [ "$(estado "d['hold']['commit']")" = 2026.10.07.2 ] && ok "deja la retención sobre la .2" || mal "sin retención: $(estado "d['hold']")"
  out="$(harness_release update --check 2>&1)"; rc=$?
  case "$out" in *retenci*) ok "con la retención, update no avanza a la .2" ;; *) mal "update sin la retención: $out" ;; esac
  # la deshecha queda en previous/: un segundo rollback la vuelve a poner y levanta la retención (AC 15)
  [ "$(j "$(TYCON_DIR)/previous/.tycon-release.json" "d['version']")" = 2026.10.07.2 ] && ok "la deshecha (.2) quedó en previous/" || mal "previous/ no es la .2: $(ls "$(TYCON_DIR)")"
  out="$(harness_release rollback 2>&1)"; rc=$?
  [ "$rc" = 0 ] && [ "$(estado "d['version']['number']")" = 2026.10.07.2 ] && ok "un segundo rollback deshace la vuelta (otra vez en la .2)" || mal "segundo rollback: rc=$rc versión $(estado "d['version']['number']"): $out"
  case "$out" in *"deshiciste la vuelta atrás"*) ok "y dice que deshizo la vuelta" ;; *) mal "no lo dice: $out" ;; esac
  [ "$(estado "d['hold']")" = None ] && ok "y levanta la retención" || mal "la retención sigue tras deshacer: $(estado "d['hold']")"
  harness_release rollback >/dev/null 2>&1   # otra vez en la .1, con retención
  harness_release rollback --release >/dev/null 2>&1
  [ "$(estado "d['hold']")" = None ] && ok "rollback --release levanta la retención" || mal "la retención sigue: $(estado "d['hold']")"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T16 ────────────────────────────────────────────
if corre T16; then
  echo "T16 · diez actualizaciones y una vuelta: nada fuera de ~/.tycon nombra incoming/ ni previous/; la cuenta de hooks no cambia"
  harness_lab_create "$BASE/lab16"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  instala latest
  [ "$INSTALL_RC" = 0 ] && ok "instalada" || mal "install salió $INSTALL_RC: $INSTALL_OUT"
  hooks0="$(harness_lab_settings_commands | wc -l | tr -d ' ')"
  mtime0="$(python3 -c 'import os,sys; print(os.stat(sys.argv[1]).st_mtime_ns)' "$TYCON_SETTINGS_PATH")"
  sleep 1
  for i in 2 3 4 5 6 7 8 9 10 11; do
    harness_lab_publish_stable "2026.10.07.$i"
    out="$(harness_release update --yes 2>&1)" || mal "update a la .$i falló: $out"
  done
  out="$(harness_release rollback 2>&1)" || mal "rollback falló: $out"
  [ "$(estado "d['version']['number']")" = 2026.10.07.10 ] && ok "diez actualizaciones y una vuelta: en la .10" || mal "versión $(estado "d['version']['number']")"
  # lo que el arnés ESCRIBE en la máquina fuera de ~/.tycon (AC 16): los enchufes, los enlaces, el estado y la
  # configuración; el código del programa (la copia fija) nombra esas carpetas en sus textos y no es un puntero
  hits=""
  for f in "$TYCON_SETTINGS_PATH" "$CLAUDE_MD_PATH" "$CODEX_HOME/hooks.json" "$CODEX_HOME/config.toml" "$CODEX_HOME/AGENTS.md" "$(ESTADO)" "$LAB_HOME/.claude/tycon.json" "$LAB_HOME"/Library/LaunchAgents/*.plist; do
    [ -f "$f" ] && grep -q -E "tycon/incoming|tycon/previous" "$f" && hits="$hits $f"
  done
  for l in "$PLACE_NAME" agent-skills; do
    if [ -L "$LAB_HOME/.claude/$l" ]; then case "$(readlink "$LAB_HOME/.claude/$l")" in *incoming*|*previous*) hits="$hits (enlace $l)" ;; esac
    else hits="$hits (falta el enlace $l)"; fi
  done
  [ -z "$hits" ] && ok "nada escrito fuera de ~/.tycon nombra incoming/ ni previous/ (enchufes, enlaces, estado, configuración)" || mal "lo nombran: $hits"
  [ "$(harness_lab_settings_commands | wc -l | tr -d ' ')" = "$hooks0" ] && ok "la cuenta de hooks es la misma ($hooks0)" || mal "hooks: $hooks0 → $(harness_lab_settings_commands | wc -l)"
  mtime1="$(python3 -c 'import os,sys; print(os.stat(sys.argv[1]).st_mtime_ns)' "$TYCON_SETTINGS_PATH")"
  [ "$mtime1" = "$mtime0" ] && ok "settings.json no se reescribió en las actualizaciones que no cambian hooks" || mal "settings.json se reescribió ($mtime0 → $mtime1)"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T46 ────────────────────────────────────────────
# Story 8.23, tanda G · AC 43 (y 44 c): `config set` acepta el valor por argumento (no para el secreto), lee una tubería
# cuyo escritor sigue vivo (antes: «EAGAIN … read»), y en una terminal lee el secreto SIN eco y sin las marcas del
# pegado; y doctor rotula el archivo de la máquina por su ruta real. Lo encontró la primera máquina migrada (2026-10-08).
if corre T46; then
  echo "T46 · config set: por argumento, por tubería viva, el secreto nunca por argumento, la terminal sin eco; el rótulo del archivo"
  harness_lab_create "$BASE/lab46"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  instala latest
  T="$(TYCON_DIR)"
  cfg() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print($1)" "$T/config.json" 2>/dev/null || echo "(sin config.json)"; }
  # el valor por argumento (lo que el mensaje final de la mudanza y la guía ya sugerían)
  out="$(harness_release config set paths.maintained "$LAB_TREE" 2>&1)"; rc=$?
  [ "$rc" = 0 ] && [ "$(cfg "d['paths']['maintained']")" = "$LAB_TREE" ] && ok "config set paths.maintained <ruta> por argumento guarda" || mal "por argumento: rc $rc: $out · $(cat "$T/config.json" 2>/dev/null)"
  harness_release config unset paths.maintained >/dev/null 2>&1
  # una tubería con el escritor vivo (gh auth token | …): se espera a los datos
  out="$( (sleep 0.5; printf '%s' "$LAB_TREE") | harness_release config set paths.maintained 2>&1)"; rc=$?
  [ "$rc" = 0 ] && [ "$(cfg "d['paths']['maintained']")" = "$LAB_TREE" ] && ok "una tubería con el escritor vivo guarda igual (sin EAGAIN)" || mal "tubería viva: rc $rc: $out"
  case "$out" in *EAGAIN*) mal "la tubería viva dio EAGAIN: $out" ;; *) ok "…sin «EAGAIN» en la salida" ;; esac
  # el secreto NUNCA por argumento: 2 con el motivo, y nada escrito
  out="$(harness_release config set github.token un-valor-que-no-va 2>&1)"; rc=$?
  [ "$rc" = 2 ] && ok "config set github.token <valor> sale 2" || mal "el secreto por argumento salió $rc: $out"
  case "$out" in *historial*) ok "…y dice por qué (quedaría en el historial del shell)" ;; *) mal "sin el motivo: $out" ;; esac
  [ "$(cfg "d.get('github',{}).get('token')")" = None ] && ok "…y no escribió el secreto" || mal "escribió el secreto pasado por argumento"
  case "$out" in *un-valor-que-no-va*) mal "la salida repite el valor" ;; *) ok "…ni lo repite" ;; esac
  # la terminal de juguete: el secreto pegado con marcas de pegado, sin eco; queda limpio y nunca aparece en la salida
  SECRETO="permiso-pty-$(date +%s)"
  # la persona pega DESPUÉS de ver la pregunta (LAB_PTY_DELAY): escrito antes de que el programa tome la terminal, el eco
  # lo haría la terminal misma, no el programa (así no se mide nada del programa)
  out="$(LAB_PTY_DELAY=1.5 harness_lab_pty "$(printf '\033[200~%s\033[201~' "$SECRETO")" node "$LAB_HOME/.tycon/harness/scripts/setup/harness.js" config set github.token 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "en la terminal, config set github.token sale 0" || mal "en la terminal salió $rc: $out"
  [ "$(cfg "d['github']['token']")" = "$SECRETO" ] && ok "…el valor guardado está limpio (sin las marcas del pegado)" || mal "el valor guardado: «$(cfg "d['github']['token']")»"
  case "$out" in *"$SECRETO"*|*"permiso-pty"*) mal "el secreto apareció en la terminal: $out" ;; *) ok "…y el secreto nunca apareció en la terminal" ;; esac
  case "$out" in *"pegá el permiso"*) ok "…la pregunta sí" ;; *) mal "sin la pregunta: $out" ;; esac
  harness_release config unset github.token >/dev/null 2>&1
  # Ctrl-C en la terminal: 130 y nada escrito
  out="$(LAB_PTY_DELAY=1.5 harness_lab_pty "$(printf '\003')" node "$LAB_HOME/.tycon/harness/scripts/setup/harness.js" config set github.token 2>&1)"; rc=$?
  [ "$rc" = 130 ] && [ "$(cfg "d.get('github',{}).get('token')")" = None ] && ok "Ctrl-C: sale 130 sin escribir" || mal "Ctrl-C: rc $rc, token «$(cfg "d.get('github',{}).get('token')")»: $out"
  # AC 44 (c): doctor rotula el archivo de la máquina por su ruta REAL. En esta máquina —una versión bajada instalada
  # con Claude Code, sin mudanza— el estado sigue donde siempre y la configuración de la máquina es ~/.claude/tycon.json
  # (tycon-home.js: la máquina «vive en ~/.tycon» sólo con ~/.tycon/state); la mudada dice ~/.tycon/config.json (T28y)
  [ ! -d "$LAB_HOME/.tycon/state" ] && ok "esta máquina (versión bajada con Claude Code, sin mudanza) conserva el estado donde siempre" || mal "esta máquina vive en ~/.tycon/state: el caso de abajo no es el que se quiere medir"
  node "$T/harness/scripts/lib/tycon-config.js" set integrations.engram true >/dev/null 2>&1
  out="$(harness_release doctor 2>&1)"
  case "$out" in *"integraciones: engram (~/.claude/tycon.json)"*) ok "doctor rotula el archivo de la máquina por su ruta real (acá, ~/.claude/tycon.json)" ;; *) mal "el rótulo del archivo (esperado ~/.claude/tycon.json): $(printf '%s\n' "$out" | grep -i integraciones)" ;; esac
  # el doctor de una versión bajada SIN mudar también imprime la línea del perfil de instalación (como el de un clon)
  case "$out" in *"perfil: full ("*) ok "doctor en una versión bajada sin mudar imprime la línea del perfil de instalación" ;; *) mal "sin la línea del perfil: $(printf '%s\n' "$out" | grep -i perfil)" ;; esac
  # una clave NO secreta por la terminal: con eco, como siempre (la persona ve lo que tipea), y guarda
  out="$(LAB_PTY_DELAY=1.5 harness_lab_pty "$LAB_TREE" node "$LAB_HOME/.tycon/harness/scripts/setup/harness.js" config set paths.maintained 2>&1)"; rc=$?
  [ "$rc" = 0 ] && [ "$(cfg "d['paths']['maintained']")" = "$LAB_TREE" ] && ok "paths.maintained pedido en la terminal guarda" || mal "paths.maintained por terminal: rc $rc: $out"
  case "$out" in *"valor para paths.maintained"*"$LAB_TREE"*) ok "…y con eco (la ruta se ve en la terminal, como siempre)" ;; *) mal "sin eco o sin la pregunta: $out" ;; esac
  # el cierre de `install` rotula igual que doctor (misma pieza): sobre la máquina ya instalada, install --dry-run lo muestra
  node "$T/harness/scripts/lib/tycon-config.js" set integrations.engram true >/dev/null 2>&1
  out="$(harness_release install --dry-run 2>&1)"
  case "$out" in *"integraciones: engram (~/.claude/tycon.json)"*) ok "el cierre/plan de install rotula el archivo de la máquina por su ruta real" ;; *) mal "install no rotula el archivo: $(printf '%s\n' "$out" | grep -i integraciones)" ;; esac
  # el canal vigente junto a la versión, y el aviso cuando el estado quedó atrás (AC 44 c): la variable pone latest, el
  # estado sigue diciendo stable
  out="$(TYCON_UPDATE_CHANNEL=latest harness_release doctor 2>&1)"
  case "$out" in *"versión bajada"*"canal latest (el estado todavía dice stable"*) ok "doctor dice el canal vigente (latest) y que el estado todavía dice stable" ;; *) mal "la línea de la versión con el canal cambiado: $(printf '%s\n' "$out" | grep -i 'versión bajada')" ;; esac
  out="$(harness_release doctor 2>&1)"
  case "$out" in *"todavía dice"*) mal "sin divergencia, doctor igual avisa: $(printf '%s\n' "$out" | grep -i 'versión bajada')" ;; *) ok "…y sin divergencia no avisa" ;; esac
  # dos valores sueltos: sobran, y lo dice
  out="$(harness_release config set paths.maintained "$LAB_TREE" otro 2>&1)"; rc=$?
  [ "$rc" = 2 ] && ok "config set con dos valores sale 2" || mal "dos valores: rc $rc: $out"
  case "$out" in *sobran*) ok "…y dice que sobran" ;; *) mal "no dice que sobran: $out" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T47 ────────────────────────────────────────────
# Story 8.23, tanda G · AC 42: en una instalación bajada el paso de terceros del aplicador VERIFICA contra el manifiesto
# del árbol (sin git, sin escribir) en vez de decir «no es un clon de agent-skills … no restituyo nada»: calla si está
# entero; si falta algo, una línea con lo que falta y la acción.
if corre T47; then
  echo "T47 · terceros en una instalación bajada: verifica contra el manifiesto; nombra lo que falta; nunca «no es un clon»"
  harness_lab_create "$BASE/lab47"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  instala latest
  T="$(TYCON_DIR)"
  TP="$RAIZ/scripts/publishing/install-third-party.js"
  mkdir -p "$T/harness/skills/lab-third"; printf '# tercero de laboratorio\n' > "$T/harness/skills/lab-third/SKILL.md"
  TREE_SHA="$(node -e 'const m=require(process.argv[1]); process.stdout.write(m.treeSha(m.diskListing(process.argv[2])))' "$TP" "$T/harness/skills/lab-third")"
  M="$BASE/lab47/manifest.json"
  printf '{ "retirement": "done", "own": [], "derived": [], "third_party": [ { "target": "skills/lab-third", "install": "download", "license": "MIT", "license_source": "LICENSE del origen (laboratorio)", "used_by": [], "why": "laboratorio", "origin": "https://example.invalid/lab-third.git", "commit": "0000000000000000000000000000000000000001", "path": "", "tree": "%s", "omit": [] } ] }\n' "$TREE_SHA" > "$M"
  REPO="$LAB_HOME/.claude/agent-skills"
  [ -L "$REPO" ] && [ ! -e "$REPO/.git" ] && [ -f "$REPO/.tycon-release.json" ] && ok "la máquina: agent-skills es un enlace a un árbol bajado (sin .git, con su manifiesto)" || mal "la máquina no es la de una instalación bajada: $(ls -ld "$REPO" 2>&1)"
  # la carpeta de usuario versionada con git (git init ~): el árbol bajado «parece» un clon; se reconoce por su manifiesto
  # igual, y el paso no escribe (pase adversarial de la tanda G, clase 6)
  git -C "$LAB_HOME" init -q 2>/dev/null && ok "la casa de la máquina se versionó con git (el árbol bajado queda adentro de un repo)" || mal "no pude versionar la casa"
  # el bit de ejecución no cambia el veredicto: la bajada deja ejecutables donde el manifiesto declara 644 y en Windows no viaja
  chmod 755 "$T/harness/skills/lab-third/SKILL.md"
  out="$(node "$TP" --repo "$REPO" --manifest "$M" 2>&1)"; rc=$?
  [ "$rc" = 0 ] && [ -z "$out" ] && ok "con los terceros enteros, el paso calla" || mal "con los terceros enteros: rc $rc: «${out}»"
  out="$(node "$TP" --repo "$REPO" --manifest "$M" --check 2>&1)"
  [ -z "$out" ] && ok "…también con --check" || mal "--check con los terceros enteros: «${out}»"
  rm -rf "$T/harness/skills/lab-third"
  out="$(node "$TP" --repo "$REPO" --manifest "$M" 2>&1)"; rc=$?
  [ "$rc" = 0 ] && [ "$(printf '%s\n' "$out" | grep -c .)" = 1 ] && ok "con una que falta: una sola línea, exit 0" || mal "con una que falta: rc $rc: $out"
  case "$out" in *"lab-third"*"harness.js update"*) ok "…que la nombra y dice la acción (harness.js update)" ;; *) mal "la línea no nombra lo que falta o la acción: $out" ;; esac
  case "$out" in *"no es un clon"*) mal "sigue diciendo «no es un clon»: $out" ;; *) ok "…y no dice «no es un clon»" ;; esac
  [ ! -e "$T/harness/skills/lab-third" ] && ok "…y no escribió nada (la que repone es la bajada), ni con la casa versionada" || mal "el paso escribió en el árbol bajado"
  case "$out" in *"ya está al día, igual vuelve a restituir"*) ok "…y la acción dice que update repone aunque la versión esté al día" ;; *) mal "la acción no dice que update repone al día: $out" ;; esac
  rm -rf "$LAB_HOME/.git"
  # un contenido que no da el árbol declarado también se nombra
  mkdir -p "$T/harness/skills/lab-third"; printf '# otro contenido\n' > "$T/harness/skills/lab-third/SKILL.md"
  out="$(node "$TP" --repo "$REPO" --manifest "$M" --check 2>&1)"
  case "$out" in *"lab-third"*"no da el árbol declarado"*) ok "con un contenido que no da el árbol declarado, lo nombra" ;; *) mal "no nombra el contenido distinto: «${out}»" ;; esac
  # un enlace adentro del destino: no se lee a través de él (escribiría/leería afuera) y se dice
  rm -rf "$T/harness/skills/lab-third"; mkdir -p "$T/harness/skills/lab-third"; ln -s /etc/hosts "$T/harness/skills/lab-third/SKILL.md"
  out="$(node "$TP" --repo "$REPO" --manifest "$M" --check 2>&1)"
  case "$out" in *"lab-third"*"enlace"*) ok "con un enlace adentro del destino, lo nombra como tal" ;; *) mal "no nombra el enlace: «${out}»" ;; esac
  rm -rf "$T/harness/skills/lab-third"
  # AC 44 (a): el reporte de paridad escrito donde la pieza lo pone en una versión bajada (la carpeta del estado) no es
  # «de más» para doctor; el mismo archivo adentro del árbol sí lo era (la primera máquina migrada)
  STATE_DIR="$(node -e 'process.stdout.write(require(process.argv[1]).stateDir())' "$T/harness/scripts/setup/harness/tycon-home.js")"
  mkdir -p "$STATE_DIR/controls-bench"; printf '{ "kind": "harness-parity", "deployed": false, "reds": 0, "surfaces": [] }\n' > "$STATE_DIR/controls-bench/harness-parity.json"
  out="$(harness_release doctor 2>&1)"
  case "$out" in *"harness-parity.json"*"de más"*) mal "el reporte de paridad en la carpeta del estado se cuenta como de más: $(printf '%s\n' "$out" | grep parity)" ;; *) ok "el reporte de paridad en la carpeta del estado no es «de más» para doctor" ;; esac
  mkdir -p "$T/harness/scripts/controls-bench/.bench"; printf '{ "kind": "harness-parity" }\n' > "$T/harness/scripts/controls-bench/.bench/harness-parity.json"
  out="$(harness_release doctor 2>&1)"
  case "$out" in *"harness-parity.json: de más"*) ok "…y el mismo archivo adentro del árbol sí (lo que pasaba antes de la G)" ;; *) mal "el reporte adentro del árbol no se cuenta como de más: $(printf '%s\n' "$out" | grep parity)" ;; esac
  rm -rf "$T/harness/scripts/controls-bench"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ═══ HP · la versión bajada: la carpeta global de hooks de git llega sola (2026-10-14) ═══════════════════════════════════
# El caso: máquinas del equipo ya instaladas (versión bajada, o mudadas) con los hooks del arnés en ~/.git-hooks y git sin
# carpeta global de hooks: el freno antes de publicar no corría, y sólo `install`, `apply` y la mudanza la ponían. El
# dueño pidió que llegue sola. El aplicador de juguete no deja el pre-push del arnés: se pone a mano, como lo deja el real.
if corre HP; then
  echo "HP · la versión bajada: el arranque (auto) y update --yes ponen la carpeta global de hooks de git"
  harness_lab_create "${BASE}/labhp"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  harness_lab_release_fresh_home
  HPCFG="${LAB}/hp-gitconfig"; : > "${HPCFG}"
  hpv() { GIT_CONFIG_GLOBAL="${HPCFG}" git config --global --get core.hooksPath; }
  hpn() { estado "d.get('notice') or ''"; }
  hpforget() { python3 -c 'import json,sys; f=sys.argv[1]; d=json.load(open(f)); d.pop("git_hooks_path", None); json.dump(d, open(f, "w"), indent=2)' "$(ESTADO)"; }
  out="$(GIT_CONFIG_GLOBAL="${HPCFG}" harness install --version latest --yes 2>&1)"; rc=$?
  [ "${rc}" = 0 ] && [ -z "$(hpv)" ] && ok "sin el pre-push del arnés en su lugar, install no la pone" || mal "install (rc ${rc}, core.hooksPath=«$(hpv)»): ${out}"
  mkdir -p "${TYCON_GIT_HOOKS_DIR}" && printf '#!/usr/bin/env bash\n# git-pre-push-global.sh (laboratorio)\nexit 0\n' > "${TYCON_GIT_HOOKS_DIR}/pre-push" && chmod +x "${TYCON_GIT_HOOKS_DIR}/pre-push"
  # ask: el arranque no la pone y el aviso la pide
  GIT_CONFIG_GLOBAL="${HPCFG}" TYCON_UPDATE_APPLY=ask harness_release startup --force >/dev/null 2>&1
  [ -z "$(hpv)" ] && case "$(hpn)" in *"falta la carpeta global de hooks de git"*"update --yes la pone"*) true ;; *) false ;; esac \
    && ok "con ask, el arranque no la pone y el aviso la pide" || mal "ask: core.hooksPath=«$(hpv)» aviso=«$(hpn)»"
  # auto (la del perfil del equipo): la pone el arranque, la anota y lo dice una vez
  GIT_CONFIG_GLOBAL="${HPCFG}" TYCON_UPDATE_APPLY=auto harness_release startup --force >/dev/null 2>&1
  [ "$(hpv)" = "${TYCON_GIT_HOOKS_DIR}" ] && case "$(hpn)" in *"el arnés puso la carpeta global de hooks de git"*) true ;; *) false ;; esac \
    && [ "$(estado "(d.get('git_hooks_path') or {}).get('value')")" = "${TYCON_GIT_HOOKS_DIR}" ] \
    && ok "con auto, el arranque la pone, la anota y lo dice en el aviso" || mal "auto: core.hooksPath=«$(hpv)» aviso=«$(hpn)»"
  GIT_CONFIG_GLOBAL="${HPCFG}" TYCON_UPDATE_APPLY=auto harness_release startup --force >/dev/null 2>&1
  case "$(hpn)" in *"carpeta global de hooks"*) mal "el arranque siguiente lo repite: «$(hpn)»" ;; *) ok "…y el arranque siguiente ya no lo dice" ;; esac
  # la persona la sacó: el arranque no la vuelve a poner
  GIT_CONFIG_GLOBAL="${HPCFG}" git config --global --unset core.hooksPath
  GIT_CONFIG_GLOBAL="${HPCFG}" TYCON_UPDATE_APPLY=auto harness_release startup --force >/dev/null 2>&1
  [ -z "$(hpv)" ] && ok "si la persona la sacó, el arranque no la vuelve a poner" || mal "el arranque volvió a ponerla: «$(hpv)»"
  # update que aplica (acá con auto: sin terminal, --yes exige auto) la pone en una máquina que el arnés nunca la puso
  hpforget
  out="$(GIT_CONFIG_GLOBAL="${HPCFG}" TYCON_UPDATE_APPLY=auto harness_release update --yes 2>&1)"; rc=$?
  [ "$(hpv)" = "${TYCON_GIT_HOOKS_DIR}" ] && case "${out}" in *"git usa ahora la carpeta global de hooks del arnés"*) true ;; *) false ;; esac \
    && ok "update --yes la pone y lo dice" || mal "update --yes (rc ${rc}, core.hooksPath=«$(hpv)»): ${out}"
  kill "${LAB_RELEASE_PROCESS}" 2>/dev/null
fi

if [ "$FALLOS" = 0 ]; then echo "harness-release: todo verde"; else echo "❌ harness-release: $FALLOS fallo(s)"; exit 1; fi
