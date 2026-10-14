#!/usr/bin/env bash
# get-harness.test.sh — el guion de entrada de la portada (`get-harness.sh`), por EJECUCIÓN: la portada SIN git
# (story 8.23, tanda E · AC 33 · la parte local de T34; reescribe T54, T55 y T57 de la 8.16 y suma T56).
#
# Lo que no se puede perder:
#   · T54 — el guion tiene 120 líneas como mucho, `bash -n` limpio, el piso de Node de `harness.js` (`NODE_FLOOR`), la
#     dirección de fábrica de la portada (`REPO="<org>/<nombre>"`), y NO invoca git ni lo pide (ni `--depth`: ya no hay
#     clon). `--help` sale 0 sin tocar la red ni la HOME.
#   · T55 — un requisito que falta (`node`, `tar`, `python3`, o un `node` viejo) sale 1 con una línea por cada uno y un
#     comando SUGERIDO según el sistema; nadie llama a un gestor de paquetes; no se baja nada y la HOME queda igual.
#   · T56 — el permiso ANTES de bajar (AC 11): con el repo público instala sin pedir nada; con el repo privado y sin
#     permiso, sin terminal sale 1 con UNA acción (el enlace para crearlo, y cómo pegarlo) sin escribir nada; con
#     `TYCON_GITHUB_TOKEN` lo guarda (0600) e instala; en una terminal lo pide sin eco y sigue; con uno guardado no
#     pregunta; uno que no vale sale 1 diciéndolo. La bajada: el comprimido por la API, la redirección a «codeload» SIN
#     la credencial, el árbol temporal se borra, `install --version latest --repo <org/nombre>` corre desde ahí (la bajada
#     verificada y la instalación son las de la tanda B: estado `release`, `~/.tycon/harness`), la entrada estándar sigue
#     siendo la terminal (la pregunta «¿Instalo?» llega), git NUNCA se invoca y el valor del permiso no aparece en nada
#     de lo escrito salvo `~/.tycon/config.json`.
#   · T57 — cada línea de bash del bloque `install:script` de la portada pasa el freno de comandos; la tubería hacia un
#     shell sale bloqueada con `SUP-C1`.
#
# Cómo mide, sin red y sin tocar la máquina: la HOME de juguete de `harness_lab_create`, el «GitHub» de juguete de
# `harness_lab_release_server` (`TYCON_RELEASE_API`, la misma variable de prueba que usa release.js) con un nombre
# inventado (`example-org/example-harness`), y un `git` testigo en el PATH. Sin python3 (la terminal de juguete), git
# (lo usa el servidor de juguete, no el guion), node o tar: UNA línea «NO MEDIDO» y exit 2.
# Correr: bash scripts/tests/get-harness.test.sh   (~30 s)

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$RAIZ/scripts/publishing/public-files/scripts/setup/get-harness.sh"
README_EN="$RAIZ/scripts/publishing/public-files/getting-started/reference.md"
COPY=0
if [ ! -f "$SRC" ] && [ -f "$RAIZ/scripts/setup/get-harness.sh" ]; then
  COPY=1; SRC="$RAIZ/scripts/setup/get-harness.sh"; README_EN="$RAIZ/getting-started/reference.md"
fi
GUARD_HOOK="$RAIZ/scripts/hooks/safety-guard-pre.sh"

for tool in python3 git node tar; do
  command -v "$tool" >/dev/null 2>&1 || { echo "⏭ get-harness: NO MEDIDO — no hay ${tool} en esta máquina"; exit 2; }
done
[ -f "$SRC" ] || { echo "❌ get-harness: no existe ${SRC#"$RAIZ"/}"; exit 1; }
[ -f "$README_EN" ] || { echo "❌ get-harness: no existe ${README_EN#"$RAIZ"/} (la referencia, con los bloques de instalación)"; exit 1; }

FAILURES=0; TOTAL=0
ok() { TOTAL=$((TOTAL+1)); echo "✅ get-harness: $1"; }
no() { TOTAL=$((TOTAL+1)); FAILURES=$((FAILURES+1)); echo "❌ get-harness: $1"; }
brief() { tail -3 "$1" 2>/dev/null | tr '\n' ' ' | cut -c1-"${2:-260}"; }

BASE="$(mktemp -d /tmp/get-harness.XXXXXX)" && BASE="$(cd "$BASE" && pwd -P)" || { echo "❌ get-harness: no pude crear la carpeta temporal"; exit 1; }
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$BASE"' EXIT
# shellcheck source=lib/harness-lab.sh
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
harness_lab_create "$BASE/lab" || { echo "❌ get-harness: no pude armar el laboratorio"; exit 1; }
REAL_BASH="$(command -v bash)"; REAL_NODE="$(command -v node)"
ORG=example-org; NAME=example-harness
harness_lab_release_server "$ORG" "$NAME" || { echo "❌ get-harness: el servidor de versiones de juguete no arrancó"; exit 1; }
harness_lab_publish_stable 2026.10.08.1 || { echo "❌ get-harness: no pude publicar la versión de juguete"; exit 1; }
harness_lab_git_witness
export TYCON_UPDATE_APPLY=auto
unset TYCON_GITHUB_TOKEN

