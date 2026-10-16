#!/usr/bin/env bash
# evidence-key-collision.test.sh — red de la story 1.17: la evidencia no se pisa entre stories del mismo número.
#
# Por qué existe: la evidencia de cierre se nombraba con el número de la story y nada más
# (`<id>-smoke-ledger.jsonl`, `<id>-runtime-matrix.md`…). En dos repos del equipo el número NO identifica:
# numeran por tema y cada tema arranca en 1.1. La matriz de verificación por criterio contó un criterio como
# corrido con el registro de OTRA story del mismo número (2026-10-05). Medido: 35 de 88 evidencias de un
# repo y 20 de 79 de otro bajo un número que comparten varias stories (guides/incident-log.md#evidencia-pisada-entre-stories-2026-10-05).
#
# La regla: la clave de la evidencia lleva el tema SÓLO cuando el número está repetido en el repo
# (`<tema>__<número>`); si es único, la clave es el número solo, como siempre. Una regla «por carpeta
# `stories/`» dejaba huérfanas las 106 evidencias de un repo con números únicos y no arreglaba otro que no
# usa carpetas `stories/`: T2b y T1b la cazan.
#
# Lo que prueba (story 1.17, tabla «Tests»):
#   T1   dos temas, mismo número → el humo de cada uno cae en su archivo (smoke-run.sh con la RUTA de la story)
#   T1b  sin carpeta `stories/` → el tema es la carpeta de la story
#   T2   forma del arnés (`specs/story-1-9-x.md`) → la clave es el número, igual que hoy
#   T2b  carpetas `stories/` con números ÚNICOS (números únicos en carpetas por tema) → la clave es el número
#   T3   la matriz de un tema no cuenta el humo del otro
#   T4   el humo, la matriz, el resultado de DoD, el gate de navegador y la copia del resultado de pruebas
#        usan la MISMA clave
#   T4b  los lectores (freno del commit, del cambio de estado, portón de Azure) no le dan la evidencia de
#        una story a la otra
#   T5   la evidencia vieja no se borra ni se reescribe (byte a byte)
#   T6   la evidencia vieja no cuenta
#   T7   la evidencia vieja se reporta como huérfana, con su ruta
#   T8   la parcheada a mano con el tema en el nombre (`1.1-cobranza-*`) no se toca y el reporte la nombra
#   T9   número repetido → el lint lo avisa con las rutas y sale 0
#   T10  números únicos → el lint no avisa
#   T11  story-format pide el id único; incident-log tiene su entrada; README tiene la fila
#   T12  sin recorrido completo del repo → error, sin clave adivinada
#   T14  clave no calculable → sin evidencia y con el motivo dicho (no «no hay evidencia» a secas)
#   T15  test-gate.sh real deja la copia sellada del resultado bajo la clave
#   T16-T21 lo que encontró el pase adversarial: la clave es única entre las stories del mismo número aunque los
#        temas choquen al desempatar, se repitan en otra área o difieran sólo en tildes; los ids con letras también se
#        separan; «renombrada a mano» mira el tema entero; el autoexamen de cierre se busca por la clave
#   T22  ruta de story inexistente o id con barras/comillas → ningún escritor escribe nada
#   T23  la guía de QA y PRE-1 de preflight-frontmatter leen por la clave
#   T13  el medidor nocturno con el recorrido incompleto dice «no medido» (no cruza por una clave adivinada)
#
# 🔴 HOME falso siempre: el espejo de los humos (`gates.log`) vive bajo el home.
# Correr: bash scripts/tests/evidence-key-collision.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SK="$AQUI/skills/tycon-pipeline/scripts"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0; pasaron=0
ok(){ echo "✅ evidencia: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ evidencia: $1"; fallos=$((fallos+1)); }

command -v node >/dev/null || { echo "❌ evidencia: sin node no se puede medir nada"; exit 1; }
unset NODE_TEST_CONTEXT TYCON_EVIDENCE_KEY

export HOME="$TMP/casa"; mkdir -p "$HOME/.claude/.tycon-pipeline"
GATES="$HOME/.claude/.tycon-pipeline/gates.log"
# `curl` falso: el humo tiene que parecer un humo de verdad para la matriz (que mira el comando), sin red.
mkdir -p "$TMP/bin"; printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/curl"; chmod +x "$TMP/bin/curl"
export PATH="$TMP/bin:$PATH"

