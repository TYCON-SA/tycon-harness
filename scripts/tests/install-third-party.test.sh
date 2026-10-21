#!/usr/bin/env bash
# install-third-party.test.sh — el paso del instalador que restituye las skills de terceros (T7-T18).
#
# Lo que no se puede perder:
#   · Que restituya SIN RED desde la historia de git del clon (el contenido que el pull del retiro acaba de borrar
#     sigue en los objetos), y desde el origen sólo si lo que baja da el árbol declarado.
#   · Que NUNCA borre ni pise lo que no escribió él; que un corte a mitad deje archivos enteros; que dos arranques a la
#     vez no se pisen; que la red no pase su tope; que «no pude preguntar» no se confunda con «no existe».
#   · Que el instalador real lo corra y su aviso se vea con stderr descartado (así lo corre la línea de arranque).
#
# Laboratorio: HOME y repos bajo `mktemp -d /tmp/tycon-terceros.XXXXXX` (nunca bajo una ruta del arnés); orígenes =
# repos locales con commits armados acá (AcmeCorp); red bloqueada con GIT_ALLOW_PROTOCOL=file salvo donde el caso pide
# una URL que no responde. Manifiestos SINTÉTICOS por --manifest; nunca el real. T7 corre el instalador de verdad con
# LAUNCHCTL_BIN de mentira, TYCON_NO_NIGHTLY_EXAM=1 y TYCON_NO_GUI_ENV=1 SÓLO en esa llamada.
# 🔴 Sin pipes sobre el comando medido: el exit code REAL es el veredicto.
set -u
TCG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STEP="$TCG/scripts/publishing/install-third-party.js"
BASE="$(mktemp -d /tmp/tycon-terceros.XXXXXX)"
node "$TCG/scripts/tests/lib/lab-guard.js" "$BASE" install-third-party || exit 1
SRV_PID=""
trap '[ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null; rm -rf "$BASE"' EXIT
FALLAS=0
ok() { echo "✅ install-third-party: $1"; }
bad() { echo "❌ install-third-party: $1"; FALLAS=$((FALLAS + 1)); }
g() { env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u GIT_COMMON_DIR GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
  GIT_AUTHOR_NAME=Lab GIT_AUTHOR_EMAIL=lab@example.com GIT_COMMITTER_NAME=Lab GIT_COMMITTER_EMAIL=lab@example.com \
  git -c core.hooksPath=/dev/null "$@"; }
ms() { node -e 'console.log(Date.now())'; }
# hash de árbol de git del contenido de una carpeta en disco (sin tocar la carpeta)
tree_of() {
  local d="$1" t; t="$(mktemp -d "$BASE/tree.XXXXXX")"
  g init -q "$t/r" && g --git-dir="$t/r/.git" --work-tree="$d" add -A && g --git-dir="$t/r/.git" write-tree
  rm -rf "$t"
}
# el árbol que tiene que quedar: <repo> <commit> <ruta> y los archivos a omitir
expected_tree() {
  local repo="$1" commit="$2" p="$3"; shift 3
  local idx="$BASE/idx.$$"; rm -f "$idx"
  GIT_INDEX_FILE="$idx" g -C "$repo" read-tree "$commit:$p" || return 1
  for f in "$@"; do GIT_INDEX_FILE="$idx" g -C "$repo" rm -q --cached "$f" >/dev/null || return 1; done
  GIT_INDEX_FILE="$idx" g -C "$repo" write-tree; rm -f "$idx"
}
# manifiesto sintético: <archivo> <retirement> <origin> <commit> <tree> [official-plugin]
manifest() {
  node -e '
const [file, retirement, origin, commit, tree, plugin] = process.argv.slice(1);
const m = { retirement, own: [{ glob: "skills/zorblax-*", why: "del equipo de prueba" }, { glob: ".gitignore", why: "del repo" }],
  derived: [], origins: {}, third_party: [{ target: "skills/acme-helper", origin, commit, path: "skills/acme-helper", tree,
    omit: [{ file: "notes/extra1.md", reason: "del desarrollo" }, { file: "extra2.md", reason: "del desarrollo" }],
    license: "MIT", license_source: "LICENSE del repo", copyright: "Copyright (c) 2026 AcmeCorp", install: "download", used_by: [], why: "ajena de prueba" }] };
if (process.env.EXTRA_TREE) m.third_party.push({ target: "skills/acme-extra", origin, commit, path: "skills/acme-extra", tree: process.env.EXTRA_TREE,
  omit: [], license: "MIT", license_source: "LICENSE del repo", copyright: "Copyright (c) 2026 AcmeCorp", install: "download", used_by: [], why: "segunda de prueba" });
if (plugin) m.third_party.push({ target: "skills/acme-docs", origin, commit, license: "LicenseRef-Proprietary",
  license_source: "LICENSE.txt de la carpeta", copyright: "(c) AcmeCorp", install: "official-plugin", plugin: "acme-docs@acme-marketplace", used_by: [], why: "propietaria de prueba" });
require("fs").writeFileSync(file, JSON.stringify(m, null, 2));' "$@"
}
# el paso, como lo corre el instalador: HOME de laboratorio, red bloqueada salvo lo que el caso pida
step() { # step <home> <repo> <manifest> [VAR=valor...]
  local h="$1" r="$2" m="$3"; shift 3
  env -i HOME="$h" PATH="$PATH" TMPDIR="$BASE/tmp" LANG="${LANG:-en_US.UTF-8}" GIT_ALLOW_PROTOCOL=file GIT_TERMINAL_PROMPT=0 \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null "$@" node "$STEP" --repo "$r" --manifest "$m"
}
mkdir -p "$BASE/tmp"

# ── el origen: AcmeCorp publica su skill con dos archivos de desarrollo que agent-skills nunca tuvo ─────────────────
O="$BASE/origin-work"; g init -q -b main "$O"
mkdir -p "$O/skills/acme-helper/ref" "$O/skills/acme-helper/notes"
printf 'name: acme-helper\n' > "$O/skills/acme-helper/SKILL.md"
printf 'referencia v1\n' > "$O/skills/acme-helper/ref/a.md"
printf 'otra referencia\n' > "$O/skills/acme-helper/ref/b.md"
printf 'uno\n' > "$O/skills/acme-helper/ref/c.md"
printf '#!/bin/sh\necho acme\n' > "$O/skills/acme-helper/run.sh"; chmod +x "$O/skills/acme-helper/run.sh"
printf 'dev\n' > "$O/skills/acme-helper/notes/extra1.md"; printf 'dev\n' > "$O/skills/acme-helper/extra2.md"
mkdir -p "$O/skills/acme-extra"; printf 'name: acme-extra\n' > "$O/skills/acme-extra/SKILL.md"   # una segunda skill, para los casos de a varias
g -C "$O" add -A && g -C "$O" commit -q -m v1; C1="$(g -C "$O" rev-parse HEAD)"
printf 'name: acme-helper\nversion: 2\n' > "$O/skills/acme-helper/SKILL.md"; printf 'referencia v2\n' > "$O/skills/acme-helper/ref/a.md"
g -C "$O" commit -q -am v2; C2="$(g -C "$O" rev-parse HEAD)"
printf 'name: acme-helper-otra\n' > "$O/skills/acme-helper/SKILL.md"; g -C "$O" commit -q -am distinta; CBAD="$(g -C "$O" rev-parse HEAD)"
g clone -q --bare "$O" "$BASE/origin.git"
ORIGIN="file://$BASE/origin.git"
T1="$(expected_tree "$O" "$C1" skills/acme-helper notes/extra1.md extra2.md)"
T2="$(expected_tree "$O" "$C2" skills/acme-helper notes/extra1.md extra2.md)"
TX="$(expected_tree "$O" "$C1" skills/acme-extra)"

# ── agent-skills de laboratorio: la versionaba (commit A) y la retiró (commit B) ────────────────────────────────────
AS_SRC="$BASE/as-src"; g init -q -b main "$AS_SRC"
mkdir -p "$AS_SRC/skills/zorblax-own"; printf 'propia\n' > "$AS_SRC/skills/zorblax-own/SKILL.md"
g -C "$O" archive "$C1" skills/acme-helper skills/acme-extra | tar -x -C "$AS_SRC"
rm -rf "$AS_SRC/skills/acme-helper/notes" "$AS_SRC/skills/acme-helper/extra2.md"
g -C "$AS_SRC" add -A && g -C "$AS_SRC" commit -q -m A
[ "$(g -C "$AS_SRC" rev-parse HEAD:skills/acme-helper)" = "$T1" ] || { bad "fixture: el árbol versionado no es el esperado"; exit 1; }
g -C "$AS_SRC" rm -q -r skills/acme-helper skills/acme-extra && printf 'skills/acme-helper/\nskills/acme-docs/\nskills/acme-extra/\n' > "$AS_SRC/.gitignore" \
  && g -C "$AS_SRC" add .gitignore && g -C "$AS_SRC" commit -q -m 'B: retiro'
