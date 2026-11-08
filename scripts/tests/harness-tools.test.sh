#!/usr/bin/env bash
# harness-tools.test.sh — cada herramienta, sus enchufes (T21, T22, T23 y T26).
#
# Lo que no se puede perder:
#   T21 · `install` DETECTA Claude Code y Codex (el ejecutable, o la configuración propia de la herramienta), nombra en
#         el plan cuáles va a enchufar y pide la conformidad de siempre; `--tool claude|codex` (repetible) lo fija sin
#         mirar qué hay; sin ninguna detectada ni pedida sale 1 «no encontré Claude Code ni Codex» SIN escribir nada y
#         sin salir a la red.
#   T22 · una máquina SÓLO con Codex: después de `install` no hay nada nuevo en `~/.claude`; `~/.codex/AGENTS.md` trae
#         los bloques del arnés entre sus marcas, con lo de la persona intacto y sin `@import`; las skills llegan por
#         `~/.codex/skills`; y el arranque de Codex (su hook) actualiza el arnés. Con Claude Code también presente,
#         `AGENTS.md` se arma igual: desde los bloques, no copiando el `CLAUDE.md`.
#   T23 · el MCP de Codex: sin `~/.claude.json` se registran los servidores del arnés; con uno que trae un servidor
#         propio, se suma; un servidor esperado que no se puede registrar SE DICE; `writable_roots` lleva `~/.tycon/state`.
#   T26 · una herramienta que se instala después: `install --tool codex` la enchufa sin tocar la otra ni bajar otra
#         versión; `uninstall --tool claude` desenchufa sólo esa.
#
# Laboratorio: scripts/tests/lib/harness-lab.sh (la máquina sin arnés, el servidor de versiones de juguete y las
# herramientas de mentira de `harness_lab_tools`). Nunca ~/.claude, ~/.codex ni ~/.tycon de verdad.
# 🔴 Sin pipes sobre el comando medido.
#
# Uso: bash scripts/tests/harness-tools.test.sh [--only T21|T22|T23|T26|T26b|T13]
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/scripts/tests/lib/harness-lab.sh"
export TYCON_UPDATE_APPLY=auto
ONLY=""; [ "${1:-}" = "--only" ] && ONLY="${2:-}"
runs() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
FAILURES=0
ok()  { echo "  ok   — $1"; }
bad() { echo "  MAL  — $1"; FAILURES=$((FAILURES+1)); }
BASE="$(mktemp -d)"
VIEJO="$(node -p "require('${ROOT}/scripts/setup/harness/place.js').LEGACY_PLACE_NAME")"
case "$BASE" in *"${VIEJO}"*|*agent-skills*|*/.claude*|*/.codex*|*/.tycon*) echo "❌ harness-tools: el laboratorio cayó en ${BASE}"; exit 1 ;; esac
trap 'rm -rf "$BASE"; kill $(jobs -p) 2>/dev/null' EXIT
j() { python3 -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print($2)" "$1" 2>/dev/null; }
# el estado de la máquina, esté donde esté (una máquina sin Claude Code lo tiene en ~/.tycon/state)
STATE_FILE() {
  if [ -f "$LAB_HOME/.tycon/state/harness-state.json" ]; then printf '%s' "$LAB_HOME/.tycon/state/harness-state.json"
  else printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"; fi
}
state() { j "$(STATE_FILE)" "$1"; }
requests() { local n; n="$(grep -c -- "$1" "$LAB_RELEASE_LOG" 2>/dev/null)"; printf '%s' "${n:-0}"; }
tools_line() { printf '%s\n' "$1" | grep -- 'herramientas a enchufar' || true; }

# ───────────── los registros de los hooks, en la casa propia ─────────────
# Una HOME de laboratorio por caso: `own` la deja viviendo en la casa propia (existe ~/.tycon/state, la regla de
# tycon-home.js), `old` es una máquina que no se mudó. Los hooks corren desde ESTE árbol, con HOME del laboratorio.
lab_home() { # lab_home <nombre> <own|old>
  local h="$BASE/$1"; mkdir -p "$h/repo"; printf '{"scripts":{"test":"vitest"}}' > "$h/repo/package.json"
  [ "$2" = own ] && mkdir -p "$h/.tycon/state"
  printf '%s' "$h"
}
in_home() { local h="$1"; shift; env -u TYCON_HOME -u TYCON_INSTINCT_OBS_DIR -u CLAUDE_CONFIG_DIR HOME="$h" USERPROFILE="$h" "$@"; }
claude_listing() { [ -e "$1/.claude" ] || return 0; ( cd "$1" && find .claude | LC_ALL=C sort ); }
# una conversación mínima: los medidores sólo crean su carpeta con una que exista
lab_transcript() {
  printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hola"}]},"timestamp":"2026-11-08T10:00:00.000Z"}' \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"listo"}]},"timestamp":"2026-11-08T10:00:01.000Z"}' > "$1"
}
# los hooks que escriben registros sueltos, uno por uno, con la HOME dada
run_writers() { # run_writers <home>
  local h="$1" t="$1/transcript.jsonl"
  lab_transcript "$t"
  printf '{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"},"cwd":"%s"}' "$h" \
    | in_home "$h" TYCON_SAFETY_GUARD=1 bash "$ROOT/scripts/hooks/safety-guard-pre.sh" >/dev/null 2>&1; GUARD_RC=$?
  printf '{"tool_name":"Bash","tool_input":{"command":"TYCON_FULL_SUITE=1 npm test"},"cwd":"%s/repo"}' "$h" \
    | in_home "$h" TYCON_TEST_SCOPE_GUARD=1 bash "$ROOT/scripts/hooks/test-scope-guard-pre.sh" >/dev/null 2>&1
  printf '{"session_id":"abcdef123456","tool_name":"Bash","tool_input":{"command":"ls"},"tool_response":{},"cwd":"%s"}' "$h" \
    | in_home "$h" TYCON_PROFILE=0 TYCON_INSTINCTS=1 node "$ROOT/integrations/instincts/scripts/instinct-observe.js" >/dev/null 2>&1
  for m in blocking-meter large-read-meter response-style-meter; do
    printf '{"transcript_path":"%s","session_id":"s-lab","cwd":"%s"}' "$t" "$h" | in_home "$h" node "$ROOT/scripts/hooks/$m.js" >/dev/null 2>&1
  done
  # el aviso de retrospectivas sella su día sólo con una serie vieja: una foto de hace meses donde la máquina la escribe
  local dash; dash="$(in_home "$h" node -e 'const m = require(process.argv[1]).machineDashboard(process.argv[2]); process.stdout.write(m.dir || "")' "$ROOT/scripts/lib/night-data.js" "$ROOT" 2>/dev/null)"
  [ -n "$dash" ] && mkdir -p "$dash" && printf '{}' > "$dash/metrics-2026-01-01.json"
  in_home "$h" node "$ROOT/scripts/hooks/retro-staleness-notice.js" < /dev/null >/dev/null 2>&1
  rm -f "$t"
}
# lo que los escritores dejan, relativo a la carpeta de los registros sueltos y a la del estado
LOOSE_STORES="safety-guard.log tycon-observations blocking-meter lectura-grande response-style .tycon-retro-staleness-last-notice"

if runs T40; then
  echo "8.150 T40 · SafetyGuard_CasaPropia_NoEscribeEnClaude @story-8.150 @ac-2"
  H="$(lab_home t40 own)"
  printf '{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"},"cwd":"%s"}' "$H" \
    | in_home "$H" TYCON_SAFETY_GUARD=1 bash "$ROOT/scripts/hooks/safety-guard-pre.sh" >/dev/null 2>&1; RC=$?
  [ "$RC" = 2 ] && ok "el freno frena (sale 2)" || bad "el freno salió $RC"
  grep -q 'BLOCK rule=' "$H/.tycon/state/safety-guard.log" 2>/dev/null && ok "safety-guard.log en ~/.tycon/state" || bad "sin safety-guard.log en el estado: $(ls -A "$H/.tycon/state" 2>&1 | tr '\n' ' ')"
  [ -z "$(claude_listing "$H")" ] && ok "y nada en ~/.claude" || bad "apareció en ~/.claude: $(claude_listing "$H" | tr '\n' ' ')"
fi

if runs T41; then
  echo "8.150 T41 · HooksShell_CasaPropia_NoEscribenEnClaude @story-8.150 @ac-3"
  H="$(lab_home t41 own)"
  run_writers "$H"
  grep -q 'FULL_SUITE_RUN' "$H/.tycon/state/bypass.log" 2>/dev/null && ok "bypass.log (el guardián de pruebas) en el estado" || bad "sin bypass.log en el estado"
  ls "$H/.tycon/state/tycon-observations/"*.jsonl >/dev/null 2>&1 && ok "la grabadora de instintos graba en el estado" || bad "sin tycon-observations en el estado: $(ls -A "$H/.tycon/state" | tr '\n' ' ')"
  for d in blocking-meter lectura-grande response-style; do
    [ -d "$H/.tycon/state/$d" ] && ok "el medidor $d escribe en el estado" || bad "el medidor $d no escribió en el estado"
  done
  [ -f "$H/.tycon/state/.tycon-retro-staleness-last-notice" ] && ok "el aviso de retrospectivas sella en el estado" || bad "sin el sello del aviso de retrospectivas en el estado"
  # el observador lee lo que la grabadora acaba de dejar en el estado (lo que lee, de dónde lo lee)
  N_OBS="$(in_home "$H" node -e 'process.stdout.write(String(require(process.argv[1]).loadObservations().length))' "$ROOT/scripts/instincts/instinct-observer.js" 2>/dev/null)"
  [ "${N_OBS:-0}" -ge 1 ] 2>/dev/null && ok "el observador lee las observaciones del estado (${N_OBS})" || bad "el observador no leyó las observaciones del estado: «${N_OBS}»"
  [ -z "$(claude_listing "$H")" ] && ok "y nada en ~/.claude" || bad "apareció en ~/.claude: $(claude_listing "$H" | tr '\n' ' ')"
fi

if runs T42; then
  echo "8.150 T42 · Lectores_LeenDeLaCasa @story-8.150 @ac-4"
  H="$(lab_home t42 own)"; S="$H/.tycon/state"
  # los tres avisos leen su pendiente en el estado (y lo consumen)
  mkdir -p "$S/blocking-meter/pending" "$S/response-style/pending" "$S/lectura-grande/pending"
  printf '{"worstMs":300000,"worstTool":"Bash","maxMs":120000,"userMsgs":0}' > "$S/blocking-meter/pending/s-lab.json"
  printf '{"reasons":["laboratorio"],"maxHeaders":1}' > "$S/response-style/pending/s-lab.json"
  printf '{"peor":{"canal":"read","chars":90000,"archivo":"a.js"},"umbral":40000,"acotadas":0}' > "$S/lectura-grande/pending/s-lab.json"
  OUT="$(printf '{"session_id":"s-lab"}' | in_home "$H" node "$ROOT/scripts/hooks/blocking-notice.js" 2>/dev/null)"
  case "$OUT" in *"segundo plano"*) ok "el aviso de bloqueo lee su pendiente del estado" ;; *) bad "el aviso de bloqueo no lo leyó: «${OUT}»" ;; esac
  OUT="$(printf '{"session_id":"s-lab"}' | in_home "$H" node "$ROOT/scripts/hooks/response-style-notice.js" 2>/dev/null)"
  case "$OUT" in *"estilo de respuesta"*) ok "el aviso de estilo lee su pendiente del estado" ;; *) bad "el aviso de estilo no lo leyó: «${OUT}»" ;; esac
  OUT="$(printf '{"session_id":"s-lab"}' | in_home "$H" node "$ROOT/scripts/hooks/large-read-notice.js" 2>/dev/null)"
  case "$OUT" in *"lecturas por rango"*) ok "el aviso de lecturas lee su pendiente del estado" ;; *) bad "el aviso de lecturas no lo leyó: «${OUT}»" ;; esac
  # el tablero: el registro del freno y los dos medidores, en el anillo de la máquina
  printf '[2026-11-08 10:00:00] BLOCK rule=GIT-C2 cwd=/x\n' > "$S/safety-guard.log"
  printf '{"over":false}\n' > "$S/response-style/log.jsonl"; printf '{"over":false}\n' > "$S/blocking-meter/log.jsonl"
  OUT="$(in_home "$H" node -e 'const m = require(process.argv[1]).local(); process.stdout.write(JSON.stringify({ freno: m.freno, estilo: m.estilo, bloqueo: m.bloqueo }))' "$ROOT/scripts/nightly/dashboard/dashboard.js" 2>&1)"
  case "$OUT" in *"el registro del freno de mano"*|*"el medidor de estilo"*|*"el medidor de bloqueo"*) bad "el tablero no encontró los registros en el estado: $OUT" ;; *'"freno"'*) ok "el tablero lee el freno y los medidores del estado" ;; *) bad "el tablero no contestó: $OUT" ;; esac
  # la auditoría: observaciones frescas en el estado; con la variable, la de la variable
  mkdir -p "$H/.claude" "$S/tycon-observations"; printf '{"hooks":{"PostToolUse":[{"command":"instinct-observe.sh"}]}}' > "$H/.claude/settings.json"
  printf '{}\n' > "$S/tycon-observations/2026-11.jsonl"
  OUT="$(in_home "$H" TYCON_INSTINCT_MINING=1 node -e 'const c = require(process.argv[1]).checkLearningLoop().checks.find((x) => /observations con actividad/.test(x.name)); process.stdout.write(String(c && c.passed))' "$ROOT/scripts/lib/harness-audit.js" 2>&1)"
  [ "$OUT" = true ] && ok "la auditoría encuentra las observaciones en el estado" || bad "la auditoría no las encontró: $OUT"
  OTRA="$H/obs-de-la-variable"; mkdir -p "$OTRA"; printf '{}\n' > "$OTRA/2026-11.jsonl"; rm -rf "$S/tycon-observations"
  OUT="$(in_home "$H" TYCON_INSTINCT_MINING=1 TYCON_INSTINCT_OBS_DIR="$OTRA" node -e 'const c = require(process.argv[1]).checkLearningLoop().checks.find((x) => /observations con actividad/.test(x.name)); process.stdout.write(String(c && c.passed) + " " + (c && c.file))' "$ROOT/scripts/lib/harness-audit.js" 2>&1)"
  [ "$OUT" = "true $OTRA" ] && ok "con TYCON_INSTINCT_OBS_DIR la auditoría lee ésa" || bad "con la variable la auditoría dio: $OUT"
  # los que no se pueden correr en una prueba (la subida al buzón, la prueba de fuego con sesiones reales, el registro
  # de fallos del aviso de instintos) se miden por su fuente: piden la carpeta a loose-logs.js y no nombran la ruta vieja
  for f in scripts/metrics/upload-runs.js scripts/controls-bench/live-fire-guard.js integrations/instincts/scripts/instincts-notice.js; do
    if grep -q 'loose-logs' "$ROOT/$f" && ! grep -qE "'\.claude', '(tycon-observations|safety-guard\.log)'|\.claude/(tycon-observations|safety-guard\.log)" "$ROOT/$f"; then ok "$f pide la carpeta a loose-logs.js"; else bad "$f sigue con la ruta fija"; fi
  done
