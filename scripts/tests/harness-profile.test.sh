#!/usr/bin/env bash
# harness-profile.test.sh — los perfiles de instalación.
#
# Sin perfiles, la instalación trae todo o nada: los frenos, los tres bloques que cambian cómo contesta el
# asistente en todos los proyectos, los dos ajustes de Claude Code, los hooks de git y las tareas de fondo. Alguien de
# afuera que sólo quiere las guías y las skills recibiría también eso. Hay dos perfiles —`minimal` y `full`— y lo
# que trae cada uno lo dice `scripts/setup/install-effects.json` (`profiles`). Lo que estas pruebas sostienen:
#   T32 · el aplicador REAL con `install.profile: minimal` registra sólo los hooks de minimal, ningún freno, no escribe
#         los dos ajustes, no toca los hooks de git y no lanza ninguna tarea de fondo de `full`; sí hace los enlaces, los
#         comandos y las skills de terceros (las pide). Con `full` sí lo hace todo (el control: si el aplicador dejara de
#         lanzar todo, el «cero lanzamientos» de minimal no diría nada).
#   T33 · sin valor es `full`; un valor fuera de la lista deja lo del perfil como está y lo dice; una
#         variable puesta a mano manda en los dos sentidos (`minimal` + `TYCON_TEST_SCOPE_GUARD=1` registra el freno de
#         pruebas; `TYCON_SAFETY_GUARD=0` saca el de comandos, que está en los dos perfiles).
#   T40 · con el perfil del equipo, el aplicador deja los MISMOS hooks (profile-equivalence.js --settings)
#         y el MISMO CLAUDE.md (cmp) que el aplicador de antes de los perfiles (BASE_REF), sin tocar tycon.json; cada
#         hook `.js` con el piso de Node, y `--gate` sólo en los frenos. Cada arreglo de la comparación tiene su caso
#         que sigue saliendo rojo: una línea de más en el CLAUDE.md, un hook sin declarar, un declarado que no está una vez.
#   T35 a T37 · `harness.js install --profile`, el cambio de perfil y los valores
#         inválidos, con el programa de verdad. Python no escribe su caché durante la prueba (PYTHONDONTWRITEBYTECODE):
#         el de Apple la deja en la carpeta de inicio y la foto de esa carpeta la vería como algo que escribió install.
#   HASH · la foto de la carpeta de inicio ve un archivo de más.
#
# Laboratorio: una copia descartable del árbol (con git propio) y una HOME de juguete con un agent-skills de juguete (un
# archivo por hook que vive ahí), el patrón de harness-plan.test.sh. Un `node` intermediario va primero en el PATH:
# anota cada lanzamiento de una tarea de fondo y NO la corre (tampoco el disparador del examen: una HOME temporal sola
# no aísla launchd). Nunca ~/.claude ni el checkout real. 🔴 Sin pipes sobre el comando medido.
# 🔴 Sin el perfil, el aplicador no lo lee y registra todos los hooks en minimal.
#
#   REG · un cambio de perfil sin el reporte del aplicador no se da por hecho.
#
# Uso: bash scripts/tests/harness-profile.test.sh [--only T32|T33|T40|T35|T36|T37|REG|HASH]
set -uo pipefail
# el banco nocturno apaga el buzón para todas las suites; acá el aplicador tiene que instalar lo que cuelga del buzón
# (T40 cuenta el hook del aviso por correo), así que la prueba no hereda ese apagado
unset TYCON_MAILBOX
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIX="$RAIZ/scripts/tests/fixtures/harness-managed-pieces.json"
EFFECTS="$RAIZ/scripts/setup/install-effects.json"
# el último commit sin perfiles: el aplicador de antes de los perfiles (T40). Con la historia entera (fetchDepth: 0) está.
# main sin los perfiles: el aplicador «de antes»
BASE_REF="${TYCON_PROFILE_BASE_REF:-44628fc7}"
ONLY=""; [ "${1:-}" = "--only" ] && ONLY="${2:-}"
corre() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
T="$(mktemp -d "${TMPDIR:-/tmp}/harness-profile.XXXXXX")"; T="$(cd "$T" && pwd)"   # sin la barra doble de un TMPDIR que termina en «/»
node "$RAIZ/scripts/tests/lib/lab-guard.js" "$T" harness-profile --place || exit 1
if [ -n "${HARNESS_PROFILE_KEEP:-}" ]; then trap 'echo "laboratorio: $T"' EXIT; else trap 'rm -rf "$T"' EXIT; fi
REAL_NODE="$(command -v node)"

# ── el laboratorio ───────────────────────────────────────────────────────────────────────────────────────────────────
gitlab() { env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=Lab GIT_AUTHOR_EMAIL=lab@example.com \
  GIT_COMMITTER_NAME=Lab GIT_COMMITTER_EMAIL=lab@example.com sh -c \
  'git -C "$1" init -q -b main && git -C "$1" add -A && git -C "$1" -c core.hooksPath=/dev/null commit -q -m "$2"' _ "$1" "$2"; }
lab_tree() { # lab_tree <dir> [<ref>] → una copia del árbol (el de trabajo, o el de un commit), con git propio
  rm -rf "$1"; mkdir -p "$1"
  if [ -n "${2:-}" ]; then
    git -C "$RAIZ" archive "$2" scripts claude-md-blocks commands README.md | ( cd "$1" && tar xf - ) || return 1
    rm -rf "$1/scripts/tests"
  else
    ( cd "$RAIZ" && tar cf - --exclude=scripts/tests --exclude=node_modules scripts claude-md-blocks commands README.md ) | ( cd "$1" && tar xf - )
  fi
  gitlab "$1" "arbol de laboratorio"
}
new_home() { # new_home <dir> → agent-skills de juguete con un archivo por hook que vive ahí, con git propio
  rm -rf "$1"; mkdir -p "$1/.claude/agent-skills/skills/tycon-pipeline"
  python3 - "$FIX" "$1/.claude/agent-skills/skills" <<'PY'
import json, os, sys
fix, skills = sys.argv[1], sys.argv[2]
for p in json.load(open(fix, encoding="utf-8"))["pieces"]:
    if p["kind"] != "hook" or "id" not in p or p["when"] == "platform:windows":
        continue
    rel = p["id"].split(":", 1)[1]
    if rel.startswith("@tcg:"):
        continue
    os.makedirs(os.path.dirname(os.path.join(skills, rel)), exist_ok=True)
    open(os.path.join(skills, rel), "a").close()
PY
  gitlab "$1/.claude/agent-skills" "agent-skills de laboratorio"
}
# el node intermediario: anota (y NO corre) cada tarea de fondo y el disparador del examen; lo demás, el node de verdad
NODEBIN="$T/nodebin"; mkdir -p "$NODEBIN"; LANZ="$T/lanzamientos.log"
cat > "$NODEBIN/node" <<EOF
#!/bin/sh
for a in "\$@"; do
  case "\$a" in
    *harness-parity.js|*sdlc-stage-metrics.js|*tokens-digest.js|*collect-findings.js|*periodic-exam.js|*upload-runs.js|*download-runs.js|*live-fire.js)
      echo "\$*" >> "\${TYCON_LAB_LAUNCHES:?}"; exit 0 ;;
  esac
done
exec "$REAL_NODE" "\$@"
EOF
chmod +x "$NODEBIN/node"
ENV_UNSET=(-u TYCON_SETTINGS_PATH -u CLAUDE_MD_PATH -u CODEX_AGENTS_MD_PATH -u TYCON_HARNESS_SNAPSHOT_DIR -u TYCON_REPORT_PIECES
     -u TYCON_PLAN_PIECES -u TYCON_HARNESS_LOCK_HELD -u TYCON_HARNESS_SHARED_DONE -u TYCON_NO_AUTOINSTALL -u TYCON_NO_CLAUDEMD_SYNC
     -u TYCON_NO_COMMANDS_SYNC -u TYCON_NO_GIT_HOOKS -u TYCON_THIRD_PARTY -u TYCON_ENGRAM_HOOK -u TYCON_SAFETY_GUARD
     -u TYCON_TEST_SCOPE_GUARD -u TYCON_SESSION_GUARD -u TYCON_TG_ZOMBIE_SWEEP -u TYCON_CLOCKIFY -u TYCON_ENGRAM -u TYCON_NIGHTLY
     -u TYCON_ADO_ORG -u ADO_ORG -u TYCON_REPOS_ROOT -u TF_BUILD -u XDG_CONFIG_HOME -u TYCON_GUIDES_DIR -u TYCON_SKILLS_DIR
     -u TYCON_INSTALL_PROFILE -u TYCON_STAGE_METRICS -u TYCON_NO_THREAD_RESCUE -u TYCON_NO_COLLECT_FINDINGS -u TYCON_NO_NIGHTLY_EXAM)
