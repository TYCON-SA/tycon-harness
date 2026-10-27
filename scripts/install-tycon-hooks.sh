#!/usr/bin/env bash
# install-tycon-hooks.sh — instala/sincroniza el set canónico de hooks TYCON
# en `~/.claude/settings.json` del dev.
#
# Diseño:
#   - Idempotente: corre N veces sin duplicar entries.
#   - Silencioso si todo OK; 1 línea por hook agregado si hubo cambio.
#   - Backup automático `settings.json.bak.<timestamp>` ANTES del primer cambio — salvo lanzado por `harness.js`
#     (`TYCON_HARNESS_SNAPSHOT_DIR` puesta): ahí la copia ya la tomó el mecanismo y no queda `.bak`.
#   - Tres piezas son COMPARTIDAS con `harness.js`: `cleanupPeriodDays`, la variable de `env` y los
#     comandos de barra. Suelto las hace este script. Lanzado por un `harness.js` que YA las hizo
#     (`TYCON_HARNESS_SHARED_DONE=1`) las saltea y no las reporta; con sólo `TYCON_HARNESS_LOCK_HELD=1` (un programa
#     viejo, que no conoce esa variable) las sigue haciendo.
#   - Opt-out via env var: `TYCON_NO_AUTOINSTALL=1` → exit 0 silencioso.
#   - Atomic write (tmp + mv).
#   - Cross-platform: bash + python3 + node (sin dependencia de jq).
#
# Hooks que instala: los de scripts/setup/hooks-list.json, que es LA lista, y los registra
# scripts/setup/apply-hooks.js — el mismo aplicador que llama el instalador de Windows. Acá no hay lista propia.
#
# El SessionStart `git pull` de los repos team-wide y el bloque codegraph
# NO se tocan acá — son out-of-scope para evitar pisar config personalizada
# del dev. (engram-pre-commit SÍ se gestiona acá: la regla de commitear .engram/ es team-wide en
# engram-workflow.md, así que el hook que la automatiza va default-ON — apagable con
# TYCON_ENGRAM_HOOK=0.)
#
# Al final delega en `sync-claude-md-blocks.sh`, que sincroniza los
# bloques team-wide de `~/.claude/CLAUDE.md` desde `claude-md-blocks/*.md`. Eso NO
# contradice el párrafo de arriba: el sync es quirúrgico sobre sus propios marcadores
# `TYCON_BLOCK:<nombre>` y no mira el resto del archivo. Opt-out independiente:
# TYCON_NO_CLAUDEMD_SYNC=1.
#
# Uso:
#   ./install-tycon-hooks.sh         # corre el install
#   TYCON_NO_AUTOINSTALL=1 ./install-tycon-hooks.sh  # skip silencioso
#   ./install-tycon-hooks.sh --check # solo reporta qué falta, no modifica
#   ./install-tycon-hooks.sh --report-json <archivo>  # además, la lista de piezas que deja
#   ./install-tycon-hooks.sh --check --plan-json <archivo>  # el plan para un programa: cada pieza con su acción
#                                                           # (add/update/remove/keep), sin escribir nada más
#
# Registra el bloque PreToolUse `Write|Edit` que apunta a `on-write-collision.js`: el arreglo robusto entre sesiones
# lo necesita en cada dev del equipo, y este script lo automatiza.

set -euo pipefail

# ============================================================
# Opt-out
# ============================================================
if [[ "${TYCON_NO_AUTOINSTALL:-0}" == "1" ]]; then
  exit 0
fi

# ============================================================
# Args
# ============================================================
CHECK_ONLY=0
REPORT_JSON=""     # --report-json <archivo>: la lista de piezas del arnés que quedan en la máquina
# --link <ruta>: la ÚNICA forma de re-apuntar el lugar del arnés (~/.claude/tycon-harness) a otro clon
ENLACE_FORZAR=""
PLAN_JSON=""       # --plan-json <archivo>: con --check, el plan como datos para harness.js install
# Los nombres viejos de las opciones siguen andando. Sin argumentos —como corre en cada arranque de
# sesión— ni se carga la biblioteca: no suma nada al arranque.
if [[ $# -gt 0 && -f "$(dirname "${BASH_SOURCE[0]}")/lib/legacy-names.sh" ]]; then
  . "$(dirname "${BASH_SOURCE[0]}")/lib/legacy-names.sh"
  legacy_args "$@" || exit 2
  set -- ${LEGACY_ARGS[@]+"${LEGACY_ARGS[@]}"}
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --report-json)
      REPORT_JSON="${2:-}"
      [[ -n "$REPORT_JSON" ]] || { echo "install-tycon-hooks.sh: --report-json necesita la ruta del archivo" >&2; exit 2; }
      shift
      ;;
    --link)
      ENLACE_FORZAR="${2:-}"
      [[ -n "$ENLACE_FORZAR" ]] || { echo "install-tycon-hooks.sh: --link necesita la ruta de un clon del arnés" >&2; exit 2; }
      shift
      ;;
    --plan-json)
      PLAN_JSON="${2:-}"
      [[ -n "$PLAN_JSON" ]] || { echo "install-tycon-hooks.sh: --plan-json necesita la ruta del archivo" >&2; exit 2; }
      shift
      ;;
    -h|--help)
      sed -n '1,40p' "$0" | grep '^#' | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "install-tycon-hooks.sh: arg desconocido: $1" >&2; exit 2 ;;
  esac
  shift
done
# el plan es una mirada: sin --check escribiría la máquina mientras dice que sólo la describe
if [[ -n "$PLAN_JSON" && "$CHECK_ONLY" != "1" ]]; then
  echo "install-tycon-hooks.sh: --plan-json va con --check (el plan se arma sin escribir nada)" >&2
  exit 2
fi

# ============================================================
# Requisitos: python3 y node
# ============================================================
# Sin `python3` este archivo muere más abajo con el error crudo de bash (el python que aplica los hooks), con
# settings.json ya escrito; sin `node`, los bloques guardados por `command -v node` se saltean callados y queda una
# instalación a medias que nadie anuncia. Acá, ANTES del candado y de escribir nada: UNA línea que nombra lo que falta
# y remite a los requisitos de la portada, y salida 1. El de `node` mira presencia, no versión (el piso lo comprueba
# harness.js).
for _req in python3 node; do
  if ! command -v "$_req" >/dev/null 2>&1; then
    echo "✗ tycon: falta $_req en el PATH — el instalador lo necesita y no escribió nada (ver los requisitos de la portada)" >&2
    exit 1
  fi
done
# Un `python3` que está y no arranca (el alias de la tienda de Windows visto desde Git Bash, un stub) cuenta como
# faltante, igual que en harness.js: pasaría el chequeo de arriba y el instalador moriría más abajo con el error crudo,
# con el esqueleto y los enlaces ya escritos.
if ! python3 -c 'pass' >/dev/null 2>&1; then
  echo "✗ tycon: python3 está en el PATH ($(command -v python3)) pero no arranca — el instalador lo necesita y no escribió nada (ver los requisitos de la portada)" >&2
  exit 1
fi

# ============================================================
# Lock anti-concurrencia
# ============================================================
# Con el mantenimiento corriendo desde el arranque de LAS DOS herramientas, abrir Claude Code y Codex juntos lanza
# dos instaladores a la vez: uno sincroniza el espejo AGENTS.md mientras el otro ya está midiendo la paridad → rojo
# transitorio "agents-md" en cada reinicio. Un solo instalador por máquina a la vez; el segundo se va en silencio (el
# que corre hace el mismo trabajo). --check no toma el lock: no escribe. Lock por mkdir (atómico) + mtime: uno viejo
# (>10 min: crash/kill) se pisa.
# Lanzado por `scripts/setup/harness.js` el candado ya lo tiene el padre (TYCON_HARNESS_LOCK_HELD=1) y acá no se toma
# otro; corrido suelto lo toma.
if [[ "$CHECK_ONLY" != "1" && "${TYCON_HARNESS_LOCK_HELD:-0}" != "1" ]]; then
  INSTALL_LOCK="$HOME/.claude/.tycon-pipeline/install-tycon-hooks.lock"
  mkdir -p "$(dirname "$INSTALL_LOCK")" 2>/dev/null || true
  _lock_stale() { [[ -n "$(find "$INSTALL_LOCK" -maxdepth 0 -mmin +10 2>/dev/null)" ]]; }
  if ! mkdir "$INSTALL_LOCK" 2>/dev/null; then
    # Otro instalador lo tiene. Si es FRESCO, está corriendo ahora mismo: me voy, el trabajo lo
    # hace ése. Si es VIEJO (>10 min: crash/SIGKILL sin trap), hay que tomarlo — y tomarlo es
    # la parte delicada: `rmdir+mkdir` a secas deja pasar a dos, y un `mv` atómico abre una ventana sin lock por la
    # que un TERCERO entra por la puerta normal. Lo que no solapa: un
    # MUTEX de takeover (mkdir, sección crítica de microsegundos, vida 1 min) y re-verificar la
    # vejez ADENTRO del mutex — el que llegó tarde ve el lock ya renovado y se va.
    _lock_stale || exit 0
    TAKEOVER="$INSTALL_LOCK.takeover"
    if ! mkdir "$TAKEOVER" 2>/dev/null; then
      { [[ -n "$(find "$TAKEOVER" -maxdepth 0 -mmin +1 2>/dev/null)" ]] && rmdir "$TAKEOVER" 2>/dev/null && mkdir "$TAKEOVER" 2>/dev/null; } || exit 0
    fi
    _tomado=0
    if _lock_stale; then rm -rf "$INSTALL_LOCK" 2>/dev/null; mkdir "$INSTALL_LOCK" 2>/dev/null && _tomado=1; fi
    rmdir "$TAKEOVER" 2>/dev/null || true
    [[ "$_tomado" == 1 ]] || exit 0
  fi
  echo "$$" > "$INSTALL_LOCK/pid" 2>/dev/null || true   # diagnóstico: quién lo tiene
fi
# UN solo handler de salida para todo el script: bash NO encadena traps — un segundo
# `trap ... EXIT` más abajo PISA al anterior (así el lock quedaría tomado tras un exit 0 limpio). Todo lo que haya
# que limpiar al salir se agrega ACÁ, no con otro trap.
# Un instalador matado a mitad (timeout, Ctrl-C) suelta el lock igual vía EXIT; si aun así
# queda huérfano (SIGKILL), la regla de los 10 min lo pisa.
_tycon_cleanup() {
  [[ -n "${TMP_REPORT:-}" ]] && rm -f "$TMP_REPORT" 2>/dev/null
  [[ -n "${REPORT_PIECES_TMP:-}" ]] && rm -f "$REPORT_PIECES_TMP" 2>/dev/null
  [[ -n "${PLAN_PIECES_TMP:-}" ]] && rm -f "$PLAN_PIECES_TMP" 2>/dev/null
  [[ -n "${INSTALL_LOCK:-}" ]] && rm -rf "$INSTALL_LOCK" 2>/dev/null
  return 0
}
# SOLO EXIT: bash corre el trap EXIT también al morir por señal; atrapar INT/TERM además haría
# que el instalador soltara el lock Y SIGUIERA corriendo tras un kill.
trap _tycon_cleanup EXIT

# ============================================================
# El registro de lo instalado
# ============================================================
# Con --report-json <archivo>, cada pieza del arnés que queda en la máquina al terminar —la que escribió esta corrida Y la
# que ya estaba— se anota como `kind<TAB>where<TAB>id` (un `setting` suma un 4º campo: su valor en JSON, que va a
# `value`) en un temporal; al final un python arma el arreglo JSON
# `[{kind, where, id}]` sin duplicados y lo escribe atómico. Lo leen harness.js (el estado `managed`) y doctor. El python
# de settings.json y sync-claude-md-blocks.sh anotan en el mismo temporal por TYCON_REPORT_PIECES. Lo que se decidió no
# escribir (integración u opt-in apagados) no se anota; lo que se hace y no se posee (sqlite3, engram, sellos, logs, los
# AGENTS.md puntero…) tampoco: la lista declarada y sus exclusiones con motivo viven en
# scripts/tests/fixtures/harness-managed-pieces.json (T18). Con --check no se escribe nada. Sin la opción, ni el temporal
# existe: la salida es la de siempre. Una salida temprana (candado de otro instalador, TYCON_NO_AUTOINSTALL, agent-skills
# ausente) no escribe reporte: quien llama no tiene nada que fundir.
REPORT_PIECES_TMP=""
if [[ -n "$REPORT_JSON" && "$CHECK_ONLY" != "1" ]]; then
  REPORT_PIECES_TMP="$(mktemp)" || REPORT_PIECES_TMP=""
fi
if [[ -n "$REPORT_PIECES_TMP" ]]; then export TYCON_REPORT_PIECES="$REPORT_PIECES_TMP"; else unset TYCON_REPORT_PIECES; fi
record() { # record <kind> <where> <id>
  [[ -n "$REPORT_PIECES_TMP" ]] || return 0
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$REPORT_PIECES_TMP" 2>/dev/null || true
}

# ============================================================
# El plan para un programa
# ============================================================
# Con --check --plan-json <archivo>, cada pieza que esta corrida escribiría, sacaría o dejaría como está se anota como
# `kind<TAB>where<TAB>id<TAB>action` (action: add · update · remove · keep) en un temporal gemelo del de --report-json, con
# los mismos `kind` e `id`; al final un python arma `[{kind, where, id, action}]` sin repetidos y lo escribe atómico. Lo
# lee `harness.js install` para mostrar el plan ANTES de escribir. El python de settings.json, sync-claude-md-blocks.sh y
# canonical-path.js anotan en el mismo temporal por TYCON_PLAN_PIECES. Lo que se decidió no escribir (integración u
# opt-in apagados) no se anota. Vale el contrato de --check: la HOME no se toca. Sin la opción, ni el
# temporal existe y la salida de --check es la de siempre.
PLAN_PIECES_TMP=""
if [[ -n "$PLAN_JSON" ]]; then
  PLAN_PIECES_TMP="$(mktemp)" || { echo "install-tycon-hooks.sh: sin un temporal para el plan" >&2; exit 1; }
fi
if [[ -n "$PLAN_PIECES_TMP" ]]; then export TYCON_PLAN_PIECES="$PLAN_PIECES_TMP"; else unset TYCON_PLAN_PIECES; fi
plan_record() { # plan_record <kind> <where> <id> <action>
  [[ -n "$PLAN_PIECES_TMP" ]] || return 0
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$PLAN_PIECES_TMP" 2>/dev/null || PLAN_INCOMPLETE=1
}
# Una pieza que no se pudo anotar deja el plan incompleto: al final, sin plan (sale 1) — mostrar un plan al que le falta
# algo sería pedir conformidad sobre una lista mentirosa. Lo mismo si el python de
# settings.json, el sync de bloques o canonical-path.js dicen que no pudieron anotar (su línea «… en el plan»).
PLAN_INCOMPLETE=0
plan_copy() { # plan_copy <kind> <origen> <destino> <id>: igual → keep · distinto → update · falta → add
  [[ -n "$PLAN_PIECES_TMP" ]] || return 0
  if cmp -s "$2" "$3" 2>/dev/null; then plan_record "$1" "$3" "$4" keep
  elif [[ -e "$3" ]]; then plan_record "$1" "$3" "$4" update
  else plan_record "$1" "$3" "$4" add; fi
}

# ============================================================
# Paths
# ============================================================
# SETTINGS override-able via TYCON_SETTINGS_PATH (para testear sobre una copia sin
# tocar el settings.json real). Default = el real del dev.
SETTINGS="${TYCON_SETTINGS_PATH:-$HOME/.claude/settings.json}"

# Hooks que viven en este repo (~/.claude/tycon-harness/scripts/hooks/), no en
# agent-skills. Se distribuyen via git pull del repo + install-tycon-hooks.sh.
# Resolvemos al directorio padre del script actual (cross-symlink-safe).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TCG_HOOKS_DIR="$SCRIPT_DIR/hooks"

# ── Con qué Node corren las llamadas de este instalador ──────────────────────────────────────────────────────────────
# El arnés baja su propio Node a <casa>/node/current (harness-node.js). Si está y es ejecutable, las llamadas a `node` de
# ESTE guion van con él; si no, con el del PATH, como siempre. `node` es una función de este guion, no exportada: no
# cambia el PATH ni llega a lo que el guion lance (install-codegraph.sh sigue con el `npm` del dev). `nohup` y un
# `bash -c` nuevo no ven funciones: lo que se lanza así nombra "$HNODE" (o lo recibe como argumento).
# con el bash de la Mac (3.2) y `set -e`, un `.` que no encuentra el archivo corta el guion aunque lleve `||`: se mira antes
_hn="$SCRIPT_DIR/lib/harness-node.sh"
{ [ -f "$_hn" ] && . "$_hn" 2>/dev/null; } || harness_node_bin() { echo node; }
HNODE="$(harness_node_bin)"
if [[ "$HNODE" != "node" ]]; then node() { "$HNODE" "$@"; }; fi

# ── Dónde están las skills: lo contesta la regla, no una ruta escrita ───────────────────────────────────────────────
# Una ruta escrita (`AGENT_SKILLS="$HOME/.claude/agent-skills/skills"`) de la que salga todo —los hooks que registra y
# las seis suites rápidas que corre en cada arranque— haría que, con un clon de trabajo que trae sus propias skills, el
# instalador corrido desde él probara las INSTALADAS: daría verde sin haber probado el cambio. La regla vive
# en scripts/lib/skills-dir.js (contrato C3) y acá se le pregunta de las dos formas que tiene:
#   _skills_dir read  <campo>   para CORRER (las suites rápidas): la variable TYCON_SKILLS_DIR › el propio clon si es
#                               unido › lo instalado.
#   _skills_dir write <campo>   para ESCRIBIR en la máquina (los hooks de settings.json, el paso de terceros, el informe de
#                               piezas): lo instalado mientras exista; si no, el propio clon. Es la variante `--installed`,
#                               y SIN la variable: este archivo no la lee, porque una variable que apunta a un clon
#                               de trabajo no puede re-apuntar los hooks de la máquina a una carpeta que mañana se borra
#                               (lo mismo que el enlace del arnés, que sólo se mueve con --link). Si escribiera con la
#                               primera forma, apenas el clon del arnés trae skills/ cambiarían los hooks registrados en
#                               una máquina con dos clones (lo cuida harness-install.test.sh, T30 y CANARY).
# <campo>: --skills (la carpeta de skills) · --repo (su raíz) · --source (variable | own-clone | installed).
# Sale como la biblioteca: 0 con una línea · 1 si esa carpeta no existe (nada por stdout, el motivo por stderr) · 2 por uso.
# Sin la biblioteca al lado (una copia parcial de este archivo) no hay a quién preguntarle: vale la ruta instalada.
SKILLS_DIR_JS="$SCRIPT_DIR/lib/skills-dir.js"
_skills_dir() { # _skills_dir read|write <campo>
  case "$1" in
    write) TYCON_SKILLS_DIR= node "$SKILLS_DIR_JS" "$2" --installed ;;
    *)     node "$SKILLS_DIR_JS" "$2" ;;
  esac
}

