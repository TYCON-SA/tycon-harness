#!/usr/bin/env bash
# harness-plan.test.sh — el plan antes de escribir (story 8.16, tanda B · AC 3, 11, 13 a 17 · T14, T15, T17 a T22).
#
# Lo que no se puede perder:
#   T15 · el aplicador REAL con `--check --plan-json <archivo>` escribe `[{kind, where, id, action}]` y nada más: en una
#         HOME vacía todo es `add`; después de instalar, todo `keep` (y cada pieza del reporte está en el plan); con un
#         hook viejo de más, un `remove`; la HOME idéntica por hash en los tres; `--plan-json` sin `--check` sale 2 con una
#         línea; la salida de `--check` es la misma con y sin la opción.
#   T17 · el plan dice la verdad: lo que `install --dry-run` anuncia es lo que `install --yes` deja (aplicador real).
#   T14 · ninguna salida sin conformidad escribe: `--dry-run` (0), «n» en la terminal (0), sin terminal (2), fin de
#         entrada en la terminal (0), una opción inválida (2): la HOME igual por hash y sin ~/.claude/.tycon-pipeline/.
#   T18 · con terminal pregunta UNA vez y con «s» instala; la segunda corrida dice «sin cambios» y no pregunta.
#   T19 · sin terminal y sin `--yes`: 2 con el plan y la línea; con `--yes` instala; `--from-existing` no pregunta;
#         `--dry-run --yes` no escribe (gana `--dry-run`).
#   T20 · una lista de efectos rota o ausente: 2 nombrando el archivo; un aplicador que no sabe mostrar su plan: el plan
#         lo dice y la conformidad se pide igual; un `--check` que sale 1 o deja un JSON roto: 2 «no pude armar el plan».
#         Nunca se lee como «no cambia nada», y la HOME queda igual.
#   T21 · si otra instalación termina mientras ésta espera la respuesta: 3, «la instalación cambió mientras
#         confirmabas», y nada escrito por la primera; en el caso normal la copia de respaldo es posterior a la respuesta.
#   T22 · `apply --dry-run` muestra lo que el aplicador repondría (un hook borrado a mano) sin escribir; `apply` lo repone
#         sin preguntar.
#
# Laboratorio: scripts/tests/lib/harness-lab.sh (aplicador de juguete; T14, T18 a T22) y, para T15 y T17, el aplicador
# REAL sobre una copia descartable del árbol y una HOME de juguete (el patrón de harness-uninstall.test.sh). Nunca
# ~/.claude ni el checkout real. 🔴 Sin pipes sobre el comando medido: el exit code REAL es el veredicto.
#
#   REG · las regresiones del pase adversarial de la tanda B: una reparación anunciada se hace (1); el plan trae el
#         despliegue de Codex (2), las skills de terceros con la ruta del reporte (3), lo que install escribe en la copia
#         fija y la línea de arranque (4), el git pull que el aplicador reescribe (5); armar el plan no escribe nada aunque
#         tycon.json use un nombre viejo (7); --dry-run --channel latest no pregunta (9); y apply --dry-run dice que la
#         lista de efectos está rota (revisor de alcance).
#   REG-PIPE · preguntarle algo al plan no depende de qué proceso termina primero (2026-10-10, ver `plan_has`).
#
# Uso: bash scripts/tests/harness-plan.test.sh [--only T15|T17|T14|T18|T19|T20|T21|T22|REG]
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIX="$RAIZ/scripts/tests/fixtures/harness-managed-pieces.json"
ONLY=""; [ "${1:-}" = "--only" ] && ONLY="${2:-}"
corre() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
T="$(mktemp -d "${TMPDIR:-/tmp}/harness-plan.XXXXXX")"
case "$T" in *tycon-claude-guides*|*agent-skills*|*/.claude*) echo "❌ harness-plan: el laboratorio cayó en ${T}"; exit 1 ;; esac
trap 'rm -rf "$T"' EXIT
ORIG_TMPDIR="${TMPDIR:-/tmp}"
j() { python3 -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print($2)" "$1" 2>/dev/null; }

# ══ La parte REAL (T15, T17): el aplicador de verdad sobre una copia del árbol y una HOME de juguete ══════════════════
lab_tree() { # lab_tree <dir> → una copia del árbol bajo prueba, con git propio
  rm -rf "$1"; mkdir -p "$1"
  ( cd "$RAIZ" && tar cf - --exclude=scripts/tests --exclude=node_modules scripts claude-md-blocks commands README.md ) | ( cd "$1" && tar xf - )
  lab_commit "$1" "arbol de laboratorio"
}
# lab_commit <repo> <mensaje> → git init + un commit, con fecha fija y SIN el mantenimiento automático de git.
# 🔴 Sin `maintenance.auto=false`, el commit deja corriendo de fondo un `git maintenance run --auto --detach` que crea y
#    borra `.git/objects/maintenance.lock` unos milisegundos después de que el commit volvió. Si en ese momento T15 saca
#    su huella de la HOME, ve el candado; cuando lista las rutas para decir qué cambió, ya no está: rojo «la HOME cambió»
#    con la lista vacía (main, 15/10, Node 22 y 24). Medido con git 2.56: 11 de cada 100 commits dejan el candado a la
#    vista; con git 2.50 (Mac), ninguno. Es la misma clase que harness_lab_git apaga en el laboratorio común (story 8.38).
lab_commit() {
  env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=Lab GIT_AUTHOR_EMAIL=lab@example.com \
    GIT_COMMITTER_NAME=Lab GIT_COMMITTER_EMAIL=lab@example.com \
    GIT_AUTHOR_DATE=2026-10-15T00:00:00Z GIT_COMMITTER_DATE=2026-10-15T00:00:00Z sh -c \
    'git -C "$1" init -q -b main && git -C "$1" add -A && git -C "$1" -c core.hooksPath=/dev/null -c maintenance.auto=false -c gc.auto=0 commit -q -m "$2"' _ "$1" "$2"
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
  lab_commit "$1/.claude/agent-skills" "agent-skills de laboratorio"
}
ENV_UNSET=(-u TYCON_SETTINGS_PATH -u CLAUDE_MD_PATH -u CODEX_AGENTS_MD_PATH -u TYCON_HARNESS_SNAPSHOT_DIR -u TYCON_REPORT_PIECES
     -u TYCON_PLAN_PIECES -u TYCON_HARNESS_LOCK_HELD -u TYCON_HARNESS_SHARED_DONE -u TYCON_NO_AUTOINSTALL -u TYCON_NO_CLAUDEMD_SYNC
     -u TYCON_NO_COMMANDS_SYNC -u TYCON_NO_GIT_HOOKS -u TYCON_THIRD_PARTY -u TYCON_ENGRAM_HOOK -u TYCON_SAFETY_GUARD
     -u TYCON_TEST_SCOPE_GUARD -u TYCON_SESSION_GUARD -u TYCON_TG_ZOMBIE_SWEEP -u TYCON_CLOCKIFY -u TYCON_ENGRAM -u TYCON_NIGHTLY
     -u TYCON_ADO_ORG -u ADO_ORG -u TYCON_REPOS_ROOT -u TF_BUILD -u XDG_CONFIG_HOME -u TYCON_GUIDES_DIR -u TYCON_SKILLS_DIR)
base() { # base <home> → el ambiente aislado (en el arreglo RUN_ENV)
  RUN_ENV=(env "${ENV_UNSET[@]}" HOME="$1" USERPROFILE="$1" TYCON_PROFILE=0 TYCON_INSTALL_PROFILE=full TYCON_CODEX=0 CODEX_HOME="$1/.codex" TYCON_GIT_HOOKS_DIR="$1/.git-hooks"
       TYCON_NO_NIGHTLY_EXAM=1 TYCON_NO_GUI_ENV=1 LAUNCHCTL_BIN=/usr/bin/true TYCON_BENCH_DAILY=0 TYCON_STAGE_METRICS=0
       TYCON_NO_THREAD_RESCUE=1 TYCON_NO_UPLOAD_RUNS=1 TYCON_NO_DOWNLOAD_RUNS=1 TYCON_NO_COLLECT_FINDINGS=1
       TYCON_MAILBOX_URL_BASE=http://127.0.0.1:9 TYCON_NO_AZ_PROJECTS_REFRESH=1 TYCON_NO_ENGRAM_VERSION_CHECK=1
       TYCON_NO_SQLITE_CHECK=1 TYCON_NO_ENGRAM_PROJECT_CHECK=1 TYCON_NO_AGENTSMD_POINTER=1 TYCON_NO_CANONICAL_PATH=1
       TYCON_THIRD_PARTY=0 TYCON_UPDATE=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null TMPDIR="$T/tmp"
       GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false GIT_CONFIG_KEY_1=gc.auto GIT_CONFIG_VALUE_1=0)
  mkdir -p "$T/tmp"
}
home_list() { # todo el HOME, una línea por ruta (enlace, archivo con su suma, carpeta)
  ( cd "$1" && find . -print | LC_ALL=C sort | while IFS= read -r f; do
      if [ -L "$f" ]; then printf '%s -> %s\n' "$f" "$(readlink "$f")"
      elif [ -f "$f" ]; then printf '%s ' "$f"; shasum -a 256 < "$f"
      else printf '%s/\n' "$f"; fi
    done )
}
home_hash() { home_list "$1" | shasum -a 256 | cut -d' ' -f1; }   # un hash de todo el HOME: «no tocó nada»
# home_changed <antes.txt> <home> → las rutas que cambiaron (para que un «la HOME cambió» diga QUÉ cambió)
home_changed() { home_list "$2" > "$1.despues"; diff "$1" "$1.despues" | grep '^[<>]' | sed 's/ [0-9a-f]\{64\}  *-$//' | head -6 | tr '\n' ' '; }
# plan_actions <plan.json> → «kind id action» por línea, ordenado (para comparar y contar)
plan_actions() { python3 -c "
import json,sys
for p in json.load(open(sys.argv[1], encoding='utf-8')): print('%s %s %s' % (p['kind'], p['id'], p['action']))" "$1" | LC_ALL=C sort; }
# plan_has <plan.json> <patrón> → sale 0 si alguna línea de plan_actions coincide
# plan_all <plan.json> <patrón> → sale 0 si el plan tiene líneas y TODAS coinciden
# 🔴 Primero se escribe la lista ENTERA a un archivo y después se busca en él. Nunca `plan_actions … | grep -q`: con el
#    `pipefail` de arriba, `grep -q` sale en su primer acierto y cierra la tubería, y si el `sort` de plan_actions todavía
#    no terminó de escribir muere por la tubería cerrada (141): la tubería da FALSO con el dato presente. Pasa cuando la
#    lista no entra en una sola escritura (sort escribe de a 4096 bytes en Linux; el plan con Codex mide ~4900) y la
#    máquina está cargada. Era REG-2, roja en cuatro validaciones de ramas que no la tocaban (12521, 12577, 12742, 12750)
#    y siempre verde en una Mac, donde sort escribe todo junto. Medido con la consulta de antes sobre ese plan, en Linux
#    con dos núcleos ocupados: 19 falsos en 300 vueltas. Lo cuida REG-PIPE, abajo.
plan_has() { plan_actions "$1" > "$T/plan-actions.txt" && grep -q -- "$2" "$T/plan-actions.txt"; }
plan_all() { plan_actions "$1" > "$T/plan-actions.txt" && [ -s "$T/plan-actions.txt" ] && ! grep -qv -- "$2" "$T/plan-actions.txt"; }
# plan_shape <plan.json> → sale 0 si es un arreglo de {kind, where, id, action} con action del vocabulario
plan_shape() { python3 -c "
import json,sys
d=json.load(open(sys.argv[1], encoding='utf-8'))
assert isinstance(d, list) and d, 'no es un arreglo con piezas'
for p in d:
    assert set(['kind','where','id','action']) <= set(p), p
    assert p['action'] in ('add','update','remove','keep'), p
" "$1"; }

if corre T15; then
  echo "T15 · Applier_CheckPlanJson_EveryPieceWithAction_WritesNothing_Exit2WithoutCheck"
  A="$T/t15/tree"; H="$T/t15/home"; lab_tree "$A"; new_home "$H"; base "$H"
  INST="$A/scripts/install-tycon-hooks.sh"
  # (a) HOME vacía: todo add, nada escrito
  # una sola foto: la huella sale de la misma lista que después se compara (así un rojo siempre dice QUÉ cambió)
  home_list "$H" > "$T/t15/home-antes.txt"; ANTES="$(shasum -a 256 < "$T/t15/home-antes.txt" | cut -d' ' -f1)"
  RC=0; "${RUN_ENV[@]}" bash "$INST" --check --plan-json "$T/t15/plan-empty.json" > "$T/t15/check-empty.out" 2>&1 || RC=$?
  if [ "$RC" = 0 ] && plan_shape "$T/t15/plan-empty.json" 2>/dev/null && plan_all "$T/t15/plan-empty.json" ' add$'; then
    ok "T15 HOME vacía: el plan trae $(plan_actions "$T/t15/plan-empty.json" | wc -l | tr -d ' ') piezas, todas «add»"
  else mal "T15 HOME vacía: salió ${RC}; plan: $(head -c 300 "$T/t15/plan-empty.json" 2>/dev/null) · $(tail -n 3 "$T/t15/check-empty.out" | tr '\n' ' ')"; fi
  [ "$(home_hash "$H")" = "$ANTES" ] && ok "T15 HOME vacía: --check --plan-json no escribió nada en la HOME" || mal "T15 HOME vacía: la HOME cambió con --check --plan-json: $(home_changed "$T/t15/home-antes.txt" "$H")"
  for k in hook setting block command git-hook; do
    plan_has "$T/t15/plan-empty.json" "^${k} " && ok "T15 el plan cubre las piezas «${k}»" || mal "T15 el plan no trae ninguna pieza «${k}»"
  done
  # (b) la salida de --check es la misma con y sin la opción
  RC=0; "${RUN_ENV[@]}" bash "$INST" --check > "$T/t15/check-plain.out" 2>&1 || RC=$?
  if [ "$RC" = 0 ] && cmp -s "$T/t15/check-plain.out" "$T/t15/check-empty.out"; then ok "T15 la salida de --check es byte a byte la misma con y sin --plan-json"
  else mal "T15 la salida de --check cambia con --plan-json (rc ${RC}): $(diff "$T/t15/check-plain.out" "$T/t15/check-empty.out" | head -5 | tr '\n' ' ')"; fi
  # (c) --plan-json sin --check: 2 con una línea, nada escrito
  ANTES="$(home_hash "$H")"
  RC=0; "${RUN_ENV[@]}" bash "$INST" --plan-json "$T/t15/plan-nocheck.json" > "$T/t15/nocheck.out" 2>&1 || RC=$?
  if [ "$RC" = 2 ] && [ "$(wc -l < "$T/t15/nocheck.out" | tr -d ' ')" = 1 ] && grep -q -- '--check' "$T/t15/nocheck.out" && [ ! -e "$T/t15/plan-nocheck.json" ] && [ "$(home_hash "$H")" = "$ANTES" ]; then
    ok "T15 --plan-json sin --check sale 2 con una línea y no escribe"
  else mal "T15 --plan-json sin --check: salió ${RC} con «$(head -c 200 "$T/t15/nocheck.out")»"; fi
  # (d) instalado (aplicador suelto, con su reporte): todo keep, y cada pieza del reporte está en el plan
  mkdir -p "$H/.claude/.tycon-pipeline"; echo '{}' > "$H/.claude/.tycon-pipeline/harness-state.json"   # sin from-existing
  RC=0; "${RUN_ENV[@]}" bash "$INST" --report-json "$T/t15/report.json" > "$T/t15/install.out" 2>&1 || RC=$?
  [ "$RC" = 0 ] || mal "T15 el aplicador real no instaló (rc ${RC}): $(tail -n 3 "$T/t15/install.out" | tr '\n' ' ')"
  ANTES="$(home_hash "$H")"
  RC=0; "${RUN_ENV[@]}" bash "$INST" --check --plan-json "$T/t15/plan-installed.json" > /dev/null 2>&1 || RC=$?
  NOT_KEEP="$(plan_actions "$T/t15/plan-installed.json" 2>/dev/null | grep -v ' keep$')"
  if [ "$RC" = 0 ] && [ -z "$NOT_KEEP" ]; then ok "T15 instalado: todo «keep»"
  else mal "T15 instalado: salió ${RC}; no son keep: $(printf '%s' "$NOT_KEEP" | head -5 | tr '\n' ';')"; fi
  [ "$(home_hash "$H")" = "$ANTES" ] && ok "T15 instalado: --check --plan-json no escribió nada" || mal "T15 instalado: la HOME cambió con --check --plan-json"
  MISSING="$(python3 - "$T/t15/report.json" "$T/t15/plan-installed.json" <<'PY'
import json, sys
rep = json.load(open(sys.argv[1], encoding="utf-8")); plan = json.load(open(sys.argv[2], encoding="utf-8"))
have = {(p["kind"], p["where"], p["id"]) for p in plan}
print("\n".join("%s %s" % (p["kind"], p["id"]) for p in rep if (p["kind"], p["where"], p["id"]) not in have))
PY
)"
  [ -z "$MISSING" ] && ok "T15 cada pieza del reporte del aplicador está en el plan (mismo kind, where e id)" || mal "T15 piezas del reporte que el plan no trae: $(printf '%s' "$MISSING" | head -5 | tr '\n' ';')"
  # (e) un hook viejo que el aplicador saca (uno que absorbió el despachador de ediciones): un «remove»
  python3 - "$H/.claude/settings.json" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p, encoding="utf-8"))
