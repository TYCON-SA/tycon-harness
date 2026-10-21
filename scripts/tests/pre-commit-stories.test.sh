#!/usr/bin/env bash
# pre-commit-stories.test.sh — que el pre-commit de ESTE repo lintee las stories.
#
# EL AGUJERO QUE CIERRA. Una regla nueva del lint de frontmatter (`followup_reason:`) vive adentro de
# `lint-story-frontmatter.js` y llega al pre-commit de todos los repos sin tocar ningún hook, pero sólo si el
# pre-commit llama al lint. Si el de este repo corriera sólo `build/check.js`, y encima únicamente cuando el commit
# tocara `adapters/|build/|scripts/controls-bench/|scripts/hooks/|…`, un commit de `specs/` saldría por el `exit 0`
# sin mirar nada, y la regla del arnés no se aplicaría al propio arnés.
#
# 🔴 LOS DOS CASOS QUE SOSTIENEN LA PIEZA, y ninguno se puede perder:
#    · el que FRENA (story rota → exit 1): sin él, el arreglo se puede borrar y todo sigue verde;
#    · el que NO frena (stories sanas, y un commit sin `.md` → exit 0): sin él, el control se
#      apaga a la semana. Las stories sanas del repo y sus `.md` pasan.
#
# El banco es un repo de juguete con la MISMA estructura relativa, y se corre el hook REAL de
# `.githooks/pre-commit` — no una copia de su lógica.

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# `.githooks/pre-commit` sólo llama a `.githooks/pre-commit-checks`, que trae los controles: cuál copiar lo elige
# scripts/tests/lib/pre-commit-hook.js, como en githook-livefire.test.sh.
# Si el ayudante falla, lo que diga se ve (no se tapa su salida de error) y queda el nombre de siempre.
HOOK="$(node "$RAIZ/scripts/tests/lib/pre-commit-hook.js" harness "$RAIZ")"
[ -n "$HOOK" ] || HOOK="$RAIZ/.githooks/pre-commit"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }

[ -f "$HOOK" ] || { echo "  MAL  — no encontré $HOOK"; exit 1; }

STORY_SANA='---
story: "9.9"
epic: "9"
status: draft
---

# Story 9.9 — de juguete

## Acceptance Criteria
1. algo
'

# Frontmatter SIN el `---` de cierre: el modo de falla original, el que deja la story
# invisible para el validator, el backfill, los scripts de status y el hook de DoD — sin dar error.
STORY_ROTA='---
story: "9.8"
epic: "9"
status: draft

# Story 9.8 — de juguete, rota

## Acceptance Criteria
1. algo
'

# ── Banco: repo de juguete con el hook y lo que el lint necesita, en las MISMAS rutas ─────────
montar() {
  local T="$1"
  mkdir -p "$T/repo/.githooks" "$T/repo/scripts" "$T/repo/specs"
  cp "$HOOK" "$T/repo/.githooks/pre-commit"
  # El lint viaja con `scripts/lib/` y NO se copia el reemplazo de su ruta vieja: así el hook y el
  # portón (C-06/C-07, T25) tienen que resolverlo en su ruta nueva — con el reemplazo al lado, un `require` viejo
  # seguiría andando y la prueba no lo vería.
  cp -R "$RAIZ/scripts/lib" "$T/repo/scripts/" 2>/dev/null
  cp -R "$RAIZ/scripts/metrics" "$T/repo/scripts/" 2>/dev/null
  cp -R "$RAIZ/scripts/ci" "$T/repo/scripts/" 2>/dev/null   # el portón, para C-06/C-07
  git init -q -b main "$T/repo"
  ( cd "$T/repo" && git -c user.email=b@b -c user.name=b commit -q --allow-empty -m base )
}

correr_hook() { ( cd "$1/repo" && bash .githooks/pre-commit ) > "$1/out.txt" 2>&1; echo $?; }

