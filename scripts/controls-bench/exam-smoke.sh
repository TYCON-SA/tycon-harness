#!/usr/bin/env bash
# =============================================================================
# exam-smoke.sh — ejercita el examen periódico de revisores CORRIENDO SUS BINARIOS.
#
# ── Por qué existe, además de la suite de tests ──────────────────────────────────────────────
# La suite (`scripts/tests/periodic-exam.test.js`) prueba el código. Esto prueba la PIEZA: se
# invoca `periodic-exam.js` y `bench-notice.js` como los invoca el sistema —línea de comandos,
# entorno real, repo git real— y se mira lo que sale por pantalla y lo que queda en disco. Es la
# diferencia entre "los tests pasan" y "la cosa anda", que es exactamente lo que el gate de
# Definition of Done del arnés existe para distinguir (y por eso rechaza un corredor de tests como
# evidencia de ejecución).
#
# Cada caso arma su propio banco de trabajo descartable —repo git propio, HOME propio, examen
# FALSO inyectado— así que no toca nada de la máquina ni gasta una sola consulta al modelo. La
# corrida REAL del examen (~12 min el chequeo de vida; ~5h30 el examen profundo, a pedido) es
# prueba del mini, no de esto.
#
# Uso:  exam-smoke.sh <numero-de-criterio>      # 1..25
#       exam-smoke.sh all
# Exit: 0 si el criterio quedó demostrado · 1 si no · 2 si el caso no existe.
# =============================================================================
set -u

TCG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# El subcomando con el nombre viejo sigue andando: scripts/lib/renames.json
if [ -f "$TCG/scripts/lib/legacy-names.sh" ]; then
  LEGACY_NAMES_WHERE=scripts/controls-bench/exam-smoke.sh
  . "$TCG/scripts/lib/legacy-names.sh"
  legacy_args "$@" || exit 2
  set -- ${LEGACY_ARGS[@]+"${LEGACY_ARGS[@]}"}
fi
EXAMEN="$TCG/scripts/controls-bench/periodic-exam.js"
AVISO="$TCG/scripts/hooks/bench-notice.js"

fail() { echo "  ✗ $1" >&2; exit 1; }
ok()   { echo "  ✓ $1"; }

