#!/usr/bin/env bash
# trimmed-close.test.sh — la red de los recortes del cierre de una story.
#
# Qué se recortó y qué se quedó: sale lo que relee la
# evidencia con un modelo (el checker de DoD por default, el meta-audit C9, los dos revisores del step 9,
# la suite E2E completa del merge); se queda lo que corre código y frena (matriz por AC, gate E2E, hooks,
# portón de CI). Esta suite prueba los helpers mecánicos que reemplazan a lo recortado, que los textos
# dicen lo que se decidió, que los frenos que se quedan no cambiaron, y que la constancia no filtra datos.
#
#   T3  — dod-checker-needed: tres preguntas, y la duda va hacia invocar
#   T4  — deferrals-open: tags vivos en tasks/todo.md y tandas abiertas
#   T4b — qa-legibilidad deja su línea en gates.log (la capa 4 de la guía se puede medir)
#   T5  — on-pre-commit: sin self-audit no frena, incompleto avisa, C10 sigue frenando
#   T9  — los textos de los steps 07c y 09 y del merge dicen lo que se decidió
#   T8  — ACCOV-C9 retirada en el catálogo; rules-distill y build/check verdes
#   T10 — la constancia del cierre no filtra ruta, story ni texto del commit
#   T11 — el banco de los tres hooks del cierre sigue verde
#   T12 — run-check y el portón de CI sin cambios (la matriz no se compara: ver el caso)
#
# (T1/T2 viven en guard-record.test.sh, T6 en reducer.test.sh y T7 en dashboard.test.sh.)
#
# 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la falla que lo pone en rojo. El exit code se lee ANTES de cualquier pipe.
# Las skills se buscan como en todo el arnés (scripts/lib/skills-dir.js): TYCON_SKILLS_DIR, el propio clon si
# es unido (<clon>/skills) o ~/.claude/agent-skills/skills. Si no aparecen, lo que depende de ellas sale «NO MEDIDO»
# en rojo — nunca verde.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SKILLS="$(node "$AQUI/scripts/lib/skills-dir.js" --skills)" || SKILLS="${TYCON_SKILLS_DIR:-$HOME/.claude/agent-skills/skills}"
PIPE="$SKILLS/tycon-pipeline/scripts/pipeline.js"
# 🔴 HOME falso DESPUÉS de resolver agent-skills: los helpers escriben gates.log bajo el home.
HOME="$(mktemp -d)"; export HOME
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP" "$HOME"' EXIT
unset CLAUDE_CODE_SESSION_ID TYCON_COVERAGE_BASE
fallos=0; pasaron=0
ok(){ echo "✅ cierre-recortado: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ cierre-recortado: $1"; fallos=$((fallos+1)); }
GATES="$HOME/.claude/.tycon-pipeline/gates.log"

# Un repo efímero con una story mínima. $1 carpeta · $2 texto extra de ACs · $3 bloque pipelines (o vacío)
repo(){
  local r="$1"; rm -rf "$r"; mkdir -p "$r/specs" "$r/src" "$r/tasks"
  git -C "$r" init -q -b main
  {
    echo '---'; echo 'story: "9.9"'; echo 'epic: "9"'; echo 'status: in-progress'
    [ -n "${3:-}" ] && printf '%s\n' "$3"
    echo '---'; echo '# Story 9.9'; echo; echo '## Acceptance Criteria'; echo
    echo '1. **Given** algo **When** pasa **Then** anda.'
    [ -n "${2:-}" ] && printf '%s\n' "$2"
    echo; echo '## Tasks'
  } > "$r/specs/story-9.9.md"
  echo 'console.log(1)' > "$r/src/app.js"
  git -C "$r" add -A && git -C "$r" -c user.email=b@b -c user.name=b commit -q -m base
  git -C "$r" rev-parse HEAD
}
# corre el helper; imprime el exit y deja la salida en $TMP/out
helper(){ node "$PIPE" "$@" > "$TMP/out" 2> "$TMP/err"; echo $?; }

if [ ! -f "$PIPE" ]; then
  no "NO MEDIDO: no encontré pipeline.js en $SKILLS (TYCON_SKILLS_DIR) — los helpers de la 7.2 no se pueden verificar"
