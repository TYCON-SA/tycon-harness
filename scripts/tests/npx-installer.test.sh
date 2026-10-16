#!/usr/bin/env bash
# npx-installer.test.sh — el instalador del paquete de npm (`scripts/setup/npm/index.js`), por EJECUCIÓN: el paquete armado
# con `npm pack` y corrido con `npx`, contra el GitHub de juguete, en una HOME de juguete (story 8.40, tanda A).
#
# Lo que no se puede perder:
#   · T1  — `npx --package <tgz> tycon-harness` instala: dice de dónde baja («bajo <repo> (main <sha7>)») antes del plan,
#           baja por las rutas públicas (info/refs y codeload, ninguna consulta suya a la API), la pregunta «¿Instalo?»
#           llega a la terminal y la respuesta también, borra su carpeta temporal y nunca invoca git. El hijo corre con
#           el MISMO Node (process.execPath): un `node` de mentira adelante en el PATH no se invoca.
#   · T2  — las opciones de install llegan tal cual (sin `--` en el medio) y `--dry-run` no escribe nada.
#   · T4  — el repo privado: sin terminal sale 1 con UNA acción y nada escrito; con TYCON_GITHUB_TOKEN lo guarda (0600) e
#           instala; en una terminal lo pide sin eco; el valor no aparece en nada salvo config.json; la redirección a
#           codeload va sin credencial. Con `--team` a un repo del equipo que no se lee, lo dice ANTES de bajar nada; el
#           permiso PEDIDO para ese repo no baja el arnés público (codeload, sin credencial); el tope de la API al mirarlo
#           dice la hora. `--repo`/`--team` con un segmento «.» o «..» salen 2 sin red.
#   · T6  — una máquina ya instalada: «ya está» con el lugar, la versión y `harness.js update`, sale 0 sin red; con
#           `--audience org`, corre el team-init del árbol instalado.
#   · T7  — sin red, un 500, un comprimido cortado, el tope de la API: sale 1 con la causa, sin temporal, la HOME igual;
#           también un 500 o la red caída al mirar el repo del equipo (sin pedir permiso), un estado del arnés ilegible
#           (sin instalar encima) y un tar cortado por una señal (la nombra).
#   · T8  — un requisito que falta (tar): una línea con el comando sugerido; nadie corre un gestor de paquetes.
#   · T9  — el «no» al plan, o la entrada que se termina: «no se instaló nada», sale 0, sin arnés ni estado ni temporal
#           (lo que install deja en ~/.tycon tras un «no» —carpetas vacías, la caché de terceros— se anota con ℹ️). Con la
#           organización (3, o --audience org), el «no» y --dry-run salen 0 «no se instaló nada» sin arrancar el alta.
#   · T17 — «¿Para quién es esta instalación?» sin valor por defecto: tres vacías salen 2 sin bajar nada; 1 sigue como
#           hoy (T9); 2 pide el repo del perfil y lanza install --team; 3 instala sin capa y, si sale 0, corre
#           harness.js team-init del árbol instalado en la misma terminal; la cadena completa, con el nombre contestado,
#           deja los tres archivos del perfil. Con 2, una dirección vacía o que no es un repo vuelve a preguntar (a la
#           tercera sale 2 sin bajar nada) y la URL de GitHub vale como en --team (pase adversarial, clases 7 y 2).
#   · T18 — `--audience` y `--team` contestan sin preguntar; sin terminal vale «para mí».
#   · T35 — detrás de un proxy (HTTP_PROXY, o npm_config_proxy que pasa npx) baja por él; NO_PROXY lo saltea; un TLS que
#           no se puede verificar nombra NODE_EXTRA_CA_CERTS.
#
# Cómo mide, sin red: el laboratorio de get-harness.test.sh (`harness_lab_release_server` con el nombre inventado
# `example-org/example-harness`, el instalador recibe `--repo`), la terminal de juguete de python3, un git testigo, y la
# caché de npm en una carpeta del laboratorio (`npm_config_cache`: un .tgz rearmado con la misma ruta no sale de una caché
# vieja). Sin python3, git, node, npm, npx o tar: UNA línea «NO MEDIDO» y exit 2.
# stable-data: el reloj se lee a propósito en dos lugares, como en get-harness.test.sh: el permiso de laboratorio lleva los
# segundos (un valor que no está en ningún otro archivo, para buscarlo en todo lo escrito) y el tope de la API vence en
# 40 minutos desde ahora (la hora que el instalador tiene que decir sale de ese reloj); ninguna afirmación compara fechas.
# Correr: bash scripts/tests/npx-installer.test.sh   (~3 min)

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG_SRC="$RAIZ/scripts/setup/npm"
for tool in python3 git node npm npx tar; do
  command -v "$tool" >/dev/null 2>&1 || { echo "⏭ npx-installer: NO MEDIDO — no hay ${tool} en esta máquina"; exit 2; }
done
[ -f "$PKG_SRC/index.js" ] || { echo "❌ npx-installer: no existe scripts/setup/npm/index.js"; exit 1; }

FAILURES=0; TOTAL=0
ok() { TOTAL=$((TOTAL+1)); echo "✅ npx-installer: $1"; }
no() { TOTAL=$((TOTAL+1)); FAILURES=$((FAILURES+1)); echo "❌ npx-installer: $1"; }
brief() { tail -4 "$1" 2>/dev/null | tr '\n' ' ' | cut -c1-"${2:-300}"; }

BASE="$(mktemp -d /tmp/npx-installer.XXXXXX)" && BASE="$(cd "$BASE" && pwd -P)" || { echo "❌ npx-installer: no pude crear la carpeta temporal"; exit 1; }
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$BASE"' EXIT
REAL_NODE="$(command -v node)"; REAL_NPX="$(command -v npx)"; REAL_NPM="$(command -v npm)"
# shellcheck source=lib/harness-lab.sh
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
harness_lab_create "$BASE/lab" || { echo "❌ npx-installer: no pude armar el laboratorio"; exit 1; }
ORG=example-org; NAME=example-harness; REPO="$ORG/$NAME"
TEAM_PERM="permiso-del-equipo-de-laboratorio"   # el permiso de mentira del repo del equipo (no es un secreto)
harness_lab_release_server "$ORG" "$NAME" || { echo "❌ npx-installer: el servidor de versiones de juguete no arrancó"; exit 1; }
harness_lab_publish_stable 2026.10.08.1 || { echo "❌ npx-installer: no pude publicar la versión de juguete"; exit 1; }
harness_lab_git_witness
export TYCON_UPDATE_APPLY=auto TYCON_THIRD_PARTY=0
export npm_config_cache="$LAB/npm-cache" npm_config_update_notifier=false npm_config_audit=false npm_config_fund=false npm_config_prefer_offline=true
unset TYCON_GITHUB_TOKEN HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy npm_config_proxy npm_config_https_proxy

