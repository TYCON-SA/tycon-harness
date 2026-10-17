#!/usr/bin/env bash
# clean-machine.test.sh — la máquina limpia (story 8.7, tanda C · T24, T26-T31, T34; story 8.13, tanda D · su T34).
#
# Instala el arnés en un contenedor que trae SÓLO lo que la portada pública declara como requisito, como lo haría
# alguien de afuera: con el bloque `install:core` de la portada, tal cual. Y mide lo que sólo se ve ahí:
#   T24 · CleanMachine_SoloLoQueDeclaraLaPortada — cada requisito del bloque responde; ninguna herramienta vigilada
#         está; las bases van por el digest de su índice; las derivadas no tienen python3 y node, respectivamente.
#   T26 · CleanMachine_Nucleo_InstalaComoDeAfuera — el bloque sale 0 y deja los cuatro enlaces, el estado, la línea
#         de arranque, la copia fija, el `@import`; `harness.js version` da la versión estampada, exacta; nadie llama a
#         una herramienta que la portada no pide; con una versión nueva servida por la copia, `startup` no la aplica y
#         deja el aviso; y `harness.js uninstall --yes` deja todo como estaba. Dos variantes: HOME vacía, y
#         `~/.claude/skills` y `~/.claude/agents` como carpetas reales con algo propio.
#         LA T34 DE LA STORY 8.13 (`CleanMachine_OneLineInstall_AskDoesNotApply_Doctor_Uninstall`, su AC 27) se cumple
#         acá: es esta T26 ampliada con «version da la estampada» y «versión nueva que no se aplica». Sus líneas salen
#         como «T26 (…)», porque en este archivo «T34» ya nombra otra prueba (abajo). Mide «`ask` no aplica y avisa»; el
#         camino del clon público (la rama propia, no bajar de número) lo mide `harness-channel.test.sh` en
#         laboratorio: dentro del contenedor el remoto que ve el programa es una carpeta local, no el repo público.
#   T27 · CleanMachine_Nucleo_PipelineSobreRepoDeEjemplo — el esqueleto mecánico del pipeline sobre un repo de Node.
#   T28 · CleanMachine_Stack_PipelineSobrePluginDeEjemplo — lo mismo con el paquete del stack sobre el plugin de
#         ejemplo, clonado de GitHub por sha.
#   T29 · CleanMachine_NucleoSolo_PideElPaquete — el núcleo solo frente a un repo que pide el paquete (modo interno).
#   T30 · CleanMachine_SinRed_DegradaYLoDice — sin red la instalación sale 0, lo dice, y `startup` dice «sin red».
#   T31 · CleanMachine_SinPythonOSinNode_DiceQueFalta — sin python3 o sin node, una línea que nombra lo que falta y
#         nada escrito; y `--check` no escribe.
#   T34 · CleanMachine_CuandoNoMide — sin docker, fuera del nocturno, en el control de cada cambio: NO MEDIDO con su
#         motivo y ningún ✅; con un docker que no termina: rojo por tope, nombrando el paso. No usa docker: corre
#         en toda máquina, antes que cualquier otra cosa. Con ella corre, también sin docker, la lectura de la portada
#         («T24 (portada)»): los tres bloques y la forma de cada requisito, contra la portada real y contra entradas
#         mal formadas; y lo que el escenario del núcleo hace con la copia servida y con el estado («T26
#         (laboratorio)»): leer la versión estampada, servir una versión nueva y soltar el sello de la última mirada,
#         sobre copias y un estado de juguete.
#   T37 y T39 DE LA STORY 8.18 (`NewMachine_OneClone_OneSource_ThreeLinks_ThirdPartyOffline` y
#         `Docs_InstallAndOnboarding_SayOneRepo`, su AC 36) · la máquina NUEVA del equipo después de la unión de los dos
#         repos internos: el contenedor del núcleo, SIN RED, con un clon del repo unido interno (no pasa por el
#         exportador), ejecuta tal cual el bloque `<!-- install:internal -->` de INSTALL.md —un clon y `harness.js
#         install`— y mide lo que queda: una fuente, los cuatro enlaces, las skills de terceros restituidas desde la
#         historia local, `doctor` sin rojos, ningún hook dos veces (tampoco llamando al instalador por el enlace), y
#         un clon sin `skills/` que sale 1 sin escribir. Sólo en modo interno. Sin docker corre su parte de lectura
#         («T39 (papeles)»): el bloque de INSTALL.md se lee y es un `git clone` y `harness.js install`.
#
# CÓMO ESTÁ ARMADA: acá (en el anfitrión) se arman las copias, las imágenes y los contenedores; las verificaciones
#   corren ADENTRO, en `clean-machine/scenarios/*.sh` (core, folders, no-network, npx, missing-tool, union, unified), que
#   imprimen las líneas con `clean-machine/lib.sh`; esta prueba las pasa a su salida y las cuenta. Los dos `Dockerfile`
#   son la lista de requisitos de la portada hecha ejecutable. Pasos (cada uno bajo tope, con su nombre en el rojo):
#   docker-probe, index-core, index-bizuit, export-core, export-union, build-core, build-src-core, build-nopython,
#   build-nonode, build-bizuit, build-src-union, clone-unified, build-src-unified, y una corrida por escenario: run-core,
#   run-folders, run-no-network, run-nopython, run-nonode, run-union, run-unified.
#
# USO:  bash scripts/tests/clean-machine.test.sh [--keep] [--only unified]          (otro argumento: salida 2)
#   --keep   no mide: deja un contenedor vivo, instalado y con el repo de ejemplo, para la corrida con modelo
#            (`tycon-clean-machine-keep`; sale 0 si quedó listo, 1 si no). No trae Claude Code ni credenciales.
#   --only unified   mide SÓLO el escenario de la máquina nueva del equipo (story 8.18): no exporta ninguna copia ni
#            corre los otros escenarios (construye la imagen del núcleo y la del clon unido, y una corrida sin red).
#
# CUÁNDO MIDE (gana la primera):
#   TYCON_CLEAN_MACHINE=1   pedida: mide, o sale 1 diciendo por qué no pudo.
#   TYCON_CLEAN_MACHINE=0   no mide, y lo dice (salida 0). Gana también en el nocturno.
#   sin la variable         mide sólo en el nocturno (TF_BUILD puesto y BUILD_REASON=Schedule). En el control de cada
#                           cambio y en la máquina de un dev: NO MEDIDO, salida 0 — nadie construye imágenes sin pedirlo.
#   Midiendo, UNA verificación puede salir NO MEDIDO por su cuenta, con su motivo: sin `docker buildx` no se puede leer
#   el índice multi-arquitectura de las bases (T24); T29 en modo público (el paquete está en la copia); y «version da la
#   estampada» en modo público, si el árbol no trae `version.json`.
# DOS MODOS:
#   interno (sin TYCON_CLEAN_MACHINE_SOURCE) — exporta `core --single-repo` y `core,bizuit --single-repo` desde un
#     commit SUELTO del árbol de trabajo del arnés (TYCON_CLEAN_MACHINE_HARNESS_REF lo cambia) y agent-skills de
#     origin/main (TYCON_CLEAN_MACHINE_SKILLS_REF=<ref>, o `worktree` para su árbol de trabajo). Cada copia sale
#     estampada con un número de laboratorio (`export.js --stamp-version`, LAB_VERSION): es el que `version` tiene que dar.
#     En el repo UNIDO (story 8.18: el commit del arnés trae skills/ y agents/) las dos fuentes salen del MISMO commit,
#     el del arnés: TYCON_CLEAN_MACHINE_SKILLS_REF no hace falta, y si pide otro commit se niega (`second_source`; lo
#     prueba, sin docker, «T26 (fuentes)»).
#   público (TYCON_CLEAN_MACHINE_SOURCE=<raíz del repo público>) — sobre ese repo, que es la unión. T29 sale NO MEDIDO.
#   En el árbol del repo de MANTENIMIENTO adelgazado (`.tycon/internal-forms.json` con `layout: thin`, story 8.26) el
#     modo interno ya no corre (AC 36: ese árbol no arma la copia; la copia es el repo público, que mide la máquina
#     limpia en cada pedido). En Azure (TF_BUILD) sale NO MEDIDO con ese motivo, con cualquier BUILD_REASON y aunque la
#     corrida la pida con TYCON_CLEAN_MACHINE=1 (story 2.21, AC 5: el banco a mano la llevaba roja); pedida a mano fuera
#     de Azure, sale 1 diciendo cómo medir (con TYCON_CLEAN_MACHINE_SOURCE). Lo prueba, sin docker, «T34 (mantenimiento)»
#     y «T34 Mantenimiento_PedidaAMano_NoMedido». El reporte de suites la cuenta «se mide en otro lado» (suites.json).
#     La versión esperada es la del `version.json` del árbol; si no lo trae, esa verificación sale NO MEDIDO.
# TOPES: cada paso corre bajo `clean-machine/run-capped.js` (en macOS no hay `timeout`); al vencer mata el grupo, saca
#   el contenedor y el paso sale en rojo con su nombre. TYCON_CLEAN_MACHINE_CAP_S pisa el tope de CADA paso;
#   TYCON_CLEAN_MACHINE_BUDGET_S (1500) es el presupuesto total: el tope de un paso es el menor entre el suyo y lo que queda.
# SALIDAS: 0 = todo lo medido en verde, o no le tocaba medir · 1 = algún rojo, un tope vencido, o pedida sin poder · 2 = uso.
# EL ENTORNO: base fija `mktemp -d /tmp/tycon-clean-machine.XXXXXX` (nunca el TMPDIR de quien corre). La copia entra a
#   la imagen en una CAPA con su dueño (`COPY --chown`), nunca montada: ningún `docker run` lleva `-v`. El listado
#   privado de reemplazos queda fuera de los contextos de docker y se borra apenas termina cada exportación.
# DURACIÓN MEDIDA (2026-10-03, con las imágenes base ya bajadas): modo interno 263 s en linux/arm64, con la tanda D de
#   la story 8.13 adentro (dos exportaciones, seis escenarios, 115 verificaciones). En linux/amd64, la del nocturno, la
#   última medición es de ANTES de esa tanda: 415 s con 108 verificaciones; la tanda le suma al escenario del núcleo un
#   `startup` y siete verificaciones. Modo público entre 50 y 142 s (antes de la tanda D). Sin la llave, 3 a 4 s. La
#   primera corrida de una máquina suma la bajada de las dos bases (~1 GB).

set -uo pipefail
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_COMMON_DIR
SELF="${BASH_SOURCE[0]}"
ROOT="$(cd "$(dirname "${SELF}")/../.." && pwd)"
LAB="${ROOT}/scripts/tests/clean-machine"
CAPPED="${LAB}/run-capped.js"
# shellcheck source=clean-machine/lib.sh
. "${LAB}/lib.sh"

# ── compuerta 1 · argumentos ─────────────────────────────────────────────────────────────────────────────────
KEEP=0; ONLY=""
USAGE="uso: bash scripts/tests/clean-machine.test.sh [--keep] [--only unified]"
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --only)
      # un solo escenario: hoy, el de la máquina nueva del equipo (story 8.18). Otro nombre es un error de uso
      [ "${2:-}" = unified ] || { echo "${USAGE}" >&2; exit 2; }
      ONLY="$2"; shift ;;
    *) echo "${USAGE}" >&2; exit 2 ;;
  esac
  shift
done
if [ "${KEEP}" -eq 1 ] && [ -n "${ONLY}" ]; then echo "${USAGE}" >&2; exit 2; fi   # --keep deja el contenedor del núcleo: no va con --only

T="$(mktemp -d /tmp/tycon-clean-machine.XXXXXX)" || { echo "⏭ clean-machine: NO MEDIDO — no pude crear la carpeta temporal en /tmp"; exit 1; }
mkdir -p "${T}/out"
RUN_ID="r$$"; LABEL="tycon.clean-machine=${RUN_ID}"
DOCKER_READY=0
T0="${SECONDS}"; BUDGET="${TYCON_CLEAN_MACHINE_BUDGET_S:-1500}"
STEP_N=0; STEP_LOG=""; STEP_CAP=0

