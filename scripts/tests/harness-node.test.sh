#!/usr/bin/env bash
# harness-node.test.sh — el Node propio del arnés (story 8.39): la lista de seis plataformas, la bajada verificada contra
# las huellas que viajan en el árbol, el enlace `current`, lo que pasa cuando no se puede, y quién lo usa.
# stable-data: no crea commits; «commit» aparece en el nombre de los hooks que nombra (engram-pre-commit.sh, git-pre-commit-global.sh).
#
# Lo que no se puede perder:
#   · `scripts/production/node-official.json` es la ÚNICA lista de versión y huellas (la del freno y la del arnés), y las
#     entradas de Mac siguen como las lee `install-guard.sh` (`grep -A2`).
#   · La bajada se verifica contra la huella del comprimido Y la del binario de la lista del árbol que corre; nunca contra
#     lo que diga el servidor. Se arma aparte (`node/.incoming-<pid>/`) y recién al final entra por cambio de nombre.
#   · Si no se puede (sin red, huella distinta, binario que no arranca, plataforma sin entrada, lista ilegible, apagado),
#     no queda nada a medias, `current` queda como estaba y el arnés sigue con el `node` del PATH.
#   · El arnés no le cambia el `node` al dev: no toca el PATH.
#
# 🔴 Nunca contra nodejs.org: el servidor es scripts/tests/lib/fake-node-dist.js en 127.0.0.1 y la lista es una copia de
# laboratorio en un árbol de juguete. El Node de juguete es un guion que llama al node real por su ruta absoluta: nunca
# un enlace (`ln`) a un binario real. Nada toca `~/.claude`, `~/.tycon` ni el checkout real (HOME de juguete).
set -u
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE="$(mktemp -d "${TMPDIR:-/tmp}/lab-harness-node.XXXXXX")"   # sin el nombre del repo público (mirror-pipeline T36)
node "$RAIZ/scripts/tests/lib/lab-guard.js" "$BASE" harness-node || exit 1
SERVER_PID=""
trap '[ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$BASE"' EXIT
FALLAS=0
ok() { echo "✅ harness-node: $1"; }
bad() { echo "❌ harness-node: $1"; FALLAS=$((FALLAS + 1)); }

MOD="$RAIZ/scripts/setup/harness/harness-node.js"
LIST="$RAIZ/scripts/production/node-official.json"
REAL_NODE="$(command -v node)"
V1="v24.21.0"; V2="v24.22.0"; V3="v24.23.0"; V4="v24.24.0"; V5="v24.25.0"

# ─── T1 · la lista real: seis plataformas, una versión ─────────────────────────────────────────────────────────────
# @story-8.39 @ac-1  NodeOfficial_SeisPlataformas_UnaVersion
t1="$(node -e '
const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const want = ["darwin-arm64","darwin-x64","linux-x64","linux-arm64","win-x64","win-arm64"];
const hex = (s) => /^[0-9a-f]{64}$/.test(String(s || ""));
const bad = [];
if (!/^v\d+\.\d+\.\d+$/.test(String(l.version))) bad.push("version");
const keys = Object.keys(l.files || {});
if (JSON.stringify(keys) !== JSON.stringify(want)) bad.push("orden de files: " + keys.join(","));
for (const k of want) {
  const e = (l.files || {})[k] || {};
  if (!hex(e.sha256)) bad.push(k + ": sha256");
  if (k.startsWith("win-")) { if (e.exe !== k + "/node.exe") bad.push(k + ": exe"); }
  else { if (e.tar !== "node-" + l.version + "-" + k + ".tar.gz") bad.push(k + ": tar"); if (!hex(e.node_sha256)) bad.push(k + ": node_sha256"); }
}
process.stdout.write(bad.join(" · "));' "$LIST" 2>&1)"
[ -z "$t1" ] && ok "T1 la lista trae seis plataformas en orden, una versión, sha256 en todas y node_sha256 en los cuatro .tar.gz" || bad "T1 la lista no está completa: $t1"
for arch in darwin-arm64 darwin-x64; do
  blk="$(grep -A2 "\"$arch\"" "$LIST")"
  if printf '%s' "$blk" | grep -q '"tar"' && printf '%s' "$blk" | grep -q '"sha256"'; then ok "T1 $arch: tar y sha256 en las dos líneas siguientes (lo que lee install-guard.sh)"; else bad "T1 $arch: install-guard.sh no encontraría tar/sha256 con grep -A2"; fi
done

[ -f "$MOD" ] || { bad "falta $MOD (la feature no existe)"; echo "harness-node: $FALLAS fallas"; exit 1; }