# ── el guion, con los marcadores puestos como los pone el exportador ─────────────────────────────────────────
GH="$LAB/get-harness.sh"
if [ "$COPY" = 0 ]; then
  sed -e "s/{{public-org}}/$ORG/g" -e "s/{{public-repo}}/$NAME/g" "$SRC" > "$GH"
else
  # en la copia el nombre real sale de public-remotes.json; se cambia por el inventado
  PUB="$(node -e 'const r=require(process.argv[1]).remotes[0];console.log(r.replace(/^https:\/\/github\.com\//,""))' "$RAIZ/scripts/setup/public-remotes.json" 2>/dev/null)"
  [ -n "$PUB" ] || { echo "❌ get-harness: la copia no trae scripts/setup/public-remotes.json con el remoto público"; exit 1; }
  sed -e "s#^REPO=\"${PUB//./\\.}\"\$#REPO=\"$ORG/$NAME\"#" "$SRC" > "$GH"
fi
grep -qxF "REPO=\"$ORG/$NAME\"" "$GH" || { echo "❌ get-harness: no pude ponerle al guion el nombre inventado (¿cambió la forma de su línea REPO=?)"; exit 1; }

# run_gh <opciones del guion…> — el guion contra el servidor de juguete, sin terminal
# (TYCON_THIRD_PARTY=0: las skills de terceros no se bajan en el laboratorio — no hay de dónde — y no son de esta prueba)
run_gh() { env -u TYCON_GITHUB_TOKEN TYCON_RELEASE_API="$LAB_RELEASE_API" TYCON_THIRD_PARTY=0 bash "$GH" "$@" < /dev/null; }
# run_gh_tty <respuesta> <opciones…> — en una terminal de juguete, con una respuesta tipeada a los 4 s (cuando el guion
# ya está leyendo sin eco; tipeada al instante, la terminal la mostraría ANTES de que nadie la lea, como a cualquiera)
run_gh_tty() { local a="$1"; shift; LAB_PTY_DELAY=4 harness_lab_pty "$a" env -u TYCON_GITHUB_TOKEN TYCON_RELEASE_API="$LAB_RELEASE_API" TYCON_THIRD_PARTY=0 bash "$GH" "$@"; }
TYCON_DIR() { printf '%s' "$LAB_HOME/.tycon"; }
estado_kind() { node -e 'try{const s=require(process.argv[1]);console.log(s.sources[0].kind)}catch{console.log("sin-estado")}' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json" 2>/dev/null; }
requests() { grep -c -- "$1" "$LAB_RELEASE_LOG" 2>/dev/null || true; }
log_lines() { wc -l < "$LAB_RELEASE_LOG" | tr -d ' '; }
tmp_left() { ls -d "$LAB_TMP"/get-harness* 2>/dev/null | wc -l | tr -d ' '; }
installed_ok() { [ "$(estado_kind)" = release ] && [ -f "$(TYCON_DIR)/harness/version.json" ] && [ -f "$(TYCON_DIR)/harness/scripts/setup/harness.js" ]; }
FLOOR_HARNESS="$(sed -n 's/^const NODE_FLOOR = \([0-9][0-9]*\);.*/\1/p' "$RAIZ/scripts/setup/harness.js")"

# ══ T54 · lo estático ═══════════════════════════════════════════════════════════════════════════
LINES="$(wc -l < "$SRC" | tr -d ' ')"
if [ "$LINES" -le 120 ]; then ok "T54 el guion tiene ${LINES} líneas (tope 120: se lee entero)"; else no "T54 el guion tiene ${LINES} líneas (tope 120)"; fi
if bash -n "$SRC" 2> "$BASE/syntax.err"; then ok "T54 bash -n limpio"; else no "T54 bash -n: $(brief "$BASE/syntax.err")"; fi
FLOOR_SCRIPT="$(sed -n 's/^NODE_FLOOR=\([0-9][0-9]*\).*/\1/p' "$SRC")"
if [ -n "$FLOOR_HARNESS" ] && [ "$FLOOR_SCRIPT" = "$FLOOR_HARNESS" ]; then ok "T54 el piso de Node del guion (${FLOOR_SCRIPT}) es el de harness.js (NODE_FLOOR)"
else no "T54 el piso de Node del guion es «${FLOOR_SCRIPT}» y el de harness.js «${FLOOR_HARNESS}»"; fi
# (la ruta `/git/ref/heads/<rama>` de la API de GitHub no es una invocación de git: se descuenta antes de mirar)
if ! grep -vE '^\s*#' "$SRC" | sed 's#/git/##g' | grep -wE 'git|--depth' >/dev/null; then ok "T54 el guion no invoca git ni lo pide (sin clon: la versión se baja como archivos)"
else no "T54 el guion todavía nombra git fuera de los comentarios: $(grep -vE '^\s*#' "$SRC" | sed 's#/git/##g' | grep -nwE 'git|--depth' | head -3 | tr '\n' ' ')"; fi
if [ "$COPY" = 0 ]; then
  if grep -qxF 'REPO="{{public-org}}/{{public-repo}}"' "$SRC"; then ok "T54 la dirección de fábrica del guion son los marcadores de la portada (REPO=\"{{public-org}}/{{public-repo}}\")"
  else no "T54 la línea REPO= del guion no trae los marcadores: $(grep -E '^REPO=' "$SRC" | tr '\n' ' ')"; fi
else
  if grep -qxF "REPO=\"$PUB\"" "$SRC" && ! grep -q '{{public-' "$SRC" "$README_EN"; then ok "T54 (copia) la dirección de fábrica del guion es la de public-remotes.json (${PUB}) y no queda ningún marcador"
  else no "T54 (copia) la dirección de fábrica no es la del remoto público (${PUB}): $(grep -E '^REPO=' "$SRC" | tr '\n' ' ')"; fi
fi
N0="$(log_lines)"; H0="$(harness_lab_home_hash)"
run_gh --help > "$BASE/help.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && grep -q 'uso: bash get-harness.sh' "$BASE/help.out" && grep -qF 'sin terminal (instalación desatendida): agregá `-- --profile minimal --yes`' "$BASE/help.out" \
   && [ "$(log_lines)" = "$N0" ] && [ "$(harness_lab_home_hash)" = "$H0" ]; then
  ok "T54 --help: el uso y la línea de la instalación desatendida, sale 0 sin tocar la red ni la HOME"
else no "T54 --help (rc $RC; pedidos $((($(log_lines)) - N0))): $(brief "$BASE/help.out")"; fi

# ══ T55 · lo que falta: una línea por cada uno, un comando sugerido, nadie lo corre, nada bajado ════════════════
PKG_CALLS="$LAB/package-manager-calls.log"
make_path() { # make_path <carpeta> <herramienta…> — un PATH de mentira con esas herramientas reales y los gestores de paquetes de mentira
  local dir="$1" t real; shift; mkdir -p "$dir"
  for t in "$@"; do real="$(command -v "$t")" && ln -sf "$real" "$dir/$t"; done
  for t in brew apt apt-get sudo winget; do printf '#!/bin/sh\necho "%s $*" >> "%s"\nexit 0\n' "$t" "$PKG_CALLS" > "$dir/$t"; chmod +x "$dir/$t"; done
}
BASICS=(bash uname rm mktemp tr env ls curl grep head printf)
case "$(uname -s)" in
  Darwin) WANT_NODE='brew install node'; WANT_TAR='brew install' ;;
  Linux) if [ -r /etc/os-release ] && grep -qiE '^(ID|ID_LIKE)=.*(debian|ubuntu)' /etc/os-release; then WANT_NODE='apt install nodejs'; WANT_TAR='apt install'; else WANT_NODE='https://nodejs.org'; WANT_TAR='tar'; fi ;;
  *) WANT_NODE='https://nodejs.org'; WANT_TAR='tar' ;;
