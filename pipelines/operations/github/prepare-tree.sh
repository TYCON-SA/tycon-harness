#!/usr/bin/env bash
# pipelines/operations/github/prepare-tree.sh — el árbol que mide un workflow de operaciones en GitHub (story 8.31).
#
# Es el equivalente de la plantilla `pipelines/operations/templates/ops-data.yml` de Azure, para los tres workflows de
# esta carpeta. Va JUSTO DESPUÉS de traer el repo de operaciones (`ops/`) y el arnés (`harness/`):
#   1. Valida `team-repos.json` del repo de operaciones (scripts/lib/team-repos.js): `public` y `operations` tienen que
#      ser de GitHub, y `operations` tiene que ser el repo donde corre el workflow (GITHUB_REPOSITORY, sin distinguir
#      mayúsculas). Si no, guardar iría a un lugar que el resto del arnés no lee: ROJO y no se mide nada.
#   2. Trae encima del arnés, en la misma ruta, SÓLO una lista cerrada (el repo de operaciones no puede reemplazar
#      código del arnés): los datos `.dashboard/`, `inbox/`, `artifacts/` (cada uno queda igual al de operaciones; los
#      que falten no son error: es la primera noche) y la configuración `operations.json`, `team-repos.json`,
#      `scripts/nightly/dependencies/{repos,summary}.json`, `scripts/nightly/dashboard/{sources,declared}.json` y
#      `scripts/ci/product-parity.json` (los productos que comparan su pipeline; story 2.25).
#      Lo demás del repo de operaciones (salvo `.github/`, `pipelines/`, `README.md` y `.gitignore`) se nombra y no se trae.
#   3. Lo fija en un commit LOCAL que no se empuja (guardar toma HEAD como base), con la identidad `github-actions[bot]`.
#   4. `origin` pasa a ser el repo de operaciones; el arnés queda como `harness`. Trae `main` de operaciones con la
#      credencial del workflow SÓLO para este proceso (operations-auth.sh): ningún `.git/config` queda con una credencial.
#   5. Deja en `$GITHUB_ENV` la huella del código que se mide (`HARNESS_TREE`, scripts/ci/harness-tree.js), de dónde
#      salió el arnés (`HARNESS_SOURCE`) y qué commit corre (`HARNESS_COMMIT`).
#
# Variables: GITHUB_WORKSPACE, GITHUB_REPOSITORY, GITHUB_ENV, OPS_TOKEN (github.token, por env del paso);
# GITHUB_SERVER_URL (por defecto github.com). Las pruebas cambian OPS_DIR, TREE_DIR y OPS_REMOTE_URL.
# Salida: 0 el árbol quedó armado · 1 no (dice por qué; no se mide nada).
set -euo pipefail

WS="${GITHUB_WORKSPACE:-$(pwd)}"
O="${OPS_DIR:-${WS}/ops}"
S="${TREE_DIR:-${WS}/harness}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
red() { echo "::error::$1 — no se mide nada"; exit 1; }

[ -d "${O}/.git" ] || red "no está el checkout del repo de operaciones en ${O}"
[ -d "${S}/.git" ] || red "no está el checkout del arnés en ${S}"
[ -n "${GITHUB_ENV:-}" ] || red "falta GITHUB_ENV (este guion corre dentro de un workflow de GitHub)"
[ -n "${GITHUB_REPOSITORY:-}" ] || red "falta GITHUB_REPOSITORY"
[ -f "${S}/scripts/ci/harness-tree.js" ] && [ -f "${S}/scripts/lib/team-repos.js" ] \
  || red "lo que se trajo como arnés no es el arnés (o es anterior a la 8.31): falta scripts/ci/harness-tree.js o scripts/lib/team-repos.js"

# 1. team-repos.json: forma completa, plataforma y que el repo de operaciones sea éste
[ -f "${O}/team-repos.json" ] || red "el repo de operaciones no trae team-repos.json (ejemplo: pipelines/operations/examples/github/team-repos.json del arnés)"
if ! WHY="$(node - "${S}/scripts/lib/team-repos.js" "${O}/team-repos.json" "${GITHUB_REPOSITORY}" <<'JS' 2>&1
const [lib, file, here] = process.argv.slice(2);
const r = require(lib).load(file);
if (!r.ok) { console.log(`team-repos.json no valida: ${r.problems.map((p) => `${p.path || '(el archivo)'}: ${p.message}`).join('; ')}`); process.exit(1); }
for (const k of ['public', 'operations']) {
  if (r.data[k].platform !== 'github') { console.log(`team-repos.json: ${k}.platform es «${r.data[k].platform}» y estos workflows son de GitHub`); process.exit(1); }
}
const ops = `${r.data.operations.org}/${r.data.operations.repo}`;
if (ops.toLowerCase() !== String(here).toLowerCase()) { console.log(`team-repos.json: operations es ${ops} y el workflow corre en ${here}: guardar iría a otro repo`); process.exit(1); }
JS
)"; then
  red "$(printf '%s' "${WHY}" | tail -n 1)"
