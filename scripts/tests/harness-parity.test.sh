#!/usr/bin/env bash
# harness-parity.test.sh — red del PRODUCTOR de la paridad de instalación Claude↔Codex.
#
# Los casos del banco (08-bench-notice) prueban al CONSUMIDOR del reporte; esta red prueba a
# quien lo produce: que las superficies den rojo cuando la máquina está rota, verde cuando no
# hay nada que medir, y que un crash de insumos sea un ROJO reportado y no una auditoría muerta.
# Sin esto, una superficie que se rompa y devuelva siempre ok:true queda verde para siempre —
# el "control que nadie controla" que la Etapa H existe para cerrar.
#
# Corre en la pasada diaria del instalador (BASH_TESTS). Manual: bash scripts/tests/harness-parity.test.sh

set -uo pipefail
TCG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PARITY="$TCG/scripts/lib/harness-parity.js"

# 🔴 TODOS los runParity de esta red escriben su reporte en un bench de LABORATORIO: si escribieran
# al .bench real, (a) correrían una carrera con el nohup de paridad del mismo
# arranque, (b) un Ctrl-C entre el lab y la restauración dejaría rojos FABRICADOS cobrándose
# como reales en cada arranque siguiente. El trap limpia pase lo que pase.
BENCHLAB="$(mktemp -d)"
export TYCON_PARITY_BENCH_DIR="$BENCHLAB"
trap 'rm -rf "$BENCHLAB"' EXIT

# 🔴 AISLAMIENTO DE LA LLAVE. Los labs de esta red simulan una máquina ROTA con un
# HOME vacío; si heredaran `TYCON_CODEX` del shell REAL, la superficie `llave-en-rc` daría
# verde si la llave está activa "por un mecanismo propio" (fish/direnv/sourced) aunque no haya
# rc. O sea: en la máquina de un dev con el lado Codex desplegado, el lab NO estaría roto y el
# caso "máquina rota → 🔴 llave-en-rc" fallaría por un motivo falso, dejando la suite en rojo
# permanente y sin señal útil (con la llave desactivada, la misma red da todo
# verde sin tocar el producto). Un rojo que no significa nada es peor que ninguno: se aprende
# a ignorarlo, y con él se ignora el rojo del día en que sí importe.
# El disparador de la auditoría NO es esta llave sino la evidencia de despliegue en
# CODEX_HOME (ver la cabecera de scripts/lib/harness-parity.js), así que desactivarla acá no
# le saca alcance a ningún caso.
unset TYCON_CODEX

fallos=0
ok()  { echo "✅ $1"; }
bad() { echo "❌ $1 — $2"; fallos=$((fallos+1)); }

# ── 1. Máquina SIN lado Codex → "no desplegado", 0 rojos, exit 0 ─────────────────────────────
LAB=$(mktemp -d); mkdir -p "$LAB/codex"
OUT=$(HOME="$LAB" CODEX_HOME="$LAB/codex" node "$PARITY" 2>&1); RC=$?
[ $RC -eq 0 ] && ok "sin despliegue → exit 0" || bad "sin despliegue → exit 0" "exit=$RC"
case "$OUT" in *"NO tiene el lado Codex desplegado"*) ok "sin despliegue → lo dice";; *) bad "sin despliegue → lo dice" "$OUT";; esac
rm -rf "$LAB"

# ── 2. Máquina rota a propósito → superficies concretas en ROJO y exit 1 ─────────────────────
# CODEX_HOME con hooks.json vacío (dispara "desplegado") y nada más; HOME de laboratorio sin rc.
LAB=$(mktemp -d); mkdir -p "$LAB/codex"; echo '{"hooks":{}}' > "$LAB/codex/hooks.json"
OUT=$(HOME="$LAB" CODEX_HOME="$LAB/codex" node "$PARITY" 2>&1); RC=$?
[ $RC -eq 1 ] && ok "máquina rota → exit 1" || bad "máquina rota → exit 1" "exit=$RC"
for surf in hooks skills writable-roots llave-en-rc; do
  case "$OUT" in *"🔴 $surf"*) ok "máquina rota → 🔴 $surf";; *) bad "máquina rota → 🔴 $surf" "no apareció";; esac
done
# El reporte se escribió (en el bench de laboratorio) con deployed:true y su kind.
grep -q '"deployed": true' "$BENCHLAB/harness-parity.json" \
  && ok "reporte escrito con deployed:true" || bad "reporte escrito" "no está o dice otra cosa"
grep -q '"kind": "harness-parity"' "$BENCHLAB/harness-parity.json" \
  && ok "el reporte declara su kind" || bad "kind del reporte" "falta"
rm -rf "$LAB"

