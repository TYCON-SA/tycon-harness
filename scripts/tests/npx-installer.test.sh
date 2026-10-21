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
#   · T17 — no se pregunta para quién es: vale «para mí». `--team` lanza install --team (también con la
#           URL de GitHub); `--audience org` instala sin capa y, si sale 0, corre harness.js team-init del árbol instalado
#           en la misma terminal; la cadena completa, con el nombre contestado, deja los tres archivos del perfil.
#   · T18 — `--audience` y `--team` eligen para quién es la instalación, sin preguntar.
#   · 8.46 — un solo sí: sin opciones, la única lectura de la terminal es «¿Instalo?», después de un plan de cinco
#           renglones (T1, T10); npx le pasa --defaults a install y las opciones de la persona llegan igual (T3); el plan
#           detallado sigue en --dry-run (T11); sin Claude Code ni Codex sale 1 con las órdenes, sin bajar nada (T12); sin
#           terminal y sin --yes sale 2 con la línea exacta, sin bajar nada, y con --yes instala la mínima (T14).
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
cp "$PKG_SRC/package.json" "$PKG_SRC/index.js" "$PKG_SRC/home-paths.json" "$PKG_SRC/README.md" "$PKG/" && cp "$RAIZ/LICENSE" "$PKG/LICENSE"
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
# el paquete siempre baja la punta (info/refs y codeload) antes de que el instalador del árbol decida: «sin instalar nada» se
# mide por las consultas a la API, que sólo hace `install` (el paquete no la usa sin permiso)
api_lines() { grep -c '"host":"api"' "$LAB_RELEASE_LOG" 2>/dev/null || true; }
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

# ══ T6 / T41 · la máquina ya instalada: mira la punta y dice «al día», sin bajar nada (el cierre, AC 35) ════════════
: > "$LAB_RELEASE_LOG"
run_npx > "$BASE/t6.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && grep -q 'al día' "$BASE/t6.out" && ! grep -q '2026.10.08.1' "$BASE/t6.out" && grep -qF "$(TYCON_DIR)/harness" "$BASE/t6.out" && [ "$(requests 'info/refs')" = 1 ] && [ "$(requests '/tar.gz/')" = 1 ] && [ "$(api_lines)" = 0 ]; then
  ok "T6/T41/8.46 T16 con el arnés ya instalado y la misma punta: dice «al día» con el lugar y sin número de versión; el paquete mira la punta y baja el árbol (info/refs y codeload, una vez) y nadie instala nada"
else no "T6 máquina instalada al día (rc $RC, info/refs $(requests 'info/refs'), tar.gz $(requests '/tar.gz/')): $(brief "$BASE/t6.out")"; fi
STATE_F="$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"
state_commit() { node -e 'try{const s=require(process.argv[1]);console.log((s.sources.find((x)=>x.name==="harness")||{}).commit||"")}catch{console.log("")}' "$STATE_F"; }
harness_lab_publish_stable 2026.10.09.1 >/dev/null 2>&1; TIP="$(harness_lab_remote_head main)"
ino() { node -e 'console.log(require("fs").statSync(process.argv[1]).ino)' "$(TYCON_DIR)/harness"; }
INO0="$(ino)"
LAB_PTY_DELAY=4 run_ix_tty n > "$BASE/t41n.out" 2>&1; RC=$?
LAB_PTY_DELAY=4 run_ix_tty '' > "$BASE/t41e.out" 2>&1; RC2=$?
if [ "$RC" -eq 0 ] && [ "$RC2" -eq 0 ] && grep -q '¿Actualizo? \[s/N\]' "$BASE/t41n.out" && grep -q 'no actualicé' "$BASE/t41n.out" && grep -q 'no actualicé' "$BASE/t41e.out" && grep -qF 'npx @tyconsa/harness@latest' "$BASE/t41n.out" && [ "$(state_commit)" != "$TIP" ] && [ "$(ino)" = "$INO0" ]; then
  ok "T41 con una versión nueva: pregunta «¿Actualizo? [s/N]»; «n» y Enter salen 0 «no actualicé» con la línea que aplica (update --yes), y el árbol instalado queda el mismo"