fi

# 2. la lista cerrada
DATA_DIRS=(.dashboard inbox artifacts)
CONFIG_FILES=(operations.json team-repos.json scripts/nightly/dependencies/repos.json scripts/nightly/dependencies/summary.json scripts/nightly/dashboard/sources.json scripts/nightly/dashboard/declared.json scripts/ci/product-parity.json)
ENTRIES=()
for D in "${DATA_DIRS[@]}"; do
  [ -d "${O}/${D}" ] || continue
  mkdir -p "${S}/${D}"
  rsync -a --delete "${O}/${D}/" "${S}/${D}/"
  ENTRIES+=("${D}")
done
for F in "${CONFIG_FILES[@]}"; do
  [ -f "${O}/${F}" ] || continue
  mkdir -p "$(dirname "${S}/${F}")"
  cp -p "${O}/${F}" "${S}/${F}"
  ENTRIES+=("${F}")
done
IGNORED="$(cd "${O}" && git ls-files | grep -Ev '^(\.dashboard/|inbox/|artifacts/|\.github/|pipelines/|README\.md$|\.gitignore$)' | grep -vxF -f <(printf '%s\n' "${CONFIG_FILES[@]}") | head -n 20 || true)"
[ -z "${IGNORED}" ] || echo "::warning::El repo de operaciones trae archivos que este armado no lee (no se ponen encima del arnés): $(printf '%s' "${IGNORED}" | tr '\n' ' ')"
echo "del repo de operaciones: ${ENTRIES[*]:-(nada todavía)}"

# 3. el commit local, con la identidad del workflow
HARNESS_SHA="$(git -C "${S}" rev-parse HEAD)" || red "no pude leer el commit del arnés"
git -C "${S}" config user.name 'github-actions[bot]'
git -C "${S}" config user.email '41898282+github-actions[bot]@users.noreply.github.com'
if [ "${#ENTRIES[@]}" -gt 0 ]; then
  git -C "${S}" add -A -f -- "${ENTRIES[@]}" || red "no pude preparar lo traído de operaciones"
  if ! git -C "${S}" diff --cached --quiet; then
    TREE="$(git -C "${S}" write-tree)" || red "no pude armar el árbol con lo de operaciones"
    DATA_COMMIT="$(GIT_AUTHOR_NAME='github-actions[bot]' GIT_AUTHOR_EMAIL='41898282+github-actions[bot]@users.noreply.github.com' \
      GIT_COMMITTER_NAME='github-actions[bot]' GIT_COMMITTER_EMAIL='41898282+github-actions[bot]@users.noreply.github.com' \
      git -C "${S}" commit-tree "${TREE}" -p HEAD -m "datos de operaciones $(git -C "${O}" rev-parse --short HEAD) [local, no se empuja]")" \
      || red "no pude fijar lo de operaciones en un commit local"
    git -C "${S}" update-ref HEAD "${DATA_COMMIT}" || red "no pude mover HEAD al commit de los datos"
  fi
fi

# 4. origin → operaciones; el del arnés queda como «harness»
OLD="$(git -C "${S}" remote get-url origin)" || red "no pude leer el origin del árbol"
if git -C "${S}" remote get-url harness > /dev/null 2>&1; then git -C "${S}" remote set-url harness "${OLD}"; else git -C "${S}" remote add harness "${OLD}"; fi
OPS_URL="${OPS_REMOTE_URL:-${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}.git}"
git -C "${S}" remote set-url origin "${OPS_URL}"
(
  # shellcheck source=/dev/null
  . "${HERE}/operations-auth.sh"
  git -C "${S}" fetch --quiet origin main
) || red "no pude traer main del repo de operaciones (${OPS_URL}): ¿tiene una rama main con un commit? ¿el workflow tiene permissions: contents: write?"
if git -C "${S}" config --get-regexp 'extraheader' > /dev/null 2>&1; then red "quedó una credencial escrita en la config del árbol"; fi

# 5. la huella, de dónde salió el arnés y qué commit corre
HT="$(node "${S}/scripts/ci/harness-tree.js" --tree --repo "${S}")" || red "no pude dejar dicha la huella del árbol que se mide"
printf '%s' "${HT}" | grep -Eqx '[0-9a-f]{64}@[0-9a-f]{40}([0-9a-f]{24})?' || red "la huella del árbol no tiene su forma"
SOURCE="$(printf '%s' "${OLD}" | sed -E 's#://[^/@]*@#://#')"
{
  echo "HARNESS_TREE=${HT}"
  echo "HARNESS_SOURCE=${SOURCE}"
  echo "HARNESS_COMMIT=${HARNESS_SHA}"
} >> "${GITHUB_ENV}"
echo "el arnés sale de ${SOURCE}, commit ${HARNESS_SHA}; datos y configuración de $(git -C "${O}" rev-parse --short HEAD) (operaciones); origin del árbol → ${OPS_URL}; huella ${HT}"
