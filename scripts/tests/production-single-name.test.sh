#!/usr/bin/env bash
# production-single-name.test.sh — el freno de producción con un solo nombre para sus estados.
#
# El freno escribe y protege su índice, su memoria y su registro sólo con el nombre en inglés. El catálogo de los
# productos se sigue leyendo con sus dos nombres. La memoria y el índice con el nombre viejo se pasan una sola vez a
# los nuevos y se borran: desde ahí nada los lee, y un servidor bajado con la puerta no vuelve.
#
# Qué prueba:
#   RetireD_SingleNameWriteAndProtect      — sólo se escriben los estados nuevos; el índice viejo no se usa como índice;
#                                            los nuevos, frenados; el viejo y el registro viejo ya no se leen ni se protegen
#   RetireD_OldCatalogStillReadAndProtected — el catálogo con su nombre y sus claves viejas se lee y se protege; dos
#                                            catálogos distintos dejan sus servidores desconocidos, y se frenan
#   RetireD_OldMemoryMergedBeforeDelete    — la migración única: suma lo viejo, guarda lo nuevo y borra lo viejo; un
#                                            servidor bajado no vuelve; una memoria vieja tocada deja el índice alterado
#                                            hasta que la puerta la resuelve
#
# Los casos del índice llaman a production-index.js directo y corren en cualquier máquina. Los del freno corren el
# hook con una HOME de juguete; en una máquina con el freno instalado (/opt/tycon) sus costuras de prueba no existen,
# así que esos casos no corren y lo dicen («NO MEDIDO»): no son un verde.
# Nunca /opt real ni sudo. Los nombres viejos se arman por concatenación.
#
# Correr: bash scripts/tests/production-single-name.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export TYCON_NO_NIGHTLY_EXAM=1
fails=0; passed=0
ok(){ echo "✅ production-single-name: $1"; passed=$((passed+1)); }
no(){ echo "❌ production-single-name: $1"; fails=$((fails+1)); }

IDX="$HERE/scripts/production/production-index.js"
GUARD="$HERE/scripts/hooks/prod-access-guard.js"

# los nombres de antes, armados
P_OLD="produ""ccion"
OLD_INDEX="$P_OLD-ind""ice.json"
OLD_MEMORY="$P_OLD-memo""ria.json"
OLD_LOG="$P_OLD.log"
OLD_CATALOG=".tycon/$P_OLD.json"
K_SERVERS="servi""dores"; K_ENV="ambi""ente"; K_KEYCHAIN="llave""ro"

world(){
  HOMEDIR="$TMP/home"; REPOS="$TMP/repos"
  rm -rf "$HOMEDIR" "$REPOS"
  mkdir -p "$HOMEDIR/.claude/.tycon-pipeline" "$REPOS/app/.tycon"
  ( cd "$REPOS/app" && git init -q . ) >/dev/null 2>&1
  printf '{"servers":[{"host":"a.example.com","environment":"production","keychain":"tycon-prod-a"}]}' > "$REPOS/app/.tycon/production.json"
  STATE="$HOMEDIR/.claude/.tycon-pipeline"
}

# $1 = script node; recibe el módulo del índice, la HOME y la raíz de repos en argv[1..3]
idx(){ node -e "$1" "$IDX" "$HOMEDIR" "$REPOS" 2>&1; }

# una memoria sellada como la escribe el índice: { produccion: [...], huella }
seal_memory(){ # $1 = ruta, $2 = hosts separados por coma, $3 = "bad" para una huella que no cierra
  node -e '
    const c = require("crypto"); const [, ruta, lista, mala] = process.argv;
    const hosts = lista ? lista.split(",") : [];
    const huella = c.createHash("sha256").update(JSON.stringify({ produccion: hosts })).digest("hex");
    require("fs").writeFileSync(ruta, JSON.stringify({ produccion: hosts, huella: mala === "bad" ? "0" + huella.slice(1) : huella }));
  ' "$1" "$2" "${3:-}"
}

