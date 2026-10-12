#!/usr/bin/env bash
# bench-unmeasured.test.sh — un TIEMPO AGOTADO no es un control roto (2026-09-04).
#
# Caso disparador: el aviso del arranque venía diciendo "3 regresiones" y después "5" del banco
# determinista. Ninguna era real. Dos de ellas eran dos casos del grabador de instintos a los que
# se les agotaban los 20 s cuando la máquina estaba cargada — corridos solos daban verde. El banco
# los contaba como rojos Y como regresiones contra la línea de base, o sea que gritaba por algo
# que no tenía nada que ver con los controles. Un banco que grita en falso es un banco que se deja
# de mirar, y con él se pierde el rojo verdadero.
#
# Lo que fija este test: un caso al que se le acaba el tiempo DOS veces (hay un reintento) se
# declara NO MEDIDO — ni verde ni rojo, su propio balde — no suma a "rojos", no cuenta como
# regresión contra la línea de base, y SE DICE. "No medido" nunca puede leerse como "limpio".
#
# 🔴 Sin pipes sobre el comando del corredor: el exit code real es parte del veredicto.
set -u
TCG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fallos=0
ok()   { echo "✅ $1"; }
mal()  { echo "❌ $1"; fallos=$((fallos+1)); }

# Un control que tarda más de lo que su caso le da.
mkdir -p "$TMP/casos" "$TMP/bin"
cat > "$TMP/bin/tardon.sh" <<'EOF'
#!/usr/bin/env bash
sleep 5
echo "llegué tarde"
EOF
chmod +x "$TMP/bin/tardon.sh"

cat > "$TMP/casos/99-tardon.json" <<EOF
{
  "hooks": [
    {
      "hook": "tardon.sh (control que no llega a tiempo)",
      "script": "$TMP/bin/tardon.sh",
      "event": "SessionStart",
      "matcher": "*",
      "cases": [
        {
          "id": "se-le-acaba-el-tiempo",
          "type": "must-emit",
          "timeout_s": 1,
          "tools": ["claude"],
          "asymmetry": "sintético: sólo prueba al corredor del banco",
          "stdin": { "source": "startup" },
          "expect": { "stdout_re": ["llegué tarde"] }
        }
      ]
    }
  ]
}
EOF

REP="$TMP/reporte.json"
salida="$(TYCON_BENCH_CASES_DIR="$TMP/casos" node "$TCG/scripts/controls-bench/runner.js" --tool claude --json "$REP" 2>&1)"

# 1 · lo dice, y lo dice como NO MEDIDO
# 🔴 Se busca la marca 🟡, que sólo se imprime cuando hay al menos uno. Buscar el texto
# "NO MEDIDO" a secas no servía: la línea de resumen lo nombra SIEMPRE ("0 NO MEDIDOS"), así
# que el chequeo pasaba incluso con el arreglo desactivado — un chequeo que no puede fallar.
echo "$salida" | grep -q "🟡" \
  && ok "1 · lo marca como NO MEDIDO (🟡) en la salida" \
  || { mal "1 · no lo marcó — un caso que no se pudo medir no puede pasar en silencio"; echo "$salida"; }

# 2 · no lo cuenta como rojo
n_rojos="$(node -e "console.log(require('$REP').failed)")"
[ "$n_rojos" = "0" ] \
  && ok "2 · no suma a rojos (failed=0)" \
  || mal "2 · lo contó como rojo (failed=$n_rojos) — un tiempo agotado no dice nada del control"

# 3 · lo cuenta en su propio balde
n_nm="$(node -e "console.log(require('$REP').nomedido)")"
[ "$n_nm" = "1" ] \
  && ok "3 · lo cuenta como no medido (nomedido=1)" \
  || mal "3 · nomedido=$n_nm — sin balde propio, 'no medido' se confunde con 'limpio'"

# 4 · con una línea de base que lo daba verde, NO es una regresión
mkdir -p "$TMP/base"
node -e "
const fs=require('fs');
fs.writeFileSync('$TMP/base/claude.json', JSON.stringify({fixed_at:new Date().toISOString(),tool:'claude',cases:{'tardon.sh::se-le-acaba-el-tiempo':true}},null,2));
"
# 🔴 Con su propio archivo de línea de base: el test NUNCA toca la foto real del equipo. Si lo
# hiciera y se interrumpiera a la mitad, dejaría al banco sin memoria de qué estaba verde.
REP2="$TMP/reporte2.json"
salida2="$(TYCON_BENCH_CASES_DIR="$TMP/casos" TYCON_BENCH_BASELINE="$TMP/base/claude.json" \
  node "$TCG/scripts/controls-bench/runner.js" --tool claude --baseline check --json "$REP2" 2>&1)"
n_reg="$(node -e "console.log(require('$REP2').baselineRegressions)")"
[ "$n_reg" = "0" ] \
  && ok "4 · no lo cuenta como regresión contra la línea de base" \
  || { mal "4 · lo contó como regresión ($n_reg) — así se fabrican los rojos falsos que vació el banco"; echo "$salida2"; }

# 5 · un hook que SE VA SIN LEER su entrada no es un rojo (corrida 10001 en Linux, 2026-09-05).
# Se fuerza el EPIPE en cualquier sistema: la entrada del caso lleva un campo de 300 KB (más que el
# buffer del pipe) y el hook sale en su primera línea sin leer nada. Antes: "ERROR: spawnSync bash
# EPIPE", contado como rojo y como paridad rota. El proceso corrió y terminó: se evalúa lo que hizo.
cat > "$TMP/bin/callado.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TMP/bin/callado.sh"
node -e "
const fs=require('fs');
fs.writeFileSync('$TMP/casos/98-callado.json', JSON.stringify({hooks:[{hook:'callado.sh (se va sin leer)',script:'$TMP/bin/callado.sh',event:'SessionStart',matcher:'*',
  cases:[{id:'sale-sin-leer-la-entrada',type:'must-stay-quiet',tools:['claude'],asymmetry:'sintético: sólo prueba al corredor',
          stdin:{source:'startup',relleno:'x'.repeat(300*1024)},expect:{}}]}]}));
"
REP5="$TMP/reporte5.json"
salida5="$(TYCON_BENCH_CASES_DIR="$TMP/casos" node "$TCG/scripts/controls-bench/runner.js" --tool claude --only callado --json "$REP5" 2>&1)"
n_rojos5="$(node -e "console.log(require('$REP5').failed)")"
[ "$n_rojos5" = "0" ] \
  && ok "5 · un hook que sale sin leer su entrada (EPIPE) no es un rojo" \
  || { mal "5 · lo contó como rojo (failed=$n_rojos5) — el hook corrió y terminó; EPIPE es del corredor, no del control"; echo "$salida5" | head -5; }

echo "─────────────"
[ "$fallos" -eq 0 ] && { echo "✅ bench-nomedido: todo verde"; exit 0; }
echo "❌ bench-nomedido: $fallos caso(s) en rojo"; exit 1
