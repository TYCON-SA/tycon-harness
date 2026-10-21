#!/usr/bin/env bash
# instinct-observer-catalog.test.sh — red del observador contra lo que ya existe, sin modelo.
#
# Sin la segunda llamada, el grabador de instintos re-propondría lo que ya existe: repetiría
# un instinto ya decidido o un control que ya corre. Lo
# que pasa la confianza y el hash va a una SEGUNDA llamada que lo revisa contra los instintos decididos
# (con su proyecto; los rechazados con su motivo) y contra el catálogo detallado (qué audita cada revisor,
# el pre-commit, scripts/ci/), todo leído del disco. Se descarta lo que la revisión cita con un hash o una
# pieza que su prompt mostró; lo descartado queda en inbox/instincts/descartados/ y `instinct-promote.js list`
# lo resume. El prompt que PROPONE no cambia: con los decididos adentro, el modelo los copiaría.
#
# Cómo corre: el observador se COPIA a un árbol de prueba (así su REPO_ROOT es el árbol, no el arnés)
# y HOME apunta a una casa de prueba. PATH no tiene ni claude ni codex: si el guion no exportara lo que
# arma y lee la revisión, requerirlo correría el observador y el caso tiene que ponerse rojo sin gastar un
# token. Los casos de punta a punta usan un `claude` y un `codex` de mentira. Nunca escribe en el arnés.
#
# Manual: bash scripts/tests/instinct-observer-catalog.test.sh
set -uo pipefail
# Una TYCON_HOME heredada del ambiente de quien corre movería la carpeta de usuario de cada caso (tycon-home.js la mira
# antes que HOME): acá manda la del árbol de prueba.
unset TYCON_HOME
TCG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OBS="$TCG/scripts/instincts/instinct-observer.js"
fallos=0
ok()  { echo "✅ $1"; }
bad() { echo "❌ $1 — $2"; fallos=$((fallos+1)); }

LAB=$(mktemp -d)
# Al salir —también cortada con Ctrl-C, Esc o un kill— se cierra todo lo que corre desde el laboratorio.
# Sin esto, un observador colgado puede sobrevivir días al 100 % de un núcleo con su carpeta ya borrada.
limpiar() {
  pkill -9 -f "$LAB/" 2>/dev/null
  chmod -R u+rwX "$LAB" 2>/dev/null; rm -rf "$LAB"
}
trap limpiar EXIT
trap 'exit 130' INT TERM HUP
# Tope de tiempo por llamada (una corrida sana tarda menos de 2 s): colgado, sale 142 y el caso da rojo.
con_limite() { perl -e 'alarm shift; exec @ARGV or die "no pude ejecutar $ARGV[0]\n"' "${TYCON_TEST_LIMIT_S:-60}" "$@"; }
mkdir -p "$LAB/bin"
ln -sf "$(command -v node)" "$LAB/bin/node"

# Un árbol vacío con el observador (y sus compañeros instinct-promote e instinct-draft) adentro, en
# scripts/instincts/ y con la biblioteca del arnés en scripts/lib/, como en el arnés.
# Es un árbol de MANTENEDOR: trae su buzón (inbox/instincts/README.md, la señal que mira instinct-dirs.js),
# así que todo se escribe y se lee adentro, como siempre. El árbol que NO lo trae (una versión bajada, la copia pública)
# tiene su suite: instinct-outside-tree.test.sh. Imprime su ruta.
arbol() {
  local A="$LAB/$1"
  mkdir -p "$A/scripts/hooks" "$A/scripts/ci" "$A/scripts/tests" "$A/scripts/instincts" "$A/scripts/setup/harness" "$A/build" "$A/.githooks" \
    "$A/inbox/instincts/promoted" "$A/inbox/instincts/archived" "$A/inbox/instincts/pending" \
    "$A/home/.claude/agent-skills/agents" "$A/home/.claude/agent-skills/skills"
  printf '# el buzón del árbol de prueba\n' > "$A/inbox/instincts/README.md"
  cp "$OBS" "$A/scripts/instincts/instinct-observer.js"
  cp "$TCG/scripts/instincts/instinct-promote.js" "$TCG/scripts/instincts/instinct-draft.js" "$TCG/scripts/instincts/instinct-dirs.js" "$A/scripts/instincts/" 2>/dev/null
  cp "$TCG/scripts/setup/harness/tycon-home.js" "$A/scripts/setup/harness/"
  cp -R "$TCG/scripts/lib" "$A/scripts/lib"
  echo "$A"
}

# Evalúa $2 (JS) con el observador del árbol $1 cargado como `o`, dos candidatos (Totora y
# el arnés) y dos propuestas fijas. Sin modelo: PATH sin claude ni codex.
con_observador() {
  HOME="$1/home" PATH="$LAB/bin:/usr/bin:/bin" TYCON_INSTINCT_OBS_DIR="$LAB/sin-observaciones" \
    TYCON_OLLAMA_URL="http://127.0.0.1:9" con_limite node -e '
      const o = require(process.argv[1]);
      const candidatos = [
        { key: "Totora|Bash|grep -rn obtenerDetalle", count: 7, items: [{ ts: 1, status: "ok", summary: "grep -rn obtenerDetalle" }] },
        { key: "tycon-claude-guides|Read|scripts/x.js", count: 4, items: [{ ts: 2, status: "ok", summary: "Read scripts/x.js" }] },
      ];
      const propuestas = [
        { trigger: "PROPUESTA-UNO buscar símbolos", action: "usar codegraph_search", candidate_index: 1 },
        { trigger: "PROPUESTA-DOS correr la suite entera", action: "npm test sin filtro", candidate_index: 2 },
      ];
      process.stdout.write(String(eval(process.argv[2])));
    ' "$1/scripts/instincts/instinct-observer.js" "$2"
}
prompt_de()   { con_observador "$1" 'o.buildPrompt(candidatos, 11)'; }
revision_de() { con_observador "$1" "o.promptDeRevision(propuestas, candidatos, ${2:-undefined}).prompt"; }

# Los renglones "- …" que siguen al encabezado que empieza con $2, en el archivo $1.
seccion() {
  node -e '
    const [archivo, prefijo] = process.argv.slice(1);
    const lineas = require("fs").readFileSync(archivo, "utf8").split("\n");
    const i = lineas.findIndex((l) => l.startsWith(prefijo));
    if (i < 0) process.exit(0);
    for (let j = i + 1; j < lineas.length && lineas[j].startsWith("- "); j++) console.log(lineas[j]);
  ' "$1" "$2"
}
# Posición (renglón) del primer texto $2 dentro de la sección $3 del archivo $1; vacío si no está.
renglon_de() { seccion "$1" "$3" | grep -nF -- "$2" | head -1 | cut -d: -f1; }

tiene()    { grep -qF -- "$2" "$1"; }
no_tiene() { ! grep -qF -- "$2" "$1"; }

instinto() { # $1=archivo  $2=trigger (o vacío)  $3=proyecto (o vacío)  $4..=renglones extra
  local f="$1" trig="$2" proy="$3"; shift 3
  { echo "# Auto-generated by instinct-observer.js"
    [ -n "$trig" ] && echo "trigger: \"$trig\""
    echo "action: \"una acción\""
    [ -n "$proy" ] && echo "project: \"$proy\""
    for extra in "$@"; do echo "$extra"; done
  } > "$f"
}

# ── Árbol completo ─────────────────────────────────────────────────────────────────────────────
A=$(arbol completo)
instinto "$A/inbox/instincts/promoted/20260910-a-aaaaaaaaaa.yaml" "MARCA-APROBADO buscar con CodeGraph primero" "Totora" \
  "hash: aaaaaaaaaa" "approved_at: 2026-09-10T02:50:25.573Z"
sed -i.bak 's/^action: "una acción"$/action: "ACCION-APROBADA codegraph_search antes de grep"/' "$A/inbox/instincts/promoted/20260910-a-aaaaaaaaaa.yaml" && rm -f "$A/inbox/instincts/promoted/"*.bak
# Otro proyecto y MÁS NUEVO: si el orden fuera sólo por fecha, iría primero.
instinto "$A/inbox/instincts/promoted/20260912-b-abababab01.yaml" "MARCA-APROBADO-OTRO-PROYECTO generar audio" "AZ400-MS" \
  "hash: abababab01" "approved_at: 2026-09-12T13:46:44.348Z"
# Sin proyecto (global) y VIEJO: cuenta como relevante, así que va antes que el de otro proyecto.
instinto "$A/inbox/instincts/promoted/20260601-g-acacacac02.yaml" "MARCA-APROBADO-GLOBAL tail de builds" "" \
  "hash: acacacac02" "approved_at: 2026-06-01T10:00:00.000Z"