esac
t55() { # t55 <nombre> <PATH> <patrón esperado> <descripción>
  local name="$1" p="$2" want="$3" what="$4" rc n0 h0
  n0="$(log_lines)"; h0="$(harness_lab_home_hash)"
  env -u TYCON_GITHUB_TOKEN PATH="$p" TYCON_RELEASE_API="$LAB_RELEASE_API" "$REAL_BASH" "$GH" -- --yes < /dev/null > "$BASE/t55-$name.out" 2>&1; rc=$?
  if [ "$rc" -eq 1 ] && grep -qE "$want" "$BASE/t55-$name.out" && [ "$(log_lines)" = "$n0" ] && [ "$(harness_lab_home_hash)" = "$h0" ] && [ ! -e "$PKG_CALLS" ] && [ "$(tmp_left)" = 0 ]; then
    ok "T55 $what: sale 1 nombrándolo con su sugerencia, sin bajar nada, sin gestores de paquetes y con la HOME igual"
  else no "T55 $what (rc $rc, pedidos $((($(log_lines)) - n0)), gestores: $(cat "$PKG_CALLS" 2>/dev/null | tr '\n' ' ')): $(brief "$BASE/t55-$name.out" 400)"; fi
}
make_path "$LAB/path-nonode" tar python3 "${BASICS[@]}";        t55 nonode "$LAB/path-nonode" "falta node.*$WANT_NODE" "sin node"
make_path "$LAB/path-notar" node python3 "${BASICS[@]}";        t55 notar "$LAB/path-notar" "falta tar.*$WANT_TAR" "sin tar"
make_path "$LAB/path-nopy" node tar "${BASICS[@]}";             t55 nopy "$LAB/path-nopy" "falta python3" "sin python3"
make_path "$LAB/path-nocurl" node tar python3 bash uname rm mktemp tr env ls grep head printf; t55 nocurl "$LAB/path-nocurl" "falta curl" "sin curl (baja por la API con él)"
# con `-- --tool codex` (sólo Codex) python3 no hace falta: el guion pasa los requisitos y llega a bajar (pase adversarial, clase 17)
: > "$LAB_RELEASE_LOG"
env -u TYCON_GITHUB_TOKEN PATH="$LAB/path-nopy" TYCON_RELEASE_API="$LAB_RELEASE_API" TYCON_THIRD_PARTY=0 "$REAL_BASH" "$GH" -- --tool codex --yes < /dev/null > "$BASE/t55-codex.out" 2>&1; RC=$?
if ! grep -q 'falta python3' "$BASE/t55-codex.out" && [ "$(requests '/tarball/')" -ge 1 ]; then ok "T55 con -- --tool codex y sin python3: python3 no es requisito (lo pide el aplicador de Claude Code) y el guion llega a bajar"
else no "T55 con -- --tool codex sin python3 (rc $RC, tarball $(requests '/tarball/')): $(brief "$BASE/t55-codex.out" 300)"; fi
make_path "$LAB/path-nonode-nopy" tar "${BASICS[@]}"
env -u TYCON_GITHUB_TOKEN PATH="$LAB/path-nonode-nopy" TYCON_RELEASE_API="$LAB_RELEASE_API" "$REAL_BASH" "$GH" -- --yes < /dev/null > "$BASE/t55-two.out" 2>&1; RC=$?
if [ "$RC" -eq 1 ] && [ "$(grep -c 'falta node' "$BASE/t55-two.out")" = 1 ] && [ "$(grep -c 'falta python3' "$BASE/t55-two.out")" = 1 ]; then ok "T55 sin node ni python3: una línea por cada uno"
else no "T55 sin node ni python3 (rc $RC): $(brief "$BASE/t55-two.out" 400)"; fi
if ! grep -q 'falta git' "$BASE/t55-two.out" "$BASE/t55-nonode.out"; then ok "T55 git no está entre los requisitos"; else no "T55 el guion pide git"; fi
harness_lab_fake_node 18.0.0
make_path "$LAB/path-oldnode" tar python3 "${BASICS[@]}"; ln -sf "$LAB_BIN/node" "$LAB/path-oldnode/node"
t55 oldnode "$LAB/path-oldnode" "18\.0\.0.*${FLOOR_HARNESS}" "con node 18 (nombra la que hay y la que pide)"
rm -f "$LAB_BIN/node" "$LAB_BIN/node-version.js"   # el node de mentira no queda en el PATH del laboratorio para lo que sigue
# la sugerencia sale del sistema: un uname que dice Darwin, uno que dice otra cosa
mkdir -p "$LAB/uname-darwin" "$LAB/uname-other"
printf '#!/bin/sh\necho Darwin\n' > "$LAB/uname-darwin/uname"; printf '#!/bin/sh\necho Plan9\n' > "$LAB/uname-other/uname"; chmod +x "$LAB/uname-darwin/uname" "$LAB/uname-other/uname"
env -u TYCON_GITHUB_TOKEN PATH="$LAB/uname-darwin:$LAB/path-nonode" "$REAL_BASH" "$GH" < /dev/null > "$BASE/t55b.out" 2>&1; RC_D=$?
env -u TYCON_GITHUB_TOKEN PATH="$LAB/uname-other:$LAB/path-nonode" "$REAL_BASH" "$GH" < /dev/null > "$BASE/t55c.out" 2>&1; RC_O=$?
if [ "$RC_D" -eq 1 ] && grep 'falta node' "$BASE/t55b.out" | grep -F 'brew install node' >/dev/null && [ "$RC_O" -eq 1 ] && grep 'falta node' "$BASE/t55c.out" | grep -F 'https://nodejs.org' >/dev/null && [ ! -e "$PKG_CALLS" ]; then
  ok "T55 la sugerencia sale del sistema: Homebrew en una Mac, la página oficial en un sistema que no es Mac ni Debian/Ubuntu (y ninguna se corre)"