# step <paso> <tope en s> [--container <nombre>] -- <comando…> — corre el comando bajo tope; su salida queda en
# out/<n>-<paso>.log (STEP_LOG). Devuelve el exit del comando, o 124 si venció el tope (el efectivo queda en STEP_CAP).
step() {
  local name="$1" cap="$2" left rc; shift 2
  STEP_N=$((STEP_N + 1)); STEP_LOG="${T}/out/${STEP_N}-${name}.log"; : > "${STEP_LOG}"
  [ -n "${TYCON_CLEAN_MACHINE_CAP_S:-}" ] && cap="${TYCON_CLEAN_MACHINE_CAP_S}"
  left=$((BUDGET - (SECONDS - T0)))
  if [ "${left}" -le 0 ]; then
    STEP_CAP=0; echo "run-capped: ${name} no arrancó: se agotó el presupuesto total de ${BUDGET} s" > "${STEP_LOG}"; return 124
  fi
  [ "${cap}" -gt "${left}" ] && cap="${left}"
  STEP_CAP="${cap}"
  node "${CAPPED}" "${name}" "${cap}" "$@" > "${STEP_LOG}" 2>&1; rc=$?
  return "${rc}"
}
# step_red <paso> <exit> — la línea roja del paso (el formato es contrato) y, con sangría, el final de su salida
step_red() {
  if [ "$2" -eq 124 ]; then no "$1 — se colgó: pasó el tope de ${STEP_CAP} s"; else no "$1 — falló (exit $2)"; fi
  tail -n 30 "${STEP_LOG}" | sed 's/^/     /'
}

cleanup() {
  if [ "${DOCKER_READY}" -eq 1 ]; then docker_cleanup; fi
  rm -rf "${T}"
}
trap cleanup EXIT

# finish — la última línea y la salida
finish() {
  if [ "${CM_FAILS}" -gt 0 ]; then echo "❌ clean-machine: ${CM_FAILS} de ${CM_TOTAL} en rojo"; exit 1; fi
  if [ "${CM_TOTAL}" -gt 0 ]; then echo "✅ clean-machine: ${CM_TOTAL} verificaciones, ${CM_SKIPPED} no medidas"; fi
  exit 0
}
# unable <motivo> — se la pidieron (o es el nocturno) y no puede: NO MEDIDO con su motivo, nunca verde, salida 1
unable() {
  skip "$1"
  if [ "${CM_FAILS}" -gt 0 ]; then echo "❌ clean-machine: ${CM_FAILS} de ${CM_TOTAL} en rojo"; fi
  exit 1
}

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
# La portada: los bloques que la prueba ejecuta TAL CUAL y la lista de requisitos que hace ejecutable
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
KNOWN_PACKS="bizuit"          # los paquetes para los que la prueba tiene imagen (un requisito `(otro)` es un rojo)
CLONE_RE='^git clone (https://[^[:space:]]+)'
URL_RE='^https://[A-Za-z0-9.-]+/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'

# cover_block <portada> <marcador> <lenguaje> → el contenido del PRIMER bloque ```<lenguaje> que hay entre
# `<!-- marcador -->` y `<!-- /marcador -->` (sin las vallas). 1 si falta el marcador, su cierre o el bloque, o si el
# marcador está dos veces.
cover_block() {
  awk -v o="<!-- $2 -->" -v c="<!-- /$2 -->" -v f='```'"$3" '
    $0 == o { if (seen) dup = 1; seen = 1; inside = 1; next }
    $0 == c { if (inside) closed = 1; inside = 0; fenced = 0; next }
    inside && !done && !fenced && $0 == f { fenced = 1; next }
    inside && fenced && $0 == "```" { fenced = 0; done = 1; next }
    inside && fenced { print }
    END { exit (seen && closed && done && !dup) ? 0 : 1 }' "$1"
}
# cover_url <bloque install:core> → la URL COMPLETA del repo público (la que sigue a `git clone`). 1 si no está o no
# está resuelta: en el repo interno la portada la trae como {{public-org}}/{{public-repo}}, y eso no es una URL — por
# eso el modo interno la lee de la COPIA exportada, donde el exportador ya puso el nombre.
cover_url() {
  local line
  line="$(grep -m 1 -E '^git clone ' "$1")" || return 1
  [[ "${line}" =~ ${CLONE_RE} ]] || return 1
  [[ "${BASH_REMATCH[1]}" =~ ${URL_RE} ]] || return 1
  echo "${BASH_REMATCH[0]}"
}
# read_cover <portada> <carpeta> → deja install-core.sh, install-bizuit.sh, install-unattended.sh, requirements.txt y public-url.txt en la
# carpeta. Si algo no se puede leer, dice qué (stdout) y devuelve 1.
read_cover() {
  local readme="$1" out="$2" why url
  [ -f "${readme}" ] || { echo "no está ${readme}"; return 1; }
  cover_block "${readme}" requirements text > "${out}/requirements.txt" || { echo 'falta el bloque <!-- requirements --> con su valla ```text y su cierre'; return 1; }
  # story 8.23, tanda E: `install:core` pasó a ser la portada SIN git (baja la versión por la API: la miden los escenarios
  # release-*); lo que estos escenarios corren tal cual es el bloque que CLONA —el modo desarrollador— `install:clone`
  # (y `install:clone-unattended`). Los archivos conservan su nombre de siempre para que los escenarios no cambien.
  cover_block "${readme}" install:clone bash > "${out}/install-core.sh" || { echo 'falta el bloque <!-- install:clone --> con su valla ```bash y su cierre'; return 1; }
  # (story 8.41: el bloque install:bizuit salió con el paquete: los paquetes llegan con el perfil del equipo)
  # story 8.16, tanda B: la misma línea más --yes, para una máquina sin terminal (la corre folders.sh)
  cover_block "${readme}" install:clone-unattended bash > "${out}/install-unattended.sh" || { echo 'falta el bloque <!-- install:clone-unattended --> con su valla ```bash y su cierre'; return 1; }
  why="$(req_check_file "${out}/requirements.txt" "${KNOWN_PACKS}")" || { echo "requisitos: $(echo "${why}" | tr '\n' ';')"; return 1; }
  url="$(cover_url "${out}/install-core.sh")" || { echo "el bloque install:clone no trae, después de «git clone», la URL completa y resuelta del repo público: $(head -n 1 "${out}/install-core.sh")"; return 1; }
  printf '%s\n' "${url}" > "${out}/public-url.txt"
}

# cover_selfcheck — la lectura de la portada, probada sin docker (corre con T34, en toda máquina): contra la portada
# real, y contra entradas mal formadas que TIENEN que rechazarse (el espejo).
cover_selfcheck() {
  local d="${T}/cover" cover why line rejected=0 total=0
  mkdir -p "${d}/ok" "${d}/bad"
  # los bloques de instalación viven en la referencia (getting-started/reference.md) desde que la portada se achicó
  cover="${ROOT}/getting-started/reference.md"
  if [ ! -f "${cover}" ]; then no "T24 (referencia) no encuentro la referencia con los bloques de instalación (getting-started/reference.md)"; return; fi
  # el nombre del repo ya puesto, como lo deja el exportador (en la copia pública no cambia nada)
  sed -e 's/{{public-org}}/acme/g' -e 's/{{public-repo}}/harness/g' "${cover}" > "${d}/README.md"
  if why="$(read_cover "${d}/README.md" "${d}/ok")"; then
    ok "T24 (referencia) los tres bloques de la referencia se leen (requirements, install:core, install:unattended), cada requisito tiene la forma declarada ($(tr '\n' ',' < "${d}/ok/requirements.txt" | sed -e 's/,$//' -e 's/,/, /g')) y la URL del repo está resuelta"
  else no "T24 (referencia) la referencia no se puede leer: ${why}"; fi
  # el espejo · requisitos con otra forma, con un paquete que la prueba no conoce, o un bloque vacío: rojo
  for line in 'node>=22' 'Node 22' 'node >= v22' 'node >= 22 or later' 'dotnet (other-pack)' 'git ' ''; do
    total=$((total + 1)); printf 'git\n%s\n' "${line}" > "${d}/bad/requirements.txt"
    req_check_file "${d}/bad/requirements.txt" "${KNOWN_PACKS}" > /dev/null || rejected=$((rejected + 1))
  done
  total=$((total + 1)); : > "${d}/bad/requirements.txt"
  req_check_file "${d}/bad/requirements.txt" "${KNOWN_PACKS}" > /dev/null || rejected=$((rejected + 1))
  if [ "${rejected}" -eq "${total}" ]; then ok "T24 (portada) el espejo: ${total} bloques de requisitos mal formados (otra forma, paquete desconocido, vacío) se rechazan"
  else no "T24 (portada) el espejo: sólo ${rejected} de ${total} bloques de requisitos mal formados se rechazan"; fi
  # el espejo · una portada sin el cierre de un bloque, sin la valla, o con la URL sin resolver: rojo
  rejected=0; total=3
  grep -v -x -F '<!-- /requirements -->' "${d}/README.md" > "${d}/bad/no-close.md"
  read_cover "${d}/bad/no-close.md" "${d}/bad" > /dev/null || rejected=$((rejected + 1))
  sed -e 's/^```bash$/```sh/' "${d}/README.md" > "${d}/bad/no-fence.md"
  read_cover "${d}/bad/no-fence.md" "${d}/bad" > /dev/null || rejected=$((rejected + 1))
  sed -e 's#^git clone https://[^ ]*#git clone https://github.com/{{public-org}}/{{public-repo}}#' "${d}/README.md" > "${d}/bad/no-url.md"
  read_cover "${d}/bad/no-url.md" "${d}/bad" > /dev/null || rejected=$((rejected + 1))
  if [ "${rejected}" -eq "${total}" ]; then ok "T24 (portada) el espejo: una portada sin el cierre de un bloque, sin su valla o con la URL sin resolver se rechaza"
  else no "T24 (portada) el espejo: sólo ${rejected} de ${total} portadas mal formadas se rechazan"; fi
}

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
# La versión: el número de laboratorio de la copia, y la versión nueva que `ask` no aplica (T34 de la story 8.13)
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
# El número con que el modo interno estampa sus copias (`export.js --stamp-version`): fijo y lejano, para que no se
# confunda con uno publicado. Adentro, `harness.js version` tiene que dar ESTE número, exacto.
LAB_VERSION="2030.01.15.1"

