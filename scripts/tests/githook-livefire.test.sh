#!/usr/bin/env bash
# githook-livefire.test.sh — la cadena de git hooks, disparada por GIT DE VERDAD (2026-09-06).
#
# ── POR QUÉ EXISTE (GITHOOK-LIVEFIRE-1, aprobado por el dev el 2026-09-06) ──────────────────────
# El banco cubre los hooks de Claude y de Codex (runner + live-fire), y la cadena de git hooks tenía
# casos… pero TODOS invocan el guion a mano (`bash .githooks/pre-commit`). Nadie hacía un commit.
# Y ése es exactamente el agujero del incidente que la motiva (`incident-log#hookspath-eclipse`):
# con `core.hooksPath` global —que el sync de engram necesita— git IGNORA el `.githooks/` de cada
# repo, así que el lint de stories, el de la wiki y el portón estaban escritos, documentados,
# adoptados… y NUNCA se ejecutaban. Invocando el guion a mano eso no se ve: se ve sólo intentando
# commitear. Lo mismo que live-fire-guard.js hace con el safety-guard, un nivel más abajo.
#
# 🔴 Lo que se asserta es el EFECTO, no el código de salida del hook: el commit NO SE CREA.
#
# Todo corre en repos de laboratorio bajo mktemp: no se toca ningún repo real, ni la config de git
# del dev (el `core.hooksPath` se pasa por `-c` en cada comando).
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GLOBAL="$RAIZ/scripts/hooks/git-pre-commit-global.sh"
POST="$RAIZ/scripts/hooks/git-post-commit-global.sh"
# `.githooks/pre-commit` sólo llama a `.githooks/pre-commit-checks`, que trae los controles: cuál copiar lo elige
# scripts/tests/lib/pre-commit-hook.js, la misma función para las tres suites
# que copian el pre-commit a un repo de juguete. Si no contesta queda el nombre de siempre y el chequeo de más abajo
# («no encontré …») decide.
HOOK_REPO="$(node "$RAIZ/scripts/tests/lib/pre-commit-hook.js" harness "$RAIZ")"   # si el ayudante falla, su error se ve
[ -n "$HOOK_REPO" ] || HOOK_REPO="$RAIZ/.githooks/pre-commit"
# Story 7.15/7.16: cada commit corre con HOME en la carpeta del caso (`$T/casa`, armada por fake_home_create
# DENTRO de la subshell del commit), así las mediciones y las constancias de los frenos no van a los registros
# reales del dev (frenos.jsonl sube al buzón y alimenta el tablero). El delegador global busca el arnés en
# `$HOME/.claude/tycon-harness` cuando no le pasan TYCON_GUIDES_DIR: el ayudante lo fija con la HOME
# real, para que la cadena sea la misma de siempre.
source "$RAIZ/scripts/tests/lib/fake-home.sh"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
# Si el ayudante no pudiera armar la HOME, el commit saldría ≠0 y los casos que esperan «no se crea» darían
# verde por el motivo equivocado: se prueba una vez acá, afuera, y sin él no se corre nada.
SONDA="$(mktemp -d)"
( fake_home_create "$SONDA/casa" ) || { echo "  MAL  — fake-home no pudo armar una HOME de prueba"; rm -rf "$SONDA"; exit 1; }
rm -rf "$SONDA"
[ -f "$GLOBAL" ]    || { echo "  MAL  — no encontré $GLOBAL"; exit 1; }
[ -f "$HOOK_REPO" ] || { echo "  MAL  — no encontré $HOOK_REPO"; exit 1; }

STORY_ROTA='---
story: "9.8"
epic: "9"
status: draft

# Story 9.8 — de juguete, rota (el frontmatter no cierra)
'
STORY_SANA='---
story: "9.9"
epic: "9"
status: draft
---

# Story 9.9 — de juguete
'

# Las rutas viejas de lo que el mapa mudó a scripts/lib/ y que el arnés todavía tiene (el reemplazo), una por línea.
lib_shims() {
  node -e 'const fs = require("fs"), path = require("path"); const [raiz, mapa] = process.argv.slice(1);
    let es = []; try { es = JSON.parse(fs.readFileSync(mapa, "utf8")).entries || []; } catch (_) { /* sin mapa: nada */ }
    for (const e of es) if (e && e.kind === "file" && String(e.new).startsWith("scripts/lib/") && fs.existsSync(path.join(raiz, e.old))) console.log(e.old);' \
    "$RAIZ" "$RAIZ/scripts/lib/renames.json"
}

# ── El laboratorio: la MISMA cadena que en la máquina del dev ─────────────────────────────────
#   core.hooksPath global → pre-commit global (el delegador) → .githooks/pre-commit del repo
montar() {
  local T="$1"
  mkdir -p "$T/hooks-globales" "$T/repo/.githooks" "$T/repo/scripts" "$T/repo/specs"
  cp "$GLOBAL" "$T/hooks-globales/pre-commit"; chmod +x "$T/hooks-globales/pre-commit"
  [ -f "$POST" ] && { cp "$POST" "$T/hooks-globales/post-commit"; chmod +x "$T/hooks-globales/post-commit"; }
  cp "$HOOK_REPO" "$T/repo/.githooks/pre-commit"; chmod +x "$T/repo/.githooks/pre-commit"
  # el lint de stories vive en scripts/lib/ desde la story 8.12 (tanda R3): viaja con la carpeta
  cp -R "$RAIZ/scripts/lib" "$RAIZ/scripts/metrics" "$RAIZ/scripts/ci" "$T/repo/scripts/" 2>/dev/null
  # y los reemplazos de lo mudado a scripts/lib/, como en el arnés (rutas del mapa, nunca escritas acá): sin ellos el mapa
  # del laboratorio (C-25) nombraría archivos mudados sin su reemplazo. Sin mapa (la copia pública) no hay nada que copiar.
  local vieja
  for vieja in $(lib_shims); do mkdir -p "$T/repo/$(dirname "$vieja")"; cp "$RAIZ/$vieja" "$T/repo/$vieja"; done
  git init -q -b main "$T/repo"
  # la base lleva TODO lo copiado (hooks apagados): el árbol arranca limpio y «quedó afuera» mide sólo lo del caso
  ( cd "$T/repo" && git add -A && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m base )
}
# Un commit REAL, con la cadena enchufada como git la enchufa.
commitear() {
  local T="$1" msg="$2"
  ( fake_home_create "$T/casa" && cd "$T/repo" \
      && git -c core.hooksPath="$T/hooks-globales" -c user.email=b@b -c user.name=b commit -q -m "$msg" ) > "$T/out.txt" 2>&1
  echo $?
}
cuantos() { git -C "$1/repo" rev-list --count HEAD; }

# ── La suite corre por partes (story 8.22, tramo F: ninguna suite pasa de 45 s en la validación de una rama). Entera
# —a mano— corre todos los bloques; como parte (`githook-livefire.p<k>.test.sh`), sólo los suyos. Lo de afuera de
# los bloques corre siempre: un bloque no puede depender de lo que dejó otro (scripts/tests/lib/suite-parts.sh).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/suite-parts.sh"
suite_parts 2
SK_ERR="$(mktemp)"   # lo usan C-06 (parte 1) y C-23 (parte 2), y se borra al final: se arma afuera de los bloques
if suite_part 1; then   # ── parte 1 de 2 ──

# ── C-01 · 🔴 EL CASO DEL INCIDENTE: una story rota, un commit de verdad → NO SE CREA ─────────
# Rojo previo verificado: con `core.hooksPath` apuntando a una carpeta SIN el delegador (el eclipse
# real), este mismo commit ENTRA — es el caso C-03 de abajo, que existe para que este verde
# signifique algo.
T=$(mktemp -d); montar "$T"; ANTES=$(cuantos "$T")
printf '%s' "$STORY_ROTA" > "$T/repo/specs/story-9.8-rota.md"
( cd "$T/repo" && git add specs/story-9.8-rota.md )
RC=$(commitear "$T" "story rota"); DESPUES=$(cuantos "$T")
if [ "$RC" != "0" ] && [ "$ANTES" = "$DESPUES" ]; then
  ok "C-01 commit REAL con una story ilegible: git NO crea el commit (exit $RC, HEAD quieto)"
else
  mal "C-01 el commit ENTRÓ (exit $RC, commits ${ANTES}→$DESPUES) — la cadena no corrió"; sed -n '1,8p' "$T/out.txt"
fi
rm -rf "$T"

# ── C-02 · el espejo: una story sana entra ────────────────────────────────────────────────────
# Sin este caso el control se apaga a la semana: una cadena que rechaza todo también está rota.
T=$(mktemp -d); montar "$T"; ANTES=$(cuantos "$T")
printf '%s' "$STORY_SANA" > "$T/repo/specs/story-9.9-sana.md"
( cd "$T/repo" && git add specs/story-9.9-sana.md )
RC=$(commitear "$T" "story sana"); DESPUES=$(cuantos "$T")
if [ "$RC" = "0" ] && [ "$DESPUES" = "$((ANTES + 1))" ]; then
  ok "C-02 commit REAL con una story sana: entra (exit 0, HEAD avanzó)"
else
  mal "C-02 una story sana fue frenada (exit $RC, commits ${ANTES}→$DESPUES)"; sed -n '1,8p' "$T/out.txt"
fi
rm -rf "$T"

# ── C-03 · 🔴 EL ECLIPSE, reproducido: sin el delegador global, el hook del repo NO corre ──────
# `core.hooksPath` apunta a una carpeta sin `pre-commit`: git ignora el `.githooks/` del repo y la
# story rota entra. Es el incidente `hookspath-eclipse` tal cual, y lo que le da sentido a C-01.
T=$(mktemp -d); montar "$T"; mkdir -p "$T/hooks-vacios"; ANTES=$(cuantos "$T")
printf '%s' "$STORY_ROTA" > "$T/repo/specs/story-9.8-rota.md"
( cd "$T/repo" && git add specs/story-9.8-rota.md )
RC=$( ( cd "$T/repo" && git -c core.hooksPath="$T/hooks-vacios" -c user.email=b@b -c user.name=b commit -q -m "eclipse" ) >/dev/null 2>&1; echo $? )
DESPUES=$(cuantos "$T")
if [ "$RC" = "0" ] && [ "$DESPUES" = "$((ANTES + 1))" ]; then
  ok "C-03 sin el delegador global, la MISMA story rota entra: el eclipse es real (y C-01 significa algo)"
else
  mal "C-03 el eclipse no se reprodujo (exit $RC, commits ${ANTES}→$DESPUES) — revisar el montaje"
fi
rm -rf "$T"

# ── C-04 · el delegador AVISA si el hook del repo no tiene permiso de ejecución, y no frena ───
T=$(mktemp -d); montar "$T"; chmod -x "$T/repo/.githooks/pre-commit"; ANTES=$(cuantos "$T")
echo 'x' > "$T/repo/nota.txt"; ( cd "$T/repo" && git add nota.txt )
RC=$(commitear "$T" "sin permiso"); DESPUES=$(cuantos "$T")
if [ "$RC" = "0" ] && [ "$DESPUES" = "$((ANTES + 1))" ] && grep -qiE "permiso|ejecut|chmod" "$T/out.txt"; then
  ok "C-04 hook del repo sin permiso de ejecución: avisa y deja pasar (fail-open ruidoso)"
else
  mal "C-04 exit $RC, commits ${ANTES}→$DESPUES, salida sin aviso"; sed -n '1,8p' "$T/out.txt"
fi
rm -rf "$T"

# ── C-05 · un repo SIN .githooks/ no paga nada ───────────────────────────────────────────────
T=$(mktemp -d); montar "$T"; rm -rf "$T/repo/.githooks"; ANTES=$(cuantos "$T")
echo 'x' > "$T/repo/nota.txt"; ( cd "$T/repo" && git add nota.txt )
RC=$(commitear "$T" "sin githooks"); DESPUES=$(cuantos "$T")
if [ "$RC" = "0" ] && [ "$DESPUES" = "$((ANTES + 1))" ]; then
  ok "C-05 un repo sin .githooks/ commitea normal"
else
  mal "C-05 exit $RC, commits ${ANTES}→$DESPUES"; sed -n '1,8p' "$T/out.txt"
fi
rm -rf "$T"

# ── C-06 · el pre-commit de AgentSkills, disparado por git de verdad ──────────────────────────
# Es el tercero de la familia y no tenía NINGÚN caso. Su regla: si el commit toca `agents/*.md`,
# la traducción a Codex tiene que estar al día. 🔴 El chequeo NO vive en su repo: lo resuelve en
# `TYCON_GUIDES_DIR` (o `~/SourceCode/tycon-claude-guides`) — lo descubrió este mismo caso, que en
# su primera versión puso el chequeo de juguete en el repo y el hook corrió el REAL, dando verde
# por el motivo equivocado. Se apunta la variable a un arnés de juguete: así se prueba la CADENA
# (que git lo corra y que el rechazo llegue), no la lógica del chequeo, que tiene su propia red.
# El clon de agent-skills: la regla común (TYCON_SKILLS_DIR › el propio clon si es unido › ~/.claude/agent-skills).
# Si la biblioteca no puede contestar es un rojo con la causa (story 8.18, pase adversarial del tramo 2, clases 4 y 7):
# antes caía callada a la ruta instalada y C-06 a C-08 probaban el pre-commit de OTRO clon.
AS_REPO="" AS_HOOK=""
if ! AS_REPO="$(node -e 'try { console.log(require(process.argv[1]).resolveSkillsDirs(process.env.TYCON_SKILLS_DIR || "").repo); } catch (e) { console.error(String((e && e.message) || e).split("\n")[0]); process.exit(1); }' "$RAIZ/scripts/lib/skills-dir.js" 2> "$SK_ERR")"; then
  mal "C-06/C-07/C-08 no pude resolver la carpeta de skills: $(head -n 1 "$SK_ERR")"; AS_REPO=""
