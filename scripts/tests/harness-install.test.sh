#!/usr/bin/env bash
# harness-install.test.sh — `harness.js install`, `install --from-existing` desde el aplicador, y `link` (story 8.13,
# tanda A · T5, T9, T11).
#
# Lo que no se puede perder:
#   T5  · `install` desde un clon en cualquier carpeta deja: el enlace, el estado `managed` con DOS fuentes (o una si la raíz
#         trae `skills/` y `agents/`), la copia fija de arranque con su sha256, la línea de arranque nueva (`async`), el
#         `@import` una sola vez, y corre el aplicador con el candado ya tomado. Una segunda corrida no cambia nada y lo
#         dice. Sin agent-skills, sin `python3` o sin `git` sale 1 con UNA línea que nombra lo que falta y el HOME queda
#         idéntico por hash (ni enlace, ni estado, ni settings.json, ni CLAUDE.md): se comprueba ANTES de escribir.
#   T9  · el aplicador REAL (`scripts/install-tycon-hooks.sh`), al terminar su escritura de settings.json y al ver que no
#         hay estado, corre `harness.js install --from-existing`: estado `managed` con dos fuentes sobre el clon, el enlace y
#         el agent-skills que ya están; settings.json termina con la línea nueva Y todos los hooks; sin candado propio ni
#         aplicador anidado. Con `--check` o `TYCON_NO_AUTOINSTALL=1` no se llama. Un clon en otra rama o con commit propio
#         queda `managed` igual y `update` no toca nada y avisa.
#   T11 · `link --local` rechaza una ruta temporal salvo `--allow-temporary`; en `developer` ni `startup` ni `update` tocan
#         el git del clon (hash de `.git` igual) y el aplicador corre desde ese clon; `link --managed` vuelve sobre
#         `tree_before`. (La vuelta SOLA a managed cuando el árbol desaparece la prueba harness-bootstrap.test.sh.)
#
# Laboratorio: scripts/tests/lib/harness-lab.sh (HOME de juguete, dos remotos bare, arnés y agent-skills de juguete con el
# aplicador de mentira; harness.js y scripts/lib REALES). Nunca ~/.claude, nunca el checkout real, nunca launchd real.
# 🔴 Sin pipes sobre el comando medido: el exit code REAL es el veredicto.
#
#   T36 · (tanda D, AC 28) las tres piezas compartidas —cleanupPeriodDays, la variable de env y los comandos de barra— las
#         hace `harness.js` antes de lanzar el aplicador, con `TYCON_HARNESS_SHARED_DONE=1` para que él las saltee, y las
#         anota en `managed`: `install` y `apply` las dejan, `apply` las repone, `uninstall --yes` las quita, un `rollback`
#         ni las quita ni las duplica (tampoco con un aplicador viejo, que las reporta), `install --from-existing` no las
#         hace, y sin settings.json corre primero el aplicador (su esqueleto trae `"$schema"`).
#
#   T29 · (story 8.18, AC 28) la máquina del equipo en la TRANSICIÓN: el clon del arnés empieza a traer skills/, agents/ y
#         packs/ y el aplicador real, en cada arranque y con --check, dice lo mismo que antes, no mueve nada y no registra
#         piezas nuevas; `doctor` lo dice una vez; una carpeta real que no es un clon de agent-skills sigue avisando.
#   T30 · (story 8.18, AC 29) settings.json y ~/.codex/hooks.json quedan iguales, por nombre y por valor, antes y después;
#         los hooks de la ruta fija ~/.claude/agent-skills y los enlaces de ~/.codex/skills, intactos.
#         Las dos usan `harness_lab_team_machine … real` (el árbol de trabajo de verdad, historia de juguete unida).
#   CANARY · (story 8.18, AC 12: la parte del instalador de T11) las seis suites rápidas que el aplicador corre en cada
#         arranque salen de donde diga la regla de `scripts/lib/skills-dir.js` (la variable › el propio clon si es unido ›
#         lo instalado): con una de ellas ROTA sólo en un clon de trabajo y un agent-skills instalado verde, el aplicador
#         de ese clon da rojo y la línea dice de qué raíz salió. Y el espejo: lo que ESCRIBE (los hooks de settings.json)
#         sigue nombrando lo instalado, también con `TYCON_SKILLS_DIR` puesta. Sin skills en ningún lado, sale 1 como hoy.
#   LAB · (story 8.18) el propio laboratorio de la máquina del equipo, en sus dos variantes: historia unida de verdad, la
#         forma de la máquina, el corte y el retorno. Lo usan T29, T30 y las pruebas de la llave.
#   T37 · (story 8.18, AC 36) la máquina NUEVA: una HOME vacía, UN clon del repo unido y `harness.js install` → una
#         fuente, los cuatro enlaces, las skills de terceros restituidas desde la historia local (sin red), `doctor` sin
#         rojos y ningún hook registrado dos veces, se llame al aplicador por la carpeta del clon o por el enlace
#         `~/.claude/tycon-claude-guides` (en los dos órdenes). Un clon sin `skills/` y sin agent-skills: sale 1 con una
#         línea y no escribe nada. Usa el árbol de trabajo de verdad con la HISTORIA de verdad (un clon `--shared` del
#         repo bajo prueba): las skills de terceros salen de ahí. En un clon recortado esa parte sale NO MEDIDO.
#   T39 · (story 8.18, AC 36) los papeles del alta, por su texto: `INSTALL.md` y `onboarding/` piden clonar UN repo y
#         correr el instalador; ninguna línea manda clonar agent-skills ni crear un enlace a mano.
#
#   S16 · (story 8.16, tanda A · AC 8 y 9) el cierre de `install`: qué quedó contado por tipo desde el reporte del
#         aplicador (y cuántos hooks pueden frenar, según `scripts/setup/install-effects.json`), cada línea de aviso del
#         aplicador tal cual, dónde quedó la copia de respaldo y cómo volver, el registro y tres líneas de «qué sigue». La
#         segunda corrida dice «sin cambios» y repite la copia de antes de instalar. Si el aplicador o la salud fallan:
#         «quedó a medias», el registro, la copia y las dos salidas, sin «qué sigue». `startup` sigue en una línea.
#
#   T79 · (story 8.26, tanda H1c · AC 65 e) el aviso de la carpeta GLOBAL de hooks de git, con el aplicador real: calla
#         si es la que el instalador llena (también por un enlace, con `~` o desde un archivo incluido), avisa con las dos
#         rutas y el comando si es otra, tiene su aviso si no existe, dice «no pude comparar» si es relativa, y nunca
#         cambia la configuración de git.
#
#   HP  · (2026-10-14) la carpeta GLOBAL de hooks de git la pone `harness.js`, no sólo la avisa: el caso de una máquina
#         instalada desde la versión bajada o mudada desde un clon, con los hooks del arnés en ~/.git-hooks y git sin
#         carpeta global — `doctor` mandaba a `apply` y el aviso seguía igual. Con el aplicador real: `install` y `apply`
#         la ponen si git no tiene ninguna (y `doctor` deja de avisar); el arranque no; otra carpeta, el interruptor de los
#         hooks de git y un git que no deja escribir no se pisan; el perfil mínimo y `uninstall` la sacan sólo si sigue
#         siendo la que puso el arnés.
#
# Uso: bash scripts/tests/harness-install.test.sh [--only T5|T9|T11|T12|T36|LAB|T29|T30|CANARY|T37|T39|S16|S16B|REG|RELOCATE|T79|HP]
#   S16B · (story 8.16, tanda B · AC 44, T27) fuera de `install`, nada pregunta nada nuevo: el aplicador suelto,
#         `startup`, `apply`, `rollback` y `uninstall` sin terminal hacen lo de siempre. Desde la tanda B toda llamada a
#         `install` sin terminal de esta suite pasa `--yes` escrita acá (el ayudante `harness` no lo agrega solo).
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
ONLY=""; [ "${1:-}" = "--only" ] && ONLY="${2:-}"
# los dos nombres del lugar del arnés (story 8.19), de su constante
PLACE_NAME="$(node -e 'process.stdout.write(require(process.argv[1]).PLACE_NAME)' "$RAIZ/scripts/setup/harness/place.js")"
LEGACY_PLACE_NAME="$(node -e 'process.stdout.write(require(process.argv[1]).LEGACY_PLACE_NAME)' "$RAIZ/scripts/setup/harness/place.js")"
corre() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
# bajo $TMPDIR también en Mac (su mktemp -d sin plantilla lo ignora): con TMPDIR=/tmp se reproduce el agente de la CI
ORIG_TMPDIR="${TMPDIR:-/tmp}"   # el laboratorio cambia TMPDIR: T11 compara contra el de la máquina
BASE="$(mktemp -d "${TMPDIR:-/tmp}/harness-install.XXXXXX")"
case "$BASE" in *tycon-claude-guides*|*agent-skills*|*/.claude*) echo "❌ harness-install: el laboratorio cayó en ${BASE}"; exit 1 ;; esac
PERSISTENT=""   # T11: la carpeta del clon propio cuando el laboratorio cae bajo /tmp (ver T11)
trap 'rm -rf "$BASE" ${PERSISTENT:+"$PERSISTENT"}' EXIT
ORIG_PATH="$PATH"

# lecturas del estado y de settings.json con python (sin jq): j <archivo> <expresión sobre d>
j() { python3 -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print($2)" "$1" 2>/dev/null; }
estado() { j "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json" "$1"; }
settings() { j "$TYCON_SETTINGS_PATH" "$1"; }
sha_de() { shasum -a 256 < "$1" | cut -d' ' -f1; }
# un PATH mínimo: sólo lo que se nombra (enlaces en una carpeta propia), para simular «sin python3» / «sin git»
path_con() { # path_con <carpeta> <cmd…>
  local d="$1"; shift; mkdir -p "$d"
  for c in "$@"; do ln -sf "$(PATH="$ORIG_PATH" command -v "$c")" "$d/$c"; done
  # lo que bash y node necesitan para arrancar (sin esto el error no sería «falta X» sino un shell roto)
  for c in sh env dirname basename cat mkdir rm cp ls readlink uname sed grep shasum find sort cut date sleep; do
    local p; p="$(PATH="$ORIG_PATH" command -v "$c" 2>/dev/null)" && ln -sf "$p" "$d/$c"
  done
  printf '%s' "$d"
}

# ═══ T5 · Harness_Install_LinkStateBootstrapLineImportApplier_Idempotent ═════════════════════════════════════════════
if corre T5; then
  harness_lab_create "$BASE/t5" >/dev/null
  SALIDA="$(harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "T5 install sale 0" || mal "T5 install salió $RC: $SALIDA"
  # story 8.19: el lugar ~/.claude/tycon-harness apunta al clon; desde la tanda C una máquina nueva no recibe el nombre viejo
  ENLACE="$LAB_HOME/.claude/$PLACE_NAME"; VIEJO="$LAB_HOME/.claude/$LEGACY_PLACE_NAME"
  [ -L "$ENLACE" ] && [ "$(cd "$ENLACE" && pwd -P)" = "$(cd "$LAB_TREE" && pwd -P)" ] && ok "T5 el lugar apunta al clon" || mal "T5 el lugar no apunta al clon: $(readlink "$ENLACE" 2>&1)"
  [ ! -e "$VIEJO" ] && [ ! -L "$VIEJO" ] && ok "T5 una máquina nueva no recibe el nombre viejo (tanda C)" || mal "T5 el nombre viejo apareció en una máquina nueva: $(readlink "$VIEJO" 2>&1)"
  [ "$(estado "d['schema']")" = 1 ] && [ "$(estado "d['mode']")" = managed ] && ok "T5 estado schema 1, mode managed" || mal "T5 estado: schema=$(estado "d['schema']") mode=$(estado "d['mode']")"
  [ "$(estado "len(d['sources'])")" = 2 ] && [ "$(estado "','.join(s['name'] for s in d['sources'])")" = "harness,agent_skills" ] && ok "T5 dos fuentes: harness y agent_skills" || mal "T5 fuentes: $(estado "d['sources']")"
  [ "$(estado "d['sources'][0]['url']")" = "$LAB_REMOTE_TREE" ] && [ "$(estado "d['sources'][1]['url']")" = "$LAB_REMOTE_SKILLS" ] && ok "T5 las url son los remotos" || mal "T5 url: $(estado "[s['url'] for s in d['sources']]")"
  [ "$(estado "d['sources'][0]['commit']")" = "$(harness_lab_git "$LAB_TREE" rev-parse HEAD)" ] && ok "T5 commit de la fuente = HEAD del clon" || mal "T5 commit: $(estado "d['sources'][0]['commit']")"
  [ "$(estado "d['version']['number']")" != "" ] && [ "$(estado "d['channel']")" != "" ] && ok "T5 versión derivada y canal en el estado ($(estado "d['version']['number']") · $(estado "d['channel']"))" || mal "T5 sin versión o canal: $(estado "d['version']") $(estado "d['channel']")"
  COPIA="$LAB_HOME/.claude/.tycon-pipeline/harness"
  if [ -f "$COPIA/bootstrap.js" ] && [ -f "$COPIA/bootstrap-fallback.sh" ] && [ -f "$COPIA/bootstrap-fallback.ps1" ]; then
    [ "$(estado "d['bootstrap']['sha256']['bootstrap.js']")" = "$(sha_de "$COPIA/bootstrap.js")" ] && ok "T5 copia fija de arranque con su sha256 en el estado" || mal "T5 el sha256 de bootstrap.js no coincide con el estado"
  else mal "T5 falta la copia fija en $COPIA: $(ls "$COPIA" 2>&1)"; fi
  LINEA="$(harness_lab_settings_commands | grep -c '\.tycon-pipeline/harness/bootstrap\.js')"
  [ "$LINEA" = 1 ] && ok "T5 la línea de arranque nueva, una sola" || mal "T5 líneas con bootstrap.js: $LINEA"
  [ "$(settings "[c.get('async') for h in d['hooks']['SessionStart'] for c in h['hooks'] if 'bootstrap.js' in c['command']][0]")" = True ] && ok "T5 la línea es async" || mal "T5 la línea no es async"
  [ "$(grep -c "^@~/.claude/$PLACE_NAME/INDEX.md\$" "$CLAUDE_MD_PATH")" = 1 ] && ok "T5 el @import del índice (INDEX.md) en CLAUDE.md, una vez (por el lugar)" || mal "T5 @import: $(grep -c "$PLACE_NAME/INDEX.md" "$CLAUDE_MD_PATH") veces"
  grep -q 'lock_held=1' "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log" 2>/dev/null && ok "T5 el aplicador corrió con el candado del padre (TYCON_HARNESS_LOCK_HELD=1)" || mal "T5 el aplicador no corrió con lock_held=1: $(cat "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log" 2>&1)"
  harness_lab_settings_commands | grep -q 'lab-hook.js' && ok "T5 el aplicador registró su hook" || mal "T5 el hook del aplicador no está en settings.json"
  case "$SALIDA" in *managed*) ok "T5 la salida dice versión, canal, política y modo" ;; *) mal "T5 la salida no dice el modo: $SALIDA" ;; esac
  # segunda corrida: nada cambia (estado, settings, CLAUDE.md, copia fija) y lo dice
  H1="$(sha_de "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json")$(sha_de "$TYCON_SETTINGS_PATH")$(sha_de "$CLAUDE_MD_PATH")$(sha_de "$COPIA/bootstrap.js")"
  SALIDA2="$(harness install --yes 2>&1)"; RC2=$?
  H2="$(sha_de "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json")$(sha_de "$TYCON_SETTINGS_PATH")$(sha_de "$CLAUDE_MD_PATH")$(sha_de "$COPIA/bootstrap.js")"
  [ "$RC2" = 0 ] && [ "$H1" = "$H2" ] && ok "T5 la segunda corrida no cambia nada" || mal "T5 la segunda corrida cambió algo (rc $RC2)"
  case "$SALIDA2" in *"sin cambios"*) ok "T5 …y lo dice" ;; *) mal "T5 la segunda corrida no dice «sin cambios»: $SALIDA2" ;; esac

  # una fuente: la raíz del clon trae skills/ y agents/ y no hay ~/.claude/agent-skills aparte
  harness_lab_create "$BASE/t5b" >/dev/null
  rm -rf "$LAB_SKILLS"; mkdir -p "$LAB_TREE/skills/tycon-pipeline" "$LAB_TREE/agents"; : > "$LAB_TREE/skills/tycon-pipeline/SKILL.md"
  SALIDA="$(harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado "len(d['sources'])")" = 1 ] && [ "$(estado "d['sources'][0]['name']")" = harness ] && ok "T5 raíz con skills/ y agents/: una sola fuente" || mal "T5 una fuente: rc $RC, fuentes $(estado "d['sources']") — $SALIDA"

  # sin agent-skills: 1, una línea, y el HOME idéntico por hash
  harness_lab_create "$BASE/t5c" >/dev/null
  rm -rf "$LAB_SKILLS"
  ANTES="$(harness_lab_home_hash)"
  SALIDA="$(harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 1 ] && ok "T5 sin agent-skills sale 1" || mal "T5 sin agent-skills salió $RC: $SALIDA"
  [ "$(printf '%s\n' "$SALIDA" | grep -c .)" = 1 ] && case "$SALIDA" in *agent-skills*) ok "T5 …con UNA línea que nombra agent-skills" ;; *) mal "T5 la línea no nombra agent-skills: $SALIDA" ;; esac || mal "T5 más de una línea: $SALIDA"
  [ "$(harness_lab_home_hash)" = "$ANTES" ] && ok "T5 …y el HOME quedó idéntico (nada se escribió)" || mal "T5 sin agent-skills escribió algo en el HOME"

  # sin python3, y aparte sin git: 1, la línea nombra lo que falta, HOME idéntico
  for falta in python3 git; do
    harness_lab_create "$BASE/t5-sin-$falta" >/dev/null
    case "$falta" in python3) P="$(path_con "$BASE/bin-sin-$falta" node bash git)" ;; git) P="$(path_con "$BASE/bin-sin-$falta" node bash python3)" ;; esac
    ANTES="$(harness_lab_home_hash)"
    SALIDA="$(PATH="$P" harness install --yes 2>&1)"; RC=$?
    [ "$RC" = 1 ] && case "$SALIDA" in *"$falta"*) ok "T5 sin $falta: 1 y la línea lo nombra" ;; *) mal "T5 sin $falta: la línea no lo nombra: $SALIDA" ;; esac || mal "T5 sin $falta salió $RC: $SALIDA"
    [ "$(harness_lab_home_hash)" = "$ANTES" ] && ok "T5 sin $falta: HOME idéntico" || mal "T5 sin $falta: escribió algo en el HOME"
  done
fi

# ═══ T12 · Writers_EitherImportPresent_LinkPiecesOnlyForLinks (story 8.19, AC 11) ════════════════════════════════════
# Los que ESCRIBEN no duplican: `install` da por presente la línea `@…/README.md` escrita con CUALQUIERA de los dos
# nombres del lugar, y la pieza `link` se anota sólo por un nombre que ES un enlace (una carpeta real en el lugar —quien
# clonó ahí— no es pieza). La tercera ruta del aplicador (por el lugar: `added: 0`) está en T37.
if corre T12; then
  T12_N=0
  for line_name in "$LEGACY_PLACE_NAME" "$PLACE_NAME"; do
    T12_N=$((T12_N + 1)); harness_lab_create "$BASE/t12-line-$T12_N" >/dev/null || { mal "T12 no pude armar el laboratorio"; continue; }
    mkdir -p "$(dirname "$CLAUDE_MD_PATH")"; printf '# mío\n@~/.claude/%s/README.md\n' "$line_name" > "$CLAUDE_MD_PATH"
    SALIDA="$(harness install --yes 2>&1)"; RC=$?
    N="$(grep -c -E "^@~/.claude/($PLACE_NAME|$LEGACY_PLACE_NAME)/(README|INDEX).md\$" "$CLAUDE_MD_PATH")"
    [ "$RC" = 0 ] && [ "$N" = 1 ] && grep -q "^@~/.claude/$line_name/INDEX.md\$" "$CLAUDE_MD_PATH" \
      && ok "T12 install con la línea por «${line_name}» ya escrita: queda UNA línea, con el mismo nombre y apuntando al índice (INDEX.md)" || mal "T12 con la línea por «${line_name}»: rc $RC, $N líneas — $(cat "$CLAUDE_MD_PATH" | tr '\n' ' ')"
  done
  # la pieza `link`: por cada nombre que ES un enlace; una carpeta real en el lugar no es pieza
  harness_lab_create "$BASE/t12-pieces" >/dev/null
  mkdir -p "$LAB_HOME/.claude/$PLACE_NAME/scripts"; : > "$LAB_HOME/.claude/$PLACE_NAME/scripts/install-tycon-hooks.sh"
  ln -s "$LAB_HOME/.claude/$PLACE_NAME" "$LAB_HOME/.claude/$LEGACY_PLACE_NAME"
  PIEZAS="$(node "$RAIZ/scripts/lib/canonical-path.js" --place-pieces --home "$LAB_HOME")"
  [ "$PIEZAS" = "$(printf 'link\t%s\t%s' "$LAB_HOME/.claude/$LEGACY_PLACE_NAME" "$LEGACY_PLACE_NAME")" ] \
    && ok "T12 con el lugar como carpeta real: sin pieza link para él; el viejo (un enlace) sí" || mal "T12 piezas: «${PIEZAS}»"
  rm "$LAB_HOME/.claude/$LEGACY_PLACE_NAME"; rm -r "$LAB_HOME/.claude/$PLACE_NAME"
  ln -s "$LAB_TREE" "$LAB_HOME/.claude/$PLACE_NAME"; ln -s "$LAB_HOME/.claude/$PLACE_NAME" "$LAB_HOME/.claude/$LEGACY_PLACE_NAME"
  PIEZAS="$(node "$RAIZ/scripts/lib/canonical-path.js" --place-pieces --home "$LAB_HOME" | cut -f3 | tr '\n' ',')"
  [ "$PIEZAS" = "$PLACE_NAME,$LEGACY_PLACE_NAME," ] && ok "T12 los dos nombres como enlaces: dos piezas link (ids $PLACE_NAME y $LEGACY_PLACE_NAME)" || mal "T12 piezas con los dos enlaces: «${PIEZAS}»"
  # (segunda vuelta, C4) `install` explícito fija el árbol: el lugar nace hacia el clon que se instala, no hacia el árbol
  # viejo del estado (si no, el estado decía un árbol y el lugar otro, y doctor quedaba en rojo)
  harness_lab_create "$BASE/t12-install-tree" >/dev/null
  harness install --yes >/dev/null 2>&1
  OTHER="$BASE/t12-otro-arbol"; mkdir -p "$OTHER/scripts"; : > "$OTHER/scripts/install-tycon-hooks.sh"
  node -e 'const fs=require("fs");const f=process.argv[1];const s=JSON.parse(fs.readFileSync(f,"utf8"));s.tree=process.argv[2];fs.writeFileSync(f,JSON.stringify(s,null,2))' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json" "$OTHER"
  rm -f "$LAB_HOME/.claude/$LEGACY_PLACE_NAME" "$LAB_HOME/.claude/$PLACE_NAME"
  SALIDA="$(harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(cd "$LAB_HOME/.claude/$PLACE_NAME" 2>/dev/null && pwd -P)" = "$(cd "$LAB_TREE" && pwd -P)" ] && [ "$(estado "d['tree']")" = "$(cd "$LAB_TREE" && pwd -P)" ] \
    && ok "T12 install con el estado en otro árbol: el lugar nace hacia el clon que se instala, igual que el estado" \
    || mal "T12 install con el estado en otro árbol (rc $RC): lugar → $(cd "$LAB_HOME/.claude/$PLACE_NAME" 2>/dev/null && pwd -P), estado → $(estado "d['tree']")"
  # y la lista declarada de piezas trae las dos
  for id in "$PLACE_NAME" "$LEGACY_PLACE_NAME"; do
    node -e 'const f=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(f.pieces.some((p)=>p.kind==="link"&&p.id===process.argv[2])?0:1)' "$RAIZ/scripts/tests/fixtures/harness-managed-pieces.json" "$id" \
      && ok "T12 harness-managed-pieces.json declara la pieza link «${id}»" || mal "T12 harness-managed-pieces.json no declara la pieza link «${id}»"
  done
fi