with_history() { g clone -q "$AS_SRC" "$1"; }          # un clon que tuvo la skill versionada (la historia la tiene)
without_history() {                                      # un clon nuevo, sólo con el estado de hoy (la copia pública)
  g init -q -b main "$1" && g -C "$AS_SRC" archive HEAD | tar -x -C "$1" && g -C "$1" add -A && g -C "$1" commit -q -m hoy
}
UNREACHABLE="https://127.0.0.1:9/acme/skills.git"

# ═══ T9 · desde la historia local, sin red ═══════════════════════════════════════════════════════════════════════════
H="$BASE/h9"; mkdir -p "$H"; R="$BASE/r9"; with_history "$R"; M="$BASE/m9.json"; manifest "$M" done "$UNREACHABLE" "$C1" "$T1"
out="$(step "$H" "$R" "$M" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && [ "$(tree_of "$R/skills/acme-helper")" = "$T1" ] && ! grep -qi 'no pude preguntar' <<<"$out"; then
  ok "T9 destino borrado, red caída: restituido desde la historia local con el mismo árbol"
else bad "T9 (rc=$rc): $out"; fi

# ═══ T8 · al día: no escribe, no abre la red, menos de 1 s ═══════════════════════════════════════════════════════════
touch "$BASE/stamp8"; sleep 1
t0=$(ms); out1="$(step "$H" "$R" "$M" 2>&1)"; rc1=$?; t1=$(ms); out2="$(step "$H" "$R" "$M" 2>&1)"; rc2=$?; t2=$(ms)
nuevos="$(find "$R/skills/acme-helper" -newer "$BASE/stamp8" | wc -l | tr -d ' ')"
if [ "$rc1" -eq 0 ] && [ "$rc2" -eq 0 ] && [ "$nuevos" = 0 ] && [ $((t1 - t0)) -lt 1000 ] && [ $((t2 - t1)) -lt 1000 ] \
   && ! grep -qiE 'no pude preguntar|restitu' <<<"$out1$out2"; then
  ok "T8 al día: dos ejecuciones sin escribir nada ni abrir la red ($((t1 - t0)) ms y $((t2 - t1)) ms)"
else bad "T8 (rc $rc1/$rc2, archivos nuevos $nuevos, $((t1 - t0))/$((t2 - t1)) ms): $out1 | $out2"; fi

# ═══ T10 · sin historia: desde el origen, sin los omitidos y con el árbol verificado ═════════════════════════════════
H="$BASE/h10"; mkdir -p "$H"; R="$BASE/r10"; without_history "$R"; M="$BASE/m10.json"; manifest "$M" done "$ORIGIN" "$C1" "$T1"
out="$(step "$H" "$R" "$M" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && [ "$(tree_of "$R/skills/acme-helper")" = "$T1" ] && [ ! -e "$R/skills/acme-helper/extra2.md" ] && [ -x "$R/skills/acme-helper/run.sh" ]; then
  ok "T10 sin historia: bajado del origen file://, sin los dos omitidos, con el árbol declarado (y run.sh ejecutable)"
else bad "T10 (rc=$rc, árbol $(tree_of "$R/skills/acme-helper" 2>/dev/null)): $out"; fi

# ═══ T11 · el origen no coincide: no escribe nada ════════════════════════════════════════════════════════════════════
H="$BASE/h11"; mkdir -p "$H"; R="$BASE/r11"; without_history "$R"; M="$BASE/m11.json"; manifest "$M" done "$ORIGIN" "$CBAD" "$T1"
out="$(step "$H" "$R" "$M" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && [ ! -e "$R/skills/acme-helper" ] && grep -q 'el origen no coincide' <<<"$out" && grep -q 'skills/acme-helper' <<<"$out"; then
  ok "T11 un origen cuyo contenido no da el árbol no se instala y se nombra"
else bad "T11 (rc=$rc): $out"; fi

# ═══ T12 · no pisa lo del dev ════════════════════════════════════════════════════════════════════════════════════════
H="$BASE/h12"; mkdir -p "$H"; R="$BASE/r12"; with_history "$R"; M="$BASE/m12.json"; manifest "$M" done "$UNREACHABLE" "$C1" "$T1"
D="$R/skills/acme-helper"; mkdir -p "$D/ref"
printf 'de un BMAD más nuevo\n' > "$D/mio.md"                 # de más
printf 'lo toqué a mano\n' > "$D/SKILL.md"                     # declarado, modificado
printf 'referencia v1\n' > "$D/ref/a.md"                       # igual
printf '#!/bin/sh\necho acme\n' > "$D/run.sh"; chmod +x "$D/run.sh"
out="$(step "$H" "$R" "$M" 2>&1)"; rc=$?                         # faltan ref/b.md y ref/c.md
if [ "$rc" -eq 0 ] && [ "$(cat "$D/mio.md")" = 'de un BMAD más nuevo' ] && [ "$(cat "$D/SKILL.md")" = 'lo toqué a mano' ] \
   && [ -f "$D/ref/b.md" ] && [ -f "$D/ref/c.md" ] && grep -q 'modificado localmente' <<<"$out" && grep -q 'SKILL.md' <<<"$out"; then
  ok "T12 el de más y el modificado quedan intactos (el modificado, nombrado); los dos faltantes se escriben"
else bad "T12 (rc=$rc): $out"; fi

# ═══ T13 · cambio de commit: reemplaza sólo lo suyo y sin tocar ══════════════════════════════════════════════════════
H="$BASE/h13"; mkdir -p "$H"; R="$BASE/r13"; without_history "$R"; M="$BASE/m13.json"; manifest "$M" done "$ORIGIN" "$C1" "$T1"
step "$H" "$R" "$M" >/dev/null 2>&1
printf 'referencia mía\n' > "$R/skills/acme-helper/ref/a.md"       # el dev toca uno que el paso escribió
manifest "$M" done "$ORIGIN" "$C2" "$T2"
out="$(step "$H" "$R" "$M" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && grep -q 'version: 2' "$R/skills/acme-helper/SKILL.md" && [ "$(cat "$R/skills/acme-helper/ref/a.md")" = 'referencia mía' ] \
   && grep -q 'modificado localmente' <<<"$out" && grep -q 'ref/a.md' <<<"$out"; then
  ok "T13 con el commit nuevo, lo no tocado pasa a la versión nueva y el archivo tocado queda y se nombra"
else bad "T13 (rc=$rc): $out"; fi

# ═══ T13b · «lo suyo» es lo que escribió o adoptó él: uno que marcó como tocado no se reemplaza aunque vuelva atrás ═
H="$BASE/h13b"; mkdir -p "$H"; R="$BASE/r13b"; without_history "$R"; M="$BASE/m13b.json"; manifest "$M" done "$ORIGIN" "$C1" "$T1"
step "$H" "$R" "$M" >/dev/null 2>&1
printf 'lo toqué\n' > "$R/skills/acme-helper/SKILL.md"; step "$H" "$R" "$M" >/dev/null 2>&1    # queda anotado como tocado
g -C "$O" show "$C1:skills/acme-helper/SKILL.md" > "$R/skills/acme-helper/SKILL.md"               # el dev lo devuelve a mano
manifest "$M" done "$ORIGIN" "$C2" "$T2"
out="$(step "$H" "$R" "$M" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && ! grep -q 'version: 2' "$R/skills/acme-helper/SKILL.md" && grep -q 'referencia v2' "$R/skills/acme-helper/ref/a.md"; then
  ok "T13b un archivo que el paso anotó como tocado no se reemplaza con el commit nuevo aunque el dev lo haya vuelto atrás; el resto sí"
else bad "T13b (rc=$rc): $out"; fi

# ═══ T12b · una ruta que se escapa del destino no se escribe (estado adulterado o árbol armado a mano) ════════════════
H="$BASE/h12b"; mkdir -p "$H/.claude/.tycon-pipeline"; R="$BASE/r12b"; without_history "$R"; M="$BASE/m12b.json"; manifest "$M" done "$UNREACHABLE" "$C1" "$T1"
node -e '
const [file, tree] = process.argv.slice(1); const blob = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
require("fs").writeFileSync(file, JSON.stringify({ version: 1, notices: {}, entries: { "skills/acme-helper": { tree, complete: true,
  files: { "../../escape.md": { blob, mode: "100644" }, "/tmp/absolute.md": { blob, mode: "100644" } } } } }));' "$H/.claude/.tycon-pipeline/third-party-state.json" "$T1"