# ── 3. Insumo CORRUPTO → rojo con causa, no auditoría muerta ─────────────────────────────────
LAB=$(mktemp -d); mkdir -p "$LAB/codex"; printf '{esto no es json' > "$LAB/codex/hooks.json"
OUT=$(HOME="$LAB" CODEX_HOME="$LAB/codex" node "$PARITY" 2>&1); RC=$?
[ $RC -eq 1 ] && ok "hooks.json corrupto → exit 1 (no crash)" || bad "hooks.json corrupto" "exit=$RC · $(echo "$OUT" | head -1)"
case "$OUT" in *"ilegible"*) ok "hooks.json corrupto → la causa se reporta";; *) bad "causa reportada" "$(echo "$OUT" | head -3)";; esac
rm -rf "$LAB"

# ── 3c. T69: la tabla de Codex se compara con las filas de la herramienta de horas ELEGIDA ─────────────────────────────
# Las filas de cada herramienta viven en su integración; con otra elegida (o ninguna), su servidor no se registra y la
# tabla tampoco lo nombra: no es un «fantasma». Con la suya elegida y registrada, no queda «oculto».
TT_ONE="$(node -e 'const I=require(process.argv[1]);const fs=require("fs");const ms=I.listManifests({dir:process.argv[2]}).manifests.filter((m)=>m.kind==="timeTracking"&&fs.existsSync(process.argv[2]+"/"+m.name+"/tool-names.codex.md"));console.log(ms.length?ms[0].name:"")' "$TCG/scripts/lib/integrations.js" "$TCG/integrations")"
LAB=$(mktemp -d); mkdir -p "$LAB/codex"; echo '{"hooks":{}}' > "$LAB/codex/hooks.json"
OUT=$(HOME="$LAB" CODEX_HOME="$LAB/codex" TYCON_TIME_TRACKING=none node "$PARITY" 2>&1)
case "$OUT" in *"NO registrados"*"$TT_ONE"*) bad "T69 con ninguna elegida, la tabla no promete ${TT_ONE}" "$(echo "$OUT" | grep -m1 'tabla-vs-realidad')" ;; *) [ -n "$TT_ONE" ] && ok "T69 con ninguna herramienta elegida, la tabla de Codex no promete el servidor de ${TT_ONE}" || bad "T69" "ninguna integración trae tool-names.codex.md" ;; esac
printf '[mcp_servers]\n\n[mcp_servers.%s]\ncommand = "x"\nargs = []\n' "$TT_ONE" > "$LAB/codex/config.toml"
OUT=$(HOME="$LAB" CODEX_HOME="$LAB/codex" TYCON_TIME_TRACKING="$TT_ONE" node "$PARITY" 2>&1)
case "$OUT" in *"que la tabla no nombra"*"$TT_ONE"*) bad "T69 con ${TT_ONE} elegida y registrada, la tabla la nombra" "$(echo "$OUT" | grep -m1 'tabla-vs-realidad')" ;; *) ok "T69 con ${TT_ONE} elegida y registrada, la tabla de Codex la nombra" ;; esac
# Registrada pero con ninguna elegida: la integración está apagada, sus reglas no corren y el despliegue deja la tabla
# del servidor como estaba. No es un servidor «oculto».
OUT=$(HOME="$LAB" CODEX_HOME="$LAB/codex" TYCON_TIME_TRACKING=none node "$PARITY" 2>&1)
case "$OUT" in *"que la tabla no nombra"*"$TT_ONE"*) bad "T69 con ${TT_ONE} registrada y apagada, no cuenta como oculta" "$(echo "$OUT" | grep -m1 'tabla-vs-realidad')" ;; *) ok "T69 con ${TT_ONE} registrada y apagada, no cuenta como oculta" ;; esac
rm -rf "$LAB"

# ── 3d. T70: el índice de código sin instalar no es un servidor «fantasma» ───────────────────────────────────────────
# El despliegue registra codebase_memory sólo si su programa está en el PATH: la fila de la tabla lo dice.
LAB=$(mktemp -d); mkdir -p "$LAB/codex"; echo '{"hooks":{}}' > "$LAB/codex/hooks.json"
OUT=$(HOME="$LAB" CODEX_HOME="$LAB/codex" TYCON_TIME_TRACKING=none node "$PARITY" 2>&1)
case "$(echo "$OUT" | grep -m1 'tabla-vs-realidad')" in *"NO registrados"*codebase_memory*) bad "T70 sin codebase_memory registrado, la tabla no lo promete" "$(echo "$OUT" | grep -m1 'tabla-vs-realidad')" ;; *) ok "T70 sin codebase_memory registrado, la tabla no lo promete" ;; esac
rm -rf "$LAB"

