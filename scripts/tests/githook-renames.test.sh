#!/usr/bin/env bash
# githook-renames.test.sh — un archivo MOVIDO no esquiva los controles del pre-commit que se disparan por ruta
# (story 8.18, deuda `[DEF-8.18-listas-sin-renombres]` · 2026-10-04).
#
# EL CASO. Varios controles del pre-commit corren SÓLO si el commit toca ciertas rutas («un commit de guías no paga el
# costo»). La lista de lo tocado salía de `git diff --cached --name-only`, y git, por defecto, empareja un borrado con
# un alta de contenido parecido y lista sólo la ruta NUEVA. Un `git mv` de un archivo vigilado a una carpeta que no lo
# está dejaba la lista sin ninguna ruta vigilada: el control no corría, y lo que ese archivo sostenía se iba del repo
# sin una palabra. El pase adversarial del tramo 1 lo encontró en el pipeline de pull request (un archivo movido fuera
# de `skills/` contaba como «sin código»); acá se mide lo mismo en las dos partes del pre-commit.
#
# QUÉ SE MIDE, con los hooks REALES del repo corridos sobre repos de juguete (un doble mínimo por control, que anota
# su llamada):
#   pre-commit-harness — los tres disparos por ruta sin filtro de carpeta. Llevan `--no-renames`:
#     · H1  el presupuesto de los bloques del CLAUDE.md: un bloque movido fuera de `claude-md-blocks/`, y la guía del
#           detalle movida de nombre;
#     · H2  la versión pública del mapa del arnés: la privada movida de nombre (el control corre y frena: no la puede
#           leer del índice);
#     · H3  la paridad (`build/check.js`): un hook movido fuera de `scripts/hooks/`.
#   pre-commit-skills — sus dos disparos piden la lista CON la carpeta (`-- skills agents …`, `-- 'agents/*.md'`): git
#     compara sólo adentro de ella, no encuentra con quién emparejar y lista la ruta vieja como borrada. Ya corrían; no
#     se tocaron, y S1 y S2 lo dejan fijado.
#   Los espejos: mover un archivo que ningún control vigila sigue sin correr nada; tocar uno vigilado sin moverlo sigue
#   corriendo su control.
#   L — una lista GRANDE en el índice (6000 archivos): con `git diff | grep -q` y `pipefail`, git moría por SIGPIPE y la
#     paridad, los bloques y el quoting de bash 3.2 no corrían; y un índice que git no puede leer frena, no pasa.
#
# 🔴 rojo previo verificado (2026-10-04): sin `--no-renames`, H1 (los dos), H2 y H3 no corren su control y el hook sale
#    0 callado. S1, S2 y los espejos ya daban verde. Con la lista leída por caño, L da 4 en rojo (la paridad, los
#    bloques y el quoting no corren; el índice roto sale 0); su espejo ya daba verde.
#
# Portable (`requiere: []`): sin red, sin agent-skills instalado, sin herramientas del vocabulario; HOME de juguete y
# git sin las variables que git le pasa a sus hooks.
# Correr: bash scripts/tests/githook-renames.test.sh   (~5 s)

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS_HOOK="${ROOT}/.githooks/pre-commit-harness"
SKILLS_HOOK="${ROOT}/.githooks/pre-commit-skills"
if [ ! -f "${HARNESS_HOOK}" ] || [ ! -f "${SKILLS_HOOK}" ]; then
  echo "githook-renames: NO MEDIDO — no encontré las dos partes del pre-commit (${HARNESS_HOOK}, ${SKILLS_HOOK}); esto no es verde"
  exit 1
fi
T="$(mktemp -d "${TMPDIR:-/tmp}/githook-renames.XXXXXX")" || { echo "githook-renames: NO MEDIDO — no pude crear una carpeta temporal"; exit 1; }
T="$(cd "${T}" && pwd -P)"
trap 'rm -rf "${T}"' EXIT
mkdir -p "${T}/home"
export HOME="${T}/home" TYCON_NO_NIGHTLY_EXAM=1 TYCON_NO_GUI_ENV=1
unset XDG_CONFIG_HOME TYCON_GUIDES_DIR TYCON_SKILLS_DIR

TOTAL=0; FAILS=0
ok() { TOTAL=$((TOTAL + 1)); echo "✅ githook-renames: $1"; }
no() { TOTAL=$((TOTAL + 1)); FAILS=$((FAILS + 1)); echo "❌ githook-renames: $1"; }

# git de la suite y de los hooks que lanza: sin lo que git le exporta a un hook (la carpeta decide el repo)
clean_env() { env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_PREFIX "$@"; }
lab_git() { clean_env git -c user.email=t@t -c user.name=t -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }

# un doble de un control: anota su nombre y sus argumentos en el archivo que diga CALLS, y sale 0
stub_js() { # <archivo> <nombre>
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "require('fs').appendFileSync(process.env.CALLS, '$2 ' + process.argv.slice(2).join(' ') + '\\n');" > "$1"
}
text() { # <archivo> <título> — contenido con cuerpo: git empareja un movimiento por contenido
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "# $2" "" "Un párrafo de relleno para que el archivo no esté vacío." "Otro, con el nombre adentro: $2." > "$1"
}

# ── el repo de juguete del arnés ────────────────────────────────────────────────────────────────────────────────────
HARNESS="${T}/harness-base"
text "${HARNESS}/README.md" "el índice"
text "${HARNESS}/guides/piezas-del-arnes.md" "la guía del detalle"
text "${HARNESS}/claude-md-blocks/style.md" "un bloque"
text "${HARNESS}/artifacts/mapa-arnes.html" "el mapa privado"
text "${HARNESS}/onboarding/mini-class/mapa-del-arnes.html" "el mapa público"
text "${HARNESS}/scripts/tools/harness-map/publica.json" "la configuración del mapa"
text "${HARNESS}/scripts/hooks/sample-hook.js" "un hook"
text "${HARNESS}/docs/note.txt" "una nota"
stub_js "${HARNESS}/scripts/ci/check-claude-md-blocks.js" blocks
stub_js "${HARNESS}/scripts/tools/harness-map/public-version.js" public-map
stub_js "${HARNESS}/build/check.js" parity
( cd "${HARNESS}" && lab_git init -q . && lab_git add -A && lab_git commit -qm base ) > /dev/null 2>&1 \
  || { echo "githook-renames: NO MEDIDO — no pude armar el repo de juguete del arnés"; exit 1; }

# ── el repo de juguete de las skills, y el arnés (de juguete) que su hook consulta ───────────────────────────────────
SKILLS="${T}/skills-base"
text "${SKILLS}/agents/reviewer.md" "un revisor"
text "${SKILLS}/skills/sample/SKILL.md" "una skill"
text "${SKILLS}/docs/note.txt" "una nota"
( cd "${SKILLS}" && lab_git init -q . && lab_git add -A && lab_git commit -qm base ) > /dev/null 2>&1 \
  || { echo "githook-renames: NO MEDIDO — no pude armar el repo de juguete de las skills"; exit 1; }
TOY_GUIDES="${T}/guides"
stub_js "${TOY_GUIDES}/build/check.js" parity
stub_js "${TOY_GUIDES}/scripts/publishing/third-party-coverage.js" coverage

