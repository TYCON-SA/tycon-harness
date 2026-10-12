#!/usr/bin/env bash
# suites-report.test.sh — red de `scripts/ci/suites-report.js`: el reporte nocturno de las suites
# guarda POR QUÉ falló cada una, no sólo el nombre (propuesta PIPE-DEBT-2.13-b).
#
# Caso: el 2026-09-14 el aviso de arranque decía «1 en rojo — pipeline-debt.test.js» y para saber la
# causa hubo que volver a correr la suite a mano (era una deuda vencida por fecha). El reporte viaja
# por git a todas las máquinas, así que el motivo se SANEA: ni rutas del agente ni credenciales.
#
# Correr: bash scripts/tests/suites-report.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$AQUI/scripts/ci/suites-report.js"
YAML="$AQUI/pipelines/azure-pipelines-banco.yml"
NOTICE="$AQUI/scripts/hooks/bench-notice.js"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0; pasaron=0
ok(){ echo "✅ reporte-suites: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ reporte-suites: $1"; fallos=$((fallos+1)); }
campo(){ node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(eval(process.argv[2])))' "$TMP/rep.json" "$1"; }

# ── R1. una suite roja: el reporte guarda el motivo, saneado ─────────────────────────────────────
mkdir -p "$TMP/rojas"
# La ruta del clon en un agente de CI, armada acá: escrita entera, el detector de publicación la marca como la ruta de
# la máquina de una persona (esta prueba viaja en la copia desde la story 8.26, tanda C).
AGENT_HOME="/$(printf home)/lab-agent"
cat > "$TMP/rojas/pipeline-debt.test.js.txt" <<OUT
✅ deuda: el registro se puede leer y parsear
❌ deuda: 🔴 INSTALADOR-CODEX: VENCIDA el 2026-09-13 — decidir o re-fechar (repo: $AGENT_HOME/work/1/s/scripts/install-tycon-hooks.sh)
   token de prueba: Bearer abc.def-123 · AZURE_DEVOPS_PAT=secreto-que-no-viaja
❌ pipeline-debt: 1 falla(s)
OUT
node "$SCRIPT" --rep "$TMP/rep.json" --build 999 --runs 83 --failures " pipeline-debt.test.js" --detail "$TMP/rojas"; rc=$?
{ [ "$rc" -eq 0 ] && [ "$(campo 'r.failures.join()')" = "pipeline-debt.test.js" ] && [ "$(campo 'r.corridas')" = 83 ] \
  && campo 'r.motivos["pipeline-debt.test.js"]' | grep -q 'VENCIDA el 2026-09-13' \
  && ! grep -qF "$AGENT_HOME" "$TMP/rep.json" && ! grep -q 'abc.def-123' "$TMP/rep.json" && ! grep -q 'secreto-que-no-viaja' "$TMP/rep.json" \
  && [ "$(campo 'r.kind')" = bash-tests ]; } \
  && ok "R1: 🔴 la suite roja trae su motivo (la línea del ❌), sin rutas del agente ni credenciales, y el formato de siempre intacto" \
  || no "R1: rc=$rc · $(cat "$TMP/rep.json" 2>/dev/null)"

# ── R2. una noche en verde: failures vacío y motivos vacío, nunca ausentes ───────────────────────
rm -rf "$TMP/rojas"; mkdir -p "$TMP/rojas"
node "$SCRIPT" --rep "$TMP/rep.json" --build 1000 --runs 83 --failures "" --detail "$TMP/rojas"; rc=$?
{ [ "$rc" -eq 0 ] && [ "$(campo 'r.failures.length')" = 0 ] && [ "$(campo 'JSON.stringify(r.motivos)')" = '{}' ]; } \
  && ok "R2: una noche verde publica failures y motivos vacíos" || no "R2: rc=$rc · $(cat "$TMP/rep.json" 2>/dev/null)"

# ── R3. roja sin salida guardada: el motivo lo dice, no queda vacío ──────────────────────────────
node "$SCRIPT" --rep "$TMP/rep.json" --build 1001 --runs 83 --failures " lab-suite.test.sh(ausente) otra.test.sh" --detail "$TMP/rojas"; rc=$?
{ [ "$rc" -eq 0 ] && [ "$(campo 'r.failures.join()')" = "lab-suite.test.sh(ausente),otra.test.sh" ] \
  && campo 'r.motivos["otra.test.sh"]' | grep -qi 'sin salida guardada' \
  && campo 'r.motivos["lab-suite.test.sh(ausente)"]' | grep -qi 'no está en el clon'; } \
  && ok "R3: una roja sin salida guardada, o ausente del clon, dice por qué no hay motivo" || no "R3: rc=$rc · $(cat "$TMP/rep.json" 2>/dev/null)"