# reclasificar como lo hace la puerta: construir, sacar el host, sellar de nuevo
door_reclassify(){ idx '
  const m = require(process.argv[1]); const [, , home, raiz] = process.argv;
  const i = m.construir({ home, raiz });
  i.memoria = (i.memoria || []).filter((h) => h !== "b.example.com");
  if (i.hosts["b.example.com"]) delete i.hosts["b.example.com"];
  i.memoria_alterada = false;
  m.guardar(i, home, { resellar: true });
' >/dev/null; }

regenerate(){ idx 'const m = require(process.argv[1]); const [, , home, raiz] = process.argv; m.guardar(m.construir({ home, raiz }), home);' >/dev/null; }
state_of(){ node -e 'const m = require(process.argv[1]); const [, , home, raiz, host] = process.argv; const i = m.construir({ home, raiz }); process.stdout.write(`${m.clasificar(host, i).estado}|${i.memoria_alterada}`);' "$IDX" "$HOMEDIR" "$REPOS" "$1" 2>&1; }

[ -f "$IDX" ] || { no "no existe $IDX"; echo "— production-single-name: $passed ok, $fails fallos —"; exit 1; }

# ═════ RetireD_SingleNameWriteAndProtect (índice) ═════════════════════════════════════════════════════════════
# Sin esto, el freno seguiría escribiendo los estados con su nombre de antes, que desde esta versión nadie lee.
world
regenerate
if [ -f "$STATE/production-index.json" ] && [ -f "$STATE/production-memory.json" ] && [ ! -e "$STATE/$OLD_INDEX" ] && [ ! -e "$STATE/$OLD_MEMORY" ]; then
  ok "RetireD_SingleNameWriteAndProtect · se escriben sólo el índice y la memoria nuevos @story-8.15 @ac-14"
else no "RetireD_SingleNameWriteAndProtect · estados escritos: $(ls "$STATE" | tr '\n' ' ') @story-8.15 @ac-14"; fi

# Un índice viejo fresco y con huella que cierra no se usa como índice: lo que vale es el nuevo
world
idx '
  const m = require(process.argv[1]); const fs = require("fs"); const [, , home, raiz] = process.argv;
  const i = m.construir({ home, raiz }); i.hosts = {}; i.memoria = []; i.huella = undefined;
  const c = require("crypto"); i.huella = c.createHash("sha256").update(JSON.stringify({ ...i, huella: undefined })).digest("hex");
  fs.writeFileSync(m.rutaIndiceVieja(home), JSON.stringify(i));
' >/dev/null
s="$(idx 'const m = require(process.argv[1]); const [, , home, raiz] = process.argv; process.stdout.write(m.clasificar("a.example.com", m.leer({ home, raiz })).estado);')"
if [ "$s" = "produccion" ] && [ -f "$STATE/production-index.json" ]; then
  ok "RetireD_SingleNameWriteAndProtect · un índice con el nombre de antes no se usa como índice @story-8.15 @ac-14"
else no "RetireD_SingleNameWriteAndProtect · el índice viejo se usó como índice: «${s}» @story-8.15 @ac-14"; fi

# ═════ RetireD_OldMemoryMergedBeforeDelete (índice) ═══════════════════════════════════════════════════════════
# Sin esto, un servidor que sólo la memoria vieja marcaba se perdería al dejar de leerla, o volvería después de bajarlo.
world
seal_memory "$STATE/production-memory.json" "a.example.com"
seal_memory "$STATE/$OLD_MEMORY" "a.example.com,b.example.com"
idx '
  const m = require(process.argv[1]); const fs = require("fs"); const [, , home] = process.argv;
  fs.writeFileSync(m.rutaIndiceVieja(home), JSON.stringify({ memoria: ["a.example.com", "c.example.com"] }));
' >/dev/null
regenerate
s="$(state_of b.example.com)"; t="$(state_of c.example.com)"
if [ "$s" = "produccion|false" ] && [ "$t" = "produccion|false" ] && [ ! -e "$STATE/$OLD_MEMORY" ] && [ ! -e "$STATE/$OLD_INDEX" ]; then
  ok "RetireD_OldMemoryMergedBeforeDelete · la migración suma la memoria y el índice viejos y los borra @story-8.15 @ac-33"
else no "RetireD_OldMemoryMergedBeforeDelete · migración: b «${s}» · c «${t}» · quedan: $(ls "$STATE" | tr '\n' ' ') @story-8.15 @ac-33"; fi

# Bajado por la puerta, no vuelve en la regeneración siguiente (con la memoria vieja todavía presente al bajarlo)
world
seal_memory "$STATE/production-memory.json" "a.example.com"
seal_memory "$STATE/$OLD_MEMORY" "a.example.com,b.example.com"
door_reclassify
regenerate
s="$(state_of b.example.com)"
if [ "$s" = "desconocido|false" ] && [ ! -e "$STATE/$OLD_MEMORY" ]; then
  ok "RetireD_OldMemoryMergedBeforeDelete · un servidor bajado con la puerta no vuelve desde la memoria vieja @story-8.15 @ac-33"
else no "RetireD_OldMemoryMergedBeforeDelete · el servidor bajado volvió: «${s}» @story-8.15 @ac-33"; fi

# La memoria vieja borrada y el índice viejo con un servidor: el servidor sigue de producción y el índice viejo se va
world
seal_memory "$STATE/production-memory.json" "a.example.com"
idx 'const m = require(process.argv[1]); require("fs").writeFileSync(m.rutaIndiceVieja(process.argv[2]), JSON.stringify({ memoria: ["a.example.com", "b.example.com"] }));' >/dev/null
regenerate
s="$(state_of b.example.com)"
if [ "${s%%|*}" = "produccion" ] && [ ! -e "$STATE/$OLD_INDEX" ]; then
  ok "RetireD_OldMemoryMergedBeforeDelete · sin la memoria vieja, lo del índice viejo se suma y el índice viejo se borra @story-8.15 @ac-33"
else no "RetireD_OldMemoryMergedBeforeDelete · índice viejo: «${s}» · quedan: $(ls "$STATE" | tr '\n' ' ') @story-8.15 @ac-33"; fi

# Las dos memorias borradas: se juntan las de los dos índices, y queda a la vista (alguien las borró)
world
idx '
  const m = require(process.argv[1]); const fs = require("fs"); const [, , home] = process.argv;
  fs.writeFileSync(m.rutaIndice(home), JSON.stringify({ memoria: ["a.example.com"] }));
  fs.writeFileSync(m.rutaIndiceVieja(home), JSON.stringify({ memoria: ["b.example.com"] }));
' >/dev/null
s="$(state_of a.example.com)"; t="$(state_of b.example.com)"
if [ "$s" = "produccion|true" ] && [ "$t" = "produccion|true" ]; then
  ok "RetireD_OldMemoryMergedBeforeDelete · con las dos memorias borradas, se juntan los dos índices y se dice alterada @story-8.15 @ac-33"
else no "RetireD_OldMemoryMergedBeforeDelete · memorias borradas: a «${s}» · b «${t}» @story-8.15 @ac-33"; fi

# La memoria vieja tocada a mano: lo legible se suma, no se borra, el índice queda alterado; la puerta lo resuelve
world
seal_memory "$STATE/production-memory.json" "a.example.com"
seal_memory "$STATE/$OLD_MEMORY" "a.example.com,d.example.com" bad
regenerate
s="$(state_of d.example.com)"
if [ "$s" = "produccion|true" ] && [ -e "$STATE/$OLD_MEMORY" ]; then
  ok "RetireD_OldMemoryMergedBeforeDelete · la memoria vieja tocada no se borra, suma lo suyo y deja el índice alterado @story-8.15 @ac-33"
else no "RetireD_OldMemoryMergedBeforeDelete · memoria vieja tocada: «${s}» · quedan: $(ls "$STATE" | tr '\n' ' ') @story-8.15 @ac-33"; fi
idx 'const m = require(process.argv[1]); const [, , home, raiz] = process.argv; process.exitCode = m.resolverViejos({ home, raiz }).resuelto ? 0 : 1;' >/dev/null
rc=$?
regenerate
s="$(state_of d.example.com)"
if [ "$rc" = 0 ] && [ "$s" = "produccion|false" ] && [ ! -e "$STATE/$OLD_MEMORY" ]; then
  ok "RetireD_OldMemoryMergedBeforeDelete · la puerta la resuelve una vez: suma, borra lo viejo y la alteración no vuelve @story-8.15 @ac-33"
else no "RetireD_OldMemoryMergedBeforeDelete · después de resolver: rc=$rc · «${s}» · quedan: $(ls "$STATE" | tr '\n' ' ') @story-8.15 @ac-33"; fi

# Un índice viejo que no se puede leer no cuenta como vacío: el índice queda alterado y no se borra; la puerta lo
# resuelve y lo borra
world
seal_memory "$STATE/production-memory.json" "a.example.com"
printf '{roto' > "$STATE/$OLD_INDEX"
regenerate
s="$(state_of a.example.com)"
if [ "$s" = "produccion|true" ] && [ -e "$STATE/$OLD_INDEX" ]; then
  ok "RetireD_OldMemoryMergedBeforeDelete · un índice viejo ilegible deja el índice alterado y no se borra @story-8.15 @ac-33"
else no "RetireD_OldMemoryMergedBeforeDelete · índice viejo ilegible: «${s}» · quedan: $(ls "$STATE" | tr '\n' ' ') @story-8.15 @ac-33"; fi
idx 'const m = require(process.argv[1]); const [, , home, raiz] = process.argv; process.exitCode = m.resolverViejos({ home, raiz }).resuelto ? 0 : 1;' >/dev/null
rc=$?
regenerate
s="$(state_of a.example.com)"
if [ "$rc" = 0 ] && [ "$s" = "produccion|false" ] && [ ! -e "$STATE/$OLD_INDEX" ]; then
  ok "RetireD_OldMemoryMergedBeforeDelete · la puerta resuelve el índice viejo ilegible y lo borra @story-8.15 @ac-33"
else no "RetireD_OldMemoryMergedBeforeDelete · índice viejo ilegible después de resolver: rc=$rc «${s}» · quedan: $(ls "$STATE" | tr '\n' ' ') @story-8.15 @ac-33"; fi

# Las memorias borradas y el índice roto: queda alterado, y sigue alterado en las regeneraciones siguientes
world
seal_memory "$STATE/production-memory.json" "a.example.com"
regenerate
rm -f "$STATE/production-memory.json"; printf '{roto' > "$STATE/production-index.json"
regenerate; regenerate
s="$(state_of a.example.com)"
if [ "${s#*|}" = "true" ]; then
  ok "RetireD_OldMemoryMergedBeforeDelete · memorias borradas con el índice roto: sigue alterado después de regenerar @story-8.15 @ac-33"
else no "RetireD_OldMemoryMergedBeforeDelete · memorias borradas con el índice roto se olvidó: «${s}» @story-8.15 @ac-33"; fi

# Si lo de antes no se pudo borrar, resolver no lo da por resuelto (ni «sana» ni «se borró»): una carpeta con el
# nombre de la memoria vieja no se borra con unlink
world
seal_memory "$STATE/production-memory.json" "a.example.com"
regenerate
mkdir -p "$STATE/$OLD_MEMORY/adentro"
r="$(idx 'const m = require(process.argv[1]); const [, , home, raiz] = process.argv; const r = m.resolverViejos({ home, raiz }); process.stdout.write(`${r.resuelto}|${r.motivo || ""}`);')"
if [ "${r%%|*}" = "false" ] && printf '%s' "$r" | grep "no pude borrar" >/dev/null; then
  ok "RetireD_OldMemoryMergedBeforeDelete · si lo de antes no se pudo borrar, resolver no lo da por resuelto @story-8.15 @ac-33"
else no "RetireD_OldMemoryMergedBeforeDelete · lo de antes quedó y resolver dijo: «${r}» @story-8.15 @ac-33"; fi

# Con la memoria NUEVA tocada, resolver lo viejo no la vuelve a sellar: eso lo decide una persona con --reclassify
world
seal_memory "$STATE/production-memory.json" "a.example.com" bad
idx 'const m = require(process.argv[1]); const [, , home, raiz] = process.argv; process.exitCode = m.resolverViejos({ home, raiz }).resuelto ? 0 : 1;' >/dev/null
rc=$?
s="$(state_of a.example.com)"
if [ "$rc" = 1 ] && [ "$s" = "produccion|true" ]; then
  ok "RetireD_OldMemoryMergedBeforeDelete · con la memoria nueva tocada, resolver lo viejo no la sella @story-8.15 @ac-33"
else no "RetireD_OldMemoryMergedBeforeDelete · la memoria nueva tocada se selló sola: rc=$rc «${s}» @story-8.15 @ac-33"; fi

# La puerta, al verificar, sólo resuelve la memoria con resolverViejos: nunca la vuelve a sellar por su cuenta (con la
# memoria nueva tocada, eso es --reclassify). Se lee el bloque de --verify de la puerta, sin correrla.
DOOR="$HERE/scripts/production/tycon-prod-sql"
verify_block="$(awk '/^if \[ "\$MODO" = verificar \]; then/{on=1} on{print} on&&/^fi$/{exit}' "$DOOR")"
if printf '%s' "$verify_block" | grep "resolverViejos" >/dev/null && ! printf '%s' "$verify_block" | grep "resellar" >/dev/null; then
  ok "RetireD_OldMemoryMergedBeforeDelete · --verify no vuelve a sellar por su cuenta una memoria nueva tocada @story-8.15 @ac-33"
else no "RetireD_OldMemoryMergedBeforeDelete · el bloque de --verify sella por su cuenta ($(printf '%s' "$verify_block" | grep -c resellar) resellar) @story-8.15 @ac-33"; fi

# ═════ los casos del freno (el hook) ══════════════════════════════════════════════════════════════════════════
if [ -d /opt/tycon ]; then
  echo "⏭ production-single-name: NO MEDIDO — esta máquina tiene el freno instalado (/opt/tycon): sin costuras de prueba, los casos del freno corren en la CI y en el nocturno. No es un verde."
  echo "— production-single-name: $passed ok, $fails fallos (casos del freno: no medidos) —"
  [ "$fails" = 0 ]; exit $?
fi
[ -f "$GUARD" ] || { no "no existe $GUARD"; echo "— production-single-name: $passed ok, $fails fallos —"; exit 1; }

payload(){ CMD="$1" node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",hook_event_name:"PreToolUse",cwd:"/tmp",tool_input:{command:process.env.CMD}}))'; }
run_guard(){ payload "$1" | env HOME="$HOMEDIR" TYCON_REPOS_ROOT="$REPOS" TYCON_PROD_SESSION_SINCE=0 node "$GUARD" >"$TMP/out" 2>"$TMP/err"; echo $?; }

# ═════ RetireD_SingleNameWriteAndProtect (freno) ══════════════════════════════════════════════════════════════
world; regenerate
rc="$(run_guard "rm -f $STATE/production-index.json")"
[ "$rc" = 2 ] && ok "RetireD_SingleNameWriteAndProtect · borrar el índice nuevo se frena @story-8.15 @ac-14" \
  || no "RetireD_SingleNameWriteAndProtect · el índice nuevo no se frenó (rc=$rc) @story-8.15 @ac-14"
rc="$(run_guard "rm -f $STATE/production-memory.json")"
[ "$rc" = 2 ] && ok "RetireD_SingleNameWriteAndProtect · borrar la memoria nueva se frena @story-8.15 @ac-14" \
  || no "RetireD_SingleNameWriteAndProtect · la memoria nueva no se frenó (rc=$rc) @story-8.15 @ac-14"
rc="$(run_guard "rm -f $STATE/$OLD_INDEX")"
[ "$rc" = 0 ] && ok "RetireD_SingleNameWriteAndProtect · el índice con el nombre de antes ya no se protege @story-8.15 @ac-14" \
  || no "RetireD_SingleNameWriteAndProtect · el índice viejo se sigue protegiendo (rc=$rc) — $(head -c 160 "$TMP/err") @story-8.15 @ac-14"
printf '{}' > "$STATE/$OLD_MEMORY"
rc="$(run_guard "rm -f $STATE/$OLD_MEMORY")"; rc2="$(run_guard "python3 -c \"import os; os.remove('$STATE/$OLD_MEMORY')\"")"
[ "$rc" = 0 ] && [ "$rc2" = 0 ] && ok "RetireD_SingleNameWriteAndProtect · la memoria con el nombre de antes ya no se protege, tampoco nombrada dentro de un programa @story-8.15 @ac-14" \
  || no "RetireD_SingleNameWriteAndProtect · la memoria vieja se sigue protegiendo (rm rc=$rc · python rc=$rc2) — $(head -c 160 "$TMP/err") @story-8.15 @ac-14"

# El registro: sólo el nuevo; el de antes no se lee ni se copia
world; regenerate
printf '{"ts":"antes"}\n' > "$STATE/$OLD_LOG"
rc="$(run_guard "sqlcmd -S a.example.com -Q \"select 1\"")"
if [ "$rc" = 2 ] && [ -f "$STATE/production.log" ] && ! grep -q '"ts":"antes"' "$STATE/production.log" && [ "$(wc -l < "$STATE/$OLD_LOG" | tr -d ' ')" = 1 ]; then
  ok "RetireD_SingleNameWriteAndProtect · el freno anota sólo en production.log y no toca el registro de antes @story-8.15 @ac-14"