else
  # el guion de los controles de las skills según el layout (en el arnés, `pre-commit-checks`, no el que lo llama)
  AS_HOOK="$(node "$RAIZ/scripts/tests/lib/pre-commit-hook.js" skills "${AS_REPO}")"
  [ -n "$AS_HOOK" ] || AS_HOOK="${AS_REPO}/.githooks/pre-commit"
fi
if [ -z "$AS_REPO" ]; then
  :   # ya contado arriba como rojo
elif [ -f "$AS_HOOK" ]; then
  montar_as() {   # $1=T  $2=exit del chequeo de juguete (vacío = sin chequeo, para el fail-open)
    local T="$1" RC="${2:-}"
    mkdir -p "$T/hooks-globales" "$T/repo/.githooks" "$T/repo/agents" "$T/tcg-juguete/build"
    cp "$GLOBAL" "$T/hooks-globales/pre-commit"; chmod +x "$T/hooks-globales/pre-commit"
    cp "$AS_HOOK" "$T/repo/.githooks/pre-commit"; chmod +x "$T/repo/.githooks/pre-commit"
    [ -n "$RC" ] && printf '#!/usr/bin/env node\nconsole.error("❌ los .toml no están al día (chequeo de juguete)");\nprocess.exit(%s);\n' "$RC" > "$T/tcg-juguete/build/check.js"
    git init -q -b main "$T/repo"
    ( cd "$T/repo" && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q --allow-empty -m base )
    printf -- '---\nname: tycon-de-juguete\n---\n# advisor\n' > "$T/repo/agents/tycon-de-juguete.md"
    ( cd "$T/repo" && git add agents/tycon-de-juguete.md )
  }
  commitear_as() {
    ( fake_home_create "$1/casa" && cd "$1/repo" && TYCON_GUIDES_DIR="$1/tcg-juguete" git -c core.hooksPath="$1/hooks-globales" -c user.email=b@b -c user.name=b commit -q -m "$2" ) > "$1/out.txt" 2>&1
    echo $?
  }

  T=$(mktemp -d); montar_as "$T" 1; ANTES=$(cuantos "$T")
  RC=$(commitear_as "$T" "advisor sin regenerar"); DESPUES=$(cuantos "$T")
  if [ "$RC" != "0" ] && [ "$ANTES" = "$DESPUES" ] && grep -q "chequeo de juguete" "$T/out.txt"; then
    ok "C-06 AgentSkills: tocar un advisor con la traducción vieja NO crea el commit (exit $RC)"
  else
    mal "C-06 el commit de AgentSkills entró (exit $RC, commits ${ANTES}→$DESPUES)"; sed -n '1,8p' "$T/out.txt"
  fi
  rm -rf "$T"

  # C-06b · story 8.41: los revisores de un stack viven en la carpeta de agentes de su paquete; tocar uno corre el mismo
  # chequeo (antes el hook miraba sólo `agents/*.md` y el commit entraba con la traducción vieja)
  T=$(mktemp -d); montar_as "$T" 1
  ( cd "$T/repo" && git rm -q --cached agents/tycon-de-juguete.md && mkdir -p packs/paq-juguete/agents \
    && mv agents/tycon-de-juguete.md packs/paq-juguete/agents/ && git add packs/paq-juguete/agents/tycon-de-juguete.md )
  ANTES=$(cuantos "$T")
  RC=$(commitear_as "$T" "revisor de paquete sin regenerar"); DESPUES=$(cuantos "$T")
  # (frena POR el chequeo: su mensaje llega; un freno por otra causa no cuenta)
  if [ "$RC" != "0" ] && [ "$ANTES" = "$DESPUES" ] && grep -q "chequeo de juguete" "$T/out.txt"; then
    ok "C-06b AgentSkills: tocar un revisor de un paquete con la traducción vieja NO crea el commit (exit $RC)"
  else
    mal "C-06b el commit que toca un revisor de paquete entró (exit $RC, commits ${ANTES}→$DESPUES)"; sed -n '1,8p' "$T/out.txt"
  fi
  rm -rf "$T"

  # C-07 · el espejo: con la traducción al día, el mismo commit entra
  T=$(mktemp -d); montar_as "$T" 0; ANTES=$(cuantos "$T")
  RC=$(commitear_as "$T" "advisor al día"); DESPUES=$(cuantos "$T")
  if [ "$RC" = "0" ] && [ "$DESPUES" = "$((ANTES + 1))" ]; then
    ok "C-07 AgentSkills: con la traducción al día, el commit entra"
  else
    mal "C-07 frenó un commit legítimo (exit $RC, commits ${ANTES}→$DESPUES)"; sed -n '1,8p' "$T/out.txt"
  fi
  rm -rf "$T"

  # C-08 · sin el arnés en la máquina: avisa FUERTE y deja pasar (fail-open ruidoso, declarado)
  T=$(mktemp -d); montar_as "$T" ""; ANTES=$(cuantos "$T")
  RC=$(commitear_as "$T" "sin el arnes"); DESPUES=$(cuantos "$T")
  if [ "$RC" = "0" ] && [ "$DESPUES" = "$((ANTES + 1))" ] && grep -q "no pude correr el check de paridad" "$T/out.txt"; then
    ok "C-08 AgentSkills sin el arnés: avisa fuerte y deja pasar"
  else
    mal "C-08 exit $RC, commits ${ANTES}→$DESPUES, salida sin el aviso"; sed -n '1,8p' "$T/out.txt"
  fi
  rm -rf "$T"
else
  echo "  ⚠️   — C-06/C-07/C-08 NO verificados: no está $AS_HOOK (máquina sin agent-skills). No es un verde."
fi


# ── C-09 · 🔴 COMMIT-DEJA-AFUERA-1: un commit REAL que deja archivos atrás → git lo dice ──────
# Rojo previo: sin `hooks-globales/post-commit` el mismo commit entra en silencio (es C-10b).
if [ -f "$POST" ]; then
  T=$(mktemp -d); montar "$T"
  printf 'a\n' > "$T/repo/a.txt"; printf 'b\n' > "$T/repo/b.txt"
  ( cd "$T/repo" && git add a.txt b.txt && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m dos )
  printf 'a2\n' > "$T/repo/a.txt"; printf 'b2\n' > "$T/repo/b.txt"; printf 'n\n' > "$T/repo/nuevo.md"
  ( cd "$T/repo" && git add a.txt )
  RC=$(commitear "$T" "uno solo")
  if [ "$RC" = "0" ] && grep -q "quedaron afuera del commit" "$T/out.txt" && grep -q "b.txt" "$T/out.txt" && grep -q "nuevo.md" "$T/out.txt" && ! grep -q "a.txt" "$T/out.txt"; then
    ok "C-09 commit REAL que deja b.txt y nuevo.md afuera: git imprime la línea, y no nombra al que entró"
  else
    mal "C-09 exit $RC, salida sin la línea (o nombra al que entró)"; sed -n '1,8p' "$T/out.txt"
  fi
  rm -rf "$T"

  # ── C-10 · el espejo: commit completo → ni una línea; y sin el hook, el C-09 es mudo ─────────
  T=$(mktemp -d); montar "$T"
  printf 'a\n' > "$T/repo/a.txt"; ( cd "$T/repo" && git add a.txt )
  RC=$(commitear "$T" "todo")
  if [ "$RC" = "0" ] && ! grep -q "quedaron afuera" "$T/out.txt"; then
    ok "C-10 commit completo: silencio"
  else
    mal "C-10 exit $RC o habló de más"; sed -n '1,8p' "$T/out.txt"
  fi
  rm -rf "$T"
  T=$(mktemp -d); montar "$T"; rm -f "$T/hooks-globales/post-commit"
  printf 'a\n' > "$T/repo/a.txt"; printf 'b\n' > "$T/repo/b.txt"; ( cd "$T/repo" && git add a.txt )
  RC=$(commitear "$T" "sin hook")
  if [ "$RC" = "0" ] && ! grep -q "quedaron afuera" "$T/out.txt"; then
    ok "C-10b sin el post-commit global el mismo commit deja b.txt atrás en SILENCIO (el rojo previo de C-09)"
  else
    mal "C-10b exit $RC — sin el hook no debería hablar nadie"; sed -n '1,8p' "$T/out.txt"
  fi
  rm -rf "$T"
else
  echo "  ⚠️   — C-09/C-10 NO verificados: no está $POST. No es un verde."
fi
# ── C-11 · el presupuesto de los archivos IMPORTADOS frena un commit REAL (story 7.4) ──────────
# El bloque del pre-commit se disparaba sólo con `claude-md-blocks/`. El README —que cada máquina
# importa ENTERO en cada sesión y en cada subagente— no estaba en ese disparo, así que su techo
# podía pasarse sin que nada corriera. Rojo previo: con el `grep` viejo este commit ENTRA (C-11b).
T=$(mktemp -d); montar "$T"
mkdir -p "$T/repo/claude-md-blocks" "$T/repo/guides"
cat > "$T/repo/claude-md-blocks/budget.json" <<'JSON'
{ "default": 6000, "imported": { "README.md": { "ceiling": 55000, "max_input": 400, "detail": "guides/piezas-del-arnes.md" } } }
JSON
printf '# piezas\n\n## scripts/uno.js\n\nel detalle.\n' > "$T/repo/guides/piezas-del-arnes.md"
printf '# r\n\n- **[scripts/uno.js](scripts/uno.js)** — hace uno. [detalle](guides/piezas-del-arnes.md#scriptsunojs)\n' > "$T/repo/README.md"
( cd "$T/repo" && git add -A && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m "presupuesto base" )
ANTES=$(cuantos "$T")
# ahora el README se pasa de su techo (70 KB contra 55.000)
{ printf '# r\n\n'; head -c 70000 /dev/zero | tr '\0' 'q'; printf '\n\n- **[scripts/uno.js](scripts/uno.js)** — hace uno. [detalle](guides/piezas-del-arnes.md#scriptsunojs)\n'; } > "$T/repo/README.md"
( cd "$T/repo" && git add README.md )
RC=$(commitear "$T" "README gordo")
if [ "$RC" != "0" ] && [ "$(cuantos "$T")" = "$ANTES" ] && grep -qi "README" "$T/out.txt"; then
  ok "C-11 un README que se pasa de su techo NO deja crear el commit, y el mensaje lo nombra"
else
  mal "C-11 exit $RC · commits ${ANTES}→$(cuantos "$T")"; sed -n '1,10p' "$T/out.txt"
fi
# C-11b · el mismo commit, con el README bajo el techo y una pieza NUEVA bien declarada → entra
printf '# r\n\n- **[scripts/uno.js](scripts/uno.js)** — hace uno. [detalle](guides/piezas-del-arnes.md#scriptsunojs)\n- **[scripts/dos.js](scripts/dos.js)** — hace dos. [detalle](guides/piezas-del-arnes.md#scriptsdosjs)\n' > "$T/repo/README.md"
printf '# piezas\n\n## scripts/uno.js\n\nel detalle.\n\n## scripts/dos.js\n\nel otro detalle.\n' > "$T/repo/guides/piezas-del-arnes.md"
( cd "$T/repo" && git add README.md guides/piezas-del-arnes.md )
RC=$(commitear "$T" "README flaco")
if [ "$RC" = "0" ] && [ "$(cuantos "$T")" -gt "$ANTES" ]; then
  ok "C-11b con el README dentro del techo el commit se crea (el control no frena de más)"
else
  mal "C-11b exit $RC — el commit legítimo no entró"; sed -n '1,10p' "$T/out.txt"
fi
# C-11c · tocar SÓLO la guía del detalle también dispara el chequeo (si no, se puede romper el par
# índice↔guía borrando una sección desde el lado de la guía sin que nada mire)
printf '# piezas\n\n## scripts/uno.js\n\nel detalle.\n\n## scripts/dos.js\n\nel otro detalle.\n\n## sobra\n\nnadie la enlaza.\n' > "$T/repo/guides/piezas-del-arnes.md"
( cd "$T/repo" && git add guides/piezas-del-arnes.md )
RC=$(commitear "$T" "sección huérfana en la guía")
if [ "$RC" != "0" ] && grep -qi "sobra" "$T/out.txt"; then
  ok "C-11c una sección de la guía que el índice no enlaza frena el commit (el disparo incluye la guía)"
else
  mal "C-11c exit $RC — tocar sólo la guía no disparó el chequeo"; sed -n '1,10p' "$T/out.txt"