# ── el paquete, armado como lo arma el workflow (LICENSE copiado a la carpeta) ───────────────────────────────────────
PKG="$BASE/pkg"; mkdir -p "$PKG"
cp "$PKG_SRC/package.json" "$PKG_SRC/index.js" "$PKG_SRC/README.md" "$PKG/" && cp "$RAIZ/LICENSE" "$PKG/LICENSE"
( cd "$PKG" && "$REAL_NPM" pack --silent --pack-destination "$BASE" > "$BASE/pack.out" 2> "$BASE/pack.err" ) || { echo "❌ npx-installer: npm pack falló: $(brief "$BASE/pack.err")"; exit 1; }
TGZ="$BASE/$(tail -1 "$BASE/pack.out")"
[ -f "$TGZ" ] || { echo "❌ npx-installer: npm pack no dejó el comprimido ($(cat "$BASE/pack.out"))"; exit 1; }

TYCON_DIR() { printf '%s' "$LAB_HOME/.tycon"; }
estado_kind() { node -e 'try{const s=require(process.argv[1]);console.log(s.sources[0].kind)}catch{console.log("sin-estado")}' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json" 2>/dev/null; }
# lo que queda en ~/.tycon tras un «no»: install borra lo que bajó (incoming/<v>) pero puede dejar carpetas vacías o la
# caché de las skills de terceros; eso es de install (release.js, que esta story no toca) y se anota, no se mide
nothing_installed() { [ "$(estado_kind)" = sin-estado ] && [ ! -e "$(TYCON_DIR)/harness" ] && [ ! -e "$(TYCON_DIR)/state/harness-state.json" ]; }
tycon_left() { [ -d "$(TYCON_DIR)" ] && (cd "$(TYCON_DIR)" && find . -mindepth 1 -maxdepth 2 | LC_ALL=C sort | tr '\n' ' ') || echo 'no existe'; }
tycon_note() { [ -d "$(TYCON_DIR)" ] && echo "ℹ️  npx-installer: tras $2 quedó en ~/.tycon (de install, no del instalador): $(tycon_left)"; return 0; }
installed_ok() { [ "$(estado_kind)" = release ] && [ -f "$(TYCON_DIR)/harness/version.json" ] && [ -f "$(TYCON_DIR)/harness/scripts/setup/harness.js" ]; }
requests() { grep -c -- "$1" "$LAB_RELEASE_LOG" 2>/dev/null || true; }
log_lines() { wc -l < "$LAB_RELEASE_LOG" | tr -d ' '; }
tmp_left() { ls -d "$LAB_TMP"/tycon-harness-* 2>/dev/null | wc -l | tr -d ' '; }
# run_npx <opciones…> — npx con el paquete armado, sin terminal (el --yes de npm va ANTES del nombre: no pregunta npx)
run_npx() { env -u TYCON_GITHUB_TOKEN "$REAL_NPX" --yes --package "$TGZ" tycon-harness --repo "$REPO" "$@" < /dev/null; }
# run_npx_tty <respuesta> <opciones…> — lo mismo en una terminal de juguete
run_npx_tty() { local a="$1"; shift; harness_lab_pty "$a" env -u TYCON_GITHUB_TOKEN "$REAL_NPX" --yes --package "$TGZ" tycon-harness --repo "$REPO" "$@"; }
# run_ix <opciones…> — el programa del paquete directo, con el Node de verdad por ruta (sin npx), sin terminal
run_ix() { env -u TYCON_GITHUB_TOKEN "$REAL_NODE" "$PKG/index.js" --repo "$REPO" "$@" < /dev/null; }
run_ix_tty() { local a="$1"; shift; harness_lab_pty "$a" env -u TYCON_GITHUB_TOKEN "$REAL_NODE" "$PKG/index.js" --repo "$REPO" "$@"; }

# ══ T1 · npx desde el paquete: baja por las rutas públicas e instala, la pregunta llega ═══════════════════════════
SHA7="$(harness_lab_remote_head main | cut -c1-7)"   # (antes de vaciar el registro del git testigo: esto es de la prueba)
harness_lab_release_fresh_home; : > "$LAB_RELEASE_LOG"; : > "$LAB_GIT_WITNESS_LOG"
LAB_PTY_DELAY=6 run_npx_tty s --audience me --profile minimal --integrations none --packs none > "$BASE/t1.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && installed_ok && grep -q '¿Instalo? \[s/N\]' "$BASE/t1.out"; then ok "T1 npx --package <tgz> tycon-harness instala en una terminal: la pregunta «¿Instalo?» llega y la respuesta también (estado release, ~/.tycon/harness)"
else no "T1 npx desde el paquete (rc $RC, estado $(estado_kind)): $(brief "$BASE/t1.out" 500)"; fi
L_BAJO="$(grep -n "bajo $REPO (main $SHA7)" "$BASE/t1.out" | head -1 | cut -d: -f1)"; L_PLAN="$(grep -n '¿Instalo?' "$BASE/t1.out" | head -1 | cut -d: -f1)"
if [ -n "$L_BAJO" ] && [ -n "$L_PLAN" ] && [ "$L_BAJO" -lt "$L_PLAN" ]; then ok "T1 dice de dónde baja («bajo $REPO (main $SHA7)») antes del plan"
else no "T1 la línea «bajo $REPO (main $SHA7)» antes del plan (línea ${L_BAJO:-ninguna}, plan ${L_PLAN:-ninguno})"; fi
if [ "$(requests 'info/refs')" -ge 2 ] && [ "$(requests '/tar.gz/')" -ge 2 ] && [ "$(grep -c '"host":"api"' "$LAB_RELEASE_LOG")" = 1 ] && [ "$(requests '/tarball/')" = 0 ]; then
  ok "T1 sin permiso baja por info/refs y codeload; la instalación entera gasta UNA consulta a la API (la de install)"
else no "T1 las consultas: info/refs $(requests 'info/refs') · tar.gz $(requests '/tar.gz/') · API $(grep -c '"host":"api"' "$LAB_RELEASE_LOG") · tarball $(requests '/tarball/')"; fi
if [ ! -s "$LAB_GIT_WITNESS_LOG" ]; then ok "T1 git no se invocó ni una vez"; else no "T1 git se invocó: $(head -3 "$LAB_GIT_WITNESS_LOG" | tr '\n' ' ')"; fi
if [ "$(tmp_left)" = 0 ]; then ok "T1 la carpeta temporal del instalador se borró"; else no "T1 quedaron $(tmp_left) carpeta(s) temporal(es) en $LAB_TMP"; fi
if ! grep -q 'Para quién es' "$BASE/t1.out"; then ok "T18 con --audience me no pregunta para quién es"; else no "T18 --audience me preguntó igual"; fi
# el hijo corre con process.execPath: un node de mentira adelante en el PATH anota cada invocación (y corre el de verdad,
# porque install y su aplicador sí lanzan `node` por nombre para sus hooks); ninguna puede ser harness.js del instalador
mkdir -p "$LAB/fake-node-bin"; printf '#!/bin/sh\necho "node de mentira: $*" >> "%s"\nexec "%s" "$@"\n' "$LAB/fake-node.log" "$REAL_NODE" > "$LAB/fake-node-bin/node"; chmod +x "$LAB/fake-node-bin/node"
harness_lab_release_fresh_home
env -u TYCON_GITHUB_TOKEN PATH="$LAB/fake-node-bin:$PATH" "$REAL_NODE" "$PKG/index.js" --repo "$REPO" --profile minimal --integrations none --packs none --yes < /dev/null > "$BASE/t1b.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && installed_ok && ! grep -q 'scripts/setup/harness.js \(install\|config\)' "$LAB/fake-node.log" 2>/dev/null; then ok "T1 el hijo (install) corre con el mismo Node que el instalador: el node de mentira del PATH nunca lanzó harness.js install"
else no "T1 process.execPath (rc $RC, node de mentira: $(grep 'scripts/setup/harness.js' "$LAB/fake-node.log" 2>/dev/null | head -2 | tr '\n' ' ')): $(brief "$BASE/t1b.out")"; fi

# ══ T6 · la máquina ya instalada: «ya está», sin red ═══════════════════════════════════════════════════════════════
N0="$(log_lines)"
run_npx > "$BASE/t6.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && grep -q 'ya está instalado' "$BASE/t6.out" && grep -q '2026.10.08.1' "$BASE/t6.out" && grep -qE 'node "[^"]+/harness\.js" update' "$BASE/t6.out" && grep -qF "$(TYCON_DIR)/harness" "$BASE/t6.out" && [ "$(log_lines)" = "$N0" ]; then
  ok "T6 con el arnés ya instalado: dice dónde, qué versión y que actualizar es harness.js update (la ruta entre comillas, para pegarla); sale 0 sin tocar la red"
else no "T6 máquina instalada (rc $RC, pedidos $(($(log_lines) - N0))): $(brief "$BASE/t6.out")"; fi
# con el arnés ya instalado, «dar de alta mi organización» no es «ya está»: corre team-init del árbol INSTALADO, sin red
# (sin terminal, el alta pide --name y sale 2: lo que mide que llegó a correr)
N0="$(log_lines)"
run_ix --audience org > "$BASE/t6org.out" 2>&1; RC=$?
if [ "$RC" -eq 2 ] && grep -q 'falta el nombre de la organización' "$BASE/t6org.out" && ! grep -q 'ya está instalado' "$BASE/t6org.out" && [ "$(log_lines)" = "$N0" ]; then
  ok "T6/T18 con el arnés ya instalado y --audience org: corre harness.js team-init del árbol instalado, sin bajar nada"
else no "T6 instalada + --audience org (rc $RC, pedidos $(($(log_lines) - N0))): $(brief "$BASE/t6org.out")"; fi

# ══ T2 · las opciones llegan tal cual; --dry-run no escribe ════════════════════════════════════════════════════════
harness_lab_release_fresh_home; H0="$(harness_lab_home_hash)"
run_npx --profile full --integrations none --packs all --dry-run > "$BASE/t2.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(harness_lab_home_hash)" = "$H0" ] && grep -q 'bajo ' "$BASE/t2.out" && ! grep -q 'opción desconocida' "$BASE/t2.out" && [ "$(tmp_left)" = 0 ]; then
  ok "T2 --profile full --integrations none --packs all --dry-run llegan a install tal cual (sin --) y la HOME queda idéntica"
else no "T2 opciones y --dry-run (rc $RC, HOME $([ "$(harness_lab_home_hash)" = "$H0" ] && echo igual || echo cambió)): $(brief "$BASE/t2.out" 500)"; fi

# ══ T9 · el «no» y la entrada que se termina (con la pregunta de para quién contestada «1») ══════════════════════
harness_lab_release_fresh_home
LAB_PTY_DELAY=5 run_npx_tty $'1\nn' --profile minimal --integrations none --packs none > "$BASE/t9.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && grep -q 'Para quién es esta instalación' "$BASE/t9.out" && grep -q 'no se instaló nada' "$BASE/t9.out" && nothing_installed && [ "$(tmp_left)" = 0 ]; then
  ok "T9/T17 en una terminal pregunta para quién es; con «1» sigue como hoy, y el «no» al plan sale 0 «no se instaló nada» sin arnés, sin estado y sin temporal"
else no "T9 el no (rc $RC, ~/.tycon: $(tycon_left)): $(brief "$BASE/t9.out" 500)"; fi
tycon_note "$BASE/t9.out" "el «no»"
harness_lab_release_fresh_home
LAB_PTY_DELAY=5 run_ix_tty $'1\n\x04' --profile minimal --integrations none --packs none > "$BASE/t9b.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && grep -q 'no se instaló nada' "$BASE/t9b.out" && nothing_installed && [ "$(tmp_left)" = 0 ]; then ok "T9 la entrada que se termina en el plan: «no se instaló nada», sale 0, sin arnés ni estado"
else no "T9 entrada cerrada (rc $RC, ~/.tycon: $(tycon_left)): $(brief "$BASE/t9b.out" 400)"; fi
# para la organización (la respuesta 3, o --audience org): install sale 0 SIN instalar (el «no», --dry-run) → sale 0 «no se
# instaló nada» y el alta NO arranca (no hay árbol instalado del que correrla)
harness_lab_release_fresh_home
LAB_PTY_DELAY=5 run_ix_tty $'3\nn' --profile minimal --integrations none --packs none > "$BASE/t9org.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && grep -q 'no se instaló nada' "$BASE/t9org.out" && nothing_installed && ! grep -q 'team-init\|nombre de la organización' "$BASE/t9org.out" && [ "$(tmp_left)" = 0 ]; then
  ok "T9/T17 con «3» y el «no» al plan: sale 0 «no se instaló nada», sin arnés y sin arrancar el alta"
else no "T9 «3» + no (rc $RC, ~/.tycon: $(tycon_left)): $(brief "$BASE/t9org.out" 400)"; fi
harness_lab_release_fresh_home; H0="$(harness_lab_home_hash)"
run_ix --audience org --profile minimal --integrations none --packs none --dry-run > "$BASE/t9orgdry.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && grep -q 'no se instaló nada' "$BASE/t9orgdry.out" && [ "$(harness_lab_home_hash)" = "$H0" ] && ! grep -q 'team-init\|nombre de la organización' "$BASE/t9orgdry.out"; then
  ok "T9/T18 --audience org con --dry-run: sale 0 «no se instaló nada», la HOME igual y sin arrancar el alta"
else no "T9 --audience org --dry-run (rc $RC, HOME $([ "$(harness_lab_home_hash)" = "$H0" ] && echo igual || echo cambió)): $(brief "$BASE/t9orgdry.out" 400)"; fi

# ══ T17 · la pregunta de para quién: sin valor por defecto; 2 lanza --team; 3 instala y sigue con el alta ════════════
harness_lab_release_fresh_home; : > "$LAB_RELEASE_LOG"
run_ix_tty $'\n\n' > "$BASE/t17a.out" 2>&1; RC=$?
if [ "$RC" -eq 2 ] && [ "$(grep -o 'Para quién es esta instalación' "$BASE/t17a.out" | wc -l | tr -d ' ')" -ge 3 ] && grep -q 'sin elegir' "$BASE/t17a.out" && [ "$(log_lines)" = 0 ] && [ ! -d "$(TYCON_DIR)" ]; then
  ok "T17 sin valor por defecto: tres respuestas vacías salen 2 «sin elegir» sin bajar nada"
else no "T17 tres vacías (rc $RC, pedidos $(log_lines)): $(brief "$BASE/t17a.out" 400)"; fi
# la opción 3: instala sin capa y, con install en 0, corre team-init del árbol instalado en la misma terminal (la entrada
# se termina en la primera pregunta del alta: sale 2 sin escribir el perfil, con la máquina ya instalada)
LAB_PTY_DELAY=4 run_ix_tty $'3\n\x04' --profile minimal --integrations none --packs none --yes > "$BASE/t17c.out" 2>&1; RC=$?
if [ "$RC" -eq 2 ] && installed_ok && grep -q 'alta de tu organización' "$BASE/t17c.out" && grep -q 'nombre de la organización' "$BASE/t17c.out"; then ok "T17 con «3»: instala sin capa y después corre harness.js team-init del árbol instalado, en la misma terminal"
else no "T17 opción 3 (rc $RC, estado $(estado_kind)): $(brief "$BASE/t17c.out" 400)"; fi
harness_lab_release_fresh_home
run_ix --audience org --profile minimal --integrations none --packs none --yes > "$BASE/t18org.out" 2>&1; RC=$?
if [ "$RC" -eq 2 ] && installed_ok && ! grep -q 'Para quién' "$BASE/t18org.out" && grep -q 'falta el nombre de la organización' "$BASE/t18org.out"; then ok "T18 --audience org contesta sin preguntar: instala y lanza el alta (sin terminal, el alta pide --name y sale 2)"
else no "T18 --audience org (rc $RC): $(brief "$BASE/t18org.out")"; fi
run_ix --audience nadie > "$BASE/t18bad.out" 2>&1; RC=$?
if [ "$RC" -eq 2 ] && grep -q 'me, team u org' "$BASE/t18bad.out"; then ok "T18 un --audience que no es me, team u org sale 2 diciéndolo"; else no "T18 --audience inválido (rc $RC): $(brief "$BASE/t18bad.out")"; fi
# la opción 2: el repo del perfil del equipo (privado en el juguete) — la respuesta llega y se lanza install --team
harness_lab_team_repo "$ORG" example-team || no "T17 no pude armar el repo del equipo de juguete"
harness_lab_team_server || no "T17 el servidor de juguete con los dos repos no arrancó"
harness_lab_release_control "{ \"auth\": \"none\", \"auth_by_repo\": { \"$ORG/example-team\": \"token:permiso-del-equipo-de-laboratorio\" } }"
harness_lab_release_fresh_home; : > "$LAB_RELEASE_LOG"
run_ix --team "$ORG/example-team" --profile minimal --yes > "$BASE/t4team.out" 2>&1; RC=$?
if [ "$RC" -eq 1 ] && grep -q "$ORG/example-team" "$BASE/t4team.out" && grep -q 'github.com/settings/' "$BASE/t4team.out" && [ "$(requests '/tar.gz/')" = 0 ] && [ "$(requests '/tarball/')" = 0 ] && [ ! -d "$(TYCON_DIR)" ]; then
  ok "T4 con --team a un repo del equipo que no se lee, sin terminal: sale 1 nombrándolo con la acción, ANTES de bajar nada"
else no "T4 --team privado sin permiso (rc $RC, tar.gz $(requests '/tar.gz/')): $(brief "$BASE/t4team.out" 400)"; fi
harness_lab_release_fresh_home; : > "$LAB_RELEASE_LOG"
# (el permiso del equipo va por TYCON_GITHUB_TOKEN: las dos respuestas se tipean juntas, y lo que llega a la terminal
# antes de que alguien lea sin eco la terminal lo muestra — el pedido sin eco lo mide T4 por terminal)
LAB_PTY_DELAY=2 harness_lab_pty $'2\nexample-org/example-team' env TYCON_GITHUB_TOKEN="$TEAM_PERM" "$REAL_NODE" "$PKG/index.js" --repo "$REPO" --profile minimal --yes > "$BASE/t17b.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && grep -q 'repo del perfil' "$BASE/t17b.out" && grep -q 'example-team' "$LAB_RELEASE_LOG" && ! grep -qF 'permiso-del-equipo-de-laboratorio' "$BASE/t17b.out"; then
  ok "T17 con «2»: pide el repo del perfil y lanza install --team (el juguete anota las consultas al repo del equipo); el permiso no sale en pantalla"
else no "T17 opción 2 (rc $RC; consultas al equipo $(requests 'example-team')): $(brief "$BASE/t17b.out" 500)"; fi
if [ "$(node -e 'try{const s=require(process.argv[1]);console.log(s.team?s.team.repo:"")}catch{console.log("")}' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json")" = "$ORG/example-team" ]; then ok "T17 la máquina quedó con la capa del equipo apilada (estado team)"
else no "T17 el estado no tiene la capa del equipo: $(node -e 'try{const s=require(process.argv[1]);console.log(JSON.stringify(s.team))}catch(e){console.log(e.message)}' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json")"; fi
# pase adversarial de la 8.40, clase 7: con «2», una dirección vacía (o que no es un repo) vuelve a preguntar, como la
# pregunta de para quién; a la tercera sale 2 sin bajar nada (nunca sigue como «para mí» sin avisar)
harness_lab_release_fresh_home; : > "$LAB_RELEASE_LOG"
LAB_PTY_DELAY=2 run_ix_tty $'2\n\nno es un repo\n' --profile minimal --yes > "$BASE/t17empty.out" 2>&1; RC=$?
if [ "$RC" -eq 2 ] && [ "$(grep -o 'dirección del repo del perfil del equipo' "$BASE/t17empty.out" | wc -l | tr -d ' ')" -ge 3 ] && [ "$(log_lines)" = 0 ] && [ ! -d "$(TYCON_DIR)" ]; then
  ok "T17 (clase 7) con «2» y la dirección vacía o inválida: vuelve a preguntar y a la tercera sale 2 sin bajar nada"
