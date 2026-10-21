#!/usr/bin/env bash
# public-ci.test.sh — la CI pública: el guion que corre todos los pasos y el `ci.yml` que lo llama.
#
#   T21 · PublicCi_PasoQueNoCorre_EsRojo — `scripts/ci/public-ci.sh` sobre un repo de MENTIRA (un guion mínimo
#         por paso, que anota su llamada en `.calls`): con el archivo de un paso faltando sale 1 con «no pude correr» y el
#         paso; con un paso que sale distinto de 0 sale 1 con el paso y su exit; con `--range` sin historia sale 1 con «no
#         pude correr»; con todo verde sale 0, los pasos en orden, sin llamar al detector, y `node --check` sólo sobre lo
#         versionado (un `.js` roto sin versionar no lo rompe; versionado, sí). No corta en el primer rojo. Las suites
#         que piden agent-skills corren cada una en su HOME vacía, sin las herramientas del vocabulario en el PATH, y su
#         veredicto queda en `agent-skills-suites.tsv`. Sirve en los dos layouts: repo único y dos repos.
#   T22 · PublicCi_Workflow_Seguro — `scripts/ci/check-public-workflow.js` deja pasar el `ci.yml` real (adentro
#         vive en `scripts/publishing/public-files/.github/workflows/`; en la copia pública, en `.github/workflows/`) y
#         da rojo, nombrando la regla, con cada copia alterada: una alteración por regla, y una por cada forma de
#         escribir lo prohibido que las reglas con nombre no ven (ahí la roja es `shape`, la forma exacta del archivo).
#         Entre ellas, la regla `after-queue`: cada job se saltea en el push a main de la cola de merge y
#         sólo en ése; una condición que saltea de más, o un job sin ella, es rojo.
#   T1-T4 · PublicCi_Workflow_SinGuionEnLaBase — sin `scripts/ci/run-base-controls.sh` en la base, el paso de `ci.yml` (su bloque `run`, corrido
#         de verdad) frena en rojo «no pude correr» sin correr nada; con el guion corre el de la base. Una rama que
#         corra los controles del pedido, de vuelta, es rojo en `base-controls`; la guía de detalle lo dice.
#   T24 · PublicCi_PartesQueJuntasSonTodo — la corrida partida para correr a la vez: con
#         TYCON_PUBLIC_CI_PART=checks corren todos los pasos menos las portables; con suites-<i>-of-<n>, sólo las portables
#         con su parte (TYCON_PORTABLE_SHARD=<i>/<n>); un valor que no es una parte sale 2 sin correr nada. Y
#         portable-suites.test.sh, sobre un repo de mentira: las <n> partes juntas son todas las portables, ninguna en dos,
#         cada parte con alguna, las más pesadas primero; una parte mal escrita o un reparto imposible es rojo.
#
# 🔴 El entorno de git de quien llama NO decide nada. Un hook de git (o un `git rebase --exec`) le exporta a lo que
#    lanza GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE y GIT_COMMON_DIR, y esas variables le ganan a la carpeta: sin limpiarlas,
#    los `git commit` de los repos de mentira caen SOBRE LA RAMA de quien corre la suite. Por eso esta suite corre ENTERA
#    con esas cuatro variables apuntando a un repo «de afuera» armado acá: todo git de la suite va por `lab_git` (sin
#    ellas), el guion las saca al arrancar, y al final el repo de afuera tiene que estar idéntico.
#
# Por qué un repo de mentira: el guion real sobre el repo entero tarda más de 15 minutos (lo corre la T23 de
# export-real.test.sh, en el nocturno). Acá se prueba el guion —orden, veredictos, «no pude correr»—, no los pasos.
#
# Portable (`requiere: []`): no necesita agent-skills, ni red, ni ninguna herramienta del vocabulario; corre igual
# adentro de la copia pública.
# Correr: bash scripts/tests/public-ci.test.sh

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${ROOT}/scripts/ci/public-ci.sh"
CHECK="${ROOT}/scripts/ci/check-public-workflow.js"
T="$(mktemp -d "${TMPDIR:-/tmp}/public-ci-test.XXXXXX")"
T="$(cd "${T}" && pwd -P)"
trap 'rm -rf "${T}"' EXIT

# Una HOME vacía para todo lo que corre acá (git sin configuración global, el guion sin nada instalado).
mkdir -p "${T}/home"
export HOME="${T}/home" TYCON_NO_NIGHTLY_EXAM=1 TYCON_NO_GUI_ENV=1 TYCON_CODEX=0
unset XDG_CONFIG_HOME TYCON_PORTABLE_HOME TYCON_PUBLIC_CI_OUT TYCON_PUBLIC_CI_PARALLEL TYCON_PUBLIC_CI_CAP_MS \
  TYCON_CLEAN_MACHINE TYCON_CLEAN_MACHINE_SOURCE TYCON_PUBLIC_CI_PART TYCON_PORTABLE_SHARD TYCON_PORTABLE_PARALLEL
# git de la suite: sin las variables que git le pasa a lo que lanza un hook (la carpeta decide el repo, nada más)
lab_git() {
  env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u GIT_COMMON_DIR \
    git -c user.email=t@t -c user.name=t -c commit.gpgsign=false "$@"
}
# El repo «de afuera»: el de alguien que corre esta suite desde un hook. Trae un .js que no compila: si el guion mirara
# este repo en vez del de --root, `node-check` lo diría. De acá en adelante TODO corre con las cuatro variables puestas.
OUTER="${T}/outer"; mkdir -p "${OUTER}"
printf 'trabajo de quien llama\n' > "${OUTER}/work.txt"; printf 'function ( {\n' > "${OUTER}/broken-in-the-outer-repo.js"
( cd "${OUTER}" && lab_git init -q . && lab_git add -A && lab_git commit -qm "trabajo de quien llama" ) > /dev/null 2>&1
# el estado del repo de afuera: el commit, las ramas, el índice (por contenido y por archivo) y lo que hay en la carpeta
outer_state() {
  lab_git -C "${OUTER}" rev-parse HEAD 2>&1; lab_git -C "${OUTER}" for-each-ref 2>&1; lab_git -C "${OUTER}" ls-files -s 2>&1
  cksum < "${OUTER}/.git/index" 2>&1; ls -A "${OUTER}" 2>&1
}
OUTER_BEFORE="$(outer_state)"
export GIT_DIR="${OUTER}/.git" GIT_INDEX_FILE="${OUTER}/.git/index" GIT_WORK_TREE="${OUTER}" GIT_COMMON_DIR="${OUTER}/.git"

TOTAL=0; FAILS=0
ok() { TOTAL=$((TOTAL + 1)); echo "✅ $1"; }
no() { TOTAL=$((TOTAL + 1)); FAILS=$((FAILS + 1)); echo "❌ $1"; }
# is <etiqueta> <esperado> <obtenido>
is() { if [ "$2" = "$3" ]; then ok "$1"; else no "$1 — esperaba «${2}» y dio «${3}»"; fi; }
# has <etiqueta> <archivo> <texto literal> · lacks: lo contrario
has() { if grep -qF -- "$3" "$2" 2>/dev/null; then ok "$1"; else no "$1 — no aparece «${3}» en ${2#${T}/}: $(tail -n 6 "$2" 2>/dev/null | tr '\n' ' ')"; fi; }
lacks() { if grep -qF -- "$3" "$2" 2>/dev/null; then no "$1 — aparece «${3}» en ${2#${T}/}"; else ok "$1"; fi; }
# los pasos, en el orden en que salieron (sólo las líneas de veredicto: «✅ public-ci: <paso> …» / «❌ public-ci: <paso> …»)
steps_of() { sed -n 's/^[^ ][^ ]* public-ci: \([a-z][a-z-]*\) .*$/\1/p' "$1" | tr '\n' ' ' | sed 's/ $//'; }
# las llamadas que anotaron los guiones de mentira, sin las de las suites (que corren a la vez y no tienen orden)
calls_of() { grep -v '^suite-' "$1/.calls" 2>/dev/null; }

