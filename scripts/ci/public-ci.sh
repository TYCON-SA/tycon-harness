#!/usr/bin/env bash
# public-ci.sh — todo lo que la CI del repo público corre, en un solo guion.
#
# POR QUÉ EXISTE: quien manda un cambio al repo público tiene que poder correr EN SU MÁQUINA lo mismo que corre la CI, y
# la CI tiene que correr un guion del repo, no una lista de comandos escrita en un YAML que nadie prueba. El workflow
# (`.github/workflows/ci.yml`) sólo llama a esto; la prueba que lo compara con el repo del equipo (la T23 de
# export-real.test.sh) corre este mismo guion en los dos lados.
#
# USO:  bash scripts/ci/public-ci.sh [--root <dir>] [--range <base>...<punta> [--base <rev>]] [--clean-machine]
#   --root <dir>      el repo a revisar; por defecto, el repo donde vive este guion. Corre los archivos DE ESE repo.
#   --range <a>...<b> además, el freno de nombres en castellano sobre ese rango (lo pasa la CI en un pull request)
#   --clean-machine   además, la prueba de la máquina limpia en su modo público (baja imágenes y paquetes: usa la red)
#   --base <rev>      con --range: el paso 9 corre los controles y su regla DE ESA BASE sobre lo que trae el rango
#                     (scripts/ci/run-base-controls.sh de la base; los del pedido corren además). La CI lo
#                     pasa en un pedido y en la cola, y corre el public-ci.sh de la base. Sin --base, el paso 9 corre los
#                     controles de este mismo árbol, como siempre, y lo dice (una máquina, el push a main)
#
# LOS PASOS, en este orden, UNA línea por paso:
#   1 node-check           `node --check` de cada .js que lista `git ls-files` (lo versionado, no lo que haya en disco: en
#                          una máquina instalada `skills/` tiene además las skills de terceros)
#   2 build-check          node build/check.js
#   3 build-generate       node build/generate.js --check
#   4 suites-coverage      node scripts/tests/suites-coverage.test.js
#   5 portable-suites      bash scripts/tests/portable-suites.test.sh. Con --range (fuera de installer-floor), sin las
#                          del instalador que el cambio no toca: el criterio de la validación de Azure
#                          (installer_skips, abajo); las corre el banco nocturno
#   6 agent-skills-suites  cada suite de scripts/tests/suites.json (diarias y semanales) que pide EXACTAMENTE
#                          ["agent-skills"]: de a varias a la vez, cada una en su proceso, con su propia HOME vacía y su
#                          TMPDIR, y sin las herramientas del vocabulario en el PATH, como las portables
#   7 controls-bench       node scripts/controls-bench/runner.js --tool both --baseline check --json <salida>/bench.json
#   8 spanish-names        sólo con --range: node scripts/publishing/spanish-names.js --range <rango>
#   9 repo-lint            sólo con --range: los controles del pre-commit (.githooks/pre-commit-checks, con la punta
#                          como arnés y sin el chequeo de vida de un revisor tocado, que pide una sesión) sobre lo que trae el
#                          rango, como si se commiteara: en una copia de trabajo aparte de la punta, con el índice en la
#                          punta y HEAD en la base (`git reset --soft`). Cada control decide si le toca, igual que al
#                          commitear; los que necesitan lo privado (la lista de nombres del equipo) no lo tienen acá y
#                          callan: eso lo mira el freno de quien empuja y la verificación diaria de lo publicado.
#                          Con --base: bash scripts/ci/run-base-controls.sh run de la BASE (el guion sale de la base con
#                          `git show`): los controles y su regla de la base sobre lo que trae el rango, y además los del
#                          pedido. Si la base no se lee o no trae ese guion, «no pude correr», nunca los del pedido solos
#  10 version              sólo con --range: node scripts/ci/version-tag.js check-pr. Con `numbering: "merge-tag"` en el
#                          version.json de la base, el pedido no toca el número (lo pone la etiqueta del merge); sin la
#                          marca, el de la punta tiene que ser MAYOR que el de la base (lo que una máquina compara).
#                          Además, si el rango toca scripts/setup/npm/ (el paquete de npm), su `version`
#                          semver sube: node scripts/ci/npm-package-version.js. Esa carpeta no es un proyecto de npm
#                          para esta CI: nada acá corre npm test ni npm install en ella
#  11 clean-machine        sólo con --clean-machine: bash scripts/tests/clean-machine.test.sh en su modo público, o sea con
#                          TYCON_CLEAN_MACHINE=1 (pedida de forma explícita) y TYCON_CLEAN_MACHINE_SOURCE=<root> (sobre
#                          este repo, que es la copia; sin esa variable la prueba exporta la copia desde el repo del equipo)
#
#   ✅ public-ci: <paso> (Ns)
#   ❌ public-ci: <paso> — rojo (exit N)                  (y debajo, con sangría, el final de su salida)
#   ❌ public-ci: <paso> — no pude correr: <motivo>
#   última línea:  ✅ public-ci: N pasos verdes  ·  ❌ public-ci: K de N pasos en rojo: <pasos>
#
# 🔴 NO corta en el primer rojo: corre todos los pasos (en una CI, una corrida muestra todos los rojos) y sale 1 si
#    alguno no quedó verde; 0 sólo con todos verdes. Un argumento desconocido, o un --root que no existe o que vino vacío
#    (la variable sin definir de quien llama): 2, con el uso.
# 🔴 Un paso que no pudo correr —falta su archivo o su herramienta, la historia no alcanza para --range, no hay ninguna
#    suite que correr— es ROJO con «no pude correr», nunca un salto: un paso salteado se ve igual que uno que pasó.
# 🔴 No corre el detector de la publicación (necesita la lista privada del equipo, que no viaja) y no lee ningún secreto.
#    Sin --clean-machine no llama a ningún servicio. Con --clean-machine, la prueba de la máquina limpia baja de estos
#    servicios, todos públicos y sin credenciales:
#      · Docker Hub y el registro de Microsoft — las imágenes base (Node; el SDK de .NET, para el paquete del stack)
#      · el repositorio de paquetes de Debian — git, Python, los certificados y la biblioteca ICU que pide .NET
#      · GitHub — el plugin de ejemplo y las skills de terceros
#      · NuGet — los paquetes del plugin de ejemplo
#
# LOS DOS LAYOUTS. En el repo único (la copia pública) las skills están en `<root>/skills`: la raíz ES el repo de las
# skills. En el repo del equipo son dos repos y las skills se ubican como en todo el arnés (scripts/lib/skills-dir.js:
# TYCON_SKILLS_DIR o el lugar de instalación). En los dos casos el guion exporta TYCON_GUIDES_DIR y TYCON_SKILLS_DIR para
# toda la corrida: los pasos miran ESE repo aunque en la máquina haya otro instalado.
#
# VARIABLES (todas opcionales):
#   TYCON_PUBLIC_CI_PART=<parte>    corre sólo una PARTE de los pasos, para repartirlos en trabajos que corren a la vez
#                                   (la CI de GitHub, con una matriz Node × parte). Sin la variable (o vacía), todos:
#                                     checks            todos los pasos menos el 5 (portable-suites)
#                                     suites-<i>-of-<n> sólo el paso 5, con la parte <i> de <n> de las portables: las
#                                                       reparte scripts/ci/suites-shard.js por peso (juego `pr`, ver
#                                                       portable-suites.test.sh, TYCON_PORTABLE_SHARD)
#                                     installer-floor   sólo el paso 5, con las suites de FLOOR_SUITES (abajo): lo que corre
#                                                       con el Node del sistema. La CI la corre con el Node más viejo que
#                                                       acepta el instalador; no es parte de la corrida entera
#                                   Las n+1 partes juntas son la corrida entera: `checks` más `suites-1-of-<n>` …
#                                   `suites-<n>-of-<n>`. Una parte sola NO es el veredicto: el resumen la nombra, y en la CI
#                                   lo da el job `public-ci`, que junta todas. Un valor que no sea uno de ésos: 2, con el uso.
#   TYCON_PUBLIC_CI_OUT=<carpeta>   dónde queda la salida: `<n>-<paso>.log` por paso, `agent-skills-suites.tsv` (una
#                                   línea `✅|❌<TAB>raiz/ruta` por suite del paso 6, ordenadas), la salida de cada una
#                                   en `agent-skills-suites/` y el reporte del banco en `bench.json`. Sin la variable va a
#                                   una carpeta temporal, que el resumen nombra. No cambia qué corre.
#   TYCON_PUBLIC_CI_PARALLEL=<n>    cuántas suites del paso 6 a la vez (4; un valor que no sea un entero ≥ 1 → 4)
#   TYCON_PUBLIC_CI_CAP_MS=<ms>     el tope de cada suite del paso 6 (900000; nunca menos de 1000): agotarlo es rojo, no
#                                   «no medido», y se mata a la suite con todos sus hijos
#   TYCON_PORTABLE_HOME=<carpeta>   dónde arman sus HOME vacías las portables (ver portable-suites.test.sh); las del
#                                   paso 6 van al lado, en `<carpeta>-agent-skills`. Sin ella, bajo `<root>/.advisors/`
#                                   (no bajo /tmp: hay suites que tratan distinto una HOME en una carpeta temporal).
#
# El paso 6 NO corre `export-real.test.sh`: es la suite que corre ESTE guion (sobre la copia y sobre el repo del equipo);
# adentro de él sería infinita. En la copia pública no existe (no viaja), así que los dos lados quedan iguales.