# story <ruta> <id> — una story mínima con un AC cubierto por una fila de la tabla de tests.
story(){
  mkdir -p "$(dirname "$1")"
  cat > "$1" <<EOF
---
epic: 1
story: "$2"
title: "story de prueba $2"
status: in-progress
---

# Story $2

## Acceptance Criteria

1. **Given** algo **When** pasa **Then** resultado.

### Tests

| # | Test | AC | Nivel | Escenario | Resultado esperado |
|---|------|----|-------|-----------|--------------------|
| T1 | \`Caso1\` | 1 | integration | x | y |
EOF
}
repo(){ rm -rf "$1"; mkdir -p "$1/.git" "$1/.advisors/dod-runtime"; }
clave(){ node "$SK/pipeline.js" evidence-key --story "$1" 2>/dev/null; }
humo(){ bash "$SK/smoke-run.sh" "$1" "$2" --acs 1 --pass-if 'responde 200' -- curl -s http://app/x >/dev/null 2>&1; }
matriz_json(){ node "$SK/runtime-matrix.js" --story "$1" --json --no-write 2>/dev/null; }
veredicto_ac1(){ node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);console.log((r.perAc&&r.perAc[1]&&r.perAc[1].verdict)||"?")}catch{console.log("?")}})'; }

# ── mundos ────────────────────────────────────────────────────────────────────────────────────────────────
W1="$TMP/w1"; repo "$W1"
story "$W1/.specs/a/stories/1-1-x.md" 1.1
story "$W1/.specs/b/stories/1-1-y.md" 1.1
EV="$W1/.advisors/dod-runtime"

# T1 — dos temas, mismo número → archivos distintos
humo "$EV" "$W1/.specs/a/stories/1-1-x.md"; humo "$EV" "$W1/.specs/b/stories/1-1-y.md"
if [ -f "$EV/a__1.1-smoke-ledger.jsonl" ] && [ -f "$EV/b__1.1-smoke-ledger.jsonl" ] && [ ! -f "$EV/1.1-smoke-ledger.jsonl" ]; then
  ok "T1 dos temas con el número 1.1 escriben en a__1.1 y b__1.1"
else
  no "T1 dos temas con el mismo número tendrían que escribir en archivos distintos: $(ls "$EV" | tr '\n' ' ')"
fi

# T1b — sin carpeta `stories/`, el tema es la carpeta de la story
W2="$TMP/w2"; repo "$W2"
story "$W2/docs/voz/epic-05/1-1-x.md" 1.1
story "$W2/docs/voz/epic-07/1-1-y.md" 1.1
k5="$(clave "$W2/docs/voz/epic-05/1-1-x.md")"; k7="$(clave "$W2/docs/voz/epic-07/1-1-y.md")"
if [ "$k5" = "epic-05__1.1" ] && [ "$k7" = "epic-07__1.1" ]; then ok "T1b sin carpeta stories/: claves epic-05__1.1 y epic-07__1.1"
else no "T1b sin carpeta stories/ el tema es la carpeta de la story: dio «${k5}» y «${k7}»"; fi

# T2 — forma del arnés: la clave es el número, igual que hoy
ARN="$TMP/arnes"; repo "$ARN"
story "$ARN/specs/story-1-9-x.md" 1.9
story "$ARN/specs/story-1-10-y.md" 1.10
k="$(clave "$ARN/specs/story-1-9-x.md")"
if [ "$k" = "1.9" ]; then ok "T2 número único en el arnés: la clave es 1.9, como siempre"
else no "T2 la clave del arnés cambió (dio «${k}»): rompería la evidencia que hoy está bien"; fi

# T2b — carpetas `stories/` con números únicos: la clave es el número
W3="$TMP/w3"; repo "$W3"
story "$W3/.specs/a/stories/1-1-x.md" 1.1
story "$W3/.specs/b/stories/2-1-y.md" 2.1
ka="$(clave "$W3/.specs/a/stories/1-1-x.md")"; kb="$(clave "$W3/.specs/b/stories/2-1-y.md")"
if [ "$ka" = "1.1" ] && [ "$kb" = "2.1" ]; then ok "T2b carpetas stories/ con números únicos: claves 1.1 y 2.1"
else no "T2b con números únicos la clave no lleva tema: dio «${ka}» y «${kb}»"; fi

# T3 — la matriz de un tema no cuenta el humo del otro
M3="$TMP/m3"; repo "$M3"
story "$M3/.specs/a/stories/1-1-x.md" 1.1
story "$M3/.specs/b/stories/1-1-y.md" 1.1
humo "$M3/.advisors/dod-runtime" "$M3/.specs/b/stories/1-1-y.md"
va="$(matriz_json "$M3/.specs/a/stories/1-1-x.md" | veredicto_ac1)"
vb="$(matriz_json "$M3/.specs/b/stories/1-1-y.md" | veredicto_ac1)"
if [ "$va" != "RUNTIME" ] && [ "$vb" = "RUNTIME" ]; then ok "T3 el humo de b cuenta para b ($vb) y no para a ($va)"
else no "T3 la matriz de a no puede usar el humo de b: a=«${va}» b=«${vb}»"; fi

# T4 — los cinco escritores usan la misma clave
M4="$TMP/m4"; repo "$M4"
story "$M4/.specs/a/stories/1-1-x.md" 1.1
story "$M4/.specs/b/stories/1-1-y.md" 1.1
S4="$M4/.specs/a/stories/1-1-x.md"; E4="$M4/.advisors/dod-runtime"
humo "$E4" "$S4"
node "$SK/runtime-matrix.js" --story "$S4" --evidence-dir "$E4" >/dev/null 2>&1
echo '{"steps":[]}' > "$TMP/escenario.json"
macro="$(node "$SK/step-7c-macro.js" --story "$S4" --scenario "$TMP/escenario.json" --evidence-dir "$E4" --dry-run 2>/dev/null | sed -n 's/^  evidence_path=//p')"
bash "$SK/e2e-gate.sh" "$TMP/no-hay-front" "$S4" "$E4" algo.spec.ts >/dev/null 2>&1
mkdir -p "$TMP/res"
( cd "$M4" && TYCON_EVIDENCE_DIR="$E4" TYCON_EVIDENCE_KEY="$(clave "$S4")" node "$SK/lib/test-gate-report.js" vitest "$M4" "$M4" "$TMP/res" "$TMP/tr.json" 0 1.1 75 2026-10-05T12:00:00Z >/dev/null 2>&1 )
faltan=""
[ -f "$E4/a__1.1-smoke-ledger.jsonl" ] || faltan="$faltan humo"
[ -f "$E4/a__1.1-runtime-matrix.md" ] || faltan="$faltan matriz"
case "$(basename "${macro:-x}")" in a__1.1-*) ;; *) faltan="$faltan dod(${macro:-sin ruta})";; esac
ls "$E4" | grep '^a__1\.1-e2e-gate-' >/dev/null || faltan="$faltan gate-navegador"
[ -f "$E4/a__1.1-tests-result.json" ] || faltan="$faltan resultado-pruebas"
viejos="$(ls "$E4" | grep '^1\.1-' | tr '\n' ' ')"
if [ -z "$faltan" ] && [ -z "$viejos" ]; then ok "T4 humo, matriz, DoD, gate de navegador y resultado de pruebas usan a__1.1"
else no "T4 todos usan la misma clave — faltan:${faltan:- nada} · con la clave vieja: ${viejos:-ninguno}"; fi

# T4b — los lectores no le dan a «a» la evidencia de cierre de «b»
M5="$TMP/m5"; repo "$M5"
story "$M5/.specs/a/stories/1-1-x.md" 1.1
story "$M5/.specs/b/stories/1-1-y.md" 1.1
printf '# DoD Runtime Evidence — Story 1.1\nverdict=PASS\n' > "$M5/.advisors/dod-runtime/b__1.1-202610051200Z.md"
lectores="$(cd "$M5" && node -e '
  const [sk, ci, a, b, repo] = process.argv.slice(1);
  const pc = require(sk + "/on-pre-commit.js"), fw = require(sk + "/on-frontmatter-write.js"), g = require(ci);
  const r = [];
  r.push("commit:" + (!pc.findDodEvidence(repo, "1.1", { storyPath: a }) && !!pc.findDodEvidence(repo, "1.1", { storyPath: b })));
  r.push("estado:" + (!fw.hasDodEvidence([repo], "1.1", a) && fw.hasDodEvidence([repo], "1.1", b)));
  r.push("azure:" + (!g.hayEvidencia(repo, "dod-runtime", "1.1", a) && g.hayEvidencia(repo, "dod-runtime", "1.1", b)));
  console.log(r.join(" "));
' "$SK" "$AQUI/scripts/ci/tycon-ci-gate.js" "$M5/.specs/a/stories/1-1-x.md" "$M5/.specs/b/stories/1-1-y.md" "$M5" 2>&1 | tail -1)"
if [ "$lectores" = "commit:true estado:true azure:true" ]; then ok "T4b freno del commit, del cambio de estado y portón de Azure buscan por la clave"
else no "T4b un lector le da a «a» la evidencia de «b» (o no encuentra la de «b»): $lectores"; fi

# T5-T8 — la evidencia vieja, bajo el número solo
M6="$TMP/m6"; repo "$M6"
story "$M6/.specs/cobranza-deudor/stories/1-1-x.md" 1.1
story "$M6/.specs/pagos/stories/1-1-y.md" 1.1
E6="$M6/.advisors/dod-runtime"; S6="$M6/.specs/cobranza-deudor/stories/1-1-x.md"
# Una línea vieja (sin `v`), armada por el ayudante compartido de las pruebas (story 1.19).
node "$SK/tests/lib/smoke-ledger-line.js" --dod "$E6" --gates "$GATES" --story 1.1 --acs 1 --repo "$M6"
printf '# matriz vieja\n' > "$E6/1.1-runtime-matrix.md"
printf '# parcheada a mano\n' > "$E6/1.1-cobranza-runtime-matrix.md"
antes="$(cd "$E6" && cksum 1.1-smoke-ledger.jsonl 1.1-runtime-matrix.md 1.1-cobranza-runtime-matrix.md)"
node "$SK/runtime-matrix.js" --story "$S6" --evidence-dir "$E6" > "$TMP/m6.md" 2>/dev/null
matriz_json "$S6" > "$TMP/m6.json"
despues="$(cd "$E6" && cksum 1.1-smoke-ledger.jsonl 1.1-runtime-matrix.md 1.1-cobranza-runtime-matrix.md 2>&1)"
if [ "$antes" = "$despues" ]; then ok "T5 la evidencia vieja sigue en disco, byte a byte"
else no "T5 la evidencia vieja se tocó: antes «${antes}» después «${despues}»"; fi
v6="$(veredicto_ac1 < "$TMP/m6.json")"
if [ "$v6" != "RUNTIME" ] && [ "$v6" != "?" ]; then ok "T6 el humo viejo bajo 1.1 no cuenta (AC1: $v6)"
else no "T6 el humo viejo bajo el número ambiguo no puede contar: AC1 dio «${v6}»"; fi
huer="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const o=r.orphans||{};console.log(((o.unowned||[]).map(f=>require("path").basename(f))).join(","))' "$TMP/m6.json" 2>/dev/null)"
if echo "$huer" | grep '1.1-smoke-ledger.jsonl' >/dev/null && grep -q "$E6/1.1-smoke-ledger.jsonl" "$TMP/m6.md" && grep -qi 'huérfana' "$TMP/m6.md"; then
  ok "T7 la evidencia vieja se reporta como huérfana, con su ruta"
else no "T7 la huérfana tiene que aparecer en el reporte con su ruta: json «${huer}»"; fi
amano="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const o=r.orphans||{};console.log(((o.handRenamed||[]).map(f=>require("path").basename(f))).join(","))' "$TMP/m6.json" 2>/dev/null)"
if [ "$amano" = "1.1-cobranza-runtime-matrix.md" ] && grep -q '1.1-cobranza-runtime-matrix.md' "$TMP/m6.md" && [ -f "$E6/1.1-cobranza-runtime-matrix.md" ]; then
  ok "T8 la parcheada a mano queda como está y el reporte la nombra aparte"
else no "T8 la parcheada a mano (1.1-cobranza-*) tiene que nombrarse aparte: «${amano}»"; fi

# T9 / T10 — el aviso de número repetido
L9="$TMP/l9"; rm -rf "$L9"; mkdir -p "$L9"; git -C "$L9" init -q
story "$L9/.specs/a/stories/1-1-x.md" 1.1
story "$L9/.specs/b/stories/1-1-y.md" 1.1
out9="$(cd "$L9" && node "$AQUI/scripts/lib/lint-story-frontmatter.js" 2>&1)"; rc9=$?
if [ $rc9 -eq 0 ] && echo "$out9" | grep 'repetid' >/dev/null && echo "$out9" | grep '.specs/a/stories/1-1-x.md' >/dev/null && echo "$out9" | grep '.specs/b/stories/1-1-y.md' >/dev/null; then
  ok "T9 número repetido: el lint lo avisa con las dos rutas y sale 0"
else no "T9 el lint tiene que avisar el 1.1 repetido con sus rutas y salir 0 (salió $rc9): $(echo "$out9" | tail -3 | tr '\n' ' ')"; fi
L10="$TMP/l10"; rm -rf "$L10"; mkdir -p "$L10"; git -C "$L10" init -q
story "$L10/.specs/a/stories/1-1-x.md" 1.1
story "$L10/.specs/b/stories/2-1-y.md" 2.1
out10="$(cd "$L10" && node "$AQUI/scripts/lib/lint-story-frontmatter.js" 2>&1)"; rc10=$?
if [ $rc10 -eq 0 ] && ! echo "$out10" | grep 'repetid' >/dev/null; then ok "T10 números únicos: el lint no avisa"
else no "T10 con números únicos no hay aviso (salió $rc10): $(echo "$out10" | grep repetid | head -2)"; fi

# T11 — la convención, el incident-log y el README
f11=""
grep -q 'único dentro de su repo' "$AQUI/story-format.md" || f11="$f11 story-format"
# el incident-log del equipo no se publica: la copia pública trae un reemplazo sin casos (sin public-repos.json, que
# tampoco sale). Ahí esas dos no se pueden medir y se dice; en el repo interno, que falten sigue siendo rojo.
if [ ! -f "$AQUI/scripts/publishing/public-repos.json" ]; then
  echo "⏭ evidencia: T11 la entrada del incident-log: NO MEDIDO en la copia (trae un reemplazo del registro, sin casos)"
else
grep -q '^## evidencia-pisada-entre-stories-2026-10-05' "$AQUI/guides/incident-log.md" || f11="$f11 incident-log"
grep -q 'un identificador que no identifica convierte a un control en un mentiroso con confianza' "$AQUI/guides/incident-log.md" || f11="$f11 regla"
fi
grep -q 'evidencia huérfana' "$AQUI/INDEX.md" || f11="$f11 INDEX"   # el índice: INDEX.md desde 2026-10-14
if [ -z "$f11" ]; then ok "T11 story-format pide el id único, incident-log tiene su entrada y README su fila"
else no "T11 faltan:$f11"; fi

# T12 — sin recorrido completo del repo no hay clave adivinada
out12="$(TYCON_EVIDENCE_KEY_BUDGET_MS=0 node "$SK/lib/evidence-key.js" "$W1/.specs/a/stories/1-1-x.md" 2>&1)"; rc12=$?
if [ $rc12 -ne 0 ] && echo "$out12" | grep -i 'no pude recorrer' >/dev/null && ! echo "$out12" | grep -E '^(1\.1|a__1\.1)$' >/dev/null; then
  ok "T12 recorrido incompleto: error dicho y sin clave (salió $rc12)"
else no "T12 sin recorrido completo tiene que fallar sin devolver clave (salió $rc12): $out12"; fi

# T13 — el medidor nocturno tampoco adivina: con el recorrido de stories incompleto, la evidencia DoD sale «no
#       medida» con el motivo, en vez de cruzarla por una clave calculada sobre una lista a la que le pueden faltar
#       las stories que repiten el número (AC 13; lo encontró la revisión de cobertura de la iteración 1).
M13="$TMP/m13"; rm -rf "$M13"; mkdir -p "$M13"; git -C "$M13" init -q
story "$M13/.specs/a/stories/1-1-x.md" 1.1; sed -i.bak 's/^status: in-progress$/status: done/' "$M13/.specs/a/stories/1-1-x.md"; rm -f "$M13/.specs/a/stories/1-1-x.md.bak"
mkdir -p "$M13/.advisors/dod-runtime"; printf 'verdict=PASS\n' > "$M13/.advisors/dod-runtime/1.1-202610051200Z.md"
( cd "$M13" && git add -A && git -c user.email=t@t -c user.name=t commit -qm base )
r13="$(node -e '
  const m = require(process.argv[1]);
  const r = m.measureRepo(process.argv[2], "2020-01-01", { discoveryBudgetMs: 0 });
  const nota = (r.notMeasured || []).find((n) => /^dod_evidence:/.test(n)) || "";
  console.log((r.dod === null ? "dod-null" : "dod=" + JSON.stringify(r.dod)) + " | " + nota);
' "$AQUI/scripts/metrics/sdlc-stage-metrics.js" "$M13" 2>/dev/null)"
if echo "$r13" | grep '^dod-null | dod_evidence: .*incompleto' >/dev/null; then ok "T13 medidor nocturno con recorrido incompleto: «no medido», sin clave adivinada"
else no "T13 con el recorrido incompleto el medidor no puede cruzar evidencia: «${r13}»"; fi

# T14 — «no pude calcular la clave» no se dice como «no hay evidencia»: el portón de Azure y el freno del cambio de
#       estado no dan la evidencia por buena Y dicen el motivo (lo encontró la revisión de fallas silenciosas, iter 1).
e14="$(cd "$M5" && TYCON_EVIDENCE_KEY_BUDGET_MS=0 node -e '
  const [sk, ci, b, repo] = process.argv.slice(1);
  const fw = require(sk + "/on-frontmatter-write.js"), g = require(ci);
  console.log("azure:" + g.hayEvidencia(repo, "dod-runtime", "1.1", b) + " estado:" + fw.hasDodEvidence([repo], "1.1", b));
' "$SK" "$AQUI/scripts/ci/tycon-ci-gate.js" "$M5/.specs/b/stories/1-1-y.md" "$M5" 2>&1)"
if echo "$e14" | grep 'azure:false estado:false' >/dev/null && [ "$(echo "$e14" | grep -c 'no pude calcular la clave')" -ge 2 ]; then
  ok "T14 clave no calculable: sin evidencia y con el motivo dicho (portón de Azure y freno de estado)"
else no "T14 sin clave no hay evidencia, y el motivo tiene que decirse: «$(echo "$e14" | tr '\n' ' ')»"; fi

# T15 — el portón de pruebas REAL (test-gate.sh, no su informe con la variable puesta a mano) calcula la clave desde la
#       ruta de la story y deja la copia sellada bajo ella (lo encontró la revisión de cobertura de pruebas, iter 1).
M15="$TMP/m15"; rm -rf "$M15"; mkdir -p "$M15/scripts/tests"; git -C "$M15" init -q
story "$M15/.specs/a/stories/1-1-x.md" 1.1
story "$M15/.specs/b/stories/1-1-y.md" 1.1
printf 'exit 0\n' > "$M15/scripts/tests/ok.test.sh"
printf '{"diarias":[{"raiz":"arnes","ruta":"tests/ok.test.sh"}],"semanales":[]}\n' > "$M15/scripts/tests/suites.json"
( cd "$M15" && git add -A && git -c user.email=t@t -c user.name=t commit -qm base )
( unset TYCON_EVIDENCE_DIR TYCON_TEST_SCOPE TYCON_EVIDENCE_KEY TYCON_EVIDENCE_KEY_FAILED; TYCON_COVERAGE_BASE='' bash "$SK/test-gate.sh" "$M15" "$M15/.specs/a/stories/1-1-x.md" > "$TMP/t15.log" 2>&1 ); rc15=$?
if [ $rc15 -eq 0 ] && [ -f "$M15/.advisors/dod-runtime/a__1.1-tests-result.json" ] && [ ! -f "$M15/.advisors/dod-runtime/1.1-tests-result.json" ]; then
  ok "T15 test-gate.sh real: la copia sellada cae en a__1.1-tests-result.json"
else no "T15 test-gate.sh con la ruta de la story tiene que dejar a__1.1-tests-result.json (salió $rc15; hay: $(ls "$M15/.advisors/dod-runtime" 2>/dev/null | tr '\n' ' ')): $(tail -3 "$TMP/t15.log" | tr '\n' ' ')"; fi

# ── T16-T21: lo que encontró el pase adversarial de la iteración 1 (9 hallazgos, 4 causas) ──────────────────────────
# claves(<ruta>...) imprime las claves separadas por espacio.
claves(){ local out="" k; for p in "$@"; do k="$(clave "$p")"; out="$out ${k:-?}"; done; echo "${out# }"; }
distintas(){ [ "$(printf '%s\n' $1 | sort -u | wc -l | tr -d ' ')" -eq "$(printf '%s\n' $1 | wc -l | tr -d ' ')" ] && ! echo "$1" | grep '?' >/dev/null; }

# T16 — el desempate de un tema repetido no choca con el nombre de otro tema (foo/bar.md · foo/baz.md · foo-bar/x.md)
W16="$TMP/w16"; repo "$W16"
story "$W16/specs/foo/stories/bar.md" 1.1; story "$W16/specs/foo/stories/baz.md" 1.1; story "$W16/specs/foo-bar/stories/x.md" 1.1
k16="$(claves "$W16/specs/foo/stories/bar.md" "$W16/specs/foo/stories/baz.md" "$W16/specs/foo-bar/stories/x.md")"
if distintas "$k16"; then ok "T16 tres stories 1.1 (foo/bar, foo/baz, foo-bar/x): tres claves distintas ($k16)"
else no "T16 el desempate de foo/bar choca con el tema foo-bar: «${k16}»"; fi

# T17 — la misma carpeta-tema en dos áreas, con el mismo nombre de archivo
W17="$TMP/w17"; repo "$W17"
story "$W17/docs/voz/epic-05/1-1-x.md" 1.1; story "$W17/docs/mensajes/epic-05/1-1-x.md" 1.1
k17="$(claves "$W17/docs/voz/epic-05/1-1-x.md" "$W17/docs/mensajes/epic-05/1-1-x.md")"
if distintas "$k17"; then ok "T17 epic-05 en dos áreas con el mismo archivo: claves distintas ($k17)"
else no "T17 la misma carpeta en dos áreas da la misma clave: «${k17}»"; fi

# T18 — dos temas que sólo difieren en tildes
W18="$TMP/w18"; repo "$W18"
story "$W18/specs/gestión/stories/x.md" 1.1; story "$W18/specs/gestiòn/stories/x.md" 1.1
k18="$(claves "$W18/specs/gestión/stories/x.md" "$W18/specs/gestiòn/stories/x.md")"
if distintas "$k18"; then ok "T18 temas que sólo difieren en tildes: claves distintas ($k18)"
else no "T18 dos temas distintos por tildes dan la misma clave: «${k18}»"; fi

# T19 — ids con letras (R-9) repetidos en dos temas, sin que el repo declare su forma de id
W19="$TMP/w19"; repo "$W19"
story "$W19/.specs/a/stories/r9.md" R-9; story "$W19/.specs/b/stories/r9.md" R-9
k19="$(claves "$W19/.specs/a/stories/r9.md" "$W19/.specs/b/stories/r9.md")"
if distintas "$k19" && [ "$k19" != "R-9 R-9" ]; then ok "T19 id R-9 repetido sin id_pattern declarado: claves distintas ($k19)"
else no "T19 un id con letras repetido tiene que separarse igual: «${k19}»"; fi

# T20 — «renombrada a mano» mira el tema entero, no su primera palabra (legajo-deudor vs legajo-acreedor)
W20="$TMP/w20"; repo "$W20"
story "$W20/.specs/legajo-deudor/stories/x.md" 1.1; story "$W20/.specs/legajo-acreedor/stories/y.md" 1.1
printf 'x\n' > "$W20/.advisors/dod-runtime/1.1-legajo-acreedor-runtime-matrix.md"
r20="$(node -e '
  const ek = require(process.argv[1]); const [d, a, b] = process.argv.slice(2);
  const de = ek.legacyFiles([d], ek.evidenceKey(a)), ac = ek.legacyFiles([d], ek.evidenceKey(b));
  console.log("deudor:" + de.handRenamed.length + "/" + de.unowned.length + " acreedor:" + ac.handRenamed.length + "/" + ac.unowned.length);
' "$SK/lib/evidence-key.js" "$W20/.advisors/dod-runtime" "$W20/.specs/legajo-deudor/stories/x.md" "$W20/.specs/legajo-acreedor/stories/y.md" 2>&1)"
if [ "$r20" = "deudor:0/1 acreedor:1/0" ]; then ok "T20 la renombrada para legajo-acreedor no se le atribuye a legajo-deudor"
else no "T20 «renombrada a mano» tiene que mirar el tema entero: «${r20}» (esperado deudor:0/1 acreedor:1/0)"; fi

# T21 — el autoexamen de cierre (self-audit) también se busca por la clave
W21="$TMP/w21"; repo "$W21"
story "$W21/.specs/a/stories/1-1-x.md" 1.1; story "$W21/.specs/b/stories/1-1-y.md" 1.1
printf '# autoexamen de a\n' > "$W21/.advisors/dod-runtime/a__1.1-self-audit-iter1.md"
r21="$(cd "$W21" && node -e '
  const pc = require(process.argv[1]); const [repo, a, b] = process.argv.slice(2);
  console.log("a:" + pc.checkSelfAudit(repo, "1.1", { storyPath: a }).exists + " b:" + pc.checkSelfAudit(repo, "1.1", { storyPath: b }).exists);
' "$SK/on-pre-commit.js" "$W21" "$W21/.specs/a/stories/1-1-x.md" "$W21/.specs/b/stories/1-1-y.md" 2>&1 | tail -1)"
if [ "$r21" = "a:true b:false" ]; then ok "T21 el autoexamen de a no cuenta para b"
else no "T21 el autoexamen de cierre se tiene que buscar por la clave: «${r21}» (esperado a:true b:false)"; fi

# T22 — un escritor que recibe una ruta de story que no existe, o un id con barras, `..` o comillas, NO escribe nada:
#       antes usaba el texto crudo como nombre del archivo de evidencia (fuera de la carpeta con `../`, o un JSON roto)
#       (lo encontró la revisión de seguridad de la iteración 2). Cada llamada se juzga por su código de salida EXACTO y
#       por el motivo que imprime: «salió distinto de 0» solo también lo da un script que no está o que se rompió
#       (lo encontró la revisión de fallas silenciosas de la iteración 4).
W22="$TMP/w22"; repo "$W22"; E22="$W22/.advisors/dod-runtime"; mkdir -p "$W22/afuera"
f22=""
# espera <etiqueta> <exit esperado> <texto esperado en stderr> -- <comando...>
espera(){ local et="$1" ex="$2" txt="$3"; shift 4; local err rc; err="$("$@" 2>&1 >/dev/null)"; rc=$?
  if [ "$rc" -ne "$ex" ] || ! printf '%s' "$err" | grep -- "$txt" >/dev/null; then f22="$f22 $et(salió $rc: $(printf '%s' "$err" | head -1 | cut -c1-80))"; fi; }
espera humo-ruta-inexistente 2 'no encontré la story' -- bash "$SK/smoke-run.sh" "$E22" "$W22/no-existe.md" --acs 1 --pass-if 'responde 200' -- true
espera humo-id-con-barras 2 'no sirve para nombrar evidencia' -- bash "$SK/smoke-run.sh" "$E22" "../afuera/x" --acs 1 --pass-if 'responde 200' -- true
espera humo-id-con-comillas 2 'no sirve para nombrar evidencia' -- bash "$SK/smoke-run.sh" "$E22" '1.1"x' --acs 1 --pass-if 'responde 200' -- true
espera gate-ruta-inexistente 1 'no encontré la story' -- bash "$SK/e2e-gate.sh" "$TMP/no-hay-front" "$W22/no-existe.md" "$E22" algo.spec.ts
espera gate-id-con-barras 1 'no sirve para nombrar evidencia' -- bash "$SK/e2e-gate.sh" "$TMP/no-hay-front" "../afuera/x" "$E22" algo.spec.ts
espera macro-ruta-inexistente 2 'no encontré la story' -- node "$SK/step-7c-macro.js" --story "$W22/no-existe.md" --scenario "$TMP/escenario.json" --evidence-dir "$E22" --dry-run
espera macro-id-con-barras 2 'no sirve para nombrar evidencia' -- node "$SK/step-7c-macro.js" --story "../afuera/x" --scenario "$TMP/escenario.json" --evidence-dir "$E22" --dry-run
r22="$(cd "$W22" && TYCON_EVIDENCE_DIR="$E22" node "$SK/lib/test-gate-report.js" vitest "$W22" "$W22" "$TMP/res" "$TMP/tr22.json" 0 "../afuera/x" 75 2026-10-05T12:00:00Z 2>&1 >/dev/null)"
printf '%s' "$r22" | grep 'no sirve para nombrar evidencia' >/dev/null || f22="$f22 informe-sin-aviso($(printf '%s' "$r22" | head -1 | cut -c1-80))"
# Nada en la carpeta de evidencia, nada en la de al lado, nada suelto en .advisors/.
[ -n "$(ls -A "$E22" 2>/dev/null)" ] && f22="$f22 evidencia-escrita($(ls -A "$E22" | tr '\n' ' '))"
[ -n "$(ls -A "$W22/afuera" 2>/dev/null)" ] && f22="$f22 escribió-afuera($(ls -A "$W22/afuera" | tr '\n' ' '))"
sueltos="$(ls -A "$W22/.advisors" 2>/dev/null | grep -vx 'dod-runtime' | tr '\n' ' ')"
[ -n "${sueltos// /}" ] && f22="$f22 suelto-en-advisors($sueltos)"
if [ -z "$f22" ]; then ok "T22 ruta inexistente o id con barras/comillas: cada escritor sale con su código y su motivo, sin escribir nada"
else no "T22 un escritor aceptó un valor que no puede nombrar evidencia, o no lo rechazó por el motivo esperado:$f22"; fi

# T23 — la guía de QA y la verificación previa al cierre (`pipeline.js preflight-frontmatter`, PRE-1) también leen por la
#       clave: con dos stories 1.1, el humo y la evidencia de cierre de una no aparecen en la de la otra (lo pidió la
#       revisión de cobertura de la iteración 2).
# En su propia carpeta: PRE-1 también busca en los repos VECINOS, y los otros mundos de esta suite lo serían.
W23="$TMP/solo23/w23"; mkdir -p "$TMP/solo23"; repo "$W23"; E23="$W23/.advisors/dod-runtime"
story "$W23/.specs/a/stories/1-1-x.md" 1.1; story "$W23/.specs/b/stories/1-1-y.md" 1.1
for s23 in "$W23/.specs/a/stories/1-1-x.md" "$W23/.specs/b/stories/1-1-y.md"; do printf '\nVerificación: smoke runtime con tests_done_smoke.\n' >> "$s23"; done
bash "$SK/smoke-run.sh" "$E23" "$W23/.specs/b/stories/1-1-y.md" --acs 1 --pass-if 'responde 200' -- curl -s http://app/solo-de-b >/dev/null 2>&1
printf '# DoD Runtime Evidence — Story 1.1\nverdict=PASS\n' > "$E23/b__1.1-202610051200Z.md"
node "$SK/qa-guide.js" --story "$W23/.specs/a/stories/1-1-x.md" --out "$TMP/qa-a.html" >/dev/null 2>&1
node "$SK/qa-guide.js" --story "$W23/.specs/b/stories/1-1-y.md" --out "$TMP/qa-b.html" >/dev/null 2>&1
pre(){ node "$SK/pipeline.js" preflight-frontmatter --story-path "$1" --target-status review 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);const p=(r.preconditions||[]).find(x=>x.id==="PRE-1-evidence-file-exists");console.log(p?String(p.satisfied):"sin-PRE-1")}catch{console.log("?")}})'; }
p23a="$(pre "$W23/.specs/a/stories/1-1-x.md")"; p23b="$(pre "$W23/.specs/b/stories/1-1-y.md")"
f23=""
grep -q 'solo-de-b' "$TMP/qa-a.html" 2>/dev/null && f23="$f23 guía-de-a-muestra-el-humo-de-b"
grep -q 'solo-de-b' "$TMP/qa-b.html" 2>/dev/null || f23="$f23 guía-de-b-sin-su-humo"
[ "$p23a" = "false" ] || f23="$f23 PRE-1-de-a=$p23a"
[ "$p23b" = "true" ] || f23="$f23 PRE-1-de-b=$p23b"
if [ -z "$f23" ]; then ok "T23 guía de QA y PRE-1: la evidencia de b no le sirve a a"
else no "T23 la guía de QA o PRE-1 mezclan la evidencia de dos stories 1.1:$f23"; fi

echo "──"
echo "evidence-key-collision: $pasaron pasaron, $fallos fallaron"
[ "$fallos" -eq 0 ]