# Los nombres viejos de las variables: cada interruptor renombrado que se lee acá pasa antes por
# `legacy_env`, así el nombre en castellano sigue apagando hasta su retiro. Sin la biblioteca, sólo el nombre nuevo.
if [[ -f "$SCRIPT_DIR/lib/legacy-names.sh" ]]; then . "$SCRIPT_DIR/lib/legacy-names.sh"; else legacy_env() { :; }; fi

# ── El lugar del arnés: ~/.claude/tycon-harness, y el nombre viejo ─────────────────────────────────────────
# Los prompts de revisores, pasos y skills nombran al arnés por este lugar (un prompt no lee una
# variable) y el clon puede vivir en cualquier carpeta. La regla de nacimiento vive en canonical-path.js: el lugar nace
# apuntando a donde apunta el nombre viejo (o a lo que dice el estado) y no al clon que corre este instalador; el viejo
# se re-apunta al lugar y no se borra; si el lugar apunta a OTRO clon válido, avisa y NO lo mueve —el equipo trabaja
# desde clones descartables—: sólo `--link <ruta>` lo re-apunta. Una carpeta real en ese lugar no se pisa. Respeta
# --check. Detalle y casos: scripts/lib/canonical-path.js.
if [[ -f "$SCRIPT_DIR/lib/canonical-path.js" ]] && command -v node >/dev/null 2>&1; then
  _ENLACE_ARGS=(--ensure-link --clone "$SCRIPT_DIR/..")
  [[ "$CHECK_ONLY" == "1" ]] && _ENLACE_ARGS+=(--check)
  [[ -n "$ENLACE_FORZAR" ]] && _ENLACE_ARGS+=(--link "$ENLACE_FORZAR")
  _RC_ENLACE=0
  node "$SCRIPT_DIR/lib/canonical-path.js" "${_ENLACE_ARGS[@]}" || _RC_ENLACE=$?
  # sólo un --link que no se puede cumplir sale 2 (no es un clon, o el lugar es una carpeta real); un enlace que no se
  # pudo escribir AVISA y el instalador sigue: un aviso que rompe el arranque se apaga
  [[ "$_RC_ENLACE" == "2" ]] && exit 2
elif [[ -n "$ENLACE_FORZAR" ]]; then
  echo "install-tycon-hooks.sh: --link necesita node y scripts/lib/canonical-path.js" >&2
  exit 2
fi
# los dos nombres del lugar son del arnés aunque esta corrida no los haya tocado (los creó una anterior): una pieza `link`
# por cada nombre que ES un enlace, y lo pregunta Node (en el bash de Git para Windows no se
# pregunta desde el shell si algo es un enlace)
if [[ -n "$REPORT_PIECES_TMP" && -f "$SCRIPT_DIR/lib/canonical-path.js" ]] && command -v node >/dev/null 2>&1; then
  # sin --home, como --ensure-link: las dos miran la misma carpeta (os.homedir()), también con HOME ≠ USERPROFILE en
  # Windows
  node "$SCRIPT_DIR/lib/canonical-path.js" --place-pieces >> "$REPORT_PIECES_TMP" 2>/dev/null || true
fi

# ── Los enlaces del repo único ──────────────────────────────────────────────────────────────
# Cuando ESTE clon trae skills/ y agents/ en su raíz (el repo público: el arnés y agent-skills juntos), todo lo que
# busca a agent-skills tiene que encontrarlo acá sin ninguna variable puesta: ~/.claude/agent-skills → el clon,
# ~/.claude/agents → <clon>/agents y ~/.claude/skills → <clon>/skills, con las mismas reglas del enlace de arriba (se
# crean si faltan, se reparan colgados, no se mueve uno que apunta a otro lado que sirve, nunca se pisa una carpeta real:
# ahí va un enlace por entrada). Dos llamadas: ACÁ sólo agent-skills (la verificación de abajo y el paso de terceros lo
# necesitan); agents y skills DESPUÉS del paso de terceros, para que las skills bajadas tengan su entrada en la primera
# corrida. En el clon del equipo (sin skills/ en la raíz) no imprime ni toca nada. Respeta --check; las piezas `link` las
# anota el propio guion en TYCON_REPORT_PIECES. Detalle y casos: scripts/lib/canonical-path.js.
# El clon del equipo TAMBIÉN trae skills/ y agents/, y la máquina puede tener además su clon viejo de agent-skills en
# ~/.claude/agent-skills (dos clones). Ahí tampoco imprime ni toca nada: lo decide canonical-path.js
# (`separateSkillsClone`), igual para este archivo y para el .ps1. Una carpeta real en ese lugar que NO es un clon de
# agent-skills sigue avisando.
_repo_links() { # _repo_links agent-skills|entries
  # sólo si el clon trae skills/ y agents/: en un clon sin ellas ni se lanza node (este archivo corre en cada arranque)
  [[ -d "$SCRIPT_DIR/../skills/tycon-pipeline" && -d "$SCRIPT_DIR/../agents" ]] || return 0
  [[ -f "$SCRIPT_DIR/lib/canonical-path.js" ]] || return 0
  local _args=(--ensure-repo-links --clone "$SCRIPT_DIR/.." --only "$1")
  [[ "$CHECK_ONLY" == "1" ]] && _args+=(--check)
  node "$SCRIPT_DIR/lib/canonical-path.js" "${_args[@]}" || true   # un enlace que no se pudo escribir avisa, no frena
}
_repo_links agent-skills

# ── ¿El arnés está donde el arnés cree que está? (mira el enlace) ────
# Si el clon que corre este instalador no es el que apunta el enlace —o el enlace falta, está colgado
# o es una carpeta—, los revisores y el pipeline leerían otro clon, o nada, sin error. Aviso, nunca
# freno: sale 0 siempre. Detalle y casos: scripts/lib/canonical-path.js.
legacy_env TYCON_NO_CANONICAL_PATH
if [[ "${TYCON_NO_CANONICAL_PATH:-0}" != "1" && -f "$SCRIPT_DIR/lib/canonical-path.js" ]]; then
  node "$SCRIPT_DIR/lib/canonical-path.js" 2>/dev/null || true
fi

# Si no existe settings.json → crear skeleton mínimo. Con --check no se escribe: el python de más
# abajo lee un settings.json que falta como vacío y reporta lo que faltaría.
if [[ ! -f "$SETTINGS" && "$CHECK_ONLY" != "1" ]]; then
  mkdir -p "$HOME/.claude"
  cat > "$SETTINGS" <<'JSON'
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "hooks": {}
}
JSON
fi

# Verificar que agent-skills está: dónde ESCRIBE esta corrida (ver `_skills_dir`, arriba). Va acá y no antes: en el repo
# único, `_repo_links agent-skills` acaba de dejar el enlace ~/.claude/agent-skills, que es «lo instalado».
#   · lo instalado existe            → ésa es la ruta de siempre, la que queda en settings.json (dos clones, o el enlace).
#   · no existe y el clon es unido   → sólo con --check: --check no crea los enlaces, así que
#                                      esta corrida mira las skills en el propio clon —donde el enlace las va a dejar—.
#                                      Sin --check es que el enlace no se pudo crear (ya se avisó arriba): sale 1, como
#                                      siempre; no se registran hooks hacia la carpeta del clon por un enlace que falta.
#   · no existe en ningún lado       → sale 1 con una línea que trae el motivo que da la biblioteca.
AGENT_SKILLS=""; _SKILLS_FROM=""; _SKILLS_WHY=""
if [[ -f "$SKILLS_DIR_JS" ]]; then
  AGENT_SKILLS="$(_skills_dir write --skills 2>/dev/null)" || AGENT_SKILLS=""
  if [[ -n "$AGENT_SKILLS" ]]; then
    _SKILLS_FROM="$(_skills_dir write --source 2>/dev/null)" || _SKILLS_FROM=""
  else
    # el motivo, de la biblioteca (su única línea por stderr): «la carpeta de skills no existe: <ruta> (salió de: …)»
    _SKILLS_WHY="$(_skills_dir write --skills 2>&1 >/dev/null | head -1 | sed 's/^skills-dir: //')" || true
  fi
else
  # Sin la biblioteca (una copia parcial de este archivo, como las que arman algunas pruebas): lo de siempre, la ruta
  # instalada. Es el único lugar donde queda escrita, y sólo vale cuando no hay a quién preguntarle.
  AGENT_SKILLS="$HOME/.claude/agent-skills/skills"; _SKILLS_FROM="installed"
fi
if [[ -n "$AGENT_SKILLS" && ! -d "$AGENT_SKILLS/tycon-pipeline" ]]; then
  _SKILLS_WHY="$AGENT_SKILLS no trae tycon-pipeline"
elif [[ -n "$AGENT_SKILLS" && "$_SKILLS_FROM" != "installed" && "$CHECK_ONLY" != "1" ]]; then
  _SKILLS_WHY="~/.claude/agent-skills no está (el enlace al clon no se pudo crear) y sin él no registro hooks hacia $AGENT_SKILLS"
fi
if [[ -n "$_SKILLS_WHY" ]]; then
  echo "✗ tycon: agent-skills no encontrado — ${_SKILLS_WHY} — ver el README.md del arnés, 'Instalación'" >&2
  exit 1
fi
AGENT_SKILLS_REPO="$(dirname "$AGENT_SKILLS")"   # la raíz que trae skills/ y agents/ (el contrato: skills = <raíz>/skills)
if [[ "$_SKILLS_FROM" != "installed" ]]; then
  _CHECK_IN_CLONE="$AGENT_SKILLS_REPO"   # el paso de terceros de más abajo también mira ahí
  echo "(--check) tycon: ~/.claude/agent-skills todavía no está: esta revisión mira las skills en $AGENT_SKILLS (el instalador crea el enlace)"
fi

# ── Las skills de terceros vuelven a su lugar ──────────────────────────────────────────────────────────────────────
# Lo ajeno no viaja en agent-skills: el manifiesto (publishing/third-party-skills.json) fija cada skill por commit y
# hash de árbol, y este paso la restituye —primero desde la historia de git del clon, sin red; desde su origen sólo
# con el retiro hecho y con tope de 20 s—, sin borrar ni pisar nada. Va acá, apenas se sabe que agent-skills está:
# la línea de arranque ya hizo el pull. Al día no dice nada; todo aviso sale por stdout (el arranque descarta stderr).
# Apagado: TYCON_THIRD_PARTY=0, y lo dice. El gemelo de Windows lo llama con los mismos argumentos.
if command -v node >/dev/null 2>&1 && [[ -f "$SCRIPT_DIR/publishing/install-third-party.js" ]]; then
  _TP_ARGS=()
  [[ "$CHECK_ONLY" == "1" ]] && _TP_ARGS+=(--check)
  if [[ -n "${_CHECK_IN_CLONE:-}" ]]; then
    # --check en el repo único sin el enlace todavía: la revisión de terceros mira el clon, como el resto
    # de esta corrida. Con la ruta del enlace (que no existe) diría «no es un clon de agent-skills» y no revisaría nada.
    node "$SCRIPT_DIR/publishing/install-third-party.js" --repo "$_CHECK_IN_CLONE" --check || true
  else
    node "$SCRIPT_DIR/publishing/install-third-party.js" --repo "$AGENT_SKILLS_REPO" ${_TP_ARGS[@]+"${_TP_ARGS[@]}"} || true
  fi
fi
# ~/.claude/agents y ~/.claude/skills del repo único: después del paso de terceros, ver arriba
_repo_links entries
# Las skills de terceros que quedaron en su lugar, según el estado del paso (entradas completas cuyo destino existe).
# Apagado el paso (TYCON_THIRD_PARTY=0), no se anotan: decidió no tocarlas.
if [[ -n "$REPORT_PIECES_TMP" && "${TYCON_THIRD_PARTY:-1}" != "0" ]]; then
  python3 - "$HOME/.claude/.tycon-pipeline/third-party-state.json" "$AGENT_SKILLS_REPO" >> "$REPORT_PIECES_TMP" 2>/dev/null <<'PY' || true
import json, os, sys
try:
    entries = json.load(open(sys.argv[1], encoding="utf-8")).get("entries") or {}
except Exception:
    sys.exit(0)
for target, e in sorted(entries.items()):
    dst = os.path.join(sys.argv[2], target)
    if isinstance(e, dict) and e.get("complete") and os.path.exists(dst):
        print("third-party\t%s\t%s" % (dst, os.path.basename(target.rstrip("/"))))
PY
fi
# El plan: cada skill de terceros que el paso restituiría (las de `install: download` del
# manifiesto): completa y en su lugar → keep; si no → add (sin red puede quedar pendiente: lo dice el cierre de install).
if [[ -n "$PLAN_PIECES_TMP" && "${TYCON_THIRD_PARTY:-1}" != "0" && -f "$SCRIPT_DIR/publishing/third-party-skills.json" ]]; then
  # dónde mira si ya está (el clon, en el repo único sin el enlace todavía) y con qué ruta la anota: la del reporte y el
  # estado, ~/.claude/agent-skills/…, aunque el enlace todavía no exista
  _TP_WHERE="$AGENT_SKILLS_REPO"; [[ -n "${_CHECK_IN_CLONE:-}" ]] && _TP_WHERE="$HOME/.claude/agent-skills"
  python3 - "$SCRIPT_DIR/publishing/third-party-skills.json" "$HOME/.claude/.tycon-pipeline/third-party-state.json" "${_CHECK_IN_CLONE:-$AGENT_SKILLS_REPO}" "$_TP_WHERE" >> "$PLAN_PIECES_TMP" 2>/dev/null <<'PY' || PLAN_INCOMPLETE=1
import json, os, sys
manifest, state_file, repo, where_root = sys.argv[1:5]
try:
    wanted = [e for e in json.load(open(manifest, encoding="utf-8")).get("third_party", []) if isinstance(e, dict) and e.get("install") == "download"]
except Exception:
    sys.exit(0)
try:
    entries = json.load(open(state_file, encoding="utf-8")).get("entries") or {}
except Exception:
    entries = {}
for e in wanted:
    target = str(e.get("target") or "").rstrip("/")
    if not target:
        continue
    dst = os.path.join(repo, target)
    st = entries.get(target) or entries.get(target + "/")
    done = isinstance(st, dict) and st.get("complete") and os.path.exists(dst)
    print("third-party\t%s\t%s\t%s" % (os.path.join(where_root, target), os.path.basename(target), "keep" if done else "add"))
PY
fi

# ============================================================
# Integraciones — cada una tiene su llave en la configuración del arnés
# (scripts/lib/tycon-config.js: variable › ~/.claude/tycon.json › perfil del equipo › APAGADA) y, apagada, este
# instalador no registra sus hooks ni llama a su servicio. Un hook compartido con el núcleo no se desregistra:
# saltea su parte adentro (el despachador de ediciones con el control de la integración de horas; bench-notice con lo
# nocturno).
#   ado        → el refresco de la lista de proyectos con `az` (al final del archivo)
#   la herramienta de horas (integrations.timeTracking) → los hooks que declara su manifiesto en integrations/<nombre>/
#   engram     → @tcg:engram-pre-commit.sh, @tcg:engram-drift-notice.js y los chequeos de versión / nombre de proyecto / sqlite3
#   nightly    → @tcg:dashboard-notice.js, dependencies-notice.js y retro-staleness-notice.js
#   mailbox    → la subida y la bajada de corridas (tanda de fondo)
#   codex      → el despliegue del lado Codex (1 · 0 · detect)
#   telegram, codegraph → nada acá: se configuran por dev (el chat por el plugin; CodeGraph con install-codegraph.sh)
# 🔴 Configuración ROTA (ilegible, clave desconocida, tipo equivocado): se dice con archivo · clave · motivo y las
#    integraciones quedan COMO ESTÁN — no se registran ni se remueven sus hooks y no se llama a nada. Un archivo roto
#    no se lee como «todo apagado». Sin el lector (una copia parcial de este archivo): lo mismo, y se dice.
# El perfil del equipo (team-profile.json, o perfil-equipo.json) prende las integraciones; afuera todo nace apagado hasta que
# se configura. `|| _RC=$?` y nunca `; _RC=$?`: este archivo corre con set -e.
# ============================================================
INTEG_ESTADO="sin-lector"   # ok · rota · sin-lector
TYCON_INTEG_ADO=0; TYCON_INTEG_ENGRAM=0; TYCON_INTEG_CODEGRAPH=0; TYCON_TIME_TOOL=""
TYCON_INTEG_MAILBOX=0; TYCON_INTEG_CODEX=0; TYCON_INTEG_NIGHTLY=0; TYCON_INTEG_TELEGRAM=0
if [[ -f "$SCRIPT_DIR/lib/tycon-config.js" ]] && command -v node >/dev/null 2>&1; then
  _INTEG_ERR="$(mktemp)"; _RC_INTEG=0
  _INTEG_OUT="$(node "$SCRIPT_DIR/lib/tycon-config.js" integrations --shell 2>"$_INTEG_ERR")" || _RC_INTEG=$?
  if [[ "$_RC_INTEG" == "0" ]]; then
    INTEG_ESTADO=ok
    while IFS='=' read -r _k _v; do
      # el nombre, entero y sin nada más (un subíndice o un `$(…)` en el nombre se evaluaría al asignar)
      if [[ "$_k" =~ ^TYCON_INTEG_[A-Z]+$ ]]; then
        case "$_v" in 0|1|detect) printf -v "$_k" '%s' "$_v" ;; esac
      elif [[ "$_k" == TYCON_TIME_TOOL && "$_v" =~ ^[a-z0-9-]+$ ]]; then
        TYCON_TIME_TOOL="$_v"
      fi
    done <<< "$_INTEG_OUT"
  elif [[ "$_RC_INTEG" == "2" ]]; then
    INTEG_ESTADO=rota
    echo "⚠ tycon: la configuración del arnés está ROTA — las integraciones quedan como estaban (ni se registran ni se remueven sus hooks; no se llama a ningún servicio) hasta arreglarla:"
    sed 's/^/   /' "$_INTEG_ERR"
  else
    echo "⚠ tycon: no pude leer la configuración del arnés (rc $_RC_INTEG: $(tr '\n' ' ' < "$_INTEG_ERR" | cut -c1-200)) — las integraciones quedan como estaban"
  fi
  rm -f "$_INTEG_ERR"
