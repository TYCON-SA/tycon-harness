#!/usr/bin/env bash
# build-bundle.sh — arma la copia del arnés que se mide en Windows y la entrega como un bundle de git.
# Corre en el trabajo de Linux de pipelines/azure-pipelines-windows.yml.
#
# POR QUÉ UN BUNDLE. Lo que se mide es lo que recibe alguien de afuera: el repo único que arma el exportador (el mismo
# comando que usa la máquina limpia, scripts/tests/clean-machine.test.sh). El agente de Windows tiene que CLONARLO: si
# se le copian los archivos, git no aplica la conversión de finales de línea y la prueba esconde justo ese problema.
# Un bundle es un repo entero en un archivo: viaja como artefacto de la corrida y se clona con `git clone`.
#
# USO
#   bash scripts/tests/windows/build-bundle.sh --output <carpeta> [--harness-ref <ref>] [--skills-ref <ref>] [--package <lista>] [--repo <clon>]
#   bash scripts/tests/windows/build-bundle.sh --output <carpeta> --source <repo ya armado>
#     --harness-ref   qué commit del arnés se exporta (por defecto HEAD de este clon)
#     --repo          el clon del arnés que trae ese commit (por defecto, el clon donde vive este guion)
#     --skills-ref    qué commit de agent-skills (por defecto origin/main; si ese clon no lo trae, HEAD)
#     --package       los paquetes de la copia (por defecto core,bizuit: la unión, que es lo que se publica)
#     --source        no exporta: empaqueta el HEAD de ese repo (un repo público ya clonado, o uno de laboratorio).
#                     El repo tiene que venir ENTERO: desde un clon recortado (sin su historia) frena, con ese motivo.
#   Todo bundle se CLONA acá antes de entregarlo (lo que va a hacer el agente): `git bundle verify` solo no alcanza.
#   Un commit del repo unido (trae agents/, skills/ o packs/) exporta las dos fuentes de sí mismo. Uno de
#   antes de la unión toma agent-skills de TYCON_SKILLS_DIR (la raíz del clon o su carpeta skills/) o de
#   ~/.claude/agent-skills, que tiene que ser el repo viejo de agent-skills, no un enlace al arnés.
#
# DEJA en <carpeta>: harness.bundle y bundle-info.json (qué commits se exportaron). Nada más: la copia de trabajo y el
# listado PRIVADO de reemplazos del exportador se borran antes de terminar, también si algo falló, y si quedara alguno
# bajo <carpeta> el guion sale en rojo sin entregar el bundle.
#
# 🔴 LA COPIA SE ARMA CON EL EXPORTADOR Y LAS LISTAS DEL COMMIT QUE SE MIDE, no con los de la rama del pipeline
# El exportador lee su lista blanca (`allowlist.json`) de su propia carpeta y la cruza con
# el `suites.json` del commit exportado. Si corriera el exportador de ESTA rama contra otro commit, la lista de acá
# declararía una suite (`tests/windows-probe.test.js`) que el commit medido todavía no tiene, y el exportador frenaría:
# el pipeline sólo podría medir commits que ya traen los guiones de medición, justo lo contrario de lo que hace falta (medir `main`, la
# marca del viernes, la rama de otro trabajo). Por eso el árbol del commit medido se extrae a la carpeta de trabajo y corre
# SU exportador, con SUS listas. De la rama del pipeline salen sólo los guiones de medición (este archivo entre ellos).
#
# SALIDAS: 0 el bundle quedó y se pudo verificar · 1 no pude armarlo (dice por qué) · 2 uso.
# Sin red. No escribe en ningún repo: lee los objetos de git de los dos clones.
set -uo pipefail
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_COMMON_DIR

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUTPUT=""; HARNESS_REF=""; SKILLS_REF=""; PACKAGE="core,bizuit"; SOURCE=""; REPO=""
usage() { echo "uso: bash scripts/tests/windows/build-bundle.sh --output <carpeta> [--harness-ref <ref>] [--skills-ref <ref>] [--package <lista>] [--repo <clon>] | --output <carpeta> --source <repo>" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --output|--harness-ref|--skills-ref|--package|--source|--repo)
      [ $# -ge 2 ] && [ -n "$2" ] || usage
      case "$1" in
        --output) OUTPUT="$2" ;; --harness-ref) HARNESS_REF="$2" ;; --skills-ref) SKILLS_REF="$2" ;;
        --package) PACKAGE="$2" ;; --source) SOURCE="$2" ;; --repo) REPO="$2" ;;
      esac
      shift 2 ;;
    *) usage ;;
  esac