set -uo pipefail

# 🔴 El entorno de git de quien llama no decide sobre qué repo se trabaja: decide --root. git le exporta a lo que lanza un
#    hook (y un `git rebase --exec`) estas variables, y le GANAN a `git -C <root>` y a la carpeta: con ellas puestas, el
#    paso 1 listaría los archivos de OTRO repo y una suite que arma repos de prueba commitearía en la rama de quien llama
#    (el caso que cuenta scripts/lib/clean-git-env.js). Se sacan acá, una vez, para el guion y para todo lo que lanza.
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_COMMON_DIR GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES

usage() {
  echo "uso: bash scripts/ci/public-ci.sh [--root <dir>] [--range <base>...<punta> [--base <rev>]] [--clean-machine]" >&2
  exit "$1"
}
# lo que se muestra de la salida de un paso puede traer texto del pedido: ningún «::» (GitHub) ni «##» (Azure) queda
# entero, ni de a tres, y un retorno de carro no arma una línea aparte
ci_neutral() { tr '\r' ' ' | sed -e ':a' -e 's/::/: :/' -e 'ta' -e ':b' -e 's/##/# #/' -e 'tb'; }

ROOT_ARG=""; ROOT_GIVEN=0; RANGE=""; WITH_RANGE=0; CLEAN_MACHINE=0; BASE_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --root) [ $# -ge 2 ] || { echo "public-ci: --root pide una carpeta" >&2; usage 2; }; ROOT_ARG="$2"; ROOT_GIVEN=1; shift 2 ;;
    --root=*) ROOT_ARG="${1#--root=}"; ROOT_GIVEN=1; shift ;;
    --range) [ $# -ge 2 ] || { echo "public-ci: --range pide <base>...<punta>" >&2; usage 2; }; RANGE="$2"; WITH_RANGE=1; shift 2 ;;
    --range=*) RANGE="${1#--range=}"; WITH_RANGE=1; shift ;;
    --clean-machine) CLEAN_MACHINE=1; shift ;;
    --base) [ $# -ge 2 ] && [ -n "$2" ] || { echo "public-ci: --base pide un commit" >&2; usage 2; }; BASE_ARG="$2"; shift 2 ;;
    --base=*) BASE_ARG="${1#--base=}"; [ -n "${BASE_ARG}" ] || { echo "public-ci: --base pide un commit" >&2; usage 2; }; shift ;;
    -h|--help) usage 0 ;;
    *) echo "public-ci: argumento desconocido: $1" >&2; usage 2 ;;
  esac
done

# los controles de la base miran lo que trae un rango: sin --range no hay qué mirar
[ -z "${BASE_ARG}" ] || [ "${WITH_RANGE}" -eq 1 ] || { echo "public-ci: --base va con --range" >&2; usage 2; }