instinto "$A/inbox/instincts/archived/20260914-c-bbbbbbbbbb.yaml" "MARCA-RECHAZADO correr la suite completa al iterar" "tycon-claude-guides" \
  "hash: bbbbbbbbbb" "rejected_at: 2026-09-14T18:32:42.080Z" 'rejection_reason: "MOTIVO-RECHAZO la regla de tests pide scope"'
instinto "$A/inbox/instincts/archived/20260910-d-cccccccccc.yaml" "MARCA-BLOQUE hook de dotnet test por edición" "PluginHost, Totora" \
  "hash: cccccccccc" "rechazado: 2026-09-10" "motivo_rechazo: |" "  MOTIVO-EN-BLOQUE primera línea" "" "  y segunda línea"
# Sin trigger: con hash y fecha, para que si se procesara, apareciera su [hash].
instinto "$A/inbox/instincts/archived/20260910-roto-eeeeeeeeee.yaml" "" "Totora" "hash: eeeeeeeeee" "rejected_at: 2026-09-10T00:00:00.000Z"
instinto "$A/inbox/instincts/pending/20260914-p-dddddddddd.yaml" "MARCA-PENDIENTE todavía sin decidir" "Totora" "hash: dddddddddd"

# Descripción larga (más de 160): la lista entre paréntesis tiene que llegar entera. El punto dentro del
# paréntesis va seguido de MAYÚSCULA: si se cortara adentro de paréntesis, se cortaría ahí.
cat > "$A/home/.claude/agent-skills/agents/tycon-revisor-prueba.md" <<'EOF'
---
name: tycon-revisor-prueba
description: Advisor Core during/post. Audita MARCA-REVISOR código .NET contra las convenciones (SafeQueryBuilder, IBackendPlugin, feature structure, orchestrator pattern, BizuitUserContext, rollback en catch. Tx abierta, read/write-while-tx-open, DateTime sin Kind, FIN-DE-LA-LISTA). Reglas PRUEBA-C1..C2. Usar cuando hay cambios en .cs.
tools: Read, Grep
---
cuerpo del revisor
EOF
cat > "$A/home/.claude/agent-skills/agents/worker-prueba.md" <<'EOF'
---
name: worker-prueba
description: "Advisor Core condicional. Audita MARCA-WORKER BackgroundService sin stoppingToken. Solo invocar si hay workers."
---
EOF
cat > "$A/home/.claude/agent-skills/agents/tycon-abrev-prueba.md" <<'EOF'
---
name: tycon-abrev-prueba
description: Advisor Core condicional. Audita MARCA-ABREV Server vs. Client boundary, e.g. Server Actions sin validar. Reglas ABREV-C1.
---
EOF
mkdir -p "$A/home/.claude/agent-skills/skills/tycon-skill-prueba"
printf '#!/usr/bin/env bash\n# hook de prueba\n' > "$A/scripts/hooks/hook-prueba.sh"

cat > "$A/.githooks/pre-commit" <<'EOF'
#!/usr/bin/env bash
# Casos: scripts/ci/comentado.js ← un comentario no corre nada
LINT="$REPO_ROOT/scripts/lint-prueba.js"
node "$LINT" $CHANGED_MD
node "$REPO_ROOT/scripts/ci/porton-prueba.js" --repo "$REPO_ROOT" --staged
node "$REPO_ROOT/build/check.js" > /tmp/x.log   # antes corría scripts/ci/viejo-en-comentario.js
echo "si falla, corré node scripts/ci/en-echo.js a mano"
bash "$REPO_ROOT/scripts/tests/real-test.sh"
cat > /tmp/nota.txt <<'NOTA'
node scripts/ci/en-heredoc.js
NOTA
if [ -n "$X" ]; then echo "corré scripts/ci/en-then.js"; fi
true && echo "o scripts/ci/en-segmento.js"
grep -q x <<< "scripts/ci/en-herestring.js"
n=$(( a << b ))
node "$REPO_ROOT/scripts/ci/despues-de-aritmetica.js"
EOF
cat > "$A/scripts/lint-prueba.js" <<'EOF'
#!/usr/bin/env node
/**
 * lint-prueba.js — MARCA-LINT chequea que el frontmatter sea legible.
 */
EOF
cat > "$A/scripts/ci/porton-prueba.js" <<'EOF'
'use strict';
/**
 * porton-prueba.js — MARCA-PORTON exige la evidencia de cierre
 * en el repo de la story.
 *
 * DETALLE-QUE-NO-VA porque es el segundo párrafo.
 */
EOF
printf '// check.js — MARCA-CHECK paridad Claude-Codex.\n' > "$A/build/check.js"
for f in comentado viejo-en-comentario en-echo en-heredoc en-then en-segmento en-herestring despues-de-aritmetica; do
  printf '// =====\n// %s.js — MARCA-CI-%s verifica algo de noche.\n// =====\n' "$f" "$f" > "$A/scripts/ci/$f.js"
done
printf 'sin cabecera\n' > "$A/scripts/ci/sin-cabecera.sh"
printf '#!/usr/bin/env bash\n# real-test.sh — un test\n' > "$A/scripts/tests/real-test.sh"

P="$LAB/completo.prompt.txt"
prompt_de "$A" > "$P" 2>"$LAB/completo.err"; RC=$?
if [ "$RC" = 0 ] && tiene "$P" "### Candidate 1" && tiene "$P" "Advisors (code reviewers that run in the pipeline) (2): tycon-abrev-prueba, tycon-revisor-prueba" \
  && no_tiene "$P" "MARCA-APROBADO" && no_tiene "$P" "MARCA-RECHAZADO" && no_tiene "$P" "MARCA-REVISOR" \
  && no_tiene "$P" "Pre-commit checks" && no_tiene "$P" "covered_by"; then
  ok "C-01 el prompt que PROPONE queda como antes: nombres de revisores y sin decididos, descripciones ni pre-commit (con los decididos adentro, el modelo los copiaba)"
else
  bad "C-01 prompt que propone" "rc=$RC $(head -c 300 "$LAB/completo.err")"
fi

R="$LAB/completo.revision.txt"
revision_de "$A" > "$R" 2>"$LAB/revision.err"
APROB="Approved ("
seccion "$R" "$APROB" | grep -F -- "- [aaaaaaaaaa] (Totora) MARCA-APROBADO buscar con CodeGraph primero → ACCION-APROBADA codegraph_search antes de grep" >/dev/null \
  && ok "C-02 la revisión recibe cada aprobado con su hash, su proyecto y su acción" \
  || bad "C-02 aprobado" "$(seccion "$R" "$APROB") $(head -c 300 "$LAB/revision.err")"

RECH=$(seccion "$R" "Rejected by the developer")
echo "$RECH" | grep -F -- "- [bbbbbbbbbb] (tycon-claude-guides) MARCA-RECHAZADO correr la suite completa al iterar — rejected because: MOTIVO-RECHAZO la regla de tests pide scope" >/dev/null \
  && ok "C-03 la revisión recibe cada rechazado con su proyecto y su motivo" \
  || bad "C-03 rechazado" "$RECH"

echo "$RECH" | grep -F "MARCA-BLOQUE hook de dotnet test por edición — rejected because: MOTIVO-EN-BLOQUE primera línea y segunda línea" >/dev/null \
  && ok "C-04 el motivo escrito en bloque (motivo_rechazo: |) se lee y queda en una línea" \
  || bad "C-04 motivo en bloque" "$RECH"

[ -n "$RECH" ] && no_tiene "$R" "MARCA-PENDIENTE" && no_tiene "$R" "[dddddddddd]" && no_tiene "$R" "[eeeeeeeeee]" \
  && ok "C-05 lo pendiente no cuenta como decidido, y un archivo sin trigger se saltea" \
  || bad "C-05 pendiente o roto" "entró algo que no es una decisión"

N_REC=$(renglon_de "$R" "MARCA-APROBADO buscar" "$APROB"); N_GLO=$(renglon_de "$R" "MARCA-APROBADO-GLOBAL" "$APROB"); N_OTRO=$(renglon_de "$R" "MARCA-APROBADO-OTRO-PROYECTO" "$APROB")
if [ -n "$N_REC" ] && [ -n "$N_GLO" ] && [ -n "$N_OTRO" ] && [ "$N_REC" -lt "$N_OTRO" ] && [ "$N_GLO" -lt "$N_OTRO" ]; then
  ok "C-06 van antes los del proyecto con candidatos y los globales, aunque el de otro proyecto sea más nuevo"
else
  bad "C-06 orden por relevancia" "totora=$N_REC global=$N_GLO otro=$N_OTRO"
fi

if tiene "$R" "### P1" && tiene "$R" "project: Totora" && tiene "$R" "PROPUESTA-UNO buscar símbolos" && tiene "$R" "project: tycon-claude-guides" \
  && tiene "$R" "The same habit in a DIFFERENT project is NOT covered" && tiene "$R" "covered_by must START with the [hash] or the piece name"; then
  ok "C-07 la revisión lleva cada propuesta numerada con el proyecto de su candidato, y las reglas de proyecto y de cita"