else no "T17 dirección vacía (rc $RC, pedidos $(log_lines)): $(brief "$BASE/t17empty.out" 400)"; fi
# clase 2: la respuesta 2 acepta lo que acepta --team (la URL de GitHub, no sólo org/repo)
harness_lab_release_fresh_home; : > "$LAB_RELEASE_LOG"
LAB_PTY_DELAY=2 harness_lab_pty $'2\nhttps://github.com/example-org/example-team.git' env TYCON_GITHUB_TOKEN="$TEAM_PERM" "$REAL_NODE" "$PKG/index.js" --repo "$REPO" --profile minimal --dry-run > "$BASE/t17url.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && grep -q 'example-team' "$LAB_RELEASE_LOG" && ! grep -q 'tiene que ser' "$BASE/t17url.out"; then ok "T17 (clase 2) con «2», la URL de GitHub del repo del perfil se acepta como en --team"
else no "T17 URL de GitHub en la respuesta 2 (rc $RC): $(brief "$BASE/t17url.out" 400)"; fi
# el permiso PEDIDO para el repo del equipo no se usa para bajar el arnés público: el comprimido del instalador sigue por
# codeload, sin credencial (la primera bajada del registro es la del instalador; las de install vienen después)
harness_lab_release_fresh_home; : > "$LAB_RELEASE_LOG"
LAB_PTY_DELAY=4 run_ix_tty permiso-del-equipo-de-laboratorio --team "$ORG/example-team" --profile minimal --yes > "$BASE/t4teamask.out" 2>&1; RC=$?
FIRST_DL="$(grep -m1 -E '/tar\.gz/|/tarball/' "$LAB_RELEASE_LOG")"
if [ "$RC" -eq 0 ] && grep -q 'pegá el permiso' "$BASE/t4teamask.out" && [[ "$FIRST_DL" == *'"host":"codeload"'* ]] && [[ "$FIRST_DL" == *'"auth":false'* ]] && ! grep -qF 'permiso-del-equipo-de-laboratorio' "$BASE/t4teamask.out"; then
  ok "T4 el permiso pedido para el repo del equipo no se reusa para el arnés público: el instalador baja por codeload sin credencial"