s.setdefault("hooks", {}).setdefault("PostToolUse", []).append({"matcher": "Edit|Write", "hooks": [{"type": "command", "command": 'node "/viejo/agent-skills/skills/tycon-pipeline/scripts/on-edit.js"'}]})
json.dump(s, open(p, "w", encoding="utf-8"), indent=2)
PY
  ANTES="$(home_hash "$H")"
  RC=0; "${RUN_ENV[@]}" bash "$INST" --check --plan-json "$T/t15/plan-stale.json" > /dev/null 2>&1 || RC=$?
  N_REMOVE="$(plan_actions "$T/t15/plan-stale.json" 2>/dev/null | grep -c ' remove$')"
  [ "$RC" = 0 ] && [ "${N_REMOVE:-0}" -ge 1 ] && ok "T15 con un hook viejo de más: el plan trae ${N_REMOVE} «remove»" || mal "T15 con un hook viejo de más: salió ${RC} y ${N_REMOVE:-0} remove"
  [ "$(home_hash "$H")" = "$ANTES" ] && ok "T15 con un hook viejo: --check --plan-json no lo sacó (no escribe)" || mal "T15 con un hook viejo: la HOME cambió"
fi

# ── T17: el plan dice la verdad (aplicador real) ─────────────────────────────────────────────────────────────────────
if corre T17; then
  echo "T17 · Install_DryRun_PlanEqualsWhatInstallWrites"
  A="$T/t17/tree"; H="$T/t17/home"; lab_tree "$A"; new_home "$H"; base "$H"
  # el plan como datos: la misma función que imprime `install --dry-run`, llamada como módulo
  PLAN_OUT="$("${RUN_ENV[@]}" node -e '