# ── Banco de trabajo descartable ───────────────────────────────────────────────────────────────
# `modo` (SMOKE_MODE) decide cómo se porta el examen FALSO: green (verde) · dies (muere) · lies (sale 0 sin
# dejar reporte) · skipped (todo salteado por un MCP ausente) · empty (reporte sin un solo caso).
armar() {
  W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
  export GIT_CONFIG_GLOBAL="$W/gitconfig"; : > "$GIT_CONFIG_GLOBAL"
  export GIT_CONFIG_NOSYSTEM=1
  mkdir -p "$W/casa/.claude/.tycon-pipeline" "$W/repo/scripts/controls-bench/.bench" "$W/agentes"
  ( cd "$W/repo"
    git init -q -b main .
    git config user.email b@b; git config user.name banco
    printf 'scripts/controls-bench/.bench/\n' > .gitignore
    echo repo > README.md
    git add -A && git commit -q -m base
    git init -q --bare "$W/remoto.git" && git remote add origin "$W/remoto.git" && git push -q -u origin main )

  cat > "$W/cfg.json" <<JSON
{"designated_machine":"Devas-Mac-mini","days_between_runs":3,"scheduled_days":["tuesday","friday"],"hour":"02:00"}
JSON
  cat > "$W/runner-falso.js" <<'JS'
const fs = require('fs');
fs.writeFileSync(process.env.W + '/invocado.json', JSON.stringify(process.argv.slice(2)));
const modo = process.env.SMOKE_MODE || 'green';
if (modo === 'dies') process.exit(1);
if (modo === 'lies') process.exit(0);
const i = process.argv.indexOf('--json');
const casos = { 'a|claude': {}, 'b|claude': {}, 'c|claude': {} };
const vacio = modo === 'empty';
const salteado = modo === 'skipped';
// El runner falso escribe lo que el real escribe HOY según cómo lo llamen: con `--liveness` es una
// corrida por caso sobre una herramienta, y lo que no puede medir va en null + motivo. El criterio
// NO se copia acá: se usa el módulo real, así el smoke ejercita la misma decisión que producción.
const { rubrosNoMedidos } = require(process.env.TCG + '/scripts/controls-bench/unmeasured-categories.js');
const vida = process.argv.includes('--liveness');
const ti = process.argv.indexOf('--tool'), ri = process.argv.indexOf('--runs');
const tool = ti >= 0 ? process.argv[ti + 1] : 'claude';
const runs = ri >= 0 ? Number(process.argv[ri + 1]) : (vida ? 1 : 3);
const nm = rubrosNoMedidos({ tool, runs });
const midioInest = nm.inestables === null, midioPar = nm.paridad === null;
const cuerpo = {
  ts: new Date().toISOString(), tool, runs,
  failed: 2, criterio: (salteado ? 0 : 1),
  inestables: midioInest ? (salteado ? 0 : 1) : null,
  erroresDeCorrida: 0, skippedMcp: (salteado ? 6 : 0),
  parityBreaks: midioPar ? 1 : null, paridadReal: midioPar ? (salteado ? 0 : 1) : null,
  paridadPorInestabilidad: midioPar ? 0 : null,
  ...(midioInest && midioPar ? {} : { no_medido: {
    ...(midioInest ? {} : { inestables: nm.inestables }),
    ...(midioPar ? {} : { paridad: nm.paridad }) } }),
  baselineRegressions: 0, alcance: 'completo', results: (vacio ? {} : casos),
};
if (i >= 0) fs.writeFileSync(process.argv[i + 1], JSON.stringify(cuerpo));
JS
  printf '#!/bin/sh\nexit 0\n' > "$W/sonda-ok.sh"
  printf '#!/bin/sh\necho "Invalid API key · Please run /login" >&2\nexit 1\n' > "$W/sonda-vencida.sh"
  chmod +x "$W/sonda-ok.sh" "$W/sonda-vencida.sh"
  export W TCG
  REPORTE="$W/repo/scripts/controls-bench/ultimo-examen.json"
  SELLO="$W/casa/.claude/.tycon-pipeline/periodic-exam-last-run"
  INTENTO="$W/repo/scripts/controls-bench/.bench/examen-intento.json"
}

# Corre el binario del examen tal como lo corre el sistema. La HOME del banco se declara la del usuario
# (TYCON_EXAM_REAL_HOME): sin eso --install-task no toca launchd desde una HOME que no es
# la real, y los criterios 3, 14/18 y 15 existen para ver el disparador que instala (con un launchctl de mentira).
correr() {
  HOME="$W/casa" TYCON_EXAM_REAL_HOME="$W/casa" TYCON_EXAM_CONFIG="$W/cfg.json" TYCON_EXAM_RUNNER="$W/runner-falso.js" \
  TYCON_EXAM_REPO="$W/repo" TYCON_EXAM_MACHINE="${MAQUINA:-Devas-Mac-mini}" \
  TYCON_EXAM_PROBE="${SONDA:-$W/sonda-ok.sh}" TYCON_EXAM_LAUNCHAGENTS="$W/agentes" \
  LAUNCHCTL_BIN=/usr/bin/true SMOKE_MODE="${SMOKE_MODE:-green}" \
  node "$EXAMEN" "$@"
}

# Corre el aviso del arranque de sesión tal como lo corre la herramienta, con la config del banco (con máquina
# designada): el aviso calla el examen si la config no designa máquina.
avisar() {
  echo '{"source":"startup"}' | HOME="$W/casa" TYCON_EXAM_CONFIG="$W/cfg.json" \
    TYCON_BENCH_DIR="$W/repo/scripts/controls-bench/.bench" TYCON_EXAM_REPORT="$REPORTE" \
    TYCON_EVAL_SANDBOX= node "$AVISO"
}