else no "T41 «n»/Enter (rc $RC/$RC2, inodo $INO0 → $(ino)): $(brief "$BASE/t41n.out" 400) · $(brief "$BASE/t41e.out" 200)"; fi
run_ix > "$BASE/t41t.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && grep -q 'hay una versión nueva' "$BASE/t41t.out" && ! grep -q 'Actualizo' "$BASE/t41t.out" && grep -qF 'npx @tyconsa/harness@latest' "$BASE/t41t.out" && [ "$(state_commit)" != "$TIP" ]; then
  ok "T41 sin terminal: no pregunta, dice que hay una versión nueva y cómo actualizar (npx en una terminal), sale 0"
else no "T41 sin terminal (rc $RC): $(brief "$BASE/t41t.out" 400)"; fi
# «s» con la política de FÁBRICA («ask», sin TYCON_UPDATE_APPLY): el sí tiene que aplicar, no sólo mirar (pase adversarial,
# clase 15: `update` sin --yes salía 3 sin cambiar nada); y «y» vale como sí, como en «¿Instalo?» (clase 10)
LAB_PTY_DELAY=4 harness_lab_pty s env -u TYCON_GITHUB_TOKEN -u TYCON_UPDATE_APPLY "$REAL_NODE" "$PKG/index.js" --repo "$REPO" > "$BASE/t41s.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && grep -q '¿Actualizo?' "$BASE/t41s.out" && [ "$(state_commit)" = "$TIP" ] && ! grep -q 'Para quién es\|¿Instalo?' "$BASE/t41s.out"; then
  ok "T41 con «s» y la política de fábrica: corre el update del árbol bajado y lo aplica (el estado queda en la punta nueva), sin reinstalar de cero"