# variant <base> <nombre> → copia el repo base a ${T}/<nombre>; deja R (el repo), CALLS (las llamadas) y OUT (la salida)
variant() { R="${T}/$2"; cp -R "$1" "${R}"; CALLS="${R}.calls"; OUT="${R}.out"; : > "${CALLS}"; }
move() { ( cd "${R}" && mkdir -p "$(dirname "$2")" && lab_git mv "$1" "$2" ) > /dev/null 2>&1 || no "no pude mover $1 a $2 en ${R#${T}/}"; }
# run_hook <hook> → lo corre desde la raíz del repo de juguete, como lo corre git; deja RC
RC=0
run_hook() { ( cd "${R}" && clean_env CALLS="${CALLS}" TYCON_GUIDES_DIR="${TOY_GUIDES}" bash "$1" ) > "${OUT}" 2>&1; RC=$?; }
called() { grep -q "^$1 " "${CALLS}" 2>/dev/null; }
# ran <etiqueta> <control> · idle <etiqueta>: ningún control corrió
ran() { if called "$2"; then ok "$1"; else no "$1 — el control «${2}» NO corrió (exit ${RC}; llamadas: $(tr '\n' '|' < "${CALLS}"); salida: $(tail -n 3 "${OUT}" | tr '\n' ' '))"; fi; }
idle() { if [ ! -s "${CALLS}" ] && [ "${RC}" -eq 0 ]; then ok "$1"; else no "$1 — esperaba exit 0 y ningún control, dio exit ${RC} y «$(tr '\n' '|' < "${CALLS}")»"; fi; }

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
# El escenario es el real: por defecto git lista SÓLO la ruta nueva de un archivo movido
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
variant "${HARNESS}" pairing; move claude-md-blocks/style.md guides/style.md
PAIRED="$(cd "${R}" && lab_git diff --cached --name-only | tr '\n' ' ')"
if [ "${PAIRED}" = "guides/style.md " ]; then ok "el escenario es el real: \`git diff --cached --name-only\` de un archivo movido lista sólo la ruta nueva"
else no "el escenario no se reproduce: git listó «${PAIRED}» para un archivo movido (¿diff.renames apagado en la configuración del sistema?)"; fi
WITH_OLD="$(cd "${R}" && lab_git diff --cached --name-only --no-renames | sort | tr '\n' ' ')"
if [ "${WITH_OLD}" = "claude-md-blocks/style.md guides/style.md " ]; then ok "con --no-renames salen las dos rutas: la vieja y la nueva"
else no "con --no-renames esperaba las dos rutas y salió «${WITH_OLD}»"; fi

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
# pre-commit-harness
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
# H1 · el presupuesto de los bloques del CLAUDE.md
variant "${HARNESS}" h1-block; move claude-md-blocks/style.md guides/style.md; run_hook "${HARNESS_HOOK}"
ran "H1 un bloque movido fuera de claude-md-blocks/ corre igual el control de los bloques" blocks
variant "${HARNESS}" h1-detail; move guides/piezas-del-arnes.md guides/detail.md; run_hook "${HARNESS_HOOK}"
ran "H1 la guía del detalle movida de nombre corre igual el control de los bloques" blocks
# H2 · la versión pública del mapa: la privada movida ya no está en el índice, y el control lo dice y frena
variant "${HARNESS}" h2-map; move artifacts/mapa-arnes.html artifacts/map-old.html; run_hook "${HARNESS_HOOK}"
if [ "${RC}" -eq 1 ] && grep -q "no pude leer del índice la privada" "${OUT}"; then ok "H2 el mapa privado movido de nombre corre igual el control del mapa, que frena: no lo puede leer del índice"
else no "H2 con el mapa privado movido esperaba exit 1 con «no pude leer del índice la privada», dio exit ${RC}: $(tail -n 3 "${OUT}" | tr '\n' ' ')"; fi
# H3 · la paridad
variant "${HARNESS}" h3-parity; move scripts/hooks/sample-hook.js docs/sample-hook.js; run_hook "${HARNESS_HOOK}"
ran "H3 un hook movido fuera de scripts/hooks/ corre igual la paridad (build/check.js)" parity
if [ "${RC}" -eq 0 ] && grep -q "paridad OK" "${OUT}"; then ok "H3 …y con la paridad en verde el commit pasa"
else no "H3 con la paridad en verde esperaba exit 0 y «paridad OK», dio exit ${RC}: $(tail -n 3 "${OUT}" | tr '\n' ' ')"; fi
# los espejos
variant "${HARNESS}" h-unrelated; move docs/note.txt docs/note-moved.txt; run_hook "${HARNESS_HOOK}"
idle "espejo: mover un archivo que ningún control vigila sigue sin correr nada (el commit de otra cosa no paga el costo)"
variant "${HARNESS}" h-touched; printf '%s\n' "una línea más" >> "${R}/claude-md-blocks/style.md"
( cd "${R}" && lab_git add claude-md-blocks/style.md ) > /dev/null 2>&1; run_hook "${HARNESS_HOOK}"
ran "espejo: tocar un bloque sin moverlo sigue corriendo el control de los bloques" blocks
if called parity; then no "espejo: tocar un bloque corrió además la paridad, que no vigila esa carpeta"; else ok "espejo: …y no corre la paridad, que no vigila esa carpeta"; fi

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
# L · una lista GRANDE en el índice (revisión del tramo 2, vuelta 1, 2026-10-04)
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
# EL CASO. Los disparos eran `git diff … | grep -q …` con `pipefail`: `grep -q` se va con la primera ruta que coincide,
# y si a git le queda lista por escribir muere por SIGPIPE (141). Con la paridad, `if ! … | grep -q` daba verdadero y
# el hook salía 0 SIN correr ningún control; con los bloques y el quoting de bash 3.2, el disparo daba falso y su control
# se salteaba. Medido con 6000 archivos en el índice. Las rutas vigiladas van ANTES de la carga (`zz-bulk/` ordena
# último): así grep coincide en el primer pedazo y git todavía tiene ~400 KB por escribir, más que el caño.
# Y si git NO puede dar la lista (un índice roto), el hook lo dice y frena: «no pude mirar» no es «no hay».
BULK="${T}/harness-bulk"; cp -R "${HARNESS}" "${BULK}"
stub_js "${BULK}/scripts/ci/bash32.js" bash32
printf '%s\n' '#!/usr/bin/env bash' 'node "$(dirname "$0")/bash32.js" "$@"' > "${BULK}/scripts/ci/check-bash32-quoting.sh"
( cd "${BULK}" && lab_git add scripts/ci && lab_git commit -qm stubs ) > /dev/null 2>&1 || no "no pude sumar el doble del quoting de bash 3.2"
mkdir -p "${BULK}/zz-bulk/a-rather-long-directory-name-so-the-list-weighs-more"
i=0; while [ "${i}" -lt 6000 ]; do : > "${BULK}/zz-bulk/a-rather-long-directory-name-so-the-list-weighs-more/file-${i}.txt"; i=$((i + 1)); done
( cd "${BULK}" && lab_git add zz-bulk ) > /dev/null 2>&1 || no "no pude poner la carga en el índice"
BULK_SIZE="$(cd "${BULK}" && lab_git diff --cached --name-only --no-renames | wc -c | tr -d ' ')"
if [ "${BULK_SIZE:-0}" -gt 300000 ]; then ok "L el escenario es el real: la lista del índice pesa ${BULK_SIZE} bytes, más que el caño entre git y grep"
else no "L la lista del índice pesa ${BULK_SIZE:-?} bytes: no alcanza para que git muera por SIGPIPE, y lo de abajo no mide nada"; fi