reporte_de() { # reporte_de <dias-atras> <criterio>
  mkdir -p "$(dirname "$REPORTE")"
  node -e "
    const fs=require('fs');
    const ts=new Date(Date.now()-$1*864e5).toISOString();
    fs.writeFileSync('$REPORTE', JSON.stringify({kind:'examen-periodico',estado:'completo',alcance:'completo',
      ts, criterio:$2, inestables:0, paridadReal:0, baselineRegressions:0, maquina:'devas-mac-mini'}));
    console.log(ts.slice(0,10));"
}

# ── Los casos, uno por criterio de aceptación ──────────────────────────────────────────────────
caso() {
case "$1" in

1|2) armar
  correr --force >"$W/out" 2>&1 || fail "el examen no corrió: $(cat "$W/out")"
  # AC 1: el nocturno es el CHEQUEO DE VIDA, sin acotar y sin las dos
  # herramientas — el examen profundo (`--tool both --runs 3`) es a pedido.
  grep -q '"--liveness"' "$W/invocado.json" || fail "no pidió el chequeo de vida"
  grep -q '"--only"' "$W/invocado.json" && fail "corrió acotado, y tiene que ser completo"
  grep -q '"both"' "$W/invocado.json" && fail "pidió las dos herramientas: eso es el examen profundo, y es a pedido"
  # AC 2: lo que SÍ midió, con número; lo que NO pudo medir con una
  # corrida y una herramienta, en null con su motivo — nunca 0. Y el aviso lo dice.
  node -e "const r=require('$REPORTE');
    if (typeof r.criterio!=='number') { console.error('falta criterio'); process.exit(1); }
    for (const k of ['inestables','paridadReal','parityBreaks'])
      if (r[k]!==null) { console.error(k+' tendría que ser null (no medido) y es '+r[k]); process.exit(1); }
    if (!r.no_medido||!r.no_medido.inestables||!r.no_medido.paridad) { console.error('falta el motivo en no_medido'); process.exit(1); }
    if (r.estado!=='completo'||r.alcance!=='completo') process.exit(1);" || fail "el reporte no distingue lo medido de lo no medido"
  avisar >"$W/aviso" 2>&1
  grep -q 'NO MEDID' "$W/aviso" || fail "el aviso no dice que hay rubros sin medir: $(cat "$W/aviso")"
  grep -qE '0 inestables|paridad rota 0' "$W/aviso" && fail "el aviso pinta de cero lo que no se midió"
  grep -q -- '--runs 2' "$W/aviso" && grep -q -- '--tool both' "$W/aviso" || fail "el aviso no dice cómo se mediría"
  ok "corrió el chequeo de vida completo; lo medido con número, lo no medido dicho, y el aviso lo muestra así" ;;

3) armar
  correr --install-task >/dev/null 2>&1 || fail "no instaló"
  P="$W/agentes/ar.com.tycon.examen-periodico.plist"
  grep -q '<key>Weekday</key><integer>2</integer>' "$P" || fail "falta el martes"
  grep -q '<key>Weekday</key><integer>5</integer>' "$P" || fail "falta el viernes"
  node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('$W/cfg.json'));c.scheduled_days=['monday'];c.hour='23:30';fs.writeFileSync('$W/cfg.json',JSON.stringify(c))"
  correr --install-task >/dev/null 2>&1 || fail "no reinstaló"
  grep -q '<key>Weekday</key><integer>1</integer>' "$P" || fail "no tomó el día nuevo de la config"
  grep -q '<key>Hour</key><integer>23</integer>' "$P" || fail "no tomó la hora nueva"
  ok "la frecuencia se cambia sólo en la config y el disparador se regenera" ;;