else no "T41 con «s» (rc $RC, estado $(state_commit | cut -c1-7), punta ${TIP:0:7}): $(brief "$BASE/t41s.out" 500)"; fi
harness_lab_publish_stable 2026.10.09.2 >/dev/null 2>&1; TIP="$(harness_lab_remote_head main)"
LAB_PTY_DELAY=4 harness_lab_pty y env -u TYCON_GITHUB_TOKEN -u TYCON_UPDATE_APPLY "$REAL_NODE" "$PKG/index.js" --repo "$REPO" > "$BASE/t41y.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(state_commit)" = "$TIP" ]; then ok "T41 «y» vale como sí, como en «¿Instalo?»"
else no "T41 con «y» (rc $RC, estado $(state_commit | cut -c1-7), punta ${TIP:0:7}): $(brief "$BASE/t41y.out" 400)"; fi
# T42: si no pudo mirar la punta, lo dice y da la línea de update; nunca «al día» sin haberlo medido
t42() { # t42 <nombre> <descripción> <env…>
  local name="$1" what="$2" rc; shift 2
  env -u TYCON_GITHUB_TOKEN "$@" "$REAL_NODE" "$PKG/index.js" --repo "$REPO" < /dev/null > "$BASE/t42-$name.out" 2>&1; rc=$?
  # el paquete es quien mira la punta (con las dos rutas, la pública y la API): si no puede, sale 1 con la causa y nunca dice «al día»
  if [ "$rc" -eq 1 ] && grep -qE 'sin red|GitHub contestó|certificado' "$BASE/t42-$name.out" && ! grep -q 'al día' "$BASE/t42-$name.out"; then ok "T42 $what: sale 1 con la causa, sin decir «al día»"
  else no "T42 $what (rc $rc): $(brief "$BASE/t42-$name.out" 400)"; fi
}
t42 nonet 'sin red' TYCON_RELEASE_GIT=http://127.0.0.1:9 TYCON_RELEASE_API=http://127.0.0.1:9
node -e 'const s=require("http").createServer((q,r)=>{r.writeHead(500);r.end("roto")});s.listen(0,"127.0.0.1",()=>require("fs").writeFileSync(process.argv[1],String(s.address().port)))' "$BASE/500b.port" & P500B=$!
for _ in $(seq 1 30); do [ -s "$BASE/500b.port" ] && break; sleep 0.1; done
t42 five 'GitHub contesta 500' TYCON_RELEASE_GIT="http://127.0.0.1:$(cat "$BASE/500b.port")" TYCON_RELEASE_API="http://127.0.0.1:$(cat "$BASE/500b.port")"
kill "$P500B" 2>/dev/null; wait "$P500B" 2>/dev/null
cp "$STATE_F" "$BASE/state.bak"
node -e 'const f=process.argv[1],fs=require("fs");const s=JSON.parse(fs.readFileSync(f,"utf8"));s.sources=s.sources.map((x)=>Object.assign({},x,{kind:"tree"}));fs.writeFileSync(f,JSON.stringify(s,null,2))' "$STATE_F"
run_ix > "$BASE/t42clon.out" 2>&1; RC=$?
cp "$BASE/state.bak" "$STATE_F"
if [ "$RC" -eq 0 ] && grep -q 'instalado desde un clon' "$BASE/t42clon.out" && ! grep -q 'al día' "$BASE/t42clon.out" && grep -qE 'harness\.js" update' "$BASE/t42clon.out"; then ok "T42 instalado desde un clon: lo dice, con la línea de update, sin comparar"
else no "T42 desde un clon (rc $RC): $(brief "$BASE/t42clon.out" 400)"; fi
# (pase adversarial del cierre) un estado con la fuente release pero sin commit no es «un clon»: lo dice; y una versión
# {number: null} no se imprime como objeto (clases 4 y la de los fallos silenciosos)
node -e 'const f=process.argv[1],fs=require("fs");const s=JSON.parse(fs.readFileSync(f,"utf8"));s.sources=s.sources.map((x)=>x.name==="harness"?Object.assign({},x,{commit:undefined}):x);s.version={number:null,installed_at:"x"};fs.writeFileSync(f,JSON.stringify(s,null,2))' "$STATE_F"
run_ix > "$BASE/t42roto.out" 2>&1; RC=$?
cp "$BASE/state.bak" "$STATE_F"
if [ "$RC" -eq 0 ] && grep -q 'el estado no dice qué commit tiene' "$BASE/t42roto.out" && ! grep -q 'instalado desde un clon\|object Object\|al día' "$BASE/t42roto.out"; then ok "T42 un estado sin el commit instalado: lo dice (no «un clon», no «al día») y la versión vacía no sale como objeto"
else no "T42 estado sin commit (rc $RC): $(brief "$BASE/t42roto.out" 400)"; fi
# una rama que no existe en el repo del estado (un 200 de info/refs sin esa rama) dice la causa (vuelta 2 de revisores)
node -e 'const f=process.argv[1],fs=require("fs");const s=JSON.parse(fs.readFileSync(f,"utf8"));s.sources=s.sources.map((x)=>x.name==="harness"?Object.assign({},x,{ref:"otra-rama"}):x);fs.writeFileSync(f,JSON.stringify(s,null,2))' "$STATE_F"
run_ix > "$BASE/t42rama.out" 2>&1; RC=$?
cp "$BASE/state.bak" "$STATE_F"
if [ "$RC" -eq 0 ] && grep -q 'sigue .* (otra-rama)' "$BASE/t42rama.out" && ! grep -q 'al día' "$BASE/t42rama.out"; then ok "T42 una rama del estado que no es main: no se compara con la punta de main (no «al día»), con la línea de update"
else no "T42 rama que no está (rc $RC): $(brief "$BASE/t42rama.out" 300)"; fi
# un certificado que no se puede verificar al mirar la punta (un proxy de la empresa sin NODE_EXTRA_CA_CERTS) es «no pude
# mirar», con la línea de update y salida 0, como sin red (pase adversarial, clase 16)
if command -v openssl >/dev/null 2>&1 && openssl req -x509 -newkey rsa:2048 -nodes -keyout "$BASE/t42.key" -out "$BASE/t42.crt" -days 1 -subj '/CN=127.0.0.1' >/dev/null 2>&1; then
  node -e 'const fs=require("fs");const s=require("https").createServer({key:fs.readFileSync(process.argv[1]),cert:fs.readFileSync(process.argv[2])},(q,r)=>{r.writeHead(200);r.end("x")});s.listen(0,"127.0.0.1",()=>fs.writeFileSync(process.argv[3],String(s.address().port)))' "$BASE/t42.key" "$BASE/t42.crt" "$BASE/t42tls.port" & PTLS=$!
  for _ in $(seq 1 30); do [ -s "$BASE/t42tls.port" ] && break; sleep 0.1; done
  t42 cert 'certificado sin verificar' TYCON_RELEASE_GIT="https://127.0.0.1:$(cat "$BASE/t42tls.port")" TYCON_RELEASE_API=http://127.0.0.1:9
  if grep -q 'certificado' "$BASE/t42-cert.out"; then ok "T42 el certificado sin verificar se nombra como la causa"; else no "T42 la causa del certificado: $(brief "$BASE/t42-cert.out" 300)"; fi
  kill "$PTLS" 2>/dev/null; wait "$PTLS" 2>/dev/null
