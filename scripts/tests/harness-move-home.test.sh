#!/usr/bin/env bash
# harness-move-home.test.sh — la mudanza de cada máquina a `~/.tycon` (story 8.23, tanda D · T27, T28, T29 y T32).
#
# Lo que no se puede perder:
#   T27 · `migrate --to-home` comprueba ANTES de escribir nada: `~/.tycon` libre o nuestro, la versión que se puede bajar
#         y verificar con la credencial, el candado libre; con una falla sale 1 con una línea y la HOME queda idéntica
#         (por hash). `--dry-run` lista lo que mueve, lo que enchufa y lo que deja como enlace, y tampoco escribe.
#   T28 · la mudanza entera: diario desde antes del primer cambio; la versión en `~/.tycon/harness`; el estado, la
#         configuración y el `.dashboard` del clon en `~/.tycon`; los hooks pasan al árbol nuevo (los que nombraban el
#         clon se sacan, la cuenta no cambia); el lugar, el nombre viejo, `agent-skills` y `.tycon-pipeline` quedan
#         como enlaces; el estado se escribe al final; cortada en tres puntos, el arranque siguiente la completa; cortada
#         antes de instalar la versión, la deshace.
#   T29 · el clon de la persona no se toca (hash del `.git` y del árbol), y `paths.maintained` lo declara: `doctor` lo nombra.
#   T32 · la llave `install.home: tycon` del perfil: el arranque migra una vez; una precondición que falla se avisa y se
#         reintenta en cada sesión; un fallo DURANTE deshace, queda `failed` y no se reintenta solo (a mano sí).
#   T28r · la raíz de los repos: si salía de los repos al lado del clon y no estaba declarada, la mudanza la anota en
#         paths.repos; una declarada no se pisa; una carpeta sin otros repos no se anota.
#   T14 · un clon de antes del lector de team-repos.json se muda con una capa que lo trae: la capa se juzga con los lectores
#         de la versión que baja (el plan lo dice); una capa que esa versión rechaza sigue frenando, con la HOME idéntica.
#
# Laboratorio: scripts/tests/lib/harness-lab.sh (la máquina de juguete instalada DESDE UN CLON, con su clon viejo de
# skills, más el servidor de versiones de juguete). Nunca ~/.claude ni ~/.tycon de verdad. 🔴 Sin pipes sobre el comando
# medido.
#
# Uso: bash scripts/tests/harness-move-home.test.sh [--only T27|T28|T28r|T29|T32|T13|T14]
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/scripts/tests/lib/harness-lab.sh"
export TYCON_UPDATE_APPLY=auto
# el arranque corre en el lugar (sin desprenderse): la suite espera su resultado
export TYCON_STARTUP_DETACH=0
ONLY=""; [ "${1:-}" = "--only" ] && ONLY="${2:-}"
runs() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
FAILURES=0
ok()  { echo "  ok   — $1"; }
bad() { echo "  MAL  — $1"; FAILURES=$((FAILURES+1)); }
BASE="$(mktemp -d)"
VIEJO="$(node -p "require('${ROOT}/scripts/setup/harness/place.js').LEGACY_PLACE_NAME")"
PLACE="$(node -p "require('${ROOT}/scripts/setup/harness/place.js').PLACE_NAME")"
case "$BASE" in *"${VIEJO}"*|*agent-skills*|*/.claude*|*/.tycon*) echo "❌ harness-move-home: el laboratorio cayó en ${BASE}"; exit 1 ;; esac
trap 'rm -rf "$BASE"; kill $(jobs -p) 2>/dev/null' EXIT
j() { python3 -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print($2)" "$1" 2>/dev/null; }
OLD_STATE() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"; }
NEW_STATE() { printf '%s' "$LAB_HOME/.tycon/state/harness-state.json"; }
# el estado, esté donde esté (después de la mudanza vive en ~/.tycon/state; antes, donde siempre)
STATE_FILE() { if [ -d "$LAB_HOME/.tycon/state" ]; then NEW_STATE; else OLD_STATE; fi; }
state() { j "$(STATE_FILE)" "$1"; }
LOG() { if [ -d "$LAB_HOME/.tycon/state" ]; then printf '%s' "$LAB_HOME/.tycon/state/harness/startup.log"; else printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness/startup.log"; fi; }
JOURNAL() { printf '%s' "$LAB_HOME/.tycon/migrate.json"; }
NEW_TREE() { printf '%s' "$LAB_HOME/.tycon/harness"; }
link_to() { readlink "$1" 2>/dev/null || true; }
# todos los comandos de hooks de settings.json, uno por línea (todos los eventos)
hook_cmds() {
  python3 -c 'import json,sys
s=json.load(open(sys.argv[1], encoding="utf-8"))
for ev,bs in (s.get("hooks") or {}).items():
    for b in bs:
        for c in b.get("hooks",[]): print(c.get("command",""))' "$TYCON_SETTINGS_PATH"
}
hook_count() { hook_cmds | grep -c . ; }
# cuántos hooks nombran una carpeta (comparando por ruta REAL: el aplicador escribe la ruta como la recibió, /var o /private/var)
hooks_naming() {
  hook_cmds | python3 -c 'import os,re,sys
want=os.path.realpath(sys.argv[1]); n=0
for line in sys.stdin:
    m=re.search(r"\"([^\"]+?)/scripts/hooks/", line) or re.search(r"\"([^\"]+?)/skills/", line)
    if m and os.path.realpath(m.group(1))==want: n+=1
print(n)' "$1"
}
# el hash del clon de la persona: el árbol Y su .git (un fetch, un pull o un reset lo cambian)
clone_hash() { ( cd "$LAB_TREE" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 ) | shasum -a 256 | cut -d' ' -f1; }

# la máquina del equipo de hoy: instalada DESDE EL CLON (el lugar → el clon, el estado en .tycon-pipeline, el clon viejo
# de skills como carpeta real), con el servidor de versiones de juguete listo para la mudanza
clone_machine() {
  harness_lab_create "$1"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.08.1
  harness install --yes >"$1/install.out" 2>&1 || { bad "la instalación desde el clon falló: $(tail -3 "$1/install.out" | tr '\n' ' ')"; return 1; }
  # lo escrito en el árbol por los nocturnos, y una configuración de la máquina
  mkdir -p "$LAB_TREE/.dashboard"; printf '{ "metrica": 1 }\n' > "$LAB_TREE/.dashboard/metrics-2026-10-07.json"
  printf '{ "install": { "profile": "full" }, "integrations": { "clockify": false } }\n' > "$LAB_HOME/.claude/tycon.json"
}

# ───────────────────────────────────────────── T27 ───────────────────────────────────────────�
if runs T27; then
  echo "T27 · las precondiciones: con una falla, 1 y la HOME idéntica; --dry-run lista el plan sin escribir"
  clone_machine "$BASE/lab27"
  [ "$(state "d['sources'][0].get('kind','tree')")" != release ] && ok "la máquina de partida es un clon (kind tree)" || bad "la máquina de partida no es un clon"

  # (a) ~/.tycon con algo que no es nuestro
  mkdir -p "$LAB_HOME/.tycon/otra-cosa"; printf 'ajeno\n' > "$LAB_HOME/.tycon/otra-cosa/nota.txt"
  H0="$(harness_lab_home_hash)"
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 1 ] && ok "~/.tycon ocupado por otra cosa: sale 1" || bad "~/.tycon ocupado: rc $RC: $OUT"
  case "$OUT" in *otra-cosa*) ok "…y nombra lo que encontró" ;; *) bad "no nombra lo ajeno: $OUT" ;; esac
  [ "$(harness_lab_home_hash)" = "$H0" ] && ok "…y la HOME quedó idéntica" || bad "la HOME cambió con ~/.tycon ocupado"
  [ "$(printf '%s\n' "$OUT" | grep -c .)" -le 2 ] && ok "…en una línea (o dos)" || bad "la falla no es una línea: $OUT"
  rm -rf "$LAB_HOME/.tycon/otra-cosa"

  # (b) la versión no verifica (el comprimido viene cambiado)
  harness_lab_release_control '{ "auth": "none", "tamper": true }'
  H0="$(harness_lab_home_hash)"
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 1 ] && ok "la versión que no verifica: sale 1" || bad "versión que no verifica: rc $RC: $OUT"
  [ "$(harness_lab_home_hash)" = "$H0" ] && ok "…y la HOME quedó idéntica (ni incoming/ ni harness/ quedan)" || bad "la HOME cambió con una versión que no verifica: $(cd "$LAB_HOME" && find .tycon 2>/dev/null | head -5 | tr '\n' ' ')"
  harness_lab_release_control '{ "auth": "none" }'

  # (c) sin credencial, repo privado
  harness_lab_release_control '{ "auth": "token:secreto-de-laboratorio" }'
  H0="$(harness_lab_home_hash)"
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 1 ] && ok "sin credencial: sale 1" || bad "sin credencial: rc $RC: $OUT"
  case "$OUT" in *github.token*) ok "…con la única acción (config set github.token)" ;; *) bad "sin la acción de la credencial: $OUT" ;; esac
  [ "$(harness_lab_home_hash)" = "$H0" ] && ok "…y la HOME quedó idéntica" || bad "la HOME cambió sin credencial"
  harness_lab_release_control '{ "auth": "none" }'

  # (d) otra sesión tiene el candado (un dueño vivo: este mismo shell)
  LOCK="$LAB_HOME/.claude/.tycon-pipeline/harness/harness.lock"
  mkdir -p "$LOCK"; printf '{ "pid": %s, "host": "%s", "at": "2026-10-08T00:00:00Z" }\n' "$$" "$(hostname)" > "$LOCK/owner.json"
  H0="$(harness_lab_home_hash)"
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 1 ] && ok "con el candado tomado: sale 1" || bad "candado tomado: rc $RC: $OUT"
  case "$OUT" in *"otra sesión"*) ok "…y dice que otra sesión lo tiene" ;; *) bad "no nombra la otra sesión: $OUT" ;; esac
  [ "$(harness_lab_home_hash)" = "$H0" ] && ok "…y la HOME quedó idéntica" || bad "la HOME cambió con el candado tomado"
  rm -rf "$LOCK"

  # (e) --dry-run: el plan, sin escribir
  H0="$(harness_lab_home_hash)"
  OUT="$(harness migrate --to-home --dry-run 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "--dry-run sale 0" || bad "--dry-run rc $RC: $OUT"
  case "$OUT" in *"mueve:"*".tycon-pipeline"*) ok "el plan dice qué mueve (el estado)" ;; *) bad "el plan no dice qué mueve: $OUT" ;; esac
  case "$OUT" in *"mueve:"*tycon.json*) ok "…y la configuración" ;; *) bad "el plan no nombra la configuración: $OUT" ;; esac
  case "$OUT" in *"copia:"*.dashboard*) ok "…y el .dashboard del clon, copiado" ;; *) bad "el plan no nombra el .dashboard: $OUT" ;; esac
  case "$OUT" in *"enchufa:"*"Claude Code"*) ok "el plan dice qué enchufa (Claude Code)" ;; *) bad "el plan no dice qué enchufa: $OUT" ;; esac
  case "$OUT" in *"enlace:"*"$PLACE"*) ok "el plan dice qué queda como enlace (el lugar)" ;; *) bad "el plan no nombra el lugar como enlace: $OUT" ;; esac
  case "$OUT" in *"enlace:"*agent-skills*) ok "…y agent-skills" ;; *) bad "el plan no nombra agent-skills como enlace: $OUT" ;; esac
  case "$OUT" in *"clon"*"no se toca"*) ok "…y que el clon no se toca" ;; *) bad "el plan no dice que el clon no se toca: $OUT" ;; esac
  [ "$(harness_lab_home_hash)" = "$H0" ] && ok "--dry-run no escribió nada" || bad "--dry-run escribió en la HOME"
  # (f) con Codex enchufado, el plan anticipa que va a pedir aprobar sus hooks (AC 28)
  python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['tools']=['claude','codex']; json.dump(d, open(p,'w'), indent=2)" "$(OLD_STATE)"
  OUT="$(harness migrate --to-home --dry-run 2>&1)"
  case "$OUT" in *"enchufa:"*"Codex te va a pedir aprobar sus hooks"*) ok "con Codex enchufado, el plan anticipa la re-aprobación de sus hooks" ;; *) bad "el plan no anticipa la re-aprobación de Codex: $OUT" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T28 ───────────────────────────────────────────�
if runs T28; then
  echo "T28 · la mudanza: diario, todo en ~/.tycon, hooks al árbol nuevo (misma cuenta), enlaces viejos; cortada, el arranque completa o deshace"
  clone_machine "$BASE/lab28"
  CLONE_REAL="$(cd "$LAB_TREE" && pwd -P)"
  N0="$(hook_count)"
  [ "$(hooks_naming "$CLONE_REAL")" -ge 1 ] && ok "antes: algún hook nombra el clon ($N0 hooks)" || bad "antes: ningún hook nombra el clon: $(hook_cmds | tr '\n' ' ')"
  [ -d "$LAB_HOME/.claude/agent-skills/.git" ] && ok "antes: agent-skills es una carpeta real (el clon viejo de skills)" || bad "antes: agent-skills no es un clon real"
  # el clon que la máquina mantiene, ya declarado: ~/.tycon/config.json existe ANTES de la mudanza (como con github.token)
  printf '%s' "$LAB_TREE" | harness config set paths.maintained >/dev/null 2>&1 || bad "config set paths.maintained falló"

  # ── (1) cortada en tres puntos: el arranque siguiente la completa ──
  for STAGE in installed state-moved links; do
    OUT="$(TYCON_MIGRATE_DIE_AT="$STAGE" harness migrate --to-home 2>&1)"; RC=$?
    [ "$RC" = 137 ] && ok "cortada justo después de «${STAGE}» (rc 137, como un kill -9)" || bad "el corte en ${STAGE} no cortó: rc ${RC}: ${OUT}"
    [ -f "$(JOURNAL)" ] && ok "…el diario quedó (etapa $(j "$(JOURNAL)" "d['stage']"))" || bad "sin diario tras el corte en $STAGE"
    OUT="$(harness startup 2>&1)"; RC=$?
    [ "$RC" = 0 ] && ok "el arranque siguiente sale 0" || bad "el arranque tras el corte en $STAGE: rc $RC: $OUT"
    [ ! -e "$(JOURNAL)" ] && ok "…y el diario se cerró" || bad "el diario sigue tras el arranque (etapa $(j "$(JOURNAL)" "d['stage']"))"
    [ "$(state "d['sources'][0]['kind']")" = release ] && ok "…la máquina quedó release (la mudanza se completó)" || bad "tras el corte en $STAGE la máquina no quedó release: $(cat "$(STATE_FILE)" 2>/dev/null | head -c 300)"
    grep -q "mudanza" "$(LOG)" && ok "…y el registro lo cuenta" || bad "el registro no habla de la mudanza"
    # la máquina vuelve a ser un clon para el corte siguiente: se rearma el laboratorio
    [ "$STAGE" = links ] || { kill "$LAB_RELEASE_PROCESS" 2>/dev/null; clone_machine "$BASE/lab28-$STAGE"; CLONE_REAL="$(cd "$LAB_TREE" && pwd -P)"; N0="$(hook_count)"; printf '%s' "$LAB_TREE" | harness config set paths.maintained >/dev/null 2>&1; }
  done
  # desde acá la máquina es la del último corte (links), completada por el arranque: se mide el resultado entero
  [ -f "$(NEW_TREE)/version.json" ] && [ "$(j "$(NEW_TREE)/version.json" "d['version']")" = 2026.10.08.1 ] && ok "la versión 2026.10.08.1 vive en ~/.tycon/harness" || bad "~/.tycon/harness no trae la versión: $(ls "$(NEW_TREE)" 2>/dev/null | head -5 | tr '\n' ' ')"
  [ -f "$(NEW_STATE)" ] && [ ! -L "$LAB_HOME/.tycon/state" ] && ok "el estado vive en ~/.tycon/state" || bad "el estado no está en ~/.tycon/state"
  [ "$(state "d['tree']")" = "$(NEW_TREE)" ] && ok "el estado apunta al árbol nuevo" || bad "el estado apunta a $(state "d['tree']")"
  [ -L "$LAB_HOME/.claude/.tycon-pipeline" ] && [ "$(cd "$LAB_HOME/.claude/.tycon-pipeline" && pwd -P)" = "$(cd "$LAB_HOME/.tycon/state" && pwd -P)" ] && ok "~/.claude/.tycon-pipeline es un enlace al estado nuevo" || bad ".tycon-pipeline no es un enlace al estado: $(link_to "$LAB_HOME/.claude/.tycon-pipeline")"
  [ -L "$LAB_HOME/.claude/$PLACE" ] && [ "$(cd "$LAB_HOME/.claude/$PLACE" && pwd -P)" = "$(cd "$(NEW_TREE)" && pwd -P)" ] && ok "el lugar ~/.claude/$PLACE es un enlace a ~/.tycon/harness" || bad "el lugar apunta a $(link_to "$LAB_HOME/.claude/$PLACE")"
  [ -L "$LAB_HOME/.claude/agent-skills" ] && [ "$(cd "$LAB_HOME/.claude/agent-skills" && pwd -P)" = "$(cd "$(NEW_TREE)" && pwd -P)" ] && ok "~/.claude/agent-skills es un enlace a ~/.tycon/harness" || bad "agent-skills apunta a $(link_to "$LAB_HOME/.claude/agent-skills")"
  ls -d "$LAB_HOME"/.claude/agent-skills.before-migrate-* >/dev/null 2>&1 && ok "…y el clon viejo de skills quedó apartado al lado, no borrado" || bad "el clon viejo de skills no quedó apartado"
  # la configuración: fundida, con lo que ya estaba en ~/.tycon/config.json intacto; la vieja, un enlace
  [ "$(j "$LAB_HOME/.tycon/config.json" "d['install']['profile']")" = full ] && [ "$(j "$LAB_HOME/.tycon/config.json" "d['integrations']['clockify']")" = False ] && ok "~/.tycon/config.json trae lo de ~/.claude/tycon.json" || bad "la configuración no se fundió: $(cat "$LAB_HOME/.tycon/config.json" 2>/dev/null)"
  [ "$(j "$LAB_HOME/.tycon/config.json" "d['paths']['maintained']")" = "$LAB_TREE" ] && ok "…y conserva lo que ya tenía (paths.maintained)" || bad "paths.maintained se perdió en la fusión: $(cat "$LAB_HOME/.tycon/config.json" 2>/dev/null)"
  [ -L "$LAB_HOME/.claude/tycon.json" ] && [ "$(j "$LAB_HOME/.claude/tycon.json" "d['install']['profile']")" = full ] && ok "~/.claude/tycon.json quedó como enlace a la nueva" || bad "tycon.json viejo: $(ls -l "$LAB_HOME/.claude/tycon.json" 2>&1)"
  # el .dashboard copiado, el clon intacto
  [ -f "$LAB_HOME/.tycon/state/dashboard/metrics-2026-10-07.json" ] && [ -f "$LAB_TREE/.dashboard/metrics-2026-10-07.json" ] && ok "el .dashboard del clon se copió a ~/.tycon/state/dashboard y el clon lo conserva" || bad "el .dashboard no se copió o el clon lo perdió"
  # los hooks: misma cuenta, ninguno nombra el clon, el del arnés nombra el árbol nuevo
  N1="$(hook_count)"
  [ "$N1" = "$N0" ] && ok "la cuenta de hooks no cambió ($N0)" || bad "la cuenta de hooks cambió: $N0 → $N1: $(hook_cmds | tr '\n' ' ')"
  [ "$(hooks_naming "$CLONE_REAL")" = 0 ] && ok "ningún hook nombra el clon" || bad "quedan hooks que nombran el clon: $(hook_cmds | tr '\n' ' ')"
  [ "$(hooks_naming "$(NEW_TREE)")" -ge 1 ] && ok "el hook del arnés nombra ~/.tycon/harness" || bad "ningún hook nombra el árbol nuevo: $(hook_cmds | tr '\n' ' ')"
  # el estado y la salud
  [ "$(state "d.get('failed')")" = None ] && ok "sin failed" || bad "failed: $(state "d.get('failed')")"
  OUT="$(harness doctor --json 2>&1)"; RC=$?
  F="$(printf '%s' "$OUT" | python3 -c "import json,sys; print(' | '.join(json.load(sys.stdin).get('fail',[])))" 2>/dev/null)"
  [ "$RC" = 0 ] && [ -z "$F" ] && ok "doctor en verde" || bad "doctor: rc $RC: ${F:-$OUT}"
  OUT="$(harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(state "d['sources'][0]['kind']")" = release ] && ok "un arranque más: sigue release y sale 0" || bad "el arranque tras la mudanza: rc $RC: $OUT"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null

  # ── (2) camino feliz entero, sin cortes: el estado se escribe al final y la salida cuenta ──
  clone_machine "$BASE/lab28b"
  CLONE_REAL="$(cd "$LAB_TREE" && pwd -P)"
  M0="$(stat -f %m "$(OLD_STATE)" 2>/dev/null || stat -c %Y "$(OLD_STATE)")"
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "migrate --to-home sale 0" || bad "migrate --to-home rc $RC: $OUT"
  case "$OUT" in *"arnés mudado a"*) ok "…y lo dice" ;; *) bad "la salida no dice que se mudó: $OUT" ;; esac
  case "$OUT" in *paths.maintained*) ok "…y recuerda cómo declarar el clon que se mantiene" ;; *) bad "la salida no habla de paths.maintained: $OUT" ;; esac
  [ ! -e "$(JOURNAL)" ] && ok "sin diario al terminar" || bad "quedó el diario: $(cat "$(JOURNAL)")"
  [ "$(state "d['sources'][0]['kind']")" = release ] && [ "$(state "d['version']['number']")" = 2026.10.08.1 ] && ok "release 2026.10.08.1" || bad "estado: $(cat "$(STATE_FILE)" | head -c 300)"
  grep -q '"stage": "start"' "$(LOG)" 2>/dev/null || grep -q "mudanza: diario" "$(LOG)" && ok "el registro anota el diario antes del primer cambio" || bad "el registro no anota el diario: $(grep mudanza "$(LOG)" | head -3)"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null

  # ── (3) cortada ANTES de instalar la versión: el arranque deshace ──
  clone_machine "$BASE/lab28c"
  OUT="$(TYCON_MIGRATE_DIE_AT=start harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 137 ] && [ -f "$(JOURNAL)" ] && ok "cortada en «start»: el diario quedó" || bad "el corte en start: rc $RC, diario $([ -f "$(JOURNAL)" ] && echo sí || echo no)"
  OUT="$(harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "el arranque siguiente sale 0" || bad "arranque tras el corte en start: rc $RC: $OUT"
  [ ! -e "$(JOURNAL)" ] && [ ! -e "$LAB_HOME/.tycon/state" ] && [ ! -e "$(NEW_TREE)" ] && ok "…deshizo: sin diario, sin ~/.tycon/state, sin ~/.tycon/harness" || bad "no deshizo: $(cd "$LAB_HOME" && find .tycon 2>/dev/null | head -8 | tr '\n' ' ')"
  [ "$(j "$(OLD_STATE)" "d['sources'][0].get('kind','tree')")" != release ] && [ -d "$LAB_HOME/.claude/.tycon-pipeline" ] && [ ! -L "$LAB_HOME/.claude/.tycon-pipeline" ] && ok "…la máquina sigue siendo un clon, con su estado donde estaba" || bad "la máquina no volvió a ser un clon"
  grep -q "mudanza.*desh" "$(LOG)" && ok "…y el registro dice que deshizo" || bad "el registro no dice que deshizo: $(grep mudanza "$(LOG)" | head -3)"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T28x ──────────────────────────────────────────