else no "RetireD_SingleNameWriteAndProtect · registro: rc=$rc · nuevo $( [ -f "$STATE/production.log" ] && head -c 80 "$STATE/production.log" || echo falta) · viejo $(wc -l < "$STATE/$OLD_LOG" | tr -d ' ') líneas @story-8.15 @ac-14"; fi

# ═════ RetireD_OldCatalogStillReadAndProtected ════════════════════════════════════════════════════════════════
# Sin esto, un producto que todavía no migró su catálogo dejaría de estar protegido.
world
mkdir -p "$REPOS/legacy/.tycon"; ( cd "$REPOS/legacy" && git init -q . ) >/dev/null 2>&1
printf '{"%s":[{"host":"old.example.com","%s":"produccion","%s":"tycon-prod-b"}]}' "$K_SERVERS" "$K_ENV" "$K_KEYCHAIN" > "$REPOS/legacy/$OLD_CATALOG"
regenerate
rc="$(run_guard "sqlcmd -S old.example.com -Q \"select 1\"")"
if [ "$rc" = 2 ] && grep -q "PRODUCCIÓN" "$TMP/err"; then ok "RetireD_OldCatalogStillReadAndProtected · un servidor del catálogo de antes se frena como producción @story-8.15 @ac-32"
else no "RetireD_OldCatalogStillReadAndProtected · el catálogo de antes no frenó (rc=$rc) — $(head -c 160 "$TMP/err") @story-8.15 @ac-32"; fi
rc="$(run_guard "rm -f $REPOS/legacy/$OLD_CATALOG")"
[ "$rc" = 2 ] && ok "RetireD_OldCatalogStillReadAndProtected · borrar el catálogo de antes se frena @story-8.15 @ac-32" \
  || no "RetireD_OldCatalogStillReadAndProtected · el catálogo de antes no se protege (rc=$rc) @story-8.15 @ac-32"