# ── R4. el pipeline guarda la salida de la roja y arma el reporte con este guion ─────────────────
# Desde el 2026-10-04 son dos pasos en dos jobs: cada trabajo de suites guarda la salida de sus rojas («Correr las
# suites») y el job del reporte junta lo de todos y llama a este guion («Juntar lo que midió cada trabajo y armar el
# reporte»). Que la salida guardada llegue de un paso al otro lo corre scripts/tests/nightly-suites-shards.test.js.
paso(){ awk "/displayName: '$1'/{exit} {print}" "$YAML" | awk '/- script: \|/{buf=""} {buf=buf"\n"$0} END{print buf}'; }
# Desde la story 8.26 (tanda C) esta prueba viaja con la validación; el pipeline nocturno del banco, no.
if [ ! -f "$YAML" ] && [ ! -f "$AQUI/perfil-equipo.json" ]; then
  echo "⏭ reporte-suites: R4 NO MEDIDO — la copia pública no trae el pipeline nocturno del banco. No es un verde."
else
corre=$(paso 'Correr las suites'); junta=$(paso 'Juntar lo que midió cada trabajo y armar el reporte')
{ printf '%s' "$corre" | grep -q 'cp "$SUITE_OUT" "$OUT/red-output/' && printf '%s' "$junta" | grep -q 'scripts/ci/suites-report.js' \
  && printf '%s' "$junta" | grep -q -- '--detail "$MERGED/red-output"'; } \
  && ok "R4: «Correr las suites» guarda la salida de cada roja y el paso que junta llama a suites-report.js con ella" \
  || no "R4: el YAML no guarda la salida de las rojas o no arma el reporte con el guion"
fi

# ── R5. el aviso de arranque muestra el motivo al lado del nombre ────────────────────────────────
mkdir -p "$TMP/h"
node -e '
const fs=require("fs"); const t=new Date().toISOString();
fs.writeFileSync(process.argv[1], JSON.stringify({kind:"bash-tests",ts:t,origen:"azure-pipelines",corridas:83,failures:["pipeline-debt.test.js"],motivos:{"pipeline-debt.test.js":"❌ deuda: INSTALADOR-CODEX: VENCIDA el 2026-09-13 — decidir o re-fechar"}}));' "$TMP/suites.json"
# TYCON_NIGHTLY=1: el aviso de las suites nocturnas es parte de la integración «nightly» (story 8.3) y esta HOME no tiene perfil
salida=$(cd "$TMP" && echo '{"source":"startup"}' | HOME="$TMP/h" TYCON_NIGHTLY=1 TYCON_SUITES_REPORT="$TMP/suites.json" node "$NOTICE" 2>&1)
{ printf '%s' "$salida" | grep -q 'pipeline-debt.test.js' && printf '%s' "$salida" | grep -q 'VENCIDA el 2026-09-13'; } \
  && ok "R5: el aviso de arranque nombra la suite roja con su motivo" || no "R5: «${salida}»"

# ── R6. las marcas de falla de TODAS las suites del nocturno: también «MAL» y «✗» ────────────────
# 🔴 Caso: el 2026-09-17 el motivo de publish-bump.test.sh decía «warning: remote HEAD… · ok — C-11 … ·
#    FALLARON 1 chequeo(s)»: un caso VERDE y ninguno rojo, porque la suite marca sus fallas con «MAL» y
#    el guion no lo reconocía, así que caía en las tres últimas líneas. Medido ese día sobre las 110
#    suites de suites.json: 23 marcan con «MAL —» y 5 con «✗» (U+2717, no el «✖» U+2716 que sí estaba).
rm -rf "$TMP/rojas"; mkdir -p "$TMP/rojas"
cat > "$TMP/rojas/publish-bump.test.sh.txt" <<'OUT'
warning: remote HEAD refers to nonexistent ref, unable to checkout
  ok   — C-01 árbol limpio + carrera: publica (exit 0, main tiene 1.0.2)
  MAL  — C-03 exit 0, commits en main=2
  ok   — C-04 sin poder publicar: sale 1 y emite el aviso
  ok   — C-10 BUILD_SOURCEVERSION válida: la marca es ese commit
  ok   — C-11 BUILD_SOURCEVERSION ajena: se niega (exit 2) y lo dice

