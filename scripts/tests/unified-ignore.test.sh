#!/usr/bin/env bash
# unified-ignore.test.sh — el .gitignore del repo unido sigue versionando el registro de revisores.
#
# ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────────────────────────────
# El arnés y agent-skills se unieron en un repo, y cada uno traía su `.gitignore`. El de agent-skills ignoraba
# `.advisors/` entero; el del arnés ignora lo efímero de esa carpeta y vuelve a incluir, con excepciones, la evidencia
# de cierre (`dod-runtime/`) y el registro de revisores de cada corrida (`review-roster.json`, `findings.json`), que es
# lo que el portón de CI exige para pasar una story a `done`. Juntar los dos archivos tal cual deja esa línea DESPUÉS de
# las excepciones, y gana: el registro deja de versionarse. Y no avisa: un `git add` de un archivo ignorado no falla,
# no agrega nada. Por eso el `.gitignore` unido es la unión SIN ese bloque, y esta prueba lo fija.
#
# ── QUÉ MIDE ─────────────────────────────────────────────────────────────────────────────────────────────────────────
# El EFECTO, con git de verdad: en una carpeta vacía con el `.gitignore` de este repo se crean los archivos y se hace
# `git add -A`; lo que entra al índice es lo que se versiona.
#   · el registro de revisores, sus hallazgos y la evidencia de cierre ENTRAN;
#   · lo efímero de `.advisors/` NO entra;
#   · cada destino de skills de terceros del manifiesto, `skills-inactivas/`, `.codegraph/`, `__pycache__/` y las dos
#     líneas de skills personales NO entran; una skill propia SÍ entra (un `.gitignore` que ignora todo también está roto);
#   · el control: con la línea `.advisors/` de vuelta (la unión simple), el registro y la evidencia se PIERDEN. Sin este
#     caso, el verde de arriba no diría nada.
# Y, si el clon trae la historia de la unión (scripts/tests/fixtures/union-commits.json), lo mismo con los dos archivos
# originales: el del arnés solo versiona el registro, y la unión simple de los dos de verdad lo pierde.
#
# No toca ningún repo real: todo corre bajo mktemp, sin la configuración global de git (un `core.excludesFile` del dev
# cambiaría el resultado) y sin las variables que git le pasa a sus hooks.
#
# Correr: bash scripts/tests/unified-ignore.test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_COMMON_DIR GIT_PREFIX GIT_OBJECT_DIRECTORY
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

FAILS=0
ok()  { echo "  ok   — $1"; }
bad() { echo "  MAL  — $1"; FAILS=$((FAILS+1)); }

UNIFIED="${ROOT}/.gitignore"
MANIFEST="${ROOT}/scripts/publishing/third-party-skills.json"
FIXTURE="${ROOT}/scripts/tests/fixtures/union-commits.json"
[ -f "${UNIFIED}" ] || { echo "  MAL  — no encontré ${UNIFIED}"; exit 1; }

LAB="$(mktemp -d)"
trap 'rm -rf "${LAB}"' EXIT
# 🔴 Anular la configuración global no alcanza. git lee además el archivo de ignorados por defecto de la
# persona (`$XDG_CONFIG_HOME/git/ignore`, o `~/.config/git/ignore`), que no depende de esa configuración: con una línea
# `__pycache__/` ahí, un .gitignore al que le FALTARA esa línea daría «todo verde». La prueba corre con una HOME vacía.
mkdir -p "${LAB}/home"
export HOME="${LAB}/home" XDG_CONFIG_HOME="${LAB}/home/.config"

# La copia pública (sin el perfil del equipo) no versiona el registro de revisores, a propósito: el exportador le saca
# al .gitignore las líneas «!…» que vuelven a incluir algo de `.advisors/`, porque esa carpeta nunca sale. Ahí lo del
# registro (C-01, C-04 y C-05) NO SE MIDE y se dice; lo que tiene que seguir ignorado (C-02 y C-03) se mide igual.
# 🔴 Sin esto, la suite viaja a la copia como portable y da rojo en su CI.
TEAM=1
[ -f "${ROOT}/perfil-equipo.json" ] || TEAM=0

VERSIONED=".advisors/pipeline-runs/r1/review-roster.json .advisors/pipeline-runs/r1/findings.json .advisors/dod-runtime/e1.md"
EPHEMERAL=".advisors/tmp/x.txt .advisors/pipeline-runs/r1/notes.md"
LOCAL_ONLY="skills-inactivas/x/SKILL.md .codegraph/index.db __pycache__/a.pyc tools/a.pyc skills/super/SKILL.md skills/theme-factory/themes/claude-warm-paper.md"
OWN_SKILL="skills/tycon-pipeline/SKILL.md"