# version_selfcheck — lo que el escenario del núcleo hace DENTRO del contenedor con la copia servida y con el estado
# (leer la versión estampada, servir una versión nueva, soltar el sello de la última mirada), probado sin docker sobre
# copias y un estado de juguete: corre con T34, en toda máquina, cada caso con su espejo. Con docker lo vuelve a medir
# el escenario (las líneas «T26 (versión nueva)»).
# 🔴 rojo previo: las cuatro líneas en rojo con «stamped_version_of: command not found», y lo mismo para
#    serve_new_version y forget_last_fetch (salida 127): lib.sh todavía no las traía.
version_selfcheck() {
  local d="${T}/version" sha_a="1111111111111111111111111111111111111111" sha_b="2222222222222222222222222222222222222222"
  local next v rc r_plain r_shape r_json r_broken r_missing before before_broken
  mkdir -p "${d}/bad" "${d}/state"
  next="${LAB_VERSION%.*}.$(( ${LAB_VERSION##*.} + 1 ))"
  # version_bytes <número> — el archivo con la forma exacta que estampa la publicación (dos espacios, este orden de
  # claves, un salto de línea final)
  version_bytes() {
    printf '{\n  "version": "%s",\n  "source": {\n    "harness": "%s",\n    "agent_skills": "%s"\n  }\n}\n' "$1" "${sha_a}" "${sha_b}"
  }
  # tres copias de juguete: con su version.json, sin él, y con uno que no se puede leer
  if ! { fake_public_repo "${d}/served" && fake_public_repo "${d}/plain" && fake_public_repo "${d}/broken"; } > "${d}/copies.out" 2>&1; then
    no "T26 (laboratorio) no pude armar las copias de juguete: $(tail -n 2 "${d}/copies.out" | tr '\n' ' ')"; return
  fi
  version_bytes "${LAB_VERSION}" > "${d}/served/version.json"; printf '{ "version": ' > "${d}/broken/version.json"
  if ! { lab_git -C "${d}/served" add version.json && lab_git -C "${d}/served" commit -q -m 'lab: version.json' \
      && lab_git -C "${d}/broken" add version.json && lab_git -C "${d}/broken" commit -q -m 'lab: version.json roto'; } >> "${d}/copies.out" 2>&1; then
    no "T26 (laboratorio) no pude commitear el version.json de las copias de juguete: $(tail -n 2 "${d}/copies.out" | tr '\n' ' ')"; return
  fi

  # la lectura de la versión estampada
  v="$(stamped_version_of "${d}/served" 2> "${d}/read.err")"; rc=$?
  stamped_version_of "${d}/plain" > /dev/null 2>&1; r_plain=$?
  version_bytes "2030.1.15.1" > "${d}/bad/version.json"; stamped_version_of "${d}/bad" > /dev/null 2>&1; r_shape=$?
  stamped_version_of "${d}/broken" > /dev/null 2>&1; r_json=$?
  if [ "${rc}" -eq 0 ] && [ "${v}" = "${LAB_VERSION}" ] && [ "${r_plain}" -eq 1 ] && [ "${r_shape}" -eq 2 ] && [ "${r_json}" -eq 2 ]; then
    ok "T26 (laboratorio) la versión estampada de una copia se lee de su version.json (${LAB_VERSION}); el espejo: sin el archivo lo dice (1), y uno ilegible o con un número sin forma se rechaza (2)"
  else no "T26 (laboratorio) la lectura de la versión estampada dio «${v}» (exit ${rc}; esperado ${LAB_VERSION} y 0); sin el archivo, ${r_plain} (esperado 1); con un número sin forma, ${r_shape}, y con un JSON roto, ${r_json} (esperado 2 y 2): $(head -c 200 "${d}/read.err" | tr '\n' ' ')"; fi

  # servir una versión nueva: un commit más en la copia, y su version.json con el número siguiente y la misma forma
  before="$(lab_git -C "${d}/served" rev-parse HEAD)"
  ( export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1; COPY_DIR="${d}/served"
    serve_new_version && printf '[%s]\n' "${NEW_VERSION}" > "${d}/served.new" ) > "${d}/serve.out" 2>&1; rc=$?
  version_bytes "${next}" > "${d}/want.json"
  if [ "${rc}" -eq 0 ] && [ "$(cat "${d}/served.new" 2> /dev/null)" = "[${next}]" ] && cmp -s "${d}/served/version.json" "${d}/want.json" \
     && [ "$(lab_git -C "${d}/served" rev-parse 'HEAD^' 2> /dev/null)" = "${before}" ] && [ -z "$(lab_git -C "${d}/served" status --porcelain)" ]; then
    ok "T26 (laboratorio) servir una versión nueva deja UN commit más en la copia y sube su version.json al número siguiente (${next}), con la forma exacta del archivo"
  else no "T26 (laboratorio) servir una versión nueva salió ${rc} y dejó el número «$(cat "${d}/served.new" 2> /dev/null)» (esperado [${next}]), o el version.json con otra forma, o no es un commit más sobre ${before:0:7}: $(tail -n 2 "${d}/serve.out" | tr '\n' ' ')"; fi

  # el espejo: una copia sin version.json recibe su commit y nadie le inventa un número; una con el archivo roto, nada
  before="$(lab_git -C "${d}/plain" rev-parse HEAD)"; before_broken="$(lab_git -C "${d}/broken" rev-parse HEAD)"
  ( export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1; COPY_DIR="${d}/plain"
    serve_new_version && printf '[%s]\n' "${NEW_VERSION}" > "${d}/plain.new" ) > "${d}/serve-plain.out" 2>&1; rc=$?
  ( export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1; COPY_DIR="${d}/broken"
    serve_new_version ) > "${d}/serve-broken.out" 2>&1; r_broken=$?
  if [ "${rc}" -eq 0 ] && [ "$(cat "${d}/plain.new" 2> /dev/null)" = "[]" ] && [ ! -e "${d}/plain/version.json" ] \
     && [ "$(lab_git -C "${d}/plain" rev-parse 'HEAD^' 2> /dev/null)" = "${before}" ] \
     && [ "${r_broken}" -ne 0 ] && [ "${r_broken}" -ne 127 ] && [ "$(lab_git -C "${d}/broken" rev-parse HEAD)" = "${before_broken}" ]; then
    ok "T26 (laboratorio) el espejo: una copia sin version.json recibe igual su commit nuevo y nadie le inventa un número; una con el version.json ilegible no recibe nada (falla)"
  else no "T26 (laboratorio) el espejo: la copia sin version.json salió ${rc} con el número «$(cat "${d}/plain.new" 2> /dev/null)» (esperado [] y un commit más), y la del version.json ilegible salió ${r_broken} (esperado un fallo, sin commit nuevo): $(tail -n 2 "${d}/serve-plain.out" | tr '\n' ' ')"; fi

  # soltar el sello de la última mirada: last_fetch queda en null y el resto del estado, igual
  printf '{\n  "schema": 1,\n  "mode": "managed",\n  "last_fetch": "2030-01-15T10:00:00.000Z",\n  "sources": [\n    {\n      "name": "harness",\n      "commit": "%s"\n    }\n  ]\n}\n' "${sha_a}" > "${d}/state/harness-state.json"
  ( STATE_FILE="${d}/state/harness-state.json"; forget_last_fetch ) > "${d}/forget.out" 2>&1; rc=$?
  v="$(json "${d}/state/harness-state.json" '[d.last_fetch === null, d.schema, d.mode, d.sources[0].name, d.sources[0].commit, Object.keys(d).length].join("|")')"
  ( STATE_FILE="${d}/state/no-such-state.json"; forget_last_fetch ) > /dev/null 2>&1; r_missing=$?
  if [ "${rc}" -eq 0 ] && [ "${v}" = "true|1|managed|harness|${sha_a}|4" ] && [ "${r_missing}" -ne 0 ] && [ "${r_missing}" -ne 127 ]; then
    ok "T26 (laboratorio) soltar el sello de la última mirada deja last_fetch en null y el resto del estado igual; el espejo: sin un estado legible, falla"
  else no "T26 (laboratorio) soltar el sello de la última mirada salió ${rc} y el estado dice «${v:-ilegible}» (esperado true|1|managed|harness|${sha_a}|4); sin estado salió ${r_missing} (esperado un fallo): $(tail -n 2 "${d}/forget.out" | tr '\n' ' ')"; fi

  # el número que el anfitrión le pasa al contenedor: en modo interno el de laboratorio (no lo lee de la copia); en modo
  # público el de la copia; sin version.json no deja nada (adentro sale NO MEDIDO), y uno ilegible es un rojo.
  # (En subshell: el modo es de cada caso, y el rojo del caso ilegible no puede contarse como rojo de esta corrida.)
  # 🔴 rojo previo: «expected_version: command not found» (salida 127 en los cuatro casos).
  version_bytes "2031.02.03.4" > "${d}/served/version.json"
  ( MODE=internal; expected_version "${d}/plain" "${d}/expected-internal.txt" ) > /dev/null 2>&1; rc=$?
  ( MODE=public; expected_version "${d}/served" "${d}/expected-public.txt" ) > /dev/null 2>&1; r_shape=$?
  ( MODE=public; expected_version "${d}/plain" "${d}/expected-plain.txt" ) > /dev/null 2>&1; r_plain=$?
  ( MODE=public; expected_version "${d}/broken" "${d}/expected-broken.txt" ) > /dev/null 2>&1; r_broken=$?
  if [ "${rc}" -eq 0 ] && [ "$(cat "${d}/expected-internal.txt" 2> /dev/null)" = "${LAB_VERSION}" ] \
     && [ "${r_shape}" -eq 0 ] && [ "$(cat "${d}/expected-public.txt" 2> /dev/null)" = "2031.02.03.4" ] \
     && [ "${r_plain}" -eq 0 ] && [ ! -e "${d}/expected-plain.txt" ] && [ "${r_broken}" -eq 1 ] && [ ! -e "${d}/expected-broken.txt" ]; then
    ok "T26 (laboratorio) el número que el contenedor tiene que ver: en modo interno el de laboratorio, en modo público el del version.json de la copia; el espejo: sin el archivo no deja ninguno (adentro sale NO MEDIDO) y uno ilegible es un rojo"
  else no "T26 (laboratorio) el número que el contenedor tiene que ver: modo interno salió ${rc} con «$(cat "${d}/expected-internal.txt" 2> /dev/null)» (esperado ${LAB_VERSION}); modo público, ${r_shape} con «$(cat "${d}/expected-public.txt" 2> /dev/null)» (esperado 2031.02.03.4); sin version.json, ${r_plain} (esperado 0 y ningún archivo); ilegible, ${r_broken} (esperado 1 y ningún archivo)"; fi
}

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
# Docker: imágenes, capas y escenarios (nada de esto corre sin que la prueba mida)
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
BASE_CORE="tycon-clean-machine:base-core"; BASE_BIZUIT="tycon-clean-machine:base-bizuit"   # quedan entre corridas
IMG_CORE="tycon-clean-machine:${RUN_ID}-core"; IMG_UNION="tycon-clean-machine:${RUN_ID}-union"   # se borran al salir
IMG_NOPYTHON="tycon-clean-machine:${RUN_ID}-nopython"; IMG_NONODE="tycon-clean-machine:${RUN_ID}-nonode"
IMG_UNIFIED="tycon-clean-machine:${RUN_ID}-unified"   # el núcleo más un clon del repo unido interno (story 8.18)
KEEP_NAME="tycon-clean-machine-keep"; KEEP_IMAGE="tycon-clean-machine:keep"
FROM_RE='^FROM ([^[:space:]]+@sha256:[0-9a-f]{64})( AS [A-Za-z0-9_-]+)?$'