else no "T55 la sugerencia por sistema (Mac rc $RC_D: $(grep 'falta node' "$BASE/t55b.out" | head -1) · otro rc $RC_O: $(grep 'falta node' "$BASE/t55c.out" | head -1))"; fi

# ══ T56 · el permiso antes de bajar, la bajada y la instalación ═════════════════════════════════════════════
LAB_PERMIT="permiso-de-laboratorio-$(date +%s)"   # no es un secreto
permit_sha() { printf '%s' "$1" | shasum -a 256 | cut -c1-64; }
# (a) repo PÚBLICO, sin permiso, en una terminal de juguete sin --yes: no pide nada, la pregunta de install llega, instala
harness_lab_release_control '{ "auth": "none" }'
harness_lab_release_fresh_home; : > "$LAB_RELEASE_LOG"
run_gh_tty s > "$BASE/t56a.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && installed_ok && grep -q '¿Instalo? \[s/N\]' "$BASE/t56a.out" && ! grep -q 'pegá el permiso' "$BASE/t56a.out"; then
  ok "T56 repo público, sin permiso, en una terminal: no pide nada, la pregunta «¿Instalo?» llega y la respuesta también; queda instalado (estado release, ~/.tycon/harness)"
else no "T56 repo público en terminal (rc $RC, estado $(estado_kind)): $(brief "$BASE/t56a.out" 400)"; fi
if [ "$(requests '/tarball/')" -ge 1 ] && [ "$(grep -c '"host":"codeload"' "$LAB_RELEASE_LOG")" -ge 2 ] && [ "$(grep -c '"host":"codeload".*"auth":true' "$LAB_RELEASE_LOG")" = 0 ]; then
  ok "T56 el comprimido se pide por la API (tarball → codeload), dos veces (la del guion y la verificada de install), y a codeload nunca viaja una credencial"