# base <home> [perfil del equipo: 0 | ruta] → el ambiente aislado, en RUN_ENV. Las tareas de fondo NO se apagan por
# variable: es lo que se mide (las intercepta el node intermediario).
base() {
  RUN_ENV=(env "${ENV_UNSET[@]}" HOME="$1" USERPROFILE="$1" PATH="$NODEBIN:$PATH" TYCON_LAB_LAUNCHES="$LANZ" TYCON_PROFILE="${2:-0}"
       TYCON_CODEX=0 CODEX_HOME="$1/.codex" TYCON_GIT_HOOKS_DIR="$1/.git-hooks" TYCON_EXAM_LAUNCHAGENTS="$1/LaunchAgents"
       TYCON_NO_GUI_ENV=1 LAUNCHCTL_BIN=/usr/bin/true TYCON_BENCH_DAILY=0 TYCON_MAILBOX_URL_BASE=http://127.0.0.1:9
       TYCON_MAILBOX_JSON="$T/no-hay-llave.json" TYCON_NO_AZ_PROJECTS_REFRESH=1 TYCON_NO_ENGRAM_VERSION_CHECK=1
       TYCON_NO_SQLITE_CHECK=1 TYCON_NO_ENGRAM_PROJECT_CHECK=1 TYCON_NO_AGENTSMD_POINTER=1 TYCON_NO_CANONICAL_PATH=1
       TYCON_THIRD_PARTY=0 TYCON_UPDATE=0 TYCON_METRICS_SCAN_ROOT="$T/scan" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null TMPDIR="$T/tmp"
       PYTHONDONTWRITEBYTECODE=1)
  mkdir -p "$T/tmp" "$T/scan"
}
machine() { mkdir -p "$1/.claude"; printf '%s\n' "$2" > "$1/.claude/tycon.json"; }
# harness_hooks <home> <árbol> → «EVENTO:ruta de su spec» de cada hook del arnés en settings.json, ordenado
harness_hooks() { python3 - "$1/.claude/settings.json" "$2" "$1/.claude/agent-skills/skills" <<'PY' | LC_ALL=C sort -u
import json, os, re, sys
try: s = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception: sys.exit(0)
tcg = os.path.join(os.path.realpath(sys.argv[2]), "scripts", "hooks") + os.sep
sk = os.path.realpath(sys.argv[3]) + os.sep
for ev, groups in (s.get("hooks") or {}).items():
    for g in groups:
        for h in g.get("hooks", []):
            for q in re.findall(r'"([^"]+)"', h.get("command", "")):
                r = os.path.realpath(q)
                if r.startswith(tcg): print("%s:@tcg:%s" % (ev, r[len(tcg):]))
                elif r.startswith(sk): print("%s:%s" % (ev, r[len(sk):]))
PY
}
minimal_hooks() { python3 -c "
import json,sys
for e in json.load(open(sys.argv[1], encoding='utf-8'))['effects']:
    # los opt-in de minimal que nacen prendidos cuentan (el freno de comandos, 2026-10-05); el de sesiones nace apagado
    if e['kind']=='hook' and 'minimal' in e['profiles'] and not e['when'].startswith(('integration:','time:','platform:')) and e['when']!='optin:TYCON_SESSION_GUARD': print(e['id'])" "$EFFECTS" | LC_ALL=C sort -u; }
setting() { python3 -c "
import json,sys
s=json.load(open(sys.argv[1], encoding='utf-8')); k=sys.argv[2].split('.'); v=s
for p in k: v=v.get(p) if isinstance(v,dict) else None
print('' if v is None else json.dumps(v))" "$1/.claude/settings.json" "$2" 2>/dev/null; }
plan_kinds() { python3 -c "
import json,sys
for p in json.load(open(sys.argv[1], encoding='utf-8')): print(p['kind'], p['id'], p['action'])" "$1" | LC_ALL=C sort; }
applier() { # applier <home> <árbol> <salida> [args…] → corre el aplicador del árbol; deja el exit code en RC
  local h="$1" tr="$2" out="$3"; shift 3
  "${RUN_ENV[@]}" bash "$tr/scripts/install-tycon-hooks.sh" "$@" > "$out" 2>&1; RC=$?
  sleep 1   # las tareas de fondo anotan con su propio proceso
}
FULL_TASKS='harness-parity.js|sdlc-stage-metrics.js|tokens-digest.js|collect-findings.js|periodic-exam.js'

TREE="$T/tree"; lab_tree "$TREE" || { echo "❌ no pude armar el árbol de laboratorio"; exit 1; }
# El perfil del equipo con que corren los casos de «máquina del equipo»: el del repo si lo trae; si no (el perfil vive
# en el repo del perfil, y el árbol armado no lo tiene), el del commit de referencia, que ya da el lado viejo de
# T40: estos casos miden el aplicador con un perfil del equipo, no un perfil en particular.
TEAM_PROFILE="$RAIZ/perfil-equipo.json"
if [ ! -f "$TEAM_PROFILE" ] && git -C "$RAIZ" show "${BASE_REF}:perfil-equipo.json" > "$T/perfil-equipo.json" 2>/dev/null; then
  # con el perfil que instala el equipo (full), como dice el perfil actual; el del commit base todavía no lo dice
  python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d.setdefault("install", {}).setdefault("profile", "full"); json.dump(d, open(p, "w"), indent=2)' "$T/perfil-equipo.json" \
    && TEAM_PROFILE="$T/perfil-equipo.json"
fi

# ══ T32 · minimal: sólo los hooks de minimal; nada de full ═════════════════════════════════════════════════════════════
if corre T32; then
  echo "T32 · Applier_Minimal_OnlyMinimalHooks_NoBrakesGitHooksSettingsOrDailyLaunches"
  H="$T/t32/home"; new_home "$H"; machine "$H" '{ "install": { "profile": "minimal" } }'; base "$H"; : > "$LANZ"
  # el plan, antes (pide los enlaces, los comandos y las skills de terceros, y nada de full)
  "${RUN_ENV[@]}" env -u TYCON_THIRD_PARTY bash "$TREE/scripts/install-tycon-hooks.sh" --check --plan-json "$T/t32/plan.json" > "$T/t32/plan.out" 2>&1; RC=$?
  if [ "$RC" = 0 ]; then
    plan_kinds "$T/t32/plan.json" > "$T/t32/plan.txt"
    for k in link command third-party; do grep -q "^${k} " "$T/t32/plan.txt" && ok "T32 el plan de minimal pide «${k}»" || mal "T32 el plan de minimal no trae «${k}»"; done
    for k in setting git-hook; do grep -q "^${k} " "$T/t32/plan.txt" && mal "T32 el plan de minimal trae «${k}»: $(grep "^${k} " "$T/t32/plan.txt" | tr '\n' ';')" || ok "T32 el plan de minimal no trae «${k}»"; done
  else mal "T32 --check --plan-json en minimal salió ${RC}: $(tail -n 3 "$T/t32/plan.out" | tr '\n' ' ')"; fi
  applier "$H" "$TREE" "$T/t32/install.out"
  [ "$RC" = 0 ] || mal "T32 el aplicador en minimal salió ${RC}: $(tail -n 3 "$T/t32/install.out" | tr '\n' ' ')"
  harness_hooks "$H" "$TREE" > "$T/t32/hooks.txt"; minimal_hooks > "$T/t32/want.txt"
  # nueve: seis que anotan, el que dice los avisos de los paquetes, el freno de comandos y el portón de edición
  [ "$(wc -l < "$T/t32/want.txt" | tr -d ' ')" = 9 ] && ok "T32 la lista de efectos marca nueve hooks de minimal" || mal "T32 la lista marca $(wc -l < "$T/t32/want.txt" | tr -d ' ') hooks de minimal, no nueve"
  cmp -s "$T/t32/hooks.txt" "$T/t32/want.txt" && ok "T32 registra exactamente los nueve hooks de minimal" \
    || mal "T32 hooks registrados distintos de los de minimal: $(diff "$T/t32/want.txt" "$T/t32/hooks.txt" | grep '^[<>]' | head -6 | tr '\n' ' ')"
  # el freno de comandos destructivos y el portón de edición están en los dos perfiles (sin el portón, el agente puede
  # implementar una historia sin recorrido y nadie se entera); los demás, sólo en full
  grep -qx 'PreToolUse:@tcg:safety-guard-pre.sh' "$T/t32/hooks.txt" && ok "T32 el freno de comandos destructivos, registrado" || mal "T32 minimal sin el freno de comandos destructivos"
  grep -qx 'PreToolUse:tycon-pipeline/scripts/hook-pre-edit.js' "$T/t32/hooks.txt" && ok "T32 el portón de edición, registrado" || mal "T32 minimal sin el portón de edición"
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if any("hook-pre-edit.js" in h.get("command","") and "Edit" in (g.get("matcher") or "") for g in d.get("hooks",{}).get("PreToolUse",[]) for h in g.get("hooks",[])) else 1)' "$H/.claude/settings.json" \
    && ok "T32 el portón de edición corre antes de Edit|Write" || mal "T32 el portón de edición no está antes de Edit|Write"
  grep -Eq 'test-scope-guard-pre|on-pre-commit|on-bash-write-gate' "$T/t32/hooks.txt" && mal "T32 hay otro freno registrado en minimal" || ok "T32 ningún otro freno"
  [ -z "$(setting "$H" cleanupPeriodDays)" ] && [ -z "$(setting "$H" env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR)" ] \
    && ok "T32 sin cleanupPeriodDays ni la variable de env" || mal "T32 escribió los ajustes: cleanupPeriodDays=$(setting "$H" cleanupPeriodDays) env=$(setting "$H" env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR)"
  [ ! -e "$H/.git-hooks" ] && ok "T32 ~/.git-hooks sin tocar" || mal "T32 tocó los hooks de git: $(ls "$H/.git-hooks" | tr '\n' ' ')"
  grep -Eq "$FULL_TASKS" "$LANZ" && mal "T32 lanzó tareas de full: $(grep -E "$FULL_TASKS" "$LANZ" | head -3 | tr '\n' ';')" || ok "T32 cero lanzamientos de full"
  ls "$H/.claude/commands/"*.md >/dev/null 2>&1 && ok "T32 copió los comandos" || mal "T32 no copió los comandos"
  grep -q 'perfil de instalación: minimal' "$T/t32/install.out" && ok "T32 el aplicador dice el perfil" || mal "T32 el aplicador no dice el perfil: $(head -c 300 "$T/t32/install.out")"
  # el CLAUDE.md sin los tres bloques de full
  if [ -f "$H/.claude/CLAUDE.md" ] && grep -q 'TYCON_BLOCK:' "$H/.claude/CLAUDE.md"; then mal "T32 CLAUDE.md trae bloques en minimal: $(grep -o 'TYCON_BLOCK:[a-z-]* START' "$H/.claude/CLAUDE.md" | tr '\n' ' ')"
  else ok "T32 CLAUDE.md sin los bloques de full"; fi

  # el control: con full, lo mismo sí escribe y sí lanza
  H="$T/t32/home-full"; new_home "$H"; machine "$H" '{ "install": { "profile": "full" } }'; base "$H"; : > "$LANZ"
  applier "$H" "$TREE" "$T/t32/full.out"
  [ "$RC" = 0 ] || mal "T32 control: el aplicador en full salió ${RC}: $(tail -n 3 "$T/t32/full.out" | tr '\n' ' ')"
  [ "$(harness_hooks "$H" "$TREE" | wc -l | tr -d ' ')" -gt 20 ] && ok "T32 control: full registra el set entero" || mal "T32 control: full registró $(harness_hooks "$H" "$TREE" | wc -l | tr -d ' ') hooks"
  [ "$(setting "$H" cleanupPeriodDays)" = 365 ] && ok "T32 control: full escribe cleanupPeriodDays" || mal "T32 control: full no escribió cleanupPeriodDays"
  [ -f "$H/.git-hooks/pre-commit" ] && ok "T32 control: full instala el pre-commit de git" || mal "T32 control: full no instaló el pre-commit de git"
  for t in harness-parity.js tokens-digest.js collect-findings.js periodic-exam.js; do
    grep -q "$t" "$LANZ" && ok "T32 control: full lanza $t" || mal "T32 control: full no lanzó $t (el «cero» de minimal no probaría nada)"
  done
  grep -q 'TYCON_BLOCK:response-style START' "$H/.claude/CLAUDE.md" 2>/dev/null && ok "T32 control: full escribe los bloques" || mal "T32 control: full no escribió el bloque de estilo"
fi

# ══ T33 · sin valor = full; rota = queda como está; la variable manda ═════════════════════════════════════════════════
if corre T33; then
  echo "T33 · Applier_UnsetIsFull_BrokenLeavesAsIs_ExplicitSwitchWins"
  # sin valor vs full explícito: mismos hooks y mismo CLAUDE.md
  H1="$T/t33/unset"; new_home "$H1"; base "$H1"; applier "$H1" "$TREE" "$T/t33/unset.out"
  H2="$T/t33/full"; new_home "$H2"; machine "$H2" '{ "install": { "profile": "full" } }'; base "$H2"; applier "$H2" "$TREE" "$T/t33/full.out"
  # cada HOME tiene su ruta: se comparan con la HOME pasada a una marca
  sed "s#$H1#@HOME@#g" "$H1/.claude/settings.json" > "$T/t33/unset.json"; sed "s#$H2#@HOME@#g" "$H2/.claude/settings.json" > "$T/t33/full.json"
  node "$RAIZ/scripts/publishing/profile-equivalence.js" --settings "$T/t33/unset.json" "$T/t33/full.json" > "$T/t33/eq.out" 2>&1
  EQ=$?
  [ "$EQ" = 0 ] && ok "T33 sin valor registra lo mismo que full (profile-equivalence --settings)" || mal "T33 sin valor ≠ full (rc $EQ): $(head -c 400 "$T/t33/eq.out")"
  cmp -s "$H1/.claude/CLAUDE.md" "$H2/.claude/CLAUDE.md" && ok "T33 sin valor: CLAUDE.md igual al de full" || mal "T33 sin valor: CLAUDE.md distinto del de full"
  grep -q 'perfil de instalación' "$T/t33/unset.out" && mal "T33 sin valor el aplicador habla del perfil (tiene que salir como hoy)" || ok "T33 sin valor: la salida no nombra el perfil (como hoy)"
  # rota: un full instalado con el valor roto → lo del perfil queda como está, y lo dice
  H="$T/t33/rota"; new_home "$H"; machine "$H" '{ "install": { "profile": "full" } }'; base "$H"; applier "$H" "$TREE" "$T/t33/r1.out"
  harness_hooks "$H" "$TREE" > "$T/t33/antes.txt"
  machine "$H" '{ "install": { "profile": "medio" } }'
  applier "$H" "$TREE" "$T/t33/r2.out"
  harness_hooks "$H" "$TREE" > "$T/t33/despues.txt"
  [ "$RC" = 0 ] && ok "T33 rota: el aplicador sale 0" || mal "T33 rota: salió ${RC}"
  cmp -s "$T/t33/antes.txt" "$T/t33/despues.txt" && ok "T33 rota: no saca ni agrega hooks del perfil" || mal "T33 rota: cambiaron los hooks: $(diff "$T/t33/antes.txt" "$T/t33/despues.txt" | grep '^[<>]' | head -4 | tr '\n' ' ')"
  grep -q 'perfil de instalación queda como estaba' "$T/t33/r2.out" && ok "T33 rota: lo dice" || mal "T33 rota: no lo dice: $(head -c 300 "$T/t33/r2.out")"
  #   …y sobre una HOME vacía, rota no registra lo de full (no lo agrega) salvo los dos frenos de comandos, que se
  #   registran igual (una máquina nueva con la configuración rota no queda sin frenos)
  H="$T/t33/rota-vacia"; new_home "$H"; machine "$H" '{ "install": { "profile": "medio" } }'; base "$H"; applier "$H" "$TREE" "$T/t33/r3.out"
  harness_hooks "$H" "$TREE" > "$T/t33/r3.txt"
  { minimal_hooks; printf '%s\n' 'PreToolUse:@tcg:safety-guard-pre.sh' 'PreToolUse:@tcg:test-scope-guard-pre.sh'; } | LC_ALL=C sort -u > "$T/t33/r3-want.txt"
  cmp -s "$T/t33/r3.txt" "$T/t33/r3-want.txt" && ok "T33 rota sobre una HOME vacía: lo que no depende del perfil, más los dos frenos" \
    || mal "T33 rota en HOME vacía: $(diff "$T/t33/r3-want.txt" "$T/t33/r3.txt" | grep '^[<>]' | head -5 | tr '\n' ' ')"
  # la variable manda, en los dos sentidos: minimal + TYCON_TEST_SCOPE_GUARD=1 → el freno de pruebas; minimal +
  # TYCON_SAFETY_GUARD=0 → sin el de comandos; full + TYCON_SAFETY_GUARD=0 → sin el de comandos
  H="$T/t33/min-sg"; new_home "$H"; machine "$H" '{ "install": { "profile": "minimal" } }'; base "$H"; RUN_ENV+=(TYCON_TEST_SCOPE_GUARD=1 TYCON_SAFETY_GUARD=0)
  applier "$H" "$TREE" "$T/t33/min-sg.out"
  grep -q '^PreToolUse:@tcg:test-scope-guard-pre.sh$' <(harness_hooks "$H" "$TREE") && ok "T33 minimal + TYCON_TEST_SCOPE_GUARD=1: el freno de pruebas registrado" || mal "T33 minimal + TYCON_TEST_SCOPE_GUARD=1: el freno de pruebas no está"
  grep -q 'safety-guard-pre.sh' <(harness_hooks "$H" "$TREE") && mal "T33 minimal + TYCON_SAFETY_GUARD=0: el freno de comandos quedó" || ok "T33 minimal + TYCON_SAFETY_GUARD=0: el freno de comandos ausente"
  H="$T/t33/full-sg"; new_home "$H"; machine "$H" '{ "install": { "profile": "full" } }'; base "$H"; RUN_ENV+=(TYCON_SAFETY_GUARD=0)
  applier "$H" "$TREE" "$T/t33/full-sg.out"
  grep -q 'safety-guard-pre.sh' <(harness_hooks "$H" "$TREE") && mal "T33 full + TYCON_SAFETY_GUARD=0: el freno quedó" || ok "T33 full + TYCON_SAFETY_GUARD=0: el freno ausente"
  # de full a minimal, el aplicador saca lo de full con el motivo en el reporte
  H="$T/t33/switch"; new_home "$H"; machine "$H" '{ "install": { "profile": "full" } }'; base "$H"; applier "$H" "$TREE" "$T/t33/s1.out"
  machine "$H" '{ "install": { "profile": "minimal" } }'; applier "$H" "$TREE" "$T/t33/s2.out"
  cmp -s <(harness_hooks "$H" "$TREE") <(minimal_hooks) && ok "T33 de full a minimal: el aplicador saca los hooks de full" || mal "T33 de full a minimal quedaron: $(harness_hooks "$H" "$TREE" | wc -l | tr -d ' ') hooks"
  grep -q 'fuera del perfil minimal' "$T/t33/s2.out" && ok "T33 de full a minimal: el motivo en la línea del reporte" || mal "T33 de full a minimal: sin el motivo en el reporte: $(grep -m3 ' - ' "$T/t33/s2.out" | tr '\n' ' ')"
fi

# ══ T40 · el perfil del equipo: lo mismo que antes de los perfiles ════════════════════════════════════════════════════
if corre T40; then
  echo "T40 · Team_ProfileFull_SettingsEquivalent_ClaudeMdByteIdentical_NoQuestions"
  if [ ! -f "$RAIZ/scripts/publishing/public-repos.json" ]; then
    # La copia pública (sin scripts/publishing/public-repos.json, que no se publica) no trae la historia ni el perfil del
    # equipo: lo que los necesita ahí NO SE PUEDE MEDIR y se dice como «NO MEDIDO en la copia», sin contar como rojo; en el
    # repo interno, que falten sigue siendo rojo (la convención de harness-place.test.js).
    echo "  ⏭   — T40 NO MEDIDO en la copia — no trae el commit de antes de la tanda (${BASE_REF}) ni el perfil del equipo"
  elif ! git -C "$RAIZ" cat-file -e "${BASE_REF}^{commit}" 2>/dev/null; then
    mal "T40 NO MEDIDO — no está el commit de antes de la tanda (${BASE_REF}); con la historia entera está (TYCON_PROFILE_BASE_REF lo cambia)"
  else
    OLD="$T/old-tree"; lab_tree "$OLD" "$BASE_REF" || mal "T40 no pude armar el árbol de ${BASE_REF}"
    # los bloques, los actuales en los dos lados: el texto de dos y la marca de arranque («generado
    # por … del arnés») cambiaron desde el commit de antes, y T40 mide el perfil, no esos textos. La marca se compara sin
    # su descripción (ver el cmp de abajo).
    # (sin el marcador `requires-profile`, que el aplicador de antes no conoce, ni la marca del lugar de las filas de la
    # herramienta de horas: el aplicador de hoy pone ahí las filas de la integración y la marca no queda; el de entonces
    # no la conoce y la dejaría escrita. Lo mismo hace claude-md-blocks.test.sh con su aplicador viejo)
    rm -rf "$OLD/claude-md-blocks" && cp -R "$RAIZ/claude-md-blocks" "$OLD/claude-md-blocks" \
      && for f in "$OLD"/claude-md-blocks/*.md; do grep -Ev '^<!-- requires-profile:|^<!--[[:space:]]*time-tool-rows[[:space:]]*-->[[:space:]]*$' "$f" > "$f.tmp" && mv "$f.tmp" "$f"; done
    # cada aplicador con el perfil del equipo de su commit (el de antes no conoce la sección `install`)
    git -C "$RAIZ" show "$BASE_REF:perfil-equipo.json" > "$T/perfil-old.json"
    for side in old new; do
      H="$T/t40/$side"; new_home "$H"
      if [ "$side" = old ]; then tr="$OLD"; base "$H" "$T/perfil-old.json"; else tr="$TREE"; base "$H" "$TEAM_PROFILE"; fi
      applier "$H" "$tr" "$T/t40/$side.out"
      [ "$RC" = 0 ] || mal "T40 el aplicador ($side) salió ${RC}: $(tail -n 3 "$T/t40/$side.out" | tr '\n' ' ')"
    done
    # los dos settings.json nombran árboles distintos: se comparan por hooks del arnés con la ruta pasada a la de uno
    # Los hooks que el arnés CAMBIÓ después de ${BASE_REF}, declarados acá y pasados del lado de antes a su forma de hoy:
    # T40 mide el perfil, no un renombre ni un matcher más ancho. Cada cambio tiene que estar del lado de antes (uno que
    # ya no aparece sale, como en T40_ADDED).
    #   production-notice.js — el aviso del freno, que pasó a su nombre en inglés
    #   safety-guard-pre.sh mira también Monitor — el freno de comandos cubre los comandos que vigilan
    # «ruta-vieja>ruta-nueva»: el hook renombrado · «ruta@matcher»: el matcher de hoy de ese hook.
    # El nombre viejo se arma en dos partes: escrito entero, el control de nombres viejos lo cuenta como una mención.
    OLD_NOTICE="scripts/hooks/produc""cion-notice.js"
    T40_CHANGED=("${OLD_NOTICE}>scripts/hooks/production-notice.js"
      "scripts/hooks/safety-guard-pre.sh@Bash|PowerShell|Monitor")
    python3 - "$T/t40/old/.claude/settings.json" "$OLD" "$TREE" "$T/t40/old-as-new.json" "$T/t40/changed.out" "${T40_CHANGED[@]}" <<'PY'
import json, sys
t = open(sys.argv[1], encoding="utf-8").read().replace(sys.argv[2], sys.argv[3]).replace(sys.argv[1].rsplit("/.claude/", 1)[0], "@HOME@")
data, missing = json.loads(t), []
def hit(h, ruta):
    return ("/" + ruta + '"') in str(h.get("command", "")) or str(h.get("command", "")).endswith("/" + ruta)
for change in sys.argv[6:]:
    if ">" in change:
        old, new = change.split(">", 1)
        found = False
        for groups in data["hooks"].values():
            for group in groups:
                for h in group.get("hooks") or []:
                    cmd = str(h.get("command", ""))
                    if ("/" + old + '"') in cmd or cmd.endswith("/" + old):
                        h["command"] = cmd.replace("/" + old, "/" + new); found = True
    else:
        # sólo ese hook pasa al matcher de hoy, en un grupo propio: los demás de su grupo quedan donde estaban
        ruta, matcher = change.split("@", 1)
        found = False
        for event, groups in data["hooks"].items():
            moved = []
            for group in groups:
                if group.get("matcher") == matcher:
                    continue
                mine = [h for h in group.get("hooks") or [] if hit(h, ruta)]
                if mine:
                    group["hooks"] = [h for h in group["hooks"] if not hit(h, ruta)]
                    moved.append({**group, "matcher": matcher, "hooks": mine}); found = True
            data["hooks"][event] = [g for g in groups if g.get("hooks")] + moved
    if not found:
        missing.append(change)
json.dump(data, open(sys.argv[4], "w", encoding="utf-8"), indent=2)
open(sys.argv[5], "w", encoding="utf-8").write("\n".join(missing))
PY
    [ -s "$T/t40/changed.out" ] && mal "T40 cambios declarados que ya no están del lado de ${BASE_REF}: $(tr '\n' ' ' < "$T/t40/changed.out")"
    sed "s#$T/t40/new#@HOME@#g" "$T/t40/new/.claude/settings.json" > "$T/t40/new-floor.json"
    # El aplicador de hoy registra cada hook `.js` por el piso de Node: `node "<árbol>/scripts/lib/node-floor.js"
    # [--gate] "<hook>"`; el de ${BASE_REF}, con `node "<hook>"`. Para comparar se saca el envoltorio y queda el hook; que
    # el piso esté en todos lo mide aparte «el piso en cada hook». La ruta del piso puede salir con /private/tmp y la del
    # hook con /tmp (sólo una de las dos pasa por la ruta real): se reconoce el piso por cómo termina, no por su carpeta.
    t40_floor_norm() { # t40_floor_norm <settings> <salida>
      python3 - "$1" "$2" <<'PY'
import json, re, sys
src, out = sys.argv[1], sys.argv[2]
data = json.load(open(src, encoding="utf-8"))
floor = re.compile(r'^node "[^"]*/scripts/lib/node-floor\.js"(?: --gate)? (?=")')
for groups in (data.get("hooks") or {}).values():
    for group in groups:
        for hook in group.get("hooks") or []:
            if isinstance(hook.get("command"), str):
                hook["command"] = floor.sub('node ', hook["command"])
json.dump(data, open(out, "w", encoding="utf-8"), indent=2)
PY
    }
    # Los hooks que el arnés SUMÓ después de ${BASE_REF}, declarados acá: T40 mide que el perfil no cambie
    # lo que había, no que el arnés no crezca. Se apartan del lado actual antes de comparar, y cada uno tiene que estar
    # UNA vez (una declaración que ya no hace falta, sale; registrado dos veces, o en otro evento más, también es rojo).
    # Sin esto, el primer hook nuevo pondría roja la prueba para siempre.
    #   scripts/hooks/public-push-guard.js — el freno antes de publicar
    #   scripts/hooks/owner-email-notice.js — tu correo de git, dicho una vez, con el buzón prendido
    #   scripts/hooks/wait-notice.js — el aviso de que una corrida espera a una persona, en sus seis eventos
    #   scripts/hooks/worktree-sweep.js — el barrido diario de las carpetas de trabajo ya mergeadas
    #   scripts/hooks/unclosed-runs-notice.js — las corridas que quedaron sin cerrar, dicho una vez por día
    #   scripts/hooks/deprecated-read-notice.js — avisa cuando se lee un archivo que el repo declara deprecado
    #   scripts/hooks/deprecated-session-notice.js — los archivos deprecados del repo, dichos al arrancar
    #   scripts/hooks/extension-notices.js — los avisos de las extensiones instaladas, al arrancar
    #   scripts/hooks/guard-update-notice.js — el freno de producción quedó viejo y hay que reinstalarlo
    #   scripts/hooks/dev-behind-main-notice.js — la rama dev atrasada frente a main
    #   scripts/hooks/stuck-pr-notice.js — los pedidos trabados en choque o sin entrar
    #   scripts/hooks/coordination-notice.js — el tope de sesiones, sólo para la coordinadora designada
    # «ruta=N»: registrado N veces (un hook en varios eventos); sin «=N», una.
    T40_ADDED=(scripts/hooks/public-push-guard.js scripts/hooks/owner-email-notice.js scripts/hooks/wait-notice.js=6
      scripts/hooks/worktree-sweep.js scripts/hooks/unclosed-runs-notice.js scripts/hooks/deprecated-read-notice.js
      scripts/hooks/deprecated-session-notice.js scripts/hooks/extension-notices.js scripts/hooks/guard-update-notice.js
      scripts/hooks/dev-behind-main-notice.js scripts/hooks/stuck-pr-notice.js scripts/hooks/coordination-notice.js)
    t40_apart() { # t40_apart <settings> <salida> → aparta los declarados del settings (lo reescribe); en <salida>, los que no están UNA vez
      rm -f "$2"
      python3 - "$1" "$2" "${T40_ADDED[@]}" <<'PY'
import json, sys
path, out = sys.argv[1], sys.argv[2]
want = {a.split("=")[0]: int(a.split("=")[1]) if "=" in a else 1 for a in sys.argv[3:]}
added = list(want)
data = json.load(open(path, encoding="utf-8"))
times = {a: 0 for a in added}
for event, groups in data["hooks"].items():
    for group in groups:
        keep = []
        for hook in group.get("hooks") or []:
            hit = [a for a in added if ("/" + a + '"') in str(hook.get("command", "")) or str(hook.get("command", "")).endswith("/" + a)]
            for a in hit:
                times[a] += 1
            if not hit:
                keep.append(hook)
        group["hooks"] = keep
    data["hooks"][event] = [g for g in groups if g.get("hooks")]
json.dump(data, open(path, "w", encoding="utf-8"), indent=2)
open(out, "w", encoding="utf-8").write("\n".join("%s (%d veces, se esperaban %d)" % (a, n, want[a]) for a, n in times.items() if n != want[a]))
PY
    }
    # El piso en cada hook `.js` del arnés, y `--gate` exactamente en los frenos: `PreToolUse` con `effect: blocks` en
    # la lista de hooks del árbol (la regla de apply-hooks.js `isGate`). Sale 0 si está bien, 1 con lo que falla, y 3
    # si ningún hook lleva el piso (una máquina con el Node propio del arnés: el aplicador no lo usa).
    t40_floor_check() { # t40_floor_check <settings>
      python3 - "$1" "$TREE/scripts/setup/hooks-list.json" <<'PY'
import json, re, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
specs = json.load(open(sys.argv[2], encoding="utf-8"))
specs = specs.get("hooks", specs) if isinstance(specs, dict) else specs
gates = [s["spec"] for s in specs if s.get("event") == "PreToolUse" and s.get("effect") == "blocks"]
def suffix(spec):
    return "/scripts/hooks/" + spec[len("@tcg:"):] if spec.startswith("@tcg:") else "/skills/" + spec
floor = re.compile(r'^node "[^"]*/scripts/lib/node-floor\.js"( --gate)? "([^"]+\.js)"')
bad, floored = [], 0
for event, groups in (data.get("hooks") or {}).items():
    for group in groups:
        for hook in group.get("hooks") or []:
            cmd = str(hook.get("command", ""))
            js = [q for q in re.findall(r'"([^"]+\.js)"', cmd) if not q.endswith("/scripts/lib/node-floor.js")]
            if not js:
                continue
            m = floor.match(cmd)
            if not m:
                bad.append("%s sin el piso: %s" % (event, cmd)); continue
            floored += 1
            gate = event == "PreToolUse" and any(m.group(2).endswith(suffix(g)) for g in gates)
            if bool(m.group(1)) != gate:
                bad.append("%s %s: %s" % (event, "le falta --gate" if gate else "--gate en un hook que no frena", m.group(2)))
if not floored and not bad:
    print("ningún hook lleva el piso de Node"); sys.exit(3)
print("\n".join(bad)); sys.exit(1 if bad else 0)
PY
    }
    t40_floor_norm "$T/t40/new-floor.json" "$T/t40/new-norm.json"
    t40_apart "$T/t40/new-norm.json" "$T/t40/added.out"; PYRC=$?
    # «no pude apartar» no es «aparté»: si el guion falla no deja su archivo, y un archivo que falta no es uno vacío
    if [ "$PYRC" != 0 ] || [ ! -f "$T/t40/added.out" ]; then mal "T40 no pude apartar los hooks sumados después de ${BASE_REF} (el guion salió ${PYRC}): la comparación que sigue no vale"
    elif [ -s "$T/t40/added.out" ]; then mal "T40 un hook declarado como «sumado después» no está UNA vez en lo que deja el aplicador: $(tr '\n' ' ' < "$T/t40/added.out")"
    else ok "T40 los hooks sumados después de ${BASE_REF} están, una vez cada uno, y se apartan de la comparación"; fi
    node "$RAIZ/scripts/publishing/profile-equivalence.js" --settings "$T/t40/old-as-new.json" "$T/t40/new-norm.json" > "$T/t40/eq.out" 2>&1; EQ=$?
    [ "$EQ" = 0 ] && ok "T40 con el perfil del equipo: los mismos hooks que el aplicador de ${BASE_REF}" || mal "T40 hooks distintos (rc $EQ): $(head -c 500 "$T/t40/eq.out")"
    # Team_FloorOnEveryHook_GateOnlyOnBlockers: el lado nuevo tal cual, y dos copias que tienen que salir rojas
    t40_floor_check "$T/t40/new-floor.json" > "$T/t40/floor.out"; FRC=$?
    if [ "$FRC" = 3 ]; then echo "  ⏭   — T40 el piso NO MEDIDO — $(cat "$T/t40/floor.out") (el aplicador corrió con el Node propio del arnés)"
    else
      [ "$FRC" = 0 ] && ok "T40 el piso de Node en cada hook, y --gate sólo en los frenos" || mal "T40 el piso de Node (rc $FRC): $(head -c 500 "$T/t40/floor.out")"
      python3 - "$T/t40/new-floor.json" "$T/t40/floor-sin.json" "$T/t40/floor-gate.json" <<'PY'