const H = require(process.argv[1]);
const r = H.installPlan({ tree: process.argv[2], home: process.env.HOME, env: process.env, opts: {}, args: [], platform: process.platform });
if (!r || !r.ok) { console.error(JSON.stringify(r && r.lines)); process.exit(1); }
console.log(JSON.stringify(r.plan.pieces));' "$A/scripts/setup/harness.js" "$A" 2>"$T/t17/plan.err")"; RC=$?
printf '%s\n' "$PLAN_OUT" > "$T/t17/plan.json"
  [ "$RC" = 0 ] && plan_shape "$T/t17/plan.json" 2>/dev/null && ok "T17 installPlan devuelve las piezas con su acción" || mal "T17 installPlan: rc ${RC} · $(head -c 300 "$T/t17/plan.err")"
  RC=0; "${RUN_ENV[@]}" node "$A/scripts/setup/harness.js" install --dry-run > "$T/t17/dry.out" 2>&1 || RC=$?
  grep -q '^escribe:' "$T/t17/dry.out" && [ "$RC" = 0 ] && ok "T17 install --dry-run imprime el plan y sale 0" || mal "T17 install --dry-run: salió ${RC}: $(head -n 3 "$T/t17/dry.out" | tr '\n' ' ')"
  RC=0; "${RUN_ENV[@]}" node "$A/scripts/setup/harness.js" install --yes > "$T/t17/install.out" 2>&1 || RC=$?
  [ "$RC" = 0 ] && ok "T17 install --yes instala" || mal "T17 install --yes salió ${RC}: $(tail -n 4 "$T/t17/install.out" | tr '\n' ' ')"
  VERDICT="$(python3 - "$T/t17/plan.json" "$H/.claude/.tycon-pipeline/harness-state.json" <<'PY'
