#!/usr/bin/env bash
# public-ci.sh — todo lo que la CI del repo público corre, en un solo guion (épica 8, story 8.7 · AC 15).
#
# POR QUÉ EXISTE: quien manda un cambio al repo público tiene que poder correr EN SU MÁQUINA lo mismo que corre la CI, y
# la CI tiene que correr un guion del repo, no una lista de comandos escrita en un YAML que nadie prueba. El workflow
# (`.github/workflows/ci.yml`) sólo llama a esto; la prueba que lo compara con el repo del equipo (la T23 de
# export-real.test.sh) corre este mismo guion en los dos lados.
#
# USO:  bash scripts/ci/public-ci.sh [--root <dir>] [--range <base>...<punta>] [--clean-machine]
#   --root <dir>      el repo a revisar; por defecto, el repo donde vive este guion. Corre los archivos DE ESE repo.
#   --range <a>...<b> además, el freno de nombres en castellano sobre ese rango (lo pasa la CI en un pull request)
#   --clean-machine   además, la prueba de la máquina limpia en su modo público (baja imágenes y paquetes: usa la red)
#
# LOS PASOS, en este orden, UNA línea por paso:
#   1 node-check           `node --check` de cada .js que lista `git ls-files` (lo versionado, no lo que haya en disco: en
#                          una máquina instalada `skills/` tiene además las skills de terceros)
#   2 build-check          node build/check.js
#   3 build-generate       node build/generate.js --check
#   4 suites-coverage      node scripts/tests/suites-coverage.test.js
#   5 portable-suites      bash scripts/tests/portable-suites.test.sh
#   6 agent-skills-suites  cada suite de scripts/tests/suites.json (diarias y semanales) que pide EXACTAMENTE
#                          ["agent-skills"]: de a varias a la vez, cada una en su proceso, con su propia HOME vacía y su
#                          TMPDIR, y sin las herramientas del vocabulario en el PATH, como las portables
#   7 controls-bench       node scripts/controls-bench/runner.js --tool both --baseline check --json <salida>/bench.json
#   8 spanish-names        sólo con --range: node scripts/publishing/spanish-names.js --range <rango>
#   9 clean-machine        sólo con --clean-machine: bash scripts/tests/clean-machine.test.sh en su modo público, o sea con
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
  echo "uso: bash scripts/ci/public-ci.sh [--root <dir>] [--range <base>...<punta>] [--clean-machine]" >&2
  exit "$1"
}

ROOT_ARG=""; ROOT_GIVEN=0; RANGE=""; WITH_RANGE=0; CLEAN_MACHINE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --root) [ $# -ge 2 ] || { echo "public-ci: --root pide una carpeta" >&2; usage 2; }; ROOT_ARG="$2"; ROOT_GIVEN=1; shift 2 ;;
    --root=*) ROOT_ARG="${1#--root=}"; ROOT_GIVEN=1; shift ;;
    --range) [ $# -ge 2 ] || { echo "public-ci: --range pide <base>...<punta>" >&2; usage 2; }; RANGE="$2"; WITH_RANGE=1; shift 2 ;;
    --range=*) RANGE="${1#--range=}"; WITH_RANGE=1; shift ;;
    --clean-machine) CLEAN_MACHINE=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "public-ci: argumento desconocido: $1" >&2; usage 2 ;;
  esac
done

# un --root VACÍO (la variable sin definir de quien llama) no es «sin --root»: caer al repo del guion daría el veredicto
# de otro repo que el pedido
if [ "${ROOT_GIVEN}" -eq 1 ]; then
  [ -n "${ROOT_ARG}" ] || { echo "public-ci: --root vino vacío: pide una carpeta" >&2; usage 2; }
  [ -d "${ROOT_ARG}" ] || { echo "public-ci: --root ${ROOT_ARG} no existe" >&2; usage 2; }
  ROOT="$(cd "${ROOT_ARG}" && pwd)"