fi
rm -rf "$T"

# C-11d · 🔴 si FALTA el guion del presupuesto, el commit NO se crea. Hasta la 7.4 acá se avisaba
# por stderr y el commit entraba igual, mientras el mismo bloque SÍ frenaba cuando el guion corría y
# no podía medir: la misma pregunta con dos respuestas. Y de este bloque cuelga el techo del README,
# que es lo que cada sesión importa entero. Rojo previo: sin el `exit 1`, este commit entra.
T=$(mktemp -d); montar "$T"
mkdir -p "$T/repo/claude-md-blocks" "$T/repo/guides"
printf '{ "default": 6000, "imported": { "README.md": { "ceiling": 55000 } } }\n' > "$T/repo/claude-md-blocks/budget.json"
printf '# r\n' > "$T/repo/README.md"
( cd "$T/repo" && git add -A && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m "base con presupuesto" )
rm -f "$T/repo/scripts/ci/check-claude-md-blocks.js"     # el checkout quedó incompleto
ANTES=$(cuantos "$T")
printf '# r\n\n- **[x](x)** — algo. \n' > "$T/repo/README.md"; ( cd "$T/repo" && git add README.md )
RC=$(commitear "$T" "README tocado sin el guion")
if [ "$RC" != "0" ] && [ "$(cuantos "$T")" = "$ANTES" ] && grep -qi "no pude medir\|RECHAZADO" "$T/out.txt"; then
  ok "C-11d sin el guion del presupuesto el commit NO se crea (no medido no es verde)"
else
  mal "C-11d exit $RC · commits ${ANTES}→$(cuantos "$T") — el commit entró sin que nada midiera"; sed -n '1,8p' "$T/out.txt"
fi
rm -rf "$T"

# ── C-12 · reglas del CLAUDE.md fuera de «Reglas para revisores»: git AVISA y el commit ENTRA (7.5) ──
# Los revisores del pipeline no cargan el CLAUDE.md: una regla escrita fuera de la sección no la ven.
# El aviso tiene que salir en un commit REAL y no puede frenarlo. Sin llave de TypeSafe (se quita del
# ambiente): avisa toda línea nueva fuera de la sección. Rojo previo: sin el bloque 1b' del pre-commit
# global, el commit entra en silencio.
T=$(mktemp -d); montar "$T"; rm -rf "$T/repo/.githooks"
printf '# r\n\n## Reglas para revisores\n\n- Nunca SQL concatenado.\n' > "$T/repo/CLAUDE.md"
( cd "$T/repo" && git add CLAUDE.md && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m "claude.md base" )
ANTES=$(cuantos "$T")
printf '\n## Otra\n\n- Las tablas nuevas no llevan prefijo XX_.\n' >> "$T/repo/CLAUDE.md"; ( cd "$T/repo" && git add CLAUDE.md )
RC=$( ( export TYCON_GUIDES_DIR="$RAIZ" TYCON_SQL_COMPILE=0; unset TYPESAFE_API_KEY; commitear "$T" "regla fuera de la sección" ) )
if [ "$RC" = "0" ] && [ "$(cuantos "$T")" = "$((ANTES + 1))" ] && grep -q 'movela a «Reglas para revisores»' "$T/out.txt" && grep -q 'sin TypeSafe' "$T/out.txt"; then
  ok "C-12 una regla fuera de la sección: git avisa y el commit entra"
else
  mal "C-12 exit $RC · commits ${ANTES}→$(cuantos "$T") — sin aviso o frenó"; sed -n '1,8p' "$T/out.txt"
fi
# T21 (story 7.15): la medición del aviso va a la HOME de la prueba, no al reviewer-rules.jsonl real.
# Evidencia POSITIVA; rojo previo: sin HOME temporal en commitear, el archivo de la prueba no existe.
if [ "$(FAKE_HOME="$T/casa" fake_home_count reviewer-rules.jsonl '"archivo":"CLAUDE.md"')" -gt 0 ]; then
  ok "C-12 T21 la medición del aviso quedó en la HOME de la prueba, no en la real"
else
  mal "C-12 T21 🔴 la medición del aviso no está en la HOME de la prueba: fue al reviewer-rules.jsonl real del dev"
fi
rm -rf "$T"

# ── C-13..C-15 · el freno de nombres nuevos, disparado por git de verdad (story 8.10, T22-T24) ──
fi   # ── lo que sigue lo usan las dos partes: queda fuera de los bloques ──
# El arnés de laboratorio lleva el freno y una configuración SINTÉTICA (AcmeCorp→Ceibo): nunca la
# lista ni la tabla reales. agent-skills de laboratorio al lado (TYCON_SKILLS_DIR), con un paquete.
# La ruta vieja de un archivo mudado, del mapa (nunca escrita acá); sin mapa (la copia pública), nada.
old_path_of() {   # $1 = la ruta nueva
  node -e 'try { const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).entries
    .find((x) => x && x.kind === "file" && x.new === process.argv[2]); console.log(e ? e.old : ""); } catch (_) { console.log(""); }' \
    "$RAIZ/scripts/lib/renames.json" "$1"
}
# Copia al laboratorio cada archivo de publicación (por su ruta nueva) y su reemplazo en la ruta vieja, como en el arnés:
# sin el reemplazo, el mapa del laboratorio (C-25) no pasa la validación. Sin mapa no hay reemplazo que copiar.
copy_publishing() {   # $1=T, el resto: nombres dentro de scripts/publishing/
  local T="$1" f old; shift
  for f in "$@"; do
    cp "$RAIZ/scripts/publishing/$f" "$T/repo/scripts/publishing/$f"
    old="$(old_path_of "scripts/publishing/$f")"
    if [ -n "$old" ] && [ -f "$RAIZ/$old" ]; then mkdir -p "$T/repo/$(dirname "$old")"; cp "$RAIZ/$old" "$T/repo/$old"; fi
  done
}
montar_nombres() {   # $1=T — montar + el freno + su configuración + un agent-skills de laboratorio
  local T="$1"
  montar "$T"
  mkdir -p "$T/repo/scripts/publishing" "$T/repo/guides" "$T/skills/packs/clientes" "$T/skills/skills/tycon-x"
  # el freno, el exportador y el detector, en su carpeta (story 8.9, tanda C4)
  copy_publishing "$T" new-names.js export.js public-copy.js detector.js
  printf '%s\n' '{"packages":{"nucleo":{"arnes":{"in":["guides/**","scripts/**",".githooks/**"],"out":[]},"agent-skills":{"in":["skills/tycon-*/**",".githooks/**"],"out":[{"glob":"packs/**","reason":"prueba"}]}}}}' > "$T/repo/scripts/publishing/allowlist.json"
  printf '%s\n' '{"terminos":[{"patron":"AcmeCorp","categoria":"cliente","palabra":true}]}' > "$T/repo/scripts/publishing/denylist.json"
  printf '%s\n' '{"pares":[{"real":"AcmeCorp","categoria":"cliente","palabra":true,"formas":[{"texto":"AcmeCorp","anonimo":"Ceibo"}]}],"afuera":[]}' > "$T/repo/scripts/publishing/replacements.json"
  printf '# Guía\n\nUna línea.\n' > "$T/repo/guides/x.md"
  ( cd "$T/repo" && git add -A && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m "el freno y su configuración" )
  printf '%s\n' '{"name":"clientes","reviewers":[]}' > "$T/skills/packs/clientes/pack.json"
  printf '# Skill\n' > "$T/skills/skills/tycon-x/SKILL.md"
  git init -q -b main "$T/skills"
  ( cd "$T/skills" && git add -A && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m base )
}
commitear_nombres() {   # $1=T $2=mensaje $3...=opciones de git commit — con la cadena real y el agent-skills del laboratorio
  local T="$1" msg="$2"; shift 2
  ( fake_home_create "$T/casa" && cd "$T/repo" && TYCON_SKILLS_DIR="$T/skills" \
      git -c core.hooksPath="$T/hooks-globales" -c user.email=b@b -c user.name=b commit -q "$@" -m "$msg" ) > "$T/out.txt" 2>&1
  echo $?
}
if suite_part 1; then   # ── sigue la parte 1 ──

# C-13 · T22 GitHook_Harness_NewName_CommitNotCreated — un nombre nuevo en un archivo que sale: NO se crea
T=$(mktemp -d); montar_nombres "$T"; ANTES=$(cuantos "$T")
printf '# Guía\n\nUna línea.\nLo usa AcmeCorp.\n' > "$T/repo/guides/x.md"; ( cd "$T/repo" && git add guides/x.md )
RC=$(commitear_nombres "$T" "un nombre nuevo")
if [ "$RC" != "0" ] && [ "$(cuantos "$T")" = "$ANTES" ] && grep -q 'guides/x.md:4' "$T/out.txt" && grep -q '«Ceibo»' "$T/out.txt"; then
  ok "C-13 T22 GitHook_Harness_NewName_CommitNotCreated: un nombre nuevo en lo que se publica, el commit NO se crea (y dice dónde y el nombre inventado)"
else
  mal "C-13 T22 exit $RC · commits ${ANTES}→$(cuantos "$T") — el commit entró o no dijo dónde"; sed -n '1,12p' "$T/out.txt"
fi
# el espejo: una línea limpia entra (una cadena que rechaza todo también está rota)
printf '# Guía\n\nUna línea.\nOtra línea limpia.\n' > "$T/repo/guides/x.md"; ( cd "$T/repo" && git add guides/x.md )
RC=$(commitear_nombres "$T" "una línea limpia")
if [ "$RC" = "0" ] && [ "$(cuantos "$T")" = "$((ANTES + 1))" ]; then ok "C-13 T22 el espejo: una línea limpia entra"
else mal "C-13 T22 el espejo: una línea limpia fue frenada (exit $RC)"; sed -n '1,12p' "$T/out.txt"; fi
# T21 (story 7.15): el freno de nombres deja su medición y su constancia (frenos.jsonl sube al buzón y
# alimenta el tablero) en la HOME de la prueba. Evidencia POSITIVA; rojo previo: fueron a la HOME real.
if [ "$(FAKE_HOME="$T/casa" fake_home_count new-names.jsonl '"outcome"')" -gt 0 ] \
   && [ "$(FAKE_HOME="$T/casa" fake_home_count frenos.jsonl '"freno":"new-names"')" -gt 0 ]; then
  ok "C-13 T21 new-names.jsonl y la constancia del freno quedaron en la HOME de la prueba, no en la real"
else
  mal "C-13 T21 🔴 la medición o la constancia del freno de nombres no están en la HOME de la prueba: fueron a la real"
fi
rm -rf "$T"

# C-14 · T23 GitHook_Harness_CommitAmAndWithPath_NotCreated — `commit -a` y `commit <ruta>`: git le pasa al hook OTRO
# índice (GIT_INDEX_FILE). Un freno que leyera el de siempre (o que borrara GIT_* como el git del exportador) no vería nada.
T=$(mktemp -d); montar_nombres "$T"; ANTES=$(cuantos "$T")
printf '# Guía\n\nUna línea.\nLo usa AcmeCorp.\n' > "$T/repo/guides/x.md"
RC_A=$(commitear_nombres "$T" "commit -a" -a); DESPUES_A=$(cuantos "$T")
RC_R=$(commitear_nombres "$T" "commit con ruta" -- guides/x.md); DESPUES_R=$(cuantos "$T")
if [ "$RC_A" != "0" ] && [ "$RC_R" != "0" ] && [ "$DESPUES_A" = "$ANTES" ] && [ "$DESPUES_R" = "$ANTES" ]; then
  ok "C-14 T23 GitHook_Harness_CommitAmAndWithPath_NotCreated: con -a y con <ruta>, sin git add, el commit NO se crea"
else
  mal "C-14 T23 -a: exit ${RC_A} (commits ${ANTES}→${DESPUES_A}) · <ruta>: exit ${RC_R} (→${DESPUES_R})"; sed -n '1,12p' "$T/out.txt"
fi
rm -rf "$T"