import json, os, sys
plan = json.load(open(sys.argv[1], encoding="utf-8")); state = json.load(open(sys.argv[2], encoding="utf-8"))
inplan = {(p["kind"], p["where"], p["id"]): p["action"] for p in plan}
bad = []
for m in state.get("managed", []):
    k = (m["kind"], m["where"], m["id"])
    if inplan.get(k) not in ("add", "update", "keep"):
        bad.append("en la máquina y no en el plan: %s %s" % (m["kind"], m["id"]))
managed = {(m["kind"], m["where"], m["id"]) for m in state.get("managed", [])}
for k, a in inplan.items():
    # lo que el plan declara que puede faltar: las skills de terceros sin red (salen como pendientes)
    if a == "add" and k not in managed and k[0] not in ("third-party", "state", "link"):
        bad.append("el plan dijo add y no quedó: %s %s" % (k[0], k[2]))
print("\n".join(bad))
PY
)"
  [ -z "$VERDICT" ] && ok "T17 cada pieza que quedó estaba en el plan, y cada «add» del plan quedó" || mal "T17 el plan no dijo la verdad: $(printf '%s' "$VERDICT" | head -6 | tr '\n' ';')"
fi

# ══ La parte de juguete (T14, T18 a T22): harness.js real, aplicador de mentira ══════════════════════════════════════
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
fresh_lab() { # fresh_lab <nombre> → un laboratorio nuevo, sin ~/.claude/.tycon-pipeline (una máquina que nunca instaló)
  harness_lab_create "$T/lab-$1" >/dev/null || { mal "no se pudo armar el laboratorio $1"; return 1; }
  rm -rf "$LAB_HOME/.claude/.tycon-pipeline"
}
home_now() { harness_lab_home_hash; }

if corre T14; then
  echo "T14 · Install_NoConsent_HomeIdentical_DryRunNoAnswerNoTtyEof"
  fresh_lab t14 || true
  ANTES="$(home_now)"
  for caso in "dry-run|0" "n|0" "notty|2" "eof|0" "invalid|2"; do
    name="${caso%%|*}"; want="${caso##*|}"; RC=0
    case "$name" in
      dry-run) harness install --dry-run > "$T/t14-$name.out" 2>&1 < /dev/null || RC=$? ;;
      n)       harness_lab_pty n harness install > "$T/t14-$name.out" 2>&1 || RC=$? ;;
      notty)   harness install > "$T/t14-$name.out" 2>&1 < /dev/null || RC=$? ;;
      eof)     harness_lab_pty EOF harness install > "$T/t14-$name.out" 2>&1 || RC=$? ;;
      invalid) harness install --sí > "$T/t14-$name.out" 2>&1 < /dev/null || RC=$? ;;
    esac
    if [ "$RC" = "$want" ] && [ "$(home_now)" = "$ANTES" ] && [ ! -e "$LAB_HOME/.claude/.tycon-pipeline" ]; then
      ok "T14 ${name}: sale ${RC}, la HOME igual por hash y sin ~/.claude/.tycon-pipeline/"
    else mal "T14 ${name}: salió ${RC} (esperaba ${want}); HOME $( [ "$(home_now)" = "$ANTES" ] && echo igual || echo CAMBIADA ); $(tail -n 2 "$T/t14-$name.out" | tr '\n' ' ')"; fi
  done
  grep -q '¿Instalo? \[s/N\]' "$T/t14-n.out" && grep -q 'no se instaló nada' "$T/t14-n.out" && ok "T14 con «n»: pregunta y dice «no se instaló nada»" || mal "T14 con «n»: $(tr '\n' ' ' < "$T/t14-n.out" | tail -c 300)"
  ! grep -q '¿Instalo?' "$T/t14-notty.out" && grep -q 'sin `--yes` y sin terminal no escribo nada' "$T/t14-notty.out" && ok "T14 sin terminal: el plan y la línea, sin pregunta" || mal "T14 sin terminal: $(tail -n 3 "$T/t14-notty.out" | tr '\n' ' ')"
fi

if corre T18; then
  echo "T18 · Install_Tty_AsksOnce_YesInstalls_NothingToWriteDoesNotAsk"
  fresh_lab t18 || true
  RC=0; harness_lab_pty s harness install > "$T/t18-1.out" 2>&1 || RC=$?
  N="$(grep -c '¿Instalo? \[s/N\]' "$T/t18-1.out")"
  if [ "$RC" = 0 ] && [ "$N" = 1 ] && [ -f "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json" ] && grep -q 'qué quedó:' "$T/t18-1.out"; then
    ok "T18 con terminal: una pregunta, «s» instala (estado y cierre)"
  else mal "T18 con terminal: salió ${RC}, ${N} preguntas: $(tail -n 4 "$T/t18-1.out" | tr '\n' ' ')"; fi
  grep -q '^escribe:' "$T/t18-1.out" && ok "T18 el plan se imprime antes de la pregunta" || mal "T18 sin plan antes de preguntar"
  RC=0; harness_lab_pty - harness install > "$T/t18-2.out" 2>&1 || RC=$?
  if [ "$RC" = 0 ] && grep -q 'sin cambios' "$T/t18-2.out" && ! grep -q '¿Instalo?' "$T/t18-2.out"; then ok "T18 segunda corrida: «sin cambios» y no pregunta"
  else mal "T18 segunda corrida: salió ${RC}: $(tail -n 3 "$T/t18-2.out" | tr '\n' ' ')"; fi
fi