else
  bad "C-07 prompt de revisión" "$(head -c 300 "$R")"
fi

REV=$(seccion "$R" "Advisors (code reviewers that run in the pipeline) — what each one audits")
if echo "$REV" | grep -F -- "- tycon-revisor-prueba: Audita MARCA-REVISOR código .NET contra las convenciones (SafeQueryBuilder, IBackendPlugin, feature structure, orchestrator pattern, BizuitUserContext, rollback en catch. Tx abierta, read/write-while-tx-open, DateTime sin Kind, FIN-DE-LA-LISTA)" >/dev/null \
  && ! echo "$REV" | grep -F "PRUEBA-C1" >/dev/null && ! echo "$REV" | grep -F "Usar cuando" >/dev/null; then
  ok "C-08 la línea de cada revisor llega hasta el final de su lista (más de 160 caracteres), sin IDs de reglas ni cuándo invocarlo"
else
  bad "C-08 línea del revisor" "$REV"
fi
if echo "$REV" | grep -F -- "- worker-prueba: Audita MARCA-WORKER BackgroundService sin stoppingToken" >/dev/null \
  && echo "$REV" | grep -F -- "- tycon-abrev-prueba: Audita MARCA-ABREV Server vs. Client boundary, e.g. Server Actions sin validar" >/dev/null; then
  ok "C-09 entran los revisores que no son tycon-*, y una abreviatura («vs.», «e.g.») no corta la oración"
else
  bad "C-09 revisores" "$REV"
fi

PRE=$(seccion "$R" "Pre-commit checks")
if echo "$PRE" | grep -F -- "- scripts/lint-prueba.js: MARCA-LINT chequea que el frontmatter sea legible." >/dev/null \
  && echo "$PRE" | grep -F -- "- scripts/ci/porton-prueba.js: MARCA-PORTON exige la evidencia de cierre en el repo de la story." >/dev/null \
  && echo "$PRE" | grep -F -- "- build/check.js: MARCA-CHECK paridad Claude-Codex." >/dev/null \
  && echo "$PRE" | grep -F -- "- scripts/ci/despues-de-aritmetica.js" >/dev/null; then
  ok "C-10 el pre-commit lista lo que su guion ejecuta, con la primera frase de la cabecera (dos renglones unidos), también después de un \$(( a << b ))"
else
  bad "C-10 pre-commit" "$PRE"
fi
if [ -n "$PRE" ] && ! echo "$PRE" | grep -E "comentado|viejo-en-comentario|en-echo|en-heredoc|en-then|en-segmento|en-herestring|real-test" >/dev/null && no_tiene "$R" "DETALLE-QUE-NO-VA"; then
  ok "C-11 no cuenta como control del pre-commit lo nombrado en un comentario, un echo (también tras then o &&), un heredoc, un here-string o bajo scripts/tests/"
else
  bad "C-11 lo que no corre" "$PRE"
fi

CI=$(seccion "$R" "CI scripts")
if echo "$CI" | grep -F -- "- comentado.js: MARCA-CI-comentado verifica algo de noche." >/dev/null \
  && echo "$CI" | grep -xF -- "- sin-cabecera.sh" >/dev/null && ! echo "$CI" | grep -F "porton-prueba.js" >/dev/null; then
  ok "C-12 scripts/ci/ entra entero, sin repetir lo que figura en el pre-commit; sin cabecera, el nombre solo"
else
  bad "C-12 CI" "$CI"
fi

# ── Tope: con muchas decisiones, se prioriza lo relevante, lo aprobado y lo nuevo ───────────────────
T=$(arbol tope)
LARGO=$(printf 'x%.0s' $(seq 1 120))
for i in $(seq -w 1 120); do
  instinto "$T/inbox/instincts/archived/2026-rel-$i-1${i}000001.yaml" "RELEVANTE-$i $LARGO" "Totora" \
    "hash: 1${i}000001" "rejected_at: 2026-08-$(printf '%02d' $(( (10#$i % 28) + 1 )))T00:00:00.000Z" "rejection_reason: \"motivo $i\""
  instinto "$T/inbox/instincts/archived/2026-otro-$i-2${i}000002.yaml" "AJENO-$i $LARGO" "Ceibo" \
    "hash: 2${i}000002" "rejected_at: 2026-09-14T00:00:00.000Z" "rejection_reason: \"motivo ajeno $i\""
done
instinto "$T/inbox/instincts/archived/2026-rel-nuevo-3000000001.yaml" "RELEVANTE-MAS-NUEVO $LARGO" "Tycon-Claude-Guides, Otro" "hash: 3000000001" "rejected_at: 2026-09-13T00:00:00.000Z"
instinto "$T/inbox/instincts/archived/2026-rel-viejo-3000000002.yaml" "RELEVANTE-MAS-VIEJO $LARGO" "Totora" "hash: 3000000002" "rejected_at: 2026-06-01T00:00:00.000Z"
instinto "$T/inbox/instincts/promoted/2026-aprob-viejo-3000000003.yaml" "APROBADO-RELEVANTE-VIEJO $LARGO" "Totora" "hash: 3000000003" "approved_at: 2026-05-01T00:00:00.000Z"

MEDIDA=$(con_observador "$T" '(() => {
  const r = [undefined, "ollama"].map((ej) => {
    const d = o.instintosYaDecididos(candidatos, o.topeDecididos(ej));
    const lista = d.texto.split("\n").filter((l) => l.startsWith("- "));
    const chars = lista.reduce((s, l) => s + l.length + 1, 0);
    const omitidos = Number((d.texto.match(/\((\d+) more decided/) || [])[1]);
    return `${o.topeDecididos(ej)}:${chars <= o.topeDecididos(ej)}:${omitidos === 243 - lista.length}`;
  });
  return r.join(" ");
})()' 2>&1)
[ "$MEDIDA" = "16000:true:true 8000:true:true" ] \
  && ok "C-13 tope de 16.000 caracteres (8.000 con ollama), medido en caracteres, y el número de omitidos es exacto" \
  || bad "C-13 tope" "dio: $MEDIDA"

RT="$LAB/tope.revision.txt"
revision_de "$T" '"ollama"' > "$RT" 2>/dev/null
LISTA_R=$(seccion "$RT" "Rejected by the developer"); LISTA_A=$(seccion "$RT" "Approved (")
if echo "$LISTA_A" | grep -F "APROBADO-RELEVANTE-VIEJO" >/dev/null && echo "$LISTA_R" | grep -F "RELEVANTE-MAS-NUEVO" >/dev/null \
  && ! echo "$LISTA_R" | grep -F "RELEVANTE-MAS-VIEJO" >/dev/null && ! echo "$LISTA_R" | grep -F "AJENO-" >/dev/null; then
  ok "C-14 bajo el tope entran primero lo aprobado, lo del proyecto con candidatos (también en una lista con coma y otras mayúsculas) y lo nuevo; lo ajeno queda afuera aunque sea de hoy"
else
  bad "C-14 prioridad" "aprobado=$(echo "$LISTA_A" | grep -c APROBADO-RELEVANTE) nuevo=$(echo "$LISTA_R" | grep -c MAS-NUEVO) viejo=$(echo "$LISTA_R" | grep -c MAS-VIEJO) ajenos=$(echo "$LISTA_R" | grep -c AJENO-)"
fi

# ── Fail-open ────────────────────────────────────────────────────────────────────────────────────
V=$(arbol vacio)
printf '#!/usr/bin/env bash\n' > "$V/scripts/hooks/hook-prueba.sh"
printf -- '---\nname: tycon-sin-desc\n---\n' > "$V/home/.claude/agent-skills/agents/tycon-sin-desc.md"
PV="$LAB/vacio.prompt.txt"
prompt_de "$V" > "$PV" 2>/dev/null; RC=$?
node -e '
  const t = require("fs").readFileSync(process.argv[1], "utf8");
  const i = t.indexOf("edit (it froze two machines).\n");
  process.exit(i >= 0 && t.slice(i).startsWith("edit (it froze two machines).\n\n\nFor each candidate")
    && t.includes("Advisors (code reviewers that run in the pipeline) (1): tycon-sin-desc") ? 0 : 1);
' "$PV" && [ "$RC" = 0 ] \
  && ok "C-15 el prompt que propone mantiene la forma de la versión 1 (renglón de nombres y costura hasta las instrucciones)" \
  || bad "C-15 forma del prompt que propone" "rc=$RC"

D=$(arbol desnudo)
DES=$(con_observador "$D" '(() => { const r = o.promptDeRevision(propuestas, candidatos); return [r.prompt === "", r.sinCatalogo, r.sinDecididos, r.conocidas.size].join(" "); })()' 2>&1)
[ "$DES" = "true true true 0" ] \
  && ok "C-16 sin nada decidido ni catálogo no hay revisión que hacer, y queda dicho por qué (sin catálogo, sin decididos)" \
  || bad "C-16 revisión sin contra qué" "dio: $DES"