# ─── el laboratorio: HOME de juguete, árbol de juguete con la lista de laboratorio, servidor local ────────────────
export HOME="$BASE/home"; mkdir -p "$HOME"
unset TYCON_HOME TYCON_NODE_BIN
export TYCON_HARNESS_NODE=1
TREE="$BASE/tree"; mkdir -p "$TREE/scripts/production" "$TREE/scripts/setup/harness" "$TREE/scripts/lib"
cp "$RAIZ/scripts/setup/harness/"*.js "$TREE/scripts/setup/harness/"
cp "$RAIZ/scripts/lib/http-get.js" "$RAIZ/scripts/lib/tar-reader.js" "$RAIZ/scripts/lib/git-tree-hash.js" "$TREE/scripts/lib/"
DIST="$BASE/dist"; mkdir -p "$DIST"
HN="$TREE/scripts/setup/harness/harness-node.js"
KEY="$(node -e 'process.stdout.write(require(process.argv[1]).platformKey({}).key || "")' "$HN")"
[ -n "$KEY" ] || { bad "esta máquina no tiene clave de plataforma: no se puede probar la bajada"; echo "harness-node: $FALLAS fallas"; exit 1; }
sha() { node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"; }

# make_dist <versión> <exit de --version>  — el comprimido de juguete de esa versión para esta plataforma, en DIST
make_dist() {
  local v="$1" rc="${2:-0}" root="$BASE/build/node-$1-$KEY"
  rm -rf "$BASE/build"; mkdir -p "$root/bin" "$root/lib/node_modules/npm/bin" "$DIST/$v"
  if [ "$rc" = "0" ]; then
    printf '#!/bin/sh\n# node de juguete (harness-node.test.sh)\nif [ "${1:-}" = "--version" ]; then echo "%s"; exit 0; fi\nexec "%s" "$@"\n' "$v" "$REAL_NODE" > "$root/bin/node"
  else
    printf '#!/bin/sh\n# node de juguete que NO arranca en esta máquina\necho "biblioteca del sistema vieja" >&2\nexit %s\n' "$rc" > "$root/bin/node"
  fi
  chmod +x "$root/bin/node"
  : > "$root/lib/node_modules/npm/bin/npm-cli.js"
  ( cd "$root/bin" && ln -s ../lib/node_modules/npm/bin/npm-cli.js npm && ln -s ../lib/node_modules/npm/bin/npm-cli.js npx && ln -s ../lib/node_modules/npm/bin/npm-cli.js corepack )
  ( cd "$BASE/build" && COPYFILE_DISABLE=1 tar -czf "$DIST/$v/node-$v-$KEY.tar.gz" "node-$v-$KEY" )
  # el .exe de juguete (Windows): el mismo guion, suelto
  mkdir -p "$DIST/$v/win-x64"; cp "$root/bin/node" "$DIST/$v/win-x64/node.exe"
  sha "$root/bin/node" > "$BASE/build/node.sha"
}
# write_list <versión> [tar-sha] [node-sha]  — la lista de laboratorio del árbol de juguete, con las huellas de DIST
write_list() {
  local v="$1" tsha="${2:-$(sha "$DIST/$1/node-$1-$KEY.tar.gz")}" nsha="${3:-$(cat "$BASE/build/node.sha")}" esha
  esha="$(sha "$DIST/$v/win-x64/node.exe")"
  node -e '
const [file, v, key, tsha, nsha, esha, port] = process.argv.slice(1);
const files = {}; files[key] = { tar: `node-${v}-${key}.tar.gz`, sha256: tsha, node_sha256: nsha };
files["win-x64"] = { exe: "win-x64/node.exe", sha256: esha };
require("fs").writeFileSync(file, JSON.stringify({ version: v, base_url: `http://127.0.0.1:${port}/`, files }, null, 2) + "\n");
' "$TREE/scripts/production/node-official.json" "$v" "$KEY" "$tsha" "$nsha" "$esha" "$(cat "$BASE/port")"
}
REQS="$BASE/requests.log"; MODE="$BASE/mode"; echo ok > "$MODE"
node "$RAIZ/scripts/tests/lib/fake-node-dist.js" "$DIST" "$BASE/port" "$REQS" "$MODE" & SERVER_PID=$!; disown "$SERVER_PID" 2>/dev/null || true
for _ in $(seq 1 50); do [ -s "$BASE/port" ] && break; node -e 'setTimeout(()=>{},100)'; done
[ -s "$BASE/port" ] || { bad "el servidor de juguete no arrancó"; echo "harness-node: $FALLAS fallas"; exit 1; }
reqs() { [ -f "$REQS" ] && wc -l < "$REQS" | tr -d ' ' || echo 0; }
NDIR="$HOME/.tycon/node"
# hn <modo> [plataforma] [arquitectura]  — corre ensure del módulo del árbol de juguete e imprime su resultado en JSON
hn() {
  node -e '
const H = require(process.argv[1]);
const o = { tree: process.argv[2], mode: process.argv[3], log: () => {} };
if (process.argv[4]) o.platform = process.argv[4];
if (process.argv[5]) o.arch = process.argv[5];
process.stdout.write(JSON.stringify(H.ensure(o)));' "$HN" "$TREE" "$@"
}
field() { node -e 'const j=JSON.parse(process.argv[1]); let v=j; for (const k of process.argv[2].split(".")) v = v == null ? v : v[k]; process.stdout.write(v == null ? "" : String(v))' "$1" "$2"; }
record() { node -e 'const H=require(process.argv[1]); process.stdout.write(JSON.stringify(H.readRecord({})))' "$HN"; }
target() { node -e 'const p=require("fs");try{process.stdout.write(require("path").basename(p.readlinkSync(process.argv[1])))}catch(_){}' "$NDIR/current"; }

# ─── T4 · baja, verifica y enlaza ───────────────────────────────────────────────────────────────────────────────────
# @story-8.39 @ac-2  Install_BajaVerificaYEnlaza
make_dist "$V1"; write_list "$V1"
r="$(hn manual)"
if [ "$(field "$r" status)" = "installed" ] && [ -x "$NDIR/versions/$V1/bin/node" ] && [ "$(target)" = "$V1" ]; then ok "T4 bajó, verificó y enlazó: current → versions/$V1"; else bad "T4 no instaló: $r"; fi
m="$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(["version","platform","file","sha256","binary_sha256","installed_at"].filter(k=>!m[k]).join(","))' "$NDIR/versions/$V1/.tycon-node.json" 2>&1)"
[ -z "$m" ] && ok "T4 el manifiesto .tycon-node.json está completo" || bad "T4 al manifiesto le falta: $m"
if ls -d "$NDIR"/.incoming-* >/dev/null 2>&1; then bad "T4 quedó una carpeta .incoming-* al final"; else ok "T4 ninguna .incoming-* al final"; fi
for extra in npm npx corepack; do [ -e "$NDIR/versions/$V1/bin/$extra" ] && bad "T4 se escribió bin/$extra (sólo va bin/node)"; done
[ "$("$NDIR/current/bin/node" --version)" = "$V1" ] && ok "T4 current/bin/node arranca y dice $V1" || bad "T4 current/bin/node no arranca"

# ─── T6 · ya al día: cero pedidos ───────────────────────────────────────────────────────────────────────────────────
# @story-8.39 @ac-3  Ensure_YaAlDia_SinRed
before="$(reqs)"; r="$(hn manual)"
[ "$(reqs)" = "$before" ] && [ "$(field "$r" status)" = "ok" ] && ok "T6 con current al día: cero pedidos" || bad "T6 pidió de nuevo o no dijo ok: $r ($(reqs) pedidos, antes $before)"
r="$(hn startup)"; [ "$(reqs)" = "$before" ] && ok "T6 el arranque tampoco pide" || bad "T6 el arranque pidió"

# ─── T7 · versión nueva: cambia el enlace, guarda la anterior, borra la más vieja en el arranque siguiente ──────────
# @story-8.39 @ac-3  Ensure_VersionNueva_CambiaElEnlaceYGuardaLaAnterior
make_dist "$V2"; write_list "$V2"; r="$(hn startup)"
[ "$(target)" = "$V2" ] && [ -d "$NDIR/versions/$V1" ] && ok "T7 current → $V2 y $V1 queda" || bad "T7 no cambió a $V2 o borró $V1: $r"
make_dist "$V3"; write_list "$V3"; r="$(hn startup)"
[ "$(target)" = "$V3" ] && [ -d "$NDIR/versions/$V2" ] && ok "T7 current → $V3 y $V2 queda" || bad "T7 tercera versión: $r"
r="$(hn startup)"
if [ ! -d "$NDIR/versions/$V1" ] && [ -d "$NDIR/versions/$V2" ] && [ -d "$NDIR/versions/$V3" ]; then ok "T7 en el arranque siguiente se borró la más vieja ($V1); quedan la de current y la anterior"; else bad "T7 limpieza: $(ls "$NDIR/versions" | tr '\n' ' ')"; fi

# ─── T8 · una versión rota se aparta, nunca se escribe encima ──────────────────────────────────────────────────────
# @story-8.39 @ac-2  Ensure_ArmaAparteYApartaLaRota
rm -rf "$NDIR"; mkdir -p "$NDIR/versions/$V3/bin"; printf '#!/bin/sh\nexit 1\n' > "$NDIR/versions/$V3/bin/node"; chmod +x "$NDIR/versions/$V3/bin/node"
r="$(hn manual)"
if [ "$(field "$r" status)" = "installed" ] && [ "$("$NDIR/current/bin/node" --version)" = "$V3" ] && ls "$NDIR"/trash/*/bin/node >/dev/null 2>&1; then ok "T8 la rota fue a node/trash/ y la nueva entró por cambio de nombre"; else bad "T8: $r · trash: $(ls "$NDIR/trash" 2>/dev/null)"; fi

# ─── T9 · sin red, 500, servidor que no contesta: nada a medias, current igual, motivo anotado ─────────────────────
# @story-8.39 @ac-11  Ensure_SinRed_SigueConElDelPathYAvisa
make_dist "$V1"; write_list "$V1"   # la lista pide otra versión que la de current
for case in 500 hang; do
  printf '%s\n' "$case" > "$MODE"
  r="$(TYCON_HARNESS_NODE_BUDGET_S=2 hn manual)"
  if [ "$(field "$r" status)" = "failed" ] && [ ! -d "$NDIR/versions/$V1" ] && [ "$(target)" = "$V3" ] && ! ls -d "$NDIR"/.incoming-* >/dev/null 2>&1; then ok "T9 ($case): falló sin dejar nada, current sigue en $V3"; else bad "T9 ($case): $r"; fi
  rec="$(record)"; [ -n "$(field "$rec" last_failure.reason)" ] && [ -n "$(field "$rec" last_failure.at)" ] && ok "T9 ($case): last_failure con motivo ($(field "$rec" last_failure.reason))" || bad "T9 ($case): sin last_failure: $rec"
  [ -n "$(field "$r" notice)" ] && ok "T9 ($case): el resultado trae el aviso" || bad "T9 ($case): sin aviso"
done
echo ok > "$MODE"
# servidor caído: un puerto que no escucha
cp "$TREE/scripts/production/node-official.json" "$BASE/list.bak"
node -e 'const f=process.argv[1];const j=JSON.parse(require("fs").readFileSync(f,"utf8"));j.base_url="http://127.0.0.1:9/";require("fs").writeFileSync(f,JSON.stringify(j))' "$TREE/scripts/production/node-official.json"
r="$(TYCON_HARNESS_NODE_BUDGET_S=2 hn manual)"
[ "$(field "$r" status)" = "failed" ] && [ "$(target)" = "$V3" ] && ok "T9 (servidor caído): falló, current igual" || bad "T9 (servidor caído): $r"
cp "$BASE/list.bak" "$TREE/scripts/production/node-official.json"

# ─── T10 · la ventana de seis horas y el arranque en el lugar ──────────────────────────────────────────────────────
# @story-8.39 @ac-4 @ac-11  Ensure_ArranqueAparte_YVentanaDeSeisHoras
set_failure_age() { node -e 'const H=require(process.argv[1]);const r=H.readRecord({});r.last_failure={at:new Date(Date.now()-Number(process.argv[2])*3600e3).toISOString(),reason:"prueba"};H.writeRecord({},r)' "$HN" "$1"; }
set_failure_age 1; before="$(reqs)"; r="$(hn startup)"
[ "$(reqs)" = "$before" ] && [ "$(field "$r" status)" = "skipped" ] && ok "T10 falla hace 1 h: el arranque no pide" || bad "T10 1 h: pidió o no salteó: $r"
set_failure_age 7; r="$(hn startup)"
[ "$(reqs)" != "$before" ] && [ "$(field "$r" status)" = "installed" ] && ok "T10 falla hace 7 h: el arranque pide y baja" || bad "T10 7 h: $r"
rec="$(record)"; [ -z "$(field "$rec" last_failure)" ] && ok "T10 con la bajada lograda, last_failure se borra" || bad "T10 last_failure quedó: $rec"
make_dist "$V2"; write_list "$V2"; before="$(reqs)"; r="$(hn none)"
[ "$(reqs)" = "$before" ] && [ "$(field "$r" status)" = "deferred" ] && [ -z "$(field "$(record)" last_failure)" ] && ok "T10 arranque en el lugar: cero pedidos y sin anotar falla" || bad "T10 en el lugar: $r"
set_failure_age 1; r="$(hn manual)"
[ "$(reqs)" != "$before" ] && ok "T10 apply/install/update a mano piden siempre (aun con falla de hace 1 h)" || bad "T10 a mano no pidió: $r"

# ─── T11 · huella que no coincide ──────────────────────────────────────────────────────────────────────────────────
# @story-8.39 @ac-12  Ensure_HuellaQueNoCoincide_SeDescarta
make_dist "$V4"; write_list "$V4" "$(printf 'a%.0s' $(seq 1 64))"
r="$(hn manual)"
if [ "$(field "$r" status)" = "failed" ] && [ ! -d "$NDIR/versions/$V4" ] && printf '%s' "$(field "$r" reason)" | grep -q "la huella no coincide (esperaba aaaa"; then ok "T11 comprimido distinto: descartado, el motivo trae las dos huellas"; else bad "T11 comprimido: $r"; fi
write_list "$V4" "" "$(printf 'b%.0s' $(seq 1 64))"
r="$(hn manual)"
if [ "$(field "$r" status)" = "failed" ] && [ ! -d "$NDIR/versions/$V4" ] && printf '%s' "$(field "$r" reason)" | grep -q "esperaba bbbb"; then ok "T11 bin/node distinto de node_sha256: descartado"; else bad "T11 binario: $r"; fi

# ─── T12 · binario que no arranca: incompatible ────────────────────────────────────────────────────────────────────
# @story-8.39 @ac-13  Ensure_BinarioQueNoArranca_Incompatible
make_dist "$V5" 1; write_list "$V5"
r="$(hn manual)"
if [ "$(field "$r" status)" = "failed" ] && printf '%s' "$(field "$r" reason)" | grep -q "no arranca en esta máquina" && [ "$(field "$(record)" incompatible)" = "$V5" ]; then ok "T12 descartado con su salida e incompatible = $V5"; else bad "T12: $r · $(record)"; fi
node -e 'const H=require(process.argv[1]);const r=H.readRecord({});delete r.last_failure;H.writeRecord({},r)' "$HN"
before="$(reqs)"; r="$(hn startup)"
[ "$(reqs)" = "$before" ] && ok "T12 el arranque no la vuelve a bajar" || bad "T12 el arranque pidió de nuevo: $r"
r="$(hn manual)"; [ "$(reqs)" != "$before" ] && ok "T12 a mano sí" || bad "T12 a mano no pidió"
[ ! -d "$NDIR/versions/$V5" ] && ok "T12 nada en versions/$V5" || bad "T12 quedó versions/$V5"

# ─── T13 · plataforma sin entrada, Linux sin glibc, lista ilegible ─────────────────────────────────────────────────
# @story-8.39 @ac-14  Ensure_PlataformaSinEntradaOListaIlegible
make_dist "$V1"; write_list "$V1"; before="$(reqs)"
r="$(hn manual linux ppc64)"
[ "$(field "$r" status)" = "unsupported" ] && printf '%s' "$(field "$r" reason)" | grep -q "no tiene Node oficial en la lista" && ok "T13 linux-ppc64: sin bajar, con el motivo" || bad "T13 ppc64: $r"
r="$(TYCON_HARNESS_NODE_NO_GLIBC=1 hn manual linux x64)"
[ "$(field "$r" status)" = "unsupported" ] && ok "T13 Linux sin glibc: sin bajar ($(field "$r" reason))" || bad "T13 sin glibc: $r"
cp "$TREE/scripts/production/node-official.json" "$BASE/list.bak"; printf '{ roto' > "$TREE/scripts/production/node-official.json"
r="$(hn manual)"
[ "$(field "$r" status)" = "unreadable" ] && printf '%s' "$(field "$r" reason)" | grep -q "no pude leer node-official.json" && ok "T13 lista ilegible: «no pude leer», nunca «no hace falta»" || bad "T13 lista rota: $r"
[ "$(reqs)" = "$before" ] && ok "T13 cero pedidos en los tres casos" || bad "T13 hubo pedidos"
[ -z "$(field "$r" notice)" ] && ok "T13 sin aviso de arranque" || bad "T13 avisa en cada sesión: $(field "$r" notice)"
cp "$BASE/list.bak" "$TREE/scripts/production/node-official.json"

# ─── T14 · apagado ─────────────────────────────────────────────────────────────────────────────────────────────────
# @story-8.39 @ac-15  Ensure_Apagado_SinRed
before="$(reqs)"; r="$(TYCON_HARNESS_NODE=0 hn manual)"
i="$(TYCON_HARNESS_NODE=0 node -e 'process.stdout.write(JSON.stringify(require(process.argv[1]).interpreter({ tree: process.argv[2] })))' "$HN" "$TREE")"
if [ "$(reqs)" = "$before" ] && [ "$(field "$r" status)" = "off" ] && [ "$(field "$i" own)" = "false" ] && [ -d "$NDIR/versions" ]; then ok "T14 apagado: cero pedidos, intérprete node, la carpeta sigue"; else bad "T14: $r · $i"; fi

# ─── T5 · Windows: el .exe suelto, comparado y enlazado ────────────────────────────────────────────────────────────
# @story-8.39 @ac-1 @ac-2  Ensure_PlataformaWindows_GuardaElExe
rm -rf "$NDIR"; r="$(hn manual win32 x64)"
if [ "$(field "$r" status)" = "installed" ] && [ -f "$NDIR/versions/$V1/node.exe" ] && [ "$(target)" = "$V1" ] && [ "$(sha "$NDIR/versions/$V1/node.exe")" = "$(sha "$DIST/$V1/win-x64/node.exe")" ]; then ok "T5 win-x64: node.exe guardado tal cual y current → $V1"; else bad "T5: $r"; fi
rm -rf "$NDIR"

# ─── T15 · current que dejó de arrancar ────────────────────────────────────────────────────────────────────────────
# @story-8.39 @ac-16  Startup_CurrentRoto_VuelveANodeEnLosDosLados
r="$(hn manual)"; printf '#!/bin/sh\nexit 1\n' > "$NDIR/versions/$V1/bin/node"
printf '500\n' > "$MODE"
r="$(TYCON_HARNESS_NODE_BUDGET_S=2 hn manual)"
i="$(node -e 'process.stdout.write(JSON.stringify(require(process.argv[1]).interpreter({ tree: process.argv[2] })))' "$HN" "$TREE")"
if [ ! -e "$NDIR/current" ] && [ -d "$NDIR/versions/$V1" ] && [ "$(field "$i" own)" = "false" ]; then ok "T15 el enlace current se fue, la carpeta quedó, el intérprete vuelve a node"; else bad "T15: current=$(target) · $i"; fi
echo ok > "$MODE"
HELPER="$RAIZ/scripts/lib/harness-node.sh"
[ "$(bash -c '. "$1"; harness_node_bin' _ "$HELPER")" = "node" ] && ok "T15 el ayudante de shell elige node sin current" || bad "T15 el ayudante eligió otro"
rm -rf "$NDIR"

# ─── T22 · los hijos usan el Node del arnés ────────────────────────────────────────────────────────────────────────
# @story-8.39 @ac-8  Hijos_UsanElNodeDelArnes
mkdir -p "$NDIR/versions/$V1/bin"; ln -s "versions/$V1" "$NDIR/current"
printf '#!/bin/sh\necho usado >> "%s"\nexec "%s" "$@"\n' "$BASE/wrapper.log" "$REAL_NODE" > "$NDIR/versions/$V1/bin/node"; chmod +x "$NDIR/versions/$V1/bin/node"
got="$(bash -c '. "$1"; harness_node_bin' _ "$HELPER")"
[ "$got" = "$NDIR/current/bin/node" ] && ok "T22 el ayudante de shell elige current si es ejecutable" || bad "T22 el ayudante eligió «${got}»"
bash -c '. "$1"; "$(harness_node_bin)" -e 1' _ "$HELPER"; [ -s "$BASE/wrapper.log" ] && ok "T22 lo que lanza el ayudante corre con el envoltorio" || bad "T22 el envoltorio no se usó"
PATH_BEFORE="$PATH"; bash -c '. "$1"' _ "$HELPER"; [ "$PATH" = "$PATH_BEFORE" ] && ok "T22 cargar el ayudante no cambia el PATH" || bad "T22 cambió el PATH"
if grep -nE "execFileSync\(\s*['\"]node['\"]" "$RAIZ/skills/tycon-pipeline/scripts/dispatch.js" "$RAIZ/skills/tycon-pipeline/scripts/pipeline.js" >/dev/null; then bad "T22 dispatch.js o pipeline.js todavía lanzan execFileSync('node', …)"; else ok "T22 dispatch.js y pipeline.js lanzan con process.execPath"; fi
for h in safety-guard-pre.sh test-scope-guard-pre.sh harness-bootstrap-heal.sh instinct-trigger.sh engram-pre-commit.sh git-pre-commit-global.sh git-pre-push-global.sh; do
  grep -q 'harness-node.sh' "$RAIZ/scripts/hooks/$h" && ok "T22 $h carga el ayudante" || bad "T22 $h no carga scripts/lib/harness-node.sh"
done
grep -q 'harness-node.sh' "$RAIZ/scripts/install-tycon-hooks.sh" && ok "T22 install-tycon-hooks.sh usa el ayudante" || bad "T22 install-tycon-hooks.sh no usa el ayudante"
# con el bash de la Mac (3.2) y `set -e`, `. <archivo que no está> || respaldo` corta el guion entero sin decir nada: quien carga un
# archivo con respaldo (`||` o el error tapado) mira antes que esté. En Linux ese corte no pasa: se mira el texto de todos
# los guiones de shell del árbol, con y sin extensión, y no sólo la corrida.
SIN_MIRAR="$(cd "$RAIZ" && { git ls-files '*.sh'; git ls-files -z | xargs -0 grep -lIE '^#!.*\b(ba)?sh\b' 2>/dev/null; } | sort -u \
  | grep -v '^scripts/tests/' | tr '\n' '\0' | xargs -0 grep -nE '(^|[;&{(]|then|else|do)[[:space:]]*(\.|source)[[:space:]]+["$/~]' 2>/dev/null \
  | grep -E '\|\||2>[[:space:]]*/dev/null' | grep -vE '\[\[? +-[fer] ')"
[ -z "$SIN_MIRAR" ] && ok "T22 ningún guion carga un archivo con respaldo sin mirar antes que esté" \
  || bad "T22 cargan un archivo con respaldo sin mirar antes que esté (el bash de la Mac corta el guion): $SIN_MIRAR"
if [ -x /bin/bash ] && /bin/bash --version 2>/dev/null | head -1 | grep -q 'version 3\.'; then
  got="$(/bin/bash -c 'set -e; _hn=/no/existe/harness-node.sh; { [ -f "$_hn" ] && . "$_hn" 2>/dev/null; } || harness_node_bin() { echo node; }; harness_node_bin')"
  [ "$got" = node ] && ok "T22 con bash 3.2 y sin el ayudante, la forma que mira antes cae al respaldo" || bad "T22 con bash 3.2 la forma que mira antes no cayó al respaldo («${got}»)"
fi
grep -q 'Get-HarnessNode' "$RAIZ/scripts/install-tycon-hooks.ps1" && ok "T22 install-tycon-hooks.ps1 tiene su función del Node del arnés" || bad "T22 install-tycon-hooks.ps1 sin Get-HarnessNode"
for f in bootstrap-fallback.sh bootstrap-fallback.ps1; do
  if git -C "$RAIZ" diff --quiet HEAD -- "scripts/setup/harness/$f" 2>/dev/null; then ok "T22 $f sin cambios (decisión 24)"; else bad "T22 $f cambió"; fi
done
rm -rf "$NDIR"

# ─── T25 · el node del dev no cambia ───────────────────────────────────────────────────────────────────────────────
# @story-8.39 @ac-10  NodeDelDev_NoCambia
dev_before="$(node --version)"; make_dist "$V1"; write_list "$V1"; r="$(hn manual)"
[ "$(node --version)" = "$dev_before" ] && [ "$(command -v node)" = "$REAL_NODE" ] && ok "T25 node --version y command -v node siguen iguales después de bajar" || bad "T25 el node del dev cambió"
if grep -nE "(process\.env|env)\.PATH\s*=|PATH=.*node/current" "$MOD" "$HELPER" >/dev/null; then bad "T25 el módulo o el ayudante escriben el PATH"; else ok "T25 ni el módulo ni el ayudante escriben el PATH"; fi
mkdir -p "$BASE/devrepo/.githooks"; printf '#!/bin/sh\nnode --version > "%s"\n' "$BASE/devrepo.out" > "$BASE/devrepo/.githooks/pre-commit"; chmod +x "$BASE/devrepo/.githooks/pre-commit"
( cd "$BASE/devrepo" && . "$HELPER" && ./.githooks/pre-commit )
[ "$(cat "$BASE/devrepo.out")" = "$dev_before" ] && ok "T25 el hook del repo del dev ve el node del PATH" || bad "T25 el hook del repo vio $(cat "$BASE/devrepo.out")"

# ─── las funciones del módulo, de a una (revisión de cobertura de la vuelta 1) ─────────────────────────────────────
# @story-8.39 @ac-1 @ac-5 @ac-14 @ac-20  readList · entryFor · formFor · noticeFor · countHooks · doctorFacts · readRecord
UNIT="$(node -e '
const H = require(process.argv[1]); const fs = require("fs"); const path = require("path"); const base = process.argv[2];
const bad = [];
const t = (cond, what) => { if (!cond) bad.push(what); };
// readList: ilegible y sin campos son «no pude leer», nunca una lista vacía
fs.mkdirSync(path.join(base, "u1", "scripts", "production"), { recursive: true });
t(/no está en/.test(H.readList(path.join(base, "nada")).reason), "readList sin archivo");
fs.writeFileSync(path.join(base, "u1", "scripts", "production", "node-official.json"), "{ roto");
t(/no pude leer node-official.json/.test(H.readList(path.join(base, "u1")).reason), "readList roto");
fs.writeFileSync(path.join(base, "u1", "scripts", "production", "node-official.json"), JSON.stringify({ version: "v24.21.0", files: {} }));
t(/le falta/.test(H.readList(path.join(base, "u1")).reason), "readList sin base_url");
// entryFor: entrada válida, incompleta, ausente, Linux sin glibc
const sha = "a".repeat(64);
const list = { files: { "linux-x64": { tar: "x.tar.gz", sha256: sha, node_sha256: sha }, "darwin-x64": { tar: "y.tar.gz", sha256: sha }, "win-x64": { exe: "win-x64/node.exe", sha256: sha } } };
t(H.entryFor({ key: "linux-x64", glibc: true }, list).kind === "tar", "entryFor válida");
t(H.entryFor({ key: "darwin-x64", glibc: true }, list) === null, "entryFor sin node_sha256");
t(H.entryFor({ key: "win-x64", glibc: true }, list).binarySha === sha, "entryFor exe: la huella del binario es la del exe");
t(H.entryFor({ key: "linux-ppc64", glibc: true }, list) === null, "entryFor ausente");
t(H.entryFor({ key: "linux-x64", glibc: false }, list) === null, "entryFor sin glibc");
// formFor: las formas del AC 5
t(H.formFor("/home/dev/.tycon/node/current/bin/node", "linux").prefix === "/home/dev/.tycon/node/current/bin/node", "formFor posix sin comillas");
t(H.formFor("/home/mi casa/.tycon/node/current/bin/node", "linux").prefix === "\"/home/mi casa/.tycon/node/current/bin/node\"", "formFor posix con espacios");
t(H.formFor("/home/ca$a/.tycon/node/current/bin/node", "linux").prefix === "node", "formFor posix con $");
t(H.formFor("C:\\Users\\dev\\.tycon\\node\\current\\node.exe", "win32").prefix === (H.WINDOWS_FORM.measured ? "C:/Users/dev/.tycon/node/current/node.exe" : "node"), "formFor windows");
t(H.formFor("C:/Users/Nombre Apellido/.tycon/node/current/node.exe", "win32").prefix === "node", "formFor windows con espacio (decisión 22)");
// noticeFor: el texto del AC 11
t(/^el arnés corre con el Node del PATH \(v[\d.]+\): no pude bajar su Node propio \(sin red\) — harness\.js doctor lo detalla$/.test(H.noticeFor("sin red")), "noticeFor");
// countHooks: propios, con node, la línea de arranque y CodeGraph no cuentan, ilegible ≠ ausente
const s = path.join(base, "settings.json");
const own = { own: true, prefix: "/h/.tycon/node/current/bin/node" };
fs.writeFileSync(s, JSON.stringify({ hooks: { Stop: [{ hooks: [
  { command: "/h/.tycon/node/current/bin/node \"/h/.claude/tycon-harness/scripts/hooks/a.js\"" },
  { command: "node \"/h/.claude/tycon-harness/scripts/hooks/b.js\"" },
  { command: "node \"/h/.claude/.tycon-pipeline/harness/bootstrap.js\"" },
  { command: "node \"/h/.claude/tycon-harness/scripts/hooks/codegraph-hook.js\"" },
  { command: "bash \"/h/.claude/tycon-harness/scripts/hooks/c.sh\"" },
] }] } }));
const c = H.countHooks(s, own);
t(c && c.own === 1 && c.path_node === 1 && c.total === 2, "countHooks: " + JSON.stringify(c));
t(H.countHooks(path.join(base, "no-hay.json"), own) === null, "countHooks sin archivo");
fs.writeFileSync(s, "{ roto");
t(H.countHooks(s, own) && H.countHooks(s, own).unreadable, "countHooks ilegible");
// doctorFacts: apagado es un dato (info), nunca warn ni fail; lista ilegible es warn con motivo
const off = H.doctorFacts({ tree: path.join(base, "u1"), env: Object.assign({}, process.env, { TYCON_HARNESS_NODE: "0" }) });
t(off.level === "info" && off.json.switch === "off", "doctorFacts apagado");
fs.writeFileSync(path.join(base, "u1", "scripts", "production", "node-official.json"), "{ roto");
const rota = H.doctorFacts({ tree: path.join(base, "u1"), env: process.env, settingsFile: s });
t(rota.level === "warn" && /no pude leer/.test(rota.json.reason), "doctorFacts lista rota");
// listedHookPaths: los .js de la lista, con la ruta en su repo; sin lista, null (no «ninguno»)
fs.mkdirSync(path.join(base, "u2", "scripts", "setup"), { recursive: true });
fs.writeFileSync(path.join(base, "u2", "scripts", "setup", "hooks-list.json"), JSON.stringify({ hooks: [{ spec: "@tcg:a.js" }, { spec: "tycon-pipeline/scripts/b.js" }, { spec: "@tcg:c.sh" }] }));
t(JSON.stringify(H.listedHookPaths(path.join(base, "u2"))) === JSON.stringify(["scripts/hooks/a.js", "skills/tycon-pipeline/scripts/b.js"]), "listedHookPaths");
t(H.listedHookPaths(path.join(base, "no-hay")) === null, "listedHookPaths sin lista");
// probe: un binario que no está, uno que dice su versión y uno que sale 1
const pb = path.join(base, "pb"); fs.writeFileSync(pb, "#!/bin/sh\necho v24.21.0\n"); fs.chmodSync(pb, 0o755);
const pm = path.join(base, "pm"); fs.writeFileSync(pm, "#!/bin/sh\necho roto >&2\nexit 1\n"); fs.chmodSync(pm, 0o755);
t(H.probe(path.join(base, "nada-bin"), { cache: false }).ok === false, "probe sin binario");
t(H.probe(pb, { cache: false }).version === "v24.21.0", "probe sano");
t(/no arranca/.test(H.probe(pm, { cache: false }).reason || ""), "probe roto");
process.stdout.write(bad.join(" · "));' "$HN" "$BASE/unit" 2>&1)"
[ -z "$UNIT" ] && ok "unidades: readList, entryFor, formFor, noticeFor, countHooks y doctorFacts dicen lo que el AC pide" || bad "unidades: $UNIT"
# readRecord: uno que no se puede leer no es «vacío», y con él no se borra ninguna versión vieja
mkdir -p "$NDIR/versions/v1.0.0/bin" "$NDIR/versions/$V1/bin"; ln -s "versions/$V1" "$NDIR/current"
RECF="$(node -e 'const p=require(process.argv[1]).paths(require("os").homedir());process.stdout.write(p.harnessNodeFile)' "$TREE/scripts/setup/harness/state.js")"
mkdir -p "$(dirname "$RECF")"; printf '{ roto' > "$RECF"
[ -n "$(field "$(record)" unreadable)" ] && ok "readRecord: el registro roto vuelve «ilegible», no vacío" || bad "readRecord roto: $(record)"
make_dist "$V1"; write_list "$V1"; hn startup >/dev/null
[ -d "$NDIR/versions/v1.0.0" ] && ok "con el registro ilegible no se borra ninguna versión vieja" || bad "se borró una versión vieja con el registro ilegible"
# (revisores, vuelta 2) una falla escrita sobre el registro ilegible no lo pisa ni hace que la corrida siguiente borre la
# versión guardada: el roto se aparta y, sin saber cuál es la anterior, no se borra nada
printf '{ roto' > "$RECF"; make_dist "$V2"; write_list "$V2"; printf '500\n' > "$MODE"
TYCON_HARNESS_NODE_BUDGET_S=2 hn manual >/dev/null; echo ok > "$MODE"
ls "$RECF".ilegible-* >/dev/null 2>&1 && ok "el registro ilegible se aparta, no se pisa" || bad "el registro ilegible se pisó sin apartarlo"
hn startup >/dev/null
[ -d "$NDIR/versions/v1.0.0" ] && ok "sin la versión anterior anotada, la corrida siguiente no borra versiones" || bad "la corrida siguiente borró una versión sin saber cuál era la anterior"
rm -rf "$NDIR"; rm -f "$RECF" "$RECF".ilegible-*

# ─── T15 (completo) · current roto: el aplicador vuelve los hooks a node en esa misma corrida ─────────────────────
# @story-8.39 @ac-16  con el Node del arnés roto, el aplicador de Claude Code escribe `node "<guion>"` en su lugar
mkdir -p "$BASE/t15/hooks" "$BASE/t15/skills" "$BASE/t15/home/.claude"
printf '// hook\n' > "$BASE/t15/hooks/s.js"
printf '{"hooks":[{"event":"Stop","matcher":"","spec":"@tcg:s.js","label":"x","when":"always","platforms":{"windows":true}}],"superseded":[],"legacy_fragments":[]}\n' > "$BASE/t15/list.json"
mkdir -p "$NDIR/versions/$V1/bin"; printf '#!/bin/sh\nexit 1\n' > "$NDIR/versions/$V1/bin/node"; chmod +x "$NDIR/versions/$V1/bin/node"; ln -s "versions/$V1" "$NDIR/current"
printf '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"%s \\"%s\\""}]}]}}\n' "$NDIR/current/bin/node" "$BASE/t15/hooks/s.js" > "$BASE/t15/home/.claude/settings.json"
TYCON_PROFILE=0 TYCON_HARNESS_SHARED_DONE=1 node "$RAIZ/scripts/setup/apply-hooks.js" --settings "$BASE/t15/home/.claude/settings.json" --hooks-dir "$BASE/t15/hooks" --skills "$BASE/t15/skills" \
  --list "$BASE/t15/list.json" --effects "$RAIZ/scripts/setup/install-effects.json" >/dev/null 2>&1
[ "$(node -e 'const s=require(process.argv[1]);process.stdout.write(s.hooks.Stop[0].hooks.map(h=>h.command).join("|"))' "$BASE/t15/home/.claude/settings.json")" = "node \"$BASE/t15/hooks/s.js\"" ] \
  && ok "T15 con current roto el aplicador vuelve el hook a node, en su lugar y sin duplicar" || bad "T15 el aplicador dejó: $(cat "$BASE/t15/home/.claude/settings.json")"
rm -rf "$NDIR"

# ─── lo que confirmó el pase adversarial (una prueba por clase; nacen en rojo, el arreglo las pone en verde) ─────────
# A y B · las llamadas de fondo de los instaladores también van con el Node del arnés (AC 8): la tanda `nohup bash -c` del
# .sh abre otro bash que no ve la función `node`, y `Start-Process` del .ps1 busca el programa en el PATH
LOTE="$(awk "/^  nohup bash -c '\$/{on=1} on{print} on && /^  ' _ /{exit}" "$RAIZ/scripts/install-tycon-hooks.sh")"
[ -n "$LOTE" ] && ! printf '%s\n' "$LOTE" | grep -qE '(^|[^"$A-Za-z_])node "' && ok "adversarial A: la tanda de fondo del .sh no llama a node pelado" || bad "adversarial A: la tanda de fondo del .sh llama a node del PATH: $(printf '%s\n' "$LOTE" | grep -E '(^|[^"$A-Za-z_])node "' | head -2)"
grep -q "FilePath = 'node'" "$RAIZ/scripts/install-tycon-hooks.ps1" && bad "adversarial B: Start-Process del .ps1 con FilePath = 'node' (busca en el PATH)" || ok "adversarial B: Start-Process del .ps1 usa el Node del arnés si está"
# C · una carpeta de bajada que dejó un proceso muerto se barre (sólo las de procesos que ya no existen)
make_dist "$V1"; write_list "$V1"; rm -rf "$NDIR"; hn manual >/dev/null
mkdir -p "$NDIR/.incoming-99999999"; printf 'resto' > "$NDIR/.incoming-99999999/download"
mkdir -p "$NDIR/.incoming-$$"
hn startup >/dev/null
[ ! -e "$NDIR/.incoming-99999999" ] && ok "adversarial C: la .incoming de un proceso muerto se barre" || bad "adversarial C: quedó la .incoming huérfana"
[ -d "$NDIR/.incoming-$$" ] && ok "adversarial C: la de un proceso vivo no se toca" || bad "adversarial C: se borró la .incoming de un proceso vivo"
rm -rf "$NDIR/.incoming-$$"
# G · con la versión ya en versions/ (sana: su huella y su --version) y sin current, se re-enlaza sin bajar nada
rm -f "$NDIR/current"; before="$(reqs)"; r="$(hn manual)"
[ "$(reqs)" = "$before" ] && [ "$(target)" = "$V1" ] && ok "adversarial G: la versión sana que ya estaba se re-enlaza sin pedir nada ($(field "$r" status))" || bad "adversarial G: pidió $(( $(reqs) - before )) vez/veces o no enlazó: $r"
# E · una TYCON_HOME relativa o vacía no tumba al intérprete ni al aplicador: el Node del PATH, con el motivo
e1="$(TYCON_HOME=relativa node -e 'process.stdout.write(JSON.stringify(require(process.argv[1]).interpreter({ tree: process.argv[2] })))' "$HN" "$TREE" 2>&1)"
[ "$(field "$e1" own)" = "false" ] && [ "$(field "$e1" prefix)" = "node" ] && ok "adversarial E: TYCON_HOME relativa → node, sin tirar ($(field "$e1" reason))" || bad "adversarial E: interpreter con TYCON_HOME relativa: $e1"
TYCON_HOME=relativa TYCON_PROFILE=0 TYCON_HARNESS_SHARED_DONE=1 node "$RAIZ/scripts/setup/apply-hooks.js" --settings "$BASE/t15/home/.claude/settings.json" --hooks-dir "$BASE/t15/hooks" --skills "$BASE/t15/skills" \
  --list "$BASE/t15/list.json" --effects "$RAIZ/scripts/setup/install-effects.json" >/dev/null 2>"$BASE/e.err"
[ $? -eq 0 ] && ok "adversarial E: el aplicador con TYCON_HOME relativa sale 0 y registra" || bad "adversarial E: el aplicador cayó: $(head -2 "$BASE/e.err")"
# E (Windows) · Get-HarnessNode del instalador .ps1: una TYCON_HOME relativa → ninguno (el Node del PATH); una absoluta con
# current → su binario. Corre la función tal como está en el .ps1; sin pwsh en la máquina, NO MEDIDO (no un verde)
if command -v pwsh >/dev/null 2>&1; then
  mkdir -p "$NDIR/versions/$V1/bin"; printf '#!/bin/sh\necho %s\n' "$V1" > "$NDIR/versions/$V1/bin/node"; chmod +x "$NDIR/versions/$V1/bin/node"; ln -s "versions/$V1" "$NDIR/current"
  PSF='$s = Get-Content -Raw $env:PS1; $i = $s.IndexOf("function Get-HarnessNode"); $j = $s.IndexOf("`$script:HarnessNode = Get-HarnessNode"); function Get-TyconHome { $env:HOME }; Invoke-Expression ($s.Substring($i, $j - $i)); $r = Get-HarnessNode; if ($r) { $r } else { "NINGUNO" }'
  rel="$(PS1="$RAIZ/scripts/install-tycon-hooks.ps1" TYCON_HOME=relativa pwsh -NoProfile -NonInteractive -Command "$PSF" 2>&1 | tail -1)"
  abs="$(PS1="$RAIZ/scripts/install-tycon-hooks.ps1" pwsh -NoProfile -NonInteractive -Command "$PSF" 2>&1 | tail -1)"
  [ "$rel" = NINGUNO ] && ok "adversarial E (.ps1): TYCON_HOME relativa → el Node del PATH" || bad "adversarial E (.ps1): con TYCON_HOME relativa devolvió «${rel}»"
  [ "$abs" = "$NDIR/current/bin/node" ] && ok "adversarial E (.ps1): con la casa absoluta, el binario de current" || bad "adversarial E (.ps1): con la casa absoluta devolvió «${abs}»"
  rm -rf "$NDIR"
else
  echo "⚪ harness-node: adversarial E (.ps1) NO MEDIDO: no hay pwsh en esta máquina"
fi
# D y F · doctor cuenta sólo los hooks del arnés de la lista (no un hook de otra pieza, como el barrido del reloj) y
# avisa un hook del arnés con OTRO Node (una ruta vieja o que ya no existe), que no es ni el propio ni el del PATH
DF="$(node -e '
const H = require(process.argv[1]); const fs = require("fs"); const path = require("path"); const base = process.argv[2];
const s = path.join(base, "df-settings.json");
const own = "/h/.tycon/node/current/bin/node";
fs.writeFileSync(s, JSON.stringify({ hooks: { Stop: [{ hooks: [
  { command: own + " \"/h/.claude/tycon-harness/scripts/hooks/a.js\"" },
  { command: "node \"/h/.claude/agent-skills/skills/clocki/scripts/sweep.js\"" },
  { command: "/viejo/.tycon/node/current/bin/node \"/h/.claude/tycon-harness/scripts/hooks/b.js\"" },
] }] } }));
const c = H.countHooks(s, { own: true, prefix: own }, ["scripts/hooks/a.js", "scripts/hooks/b.js", "skills/tycon-pipeline/scripts/x.js"]);
process.stdout.write(JSON.stringify(c));' "$HN" "$BASE" 2>&1)"
[ "$(field "$DF" total)" = 2 ] && ok "adversarial F: el barrido del reloj (fuera de la lista) no cuenta como hook del arnés" || bad "adversarial F: countHooks contó: $DF"
[ "$(field "$DF" other)" = 1 ] && ok "adversarial D: el hook con otro Node se cuenta aparte" || bad "adversarial D: countHooks no separa el otro Node: $DF"
DFL="$(node -e '
const H = require(process.argv[1]);
process.stdout.write(H.doctorLevel({ own: true, verified: true }, { own: 1, path_node: 0, other: 1, total: 2 }));' "$HN" 2>&1)"
[ "$DFL" = warn ] && ok "adversarial D: con un hook en otro Node, doctor avisa (warn), no ok" || bad "adversarial D: el nivel con un hook en otro Node es «${DFL}»"
rm -rf "$NDIR"

# ─── el contador de hooks del ensayo de Windows (count-hooks.js) reconoce el intérprete escrito como ruta sin comillas
# @story-8.39 @ac-27  sin esto, el ensayo contaba 0 hooks «en su lugar» en una máquina con el Node del arnés
CF="$(node -e 'const C=require(process.argv[1]);process.stdout.write(JSON.stringify([C.commandFile("C:/U/.tycon/node/current/node.exe \"C:/x/y.js\"").runner, C.commandFile("/h/.tycon/node/current/bin/node \"/x/y.js\"").runner, C.commandFile("node \"/x/y.js\"").runner, C.commandFile("bash -c \"x\"").runner]))' "$RAIZ/scripts/tests/windows/count-hooks.js" 2>&1)"
[ "$CF" = '["node","node","node",null]' ] && ok "count-hooks: la ruta del Node del arnés sin comillas cuenta como node (y bash -c no es un hook)" || bad "count-hooks: $CF"