if [ ! -f "${SCRIPT}" ]; then no "T21 no existe scripts/ci/public-ci.sh"; fi
if [ ! -f "${CHECK}" ]; then no "T22 no existe scripts/ci/check-public-workflow.js"; fi

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
# El repo de mentira: un guion mínimo por paso. Cada uno anota «<nombre> <argumentos>» en `.calls`, relativo a la
# carpeta desde donde lo corren (así también se mide que el guion corre cada paso desde la raíz).
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
fake_js() { # <archivo> <nombre>
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "require('fs').appendFileSync('.calls', '$2 ' + process.argv.slice(2).join(' ') + '\\n');" > "$1"
}
fake_sh() { # <archivo> <nombre>
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "echo \"$2 \$*\" >> .calls" > "$1"
}
make_repo() { # <carpeta>
  local r="$1"
  mkdir -p "${r}/scripts/tests" "${r}/scripts/controls-bench"
  fake_js "${r}/build/check.js" build-check
  fake_js "${r}/build/generate.js" build-generate
  fake_js "${r}/scripts/tests/suites-coverage.test.js" suites-coverage
  # las portables: anota además con qué layout la llamaron y qué repo ve git desde un paso (el de --root, no el de quien llama)
  printf '%s\n' 'echo "portable-suites skills=${TYCON_SKILLS_DIR:-} guides=${TYCON_GUIDES_DIR:-} git=$(git rev-parse --show-toplevel 2>/dev/null) shard=${TYCON_PORTABLE_SHARD:-}" >> .calls' > "${r}/scripts/tests/portable-suites.test.sh"
  # el banco: tiene que dejar su reporte donde le dicen
  cat > "${r}/scripts/controls-bench/runner.js" <<'JS'
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync('.calls', 'controls-bench ' + a.join(' ') + '\n');
const i = a.indexOf('--json');
if (i >= 0) fs.writeFileSync(a[i + 1], JSON.stringify({ results: {} }));
JS
  fake_js "${r}/scripts/publishing/spanish-names.js" spanish-names
  fake_js "${r}/scripts/publishing/detector.js" detector
  # la máquina limpia: imprime además las dos variables de su modo público
  printf '%s\n' 'echo "clean-machine $*" >> .calls' \
    'echo "TYCON_CLEAN_MACHINE=${TYCON_CLEAN_MACHINE:-} TYCON_CLEAN_MACHINE_SOURCE=${TYCON_CLEAN_MACHINE_SOURCE:-}"' > "${r}/scripts/tests/clean-machine.test.sh"
  # las suites: tres que piden exactamente agent-skills (dos diarias —una en cada raíz— y una semanal), una portable,
  # una que pide algo más, y la que corre este guion (export-real), que adentro de él sería infinita
  cat > "${r}/scripts/tests/alpha.test.js" <<'JS'
const fs = require('fs');
const path = require('path');
const h = process.env.HOME || '';
const link = fs.existsSync(path.join(h, '.claude', 'agent-skills', 'skills', 'tycon-pipeline')) ? 'yes' : 'no';
const engram = (process.env.PATH || '').split(':').some((d) => fs.existsSync(path.join(d, 'engram'))) ? 'yes' : 'no';
fs.appendFileSync('.calls', `suite-alpha home=${h} link=${link} engram=${engram} guides=${process.env.TYCON_GUIDES_DIR} skills=${process.env.TYCON_SKILLS_DIR} tmp=${process.env.TMPDIR}\n`);
console.log('alpha: salida de la suite');
JS
  mkdir -p "${r}/skills/tycon-pipeline/scripts/tests"
  printf '%s\n' 'echo "suite-beta home=${HOME}" >> .calls' > "${r}/skills/tycon-pipeline/scripts/tests/beta.test.sh"
  fake_sh "${r}/scripts/tests/weekly.test.sh" suite-weekly
  fake_js "${r}/scripts/tests/portable.test.js" suite-portable
  fake_js "${r}/scripts/tests/more.test.js" suite-more
  fake_sh "${r}/scripts/tests/export-real.test.sh" suite-export-real
  cat > "${r}/scripts/tests/suites.json" <<'JSON'
{
  "diarias": [
    { "raiz": "arnes", "ruta": "tests/alpha.test.js", "requiere": ["agent-skills"] },
    { "raiz": "agent-skills", "ruta": "tycon-pipeline/scripts/tests/beta.test.sh", "requiere": ["agent-skills"] },
    { "raiz": "arnes", "ruta": "tests/portable.test.js", "requiere": [] },
    { "raiz": "arnes", "ruta": "tests/more.test.js", "requiere": ["agent-skills", "engram"] },
    { "raiz": "arnes", "ruta": "tests/export-real.test.sh", "requiere": ["agent-skills"] }
  ],
  "semanales": [
    { "raiz": "arnes", "ruta": "tests/weekly.test.sh", "requiere": ["agent-skills"] }
  ]
}
JSON
  printf '.calls\n.advisors/\n' > "${r}/.gitignore"
  mkdir -p "${r}/.githooks"
  printf '%s\n' 'echo "repo-lint head=$(git log -1 --format=%s HEAD) staged=$(git diff --cached --name-only | tr "\n" " ")" >> "$(cd "$(git rev-parse --git-common-dir)/.." && pwd)/.calls"' \
    '[ ! -f lint-rojo ] || { echo "el pre-commit frena"; exit 1; }' > "${r}/.githooks/pre-commit-checks"
  printf '{ "version": "2026.01.01.1" }\n' > "${r}/version.json"
  # el paso `version` lee la regla del repo (scripts/ci/version-tag.js check-pr): va la de verdad, no una de mentira
  mkdir -p "${r}/scripts/ci" "${r}/scripts/setup/harness"
  cp "${ROOT}/scripts/ci/version-tag.js" "${r}/scripts/ci/version-tag.js"
  cp "${ROOT}/scripts/setup/harness/version-order.js" "${r}/scripts/setup/harness/version-order.js"
  ( cd "${r}" && lab_git init -q . && lab_git add -A && lab_git commit -qm base \
      && echo "// segundo commit" >> build/check.js && printf '{ "version": "2026.01.01.2" }\n' > version.json \
      && lab_git commit -qam historia ) > /dev/null 2>&1 \
    || { no "no pude armar el repo de mentira en ${r}"; return 1; }
  # un .js roto SIN versionar: no es del repo, `node --check` no lo mira
  mkdir -p "${r}/scratch"; printf 'function ( {\n' > "${r}/scratch/broken.js"
}
# variant <nombre> → copia el repo base a ${T}/<nombre> y deja R apuntando ahí
variant() { R="${T}/$1"; cp -R "${T}/base" "${R}"; rm -f "${R}/.calls"; }
commit_all() { ( cd "${R}" && lab_git add -A -- . ':!scratch' ':!tools-rel' && lab_git commit -qm "$1" ) > /dev/null 2>&1 || no "no pude commitear en ${R#${T}/} ($1)"; }
# run_ci <args…> → corre el guion real sobre ${R}, desde OTRA carpeta, con una herramienta del vocabulario en el PATH;
# deja la salida en ${R}.out, la carpeta de TYCON_PUBLIC_CI_OUT en ${R}.ci y el exit en RC
mkdir -p "${T}/fakebin" "${T}/elsewhere" "${T}/no-skills"
printf '#!/bin/sh\nexit 0\n' > "${T}/fakebin/engram"; chmod +x "${T}/fakebin/engram"
RC=0
run_ci() { # PATH_PREFIX (opcional): entradas que van ADELANTE en el PATH, con su «:» final
  ( cd "${T}/elsewhere" && PATH="${PATH_PREFIX:-}${T}/fakebin:${PATH}" TYCON_PUBLIC_CI_OUT="${R}.ci" TYCON_SKILLS_DIR="${SKILLS_ENV:-${T}/no-skills}" \
      bash "${SCRIPT}" --root "${R}" "$@" ) > "${R}.out" 2>&1
  RC=$?
}
SEVEN="node-check build-check build-generate suites-coverage portable-suites agent-skills-suites controls-bench"

make_repo "${T}/base"
is "T21 armar los repos de mentira no toca el repo de quien llama (GIT_DIR y compañía puestos)" "${OUTER_BEFORE}" "$(outer_state)"

# ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
# T21 (d) · todo verde, sin opciones: 0, los siete pasos en orden, sin el detector, sólo lo versionado
# ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
variant green; SKILLS_ENV=""; run_ci
is "T21 (d) todo verde sale 0" 0 "${RC}"
is "T21 (d) los siete pasos, en orden" "${SEVEN}" "$(steps_of "${R}.out")"
is "T21 (d) una línea «✅ public-ci: <paso> (Ns)» por paso" 7 "$(grep -cE '^✅ public-ci: [a-z-]+ \([0-9]+s\)$' "${R}.out")"
is "T21 (d) la última línea es el resumen" "✅ public-ci: 7 pasos verdes" "$(tail -n 1 "${R}.out")"
printf '%s\n' "build-check " "build-generate --check" "suites-coverage " "portable-suites skills=${R}/skills guides=${R} git=${R} shard=" \
  "controls-bench --tool both --baseline check --json ${R}.ci/bench.json" > "${R}.expected"
if calls_of "${R}" | cmp -s - "${R}.expected"; then ok "T21 (d) cada paso se llamó una vez, en orden, con sus argumentos, desde la raíz y con git mirando el repo de --root"
else no "T21 (d) las llamadas no son las esperadas: $(calls_of "${R}" | tr '\n' '|')"; fi
lacks "T21 (d) no corre el detector" "${R}/.calls" "detector"
lacks "T21 (d) sin --range no corre el freno de nombres" "${R}/.calls" "spanish-names"
lacks "T21 (d) sin --clean-machine no corre la máquina limpia" "${R}/.calls" "clean-machine"
has "T21 (d) node --check mira sólo lo versionado (el .js roto sin versionar no cuenta)" "${R}.ci/1-node-check.log" "node-check: 11 .js versionados · 0 no compilan"
# las suites que piden agent-skills: las tres, entre las portables y el banco, cada una en su HOME vacía
is "T21 (d) corren las tres suites que piden exactamente agent-skills (diarias y semanales), y ninguna otra" \
  "suite-alpha suite-beta suite-weekly" "$(grep '^suite-' "${R}/.calls" | cut -d' ' -f1 | sort | tr '\n' ' ' | sed 's/ $//')"
FIRST_SUITE="$(grep -n '^suite-' "${R}/.calls" | head -n 1 | cut -d: -f1)"; LAST_SUITE="$(grep -n '^suite-' "${R}/.calls" | tail -n 1 | cut -d: -f1)"
AT_PORTABLE="$(grep -n '^portable-suites' "${R}/.calls" | cut -d: -f1)"; AT_BENCH="$(grep -n '^controls-bench' "${R}/.calls" | cut -d: -f1)"
if [ -n "${FIRST_SUITE}" ] && [ "${AT_PORTABLE:-0}" -lt "${FIRST_SUITE}" ] && [ "${LAST_SUITE}" -lt "${AT_BENCH:-0}" ]; then ok "T21 (d) las suites corren después de las portables y antes del banco"
else no "T21 (d) las suites no corrieron entre las portables y el banco: $(tr '\n' '|' < "${R}/.calls")"; fi
ALPHA="$(grep '^suite-alpha' "${R}/.calls")"
HOME_ALPHA="$(printf '%s' "${ALPHA}" | sed -n 's/^.* home=\([^ ]*\) .*$/\1/p')"; HOME_BETA="$(sed -n 's/^suite-beta home=\(.*\)$/\1/p' "${R}/.calls")"
case "${ALPHA}" in *" link=yes engram=no guides=${R} skills=${R}/skills tmp="*) ok "T21 (d) la suite ve las skills instaladas, el layout y ninguna herramienta del vocabulario" ;;
  *) no "T21 (d) el entorno de la suite no es el esperado: ${ALPHA}" ;; esac
if [ -n "${HOME_ALPHA}" ] && [ -n "${HOME_BETA}" ] && [ "${HOME_ALPHA}" != "${HOME_BETA}" ] && [ "${HOME_ALPHA}" != "${HOME}" ] && [ "${HOME_BETA}" != "${HOME}" ]; then
  ok "T21 (d) cada suite corre en SU PROPIA HOME, que no es la de quien llama"
else no "T21 (d) las HOME de las suites: alpha «${HOME_ALPHA}» · beta «${HOME_BETA}» · la de quien llama «${HOME}»"; fi
if [ -n "${HOME_ALPHA}" ] && [ ! -e "${HOME_ALPHA}" ] && [ -z "$(ls -A "${R}/.advisors" 2>/dev/null)" ]; then ok "T21 (d) las HOME vacías se borran al terminar"
else no "T21 (d) quedaron HOME vacías sin borrar (${HOME_ALPHA} · $(ls -A "${R}/.advisors" 2>/dev/null | tr '\n' ' '))"; fi
# lo que queda en TYCON_PUBLIC_CI_OUT
printf '✅\t%s\n' "agent-skills/tycon-pipeline/scripts/tests/beta.test.sh" "arnes/tests/alpha.test.js" "arnes/tests/weekly.test.sh" > "${R}.tsv"
if cmp -s "${R}.ci/agent-skills-suites.tsv" "${R}.tsv"; then ok "T21 (d) agent-skills-suites.tsv trae el veredicto de cada suite, ordenado por raiz/ruta"
else no "T21 (d) agent-skills-suites.tsv no es el esperado: $(tr '\n\t' '| ' < "${R}.ci/agent-skills-suites.tsv" 2>/dev/null)"; fi
MISSING=""
for f in 1-node-check.log 2-build-check.log 3-build-generate.log 4-suites-coverage.log 5-portable-suites.log 6-agent-skills-suites.log \
  7-controls-bench.log bench.json agent-skills-suites/arnes__tests__alpha.test.js.log agent-skills-suites/arnes__tests__weekly.test.sh.log \
  agent-skills-suites/agent-skills__tycon-pipeline__scripts__tests__beta.test.sh.log; do
  [ -f "${R}.ci/${f}" ] || MISSING="${MISSING} ${f}"
done
is "T21 (d) la salida de cada paso, la de cada suite y el reporte del banco quedan en TYCON_PUBLIC_CI_OUT" "" "${MISSING}"
has "T21 (d) el archivo de cada suite trae SU salida" "${R}.ci/agent-skills-suites/arnes__tests__alpha.test.js.log" "alpha: salida de la suite"

# con --range y --clean-machine: los once pasos; sin TYCON_PUBLIC_CI_OUT, la carpeta temporal se nombra y existe
variant green9
( cd "${T}/elsewhere" && TYCON_SKILLS_DIR="${T}/no-skills" bash "${SCRIPT}" --root "${R}" --range 'HEAD~1...HEAD' --clean-machine ) > "${R}.out" 2>&1; RC=$?
is "T21 (d) todo verde con --range y --clean-machine sale 0" 0 "${RC}"
is "T21 (d) los once pasos, en orden" "${SEVEN} spanish-names repo-lint version clean-machine" "$(steps_of "${R}.out")"
is "T21 (d) el resumen cuenta los once" "✅ public-ci: 11 pasos verdes" "$(tail -n 1 "${R}.out")"
is "T21 (d) el freno de nombres recibe el rango, el pre-commit ve lo que trae el rango sobre la base, y la máquina limpia va al final" \
  "spanish-names --range HEAD~1...HEAD|repo-lint head=base staged=build/check.js version.json |clean-machine |" \
  "$(calls_of "${R}" | tail -n 3 | tr '\n' '|')"