# docker_cleanup — al salir: los contenedores de ESTA corrida (por su etiqueta) y sus imágenes. Las bases quedan (son
# las que tardan en bajar), y lo que dejó --keep también: su contenedor no lleva la etiqueta, y su imagen tiene otro nombre.
docker_cleanup() {
  local ids
  ids="$(node "${CAPPED}" cleanup 30 -- docker ps -aq --filter "label=${LABEL}" 2>/dev/null)" || ids=""
  # shellcheck disable=SC2086
  [ -z "${ids}" ] || node "${CAPPED}" cleanup 60 -- docker rm -f ${ids} > /dev/null 2>&1 || true
  node "${CAPPED}" cleanup 60 -- docker rmi -f "${IMG_CORE}" "${IMG_UNION}" "${IMG_NOPYTHON}" "${IMG_NONODE}" "${IMG_UNIFIED}" > /dev/null 2>&1 || true
}
# docker_step <paso> <tope> <comando…> — corre el paso; si falla o se cuelga, su línea roja. Devuelve su exit.
docker_step() {
  local name="$1" cap="$2" rc; shift 2
  step "${name}" "${cap}" -- "$@"; rc=$?
  [ "${rc}" -eq 0 ] || step_red "${name}" "${rc}"
  return "${rc}"
}
# pull_step — igual, con UN reintento si falló sin colgarse: bajar una imagen base depende de la red del momento.
# Es el único reintento de toda la prueba.
pull_step() {
  local name="$1" cap="$2" rc; shift 2
  step "${name}" "${cap}" -- "$@"; rc=$?
  if [ "${rc}" -ne 0 ] && [ "${rc}" -ne 124 ]; then
    echo "clean-machine: ${name} falló (exit ${rc}): un reintento"
    step "${name}" "${cap}" -- "$@"; rc=$?
  fi
  [ "${rc}" -eq 0 ] || step_red "${name}" "${rc}"
  return "${rc}"
}
# tally <paso> <exit> <nombre del escenario> — pasa a la salida los veredictos que el escenario imprimió dentro del
# contenedor, y los cuenta. Un escenario que no llegó a su última línea, salió distinto de 0 o venció su tope es un rojo
# del paso: las verificaciones que no llegó a imprimir no pueden desaparecer.
tally() {
  local name="$1" rc="$2" scenario="$3" line ended=0
  while IFS= read -r line; do
    case "${line}" in
      "✅ clean-machine: "*) CM_TOTAL=$((CM_TOTAL + 1)); echo "${line}" ;;
      "❌ clean-machine: "*) CM_TOTAL=$((CM_TOTAL + 1)); CM_FAILS=$((CM_FAILS + 1)); echo "${line}" ;;
      "⏭ clean-machine: NO MEDIDO"*) CM_SKIPPED=$((CM_SKIPPED + 1)); echo "${line}" ;;
      "clean-machine: fin del escenario ${scenario}") ended=1 ;;
    esac
  done < "${STEP_LOG}"
  if [ "${rc}" -ne 0 ]; then step_red "${name}" "${rc}"
  elif [ "${ended}" -ne 1 ]; then
    no "${name} — falló (exit ${rc}): el escenario no llegó a su última línea"; tail -n 30 "${STEP_LOG}" | sed 's/^/     /'
  fi
}
# run_scenario <paso> <tope> <imagen> <con red: yes|no> <guion> <nombre con que cierra> [argumentos…]
# El contenedor no monta nada (ningún `-v`): la copia y los guiones ya están en una capa de la imagen.
run_scenario() {
  local name="$1" cap="$2" image="$3" net="$4" script="$5" closes="$6" container rc; shift 6
  container="tycon-clean-machine-${RUN_ID}-${name#run-}"
  if [ "${net}" = yes ]; then
    # con red: el tope del paso de terceros sube, para no depender de la red del momento (AC 23)
    # TYCON_HARNESS_NODE=0 (story 8.39, decisión 20): la máquina limpia no baja el Node del arnés de nodejs.org
    step "${name}" "${cap}" --container "${container}" -- docker run --rm --name "${container}" --label "${LABEL}" \
      -e TYCON_THIRD_PARTY_NETWORK_BUDGET_S=120 -e TYCON_HARNESS_NODE=0 "${image}" bash "/opt/lab/scenarios/${script}.sh" "$@"; rc=$?
  else
    step "${name}" "${cap}" --container "${container}" -- docker run --rm --name "${container}" --label "${LABEL}" \
      --network none -e TYCON_HARNESS_NODE=0 "${image}" bash "/opt/lab/scenarios/${script}.sh" "$@"; rc=$?
  fi
  tally "${name}" "${rc}" "${closes}"
}

# ── T24, lo que se ve sin correr nada: las bases van fijadas por el digest de su ÍNDICE multi-arquitectura ────
t24_static() {
  local f line n ref refs="" bad="" plats rc
  for f in Dockerfile Dockerfile.bizuit; do
    if [ ! -f "${LAB}/${f}" ]; then bad="${bad} ${f} (no está)"; continue; fi
    n=0
    while IFS= read -r line; do
      case "${line}" in 'FROM ${'*) continue ;; esac            # parte de otra imagen de la prueba: no lleva digest
      if [[ "${line}" =~ ${FROM_RE} ]]; then n=$((n + 1)); [ "${n}" -eq 1 ] && refs="${refs} ${f}=${BASH_REMATCH[1]}"
      else bad="${bad} ${f}: «${line}»"; fi
    done < <(grep -E '^FROM[[:space:]]' "${LAB}/${f}")
    [ "${n}" -gt 0 ] || bad="${bad} ${f} (ningún FROM con digest)"
  done
  if [ -z "${bad}" ]; then ok "T24 los dos Dockerfile fijan su base por digest (FROM <imagen>@sha256:<64 hex>)"
  else no "T24 un FROM sin digest, o un Dockerfile que falta:${bad}"; fi
  if ! node "${CAPPED}" buildx-probe 20 -- docker buildx version > /dev/null 2>&1; then
    skip "T24 el digest es el de un índice con linux/amd64 y linux/arm64: docker buildx no está en esta máquina"; return
  fi
  for ref in ${refs}; do
    f="${ref%%=*}"; ref="${ref#*=}"; n="index-core"; [ "${f}" = Dockerfile.bizuit ] && n="index-bizuit"
    step "${n}" 60 -- docker buildx imagetools inspect --raw "${ref}"; rc=$?
    if [ "${rc}" -ne 0 ]; then step_red "${n}" "${rc}"; continue; fi
    plats="$(node -e '
      let d; try { d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch (e) { console.log("no-es-json"); process.exit(0); }
      const p = (d.manifests || []).map((m) => m.platform && `${m.platform.os}/${m.platform.architecture}`).filter(Boolean);
      console.log(["linux/amd64", "linux/arm64"].every((x) => p.includes(x)) ? "ok" : (p.join(",") || "sin-manifests"));' "${STEP_LOG}")"
    if [ "${plats}" = ok ]; then ok "T24 la base de ${f} va por el digest de su índice: trae linux/amd64 y linux/arm64"
    else no "T24 el digest de ${f} no es el de un índice con linux/amd64 y linux/arm64 (${plats}): ${ref}"; fi
  done
}

# ── las copias ───────────────────────────────────────────────────────────────────────────────────────────────
# ref_of <repo> <pedido> → «sha qué» (el pedido; o origin/main; o HEAD si un checkout superficial no lo trae)
ref_of() {
  local sha
  if [ -n "$2" ]; then sha="$(git -C "$1" rev-parse --verify --quiet "$2^{commit}")" || return 1; echo "${sha} $2"; return 0; fi
  if sha="$(git -C "$1" rev-parse --verify --quiet 'origin/main^{commit}')"; then echo "${sha} origin/main"; return 0; fi
  sha="$(git -C "$1" rev-parse --verify --quiet 'HEAD^{commit}')" || return 1
  echo "${sha} HEAD (este checkout no trae origin/main)"
}
# loose_commit <repo> → el sha de un commit con el árbol de trabajo tal cual (lo no commiteado y lo nuevo, sin lo
# ignorado), colgado de HEAD: sin rama, sin push y sin tocar el índice del repo (el patrón de export-real.test.sh)
loose_commit() {
  local idx="${T}/loose-index" tree
  rm -f "${idx}"
  GIT_INDEX_FILE="${idx}" git -C "$1" read-tree HEAD && GIT_INDEX_FILE="${idx}" git -C "$1" add -A \
    && tree="$(GIT_INDEX_FILE="${idx}" git -C "$1" write-tree)" || { rm -f "${idx}"; return 1; }
  rm -f "${idx}"
  git -C "$1" -c user.name=clean-machine -c user.email=clean-machine@example.com \
    commit-tree "${tree}" -p HEAD -m 'clean-machine: el árbol de trabajo (commit suelto: sin rama, no se pushea)'
}
# export_copy <paquetes> <nombre> <destino> <paso> — exporta a export/<nombre> y lo MUEVE al contexto. El listado
# PRIVADO de reemplazos queda en export/, fuera de todo contexto de docker, y se borra apenas termina la exportación
# (también si falló). La salida estándar del exportador (su --json, que nombra lo reemplazado) no se guarda.
# La copia sale con su `version.json`, estampado con el número de laboratorio (LAB_VERSION): el que publica de verdad
# lo numera la sincronización, que esta prueba no corre.
export_copy() {
  local out="${T}/export/$2" rc
  step "$4" 300 -- bash -c 'exec "$@" > /dev/null' export env TYCON_GUIDES_DIR="${ROOT}" TYCON_SKILLS_DIR="${SK_REPO}" \
    node "${ROOT}/scripts/publishing/export.js" --package "$1" --single-repo --stamp-version "${LAB_VERSION}" --output "${out}" \
    --harness "${HARNESS_SHA}" --agent-skills "${SKILLS_SHA}" --json; rc=$?
  rm -f "${out}.reemplazos.md"
  if [ "${rc}" -ne 0 ]; then step_red "$4" "${rc}"; return 1; fi
  if [ ! -d "${out}/.git" ]; then no "$4 — falló (exit 0): el exportador no dejó un repo en ${out}"; return 1; fi
  mv "${out}" "$3" && git -C "$3" checkout -q -B main || { no "$4 — falló (exit 0): no pude dejar la copia en $3 con una rama main"; return 1; }
}
# second_source <repo del arnés> <repo de las skills> <sha del arnés> → «sha qué» de la segunda fuente (agent-skills); si no
# puede, una línea con el motivo y 1.
# Desde la unión de los dos repos internos (story 8.18) el commit del arnés puede ser el del repo UNIDO (su árbol trae
# skills/tycon-pipeline y agents/, el criterio del exportador): ahí las dos fuentes salen de un solo repo y del MISMO
# commit, y el exportador sale 2 si se le pasan dos distintos. Antes acá se tomaba `origin/main` del repo de las skills
# —que en el repo unido es el mismo repo, en OTRO commit que el árbol de trabajo bajo prueba—. Con dos repos físicos,
# lo de siempre: `origin/main` de agent-skills, el commit pedido, o su árbol de trabajo (`worktree`).
second_source() {
  local names sha
  names="$(git -C "$1" ls-tree -d --name-only "$3^{tree}" -- skills/tycon-pipeline agents)" \
    || { echo "no pude leer el árbol del commit del arnés ($3) en $1"; return 1; }
  if [ "$(printf '%s\n' "${names}" | grep -c -x -e skills/tycon-pipeline -e agents)" = 2 ]; then
    case "${TYCON_CLEAN_MACHINE_SKILLS_REF:-}" in
      '') ;;
      worktree)
        [ -z "${TYCON_CLEAN_MACHINE_HARNESS_REF:-}" ] || { echo "en el repo unido las dos fuentes salen del mismo commit: TYCON_CLEAN_MACHINE_SKILLS_REF=worktree no va con un commit pedido para el arnés (${TYCON_CLEAN_MACHINE_HARNESS_REF}) — sacá una de las dos variables"; return 1; } ;;
      *)
        sha="$(git -C "$1" rev-parse --verify --quiet "${TYCON_CLEAN_MACHINE_SKILLS_REF}^{commit}")" || { echo "no encuentro el commit pedido de agent-skills (${TYCON_CLEAN_MACHINE_SKILLS_REF}) en el repo unido"; return 1; }
        [ "${sha}" = "$3" ] || { echo "en el repo unido las dos fuentes salen del mismo commit: TYCON_CLEAN_MACHINE_SKILLS_REF es ${sha} y el arnés está en $3 — sacá la variable"; return 1; } ;;
    esac
    echo "$3 el mismo commit que el arnés (repo unido)"; return 0
  fi
  if [ "${TYCON_CLEAN_MACHINE_SKILLS_REF:-}" = worktree ]; then
    sha="$(loose_commit "$2")" || { echo "no pude armar el commit suelto del árbol de trabajo de agent-skills ($2)"; return 1; }
    echo "${sha} el árbol de trabajo (commit suelto)"; return 0
  fi
  ref_of "$2" "${TYCON_CLEAN_MACHINE_SKILLS_REF:-}" || { echo "no encuentro el commit pedido de agent-skills (${TYCON_CLEAN_MACHINE_SKILLS_REF:-origin/main})"; return 1; }
}
internal_copies() { # <contexto del núcleo> <contexto de la unión>
  local harness skills sha
  if [ -n "${TYCON_CLEAN_MACHINE_HARNESS_REF:-}" ]; then
    harness="$(ref_of "${ROOT}" "${TYCON_CLEAN_MACHINE_HARNESS_REF}")" || { no "modo interno: no encuentro el commit pedido del arnés (${TYCON_CLEAN_MACHINE_HARNESS_REF})"; return 1; }
  else
    sha="$(loose_commit "${ROOT}")" || { no "modo interno: no pude armar el commit suelto del árbol de trabajo del arnés (${ROOT})"; return 1; }
    harness="${sha} el árbol de trabajo (commit suelto)"
  fi
  skills="$(second_source "${ROOT}" "${SK_REPO}" "${harness%% *}")" || { no "modo interno: ${skills}"; return 1; }
  HARNESS_SHA="${harness%% *}"; SKILLS_SHA="${skills%% *}"
  echo "clean-machine: modo interno · arnés ${HARNESS_SHA} (${harness#* }) · agent-skills ${SKILLS_SHA} (${skills#* }) · base ${T}"
  export_copy core core "$1/copy" export-core || return 1
  if [ "${KEEP}" -eq 0 ]; then export_copy core,bizuit union "$2/copy" export-union || return 1; fi
}
public_copy() { # <contexto> — un clon de SOURCE con una rama `main` (un checkout de pull request es un merge suelto)
  if [ -n "$(git -C "${SOURCE}" status --porcelain 2> /dev/null)" ]; then
    echo "clean-machine: aviso — ${SOURCE} tiene cambios sin commitear: no entran a la copia (se mide lo commiteado)"
  fi
  if git clone -q "${SOURCE}" "$1/copy" 2> "${T}/out/clone-source.err" && git -C "$1/copy" checkout -q -B main 2>> "${T}/out/clone-source.err"; then
    echo "clean-machine: modo público · ${SOURCE} en $(git -C "$1/copy" rev-parse --short HEAD) · base ${T}"
  else
    no "modo público: no pude clonar ${SOURCE} con una rama main: $(tail -n 2 "${T}/out/clone-source.err" | tr '\n' ' ')"; return 1
  fi
}
# prepare_lab <contexto> — lo que corre adentro: los bloques de la portada DE ESA COPIA, los guiones y los ejemplos
prepare_lab() {
  local lab="$1/lab" why
  mkdir -p "${lab}/blocks" && cp -R "${LAB}/scenarios" "${lab}/scenarios" && cp "${LAB}/lib.sh" "${LAB}/plugin-story-1.1.md.tpl" "${lab}/" \
    && cp -R "${ROOT}/scripts/tests/fixtures/example-repo" "${lab}/example-repo" \
    || { no "no pude armar lo que corre adentro del contenedor en ${lab}"; return 1; }
  why="$(read_cover "$1/copy/getting-started/reference.md" "${lab}/blocks")" || { no "T24 la referencia de la copia no se puede leer: ${why}"; return 1; }
  expected_version "$1/copy" "${lab}/blocks/stamped-version.txt"
}
# expected_version <copia> <archivo> — deja en el archivo el número que `harness.js version` tiene que dar adentro. En
# modo interno, el de laboratorio con que se estampó la copia (no se lee de la copia: si el exportador no lo puso, es un
# rojo adentro). En modo público la copia ya viene armada: el de su version.json; si el árbol no lo trae, no deja el
# archivo y adentro esa verificación sale NO MEDIDO con su motivo (nunca verde sin medir). Uno ilegible es un rojo.
expected_version() {
  local v rc
  if [ "${MODE}" = internal ]; then printf '%s\n' "${LAB_VERSION}" > "$2"; return 0; fi
  v="$(stamped_version_of "$1")"; rc=$?
  case "${rc}" in
    0) printf '%s\n' "${v}" > "$2" ;;
    1) echo "clean-machine: aviso — la copia no trae version.json: «harness.js version da la estampada» va a salir NO MEDIDO" ;;
    *) no "T26 el version.json de la copia no se puede leer, o su número no tiene la forma AAAA.MM.DD.N"; return 1 ;;
  esac
}

