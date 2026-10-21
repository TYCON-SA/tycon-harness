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
  FOUND_LOG="$(find "$LAB_HOME" -name 'lab-applier.log' 2>/dev/null | head -1)"
  [ -z "$FOUND_LOG" ] && ok "el aplicador (el enchufe de Claude Code) no corrió" || bad "corrió el aplicador: $FOUND_LOG"

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

  # una máquina que nació sin Claude Code: sumárselo espera a la mudanza, y lo dice sin escribir
  harness_lab_tools both; harness_lab_tools_fresh_home
  OUT="$(harness install --version latest --tool codex --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ -f "$LAB_HOME/.tycon/state/harness-state.json" ] || bad "no pude armar la máquina nacida sin Claude Code: rc=$RC $OUT"
  before="$(harness_lab_home_hash)"
  OUT="$(harness_release install --tool claude --yes 2>&1)"; RC=$?
  [ "$RC" = 2 ] && [ "$(harness_lab_home_hash)" = "$before" ] && [ -z "$(harness_lab_claude_home_listing)" ] && ok "en una máquina nacida sin Claude Code, install --tool claude sale 2 sin escribir" || bad "sumar Claude Code a una máquina de ~/.tycon salió $RC: $OUT"
  case "$OUT" in *mudanza*) ok "y dice que llega con la mudanza" ;; *) bad "no dice por qué: $OUT" ;; esac
  # tampoco se instala desde un clon encima de esa máquina (enchufaría a Claude Code con el estado partido en dos)
  OUT="$(harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 2 ] && [ "$(harness_lab_home_hash)" = "$before" ] && [ -z "$(harness_lab_claude_home_listing)" ] && ok "ni una instalación desde un clon: sale 2 sin escribir" || bad "install desde un clon sobre una máquina de ~/.tycon salió $RC: $OUT"
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