else no "T4 permiso del equipo reusado (rc $RC; primera bajada: ${FIRST_DL:-ninguna}): $(brief "$BASE/t4teamask.out" 400)"; fi
# mirar el repo del equipo distingue: el tope de la API dice hasta qué hora (no pide permiso ni sigue a bajar)
RESET_T=$(( $(date +%s) + 2700 )); HORA_T="$(node -e 'const d=new Date(Number(process.argv[1])*1000);console.log(`${d.getHours()}`.padStart(2,"0")+":"+`${d.getMinutes()}`.padStart(2,"0"))' "$RESET_T")"
harness_lab_release_control "{ \"auth\": \"none\", \"auth_by_repo\": { \"$ORG/example-team\": \"token:permiso-del-equipo-de-laboratorio\" }, \"ratelimit\": true, \"ratelimit_reset\": $RESET_T }"
harness_lab_release_fresh_home; : > "$LAB_RELEASE_LOG"
env TYCON_GITHUB_TOKEN="$TEAM_PERM" "$REAL_NODE" "$PKG/index.js" --repo "$REPO" --team "$ORG/example-team" --profile minimal --yes < /dev/null > "$BASE/t4teamlimit.out" 2>&1; RC=$?
if [ "$RC" -eq 1 ] && grep -q "example-team.*hasta las $HORA_T" "$BASE/t4teamlimit.out" && [ "$(requests '/tar.gz/')" = 0 ] && [ "$(requests '/tarball/')" = 0 ] && [ ! -d "$(TYCON_DIR)" ]; then
  ok "T4/T26 el tope de la API al mirar el repo del equipo: sale 1 nombrándolo y diciendo hasta qué hora, sin bajar nada"