FALLARON 1 chequeo(s)
OUT
cat > "$TMP/rojas/test-runtime-matrix.js.txt" <<'OUT'
  ✓ caso-a
  ✗ caso-b — esperaba exit 2, dio 0
✗ 1 caso(s) fallando
OUT
node "$SCRIPT" --rep "$TMP/rep.json" --build 1002 --runs 110 --failures "publish-bump.test.sh test-runtime-matrix.js" --detail "$TMP/rojas"; rc=$?
M1="$(campo 'r.motivos["publish-bump.test.sh"]')"; M2="$(campo 'r.motivos["test-runtime-matrix.js"]')"
{ [ "$rc" -eq 0 ] && printf '%s' "$M1" | grep -q 'C-03 exit 0' && ! printf '%s' "$M1" | grep -q 'C-11'; } \
  && ok "R6: 🔴 una suite que marca con «MAL» trae su chequeo rojo en el motivo, no un caso verde" \
  || no "R6: rc=$rc · motivo=«${M1}»"
{ printf '%s' "$M2" | grep -q 'caso-b — esperaba exit 2' && ! printf '%s' "$M2" | grep -q 'caso-a'; } \
  && ok "R6b: 🔴 una suite que marca con «✗» trae su caso rojo en el motivo" \
  || no "R6b: motivo=«${M2}»"

# R6c · no-regresión (verde también contra el guion anterior, a propósito): las marcas nuevas cuentan
# sólo al PRINCIPIO de la línea. Un «MAL» o un «✗» en la prosa de un chequeo verde no desplaza al rojo:
# el motivo tiene tres líneas y una elegida de más le quita el lugar a la que dice qué falló.
cat > "$TMP/rojas/prosa.test.sh.txt" <<'OUT'
  ok   — el caso MAL formado se rechaza
  ok   — la salida trae ✗ cuando corresponde
❌ prosa: el caso real que falló
OUT
node "$SCRIPT" --rep "$TMP/rep.json" --build 1003 --runs 110 --failures "prosa.test.sh" --detail "$TMP/rojas"; rc=$?
M3="$(campo 'r.motivos["prosa.test.sh"]')"
{ [ "$rc" -eq 0 ] && [ "$M3" = "❌ prosa: el caso real que falló" ]; } \
  && ok "R6c: un «MAL» o un «✗» en medio de una línea verde no entra al motivo" \
  || no "R6c: rc=$rc · motivo=«${M3}»"

# ── R7. «no medida» no es «roja»: el reporte las distingue (revisión del 2026-10-04) ─────────────
# Desde que las suites del nocturno corren en trabajos paralelos, las de un trabajo que no terminó llegan en
# `--failures` con la marca «(no-medida)» (scripts/ci/suites-shard.js). El reporte las deja en `failures` —el control
# de cada cambio compara por ese nombre— y además las separa: `unmeasured` (las mismas entradas) y `complete`.
mkdir -p "$TMP/r7" && printf 'no medida: el trabajo 2 no terminó\n' > "$TMP/r7/lab-b.test.sh(no-medida).txt"
printf '❌ lab-a: se rompió\n' > "$TMP/r7/lab-a.test.sh.txt"
printf 'lab-a.test.sh\nlab-d.test.sh\n' > "$TMP/r7-ran.txt"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({kind:"bash-tests",ts:new Date().toISOString(),build:"1",corridas:4,failures:[],motivos:{},ran:["lab-a.test.sh","lab-b.test.sh","lab-d.test.sh","lab-gone.test.sh"]}))' "$TMP/rep.json"
node "$SCRIPT" --rep "$TMP/rep.json" --build 1004 --runs 2 --failures " lab-a.test.sh lab-b.test.sh(no-medida) lab-c.test.sh(ausente)" \
  --detail "$TMP/r7" --ran "$TMP/r7-ran.txt" 2>"$TMP/r7.err"; rc=$?
{ [ "$rc" -eq 0 ] && [ "$(campo 'JSON.stringify(r.unmeasured)')" = '["lab-b.test.sh(no-medida)"]' ] && [ "$(campo 'r.complete')" = false ] \
  && [ "$(campo 'r.failures.join()')" = "lab-a.test.sh,lab-b.test.sh(no-medida),lab-c.test.sh(ausente)" ] \
  && [ "$(campo 'r.motivos["lab-b.test.sh(no-medida)"]')" = "no medida: el trabajo 2 no terminó" ]; } \
  && ok "R7: 🔴 una suite no medida queda en failures con su marca, y aparte en unmeasured, con complete en false" \
  || no "R7: rc=$rc · $(cat "$TMP/rep.json" 2>/dev/null)"
{ [ "$(campo 'r.disappeared.join()')" = "lab-gone.test.sh" ] && ! grep -q 'lab-b' "$TMP/r7.err"; } \
  && ok "R7b: la no medida no se cuenta otra vez como desaparecida; la que desapareció de verdad, sí" \
  || no "R7b: disappeared=$(campo 'JSON.stringify(r.disappeared)') · $(cat "$TMP/r7.err")"