else echo "⏭ npx-installer: T42 (certificado) NO MEDIDO — no hay openssl para armar el certificado de juguete"; fi
# T55 (AC 47): la suite que el aplicador corre al instalar no falla sin git, tampoco con un git que existe y sale 1 (el de
# /usr/bin en una Mac sin las herramientas de línea de comandos: pase adversarial, clase 2)
mkdir -p "$LAB/git-roto-bin"; printf '#!/bin/sh\necho "xcode-select: note: No developer tools were found" >&2\nexit 1\n' > "$LAB/git-roto-bin/git"; chmod +x "$LAB/git-roto-bin/git"; ln -sf "$REAL_NODE" "$LAB/git-roto-bin/node"
LEDGER="$RAIZ/skills/tycon-pipeline/scripts/tests/advisor-ledger.test.js"
for kind in sin-git git-roto; do
  P="$LAB/git-roto-bin"; [ "$kind" = sin-git ] && { mkdir -p "$LAB/sin-git-bin"; ln -sf "$REAL_NODE" "$LAB/sin-git-bin/node"; P="$LAB/sin-git-bin"; }
  env PATH="$P" "$REAL_NODE" --test "$LEDGER" > "$BASE/t55-$kind.out" 2>&1; RC=$?
  if [ "$RC" -eq 0 ] && grep -qE '^ℹ skipped 2$|^# skip 2$' "$BASE/t55-$kind.out" && grep -q 'NO MEDIDO: sin git' "$BASE/t55-$kind.out"; then ok "T55 advisor-ledger.test.js ($kind): sale 0, con las dos pruebas que arman repos en «no medido»"
  else no "T55 advisor-ledger.test.js ($kind) (rc $RC): $(grep -E '^ℹ (pass|fail|skipped)|^# (pass|fail|skip)' "$BASE/t55-$kind.out" | tr '\n' ' ')"; fi
done
# con el arnés ya instalado, «dar de alta mi organización» no es «ya está»: corre team-init del árbol INSTALADO, sin red
# (sin terminal, el alta pide --name y sale 2: lo que mide que llegó a correr)
N0="$(api_lines)"
run_ix --audience org > "$BASE/t6org.out" 2>&1; RC=$?
if [ "$RC" -eq 2 ] && grep -q 'falta el nombre de la organización' "$BASE/t6org.out" && ! grep -q 'ya está instalado' "$BASE/t6org.out" && [ "$(api_lines)" = "$N0" ]; then
  ok "T6/T18 con el arnés ya instalado y --audience org: corre harness.js team-init del árbol bajado, sin instalar nada"
else no "T6 instalada + --audience org (rc $RC, consultas a la API $(($(api_lines) - N0))): $(brief "$BASE/t6org.out")"; fi

# ══ T2 · las opciones llegan tal cual; --dry-run no escribe ════════════════════════════════════════════════════════
harness_lab_release_fresh_home; H0="$(harness_lab_home_hash)"
run_npx --profile full --integrations none --packs all --dry-run > "$BASE/t2.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(harness_lab_home_hash)" = "$H0" ] && grep -q 'bajo ' "$BASE/t2.out" && ! grep -q 'opción desconocida' "$BASE/t2.out" && [ "$(tmp_left)" = 0 ]; then
  ok "T2 --profile full --integrations none --packs all --dry-run llegan a install tal cual (sin --) y la HOME queda idéntica"
else no "T2 opciones y --dry-run (rc $RC, HOME $([ "$(harness_lab_home_hash)" = "$H0" ] && echo igual || echo cambió)): $(brief "$BASE/t2.out" 500)"; fi

# ══ T9 · el «no» y la entrada que se termina ═══════════════════════════════════════════════════════════════════════
harness_lab_release_fresh_home
LAB_PTY_DELAY=5 run_npx_tty n --profile minimal --integrations none --packs none > "$BASE/t9.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && ! grep -q 'Para quién es' "$BASE/t9.out" && grep -q 'no se instaló nada' "$BASE/t9.out" && nothing_installed && [ "$(tmp_left)" = 0 ]; then
  ok "T9/T17 en una terminal no pregunta para quién es, y el «no» al plan sale 0 «no se instaló nada» sin arnés, sin estado y sin temporal"