if [ "$(id -u)" = 0 ]; then
  echo "⏭️  C-17 se saltea: como root los permisos no impiden leer"
else
  U=$(arbol ilegible)
  printf '#!/usr/bin/env bash\n# hook legible\n' > "$U/scripts/hooks/hook-legible.sh"
  instinto "$U/inbox/instincts/promoted/20260910-a-aaaaaaaaaa.yaml" "MARCA-ILEGIBLE" "Totora" "hash: aaaaaaaaaa"
  instinto "$U/inbox/instincts/promoted/20260911-b-bbbbbbbbbb.yaml" "MARCA-LEGIBLE-AL-LADO" "Totora" "hash: bbbbbbbbbb"
  printf '// x.js — MARCA-CI-ILEGIBLE\n' > "$U/scripts/ci/x.js"
  chmod 000 "$U/inbox/instincts/promoted/20260910-a-aaaaaaaaaa.yaml" "$U/scripts/ci/x.js" "$U/inbox/instincts/archived" "$U/home/.claude/agent-skills/agents" "$U/.githooks"
  RU="$LAB/ilegible.revision.txt"
  revision_de "$U" > "$RU" 2>"$LAB/ilegible.err"; RC=$?
  if [ "$RC" = 0 ] && tiene "$RU" "hook-legible" && tiene "$RU" "MARCA-LEGIBLE-AL-LADO" && no_tiene "$RU" "MARCA-ILEGIBLE" \
    && tiene "$RU" "- x.js" && no_tiene "$RU" "MARCA-CI-ILEGIBLE" && [ ! -s "$LAB/ilegible.err" ]; then
    ok "C-17 archivos y carpetas ilegibles: no revienta y la revisión sale con lo que sí pudo leer"
  else
    bad "C-17 ilegibles" "rc=$RC $(head -c 300 "$LAB/ilegible.err")"
  fi
fi

# ── La cita: tiene que EMPEZAR por algo que la revisión mostró ─────────────────────────────────────
CITAS=$(con_observador "$A" '(() => {
  const k = o.promptDeRevision(propuestas, candidatos).conocidas;
  return [
    "[aaaaaaaaaa] MARCA-APROBADO buscar con CodeGraph",
    "tycon-revisor-prueba",
    "scripts/ci/porton-prueba.js",
    "build/check.js",
    "hook-prueba.",
    "hook-prueba.sh:REGLA-C1",
    "`comentado.js`",
    "build infrastructure",
    "not the same as [aaaaaaaaaa]",
    "no (closest: [aaaaaaaaaa])",
    "none (lo más parecido es tycon-revisor-prueba)",
    "dddddddddd",
    "check",
    "similar to [aaaaaaaaaa] but not the same",
    "tycon-revisor-prueba does not cover this",
    "hook-prueba isn’t the same habit",
    "[aaaaaaaaaa] — not the same",
    "[aaaaaaaaaa] (different project)",
    "tycon-revisor-prueba — does not cover this",
    "advisor: tycon-revisor-prueba",
    "Approved instinct [aaaaaaaaaa]",
    "scripts/ci/comentado.js",
  ].map((c) => String(o.citaVerificada(c, k))).join(" ");
})()' 2>&1)
[ "$CITAS" = "aaaaaaaaaa tycon-revisor-prueba scripts/ci/porton-prueba.js build/check.js hook-prueba hook-prueba comentado.js null null null null null null null null null null null null tycon-revisor-prueba aaaaaaaaaa comentado.js" ] \
  && ok "C-18 una cita vale si EMPIEZA por un hash o una pieza mostrada (con ruta, etiqueta, punto final o regla); una categoría, una frase negativa, una salvedad justo después, un pendiente o un nombre sin guion, no" \
  || bad "C-18 verificación de citas" "dio: $CITAS"

OMITIDO=$(con_observador "$T" '(() => {
  const r = o.promptDeRevision(propuestas, candidatos, "ollama");
  return [o.citaVerificada("[3000000002] viejo", r.conocidas), o.citaVerificada("[3000000001] nuevo", r.conocidas)].map(String).join(" ");
})()' 2>&1)
[ "$OMITIDO" = "null 3000000001" ] \
  && ok "C-19 el hash de un decidido que el tope dejó afuera no verifica: el modelo no pudo haberlo leído" \
  || bad "C-19 hash omitido" "dio: $OMITIDO"

LEIDO=$(con_observador "$A" '(() => {
  const v = o.leerRevision("```yaml\n- p: P1\n  covered_by: \"[aaaaaaaaaa] algo\"\n  why: \"igual\"\n\n- p: 2\n  covered_by: none\n```", 2);
  const cero = o.leerRevision("- p: 0\n  covered_by: \"[aaaaaaaaaa]\"\n- p: 1\n  covered_by: none\n", 2);
  return [v.size, v.get(1).covered_by, v.get(1).why, v.get(2).covered_by, cero.get(1).covered_by, cero.get(2).covered_by].join("|");
})()' 2>&1)
[ "$LEIDO" = "2|[aaaaaaaaaa] algo|igual|none|[aaaaaaaaaa]|none" ] \
  && ok "C-20 los veredictos se leen con «p: 1» o «p: P1»; si numeró desde 0, cada uno va a su propuesta y no a la siguiente" \
  || bad "C-20 lectura de veredictos" "dio: $LEIDO"

# ── De punta a punta, con modelos de mentira que contestan las dos llamadas ───────────────────────────
# Cinco propuestas: una baja de confianza (no llega a la revisión), una que la revisión cita con un hash
# mostrado, una con `none`, una que cita una categoría y una que dice «no (closest: [hash])».
cat > "$LAB/respuesta-propuestas.txt" <<'YAML'
```yaml
- trigger: "PROPUESTA-BAJA confianza"
  action: "algo"
  confidence: 0.5
  candidate_index: 1
- trigger: "PROPUESTA-CUBIERTA buscar con CodeGraph en Totora"
  action: "usar codegraph_search"
  confidence: 0.95
  scope: project
  project: "Totora"
  candidate_index: 1
- trigger: "PROPUESTA-NUEVA regenerar el cliente antes del typecheck"
  action: "correr la generación primero"
  confidence: 0.95
  candidate_index: 1
- trigger: "PROPUESTA-CITA-FALSA algo que dice cubrir una categoría"
  action: "otra cosa concreta"
  confidence: 0.95
  candidate_index: 1
- trigger: "PROPUESTA-NEGADA parecida pero distinta"
  action: "una tercera cosa"
  confidence: 0.95
  candidate_index: 1
- trigger: "PROPUESTA-OTRO-PROYECTO el mismo hábito en tycon-claude-guides"
  action: "usar codegraph_search"
  confidence: 0.95
  candidate_index: 2
```
YAML
printf '%s\n' '- p: 1' '  covered_by: "[aaaaaaaaaa] MARCA-APROBADO"' '  why: "mismo caso"' \
  '- p: 2' '  covered_by: none' '  why: "nuevo"' \
  '- p: 3' '  covered_by: "build infrastructure"' '  why: "genérico"' \
  '- p: 4' '  covered_by: "no (closest: [aaaaaaaaaa], but a different situation)"' '  why: "distinto"' \
  '- p: 5' '  covered_by: "[aaaaaaaaaa]"' '  why: "mismo hábito"' > "$LAB/respuesta-revision.txt"

# $1 = árbol · $2 = revisión: ok | fails (falla) | prose (contesta en prosa) · $3 = claude | codex · $4 = --dry-run (opcional)
punta() {
  local nombre="$1" modo="$2" ejecutor="$3" extra="${4:-}"
  local E; E=$(arbol "$nombre")
  cp "$A/inbox/instincts/promoted/"*.yaml "$E/inbox/instincts/promoted/"
  local MES; MES=$(date -u +%Y-%m)
  mkdir -p "$LAB/obs-$nombre" "$LAB/bin-$nombre"
  for i in 1 2 3 4 5; do
    echo "{\"ts\":\"${MES}-0${i}T10:00:00Z\",\"tool\":\"Bash\",\"project\":\"Totora\",\"summary\":\"grep -rn obtenerDetalle src/\",\"status\":\"ok\"}" >> "$LAB/obs-$nombre/${MES}.jsonl"
  done
  for i in 1 2 3 4; do
    echo "{\"ts\":\"${MES}-0${i}T11:00:00Z\",\"tool\":\"Read\",\"project\":\"tycon-claude-guides\",\"summary\":\"Read scripts/x.js\",\"status\":\"ok\"}" >> "$LAB/obs-$nombre/${MES}.jsonl"
  done
  [ -n "${DESCARTADOS_COMO_ARCHIVO:-}" ] && printf 'no soy una carpeta\n' > "$E/inbox/instincts/descartados"
  ln -sf "$(command -v node)" "$LAB/bin-$nombre/node"
  cat > "$LAB/bin-$nombre/$ejecutor" <<STUB
#!/usr/bin/env bash
if [ "\$1" = "--version" ]; then echo "$ejecutor de mentira"; exit 0; fi
entrada=\$(cat)
salida="$LAB/respuesta-propuestas.txt"
if printf '%s' "\$entrada" | grep "You are checking proposed" >/dev/null; then
  printf '%s' "\$entrada" > "$LAB/$nombre.revision-recibida.txt"
  case "$modo" in
    fails) echo "sin cuota" >&2; exit 1 ;;
    prose) printf 'All proposals look new to me.\n' > "$LAB/$nombre.prosa.txt"; salida="$LAB/$nombre.prosa.txt" ;;
    *) salida="$LAB/respuesta-revision.txt" ;;
  esac