4) armar
  # Un candado de un proceso VIVO (este mismo shell) frena la segunda corrida.
  # 🔴 Sin `&` ni procesos de fondo: una escritura en segundo plano puede pisar el candado DESPUÉS
  # y dejar el caso verde o rojo según quién gane. Un smoke que depende de una carrera no prueba nada.
  node -e "require('fs').writeFileSync('$W/repo/scripts/controls-bench/.bench/examen.lock',
    JSON.stringify({pid:$$,ts:new Date().toISOString(),maquina:'x'}))"
  correr --force >"$W/out" 2>&1
  grep -q 'otra-corrida-en-curso' "$W/out" || fail "arrancó con el candado tomado: $(cat "$W/out")"
  [ ! -f "$W/invocado.json" ] || fail "invocó el examen caro igual"
  # Un candado de un proceso MUERTO no frena.
  node -e "require('fs').writeFileSync('$W/repo/scripts/controls-bench/.bench/examen.lock',
    JSON.stringify({pid:2147483646,ts:new Date().toISOString(),maquina:'x'}))"
  correr --force >"$W/out" 2>&1 || fail "un candado huérfano frenó la corrida: $(cat "$W/out")"
  [ -f "$W/invocado.json" ] || fail "no corrió el examen"
  ok "el candado frena una segunda corrida viva, y uno huérfano no frena nada" ;;

5) armar
  F="$(reporte_de 9 7)"
  avisar > "$W/out" 2>&1
  grep -qi 'NO ESTÁ CORRIENDO' "$W/out" || fail "no denunció: $(cat "$W/out")"
  grep -q "$F" "$W/out" || fail "no dijo desde cuándo"
  grep -q '7 de criterio' "$W/out" && fail "mostró los números viejos"
  ok "a los 9 días denuncia el examen detenido y calla los números viejos" ;;

6) armar
  F="$(reporte_de 2 0)"
  SMOKE_MODE=lies correr --force >"$W/out" 2>&1 && fail "salió 0 sin haber medido"
  grep -q "$F" "$REPORTE" || fail "pisó la última medición buena"
  node -e "const r=require('$INTENTO'); if(r.estado!=='incompleto'||!r.motivo) process.exit(1)" || fail "no quedó registrada como incompleta"
  avisar | grep -qi 'INCOMPLETO' || fail "el aviso no la trata como no medida"
  avisar | grep -q '✅' && fail "la mostró en verde"
  ok "una corrida incompleta queda registrada con su motivo y nunca se ve verde" ;;

7) armar
  SONDA="$W/sonda-vencida.sh" correr --force >"$W/out" 2>&1 && fail "salió 0 con la sesión vencida"
  grep -qiE 'sesion|sesión|login|autentic' "$W/out" || fail "no escribió el motivo: $(cat "$W/out")"
  [ ! -f "$W/invocado.json" ] || fail "gastó el examen caro igual"
  [ ! -f "$REPORTE" ] || fail "dejó un reporte que parece bueno"
  ok "con la sesión vencida falla rápido, con motivo, y sin dejar reporte" ;;

8) armar
  F="$(reporte_de 1 2)"
  avisar > "$W/out" 2>&1
  grep -q "$F" "$W/out" || fail "no muestra la fecha"
  grep -q '2 de criterio' "$W/out" || fail "no muestra los números"
  grep -qi 'no está corriendo' "$W/out" && fail "denunció un reporte fresco"
  ok "un reporte fresco se muestra con sus números y su fecha" ;;

9) armar
  echo "del dev" > "$W/repo/del-dev.txt"
  ( cd "$W/repo" && git add -- del-dev.txt )
  echo "sucio" >> "$W/repo/README.md"
  correr --force >"$W/out" 2>&1 || fail "no corrió: $(cat "$W/out")"
  T="$(cd "$W/repo" && git show --name-only --format= HEAD | tr -d ' \n')"
  [ "$T" = "scripts/controls-bench/ultimo-examen.json" ] || fail "el commit tocó: $T"
  ( cd "$W/repo" && git status --porcelain | grep -q 'del-dev.txt' ) || fail "se llevó el trabajo del dev"
  ok "sólo el reporte entra al commit; lo del dev queda intacto" ;;

10) armar
  printf '#!/bin/sh\nexit 1\n' > "$W/remoto.git/hooks/pre-receive"; chmod +x "$W/remoto.git/hooks/pre-receive"
  correr --force >"$W/out" 2>&1 && fail "salió 0 con el push rechazado"
  grep -qi 'push' "$W/out" || fail "no lo dice en el log: $(cat "$W/out")"
  grep -qE '3|reintent' "$W/out" || fail "no reintentó"
  [ -f "$REPORTE" ] || fail "borró el resultado"
  node -e "const r=require('$INTENTO'); if(r.estado!=='no-viajo') process.exit(1)" || fail "no quedó constancia de que no viajó"
  ok "con el push rechazado el resultado sobrevive, se reintenta y queda dicho" ;;

