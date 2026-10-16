#!/usr/bin/env bash
# harness-lab.sh — el laboratorio compartido de las suites `harness-*.test.sh` (story 8.13, tanda A · 2026-10-02).
#
# Por qué existe: cinco suites prueban el mecanismo de instalación (`scripts/setup/harness.js`) sobre una máquina de
# juguete con git DE VERDAD: una HOME propia, dos remotos bare (el arnés y agent-skills), un clon de cada uno, y un
# «arnés de juguete» con la forma mínima que el programa exige —`install-tycon-hooks.sh` de mentira que registra un hook y
# honra `--check`, `--report-json`, `TYCON_HARNESS_LOCK_HELD` y `TYCON_HARNESS_SNAPSHOT_DIR`; `scripts/lib/` y
# `scripts/setup/` REALES copiados del repo bajo prueba—. Armarlo en cada suite a mano eran tres copias que divergen.
#
# Nunca toca `~/.claude`, el checkout real ni `~/.claude/agent-skills`: todo vive bajo la carpeta que recibe (de
# `mktemp -d`), la HOME de la sesión se reemplaza por la de juguete, launchd es un `launchctl` de mentira, el examen
# nocturno y el entorno gráfico quedan apagados, y ninguna etiqueta de LaunchAgent es `ar.com.tycon.*`.
#
# Se usa con `source` (cambia el ambiente de la suite que lo carga):
#
#   source "$RAIZ/scripts/tests/lib/harness-lab.sh"
#   harness_lab_create "$BASE/lab"          # exporta LAB, LAB_HOME, LAB_TREE, LAB_SKILLS, LAB_BIN, LAB_REMOTE_*, LAB_AUTHOR_*
#   harness install                         # = node "$LAB_TREE/scripts/setup/harness.js" install
#   harness_lab_publish tree "v2" VERSION 2 # commit en la copia «autor» del arnés + push al remoto: hay versión nueva
#   harness_lab_fake_node 18.0.0            # $LAB_BIN/node: `--version` dice v18.0.0 y todo lo demás corre con
#                                           #   process.versions.node = 18.0.0 (así harness.js y bootstrap.js ven el piso)
#   harness_lab_old_line canonical          # la línea de arranque VIEJA en settings.json (variantes de la fixture)
#   harness_lab_home_hash                   # un hash de todo el HOME: «no cambió nada» se prueba comparando dos
#   harness_lab_state                       # el estado (harness-state.json) o nada
#   harness_lab_settings_commands           # los `command` de SessionStart, uno por línea
#
#   harness_lab_publish_hook PreToolUse tycon-pipeline/x.js   # tanda C: un hook nuevo de agent-skills en el remoto
#   harness_lab_publish_block lab-extra     # tanda C: un bloque TYCON_BLOCK nuevo declarado por el árbol
#   harness_lab_bootstrap rollback          # tanda C: la copia fija de arranque (~/.claude/.tycon-pipeline/harness/)
#
#   harness_lab_public                      # tanda D: el remoto del arnés pasa a ser «el repo público» (lo declara
#                                           #   scripts/setup/public-remotes.json en el árbol, con la ruta del bare)
#   harness_lab_publish_sync 2026.10.02.1   # tanda D: una sincronización: commit sobre la punta de main con ese número
#                                           #   en version.json, y push --force a mirror/sync (la rama se reescribe)
#   harness_lab_publish_stable 2026.10.02.1 # tanda D: un commit en main con ese número en version.json
#   harness_lab_merge_sync                  # tanda D: el merge del pull request (merge --no-ff de mirror/sync a main)
#   harness_lab_delete_sync                 # tanda D: el remoto se queda sin mirror/sync (se borró al mergear)
#   harness_lab_pty s harness channel latest   # tanda D: corre con una terminal de juguete y contesta «s» («-» = nada)
#
#   harness_lab_team_machine "$BASE/lab" [toy|real]   # story 8.18: la máquina del equipo en la TRANSICIÓN, en vez de
#                                           #   harness_lab_create (detalle en «La máquina del equipo», más abajo)
#   harness_lab_single_tree "$BASE/lab"     # 8.18: la máquina NUEVA de un solo árbol (la tercera forma), en vez de las otras dos
#   harness_lab_worktree_hash "$LAB_SKILLS" # 8.18: un hash de todo el árbol de trabajo de ese clon (sin su .git)
#   harness_lab_shape "$BASE/lab" repointed # 8.18: una máquina ya instalada en una de las tres formas (two-clones|repointed|single)
#   harness_lab_cut                         # 8.18: el corte — `main` del remoto del arnés pasa a traer skills/, agents/ y packs/
#   harness_lab_pull_tree                   # 8.18: el clon del arnés avanza a lo publicado (lo que hace el arranque)
#   harness_lab_publish_without_skills      # 8.18: una punta de `main` que NO trae skills/ (el retorno a antes de la unión)
#   harness_lab_clone_extras "$LAB_SKILLS"  # 8.18: un hash de lo que git no sigue en ese clon y de sus stash
#   harness_lab_links                       # 8.18: a dónde apunta cada enlace de ~/.claude (o qué hay en su lugar)
#   harness_lab_isolated harness update     # 8.18: corre un comando con apagado lo que el aplicador real saca a la red
#   harness_lab_real_applier [--check]      # 8.18: el aplicador REAL del clon del laboratorio (sólo con `real`), aislado
#   harness_lab_seed_codex_links            # 8.18: los enlaces de ~/.codex/skills hacia el clon viejo, como en el equipo
#   harness_lab_codex_links                 # 8.18: esos enlaces, uno por línea («nombre -> destino»)
#
# El perfil del equipo del laboratorio (story 8.16, tanda D): `TYCON_PROFILE=$LAB/lab-profile.json`, que sólo fija
# `install.profile: full` — una máquina cuyo perfil ya está elegido, así `install --yes` sin terminal instala como
# siempre y nada pregunta. La máquina de afuera que pregunta la arma harness-questions.test.sh con TYCON_PROFILE=0.
#
# Variables que respeta: LAB_APPLIER_SLEEP (segundos que duerme el aplicador de juguete), LAB_APPLIER_FAIL=1 (sale 1),
# LAB_APPLIER_SUITE_FAIL=1 (imprime «FALLÓ» como su suite rápida y sale 0; tanda C), LAB_APPLIER_OLD=1 (un aplicador de
# antes de la tanda D: no conoce TYCON_HARNESS_SHARED_DONE y hace y reporta las piezas compartidas igual),
# LAB_APPLIER_WARN (una línea de aviso que el aplicador de juguete imprime tal cual, entre otras dos; story 8.16),
# LAB_APPLIER_NO_REPORT=1 (acepta --report-json y no escribe el reporte de piezas; story 8.16),
# LAB_APPLIER_EDIT (una ruta del árbol que el aplicador de juguete reescribe con LAB_APPLIER_EDIT_TEXT antes de su
# suite, una sola vez por HOME: la persona que edita un archivo entre que se apila la capa y la salud; story 8.13.1,
# revisión del paso 5).
# Tanda B de la 8.16: el aplicador de juguete honra `--check --plan-json <archivo>` (y `--plan-json` sin `--check` sale
# 2); LAB_APPLIER_CHECK_FAIL=1 (su --check sale 1), LAB_APPLIER_BAD_PLAN=1 (deja un plan ilegible),
# LAB_APPLIER_PLAN_LOST=1 (dice que no pudo anotar una pieza en el plan y lo deja igual),
# harness_lab_old_applier (un aplicador que no conoce la opción), LAB_PTY_DELAY y la respuesta «EOF» de harness_lab_pty.
# Con --check no escribe nada en la HOME: su corrida se anota en $LAB/lab-applier-check.log.

# raíz del repo bajo prueba: scripts/tests/lib → ../../..
HARNESS_LAB_RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

harness_lab_git() { # harness_lab_git <dir> <args…>  — git sin la configuración de la máquina
  # 🔴 Sin carpeta no hay git. `git -C ""` NO cambia de carpeta: opera sobre el repo donde está parado quien llama. Un
  #    guion cuyo laboratorio no se armó (harness_lab_create se niega bajo una ruta con el nombre del repo del equipo, y
  #    deja LAB_* sin valor) terminaba creando ramas y commits en la copia de trabajo real (2026-10-02).
  local d="${1:-}"
  if [ -z "$d" ] || [ ! -d "$d" ]; then
    echo "harness-lab: harness_lab_git sin carpeta («${d}» no existe): ¿se armó el laboratorio? — no corro git" >&2
    return 2
  fi
  shift
  # 🔴 Sin mantenimiento automático (2026-10-11). Sin configuración, git lanza `git maintenance run --auto` después de
  #    cada commit y de cada fetch y lo deja corriendo de fondo: empaqueta y borra objetos sueltos cuando quiere. Una
  #    suite que saca la huella de un repo (find + shasum) antes y después de un comando leía un repo que se movía solo:
  #    harness-update.test.sh T8 dio «algún comando escribió en un repo ajeno» sin que nadie escribiera (con git 2.55.0;
  #    la misma corrida, media hora después, verde). Lo mide scripts/tests/harness-lab-git.test.sh. `gc.auto=0` es por
  #    un git viejo, que lanzaba `git gc --auto` en vez de `maintenance`.
  env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u GIT_COMMON_DIR \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 LC_ALL=C \
    GIT_AUTHOR_NAME=Lab GIT_AUTHOR_EMAIL=lab@example.com GIT_COMMITTER_NAME=Lab GIT_COMMITTER_EMAIL=lab@example.com \
    git -c core.hooksPath=/dev/null -c maintenance.auto=false -c gc.auto=0 -C "$d" "$@"
}

# 🔴 Sin mantenimiento automático TAMBIÉN para el git que corre el código bajo prueba (2026-10-14). harness_lab_git lo
#    apaga para el git del laboratorio, pero el `fetch` y el `commit` de harness.js lo lanzaban igual
#    (`git maintenance run --auto --detach`, de fondo). Con git 2.55 eso reempaqueta el clon y escribe `.git/info/refs`:
#    harness-repoint.test.sh, que compara la máquina byte a byte después de la ida y la vuelta, salía rojo de a ratos
#    (public-ci, LINK y VIEW: «info: exclude» antes, «info: exclude refs» después). Va por el entorno, que lo hereda todo
#    git hijo (sources.js pasa el entorno; layer.js borra las GIT_* pero sólo hace checkout, que no lo lanza). Lo mide
#    scripts/tests/harness-lab-git.test.sh.
harness_lab_no_auto_maintenance() {
  export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false GIT_CONFIG_KEY_1=gc.auto GIT_CONFIG_VALUE_1=0
}