# ── caso 1 · una story ROTA en el commit → el hook FRENA ──────────────────────────────────────
# 🔴 Sin el bloque del lint en el hook, da exit 0.
T=$(mktemp -d); montar "$T"
printf '%s' "$STORY_ROTA" > "$T/repo/specs/story-9.8-rota.md"
( cd "$T/repo" && git add specs/story-9.8-rota.md )
RC=$(correr_hook "$T")
if [ "$RC" != "0" ] && grep -q "9.8" "$T/out.txt"; then
  ok "C-01 una story ilegible frena el commit (exit $RC) y el hook la nombra"
else
  mal "C-01 una story ilegible NO frenó (exit $RC) — el lint no está cableado"; sed -n '1,10p' "$T/out.txt"
fi
rm -rf "$T"

# ── caso 1b · la misma story ROTA con espacios y una tilde en el nombre → también FRENA ─────────
# 🔴 Con la lista sin comillas, el nombre se parte en pedazos que no existen y el
# lint sale «0 revisadas · OK»: exit 0.
T=$(mktemp -d); montar "$T"
printf '%s' "$STORY_ROTA" > "$T/repo/specs/story 9.8 ñandú rota.md"
( cd "$T/repo" && git add "specs/story 9.8 ñandú rota.md" )
RC=$(correr_hook "$T")
if [ "$RC" != "0" ] && grep -q "ñandú rota" "$T/out.txt"; then
  ok "C-01b una story ilegible con espacios y tilde en el nombre frena el commit (exit $RC) y el hook la nombra"
else
  mal "C-01b una story ilegible con espacios en el nombre NO frenó (exit $RC) — la lista se parte"; sed -n '1,10p' "$T/out.txt"
fi
rm -rf "$T"

# ── caso 2 · stories SANAS → NO frena ─────────────────────────────────────────────────────────
# El espejo obligatorio: un control que frena lo legítimo se apaga, y se lleva puesto el caso 1.
T=$(mktemp -d); montar "$T"
printf '%s' "$STORY_SANA" > "$T/repo/specs/story-9.9-sana.md"
( cd "$T/repo" && git add specs/story-9.9-sana.md )
RC=$(correr_hook "$T")
[ "$RC" = "0" ] && ok "C-02 una story sana pasa (exit 0)" \
  || { mal "C-02 una story SANA fue frenada (exit $RC)"; sed -n '1,10p' "$T/out.txt"; }
rm -rf "$T"

# ── caso 3 · un commit sin `.md` no paga el costo ─────────────────────────────────────────────
T=$(mktemp -d); montar "$T"
echo 'x' > "$T/repo/nota.txt"
( cd "$T/repo" && git add nota.txt )
RC=$(correr_hook "$T")
if [ "$RC" = "0" ] && ! grep -qi "frontmatter" "$T/out.txt"; then
  ok "C-03 un commit sin .md no dispara el lint"
else
  mal "C-03 un commit sin .md disparó el lint (exit $RC)"; sed -n '1,10p' "$T/out.txt"
fi
rm -rf "$T"

# ── caso 4 · sin el lint en disco: avisa y NO frena ───────────────────────────────────────────
# Fail-open RUIDOSO, igual que el snippet canónico de la cabecera del lint: un pre-commit que
# frena a todo el equipo porque falta un archivo se desactiva con --no-verify el mismo día.
T=$(mktemp -d); montar "$T"
rm -f "$T/repo/scripts/lib/lint-story-frontmatter.js"
printf '%s' "$STORY_ROTA" > "$T/repo/specs/story-9.8-rota.md"
( cd "$T/repo" && git add specs/story-9.8-rota.md )
RC=$(correr_hook "$T")
if [ "$RC" = "0" ] && grep -qiE "lint|frontmatter" "$T/out.txt"; then
  ok "C-04 sin el lint en disco: avisa y deja pasar (exit 0)"
else
  mal "C-04 sin el lint: exit $RC y/o sin aviso — o frena de más, o se saltea en silencio"; sed -n '1,10p' "$T/out.txt"
fi
rm -rf "$T"