# T41 (story 8.23, tanda F · AC 40): lo PERSONAL de la carpeta vieja de agent-skills (lo que no es del arnés ni de terceros)
# queda activo después de la mudanza: ~/.claude/skills y ~/.claude/agents pasan a carpetas reales con lo personal adentro y un
# enlace por entrada del arnés al lado; el plan lo dice («conserva N skills y M agentes tuyos: …»); cortada en la etapa
# `personal`, el arranque la completa; cortada antes de instalar, deshace y los enlaces viejos vuelven.
if runs T28x; then
  echo "T28x · lo personal de la carpeta vieja queda activo: carpetas reales + un enlace por entrada del arnés; el plan lo dice; cortada completa o deshace"
  # lo que un dev tiene en su carpeta vieja: el laboratorio ya pone skills/lab-own (sin versionar) y skills/lab-third-party
  # (ignorada por git; como NO está en third-party-skills.json, cuenta personal); se suman una skill, .trash y un agente
  personal_entries() { # personal_entries <carpeta vieja de agent-skills>
    mkdir -p "$1/skills/mi-skill" "$1/skills/.trash/vieja" "$1/agents" "$1/skills/lab-own" "$1/skills/lab-third-party"
    [ -f "$1/skills/lab-own/SKILL.md" ] || printf '# skill propia del dev, sin versionar\n' > "$1/skills/lab-own/SKILL.md"
    [ -f "$1/skills/lab-third-party/SKILL.md" ] || printf '# skill de terceros: ignorada por git, pero no está en el manifiesto\n' > "$1/skills/lab-third-party/SKILL.md"
    printf '# mi skill\n' > "$1/skills/mi-skill/SKILL.md"; printf '# vieja, en la papelera\n' > "$1/skills/.trash/vieja/SKILL.md"
    printf '# mi agente\n' > "$1/agents/mi-agente.md"
  }
  personal_hash() { # personal_hash <raíz> → sha de cada archivo personal, para comparar antes y después
    ( cd "$1" && find skills/mi-skill skills/.trash skills/lab-own skills/lab-third-party agents/mi-agente.md -type f 2>/dev/null | sort | while IFS= read -r f; do printf '%s %s\n' "$f" "$(shasum -a 256 < "$f" | cut -c1-16)"; done )
  }
  # la máquina de un dev: el arnés de juguete trae skills/ y agents/ (como el repo único, para que exista «el enlace por
  # entrada del arnés»), la carpeta vieja trae lo personal, y ~/.claude/skills y ~/.claude/agents son enlaces que pasan por ella
  clone_machine_f() { # clone_machine_f <dir>
    harness_lab_create "$1"
    mkdir -p "$LAB_AUTHOR_TREE/skills/tycon-pipeline" "$LAB_AUTHOR_TREE/agents"
    printf '# skill del arnés (juguete)\n' > "$LAB_AUTHOR_TREE/skills/tycon-pipeline/SKILL.md"
    printf '# revisor del arnés (juguete)\n' > "$LAB_AUTHOR_TREE/agents/lab-revisor.md"
    harness_lab_git "$LAB_AUTHOR_TREE" add -A >/dev/null 2>&1 && harness_lab_git "$LAB_AUTHOR_TREE" commit -q -m "lab: skills/ y agents/ en el árbol (el repo único)" >/dev/null 2>&1 && harness_lab_git "$LAB_AUTHOR_TREE" push -q origin main >/dev/null 2>&1 || { bad "no pude dar skills/ y agents/ al arnés de juguete"; return 1; }
    harness_lab_pull_tree || { bad "el clon de la máquina no trajo skills/ y agents/"; return 1; }
    harness_lab_release_server
    harness_lab_publish_stable 2026.10.08.1
    harness install --yes >"$1/install.out" 2>&1 || { bad "la instalación desde el clon falló: $(tail -3 "$1/install.out" | tr '\n' ' ')"; return 1; }
    mkdir -p "$LAB_TREE/.dashboard"; printf '{ "metrica": 1 }\n' > "$LAB_TREE/.dashboard/metrics-2026-10-07.json"
    printf '{ "install": { "profile": "full" }, "integrations": { "clockify": false } }\n' > "$LAB_HOME/.claude/tycon.json"
    OLD_SKILLS="$LAB_HOME/.claude/agent-skills"
    personal_entries "$OLD_SKILLS"
    rm -f "$LAB_HOME/.claude/skills" "$LAB_HOME/.claude/agents"
    ln -s "$OLD_SKILLS/skills" "$LAB_HOME/.claude/skills"; ln -s "$OLD_SKILLS/agents" "$LAB_HOME/.claude/agents"
  }
  clone_machine_f "$BASE/lab28x"
  H_BEFORE="$(personal_hash "$OLD_SKILLS")"
  [ -L "$LAB_HOME/.claude/skills" ] && [ -L "$LAB_HOME/.claude/agents" ] && ok "antes: ~/.claude/skills y ~/.claude/agents son enlaces que pasan por la carpeta vieja" || bad "antes: skills/agents no son enlaces: $(ls -ld "$LAB_HOME/.claude/skills" "$LAB_HOME/.claude/agents" 2>&1 | tr '\n' ' ')"
  [ -d "$LAB_TREE/skills/tycon-pipeline" ] && [ -d "$LAB_TREE/agents" ] && ok "antes: el arnés de juguete trae skills/ y agents/ (como el repo único)" || bad "antes: el arnés de juguete no trae skills/agents"
  # (a) el plan lo dice, sin escribir
  H0="$(harness_lab_home_hash)"
  OUT="$(harness migrate --to-home --dry-run 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "--dry-run sale 0" || bad "--dry-run rc $RC: $OUT"
  case "$OUT" in *"conserva 4 skills y 1 agente tuyos"*) ok "el plan dice «conserva 4 skills y 1 agente tuyos» (.trash, lab-own, lab-third-party, mi-skill · mi-agente.md)" ;; *) bad "el plan no cuenta lo personal: $(printf '%s\n' "$OUT" | grep -i conserva || echo "(sin línea conserva)")" ;; esac
  case "$OUT" in *"mi-skill"*"mi-agente.md"*) ok "…y nombra cada entrada" ;; *) bad "el plan no nombra lo personal: $(printf '%s\n' "$OUT" | grep -i conserva)" ;; esac
  case "$OUT" in *"carpetas reales"*"un enlace por entrada"*) ok "…y dice cómo quedan (carpetas reales, un enlace por entrada del arnés)" ;; *) bad "el plan no dice cómo quedan: $(printf '%s\n' "$OUT" | grep -i conserva)" ;; esac
  [ "$(harness_lab_home_hash)" = "$H0" ] && ok "…sin escribir nada" || bad "--dry-run escribió"
  # (b) cortada justo después de «personal»: el arranque completa y lo personal está activo
  OUT="$(TYCON_MIGRATE_DIE_AT=personal harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 137 ] && [ "$(j "$(JOURNAL)" "d['stage']")" = personal ] && ok "cortada justo después de «personal» (rc 137, diario en personal)" || bad "el corte en personal: rc $RC, etapa $(j "$(JOURNAL)" "d['stage']" 2>/dev/null): $OUT"
  OUT="$(harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ ! -e "$(JOURNAL)" ] && [ "$(state "d['sources'][0]['kind']")" = release ] && ok "el arranque siguiente completa la mudanza (release, sin diario)" || bad "el arranque tras el corte en personal: rc $RC, diario $([ -e "$(JOURNAL)" ] && echo sí || echo no): $OUT"
  check_personal_active() { # lo personal como carpetas reales con el mismo contenido; el arnés al lado como enlaces por entrada
    [ -d "$LAB_HOME/.claude/skills" ] && [ ! -L "$LAB_HOME/.claude/skills" ] && [ -d "$LAB_HOME/.claude/agents" ] && [ ! -L "$LAB_HOME/.claude/agents" ] && ok "~/.claude/skills y ~/.claude/agents son carpetas reales" || bad "skills/agents no son carpetas reales: $(ls -ld "$LAB_HOME/.claude/skills" "$LAB_HOME/.claude/agents" 2>&1 | tr '\n' ' ')"
    for e in skills/mi-skill skills/.trash skills/lab-own skills/lab-third-party agents/mi-agente.md; do
      [ -e "$LAB_HOME/.claude/$e" ] && [ ! -L "$LAB_HOME/.claude/$e" ] || bad "lo personal no está activo como real: $e ($(ls -ld "$LAB_HOME/.claude/$e" 2>&1))"
    done
    [ "$(personal_hash "$LAB_HOME/.claude")" = "$H_BEFORE" ] && ok "…con el mismo contenido (sha de cada archivo), y las cinco entradas personales activas" || bad "el contenido personal cambió o falta: $(diff <(printf '%s\n' "$H_BEFORE") <(personal_hash "$LAB_HOME/.claude") | head -4 | tr '\n' ' ')"
    ASIDE="$(ls -d "$LAB_HOME"/.claude/agent-skills.before-migrate-* 2>/dev/null | head -1)"
    [ -n "$ASIDE" ] && [ ! -e "$ASIDE/skills/mi-skill" ] && [ ! -e "$ASIDE/agents/mi-agente.md" ] && ok "…y no quedan duplicadas en la carpeta apartada (movidas, no copiadas)" || bad "lo personal quedó también en la carpeta apartada: $(ls "$ASIDE/skills" "$ASIDE/agents" 2>&1 | tr '\n' ' ')"
    [ -L "$LAB_HOME/.claude/skills/tycon-pipeline" ] && [ "$(cd "$LAB_HOME/.claude/skills/tycon-pipeline" && pwd -P)" = "$(cd "$(NEW_TREE)/skills/tycon-pipeline" && pwd -P)" ] && ok "la skill del arnés está al lado como enlace por entrada a ~/.tycon/harness" || bad "tycon-pipeline no es un enlace por entrada al árbol nuevo: $(ls -ld "$LAB_HOME/.claude/skills/tycon-pipeline" 2>&1)"
    [ "$(find "$LAB_HOME/.claude/agents" -mindepth 1 -maxdepth 1 -type l | wc -l | tr -d ' ')" -ge 1 ] && ok "los revisores del arnés están al lado como enlaces por entrada" || bad "ningún enlace por entrada en ~/.claude/agents: $(ls -la "$LAB_HOME/.claude/agents" | head -5 | tr '\n' ' ')"
  }
  check_personal_active
  OUT="$(harness doctor --json 2>&1)"; RC=$?
  F="$(printf '%s' "$OUT" | python3 -c "import json,sys; print(' | '.join(json.load(sys.stdin).get('fail',[])))" 2>/dev/null)"
  [ "$RC" = 0 ] && [ -z "$F" ] && ok "doctor en verde con lo personal al lado" || bad "doctor: rc $RC: ${F:-$OUT}"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
  # (c) camino feliz entero: la salida cuenta lo conservado; una carpeta real previa en ~/.claude/skills no se pisa
  clone_machine_f "$BASE/lab28x2"
  rm "$LAB_HOME/.claude/skills"; mkdir -p "$LAB_HOME/.claude/skills/otra"; printf '# ya estaba acá\n' > "$LAB_HOME/.claude/skills/otra/SKILL.md"
  mkdir -p "$OLD_SKILLS/skills/otra"; printf '# la de la carpeta vieja con el mismo nombre\n' > "$OLD_SKILLS/skills/otra/SKILL.md"
  OUT="$(harness migrate --to-home --dry-run 2>&1)"
  case "$OUT" in *"conserva 6 skills y 1 agente tuyos"*"otra (ya en su lugar)"*) ok "con una carpeta real previa: el plan cuenta lo suyo como «ya en su lugar»" ;; *) bad "el plan con carpeta real previa: $(printf '%s\n' "$OUT" | grep -i conserva)" ;; esac
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "migrate --to-home sale 0" || bad "migrate rc $RC: $OUT"
  case "$OUT" in *"conservadas 4 skills y 1 agente tuyos"*) ok "la salida cuenta lo conservado (4 skills y 1 agente: la «otra» de la vieja no se movió)" ;; *) bad "la salida no cuenta lo conservado: $OUT" ;; esac
  case "$OUT" in *"no se pisaron: skills/otra"*) ok "…y dice que «otra» ya existía y no se pisó" ;; *) bad "la salida no dice lo no pisado: $OUT" ;; esac
  [ "$(cat "$LAB_HOME/.claude/skills/otra/SKILL.md")" = "# ya estaba acá" ] && ok "la carpeta real previa quedó como estaba" || bad "«otra» fue pisada: $(cat "$LAB_HOME/.claude/skills/otra/SKILL.md")"
  ASIDE="$(ls -d "$LAB_HOME"/.claude/agent-skills.before-migrate-* 2>/dev/null | head -1)"
  [ -f "$ASIDE/skills/otra/SKILL.md" ] && grep -q "carpeta vieja" "$ASIDE/skills/otra/SKILL.md" && ok "…y la «otra» de la carpeta vieja (el choque dentro del movimiento) sigue en la carpeta apartada, intacta" || bad "la «otra» de la vieja no quedó en la apartada: $(ls "$ASIDE/skills" 2>&1 | tr '\n' ' ')"
  [ -d "$LAB_HOME/.claude/skills/mi-skill" ] && [ -L "$LAB_HOME/.claude/skills/tycon-pipeline" ] && ok "lo personal activo y el arnés al lado también con la carpeta real previa" || bad "con carpeta real previa: $(ls -la "$LAB_HOME/.claude/skills" | tr '\n' ' ')"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
  # (d) cortada ANTES de instalar: deshace, y los enlaces viejos de skills/agents vuelven (lo personal sigue en la carpeta vieja)
  clone_machine_f "$BASE/lab28x3"
  L_SK="$(link_to "$LAB_HOME/.claude/skills")"; L_AG="$(link_to "$LAB_HOME/.claude/agents")"
  OUT="$(TYCON_MIGRATE_DIE_AT=links harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 137 ] && ok "cortada justo después de «links» (antes de lo personal)" || bad "el corte en links: rc $RC: $OUT"
  # un fallo DURANTE lo personal se simula con ~/.claude/skills convertido en un ARCHIVO antes del arranque: la etapa no puede
  # crear la carpeta → la mudanza COMPLETA sin pisarlo: lo personal de ese lado queda en la carpeta apartada y lo dice
  rm -f "$LAB_HOME/.claude/skills"; printf 'un archivo en el lugar de skills\n' > "$LAB_HOME/.claude/skills"
  OUT="$(harness startup 2>&1)"; RC=$?
  [ ! -e "$(JOURNAL)" ] && ok "el arranque cerró el diario (completó o deshizo)" || bad "quedó el diario tras el arranque: $(cat "$(JOURNAL)" | head -c 300)"
  if [ "$(state "d['sources'][0]['kind']")" = release ]; then
    [ -f "$LAB_HOME/.claude/skills" ] && ok "con un archivo en el lugar de skills la mudanza completó sin pisarlo (lo personal de skills queda en la carpeta apartada y lo dice)" || bad "el archivo en el lugar de skills fue pisado"
    grep -q "no es una carpeta: lo personal de skills queda" "$(LOG)" && ok "…y el registro lo dice" || bad "el registro no dice que skills no es una carpeta: $(grep -i personal "$(LOG)" | head -3)"
    [ -d "$LAB_HOME/.claude/agents" ] && [ ! -L "$LAB_HOME/.claude/agents" ] && [ -f "$LAB_HOME/.claude/agents/mi-agente.md" ] && ok "…mientras que agents sí quedó activo" || bad "agents no quedó activo: $(ls -la "$LAB_HOME/.claude/agents" 2>&1 | head -4 | tr '\n' ' ')"
  else
    bad "tras el arranque la máquina no quedó release ni deshecha de forma limpia: $(cat "$(STATE_FILE)" | head -c 200)"
  fi
  rm -f "$LAB_HOME/.claude/skills"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
  # (e) deshacer de verdad: una mudanza que falla DESPUÉS de mover lo personal (la salud en rojo) vuelve lo personal a la carpeta vieja
  clone_machine_f "$BASE/lab28x4"
  L_SK="$(link_to "$LAB_HOME/.claude/skills")"
  OUT="$(TYCON_MIGRATE_FAIL_AFTER=personal harness migrate --to-home 2>&1)"; RC=$?
  if [ "$RC" = 1 ]; then
    ok "con un fallo justo después de mover lo personal, la mudanza sale 1"
    [ -L "$LAB_HOME/.claude/skills" ] && [ "$(link_to "$LAB_HOME/.claude/skills")" = "$L_SK" ] && ok "…y ~/.claude/skills volvió a ser el enlace de antes" || bad "skills no volvió a ser el enlace: $(ls -ld "$LAB_HOME/.claude/skills")"
    [ -d "$OLD_SKILLS/skills/mi-skill" ] && [ -f "$OLD_SKILLS/agents/mi-agente.md" ] && [ -d "$OLD_SKILLS/.git" ] && ok "…lo personal volvió a la carpeta vieja, que volvió a su lugar" || bad "lo personal no volvió: $(ls "$OLD_SKILLS/skills" 2>&1 | tr '\n' ' ')"
    grep -q "tuyo(s) vuelven a" "$(LOG)" && ok "…y el registro lo cuenta" || bad "el registro no cuenta la vuelta de lo personal: $(grep -i tuyo "$(LOG)" | head -3)"
  else
    bad "el fallo de prueba tras «personal» no hizo fallar la mudanza (rc $RC): $OUT"
  fi
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
  # (f) deshacer con una carpeta real PREVIA en ~/.claude/skills: lo suyo queda como estaba y los enlaces por entrada que
  # puso la mudanza se sacan (apuntarían a una versión que ya no está); los que no puso ella no se tocan
  clone_machine_f "$BASE/lab28x5"
  rm "$LAB_HOME/.claude/skills"; mkdir -p "$LAB_HOME/.claude/skills/otra"; printf '# ya estaba acá\n' > "$LAB_HOME/.claude/skills/otra/SKILL.md"
  ln -s "$LAB_HOME/.claude/tycon.json" "$LAB_HOME/.claude/skills/enlace-ajeno"   # un enlace que no es del arnés, puesto por la persona
  OUT="$(TYCON_MIGRATE_FAIL_AFTER=personal harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 1 ] && ok "con carpeta real previa, el fallo tras «personal» sale 1" || bad "rc $RC: $OUT"
  [ -d "$LAB_HOME/.claude/skills" ] && [ ! -L "$LAB_HOME/.claude/skills" ] && [ "$(cat "$LAB_HOME/.claude/skills/otra/SKILL.md")" = "# ya estaba acá" ] && ok "…la carpeta real previa sigue siendo real y con lo suyo" || bad "la carpeta previa cambió: $(ls -la "$LAB_HOME/.claude/skills" 2>&1 | tr '\n' ' ')"
  [ -L "$LAB_HOME/.claude/skills/enlace-ajeno" ] && ok "…el enlace ajeno que ya estaba sigue" || bad "el enlace ajeno fue sacado"
  [ ! -e "$LAB_HOME/.claude/skills/tycon-pipeline" ] && [ ! -L "$LAB_HOME/.claude/skills/tycon-pipeline" ] && ok "…y el enlace por entrada que puso la mudanza (tycon-pipeline → ~/.tycon/harness) se sacó: no quedan enlaces colgados" || bad "quedó el enlace por entrada de la mudanza: $(ls -ld "$LAB_HOME/.claude/skills/tycon-pipeline" 2>&1)"
  [ ! -d "$LAB_HOME/.claude/skills/mi-skill" ] && [ -d "$OLD_SKILLS/skills/mi-skill" ] && ok "…lo personal volvió a la carpeta vieja" || bad "mi-skill: en skills $([ -d "$LAB_HOME/.claude/skills/mi-skill" ] && echo sí || echo no), en la vieja $([ -d "$OLD_SKILLS/skills/mi-skill" ] && echo sí || echo no)"
  [ "$(find "$LAB_HOME/.claude/skills" "$LAB_HOME/.claude/agents" -maxdepth 1 -type l ! -exec test -e {} \; -print 2>/dev/null | wc -l | tr -d ' ')" = 0 ] && ok "…sin enlaces colgados en ~/.claude/skills ni ~/.claude/agents" || bad "quedaron enlaces colgados: $(find "$LAB_HOME/.claude/skills" "$LAB_HOME/.claude/agents" -maxdepth 1 -type l ! -exec test -e {} \; -print 2>/dev/null | tr '\n' ' ')"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
  # (g) una carpeta real previa con una entrada PROPIA que se llama como una del arnés (tycon-pipeline): la regla del
  # enlace por entrada no la pisa, y el aviso llega a la SALIDA FINAL de la mudanza, no sólo al registro
  clone_machine_f "$BASE/lab28x6"
  rm "$LAB_HOME/.claude/skills"; mkdir -p "$LAB_HOME/.claude/skills/tycon-pipeline"; printf '# la mía, con el nombre del arnés\n' > "$LAB_HOME/.claude/skills/tycon-pipeline/SKILL.md"
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "con una entrada propia que se llama como una del arnés, la mudanza sale 0" || bad "rc $RC: $OUT"
  [ "$(cat "$LAB_HOME/.claude/skills/tycon-pipeline/SKILL.md")" = "# la mía, con el nombre del arnés" ] && [ ! -L "$LAB_HOME/.claude/skills/tycon-pipeline" ] && ok "…la entrada propia no se pisó (sigue real)" || bad "tycon-pipeline propia pisada: $(ls -ld "$LAB_HOME/.claude/skills/tycon-pipeline")"
  case "$OUT" in *"lo personal quedó activo, pero"*"no las piso: skills/tycon-pipeline"*) ok "…y la salida final avisa que la del arnés con ese nombre no se ve (no sólo el registro)" ;; *) bad "la salida no trae el aviso del choque: $OUT" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
  # (h) (pase adversarial, clases 2 y 11) ~/.claude/skills es un enlace a una carpeta PROPIA del dev: no se toca, lo suyo sigue
  # activo, lo personal de la carpeta vieja va adentro, y el plan lo dice
  clone_machine_f "$BASE/lab28x7"
  mkdir -p "$LAB_HOME/mis-skills/propia"; printf '# la mía, en mi carpeta\n' > "$LAB_HOME/mis-skills/propia/SKILL.md"
  rm "$LAB_HOME/.claude/skills"; ln -s "$LAB_HOME/mis-skills" "$LAB_HOME/.claude/skills"
  OUT="$(harness migrate --to-home --dry-run 2>&1)"
  case "$OUT" in *"tu carpeta, por el enlace"*"propia (ya en su lugar)"*) ok "el plan reconoce tu carpeta propia y cuenta lo tuyo como ya en su lugar" ;; *) bad "el plan con carpeta propia: $(printf '%s\n' "$OUT" | grep -i conserva)" ;; esac
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "con tu carpeta propia enlazada, la mudanza sale 0" || bad "rc $RC: $OUT"
  [ -L "$LAB_HOME/.claude/skills" ] && [ "$(link_to "$LAB_HOME/.claude/skills")" = "$LAB_HOME/mis-skills" ] && ok "…el enlace a tu carpeta propia sigue intacto" || bad "el enlace a la carpeta propia cambió: $(ls -ld "$LAB_HOME/.claude/skills")"
  [ -f "$LAB_HOME/mis-skills/propia/SKILL.md" ] && [ -d "$LAB_HOME/mis-skills/mi-skill" ] && [ ! -L "$LAB_HOME/mis-skills/mi-skill" ] && ok "…lo tuyo sigue y lo personal de la carpeta vieja quedó adentro de tu carpeta" || bad "la carpeta propia: $(ls -la "$LAB_HOME/mis-skills" | tr '\n' ' ')"
  [ -L "$LAB_HOME/mis-skills/tycon-pipeline" ] && ok "…y el arnés al lado, también adentro de tu carpeta (un enlace por entrada)" || bad "sin enlace por entrada en la carpeta propia: $(ls -la "$LAB_HOME/mis-skills" | tr '\n' ' ')"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
  # (i) (clase 6) en una carpeta real previa hay un enlace por entrada que apunta a la carpeta vieja (quedaría colgado al
  # apartarla): no cuenta como «ya existe», se reemplaza por lo personal real
  clone_machine_f "$BASE/lab28x8"
  rm "$LAB_HOME/.claude/skills"; mkdir -p "$LAB_HOME/.claude/skills"; ln -s "$OLD_SKILLS/skills/mi-skill" "$LAB_HOME/.claude/skills/mi-skill"
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ -d "$LAB_HOME/.claude/skills/mi-skill" ] && [ ! -L "$LAB_HOME/.claude/skills/mi-skill" ] && [ -f "$LAB_HOME/.claude/skills/mi-skill/SKILL.md" ] && ok "un enlace por entrada a la carpeta vieja se reemplaza por lo personal real (no queda colgado ni cuenta como «ya existe»)" || bad "el enlace viejo a mi-skill no se reemplazó (rc $RC): $(ls -ld "$LAB_HOME/.claude/skills/mi-skill" 2>&1) $OUT"
  case "$OUT" in *"no se pisaron: skills/mi-skill"*) bad "la salida cuenta mi-skill como no pisada, pero era un enlace colgado" ;; *) ok "…y la salida no la cuenta como «ya existía»" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
  # (j) (clase 7) TODO lo personal choca con algo real en el destino: nada se mueve, y la salida final igual lo DICE
  clone_machine_f "$BASE/lab28x9"
  rm -rf "$OLD_SKILLS/skills/.trash" "$OLD_SKILLS/skills/lab-own" "$OLD_SKILLS/skills/lab-third-party" "$OLD_SKILLS/agents/mi-agente.md"   # queda sólo mi-skill
  rm "$LAB_HOME/.claude/skills"; mkdir -p "$LAB_HOME/.claude/skills/mi-skill"; printf '# otra mi-skill, ya acá\n' > "$LAB_HOME/.claude/skills/mi-skill/SKILL.md"
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "con todo lo personal chocando, la mudanza sale 0" || bad "rc $RC: $OUT"
  case "$OUT" in *"⚠️ lo tuyo ya existían en el destino y no se pisaron: skills/mi-skill"*) ok "…y la salida final dice que no se pisó, aunque no se haya movido nada" ;; *) bad "la salida no dice lo no pisado cuando nada se movió: $OUT" ;; esac
  [ "$(cat "$LAB_HOME/.claude/skills/mi-skill/SKILL.md")" = "# otra mi-skill, ya acá" ] && ok "…y lo que estaba quedó como estaba" || bad "mi-skill del destino pisada"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T28y ──────────────────────────────────────────