if corre T19; then
  echo "T19 · Install_NoTty_Exit2WithPlan_YesInstalls_FromExistingNeverAsks"
  fresh_lab t19 || true
  ANTES="$(home_now)"
  RC=0; harness install --dry-run --yes > "$T/t19-dy.out" 2>&1 < /dev/null || RC=$?
  [ "$RC" = 0 ] && [ "$(home_now)" = "$ANTES" ] && grep -q '^escribe:' "$T/t19-dy.out" && ok "T19 --dry-run --yes: gana --dry-run (plan, 0, nada escrito)" || mal "T19 --dry-run --yes: salió ${RC}, HOME $( [ "$(home_now)" = "$ANTES" ] && echo igual || echo CAMBIADA )"
  RC=0; harness install > "$T/t19-no.out" 2>&1 < /dev/null || RC=$?
  [ "$RC" = 2 ] && grep -q '^escribe:' "$T/t19-no.out" && grep -q 'harness.js install --yes' "$T/t19-no.out" && ok "T19 sin terminal y sin --yes: 2 con el plan y la línea" || mal "T19 sin terminal: salió ${RC}: $(tail -n 2 "$T/t19-no.out" | tr '\n' ' ')"
  RC=0; harness install --yes > "$T/t19-yes.out" 2>&1 < /dev/null || RC=$?
  [ "$RC" = 0 ] && [ -f "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json" ] && ! grep -q '¿Instalo?' "$T/t19-yes.out" && ok "T19 --yes sin terminal instala sin preguntar" || mal "T19 --yes: salió ${RC}: $(tail -n 3 "$T/t19-yes.out" | tr '\n' ' ')"
  fresh_lab t19b || true
  RC=0; harness install --from-existing > "$T/t19-fe.out" 2>&1 < /dev/null || RC=$?
  [ "$RC" = 0 ] && [ -f "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json" ] && ! grep -q -e '¿Instalo?' -e '--yes' "$T/t19-fe.out" && ok "T19 --from-existing sin terminal: crea el estado sin preguntar ni pedir --yes" || mal "T19 --from-existing: salió ${RC}: $(tail -n 3 "$T/t19-fe.out" | tr '\n' ' ')"
fi

if corre T20; then
  echo "T20 · Plan_BrokenEffectsOldApplierFailedCheck_NeverReadAsNoChanges"
  EFF="scripts/setup/install-effects.json"
  fresh_lab t20 || true
  cp "$LAB_TREE/$EFF" "$T/effects.ok.json"
  ANTES="$(home_now)"
  printf '{ roto\n' > "$LAB_TREE/$EFF"
  for opt in "" "--dry-run"; do
    RC=0; harness install ${opt:+$opt} > "$T/t20-broken.out" 2>&1 < /dev/null || RC=$?
    [ "$RC" = 2 ] && grep -q 'install-effects.json' "$T/t20-broken.out" && [ "$(home_now)" = "$ANTES" ] && ok "T20 lista rota (install ${opt:-sin opción}): 2 nombrando el archivo, nada escrito" || mal "T20 lista rota (${opt:-sin opción}): salió ${RC}: $(tail -n 2 "$T/t20-broken.out" | tr '\n' ' ')"
  done
  rm -f "$LAB_TREE/$EFF"
  RC=0; harness install --yes > "$T/t20-absent.out" 2>&1 < /dev/null || RC=$?
  [ "$RC" = 2 ] && grep -q 'install-effects.json' "$T/t20-absent.out" && [ "$(home_now)" = "$ANTES" ] && ok "T20 lista ausente: 2 nombrando el archivo, también con --yes" || mal "T20 lista ausente: salió ${RC}: $(tail -n 2 "$T/t20-absent.out" | tr '\n' ' ')"
  cp "$T/effects.ok.json" "$LAB_TREE/$EFF"
  # un aplicador que no conoce --plan-json (un árbol viejo): el plan lo dice y la conformidad se pide igual
  harness_lab_old_applier
  RC=0; harness install > "$T/t20-old.out" 2>&1 < /dev/null || RC=$?
  [ "$RC" = 2 ] && grep -q 'este aplicador no sabe mostrar su plan' "$T/t20-old.out" && [ "$(home_now)" = "$ANTES" ] && ok "T20 aplicador viejo: el plan lo dice y sin terminal pide --yes igual (2)" || mal "T20 aplicador viejo: salió ${RC}: $(tail -n 3 "$T/t20-old.out" | tr '\n' ' ')"
  RC=0; harness_lab_pty n harness install > "$T/t20-old-tty.out" 2>&1 || RC=$?
  [ "$RC" = 0 ] && grep -q '¿Instalo?' "$T/t20-old-tty.out" && ok "T20 aplicador viejo con terminal: pregunta (nunca «sin cambios»)" || mal "T20 aplicador viejo con terminal: salió ${RC}: $(tail -n 3 "$T/t20-old-tty.out" | tr '\n' ' ')"
  fresh_lab t20b || true
  ANTES="$(home_now)"
  for knob in LAB_APPLIER_CHECK_FAIL LAB_APPLIER_BAD_PLAN LAB_APPLIER_PLAN_LOST; do
    RC=0; env "$knob=1" node "$LAB_TREE/scripts/setup/harness.js" install --yes > "$T/t20-$knob.out" 2>&1 < /dev/null || RC=$?
    [ "$RC" = 2 ] && grep -q 'no pude armar el plan' "$T/t20-$knob.out" && [ "$(home_now)" = "$ANTES" ] && ok "T20 ${knob}: 2 «no pude armar el plan», nada escrito" || mal "T20 ${knob}: salió ${RC}: $(tail -n 2 "$T/t20-$knob.out" | tr '\n' ' ')"
  done
fi

if corre T21; then
  echo "T21 · Install_StateChangedWhileConfirming_AbortsUnderLock"
  fresh_lab t21 || true
  # la primera espera 15 s su respuesta; mientras, otra instalación termina (en una máquina cargada tarda varios segundos:
  # con 4 s la primera contestaba con la segunda todavía adentro del candado)
  ( LAB_PTY_DELAY=15 harness_lab_pty s harness install > "$T/t21-first.out" 2>&1; echo $? > "$T/t21-first.rc" ) &
  FIRST=$!
  sleep 1.5
  RC=0; harness install --yes > "$T/t21-second.out" 2>&1 < /dev/null || RC=$?
  [ "$RC" = 0 ] || mal "T21 la segunda instalación salió ${RC}: $(tail -n 3 "$T/t21-second.out" | tr '\n' ' ')"
  STATE_2="$(shasum -a 256 < "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json" | cut -d' ' -f1)"
  N_COPIES_2="$(ls -1 "$LAB_HOME/.claude/.tycon-pipeline/harness/backups" 2>/dev/null | wc -l | tr -d ' ')"
  wait "$FIRST"
  RC1="$(cat "$T/t21-first.rc" 2>/dev/null)"
  if [ "$RC1" = 3 ] && grep -q 'la instalación cambió mientras confirmabas: volvé a correr' "$T/t21-first.out" \
     && [ "$(shasum -a 256 < "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json" | cut -d' ' -f1)" = "$STATE_2" ] \
     && [ "$(ls -1 "$LAB_HOME/.claude/.tycon-pipeline/harness/backups" 2>/dev/null | wc -l | tr -d ' ')" = "$N_COPIES_2" ]; then
    ok "T21 la primera sale 3 con la línea, sin tocar el estado ni tomar otra copia"
  else mal "T21 la primera salió ${RC1:-?}: $(tail -n 3 "$T/t21-first.out" | tr '\n' ' ')"; fi
  # el caso normal: la copia de respaldo es posterior a la respuesta
  fresh_lab t21b || true
  T0="$(date +%s)"
  RC=0; LAB_PTY_DELAY=2 harness_lab_pty s harness install > "$T/t21-normal.out" 2>&1 || RC=$?
  COPY="$(ls -1d "$LAB_HOME/.claude/.tycon-pipeline/harness/backups"/*/ 2>/dev/null | head -1)"
  COPY_T="$(python3 -c "import os,sys; print(int(os.stat(sys.argv[1]).st_mtime))" "${COPY}manifest.json" 2>/dev/null || echo 0)"
  [ "$RC" = 0 ] && [ -n "$COPY" ] && [ "$COPY_T" -ge $((T0 + 2)) ] && ok "T21 caso normal: la copia de respaldo se toma después de la respuesta" || mal "T21 caso normal: rc ${RC}, copia «${COPY}» a ${COPY_T} (respuesta a $((T0 + 2)))"