out="$(step "$H" "$R" "$M" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && [ ! -e "$R/escape.md" ] && [ ! -e "$R/skills/escape.md" ] && grep -q 'ruta insegura' <<<"$out"; then
  ok "T12b una ruta con .. o absoluta no se escribe y se nombra como insegura"
else bad "T12b (rc=$rc): $out"; fi

# ═══ T14 · tres fallas distintas, disco intacto ══════════════════════════════════════════════════════════════════════
t14() { # <caso> <origen> <commit> <patrón esperado> [VAR=valor]
  local n="$1" origin="$2" commit="$3" re="$4"; shift 4
  local h="$BASE/h14$n" r="$BASE/r14$n" m="$BASE/m14$n.json"
  mkdir -p "$h"; without_history "$r"; manifest "$m" done "$origin" "$commit" "$T1"
  mkdir -p "$r/skills/acme-helper"; printf 'name: acme-helper\n' > "$r/skills/acme-helper/SKILL.md"   # parcial preexistente
  local antes; antes="$(cd "$r/skills/acme-helper" && ls -la; shasum SKILL.md)"
  out="$(step "$h" "$r" "$m" "$@" 2>&1)"; rc=$?
  local despues; despues="$(cd "$r/skills/acme-helper" && ls -la; shasum SKILL.md)"
  if [ "$rc" -eq 0 ] && [ "$antes" = "$despues" ] && grep -qi "$re" <<<"$out"; then ok "T14${n} «${re}», exit 0 y el destino parcial igual byte a byte"
  else bad "T14${n} esperaba «${re}» (rc=${rc}, destino igual: $([ "$antes" = "$despues" ] && echo sí || echo no)): $out"; fi
}
t14 a "$UNREACHABLE" "$C1" 'no pude preguntar' GIT_ALLOW_PROTOCOL=file:https
t14 b "file://$BASE/no-existe.git" "$C1" 'el origen no existe'
t14 c "$ORIGIN" "$(printf '%040d' 7)" 'ya no está en el origen'

# ═══ T15 · corte a mitad: archivos enteros, y el siguiente completa ══════════════════════════════════════════════════
H="$BASE/h15"; mkdir -p "$H"; R="$BASE/r15"; without_history "$R"; M="$BASE/m15.json"; manifest "$M" done "$ORIGIN" "$C1" "$T1"
step "$H" "$R" "$M" TYCON_THIRD_PARTY_TEST_CUT_AFTER=3 >/dev/null 2>&1
n="$(find "$R/skills/acme-helper" -type f | wc -l | tr -d ' ')"
enteros=1; for f in SKILL.md ref/a.md ref/b.md ref/c.md run.sh; do
  [ -f "$R/skills/acme-helper/$f" ] && ! cmp -s "$R/skills/acme-helper/$f" <(g -C "$O" show "$C1:skills/acme-helper/$f") && enteros=0
done
out="$(step "$H" "$R" "$M" 2>&1)"; rc=$?
tmp_sueltos="$(find "$R/skills" -name '*.tycon-tmp*' | wc -l | tr -d ' ')"
if [ "$n" = 3 ] && [ "$enteros" = 1 ] && [ "$rc" -eq 0 ] && [ "$(tree_of "$R/skills/acme-helper")" = "$T1" ] && [ "$tmp_sueltos" = 0 ]; then
  ok "T15 cortado después del tercer archivo: 3 archivos enteros; la ejecución siguiente completa el árbol, sin temporales"
else bad "T15 (archivos tras el corte $n, enteros $enteros, rc=$rc, temporales $tmp_sueltos): $out"; fi

# ═══ T16 · dos arranques a la vez ════════════════════════════════════════════════════════════════════════════════════
H="$BASE/h16"; mkdir -p "$H"; R="$BASE/r16"; without_history "$R"; M="$BASE/m16.json"; manifest "$M" done "$ORIGIN" "$C1" "$T1"
step "$H" "$R" "$M" TYCON_THIRD_PARTY_TEST_DELAY_MS=300 > "$BASE/t16a.out" 2>&1 &
PA=$!; sleep 0.3
step "$H" "$R" "$M" TYCON_THIRD_PARTY_TEST_DELAY_MS=300 > "$BASE/t16b.out" 2>&1; rcb=$?
wait "$PA"; rca=$?
tmp_sueltos="$(find "$R/skills" -name '*.tycon-tmp*' | wc -l | tr -d ' ')"
if [ "$rca" -eq 0 ] && [ "$rcb" -eq 0 ] && grep -q 'otro arranque' "$BASE/t16b.out" && [ "$(tree_of "$R/skills/acme-helper")" = "$T1" ] && [ "$tmp_sueltos" = 0 ]; then
  ok "T16 dos pasos a la vez: uno escribe, el otro dice que hay otro arranque y no escribe; el árbol final es el declarado"
else bad "T16 (rc $rca/$rcb, temporales $tmp_sueltos): A=$(cat "$BASE/t16a.out") B=$(cat "$BASE/t16b.out")"; fi

# ═══ T17 · tope de tiempo de la red ══════════════════════════════════════════════════════════════════════════════════
PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
node -e 'require("net").createServer(()=>{}).listen(+process.argv[1],"127.0.0.1")' "$PORT" & SRV_PID=$!
sleep 0.3
H="$BASE/h17"; mkdir -p "$H"; R="$BASE/r17"; without_history "$R"; M="$BASE/m17.json"; manifest "$M" done "http://127.0.0.1:$PORT/acme/skills.git" "$C1" "$T1"
t0=$(ms); out="$(step "$H" "$R" "$M" GIT_ALLOW_PROTOCOL=file:http TYCON_THIRD_PARTY_NETWORK_BUDGET_S=2 2>&1)"; rc=$?; t1=$(ms)
kill "$SRV_PID" 2>/dev/null; SRV_PID=""
manifest "$M" done "$ORIGIN" "$C1" "$T1"
out2="$(step "$H" "$R" "$M" 2>&1)"; rc2=$?
if [ "$rc" -eq 0 ] && [ $((t1 - t0)) -lt 3000 ] && grep -q 'skills/acme-helper' <<<"$out" && grep -qi 'tiempo' <<<"$out" \
   && [ "$rc2" -eq 0 ] && [ "$(tree_of "$R/skills/acme-helper")" = "$T1" ]; then
  ok "T17 un origen que no contesta corta a los 2 s ($((t1 - t0)) ms) nombrando lo pendiente; el siguiente arranque lo completa"
else bad "T17 (rc=$rc, $((t1 - t0)) ms, siguiente rc=$rc2): $out | $out2"; fi

# ═══ T18 · propietarias: una línea por día, nunca baja nada ══════════════════════════════════════════════════════════
H="$BASE/h18"; mkdir -p "$H"; R="$BASE/r18"; with_history "$R"; M="$BASE/m18.json"; manifest "$M" done "$UNREACHABLE" "$C1" "$T1" plugin
o1="$(step "$H" "$R" "$M" 2>&1)"; o2="$(step "$H" "$R" "$M" 2>&1)"
mkdir -p "$H/.claude/plugins"; printf '{"version":2,"plugins":{"acme-docs@acme-marketplace":[{"scope":"user"}]}}' > "$H/.claude/plugins/installed_plugins.json"
o3="$(step "$H" "$R" "$M" 2>&1)"
H2="$BASE/h18b"; mkdir -p "$H2"; o4="$(step "$H2" "$R" "$M" TYCON_THIRD_PARTY_PROPRIETARY_NOTICE=0 2>&1)"
n1="$(grep -c '/plugin install acme-docs@acme-marketplace' <<<"$o1")"
if [ "$n1" = 1 ] && grep -q '/plugin marketplace add' <<<"$o1" && ! grep -q '/plugin' <<<"$o2$o3$o4" && [ ! -e "$R/skills/acme-docs" ] \
   && ! grep -qi 'no pude preguntar' <<<"$o1$o2$o3$o4"; then
  ok "T18 sin el plugin: una sola línea con los dos comandos en el día; con el plugin o apagado, silencio; nunca baja la propietaria"
else bad "T18: 1=[$o1] 2=[$o2] 3=[$o3] 4=[$o4]"; fi

# ═══ Regresiones ═══════════════════════════════════════════════════════════════════════════════════════════════════
# A · una skill rota en el disco no deja sin restituir a las demás, y el aviso la nombra
H="$BASE/hA"; mkdir -p "$H"; R="$BASE/rA"; with_history "$R"; M="$BASE/mA.json"; EXTRA_TREE="$TX" manifest "$M" done "$UNREACHABLE" "$C1" "$T1"
step "$H" "$R" "$M" >/dev/null 2>&1
rm -f "$R/skills/acme-helper/ref/a.md"; chmod 555 "$R/skills/acme-helper/ref"; rm -rf "$R/skills/acme-extra"
out="$(step "$H" "$R" "$M" 2>&1)"; rc=$?
chmod 755 "$R/skills/acme-helper/ref"
if [ "$rc" -eq 0 ] && [ "$(tree_of "$R/skills/acme-extra")" = "$TX" ] && grep -q 'skills/acme-helper' <<<"$out" && grep -q 'ref/a.md' <<<"$out"; then
  ok "adv-A una carpeta sin permiso en una skill no frena a la siguiente, y el aviso nombra skill y archivo"