# C-15 · T24 GitHook_AgentSkills_NewNameWithoutHarnessOrScript — el pre-commit de agent-skills llama al freno del arnés:
# con el freno, no se crea; sin el arnés o con un arnés atrasado (sin el guion), avisa fuerte y deja pasar.
if [ -f "$AS_HOOK" ]; then
  T=$(mktemp -d); montar_nombres "$T"
  mkdir -p "$T/skills/.githooks"; cp "$AS_HOOK" "$T/skills/.githooks/pre-commit"; chmod +x "$T/skills/.githooks/pre-commit"
  ( cd "$T/skills" && git add -A && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m hook )
  commitear_skills() {   # $1=T $2=TYCON_GUIDES_DIR $3=mensaje
    ( fake_home_create "$1/casa" && cd "$1/skills" && TYCON_GUIDES_DIR="$2" TYCON_SKILLS_DIR="$1/skills" git -c core.hooksPath="$1/hooks-globales" -c user.email=b@b -c user.name=b commit -q -m "$3" ) > "$1/out.txt" 2>&1
    echo $?
  }
  cuantos_skills() { git -C "$1/skills" rev-list --count HEAD; }
  ANTES=$(cuantos_skills "$T")
  printf '# Skill\n\nLo usa AcmeCorp.\n' > "$T/skills/skills/tycon-x/SKILL.md"; ( cd "$T/skills" && git add -A )
  RC=$(commitear_skills "$T" "$T/repo" "un nombre nuevo en agent-skills")
  if [ "$RC" != "0" ] && [ "$(cuantos_skills "$T")" = "$ANTES" ] && grep -q 'skills/tycon-x/SKILL.md:3' "$T/out.txt"; then
    ok "C-15 T24 GitHook_AgentSkills_NewNameWithoutHarnessOrScript: con el freno del arnés, el commit de agent-skills NO se crea"
  else
    mal "C-15 T24 exit $RC · commits ${ANTES}→$(cuantos_skills "$T") — el commit entró"; sed -n '1,12p' "$T/out.txt"
  fi
  VACIA="$(mktemp -d)"
  RC=$(commitear_skills "$T" "$VACIA" "sin el arnés")
  if [ "$RC" = "0" ] && [ "$(cuantos_skills "$T")" = "$((ANTES + 1))" ] && grep -q 'NO se miró si este commit mete nombres' "$T/out.txt"; then
    ok "C-15 T24 sin el arnés: el commit entra con el aviso fuerte"
  else
    mal "C-15 T24 sin el arnés: exit $RC, commits ${ANTES}→$(cuantos_skills "$T"), sin el aviso"; sed -n '1,12p' "$T/out.txt"
  fi
  printf '# Skill\n\nLo usa AcmeCorp otra vez.\n' > "$T/skills/skills/tycon-x/SKILL.md"; ( cd "$T/skills" && git add -A )
  # un arnés sin el guion: ni en la carpeta nueva ni su reemplazo en la vieja (el pre-commit de agent-skills mira las dos)
  rm -f "$T/repo/scripts/publishing/new-names.js"
  OLD_NN="$(old_path_of scripts/publishing/new-names.js)"; [ -n "$OLD_NN" ] && rm -f "$T/repo/$OLD_NN"
  RC=$(commitear_skills "$T" "$T/repo" "arnés atrasado")
  if [ "$RC" = "0" ] && [ "$(cuantos_skills "$T")" = "$((ANTES + 2))" ] && grep -q 'actualizá el arnés' "$T/out.txt"; then
    ok "C-15 T24 con un arnés sin el guion: el commit entra con el aviso fuerte («actualizá el arnés»)"
  else
    mal "C-15 T24 arnés sin el guion: exit $RC, commits →$(cuantos_skills "$T"), sin el aviso"; sed -n '1,12p' "$T/out.txt"
  fi
  rm -rf "$T" "$VACIA"
else
  echo "  ⚠️   — C-15 (T24) NO verificado: no está $AS_HOOK (máquina sin agent-skills). No es un verde."
fi

fi   # ── lo que sigue lo usan las dos partes: queda fuera de los bloques ──

# ── C-16..C-24 · el freno de nombres nuevos en castellano, disparado por git de verdad (story 8.9, T6-T13, T15) ──
# El laboratorio es el de C-13 más el freno nuevo, la lista REAL de palabras (scripts/lib/spanish-words.json, que
# `montar` copia con scripts/lib) y un perfil de laboratorio (modo equipo: lo que sale lo decide la lista blanca). Los
# nombres castellanos de los casos se arman partidos (`co""pia`): este archivo sale en la copia pública y el freno lo
# mira como a cualquier ejecutable (AC 7). En los archivos del laboratorio quedan literales.
montar_castellano() {   # $1=T
  local T="$1"
  montar_nombres "$T"
  # con el perfil del equipo el pre-commit exige también el control de historia interna (story 8.26, tanda G3: sin el
  # guion, en un clon del equipo, el commit no se crea); va con su configuración
  copy_publishing "$T" spanish-names.js internal-history.js internal-history.json
  printf '%s\n' '{"__doc":"perfil de laboratorio"}' > "$T/repo/perfil-equipo.json"
  printf '%s\n' '{"packages":{"nucleo":{"arnes":{"in":["guides/**","scripts/**",".githooks/**"],"out":[]},"agent-skills":{"in":["skills/tycon-*/**"],"out":[{"glob":"packs/**","reason":"prueba"}]}}}}' > "$T/repo/scripts/publishing/allowlist.json"
  printf 'const x = 1;\n' > "$T/repo/scripts/english-tool.js"
  ( cd "$T/repo" && git add -A && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m "el freno en castellano" )
}
# Sin diccionario inglés (el nocturno es Linux) una palabra que no está en la lista pasa por inglés: lo que depende de
# eso se declara NO verificado, y el aviso «sin diccionario» no cuenta como que el freno habló (corrida 11337).
DICC="${TYCON_SPANISH_NAMES_DICTIONARY:-/usr/share/dict/words}"
# (el control corre también la parte de las skills, que en este repo de juguete —sin la forma del arnés— no encuentra
# «el otro repo» y lo avisa, sin frenar: ese aviso no es el freno hablando de un nombre)
hablo_el_freno() { grep -v 'sin diccionario inglés' "$1" | grep -v 'no encontré arnes' | grep 'castellano' >/dev/null; }
C_OPT="--si""n-copia"; C_SUB="lim""piar"; C_ENV="TYCON_NO_BA""JAR"; C_KEY="moti""vo"; C_FILE="car""gar-da""tos"
nuevo_bloqueado() {   # $1=T $2=etiqueta $3...=patrones que el mensaje tiene que traer
  local T="$1" etiqueta="$2"; shift 2
  local ANTES; ANTES=$(cuantos "$T")
  local RC; RC=$(commitear_nombres "$T" "$etiqueta")
  local falta=""
  for p in "$@" 'Cómo salir' '(a) ' '(b) ' 'allowed'; do grep -qF -- "$p" "$T/out.txt" || falta="${falta} «${p}»"; done
  if [ "$RC" != "0" ] && [ "$(cuantos "$T")" = "$ANTES" ] && [ -z "$falta" ]; then
    ok "C-16 T6 ${etiqueta}: el commit NO se crea y el mensaje dice dónde, qué, las palabras, la propuesta y las salidas"
  else
    mal "C-16 T6 ${etiqueta}: exit $RC · commits ${ANTES}→$(cuantos "$T") · faltó:${falta}"; sed -n '1,14p' "$T/out.txt"
  fi
  ( cd "$T/repo" && git reset -q --hard HEAD && git clean -qfd )
}
if suite_part 2; then   # ── parte 2 de 2 ──

# C-16 · T6 SpanishNames_NewPathOptionSubcommandEnvKey_Block — cinco categorías, cinco commits que no se crean
T=$(mktemp -d); montar_castellano "$T"
printf '// nada\n' > "$T/repo/scripts/lib/${C_FILE}.js"; ( cd "$T/repo" && git add -A )
nuevo_bloqueado "$T" "una ruta nueva" "scripts/lib/${C_FILE}.js" "[ruta]" "load-data"
printf '// x\nconst y = process.argv.includes("%s");\n' "$C_OPT" > "$T/repo/scripts/english-tool.js"; ( cd "$T/repo" && git add -A )
nuevo_bloqueado "$T" "una opción nueva" "scripts/english-tool.js:2" "[opción]" "$C_OPT" "--without-copy"
printf 'const cmd = process.argv[2];\nswitch (cmd) {\n  case %s: break;\n}\n' "'${C_SUB}'" > "$T/repo/scripts/english-tool.js"; ( cd "$T/repo" && git add -A )
if [ -r "$DICC" ]; then
  nuevo_bloqueado "$T" "un subcomando nuevo" "scripts/english-tool.js:3" "[subcomando]" "$C_SUB"
else
  echo "  ⏭   — C-16 T6 un subcomando nuevo NO verificado: «${C_SUB}» no está en la lista y se juzga con el diccionario, que esta máquina no tiene ($DICC). No es un verde."
  ( cd "$T/repo" && git reset -q --hard HEAD && git clean -qfd )
fi
printf 'if (process.env.%s) {}\n' "$C_ENV" > "$T/repo/scripts/english-tool.js"; ( cd "$T/repo" && git add -A )
nuevo_bloqueado "$T" "una variable nueva" "scripts/english-tool.js:1" "[variable]" "$C_ENV" "TYCON_NO_DOWNLOAD"
mkdir -p "$T/repo/scripts/controls-bench"; printf '{\n  "%s": "x"\n}\n' "$C_KEY" > "$T/repo/scripts/controls-bench/hook-debt.json"; ( cd "$T/repo" && git add -A )
nuevo_bloqueado "$T" "una clave nueva en schemaFiles" "scripts/controls-bench/hook-debt.json:2" "[clave]" "$C_KEY" "reason"
# el espejo: un cambio en inglés entra
printf 'const x = process.argv.includes("--dry-run");\n' > "$T/repo/scripts/english-tool.js"; ( cd "$T/repo" && git add -A )
ANTES=$(cuantos "$T"); RC=$(commitear_nombres "$T" "en inglés")
if [ "$RC" = "0" ] && [ "$(cuantos "$T")" = "$((ANTES + 1))" ]; then ok "C-16 T6 el espejo: un nombre nuevo en inglés entra"
else mal "C-16 T6 el espejo: un nombre en inglés fue frenado (exit $RC)"; sed -n '1,12p' "$T/out.txt"; fi
if grep -q '"freno":"spanish-names"' "$T/casa/.claude/.tycon-pipeline/frenos.jsonl" 2>/dev/null; then
  ok "C-16 la constancia del freno quedó en la HOME de la prueba"
else
  mal "C-16 🔴 el freno no dejó su constancia en la HOME de la prueba"
fi
rm -rf "$T"

# C-17 · T7 SpanishNames_ExistingNameReused_Passes — un nombre castellano que ya sale pasa: todavía no tiene reemplazo
T=$(mktemp -d); montar_castellano "$T"
# el nombre tiene que existir ANTES del commit: desde la tanda B3a la opción real de la copia se llama en inglés, así que
# el laboratorio trae su propia herramienta que ya la usa en castellano (tanda C1)
printf 'const quiere = process.argv.includes("--pa""quete");\n' | sed 's/""//' > "$T/repo/scripts/old-tool.js"
( cd "$T/repo" && git add -A && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m "una herramienta que ya usa la opción" )
ANTES=$(cuantos "$T")
mkdir -p "$T/repo/scripts/tests"
printf 'const r = run(["--pa""quete", "nucleo"]);\n' | sed 's/""//' > "$T/repo/scripts/tests/lab.test.js"
printf '# Guía nueva\n\n`TYCON_NO_UPLOAD_RUNS=1` lo apaga.\n' > "$T/repo/guides/nueva.md"
# (el commit trae una guía: el control de historia interna, que no es lo que este caso mide, va apagado — el repo del
# laboratorio no tiene la forma del repo unido y ahí el control, con razón, no sabe qué sale)
( cd "$T/repo" && git add -A ); RC=$(TYCON_INTERNAL_HISTORY=0 commitear_nombres "$T" "nombres que ya existen")
if [ "$RC" = "0" ] && [ "$(cuantos "$T")" = "$((ANTES + 1))" ] && ! hablo_el_freno "$T/out.txt"; then
  ok "C-17 T7 SpanishNames_ExistingNameReused_Passes: una prueba con una opción que ya existe y una guía nueva pasan callados"
else
  mal "C-17 T7 exit $RC · commits ${ANTES}→$(cuantos "$T")"; sed -n '1,12p' "$T/out.txt"
fi
rm -rf "$T"

# C-18 · T8 SpanishNames_ShellLocalAndMdAndCases_Silent — una variable local de shell, un .md y un caso del banco
T=$(mktemp -d); montar_castellano "$T"; ANTES=$(cuantos "$T")
printf '#!/usr/bin/env bash\necho "${SAL""IDA:-}"\n' | sed 's/""//' > "$T/repo/scripts/english-tool.sh"
printf '# x\n' > "$T/repo/guides/guias-nue""vas.md"
( cd "$T/repo" && git add -A ); RC=$(TYCON_INTERNAL_HISTORY=0 commitear_nombres "$T" "lo que no se mira")   # ídem: trae un .md
if [ "$RC" = "0" ] && [ "$(cuantos "$T")" = "$((ANTES + 1))" ] && ! hablo_el_freno "$T/out.txt"; then
  ok "C-18 T8 SpanishNames_ShellLocalAndMdAndCases_Silent: una variable local de shell y un .md nuevo entran callados"
else
  mal "C-18 T8 exit $RC · commits ${ANTES}→$(cuantos "$T")"; sed -n '1,12p' "$T/out.txt"
fi
# el caso del banco va directo al freno: un caso nuevo dispara en el pre-commit el control de paridad con Codex, que en
# el laboratorio (sin build/) no tiene de dónde leer y no es lo que se prueba acá
mkdir -p "$T/repo/scripts/controls-bench/cases/hooks"; printf '{"cases":[{"id":"%s"}]}\n' "caso-nue""vo" > "$T/repo/scripts/controls-bench/cases/hooks/lab.json"
( cd "$T/repo" && git add -A && HOME="$T/casa" TYCON_SKILLS_DIR="$T/skills" node scripts/publishing/spanish-names.js --repo . ) > "$T/out.txt" 2>&1; RC=$?
if [ "$RC" = "0" ] && [ ! -s "$T/out.txt" ]; then ok "C-18 T8 un caso nuevo del banco con id en castellano: el freno calla"
else mal "C-18 T8 el caso del banco: exit $RC"; sed -n '1,8p' "$T/out.txt"; fi
rm -rf "$T"