# el arnés de juguete, en <dir>: lo mínimo que harness.js y el aplicador real exigen, con los scripts REALES bajo prueba
_harness_lab_toy_tree() { # _harness_lab_toy_tree <dir>
  local d="$1"
  mkdir -p "$d/scripts/setup" "$d/scripts/lib" "$d/scripts/hooks" "$d/.dashboard"
  cp -R "$HARNESS_LAB_RAIZ/scripts/setup/harness.js" "$d/scripts/setup/" 2>/dev/null || true
  [ -d "$HARNESS_LAB_RAIZ/scripts/setup/harness" ] && cp -R "$HARNESS_LAB_RAIZ/scripts/setup/harness" "$d/scripts/setup/"
  # la lista de efectos REAL (story 8.16): el cierre de `install` cuenta con ella los hooks que pueden frenar
  [ -f "$HARNESS_LAB_RAIZ/scripts/setup/install-effects.json" ] && cp "$HARNESS_LAB_RAIZ/scripts/setup/install-effects.json" "$d/scripts/setup/"
  cp "$HARNESS_LAB_RAIZ"/scripts/lib/*.js "$d/scripts/lib/" 2>/dev/null || true
  cp "$HARNESS_LAB_RAIZ"/scripts/lib/*.sh "$d/scripts/lib/" 2>/dev/null || true
  cp "$HARNESS_LAB_RAIZ"/scripts/lib/*.json "$d/scripts/lib/" 2>/dev/null || true
  # dos listas REALES de la publicación: los repos públicos, y las skills de terceros (story 8.16: el cierre de `install`
  # cuenta con ella las que quedan pendientes). Se nombra cada archivo, nunca la carpeta: el lector de dependencias de la
  # validación (scripts/ci/suite-deps.js) cuenta una carpeta nombrada entera, y con ella cualquier cambio en la publicación
  # corría todas las suites del laboratorio (story 8.22, tramo E). La carpeta se crea igual, vacía si faltan las dos.
  local pub
  for pub in scripts/publishing/public-repos.json scripts/publishing/third-party-skills.json; do
    mkdir -p "$d/$(dirname "$pub")"
    [ -f "$HARNESS_LAB_RAIZ/$pub" ] && cp "$HARNESS_LAB_RAIZ/$pub" "$d/$pub"
  done
  # 🔴 el laboratorio NO hereda el repo del equipo del repo real (story 8.25, AC 16): con la clave `team` puesta, cada máquina
  #    de juguete tendría repo del equipo declarado y la mudanza exigiría verlo (el servidor de juguete atiende un solo repo)
  #    → T27-T32 de harness-move-home rojas. Sólo las pruebas de la capa la ponen, con el nombre que atiende el segundo repo
  [ -f "$d/scripts/publishing/public-repos.json" ] && node -e '
    const fs = require("fs"); const f = process.argv[1];
    const j = JSON.parse(fs.readFileSync(f, "utf8")); if (j.team === undefined) process.exit(0);
    delete j.team; fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");' "$d/scripts/publishing/public-repos.json"
  printf '# arnés de juguete (harness-lab.sh)\n' > "$d/README.md"
  printf '1\n' > "$d/VERSION"
  printf '.dashboard/\n' > "$d/.gitignore"
  cat > "$d/scripts/hooks/lab-hook.js" <<'JS'
// hook de juguete que registra el aplicador de laboratorio
process.exit(0);
JS
  # el aplicador de mentira: lo que harness.js necesita del real, y nada más
  cat > "$d/scripts/install-tycon-hooks.sh" <<'SH'
#!/usr/bin/env bash
# install-tycon-hooks.sh DE JUGUETE (harness-lab.sh): registra un hook, honra --check y --report-json, el candado,
# TYCON_HARNESS_LOCK_HELD y TYCON_HARNESS_SNAPSHOT_DIR; deja un sello diario; anota cada corrida en lab-applier.log.
# Como el real, hace y reporta las tres piezas COMPARTIDAS (cleanupPeriodDays, la variable de env y los comandos de
# barra de <árbol>/commands) salvo que quien lo lanzó ya las haya hecho (TYCON_HARNESS_SHARED_DONE=1: tanda D, AC 28).
# Con LAB_APPLIER_OLD=1 es un aplicador de ANTES de la tanda D: no conoce esa variable y las hace y las reporta igual.
set -u
SHARED_DONE="${TYCON_HARNESS_SHARED_DONE:-0}"; [ "${LAB_APPLIER_OLD:-0}" = "1" ] && SHARED_DONE=0
# su «lista canónica», con la forma de la del aplicador real: doctor sólo cuenta como del arnés lo que el aplicador conoce
LAB_SPEC="SessionStart||@tcg:lab-hook.js|hook de juguete del laboratorio"
CHECK=0; REPORT=""
while [ $# -gt 0 ]; do
  case "$1" in --check) CHECK=1 ;; --report-json) REPORT="${2:-}"; shift ;; esac
  [ "$1" = "--plan-json" ] && { PLAN="${2:-}"; shift; }   # plan-json (story 8.16, tanda B)
  shift
done
[ -n "${PLAN:-}" ] && [ "$CHECK" != "1" ] && { echo "install-tycon-hooks.sh: --plan-json necesita --check" >&2; exit 2; }   # plan-json
# un aplicador que acepta --report-json y no escribe el reporte (story 8.16): harness.js tiene que decirlo en su cierre
[ "${LAB_APPLIER_NO_REPORT:-0}" = "1" ] && REPORT=""
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="${TYCON_SETTINGS_PATH:-$HOME/.claude/settings.json}"
ST="$HOME/.claude/.tycon-pipeline"
RUN_LINE="run check=$CHECK lock_held=${TYCON_HARNESS_LOCK_HELD:-} snapshot_dir=${TYCON_HARNESS_SNAPSHOT_DIR:-} shared_done=${TYCON_HARNESS_SHARED_DONE:-} git_bash_health=${TYCON_HARNESS_GIT_BASH_HEALTH:-} tree=$(cd "$AQUI/.." && pwd) version=$(cat "$AQUI/../VERSION" 2>/dev/null) at=$(date +%s)"
# LAB_APPLIER_INTEG=1 (story 8.25, A1b · T10): anota lo que el aplicador REAL evalúa para registrar los hooks de las
# integraciones —la salida de `tycon-config.js integrations` del árbol desde el que corre—: así se mide que el aplicador de
# un arranque ya lee el perfil que ese mismo arranque refrescó
[ "${LAB_APPLIER_INTEG:-0}" = "1" ] && RUN_LINE="$RUN_LINE integ=$(node "$AQUI/lib/tycon-config.js" integrations 2>&1 | tr '\n' ',')"
if [ "$CHECK" = "1" ]; then
  # --check no escribe nada en la HOME (story 8.7, AC 24; story 8.16, AC 3): su corrida se anota fuera, en el laboratorio
  [ -n "${LAB_APPLIER_CHECK_LOG:-}" ] && echo "$RUN_LINE" >> "$LAB_APPLIER_CHECK_LOG"
else
  mkdir -p "$ST" "$(dirname "$S")"
  echo "$RUN_LINE" >> "$ST/lab-applier.log"
fi
[ "${TYCON_NO_AUTOINSTALL:-0}" = "1" ] && exit 0   # como el real: apagado, sale sin escribir nada (ni reporte)
[ "${LAB_APPLIER_SLEEP:-0}" != "0" ] && sleep "$LAB_APPLIER_SLEEP"
if [ "${TYCON_HARNESS_LOCK_HELD:-0}" != "1" ] && [ "$CHECK" != "1" ]; then
  L="$ST/install-tycon-hooks.lock"
  mkdir "$L" 2>/dev/null || { echo "lab-applier: candado tomado, me voy" >> "$ST/lab-applier.log"; exit 0; }
  trap 'rmdir "$L" 2>/dev/null' EXIT
fi
# story 8.16 (tanda B): un --check que falla, o un plan ilegible; harness.js no instala sin haber mostrado un plan
[ "$CHECK" = "1" ] && [ "${LAB_APPLIER_CHECK_FAIL:-0}" = "1" ] && { echo "lab-applier: --check FALLÓ a propósito" >&2; exit 1; }
[ "$CHECK" = "1" ] && [ -n "${PLAN:-}" ] && [ "${LAB_APPLIER_BAD_PLAN:-0}" = "1" ] && { printf '{ roto\n' > "$PLAN"; exit 0; }   # plan-json
[ "$CHECK" = "1" ] && [ -z "${PLAN:-}" ] && exit 0
# >>> plan-json — lo mismo que haría abajo, como acciones, sin escribir nada más que el plan (story 8.16, AC 11). El
# aplicador VIEJO de harness_lab_old_applier es este archivo sin las líneas que nombran la opción y sin este bloque.
if [ "$CHECK" = "1" ]; then
  python3 - "$S" "$AQUI/hooks/lab-hook.js" "${CLAUDE_MD_PATH:-$HOME/.claude/CLAUDE.md}" "$HOME/.claude/agent-skills" "$AQUI/../lab-blocks.txt" "${PLAN:-}" "$SHARED_DONE" "$AQUI/../commands" "$HOME/.claude/commands" <<'PY'
import glob, json, os, sys, tempfile
s_path, hook, c_path, skills, blocks_file, plan, shared_done, commands_src, commands_dst = sys.argv[1:10]
try: s = json.load(open(s_path, encoding="utf-8"))
except (OSError, ValueError): s = {}
cmds = [c.get("command") for bs in (s.get("hooks") or {}).values() for b in bs for c in b.get("hooks", [])]
out = []
wanted = [('node "%s"' % hook, "SessionStart:@tcg:lab-hook.js")]
try:
    for line in open(os.path.join(skills, "lab-hooks.txt"), encoding="utf-8"):
        line = line.strip()
        if line and "|" in line:
            ev, rel = line.split("|", 1)
            wanted.append(('node "%s"' % os.path.join(skills, "skills", rel), "%s:%s" % (ev, rel)))
except OSError:   # una carpeta que no se puede mirar (permisos): el plan es una mirada, no frena; lo dice la instalación
    pass
for cmd, hid in wanted: out.append({"kind": "hook", "where": s_path, "id": hid, "action": "keep" if cmd in cmds else "add"})
if shared_done != "1":
    for k, v, cur in (("cleanupPeriodDays", 365, s.get("cleanupPeriodDays")), ("env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR", "1", (s.get("env") or {}).get("CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR"))):
        if cur is None: out.append({"kind": "setting", "where": s_path, "id": k, "action": "add"})
        elif cur == v: out.append({"kind": "setting", "where": s_path, "id": k, "action": "keep"})
    for src in sorted(glob.glob(os.path.join(commands_src, "*.md"))):
        dst = os.path.join(commands_dst, os.path.basename(src))
        act = "add" if not os.path.exists(dst) else ("keep" if open(src, "rb").read() == open(dst, "rb").read() else "update")
        out.append({"kind": "command", "where": os.path.abspath(dst), "id": os.path.basename(src), "action": act})
try: names = [l.strip() for l in open(blocks_file, encoding="utf-8") if l.strip()]
except FileNotFoundError: names = []
text = open(c_path, encoding="utf-8").read() if os.path.exists(c_path) else ""
for n in names:
    out.append({"kind": "block", "where": c_path, "id": "TYCON_BLOCK:%s" % n, "action": "keep" if ("<!-- TYCON_BLOCK:%s START -->" % n) in text else "add"})
fd, tmp = tempfile.mkstemp(prefix=".plan.", dir=os.path.dirname(os.path.abspath(plan)))
with os.fdopen(fd, "w", encoding="utf-8") as f: f.write(json.dumps(out) + "\n")
os.replace(tmp, plan)
# LAB_APPLIER_PLAN_LOST=1: uno de sus pasos dice que no pudo anotar una pieza (como el sync de bloques), y el plan sale igual
if os.environ.get("LAB_APPLIER_PLAN_LOST") == "1": print("⚠ tycon: no pude anotar el bloque TYCON_BLOCK:lab en el plan (disco lleno)")
PY
  exit $?
fi
# <<< plan-json
# con LAB_APPLIER_FAIL y LAB_APPLIER_WARN juntos, el aviso sale ANTES de fallar: el cierre de «quedó a medias» lo repite
[ "${LAB_APPLIER_FAIL:-0}" = "1" ] && [ -n "${LAB_APPLIER_WARN:-}" ] && printf '%s\n' "$LAB_APPLIER_WARN"
[ "${LAB_APPLIER_FAIL:-0}" = "1" ] && { echo "lab-applier: FALLÓ a propósito" >&2; exit 1; }
# una edición a mano en la ventana entre apilar la capa y la salud (story 8.13.1): la ruta, relativa al árbol. UNA sola
# vez (la marca queda en la HOME del laboratorio): la vuelta atrás vuelve a correr el aplicador, y una segunda edición
# taparía lo que la prueba mira —si la vuelta atrás pisó la primera—
if [ -n "${LAB_APPLIER_EDIT:-}" ] && [ "$CHECK" != "1" ] && [ ! -e "$ST/lab-applier-edit.done" ]; then
  printf '%s\n' "${LAB_APPLIER_EDIT_TEXT:-EDITADO EN LA VENTANA}" > "$AQUI/../$LAB_APPLIER_EDIT"; : > "$ST/lab-applier-edit.done"
  # LAB_APPLIER_EDIT_MODE: además le cambia los permisos (por ejemplo 000, para que el freno no lo pueda leer)
  [ -n "${LAB_APPLIER_EDIT_MODE:-}" ] && chmod "$LAB_APPLIER_EDIT_MODE" "$AQUI/../$LAB_APPLIER_EDIT"
fi
# la suite rápida de cada arranque del aplicador real imprime «FALLÓ» y el aplicador sale 0 igual (tanda C, AC 21)
[ "${LAB_APPLIER_SUITE_FAIL:-0}" = "1" ] && echo "✗ suite de la capa determinista: lab-suite FALLÓ"
# un aviso para la persona, como los del real (story 8.16, AC 8): la línea de LAB_APPLIER_WARN tal cual, entre otras dos
[ -n "${LAB_APPLIER_WARN:-}" ] && printf '%s\n%s\n%s\n' "lab-applier: registrando hooks" "$LAB_APPLIER_WARN" "lab-applier: listo"
# el esqueleto del real, con su "$schema" (lo que un settings.json creado por el módulo de las piezas compartidas no trae)
[ -f "$S" ] || printf '{\n  "$schema": "https://json.schemastore.org/claude-code-settings.json",\n  "hooks": {}\n}\n' > "$S"
C="${CLAUDE_MD_PATH:-$HOME/.claude/CLAUDE.md}"
[ -z "${TYCON_HARNESS_SNAPSHOT_DIR:-}" ] && cp "$S" "$S.bak.$(date +%Y-%m-%dT%H-%M-%S)"
# Además de su hook de siempre (tanda C): los hooks que declara agent-skills (`lab-hooks.txt`, «EVENTO|ruta en skills/») y
# los bloques que declara el árbol (`lab-blocks.txt`, un nombre por línea). Sólo AGREGA: quitar lo que ya no se declara es
# trabajo de harness.js (decisión 3 del dueño), no del aplicador. El reporte nombra todo lo suyo que está en la máquina.
python3 - "$S" "$AQUI/hooks/lab-hook.js" "$C" "$HOME/.claude/agent-skills" "$AQUI/../lab-blocks.txt" "$REPORT" "$SHARED_DONE" "$AQUI/../commands" "$HOME/.claude/commands" <<'PY'
import glob, json, sys, os, shutil, tempfile
s_path, hook, c_path, skills, blocks_file, report, shared_done, commands_src, commands_dst = sys.argv[1:10]
shared_done = shared_done == "1"
def atomic(path, text):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".lab.", dir=os.path.dirname(path) or ".")
    with os.fdopen(fd, "w", encoding="utf-8") as f: f.write(text)
    os.replace(tmp, path)
with open(s_path, encoding="utf-8") as f: s = json.load(f)
pieces = []
wanted = [("SessionStart", 'node "%s"' % hook, "SessionStart:@tcg:lab-hook.js")]
try:
    for line in open(os.path.join(skills, "lab-hooks.txt"), encoding="utf-8"):
        line = line.strip()
        if not line or "|" not in line: continue
        ev, rel = line.split("|", 1)
        wanted.append((ev, 'node "%s"' % os.path.join(skills, "skills", rel), "%s:%s" % (ev, rel)))
except FileNotFoundError:
    pass
changed = False
hooks = s.setdefault("hooks", {})
for ev, cmd, hid in wanted:
    blocks = hooks.setdefault(ev, [])
    if not any(c.get("command") == cmd for h in blocks for c in h.get("hooks", [])):
        blocks.append({"hooks": [{"type": "command", "command": cmd}]}); changed = True
    pieces.append({"kind": "hook", "where": s_path, "id": hid})
# las piezas compartidas, con las reglas del real: el valor del dev gana y no se anota; en el orden del real (la clave de
# raíz, después `env`)
if not shared_done:
    if "cleanupPeriodDays" not in s:
        s["cleanupPeriodDays"] = 365; changed = True
    env = s.setdefault("env", {})
    if isinstance(env, dict) and "CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR" not in env:
        env["CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR"] = "1"; changed = True
    if s.get("cleanupPeriodDays") == 365:
        pieces.append({"kind": "setting", "where": s_path, "id": "cleanupPeriodDays", "value": 365})
    if isinstance(env, dict) and env.get("CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR") == "1":
        pieces.append({"kind": "setting", "where": s_path, "id": "env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR", "value": "1"})
    for src in sorted(glob.glob(os.path.join(commands_src, "*.md"))):
        dst = os.path.join(commands_dst, os.path.basename(src))
        os.makedirs(commands_dst, exist_ok=True)
        if not os.path.exists(dst) or open(src, "rb").read() != open(dst, "rb").read(): shutil.copyfile(src, dst)
        pieces.append({"kind": "command", "where": os.path.abspath(dst), "id": os.path.basename(src)})
if changed: atomic(s_path, json.dumps(s, indent=2, ensure_ascii=False) + "\n")
try:
    names = [l.strip() for l in open(blocks_file, encoding="utf-8") if l.strip()]
except FileNotFoundError:
    names = []
if names:
    text = open(c_path, encoding="utf-8").read() if os.path.exists(c_path) else ""
    add = ""
    for n in names:
        if ("<!-- TYCON_BLOCK:%s START -->" % n) not in text:
            add += "<!-- TYCON_BLOCK:%s START -->\nbloque de juguete %s\n<!-- TYCON_BLOCK:%s END -->\n" % (n, n, n)
        pieces.append({"kind": "block", "where": c_path, "id": "TYCON_BLOCK:%s" % n})
    if add: atomic(c_path, text + ("" if not text or text.endswith("\n") else "\n") + add)
# el reporte con la forma del aplicador real (tanda B): el id de un hook es «<EVENTO>:<ruta de su spec>»
if report: atomic(report, json.dumps(pieces) + "\n")
PY
touch "$ST/lab-daily-$(date +%F)"
exit 0
SH
  chmod +x "$d/scripts/install-tycon-hooks.sh"
  printf '# gemelo de Windows del aplicador de juguete: no se ejecuta en el laboratorio\nexit 0\n' > "$d/scripts/install-tycon-hooks.ps1"
}

_harness_lab_toy_skills() { # _harness_lab_toy_skills <dir>
  local d="$1"
  mkdir -p "$d/skills/tycon-pipeline/scripts/lib" "$d/agents"
  printf '# skill de juguete (harness-lab.sh)\n' > "$d/skills/tycon-pipeline/SKILL.md"
  printf '# agent-skills de juguete\n' > "$d/README.md"
  printf '1\n' > "$d/VERSION"
}

# un repo con remoto bare, una copia «autor» (para publicar versiones nuevas) y el clon que se usa
_harness_lab_repo() { # _harness_lab_repo <semilla> <remoto> <autor> <clon>
  local seed="$1" remote="$2" author="$3" clone="$4"
  harness_lab_git "$seed" init -q -b main >/dev/null
  harness_lab_git "$seed" add -A >/dev/null
  harness_lab_git "$seed" commit -q -m "versión 1" >/dev/null
  harness_lab_git "$(dirname "$remote")" clone -q --bare "$seed" "$remote"
  harness_lab_git "$(dirname "$author")" clone -q "$remote" "$author"
  harness_lab_git "$(dirname "$clone")" clone -q "$remote" "$clone"
}

harness_lab_create() { # harness_lab_create <dir>
  local dir="${1:-}"
  case "$dir" in /*) ;; *) echo "harness-lab: «${dir}» no es una ruta absoluta — pasá una carpeta de mktemp -d" >&2; return 2 ;; esac
  node "$HARNESS_LAB_RAIZ/scripts/tests/lib/lab-guard.js" "$dir" harness-lab >&2 || return 2
  mkdir -p "$dir" || return 1
  export LAB="$(cd "$dir" && pwd)"
  export LAB_HOME="$LAB/home" LAB_BIN="$LAB/bin" LAB_TMP="$LAB/tmp"
  export LAB_REMOTE_TREE="$LAB/remotes/harness.git" LAB_REMOTE_SKILLS="$LAB/remotes/agent-skills.git"
  export LAB_AUTHOR_TREE="$LAB/author/harness" LAB_AUTHOR_SKILLS="$LAB/author/agent-skills"
  export LAB_TREE="$LAB/clones/harness" LAB_SKILLS="$LAB_HOME/.claude/agent-skills"
  mkdir -p "$LAB_HOME/.claude/.tycon-pipeline" "$LAB_BIN" "$LAB_TMP" "$LAB/remotes" "$LAB/author" "$LAB/clones" "$LAB/seed"
  _harness_lab_toy_tree "$LAB/seed/harness"
  _harness_lab_toy_skills "$LAB/seed/agent-skills"
  _harness_lab_repo "$LAB/seed/harness" "$LAB_REMOTE_TREE" "$LAB_AUTHOR_TREE" "$LAB_TREE"
  _harness_lab_repo "$LAB/seed/agent-skills" "$LAB_REMOTE_SKILLS" "$LAB_AUTHOR_SKILLS" "$LAB_SKILLS"
  _harness_lab_machine
}

# la máquina de juguete, sobre $LAB ya armado: launchctl de mentira, settings.json y CLAUDE.md vacíos, la HOME de la
# sesión reemplazada, y apagado todo lo que sale de la carpeta (el examen nocturno, el entorno gráfico, Codex, la red)
_harness_lab_machine() {
  printf '#!/bin/sh\n# launchctl de mentira (harness-lab.sh): no carga nada en la máquina real.\nexit 0\n' > "$LAB_BIN/launchctl"
  chmod +x "$LAB_BIN/launchctl"
  printf '{\n  "hooks": {}\n}\n' > "$LAB_HOME/.claude/settings.json"
  : > "$LAB_HOME/.claude/CLAUDE.md"
  export REAL_HOME="${REAL_HOME:-$HOME}" HOME="$LAB_HOME" TMPDIR="$LAB_TMP"
  harness_lab_no_auto_maintenance
  # en Windows, Node saca la carpeta de la persona de USERPROFILE y no de HOME: sin esto, `harness.js` corrido desde el
  # laboratorio en Git Bash trabajaría sobre la máquina DE VERDAD (story 8.18: la ida y la vuelta se miden en Windows)
  export USERPROFILE="$LAB_HOME"
  export TYCON_SETTINGS_PATH="$LAB_HOME/.claude/settings.json" CLAUDE_MD_PATH="$LAB_HOME/.claude/CLAUDE.md"
  export CODEX_HOME="$LAB_HOME/.codex" TYCON_GIT_HOOKS_DIR="$LAB_HOME/.git-hooks" LAUNCHCTL_BIN="$LAB_BIN/launchctl"
  export LAB_APPLIER_CHECK_LOG="$LAB/lab-applier-check.log"   # las corridas con --check, fuera de la HOME (story 8.16)
  export TYCON_NO_NIGHTLY_EXAM=1 TYCON_NO_GUI_ENV=1 TYCON_CODEX=0 TYCON_BENCH_DAILY=0 TYCON_STAGE_METRICS=0
  # story 7.27: la carpeta de los mods no se suma a CLAUDE_CODE_PLUGIN_DIRS en el laboratorio (la prueba propia es
  # scripts/tests/harness-mods.test.js); así los settings.json esperados de las demás suites quedan como estaban
  export TYCON_NO_MODS=1
  # story 8.23 (tanda C): `install` enchufa las herramientas que DETECTA; la máquina de juguete de siempre es «con
  # Claude Code y sin Codex», dicho por sus llaves (el agente de la validación no tiene ninguna de las dos instalada).
  # Las suites que prueban la detección (harness-tools.test.sh) las sacan con `harness_lab_tools`.
  export TYCON_CLAUDE=1
  # y nunca detecta sobre la máquina DE VERDAD: una suite que saca una llave (las preguntas de `install` sacan la de
  # Codex para contestarla) encontraba el `codex` del PATH de quien la corre. Se busca en una carpeta vacía del laboratorio
  export LAB_TOOLS_BIN="$LAB/tools-bin"
  mkdir -p "$LAB_TOOLS_BIN"
  export TYCON_TOOLS_DETECT_PATH="$LAB_TOOLS_BIN"
  # el perfil del laboratorio (story 8.16, tanda D): una máquina cuyo perfil de instalación ya está elegido (`full`) y nada
  # más — sin integraciones, sin política: lo que antes daba TYCON_PROFILE=0 —. Desde la tanda D, `install` sin perfil
  # elegido pregunta (y sin terminal sale 2); las suites del mecanismo no prueban eso: lo prueba harness-questions.test.sh,
  # que corre con TYCON_PROFILE=0. Un `~/.claude/tycon.json` con `install.profile` le gana, como en cualquier máquina.
  printf '{ "install": { "profile": "full" } }\n' > "$LAB/lab-profile.json"
  export TYCON_PROFILE="$LAB/lab-profile.json" TYCON_UPDATE_NETWORK_BUDGET_S="${TYCON_UPDATE_NETWORK_BUDGET_S:-5}"
  # story 8.39 (decisión 20): el laboratorio no baja el Node del arnés; una suite que lo prueba pone TYCON_HARNESS_NODE=1
  # después de armar el laboratorio, y una lista de laboratorio con un servidor local, nunca nodejs.org
  export TYCON_HARNESS_NODE=0
  export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
  export GIT_AUTHOR_NAME=Lab GIT_AUTHOR_EMAIL=lab@example.com GIT_COMMITTER_NAME=Lab GIT_COMMITTER_EMAIL=lab@example.com
  unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_COMMON_DIR TYCON_GUIDES_DIR TYCON_SKILLS_DIR TYCON_HARNESS_LOCK_HELD TYCON_HARNESS_SNAPSHOT_DIR
  unset TYCON_HARNESS_SHARED_DONE TYCON_NO_COMMANDS_SYNC TYCON_NO_AUTOINSTALL LAB_APPLIER_OLD
  unset TYCON_UPDATE_SKILLS_SOURCE LAB_SHAPE   # la llave de la 8.18: cada laboratorio nace con ella apagada
  return 0
}

harness() { node "$LAB_TREE/scripts/setup/harness.js" "$@"; }

# harness_lab_old_applier  — el aplicador de juguete pasa a ser uno de ANTES de la tanda B de la 8.16: no conoce
# --plan-json (sin las líneas que la nombran ni su bloque). harness.js lo tiene que decir en el plan y preguntar igual.
harness_lab_old_applier() {
  local f="$LAB_TREE/scripts/install-tycon-hooks.sh"
  sed -e '/# >>> plan-json/,/# <<< plan-json/d' -e '/plan-json/d' "$f" > "$f.old" && mv "$f.old" "$f" && chmod +x "$f"
}

# harness_lab_publish <tree|skills> <mensaje> [<archivo relativo> <contenido>]  — una versión nueva en el remoto
harness_lab_publish() {
  local which="$1" msg="$2" rel="${3:-}" content="${4:-}" author
  case "$which" in tree) author="$LAB_AUTHOR_TREE" ;; skills) author="$LAB_AUTHOR_SKILLS" ;; *) echo "harness-lab: publish tree|skills" >&2; return 2 ;; esac
  harness_lab_git "$author" pull -q --ff-only origin main >/dev/null 2>&1 || true
  if [ -n "$rel" ]; then mkdir -p "$(dirname "$author/$rel")"; printf '%s\n' "$content" > "$author/$rel"; else printf '%s\n' "$msg" >> "$author/CHANGES"; fi
  harness_lab_git "$author" add -A >/dev/null
  harness_lab_git "$author" commit -q -m "$msg" >/dev/null
  harness_lab_git "$author" push -q origin main >/dev/null 2>&1
}

# harness_lab_publish_hook <EVENTO> <ruta en skills/> [<contenido js>]  — un hook nuevo de agent-skills en el remoto: el
# script y su línea en lab-hooks.txt (el aplicador de juguete lo registra y lo reporta). Tanda C.
harness_lab_publish_hook() {
  local ev="$1" rel="$2" content="${3:-process.exit(0);}" a="$LAB_AUTHOR_SKILLS"
  harness_lab_git "$a" pull -q --ff-only origin main >/dev/null 2>&1 || true
  mkdir -p "$(dirname "$a/skills/$rel")"
  printf '%s\n' "$content" > "$a/skills/$rel"
  printf '%s|%s\n' "$ev" "$rel" >> "$a/lab-hooks.txt"
  harness_lab_git "$a" add -A >/dev/null
  harness_lab_git "$a" commit -q -m "hook nuevo $ev $rel" >/dev/null
  harness_lab_git "$a" push -q origin main >/dev/null 2>&1
}

# harness_lab_publish_block <nombre>  — un bloque TYCON_BLOCK nuevo declarado por el árbol, en el remoto. Tanda C.
harness_lab_publish_block() {
  local name="$1" a="$LAB_AUTHOR_TREE"
  harness_lab_git "$a" pull -q --ff-only origin main >/dev/null 2>&1 || true
  printf '%s\n' "$name" >> "$a/lab-blocks.txt"
  harness_lab_git "$a" add -A >/dev/null
  harness_lab_git "$a" commit -q -m "bloque nuevo $name" >/dev/null
  harness_lab_git "$a" push -q origin main >/dev/null 2>&1
}

# ── tanda D: el repo público de juguete (canales, versiones numeradas) y la terminal de juguete ─────────────────────
# El remoto del arnés pasa a ser «el público»: el árbol declara su remoto en scripts/setup/public-remotes.json (en la
# copia real ese archivo lo deja el exportador; en un clon interno no existe). Llamarlo ANTES de `harness install`: que
# una fuente se reescriba lo decide el remoto al instalar. Con un argumento, declara ESA url en vez de la del bare (un
# clon cuyo remoto no es el público). Sin número de versión: `main` queda sin version.json, como la primera publicación.
harness_lab_public() { # harness_lab_public [<url declarada>]
  local a="$LAB_AUTHOR_TREE" url="${1:-$LAB_REMOTE_TREE}"
  harness_lab_git "$a" pull -q --ff-only origin main >/dev/null 2>&1 || true
  mkdir -p "$a/scripts/setup"
  printf '{ "remotes": ["%s"] }\n' "$url" > "$a/scripts/setup/public-remotes.json"
  harness_lab_git "$a" add -A >/dev/null
  harness_lab_git "$a" commit -q -m "el remoto público, declarado" >/dev/null
  harness_lab_git "$a" push -q origin main >/dev/null 2>&1
  harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1
}

# el version.json de una versión publicada (la forma del contrato: sin `channel`, `source` es un mapa nombre → sha)
# Con LAB_VERSION_RAW puesta, el archivo lleva ESE texto tal cual (un version.json roto: `LAB_VERSION_RAW='{ roto'`).
_harness_lab_version_json() { # _harness_lab_version_json <número> <archivo>
  if [ -n "${LAB_VERSION_RAW:-}" ]; then printf '%s\n' "$LAB_VERSION_RAW" > "$2"; return 0; fi
  printf '{ "version": "%s", "source": { "harness": "%040d", "agent_skills": "%040d" } }\n' "$1" 1 2 > "$2"
}
# un commit con ese número, y opcionalmente un archivo, sobre lo que haya en la copia «autor»
_harness_lab_version_commit() { # _harness_lab_version_commit <número> [<archivo relativo> <contenido>]
  local a="$LAB_AUTHOR_TREE" number="$1" rel="${2:-}" content="${3:-}"
  _harness_lab_version_json "$number" "$a/version.json"
  if [ -n "$rel" ]; then mkdir -p "$(dirname "$a/$rel")"; printf '%s\n' "$content" > "$a/$rel"; else printf '%s\n' "$number" >> "$a/CHANGES"; fi
  harness_lab_git "$a" add -A >/dev/null
  harness_lab_git "$a" commit -q -m "versión $number" >/dev/null
}

# harness_lab_publish_sync <número> [<archivo relativo> <contenido>]  — una sincronización: UN commit sobre la punta de
# main, empujado con --force a mirror/sync. Dos seguidas dan dos commits que no descienden uno del otro: la rama se
# reescribe, como la del repo público.
harness_lab_publish_sync() {
  local a="$LAB_AUTHOR_TREE"
  harness_lab_git "$a" fetch -q origin >/dev/null 2>&1
  harness_lab_git "$a" checkout -q -B mirror/sync origin/main >/dev/null 2>&1 || return 1
  _harness_lab_version_commit "$@"
  harness_lab_git "$a" push -q --force origin mirror/sync >/dev/null 2>&1
}

# harness_lab_publish_stable <número> [<archivo relativo> <contenido>]  — un commit en main con ese número
harness_lab_publish_stable() {
  local a="$LAB_AUTHOR_TREE"
  harness_lab_git "$a" fetch -q origin >/dev/null 2>&1
  harness_lab_git "$a" checkout -q -B main origin/main >/dev/null 2>&1 || return 1
  _harness_lab_version_commit "$@"
  harness_lab_git "$a" push -q origin main >/dev/null 2>&1
}

# harness_lab_merge_sync  — el merge del pull request público: un commit de merge en main (nunca fast-forward), con el
# mismo version.json que traía la rama. El número no cambia; el sha, sí.
harness_lab_merge_sync() {
  local a="$LAB_AUTHOR_TREE"
  harness_lab_git "$a" fetch -q origin >/dev/null 2>&1
  harness_lab_git "$a" checkout -q -B main origin/main >/dev/null 2>&1 || return 1
  harness_lab_git "$a" merge -q --no-ff -m "Merge pull request: mirror/sync" origin/mirror/sync >/dev/null 2>&1 || return 1
  harness_lab_git "$a" push -q origin main >/dev/null 2>&1
}

# harness_lab_delete_sync  — el remoto se queda sin mirror/sync
harness_lab_delete_sync() { harness_lab_git "$LAB_AUTHOR_TREE" push -q origin --delete mirror/sync >/dev/null 2>&1; }

# harness_lab_remote_head <rama>  — la punta de esa rama en el remoto del arnés
harness_lab_remote_head() { harness_lab_git "$LAB_REMOTE_TREE" rev-parse --verify -q "refs/heads/$1"; }

# harness_lab_pty <respuesta|-> <comando…>  — corre el comando con una TERMINAL de juguete (stdin, stdout y stderr son
# una tty), escribe la respuesta («-» = no escribe nada), imprime lo que salió y devuelve el código de salida del
# comando. Con python3 + pty: igual en Mac y en Linux (`script` no lo es). Las funciones del laboratorio (`harness`) se
# pueden pasar por nombre: se resuelven antes.
# Story 8.16 (tanda B): «EOF» como respuesta cierra la entrada (Ctrl-D: la lectura vuelve vacía, como una terminal que
# se cerró); con LAB_PTY_DELAY=<segundos> la respuesta se escribe recién después de esa espera (otra instalación puede
# terminar mientras ésta espera su respuesta: T21).
harness_lab_pty() {
  local answer="$1"; shift
  if [ "${1:-}" = harness ]; then shift; set -- node "$LAB_TREE/scripts/setup/harness.js" "$@"; fi
  python3 - "$answer" "${LAB_PTY_DELAY:-0}" "$@" <<'PY'
import os, pty, select, sys, time
answer, delay, cmd = sys.argv[1], float(sys.argv[2]), sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    try:
        os.execvp(cmd[0], cmd)
    finally:
        os._exit(127)
payload = None if answer == "-" else (b"\x04" if answer == "EOF" else (answer + "\n").encode("utf-8"))
write_at = time.time() + delay
def maybe_answer():
    global payload
    if payload is not None and time.time() >= write_at:
        os.write(fd, payload)
        payload = None
maybe_answer()
out = b""
status = None
deadline = time.time() + 180
while time.time() < deadline:
    maybe_answer()
    try:
        ready, _, _ = select.select([fd], [], [], 0.2)
    except (OSError, ValueError):
        break
    if ready:
        try:
            chunk = os.read(fd, 4096)
        except OSError:      # Linux: EIO cuando el hijo cerró la terminal
            break
        if not chunk:        # Mac: lectura vacía
            break
        out += chunk
        continue
    # nada que leer: ¿el comando ya terminó? (un nieto puede dejar la terminal abierta)
    done, st = os.waitpid(pid, os.WNOHANG)
    if done:
        status = st
        break
if status is None:
    try:
        if time.time() >= deadline:
            os.kill(pid, 9)
        _, status = os.waitpid(pid, 0)
    except (ChildProcessError, ProcessLookupError):
        status = 0
sys.stdout.write(out.decode("utf-8", "replace").replace("\r\n", "\n"))
sys.stdout.flush()
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)
PY
}

# harness_lab_bootstrap <args…>  — la copia fija de arranque (la que corre la línea de arranque). Tanda C.
harness_lab_bootstrap() { node "$LAB_HOME/.claude/.tycon-pipeline/harness/bootstrap.js" "$@"; }

# harness_lab_fake_node <version>  — deja en $LAB_BIN un `node` que dice esa versión; usar con PATH="$LAB_BIN:$PATH"
harness_lab_fake_node() {
  local v="${1:-18.0.0}" real
  real="$(command -v node)"
  printf 'Object.defineProperty(process.versions, "node", { value: "%s" });\n' "$v" > "$LAB_BIN/node-version.js"
  cat > "$LAB_BIN/node" <<SH
#!/usr/bin/env bash
# node de mentira (harness-lab.sh): --version dice v$v; lo demás corre con process.versions.node = $v
if [ "\${1:-}" = "--version" ] || [ "\${1:-}" = "-v" ]; then echo "v$v"; exit 0; fi
exec "$real" -r "$LAB_BIN/node-version.js" "\$@"
SH
  chmod +x "$LAB_BIN/node"
}

# harness_lab_old_line [variante]  — la línea de arranque vieja en settings.json (y nada más del arnés)
# variantes: canonical (INSTALL.md) · sourcecode (clon en ~/SourceCode) · no-engram · no-installer · no-ff · sync (async:false)
harness_lab_old_line() {
  local variant="${1:-canonical}" cmd async=true
  local tree_cd="cd $LAB_HOME/.claude/tycon-claude-guides" skills_cd="cd $LAB_HOME/.claude/agent-skills"
  local installer="bash $LAB_HOME/.claude/tycon-claude-guides/scripts/install-tycon-hooks.sh 2>/dev/null || true"
  case "$variant" in
    canonical)    cmd="engram sync --import >/dev/null 2>&1 || true; $tree_cd && git pull --ff-only --quiet --autostash 2>/dev/null || true; $skills_cd && git pull --ff-only --quiet --autostash 2>/dev/null || true; $installer" ;;
    sourcecode)   cmd="cd $LAB/clones/harness && git pull --ff-only --autostash --quiet 2>/dev/null || true; $skills_cd && git pull --ff-only --quiet --autostash 2>/dev/null || true; bash $LAB/clones/harness/scripts/install-tycon-hooks.sh 2>/dev/null || true" ;;
    no-engram)    cmd="$tree_cd && git pull --ff-only --quiet --autostash 2>/dev/null || true; $skills_cd && git pull --ff-only --quiet --autostash 2>/dev/null || true; $installer" ;;
    no-installer) cmd="engram sync --import >/dev/null 2>&1 || true; $tree_cd && git pull --ff-only --quiet --autostash 2>/dev/null || true; $skills_cd && git pull --ff-only --quiet --autostash 2>/dev/null || true" ;;
    no-ff)        cmd="engram sync --import >/dev/null 2>&1 || true; $tree_cd && git pull --quiet 2>/dev/null || true; $skills_cd && git pull --quiet 2>/dev/null || true; $installer" ;;
    sync)         cmd="engram sync --import >/dev/null 2>&1 || true; $tree_cd && git pull --ff-only --quiet --autostash 2>/dev/null || true; $skills_cd && git pull --ff-only --quiet --autostash 2>/dev/null || true; $installer"; async=false ;;
    *) echo "harness-lab: variante desconocida «${variant}»" >&2; return 2 ;;
  esac
  LAB_LINE="$cmd" LAB_ASYNC="$async" python3 - "$TYCON_SETTINGS_PATH" <<'PY'
import json, os, sys
p = sys.argv[1]
s = json.load(open(p, encoding="utf-8")) if os.path.exists(p) else {"hooks": {}}
ss = s.setdefault("hooks", {}).setdefault("SessionStart", [])
hook = {"type": "command", "command": os.environ["LAB_LINE"]}
if os.environ["LAB_ASYNC"] == "true": hook["async"] = True
ss.append({"hooks": [hook]})
json.dump(s, open(p, "w", encoding="utf-8"), indent=2, ensure_ascii=False); open(p, "a").write("\n")
PY
}

harness_lab_state() { cat "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json" 2>/dev/null; }

harness_lab_settings_commands() {
  python3 -c 'import json,sys
s=json.load(open(sys.argv[1], encoding="utf-8"))
for h in s.get("hooks",{}).get("SessionStart",[]):
    for c in h.get("hooks",[]): print(c.get("command",""))' "$TYCON_SETTINGS_PATH"
}

# __harness_lab_tree_digest <find: lo que se poda>…  — desde la carpeta actual, una línea por enlace («ruta -> destino»)
# y una por archivo («suma  ruta»), en orden fijo. Los archivos van todos a UN shasum (xargs): con un shasum por archivo,
# cada comparación «doctor no escribió nada» costaba ~4 s en la Mac por un HOME de ~200 archivos, y el doble en el
# agente de GitHub; harness-doctor.test.sh hace decenas (public-ci, 2026-10-14: cortada a los 900 s en un agente lento).
# `xargs -r`: sin archivos no corre shasum (que leería la entrada estándar).
__harness_lab_tree_digest() {
  find . "$@" -o -type l -print0 | LC_ALL=C sort -z | while IFS= read -r -d '' f; do printf '%s -> %s\n' "$f" "$(readlink "$f")"; done
  find . "$@" -o -type f -print0 | LC_ALL=C sort -z | xargs -0 -r shasum -a 256
}

# un hash de todo el HOME de juguete (contenido y rutas; sin los .git, que cambian solos con un fetch)
harness_lab_home_hash() {
  ( cd "$LAB_HOME" && __harness_lab_tree_digest -path '*/.git' -prune ) | shasum -a 256 | cut -d' ' -f1
}