else bad "adv-A (rc=$rc): $out"; fi
# B · el paso no escribe a través de un enlace simbólico del disco (la carpeta de la skill enlazada a otro checkout)
H="$BASE/hB"; mkdir -p "$H" "$BASE/otro-checkout"; R="$BASE/rB"; with_history "$R"; M="$BASE/mB.json"; manifest "$M" done "$UNREACHABLE" "$C1" "$T1"
ln -s "$BASE/otro-checkout" "$R/skills/acme-helper"
out="$(step "$H" "$R" "$M" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && [ -z "$(ls -A "$BASE/otro-checkout")" ] && grep -q 'enlace' <<<"$out"; then
  ok "adv-B con la carpeta de la skill enlazada a otro lado, no escribe nada ahí y lo dice"
else bad "adv-B (rc=$rc, en el otro checkout: $(ls -A "$BASE/otro-checkout" | tr '\n' ' ')): $out"; fi
# C · un archivo con fines de línea CRLF (core.autocrlf del dev) no es «modificado localmente»
H="$BASE/hC"; mkdir -p "$H"; R="$BASE/rC"; with_history "$R"; M="$BASE/mC.json"; manifest "$M" done "$UNREACHABLE" "$C1" "$T1"
step "$H" "$R" "$M" >/dev/null 2>&1; rm -rf "$H/.claude"; mkdir -p "$H"
printf 'name: acme-helper\r\n' > "$R/skills/acme-helper/SKILL.md"
out="$(step "$H" "$R" "$M" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && ! grep -q 'modificado' <<<"$out" && [ "$(od -c "$R/skills/acme-helper/SKILL.md" | grep -c '\\r')" = 1 ]; then
  ok "adv-C el mismo contenido con CRLF cuenta como igual: ni se nombra ni se reescribe"
else bad "adv-C (rc=$rc): $out"; fi
# D · con git traducido, «el origen no existe» sigue siendo eso (los mensajes de git se piden en inglés)
H="$BASE/hD"; mkdir -p "$H"; R="$BASE/rD"; without_history "$R"; M="$BASE/mD.json"; manifest "$M" done "file://$BASE/no-existe.git" "$C1" "$T1"
out="$(step "$H" "$R" "$M" LANG=es_ES.UTF-8 LC_ALL=es_ES.UTF-8 LANGUAGE=es 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && grep -q 'el origen no existe' <<<"$out"; then ok "adv-D con el entorno en castellano, el origen inexistente se clasifica igual"
else bad "adv-D (rc=$rc): $out"; fi
# F · una edición que conserva el tamaño y la fecha no se esconde detrás del caché
H="$BASE/hF"; mkdir -p "$H"; R="$BASE/rF"; with_history "$R"; M="$BASE/mF.json"; manifest "$M" done "$UNREACHABLE" "$C1" "$T1"
step "$H" "$R" "$M" >/dev/null 2>&1
node -e 'const fs=require("fs");const f=process.argv[1];const st=fs.statSync(f);fs.writeFileSync(f,"referencia XX\n");fs.utimesSync(f,st.atime,st.mtime)' "$R/skills/acme-helper/ref/a.md"
out="$(step "$H" "$R" "$M" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && grep -q 'modificado' <<<"$out" && grep -q 'ref/a.md' <<<"$out" && [ "$(cat "$R/skills/acme-helper/ref/a.md")" = 'referencia XX' ]; then
  ok "adv-F una edición con el mismo tamaño y la misma fecha se ve como modificada y no se pisa"
else bad "adv-F (rc=$rc): $out"; fi
# H · retiro hecho, sin historia ni estado, destino ya completo en el disco: lo adopta sin ir a la red
H="$BASE/hH"; mkdir -p "$H"; R="$BASE/rH"; without_history "$R"; M="$BASE/mH.json"; manifest "$M" done "$UNREACHABLE" "$C1" "$T1"
mkdir -p "$R/skills"; cp -Rp "$BASE/r10/skills/acme-helper" "$R/skills/"
out="$(step "$H" "$R" "$M" GIT_ALLOW_PROTOCOL=file:https 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && ! grep -qi 'no pude preguntar' <<<"$out" && [ -s "$H/.claude/.tycon-pipeline/third-party-state.json" ]; then
  ok "adv-H un destino completo sin historia ni estado se adopta sin ir a la red"
else bad "adv-H (rc=$rc): $out"; fi
# I · --check con el retiro pendiente dice lo que falta aunque el aviso del día ya haya salido
H="$BASE/hI"; mkdir -p "$H"; R="$BASE/rI"; without_history "$R"; M="$BASE/mI.json"; manifest "$M" pending "$UNREACHABLE" "$C1" "$T1"
step "$H" "$R" "$M" >/dev/null 2>&1
out="$(env -i HOME="$H" PATH="$PATH" GIT_ALLOW_PROTOCOL=file node "$STEP" --repo "$R" --manifest "$M" --check 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && grep -q 'faltan' <<<"$out" && grep -q 'skills/acme-helper' <<<"$out"; then ok "adv-I --check nombra lo que falta aunque el aviso diario ya haya salido"
else bad "adv-I (rc=$rc): $out"; fi

# J · retiro pendiente, árbol fuera de la historia y un destino con OTRO contenido: se dice, no se calla
H="$BASE/hJ"; mkdir -p "$H"; R="$BASE/rJ"; without_history "$R"; M="$BASE/mJ.json"; manifest "$M" pending "$UNREACHABLE" "$C1" "$T1"
mkdir -p "$R/skills/acme-helper"; printf 'otra cosa\n' > "$R/skills/acme-helper/SKILL.md"
out="$(step "$H" "$R" "$M" 2>&1)"; rc=$?
out2="$(env -i HOME="$H" PATH="$PATH" GIT_ALLOW_PROTOCOL=file node "$STEP" --repo "$R" --manifest "$M" --check 2>&1)"
if [ "$rc" -eq 0 ] && grep -q 'skills/acme-helper' <<<"$out" && grep -q 'no puedo verificar' <<<"$out" && grep -q 'skills/acme-helper' <<<"$out2"; then
  ok "rev-J un destino con otro contenido y sin su árbol en la historia se nombra (en el arranque y en --check), no se saltea callado"
else bad "rev-J (rc=$rc): [$out] [$out2]"; fi

# K · --check nombra lo modificado localmente aunque el aviso del día ya haya salido en el arranque. Si un dev
# corre --check a mano para saber qué skills le pisó otro instalador, tiene que salir algo aunque el arranque ya lo
# haya dicho esa mañana: el aviso diario es para el arranque, no para quien pregunta.
H="$BASE/hK"; mkdir -p "$H"; R="$BASE/rK"; without_history "$R"; M="$BASE/mK.json"; manifest "$M" done "$ORIGIN" "$C1" "$T1"
step "$H" "$R" "$M" >/dev/null 2>&1
printf 'la pisó otro instalador\n' > "$R/skills/acme-helper/SKILL.md"
out="$(step "$H" "$R" "$M" 2>&1)"
out2="$(env -i HOME="$H" PATH="$PATH" GIT_ALLOW_PROTOCOL=file node "$STEP" --repo "$R" --manifest "$M" --check 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && grep -q 'modificado localmente' <<<"$out" && grep -q 'modificado localmente' <<<"$out2" && grep -q 'SKILL.md' <<<"$out2"; then
  ok "K --check nombra lo modificado localmente aunque el arranque ya haya dado el aviso del día"
else bad "K (rc=$rc): [$out] [$out2]"; fi

