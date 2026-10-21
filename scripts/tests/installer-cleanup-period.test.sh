#!/usr/bin/env bash
# installer-cleanup-period.test.sh — el instalador fija `cleanupPeriodDays` y respeta al dev.
#
# Claude Code borra la transcripción de cada sesión a los 30 días, y esa
# transcripción es la única fuente del consumo y del hilo de cada corrida del pipeline. Esta línea del instalador
# frena la pérdida en todas
# las máquinas. Tres casos: (1) sin la clave → la escribe en 365; (2) el dev la fijó en otro valor → no
# se pisa; (3) sin el bloque, la clave no aparece.
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INST="$RAIZ/scripts/install-tycon-hooks.sh"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export TYCON_NO_CANONICAL_PATH=1 TYCON_NO_AZ_PROJECTS_REFRESH=1 TYCON_NO_BOOTSTRAP_HEAL=1 \
  TYCON_NO_CLAUDEMD_SYNC=1 TYCON_NO_COMMANDS_SYNC=1 TYCON_NO_ENGRAM_PROJECT_CHECK=1 \
  TYCON_NO_ENGRAM_VERSION_CHECK=1 TYCON_NO_NIGHTLY_EXAM=1 TYCON_NO_GIT_HOOKS=1 \
  TYCON_NO_GUI_ENV=1 TYCON_NO_SQLITE_CHECK=1 TYCON_NO_AGENTSMD_POINTER=1
# 🔴 AISLAMIENTO: esta suite corre el instalador REAL. Con el HOME de quien la corre y la tanda de fondo
#    prendida, en el banco nocturno de Azure el instalador lanzaría rescate → recolección → subida con el HOME del agente,
#    y el agente subiría sus registros al buzón del equipo como si fuera una máquina. El destino inalcanzable es la
#    red de seguridad: aunque la tanda arranque, no sube nada.
#    El instalador exige `~/.claude/agent-skills/skills/tycon-pipeline`: va un esqueleto vacío, nunca un enlace al
#    agent-skills real (lo usan las sesiones vivas; el instalador no tiene por qué poder tocarlo desde una prueba).
HOME="$T/casa"; mkdir -p "$HOME/.claude/agent-skills/skills/tycon-pipeline"; export HOME
export TYCON_NO_THREAD_RESCUE=1 TYCON_NO_UPLOAD_RUNS=1 TYCON_NO_DOWNLOAD_RUNS=1 TYCON_NO_COLLECT_FINDINGS=1 \
  TYCON_MAILBOX_URL_BASE=http://127.0.0.1:9
# 🔴 Y el HOME falso deja sin sello las tareas DIARIAS del instalador: con TYCON_CODEX=1 de
#    quien corre la suite, cada corrida desplegaría Codex en un home vacío, lanzaría el disparo real de Codex (con red) y la
#    auditoría de paridad dejaría rojos falsos en .bench; y el respaldo del medidor podría escribir en .dashboard. Se apagan
#    EN CADA LLAMADA (env), no sólo exportadas: así le ganan al ambiente de quien corre la suite (lo prueba el chequeo 6).
# CLAUDE_CODE_PLUGIN_DIRS fuera: la pone el instalador en cada máquina con el arnés y, heredada, la
# instalación de prueba anotaría la carpeta de mods DE VERDAD de quien corre la suite.
AISLADO=(env -u CLAUDE_CODE_PLUGIN_DIRS TYCON_CODEX=0 TYCON_BENCH_DAILY=0 TYCON_STAGE_METRICS=0 CODEX_HOME="$T/codex-home")
correr() { TYCON_SETTINGS_PATH="$1" "${AISLADO[@]}" bash "$INST" >/dev/null 2>&1; }
leer()   { python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('cleanupPeriodDays'))" "$1"; }