else no "T56 la bajada: tarball $(requests '/tarball/') · codeload $(grep -c '"host":"codeload"' "$LAB_RELEASE_LOG") · con credencial $(grep -c '"host":"codeload".*"auth":true' "$LAB_RELEASE_LOG")"; fi
if [ ! -s "$LAB_GIT_WITNESS_LOG" ]; then ok "T56 git no se invocó ni una vez (ni el guion ni install)"; else no "T56 git se invocó: $(head -3 "$LAB_GIT_WITNESS_LOG" | tr '\n' ' ')"; fi
if [ "$(tmp_left)" = 0 ]; then ok "T56 el árbol temporal del guion se borró"; else no "T56 quedaron $(tmp_left) carpeta(s) temporal(es) del guion en $LAB_TMP"; fi
[ "$(node -e 'console.log(require(process.argv[1]).version)' "$(TYCON_DIR)/harness/version.json" 2>/dev/null)" = 2026.10.08.1 ] && ok "T56 la versión instalada es la publicada (2026.10.08.1)" || no "T56 la versión instalada no es 2026.10.08.1: $(cat "$(TYCON_DIR)/harness/version.json" 2>/dev/null | tr '\n' ' ')"
# (a2) con --yes y opciones de install: llegan tal cual (sin pregunta)
harness_lab_release_fresh_home
run_gh -- --profile minimal --yes > "$BASE/t56a2.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && installed_ok && ! grep -q '¿Instalo?' "$BASE/t56a2.out"; then ok "T56 sin terminal con -- --profile minimal --yes: las opciones llegan a install y no hay pregunta"
else no "T56 con -- --profile minimal --yes (rc $RC): $(brief "$BASE/t56a2.out" 400)"; fi
# (b) repo PRIVADO, sin permiso, sin terminal: sale 1 con UNA acción, nada escrito, nada bajado
harness_lab_release_control "{ \"auth\": \"token:$LAB_PERMIT\" }"
harness_lab_release_fresh_home; : > "$LAB_RELEASE_LOG"
H0="$(harness_lab_home_hash)"
run_gh -- --yes > "$BASE/t56b.out" 2>&1; RC=$?
if [ "$RC" -eq 1 ] && grep -q 'github.com/settings/' "$BASE/t56b.out" && grep -q 'TYCON_GITHUB_TOKEN' "$BASE/t56b.out" && [ "$(harness_lab_home_hash)" = "$H0" ] \
   && [ "$(requests '/tarball/')" = 0 ] && [ ! -d "$(TYCON_DIR)" ] && [ "$(tmp_left)" = 0 ]; then
  ok "T56 repo privado, sin permiso y sin terminal: sale 1 con la única acción (crear el permiso —con el enlace— y pasarlo), no baja nada y la HOME queda igual"
else no "T56 privado sin permiso (rc $RC, tarball $(requests '/tarball/'), ~/.tycon $([ -d "$(TYCON_DIR)" ] && echo creada || echo no)): $(brief "$BASE/t56b.out" 400)"; fi
# (c) con TYCON_GITHUB_TOKEN y sin terminal: lo guarda (0600) e instala; el valor no queda en nada más
harness_lab_release_fresh_home; : > "$LAB_RELEASE_LOG"
env TYCON_GITHUB_TOKEN="$LAB_PERMIT" TYCON_RELEASE_API="$LAB_RELEASE_API" TYCON_THIRD_PARTY=0 bash "$GH" -- --yes < /dev/null > "$BASE/t56c.out" 2>&1; RC=$?
PERM="$(python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777)[2:])' "$(TYCON_DIR)/config.json" 2>/dev/null)"
if [ "$RC" -eq 0 ] && installed_ok && [ "$PERM" = 600 ] && grep -qF "$LAB_PERMIT" "$(TYCON_DIR)/config.json"; then
  ok "T56 con TYCON_GITHUB_TOKEN: instala y el permiso queda guardado en ~/.tycon/config.json con 0600 (la próxima vez no hace falta)"
else no "T56 con TYCON_GITHUB_TOKEN (rc $RC, config.json $PERM): $(brief "$BASE/t56c.out" 400)"; fi
if [ "$(requests "\"auth_sha256\":\"$(permit_sha "$LAB_PERMIT")\"")" -ge 2 ] && [ "$(grep -c '"host":"codeload".*"auth":true' "$LAB_RELEASE_LOG")" = 0 ]; then
  ok "T56 los pedidos a la API llevan el permiso y los de codeload no"