# ═══ T28 · el pull del retiro sobre un archivo ajeno que el dev modificó no deja agent-skills trabado ══════════
# Así lo trae la línea de arranque: `pull --ff-only --autostash`. Con el archivo modificado, git sale 0 pero deja el
# índice en conflicto (DU) y el stash «autostash»; desde ahí ningún pull entra.
S28="$BASE/as28"; g clone -q "$AS_SRC" "$S28"                         # un upstream propio: acá se agregan commits
H="$BASE/h28"; mkdir -p "$H"; R="$BASE/r28"; g clone -q "$S28" "$R"; g -C "$R" reset -q --hard HEAD~1   # la máquina, antes del retiro
M="$BASE/m28.json"; manifest "$M" done "$UNREACHABLE" "$C1" "$T1"
printf 'lo cambió un BMAD más nuevo\n' > "$R/skills/acme-helper/SKILL.md"
g -C "$R" pull --ff-only --quiet --autostash >/dev/null 2>&1
antes_u="$(g -C "$R" ls-files -u | wc -l | tr -d ' ')"
out="$(step "$H" "$R" "$M" 2>&1)"; rc=$?
despues_u="$(g -C "$R" ls-files -u | wc -l | tr -d ' ')"
printf 'otra propia\n' > "$S28/skills/zorblax-own/NOTAS.md"; g -C "$S28" add -A && g -C "$S28" commit -q -m 'sigue la vida'
g -C "$R" pull --ff-only --quiet --autostash >/dev/null 2>&1; rcp=$?
if [ "$antes_u" -gt 0 ] && [ "$rc" -eq 0 ] && [ "$despues_u" = 0 ] && [ "$rcp" -eq 0 ] && [ -f "$R/skills/zorblax-own/NOTAS.md" ] \
   && [ "$(cat "$R/skills/acme-helper/SKILL.md")" = 'lo cambió un BMAD más nuevo' ] && [ -f "$R/skills/acme-helper/ref/b.md" ] \
   && g -C "$R" stash list | grep -q autostash && grep -q 'destrabé agent-skills.*skills/acme-helper/SKILL.md' <<<"$out" \
   && grep -q 'modificado localmente' <<<"$out" && grep -q 'SKILL.md' <<<"$out"; then
  ok "T28 el pull del retiro con un archivo ajeno modificado: el paso destraba, el archivo del dev queda y se nombra, el stash sigue y el pull siguiente entra"
else bad "T28 (conflictos antes ${antes_u} · después ${despues_u}, rc=$rc, pull siguiente rc=$rcp, SKILL.md: $(cat "$R/skills/acme-helper/SKILL.md" 2>&1)): $out"; fi
# un conflicto que NO es del retiro (un archivo propio) no se toca y se nombra
S28b="$BASE/as28b"; g clone -q "$AS_SRC" "$S28b"
printf 'propia v2\n' > "$S28b/skills/zorblax-own/SKILL.md"; g -C "$S28b" commit -q -am 'la propia cambia'
H="$BASE/h28b"; mkdir -p "$H"; R="$BASE/r28b"; g clone -q "$S28b" "$R"; g -C "$R" reset -q --hard HEAD~1
printf 'propia, tocada por el dev\n' > "$R/skills/zorblax-own/SKILL.md"
g -C "$R" pull --ff-only --quiet --autostash >/dev/null 2>&1
antes_u="$(g -C "$R" ls-files -u | wc -l | tr -d ' ')"
out="$(step "$H" "$R" "$M" 2>&1)"; rc=$?
despues_u="$(g -C "$R" ls-files -u | wc -l | tr -d ' ')"
if [ "$antes_u" -gt 0 ] && [ "$rc" -eq 0 ] && [ "$despues_u" = "$antes_u" ] && grep -q 'conflicto sin resolver' <<<"$out" \
   && grep -q 'skills/zorblax-own/SKILL.md' <<<"$out" && grep -q 'a mano' <<<"$out" && ! grep -q 'destrabé' <<<"$out"; then
  ok "T28 un conflicto en un archivo propio no se toca y se nombra (antes era silencio)"
else bad "T28 conflicto propio (antes ${antes_u} · después ${despues_u}, rc=$rc): $out"; fi

# T28 · los rechazos del destrabe: cada uno deja el índice como estaba y lo dice
# retired_du <dir> → una máquina con el pull del retiro trabado sobre skills/acme-helper/SKILL.md (DU con autostash)
retired_du() {
  local s="$1.src"; g clone -q "$AS_SRC" "$s"; g clone -q "$s" "$1"; g -C "$1" reset -q --hard HEAD~1
  printf 'lo cambió un BMAD más nuevo\n' > "$1/skills/acme-helper/SKILL.md"
  g -C "$1" pull --ff-only --quiet --autostash >/dev/null 2>&1
}
unmerged() { g -C "$1" ls-files -u | wc -l | tr -d ' '; }
# mixto: un ajeno que el retiro borró (DU) y un propio en conflicto (UU) → no se toca, y el consejo sirve para los dos
S28c="$BASE/as28c"; g clone -q "$AS_SRC" "$S28c"
printf 'propia v2\n' > "$S28c/skills/zorblax-own/SKILL.md"; g -C "$S28c" commit -q -am 'la propia cambia'
R="$BASE/r28c"; g clone -q "$S28c" "$R"; g -C "$R" reset -q --hard HEAD~2
printf 'propia, tocada\n' > "$R/skills/zorblax-own/SKILL.md"; printf 'ajena, tocada\n' > "$R/skills/acme-helper/SKILL.md"
g -C "$R" pull --ff-only --quiet --autostash >/dev/null 2>&1; u0="$(unmerged "$R")"
mkdir -p "$BASE/h28c"; out="$(step "$BASE/h28c" "$R" "$M" 2>&1)"
if [ "$u0" -gt 0 ] && [ "$(unmerged "$R")" = "$u0" ] && grep -q 'rm --cached -- skills/acme-helper/SKILL.md' <<<"$out" && grep -q 'a mano' <<<"$out"; then
  ok "T28 conflicto mixto: no toca nada; da el comando que destraba el ajeno y manda a resolver a mano el propio"
else bad "T28 mixto (conflictos ${u0} → $(unmerged "$R")): $out"; fi
# el stash de arriba no es un autostash (el dev hizo su propio stash y lo aplicó)
R="$BASE/r28d"; g clone -q "$AS_SRC" "$R"; g -C "$R" reset -q --hard HEAD~1
printf 'mío\n' > "$R/skills/acme-helper/SKILL.md"; g -C "$R" stash push -q -m 'guardado a mano'
g -C "$R" merge -q --ff-only origin/main >/dev/null 2>&1; g -C "$R" stash apply -q >/dev/null 2>&1; u0="$(unmerged "$R")"
mkdir -p "$BASE/h28d"; out="$(step "$BASE/h28d" "$R" "$M" 2>&1)"
if [ "$u0" -gt 0 ] && [ "$(unmerged "$R")" = "$u0" ] && grep -q 'no vienen de un autostash' <<<"$out"; then
  ok "T28 un conflicto que no viene de un autostash no se toca y se nombra"
else bad "T28 sin autostash (conflictos ${u0} → $(unmerged "$R")): $out"; fi
# el autostash de arriba no trae la ruta en conflicto (se descartó el de verdad y quedó otro)
R="$BASE/r28e"; g clone -q "$AS_SRC" "$R"; g -C "$R" reset -q --hard HEAD~1
printf 'otra propia\n' >> "$R/skills/zorblax-own/SKILL.md"; g -C "$R" stash push -q -m autostash -- skills/zorblax-own/SKILL.md
printf 'lo cambió un BMAD más nuevo\n' > "$R/skills/acme-helper/SKILL.md"
g -C "$R" pull --ff-only --quiet --autostash >/dev/null 2>&1; g -C "$R" stash drop -q >/dev/null 2>&1; u0="$(unmerged "$R")"
mkdir -p "$BASE/h28e"; out="$(step "$BASE/h28e" "$R" "$M" 2>&1)"
if [ "$u0" -gt 0 ] && [ "$(unmerged "$R")" = "$u0" ] && grep -q 'no los trae a todos' <<<"$out"; then
  ok "T28 un autostash que no trae las rutas en conflicto no alcanza: no se toca y se nombra"
else bad "T28 stash ajeno (conflictos ${u0} → $(unmerged "$R")): $out"; fi
# --check no escribe, y git rm --cached que falla (el índice tomado por otro git) deja todo como estaba
R="$BASE/r28f"; retired_du "$R"; u0="$(unmerged "$R")"; mkdir -p "$BASE/h28f"
out="$(env -i HOME="$BASE/h28f" PATH="$PATH" GIT_ALLOW_PROTOCOL=file node "$STEP" --repo "$R" --manifest "$M" --check 2>&1)"
touch "$R/.git/index.lock"; out2="$(step "$BASE/h28f" "$R" "$M" 2>&1)"; rm -f "$R/.git/index.lock"
if [ "$u0" -gt 0 ] && [ "$(unmerged "$R")" = "$u0" ] && grep -q -- '--check no escribe' <<<"$out" && grep -q 'rm --cached falló' <<<"$out2" \
   && [ "$(cat "$R/skills/acme-helper/SKILL.md")" = 'lo cambió un BMAD más nuevo' ]; then
  ok "T28 --check nombra el conflicto sin escribir, y un git rm --cached que falla deja el índice y el archivo como estaban"