# ══ La máquina del equipo en la transición (story 8.18, tramo 3 · 2026-10-04) ══════════════════════════════════════════
# El caso: los dos repos internos (el arnés y agent-skills) se unen en uno, y cada máquina del equipo sigue un tiempo
# con sus DOS clones. Lo que hay que poder probar sin tocar ninguna máquina de verdad: que el instalador calle cuando el
# clon del arnés empieza a traer skills/ (AC 28), que los hooks no cambien (AC 29), y —el implementador que sigue— que
# la llave re-apunte el clon viejo al repo unido y lo deshaga (AC 31 a 35). Para eso hace falta la forma de esa máquina
# y, sobre todo, HISTORIA UNIDA DE VERDAD: el repo unido contiene los commits del viejo, así el clon viejo avanza en
# línea recta. Un laboratorio con dos remotos sin relación daría verde sin haber probado eso.
#
#   harness_lab_team_machine <dir> [toy|real]     (en vez de harness_lab_create; exporta lo mismo y además lo de abajo)
#
#   Los remotos (bare):
#     $LAB_REMOTE_SKILLS   el repo VIEJO de agent-skills. `main` = $LAB_COMMIT_SKILLS. Nunca recibe nada más.
#     $LAB_REMOTE_TREE     el repo del arnés, que es el UNIDO (= $LAB_REMOTE_UNIFIED). `main` nace en
#                          $LAB_COMMIT_BEFORE (el arnés de antes: sin skills/, agents/ ni packs/) y la unión espera en
#                          la rama `lab/union` ($LAB_COMMIT_UNION): un merge de verdad (--allow-unrelated-histories) del
#                          arnés con la historia del repo viejo, cuyo lado resolvió antes las tres rutas que chocan
#                          (README.md, .gitignore, VERSION), como en la unión real. `harness_lab_cut` lleva `main` ahí.
#   La máquina (HOME de juguete):
#     ~/.claude/agent-skills        un clon REAL del repo viejo ($LAB_SKILLS), con lo que tiene el de un dev: archivos
#                                   sin versionar (skills/lab-own/, lab-notes.txt), ignorados (skills/lab-third-party/,
#                                   .advisors/lab-run.json) y un stash
#     $LAB_TREE                     el clon del arnés, parado en $LAB_COMMIT_BEFORE
#     ~/.claude/tycon-claude-guides → $LAB_TREE · ~/.claude/skills → agent-skills/skills · ~/.claude/agents → agent-skills/agents
#
#   toy  (por defecto): el arnés y las skills de juguete de este archivo, con el aplicador de mentira. Para probar
#        harness.js (rápido).
#   real : el árbol de trabajo del repo bajo prueba —scripts/, build/, adapters/, claude-md-blocks/, commands/ y el
#        perfil del lado del arnés; skills/, agents/ y packs/ del lado viejo—, con lo que esté sin commitear. El
#        aplicador es el REAL: se corre con `harness_lab_real_applier`, que apaga lo que sale a la red. Para probar el
#        instalador y los enlaces. La historia sigue siendo de juguete (tres commits): no depende de la del repo.
#
# Todo git del laboratorio va por harness_lab_git (entorno limpio). Ninguna tarea programada: launchctl de mentira,
# TYCON_NO_NIGHTLY_EXAM=1 y TYCON_NO_GUI_ENV=1, como en harness_lab_create.