# ── la máquina nueva del equipo: un clon del repo unido interno, sin red (story 8.18, AC 36 · T37 y T39) ─────
# unified_copy <contexto> — la copia del escenario `unified`: el repo unido INTERNO tal como lo baja una máquina nueva
# —todo lo alcanzable desde el commit, y nada más: de esa historia salen las skills de terceros—, parado en un commit
# SUELTO con el árbol de trabajo bajo prueba (TYCON_CLEAN_MACHINE_HARNESS_REF lo cambia). No pasa por el exportador. Se
# baja con `git fetch <sha>`: un clon local a secas enlazaría los objetos del repo de origen (y sus «alternates»), que
# adentro del contenedor no existen. El `--upload-pack` deja pedir un commit que ninguna rama nombra, sin tocar la
# configuración del repo bajo prueba.
unified_copy() {
  local sha what rc
  if [ -n "${TYCON_CLEAN_MACHINE_HARNESS_REF:-}" ]; then
    what="$(ref_of "${ROOT}" "${TYCON_CLEAN_MACHINE_HARNESS_REF}")" || { no "T37 (unified) no encuentro el commit pedido (${TYCON_CLEAN_MACHINE_HARNESS_REF})"; return 1; }
    sha="${what%% *}"; what="${what#* }"
  else
    sha="$(loose_commit "${ROOT}")" || { no "T37 (unified) no pude armar el commit suelto del árbol de trabajo (${ROOT})"; return 1; }
    what="el árbol de trabajo (commit suelto)"
  fi
  echo "clean-machine: escenario unified · el repo unido interno en ${sha} (${what}) · base ${T}"
  mkdir -p "$1/copy" && lab_git -C "$1/copy" init -q -b main || { no "T37 (unified) no pude crear el repo de la copia en $1/copy"; return 1; }
  step clone-unified 300 -- env GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 \
    git -C "$1/copy" fetch -q --upload-pack 'git -c uploadpack.allowAnySHA1InWant=true upload-pack' "${ROOT}" "${sha}"; rc=$?
  if [ "${rc}" -ne 0 ]; then step_red clone-unified "${rc}"; return 1; fi
  lab_git -C "$1/copy" checkout -q -B main FETCH_HEAD || { no "T37 (unified) no pude dejar la copia en $1/copy parada en ${sha:0:12}"; return 1; }
}
# internal_block <INSTALL.md> <archivo> — deja en el archivo el bloque `<!-- install:internal -->` (su valla ```bash), y
# comprueba que sea lo que el alta promete: UN `git clone` con el marcador de la URL y `harness.js install`, sin enlaces
# a mano ni el aplicador suelto. Si no, dice qué (stdout) y devuelve 1.
internal_block() {
  local n
  cover_block "$1" install:internal bash > "$2" || { echo 'falta el bloque <!-- install:internal --> con su valla ```bash y su cierre'; return 1; }
  n="$(grep -c -E '^[[:space:]]*git clone ' "$2" || true)"
  [ "${n}" = 1 ] || { echo "el bloque trae ${n} líneas de «git clone» (tiene que ser una)"; return 1; }
  grep -q -E '^[[:space:]]*git clone <URL [^>]+> [^[:space:]]+' "$2" || { echo 'el «git clone» del bloque no lleva el marcador <URL …> y la carpeta de destino'; return 1; }
  grep -q -E '^[[:space:]]*node [^[:space:]]+/scripts/setup/harness\.js install[[:space:]]*$' "$2" || { echo 'el bloque no corre «node <clon>/scripts/setup/harness.js install»'; return 1; }
  if grep -q -E 'ln -s|install-tycon-hooks|agent-skills' "$2"; then echo 'el bloque crea un enlace a mano, llama al aplicador suelto o nombra agent-skills'; return 1; fi
}
# unified_selfcheck — la lectura del bloque de INSTALL.md, probada sin docker (corre con T34, en toda máquina), contra
# el INSTALL.md real y contra papeles mal formados que TIENEN que rechazarse (el espejo). En un árbol que no trae el
# bloque (la copia pública: el alta del equipo no sale) no hay qué leer: NO MEDIDO.
unified_selfcheck() {
  local d="${T}/unified-papers" why rejected=0 total=3
  mkdir -p "${d}"
  if [ ! -f "${ROOT}/INSTALL.md" ] || ! grep -q -x -F '<!-- install:internal -->' "${ROOT}/INSTALL.md"; then
    skip "T39 (papeles) el bloque <!-- install:internal --> de INSTALL.md: este árbol no lo trae (la copia pública no lleva el alta del equipo)"; return
  fi
  if why="$(internal_block "${ROOT}/INSTALL.md" "${d}/install-internal.sh")"; then
    ok "T39 (papeles) el bloque <!-- install:internal --> de INSTALL.md se lee, y es UN git clone y harness.js install ($(grep -c . "${d}/install-internal.sh") líneas)"
  else no "T39 (papeles) el bloque <!-- install:internal --> de INSTALL.md: ${why}"; fi
  # el espejo · sin el cierre del bloque, con un segundo clon (el repo viejo), o con un enlace a mano: rojo
  grep -v -x -F '<!-- /install:internal -->' "${ROOT}/INSTALL.md" > "${d}/no-close.md"
  internal_block "${d}/no-close.md" "${d}/bad.sh" > /dev/null || rejected=$((rejected + 1))
  awk '{ print } /^git clone <URL / && !done { print "git clone <URL de agent-skills> ~/.claude/agent-skills"; done = 1 }' "${ROOT}/INSTALL.md" > "${d}/two-clones.md"
  internal_block "${d}/two-clones.md" "${d}/bad.sh" > /dev/null || rejected=$((rejected + 1))
  awk '{ print } /scripts\/setup\/harness\.js install$/ && !done { print "ln -s ~/.claude/agent-skills/agents ~/.claude/agents"; done = 1 }' "${ROOT}/INSTALL.md" > "${d}/hand-link.md"
  internal_block "${d}/hand-link.md" "${d}/bad.sh" > /dev/null || rejected=$((rejected + 1))
  if [ "${rejected}" -eq "${total}" ]; then ok "T39 (papeles) el espejo: un INSTALL.md sin el cierre del bloque, con un segundo clon o con un enlace a mano se rechaza"
  else no "T39 (papeles) el espejo: sólo ${rejected} de ${total} papeles mal formados se rechazan"; fi
}
# unified_scenario — arma la copia, la imagen (el núcleo más la copia) y corre el escenario sin red
unified_scenario() {
  local ctx="${T}/ctx-unified" lab why
  lab="${ctx}/lab"
  mkdir -p "${ctx}" "${lab}/blocks"
  unified_copy "${ctx}" || return 0
  if ! { cp -R "${LAB}/scenarios" "${lab}/scenarios" && cp "${LAB}/lib.sh" "${lab}/"; }; then
    no "T37 (unified) no pude armar lo que corre adentro del contenedor en ${lab}"; return 0
  fi
  if ! why="$(internal_block "${ctx}/copy/INSTALL.md" "${lab}/blocks/install-internal.sh")"; then
    no "T39 el INSTALL.md de la copia: ${why}"; return 0
  fi
  if ! docker_step build-src-unified 300 docker build -t "${IMG_UNIFIED}" --build-arg "BASE=${BASE_CORE}" -f "${LAB}/Dockerfile.copy" "${ctx}"; then
    skip "el escenario unified: no hay imagen del núcleo con el clon del repo unido (ver build-src-unified)"; return 0
  fi
  run_scenario run-unified 600 "${IMG_UNIFIED}" no unified unified
}

# ── --keep: el contenedor para la corrida con modelo (decisión C19) ──────────────────────────────────────────
keep_container() {
  local rc
  step keep-remove 60 -- docker rm -f "${KEEP_NAME}" || true       # el de una corrida anterior, si quedó
  docker_step keep-tag 60 docker tag "${IMG_CORE}" "${KEEP_IMAGE}" || return 1
  docker_step keep-start 60 docker run -d --name "${KEEP_NAME}" "${KEEP_IMAGE}" sleep infinity || return 1
  step keep-install 600 --container "${KEEP_NAME}" -- docker exec -e TYCON_THIRD_PARTY_NETWORK_BUDGET_S=120 -e TYCON_HARNESS_NODE=0 "${KEEP_NAME}" \
    bash -c '. /opt/lab/lib.sh && scenario_begin keep && serve_copy && run_block unattended "${OUT_DIR}/install.out" < /dev/null && make_example_repo "${WORK_DIR}/example-repo"'; rc=$?
  if [ "${rc}" -ne 0 ]; then
    step_red keep-install "${rc}"
    node "${CAPPED}" cleanup 60 -- docker rm -f "${KEEP_NAME}" > /dev/null 2>&1 || true
    return 1
  fi
  cat <<EOF
clean-machine: --keep · el contenedor ${KEEP_NAME} quedó vivo: el arnés instalado con el bloque de la portada y el repo
de ejemplo en /work/example-repo (rama story/1.1). No trae Claude Code ni credenciales: viven en el contenedor y se van con él.
  docker exec -it ${KEEP_NAME} bash
  npm config set prefix "\$HOME/.npm-global" && npm install -g @anthropic-ai/claude-code
  export PATH="\$HOME/.npm-global/bin:\$PATH" && cd /work/example-repo && claude
  # login con la suscripción (enlace y código); nunca una llave. Pedir: «implementemos la story 1.1»
  docker rm -f ${KEEP_NAME} && docker rmi ${KEEP_IMAGE}
EOF
}