else bad "T28 --check / rm fallido (conflictos ${u0} → $(unmerged "$R")): [$out] [$out2]"; fi
# el manifiesto dice que el retiro está pendiente: ese pull no es el del retiro → no se toca nada (T5)
R="$BASE/r28g"; retired_du "$R"; u0="$(unmerged "$R")"; st0="$(g -C "$R" stash list)"; M28g="$BASE/m28g.json"; manifest "$M28g" pending "$UNREACHABLE" "$C1" "$T1"
mkdir -p "$BASE/h28g"; out="$(step "$BASE/h28g" "$R" "$M28g" 2>&1)"; rc=$?
if [ "$u0" -gt 0 ] && [ "$rc" -eq 0 ] && [ "$(unmerged "$R")" = "$u0" ] && [ "$(g -C "$R" stash list)" = "$st0" ] \
   && [ "$(cat "$R/skills/acme-helper/SKILL.md")" = 'lo cambió un BMAD más nuevo' ] && grep -q 'el retiro está pendiente' <<<"$out" \
   && grep -q 'skills/acme-helper/SKILL.md' <<<"$out" && ! grep -q 'destrabé' <<<"$out"; then
  ok "T28 con el retiro pendiente no toca nada (índice, archivo y stash iguales) y lo dice nombrando la ruta"
else bad "T28 retiro pendiente (rc=$rc, conflictos ${u0} → $(unmerged "$R")): $out"; fi
# una ruta con espacio: el comando que sugiere el paso se copia, se corre y destraba ese archivo (T6).
# Laboratorio propio: una ruta con espacio en AS_SRC cambiaría los árboles de todos los casos de arriba.
S6="$BASE/as-esp"; g init -q -b main "$S6"; mkdir -p "$S6/skills/zorblax-own" "$S6/skills/acme-helper/ref"
printf 'propia\n' > "$S6/skills/zorblax-own/SKILL.md"; printf 'ajena\n' > "$S6/skills/acme-helper/ref/con espacio.md"
g -C "$S6" add -A && g -C "$S6" commit -q -m A
R="$BASE/r28h"; g clone -q "$S6" "$R"
g -C "$S6" rm -q -r skills/acme-helper && printf 'propia v2\n' > "$S6/skills/zorblax-own/SKILL.md" && g -C "$S6" add -A && g -C "$S6" commit -q -m 'B: retiro'
printf 'ajena, tocada\n' > "$R/skills/acme-helper/ref/con espacio.md"; printf 'propia, tocada\n' > "$R/skills/zorblax-own/SKILL.md"
g -C "$R" pull --ff-only --quiet --autostash >/dev/null 2>&1; u0="$(unmerged "$R")"
mkdir -p "$BASE/h28h"; out="$(step "$BASE/h28h" "$R" "$M" 2>&1)"
cmd="$(grep -o "git -C [^ ]* rm --cached --\( '[^']*'\| [A-Za-z0-9_./-]*\)*" <<<"$out" | head -1)"
env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null bash -c "$cmd" >/dev/null 2>&1; rcc=$?
if [ "$u0" -gt 0 ] && grep -qF "rm --cached -- 'skills/acme-helper/ref/con espacio.md'" <<<"$out" && [ "$rcc" -eq 0 ] \
   && ! g -C "$R" ls-files -u | grep -q 'con espacio' && g -C "$R" ls-files -u | grep -q 'zorblax-own/SKILL.md' \
   && [ -f "$R/skills/acme-helper/ref/con espacio.md" ]; then
  ok "T28 una ruta con espacio va citada en el comando sugerido; copiado y corrido, destraba ese archivo (el propio sigue para resolver a mano)"
else bad "T28 ruta con espacio (conflictos ${u0} → $(unmerged "$R"), comando rc=$rcc: [$cmd]): $out"; fi
# el destrabe EXITOSO bajo una carpeta con espacio: el `git -C … stash list` del mensaje se copia y corre (la rama
# del rechazo y la del éxito citan la carpeta)
mkdir -p "$BASE/con espacio"; R="$BASE/con espacio/r28i"; retired_du "$R"
mkdir -p "$BASE/h28i"; out="$(step "$BASE/h28i" "$R" "$M" 2>&1)"
cmd="$(grep -o "git -C '[^']*' stash list" <<<"$out" | head -1)"
env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null bash -c "$cmd" >/dev/null 2>&1; rcc=$?
if grep -q 'destrabé agent-skills' <<<"$out" && [ -n "$cmd" ] && [ "$rcc" -eq 0 ] && [ "$(unmerged "$R")" = 0 ]; then
  ok "T28 destrabe exitoso bajo una carpeta con espacio: el git -C … stash list del mensaje va citado y corre"
else bad "T28 destrabe con carpeta con espacio (comando [$cmd] rc=$rcc, conflictos $(unmerged "$R")): $out"; fi

# ═══ retiro hecho, sin historia ni estado: --check nombra una carpeta a medias, no sólo la que falta entera ═══════
H="$BASE/hB1"; mkdir -p "$H"; R="$BASE/rB1"; without_history "$R"; M1="$BASE/mB1.json"; manifest "$M1" done "$UNREACHABLE" "$C1" "$T1"
mkdir -p "$R/skills/acme-helper"; printf 'name: acme-helper\n' > "$R/skills/acme-helper/SKILL.md"
out="$(env -i HOME="$H" PATH="$PATH" GIT_ALLOW_PROTOCOL=file node "$STEP" --repo "$R" --manifest "$M1" --check 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && grep -q 'faltan' <<<"$out" && grep -q 'skills/acme-helper' <<<"$out"; then
  ok "adv-B1 --check con el retiro hecho nombra una skill a medias que no está en la historia local"
else bad "adv-B1 (rc=$rc): $out"; fi
# ═══ adv-B6 · sin red, las fallas del mismo tipo salen en UNA línea (la copia pública tiene ~70 skills que bajar) ════════
H="$BASE/hB6"; mkdir -p "$H"; R="$BASE/rB6"; without_history "$R"; M6="$BASE/mB6.json"; EXTRA_TREE="$TX" manifest "$M6" done "$UNREACHABLE" "$C1" "$T1"
out="$(step "$H" "$R" "$M6" GIT_ALLOW_PROTOCOL=file 2>&1)"; rc=$?
n6="$(grep -c 'no pude preguntar' <<<"$out")"
if [ "$rc" -eq 0 ] && [ "$n6" = 1 ] && grep -q 'skills/acme-helper' <<<"$out" && grep -q 'skills/acme-extra' <<<"$out"; then
  ok "adv-B6 sin red, dos skills del mismo origen: una sola línea «no pude preguntar» que nombra las dos"
else bad "adv-B6 (rc=$rc, líneas ${n6}): $out"; fi

# ═══ T26 · el repo unido: un clon NUEVO restituye desde la historia unida, sin red ══════════════
# El arnés y agent-skills son UN repo. La historia de agent-skills —con la skill ajena versionada (A) y su retiro (B)—
# entró por el merge de la unión: un clon nuevo del repo unido trae esos objetos, y el paso restituye sin red con los
# destinos del manifiesto resueltos contra la raíz que trae skills/. El clon es `--no-local`: viaja sólo lo que la
# historia alcanza, no la carpeta de objetos entera (si la unión perdiera esa historia, acá se vería).
UNION_SRC="$BASE/union-src"; g init -q -b main "$UNION_SRC"
mkdir -p "$UNION_SRC/scripts"; printf 'del arnés\n' > "$UNION_SRC/scripts/tool.txt"
g -C "$UNION_SRC" add -A && g -C "$UNION_SRC" commit -q -m 'el arnés, antes de la unión' \
  && g -C "$UNION_SRC" fetch -q "$AS_SRC" HEAD && g -C "$UNION_SRC" merge -q --allow-unrelated-histories -m 'la unión' FETCH_HEAD \
  || { bad "T26 fixture: no pude armar el repo unido de laboratorio"; exit 1; }
unified_clone() { g clone -q --no-local "$UNION_SRC" "$1"; }   # un clon nuevo del repo unido
H="$BASE/h26"; mkdir -p "$H"; R="$BASE/r26"; unified_clone "$R"; M="$BASE/m26.json"; manifest "$M" done "$UNREACHABLE" "$C1" "$T1"
out="$(step "$H" "$R" "$M" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && [ -f "$R/scripts/tool.txt" ] && [ "$(tree_of "$R/skills/acme-helper")" = "$T1" ] \
   && grep -q 'desde la historia local' <<<"$out" && ! grep -qi 'no pude preguntar' <<<"$out"; then
  ok "T26 un clon nuevo del repo unido, red caída: restituido desde la historia unida, en skills/ de la misma raíz"