fi

if runs T43; then
  echo "8.150 T43 · SinMudar_MismoLugar @story-8.150 @ac-5"
  H="$(lab_home t43 old)"
  run_writers "$H"
  [ "$GUARD_RC" = 2 ] && ok "el freno frena igual" || bad "el freno salió $GUARD_RC"
  for n in $LOOSE_STORES; do
    [ -e "$H/.claude/$n" ] && ok "$n donde estuvo siempre (~/.claude)" || bad "$n no está en ~/.claude: $(claude_listing "$H" | tr '\n' ' ')"
  done
  grep -q 'FULL_SUITE_RUN' "$H/.claude/.tycon-pipeline/bypass.log" 2>/dev/null && ok "bypass.log en ~/.claude/.tycon-pipeline" || bad "sin bypass.log donde siempre"
  [ ! -e "$H/.tycon" ] && ok "y nada en ~/.tycon" || bad "apareció ~/.tycon: $(ls -A "$H/.tycon" | tr '\n' ' ')"
fi

if runs T50; then
  echo "8.150 T50 · Uninstall_CasaPropia_EncuentraLosRegistros @story-8.150 @ac-13"
  H="$(lab_home t50 own)"; S="$H/.tycon/state"
  for n in $LOOSE_STORES; do case "$n" in *.log|.tycon-*) printf 'x\n' > "$S/$n" ;; *) mkdir -p "$S/$n" ;; esac; done
  OUT="$(in_home "$H" node -e '
    const U = require(process.argv[1]);
    const p = U.plan({ home: process.argv[2], env: {} }, { tree: process.argv[2] + "/sin-arbol", managed: [], sources: [] });
    process.stdout.write(U.describePlan(p).join("\n"));' "$ROOT/scripts/setup/harness/uninstall.js" "$H" 2>&1)"
  for n in $LOOSE_STORES; do
    case "$OUT" in *"$S/$n"*) ok "el plan nombra $n en la carpeta del estado" ;; *) bad "el plan no nombra $S/$n: $OUT" ;; esac
  done
  case "$OUT" in *"se va con la carpeta del estado"*) ok "y dice que se va con la carpeta del estado" ;; *) bad "el plan no dice qué pasa con ellos: $OUT" ;; esac
  [ -z "$(claude_listing "$H")" ] && ok "el plan no escribió en ~/.claude" || bad "apareció ~/.claude"
fi

# ───────────── sumar y sacar Claude Code en la casa propia ─────────────
if runs T44; then
  echo "8.150 T44 · SumarClaude_CasaPropia_Instala @story-8.150 @ac-6"
  harness_lab_create "$BASE/lab44"
  harness_lab_release_server
  harness_lab_codex_pieces
  harness_lab_publish_stable 2026.10.07.1
  harness_lab_tools codex; harness_lab_tools_fresh_home
  OUT="$(harness install --version latest --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ -f "$LAB_HOME/.tycon/state/harness-state.json" ] && ok "la máquina nace sólo con Codex, en ~/.tycon" || bad "la instalación sólo con Codex salió $RC: $OUT"
  harness_lab_tools both
  OUT="$(harness_release install --tool claude --yes 2>&1)"; RC=$?
  if [ "$(uname -s)" = Darwin ] || [ "$(uname -s)" = Linux ]; then
    [ "$RC" = 0 ] && ok "install --tool claude sale 0 en una máquina que vive en ~/.tycon" || bad "install --tool claude salió $RC: $OUT"
    [ "$(state "','.join(d['tools'])")" = "claude,codex" ] && ok "el estado dice tools: claude, codex" || bad "tools: $(state "d.get('tools')")"
    [ -L "$LAB_HOME/.claude/.tycon-pipeline" ] && [ "$(cd "$LAB_HOME/.claude/.tycon-pipeline" && pwd -P)" = "$(cd "$LAB_HOME/.tycon/state" && pwd -P)" ] \
      && ok "~/.claude/.tycon-pipeline es un enlace a ~/.tycon/state (el mismo que deja la mudanza)" || bad "~/.claude/.tycon-pipeline no es el enlace: $(ls -la "$LAB_HOME/.claude" 2>&1 | grep tycon-pipeline)"
    grep -q '^run check=0' "$LAB_HOME/.tycon/state/lab-applier.log" 2>/dev/null && ok "el aplicador escribió su registro en ~/.tycon/state" || bad "sin el registro del aplicador en el estado: $(ls -A "$LAB_HOME/.tycon/state" | tr '\n' ' ')"
    [ -f "$LAB_HOME/.tycon/state/harness-state.json" ] && [ ! -e "$LAB_HOME/.tycon/state/.tycon-pipeline" ] && ok "el estado sigue en ~/.tycon/state" || bad "el estado se movió"
    # hallazgos del pase adversarial: sacar Claude Code se lleva ese enlace; uno colgado o a otra casa se dice y no se toca
    OUT="$(harness_release uninstall --tool claude --yes 2>&1)"; RC=$?
    [ "$RC" = 0 ] && [ ! -e "$LAB_HOME/.claude/.tycon-pipeline" ] && [ ! -L "$LAB_HOME/.claude/.tycon-pipeline" ] && ok "uninstall --tool claude se lleva el enlace del estado" || bad "uninstall --tool claude salió $RC y el enlace: $(ls -la "$LAB_HOME/.claude" 2>&1 | grep tycon-pipeline)"
    [ -f "$LAB_HOME/.tycon/state/harness-state.json" ] && ok "y el estado propio queda (Codex sigue)" || bad "se fue el estado propio"
    mkdir -p "$LAB_HOME/.claude"; ln -s "$LAB_HOME/casa-vieja/state" "$LAB_HOME/.claude/.tycon-pipeline"
    OUT="$(harness_release install --tool claude --yes 2>&1)"; RC=$?
    case "$OUT" in *"no es un enlace a"*) [ "$(readlink "$LAB_HOME/.claude/.tycon-pipeline")" = "$LAB_HOME/casa-vieja/state" ] && ok "un enlace colgado a otra casa: lo dice y no lo toca" || bad "tocó el enlace colgado: $(readlink "$LAB_HOME/.claude/.tycon-pipeline")" ;;
      *) bad "un enlace colgado pasó sin aviso (rc $RC): $(printf '%s' "$OUT" | tail -3)" ;; esac
  else
    [ "$RC" = 2 ] && ok "en Windows sigue saliendo 2" || bad "en Windows salió $RC"
  fi
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