# ═══ T9 · Harness_FromExisting_AfterApplierWrite_NoLockNoNestedApplier ════════════════════════════════════════════════
if corre T9; then
  harness_lab_create "$BASE/t9" >/dev/null
  # el clon «existente» de un dev: una copia compartida del repo bajo prueba, en main, sin commits propios, con los archivos
  # de trabajo de esta tanda encima (harness.js y compañía todavía no están commiteados)
  DEV="$BASE/t9/clones/dev"
  # el «origin» de esos clones es una copia propia de la prueba con `main` y una rama de trabajo EXPLÍCITAS: no depende de
  # las ramas del repo que corre la prueba (el agente de la CI lo baja con HEAD suelto y sin `main` local, y ahí T9 daba
  # «couldn't find remote ref refs/heads/main» y «(sin rama)» — CI de main 11561 y 11565, 2026-10-02)
  T9_ORIGIN="$BASE/t9-origin"; T9_RAMA="lab-work"
  harness_lab_git "$BASE" clone -q --shared "$RAIZ" "$T9_ORIGIN" >/dev/null 2>&1
  harness_lab_git "$T9_ORIGIN" checkout -q -B main >/dev/null 2>&1
  harness_lab_git "$T9_ORIGIN" branch -q -f "$T9_RAMA" main >/dev/null 2>&1
  arma_dev() { # arma_dev <dir> <rama>
    rm -rf "$1"; harness_lab_git "$(dirname "$1")" clone -q --shared "$T9_ORIGIN" "$1" >/dev/null 2>&1
    harness_lab_git "$1" checkout -q -B "$2" >/dev/null 2>&1
    for p in scripts/setup scripts/lib scripts/hooks scripts/install-tycon-hooks.sh scripts/install-tycon-hooks.ps1 scripts/publishing; do
      rm -rf "$1/$p"; cp -R "$RAIZ/$p" "$1/$p"
    done
  }
  arma_dev "$DEV" main
  rm -f "$LAB_HOME/.claude/tycon-claude-guides"; ln -s "$DEV" "$LAB_HOME/.claude/tycon-claude-guides"
  harness_lab_old_line canonical
  # el aplicador REAL, con todo lo que sale a la red o a la máquina apagado (patrón de installer-cleanup-period.test.sh)
  AISLADO=(env TYCON_NO_CANONICAL_PATH=1 TYCON_NO_AZ_PROJECTS_REFRESH=1 TYCON_NO_BOOTSTRAP_HEAL=1 TYCON_NO_CLAUDEMD_SYNC=1
    TYCON_NO_COMMANDS_SYNC=1 TYCON_NO_ENGRAM_PROJECT_CHECK=1 TYCON_NO_ENGRAM_VERSION_CHECK=1 TYCON_NO_GIT_HOOKS=1
    TYCON_NO_SQLITE_CHECK=1 TYCON_NO_AGENTSMD_POINTER=1 TYCON_NO_THREAD_RESCUE=1 TYCON_NO_UPLOAD_RUNS=1 TYCON_NO_DOWNLOAD_RUNS=1
    TYCON_NO_COLLECT_FINDINGS=1 TYCON_MAILBOX_URL_BASE=http://127.0.0.1:9 TYCON_THIRD_PARTY=0)
  aplicador() { "${AISLADO[@]}" "$@" bash "$DEV/scripts/install-tycon-hooks.sh"; }
  SALIDA="$(aplicador 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "T9 el aplicador real sale 0" || mal "T9 el aplicador real salió $RC: $(printf '%s' "$SALIDA" | tail -5)"
  [ -f "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json" ] && ok "T9 el aplicador creó el estado (--from-existing)" || mal "T9 no hay estado tras el aplicador: $(printf '%s' "$SALIDA" | tail -5)"
  [ "$(estado "d['mode']")" = managed ] && [ "$(estado "len(d['sources'])")" = 2 ] && ok "T9 managed con dos fuentes" || mal "T9 estado: mode=$(estado "d['mode']") fuentes=$(estado "d['sources']")"
  [ "$(estado "d['sources'][0]['url']")" = "$(harness_lab_git "$DEV" remote get-url origin)" ] && ok "T9 la fuente harness apunta al origin del clon" || mal "T9 url harness: $(estado "d['sources'][0]['url']")"
  N_NUEVA="$(harness_lab_settings_commands | grep -c '\.tycon-pipeline/harness/bootstrap\.js')"
  N_VIEJA="$(harness_lab_settings_commands | grep -c 'install-tycon-hooks.sh 2>/dev/null')"
  [ "$N_NUEVA" = 1 ] && [ "$N_VIEJA" = 0 ] && ok "T9 settings.json: la línea nueva reemplazó a la vieja" || mal "T9 líneas: nueva=$N_NUEVA vieja=$N_VIEJA"
  N_HOOKS="$(settings "sum(len(h['hooks']) for ev in d['hooks'].values() for h in ev)")"
  [ "${N_HOOKS:-0}" -ge 20 ] && ok "T9 settings.json conserva todos los hooks ($N_HOOKS)" || mal "T9 settings.json quedó con $N_HOOKS hooks"
  [ -f "$LAB_HOME/.claude/.tycon-pipeline/harness/bootstrap.js" ] && ok "T9 la copia fija está" || mal "T9 falta la copia fija"
  [ "$(estado "d.get('last_apply')")" = None ] && ok "T9 --from-existing no corrió un aplicador anidado (last_apply vacío)" || mal "T9 last_apply=$(estado "d.get('last_apply')"): corrió aplicador anidado"
  [ ! -d "$LAB_HOME/.claude/.tycon-pipeline/harness/harness.lock" ] && ok "T9 sin candado propio colgado" || mal "T9 quedó el candado harness.lock"

  # con --check y con TYCON_NO_AUTOINSTALL=1: no se llama
  harness_lab_create "$BASE/t9b" >/dev/null; DEV="$BASE/t9b/clones/dev"; arma_dev "$DEV" main
  rm -f "$LAB_HOME/.claude/tycon-claude-guides"; ln -s "$DEV" "$LAB_HOME/.claude/tycon-claude-guides"; harness_lab_old_line canonical
  "${AISLADO[@]}" bash "$DEV/scripts/install-tycon-hooks.sh" --check >/dev/null 2>&1
  [ ! -f "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json" ] && ok "T9 con --check no se crea el estado" || mal "T9 --check creó el estado"
  "${AISLADO[@]}" TYCON_NO_AUTOINSTALL=1 bash "$DEV/scripts/install-tycon-hooks.sh" >/dev/null 2>&1
  [ ! -f "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json" ] && ok "T9 con TYCON_NO_AUTOINSTALL=1 no se crea el estado" || mal "T9 NO_AUTOINSTALL creó el estado"

  # clon en otra rama, y clon con commit propio: managed igual; update no toca y avisa
  # la rama de trabajo EXISTE en origin (la del clon bajo prueba): antes la prueba usaba una rama sólo local, el fetch
  # fallaba y el «rama» que buscaba aparecía de casualidad en el error (pase adversarial, clase 1)
  RAMA_ORIGIN="$T9_RAMA"
  for caso in rama commit; do
    harness_lab_create "$BASE/t9-$caso" >/dev/null; DEV="$BASE/t9-$caso/clones/dev"
    if [ "$caso" = rama ]; then arma_dev "$DEV" "$RAMA_ORIGIN"; else arma_dev "$DEV" main; printf 'propio\n' > "$DEV/PROPIO.md"; harness_lab_git "$DEV" add PROPIO.md >/dev/null; harness_lab_git "$DEV" commit -q -m "commit propio" >/dev/null; fi
    rm -f "$LAB_HOME/.claude/tycon-claude-guides"; ln -s "$DEV" "$LAB_HOME/.claude/tycon-claude-guides"; harness_lab_old_line canonical
    aplicador >/dev/null 2>&1
    [ "$(estado "d['mode']")" = managed ] && ok "T9 clon con $caso: managed igual" || mal "T9 clon con $caso: mode=$(estado "d['mode']")"
    [ "$(estado "d['sources'][0]['ref']")" = main ] && [ "$(estado "d['sources'][0]['rewrites']")" = False ] && ok "T9 clon con $caso: la fuente sigue main y no se reescribe" || mal "T9 clon con $caso: ref=$(estado "d['sources'][0]['ref']") rewrites=$(estado "d['sources'][0]['rewrites']")"
    ANTES="$(harness_lab_git "$DEV" rev-parse HEAD)"; RAMA_ANTES="$(harness_lab_git "$DEV" rev-parse --abbrev-ref HEAD)"
    # tanda D (AC 26): con la política en `ask`, `update --yes` pide una terminal; esta prueba corre sin ella, así que
    # va con la aplicación en `auto` (lo que mide es que un clon en otra rama o con un commit propio no se toca)
    SALIDA="$(TYCON_UPDATE_APPLY=auto node "$DEV/scripts/setup/harness.js" update --yes < /dev/null 2>&1)"; RC=$?
    [ "$(harness_lab_git "$DEV" rev-parse HEAD)" = "$ANTES" ] && [ "$(harness_lab_git "$DEV" rev-parse --abbrev-ref HEAD)" = "$RAMA_ANTES" ] && ok "T9 clon con $caso: update no movió el clon ni de commit ni de rama" || mal "T9 clon con $caso: update movió el clon ($(harness_lab_git "$DEV" rev-parse --abbrev-ref HEAD))"
    case "$caso-$SALIDA" in "rama-"*"rama $RAMA_ORIGIN"*|commit-*diverg*) ok "T9 clon con $caso: update avisa el motivo" ;; *) mal "T9 clon con $caso: update no avisa el motivo (rc $RC): $SALIDA" ;; esac
  done
fi