fi

if corre T22; then
  echo "T22 · Apply_DryRun_SamePlan_HomeIdentical"
  fresh_lab t22 || true
  harness install --yes > /dev/null 2>&1 < /dev/null || mal "T22 no se pudo instalar"
  python3 - "$LAB_HOME/.claude/settings.json" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p, encoding="utf-8"))
for ev in list(s.get("hooks", {})):
    s["hooks"][ev] = [b for b in s["hooks"][ev] if not any("lab-hook.js" in h.get("command", "") for h in b.get("hooks", []))]
    if not s["hooks"][ev]: del s["hooks"][ev]
json.dump(s, open(p, "w", encoding="utf-8"), indent=2)
PY
  ANTES="$(home_now)"
  RC=0; harness apply --dry-run > "$T/t22-dry.out" 2>&1 < /dev/null || RC=$?
  [ "$RC" = 0 ] && grep -q 'settings.json: 1 hook' "$T/t22-dry.out" && [ "$(home_now)" = "$ANTES" ] && ok "T22 apply --dry-run: el hook borrado aparece para agregar, nada escrito" || mal "T22 apply --dry-run: salió ${RC}: $(tr '\n' ' ' < "$T/t22-dry.out" | head -c 300)"
  RC=0; harness apply > "$T/t22-apply.out" 2>&1 < /dev/null || RC=$?
  [ "$RC" = 0 ] && grep -q 'lab-hook.js' "$LAB_HOME/.claude/settings.json" && ! grep -q -e '¿' -e '--yes' "$T/t22-apply.out" && ok "T22 apply lo repone sin preguntar" || mal "T22 apply: salió ${RC}: $(tail -n 2 "$T/t22-apply.out" | tr '\n' ' ')"
fi

# ══ REG · las regresiones del pase adversarial de la tanda B (y del revisor de alcance) ══════════════════════════════
if corre REG; then
  echo "REG · lo que encontró el pase adversarial de la tanda B"
  # clase 1: una reparación que el plan anuncia (un hook borrado a mano) se hace; antes, «sin cambios» y nada repuesto
  fresh_lab reg1 || true
  harness install --yes > /dev/null 2>&1 < /dev/null || mal "REG-1 install previo falló"
  python3 - "$LAB_HOME/.claude/settings.json" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p, encoding="utf-8"))
for ev in list(s.get("hooks", {})):
    s["hooks"][ev] = [b for b in s["hooks"][ev] if not any("lab-hook.js" in h.get("command", "") for h in b.get("hooks", []))]
    if not s["hooks"][ev]: del s["hooks"][ev]
json.dump(s, open(p, "w", encoding="utf-8"), indent=2)
PY
  RC=0; harness install --yes > "$T/reg1.out" 2>&1 < /dev/null || RC=$?
  [ "$RC" = 0 ] && grep -q 'lab-hook.js' "$LAB_HOME/.claude/settings.json" && ! grep -q 'sin cambios' "$T/reg1.out" \
    && ok "REG-1 el hook borrado que el plan anunciaba, install --yes lo repone" || mal "REG-1 rc ${RC}, el hook $(grep -q lab-hook.js "$LAB_HOME/.claude/settings.json" && echo está || echo 'NO está'): $(tail -n 2 "$T/reg1.out" | tr '\n' ' ')"
  # clase 4: lo que install escribe y el plan no veía (un módulo viejo de la copia fija, la línea de arranque repetida)
  for caso in modulo-viejo linea-repetida; do
    fresh_lab "reg4-$caso" || true
    harness install --yes > /dev/null 2>&1 < /dev/null || mal "REG-4 install previo falló"
    case "$caso" in
      modulo-viejo) printf '// un módulo que el árbol ya no trae\n' > "$LAB_HOME/.claude/.tycon-pipeline/harness/program/harness/old-module.js" ;;
      linea-repetida) python3 - "$LAB_HOME/.claude/settings.json" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p, encoding="utf-8"))