# C-19 · T9 SpanishNames_RenameDirections — castellano→inglés pasa; inglés→castellano y castellano→castellano frenan;
# el merge cuya rama agregó un nombre y la resolución no, pasa
T=$(mktemp -d); montar_castellano "$T"
mkdir -p "$T/repo/scripts/lab"; printf '// x\n' > "$T/repo/scripts/lab/reg""istro-viejo.js"
( cd "$T/repo" && git add -A && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m "un archivo en castellano" )
dir_rc() { local T="$1" de="$2" a="$3" etiqueta="$4"; ( cd "$T/repo" && git mv "$de" "$a" ); commitear_nombres "$T" "$etiqueta"; }
ANTES=$(cuantos "$T")
RC1=$(dir_rc "$T" "scripts/lab/reg""istro-viejo.js" "scripts/lab/old-log.js" "castellano a inglés"); D1=$(cuantos "$T")
RC2=$(dir_rc "$T" "scripts/english-tool.js" "scripts/lab/herra""mienta.js" "inglés a castellano"); ( cd "$T/repo" && git reset -q --hard HEAD )
RC3=$(dir_rc "$T" "scripts/lab/old-log.js" "scripts/lab/otro-nom""bre.js" "castellano a castellano"); ( cd "$T/repo" && git reset -q --hard HEAD )
if [ "$RC1" = "0" ] && [ "$D1" = "$((ANTES + 1))" ] && [ "$RC2" != "0" ] && [ "$RC3" != "0" ] && [ "$(cuantos "$T")" = "$D1" ]; then
  ok "C-19 T9 SpanishNames_RenameDirections: castellano→inglés entra; inglés→castellano y castellano→castellano no"
else
  mal "C-19 T9 castellano→inglés $RC1 · inglés→castellano $RC2 · castellano→castellano $RC3 (commits ${ANTES}→$(cuantos "$T"))"
fi
( cd "$T/repo" && git checkout -q -b rama \
  && printf 'const y = process.argv.includes("%s");\n' "$C_OPT" > scripts/w.js && git add -A \
  && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m "la rama agrega un nombre" \
  && git checkout -q main && git merge -q --no-ff --no-commit rama >/dev/null 2>&1; printf 'const y = 1;\n' > scripts/w.js && git add -A )
ANTES=$(cuantos "$T"); RC=$(commitear_nombres "$T" "merge sin el nombre")
if [ "$RC" = "0" ] && [ "$(cuantos "$T")" -gt "$ANTES" ]; then ok "C-19 T9 el merge cuya resolución no trae el nombre de la rama entra"
else mal "C-19 T9 el merge fue frenado (exit $RC)"; sed -n '1,12p' "$T/out.txt"; fi
rm -rf "$T"

# C-20 · T10 SpanishNames_CannotLook_Off_OtherRepo — sin la lista sale 2; apagado pasa, lo dice y deja constancia;
# sin agent-skills avisa fuerte y pasa
T=$(mktemp -d); montar_castellano "$T"
( cd "$T/repo" && git rm -q scripts/lib/spanish-words.json && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m "sin la lista" )
printf 'const x = 2;\n' > "$T/repo/scripts/english-tool.js"; ( cd "$T/repo" && git add -A )
ANTES=$(cuantos "$T"); RC=$(commitear_nombres "$T" "sin la lista")
# La corrida directa lleva el MISMO agent-skills de laboratorio que el commit: sin él, busca uno en la HOME de prueba,
# no lo encuentra, avisa y sale 0 antes de mirar la lista — el caso daba rojo en toda consola sin TYCON_SKILLS_DIR
# exportada (el nocturno la exporta, por eso ahí pasaba).
( cd "$T/repo" && git add -A && HOME="$T/casa" TYCON_SKILLS_DIR="$T/skills" node scripts/publishing/spanish-names.js --repo . ) >/dev/null 2>&1; RC_DIRECTO=$?
if [ "$RC" != "0" ] && [ "$RC_DIRECTO" = "2" ] && [ "$(cuantos "$T")" = "$ANTES" ] && grep -q 'no pude mirar' "$T/out.txt"; then
  ok "C-20 T10 sin la lista: «no pude mirar», sale 2 y el commit NO se crea"
else
  mal "C-20 T10 sin la lista: exit $RC (directo $RC_DIRECTO), commits ${ANTES}→$(cuantos "$T")"; sed -n '1,10p' "$T/out.txt"
fi
( cd "$T/repo" && git checkout -q HEAD~1 -- scripts/lib/spanish-words.json && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m "vuelve la lista" )
printf 'if (process.env.%s) {}\n' "$C_ENV" > "$T/repo/scripts/english-tool.js"; ( cd "$T/repo" && git add -A )
ANTES=$(cuantos "$T"); RC=$( export TYCON_SPANISH_NAMES=0; commitear_nombres "$T" "apagado" )
if [ "$RC" = "0" ] && [ "$(cuantos "$T")" = "$((ANTES + 1))" ] && grep -q 'APAGADO (TYCON_SPANISH_NAMES=0)' "$T/out.txt" \
   && grep -q '"freno":"spanish-names".*"veredicto":"escape"' "$T/casa/.claude/.tycon-pipeline/frenos.jsonl" 2>/dev/null; then
  ok "C-20 T10 apagado: el commit entra, lo dice y deja constancia de escape"
else
  mal "C-20 T10 apagado: exit $RC, commits ${ANTES}→$(cuantos "$T")"; sed -n '1,10p' "$T/out.txt"
fi
printf 'const x = 3;\n' > "$T/repo/scripts/english-tool.js"; ( cd "$T/repo" && git add -A )
ANTES=$(cuantos "$T")
RC=$( ( fake_home_create "$T/casa" && cd "$T/repo" && TYCON_SKILLS_DIR="$T/no-hay-skills" TYCON_NEW_NAMES=0 \
  git -c core.hooksPath="$T/hooks-globales" -c user.email=b@b -c user.name=b commit -q -m "sin agent-skills" ) > "$T/out.txt" 2>&1; echo $? )
if [ "$RC" = "0" ] && [ "$(cuantos "$T")" = "$((ANTES + 1))" ] && grep -q 'nombres en castellano: no encontré agent-skills' "$T/out.txt"; then
  ok "C-20 T10 sin agent-skills: avisa fuerte y el commit entra"
else
  mal "C-20 T10 sin agent-skills: exit $RC, commits ${ANTES}→$(cuantos "$T")"; sed -n '1,10p' "$T/out.txt"
fi
rm -rf "$T"

# C-21 · T11 (modo público, en laboratorio) — un repo con la forma de la copia: sin perfil del equipo ni listas privadas.
# Todo lo del repo «sale»; frena lo nuevo en castellano y nunca sale 2 por la configuración que falta. La misma prueba
# sobre la copia REAL del núcleo está en export-real.test.sh (T11): el exportador no se deja correr sobre un
# laboratorio sin los archivos de sus exclusiones fijas.
T=$(mktemp -d); montar_castellano "$T"
( cd "$T/repo" && git rm -q perfil-equipo.json scripts/publishing/denylist.json scripts/publishing/replacements.json \
  && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m "con la forma de la copia pública" )
printf 'const y = process.argv.includes("%s");\n' "$C_OPT" > "$T/repo/scripts/english-tool.js"; git -C "$T/repo" add -A
( cd "$T/repo" && HOME="$T/casa" node scripts/publishing/spanish-names.js --repo . ) > "$T/p1.txt" 2>&1; RC1=$?
printf 'const y = 4;\n' > "$T/repo/scripts/english-tool.js"; git -C "$T/repo" add -A
( cd "$T/repo" && HOME="$T/casa" node scripts/publishing/spanish-names.js --repo . ) > "$T/p2.txt" 2>&1; RC2=$?
if [ "$RC1" = "1" ] && grep -qF -- "$C_OPT" "$T/p1.txt" && [ "$RC2" = "0" ]; then
  ok "C-21 T11 SpanishNames_PublicMode: sin perfil ni listas privadas frena lo nuevo (1) y deja pasar lo limpio (0)"
else
  mal "C-21 T11 modo público: con el nombre $RC1, limpio $RC2"; sed -n '1,8p' "$T/p1.txt" "$T/p2.txt"
fi
rm -rf "$T"

# C-22 · T12 SpanishNames_PrStep — el paso de lint del PR, con sus líneas de pipelines/azure-pipelines-maintainers-pr.yml, suma a FALLAS.
# La copia pública no trae los pipelines del equipo (el exportador deja afuera pipelines/**): ahí se saltea con constancia.
if [ ! -f "$RAIZ/pipelines/azure-pipelines-maintainers-pr.yml" ]; then
  echo "  ⏭   — C-22 (T12) NO verificado: no está pipelines/azure-pipelines-maintainers-pr.yml (la copia pública no trae los pipelines del equipo). No es un verde."
else
T=$(mktemp -d); montar_castellano "$T"
BASE_LAB=$(git -C "$T/repo" rev-parse HEAD)
( cd "$T/repo" && git checkout -q -b cambio && printf 'const y = process.argv.includes("%s");\n' "$C_OPT" > scripts/english-tool.js \
  && git add -A && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m "rama con un nombre nuevo" )
PASO="$(awk '/spanish-names\.js --range/{p=1} p{print} p&&/falla /{exit}' "$RAIZ/pipelines/azure-pipelines-maintainers-pr.yml" | sed 's/^ *//')"
FALLAS_LAB=$( cd "$T/repo" && FALLAS=0; falla() { FALLAS=$((FALLAS+1)); echo "❌ $1" >&2; }
  HOME="$T/casa" TYCON_SKILLS_DIR="$T/skills"; export HOME TYCON_SKILLS_DIR
  eval "$(printf '%s\n' "$PASO" | sed "s/\$(baseDelCambio)/${BASE_LAB}/g")" > "$T/pr.txt" 2>&1; echo "$FALLAS" )
if [ -n "$PASO" ] && [ "$FALLAS_LAB" = "1" ]; then ok "C-22 T12 SpanishNames_PrStep: el paso del PR suma el nombre nuevo a FALLAS"
else mal "C-22 T12 el paso del PR: FALLAS=${FALLAS_LAB:-?} (paso: ${PASO:-no está en pipelines/azure-pipelines-maintainers-pr.yml})"; sed -n '1,8p' "$T/pr.txt" 2>/dev/null; fi
rm -rf "$T"
fi

# C-23 · T13 SpanishNames_TimeBudget y C-24 · T15 SpanishNames_OwnTestsDoNotTriggerItself — sobre una copia de trabajo
# del arnés REAL: el freno con sus archivos y su prueba stageados pasa, y 5 corridas sobre un commit de un archivo dan
# una mediana de a lo sumo 5 s.
# Con la biblioteca rota es un rojo con la causa, no el «NO verificados» de la máquina sin skills (story 8.18, pase
# adversarial del tramo 2, clases 4 y 7: antes la carpeta quedaba vacía y el bloque se salteaba con un aviso).
if ! SK_REAL="$(node -e 'try { console.log(require(process.argv[1]).resolveSkillsDirs(process.env.TYCON_SKILLS_DIR || "").repo); } catch (e) { console.error(String((e && e.message) || e).split("\n")[0]); process.exit(1); }' "$RAIZ/scripts/lib/skills-dir.js" 2> "$SK_ERR")"; then
  mal "C-23/C-24 (T13, T15) no pude resolver la carpeta de skills: $(head -n 1 "$SK_ERR")"
elif [ -d "$SK_REAL/skills" ]; then
  W=$(mktemp -d); rmdir "$W"
  git -C "$RAIZ" worktree add -q --detach "$W" HEAD
  for f in scripts/publishing/spanish-names.js scripts/lib/spanish-words.json scripts/tests/spanish-names.test.js scripts/publishing/new-names.js \
           scripts/tests/githook-livefire.test.sh scripts/tests/export-real.test.sh scripts/publishing/export.js scripts/publishing/public-copy.js; do
    [ -f "$RAIZ/$f" ] || continue   # la copia pública no trae todo (exportador-real es del interno)
    mkdir -p "$W/$(dirname "$f")"; cp "$RAIZ/$f" "$W/$f"
  done
  git -C "$W" add -A
  ( cd "$W" && HOME="$(mktemp -d)" TYCON_SKILLS_DIR="$SK_REAL" node scripts/publishing/spanish-names.js --repo . ) > "$W.t15" 2>&1; RC=$?
  if [ "$RC" = "0" ]; then ok "C-24 T15 SpanishNames_OwnTestsDoNotTriggerItself: el freno, su lista y su prueba stageados pasan"
  else mal "C-24 T15 el freno se frena a sí mismo (exit $RC)"; sed -n '1,14p' "$W.t15"; fi
  git -C "$W" -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m "el freno" >/dev/null 2>&1
  printf '\n// un archivo\n' >> "$W/scripts/lib/skills-dir.js"; git -C "$W" add -A
  TIEMPOS=""
  for i in 1 2 3 4 5; do
    T0=$(node -e 'console.log(Date.now())')
    ( cd "$W" && HOME="$(mktemp -d)" TYCON_SKILLS_DIR="$SK_REAL" node scripts/publishing/spanish-names.js --repo . ) >/dev/null 2>&1
    TIEMPOS="$TIEMPOS $(( $(node -e 'console.log(Date.now())') - T0 ))"
  done
  MEDIANA=$(printf '%s\n' $TIEMPOS | sort -n | sed -n 3p)
  if [ "$MEDIANA" -le 5000 ]; then ok "C-23 T13 SpanishNames_TimeBudget: mediana de 5 corridas ${MEDIANA} ms (≤ 5000; corridas:${TIEMPOS})"
  else mal "C-23 T13 la mediana es ${MEDIANA} ms (> 5000; corridas:${TIEMPOS})"; fi
  git -C "$RAIZ" worktree remove --force "$W" >/dev/null 2>&1; rm -f "$W.t15"