# ── la corrida ───────────────────────────────────────────────────────────────────────────────────────────────
main() {
  local ctx_core="${T}/ctx-core" ctx_union="${T}/ctx-union" empty="${T}/ctx-empty" left
  mkdir -p "${T}/export" "${ctx_core}" "${ctx_union}" "${empty}"

  # --only unified: sólo la máquina nueva del equipo (story 8.18). La imagen del núcleo y el clon del repo unido; ninguna
  # exportación, ningún otro escenario.
  if [ "${ONLY}" = unified ]; then
    if ! pull_step build-core 600 docker build -t "${BASE_CORE}" -f "${LAB}/Dockerfile" "${empty}"; then
      skip "el escenario unified: no hay imagen del núcleo (ver build-core)"; return 0
    fi
    unified_scenario; return 0
  fi

  [ "${KEEP}" -eq 1 ] || t24_static

  if [ "${MODE}" = internal ]; then internal_copies "${ctx_core}" "${ctx_union}" || return 0
  else public_copy "${ctx_union}" || return 0; ctx_core="${ctx_union}"; fi
  prepare_lab "${ctx_core}" || return 0
  if [ "${ctx_union}" != "${ctx_core}" ] && [ "${KEEP}" -eq 0 ]; then prepare_lab "${ctx_union}" || return 0; fi

  # antes del primer `docker build`: ningún listado privado puede quedar bajo la carpeta de trabajo
  left="$(find "${T}" -name '*.reemplazos.md' -print)"
  if [ -n "${left}" ]; then
    no "queda un listado privado de reemplazos bajo la carpeta de trabajo: no construyo ninguna imagen ($(echo "${left}" | tr '\n' ' '))"
    return 0
  fi

  # el núcleo: la base (sólo requisitos) y la capa de la copia, con su dueño
  if ! pull_step build-core 600 docker build -t "${BASE_CORE}" -f "${LAB}/Dockerfile" "${empty}"; then
    skip "los escenarios (core, folders, sin red, sin python3, sin node, union): no hay imagen del núcleo (ver build-core)"; return 0
  fi
  if ! docker_step build-src-core 300 docker build -t "${IMG_CORE}" --build-arg "BASE=${BASE_CORE}" -f "${LAB}/Dockerfile.copy" "${ctx_core}"; then
    skip "los escenarios (core, folders, sin red, sin python3, sin node, union): no hay imagen del núcleo con la copia (ver build-src-core)"; return 0
  fi
  if [ "${KEEP}" -eq 1 ]; then keep_container; return 0; fi

  run_scenario run-core 600 "${IMG_CORE}" yes core core "${MODE}"
  run_scenario run-folders 600 "${IMG_CORE}" yes folders folders
  run_scenario run-no-network 600 "${IMG_CORE}" no no-network no-network
  # el instalador del paquete de npm (story 8.40, el cierre: T46), sin red: el GitHub de juguete corre adentro
  run_scenario run-npx 600 "${IMG_CORE}" no npx npx

  # las dos derivadas de la AC 24: la del núcleo con la copia, menos una herramienta (un Dockerfile en línea, no un archivo)
  printf 'ARG BASE\nFROM ${BASE}\nUSER root\nRUN rm -f /usr/bin/python3*\nUSER node\n' > "${T}/nopython.Dockerfile"
  if docker_step build-nopython 300 docker build -t "${IMG_NOPYTHON}" --build-arg "BASE=${IMG_CORE}" -f "${T}/nopython.Dockerfile" "${empty}"; then
    run_scenario run-nopython 600 "${IMG_NOPYTHON}" no missing-tool sin-python3 python3
  else skip "T31 sin python3: no hay imagen derivada (ver build-nopython)"; fi
  printf 'ARG BASE\nFROM ${BASE}\nUSER root\nRUN rm -f /usr/local/bin/node\nUSER node\n' > "${T}/nonode.Dockerfile"
  if docker_step build-nonode 300 docker build -t "${IMG_NONODE}" --build-arg "BASE=${IMG_CORE}" -f "${T}/nonode.Dockerfile" "${empty}"; then
    run_scenario run-nonode 600 "${IMG_NONODE}" no missing-tool sin-node node
  else skip "T31 sin node: no hay imagen derivada (ver build-nonode)"; fi

  # el paquete del stack: la del núcleo más el SDK de .NET, y la copia con el paquete
  if pull_step build-bizuit 900 docker build -t "${BASE_BIZUIT}" --build-arg "CORE_IMAGE=${BASE_CORE}" -f "${LAB}/Dockerfile.bizuit" "${empty}" \
     && docker_step build-src-union 300 docker build -t "${IMG_UNION}" --build-arg "BASE=${BASE_BIZUIT}" -f "${LAB}/Dockerfile.copy" "${ctx_union}"; then
    run_scenario run-union 900 "${IMG_UNION}" yes union union
  else skip "T28: no hay imagen del paquete con la copia (ver build-bizuit y build-src-union)"; fi

  # la máquina nueva del equipo (story 8.18): un clon del repo unido interno, sin red. En modo público no hay repo
  # interno del que clonar (ni el bloque del alta del equipo en INSTALL.md).
  if [ "${MODE}" = internal ]; then unified_scenario
  else skip "T37 y T39 (story 8.18) la máquina nueva del equipo: sólo en modo interno (la copia pública no lleva el alta del equipo)"; fi
}

# lab_git — git para los repos de laboratorio que esta prueba ARMA (no para el repo del arnés): sin la configuración
# global ni la del sistema de quien corre. Con ellas, una máquina con firma de commits obligatoria o con hooks globales
# daba rojo, o quedaba esperando una contraseña (pase adversarial de la tanda C).
lab_git() {
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    git -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name=lab -c user.email=lab@example.com "$@"
}
# fake_public_repo <carpeta> — un repo público de mentira (skills/, agents/, la portada) con un commit
fake_public_repo() {
  mkdir -p "$1/skills" "$1/agents" "$1/getting-started" && printf '# portada de mentira\n' > "$1/README.md" \
    && printf '# referencia de mentira\n' > "$1/getting-started/reference.md" \
    && lab_git -C "$1" init -q && lab_git -C "$1" add -A && lab_git -C "$1" commit -q -m lab
}