ss = s["hooks"]["SessionStart"]
line = next(h for b in ss for h in b.get("hooks", []) if "bootstrap.js" in h.get("command", ""))
ss.append({"hooks": [dict(line)]})
json.dump(s, open(p, "w", encoding="utf-8"), indent=2)
PY
      ;;
    esac
    ANTES="$(home_now)"
    RC=0; harness install --dry-run > "$T/reg4-$caso-dry.out" 2>&1 < /dev/null || RC=$?
    RC2=0; harness install > "$T/reg4-$caso.out" 2>&1 < /dev/null || RC2=$?
    if [ "$RC" = 0 ] && ! grep -q 'sin cambios' "$T/reg4-$caso-dry.out" && grep -q '^escribe:' "$T/reg4-$caso-dry.out" && [ "$RC2" = 2 ] && [ "$(home_now)" = "$ANTES" ]; then
      ok "REG-4 ${caso}: el plan lo muestra, y sin terminal ni --yes install sale 2 sin escribir"
    else mal "REG-4 ${caso}: dry-run rc ${RC} ($(head -n 2 "$T/reg4-$caso-dry.out" | tr '\n' ' ')) · install rc ${RC2}, HOME $( [ "$(home_now)" = "$ANTES" ] && echo igual || echo CAMBIADA )"; fi
  done
  # clase 7: un tycon.json con un nombre viejo de sección no hace escribir nada en la HOME al armar el plan
  fresh_lab reg7 || true
  # el nombre viejo de la sección, armado en dos partes: escrito entero, el control de menciones viejas lo contaría como uso
  OLD_SECTION="integra""ciones"
  printf '{ "%s": { "engram": false } }\n' "$OLD_SECTION" > "$LAB_HOME/.claude/tycon.json"
  ANTES="$(home_now)"
  RC=0; harness install --dry-run > "$T/reg7.out" 2>&1 < /dev/null || RC=$?
  [ "$RC" = 0 ] && [ "$(home_now)" = "$ANTES" ] && [ ! -e "$LAB_HOME/.claude/.tycon-pipeline" ] \
    && ok "REG-7 con un nombre viejo en tycon.json, install --dry-run no escribe nada (ni el registro de nombres viejos)" || mal "REG-7 rc ${RC}; HOME $( [ "$(home_now)" = "$ANTES" ] && echo igual || echo CAMBIADA ): $(ls "$LAB_HOME/.claude/.tycon-pipeline" 2>&1 | tr '\n' ' ')"
  # clase 9: install --dry-run --channel latest sobre una copia pública con apply: auto no pregunta: muestra el plan
  fresh_lab reg9 || true
  harness_lab_public > /dev/null 2>&1
  printf '{ "update": { "apply": "auto" } }\n' > "$LAB_HOME/.claude/tycon.json"
  ANTES="$(home_now)"
  RC=0; harness install --dry-run --channel latest > "$T/reg9.out" 2>&1 < /dev/null || RC=$?
  [ "$RC" = 0 ] && grep -q '^escribe:' "$T/reg9.out" && ! grep -q '¿Paso a latest' "$T/reg9.out" && grep -q 'se te pide confirmarlo' "$T/reg9.out" && [ "$(home_now)" = "$ANTES" ] \
    && ok "REG-9 install --dry-run --channel latest: el plan, el aviso de la confirmación, sin preguntar ni escribir" || mal "REG-9 rc ${RC}: $(tr '\n' ' ' < "$T/reg9.out" | head -c 300)"
  # las piezas compartidas (en Windows las hace este programa, no el aplicador): con un aplicador que no da su plan, el plan
  # del programa trae igual cleanupPeriodDays, la variable de env y los comandos de barra (story 8.16, AC 20)
  fresh_lab regsh || true
  harness_lab_old_applier
  mkdir -p "$LAB_TREE/commands"; printf '# un comando de barra de laboratorio\n' > "$LAB_TREE/commands/lab-cmd.md"
  SH="$(node -e '
const H = require(process.argv[1]);
const r = H.installPlan({ tree: process.argv[2], home: process.env.HOME, env: process.env, opts: {}, args: [], platform: process.platform });
if (!r.ok) { console.log("no-ok " + JSON.stringify(r.lines)); process.exit(0); }
const p = r.plan.pieces;
const has = (k, id) => p.some((x) => x.kind === k && x.id === id && x.action === "add");
console.log([has("setting", "cleanupPeriodDays"), has("setting", "env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR"), p.some((x) => x.kind === "command" && x.action === "add")].join(" "));' "$LAB_TREE/scripts/setup/harness.js" "$LAB_TREE" 2>&1)"
  [ "$SH" = "true true true" ] && ok "REG-SH las piezas compartidas están en el plan del programa aunque el aplicador no dé el suyo" || mal "REG-SH piezas compartidas en el plan: «${SH}»"
  # revisor de alcance: apply --dry-run con la lista de efectos rota lo dice
  fresh_lab regw2 || true
  harness install --yes > /dev/null 2>&1 < /dev/null || mal "REG-W2 install previo falló"
  printf '{ roto\n' > "$LAB_TREE/scripts/setup/install-effects.json"
  RC=0; harness apply --dry-run > "$T/regw2.out" 2>&1 < /dev/null || RC=$?
  [ "$RC" = 0 ] && grep -q 'no pude leer la lista de lo que la instalación cambia' "$T/regw2.out" \
    && ok "REG-W2 apply --dry-run con la lista de efectos rota lo dice" || mal "REG-W2 rc ${RC}: $(tr '\n' ' ' < "$T/regw2.out" | head -c 300)"
fi

# ── REG-PIPE: la consulta del plan no depende de quién termina primero ────────────────────────────────────────────
# Un plan de laboratorio grande (4.000 piezas: su lista ordenada no entra ni en la tubería), con la pieza buscada PRIMERA
# en el orden. Con `plan_actions … | grep -q` esto da falso SIEMPRE, en Linux y en una Mac: sort queda escribiendo, grep
# sale en su primer acierto, y `pipefail` convierte el corte en un «no está». Con plan_has y plan_all da lo que hay.
if corre REG; then
  mkdir -p "$T/regpipe"
  python3 -c "
import json,sys
pieces=[{'kind':'aaa','where':'lab','id':'first','action':'add'}]+[{'kind':'hook','where':'lab','id':'relleno-de-laboratorio-%05d'%i,'action':'add'} for i in range(4000)]
json.dump(pieces, open(sys.argv[1],'w',encoding='utf-8'))" "$T/regpipe/plan.json"
  plan_has "$T/regpipe/plan.json" '^aaa first add$' \
    && ok "REG-PIPE plan_has encuentra la primera pieza de un plan de 4.001 (no depende de que sort termine antes)" \
    || mal "REG-PIPE plan_has no encontró una pieza que está en el plan: la consulta volvió a depender de la tubería"
  plan_all "$T/regpipe/plan.json" ' add$' && ! plan_has "$T/regpipe/plan.json" '^zzz ' && ! plan_all "$T/regpipe/plan.json" '^hook ' \
    && ok "REG-PIPE plan_all dice «todas» sólo si todas coinciden, y plan_has no inventa una pieza que no está" \
    || mal "REG-PIPE plan_all o plan_has contestan otra cosa que lo que el plan trae"
  printf '{ roto\n' > "$T/regpipe/broken.json"
  ! plan_has "$T/regpipe/broken.json" '.' 2>/dev/null && ! plan_all "$T/regpipe/broken.json" '.' 2>/dev/null \
    && ok "REG-PIPE un plan que no se puede leer no «tiene» nada ni «cumple» todo" \
    || mal "REG-PIPE un plan ilegible se leyó como si trajera piezas"
fi