fi
if [ "$ejecutor" = codex ]; then
  prev=""; for a in "\$@"; do [ "\$prev" = "-o" ] && cat "\$salida" > "\$a"; prev="\$a"; done
else
  cat "\$salida"
fi
exit 0
STUB
  chmod +x "$LAB/bin-$nombre/$ejecutor"
  mkdir -p "$LAB/tmp-$nombre"
  HOME="$E/home" PATH="$LAB/bin-$nombre:/usr/bin:/bin" TMPDIR="$LAB/tmp-$nombre" TYCON_INSTINCT_OBS_DIR="$LAB/obs-$nombre" TYCON_OBSERVER_EXECUTOR="$ejecutor" \
    con_limite node "$E/scripts/instincts/instinct-observer.js" --since "$MES" $extra > /dev/null 2> "$LAB/$nombre.log"
  local rc=$?
  echo "rc=$rc pending=$(grep -ho '^trigger: "PROPUESTA-[A-Z-]*' "$E/inbox/instincts/pending/"*.yaml 2>/dev/null | sed 's/^trigger: "//' | sort | tr '\n' ' ')descartados=$(grep -ho '^trigger: "PROPUESTA-[A-Z-]*' "$E/inbox/instincts/descartados/"*.yaml 2>/dev/null | sed 's/^trigger: "//' | sort | tr '\n' ' ')"
}

SALIDA=$(punta punta ok claude)
E1="$LAB/punta"
if [ "$SALIDA" = "rc=0 pending=PROPUESTA-CITA-FALSA PROPUESTA-NEGADA PROPUESTA-NUEVA PROPUESTA-OTRO-PROYECTO descartados=PROPUESTA-CUBIERTA " ] \
  && grep -qF 'Descartada "PROPUESTA-CUBIERTA buscar con CodeGraph en Totora" — ya lo cubre aaaaaaaaaa: mismo caso' "$LAB/punta.log" \
  && grep -qF "la revisión citó algo que su prompt no mostró, o lo negó: build infrastructure" "$LAB/punta.log" \
  && grep -qF "la revisión citó aaaaaaaaaa, que es de otro proyecto (totora)" "$LAB/punta.log" \
  && ! grep -qF "no mostró, o lo negó: no (closest" "$LAB/punta.log" \
  && grep -qF 'cubierto_por: "aaaaaaaaaa"' "$E1/inbox/instincts/descartados/"*.yaml \
  && grep -qF "project: Totora" "$LAB/punta.revision-recibida.txt" && ! grep -qF "PROPUESTA-BAJA" "$LAB/punta.revision-recibida.txt"; then
  ok "C-21 lo que la revisión cita con un decidido del mismo proyecto va a descartados con su cita; lo que cita una categoría, niega la cobertura o cita un decidido de OTRO proyecto, a la bandeja"
else
  bad "C-21 revisión de punta a punta" "$SALIDA · $(tail -5 "$LAB/punta.log" | tr '\n' ' ')"
fi

SALIDA=$(punta cae fails claude)
[ "$SALIDA" = "rc=0 pending=PROPUESTA-CITA-FALSA PROPUESTA-CUBIERTA PROPUESTA-NEGADA PROPUESTA-NUEVA PROPUESTA-OTRO-PROYECTO descartados=" ] \
  && grep -qF "La revisión contra lo que ya existe falló" "$LAB/cae.log" \
  && ok "C-22 si la revisión falla, lo propuesto llega igual a la bandeja y el log lo dice" \
  || bad "C-22 revisión caída" "$SALIDA · $(tail -3 "$LAB/cae.log" | tr '\n' ' ')"

SALIDA=$(punta prosa prose claude)
[ "$SALIDA" = "rc=0 pending=PROPUESTA-CITA-FALSA PROPUESTA-CUBIERTA PROPUESTA-NEGADA PROPUESTA-NUEVA PROPUESTA-OTRO-PROYECTO descartados=" ] \
  && grep -qF "La revisión contestó algo que no se entendió" "$LAB/prosa.log" \
  && ok "C-23 si la revisión contesta en otro formato, lo propuesto llega igual y el log dice que no se entendió" \
  || bad "C-23 revisión ilegible" "$SALIDA · $(tail -3 "$LAB/prosa.log" | tr '\n' ' ')"

SALIDA=$(punta codex ok codex)
[ "$SALIDA" = "rc=0 pending=PROPUESTA-CITA-FALSA PROPUESTA-NEGADA PROPUESTA-NUEVA PROPUESTA-OTRO-PROYECTO descartados=PROPUESTA-CUBIERTA " ] \
  && [ -z "$(ls -A "$LAB/tmp-codex")" ] \
  && ok "C-24 con codex la revisión funciona igual (las dos llamadas usan el mismo archivo de salida, y no queda nada en el temporal)" \
  || bad "C-24 codex" "$SALIDA · $(tail -3 "$LAB/codex.log" | tr '\n' ' ')"

SALIDA=$(punta seco ok claude --dry-run)
[ "$SALIDA" = "rc=0 pending=descartados=" ] && grep -qF "Descartada \"PROPUESTA-CUBIERTA" "$LAB/seco.log" \
  && ok "C-25 en --dry-run la revisión corre y se loguea, pero no escribe ni la bandeja ni descartados" \
  || bad "C-25 dry-run" "$SALIDA"

# ── /tycon-instincts review muestra lo descartado ──────────────────────────────────────────────────
# Con la carpeta de usuario del árbol de prueba: el comando lee TODOS los lugares donde puede haber
# propuestas, también el clon que la máquina declara que mantiene. Con la carpeta de usuario real, en una máquina que
# declara uno, la lista sumaría los descartados de ese clon («2 propuesta(s)» en vez de 1).
en_e1() { ( cd "$E1" && HOME="$E1/home" USERPROFILE="$E1/home" node scripts/instincts/instinct-promote.js "$@" ); }
LISTA=$(en_e1 list 2>&1)
HASH_DESC=$(grep -h '^hash:' "$E1/inbox/instincts/descartados/"*.yaml 2>/dev/null | head -1 | awk '{print $2}')
MOSTRADO=$(en_e1 show "${HASH_DESC:-sin-hash}" 2>&1)
if echo "$LISTA" | grep -F "1 propuesta(s) que la revisión del observer descartó" >/dev/null && echo "$LISTA" | grep -F "PROPUESTA-CUBIERTA" >/dev/null \
  && echo "$LISTA" | grep -F "la cubre: aaaaaaaaaa — mismo caso" >/dev/null && echo "$MOSTRADO" | grep -F "cubierto_por" >/dev/null; then
  ok "C-26 la lista de pending resume lo que la revisión descartó (con qué lo cubre), y show lo encuentra"
else
  bad "C-26 lista de descartados" "$(echo "$LISTA" | tail -6 | tr '\n' ' ')"
fi

SALIDA=$(DESCARTADOS_COMO_ARCHIVO=1 punta roto ok claude)
[ "$SALIDA" = "rc=0 pending=PROPUESTA-CITA-FALSA PROPUESTA-NEGADA PROPUESTA-NUEVA PROPUESTA-OTRO-PROYECTO descartados=" ] \
  && grep -qF "No pude dejar constancia en inbox/instincts/descartados/" "$LAB/roto.log" && grep -qF "Done." "$LAB/roto.log" \
  && ok "C-27 si inbox/instincts/descartados/ no se puede escribir, el observador no se cae: lo dice y lo nuevo llega igual a la bandeja" \
  || bad "C-27 descartados sin escritura" "$SALIDA · $(tail -3 "$LAB/roto.log" | tr '\n' ' ')"