else
  # ── T3 — DodCheckerNeeded_TresPreguntas_YDudaHaciaInvocar ───────────────────────────────────────
  # 🔴 Si el subcomando no existe, sale sin exit 0/3 ni JSON.
  R="$TMP/t3a"; B="$(repo "$R")"
  printf 'public class Latido : BackgroundService { }\n' > "$R/src/Latido.cs"
  a=$(helper dod-checker-needed --story "$R/specs/story-9.9.md" --repo "$R" --base "$B")
  grep -q '"invoca": *true' "$TMP/out" && grep -qi 'worker\|BackgroundService' "$TMP/out"; wa=$?

  R="$TMP/t3b"; B="$(repo "$R" '2. **Given** un cobro **When** falla **Then** la transacción hace rollback de todo.')"
  b=$(helper dod-checker-needed --story "$R/specs/story-9.9.md" --repo "$R" --base "$B")

  R="$TMP/t3c"; B="$(repo "$R" '' "$(printf 'pipelines:\n  A-backend:\n    status: done\n  B-frontend:\n    status: blocked')")"
  c=$(helper dod-checker-needed --story "$R/specs/story-9.9.md" --repo "$R" --base "$B")

  # ninguna: diff sin worker, ACs que NOMBRAN el patrón como texto citado y tandas cerradas
  R="$TMP/t3d"; B="$(repo "$R" '2. **Given** el helper **When** busca (`TransactionScope|transacci[oó]n.*(rollback|compensa)`) **Then** decide.' "$(printf 'pipelines:\n  A:\n    status: done')")"
  echo 'console.log(2)' >> "$R/src/app.js"
  rm -f "$GATES"
  d=$(helper dod-checker-needed --story "$R/specs/story-9.9.md" --repo "$R" --base "$B")
  linea_d="$(grep '"name":"dod-checker-decision"' "$GATES" 2>/dev/null | tail -1)"

  e=$(helper dod-checker-needed --story "$R/specs/story-9.9.md" --repo "$R" --base no-existe-esta-base)
  grep -qi 'no pude' "$TMP/out"; we=$?
  f=$(helper dod-checker-needed --story "$R/specs/story-9.9.md" --repo "$R")        # sin base ni marcador: no hay base de la corrida
  g=$(helper dod-checker-needed --story "$TMP/no-existe.md" --repo "$TMP/tampoco")   # fuera del pipeline, nada legible
  grep -qi 'no pude' "$TMP/out"; wg=$?
  # 🔴 Con --repo en una SUBCARPETA, el listado de lo no trackeado sale relativo a esa carpeta y el diff
  #    relativo a la raíz; si no se normaliza, el worker nuevo se busca en la ruta equivocada y se saltea en
  #    silencio → «no invocar».
  R="$TMP/t3e"; B="$(repo "$R")"; mkdir -p "$R/api/src"; printf 'class W : IHostedService { }\n' > "$R/api/src/W.cs"
  x=$(helper dod-checker-needed --story "$R/specs/story-9.9.md" --repo "$R/api" --base "$B")

  if [ "$a" = "0" ] && [ "$wa" = "0" ] && [ "$b" = "0" ] && [ "$c" = "0" ] && [ "$d" = "3" ] \
     && echo "$linea_d" | grep '"invoca":false' >/dev/null && [ "$e" = "0" ] && [ "$we" = "0" ] && [ "$f" = "0" ] && [ "$g" = "0" ] && [ "$wg" = "0" ] && [ "$x" = "0" ]; then
    ok "T3 worker→0 (también en subcarpeta sin trackear) · transacción con rollback→0 · tanda bloqueada→0 · ninguna→3 con su línea · diff roto, sin base o sin story→0 con motivo"
  else
    no "T3 exits worker/tx/tanda/ninguna/diff-roto/sin-base/sin-story/worker-en-subcarpeta=$a/$b/$c/$d/$e/$f/$g/$x · motivo-worker=$wa · línea=[$linea_d] · motivos-no-pude=$we/$wg"
  fi

  # ── T3b — los falsos «no invocar» y «invocar de más» ─────
  # 🔴 Un caso por clase:
  #    · un .js que NOMBRA BackgroundService (pipeline.js mismo) no es un worker: invocaría de más
  #    · prosa entre dos citas con **negritas** no se puede borrar: una transacción real no se vería
  #    · un worker con tilde en la ruta sale entre comillas y no se puede descartar
  #    · con --repo en subcarpeta, un worker sin trackear FUERA de ella se lista
  #    · un .js de 3 MB no cuenta como «no pude leer» ni invoca con un motivo falso
  #    · un worker creado en OTRO repo de la misma corrida (marker.filesTouched) se ve
  R="$TMP/t3f"; B="$(repo "$R")"; printf '// busca BackgroundService|IHostedService\nconst W=/BackgroundService/;\n' > "$R/src/pipeline.js"
  y1=$(helper dod-checker-needed --story "$R/specs/story-9.9.md" --repo "$R" --base "$B")
  R="$TMP/t3g"; B="$(repo "$R" '2. **Given** `OrdenesService` **When** confirma, todo va en una transacción con rollback si falla **Then** responde `201`.')"
  y2=$(helper dod-checker-needed --story "$R/specs/story-9.9.md" --repo "$R" --base "$B")
  R="$TMP/t3h"; B="$(repo "$R")"; mkdir -p "$R/src/Notificación"; printf 'class W : BackgroundService { }\n' > "$R/src/Notificación/W.cs"
  y3=$(helper dod-checker-needed --story "$R/specs/story-9.9.md" --repo "$R" --base "$B")
  R="$TMP/t3i"; B="$(repo "$R")"; mkdir -p "$R/front" "$R/back"; echo 'x' > "$R/front/a.ts"; git -C "$R" add -A; git -C "$R" -c user.email=b@b -c user.name=b commit -q -m f; B="$(git -C "$R" rev-parse HEAD)"
  printf 'class W : IHostedService { }\n' > "$R/back/W.cs"; echo 'y' >> "$R/front/a.ts"
  y4=$(helper dod-checker-needed --story "$R/specs/story-9.9.md" --repo "$R/front" --base "$B")
  R="$TMP/t3j"; B="$(repo "$R")"; mkdir -p "$R/dist"; head -c 3200000 /dev/zero | tr '\0' 'a' > "$R/dist/form.js"
  y5=$(helper dod-checker-needed --story "$R/specs/story-9.9.md" --repo "$R" --base "$B")
  grep -qi 'no pude leer' "$TMP/out"; w5=$?
  # repos compañeros: el marcador de la corrida trae un worker de OTRO repo
  RF="$TMP/t3k-front"; RB="$TMP/t3k-back"; BF="$(repo "$RF")"; mkdir -p "$RB/Workers"; printf 'public class Sync : BackgroundService { }\n' > "$RB/Workers/Sync.cs"
  echo 'y' >> "$RF/src/app.js"
  y6="$(RF="$RF" RB="$RB" BF="$BF" node -e '
    const p=require(process.argv[1]);
    const r=p.computeDodCheckerNeeded({story:process.env.RF+"/specs/story-9.9.md",repo:process.env.RF},
      {leerMarcador:()=>({marker:{repoPath:process.env.RF,baseSha:process.env.BF,filesTouched:[process.env.RF+"/src/app.js",process.env.RB+"/Workers/Sync.cs"]},error:null})});
    process.stdout.write(r.invoca?"invoca":"no-invoca");' "$PIPE" 2>&1)"
  if [ "$y1" = "3" ] && [ "$y2" = "0" ] && [ "$y3" = "0" ] && [ "$y4" = "0" ] && [ "$y5" = "3" ] && [ "$w5" != "0" ] && [ "$y6" = "invoca" ]; then
    ok "T3b .js que nombra la palabra→no invoca · prosa entre citas→transacción vista · ruta con tilde, subcarpeta y repo compañero→worker visto · archivo grande→sin motivo falso"
  else
    no "T3b exits js-que-nombra/prosa-entre-citas/tilde/subcarpeta/archivo-grande=$y1/$y2/$y3/$y4/$y5 · motivo-falso-grande=$([ "$w5" = "0" ] && echo si || echo no) · repo-compañero=$y6"
  fi

  # ── T4 — DeferralsOpen_TagsVivosYTandasAbiertas ─────────────────────────────────────────────────
  # 🔴 Si el subcomando no existe, el caso sale rojo.
  R="$TMP/t4a"; repo "$R" >/dev/null
  printf -- '- [ ] [story-9.9-deuda] pagar la deuda del reporte\n- [x] [story-9.9-vieja] ya pagada\n' > "$R/tasks/todo.md"
  h=$(helper deferrals-open --story "$R/specs/story-9.9.md" --repo "$R")
  grep -q 'story-9.9-deuda' "$TMP/out" && ! grep -q 'story-9.9-vieja' "$TMP/out"; wh=$?

  R="$TMP/t4b"; repo "$R" '' "$(printf 'pipelines:\n  A:\n    status: done\n  B:\n    status: done')" >/dev/null
  printf -- '- [ ] [story-9.10-otra] de otra story\n' > "$R/tasks/todo.md"
  i=$(helper deferrals-open --story "$R/specs/story-9.9.md" --repo "$R")

  R="$TMP/t4c"; repo "$R" '' "$(printf 'pipelines:\n  A:\n    status: done\n  B:\n    status: in-progress')" >/dev/null
  k=$(helper deferrals-open --story "$R/specs/story-9.9.md" --repo "$R")
  grep -q '"B"' "$TMP/out"; wk=$?

  if [ "$h" = "3" ] && [ "$wh" = "0" ] && [ "$i" = "0" ] && [ "$k" = "3" ] && [ "$wk" = "0" ]; then
    ok "T4 tag vivo→3 con la lista (el tachado no cuenta) · sin tags propios y tandas cerradas→0 · tanda abierta→3"
  else
    no "T4 exits tag/limpio/tanda=$h/$i/$k · lista-tag=$wh · lista-tanda=$wk · salida=$(head -c 300 "$TMP/out")"
  fi

  # ── T4c — tags con guiones y tachados por pares ────────────────────────────────
  # 🔴 Un producto escribe `[story-2-9-…]`: si el helper sólo buscara la forma con punto, la deuda viva sería
  #    invisible (exit 0); y `~~nota~~ [story-<N.M>-x]` no se puede tomar como tachado entero.
  R="$TMP/t4e"; repo "$R" >/dev/null
  printf -- '### [story-9-9-tightening] abierto\n- [ ] [story-9-9-1-otra] es de la 9.9.1\n' > "$R/tasks/todo.md"
  z1=$(helper deferrals-open --story "$R/specs/story-9.9.md" --repo "$R")
  grep -q 'story-9-9-tightening' "$TMP/out" && ! grep -q 'story-9-9-1-otra' "$TMP/out"; wz1=$?
  printf -- '- [ ] ~~ya no aplica~~ [story-9.9-viva] sigue abierta\n- [ ] ~~[story-9.9-muerta] tachada~~\n' > "$R/tasks/todo.md"
  z2=$(helper deferrals-open --story "$R/specs/story-9.9.md" --repo "$R")
  grep -q 'story-9.9-viva' "$TMP/out" && ! grep -q 'story-9.9-muerta' "$TMP/out"; wz2=$?
  printf -- '- [ ] [story-9-9-1-sub] sólo de la sub-story\n' > "$R/tasks/todo.md"
  z3=$(helper deferrals-open --story "$R/specs/story-9.9.md" --repo "$R")
  # 🔴 Una story que EXISTE pero no se puede leer (una carpeta) no puede leerse como vacía → «sin deuda»,
  #    exit 0. Lo mismo en qa-legibilidad: no anota con el nombre de la carpeta.
  mkdir -p "$R/specs/story-carpeta.md"
  z4=$(helper deferrals-open --story "$R/specs/story-carpeta.md" --repo "$R")
  z5=$(helper qa-readability --story "$R/specs/story-carpeta.md" --repo "$R" --marks 1)
  [ "$z4" = "1" ] && [ "$z5" = "2" ] || z3="ilegible:deferrals=$z4,qa-legibilidad=$z5"
  if [ "$z1" = "3" ] && [ "$wz1" = "0" ] && [ "$z2" = "3" ] && [ "$wz2" = "0" ] && [ "$z3" = "0" ]; then
    ok "T4c tag con guiones→3 (sin tomar la sub-story) · tachado previo no oculta el tag vivo · tag dentro del tachado no cuenta"
  else
    no "T4c exits guiones/tachado/sólo-sub-story=$z1/$z2/$z3 · lista-guiones=$wz1 · lista-tachado=$wz2"
  fi

  # ── T4b — qa-legibilidad deja una línea medible en gates.log ────────────────────────────
  # 🔴 Sin el subcomando, la capa 4 de la guía no deja ninguna marca.
  R="$TMP/t4d"; repo "$R" >/dev/null; rm -f "$GATES"
  m=$(helper qa-readability --story "$R/specs/story-9.9.md" --repo "$R" --marks 3)
  linea_m="$(grep '"name":"qa-legibilidad"' "$GATES" 2>/dev/null | tail -1)"
  n=$(helper qa-readability --story "$R/specs/story-9.9.md" --repo "$R" --marks tres)
  if [ "$m" = "0" ] && echo "$linea_m" | grep '"marcas":3' >/dev/null && echo "$linea_m" | grep '"storyId":"9.9"' >/dev/null && [ "$n" = "2" ]; then
    ok "T4b qa-legibilidad anota las marcas resueltas; un número inválido no se anota (exit 2)"
  else
    no "T4b exit=$m/$n línea=[$linea_m]"
  fi