# ── REG con el aplicador real: Codex (clase 2), las skills de terceros del repo único (clase 3), el git pull (clase 5) ──
if corre REG; then
  A="$T/regr/tree"; H="$T/regr/home"; lab_tree "$A"; new_home "$H"; base "$H"
  # clase 5: un `git pull` propio en la línea de arranque, que el aplicador reescribe, aparece en el plan
  mkdir -p "$H/.claude"
  printf '{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "cd ~/SourceCode/tycon-claude-guides && git pull -q" } ] } ] } }\n' > "$H/.claude/settings.json"
  RC=0; "${RUN_ENV[@]}" bash "$A/scripts/install-tycon-hooks.sh" --check --plan-json "$T/regr/plan5.json" > /dev/null 2>&1 || RC=$?
  [ "$RC" = 0 ] && plan_has "$T/regr/plan5.json" '^pull-line .* update$' \
    && ok "REG-5 el git pull de una línea de arranque que el aplicador reescribe está en el plan (pull-line update)" || mal "REG-5 rc ${RC}: $(plan_actions "$T/regr/plan5.json" 2>&1 | grep -v ' add$' | head -3 | tr '\n' ';')"
  # clase 2: con Codex prendido, el plan trae las piezas del despliegue (hooks.json, config.toml), no sólo AGENTS.md
  if [ -d "$RAIZ/build" ] && [ -d "$RAIZ/adapters/codex" ]; then
    A2="$T/regr/tree-codex"; H2="$T/regr/home-codex"
    lab_tree "$A2"; ( cd "$RAIZ" && tar cf - build adapters ) | ( cd "$A2" && tar xf - )
    new_home "$H2"; base "$H2"; RUN_ENV=("${RUN_ENV[@]/TYCON_CODEX=0/TYCON_CODEX=1}"); mkdir -p "$H2/.codex"
    RC=0; "${RUN_ENV[@]}" bash "$A2/scripts/install-tycon-hooks.sh" --check --plan-json "$T/regr/plan2.json" > /dev/null 2>&1 || RC=$?
    # El mensaje dice QUÉ buscaba y qué no encontró. Antes mostraba las primeras cuatro piezas `codex` del plan, por
    # orden alfabético, y se leía como «el plan propone de más»: nunca decía si las dos buscadas estaban.
    MISSING=""; for piece in hooks.json config.toml; do plan_has "$T/regr/plan2.json" "^codex ${piece} add\$" || MISSING="${MISSING} «codex ${piece} add»"; done
    [ "$RC" = 0 ] && [ -z "$MISSING" ] \
      && ok "REG-2 con Codex prendido, el plan trae hooks.json y config.toml del despliegue" || mal "REG-2 rc ${RC}: al plan con Codex prendido le falta:${MISSING:- nada} · trae $(grep -c '^codex ' "$T/plan-actions.txt" 2>/dev/null) pieza(s) codex de $(grep -c . "$T/plan-actions.txt" 2>/dev/null)"
  else ok "REG-2 NO MEDIDO: este árbol no trae build/ y adapters/codex"; fi
  # clase 3: en el repo único sin el enlace todavía, las skills de terceros se anotan con la ruta del reporte
  A3="$T/regr/tree-single"; H3="$T/regr/home-single"
  lab_tree "$A3"; mkdir -p "$A3/skills/tycon-pipeline" "$A3/agents"; : > "$A3/skills/tycon-pipeline/.keep"; : > "$A3/agents/.keep"
  git -C "$A3" add -A >/dev/null 2>&1; env GIT_CONFIG_GLOBAL=/dev/null git -C "$A3" -c user.name=l -c user.email=l@e -c core.hooksPath=/dev/null commit -q -m single >/dev/null 2>&1
  rm -rf "$H3"; mkdir -p "$H3/.claude"; base "$H3"; RUN_ENV=("${RUN_ENV[@]/TYCON_THIRD_PARTY=0/TYCON_THIRD_PARTY=1}")
  RC=0; "${RUN_ENV[@]}" bash "$A3/scripts/install-tycon-hooks.sh" --check --plan-json "$T/regr/plan3.json" > /dev/null 2>&1 || RC=$?
  BAD3="$(python3 -c "
import json,sys
p=json.load(open(sys.argv[1])); tp=[x for x in p if x['kind']=='third-party']
import os
root=os.path.normpath(sys.argv[2]) + os.sep   # TMPDIR puede terminar en «/»: el plan trae la ruta normalizada
bad=[x['where'] for x in tp if not x['where'].startswith(root)]
print(len(tp), len(bad), (bad[:1] or [''])[0])" "$T/regr/plan3.json" "$H3/.claude/agent-skills/" 2>/dev/null)"
  BAD3="${BAD3% *}"; [ "${BAD3##* }" = 0 ] || BAD3="$BAD3 · ej.: $(python3 -c "
import json,sys
p=json.load(open(sys.argv[1])); print(next((x['where'] for x in p if x['kind']=='third-party'), ''))" "$T/regr/plan3.json" 2>/dev/null)"
  case "$BAD3" in "0 0"|"") mal "REG-3 rc ${RC}: el plan no trae skills de terceros («${BAD3}»)" ;; *" 0") ok "REG-3 las skills de terceros del plan van con la ruta de ~/.claude/agent-skills (${BAD3% *}), como el reporte" ;; *) mal "REG-3 skills de terceros con otra ruta: ${BAD3}" ;; esac
fi

# REG-819 (story 8.19, revisión de C+E, M3): la marca de arranque de los bloques cambió de texto en la tanda E. Un bloque
# que ya está escrito con la marca vieja se anota «update» (como el .ps1, que decide por el prefijo), nunca «add».
# 🔴 rojo previo: el plan del .sh comparaba la marca entera y decía «add» para los bloques que la persona ya tiene.
if corre REG; then
  H4="$T/reg5"; rm -rf "$H4"; mkdir -p "$H4/.claude"
  for f in "$RAIZ"/claude-md-blocks/*.md; do n="$(basename "$f" .md)"
    printf '<!-- TYCON_BLOCK:%s START — generado por una marca de antes · NO EDITAR A MANO -->\nviejo\n<!-- TYCON_BLOCK:%s END -->\n\n' "$n" "$n" >> "$H4/.claude/CLAUDE.md"
  done
  : > "$H4/plan.tsv"
  env -i HOME="$H4" PATH="$PATH" LANG="${LANG:-en_US.UTF-8}" CLAUDE_MD_PATH="$H4/.claude/CLAUDE.md" CODEX_AGENTS_MD_PATH="$H4/.codex/AGENTS.md" \
    TYCON_PLAN_PIECES="$H4/plan.tsv" bash "$RAIZ/scripts/setup/sync-claude-md-blocks.sh" --check > "$H4/out" 2>&1
  ADDS="$(grep -c 'TYCON_BLOCK:.*[[:space:]]add$' "$H4/plan.tsv")"; UPDS="$(grep -c 'TYCON_BLOCK:.*[[:space:]]update$' "$H4/plan.tsv")"
  [ "$ADDS" = 0 ] && [ "$UPDS" -gt 0 ] && ok "REG-819 bloques con la marca vieja: el plan dice update (${UPDS}), ningún add" \
    || mal "REG-819 bloques con la marca vieja: ${ADDS} add, ${UPDS} update — $(head -c 300 "$H4/plan.tsv" | tr '\n' ';')"
fi

echo
if [ "$FALLOS" -eq 0 ]; then echo "harness-plan: verde"; exit 0; fi
echo "harness-plan: ${FALLOS} fallo(s)"; exit 1