# ═══ T11 · Harness_Link_RejectsTemp_DeveloperNeverTouchesGit_RecoversIfGone ═══════════════════════════════════════════
if corre T11; then
  harness_lab_create "$BASE/t11" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "T11 install previo falló"
  # un clon descartable (bajo TMPDIR) se rechaza; con --allow-temporary pasa
  DESC="$LAB_TMP/descartable"; harness_lab_git "$LAB_TMP" clone -q "$LAB_REMOTE_TREE" "$DESC" >/dev/null 2>&1
  SALIDA="$(harness link --local "$DESC" 2>&1)"; RC=$?
  [ "$RC" = 2 ] && case "$SALIDA" in *descartable*|*temporal*) ok "T11 link --local a una ruta temporal: rechazado con el motivo" ;; *) mal "T11 rechazo sin motivo: $SALIDA" ;; esac || mal "T11 link --local temporal salió $RC: $SALIDA"
  [ "$(estado "d['mode']")" = managed ] && ok "T11 …y el estado sigue managed" || mal "T11 el rechazo cambió el modo"
  SALIDA="$(harness link --local "$DESC" --allow-temporary 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado "d['mode']")" = developer ] && ok "T11 con --allow-temporary pasa" || mal "T11 --allow-temporary salió $RC: $SALIDA"
  harness link --managed >/dev/null 2>&1
  # un clon propio con cambios sin commitear: developer, el enlace re-apuntado, tree_before guardado.
  # Tiene que vivir FUERA de las carpetas temporales (harness.js las rechaza: /tmp, /private/tmp, $TMPDIR…). En Linux
  # —el agente de la CI— el laboratorio entero cae bajo /tmp, y ahí T11 rechazaba hasta al clon «propio» (CI de main
  # 11568, 2026-10-02): en ese caso va al lado del repo bajo prueba o, si ése también es temporal, al HOME real; se
  # borra al salir.
  DEVC="$LAB/clones/dev"
  temporal() { case "$(cd "$1" && pwd -P)/" in /tmp/*|/private/tmp/*|"$(cd "${ORIG_TMPDIR:-/tmp}" 2>/dev/null && pwd -P)"/*) return 0 ;; esac; return 1; }
  if temporal "$LAB"; then
    for cand in "$(dirname "$RAIZ")" "$REAL_HOME"; do
      [ -d "$cand" ] && [ -w "$cand" ] && ! temporal "$cand" && PERSISTENT="$(mktemp -d "$cand/.harness-install-t11.XXXXXX")" && break
    done
    [ -n "$PERSISTENT" ] && DEVC="$PERSISTENT/dev" || mal "T11 no hay una carpeta fuera de las temporales para el clon propio (lado del repo y HOME real lo son)"
  fi
  harness_lab_git "$(dirname "$DEVC")" clone -q "$LAB_REMOTE_TREE" "$DEVC" >/dev/null 2>&1
  printf 'sin commitear\n' > "$DEVC/BORRADOR.md"
  SALIDA="$(harness link --local "$DEVC" 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "T11 link --local a un clon propio sale 0" || mal "T11 link --local salió $RC: $SALIDA"
  [ "$(cd "$LAB_HOME/.claude/$PLACE_NAME" && pwd -P)" = "$(cd "$DEVC" && pwd -P)" ] && ok "T11 el enlace apunta al clon propio" || mal "T11 el enlace no se re-apuntó: $(readlink "$LAB_HOME/.claude/$PLACE_NAME")"
  [ "$(estado "d['mode']")" = developer ] && [ "$(estado "d['tree_before']")" = "$(cd "$LAB_TREE" && pwd -P)" ] && ok "T11 mode developer con tree_before" || mal "T11 estado: mode=$(estado "d['mode']") tree_before=$(estado "d['tree_before']")"
  GIT_ANTES="$(cd "$DEVC/.git" && find . -type f -not -name 'index' | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256)"
  harness_lab_publish tree "v2" VERSION 2   # hay versión nueva en el remoto: en developer no se trae
  SALIDA="$(node "$DEVC/scripts/setup/harness.js" startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "T11 startup en developer sale 0" || mal "T11 startup salió $RC: $SALIDA"
  GIT_DESPUES="$(cd "$DEVC/.git" && find . -type f -not -name 'index' | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256)"
  [ "$GIT_ANTES" = "$GIT_DESPUES" ] && ok "T11 startup no tocó el git del clon propio (ni fetch)" || mal "T11 startup tocó .git del clon propio"
  grep -q "tree=$(cd "$DEVC" && pwd -P)" "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log" && ok "T11 el aplicador corrió desde el clon propio" || mal "T11 el aplicador no corrió desde el clon propio: $(tail -2 "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log")"
  SALIDA="$(node "$DEVC/scripts/setup/harness.js" update 2>&1)"; RC=$?
  case "$SALIDA" in *desarrollador*) ok "T11 update en developer dice «modo desarrollador» y no actualiza" ;; *) mal "T11 update en developer: $SALIDA" ;; esac
  [ -f "$DEVC/BORRADOR.md" ] && ok "T11 lo sin commitear sigue en el clon propio" || mal "T11 se perdió BORRADOR.md"
  SALIDA="$(node "$DEVC/scripts/setup/harness.js" link --managed 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado "d['mode']")" = managed ] && [ "$(cd "$LAB_HOME/.claude/$PLACE_NAME" && pwd -P)" = "$(cd "$LAB_TREE" && pwd -P)" ] && ok "T11 link --managed vuelve sobre tree_before" || mal "T11 link --managed: rc $RC mode=$(estado "d['mode']") enlace=$(readlink "$LAB_HOME/.claude/$PLACE_NAME") — $SALIDA"
fi

# ═══ T36 · Applier_Standalone_StillDoesFourPieces_SkipsUnderHarness — el lado de harness.js (tanda D · AC 28) ═════════
# Las tres piezas compartidas (cleanupPeriodDays, la variable de env, los comandos de barra) las hace `harness.js` ANTES
# de lanzar el aplicador, se lo avisa con TYCON_HARNESS_SHARED_DONE=1 y las anota en `managed`. El lado del `.sh` real
# (las saltea bajo la variable, las hace con sólo el candado) está en installer-shared-pieces.test.sh (S11).
# 🔴 rojo previo (medido con el harness.js de antes del enganche y el aplicador de juguete ya honrando la variable): el
#    aplicador corría con `shared_done=` vacío y las hacía él; sin «piezas compartidas» en el registro; con un aplicador
#    que no las hace (el `.ps1` de hoy) no quedaban en la máquina ni en `managed`; y —con `runApplier` ya enganchado y
#    rollback.js sin tocar— el rollback QUITABA de la máquina las piezas que harness.js acababa de hacer («quitada (esta
#    versión ya no la trae): setting cleanupPeriodDays»).
if corre T36; then
  VAR_ENV="CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR"
  APPLIER_LOG() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log"; }
  last_run() { tail -1 "$(APPLIER_LOG)" 2>/dev/null; }
  # las piezas compartidas del registro, ordenadas, con repetidos si los hubiera
  shared_managed() { estado "sorted([p['kind'], p['id']] for p in d.get('managed') or [] if p['kind'] in ('setting', 'command'))"; }
  SHARED_WANT="[['command', 'lab-command.md'], ['setting', 'cleanupPeriodDays'], ['setting', 'env.$VAR_ENV']]"
  no_repeats() { estado "len(d['managed']) == len({(p['kind'], p['where'], p['id']) for p in d['managed']})"; }
  in_machine() { [ "$(settings "d.get('cleanupPeriodDays')")" = 365 ] && [ "$(settings "d.get('env', {}).get('$VAR_ENV')")" = 1 ] && cmp -s "$LAB_TREE/commands/lab-command.md" "$LAB_HOME/.claude/commands/lab-command.md"; }
  lab36() { # lab36 <dir> — un laboratorio cuyo árbol trae un comando de barra
    harness_lab_create "$1" >/dev/null
    harness_lab_publish tree "un comando de barra" commands/lab-command.md "# comando de laboratorio"
    harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1
  }

  # (a) install: las hace harness.js, el aplicador corre avisado y no las reporta, quedan en el registro
  lab36 "$BASE/t36"
  cp "$TYCON_SETTINGS_PATH" "$BASE/t36-settings-antes.json"
  SALIDA="$(harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && in_machine && ok "T36 install deja las tres piezas compartidas en la máquina" || mal "T36 install (rc $RC): cleanupPeriodDays=$(settings "d.get('cleanupPeriodDays')") env=$(settings "d.get('env')") comandos=$(ls "$LAB_HOME/.claude/commands" 2>&1) — $SALIDA"
  case "$(last_run)" in *" shared_done=1 "*) ok "T36 el aplicador corrió avisado (TYCON_HARNESS_SHARED_DONE=1): no las hace él" ;; *) mal "T36 el aplicador corrió sin el aviso: $(last_run)" ;; esac
  HARNESS_LOG="$LAB_HOME/.claude/.tycon-pipeline/harness/startup.log"
  grep -q 'piezas compartidas: cleanupPeriodDays' "$HARNESS_LOG" 2>/dev/null \
    && ok "T36 las hizo harness.js (su registro lo dice)" || mal "T36 el registro de harness.js no dice que hizo las piezas compartidas: $(tail -3 "$HARNESS_LOG" 2>&1)"
  [ "$(shared_managed)" = "$SHARED_WANT" ] && [ "$(no_repeats)" = True ] && ok "T36 quedan en el registro (managed), una vez cada una" || mal "T36 managed: $(shared_managed)"
  case "$SALIDA" in *"piezas compartidas"*) mal "T36 install suma una salida nueva: $SALIDA" ;; *) ok "T36 install no suma salidas (lo dice sólo el registro)" ;; esac
  case "$(harness doctor 2>&1)" in *"todas en su lugar"*) ok "T36 doctor: todas en su lugar" ;; *) mal "T36 doctor tras install: $(harness doctor 2>&1 | grep -i 'pieza\|registr')" ;; esac

  # (b) apply las repone: el dev borra un comando y la variable; doctor remite a apply; apply las vuelve a hacer
  rm -f "$LAB_HOME/.claude/commands/lab-command.md"
  python3 - "$TYCON_SETTINGS_PATH" "$VAR_ENV" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p, encoding="utf-8")); del s["env"][sys.argv[2]]
open(p, "w", encoding="utf-8").write(json.dumps(s, indent=2, ensure_ascii=False) + "\n")
PY
  SALIDA="$(harness doctor 2>&1)"
  case "$SALIDA" in *"lab-command.md"*"apply"*) ok "T36 una pieza compartida que falta: doctor remite a apply (no a install)" ;; *) mal "T36 doctor no remite a apply: $(printf '%s\n' "$SALIDA" | grep -i 'falta')" ;; esac
  harness apply >/dev/null 2>&1; RC=$?
  [ "$RC" = 0 ] && in_machine && [ "$(shared_managed)" = "$SHARED_WANT" ] && ok "T36 apply repone las piezas compartidas y siguen en el registro" || mal "T36 apply (rc $RC) no repuso: managed $(shared_managed)"
  # una segunda corrida no cambia nada
  H1="$(sha_de "$TYCON_SETTINGS_PATH")"; harness apply >/dev/null 2>&1
  [ "$(sha_de "$TYCON_SETTINGS_PATH")" = "$H1" ] && [ "$(no_repeats)" = True ] && ok "T36 una segunda corrida no reescribe settings.json ni repite piezas" || mal "T36 la segunda corrida cambió settings.json o repitió piezas"

  # (c) un aplicador viejo (no conoce la variable: las hace y las reporta también): el registro no las duplica
  LAB_APPLIER_OLD=1 harness apply >/dev/null 2>&1; RC=$?
  [ "$RC" = 0 ] && [ "$(shared_managed)" = "$SHARED_WANT" ] && [ "$(no_repeats)" = True ] && ok "T36 con un aplicador que también las reporta (uno viejo), el registro no las duplica" || mal "T36 aplicador viejo (rc $RC): managed $(shared_managed)"

  # (d) rollback: ni las quita ni las duplica — con el aplicador de ahora y con uno viejo
  harness_lab_publish tree "v2" VERSION 2
  SALIDA="$(TYCON_UPDATE_APPLY=auto harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(shared_managed)" = "$SHARED_WANT" ] && ok "T36 update: las piezas compartidas siguen en el registro" || mal "T36 update (rc $RC): $SALIDA · managed $(shared_managed)"
  SALIDA="$(TYCON_UPDATE_APPLY=auto harness rollback 2>&1)"; RC=$?
  [ "$RC" = 0 ] && in_machine && [ "$(shared_managed)" = "$SHARED_WANT" ] && [ "$(no_repeats)" = True ] \
    && ok "T36 rollback: las piezas compartidas quedan en la máquina y en el registro, una vez" || mal "T36 rollback (rc $RC): managed $(shared_managed) — $SALIDA"
  case "$SALIDA" in *"quitada"*"cleanupPeriodDays"*|*"quitada"*"lab-command"*|*"quitada"*"$VAR_ENV"*) mal "T36 rollback quitó una pieza compartida: $SALIDA" ;; *) ok "T36 rollback no quita ninguna pieza compartida" ;; esac
  # …y deshecho con otro rollback, que corre un aplicador viejo (sin la variable): tampoco duplica
  SALIDA="$(TYCON_UPDATE_APPLY=auto LAB_APPLIER_OLD=1 harness rollback 2>&1)"; RC=$?
  [ "$RC" = 0 ] && in_machine && [ "$(shared_managed)" = "$SHARED_WANT" ] && [ "$(no_repeats)" = True ] \
    && ok "T36 un rollback que corre un aplicador viejo (sin la variable) no duplica piezas en el registro" || mal "T36 rollback con aplicador viejo (rc $RC): managed $(shared_managed) — $SALIDA"

  # (e) el valor del dev gana: no se pisa y sale del registro
  python3 - "$TYCON_SETTINGS_PATH" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p, encoding="utf-8")); s["cleanupPeriodDays"] = 30
open(p, "w", encoding="utf-8").write(json.dumps(s, indent=2, ensure_ascii=False) + "\n")
PY
  harness apply >/dev/null 2>&1
  [ "$(settings "d['cleanupPeriodDays']")" = 30 ] && [ "$(estado "any(p['id'] == 'cleanupPeriodDays' for p in d['managed'])")" = False ] \
    && ok "T36 un valor que el dev cambió no se pisa y sale del registro" || mal "T36 el valor del dev: cleanupPeriodDays=$(settings "d['cleanupPeriodDays']") managed=$(shared_managed)"
  python3 - "$TYCON_SETTINGS_PATH" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p, encoding="utf-8")); del s["cleanupPeriodDays"]
open(p, "w", encoding="utf-8").write(json.dumps(s, indent=2, ensure_ascii=False) + "\n")
PY
  harness apply >/dev/null 2>&1

  # (f) uninstall --yes las quita: settings.json vuelve byte a byte a como estaba antes de instalar
  SALIDA="$(harness uninstall --yes 2>&1 < /dev/null)"; RC=$?
  [ "$RC" = 0 ] && cmp -s "$BASE/t36-settings-antes.json" "$TYCON_SETTINGS_PATH" && [ ! -e "$LAB_HOME/.claude/commands/lab-command.md" ] \
    && ok "T36 uninstall --yes quita las tres: settings.json byte a byte el de antes, sin el comando" \
    || mal "T36 uninstall (rc $RC): settings.json $(cat "$TYCON_SETTINGS_PATH" 2>&1 | tr -d '\n ') · comandos $(ls "$LAB_HOME/.claude/commands" 2>&1) — $(printf '%s\n' "$SALIDA" | head -4)"

  # (g) settings.json AUSENTE: el esqueleto del aplicador trae "$schema", que el módulo no pone. harness.js deja que el
  #     aplicador corra SIN la variable (aunque venga heredada de quien lo lanzó) y hace las piezas después; quedan
  #     anotadas igual. Con el archivo presente, la variable heredada tampoco vale: la pone harness.js si las hizo.
  lab36 "$BASE/t36g"
  harness install --yes >/dev/null 2>&1 || mal "T36 (g) install previo falló"
  rm -f "$TYCON_SETTINGS_PATH"
  TYCON_HARNESS_SHARED_DONE=1 harness apply >/dev/null 2>&1; RC=$?
  case "$(last_run)" in *" shared_done= "*) ok "T36 sin settings.json el aplicador corre SIN el aviso (tampoco el heredado de quien lanzó a harness.js)" ;; *) mal "T36 sin settings.json el aplicador corrió avisado: $(last_run)" ;; esac
  [ "$RC" = 0 ] && [ "$(settings "list(d)[0]")" = '$schema' ] && in_machine && [ "$(shared_managed)" = "$SHARED_WANT" ] && [ "$(no_repeats)" = True ] \
    && ok "T36 sin settings.json: nace con el \"\$schema\" del esqueleto, con las tres piezas, anotadas una vez" \
    || mal "T36 sin settings.json (rc $RC): claves $(settings "list(d)") · managed $(shared_managed)"
  # espejo: con el archivo presente, harness.js las hace primero y avisa
  harness apply >/dev/null 2>&1
  case "$(last_run)" in *" shared_done=1 "*) ok "T36 (espejo) con settings.json presente, el aplicador corre avisado" ;; *) mal "T36 (espejo) settings.json presente y sin aviso: $(last_run)" ;; esac
  # un settings.json que el módulo no puede tocar (su `env` no es un objeto): harness.js NO avisa —no las hizo—, aunque la
  # variable venga heredada: las hace el aplicador, como hoy
  printf '{"hooks": {}, "env": "x"}\n' > "$TYCON_SETTINGS_PATH"
  TYCON_HARNESS_SHARED_DONE=1 harness apply >/dev/null 2>&1; RC=$?
  case "$(last_run)" in *" shared_done= "*) ok "T36 si harness.js no pudo hacerlas, no avisa (ni con la variable heredada): quedan para el aplicador" ;; *) mal "T36 harness.js avisó sin haberlas hecho: $(last_run)" ;; esac
  [ "$RC" = 0 ] && [ "$(settings "d.get('cleanupPeriodDays')")" = 365 ] && [ "$(settings "d['env']")" = x ] && ok "T36 …y el aplicador hace la suya sin pisar lo que no entiende" || mal "T36 con env ilegible (rc $RC): $(cat "$TYCON_SETTINGS_PATH" | tr -d '\n')"

  # (i) TYCON_NO_AUTOINSTALL=1 apaga al aplicador entero (sale sin escribir nada): harness.js tampoco hace por él las
  #     piezas compartidas. El espejo: sin el interruptor, las repone.
  # 🔴 rojo previo: con el interruptor puesto harness.js escribía igual cleanupPeriodDays, la variable y el comando
  #    («T36 con TYCON_NO_AUTOINSTALL=1 harness.js hizo igual las piezas compartidas»).
  printf '{\n  "hooks": {}\n}\n' > "$TYCON_SETTINGS_PATH"; rm -rf "$LAB_HOME/.claude/commands"
  H1="$(sha_de "$TYCON_SETTINGS_PATH")"
  TYCON_NO_AUTOINSTALL=1 harness apply >/dev/null 2>&1; RC=$?
  [ "$RC" = 0 ] && [ "$(sha_de "$TYCON_SETTINGS_PATH")" = "$H1" ] && [ ! -e "$LAB_HOME/.claude/commands" ] \
    && ok "T36 con TYCON_NO_AUTOINSTALL=1 (el aplicador apagado) harness.js tampoco hace las piezas compartidas" \
    || mal "T36 con TYCON_NO_AUTOINSTALL=1 harness.js hizo igual las piezas compartidas (rc $RC): $(cat "$TYCON_SETTINGS_PATH" | tr -d '\n ') · comandos $(ls "$LAB_HOME/.claude/commands" 2>&1 | tr '\n' ' ')"
  harness apply >/dev/null 2>&1
  in_machine && ok "T36 (espejo) sin el interruptor, apply las repone" || mal "T36 (espejo) sin el interruptor apply no las repuso: $(cat "$TYCON_SETTINGS_PATH" | tr -d '\n ')"

  # (j) el registro no miente sobre la causa (revisión de la tanda D): «sin shared.js en esta versión» sólo cuando el
  #     módulo de verdad no está; si está y falla, dice que FALLÓ y con qué. En los dos casos las hace el aplicador.
  # 🔴 rojo previo: con un shared.js presente que tira, el registro decía «piezas compartidas: sin shared.js en esta
  #    versión (rota a propósito)…»: apuntaba a una causa falsa.
  lab36 "$BASE/t36j"
  harness install --yes >/dev/null 2>&1 || mal "T36 (j) install previo falló"
  HARNESS_LOG="$LAB_HOME/.claude/.tycon-pipeline/harness/startup.log"
  SHARED_JS="$LAB_TREE/scripts/setup/harness/shared.js"
  cp "$SHARED_JS" "$BASE/t36j-shared.js"
  printf "'use strict';\nmodule.exports = { applyShared() { throw new Error('rota a propósito'); }, union: (a) => a || [], isShared: () => false };\n" > "$SHARED_JS"
  : > "$HARNESS_LOG"
  harness apply >/dev/null 2>&1; RC=$?
  [ "$RC" = 0 ] && grep -q 'piezas compartidas: applyShared falló (rota a propósito): las hace el aplicador' "$HARNESS_LOG" && ! grep -q 'sin shared.js' "$HARNESS_LOG" \
    && ok "T36 un shared.js presente que tira: el registro dice que falló y con qué, no que no existe" || mal "T36 shared.js que tira (rc $RC): $(grep 'piezas compartidas' "$HARNESS_LOG" 2>&1 | cut -c1-300)"
  case "$(last_run)" in *" shared_done= "*) ok "T36 …y el aplicador corre sin el aviso: las hace él" ;; *) mal "T36 shared.js que tira: el aplicador corrió avisado: $(last_run)" ;; esac
  # un shared.js que no carga porque le falta una dependencia SUYA: tampoco es «sin shared.js»
  printf "'use strict';\nrequire('./no-existe-lab.js');\n" > "$SHARED_JS"
  : > "$HARNESS_LOG"
  harness apply >/dev/null 2>&1; RC=$?
  [ "$RC" = 0 ] && grep -q 'piezas compartidas: applyShared falló' "$HARNESS_LOG" && grep -q 'no-existe-lab.js' "$HARNESS_LOG" && ! grep -q 'sin shared.js' "$HARNESS_LOG" \
    && ok "T36 un shared.js al que le falta una dependencia suya: «falló», nombrando lo que falta" || mal "T36 shared.js sin su dependencia (rc $RC): $(grep 'piezas compartidas' "$HARNESS_LOG" 2>&1 | cut -c1-300)"
  # espejo: sin el módulo (un árbol de antes de la tanda D), el mensaje de siempre
  rm -f "$SHARED_JS"
  : > "$HARNESS_LOG"
  harness apply >/dev/null 2>&1; RC=$?
  [ "$RC" = 0 ] && grep -q 'piezas compartidas: sin shared.js en esta versión' "$HARNESS_LOG" && ! grep -q 'applyShared falló' "$HARNESS_LOG" \
    && ok "T36 espejo: sin el módulo, «sin shared.js en esta versión»" || mal "T36 sin shared.js (rc $RC): $(grep 'piezas compartidas' "$HARNESS_LOG" 2>&1 | cut -c1-300)"
  cp "$BASE/t36j-shared.js" "$SHARED_JS"

  # (h) install --from-existing NO las hace: lo lanza el aplicador suelto en medio de su corrida, que ya las hizo
  lab36 "$BASE/t36h"
  rm -f "$LAB_HOME/.claude/tycon-claude-guides"; ln -s "$LAB_TREE" "$LAB_HOME/.claude/tycon-claude-guides"
  cp "$TYCON_SETTINGS_PATH" "$BASE/t36h-antes.json"
  SALIDA="$(TYCON_HARNESS_LOCK_HELD=1 harness install --from-existing 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(settings "'cleanupPeriodDays' in d or 'env' in d")" = False ] && [ ! -e "$LAB_HOME/.claude/commands" ] && [ "$(shared_managed)" = "[]" ] \
    && ok "T36 install --from-existing no hace las piezas compartidas ni las anota" || mal "T36 --from-existing (rc $RC): $(cat "$TYCON_SETTINGS_PATH" | tr -d '\n ') · managed $(shared_managed) — $SALIDA"
  [ ! -f "$(APPLIER_LOG)" ] && ok "T36 …y no corre ningún aplicador" || mal "T36 --from-existing corrió un aplicador: $(last_run)"
  # espejo: el arranque siguiente (startup) sí las hace y las anota
  harness startup >/dev/null 2>&1; RC=$?
  [ "$RC" = 0 ] && in_machine && [ "$(shared_managed)" = "$SHARED_WANT" ] && ok "T36 (espejo) el arranque siguiente las hace y las anota" || mal "T36 (espejo) startup (rc $RC): managed $(shared_managed)"
fi

# ═══ LAB · la máquina del equipo de laboratorio (story 8.18, tramo 3) ═════════════════════════════════════════════════
# Lo que las pruebas del carril dan por cierto de `harness_lab_team_machine` (scripts/tests/lib/harness-lab.sh), en sus dos
# variantes: historia UNIDA de verdad (el repo unido contiene los commits del viejo: el clon viejo avanza en línea recta),
# la forma de la máquina (clon real con cosas sin versionar, ignoradas y un stash; los enlaces a su interior), y el corte
# y el retorno. Un laboratorio que no fuera así daría verde en T29 y en la llave sin haber probado nada.
if corre LAB; then
  top_names() { harness_lab_git "$LAB_REMOTE_TREE" ls-tree --name-only "$1" | tr '\n' ' '; }
  for kind in toy real; do
    if ! harness_lab_team_machine "$BASE/lab-$kind" "$kind" >/dev/null; then mal "LAB ($kind) no se pudo armar la máquina del equipo"; continue; fi
    harness_lab_git "$LAB_REMOTE_UNIFIED" merge-base --is-ancestor "$LAB_COMMIT_SKILLS" "$LAB_COMMIT_UNION" && harness_lab_git "$LAB_REMOTE_UNIFIED" merge-base --is-ancestor "$LAB_COMMIT_BEFORE" "$LAB_COMMIT_UNION" \
      && [ "$(harness_lab_git "$LAB_REMOTE_UNIFIED" rev-list --count --merges "$LAB_COMMIT_UNION")" = 1 ] \
      && ok "LAB ($kind) historia unida de verdad: la unión es un merge que contiene los commits del repo viejo y los del arnés de antes" || mal "LAB ($kind) la unión no contiene las dos historias"
    case " $(top_names "$LAB_COMMIT_BEFORE")" in *" skills "*|*" agents "*|*" packs "*) mal "LAB ($kind) el arnés de antes ya trae skills/, agents/ o packs/: $(top_names "$LAB_COMMIT_BEFORE")" ;; *) ok "LAB ($kind) el arnés de antes no trae skills/, agents/ ni packs/" ;; esac
    MISSING=""; for n in scripts skills agents packs; do case " $(top_names "$LAB_COMMIT_UNION")" in *" $n "*) ;; *) MISSING="$MISSING $n" ;; esac; done
    [ -z "$MISSING" ] && ok "LAB ($kind) la unión trae scripts/, skills/, agents/ y packs/" || mal "LAB ($kind) a la unión le falta${MISSING}: $(top_names "$LAB_COMMIT_UNION")"
    [ "$(harness_lab_git "$LAB_REMOTE_TREE" rev-parse refs/heads/main)" = "$LAB_COMMIT_BEFORE" ] && [ "$(harness_lab_git "$LAB_REMOTE_SKILLS" rev-parse refs/heads/main)" = "$LAB_COMMIT_SKILLS" ] \
      && [ "$(harness_lab_git "$LAB_TREE" rev-parse HEAD)" = "$LAB_COMMIT_BEFORE" ] && [ ! -e "$LAB_TREE/skills" ] \
      && ok "LAB ($kind) antes del corte: main del arnés y el clon de la máquina, en el commit de antes" || mal "LAB ($kind) el punto de partida no es el de antes del corte"
    # el clon viejo avanza en línea recta al repo unido: se prueba en OTRO clon del repo viejo, sin tocar el de la máquina
    FF="$BASE/lab-$kind-straight"; harness_lab_git "$BASE" clone -q "$LAB_REMOTE_SKILLS" "$FF" && harness_lab_git "$FF" fetch -q "$LAB_REMOTE_UNIFIED" refs/heads/lab/union \
      && harness_lab_git "$FF" merge -q --ff-only FETCH_HEAD && [ "$(harness_lab_git "$FF" rev-parse HEAD)" = "$LAB_COMMIT_UNION" ] && [ -f "$FF/scripts/install-tycon-hooks.sh" ] && [ -d "$FF/skills/tycon-pipeline" ] \
      && ok "LAB ($kind) un clon del repo viejo avanza en línea recta (merge --ff-only) al repo unido" || mal "LAB ($kind) el clon viejo no avanza en línea recta al unido"
    [ "$(harness_lab_links)" = "$(printf 'tycon-claude-guides -> %s\nagent-skills = carpeta\nskills -> %s\nagents -> %s' "$LAB_TREE" "$LAB_SKILLS/skills" "$LAB_SKILLS/agents")" ] \
      && ok "LAB ($kind) la forma de la máquina: agent-skills es una carpeta real; skills y agents, enlaces a su interior" || mal "LAB ($kind) enlaces: $(harness_lab_links | tr '\n' ' ')"
    OLD_STATUS="$(harness_lab_git "$LAB_SKILLS" status --porcelain --ignored | LC_ALL=C sort | tr '\n' '|')"
    [ "$OLD_STATUS" = '!! .advisors/|!! skills/lab-third-party/|?? lab-notes.txt|?? skills/lab-own/|' ] && [ "$(harness_lab_git "$LAB_SKILLS" stash list | grep -c .)" = 1 ] \
      && [ "$(harness_lab_git "$LAB_SKILLS" rev-parse HEAD)" = "$LAB_COMMIT_SKILLS" ] && [ "$(harness_lab_git "$LAB_SKILLS" remote get-url origin)" = "$LAB_REMOTE_SKILLS" ] \
      && ok "LAB ($kind) el clon viejo: en main del repo viejo, con dos cosas sin versionar, dos ignoradas y un stash" || mal "LAB ($kind) el clon viejo: «${OLD_STATUS}» · $(harness_lab_git "$LAB_SKILLS" stash list | grep -c .) stash"
    E1="$(harness_lab_clone_extras "$LAB_SKILLS")"; E2="$(harness_lab_clone_extras "$LAB_SKILLS")"
    printf 'otra cosa\n' >> "$LAB_SKILLS/skills/lab-third-party/SKILL.md"; E3="$(harness_lab_clone_extras "$LAB_SKILLS")"
    printf '# skill de terceros: ignorada\n' > "$LAB_SKILLS/skills/lab-third-party/SKILL.md"; E4="$(harness_lab_clone_extras "$LAB_SKILLS")"
    harness_lab_git "$LAB_SKILLS" stash drop -q; E5="$(harness_lab_clone_extras "$LAB_SKILLS")"
    [ -n "$E1" ] && [ "$E1" = "$E2" ] && [ "$E3" != "$E1" ] && [ "$E4" = "$E1" ] && [ "$E5" != "$E1" ] \
      && ok "LAB ($kind) la huella del clon viejo es estable, y cambia si cambia un archivo ignorado o se pierde el stash (espejo)" || mal "LAB ($kind) la huella del clon viejo no distingue: $E1 $E2 $E3 $E4 $E5"
    harness_lab_cut && [ "$(harness_lab_git "$LAB_REMOTE_TREE" rev-parse refs/heads/main)" = "$LAB_COMMIT_UNION" ] && harness_lab_pull_tree \
      && [ "$(harness_lab_git "$LAB_TREE" rev-parse HEAD)" = "$LAB_COMMIT_UNION" ] && [ -d "$LAB_TREE/skills/tycon-pipeline" ] && [ -d "$LAB_TREE/agents" ] \
      && ok "LAB ($kind) el corte: main pasa a la unión y el clon del arnés la baja en línea recta" || mal "LAB ($kind) el corte no dejó al clon del arnés en la unión"
    SALIDA="$(harness_lab_cut 2>&1)"; RC=$?
    [ "$RC" != 0 ] && ok "LAB ($kind) (error) un segundo corte se niega" || mal "LAB ($kind) el segundo corte salió 0: $SALIDA"
    harness_lab_publish_without_skills; RC=$?
    TIP="$(harness_lab_git "$LAB_REMOTE_TREE" rev-parse refs/heads/main)"
    [ "$RC" = 0 ] && harness_lab_git "$LAB_REMOTE_TREE" merge-base --is-ancestor "$LAB_COMMIT_UNION" "$TIP" && case " $(top_names "$TIP")" in *" skills "*|*" agents "*|*" packs "*) false ;; *) true ;; esac \
      && ok "LAB ($kind) el retorno: una punta de main, encima de la unión, que no trae skills/, agents/ ni packs/" || mal "LAB ($kind) el retorno (rc $RC): $(top_names "$TIP")"
    if [ "$kind" = real ]; then
      cmp -s "$RAIZ/scripts/lib/canonical-path.js" "$LAB_TREE/scripts/lib/canonical-path.js" && cmp -s "$RAIZ/scripts/install-tycon-hooks.sh" "$LAB_TREE/scripts/install-tycon-hooks.sh" && cmp -s "$RAIZ/skills/tycon-pipeline/SKILL.md" "$LAB_SKILLS/skills/tycon-pipeline/SKILL.md" \
        && ok "LAB (real) el laboratorio lleva el árbol de trabajo bajo prueba: el instalador, sus bibliotecas y las skills" || mal "LAB (real) el laboratorio no lleva el árbol de trabajo bajo prueba"
    else
      SALIDA="$(harness_lab_real_applier 2>&1)"; RC=$?
      [ "$RC" = 2 ] && ok "LAB (toy) (error) el aplicador real se niega en el laboratorio de juguete" || mal "LAB (toy) el aplicador real corrió en el laboratorio de juguete (rc $RC)"
    fi
  done
  SALIDA="$(harness_lab_team_machine "$BASE/lab-odd" other 2>&1)"; RC=$?
  [ "$RC" = 2 ] && ok "LAB (error) una variante que no existe sale 2" || mal "LAB variante desconocida: rc $RC: $SALIDA"
fi

# ═══ T29 · Transition_TeamMachine_SilentEveryStartup_UnknownFolderStillWarns (story 8.18, AC 28) ══════════════════════
# La máquina del equipo de hoy —~/.claude/agent-skills es un clon real del repo viejo; skills y agents, enlaces a su
# interior— el día que el clon del arnés empieza a traer skills/, agents/ y packs/ (porque `main` ahora los trae). El
# aplicador REAL, corrido como en cada arranque: lo que imprime tiene que ser, línea por línea, lo que imprimía con el
# clon de antes; nada se mueve; ninguna pieza nueva; `doctor` lo dice una vez. Y una carpeta real que no es un clon de
# agent-skills sigue avisando.
# 🔴 rojo previo (medido sobre la base, 2026-10-04): tres líneas más en CADA corrida, también con --check —«en
#    ~/.claude/agent-skills hay una carpeta real, no un enlace: no la piso» y dos «el enlace … apunta a otro lado que
#    sirve … no lo muevo»—, y `doctor` sin decir nada de los dos clones.
if corre T29; then
  transition_said() { grep -c -e 'hay una carpeta real' -e 'no lo muevo' -e 'apunta a otro lado' ; }
  doctor_alarms() { grep -e '^  ✗ ' -e '^  ! '; }
  if ! harness_lab_team_machine "$BASE/t29" real >/dev/null; then mal "T29 no pude armar la máquina del equipo de laboratorio"; else
  SALIDA="$(harness_lab_isolated harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado "','.join(s['name'] for s in d['sources'])")" = "harness,agent_skills" ] && [ ! -e "$LAB_TREE/skills" ] \
    && ok "T29 la máquina del equipo, instalada con el clon de antes (sin skills/): dos fuentes" || mal "T29 install (rc $RC): fuentes $(estado "d['sources']") — $(printf '%s' "$SALIDA" | tail -3)"
  harness_lab_real_applier >/dev/null 2>&1   # lo que haya que decir una sola vez se dice acá
  BEFORE="$(harness_lab_real_applier 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(printf '%s\n' "$BEFORE" | transition_said)" = 0 ] && ok "T29 antes del corte el aplicador no dice nada de los enlaces (la vara)" || mal "T29 la vara (rc $RC): $BEFORE"
  BEFORE_CHECK="$(harness_lab_real_applier --check 2>&1)"
  harness_lab_real_applier --report-json "$BASE/t29-pieces-before.json" >/dev/null 2>&1
  LINKS_BEFORE="$(harness_lab_links)"; EXTRAS_BEFORE="$(harness_lab_clone_extras "$LAB_SKILLS")"
  OLD_HEAD="$(harness_lab_git "$LAB_SKILLS" rev-parse HEAD)"; OLD_ORIGIN="$(harness_lab_git "$LAB_SKILLS" remote get-url origin)"
  DOCTOR_BEFORE="$(harness_lab_isolated harness doctor 2>&1)"

  # el corte: `main` trae la unión, y la máquina la baja por el mecanismo (lo que hace el arranque)
  harness_lab_cut || mal "T29 el corte del laboratorio falló"
  SALIDA="$(TYCON_UPDATE_APPLY=auto harness_lab_isolated harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(harness_lab_git "$LAB_TREE" rev-parse HEAD)" = "$LAB_COMMIT_UNION" ] && [ -d "$LAB_TREE/skills/tycon-pipeline" ] && [ -d "$LAB_TREE/agents" ] && [ -d "$LAB_TREE/packs" ] \
    && ok "T29 el corte: el clon del arnés avanzó a la unión y ahora trae skills/, agents/ y packs/" || mal "T29 el corte (rc $RC): HEAD $(harness_lab_git "$LAB_TREE" rev-parse --short HEAD) — $SALIDA"
  [ "$(printf '%s\n' "$SALIDA" | transition_said)" = 0 ] && ok "T29 la actualización que trae skills/ no dice nada de los enlaces" || mal "T29 la actualización habla de los enlaces: $SALIDA"
  [ "$(transition_said < "$LAB_HOME/.claude/.tycon-pipeline/harness/startup.log")" = 0 ] && ok "T29 …y tampoco queda en el registro del mecanismo" || mal "T29 el registro del mecanismo: $(grep -e 'carpeta real' -e 'no lo muevo' "$LAB_HOME/.claude/.tycon-pipeline/harness/startup.log" | head -3)"
  for i in 1 2 3; do
    AFTER="$(harness_lab_real_applier 2>&1)"; RC=$?
    [ "$RC" = 0 ] && [ "$AFTER" = "$BEFORE" ] && ok "T29 arranque $i con skills/ en el clon: sale 0 y dice, línea por línea, lo mismo que antes del corte" \
      || mal "T29 arranque $i (rc $RC) dice otra cosa: $(diff <(printf '%s\n' "$BEFORE") <(printf '%s\n' "$AFTER") | head -6)"
  done
  S1="$(sha_de "$TYCON_SETTINGS_PATH")$(sha_de "$CLAUDE_MD_PATH")"
  AFTER_CHECK="$(harness_lab_real_applier --check 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$AFTER_CHECK" = "$BEFORE_CHECK" ] && ok "T29 con --check: lo mismo que antes del corte" \
    || mal "T29 --check (rc $RC) dice otra cosa: $(diff <(printf '%s\n' "$BEFORE_CHECK") <(printf '%s\n' "$AFTER_CHECK") | head -6)"
  [ "$(sha_de "$TYCON_SETTINGS_PATH")$(sha_de "$CLAUDE_MD_PATH")" = "$S1" ] && [ "$(harness_lab_links)" = "$LINKS_BEFORE" ] && ok "T29 …y --check no escribió settings.json ni CLAUDE.md, ni movió un enlace" || mal "T29 --check escribió algo"
  [ "$(harness_lab_links)" = "$LINKS_BEFORE" ] && ok "T29 nada se movió: los cuatro enlaces de ~/.claude están como estaban" || mal "T29 enlaces: antes «$(printf '%s' "$LINKS_BEFORE" | tr '\n' ' ')» · ahora «$(harness_lab_links | tr '\n' ' ')»"
  [ "$(harness_lab_git "$LAB_SKILLS" rev-parse HEAD)" = "$OLD_HEAD" ] && [ "$(harness_lab_git "$LAB_SKILLS" remote get-url origin)" = "$OLD_ORIGIN" ] && [ "$(harness_lab_clone_extras "$LAB_SKILLS")" = "$EXTRAS_BEFORE" ] \
    && ok "T29 el clon viejo quedó como estaba: mismo commit, mismo origin; lo sin versionar, lo ignorado y el stash, idénticos" || mal "T29 el clon viejo cambió: HEAD $(harness_lab_git "$LAB_SKILLS" rev-parse --short HEAD) origin $(harness_lab_git "$LAB_SKILLS" remote get-url origin)"
  harness_lab_real_applier --report-json "$BASE/t29-pieces-after.json" >/dev/null 2>&1
  PIECES="$(python3 - "$BASE/t29-pieces-before.json" "$BASE/t29-pieces-after.json" <<'PY'
import json, sys
key = lambda p: (p["kind"], p["where"], p["id"])
before, after = ({key(p) for p in json.load(open(f, encoding="utf-8"))} for f in sys.argv[1:3])
links = sorted(i for k, w, i in after if k == "link")
print("%d new=%s gone=%s links=%s" % (len(after), sorted(after - before), sorted(before - after), ",".join(links)))
PY
)"
  # (story 8.19: los enlaces del arnés son los dos nombres de su lugar, el lugar y el viejo, cada uno su pieza `link`)
  case "$PIECES" in *" new=[] gone=[] links=$LEGACY_PLACE_NAME,$PLACE_NAME") ok "T29 no registra piezas nuevas: las mismas que antes del corte, y los únicos enlaces son los dos nombres del lugar (${PIECES%% *} piezas)" ;; *) mal "T29 las piezas cambiaron: $PIECES" ;; esac
  DOCTOR="$(harness_lab_isolated harness doctor 2>&1)"
  [ "$(printf '%s\n' "$DOCTOR" | grep -c 'dos clones: en transición')" = 1 ] && printf '%s\n' "$DOCTOR" | grep 'dos clones: en transición' | grep -q '^  ✓ ' \
    && ok "T29 doctor lo dice UNA vez, como dato" || mal "T29 doctor: $(printf '%s\n' "$DOCTOR" | grep -c 'dos clones') mención(es) — $(printf '%s\n' "$DOCTOR" | grep 'dos clones' | head -2)"
  [ "$(printf '%s\n' "$DOCTOR_BEFORE" | grep -c 'dos clones')" = 0 ] && ok "T29 (espejo) antes del corte doctor no lo dice" || mal "T29 doctor lo decía antes del corte"
  [ "$(printf '%s\n' "$DOCTOR" | doctor_alarms)" = "$(printf '%s\n' "$DOCTOR_BEFORE" | doctor_alarms)" ] && ok "T29 …y la transición no suma ni un rojo ni un aviso a doctor" \
    || mal "T29 doctor suma alarmas: $(diff <(printf '%s\n' "$DOCTOR_BEFORE" | doctor_alarms) <(printf '%s\n' "$DOCTOR" | doctor_alarms) | head -6)"

  # (error) callar vale sólo para el estado conocido: el mismo clon viejo SIN su .git es una carpeta real cualquiera
  mv "$LAB_SKILLS/.git" "$BASE/t29-old-git" || mal "T29 no pude sacar el .git del clon viejo"
  ODD="$(harness_lab_real_applier 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(printf '%s\n' "$ODD" | grep -c 'hay una carpeta real, no un enlace: no la piso')" = 1 ] && [ -d "$LAB_SKILLS/skills" ] && [ ! -L "$LAB_SKILLS" ] \
    && ok "T29 (error) una carpeta real que NO es un clon de agent-skills sigue avisando, y no se pisa" || mal "T29 (error) carpeta desconocida (rc $RC): $(printf '%s\n' "$ODD" | head -4)"
  ODD="$(harness_lab_real_applier --check 2>&1)"
  [ "$(printf '%s\n' "$ODD" | grep -c 'hay una carpeta real, no un enlace: no la piso')" = 1 ] && ok "T29 (error) …también con --check" || mal "T29 (error) --check con carpeta desconocida: $(printf '%s\n' "$ODD" | head -4)"
  mv "$BASE/t29-old-git" "$LAB_SKILLS/.git"
  AFTER="$(harness_lab_real_applier 2>&1)"
  [ "$AFTER" = "$BEFORE" ] && ok "T29 (espejo) de vuelta el clon, de vuelta el silencio" || mal "T29 con el clon de vuelta: $(diff <(printf '%s\n' "$BEFORE") <(printf '%s\n' "$AFTER") | head -6)"
  fi

  # el gemelo de Windows, por lectura: los dos instaladores delegan los enlaces en canonical-path.js con los mismos
  # argumentos, y ninguno escribe por su cuenta las líneas de la transición (callar vive en Node, igual en los tres sistemas)
  SH_I="$RAIZ/scripts/install-tycon-hooks.sh"; PS_I="$RAIZ/scripts/install-tycon-hooks.ps1"
  if grep -qF -- '--ensure-repo-links --clone "$SCRIPT_DIR/.." --only "$1"' "$SH_I" && grep -qF -- "'--ensure-repo-links', '--clone', (Split-Path -Parent \$PSScriptRoot), '--only', \$Only" "$PS_I" \
     && [ "$(grep -cxF -e '_repo_links agent-skills' -e '_repo_links entries' "$SH_I")" = 2 ] && [ "$(grep -cxF -e "Invoke-RepoLinks 'agent-skills'" -e "Invoke-RepoLinks 'entries'" "$PS_I")" = 2 ] \
     && [ "$(cat "$SH_I" "$PS_I" | grep -c -e 'no la piso' -e 'no lo muevo')" = 0 ]; then
    ok "T29 el .sh y el .ps1 delegan los enlaces en canonical-path.js igual (por lectura): callar vale en los dos"
  else mal "T29 el .sh y el .ps1 no delegan los enlaces igual, o escriben las líneas de la transición por su cuenta"; fi
fi

# ═══ T30 · Transition_HooksSameByNameAndValue_CodexLinksUntouched (story 8.18, AC 29) ══════════════════════════════════
# settings.json y ~/.codex/hooks.json, antes y después de que el clon del arnés traiga skills/: los mismos hooks, por
# nombre y por valor; los que nombran la ruta fija ~/.claude/agent-skills siguen nombrándola; y los enlaces de
# ~/.codex/skills que ya estaban no se tocan. El desplegador de hooks de Codex escribe la ruta que le da
# `resolveSkillsDirs()` (scripts/lib/skills-dir.js): si en una máquina con DOS clones esa función pasa a contestar «el
# propio clon», hooks.json cambia y esta prueba tiene que dar rojo.
if corre T30; then
  if ! harness_lab_team_machine "$BASE/t30" real >/dev/null; then mal "T30 no pude armar la máquina del equipo de laboratorio"; else
  fixed_path_hooks() { python3 -c 'import json,sys
s=json.load(open(sys.argv[1], encoding="utf-8"))
for c in sorted(c.get("command","") for ev in s.get("hooks",{}).values() for h in ev for c in h.get("hooks",[]) if sys.argv[2] in c.get("command","")): print(c)' "$TYCON_SETTINGS_PATH" "$LAB_HOME/.claude/agent-skills/"; }
  harness_lab_seed_codex_links || mal "T30 no pude sembrar los enlaces de ~/.codex/skills"
  TYCON_CODEX=1 harness_lab_real_applier >/dev/null 2>&1; TYCON_CODEX=1 harness_lab_real_applier >/dev/null 2>&1; RC=$?
  if [ "$RC" = 0 ] && [ -s "$CODEX_HOME/hooks.json" ] && grep -q "$LAB_HOME/.claude/agent-skills" "$CODEX_HOME/hooks.json"; then
    ok "T30 la vara: el lado Codex desplegado, con hooks.json nombrando ~/.claude/agent-skills"
  else mal "T30 NO MEDIDO — el lado Codex no se desplegó en el laboratorio (rc $RC): $(ls "$CODEX_HOME" 2>&1 | tr '\n' ' ')"; fi
  cp "$TYCON_SETTINGS_PATH" "$BASE/t30-settings-before.json"; cp "$CODEX_HOME/hooks.json" "$BASE/t30-codex-hooks-before.json" 2>/dev/null
  FIXED_BEFORE="$(fixed_path_hooks)"; CODEX_LINKS_BEFORE="$(harness_lab_codex_links)"
  [ "$(printf '%s\n' "$FIXED_BEFORE" | grep -c .)" -ge 5 ] && [ "$(printf '%s\n' "$CODEX_LINKS_BEFORE" | grep -c "$LAB_HOME/.claude/agent-skills/skills/")" -ge 5 ] \
    && ok "T30 la vara: $(printf '%s\n' "$FIXED_BEFORE" | grep -c .) hooks con la ruta fija y $(printf '%s\n' "$CODEX_LINKS_BEFORE" | grep -c .) enlaces en ~/.codex/skills" \
    || mal "T30 la vara quedó vacía: $(printf '%s\n' "$FIXED_BEFORE" | grep -c .) hooks con la ruta fija, $(printf '%s\n' "$CODEX_LINKS_BEFORE" | grep -c .) enlaces"

  harness_lab_cut && harness_lab_pull_tree || mal "T30 el corte del laboratorio falló"
  [ -d "$LAB_TREE/skills/tycon-pipeline" ] && [ -d "$LAB_TREE/agents" ] || mal "T30 el clon del arnés no trae skills/ después del corte"
  for i in 1 2 3; do TYCON_CODEX=1 harness_lab_real_applier >/dev/null 2>&1 || mal "T30 el aplicador salió con error después del corte (corrida $i)"; done
  cmp -s "$BASE/t30-settings-before.json" "$TYCON_SETTINGS_PATH" && ok "T30 settings.json: byte a byte el de antes del corte" \
    || mal "T30 settings.json cambió: $(diff "$BASE/t30-settings-before.json" "$TYCON_SETTINGS_PATH" | head -6)"
  SALIDA="$(node "$RAIZ/scripts/publishing/profile-equivalence.js" --settings "$BASE/t30-settings-before.json" "$TYCON_SETTINGS_PATH" 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "T30 los hooks del arnés son los mismos por nombre y por valor (profile-equivalence.js --settings sale 0)" || mal "T30 profile-equivalence.js --settings salió $RC: $(printf '%s\n' "$SALIDA" | head -6)"
  [ "$(fixed_path_hooks)" = "$FIXED_BEFORE" ] && ok "T30 los hooks que nombran la ruta fija ~/.claude/agent-skills siguen igual" || mal "T30 los hooks de la ruta fija cambiaron: $(diff <(printf '%s\n' "$FIXED_BEFORE") <(fixed_path_hooks) | head -6)"
  cmp -s "$BASE/t30-codex-hooks-before.json" "$CODEX_HOME/hooks.json" && ok "T30 ~/.codex/hooks.json: byte a byte el de antes del corte" \
    || mal "T30 ~/.codex/hooks.json cambió (¿el desplegador pasó a leer las skills del propio clon?): $(diff "$BASE/t30-codex-hooks-before.json" "$CODEX_HOME/hooks.json" | head -6)"
  [ "$(harness_lab_codex_links)" = "$CODEX_LINKS_BEFORE" ] && [ -f "$CODEX_HOME/skills/own-lab-skill/SKILL.md" ] && ok "T30 los enlaces de ~/.codex/skills quedaron intactos, y la carpeta propia del dev también" \
    || mal "T30 los enlaces de ~/.codex/skills cambiaron: $(diff <(printf '%s\n' "$CODEX_LINKS_BEFORE") <(harness_lab_codex_links) | head -6)"
  fi
fi

# ═══ CANARY · Installer_FastSuites_RunOwnClone_WritesInstalled (story 8.18, AC 12 · la parte del instalador de T11) ════
# El aplicador corre en cada arranque seis suites rápidas de las skills («la capa determinista»). Las buscaba en una
# ruta escrita, ~/.claude/agent-skills/skills: corrido desde un clon de trabajo del repo unido corría las INSTALADAS y
# daba verde sin haber probado el cambio. Ahora las busca por la regla de scripts/lib/skills-dir.js (la variable › el
# propio clon si es unido › lo instalado) y la línea del rojo dice de qué raíz salieron.
# El espejo (hallazgo I12 de la revisión adversarial): lo que el aplicador ESCRIBE en la máquina —los hooks de
# settings.json— sigue nombrando lo instalado: corrido desde un clon de trabajo, y también con TYCON_SKILLS_DIR puesta
# (la variable dice de dónde LEER; no re-apunta los hooks de una máquina a un clon que mañana se borra).
# Y el error: sin skills en ningún lado, sale 1 con la línea de siempre y sin escribir nada, como hoy.
# 🔴 rojo previo (medido sobre 4e0c60a7, 2026-10-04): con la canario rota SÓLO en el clon de trabajo el aplicador no
#    decía nada (corría la instalada, verde); la línea del rojo no decía de qué raíz había salido; y con la variable
#    apuntando al clon de trabajo seguía corriendo la instalada.
if corre CANARY; then
  CANARY_REL="skills/tycon-pipeline/scripts/tests/ledger-honesty.test.js"   # una de las seis suites rápidas
  break_canary() { printf "'use strict';\nconst { test } = require('node:test');\ntest('canario: rota a propósito (harness-install.test.sh)', () => { throw new Error('canario'); });\n" > "$1/$CANARY_REL"; }
  suite_line() { printf '%s\n' "$1" | grep 'la suite de la capa determinista FALLÓ'; }   # <salida>: la línea del rojo, si está
  # los comandos de settings.json que nombran esa carpeta, ordenados (uno por línea)
  hooks_naming() { python3 -c 'import json,sys
s=json.load(open(sys.argv[1], encoding="utf-8"))
for c in sorted(c.get("command","") for ev in s.get("hooks",{}).values() for h in ev for c in h.get("hooks",[]) if sys.argv[2] in c.get("command","")): print(c)' "$TYCON_SETTINGS_PATH" "$1"; }
  if ! harness_lab_team_machine "$BASE/canary" real >/dev/null; then mal "CANARY no pude armar la máquina del equipo de laboratorio"; else
  INSTALLED="$LAB_HOME/.claude/agent-skills/skills"
  [ -f "$LAB_SKILLS/$CANARY_REL" ] && grep -qF "/${CANARY_REL#skills/}" "$LAB_TREE/scripts/install-tycon-hooks.sh" \
    && ok "CANARY la vara: la canario es una de las suites rápidas que el aplicador lista, y está en el agent-skills instalado" \
    || mal "CANARY la vara: ${CANARY_REL} no está en el agent-skills instalado, o el aplicador ya no la lista"
  harness_lab_real_applier >/dev/null 2>&1   # lo que haya que decir una sola vez se dice acá
  SALIDA="$(harness_lab_real_applier 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ -z "$(suite_line "$SALIDA")" ] && [ "$(hooks_naming "$INSTALLED/" | grep -c .)" -ge 5 ] \
    && ok "CANARY la vara: con todo verde el aplicador no dice nada de la suite, y los hooks de las skills nombran lo instalado ($(hooks_naming "$INSTALLED/" | grep -c .))" \
    || mal "CANARY la vara (rc $RC): $(suite_line "$SALIDA" | cut -c1-200) · $(hooks_naming "$INSTALLED/" | grep -c .) hooks con la ruta instalada"

  # (espejo: dos repos físicos) el clon del arnés NO trae skills/: corre las instaladas, como siempre, y lo dice
  break_canary "$LAB_SKILLS"
  SALIDA="$(harness_lab_real_applier 2>&1)"; RC=$?; LINE="$(suite_line "$SALIDA")"
  [ "$RC" = 0 ] && [ "$(printf '%s\n' "$LINE" | grep -c .)" = 1 ] && ok "CANARY (dos repos físicos) la canario rota en el agent-skills instalado: el aplicador del clon sin skills/ da rojo (corre lo instalado)" \
    || mal "CANARY (dos repos físicos) con la canario instalada rota (rc $RC) no hay UNA línea de rojo: $(printf '%s\n' "$SALIDA" | tail -3 | cut -c1-300)"
  case "$LINE" in *"$INSTALLED"*"installed"*) ok "CANARY (dos repos físicos) …y la línea dice de qué raíz salió: lo instalado" ;; *) mal "CANARY (dos repos físicos) la línea no dice la raíz ni «installed»: ${LINE}" ;; esac
  harness_lab_git "$LAB_SKILLS" checkout -q -- "$CANARY_REL" || mal "CANARY no pude devolver la canario instalada a su verde"

  # (error) sin skills en ningún lado (ni el clon las trae, ni hay agent-skills instalado): 1, la línea de siempre, nada escrito
  mv "$LAB_SKILLS" "$BASE/canary-old-clone" && rm -f "$LAB_HOME/.claude/skills" "$LAB_HOME/.claude/agents" || mal "CANARY no pude sacar el agent-skills instalado"
  ANTES="$(harness_lab_home_hash)"
  SALIDA="$(harness_lab_real_applier 2>&1)"; RC=$?
  [ "$RC" = 1 ] && [ "$(printf '%s\n' "$SALIDA" | grep -c 'agent-skills no encontrado')" = 1 ] && printf '%s\n' "$SALIDA" | grep 'agent-skills no encontrado' | grep -qF "$INSTALLED" \
    && ok "CANARY (error) sin skills en ningún lado: sale 1 con UNA línea «agent-skills no encontrado» que nombra dónde las buscó" \
    || mal "CANARY (error) sin skills (rc $RC): $(printf '%s\n' "$SALIDA" | tail -3 | cut -c1-400)"
  [ "$(harness_lab_home_hash)" = "$ANTES" ] && ok "CANARY (error) …y no escribe nada (la HOME, idéntica por hash)" || mal "CANARY (error) sin skills escribió algo en la HOME"
  SALIDA="$(harness_lab_real_applier --check 2>&1)"; RC=$?
  [ "$RC" = 1 ] && [ "$(printf '%s\n' "$SALIDA" | grep -c 'agent-skills no encontrado')" = 1 ] && [ "$(harness_lab_home_hash)" = "$ANTES" ] \
    && ok "CANARY (error) …también con --check" || mal "CANARY (error) sin skills con --check (rc $RC): $(printf '%s\n' "$SALIDA" | tail -2 | cut -c1-300)"
  mv "$BASE/canary-old-clone" "$LAB_SKILLS" && ln -s "$LAB_SKILLS/skills" "$LAB_HOME/.claude/skills" && ln -s "$LAB_SKILLS/agents" "$LAB_HOME/.claude/agents" || mal "CANARY no pude devolver el agent-skills instalado"

  # el corte, y un clon de TRABAJO del repo unido en otra carpeta (el de la máquina sigue siendo $LAB_TREE)
  harness_lab_cut && harness_lab_pull_tree || mal "CANARY el corte del laboratorio falló"
  WORK="$LAB/clones/work"
  harness_lab_git "$LAB/clones" clone -q "$LAB_REMOTE_UNIFIED" "$WORK" && [ -f "$WORK/$CANARY_REL" ] && [ -d "$WORK/agents" ] || mal "CANARY no pude armar el clon de trabajo del repo unido"
  WORK_REAL="$(cd "$WORK" && pwd -P)"
  work_applier() { harness_lab_isolated bash "$WORK/scripts/install-tycon-hooks.sh" "$@"; }
  harness_lab_real_applier >/dev/null 2>&1; work_applier >/dev/null 2>&1   # cada uno registra una vez lo suyo (sus hooks @tcg)
  FIXED_BEFORE="$(hooks_naming "$INSTALLED/")"

  # la canario: rota SÓLO en el clon de trabajo; el agent-skills instalado, verde; sin ninguna variable
  break_canary "$WORK"
  SALIDA="$(work_applier 2>&1)"; RC=$?; LINE="$(suite_line "$SALIDA")"
  [ "$RC" = 0 ] && [ "$(printf '%s\n' "$LINE" | grep -c .)" = 1 ] && ok "CANARY la canario rota SÓLO en el clon de trabajo, sin variables: el aplicador de ese clon da rojo (corre SU suite, no la instalada)" \
    || mal "CANARY con la canario rota en el clon de trabajo (rc $RC) el aplicador no da rojo: corrió la instalada — $(printf '%s\n' "$SALIDA" | tail -2 | cut -c1-300)"
  case "$LINE" in *"$WORK_REAL/skills"*"own-clone"*) ok "CANARY …y la línea dice de qué raíz salió: el propio clon" ;; *) mal "CANARY la línea no dice la raíz del clon de trabajo ni «own-clone»: ${LINE}" ;; esac
  [ "$(hooks_naming "$WORK/skills/" | grep -c .)" = 0 ] && [ "$(hooks_naming "$WORK_REAL/skills/" | grep -c .)" = 0 ] && [ -n "$FIXED_BEFORE" ] && [ "$(hooks_naming "$INSTALLED/")" = "$FIXED_BEFORE" ] \
    && ok "CANARY (espejo, I12) lo que ESCRIBE sigue apuntando a lo instalado: los $(printf '%s\n' "$FIXED_BEFORE" | grep -c .) hooks de las skills nombran ~/.claude/agent-skills, ninguno el clon de trabajo" \
    || mal "CANARY (espejo, I12) el aplicador del clon de trabajo escribió hooks hacia sus propias skills: $(hooks_naming "$WORK_REAL/skills/" | head -2 | cut -c1-200)"
  SALIDA="$(harness_lab_real_applier 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ -z "$(suite_line "$SALIDA")" ] && ok "CANARY (espejo) el aplicador de la MÁQUINA, que no tiene la canario rota, sigue callado" \
    || mal "CANARY (espejo) el aplicador de la máquina (rc $RC) da rojo por la canario de otro clon: $(suite_line "$SALIDA" | cut -c1-300)"

  # la variable gana para CORRER (la regla general), en los dos sentidos; para ESCRIBIR, no mueve nada
  SALIDA="$(TYCON_SKILLS_DIR="$INSTALLED" work_applier 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ -z "$(suite_line "$SALIDA")" ] && ok "CANARY con TYCON_SKILLS_DIR en lo instalado, el aplicador del clon de trabajo corre lo instalado (verde): la variable gana" \
    || mal "CANARY con la variable en lo instalado (rc $RC) el clon de trabajo sigue en rojo: $(suite_line "$SALIDA" | cut -c1-300)"
  cp "$TYCON_SETTINGS_PATH" "$BASE/canary-settings.json"
  SALIDA="$(TYCON_SKILLS_DIR="$WORK/skills" harness_lab_real_applier 2>&1)"; RC=$?; LINE="$(suite_line "$SALIDA")"
  [ "$RC" = 0 ] && case "$LINE" in *"$WORK/skills"*"variable"*) true ;; *) false ;; esac \
    && ok "CANARY con TYCON_SKILLS_DIR en el clon de trabajo, el aplicador de la máquina corre la canario de ahí (rojo) y dice «variable»" \
    || mal "CANARY con la variable en el clon de trabajo (rc $RC) la línea no lo dice: «${LINE}»"
  cmp -s "$BASE/canary-settings.json" "$TYCON_SETTINGS_PATH" && [ "$(hooks_naming "$WORK/skills/" | grep -c .)" = 0 ] \
    && ok "CANARY (espejo) …y la variable no cambia lo que ESCRIBE: settings.json byte a byte igual, ningún hook hacia el clon de trabajo" \
    || mal "CANARY la variable cambió settings.json: $(diff "$BASE/canary-settings.json" "$TYCON_SETTINGS_PATH" | grep '^[<>]' | head -3 | cut -c1-300)"
  # (error) la variable apunta a una carpeta que no existe: la suite NO corrió y se dice (no es verde); lo demás sigue
  SALIDA="$(TYCON_SKILLS_DIR="$BASE/canary-nowhere" harness_lab_real_applier 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(printf '%s\n' "$SALIDA" | grep -c 'la suite de la capa determinista NO corrió')" = 1 ] && printf '%s\n' "$SALIDA" | grep 'NO corrió' | grep -qF "$BASE/canary-nowhere" \
    && cmp -s "$BASE/canary-settings.json" "$TYCON_SETTINGS_PATH" \
    && ok "CANARY (error) con TYCON_SKILLS_DIR en una carpeta que no existe: sale 0, dice UNA vez que la suite NO corrió y por qué, y no toca settings.json" \
    || mal "CANARY (error) variable a una carpeta inexistente (rc $RC): $(printf '%s\n' "$SALIDA" | grep -e 'suite' -e 'no encontrado' | head -2 | cut -c1-300)"

  # (espejo) la canario verde otra vez: silencio
  harness_lab_git "$WORK" checkout -q -- "$CANARY_REL" || mal "CANARY no pude devolver la canario del clon de trabajo a su verde"
  SALIDA="$(work_applier 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ -z "$(suite_line "$SALIDA")" ] && ok "CANARY (espejo) con la canario verde otra vez, el aplicador del clon de trabajo calla" \
    || mal "CANARY (espejo) con la canario verde (rc $RC) sigue el rojo: $(suite_line "$SALIDA" | cut -c1-300)"
  fi

  # por lectura: los dos instaladores le preguntan a la regla, y ninguno trae la ruta escrita
  SH_I="$RAIZ/scripts/install-tycon-hooks.sh"; PS_I="$RAIZ/scripts/install-tycon-hooks.ps1"
  if grep -q 'skills-dir\.js' "$SH_I" && grep -q -- '--installed' "$SH_I" && grep -q 'skills-dir\.js' "$PS_I" && grep -q -- '--installed' "$PS_I" \
     && [ "$(grep -c -e '^AGENT_SKILLS="\$HOME/\.claude/agent-skills/skills"' "$SH_I")" = 0 ] && [ "$(grep -c -e "^\\\$AgentSkills = Join-Path \\\$ClaudeDir 'agent-skills" "$PS_I")" = 0 ]; then
    ok "CANARY el .sh y el .ps1 resuelven dónde están las skills por scripts/lib/skills-dir.js, con la variante de quien escribe (por lectura)"
  else mal "CANARY el .sh o el .ps1 todavía traen la ruta de las skills escrita, o no le preguntan a skills-dir.js con --installed"; fi
fi

# ═══ T37 · NewMachine_OneClone_OneSource_ThreeLinks_ThirdPartyOffline (story 8.18, AC 36) ═════════════════════════════
# La máquina NUEVA después del corte: una HOME vacía (ni `.claude` trae), UN clon del repo unido en la carpeta que elige
# el dev, y `node <clon>/scripts/setup/harness.js install`. Lo que tiene que quedar: una fuente, los cuatro enlaces
# (el arnés y `agent-skills` → el clon; `skills` y `agents` → adentro), las skills de terceros en su lugar
# sin salir a la red, `doctor` sin rojos, y ningún hook dos veces — tampoco si después alguien corre el aplicador por el
# enlace (`bash ~/.claude/tycon-claude-guides/scripts/install-tycon-hooks.sh`: así lo nombran los papeles y la línea de
# arranque vieja), ni en el orden inverso (primero por el enlace, después por el clon).
# El laboratorio: un clon `--shared` del repo bajo prueba con su árbol de trabajo commiteado encima —así lleva la
# HISTORIA de verdad, de la que salen las skills de terceros—, y de ése se clona cada máquina. Todo git, por
# harness_lab_git; lo que el aplicador saca a la red, apagado (harness_lab_isolated); git, sólo con rutas locales.
# 🔴 rojo previo (medido sobre la base, 2026-10-04): después de `install`, el aplicador por el enlace con --check decía
#    «27 hooks faltan» (no faltaba ninguno) y sin --check registraba 27 hooks por segunda vez (32 con el perfil del
#    equipo: ensayo del alta del 2026-10-03); y con TYCON_SAFETY_GUARD=0 por el enlace, el freno que había registrado el
#    clon seguía en settings.json: el interruptor no apagaba nada.
if corre T37; then
  # «<total> <repetidos>»: repetido = mismo evento, mismo matcher y el MISMO archivo (por su ruta real: el enlace y la
  # carpeta del clon son dos rutas al mismo archivo)
  hooks_census() { python3 - "$TYCON_SETTINGS_PATH" <<'PY'
import collections, json, os, re, sys
try:
    s = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    print("0 0"); sys.exit(0)
seen = collections.Counter(); total = 0
for ev, bucket in (s.get("hooks") or {}).items():
    for entry in bucket:
        matcher = "|".join(sorted(t.strip() for t in (entry.get("matcher") or "").split("|") if t.strip()))
        for h in entry.get("hooks", []):
            cmd = h.get("command", ""); total += 1
            q = re.search(r'"(/[^"]+)"', cmd)
            seen[(ev, matcher, os.path.realpath(q.group(1)) if q else cmd)] += 1
print(total, sum(v - 1 for v in seen.values() if v > 1))
PY
  }
  n_hooks_with() { settings "sum(1 for ev in d['hooks'].values() for h in ev for c in h.get('hooks', []) if '$1' in c.get('command', ''))"; }
  # el orden de los hooks, uno por línea («evento|matcher|archivo real»): dos settings.json con los mismos hooks en el
  # mismo orden dan lo mismo aunque nombren el archivo por rutas distintas
  hooks_order() { python3 - "$TYCON_SETTINGS_PATH" <<'PY'
import json, os, re, sys
s = json.load(open(sys.argv[1], encoding="utf-8"))
for ev, bucket in (s.get("hooks") or {}).items():
    for entry in bucket:
        for h in entry.get("hooks", []):
            q = re.search(r'"(/[^"]+)"', h.get("command", ""))
            print("%s|%s|%s" % (ev, entry.get("matcher", ""), os.path.realpath(q.group(1)) if q else h.get("command", "")))
PY
  }
  # los cuatro enlaces, cada uno a su lugar del clon (por la ruta real); si alguno no, lo nombra y devuelve 1
  links_to_clone() {
    local name side entry e link n=0
    for name in "$PLACE_NAME" agent-skills; do   # una máquina nueva: sin el viejo (tanda C)
      link="$HOME/.claude/$name"
      [ -L "$link" ] && [ "$(cd "$link" 2>/dev/null && pwd -P)" = "$(cd "$LAB_TREE" && pwd -P)" ] || { printf '%s' "$name"; return 1; }
    done
    # (story 8.35) skills y agents: carpetas reales del dev, con un enlace por CADA entrada del clon
    for side in skills agents; do
      { [ -d "$HOME/.claude/$side" ] && [ ! -L "$HOME/.claude/$side" ]; } || { printf '%s (no es carpeta real)' "$side"; return 1; }
      for entry in "$LAB_TREE/$side"/*; do
        [ -e "$entry" ] || continue
        e="$(basename "$entry")"; link="$HOME/.claude/$side/$e"; n=$((n + 1))
        [ -L "$link" ] && [ "$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$link")" = "$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$entry")" ] || { printf '%s' "$side/$e"; return 1; }
      done
    done
    [ "$n" -gt 0 ] || { printf 'skills y agents (el clon no tiene entradas)'; return 1; }
  }
  # una máquina NUEVA: HOME vacía y UN clon del repo unido, en la carpeta que elige el dev
  new_machine() { # new_machine <dir>
    mkdir -p "$1/home" "$1/src" || return 1
    harness_lab_git "$1/src" clone -q --shared "$T37_ORIGIN" "$1/src/harness" || return 1
    export HOME="$1/home" LAB_HOME="$1/home" LAB_TREE="$1/src/harness"
    export TYCON_SETTINGS_PATH="$HOME/.claude/settings.json" CLAUDE_MD_PATH="$HOME/.claude/CLAUDE.md"
    export CODEX_HOME="$HOME/.codex" TYCON_GIT_HOOKS_DIR="$HOME/.git-hooks"
  }
  on_machine() { harness_lab_isolated env "${TP_ENV[@]}" "$@"; }
  by_clone() { on_machine bash "$LAB_TREE/scripts/install-tycon-hooks.sh" "$@"; }
  by_link() { on_machine bash "$HOME/.claude/$PLACE_NAME/scripts/install-tycon-hooks.sh" "$@"; }   # el enlace de una máquina nueva: el lugar (tanda C)
  by_place() { on_machine bash "$HOME/.claude/$PLACE_NAME/scripts/install-tycon-hooks.sh" "$@"; }   # story 8.19 (T12)
  tp_on_disk() { node -e '
    const fs = require("fs"); const path = require("path");
    const m = JSON.parse(fs.readFileSync(path.join(process.argv[1], "scripts", "publishing", "third-party-skills.json"), "utf8"));
    console.log((m.third_party || []).filter((e) => e && e.install === "download" && fs.existsSync(path.join(process.argv[1], e.target, "SKILL.md"))).length);' "$LAB_TREE" 2>/dev/null; }

  harness_lab_create "$BASE/t37" >/dev/null   # el ambiente del laboratorio: launchctl de mentira, examen apagado, git sin la máquina
  T37_ORIGIN="$LAB/origin"; T37_READY=0
  if harness_lab_git "$LAB" clone -q --shared "$RAIZ" "$T37_ORIGIN" >/dev/null 2>&1 && harness_lab_git "$T37_ORIGIN" checkout -q -B main >/dev/null 2>&1 \
     && _harness_lab_copy_real "$T37_ORIGIN" . ; then
    # lo borrado en el árbol de trabajo tampoco viaja; y el árbol de trabajo, commiteado: la máquina clona un repo limpio
    harness_lab_git "$RAIZ" ls-files -d -z | ( cd "$T37_ORIGIN" && xargs -0 rm -f )
    harness_lab_git "$T37_ORIGIN" add -A >/dev/null 2>&1
    harness_lab_git "$T37_ORIGIN" diff --cached --quiet || harness_lab_git "$T37_ORIGIN" commit -q -m "lab: el árbol de trabajo bajo prueba" >/dev/null 2>&1
    [ -z "$(harness_lab_git "$T37_ORIGIN" status --porcelain)" ] && [ -d "$T37_ORIGIN/skills/tycon-pipeline" ] && [ -d "$T37_ORIGIN/agents" ] && T37_READY=1
  fi
  if [ "$T37_READY" != 1 ]; then
    mal "T37 no pude armar el repo unido de laboratorio desde $RAIZ (¿no es un clon de git, o no trae skills/ y agents/ en su raíz?)"
  else
  # ¿la historia trae las skills de terceros? (cada árbol del manifiesto, alcanzable desde HEAD: es lo que un clon nuevo baja)
  harness_lab_git "$T37_ORIGIN" rev-list --objects HEAD > "$BASE/t37-objects.txt" 2>/dev/null
  TP_COUNT="$(node -e '
    const fs = require("fs"); const path = require("path");
    let m; try { m = JSON.parse(fs.readFileSync(path.join(process.argv[1], "scripts", "publishing", "third-party-skills.json"), "utf8")); } catch (_) { console.log("0 0"); process.exit(0); }
    const have = new Set(fs.readFileSync(process.argv[2], "utf8").split("\n").map((l) => l.split(" ")[0]));
    const dl = (m.third_party || []).filter((e) => e && e.install === "download");
    console.log(dl.length + " " + dl.filter((e) => have.has(e.tree)).length);' "$T37_ORIGIN" "$BASE/t37-objects.txt" 2>/dev/null)"
  TP_TOTAL="${TP_COUNT%% *}"; TP_IN_HISTORY="${TP_COUNT##* }"
  if [ "${TP_TOTAL:-0}" -gt 0 ] && [ "$TP_IN_HISTORY" = "$TP_TOTAL" ]; then
    # el paso de terceros PRENDIDO y git sin otro transporte que las rutas locales: si saliera a la red, falla en el acto
    TP_ON=1; TP_ENV=(TYCON_THIRD_PARTY=1 GIT_ALLOW_PROTOCOL=file TYCON_THIRD_PARTY_NETWORK_BUDGET_S=2)
  else
    TP_ON=0; TP_ENV=(TYCON_THIRD_PARTY=0)
    echo "  ⏭ T37 NO MEDIDO — las skills de terceros desde la historia local: la historia de este clon trae ${TP_IN_HISTORY:-0} de ${TP_TOTAL:-0} árboles del manifiesto (un clon recortado, o una copia sin esa historia)"
  fi

  # (a) la máquina nueva: un clon y `harness.js install`
  new_machine "$LAB/m1" || mal "T37 no pude armar la máquina nueva (m1)"
  [ -z "$(ls -A "$HOME")" ] && ok "T37 la HOME de la máquina nueva arranca vacía (ni .claude trae)" || mal "T37 la HOME no arranca vacía: $(ls -A "$HOME" | tr '\n' ' ')"
  SALIDA="$(on_machine node "$LAB_TREE/scripts/setup/harness.js" install --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "T37 con UN clon, harness.js install sale 0" || mal "T37 harness.js install salió $RC: $(printf '%s' "$SALIDA" | tail -4)"
  [ "$(estado "len(d['sources'])")" = 1 ] && [ "$(estado "d['sources'][0]['name']")" = harness ] && [ "$(estado "d['sources'][0]['url']")" = "$T37_ORIGIN" ] \
    && ok "T37 el estado tiene UNA fuente (harness), con el origin del clon" || mal "T37 fuentes: $(estado "[(s['name'], s['url']) for s in d['sources']]")"
  BAD="$(links_to_clone)" && ok "T37 los enlaces existen: el lugar y agent-skills → el clon; skills y agents, carpetas reales con un enlace por entrada" || mal "T37 el enlace ~/.claude/${BAD} falta o apunta a otro lado: $(harness_lab_links | tr '\n' ' ')"
  [ -f "$HOME/.claude/skills/tycon-pipeline/SKILL.md" ] && [ -n "$(ls "$HOME/.claude/agents"/*.md 2>/dev/null | head -1)" ] \
    && ok "T37 las skills y los revisores se ven desde ~/.claude/skills y ~/.claude/agents (donde los busca Claude Code)" || mal "T37 ~/.claude/skills/tycon-pipeline/SKILL.md o los revisores de ~/.claude/agents no se ven"
  read -r N_HOOKS N_REP <<< "$(hooks_census)"
  [ "${N_HOOKS:-0}" -ge 20 ] && [ "$N_REP" = 0 ] && ok "T37 settings.json: $N_HOOKS hooks, ninguno dos veces" || mal "T37 settings.json: ${N_HOOKS:-?} hooks, ${N_REP:-?} repetido(s)"
  [ "$(harness_lab_settings_commands | grep -c '\.tycon-pipeline/harness/bootstrap\.js')" = 1 ] && [ "$(grep -c -E "^@~/.claude/($PLACE_NAME|$LEGACY_PLACE_NAME)/(README|INDEX).md\$" "$CLAUDE_MD_PATH" 2>/dev/null)" = 1 ] \
    && ok "T37 la línea de arranque y el @import, una vez cada uno (nadie los escribe a mano)" || mal "T37 la línea de arranque o el @import no están una vez"
  DOCTOR="$(on_machine node "$LAB_TREE/scripts/setup/harness.js" doctor 2>&1)"; RC=$?
  # «todo en orden» (sin avisos: la copia pública) o «N aviso(s), nada en rojo» (el repo interno): lo que importa es 0 y ningún ✗
  [ "$RC" = 0 ] && [ "$(printf '%s\n' "$DOCTOR" | grep -c '^  ✗ ')" = 0 ] && printf '%s\n' "$DOCTOR" | grep -qE '^(todo en orden|[0-9]+ aviso\(s\), nada en rojo)$' \
    && ok "T37 doctor: sale 0, nada en rojo" || mal "T37 doctor (rc $RC): $(printf '%s\n' "$DOCTOR" | grep -e '^  ✗ ' -e 'rojo' | head -4 | tr '\n' ' ') · última línea: $(printf '%s\n' "$DOCTOR" | tail -1)"
  [ "$(printf '%s\n' "$DOCTOR" | grep -c 'dos clones')" = 0 ] && ok "T37 (espejo de T29) con un solo clon doctor no habla de «dos clones»" || mal "T37 doctor habla de dos clones en una máquina de uno: $(printf '%s\n' "$DOCTOR" | grep 'dos clones')"
  if [ "$TP_ON" = 1 ]; then
    [ "$(tp_on_disk)" = "$TP_TOTAL" ] && ! grep -q 'no pude preguntar' "$HOME/.claude/.tycon-pipeline/harness/startup.log" 2>/dev/null \
      && ok "T37 las $TP_TOTAL skills de terceros del manifiesto quedaron en su lugar, restituidas desde la historia local (git sin red)" \
      || mal "T37 skills de terceros: $(tp_on_disk) de $TP_TOTAL en su lugar — $(grep -i 'terceros' "$HOME/.claude/.tycon-pipeline/harness/startup.log" 2>/dev/null | tail -2 | cut -c1-300)"
    [ -z "$(harness_lab_git "$LAB_TREE" status --porcelain)" ] && ok "T37 …y el clon sigue limpio para git (lo restituido está ignorado: no traba la próxima actualización)" \
      || mal "T37 el clon quedó sucio después de restituir las skills de terceros: $(harness_lab_git "$LAB_TREE" status --porcelain | head -3 | tr '\n' ' ')"
  fi

  # (b) el aplicador llamado por el ENLACE, y después por el clon: nada nuevo, nada repetido
  cp "$TYCON_SETTINGS_PATH" "$BASE/t37-settings.json"
  SALIDA="$(by_link --check 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(printf '%s\n' "$SALIDA" | grep -c 'hooks faltan')" = 0 ] && cmp -s "$BASE/t37-settings.json" "$TYCON_SETTINGS_PATH" \
    && ok "T37 por el enlace con --check: no dice que falte ningún hook, y no escribe" || mal "T37 por el enlace con --check (rc $RC): $(printf '%s\n' "$SALIDA" | grep 'hooks faltan' | cut -c1-200)"
  SALIDA="$(by_link 2>&1)"; RC=$?
  read -r N_HOOKS2 N_REP <<< "$(hooks_census)"
  [ "$RC" = 0 ] && [ "$N_REP" = 0 ] && cmp -s "$BASE/t37-settings.json" "$TYCON_SETTINGS_PATH" \
    && ok "T37 el aplicador por el enlace no registra nada por segunda vez: settings.json byte a byte igual" \
    || mal "T37 el aplicador por el enlace (rc $RC) dejó ${N_HOOKS2:-?} hooks (había $N_HOOKS), ${N_REP:-?} repetido(s): $(printf '%s\n' "$SALIDA" | grep 'instalé' | cut -c1-200)"
  by_clone >/dev/null 2>&1; RC=$?
  [ "$RC" = 0 ] && cmp -s "$BASE/t37-settings.json" "$TYCON_SETTINGS_PATH" && ok "T37 (espejo) …y por la carpeta del clon, tampoco" || mal "T37 el aplicador por el clon (rc $RC) cambió settings.json"
  # story 8.19 · T12: la tercera ruta, el LUGAR: nada nuevo, nada repetido, la misma cuenta
  SALIDA="$(by_place 2>&1)"; RC=$?
  read -r N_HOOKS3 N_REP <<< "$(hooks_census)"
  [ "$RC" = 0 ] && [ "$N_REP" = 0 ] && [ "$N_HOOKS3" = "$N_HOOKS" ] && cmp -s "$BASE/t37-settings.json" "$TYCON_SETTINGS_PATH" \
    && ok "T12 el aplicador por el lugar tampoco registra nada: settings.json byte a byte igual, la misma cuenta ($N_HOOKS3)" \
    || mal "T12 el aplicador por el lugar (rc $RC) dejó ${N_HOOKS3:-?} hooks (había $N_HOOKS), ${N_REP:-?} repetido(s)"

  # (c) un interruptor apagado por la OTRA ruta saca el hook que registró la primera; prendido, vuelve una sola vez
  [ "$(n_hooks_with safety-guard-pre.sh)" = 1 ] && ok "T37 la vara: el freno de comandos destructivos está registrado una vez (por la ruta del clon)" || mal "T37 la vara: safety-guard-pre.sh está $(n_hooks_with safety-guard-pre.sh) veces"
  TYCON_SAFETY_GUARD=0 by_link >/dev/null 2>&1
  [ "$(n_hooks_with safety-guard-pre.sh)" = 0 ] && ok "T37 con TYCON_SAFETY_GUARD=0 por el enlace, el hook que registró el clon se va" || mal "T37 con TYCON_SAFETY_GUARD=0 por el enlace el hook sigue: está $(n_hooks_with safety-guard-pre.sh) veces"
  by_link >/dev/null 2>&1; by_clone >/dev/null 2>&1
  read -r _N N_REP <<< "$(hooks_census)"
  [ "$(n_hooks_with safety-guard-pre.sh)" = 1 ] && [ "$N_REP" = 0 ] && ok "T37 (espejo) prendido otra vez, vuelve UNA vez: el clon reconoce el que registró el enlace" || mal "T37 de vuelta prendido: safety-guard-pre.sh $(n_hooks_with safety-guard-pre.sh) veces, ${N_REP:-?} repetido(s)"
  # …y un hook que entra por la otra ruta entra en SU LUGAR (settings.json es función de la configuración, no de por dónde
  # se llamó al instalador). Se mide con el freno de sesiones, que va DESPUÉS de hooks del arnés registrados por el clon:
  # la vara es el orden que deja el clon al prenderlo; después se apaga y se prende por el enlace.
  # 🔴 rojo previo (mutación, 2026-10-04): sin la otra ruta en la tabla del orden, por el enlace entraba antes del freno de
  #    comandos destructivos en vez de al final de su bloque.
  TYCON_SESSION_GUARD=1 by_clone >/dev/null 2>&1; ORDER_REF="$(hooks_order)"
  by_clone >/dev/null 2>&1
  [ "$(n_hooks_with session-collision-guard.js)" = 0 ] || mal "T37 la vara del orden: apagado, el freno de sesiones sigue registrado ($(n_hooks_with session-collision-guard.js))"
  TYCON_SESSION_GUARD=1 by_link >/dev/null 2>&1
  [ "$(n_hooks_with session-collision-guard.js)" = 2 ] && [ -n "$ORDER_REF" ] && [ "$(hooks_order)" = "$ORDER_REF" ] \
    && ok "T37 un hook que entra por el enlace queda en su lugar: el mismo orden que cuando lo prende el clon" \
    || mal "T37 el hook que entró por el enlace no quedó en su lugar ($(n_hooks_with session-collision-guard.js) registrados): $(diff <(printf '%s\n' "$ORDER_REF") <(hooks_order) | grep '^[<>]' | head -4 | tr '\n' ' ' | cut -c1-400)"
  by_clone >/dev/null 2>&1   # apagado otra vez: la máquina queda como estaba

  # (d) el orden inverso y los pasos a mano: una HOME con algo propio, el enlace, y el aplicador SOLO (sin harness.js) por
  #     el enlace; después por el clon; después `harness.js install`
  new_machine "$LAB/m2" || mal "T37 no pude armar la máquina nueva (m2)"
  mkdir -p "$HOME/.claude" "$LAB/elsewhere"
  printf 'process.exit(0);\n' > "$LAB/elsewhere/response-style-meter.js"   # OTRO archivo con el nombre de un hook del arnés
  printf '{\n  "hooks": {\n    "Stop": [\n      { "hooks": [ { "type": "command", "command": "node \\"%s\\"" } ] }\n    ]\n  }\n}\n' "$LAB/elsewhere/response-style-meter.js" > "$TYCON_SETTINGS_PATH"
  ln -s "$LAB_TREE" "$HOME/.claude/$PLACE_NAME"   # una máquina nueva, pasos a mano: el enlace es el lugar (tanda C)
  SALIDA="$(by_link 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "T37 el aplicador solo, por el enlace, sobre una HOME sin instalar: sale 0" || mal "T37 el aplicador solo por el enlace salió $RC: $(printf '%s' "$SALIDA" | tail -3)"
  BAD="$(links_to_clone)" && ok "T37 …y deja los enlaces agent-skills, skills y agents (los pasos a mano ya no dejan a Claude Code sin skills)" || mal "T37 tras el aplicador solo, el enlace ~/.claude/${BAD} falta: $(harness_lab_links | tr '\n' ' ')"
  [ "$(n_hooks_with "$HOME/.claude/$PLACE_NAME/scripts/hooks/")" -ge 15 ] 2>/dev/null && ok "T37 la vara del orden inverso: los hooks del arnés quedaron registrados por la ruta del ENLACE" \
    || mal "T37 la vara del orden inverso: sólo $(n_hooks_with "$HOME/.claude/$PLACE_NAME/scripts/hooks/") hooks por la ruta del enlace"
  [ "$(estado "len(d['sources'])")" = 1 ] && ok "T37 …con el estado creado sobre lo que ya estaba (una fuente)" || mal "T37 tras el aplicador solo no hay estado con una fuente: $(estado "d['sources']")"
  cp "$TYCON_SETTINGS_PATH" "$BASE/t37-settings-m2.json"
  by_clone >/dev/null 2>&1; RC=$?
  read -r _N N_REP <<< "$(hooks_census)"
  [ "$RC" = 0 ] && [ "$N_REP" = 0 ] && cmp -s "$BASE/t37-settings-m2.json" "$TYCON_SETTINGS_PATH" \
    && ok "T37 orden inverso: después, por el clon, no registra nada por segunda vez (settings.json byte a byte igual)" || mal "T37 orden inverso (rc $RC): ${N_REP:-?} repetido(s) tras correr por el clon"
  SALIDA="$(on_machine node "$LAB_TREE/scripts/setup/harness.js" install --yes 2>&1)"; RC=$?
  read -r _N N_REP <<< "$(hooks_census)"
  DOCTOR="$(on_machine node "$LAB_TREE/scripts/setup/harness.js" doctor 2>&1)"; RC_D=$?
  [ "$RC" = 0 ] && [ "$N_REP" = 0 ] && [ "$RC_D" = 0 ] && [ "$(printf '%s\n' "$DOCTOR" | grep -c '^  ✗ ')" = 0 ] \
    && ok "T37 …y harness.js install encima tampoco repite nada; doctor sin rojos" || mal "T37 install sobre lo hecho a mano (rc $RC): ${N_REP:-?} repetido(s); doctor rc $RC_D: $(printf '%s\n' "$DOCTOR" | grep '^  ✗ ' | head -3 | tr '\n' ' ')"
  [ "$(n_hooks_with "$LAB/elsewhere/response-style-meter.js")" = 1 ] && [ "$(n_hooks_with "scripts/hooks/response-style-meter.js")" = 1 ] \
    && ok "T37 (espejo) OTRO archivo con el nombre de un hook del arnés no se confunde con el suyo: queda, y el del arnés se registra una vez" \
    || mal "T37 (espejo) el hook ajeno está $(n_hooks_with "$LAB/elsewhere/response-style-meter.js") veces y el del arnés $(n_hooks_with "scripts/hooks/response-style-meter.js")"

  # (e) (error) un clon SIN skills/ y sin ~/.claude/agent-skills: 1, una línea que lo nombra, nada escrito
  new_machine "$LAB/m3" || mal "T37 no pude armar la máquina nueva (m3)"
  for d in skills agents packs; do [ -e "$LAB_TREE/$d" ] && harness_lab_git "$LAB_TREE" rm -r -q "$d" >/dev/null 2>&1; done
  harness_lab_git "$LAB_TREE" commit -q -m "lab: un clon sin skills/" >/dev/null 2>&1
  SALIDA="$(on_machine node "$LAB_TREE/scripts/setup/harness.js" install --yes 2>&1)"; RC=$?
  [ ! -e "$LAB_TREE/skills" ] && [ "$RC" = 1 ] && ok "T37 (error) un clon sin skills/ y sin ~/.claude/agent-skills: install sale 1" || mal "T37 (error) un clon sin skills/ salió $RC: $SALIDA"
  [ "$(printf '%s\n' "$SALIDA" | grep -c .)" = 1 ] && case "$SALIDA" in *agent-skills*) ok "T37 (error) …con UNA línea que nombra agent-skills" ;; *) mal "T37 (error) la línea no nombra agent-skills: $SALIDA" ;; esac || mal "T37 (error) más de una línea: $SALIDA"
  [ -z "$(ls -A "$HOME")" ] && ok "T37 (error) …y sin escribir nada: la HOME sigue vacía" || mal "T37 (error) escribió en la HOME: $(ls -A "$HOME" | tr '\n' ' ')"
  fi
fi

# ═══ T39 · Docs_InstallAndOnboarding_SayOneRepo (story 8.18, AC 36) ═══════════════════════════════════════════════════
# Los papeles del alta, por su texto: `INSTALL.md` y los archivos de `onboarding/` dicen «clonar UN repo y correr el
# instalador». Ninguna línea manda clonar agent-skills, ni crear un enlace a mano, ni pegar la línea de arranque vieja
# (la escribe `harness.js install`). El bloque `<!-- install:internal -->` de INSTALL.md es el que la máquina limpia
# ejecuta tal cual (clean-machine/scenarios/unified.sh): un `git clone` y `harness.js install`, nada más.
# El caso: el ensayo del alta (2026-10-03) siguió los pasos manuales al pie de la letra y la máquina quedó sin
# `~/.claude/skills` (ningún paso lo creaba), con 32 hooks dos veces y con el diagnóstico en rojo.
# 🔴 rojo previo (2026-10-04, sobre la base): INSTALL.md §1 «Clonar los dos repos», con `git clone <URL de agent-skills>`
#    (dos veces), §3 con el `ln -s` de agents a mano y §4 con la línea de arranque vieja; el prompt de onboarding con su
#    PASO 1 «Clonar los dos repos compartidos» y su PASO 2 de enlaces a mano; sin el bloque `install:internal`.
if corre T39; then
  if [ ! -f "$RAIZ/INSTALL.md" ] || [ ! -d "$RAIZ/onboarding" ]; then
    echo "  ⏭ T39 NO MEDIDO — este árbol no trae INSTALL.md y onboarding/ (la copia pública no lleva el alta del equipo)"
  else
  # (a un archivo y después se lee: bash 3.2 no sabe leer un heredoc con comillas invertidas dentro de `<( … )`)
  python3 - "$RAIZ" > "$BASE/t39.out" 2> "$BASE/t39.err" <<'PY'
import os, re, sys
root = sys.argv[1]
def say(good, text): print(("OK" if good else "MAL") + "\t" + text)
def read(rel):
    with open(os.path.join(root, rel), encoding="utf-8") as f: return f.read()
# lo que lee una persona del equipo: sin los bloques que sólo salen en la copia pública (son comentarios HTML)
def internal_view(text): return re.sub(r"<!-- tycon:" r"public-only\n.*?\n-->", "", text, flags=re.S)  # partido: entero sería un marcador para el exportador
def block(text, name, lang):
    m = re.search(r"<!-- %s -->\n(.*?)\n<!-- /%s -->" % (re.escape(name), re.escape(name)), text, flags=re.S)
    if not m: return None
    f = re.search(r"```%s\n(.*?)\n```" % lang, m.group(1), flags=re.S)
    return f.group(1).split("\n") if f else None
OLD_REPO = re.compile(r"agent-skills|AgentSkills")
CLONE = re.compile(r"\bgit clone\s+(?:-\S+\s+)*(?:<URL|https?://)")   # el comando con su URL: la prosa que nombra `git clone` no cuenta
def clone_problems(text):
    """Las líneas que mandan clonar otra cosa que el repo unido, y cuántas líneas de `git clone` hay."""
    clones = [l.strip() for l in text.split("\n") if CLONE.search(l)]
    return [l for l in clones if OLD_REPO.search(l)], len(clones)
def hand_made_links(text):
    return [l.strip() for l in text.split("\n") if re.search(r"^\s*(ln -s|.*\bmklink\b)", l) and re.search(r"\.claude[\\/](agents|skills|agent-skills)", l)]
def old_startup_line(text):
    # el bloque de SessionStart que se pegaba a mano: un `"command"` con el `git pull` de los repos
    return [l.strip()[:80] for l in text.split("\n") if '"command"' in l and re.search(r"git\s+(-C\s+\S+\s+)?pull", l)]

install = internal_view(read("INSTALL.md"))
papers = {"INSTALL.md": install}
for name in ("step-0-mac.md", "step-0-windows.md", "new-dev-harness-setup.md", "datos-del-equipo.md"):
    papers["onboarding/" + name] = read(os.path.join("onboarding", name))

bad = {k: clone_problems(v)[0] for k, v in papers.items()}
bad = {k: v for k, v in bad.items() if v}
say(not bad, "ningún papel del alta manda clonar agent-skills" + ("" if not bad else ": " + " · ".join("%s → %s" % (k, v[0][:90]) for k, v in bad.items())))
counts = {k: clone_problems(v)[1] for k, v in papers.items()}
# story 8.23, tanda E: usar no es mantener. El clon queda SÓLO en INSTALL.md §1b (quien mantiene: uno para macOS/Linux y
# uno para Windows); los Step 0 y el prompt del dev nuevo ya no clonan (la versión la instala el guion de la portada)
want = {"INSTALL.md": 2, "onboarding/step-0-mac.md": 0, "onboarding/step-0-windows.md": 0, "onboarding/new-dev-harness-setup.md": 0, "onboarding/datos-del-equipo.md": 0}
say(counts == want, "el clon sólo en INSTALL.md §1b (uno para macOS/Linux y uno para Windows, para quien mantiene); los Step 0 y el prompt del dev nuevo no clonan (8.23 E)"
    + ("" if counts == want else ": hay %s y se esperaba %s" % (counts, want)))
for name, lang in (("install:internal", "bash"), ("install:internal-windows", "powershell")):
    b = block(install, name, lang)
    good = bool(b) and sum(1 for l in b if re.search(r"\bgit clone\b", l)) == 1 \
        and sum(1 for l in b if re.search(r"scripts[\\/]setup[\\/]harness\.js install\b", l)) == 1 \
        and not any(OLD_REPO.search(l) or re.search(r"\bln -s\b|\bmklink\b|install-tycon-hooks", l) for l in b)
    say(good, "INSTALL.md: el bloque <!-- %s --> (```%s) es un `git clone` y `harness.js install`, sin agent-skills, sin enlaces a mano y sin el aplicador suelto" % (name, lang)
        + ("" if good else ": " + ("no está" if not b else " ⏎ ".join(b)[:200])))
# story 8.16, tanda B (AC 19): el PASO 2 del alta lo corre el asistente, sin terminal. Por sistema, dos comandos: primero
# `install --dry-run` (le muestra el plan al dev) y después `install --yes`, que se corre sólo con el sí del dev; y
# ninguno sin una de esas dos opciones (sin terminal, `install` solo sale 2 y no instala nada)
onb = papers["onboarding/new-dev-harness-setup.md"]
paso2 = onb.split("## PASO 2", 1)[1].split("\n## ", 1)[0] if "## PASO 2" in onb else ""
cmds = [l.strip() for l in paso2.splitlines() if re.search(r"scripts[\\/]setup[\\/]harness\.js\"? install\b", l)]
plain = [c for c in cmds if not re.search(r"install (--dry-run|--yes)\s*$", c)]
dry = [c for c in cmds if c.endswith("install --dry-run")]
yes = [c for c in cmds if c.endswith("install --yes")]
asks = re.search(r"[Pp]reguntame si instalo", paso2) and re.search(r"[Ss]ólo con mi sí", paso2)
good = len(dry) == 2 and len(yes) == 2 and not plain and bool(asks) and paso2.find("--dry-run") < paso2.find("--yes")
say(good, "onboarding: el PASO 2 trae, por sistema, `install --dry-run` (el plan al dev) y después `install --yes` sólo con su sí; ningún `install` pelado"
    + ("" if good else ": dry-run %d, yes %d, sin opción %s, pregunta %s" % (len(dry), len(yes), plain[:2], bool(asks))))
links = {k: hand_made_links(v) for k, v in papers.items()}
links = {k: v for k, v in links.items() if v}
say(not links, "ningún papel manda crear a mano los enlaces de ~/.claude (los crea el instalador)" + ("" if not links else ": " + " · ".join("%s → %s" % (k, v[0][:90]) for k, v in links.items())))
old = {k: old_startup_line(v) for k, v in papers.items()}
old = {k: v for k, v in old.items() if v}
say(not old, "ningún papel trae un bloque de SessionStart para pegar a mano (la línea de arranque vieja, con su `git pull`): la escribe harness.js install" + ("" if not old else ": " + " · ".join("%s → %s" % (k, v[0]) for k, v in old.items())))
two = [k for k, v in papers.items() if re.search(r"[Cc]lon\w+ los dos repos|los dos repos compartidos|\*\*los dos\*\* repos", v)]
say(not two, "ningún papel habla de clonar «los dos repos»" + ("" if not two else ": " + ", ".join(two)))
for k in ("INSTALL.md", "onboarding/new-dev-harness-setup.md"):
    missing = [n for n in ("~/.claude/tycon-harness", "~/.claude/agent-skills", "~/.claude/skills", "~/.claude/agents") if n not in papers[k]]
    say(not missing and "harness.js doctor" in papers[k], "%s nombra los cuatro enlaces que deja el instalador y manda a mirarlos con harness.js doctor" % k
        + ("" if not missing and "harness.js doctor" in papers[k] else ": falta %s" % (", ".join(missing) or "harness.js doctor")))
win = "winget install Microsoft.PowerShell" in install and "winget install Microsoft.PowerShell" in papers["onboarding/new-dev-harness-setup.md"]
say(win, "Windows: INSTALL.md y el prompt dicen que harness.js install pide PowerShell 7 (pwsh) y cómo instalarlo")
say("update.skills_source" in install and "separate" in install, "INSTALL.md dice, aparte, qué pasa en una máquina que ya estaba instalada con dos clones (la llave update.skills_source)")
# decisión del dueño (2026-10-04, «una primero, después todas»): reemplaza «las Windows quedan con la llave apagada»
flat = re.sub(r"[\s*]+", " ", install)   # sin saltos de línea ni negritas: el texto corrido
one_first = "en una máquina Windows real, con el dueño mirando" in flat and "hasta probar una" not in flat and "en una máquina Windows real todavía no se midieron" in flat
say(one_first, "INSTALL.md dice cómo entra la llave: primero en UNA máquina Windows real, después todas, y que ahí todavía no se midió (ya no «las Windows quedan como están hasta probar una»)")
# el espejo: el lector de arriba SÍ ve un papel que manda clonar agent-skills, crear un enlace a mano o pegar la línea vieja
toy = ("git clone <URL de agent-skills> ~/.claude/agent-skills\nln -s ~/.claude/agent-skills/agents ~/.claude/agents\n"
       '        "command": "cd ~/.claude/agent-skills && git pull --ff-only --quiet || true",\n')
sane = "git clone <URL del arnés> tycon-claude-guides\nUn `git clone` y un comando, y listo.\ngit -C ~/.claude/agent-skills pull --ff-only\n"
say(len(clone_problems(toy)[0]) == 1 and len(hand_made_links(toy)) == 1 and len(old_startup_line(toy)) == 1
    and clone_problems(sane) == ([], 1) and not hand_made_links(sane) and not old_startup_line(sane),
    "(espejo) el lector ve un papel que manda clonar agent-skills, crear un enlace a mano o pegar la línea vieja; y no marca el clon del repo unido, la prosa, ni el pull a mano de una máquina que ya estaba instalada")
PY
  RC=$?
  N_T39=0
  while IFS="$(printf '\t')" read -r VERDICT TEXT; do
    case "$VERDICT" in OK) ok "T39 $TEXT"; N_T39=$((N_T39+1)) ;; MAL) mal "T39 $TEXT"; N_T39=$((N_T39+1)) ;; esac
  done < "$BASE/t39.out"
  # un lector que se cae a mitad de camino no puede pasar por «pocas afirmaciones, todas verdes»
  [ "$RC" = 0 ] && [ "$N_T39" = 14 ] || mal "T39 el lector de los papeles no terminó (rc $RC, $N_T39 afirmaciones): $(tail -2 "$BASE/t39.err" | tr '\n' ' ')"
  fi
fi

# ═══ Regresiones de la iteración 1 (pase adversarial y revisores, 2026-10-02) ═════════════════════════════════════════
if corre REG; then
  # REG-D4 · install --source sobre una instalación existente cambia el origen fijado (es el remedio que nombran update y doctor)
  harness_lab_create "$BASE/reg-d4" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "REG-D4 install previo falló"
  OTRO="$LAB/remotes/harness-otro.git"; cp -R "$LAB_REMOTE_TREE" "$OTRO"; harness_lab_git "$LAB_TREE" remote set-url origin "$OTRO"
  SALIDA="$(harness update --check 2>&1)"; RC=$?
  [ "$RC" = 2 ] && case "$SALIDA" in *origin*) ok "REG-D4 con el origin cambiado update se niega y lo nombra" ;; *) mal "REG-D4 no nombra el origin: $SALIDA" ;; esac || mal "REG-D4 origin cambiado: rc $RC: $SALIDA"
  SALIDA="$(harness install --yes --source "$OTRO" 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado "d['sources'][0]['url']")" = "$OTRO" ] && ok "REG-D4 install --source fija el origen nuevo" || mal "REG-D4 --source: rc $RC url=$(estado "d['sources'][0]['url']"): $SALIDA"
  harness update --check >/dev/null 2>&1; RC=$?
  [ "$RC" = 0 ] && ok "REG-D4 …y update vuelve a mirar (al día)" || mal "REG-D4 update después de --source: rc $RC"
  # REG-W5 · install --channel escribe el canal en la configuración (~/.claude/tycon.json), no sólo en el estado
  harness_lab_create "$BASE/reg-w5" >/dev/null
  harness install --yes --channel latest >/dev/null 2>&1 || mal "REG-W5 install --channel falló"
  [ "$(j "$LAB_HOME/.claude/tycon.json" "d['update']['channel']")" = latest ] && ok "REG-W5 install --channel latest queda en ~/.claude/tycon.json" || mal "REG-W5 tycon.json: $(cat "$LAB_HOME/.claude/tycon.json" 2>&1)"
  case "$(harness channel 2>&1)" in *"canal: latest"*) ok "REG-W5 …y channel dice latest" ;; *) mal "REG-W5 channel: $(harness channel 2>&1)" ;; esac
  # REG-D12 · los requisitos se comprueban con su versión: un python3 que no responde a --version cuenta como faltante
  harness_lab_create "$BASE/reg-d12" >/dev/null
  printf '#!/bin/sh\nexit 1\n' > "$LAB_BIN/python3"; chmod +x "$LAB_BIN/python3"
  ANTES="$(harness_lab_home_hash)"
  SALIDA="$(PATH="$LAB_BIN:$PATH" harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 1 ] && case "$SALIDA" in *python3*) ok "REG-D12 un python3 roto: install sale 1 y lo nombra" ;; *) mal "REG-D12 no nombra python3: $SALIDA" ;; esac || mal "REG-D12 python3 roto: rc $RC: $SALIDA"
  [ "$(harness_lab_home_hash)" = "$ANTES" ] && ok "REG-D12 …sin escribir nada" || mal "REG-D12 escribió en el HOME"
  # REG-LAB · el git del laboratorio se niega a una carpeta vacía o que no existe. `git -C ""` NO cambia de carpeta: opera
  # sobre el repo donde está parado quien llama. El 2026-10-02 un guion cuyo laboratorio no se había armado (variables
  # vacías) creó una rama y dos commits en la copia de trabajo del equipo.
  PARADO="$BASE/reg-lab-parado"; mkdir -p "$PARADO"
  harness_lab_git "$PARADO" init -q -b main && harness_lab_git "$PARADO" commit -q --allow-empty -m base || mal "REG-LAB no pude armar el repo donde pararme"
  ANTES="$(harness_lab_git "$PARADO" rev-parse HEAD)"
  SALIDA="$(cd "$PARADO" && harness_lab_git "" commit -q --allow-empty -m intruso 2>&1)"; RC=$?
  [ "$RC" = 2 ] && [ "$(harness_lab_git "$PARADO" rev-parse HEAD)" = "$ANTES" ] && case "$SALIDA" in *"sin carpeta"*) ok "REG-LAB con la carpeta vacía el git del laboratorio sale 2, lo dice y no commitea donde está parado" ;; *) mal "REG-LAB carpeta vacía: no lo dice: $SALIDA" ;; esac \
    || mal "REG-LAB carpeta vacía: rc $RC, HEAD $(harness_lab_git "$PARADO" rev-parse --short HEAD) (antes ${ANTES:0:7}): $SALIDA"
  SALIDA="$(cd "$PARADO" && harness_lab_git "$BASE/reg-lab-no-existe" checkout -q -b intrusa 2>&1)"; RC=$?
  [ "$RC" = 2 ] && [ "$(harness_lab_git "$PARADO" symbolic-ref --short HEAD)" = main ] && ok "REG-LAB con una carpeta que no existe sale 2 y no cambia la rama de donde está parado" \
    || mal "REG-LAB carpeta inexistente: rc $RC, rama $(harness_lab_git "$PARADO" symbolic-ref --short HEAD): $SALIDA"
  SALIDA="$(cd "$PARADO" && harness_lab_git 2>&1)"; RC=$?
  [ "$RC" = 2 ] && ok "REG-LAB sin argumentos sale 2" || mal "REG-LAB sin argumentos: rc $RC: $SALIDA"
  [ "$(harness_lab_git "$PARADO" rev-list --count HEAD)" = 1 ] && ok "REG-LAB el repo donde estaba parado quedó con su único commit" || mal "REG-LAB el repo quedó con $(harness_lab_git "$PARADO" rev-list --count HEAD) commits"
fi

# ── story 8.16, tanda A · el cierre de `install` dice lo que quedó (AC 8) y lo que hacer si quedó a medias (AC 9) ─────
# El caso (auditoría de la copia publicada, 2026-10-03): `install` mostraba cuatro líneas («piezas escritas: link, state…»)
# y mandaba al registro sólo las últimas tres del aplicador; la persona no veía ni los hooks que le agregaron ni los avisos.
#   S16-T8  · Install_Summary_CountsWarningsBackupLogNextSteps_SecondRunSaysNoChanges
#   S16-T10 · Install_ApplierOrHealthFails_SaysHalfInstalledAndHowToUndo
if corre S16; then
  # la línea (1-based) de la salida donde aparece un texto, o vacío
  linea_de() { printf '%s\n' "$SALIDA" | grep -n -F -- "$1" | head -1 | cut -d: -f1; }
  echo "── S16-T8 · el cierre de install: qué quedó por tipo, los avisos del aplicador, la copia, el registro y qué sigue"
  harness_lab_create "$BASE/s16-t8" >/dev/null
  # un hook que la lista de efectos declara como freno, además del de juguete: «2 hooks (1 puede frenar un comando)»
  harness_lab_publish_hook PreToolUse tycon-pipeline/scripts/hook-pre-edit.js
  harness_lab_git "$LAB_SKILLS" pull -q --ff-only origin main >/dev/null 2>&1
  AVISO='⚠ aviso de juguete: tu core.hooksPath global apunta a otra carpeta'
  SALIDA="$(LAB_APPLIER_WARN="$AVISO" harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "S16-T8 install sale 0" || mal "S16-T8 install salió $RC: $SALIDA"
  N_VER="$(linea_de 'versión: ')"; N_QUE="$(linea_de 'qué quedó:')"; N_AVI="$(linea_de "$AVISO")"
  N_COP="$(linea_de 'copia de respaldo: ')"; N_REG="$(linea_de 'registro: ')"; N_SIG="$(linea_de 'qué sigue:')"
  if [ -n "$N_VER" ] && [ -n "$N_QUE" ] && [ -n "$N_AVI" ] && [ -n "$N_COP" ] && [ -n "$N_REG" ] && [ -n "$N_SIG" ] \
     && [ "$N_VER" -lt "$N_QUE" ] && [ "$N_QUE" -lt "$N_AVI" ] && [ "$N_AVI" -lt "$N_COP" ] && [ "$N_COP" -lt "$N_REG" ] && [ "$N_REG" -lt "$N_SIG" ]; then
    ok "S16-T8 el cierre trae, en orden: versión, qué quedó, los avisos, la copia, el registro y qué sigue"
  else
    mal "S16-T8 el cierre no trae sus partes en orden (versión $N_VER · qué quedó $N_QUE · aviso $N_AVI · copia $N_COP · registro $N_REG · qué sigue $N_SIG): $SALIDA"
  fi
  case "$SALIDA" in *"hooks: 2 (1 puede frenar un comando)"*) ok "S16-T8 cuenta los hooks del reporte y cuántos pueden frenar según la lista de efectos" ;; *) mal "S16-T8 no dice «hooks: 2 (1 puede frenar un comando)»: $SALIDA" ;; esac
  case "$SALIDA" in *"ajustes de settings.json: 2"*) ok "S16-T8 cuenta los dos ajustes" ;; *) mal "S16-T8 no cuenta los dos ajustes: $SALIDA" ;; esac
  # las skills de terceros: el árbol declara cuántas baja el instalador (la lista REAL, copiada al laboratorio) y el
  # aplicador de juguete no baja ninguna: todas quedan pendientes, y el cierre lo dice con el número de la lista
  DECLARADAS="$(j "$LAB_TREE/scripts/publishing/third-party-skills.json" "sum(1 for e in d['third_party'] if e.get('install') == 'download')")"
  [ -n "$DECLARADAS" ] && [ "$DECLARADAS" -gt 0 ] && case "$SALIDA" in *"skills de terceros: 0 en su lugar, $DECLARADAS pendientes"*) ok "S16-T8 cuenta las skills de terceros pendientes desde la lista del árbol ($DECLARADAS)" ;; *) mal "S16-T8 no dice «skills de terceros: 0 en su lugar, $DECLARADAS pendientes»: $SALIDA" ;; esac \
    || mal "S16-T8 el laboratorio no trae la lista de terceros (declaradas: «${DECLARADAS}»)"
  case "$SALIDA" in *"no entregó su reporte"*) mal "S16-T8 con reporte dice que falta: $SALIDA" ;; *) ok "S16-T8 con el reporte del aplicador no avisa que falte" ;; esac
  [ "$(printf '%s\n' "$SALIDA" | grep -c -x -F -- "$AVISO")" = 1 ] && ok "S16-T8 la línea de aviso del aplicador sale tal cual, una vez" || mal "S16-T8 el aviso del aplicador no salió tal cual: $SALIDA"
  case "$SALIDA" in *"lab-applier: registrando hooks"*|*"lab-applier: listo"*) mal "S16-T8 volcó líneas del aplicador que no son avisos" ;; *) ok "S16-T8 no vuelca el resto de la salida del aplicador" ;; esac
  case "$SALIDA" in *"piezas escritas:"*) mal "S16-T8 sigue la línea vieja «piezas escritas: link, state…»" ;; *) ok "S16-T8 ya no imprime «piezas escritas: link, state…»" ;; esac
  COPIA="$(printf '%s\n' "$SALIDA" | sed -n 's/^copia de respaldo: \(.*\) · volver: .*$/\1/p' | head -1)"
  [ -n "$COPIA" ] && [ -d "$COPIA" ] && case "$COPIA" in "$LAB_HOME/.claude/.tycon-pipeline/harness/backups/"*) ok "S16-T8 dice dónde quedó la copia de respaldo, y la carpeta existe" ;; *) mal "S16-T8 la copia no está bajo backups/: $COPIA" ;; esac \
    || mal "S16-T8 no dice una carpeta de copia que exista («${COPIA}»): $SALIDA"
  case "$SALIDA" in *"volver: node ~/.claude/$PLACE_NAME/scripts/setup/harness.js rollback --list"*) ok "S16-T8 …y cómo volver (por el lugar: story 8.19)" ;; *) mal "S16-T8 no dice cómo volver: $SALIDA" ;; esac
  case "$SALIDA" in *"registro: $LAB_HOME/.claude/.tycon-pipeline/harness/startup.log"*) ok "S16-T8 dice la ruta del registro" ;; *) mal "S16-T8 no dice la ruta del registro: $SALIDA" ;; esac
  DESPUES="$(printf '%s\n' "$SALIDA" | sed -n "$((N_SIG + 1)),\$p" | grep -c .)"
  [ "$DESPUES" = 3 ] && ok "S16-T8 «qué sigue» son tres líneas, las últimas" || mal "S16-T8 «qué sigue» tiene $DESPUES líneas: $SALIDA"
  case "$SALIDA" in *"harness.js doctor"*) ok "S16-T8 «qué sigue» nombra doctor" ;; *) mal "S16-T8 «qué sigue» no nombra doctor" ;; esac
  # la segunda corrida
  SALIDA="$(harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$SALIDA" in *"sin cambios"*) ok "S16-T8 la segunda corrida dice «sin cambios»" ;; *) mal "S16-T8 la segunda corrida no dice «sin cambios»: $SALIDA" ;; esac || mal "S16-T8 segunda corrida rc $RC: $SALIDA"
  ANTES_DE="$(printf '%s\n' "$SALIDA" | sed -n 's/^copia de antes de instalar: \(.*\) · volver: .*$/\1/p' | head -1)"
  [ -n "$ANTES_DE" ] && [ "$ANTES_DE" = "$COPIA" ] && ok "S16-T8 …y repite dónde está la copia de antes de instalar (la misma carpeta)" || mal "S16-T8 la segunda corrida no repite la copia de antes de instalar («${ANTES_DE}» vs «${COPIA}»): $SALIDA"
  case "$SALIDA" in *"qué sigue:"*) mal "S16-T8 la segunda corrida repite «qué sigue»" ;; *) ok "S16-T8 la segunda corrida no repite «qué sigue»" ;; esac
  # startup no imprime nada de esto: una línea como mucho
  SALIDA="$(LAB_APPLIER_WARN="$AVISO" harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(printf '%s' "$SALIDA" | grep -c .)" -le 1 ] && ok "S16-T8 startup sigue en una línea como mucho" || mal "S16-T8 startup (rc $RC) imprimió de más: $SALIDA"
  # una lista de efectos rota no se lee como «nada frena». Desde la tanda B (AC 15) ni se instala: sin la lista no hay
  # plan que mostrar, así que sale 2 nombrando el archivo, también con --yes, y no escribe nada
  harness_lab_create "$BASE/s16-t8-rota" >/dev/null
  printf '{ "effects": [' > "$LAB_TREE/scripts/setup/install-effects.json"
  SALIDA="$(harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 2 ] && [ ! -e "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json" ] && case "$SALIDA" in *"install-effects.json"*) true ;; *) false ;; esac \
    && ok "S16-T8 con la lista de efectos rota: 2 nombrando el archivo, sin instalar (tanda B, AC 15)" || mal "S16-T8 lista rota: rc $RC: $SALIDA"

  # un aplicador que acepta --report-json y no escribe el reporte: «qué quedó» cuenta sólo lo del programa, y lo dice
  harness_lab_create "$BASE/s16-t8-sin-reporte" >/dev/null
  SALIDA="$(LAB_APPLIER_NO_REPORT=1 harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$SALIDA" in *"el aplicador no entregó su reporte de piezas"*) ok "S16-T8 sin el reporte del aplicador, el cierre dice que falta contar lo que dejó" ;; *) mal "S16-T8 sin reporte y no lo dice: $SALIDA" ;; esac \
    || mal "S16-T8 sin reporte: rc $RC: $SALIDA"
  case "$SALIDA" in *"hooks: "*) mal "S16-T8 sin reporte contó hooks igual: $SALIDA" ;; *) ok "S16-T8 sin reporte no inventa un conteo de hooks" ;; esac
  # --from-existing (lo llama el aplicador sobre una instalación que ya está) dice lo de siempre: ni cierre ni «qué sigue»
  harness_lab_create "$BASE/s16-t8-existente" >/dev/null
  SALIDA="$(harness install --from-existing 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$SALIDA" in *"piezas escritas: "*) case "$SALIDA" in *"qué sigue:"*|*"qué quedó:"*) mal "S16-T8 --from-existing imprime el cierre nuevo: $SALIDA" ;; *) ok "S16-T8 --from-existing dice lo de siempre («piezas escritas: …»), sin el cierre nuevo" ;; esac ;; *) mal "S16-T8 --from-existing no dice sus piezas: $SALIDA" ;; esac \
    || mal "S16-T8 --from-existing: rc $RC: $SALIDA"
  SALIDA="$(harness install --from-existing 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$SALIDA" in *"copia de antes de instalar"*) false ;; *"sin cambios"*) true ;; *) false ;; esac \
    && ok "S16-T8 --from-existing, segunda vez: «sin cambios», sin la línea de la copia (su salida es la de siempre)" || mal "S16-T8 --from-existing segunda vez (rc $RC): $SALIDA"
  # las piezas compartidas no se cuentan dos veces con un aplicador de antes de la 8.13 D (las reporta él también)
  harness_lab_create "$BASE/s16-t8-viejo" >/dev/null
  SALIDA="$(LAB_APPLIER_OLD=1 harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$SALIDA" in *"ajustes de settings.json: 2"*) ok "S16-T8 con un aplicador viejo, que también reporta las piezas compartidas, los ajustes son 2 y no 4" ;; *) mal "S16-T8 aplicador viejo: no cuenta 2 ajustes: $SALIDA" ;; esac \
    || mal "S16-T8 aplicador viejo: rc $RC: $SALIDA"
  # con el paso de terceros apagado no se cuentan «pendientes»: no va a bajar nada
  harness_lab_create "$BASE/s16-t8-terceros" >/dev/null
  SALIDA="$(TYCON_THIRD_PARTY=0 harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$SALIDA" in *"pendientes"*) false ;; *"skills de terceros: el paso está apagado (TYCON_THIRD_PARTY=0)"*) true ;; *) false ;; esac \
    && ok "S16-T8 con TYCON_THIRD_PARTY=0 el cierre dice que el paso está apagado y no cuenta pendientes" || mal "S16-T8 terceros apagado (rc $RC): $SALIDA"
  # el instalador apagado a propósito: el cierre lo dice, y no habla de un reporte que falta ni de skills pendientes
  harness_lab_create "$BASE/s16-t8-apagado" >/dev/null
  SALIDA="$(TYCON_NO_AUTOINSTALL=1 harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$SALIDA" in *"no entregó su reporte"*|*"pendientes"*) false ;; *"el instalador está apagado (TYCON_NO_AUTOINSTALL=1)"*) true ;; *) false ;; esac \
    && ok "S16-T8 con TYCON_NO_AUTOINSTALL=1 el cierre dice que el instalador está apagado" || mal "S16-T8 instalador apagado (rc $RC): $SALIDA"
  # un aviso de varios renglones sale entero: el renglón marcado y los sangrados que lo siguen
  harness_lab_create "$BASE/s16-t8-aviso-largo" >/dev/null
  AVISO_LARGO="$(printf '%s\n%s' '⚠ git no tiene core.hooksPath global. Activalo con:' '    git config --global core.hooksPath /una/carpeta')"
  SALIDA="$(LAB_APPLIER_WARN="$AVISO_LARGO" harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$SALIDA" in *"Activalo con:"*"    git config --global core.hooksPath /una/carpeta"*) ok "S16-T8 un aviso de dos renglones sale con su comando" ;; *) mal "S16-T8 el aviso largo salió cortado: $SALIDA" ;; esac \
    || mal "S16-T8 aviso largo: rc $RC: $SALIDA"

  echo "── S16-T10 · el aplicador o la salud fallan: «quedó a medias», el registro, la copia y las dos salidas"
  harness_lab_create "$BASE/s16-t10-aplicador" >/dev/null
  SALIDA="$(LAB_APPLIER_FAIL=1 harness install --yes 2>&1)"; RC=$?
  a_medias() { # a_medias <caso>
    [ "$RC" = 1 ] && ok "S16-T10 $1: install sale 1" || mal "S16-T10 $1: rc $RC: $SALIDA"
    case "$SALIDA" in *"quedó a medias"*) ok "S16-T10 $1: dice que la instalación quedó a medias" ;; *) mal "S16-T10 $1: no dice «quedó a medias»: $SALIDA" ;; esac
    case "$SALIDA" in *"harness.js doctor"*) ok "S16-T10 $1: manda a doctor por el detalle" ;; *) mal "S16-T10 $1: no nombra doctor: $SALIDA" ;; esac
    case "$SALIDA" in *"registro: $LAB_HOME/.claude/.tycon-pipeline/harness/startup.log"*) ok "S16-T10 $1: dice el registro" ;; *) mal "S16-T10 $1: no dice el registro: $SALIDA" ;; esac
    local copia; copia="$(printf '%s\n' "$SALIDA" | sed -n 's/^copia de respaldo: \(.*\) · volver: .*$/\1/p' | head -1)"
    [ -n "$copia" ] && [ -d "$copia" ] && ok "S16-T10 $1: dice la copia de respaldo, y existe" || mal "S16-T10 $1: no dice una copia que exista («${copia}»): $SALIDA"
    case "$SALIDA" in *"harness.js install"*"harness.js uninstall"*) ok "S16-T10 $1: da las dos salidas (install otra vez, o uninstall)" ;; *) mal "S16-T10 $1: no da las dos salidas: $SALIDA" ;; esac
    case "$SALIDA" in *"qué sigue:"*) mal "S16-T10 $1: imprime «qué sigue» con la instalación a medias" ;; *) ok "S16-T10 $1: no imprime «qué sigue»" ;; esac
  }
  a_medias "el aplicador sale 1"
  # los avisos que el aplicador alcanzó a dar antes de fallar salen tal cual en el mensaje de «quedó a medias»
  harness_lab_create "$BASE/s16-t10-aviso" >/dev/null
  AVISO_FALLA='⚠ aviso de juguete antes de fallar'
  SALIDA_AVISO="$(LAB_APPLIER_FAIL=1 LAB_APPLIER_WARN="$AVISO_FALLA" harness install --yes 2>&1)"
  [ "$(printf '%s\n' "$SALIDA_AVISO" | grep -c -x -F -- "$AVISO_FALLA")" = 1 ] && case "$SALIDA_AVISO" in *"quedó a medias"*) ok "S16-T10 el aviso que el aplicador dio antes de fallar sale tal cual con «quedó a medias»" ;; *) mal "S16-T10 aviso con falla sin «quedó a medias»: $SALIDA_AVISO" ;; esac \
    || mal "S16-T10 el aviso dado antes de fallar no salió: $SALIDA_AVISO"
  harness_lab_create "$BASE/s16-t10-aplicador" >/dev/null
  SALIDA="$(LAB_APPLIER_FAIL=1 harness install --yes 2>&1)"; RC=$?
  case "$SALIDA" in *"el aplicador salió 1"*) ok "S16-T10 el aplicador sale 1: dice qué falló" ;; *) mal "S16-T10 no dice qué falló: $SALIDA" ;; esac
  [ "$(estado "d['mode']")" = managed ] && ok "S16-T10 el estado quedó escrito (por eso «a medias» y no «nada»)" || mal "S16-T10 el estado no quedó escrito"
  # el cierre manda a `doctor` por el detalle: el estado guarda que falló, y `doctor` —en otra sesión— lo dice en rojo
  [ "$(estado "d['failed']['reason']")" = applier ] && ok "S16-T10 el estado guarda que el aplicador falló" || mal "S16-T10 el estado no guarda la falla: $(estado "d.get('failed')")"
  DOCTOR="$(harness doctor 2>&1)"; RC_DOCTOR=$?
  [ "$RC_DOCTOR" != 0 ] && case "$DOCTOR" in *"✗"*"la instalación quedó a medias"*) ok "S16-T10 doctor, después, lo muestra en rojo como instalación a medias" ;; *) mal "S16-T10 doctor sale $RC_DOCTOR sin la instalación a medias en rojo: $DOCTOR" ;; esac || mal "S16-T10 doctor sale 0 con la instalación a medias: $DOCTOR"
  case "$DOCTOR" in *"última actualización fallida"*) mal "S16-T10 doctor llama «actualización» a una instalación a medias: $DOCTOR" ;; *) ok "S16-T10 doctor no la llama «actualización fallida»" ;; esac
  # el arranque siguiente avisa lo mismo, sin afirmar una vuelta atrás que no hubo
  harness startup >/dev/null 2>&1
  AVISO_ARRANQUE="$(estado "d.get('notice') or ''")"
  case "$AVISO_ARRANQUE" in *"volvió sola"*) mal "S16-T10 el arranque afirma una vuelta atrás que no hubo: $AVISO_ARRANQUE" ;; *"la instalación quedó a medias"*"install otra vez"*) ok "S16-T10 el arranque siguiente avisa «la instalación quedó a medias» y cómo retomarla" ;; *) mal "S16-T10 el aviso del arranque no dice la instalación a medias: «${AVISO_ARRANQUE}»" ;; esac
  # la salida que el propio cierre ofrece —«install otra vez»— tiene que HACER algo: retoma el aplicador y la salud, no
  # dice «sin cambios» (pase adversarial de la tanda A: la segunda corrida caía en el atajo y salía 0 sin correr nada)
  N_ANTES="$(grep -c '^run check=0' "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log" 2>/dev/null || echo 0)"
  SALIDA="$(LAB_APPLIER_FAIL=1 harness install --yes 2>&1)"; RC=$?
  N_DESPUES="$(grep -c '^run check=0' "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log" 2>/dev/null || echo 0)"
  [ "$RC" = 1 ] && [ "$N_DESPUES" = $((N_ANTES + 1)) ] && case "$SALIDA" in *"sin cambios"*) false ;; *"quedó a medias"*) true ;; *) false ;; esac \
    && ok "S16-T10 «install otra vez» con el aplicador todavía roto: lo vuelve a correr y sale 1, no «sin cambios»" || mal "S16-T10 install otra vez (roto): rc $RC, corridas ${N_ANTES}→${N_DESPUES}: $SALIDA"
  SALIDA="$(harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(grep -c '^run check=0' "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log")" = $((N_DESPUES + 1)) ] && case "$SALIDA" in *"sin cambios"*) false ;; *"qué quedó:"*"qué sigue:"*) true ;; *) false ;; esac \
    && ok "S16-T10 «install otra vez» con el aplicador sano: corre el aplicador y la salud, y da el cierre completo" || mal "S16-T10 install otra vez (sano): rc $RC: $SALIDA"
  [ "$(estado "d.get('failed')")" = None ] && ok "S16-T10 …y el estado deja de decir que el aplicador falló" || mal "S16-T10 el estado sigue con failed: $(estado "d.get('failed')")"
  SALIDA="$(harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$SALIDA" in *"sin cambios"*) ok "S16-T10 …y la corrida siguiente, ya sana, sí dice «sin cambios»" ;; *) mal "S16-T10 la corrida siguiente no dice «sin cambios»: $SALIDA" ;; esac || mal "S16-T10 corrida siguiente: rc $RC: $SALIDA"
  harness_lab_create "$BASE/s16-t10-salud" >/dev/null
  harness_lab_publish_hook PreToolUse tycon-pipeline/deny.js 'console.log(JSON.stringify({decision:"block"}));process.exit(2);'
  harness_lab_git "$LAB_SKILLS" pull -q --ff-only origin main >/dev/null 2>&1
  SALIDA="$(harness install --yes 2>&1)"; RC=$?
  a_medias "la salud no pasa"
  case "$SALIDA" in *"comprobación de salud no pasó"*) ok "S16-T10 la salud no pasa: dice qué falló" ;; *) mal "S16-T10 no dice que falló la salud: $SALIDA" ;; esac
  # «install otra vez» también retoma el camino de la salud: con el hook todavía roto vuelve a salir 1; arreglado el
  # hook, corre el aplicador y la salud y da el cierre completo; y recién la siguiente dice «sin cambios»
  SALIDA="$(harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 1 ] && case "$SALIDA" in *"sin cambios"*) false ;; *"comprobación de salud no pasó"*"quedó a medias"*) true ;; *) false ;; esac \
    && ok "S16-T10 «install otra vez» con la salud todavía rota: la vuelve a correr y sale 1, no «sin cambios»" || mal "S16-T10 install otra vez (salud rota): rc $RC: $SALIDA"
  printf 'process.exit(0);\n' > "$LAB_SKILLS/skills/tycon-pipeline/deny.js"
  N_ANTES="$(grep -c '^run check=0' "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log" 2>/dev/null || echo 0)"
  SALIDA="$(harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(grep -c '^run check=0' "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log")" = $((N_ANTES + 1)) ] && case "$SALIDA" in *"sin cambios"*) false ;; *"qué quedó:"*"qué sigue:"*) true ;; *) false ;; esac \
    && ok "S16-T10 «install otra vez» con la salud arreglada: corre el aplicador y la salud, y da el cierre completo" || mal "S16-T10 install otra vez (salud arreglada): rc $RC: $SALIDA"
  [ "$(estado "d.get('failed')")" = None ] && ok "S16-T10 …y el estado deja de decir que la instalación falló" || mal "S16-T10 el estado sigue con failed: $(estado "d.get('failed')")"
  SALIDA="$(harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$SALIDA" in *"sin cambios"*) ok "S16-T10 …y la corrida siguiente, ya sana, dice «sin cambios»" ;; *) mal "S16-T10 la corrida siguiente (salud) no dice «sin cambios»: $SALIDA" ;; esac || mal "S16-T10 corrida siguiente (salud): rc $RC: $SALIDA"
fi

# ═══ S16B-T27 · Applier_Standalone_Startup_Apply_NeverAsk_Contracts813Intact (story 8.16, tanda B · AC 44) ════════════
# Desde la tanda B `install` pregunta; nada más pregunta nada nuevo: el aplicador suelto (con y sin --check), `startup`,
# `apply`, `rollback` y `uninstall` sin terminal hacen lo de siempre y su salida no trae ninguna pregunta ni pide --yes
# (salvo la línea de siempre de `uninstall`, de la 8.13).
if corre S16B; then
  echo "S16B-T27 · ninguna pregunta nueva fuera de install"
  harness_lab_create "$BASE/s16b-t27" >/dev/null
  harness install --yes >/dev/null 2>&1 < /dev/null || mal "S16B-T27 install --yes previo falló"
  for cmd in "applier" "applier-check" "startup --force" "apply" "rollback --list" "uninstall"; do
    RC=0
    case "$cmd" in
      applier)       SALIDA="$(bash "$LAB_TREE/scripts/install-tycon-hooks.sh" 2>&1 < /dev/null)" || RC=$? ;;
      applier-check) SALIDA="$(bash "$LAB_TREE/scripts/install-tycon-hooks.sh" --check 2>&1 < /dev/null)" || RC=$? ;;
      *)             SALIDA="$(harness $cmd 2>&1 < /dev/null)" || RC=$? ;;
    esac
    case "$cmd" in
      uninstall) [ "$RC" = 2 ] && [ "$(printf '%s' "$SALIDA" | grep -c '¿')" = 0 ] && case "$SALIDA" in *"sin --yes y sin terminal no hago nada (harness.js uninstall --yes)"*) true ;; *) false ;; esac \
                   && ok "S16B-T27 uninstall sin terminal: 2 con la línea de la 8.13, sin pregunta" || mal "S16B-T27 uninstall (rc $RC): $SALIDA" ;;
      *)         [ "$RC" = 0 ] && [ "$(printf '%s' "$SALIDA" | grep -c -e '¿' -e '--yes')" = 0 ] \
                   && ok "S16B-T27 ${cmd} sin terminal: sale 0 sin preguntar ni pedir --yes" || mal "S16B-T27 ${cmd} (rc $RC): $SALIDA" ;;
    esac
  done
fi

# ── RELOCATE (story 8.19, tanda B · AC 17): después de `relocate`, el aplicador REAL no vuelve a agregar ningún hook y
# los hooks del arnés son los mismos (profile-equivalence --settings da 0) — la única red contra «relocate deja un hook
# que el aplicador no reconoce y registra otra vez» (pase adversarial de la tanda B, C4). La máquina registra los hooks
# por el nombre viejo como la de una persona que corrió el aplicador por el enlace viejo: se arma con `--reroot` de la
# ruta real al nombre viejo.
if corre RELOCATE; then
  if ! harness_lab_team_machine "$BASE/trel" real >/dev/null; then mal "RELOCATE no pude armar la máquina del equipo de laboratorio"; else
  harness_lab_isolated harness install --yes >/dev/null 2>&1 || mal "RELOCATE install previo falló"
  harness_lab_real_applier >/dev/null 2>&1
  REL_OLD="$LAB_HOME/.claude/$LEGACY_PLACE_NAME"; REL_PLACE="$LAB_HOME/.claude/$PLACE_NAME"
  node -e 'const fs=require("fs");const [t,p,o]=process.argv.slice(1);const ty=process.platform==="win32"?"junction":"dir";for(const a of [p,o]){try{fs.unlinkSync(a)}catch(_){try{fs.rmdirSync(a)}catch(_){}}}fs.symlinkSync(t,p,ty);fs.symlinkSync(p,o,ty)' "$LAB_TREE" "$REL_PLACE" "$REL_OLD"
  for d in "$LAB_TREE" "$(node -p 'require("fs").realpathSync(process.argv[1])' "$LAB_TREE")"; do
    harness_lab_isolated node "$LAB_TREE/scripts/lib/legacy-names.js" --migrate-machine --reroot "$d" "$REL_OLD" --home "$LAB_HOME" >/dev/null 2>&1
  done
  N_OLD="$(grep -c "/.claude/$LEGACY_PLACE_NAME/" "$TYCON_SETTINGS_PATH")"
  cp "$TYCON_SETTINGS_PATH" "$BASE/trel-before.json"
  HOOKS_BEFORE="$(harness_lab_settings_commands | wc -l | tr -d ' ')"
  SALIDA="$(harness_lab_isolated harness relocate 2>&1)"; RC=$?
  [ "${N_OLD:-0}" -gt 0 ] && [ "$RC" = 0 ] && [ "$(grep -c "/.claude/$LEGACY_PLACE_NAME/" "$TYCON_SETTINGS_PATH")" = 0 ] \
    && ok "RELOCATE la máquina con $N_OLD línea(s) por el nombre viejo: relocate 0 y ninguna queda" || mal "RELOCATE relocate (rc $RC, por el viejo antes $N_OLD): $SALIDA"
  APPLIED="$(harness_lab_real_applier 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ! printf '%s\n' "$APPLIED" | grep -q '^ADDED:' && [ "$(harness_lab_settings_commands | wc -l | tr -d ' ')" = "$HOOKS_BEFORE" ] \
    && ok "RELOCATE el aplicador real después de relocate: no agrega ningún hook ($HOOKS_BEFORE, los mismos)" || mal "RELOCATE el aplicador (rc $RC) agregó: $(printf '%s\n' "$APPLIED" | grep -A3 '^ADDED:' | head -4) · hooks $(harness_lab_settings_commands | wc -l | tr -d ' ') (antes $HOOKS_BEFORE)"
  [ "$(harness_lab_settings_commands | sort | uniq -d | wc -l | tr -d ' ')" = 0 ] && ok "RELOCATE ningún hook repetido" || mal "RELOCATE repetidos: $(harness_lab_settings_commands | sort | uniq -d | head -3)"
  EQ="$(node "$RAIZ/scripts/publishing/profile-equivalence.js" --settings "$BASE/trel-before.json" "$TYCON_SETTINGS_PATH" 2>&1)"; RC=$?
  # los mismos hooks del arnés (por evento, matcher, nombre y valor): lo único que cambia es la raíz del comando, del
  # nombre viejo al lugar (en esta máquina estaban todos por el viejo; en una real, los de la ruta real dan 0)
  EQ_OTHER="$(printf '%s\n' "$EQ" | grep '^❌' | grep -v 'diferencia(s) en los hooks' | grep -v "cambió el comando: «[^»]*/\.claude/$LEGACY_PLACE_NAME/[^»]*» → «[^»]*/\.claude/$PLACE_NAME/" | head -3)"
  EQ_COUNTS="$(printf '%s\n' "$EQ" | grep -o 'antes [0-9]* (.*después [0-9]*' | sed -E 's/antes ([0-9]+) .*después ([0-9]+)/\1 \2/')"
  [ "$RC" -le 1 ] && [ -z "$EQ_OTHER" ] && [ "${EQ_COUNTS% *}" = "${EQ_COUNTS#* }" ] && [ -n "$EQ_COUNTS" ] \
    && ok "RELOCATE profile-equivalence --settings: los mismos hooks del arnés ($EQ_COUNTS); sólo cambió la raíz, del viejo al lugar" || mal "RELOCATE profile-equivalence (rc $RC, $EQ_COUNTS): $EQ_OTHER"
  fi
fi

# ═══ T79 · MaintainerMachine_…_HooksPathElsewhereWarned (story 8.26, tanda H1c · AC 65 e) ═════════════════════════════
# El caso: los hooks de git del arnés —entre ellos el pre-push, el freno antes de publicar— corren sólo si la carpeta
# GLOBAL de hooks de git es la que el instalador llena. El instalador avisaba únicamente cuando git no tenía ninguna:
# con OTRA (la de otra herramienta, una vieja) llenaba la suya, no decía nada, y ningún hook del arnés corría.
# Lo que no se puede perder — el aplicador REAL sobre la máquina de laboratorio, con la configuración global de git en
# un archivo propio (`GIT_CONFIG_GLOBAL`: nunca la de quien corre la prueba):
#   · git no tiene ninguna          → el aviso de siempre, con su comando (también con --check);
#   · es la del instalador          → calla: escrita entera, con `~`, por un enlace (también uno que no es la última
#                                     carpeta de la ruta), con otras mayúsculas en un disco que no las distingue, o puesta
#                                     desde un archivo incluido;
#   · git no contesta (sale con un código que no es «la clave no está») → «no pude leer», con el código y lo que git
#                                     dijo: nunca «git no tiene ninguna»;
#   · es otra                       → avisa con las DOS rutas y el comando (también con --check);
#   · apunta a una que no existe    → su aviso propio;
#   · es relativa                   → «no pude comparar», con el motivo y los dos valores;
#   · con los hooks de git apagados (TYCON_NO_GIT_HOOKS=1) no se mira nada, como el aviso de siempre;
#   · y en NINGÚN caso el instalador cambia la configuración: el archivo queda byte a byte.
# El gemelo de Windows se mide en installer-ps1.test.sh, sección (gh).
if corre T79; then
  echo "T79 · el aviso de la carpeta global de hooks de git: cuatro respuestas, y nunca la cambia"
  if ! harness_lab_team_machine "$BASE/t79" real >/dev/null; then mal "T79 no pude armar la máquina del equipo de laboratorio"; else
  [ "$HOME" = "$LAB_HOME" ] && [ "$HOME" != "${REAL_HOME:-}" ] || { echo "❌ harness-install: T79 la HOME no es la de juguete (${HOME})"; exit 1; }
  # las carpetas y la configuración de git de cada caso, fuera de la HOME de juguete
  GH_DIR="$LAB/global-hooks"; mkdir -p "$GH_DIR" || mal "T79 no pude crear la carpeta de los casos"
  OURS="$TYCON_GIT_HOOKS_DIR"; GH_CFG="$GH_DIR/gitconfig"
  # gh_set <valor o vacío>: la configuración global de git del caso, y su copia para comparar después
  gh_set() { : > "$GH_CFG"; [ -z "${1:-}" ] || git config --file "$GH_CFG" core.hooksPath "$1"; cp "$GH_CFG" "$GH_CFG.before"; }
  gh_run() { SALIDA="$(GIT_CONFIG_GLOBAL="$GH_CFG" harness_lab_real_applier "$@" 2>&1 < /dev/null)"; RC=$?; }
  # lo que el instalador dijo de la carpeta global: el renglón que la nombra y los sangrados que lo siguen
  gh_said() { printf '%s\n' "$SALIDA" | awk '/core\.hooksPath global/ { on = 1; print; next } on && /^    [^ ]/ { print; next } { on = 0 }'; }
  gh_same() { cmp -s "$GH_CFG" "$GH_CFG.before"; }
  gh_brief() { gh_said | tr '\n' '|' | cut -c1-600; }
  # gh_quiet <caso>: sale 0, no dice nada de la carpeta global y no toca la configuración
  gh_quiet() {
    [ "$RC" = 0 ] && [ -z "$(gh_said)" ] && gh_same && ok "T79 $1: calla, y no toca la configuración de git" \
      || mal "T79 $1 (rc $RC, configuración $(gh_same && echo igual || echo CAMBIADA)): dijo «$(gh_brief)»"
  }
  # gh_warned <caso> <lo que git usa> <texto de la cabecera>…: UN aviso con esa cabecera, las dos rutas y el comando; la
  # configuración queda byte a byte
  gh_warned() {
    local name="$1" uses="$2" said head good=1; shift 2
    said="$(gh_said)"
    [ "$RC" = 0 ] && [ "$(printf '%s\n' "$said" | grep -c 'core\.hooksPath global')" = 1 ] || good=0
    for head in "$@"; do case "$(printf '%s\n' "$said" | head -1)" in *"$head"*) ;; *) good=0 ;; esac; done
    [ "$(printf '%s\n' "$said" | grep -c -x -F -- "    git usa:             ${uses}")" = 1 ] || good=0
    [ "$(printf '%s\n' "$said" | grep -c -x -F -- "    el instalador llena: ${OURS}")" = 1 ] || good=0
    [ "$(printf '%s\n' "$said" | grep -c -x -F -- "    para apuntarlo:      git config --global core.hooksPath \"${OURS}\"")" = 1 ] || good=0
    gh_same || good=0
    [ "$good" = 1 ] && ok "T79 ${name}: avisa una vez, con las dos rutas y el comando, y no toca la configuración de git" \
      || mal "T79 ${name} (rc $RC, configuración $(gh_same && echo igual || echo CAMBIADA)): dijo «$(gh_brief)»"
  }

  # git no tiene ninguna: el aviso de siempre (esta primera corrida, además, deja los hooks en la carpeta del instalador)
  gh_set ""; gh_run
  HOY="$(printf '%s\n%s' '⚠ git no tiene core.hooksPath global — los hooks del arnés NO corren. Activalo con:' "    git config --global core.hooksPath ${OURS}")"
  [ "$RC" = 0 ] && [ "$(gh_said)" = "$HOY" ] && gh_same && [ -f "$OURS/pre-push" ] \
    && ok "T79 git no tiene ninguna: el aviso de siempre con su comando, y el pre-push queda en la carpeta del instalador" \
    || mal "T79 git no tiene ninguna (rc $RC, pre-push $([ -f "$OURS/pre-push" ] && echo puesto || echo FALTA)): dijo «$(gh_brief)»"
  gh_run --check
  [ "$RC" = 0 ] && [ "$(gh_said)" = "$HOY" ] && gh_same && ok "T79 git no tiene ninguna, con --check: el mismo aviso" || mal "T79 ninguna con --check (rc $RC): dijo «$(gh_brief)»"

  # es la del instalador: calla
  gh_set "$OURS"; gh_run; gh_quiet "es la del instalador (la ruta entera)"
  if [ "$OURS" = "$HOME/.git-hooks" ]; then
    gh_set '~/.git-hooks'; gh_run; gh_quiet "es la del instalador (escrita con ~)"
  else mal "T79 la carpeta del instalador del laboratorio no es ~/.git-hooks (${OURS}): no pude medir el caso con ~"; fi
  ln -s "$OURS" "$GH_DIR/enlace" || mal "T79 no pude crear el enlace a la carpeta del instalador"
  gh_set "$GH_DIR/enlace"; gh_run; gh_quiet "es un enlace a la del instalador (la misma carpeta)"
  # …y alcanzada por un enlace que no es la última carpeta de la ruta (la HOME por un enlace): también es la misma
  ln -s "$(dirname "$OURS")" "$GH_DIR/casa" || mal "T79 no pude crear el enlace intermedio"
  gh_set "$GH_DIR/casa/$(basename "$OURS")"; gh_run; gh_quiet "es la del instalador alcanzada por un enlace intermedio"
  OURS_UPPER="$(dirname "$OURS")/$(basename "$OURS" | tr '[:lower:]' '[:upper:]')"
  if [ "$OURS_UPPER" != "$OURS" ] && [ "$OURS_UPPER" -ef "$OURS" ]; then
    gh_set "$OURS_UPPER"; gh_run; gh_quiet "es la del instalador escrita con otras mayúsculas (este disco no las distingue)"
  else echo "  ⏭ NO MEDIDO — T79 otras mayúsculas: este disco las distingue (${OURS_UPPER} no es ${OURS})"; fi
  # puesta desde un archivo incluido: `git config --global` no sigue los `include` si no se le pide
  git config --file "$GH_DIR/incluido" core.hooksPath "$OURS" && : > "$GH_CFG" && git config --file "$GH_CFG" include.path "$GH_DIR/incluido" && cp "$GH_CFG" "$GH_CFG.before" \
    || mal "T79 no pude armar la configuración con un archivo incluido"
  gh_run; gh_quiet "es la del instalador, puesta desde un archivo incluido"
  # un git de antes de 2.18 no conoce `--type=path`: el valor se toma tal cual, con el `~` expandido
  mkdir -p "$GH_DIR/old-git" \
    && printf '#!/bin/sh\n# un git que no conoce --type=path (laboratorio)\nfor a in "$@"; do case "$a" in --type=path) echo "error: unknown option" >&2; exit 129 ;; esac; done\nexec "%s" "$@"\n' "$(command -v git)" > "$GH_DIR/old-git/git" \
    && chmod +x "$GH_DIR/old-git/git" || mal "T79 no pude armar el git de antes"
  if [ "$OURS" = "$HOME/.git-hooks" ]; then
    gh_set '~/.git-hooks'; PATH="$GH_DIR/old-git:$PATH" gh_run; gh_quiet "es la del instalador escrita con ~, con un git que no conoce --type=path"
  fi
  # git ya apunta a la carpeta del instalador y esa carpeta todavía no existe (se mira antes de instalar): es la del
  # instalador, no «otra» ni «una que no existe» (el instalador ya dice aparte que sus hooks faltan)
  gh_set "$GH_DIR/todavia-no"; TYCON_GIT_HOOKS_DIR="$GH_DIR/todavia-no" gh_run --check
  gh_quiet "es la del instalador, que todavía no existe (con --check)"
  [ ! -e "$GH_DIR/todavia-no" ] && ok "T79 …y --check no la crea" || mal "T79 --check creó la carpeta del instalador (${GH_DIR}/todavia-no)"

  # es otra: las dos rutas y el comando
  mkdir -p "$GH_DIR/otra" || mal "T79 no pude crear la otra carpeta de hooks"
  gh_set "$GH_DIR/otra"; gh_run
  gh_warned "es otra" "$GH_DIR/otra" "apunta a OTRA carpeta" "NO corren" "freno antes de publicar"
  gh_run --check
  gh_warned "es otra, con --check" "$GH_DIR/otra" "apunta a OTRA carpeta" "NO corren" "freno antes de publicar"
  # con los hooks de git apagados no se mira nada (las mismas condiciones que el aviso de siempre)
  TYCON_NO_GIT_HOOKS=1 gh_run; gh_quiet "es otra, con TYCON_NO_GIT_HOOKS=1"

  # apunta a una carpeta que no existe
  gh_set "$GH_DIR/no-esta"; gh_run
  gh_warned "no existe" "$GH_DIR/no-esta" "carpeta que NO existe" "NO corren" "freno antes de publicar"
  [ ! -e "$GH_DIR/no-esta" ] && ok "T79 no existe: el instalador no la crea" || mal "T79 no existe: el instalador creó ${GH_DIR}/no-esta"

  # relativa: cada repo usa la suya, no hay con qué comparar
  gh_set ".githooks"; gh_run
  gh_warned "relativa" ".githooks" "no pude comparar" "relativa" "freno antes de publicar"

  # git no contesta: no es «git no tiene carpeta global de hooks». Con un git cuya lectura de la clave sale con otro
  # código (acá 128, lo que da una configuración rota) el instalador dice que no pudo leerla, con el código y lo que git
  # dijo, y no afirma nada más (ni «no tiene», ni «es otra»)
  mkdir -p "$GH_DIR/broken-git" \
    && printf '#!/bin/sh\n# un git cuya lectura de la carpeta global de hooks falla (laboratorio)\ncase "$*" in *config*--global*core.hooksPath*) echo "fatal: configuracion rota (laboratorio)" >&2; exit 128 ;; esac\nexec "%s" "$@"\n' "$(command -v git)" > "$GH_DIR/broken-git/git" \
    && chmod +x "$GH_DIR/broken-git/git" || mal "T79 no pude armar el git que falla"
  gh_unread() { # gh_unread <caso>: UN aviso «no pude leer» con el código, lo que git dijo y la carpeta del instalador
    local said good=1; said="$(gh_said)"
    [ "$RC" = 0 ] && [ "$(printf '%s\n' "$said" | grep -c 'core\.hooksPath global')" = 1 ] || good=0
    case "$(printf '%s\n' "$said" | head -1)" in *"no pude leer la carpeta global de hooks de git"*"git config salió 128"*) ;; *) good=0 ;; esac
    [ "$(printf '%s\n' "$said" | grep -c -x -F -- '    git dijo:            fatal: configuracion rota (laboratorio)')" = 1 ] || good=0
    [ "$(printf '%s\n' "$said" | grep -c -x -F -- "    el instalador llena: ${OURS}")" = 1 ] || good=0
    case "$SALIDA" in *"git no tiene core.hooksPath global"*|*"apunta a OTRA carpeta"*|*"Activalo con"*) good=0 ;; esac
    gh_same || good=0
    [ "$good" = 1 ] && ok "T79 $1: dice que no pudo leerla, con el código y lo que git dijo, y no afirma que git no tenga ninguna" \
      || mal "T79 $1 (rc $RC): dijo «$(gh_brief)»"
  }
  gh_set "$GH_DIR/otra"; PATH="$GH_DIR/broken-git:$PATH" gh_run; gh_unread "git falla al leer la clave (sale 128)"
  PATH="$GH_DIR/broken-git:$PATH" gh_run --check; gh_unread "git falla al leer la clave, con --check"

  # otra que está y no se deja leer: es otra igual (se compara qué carpeta es, sin entrar), y el instalador no se corta
  if [ "$(id -u)" = 0 ]; then echo "  ⏭ NO MEDIDO — T79 una carpeta que no se deja leer: corriendo como root no hay"; else
    mkdir -p "$GH_DIR/cerrada" && chmod 000 "$GH_DIR/cerrada"
    gh_set "$GH_DIR/cerrada"; gh_run
    chmod 755 "$GH_DIR/cerrada"
    gh_warned "es otra que no se deja leer" "$GH_DIR/cerrada" "apunta a OTRA carpeta" "NO corren"
  fi
  fi