fi

# ── T5 — PreCommit_SinSelfAudit_NoBloquea_ConSelfAuditConvergenciaSigue ─────────────────────
# 🔴 Primer caso: una story a `review` con evidencia y matriz en orden, pero sin self-audit, no frena
#    (exit 0); sin esta regla frenaría por ACCOV-C8 (exit 2).
PC="$SKILLS/tycon-pipeline/scripts/on-pre-commit.js"
if [ ! -f "$PC" ]; then
  no "T5 NO MEDIDO: no encontré on-pre-commit.js en $SKILLS"
else
  export TYCON_WAIVER_LOG="$TMP/waivers.jsonl"
  spec_c8(){ # $1 archivo · $2 estado
    printf '%s\n' '---' "status: $2" 'story: 9.9' 'sprint: 9' 'runtime_not_verifiable:' \
      '  - ac: 1' '    reason: "fixture de la 7.2"' '    covered_by: T1' '---' '' '# Story 9.9' '' \
      '## Acceptance Criteria' '' '1. **Given** algo, when pasa, then anda. (Playwright E2E)' '' \
      '### Tests' '' '| Test | AC |' '|------|-----|' '| T1   | #1 |' > "$1"
  }
  audit_c8(){ # $1 archivo · resto: gaps (vacío = incompleto, sin secciones)
    local f="$1"; shift
    if [ "${1:-}" = "--incomplete" ]; then printf '# Self-audit\n## 1. Cobertura por AC\nAC #1.\n' > "$f"; return; fi
    { echo '# Self-audit'; echo '## 1. Cobertura por AC'; echo 'AC #1.'; echo '## 2. Cobertura por interacción'; echo 'OK.'
      echo '## 3. Gaps conocidos'; echo '| Gap | Desc |'; echo '|---|---|'
      for g in "$@"; do echo "| **$g — x** | x |"; done
      echo '## 4. Verificación de no-regresión'; echo 'OK.'; echo '## 5. Confianza del agente'; echo '8/10.'; } > "$f"
  }
  caso_c8(){ # $1 carpeta · $2 estado nuevo → deja la story staged con evidencia y la matriz firmada
    local r="$1"; rm -rf "$r"; mkdir -p "$r/specs/stories" "$r/.advisors/dod-runtime"
    git -C "$r" init -q; git -C "$r" config user.email t@t; git -C "$r" config user.name t
    spec_c8 "$r/specs/stories/9-9.md" in-progress; git -C "$r" add -A; git -C "$r" commit -q -m base
    spec_c8 "$r/specs/stories/9-9.md" "$2"; git -C "$r" add -A
    printf '# DoD\n## Playwright Run\nnpx playwright test story-9-9.spec.ts → PASS (1/1)\n#### AC #1 — ok\n' > "$r/.advisors/dod-runtime/9.9-2026-09-16T00-00-00Z.md"
    printf '{"ts":"2026-09-16T00:00:00Z","story_id":"9.9","suite_green":true}' > "$r/.advisors/tests-result.json"
    : > "$TYCON_WAIVER_LOG"
    SPEC="$r/specs/stories/9-9.md" SK="$SKILLS/tycon-pipeline/scripts" node -e '
      const rm=require(process.env.SK+"/runtime-matrix.js"), w=require(process.env.SK+"/lib/runtime-waiver.js");
      const m=rm.compute({storyPath:process.env.SPEC}); if(m.structuralError){console.error(m.structuralError);process.exit(1)}
      if(m.pendientes.length) w.appendWaiver({story:m.sid,acs:m.pendientes,matrixHash:m.hash,approvedBy:"test(TTY)",nowIso:new Date().toISOString()});' 2>/dev/null
  }
  correr_pc(){ node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",tool_input:{command:"git commit -m t"},cwd:process.argv[1]}))' "$1" \
    | (cd "$1" && node "$PC" >/dev/null 2>"$TMP/pc.err"); echo $?; }

  R="$TMP/t5a"; caso_c8 "$R" review
  sin=$(correr_pc "$R")
  R="$TMP/t5b"; caso_c8 "$R" review; audit_c8 "$R/.advisors/dod-runtime/9.9-self-audit-iter1.md" --incomplete
  inc=$(correr_pc "$R"); grep -qi 'aviso' "$TMP/pc.err"; winc=$?
  R="$TMP/t5c"; caso_c8 "$R" done
  mkdir -p "$R/.advisors/pipeline-runs/9.9-20260824-1200" && echo '[]' > "$R/.advisors/pipeline-runs/9.9-20260824-1200/findings.json"
  audit_c8 "$R/.advisors/dod-runtime/9.9-self-audit-iter1.md" A B
  audit_c8 "$R/.advisors/dod-runtime/9.9-self-audit-iter2.md" A B NUEVO; touch -t 209901010000 "$R/.advisors/dod-runtime/9.9-self-audit-iter2.md"
  conv=$(correr_pc "$R"); grep -q 'ACCOV-C10' "$TMP/pc.err"; wconv=$?
  # 🔴 Si al último self-audit le borran la sección de gaps, C10 compararía 0 gaps contra los de la
  #    iteración previa y «convergería»: borrar §3 sería la forma de saltear la convergencia.
  R="$TMP/t5d"; caso_c8 "$R" done
  mkdir -p "$R/.advisors/pipeline-runs/9.9-20260824-1200" && echo '[]' > "$R/.advisors/pipeline-runs/9.9-20260824-1200/findings.json"
  audit_c8 "$R/.advisors/dod-runtime/9.9-self-audit-iter1.md" A B
  audit_c8 "$R/.advisors/dod-runtime/9.9-self-audit-iter2.md" --incomplete; touch -t 209901010000 "$R/.advisors/dod-runtime/9.9-self-audit-iter2.md"
  sin3=$(correr_pc "$R"); grep -q 'ACCOV-C10' "$TMP/pc.err"; wsin3=$?
  [ "$sin3" = "2" ] && [ "$wsin3" = "0" ] || conv="sin-§3:$sin3"
  if [ "$sin" = "0" ] && [ "$inc" = "0" ] && [ "$winc" = "0" ] && [ "$conv" = "2" ] && [ "$wconv" = "0" ]; then
    ok "T5 sin self-audit no frena · incompleto avisa sin frenar · dos que no convergen siguen frenando por C10"
  else
    no "T5 exits sin/incompleto/no-converge=$sin/$inc/$conv · aviso-incompleto=$winc · c10=$wconv · err=$(grep -E "❌|reason|ACCOV|DODRT|advisors|roster" "$TMP/pc.err" | head -8 | tr "\n" " ")"
  fi
  unset TYCON_WAIVER_LOG
fi

# ── T9 — Steps_TextosRecortados ─────────────────────────────────────────────────
# 🔴 Los textos tienen que decir lo decidido: sin eso, 7c.2 describiría la regla de «las cuatro», el step 9
#    relanzaría los dos revisores y el merge lanzaría la suite completa en segundo plano. Si los archivos no
#    están en la máquina, se saltea diciéndolo (no es un rojo: no hay texto que juzgar).
S07C="$SKILLS/tycon-pipeline/steps/step-10-live-check.md"
S09="$SKILLS/tycon-pipeline/steps/close-work-item.md"
SMERGE="$SKILLS/tycon-merge-to-main/SKILL.md"
if [ ! -f "$S07C" ] || [ ! -f "$S09" ] || [ ! -f "$SMERGE" ]; then
  echo "⏭  cierre-recortado: T9 salteado — no están los textos de agent-skills en $SKILLS"
else
  seccion(){ awk -v ini="$2" 'index($0, ini)==1 {en=1; print; next} en && /^###? / {exit} en {print}' "$1"; }
  s72="$(seccion "$S07C" '### Parte 2 ')"
  capa4="$(awk '/Review de legibilidad independiente/,/Usuario de prueba declarado/' "$S07C")"
  pre9="$(awk '/^## /{n++} n<=2' "$S09")"
  s7b="$(awk '/\*\*7b-1 /,/Regla general anti-espera/' "$SMERGE")"
  problemas=""
  echo "$s72" | grep 'dod-checker-needed' >/dev/null || problemas="$problemas 7c.2-sin-helper"
  echo "$s72" | grep 'dod-checker-decision' >/dev/null || problemas="$problemas 7c.2-sin-constancia-de-la-decision"
  echo "$s72" | grep -i 'LAS CUATRO\|4 condiciones' >/dev/null && problemas="$problemas 7c.2-sigue-la-regla-de-cuatro"
  echo "$capa4" | grep 'qa-legibilidad' >/dev/null || problemas="$problemas capa4-sin-marca"
  grep -q 'deferrals-open' "$S09" || problemas="$problemas step9-sin-helper"
  grep -q '`tycon-dod-runtime-checker` advisor verde' "$S09" && problemas="$problemas step9-relanza-dod-checker"
  grep -q '`tycon-ac-coverage-checker` en modo `transition-to-done`' "$S09" && problemas="$problemas step9-relanza-ac-coverage"
  echo "$s7b" | grep 'vuelve cuando el gate del proyecto tenga aislamiento por worker' >/dev/null || problemas="$problemas merge-sin-condicion-de-vuelta"
  echo "$s7b" | grep 'lanzar la suite COMPLETA del gate del proyecto en \*\*BACKGROUND\*\*' >/dev/null && problemas="$problemas merge-sigue-lanzando-7b-2"
  grep -q 'correr 7b-1 + 7b-2' "$SMERGE" && problemas="$problemas merge-sigue-corriendo-7b-2"
  [ -n "$pre9" ] || problemas="$problemas step9-ilegible"
  if [ -z "$problemas" ]; then
    ok "T9 7c.2 decide con dod-checker-needed · la capa 4 deja su marca · el step 9 usa deferrals-open · el merge no lanza 7b-2 y dice cuándo vuelve"
  else
    no "T9 textos:$problemas"
  fi
fi

# ── T8 — Catalogo_ACCOV_C9_Retirada_RulesDistillVerde ──────────────────────────────────────
# 🔴 Sin la retirada, la fila de ACCOV-C9 estaría viva en el catálogo (sin marca de retirada).
# rules-distill y build/check leen los agentes desde el home: un home falso con `.claude/agents` y
# `.claude/agent-skills` apuntando al agent-skills que se prueba. La línea base de zombies es 1 y previa
# (ACCOV-C1-EXT, fijada por C7 de rules-catalog.test.sh): lo que se exige es que no suba y que la
# regla retirada no aparezca en ningún listado.
AS_RAIZ="$(cd "$SKILLS/.." 2>/dev/null && pwd)"
HB="$TMP/home-banco"; mkdir -p "$HB/.claude"
[ -n "$AS_RAIZ" ] && ln -sfn "$AS_RAIZ" "$HB/.claude/agent-skills" && ln -sfn "$AS_RAIZ/agents" "$HB/.claude/agents"
CAT="$AQUI/guides/advisor-rules-catalog.md"
fila_c9="$(grep -E '^\| (~~)?\*?\*?ACCOV-C9' "$CAT" | head -1)"
rd_out="$(HOME="$HB" node "$AQUI/scripts/tools/rules-distill.js" 2>&1)"; rd=$?
HOME="$HB" TYCON_AGENTS_DIR="$AS_RAIZ/agents" node "$AQUI/build/check.js" > "$TMP/check.out" 2>&1; bc=$?
zomb="$(echo "$rd_out" | grep -Eo '^  [0-9]+ zombies' | grep -Eo '[0-9]+')"
# TEST-W8 la cita sólo el revisor de convenciones .NET, que vive en el paquete bizuit (no viaja al público):
# en un árbol sin ese paquete queda sin quien la cite y no cuenta como zombie; con el paquete, cuenta como cualquiera
if [ -n "$zomb" ] && [ ! -d "$AQUI/packs/bizuit" ] && echo "$rd_out" | grep -E '^ +TEST-W8 +owner:' >/dev/null; then zomb=$((zomb - 1)); fi
orph="$(echo "$rd_out" | grep -Eo '^  [0-9]+ orphans' | grep -Eo '[0-9]+')"
c9_listado="$(echo "$rd_out" | grep -E '^ +ACCOV-C9 ' | head -1)"
# Los huérfanos (un revisor cita una regla que el catálogo no tiene) se cuentan por regla. La familia XPAT es del
# revisor de patrones hermanos, que vive en el paquete de clientes (packs/clients) y no viaja al público: en un árbol
# sin ese paquete, que un revisor que sí viaja la nombre no es una regla retirada que quedó citada, y no cuenta. En un
# árbol con el paquete, cuenta como cualquier otra.
orph_ids="$(printf '%s\n' "$rd_out" | node -e '
const t = require("fs").readFileSync(0, "utf8").split("\n");
const i = t.findIndex((l) => /^ +ORPHANS \(/.test(l)); const ids = [];
if (i >= 0) for (let k = i + 1; k < t.length && !/^ +[A-Z-]+ \(\d+\)/.test(t[k]); k++) { const m = t[k].match(/^ {3,}([A-Z]+-[A-Z]*\d+[A-Za-z0-9-]*) +citado por/); if (m) ids.push(m[1]); }
process.stdout.write(ids.join(" "));')"
orph_cuentan=""
for o in $orph_ids; do
  case "$o" in XPAT-*) [ -d "$AQUI/packs/clients" ] && orph_cuentan="$orph_cuentan $o" ;; *) orph_cuentan="$orph_cuentan $o" ;; esac