else no "T9 el no (rc $RC, ~/.tycon: $(tycon_left)): $(brief "$BASE/t9.out" 500)"; fi
tycon_note "$BASE/t9.out" "el «no»"
harness_lab_release_fresh_home
LAB_PTY_DELAY=5 run_ix_tty $'\x04' --profile minimal --integrations none --packs none > "$BASE/t9b.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && grep -q 'no se instaló nada' "$BASE/t9b.out" && nothing_installed && [ "$(tmp_left)" = 0 ]; then ok "T9 la entrada que se termina en el plan: «no se instaló nada», sale 0, sin arnés ni estado"
else no "T9 entrada cerrada (rc $RC, ~/.tycon: $(tycon_left)): $(brief "$BASE/t9b.out" 400)"; fi
# para la organización (--audience org): install sale 0 SIN instalar (el «no», --dry-run) → sale 0 «no se
# instaló nada» y el alta NO arranca (no hay árbol instalado del que correrla)
harness_lab_release_fresh_home
LAB_PTY_DELAY=5 run_ix_tty n --audience org --profile minimal --integrations none --packs none > "$BASE/t9org.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && grep -q 'no se instaló nada' "$BASE/t9org.out" && nothing_installed && ! grep -q 'team-init\|nombre de la organización' "$BASE/t9org.out" && [ "$(tmp_left)" = 0 ]; then
  ok "T9/T17 con --audience org y el «no» al plan: sale 0 «no se instaló nada», sin arnés y sin arrancar el alta"
else no "T9 org + no (rc $RC, ~/.tycon: $(tycon_left)): $(brief "$BASE/t9org.out" 400)"; fi
harness_lab_release_fresh_home; H0="$(harness_lab_home_hash)"
run_ix --audience org --profile minimal --integrations none --packs none --dry-run > "$BASE/t9orgdry.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && grep -q 'no se instaló nada' "$BASE/t9orgdry.out" && [ "$(harness_lab_home_hash)" = "$H0" ] && ! grep -q 'team-init\|nombre de la organización' "$BASE/t9orgdry.out"; then
  ok "T9/T18 --audience org con --dry-run: sale 0 «no se instaló nada», la HOME igual y sin arrancar el alta"
else no "T9 --audience org --dry-run (rc $RC, HOME $([ "$(harness_lab_home_hash)" = "$H0" ] && echo igual || echo cambió)): $(brief "$BASE/t9orgdry.out" 400)"; fi

# ══ T17 / 8.46 · sin pregunta de para quién: un solo sí, después del plan corto ══════════════════════════════════════
# una HOME sin arnés y sin la configuración que dejó una instalación anterior del laboratorio
# y sin el perfil del equipo del laboratorio (fija full): una máquina de afuera, sin equipo
fresh846() { harness_lab_release_fresh_home; rm -f "$LAB_HOME/.claude/tycon.json"; }
PROFILE_BEFORE_846="${TYCON_PROFILE-}"; export TYCON_PROFILE=0
# (T1, T10) sin opciones, con terminal: no pregunta nada salvo «¿Instalo?», y antes muestra los cinco renglones
fresh846; : > "$LAB_RELEASE_LOG"
LAB_PTY_DELAY=5 run_ix_tty n > "$BASE/t17a.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && ! grep -q 'Para quién es' "$BASE/t17a.out" && ! grep -q 'Elegí 1, 2' "$BASE/t17a.out" && ! grep -q 'integraciones prendo' "$BASE/t17a.out" \
   && ! grep -q 'paquete del stack en todos' "$BASE/t17a.out" && [ "$(grep -o '¿Instalo? \[s/N\]' "$BASE/t17a.out" | wc -l | tr -d ' ')" = 1 ] && grep -q 'no se instaló nada' "$BASE/t17a.out" && nothing_installed && [ "$(tmp_left)" = 0 ]; then
  ok "8.46 T1/T10 sin opciones: ninguna pregunta salvo «¿Instalo?»; el «no» sale 0 sin arnés ni temporal"