# R7c · una no medida sin su archivo de motivo no dice «sin salida guardada» (eso es de una roja): dice que no se midió.
node "$SCRIPT" --rep "$TMP/rep.json" --build 1005 --runs 1 --failures "lab-z.test.sh(no-medida)" --detail "$TMP/r7"; rc=$?
{ [ "$rc" -eq 0 ] && campo 'r.motivos["lab-z.test.sh(no-medida)"]' | grep -q '^no medida'; } \
  && ok "R7c: una no medida sin motivo guardado igual dice que no se midió" || no "R7c: rc=$rc · $(campo 'JSON.stringify(r.motivos)')"

# R7d · el espejo: una noche sin no medidas lo dice con los mismos campos (vacío y true), no omitiéndolos.
node "$SCRIPT" --rep "$TMP/rep.json" --build 1006 --runs 3 --failures "lab-a.test.sh lab-c.test.sh(ausente)" --detail "$TMP/r7"; rc=$?
{ [ "$rc" -eq 0 ] && [ "$(campo 'JSON.stringify(r.unmeasured)')" = '[]' ] && [ "$(campo 'r.complete')" = true ]; } \
  && ok "R7d: una noche entera trae unmeasured vacío y complete en true (una roja o una ausente no la vuelven incompleta)" \
  || no "R7d: rc=$rc · $(cat "$TMP/rep.json" 2>/dev/null)"

# ── R8. «no corrió»: la suite que el cambio no toca no es verde, ni roja, ni desaparecida (2026-10-04) ──────────
# La validación de cada pedido de merge deja para el nocturno las suites que el cambio no toca (scripts/ci/
# suites-for-change.js; las dos más largas, por scripts/ci/heavy-suites.json). `--not-run` (nombre<TAB>motivo) las
# anota en `notRun`, y la foto anterior no las cuenta como desaparecidas.
printf 'lab-a.test.sh\n' > "$TMP/r8-ran.txt"
printf 'export-real.test.sh\tel cambio no toca lo que mide (scripts/ci/heavy-suites.json): la corre el banco nocturno\n' > "$TMP/r8-skip.txt"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({kind:"bash-tests",ts:new Date().toISOString(),build:"1",corridas:2,failures:[],motivos:{},ran:["lab-a.test.sh","export-real.test.sh","lab-gone.test.sh"]}))' "$TMP/rep.json"
node "$SCRIPT" --rep "$TMP/rep.json" --build 1007 --runs 1 --failures "" --detail "$TMP/r7" --ran "$TMP/r8-ran.txt" --not-run "$TMP/r8-skip.txt" 2>"$TMP/r8.err"; rc=$?
{ [ "$rc" -eq 0 ] && campo 'r.notRun["export-real.test.sh"]' | grep -q 'no toca lo que mide' \
  && [ "$(campo 'r.disappeared.join()')" = "lab-gone.test.sh" ] && [ "$(campo 'r.failures.length')" = 0 ] && [ "$(campo 'r.complete')" = true ]; } \
  && ok "R8: 🔴 la suite que el cambio no toca va a notRun con su motivo: ni falla, ni no medida, ni desaparecida" \
  || no "R8: rc=$rc · $(cat "$TMP/rep.json" 2>/dev/null) · $(cat "$TMP/r8.err")"