# ── compuerta 2 · T34: cuándo no mide (sin docker; se llama a sí misma con INNER=1 para no repetirse) ─────────
t34() {
  local d="${T}/t34" out rc t
  mkdir -p "${d}/bin" "${d}/fake"
  # el PATH armado con enlaces: todo lo del PATH de quien corre menos `docker` (el patrón de portable-suites.test.sh)
  node -e '
    const fs = require("fs"); const path = require("path");
    const [bin, ...skip] = process.argv.slice(1);
    for (const dir of String(process.env.PATH || "").split(":")) {
      let names; try { names = fs.readdirSync(dir); } catch (_) { continue; }
      for (const n of names) {
        if (skip.includes(n)) continue;
        try { fs.symlinkSync(path.join(dir, n), path.join(bin, n)); } catch (_) { /* ya está: gana el primero del PATH */ }
      }
    }' "${d}/bin" docker || { no "T34 no pude armar el PATH con enlaces"; return; }
  if PATH="${d}/bin" command -v docker >/dev/null 2>&1; then no "T34 docker sigue en el PATH armado: la medición no vale"; return; fi
  for t in bash node git; do
    PATH="${d}/bin" command -v "${t}" >/dev/null 2>&1 || { no "T34 no quedó ${t} en el PATH armado"; return; }
  done
  # el docker de mentira que no termina nunca, y un repo público de mentira: con él, el caso 4 llega a `docker-probe`
  # en toda máquina (la copia pública no trae el exportador; la de un dev puede no tener agent-skills)
  printf '#!/bin/sh\nexec sleep 600\n' > "${d}/fake/docker"; chmod +x "${d}/fake/docker"
  fake_public_repo "${d}/source" > "${d}/source.out" 2>&1 || { no "T34 no pude armar el repo público de mentira: $(tail -n 2 "${d}/source.out" | tr '\n' ' ')"; return; }
  # el laboratorio no depende de la configuración de git de quien corre: con una global hostil (firma de commits
  # obligatoria con un programa que falla, y un pre-commit global que rechaza todo) se arma igual. El espejo: con git
  # a secas esa misma configuración SÍ rompe el commit (si no, este caso no mediría nada).
  mkdir -p "${d}/hostile-hooks" "${d}/plain"
  printf '#!/bin/sh\nexit 1\n' > "${d}/hostile-hooks/pre-commit"; chmod +x "${d}/hostile-hooks/pre-commit"
  printf '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n[core]\n\thooksPath = %s\n' "${d}/hostile-hooks" > "${d}/hostile.gitconfig"
  if ( export GIT_CONFIG_GLOBAL="${d}/hostile.gitconfig"; fake_public_repo "${d}/source-hostile" ) > "${d}/hostile.out" 2>&1 \
     && ! ( export GIT_CONFIG_GLOBAL="${d}/hostile.gitconfig"; git -C "${d}/plain" init -q \
            && git -C "${d}/plain" -c user.name=lab -c user.email=lab@example.com commit -q --allow-empty -m lab ) > "${d}/plain.out" 2>&1; then
    ok "T34 el repo de laboratorio se arma aunque la configuración global de git de quien corre firme commits o traiga hooks (y con git a secas esa configuración sí lo rompe)"
  else no "T34 el repo de laboratorio depende de la configuración global de git de quien corre: $(tail -n 2 "${d}/hostile.out" | tr '\n' ' ')"; fi
  # inner <salida> <PATH> [VAR=valor…] — esta misma prueba, con INNER=1 y sin nada del ambiente de quien corre
  inner() {
    local o="$1" p="$2"; shift 2
    env -u TYCON_CLEAN_MACHINE -u TF_BUILD -u BUILD_REASON -u TYCON_CLEAN_MACHINE_SOURCE -u TYCON_CLEAN_MACHINE_CAP_S \
      -u TYCON_CLEAN_MACHINE_BUDGET_S -u TYCON_CLEAN_MACHINE_HARNESS_REF -u TYCON_CLEAN_MACHINE_SKILLS_REF \
      PATH="${p}" TYCON_CLEAN_MACHINE_INNER=1 "$@" bash "${SELF}" > "${o}" 2>&1
  }
  greens() { grep -c '^✅' "$1" || true; }

  out="${d}/case1.out"; inner "${out}" "${d}/bin" TYCON_CLEAN_MACHINE=1; rc=$?
  if [ "${rc}" -eq 1 ] && grep -q '^⏭ clean-machine: NO MEDIDO — .*docker' "${out}" && [ "$(greens "${out}")" = 0 ]; then
    ok "T34 pedida y sin docker en el PATH: NO MEDIDO con su motivo, ningún ✅, salida 1"
  else no "T34 pedida y sin docker en el PATH: salida ${rc}, $(greens "${out}") ✅ — $(tail -n 2 "${out}" | tr '\n' ' ')"; fi

  out="${d}/case2.out"; inner "${out}" "${d}/bin"; rc=$?
  if [ "${rc}" -eq 0 ] && grep -q '^⏭ clean-machine: NO MEDIDO — ' "${out}" && [ "$(greens "${out}")" = 0 ]; then
    ok "T34 sin la variable y fuera del nocturno: NO MEDIDO con su motivo, ningún ✅, salida 0"
  else no "T34 sin la variable y fuera del nocturno: salida ${rc}, $(greens "${out}") ✅ — $(tail -n 2 "${out}" | tr '\n' ' ')"; fi

  # corrida dentro del árbol de MANTENIMIENTO adelgazado (el banco del privado, con el público encima), el motivo es el de
  # mantenimiento con cualquier BUILD_REASON (story 2.21, AC 5); en cualquier otro árbol, el del control de cada cambio.
  # (`maintenance_tree` se define más abajo: acá se lee el archivo directo, con la misma regla)
  why3='BUILD_REASON=PullRequest'
  if [ -f "${ROOT}/.tycon/internal-forms.json" ] && node -e 'try { process.exit(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).layout === "thin" ? 0 : 1); } catch (_) { process.exit(1); }' "${ROOT}/.tycon/internal-forms.json"; then why3='AC 36'; fi
  out="${d}/case3.out"; inner "${out}" "${d}/bin" TF_BUILD=True BUILD_REASON=PullRequest; rc=$?
  if [ "${rc}" -eq 0 ] && grep -q "^⏭ clean-machine: NO MEDIDO — .*${why3}" "${out}" && [ "$(greens "${out}")" = 0 ]; then
    ok "T34 en el control de cada cambio (TF_BUILD y BUILD_REASON=PullRequest): NO MEDIDO con su motivo, ningún ✅, salida 0"
  else no "T34 en el control de cada cambio: salida ${rc}, $(greens "${out}") ✅ — $(tail -n 2 "${out}" | tr '\n' ' ')"; fi

  # TYCON_CLEAN_MACHINE=0 gana también en el nocturno: quien corre pidió no medir, y se dice
  out="${d}/case0.out"; inner "${out}" "${d}/bin" TYCON_CLEAN_MACHINE=0 TF_BUILD=True BUILD_REASON=Schedule; rc=$?
  if [ "${rc}" -eq 0 ] && grep -q '^⏭ clean-machine: NO MEDIDO — TYCON_CLEAN_MACHINE=0' "${out}" && [ "$(greens "${out}")" = 0 ]; then
    ok "T34 con TYCON_CLEAN_MACHINE=0 no mide ni en el nocturno: NO MEDIDO con su motivo, ningún ✅, salida 0"
  else no "T34 con TYCON_CLEAN_MACHINE=0 en el nocturno: salida ${rc}, $(greens "${out}") ✅ — $(tail -n 2 "${out}" | tr '\n' ' ')"; fi

  # el árbol del repo de mantenimiento adelgazado (story 8.26, AC 36): esta misma prueba, copiada a una raíz cuyo
  # `.tycon/internal-forms.json` dice `layout: thin`. En el nocturno no arma ninguna copia: NO MEDIDO con el motivo,
  # salida 0. Pedida a mano (con un docker de mentira en el PATH, para llegar a la elección del modo): salida 1, mismo
  # motivo. El espejo: con TYCON_CLEAN_MACHINE_SOURCE puesta ya no es «el árbol de mantenimiento» y sigue de largo
  # (sin docker, hasta su propio NO MEDIDO por docker).
  mkdir -p "${d}/thin/scripts/tests" "${d}/thin/.tycon" "${d}/thin-bin"
  cp "${SELF}" "${d}/thin/scripts/tests/clean-machine.test.sh" && cp -R "${LAB}" "${d}/thin/scripts/tests/clean-machine" \
    && printf '{ "layout": "thin" }\n' > "${d}/thin/.tycon/internal-forms.json" \
    && cp -R "${d}/bin/." "${d}/thin-bin/" && cp "${d}/fake/docker" "${d}/thin-bin/docker" \
    || { no "T34 (mantenimiento) no pude armar la raíz adelgazada de juguete"; return; }
  thin_inner() {
    local o="$1" p="$2"; shift 2
    env -u TYCON_CLEAN_MACHINE -u TF_BUILD -u BUILD_REASON -u TYCON_CLEAN_MACHINE_SOURCE -u TYCON_CLEAN_MACHINE_CAP_S \
      -u TYCON_CLEAN_MACHINE_BUDGET_S -u TYCON_CLEAN_MACHINE_HARNESS_REF -u TYCON_CLEAN_MACHINE_SKILLS_REF \
      PATH="${p}" TYCON_CLEAN_MACHINE_INNER=1 "$@" bash "${d}/thin/scripts/tests/clean-machine.test.sh" > "${o}" 2>&1
  }
  out="${d}/case-thin.out"; thin_inner "${out}" "${d}/bin" TF_BUILD=True BUILD_REASON=Schedule; rc=$?
  if [ "${rc}" -eq 0 ] && grep -q '^⏭ clean-machine: NO MEDIDO — .*AC 36' "${out}" && [ "$(greens "${out}")" = 0 ]; then
    ok "T34 (mantenimiento) el nocturno del árbol de mantenimiento no arma la copia: NO MEDIDO con su motivo (AC 36), ningún ✅, salida 0"
  else no "T34 (mantenimiento) el nocturno del árbol de mantenimiento: salida ${rc}, $(greens "${out}") ✅ — $(tail -n 2 "${out}" | tr '\n' ' ')"; fi
  out="${d}/case-thin-asked.out"; thin_inner "${out}" "${d}/thin-bin" TYCON_CLEAN_MACHINE=1; rc=$?
  if [ "${rc}" -eq 1 ] && grep -q 'NO MEDIDO — .*AC 36' "${out}" && [ "$(greens "${out}")" = 0 ]; then
    ok "T34 (mantenimiento) pedida a mano en el árbol de mantenimiento: no arma nada, dice cómo medir, salida 1"
  else no "T34 (mantenimiento) pedida a mano en el árbol de mantenimiento: salida ${rc}, $(greens "${out}") ✅ — $(tail -n 2 "${out}" | tr '\n' ' ')"; fi
  out="${d}/case-thin-source.out"; thin_inner "${out}" "${d}/bin" TF_BUILD=True BUILD_REASON=Schedule TYCON_CLEAN_MACHINE_SOURCE="${d}/source"; rc=$?
  if [ "${rc}" -eq 1 ] && ! grep -q 'AC 36' "${out}" && grep -q 'NO MEDIDO — .*docker' "${out}"; then
    ok "T34 (mantenimiento) el espejo: con TYCON_CLEAN_MACHINE_SOURCE el árbol de mantenimiento sí mide (acá, sin docker, hasta su NO MEDIDO por docker)"
  else no "T34 (mantenimiento) el espejo con TYCON_CLEAN_MACHINE_SOURCE: salida ${rc} — $(tail -n 2 "${out}" | tr '\n' ' ')"; fi
  # story 2.21 (AC 5, R1 de su revisión): en Azure el árbol de mantenimiento no la mide con NINGÚN motivo de la corrida.
  # La corrida a mano del banco (BUILD_REASON=Manual) la llevaba roja cuando su parámetro pedía medirla
  # (TYCON_CLEAN_MACHINE=1), y sin pedirla salía NO MEDIDO con el motivo de otro caso. Las dos, con el de mantenimiento.
  for asked in "" "TYCON_CLEAN_MACHINE=1"; do
    out="${d}/case-thin-manual${asked:+-asked}.out"
    # shellcheck disable=SC2086 # ${asked} vacío no es un argumento
    thin_inner "${out}" "${d}/thin-bin" TF_BUILD=True BUILD_REASON=Manual ${asked}; rc=$?
    if [ "${rc}" -eq 0 ] && tail -n 1 "${out}" | grep '^⏭ clean-machine: NO MEDIDO — .*AC 36' >/dev/null && [ "$(greens "${out}")" = 0 ]; then
      ok "T34 Mantenimiento_PedidaAMano_NoMedido @story-2.21 @ac-5 (BUILD_REASON=Manual${asked:+, ${asked}}): NO MEDIDO con el motivo de mantenimiento como última línea, ningún ✅, salida 0"
    else no "T34 Mantenimiento_PedidaAMano_NoMedido (BUILD_REASON=Manual${asked:+, ${asked}}): salida ${rc}, $(greens "${out}") ✅ — $(tail -n 2 "${out}" | tr '\n' ' ')"; fi
  done

  out="${d}/case4.out"; t="${SECONDS}"
  inner "${out}" "${d}/fake:${d}/bin" TYCON_CLEAN_MACHINE=1 TYCON_CLEAN_MACHINE_CAP_S=2 TYCON_CLEAN_MACHINE_SOURCE="${d}/source"; rc=$?
  t=$((SECONDS - t))
  if [ "${rc}" -eq 1 ] && grep -q '^❌ clean-machine: docker-probe — se colgó: pasó el tope de 2 s' "${out}" && [ "${t}" -lt 15 ] && [ "$(greens "${out}")" = 0 ]; then
    ok "T34 un docker que no termina: rojo por tope que nombra docker-probe, salida 1, en ${t} s (menos de 15)"
  else no "T34 un docker que no termina: salida ${rc} en ${t} s, $(greens "${out}") ✅ — $(tail -n 2 "${out}" | tr '\n' ' ')"; fi

  # el espejo del tope: un paso que termina a tiempo sale con SU código (un envoltorio que cortara todo también está roto)
  node "${CAPPED}" mirror 10 -- sh -c 'exit 0' > "${d}/mirror0.out" 2>&1; rc=$?
  node "${CAPPED}" mirror 10 -- sh -c 'echo dicho; exit 3' > "${d}/mirror3.out" 2>&1; t=$?
  if [ "${rc}" -eq 0 ] && [ "${t}" -eq 3 ] && grep -q '^dicho$' "${d}/mirror3.out"; then
    ok "T34 el espejo: un paso que termina dentro del tope sale con su propio código (0 y 3) y su salida pasa"
  else no "T34 el espejo: un paso sano salió ${rc} (esperado 0) y ${t} (esperado 3)"; fi
  # un tope gigante no desborda el reloj de Node (más de 2^31-1 ms lo bajaba a 1 ms y cortaba un paso sano al instante)
  node "${CAPPED}" mirror 99999999 -- sh -c 'exit 0' > "${d}/mirror-big.out" 2>&1; rc=$?
  if [ "${rc}" -eq 0 ]; then ok "T34 un tope gigante (99999999 s) no corta un paso sano"
  else no "T34 un tope gigante cortó un paso sano (exit ${rc}): $(tail -n 1 "${d}/mirror-big.out")"; fi

  # y la compuerta de uso: un argumento que no existe sale 2, sin medir nada
  env PATH="${d}/bin" TYCON_CLEAN_MACHINE_INNER=1 TYCON_CLEAN_MACHINE=1 bash "${SELF}" --no-such-option > "${d}/usage.out" 2>&1; rc=$?
  if [ "${rc}" -eq 2 ] && grep -q '^uso: ' "${d}/usage.out"; then ok "T34 un argumento desconocido sale 2 con la línea de uso"
  else no "T34 un argumento desconocido salió ${rc} (esperado 2)"; fi
}
# sources_selfcheck — de qué commit sale la segunda fuente de la copia interna, probado sin docker (corre con T34, en
# toda máquina) sobre repos de juguete: en el repo UNIDO es el mismo commit que el del arnés (el exportador sale 2 si
# difieren); con dos repos físicos, el de siempre (el espejo). El caso: desde la unión de los dos repos internos (story
# 8.18) `internal_copies` le pasaba al exportador un commit suelto del árbol de trabajo como arnés y `origin/main` del
# MISMO repo como agent-skills: dos commits distintos, y la exportación —que sólo corre con docker— salía 2.
sources_selfcheck() {
  local d="${T}/sources" a b got why rc
  mkdir -p "${d}/unified/skills/tycon-pipeline" "${d}/unified/agents" "${d}/tree/scripts" "${d}/skills/skills/tycon-pipeline" "${d}/skills/agents"
  printf '# skill\n' > "${d}/unified/skills/tycon-pipeline/SKILL.md"; printf '# revisor\n' > "${d}/unified/agents/lab.md"
  lab_git -C "${d}/unified" init -q && lab_git -C "${d}/unified" add -A && lab_git -C "${d}/unified" commit -q -m 'lo publicado' \
    && a="$(lab_git -C "${d}/unified" rev-parse HEAD)" && printf 'cambio\n' > "${d}/unified/agents/lab.md" \
    && lab_git -C "${d}/unified" commit -q -a -m 'el cambio bajo prueba' && b="$(lab_git -C "${d}/unified" rev-parse HEAD)" \
    || { no "T26 (fuentes) no pude armar el repo unido de juguete en ${d}/unified"; return; }
  # el repo unido: el arnés en el commit bajo prueba (b); lo publicado es otro (a)
  got="$(TYCON_CLEAN_MACHINE_SKILLS_REF='' TYCON_CLEAN_MACHINE_HARNESS_REF='' second_source "${d}/unified" "${d}/unified" "${b}")"; rc=$?
  if [ "${rc}" -eq 0 ] && [ "${got%% *}" = "${b}" ] && [ "${a}" != "${b}" ]; then ok "T26 (fuentes) en el repo unido la segunda fuente sale del MISMO commit que el arnés (no de lo publicado): el exportador recibe un solo commit"
  else no "T26 (fuentes) en el repo unido la segunda fuente dio «${got}» (rc ${rc}); el arnés está en ${b}"; fi
  got="$(TYCON_CLEAN_MACHINE_SKILLS_REF="${b}" TYCON_CLEAN_MACHINE_HARNESS_REF='' second_source "${d}/unified" "${d}/unified" "${b}")"; rc=$?
  if [ "${rc}" -eq 0 ] && [ "${got%% *}" = "${b}" ]; then ok "T26 (fuentes) …y pedir a mano ese mismo commit para agent-skills también vale"
  else no "T26 (fuentes) en el repo unido, con el mismo commit pedido a mano: «${got}» (rc ${rc})"; fi
  # (error) pedir OTRO commit para agent-skills en el repo unido: se niega acá, nombrando los dos, antes de exportar
  why="$(TYCON_CLEAN_MACHINE_SKILLS_REF="${a}" TYCON_CLEAN_MACHINE_HARNESS_REF='' second_source "${d}/unified" "${d}/unified" "${b}")"; rc=$?
  if [ "${rc}" -eq 1 ] && case "${why}" in *"${a}"*"${b}"*) true ;; *) false ;; esac; then ok "T26 (fuentes) (error) en el repo unido, pedir otro commit para agent-skills se niega nombrando los dos"
  else no "T26 (fuentes) (error) otro commit para agent-skills en el repo unido: rc ${rc}: ${why}"; fi
  # el espejo · dos repos físicos (el arnés sin skills/): la segunda fuente sale de SU repo, como siempre
  printf 'x\n' > "${d}/tree/scripts/x.sh"; printf '# skill\n' > "${d}/skills/skills/tycon-pipeline/SKILL.md"; printf '# revisor\n' > "${d}/skills/agents/lab.md"
  for a in tree skills; do lab_git -C "${d}/${a}" init -q && lab_git -C "${d}/${a}" add -A && lab_git -C "${d}/${a}" commit -q -m lab || { no "T26 (fuentes) no pude armar el repo de juguete ${a}"; return; }; done
  a="$(lab_git -C "${d}/tree" rev-parse HEAD)"; b="$(lab_git -C "${d}/skills" rev-parse HEAD)"
  got="$(TYCON_CLEAN_MACHINE_SKILLS_REF='' TYCON_CLEAN_MACHINE_HARNESS_REF='' second_source "${d}/tree" "${d}/skills" "${a}")"; rc=$?
  if [ "${rc}" -eq 0 ] && [ "${got%% *}" = "${b}" ] && [ "${a}" != "${b}" ]; then ok "T26 (fuentes) el espejo: con dos repos físicos la segunda fuente sale del repo de las skills, en su commit"
  else no "T26 (fuentes) el espejo: con dos repos físicos la segunda fuente dio «${got}» (rc ${rc}); el de las skills está en ${b}"; fi
}
if [ "${TYCON_CLEAN_MACHINE_INNER:-}" != 1 ] && [ "${KEEP}" -eq 0 ]; then t34; cover_selfcheck; version_selfcheck; unified_selfcheck; sources_selfcheck; fi