# Los destinos de skills de terceros: cada `target` del manifiesto y cada enlace que declara. Sin manifiesto (una copia
# que no lo trae) la lista queda vacía y se dice.
THIRD_PARTY=""
if [ -f "${MANIFEST}" ]; then
  THIRD_PARTY="$(node -e 'const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const out = new Set();
    for (const e of m.third_party || []) { if (e.target) out.add(e.target); for (const l of e.links || []) out.add(l); }
    console.log([...out].join("\n"));' "${MANIFEST}")" || { echo "  MAL  — no pude leer ${MANIFEST}"; exit 1; }
fi

# Una carpeta vacía con ese .gitignore y todos los archivos del caso; imprime lo que `git add -A` dejó en el índice.
staged_with() {   # $1 = nombre del caso · $2 = archivo .gitignore
  local dir="${LAB}/$1" f
  mkdir -p "${dir}" && git init -q "${dir}" || return 1
  cp "$2" "${dir}/.gitignore"
  for f in ${VERSIONED} ${EPHEMERAL} ${LOCAL_ONLY} ${OWN_SKILL}; do
    mkdir -p "${dir}/$(dirname "${f}")" && echo x > "${dir}/${f}"
  done
  while IFS= read -r f; do
    [ -n "${f}" ] || continue
    mkdir -p "${dir}/${f}" && echo x > "${dir}/${f}/SKILL.md"
  done <<< "${THIRD_PARTY}"
  ( cd "${dir}" && git add -A && git diff --cached --name-only ) > "${LAB}/$1.staged" 2> "${LAB}/$1.err" || return 1
}
in_index()     { grep -qxF "$2" "${LAB}/$1.staged"; }
under_index()  { grep -qE "^$(printf '%s' "$2" | sed 's/[.[\*^$]/\\&/g')(/|$)" "${LAB}/$1.staged"; }

# ── C-01 · el .gitignore unido: el registro y la evidencia se versionan ───────────────────────────────────────────────
if staged_with unified "${UNIFIED}"; then
  if [ "${TEAM}" = 1 ]; then
    MISSING=""
    for f in ${VERSIONED}; do in_index unified "${f}" || MISSING="${MISSING} ${f}"; done
    if [ -z "${MISSING}" ]; then
      ok "C-01 T4 con el .gitignore unido, git add agrega el registro de revisores, sus hallazgos y la evidencia de cierre"
    else
      bad "C-01 T4 con el .gitignore unido NO se versiona:${MISSING}"
    fi
    # y `git check-ignore` contesta lo mismo: no están ignorados
    IGNORED=""
    for f in ${VERSIONED}; do ( cd "${LAB}/unified" && git check-ignore -q "${f}" ) && IGNORED="${IGNORED} ${f}"; done
    if [ -z "${IGNORED}" ]; then ok "C-01 T4 git check-ignore: ninguno de los tres está ignorado"; else bad "C-01 T4 git check-ignore los da por ignorados:${IGNORED}"; fi
  else
    echo "  ⚠️   — C-01 T4 NO MEDIDO: este árbol no trae perfil-equipo.json (la copia pública), y ahí el registro de revisores no se versiona a propósito. No es un verde."
  fi

  # ── C-02 · lo efímero sigue afuera ─────────────────────────────────────────────────────────────────────────────────
  LEAKED=""
  for f in ${EPHEMERAL}; do in_index unified "${f}" && LEAKED="${LEAKED} ${f}"; done
  if [ -z "${LEAKED}" ]; then ok "C-02 T4 lo efímero de .advisors/ sigue ignorado"; else bad "C-02 T4 lo efímero de .advisors/ se versionaría:${LEAKED}"; fi

  # ── C-03 · lo que nunca se versiona de agent-skills sigue afuera ───────────────────────────────────────────────────
  LEAKED=""
  for f in ${LOCAL_ONLY}; do in_index unified "${f}" && LEAKED="${LEAKED} ${f}"; done
  if [ -z "${LEAKED}" ]; then
    ok "C-03 T4 skills-inactivas/, .codegraph/, __pycache__/ y las dos líneas de skills personales siguen ignoradas"
  else
    bad "C-03 T4 se versionaría lo que es de cada máquina:${LEAKED}"
  fi
  if [ -z "${THIRD_PARTY}" ]; then
    echo "  ⚠️   — C-03 T4 destinos de terceros NO verificados: este árbol no trae ${MANIFEST#"${ROOT}"/}. No es un verde."
  else
    LEAKED=""; COUNT=0
    while IFS= read -r f; do
      [ -n "${f}" ] || continue
      COUNT=$((COUNT+1))
      under_index unified "${f}" && LEAKED="${LEAKED} ${f}"
    done <<< "${THIRD_PARTY}"
    if [ -z "${LEAKED}" ] && [ "${COUNT}" -gt 0 ]; then
      ok "C-03 T4 los ${COUNT} destinos de skills de terceros del manifiesto siguen ignorados"
    else
      bad "C-03 T4 destinos de terceros que se versionarían (de ${COUNT}):${LEAKED}"
    fi
  fi
  # el espejo: una skill propia entra
  if in_index unified "${OWN_SKILL}"; then ok "C-03 T4 una skill propia sí se versiona"; else bad "C-03 T4 una skill propia quedó ignorada: ${OWN_SKILL}"; fi