# un --root VACÍO (la variable sin definir de quien llama) no es «sin --root»: caer al repo del guion daría el veredicto
# de otro repo que el pedido
if [ "${ROOT_GIVEN}" -eq 1 ]; then
  [ -n "${ROOT_ARG}" ] || { echo "public-ci: --root vino vacío: pide una carpeta" >&2; usage 2; }
  [ -d "${ROOT_ARG}" ] || { echo "public-ci: --root ${ROOT_ARG} no existe" >&2; usage 2; }
  ROOT="$(cd "${ROOT_ARG}" && pwd)"
else
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi

# ── qué parte de los pasos (TYCON_PUBLIC_CI_PART, ver arriba) ───────────────────────────────────────
PART="${TYCON_PUBLIC_CI_PART:-}"; PORTABLE_SHARD=""; PORTABLE_ONLY=""
# Las suites de lo que corre con el Node DEL SISTEMA, antes de que el arnés tenga el suyo (el arranque, la actualización,
# el Node propio, la versión bajada y su número). La parte installer-floor las corre con el Node más viejo que acepta el
# instalador: el resto de la CI corre sólo con Node 24, que es el que el arnés se instala.
FLOOR_SUITES="tests/harness-bootstrap.test.sh,tests/harness-update.test.sh,tests/harness-node.test.sh,tests/harness-release.test.sh,tests/harness-release-links.test.sh,tests/version-by-merge.test.js"
case "${PART}" in
  ""|checks) ;;
  installer-floor) PORTABLE_ONLY="${FLOOR_SUITES}" ;;
  suites-*-of-*)
    # sólo dígitos, i entre 1 y n: «suites-0-of-3», «suites-4-of-3», «suites-1-of-3x» o «suites-1-of-2-of-3» no son una parte
    PART_RE='^suites-([1-9][0-9]*)-of-([1-9][0-9]*)$'
    if [[ "${PART}" =~ ${PART_RE} ]] && [ "${BASH_REMATCH[1]}" -le "${BASH_REMATCH[2]}" ]; then
      SHARD_I="${BASH_REMATCH[1]}"; SHARD_N="${BASH_REMATCH[2]}"
    else
      echo "public-ci: TYCON_PUBLIC_CI_PART=${PART} no es una parte: checks, installer-floor o suites-<i>-of-<n>, con i entre 1 y n" >&2; usage 2
    fi
    PORTABLE_SHARD="${SHARD_I}/${SHARD_N}" ;;
  *) echo "public-ci: TYCON_PUBLIC_CI_PART=${PART} no es una parte: checks, installer-floor o suites-<i>-of-<n>, con i entre 1 y n" >&2; usage 2 ;;
esac
# wants <paso> → 0 si el paso le toca a esta parte
wants() {
  case "${PART}" in
    "") return 0 ;;
    checks) [ "$1" != portable-suites ] ;;
    *) [ "$1" = portable-suites ] ;;   # suites-<i>-of-<n> e installer-floor: sólo las portables
  esac
}

# ── dónde queda la salida ──────────────────────────────────────────────────────────────────────────
if [ -n "${TYCON_PUBLIC_CI_OUT:-}" ]; then
  mkdir -p "${TYCON_PUBLIC_CI_OUT}" 2>/dev/null && OUT="$(cd "${TYCON_PUBLIC_CI_OUT}" && pwd)" \
    || { echo "public-ci: no pude crear TYCON_PUBLIC_CI_OUT=${TYCON_PUBLIC_CI_OUT}" >&2; exit 2; }
  # lo de una corrida anterior no puede leerse como veredicto de ésta
  rm -rf "${OUT}/agent-skills-suites" "${OUT}/agent-skills-suites.tsv" "${OUT}/bench.json" "${OUT}"/[0-9]*-*.log
else
  OUT="$(mktemp -d "${TMPDIR:-/tmp}/public-ci.XXXXXX")" || { echo "public-ci: no pude crear una carpeta temporal para la salida" >&2; exit 2; }
fi
WORK="$(mktemp -d "${TMPDIR:-/tmp}/public-ci-work.XXXXXX")" || { echo "public-ci: no pude crear una carpeta temporal de trabajo" >&2; exit 2; }
# las HOME vacías del paso 6 (ver TYCON_PORTABLE_HOME arriba)
if [ -n "${TYCON_PORTABLE_HOME:-}" ]; then HOMES="${TYCON_PORTABLE_HOME}-agent-skills"; else HOMES="${ROOT}/.advisors/public-ci-home-$$"; fi
cleanup() {
  rm -rf "${WORK}" "${HOMES}"
  [ -n "${TYCON_PORTABLE_HOME:-}" ] || rmdir "${ROOT}/.advisors" 2>/dev/null || true
}
trap cleanup EXIT

# ── el layout: dónde están las skills ──────────────────────────────────────────────────────────────
# 🔴 «No pude preguntar» no es «no hay skills». La biblioteca tira cuando su vecina
#    (canonical-path.js) está y no carga; con `2>/dev/null || true` eso quedaría como «no encuentro las skills: ni … ni
#    el lugar de instalación», que manda a buscar una instalación que no es el problema. La causa se dice acá y
#    en el paso que las necesita (el 6), que es rojo «no pude correr» por ESO. Los demás pasos corren igual.
SKILLS_REPO=""; SKILLS_ERROR=""
if [ -d "${ROOT}/skills/tycon-pipeline" ]; then
  SKILLS_REPO="${ROOT}"
elif [ -f "${ROOT}/scripts/lib/skills-dir.js" ] && command -v node >/dev/null 2>&1; then
  if SKILLS_REPO="$(node -e 'try { console.log(require(process.argv[1]).resolveSkillsDirs(process.env.TYCON_SKILLS_DIR || "").repo); } catch (e) { console.error(String((e && e.message) || e).split("\n")[0]); process.exit(1); }' "${ROOT}/scripts/lib/skills-dir.js" 2> "${WORK}/skills-dir.err")"; then
    [ -n "${SKILLS_REPO}" ] && [ -d "${SKILLS_REPO}/skills/tycon-pipeline" ] || SKILLS_REPO=""
  else
    SKILLS_REPO=""; SKILLS_ERROR="$(head -n 1 "${WORK}/skills-dir.err")"
    [ -n "${SKILLS_ERROR}" ] || SKILLS_ERROR="scripts/lib/skills-dir.js salió con error y no dijo por qué"
    echo "public-ci: no pude resolver la carpeta de skills: $(printf '%s\n' "${SKILLS_ERROR}" | ci_neutral)"
  fi