# ── 3b. T25: la paridad mide POR HERRAMIENTA ENCHUFADA ─────────
# Una máquina que sólo enchufa a Codex no puede dar rojo por piezas de Claude Code que no tiene (ni su CLAUDE.md, ni su
# ~/.claude.json, ni la llave en el rc): la paridad mide cada herramienta por separado.
# Con las dos enchufadas se miden las dos: un ~/.claude.json roto sí es un rojo.
# El laboratorio es una máquina sana de verdad: los desplegadores reales corren contra un CODEX_HOME de juguete.
LAB=$(mktemp -d); mkdir -p "$LAB/.codex" "$LAB/.tycon/state"
lab() { HOME="$LAB" USERPROFILE="$LAB" CODEX_HOME="$LAB/.codex" TYCON_PROFILE=0 "$@"; }
printf '{ "tools": ["codex"], "tree": "%s" }\n' "$TCG" > "$LAB/.tycon/state/harness-state.json"
lab node "$TCG/build/deploy-codex-all.js" --force >/dev/null 2>&1
lab node "$TCG/scripts/setup/agents-md-blocks.js" >/dev/null 2>&1
OUT=$(lab node "$PARITY" 2>&1); RC=$?
case "$OUT" in *"esta máquina no enchufa a Claude Code"*) ok "T25 sólo Codex → el reporte dice que mide sólo a Codex";; *) bad "T25 sólo Codex → lo dice" "$(echo "$OUT" | head -2)";; esac
for surf in agents-md llave-en-rc writable-roots mcp hooks skills; do
  case "$OUT" in *"✅ $surf"*) ok "T25 sólo Codex → ✅ $surf";; *) bad "T25 sólo Codex → ✅ $surf" "$(echo "$OUT" | grep " $surf" | head -1)";; esac