is "T21 (d) la copia de trabajo del pre-commit no queda" "" "$(git -C "${R}" worktree list | sed -n 2p)"
lacks "T21 (d) tampoco con todas las opciones corre el detector" "${R}/.calls" "detector"
OUT_DIR="$(sed -n 's/^public-ci: la salida de cada paso quedó en \(.*\)$/\1/p' "${R}.out")"
if [ -n "${OUT_DIR}" ] && [ -f "${OUT_DIR}/11-clean-machine.log" ]; then
  ok "T21 (d) sin TYCON_PUBLIC_CI_OUT la salida va a una carpeta temporal que el resumen nombra"
  # la máquina limpia corre en su modo PÚBLICO: pedida de forma explícita y sobre el repo de --root
  has "T21 (d) la máquina limpia recibe TYCON_CLEAN_MACHINE=1 y TYCON_CLEAN_MACHINE_SOURCE=<raíz>" "${OUT_DIR}/11-clean-machine.log" \
    "TYCON_CLEAN_MACHINE=1 TYCON_CLEAN_MACHINE_SOURCE=${R}"
  rm -rf "${OUT_DIR}"
else no "T21 (d) el resumen no nombra una carpeta con la salida de cada paso («${OUT_DIR}»): $(tail -n 3 "${R}.out" | tr '\n' ' ')"; fi

# el pedido: un pre-commit que frena es rojo de repo-lint; una versión que no sube es rojo de version
variant lintred; ( cd "${R}" && touch lint-rojo && lab_git add lint-rojo && lab_git commit -qm "con lint rojo" ) > /dev/null 2>&1
run_ci --range 'HEAD~1...HEAD'
is "T21 (e) un pre-commit que frena sobre el rango sale 1" 1 "${RC}"
has "T21 (e) …con repo-lint en rojo" "${R}.out" "❌ public-ci: repo-lint — rojo (exit 1)"
has "T21 (e) …y su motivo" "${R}.out" "el pre-commit frena"
# la cola de un paso rojo puede traer texto del pedido: ningún comando de la CI («::», «##») sale entero
variant lintinject
printf '%s\n' 'echo "::error::forjado"; echo "##vso[task.complete result=Succeeded]"; printf "x\r:::warning:::y ###vso[z]\n"; exit 1' > "${R}/.githooks/pre-commit-checks"
( cd "${R}" && lab_git add -A -- . ':!scratch' && lab_git commit -qm "pre-commit que imprime comandos" ) > /dev/null 2>&1
run_ci --range 'HEAD~1...HEAD'
has "T21 (e) la cola del paso rojo se muestra" "${R}.out" ": :error: :forjado"
lacks "T21 (e) …sin un «::» entero (GitHub)" "${R}.out" "::error::"
lacks "T21 (e) …ni un «##» entero (Azure)" "${R}.out" "##vso"
if grep -E '::|##' "${R}.out" >/dev/null; then no "T21 (e) un «:::», «###» o un retorno de carro dejó un par entero"; else ok "T21 (e) …tampoco de a tres ni detrás de un retorno de carro"; fi
# el nombre del registro de una suite sale de suites.json del pedido: no arma una línea ni un comando de la CI
variant weirdsuite; SKILLS_ENV=""
node -e 'const f=process.argv[1];const j=JSON.parse(require("fs").readFileSync(f,"utf8"));j.diarias.push({raiz:"arnes",ruta:"tests/x\n::warning::y.test.sh",requiere:["agent-skills"]});require("fs").writeFileSync(f,JSON.stringify(j,null,2))' "${R}/scripts/tests/suites.json"
( cd "${R}" && lab_git add -A -- . ':!scratch' && lab_git commit -qm "una suite con un nombre raro" ) > /dev/null 2>&1
run_ci
if ls "${R}.ci/agent-skills-suites" 2>/dev/null | grep -E '::|[[:cntrl:]]' >/dev/null; then no "T21 (e) el nombre de un registro de suite trae un comando de la CI o un salto de línea"
elif [ -n "$(ls "${R}.ci/agent-skills-suites" 2>/dev/null)" ]; then ok "T21 (e) los nombres de los registros de las suites salen sólo con caracteres seguros"
else no "T21 (e) no quedó ningún registro de suite que mirar"; fi
variant samever; ( cd "${R}" && echo "// sin subir la versión" >> build/check.js && lab_git commit -qam "sin versión" ) > /dev/null 2>&1
run_ci --range 'HEAD~1...HEAD'
is "T21 (e) una versión que no sube sale 1" 1 "${RC}"
has "T21 (e) …con version en rojo" "${R}.out" "❌ public-ci: version — rojo (exit 1)"
has "T21 (e) …diciendo qué hacer" "${R}.out" "cada pedido sube la versión"
# el paquete de npm sin su regla: un repo que trae scripts/setup/npm/package.json pero no
# scripts/ci/npm-package-version.js no es «sin nada que exigir»: es «no pude correr», rojo
variant npmnorule
( cd "${R}" && mkdir -p scripts/setup/npm && printf '{ "name": "@acme/paquete", "version": "1.0.0" }\n' > scripts/setup/npm/package.json \
    && printf '{ "version": "2026.01.01.3" }\n' > version.json && lab_git add -A -- . ':!scratch' && lab_git commit -qm "paquete sin regla" ) > /dev/null 2>&1
run_ci --range 'HEAD~1...HEAD'
is "T21 (e) el paquete de npm sin npm-package-version.js sale 1" 1 "${RC}"
has "T21 (e) …con version «no pude correr» nombrando la regla que falta" "${R}.out" "❌ public-ci: version — no pude correr: "
has "T21 (e) …y el archivo" "${R}.out" "scripts/ci/npm-package-version.js"

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
# T14 · PublicCi_NoBase_SameAsToday — sin --base el guion corre los controles de su propio árbol
# y lo dice; con --base, un pedido que no toca ningún control da el mismo veredicto y los mismos pasos
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
variant nobase; run_ci --range 'HEAD~1...HEAD'
is "T14 sin --base: el veredicto de siempre" 0 "${RC}"
NOBASE_STEPS="$(steps_of "${R}.out")"
has "T14 sin --base el repo-lint lo dice" "$(ls "${R}.ci"/*-repo-lint.log | head -n 1)" "sin --base: los controles salen de este mismo árbol"
variant withbase
mkdir -p "${R}/scripts/ci"; cp "${ROOT}/scripts/ci/run-base-controls.sh" "${R}/scripts/ci/run-base-controls.sh"
cat > "${R}/scripts/ci/controls-from-base.json" <<'JSON'
{ "hook": ".githooks/pre-commit-checks",
  "passes": [ { "name": "pre-commit", "mode": "index", "cmd": ["bash", ".githooks/pre-commit-checks"] } ],
  "controls": [ { "name": "base-controls", "script": "scripts/ci/run-base-controls.sh", "rules": [] } ],
  "content": [], "workflows": [], "approvals": ".tycon/control-changes.jsonl" }
JSON
commit_all "la base con su inventario"; lab_git -C "${R}" tag base-ref
( cd "${R}" && printf 'un documento\n' > leeme.txt && printf '{ "version": "2026.01.01.3" }\n' > version.json ) ; commit_all "el pedido"
run_ci --range 'base-ref...HEAD' --base base-ref
is "T14 con --base, un pedido que no toca controles: el mismo veredicto" 0 "${RC}"
is "T14 con --base, los mismos pasos" "${NOBASE_STEPS}" "$(steps_of "${R}.out")"
LINT_LOG="$(ls "${R}.ci"/*-repo-lint.log | head -n 1)"
has "T14 con --base el repo-lint dice de dónde salen los controles" "${LINT_LOG}" "los controles y su regla salen de la base base-ref"
has "T14 con --base corrió la revisión desde la base, en verde" "${LINT_LOG}" "✅ base-controls: verde"
has "T14 el pre-commit corrió sobre lo que trae el pedido" "${R}/.calls" "staged=leeme.txt version.json"
run_ci --base base-ref
is "T14 --base sin --range es un error de uso (exit 2)" 2 "${RC}"
run_ci --range 'base-ref...HEAD' --base=
is "T14 --base= vacío es un error de uso (exit 2)" 2 "${RC}"
run_ci --range 'base-ref...HEAD' --base=base-ref
is "T14 --base=<rev> es lo mismo que --base <rev>" 0 "${RC}"
# lo que se suma a una regla se ve en la salida aunque el paso salga verde
( cd "${R}" && node -e 'const f="scripts/ci/controls-from-base.json";const j=JSON.parse(require("fs").readFileSync(f,"utf8"));j.content.push("una-suma.json");require("fs").writeFileSync(f,JSON.stringify(j,null,2))' ); commit_all "suma una entrada al inventario"
run_ci --range 'base-ref...HEAD' --base base-ref
is "T14 sumar una entrada al inventario no frena" 0 "${RC}"
has "T14 …pero se ve en la salida, en verde" "${R}.out" '+ content: "una-suma.json"'
# una base que resuelve pero no trae el guion de la revisión: no pude correr, nunca los controles del pedido solos
lab_git -C "${R}" tag sin-guion base-ref~1
run_ci --range 'sin-guion...HEAD' --base sin-guion
is "T14 una base sin run-base-controls.sh: rojo" 1 "${RC}"
has "T14 …«no pude correr», nombrando lo que falta" "${R}.out" "no trae scripts/ci/run-base-controls.sh"
variant badbase; run_ci --range 'HEAD~1...HEAD' --base no-existe
is "T14 una base que no resuelve: rojo, nunca los controles del pedido" 1 "${RC}"
has "T14 …«no pude correr»" "${R}.out" "❌ public-ci: repo-lint — no pude correr: "
if grep -qF 'secrets.' "${ROOT}/.github/workflows/ci.yml" 2>/dev/null; then no "T14 el workflow lee un secreto"; else ok "T14 el workflow sigue sin leer ningún secreto"; fi

# el control del «sólo lo versionado»: el mismo .js roto, versionado, sí es rojo
variant tracked; ( cd "${R}" && lab_git add scratch/broken.js && lab_git commit -qm roto ) > /dev/null 2>&1; run_ci
is "T21 (d) un .js versionado que no compila sale 1" 1 "${RC}"
has "T21 (d) …con node-check en rojo" "${R}.out" "❌ public-ci: node-check — rojo (exit 1)"
has "T21 (d) …nombrando el archivo" "${R}.out" "scratch/broken.js"
is "T21 (d) …y el resumen nombra el paso" "❌ public-ci: 1 de 7 pasos en rojo: node-check" "$(tail -n 1 "${R}.out")"

# ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
# T21 (a) · falta el archivo de un paso: rojo «no pude correr», nunca un salto (y los demás corren igual)
# ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
variant missing; rm -f "${R}/build/generate.js" "${R}/scripts/tests/clean-machine.test.sh"; commit_all "sin dos archivos"; run_ci --clean-machine
is "T21 (a) con el archivo de un paso faltando sale 1" 1 "${RC}"
has "T21 (a) el paso es rojo con «no pude correr» y el archivo" "${R}.out" "❌ public-ci: build-generate — no pude correr: falta build/generate.js"
has "T21 (a) --clean-machine sin su prueba (antes de la tanda C) es rojo «no pude correr»" "${R}.out" "❌ public-ci: clean-machine — no pude correr: falta scripts/tests/clean-machine.test.sh"
is "T21 (a) el paso que no corrió figura en su lugar: no se saltea" "${SEVEN} clean-machine" "$(steps_of "${R}.out")"
is "T21 (a) los demás pasos corren igual" "build-check|suites-coverage|portable-suites|controls-bench|" "$(calls_of "${R}" | cut -d' ' -f1 | tr '\n' '|')"
is "T21 (a) el resumen nombra los pasos en rojo" "❌ public-ci: 2 de 8 pasos en rojo: build-generate, clean-machine" "$(tail -n 1 "${R}.out")"

# ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
# T21 (b) · un paso sale distinto de 0, y una suite de las que piden agent-skills da rojo: no corta en el primero
# ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
variant red
echo "process.exit(3);" >> "${R}/scripts/tests/suites-coverage.test.js"
echo "console.log('alpha: ASERCIÓN ROTA'); process.exit(1);" >> "${R}/scripts/tests/alpha.test.js"
commit_all "dos rojos"; run_ci
is "T21 (b) con un paso que sale distinto de 0 sale 1" 1 "${RC}"
has "T21 (b) el paso es rojo con su exit" "${R}.out" "❌ public-ci: suites-coverage — rojo (exit 3)"
has "T21 (b) el paso de las suites es rojo" "${R}.out" "❌ public-ci: agent-skills-suites — rojo (exit 1)"
has "T21 (b) …y nombra la suite roja" "${R}.out" "❌ arnes/tests/alpha.test.js"
is "T21 (b) no corta en el primer rojo: salen los siete pasos" "${SEVEN}" "$(steps_of "${R}.out")"
is "T21 (b) …y los pasos de después se corrieron" "build-check|build-generate|suites-coverage|portable-suites|controls-bench|" "$(calls_of "${R}" | cut -d' ' -f1 | tr '\n' '|')"
is "T21 (b) el resumen nombra los dos" "❌ public-ci: 2 de 7 pasos en rojo: suites-coverage, agent-skills-suites" "$(tail -n 1 "${R}.out")"
{ printf '✅\t%s\n' "agent-skills/tycon-pipeline/scripts/tests/beta.test.sh"; printf '❌\t%s\n' "arnes/tests/alpha.test.js"; printf '✅\t%s\n' "arnes/tests/weekly.test.sh"; } > "${R}.tsv"
if cmp -s "${R}.ci/agent-skills-suites.tsv" "${R}.tsv"; then ok "T21 (b) agent-skills-suites.tsv trae la verde y la roja"
else no "T21 (b) agent-skills-suites.tsv no es el esperado: $(tr '\n\t' '| ' < "${R}.ci/agent-skills-suites.tsv" 2>/dev/null)"; fi
has "T21 (b) el archivo de la suite roja trae su salida" "${R}.ci/agent-skills-suites/arnes__tests__alpha.test.js.log" "alpha: ASERCIÓN ROTA"

# ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
# T21 (c) · --range con una historia que no alcanza: rojo «no pude correr», y el freno de nombres no se llama
# ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
variant norange; run_ci --range 'origin/main...HEAD'
is "T21 (c) --range sin historia sale 1" 1 "${RC}"
has "T21 (c) el paso es rojo con «no pude correr»" "${R}.out" "❌ public-ci: spanish-names — no pude correr: "
has "T21 (c) …y dice qué punta no resuelve" "${R}.out" "origin/main"
lacks "T21 (c) el freno de nombres no se llama con un rango que no resuelve" "${R}/.calls" "spanish-names"
has "T21 (c) el pre-commit del rango tampoco corre: «no pude correr»" "${R}.out" "❌ public-ci: repo-lint — no pude correr: "
has "T21 (c) ni la versión: «no pude correr»" "${R}.out" "❌ public-ci: version — no pude correr: "
lacks "T21 (c) el pre-commit no se llama con un rango que no resuelve" "${R}/.calls" "repo-lint"
is "T21 (c) el resumen nombra los tres pasos del rango" "❌ public-ci: 3 de 10 pasos en rojo: spanish-names, repo-lint, version" "$(tail -n 1 "${R}.out")"
variant badrange; run_ci --range 'HEAD'
has "T21 (c) un rango que no es <base>...<punta> también es «no pude correr»" "${R}.out" "❌ public-ci: spanish-names — no pude correr: "

# ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
# T21 · los dos layouts, las suites que no se pueden correr y los argumentos
# ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
# dos repos (el interno): sin skills/ en la raíz, las skills salen de TYCON_SKILLS_DIR por scripts/lib/skills-dir.js
variant tworepos
mkdir -p "${T}/sk/skills" "${R}/scripts/lib"; mv "${R}/skills/tycon-pipeline" "${T}/sk/skills/tycon-pipeline"; rmdir "${R}/skills"
cp "${ROOT}/scripts/lib/skills-dir.js" "${R}/scripts/lib/skills-dir.js"; commit_all "dos repos"
SKILLS_ENV="${T}/sk"; run_ci; SKILLS_ENV=""
is "T21 con dos repos (TYCON_SKILLS_DIR) todo verde sale 0" 0 "${RC}"
has "T21 con dos repos las portables reciben las skills del otro repo" "${R}/.calls" "portable-suites skills=${T}/sk/skills guides=${R}"
has "T21 con dos repos corre la suite que vive en el otro repo" "${R}/.calls" "suite-beta home="
has "T21 con dos repos la suite ve las skills del otro repo" "${R}/.calls" " link=yes engram=no guides=${R} skills=${T}/sk/skills tmp="
# sin skills a la vista: no pude correr
rm -f "${R}/.calls"; run_ci
is "T21 sin skills a la vista sale 1" 1 "${RC}"
has "T21 sin skills a la vista las suites son «no pude correr»" "${R}.out" "❌ public-ci: agent-skills-suites — no pude correr: "
has "T21 sin skills a la vista el motivo es que no están (la biblioteca contestó, y ahí no hay skills)" "${R}.out" "no pude correr: no encuentro las skills"
lacks "T21 sin skills a la vista no se dice «no pude resolver»: eso es otra cosa" "${R}.out" "no pude resolver la carpeta de skills"
lacks "T21 sin skills a la vista no corre ninguna suite" "${R}/.calls" "suite-"
if [ -f "${R}.ci/agent-skills-suites.tsv" ]; then no "T21 sin skills a la vista quedó un agent-skills-suites.tsv (de la corrida anterior): un veredicto viejo no es un veredicto"
else ok "T21 una corrida no deja en pie el .tsv de la anterior"; fi
# la biblioteca que ubica las skills NO PUDO contestar (su vecina está y rompe al cargarse): no es «no hay skills». El
# guion lo dice con la causa, y el paso de las suites es «no pude correr» por ESO.
# 🔴 Con `2>/dev/null || true` la carpeta quedaría vacía y el paso diría «no encuentro las skills: ni … ni el
#    lugar de instalación», mandando a buscar una instalación que no es el problema.
variant brokenlib
mkdir -p "${R}/scripts/lib"; rm -rf "${R}/skills"
cp "${ROOT}/scripts/lib/skills-dir.js" "${R}/scripts/lib/skills-dir.js"
printf '%s\n' 'throw new Error("biblioteca rota a propósito")' > "${R}/scripts/lib/canonical-path.js"; commit_all "la vecina de skills-dir.js no carga"
( cd "${T}/elsewhere" && env -u TYCON_SKILLS_DIR PATH="${T}/fakebin:${PATH}" TYCON_PUBLIC_CI_OUT="${R}.ci" bash "${SCRIPT}" --root "${R}" ) > "${R}.out" 2>&1; RC=$?
is "T21 con la biblioteca de las skills rota sale 1" 1 "${RC}"
has "T21 con la biblioteca rota el guion dice que no pudo resolver, con la causa" "${R}.out" "public-ci: no pude resolver la carpeta de skills: biblioteca rota a propósito"
has "T21 con la biblioteca rota las suites son «no pude correr» por esa causa" "${R}.out" "❌ public-ci: agent-skills-suites — no pude correr: no pude resolver la carpeta de skills: biblioteca rota a propósito"
lacks "T21 con la biblioteca rota no se dice «no encuentro las skills»: no es que no estén" "${R}.out" "no encuentro las skills"
lacks "T21 con la biblioteca rota no corre ninguna suite" "${R}/.calls" "suite-"
is "T21 con la biblioteca rota los siete pasos figuran igual (no corta, no saltea)" "${SEVEN}" "$(steps_of "${R}.out")"
# cero suites que pidan exactamente agent-skills: cero no es verde
variant nosuites; printf '%s\n' '{ "diarias": [ { "raiz": "arnes", "ruta": "tests/portable.test.js", "requiere": [] } ], "semanales": [] }' > "${R}/scripts/tests/suites.json"
commit_all "sin suites"; run_ci
is "T21 con cero suites que pidan agent-skills sale 1" 1 "${RC}"
has "T21 con cero suites el paso es «no pude correr»" "${R}.out" "❌ public-ci: agent-skills-suites — no pude correr: "
# el tope por suite (TYCON_PUBLIC_CI_CAP_MS): una suite que no termina es ROJA por tope, el guion no queda colgado y no
# deja vivo ni al proceso de la suite ni a sus hijos (la suite lanza un hijo y lo espera; anota los dos pid)
variant capped
printf '%s\n' 'sleep 60 &' 'echo "$$ $!" > .hang-pids' 'wait' > "${R}/scripts/tests/hang.test.sh"
printf '%s\n' '{ "diarias": [ { "raiz": "arnes", "ruta": "tests/hang.test.sh", "requiere": ["agent-skills"] } ], "semanales": [] }' > "${R}/scripts/tests/suites.json"
commit_all "una suite que no termina"
T0="${SECONDS}"; export TYCON_PUBLIC_CI_CAP_MS=2000; run_ci; unset TYCON_PUBLIC_CI_CAP_MS; TOOK=$((SECONDS - T0))
is "T21 con una suite que no termina sale 1" 1 "${RC}"
has "T21 con una suite que no termina el paso es rojo" "${R}.out" "❌ public-ci: agent-skills-suites — rojo (exit 1)"
has "T21 …nombra la suite y dice que fue por el tope" "${R}.out" "❌ arnes/tests/hang.test.sh — se agotó el tope de 2s"
printf '❌\t%s\n' "arnes/tests/hang.test.sh" > "${R}.tsv"
if cmp -s "${R}.ci/agent-skills-suites.tsv" "${R}.tsv"; then ok "T21 …y el .tsv la trae en rojo"
else no "T21 con una suite que no termina el .tsv no es el esperado: $(tr '\n\t' '| ' < "${R}.ci/agent-skills-suites.tsv" 2>/dev/null)"; fi
if [ "${TOOK}" -lt 30 ]; then ok "T21 …y el guion no queda colgado esperándola (${TOOK}s)"; else no "T21 con una suite que no termina el guion tardó ${TOOK}s: la esperó"; fi
HANG_PIDS="$(cat "${R}/.hang-pids" 2>/dev/null || true)"; ALIVE="${HANG_PIDS}"; TRIES=0
while [ -n "${ALIVE}" ] && [ "${TRIES}" -lt 30 ]; do
  ALIVE=""; for p in ${HANG_PIDS}; do if kill -0 "${p}" 2>/dev/null; then ALIVE="${ALIVE} ${p}"; fi; done
  [ -z "${ALIVE}" ] || sleep 0.1; TRIES=$((TRIES + 1))