else
  echo "⚠ tycon: sin scripts/lib/tycon-config.js (o sin node): no sé qué integraciones están prendidas — quedan como estaban"
fi
# Los interruptores por hook que ya existían mandan por encima de la llave, en los dos sentidos.
ENGRAM_HOOK_ON="$TYCON_INTEG_ENGRAM"
if [[ -n "${TYCON_ENGRAM_HOOK-}" ]]; then if [[ "$TYCON_ENGRAM_HOOK" == "0" ]]; then ENGRAM_HOOK_ON=0; else ENGRAM_HOOK_ON=1; fi; fi
# ============================================================
# El perfil de instalación: `minimal` o `full`, de la configuración del arnés
# (`install.profile`: TYCON_INSTALL_PROFILE › ~/.claude/tycon.json › perfil del equipo). Se lee UNA vez.
#   · full, o SIN VALOR → todo, byte a byte (el perfil del equipo fija full; sin elegir se comporta como full).
#   · minimal → sólo los hooks que scripts/setup/install-effects.json marca `minimal` (ocho, con el freno de
#     comandos destructivos, que está en los dos perfiles y sólo lo apaga TYCON_SAFETY_GUARD=0, y el portón de edición,
#     también en los dos, que apaga TYCON_STORY_GATE=off) más los de una
#     integración prendida; los demás se SACAN si estaban (con el motivo en la línea del reporte); los dos opt-in de
#     full que nacen prendidos (test-scope-guard, telegram-zombie-sweep) sólo con su variable en `1`; sin los dos
#     ajustes de settings.json, sin los hooks de git (ni el core.hooksPath de ningún repo) y sin las tareas de fondo
#     de full. Los enlaces, los comandos, las skills de terceros, la suite rápida y los nombres viejos, igual.
#   · ROTA (valor fuera de la lista, archivo ilegible) o sin lector → lo que depende del perfil QUEDA COMO ESTÁ: ni se
#     registra ni se saca, y se dice (la regla de las integraciones). Rota nunca se lee como full. La
#     excepción son los dos frenos de comandos (safety-guard y test-scope-guard): se registran igual,
#     para que una máquina nueva con la configuración rota no quede sin frenos.
# Una variable puesta a mano manda sobre el perfil, en los dos sentidos (TYCON_SAFETY_GUARD=1 en minimal registra el freno).
# ============================================================
PROFILE_STATE="sin-lector"   # ok · rota · sin-lector
TYCON_PROFILE_VALUE=""        # minimal · full · vacío (sin elegir: se comporta como full)
if [[ -f "$SCRIPT_DIR/lib/tycon-config.js" ]] && command -v node >/dev/null 2>&1; then
  _PROF_ERR="$(mktemp)"; _RC_PROF=0
  _PROF_OUT="$(node "$SCRIPT_DIR/lib/tycon-config.js" get install.profile 2>"$_PROF_ERR")" || _RC_PROF=$?
  case "$_RC_PROF" in
    0) case "$_PROF_OUT" in minimal|full) PROFILE_STATE=ok; TYCON_PROFILE_VALUE="$_PROF_OUT" ;; *) PROFILE_STATE=rota ;; esac ;;
    3) PROFILE_STATE=ok ;;
    *) PROFILE_STATE=rota ;;
  esac
  rm -f "$_PROF_ERR"
fi
# los hooks de minimal salen de la lista declarada (una sola fuente: la portada, el plan y doctor leen la misma)
PROFILE_MINIMAL_HOOKS=""
if [[ "$PROFILE_STATE" == "ok" && "$TYCON_PROFILE_VALUE" == "minimal" ]]; then
  PROFILE_MINIMAL_HOOKS="$(python3 - "$SCRIPT_DIR/setup/install-effects.json" <<'PY' 2>/dev/null
import json, sys
for e in json.load(open(sys.argv[1], encoding="utf-8"))["effects"]:
    if e.get("kind") == "hook" and "minimal" in (e.get("profiles") or []):
        print(e["id"])
PY
)" || PROFILE_MINIMAL_HOOKS=""
  if [[ -z "$PROFILE_MINIMAL_HOOKS" ]]; then
    PROFILE_STATE=rota
    echo "⚠ tycon: no pude leer qué trae el perfil minimal ($SCRIPT_DIR/setup/install-effects.json): lo que depende del perfil de instalación queda como estaba"
  fi
fi
case "$PROFILE_STATE" in
  ok) [[ "$TYCON_PROFILE_VALUE" == "minimal" ]] && echo "tycon: perfil de instalación: minimal — con el freno de comandos destructivos y el de editar código sin historia ni ajuste puntual, sin los demás frenos, sin los bloques que cambian cómo contesta el asistente, sin los ajustes de settings.json, sin hooks de git ni tareas de fondo (full: install.profile en ~/.claude/tycon.json)" ;;
  rota) echo "⚠ tycon: la configuración del arnés está ROTA — lo del perfil de instalación queda como estaba (ni se registra ni se saca; los dos frenos de comandos se registran igual) hasta arreglarla: node $SCRIPT_DIR/lib/tycon-config.js validate" ;;
  *) echo "⚠ tycon: sin scripts/lib/tycon-config.js (o sin node): no sé qué perfil de instalación tiene esta máquina — lo del perfil queda como estaba (los dos frenos de comandos se registran igual)" ;;
esac
# full de verdad: lo que sólo trae full se hace (sin valor también es full); minimal o no saber, no
PROFILE_FULL=0; [[ "$PROFILE_STATE" == "ok" && "$TYCON_PROFILE_VALUE" != "minimal" ]] && PROFILE_FULL=1
PROFILE_IS_MINIMAL=0; [[ "$PROFILE_STATE" == "ok" && "$TYCON_PROFILE_VALUE" == "minimal" ]] && PROFILE_IS_MINIMAL=1
# ============================================================
# Los hooks de settings.json
# ============================================================
# La lista de hooks vive en scripts/setup/hooks-list.json y la aplica scripts/setup/apply-hooks.js: el mismo aplicador
# que llama install-tycon-hooks.ps1. Este archivo no lleva una lista propia ni código propio para settings.json: con
# dos listas escritas aparte, se desfasan sin que nada lo diga. El aplicador decide cada hook por su `when`
# (integraciones, perfil de instalación, variables de opt-in) y escribe el informe que se imprime
# más abajo (ADDED/EXISTED/REMOVED/MISSING/NORMALIZED/BACKUP). Lista rota o settings.json roto: sale distinto de 0
# nombrando el archivo, no escribe nada, y este instalador corta acá (set -e).
TMP_REPORT=$(mktemp)   # lo limpia _tycon_cleanup (el handler único de salida — no re-trapear acá)

# ── Los nombres viejos: las rutas de archivos renombrados, a su nombre nuevo ────────────────────────────────
# El renombre a inglés deja un reemplazo en cada ruta vieja (sigue andando), pero cada máquina tiene esas rutas
# escritas en settings.json (hooks y permisos), settings.local.json, ~/.codex/hooks.json, ~/.git-hooks/* y el
# LaunchAgent del examen. Se reescriben ANTES del bloque de hooks, así éste encuentra el hook nuevo ya registrado y no
# lo duplica. Compara la ruta COMPLETA (`runs.js` está dentro de `upload-runs.js`), recarga un LaunchAgent sólo si
# estaba cargado, y con el mapa vacío no toca nada. El .ps1 llama al mismo guion. Guía: guides/maintaining/nombres-en-ingles.md.
RENAMED_N=0; RENAMED_OUT=""
if command -v node >/dev/null 2>&1 && [[ -f "$SCRIPT_DIR/lib/legacy-names.js" ]]; then
  _LN_ARGS=(--migrate-machine --guides "$(dirname "$SCRIPT_DIR")" --skills "$AGENT_SKILLS_REPO")
  [[ "$CHECK_ONLY" == "1" ]] && _LN_ARGS+=(--check)
  # si se cae, su mensaje es la línea «⛔ legacy-names: …» (la última de una pila no dice nada)
  RENAMED_OUT="$(node "$SCRIPT_DIR/lib/legacy-names.js" "${_LN_ARGS[@]}" 2>&1)" || {
    _ln_rc=$?
    _ln_msg="$(printf '%s\n' "$RENAMED_OUT" | grep -m1 '^⛔')"
    RENAMED_OUT="⚠ tycon: la migración de nombres viejos falló (salió ${_ln_rc}) — ${_ln_msg:-$(printf '%s' "$RENAMED_OUT" | tail -1)}"
  }
  RENAMED_N="$(printf '%s\n' "$RENAMED_OUT" | sed -n 's/^RENAMED:\([0-9][0-9]*\)$/\1/p' | head -1)"
  RENAMED_N="${RENAMED_N:-0}"
fi

_APPLY_ARGS=(--settings "$SETTINGS" --hooks-dir "$TCG_HOOKS_DIR" --skills "$AGENT_SKILLS" --platform posix --report-out "$TMP_REPORT")
[[ "$CHECK_ONLY" == "1" ]] && _APPLY_ARGS+=(--check)
node "$SCRIPT_DIR/setup/apply-hooks.js" "${_APPLY_ARGS[@]}"

# ── El mecanismo de instalación ─────────────────────────────────────────────────────────────────────
# En una máquina que todavía no tiene estado (`~/.claude/.tycon-pipeline/harness-state.json`), este
# aplicador —que la línea de arranque vieja SÍ llama— crea el estado sobre el clon, el enlace y el
# agent-skills que ya están, copia el arranque fijo y migra la línea de arranque una sola vez (si el
# `node` de la sesión alcanza el piso; si no, `harness.js` lo dice y deja la línea vieja). Va DESPUÉS
# de la escritura de settings.json (la migración la reescribe con copia previa) y no toma candado ni
# corre otro aplicador: el candado lo tiene este script (TYCON_HARNESS_LOCK_HELD=1). Con --check no se
# llama. Desde la sesión siguiente actualiza `harness.js startup`, por la copia fija.
# Lanzado POR harness.js (TYCON_HARNESS_LOCK_HELD=1) no se llama: el estado lo escribe quien lo lanzó, y durante su
# `install` el estado todavía no existe — se escribiría dos veces y quedaría una copia de seguridad de más.
if [[ "$CHECK_ONLY" != "1" && "${TYCON_HARNESS_LOCK_HELD:-0}" != "1" && -f "$SCRIPT_DIR/setup/harness.js" && ! -f "$HOME/.claude/.tycon-pipeline/harness-state.json" ]] && command -v node >/dev/null 2>&1; then
  TYCON_HARNESS_LOCK_HELD=1 node "$SCRIPT_DIR/setup/harness.js" install --from-existing || true
fi

# El reporte suma los nombres viejos reescritos: una línea, sólo si hubo alguno o la migración falló.
echo "RENAMED:${RENAMED_N}" >> "$TMP_REPORT"
if [[ "$RENAMED_N" != "0" ]]; then
  if [[ "$CHECK_ONLY" == "1" ]]; then
    echo "⚠ tycon: ${RENAMED_N} ruta(s) vieja(s) de archivos renombrados siguen en la configuración de esta máquina — corré install-tycon-hooks.sh"
  else
    echo "✓ tycon: reescribí ${RENAMED_N} ruta(s) vieja(s) de archivos renombrados a su nombre nuevo (story 8.9):"
  fi
  printf '%s\n' "$RENAMED_OUT" | grep '^  ' || true
elif [[ "$RENAMED_OUT" == ⚠* ]]; then
  echo "$RENAMED_OUT"
elif printf '%s\n' "$RENAMED_OUT" | grep '^  ⚠' >/dev/null; then
  # nada reescrito, pero algo quedó sin tocar (un plist binario, un archivo sin respaldo): se dice igual
  echo "⚠ tycon: la migración de nombres viejos dejó avisos (story 8.9):"
  printf '%s\n' "$RENAMED_OUT" | grep '^  ⚠' || true
fi

# ============================================================
# Output al user (silencioso si nada cambió)
# ============================================================
if [[ -s "$TMP_REPORT" ]]; then
  ADDED_LINE=$(grep '^ADDED:' "$TMP_REPORT" || true)
  REMOVED_LINE=$(grep '^REMOVED:' "$TMP_REPORT" || true)
  BACKUP_LINE=$(grep '^BACKUP:' "$TMP_REPORT" || true)
  MISSING_LINE=$(grep '^MISSING:' "$TMP_REPORT" || true)

  # Aviso de controles que NO se pudieron registrar (script ausente en el disco). Va SIEMPRE, aunque
  # no haya habido ningún cambio: el clone desactualizado es exactamente el caso donde no hay nada
  # que agregar. Fail-open igual — informa, no rompe.
  if [[ -n "$MISSING_LINE" ]]; then
    echo "🔴 TYCON hooks — ${MISSING_LINE#MISSING:} control(es) del arnés NO quedaron instalados en esta máquina:"
    grep '^  ! ' "$TMP_REPORT" || true
    echo "   Falta el script en el disco → tu copia del arnés está atrasada. Para arreglarlo:"
    _tcg_root=$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd) || _tcg_root="$SCRIPT_DIR/.."   # el propio clon, nunca una carpeta escrita a mano
    # en una versión BAJADA no hay git que tirar: la actualiza el programa. La carpeta del estado la
    # sabe tycon-home.js (una sola pieza): no se escribe acá
    # `|| true`: con `set -e`, una asignación cuyo `$(…)` falla (copia parcial sin tycon-home.js) cortaría el instalador
    # entero justo acá, antes del chequeo de Codex (installer-codex-evidence, caso 5)
    _state_dir="$(node -e 'process.stdout.write(require(process.argv[1]).stateDir())' "$SCRIPT_DIR/setup/harness/tycon-home.js" 2>/dev/null || true)"
    _state_file="${_state_dir:-/nonexistent}/harness-state.json"
    if grep -q '"kind":[[:space:]]*"release"' "$_state_file" 2>/dev/null; then
      echo "     node $_tcg_root/scripts/setup/harness.js update"
    else
      echo "     git -C $AGENT_SKILLS_REPO pull --ff-only && git -C $_tcg_root pull --ff-only"
    fi
    echo "   y volvé a abrir la sesión. (Estos controles NO están corriendo mientras tanto.)"
  fi
  # Una ruta que un shell leería mal (`$`, acento grave, comilla doble en la carpeta del clon o de la de usuario): el
  # aplicador no escribe un comando roto. Se dice, como lo que falta.
  UNSAFE_LINE=$(grep '^UNSAFE:' "$TMP_REPORT" || true)
  if [[ -n "$UNSAFE_LINE" ]]; then
    echo "🔴 TYCON hooks — ${UNSAFE_LINE#UNSAFE:} control(es) del arnés NO quedaron instalados: su ruta trae un carácter que el shell que lanza el hook leería de otra forma:"
    grep '^  !! ' "$TMP_REPORT" | sed 's/^  !! /  ! /' || true
    echo "   Remedio: que ni la carpeta del clon ni la de usuario traigan \$, acento grave o comilla doble en su nombre. (Estos controles NO están corriendo.)"
  fi

  # Línea de arranque normalizada: el pull de los dos repos con --ff-only --autostash.
  NORMALIZED_LINE=$(grep '^NORMALIZED:' "$TMP_REPORT" || true)
  if [[ -n "$NORMALIZED_LINE" ]]; then
    if [[ "$CHECK_ONLY" == "1" ]]; then
      echo "⚠ tycon: la línea de arranque NO protege cambios locales al actualizar el arnés (falta --ff-only/--autostash en un git pull) — un archivo modificado la frena en silencio. Corré install-tycon-hooks.sh"
    else
      echo "✓ tycon: la línea de arranque ahora protege cambios locales al actualizar el arnés (git pull --ff-only --autostash en los dos repos): un archivo modificado ya no frena la actualización en silencio."
      [[ -n "$BACKUP_LINE" && -z "$ADDED_LINE" && -z "$REMOVED_LINE" ]] && echo "✓ tycon: backup en ${BACKUP_LINE#BACKUP:}"
    fi
  fi

  # El cambio de forma de los hooks .js: del `node` del PATH al Node propio del arnés, o de vuelta
  REFORMED_LINE=$(grep '^REFORMED:' "$TMP_REPORT" || true)
  if [[ -n "$REFORMED_LINE" ]]; then
    if [[ "$CHECK_ONLY" == "1" ]]; then echo "⚠ tycon: ${REFORMED_LINE#REFORMED:} hook(s) .js con otro intérprete que el que corresponde (el Node del arnés o el del PATH) — corré install-tycon-hooks.sh"
    else echo "✓ tycon: ${REFORMED_LINE#REFORMED:} hook(s) .js cambiaron de intérprete, en su lugar (el Node del arnés o el del PATH: harness.js doctor lo dice)"; fi
    grep '^  ~ ' "$TMP_REPORT" || true
  fi

  if [[ -n "$ADDED_LINE" || -n "$REMOVED_LINE" ]]; then
    if [[ "$CHECK_ONLY" == "1" ]]; then
      [[ -n "$ADDED_LINE" ]] && echo "⚠ tycon: ${ADDED_LINE#ADDED:} hooks faltan en ~/.claude/settings.json — corré install-tycon-hooks.sh"
      [[ -n "$REMOVED_LINE" ]] && echo "⚠ tycon: ${REMOVED_LINE#REMOVED:} hooks superseded siguen en settings.json — corré install-tycon-hooks.sh"
      grep '^  [+-] ' "$TMP_REPORT" || true
    else
      [[ -n "$ADDED_LINE" ]] && echo "✓ tycon: instalé ${ADDED_LINE#ADDED:} hook(s) en ~/.claude/settings.json"
      [[ -n "$REMOVED_LINE" ]] && echo "✓ tycon: removí ${REMOVED_LINE#REMOVED:} hook(s) (motivo en línea)"
      grep '^  [+-] ' "$TMP_REPORT" || true
      if [[ -n "$BACKUP_LINE" ]]; then
        echo "✓ tycon: backup en ${BACKUP_LINE#BACKUP:}"
      fi
    fi
  fi
fi

# ============================================================
# Detección de features muertos: hooks registrados
# en settings.json cuya env var de activación está apagada salen en silencio
# (exit 0) y el feature parece vivo pero no produce NADA. Ejemplo:
# instinct-mining con hooks registrados y 0 observations
# cuando TYCON_INSTINCT_MINING no está exportada en la máquina.
# ============================================================
if grep -q 'instinct-observe.sh' "$SETTINGS" 2>/dev/null && [[ "${TYCON_INSTINCT_MINING:-0}" != "1" ]]; then
  echo "⚠ tycon: instinct-mining REGISTRADO pero APAGADO — el hook está en settings.json pero TYCON_INSTINCT_MINING≠1 (no graba nada). Agregá 'export TYCON_INSTINCT_MINING=1' a tu shell rc o removelo. Ver guides/integrations/instinct-mining.md"