done
case "$OUT" in *CLAUDE.md*|*.claude.json*|*"TYCON_CODEX=1 NO está"*) bad "T25 sólo Codex → no pide piezas de Claude" "$(echo "$OUT" | grep -E 'CLAUDE.md|claude.json|TYCON_CODEX' | head -2)";; *) ok "T25 sólo Codex → no pide ninguna pieza de Claude Code";; esac
[ ! -e "$LAB/.claude" ] && ok "T25 sólo Codex → medir no crea nada en la carpeta de Claude Code" || bad "T25 medir creó ~/.claude" "$(ls -A "$LAB/.claude" | head -3)"
grep -q '"tools"' "$BENCHLAB/harness-parity.json" && ok "T25 el reporte dice qué herramientas midió" || bad "T25 herramientas en el reporte" "falta"
# T25b · una raíz de escritura que pasa por un enlace deja a Codex sin shell («symlinked writable roots are
# not supported»: rechaza TODOS los comandos y no lo dice al arrancar). Es lo que deja la mudanza a ~/.tycon: la carpeta
# vieja del estado pasa a ser un enlace al estado nuevo y, si sigue en writable_roots al lado de la ruta real, esta
# superficie se pone roja nombrándola y el desplegador la saca.
# 🔴 Sin el arreglo, la superficie da ✅ y el desplegador dice «sin cambios».
CFG="$LAB/.codex/config.toml"
add_root() { node -e 'const fs=require("fs");const [f,r]=process.argv.slice(1);const t=fs.readFileSync(f,"utf8");const n=t.replace(/^(\s*writable_roots\s*=\s*\[)/m,(m)=>m+JSON.stringify(r)+", ");if(n===t)process.exit(3);fs.writeFileSync(f,n)' "$CFG" "$1"; }
has_root() { node -e 'const D=require(process.argv[1]);process.exit(D.writableRootsHas(require("fs").readFileSync(process.argv[2],"utf8"),process.argv[3])?0:1)' "$TCG/build/deploy-codex-mcp.js" "$CFG" "$1"; }
mkdir -p "$LAB/.claude" "$LAB/otra"; ln -s "$LAB/.tycon/state" "$LAB/.claude/.tycon-pipeline"; ln -s "$LAB/otra" "$LAB/del-dev"
add_root "$LAB/.claude/.tycon-pipeline" && has_root "$LAB/.claude/.tycon-pipeline" && ok "T25b la carpeta vieja (un enlace al estado) quedó en writable_roots, como tras la mudanza" || bad "T25b no pude armar el caso" "$(grep writable_roots "$CFG")"
OUT=$(lab node "$PARITY" 2>&1); RC=$?
case "$OUT" in *"🔴 writable-roots"*"$LAB/.claude/.tycon-pipeline pasa por un enlace"*"TODOS los comandos de shell"*"es del arnés"*) ok "T25b una raíz del arnés que pasa por un enlace → 🔴 writable-roots, la nombra y dice cómo se arregla";; *) bad "T25b raíz con enlace → 🔴 writable-roots" "$(echo "$OUT" | grep writable-roots | head -1)";; esac
[ $RC -eq 1 ] && ok "T25b …y exit 1" || bad "T25b exit con la raíz enlazada" "exit=$RC"
OUT=$(lab node "$TCG/build/deploy-codex-mcp.js" 2>&1)
case "$OUT" in *"saqué $LAB/.claude/.tycon-pipeline de writable_roots"*) ok "T25b el desplegador la saca y lo dice";; *) bad "T25b el desplegador no la sacó" "$(echo "$OUT" | tail -2)";; esac
! has_root "$LAB/.claude/.tycon-pipeline" && has_root "$LAB/.tycon/state" && ok "T25b queda sólo la ruta real del estado" || bad "T25b writable_roots tras el desplegador" "$(grep writable_roots "$CFG")"
OUT=$(lab node "$PARITY" 2>&1)
case "$OUT" in *"✅ writable-roots"*) ok "T25b después del desplegador → ✅ writable-roots";; *) bad "T25b ✅ tras el desplegador" "$(echo "$OUT" | grep writable-roots | head -1)";; esac
OUT=$(lab node "$TCG/build/deploy-codex-mcp.js" 2>&1)
case "$OUT" in *"sin cambios"*) ok "T25b el desplegador es idempotente";; *) bad "T25b segunda pasada del desplegador" "$(echo "$OUT" | tail -1)";; esac
# una raíz AJENA (del dev) con enlace: el desplegador no la toca y avisa; la superficie la marca y dice que no es del arnés
add_root "$LAB/del-dev"
OUT=$(lab node "$TCG/build/deploy-codex-mcp.js" 2>&1)
has_root "$LAB/del-dev" && case "$OUT" in *"⚠"*"$LAB/del-dev"*"no es del arnés"*) true;; *) false;; esac && ok "T25b una raíz ajena con enlace no se toca, y el desplegador avisa" || bad "T25b raíz ajena" "$(echo "$OUT" | tail -2)"
OUT=$(lab node "$PARITY" 2>&1)
case "$OUT" in *"🔴 writable-roots"*"$LAB/del-dev pasa por un enlace"*"no es del arnés"*) ok "T25b …y la superficie la marca en rojo diciendo que no es del arnés";; *) bad "T25b raíz ajena → 🔴" "$(echo "$OUT" | grep writable-roots | head -1)";; esac
# se deja el laboratorio como estaba para lo que sigue: sin la raíz ajena ni la carpeta de Claude Code
node -e 'const fs=require("fs");const D=require(process.argv[1]);const f=process.argv[2];fs.writeFileSync(f,D.dropWritableRoot(fs.readFileSync(f,"utf8"),process.argv[3]))' "$TCG/build/deploy-codex-mcp.js" "$CFG" "$LAB/del-dev"
rm -rf "$LAB/.claude" "$LAB/del-dev" "$LAB/otra"
OUT=$(lab node "$PARITY" 2>&1)
case "$OUT" in *"✅ writable-roots"*) ok "T25b el laboratorio vuelve a ✅ writable-roots";; *) bad "T25b laboratorio sin restaurar" "$(echo "$OUT" | grep writable-roots | head -1)";; esac
# un ~/.claude.json roto: con sólo Codex no es problema de esta máquina; con las dos, es un rojo
printf '{ roto' > "$LAB/.claude.json"
OUT=$(lab node "$PARITY" 2>&1)
case "$OUT" in *"claude.json"*) bad "T25 sólo Codex → un ~/.claude.json roto no es su problema" "$(echo "$OUT" | grep claude.json | head -1)";; *) ok "T25 sólo Codex → un ~/.claude.json roto no da rojo";; esac
printf '{ "tools": ["claude", "codex"], "tree": "%s" }\n' "$TCG" > "$LAB/.tycon/state/harness-state.json"
OUT=$(lab node "$PARITY" 2>&1); RC=$?
case "$OUT" in *"🔴 insumos"*"claude.json"*) ok "T25 con las dos → el ~/.claude.json roto es un rojo";; *) bad "T25 con las dos → rojo por ~/.claude.json" "$(echo "$OUT" | grep -i insumos | head -1)";; esac
case "$OUT" in *"esta máquina no enchufa a Claude Code"*) bad "T25 con las dos → dice que mide sólo a Codex" "";; *) ok "T25 con las dos → se miden las dos";; esac
[ $RC -eq 1 ] && ok "T25 con las dos y un insumo roto → exit 1" || bad "T25 exit con insumo roto" "exit=$RC"
# el estado dice que NO enchufa a Codex: nada que medir, aunque haya quedado algo desplegado
printf '{ "tools": ["claude"], "tree": "%s" }\n' "$TCG" > "$LAB/.tycon/state/harness-state.json"
OUT=$(lab node "$PARITY" 2>&1); RC=$?
[ $RC -eq 0 ] && case "$OUT" in *"no enchufa a Codex"*) true;; *) false;; esac && ok "T25 el estado sin Codex → 0 superficies, exit 0, y lo dice" || bad "T25 estado sin Codex" "exit=$RC · $(echo "$OUT" | head -1)"
rm -rf "$LAB"

# ── 4. El reporte REAL nunca se tocó: los labs escriben en su propio bench ───────────────────
# (la aserción es la ausencia de efecto: si el real cambió durante esta red, el aislamiento
# está roto — el modo de falla que deja rojos de laboratorio sonando como reales)