fi
export TYCON_GUIDES_DIR="${ROOT}"
[ -z "${SKILLS_REPO}" ] || export TYCON_SKILLS_DIR="${SKILLS_REPO}/skills"
# El buzón apagado para cada suite: ninguna sube a un buzón real, aunque se equivoque. La llave apunta a un archivo que
# no existe; una suite que prueba la subida pone sus propias variables y su destino de prueba.
export TYCON_MAILBOX=0 TYCON_NO_UPLOAD_RUNS=1 TYCON_MAILBOX_JSON="${WORK}/sin-llave-del-buzon/corridas-buzon.json" TYCON_SUITE_RUNNER=public-ci

# ── los veredictos ─────────────────────────────────────────────────────────────────────────────────
STEP=0; RED_COUNT=0; RED_NAMES=""
BLOCKED_EXIT=9   # con este exit un paso propio dice «no pude correr»; el motivo es la última línea de su salida
mark_red() { RED_COUNT=$((RED_COUNT + 1)); if [ -z "${RED_NAMES}" ]; then RED_NAMES="$1"; else RED_NAMES="${RED_NAMES}, $1"; fi; }
blocked() { mark_red "$1"; echo "❌ public-ci: $1 — no pude correr: $(printf '%s\n' "$2" | ci_neutral)"; }

# run_step <paso> <own|file> <archivo que tiene que existir, relativo a la raíz> <herramientas, separadas por espacio> <comando…>
#   own  = un paso de este guion (una función): puede salir con BLOCKED_EXIT para decir «no pude correr»
#   file = un guion del repo: cualquier exit distinto de 0 es rojo
run_step() {
  local name="$1" kind="$2" needs="$3" tools="$4" tool log rc t0
  shift 4
  STEP=$((STEP + 1)); log="${OUT}/${STEP}-${name}.log"; : > "${log}"
  for tool in ${tools}; do
    if ! command -v "${tool}" >/dev/null 2>&1; then blocked "${name}" "no encuentro ${tool} en el PATH"; return; fi
  done
  if [ -n "${needs}" ] && [ ! -f "${ROOT}/${needs}" ]; then blocked "${name}" "falta ${needs}"; return; fi
  t0="${SECONDS}"
  ( cd "${ROOT}" && "$@" ) > "${log}" 2>&1; rc=$?
  if [ "${rc}" -eq 0 ]; then
    echo "✅ public-ci: ${name} ($((SECONDS - t0))s)"
    # lo que avisa la revisión desde la base se ve también en verde: lo que se suma a las reglas, la alarma, la constancia
    [ "${name}" != repo-lint ] || grep -E '^(⚠️ base-controls|✅ base-controls: cambio de control aprobado|base-controls: reglas que cambia|   [^ ]|      [-+~] )' "${log}" | ci_neutral | sed 's/^/     /'
  elif [ "${kind}" = "own" ] && [ "${rc}" -eq "${BLOCKED_EXIT}" ]; then
    blocked "${name}" "$(tail -n 1 "${log}" | sed 's/^no pude correr: //')"
  else
    mark_red "${name}"
    echo "❌ public-ci: ${name} — rojo (exit ${rc})"
    tail -n 30 "${log}" | ci_neutral | sed 's/^/     /'
  fi
}