else no "T56 el permiso en los pedidos: API $(requests "\"auth_sha256\":\"$(permit_sha "$LAB_PERMIT")\"") · codeload con credencial $(grep -c '"host":"codeload".*"auth":true' "$LAB_RELEASE_LOG")"; fi
LEAKS="$(grep -rlF "$LAB_PERMIT" "$LAB_HOME" "$BASE/t56c.out" "$LAB_RELEASE_LOG" 2>/dev/null | grep -v '/.tycon/config.json$' || true)"
if [ -z "$LEAKS" ]; then ok "T56 el valor del permiso no aparece en nada de lo escrito (HOME, salida, registro del servidor) salvo config.json"
else no "T56 el valor del permiso quedó escrito en: $(echo "$LEAKS" | tr '\n' ' ')"; fi
# (d) en una terminal, sin permiso: lo pide sin eco y sigue
harness_lab_release_fresh_home
run_gh_tty "$LAB_PERMIT" -- --yes > "$BASE/t56d.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && installed_ok && grep -q 'pegá el permiso' "$BASE/t56d.out" && ! grep -qF "$LAB_PERMIT" "$BASE/t56d.out"; then
  ok "T56 en una terminal sin permiso: lo pide (sin eco: el valor no sale en pantalla), lo guarda e instala"
else no "T56 pedido por terminal (rc $RC, estado $(estado_kind), eco: $(grep -cF "$LAB_PERMIT" "$BASE/t56d.out")): $(brief "$BASE/t56d.out" 400)"; fi
# (e) con el permiso ya guardado y sin terminal: no pregunta, instala
harness_lab_release_fresh_home
printf '%s' "$LAB_PERMIT" | harness config set github.token >/dev/null 2>&1
run_gh -- --yes > "$BASE/t56e.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && installed_ok && ! grep -q 'pegá el permiso\|TYCON_GITHUB_TOKEN' "$BASE/t56e.out"; then ok "T56 con el permiso ya guardado: no pregunta ni pide la variable, instala"
else no "T56 con permiso guardado (rc $RC): $(brief "$BASE/t56e.out" 400)"; fi
# (f) un permiso que no vale: sale 1 diciéndolo, sin bajar el comprimido
harness_lab_release_fresh_home; : > "$LAB_RELEASE_LOG"
BAD_PERMIT="otro-permiso-de-laboratorio-que-no-vale"   # tampoco es un secreto (el detector de la copia pública toma por uno a un literal al lado de TOKEN)
env TYCON_GITHUB_TOKEN="$BAD_PERMIT" TYCON_RELEASE_API="$LAB_RELEASE_API" TYCON_THIRD_PARTY=0 bash "$GH" -- --yes < /dev/null > "$BASE/t56f.out" 2>&1; RC=$?
if [ "$RC" -eq 1 ] && grep -qiE 'no vale|venci|401' "$BASE/t56f.out" && [ "$(requests '/tarball/')" = 0 ] && [ "$(tmp_left)" = 0 ]; then
  ok "T56 un permiso que no vale: sale 1 diciéndolo (venció o se revocó) y no baja nada"