# ── caso 5 · las stories legítimas pasan ──────────────────────────────────────────────────────
# La medición que sostiene que esto sea BLOQUEANTE y no sólo avise. Si un día deja de valer, el
# arreglo hay que reconsiderarlo — no bajarle el volumen a este caso.
# Un repo con stories propias (specs/, como el de mantenimiento) se mide con las suyas. El público no trae stories:
# ahí se mide con stories de muestra que arma esta prueba, una por cada forma que un commit legítimo trae (la mínima,
# con id compuesto, con bloque `pipelines:`, la que sigue a otra con su causa, con finales de línea de Windows). Una
# regla nueva del lint que rechace alguna de estas formas frenaría commits legítimos: eso pone este caso en rojo.
if [ -d "$RAIZ/specs" ]; then
  if node "$RAIZ/scripts/lib/lint-story-frontmatter.js" >/dev/null 2>&1; then
    ok "C-05 todas las stories reales del repo pasan el lint (por eso entra bloqueante)"
  else
    mal "C-05 hay stories del repo que NO pasan el lint — el hook estaría frenando commits legítimos"
  fi
else
  M5="$(mktemp -d)"; mkdir -p "$M5/repo/specs/stories"
  printf '%s' "$STORY_SANA" > "$M5/repo/specs/stories/story-9.9-minima.md"
  printf '%s\n' '---' 'story: 1.3-B-frontend' 'epic: "1"' 'status: ready-for-dev' 'title: "Una story con id compuesto: y dos puntos"' '---' '' '# Story 1.3-B' '' '## Acceptance Criteria' '1. algo' > "$M5/repo/specs/stories/story-1.3-B-frontend.md"
  printf '%s\n' '---' 'story: "4.2"' 'epic: "4"' 'status: in-progress' 'pipelines:' '  A-backend:' '    status: done' '    tests_pending: []' '  B-frontend:' '    status: blocked' '---' '' '# Story 4.2' '' '## Acceptance Criteria' '1. algo' > "$M5/repo/specs/stories/story-4.2-tandas.md"
  printf '%s\n' '---' 'story: "4.3"' 'epic: "4"' 'status: draft' 'followup_of: "4.2"' 'followup_reason: descubrimiento' '---' '' '# Story 4.3' '' '## Acceptance Criteria' '1. algo' > "$M5/repo/specs/stories/story-4.3-sigue.md"
  printf '%s' "$STORY_SANA" | sed 's/9\.9/9.6/g' | perl -pe 's/\n/\r\n/' > "$M5/repo/specs/stories/story-9.6-crlf.md"
  ( cd "$M5/repo" && STORIES_DIR="$M5/repo/specs/stories" node "$RAIZ/scripts/lib/lint-story-frontmatter.js" ) > "$M5/out.txt" 2>&1; RC5=$?
  if [ "$RC5" = "0" ] && grep -q " 5 revisadas" "$M5/out.txt"; then
    ok "C-05 las 5 stories de muestra, una por cada forma legítima, pasan el lint (por eso entra bloqueante)"
  else
    mal "C-05 alguna story de muestra con una forma legítima NO pasa el lint (exit $RC5) — el hook estaría frenando commits legítimos"; sed -n '1,10p' "$M5/out.txt"
  fi
  rm -rf "$M5"
fi

# ── C-06 · el PORTÓN también corre al commitear: una story a `done` sin evidencia FRENA ──────
# 🔴 Sin el bloque del portón en el hook, exit 0. El freno equivalente vive en un hook de Claude Code,
# así que un commit desde la terminal, VS Code, Codex o la web de ADO se lo saltearía sin rastro.
T=$(mktemp -d); montar "$T"
printf '%s' "$STORY_SANA" | sed 's/^status: draft/status: in-progress/' > "$T/repo/specs/story-9.9-sana.md"
( cd "$T/repo" && git add specs/story-9.9-sana.md && git -c user.email=b@b -c user.name=b commit -q -m "nace" )
printf '%s' "$STORY_SANA" | sed 's/^status: draft/status: done/' > "$T/repo/specs/story-9.9-sana.md"
( cd "$T/repo" && git add specs/story-9.9-sana.md )
RC=$(correr_hook "$T")
# La aserción exige la REGLA que rechazó (`sin-evidencia-de-cierre`), no una palabra suelta: la salida
# VERDE del portón también dice «tycon-ci-gate», y el pie de error del lint dice «evidencia» — con el
# grep laxo, un portón mutado a «línea verde + exit 1» y un lint roto sobre una story sana pasarían
# los dos por este caso.
# T25 R3_CiGate_RequiresLib: el banco no lleva el reemplazo de la ruta vieja del lint, así que
# el portón sólo llega a juzgar si su `require` del detector apunta a `scripts/lib/`.
if [ "$RC" != "0" ] && grep -q "sin-evidencia-de-cierre" "$T/out.txt"; then
  ok "C-06 (T25 R3_CiGate_RequiresLib) una story a done SIN evidencia ni revisores frena en el commit (exit $RC)"