done
if echo "$fila_c9" | grep '~~ACCOV-C9~~' >/dev/null && echo "$fila_c9" | grep 'RETIRADA 2026-09-16' >/dev/null \
   && [ "$rd" = "0" ] && [ "$bc" = "0" ] && [ -n "$zomb" ] && [ "$zomb" -le 1 ] && [ -n "$orph" ] && [ -z "$orph_cuentan" ] && [ -z "$c9_listado" ]; then
  ok "T8 ACCOV-C9 figura retirada con fecha, sin borrar la fila; rules-distill (0 orphans que cuenten, zombies $zomb ≤ línea base) y build/check verdes"
else
  no "T8 fila=[$(echo "$fila_c9" | cut -c1-90)] rules-distill=$rd zombies=${zomb:-?} orphans=${orph:-?} (cuentan:${orph_cuentan:- ninguno}) c9-listado=[$c9_listado] build/check=$bc $(grep -E '❌' "$TMP/check.out" | head -2 | tr '\n' ' ')"
fi

# ── T10 — Fuga_FrenosDelCierre_SinDatos ────────────────────────────────────────────────────
# 🔴 Por mutación: si la constancia pasara `cmd`, `specRel` o el mensaje del commit como
#    `regla` o como campo propio, alguno de estos tres aparecería en el registro.
if [ -f "$PC" ]; then
  R="$TMP/t10-historia-confidencial"; rm -rf "$R"; mkdir -p "$R/specs"
  git -C "$R" init -q; git -C "$R" config user.email t@t; git -C "$R" config user.name t
  printf '%s\n' '---' 'story: "9.9"' 'status: in-progress' '---' '# Story historia-confidencial' '' '## Acceptance Criteria' '1. AC con E2E' > "$R/specs/historia-confidencial.md"
  git -C "$R" add -A; git -C "$R" commit -q -m base
  sed -i '' 's/status: in-progress/status: review/' "$R/specs/historia-confidencial.md" 2>/dev/null || sed -i 's/status: in-progress/status: review/' "$R/specs/historia-confidencial.md"
  git -C "$R" add -A
  rm -f "$HOME/.claude/.tycon-pipeline/frenos.jsonl"
  node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",tool_input:{command:"git commit -m \"cierre, avisar a juan.perez@cliente-secreto.com\""},cwd:process.argv[1]}))' "$R" \
    | (cd "$R" && TYCON_GUIDES_DIR="$AQUI" node "$PC" >/dev/null 2>&1); ec10=$?
  REG10="$HOME/.claude/.tycon-pipeline/frenos.jsonl"
  if [ -s "$REG10" ] && ! grep -qF "$HOME" "$REG10" && ! grep -q 'historia-confidencial' "$REG10" \
     && ! grep -q 'cliente-secreto' "$REG10" && ! grep -q 'juan.perez' "$REG10" && ! grep -q '/specs' "$REG10"; then
    ok "T10 la constancia del cierre no lleva ni la ruta del home, ni la story, ni el correo del mensaje (exit del hook=$ec10)"
  else
    no "T10 registro=[$(cat "$REG10" 2>/dev/null | head -3 | tr '\n' ' ')] exit=$ec10"
  fi