# Otra corrida sobre el mismo árbol, con el descarte anterior fechado ayer: queda UN archivo por propuesta.
ANTERIOR=$(ls "$E1/inbox/instincts/descartados/"*.yaml | head -1)
AYER=$(node -e 'console.log(new Date(Date.now() - 864e5).toISOString().slice(0, 10).replace(/-/g, ""))')
mv "$ANTERIOR" "$E1/inbox/instincts/descartados/${AYER}${ANTERIOR##*/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]}"
MES=$(date -u +%Y-%m)
HOME="$E1/home" PATH="$LAB/bin-punta:/usr/bin:/bin" TMPDIR="$LAB/tmp-punta" TYCON_INSTINCT_OBS_DIR="$LAB/obs-punta" TYCON_OBSERVER_EXECUTOR=claude \
  con_limite node "$E1/scripts/instincts/instinct-observer.js" --since "$MES" > /dev/null 2> "$LAB/punta2.log"
N_DESC=$(ls "$E1/inbox/instincts/descartados/"*.yaml | wc -l | tr -d ' ')
VECES_OK=$(grep -c 'veces_descartada: 2' "$E1/inbox/instincts/descartados/"*.yaml 2>/dev/null)
# Una copia vieja del mismo descarte (la dejaría una versión anterior o un borrado fallido): la lista cuenta la propuesta, no los archivos.
ACTUAL=$(ls "$E1/inbox/instincts/descartados/"*.yaml | head -1)
cp "$ACTUAL" "$E1/inbox/instincts/descartados/${AYER}${ACTUAL##*/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]}"
LISTA2=$(en_e1 list 2>&1)
if [ "$N_DESC" = 1 ] && [ "$VECES_OK" = 1 ] \
  && echo "$LISTA2" | grep -F "1 propuesta(s) que la revisión del observer descartó" >/dev/null && echo "$LISTA2" | grep -F "(descartada 2 veces)" >/dev/null; then
  ok "C-28 la misma repetición en otra corrida deja un solo archivo, con cuántas veces se descartó, y la lista la cuenta una vez (también si quedó una copia vieja)"
else
  bad "C-28 descartes repetidos" "archivos=$N_DESC · $(echo "$LISTA2" | tail -4 | tr '\n' ' ')"
fi

DECIDE=$(con_observador "$A" '(() => {
  const rev = { conocidas: new Set(["aaaaaaaaaa", "acacacac02", "tycon-revisor-prueba"]), proyectos: ["totora", "ceibo", "global"],
    proyectosPorHash: new Map([["aaaaaaaaaa", ["totora"]], ["acacacac02", []]]) };
  const d = (v, k) => { const r = o.decidirDescarte(v, rev, k); return r === null ? "null" : r.cita ? `cita:${r.cita}` : "sigue"; };
  return [
    d({ covered_by: "[aaaaaaaaaa]", why: "mismo caso" }, 0),
    d({ covered_by: "[aaaaaaaaaa]", why: "mismo caso" }, 1),
    d({ covered_by: "[aaaaaaaaaa]", why: "mismo caso" }, 2),
    d({ covered_by: "[acacacac02]", why: "global" }, 1),
    d({ covered_by: "tycon-revisor-prueba", why: "audita eso" }, 1),
    d({ covered_by: "[aaaaaaaaaa]", why: "different project, so NOT covered" }, 0),
    d({ covered_by: "none", why: "" }, 0),
  ].join(" ");
})()' 2>&1)
[ "$DECIDE" = "cita:aaaaaaaaaa sigue cita:aaaaaaaaaa cita:acacacac02 cita:tycon-revisor-prueba sigue null" ] \
  && ok "C-29 un decidido de otro proyecto no descarta (uno global o una pieza, sí), y un why que niega la cobertura tampoco" \
  || bad "C-29 decisión de descarte" "dio: $DECIDE"

# ── El contexto de ollama se dimensiona con el prompt ──────────────────────────────────────────────
# Se juzga por lo que imprime, no por el código de salida: un guion sin exportaciones corre el observador
# al requerirlo, y ése sale 0 ("sin ejecutor").
CTX=$(con_observador "$A" '[17702, 25526, 500000].map((n) => o.contextoOllama("x".repeat(n))).join(" ")' 2>&1)
[ "$CTX" = "8192 16384 32768" ] \
  && ok "C-30 ollama: 8192 para el prompt que propone, 16384 para uno de ~25.000 caracteres, techo 32768" \
  || bad "C-30 contexto de ollama" "dio: $(echo "$CTX" | head -c 200)"

# ── T18 R2_Instincts_ScriptsFindRepoRootAndLib ────────────────────────────────
# Los tres guiones viven en scripts/instincts/ y los datos en inbox/instincts/: desde ahí tienen que encontrar
# la raíz del arnés (dos niveles arriba), sus carpetas de datos y la biblioteca (scripts/lib/). El hook que los
# lanza, el medidor del perfil y los reemplazos de la ruta vieja también. Todo en un árbol de prueba: nada
# escribe en el arnés. Con un ambiente vacío (env -i): un chat o un perfil de la máquina no cambian el caso.
R2=$(arbol r2)
limpio() { con_limite env -i HOME="$R2/home" PATH="$LAB/bin:/usr/bin:/bin" TYCON_INSTINCT_OBS_DIR="$LAB/sin-observaciones" "$@"; }

DUENO=$(limpio node -e 'process.stdout.write(require(process.argv[1]).ownerDePrefijo("NOEXISTE"))' "$R2/scripts/instincts/instinct-draft.js" 2>&1)
[ "$DUENO" = "UNKNOWN-ADVISOR" ] \
  && ok "T18 instinct-draft encuentra la biblioteca (scripts/lib/installed-packs.js) desde scripts/instincts/" \
  || bad "T18 draft + biblioteca" "dio: $(echo "$DUENO" | head -c 200)"

instinto "$R2/inbox/instincts/pending/20261002-r2-a1a1a1a1a1.yaml" "MARCA-R2-APROBAR" "Totora" "hash: a1a1a1a1a1" \
  "confidence: 0.95" "engram_promoted: false" 'tycon_artifact_suggestion: "advisor:NOEXISTE-C1"'
instinto "$R2/inbox/instincts/pending/20261002-r2-b2b2b2b2b2.yaml" "MARCA-R2-RECHAZAR" "Totora" "hash: b2b2b2b2b2"
LISTA_R2=$(cd "$R2" && limpio node scripts/instincts/instinct-promote.js list 2>&1)
APRUEBA=$(cd "$R2" && limpio node scripts/instincts/instinct-promote.js approve a1a1a1a1a1 2>&1)
RECHAZA=$(cd "$R2" && limpio node scripts/instincts/instinct-promote.js reject b2b2b2b2b2 --reason "prueba" 2>&1)
if echo "$LISTA_R2" | grep -F "MARCA-R2-APROBAR" >/dev/null && echo "$LISTA_R2" | grep -F "MARCA-R2-RECHAZAR" >/dev/null \
  && [ -f "$R2/inbox/instincts/promoted/20261002-r2-a1a1a1a1a1.yaml" ] && [ -f "$R2/inbox/instincts/archived/20261002-r2-b2b2b2b2b2.yaml" ] \
  && [ -z "$(ls -A "$R2/inbox/instincts/pending")" ] && [ -f "$R2/inbox/instincts/drafts/a1a1a1a1a1-advisor-noexiste-c1.md" ] \
  && echo "$APRUEBA" | grep -F "Archivo: inbox/instincts/drafts/a1a1a1a1a1-advisor-noexiste-c1.md" >/dev/null \
  && [ ! -e "$R2/scripts/instincts/pending" ] && [ ! -e "$R2/scripts/instincts/drafts" ] && [ ! -e "$R2/instincts" ]; then
  ok "T18 instinct-promote lista, aprueba (con su borrador) y rechaza sobre inbox/instincts/{pending,promoted,archived,drafts}"
else
  bad "T18 promote en inbox/instincts" "$(echo "$LISTA_R2 $APRUEBA $RECHAZA" | tail -4 | tr '\n' ' ' | head -c 300)"
fi

AVISO=$(limpio TYCON_INSTINCT_NOTIFY=1 node "$R2/scripts/instincts/instinct-observer.js" --notify --dry-run 2>&1); RC=$?
if [ "$RC" = 0 ] && echo "$AVISO" | grep -F "Telegram apagado en esta máquina" >/dev/null && ! echo "$AVISO" | grep -F "Cannot find module" >/dev/null; then
  ok "T18 instinct-observer --notify lee la configuración del arnés (scripts/lib/tycon-config.js) desde scripts/instincts/"
else
  bad "T18 observer + tycon-config" "rc=$RC $(echo "$AVISO" | head -3 | tr '\n' ' ' | head -c 300)"
fi

# El hook del arranque: se ubica por su carpeta (scripts/hooks/ → la raíz) y lanza el observador de la ruta nueva,
# con el log en inbox/instincts/observer.log. Un observador de mentira deja su marca y una línea en el log.
H=$(arbol hook)
cp "$TCG/scripts/hooks/instinct-trigger.sh" "$H/scripts/hooks/"
cat > "$H/scripts/instincts/instinct-observer.js" <<'EOF'
require('fs').writeFileSync(require('path').join(__dirname, '..', '..', 'corrio.txt'), process.argv.slice(2).join(' '));
console.log('LINEA-DEL-OBSERVADOR');
EOF
con_limite env -i HOME="$H/home" PATH="$LAB/bin:/usr/bin:/bin" TYCON_INSTINCT_OBSERVER=1 TYCON_NO_BOOTSTRAP_HEAL=1 \
  bash "$H/scripts/hooks/instinct-trigger.sh" < /dev/null > /dev/null 2>&1; RC=$?