else
  echo "  ⚠️   — C-23/C-24 (T13, T15) NO verificados: no está agent-skills. No es un verde."
fi

fi
if suite_part 1; then   # ── parte 1 de 2 ──

# ── C-25 · el mapa de renombres se valida en el pre-commit cuando el commit lo toca (story 8.9, tanda A2, AC 13) ──
# Un mapa con una variable nueva en castellano no se commitea; el mismo mapa con el nombre en inglés, sí. Lo que se
# valida es lo stageado: un arreglo en el disco sin stagear no hace pasar el commit. La palabra es una de la lista, no
# una que se juzga con el diccionario: lo que se prueba acá es el mapa, y así se mide también en el nocturno (Linux).
# La copia pública (story 8.7) sale sin el perfil del equipo y sin el mapa: el de laboratorio parte del mapa REAL, así
# que ahí no hay de dónde armarlo. Se dice y no corre. (Tapado hasta la 8.7 por el rojo del pre-commit de más arriba.)
PUBLIC_COPY=0
if [ ! -f "$RAIZ/perfil-equipo.json" ] || [ ! -f "$RAIZ/scripts/lib/renames.json" ]; then PUBLIC_COPY=1; fi
if [ "$PUBLIC_COPY" = 1 ]; then
  echo "  ⏭️   — C-25 NO MEDIDO — copia pública sin el mapa de renombres: no hay mapa del que armar el de laboratorio. No es un verde."
else
T=$(mktemp -d); montar_castellano "$T"
# El mapa de laboratorio parte del mapa real recortado a lo que el laboratorio tiene en disco, y le suma su entrada. Uno
# de una sola entrada dejaba a los guiones de scripts/ci declarando pares de opciones sin su entrada (el validador lo
# exige desde la B2) y a los reemplazos sin la suya; el mapa real entero nombra archivos que el laboratorio no copió
# (tanda C1).
mapa_de_lab() {   # $1 = la variable nueva de la entrada de laboratorio
  node -e '
    const fs = require("fs"), path = require("path"); const [repo, nueva] = process.argv.slice(1);
    const m = JSON.parse(fs.readFileSync(path.join(repo, "scripts/lib/renames.json"), "utf8"));
    const hay = (p) => typeof p === "string" && !p.startsWith("~") && fs.existsSync(path.join(repo, p));
    const ruta = ["file", "folder", "config-file", "state-file"];
    m.entries = m.entries.filter((e) => (e.repo || "arnes") === "arnes" && (ruta.includes(e.kind) ? hay(e.old) || hay(e.new) : !e.where || hay(e.where)));
    m.entries.push({ kind: "env", old: "TYCON_LAB_OLD", new: nueva, batch: "lab" });
    process.stdout.write(JSON.stringify(m, null, 2));' "$T/repo" "$1"
}
MAPA_MALO="$(mapa_de_lab "TYCON_CAR""GAR_LAB")"
MAPA_BUENO="$(mapa_de_lab "TYCON_CLEAN_LAB")"
printf '%s\n' "$MAPA_MALO" > "$T/repo/scripts/lib/renames.json"; ( cd "$T/repo" && git add -A )
printf '%s\n' "$MAPA_BUENO" > "$T/repo/scripts/lib/renames.json"   # arreglado en el disco, SIN stagear
ANTES=$(cuantos "$T"); RC=$(commitear_nombres "$T" "mapa malo stageado")
if [ "$RC" != "0" ] && [ "$(cuantos "$T")" = "$ANTES" ] && grep -q 'mapa de renombres (scripts/lib/renames.json)' "$T/out.txt" \
   && ! grep -qE 'mapa de renombres \(/' "$T/out.txt"; then
  ok "C-25 un mapa de renombres malo (stageado) no se commitea, aunque el disco esté arreglado, y el mensaje nombra scripts/lib/renames.json"
else mal "C-25 mapa malo: exit $RC · commits ${ANTES}→$(cuantos "$T")"; sed -n '1,10p' "$T/out.txt"; fi
( cd "$T/repo" && git add -A ); RC=$(commitear_nombres "$T" "mapa bueno")
if [ "$RC" = "0" ] && [ "$(cuantos "$T")" = "$((ANTES + 1))" ]; then ok "C-25 el mismo mapa con el nombre en inglés se commitea"
else mal "C-25 mapa bueno: exit $RC"; sed -n '1,10p' "$T/out.txt"; fi
# si git no puede dar el mapa del índice por otra cosa que un borrado, no se saltea la validación: el commit no se crea
GIT_REAL="$(command -v git)"; mkdir -p "$T/bin-git"
printf '#!/bin/sh\ncase "$*" in *"show :scripts/lib/renames.json"*) echo "fatal: simulado" >&2; exit 128 ;; esac\nexec "%s" "$@"\n' "$GIT_REAL" > "$T/bin-git/git"
chmod +x "$T/bin-git/git"
printf '%s\n' "$MAPA_BUENO" > "$T/repo/scripts/lib/renames.json"; printf '\n' >> "$T/repo/scripts/lib/renames.json"; ( cd "$T/repo" && git add -A )
# git antepone su carpeta al PATH al correr un hook: el git de mentira sólo se interpone corriendo el pre-commit directo
( fake_home_create "$T/casa" && cd "$T/repo" && PATH="$T/bin-git:$PATH" bash .githooks/pre-commit ) > "$T/out.txt" 2>&1; RC=$?
if [ "$RC" != "0" ] && grep -q 'no pude leer el mapa de renombres' "$T/out.txt"; then
  ok "C-25 si git no da el mapa del índice (y no es un borrado), el pre-commit frena"
else mal "C-25 git show fallido: exit $RC"; sed -n '1,8p' "$T/out.txt"; fi
( cd "$T/repo" && git reset -q --hard HEAD )
( cd "$T/repo" && git rm -q --cached scripts/lib/renames.json && rm -f scripts/lib/renames.json )
ANTES=$(cuantos "$T"); RC=$(commitear_nombres "$T" "sin mapa")
if [ "$RC" = "0" ] && [ "$(cuantos "$T")" = "$((ANTES + 1))" ]; then ok "C-25 borrar el mapa no pasa por la validación (no hay mapa que validar)"
else mal "C-25 borrado del mapa: exit $RC"; sed -n '1,8p' "$T/out.txt"; fi
rm -rf "$T"
fi

# ── C-26/C-27 · el tipo de cada pieza del mapa, disparado por git de verdad (story 8.12, R7, AC 42) ──
# Un commit que deja una ficha con un tipo distinto del que le da su ruta NO se crea; el espejo —un cambio
# en el mapa con los tipos al día— entra, con la pública regenerada. Sin el espejo, un pre-commit que
# rechaza todo commit del mapa también daría verde.
mapa_lab() {
  local T="$1"
  # el mapa del arnés vive en scripts/tools/harness-map/ desde la story 8.12, tanda R4
  # y su versión pública, con la mini-clase en onboarding/mini-class/ desde la story 8.9, tanda F
  mkdir -p "$T/repo/scripts/tools/harness-map" "$T/repo/artifacts" "$T/repo/onboarding/mini-class" "$T/repo/build"
  cp "$RAIZ/scripts/tools/harness-map/"* "$T/repo/scripts/tools/harness-map/"
  cp "$RAIZ/artifacts/mapa-arnes.html" "$T/repo/artifacts/"
  cp "$RAIZ/onboarding/mini-class/mapa-del-arnes.html" "$T/repo/onboarding/mini-class/"
  # el selector de idioma que el generador incrusta (onboarding/mini-class/i18n/inject.js, con su diccionario): sin él la
  # pública no se genera y el cambio sano de C-27 se frenaría por eso
  cp -R "$RAIZ/onboarding/mini-class/i18n" "$T/repo/onboarding/mini-class/"
  ( cd "$T/repo" && git add -A && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m mapa )
}
if [ ! -f "$RAIZ/artifacts/mapa-arnes.html" ] || [ ! -f "$RAIZ/scripts/tools/harness-map/census.js" ]; then
  # La copia pública no trae el mapa ni scripts/tools/harness-map/ (allowlist.json): no hay freno que disparar.
  echo "  ⚠️   — C-26/C-27 NO verificados: esta copia no trae el mapa del arnés. No es un verde."
else
T=$(mktemp -d); montar "$T"; mapa_lab "$T"; ANTES=$(cuantos "$T")
node -e '
  const fs = require("fs"), p = process.argv[1];
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/("censo": \{[^\n]*?"tipo":)"[^"]*"/, "$1\"guía\""));
' "$T/repo/artifacts/mapa-arnes.html"
( cd "$T/repo" && git add artifacts/mapa-arnes.html )
RC=$(commitear "$T" "tipo mal puesto"); DESPUES=$(cuantos "$T")
if [ "$RC" != "0" ] && [ "$ANTES" = "$DESPUES" ] && grep -q "censo: tiene «guía»" "$T/out.txt"; then
  ok "C-26 commit REAL con una ficha mal tipeada: git NO lo crea y nombra la ficha (exit $RC)"
else
  mal "C-26 la ficha mal tipeada pasó o no se nombró (exit $RC, commits ${ANTES}→$DESPUES)"; sed -n '1,12p' "$T/out.txt"
fi
rm -rf "$T"
T=$(mktemp -d); montar "$T"; mapa_lab "$T"; ANTES=$(cuantos "$T")
printf '\n<!-- cambio de prueba -->\n' >> "$T/repo/artifacts/mapa-arnes.html"
( cd "$T/repo" && git add artifacts/mapa-arnes.html )
RC=$(commitear "$T" "mapa sano"); DESPUES=$(cuantos "$T")
if [ "$RC" = "0" ] && [ "$DESPUES" = "$((ANTES + 1))" ]; then
  ok "C-27 commit REAL del mapa con los tipos al día: entra (exit 0, HEAD avanzó)"
else
  mal "C-27 un cambio sano del mapa fue frenado (exit $RC, commits ${ANTES}→$DESPUES)"; sed -n '1,12p' "$T/out.txt"
fi
rm -rf "$T"
fi

# ── C-28 · T26 R3_DashboardSeries_PipelinesAndCapturerShim (story 8.12, tanda R3, AC 22) ──────────────
# Cinco piezas pasaron a scripts/lib/. Los pipelines del arnés corren en Azure desde un checkout del arnés: si un yml
# siguiera nombrando la ruta vieja andaría por el reemplazo… que la copia pública no lleva. Así que (a) los yml parsean,
# (b) ningún archivo de este carril nombra una ruta vieja y cada ruta nueva existe, (c) el reemplazo de la vieja da lo
# mismo que la nueva (el revisor de retrospectiva de agent-skills sigue llamando la vieja hasta el retiro) y (d) el
# pre-commit real lintea por la ruta nueva aunque la vieja no esté. Las rutas viejas salen del mapa, nunca escritas acá.
# desde la R6 los yml del arnés viven en pipelines/ y la plantilla en pipelines/templates/
# (story 8.41: la validación y su plantilla son del repo privado, con nombre nuevo; la plantilla del hook de stories vive
# en el paquete bizuit, en la capa del equipo)
R3_ARCHIVOS="pipelines/azure-pipelines.yml pipelines/azure-pipelines-maintainers-pr.yml pipelines/azure-pipelines-vigilante.yml pipelines/templates/fetch-repos.yml .githooks/pre-commit packs/bizuit/templates/stories/githooks-pre-commit.template build/check.js"
R3_YML="pipelines/azure-pipelines.yml pipelines/azure-pipelines-maintainers-pr.yml pipelines/azure-pipelines-vigilante.yml pipelines/templates/fetch-repos.yml"
# La copia pública (story 8.7) no trae los pipelines del equipo (el exportador deja afuera pipelines/**): un yml que ahí
# no está no se puede parsear, y se dice. En el repo del equipo, que falte uno sigue siendo un rojo.
if python3 -c 'import yaml' >/dev/null 2>&1; then
  R3_ROTOS=""; R3_NOT_SHIPPED=""; R3_PARSED=0
  for y in $R3_YML; do
    if [ "$PUBLIC_COPY" = 1 ] && [ ! -f "$RAIZ/$y" ]; then R3_NOT_SHIPPED="$R3_NOT_SHIPPED $y"; continue; fi
    R3_PARSED=$((R3_PARSED + 1))
    python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]))' "$RAIZ/$y" >/dev/null 2>&1 || R3_ROTOS="$R3_ROTOS $y"
  done
  [ -z "$R3_NOT_SHIPPED" ] || echo "  ⏭️   — C-28 T26 yml NO MEDIDO para:$R3_NOT_SHIPPED — la copia pública no trae los pipelines del equipo. No es un verde."
  if [ -n "$R3_ROTOS" ]; then mal "C-28 T26 no parsean:$R3_ROTOS"
  elif [ -z "$R3_NOT_SHIPPED" ]; then ok "C-28 T26 los cuatro yml de este carril parsean"
  elif [ "$R3_PARSED" -gt 0 ]; then ok "C-28 T26 los $R3_PARSED yml de este carril que la copia trae parsean"; fi