# ── paso 1 · node --check de lo versionado ─────────────────────────────────────────────────────────
node_check() {
  node - "${ROOT}" <<'JS'
'use strict';
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const ROOT = process.argv[2];
const blocked = (m) => { console.log(`no pude correr: ${m}`); process.exit(9); };
let files = [];
try {
  // sólo lo versionado: lo que haya en disco sin versionar (las skills de terceros de una máquina instalada) no es del repo
  files = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--', '*.js'], { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString('utf8').split('\0').filter(Boolean).sort();
} catch (e) {
  blocked(`git ls-files falló en ${ROOT}: ${String((e.stderr && e.stderr.toString()) || e.message).trim().split('\n')[0]}`);
}
if (!files.length) blocked(`git ls-files no lista ningún .js en ${ROOT}: cero archivos revisados no es un verde`);
const POOL = Math.max(1, Math.min(8, os.cpus().length || 2));
const bad = new Map();
let next = 0;
let alive = 0;
// Un guion de flujo de trabajo (`*.workflow.js`) no es un módulo: lo carga la herramienta Workflow de Claude Code, que
// envuelve su cuerpo en una función asíncrona (ahí `return` y `await` a nivel de archivo son legítimos) y lee su
// `export const meta`. Se revisa como lo ejecuta ese motor: el cuerpo, sin el `export`, adentro de una función
// asíncrona, en un temporal. Saltearlo dejaría sin revisar un archivo que corre; revisarlo como módulo, en rojo uno sano.
let wrapDir = null;
function checkable(f) {
  if (!f.endsWith('.workflow.js')) return path.join(ROOT, f);
  if (!wrapDir) wrapDir = require('fs').mkdtempSync(path.join(os.tmpdir(), 'public-ci-workflow-'));
  const body = require('fs').readFileSync(path.join(ROOT, f), 'utf8').replace(/^export\s+(?=(?:const|let|var|function|async\s+function|class)\b)/gm, '');
  const out = path.join(wrapDir, f.replace(/[\\/]/g, '__'));
  require('fs').writeFileSync(out, `(async () => {\n${body}\n})();\n`);
  return out;
}
function launch() {
  while (alive < POOL && next < files.length) {
    const f = files[next++];
    alive++;
    let err = '';
    const p = spawn(process.execPath, ['--check', checkable(f)], { stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { err += e.message; });
    p.on('close', (code) => {
      alive--;
      if (code !== 0) bad.set(f, err.trim().split('\n').slice(0, 4).join('\n'));
      if (next < files.length) launch();
      else if (!alive) end();
    });
  }
}
function end() {
  for (const f of [...bad.keys()].sort()) console.log(`❌ ${f}\n${bad.get(f).split('\n').map((l) => `     ${l}`).join('\n')}`);
  console.log(`node-check: ${files.length} .js versionados · ${bad.size} no compilan`);
  process.exit(bad.size ? 1 : 0);
}
launch();
JS
}

# ── paso 6 · las suites que piden agent-skills ─────────────────────────────────────────────────────
agent_skills_suites() {
  rm -rf "${HOMES}"
  mkdir -p "${HOMES}" "${WORK}/bin" "${WORK}/tmp" "${OUT}/agent-skills-suites" || { echo "no pude correr: no pude crear ${HOMES}"; return "${BLOCKED_EXIT}"; }
  node - "${ROOT}" "${SKILLS_REPO}" "${HOMES}" "${WORK}/bin" "${WORK}/tmp" "${OUT}" "${TYCON_PUBLIC_CI_PARALLEL:-}" "${TYCON_PUBLIC_CI_CAP_MS:-}" "${SKILLS_ERROR}" <<'JS'
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const [ROOT, SK, HOMES, BIN, TMP, OUT, POOL_RAW, CAP_RAW, SK_ERROR] = process.argv.slice(2);
const blocked = (m) => { console.log(`no pude correr: ${m}`); process.exit(9); };

// El PATH sin las herramientas del vocabulario, como en portable-suites.test.sh: una carpeta con ENLACES a todo lo demás
// (un binario copiado pierde sus bibliotecas). En cada nombre gana la primera carpeta del PATH, como en el PATH mismo.
// Una suite que pide sólo agent-skills declara que no necesita ninguna de las cinco: acá se mide.
// Una entrada RELATIVA del PATH se lleva a absoluta (contra la raíz, que es desde donde corre cada suite): un enlace con
// destino relativo se resuelve contra la carpeta armada, queda roto y encima tapa al binario bueno de más adelante.
const VOCABULARY_TOOLS = ['az', 'engram', 'codegraph', 'codex', 'claude'];
const linked = new Set();
for (const entry of (process.env.PATH || '').split(':').filter(Boolean)) {
  const dir = path.resolve(ROOT, entry);
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { continue; }
  for (const name of names) {
    if (name.startsWith('.') || VOCABULARY_TOOLS.includes(name) || linked.has(name)) continue;
    try { fs.symlinkSync(path.join(dir, name), path.join(BIN, name)); linked.add(name); } catch (_) { /* un nombre que no se puede enlazar no está: la suite que lo necesite lo dirá */ }
  }
}
const left = VOCABULARY_TOOLS.filter((t) => fs.existsSync(path.join(BIN, t)));
if (left.length) blocked(`${left.join(', ')} sigue en el PATH armado — la medición no vale`);
if (!linked.has('node') || !linked.has('bash')) blocked('no quedó node o bash en el PATH armado');
const SUITES = path.join(ROOT, 'scripts', 'tests', 'suites.json');
let cfg = null;
try { cfg = JSON.parse(fs.readFileSync(SUITES, 'utf8')); } catch (e) { blocked(`no pude leer scripts/tests/suites.json (${e.message})`); }
const all = [...(cfg.diarias || []), ...(cfg.semanales || [])].filter((e) => e && e.raiz && e.ruta);
// la suite que corre este guion: adentro de él sería infinita (y en la copia pública no existe)
const callsMe = (e) => /(^|\/)export-real\.test\.sh$/.test(e.ruta);
const wanted = all.filter((e) => Array.isArray(e.requiere) && e.requiere.length === 1 && e.requiere[0] === 'agent-skills');
const suites = wanted.filter((e) => !callsMe(e));
if (!SK && SK_ERROR) blocked(`no pude resolver la carpeta de skills: ${SK_ERROR}`);
if (!SK) blocked('no encuentro las skills: ni <raíz>/skills/tycon-pipeline (repo único) ni TYCON_SKILLS_DIR ni el lugar de instalación (dos repos)');
if (!suites.length) blocked(`ninguna suite de scripts/tests/suites.json pide exactamente ["agent-skills"] (${all.length} declaradas): cero no es verde`);
for (const e of wanted.filter(callsMe)) console.log(`· ${e.raiz}/${e.ruta} no se corre acá: es la suite que corre este guion`);

const POOL = /^[1-9]\d*$/.test(POOL_RAW) ? Number(POOL_RAW) : 4;
const CAP_MS = /^[1-9]\d*$/.test(CAP_RAW) ? Math.max(1000, Number(CAP_RAW)) : 900000;
const key = (e) => `${e.raiz}/${e.ruta}`;
const dirOf = (e) => (e.raiz === 'arnes' ? path.join(ROOT, 'scripts') : path.join(SK, 'skills'));
const sec = (ms) => `${Math.round(ms / 1000)}s`;
const verdicts = new Map();
const red = [];
const start = Date.now();

/** La HOME vacía de UNA suite: sólo los dos enlaces de instalación. Una por suite, así no se pisan entre sí. */
let made = 0;
function emptyHome() {
  const n = ++made;
  const home = path.join(HOMES, `h${n}`);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(SK, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(path.join(SK, 'agents'), path.join(home, '.claude', 'agents'));
  const tmp = path.join(TMP, `t${n}`);
  fs.mkdirSync(tmp, { recursive: true });
  const env = {
    HOME: home, USERPROFILE: home, PATH: BIN, TMPDIR: tmp, LANG: process.env.LANG || 'en_US.UTF-8',
    TYCON_PROFILE: '0', TYCON_GUIDES_DIR: ROOT, TYCON_SKILLS_DIR: path.join(SK, 'skills'),
    TYCON_MAILBOX_JSON: path.join(home, 'no-hay-llave.json'), TYCON_CHROME: '0',
  };
  // lo que protege a la máquina de quien corre (una HOME temporal no aísla al programador de tareas del sistema):
  // si quien llama lo pidió, llega a cada suite
  for (const k of ['TYCON_NO_NIGHTLY_EXAM', 'TYCON_NO_GUI_ENV']) if (process.env[k]) env[k] = process.env[k];
  return { home, env };
}

const queue = suites.slice().sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
let alive = 0;
function settle(e, good, why, t0, output) {
  verdicts.set(key(e), good ? '✅' : '❌');
  // el nombre sale de suites.json del pedido y lo imprime el volcado del workflow: sólo caracteres que no arman una línea
  // ni un comando de la CI
  const logName = key(e).split('/').join('__').replace(/[^\w.@-]/g, '_');
  try { fs.writeFileSync(path.join(OUT, 'agent-skills-suites', `${logName}.log`), output); } catch (_) { /* el veredicto no depende de esto */ }
  if (good) { console.log(`✅ ${key(e)} (${sec(Date.now() - t0)})`); return; }
  red.push(`${key(e)} (${why})`);
  // la salida de una suite puede traer texto del pedido: ningún «::» ni «##» llega entero como comando de la CI
  const tail = output.trim().split('\n').slice(-8).map((l) => `     ${l.replace(/\r/g, ' ').replace(/:(?=:)/g, ': ').replace(/#(?=#)/g, '# ')}`).join('\n');
  console.log(`❌ ${key(e)} — ${why} (${sec(Date.now() - t0)})${tail.trim() ? `\n${tail}` : ''}`);
}
function launch() {
  while (alive < POOL && queue.length) {
    const e = queue.shift();
    const abs = path.join(dirOf(e), e.ruta);
    const t0 = Date.now();
    if (!fs.existsSync(abs)) { settle(e, false, 'no existe en disco', t0, ''); continue; }
    alive++;
    const { home, env } = emptyHome();
    let output = '';
    let capped = false;
    // `detached`: la suite es el líder de su grupo de procesos; al agotarse el tope se mata EL GRUPO (matar sólo a la
    // suite deja vivos a sus hijos, que retienen la salida, y el cierre no llega nunca)
    const p = spawn(/\.js$/.test(e.ruta) ? process.execPath : 'bash', [abs], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const kill = () => { try { process.kill(-p.pid, 'SIGKILL'); } catch (_) { try { p.kill('SIGKILL'); } catch (__) { /* ya murió */ } } };
    const timer = setTimeout(() => { capped = true; kill(); }, CAP_MS);
    let closed = false;
    const close = (code, failure) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      alive--;
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) { /* se borra entera al final igual */ }
      const good = code === 0 && !capped && !failure;
      settle(e, good, failure || (capped ? `se agotó el tope de ${sec(CAP_MS)}` : `exit ${code}`), t0, output);
      launch();
      if (!alive && !queue.length) end();
    };
    p.stdout.on('data', (d) => { output += d; });
    p.stderr.on('data', (d) => { output += d; });
    p.on('error', (err) => close(null, `no pude lanzarla: ${err.message}`));
    p.on('close', (code) => close(code, ''));
  }
  if (!alive && !queue.length) end();
}
let ended = false;
function end() {
  if (ended) return;
  ended = true;
  // ordenado por raiz/ruta: dos corridas dan el mismo archivo
  const lines = [...verdicts.keys()].sort().map((k) => `${verdicts.get(k)}\t${k}\n`).join('');
  fs.writeFileSync(path.join(OUT, 'agent-skills-suites.tsv'), lines);
  console.log(`\nagent-skills-suites: ${verdicts.size} corridas · ${verdicts.size - red.length} verdes · ${red.length} rojas · de a ${POOL} · ${sec(Date.now() - start)}`);
  if (red.length) {
    console.log('❌ suites que piden agent-skills y NO dieron verde en una HOME vacía:');
    for (const r of red.slice().sort()) console.log(`   ❌ ${r}`);
    process.exit(1);
  }
  process.exit(0);
}
launch();
JS
}

# ── paso 8 · el freno de nombres en castellano, sobre el rango ─────────────────────────────────────
spanish_names() {
  local base tip x
  case "${RANGE}" in
    ?*...?*) base="${RANGE%%...*}"; tip="${RANGE##*...}" ;;
    *) echo "no pude correr: --range pide <base>...<punta> y recibió «${RANGE}»"; return "${BLOCKED_EXIT}" ;;
  esac
  for x in "${base}" "${tip}"; do
    git -C "${ROOT}" rev-parse --verify --quiet "${x}^{commit}" >/dev/null 2>&1 \
      || { echo "no pude correr: la historia no alcanza para --range ${RANGE}: ${x} no resuelve a un commit en ${ROOT} (¿un clon sin la historia completa?)"; return "${BLOCKED_EXIT}"; }
  done
  node scripts/publishing/spanish-names.js --range "${RANGE}"
}