else bad "T26 clon nuevo del repo unido (rc=$rc, árbol $(tree_of "$R/skills/acme-helper" 2>/dev/null)): $out"; fi
out="$(env -i HOME="$H" PATH="$PATH" GIT_ALLOW_PROTOCOL=file node "$STEP" --repo "$R" --manifest "$M" --check 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && [ -z "$out" ]; then ok "T26 --check sobre ese clon, ya restituido: no falta nada"
else bad "T26 --check tras restituir (rc=$rc): $out"; fi

# Contrato C11: la llamada de los instaladores (`--repo "$HOME/.claude/agent-skills"`) sigue valiendo cuando esa ruta es
# un ENLACE al clon unido…
H="$BASE/h26b"; mkdir -p "$H/.claude"; R="$BASE/r26b"; unified_clone "$R"; ln -s "$R" "$H/.claude/agent-skills"
out="$(step "$H" "$H/.claude/agent-skills" "$M" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && [ "$(tree_of "$R/skills/acme-helper")" = "$T1" ] && ! grep -qiE 'enlace|no pude preguntar|no es un clon' <<<"$out"; then
  ok "T26 C11 --repo <HOME>/.claude/agent-skills como enlace al clon unido: restituye en el clon, sin red"
else bad "T26 C11 enlace al clon unido (rc=$rc, árbol $(tree_of "$R/skills/acme-helper" 2>/dev/null)): $out"; fi
# …y cuando es el clon viejo de agent-skills RE-APUNTADO al repo unido (su origen cambia y el pull trae el árbol unido)
H="$BASE/h26c"; mkdir -p "$H/.claude"; R="$H/.claude/agent-skills"; with_history "$R"
g -C "$R" remote set-url origin "$UNION_SRC" && g -C "$R" pull -q --ff-only origin main \
  || bad "T26 C11 fixture: el clon viejo no pudo traer el repo unido"
out="$(step "$H" "$R" "$M" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && [ -f "$R/scripts/tool.txt" ] && [ "$(tree_of "$R/skills/acme-helper")" = "$T1" ] && ! grep -qi 'no pude preguntar' <<<"$out"; then
  ok "T26 C11 el clon viejo re-apuntado al repo unido: restituye igual, sin red"
else bad "T26 C11 clon viejo re-apuntado (rc=$rc, árbol $(tree_of "$R/skills/acme-helper" 2>/dev/null)): $out"; fi
# El mismo clon por sus dos rutas (el enlace y la real) es UN repo para el cerrojo: dos pasos a la vez no escriben los dos
H="$BASE/h26d"; mkdir -p "$H/.claude"; R="$BASE/r26d"; unified_clone "$R"; ln -s "$R" "$H/.claude/agent-skills"
step "$H" "$H/.claude/agent-skills" "$M" TYCON_THIRD_PARTY_TEST_DELAY_MS=300 > "$BASE/t26a.out" 2>&1 &
PA=$!; sleep 0.3
step "$H" "$R" "$M" TYCON_THIRD_PARTY_TEST_DELAY_MS=300 > "$BASE/t26b.out" 2>&1; rcb=$?
wait "$PA"; rca=$?
if [ "$rca" -eq 0 ] && [ "$rcb" -eq 0 ] && grep -q 'otro arranque' "$BASE/t26b.out" && [ "$(tree_of "$R/skills/acme-helper")" = "$T1" ]; then
  ok "T26 C11 el enlace y la ruta real a la vez: uno escribe y el otro dice que hay otro arranque (un solo cerrojo por clon)"
else bad "T26 C11 dos rutas al mismo clon (rc $rca/$rcb): A=$(cat "$BASE/t26a.out") B=$(cat "$BASE/t26b.out")"; fi

# ═══ T7 · enganchado en los dos instaladores; el aviso por stdout; apagado lo dice ═══════════════════════════════════
H="$BASE/h7"; mkdir -p "$H/.claude" "$BASE/fake"
without_history "$H/.claude/agent-skills"; mkdir -p "$H/.claude/agent-skills/skills/tycon-pipeline"
printf '#!/bin/sh\nexit 0\n' > "$BASE/fake/launchctl"; chmod +x "$BASE/fake/launchctl"
instalar() { # stderr descartado, como la línea de arranque
  # TYCON_PARITY_BENCH_DIR: el chequeo de paridad que el instalador lanza de fondo dejaría su reporte en .bench/ del árbol
  env -i HOME="$H" PATH="$PATH" TMPDIR="$BASE/tmp" LANG="${LANG:-en_US.UTF-8}" GIT_ALLOW_PROTOCOL=file GIT_TERMINAL_PROMPT=0 \
    TYCON_PROFILE=0 TYCON_PARITY_BENCH_DIR="$BASE/parity-bench" TYCON_CODEX=0 TYCON_NO_CLAUDEMD_SYNC=1 TYCON_NO_COMMANDS_SYNC=1 TYCON_NO_GIT_HOOKS=1 TYCON_NO_GUI_ENV=1 \
    TYCON_NO_SQLITE_CHECK=1 TYCON_NO_NIGHTLY_EXAM=1 TYCON_NO_THREAD_RESCUE=1 TYCON_NO_COLLECT_FINDINGS=1 TYCON_STAGE_METRICS=0 \
    TYCON_BENCH_DAILY=0 TYCON_NO_CANONICAL_PATH=1 TYCON_NO_BOOTSTRAP_HEAL=1 TYCON_MAILBOX_URL_BASE=http://127.0.0.1:9 \
    LAUNCHCTL_BIN="$BASE/fake/launchctl" "$@" bash "$TCG/scripts/install-tycon-hooks.sh" 2>/dev/null
}
out="$(instalar)"; rc=$?
if [ "$rc" -eq 0 ] && grep -q 'skills de terceros' <<<"$out"; then ok "T7 el instalador real corre el paso y su aviso se ve con stderr descartado"
else bad "T7 el instalador (rc=$rc) no mostró el aviso del paso: $(tail -5 <<<"$out" | tr '\n' ' ')"; fi
out="$(instalar TYCON_THIRD_PARTY=0)"
if grep -q 'skills de terceros.*apagado' <<<"$out"; then ok "T7 con TYCON_THIRD_PARTY=0 el paso lo dice en una línea"
else bad "T7 apagado no dijo nada: $(tail -5 <<<"$out" | tr '\n' ' ')"; fi
# Los dos instaladores invocan el mismo script, con el MISMO repo y con --check cuando corresponde.
# Ninguno trae la ruta escrita (`--repo <HOME>/.claude/agent-skills`): le preguntan a scripts/lib/skills-dir.js con la variante
# de quien ESCRIBE en la máquina (`--installed`: lo instalado mientras exista) y guardan la raíz en una variable. Buscar
# ese texto daría rojo con los dos instaladores sanos. Se mira lo que el contrato protege:
#   1. las llamadas al paso son las dos de siempre, en los dos: la de la raíz instalada, con los argumentos del modo
#      revisión, y la del modo revisión sin el enlace todavía, con --check fijo; ninguna con otra carpeta;
#   2. esa raíz sale de la carpeta de skills que contesta la biblioteca con --installed, y de ningún otro lado (la ruta
#      escrita queda sólo para una copia del instalador sin la biblioteca al lado);
#   3. en modo revisión, --check viaja.
# same_step_call <.sh> <.ps1> → «-» si los dos llaman igual; si no, los motivos. Lee el texto sin las líneas de comentario.
same_step_call() {
  node -e '
const fs = require("fs");
const code = (f) => fs.readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*#/.test(l));
const [sh, ps] = [code(process.argv[1]), code(process.argv[2])];
const why = [];
const Q = "\x27";
const has = (lines, re) => lines.some((l) => re.test(l));
// los valores que se le asignan a una variable, en cualquier parte de una línea
const assigned = (lines, re) => lines.flatMap((l) => [...l.matchAll(re)].map((m) => m[1].trim()));
function calls(lines, re, who, main, inClone, modeArgs) {
  const all = lines.map((l) => re.exec(l)).filter(Boolean).map((m) => ({ repo: m[1], rest: m[2] }));
  if (!all.length) { why.push(`${who}: no llama al paso`); return; }
  const m = all.filter((c) => c.repo === main);
  if (m.length !== 1) why.push(`${who}: ${m.length} llamadas con la raíz instalada (${main}); tiene que haber una`);
  else if (!m[0].rest.includes(modeArgs)) why.push(`${who}: la llamada con la raíz instalada no lleva los argumentos del modo revisión (${modeArgs})`);
  const c = all.filter((x) => x.repo === inClone);
  if (c.length !== 1) why.push(`${who}: ${c.length} llamadas del modo revisión sin el enlace (${inClone}); tiene que haber una`);
  else if (!/(^|\s)--check(\s|$)/.test(c[0].rest)) why.push(`${who}: la llamada del modo revisión sin el enlace no lleva --check`);
  for (const x of all) if (x.repo !== main && x.repo !== inClone) why.push(`${who}: llama al paso con otra carpeta (${x.repo})`);
}
function only(who, name, values, allowed, needed) {
  for (const v of values) if (!allowed.includes(v)) why.push(`${who}: ${name} sale de otro lado (${v})`);
  if (!values.includes(needed)) why.push(`${who}: ${name} ya no sale de ${needed}`);
}
// ── el .sh ──
calls(sh, /install-third-party\.js"\s+--repo\s+("[^"]*"|\S+)\s*(.*)$/, ".sh", "\"$AGENT_SKILLS_REPO\"", "\"$_CHECK_IN_CLONE\"", "_TP_ARGS[@]");
if (!has(sh, /\[\[\s*"\$CHECK_ONLY"\s*==\s*"1"\s*\]\]\s*&&\s*_TP_ARGS\+=\(--check\)/)) why.push(".sh: en modo revisión no agrega --check a los argumentos del paso");
only(".sh", "la raíz (AGENT_SKILLS_REPO)", assigned(sh, /(?:^|[\s;&|])AGENT_SKILLS_REPO=("[^"]*(?:"[^"]*"[^"]*)*"|\S*)/g),
  ["\"$(dirname \"$AGENT_SKILLS\")\""], "\"$(dirname \"$AGENT_SKILLS\")\"");