# copia a <destino> lo que el repo bajo prueba trae en esas rutas, CON lo que está sin commitear (lo que se prueba es el
# árbol de trabajo): lo que git sigue y lo sin seguir que no está ignorado. Lo borrado en el árbol no se copia.
_harness_lab_copy_real() { # _harness_lab_copy_real <destino> <ruta…>
  local dst="$1" list="$LAB_TMP/copy-real.list"; shift
  harness_lab_git "$HARNESS_LAB_RAIZ" ls-files -co --exclude-standard -z -- "$@" > "$list" \
    || { echo "harness-lab: no pude listar los archivos de ${HARNESS_LAB_RAIZ} (¿no es un clon de git?)" >&2; return 1; }
  python3 - "$HARNESS_LAB_RAIZ" "$dst" "$list" <<'PY' || return 1
import os, shutil, sys
src, dst, listing = sys.argv[1:4]
with open(listing, "rb") as fh:
    names = [n.decode("utf-8", "surrogateescape") for n in fh.read().split(b"\0") if n]
for rel in names:
    a, b = os.path.join(src, rel), os.path.join(dst, rel)
    if not os.path.lexists(a):
        continue
    os.makedirs(os.path.dirname(b), exist_ok=True)
    if os.path.islink(a):
        if os.path.lexists(b):
            os.remove(b)
        os.symlink(os.readlink(a), b)
    else:
        shutil.copy2(a, b)
PY
  rm -f "$list"
}