# los dos extremos de --range, ya comprobados; si no resuelven, «no pude correr» (la misma regla que spanish_names)
range_ends() {
  local x
  case "${RANGE}" in
    ?*...?*) RANGE_BASE="${RANGE%%...*}"; RANGE_TIP="${RANGE##*...}" ;;
    *) echo "no pude correr: --range pide <base>...<punta> y recibió «${RANGE}»"; return "${BLOCKED_EXIT}" ;;
  esac
  for x in "${RANGE_BASE}" "${RANGE_TIP}"; do
    git -C "${ROOT}" rev-parse --verify --quiet "${x}^{commit}" >/dev/null 2>&1 \
      || { echo "no pude correr: la historia no alcanza para --range ${RANGE}: ${x} no resuelve a un commit en ${ROOT} (¿un clon sin la historia completa?)"; return "${BLOCKED_EXIT}"; }
  done
}

# ── las portables del instalador que el cambio no toca (paso 5, con --range) ───────────────────────────────────────
# El mismo criterio que la validación de Azure: las suites del grupo `installer` de scripts/ci/heavy-suites.json corren
# sólo si el cambio toca sus patrones o la suite misma (scripts/ci/suites-for-change.js --groups-alone). Las corre el
# banco nocturno. Deja en PORTABLE_SKIP las rutas a saltear; si algo no se puede calcular, ninguna, y lo dice.
installer_skips() {
  local why="" changed="${WORK}/installer-changed.txt" plan="${WORK}/installer-plan.txt"
  PORTABLE_SKIP=""
  if ! range_ends > "${WORK}/installer-range.txt" 2>&1; then why="$(cat "${WORK}/installer-range.txt")"
  elif ! git -C "${ROOT}" diff --name-only "${RANGE_BASE}...${RANGE_TIP}" > "${changed}" 2> "${WORK}/installer-diff.err"; then why="git diff no pudo listar el cambio: $(head -n 1 "${WORK}/installer-diff.err")"
  elif [ ! -f "${ROOT}/scripts/ci/suites-for-change.js" ] || [ ! -f "${ROOT}/scripts/ci/heavy-suites.json" ]; then why="falta scripts/ci/suites-for-change.js o scripts/ci/heavy-suites.json"
  elif [ -z "${SKILLS_REPO}" ]; then why="no encuentro las skills"
  elif ! node "${ROOT}/scripts/ci/suites-for-change.js" --suites "${ROOT}/scripts/tests/suites.json" --scripts "${ROOT}/scripts" \
      --skills "${SKILLS_REPO}/skills" --heavy "${ROOT}/scripts/ci/heavy-suites.json" --changed "${changed}" --groups-alone \
      > "${plan}" 2> "${WORK}/installer-plan.err"; then why="el selector falló: $(tail -n 1 "${WORK}/installer-plan.err")"
  elif ! PORTABLE_SKIP="$(node -e '
      const fs = require("fs");
      const [plan, heavy, suites] = process.argv.slice(1);
      const groups = JSON.parse(fs.readFileSync(heavy, "utf8")).suites || {};
      const s = JSON.parse(fs.readFileSync(suites, "utf8"));
      const all = [...(s.diarias || []), ...(s.semanales || [])].filter((e) => e && e.raiz === "arnes" && typeof e.ruta === "string");
      const names = fs.readFileSync(plan, "utf8").split("\n").filter((l) => l.startsWith("SKIP\t")).map((l) => l.split("\t")[1]);
      const out = names.filter((n) => groups[n] && groups[n].group === "installer")
        .map((n) => (all.find((e) => e.ruta.split("/").pop() === n) || {}).ruta).filter(Boolean);
      console.log(out.join(","));' "${plan}" "${ROOT}/scripts/ci/heavy-suites.json" "${ROOT}/scripts/tests/suites.json" 2> "${WORK}/installer-skip.err")"; then
    why="no pude leer el plan: $(head -n 1 "${WORK}/installer-skip.err")"; PORTABLE_SKIP=""
  fi
  if [ -n "${why}" ]; then echo "public-ci: no sé qué portables del instalador saltear (${why}): corren todas"
  elif [ -n "${PORTABLE_SKIP}" ]; then echo "public-ci: el cambio no toca el instalador: $(printf '%s' "${PORTABLE_SKIP}" | tr ',' '\n' | grep -c .) portable(s) del instalador quedan para el banco nocturno: ${PORTABLE_SKIP//,/, }"
  else echo "public-ci: el cambio toca el instalador: corren todas las portables"; fi
}