fi

# ── T11 — Bench_HooksDelCierre_Verdes ─────────────────────────────────────────────────────
# El banco resuelve agent-skills desde el home: un home falso con `.claude/agent-skills` apuntando al que
# se está probando. Ningún caso del banco exige el self-audit como bloqueo.
if [ -z "$AS_RAIZ" ] || [ ! -d "$AS_RAIZ/agents" ]; then
  no "T11 NO MEDIDO: no encontré la raíz de agent-skills a partir de $SKILLS"
else
  res11=""
  for o in on-pre-commit frontmatter dod-evidence; do
    HOME="$HB" node "$AQUI/scripts/controls-bench/runner.js" --tool claude --only "$o" > "$TMP/banco-$o.out" 2>&1; r=$?
    linea="$(grep -E 'corridos' "$TMP/banco-$o.out" | tail -1)"
    # en Windows el resumen intercala «N rojos conocidos (known-gaps.json)»: la misma suposición pondría rojo a T19e
    echo "$linea" | grep -E ' 0 rojos · ([0-9]+ rojos conocidos \(known-gaps\.json\) · )?0 NO MEDIDOS' >/dev/null && [ "$r" = "0" ] || res11="$res11 $o(rc=$r: $linea)"
  done
  if [ -z "$res11" ]; then ok "T11 el banco de on-pre-commit, on-frontmatter-write y on-dod-evidence-guard sigue verde"
  else no "T11 banco:$res11"; fi
  rm -f "$AQUI"/scripts/controls-bench/.bench/last-run-claude-parcial-{on-pre-commit,frontmatter,dod-evidence}-*.json 2>/dev/null