if runs T45; then
  echo "8.150 T45 · SacarClaude_DesdeClon_NombraLaMudanza @story-8.150 @ac-7 · T46 SacarClaude_Mudada_Saca @story-8.150 @ac-8"
  harness_lab_create "$BASE/lab45"
  harness_lab_release_server
  harness_lab_codex_pieces
  harness_lab_publish_stable 2026.10.08.1
  harness_lab_tools both; harness_lab_tools_fresh_home
  OUT="$(harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(state "','.join(d['tools'])")" = "claude,codex" ] && ok "instalada desde el clon con las dos" || bad "la instalación desde el clon salió $RC (tools $(state "d.get('tools')")): $OUT"
  before="$(harness_lab_home_hash)"
  OUT="$(harness uninstall --tool claude --yes 2>&1)"; RC=$?
  [ "$RC" = 2 ] && ok "sacar Claude Code desde un clon sale 2" || bad "salió $RC: $OUT"
  case "$OUT" in *"migrate --to-home"*) ok "el mensaje nombra harness.js migrate --to-home" ;; *) bad "el mensaje no nombra la mudanza: $OUT" ;; esac
  case "$OUT" in *"carpeta de Claude Code"*) ok "y dice que el clon vive en la carpeta de Claude Code" ;; *) bad "el mensaje no dice por qué: $OUT" ;; esac
  [ "$(harness_lab_home_hash)" = "$before" ] && ok "no tocó nada" || bad "escribió algo"
  if runs T45 || runs T46; then
    OUT="$(harness migrate --to-home 2>&1)"; RC=$?
    [ "$RC" = 0 ] && ok "la mudanza sale 0" || bad "la mudanza salió $RC: $(printf '%s' "$OUT" | tail -5)"
    OUT="$(harness_release uninstall --tool claude --yes 2>&1)"; RC=$?
    [ "$RC" = 0 ] && ok "T46: después de la mudanza, uninstall --tool claude sale 0" || bad "T46: uninstall --tool claude salió $RC: $OUT"
    [ "$(state "','.join(d['tools'])")" = codex ] && ok "T46: el estado dice tools: codex" || bad "T46: tools $(state "d.get('tools')")"
    grep -q 'harness-startup' "$CODEX_HOME/hooks.json" 2>/dev/null && [ -L "$CODEX_HOME/skills/tycon-pipeline" ] && ok "T46: Codex sigue enchufado (hooks y skills)" || bad "T46: Codex quedó sin enchufe"
    OUT="$(harness_release doctor 2>&1)"; RC=$?
    [ "$RC" = 0 ] && ok "T46: doctor sale 0: el arnés anda para Codex" || bad "T46: doctor salió $RC: $(printf '%s' "$OUT" | tail -5)"
  fi
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────── lo de fondo sin Claude Code ─────────────
# El aplicador DE VERDAD en el modo sin Claude Code, con un ambiente limpio (nada de las llaves de quien corre la suite)
# y una HOME que vive en la casa propia. `$1` es el árbol (el de este repo, o uno de laboratorio).
real_applier_off() { # real_applier_off <árbol> <home> [VAR=valor…]
  local tree="$1" h="$2"; shift 2
  env -i PATH="$PATH" HOME="$h" USERPROFILE="$h" TMPDIR="${TMPDIR:-/tmp}" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$h/gitconfig" \
    TYCON_REPOS_ROOT="$h/repos" TYCON_PROFILE=0 TYCON_HARNESS_NODE=0 \
    TYCON_HARNESS_CLAUDE=off TYCON_HARNESS_LOCK_HELD=1 TYCON_HARNESS_SHARED_DONE=1 TYCON_HARNESS_CODEX=done "$@" \
    bash "$tree/scripts/install-tycon-hooks.sh" > "$h/applier.out" 2>&1
}
off_home() { local h; h="$(lab_home "$1" own)"; mkdir -p "$h/repos"; : > "$h/gitconfig"; printf '%s' "$h"; }

if runs T47; then
  echo "8.150 T47 · CodexSolo_HookGlobalDeGit @story-8.150 @ac-9"
  # (a) el aplicador de verdad, sin Claude Code: copia los tres hooks y no toca core.hooksPath ni ~/.claude
  H="$(off_home t47a)"
  real_applier_off "$ROOT" "$H" TYCON_NO_UPLOAD_RUNS=1 TYCON_NO_DOWNLOAD_RUNS=1 TYCON_NO_COLLECT_FINDINGS=1; RC=$?
  [ "$RC" = 0 ] && ok "(a) el aplicador sin Claude Code sale 0" || bad "(a) el aplicador salió $RC: $(tail -5 "$H/applier.out")"
  for g in pre-commit post-commit pre-push; do
    [ -x "$H/.git-hooks/$g" ] && ok "(a) $g en ~/.git-hooks" || bad "(a) falta $g en ~/.git-hooks: $(ls -A "$H/.git-hooks" 2>&1 | tr '\n' ' ')"
  done
  [ -z "$(claude_listing "$H")" ] && ok "(a) nada en ~/.claude" || bad "(a) apareció en ~/.claude: $(claude_listing "$H" | head -12 | tr '\n' ' ')"
  [ -z "$(GIT_CONFIG_GLOBAL="$H/gitconfig" git config --global core.hooksPath 2>/dev/null)" ] && ok "(a) el aplicador no tocó core.hooksPath" || bad "(a) el aplicador puso core.hooksPath"
  H="$(off_home t47a2)"
  real_applier_off "$ROOT" "$H" TYCON_NO_GIT_HOOKS=1 TYCON_NO_UPLOAD_RUNS=1 TYCON_NO_DOWNLOAD_RUNS=1 TYCON_NO_COLLECT_FINDINGS=1; RC=$?
  [ "$RC" = 0 ] && [ ! -e "$H/.git-hooks" ] && ok "(a) con TYCON_NO_GIT_HOOKS=1, sin hooks de git" || bad "(a) con el interruptor salió $RC y ~/.git-hooks: $(ls -A "$H/.git-hooks" 2>&1 | tr '\n' ' ')"
  # (b) harness.js, en una instalación sólo con Codex, pone core.hooksPath global (el aplicador de juguete copia el pre-push)
  harness_lab_create "$BASE/lab47"
  harness_lab_release_server
  harness_lab_codex_pieces
  harness_lab_publish_stable 2026.10.07.1
  harness_lab_tools codex; harness_lab_tools_fresh_home
  export GIT_CONFIG_GLOBAL="$LAB_HOME/gitconfig"; : > "$GIT_CONFIG_GLOBAL"
  OUT="$(harness install --version latest --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "(b) install sólo con Codex sale 0" || bad "(b) install salió $RC: $OUT"
  [ "$(git config --global core.hooksPath 2>/dev/null)" = "$TYCON_GIT_HOOKS_DIR" ] && ok "(b) harness.js puso core.hooksPath global en la carpeta de los hooks" || bad "(b) core.hooksPath: «$(git config --global core.hooksPath 2>/dev/null)»"
  grep -q 'claude=off' "$LAB_HOME/.tycon/state/lab-applier.log" 2>/dev/null && ok "(b) el aplicador corrió en el modo sin Claude Code" || bad "(b) el aplicador no corrió sin Claude Code: $(cat "$LAB_HOME/.tycon/state/lab-applier.log" 2>&1 | tail -2)"
  [ -z "$(harness_lab_claude_home_listing)" ] && ok "(b) nada en ~/.claude" || bad "(b) apareció en ~/.claude: $(harness_lab_claude_home_listing | head -8 | tr '\n' ' ')"
  harness_lab_tools_fresh_home; rm -rf "$TYCON_GIT_HOOKS_DIR"; : > "$GIT_CONFIG_GLOBAL"
  OUT="$(TYCON_NO_GIT_HOOKS=1 harness install --version latest --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ -z "$(git config --global core.hooksPath 2>/dev/null)" ] && [ ! -e "$TYCON_GIT_HOOKS_DIR/pre-push" ] && ok "(b) con TYCON_NO_GIT_HOOKS=1, ni hooks ni core.hooksPath" || bad "(b) con el interruptor: rc $RC, core.hooksPath «$(git config --global core.hooksPath 2>/dev/null)»"
  export GIT_CONFIG_GLOBAL=/dev/null
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
  # (c) el pre-commit copiado encuentra el arnés en la casa propia, y donde siempre si está
  H="$(lab_home t47c own)"; mkdir -p "$H/.tycon/harness/scripts"
  # el tramo del hook que resuelve el arnés: harness_dir, harness_own_home y la línea de _TCG_DIR (hasta su `fi`)
  # (el nombre del hook va con comodín: escrito entero, el control de datos estables lo lee como un commit de git)
  HD_FN="$(awk '/^harness_dir\(\) \{/,/^fi$/' "$ROOT"/scripts/hooks/git-pre-c*-global.sh)"
  HD="$(env -i PATH="$PATH" HOME="$H" bash -c 'eval "$1"; printf "%s" "$_TCG_DIR"' _ "$HD_FN")"
  [ "$HD" = "$H/.tycon/harness" ] && ok "(c) sin ~/.claude, el pre-commit encuentra el arnés en ~/.tycon/harness" || bad "(c) el pre-commit buscó en «${HD}»"
  mkdir -p "$H/.claude/tycon-harness/scripts"
  HD="$(env -i PATH="$PATH" HOME="$H" bash -c 'eval "$1"; printf "%s" "$_TCG_DIR"' _ "$HD_FN")"
  [ "$HD" = "$H/.claude/tycon-harness" ] && ok "(c) con ~/.claude/tycon-harness, lo sigue encontrando ahí" || bad "(c) con el lugar de siempre buscó en «${HD}»"
fi

if runs T48; then
  echo "8.150 T48 · CodexSolo_FondoDelAplicador @story-8.150 @ac-10"
  # un árbol de laboratorio: el de este repo sin las pruebas, con la subida, la bajada y la recolección de mentira (anotan
  # que corrieron, sin red)
  TREE48="$BASE/tree48"; mkdir -p "$TREE48"
  ( cd "$ROOT" && tar --exclude='./scripts/tests' -cf - ./scripts ) | ( cd "$TREE48" && tar -xf - )
  for f in upload-runs download-runs collect-findings sdlc-stage-metrics tokens-digest; do
    printf 'require("fs").appendFileSync(require("path").join(process.env.HOME, "corrio.txt"), "%s\\n");\n' "$f" > "$TREE48/scripts/metrics/$f.js"
  done
  H="$(off_home t48)"
  real_applier_off "$TREE48" "$H" TYCON_MAILBOX=1; RC=$?
  [ "$RC" = 0 ] && ok "el aplicador sin Claude Code sale 0" || bad "el aplicador salió $RC: $(tail -5 "$H/applier.out")"
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do grep -q download-runs "$H/corrio.txt" 2>/dev/null && break; sleep 0.5; done
  for f in collect-findings upload-runs download-runs; do
    grep -qx "$f" "$H/corrio.txt" 2>/dev/null && ok "lanzó $f" || bad "no lanzó $f: $(cat "$H/corrio.txt" 2>&1 | tr '\n' ' ')"
    [ -f "$H/.tycon/state/$f.log" ] && ok "su registro, $f.log, en el estado" || bad "sin $f.log en el estado"
  done
  ! grep -qx tokens-digest "$H/corrio.txt" 2>/dev/null && ok "no lanzó el rescate del hilo (lee conversaciones de Claude Code)" || bad "lanzó el rescate del hilo"
  ! grep -qx sdlc-stage-metrics "$H/corrio.txt" 2>/dev/null && [ ! -e "$H/.tycon/state/stage-metrics-last-run" ] && ok "ni las métricas de etapa" || bad "lanzó las métricas"
  [ ! -e "$H/.tycon/state/controls-bench-last-run" ] && [ ! -e "$H/.tycon/state/controls-bench-last-try" ] && ok "ni el banco" || bad "selló el banco"
  [ -z "$(claude_listing "$H")" ] && ok "nada en ~/.claude" || bad "apareció en ~/.claude: $(claude_listing "$H" | head -12 | tr '\n' ' ')"
fi

if runs T49; then
  echo "8.150 T49 · ConClaude_SinCambios @story-8.150 @ac-11"
  harness_lab_create "$BASE/lab49"
  harness_lab_release_server
  harness_lab_codex_pieces
  harness_lab_publish_stable 2026.10.08.1
  harness_lab_tools both; harness_lab_tools_fresh_home
  OUT="$(harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "instalada con Claude Code y Codex" || bad "la instalación salió $RC: $OUT"
  LOG49="$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log"
  [ "$(grep -c '^run check=0' "$LOG49" 2>/dev/null)" = 1 ] && ok "el aplicador corrió una sola vez" || bad "el aplicador corrió $(grep -c '^run check=0' "$LOG49" 2>/dev/null) veces"
  ! grep -q 'claude=off' "$LOG49" 2>/dev/null && grep -q 'claude=on' "$LOG49" && ok "y como siempre, con Claude Code (sin el modo sin Claude Code)" || bad "corrió en el modo sin Claude Code: $(grep '^run' "$LOG49" | tail -2)"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