else no "T4 tope al mirar el equipo (rc $RC): $(brief "$BASE/t4teamlimit.out" 400)"; fi
harness_lab_release_control '{ "auth": "none" }'
# --repo y --team con un segmento «.» o «..» no son nombres: cambiarían de endpoint en la URL. Sale 2 sin tocar la red
harness_lab_release_fresh_home; : > "$LAB_RELEASE_LOG"; DOTS_OK=1; DOTS_BAD=''
for bad in "--repo ../$NAME" "--repo $ORG/.." "--repo ./." "--team $ORG/.." "--team ../example-team" "--team https://dev.azure.com/../acme/_git/perfil" "--team https://dev.azure.com/acme/../_git/perfil"; do
  # shellcheck disable=SC2086
  run_ix $bad --yes > "$BASE/t1dots.out" 2>&1; RC=$?
  if [ "$RC" -ne 2 ]; then DOTS_OK=0; DOTS_BAD="${DOTS_BAD} «${bad}» rc ${RC}: $(brief "$BASE/t1dots.out" 160);"; fi
done
if [ "$DOTS_OK" = 1 ] && [ "$(log_lines)" = 0 ] && [ ! -d "$(TYCON_DIR)" ]; then ok "T1 --repo/--team con un segmento «.» o «..» (GitHub y Azure) salen 2 sin tocar la red"
else no "T1 segmentos de puntos (pedidos $(log_lines)):$DOTS_BAD"; fi
# la cadena completa install → alta, con el nombre CONTESTADO en la terminal: «3» (y --audience org) instalan y el alta
# escribe los tres archivos. El ejemplo del alta: el repo del equipo de juguete, ya público, con los tres archivos del
# ejemplo publicado (los de fixtures/team-init-example/)
cp "$RAIZ/scripts/tests/fixtures/team-init-example/"*.json "$LAB_AUTHOR_TEAM/" && harness_lab_team_publish "los tres archivos del ejemplo" \
  || no "T17 no pude sumar el ejemplo al repo de juguete"