else no "T56 permiso que no vale (rc $RC, tarball $(requests '/tarball/')): $(brief "$BASE/t56f.out" 400)"; fi
# (g) detrás de un proxy (HTTP_PROXY): la bajada del guion pasa por él, como la de install (pase adversarial, clase 1)
harness_lab_release_control '{ "auth": "none" }'
harness_lab_release_fresh_home; : > "$LAB_RELEASE_LOG"
env -u TYCON_GITHUB_TOKEN HTTP_PROXY="$LAB_RELEASE_PROXY" HTTPS_PROXY="$LAB_RELEASE_PROXY" TYCON_RELEASE_API="$LAB_RELEASE_API" TYCON_THIRD_PARTY=0 bash "$GH" -- --yes < /dev/null > "$BASE/t56g.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && installed_ok && [ "$(requests '"via_proxy":true')" -ge 2 ]; then ok "T56 con HTTP_PROXY: la bajada del guion y la de install pasan por el proxy ($(requests '"via_proxy":true') pedidos) e instala"
else no "T56 con HTTP_PROXY (rc $RC, por proxy $(requests '"via_proxy":true')): $(brief "$BASE/t56g.out" 300)"; fi
# (h) un permiso con un salto de línea final (un archivo CRLF): se limpia antes de usarlo, no rompe la cabecera (clase 12)
harness_lab_release_control "{ \"auth\": \"token:$LAB_PERMIT\" }"
harness_lab_release_fresh_home; : > "$LAB_RELEASE_LOG"
env TYCON_GITHUB_TOKEN="$LAB_PERMIT"$'\r\n' TYCON_RELEASE_API="$LAB_RELEASE_API" TYCON_THIRD_PARTY=0 bash "$GH" -- --yes < /dev/null > "$BASE/t56h.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && installed_ok && ! grep -q 'caracteres que no valen' "$BASE/t56h.out"; then ok "T56 un permiso con CR/LF al final (pegado de un archivo CRLF): se limpia e instala"
else no "T56 permiso con CRLF (rc $RC): $(brief "$BASE/t56h.out" 300)"; fi
# (i) una redirección a un esquema que no es http(s) —un servidor hostil que manda a file://— no se sigue: sale 1 diciéndolo
# y sin bajar nada; una TYCON_RELEASE_API que no es http(s) sale 2 antes de tocar la red (vuelta 2 de revisores, seguridad)
node -e 'const s=require("http").createServer((q,r)=>{r.writeHead(302,{Location:"file:///etc/passwd"});r.end()});s.listen(0,"127.0.0.1",()=>require("fs").writeFileSync(process.argv[1],String(s.address().port)))' "$BASE/redir.port" & REDIR_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do [ -s "$BASE/redir.port" ] && break; sleep 0.2; done
harness_lab_release_fresh_home
env -u TYCON_GITHUB_TOKEN TYCON_RELEASE_API="http://127.0.0.1:$(cat "$BASE/redir.port")" TYCON_THIRD_PARTY=0 bash "$GH" -- --yes < /dev/null > "$BASE/t56i.out" 2>&1; RC=$?
kill "$REDIR_PID" 2>/dev/null; wait "$REDIR_PID" 2>/dev/null
if [ "$RC" -eq 1 ] && grep -q 'esquema que no es http' "$BASE/t56i.out" && ! grep -q 'GitHub contestó' "$BASE/t56i.out" && ! installed_ok && [ "$(tmp_left)" = 0 ]; then ok "T56 una redirección a file:// no se sigue: sale 1 diciéndolo (una sola vez: sin el genérico «GitHub contestó»), sin bajar ni instalar nada"
else no "T56 redirección a file:// (rc $RC, estado $(estado_kind)): $(brief "$BASE/t56i.out" 300)"; fi
# (i2) la misma redirección hostil pero en la BAJADA del comprimido (la rama main se resolvió bien): el motivo se dice una vez
# y el genérico «no pude bajar el comprimido (GitHub contestó …)» se calla (vuelta 5 de revisores)
node -e 'const s=require("http").createServer((q,r)=>{if(/\/git\/ref\//.test(q.url)){r.writeHead(200,{"Content-Type":"application/json"});r.end(JSON.stringify({object:{sha:"0123456789abcdef0123456789abcdef01234567"}}));return}r.writeHead(302,{Location:"file:///etc/passwd"});r.end()});s.listen(0,"127.0.0.1",()=>require("fs").writeFileSync(process.argv[1],String(s.address().port)))' "$BASE/redir2.port" & REDIR_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do [ -s "$BASE/redir2.port" ] && break; sleep 0.2; done
harness_lab_release_fresh_home
env -u TYCON_GITHUB_TOKEN TYCON_RELEASE_API="http://127.0.0.1:$(cat "$BASE/redir2.port")" TYCON_THIRD_PARTY=0 bash "$GH" -- --yes < /dev/null > "$BASE/t56i2.out" 2>&1; RC=$?
kill "$REDIR_PID" 2>/dev/null; wait "$REDIR_PID" 2>/dev/null
if [ "$RC" -eq 1 ] && grep -q 'bajo .* a una carpeta temporal' "$BASE/t56i2.out" && grep -q 'esquema que no es http' "$BASE/t56i2.out" && ! grep -q 'GitHub contestó' "$BASE/t56i2.out" && ! installed_ok && [ "$(tmp_left)" = 0 ]; then ok "T56 una redirección a file:// en la bajada del comprimido (con main ya resuelta): sale 1 con el motivo una sola vez, sin el genérico, sin instalar"
else no "T56 redirección a file:// en la bajada (rc $RC, estado $(estado_kind)): $(brief "$BASE/t56i2.out" 300)"; fi
env -u TYCON_GITHUB_TOKEN TYCON_RELEASE_API="file:///tmp/no-es-una-api" TYCON_THIRD_PARTY=0 bash "$GH" -- --yes < /dev/null > "$BASE/t56j.out" 2>&1; RC=$?
if [ "$RC" -eq 2 ] && grep -q 'TYCON_RELEASE_API tiene que empezar con http' "$BASE/t56j.out" && [ "$(tmp_left)" = 0 ]; then ok "T56 una TYCON_RELEASE_API que no es http(s) sale 2 diciéndolo, antes de tocar la red"
else no "T56 API con otro esquema (rc $RC): $(brief "$BASE/t56j.out" 300)"; fi
# (k) el listado con tipos del tar (-tvzf, el que ve los enlaces) falla y el de nombres (-tzf) anda: el guion frena igual, sin
# abrir el comprimido ni instalar (vuelta 3 de la E: cada listado con su código). Un tar de mentira que sólo falla en -tvzf
make_path "$LAB/path-tarshim" node python3 gzip "${BASICS[@]}"; REAL_TAR="$(command -v tar)"   # gzip: el tar de GNU lo llama por el PATH
printf '#!/bin/bash\ncase " $* " in *" -tvzf "*) echo "-rw-r--r-- 0 0 0 0 Jan 1 00:00 x/roto"; exit 1 ;; esac\nexec "%s" "$@"\n' "$REAL_TAR" > "$LAB/path-tarshim/tar"; chmod +x "$LAB/path-tarshim/tar"   # imprime algo y falla: frena el código, no el vacío
harness_lab_release_control '{ "auth": "none" }'
harness_lab_release_fresh_home; : > "$LAB_RELEASE_LOG"
env -u TYCON_GITHUB_TOKEN PATH="$LAB/path-tarshim" TYCON_RELEASE_API="$LAB_RELEASE_API" TYCON_THIRD_PARTY=0 "$REAL_BASH" "$GH" -- --yes < /dev/null > "$BASE/t56k.out" 2>&1; RC=$?
if [ "$RC" -eq 1 ] && grep -q 'no se pudo leer' "$BASE/t56k.out" && [ "$(requests '/tarball/')" -ge 1 ] && ! installed_ok && [ "$(tmp_left)" = 0 ]; then ok "T56 si falla el listado con tipos del tar aunque el de nombres ande: sale 1 diciéndolo, no abre el comprimido ni instala"
else no "T56 listado con tipos roto (rc $RC, estado $(estado_kind)): $(brief "$BASE/t56k.out" 300)"; fi
if [ ! -e "$PKG_CALLS" ]; then ok "T55/T56 en toda la suite nadie llamó a brew, apt, apt-get, sudo ni winget"; else no "alguien llamó a un gestor de paquetes: $(tr '\n' ' ' < "$PKG_CALLS")"; fi