if runs T53; then
  echo "8.150 T53 · HistorialViejo_SeMudaUnaVez @story-8.150 @ac-14"
  # decisión del dueño 8/11: el historial que los hooks dejaron en ~/.claude antes de esta historia se muda una vez al
  # estado; lo que ya tiene destino no se pisa ni se borra
  H="$(off_home t53)"; C="$H/.claude"; S="$H/.tycon/state"
  mkdir -p "$C/blocking-meter" "$C/response-style" "$S/response-style" "$H/otra"
  printf 'viejo-freno\n' > "$C/safety-guard.log"
  printf '{"viejo":1}\n' > "$C/blocking-meter/log.jsonl"
  printf 'viejo-estilo\n' > "$C/response-style/log.jsonl"; printf 'nuevo-estilo\n' > "$S/response-style/log.jsonl"
  ln -s "$H/otra" "$C/lectura-grande"
  real_applier_off "$ROOT" "$H" TYCON_NO_UPLOAD_RUNS=1 TYCON_NO_DOWNLOAD_RUNS=1 TYCON_NO_COLLECT_FINDINGS=1 TYCON_NO_GIT_HOOKS=1; RC=$?
  [ "$RC" = 0 ] && ok "el aplicador sale 0" || bad "el aplicador salió $RC: $(tail -5 "$H/applier.out")"
  [ "$(cat "$S/safety-guard.log" 2>/dev/null)" = viejo-freno ] && [ ! -e "$C/safety-guard.log" ] && ok "safety-guard.log se mudó al estado, con su contenido" || bad "safety-guard.log: estado «$(cat "$S/safety-guard.log" 2>&1)», viejo $(ls "$C" 2>&1 | tr '\n' ' ')"
  [ "$(cat "$S/blocking-meter/log.jsonl" 2>/dev/null)" = '{"viejo":1}' ] && [ ! -e "$C/blocking-meter" ] && ok "blocking-meter/ se mudó entera" || bad "blocking-meter no se mudó"
  [ "$(cat "$C/response-style/log.jsonl" 2>/dev/null)" = viejo-estilo ] && [ "$(cat "$S/response-style/log.jsonl" 2>/dev/null)" = nuevo-estilo ] \
    && ok "response-style/ con destino ocupado: los dos quedan intactos" || bad "response-style: viejo «$(cat "$C/response-style/log.jsonl" 2>&1)», estado «$(cat "$S/response-style/log.jsonl" 2>&1)»"
  grep -q "response-style.*ya existe" "$H/applier.out" && ok "y lo avisa en una línea" || bad "no avisó el destino ocupado: $(grep -i 'tycon' "$H/applier.out" | tail -3)"
  [ -L "$C/lectura-grande" ] && [ ! -e "$S/lectura-grande" ] && ok "un enlace en ~/.claude no se muda" || bad "se mudó el enlace"
  real_applier_off "$ROOT" "$H" TYCON_NO_UPLOAD_RUNS=1 TYCON_NO_DOWNLOAD_RUNS=1 TYCON_NO_COLLECT_FINDINGS=1 TYCON_NO_GIT_HOOKS=1
  ! grep -q 'mudé' "$H/applier.out" && ok "la segunda corrida no muda nada" || bad "la segunda corrida volvió a mudar: $(grep 'mudé' "$H/applier.out")"
  # si no se puede renombrar (sin permiso en el estado; un disco distinto da otro error con la misma salida), el viejo
  # queda intacto y se dice
  H3="$(lab_home t53c own)"; mkdir -p "$H3/.claude"; printf 'viejo\n' > "$H3/.claude/safety-guard.log"; chmod 555 "$H3/.tycon/state"
  OUT="$(in_home "$H3" node "$ROOT/scripts/lib/loose-logs.js" --move-old 2>&1)"; RC=$?; chmod 755 "$H3/.tycon/state"
  [ "$RC" = 0 ] && [ "$(cat "$H3/.claude/safety-guard.log" 2>/dev/null)" = viejo ] && case "$OUT" in *"no pude moverlo"*) true ;; *) false ;; esac \
    && ok "sin poder renombrar: el viejo queda intacto y lo dice" || bad "sin poder renombrar: rc $RC, $OUT"
  # el guardián de pruebas sin el ayudante de la carpeta del estado: no anota, pero lo dice por stderr
  mkdir -p "$BASE/t53d/hooks"; cp "$ROOT/scripts/hooks/test-scope-guard-pre.sh" "$BASE/t53d/hooks/"
  H4="$(lab_home t53e own)"
  ERR="$(printf '{"tool_name":"Bash","tool_input":{"command":"TYCON_FULL_SUITE=1 npm test"},"cwd":"%s/repo"}' "$H4" \
    | in_home "$H4" TYCON_TEST_SCOPE_GUARD=1 bash "$BASE/t53d/hooks/test-scope-guard-pre.sh" 2>&1 >/dev/null)"
  case "$ERR" in *"no anoté la suite completa"*) ok "el guardián sin state-dir.sh avisa que no anotó" ;; *) bad "el guardián sin state-dir.sh calló: «${ERR}»" ;; esac
  # en una máquina que no vive en la casa propia no hace nada: el historial está donde sus lectores lo buscan
  H2="$(lab_home t53b old)"; mkdir -p "$H2/.claude"; printf 'viejo\n' > "$H2/.claude/safety-guard.log"
  OUT="$(in_home "$H2" node "$ROOT/scripts/lib/loose-logs.js" --move-old 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ -f "$H2/.claude/safety-guard.log" ] && [ ! -e "$H2/.tycon" ] && ok "sin mudar a la casa propia, no toca nada" || bad "sin mudar: rc $RC, $OUT"
fi

if runs T51; then
  echo "8.150 T51 · CodexSolo_SacarClaude_NoSeLlevaLosHooksDeGit @story-8.150 @ac-9"
  # hallazgo del pase adversarial: los hooks de git quedan registrados en una máquina sólo con Codex, y sacar Claude Code
  # (que nunca estuvo) no los cuenta como suyos
  harness_lab_create "$BASE/lab51"
  harness_lab_release_server
  harness_lab_codex_pieces
  harness_lab_publish_stable 2026.10.09.1
  harness_lab_tools codex; harness_lab_tools_fresh_home
  export GIT_CONFIG_GLOBAL="$LAB_HOME/gitconfig"; : > "$GIT_CONFIG_GLOBAL"
  OUT="$(harness install --version latest --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ -f "$TYCON_GIT_HOOKS_DIR/pre-push" ] && ok "instalada sólo con Codex, con el pre-push" || bad "la instalación salió $RC o sin pre-push: $OUT"
  OUT="$(harness_release uninstall --tool claude --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$OUT" in *"no está enchufad"*) true ;; *) false ;; esac && ok "uninstall --tool claude: Claude Code no está enchufada, nada que quitar" || bad "uninstall --tool claude salió $RC: $OUT"
  [ -f "$TYCON_GIT_HOOKS_DIR/pre-push" ] && ok "y el pre-push de git sigue en su lugar" || bad "sacar Claude Code se llevó el pre-push"
  export GIT_CONFIG_GLOBAL=/dev/null
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

if runs T52; then
  echo "8.150 T52 · CodexSolo_AplicadorViejo_NoCorre @story-8.150 @ac-11"
  # hallazgo del pase adversarial: una versión cuyo aplicador no conoce el modo sin Claude Code (una vuelta atrás, una
  # versión anterior) no corre en una máquina sin Claude Code: instalaría todo Claude Code
  harness_lab_create "$BASE/lab52"
  harness_lab_release_server
  harness_lab_codex_pieces
  harness_lab_applier_without_claude_off "$LAB_AUTHOR_TREE" && ok "(armado) el aplicador publicado no nombra TYCON_HARNESS_CLAUDE" || bad "(armado) el aplicador sigue nombrando el modo"
  harness_lab_publish_stable 2026.10.10.1
  harness_lab_tools codex; harness_lab_tools_fresh_home
  OUT="$(harness install --version latest --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "install sólo con Codex sale 0" || bad "install salió $RC: $OUT"
  [ -z "$(find "$LAB_HOME" -name 'lab-applier.log' 2>/dev/null | head -1)" ] && ok "el aplicador viejo no corrió" || bad "el aplicador viejo corrió: $(find "$LAB_HOME" -name 'lab-applier.log' | head -1)"
  [ -z "$(harness_lab_claude_home_listing)" ] && ok "nada en ~/.claude" || bad "apareció en ~/.claude: $(harness_lab_claude_home_listing | head -8 | tr '\n' ' ')"
  OUT="$(harness_release apply --dry-run 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ -z "$(harness_lab_claude_home_listing)" ] && ok "y apply --dry-run no le pide el plan" || bad "apply --dry-run salió $RC: $(printf '%s' "$OUT" | tail -3)"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ─────────────────────────── T13 · sin agente de código ───────────────────────────
if runs T13; then
  echo "8.46 T13 · sin Claude Code ni Codex: la orden de las dos para cada sistema y cómo iniciar sesión, sin correr nada"
  for P in darwin linux win32; do
    OUT="$(node -e 'process.stdout.write(require(process.argv[1]).noneFound(process.argv[2]))' "$ROOT/scripts/setup/harness/tools.js" "$P" 2>&1)"
    case "$OUT" in *"no encontré Claude Code ni Codex"*) ok "$P: empieza diciendo qué falta" ;; *) bad "$P: no dice qué falta: $OUT" ;; esac
    if [ "$P" = win32 ]; then
      case "$OUT" in *"irm https://claude.ai/install.ps1 | iex"*"chatgpt.com/codex/install.ps1"*) ok "$P: las órdenes de PowerShell de las dos" ;; *) bad "$P: sin las órdenes de Windows: $OUT" ;; esac
    else
      case "$OUT" in *"curl -fsSL https://claude.ai/install.sh | bash"*"curl -fsSL https://chatgpt.com/codex/install.sh | sh"*) ok "$P: las órdenes de la terminal de las dos" ;; *) bad "$P: sin las órdenes de Mac/Linux: $OUT" ;; esac
    fi
    case "$OUT" in *"corré claude"*"corré codex"*) ok "$P: cómo iniciar sesión en cada una" ;; *) bad "$P: no dice cómo iniciar sesión: $OUT" ;; esac
    case "$OUT" in *"No escribí nada"*) ok "$P: no escribió nada" ;; *) bad "$P: no dice que no escribió nada: $OUT" ;; esac
  done
fi