fi

# ═══ HP · Apply_GitWithoutGlobalHooksDir_SetsIt_DoctorStopsWarning (2026-10-14) ═══════════════════════════════════════
# El caso real: Windows 11, versión bajada, mudada desde un clon. `doctor` decía «el pre-push del arnés NO está puesto: git
# no tiene carpeta global de hooks (core.hooksPath) — harness.js apply lo pone»; el dev corrió `apply`, actualizó, y el
# aviso seguía igual: el aplicador (los dos guiones) sólo avisa y nunca toca esa clave, y nada más la ponía. Las máquinas
# sin el aviso la tenían puesta a mano, del alta de cuando se instalaba desde un clon.
# Lo que no se puede perder — `harness.js` con el aplicador REAL, y la configuración global de git en un archivo del
# laboratorio (`GIT_CONFIG_GLOBAL`: nunca la de quien corre la prueba):
#   · `install` sobre git sin ninguna la pone (la carpeta del instalador, con el pre-push del arnés adentro) y lo dice;
#   · `apply` sobre una máquina sin ella (la mudada) la pone, y `doctor` deja de avisar el pre-push;
#   · el arranque (`startup --force`) no la pone: sólo lo que pide una persona;
#   · otra carpeta, `TYCON_NO_GIT_HOOKS=1` y un git que no deja escribir la configuración: no se pisa nada (con el último,
#     el aviso dice que no pudo, con el comando a mano);
#   · el perfil mínimo y `uninstall` la sacan si sigue siendo la que puso el arnés; si la persona la cambió, no.
if corre HP; then
  echo "HP · la carpeta global de hooks de git: install y apply la ponen, y nada más"
  if ! harness_lab_team_machine "${BASE}/hp" real >/dev/null; then mal "HP no pude armar la máquina del equipo de laboratorio"; else
  [ "${HOME}" = "${LAB_HOME}" ] && [ "${HOME}" != "${REAL_HOME:-}" ] || { echo "❌ harness-install: HP la HOME no es la de juguete (${HOME})"; exit 1; }
  HP_CFG="${LAB}/hp-gitconfig"; : > "${HP_CFG}"
  HP_OURS="${TYCON_GIT_HOOKS_DIR}"
  hp() { SALIDA="$(GIT_CONFIG_GLOBAL="${HP_CFG}" harness_lab_isolated harness "$@" 2>&1 < /dev/null)"; RC=$?; }
  hp_value() { GIT_CONFIG_GLOBAL="${HP_CFG}" git config --global --get core.hooksPath; }
  hp_unset() { GIT_CONFIG_GLOBAL="${HP_CFG}" git config --global --unset core.hooksPath 2>/dev/null; true; }
  hp_said_set() { printf '%s\n' "${SALIDA}" | grep -c 'git usa ahora la carpeta global de hooks del arnés'; }
  hp_doctor_warns() { GIT_CONFIG_GLOBAL="${HP_CFG}" harness_lab_isolated harness doctor 2>&1 < /dev/null | grep -c 'pre-push del arnés NO'; }

  # install sobre git sin carpeta global: la pone, con el pre-push del arnés adentro, y lo dice una vez (sin el aviso viejo)
  hp install --yes
  [ "${RC}" = 0 ] && [ "$(hp_value)" = "${HP_OURS}" ] && grep -q 'git-pre-push-global.sh' "${HP_OURS}/pre-push" && [ "$(hp_said_set)" = 1 ] \
    && ! printf '%s' "${SALIDA}" | grep -q 'git no tiene core.hooksPath global' \
    && ok "HP install sobre git sin carpeta global: la pone en la del instalador y lo dice, sin el aviso de «no tiene»" \
    || mal "HP install (rc ${RC}, core.hooksPath=«$(hp_value)»): $(printf '%s' "${SALIDA}" | grep -i 'hooks' | head -3 | tr '\n' '|')"
  [ "$(estado "(d.get('git_hooks_path') or {}).get('value')")" = "${HP_OURS}" ] && ok "HP …y la anota en el estado (la saca uninstall)" || mal "HP el estado no anota la carpeta: $(estado "d.get('git_hooks_path')")"

  # la puso el arnés y la persona la sacó: el arranque no la vuelve a poner, ni con la política auto
  hp_unset
  TYCON_UPDATE_APPLY=auto hp startup --force
  [ -z "$(hp_value)" ] && ok "HP si la puso el arnés y la persona la sacó, el arranque no la vuelve a poner" || mal "HP el arranque volvió a poner la que la persona sacó: «$(hp_value)»"
  [ "$(hp_doctor_warns)" = 1 ] && ok "HP sin la clave, doctor avisa que el pre-push no está puesto" || mal "HP doctor sin la clave no avisó el pre-push"

  # una máquina YA instalada sin la carpeta, que el arnés nunca puso (la mudada, o instalada antes de este arreglo): el
  # caso que pidió el dueño — que sea transparente, sin que el dev corra nada
  hp_forget() { python3 -c 'import json,sys; f=sys.argv[1]; d=json.load(open(f)); d.pop("git_hooks_path", None); json.dump(d, open(f, "w"), indent=2)' "${LAB_HOME}/.claude/.tycon-pipeline/harness-state.json"; }
  hp_notice() { estado "d.get('notice') or ''"; }
  hp_forget
  # con la política ask: el arranque no la pone, y el aviso la pide; update --yes (con terminal, como pide ask) la pone
  TYCON_UPDATE_APPLY=ask hp startup --force
  [ -z "$(hp_value)" ] && case "$(hp_notice)" in *"falta la carpeta global de hooks de git"*"update --yes la pone"*) true ;; *) false ;; esac \
    && ok "HP con ask, el arranque no la pone y el aviso la pide (update --yes)" || mal "HP ask: core.hooksPath=«$(hp_value)» aviso=«$(hp_notice)»"
  SALIDA="$(harness_lab_pty - env GIT_CONFIG_GLOBAL="${HP_CFG}" TYCON_UPDATE_APPLY=ask TYCON_THIRD_PARTY=0 TYCON_NO_AZ_PROJECTS_REFRESH=1 TYCON_NO_UPLOAD_RUNS=1 TYCON_NO_DOWNLOAD_RUNS=1 TYCON_NO_COLLECT_FINDINGS=1 node "${LAB_TREE}/scripts/setup/harness.js" update --yes 2>&1)"; RC=$?
  [ "$(hp_value)" = "${HP_OURS}" ] && [ "$(hp_said_set)" = 1 ] && case "$(hp_notice)" in *"falta la carpeta global"*) false ;; *) true ;; esac \
    && ok "HP con ask, update --yes la pone, lo dice, y el aviso deja de pedirla" || mal "HP ask update --yes (rc ${RC}, core.hooksPath=«$(hp_value)», aviso «$(hp_notice)»): ${SALIDA}"
  # con la política auto (la del perfil del equipo): la pone el arranque y lo dice UNA vez en el aviso
  hp_unset; hp_forget
  TYCON_UPDATE_APPLY=auto hp startup --force
  [ "$(hp_value)" = "${HP_OURS}" ] && case "$(hp_notice)" in *"el arnés puso la carpeta global de hooks de git"*) true ;; *) false ;; esac \
    && [ "$(estado "(d.get('git_hooks_path') or {}).get('value')")" = "${HP_OURS}" ] \
    && ok "HP con auto, el arranque la pone, la anota y lo dice en el aviso" || mal "HP auto: core.hooksPath=«$(hp_value)» aviso=«$(hp_notice)»"
  TYCON_UPDATE_APPLY=auto hp startup --force
  case "$(hp_notice)" in *"carpeta global de hooks"*) mal "HP el arranque siguiente lo repite: «$(hp_notice)»" ;; *) ok "HP …y el arranque siguiente ya no lo repite (una sola vez)" ;; esac
  hp_unset

  # el caso real: apply sobre la máquina sin la clave la pone, y doctor deja de avisar
  hp apply
  [ "${RC}" = 0 ] && [ "$(hp_value)" = "${HP_OURS}" ] && [ "$(hp_said_set)" = 1 ] \
    && ok "HP apply sobre git sin carpeta global (la máquina mudada): la pone y lo dice" || mal "HP apply (rc ${RC}, core.hooksPath=«$(hp_value)»): ${SALIDA}"
  [ "$(hp_doctor_warns)" = 0 ] && ok "HP …y doctor deja de avisar el pre-push" || mal "HP después de apply, doctor sigue avisando el pre-push"
  hp apply
  [ "${RC}" = 0 ] && [ "$(hp_said_set)" = 0 ] && [ "$(hp_value)" = "${HP_OURS}" ] && ok "HP un segundo apply no la toca ni lo repite" || mal "HP segundo apply (rc ${RC}): ${SALIDA}"

  # otra carpeta: no se pisa (byte a byte), y doctor no manda a apply
  mkdir -p "${LAB}/hp-otra"
  : > "${HP_CFG}"; GIT_CONFIG_GLOBAL="${HP_CFG}" git config --global core.hooksPath "${LAB}/hp-otra"; cp "${HP_CFG}" "${HP_CFG}.before"
  hp apply
  [ "${RC}" = 0 ] && cmp -s "${HP_CFG}" "${HP_CFG}.before" && [ "$(hp_said_set)" = 0 ] && ok "HP con otra carpeta, apply no la toca" || mal "HP otra carpeta (rc ${RC}): configuración $(cmp -s "${HP_CFG}" "${HP_CFG}.before" && echo igual || echo CAMBIADA)"
  HP_DOC="$(GIT_CONFIG_GLOBAL="${HP_CFG}" harness_lab_isolated harness doctor 2>&1 < /dev/null | grep 'pre-push del arnés NO')"
  case "${HP_DOC}" in *"apply no la cambia"*"git config --global core.hooksPath \"${HP_OURS}\""*) ok "HP …y doctor dice que apply no la cambia, con el comando para apuntarla" ;; *) mal "HP doctor con otra carpeta: «${HP_DOC}»" ;; esac

  # el interruptor de los hooks de git: nada
  : > "${HP_CFG}"
  TYCON_NO_GIT_HOOKS=1 hp apply
  [ "${RC}" = 0 ] && [ -z "$(hp_value)" ] && ok "HP con TYCON_NO_GIT_HOOKS=1, apply no la pone" || mal "HP TYCON_NO_GIT_HOOKS=1 (rc ${RC}): «$(hp_value)»"

  # un git que no deja escribir la configuración: no se dice «✓», se avisa con el comando a mano, y apply sale 0
  if [ "$(id -u)" = 0 ]; then echo "  ⏭ NO MEDIDO — HP la configuración que no se deja escribir: corriendo como root no hay"; else
    mkdir -p "${LAB}/hp-cerrada" && : > "${LAB}/hp-cerrada/gitconfig" && chmod 555 "${LAB}/hp-cerrada"
    SALIDA="$(GIT_CONFIG_GLOBAL="${LAB}/hp-cerrada/gitconfig" harness_lab_isolated harness apply 2>&1 < /dev/null)"; RC=$?
    chmod 755 "${LAB}/hp-cerrada"
    [ "${RC}" = 0 ] && [ "$(hp_said_set)" = 0 ] && printf '%s' "${SALIDA}" | grep -q 'no pude ponerla' && printf '%s' "${SALIDA}" | grep -q -F "git config --global core.hooksPath \"${HP_OURS}\"" && [ ! -s "${LAB}/hp-cerrada/gitconfig" ] \
      && ok "HP git no deja escribir: avisa que no pudo, con el comando, sin «✓»" || mal "HP configuración cerrada (rc ${RC}): ${SALIDA}"
  fi

  # el perfil mínimo la saca si es la que puso el arnés…
  : > "${HP_CFG}"; hp apply
  [ "$(hp_value)" = "${HP_OURS}" ] || mal "HP no quedó puesta antes de medir el perfil mínimo: «$(hp_value)»"
  printf '{ "install": { "profile": "minimal" } }\n' > "${LAB_HOME}/.claude/tycon.json"
  hp apply
  [ "${RC}" = 0 ] && [ -z "$(hp_value)" ] && [ "$(estado "d.get('git_hooks_path')")" = None ] && ok "HP pasar al perfil mínimo saca la carpeta que puso el arnés" || mal "HP perfil mínimo (rc ${RC}, core.hooksPath=«$(hp_value)», estado $(estado "d.get('git_hooks_path')")): ${SALIDA}"
  rm -f "${LAB_HOME}/.claude/tycon.json"
  hp apply
  [ "$(hp_value)" = "${HP_OURS}" ] && ok "HP de vuelta a full, apply la pone otra vez" || mal "HP de vuelta a full: «$(hp_value)»"

  # uninstall: si la persona la cambió, queda; si es la del arnés, sale
  GIT_CONFIG_GLOBAL="${HP_CFG}" git config --global core.hooksPath "${LAB}/hp-otra"
  hp uninstall --yes
  [ "$(hp_value)" = "${LAB}/hp-otra" ] && ok "HP uninstall no saca una carpeta que la persona cambió" || mal "HP uninstall tocó la carpeta cambiada: «$(hp_value)»"
  : > "${HP_CFG}"
  hp install --yes
  [ "$(hp_value)" = "${HP_OURS}" ] || mal "HP la reinstalación no la puso: «$(hp_value)»"
  hp uninstall --dry-run
  printf '%s' "${SALIDA}" | grep -q 'quita también la carpeta global de hooks de git que puso el arnés' && ok "HP uninstall --dry-run la nombra" || mal "HP uninstall --dry-run no la nombra: ${SALIDA}"
  hp uninstall --yes
  [ "${RC}" = 0 ] && [ -z "$(hp_value)" ] && printf '%s' "${SALIDA}" | grep -q 'quitado: la carpeta global de hooks de git que puso el arnés' \
    && ok "HP uninstall saca la carpeta que puso el arnés" || mal "HP uninstall (rc ${RC}, core.hooksPath=«$(hp_value)»): $(printf '%s' "${SALIDA}" | tail -5)"
  fi
fi

if [ "$FALLOS" = 0 ]; then echo "✅ harness-install: todo verde"; exit 0; fi
echo "❌ harness-install: $FALLOS fallo(s)"; exit 1