for _ in $(seq 1 100); do grep -qF "LINEA-DEL-OBSERVADOR" "$H/inbox/instincts/observer.log" 2>/dev/null && break; sleep 0.1; done
if [ "$RC" = 0 ] && [ "$(cat "$H/corrio.txt" 2>/dev/null)" = "--notify" ] \
  && grep -qF "LINEA-DEL-OBSERVADOR" "$H/inbox/instincts/observer.log" 2>/dev/null && [ ! -e "$H/instincts" ]; then
  ok "T18 instinct-trigger.sh lanza scripts/instincts/instinct-observer.js y escribe el log en inbox/instincts/observer.log"
else
  bad "T18 hook del arranque" "rc=$RC corrió=$(cat "$H/corrio.txt" 2>/dev/null || echo no) log=$(ls "$H/inbox/instincts/" 2>&1 | tr '\n' ' ')"
fi

# Las rutas viejas salen del mapa de renombres, nunca escritas acá: la copia pública no lleva ni el mapa ni los
# reemplazos, y ahí lo que las necesita se saltea como NO MEDIDO.
CON_MAPA=""; [ -f "$TCG/scripts/lib/renames.json" ] && CON_MAPA=1
viejo_de() { # $1 = ruta nueva → la vieja según el mapa (vacío si no hay mapa o entrada)
  [ -n "$CON_MAPA" ] || return 0
  node -e '
    const l = require(process.argv[1]);
    const e = l.usableEntries(l.loadMap()).find((x) => x.kind === "file" && x.new === process.argv[2]);
    process.stdout.write(e ? e.old : "");
  ' "$TCG/scripts/lib/legacy-names.js" "$1" 2>/dev/null
}
V_OBS=$(viejo_de scripts/instincts/instinct-observer.js)
V_PROMOTE=$(viejo_de scripts/instincts/instinct-promote.js)
V_DRAFT=$(viejo_de scripts/instincts/instinct-draft.js)

# El medidor del perfil del equipo lee el chat del observador en la base: la ruta nueva si la base ya la tiene
# (aunque esté el reemplazo en la vieja), la vieja si la base es de antes de la mudanza.
mkdir -p "$LAB/base-nueva/scripts/instincts"
: > "$LAB/base-nueva/scripts/instincts/instinct-observer.js"
if [ -z "$CON_MAPA" ]; then
  CHAT=$(node -e 'process.stdout.write(require(process.argv[1]).chatFileIn(process.argv[2]))' "$TCG/scripts/publishing/profile-equivalence.js" "$LAB/base-nueva" 2>&1)
  [ "$CHAT" = "scripts/instincts/instinct-observer.js" ] \
    && ok "T18 profile-equivalence lee el chat del observador en scripts/instincts/ (la base vieja: NO MEDIDO — copia pública sin el mapa)" \
    || bad "T18 profile-equivalence" "dio: $(echo "$CHAT" | head -c 200)"
elif [ -z "$V_OBS" ]; then
  bad "T18 profile-equivalence" "el mapa no tiene la entrada de scripts/instincts/instinct-observer.js"