harness_lab_team_machine() { # harness_lab_team_machine <dir> [toy|real]
  local dir="${1:-}" kind="${2:-toy}"
  case "$kind" in toy|real) ;; *) echo "harness-lab: harness_lab_team_machine <dir> [toy|real] — «${kind}» no existe" >&2; return 2 ;; esac
  case "$dir" in /*) ;; *) echo "harness-lab: «${dir}» no es una ruta absoluta — pasá una carpeta de mktemp -d" >&2; return 2 ;; esac
  node "$HARNESS_LAB_RAIZ/scripts/tests/lib/lab-guard.js" "$dir" harness-lab >&2 || return 2
  mkdir -p "$dir" || return 1
  export LAB="$(cd "$dir" && pwd)"
  export LAB_KIND="$kind"
  export LAB_HOME="$LAB/home" LAB_BIN="$LAB/bin" LAB_TMP="$LAB/tmp"
  export LAB_REMOTE_TREE="$LAB/remotes/harness.git" LAB_REMOTE_SKILLS="$LAB/remotes/agent-skills.git"
  export LAB_REMOTE_UNIFIED="$LAB_REMOTE_TREE"
  export LAB_AUTHOR_TREE="$LAB/author/harness" LAB_AUTHOR_SKILLS="$LAB/author/agent-skills"
  export LAB_TREE="$LAB/clones/harness" LAB_SKILLS="$LAB_HOME/.claude/agent-skills"
  unset LAB_COMMIT_BEFORE LAB_COMMIT_SKILLS LAB_COMMIT_UNION
  mkdir -p "$LAB_HOME/.claude/.tycon-pipeline" "$LAB_BIN" "$LAB_TMP" "$LAB/remotes" "$LAB/author" "$LAB/clones" "$LAB/seed" || return 1
  local hs="$LAB/seed/harness" ss="$LAB/seed/agent-skills" u="$LAB/seed/union"

  # 1 · el lado del arnés, ANTES de la unión: sin skills/, agents/ ni packs/. Su .gitignore ya es el unido (trae las
  #     líneas del lado viejo que siguen valiendo), como el del arnés real antes del merge
  if [ "$kind" = real ]; then
    mkdir -p "$hs" || return 1
    _harness_lab_copy_real "$hs" scripts build adapters claude-md-blocks commands team-profile.json perfil-equipo.json engram-version version.json || return 1
    [ -f "$hs/scripts/install-tycon-hooks.sh" ] || { echo "harness-lab: el repo bajo prueba no trae scripts/install-tycon-hooks.sh: el laboratorio «real» no se puede armar" >&2; return 1; }
    printf '# arnés del laboratorio (harness-lab.sh, real)\n' > "$hs/README.md"
    printf '1\n' > "$hs/VERSION"
    printf '.dashboard/\n.bench/\n' > "$hs/.gitignore"
  else
    _harness_lab_toy_tree "$hs"
    # como el arnés de verdad: sigue archivos bajo .advisors/ (las evidencias), la misma carpeta donde el clon viejo de un
    # dev tiene lo suyo IGNORADO. Es lo que una vista reducida «en cono» borraría al re-apuntar (repoint.js, AC 31 c)
    mkdir -p "$hs/.advisors/dod-runtime"
    printf 'evidencia de juguete, versionada\n' > "$hs/.advisors/dod-runtime/lab-evidence.md"
  fi
  printf 'skills/lab-third-party/\n.advisors/lab-*.json\n' >> "$hs/.gitignore"

  # 2 · el repo viejo de agent-skills, con las tres rutas que chocan con el arnés (README.md, .gitignore, VERSION)
  if [ "$kind" = real ]; then
    mkdir -p "$ss" || return 1
    _harness_lab_copy_real "$ss" skills agents packs || return 1
    [ -d "$ss/skills/tycon-pipeline" ] && [ -d "$ss/agents" ] \
      || { echo "harness-lab: el repo bajo prueba no trae skills/tycon-pipeline y agents/ en su raíz: el laboratorio «real» no se puede armar acá" >&2; return 1; }
    printf '# agent-skills del laboratorio (harness-lab.sh, real)\n' > "$ss/README.md"
    printf '1\n' > "$ss/VERSION"
  else
    _harness_lab_toy_skills "$ss"
    mkdir -p "$ss/skills/lab-skill" "$ss/packs/lab"
    printf '# otra skill de juguete\n' > "$ss/skills/lab-skill/SKILL.md"
    printf '# revisor de juguete\n' > "$ss/agents/lab-reviewer.md"
    printf '{ "name": "lab" }\n' > "$ss/packs/lab/pack.json"
    # dos carpetas de la raíz que el repo viejo de verdad sigue y que NO son agents/, skills/ ni packs/ (.githooks/ y
    # .tycon/): al re-apuntar dejan de verse (AC 31 d) y al deshacer vuelven, byte a byte (AC 33)
    mkdir -p "$ss/.githooks" "$ss/.tycon"
    printf '#!/bin/sh\n# hook de juguete del repo viejo\nexit 0\n' > "$ss/.githooks/pre-commit"
    printf 'lab: true\n' > "$ss/.tycon/lab-config.yaml"
  fi
  printf '.advisors/\nskills/lab-third-party/\n' > "$ss/.gitignore"

  _harness_lab_repo "$hs" "$LAB_REMOTE_TREE" "$LAB_AUTHOR_TREE" "$LAB_TREE" || return 1
  _harness_lab_repo "$ss" "$LAB_REMOTE_SKILLS" "$LAB_AUTHOR_SKILLS" "$LAB_SKILLS" || return 1

  # 3 · la unión, en una rama del remoto del arnés: el lado viejo saca primero las tres rutas que chocan (un commit que
  #     el repo viejo nunca recibe) y después un merge de verdad. `main` del remoto NO se mueve: eso es el corte
  harness_lab_git "$LAB/seed" clone -q "$LAB_REMOTE_TREE" "$u" || return 1
  harness_lab_git "$u" fetch -q "$LAB_REMOTE_SKILLS" "refs/heads/main:refs/heads/lab/skills-side" || return 1
  harness_lab_git "$u" checkout -q lab/skills-side || return 1
  harness_lab_git "$u" rm -q README.md .gitignore VERSION || return 1
  harness_lab_git "$u" commit -q -m "agent-skills: sin las tres rutas que chocan con el arnés" || return 1
  harness_lab_git "$u" checkout -q main || return 1
  harness_lab_git "$u" merge -q --no-ff --allow-unrelated-histories -m "la unión: el arnés y agent-skills en un repo" lab/skills-side || return 1
  harness_lab_git "$u" push -q origin "main:refs/heads/lab/union" || return 1
  LAB_COMMIT_BEFORE="$(harness_lab_git "$LAB_REMOTE_TREE" rev-parse --verify -q refs/heads/main)" || return 1
  LAB_COMMIT_SKILLS="$(harness_lab_git "$LAB_REMOTE_SKILLS" rev-parse --verify -q refs/heads/main)" || return 1
  LAB_COMMIT_UNION="$(harness_lab_git "$LAB_REMOTE_TREE" rev-parse --verify -q refs/heads/lab/union)" || return 1
  export LAB_COMMIT_BEFORE LAB_COMMIT_SKILLS LAB_COMMIT_UNION

  # 4 · lo que el clon viejo de un dev tiene y git no sigue, y un stash
  mkdir -p "$LAB_SKILLS/skills/lab-own" "$LAB_SKILLS/skills/lab-third-party" "$LAB_SKILLS/.advisors" || return 1
  printf '# skill propia del dev, sin versionar\n' > "$LAB_SKILLS/skills/lab-own/SKILL.md"
  printf 'notas sin versionar\n' > "$LAB_SKILLS/lab-notes.txt"
  printf '# skill de terceros: ignorada\n' > "$LAB_SKILLS/skills/lab-third-party/SKILL.md"
  printf '{ "lab": true }\n' > "$LAB_SKILLS/.advisors/lab-run.json"
  printf '\ntrabajo a medias\n' >> "$LAB_SKILLS/skills/tycon-pipeline/SKILL.md"
  harness_lab_git "$LAB_SKILLS" stash push -q -m "lab: trabajo a medias" || return 1

  # 5 · los enlaces de una máquina del equipo
  ln -s "$LAB_TREE" "$LAB_HOME/.claude/tycon-claude-guides" || return 1
  ln -s "$LAB_SKILLS/skills" "$LAB_HOME/.claude/skills" || return 1
  ln -s "$LAB_SKILLS/agents" "$LAB_HOME/.claude/agents" || return 1
  _harness_lab_machine
}

# harness_lab_single_tree <dir>  — la máquina NUEVA de un solo árbol (story 8.18, AC 36 y 37): la tercera forma de
# máquina. Un clon del repo unido (el corte ya hecho) y ~/.claude/agent-skills, skills y agents enlazados a él: no hay
# clon aparte. Se arma sobre la misma historia unida que la máquina del equipo (de juguete), así las tres formas se
# prueban con los mismos remotos. $LAB_SKILLS queda como la ruta del enlace.
harness_lab_single_tree() { # harness_lab_single_tree <dir>
  harness_lab_team_machine "${1:-}" toy || return $?
  harness_lab_cut || return 1
  harness_lab_pull_tree || return 1
  rm -f "$LAB_HOME/.claude/skills" "$LAB_HOME/.claude/agents" || return 1
  rm -rf "$LAB_SKILLS" || return 1
  ln -s "$LAB_TREE" "$LAB_HOME/.claude/agent-skills" || return 1
  ln -s "$LAB_TREE/skills" "$LAB_HOME/.claude/skills" || return 1
  ln -s "$LAB_TREE/agents" "$LAB_HOME/.claude/agents" || return 1
  export LAB_KIND=single
}

# harness_lab_shape <dir> <two-clones|repointed|single>  — una máquina YA INSTALADA con `harness.js`, en una de las tres
# formas que deja la unión de los dos repos (story 8.18, AC 37), para probar que cada comando del mecanismo anda en las tres:
#   two-clones  dos clones sin re-apuntar: el arnés ya en la unión, las skills en el clon viejo (la llave apagada)
#   repointed   dos clones con el viejo RE-APUNTADO al repo unificado; la llave queda prendida en ~/.claude/tycon.json
#               (si no, el arranque siguiente lo desharía)
#   single      un solo árbol: ~/.claude/agent-skills es un enlace al clon del arnés
# Exporta lo de siempre y LAB_SHAPE. La política de la instalación es `auto` (la del equipo); lo que siga decide la suya.
harness_lab_shape() { # harness_lab_shape <dir> <two-clones|repointed|single>
  local dir="${1:-}" shape="${2:-}"
  case "$shape" in
    two-clones|repointed)
      harness_lab_team_machine "$dir" toy >/dev/null || return 1
      TYCON_UPDATE_APPLY=auto harness install --yes >/dev/null 2>&1 || return 1
      harness_lab_cut || return 1
      TYCON_UPDATE_APPLY=auto harness update >/dev/null 2>&1 || return 1
      if [ "$shape" = repointed ]; then
        printf '{ "update": { "skills_source": "unified" } }\n' > "$LAB_HOME/.claude/tycon.json"
        TYCON_UPDATE_APPLY=auto harness update >/dev/null 2>&1 || return 1
        [ "$(harness_lab_git "$LAB_SKILLS" remote get-url origin)" = "$LAB_REMOTE_UNIFIED" ] || { echo "harness-lab: la máquina no quedó re-apuntada" >&2; return 1; }
      fi ;;
    single)
      harness_lab_single_tree "$dir" >/dev/null || return 1
      TYCON_UPDATE_APPLY=auto harness install --yes >/dev/null 2>&1 || return 1 ;;
    *) echo "harness-lab: harness_lab_shape <dir> <two-clones|repointed|single> — «${shape}» no existe" >&2; return 2 ;;
  esac
  export LAB_SHAPE="$shape"
}

# harness_lab_worktree_hash <clon>  — un hash de TODO lo que hay en el árbol de trabajo de ese clon (rutas y contenido,
# sin su .git): «quedó byte a byte como al principio» se prueba comparando dos (story 8.18, AC 33)
harness_lab_worktree_hash() {
  local d="${1:-}"
  [ -n "$d" ] && [ -d "$d" ] || { echo "harness-lab: harness_lab_worktree_hash <clon> — «${d}» no existe" >&2; return 2; }
  ( cd "$d" && __harness_lab_tree_digest -path ./.git -prune ) | shasum -a 256 | cut -d' ' -f1
}

# harness_lab_cut  — el corte: `main` del remoto del arnés pasa a ser la unión (trae skills/, agents/ y packs/). Se
# niega si `main` ya no está en el commit de antes (se cortó dos veces, o alguien publicó antes del corte).
harness_lab_cut() {
  [ -n "${LAB_COMMIT_UNION:-}" ] || { echo "harness-lab: harness_lab_cut sin la máquina del equipo armada (harness_lab_team_machine)" >&2; return 2; }
  harness_lab_git "$LAB_REMOTE_TREE" update-ref refs/heads/main "$LAB_COMMIT_UNION" "$LAB_COMMIT_BEFORE"
}

# harness_lab_pull_tree  — el clon del arnés avanza en línea recta a lo publicado (lo que hace el arranque de sesión)
harness_lab_pull_tree() { harness_lab_git "$LAB_TREE" pull -q --ff-only origin main; }

# harness_lab_publish_without_skills  — una punta de `main` que NO trae skills/, agents/ ni packs/: `main` devuelto al
# árbol de antes de la unión con un commit nuevo encima (el retorno que dejaría sin skills a una máquina re-apuntada)
harness_lab_publish_without_skills() {
  local a="$LAB_AUTHOR_TREE"
  harness_lab_git "$a" pull -q --ff-only origin main || return 1
  [ -d "$a/skills" ] || { echo "harness-lab: main todavía no trae skills/ (¿faltó harness_lab_cut?): no hay nada que sacar" >&2; return 2; }
  harness_lab_git "$a" rm -r -q skills agents packs || return 1
  harness_lab_git "$a" commit -q -m "retorno: main vuelve al árbol de antes de la unión" || return 1
  harness_lab_git "$a" push -q origin main
}

# harness_lab_clone_extras <clon>  — un hash de lo que git NO sigue en ese clon (sin versionar e ignorado: rutas y
# contenido) y de sus stash (el commit de cada uno): «nada se movió en el disco» se prueba comparando dos
harness_lab_clone_extras() {
  local d="${1:-}" f
  [ -n "$d" ] && [ -d "$d" ] || { echo "harness-lab: harness_lab_clone_extras <clon> — «${d}» no existe" >&2; return 2; }
  {
    harness_lab_git "$d" ls-files --others -z | while IFS= read -r -d '' f; do
      printf '%s ' "$f"
      if [ -L "$d/$f" ]; then printf -- '-> %s\n' "$(readlink "$d/$f")"; else shasum -a 256 < "$d/$f"; fi
    done
    harness_lab_git "$d" stash list --format='%H %gs'
  } | shasum -a 256 | cut -d' ' -f1
}

# harness_lab_links  — a dónde apunta cada enlace de ~/.claude que el arnés conoce, o qué hay en su lugar
harness_lab_links() {
  local n p
  for n in tycon-claude-guides agent-skills skills agents; do
    p="$LAB_HOME/.claude/$n"
    if [ -L "$p" ]; then printf '%s -> %s\n' "$n" "$(readlink "$p")"
    elif [ -d "$p" ]; then printf '%s = carpeta\n' "$n"
    elif [ -e "$p" ]; then printf '%s = archivo\n' "$n"
    else printf '%s = falta\n' "$n"; fi
  done
}

# harness_lab_isolated <comando…>  — corre el comando con apagado lo que el aplicador REAL saca a la red o le pregunta a
# la máquina: Azure DevOps, el buzón, engram, sqlite3, las skills de terceros (su respaldo baja de internet), los
# punteros AGENTS.md y el rescate del hilo. Lo local queda prendido (los enlaces, el aviso de la ruta, settings.json,
# los bloques, los comandos de barra, los hooks de git): es lo que se mide. Las funciones del laboratorio (`harness`) se
# pueden pasar por nombre. Quien llama suma o cambia interruptores por delante: `TYCON_CODEX=1 harness_lab_isolated …`.
harness_lab_isolated() {
  if [ "${1:-}" = harness ]; then shift; set -- node "$LAB_TREE/scripts/setup/harness.js" "$@"; fi
  env TYCON_NO_AZ_PROJECTS_REFRESH=1 TYCON_NO_BOOTSTRAP_HEAL=1 TYCON_NO_ENGRAM_PROJECT_CHECK=1 TYCON_NO_ENGRAM_VERSION_CHECK=1 \
    TYCON_NO_SQLITE_CHECK=1 TYCON_NO_AGENTSMD_POINTER=1 TYCON_NO_THREAD_RESCUE=1 TYCON_NO_UPLOAD_RUNS=1 TYCON_NO_DOWNLOAD_RUNS=1 \
    TYCON_NO_COLLECT_FINDINGS=1 TYCON_MAILBOX_URL_BASE=http://127.0.0.1:9 TYCON_THIRD_PARTY=0 \
    "$@"
}

# harness_lab_real_applier [args…]  — el aplicador REAL del clon del laboratorio (sólo con `real`), aislado
harness_lab_real_applier() {
  [ "${LAB_KIND:-}" = real ] || { echo "harness-lab: harness_lab_real_applier pide el laboratorio «real» (harness_lab_team_machine <dir> real)" >&2; return 2; }
  harness_lab_isolated bash "$LAB_TREE/scripts/install-tycon-hooks.sh" "$@"
}

# harness_lab_seed_codex_links  — los enlaces de ~/.codex/skills de una máquina del equipo: uno por skill del clon viejo,
# hacia él (como los deja build/deploy-shared-skills.js), más uno ajeno y una carpeta propia del dev
harness_lab_seed_codex_links() {
  local d="$CODEX_HOME/skills" s
  mkdir -p "$d/own-lab-skill" "$LAB/elsewhere/other-lab-skill" || return 1
  printf '# skill propia del dev en Codex\n' > "$d/own-lab-skill/SKILL.md"
  ln -s "$LAB/elsewhere/other-lab-skill" "$d/other-lab-skill" || return 1
  for s in "$LAB_SKILLS"/skills/*/; do
    [ -f "${s}SKILL.md" ] || continue
    s="${s%/}"
    [ -e "$d/$(basename "$s")" ] || [ -L "$d/$(basename "$s")" ] || ln -s "$s" "$d/$(basename "$s")" || return 1
  done
}

