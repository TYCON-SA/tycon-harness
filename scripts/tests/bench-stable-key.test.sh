#!/usr/bin/env bash
# bench-stable-key.test.sh — renombrar la PROSA de un hook no fabrica regresiones (2026-09-05).
#
# Caso disparador: la clave de cada caso del banco incluía la descripción para humanos del hook.
# El 03-09 se amplió la de branch-guard-notice y sus tres casos viejos quedaron "desaparecidos"
# de la línea de base: el aviso del arranque gritó "3 regresiones" durante dos días sin que
# existiera ninguna. Un banco que grita en falso se deja de mirar. Deuda BANCO-CLAVE-ES-LA-PROSA.
#
# Lo que fija: se fija una línea de base, se cambia SOLO la prosa del hook, y la comparación
# tiene que dar 0 regresiones y 0 desaparecidos. `RUNNER=` permite apuntar a otra copia del
# corredor (así se verificó el rojo previo contra la versión anterior).
set -u
TCG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER="${RUNNER:-$TCG/scripts/controls-bench/runner.js}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0; ok(){ echo "✅ $1"; }; mal(){ echo "❌ $1"; fallos=$((fallos+1)); }
mkdir -p "$TMP/casos" "$TMP/bin" "$TMP/base"
printf '#!/usr/bin/env bash\necho hola\n' > "$TMP/bin/saluda.sh"; chmod +x "$TMP/bin/saluda.sh"
escribir_caso() {  # $1 = prosa del hook
  node -e "
const fs=require('fs');
fs.writeFileSync('$TMP/casos/01-saluda.json', JSON.stringify({hooks:[{hook:process.argv[1],script:'$TMP/bin/saluda.sh',event:'SessionStart',matcher:'*',
  cases:[{id:'saluda',type:'must-emit',tools:['claude'],asymmetry:'sintético',stdin:{source:'startup'},expect:{stdout_re:['hola']}}]}]}));
" "$1"
}
escribir_caso "saluda.sh (versión corta de la prosa)"
TYCON_BENCH_CASES_DIR="$TMP/casos" TYCON_BENCH_BASELINE="$TMP/base/claude.json" node "$RUNNER" --tool claude --baseline write --json "$TMP/r1.json" >/dev/null 2>&1
[ -f "$TMP/base/claude.json" ] && ok "1 · línea de base fijada" || mal "1 · no se fijó la línea de base"
# se cambia SOLO la prosa
escribir_caso "saluda.sh (la misma pieza, con una descripción más larga porque creció)"
REP="$TMP/r2.json"
TYCON_BENCH_CASES_DIR="$TMP/casos" TYCON_BENCH_BASELINE="$TMP/base/claude.json" node "$RUNNER" --tool claude --baseline check --json "$REP" >/dev/null 2>&1
n_reg="$(node -e "console.log(require('$REP').baselineRegressions)")"
[ "$n_reg" = "0" ] \
  && ok "2 · cambiar la prosa del hook NO produce regresiones ni desaparecidos" \
  || mal "2 · la prosa renombrada produjo $n_reg 'regresión(es)' — la clave sigue siendo la descripción"
clave="$(node -e "console.log(Object.keys(require('$REP').results)[0])")"
[ "$clave" = "saluda.sh::saluda" ] \
  && ok "3 · la clave es <script>::<id> ($clave)" \
  || mal "3 · la clave es '$clave', no <script>::<id>"
echo "─────────────"
[ "$fallos" -eq 0 ] && { echo "✅ bench-clave-estable: todo verde"; exit 0; }
echo "❌ bench-clave-estable: $fallos en rojo"; exit 1