# T44 (story 8.23, tanda G · AC 41): el perfil del equipo que el clon trae (perfil-equipo.json en su raíz) pasa a
# ~/.tycon/config.json como valores de la máquina: la versión bajada no lo trae y la primera máquina migrada (2026-10-08)
# quedó con las integraciones, el paquete por defecto y la política de fábrica. Se mide con el lector de configuración ANTES
# (desde el clon) y DESPUÉS (desde ~/.tycon/harness): los mismos valores, con el origen «perfil» convertido en «maquina».
# El laboratorio pone el perfil por variable (TYCON_PROFILE): acá se vacía después de crear el laboratorio, para que el
# perfil se lea del árbol que corre, como en una máquina del equipo.
if runs T28y; then
  echo "T28y · el perfil del equipo del clon pasa a ~/.tycon/config.json: explain igual antes y después; el plan lo dice; el fallo lo repone"
  team_profile() { # team_profile <clon>
    printf '{ "ado": { "org": "https://dev.azure.com/acme" }, "integrations": { "clockify": true, "engram": true, "nightly": true, "codex": "detect" }, "update": { "channel": "latest", "apply": "auto", "source": "internal" }, "packs": { "default": "all" }, "install": { "profile": "full" } }\n' > "$1/perfil-equipo.json"
  }
  clone_machine_g() { # clone_machine_g <dir> — la máquina del equipo con el perfil EN SU CLON y sin perfil por variable
    harness_lab_create "$1"
    export TYCON_PROFILE=
    team_profile "$LAB_TREE"
    harness_lab_release_server
    harness_lab_publish_stable 2026.10.08.1
    harness install --yes >"$1/install.out" 2>&1 || { bad "la instalación desde el clon falló: $(tail -3 "$1/install.out" | tr '\n' ' ')"; return 1; }
    printf '{ "integrations": { "clockify": false } }\n' > "$LAB_HOME/.claude/tycon.json"
  }
  # lo que viaja, leído con el lector del árbol dado: «clave=valor origen», una por línea
  explain_keys() { # explain_keys <árbol>
    node "$1/scripts/lib/tycon-config.js" explain --json 2>/dev/null | python3 -c '
import json,sys
d=json.load(sys.stdin); v=d["valores"]; o=d["origenes"]
for k in ["ado.org","integraciones.clockify","integraciones.engram","integraciones.nightly","integraciones.codex","update.channel","update.apply","packs.default","install.profile"]:
    s,c=k.split("."); print("%s=%s %s" % (k, json.dumps(v[s][c]), o[k]))'
  }
  clone_machine_g "$BASE/lab28y"
  BEFORE="$(explain_keys "$LAB_TREE")"
  case "$BEFORE" in *"integraciones.engram=true perfil"*"update.channel=\"latest\" perfil"*"packs.default=\"all\" perfil"*) ok "antes: el clon lee el perfil del equipo (engram, canal latest, packs all con origen perfil)" ;; *) bad "antes: el clon no lee su perfil: $(printf '%s' "$BEFORE" | tr '\n' ' ')" ;; esac
  case "$BEFORE" in *"integraciones.clockify=false maquina"*) ok "antes: clockify apagada por la máquina (le gana al perfil)" ;; *) bad "antes: clockify: $BEFORE" ;; esac
  # (a) el plan lo dice, sin escribir
  H0="$(harness_lab_home_hash)"
  OUT="$(harness migrate --to-home --dry-run 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "--dry-run sale 0" || bad "--dry-run rc $RC: $OUT"
  case "$OUT" in *"perfil del equipo: "*"perfil-equipo.json → "*"config.json, como valores de la máquina"*) ok "el plan tiene su línea «perfil del equipo: … → ~/.tycon/config.json, como valores de la máquina»" ;; *) bad "el plan no habla del perfil: $OUT" ;; esac
  for w in "ado.org" "engram" "nightly" "codex detect" "canal latest" "aplicación auto" "paquete del stack all" "perfil full"; do
    case "$OUT" in *"$w"*) : ;; *) bad "el plan no nombra «${w}»: $(printf '%s\n' "$OUT" | grep -i 'perfil del equipo')" ;; esac
  done
  case "$OUT" in *"ya tenías: clockify (gana lo tuyo)"*) ok "…nombra lo que la máquina ya tenía (clockify: gana lo tuyo)" ;; *) bad "el plan no dice lo que ya tenía: $(printf '%s\n' "$OUT" | grep -i 'perfil del equipo')" ;; esac
  case "$OUT" in *"no viajan: update.source"*) ok "…y lo que no viaja (update.source)" ;; *) bad "el plan no dice lo que no viaja: $(printf '%s\n' "$OUT" | grep -i 'perfil del equipo')" ;; esac
  case "$OUT" in *"canal latest):"*) ok "el canal del plan es el vigente de la máquina (latest, del perfil)" ;; *) bad "el canal del plan no es latest: $(printf '%s\n' "$OUT" | head -1)" ;; esac
  [ "$(harness_lab_home_hash)" = "$H0" ] && ok "…sin escribir nada" || bad "--dry-run escribió"
  # (b) el camino feliz: explain igual antes y después; doctor dice lo mismo que antes
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "migrate --to-home sale 0" || bad "migrate rc $RC: $OUT"
  case "$OUT" in *"perfil del equipo: 8 valores pasaron a "*"config.json"*) ok "la salida cuenta los valores que pasaron (8)" ;; *) bad "la salida no cuenta el perfil: $OUT" ;; esac
  AFTER="$(explain_keys "$(NEW_TREE)")"
  [ "$(printf '%s\n' "$BEFORE" | sed 's/ perfil$/ maquina/')" = "$AFTER" ] && ok "después: el lector del árbol nuevo da los MISMOS valores, con origen maquina en vez de perfil" || bad "antes/después difieren:$(diff <(printf '%s\n' "$BEFORE" | sed 's/ perfil$/ maquina/') <(printf '%s\n' "$AFTER") | tr '\n' ' ')"
  [ "$(j "$LAB_HOME/.tycon/config.json" "d['integrations']['clockify']")" = False ] && [ "$(j "$LAB_HOME/.tycon/config.json" "d['update'].get('source')")" = None ] && ok "clockify sigue false (gana lo tuyo) y update.source no se escribió" || bad "config.json: $(cat "$LAB_HOME/.tycon/config.json")"
  OUT="$(harness doctor --json 2>&1)"; RC=$?
  F="$(printf '%s' "$OUT" | python3 -c "import json,sys; print(' | '.join(json.load(sys.stdin).get('fail',[])))" 2>/dev/null)"
  [ "$RC" = 0 ] && [ -z "$F" ] && ok "doctor en verde" || bad "doctor: rc $RC: ${F:-$OUT}"
  [ "$(printf '%s' "$OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['integrations']['engram']['state'], d['integrations']['nightly']['state'], d['integrations']['ado']['state'], d['packs']['value'])" 2>/dev/null)" = "prendida prendida prendida all" ] && ok "doctor: engram, nightly y ado prendidas y el paquete del stack all, como antes de mudar" || bad "doctor dice otra cosa: $(printf '%s' "$OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['integrations'], d['packs'])" 2>/dev/null)"
  # (la aplicación la fija el laboratorio por variable —TYCON_UPDATE_APPLY=auto— y la variable sigue ganando: se mira el canal)
  [ "$(printf '%s' "$OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(any('política: canal latest (maquina) · aplicación auto' in o for o in d['ok']))" 2>/dev/null)" = True ] && ok "doctor: la política sigue latest + auto (el canal, ahora de la máquina)" || bad "doctor: la política cambió: $(printf '%s' "$OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print([o for o in d['ok'] if 'política' in o])" 2>/dev/null)"
  [ "$(printf '%s' "$OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(any('integraciones:' in o and '(~/.tycon/config.json)' in o for o in d['ok']))" 2>/dev/null)" = True ] && ok "doctor rotula el archivo de la máquina por su ruta real (~/.tycon/config.json)" || bad "doctor rotula mal el archivo: $(printf '%s' "$OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print([o for o in d['ok'] if 'integraciones' in o])" 2>/dev/null)"
  [ "$(printf '%s' "$OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(any(o.startswith('perfil: full (~/.tycon/config.json)') for o in d['ok']))" 2>/dev/null)" = True ] && ok "doctor: el perfil de instalación con el mismo rótulo (perfil: full (~/.tycon/config.json))" || bad "doctor: el rótulo del perfil: $(printf '%s' "$OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print([o for o in d['ok'] if o.startswith('perfil')])" 2>/dev/null)"
  # el canal que quedó en el estado al terminar es el del plan (latest), y la línea de la versión no dice «el estado todavía dice»
  [ "$(state "d['channel']")" = latest ] && ok "el estado quedó con el canal del plan (latest)" || bad "el estado quedó con canal $(state "d['channel']")"
  [ "$(printf '%s' "$OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(any(o.startswith('versión bajada') and 'canal latest' in o and 'todavía dice' not in o for o in d['ok']))" 2>/dev/null)" = True ] && ok "doctor: la línea de la versión dice canal latest, sin estado atrasado" || bad "doctor: la línea de la versión: $(printf '%s' "$OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print([o for o in d['ok'] if o.startswith('versión')])" 2>/dev/null)"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
  # (c) un fallo justo después de fundir: la configuración propia vuelve EXACTAMENTE a como estaba (acá existía: traía el
  # permiso de GitHub) y la vieja también; y el diario con ese texto se escribió sólo para el usuario
  clone_machine_g "$BASE/lab28yb"
  printf '%s' "permiso-lab-28y" | harness config set github.token >/dev/null 2>&1 || bad "config set github.token falló"
  CFG0="$(cat "$LAB_HOME/.tycon/config.json")"
  OUT="$(TYCON_MIGRATE_FAIL_AFTER=config-moved harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 1 ] && ok "con un fallo tras «config-moved», la mudanza sale 1" || bad "el fallo tras config-moved: rc $RC: $OUT"
  [ "$(cat "$LAB_HOME/.tycon/config.json")" = "$CFG0" ] && ok "…y ~/.tycon/config.json volvió byte a byte a como estaba (el permiso, sin el perfil)" || bad "config.json tras el fallo: $(cat "$LAB_HOME/.tycon/config.json")"
  [ ! -L "$LAB_HOME/.claude/tycon.json" ] && [ "$(j "$LAB_HOME/.claude/tycon.json" "d['integrations']['clockify']")" = False ] && ok "…y ~/.claude/tycon.json volvió a ser el archivo de antes" || bad "tycon.json: $(ls -l "$LAB_HOME/.claude/tycon.json" 2>&1)"
  [ "$(state "d['sources'][0].get('kind','tree')")" != release ] && ok "…la máquina sigue siendo un clon" || bad "la máquina quedó release tras el fallo"
  grep -q "diario .*migrate.json" "$(LOG)" && ok "…el diario se escribió (y se cerró)" || bad "el registro no habla del diario"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
  # el modo del diario: se mira en una corrida cortada justo después de anotarlo (queda en el disco)
  clone_machine_g "$BASE/lab28yd"
  printf '%s' "permiso-lab-28y" | harness config set github.token >/dev/null 2>&1
  TYCON_MIGRATE_DIE_AT=start harness migrate --to-home >/dev/null 2>&1
  PERM="$(python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777)[2:])' "$(JOURNAL)" 2>/dev/null)"
  [ "$PERM" = 600 ] && ok "el diario de la mudanza (que guarda el texto de config.json, con el permiso) queda 0600" || bad "el diario quedó con permisos $PERM"
  harness startup >/dev/null 2>&1
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
  # (d) un perfil ROTO en el clon: precondición fallida, 1, HOME idéntica; sin perfil: «nada que pasar» y la mudanza sigue
  clone_machine_g "$BASE/lab28yc"
  printf '{ "integrations": { "engram": "si" } }\n' > "$LAB_TREE/perfil-equipo.json"
  H0="$(harness_lab_home_hash)"
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 1 ] && ok "con el perfil roto sale 1" || bad "perfil roto: rc $RC: $OUT"
  case "$OUT" in *perfil-equipo.json*engram*|*engram*perfil-equipo.json*) ok "…y nombra el archivo y la clave" ;; *) bad "no nombra el perfil roto: $OUT" ;; esac
  [ "$(harness_lab_home_hash)" = "$H0" ] && ok "…y la HOME quedó idéntica" || bad "la HOME cambió con el perfil roto"
  rm -f "$LAB_TREE/perfil-equipo.json"
  OUT="$(harness migrate --to-home --dry-run 2>&1)"
  case "$OUT" in *"perfil del equipo: el clon no trae team-profile.json (ni perfil-equipo.json, el nombre de antes) — nada que pasar"*) ok "sin perfil, el plan lo dice y sigue" ;; *) bad "sin perfil el plan dice otra cosa: $(printf '%s\n' "$OUT" | grep -i perfil)" ;; esac
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(state "d['sources'][0]['kind']")" = release ] && ok "sin perfil la mudanza completa igual" || bad "sin perfil: rc $RC: $OUT"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T28r ──────────────────────────────────────────
# La raíz de los repos (2026-10-14): una máquina sin raíz declarada la deducía de los repos al lado del clon. Mudado el
# arnés a ~/.tycon, al lado no hay nada y la máquina quedó «sin raíz» (el aviso diario de engram dejó de chequear). La
# mudanza anota esa carpeta en paths.repos si la raíz salía de ahí y no estaba declarada; con una raíz declarada no la
# pisa; y una carpeta sin otros repos no se anota.
if runs T28r; then
  echo "T28r · la raíz de los repos: la mudanza anota la carpeta del clon si de ahí salía; no pisa una declarada; no anota una carpeta sin repos"
  unset TYCON_REPOS_ROOT   # la raíz explícita del que corre la suite no entra al laboratorio
  same_dir() { python3 -c 'import os,sys; sys.exit(0 if os.path.realpath(sys.argv[1])==os.path.realpath(sys.argv[2]) else 1)' "$1" "$2"; }
  clone_machine "$BASE/lab28r"
  CLONES="$(dirname "$LAB_TREE")"
  # (a) el clon solo en su carpeta: nada que anotar
  OUT="$(harness migrate --to-home --dry-run 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "(a) --dry-run sale 0" || bad "(a) --dry-run rc $RC: $OUT"
  case "$OUT" in *"→ paths.repos"*) bad "(a) con el clon solo en su carpeta el plan anota una raíz sin repos: $(printf '%s\n' "$OUT" | grep 'raíz de repos')" ;; *) ok "(a) con el clon solo en su carpeta el plan no anota raíz (sería una carpeta sin repos)" ;; esac
  # (b) un repo de trabajo al lado del clon: la raíz salía de ahí → el plan lo dice y la mudanza la anota
  mkdir -p "$CLONES/ProductoA" && git -C "$CLONES/ProductoA" init -q
  OUT="$(harness migrate --to-home --dry-run 2>&1)"; RC=$?
  case "$OUT" in *"raíz de repos: "*"→ paths.repos"*) ok "(b) con un repo al lado del clon, el plan dice que anota la raíz en paths.repos" ;; *) bad "(b) el plan no anota la raíz: $(printf '%s\n' "$OUT" | grep 'raíz de repos' || echo '(sin línea)')" ;; esac
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "(b) migrate --to-home sale 0" || bad "(b) migrate rc $RC: $OUT"
  W="$(j "$LAB_HOME/.tycon/config.json" "d['paths']['repos']")"
  [ -n "$W" ] && same_dir "$W" "$CLONES" && ok "(b) ~/.tycon/config.json trae paths.repos = la carpeta del clon" || bad "(b) paths.repos no quedó: «${W}» (config: $(python3 -c 'import json,sys; print(sorted(json.load(open(sys.argv[1])).get("paths",{}).keys()))' "$LAB_HOME/.tycon/config.json" 2>&1))"
  [ "$(j "$LAB_HOME/.tycon/config.json" "d['install']['profile']")" = full ] && ok "(b) …sin perder lo demás de la configuración" || bad "(b) la configuración perdió install.profile"
  case "$OUT" in *"raíz de repos: "*"anotada en"*) ok "(b) la salida lo cuenta" ;; *) bad "(b) la salida no cuenta la raíz anotada: $OUT" ;; esac
  OUT="$(HOME="$LAB_HOME" node "$(NEW_TREE)/scripts/lib/repos-root.js" < /dev/null 2>&1)"
  case "$OUT" in *"fuente: el archivo de la máquina"*) ok "(b) después de mudar, repos-root la lee del archivo de la máquina" ;; *) bad "(b) repos-root después de mudar: $OUT" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
  # (c) una raíz ya declarada no se pisa
  clone_machine "$BASE/lab28r2"
  CLONES="$(dirname "$LAB_TREE")"
  mkdir -p "$CLONES/ProductoA" && git -C "$CLONES/ProductoA" init -q
  DECL="$BASE/lab28r2/mis-repos"; mkdir -p "$DECL"
  printf '{ "install": { "profile": "full" }, "paths": { "repos": "%s" } }\n' "$DECL" > "$LAB_HOME/.claude/tycon.json"
  OUT="$(harness migrate --to-home --dry-run 2>&1)"
  case "$OUT" in *"raíz de repos: ya declarada"*) ok "(c) con la raíz declarada, el plan dice que no se toca" ;; *) bad "(c) el plan con la raíz declarada: $(printf '%s\n' "$OUT" | grep 'raíz de repos' || echo '(sin línea)')" ;; esac
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(j "$LAB_HOME/.tycon/config.json" "d['paths']['repos']")" = "$DECL" ] && ok "(c) la mudanza deja la raíz declarada como estaba" || bad "(c) rc $RC, paths.repos = $(j "$LAB_HOME/.tycon/config.json" "d['paths'].get('repos')")"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T29 ───────────────────────────────────────────�
if runs T29; then
  echo "T29 · el clon de la persona no se toca, y declarado como el que se mantiene, doctor lo nombra"
  clone_machine "$BASE/lab29"
  C0="$(clone_hash)"
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 0 ] || bad "migrate --to-home rc $RC: $OUT"
  [ "$(clone_hash)" = "$C0" ] && ok "el clon (árbol y .git) quedó idéntico" || bad "el clon cambió"
  [ -d "$LAB_TREE/.git" ] && ok "…y sigue donde estaba" || bad "el clon ya no está en $LAB_TREE"
  OUT="$(harness doctor 2>&1)"
  case "$OUT" in *"sin clon declarado"*paths.maintained*) ok "doctor: sin clon declarado, dice cómo declararlo" ;; *) bad "doctor no habla del clon mantenido: $OUT" ;; esac
  printf '%s' "$LAB_TREE" | harness config set paths.maintained >/dev/null 2>&1 || bad "config set paths.maintained falló"
  OUT="$(harness doctor 2>&1)"
  case "$OUT" in *"clon que esta máquina mantiene"*"$LAB_TREE"*) ok "doctor nombra el clon que la máquina mantiene" ;; *) bad "doctor no nombra el clon mantenido: $OUT" ;; esac
  [ "$(clone_hash)" = "$C0" ] && ok "…y doctor tampoco lo tocó" || bad "doctor cambió el clon"
  # el freno de producción de ANTES de la mudanza (AC 30): instalado desde un clon, su origen fijado no trae `repo`; anda por
  # los enlaces y doctor pide reinstalarlo. Con el freno nuevo (con `repo`), nada que decir. Raíz de sistema falsa (TYCON_PROD_ROOT)
  SYS="$BASE/lab29/sys"; mkdir -p "$SYS/opt/tycon/hooks" "$SYS/opt/tycon/production"; printf '// freno\n' > "$SYS/opt/tycon/hooks/prod-access-guard.js"
  printf '{ "url": "https://dev.azure.com/acme/x/_git/x", "org": "https://dev.azure.com/acme", "fijado": "2026-09-15T00:00:00Z" }\n' > "$SYS/opt/tycon/production/trusted-origin.json"
  OUT="$(TYCON_PROD_ROOT="$SYS" harness doctor 2>&1)"
  case "$OUT" in *"freno de producción instalado"*"anterior a la mudanza"*install-guard.sh*) ok "doctor: el freno viejo sigue por los enlaces y pide reinstalarlo (con el comando)" ;; *) bad "doctor no habla del freno viejo: $OUT" ;; esac
  printf '{ "url": "https://github.com/lab-org/arnes-lab", "org": "github:lab-org/arnes-lab", "repo": "lab-org/arnes-lab", "fijado": "2026-10-08T00:00:00Z" }\n' > "$SYS/opt/tycon/production/trusted-origin.json"
  OUT="$(TYCON_PROD_ROOT="$SYS" harness doctor 2>&1)"
  case "$OUT" in *"anterior a la mudanza"*) bad "doctor sigue hablando del freno viejo con el freno nuevo instalado" ;; *) ok "con el freno reinstalado (origen con repo), doctor no dice nada del freno" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T32 ───────────────────────────────────────────�
if runs T32; then
  echo "T32 · install.home: tycon en el perfil: el arranque migra una vez; la precondición reintenta; el fallo durante queda failed"
  clone_machine "$BASE/lab32"
  # (0) la llave en `claude` (o sin valor): el arranque no muda nada ni lo intenta; una llave ROTA se dice y tampoco muda
  printf '{ "install": { "profile": "full", "home": "claude" } }\n' > "$LAB/lab-profile.json"
  harness startup >/dev/null 2>&1
  [ "$(state "d['sources'][0].get('kind','tree')")" != release ] && [ "$(grep -c "mudanza" "$(LOG)")" = 0 ] && ok "install.home: claude — el arranque no muda ni lo intenta" || bad "con install.home claude: kind=$(state "d['sources'][0].get('kind','tree')") log=$(grep mudanza "$(LOG)" | head -2)"
  printf '{ "install": { "profile": "full", "home": "casa" } }\n' > "$LAB/lab-profile.json"
  harness startup >/dev/null 2>&1
  [ "$(state "d['sources'][0].get('kind','tree')")" != release ] && grep -q "install.home no se pudo leer" "$(LOG)" && ok "install.home rota: no muda y el registro dice por qué" || bad "con install.home rota: kind=$(state "d['sources'][0].get('kind','tree')") log=$(grep -i "install.home" "$(LOG)" | head -2)"
  # el perfil del equipo con la llave prendida
  printf '{ "install": { "profile": "full", "home": "tycon" } }\n' > "$LAB/lab-profile.json"

  # (a) sin credencial: la precondición falla, se avisa, y se reintenta en la sesión siguiente
  harness_lab_release_control '{ "auth": "token:secreto-de-laboratorio" }'
  OUT="$(harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "arranque sin credencial: sale 0" || bad "arranque sin credencial: rc $RC: $OUT"
  [ "$(state "d['sources'][0].get('kind','tree')")" != release ] && ok "…no migró" || bad "migró sin credencial"
  case "$(state "d.get('notice')")" in *mudanza*github.token*|*github.token*mudanza*) ok "…y el aviso dice la acción (github.token)" ;; *) bad "el aviso no habla de la mudanza ni de la credencial: $(state "d.get('notice')")" ;; esac
  [ "$(state "d.get('migrate_home')")" = None ] && ok "…sin marcar failed (una precondición no es un fallo)" || bad "marcó migrate_home: $(state "d.get('migrate_home')")"
  harness startup >/dev/null 2>&1
  [ "$(grep -c "mudanza" "$(LOG)")" -ge 2 ] && ok "la sesión siguiente lo volvió a intentar" || bad "no reintentó: $(grep mudanza "$(LOG)")"

  # (b) con la credencial (repo público): migra sola, una vez
  harness_lab_release_control '{ "auth": "none" }'
  OUT="$(harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(state "d['sources'][0]['kind']")" = release ] && ok "con la credencial el arranque migró solo" || bad "el arranque no migró: rc $RC: $OUT · $(cat "$(STATE_FILE)" | head -c 300)"
  [ -f "$(NEW_STATE)" ] && ok "…el estado en ~/.tycon/state" || bad "el estado no está en ~/.tycon/state"
  case "$(state "d.get('notice')")" in *mudanza*) bad "el aviso de la mudanza se arrastra: $(state "d.get('notice')")" ;; *) ok "…y el aviso de la precondición se fue" ;; esac
  N="$(grep -c "mudanza: la máquina pasó a" "$(LOG)")"
  harness startup >/dev/null 2>&1
  [ "$(grep -c "mudanza: la máquina pasó a" "$(LOG)")" = "$N" ] && ok "una máquina release no vuelve a migrar" || bad "volvió a migrar"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null

  # (c) un fallo DURANTE (el aplicador del árbol nuevo falla): deshace, queda failed, no se reintenta solo; a mano sí
  clone_machine "$BASE/lab32c"
  printf '{ "install": { "profile": "full", "home": "tycon" } }\n' > "$LAB/lab-profile.json"
  OUT="$(LAB_APPLIER_FAIL=1 harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "arranque con el aplicador roto: sale 0" || bad "arranque con el aplicador roto: rc $RC: $OUT"
  [ "$(j "$(OLD_STATE)" "d['sources'][0].get('kind','tree')")" != release ] && [ ! -e "$LAB_HOME/.tycon/state" ] && ok "…la mudanza se deshizo: la máquina sigue siendo un clon" || bad "no se deshizo: $(cd "$LAB_HOME" && find .tycon -maxdepth 1 2>/dev/null | tr '\n' ' ')"
  [ "$(j "$(OLD_STATE)" "d['migrate_home']['status']")" = failed ] && ok "…y quedó failed" || bad "sin failed: $(j "$(OLD_STATE)" "d.get('migrate_home')")"
  case "$(j "$(OLD_STATE)" "d.get('notice')")" in *mudanza*) ok "…con su aviso" ;; *) bad "sin aviso de la mudanza fallida: $(j "$(OLD_STATE)" "d.get('notice')")" ;; esac
  N="$(grep -c "mudanza: diario" "$(LOG)")"
  harness startup >/dev/null 2>&1
  [ "$(grep -c "mudanza: diario" "$(LOG)")" = "$N" ] && [ "$(j "$(OLD_STATE)" "d['sources'][0].get('kind','tree')")" != release ] && ok "la sesión siguiente NO reintentó sola" || bad "reintentó sola tras el fallo"
  OUT="$(harness doctor 2>&1)"
  case "$OUT" in *mudanza*fall*) ok "doctor muestra la mudanza fallida" ;; *) bad "doctor no muestra la mudanza fallida: $OUT" ;; esac
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(state "d['sources'][0]['kind']")" = release ] && ok "a mano sí: migrate --to-home sale 0 y la máquina es release" || bad "a mano: rc $RC: $OUT"
  [ "$(state "d.get('migrate_home')")" = None ] || [ "$(state "d['migrate_home']['status']")" = done ] && ok "…y el failed se limpió" || bad "migrate_home sigue: $(state "d.get('migrate_home')")"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ══ T13 (story 8.25, AC 13): la mudanza con repo del equipo ═══════════════════════════════════════════════════════════