# ─── el laboratorio de la página guiada arma su ambiente de cero: conserva el apagado de quien lo lanza, y si no estaba
# no lo agrega (en el ensayo de Windows la bajada es lo que se mide) — decisión 20
TL="$(node -e '
const T = require(process.argv[1]); const os = require("os"); const path = require("path");
const h = path.join(os.tmpdir(), "toy-lab-env-839");
const off = T.variantEnv(h, { base: Object.assign({}, process.env, { TYCON_HARNESS_NODE: "0" }), api: "http://127.0.0.1:1" }).env.TYCON_HARNESS_NODE;
const b = Object.assign({}, process.env); delete b.TYCON_HARNESS_NODE;
const on = T.variantEnv(h, { base: b, api: "http://127.0.0.1:1" }).env.TYCON_HARNESS_NODE;
process.stdout.write(JSON.stringify([off, on === undefined ? null : on]));' "$RAIZ/scripts/tests/windows/toy-lab.js" 2>&1)"
[ "$TL" = '["0",null]' ] && ok "toy-lab: conserva TYCON_HARNESS_NODE=0 de quien lo lanza y no lo agrega si no estaba" || bad "toy-lab variantEnv: $TL"

# ─── T26 · la mudanza a ~/.tycon no se niega por el Node del arnés ─────────────────────────────────────────────────
# @story-8.39 @ac-19  Mudanza_ConNodeDelArnes_NoSeNiega (por lectura y con la función de precondiciones; la mudanza entera
# la corre harness-move-home.test.sh en la CI: nunca a mano en una máquina ya mudada)
t26="$(node -e '
const M = require(process.argv[1]);
process.stdout.write(M.OWN_ENTRIES.includes("node") ? "ok" : "falta node en OWN_ENTRIES");' "$RAIZ/scripts/setup/harness/move-home.js" 2>&1)"
[ "$t26" = ok ] && ok "T26 move-home.js#OWN_ENTRIES trae node: la mudanza no dice «no es nuestra: trae node»" || bad "T26 $t26"