# ───────────────────────────────────────────── T21 ─────────────────────────────────────────────
if runs T21; then
  echo "T21 · install detecta las herramientas, las nombra en el plan, --tool las fija, sin ninguna sale 1 sin escribir"
  harness_lab_create "$BASE/lab21"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1

  # sólo Claude Code en el PATH
  harness_lab_tools claude; harness_lab_tools_fresh_home
  OUT="$(harness install --version latest --dry-run 2>&1)"; RC=$?
  L="$(tools_line "$OUT")"
  [ "$RC" = 0 ] && ok "con claude en el PATH, --dry-run sale 0" || bad "--dry-run salió $RC: $OUT"
  case "$L" in *"Claude Code"*) ok "el plan nombra a Claude Code" ;; *) bad "el plan no nombra a Claude Code: $OUT" ;; esac
  case "$L" in *Codex*) bad "el plan nombra a Codex sin estar: $L" ;; *) ok "y no nombra a Codex" ;; esac

  # sólo Codex en el PATH
  harness_lab_tools codex; harness_lab_tools_fresh_home
  OUT="$(harness install --version latest --dry-run 2>&1)"; RC=$?
  L="$(tools_line "$OUT")"
  [ "$RC" = 0 ] && ok "con codex en el PATH, --dry-run sale 0" || bad "--dry-run salió $RC: $OUT"
  case "$L" in *Codex*) ok "el plan nombra a Codex" ;; *) bad "el plan no nombra a Codex: $OUT" ;; esac
  case "$L" in *"Claude Code"*) bad "el plan nombra a Claude Code sin estar: $L" ;; *) ok "y no nombra a Claude Code" ;; esac

  # las dos
  harness_lab_tools both; harness_lab_tools_fresh_home
  OUT="$(harness install --version latest --dry-run 2>&1)"; RC=$?
  L="$(tools_line "$OUT")"
  case "$L" in *"Claude Code"*Codex*|*Codex*"Claude Code"*) ok "con las dos, el plan nombra a las dos" ;; *) bad "con las dos, el plan dice: $OUT" ;; esac
  case "$L" in *detectada*) ok "y dice que las detectó" ;; *) bad "no dice que las detectó: $L" ;; esac

  # la configuración propia de la herramienta también cuenta (sin ejecutable en el PATH)
  harness_lab_tools none; harness_lab_tools_fresh_home
  mkdir -p "$CODEX_HOME"; printf '{}\n' > "$CODEX_HOME/auth.json"
  OUT="$(harness install --version latest --dry-run 2>&1)"; RC=$?
  L="$(tools_line "$OUT")"
  case "$L" in *Codex*) ok "sin ejecutable, la configuración propia de Codex (auth.json) la detecta" ;; *) bad "auth.json no alcanzó: rc=$RC $OUT" ;; esac
  harness_lab_tools_fresh_home
  printf '{}\n' > "$LAB_HOME/.claude.json"
  OUT="$(harness install --version latest --dry-run 2>&1)"; RC=$?
  L="$(tools_line "$OUT")"
  case "$L" in *"Claude Code"*) ok "sin ejecutable, la configuración propia de Claude Code (~/.claude.json) la detecta" ;; *) bad "~/.claude.json no alcanzó: rc=$RC $OUT" ;; esac

  # lo que el arnés despliega NO cuenta como «instalada»
  harness_lab_tools none; harness_lab_tools_fresh_home
  mkdir -p "$CODEX_HOME" "$LAB_HOME/.claude"; printf '{ "hooks": {} }\n' > "$CODEX_HOME/hooks.json"; printf '{ "hooks": {} }\n' > "$LAB_HOME/.claude/settings.json"
  OUT="$(harness install --version latest --dry-run 2>&1)"; RC=$?
  [ "$RC" = 1 ] && ok "un hooks.json de Codex y un settings.json sueltos no cuentan como herramienta instalada (sale 1)" || bad "con sólo lo desplegado salió $RC: $OUT"

  # ninguna: 1, sin escribir y sin salir a la red
  harness_lab_tools none; harness_lab_tools_fresh_home
  before="$(harness_lab_home_hash)"; asked="$(requests .)"
  OUT="$(harness install --version latest --yes 2>&1)"; RC=$?
  [ "$RC" = 1 ] && ok "sin ninguna, install sale 1" || bad "sin ninguna salió $RC: $OUT"
  case "$OUT" in *"no encontré Claude Code ni Codex"*) ok "y lo dice: «no encontré Claude Code ni Codex»" ;; *) bad "no lo dice: $OUT" ;; esac
  [ "$(harness_lab_home_hash)" = "$before" ] && [ ! -e "$LAB_HOME/.tycon" ] && ok "sin escribir nada" || bad "escribió en la HOME"
  [ "$(requests .)" = "$asked" ] && ok "y sin salir a la red" || bad "salió a la red ($asked → $(requests .) pedidos)"

  # --tool lo fija: con las dos detectadas, sólo la pedida
  harness_lab_tools both; harness_lab_tools_fresh_home
  OUT="$(harness install --version latest --tool codex --dry-run 2>&1)"; RC=$?
  L="$(tools_line "$OUT")"
  case "$L" in *Codex*) ok "--tool codex: el plan nombra a Codex" ;; *) bad "--tool codex: $OUT" ;; esac
  case "$L" in *"Claude Code"*) bad "--tool codex nombra también a Claude Code: $L" ;; *) ok "y a ninguna otra, aunque esté detectada" ;; esac
  case "$L" in *"--tool"*) ok "y dice que vino por --tool" ;; *) bad "no dice que vino por --tool: $L" ;; esac
  # --tool pide una que no está detectada: vale igual (la persona la fija)
  harness_lab_tools none; harness_lab_tools_fresh_home
  OUT="$(harness install --version latest --tool claude --dry-run 2>&1)"; RC=$?
  L="$(tools_line "$OUT")"
  [ "$RC" = 0 ] && case "$L" in *"Claude Code"*) true ;; *) false ;; esac && ok "--tool claude sin nada detectado: la fija igual" || bad "--tool claude sin detectar salió $RC: $OUT"
  # repetible
  OUT="$(harness install --version latest --tool claude --tool codex --dry-run 2>&1)"; RC=$?
  L="$(tools_line "$OUT")"
  case "$L" in *"Claude Code"*Codex*|*Codex*"Claude Code"*) ok "--tool es repetible (claude y codex)" ;; *) bad "--tool repetido: rc=$RC $OUT" ;; esac
  # un valor que no es una herramienta: 2, sin escribir
  before="$(harness_lab_home_hash)"
  OUT="$(harness install --version latest --tool cursor --yes 2>&1)"; RC=$?
  [ "$RC" = 2 ] && ok "--tool con un valor desconocido sale 2" || bad "--tool cursor salió $RC: $OUT"
  case "$OUT" in *claude*codex*) ok "y nombra los que valen" ;; *) bad "no nombra los que valen: $OUT" ;; esac
  [ "$(harness_lab_home_hash)" = "$before" ] && ok "sin escribir nada" || bad "--tool cursor escribió"

  # la conformidad: sin --yes y sin terminal no escribe (2) y el plan mostrado nombra las herramientas
  harness_lab_tools claude; harness_lab_tools_fresh_home
  before="$(harness_lab_home_hash)"
  OUT="$(harness install --version latest 2>&1 </dev/null)"; RC=$?
  [ "$RC" = 2 ] && ok "sin --yes y sin terminal sale 2" || bad "sin --yes salió $RC: $OUT"
  case "$(tools_line "$OUT")" in *"Claude Code"*) ok "y el plan mostrado nombra las herramientas" ;; *) bad "el plan mostrado no las nombra: $OUT" ;; esac
  [ "$(harness_lab_home_hash)" = "$before" ] && ok "sin escribir nada" || bad "sin --yes escribió"
  # con terminal: pregunta UNA vez, y «n» no instala
  OUT="$(harness_lab_pty n harness install --version latest 2>&1)"; RC=$?
  case "$OUT" in *"herramientas a enchufar"*"¿Instalo?"*) ok "con terminal muestra las herramientas y después pide la conformidad" ;; *) bad "con terminal: $OUT" ;; esac
  [ "$(printf '%s\n' "$OUT" | grep -c '¿Instalo?')" = 1 ] && ok "pregunta una sola vez" || bad "preguntó $(printf '%s\n' "$OUT" | grep -c '¿Instalo?') veces"
  [ ! -d "$LAB_HOME/.tycon/harness" ] && ok "y con «n» no instala" || bad "con «n» instaló"

  # instalar de verdad con --tool claude y las dos detectadas: el estado lo recuerda y Codex no se toca
  harness_lab_tools both; harness_lab_tools_fresh_home
  OUT="$(harness install --version latest --tool claude --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "install --tool claude --yes sale 0" || bad "install --tool claude salió $RC: $OUT"
  [ "$(state "','.join(d['tools'])")" = claude ] && ok "el estado recuerda qué enchufó (tools: claude)" || bad "el estado dice tools: $(state "d.get('tools')")"
  [ ! -e "$CODEX_HOME" ] && ok "y no escribió nada en la carpeta de Codex" || bad "escribió en $CODEX_HOME: $(ls -A "$CODEX_HOME" 2>/dev/null)"
  case "$OUT" in *"herramientas enchufadas: Claude Code"*) ok "el cierre dice qué enchufó" ;; *) bad "el cierre no dice qué enchufó: $OUT" ;; esac
  # InstallClose_NombraLasCarpetas @story-8.66.1 @ac-1: el cierre nombra las carpetas que Claude Code lee sin preguntar
  case "$OUT" in *"piezas escritas"*"lee sin preguntar"*"~/.tycon/harness"*) ok "InstallClose_NombraLasCarpetas: el cierre nombra las carpetas permitidas, después de las piezas" ;; *) bad "InstallClose_NombraLasCarpetas: el cierre no nombra las carpetas permitidas: $OUT" ;; esac
  # InstallClose_SinReglas_SinLinea @story-8.66.1 @ac-1: con las reglas apagadas, el cierre no las nombra
  harness_lab_tools_fresh_home
  OUT="$(TYCON_NO_READ_PERMISSIONS=1 harness install --version latest --tool claude --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "InstallClose_SinReglas_SinLinea: install con las reglas apagadas sale 0" || bad "InstallClose_SinReglas_SinLinea: salió $RC: $OUT"
  case "$OUT" in *"lee sin preguntar"*) bad "InstallClose_SinReglas_SinLinea: con las reglas apagadas el cierre igual las nombra: $OUT" ;; *) ok "InstallClose_SinReglas_SinLinea: con las reglas apagadas, el cierre no las nombra" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null

  # desde un CLON (la instalación actual): el plan nombra las herramientas, Claude Code va siempre, y --tool codex solo sale 2
  harness_lab_create "$BASE/lab21c"
  harness_lab_release_server   # el árbol unido (skills/, agents/): lo que el enchufe de Codex espera del clon
  harness_lab_codex_pieces
  harness_lab_tools both
  OUT="$(harness install --dry-run 2>&1)"; RC=$?
  L="$(tools_line "$OUT")"
  case "$L" in *"Claude Code"*Codex*) ok "desde un clon, el plan nombra a Claude Code y a Codex (detectado)" ;; *) bad "desde un clon, el plan dice: rc=$RC $OUT" ;; esac
  before="$(harness_lab_home_hash)"
  OUT="$(harness install --tool codex --yes 2>&1)"; RC=$?
  [ "$RC" = 2 ] && [ "$(harness_lab_home_hash)" = "$before" ] && ok "desde un clon, --tool codex solo sale 2 sin escribir (Claude Code va siempre)" || bad "desde un clon, --tool codex salió $RC: $OUT"
  case "$OUT" in *"--tool claude --tool codex"*) ok "y dice cómo pedir las dos" ;; *) bad "no dice cómo: $OUT" ;; esac
  # sin Codex detectado y con su lado YA desplegado (una máquina de antes): install no lo deja sin mantener
  harness_lab_tools claude
  mkdir -p "$CODEX_HOME"; printf '{ "hooks": {} }\n' > "$CODEX_HOME/hooks.json"
  OUT="$(harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "desde un clon con Codex ya desplegado, install sale 0" || bad "install salió $RC: $OUT"
  [ "$(state "','.join(d['tools'])")" = "claude,codex" ] && ok "y Codex se conserva enchufado aunque esta ejecución no lo detecte (tools: claude, codex)" || bad "tools: $(state "d.get('tools')") — install dejó a Codex sin mantener"
  grep -q 'harness-startup.js' "$CODEX_HOME/hooks.json" && ok "y su lado se mantiene por el enchufe en Node (el hook de arranque quedó registrado)" || bad "el lado Codex no se re-enchufó: $(cat "$CODEX_HOME/hooks.json")"
  # con la llave apagada a propósito: deja de mantenerse, y lo dice
  OUT="$(TYCON_CODEX=0 harness install --dry-run 2>&1)"
  case "$OUT" in *"deja de mantenerse"*) ok "con integrations.codex apagada a propósito, el plan dice que Codex deja de mantenerse" ;; *) bad "con la llave apagada no lo dice: $OUT" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# lo que escribió el arnés en todo el HOME, sin la carpeta de Codex de la persona ni la casa del arnés: rutas que nombran