done
[ -n "${OUTPUT}" ] || usage

stop() { echo "❌ build-bundle: no pude armar el bundle — $1" >&2; exit 1; }
mkdir -p "${OUTPUT}" || stop "no pude crear ${OUTPUT}"
OUTPUT="$(cd "${OUTPUT}" && pwd)"
WORK="${OUTPUT}/.work"
cleanup() { rm -rf "${WORK}"; }
trap cleanup EXIT
rm -rf "${WORK}" "${OUTPUT}/harness.bundle" "${OUTPUT}/bundle-info.json"
mkdir -p "${WORK}" || stop "no pude crear ${WORK}"

if [ -n "${SOURCE}" ]; then
  # un repo ya armado: se empaqueta lo commiteado, tal cual
  [ -d "${SOURCE}" ] || stop "--source ${SOURCE} no es una carpeta"
  COPY="$(cd "${SOURCE}" && pwd)"
  git -C "${COPY}" rev-parse --verify --quiet 'HEAD^{commit}' > /dev/null || stop "${COPY} no es un repo de git con un commit"
  # un clon recortado no trae los padres de sus commits: el bundle se arma, pasa `git bundle verify` y después no se
  # puede clonar. Se dice acá, con su motivo; más abajo, además, todo bundle se clona antes de entregarlo.
  # «No pude saber» no es «no está recortado»: si git no contesta true o false, se frena con lo que dijo.
  SHALLOW="$(git -C "${COPY}" rev-parse --is-shallow-repository 2>&1)" || stop "no pude saber si ${COPY} está recortado: $(printf '%s' "${SHALLOW}" | head -n 1)"
  case "${SHALLOW}" in
    false) ;;
    true) stop "${COPY} es un clon recortado (sin su historia): un bundle armado desde ahí no se puede clonar — hay que traerlo entero" ;;
    *) stop "no pude saber si ${COPY} está recortado: git contestó «$(printf '%s' "${SHALLOW}" | head -n 1)»" ;;
  esac
  HARNESS_SHA=""; SKILLS_SHA=""; MODE="source"