11) armar
  R="$(node -e "console.log(require('$EXAMEN').RUTA_REPORTE_QUE_VIAJA)")"
  case "$R" in *.bench*) fail "el reporte que viaja vive en una carpeta ignorada";; esac
  ( cd "$W/repo" && git check-ignore -q "$R" ) && fail "git lo ignora"
  ok "el reporte que viaja no cae bajo ninguna regla de .gitignore" ;;

12|13) armar
  N="$(node -e "console.log(require('$TCG/scripts/controls-bench/report-name.js').nombreDeReporte({tool:'both',only:[]}).nombre)")"
  [ "$N" = "advisors-both.json" ] || fail "cambió el nombre histórico del reporte completo: $N"
  A="$(node -e "const n=require('$TCG/scripts/controls-bench/report-name.js').nombreDeReporte({tool:'claude',only:['tycon-story-validator']});console.log(n.nombre+' '+n.alcance)")"
  case "$A" in advisors-claude.json*) fail "la corrida acotada pisa la completa";; esac
  case "$A" in *acotado) : ;; *) fail "no se marca como acotada: $A";; esac
  for f in --tool --only --runs --jobs --baseline --json; do
    grep -q -- "'$f'" "$TCG/scripts/controls-bench/advisor-runner.js" || fail "el examen perdió el flag $f"
  done
  ok "el nombre sale del alcance sin pasar ningún flag, y el examen conserva su contrato" ;;

14|18) armar
  MAQUINA=una-notebook correr >"$W/out" 2>&1 || fail "salió ≠ 0 en una máquina que no es la designada"
  grep -q 'no-designada' "$W/out" || fail "no dijo por qué: $(cat "$W/out")"
  [ ! -f "$W/invocado.json" ] || fail "corrió el examen igual"
  MAQUINA=una-notebook correr --install-task >/dev/null 2>&1
  [ ! -f "$W/agentes/ar.com.tycon.examen-periodico.plist" ] || fail "le dejó una tarea programada"
  MAQUINA=Devas-Mac-mini correr --install-task >/dev/null 2>&1
  [ -f "$W/agentes/ar.com.tycon.examen-periodico.plist" ] || fail "no instaló la tarea en la designada"
  ok "sólo la máquina designada corre y tiene disparador; las demás, nada" ;;

15) armar
  for k in ANTHROPIC_API_KEY OPENAI_API_KEY AZURE_DEVOPS_PAT GITHUB_PAT; do
    grep -q "$k" "$EXAMEN" && fail "el examen depende de $k"
  done
  correr --install-task >/dev/null 2>&1
  grep -qiE 'API_KEY|SECRET|TOKEN' "$W/agentes/ar.com.tycon.examen-periodico.plist" && fail "la tarea lleva credenciales"
  ok "ni el corredor ni la tarea programada leen o llevan credenciales" ;;

16|19|20|21) armar
  I="$TCG/scripts/install-tycon-hooks.sh"
  grep -q 'controls-bench-advisors-last-run' "$I" && fail "el lanzador viejo sigue en el instalador"
  grep -q 'periodic-exam.js' "$I" || fail "el instalador no invoca la pieza extraída"
  # AC 20: live-fire bajo Codex se lanza; el banco determinista no — corre en Azure DevOps
  # (pipelines/azure-pipelines-banco.yml). Se verifica que la invocación EXISTA, no cómo está escrita:
  # buscar una línea textual se rompería con otras comillas aunque el comportamiento siguiera.
  grep -vE '^[[:space:]]*#' "$I" | grep -qE "live-fire\.js['\"[:space:]]+--tool codex" || fail "se llevó puesta la corrida de live-fire (una línea comentada no cuenta)"
  grep -vE '^[[:space:]]*#' "$I" | grep nohup | grep -qE 'BENCH_RUNNER|BENCH_JOB|run-controls-bench-job|runner\.js' \
    && fail "el instalador sigue lanzando el banco determinista: corre en Azure y su reporte viaja por git"
  B="$(awk '/^EXAMEN_PERIODICO=/,/^fi$/' "$I")"
  echo "$B" | grep -qE 'LAST_CB|TODAY_CB' && fail "el examen quedó colgado del sello diario ajeno"
  echo "$B" | grep -q 'TYCON_CODEX' && fail "el examen quedó colgado de la llave de Codex"
  echo "$B" | grep -q 'nohup' && fail "el instalador es un segundo disparador"
  ok "una sola implementación, un solo disparador, y las otras corridas intactas" ;;