only(".sh", "la carpeta de skills (AGENT_SKILLS)", assigned(sh, /(?:^|[\s;&|])AGENT_SKILLS=("\$\(_skills_dir write --skills[^)]*\)"|"[^"]*"|\S*)/g).map((v) => v.replace(/;$/, "")),
  ["\"\"", "\"$(_skills_dir write --skills 2>/dev/null)\"", "\"$HOME/.claude/agent-skills/skills\""], "\"$(_skills_dir write --skills 2>/dev/null)\"");
only(".sh", "la raíz del modo revisión (_CHECK_IN_CLONE)", assigned(sh, /(?:^|[\s;&|])_CHECK_IN_CLONE=("[^"]*"|\S*)/g), ["\"$AGENT_SKILLS_REPO\""], "\"$AGENT_SKILLS_REPO\"");
if (!has(sh, /^\s*write\)\s+TYCON_SKILLS_DIR=\s+node\s+"\$SKILLS_DIR_JS"\s+"\$2"\s+--installed\b/)) why.push(".sh: `_skills_dir write` ya no le pregunta a la biblioteca con --installed y sin la variable");
if (!has(sh, /^\s*SKILLS_DIR_JS="\$SCRIPT_DIR\/lib\/skills-dir\.js"/)) why.push(".sh: la biblioteca ya no es scripts/lib/skills-dir.js");
// ── el .ps1 ──
calls(ps, new RegExp(`install-third-party\\.js${Q}\\)\\s+--repo\\s+(\\S+)\\s*([^}]*)`), ".ps1", "$AgentSkillsRepo", "$CheckInClone", "@tpArgs");
if (!has(ps, new RegExp(`if\\s*\\(\\$Check\\)\\s*\\{\\s*\\$tpArgs\\s*\\+=\\s*${Q}--check${Q}\\s*\\}`))) why.push(".ps1: en modo revisión no agrega --check a los argumentos del paso");
only(".ps1", "la raíz ($AgentSkillsRepo)", assigned(ps, /\$AgentSkillsRepo\s*=(?!=)\s*([^;}#]*)/g), ["Split-Path -Parent $AgentSkills"], "Split-Path -Parent $AgentSkills");
only(".ps1", "la carpeta de skills ($AgentSkills)", assigned(ps, /\$AgentSkills\s*=(?!=)\s*([^;}#]*)/g),
  ["$null", `Get-InstalledSkillsDir ${Q}--skills${Q}`], `Get-InstalledSkillsDir ${Q}--skills${Q}`);
only(".ps1", "la raíz del modo revisión ($CheckInClone)", assigned(ps, /\$CheckInClone\s*=(?!=)\s*([^;}#]*)/g), ["$null", "$AgentSkillsRepo"], "$AgentSkillsRepo");
if (!has(ps, /&\s*node\s+\$SkillsDirJs\s+\$Field\s+--installed\b/)) why.push(".ps1: Get-InstalledSkillsDir ya no le pregunta a la biblioteca con --installed");
if (!has(ps, new RegExp(`\\$SkillsDirJs\\s*=\\s*Join-Path \\(Join-Path \\$PSScriptRoot ${Q}lib${Q}\\) ${Q}skills-dir\\.js${Q}`))) why.push(".ps1: la biblioteca ya no es scripts/lib/skills-dir.js");
console.log(why.join(" · ") || "-");' "$1" "$2"
}
SAME="$(same_step_call "$TCG/scripts/install-tycon-hooks.sh" "$TCG/scripts/install-tycon-hooks.ps1")"; rc=$?
if [ "$rc" -eq 0 ] && [ "$SAME" = "-" ]; then
  ok "T7 el .sh y el .ps1 invocan install-third-party.js con la raíz instalada (la que contesta skills-dir.js --installed) y pasan --check"
else bad "T7 los instaladores no invocan el paso igual (rc=$rc): ${SAME}"; fi
# Controles: la misma mirada sobre una copia de los instaladores con UNA cosa cambiada tiene que dar rojo y decir cuál.
# mutated <origen> <destino> <texto> <reemplazo>: copia con ese texto cambiado; sale 1 si el texto no estaba (la prueba
# quedó vieja: hay que re-apuntarla, no darla por buena).
mutated() {
  node -e '
const fs = require("fs"); const [src, dst, from, to] = process.argv.slice(1);
const t = fs.readFileSync(src, "utf8");
if (!t.includes(from)) { console.error(`mutated: «${from}» no está en ${src}`); process.exit(1); }
fs.writeFileSync(dst, t.split(from).join(to));' "$@"
}
M7="$BASE/t7m"; mkdir -p "$M7"
SH_REAL="$TCG/scripts/install-tycon-hooks.sh"; PS_REAL="$TCG/scripts/install-tycon-hooks.ps1"
control() { # control <qué se cambió> <.sh> <.ps1> <lo que el motivo tiene que nombrar>
  local out; out="$(same_step_call "$2" "$3")"
  if [ "$out" != "-" ] && grep -q -- "$4" <<<"$out"; then ok "T7 control: $1 → rojo"
  else bad "T7 control: $1 tenía que dar rojo nombrando «$4» y dio: ${out}"; fi
}
if mutated "$SH_REAL" "$M7/a.sh" '--repo "$AGENT_SKILLS_REPO" ${_TP_ARGS' '--other "$AGENT_SKILLS_REPO" ${_TP_ARGS'; then
  control "el .sh deja de llamar al paso con la raíz instalada" "$M7/a.sh" "$PS_REAL" '^\.sh: 0 llamadas con la raíz instalada'
else bad "T7 control: no pude armar el .sh sin la llamada"; fi
if mutated "$PS_REAL" "$M7/b.ps1" '--repo $AgentSkillsRepo @tpArgs' "--repo (Join-Path \$ClaudeDir 'lab-folder') @tpArgs"; then
  control "el .ps1 llama al paso con otra carpeta" "$SH_REAL" "$M7/b.ps1" '\.ps1: llama al paso con otra carpeta'
else bad "T7 control: no pude armar el .ps1 con otra carpeta"; fi
if mutated "$SH_REAL" "$M7/c.sh" 'AGENT_SKILLS_REPO="$(dirname "$AGENT_SKILLS")"' 'AGENT_SKILLS_REPO="$HOME/lab-folder"'; then
  control "el .sh saca la raíz de otro lado" "$M7/c.sh" "$PS_REAL" '^\.sh: la raíz (AGENT_SKILLS_REPO) sale de otro lado'
else bad "T7 control: no pude armar el .sh con la raíz de otro lado"; fi
if mutated "$PS_REAL" "$M7/d.ps1" "if (\$Check) { \$tpArgs += '--check' }" ''; then
  control "el .ps1 no pasa --check en modo revisión" "$SH_REAL" "$M7/d.ps1" '\.ps1: en modo revisión no agrega --check'
else bad "T7 control: no pude armar el .ps1 sin --check"; fi
if mutated "$SH_REAL" "$M7/e.sh" '"$2" --installed ;;' '"$2" ;;'; then
  control "el .sh pregunta sin --installed (contestaría el clon de trabajo)" "$M7/e.sh" "$PS_REAL" '^\.sh: `_skills_dir write` ya no le pregunta'
else bad "T7 control: no pude armar el .sh sin --installed"; fi

[ "$FALLAS" -eq 0 ] && { echo "install-third-party: todo verde"; exit 0; }
echo "install-third-party: $FALLAS en rojo"; exit 1