import json, re, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
floor = re.compile(r'^node "[^"]*/scripts/lib/node-floor\.js"(?: --gate)? (?=")')
def first(pred):
    for event, groups in data["hooks"].items():
        for group in groups:
            for hook in group.get("hooks") or []:
                if pred(event, str(hook.get("command", ""))):
                    return hook
h = first(lambda e, c: floor.match(c) is not None)
saved = h["command"]; h["command"] = floor.sub("node ", saved)
json.dump(data, open(sys.argv[2], "w", encoding="utf-8"), indent=2); h["command"] = saved
h = first(lambda e, c: e != "PreToolUse" and floor.match(c) is not None and " --gate " not in c)
h["command"] = h["command"].replace('node-floor.js" "', 'node-floor.js" --gate "', 1)
json.dump(data, open(sys.argv[3], "w", encoding="utf-8"), indent=2)
PY
      t40_floor_check "$T/t40/floor-sin.json" > /dev/null; R1=$?
      t40_floor_check "$T/t40/floor-gate.json" > /dev/null; R2=$?
      { [ "$R1" = 1 ] && [ "$R2" = 1 ]; } && ok "T40 el chequeo del piso ve un hook sin el piso y un --gate en un hook que no frena" \
        || mal "T40 el chequeo del piso no ve lo que tiene que ver: sin el piso rc ${R1}, --gate de más rc ${R2} (se esperaba 1 y 1)"
    fi
    # Team_UndeclaredHookStillRed: normalizar el piso y declarar los sumados no esconden un hook de más. Un hook del
    # arnés que nadie declaró, con el piso y sin él, pasa por la misma normalización y el mismo apartado que el caso real
    for v in con sin; do
      python3 - "$T/t40/new-floor.json" "$T/t40/extra-$v.json" "$TREE/scripts/hooks/hook-sin-declarar-lab.js" "$v" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