else
  REPO="${REPO:-${ROOT}}"
  git -C "${REPO}" rev-parse --git-dir > /dev/null 2>&1 || stop "--repo ${REPO} no es un clon de git"
  REPO="$(cd "${REPO}" && pwd)"
  HARNESS_SHA="$(git -C "${REPO}" rev-parse --verify --quiet "${HARNESS_REF:-HEAD}^{commit}")" || stop "el arnés no tiene el commit pedido (${HARNESS_REF:-HEAD}): con una referencia que no sea la de la corrida, el checkout tiene que traer la historia"
  # 🔴 EL REPO UNIDO. Un commit que trae agents/, skills/ o packs/ en la raíz tiene las dos fuentes
  # adentro: las dos salen de ESE commit y no se lee otro clon (el exportador sale 2 si --agent-skills es otro commit).
  # Un commit de antes de la unión necesita el agent-skills de entonces, que es OTRO repo: si TYCON_SKILLS_DIR (o
  # ~/.claude/agent-skills, que suele ser un enlace al propio arnés) es el mismo repo, se frena.
  # La raíz del commit se lista una vez: un error de git frena con su motivo, nunca pasa como «no trae la carpeta».
  ROOT_LIST="$(git -C "${REPO}" ls-tree --name-only "${HARNESS_SHA}" 2>&1)" || stop "no pude listar la raíz del commit ${HARNESS_SHA}: ${ROOT_LIST}"
  UNIFIED=""
  if printf '%s\n' "${ROOT_LIST}" | grep -xE 'agents|skills|packs' >/dev/null; then UNIFIED=1; fi
  if [ -n "${UNIFIED}" ]; then
    [ -z "${SKILLS_REF}" ] || stop "el commit ${HARNESS_SHA} es del repo unido: trae las skills adentro y --skills-ref no aplica"
    SK="${REPO}"; SKILLS_SHA="${HARNESS_SHA}"
  else
  SK="${TYCON_SKILLS_DIR:-${HOME}/.claude/agent-skills}"
  if [ ! -d "${SK}/.git" ] && [ ! -f "${SK}/.git" ] && [ -d "$(dirname "${SK}")/.git" ]; then SK="$(dirname "${SK}")"; fi   # le pasaron la carpeta skills/
  git -C "${SK}" rev-parse --git-dir > /dev/null 2>&1 || stop "no encuentro el clon de agent-skills (TYCON_SKILLS_DIR o ~/.claude/agent-skills): ${SK}"
  SK_GIT="$(cd "${SK}" && cd "$(git rev-parse --git-common-dir)" && pwd -P)" || stop "no pude leer la carpeta de git de ${SK}"
  REPO_GIT="$(cd "${REPO}" && cd "$(git rev-parse --git-common-dir)" && pwd -P)" || stop "no pude leer la carpeta de git de ${REPO}"
  [ "${SK_GIT}" != "${REPO_GIT}" ] || stop "el commit ${HARNESS_SHA} es de antes de la unión y ${SK} es el mismo repo que el arnés: hace falta el clon de agent-skills de entonces (TYCON_SKILLS_DIR)"
  if [ -n "${SKILLS_REF}" ]; then
    SKILLS_SHA="$(git -C "${SK}" rev-parse --verify --quiet "${SKILLS_REF}^{commit}")" || stop "agent-skills no tiene el commit pedido (${SKILLS_REF})"
  else
    SKILLS_SHA="$(git -C "${SK}" rev-parse --verify --quiet 'origin/main^{commit}')" || SKILLS_SHA="$(git -C "${SK}" rev-parse --verify --quiet 'HEAD^{commit}')" || stop "agent-skills no tiene origin/main ni HEAD"
  fi
  fi
  COPY="${WORK}/copy"; MODE="export"
  echo "build-bundle: exporto ${PACKAGE} (un solo repo) · arnés ${HARNESS_SHA} · agent-skills ${SKILLS_SHA}"
  # La salida del exportador (su --json nombra lo reemplazado) no se muestra ni se guarda: queda en la carpeta de
  # trabajo, que se borra al salir. Sus errores (stderr) sí se ven.
  # 🔴 El exportador y sus listas son los del commit que se mide (ver la cabecera): su árbol se extrae a la carpeta de
  # trabajo, que se borra al salir. El repo de donde se leen los objetos sigue siendo el clon (TYCON_GUIDES_DIR).
  REF_TREE="${WORK}/ref-tree"
  mkdir -p "${REF_TREE}" || stop "no pude crear ${REF_TREE}"
  git -C "${REPO}" archive --format=tar "${HARNESS_SHA}" | tar -x -C "${REF_TREE}" || stop "no pude extraer el árbol del commit ${HARNESS_SHA}"
  [ -f "${REF_TREE}/scripts/publishing/export.js" ] || stop "el commit ${HARNESS_SHA} no trae scripts/publishing/export.js: no hay con qué armar su copia (es anterior al exportador)"
  TYCON_GUIDES_DIR="${REPO}" TYCON_SKILLS_DIR="${SK}" node "${REF_TREE}/scripts/publishing/export.js" --package "${PACKAGE}" --single-repo \
    --output "${COPY}" --harness "${HARNESS_SHA}" --agent-skills "${SKILLS_SHA}" --json > "${WORK}/export.json"
  RC=$?
  rm -f "${COPY}.reemplazos.md"          # el listado privado de reemplazos: se va apenas termina, también si falló
  if [ "${RC}" -ne 0 ]; then
    # Qué control frenó y en qué archivo: sólo nombres de control, rutas, líneas y categorías. Nunca el texto encontrado.
    node -e '
      let d; try { d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch (e) { console.error("  (el exportador no dejó un resultado legible)"); process.exit(0); }
      for (const [name, v] of Object.entries(d.controles || {})) { const n = Array.isArray(v) ? v.length : Number(v) || 0; if (n) console.error("  control " + name + ": " + n + " hallazgo(s)"); }
      for (const [name, v] of Object.entries(d.detector || {})) for (const h of (v && v.hallazgos) || []) console.error("  detector (" + name + "): " + h.archivo + ":" + h.linea + " · " + h.categoria);
      for (const k of ["pendientes", "globsSinUso", "entradasSinClasificar"]) if (Array.isArray(d[k]) && d[k].length) console.error("  " + k + ": " + d[k].length);
    ' "${WORK}/export.json" >&2
    stop "el exportador salió ${RC} (1 = hallazgos, 2 = no pudo armar la copia): arriba, qué control y en qué archivo"
  fi
  [ -d "${COPY}/.git" ] || stop "el exportador salió 0 y no dejó un repo en ${COPY}"
fi

# El bundle lleva HEAD y la rama main: así el clon queda con una rama y con su checkout hecho.
BRANCH_REPO="${COPY}"
if [ "${MODE}" = "source" ]; then
  # no se toca el repo que pasaron: la rama main se arma en un clon de trabajo
  git clone --quiet "${COPY}" "${WORK}/source-copy" || stop "no pude clonar ${COPY}"
  BRANCH_REPO="${WORK}/source-copy"
fi
git -C "${BRANCH_REPO}" checkout --quiet -B main || stop "no pude dejar la copia con una rama main"
COPY_SHA="$(git -C "${BRANCH_REPO}" rev-parse HEAD)" || stop "no pude leer el commit de la copia"
git -C "${BRANCH_REPO}" bundle create --quiet "${OUTPUT}/harness.bundle" HEAD main || stop "git bundle create falló"
# Desde acá, un `stop` no deja un bundle a medio verificar en la carpeta de entrega.
refuse() { rm -f "${OUTPUT}/harness.bundle" "${OUTPUT}/bundle-info.json"; stop "$1"; }
git bundle verify --quiet "${OUTPUT}/harness.bundle" > /dev/null 2>&1 || git -C "${BRANCH_REPO}" bundle verify --quiet "${OUTPUT}/harness.bundle" > /dev/null 2>&1 || refuse "el bundle no pasa git bundle verify"
# La prueba que vale es la que va a hacer el agente: clonarlo. `git bundle verify` da por bueno un bundle al que le
# faltan objetos que el repo donde se verifica tampoco tiene.
CLONE_ERR="$(git clone --quiet --bare "${OUTPUT}/harness.bundle" "${WORK}/clone-check.git" 2>&1)" || refuse "el bundle no se puede clonar: $(printf '%s' "${CLONE_ERR}" | head -n 1)"
CLONED_SHA="$(git -C "${WORK}/clone-check.git" rev-parse --verify --quiet 'refs/heads/main^{commit}')" || refuse "el clon del bundle no trae la rama main"
[ "${CLONED_SHA}" = "${COPY_SHA}" ] || refuse "el clon del bundle quedó en ${CLONED_SHA} y la copia es ${COPY_SHA}"
rm -rf "${WORK}/clone-check.git"
# los bloques de instalación: en la referencia; una copia anterior los trae en la portada
[ -f "${BRANCH_REPO}/getting-started/reference.md" ] || [ -f "${BRANCH_REPO}/.github/README.md" ] || [ -f "${BRANCH_REPO}/README.md" ] || refuse "la copia no trae ni su referencia (getting-started/reference.md) ni su portada (.github/README.md): el paso de instalación no tendría qué leer"

node -e '
  const [file, mode, pkg, harness, skills, copy] = process.argv.slice(1);
  require("fs").writeFileSync(file, JSON.stringify({ mode, package: mode === "export" ? pkg : null, harness_commit: harness || null, agent_skills_commit: skills || null, copy_commit: copy, created: new Date().toISOString() }, null, 2) + "\n");
' "${OUTPUT}/bundle-info.json" "${MODE}" "${PACKAGE}" "${HARNESS_SHA}" "${SKILLS_SHA}" "${COPY_SHA}" || refuse "no pude escribir bundle-info.json"

cleanup
LEFT="$(find "${OUTPUT}" -name '*.reemplazos.md' -print)"
if [ -n "${LEFT}" ]; then rm -f "${OUTPUT}/harness.bundle" "${OUTPUT}/bundle-info.json"; stop "quedó un listado privado de reemplazos bajo ${OUTPUT}: no entrego el bundle"; fi
echo "✅ build-bundle: ${OUTPUT}/harness.bundle · copia ${COPY_SHA}"