# ── 4b. T48: dónde vive el reporte de paridad ──────────────────────────────────
# En un clon, donde siempre (.bench/ del árbol, que git ignora). En una versión BAJADA (el árbol trae .tycon-release.json)
# el árbol es de sólo lectura para la máquina: el reporte va a la carpeta del estado (<estado>/controls-bench/), si no
# `doctor` lo cuenta como «de más» y la próxima actualización lo pierde.
# TYCON_PARITY_BENCH_DIR explícita gana siempre. Se mide con una copia suelta de las dos piezas, nunca con el árbol real.
LAB=$(mktemp -d); LAB="$(cd "$LAB" && pwd -P)"   # la ruta real: la pieza resuelve su propia carpeta sin enlaces (/var → /private/var en macOS)
mkdir -p "$LAB/tree/scripts/lib" "$LAB/tree/scripts/setup/harness" "$LAB/home/.tycon/state"
cp "$PARITY" "$LAB/tree/scripts/lib/"; cp "$TCG/scripts/setup/harness/tycon-home.js" "$LAB/tree/scripts/setup/harness/"
donde() { ( unset TYCON_PARITY_BENCH_DIR; HOME="$LAB/home" USERPROFILE="$LAB/home" TYCON_HOME="$LAB/home/.tycon" "$@" node "$LAB/tree/scripts/lib/harness-parity.js" --report-path ); }
OUT=$(donde env)
[ "$OUT" = "$LAB/tree/scripts/controls-bench/.bench/harness-parity.json" ] && ok "T48 en un clon el reporte va a .bench/ del árbol" || bad "T48 clon → .bench" "$OUT"
# la versión bajada: el árbol trae su manifiesto y la máquina vive en ~/.tycon (su estado está ahí, como deja install --version o la mudanza)
printf '{ "version": "2030.01.01.1", "files": [] }\n' > "$LAB/tree/.tycon-release.json"
printf '{ "schema": 1, "mode": "managed", "tree": "%s" }\n' "$LAB/tree" > "$LAB/home/.tycon/state/harness-state.json"
OUT=$(donde env)
[ "$OUT" = "$LAB/home/.tycon/state/controls-bench/harness-parity.json" ] && ok "T48 en una versión bajada el reporte va a la carpeta del estado" || bad "T48 release → estado" "$OUT"
OUT=$(donde env TYCON_PARITY_BENCH_DIR="$LAB/otro")
[ "$OUT" = "$LAB/otro/harness-parity.json" ] && ok "T48 TYCON_PARITY_BENCH_DIR explícita gana" || bad "T48 variable explícita" "$OUT"
# y el que lo cobra (bench-notice) resuelve la misma ruta por la misma pieza
OUT=$( unset TYCON_PARITY_BENCH_DIR; cd "$LAB/tree" && HOME="$LAB/home" USERPROFILE="$LAB/home" TYCON_HOME="$LAB/home/.tycon" node -e 'const p=require("./scripts/lib/harness-parity.js"); process.stdout.write(p.reportPath())')
[ "$OUT" = "$LAB/home/.tycon/state/controls-bench/harness-parity.json" ] && ok "T48 reportPath() exportada para el que cobra el rojo" || bad "T48 reportPath()" "$OUT"
# …y lo COBRA: bench-notice en un árbol bajado (scripts/ entero, sin .bench/, que git ignora y la bajada no trae) lee el
# reporte rojo de la carpeta del estado (sin esto, sale antes de leerlo porque .bench/ no existe)
rm -rf "$LAB/tree/scripts"; cp -R "$TCG/scripts" "$LAB/tree/scripts"; rm -rf "$LAB/tree/scripts/controls-bench/.bench"
mkdir -p "$LAB/home/.tycon/state/controls-bench"
printf '{ "kind": "harness-parity", "deployed": true, "ts": "%s", "reds": 2, "surfaces": [ { "name": "hooks", "ok": false }, { "name": "mcp", "ok": false } ] }\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LAB/home/.tycon/state/controls-bench/harness-parity.json"
OUT=$( unset TYCON_PARITY_BENCH_DIR TYCON_BENCH_DIR; HOME="$LAB/home" USERPROFILE="$LAB/home" TYCON_HOME="$LAB/home/.tycon" TYCON_PROFILE=0 node "$LAB/tree/scripts/hooks/bench-notice.js" 2>&1 )
case "$OUT" in *"2 superficie(s) de paridad en rojo"*hooks*mcp*) ok "T48 bench-notice cobra el reporte rojo desde la carpeta del estado en un árbol bajado sin .bench/" ;; *) bad "T48 bench-notice no cobra el reporte del estado" "$(printf '%s' "$OUT" | head -5)" ;; esac
# un reporte VIEJO que quedó en .bench/ del árbol y el nuevo en la carpeta del estado: manda el del productor (el del estado)
mkdir -p "$LAB/tree/scripts/controls-bench/.bench"
printf '{ "kind": "harness-parity", "deployed": true, "ts": "%s", "reds": 5, "surfaces": [ { "name": "viejo", "ok": false } ] }\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LAB/tree/scripts/controls-bench/.bench/harness-parity.json"
OUT=$( unset TYCON_PARITY_BENCH_DIR TYCON_BENCH_DIR; HOME="$LAB/home" USERPROFILE="$LAB/home" TYCON_HOME="$LAB/home/.tycon" TYCON_PROFILE=0 node "$LAB/tree/scripts/hooks/bench-notice.js" 2>&1 )
case "$OUT" in *viejo*) bad "T48 bench-notice cobró el reporte viejo de .bench/ en vez del del estado" "$(printf '%s' "$OUT" | grep -i paridad | head -3)" ;; *"2 superficie(s) de paridad en rojo"*) ok "T48 con un reporte viejo en .bench/ y el nuevo en el estado, gana el del estado" ;; *) bad "T48 con los dos reportes no cobró ninguno" "$(printf '%s' "$OUT" | head -5)" ;; esac
# T48b · los reportes del disparo real (live-fire*.js) van a la MISMA carpeta que el de paridad: en una
# versión bajada, si quedaran en .bench/ del árbol —que cada actualización reemplaza entero—, un rojo desaparecería sin que
# nadie lo arreglara. Y bench-notice los cobra desde ahí.
# 🔴 Sin el arreglo, los tres guiones no conocen --report-dir (abren una sesión) y el aviso no lee live-fire del estado.
bajada() { ( unset TYCON_PARITY_BENCH_DIR TYCON_BENCH_DIR; HOME="$LAB/home" USERPROFILE="$LAB/home" TYCON_HOME="$LAB/home/.tycon" TYCON_PROFILE=0 "$@" ); }
for g in live-fire live-fire-guard live-fire-stop; do
  OUT=$(bajada node "$LAB/tree/scripts/controls-bench/$g.js" --report-dir 2>&1); RC=$?
  [ $RC -eq 0 ] && [ "$OUT" = "$LAB/home/.tycon/state/controls-bench" ] && ok "T48b $g.js en una versión bajada escribe en la carpeta del estado" || bad "T48b $g.js --report-dir (bajada)" "rc=$RC · $(printf '%s' "$OUT" | tail -1)"