floor = next(q for groups in data["hooks"].values() for g in groups for h in g.get("hooks") or []
             for q in [str(h.get("command", "")).split('"')[1] if 'node-floor.js"' in str(h.get("command", "")) else None] if q)
head = 'node "%s" ' % floor if sys.argv[4] == "con" else "node "
data["hooks"].setdefault("SessionStart", []).append({"matcher": "", "hooks": [{"type": "command", "command": head + '"%s"' % sys.argv[3]}]})
json.dump(data, open(sys.argv[2], "w", encoding="utf-8"), indent=2)
PY
      t40_floor_norm "$T/t40/extra-$v.json" "$T/t40/extra-$v.json"; t40_apart "$T/t40/extra-$v.json" "$T/t40/extra-$v.added"
      node "$RAIZ/scripts/publishing/profile-equivalence.js" --settings "$T/t40/old-as-new.json" "$T/t40/extra-$v.json" > /dev/null 2>&1; eval "XRC_$v=\$?"
    done
    { [ "$XRC_con" != 0 ] && [ "$XRC_sin" != 0 ]; } && ok "T40 un hook sin declarar sigue saliendo distinto, con el piso y sin él" \
      || mal "T40 un hook sin declarar pasó la comparación: con el piso rc ${XRC_con}, sin él rc ${XRC_sin} (se esperaba distinto de 0)"
    # Team_DeclaredHookCountedExactlyOnce: un declarado dos veces, y uno que falta, salen en la lista de «no está una vez»
    python3 - "$T/t40/new-floor.json" "$T/t40/dup.json" "$T/t40/falta.json" "scripts/hooks/stuck-pr-notice.js" <<'PY'