else
  mal "C-06 (T25 R3_CiGate_RequiresLib) una story a done sin evidencia NO frenó (exit $RC) — el portón no corre al commitear"; sed -n '1,8p' "$T/out.txt"
fi
rm -rf "$T"

# ── C-07 · …y con su evidencia y su exención declarada, pasa (el espejo) ────────────────────
T=$(mktemp -d); montar "$T"
printf '%s' "$STORY_SANA" | sed 's/^status: draft/status: in-progress/' > "$T/repo/specs/story-9.9-sana.md"
( cd "$T/repo" && git add specs/story-9.9-sana.md && git -c user.email=b@b -c user.name=b commit -q -m "nace" )
printf '%s' "$STORY_SANA" | sed 's/^status: draft/status: done\ndod_runtime_exempt: true\nadvisors_exempt: true/' > "$T/repo/specs/story-9.9-sana.md"
( cd "$T/repo" && git add specs/story-9.9-sana.md )
RC=$(correr_hook "$T")
[ "$RC" = "0" ] && ok "C-07 (T25 R3_CiGate_RequiresLib) con las exenciones declaradas pasa (exit 0)" || { mal "C-07 (T25 R3_CiGate_RequiresLib) frenó una story con exenciones declaradas (exit $RC)"; sed -n '1,8p' "$T/out.txt"; }
rm -rf "$T"

# ── C-08 · la story se RENOMBRA (`git mv`) y cierra en el mismo commit → el portón la ve igual ─
# 🔴 Con `--diff-filter=ACM` el rename (R) no entra en CHANGED_MD y el hook sale 0
# mudo — ni lint ni portón — con `status: done` sin evidencia.
T=$(mktemp -d); montar "$T"
printf '%s' "$STORY_SANA" | sed 's/^status: draft/status: in-progress/' > "$T/repo/specs/story-9.9-sana.md"
( cd "$T/repo" && git add specs/story-9.9-sana.md && git -c user.email=b@b -c user.name=b commit -q -m "nace" )
( cd "$T/repo" && git mv specs/story-9.9-sana.md specs/story-9.9-renombrada.md )
printf '%s' "$STORY_SANA" | sed 's/^status: draft/status: done/' > "$T/repo/specs/story-9.9-renombrada.md"
( cd "$T/repo" && git add specs/story-9.9-renombrada.md )
RC=$(correr_hook "$T")
if [ "$RC" != "0" ] && grep -q "sin-evidencia-de-cierre" "$T/out.txt"; then
  ok "C-08 una story renombrada y cerrada en el mismo commit también frena (exit $RC)"
else
  mal "C-08 el rename dejó al portón sin correr (exit $RC)"; sed -n '1,8p' "$T/out.txt"
fi
rm -rf "$T"