else
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi

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
# 🔴 «No pude preguntar» no es «no hay skills» (story 8.18, 2026-10-04). La biblioteca tira cuando su vecina
#    (canonical-path.js) está y no carga; con `2>/dev/null || true` eso quedaba como «no encuentro las skills: ni … ni
#    el lugar de instalación», que manda a buscar una instalación que no es el problema. Ahora la causa se dice acá y
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
    echo "public-ci: no pude resolver la carpeta de skills: ${SKILLS_ERROR}"
  fi
fi
export TYCON_GUIDES_DIR="${ROOT}"
[ -z "${SKILLS_REPO}" ] || export TYCON_SKILLS_DIR="${SKILLS_REPO}/skills"

# ── los veredictos ─────────────────────────────────────────────────────────────────────────────────
STEP=0; RED_COUNT=0; RED_NAMES=""
BLOCKED_EXIT=9   # con este exit un paso propio dice «no pude correr»; el motivo es la última línea de su salida
mark_red() { RED_COUNT=$((RED_COUNT + 1)); if [ -z "${RED_NAMES}" ]; then RED_NAMES="$1"; else RED_NAMES="${RED_NAMES}, $1"; fi; }
blocked() { mark_red "$1"; echo "❌ public-ci: $1 — no pude correr: $2"; }

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
  elif [ "${kind}" = "own" ] && [ "${rc}" -eq "${BLOCKED_EXIT}" ]; then
    blocked "${name}" "$(tail -n 1 "${log}" | sed 's/^no pude correr: //')"
  else
    mark_red "${name}"
    echo "❌ public-ci: ${name} — rojo (exit ${rc})"
    tail -n 30 "${log}" | sed 's/^/     /'
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
function launch() {
  while (alive < POOL && next < files.length) {
    const f = files[next++];
    alive++;
    let err = '';
    const p = spawn(process.execPath, ['--check', path.join(ROOT, f)], { stdio: ['ignore', 'ignore', 'pipe'] });
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
  try { fs.writeFileSync(path.join(OUT, 'agent-skills-suites', `${key(e).split('/').join('__')}.log`), output); } catch (_) { /* el veredicto no depende de esto */ }
  if (good) { console.log(`✅ ${key(e)} (${sec(Date.now() - t0)})`); return; }
  red.push(`${key(e)} (${why})`);
  const tail = output.trim().split('\n').slice(-8).map((l) => `     ${l}`).join('\n');
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

# ── la corrida ─────────────────────────────────────────────────────────────────────────────────────
run_step node-check own "" "git node" node_check
run_step build-check file build/check.js "node" node build/check.js
run_step build-generate file build/generate.js "node" node build/generate.js --check
run_step suites-coverage file scripts/tests/suites-coverage.test.js "node" node scripts/tests/suites-coverage.test.js
run_step portable-suites file scripts/tests/portable-suites.test.sh "bash node" bash scripts/tests/portable-suites.test.sh
run_step agent-skills-suites own scripts/tests/suites.json "bash node" agent_skills_suites
run_step controls-bench file scripts/controls-bench/runner.js "node" node scripts/controls-bench/runner.js --tool both --baseline check --json "${OUT}/bench.json"
[ "${WITH_RANGE}" -eq 0 ] || run_step spanish-names own scripts/publishing/spanish-names.js "git node" spanish_names
# la máquina limpia, en su modo PÚBLICO: pedida de forma explícita (sin eso, fuera del nocturno sale NO MEDIDA) y sobre
# ESTE repo (sin eso cae en el modo interno, que exporta la copia desde el repo del equipo)
[ "${CLEAN_MACHINE}" -eq 0 ] || run_step clean-machine file scripts/tests/clean-machine.test.sh "bash" \
  env TYCON_CLEAN_MACHINE=1 TYCON_CLEAN_MACHINE_SOURCE="${ROOT}" bash scripts/tests/clean-machine.test.sh

echo "public-ci: la salida de cada paso quedó en ${OUT}"
if [ "${RED_COUNT}" -eq 0 ]; then echo "✅ public-ci: ${STEP} pasos verdes"; exit 0; fi
echo "❌ public-ci: ${RED_COUNT} de ${STEP} pasos en rojo: ${RED_NAMES}"
exit 1