else
  bad "C-01 T4 no pude armar la carpeta de prueba del .gitignore unido"; sed -n '1,5p' "${LAB}/unified.err" 2>/dev/null
fi

# ── C-04 · 🔴 el control: con la línea de agent-skills de vuelta, el registro se pierde ───────────────────────────────
# Es la unión simple: el bloque que la unión deja afuera, puesto donde quedaría (después de las líneas del arnés).
{ cat "${UNIFIED}"; printf '%s\n' '.advisors/'; } > "${LAB}/simple.gitignore"
if [ "${TEAM}" != 1 ]; then
  echo "  ⚠️   — C-04 T4 NO MEDIDO: es el control de C-01, que en la copia pública no se mide. No es un verde."
elif staged_with simple "${LAB}/simple.gitignore"; then
  KEPT=""
  for f in ${VERSIONED}; do in_index simple "${f}" && KEPT="${KEPT} ${f}"; done
  if [ -z "${KEPT}" ]; then
    ok "C-04 T4 con la línea .advisors/ de vuelta (la unión simple) el registro y la evidencia se pierden, y git add no falla: el verde de C-01 mide algo"
  else
    bad "C-04 T4 la unión simple igual versiona:${KEPT} — el control no reproduce la trampa"
  fi
else
  bad "C-04 T4 no pude armar la carpeta de prueba de la unión simple"
fi

# ── C-05 · con la historia de la unión a mano: los dos archivos originales ───────────────────────────────────────────
HARNESS_SIDE=""; SKILLS_SIDE=""
if [ -f "${FIXTURE}" ]; then
  HARNESS_SIDE="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).harness_side || "")' "${FIXTURE}")"
  SKILLS_SIDE="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).skills_side || "")' "${FIXTURE}")"
fi
if [ -n "${HARNESS_SIDE}" ] && [ -n "${SKILLS_SIDE}" ] \
   && git -C "${ROOT}" show "${HARNESS_SIDE}:.gitignore" > "${LAB}/harness.gitignore" 2>/dev/null \
   && git -C "${ROOT}" show "${SKILLS_SIDE}:.gitignore" > "${LAB}/skills.gitignore" 2>/dev/null; then
  if staged_with harness-alone "${LAB}/harness.gitignore"; then
    MISSING=""
    for f in ${VERSIONED}; do in_index harness-alone "${f}" || MISSING="${MISSING} ${f}"; done
    if [ -z "${MISSING}" ]; then ok "C-05 T4 el .gitignore del arnés solo (el de antes de la unión) versiona el registro"; else bad "C-05 T4 el del arnés solo no versiona:${MISSING}"; fi
  else
    bad "C-05 T4 no pude armar la carpeta de prueba del .gitignore del arnés solo"
  fi
  # la unión simple de los dos de verdad: primero las líneas del arnés, después las de agent-skills, sin repetir
  node -e 'const fs = require("fs"); const lines = (f) => fs.readFileSync(f, "utf8").split("\n").filter((l, i, t) => !(i === t.length - 1 && l === ""));
    const h = lines(process.argv[1]); const s = lines(process.argv[2]);
    fs.writeFileSync(process.argv[3], [...new Set([...h, ...s.filter((l) => !h.includes(l))])].join("\n") + "\n");' \
    "${LAB}/harness.gitignore" "${LAB}/skills.gitignore" "${LAB}/real-simple.gitignore"
  if staged_with real-simple "${LAB}/real-simple.gitignore"; then
    KEPT=""
    for f in ${VERSIONED}; do in_index real-simple "${f}" && KEPT="${KEPT} ${f}"; done
    if [ -z "${KEPT}" ]; then ok "C-05 T4 la unión simple de los dos archivos de verdad pierde el registro (la trampa medida en el análisis)"; else bad "C-05 T4 la unión simple de verdad igual versiona:${KEPT}"; fi
  else
    bad "C-05 T4 no pude armar la carpeta de prueba de la unión simple de verdad"
  fi
else
  echo "  ⚠️   — C-05 T4 NO MEDIDO: este árbol no trae los commits de los dos lados de la unión (falta el archivo de commits, o el clon no trae esa historia). No es un verde."
fi

echo
if [ "${FAILS}" -gt 0 ]; then echo "FALLARON ${FAILS} chequeo(s)"; exit 1; fi
echo "todo verde"; exit 0