# ── compuerta 3 · política: ¿le toca medir? ──────────────────────────────────────────────────────────────────
POLICY_WHY=""
# maintenance_tree <raíz> — sale 0 si la raíz es el árbol del repo de MANTENIMIENTO adelgazado (story 8.26, tanda I): su
# `.tycon/internal-forms.json` declara `"layout": "thin"`. Ese árbol (lo privado con el público encima) ya no arma la
# copia pública (story 8.26, AC 36): la copia ES el repo público, y su CI mide la máquina limpia en cada pedido
# (`public-ci.sh --clean-machine`, modo público). Un archivo ilegible no cuenta como adelgazado: se mide como siempre.
MAINTENANCE_WHY="el árbol del repo de mantenimiento ya no arma la copia pública (story 8.26, AC 36): la máquina limpia la mide el repo público en cada pedido (public-ci.sh --clean-machine); acá va con TYCON_CLEAN_MACHINE_SOURCE=<clon del público>"
maintenance_tree() {
  [ -f "$1/.tycon/internal-forms.json" ] || return 1
  node -e 'try { process.exit(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).layout === "thin" ? 0 : 1); } catch (_) { process.exit(1); }' \
    "$1/.tycon/internal-forms.json"
}
measures() {
  [ "${TYCON_CLEAN_MACHINE:-}" = 0 ] && { POLICY_WHY="TYCON_CLEAN_MACHINE=0: quien corre pidió no medir"; return 1; }
  # el árbol de mantenimiento corrido en Azure, con CUALQUIER motivo de la corrida (story 2.21, AC 5): sin un público que
  # medir no le toca — tampoco cuando la corrida a mano del banco la pide (TYCON_CLEAN_MACHINE=1, su parámetro
  # cleanMachine): ese pedido la llevaba roja (corrida 13553). Pedida a mano fuera de Azure sigue saliendo 1, con cómo medir
  if [ -n "${TF_BUILD:-}" ] && [ -z "${TYCON_CLEAN_MACHINE_SOURCE:-}" ] && [ -z "${ONLY}" ] && maintenance_tree "${ROOT}"; then
    POLICY_WHY="${MAINTENANCE_WHY}"; return 1
  fi
  [ "${TYCON_CLEAN_MACHINE:-}" = 1 ] && return 0
  if [ -n "${TF_BUILD:-}" ]; then
    [ "${BUILD_REASON:-}" = "Schedule" ] && return 0
    POLICY_WHY="corre en el nocturno, no en el control de cada cambio (BUILD_REASON=${BUILD_REASON:-sin definir}; TYCON_CLEAN_MACHINE=1 la fuerza)"
    return 1
  fi
  POLICY_WHY="fuera del nocturno no se construyen imágenes sin que alguien lo pida (TYCON_CLEAN_MACHINE=1 la pide)"
  return 1
}
if ! measures; then
  # --keep no es una medición: sin la llave no deja nada listo, y eso es un 1
  if [ "${KEEP}" -ne 0 ]; then skip "${POLICY_WHY}"; exit 1; fi
  # 🔴 La ÚLTIMA línea dice NO MEDIDO (DEF-8.7-C, banco a mano #12543): con un «✅ … verificaciones» al final, el trabajo
  # de suites contaba la máquina limpia como verde sin haberla medido. Las verificaciones propias de la prueba se
  # cuentan en la misma línea; si alguna está en rojo, la salida es roja, como siempre.
  if [ "${CM_FAILS}" -gt 0 ]; then echo "❌ clean-machine: ${CM_FAILS} de ${CM_TOTAL} en rojo"; exit 1; fi
  LAB_NOTE=""; [ "${CM_TOTAL}" -gt 0 ] && LAB_NOTE=" · las ${CM_TOTAL} verificaciones propias de la prueba, en verde"
  echo "⏭ clean-machine: NO MEDIDO — ${POLICY_WHY}${LAB_NOTE}"
  exit 0
fi

# ── compuerta 4 · capacidad: se la pidieron (o es el nocturno); si no puede, lo dice y sale 1 ────────────────
command -v docker >/dev/null 2>&1 || unable "no hay docker en el PATH (hace falta para construir y correr los contenedores)"
SOURCE="${TYCON_CLEAN_MACHINE_SOURCE:-}"
if [ "${ONLY}" = unified ]; then
  # el escenario de la máquina nueva del equipo clona ESTE repo: tiene que ser el unido interno, con su alta. No usa el
  # exportador ni un segundo repo
  MODE=internal
  [ -z "${SOURCE}" ] || unable "--only unified mide el repo interno: no va con TYCON_CLEAN_MACHINE_SOURCE (el modo público)"
  for need in INSTALL.md scripts/setup/harness.js skills/tycon-pipeline agents; do
    [ -e "${ROOT}/${need}" ] || unable "--only unified: este árbol no es el repo unido interno (falta ${need})"
  done
  git -C "${ROOT}" rev-parse --verify --quiet 'HEAD^{commit}' >/dev/null || unable "--only unified: ${ROOT} no es un repo git con algún commit (el escenario lo clona)"
elif [ -n "${SOURCE}" ]; then
  MODE=public
  [ -d "${SOURCE}" ] || unable "TYCON_CLEAN_MACHINE_SOURCE no es una carpeta: ${SOURCE}"
  SOURCE="$(cd "${SOURCE}" && pwd -P)"
  [ "$(cd "$(git -C "${SOURCE}" rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)" 2>/dev/null && pwd -P)" = "${SOURCE}" ] \
    || unable "TYCON_CLEAN_MACHINE_SOURCE no es la raíz de un repo git: ${SOURCE}"
  git -C "${SOURCE}" rev-parse --verify --quiet 'HEAD^{commit}' >/dev/null || unable "el repo de TYCON_CLEAN_MACHINE_SOURCE no tiene ningún commit: ${SOURCE}"
  for need in skills agents README.md getting-started/reference.md; do
    [ -e "${SOURCE}/${need}" ] || unable "TYCON_CLEAN_MACHINE_SOURCE no es el repo público (le falta ${need}): ${SOURCE}"
  done
else
  MODE=internal
  # pedida a mano (TYCON_CLEAN_MACHINE=1) en el árbol de mantenimiento: no hay copia que armar, y se dice cómo medir
  if maintenance_tree "${ROOT}"; then unable "${MAINTENANCE_WHY}"; fi
  for need in scripts/publishing/export.js scripts/publishing/allowlist.json scripts/publishing/replacements.json scripts/publishing/public-files/LICENSE; do
    [ -e "${ROOT}/${need}" ] || unable "modo interno sin exportador (falta ${need}): en el repo público va con TYCON_CLEAN_MACHINE_SOURCE=<raíz>"
  done
  # «No pude mirar» no es «no hay»: si la biblioteca tira (su vecina está y no carga), se dice la causa; no se lee como
  # «sin agent-skills» (story 8.18, deuda lectores-que-tragan; caso en scripts/tests/skills-dir-readers.test.js).
  if ! SK_REPO="$(node -e 'try { console.log(require(process.argv[1]).resolveSkillsDirs(process.env.TYCON_SKILLS_DIR || "").repo); } catch (e) { console.error(String((e && e.message) || e).split("\n")[0]); process.exit(1); }' "${ROOT}/scripts/lib/skills-dir.js" 2> "${T}/skills-dir.err")"; then
    unable "no pude resolver la carpeta de skills: $(head -n 1 "${T}/skills-dir.err")"
  fi
  if [ -z "${SK_REPO}" ] || [ ! -d "${SK_REPO}/skills/tycon-pipeline" ]; then
    unable "modo interno sin agent-skills (TYCON_SKILLS_DIR o ~/.claude/agent-skills): sin la segunda fuente no hay copia que armar"
  fi
fi

# ── compuerta 5 · el servicio de docker contesta, bajo tope y ANTES de exportar ──────────────────────────────
step docker-probe 20 -- docker version; RC=$?
if [ "${RC}" -eq 124 ]; then step_red docker-probe "${RC}"; finish; fi
if [ "${RC}" -ne 0 ]; then unable "el servicio de docker no contesta (docker version salió ${RC}): $(tail -n 1 "${STEP_LOG}")"; fi
DOCKER_READY=1

main
finish