else
  mkdir -p "$(dirname "$LAB/base-nueva/$V_OBS")" "$(dirname "$LAB/base-vieja/$V_OBS")"
  : > "$LAB/base-nueva/$V_OBS"; : > "$LAB/base-vieja/$V_OBS"
  CHAT=$(node -e '
    const p = require(process.argv[1]);
    process.stdout.write([p.chatFileIn(process.argv[2]), p.chatFileIn(process.argv[3])].join(" "));
  ' "$TCG/scripts/publishing/profile-equivalence.js" "$LAB/base-nueva" "$LAB/base-vieja" 2>&1)
  [ "$CHAT" = "scripts/instincts/instinct-observer.js $V_OBS" ] \
    && ok "T18 profile-equivalence lee el chat del observador en scripts/instincts/ (y en la ruta vieja si la base es anterior)" \
    || bad "T18 profile-equivalence" "dio: $(echo "$CHAT" | head -c 200)"
fi

# Los reemplazos de la ruta vieja (los genera legacy-names.js --write-shims desde el mapa): /tycon-instincts
# todavía puede llamar a instinct-promote por su ruta vieja y da lo mismo que la ruta nueva.
if [ -z "$CON_MAPA" ]; then
  echo "⏭️  T18 reemplazos: NO MEDIDO — copia pública sin el mapa"
elif [ -z "$V_OBS" ] || [ -z "$V_PROMOTE" ] || [ -z "$V_DRAFT" ]; then
  bad "T18 reemplazos" "el mapa no tiene las tres entradas de scripts/instincts/ (observer=$V_OBS promote=$V_PROMOTE draft=$V_DRAFT)"
else
  for v in "$V_PROMOTE" "$V_OBS" "$V_DRAFT"; do
    [ -f "$TCG/$v" ] && mkdir -p "$(dirname "$R2/$v")" && cp "$TCG/$v" "$R2/$v"
  done
  if [ ! -f "$R2/$V_PROMOTE" ] || [ ! -f "$R2/$V_OBS" ] || [ ! -f "$R2/$V_DRAFT" ]; then
    bad "T18 reemplazos" "falta el reemplazo de alguna ruta vieja ($V_PROMOTE, $V_OBS, $V_DRAFT): correr legacy-names.js --write-shims"
  else
    instinto "$R2/inbox/instincts/pending/20261002-r2-c3c3c3c3c3.yaml" "MARCA-R2-VIEJA" "Totora" "hash: c3c3c3c3c3"
    NUEVA=$(cd "$R2" && limpio node scripts/instincts/instinct-promote.js list 2>&1); RN=$?
    VIEJA=$(cd "$R2" && limpio node "$V_PROMOTE" list 2>&1); RV=$?
    DVIEJO=$(limpio node -e 'process.stdout.write(require(process.argv[1]).ownerDePrefijo("NOEXISTE"))' "$R2/$V_DRAFT" 2>&1)
    if [ "$RN" = 0 ] && [ "$RN" = "$RV" ] && [ "$NUEVA" = "$VIEJA" ] && echo "$VIEJA" | grep -F "MARCA-R2-VIEJA" >/dev/null && [ "$DVIEJO" = "UNKNOWN-ADVISOR" ]; then
      ok "T18 los reemplazos de la ruta vieja (instinct-promote list, instinct-draft) dan lo mismo que la nueva"
    else
      bad "T18 reemplazos" "rc nueva=$RN vieja=$RV draft=$(echo "$DVIEJO" | head -c 80) · $(echo "$VIEJA" | head -3 | tr '\n' ' ' | head -c 200)"
    fi
  fi
fi

# ── T18b R2_Instincts_LegacyDiscardedFolderMigrates ─────────────
# En cada máquina que ya corrió el observador quedan, en la carpeta de antes de la
# mudanza, archivos locales que nunca viajaron por git. El log se queda, pero `descartados/` es estado: con
# su contador `veces_descartada`, el observador sabe cuántas veces ya descartó lo mismo. Sin migrarlo, el observador e
# instinct-promote miran sólo inbox/instincts/descartados/ y esa memoria se pierde. La primera corrida después del pull
# lleva los archivos a la carpeta nueva y lo dice en una línea; la segunda no hace nada. Si un archivo está en las dos
# con el mismo nombre, gana el de más veces descartada (empate: el descartado más nuevo). El nombre viejo sale del mapa.
viejo_carpeta() {
  [ -n "$CON_MAPA" ] || return 0
  node -e '
    const l = require(process.argv[1]);
    const e = l.usableEntries(l.loadMap()).find((x) => x.kind === "folder" && x.new === "inbox/instincts");
    process.stdout.write(e ? e.old : "");
  ' "$TCG/scripts/lib/legacy-names.js" 2>/dev/null
}
V_CARPETA=$(viejo_carpeta)
if [ -z "$CON_MAPA" ]; then
  echo "⏭️  T18b descartados de la carpeta vieja: NO MEDIDO — copia pública sin el mapa"
elif [ -z "$V_CARPETA" ]; then
  bad "T18b descartados de la carpeta vieja" "el mapa no tiene la entrada folder → inbox/instincts"
else
  MES=$(date -u +%Y-%m)
  # 1) De punta a punta con el observador: una corrida deja PROPUESTA-CUBIERTA en descartados; se lleva a la carpeta
  #    vieja con el contador en 3 (más otro descartado y el log viejo) y se vuelve a correr.
  punta migra ok claude > /dev/null
  M="$LAB/migra"
  mkdir -p "$M/$V_CARPETA/descartados"
  for f in "$M/inbox/instincts/descartados/"*.yaml; do
    sed 's/^veces_descartada: .*/veces_descartada: 3/' "$f" > "$M/$V_CARPETA/descartados/${f##*/}" && rm -f "$f"
  done
  instinto "$M/$V_CARPETA/descartados/20260920-otro-d4d4d4d4d4.yaml" "MARCA-DESCARTE-VIEJO" "Totora" "hash: d4d4d4d4d4" "veces_descartada: 2"
  printf 'log de antes\n' > "$M/$V_CARPETA/observer.log"
  correr_migra() {
    HOME="$M/home" PATH="$LAB/bin-migra:/usr/bin:/bin" TMPDIR="$LAB/tmp-migra" TYCON_INSTINCT_OBS_DIR="$LAB/obs-migra" TYCON_OBSERVER_EXECUTOR=claude \
      con_limite node "$M/scripts/instincts/instinct-observer.js" --since "$MES" > /dev/null 2> "$1"
  }
  correr_migra "$LAB/migra2.log"; RC1=$?
  CUB=$(grep -l '^trigger: "PROPUESTA-CUBIERTA' "$M/inbox/instincts/descartados/"*.yaml 2>/dev/null | wc -l | tr -d ' ')
  if [ "$RC1" = 0 ] && [ "$CUB" = 1 ] \
    && grep -qF 'veces_descartada: 4' "$(grep -l '^trigger: "PROPUESTA-CUBIERTA' "$M/inbox/instincts/descartados/"*.yaml)" \
    && [ -f "$M/inbox/instincts/descartados/20260920-otro-d4d4d4d4d4.yaml" ] \
    && ! grep -qF 'PROPUESTA-CUBIERTA' "$M/inbox/instincts/pending/"*.yaml \
    && [ ! -e "$M/$V_CARPETA/descartados" ] && [ "$(cat "$M/$V_CARPETA/observer.log")" = "log de antes" ] \
    && [ "$(grep -cF "descartado(s) de $V_CARPETA/descartados/ a inbox/instincts/descartados/" "$LAB/migra2.log")" = 1 ]; then
    ok "T18b adversarial R2: los descartados de la carpeta vieja pasan a inbox/instincts/descartados/ con su contador (3 → 4), el observador no los re-propone, el log viejo se queda y se dice en una línea"
  else
    bad "T18b migración con el observador" "rc=$RC1 cubierta=$CUB · $(ls "$M/inbox/instincts/descartados/" "$M/$V_CARPETA" 2>&1 | tr '\n' ' ') · $(tail -4 "$LAB/migra2.log" | tr '\n' ' ')"
  fi
  correr_migra "$LAB/migra3.log"; RC2=$?
  if [ "$RC2" = 0 ] && ! grep -qF "descartado(s) de" "$LAB/migra3.log" && [ ! -e "$M/$V_CARPETA/descartados" ] \
    && grep -qF 'veces_descartada: 5' "$(grep -l '^trigger: "PROPUESTA-CUBIERTA' "$M/inbox/instincts/descartados/"*.yaml)" \
    && [ -f "$M/inbox/instincts/descartados/20260920-otro-d4d4d4d4d4.yaml" ]; then
    ok "T18b adversarial R2: la segunda corrida no migra nada (idempotente) y el contador sigue sumando"
  else
    bad "T18b segunda corrida" "rc=$RC2 · $(tail -4 "$LAB/migra3.log" | tr '\n' ' ')"
  fi

  # 2) Choque con instinct-promote: el mismo nombre en las dos carpetas. Gana el de más veces descartada; empate, el
  #    descartado más nuevo. La carpeta vieja de descartados se va; lo demás de la carpeta vieja se queda.
  C=$(arbol choque)
  mkdir -p "$C/$V_CARPETA/descartados" "$C/inbox/instincts/descartados"
  instinto "$C/$V_CARPETA/descartados/20260901-x-c1c1c1c1c1.yaml" "VIEJO-C1" "" "hash: c1c1c1c1c1" "veces_descartada: 2" 'descartado_at: "2026-09-05T00:00:00.000Z"'
  instinto "$C/inbox/instincts/descartados/20260901-x-c1c1c1c1c1.yaml" "NUEVO-C1" "" "hash: c1c1c1c1c1" "veces_descartada: 4" 'descartado_at: "2026-09-01T00:00:00.000Z"'
  instinto "$C/$V_CARPETA/descartados/20260901-y-c2c2c2c2c2.yaml" "VIEJO-C2" "" "hash: c2c2c2c2c2" "veces_descartada: 5" 'descartado_at: "2026-09-01T00:00:00.000Z"'
  instinto "$C/inbox/instincts/descartados/20260901-y-c2c2c2c2c2.yaml" "NUEVO-C2" "" "hash: c2c2c2c2c2" "veces_descartada: 1" 'descartado_at: "2026-09-09T00:00:00.000Z"'
  instinto "$C/$V_CARPETA/descartados/20260901-z-c3c3c3c3c3.yaml" "VIEJO-C3" "" "hash: c3c3c3c3c3" "veces_descartada: 2" 'descartado_at: "2026-09-02T00:00:00.000Z"'
  instinto "$C/inbox/instincts/descartados/20260901-z-c3c3c3c3c3.yaml" "NUEVO-C3" "" "hash: c3c3c3c3c3" "veces_descartada: 2" 'descartado_at: "2026-09-01T00:00:00.000Z"'
  instinto "$C/$V_CARPETA/descartados/20260901-w-c4c4c4c4c4.yaml" "VIEJO-C4" "" "hash: c4c4c4c4c4" "veces_descartada: 1"
  printf 'log de antes\n' > "$C/$V_CARPETA/observer.log"
  L1=$(cd "$C" && limpio node scripts/instincts/instinct-promote.js list 2>&1 >/dev/null); RL1=$?
  L2=$(cd "$C" && limpio node scripts/instincts/instinct-promote.js list 2>&1 >/dev/null); RL2=$?
  D="$C/inbox/instincts/descartados"
  if [ "$RL1" = 0 ] && [ "$RL2" = 0 ] \
    && tiene "$D/20260901-x-c1c1c1c1c1.yaml" "NUEVO-C1" && tiene "$D/20260901-y-c2c2c2c2c2.yaml" "VIEJO-C2" \
    && tiene "$D/20260901-z-c3c3c3c3c3.yaml" "VIEJO-C3" && tiene "$D/20260901-w-c4c4c4c4c4.yaml" "VIEJO-C4" \
    && [ "$(ls "$D" | wc -l | tr -d ' ')" = 4 ] && [ ! -e "$C/$V_CARPETA/descartados" ] && [ -f "$C/$V_CARPETA/observer.log" ] \
    && echo "$L1" | grep -F "4 descartado(s) de $V_CARPETA/descartados/ a inbox/instincts/descartados/" >/dev/null \
    && echo "$L1" | grep -F "3 con el mismo nombre en las dos" >/dev/null && [ -z "$L2" ]; then
    ok "T18b adversarial R2: instinct-promote también migra; en un choque gana el de más veces descartada (empate: el más nuevo), y la segunda vez calla"
  else
    bad "T18b choque" "rc=$RL1/$RL2 · $(echo "$L1 | $L2" | head -c 300) · $(grep -h '^trigger' "$D/"*.yaml 2>&1 | tr '\n' ' ')"
  fi

  # 3) Sin el mapa (la copia pública) no hay carpeta vieja que mirar: nada se mueve.
  S=$(arbol sinmapa)
  rm -f "$S/scripts/lib/renames.json"
  mkdir -p "$S/$V_CARPETA/descartados"
  instinto "$S/$V_CARPETA/descartados/20260901-s-c5c5c5c5c5.yaml" "SIN-MAPA" "" "hash: c5c5c5c5c5"
  LS=$(cd "$S" && limpio node scripts/instincts/instinct-promote.js list 2>&1); RS=$?
  [ "$RS" = 0 ] && [ -f "$S/$V_CARPETA/descartados/20260901-s-c5c5c5c5c5.yaml" ] && [ ! -e "$S/inbox/instincts/descartados/20260901-s-c5c5c5c5c5.yaml" ] \
    && ! echo "$LS" | grep -F "descartado(s) de" >/dev/null \
    && ok "T18b adversarial R2: sin el mapa (copia pública) no hay nada que migrar y nada se mueve" \
    || bad "T18b sin mapa" "rc=$RS · $(echo "$LS" | tail -3 | tr '\n' ' ' | head -c 200)"
fi

echo
[ "$fallos" = 0 ] && { echo "✅ instinct-observer-catalogo: todo verde"; exit 0; } || { echo "❌ instinct-observer-catalogo: $fallos fallo(s)"; exit 1; }