17) armar
  SMOKE_MODE=dies correr --force >/dev/null 2>&1 && fail "salió 0 sin haber terminado"
  [ ! -f "$SELLO" ] || fail "selló el período con una corrida que murió"
  SMOKE_MODE=skipped correr --force >"$W/out" 2>&1 && fail "salió 0 con todo salteado"
  [ ! -f "$SELLO" ] || fail "selló con cero revisores evaluados"
  correr --force >/dev/null 2>&1 || fail "no corrió la buena"
  [ -f "$SELLO" ] || fail "una corrida COMPLETA no selló"
  ok "sólo una corrida completa marca el período como hecho" ;;

22) armar
  reporte_de 1 3 >/dev/null
  rm -rf "$W/repo/scripts/controls-bench/.bench"; mkdir -p "$W/repo/scripts/controls-bench/.bench"
  avisar | grep -q '3 de criterio' || fail "el aviso no encuentra el reporte fuera de .bench/"
  ok "el aviso lee el reporte que viaja, no sólo la carpeta local" ;;

23) armar
  node -e "require('fs').writeFileSync('$W/repo/scripts/controls-bench/.bench/last-run-claude.json',
    JSON.stringify({ts:new Date().toISOString(),failed:0,parityBreaks:0,baselineRegressions:0}))"
  avisar | grep -qi 'NO ESTÁ CORRIENDO' || fail "con todo en verde y sin examen, se calló"
  ok "habla aunque no haya una sola falla" ;;

24) armar
  node -e "const E=require('$EXAMEN'); if(E.VEJEZ_MS!==8*864e5) process.exit(1)" || fail "el umbral no son 8 días"
  grep -qE '8\s*\*\s*24\s*\*\s*60' "$AVISO" && fail "el aviso redefine el umbral en vez de importarlo"
  grep -q 'STALE_MS' "$AVISO" || fail "se llevó puesto el umbral de paridad"
  [ "$(grep -cE '8\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000' "$EXAMEN")" = "1" ] || fail "el umbral está definido más de una vez"
  ok "un solo umbral de 8 días, y el de paridad intacto" ;;

25) armar
  correr --force >/dev/null 2>&1 || fail "no corrió"
  [ -f "$SELLO" ] || fail "no selló"
  correr >"$W/out" 2>&1 || fail "salió ≠ 0"
  grep -q 'periodo-no-cumplido' "$W/out" || fail "volvió a correr el mismo día"
  node -e "require('fs').writeFileSync('$SELLO', new Date(Date.now()-3*864e5).toISOString())"
  rm -f "$W/invocado.json"
  correr >/dev/null 2>&1 || fail "no corrió a los 3 días"
  [ -f "$W/invocado.json" ] || fail "la segunda corrida de la semana no arrancó"
  ok "el sello es por corrida: a los 3 días vuelve a tocarle" ;;

*) echo "exam-smoke.sh: no hay caso para '$1'" >&2; exit 2 ;;
esac
}

if [ "${1:-}" = "all" ]; then
  R=0
  for n in 1 3 4 5 6 7 8 9 10 11 12 14 15 16 17 22 23 24 25; do
    echo "— criterio $n"; ( caso "$n" ) || R=1
  done
  exit $R
fi
echo "— criterio ${1:?falta el número de criterio}"
caso "$1"