done
if [ -z "${HANG_PIDS}" ]; then no "T21 la suite que no termina no llegó a correr (no anotó sus pid): la prueba del tope no midió nada"
elif [ -z "${ALIVE}" ]; then ok "T21 …y no deja vivo ni al proceso de la suite ni a su hijo"
else no "T21 después del tope quedaron vivos procesos de la suite:${ALIVE}"; for p in ${ALIVE}; do kill -9 "${p}" 2>/dev/null || true; done; fi
# los argumentos
variant args; run_ci --no-such-option
is "T21 un argumento desconocido sale 2" 2 "${RC}"
has "T21 …con el uso" "${R}.out" "uso: bash scripts/ci/public-ci.sh"
if [ -f "${R}/.calls" ]; then no "T21 con un argumento desconocido corrió algún paso"; else ok "T21 con un argumento desconocido no corre nada"; fi
( cd "${T}/elsewhere" && bash "${SCRIPT}" --root "${T}/no-such-folder" ) > "${R}.out" 2>&1; RC=$?
is "T21 un --root que no existe sale 2" 2 "${RC}"
has "T21 …con el uso" "${R}.out" "uso: bash scripts/ci/public-ci.sh"
# un --root VACÍO (una variable sin definir de quien llama) no es «sin --root»: sale 2, no revisa el repo del guion. Se
# prueba con una copia del guion adentro de un repo de mentira: si cayera a «el repo donde vive», correría sobre ése.
variant host; mkdir -p "${R}/scripts/ci"; cp "${SCRIPT}" "${R}/scripts/ci/public-ci.sh"; commit_all "el guion vive acá"
for form in 'empty-value' 'empty-equals' 'no-value'; do
  rm -f "${R}/.calls"
  case "${form}" in
    empty-value) ( cd "${T}/elsewhere" && TYCON_SKILLS_DIR="${T}/no-skills" bash "${R}/scripts/ci/public-ci.sh" --root "" ) > "${R}.out" 2>&1; RC=$?; SAID='--root ""' ;;
    empty-equals) ( cd "${T}/elsewhere" && TYCON_SKILLS_DIR="${T}/no-skills" bash "${R}/scripts/ci/public-ci.sh" --root= ) > "${R}.out" 2>&1; RC=$?; SAID='--root=' ;;
    *) ( cd "${T}/elsewhere" && TYCON_SKILLS_DIR="${T}/no-skills" bash "${R}/scripts/ci/public-ci.sh" --root ) > "${R}.out" 2>&1; RC=$?; SAID='--root sin valor' ;;
  esac
  if [ "${RC}" -eq 2 ] && grep -qF "uso: bash scripts/ci/public-ci.sh" "${R}.out" && [ ! -f "${R}/.calls" ]; then ok "T21 ${SAID} sale 2 con el uso y no corre nada"
  else no "T21 ${SAID} esperaba exit 2 con el uso y sin correr nada, y dio exit ${RC}: $(tail -n 2 "${R}.out" | tr '\n' ' ')"; fi
done
# una entrada RELATIVA del PATH (vista desde la raíz, una carpeta con un bash que anda): las suites encuentran igual su
# intérprete; un enlace armado con destino relativo quedaría roto y taparía al bash bueno de más adelante
variant relpath; mkdir -p "${R}/tools-rel"; ln -s "$(command -v bash)" "${R}/tools-rel/bash"
PATH_PREFIX="tools-rel:"; run_ci; PATH_PREFIX=""
is "T21 con una entrada relativa en el PATH todo verde sale 0" 0 "${RC}"
printf '✅\t%s\n' "agent-skills/tycon-pipeline/scripts/tests/beta.test.sh" "arnes/tests/alpha.test.js" "arnes/tests/weekly.test.sh" > "${R}.tsv"
if cmp -s "${R}.ci/agent-skills-suites.tsv" "${R}.tsv"; then ok "T21 con una entrada relativa en el PATH las suites en bash corren (el enlace no queda roto)"
else no "T21 con una entrada relativa en el PATH las suites no corrieron: $(grep -F 'no pude lanzarla' "${R}.out" | head -n 2 | tr '\n' ' ')"; fi
# ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
# T24 (a) · la corrida partida (TYCON_PUBLIC_CI_PART): checks + las partes de las suites = la corrida entera
# ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
ELEVEN="${SEVEN} spanish-names repo-lint version clean-machine"
variant partchecks; export TYCON_PUBLIC_CI_PART=checks; run_ci --range 'HEAD~1...HEAD' --clean-machine; unset TYCON_PUBLIC_CI_PART
is "T24 (a) la parte checks, todo verde, sale 0" 0 "${RC}"
is "T24 (a) la parte checks corre todos los pasos menos las portables, en orden" "node-check build-check build-generate suites-coverage agent-skills-suites controls-bench spanish-names repo-lint version clean-machine" "$(steps_of "${R}.out")"
lacks "T24 (a) …y no llama a las portables" "${R}/.calls" "portable-suites"
has "T24 (a) …y lo dice al arrancar" "${R}.out" "public-ci: parte checks — todos los pasos menos portable-suites"
is "T24 (a) el resumen dice que es sólo una parte" "✅ public-ci: 10 pasos verdes (sólo la parte checks)" "$(tail -n 1 "${R}.out")"
STEPS_CHECKS="$(steps_of "${R}.out")"
variant partsuites; export TYCON_PUBLIC_CI_PART=suites-2-of-3; run_ci --range 'HEAD~1...HEAD' --clean-machine; unset TYCON_PUBLIC_CI_PART
is "T24 (a) una parte de las suites, todo verde, sale 0" 0 "${RC}"
is "T24 (a) la parte suites-2-of-3 corre sólo las portables" "portable-suites" "$(steps_of "${R}.out")"
is "T24 (a) …con su parte: TYCON_PORTABLE_SHARD=2/3, y nada más" "portable-suites skills=${R}/skills guides=${R} git=${R} shard=2/3" "$(calls_of "${R}" | tr '\n' '|' | sed 's/|$//')"
lacks "T24 (a) …sin las suites que piden agent-skills (van en checks)" "${R}/.calls" "suite-"
is "T24 (a) el resumen dice que es sólo una parte" "✅ public-ci: 1 pasos verdes (sólo la parte suites-2-of-3)" "$(tail -n 1 "${R}.out")"
# shellcheck disable=SC2086
is "T24 (a) checks más una parte de las suites son los once pasos de la corrida entera, ninguno dos veces" \
  "$(printf '%s\n' ${ELEVEN} | LC_ALL=C sort | tr '\n' ' ')" "$(printf '%s\n' ${STEPS_CHECKS} $(steps_of "${R}.out") | LC_ALL=C sort | tr '\n' ' ')"
variant partred; echo 'exit 4' >> "${R}/scripts/tests/portable-suites.test.sh"; commit_all "portables en rojo"
export TYCON_PUBLIC_CI_PART=suites-1-of-1; run_ci; unset TYCON_PUBLIC_CI_PART
is "T24 (a) una parte con su paso en rojo sale 1" 1 "${RC}"
is "T24 (a) …y el resumen nombra el paso y la parte" "❌ public-ci: 1 de 1 pasos en rojo (sólo la parte suites-1-of-1): portable-suites" "$(tail -n 1 "${R}.out")"
# sin parte, la corrida entera corre TODAS las portables aunque quien llama tenga puesta una parte de las portables
variant partnone; export TYCON_PORTABLE_SHARD=1/3; run_ci; unset TYCON_PORTABLE_SHARD
is "T24 (a) sin TYCON_PUBLIC_CI_PART corre los siete pasos" "${SEVEN}" "$(steps_of "${R}.out")"
if grep -qE "^portable-suites .* shard=$" "${R}/.calls"; then ok "T24 (a) …y las portables van enteras (la parte llega vacía) aunque quien llama tenga TYCON_PORTABLE_SHARD puesta"
else no "T24 (a) la parte de las portables no llegó vacía: $(grep '^portable-suites' "${R}/.calls")"; fi
for bad in suites-0-of-3 suites-4-of-3 suites-1-of-2-of-3 suites-1-of-3x all Checks; do
  variant "part-${bad}"; export TYCON_PUBLIC_CI_PART="${bad}"; run_ci; unset TYCON_PUBLIC_CI_PART
  if [ "${RC}" -eq 2 ] && grep -qF "uso: bash scripts/ci/public-ci.sh" "${R}.out" && grep -qF "no es una parte" "${R}.out" && [ ! -f "${R}/.calls" ]; then ok "T24 (a) TYCON_PUBLIC_CI_PART=${bad} sale 2 con el uso y no corre nada"
  else no "T24 (a) TYCON_PUBLIC_CI_PART=${bad} esperaba exit 2 con el uso y sin correr nada, y dio exit ${RC}: $(tail -n 2 "${R}.out" | tr '\n' ' ')"; fi
done

# ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
# T24 (b) · portable-suites.test.sh con una parte (TYCON_PORTABLE_SHARD), sobre un repo de mentira: siete portables
#           (una pesada y una mediana según el juego `pr`) y una que pide engram
# ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
PS="${T}/portables"; mkdir -p "${PS}/scripts/tests" "${PS}/scripts/ci"
cp "${ROOT}/scripts/tests/portable-suites.test.sh" "${PS}/scripts/tests/portable-suites.test.sh"
cp "${ROOT}/scripts/ci/suites-shard.js" "${PS}/scripts/ci/suites-shard.js"
printf '%s\n' '{ "default": 1, "weights": {}, "github": { "default": 1, "weights": { "heavy.test.sh": 50, "mid.test.sh": 20 } } }' > "${PS}/scripts/ci/suites-weights.json"
for s in a b c heavy d mid e other; do printf '%s\n' "echo ${s} >> \"\${PWD}/.ran\"" > "${PS}/scripts/tests/${s}.test.sh"; done
node -e 'const names = ["a", "b", "c", "heavy", "d", "mid", "e"];
  const diarias = names.map((n) => ({ raiz: "arnes", ruta: `tests/${n}.test.sh`, requiere: [] }));
  diarias.push({ raiz: "arnes", ruta: "tests/other.test.sh", requiere: ["engram"] });
  require("fs").writeFileSync(process.argv[1], JSON.stringify({ diarias, semanales: [] }, null, 2));' "${PS}/scripts/tests/suites.json"
# run_ps <parte> → corre la prueba real sobre el repo de mentira, de a una suite (el orden se puede medir); salida en
# ${PS}.out, lo que corrió en ${PS}.ran (en el orden en que arrancó) y el exit en RC
run_ps() {
  rm -f "${PS}/.ran"
  ( cd "${PS}" && env TYCON_PORTABLE_SHARD="$1" TYCON_PORTABLE_PARALLEL=1 bash scripts/tests/portable-suites.test.sh < /dev/null ) > "${PS}.out" 2>&1; RC=$?
  cp "${PS}/.ran" "${PS}.ran" 2>/dev/null || : > "${PS}.ran"
}
ALL_RAN=""; EMPTY_PART=""; PART_RC=""
for i in 1 2 3; do
  run_ps "${i}/3"; PART_RC="${PART_RC}${RC}"
  [ -s "${PS}.ran" ] || EMPTY_PART="${EMPTY_PART} ${i}"
  ALL_RAN="${ALL_RAN}$(cat "${PS}.ran")"$'\n'
  if grep -qx heavy "${PS}.ran"; then is "T24 (b) en su parte, la pesada arranca primero" "heavy" "$(head -n 1 "${PS}.ran")"; fi
  if grep -qx mid "${PS}.ran"; then is "T24 (b) en su parte, la mediana arranca primero" "mid" "$(head -n 1 "${PS}.ran")"; fi
done
is "T24 (b) las tres partes salen 0" "000" "${PART_RC}"
is "T24 (b) ninguna parte queda sin suites" "" "${EMPTY_PART}"
is "T24 (b) las tres partes juntas son las siete portables, cada una una sola vez, y nunca la que pide engram" \
  "a b c d e heavy mid" "$(printf '%s' "${ALL_RAN}" | grep -v '^$' | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')"