done
mv "$LAB/tree/.tycon-release.json" "$LAB/release.aside"
OUT=$(bajada node "$LAB/tree/scripts/controls-bench/live-fire.js" --report-dir 2>&1)
[ "$OUT" = "$LAB/tree/scripts/controls-bench/.bench" ] && ok "T48b en un clon, donde siempre (.bench/ del árbol)" || bad "T48b live-fire.js --report-dir (clon)" "$OUT"
mv "$LAB/release.aside" "$LAB/tree/.tycon-release.json"
# el aviso: un reporte rojo del disparo real en la carpeta del estado se cobra; uno viejo con el mismo nombre en .bench/ del árbol, no
printf '{ "ts": "%s", "tool": "codex", "prove": false, "failures": ["hook de PostToolUse NO SE DISPARÓ (sin marcador)"] }\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LAB/home/.tycon/state/controls-bench/live-fire-codex.json"
printf '{ "ts": "%s", "tool": "codex", "prove": false, "failures": ["viejo-del-arbol"] }\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LAB/tree/scripts/controls-bench/.bench/live-fire-codex.json"
OUT=$(bajada node "$LAB/tree/scripts/hooks/bench-notice.js" 2>&1)
case "$OUT" in *viejo-del-arbol*) bad "T48b bench-notice cobró el live-fire viejo de .bench/ en vez del del estado" "$(printf '%s' "$OUT" | grep -i live-fire | head -2)" ;; *"live-fire-codex.json: hook de PostToolUse NO SE DISPARÓ"*) ok "T48b bench-notice cobra el live-fire rojo desde la carpeta del estado (y no el viejo del árbol)" ;; *) bad "T48b bench-notice no cobra el live-fire del estado" "$(printf '%s' "$OUT" | head -4)" ;; esac
# …también cuando es lo ÚNICO que hay (sin reporte de paridad y sin .bench/ en el árbol): el aviso no sale antes de leerlo
rm -rf "$LAB/tree/scripts/controls-bench/.bench"; rm -f "$LAB/home/.tycon/state/controls-bench/harness-parity.json"
OUT=$(bajada node "$LAB/tree/scripts/hooks/bench-notice.js" 2>&1)
case "$OUT" in *"live-fire-codex.json: hook de PostToolUse NO SE DISPARÓ"*) ok "T48b …también cuando es el único reporte de la máquina" ;; *) bad "T48b live-fire como único reporte" "$(printf '%s' "$OUT" | head -4)" ;; esac
# (una TYCON_HOME relativa NO hace fallar `stateDir(home)` —la pieza la ignora y usa la casa—: medido acá; el `catch` que sólo
# calla «falta la pieza» queda sin un error forzable sin simular el sistema de archivos, que esta suite evita)
rm -rf "$LAB"