# ── paso 9 · el pre-commit del repo sobre lo que trae el rango ─────────────────────────────────────
# En una copia de trabajo APARTE: el checkout de la CI no se mueve (los pasos de antes y de después miden la punta tal
# cual). La base es el ancestro común, como el `...` del rango: lo que trae el pedido, no lo que la base avanzó.
repo_lint() {
  local mb wt rc
  range_ends || return $?
  mb="$(git -C "${ROOT}" merge-base "${RANGE_BASE}" "${RANGE_TIP}")" \
    || { echo "no pude correr: no hay ancestro común entre ${RANGE_BASE} y ${RANGE_TIP}"; return "${BLOCKED_EXIT}"; }
  wt="${OUT}/repo-lint-tree"
  rm -rf "${wt}"
  git -C "${ROOT}" worktree add --quiet --detach "${wt}" "${RANGE_TIP}" \
    || { echo "no pude correr: no pude armar la copia de trabajo de ${RANGE_TIP}"; return "${BLOCKED_EXIT}"; }
  if ! git -C "${wt}" reset --quiet --soft "${mb}"; then
    git -C "${ROOT}" worktree remove --force "${wt}" >/dev/null 2>&1
    echo "no pude correr: no pude poner HEAD en la base ${mb}"; return "${BLOCKED_EXIT}"
  fi
  echo "repo-lint: lo que trae ${RANGE} ($(git -C "${wt}" diff --cached --name-only | wc -l | tr -d ' ') archivo(s)), con el pre-commit de la punta"
  echo "repo-lint: sin --base: los controles salen de este mismo árbol (la punta del rango), como en una máquina"
  ( cd "${wt}" && TYCON_GUIDES_DIR="${wt}" TYCON_SKILLS_DIR="${wt}" TYCON_NO_LIVENESS_PRECOMMIT=1 bash .githooks/pre-commit-checks < /dev/null ); rc=$?
  git -C "${ROOT}" worktree remove --force "${wt}" >/dev/null 2>&1
  return "${rc}"
}

# ── paso 9 con --base · los controles de la BASE sobre lo que trae el rango ───────────────────────────────────────
# Casos: scripts/tests/public-ci.test.sh (T14) y scripts/tests/base-controls.test.sh
# El guion que lo hace sale de la base (`git show`), no del árbol que se revisa: un pedido que lo vacía no lo saltea.
repo_lint_from_base() {
  local rbc
  range_ends || return $?
  git -C "${ROOT}" rev-parse --verify --quiet "${BASE_ARG}^{commit}" >/dev/null 2>&1 \
    || { echo "no pude correr: la base ${BASE_ARG} no resuelve a un commit en ${ROOT}: sin la base no hay de dónde correr los controles"; return "${BLOCKED_EXIT}"; }
  rbc="${WORK}/run-base-controls.sh"
  git -C "${ROOT}" cat-file -e "${BASE_ARG}:scripts/ci/run-base-controls.sh" 2>/dev/null && git -C "${ROOT}" show "${BASE_ARG}:scripts/ci/run-base-controls.sh" > "${rbc}" \
    || { echo "no pude correr: la base ${BASE_ARG} no trae scripts/ci/run-base-controls.sh: no sé correr sus controles"; return "${BLOCKED_EXIT}"; }
  echo "repo-lint: los controles y su regla salen de la base ${BASE_ARG} (scripts/ci/run-base-controls.sh de la base); los del pedido corren además"
  bash "${rbc}" run --root "${ROOT}" --base "${BASE_ARG}" --range "${RANGE}" --out "${OUT}/base-controls" < /dev/null
}