# la carpeta de Claude Code (la prueba de «nada nuevo en ~/.claude» mira el disco; ésta mira lo ESCRITO en los enchufes)
names_claude_dir() { grep -l -- '/\.claude/' "$@" 2>/dev/null || true; }
# el `command` de un evento del hooks.json de Codex, uno por línea
codex_commands() {
  python3 -c '
import json, sys
h = json.load(open(sys.argv[1], encoding="utf-8")).get("hooks", {})
for g in h.get(sys.argv[2], []):
    for c in g.get("hooks", []): print(c.get("command", ""))' "$CODEX_HOME/hooks.json" "$1" 2>/dev/null
}
# espera a que el estado diga esa versión (el arranque actualiza aparte del hook)
wait_version() { local i; for i in $(seq 1 150); do [ "$(state "d['version']['number']")" = "$1" ] && return 0; sleep 0.2; done; return 1; }

# ───────────────────────────────────────────── T22 ─────────────────────────────────────────────
if runs T22; then
  echo "T22 · sólo Codex: nada nuevo en ~/.claude, AGENTS.md desde los bloques entre marcas, skills, y el arranque actualiza"
  harness_lab_create "$BASE/lab22"
  harness_lab_release_server
  harness_lab_codex_pieces
  harness_lab_publish_stable 2026.10.07.1
  harness_lab_tools codex; harness_lab_tools_fresh_home
  mkdir -p "$CODEX_HOME"
  PERSON='# Mis reglas de Codex

texto propio de la persona, con  dos espacios
'
  printf '%s' "$PERSON" > "$CODEX_HOME/AGENTS.md"
  printf 'model = "lab"\n' > "$CODEX_HOME/config.toml"
  OUT="$(harness install --version latest --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "install en una máquina sólo con Codex sale 0" || bad "install salió $RC: $OUT"
  [ -z "$(harness_lab_claude_home_listing)" ] && ok "después de install no existe nada en ~/.claude" || bad "hay cosas nuevas en ~/.claude: $(harness_lab_claude_home_listing | head -12 | tr '\n' ' ')"
  [ ! -e "$LAB_HOME/.claude.json" ] && ok "ni un ~/.claude.json" || bad "apareció ~/.claude.json"
  [ -f "$LAB_HOME/.tycon/state/harness-state.json" ] && ok "el estado nació en ~/.tycon/state" || bad "no hay estado en ~/.tycon/state: $(ls -A "$LAB_HOME/.tycon" 2>/dev/null | tr '\n' ' ')"
  [ "$(state "','.join(d['tools'])")" = codex ] && ok "el estado dice tools: codex" || bad "tools: $(state "d.get('tools')")"
  [ "$(state "d['sources'][0]['kind']")" = release ] && [ -f "$LAB_HOME/.tycon/harness/version.json" ] && ok "la versión bajada quedó en ~/.tycon/harness" || bad "sin árbol o sin kind release"
  [ -f "$LAB_HOME/.tycon/state/harness/bootstrap.js" ] && ok "la copia fija de arranque está en ~/.tycon/state/harness" || bad "falta la copia fija en ~/.tycon/state/harness"
  case "$OUT" in *"herramientas enchufadas: Codex"*) ok "el cierre dice que enchufó a Codex" ;; *) bad "el cierre no lo dice: $OUT" ;; esac
  # el aplicador corre sólo en el modo sin Claude Code (lo de fondo), con su registro en el estado
  FOUND_LOG="$(find "$LAB_HOME" -name 'lab-applier.log' 2>/dev/null | head -1)"
  [ "$FOUND_LOG" = "$LAB_HOME/.tycon/state/lab-applier.log" ] && grep -q '^run check=0' "$FOUND_LOG" && ! grep '^run check=0' "$FOUND_LOG" | grep -v 'claude=off' >/dev/null \
    && ok "el aplicador corrió sólo en el modo sin Claude Code (el enchufe de Claude Code no corrió)" || bad "el aplicador: $FOUND_LOG · $(grep '^run' "$FOUND_LOG" 2>/dev/null | tail -2)"

  # AGENTS.md: los bloques entre marcas, lo de la persona intacto, sin @import
  AG="$CODEX_HOME/AGENTS.md"
  grep -q 'TYCON_BLOCK:lab-rules START' "$AG" && grep -q 'TYCON_BLOCK:lab-rules END' "$AG" && grep -q 'regla del laboratorio' "$AG" && ok "AGENTS.md trae el bloque del arnés entre sus marcas" || bad "AGENTS.md sin el bloque: $(cat "$AG" 2>/dev/null | head -20)"
  grep -q 'nombres del lado Codex' "$AG" && ! grep -q 'nombres del lado Claude' "$AG" && ok "el bloque con variante lleva el cuerpo de Codex" || bad "la variante de Codex no está (o está la de Claude)"
  [ "$(head -c "${#PERSON}" "$AG")" = "$(printf '%s' "$PERSON")" ] && ok "lo de la persona fuera de las marcas quedó intacto" || bad "lo de la persona cambió: $(head -5 "$AG")"
  [ "$(grep -c '^@' "$AG")" = 0 ] && ok "sin ningún @import" || bad "AGENTS.md tiene un @import: $(grep '^@' "$AG")"

  # las skills llegan por ~/.codex/skills, desde ~/.tycon/harness
  [ -L "$CODEX_HOME/skills/tycon-pipeline" ] && [ "$(cd "$(readlink "$CODEX_HOME/skills/tycon-pipeline")" 2>/dev/null && pwd -P)" = "$(cd "$LAB_HOME/.tycon/harness/skills/tycon-pipeline" && pwd -P)" ] && ok "las skills están enlazadas en ~/.codex/skills hacia ~/.tycon/harness" || bad "skills: $(ls -la "$CODEX_HOME/skills" 2>&1 | tail -3)"
  # los revisores: el perfil y el subagente que el árbol trae generados, desplegados tal cual (sin regenerar en el árbol)
  [ -f "$CODEX_HOME/lab-advisor.config.toml" ] && [ -f "$CODEX_HOME/agents/lab-advisor.toml" ] && ok "el perfil y el subagente del revisor llegaron a la carpeta de Codex" || bad "faltan el perfil o el subagente: $(ls "$CODEX_HOME" 2>&1 | tr '\n' ' ')"
  # los hooks: los del arnés, apuntando a ~/.tycon/harness, ninguno a la carpeta de Claude
  START_CMD="$(codex_commands SessionStart | grep 'harness-startup.js' | head -1)"
  case "$START_CMD" in *"$LAB_HOME/.tycon/harness/scripts/hooks/harness-startup.js"*) ok "el hook de arranque de Codex apunta a ~/.tycon/harness" ;; *) bad "hook de arranque: «${START_CMD}» ($(cat "$CODEX_HOME/hooks.json" 2>&1 | head -5))" ;; esac
  [ -z "$(names_claude_dir "$CODEX_HOME/hooks.json" "$CODEX_HOME/config.toml" "$LAB_HOME/.tycon/state/harness-state.json")" ] && ok "ningún enchufe ni el estado nombran la carpeta de Claude Code" || bad "la nombran: $(names_claude_dir "$CODEX_HOME/hooks.json" "$CODEX_HOME/config.toml" "$LAB_HOME/.tycon/state/harness-state.json")"
  grep -q 'model = "lab"' "$CODEX_HOME/config.toml" && ok "lo que la persona tenía en config.toml sigue" || bad "config.toml perdió lo de la persona"

  # doctor: sano, y dice qué herramientas enchufa
  OUT="$(harness_release doctor 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "doctor sale 0" || bad "doctor salió $RC: $OUT"
  case "$OUT" in *"herramientas"*Codex*) ok "doctor dice que enchufa a Codex" ;; *) bad "doctor no nombra las herramientas: $OUT" ;; esac
  [ -z "$(harness_lab_claude_home_listing)" ] && ok "doctor no escribió en ~/.claude" || bad "doctor escribió en ~/.claude"

  # el arranque de una sesión de Codex actualiza el arnés: una versión nueva, y se corre SU hook como lo corre Codex
  harness_lab_publish_stable 2026.10.07.2
  HOOK_OUT="$(printf '{"hook_event_name":"SessionStart","session_id":"lab","cwd":"%s"}' "$LAB_TMP" | bash -c "$START_CMD" 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "el hook de arranque de Codex sale 0" || bad "el hook de arranque salió $RC: $HOOK_OUT"
  wait_version 2026.10.07.2 && ok "el arranque de Codex actualizó el arnés (2026.10.07.2)" || bad "no actualizó: versión $(state "d['version']['number']") · $(tail -5 "$LAB_HOME/.tycon/state/harness/startup.log" 2>/dev/null)"
  [ "$(j "$LAB_HOME/.tycon/harness/version.json" "d['version']")" = 2026.10.07.2 ] && ok "y ~/.tycon/harness es la versión nueva" || bad "~/.tycon/harness sigue en $(j "$LAB_HOME/.tycon/harness/version.json" "d['version']")"
  [ -z "$(harness_lab_claude_home_listing)" ] && ok "el arranque y la actualización tampoco escribieron en ~/.claude" || bad "el arranque escribió en ~/.claude: $(harness_lab_claude_home_listing | head -8 | tr '\n' ' ')"
  [ "$(head -c "${#PERSON}" "$AG")" = "$(printf '%s' "$PERSON")" ] && ok "y lo de la persona en AGENTS.md sigue intacto" || bad "la actualización tocó lo de la persona"

  # uninstall: se va lo del arnés, queda lo de la persona, y sigue sin haber nada en ~/.claude
  OUT="$(harness_release uninstall --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "uninstall sale 0" || bad "uninstall salió $RC: $OUT"
  [ ! -d "$LAB_HOME/.tycon/harness" ] && [ ! -f "$LAB_HOME/.tycon/state/harness-state.json" ] && ok "se fueron el árbol y el estado" || bad "quedó el árbol o el estado"
  # la máquina deja de «vivir en ~/.tycon»: si quedara la carpeta del estado, instalar después con Claude Code se negaría
  [ ! -e "$LAB_HOME/.tycon/state" ] && ok "y la carpeta del estado en ~/.tycon (la máquina queda libre para instalar como quiera)" || bad "quedó ~/.tycon/state: $(cd "$LAB_HOME/.tycon" && find state | head -12 | tr '\n' ' ')"
  ! grep -q 'TYCON_BLOCK' "$AG" 2>/dev/null && grep -q 'texto propio de la persona' "$AG" && ok "AGENTS.md quedó sin los bloques y con lo de la persona" || bad "AGENTS.md después de uninstall: $(cat "$AG" 2>&1 | head -8)"
  [ ! -e "$CODEX_HOME/skills/tycon-pipeline" ] && ok "y sin los enlaces de skills" || bad "quedaron enlaces de skills"
  [ -z "$(harness_lab_claude_home_listing)" ] && ok "uninstall no escribió en ~/.claude" || bad "uninstall escribió en ~/.claude"

  # con Claude Code también presente: AGENTS.md se arma igual, desde los bloques, no copiando el CLAUDE.md
  harness_lab_tools both; harness_lab_tools_fresh_home
  mkdir -p "$LAB_HOME/.claude" "$CODEX_HOME"
  printf '{\n  "hooks": {}\n}\n' > "$LAB_HOME/.claude/settings.json"
  printf '# Lo mío en Claude\nTEXTO-PERSONAL-DE-CLAUDE\n' > "$LAB_HOME/.claude/CLAUDE.md"
  OUT="$(harness install --version latest --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "con las dos, install sale 0" || bad "con las dos, install salió $RC: $OUT"
  [ "$(state "','.join(d['tools'])")" = "claude,codex" ] && ok "el estado dice tools: claude, codex" || bad "tools: $(state "d.get('tools')")"
  grep -q 'TYCON_BLOCK:lab-rules START' "$AG" && ok "con Claude Code presente, AGENTS.md trae los bloques" || bad "con las dos, AGENTS.md sin bloques: $(cat "$AG" 2>&1 | head -6)"
  ! grep -q 'TEXTO-PERSONAL-DE-CLAUDE' "$AG" && ok "y no es copia del CLAUDE.md de la persona" || bad "AGENTS.md copió el CLAUDE.md"
  [ -f "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json" ] && ok "con Claude Code, el estado sigue donde hoy (hasta la mudanza)" || bad "con Claude Code el estado no está en su lugar de hoy"
  [ -n "$(harness_lab_settings_commands)" ] && ok "y Claude Code recibió su línea de arranque" || bad "sin línea de arranque en settings.json"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T23 ─────────────────────────────────────────────
if runs T23; then
  echo "T23 · el MCP de Codex: sin ~/.claude.json, con uno que suma un servidor, el faltante dicho, writable_roots"
  harness_lab_create "$BASE/lab23"
  harness_lab_release_server
  harness_lab_codex_pieces
  harness_lab_publish_stable 2026.10.07.1
  TOML() { printf '%s' "$CODEX_HOME/config.toml"; }

  # sin ~/.claude.json: los servidores del arnés, y el estado de ~/.tycon en writable_roots
  harness_lab_tools codex; harness_lab_tools_fresh_home
  OUT="$(TYCON_ENGRAM=1 harness install --version latest --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "install (sólo Codex, sin ~/.claude.json) sale 0" || bad "install salió $RC: $OUT"
  grep -q '^\[mcp_servers.plugin_engram_engram\]' "$(TOML)" && ok "sin ~/.claude.json se registran los servidores del arnés (engram)" || bad "falta engram en config.toml: $(cat "$(TOML)" 2>&1 | head -20)"
  grep -q "\"$LAB_HOME/.tycon/state\"" "$(TOML)" && grep -q 'writable_roots' "$(TOML)" && ok "writable_roots lleva ~/.tycon/state" || bad "writable_roots sin ~/.tycon/state: $(grep -A3 sandbox_workspace_write "$(TOML)" 2>&1)"
  [ ! -e "$LAB_HOME/.claude.json" ] && ok "y no se creó ningún ~/.claude.json" || bad "se creó ~/.claude.json"

  # un servidor esperado que no se puede registrar SE DICE: clockify prendido y sin su definición en la máquina
  harness_lab_tools_fresh_home
  OUT="$(TYCON_CLOCKIFY=1 harness install --version latest --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "con un servidor que falta, install igual sale 0" || bad "install salió $RC: $OUT"
  case "$OUT" in *clockify*"no lo puedo registrar"*|*"no lo puedo registrar"*clockify*) ok "el servidor que falta se dice (clockify)" ;; *) bad "no dice que falta clockify: $OUT" ;; esac
  ! grep -q '^\[mcp_servers.clockify\]' "$(TOML)" && ok "y no se registra uno a medias" || bad "registró clockify sin definición"

  # con un ~/.claude.json que trae un servidor de la persona: se suma (y su secreto no viaja)
  harness_lab_tools_fresh_home
  cat > "$LAB_HOME/.claude.json" <<'JSON'
{ "mcpServers": { "clockify": { "command": "/opt/lab/node", "args": ["/opt/lab/clockify.js"], "env": { "CLOCKIFY_API_KEY": "sekreto-del-lab" } } } }
JSON
  OUT="$(TYCON_CLOCKIFY=1 CLOCKIFY_API_KEY=x harness install --version latest --tool codex --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "con ~/.claude.json, install sale 0" || bad "install salió $RC: $OUT"
  grep -q '^\[mcp_servers.clockify\]' "$(TOML)" && grep -q '/opt/lab/clockify.js' "$(TOML)" && ok "el servidor de ~/.claude.json se suma" || bad "no se sumó clockify: $(cat "$(TOML)" 2>&1 | head -20)"
  ! grep -rq 'sekreto-del-lab' "$CODEX_HOME" "$LAB_HOME/.tycon/state" && ok "y su secreto no se copió a ningún lado" || bad "el secreto viajó"
  case "$OUT" in *"no lo puedo registrar"*) bad "dice que falta uno que sí registró: $OUT" ;; *) ok "y ya no dice que falta" ;; esac

  # con Claude Code también (el estado en su lugar actual): writable_roots lleva el actual Y ~/.tycon/state
  harness_lab_tools both; harness_lab_tools_fresh_home
  mkdir -p "$LAB_HOME/.claude"; printf '{\n  "hooks": {}\n}\n' > "$LAB_HOME/.claude/settings.json"; : > "$LAB_HOME/.claude/CLAUDE.md"
  OUT="$(harness install --version latest --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "con las dos, install sale 0" || bad "con las dos, install salió $RC: $OUT"
  grep -q "\"$LAB_HOME/.claude/.tycon-pipeline\"" "$(TOML)" && grep -q "\"$LAB_HOME/.tycon/state\"" "$(TOML)" && ok "writable_roots lleva el estado de hoy y ~/.tycon/state" || bad "writable_roots: $(grep -A4 sandbox_workspace_write "$(TOML)" 2>&1 | tr '\n' ' ')"

  # lo contestado en las preguntas de install (acá por su opción) decide el enchufe en ESA corrida: una máquina donde
  # sólo se detecta Claude Code y la persona prende la integración de Codex queda con las dos enchufadas
  harness_lab_tools claude; harness_lab_tools_fresh_home
  mkdir -p "$LAB_HOME/.claude"; printf '{\n  "hooks": {}\n}\n' > "$LAB_HOME/.claude/settings.json"; : > "$LAB_HOME/.claude/CLAUDE.md"
  OUT="$(harness install --version latest --integrations codex --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(state "','.join(d['tools'])")" = "claude,codex" ] && [ -f "$CODEX_HOME/AGENTS.md" ] \
    && ok "prender la integración de Codex al instalar lo enchufa en esa misma ejecución" \
    || bad "--integrations codex salió $RC, tools: $(state "d.get('tools')"), AGENTS.md $([ -f "$CODEX_HOME/AGENTS.md" ] && echo está || echo falta): $OUT"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T26 ─────────────────────────────────────────────