else
  echo "  ⚠️   — C-28 T26 yml NO MEDIDO — sin PyYAML en esta máquina. No es un verde."
fi
if [ ! -f "$RAIZ/perfil-equipo.json" ] || [ ! -f "$RAIZ/scripts/lib/renames.json" ]; then
  echo "  ⏭️   — C-28 T26 rutas viejas y reemplazo: NO MEDIDO — copia pública sin el mapa"
else
  # «vieja<TAB>nueva» de las cinco de la tanda R3
  R3_PARES="$(node -e 'const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const e of m.entries) if (e && e.batch === "R3" && e.kind === "file") console.log(e.old + "\t" + e.new);' "$RAIZ/scripts/lib/renames.json")"
  R3_N=$(printf '%s\n' "$R3_PARES" | grep -c .)
  R3_PROBLEMAS=""
  while IFS="$(printf '\t')" read -r vieja nueva; do
    [ -n "$vieja" ] || continue
    [ -f "$RAIZ/$nueva" ] || R3_PROBLEMAS="$R3_PROBLEMAS · falta $nueva"
    for f in $R3_ARCHIVOS; do
      # un archivo que no está no se saltea: sería un «no nombra la vieja» en vacío
      [ -f "$RAIZ/$f" ] || { R3_PROBLEMAS="$R3_PROBLEMAS · no está $f"; continue; }
      if grep -qF "$vieja" "$RAIZ/$f"; then R3_PROBLEMAS="$R3_PROBLEMAS · $f nombra $vieja"; fi
    done
  done <<< "$R3_PARES"
  if [ "$R3_N" = "5" ] && [ -z "$R3_PROBLEMAS" ]; then
    ok "C-28 T26 ninguno de los archivos de pipelines y githooks nombra una ruta vieja de las 5, y las 5 nuevas existen"
  else
    mal "C-28 T26 rutas de la tanda R3 (entradas en el mapa: $R3_N):$R3_PROBLEMAS"
  fi

  # (c) el validador del tablero por la ruta vieja (el reemplazo) y por la nueva: misma salida, mismo código
  DS_NUEVA="$(printf '%s\n' "$R3_PARES" | awk -F'\t' '$2 ~ /\/dashboard-series\.js$/ {print $2}')"
  DS_VIEJA="$(printf '%s\n' "$R3_PARES" | awk -F'\t' '$2 ~ /\/dashboard-series\.js$/ {print $1}')"
  if [ -z "$DS_VIEJA" ] || [ ! -f "$RAIZ/$DS_VIEJA" ] || [ ! -f "$RAIZ/$DS_NUEVA" ]; then
    mal "C-28 T26 falta el validador del tablero en la ruta nueva o su reemplazo en la vieja (${DS_VIEJA:-sin entrada} → ${DS_NUEVA:-?})"
  else
    T=$(mktemp -d); mkdir -p "$T/sano" "$T/roto" "$T/casa"
    ULTIMO="$(ls "$RAIZ/.dashboard" 2>/dev/null | grep -E '^metrics-.*\.json$' | tail -1)"
    [ -n "$ULTIMO" ] && cp "$RAIZ/.dashboard/$ULTIMO" "$T/sano/"
    printf '{' > "$T/roto/metrics-2026-01-01-lab-roto.json"
    R3_DIF=""
    for d in sano roto; do
      ( cd "$RAIZ" && env -u TF_BUILD HOME="$T/casa" TYCON_NO_NIGHTLY_EXAM=1 node "$DS_VIEJA" --validate --dir "$T/$d" ) > "$T/v.out" 2> "$T/v.err"; RCV=$?
      ( cd "$RAIZ" && env -u TF_BUILD HOME="$T/casa" TYCON_NO_NIGHTLY_EXAM=1 node "$DS_NUEVA" --validate --dir "$T/$d" ) > "$T/n.out" 2> "$T/n.err"; RCN=$?
      if [ "$RCV" != "$RCN" ] || ! cmp -s "$T/v.out" "$T/n.out" || ! cmp -s "$T/v.err" "$T/n.err"; then
        R3_DIF="$R3_DIF · $d (vieja exit $RCV, nueva exit $RCN)"
      fi
      [ "$d" = "roto" ] && RC_ROTO=$RCN
    done
    if [ -z "$R3_DIF" ] && [ "${RC_ROTO:-0}" = "1" ]; then
      ok "C-28 T26 el validador del tablero por la ruta vieja (el reemplazo) da la misma salida y el mismo código que por la nueva (sano y roto)"
    else
      mal "C-28 T26 la ruta vieja y la nueva difieren:${R3_DIF:- (el roto no salió 1: exit ${RC_ROTO:-?})}"; sed -n '1,6p' "$T/v.err"
    fi
    rm -rf "$T"
  fi

  # (d) el pre-commit real del arnés, sin la ruta vieja del lint en el laboratorio: igual lintea (por la nueva)
  LINT_VIEJA="$(printf '%s\n' "$R3_PARES" | awk -F'\t' '$2 ~ /\/lint-story-frontmatter\.js$/ {print $1}')"
  T=$(mktemp -d); montar "$T"
  if [ -n "$LINT_VIEJA" ] && [ -f "$T/repo/$LINT_VIEJA" ]; then
    ( cd "$T/repo" && git rm -q "$LINT_VIEJA" && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m "sin la ruta vieja" )
  fi
  ANTES=$(cuantos "$T")
  printf '%s' "$STORY_ROTA" > "$T/repo/specs/story-9.8-rota.md"; ( cd "$T/repo" && git add specs/story-9.8-rota.md )
  RC=$(commitear "$T" "story rota sin la ruta vieja"); DESPUES=$(cuantos "$T")
  # el rechazo tiene que ser del lint (nombra la story y el motivo), no de un lint que no arranca: un `require` roto
  # también sale ≠0 y daría este verde por el motivo equivocado
  if [ "$RC" != "0" ] && [ "$ANTES" = "$DESPUES" ] && ! grep -q "no encontré.*lint-story-frontmatter" "$T/out.txt" \
     && grep -q "story-9.8-rota.md" "$T/out.txt" && grep -q "frontmatter NO cierra" "$T/out.txt" && ! grep -q "Cannot find module" "$T/out.txt"; then
    ok "C-28 T26 el pre-commit real lintea por la ruta nueva: sin la vieja en el laboratorio, la story rota no entra"
  else
    mal "C-28 T26 sin la ruta vieja el pre-commit no linteó (exit $RC, commits ${ANTES}→$DESPUES)"; sed -n '1,8p' "$T/out.txt"
  fi
  rm -rf "$T"
fi