# 1) sin la clave → 365
echo '{"hooks":{}}' > "$T/a.json"; correr "$T/a.json"
[ "$(leer "$T/a.json")" = "365" ] && ok "sin la clave, el instalador escribe cleanupPeriodDays=365" \
  || mal "sin la clave, quedó cleanupPeriodDays=$(leer "$T/a.json") (esperado 365)"

# 2) el dev la fijó → gana él
echo '{"hooks":{},"cleanupPeriodDays":90}' > "$T/b.json"; correr "$T/b.json"
[ "$(leer "$T/b.json")" = "90" ] && ok "el valor del dev (90) no se pisa" \
  || mal "el instalador pisó el valor del dev: quedó $(leer "$T/b.json")"

# 3) con el bloque borrado de una copia, la clave no aparece
sed '/^TOP_CANONICAL = {/,/^    added.append(("settings"/d' "$INST" > "$T/inst-sin.sh"
echo '{"hooks":{}}' > "$T/c.json"; TYCON_SETTINGS_PATH="$T/c.json" "${AISLADO[@]}" bash "$T/inst-sin.sh" >/dev/null 2>&1
[ "$(leer "$T/c.json")" = "None" ] && ok "sin el bloque, la clave no aparece (rojo previo)" \
  || mal "el rojo previo no se reproduce: la copia sin el bloque igual escribió $(leer "$T/c.json")"

# 4) el reporte que ve el dev DICE que la agregó (si el bloque corriera después de cerrar el reporte,
#    la clave se escribiría sin que la salida lo mencionara nunca)
echo '{"hooks":{}}' > "$T/d.json"
SALIDA="$(TYCON_SETTINGS_PATH="$T/d.json" "${AISLADO[@]}" bash "$INST" 2>&1)"
case "$SALIDA" in
  *cleanupPeriodDays*) ok "la salida del instalador menciona cleanupPeriodDays al agregarla" ;;
  *) mal "la clave se escribió pero el reporte no lo dice (rojo previo del hallazgo 9)" ;;
esac

# 5) T15 · SuiteDelInstalador_AislaHome · la suite no lanza la tanda de fondo del instalador
# 🔴 Sin las cuatro llaves de arriba la tanda arranca y deja su registro en el HOME falso.
TP="$HOME/.claude/.tycon-pipeline"; n=0; LANZO=""
while [ "$n" -lt 12 ]; do
  for r in rescate-hilo recolectar-hallazgos subir-corridas bajar-corridas; do [ -e "$TP/$r.log" ] && LANZO="$LANZO $r"; done
  [ -n "$LANZO" ] && break; sleep 0.25; n=$((n+1))
done
[ -z "$LANZO" ] && ok "2.12-T15 SuiteDelInstalador_AislaHome: la suite no lanzó la tanda de fondo del instalador (sin registros en el HOME falso)" \
  || mal "2.12-T15 SuiteDelInstalador_AislaHome: la suite lanzó la tanda de fondo del instalador:$LANZO"

# 6) T15 · SuiteDelInstalador_AislaHome · con TYCON_CODEX=1 en el ambiente de quien corre la suite (la máquina del dev),
#    el instalador no despliega Codex ni lanza sus tareas diarias
# 🔴 Sin TYCON_CODEX=0 en cada llamada → el despliegue escribe en el CODEX_HOME temporal.
echo '{"hooks":{}}' > "$T/e.json"; TYCON_CODEX=1 correr "$T/e.json"
[ ! -e "$T/codex-home" ] && ok "2.12-T15 SuiteDelInstalador_AislaHome: con TYCON_CODEX=1 en el ambiente, la suite no despliega Codex ni lanza sus tareas diarias" \
  || mal "2.12-T15 SuiteDelInstalador_AislaHome: con TYCON_CODEX=1 en el ambiente, el instalador desplegó Codex en $T/codex-home"

echo
if [ "$FALLOS" -gt 0 ]; then echo "FALLARON $FALLOS chequeo(s)"; exit 1; fi
echo "todo verde"; exit 0