fi
if grep -q 'instinct-observer' "$SETTINGS" 2>/dev/null && [[ "${TYCON_INSTINCT_OBSERVER:-0}" != "1" ]]; then
  echo "⚠ tycon: instinct-observer REGISTRADO pero APAGADO — TYCON_INSTINCT_OBSERVER≠1 (nunca propone instincts). Agregá 'export TYCON_INSTINCT_OBSERVER=1' a tu shell rc o removelo. Ver guides/integrations/instinct-mining.md"
fi

# ============================================================
# Suite de tests de la capa determinista.
# Corre tras cada cambio de lo que prueban (node:test 0-deps). Silenciosa si verde;
# si una regresión rompe isGitCommit/matchGlob/check-count se ve EL MISMO DÍA,
# no en la próxima auditoría manual. Skip si node no está (improbable).
# ============================================================
# `story-discovery.test.js` está separado de `unit.test.js` para que el chequeo de
# mutantes pueda correrlo (unit.test.js lanza herramientas reales y con la máquina cargada pasa
# el tope de 120s por corrida). Se listan los dos: una suite que nadie corre es indistinguible
# de una suite verde — el mismo motivo por el que existe este bloque.
# `advisor-ledger.test.js` (parte PURA del registro de corridas de revisores) entra acá
# —55ms, sin spawns—. Lo que lanza procesos va abajo, en el throttle diario.
# 🔴 Este bloque tiene que ser rápido: corre en CADA arranque de sesión, y una demora se paga entera cada vez que
# alguien abre Claude (la extensión de VS Code se rinde a los 60 s). `unit.test.js` lanza herramientas reales (lo dice
# el comentario de su propia separación) y por la doctrina de este archivo eso va al throttle diario (BACKFILL_TESTS),
# no acá. Lo que queda en línea son las seis rápidas, que sí son milisegundos.
# De DÓNDE salen lo dice la regla para quien lee (`_skills_dir read`: la variable › el
# propio clon si es unido › lo instalado), no la ruta donde se registran los hooks: corridas desde un clon de trabajo
# probarían las instaladas, un verde que no habría probado nada. La línea del rojo dice de qué raíz salieron. Si la
# carpeta que da la regla no existe (una variable que quedó apuntando a un clon borrado), la suite NO corrió y se dice:
# no es un verde. Con --check no se pregunta nada (no corren).
UT_SKILLS=""; UT_PRESENT=()
if [[ "$CHECK_ONLY" != "1" ]] && command -v node >/dev/null 2>&1; then
  if [[ ! -f "$SKILLS_DIR_JS" ]]; then
    UT_SKILLS="$AGENT_SKILLS"   # sin la biblioteca (copia parcial): las instaladas, como siempre
  else
    UT_SKILLS="$(_skills_dir read --skills 2>/dev/null)" || UT_SKILLS=""
    if [[ -z "$UT_SKILLS" ]]; then
      UT_WHY="$(_skills_dir read --skills 2>&1 >/dev/null | head -1 | sed 's/^skills-dir: //')" || true
      echo "⚠ tycon: la suite de la capa determinista NO corrió — ${UT_WHY:-scripts/lib/skills-dir.js no contestó}"
    fi
  fi
fi
if [[ -n "$UT_SKILLS" ]]; then
  UNIT_TESTS=(
    "$UT_SKILLS/tycon-pipeline/scripts/tests/story-discovery.test.js"
    "$UT_SKILLS/tycon-pipeline/scripts/tests/story-gate.test.js"
    "$UT_SKILLS/tycon-pipeline/scripts/tests/advisor-ledger.test.js"
    "$UT_SKILLS/tycon-pipeline/scripts/tests/config-lint.test.js"
    "$UT_SKILLS/tycon-pipeline/scripts/tests/navigation-drift.test.js"
    # honestidad del registro de ediciones (parte PURA, ~10ms, sin spawns). Lo que
    # cuida: que un registro lleno de ruido del pase adversarial no pase por registro sano.
    "$UT_SKILLS/tycon-pipeline/scripts/tests/ledger-honesty.test.js"
  )
  for t in "${UNIT_TESTS[@]}"; do [[ -f "$t" ]] && UT_PRESENT+=("$t"); done