else no "8.46 T1/T10 sin opciones (rc $RC): $(brief "$BASE/t17a.out" 500)"; fi
PLAN5="$(python3 - "$BASE/t17a.out" <<'PY'
import re,sys
t=re.sub(r'\x1b\[[0-9;?]*[A-Za-z]','',open(sys.argv[1],encoding='utf-8',errors='replace').read()).replace('\r','')
lines=t.split('\n'); i=next((k for k,l in enumerate(lines) if '¿Instalo?' in l),-1)
j=next((k for k,l in enumerate(lines) if l.startswith('Instalo el arnés')),-1)
print('ok' if j>=0 and i-j==5 and 'mínima' in lines[j+1] and 'harness.js uninstall' in lines[j+4] else f'j={j} i={i} {lines[max(j,0):i+1]}')
PY
)"
[ "$PLAN5" = ok ] && ok "8.46 T10 el plan son cinco renglones justo antes de «¿Instalo?» (qué y dónde … cómo sacarlo)" || no "8.46 T10 el plan corto: $PLAN5"
LAB_PTY_DELAY=5 run_ix_tty s > "$BASE/t10s.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && installed_ok && [ "$(node -e 'try{console.log(require(process.argv[1]).install.profile)}catch{console.log("")}' "$LAB_HOME/.claude/tycon.json")" = minimal ]; then ok "8.46 T10 con «s», el único sí: instala la mínima"
else no "8.46 T10 el sí (rc $RC, estado $(estado_kind)): $(brief "$BASE/t10s.out" 400)"; fi
# (8.54 T7, el camino de la versión bajada) la primera instalación deja first_install fresca en el estado
FI854="$(node -e 'try{const f=require(process.argv[1]).first_install;console.log(f&&f.fresh===true&&f.version?"ok":JSON.stringify(f))}catch(e){console.log("sin-estado")}' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json" 2>/dev/null)"
[ "$FI854" = ok ] && ok "8.54 T7 con la versión bajada: el estado nuevo trae first_install fresca, con su versión" || no "8.54 T7 first_install con la versión bajada: ${FI854}"
# (T3) npx pasa --defaults y las opciones de la persona llegan: --packs all sin --profile, sin terminal con --yes
fresh846
run_ix --packs all --yes > "$BASE/t3.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && installed_ok && [ "$(node -e 'try{const c=require(process.argv[1]);console.log(c.install.profile+" "+c.packs.default)}catch{console.log("")}' "$LAB_HOME/.claude/tycon.json")" = "minimal all" ]; then
  ok "8.46 T3/T14 sin terminal con --yes: instala la mínima por defecto sin pedir --profile, y --packs all llega a install"
else no "8.46 T3 --defaults y las opciones (rc $RC): $(brief "$BASE/t3.out" 400)"; fi
# (T11) el plan detallado sigue en --dry-run
fresh846; H0="$(harness_lab_home_hash)"
run_ix --dry-run > "$BASE/t11.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && grep -q 'se instalaría la versión' "$BASE/t11.out" && grep -q 'herramientas a enchufar' "$BASE/t11.out" && grep -q 'perfil: minimal (por defecto' "$BASE/t11.out" && [ "$(harness_lab_home_hash)" = "$H0" ]; then
  ok "8.46 T11 --dry-run muestra el plan detallado (con la mínima por defecto) y no escribe"
else no "8.46 T11 --dry-run (rc $RC): $(brief "$BASE/t11.out" 400)"; fi
# (T14) sin terminal y sin --yes (las URL con credencial se arman con ${A}: escrita entera, el freno de publicación la lee como un correo): 2 con la línea exacta, sin bajar nada
fresh846; : > "$LAB_RELEASE_LOG"
run_ix --packs none > "$BASE/t14.out" 2>&1; RC=$?
if [ "$RC" -eq 2 ] && grep -qF "corré npx @tyconsa/harness@latest --repo $REPO --packs none --yes" "$BASE/t14.out" && [ "$(api_lines)" = 0 ] && [ ! -d "$(TYCON_DIR)" ]; then
  ok "8.46 T14 sin terminal ni --yes: sale 2 con la línea exacta (con las opciones que vinieron), sin bajar nada"