has "T24 (b) cada parte dice cuál es y cuántas le tocaron" "${PS}.out" "suites-portables: parte 3 de 3 (repartidas por peso con scripts/ci/suites-shard.js, juego github): "
run_ps ""
is "T24 (b) sin parte corren las siete" "a b c d e heavy mid" "$(LC_ALL=C sort "${PS}.ran" | tr '\n' ' ' | sed 's/ $//')"
for bad in 4/3 0/3 x 1/3x; do
  run_ps "${bad}"
  if [ "${RC}" -eq 1 ] && grep -qF "TYCON_PORTABLE_SHARD=${bad} no es una parte" "${PS}.out" && [ ! -s "${PS}.ran" ]; then ok "T24 (b) TYCON_PORTABLE_SHARD=${bad} es rojo sin correr ninguna"
  else no "T24 (b) TYCON_PORTABLE_SHARD=${bad} esperaba exit 1 sin correr ninguna, y dio exit ${RC}: $(tail -n 2 "${PS}.out" | tr '\n' ' ')"; fi
done
run_ps "8/8"
if [ "${RC}" -eq 1 ] && grep -qF "no le tocó ninguna portable" "${PS}.out"; then ok "T24 (b) una parte sin ninguna suite es rojo (cero no es verde)"
else no "T24 (b) la parte 8 de 8 con siete portables esperaba exit 1 «no le tocó ninguna», y dio exit ${RC}: $(tail -n 2 "${PS}.out" | tr '\n' ' ')"; fi
rm -f "${PS}/scripts/ci/suites-shard.js"; run_ps "1/3"
if [ "${RC}" -eq 1 ] && grep -qF "no pude repartir las portables para la parte 1 de 3" "${PS}.out" && [ ! -s "${PS}.ran" ]; then ok "T24 (b) sin el repartidor es rojo, no «todas» ni «ninguna» en silencio"
else no "T24 (b) sin suites-shard.js esperaba exit 1 «no pude repartir», y dio exit ${RC}: $(tail -n 2 "${PS}.out" | tr '\n' ' ')"; fi

# el entorno de git de quien llama: toda la suite corre con GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE y GIT_COMMON_DIR
# apuntando al repo de afuera (ver la cabecera). El guion mira siempre el repo de --root, y el de afuera queda como estaba.
lacks "T21 con GIT_DIR y compañía de otro repo el guion revisa el de --root, no el de quien llama" "${T}/green.ci/1-node-check.log" "broken-in-the-outer-repo.js"
is "T21 el repo de quien llama queda idéntico después de toda la suite (mismo commit, mismas ramas, mismo índice)" "${OUTER_BEFORE}" "$(outer_state)"

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
# T22 · PublicCi_Workflow_Seguro — el `ci.yml` real pasa el control; cada copia alterada es roja nombrando su regla
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
CI_YML=""; FOUND=0
for f in "${ROOT}/scripts/publishing/public-files/.github/workflows/ci.yml" "${ROOT}/.github/workflows/ci.yml"; do
  [ -f "${f}" ] || continue
  FOUND=$((FOUND + 1)); [ -n "${CI_YML}" ] || CI_YML="${f}"
  node "${CHECK}" "${f}" > "${T}/check.out" 2>&1; RC=$?
  if [ "${RC}" -eq 0 ]; then ok "T22 el ci.yml real pasa el control (${f#${ROOT}/})"
  else no "T22 el ci.yml real NO pasa el control (${f#${ROOT}/}, exit ${RC}): $(tr '\n' ' ' < "${T}/check.out")"; fi
done
if [ "${FOUND}" -eq 0 ]; then
  no "T22 no hay ci.yml: ni en scripts/publishing/public-files/.github/workflows/ (el repo del equipo) ni en .github/workflows/ (la copia pública)"