fi
# Con --check no corren (--check no escribe): sobre una HOME vacía, estas suites
# dejan ~/.claude/.tycon-pipeline/file-events/ y story-dirs-cache.json. El aviso no se pierde: lo da la corrida normal de
# cada arranque.
# 🔴 Por `quick-suite-run.js`, nunca con un `node --test` suelto: corre sólo si cambió lo que prueban desde la última
# corrida verde, con tope de la mitad de los núcleos y una sola corrida por máquina. Suelto, cada sesión que abría
# lanzaba las seis enteras: con varias sesiones abriendo juntas, decenas de procesos y la máquina trabada.
QUICK_SUITE_JS="$SCRIPT_DIR/lib/quick-suite-run.js"
if [[ ${#UT_PRESENT[@]} -gt 0 && ! -f "$QUICK_SUITE_JS" ]]; then
  echo "⚠ tycon: la suite de la capa determinista NO corrió — falta $QUICK_SUITE_JS"
elif [[ ${#UT_PRESENT[@]} -gt 0 ]]; then
  if ! node "$QUICK_SUITE_JS" --state-dir "$HOME/.claude/.tycon-pipeline" --watch "$UT_SKILLS/tycon-pipeline/scripts" "${UT_PRESENT[@]}" >/dev/null 2>&1; then
    UT_FROM="installed"
    if [[ -f "$SKILLS_DIR_JS" ]]; then UT_FROM="$(_skills_dir read --source 2>/dev/null)" || UT_FROM="sin dato"; fi
    echo "🛑 tycon: la suite de la capa determinista FALLÓ tras el pull (skills: ${UT_SKILLS} · salió de: ${UT_FROM}) — hooks/gates pueden tener una regresión."
    echo "   Diagnóstico: node --test ${UT_PRESENT[*]}"
  fi
fi

# ============================================================
# Suite del descubridor de stories del backfill — throttle DIARIO.
# Por qué existe: dos buscadores de stories en repos distintos se desfasan —en un repo del equipo eso se vería como
# "0 stories Mary+GOLD encontradas"—. `tycon-backfill-followups.js` delega en `lib/story-discovery.js`, y esta suite es
# lo que impide que la unificación se deshaga sin que nadie se entere. Spawnea procesos → 1 vez/día.
# ============================================================
# 🔴 Los archivos se listan UNO POR UNO a propósito: `node --test <dir>` no resuelve el require
# por ruta de estos tests y falla con MODULE_NOT_FOUND — un rojo que no es del código. Al agregar
# una suite nueva acá, agregarla también a esta lista.
# `story-gate-cli.test.js` (portón de carril — la parte que lanza git + marker.js CLI) va
# acá, en el throttle diario, y NO en UNIT_TESTS: tarda ~1 min bajo carga en SessionStart.
# La parte pura del portón (story-gate.test.js) sí corre en cada arranque.
# 🔴 Las suites "backfill" (descubrimiento de stories, lints, métricas, examen, freno de story-a-mano…) y "matrix" (la
# matriz runtime) NO se lanzan desde las máquinas: están en scripts/tests/suites.json y corren en Azure DevOps con el
# resto (job `Suites`), donde lanzar git y procesos de verdad no le cuesta a nadie. Su reporte viaja en
# ultimo-suites.json.
BACKFILL_TESTS=()
# ── Reporte de las suites diarias que corren EN LÍNEA ──────────────────────────────────────────
# Las suites de fondo dejan su `{kind:"bash-tests"}` en .bench/, y por eso la detección de
# sello-trucho de bench-notice puede cruzar "sello de hoy" contra "reporte de hoy". Las dos que
# corren en línea (backfill/lint/portón-CLI y matriz runtime) también dejan el suyo, con el mismo shape: sin
# reporte, un sello escrito a mano sería indetectable.
tycon_report() { # tycon_report <kind> <fallas...>
  local kind="$1"; shift
  local bench="$TCG_HOOKS_DIR/../controls-bench/.bench"
  command -v node >/dev/null 2>&1 || return 0
  mkdir -p "$bench" 2>/dev/null || return 0
  node - "$bench" "$kind" "$@" <<'NODE' 2>/dev/null || true
const [out, kind, ...failures] = process.argv.slice(2);
const fs = require('fs');
const tmp = `${out}/${kind}.json.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify({ kind, ts: new Date().toISOString(), failures }, null, 1) + '\n');
fs.renameSync(tmp, `${out}/${kind}.json`);
NODE
}

BACKFILL_STAMP="$HOME/.claude/.tycon-pipeline/backfill-tests-last-run"
BF_PRESENT=()

# ============================================================
# Suite de la matriz runtime (DODRT-C6/C8) — throttle DIARIO.
# Por qué existe: una suite que no está wireada a ningún arranque puede estar en rojo sin que nadie lo vea (por
# ejemplo, por una fecha hardcodeada que se pudre). Una suite que nada corre es indistinguible de una suite verde.
# Tarda ~3.5s (spawnea procesos reales) → corre a lo sumo 1 vez por día por máquina, no en cada sesión.
# ============================================================
# (matrix: ver la nota de backfill, arriba — corre en ADO)

# ============================================================
# Banco de pruebas de controles — throttle DIARIO.
# Corre los casos de los ~20 hooks contra los scripts REALES (sandbox, sin LLM,
# ~45s) y compara contra la línea de base Claude: un control que se rompe suena
# acá, no en producción. El lado Codex (paridad + live-fire con sesiones reales)
# corre solo con TYCON_CODEX=1, en background para no frenar el arranque.
# Reporte → scripts/controls-bench/.bench/ · lo cobra bench-notice.js al arranque.
# Ver guides/maintaining/controls-bench.md. Opt-out: TYCON_BENCH_DAILY=0.
# ============================================================
# ============================================================
# Despliegue del lado Codex.
#
# UN solo entrypoint — build/deploy-codex-all.js — con una sola política, compartida con el
# instalador de Windows (.ps1 llama el MISMO script: dos copias inline del bloque driftean en la primera
# edición). Qué garantiza el entrypoint:
#   · fingerprint contra un stamp → el arranque estable cuesta ~5ms y cero spawns;
#   · respeta --check (NO escribe);
#   · silencioso si no hay nada que hacer; ante un fallo imprime la CAUSA + el comando;
#   · clon incompleto (git pull fallado) se dice como tal, no como "deploy roto".
# Por qué existe el bloque: los 4 deployers viven ANIDADOS bajo el stamp diario del banco —
# con el stamp puesto no desplegarían nada y no dirían nada.
#
# ¿Esta máquina usa Codex?
# La llave TYCON_CODEX vive en el rc del shell y a este instalador, que corre desde el arranque de sesión, no le llega:
# puesta en el .zshrc y en launchctl, acá llega VACÍA. Preguntar sólo por ella dejaría el lado Codex atrás en silencio.
# La pregunta la contesta el DISCO, con la misma función
# que usa el chequeo de paridad (codexDeployed() de scripts/lib/harness-parity.js), no una copia:
#   · TYCON_CODEX=1           → sí. Hace falta la PRIMERA vez, cuando todavía no hay nada desplegado.
#   · TYCON_CODEX=0 explícito → no, aunque haya evidencia (apagado a propósito; las suites aíslan así).
#   · sin la variable         → lo que diga el disco.
# Alcanza al despliegue y al AGENTS.md puntero. El LaunchAgent de apps gráficas y las corridas
# caras de Codex (más abajo) siguen pidiendo la llave: publican la llave misma o gastan sesiones.
# Un chequeo que FALLA no se lee como «no usa Codex»: sería un silencio con otra
# causa. 0 = sí · 10 = no · cualquier otra cosa = no pude saberlo → se avisa con la causa.
# ============================================================
CODEX_ON=0
# La llave es `integrations.codex` (TYCON_CODEX › ~/.claude/tycon.json › perfil del equipo › apagada):
# `1` sí · `0` no · `detect` lo que diga el disco (es lo que trae el perfil). Sin configuración: apagada —
# afuera nadie despliega Codex sin pedirlo. Configuración ROTA: nada de Codex hasta arreglarla (ya se avisó arriba).
# Sin lector (copia parcial de este archivo): la variable.
case "$INTEG_ESTADO" in
  ok) _CODEX_LLAVE="$TYCON_INTEG_CODEX" ;;
  rota) _CODEX_LLAVE=0 ;;
  *) case "${TYCON_CODEX-}" in 1) _CODEX_LLAVE=1 ;; 0) _CODEX_LLAVE=0 ;; *) _CODEX_LLAVE=detect ;; esac ;;
esac
case "$_CODEX_LLAVE" in
  1) CODEX_ON=1 ;;
  0) CODEX_ON=0 ;;
  *) if command -v node >/dev/null 2>&1; then
       # `|| CODEX_CHK_RC=$?`: con `set -e` una salida ≠0 cortaría el instalador entero.
       CODEX_CHK_RC=0
       CODEX_CHK_ERR="$(node -e 'try { process.exit(require(process.argv[1]).codexDeployed() ? 0 : 10) } catch (e) { console.error(e.message); process.exit(2) }' \
          "$(cd "$TCG_HOOKS_DIR/../.." && pwd)/scripts/lib/harness-parity.js" 2>&1 >/dev/null)" || CODEX_CHK_RC=$?
       case $CODEX_CHK_RC in
         0) CODEX_ON=1 ;;
         10) ;;
         *) echo "⚠ tycon: no pude saber si esta máquina usa Codex (${CODEX_CHK_ERR:-sin detalle}) — sigo como si no; para desplegarlo igual: TYCON_CODEX=1" ;;
       esac
     else
       echo "⚠ tycon: no pude saber si esta máquina usa Codex (no hay node en el PATH) — sigo como si no; para desplegarlo igual: TYCON_CODEX=1"
     fi ;;
esac
# Bajo el mecanismo de instalación: qué herramientas enchufa la máquina lo dice SU ESTADO, y a
# Codex lo enchufa harness.js en Node (el mismo camino en Mac y en Windows, y el único en una máquina sin Claude Code).
# `TYCON_HARNESS_CODEX` se lo dice a este instalador, y gana sobre la llave de arriba:
#   · done → la máquina usa Codex y su despliegue YA LO HIZO harness.js: acá se saltea (ni se despliega ni se anota);
#            lo demás que depende de «usa Codex» (los AGENTS.md puntero) sigue.
#   · off  → esta máquina no enchufa a Codex: nada de Codex, diga lo que diga la llave.
# Corrido suelto (sin la variable), todo lo de arriba vale como siempre.
CODEX_BY_HARNESS=0
case "${TYCON_HARNESS_CODEX:-}" in
  done) CODEX_ON=1; CODEX_BY_HARNESS=1 ;;
  off) CODEX_ON=0 ;;
esac

if [[ "$CODEX_ON" == "1" && "$CODEX_BY_HARNESS" != "1" ]] && command -v node >/dev/null 2>&1; then
  CODEX_DEPLOY_ALL="$(cd "$TCG_HOOKS_DIR/../.." && pwd)/build/deploy-codex-all.js"
  if [[ -f "$CODEX_DEPLOY_ALL" ]]; then
    if [[ "$CHECK_ONLY" == "1" ]]; then
      # la salida va tal cual, como siempre; el plan sólo necesita saber si dijo que el despliegue está pendiente
      _CODEX_CHECK_OUT="$(node "$CODEX_DEPLOY_ALL" --check)" || true
      [[ -n "$_CODEX_CHECK_OUT" ]] && printf '%s\n' "$_CODEX_CHECK_OUT"
      case "$_CODEX_CHECK_OUT" in *PENDIENTE*) CODEX_PENDING=1 ;; *) CODEX_PENDING=0 ;; esac
    else
      node "$CODEX_DEPLOY_ALL" || true
    fi
  fi
  # El plan: lo que el despliegue escribiría en $CODEX_HOME,
  # con los mismos `kind` e `id` que el reporte de abajo — un perfil y un subagente nativo por revisor, hooks.json,
  # config.toml y un enlace por skill de agent-skills (los enlaces del dev a otro lado no son del arnés). Falta → add;
  # está → keep, salvo hooks.json y config.toml cuando --check dijo que el despliegue está pendiente sin que falte nada
  # (contenido viejo) → update; un enlace propio cuyo origen desapareció → remove.
  if [[ -n "$PLAN_PIECES_TMP" ]]; then
    python3 - "${CODEX_HOME:-$HOME/.codex}" "$(cd "$TCG_HOOKS_DIR/../.." && pwd)/adapters/codex" "$AGENT_SKILLS" "${CODEX_PENDING:-0}" >> "$PLAN_PIECES_TMP" 2>/dev/null <<'PY' || PLAN_INCOMPLETE=1
import glob, os, sys
home, adapters, skills, pending = sys.argv[1], sys.argv[2], sys.argv[3].rstrip("/"), sys.argv[4] == "1"
rows = []
def row(rel, action):
    rows.append((rel, action))
files = [os.path.basename(f)[:-len(".toml")] + ".config.toml" for f in sorted(glob.glob(os.path.join(adapters, "agents", "*.toml")))]
files += ["agents/" + os.path.basename(f) for f in sorted(glob.glob(os.path.join(adapters, "agents-native", "*.toml")))]
missing = False
for rel in files + ["hooks.json", "config.toml"]:
    there = os.path.isfile(os.path.join(home, rel))
    missing = missing or not there
    row(rel, "keep" if there else "add")
if pending and not missing:
    rows = [(r, "update" if r in ("hooks.json", "config.toml") else a) for r, a in rows]
sk = os.path.join(home, "skills")
for n in sorted(os.listdir(skills)) if os.path.isdir(skills) else []:
    src = os.path.join(skills, n)
    if not os.path.isfile(os.path.join(src, "SKILL.md")):
        continue
    dst = os.path.join(sk, n)
    if os.path.islink(dst):
        to = os.readlink(dst)
        if to == src: row("skills/" + n, "keep")
        elif to.startswith(skills + "/"): row("skills/" + n, "update")
    elif not os.path.exists(dst):
        row("skills/" + n, "add")
for n in sorted(os.listdir(sk)) if os.path.isdir(sk) else []:
    p = os.path.join(sk, n)
    if os.path.islink(p) and os.readlink(p).startswith(skills + "/") and not os.path.exists(os.readlink(p)):
        row("skills/" + n, "remove")
for rel, action in rows:
    print("codex\t%s\t%s\t%s" % (os.path.join(home, rel), rel, action))
PY
  fi
  # Lo que el despliegue deja en $CODEX_HOME y es del arnés: un perfil y un subagente nativo por cada
  # revisor generado en adapters/codex/, hooks.json y config.toml (con sus entradas adentro), y los enlaces de
  # ~/.codex/skills que apuntan a agent-skills (los que el dev puso a mano no). El espejo AGENTS.md lo anota el sync.
  if [[ -n "$REPORT_PIECES_TMP" ]]; then
    python3 - "${CODEX_HOME:-$HOME/.codex}" "$(cd "$TCG_HOOKS_DIR/../.." && pwd)/adapters/codex" "$AGENT_SKILLS" >> "$REPORT_PIECES_TMP" 2>/dev/null <<'PY' || true
import glob, os, sys
home, adapters, skills = sys.argv[1], sys.argv[2], sys.argv[3]
def out(rel):
    print("codex\t%s\t%s" % (os.path.join(home, rel), rel))
for f in sorted(glob.glob(os.path.join(adapters, "agents", "*.toml"))):
    rel = os.path.basename(f)[:-len(".toml")] + ".config.toml"
    if os.path.isfile(os.path.join(home, rel)):
        out(rel)
for f in sorted(glob.glob(os.path.join(adapters, "agents-native", "*.toml"))):
    rel = "agents/" + os.path.basename(f)
    if os.path.isfile(os.path.join(home, rel)):
        out(rel)
for rel in ("hooks.json", "config.toml"):
    if os.path.isfile(os.path.join(home, rel)):
        out(rel)
sk = os.path.join(home, "skills")
for n in sorted(os.listdir(sk)) if os.path.isdir(sk) else []:
    p = os.path.join(sk, n)
    if os.path.islink(p) and os.readlink(p).startswith(skills.rstrip("/") + "/"):
        out("skills/" + n)
PY
  fi
fi

# ── AGENTS.md puntero en los repos de proyecto ──────────────────────────────
# El espejo automático cubre SOLO el CLAUDE.md GLOBAL; los de proyecto no se traducen
# (asimetría declarada en el inventario). Este bloque la cierra SIN segunda copia: deposita
# un AGENTS.md de puntero ("las reglas viven en CLAUDE.md — leelo y aplicalo") en cada repo
# bajo la raíz de repos de esta máquina que tenga CLAUDE.md y NO tenga AGENTS.md. Nunca pisa un
# AGENTS.md existente (propio o de otro origen). El dev lo commitea una vez y le llega al equipo.
# La raíz sale de scripts/lib/repos-root.js (TYCON_REPOS_ROOT, ~/.claude/tycon.json,
# las sesiones) y «repo del equipo» se decide con la organización configurada (ado.org): sin raíz o
# sin organización no se deposita nada, y se dice. Opt-out: TYCON_NO_AGENTSMD_POINTER=1.
if [[ "$CODEX_ON" == "1" && "${TYCON_NO_AGENTSMD_POINTER:-0}" != "1" ]]; then
  # rc 2 = la configuración del arnés está ROTA (tycon.json / perfil): se dice tal cual y no se deposita nada —
  # un archivo roto no se lee como «sin raíz» ni como «sin organización». rc 3 = sin valor.
  # 🔴 `|| _RC=$?` y no `; _RC=$?`: este archivo corre con `set -e`, y una asignación `X="$(cmd)"` con cmd ≠ 0
  # aborta el instalador ENTERO antes de leer el código.
  _CFG_ERR="$(mktemp)"; _RC_RAIZ=0; _RC_ORG=0
  _REPOS_ROOT="$(node "$SCRIPT_DIR/lib/repos-root.js" --plain 2>"$_CFG_ERR")" || _RC_RAIZ=$?
  _ADO_ORG="$(node "$SCRIPT_DIR/lib/tycon-config.js" get ado.org 2>>"$_CFG_ERR")" || _RC_ORG=$?
  _ORG_NOMBRE="${_ADO_ORG##*/}"
  if [[ "$_RC_RAIZ" == "2" || "$_RC_ORG" == "2" ]]; then
    echo "⚠ tycon/codex: la configuración del arnés está rota — no deposito punteros AGENTS.md hasta que se arregle:"
    sed 's/^/   /' "$_CFG_ERR"
    _REPOS_ROOT=""; _ORG_NOMBRE=""
  fi
  rm -f "$_CFG_ERR"
  if [[ "$_RC_RAIZ" == "2" || "$_RC_ORG" == "2" ]]; then
    :
  elif [[ -z "$_REPOS_ROOT" ]]; then
    echo "ℹ tycon/codex: sin raíz de repos conocida (TYCON_REPOS_ROOT, o rutas.repos en ~/.claude/tycon.json): no deposito punteros AGENTS.md"
  elif [[ -z "$_ORG_NOMBRE" ]]; then
    echo "ℹ tycon/codex: sin organización de Azure DevOps configurada (ado.org): no sé cuáles repos son del equipo, no deposito punteros AGENTS.md"
  else
  # Dos niveles: hay repos anidados en contenedores (ej. Cliente/Backend, Cliente/Project).
  for repo in "$_REPOS_ROOT"/*/ "$_REPOS_ROOT"/*/*/; do
    # ! -L además de ! -e: un AGENTS.md symlink ROTO da -e falso y el write saldría POR el
    # symlink, fuera del repo.
    [[ -d "$repo/.git" && -f "$repo/CLAUDE.md" && ! -e "$repo/AGENTS.md" && ! -L "$repo/AGENTS.md" ]] || continue
    # Solo repos DEL EQUIPO (origin en la organización configurada): en un fork ajeno o un repo personal depositar no
    # corresponde, y borrar el puntero no serviría porque cada arranque lo re-crearía. La guarda por origin lo resuelve
    # sin opt-out manual.
    origen="$(git -C "$repo" remote get-url origin 2>/dev/null || true)"
    case "$origen" in
      *"dev.azure.com/$_ORG_NOMBRE"*|*"$_ORG_NOMBRE.visualstudio.com"*) ;;
      *) continue ;;
    esac
    if [[ "$CHECK_ONLY" == "1" ]]; then
      echo "⚠ $repo tiene CLAUDE.md sin AGENTS.md — bajo Codex sus reglas de proyecto no se cargan"
      continue
    fi
    cat > "$repo/AGENTS.md" <<'AGENTSMD' || true
# AGENTS.md — puntero (lo depositó el arnés TYCON; commitealo así le llega al equipo)

Las reglas de este repo viven en `CLAUDE.md`, el canónico multi-herramienta.
**Antes de trabajar acá: leé `./CLAUDE.md` COMPLETO y aplicalo como si fuera este archivo.**
Si existe `./CLAUDE.local.md`, leelo y aplicalo también.

No agregues reglas acá: se escriben en `CLAUDE.md` — este puntero existe para que no haya
dos copias que mantener. (Convención: INSTALL.md del arnés, §Lado Codex.)
AGENTSMD
    if [[ -f "$repo/AGENTS.md" ]]; then
      echo "✓ $repo: AGENTS.md puntero depositado (commitealo cuando puedas)"
    else
      echo "⚠ $repo: no pude escribir AGENTS.md (¿permisos?) — sigo con el resto"
    fi
  done
  fi
fi

# ── Ambiente para apps GRÁFICAS en macOS ────────────────────────────────────
# Los secretos de los MCP bajo Codex se leen del ambiente; el panel de Codex en VSCode no pasa
# por ~/.zshrc y no los ve (un servidor sin su llave aunque el export esté). Un LaunchAgent invoca en
# cada login scripts/setup/harness-env-publish.sh, que publica TYCON_CODEX y los env de
# ~/.claude.json (mcpServers.*.env) con launchctl setenv — sin copiar secretos a ningún
# archivo nuevo. Windows no lo necesita (variables de usuario en el registro, permanentes).
# Idempotente: reescribe el plist solo si cambió; corre el script YA para no esperar al login.
# Opt-out: TYCON_NO_GUI_ENV=1.
if [[ "$(uname)" == "Darwin" && "${TYCON_CODEX:-0}" == "1" && "${TYCON_NO_GUI_ENV:-0}" != "1" ]]; then
  ENV_PUBLISH="$SCRIPT_DIR/setup/harness-env-publish.sh"
  PLIST_DIR="$HOME/Library/LaunchAgents"
  PLIST="$PLIST_DIR/ar.com.tycon.harness-env.plist"
  if [[ -f "$ENV_PUBLISH" ]]; then
    PLIST_WANT="$(cat <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ar.com.tycon.harness-env</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$ENV_PUBLISH</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PL
)"
    if [[ "$(cat "$PLIST" 2>/dev/null)" == "$PLIST_WANT" ]]; then plan_record launch-agent "$PLIST" ar.com.tycon.harness-env keep
    elif [[ -e "$PLIST" ]]; then plan_record launch-agent "$PLIST" ar.com.tycon.harness-env update
    else plan_record launch-agent "$PLIST" ar.com.tycon.harness-env add; fi
    if [[ "$(cat "$PLIST" 2>/dev/null)" != "$PLIST_WANT" ]]; then
      if [[ "$CHECK_ONLY" == "1" ]]; then
        echo "⚠ falta (o cambió) el LaunchAgent que publica el ambiente Codex a las apps gráficas"
      else
        mkdir -p "$PLIST_DIR"
        printf '%s\n' "$PLIST_WANT" > "$PLIST"
        launchctl bootout "gui/$(id -u)/ar.com.tycon.harness-env" >/dev/null 2>&1 || true
        launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || launchctl load "$PLIST" >/dev/null 2>&1 || true
        echo "✓ LaunchAgent del ambiente Codex instalado (las apps gráficas ven la llave y los secretos MCP en cada login)"
      fi
    fi
    [[ "$CHECK_ONLY" == "1" ]] || bash "$ENV_PUBLISH" >/dev/null 2>&1 || true
    if [[ "$(cat "$PLIST" 2>/dev/null)" == "$PLIST_WANT" ]]; then record launch-agent "$PLIST" ar.com.tycon.harness-env; fi
  fi
fi

BENCH_RUNNER="$TCG_HOOKS_DIR/../controls-bench/runner.js"
BENCH_STAMP="$HOME/.claude/.tycon-pipeline/controls-bench-last-run"
if [[ "${TYCON_BENCH_DAILY:-1}" != "0" ]] && command -v node >/dev/null 2>&1 && [[ -f "$BENCH_RUNNER" ]]; then
  TODAY_CB="$(date +%Y-%m-%d)"
  LAST_CB="$(cat "$BENCH_STAMP" 2>/dev/null || true)"
  # 🔴 DE FONDO y con reintento diario, no en línea y en cada arranque. Un banco de ~3 min con la línea de base sin
  # sellar, corrido EN LÍNEA, se lleva puesto el arranque: la extensión de VS Code, que se rinde a los 60 s, deja de
  # abrir. Dos decisiones: el arranque no espera a ninguna batería, y un rojo se reintenta UNA VEZ POR DÍA en vez de en
  # cada sesión. El aviso no se pierde — lo cobra bench-notice.js al arranque siguiente, leyendo el reporte de .bench/.
  BENCH_TRY_STAMP="$HOME/.claude/.tycon-pipeline/controls-bench-last-try"
  LAST_TRY_CB="$(cat "$BENCH_TRY_STAMP" 2>/dev/null || true)"
  # 🔴 El banco determinista NO se lanza desde las máquinas. Corre de noche en Azure DevOps
  # (pipelines/azure-pipelines-banco.yml) sobre lo publicado en main, y su reporte viaja por git:
  # `scripts/controls-bench/ultimo-banco.json`, que bench-notice.js lee y denuncia si envejece. Lanzarlo acá lo correría
  # DOS veces por arranque (este bloque y el de las dos herramientas, más abajo), y el segundo se relanzaría en CADA
  # sesión si su gatillo fuera el sello verde, que un caso frágil mantiene en rojo. Dos bancos superpuestos agotan el
  # tiempo de los casos y fabrican regresiones falsas. A mano sigue disponible:
  # `node scripts/controls-bench/runner.js --tool claude`.
  :
  if [[ "$LAST_CB" != "$TODAY_CB" ]]; then
    # Frescura del generador: ¿adapters/codex/agents/*.toml refleja el canónico?
    # Sin LLM, ~50ms. OJO alcance: en máquinas TYCON_CODEX=1 el deploy de
    # arriba regenera ANTES, así que acá no puede dar rojo — y el nudge de "commitear los .toml
    # regenerados" lo imprime deploy-codex-all. Este check protege a las máquinas SIN Codex y
    # al que commitea (vía pre-commit).
    GEN_CHECK="$TCG_HOOKS_DIR/../../build/check.js"
    if [[ -f "$GEN_CHECK" ]] && ! node "$GEN_CHECK" >/dev/null 2>&1; then
      echo "🛑 tycon: adapters/codex DESACTUALIZADO vs el canónico — corré: node $(cd "$TCG_HOOKS_DIR/../.." && pwd)/build/generate.js"
    fi
    # con --check no se sella ni se lanza nada (--check no escribe)
    if [[ "${TYCON_CODEX:-0}" == "1" && "$CHECK_ONLY" != "1" ]]; then
      # Sólo las corridas CARAS (sesiones LLM reales) quedan bajo el stamp diario. El despliegue
      # está en su propio bloque, más arriba: ver "Despliegue del lado Codex".
      # Los casos de ADVISORS no se lanzan desde acá: los lanza `periodic-exam.js`, en su propio bloque de abajo. Un
      # lanzador pegado a este bloque quedaría bajo TRES condiciones anidadas —el stamp diario de arriba, este
      # TYCON_CODEX, y TYCON_BENCH_DAILY— y, si sellara la semana ANTES de correr, nunca correría en la máquina del dev,
      # donde la llave de Codex no está puesta.
      # `runner.js --tool both` corre en ADO con el resto del banco (ver arriba). Lo único que tiene que correr en una
      # máquina es el disparo REAL dentro de Codex — y con su PROPIO sello diario: si heredara el sello verde del banco,
      # un rojo cualquiera lo dejaría viejo y esto se relanzaría en cada arranque de sesión.
      LIVE_FIRE_STAMP="$HOME/.claude/.tycon-pipeline/live-fire-codex-last-try"
      if [[ "$(cat "$LIVE_FIRE_STAMP" 2>/dev/null || true)" != "$TODAY_CB" ]]; then
        echo "$TODAY_CB" > "$LIVE_FIRE_STAMP" 2>/dev/null || true
        nohup "$HNODE" "$TCG_HOOKS_DIR/../controls-bench/live-fire.js" --tool codex >/dev/null 2>&1 &
      fi
    fi
  fi
fi

# ============================================================
# El examen periódico de los 28 revisores.
#
# 🔴 Este bloque es de PRIMER NIVEL a propósito. Un lanzador dentro del bloque de arriba quedaría bajo tres
# condiciones anidadas; la de afuera es el sello DIARIO del banco determinista, así que si ese banco ya corrió hoy, el
# examen semanal ni se evaluaría. Un control que sólo se pregunta si le toca cuando OTRO control no corrió es un
# control que no corre.
#
# Acá el instalador no decide nada: sólo invoca. Quién corre (máquina designada), cada cuánto y a
# qué hora lo decide `exam-config.json`, y el propio script se ocupa del candado, del sello (que
# se escribe al TERMINAR) y de que el resultado viaje por git.
# 🔴 Y el instalador NO lanza el examen: sólo instala (o retira) el disparador. Lanzarlo también
# desde acá crearía DOS programadores para lo mismo y haría
# que cada máquina del equipo ejecutara la pieza en cada arranque, cuando para el resto del equipo
# lo único que tiene que cambiar es el texto del aviso. Si el mini estaba dormido a las 2, launchd
# corre igual el trabajo perdido al despertar; y si aun así no corre, la denuncia a los 8 días lo dice.
#   · `--install-task`: instala el disparador SÓLO en la designada, y lo retira en las demás.
# Apagado: TYCON_NO_NIGHTLY_EXAM=1
# ============================================================
EXAMEN_PERIODICO="$TCG_HOOKS_DIR/../controls-bench/periodic-exam.js"
legacy_env TYCON_NO_NIGHTLY_EXAM
# sólo en full: fuera de full ni se instala ni se retira (si quedó, lo saca el cambio de perfil de harness.js)
if [[ "${TYCON_NO_NIGHTLY_EXAM:-0}" != "1" && "$PROFILE_FULL" == "1" ]] && command -v node >/dev/null 2>&1 && [[ -f "$EXAMEN_PERIODICO" ]]; then
  if [[ "$CHECK_ONLY" == "1" ]]; then
    node "$EXAMEN_PERIODICO" --install-task --check 2>/dev/null || true
  else
    node "$EXAMEN_PERIODICO" --install-task 2>/dev/null || true
  fi
  # su disparador, si quedó (sólo en la máquina designada: en las demás periodic-exam.js lo retira); la variable tiene
  # nombre viejo en el mapa: se lee por la biblioteca, como las demás
  legacy_env TYCON_EXAM_LAUNCHAGENTS
  _EXAM_PLIST="${TYCON_EXAM_LAUNCHAGENTS:-$HOME/Library/LaunchAgents}/ar.com.tycon.examen-periodico.plist"
  if [[ -f "$_EXAM_PLIST" ]]; then record launch-agent "$_EXAM_PLIST" ar.com.tycon.examen-periodico; fi
  # en el plan, sólo el que ya está (quién lo instala lo decide periodic-exam.js, y sólo en la máquina designada)
  if [[ -f "$_EXAM_PLIST" ]]; then plan_record launch-agent "$_EXAM_PLIST" ar.com.tycon.examen-periodico keep; fi
fi

# ============================================================
# Bloques team-wide de ~/.claude/CLAUDE.md.
# `CLAUDE.md` no está versionado (archivo suelto en el home de cada dev) y las
# guías de este repo son lectura on-demand — así que una regla que tiene que estar
# SIEMPRE cargada necesita este puente. El sync es QUIRÚRGICO: solo toca lo que
# está entre sus propios marcadores `TYCON_BLOCK:<nombre>`; lo que el dev escribió
# a mano (y el bloque CODEGRAPH, que no es nuestro) queda intacto. Fail-open.
# Opt-out: TYCON_NO_CLAUDEMD_SYNC=1.
# ============================================================
SYNC_BLOCKS="$SCRIPT_DIR/setup/sync-claude-md-blocks.sh"
if [[ -f "$SYNC_BLOCKS" ]]; then
  if [[ "$CHECK_ONLY" == "1" ]]; then
    bash "$SYNC_BLOCKS" --check 2>/dev/null || true
  else
    bash "$SYNC_BLOCKS" 2>/dev/null || true
  fi
fi

# La línea de ~/.claude/CLAUDE.md que carga el índice de guías: el índice es INDEX.md y README.md es la
# portada. Este aplicador es el del árbol NUEVO aunque la actualización la haya decidido el programa instalado antes, así
# que la misma actualización deja la línea nueva (la vieja, reescrita en su lugar; nunca dos). No la agrega si no está:
# eso es de harness.js. Fail-open: si no puede, la reescribe el próximo arranque. Detalle: setup/harness/import-line.js.
if [[ -f "$SCRIPT_DIR/setup/harness/import-line.js" ]] && command -v node >/dev/null 2>&1; then
  if [[ "$CHECK_ONLY" == "1" ]]; then
    node "$SCRIPT_DIR/setup/harness/import-line.js" --fix --check --quiet 2>/dev/null || true
  else
    node "$SCRIPT_DIR/setup/harness/import-line.js" --fix --quiet 2>/dev/null || true
  fi
fi

# ============================================================
# Los comandos de barra del equipo. Mismo problema que los bloques de
# CLAUDE.md: viven versionados en `commands/` pero Claude Code los lee de
# `~/.claude/commands/`, y copiarlos A MANO haría que `/tycon-instincts` existiera sólo en la máquina de quien lo
# escribió. Una pieza que depende de que alguien se acuerde es una pieza que la mitad del equipo no tiene.
# Copia sólo si cambió, no pisa comandos propios del dev que no estén en el repo.
# Opt-out: TYCON_NO_COMMANDS_SYNC=1.
# Pieza compartida: bajo un `harness.js` que ya los copió y los anotó
# (TYCON_HARNESS_SHARED_DONE=1) este bloque se saltea, con su reporte.
# ============================================================
if [[ "${TYCON_HARNESS_SHARED_DONE:-0}" != "1" && "${TYCON_NO_COMMANDS_SYNC:-0}" != "1" && -d "$SCRIPT_DIR/../commands" ]]; then
  # con --check ni la carpeta se crea: sólo se dice qué comando falta o cambió
  [[ "$CHECK_ONLY" == "1" ]] || mkdir -p "$HOME/.claude/commands" 2>/dev/null || true
  for _cmd in "$SCRIPT_DIR"/../commands/*.md; do
    [[ -f "$_cmd" ]] || continue
    _dst="$HOME/.claude/commands/$(basename "$_cmd")"
    plan_copy command "$_cmd" "$_dst" "$(basename "$_cmd")"
    if ! cmp -s "$_cmd" "$_dst" 2>/dev/null; then
      if [[ "$CHECK_ONLY" == "1" ]]; then
        echo "  · comando desactualizado: $(basename "$_cmd")"
      else
        cp "$_cmd" "$_dst" 2>/dev/null || true
      fi
    fi
    # del arnés sólo si quedó igual al del repo (uno que el dev cambió a mano, o que no se pudo copiar, no se anota)
    if cmp -s "$_cmd" "$_dst" 2>/dev/null; then record command "$_dst" "$(basename "$_cmd")"; fi
  done
fi

# ============================================================
# Versión de engram vs el pin del equipo. AVISA, nunca actualiza —
# los chunks de `.engram/` se comparten por git y la deriva de versiones puede
# partir la memoria en dos formatos con falla silenciosa. Ver el header de
# check-engram-version.sh. Silencioso si coincide. Opt-out:
# TYCON_NO_ENGRAM_VERSION_CHECK=1.
# ============================================================
# ============================================================
# Paridad de INSTALACIÓN Claude↔Codex. Corre en CADA arranque, DE FONDO (~0.3s,
# cero costo en el critical path) y DESPUÉS del sync de bloques: anidada bajo el stamp diario del banco sería el mismo
# anti-patrón que deja a los deployers sin correr, y ANTES del sync gritaría un rojo de AGENTS.md que el propio
# arranque arregla dos líneas más abajo. Se auto-gatea si la máquina no tiene lado
# Codex desplegado; el rojo lo cobra bench-notice en el próximo arranque. Respeta --check.
# ============================================================
if [[ "$CHECK_ONLY" != "1" && "$PROFILE_FULL" == "1" ]] && command -v node >/dev/null 2>&1 && [[ -f "$SCRIPT_DIR/lib/harness-parity.js" ]]; then
  nohup "$HNODE" "$SCRIPT_DIR/lib/harness-parity.js" >/dev/null 2>&1 &
fi

ENGRAM_VER_CHECK="$SCRIPT_DIR/setup/check-engram-version.sh"
# Los tres chequeos de engram (versión, sqlite3, nombre de proyecto) sólo con la integración prendida.
if [[ "$TYCON_INTEG_ENGRAM" == "1" && -f "$ENGRAM_VER_CHECK" ]]; then
  if [[ "$CHECK_ONLY" == "1" ]]; then
    # --check no escribe: el `--check` de ese script fuerza los avisos, no frena su auto-alineación
    # (que actualiza engram con una versión atrasada). Con la variable queda el aviso y no se actualiza nada.
    TYCON_ENGRAM_AUTO_UPGRADE=0 bash "$ENGRAM_VER_CHECK" --check 2>/dev/null || true
  else
    bash "$ENGRAM_VER_CHECK" 2>/dev/null || true
  fi
fi

# ============================================================
# Dependencia de los chequeos de salud de la memoria: el COMANDO `sqlite3`.
# Va acá, pegado al de engram, porque es su compañero: dos de los cuatro chequeos leen la base
# de engram por dentro (el dato "desde qué carpeta se guardó cada recuerdo" no lo expone ningún
# comando de engram) y sin `sqlite3` no pueden correr.
# 🔴 Tener engram NO alcanza: lleva su propio SQLite compilado adentro (modernc.org/sqlite), así
# que anda perfecto sin dejar el comando en el PATH. En macOS viene con el sistema; en Windows no
# viene ni con el sistema ni con engram (que allá se instala con `go install`) — de ahí el .ps1.
# Silencioso si ya está. Opt-outs: TYCON_NO_SQLITE_CHECK=1 · TYCON_SQLITE_AUTO_INSTALL=0.
# ============================================================
SQLITE_ENSURE="$SCRIPT_DIR/setup/ensure-sqlite3.sh"
if [[ "$TYCON_INTEG_ENGRAM" == "1" && -f "$SQLITE_ENSURE" && "$CHECK_ONLY" != "1" ]]; then
  # 🔴 SIN `2>/dev/null`. Con el redirect, el helper avisaría por stderr y el instalador lo tiraría: el aviso
  # existiría y no lo vería nadie. O sea, el arreglo de "no te quedes callado" quedaría anulado por
  # quien lo invoca. El `|| true` se conserva: esto nunca puede romper el arranque.
  bash "$SQLITE_ENSURE" || true
fi

# ============================================================
# Nombre de proyecto de engram: UNO por repo.
# `.engram/config.json → project_name` (lo usa la sesión) y `.engram-project` (lo usa el hook
# de commit) pueden desacordar sin ningún error — y la memoria se parte en dos cajones.
# AVISA sobre el repo de la
# sesión ($PWD), nunca bloquea, silencioso si coinciden. Opt-out: TYCON_NO_ENGRAM_PROJECT_CHECK=1.
# ============================================================
ENGRAM_PROJECT_CHECK="$SCRIPT_DIR/setup/check-engram-project.sh"
if [[ "$TYCON_INTEG_ENGRAM" == "1" && -f "$ENGRAM_PROJECT_CHECK" ]]; then
  bash "$ENGRAM_PROJECT_CHECK" "$PWD" 2>/dev/null || true
fi

# ============================================================
# Suites de prueba del arnés — NO CORREN ACÁ
#
# Corren de noche en Azure DevOps: pipelines/azure-pipelines-banco.yml, job `Suites`, sobre lo publicado en
# main y con los repos de los productos clonados. El reporte viaja por git
# (scripts/controls-bench/ultimo-suites.json) y bench-notice.js denuncia si dejan de correr.
#
# 🔴 Por qué no corren acá: corriendo en la máquina del dev, el veredicto depende de qué tiene en el disco y en qué
# rama: `tolerant-steps` da ROJO con hallazgos que en `main` no existen (ramas `dev` de frontends, repos que ni
# siquiera son del arnés). Un control que acusa a pipelines que no corren es un control que se apaga.
#
# LA lista de suites vive en scripts/tests/suites.json (la lee el pipeline). A mano, cualquiera:
#   bash scripts/tests/<suite>.test.sh
# ============================================================

# ============================================================
# Snapshot de las MÉTRICAS DE ETAPA del SDLC — throttle DIARIO, DE FONDO.
#
# Escribe un punto de serie por día en `<tcg>/.dashboard/sdlc-stage-<fecha>.json`: lead time
# story→cierre, first-pass del pipeline, rework por follow-ups y evidencia de cierre.
# Existe porque estas métricas NO SE MIDEN solas, teniendo toda la materia prima en el disco.
#
# De fondo y con sello diario por el mismo motivo que las suites de arriba: barre los repos
# con git log y tarda minutos; colgado del arranque bloquearía la sesión. Sólo LEE (git log +
# frontmatter) y escribe su propio snapshot — no toca ningún repo de trabajo.
#
# 🔴 Descubre los repos SOLO (`--scan`): una lista a mano falla —mide los repos de implementación, que no contienen
# las stories— y el escaneo encuentra más repos y stories.
# override con TYCON_METRICS_SCAN_ROOT. Off: TYCON_STAGE_METRICS=0.
# ============================================================
STAGE_METRICS_JS="$SCRIPT_DIR/metrics/sdlc-stage-metrics.js"
STAGE_STAMP="$HOME/.claude/.tycon-pipeline/stage-metrics-last-run"
STAGE_ROOT="${TYCON_METRICS_SCAN_ROOT:-$(dirname "$(dirname "$SCRIPT_DIR")")}"
# con --check no se sella ni se lanza el barrido (--check no escribe: dejaría el sello en
# ~/.claude/.tycon-pipeline/ y lanzaría el respaldo, que escribe su punto del día en el clon)
# 🔴 Sólo donde el arnés corre desde un CLON: en una versión instalada el árbol no es un clon, la foto del
# día nunca está en `<árbol>/.dashboard/` y este respaldo correría todos los días, barriendo una carpeta sin repos y
# dejando una foto vacía con el nombre de la del nocturno. La pregunta vive en scripts/lib/meter-backup.sh.
# shellcheck source=lib/meter-backup.sh
if [[ -f "$SCRIPT_DIR/lib/meter-backup.sh" ]]; then . "$SCRIPT_DIR/lib/meter-backup.sh"
else echo "⚠️  falta scripts/lib/meter-backup.sh: el respaldo local del medidor no corre (el árbol del arnés está incompleto)" >&2; fi
if [[ "$CHECK_ONLY" != "1" && "${TYCON_STAGE_METRICS:-1}" == "1" && "$PROFILE_FULL" == "1" ]] && command -v node >/dev/null 2>&1 \
   && [[ -f "$STAGE_METRICS_JS" && -d "$STAGE_ROOT" ]] && meter_backup_has_own_tree "$(dirname "$SCRIPT_DIR")"; then
  TODAY_SM="$(date +%Y-%m-%d)"
  # Escritor ÚNICO: el punto del día lo escribe el pipeline nocturno de ADO; esta corrida local es el RESPALDO — sólo
  # actúa si el snapshot de hoy no llegó con el pull (pipeline caído o repo sin red). Dos escritores del mismo archivo
  # por día = conflictos de merge en la serie, que es justo lo que la serie no puede tener.
  # 🔴 La decisión vive en scripts/lib/meter-backup.sh y mira también la HORA: antes de las 03:00 el archivo de hoy
  # nunca está —el nocturno no corrió todavía—, y el respaldo correría en toda sesión de madrugada aunque nada hubiera
  # fallado. Después el nocturno commitearía el suyo y el `git pull` de la mañana rebotaría contra el suelto.
  _SM_EXISTE=0; [[ -f "$(dirname "$SCRIPT_DIR")/.dashboard/sdlc-stage-$TODAY_SM.json" ]] && _SM_EXISTE=1
  _SM_SELLO_HOY=0; [[ "$(cat "$STAGE_STAMP" 2>/dev/null || true)" == "$TODAY_SM" ]] && _SM_SELLO_HOY=1
  if [[ "$_SM_EXISTE" == "1" ]]; then
    echo "$TODAY_SM" > "$STAGE_STAMP" 2>/dev/null || true
  elif respaldo_medidor_debe_correr "$(date +%H)" "$_SM_EXISTE" "$_SM_SELLO_HOY"; then
    mkdir -p "$(dirname "$STAGE_STAMP")" 2>/dev/null || true
    # Stampea ANTES de lanzar: si el barrido falla, no se reintenta en cada arranque del día
    # (un job de minutos reintentado en loop es peor que un snapshot faltante — el hueco se ve
    # solo, como serie con un día menos).
    echo "$TODAY_SM" > "$STAGE_STAMP" 2>/dev/null || true
    nohup "$HNODE" "$STAGE_METRICS_JS" --scan "$STAGE_ROOT" --snapshot --json >/dev/null 2>&1 &
  fi
fi

# ============================================================
# Rescate del hilo y el consumo de las ejecuciones del pipeline.
#
# El archivador del pipeline guarda por corrida los tiempos, los frenos y los agentes, pero el
# CONSUMO y el HILO viven sólo en la conversación de Claude Code, que se borra a los 30 días.
#
# 🔴 Por qué acá y no sólo en el cierre del pipeline: el archivador corre en el `clear`, y DESPUÉS
# siguen la preparación del commit, el cierre y el resumen. O sea que lo guardado al cerrar es un
# hilo TRUNCADO, y el consumo de ese tramo final no queda en ningún lado. Este barrido vuelve a
# pasar sobre toda corrida cuya conversación siga creciendo y reescribe lo que haga falta — un solo
# mecanismo cubre tres cosas: el cierre truncado, el rescate hacia atrás, y las corridas de las
# OTRAS máquinas (las transcripciones viven donde corrió el pipeline).
#
# 🔴 Sin sello diario, a propósito: el caso que esto cubre es justo el cierre de la corrida
# anterior, así que tiene que correr en el arranque SIGUIENTE, no una vez por día. El costo se
# acota por tiempo (--budget-ms), no por sello, y va en segundo plano: nunca bloquea el arranque.
# Apagar: TYCON_NO_THREAD_RESCUE=1
#
# Y DESPUÉS, en la misma tanda de fondo, las corridas al BUZÓN de Azure Storage:
#   · `upload-runs.js` sube lo nuevo o lo que creció, bajo la carpeta de esta máquina, con la llave de
#     SÓLO ESCRITURA commiteada en scripts/metrics/corridas-buzon.json. Todas las máquinas suben; nada
#     que configurar. Va después del barrido para que lo rescatado en este arranque suba en este arranque.
#   · `download-runs.js` baja lo de todo el equipo a ~/.claude/.tycon-pipeline/corridas-buzon/, con la
#     sesión de az de la persona. Sólo DevA y DevB tienen el rol de lectura: en cualquier otra máquina
#     no hace nada, no crea la carpeta y nunca abre un login. Va después de la subida para que la vista
#     de esta máquina incluya lo de hoy.
#
# Y ENTRE el barrido y la subida, la recolección de HALLAZGOS:
#   · `collect-findings.js` recorre los repos de esta máquina (dos niveles bajo la raíz de repos),
#     proyecta cada hallazgo de los revisores a seis claves y deja ~/.claude/.tycon-pipeline/hallazgos.jsonl,
#     que la subida sube como un registro más. Va ANTES de la subida para que lo de hoy suba hoy. Tiene su
#     propio sello diario: en el segundo arranque del día contesta «ya lo hice» y no recorre nada.
#   🔴 No depende de la subida: el cruce de poda de ESTA máquina lo lee aunque la subida esté apagada.
# Registros: ~/.claude/.tycon-pipeline/{collect-findings,upload-runs,download-runs}.log
#            (se agregan; pasado ~512 KB, el viejo va a .1) y thread-rescue.log (el del barrido: se reescribe)
#   🔴 Los registros con nombre en castellano se copian ANTES de abrirlos: los abre bash con `>>` antes de que corra
#      node (`legacy-names.js --prepare-state`, una sola llamada, también de fondo); el viejo queda intacto hasta el
#      retiro del mapa.
# Apagar: TYCON_NO_UPLOAD_RUNS=1 · TYCON_NO_DOWNLOAD_RUNS=1 · TYCON_NO_COLLECT_FINDINGS=1
#         (cada llave apaga sólo lo suyo)
# ============================================================
TOKENS_DIGEST_JS="$SCRIPT_DIR/metrics/tokens-digest.js"
SUBIR_CORRIDAS_JS="$SCRIPT_DIR/metrics/upload-runs.js"
BAJAR_CORRIDAS_JS="$SCRIPT_DIR/metrics/download-runs.js"
RECOLECTAR_JS="$SCRIPT_DIR/metrics/collect-findings.js"
LEGACY_NAMES_JS="$SCRIPT_DIR/lib/legacy-names.js"
_RESCATAR=0; _SUBIR=0; _BAJAR=0; _RECOLECTAR=0
legacy_env TYCON_NO_THREAD_RESCUE; legacy_env TYCON_NO_UPLOAD_RUNS
legacy_env TYCON_NO_DOWNLOAD_RUNS; legacy_env TYCON_NO_COLLECT_FINDINGS
if [[ "$CHECK_ONLY" != "1" ]] && command -v node >/dev/null 2>&1; then
  # el rescate y la recolección son de full; la subida y la bajada, de su integración (en los dos perfiles)
  [[ "${TYCON_NO_THREAD_RESCUE:-0}" != "1" && "$PROFILE_FULL" == "1" && -f "$TOKENS_DIGEST_JS" ]] && _RESCATAR=1
  # el buzón sólo con su llave prendida: sin la llave del buzón, ni subida ni bajada — y se ve en el resumen
  [[ "$TYCON_INTEG_MAILBOX" == "1" && "${TYCON_NO_UPLOAD_RUNS:-0}" != "1" && -f "$SUBIR_CORRIDAS_JS" ]] && _SUBIR=1
  [[ "$TYCON_INTEG_MAILBOX" == "1" && "${TYCON_NO_DOWNLOAD_RUNS:-0}" != "1" && -f "$BAJAR_CORRIDAS_JS" ]] && _BAJAR=1
  [[ "${TYCON_NO_COLLECT_FINDINGS:-0}" != "1" && "$PROFILE_FULL" == "1" && -f "$RECOLECTAR_JS" ]] && _RECOLECTAR=1
fi
# 🔴 Un agente de CI no es una máquina del equipo. Una prueba del banco nocturno que corre este instalador con el
#    HOME del agente de Azure haría que el agente subiera sus registros al buzón como si fuera una máquina. Dentro de
#    una corrida de Azure DevOps (TF_BUILD) la tanda no se lanza.
if [[ "${TF_BUILD:-}" =~ ^[Tt][Rr][Uu][Ee]$ ]] && [[ "$_RESCATAR" == "1" || "$_SUBIR" == "1" || "$_BAJAR" == "1" || "$_RECOLECTAR" == "1" ]]; then
  echo "tycon: dentro de una ejecución de Azure DevOps (TF_BUILD) — el rescate del hilo, la recolección de hallazgos y la subida/bajada de ejecuciones no se lanzan: un agente de CI no es una máquina del equipo" >&2
  _RESCATAR=0; _SUBIR=0; _BAJAR=0; _RECOLECTAR=0
fi
if [[ "$_RESCATAR" == "1" || "$_SUBIR" == "1" || "$_BAJAR" == "1" || "$_RECOLECTAR" == "1" ]] && ! mkdir -p "$HOME/.claude/.tycon-pipeline" 2>/dev/null; then
  # 🔴 Sin esa carpeta los registros no se pueden escribir y el fondo no dejaría rastro: se dice acá.
  echo "⚠ tycon: no se pudo crear $HOME/.claude/.tycon-pipeline — el rescate del hilo, la recolección de hallazgos y la subida/bajada de ejecuciones NO se lanzan en este arranque" >&2
  _RESCATAR=0; _SUBIR=0; _BAJAR=0; _RECOLECTAR=0
fi
if [[ "$_RESCATAR" == "1" || "$_SUBIR" == "1" || "$_BAJAR" == "1" || "$_RECOLECTAR" == "1" ]]; then
  # 🔴 La salida NO va a /dev/null: el barrido puede reportar corridas que no se pudieron escribir, y la
  # subida o la bajada pueden decir «no» con su motivo. Sin rastro, nadie se entera nunca.
  # Una sola tanda de fondo, en serie: el orden (barrido → recolección → subida → bajada) es parte del contrato
  # (la recolección va antes de la subida para que lo de hoy suba hoy).
  # 🔴 La subida y la bajada AGREGAN a su registro (con tope: pasado ~512 KB el viejo se mueve a .1). Con `>` la
  #    segunda sesión del día borraría el aviso de vencimiento de la llave, que sale una sola vez por día.
  #    El barrido sigue con `>`: su registro es el estado de este arranque, no un historial.
  # (este bash nuevo no ve la función `node` del instalador: el Node del arnés le llega como argumento, `${11}`)
  nohup bash -c '
    N="${11:-node}"
    rotar() { [ -f "$1" ] && [ "$(wc -c < "$1" | tr -d " ")" -gt 524288 ] && mv -f "$1" "$1.1"; return 0; }
    # los registros con nombre viejo (story 8.9, D2): copiados antes de abrirlos. Si alguno no se puede llevar, los otros se
    # llevan igual y la falla queda en hook-errors.log (el registro nuevo de ése nace sin la historia del viejo, que sigue ahí)
    if [ -f "${10}" ]; then
      _err=$("$N" "${10}" --prepare-state "$4/thread-rescue.log" "$4/collect-findings.log" "$4/upload-runs.log" "$4/download-runs.log" --where scripts/install-tycon-hooks.sh 2>&1 > /dev/null < /dev/null) \
        || printf "[%s] install-tycon-hooks --prepare-state: %s\n\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${_err:-salió con error y sin mensaje}" >> "$4/hook-errors.log"
    fi
    if [ "$1" = 1 ]; then "$N" "$2" --pending --budget-ms 45000 > "$4/thread-rescue.log" 2>&1; fi
    if [ "$8" = 1 ]; then rotar "$4/collect-findings.log"; "$N" "$9" --budget-ms 60000 >> "$4/collect-findings.log" 2>&1 < /dev/null; fi
    if [ "$5" = 1 ]; then rotar "$4/upload-runs.log"; "$N" "$3" --budget-ms 90000 >> "$4/upload-runs.log" 2>&1; fi
    if [ "$6" = 1 ]; then rotar "$4/download-runs.log"; "$N" "$7" --budget-ms 120000 >> "$4/download-runs.log" 2>&1 < /dev/null; fi
  ' _ "$_RESCATAR" "$TOKENS_DIGEST_JS" "$SUBIR_CORRIDAS_JS" "$HOME/.claude/.tycon-pipeline" "$_SUBIR" "$_BAJAR" "$BAJAR_CORRIDAS_JS" \
    "$_RECOLECTAR" "$RECOLECTAR_JS" "$LEGACY_NAMES_JS" "$HNODE" \
    >/dev/null 2>&1 &
fi

# ============================================================
# Hook de git PRE-COMMIT global.
#
# 🔴 Por qué el instalador tiene que meterse con esto: varias guías documentan el
# patrón "el repo referencia su linter desde `.githooks/pre-commit`" — el lint de
# frontmatter de stories, el de la wiki, el `check.js` de paridad. **Ninguno corría.**
# Con `core.hooksPath` seteado a nivel global (como está en las máquinas del equipo,
# porque el sync de engram lo necesita), git usa SÓLO ese directorio y **ignora los
# `.githooks/` de cada repo, en silencio**. Linters escritos, documentados, adoptados
# — y jamás ejecutados.
#
# El hook global versionado en este repo arregla eso DELEGANDO en el del repo antes
# de su propia tarea. Se instala con backup, y sólo si el destino difiere.
# Lanzado por harness.js (TYCON_HARNESS_SNAPSHOT_DIR puesta) no hay `.bak-<ts>` propio: la copia del
# mecanismo (scripts/setup/harness/snapshot.js) ya guardó pre-commit, post-commit y sus `.local` tal cual, ANTES de este
# aplicador. 🔴 SALVO el caso «hook ajeno + ya hay .local»: el ajeno no tiene otro lugar que su `.bak` (la copia del
# mecanismo rota tras 5 y se perdería con ella), así que ESE `.bak-<ts>` se hace siempre, también bajo harness.js, y el
# aviso lo dice como siempre. Los demás `.bak` de acá, no.
# Opt-out: TYCON_NO_GIT_HOOKS=1.
# ============================================================
GIT_HOOK_SRC="$SCRIPT_DIR/hooks/git-pre-commit-global.sh"
GIT_HOOKS_DIR="${TYCON_GIT_HOOKS_DIR:-$HOME/.git-hooks}"
# Sólo en full: fuera de full ni se instalan ni se mira el core.hooksPath de ningún repo; si estaban, los
# saca el cambio de perfil de harness.js (vuelve el propio desde su .local), o quedan como están.
if [[ "${TYCON_NO_GIT_HOOKS:-0}" != "1" && "$PROFILE_FULL" == "1" && -f "$GIT_HOOK_SRC" ]]; then
  GIT_HOOK_DST="$GIT_HOOKS_DIR/pre-commit"
  plan_copy git-hook "$GIT_HOOK_SRC" "$GIT_HOOK_DST" pre-commit
  if ! cmp -s "$GIT_HOOK_SRC" "$GIT_HOOK_DST" 2>/dev/null; then
    if [[ "$CHECK_ONLY" == "1" ]]; then
      echo "⚠ el pre-commit global de git está desactualizado (o falta): $GIT_HOOK_DST"
    else
      mkdir -p "$GIT_HOOKS_DIR"
      if [[ -f "$GIT_HOOK_DST" ]] && ! grep -q 'git-pre-commit-global.sh' "$GIT_HOOK_DST" 2>/dev/null; then
        # el pre-commit que el dev ya tenía no se pisa: queda como pre-commit.local y el nuestro lo invoca primero
        if [[ ! -e "$GIT_HOOKS_DIR/pre-commit.local" ]]; then
          mv "$GIT_HOOK_DST" "$GIT_HOOKS_DIR/pre-commit.local" && chmod +x "$GIT_HOOKS_DIR/pre-commit.local"
          echo "ℹ tu pre-commit global anterior sigue corriendo desde $GIT_HOOKS_DIR/pre-commit.local (lo invoca el nuestro primero; si rechaza, rechaza)"
        else
          # también bajo harness.js: es el único lugar donde el ajeno sobrevive (ver la cabecera del bloque)
          cp "$GIT_HOOK_DST" "$GIT_HOOK_DST.bak-$(date +%Y%m%d%H%M%S)"
          echo "⚠ había un pre-commit global ajeno y ya existe pre-commit.local: el ajeno quedó en .bak, revisalo"
        fi
      elif [[ -f "$GIT_HOOK_DST" && -z "${TYCON_HARNESS_SNAPSHOT_DIR:-}" ]]; then
        cp "$GIT_HOOK_DST" "$GIT_HOOK_DST.bak-$(date +%Y%m%d%H%M%S)"
      fi
      cp "$GIT_HOOK_SRC" "$GIT_HOOK_DST" && chmod +x "$GIT_HOOK_DST"
      echo "✓ pre-commit global de git actualizado ($GIT_HOOK_DST) — ahora delega en el .githooks/ de cada repo"
    fi
  fi
  if cmp -s "$GIT_HOOK_SRC" "$GIT_HOOK_DST" 2>/dev/null; then record git-hook "$GIT_HOOK_DST" pre-commit; fi
  # El hooksPath global es lo que hace que ese archivo se use. Si NO está seteado, el
  # hook no corre en ningún lado y el sync de engram tampoco: se avisa, no se fuerza
  # (tocar la config global de git de otro sin avisar es peor que el problema).
  # ── post-commit global: UNA línea con lo que quedó afuera del commit ──
  # Sin esto queda trabajo sin commitear y nadie lo dice; el commit siguiente tampoco.
  # Lo dispara git (no la herramienta), así que habla igual desde la terminal, VS Code, Claude o Codex.
  # Nunca frena; lo ignorado por git no cuenta; `.tycon/post-commit-ignore` excluye por repo.
  POST_HOOK_SRC="$SCRIPT_DIR/hooks/git-post-commit-global.sh"
  POST_HOOK_DST="$GIT_HOOKS_DIR/post-commit"
  [[ -f "$POST_HOOK_SRC" ]] && plan_copy git-hook "$POST_HOOK_SRC" "$POST_HOOK_DST" post-commit
  if [[ -f "$POST_HOOK_SRC" ]] && ! cmp -s "$POST_HOOK_SRC" "$POST_HOOK_DST" 2>/dev/null; then
    if [[ "$CHECK_ONLY" == "1" ]]; then
      echo "⚠ el post-commit global de git está desactualizado (o falta): $POST_HOOK_DST"
    else
      mkdir -p "$GIT_HOOKS_DIR"
      if [[ -f "$POST_HOOK_DST" ]] && ! grep -q 'git-post-commit-global.sh' "$POST_HOOK_DST" 2>/dev/null; then
        # el post-commit que el dev ya tenía no se pisa: queda como post-commit.local y el nuestro lo invoca primero
        if [[ ! -e "$GIT_HOOKS_DIR/post-commit.local" ]]; then
          mv "$POST_HOOK_DST" "$GIT_HOOKS_DIR/post-commit.local" && chmod +x "$GIT_HOOKS_DIR/post-commit.local"
          echo "ℹ tu post-commit global anterior sigue corriendo desde $GIT_HOOKS_DIR/post-commit.local (lo invoca el nuestro antes de su tarea)"
        else
          # también bajo harness.js (ver el pre-commit, arriba)
          cp "$POST_HOOK_DST" "$POST_HOOK_DST.bak-$(date +%Y%m%d%H%M%S)"
          echo "⚠ había un post-commit global ajeno y ya existe post-commit.local: el ajeno quedó en .bak, revisalo"
        fi
      elif [[ -f "$POST_HOOK_DST" && -z "${TYCON_HARNESS_SNAPSHOT_DIR:-}" ]]; then
        cp "$POST_HOOK_DST" "$POST_HOOK_DST.bak-$(date +%Y%m%d%H%M%S)"
      fi
      cp "$POST_HOOK_SRC" "$POST_HOOK_DST" && chmod +x "$POST_HOOK_DST"
      echo "✓ post-commit global de git instalado ($POST_HOOK_DST) — avisa en una línea lo que quedó afuera de cada commit"
    fi
  fi
  if [[ -f "$POST_HOOK_SRC" ]] && cmp -s "$POST_HOOK_SRC" "$POST_HOOK_DST" 2>/dev/null; then record git-hook "$POST_HOOK_DST" post-commit; fi
  # ── pre-push global: el freno antes de publicar ──────────────────────────────────
  # El arnés se mantiene en un repo público: una rama empujada ya es pública. El freno (scripts/hooks/public-push-guard.js)
  # tiene que correr en CUALQUIER clon, y con `core.hooksPath` global el `.githooks/pre-push` de un repo no lo llama nadie:
  # por eso va acá, con el pre-commit. Si el empuje no es del arnés no hace nada (un repo de producto empuja como siempre).
  # Mismas reglas que los otros dos: sólo si difiere; el pre-push que la persona ya tenía pasa a `pre-push.local` y el
  # nuestro lo corre primero, con la misma entrada (si rechaza, rechaza).
  PUSH_HOOK_SRC="$SCRIPT_DIR/hooks/git-pre-push-global.sh"
  PUSH_HOOK_DST="$GIT_HOOKS_DIR/pre-push"
  [[ -f "$PUSH_HOOK_SRC" ]] && plan_copy git-hook "$PUSH_HOOK_SRC" "$PUSH_HOOK_DST" pre-push
  if [[ -f "$PUSH_HOOK_SRC" ]] && ! cmp -s "$PUSH_HOOK_SRC" "$PUSH_HOOK_DST" 2>/dev/null; then
    if [[ "$CHECK_ONLY" == "1" ]]; then
      echo "⚠ el pre-push global de git está desactualizado (o falta): $PUSH_HOOK_DST"
    else
      mkdir -p "$GIT_HOOKS_DIR"
      # 🔴 Lo ajeno se conserva ANTES de copiar encima, y si no se pudo conservar NO se copia: si no, el instalador diría
      # «no pude conservar tu pre-push» y en la línea siguiente lo pisaría (con la carpeta sin permiso de escritura el
      # `mv` falla y el `cp` sobre el archivo que ya existe no).
      PUSH_KEPT=1
      if [[ -f "$PUSH_HOOK_DST" ]] && ! grep -q 'git-pre-push-global.sh' "$PUSH_HOOK_DST" 2>/dev/null; then
        # el pre-push que la persona ya tenía no se pisa: queda como pre-push.local y el nuestro lo invoca primero
        if [[ ! -e "$GIT_HOOKS_DIR/pre-push.local" ]]; then
          if mv "$PUSH_HOOK_DST" "$GIT_HOOKS_DIR/pre-push.local" 2>/dev/null; then
            chmod +x "$GIT_HOOKS_DIR/pre-push.local" 2>/dev/null \
              || echo "⚠ tu pre-push global anterior quedó en $GIT_HOOKS_DIR/pre-push.local SIN permiso de ejecución: no va a correr hasta que se lo des (chmod +x)"
            echo "ℹ tu pre-push global anterior sigue corriendo desde $GIT_HOOKS_DIR/pre-push.local (lo invoca el nuestro primero; si rechaza, rechaza)"
          else
            PUSH_KEPT=0
          fi
        else
          # también bajo harness.js (ver el pre-commit, arriba)
          if cp "$PUSH_HOOK_DST" "$PUSH_HOOK_DST.bak-$(date +%Y%m%d%H%M%S)" 2>/dev/null; then
            echo "⚠ había un pre-push global ajeno y ya existe pre-push.local: el ajeno quedó en .bak, revisalo"
          else
            PUSH_KEPT=0
          fi
        fi
      elif [[ -f "$PUSH_HOOK_DST" && -z "${TYCON_HARNESS_SNAPSHOT_DIR:-}" ]]; then
        cp "$PUSH_HOOK_DST" "$PUSH_HOOK_DST.bak-$(date +%Y%m%d%H%M%S)" 2>/dev/null || true   # la versión anterior del NUESTRO: perder esa copia no pierde nada de nadie
      fi
      # el «✓» sólo si de verdad quedó puesto: decir «instalado» con la copia fallida deja a la máquina creyendo que
      # tiene un freno que no tiene (`harness.js doctor` y `public-push-guard.js status` lo dirían, pero nadie los corre)
      # Se comprueba el RESULTADO (el archivo quedó igual al del arnés), no sólo que `cp` no se quejó: con una carpeta
      # en ese lugar `cp` copia ADENTRO y sale 0.
      if [[ "$PUSH_KEPT" != "1" ]]; then
        echo "✗ NO instalé el pre-push global de git: no pude conservar el tuyo ($PUSH_HOOK_DST sigue como estaba, no lo pisé). El freno antes de publicar NO está puesto en esta máquina: revisá los permisos de $GIT_HOOKS_DIR y volvé a correr el instalador"
      elif cp "$PUSH_HOOK_SRC" "$PUSH_HOOK_DST" 2>/dev/null && chmod +x "$PUSH_HOOK_DST" 2>/dev/null && [[ -f "$PUSH_HOOK_DST" ]] && cmp -s "$PUSH_HOOK_SRC" "$PUSH_HOOK_DST"; then
        echo "✓ pre-push global de git instalado ($PUSH_HOOK_DST) — el freno antes de publicar corre en cualquier clon del arnés"
      else
        echo "✗ NO pude instalar el pre-push global de git ($PUSH_HOOK_DST): el freno antes de publicar NO está puesto en esta máquina"
      fi
    fi
  elif [[ ! -f "$PUSH_HOOK_SRC" ]]; then
    :   # este arnés no trae el pre-push (una versión anterior): el que haya es de la persona, no se toca
  elif [[ -f "$PUSH_HOOK_DST" && ! -x "$PUSH_HOOK_DST" && "$CHECK_ONLY" != "1" ]]; then
    # el contenido es el nuestro y le falta el permiso de ejecución (restaurado de una copia, o copiado por otra
    # herramienta): git no lo corre, y por contenido se lo daría por instalado
    if chmod +x "$PUSH_HOOK_DST" 2>/dev/null; then echo "✓ pre-push global de git: le faltaba el permiso de ejecución ($PUSH_HOOK_DST) — ya lo tiene"
    else echo "✗ el pre-push global de git ($PUSH_HOOK_DST) no tiene permiso de ejecución y no se lo pude dar: el freno antes de publicar NO corre en esta máquina"; fi
  elif [[ -f "$PUSH_HOOK_DST" && ! -x "$PUSH_HOOK_DST" ]]; then
    echo "⚠ el pre-push global de git no tiene permiso de ejecución (git no lo corre): $PUSH_HOOK_DST"
  fi
  if [[ -f "$PUSH_HOOK_SRC" ]] && cmp -s "$PUSH_HOOK_SRC" "$PUSH_HOOK_DST" 2>/dev/null; then record git-hook "$PUSH_HOOK_DST" pre-push; fi
  # La carpeta GLOBAL de hooks de git, ¿es la que este instalador llena?
  # Los hooks de arriba —entre ellos el pre-push, el freno antes de publicar— corren sólo si git usa ESTA carpeta. Avisar
  # únicamente cuando git no tiene ninguna dejaría pasar el caso de OTRA (la de otra herramienta, una vieja): el
  # instalador llenaría la suya, no diría nada, y ningún hook del arnés correría sin que nadie lo supiera.
  # Cuatro respuestas además de «git no tiene ninguna», cada una con su texto:
  #   · es la del instalador                 → no se dice nada;
  #   · es otra                              → las dos rutas y el comando para apuntarla;
  #   · apunta a una carpeta que no existe   → su aviso (es otra, y además no está);
  #   · no se puede comparar                 → se dice por qué, con los dos valores: es relativa (`.githooks`: cada repo
  #                                            usa la suya, no hay una sola con qué comparar).
  # (Y si git no contesta, «no pude leer»: más abajo.)
  # Se juzga por lo que hay en el disco, no por cómo está escrita la ruta: el valor se lee con `--type=path` (git expande
  # `~`) y con `--includes` (con `--global` solo, git no sigue los archivos incluidos y diría «no tiene»), y las dos
  # carpetas se comparan con `-ef` (el mismo dispositivo y el mismo inodo; bash 3.2 lo trae y no trae `realpath`): un
  # enlace a la del instalador es LA MISMA, y también la misma carpeta escrita con otras mayúsculas en un disco que no
  # las distingue (`cd … && pwd -P` devuelve la ruta con las mayúsculas con que se la escribió, y la
  # daría por otra).
  # 🔴 Nunca la cambia, en ningún modo: esa clave es de la persona y puede ser de otra herramienta. Sólo avisa (también
  # con --check). Lo cuida scripts/tests/harness-install.test.sh (T79); el .ps1 lleva la misma regla.
  # «Git no contestó» no es «git no tiene»: `git config` sale 1 cuando la clave no está, y con OTRO código cuando falló
  # (128 con la configuración rota, 127 si git no está en el PATH). Leer los dos como «no tiene» afirmaría algo que no se
  # midió y mandaría a pisar la clave con el comando del aviso. Con otro código se dice «no pude leer», con el código y lo
  # que git dijo, y nada más. `|| X=$?` y no `; X=$?`: este archivo corre con `set -e`.
  GLOBAL_HOOKS_RC=0
  GLOBAL_HOOKS_RAW="$(git config --global --includes core.hooksPath 2>/dev/null)" || GLOBAL_HOOKS_RC=$?
  if [[ "$GLOBAL_HOOKS_RC" != 0 && "$GLOBAL_HOOKS_RC" != 1 ]]; then
    # lo que git dijo, en un renglón: la misma lectura otra vez, sólo por su texto (vuelve a fallar, a propósito)
    GLOBAL_HOOKS_WHY="$(git config --global --includes core.hooksPath 2>&1 >/dev/null)" || true
    GLOBAL_HOOKS_WHY="${GLOBAL_HOOKS_WHY%%$'\n'*}"
    echo "⚠ no pude leer la carpeta global de hooks de git (core.hooksPath global; git config salió ${GLOBAL_HOOKS_RC}): no sé si los hooks del arnés, incluido el freno antes de publicar, corren en esta máquina. Cuando git conteste, volvé a correr el instalador."
    [[ -z "$GLOBAL_HOOKS_WHY" ]] || echo "    git dijo:            ${GLOBAL_HOOKS_WHY}"
    echo "    el instalador llena: ${GIT_HOOKS_DIR}"
  elif [[ -z "$GLOBAL_HOOKS_RAW" ]]; then
    echo "⚠ git no tiene core.hooksPath global — los hooks del arnés NO corren. Activalo con:"
    echo "    git config --global core.hooksPath $GIT_HOOKS_DIR"
  else
    # cualquier fallo de ESTA lectura cae al valor crudo, que ya se leyó bien (un git anterior a 2.18 no conoce
    # `--type=path`): el valor tal cual, con el `~` expandido a mano
    GLOBAL_HOOKS="$(git config --global --includes --type=path core.hooksPath 2>/dev/null)" || GLOBAL_HOOKS=""
    if [[ -z "$GLOBAL_HOOKS" ]]; then
      GLOBAL_HOOKS="$GLOBAL_HOOKS_RAW"
      case "$GLOBAL_HOOKS" in "~") GLOBAL_HOOKS="$HOME" ;; "~/"*) GLOBAL_HOOKS="$HOME/${GLOBAL_HOOKS#\~/}" ;; esac
    fi
    GLOBAL_HOOKS_VERDICT=other
    if [[ "${GLOBAL_HOOKS%/}" == "${GIT_HOOKS_DIR%/}" ]]; then GLOBAL_HOOKS_VERDICT=same
    elif [[ "$GLOBAL_HOOKS" != /* ]]; then GLOBAL_HOOKS_VERDICT=relative
    elif [[ ! -d "$GLOBAL_HOOKS" ]]; then GLOBAL_HOOKS_VERDICT=missing
    elif [[ "$GLOBAL_HOOKS" -ef "$GIT_HOOKS_DIR" ]]; then GLOBAL_HOOKS_VERDICT=same
    fi
    case "$GLOBAL_HOOKS_VERDICT" in
      same)     GLOBAL_HOOKS_HEAD="" ;;
      missing)  GLOBAL_HOOKS_HEAD="⚠ el core.hooksPath global de git apunta a una carpeta que NO existe — los hooks del arnés, incluido el freno antes de publicar, NO corren. No lo cambio solo:" ;;
      relative) GLOBAL_HOOKS_HEAD="⚠ no pude comparar el core.hooksPath global de git con la carpeta que llena el instalador: es una ruta relativa (cada repo usa la suya, no hay una sola con qué comparar). Los hooks del arnés, incluido el freno antes de publicar, sólo corren si git usa la del instalador:" ;;
      *)        GLOBAL_HOOKS_HEAD="⚠ el core.hooksPath global de git apunta a OTRA carpeta, no a la que llena el instalador — los hooks del arnés, incluido el freno antes de publicar, NO corren. No lo cambio solo (puede ser de otra herramienta):" ;;
    esac
    if [[ -n "$GLOBAL_HOOKS_HEAD" ]]; then
      echo "$GLOBAL_HOOKS_HEAD"
      echo "    git usa:             ${GLOBAL_HOOKS}"
      echo "    el instalador llena: ${GIT_HOOKS_DIR}"
      echo "    para apuntarlo:      git config --global core.hooksPath \"${GIT_HOOKS_DIR}\""
    fi
  fi

  # Un core.hooksPath LOCAL eclipsa al global — y con eso a la delegación entera — sin error
  # ni aviso (por ejemplo, el pre-commit de un repo nace muerto por una config vestigial que apunta al .git/hooks
  # propio, solo con *.sample adentro).
  # Se destapa SOLO cuando es vestigial comprobado: apunta dentro del repo y no tiene ningún
  # hook real (solo samples). Cualquier otra cosa (husky, un dir con hooks de verdad) se
  # respeta y se avisa — el dev decide.
  #
  # «No tiene ningún hook real» se mira en el disco Y en lo que el repo sigue. Ejemplo: un clon viejo de agent-skills con
  # `core.hooksPath = .githooks` (el repo sigue esa carpeta, con un hook de verdad), re-apuntado al repo unido: la vista
  # reducida (sparse-checkout) esconde `.githooks/`. Mirar sólo el disco no alcanza: `find` falla sobre la carpeta que no
  # está y, con `set -e` y `pipefail`, el aplicador MORIRÍA en esta línea sin decir nada (salida 1: `harness.js update`
  # no podría aplicar ninguna versión mientras el clon siguiera re-apuntado); el gemelo de Windows la daría por
  # vestigial y borraría la clave. Son tres respuestas, no dos:
  #   · la carpeta está y se puede leer      → se cuentan sus hooks, como siempre;
  #   · la carpeta no está pero el repo la sigue con archivos que no son *.sample (la esconde la vista reducida, o se
  #     borró sin commitear)                 → NO es vestigial: se avisa y no se toca;
  #   · no se pudo mirar (la carpeta no se deja leer, o git no contestó: una ruta absoluta fuera del clon, por ejemplo)
  #                                          → tampoco se toca, y se dice.
  # Sólo lo que no está en el disco NI en el repo, o está con puros *.sample, es vestigial. Ninguna rama corta el
  # aplicador. Lo cuida scripts/tests/installer-repeated-hooks.test.sh (HOOKSPATH); el .ps1 lleva la misma regla.
  for repo in "$AGENT_SKILLS_REPO" "$(dirname "$SCRIPT_DIR")"; do
    [[ -d "$repo/.git" ]] || continue
    lhp="$(git -C "$repo" config --local core.hooksPath 2>/dev/null)" || true
    [[ -z "$lhp" ]] && continue
    case "$lhp" in /*) lhp_abs="$lhp";; *) lhp_abs="$repo/$lhp";; esac
    if [[ -d "$lhp_abs" ]]; then
      if ! _lhp_found="$(find "$lhp_abs" -maxdepth 1 -type f ! -name '*.sample' 2>&1)"; then
        echo "⚠ $repo tiene core.hooksPath LOCAL ($lhp) y no pude mirar qué hay en esa carpeta ($(printf '%s' "$_lhp_found" | tail -1)) — no lo toco."
        continue
      fi
      reales=0
      if [[ -n "$_lhp_found" ]]; then reales="$(printf '%s\n' "$_lhp_found" | wc -l | tr -d ' ')"; fi
    else
      # la carpeta no está en el disco: ¿el repo la sigue? Se le pregunta a git por esa ruta (relativa a la raíz del
      # clon, o absoluta: git la ubica solo; fuera del clon no contesta, y eso es «no pude mirar»). Cada línea es
      # `<letra> <ruta>`; `S` = el archivo está en el repo y la vista reducida lo esconde.
      reales=0
      if ! _lhp_tracked="$(git -C "$repo" ls-files -t -- ":(literal)$lhp" 2>&1)"; then
        echo "⚠ $repo tiene core.hooksPath LOCAL ($lhp), esa carpeta no está en el disco y no pude mirar si el repo la sigue ($(printf '%s' "$_lhp_tracked" | tail -1)) — no lo toco."
        continue
      fi
      _lhp_n=0; _lhp_view=0
      while IFS= read -r _lhp_line; do
        case "$_lhp_line" in ''|*.sample) continue ;; esac
        _lhp_n=$((_lhp_n + 1))
        if [[ "$_lhp_line" == S\ * ]]; then _lhp_view=1; fi
      done <<< "$_lhp_tracked"
      if [[ "$_lhp_n" -gt 0 ]]; then
        if [[ "$_lhp_view" == "1" ]]; then _lhp_why="la esconde la vista reducida (sparse-checkout) de un clon re-apuntado"; else _lhp_why="se borró del disco sin commitear"; fi
        echo "⚠ $repo tiene core.hooksPath LOCAL ($lhp): esa carpeta no está en el disco, pero el repo la sigue con $_lhp_n archivo(s) — $_lhp_why. No es vestigial: no lo toco."
        continue
      fi
    fi
    if [[ "$reales" == "0" ]]; then
      if [[ "$CHECK_ONLY" == "1" ]]; then
        echo "⚠ $repo tiene core.hooksPath LOCAL vestigial ($lhp) — eclipsa los hooks del arnés"
      else
        git -C "$repo" config --local --unset core.hooksPath
        echo "✓ $repo: core.hooksPath local vestigial removido — la delegación global vuelve a regir"
      fi
    else
      echo "⚠ $repo tiene core.hooksPath LOCAL con $reales hook(s) reales ($lhp) — los hooks del arnés NO corren ahí. Revisalo vos: no lo toco."
    fi
  done
fi


# ── la lista de proyectos de Azure DevOps para failed-query-notice.js ─────────────
# La segunda mirada del hook (--project inexistente) sólo habla si hay lista cacheada, y sin refresco automático la
# lista sólo existe donde el dev corrió --refresh a mano. Cada 7 días, en
# segundo plano (sale a la red: nunca bloquea el arranque), si hay `az`. Vencida a los 30 días el
# hook la ignora. Off: TYCON_NO_AZ_PROJECTS_REFRESH=1.
# Sólo con Azure DevOps prendida (ado.org configurada): afuera, con `az` instalado por otro motivo,
# el instalador no le pregunta a ninguna organización. La organización se le pasa: la del lector, no la de `az devops configure`.
if [[ "$TYCON_INTEG_ADO" == "1" && "${TYCON_NO_AZ_PROJECTS_REFRESH:-0}" != "1" && "$CHECK_ONLY" != "1" ]] && command -v az >/dev/null 2>&1; then
  AZ_CACHE="$HOME/.claude/.tycon-pipeline/az-projects.json"
  if [[ ! -f "$AZ_CACHE" ]] || [[ -n "$(find "$AZ_CACHE" -mtime +7 2>/dev/null)" ]]; then
    _ORG_REFRESCO="$(node "$SCRIPT_DIR/lib/tycon-config.js" get ado.org 2>/dev/null)" || _ORG_REFRESCO=""
    ( node "$SCRIPT_DIR/hooks/failed-query-notice.js" --refresh ${_ORG_REFRESCO:+--org "$_ORG_REFRESCO"} >/dev/null 2>&1 & ) 2>/dev/null
  fi
fi

# ── una línea con el estado de las ocho integraciones (la lee T9) ─────────────────────
if [[ "$INTEG_ESTADO" == "ok" ]]; then
  _PREND=""; _APAG=""
  # la herramienta de horas no es una de estas: se elige aparte (`integrations.timeTracking`) y va en su propia línea
  for _i in ado engram codegraph mailbox codex nightly telegram; do
    _var="TYCON_INTEG_$(printf '%s' "$_i" | tr '[:lower:]' '[:upper:]')"
    case "${!_var}" in
      0) _APAG="$_APAG $_i" ;;
      detect) _PREND="$_PREND $_i(detect)" ;;
      *) _PREND="$_PREND $_i" ;;
    esac
  done
  echo "tycon: integraciones — prendidas:${_PREND:- (ninguna)} · apagadas:${_APAG:- (ninguna)} — detalle: node $SCRIPT_DIR/lib/tycon-config.js explain"
  # la herramienta de horas elegida, de la misma respuesta del lector; un lector que no la dice, se dice
  if [[ -n "$TYCON_TIME_TOOL" ]]; then
    [[ "$TYCON_TIME_TOOL" == none ]] && echo "tycon: herramienta de horas: ninguna" || echo "tycon: herramienta de horas: $TYCON_TIME_TOOL"
  else
    echo "⚠ tycon: herramienta de horas: el lector de configuración no la dijo"
  fi
fi

# ── el reporte de piezas: el arreglo JSON, sin duplicados, escrito atómico ──────────────────────
# Si no se pudo escribir se dice por stderr y el instalador sale 0 igual (hizo su trabajo): quien lo llamó encuentra el
# archivo ausente y no funde nada.
if [[ -n "$REPORT_PIECES_TMP" ]]; then
  python3 - "$REPORT_PIECES_TMP" "$REPORT_JSON" <<'PY' || echo "⚠ tycon: no pude escribir el reporte de piezas en $REPORT_JSON" >&2
import json, os, sys, tempfile
src, dst = sys.argv[1], os.path.abspath(sys.argv[2])
seen, out = set(), []
with open(src, encoding="utf-8") as fh:
    for line in fh:
        parts = line.rstrip("\n").split("\t")
        # tres campos; un `setting`, cuatro: el 4º es su valor en JSON y va a `value`
        if len(parts) not in (3, 4) or not all(parts) or (len(parts) == 4) != (parts[0] == "setting"):
            continue
        piece = (parts[0], os.path.abspath(parts[1]), parts[2])
        if piece in seen:
            continue
        item = {"kind": piece[0], "where": piece[1], "id": piece[2]}
        if len(parts) == 4:
            try:
                item["value"] = json.loads(parts[3])
            except ValueError:
                continue
        seen.add(piece)
        out.append(item)
os.makedirs(os.path.dirname(dst), exist_ok=True)
fd, tmp = tempfile.mkstemp(prefix=".report-pieces.", dir=os.path.dirname(dst))
try:
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, dst)
except Exception:
    os.unlink(tmp)
    raise
PY
fi

# ── el plan: el arreglo JSON, sin repetidos, escrito atómico ─────────────────────────────────────
# A diferencia del reporte, si no se puede escribir el instalador sale 1: quien pidió el plan no puede instalar sin él.
if [[ -n "$PLAN_PIECES_TMP" && "$PLAN_INCOMPLETE" == "1" ]]; then
  echo "install-tycon-hooks.sh: el plan quedó incompleto (alguna pieza no se pudo anotar): no lo escribo" >&2
  exit 1
fi
if [[ -n "$PLAN_PIECES_TMP" ]]; then
  python3 - "$PLAN_PIECES_TMP" "$PLAN_JSON" <<'PY' || { echo "install-tycon-hooks.sh: no pude escribir el plan en $PLAN_JSON" >&2; exit 1; }
import json, os, sys, tempfile
src, dst = sys.argv[1], os.path.abspath(sys.argv[2])
seen, out = {}, []
with open(src, encoding="utf-8") as fh:
    for line in fh:
        parts = line.rstrip("\n").split("\t")
        if len(parts) != 4 or not all(parts) or parts[3] not in ("add", "update", "remove", "keep"):
            continue
        key = (parts[0], os.path.abspath(parts[1]), parts[2])
        if key in seen:
            # la misma pieza anotada dos veces: gana la acción que cambia algo
            if out[seen[key]]["action"] == "keep" and parts[3] != "keep":
                out[seen[key]]["action"] = parts[3]
            continue
        seen[key] = len(out)
        out.append({"kind": key[0], "where": key[1], "id": key[2], "action": parts[3]})
fd, tmp = tempfile.mkstemp(prefix=".plan-pieces.", dir=os.path.dirname(dst) or ".")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, dst)
except Exception:
    os.unlink(tmp)
    raise
PY
fi

exit 0