# harness_lab_codex_links  — los enlaces de ~/.codex/skills, uno por línea («nombre -> destino»), ordenados
harness_lab_codex_links() {
  local d="$CODEX_HOME/skills" p
  [ -d "$d" ] || return 0
  for p in "$d"/*; do
    [ -L "$p" ] && printf '%s -> %s\n' "$(basename "$p")" "$(readlink "$p")"
  done | LC_ALL=C sort
}

# ── story 8.23, tanda B: la máquina que instala una versión BAJADA (sin git) del servidor de juguete ────────────────
#
#   harness_lab_release_server [org name]  — el «GitHub» de juguete (scripts/tests/fixtures/toy-release-server.js) sobre el
#                                            remoto bare del arnés: la API, «codeload», un proxy y un proxy mudo, cada
#                                            uno en su puerto. Publica en main el remoto público declarado
#                                            (https://github.com/<org>/<name>) y skills/, agents/ y packs/ (el repo
#                                            unido). Exporta LAB_RELEASE_API, LAB_RELEASE_CODELOAD, LAB_RELEASE_PROXY,
#                                            LAB_RELEASE_MUTE_PROXY, LAB_RELEASE_CONTROL, LAB_RELEASE_LOG y
#                                            TYCON_RELEASE_API (la variable de prueba que apunta el cliente al servidor).
#                                            Desde la story 8.34 también las rutas públicas: «git» (info/refs) y «raw»,
#                                            en LAB_RELEASE_GIT / LAB_RELEASE_RAW, y TYCON_RELEASE_GIT / _RAW / _ARCHIVE.
#                                            El servidor usa el git REAL por ruta absoluta: así un `git` testigo en el
#                                            PATH sólo ve lo que invoca el mecanismo. Muere con la suite (su proceso en
#                                            LAB_RELEASE_PROCESS; el `kill $(jobs -p)` del trap lo alcanza).
#   harness_lab_release_control '<json>'   — reescribe el archivo de control (auth, ratelimit, mute, truncate, tamper…)
#   harness_lab_release_fresh_home         — una HOME de juguete SIN arnés: sin clon de skills, sin estado, sin ~/.tycon,
#                                            settings vacío (la máquina nueva que instala con `install --version`);
#                                            LAB_TREE sigue siendo la copia del programa desde la que se corre `install`
#   harness_release <args…>                — harness.js DE LA VERSIÓN INSTALADA (~/.tycon/harness)
#   harness_lab_git_witness                — un `git` en el PATH que anota cada invocación en LAB_GIT_WITNESS_LOG y
#                                            después corre el de verdad: «git nunca invocado» se prueba leyendo ese archivo
harness_lab_release_server() { # harness_lab_release_server [<org> <name>]
  local org="${1:-TYCON-LAB}" name="${2:-arnes-lab}" a="$LAB_AUTHOR_TREE" i
  export LAB_RELEASE_ORG="$org" LAB_RELEASE_NAME="$name" LAB_RELEASE_DIR="$LAB/release-server"
  mkdir -p "$LAB_RELEASE_DIR" || return 1
  export LAB_RELEASE_CONTROL="$LAB_RELEASE_DIR/control.json" LAB_RELEASE_LOG="$LAB_RELEASE_DIR/requests.log"
  printf '{ "auth": "none" }\n' > "$LAB_RELEASE_CONTROL"
  : > "$LAB_RELEASE_LOG"
  # el árbol publicado: el remoto público declarado con el nombre que atiende el servidor, y el repo unido (skills/,
  # agents/, packs/ en main), que es lo que una versión bajada tiene que traer
  harness_lab_git "$a" pull -q --ff-only origin main >/dev/null 2>&1 || true
  mkdir -p "$a/scripts/setup" "$a/agents" "$a/packs"
  printf '{ "remotes": ["https://github.com/%s/%s"] }\n' "$org" "$name" > "$a/scripts/setup/public-remotes.json"
  [ -d "$a/skills" ] || cp -R "$LAB/seed/agent-skills/skills" "$a/skills"
  [ -f "$a/agents/README.md" ] || printf '# agentes de juguete\n' > "$a/agents/README.md"
  [ -f "$a/packs/README.md" ] || printf '# paquetes de juguete\n' > "$a/packs/README.md"
  harness_lab_git "$a" add -A >/dev/null
  harness_lab_git "$a" commit -q -m "el remoto público y el repo unido, para la versión bajada" >/dev/null 2>&1 || true
  harness_lab_git "$a" push -q origin main >/dev/null 2>&1
  harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1 || true
  rm -f "$LAB_RELEASE_DIR/ports.env"
  node "$HARNESS_LAB_RAIZ/scripts/tests/fixtures/toy-release-server.js" --repo "$LAB_REMOTE_TREE" --org "$org" --name "$name" \
    --git "$(command -v git)" --control "$LAB_RELEASE_CONTROL" --log "$LAB_RELEASE_LOG" --port-file "$LAB_RELEASE_DIR/ports.env" &
  export LAB_RELEASE_PROCESS=$!
  for i in $(seq 1 100); do [ -f "$LAB_RELEASE_DIR/ports.env" ] && break; sleep 0.1; done
  [ -f "$LAB_RELEASE_DIR/ports.env" ] || { echo "harness-lab: el servidor de versiones de juguete no arrancó" >&2; return 1; }
  _harness_lab_release_ports
}
# las direcciones del servidor de juguete: la API y, desde la story 8.34, las rutas públicas (git, raw, codeload) — sin
# TYCON_RELEASE_GIT, una máquina con la API apuntada al juguete mira por la API (la salvaguarda de public-git.js)
_harness_lab_release_ports() {
  local f="$LAB_RELEASE_DIR/ports.env"
  export LAB_RELEASE_API="$(sed -n 's/^API=//p' "$f")" LAB_RELEASE_CODELOAD="$(sed -n 's/^CODELOAD=//p' "$f")"
  export LAB_RELEASE_PROXY="$(sed -n 's/^PROXY=//p' "$f")" LAB_RELEASE_MUTE_PROXY="$(sed -n 's/^MUTE_PROXY=//p' "$f")"
  export LAB_RELEASE_GIT="$(sed -n 's/^GIT=//p' "$f")" LAB_RELEASE_RAW="$(sed -n 's/^RAW=//p' "$f")"
  export TYCON_RELEASE_API="$LAB_RELEASE_API" TYCON_RELEASE_GIT="$LAB_RELEASE_GIT" TYCON_RELEASE_RAW="$LAB_RELEASE_RAW" TYCON_RELEASE_ARCHIVE="$LAB_RELEASE_CODELOAD"
}
harness_lab_release_control() { printf '%s\n' "$1" > "$LAB_RELEASE_CONTROL"; }
# ── El repo del equipo de juguete (story 8.25) ────────────────────────────────────────────────────────────────────────
#   harness_lab_team_repo [<org> <name>]  — el repo PRIVADO del equipo, de juguete: un bare ($LAB_REMOTE_TEAM) con su autor
#                                           ($LAB_AUTHOR_TEAM) y los tres archivos de la A1: team-layer.json, perfil-equipo.json
#                                           (organización inventada; engram, nightly y el buzón prendidos) y la llave de
#                                           juguete del buzón. Exporta LAB_TEAM=<org>/<name>.
#   harness_lab_team_publish "<mensaje>"  — commit + push de lo que haya en el autor del repo del equipo
#   harness_lab_team_server               — reinicia el servidor de versiones de juguete atendiendo los DOS repos (el público
#                                           con LAB_RELEASE_ORG/NAME y el del equipo); mismo control y registro
#   harness_lab_team_set_clone_key        — la clave `team` en public-repos.json del CLON de juguete ($LAB_TREE): la máquina
#                                           con clon que «sabe» cuál es su repo del equipo (AC 13)
harness_lab_team_repo() { # harness_lab_team_repo [<org> <name>]
  local org="${1:-TYCON-LAB}" name="${2:-equipo-lab}"
  export LAB_TEAM_ORG="$org" LAB_TEAM_NAME="$name" LAB_TEAM="$org/$name"
  export LAB_REMOTE_TEAM="$LAB/remotes/team.git" LAB_AUTHOR_TEAM="$LAB/author/team"
  rm -rf "$LAB_REMOTE_TEAM" "$LAB_AUTHOR_TEAM" "$LAB/seed/team"
  mkdir -p "$LAB/seed/team/scripts/metrics" || return 1
  printf '{ "schema": 1, "name": "equipo-lab", "requires": { "harness": ">= 2026.10.01.1" } }\n' > "$LAB/seed/team/team-layer.json"
  printf '{ "ado": { "org": "https://dev.azure.com/acme" }, "integrations": { "engram": true, "nightly": true, "mailbox": true }, "update": { "channel": "latest", "apply": "auto" }, "packs": { "default": "all" }, "install": { "profile": "full" } }\n' > "$LAB/seed/team/perfil-equipo.json"
  printf '{ "_que_es": "la llave de JUGUETE del buzón de corridas (laboratorio): no abre nada", "cuenta": "labcorridas", "contenedor": "corridas", "sas": "sv=lab&sig=juguete", "vence": "2099-01-01" }\n' > "$LAB/seed/team/scripts/metrics/corridas-buzon.json"
  printf '# el repo del equipo de juguete (harness-lab.sh)\n' > "$LAB/seed/team/README.md"
  harness_lab_git "$LAB/seed/team" init -q -b main >/dev/null
  harness_lab_git "$LAB/seed/team" add -A >/dev/null
  harness_lab_git "$LAB/seed/team" commit -q -m "el perfil, la llave y la declaración de la capa" >/dev/null
  harness_lab_git "$LAB/remotes" clone -q --bare "$LAB/seed/team" "$LAB_REMOTE_TEAM"
  harness_lab_git "$LAB/author" clone -q "$LAB_REMOTE_TEAM" "$LAB_AUTHOR_TEAM"
}
harness_lab_team_publish() { # harness_lab_team_publish "<mensaje>"
  harness_lab_git "$LAB_AUTHOR_TEAM" add -A >/dev/null
  harness_lab_git "$LAB_AUTHOR_TEAM" commit -q --allow-empty -m "${1:-cambio del equipo}" >/dev/null
  harness_lab_git "$LAB_AUTHOR_TEAM" push -q origin main >/dev/null 2>&1
}
harness_lab_team_head() { harness_lab_git "$LAB_REMOTE_TEAM" rev-parse --verify -q refs/heads/main; }
harness_lab_team_server() {
  [ -n "${LAB_RELEASE_PROCESS:-}" ] && kill "$LAB_RELEASE_PROCESS" 2>/dev/null
  local i
  for i in $(seq 1 30); do kill -0 "${LAB_RELEASE_PROCESS:-0}" 2>/dev/null || break; sleep 0.1; done
  rm -f "$LAB_RELEASE_DIR/ports.env"
  node "$HARNESS_LAB_RAIZ/scripts/tests/fixtures/toy-release-server.js" \
    --repo "$LAB_REMOTE_TREE" --org "$LAB_RELEASE_ORG" --name "$LAB_RELEASE_NAME" \
    --repo "$LAB_REMOTE_TEAM" --org "$LAB_TEAM_ORG" --name "$LAB_TEAM_NAME" \
    --git "$(command -v git)" --control "$LAB_RELEASE_CONTROL" --log "$LAB_RELEASE_LOG" --port-file "$LAB_RELEASE_DIR/ports.env" &
  export LAB_RELEASE_PROCESS=$!
  for i in $(seq 1 100); do [ -f "$LAB_RELEASE_DIR/ports.env" ] && break; sleep 0.1; done
  [ -f "$LAB_RELEASE_DIR/ports.env" ] || { echo "harness-lab: el servidor de versiones de juguete (dos repos) no arrancó" >&2; return 1; }
  _harness_lab_release_ports
}
# ── El repo del equipo en AZURE DEVOPS, de juguete (story 8.25, la fuente de TYCON) ──────────────────────────────────
#   harness_lab_team_azure_server [<org> <proyecto> <repo>]  — un Azure DevOps de juguete (scripts/tests/fixtures/toy-azure-server.js)
#                                           que atiende el MISMO repo bare del equipo ($LAB_REMOTE_TEAM, de harness_lab_team_repo)
#                                           con PAT «pat-lab»; exporta TYCON_AZURE_API y LAB_TEAM_URL (la URL que se declara con
#                                           --team o en la clave team del clon). El control: $LAB_AZURE_CONTROL (pat, blind,
#                                           missing_repo, truncated_tree, tamper_item); el registro: $LAB_AZURE_LOG.
#   harness_lab_team_azure_control '<json>' — reescribe el control
#   harness_lab_team_azure_pat [<valor>]    — guarda el PAT en ~/.tycon/config.json de la máquina de juguete (azure.token), como
#                                           lo haría `harness.js config set azure.token` (sin pasar por la terminal)
harness_lab_team_azure_server() { # harness_lab_team_azure_server [<org> <proyecto> <repo>]
  local org="${1:-acme}" project="${2:-proyecto}" name="${3:-equipo-lab}" i
  export LAB_AZURE_DIR="$LAB/azure-server" LAB_TEAM_URL="https://dev.azure.com/$org/$project/_git/$name" LAB_AZURE_PAT="pat-lab"
  mkdir -p "$LAB_AZURE_DIR" || return 1
  export LAB_AZURE_CONTROL="$LAB_AZURE_DIR/control.json" LAB_AZURE_LOG="$LAB_AZURE_DIR/requests.log"
  printf '{ "pat": "%s" }\n' "$LAB_AZURE_PAT" > "$LAB_AZURE_CONTROL"
  : > "$LAB_AZURE_LOG"
  [ -n "${LAB_AZURE_PROCESS:-}" ] && kill "$LAB_AZURE_PROCESS" 2>/dev/null
  rm -f "$LAB_AZURE_DIR/ports.env"
  node "$HARNESS_LAB_RAIZ/scripts/tests/fixtures/toy-azure-server.js" --repo "$LAB_REMOTE_TEAM" --org "$org" --project "$project" --name "$name" \
    --git "$(command -v git)" --control "$LAB_AZURE_CONTROL" --log "$LAB_AZURE_LOG" --port-file "$LAB_AZURE_DIR/ports.env" &
  export LAB_AZURE_PROCESS=$!
  for i in $(seq 1 100); do [ -f "$LAB_AZURE_DIR/ports.env" ] && break; sleep 0.1; done
  [ -f "$LAB_AZURE_DIR/ports.env" ] || { echo "harness-lab: el Azure DevOps de juguete no arrancó" >&2; return 1; }
  export TYCON_AZURE_API="$(sed -n 's/^AZURE=//p' "$LAB_AZURE_DIR/ports.env")"
  # el gestor de credenciales de git de la máquina REAL no entra al laboratorio: sólo el PAT guardado decide
  export TYCON_AZURE_GIT_CREDENTIAL=0
}
harness_lab_team_azure_control() { printf '%s\n' "$1" > "$LAB_AZURE_CONTROL"; }
harness_lab_team_azure_pat() { # harness_lab_team_azure_pat [<valor>]
  # por el MISMO camino que el dev: `harness.js config set azure.token` con el valor por stdin (pase adversarial 8.25 A1a-azure:
  # el laboratorio escribía el archivo a mano y nadie notó que el comando recomendado salía 2). Si el comando falla, la prueba
  # que lo llamó falla con su salida: no hay otro camino.
  local v="${1:-$LAB_AZURE_PAT}" out rc
  mkdir -p "$LAB_HOME/.tycon"
  out="$(printf '%s' "$v" | harness config set azure.token 2>&1)"; rc=$?
  if [ "$rc" != 0 ]; then echo "harness_lab_team_azure_pat: config set azure.token salió $rc: $out" >&2; return 1; fi
  case "$out" in *"$v"*) echo "harness_lab_team_azure_pat: el PAT apareció en la salida de config set" >&2; return 1 ;; esac
  node -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(j.azure && j.azure.token === process.argv[2] ? 0 : 1)' "$LAB_HOME/.tycon/config.json" "$v" \
    || { echo "harness_lab_team_azure_pat: config set no dejó azure.token en $LAB_HOME/.tycon/config.json" >&2; return 1; }
}
harness_lab_team_set_clone_key() { # harness_lab_team_set_clone_key [<org/name o URL>]
  local v="${1:-$LAB_TEAM}"
  node -e '
    const fs = require("fs"); const [f, v] = process.argv.slice(1);
    let j = {}; try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { j = {}; }
    j.team = v; fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");' "$LAB_TREE/scripts/publishing/public-repos.json" "$v"
}
harness_lab_release_fresh_home() {
  local pipe="$LAB_HOME/.claude/.tycon-pipeline"
  rm -rf "$LAB_HOME/.claude/agent-skills" "$pipe" "$LAB_HOME/.claude/tycon-harness" "$LAB_HOME/.tycon" || return 1
  mkdir -p "$pipe" || return 1
  printf '{\n  "hooks": {}\n}\n' > "$LAB_HOME/.claude/settings.json"
  : > "$LAB_HOME/.claude/CLAUDE.md"
}
harness_release() { node "$LAB_HOME/.tycon/harness/scripts/setup/harness.js" "$@"; }
# ── Las herramientas de la máquina de juguete (story 8.23, tanda C) ──────────────────────────────────────────────────
#   harness_lab_tools <claude|codex|both|none>  — qué herramientas «tiene» la máquina: un `claude` y/o un `codex` de
#                                            mentira en $LAB_TOOLS_BIN, que es DONDE el arnés las busca en el laboratorio
#                                            (TYCON_TOOLS_DETECT_PATH: variable de prueba, reemplaza al PATH sólo para
#                                            detectar; el PATH de verdad de quien corre la suite puede traer las dos).
#                                            Saca las llaves del laboratorio (TYCON_CLAUDE / TYCON_CODEX): decide el disco.
#   harness_lab_tools_fresh_home           — la máquina sin arnés y SIN la carpeta de ninguna herramienta (ni ~/.claude,
#                                            ni ~/.codex, ni ~/.tycon, ni ~/.claude.json)
#   harness_lab_claude_home_listing        — todo lo que hay bajo ~/.claude, una ruta por línea (o nada): «nada nuevo
#                                            en ~/.claude» se prueba comparando dos
harness_lab_tools() { # harness_lab_tools <claude|codex|both|none>
  export LAB_TOOLS_BIN="$LAB/tools-bin"
  rm -rf "$LAB_TOOLS_BIN"; mkdir -p "$LAB_TOOLS_BIN" || return 1
  local t
  for t in claude codex; do
    case "$1:$t" in claude:claude|codex:codex|both:*)
      printf '#!/bin/sh\n# %s DE MENTIRA (harness-lab.sh, story 8.23 C): sólo dice su versión\necho "%s 0.0.0-lab"\n' "$t" "$t" > "$LAB_TOOLS_BIN/$t"
      chmod +x "$LAB_TOOLS_BIN/$t" ;;
    esac
  done
  export TYCON_TOOLS_DETECT_PATH="$LAB_TOOLS_BIN"
  unset TYCON_CLAUDE TYCON_CODEX
}
harness_lab_tools_fresh_home() {
  rm -rf "$LAB_HOME/.claude" "$LAB_HOME/.codex" "$LAB_HOME/.tycon" "$LAB_HOME/.claude.json" || return 1
}
harness_lab_claude_home_listing() {
  [ -e "$LAB_HOME/.claude" ] || [ -L "$LAB_HOME/.claude" ] || return 0
  ( cd "$LAB_HOME" && find .claude | LC_ALL=C sort )
}
#   harness_lab_codex_pieces               — lo que el enchufe de Codex necesita del árbol, sumado a lo PUBLICADO (va
#                                            antes de `harness_lab_publish_stable`): los desplegadores REALES de build/,
#                                            el escritor de AGENTS.md y el hook de arranque reales, y de juguete un
#                                            fragmento de hooks (el arranque + un hook), un revisor (`lab-advisor`, con
#                                            su perfil y su subagente generados por el generador real) y dos bloques de
#                                            reglas (`lab-rules`, y `lab-names` con su variante de Codex). Pide el árbol
#                                            unido: va después de `harness_lab_release_server`
harness_lab_codex_pieces() {
  local a="$LAB_AUTHOR_TREE" f
  harness_lab_git "$a" pull -q --ff-only origin main >/dev/null 2>&1 || true
  mkdir -p "$a/build" "$a/adapters/codex/agents" "$a/adapters/codex/agents-native" "$a/claude-md-blocks/names" "$a/scripts/hooks" "$a/scripts/setup" || return 1
  cp "$HARNESS_LAB_RAIZ"/build/*.js "$HARNESS_LAB_RAIZ"/build/*.json "$a/build/" || return 1
  cp "$HARNESS_LAB_RAIZ/scripts/setup/agents-md-blocks.js" "$a/scripts/setup/" || return 1
  for f in harness-startup.js; do [ -f "$HARNESS_LAB_RAIZ/scripts/hooks/$f" ] && cp "$HARNESS_LAB_RAIZ/scripts/hooks/$f" "$a/scripts/hooks/"; done
  # un revisor de juguete, generado con el generador REAL (así el árbol trae su perfil y su subagente como los trae el
  # arnés: generados y versionados). El canónico va en agents/ del árbol: el laboratorio de la versión bajada es unido.
  mkdir -p "$a/agents"
  printf -- '---\nname: lab-advisor\ndescription: revisor de juguete del laboratorio\nmodel: sonnet\ntools: Read, Grep, Glob\n---\n\nSos un revisor de juguete: no revisás nada.\n' > "$a/agents/lab-advisor.md"
  printf '{ "advisors": [] }\n' > "$a/adapters/codex/agents/MANIFEST.json"
  ( cd "$a" && TYCON_AGENTS_DIR="$a/agents" CODEX_HOME="$LAB_TMP/codex-gen" node build/generate.js --add lab-advisor >/dev/null 2>&1 ) || { echo "harness-lab: no pude generar el revisor de juguete" >&2; return 1; }
  cat > "$a/adapters/codex/hooks.json" <<'JSON'
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "node ${TCG}/scripts/hooks/harness-startup.js" } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "node ${TCG}/scripts/hooks/lab-store-hook.js" } ] }
    ],
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node ${TCG}/scripts/hooks/lab-hook.js" } ] }
    ]
  }
}
JSON
  # un hook que guarda lo suyo bajo la carpeta de Claude Code, como varios de verdad (el reloj, los medidores): la
  # comprobación de salud lo LANZA, y en una máquina sólo con Codex eso no puede crear esa carpeta
  cat > "$a/scripts/hooks/lab-store-hook.js" <<'JS'
// hook de juguete (harness-lab.sh): guarda su estado bajo la carpeta de Claude Code de quien lo corre
const fs = require('fs'), os = require('os'), path = require('path');
try { fs.mkdirSync(path.join(os.homedir(), '.claude', 'lab-hook-store'), { recursive: true }); } catch (_) { /* nada */ }
process.exit(0);
JS
  printf '# Reglas de juguete\nregla del laboratorio\n' > "$a/claude-md-blocks/lab-rules.md"
  printf '# Nombres de juguete\nnombres del lado Claude\n' > "$a/claude-md-blocks/lab-names.md"
  printf '# Nombres de juguete\nnombres del lado Codex\n' > "$a/claude-md-blocks/names/lab-names.codex.md"
  harness_lab_git "$a" add -A >/dev/null
  harness_lab_git "$a" commit -q -m "las piezas del enchufe de Codex" >/dev/null 2>&1 || true
  harness_lab_git "$a" push -q origin main >/dev/null 2>&1
  harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1 || true
}
harness_lab_release_log() { cat "$LAB_RELEASE_LOG" 2>/dev/null; }
harness_lab_git_witness() {
  export LAB_GIT_WITNESS_LOG="$LAB/git-witness.log"
  : > "$LAB_GIT_WITNESS_LOG"
  local real; real="$(command -v git)"
  printf '#!/bin/sh\n# git TESTIGO (harness-lab.sh, story 8.23 B): anota la invocación y corre el de verdad\nprintf "%%s\\n" "$*" >> "%s"\nexec "%s" "$@"\n' "$LAB_GIT_WITNESS_LOG" "$real" > "$LAB_BIN/git"
  chmod +x "$LAB_BIN/git"
  export PATH="$LAB_BIN:$PATH"
}