else
  mkdir -p "${T}/alt"
  # altered <nombre> <reglas CON NOMBRE esperadas, separadas por espacio> <cuerpo JS: recibe `t` (el texto) y devuelve el alterado>
  #   Toda alteración del código rompe además `shape` (la forma exacta del archivo): se espera siempre, sin escribirla.
  #   Si la lista empieza con «=», es la lista exacta (una alteración que toca sólo comentarios no rompe la forma).
  altered() {
    local name="$1" want="$2" body="$3" got
    case "${want}" in "="*) want="${want#=}" ;; *) want="${want} shape" ;; esac
    # shellcheck disable=SC2086
    want="$(printf '%s\n' ${want} | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')"
    node -e 'const fs = require("fs"); const [src, dst, body] = process.argv.slice(1); const t = fs.readFileSync(src, "utf8");
      const out = new Function("t", body)(t); if (typeof out !== "string" || out === t) process.exit(3); fs.writeFileSync(dst, out);' \
      "${CI_YML}" "${T}/alt/${name}.yml" "${body}" 2> "${T}/alt/${name}.err" \
      || { no "T22 (${name}) la alteración no cambió nada: el ci.yml ya no tiene lo que esta prueba altera ($(tr '\n' ' ' < "${T}/alt/${name}.err"))"; return; }
    node "${CHECK}" "${T}/alt/${name}.yml" > "${T}/alt/${name}.out" 2>&1; RC=$?
    got="$(sed -n 's/^❌ check-public-workflow: \([a-z-]*\) — .*$/\1/p' "${T}/alt/${name}.out" | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')"
    if [ "${RC}" -eq 1 ] && [ "${got}" = "${want}" ]; then ok "T22 (${name}) es rojo nombrando su regla: ${want}"
    else no "T22 (${name}) esperaba exit 1 con «${want}» y dio exit ${RC} con «${got}»: $(tr '\n' ' ' < "${T}/alt/${name}.out")"; fi
  }
  # still_green <nombre> <cuerpo JS> → un cambio que NO es del código (o que la forma admite) deja el veredicto en verde
  still_green() {
    local name="$1" body="$2"
    node -e 'const fs = require("fs"); const [src, dst, body] = process.argv.slice(1); const t = fs.readFileSync(src, "utf8");
      const out = new Function("t", body)(t); if (typeof out !== "string" || out === t) process.exit(3); fs.writeFileSync(dst, out);' \
      "${CI_YML}" "${T}/alt/${name}.yml" "${body}" 2> "${T}/alt/${name}.err" \
      || { no "T22 (${name}) la alteración no cambió nada ($(tr '\n' ' ' < "${T}/alt/${name}.err"))"; return; }
    node "${CHECK}" "${T}/alt/${name}.yml" > "${T}/alt/${name}.out" 2>&1; RC=$?
    if [ "${RC}" -eq 0 ]; then ok "T22 (${name}) sigue verde"
    else no "T22 (${name}) esperaba exit 0 y dio exit ${RC}: $(tr '\n' ' ' < "${T}/alt/${name}.out")"; fi
  }
  # las seis de la tabla de reglas
  altered "con pull_request_target" "pull-request-target triggers" 'return t.replace(/^  pull_request:/m, "  pull_request_target:");'
  altered "con secrets." "secrets" 'return t.replace(/^(\s*)TYCON_PUBLIC_CI_OUT:.*$/m, (l, s) => l + "\n" + s + "TOKEN: ${{ secrets.GITHUB_TOKEN }}");'
  altered "con un uses por tag" "uses-by-sha" 'return t.replace(/actions\/checkout@[0-9a-f]{40} # v[0-9.]+/, "actions/checkout@v7");'
  altered "sin permissions" "permissions" 'return t.replace(/^permissions:\n  contents: read\n/m, "");'
  altered "sin fetch-depth 0" "fetch-depth" 'return t.replace(/^\s*fetch-depth: 0\n/m, "");'
  altered "sin el job public-ci" "aggregate-job" 'return t.replace(/^  public-ci:\n(?:(?:    .*)?\n)*/m, "");'
  # una por cada regla que queda, y las otras formas de romper las de arriba
  altered "con un disparador de más" "triggers" 'return t.replace(/^  pull_request:/m, "  workflow_dispatch:\n  pull_request:");'
  altered "con push a cualquier rama" "triggers" 'return t.replace(/^    branches: \[main\]\n/m, "");'
  altered "con push también a otra rama" "triggers" 'return t.replace(/^    branches: \[main\]$/m, "    branches: [main, next]");'
  altered "con push también a los tags" "triggers" 'return t.replace(/^(    branches: \[main\])$/m, "$1\n    tags: [\"v*\"]");'
  altered "sin la cola de merge" "triggers" 'return t.replace(/^  merge_group:\n/m, "");'
  altered "con el token por otro nombre" "secrets" 'return t.replace(/^(\s*)TYCON_PUBLIC_CI_OUT:.*$/m, (l, s) => l + "\n" + s + "TOKEN: ${{ github.token }}");'
  altered "con un uses por sha sin el tag" "uses-by-sha" 'return t.replace(/(actions\/setup-node@[0-9a-f]{40}) # v[0-9.]+/, "$1");'
  altered "con un uses por sha corto" "uses-by-sha" 'return t.replace(/(actions\/setup-node@[0-9a-f]{12})[0-9a-f]{28}/, "$1");'
  altered "con permisos de escritura" "permissions" 'return t.replace(/^  contents: read$/m, "  contents: write");'
  altered "con permisos propios en un job" "permissions" 'return t.replace(/^(    runs-on: .*)$/m, "$1\n    permissions:\n      contents: write");'
  altered "con fetch-depth 1" "fetch-depth" 'return t.replace(/^(\s*)fetch-depth: 0$/m, "$1fetch-depth: 1");'
  altered "sin Node 24 en la matriz" "node-matrix" 'return t.replace(/node: \[24\]/, "node: [22]");'
  # el piso del instalador: el job installer-floor instala Node 22, una vez y sólo ahí
  altered "el piso del instalador con otro Node" "node-matrix" 'return t.replace(/node-version: 22$/m, "node-version: 20");'
  altered "el piso del instalador fuera de su job" "node-matrix" 'return t.replace(/node-version: \$\{\{ matrix\.node \}\}/, "node-version: 22");'
  altered "el chequeo final no espera al piso del instalador" "aggregate-job" 'return t.replace("needs: [checks, installer-floor]", "needs: [checks]");'
  altered "una parte fija fuera del piso del instalador" "parts" 'return t.replace(/TYCON_PUBLIC_CI_PART: \$\{\{ matrix\.part \}\}/, "TYCON_PUBLIC_CI_PART: installer-floor");'
  altered "con un Node fijo" "node-matrix" 'return t.replace(/node-version: .*$/m, "node-version: 22");'
  altered "sin --range en el pull request" "range base-controls" 'return t.replace(/ --range "[^"]*"/g, "");'
  altered "sin --range en la cola de merge" "range" 'return t.replace(/ \|\| \[ "\$\{GITHUB_EVENT_NAME\}" = "merge_group" \]/, "");'
  altered "con la cola comparando contra su propia rama" "" 'return t.replace("github.base_ref || github.event.merge_group.base_ref", "github.base_ref || github.ref");'
  altered "con la rama base de la cola sin sacarle el prefijo refs-heads" "" 'return t.replace("${BASE_REF#refs/heads/}", "${BASE_REF}");'
  altered "clase 5: un filtro bajo merge_group" "" 'return t.replace(/^  merge_group:$/m, "  merge_group:\n    types: [destroyed]");'
  altered "sin --clean-machine en una llamada" "clean-machine" 'return t.replace(/(public-ci\.sh) --clean-machine$/m, "$1");'
  altered "con el job public-ci sin if always" "aggregate-job after-queue" 'return t.replace(/^    if: always\(\) && .*\n/m, "");'
  altered "con el job public-ci que no espera a los demás" "aggregate-job" 'return t.replace(/^    needs: .*\n/m, "");'
  altered "con el job public-ci con otro nombre visible" "aggregate-job" 'return t.replace(/^  public-ci:\n/m, "  public-ci:\n    name: all green\n");'
  altered "con el job public-ci que no mira los resultados" "aggregate-job" 'return t.replace(/needs\.\*\.result/, "needs.*.outputs");'
  altered "con un job que deja pasar su rojo" "aggregate-job" 'return t.replace(/^(    runs-on: .*)$/m, "$1\n    continue-on-error: true");'
  # lo que el control no encuentra es rojo, nunca limpio: una regla cuyo bloque no existe no se da por cumplida
  altered "sin on ni jobs" "after-queue aggregate-job base-controls clean-machine fetch-depth node-matrix parts permissions range triggers" 'return "name: x\n";'
  altered "sin el bloque de la matriz" "node-matrix parts" 'return t.replace(/^    strategy:\n(?:      .*\n)+/m, "");'
  altered "con la lista de Node fuera de matrix" "node-matrix" 'return t.replace(/^      matrix:$/m, "      versions:");'
  altered "con matrix fuera de strategy" "node-matrix" 'return t.replace(/^    strategy:$/m, "    defaults:");'
  altered "sin ningún checkout" "fetch-depth" 'return t.replace(/^      - uses: actions\/checkout@.*\n(?:        .*\n)+/gm, "");'

  # ── `shape`, la forma exacta: las líneas de código del archivo son las que el control lleva adentro, en ese orden ──
  altered "con una línea de más al final" "" 'return t + "          echo fin\n";'
  altered "sin la última línea" "" 'return t.replace(/\n          done\n$/, "\n");'
  altered "con otra indentación en una línea" "" 'return t.replace("          echo \"resultados: ${RESULTS}\"", "            echo \"resultados: ${RESULTS}\"");'
  altered "con un comentario al final de una línea de código" "" 'return t.replace(/^(    timeout-minutes: 5)$/m, "$1 # corto");'
  # lo que NO es código no rompe la forma; y las dos líneas `uses:` admiten otro sha completo y otro tag
  still_green "con un comentario y una línea vacía de más" 'return t.replace(/^jobs:$/m, "# una nota\n\njobs:");'
  still_green "con los finales de línea de Windows" 'return t.replace(/\n/g, "\r\n");'
  still_green "con otro sha completo y otro tag en un uses" 'return t.replace(/actions\/checkout@[0-9a-f]{40} # v[0-9.]+/, "actions/checkout@0123456789abcdef0123456789abcdef01234567 # v7.1.0");'
  # las dos reglas que buscan lo prohibido miran también los comentarios (ahí la forma no se rompe: la lista es exacta)
  altered "con el disparador prohibido en un comentario" "=pull-request-target" 'return t.replace(/^name: public-ci$/m, "# nunca pull_request_target\nname: public-ci");'
  altered "con un secreto en un comentario" "=secrets" 'return t.replace(/^name: public-ci$/m, "# TOKEN: ${{ secrets.X }}\nname: public-ci");'

  # ── una copia alterada por cada clase del pase adversarial: otra forma de escribir lo prohibido que las
  #    reglas con nombre no ven. La cierra la forma exacta, no una regla más por cada forma. ──
  altered "clase 1: la opción dentro de un comentario de shell" "" 'return t.replace(/(public-ci\.sh) --clean-machine$/m, "$1 # --clean-machine");'
  altered "clase 2: el token leído por índice" "secrets" 'return t.replace(/^(\s*)TYCON_PUBLIC_CI_OUT:.*$/m, (l, s) => l + "\n" + s + "TOKEN: ${{ github[\x27token\x27] }}");'
  altered "clase 2: el contexto github volcado entero" "secrets" 'return t.replace(/^(\s*)TYCON_PUBLIC_CI_OUT:.*$/m, (l, s) => l + "\n" + s + "CTX: ${{ toJSON(github) }}");'
  altered "clase 2: un secreto escondido con un escape de YAML" "" 'return t.replace(/^(\s*)TYCON_PUBLIC_CI_OUT:.*$/m, (l, s) => l + "\n" + s + "TOKEN: \"${{ secr\\x65ts.GITHUB_TOKEN }}\"");'
  altered "clase 3: un job salteado cuenta como aprobado" "" 'return t.replace("[ \"${r}\" = \"success\" ] || exit 1", "[ \"${r}\" = \"success\" ] || [ \"${r}\" = \"skipped\" ] || exit 1");'
  altered "clase 4: un exclude en la matriz" "" 'return t.replace(/^(        node: \[24\])$/m, "$1\n        exclude:\n          - node: 24");'
  altered "clase 5: un filtro bajo pull_request" "" 'return t.replace(/^  pull_request:$/m, "  pull_request:\n    types: [closed]");'
  altered "clase 8: un job en estilo flujo con permisos de escritura" "after-queue" 'return t.replace(/^  public-ci:\n/m, "  extra: { runs-on: ubuntu-latest, permissions: write-all, steps: [ { run: \"echo hola\" } ] }\n  public-ci:\n").replace("needs: [checks, installer-floor]", "needs: [checks, installer-floor, extra]");'
  altered "clase 9: un if propio en el paso del job public-ci" "" 'return t.replace(/^(      - name: Todos los jobs terminaron bien)$/m, "$1\n        if: github.event_name == \x27push\x27");'
  altered "clase 10: la llamada escrita de otra forma" "" 'return t.replace(/bash scripts\/ci\/public-ci\.sh --clean-machine$/m, "bash ./scripts/ci/public-ci.sh");'
  altered "clase 11: el rojo de la llamada se pierde con || true" "" 'return t.replace(/(public-ci\.sh --clean-machine)$/m, "$1 || true");'
  altered "clase 11: el rojo de la llamada se pierde en un tee" "" 'return t.replace(/(public-ci\.sh --clean-machine)$/m, "$1 | tee ci.log");'
  altered "clase 15: un retorno de carro suelto esconde una línea" "" 'return t.replace("    timeout-minutes: 90\n", "    # nota\r    permissions: write-all\n    timeout-minutes: 90\n");'
  altered "clase 15: un salto de línea de Unicode esconde una línea" "" 'return t.replace("    timeout-minutes: 90\n", "    # nota\u0085    permissions: write-all\n    timeout-minutes: 90\n");'
  altered "clase 15: un separador de línea de Unicode esconde una línea" "" 'return t.replace("    timeout-minutes: 90\n", "    # nota" + String.fromCharCode(0x2028) + "    permissions: write-all\n    timeout-minutes: 90\n");'
  altered "clase 15: un comentario detrás de un blanco que no es un espacio" "" 'return t.replace(/^jobs:$/m, String.fromCharCode(0xA0) + "# nota\njobs:");'
  altered "clase 15: un tabulador" "" 'return t.replace("    timeout-minutes: 90", "    timeout-minutes:\t90");'
  altered "clase 15: un carácter de control" "" 'return t.replace("    timeout-minutes: 90", "    timeout-minutes: 90\u0007");'
  altered "clase 16: el job public-ci con los textos sueltos y sin fallar" "" 'return t.replace("[ \"${r}\" = \"success\" ] || exit 1", "echo \"${r} success exit 1\"");'
  altered "clase 17: fetch-depth 0 fuera de with" "" 'return t.replace("        with:\n          fetch-depth: 0\n          persist-credentials: false\n", "        env:\n          fetch-depth: 0\n");'
  altered "clase 20: exit 1 sólo dentro de un echo" "" 'return t.replace("[ \"${r}\" = \"success\" ] || exit 1", "[ \"${r}\" = \"success\" ] || echo \"exit 1\"");'
  # lo que el pase dejó «a verificar aparte» (otra regla u otro mecanismo que el de su clase)
  altered "aparte: un uses por rama dentro de una lista en estilo flujo" "uses-by-sha after-queue" 'return t.replace(/^  public-ci:\n/m, "  extra: { runs-on: ubuntu-latest, steps: [uses: evil/action@main] }\n  public-ci:\n").replace("needs: [checks, installer-floor]", "needs: [checks, installer-floor, extra]");'
  altered "aparte: la condición del pull request invertida" "" 'return t.replace("= \"pull_request\" ]", "!= \"pull_request\" ]");'
  altered "aparte: un if en el paso que corre el guion" "" 'return t.replace(/^(      - name: Los pasos de la CI pública que le tocan a esta parte)$/m, "$1\n        if: ${{ false }}");'
  altered "aparte: sin persist-credentials false en el checkout" "" 'return t.replace(/^          persist-credentials: false\n/m, "");'
  # la corrida partida (T24): la lista de partes trae checks y TODAS las de las suites, en orden, y la parte sale de la matriz
  altered "sin una parte de las suites" "parts" 'return t.replace(", suites-5-of-5]", "]");'
  altered "sin la parte checks" "parts" 'return t.replace("part: [checks, ", "part: [");'
  altered "con una parte repetida" "parts" 'return t.replace("suites-5-of-5]", "suites-4-of-5]");'
  altered "con las partes desordenadas" "parts" 'return t.replace("suites-1-of-5, suites-2-of-5", "suites-2-of-5, suites-1-of-5");'
  altered "con una parte que dice otra cuenta" "parts" 'return t.replace("suites-5-of-5]", "suites-5-of-6]");'
  altered "con la lista de partes dos veces" "parts" 'return t.replace(/^(        part: .*)$/m, "$1\n$1");'
  altered "sin la lista de partes" "parts" 'return t.replace(/^        part: .*\n/m, "");'
  altered "con la parte fija en vez de la de la matriz" "parts" 'return t.replace("TYCON_PUBLIC_CI_PART: ${{ matrix.part }}", "TYCON_PUBLIC_CI_PART: checks");'
  altered "sin pasarle la parte al guion" "parts" 'return t.replace(/^          TYCON_PUBLIC_CI_PART: .*\n/m, "");'
  # otra cuenta de partes, completa, cumple la regla con nombre: la frena sólo la forma exacta (cambiarla es cambiar SHAPE)
  altered "con cuatro partes de las suites, todas" "=shape" 'return t.replace("part: [checks, suites-1-of-5, suites-2-of-5, suites-3-of-5, suites-4-of-5, suites-5-of-5]", "part: [checks, suites-1-of-4, suites-2-of-4, suites-3-of-4, suites-4-of-4]");'
  # el push a main que hace la cola al entrar un pedido no corre nada (la cola ya probó ese commit), y sólo
  # ése: cualquier otro push a main —el merge directo de un administrador— corre entero, y un pedido o la cola, igual
  altered "sin la condición de la cola en el job de la matriz" "after-queue" 'return t.replace(/^    if: github\.event_name .*\n/m, "");'
  altered "salteando todo push a main" "after-queue" 'return t.replace(/^    if: github\.event_name != \x27push\x27 \|\| .*$/m, "    if: github.event_name != \x27push\x27");'
  altered "salteando todo lo que empuja el bot, también la cola" "after-queue" 'return t.replace(/^    if: github\.event_name != \x27push\x27 \|\| /m, "    if: ");'
  altered "salteando el push de cualquiera que no sea el bot" "after-queue" 'return t.replace(/^(    if: github\.event_name .*)!= \x27github-merge-queue\[bot\]\x27$/m, "$1== \x27github-merge-queue[bot]\x27");'
  altered "con el job public-ci sólo con always" "after-queue" 'return t.replace(/^    if: always\(\) && .*$/m, "    if: always()");'
  altered "con el job public-ci con la condición y sin always" "aggregate-job after-queue" 'return t.replace(/^    if: always\(\) && \((.*)\)$/m, "    if: $1");'
  # ── T12 · PublicCi_Workflow_PassesBaseInPullRequestAndMergeGroup — en un pedido y en la cola corre el
  #    public-ci.sh de la BASE con `--base`; en un push, el del árbol y sin `--base` ──
  BASE_CALL="$(grep -n 'public-ci-base\.sh" --root ' "${CI_YML}" | head -n 1)"
  case "${BASE_CALL}" in *'--base "${BASE}"'*) ok "T12 en un pedido y en la cola corre el public-ci.sh de la base, con --base" ;;
    *) no "T12 no hay una llamada al public-ci.sh de la base con --base: «${BASE_CALL}»" ;; esac
  grep -qF 'git show "${BASE}:scripts/ci/public-ci.sh"' "${CI_YML}" && ok "T12 el guion que corre sale de la base (git show), no del checkout del pedido" \
    || no "T12 el public-ci.sh que corre en un pedido no sale de la base"
  grep -qF 'BASE_SHA: ${{ github.event.merge_group.base_sha }}' "${CI_YML}" && ok "T12 en la cola la base es la base del grupo" \
    || no "T12 la cola no usa la base del grupo (merge_group.base_sha)"
  PUSH_CALL="$(awk '/^          else$/ { e = 1; next } e && /public-ci\.sh/ { print; exit }' "${CI_YML}")"
  case "${PUSH_CALL}" in *"--base"*) no "T12 en un push la llamada lleva --base: «${PUSH_CALL}»" ;;
    *'bash scripts/ci/public-ci.sh --clean-machine'*) ok "T12 en un push corre el guion del árbol, sin --base" ;;
    *) no "T12 no encuentro la llamada del push: «${PUSH_CALL}»" ;; esac
  altered "sin --base en la llamada de la base" "base-controls" 'return t.replace(/ --base "\$\{BASE\}"/, "");'
  altered "corriendo el guion del pedido con la base" "base-controls" 'return t.replace("git show \"${BASE}:scripts/ci/public-ci.sh\"", "cat scripts/ci/public-ci.sh");'
  altered "sin la base de la cola" "base-controls" 'return t.replace(/^          BASE_SHA: .*\n/m, "");'
  altered "con el rango de la base saliendo de main" "base-controls" 'return t.replace("--range \"${BASE}...HEAD\" --base", "--range \"origin/${BASE_REF#refs/heads/}...HEAD\" --base");'
  altered "sin frenar una base que no se lee" "base-controls" 'return t.replace(/^            git cat-file -e "\$\{BASE\}\^\{commit\}" \|\| exit 1\n/m, "");'
  [ "$(grep -cF "tr '\\r' ' ' < \"\${f}\" | sed -e ':a' -e 's/::/: :/' -e 'ta' -e ':b' -e 's/##/# #/' -e 'tb'" "${CI_YML}")" = 2 ] && ok "T12 el volcado del registro neutraliza los comandos de la CI (::, ##) en los dos trabajos" \
    || no "T12 el volcado del registro en el paso de falla no neutraliza los comandos de la CI"
  grep -qF -- '--range "${BASE}...HEAD" --base "${BASE}"' "${CI_YML}" && ok "T12 en la cola el rango sale de la misma base que los controles" \
    || no "T12 el rango de la llamada de la base no sale de la base"

  # ── T1 · PublicCi_Workflow_BaseSinGuion_FrenaRojo · T2 · PublicCi_Workflow_BaseConGuion_CorreLaBase —
  #    el bloque `run` del paso, sacado del ci.yml real y corrido con `bash -e` (el shell de GitHub) en un pedido de
  #    juguete: sin run-base-controls.sh en la base sale 1 «no pude correr» y no corre nada del pedido; con el guion,
  #    corre el public-ci.sh de la base con --base. Cada public-ci.sh anota quién corrió en ${WF_MARKS}. ──
  awk '/^      - name: Los pasos de la CI pública que le tocan a esta parte$/ { s = 1; next }
    s && /^        run: \|$/ { r = 1; next }
    r && /^          / { sub(/^          /, ""); print; next }
    r && /^$/ { print; next }
    r { exit }' "${CI_YML}" > "${T}/wf-step.sh"
  grep -q 'public-ci' "${T}/wf-step.sh" || no "T1 no encuentro el bloque run del paso en ${CI_YML#${ROOT}/}"
  # wf_case <nombre> <con-guion 0|1> [<evento: pull_request|merge_group>] [<public-ci.sh en la base 1|0>] → arma origin
  #   (la base) y un pedido encima; corre el bloque; deja .out, .rc y .ran. En la cola la base llega por BASE_SHA.
  wf_case() {
    local name="$1" with_script="$2" event="${3:-pull_request}" with_ci="${4:-1}" d="${T}/wf-$1" sha=""
    mkdir -p "${d}/origin/scripts/ci" "${d}/rt" "${d}/marks"
    printf '#!/usr/bin/env bash\necho "pedido $*" >> "${WF_MARKS}/ran"\n' > "${d}/origin/scripts/ci/public-ci.sh"
    ( cd "${d}/origin" && lab_git init -q -b main . && lab_git add -A && lab_git commit -qm inicio ) > /dev/null 2>&1
    if [ "${with_ci}" = 1 ]; then printf '#!/usr/bin/env bash\necho "base $*" >> "${WF_MARKS}/ran"\n' > "${d}/origin/scripts/ci/public-ci.sh"
    else rm -f "${d}/origin/scripts/ci/public-ci.sh"; fi
    [ "${with_script}" = 1 ] && printf '#!/usr/bin/env bash\nexit 0\n' > "${d}/origin/scripts/ci/run-base-controls.sh"
    ( cd "${d}/origin" && lab_git add -A && lab_git commit -qm base ) > /dev/null 2>&1
    lab_git clone -q "${d}/origin" "${d}/pr" > /dev/null 2>&1
    printf '#!/usr/bin/env bash\necho "pedido $*" >> "${WF_MARKS}/ran"\n' > "${d}/pr/scripts/ci/public-ci.sh"
    ( cd "${d}/pr" && lab_git checkout -q -b pedido && lab_git add -A && lab_git commit -qm "el pedido" ) > /dev/null 2>&1
    [ "${event}" = merge_group ] && sha="$(lab_git -C "${d}/pr" rev-parse origin/main)"
    ( cd "${d}/pr" && env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u GIT_COMMON_DIR \
        GITHUB_EVENT_NAME="${event}" BASE_REF=main BASE_SHA="${sha}" RUNNER_TEMP="${d}/rt" WF_MARKS="${d}/marks" \
        bash -e "${T}/wf-step.sh" ) > "${d}.out" 2>&1
    echo "$?" > "${d}.rc"; touch "${d}/marks/ran"
  }
  wf_case no-script 0
  is "T1 base sin run-base-controls.sh: el paso sale 1" 1 "$(cat "${T}/wf-no-script.rc")"
  has "T1 …y dice que no pudo correr" "${T}/wf-no-script.out" "no pude correr"
  has "T1 …nombrando el guion que falta" "${T}/wf-no-script.out" "scripts/ci/run-base-controls.sh"
  if [ -s "${T}/wf-no-script/marks/ran" ]; then no "T1 …y no corre nada, pero corrió: $(tr '\n' ' ' < "${T}/wf-no-script/marks/ran")"
  else ok "T1 …y no corre ningún public-ci.sh, ni el del pedido ni el de la base"; fi
  wf_case with-script 1
  is "T2 base con run-base-controls.sh: el paso sale 0" 0 "$(cat "${T}/wf-with-script.rc")"
  if grep -q '^base .*--base ' "${T}/wf-with-script/marks/ran" && ! grep -q '^pedido' "${T}/wf-with-script/marks/ran"; then
    ok "T2 …corre el public-ci.sh de la base, con --base, y no el del pedido"
  else no "T2 esperaba sólo el de la base con --base y corrió: $(tr '\n' ' ' < "${T}/wf-with-script/marks/ran")"; fi
  # la cola de merge (la base llega por BASE_SHA) y una base con el guion pero sin public-ci.sh: rojo igual, sin correr nada
  wf_case queue-no-script 0 merge_group
  is "T1 en la cola, base sin run-base-controls.sh: el paso sale 1" 1 "$(cat "${T}/wf-queue-no-script.rc")"
  has "T1 …y dice que no pudo correr" "${T}/wf-queue-no-script.out" "no pude correr"
  if [ -s "${T}/wf-queue-no-script/marks/ran" ]; then no "T1 …en la cola corrió: $(tr '\n' ' ' < "${T}/wf-queue-no-script/marks/ran")"
  else ok "T1 …y en la cola tampoco corre ningún public-ci.sh"; fi
  wf_case no-base-ci 1 pull_request 0
  RC="$(cat "${T}/wf-no-base-ci.rc")"
  if [ "${RC}" != 0 ] && [ ! -s "${T}/wf-no-base-ci/marks/ran" ]; then ok "T1 base con el guion y sin public-ci.sh: rojo (exit ${RC}) sin correr el del pedido"
  else no "T1 base sin public-ci.sh: esperaba rojo sin correr nada y dio exit ${RC}: $(tr '\n' ' ' < "${T}/wf-no-base-ci/marks/ran")"; fi
  # ── T3 · PublicCi_Workflow_RamaDeArranqueDeVuelta_Rojo — la rama que corría los controles del pedido
  #    cuando la base no traía el guion, de vuelta, o el freno quitado: rojo en base-controls ──
  altered "con la rama de arranque de vuelta" "base-controls" 'return t.replace(/^( *)git cat-file -e "\$\{BASE\}:scripts\/ci\/run-base-controls\.sh" \|\| .*\n((?:.*\n){2})/m,
    (m, s, two) => s + "if git cat-file -e \"${BASE}:scripts/ci/run-base-controls.sh\"; then\n" + two.replace(/^(?=.)/gm, "  ")
      + s + "else\n" + s + "  bash scripts/ci/public-ci.sh --clean-machine --range \"origin/${BASE_REF#refs/heads/}...HEAD\"\n" + s + "fi\n");'
  altered "sin frenar una base sin el guion" "base-controls" 'return t.replace(/^ *git cat-file -e "\$\{BASE\}:scripts\/ci\/run-base-controls\.sh" \|\| .*\n/m, "");'
  # ── T4 · PublicCi_Guia_SinRamaDeArranque — la guía de detalle dice que sin el guion `ci.yml` frena ──
  DETAIL="${ROOT}/guides/maintaining/piezas-en-detalle.md"
  if [ -f "${DETAIL}" ]; then
    lacks "T4 la guía de detalle ya no habla de la rama de arranque" "${DETAIL}" "rama de arranque"
    has "T4 …y dice que sin el guion en la base ci.yml frena en rojo" "${DETAIL}" "Si la base no trae este guion, \`ci.yml\` frena en rojo «no pude correr»"
  fi

  # no pudo leer: 2, no un verde
  node "${CHECK}" "${T}/alt/no-such-file.yml" > "${T}/check.out" 2>&1; is "T22 un archivo que no existe sale 2 (no pude leer)" 2 "$?"
  node "${CHECK}" > "${T}/check.out" 2>&1; is "T22 sin archivo sale 2" 2 "$?"
  : > "${T}/alt/empty.yml"; node "${CHECK}" "${T}/alt/empty.yml" > "${T}/check.out" 2>&1; is "T22 un archivo vacío sale 2" 2 "$?"
fi

echo ""
if [ "${FAILS}" -eq 0 ] && [ "${TOTAL}" -gt 0 ]; then echo "✅ public-ci.test: ${TOTAL} verificaciones verdes"; exit 0; fi
echo "❌ public-ci.test: ${FAILS} de ${TOTAL} verificaciones en rojo"; exit 1