# ── paso 10 · la versión ──────────────────────────────────────────────────────────────────────────
# Con la marca `numbering: "merge-tag"` en el version.json de la base, el número lo pone la etiqueta del merge y el pedido
# no lo toca; sin la marca (antes de la transición), el número de la punta tiene que ser mayor. La regla vive en
# scripts/ci/version-tag.js (check-pr), con sus pruebas en scripts/tests/version-by-merge.test.js.
version_bumped() {
  range_ends || return $?
  git -C "${ROOT}" merge-base "${RANGE_BASE}" "${RANGE_TIP}" >/dev/null \
    || { echo "no pude correr: no hay ancestro común entre ${RANGE_BASE} y ${RANGE_TIP}"; return "${BLOCKED_EXIT}"; }
  [ -f "${ROOT}/scripts/ci/version-tag.js" ] \
    || { echo "no pude correr: el repo no trae scripts/ci/version-tag.js (la regla del número)"; return "${BLOCKED_EXIT}"; }
  node "${ROOT}/scripts/ci/version-tag.js" check-pr --root "${ROOT}" --base "${RANGE_BASE}" --tip "${RANGE_TIP}" || return $?
  # la versión del paquete de npm: si el pedido toca scripts/setup/npm/, su `version` sube. Un repo sin
  # el paquete (los de juguete de public-ci.test.sh) no tiene nada que exigir; un repo CON el paquete y sin su regla no es
  # «nada que exigir»: es «no pude correr», rojo (un salto se vería igual que un verde)
  if [ ! -f "${ROOT}/scripts/ci/npm-package-version.js" ]; then
    [ ! -f "${ROOT}/scripts/setup/npm/package.json" ] && return 0
    echo "no pude correr: el repo trae scripts/setup/npm/package.json y no trae scripts/ci/npm-package-version.js (la regla de su versión)"
    return "${BLOCKED_EXIT}"
  fi
  node "${ROOT}/scripts/ci/npm-package-version.js" --root "${ROOT}" --range "${RANGE_BASE}...${RANGE_TIP}"
}

# ── la corrida ─────────────────────────────────────────────────────────────────────────────────────
case "${PART}" in
  "") ;;
  checks) echo "public-ci: parte checks — todos los pasos menos portable-suites (las portables van en las partes suites-<i>-of-<n>)" ;;
  installer-floor) echo "public-ci: parte installer-floor — sólo las portables de la instalación y la actualización, con el Node de esta máquina ($(node --version 2>/dev/null || echo 'sin node'))" ;;
  *) echo "public-ci: parte ${PART} — sólo portable-suites, con la parte ${SHARD_I} de ${SHARD_N} de las portables (los demás pasos van en la parte checks)" ;;
esac
wants node-check && run_step node-check own "" "git node" node_check
wants build-check && run_step build-check file build/check.js "node" node build/check.js
wants build-generate && run_step build-generate file build/generate.js "node" node build/generate.js --check
wants suites-coverage && run_step suites-coverage file scripts/tests/suites-coverage.test.js "node" node scripts/tests/suites-coverage.test.js
# TYCON_PORTABLE_SHARD siempre se pasa: vacía (la corrida entera, o la parte checks) corre todas las portables, aunque
# quien llama la tenga puesta. TYCON_PORTABLE_SKIP también: sólo con --range y fuera de installer-floor lleva algo.
PORTABLE_SKIP=""
if wants portable-suites && [ "${WITH_RANGE}" -eq 1 ] && [ "${PART}" != installer-floor ]; then installer_skips; fi
wants portable-suites && run_step portable-suites file scripts/tests/portable-suites.test.sh "bash node" \
  env TYCON_PORTABLE_SHARD="${PORTABLE_SHARD}" TYCON_PORTABLE_ONLY="${PORTABLE_ONLY}" TYCON_PORTABLE_SKIP="${PORTABLE_SKIP}" bash scripts/tests/portable-suites.test.sh
wants agent-skills-suites && run_step agent-skills-suites own scripts/tests/suites.json "bash node" agent_skills_suites
wants controls-bench && run_step controls-bench file scripts/controls-bench/runner.js "node" node scripts/controls-bench/runner.js --tool both --baseline check --json "${OUT}/bench.json"
[ "${WITH_RANGE}" -eq 0 ] || ! wants spanish-names || run_step spanish-names own scripts/publishing/spanish-names.js "git node" spanish_names
if [ -n "${BASE_ARG}" ]; then
  # con --base el pre-commit del árbol puede faltar (el pedido lo borró): lo que tiene que existir es la base
  ! wants repo-lint || run_step repo-lint own "" "git bash node" repo_lint_from_base
else
  [ "${WITH_RANGE}" -eq 0 ] || ! wants repo-lint || run_step repo-lint own .githooks/pre-commit-checks "git bash node" repo_lint
fi
[ "${WITH_RANGE}" -eq 0 ] || ! wants version || run_step version own version.json "git node" version_bumped
# la máquina limpia, en su modo PÚBLICO: pedida de forma explícita (sin eso, fuera del nocturno sale NO MEDIDA) y sobre
# ESTE repo (sin eso cae en el modo interno, que exporta la copia desde el repo del equipo)
[ "${CLEAN_MACHINE}" -eq 0 ] || ! wants clean-machine || run_step clean-machine file scripts/tests/clean-machine.test.sh "bash" \
  env TYCON_CLEAN_MACHINE=1 TYCON_CLEAN_MACHINE_SOURCE="${ROOT}" bash scripts/tests/clean-machine.test.sh

echo "public-ci: la salida de cada paso quedó en ${OUT}"
# una parte sola no es la corrida entera: el resumen lo dice
OF_PART=""; [ -z "${PART}" ] || OF_PART=" (sólo la parte ${PART})"
if [ "${RED_COUNT}" -eq 0 ]; then echo "✅ public-ci: ${STEP} pasos verdes${OF_PART}"; exit 0; fi
echo "❌ public-ci: ${RED_COUNT} de ${STEP} pasos en rojo${OF_PART}: ${RED_NAMES}"
exit 1