import copy, json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
name = "/" + sys.argv[4] + '"'
dup, gone = copy.deepcopy(data), copy.deepcopy(data)
for groups in dup["hooks"].values():
    extra = [copy.deepcopy(g) for g in groups if any(name in str(h.get("command", "")) for h in g.get("hooks") or [])]
    groups.extend(extra)
for event, groups in gone["hooks"].items():
    for g in groups:
        g["hooks"] = [h for h in g.get("hooks") or [] if name not in str(h.get("command", ""))]
    gone["hooks"][event] = [g for g in groups if g["hooks"]]
json.dump(dup, open(sys.argv[2], "w", encoding="utf-8"), indent=2)
json.dump(gone, open(sys.argv[3], "w", encoding="utf-8"), indent=2)
PY
    t40_floor_norm "$T/t40/dup.json" "$T/t40/dup.json"; t40_apart "$T/t40/dup.json" "$T/t40/dup.added"
    t40_floor_norm "$T/t40/falta.json" "$T/t40/falta.json"; t40_apart "$T/t40/falta.json" "$T/t40/falta.added"
    { grep -q 'stuck-pr-notice.js (2 veces' "$T/t40/dup.added" && grep -q 'stuck-pr-notice.js (0 veces' "$T/t40/falta.added"; } \
      && ok "T40 un declarado registrado dos veces, o ninguna, no pasa por «una vez cada uno»" \
      || mal "T40 «una vez cada uno» no ve el declarado de más o el que falta: dos veces «$(tr '\n' ' ' < "$T/t40/dup.added")» · ninguna «$(tr '\n' ' ' < "$T/t40/falta.added")»"
    # aparte, lo que el aplicador de entonces no conoce: el bloque del estilo de respuesta, que hoy se elige por
    # variante, y las filas de la tabla de nombres marcadas con su integración, que hoy se escriben sólo si está prendida
    for side in old new; do sed -E 's#(<!-- TYCON_BLOCK:[^ ]+ START) — generado por [^·]*·#\1 — generado por @SYNC@ ·#' "$T/t40/$side/.claude/CLAUDE.md" \
      | sed '/<!-- TYCON_BLOCK:response-style START/,/<!-- TYCON_BLOCK:response-style END/d' > "$T/t40/$side-claude.md"; done
    python3 - "$T/t40/old-claude.md" "$T/t40/new-claude.md" <<'PY'