# ─── T34 · las suites que lanzan harness.js apagan la bajada ───────────────────────────────────────────────────────
# @story-8.39 @ac-26  Suites_QueLanzanHarnessJs_ApaganLaBajada
missing="$(cd "$RAIZ/scripts/tests" && for f in *.sh *.js; do
  [ "$f" = "harness-node.test.sh" ] && continue
  # lanza un harness.js (el real o el de una copia): un spawn que lo nombra, o una línea de shell que lo corre con un subcomando
  # (doctor y config no bajan nada: no cuentan)
  grep -E "(spawnSync|execFileSync|spawn)\(.*(harness\.js|\[HARNESS\b|'harness\.js')|^[[:space:]]*(node|harness) .*harness\.js\"? (install|update|apply|startup)" "$f" | grep -vqE "'(doctor|config)'" || continue
  grep -qE 'harness-lab\.sh|fake-home\.sh|TYCON_HARNESS_NODE' "$f" || echo "$f"
done)"
[ -z "$missing" ] && ok "T34 toda suite que lanza un harness.js apaga la bajada (o carga el laboratorio)" || bad "T34 lanzan un harness.js sin TYCON_HARNESS_NODE=0 ni el laboratorio: $(echo $missing)"
for f in clean-machine.test.sh installer-ps1.test.sh windows-guided-lab.test.js harness-relocate.test.js; do
  grep -q 'TYCON_HARNESS_NODE' "$RAIZ/scripts/tests/$f" && ok "T34 $f apaga la bajada (decisión 20)" || bad "T34 $f no apaga la bajada (decisión 20)"
done
grep -q 'TYCON_HARNESS_NODE=0' "$RAIZ/scripts/tests/lib/harness-lab.sh" && grep -q 'TYCON_HARNESS_NODE=0' "$RAIZ/scripts/tests/lib/fake-home.sh" && ok "T34 harness-lab.sh y fake-home.sh exportan el apagado" || bad "T34 el laboratorio no exporta TYCON_HARNESS_NODE=0"

echo "harness-node: $FALLAS fallas"
[ "$FALLAS" -eq 0 ]