# ── C-09 · `review → done` sin evidencia: el hook AVISA y deja pasar ──────
# 🔴 Si el portón `--staged` frenara (exit 1) la misma transición que el hook del skill deja pasar avisando,
# la decisión de sólo avisar viviría en una sola de las dos copias.
T=$(mktemp -d); montar "$T"
printf '%s' "$STORY_SANA" | sed 's/^status: draft/status: review/' > "$T/repo/specs/story-9.9-sana.md"
# El commit de armado va SIN hooks (`core.hooksPath=/dev/null`): el hooksPath global delega en el
# pre-commit del repo, que rechazaría «(nueva) → review» sin evidencia — y entonces HEAD nunca
# tendría la story en review, y lo que se juzgaría sería «(nueva) → done», que frena bien.
( cd "$T/repo" && git add specs/story-9.9-sana.md && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m "en review" )
printf '%s' "$STORY_SANA" | sed 's/^status: draft/status: done/' > "$T/repo/specs/story-9.9-sana.md"
( cd "$T/repo" && git add specs/story-9.9-sana.md )
RC=$(correr_hook "$T")
if [ "$RC" = "0" ] && grep -q "AVISO" "$T/out.txt" && grep -q "sin-evidencia-de-cierre" "$T/out.txt"; then
  ok "C-09 review → done sin evidencia: avisa nombrando la regla y deja pasar (exit 0)"
else
  mal "C-09 review → done: exit $RC (tiene que avisar, no frenar)"; sed -n '1,8p' "$T/out.txt"
fi
# …y con la llave, frena — la misma llave que el hook del skill
RC=$( ( cd "$T/repo" && TYCON_REVIEW_A_DONE=block bash .githooks/pre-commit ) > "$T/out2.txt" 2>&1; echo $? )
[ "$RC" != "0" ] && ok "C-09b con TYCON_REVIEW_A_DONE=block frena (exit $RC)" || { mal "C-09b con la llave no frenó"; sed -n '1,6p' "$T/out2.txt"; }
# C-10 · PARIDAD con el hook del skill sobre la MISMA transición: los dos avisan, ninguno frena.
# Las skills se buscan como en todo el arnés (TYCON_SKILLS_DIR › el propio clon si es unido › las instaladas).
SKILL_HOOK="$(node "$RAIZ/scripts/lib/skills-dir.js" --skills)/tycon-pipeline/scripts/on-pre-commit.js"
if [ -f "$SKILL_HOOK" ]; then
  H2=$(mktemp -d)
  RCS=$( printf '{"hook_event_name":"PreToolUse","tool_name":"Bash","session_id":"pcs","cwd":"%s","tool_input":{"command":"git commit -m x"}}' "$T/repo" \
        | HOME="$H2" node "$SKILL_HOOK" > "$T/skill.txt" 2>&1; echo $? )
  if [ "$RCS" = "0" ] && grep -q "AVISO" "$T/skill.txt"; then
    ok "C-10 paridad: el hook del skill también avisa y deja pasar la misma transición (exit 0)"
  else
    mal "C-10 paridad rota: el hook del skill dio exit $RCS sobre la misma transición"; sed -n '1,6p' "$T/skill.txt"
  fi
  rm -rf "$H2"
else
  echo "  ⚠️   — C-10 paridad NO verificada: no está $SKILL_HOOK (máquina sin el arnés). No es un verde."
fi
rm -rf "$T"

# ── C-11 · T24 R3_LintStory_ProductPreCommitOldPath_SameOutput ──────────────────────────────
# Los pre-commit de los repos de PRODUCTO no se tocan hasta su retiro: siguen llamando al lint por su ruta
# vieja, que es un reemplazo generado. El hook de abajo es copia literal del de un producto; sólo la línea
# de FM_LINT lleva una marca que se completa con la ruta del mapa (la ruta vieja no se escribe en este archivo: la copia
# pública no lleva ni el mapa ni los reemplazos). Se corre por la ruta vieja y por la nueva sobre una story legible y
# una ilegible: misma salida, mismo código. Con TF_BUILD=True (Azure), la vieja deja además el warning con los dos
# nombres — y fuera de esa línea, la salida es la misma.
LINT_NUEVO="scripts/lib/lint-story-frontmatter.js"
if [ ! -f "$RAIZ/scripts/lib/renames.json" ]; then
  echo "  ⏭   — C-11 (T24 R3_LintStory_ProductPreCommitOldPath_SameOutput): NO MEDIDO — copia pública sin el mapa"