import re, sys
old_p, new_p = sys.argv[1], sys.argv[2]
old = open(old_p, encoding="utf-8").read().split("\n")
mark = re.compile(r"\s*<!-- integration: [a-z]+ -->\s*$")
rows = {mark.sub("", l).rstrip() for l in old if mark.search(l)}
open(old_p, "w", encoding="utf-8").write("\n".join(l for l in old if not mark.search(l)))
new = open(new_p, encoding="utf-8").read().split("\n")
open(new_p, "w", encoding="utf-8").write("\n".join(l for l in new if mark.sub("", l).rstrip() not in rows))
PY
    cmp -s "$T/t40/old-claude.md" "$T/t40/new-claude.md" && ok "T40 CLAUDE.md byte a byte igual (la descripción de la marca de arranque aparte)" || mal "T40 CLAUDE.md distinto: $(diff "$T/t40/old-claude.md" "$T/t40/new-claude.md" | head -5 | tr '\n' ' ')"
    # Team_ClaudeMd_OtherExtraLineStillRed: sacar la marca de horas del lado viejo no abre la puerta a otra línea de más
    { cat "$T/t40/new-claude.md"; printf '\n<!-- una línea de más -->\n'; } > "$T/t40/new-claude-extra.md"
    ! cmp -s "$T/t40/old-claude.md" "$T/t40/new-claude-extra.md" && ok "T40 una línea de más en el CLAUDE.md sigue saliendo distinta" \
      || mal "T40 el CLAUDE.md con una línea de más pasó por igual"
    [ ! -e "$T/t40/new/.claude/tycon.json" ] && ok "T40 tycon.json sin tocar" || mal "T40 el aplicador escribió tycon.json"
    [ "$(setting "$T/t40/new" cleanupPeriodDays)" = "$(setting "$T/t40/old" cleanupPeriodDays)" ] && ok "T40 los ajustes iguales" || mal "T40 los ajustes cambiaron"
  fi
fi

# ══ La parte del programa (T35 a T37): harness.js de verdad, con el aplicador real ═════════════════════════════════════
# shellcheck source=lib/harness-lab.sh
source "$RAIZ/scripts/tests/lib/harness-lab.sh"   # sólo por harness_lab_pty (la terminal de juguete)
home_hash() { ( cd "$1" && find . -print | LC_ALL=C sort | while IFS= read -r f; do
    if [ -L "$f" ]; then printf '%s -> %s\n' "$f" "$(readlink "$f")"; elif [ -f "$f" ]; then printf '%s ' "$f"; shasum -a 256 < "$f"; else printf '%s/\n' "$f"; fi
  done ) | shasum -a 256 | cut -d' ' -f1; }
# ══ HASH · HomeHash_SeesAStrayFile: la foto ve lo que aparece en la carpeta de inicio ═════════════════════════════════
# (python ya no escribe su caché durante la prueba; la foto no se achica para eso y tiene que seguir viendo lo demás)
if corre HASH; then
  echo "HASH · HomeHash_SeesAStrayFile"
  H="$T/hash"; mkdir -p "$H/.claude"; ANTES="$(home_hash "$H")"
  mkdir -p "$H/Library/Caches/com.apple.python" && : > "$H/Library/Caches/com.apple.python/algo.pyc"
  [ "$(home_hash "$H")" != "$ANTES" ] && ok "HASH la foto cambia con un archivo nuevo en la carpeta de inicio" || mal "HASH la foto no vio el archivo nuevo"