if runs T26; then
  echo "T26 · una herramienta que llega después: install --tool la enchufa sin tocar la otra ni bajar nada; uninstall --tool saca sólo esa"
  harness_lab_create "$BASE/lab26"
  harness_lab_release_server
  harness_lab_codex_pieces
  harness_lab_publish_stable 2026.10.07.1
  sha() { shasum -a 256 < "$1" 2>/dev/null | cut -d' ' -f1; }
  applier_runs() { local n; n="$(grep -c '^run check=0' "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log" 2>/dev/null)"; printf '%s' "${n:-0}"; }

  # la máquina nace con Claude Code solo
  harness_lab_tools both; harness_lab_tools_fresh_home
  mkdir -p "$LAB_HOME/.claude"; printf '{\n  "hooks": {}\n}\n' > "$LAB_HOME/.claude/settings.json"; printf '# lo mío\n' > "$LAB_HOME/.claude/CLAUDE.md"
  OUT="$(harness install --version latest --tool claude --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(state "','.join(d['tools'])")" = claude ] && ok "instalada sólo con Claude Code" || bad "la instalación base salió $RC (tools: $(state "d.get('tools')")): $OUT"
  [ ! -e "$CODEX_HOME" ] && ok "sin nada en la carpeta de Codex" || bad "ya hay algo en $CODEX_HOME"
  settings0="$(sha "$TYCON_SETTINGS_PATH")"; claudemd0="$(sha "$CLAUDE_MD_PATH")"; runs0="$(applier_runs)"; asked0="$(requests .)"

  # --dry-run dice qué enchufaría y no escribe
  before="$(harness_lab_home_hash)"
  OUT="$(harness_release install --tool codex --dry-run 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$OUT" in *Codex*) true ;; *) false ;; esac && ok "install --tool codex --dry-run dice que enchufaría a Codex" || bad "--dry-run salió $RC: $OUT"
  [ "$(harness_lab_home_hash)" = "$before" ] && ok "y no escribe nada" || bad "--dry-run escribió"
  # sin --yes y sin terminal: 2, sin escribir
  OUT="$(harness_release install --tool codex 2>&1 </dev/null)"; RC=$?
  [ "$RC" = 2 ] && [ "$(harness_lab_home_hash)" = "$before" ] && ok "sin --yes y sin terminal sale 2 sin escribir" || bad "sin --yes salió $RC: $OUT"

  # Codex llega después: se enchufa sin tocar a Claude Code ni bajar otra versión
  OUT="$(harness_release install --tool codex --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "install --tool codex sale 0" || bad "install --tool codex salió $RC: $OUT"
  [ "$(state "','.join(d['tools'])")" = "claude,codex" ] && ok "el estado dice tools: claude, codex" || bad "tools: $(state "d.get('tools')")"
  [ -f "$CODEX_HOME/hooks.json" ] && grep -q 'TYCON_BLOCK:lab-rules START' "$CODEX_HOME/AGENTS.md" 2>/dev/null && [ -L "$CODEX_HOME/skills/tycon-pipeline" ] && ok "Codex quedó enchufado (hooks, reglas en AGENTS.md, skills)" || bad "Codex a medias: $(ls -A "$CODEX_HOME" 2>&1 | tr '\n' ' ')"
  [ "$(sha "$TYCON_SETTINGS_PATH")" = "$settings0" ] && [ "$(sha "$CLAUDE_MD_PATH")" = "$claudemd0" ] && ok "sin tocar a Claude Code (settings.json y CLAUDE.md, byte a byte)" || bad "tocó los enchufes de Claude Code"
  [ "$(applier_runs)" = "$runs0" ] && ok "y sin correr su aplicador" || bad "corrió el aplicador ($runs0 → $(applier_runs))"
  [ "$(requests .)" = "$asked0" ] && [ "$(state "d['version']['number']")" = 2026.10.07.1 ] && ok "sin bajar otra versión (cero pedidos a la red)" || bad "salió a la red ($asked0 → $(requests .)) o cambió la versión ($(state "d['version']['number']"))"
  case "$OUT" in *"herramientas enchufadas: Claude Code y Codex"*) ok "el cierre dice lo que quedó enchufado" ;; *) bad "el cierre no lo dice: $OUT" ;; esac
  # otra vez: nada que hacer
  hooks1="$(sha "$CODEX_HOME/hooks.json")"; agents1="$(sha "$CODEX_HOME/AGENTS.md")"
  OUT="$(harness_release install --tool codex --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$OUT" in *"ya está"*) true ;; *) false ;; esac && ok "pedirla otra vez: ya está enchufada, sale 0" || bad "la segunda vez salió $RC: $OUT"
  # un valor que no vale
  OUT="$(harness_release install --tool cursor --yes 2>&1)"; RC=$?
  [ "$RC" = 2 ] && ok "install --tool con un valor desconocido sale 2" || bad "install --tool cursor salió $RC: $OUT"

  # uninstall --tool claude: se va sólo lo de Claude Code; Codex y el arnés quedan
  before="$(harness_lab_home_hash)"
  OUT="$(harness_release uninstall --tool claude --dry-run 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(harness_lab_home_hash)" = "$before" ] && case "$OUT" in *"Claude Code"*) true ;; *) false ;; esac && ok "uninstall --tool claude --dry-run dice qué quitaría y no escribe" || bad "--dry-run salió $RC: $OUT"
  OUT="$(harness_release uninstall --tool claude --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "uninstall --tool claude sale 0" || bad "uninstall --tool claude salió $RC: $OUT"
  [ "$(state "','.join(d['tools'])")" = codex ] && ok "el estado dice tools: codex" || bad "tools: $(state "d.get('tools')")"
  [ -z "$(harness_lab_settings_commands)" ] && ! grep -q 'lab-hook' "$TYCON_SETTINGS_PATH" && ok "settings.json quedó sin la línea de arranque y sin los hooks del arnés" || bad "settings.json conserva algo del arnés: $(cat "$TYCON_SETTINGS_PATH")"
  ! grep -q 'TYCON_BLOCK\|^@' "$CLAUDE_MD_PATH" && grep -q 'lo mío' "$CLAUDE_MD_PATH" && ok "CLAUDE.md quedó sin bloques ni @import, con lo de la persona" || bad "CLAUDE.md: $(cat "$CLAUDE_MD_PATH")"
  # el lugar se va; el enlace de las skills SE QUEDA: los enlaces de ~/.codex/skills y los hooks ${SKILLS} de Codex apuntan
  # ahí (sacarlo dejaría a Codex colgado y doctor no lo vería)
  [ ! -e "$LAB_HOME/.claude/$(node -p "require('$ROOT/scripts/setup/harness/tycon-home.js').PLACE_NAME")" ] && [ -L "$LAB_HOME/.claude/agent-skills" ] && ok "sin el lugar en su carpeta, y con el enlace de las skills (lo usa Codex)" || bad "quedaron enlaces: $(ls -la "$LAB_HOME/.claude" | grep -- '->')"
  [ "$(sha "$CODEX_HOME/hooks.json")" = "$hooks1" ] && [ "$(sha "$CODEX_HOME/AGENTS.md")" = "$agents1" ] && [ -L "$CODEX_HOME/skills/tycon-pipeline" ] && ok "Codex quedó intacto (hooks.json y AGENTS.md, byte a byte; skills)" || bad "uninstall --tool claude tocó a Codex"
  [ -f "$LAB_HOME/.tycon/harness/version.json" ] && [ -n "$(harness_lab_state)" ] && ok "y el arnés sigue instalado" || bad "se fue el arnés"
  OUT="$(harness_release doctor 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "doctor queda sano con Codex solo" || bad "doctor salió $RC: $OUT"
  # la que queda es la única: no se saca con --tool
  before="$(harness_lab_home_hash)"
  OUT="$(harness_release uninstall --tool codex --yes 2>&1)"; RC=$?
  [ "$RC" = 2 ] && [ "$(harness_lab_home_hash)" = "$before" ] && ok "sacar la única herramienta enchufada sale 2 sin tocar nada (es uninstall entero)" || bad "uninstall --tool codex (la única) salió $RC: $OUT"
  # una que no está enchufada
  OUT="$(harness_release uninstall --tool claude --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$OUT" in *"no está enchufad"*) true ;; *) false ;; esac && ok "sacar una que no está enchufada: lo dice y sale 0" || bad "uninstall --tool claude (ya sacada) salió $RC: $OUT"
  # y Claude Code vuelve: se re-enchufa sin tocar a Codex
  OUT="$(harness_release install --tool claude --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(state "','.join(d['tools'])")" = "claude,codex" ] && [ -n "$(harness_lab_settings_commands)" ] && ok "install --tool claude lo vuelve a enchufar (línea de arranque y hooks)" || bad "re-enchufar Claude Code salió $RC: $OUT"
  [ "$(sha "$CODEX_HOME/hooks.json")" = "$hooks1" ] && [ "$(sha "$CODEX_HOME/AGENTS.md")" = "$agents1" ] && ok "sin tocar a Codex" || bad "re-enchufar Claude Code tocó a Codex"

  # `install` nunca desenchufa: reinstalar pidiendo una sola deja enchufada la otra, y lo dice (sacar es `uninstall --tool`)
  OUT="$(harness_release install --version latest --tool codex --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(state "','.join(d['tools'])")" = "claude,codex" ] && ok "reinstalar con --tool codex no desenchufa a Claude Code (tools: claude, codex)" || bad "reinstalar con una sola salió $RC, tools: $(state "d.get('tools')"): $OUT"
  OUT="$(harness_release install --version latest --tool codex --dry-run 2>&1)"
  case "$OUT" in *"se conserva"*"Claude Code"*) ok "y el plan dice que la otra se conserva" ;; *) bad "el plan no dice que Claude Code se conserva: $OUT" ;; esac
  [ -n "$(harness_lab_settings_commands)" ] && ok "y Claude Code sigue con su línea de arranque" || bad "reinstalar con --tool codex le sacó la línea de arranque a Claude Code"

  # una máquina que nació sin Claude Code: no se instala desde un clon encima (enchufaría a Claude Code con el estado
  # partido en dos)
  harness_lab_tools both; harness_lab_tools_fresh_home
  OUT="$(harness install --version latest --tool codex --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ -f "$LAB_HOME/.tycon/state/harness-state.json" ] || bad "no pude armar la máquina nacida sin Claude Code: rc=$RC $OUT"
  before="$(harness_lab_home_hash)"
  OUT="$(harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 2 ] && [ "$(harness_lab_home_hash)" = "$before" ] && [ -z "$(harness_lab_claude_home_listing)" ] && ok "ni una instalación desde un clon: sale 2 sin escribir" || bad "install desde un clon sobre una máquina de ~/.tycon salió $RC: $OUT"
  # sumarle Claude Code no espera a la mudanza: en Mac y Linux se instala (lo mide T44)
  OUT="$(harness_release install --tool claude --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(state "','.join(d['tools'])")" = "claude,codex" ] && ok "en una máquina nacida sin Claude Code, install --tool claude lo suma (story 8.150)" || bad "sumar Claude Code a una máquina de ~/.tycon salió $RC: $OUT"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T26b ──────