chain() { # chain <nombre> <respuestas> <opciones…>
  local name="$1" answers="$2" rc d="$BASE/perfil-$1"; shift 2
  harness_lab_release_fresh_home
  LAB_PTY_DELAY=4 harness_lab_pty "$answers" env -u TYCON_GITHUB_TOKEN TYCON_TEAM_EXAMPLE_REPO="$ORG/example-team" "$REAL_NODE" "$PKG/index.js" --repo "$REPO" "$@" --profile minimal --integrations none --packs none --yes > "$BASE/chain-$name.out" 2>&1; rc=$?
  if [ "$rc" -eq 0 ] && installed_ok && [ "$(cd "$d" 2>/dev/null && ls | tr '\n' ' ')" = "team-layer.json team-profile.json team-repos.json " ] && grep -q '"name": "acme-'"$name"'"' "$d/team-layer.json"; then
    ok "T17/T18 $name: instala y el alta, con el nombre contestado en la terminal, deja los tres archivos validados"
  else no "T17/T18 $name, la cadena install → alta (rc $rc, estado $(estado_kind), carpeta: $(ls "$d" 2>/dev/null | tr '\n' ' ')): $(brief "$BASE/chain-$name.out" 500)"; fi
}
chain tres $'3\nacme-tres\ngithub\nacme/harness-team-profile\n'"$BASE/perfil-tres"$'\nn'
chain org $'acme-org\ngithub\nacme/harness-team-profile\n'"$BASE/perfil-org"$'\nn' --audience org

# ══ T4 · el repo del arnés privado ════════════════════════════════════════════════════════════════════════════════
LAB_PERMIT="permiso-de-laboratorio-$(date +%s)"   # no es un secreto
harness_lab_release_control "{ \"auth\": \"token:$LAB_PERMIT\" }"
harness_lab_release_fresh_home; : > "$LAB_RELEASE_LOG"; H0="$(harness_lab_home_hash)"
run_ix --yes > "$BASE/t4a.out" 2>&1; RC=$?
if [ "$RC" -eq 1 ] && grep -q 'github.com/settings/' "$BASE/t4a.out" && grep -q 'TYCON_GITHUB_TOKEN' "$BASE/t4a.out" && [ "$(harness_lab_home_hash)" = "$H0" ] && [ "$(requests '/tarball/')" = 0 ] && [ "$(tmp_left)" = 0 ]; then
  ok "T4 repo privado sin permiso y sin terminal: sale 1 con la única acción, sin bajar ni escribir nada"
else no "T4 privado sin permiso (rc $RC): $(brief "$BASE/t4a.out" 400)"; fi
harness_lab_release_fresh_home; : > "$LAB_RELEASE_LOG"
env TYCON_GITHUB_TOKEN="$LAB_PERMIT" "$REAL_NODE" "$PKG/index.js" --repo "$REPO" --profile minimal --yes < /dev/null > "$BASE/t4b.out" 2>&1; RC=$?
PERM="$(python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777)[2:])' "$(TYCON_DIR)/config.json" 2>/dev/null)"
if [ "$RC" -eq 0 ] && installed_ok && [ "$PERM" = 600 ] && grep -qF "$LAB_PERMIT" "$(TYCON_DIR)/config.json"; then ok "T4 con TYCON_GITHUB_TOKEN: instala y el permiso queda en ~/.tycon/config.json con 0600"
else no "T4 con TYCON_GITHUB_TOKEN (rc $RC, config.json $PERM): $(brief "$BASE/t4b.out" 400)"; fi
if [ "$(grep -c '"host":"codeload".*"auth":true' "$LAB_RELEASE_LOG")" = 0 ] && [ "$(requests '/tarball/')" -ge 1 ]; then ok "T4 con permiso baja por la API y la redirección a codeload va sin la credencial"
else no "T4 la redirección: codeload con credencial $(grep -c '"host":"codeload".*"auth":true' "$LAB_RELEASE_LOG") · tarball $(requests '/tarball/')"; fi
LEAKS="$(grep -rlF "$LAB_PERMIT" "$LAB_HOME" "$BASE/t4b.out" "$LAB_RELEASE_LOG" 2>/dev/null | grep -v '/.tycon/config.json$' || true)"
if [ -z "$LEAKS" ]; then ok "T4 el valor del permiso no aparece en nada de lo escrito salvo config.json"; else no "T4 el permiso quedó escrito en: $(echo "$LEAKS" | tr '\n' ' ')"; fi
harness_lab_release_fresh_home
LAB_PTY_DELAY=4 run_ix_tty "$LAB_PERMIT" --audience me --profile minimal --yes > "$BASE/t4c.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && installed_ok && grep -q 'pegá el permiso' "$BASE/t4c.out" && ! grep -qF "$LAB_PERMIT" "$BASE/t4c.out"; then ok "T4 en una terminal sin permiso: lo pide sin eco, lo guarda e instala"
else no "T4 por terminal (rc $RC, eco $(grep -cF "$LAB_PERMIT" "$BASE/t4c.out")): $(brief "$BASE/t4c.out" 400)"; fi
harness_lab_release_control '{ "auth": "none" }'