# ── C-29 · T36 R5_Probe_MovedPrivateGuideWithoutGlob_CommitNotCreated (story 8.12, tanda R5, AC 32) ──────────────────
# Una guía privada que el exportador deja afuera por su NOMBRE de archivo (una exclusión fija con comodín en guides/): si
# se la mueve con su reemplazo atrás y SIN tocar el glob, su contenido pasa a salir en la copia. Dos redes: la primera
# (la exportación sale 2, «exclusión fija sin archivo») la cubre export.test.js; ésta es la segunda, la del commit:
# new-names.js frena porque lo que sale estrena un nombre de la lista de denegación. Laboratorio: la lista es la
# sintética de montar_nombres (AcmeCorp→Ceibo), nunca la real; la exclusión fija sale del export.js del arnés, nunca
# escrita acá, y el export.js del laboratorio es ése, sin tocar. El espejo: renombrarla dentro de lo que cubre el glob
# entra (una cadena que rechaza todo también está rota, y prueba que el contenido de base de verdad no salía).
FIJA="$(node -e 'const { EXCLUIDOS_SIEMPRE } = require(process.argv[1]);
  const fijas = EXCLUIDOS_SIEMPRE.filter((x) => x.fuente === "arnes" && !x.clase && /^guides\/(?:[^/*]+\/)*[^/*]*\*[^/*]*\.md$/.test(x.glob));
  const x = fijas.find((y) => y.glob.startsWith("guides/decisions/")) || fijas[0]; console.log(x ? x.glob : "");' \
  "$RAIZ/scripts/publishing/export.js" 2>/dev/null)"
if [ -z "$FIJA" ]; then
  mal "C-29 T36 no encontré en export.js una exclusión fija por nombre de archivo en guides/ (con comodín): el caso no tiene qué mover"
else
  PRIV="${FIJA/\*/lab-a}"; PRIV2="${FIJA/\*/lab-b}"; MOV="guides/lab-moved/$(basename "$PRIV2")"
  T=$(mktemp -d); montar_nombres "$T"
  mkdir -p "$T/repo/$(dirname "$PRIV")"
  printf '# Inventario de laboratorio\n\nLo usa AcmeCorp.\n' > "$T/repo/$PRIV"
  ( cd "$T/repo" && git add -A && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m "la guía privada, afuera por su nombre" )
  # el espejo: renombrada dentro de lo que cubre el glob, sigue afuera → entra
  ANTES=$(cuantos "$T")
  ( cd "$T/repo" && git mv "$PRIV" "$PRIV2" )
  RC=$(commitear_nombres "$T" "renombrada dentro del glob")
  if [ "$RC" = "0" ] && [ "$(cuantos "$T")" = "$((ANTES + 1))" ]; then
    ok "C-29 T36 el espejo: renombrada dentro de lo que cubre la exclusión fija, el commit entra"
  else
    mal "C-29 T36 el espejo: renombrada dentro del glob fue frenada (exit $RC)"; sed -n '1,12p' "$T/out.txt"
  fi
  # el caso: movida fuera del glob, con su reemplazo .md en la ruta vieja y el glob sin tocar → NO se crea
  ANTES=$(cuantos "$T")
  mkdir -p "$T/repo/$(dirname "$MOV")"
  ( cd "$T/repo" && git mv "$PRIV2" "$MOV" )
  SHIM_OK="$(node -e 'const fs = require("fs"), path = require("path"); const [lib, repo, viejo, nuevo] = process.argv.slice(1);
    const rel = path.relative(path.dirname(viejo), nuevo).split(path.sep).join("/");
    const text = `Movida a [\`${nuevo}\`](${rel}): este archivo queda en la ruta vieja hasta el retiro de los nombres viejos (story 8.9).\n<!-- tycon-legacy-shim: ${nuevo} -->\n`;
    fs.writeFileSync(path.join(repo, viejo), text); console.log(require(lib).isGeneratedShim(viejo, text) ? "si" : "no");' \
    "$RAIZ/scripts/lib/legacy-names.js" "$T/repo" "$PRIV2" "$MOV" 2>/dev/null)"
  ( cd "$T/repo" && git add -A )
  RC=$(commitear_nombres "$T" "movida sin su glob")
  if [ "$SHIM_OK" != "si" ]; then
    mal "C-29 T36 el reemplazo del laboratorio no es el que genera legacy-names.js: el caso no prueba la mudanza real"
  elif [ "$RC" != "0" ] && [ "$(cuantos "$T")" = "$ANTES" ] && grep -q "$MOV:3" "$T/out.txt" && grep -q '«Ceibo»' "$T/out.txt"; then
    ok "C-29 T36 R5_Probe_MovedPrivateGuideWithoutGlob_CommitNotCreated: movida con su reemplazo y sin su glob, new-names frena y el commit NO se crea"
  else
    mal "C-29 T36 exit $RC · commits ${ANTES}→$(cuantos "$T") — la guía privada movida sin su glob entró, o el freno no dijo dónde"; sed -n '1,12p' "$T/out.txt"
  fi
  rm -rf "$T"
fi

# ── C-30 · T16 GithookLivefire_PapelesPasanLosFrenos (story 8.7, tanda A, AC 13) ──────────────────────────────────────────
# Los papeles de la copia pública viven en scripts/publishing/public-files/, que queda afuera por un «out», y llegan a su
# destino por un sintético. Para los dos frenos, el `from` de un sintético sale (whatShips lo cuenta): un nombre real en un
# papel, o un ejecutable con nombre en castellano que un sintético publica, NO entran. Rojo previo: el `from` no contaba
# como algo que sale y los dos commits se creaban.
papeles_lista() {   # $1=T $2=lista JSON de sintéticos — la lista blanca del laboratorio con los papeles afuera
  printf '%s\n' "{\"packages\":{\"core\":{\"arnes\":{\"in\":[\"guides/**\",\"scripts/**\",\".githooks/**\"],\"out\":[{\"glob\":\"scripts/publishing/public-files/**\",\"reason\":\"prueba: llegan por un sintético\"}]},\"agent-skills\":{\"in\":[\"skills/tycon-*/**\"],\"out\":[{\"glob\":\"packs/**\",\"reason\":\"prueba\"}]}}},\"synthetic\":$2}" \
    > "$1/repo/scripts/publishing/allowlist.json"
}
PAPEL='{"target":".github/SECURITY.md","from":"scripts/publishing/public-files/.github/SECURITY.md","packages":["core"],"reason":"prueba"}'
T=$(mktemp -d); montar_castellano "$T"
mkdir -p "$T/repo/scripts/publishing/public-files/.github" "$T/repo/scripts/publishing/public-files/scripts"
printf '# Security\n\nReport privately.\n' > "$T/repo/scripts/publishing/public-files/.github/SECURITY.md"
papeles_lista "$T" "[${PAPEL}]"
( cd "$T/repo" && git add -A && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m "los papeles del laboratorio" )
ANTES=$(cuantos "$T")
printf '# Security\n\nReport privately.\nAsk AcmeCorp first.\n' > "$T/repo/scripts/publishing/public-files/.github/SECURITY.md"
( cd "$T/repo" && git add -A )
RC=$(commitear_nombres "$T" "un nombre real en un papel")
if [ "$RC" != "0" ] && [ "$(cuantos "$T")" = "$ANTES" ] && grep -q 'public-files/.github/SECURITY.md' "$T/out.txt" && grep -q '«Ceibo»' "$T/out.txt"; then
  ok "C-30 T16 GithookLivefire_PapelesPasanLosFrenos: un nombre real en un papel de public-files/, el freno de nombres NO deja crear el commit y dice dónde"
else
  mal "C-30 T16 nombre real en un papel: exit $RC · commits ${ANTES}→$(cuantos "$T") — el commit entró o no dijo dónde"; sed -n '1,12p' "$T/out.txt"
fi
( cd "$T/repo" && git reset -q --hard HEAD && git clean -qfd )
ANTES=$(cuantos "$T")
mkdir -p "$T/repo/scripts/publishing/public-files/scripts"   # el `git clean` de arriba se lleva la carpeta vacía
printf '#!/usr/bin/env bash\necho ok\n' > "$T/repo/scripts/publishing/public-files/scripts/${C_FILE}.sh"
chmod +x "$T/repo/scripts/publishing/public-files/scripts/${C_FILE}.sh"
papeles_lista "$T" "[${PAPEL},{\"target\":\"scripts/load-data.sh\",\"from\":\"scripts/publishing/public-files/scripts/${C_FILE}.sh\",\"packages\":[\"core\"],\"reason\":\"prueba\"}]"
( cd "$T/repo" && git add -A )
RC=$(commitear_nombres "$T" "un ejecutable en castellano en los papeles")
if [ "$RC" != "0" ] && [ "$(cuantos "$T")" = "$ANTES" ] && grep -q "public-files/scripts/${C_FILE}.sh" "$T/out.txt" && grep -q 'en castellano' "$T/out.txt"; then
  ok "C-30 T16 un ejecutable con nombre en castellano que un sintético publica: el freno de castellano NO deja crear el commit y dice dónde"
else
  mal "C-30 T16 ejecutable en castellano en los papeles: exit $RC · commits ${ANTES}→$(cuantos "$T") — el commit entró o no dijo dónde"; sed -n '1,14p' "$T/out.txt"
fi
rm -rf "$T"

# ── C-31..C-33 · el control único del arnés, disparado por git de verdad (story 8.18, T5; story 8.41, T25) ─────────
# `.githooks/pre-commit` llama a `.githooks/pre-commit-checks`, que corre SIEMPRE sus dos partes (la del arnés y la de
# las skills), cada una en su proceso. El laboratorio tiene esa forma: los dos archivos de ESTE repo, el arnés de `montar` y —para que la parte de skills tenga con qué frenar— el control de
# skills de terceros con un manifiesto sintético (una sola familia propia). Se mide el efecto: un commit sano entra, y
# un freno de CUALQUIERA de las dos partes hace que el commit no se cree, con el mensaje de esa parte. Que la otra
# parte corrió igual se ve en su salida: la salida temprana de una no saltea a la otra.
DISPATCHER="$RAIZ/.githooks/pre-commit"
CHECKS="$RAIZ/.githooks/pre-commit-checks"
if [ -f "$CHECKS" ] && grep -q 'pre-commit-checks' "$DISPATCHER" 2>/dev/null; then
  mount_union() {   # $1=T — montar + la forma del arnés: el pre-commit que llama y el control único
    local T="$1"
    montar "$T"
    cp "$DISPATCHER" "$T/repo/.githooks/pre-commit"
    cp "$CHECKS" "$T/repo/.githooks/pre-commit-checks"
    chmod +x "$T/repo/.githooks/pre-commit" "$T/repo/.githooks/pre-commit-checks"
    mkdir -p "$T/repo/scripts/publishing" "$T/repo/skills/tycon-x"
    copy_publishing "$T" third-party-coverage.js
    printf '%s\n' '{"retirement":"done","own":[{"glob":"skills/tycon-*","why":"prueba"}],"derived":[],"origins":{},"third_party":[]}' > "$T/repo/scripts/publishing/third-party-skills.json"
    printf '# Skill\n' > "$T/repo/skills/tycon-x/SKILL.md"
    ( cd "$T/repo" && git add -A && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m "la forma del repo unido" )
  }
  SKILLS_PART_RAN='pre-commit AgentSkills'            # la parte de skills avisa que en el laboratorio no está el freno de nombres
  HARNESS_PART_RAN='lint de frontmatter de stories'   # la parte del arnés anuncia su lint cuando el commit trae un .md

  # C-31 · un commit sano entra, y corrieron las dos partes
  T=$(mktemp -d); mount_union "$T"; ANTES=$(cuantos "$T")
  printf '%s' "$STORY_SANA" > "$T/repo/specs/story-9.9-sana.md"; ( cd "$T/repo" && git add specs/story-9.9-sana.md )
  RC=$(commitear "$T" "un commit sano en el repo unido")
  if [ "$RC" = "0" ] && [ "$(cuantos "$T")" = "$((ANTES + 1))" ] && grep -q "$HARNESS_PART_RAN" "$T/out.txt" && grep -q "$SKILLS_PART_RAN" "$T/out.txt"; then
    ok "C-31 T5 Hooks_DispatcherRunsBothParts: un commit sano en el repo unido entra, y corrieron las dos partes"
  else
    mal "C-31 T5 commit sano: exit $RC · commits ${ANTES}→$(cuantos "$T") — no entró, o no corrió alguna de las dos partes"; sed -n '1,12p' "$T/out.txt"
  fi

  # C-32 · frena la parte del arnés (una story ilegible): el commit no se crea, con su mensaje; la de skills corrió igual
  ANTES=$(cuantos "$T")
  printf '%s' "$STORY_ROTA" > "$T/repo/specs/story-9.8-rota.md"; ( cd "$T/repo" && git add specs/story-9.8-rota.md )
  RC=$(commitear "$T" "una story rota en el repo unido")
  if [ "$RC" != "0" ] && [ "$(cuantos "$T")" = "$ANTES" ] && grep -q 'hay stories que el harness no puede leer' "$T/out.txt" && grep -q "$SKILLS_PART_RAN" "$T/out.txt"; then
    ok "C-32 T5 frena la parte del arnés: el commit NO se crea, con su mensaje, y la parte de skills corrió igual"
  else
    mal "C-32 T5 story rota: exit $RC · commits ${ANTES}→$(cuantos "$T") — el commit entró, sin el mensaje del arnés, o la parte de skills no corrió"; sed -n '1,12p' "$T/out.txt"
  fi
  ( cd "$T/repo" && git reset -q --hard HEAD && git clean -qfd )

  # C-33 · frena la parte de skills (una skill ajena sin declarar): el commit no se crea, con su mensaje
  ANTES=$(cuantos "$T")
  mkdir -p "$T/repo/skills/foreign"; printf '# Skill de internet\n' > "$T/repo/skills/foreign/SKILL.md"; ( cd "$T/repo" && git add skills/foreign )
  RC=$(commitear "$T" "una skill ajena sin declarar en el repo unido")
  if [ "$RC" != "0" ] && [ "$(cuantos "$T")" = "$ANTES" ] && grep -q 'no está declarado en el manifiesto de terceros' "$T/out.txt" && grep -q 'skills/foreign' "$T/out.txt"; then
    ok "C-33 T5 frena la parte de skills: el commit NO se crea, con su mensaje y el nombre de la skill"
  else
    mal "C-33 T5 skill ajena: exit $RC · commits ${ANTES}→$(cuantos "$T") — el commit entró o no dijo qué"; sed -n '1,12p' "$T/out.txt"
  fi
  rm -rf "$T"

  # C-34 · el doble aviso (story 8.18, AC 25, T25 · [DEF-8.18-doble-aviso]): un commit que estrena un ejecutable con
  # nombre en castellano en CADA mitad. Las dos partes corren el freno sobre la misma raíz, una por fuente: cada una
  # frena lo suyo, y cada hallazgo sale UNA vez en toda la salida del commit.
  # 🔴 rojo previo verificado: cada parte nombraba también el archivo de la otra (dos veces cada uno, y doble en el registro).
  T=$(mktemp -d); mount_union "$T"
  mkdir -p "$T/repo/agents" "$T/repo/skills/tycon-pipeline"
  copy_publishing "$T" new-names.js spanish-names.js export.js public-copy.js detector.js internal-history.js internal-history.json
  printf '%s\n' '{"__doc":"perfil de laboratorio"}' > "$T/repo/perfil-equipo.json"
  printf '%s\n' '{"packages":{"core":{"arnes":{"in":["scripts/**",".githooks/**"],"out":[]},"agent-skills":{"in":["agents/*.md","skills/tycon-*/**"],"out":[]}}}}' > "$T/repo/scripts/publishing/allowlist.json"
  printf '%s\n' '{"terminos":[{"patron":"AcmeCorp","categoria":"cliente","palabra":true}]}' > "$T/repo/scripts/publishing/denylist.json"
  printf '%s\n' '{"pares":[{"real":"AcmeCorp","categoria":"cliente","palabra":true,"formas":[{"texto":"AcmeCorp","anonimo":"Ceibo"}]}],"afuera":[]}' > "$T/repo/scripts/publishing/replacements.json"
  printf '%s\n' '{"retirement":"done","own":[{"glob":"skills/tycon-*","why":"prueba"},{"glob":"agents/*.md","why":"prueba"}],"derived":[],"origins":{},"third_party":[]}' > "$T/repo/scripts/publishing/third-party-skills.json"
  printf '# Pipeline\n' > "$T/repo/skills/tycon-pipeline/SKILL.md"
  printf -- '---\nname: lab-reviewer\ndescription: de laboratorio\n---\n\nRevisa.\n' > "$T/repo/agents/lab-reviewer.md"
  ( cd "$T/repo" && git add -A && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m "el repo unido con los dos frenos de nombres" )
  ANTES=$(cuantos "$T")
  IN_HARNESS="scripts/${C_FILE}.sh"; IN_SKILLS="skills/tycon-x/${C_FILE}-lab.sh"
  printf '#!/usr/bin/env bash\necho ok\n' > "$T/repo/$IN_HARNESS"; printf '#!/usr/bin/env bash\necho ok\n' > "$T/repo/$IN_SKILLS"
  ( cd "$T/repo" && git add "$IN_HARNESS" "$IN_SKILLS" )
  RC=$(commitear "$T" "un ejecutable en castellano en cada mitad")
  N_HARNESS=$(grep -cF -- "$IN_HARNESS" "$T/out.txt"); N_SKILLS=$(grep -cF -- "$IN_SKILLS" "$T/out.txt")
  if [ "$RC" != "0" ] && [ "$(cuantos "$T")" = "$ANTES" ] && [ "$N_HARNESS" = "1" ] && [ "$N_SKILLS" = "1" ] && ! grep -q 'no encontré' "$T/out.txt"; then
    ok "C-34 T25 Hooks_UnifiedRepo_EachFindingOnce: un nombre en castellano en cada mitad — el commit NO se crea y cada hallazgo sale una vez, de su parte"
  else
    mal "C-34 T25 doble aviso: exit $RC · commits ${ANTES}→$(cuantos "$T") · el del arnés salió ${N_HARNESS} vez/veces y el de skills ${N_SKILLS} (va 1 y 1)"; sed -n '1,16p' "$T/out.txt"
  fi
  rm -rf "$T"
else
  mal "C-31..C-34 T5 este repo no tiene la forma del arnés: falta .githooks/pre-commit-checks, o .githooks/pre-commit no lo llama"
fi

fi   # ── fin de los bloques: lo que sigue corre en todas las partes ──

rm -f "$SK_ERR"
echo
if [ "$FALLOS" -gt 0 ]; then echo "FALLARON $FALLOS chequeo(s)"; exit 1; fi
echo "todo verde"; exit 0