else no "8.46 T14 sin terminal (rc $RC, pedidos $(log_lines)): $(brief "$BASE/t14.out" 400)"; fi
A="@"; run_ix --team "https://persona:CREDENCIAL-DE-LAB${A}dev.azure.com/acme/proy/_git/perfil" > "$BASE/t14red.out" 2>&1; RC=$?
if [ "$RC" -eq 2 ] && ! grep -q 'CREDENCIAL-DE-LAB' "$BASE/t14red.out" && grep -qF -- '--team https://dev.azure.com/acme/proy/_git/perfil' "$BASE/t14red.out"; then ok "8.46 T14 la línea exacta no repite la credencial de una URL"
else no "8.46 T14 la línea con una URL con credencial (rc $RC): $(brief "$BASE/t14red.out" 300)"; fi
run_ix "--team=https://persona:CLAVE${A}CON-ARROBA${A}dev.azure.com/acme/proy/_git/perfil" > "$BASE/t14eq.out" 2>&1; RC=$?
run_ix --team "HTTPS://persona:CLAVE-MAYUS${A}github.com/acme/perfil" --packs "it's" > "$BASE/t14may.out" 2>&1; RC2=$?
run_ix --repo "https://persona:CLAVE-REPO${A}github.com/acme/arnes" > "$BASE/t14repo.out" 2>&1; RC3=$?
if ! grep -q 'CLAVE' "$BASE/t14eq.out" && [ "$RC" -eq 2 ] && grep -qF 'https://dev.azure.com/acme/proy/_git/perfil' "$BASE/t14eq.out" \
   && ! grep -q 'CLAVE-REPO' "$BASE/t14repo.out" && [ "$RC3" -eq 2 ] && grep -qF 'https://github.com/acme/arnes' "$BASE/t14repo.out" \
   && ! grep -q 'CLAVE-MAYUS' "$BASE/t14may.out" && [ "$RC2" -eq 2 ] && grep -qF "'it'\\''s'" "$BASE/t14may.out"; then ok "8.46 T14 tampoco con --team=URL, una clave con @ o el esquema en mayúsculas; una comilla simple queda bien entrecomillada"
else no "8.46 T14 credencial en --team=URL, --repo o mayúsculas (rc $RC/$RC2/$RC3): $(brief "$BASE/t14eq.out" 200) | $(brief "$BASE/t14may.out" 200)"; fi
# (T12) sin Claude Code ni Codex: 1 con las órdenes, sin bajar nada; con --tool no se mira
harness_lab_tools none; harness_lab_tools_fresh_home; fresh846; : > "$LAB_RELEASE_LOG"
run_ix --yes > "$BASE/t12.out" 2>&1; RC=$?
if [ "$RC" -eq 1 ] && grep -q 'no encontré Claude Code ni Codex' "$BASE/t12.out" && grep -qF 'https://claude.ai/install' "$BASE/t12.out" && grep -qF 'chatgpt.com/codex/install' "$BASE/t12.out" && [ "$(api_lines)" = 0 ] && [ ! -d "$(TYCON_DIR)" ]; then
  ok "8.46 T12 sin agente de código: sale 1 con las órdenes de Claude Code y Codex, sin bajar nada"
else no "8.46 T12 sin agente (rc $RC, pedidos $(log_lines)): $(brief "$BASE/t12.out" 400)"; fi
run_ix --tool codex --dry-run > "$BASE/t12tool.out" 2>&1; RC=$?
if ! grep -q 'no encontré Claude Code ni Codex' "$BASE/t12tool.out" || [ "$(log_lines)" -gt 0 ]; then ok "8.46 T12 con --tool, npx no mira: lo decide install"
else no "8.46 T12 con --tool (rc $RC): $(brief "$BASE/t12tool.out" 300)"; fi
harness_lab_tools claude; harness_lab_release_fresh_home
if [ -n "$PROFILE_BEFORE_846" ]; then export TYCON_PROFILE="$PROFILE_BEFORE_846"; else unset TYCON_PROFILE; fi
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
if [ "$RC" -eq 1 ] && grep -q "$ORG/example-team" "$BASE/t4team.out" && grep -q 'github.com/settings/' "$BASE/t4team.out" && [ "$(api_lines)" = 0 ] && [ "$(requests '/tarball/')" = 0 ] && [ ! -d "$(TYCON_DIR)" ]; then
  ok "T4 con --team a un repo del equipo que no se lee, sin terminal: sale 1 nombrándolo con la acción, ANTES de bajar nada"