fi
harness() { # harness <salida> <args…> → el programa del árbol de laboratorio con el ambiente aislado; el exit code en RC
  local out="$1"; shift
  RC=0; "${RUN_ENV[@]}" TYCON_GUARD_LIB_FOR_TEST="$T/sin-freno.js" node "$TREE/scripts/setup/harness.js" "$@" > "$out" 2>&1 || RC=$?
}
state_profile() { python3 -c "
import json,sys
try: s=json.load(open(sys.argv[1], encoding='utf-8'))
except Exception: print('sin-estado'); sys.exit(0)
p=s.get('profile') or {}
print('%s|%s' % (p.get('value'), p.get('origin')))" "$1/.claude/.tycon-pipeline/harness-state.json"; }
machine_profile() { python3 -c "
import json,sys
try: print((json.load(open(sys.argv[1], encoding='utf-8')).get('install') or {}).get('profile'))
except Exception: print('sin-archivo')" "$1/.claude/tycon.json"; }

# ══ T35 · install --profile: escribe la clave después de la conformidad; el plan cambia con el perfil ══════════════════
if corre T35; then
  echo "T35 · Install_Profile_WritesKeyAfterConsent_PlanDiffersByProfile_EnvConflictExit2"
  H="$T/t35/home"; new_home "$H"; base "$H"
  harness "$T/t35/dry-min.out" install --dry-run --profile minimal; R1=$RC
  harness "$T/t35/dry-full.out" install --dry-run --profile full; R2=$RC
  if [ "$R1" = 0 ] && [ "$R2" = 0 ] && grep -q 'perfil: minimal (--profile)' "$T/t35/dry-min.out" && grep -q 'perfil: full (--profile)' "$T/t35/dry-full.out" \
     && ! cmp -s <(grep -v '^perfil:' "$T/t35/dry-min.out") <(grep -v '^perfil:' "$T/t35/dry-full.out"); then ok "T35 --dry-run con cada perfil: dos planes distintos, con el perfil en la cabecera"
  else mal "T35 --dry-run por perfil: rc ${R1}/${R2} · $(grep -m1 '^perfil' "$T/t35/dry-min.out") · $(grep -m1 '^perfil' "$T/t35/dry-full.out")"; fi
  # en minimal frenan dos: el freno de comandos destructivos y el portón de edición
  grep -Eq '\(2 pueden frenar' "$T/t35/dry-min.out" && ok "T35 el plan de minimal cuenta dos frenos (el de comandos y el portón de edición)" || mal "T35 el plan de minimal no cuenta dos frenos: $(grep -Em1 'frenar|hooks' "$T/t35/dry-min.out")"
  grep -Eq 'puede(n)? frenar' "$T/t35/dry-full.out" && ok "T35 espejo: el plan de full sí cuenta frenos" || mal "T35 espejo: el plan de full no cuenta frenos (el «ninguno» de minimal no probaría nada)"
  # las tareas de fondo de full no se anuncian en el plan de minimal
  BG='recorre de fondo el historial de git'
  { ! grep -q "$BG" "$T/t35/dry-min.out" && grep -q "$BG" "$T/t35/dry-full.out"; } && ok "T35 el plan de minimal no anuncia las tareas de fondo de full (el de full sí)" \
    || mal "T35 tareas de fondo por perfil: minimal $(grep -c "$BG" "$T/t35/dry-min.out") · full $(grep -c "$BG" "$T/t35/dry-full.out")"
  [ ! -e "$H/.claude/tycon.json" ] && [ ! -e "$H/.claude/.tycon-pipeline" ] && ok "T35 --dry-run --profile no escribe nada" || mal "T35 --dry-run --profile escribió"
  # «n» en la terminal: ni tycon.json. Con `--profile` y terminal se preguntan antes las integraciones y
  # el paquete (Enter y Enter: ninguna, no), y recién después la conformidad
  H="$T/t35/no"; new_home "$H"; base "$H"; ANTES="$(home_hash "$H")"
  harness_lab_pty $'\n\nn' "${RUN_ENV[@]}" node "$TREE/scripts/setup/harness.js" install --profile minimal > "$T/t35/no.out" 2>&1
  { [ "$(home_hash "$H")" = "$ANTES" ] && [ ! -e "$H/.claude/tycon.json" ]; } && ok "T35 con «n» no queda ni tycon.json" || mal "T35 con «n» quedó algo: $(machine_profile "$H") · $(tail -n 2 "$T/t35/no.out" | tr '\n' ' ')"
  # la variable dice otro valor que --profile: 2 nombrando la variable, sin escribir
  H="$T/t35/env"; new_home "$H"; base "$H"; ANTES="$(home_hash "$H")"; RUN_ENV+=(TYCON_INSTALL_PROFILE=full)
  harness "$T/t35/env.out" install --profile minimal --yes
  { [ "$RC" = 2 ] && grep -q 'TYCON_INSTALL_PROFILE' "$T/t35/env.out" && [ "$(home_hash "$H")" = "$ANTES" ]; } && ok "T35 la variable contradice a --profile: 2 nombrando la variable, nada escrito" \
    || mal "T35 variable contra --profile: rc ${RC} · $(head -c 200 "$T/t35/env.out")"
  # --profile minimal --yes: la clave y el estado
  H="$T/t35/min"; new_home "$H"; base "$H"
  harness "$T/t35/min.out" install --profile minimal --yes
  [ "$RC" = 0 ] && ok "T35 install --profile minimal --yes instala" || mal "T35 install --profile minimal --yes salió ${RC}: $(tail -n 4 "$T/t35/min.out" | tr '\n' ' ')"
  [ "$(machine_profile "$H")" = minimal ] && ok "T35 tycon.json con install.profile: minimal" || mal "T35 tycon.json: $(machine_profile "$H")"
  [ "$(state_profile "$H")" = "minimal|maquina" ] && ok "T35 el estado guarda el perfil y su origen" || mal "T35 el estado: $(state_profile "$H")"
  cmp -s <(harness_hooks "$H" "$TREE") <(minimal_hooks) && ok "T35 instaló los hooks de minimal" || mal "T35 hooks tras --profile minimal: $(harness_hooks "$H" "$TREE" | wc -l | tr -d ' ')"
  grep -q 'perfil: minimal' "$T/t35/min.out" && ok "T35 el cierre nombra el perfil" || mal "T35 el cierre no nombra el perfil: $(tail -n 8 "$T/t35/min.out" | tr '\n' ' ')"
  # sin --profile y sin que nadie lo diga: no es «full (sin elegir)» — sin terminal sale 2
  # pidiendo el perfil, también con --yes, y no escribe nada (las preguntas las prueba harness-questions.test.sh)
  H="$T/t35/unset"; new_home "$H"; base "$H"; ANTES="$(home_hash "$H")"
  harness "$T/t35/unset.out" install --yes
  { [ "$RC" = 2 ] && grep -q 'elegí el perfil' "$T/t35/unset.out" && [ "$(home_hash "$H")" = "$ANTES" ]; } && ok "T35 sin --profile y sin terminal: 2 pidiendo el perfil, nada escrito (tanda D)" \
    || mal "T35 sin --profile: rc ${RC} · $(head -n 2 "$T/t35/unset.out" | tr '\n' ' ') · tycon.json $(machine_profile "$H")"
  # con el perfil del equipo: full (perfil), sin tocar tycon.json, y una segunda corrida no pregunta (nada que escribir).
  # La copia pública no trae el perfil del equipo: ahí NO MEDIDO (en el repo interno, que falte sigue siendo rojo).
  if [ ! -f "$TEAM_PROFILE" ] && [ ! -f "$RAIZ/scripts/publishing/public-repos.json" ]; then
    echo "  ⏭   — T35/T40 perfil del equipo: NO MEDIDO en la copia — no trae perfil-equipo.json"
  else
  H="$T/t35/team"; new_home "$H"; base "$H" "$TEAM_PROFILE"
  harness "$T/t35/team.out" install --yes
  { [ "$RC" = 0 ] && grep -q 'perfil: full (perfil)' "$T/t35/team.out" && [ ! -e "$H/.claude/tycon.json" ]; } && ok "T35 el perfil del equipo: full (perfil), sin tocar tycon.json" \
    || mal "T35 perfil del equipo: rc ${RC} · $(grep -m1 'perfil' "$T/t35/team.out")"
  harness_lab_pty - "${RUN_ENV[@]}" node "$TREE/scripts/setup/harness.js" install > "$T/t35/team2.out" 2>&1
  { ! grep -q '¿Instalo?' "$T/t35/team2.out" && grep -q 'sin cambios' "$T/t35/team2.out"; } && ok "T40 máquina del equipo instalada: install no pregunta nada" || mal "T40 máquina del equipo: $(tail -n 3 "$T/t35/team2.out" | tr '\n' ' ')"
  fi
fi

# ══ T36 · el cambio de perfil: de full a minimal quita lo registrado; volver a full lo repone ═══════════════════════════
if corre T36; then
  echo "T36 · Profile_Switch_FullToMinimalRemovesRegistered_BackAdds_IntegrationBringsItsOwn"
  H="$T/t36/home"; new_home "$H"; base "$H"
  harness "$T/t36/full.out" install --profile full --yes
  [ "$RC" = 0 ] || mal "T36 install --profile full salió ${RC}: $(tail -n 3 "$T/t36/full.out" | tr '\n' ' ')"
  # lo ajeno: un hook propio en settings.json y un texto propio en CLAUDE.md
  python3 - "$H/.claude/settings.json" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p, encoding="utf-8"))
s.setdefault("hooks", {}).setdefault("Stop", []).append({"hooks": [{"type": "command", "command": "echo mio"}]})
s["miClave"] = 7
json.dump(s, open(p, "w", encoding="utf-8"), indent=2)
PY
  printf '\nmi texto propio\n' >> "$H/.claude/CLAUDE.md"
  harness "$T/t36/dry.out" install --profile minimal --dry-run
  { grep -q '^quita:' "$T/t36/dry.out" && grep -q 'cleanupPeriodDays\|ajuste' "$T/t36/dry.out"; } && ok "T36 el plan de full a minimal trae «quita:»" || mal "T36 el plan no trae «quita:»: $(head -n 30 "$T/t36/dry.out" | tr '\n' '|' | head -c 500)"
  harness "$T/t36/min.out" install --profile minimal --yes
  [ "$RC" = 0 ] || mal "T36 install --profile minimal salió ${RC}: $(tail -n 4 "$T/t36/min.out" | tr '\n' ' ')"
  cmp -s <(harness_hooks "$H" "$TREE") <(minimal_hooks) && ok "T36 de full a minimal: quedan los hooks de minimal" || mal "T36 hooks tras pasar a minimal: $(harness_hooks "$H" "$TREE" | wc -l | tr -d ' ')"
  [ -z "$(setting "$H" cleanupPeriodDays)" ] && ok "T36 se fueron los dos ajustes" || mal "T36 quedó cleanupPeriodDays"
  [ ! -e "$H/.git-hooks/pre-commit" ] && ok "T36 se fueron los hooks de git" || mal "T36 quedó el pre-commit de git"
  grep -q 'TYCON_BLOCK:response-style START' "$H/.claude/CLAUDE.md" && mal "T36 quedó el bloque de estilo" || ok "T36 se fueron los bloques de full"
  { grep -q '"echo mio"' "$H/.claude/settings.json" && [ "$(setting "$H" miClave)" = 7 ] && grep -q '^mi texto propio$' "$H/.claude/CLAUDE.md"; } && ok "T36 lo ajeno de settings.json y de CLAUDE.md quedó igual" || mal "T36 se perdió algo ajeno"
  REASON="$(python3 -c "
import json,os,sys
d=sys.argv[1]; rs=[]
for n in sorted(os.listdir(d)):
    try: rs.append(json.load(open(os.path.join(d,n,'manifest.json'))).get('reason'))
    except Exception: pass