# ── 4c. T26: lo desplegado con el modelo de la organización está al día ────────────────────────
# Con `team-repos.json → models`, lo desplegado a Codex lleva el modelo resuelto de la organización (no el de adapters/):
# la paridad lo compara con la misma resolución y da ✅; con el archivo ilegible se despliega lo de adapters/ y también da ✅;
# un .toml editado a mano sigue siendo rojo. Sobre una copia del árbol (sin .git), nunca el real.
# 🔴 Sin el arreglo, con `models` declarado la paridad compara contra adapters/ y da 🔴 advisors.
LAB=$(mktemp -d); LAB="$(cd "$LAB" && pwd -P)"
mkdir -p "$LAB/.codex" "$LAB/.tycon/state" "$LAB/tree"
rsync -a --exclude .git --exclude node_modules --exclude '.advisors' "$TCG/" "$LAB/tree/"
equipo() { printf '{"version":1,"public":{"platform":"github","org":"acme","repo":"h"},"profile":{"platform":"github","org":"acme","repo":"p"},"operations":{"platform":"github","org":"acme","repo":"o"}%s}\n' "$1" > "$LAB/tree/team-repos.json"; }
lab7() { HOME="$LAB" USERPROFILE="$LAB" CODEX_HOME="$LAB/.codex" TYCON_PROFILE=0 TYCON_SKILLS_DIR="$LAB/tree" "$@"; }
printf '{ "tools": ["codex"], "tree": "%s" }\n' "$LAB/tree" > "$LAB/.tycon/state/harness-state.json"
equipo ',"models":{"reviewers":"haiku","reviewer":{"tycon-spec-first-checker":"opus"},"mandatory_ceiling":true,"ceiling":"sonnet"}'
lab7 node "$LAB/tree/build/deploy-codex-all.js" --force >/dev/null 2>&1
grep -q '^model = "gpt-5.4-mini"$' "$LAB/.codex/agents/tycon-plugin-security-basics.toml" && grep -q '^model = "gpt-5.6-luna"$' "$LAB/.codex/agents/tycon-spec-first-checker.toml" \
  && ok "T26 lo desplegado lleva el modelo de la organización (haiku → gpt-5.4-mini; spec-first, por el techo, gpt-5.6-luna)" \
  || bad "T26 modelo de la organización en lo desplegado" "$(grep -h '^model' "$LAB/.codex/agents/tycon-plugin-security-basics.toml" "$LAB/.codex/agents/tycon-spec-first-checker.toml" 2>&1 | head -2)"
OUT=$(lab7 node "$LAB/tree/scripts/lib/harness-parity.js" 2>&1)
case "$OUT" in *"✅ advisors"*) ok "T26 con models → ✅ advisors";; *) bad "T26 con models → ✅ advisors" "$(echo "$OUT" | grep advisors | head -1)";; esac
printf '# editado a mano\n' >> "$LAB/.codex/agents/tycon-plugin-security-basics.toml"
OUT=$(lab7 node "$LAB/tree/scripts/lib/harness-parity.js" 2>&1)
case "$OUT" in *"🔴 advisors"*) ok "T26 uno editado a mano → 🔴 advisors, como hoy";; *) bad "T26 editado a mano → 🔴" "$(echo "$OUT" | grep advisors | head -1)";; esac
printf '{ roto' > "$LAB/tree/team-repos.json"
OUT=$(lab7 node "$LAB/tree/build/deploy-codex-all.js" --force 2>&1)
case "$OUT" in *"no pude leer la configuración de la organización"*) ok "T26 con team-repos.json ilegible el despliegue lo dice";; *) bad "T26 ilegible → lo dice" "$(echo "$OUT" | tail -2)";; esac
cmp -s "$LAB/.codex/agents/tycon-plugin-security-basics.toml" "$LAB/tree/adapters/codex/agents-native/tycon-plugin-security-basics.toml" \
  && ok "T26 …y despliega lo de hoy, byte a byte" || bad "T26 ilegible → lo de hoy" "difiere de adapters/"
OUT=$(lab7 node "$LAB/tree/scripts/lib/harness-parity.js" 2>&1)
case "$OUT" in *"✅ advisors"*) ok "T26 con el archivo ilegible → ✅ advisors";; *) bad "T26 ilegible → ✅ advisors" "$(echo "$OUT" | grep advisors | head -1)";; esac
rm -rf "$LAB"