variant "${BULK}" l-parity; text "${R}/scripts/hooks/new-hook.js" "un hook nuevo"
( cd "${R}" && lab_git add scripts/hooks/new-hook.js ) > /dev/null 2>&1; run_hook "${HARNESS_HOOK}"
ran "L con 6000 archivos en el índice, un hook nuevo corre igual la paridad (antes: exit 0 sin correr nada)" parity
variant "${BULK}" l-blocks; printf '%s\n' "una línea más" >> "${R}/claude-md-blocks/style.md"
( cd "${R}" && lab_git add claude-md-blocks/style.md ) > /dev/null 2>&1; run_hook "${HARNESS_HOOK}"
ran "L con 6000 archivos en el índice, tocar un bloque corre igual el control de los bloques" blocks
variant "${BULK}" l-bash32; printf '%s\n' '#!/usr/bin/env bash' 'echo hola' > "${R}/a.sh"
( cd "${R}" && lab_git add a.sh ) > /dev/null 2>&1; run_hook "${HARNESS_HOOK}"
ran "L con 6000 archivos en el índice, un .sh corre igual el control del quoting de bash 3.2" bash32
variant "${BULK}" l-unrelated; run_hook "${HARNESS_HOOK}"
idle "L espejo: 6000 archivos que ningún control vigila no corren nada y el commit pasa"

variant "${HARNESS}" l-broken-index; printf '%s\n' "una línea más" >> "${R}/docs/note.txt"
( cd "${R}" && lab_git add docs/note.txt ) > /dev/null 2>&1
printf 'esto no es un índice de git' > "${R}/.git/index"
if ( cd "${R}" && lab_git diff --cached --name-only ) > /dev/null 2>&1; then
  no "L NO MEDIDO — el índice roto no hizo fallar a git, así que no hay escenario"
else
  run_hook "${HARNESS_HOOK}"
  if [ "${RC}" -ne 0 ] && grep -q "no pude leer la lista" "${OUT}"; then ok "L con el índice roto, git no puede dar la lista y el hook lo dice y frena (exit ${RC})"
  else no "L con el índice roto esperaba un exit distinto de 0 y «no pude leer la lista», dio exit ${RC}: $(tail -n 3 "${OUT}" | tr '\n' ' ')"; fi
fi

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
# pre-commit-skills (sin cambios: la lista se pide con la carpeta, y ahí la ruta vieja sale como borrada)
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
variant "${SKILLS}" s1-agent; move agents/reviewer.md retired/reviewer.md; run_hook "${SKILLS_HOOK}"
ran "S1 un revisor movido fuera de agents/ corre igual la paridad de los revisores" parity
ran "S1 …y el control de lo ajeno sin declarar" coverage
variant "${SKILLS}" s2-skill; move skills/sample/SKILL.md docs/SKILL.md; run_hook "${SKILLS_HOOK}"
ran "S2 una skill movida fuera de skills/ corre igual el control de lo ajeno sin declarar" coverage
variant "${SKILLS}" s-unrelated; move docs/note.txt docs/note-moved.txt; run_hook "${SKILLS_HOOK}"
idle "espejo: en las skills, mover un archivo que ningún control vigila sigue sin correr nada"

echo ""
if [ "${FAILS}" -eq 0 ] && [ "${TOTAL}" -gt 0 ]; then echo "✅ githook-renames: ${TOTAL} verificaciones verdes"; exit 0; fi
echo "❌ githook-renames: ${FAILS} de ${TOTAL} verificaciones en rojo"; exit 1