else
  LINT_VIEJO=$(node -e '
    const l = require(process.argv[1]);
    const e = l.usableEntries(l.loadMap()).find((x) => x.kind === "file" && x.new === process.argv[2]);
    process.stdout.write(e ? e.old : "");
  ' "$RAIZ/scripts/lib/legacy-names.js" "$LINT_NUEVO" 2>/dev/null)
  if [ -z "$LINT_VIEJO" ]; then
    mal "C-11 (T24) el mapa no tiene la entrada de $LINT_NUEVO"
  elif [ ! -f "$RAIZ/$LINT_VIEJO" ] || [ ! -f "$RAIZ/$LINT_NUEVO" ]; then
    mal "C-11 (T24) falta el lint en su ruta nueva o el reemplazo en la vieja (legacy-names.js --write-shims)"
  else
    T=$(mktemp -d); T="$(cd "$T" && pwd -P)"
    mkdir -p "$T/home"
    cat > "$T/hook-producto.sh" <<'HOOK'
#!/usr/bin/env bash
# .githooks/pre-commit — que ninguna story se vuelva invisible para el arnés TYCON.
#
# QUÉ FRENA
# Una story cuyo frontmatter no se puede leer NO da error en ningún lado: las herramientas del
# equipo (el validator, el backfill de back-links, los scripts de status, el gate de DoD) la
# SALTEAN en silencio. Caso real 2026-07-24: 4 stories invisibles ~2 meses, una de ellas tapando
# una deuda de evidencia de DoD. El lint replica el parser real de esas herramientas: si el lint
# la lee, ellas también.
#
# CÓMO LLEGA ACÁ
# El script vive SOLO en tycon-claude-guides y se referencia por path — no se copia, para que no
# haya dos versiones que se separen. El onboarding clona ese repo en una ruta fija y el hook de
# arranque de sesión le hace `git pull`, así que está en la máquina de todo el equipo.
#
# 🔴 Por qué este archivo sirve: con `core.hooksPath` global, git IGNORA los `.githooks/` de cada repo.
# Este hook sólo corre porque el hook global del arnés DELEGA en él. Sin esa delegación, un
# `.githooks/pre-commit` sería decorativo: estaría, y no se ejecutaría nunca.
#
# Fail-open RUIDOSO: si falta el repo de guías avisa pero no bloquea — un repo hermano ausente es
# un problema de setup de la máquina, no de este commit.

set -uo pipefail

TYCON_GUIDES_DIR="${TYCON_GUIDES_DIR:-$HOME/SourceCode/tycon-claude-guides}"
FM_LINT="$TYCON_GUIDES_DIR/@@FM_LINT@@"

# Se le pasan TODOS los `.md` del commit: el filtro "esto es una story" lo hace el lint, que es el
# que sabe. Filtrarlos acá por ruta sería un bug: en un repo cuyas stories no
# viven en `specs/stories/`, el hook no le pasaría nada y el lint diría "OK" sin mirar una sola.
CHANGED_MD="$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.md$' || true)"
[ -n "$CHANGED_MD" ] || exit 0

if [ ! -f "$FM_LINT" ]; then
  echo "⚠️  No encontré $FM_LINT — se saltea el lint de frontmatter de stories." >&2
  echo "   Cloná tycon-claude-guides (onboarding) o exportá TYCON_GUIDES_DIR." >&2
  exit 0
fi

echo "▸ pre-commit: leyendo el frontmatter de las stories del commit…"
# shellcheck disable=SC2086
if ! node "$FM_LINT" $CHANGED_MD; then
  echo "" >&2
  echo "⛔ COMMIT RECHAZADO — hay stories que el arnés no puede leer (ver arriba)." >&2
  echo "   No es cosmético: una story ilegible desaparece del validator, del backfill, de los" >&2
  echo "   scripts de status y del gate de DoD, sin que nada avise." >&2
  echo "   Si sabés lo que hacés: git commit --no-verify" >&2
  exit 1
fi
exit 0
HOOK
    # producto de laboratorio: un repo con su pre-commit y una story en el índice
    prod() {   # prod <dir> <ruta del lint> <story>
      mkdir -p "$1/.githooks" "$1/docs/stories"; git init -q -b main "$1"
      L="$2" perl -pe 's/\@\@FM_LINT\@\@/$ENV{L}/' "$T/hook-producto.sh" > "$1/.githooks/pre-commit"
      printf '%s' "$3" > "$1/docs/stories/story-9.7-producto.md"; ( cd "$1" && git add -A )
    }
    # correr_prod <dir> [TF_BUILD] → salida (stdout y stderr juntos) en <dir>.out, sin las rutas del lint; imprime el código
    correr_prod() {
      ( cd "$1" && env -u TF_BUILD HOME="$T/home" TYCON_NO_NIGHTLY_EXAM=1 TYCON_GUIDES_DIR="$RAIZ" ${2:+TF_BUILD=$2} \
          bash .githooks/pre-commit ) > "$1.raw" 2>&1
      local rc=$?
      LV="$RAIZ/$LINT_VIEJO" LN="$RAIZ/$LINT_NUEVO" perl -pe 's/\Q$ENV{LV}\E/<LINT>/g; s/\Q$ENV{LN}\E/<LINT>/g' "$1.raw" > "$1.out"
      echo "$rc"
    }
    for caso in sana rota; do
      if [ "$caso" = sana ]; then S="$STORY_SANA"; else S="$STORY_ROTA"; fi
      prod "$T/viejo-$caso" "$LINT_VIEJO" "$S"; prod "$T/nuevo-$caso" "$LINT_NUEVO" "$S"
      RV=$(correr_prod "$T/viejo-$caso"); RN=$(correr_prod "$T/nuevo-$caso")
      if [ "$caso" = sana ]; then ESPERADO='[ "$RV" = 0 ]'; else ESPERADO='[ "$RV" != 0 ] && grep -q "story-9.7-producto.md" "$T/viejo-$caso.out" && grep -q "ilegible" "$T/viejo-$caso.out"'; fi
      if [ "$RV" = "$RN" ] && cmp -s "$T/viejo-$caso.out" "$T/nuevo-$caso.out" && eval "$ESPERADO"; then
        ok "C-11 (T24 R3_LintStory_ProductPreCommitOldPath_SameOutput) story $caso: el pre-commit de producto por la ruta vieja da la misma salida y el mismo código que por la nueva (exit $RV)"
      else
        mal "C-11 (T24) story $caso: vieja exit $RV, nueva exit $RN — $(diff "$T/viejo-$caso.out" "$T/nuevo-$caso.out" | head -6 | tr '\n' ' ')"
      fi
    done
    # con TF_BUILD=True: el warning con el nombre viejo y el nuevo, y el resto igual
    RV=$(correr_prod "$T/viejo-sana" True); RN=$(correr_prod "$T/nuevo-sana" True)
    W="$(grep -F '##vso[task.logissue type=warning]nombre viejo' "$T/viejo-sana.raw")"
    grep -vF '##vso[task.logissue type=warning]nombre viejo' "$T/viejo-sana.out" > "$T/viejo-sana.sin-w"
    if [ "$RV" = 0 ] && [ "$RN" = 0 ] && case "$W" in *"«${LINT_VIEJO}»"*"«${LINT_NUEVO}»"*) true ;; *) false ;; esac \
       && cmp -s "$T/viejo-sana.sin-w" "$T/nuevo-sana.out"; then
      ok "C-11 (T24) con TF_BUILD=True la ruta vieja deja el ##vso[task.logissue type=warning] con el nombre viejo y el nuevo, y nada más cambia"
    else
      mal "C-11 (T24) con TF_BUILD=True: vieja exit $RV, nueva exit $RN, warning=[$W] — $(diff "$T/viejo-sana.sin-w" "$T/nuevo-sana.out" | head -4 | tr '\n' ' ')"
    fi
    rm -rf "$T"
  fi
fi

echo
if [ "$FALLOS" -gt 0 ]; then echo "FALLARON $FALLOS chequeo(s)"; exit 1; fi
echo "todo verde"
exit 0