print(' '.join(str(r) for r in rs))" "$H/.claude/.tycon-pipeline/harness/backups" 2>/dev/null)"
  printf '%s' "$REASON" | grep -w profile >/dev/null && ok "T36 copia de respaldo con reason: profile" || mal "T36 sin copia «profile» (copias: ${REASON})"
  # de vuelta a full: lo repone
  harness "$T/t36/back.out" install --profile full --yes
  { [ "$RC" = 0 ] && [ "$(setting "$H" cleanupPeriodDays)" = 365 ] && [ -f "$H/.git-hooks/pre-commit" ] && grep -q 'TYCON_BLOCK:response-style START' "$H/.claude/CLAUDE.md" \
    && [ "$(harness_hooks "$H" "$TREE" | wc -l | tr -d ' ')" -gt 20 ]; } && ok "T36 de vuelta a full: lo repone todo" || mal "T36 de vuelta a full: rc ${RC} · $(harness_hooks "$H" "$TREE" | wc -l | tr -d ' ') hooks · $(tail -n 3 "$T/t36/back.out" | tr '\n' ' ')"
  # el cambio por archivo: `apply --dry-run` lo muestra antes (qué quita y que el perfil cambia),
  # y el próximo startup lo aplica, con su copia y sin preguntar
  machine "$H" '{ "install": { "profile": "minimal" } }'
  ANTES="$(home_hash "$H")"
  harness "$T/t36/apply-dry.out" apply --dry-run
  { [ "$RC" = 0 ] && grep -q 'pasa de full a minimal' "$T/t36/apply-dry.out" && grep -q '^quita:' "$T/t36/apply-dry.out" && grep -q 'ajustes' "$T/t36/apply-dry.out" && grep -q 'hooks globales de git' "$T/t36/apply-dry.out" && [ "$(home_hash "$H")" = "$ANTES" ]; } \
    && ok "T36 apply --dry-run con el perfil cambiado en el archivo: dice el cambio y lo que quita (ajustes y hooks de git), sin escribir" \
    || mal "T36 apply --dry-run con el cambio pendiente: rc ${RC} · $(tr '\n' '|' < "$T/t36/apply-dry.out" | head -c 500)"
  harness "$T/t36/startup.out" startup
  { [ "$RC" = 0 ] && cmp -s <(harness_hooks "$H" "$TREE") <(minimal_hooks) && [ "$(state_profile "$H")" = "minimal|maquina" ]; } && ok "T36 el cambio por archivo lo aplica el próximo startup" \
    || mal "T36 startup tras cambiar el archivo: rc ${RC} · $(harness_hooks "$H" "$TREE" | wc -l | tr -d ' ') hooks · estado $(state_profile "$H")"
  [ "$(wc -l < "$T/t36/startup.out" | tr -d ' ')" -le 1 ] && ok "T36 startup sigue en una línea como mucho" || mal "T36 startup imprimió $(wc -l < "$T/t36/startup.out" | tr -d ' ') líneas"
  # un paso apagado a mano no se lee como «no es del perfil nuevo»: con TYCON_NO_COMMANDS_SYNC=1 los comandos no se
  # reportan, y el cambio de full a minimal NO los borra (están en los dos perfiles)
  H="$T/t36/optout"; new_home "$H"; base "$H"
  harness "$T/t36/oo1.out" install --profile full --yes
  N_CMD="$(ls "$H/.claude/commands/"*.md 2>/dev/null | wc -l | tr -d ' ')"
  RUN_ENV+=(TYCON_NO_COMMANDS_SYNC=1)
  harness "$T/t36/oo2.out" install --profile minimal --yes
  { [ "$RC" = 0 ] && [ "${N_CMD:-0}" -gt 0 ] && [ "$(ls "$H/.claude/commands/"*.md 2>/dev/null | wc -l | tr -d ' ')" = "$N_CMD" ] && [ -z "$(setting "$H" cleanupPeriodDays)" ]; } \
    && ok "T36 con los comandos apagados a mano, pasar a minimal no los borra (y sí quita lo de full)" \
    || mal "T36 opt-out en el cambio: rc ${RC} · comandos ${N_CMD} → $(ls "$H/.claude/commands/"*.md 2>/dev/null | wc -l | tr -d ' ') · cleanupPeriodDays «$(setting "$H" cleanupPeriodDays)»"
  # una integración prendida trae lo suyo también en minimal
  H="$T/t36/engram"; new_home "$H"; base "$H"; RUN_ENV+=(TYCON_ENGRAM=1)
  harness "$T/t36/engram.out" install --profile minimal --yes
  { [ "$RC" = 0 ] && harness_hooks "$H" "$TREE" | grep 'engram-pre-commit.sh' >/dev/null && harness_hooks "$H" "$TREE" | grep 'engram-drift-notice.js' >/dev/null; } && ok "T36 engram prendida en minimal: sus hooks están" \
    || mal "T36 engram en minimal: rc ${RC} · $(harness_hooks "$H" "$TREE" | grep engram | tr '\n' ' ')"
fi

# ══ T37 · un perfil inválido: por opción, en el archivo o en la variable ═══════════════════════════════════════════════
if corre T37; then
  echo "T37 · Profile_Invalid_OptionFileEnv_Exit2NothingWritten"
  H="$T/t37/opt"; new_home "$H"; base "$H"; ANTES="$(home_hash "$H")"
  harness "$T/t37/opt.out" install --profile medio --yes
  { [ "$RC" = 2 ] && grep -q 'perfil «medio»: tiene que ser minimal o full' "$T/t37/opt.out" && [ "$(home_hash "$H")" = "$ANTES" ]; } && ok "T37 --profile medio: 2 con los dos válidos, nada escrito" || mal "T37 --profile medio: rc ${RC} · $(head -c 200 "$T/t37/opt.out")"
  # `--profile` con `--from-existing` (esa corrida no aplica nada): 2, no se ignora en silencio
  harness "$T/t37/fe.out" install --from-existing --profile minimal
  { [ "$RC" = 2 ] && grep -q -- '--profile no va con --from-existing' "$T/t37/fe.out" && [ "$(home_hash "$H")" = "$ANTES" ]; } && ok "T37 --profile con --from-existing: 2, nada escrito" \
    || mal "T37 --profile con --from-existing: rc ${RC} · $(head -c 200 "$T/t37/fe.out")"
  H="$T/t37/file"; new_home "$H"; machine "$H" '{ "install": { "profile": "medio" } }'; base "$H"; ANTES="$(home_hash "$H")"
  harness "$T/t37/file.out" install --yes
  { [ "$RC" = 2 ] && grep -q 'tycon.json' "$T/t37/file.out" && grep -q 'install.profile' "$T/t37/file.out" && grep -q 'minimal, full' "$T/t37/file.out" && [ "$(home_hash "$H")" = "$ANTES" ]; } \
    && ok "T37 el valor inválido en el archivo: 2 con archivo, clave y motivo, nada escrito" || mal "T37 archivo inválido: rc ${RC} · $(head -c 300 "$T/t37/file.out")"
  H="$T/t37/env"; new_home "$H"; base "$H"; RUN_ENV+=(TYCON_INSTALL_PROFILE=medio); ANTES="$(home_hash "$H")"
  harness "$T/t37/env.out" install --yes
  { [ "$RC" = 2 ] && grep -q 'TYCON_INSTALL_PROFILE' "$T/t37/env.out" && [ "$(home_hash "$H")" = "$ANTES" ]; } && ok "T37 la variable inválida: 2 nombrándola, nada escrito" || mal "T37 variable inválida: rc ${RC} · $(head -c 200 "$T/t37/env.out")"
  # startup con la configuración rota: sale 0 con su aviso
  H="$T/t37/startup"; new_home "$H"; base "$H"; harness "$T/t37/s1.out" install --profile full --yes
  machine "$H" '{ "install": { "profile": "medio" } }'
  harness "$T/t37/s2.out" startup
  NOTICE="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1], encoding='utf-8')).get('notice') or '')" "$H/.claude/.tycon-pipeline/harness-state.json" 2>/dev/null)"
  { [ "$RC" = 0 ] && printf '%s' "$NOTICE" | grep 'perfil' >/dev/null; } && ok "T37 startup con el perfil roto: 0 con su aviso" || mal "T37 startup con el perfil roto: rc ${RC} · aviso «${NOTICE}»"
  # el freno de producción instalado con un lector que no conoce la sección: el aviso de setKey, y sigue
  printf "const VOCABULARIO = Object.freeze({ ado: Object.freeze({ org: 'texto' }) });\n" > "$T/freno-viejo.js"
  H="$T/t37/guard"; new_home "$H"; base "$H"
  RC=0; "${RUN_ENV[@]}" TYCON_GUARD_LIB_FOR_TEST="$T/freno-viejo.js" node "$TREE/scripts/setup/harness.js" install --profile minimal --yes > "$T/t37/guard.out" 2>&1 || RC=$?
  { [ "$RC" = 0 ] && grep -q 'freno de producción' "$T/t37/guard.out" && grep -q 'install-guard.sh' "$T/t37/guard.out"; } && ok "T37 un freno instalado que no conoce la sección: el aviso con el comando, y sigue" \
    || mal "T37 aviso del freno: rc ${RC} · $(grep -m1 'freno' "$T/t37/guard.out")"
fi

# ══ REG · regresiones que piden el aplicador de juguete ═════════════════════════════
# un cambio de perfil sin el reporte de piezas del aplicador no sabe qué sobra: no quita nada, y por eso
# tampoco anota el perfil nuevo — el arranque siguiente, con reporte, lo reintenta. Si lo anotara igual, lo de full
# que el aplicador no saca solo (los ajustes, los hooks de git) quedaría para siempre.
if corre REG; then
  echo "REG · el cambio de perfil sin reporte no se da por hecho"
  OUT="$( (
    harness_lab_create "$T/reg-lab" >/dev/null || { echo "MAL no pude armar el laboratorio"; exit 0; }
    H="node $LAB_TREE/scripts/setup/harness.js"
    $H install --yes >/dev/null 2>&1 || echo "MAL install previo"
    printf '{ "install": { "profile": "minimal" } }\n' > "$LAB_HOME/.claude/tycon.json"
    st() { python3 -c "import json,sys; print((json.load(open(sys.argv[1])).get('profile') or {}).get('value'))" "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"; }
    LAB_APPLIER_NO_REPORT=1 $H startup >/dev/null 2>&1
    echo "SIN-REPORTE $(st)"
    $H startup >/dev/null 2>&1
    echo "CON-REPORTE $(st)"
  ) 2>&1 )"
  case "$OUT" in *"MAL"*) mal "REG laboratorio: $OUT" ;; esac
  printf '%s\n' "$OUT" | grep '^SIN-REPORTE full$' >/dev/null && ok "REG sin reporte, el perfil nuevo no se anota (queda full: se reintenta)" || mal "REG sin reporte: $(printf '%s' "$OUT" | tr '\n' ' ')"
  printf '%s\n' "$OUT" | grep '^CON-REPORTE minimal$' >/dev/null && ok "REG …y el arranque siguiente, con reporte, lo completa" || mal "REG con reporte: $(printf '%s' "$OUT" | tr '\n' ' ')"
fi

echo
if [ "$FALLOS" -gt 0 ]; then echo "FALLARON $FALLOS chequeo(s)"; exit 1; fi
echo "todo verde"; exit 0