# Regresiones sobre `install --tool` / `uninstall --tool` / `apply`:
#   · Codex enchufado DESPUÉS (install --tool) se desenchufa de verdad: hooks.json y config.toml sin lo del arnés;
#   · con la llave apagada (`TYCON_CODEX=0 install`) las piezas quedan registradas y `uninstall --tool codex`
#     las quita (el plan lo promete; el comando no puede decir «no está enchufada»);
#   · el aviso «herramienta sin enchufar» se va al enchufar, sin esperar al próximo arranque;
#   · sin config.toml, `apply` lo repone (doctor lo manda y alguien tiene que hacerlo).
if runs T26b; then
  echo "T26b · uninstall --tool codex saca lo enchufado después y lo que la llave dejó de mantener; apply repone config.toml; el aviso se va al enchufar"
  harness_lab_create "$BASE/lab26b"
  harness_lab_release_server
  harness_lab_codex_pieces
  harness_lab_publish_stable 2026.10.07.1
  harness_lab_tools both; harness_lab_tools_fresh_home
  mkdir -p "$LAB_HOME/.claude"; printf '{\n  "hooks": {}\n}\n' > "$LAB_HOME/.claude/settings.json"; printf '# lo mío\n' > "$LAB_HOME/.claude/CLAUDE.md"
  OUT="$(harness install --version latest --tool claude --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "instalada sólo con Claude Code" || bad "la instalación base salió $RC: $OUT"
  # el aviso de Codex sin enchufar está, y se va al enchufar
  harness_release startup >/dev/null 2>&1
  case "$(state "d.get('notice') or ''")" in *"sin enchufar"*) ok "antes de enchufar, el estado avisa «sin enchufar»" ;; *) bad "sin el aviso previo: $(state "d.get('notice')")" ;; esac
  OUT="$(harness_release install --tool codex --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "install --tool codex sale 0" || bad "install --tool codex salió $RC: $OUT"
  case "$(state "d.get('notice') or ''")" in *"sin enchufar"*) bad "el aviso «sin enchufar» sigue después de enchufar: $(state "d.get('notice')")" ;; *) ok "el aviso «sin enchufar» se fue al enchufar" ;; esac
  grep -q 'harness-startup' "$CODEX_HOME/hooks.json" && ok "hooks.json trae los hooks del arnés" || bad "hooks.json sin los hooks del arnés"
  # desenchufar lo enchufado después quita de verdad
  OUT="$(harness_release uninstall --tool codex --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(state "','.join(d['tools'])")" = claude ] && ok "uninstall --tool codex sale 0 y tools queda claude" || bad "uninstall --tool codex salió $RC (tools $(state "d.get('tools')")): $OUT"
  ! grep -q 'harness-startup' "$CODEX_HOME/hooks.json" 2>/dev/null && ok "hooks.json ya no trae los hooks del arnés" || bad "hooks.json conserva los hooks del arnés: $(grep -c harness "$CODEX_HOME/hooks.json" 2>/dev/null) menciones"
  [ "$(state "len([p for p in d.get('managed',[]) if p.get('kind')=='codex'])")" = 0 ] && ok "y el registro quedó sin piezas de Codex" || bad "el registro conserva piezas codex: $(state "[p['id'] for p in d.get('managed',[]) if p.get('kind')=='codex']")"
  # la llave apagada deja las piezas registradas; uninstall --tool las quita igual
  OUT="$(harness_release install --tool codex --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "Codex enchufado otra vez" || bad "re-enchufar salió $RC: $OUT"
  OUT="$(TYCON_CODEX=0 harness_release install --version latest --dry-run 2>&1)"
  case "$OUT" in *"quedan hasta harness.js uninstall --tool codex"*) ok "el plan dice que sus piezas quedan hasta uninstall --tool codex" ;; *) bad "el plan no lo dice: $OUT" ;; esac
  OUT="$(TYCON_CODEX=0 harness_release install --version latest --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(state "','.join(d['tools'])")" = claude ] && ok "con la llave apagada, install deja de mantener a Codex (tools: claude)" || bad "con TYCON_CODEX=0 install salió $RC (tools $(state "d.get('tools')")): $OUT"
  OUT="$(harness_release uninstall --tool codex --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$OUT" in *"no está enchufad"*) false ;; *) true ;; esac && ok "uninstall --tool codex las quita (no dice «no está enchufada»)" || bad "uninstall --tool codex tras la llave apagada: rc $RC: $OUT"
  ! grep -q 'harness-startup' "$CODEX_HOME/hooks.json" 2>/dev/null && ok "hooks.json sin los hooks del arnés" || bad "hooks.json conserva los hooks del arnés"
  # sin config.toml, apply lo repone
  OUT="$(harness_release install --tool codex --yes 2>&1)"; RC=$?
  [ -f "$CODEX_HOME/config.toml" ] && ok "Codex enchufado con config.toml" || bad "sin config.toml tras enchufar: $OUT"
  rm -f "$CODEX_HOME/config.toml"
  OUT="$(harness_release apply 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ -f "$CODEX_HOME/config.toml" ] && ok "apply repuso config.toml" || bad "apply salió $RC y config.toml $([ -f "$CODEX_HOME/config.toml" ] && echo está || echo falta): $OUT"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

if [ "$FAILURES" = 0 ]; then echo "harness-tools: todo verde"; else echo "❌ harness-tools: $FAILURES fallo(s)"; exit 1; fi