node "$SCRIPT" --rep "$TMP/rep.json" --build 1008 --runs 1 --failures "" --detail "$TMP/r7"; rc=$?
{ [ "$rc" -eq 0 ] && [ "$(campo 'r.notRun === undefined')" = true ]; } \
  && ok "R8b: sin --not-run (el nocturno) el reporte no trae notRun: no hay nada que el nocturno deje de correr" \
  || no "R8b: rc=$rc · $(cat "$TMP/rep.json" 2>/dev/null)"

# ── R9. «no viaja»: la suite de la foto que no está en ningún registro del árbol (story 8.26, tanda C, AC 11) ──────
# Con la validación sobre el público, la foto nocturna (del repo de mantenimiento) nombra suites que el árbol validado no
# trae. Sin registro serían «desaparecidas»: el aviso nombraría cada una, y la que el cambio borró de verdad quedaría
# escondida entre ellas. `--registry` (el suites.json de la rama y el de main): la que no está en ninguno no viaja; la que
# está en el de main y hoy no corrió desapareció, como siempre.
printf 'lab-a.test.sh\n' > "$TMP/r9-ran.txt"
printf '{"diarias":[{"raiz":"arnes","ruta":"tests/lab-a.test.sh"}],"semanales":[]}\n' > "$TMP/r9-branch.json"
printf '{"diarias":[{"raiz":"arnes","ruta":"tests/lab-a.test.sh"},{"raiz":"arnes","ruta":"tests/lab-gone.test.sh"}],"semanales":[]}\n' > "$TMP/r9-main.json"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({kind:"bash-tests",ts:new Date().toISOString(),build:"1",corridas:3,failures:[],motivos:{},ran:["lab-a.test.sh","lab-private.test.sh","lab-gone.test.sh"]}))' "$TMP/r9-prev.json"
node "$SCRIPT" --rep "$TMP/rep.json" --build 1009 --runs 1 --failures "" --detail "$TMP/r7" --ran "$TMP/r9-ran.txt" \
  --previous "$TMP/r9-prev.json" --registry "$TMP/r9-branch.json" --registry "$TMP/r9-main.json" 2>"$TMP/r9.err"; rc=$?
{ [ "$rc" -eq 0 ] && [ "$(campo 'JSON.stringify(r.notTravelling)')" = '["lab-private.test.sh"]' ] \
  && [ "$(campo 'r.disappeared.join()')" = "lab-gone.test.sh" ] && ! grep -q 'lab-private' "$TMP/r9.err"; } \
  && ok "R9: 🔴 la suite que no está en ningún registro va a notTravelling; la que el cambio borró sigue siendo desaparecida" \
  || no "R9: rc=$rc · notTravelling=$(campo 'JSON.stringify(r.notTravelling)') disappeared=$(campo 'JSON.stringify(r.disappeared)') · $(cat "$TMP/r9.err")"
# R9b · un registro que no se deja leer no esconde nada: sin él no se sabe qué viaja, todas siguen como desaparecidas
node "$SCRIPT" --rep "$TMP/rep.json" --build 1010 --runs 1 --failures "" --detail "$TMP/r7" --ran "$TMP/r9-ran.txt" \
  --previous "$TMP/r9-prev.json" --registry "$TMP/no-existe.json" 2>"$TMP/r9b.err"; rc=$?
{ [ "$rc" -eq 0 ] && [ "$(campo 'r.disappeared.join()')" = "lab-gone.test.sh,lab-private.test.sh" ] \
  && [ "$(campo 'JSON.stringify(r.notTravelling || [])')" = '[]' ] && grep -q 'no pude leer el registro' "$TMP/r9b.err"; } \
  && ok "R9b: un registro ilegible no da nada por «no viaja»: lo dice y deja las desaparecidas como siempre" \
  || no "R9b: rc=$rc · $(cat "$TMP/rep.json" 2>/dev/null) · $(cat "$TMP/r9b.err")"

echo
total=$((pasaron + fallos))
[ "$fallos" -eq 0 ] && { echo "✅ reporte-suites: $pasaron/$total"; exit 0; } \
  || { echo "❌ reporte-suites: $fallos fallo(s) de $total"; exit 1; }