# El repo del equipo sale de `--team` o de la clave `team` del public-repos.json del clon; el plan lo dice; sin acceso, la
# mudanza no arranca (1, HOME idéntica); con la capa apilada, el perfil del clon NO se funde en ~/.tycon/config.json (el
# profileFold de la G queda `skipped`), explain lee ado.org con origen perfil, y el estado trae team con el commit.
if runs T13; then
  echo "T13 · la mudanza con el repo del equipo: la clave del clon o --team, el plan, sin acceso 1, la capa apilada y el perfil sin fundir"
  team_profile_13() { printf '{ "ado": { "org": "https://dev.azure.com/acme" }, "integrations": { "clockify": true, "engram": true, "nightly": true }, "update": { "channel": "latest", "apply": "auto", "source": "internal" }, "packs": { "default": "all" }, "install": { "profile": "full" } }\n' > "$1/perfil-equipo.json"; }
  explain_key() { # explain_key <árbol> <sección> <clave>  → «valor origen»
    node "$1/scripts/lib/tycon-config.js" explain --json 2>/dev/null | python3 -c '
import json,sys
d=json.load(sys.stdin); s,c=sys.argv[1],sys.argv[2]; print("%s %s" % (json.dumps(d["valores"][s][c]), d["origenes"]["%s.%s" % (s,c)]))' "$2" "$3"
  }
  harness_lab_create "$BASE/lab13"
  export TYCON_PROFILE=
  team_profile_13 "$LAB_TREE"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.08.1
  harness_lab_team_repo
  harness_lab_team_server
  harness install --yes >"$BASE/lab13/install.out" 2>&1 || bad "la instalación desde el clon falló: $(tail -3 "$BASE/lab13/install.out" | tr '\n' ' ')"
  # (a) --team mal formado: 2, sin escribir, antes de la red
  H0="$(harness_lab_home_hash)"
  OUT="$(harness migrate --to-home --dry-run --team sin-barra 2>&1)"; RC=$?
  [ "$RC" = 2 ] && ok "--team sin forma sale 2" || bad "--team sin forma: rc $RC: $OUT"
  case "$OUT" in *"org/nombre"*) ok "…diciendo la forma" ;; *) bad "no dice la forma: $OUT" ;; esac
  # (b) sin repo del equipo declarado en ningún lado: el plan funde el perfil (lo de la tanda G), sin línea de capa
  OUT="$(harness migrate --to-home --dry-run 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "sin equipo: --dry-run sale 0" || bad "sin equipo: rc $RC: $OUT"
  case "$OUT" in *"capa del equipo"*) bad "sin equipo declarado el plan habla de la capa: $OUT" ;; *"como valores de la máquina"*) ok "sin equipo: el plan funde el perfil (tanda G)" ;; *) bad "sin equipo: el plan no funde el perfil: $OUT" ;; esac
  # (c) la clave `team` del clon: el plan nombra la capa y dice que el perfil no se funde; sin escribir
  harness_lab_team_set_clone_key
  OUT="$(harness migrate --to-home --dry-run 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "con la clave del clon: --dry-run sale 0" || bad "con la clave: rc $RC: $OUT"
  case "$OUT" in *"capa del equipo $LAB_TEAM @ "*"2 archivo(s)"*) ok "el plan nombra la capa con el valor de la clave y sus 2 archivos" ;; *) bad "el plan no nombra la capa: $OUT" ;; esac
  case "$OUT" in *"perfil del equipo: viaja en la capa del equipo ($LAB_TEAM), no se funde"*) ok "el plan dice que el perfil viaja en la capa y no se funde" ;; *) bad "el plan no dice que el perfil no se funde: $OUT" ;; esac
  case "$OUT" in *"como valores de la máquina"*) bad "el plan sigue fundiendo el perfil con capa: $OUT" ;; *) ok "…y no habla de fundirlo" ;; esac
  [ "$(harness_lab_home_hash)" = "$H0" ] && ok "--dry-run no escribió nada" || bad "--dry-run escribió"
  # (d) repo del equipo mudo (el permiso no lo ve): la mudanza no arranca, 1, HOME idéntica
  harness_lab_release_control "{ \"auth\": \"none\", \"auth_by_repo\": { \"$LAB_TEAM\": \"token:permiso-equipo-13\" } }"
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 1 ] && ok "sin acceso al repo del equipo: migrate sale 1" || bad "sin acceso: rc $RC: $OUT"
  case "$OUT" in *"$LAB_TEAM"*"no está o no se ve"*) ok "…nombrando el repo del equipo que no se ve" ;; *) bad "no nombra el repo que no se ve: $OUT" ;; esac
  case "$OUT" in *"Contents: read sobre los repos "*"$LAB_TEAM"*) ok "…y la acción nombra los dos repos" ;; *) bad "la acción no nombra los dos repos: $OUT" ;; esac
  [ "$(harness_lab_home_hash)" = "$H0" ] && ok "…sin escribir nada (HOME idéntica)" || bad "sin acceso escribió"
  harness_lab_release_control '{ "auth": "none" }'
  # (d bis) un public-repos.json del clon ILEGIBLE no es «sin equipo»: precondición fallida, HOME idéntica
  cp "$LAB_TREE/scripts/publishing/public-repos.json" "$BASE/lab13/public-repos.bak"
  printf '{ roto\n' > "$LAB_TREE/scripts/publishing/public-repos.json"
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 1 ] && ok "public-repos.json del clon ilegible: migrate sale 1 (precondición, no una opción mal escrita)" || bad "ilegible: rc $RC: $OUT"
  case "$OUT" in *"no se lee como JSON"*) ok "…diciendo que no se lee" ;; *) bad "no lo dice: $OUT" ;; esac
  [ "$(harness_lab_home_hash)" = "$H0" ] && ok "…sin escribir nada" || bad "ilegible escribió"
  cp "$BASE/lab13/public-repos.bak" "$LAB_TREE/scripts/publishing/public-repos.json"
  # (d ter) la versión pública que trae una ruta de la capa: la mudanza no arranca, 1, HOME idéntica y sin pedir el comprimido del equipo
  harness_lab_publish_stable 2026.10.08.2 perfil-equipo.json '{ "integrations": { "engram": false } }'
  N1="$(grep -c -- "/repos/$LAB_TEAM/tarball/" "$LAB_RELEASE_LOG" 2>/dev/null || echo 0)"
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 1 ] && ok "versión que trae perfil-equipo.json: migrate sale 1" || bad "colisión: rc $RC: $OUT"
  case "$OUT" in *"trae perfil-equipo.json"*"choca con la capa del equipo"*) ok "…nombrando la ruta que choca" ;; *) bad "no nombra la ruta: $OUT" ;; esac
  [ "$(grep -c -- "/repos/$LAB_TEAM/tarball/" "$LAB_RELEASE_LOG" 2>/dev/null || echo 0)" = "$N1" ] && ok "…sin pedir el comprimido del equipo (el choque se mira antes de bajar)" || bad "pidió el comprimido del equipo pese al choque"
  [ "$(harness_lab_home_hash)" = "$H0" ] && ok "…y sin escribir nada" || bad "colisión escribió"
  rm -f "$LAB_AUTHOR_TREE/perfil-equipo.json"   # la versión siguiente ya no trae la ruta de la capa
  harness_lab_publish_stable 2026.10.08.3 CHANGES "sin la ruta de la capa"
  # (e) la mudanza entera: la capa apilada, el perfil sin fundir, explain con origen perfil, el estado con team
  BEFORE_ADO="$(explain_key "$LAB_TREE" ado org)"
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "migrate --to-home sale 0" || bad "migrate rc $RC: $OUT"
  case "$OUT" in *"perfil del equipo: viaja en la capa del equipo ($LAB_TEAM), no se funde"*) ok "la salida dice que el perfil viajó en la capa" ;; *) bad "la salida no habla del perfil: $OUT" ;; esac
  case "$OUT" in *"capa del equipo $LAB_TEAM @ "*"2 archivo(s)"*) ok "la salida cuenta la capa apilada" ;; *) bad "la salida no cuenta la capa: $OUT" ;; esac
  NEW="$LAB_HOME/.tycon/harness"
  [ -f "$NEW/perfil-equipo.json" ] && [ -f "$NEW/scripts/metrics/corridas-buzon.json" ] && [ -f "$NEW/.tycon-team.json" ] && ok "los dos archivos de la capa y su manifiesto están en ~/.tycon/harness" || bad "falta algo de la capa en $NEW: $(ls -a "$NEW" 2>/dev/null | tr '\n' ' ')"
  case "$(explain_key "$NEW" ado org)" in *acme*" perfil") ok "explain del árbol nuevo: ado.org de la capa con origen perfil" ;; *) bad "explain ado.org: $(explain_key "$NEW" ado org) (antes: $BEFORE_ADO)" ;; esac
  case "$(explain_key "$NEW" integraciones engram)" in "true perfil") ok "…engram prendida con origen perfil (no maquina)" ;; *) bad "engram: $(explain_key "$NEW" integraciones engram)" ;; esac
  # el perfil del CLON prendía clockify; la capa no: si se hubiera fundido, clockify sería «true maquina»
  case "$(explain_key "$NEW" integraciones clockify)" in *" maquina"|*" perfil") bad "clockify del CLON llegó a la máquina (el perfil del clon se fundió): $(explain_key "$NEW" integraciones clockify)" ;; "false apagado") ok "clockify (sólo en el perfil del clon) no se fundió: queda apagada por defecto" ;; *) bad "clockify inesperada: $(explain_key "$NEW" integraciones clockify)" ;; esac
  CFG="$LAB_HOME/.tycon/config.json"
  if [ -f "$CFG" ]; then
    case "$(cat "$CFG")" in *'"ado"'*|*'"engram"'*) bad "config.json trae claves del perfil (se fundió): $(cat "$CFG")" ;; *) ok "config.json sin las claves del perfil" ;; esac
  else ok "config.json sin las claves del perfil (no hace falta ninguno)"; fi
  STATE="$LAB_HOME/.tycon/state/harness-state.json"
  [ "$(j "$STATE" "d['team']['repo']")" = "$LAB_TEAM" ] && [ "$(j "$STATE" "d['team']['commit']")" = "$(harness_lab_team_head)" ] && [ "$(j "$STATE" "d['team']['files']")" = 2 ] && ok "el estado trae team con el repo, el commit y los 2 archivos" || bad "el estado no trae team: $(j "$STATE" "d.get('team')")"
  [ "$(j "$STATE" "d['sources'][0]['kind']")" = release ] && ok "…y la máquina es release" || bad "no es release"
  JOURNAL="$LAB_HOME/.tycon/migrate.json"
  [ -f "$JOURNAL" ] && bad "el diario quedó: $(cat "$JOURNAL")" || ok "el diario se borró al terminar"
  OUT="$(node "$NEW/scripts/setup/harness.js" doctor 2>&1)"
  case "$OUT" in *"perfil:"*) ok "doctor del árbol nuevo sigue diciendo el perfil" ;; *) bad "doctor sin línea del perfil: $OUT" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ══ T14: el clon viejo, de antes del lector de team-repos.json ═══════════════════════════════════════════════════════