# ══ T7 · sin red, 500, cortado, el tope: sale 1 con la causa y no deja nada ════════════════════════════════════════
t7() { # t7 <nombre> <patrón> <descripción> <env…>
  local name="$1" want="$2" what="$3" rc h0; shift 3
  harness_lab_release_fresh_home; h0="$(harness_lab_home_hash)"
  env -u TYCON_GITHUB_TOKEN "$@" "$REAL_NODE" "$PKG/index.js" --repo "$REPO" --profile minimal --yes < /dev/null > "$BASE/t7-$name.out" 2>&1; rc=$?
  if [ "$rc" -eq 1 ] && grep -qE "$want" "$BASE/t7-$name.out" && [ "$(tmp_left)" = 0 ] && [ "$(harness_lab_home_hash)" = "$h0" ]; then ok "T7 $what: sale 1 con la causa, sin temporal y con la HOME igual"
  else no "T7 $what (rc $rc, temporales $(tmp_left)): $(brief "$BASE/t7-$name.out" 400)"; fi
}
t7 nonet 'sin red.*No bajé nada' 'sin red' TYCON_RELEASE_GIT=http://127.0.0.1:9 TYCON_RELEASE_API=http://127.0.0.1:9
node -e 'const s=require("http").createServer((q,r)=>{r.writeHead(500);r.end("roto")});s.listen(0,"127.0.0.1",()=>require("fs").writeFileSync(process.argv[1],String(s.address().port)))' "$BASE/500.port" & P500=$!
for _ in $(seq 1 30); do [ -s "$BASE/500.port" ] && break; sleep 0.1; done
t7 five '500.*No bajé nada' 'GitHub contesta 500' TYCON_RELEASE_GIT="http://127.0.0.1:$(cat "$BASE/500.port")" TYCON_RELEASE_API="http://127.0.0.1:$(cat "$BASE/500.port")"
# al mirar el repo del EQUIPO, un 500 o la red caída no son «pedí permiso»: salen 1 con la causa (un permiso no lo arregla)
t7team() { # t7team <nombre> <patrón> <descripción> <env…>
  local name="$1" want="$2" what="$3" rc h0; shift 3
  harness_lab_release_fresh_home; h0="$(harness_lab_home_hash)"
  env -u TYCON_GITHUB_TOKEN "$@" "$REAL_NODE" "$PKG/index.js" --repo "$REPO" --team "$ORG/example-team" --profile minimal --yes < /dev/null > "$BASE/t7team-$name.out" 2>&1; rc=$?
  if [ "$rc" -eq 1 ] && grep -qE "$want" "$BASE/t7team-$name.out" && ! grep -q 'sin un permiso' "$BASE/t7team-$name.out" && [ "$(tmp_left)" = 0 ] && [ "$(harness_lab_home_hash)" = "$h0" ]; then ok "T7 $what al mirar el repo del equipo: sale 1 con la causa, sin pedir permiso y con la HOME igual"
  else no "T7 $what al mirar el equipo (rc $rc): $(brief "$BASE/t7team-$name.out" 400)"; fi
}
t7team five '500' 'GitHub contesta 500' TYCON_RELEASE_GIT="http://127.0.0.1:$(cat "$BASE/500.port")" TYCON_RELEASE_API="http://127.0.0.1:$(cat "$BASE/500.port")"
t7team nonet 'sin red.*No bajé nada' 'sin red' TYCON_RELEASE_GIT=http://127.0.0.1:9 TYCON_RELEASE_API=http://127.0.0.1:9
kill "$P500" 2>/dev/null; wait "$P500" 2>/dev/null
harness_lab_release_control '{ "auth": "none", "truncate": true }'
t7 trunc 'no se pudo leer|cortado' 'el comprimido cortado'
RESET=$(( $(date +%s) + 2400 )); HORA="$(node -e 'const d=new Date(Number(process.argv[1])*1000);console.log(`${d.getHours()}`.padStart(2,"0")+":"+`${d.getMinutes()}`.padStart(2,"0"))' "$RESET")"
harness_lab_release_control "{ \"auth\": \"none\", \"ratelimit\": true, \"ratelimit_reset\": $RESET }"
t7 limit "hasta las $HORA" "el tope de la API (con la API como única ruta)" TYCON_RELEASE_GIT=http://127.0.0.1:9
harness_lab_release_control '{ "auth": "none" }'

# ══ T8 · un requisito que falta: se sugiere, nadie lo corre ════════════════════════════════════════════════════════
PKG_CALLS="$LAB/package-manager-calls.log"
mkdir -p "$LAB/path-notar"
for t in python3 bash uname env ls; do real="$(command -v "$t")" && ln -sf "$real" "$LAB/path-notar/$t"; done
for t in brew apt apt-get sudo winget; do printf '#!/bin/sh\necho "%s $*" >> "%s"\nexit 0\n' "$t" "$PKG_CALLS" > "$LAB/path-notar/$t"; chmod +x "$LAB/path-notar/$t"; done
harness_lab_release_fresh_home; : > "$LAB_RELEASE_LOG"; H0="$(harness_lab_home_hash)"
env -u TYCON_GITHUB_TOKEN PATH="$LAB/path-notar" "$REAL_NODE" "$PKG/index.js" --repo "$REPO" --yes < /dev/null > "$BASE/t8.out" 2>&1; RC=$?
case "$(uname -s)" in Darwin) WANT='brew install' ;; *) WANT='tar' ;; esac
if [ "$RC" -eq 1 ] && grep -q "falta tar.*$WANT" "$BASE/t8.out" && grep -q 'no lo corro' "$BASE/t8.out" && [ ! -e "$PKG_CALLS" ] && [ "$(log_lines)" = 0 ] && [ "$(harness_lab_home_hash)" = "$H0" ]; then
  ok "T8 sin tar: sale 1 nombrándolo con su comando sugerido, sin correrlo, sin bajar nada y con la HOME igual"
else no "T8 sin tar (rc $RC, gestores: $(cat "$PKG_CALLS" 2>/dev/null | tr '\n' ' ')): $(brief "$BASE/t8.out" 400)"; fi

# ══ T7b · lo que el instalador lanza y lo que lee de la máquina: nada se calla ════════════════════════════════════════
# un estado del arnés que está pero no se lee: no es «sin arnés» — avisa y sale 1, sin instalar encima
harness_lab_release_fresh_home; : > "$LAB_RELEASE_LOG"
mkdir -p "$LAB_HOME/.claude/.tycon-pipeline" && printf '{ "tree": "cortado' > "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"
run_ix --profile minimal --yes > "$BASE/t7state.out" 2>&1; RC=$?
if [ "$RC" -eq 1 ] && grep -q 'harness-state.json' "$BASE/t7state.out" && grep -q 'no se lee' "$BASE/t7state.out" && [ "$(log_lines)" = 0 ] && [ ! -e "$(TYCON_DIR)/harness" ]; then
  ok "T7 un estado del arnés que no se lee: sale 1 nombrándolo, sin red y sin instalar encima"