# ── T49 · el config.toml de Codex respeta las integraciones elegidas ─────────────────────────
# Un servidor de una integración apagada no se declara en ~/.codex/config.toml: Codex intenta arrancar todo lo que está
# declarado, también lo que el dev no eligió.
# 🔴 Rojo si el desplegador escribe las tablas de engram o codegraph con sus integraciones apagadas.
LAB=$(mktemp -d); mkdir -p "$LAB/.codex" "$LAB/.tycon/state" "$LAB/bin"
printf '#!/bin/sh\nexit 0\n' > "$LAB/bin/codegraph"; chmod +x "$LAB/bin/codegraph"
printf '{ "tools": ["codex"], "tree": "%s" }\n' "$TCG" > "$LAB/.tycon/state/harness-state.json"
lab49() { HOME="$LAB" USERPROFILE="$LAB" CODEX_HOME="$LAB/.codex" TYCON_PROFILE=0 PATH="$LAB/bin:$PATH" "$@"; }
CFG="$LAB/.codex/config.toml"
# codebase-memory no entra: depende de que su ejecutable esté en la máquina que corre la suite
tablas() { grep -oE '^\[mcp_servers\.(plugin_engram_engram|codegraph)\]' "$CFG" 2>/dev/null | sort | tr '\n' ' '; }
lab49 env TYCON_ENGRAM=0 TYCON_CODEGRAPH=0 node "$TCG/build/deploy-codex-mcp.js" >/dev/null 2>&1
[ -z "$(tablas)" ] && ok "T49 con engram y codegraph apagados, el config.toml de Codex no los declara" || bad "T49 integraciones apagadas" "declara: $(tablas)"
OUT=$(lab49 env TYCON_ENGRAM=0 TYCON_CODEGRAPH=0 node "$PARITY" 2>&1)
case "$OUT" in *"✅ mcp"*) ok "T49 …y la paridad lo da por bueno (✅ mcp)";; *) bad "T49 paridad con las integraciones apagadas" "$(echo "$OUT" | grep ' mcp' | head -1)";; esac
lab49 env TYCON_ENGRAM=1 TYCON_CODEGRAPH=1 node "$TCG/build/deploy-codex-mcp.js" >/dev/null 2>&1
case "$(tablas)" in *plugin_engram_engram*codegraph*|*codegraph*plugin_engram_engram*) ok "T49 prendidos, los declara";; *) bad "T49 integraciones prendidas" "declara: $(tablas)";; esac
OUT=$(lab49 env TYCON_ENGRAM=1 TYCON_CODEGRAPH=1 node "$PARITY" 2>&1)
case "$OUT" in *"✅ mcp"*) ok "T49 …y con ellos prendidos la paridad también da ✅ mcp";; *) bad "T49 paridad con las integraciones prendidas" "$(echo "$OUT" | grep ' mcp' | head -1)";; esac
lab49 env TYCON_ENGRAM=0 TYCON_CODEGRAPH=0 node "$TCG/build/deploy-codex-mcp.js" >/dev/null 2>&1
[ -z "$(tablas)" ] && ok "T49 al apagarlos después, el desplegador saca sus tablas" || bad "T49 apagar después" "quedó: $(tablas)"
# clockify se define en cada máquina: con su integración prendida y sin cómo resolverlo, la tabla escrita a mano se queda;
# apagada, se saca
printf '\n[mcp_servers.clockify]\ncommand = "a-mano"\nargs = []\n' >> "$CFG"
lab49 env TYCON_ENGRAM=0 TYCON_CODEGRAPH=0 TYCON_CLOCKIFY=1 node "$TCG/build/deploy-codex-mcp.js" >/dev/null 2>&1
grep -q '^\[mcp_servers\.clockify\]' "$CFG" && ok "T49 clockify prendido y escrito a mano: la tabla se queda" || bad "T49 clockify prendido" "se borró"
lab49 env TYCON_ENGRAM=0 TYCON_CODEGRAPH=0 TYCON_CLOCKIFY=0 node "$TCG/build/deploy-codex-mcp.js" >/dev/null 2>&1
! grep -q '^\[mcp_servers\.clockify\]' "$CFG" && ok "T49 clockify apagado: el desplegador saca su tabla" || bad "T49 clockify apagado" "quedó la tabla"
rm -rf "$LAB"

# ── 5. Los selftests de las piezas que esta red integra ──────────────────────────────────────
node "$PARITY" --selftest >/dev/null 2>&1 && ok "selftest de paridad verde" || bad "selftest de paridad" "rojo"
node "$TCG/build/deploy-codex-mcp.js" --selftest >/dev/null 2>&1 && ok "selftest del deployer MCP verde" || bad "selftest deployer MCP" "rojo"
node "$TCG/build/deploy-codex-all.js" --selftest >/dev/null 2>&1 && ok "selftest del orquestador verde" || bad "selftest orquestador" "rojo"

if [ "$fallos" -eq 0 ]; then echo "✅ harness-parity: todo verde"; exit 0; fi
echo "❌ harness-parity: $fallos rojos"; exit 1