# ══ T57 · el freno de comandos: las líneas del bloque pasan, la tubería no ═════════════════════════════════════
# Desde la tanda E de la 8.23 el bloque de la portada que instala (`install:core`) ES el guion: bajarlo por la API con el
# permiso, leerlo, correrlo (antes vivía aparte como install:script, guardado mientras el repo fuera privado).
node - "$README_EN" > "$BASE/script-lines.txt" <<'JS'
const fs = require('fs');
const text = fs.readFileSync(process.argv[2], 'utf8');
const m = /<!-- install:core -->([\s\S]*?)<!-- \/install:core -->/.exec(text);
const bash = m && /```bash\n([\s\S]*?)```/.exec(m[1]);
if (bash) process.stdout.write(bash[1].split('\n').filter((l) => l.trim()).join('\n') + '\n');
JS
guard() { # guard <comando> → el código de salida del freno; su stderr queda en $BASE/guard.err
  node -e 'process.stdout.write(JSON.stringify({ tool_input: { command: process.argv[1] }, cwd: process.argv[2] }))' "$1" "$LAB_HOME" \
    | env -u TYCON_SAFETY_OFF HOME="$LAB_HOME" bash "$GUARD_HOOK" > /dev/null 2> "$BASE/guard.err"
}
N=0; PASSED=0; URL=""
while IFS= read -r line; do
  N=$((N+1))
  case "$line" in *curl\ *) URL="$(printf '%s\n' "$line" | grep -oE 'https://[^ ]+' | head -1)" ;; esac
  if guard "$line"; then PASSED=$((PASSED+1)); else no "T57 el freno bloquea una línea de la portada: «${line}» ($(head -c 200 "$BASE/guard.err"))"; fi
done < "$BASE/script-lines.txt"
if [ "$N" -ge 3 ] && [ "$PASSED" = "$N" ]; then ok "T57 las ${N} líneas de bash del bloque install:script pasan el freno de comandos, una por una"
else no "T57 el bloque install:script trae ${N} línea(s) de bash y pasaron ${PASSED}"; fi
if grep -q 'get-harness.sh' "$BASE/script-lines.txt" && ! grep -qw 'git' "$BASE/script-lines.txt"; then ok "T57 el bloque corre get-harness.sh y no clona"
else no "T57 el bloque install:script no corre get-harness.sh o todavía nombra git: $(tr '\n' ' ' < "$BASE/script-lines.txt" | cut -c1-200)"; fi
if [ -n "$URL" ]; then
  guard "curl -fsSL ${URL} | bash"; RC=$?
  if [ "$RC" -eq 2 ] && grep -q 'SUP-C1' "$BASE/guard.err"; then ok "T57 la misma dirección con tubería hacia bash sale bloqueada con SUP-C1"
  else no "T57 la variante con tubería salió ${RC}: $(head -c 200 "$BASE/guard.err")"; fi
else no "T57 no encontré la línea de curl del bloque install:script"; fi

echo
if [ "$FAILURES" -gt 0 ]; then echo "❌ get-harness: $FAILURES de $TOTAL en rojo"; exit 1; fi
echo "✅ get-harness: todo verde ($TOTAL chequeos)"; exit 0