# Un clon anterior a scripts/lib/team-repos.js no se podía mudar con una capa que trae team-repos.json: las precondiciones
# juzgaban la capa con los lectores DEL CLON («la versión que va a quedar no trae su lector … la capa no se apila»). Ahora
# el plan dice que la capa se valida con la versión que baja, y la mudanza la juzga con los lectores de esa versión, después
# de bajarla y antes de escribir nada: una capa válida se apila; una que esa versión rechaza sigue frenando, con la HOME idéntica.
if runs T14; then
  echo "T14 · el clon sin el lector de team-repos.json: el plan y la mudanza validan la capa con la versión que baja; una capa inválida sigue frenando"
  harness_lab_create "$BASE/lab14"
  export TYCON_PROFILE=
  printf '{ "install": { "profile": "full" } }\n' > "$LAB_TREE/perfil-equipo.json"   # el clon contesta la pregunta del perfil (como T13)
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.08.1
  harness_lab_team_repo
  repos_14() { printf '{ "version": 1, "public": { "platform": "github", "org": "acme", "repo": "arnes" }, "profile": { "platform": "github", "org": "acme", "repo": "perfil" }, "operations": { "platform": "github", "org": "acme", "repo": "operaciones" }%s }\n' "$1" > "$LAB_AUTHOR_TEAM/team-repos.json"; }
  repos_14 ""
  harness_lab_team_publish "team-repos.json en la capa"
  harness_lab_team_server
  harness install --yes >"$BASE/lab14/install.out" 2>&1 || bad "la instalación desde el clon falló: $(tail -3 "$BASE/lab14/install.out" | tr '\n' ' ')"
  harness_lab_team_set_clone_key
  # el clon es de antes del lector: la versión publicada sí lo trae
  rm -f "$LAB_TREE/scripts/lib/team-repos.js"
  [ -f "$LAB_AUTHOR_TREE/scripts/lib/team-repos.js" ] && ok "la versión publicada trae el lector y el clon no" || bad "la versión publicada no trae scripts/lib/team-repos.js"
  H0="$(harness_lab_home_hash)"
  # (a) el plan: sale 0, nombra la capa con sus 3 archivos y dice que team-repos.json se valida con la versión que baja
  OUT="$(harness migrate --to-home --dry-run 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "(a) --dry-run sale 0 aunque el clon no traiga el lector" || bad "(a) dry-run rc $RC: $OUT"
  case "$OUT" in *MODULE_NOT_FOUND*|*"no trae su lector"*) bad "(a) el plan juzgó con el lector del clon: $OUT" ;; *) ok "(a) …sin juzgar con el lector del clon" ;; esac
  case "$OUT" in *"capa del equipo $LAB_TEAM @ "*"3 archivo(s)"*) ok "(a) el plan nombra la capa y sus 3 archivos" ;; *) bad "(a) el plan no nombra la capa: $OUT" ;; esac
  case "$OUT" in *"valida: "*"team-repos.json de la capa con los lectores de la versión 2026.10.08.1 (la que baja)"*) ok "(a) …y dice que team-repos.json se valida con la versión que baja" ;; *) bad "(a) el plan no dice con qué se valida: $OUT" ;; esac
  [ "$(harness_lab_home_hash)" = "$H0" ] && ok "(a) --dry-run no escribió nada" || bad "(a) --dry-run escribió"
  # (b) una capa que la versión que baja rechaza (una clave que su lector no admite): 1, nombrando el archivo, sin escribir nada
  repos_14 ', "owners": ["x"]'
  harness_lab_team_publish "team-repos.json que la versión rechaza"
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 1 ] && ok "(b) capa inválida para la versión que baja: migrate sale 1" || bad "(b) rc $RC: $OUT"
  case "$OUT" in *"team-repos.json de la capa"*"owners"*"la capa no se apila"*) ok "(b) …nombrando la clave que esa versión rechaza" ;; *) bad "(b) no dice por qué: $OUT" ;; esac
  case "$OUT" in *"$LAB_TREE"*) bad "(b) juzgó con el clon: $OUT" ;; *) ok "(b) …juzgada con la versión bajada, no con el clon" ;; esac
  [ "$(harness_lab_home_hash)" = "$H0" ] && ok "(b) …y la HOME quedó idéntica (ni diario, ni incoming/, ni la capa)" || bad "(b) la HOME cambió: $(cd "$LAB_HOME" && find .tycon 2>/dev/null | head -5 | tr '\n' ' ')"
  [ "$(state "d['sources'][0].get('kind','tree')")" != release ] && ok "(b) …y la máquina sigue en el clon" || bad "(b) la máquina dejó el clon"
  # (c) la capa válida otra vez: la mudanza entera, con team-repos.json apilado
  repos_14 ""
  harness_lab_team_publish "team-repos.json válido otra vez"
  OUT="$(harness migrate --to-home 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "(c) migrate --to-home sale 0 desde el clon sin el lector" || bad "(c) migrate rc $RC: $OUT"
  NEW="$LAB_HOME/.tycon/harness"
  [ -f "$NEW/team-repos.json" ] && [ -f "$NEW/scripts/lib/team-repos.js" ] && [ -f "$NEW/.tycon-team.json" ] && ok "(c) team-repos.json, su lector y el manifiesto de la capa están en ~/.tycon/harness" || bad "(c) falta algo en $NEW: $(ls -a "$NEW" 2>/dev/null | tr '\n' ' ')"
  STATE="$LAB_HOME/.tycon/state/harness-state.json"
  [ "$(j "$STATE" "d['team']['commit']")" = "$(harness_lab_team_head)" ] && [ "$(j "$STATE" "d['team']['files']")" = 3 ] && ok "(c) el estado trae team con el commit de la punta y los 3 archivos" || bad "(c) el estado no trae team: $(j "$STATE" "d.get('team')")"
  [ "$(j "$STATE" "d['sources'][0]['kind']")" = release ] && ok "(c) …y la máquina es release" || bad "(c) no es release"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

echo
if [ "$FAILURES" = 0 ]; then echo "harness-move-home: todo verde"; else echo "harness-move-home: $FAILURES fallo(s)"; exit 1; fi