else no "T4 --team privado sin permiso (rc $RC, tar.gz $(requests '/tar.gz/')): $(brief "$BASE/t4team.out" 400)"; fi
harness_lab_release_fresh_home; : > "$LAB_RELEASE_LOG"
env TYCON_GITHUB_TOKEN="$TEAM_PERM" "$REAL_NODE" "$PKG/index.js" --repo "$REPO" --team example-org/example-team --profile minimal --yes < /dev/null > "$BASE/t17b.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && grep -q 'example-team' "$LAB_RELEASE_LOG" && ! grep -qF 'permiso-del-equipo-de-laboratorio' "$BASE/t17b.out"; then
  ok "T17 --team lanza install --team (el juguete anota las consultas al repo del equipo); el permiso no sale en pantalla"
else no "T17 --team (rc $RC; consultas al equipo $(requests 'example-team')): $(brief "$BASE/t17b.out" 500)"; fi
if [ "$(node -e 'try{const s=require(process.argv[1]);console.log(s.team?s.team.repo:"")}catch{console.log("")}' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json")" = "$ORG/example-team" ]; then ok "T17 la máquina quedó con la capa del equipo apilada (estado team)"
else no "T17 el estado no tiene la capa del equipo: $(node -e 'try{const s=require(process.argv[1]);console.log(JSON.stringify(s.team))}catch(e){console.log(e.message)}' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json")"; fi
# clase 2 de la 8.40: --team acepta la URL de GitHub, no sólo org/repo
harness_lab_release_fresh_home; : > "$LAB_RELEASE_LOG"
env TYCON_GITHUB_TOKEN="$TEAM_PERM" "$REAL_NODE" "$PKG/index.js" --repo "$REPO" --team https://github.com/example-org/example-team.git --profile minimal --dry-run < /dev/null > "$BASE/t17url.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && grep -q 'example-team' "$LAB_RELEASE_LOG" && ! grep -q 'tiene que ser' "$BASE/t17url.out"; then ok "T17 (clase 2) --team con la URL de GitHub del repo del perfil se acepta"
else no "T17 URL de GitHub en --team (rc $RC): $(brief "$BASE/t17url.out" 400)"; fi
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
if [ "$RC" -eq 1 ] && grep -q "hasta las $HORA_T" "$BASE/t4teamlimit.out" && [ "$(requests '/tar.gz/')" = 0 ] && [ "$(requests '/tarball/')" = 0 ] && [ ! -d "$(TYCON_DIR)" ]; then
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
if [ "$DOTS_OK" = 1 ] && [ "$(api_lines)" = 0 ] && [ ! -d "$(TYCON_DIR)" ]; then ok "T1 --repo/--team con un segmento «.» o «..» (GitHub y Azure) salen 2 sin tocar la red"
else no "T1 segmentos de puntos (pedidos $(log_lines)):$DOTS_BAD"; fi
# la cadena completa install → alta, con el nombre CONTESTADO en la terminal: --audience org instala y el alta
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
# la última respuesta («no») es la del repo de historias, que el alta pregunta al final (el cierre, AC 38)
chain org $'acme-org\ngithub\nacme/harness-team-profile\n'"$BASE/perfil-org"$'\nn\nno' --audience org

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
if [ "$RC" -eq 1 ] && grep -q "falta tar.*$WANT" "$BASE/t8.out" && grep -q 'no lo corro' "$BASE/t8.out" && [ ! -e "$PKG_CALLS" ] && [ "$(api_lines)" = 0 ] && [ "$(harness_lab_home_hash)" = "$H0" ]; then
  ok "T8 sin tar: sale 1 nombrándolo con su comando sugerido, sin correrlo, sin bajar nada y con la HOME igual"
else no "T8 sin tar (rc $RC, gestores: $(cat "$PKG_CALLS" 2>/dev/null | tr '\n' ' ')): $(brief "$BASE/t8.out" 400)"; fi

# ══ T7b · lo que el instalador lanza y lo que lee de la máquina: nada se calla ════════════════════════════════════════
# un estado del arnés que está pero no se lee: no es «sin arnés» — avisa y sale 1, sin instalar encima
harness_lab_release_fresh_home; : > "$LAB_RELEASE_LOG"
mkdir -p "$LAB_HOME/.claude/.tycon-pipeline" && printf '{ "tree": "cortado' > "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"
run_ix --profile minimal --yes > "$BASE/t7state.out" 2>&1; RC=$?
if [ "$RC" -eq 1 ] && grep -q 'harness-state.json' "$BASE/t7state.out" && grep -q 'no se lee' "$BASE/t7state.out" && [ "$(api_lines)" = 0 ] && [ ! -e "$(TYCON_DIR)/harness" ]; then
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