# Los dos catálogos con contenido distinto: los servidores de ese repo quedan desconocidos, y se frenan (en un mundo
# nuevo, sin memoria que lo recuerde de antes)
world
mkdir -p "$REPOS/legacy/.tycon"; ( cd "$REPOS/legacy" && git init -q . ) >/dev/null 2>&1
printf '{"%s":[{"host":"twice.example.com","%s":"no-produccion"}]}' "$K_SERVERS" "$K_ENV" > "$REPOS/legacy/$OLD_CATALOG"
printf '{"servers":[{"host":"twice.example.com","environment":"non-production","port":1444}]}' > "$REPOS/legacy/.tycon/production.json"
regenerate
s="$(state_of twice.example.com)"
rc="$(run_guard "sqlcmd -S twice.example.com -Q \"select 1\"")"
if [ "${s%%|*}" = "desconocido" ] && [ "$rc" = 2 ]; then
  ok "RetireD_OldCatalogStillReadAndProtected · con los dos catálogos distintos, sus servidores quedan desconocidos y se frenan @story-8.15 @ac-32"
else no "RetireD_OldCatalogStillReadAndProtected · dos catálogos: «${s}» rc=$rc @story-8.15 @ac-32"; fi
# El lint del catálogo sigue mirando el nombre de antes: acepta uno bien formado y rechaza uno mal formado
mkdir -p "$TMP/lint-ok/.tycon" "$TMP/lint-bad/.tycon"
printf '{"%s":[{"host":"old.example.com","%s":"produccion","%s":"tycon-prod-b"}]}' "$K_SERVERS" "$K_ENV" "$K_KEYCHAIN" > "$TMP/lint-ok/$OLD_CATALOG"
printf '{"x":1}' > "$TMP/lint-bad/$OLD_CATALOG"
node "$HERE/scripts/production/lint-production-json.js" "$TMP/lint-ok/$OLD_CATALOG" >"$TMP/lint" 2>&1; r1=$?
node "$HERE/scripts/production/lint-production-json.js" "$TMP/lint-bad/$OLD_CATALOG" >>"$TMP/lint" 2>&1; r2=$?
if [ "$r1" = 0 ] && [ "$r2" != 0 ]; then
  ok "RetireD_OldCatalogStillReadAndProtected · el lint del catálogo lee el archivo con su nombre de antes @story-8.15 @ac-32"
else no "RetireD_OldCatalogStillReadAndProtected · lint: bien formado rc=$r1 · mal formado rc=$r2 — $(head -c 160 "$TMP/lint") @story-8.15 @ac-32"; fi

echo "— production-single-name: $passed ok, $fails fallos —"
[ "$fails" = 0 ]