fi

# ── T12 — NoRegresion_GatesYCiGate ────────────────────────────────────────────────────────
# Lo que frena de verdad no se toca: `run-check` (marker.js) y el portón de CI, comparados contra
# origin/main de cada repo. Y ningún caso del examen de revisores apunta a la regla retirada.
t12=""
# 🔴 De marker.js se compara SÓLO lo que registra el veredicto de los chequeos (`registrarRunCheck`: qué es verde,
#    con qué procedencia), no el archivo entero: el archivo entero pondría en rojo a toda story que tocara otra parte
#    de marker.js hasta que se mergeara. Mutación que lo pone rojo: cambiar una línea de esa función.
# 🔴 La función que LANZA la corrida (`cmdRunCheck`) no se compara por bytes, por el mismo motivo que el portón (abajo):
#    comparar bytes no distingue una mejora de un deterioro, y cada cambio a cómo se lanza —el candado de una sola
#    corrida por repo, las señales— la desfrizaría con su justificación. Lo que importa de ella se mide ejecutándola:
#    que sale con el código real del comando (`tooling-portable.test.js`) y el candado (`marker-run-check.test.js`).
# 🔴 El tramo termina en la LLAVE DE CIERRE de la función, no en la función siguiente: lo que hay entre las
#    dos (la lista `VALID_FLAGS` de set-flag) no es run-check, y un cambio ahí pondría rojo acá sin haber
#    tocado una línea de run-check.
funciones_run_check(){ node -e '
  const s = require("fs").readFileSync(0, "utf8"); let out = "";
  for (const n of ["registrarRunCheck"]) {
    const i = s.indexOf("\nfunction " + n + "(");
    if (i < 0) { out += "SIN:" + n + "\n"; continue; }
    const j = s.indexOf("\n}\n", i + 1);
    out += s.slice(i, j < 0 ? s.length : j + 2);
  }
  process.stdout.write(out);'; }
# 🔴 EN EL REPO PRIVADO ADELGAZADO: marker.js es del público y su `main` no lo trae. En el árbol armado
#    el que corre YA es el de `main` del público (compararlo contra él sería compararlo consigo mismo), y una rama de este
#    repo no lo puede cambiar: la superposición rechaza un archivo que está en los dos repos sin declarar. Lo que frena de
#    verdad lo cuida la validación del público. Esta mitad no aplica, y se dice; un repo con marker.js en su main la mide.
THIN_SIN_MARKER=""
if [ -n "$AS_RAIZ" ] && git -C "$AS_RAIZ" rev-parse --verify -q origin/main >/dev/null 2>&1 \
  && ! git -C "$AS_RAIZ" cat-file -e origin/main:skills/tycon-pipeline/scripts/marker.js 2>/dev/null \
  && node -e 'try { process.exit(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).layout === "thin" ? 0 : 1); } catch (_) { process.exit(1); }' "$AS_RAIZ/.tycon/internal-forms.json"; then
  THIN_SIN_MARKER=1
fi
if [ -n "$THIN_SIN_MARKER" ]; then
  echo "ℹ️ cierre-recortado: T12 run-check no aplica en el repo adelgazado (marker.js es del público; lo cuida su validación)"
elif git -C "$AS_RAIZ" rev-parse --verify -q origin/main >/dev/null 2>&1; then
  RC_MAIN="$(git -C "$AS_RAIZ" show origin/main:skills/tycon-pipeline/scripts/marker.js | funciones_run_check)"
  RC_AHORA="$(funciones_run_check < "$AS_RAIZ/skills/tycon-pipeline/scripts/marker.js")"
  { [ -n "$RC_MAIN" ] && [ "$RC_MAIN" = "$RC_AHORA" ] && ! printf '%s' "$RC_AHORA" | grep '^SIN:' >/dev/null; } \
    || t12="$t12 agent-skills:run-check-cambiado"
  # 🔴 La matriz NO se compara contra origin/main: la comparación sólo pondría en rojo —hasta el merge, y
  #    volviendo sola a verde después— a toda rama que cambiara la matriz por un motivo propio. Un rojo esperado
  #    que se aprende a ignorar tapa al que importa. La matriz tiene su red: `tycon-pipeline/scripts/tests/test-runtime-matrix.js`.
else
  t12="$t12 agent-skills-sin-origin/main(no-medido)"
fi
# 🔴 Del portón se comparan SÓLO las funciones que deciden sus chequeos, no el archivo entero (mismo motivo
#    que el de `marker.js`, más arriba). El archivo entero pondría en rojo a toda story que AGREGARA un
#    chequeo, aunque no tocara un solo byte de lo que esta prueba quiere congelar.
# 🔴 Y para el portón la comparación por bytes no existe: comparar bytes —aunque fuera sólo los de seis
#    funciones— no distingue una mejora de un deterioro, así que cada story que mejora el portón
#    desfrizaría una función con su justificación razonable, y el control se moriría de a poco sin que
#    nadie lo decidiera. Lo que el congelamiento quiere proteger se mide como corresponde: **se ejecuta cada
#    función** contra los casos del incidente que la puso en la lista. Una mejora pasa; un deterioro la
#    pone en rojo. Cada función tiene su mutación (ver el bloque `node` abajo).
#    De `marker.js` (sólo las funciones de run-check) SÍ se comparan los bytes. `runtime-matrix.js` no se
#    compara: ahí el congelamiento estorba (ver arriba, en T12).
# Extrae una función de nivel superior y se queda con su LÓGICA: sin líneas de comentario ni
# vacías. Así un comentario nuevo —o uno agregado entre dos funciones— no cuenta como cambio, y cualquier
# línea de código que se toque, sí. Cortar por la llave de cierre NO sirve: se come la función a la mitad
# si adentro hay un bloque que cierra en columna 0.
# 🔴 Y la función termina donde termina SU cuerpo, no donde empieza la siguiente: cortar en el próximo
# `\nfunction ` arrastraría todo lo que hubiera entre medio — un docblock `/** … */`, una `const` nueva
# puesta arriba de la función siguiente— y lo compararía como si fuera código de la función congelada. Se cuenta llaves (ignorando strings, comentarios de línea
# y de bloque) hasta cerrar la del `function`, y se descartan comentarios y líneas vacías.
funcion_js(){ node -e '
  const s = require("fs").readFileSync(0, "utf8");
  const n = process.argv[1];
  const i = s.indexOf("\nfunction " + n + "(");
  if (i < 0) { process.stdout.write("SIN:" + n); }
  else {
    let k = s.indexOf("{", i), prof = 0, fin = -1;
    for (let p = k; p < s.length && fin < 0; p++) {
      const c = s[p], sig = s[p + 1];
      if (c === "/" && sig === "/") { p = s.indexOf("\n", p); if (p < 0) break; continue; }
      if (c === "/" && sig === "*") { p = s.indexOf("*/", p + 2); if (p < 0) break; p += 1; continue; }
      if (c === "\"" || c === "\x27" || c === "`") { let q = p + 1; while (q < s.length && s[q] !== c) { if (s[q] === "\\") q++; q++; } p = q; continue; }
      if (c === "{") prof++;
      else if (c === "}") { prof--; if (prof === 0) fin = p + 1; }
    }
    const cuerpo = s.slice(i, fin < 0 ? s.length : fin);
    process.stdout.write(cuerpo.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).join("\n"));
  }' "$1"; }
if git -C "$AQUI" rev-parse --verify -q origin/main >/dev/null 2>&1; then
  # 🔴 `validarRoster` no está en la lista congelada: se mide por lo que GARANTIZA, no por sus bytes. Es el
  #    mismo motivo que el del portón más arriba: esta función es la que el arnés está evolucionando
  #    —por ejemplo, la comparación tramo contra tramo para que un hallazgo del paso 1 no cuente como
  #    revisor ausente— así que congelar sus bytes pondría en rojo a toda story que la mejorara, sin
  #    distinguir una mejora de un debilitamiento. Lo que no puede pasar es que PIERDA una regla, y eso se
  #    chequea abajo, junto a los cuatro chequeos de `revisar()`. Su comportamiento real lo fijan dos
  #    suites propias que corren aparte: `roster-validate-parity.test.js` (las dos copias, veredicto
  #    por veredicto, sobre rosters reales de un pedido) y el `--selftest` del propio portón.
  # 🔴 Para las seis funciones no hay comparación por bytes. El congelamiento no distingue una mejora de un
  #    deterioro: cualquier cambio saldría rojo, así que se lo iría vaciando de a una función por story y
  #    nadie decidiría nada. Lo que el congelamiento QUIERE proteger se mide como corresponde:
  #    **ejecutando cada función** contra los casos del incidente que la puso ahí. Una mejora pasa;
  #    un deterioro la pone en rojo.
  #    Cada caso de abajo trae el incidente que lo justifica y su mutación verificada.
  node - "$AQUI" <<'PORTON' || t12="$t12 tycon-ci-gate:comportamiento-roto"
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const g = require(process.argv[2] + '/scripts/ci/tycon-ci-gate.js');
const fallas = [];
const exige = (ok, q) => { if (!ok) fallas.push(q); };

// ── esEvidenciaDeCierre — los tres que NO son evidencia, y el ledger que SÍ ────────────────
// (2026-09-05, en un producto): una copia de SÓLO la matriz por AC ponía el portón en verde sin una
// corrida real detrás. La matriz lista los ACs incluidos los que no tienen evidencia.
for (const f of ['1.1-self-audit.md', '1.1-self-audit-iter2.md', '1.1-runtime-matrix.md', '1.1-manual-test-plan.md']) {
  exige(g.esEvidenciaDeCierre(f) === false, `esEvidenciaDeCierre acepta ${f}, que NO es evidencia`);
}
exige(g.esEvidenciaDeCierre('1.1-smoke-ledger.jsonl') === true, 'el ledger de smokes dejó de contar como evidencia');
exige(g.esEvidenciaDeCierre('1.1-e2e-gate-20260905T120000Z.md') === true, 'el gate E2E dejó de contar como evidencia');

// ── hayEvidencia — mira la raíz Y un nivel más (monorepos) y aplica el criterio de arriba ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'porton-t12-'));
fs.mkdirSync(path.join(tmp, 'Sub', '.advisors', 'dod-runtime'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'Sub', '.advisors', 'dod-runtime', '9.9-runtime-matrix.md'), 'x');
exige(g.hayEvidencia(tmp, 'dod-runtime', '9.9') === false, 'SÓLO la matriz cuenta como evidencia (era el caso de la matriz sola)');
fs.writeFileSync(path.join(tmp, 'Sub', '.advisors', 'dod-runtime', '9.9-smoke.md'), 'x');
exige(g.hayEvidencia(tmp, 'dod-runtime', '9.9') === true, 'dejó de mirar la evidencia de los sub-proyectos (monorepo)');

// ── mdDelDiff — no puede devolver «no hay .md» cuando lo que pasó es «no pude preguntar» ───
// Un error de git que se lee como lista vacía deja pasar toda story: es la mentira más barata.
const roto = g.mdDelDiff(path.join(tmp, 'no-existe'), 'origin/main', false);
exige(roto && typeof roto.error === 'string', 'mdDelDiff tapa el fallo de git en vez de devolver {error}');
const repo = path.join(tmp, 'r');
fs.mkdirSync(repo);
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
git('init', '-q', '-b', 'main');
fs.writeFileSync(path.join(repo, 'a.md'), '# a\n'); fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
git('add', '-A');
const staged = g.mdDelDiff(repo, null, true);
exige(staged && Array.isArray(staged.files) && staged.files.includes('a.md') && !staged.files.includes('b.txt'),
  'mdDelDiff dejó de leer el ÍNDICE (--staged) o de filtrar por .md');

// ── contenidoEn — con `ref` vacío lee el ÍNDICE: es lo que hace que el mismo motor sirva
//    de los dos lados (antes del commit y en el pull request). Sin eso, `--staged` no existe.
exige(g.contenidoEn(repo, '', 'a.md') === '# a\n', 'contenidoEn dejó de leer la versión del índice (`ref` vacío)');
exige(g.contenidoEn(repo, '', 'no-esta.md') === null, 'contenidoEn tiene que devolver null, no romper, ante un archivo ausente');

fs.rmSync(tmp, { recursive: true, force: true });
if (fallas.length) { for (const f of fallas) console.error('   · ' + f); process.exit(1); }
PORTON
  # …y los cuatro chequeos siguen existiendo dentro de `revisar()`: agregar uno está bien, sacar uno no.
  for regla in frontmatter-roto sin-evidencia-de-cierre sin-constancia-de-revisores revisor-es-el-autor; do
    grep -q "'$regla'" "$AQUI/scripts/ci/tycon-ci-gate.js" || t12="$t12 tycon-ci-gate:falta-$regla"
  done
  # …y `validarRoster` sigue pudiendo emitir sus cuatro veredictos: perder uno es el debilitamiento
  # que la congelación cuidaba. Agregar está bien, sacar no.
  # 🔴 El cuerpo se captura UNA vez en una variable y se busca con `case`, sin tubería. Con
  # `printf '%s' "$(…)" | grep -q`, `grep -q` corta apenas encuentra, el `printf` se come un SIGPIPE
  # y el `||` lo lee como "no está": la prueba saldría roja de a ratos, según cuán rápido cierre el grep.
  # Verde a mano y roja en la corrida completa: el peor tipo de rojo.
  CUERPO_VR="$(funcion_js validarRoster < "$AQUI/scripts/ci/tycon-ci-gate.js")"
  for regla in registro-de-autoria-invalido sin-revisores revisor-es-el-autor roster-incoherente; do
    case "$CUERPO_VR" in
      *"'$regla'"*) : ;;
      *) t12="$t12 validarRoster:perdio-$regla" ;;
    esac
  done
  # …y `revisarAutoria` sigue emitiendo las suyas y llamando al cruce. Lo que no puede pasar es que
  # deje de reclamar el registro ausente o deje de validar el que encuentra.
  CUERPO_RA="$(funcion_js revisarAutoria < "$AQUI/scripts/ci/tycon-ci-gate.js")"
  for marca in "'sin-registro-de-autoria'" "'registro-de-autoria-invalido'" "validarRoster(" "advisoresEnFindings("; do
    case "$CUERPO_RA" in
      *"$marca"*) : ;;
      *) t12="$t12 revisarAutoria:perdio-${marca%%(*}" ;;
    esac
  done
  # y su red propia existe y no está vacía (si alguien la borra, la función queda sin nada que la mida)
  [ -s "$AQUI/scripts/tests/roster-validate-parity.test.js" ] || t12="$t12 falta-roster-validate-parity"
  grep -q "roster-validate-parity.test.js" "$AQUI/scripts/tests/suites.json" || t12="$t12 paridad-del-roster-sin-registrar"
else
  t12="$t12 tycon-claude-guides-sin-origin/main(no-medido)"
fi
grep -rlq 'ACCOV-C9' "$AQUI/scripts/controls-bench/cases/advisors" 2>/dev/null && t12="$t12 examen-con-casos-de-C9"
if [ -z "$t12" ]; then ok "T12 run-check y el portón de CI sin cambios; el examen no tiene casos de la regla retirada"
else no "T12$t12"; fi

echo "─────────────────────────────"
echo "cierre-recortado: $pasaron ok · $fallos fallos"
[ "$fallos" = "0" ] || exit 1