else no "T7 estado ilegible (rc $RC, pedidos $(log_lines)): $(brief "$BASE/t7state.out" 300)"; fi
rm -f "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"
# un hijo cortado por una señal (un tar que se mata) se dice como tal, no como «comprimido cortado»; la temporal se borra
mkdir -p "$LAB/killed-tar-bin"; printf '#!/bin/sh\nkill -9 $$\n' > "$LAB/killed-tar-bin/tar"; chmod +x "$LAB/killed-tar-bin/tar"
harness_lab_release_fresh_home; H0="$(harness_lab_home_hash)"
env -u TYCON_GITHUB_TOKEN PATH="$LAB/killed-tar-bin:$PATH" "$REAL_NODE" "$PKG/index.js" --repo "$REPO" --profile minimal --yes < /dev/null > "$BASE/t7signal.out" 2>&1; RC=$?
if [ "$RC" -eq 1 ] && grep -q 'SIGKILL' "$BASE/t7signal.out" && grep -q 'tar' "$BASE/t7signal.out" && [ "$(tmp_left)" = 0 ] && [ "$(harness_lab_home_hash)" = "$H0" ]; then
  ok "T7 un tar cortado por una señal: sale 1 nombrando la señal, sin temporal y con la HOME igual"
else no "T7 hijo cortado por señal (rc $RC, temporales $(tmp_left)): $(brief "$BASE/t7signal.out" 300)"; fi

# ══ T35 · el proxy y la CA ═════════════════════════════════════════════════════════════════════════════════════════
harness_lab_release_fresh_home; : > "$LAB_RELEASE_LOG"
env -u TYCON_GITHUB_TOKEN HTTP_PROXY="$LAB_RELEASE_PROXY" "$REAL_NODE" "$PKG/index.js" --repo "$REPO" --dry-run < /dev/null > "$BASE/t35a.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(grep '"host":"git"' "$LAB_RELEASE_LOG" | grep -c '"via_proxy":true')" -ge 1 ] && [ "$(grep '"host":"codeload"' "$LAB_RELEASE_LOG" | grep -c '"via_proxy":true')" -ge 1 ]; then
  ok "T35 con HTTP_PROXY la bajada del instalador pasa por el proxy (info/refs y codeload)"
else no "T35 con HTTP_PROXY (rc $RC, por proxy $(requests '"via_proxy":true')): $(brief "$BASE/t35a.out" 300)"; fi
: > "$LAB_RELEASE_LOG"
env -u TYCON_GITHUB_TOKEN npm_config_proxy="$LAB_RELEASE_PROXY" "$REAL_NODE" "$PKG/index.js" --repo "$REPO" --dry-run < /dev/null > "$BASE/t35b.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(grep '"host":"git"' "$LAB_RELEASE_LOG" | grep -c '"via_proxy":true')" -ge 1 ]; then ok "T35 con npm_config_proxy (la que npx le pasa al proceso) también baja por el proxy"
else no "T35 con npm_config_proxy (rc $RC, por proxy $(requests '"via_proxy":true')): $(brief "$BASE/t35b.out" 300)"; fi
: > "$LAB_RELEASE_LOG"
env -u TYCON_GITHUB_TOKEN HTTP_PROXY="$LAB_RELEASE_PROXY" NO_PROXY=127.0.0.1 "$REAL_NODE" "$PKG/index.js" --repo "$REPO" --dry-run < /dev/null > "$BASE/t35c.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(requests '"via_proxy":true')" = 0 ] && [ "$(requests '"host":"git"')" -ge 1 ]; then ok "T35 con NO_PROXY para el host, va directo (ningún pedido por el proxy)"
else no "T35 con NO_PROXY (rc $RC, por proxy $(requests '"via_proxy":true')): $(brief "$BASE/t35c.out" 300)"; fi
if command -v openssl >/dev/null 2>&1 && openssl req -x509 -newkey rsa:2048 -nodes -keyout "$BASE/tls.key" -out "$BASE/tls.crt" -days 1 -subj '/CN=127.0.0.1' >/dev/null 2>&1; then
  node -e 'const fs=require("fs");const s=require("https").createServer({key:fs.readFileSync(process.argv[1]),cert:fs.readFileSync(process.argv[2])},(q,r)=>{r.writeHead(404);r.end()});s.listen(0,"127.0.0.1",()=>fs.writeFileSync(process.argv[3],String(s.address().port)))' "$BASE/tls.key" "$BASE/tls.crt" "$BASE/tls.port" & PTLS=$!
  for _ in $(seq 1 30); do [ -s "$BASE/tls.port" ] && break; sleep 0.1; done
  harness_lab_release_fresh_home
  env -u TYCON_GITHUB_TOKEN -u NODE_EXTRA_CA_CERTS TYCON_RELEASE_GIT="https://127.0.0.1:$(cat "$BASE/tls.port")" "$REAL_NODE" "$PKG/index.js" --repo "$REPO" --yes < /dev/null > "$BASE/t35d.out" 2>&1; RC=$?
  kill "$PTLS" 2>/dev/null; wait "$PTLS" 2>/dev/null
  if [ "$RC" -eq 1 ] && grep -q 'NODE_EXTRA_CA_CERTS' "$BASE/t35d.out" && [ "$(tmp_left)" = 0 ]; then ok "T35 un certificado que no se puede verificar: sale 1 y el error nombra NODE_EXTRA_CA_CERTS (la CA de la organización)"
  else no "T35 TLS sin verificar (rc $RC): $(brief "$BASE/t35d.out" 300)"; fi
else echo "⏭ npx-installer: T35 (TLS) NO MEDIDO — no hay openssl para armar el certificado de juguete"; fi

# ══ --help y el esquema de las variables de prueba ═════════════════════════════════════════════════════════════════
N0="$(log_lines)"
"$REAL_NODE" "$PKG/index.js" --help > "$BASE/help.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && grep -q 'Provenance' "$BASE/help.out" && [ "$(log_lines)" = "$N0" ]; then ok "--help sale 0 sin tocar la red"; else no "--help (rc $RC): $(brief "$BASE/help.out")"; fi
env TYCON_RELEASE_GIT=file:///tmp/no "$REAL_NODE" "$PKG/index.js" --repo "$REPO" --yes < /dev/null > "$BASE/scheme.out" 2>&1; RC=$?
if [ "$RC" -eq 2 ] && grep -q 'http:// o https://' "$BASE/scheme.out"; then ok "una TYCON_RELEASE_GIT que no es http(s) sale 2 antes de tocar la red"; else no "esquema de las variables (rc $RC): $(brief "$BASE/scheme.out")"; fi

if [ ! -e "$PKG_CALLS" ]; then ok "en toda la suite nadie llamó a brew, apt, apt-get, sudo ni winget"; else no "alguien llamó a un gestor de paquetes: $(tr '\n' ' ' < "$PKG_CALLS")"; fi

echo
if [ "$FAILURES" -gt 0 ]; then echo "❌ npx-installer: $FAILURES de $TOTAL en rojo"; exit 1; fi
echo "✅ npx-installer: todo verde ($TOTAL chequeos)"; exit 0
