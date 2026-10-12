#!/usr/bin/env bash
# pr-verdict.test.sh — red de `scripts/ci/pr-verdict.js`, el veredicto de la validación de un
# pull request del arnés: un rojo que YA estaba rojo en main avisa; sólo un rojo NUEVO frena.
#
# Caso disparador (medido en la etapa 0 del plan de protección por PR, 2026-09-17):
# `publish-bump.test.sh` está roja en el nocturno desde el 7/9 por una causa de entorno de Azure
# que no se reproduce en local. Con un veredicto «cero rojos o no entra», la política habría frenado
# el 100 % de los pull requests durante 11 días.
#
# Los casos que más pesan son los dos pares espejo: sin ellos un verde no significaría nada.
#   V1/V2  — el rojo viejo NO frena · el rojo nuevo SÍ frena (mismo reporte, una línea de diferencia)
#   V5/V6  — la foto ausente frena TODO · la foto vieja sigue sirviendo de excusa
#
# Correr: bash scripts/tests/pr-verdict.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$AQUI/scripts/ci/pr-verdict.js"
YAML="$AQUI/pipelines/azure-pipelines-pr.yml"
# Los pasos que corren las suites viven en una plantilla que usan el trabajo de suites y el del banco (story 8.22, tramo I).
SUITES_TEMPLATE="$AQUI/pipelines/templates/correr-suites.yml"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0; pasaron=0
ok(){ echo "✅ veredicto-pr: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ veredicto-pr: $1"; fallos=$((fallos+1)); }

hoy(){ node -e 'console.log(new Date().toISOString())'; }
hace_dias(){ node -e 'console.log(new Date(Date.now()-Number(process.argv[1])*86400000).toISOString())' "$1"; }

# Un reporte de suites con los nombres que se le pasen.
suites(){ # $1=archivo $2=ts $3..=nombres
  local f="$1" ts="$2"; shift 2
  node -e '
    const fs=require("fs"); const [f,ts,...n]=process.argv.slice(1);
    const motivos={}; for(const x of n) motivos[x]="se rompió algo";
    fs.writeFileSync(f, JSON.stringify({kind:"bash-tests",ts,corridas:107,failures:n,motivos},null,2));
  ' "$f" "$ts" "$@"
}

# Un reporte del banco: cada argumento es `caso|herramienta|pass` (pass = 1/0/nm).
banco(){ # $1=archivo $2=ts $3..=caso|tool|estado
  local f="$1" ts="$2"; shift 2
  node -e '
    const fs=require("fs"); const [f,ts,...spec]=process.argv.slice(1);
    const results={};
    for (const s of spec) { const [caso,tool,est]=s.split("|");
      results[caso]=results[caso]||{type:"must-block",asymmetry:null,tools:{}};
      results[caso].tools[tool]= est==="nm" ? {nomedido:true,pass:false,failures:[]} : {pass:est==="1",failures:est==="1"?[]:["falló"]};
    }
    let failed=0; for(const r of Object.values(results)) for(const t of Object.values(r.tools)) if(!t.skipped&&!t.nomedido&&t.pass===false) failed++;
    fs.writeFileSync(f, JSON.stringify({ts,tool:"both",ran:99,failed,skipped:0,nomedido:0,parityBreaks:0,baselineRegressions:0,results},null,2));
  ' "$f" "$ts" "$@"
}

VACIA="$TMP/sin-baseline.json"; echo '{"cases":{}}' > "$VACIA"
corre(){ node "$SCRIPT" --baseline "$VACIA" "$@" > "$TMP/out.txt" 2>&1; echo $?; }

# ── V1. el rojo que YA estaba rojo en la foto avisa y NO frena ───────────────────────────────────
suites "$TMP/foto-s.json" "$(hoy)" publish-bump.test.sh
suites "$TMP/ahora-s.json" "$(hoy)" publish-bump.test.sh
rc=$(corre --suites-actual "$TMP/ahora-s.json" --suites-snapshot "$TMP/foto-s.json")
{ [ "$rc" = 0 ] && grep -q 'ya estaba rojo en main' "$TMP/out.txt" && ! grep -q 'ROJO NUEVO' "$TMP/out.txt"; } \
  && ok "V1: 🔴 la suite roja desde hace 11 días avisa y deja pasar el pull request" || no "V1: rc=$rc · $(cat "$TMP/out.txt")"

# ── V2. (espejo de V1) el rojo que NO está en la foto frena, y lo nombra ─────────────────────────
suites "$TMP/ahora-s.json" "$(hoy)" publish-bump.test.sh lab-suite.test.sh
rc=$(corre --suites-actual "$TMP/ahora-s.json" --suites-snapshot "$TMP/foto-s.json")
{ [ "$rc" = 1 ] && grep -q 'ROJO NUEVO.*lab-suite.test.sh' "$TMP/out.txt" && grep -q 'ya estaba rojo en main.*publish-bump' "$TMP/out.txt"; } \
  && ok "V2: el rojo nuevo frena (exit 1) y se distingue del que ya estaba" || no "V2: rc=$rc · $(cat "$TMP/out.txt")"

# ── V3. una suite que estaba roja y ahora pasa: nada que decir, verde ────────────────────────────
suites "$TMP/ahora-s.json" "$(hoy)"
rc=$(corre --suites-actual "$TMP/ahora-s.json" --suites-snapshot "$TMP/foto-s.json")
{ [ "$rc" = 0 ] && grep -q 'sin rojos nuevos' "$TMP/out.txt" && ! grep -q 'ROJO NUEVO' "$TMP/out.txt"; } \
  && ok "V3: arreglar una suite roja no se acusa como nada" || no "V3: rc=$rc · $(cat "$TMP/out.txt")"

# ── V4. el banco: rojo viejo avisa, rojo nuevo frena, y la herramienta es parte de la identidad ──
banco "$TMP/foto-b.json" "$(hoy)" "hook-a::caso1|claude|0" "hook-a::caso1|codex|0"
banco "$TMP/ahora-b.json" "$(hoy)" "hook-a::caso1|claude|0" "hook-a::caso1|codex|0"
rc=$(corre --current-bench "$TMP/ahora-b.json" --bench-snapshot "$TMP/foto-b.json")
[ "$rc" = 0 ] && ok "V4a: el rojo del banco que ya estaba en la foto no frena" || no "V4a: rc=$rc · $(cat "$TMP/out.txt")"
# El mismo caso rojo en codex solamente: en la foto los dos estaban rojos, así que acá aparece
# PARIDAD ROTA, que la foto no tenía. Es un hecho nuevo y frena.
banco "$TMP/ahora-b.json" "$(hoy)" "hook-a::caso1|claude|1" "hook-a::caso1|codex|0"
rc=$(corre --current-bench "$TMP/ahora-b.json" --bench-snapshot "$TMP/foto-b.json")
{ [ "$rc" = 1 ] && grep -q 'paridad rota' "$TMP/out.txt"; } \
  && ok "V4b: la paridad rota que la foto no tenía es un rojo nuevo" || no "V4b: rc=$rc · $(cat "$TMP/out.txt")"

# ── V5. la foto AUSENTE no es una excusa en blanco, ni un verde: «no pude decidir: sin foto» ─────
# Story 8.26, tanda C (AC 43): hasta ese día, sin foto todo rojo contaba como nuevo y, sin rojos, salía verde. Con la
# validación sobre el público la foto viene de afuera (donde la deja el nocturno): si no llegó, la corrida no sabe qué
# es viejo y qué es nuevo, haya rojos o no. Sale 2 y lo dice; no frena como «rojo nuevo» ni aprueba en blanco.
suites "$TMP/ahora-s.json" "$(hoy)" publish-bump.test.sh
rc=$(corre --suites-actual "$TMP/ahora-s.json" --suites-snapshot "$TMP/no-existe.json")
{ [ "$rc" = 2 ] && grep -q 'no pude decidir: sin foto' "$TMP/out.txt" && grep -q 'no pude leer la foto nocturna' "$TMP/out.txt"; } \
  && ok "V5: 🔴 sin foto no se distingue viejo de nuevo ⇒ «no pude decidir: sin foto» (2), diciendo el motivo" || no "V5: rc=$rc · $(cat "$TMP/out.txt")"
echo '{ esto no es json' > "$TMP/rota.json"
rc=$(corre --suites-actual "$TMP/ahora-s.json" --suites-snapshot "$TMP/rota.json")
{ [ "$rc" = 2 ] && grep -q 'ilegible' "$TMP/out.txt" && grep -q 'no pude decidir: sin foto' "$TMP/out.txt"; } \
  && ok "V5b: una foto ilegible se trata igual que una ausente" || no "V5b: rc=$rc · $(cat "$TMP/out.txt")"
suites "$TMP/ahora-verde.json" "$(hoy)"
rc=$(corre --suites-actual "$TMP/ahora-verde.json" --suites-snapshot "$TMP/no-existe.json")
{ [ "$rc" = 2 ] && grep -q 'no pude decidir: sin foto' "$TMP/out.txt" && ! grep -q 'sin rojos nuevos' "$TMP/out.txt"; } \
  && ok "V5c: 🔴 sin foto y sin rojos tampoco es verde: «no pude decidir: sin foto»" || no "V5c: rc=$rc · $(cat "$TMP/out.txt")"
banco "$TMP/ahora-b5.json" "$(hoy)" "hook-a::caso1|claude|1"
rc=$(corre --current-bench "$TMP/ahora-b5.json" --bench-snapshot "$TMP/no-existe.json")
{ [ "$rc" = 2 ] && grep -q 'no pude decidir: sin foto' "$TMP/out.txt"; } \
  && ok "V5d: lo mismo con la foto del banco" || no "V5d: rc=$rc · $(cat "$TMP/out.txt")"
# V5e — (pase adversarial de la tanda C de la 8.26) la etiqueta sigue a la foto de CADA sección: (a) sin foto de suites y en
# modo aviso, la roja de suite no se llama «ROJO NUEVO»; (b) con la foto de suites y sin la del banco, la roja de suite
# nueva SÍ es «ROJO NUEVO» (su foto se leyó), y la corrida igual sale 2 por la foto que falta.
rc=$(corre --suites-actual "$TMP/ahora-s.json" --suites-snapshot "$TMP/no-existe.json" --suites-warn)
{ [ "$rc" = 2 ] && ! grep -q 'ROJO NUEVO' "$TMP/out.txt" && grep -q 'sin foto para saber si ya estaba en main: suite publish-bump' "$TMP/out.txt" \
  && grep -q '1 rojo(s) sin foto' "$TMP/out.txt"; } \
  && ok "V5e: sin foto de suites, en modo aviso la roja no se llama nueva y se cuenta" || no "V5e: rc=$rc · $(cat "$TMP/out.txt")"
suites "$TMP/foto-s5.json" "$(hoy)"
rc=$(corre --suites-actual "$TMP/ahora-s.json" --suites-snapshot "$TMP/foto-s5.json" --current-bench "$TMP/ahora-b5.json" --bench-snapshot "$TMP/no-existe.json")
{ [ "$rc" = 2 ] && grep -q 'ROJO NUEVO (no está en la foto nocturna): suite publish-bump' "$TMP/out.txt" && grep -q 'sin foto nocturna de banco' "$TMP/out.txt"; } \
  && ok "V5f: con la foto de suites y sin la del banco, la roja de suite nueva se nombra nueva (y la corrida sale 2)" || no "V5f: rc=$rc · $(cat "$TMP/out.txt")"

# ── V6. (espejo de V5) la foto VIEJA sigue sirviendo de excusa, con el aviso de su edad ──────────
suites "$TMP/foto-vieja.json" "$(hace_dias 9)" publish-bump.test.sh
rc=$(corre --suites-actual "$TMP/ahora-s.json" --suites-snapshot "$TMP/foto-vieja.json")
{ [ "$rc" = 0 ] && grep -q 'foto nocturna es de hace 9 día' "$TMP/out.txt" && grep -q 'ya estaba rojo en main' "$TMP/out.txt"; } \
  && ok "V6: 🔴 el nocturno caído no frena todos los pull requests: la foto vieja se usa y se dice la edad" \
  || no "V6: rc=$rc · $(cat "$TMP/out.txt")"

# ── V7. el reporte de ESTA corrida ilegible o ausente ⇒ exit 2, nunca 0 ──────────────────────────
rc=$(corre --suites-actual "$TMP/no-existe-ahora.json" --suites-snapshot "$TMP/foto-s.json")
{ [ "$rc" = 2 ] && grep -qi 'no pude decidir' "$TMP/out.txt"; } \
  && ok "V7: sin el reporte de esta corrida no se midió ⇒ 2, no verde" || no "V7: rc=$rc · $(cat "$TMP/out.txt")"
rc=$(corre --current-bench "$TMP/rota.json" --bench-snapshot "$TMP/foto-b.json")
[ "$rc" = 2 ] && ok "V7b: reporte del banco ilegible ⇒ 2" || no "V7b: rc=$rc · $(cat "$TMP/out.txt")"
rc=$(corre --suites-snapshot "$TMP/foto-s.json")
[ "$rc" = 2 ] && ok "V7c: sin nada que juzgar ⇒ 2 (un veredicto sobre la nada no es un veredicto)" || no "V7c: rc=$rc · $(cat "$TMP/out.txt")"

# ── V8. NO MEDIDO avisa y nunca frena ───────────────────────────────────────────────────────────
banco "$TMP/foto-b.json" "$(hoy)" "hook-a::caso1|claude|1"
banco "$TMP/ahora-b.json" "$(hoy)" "hook-a::caso1|claude|nm"
rc=$(corre --current-bench "$TMP/ahora-b.json" --bench-snapshot "$TMP/foto-b.json")
{ [ "$rc" = 0 ] && grep -q 'NO MEDIDO' "$TMP/out.txt"; } \
  && ok "V8: un caso NO MEDIDO avisa y no frena (no dice que ande ni que esté roto)" || no "V8: rc=$rc · $(cat "$TMP/out.txt")"

# ── V9. regresión contra la baseline: se deriva por NOMBRE y se compara contra la foto ───────────
echo '{"cases":{"hook-a::caso1":true}}' > "$TMP/base.json"
banco "$TMP/foto-b.json" "$(hoy)" "hook-a::caso1|claude|1"
banco "$TMP/ahora-b.json" "$(hoy)" "hook-a::caso1|claude|0"
node "$SCRIPT" --current-bench "$TMP/ahora-b.json" --bench-snapshot "$TMP/foto-b.json" --baseline "$TMP/base.json" > "$TMP/out.txt" 2>&1; rc=$?
{ [ "$rc" = 1 ] && grep -q 'regresión contra la baseline' "$TMP/out.txt"; } \
  && ok "V9: una regresión contra la baseline que la foto no tenía frena, con el caso nombrado" || no "V9: rc=$rc · $(cat "$TMP/out.txt")"
node "$SCRIPT" --current-bench "$TMP/ahora-b.json" --bench-snapshot "$TMP/ahora-b.json" --baseline "$TMP/base.json" > "$TMP/out.txt" 2>&1; rc=$?
[ "$rc" = 0 ] && ok "V9b: la misma regresión, si ya estaba en la foto, avisa y no frena" || no "V9b: rc=$rc · $(cat "$TMP/out.txt")"
# Sin baseline no hay cómo derivar regresiones: se dice, y no se inventa un rojo nuevo por eso.
# (La foto es la MISMA corrida, así que lo único que podría cambiar el veredicto es la baseline.)
node "$SCRIPT" --current-bench "$TMP/ahora-b.json" --bench-snapshot "$TMP/ahora-b.json" --baseline "$TMP/no-existe.json" > "$TMP/out.txt" 2>&1; rc=$?
{ [ "$rc" = 0 ] && grep -qi 'no pude leer la baseline' "$TMP/out.txt"; } \
  && ok "V9c: sin baseline las regresiones no se juzgan, y se DICE (no se callan)" || no "V9c: rc=$rc · $(cat "$TMP/out.txt")"

# ── V10. el texto de afuera no fija comandos de la corrida ──────────────────────────────────────
# El motivo de una suite roja es salida libre de un test: Azure interpreta `##vso[` en CUALQUIER
# línea de la consola del paso.
node -e '
  const fs=require("fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({kind:"bash-tests",ts:new Date().toISOString(),failures:["mala.test.sh"],
    motivos:{"mala.test.sh":"falló\n##vso[task.setvariable variable=X]1\n##vso[task.complete result=Succeeded]"}}));
' "$TMP/ahora-s.json"
suites "$TMP/foto-s.json" "$(hoy)"
node "$SCRIPT" --suites-actual "$TMP/ahora-s.json" --suites-snapshot "$TMP/foto-s.json" --baseline "$VACIA" --ado > "$TMP/out.txt" 2>&1; rc=$?
# Lo que importa NO es que la palabra desaparezca (el hallazgo tiene que seguir siendo legible):
# es que en toda la salida haya UN solo `##vso[`, el nuestro. El del motivo quedó neutralizado.
{ [ "$rc" = 1 ] && [ "$(grep -o '##vso\[' "$TMP/out.txt" | wc -l | tr -d ' ')" = 1 ] \
  && [ "$(grep -c . "$TMP/out.txt")" -ge 1 ] && grep -q 'mala.test.sh' "$TMP/out.txt" \
  && grep -q 'setvariable' "$TMP/out.txt"; } \
  && ok "V10: 🔴 un motivo con ##vso adentro no fija variables de la corrida, y el hallazgo se sigue leyendo entero" \
  || no "V10: rc=$rc · $(cat "$TMP/out.txt")"

# ── V11. el pipeline de PR llama a este guion y no escribe en el repo ───────────────────────────
if [ ! -f "$YAML" ]; then
  no "V11: no encontré $YAML — el veredicto sin su pipeline no cubre nada"
else
  { grep -q 'pr-verdict.js' "$YAML" && grep -q -- '--ado' "$YAML"; } \
    && ok "V11a: el pipeline de PR da el veredicto con este guion, en modo Azure" || no "V11a: el pipeline no llama a pr-verdict.js --ado"
  # Nunca escribe: ni commit, ni push, ni add. (El nocturno sí; éste no.)
  if grep -nE '^[^#]*git (commit|push|add)\b' "$YAML" > "$TMP/escribe.txt"; then
    no "V11b: 🔴 el pipeline de PR escribe en el repo: $(cat "$TMP/escribe.txt")"
  else
    ok "V11b: el pipeline de PR nunca commitea ni pushea (eso sigue siendo del nocturno)"
  fi
  # Story 8.26, tanda C (AC 10): en un repo de GitHub el pedido es el que la dispara (`pr:` sobre main, y Azure corta las
  # corridas viejas del mismo pedido); en un repo de Azure ese bloque no se aplica (allá la encola la política de rama),
  # así que la 170 no cambia. Lo que sigue sin existir es el disparador por empuje: dos corridas por cambio.
  { grep -q '^trigger: none' "$YAML" && grep -A2 '^pr:' "$YAML" | grep -qE 'include: \[main\]' && ! grep -q '^pr: none' "$YAML"; } \
    && ok "V11c: no se dispara por empuje; en GitHub lo dispara el pedido a main" || no "V11c: el pipeline tiene trigger propio o no declara el pedido a main"
fi

# ── V12. el orden: AgentSkills ANTES del lint, y sin condición ───────────────────────────────────
# 🔴 ROJO PREVIO REAL, no inventado: la corrida 10568 (17/9) tenía el clon DESPUÉS del lint y dos
# controles mintieron en la misma corrida — el lint de frontmatter declaró «todas las stories son
# legibles» habiendo mirado 33 de 278 .md (sin el descubridor, que vive en AgentSkills), y
# `build/check.js` salió rojo por no encontrar los advisors canónicos.
if [ -f "$YAML" ]; then
  ORDEN=$(node -e '
    const y=require("fs").readFileSync(process.argv[1],"utf8").split("\n");
    const lint = y.findIndex((l)=>/displayName: .Controles de lint/.test(l));
    // el primer uso del template que SÍ trae AgentSkills (agentSkills: false lo apaga)
    let clon=-1, incond=null;
    for (let i=0;i<y.length;i++) {
      if (!/template: \/pipelines\/templates\/traer-repos\.yml/.test(y[i])) continue;
      const bloque = y.slice(i, i+8).join("\n");
      if (/agentSkills: false/.test(bloque)) continue;
      clon = i; incond = !/condicion:/.test(bloque); break;
    }
    console.log(`${clon} ${lint} ${incond}`);
  ' "$YAML")
  set -- $ORDEN
  { [ "$1" != "-1" ] && [ "$2" != "-1" ] && [ "$1" -lt "$2" ]; } \
    && ok "V12a: 🔴 AgentSkills se clona ANTES del lint (sin él, el lint de stories mira 33 de 278 y dice OK)" \
    || no "V12a: el clon de AgentSkills (línea $1) no está antes del lint (línea $2)"
  [ "$3" = "true" ] \
    && ok "V12b: ese clon no está condicionado a que haya código — un PR de sólo docs es JUSTO el que toca stories" \
    || no "V12b: el clon de AgentSkills quedó condicionado; un PR de docs lintearía sin el descubridor"
fi

# ── V12d. una suite que anoche NO SE MIDIÓ no excusa un rojo de hoy (2026-10-04) ────────────────
# Las suites del nocturno corren en trabajos paralelos, y las de un trabajo que no terminó quedan en `failures` de la
# foto (con la marca «(no-medida)») y, aparte, en `unmeasured`. No son rojas: no se sabe cómo estaban. Lo que manda es
# el campo `unmeasured`, no la marca: aunque la entrada llevara el nombre pelado, no cuenta como «ya estaba roja».
foto_incompleta(){ # $1=archivo $2..=entradas no medidas, tal cual van en failures
  local f="$1"; shift
  node -e '
    const fs=require("fs"); const [f,...u]=process.argv.slice(1);
    const motivos={"publish-bump.test.sh":"se rompió algo"}; for(const x of u) motivos[x]="no medida: el trabajo 2 no terminó";
    fs.writeFileSync(f, JSON.stringify({kind:"bash-tests",ts:new Date().toISOString(),corridas:50,failures:["publish-bump.test.sh",...u],motivos,unmeasured:u,complete:false},null,2));
  ' "$f" "$@"
}
suites "$TMP/ahora-s.json" "$(hoy)" publish-bump.test.sh lab-suite.test.sh
foto_incompleta "$TMP/foto-inc.json" "lab-suite.test.sh(no-medida)" "otra.test.sh(no-medida)"
rc=$(corre --suites-actual "$TMP/ahora-s.json" --suites-snapshot "$TMP/foto-inc.json")
{ [ "$rc" = 1 ] && grep -q 'ROJO NUEVO.*lab-suite.test.sh' "$TMP/out.txt" && grep -q 'ya estaba rojo en main.*publish-bump' "$TMP/out.txt" \
  && grep -q 'foto nocturna quedó incompleta.*2 suite' "$TMP/out.txt"; } \
  && ok "V12d: 🔴 el rojo en una suite que anoche no se midió es NUEVO, y se avisa que la foto quedó incompleta" || no "V12d: rc=$rc · $(cat "$TMP/out.txt")"
foto_incompleta "$TMP/foto-inc.json" "lab-suite.test.sh"
rc=$(corre --suites-actual "$TMP/ahora-s.json" --suites-snapshot "$TMP/foto-inc.json")
{ [ "$rc" = 1 ] && grep -q 'ROJO NUEVO.*lab-suite.test.sh' "$TMP/out.txt"; } \
  && ok "V12e: manda el campo unmeasured, no la marca: una no medida con el nombre pelado tampoco excusa" || no "V12e: rc=$rc · $(cat "$TMP/out.txt")"

# ── V12f. las suites de ESTA corrida que no se midieron: ni verdes ni «rojo nuevo» (2026-10-04) ──────────────────
# La validación de cada cambio corre sus suites en trabajos paralelos. Si un trabajo no terminó (lo cortó el tope, no
# publicó, lo que publicó no cuadra), sus suites llegan al reporte como no medidas. No son un rojo que trajo el cambio
# —no se sabe cómo estaban— y tampoco un verde: el veredicto lo dice con todas las letras y sale 2 («no pude decidir»),
# también en modo aviso. Un rojo nuevo del banco sigue mandando: sale 1.
foto_incompleta "$TMP/ahora-inc.json" "lab-a.test.sh(no-medida)" "lab-b.test.sh(no-medida)"
suites "$TMP/foto-s.json" "$(hoy)" publish-bump.test.sh
rc=$(corre --suites-actual "$TMP/ahora-inc.json" --suites-snapshot "$TMP/foto-s.json" --suites-warn)
# Story 8.22, tramo D: una suite que pasó su tope también llega no medida, desde un trabajo que SÍ terminó: el motivo
# que da el veredicto nombra las dos causas (pase adversarial: decía sólo «un trabajo no terminó»).
{ [ "$rc" = 2 ] && grep -q '2 suite(s) NO SE MIDIERON' "$TMP/out.txt" && grep -q 'lab-a.test.sh' "$TMP/out.txt" \
  && grep -q 'un trabajo de suites no terminó, o la suite pasó su tope' "$TMP/out.txt" \
  && ! grep -q 'ROJO NUEVO.*lab-a' "$TMP/out.txt" && ! grep -q '✅ sin rojos nuevos' "$TMP/out.txt"; } \
  && ok "V12f: 🔴 las suites de un trabajo que no terminó se declaran NO MEDIDAS: ni rojo nuevo ni verde (sale 2, aun en modo aviso)" \
  || no "V12f: rc=$rc · $(cat "$TMP/out.txt")"
banco "$TMP/foto-b.json" "$(hoy)" "hook-a::caso1|claude|1"
banco "$TMP/ahora-b.json" "$(hoy)" "hook-a::caso1|claude|0"
rc=$(corre --suites-actual "$TMP/ahora-inc.json" --suites-snapshot "$TMP/foto-s.json" --current-bench "$TMP/ahora-b.json" --bench-snapshot "$TMP/foto-b.json" --suites-warn)
{ [ "$rc" = 1 ] && grep -q 'ROJO NUEVO.*hook-a' "$TMP/out.txt" && grep -q 'NO SE MIDIERON' "$TMP/out.txt"; } \
  && ok "V12g: con suites sin medir, un rojo nuevo del banco sigue frenando (sale 1) y las no medidas se siguen diciendo" \
  || no "V12g: rc=$rc · $(cat "$TMP/out.txt")"

# ── V12h. la suite que no corrió porque el cambio no toca lo que mide: se nombra, no se cuenta (2026-10-04) ────
node -e '
  const fs=require("fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({kind:"bash-tests",ts:new Date().toISOString(),corridas:3,failures:[],motivos:{},
    notRun:{"export-real.test.sh":"el cambio no toca lo que mide (scripts/ci/heavy-suites.json): la corre el banco nocturno"}}));
' "$TMP/ahora-nr.json"
suites "$TMP/foto-s.json" "$(hoy)" export-real.test.sh
rc=$(corre --suites-actual "$TMP/ahora-nr.json" --suites-snapshot "$TMP/foto-s.json" --suites-warn)
{ [ "$rc" = 0 ] && grep -q 'no corrió: el cambio no toca lo que mide — export-real.test.sh' "$TMP/out.txt" \
  && ! grep -q 'ya estaba rojo en main.*export-real' "$TMP/out.txt" && ! grep -q 'ROJO NUEVO' "$TMP/out.txt" \
  && grep -q '1 no corrió' "$TMP/out.txt"; } \
  && ok "V12h: 🔴 la suite que no corrió se lista como «no corrió: el cambio no toca lo que mide», sin contarla roja ni verde" \
  || no "V12h: rc=$rc · $(cat "$TMP/out.txt")"

# ── V12i. la suite que no viaja: «no corrió: no viaja», con su texto propio (story 8.26, tanda C, AC 11) ────────────
# Con la validación sobre el público, las suites que sólo existen en el repo de mantenimiento no están en el árbol que
# se valida. No son un rojo, ni un verde, ni «el cambio no toca lo que mide» (que sería falso): corren en el nocturno.
node -e '
  const fs=require("fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({kind:"bash-tests",ts:new Date().toISOString(),corridas:3,failures:[],motivos:{},
    notTravelling:["lab-private-a.test.sh","lab-private-b.test.js"]}));
' "$TMP/ahora-nv.json"
suites "$TMP/foto-s.json" "$(hoy)" lab-private-a.test.sh
rc=$(corre --suites-actual "$TMP/ahora-nv.json" --suites-snapshot "$TMP/foto-s.json")
{ [ "$rc" = 0 ] && grep -q '2 no viajan' "$TMP/out.txt" && grep -q 'no corrió: no viaja — lab-private-a.test.sh' "$TMP/out.txt" \
  && ! grep -q 'el cambio no toca lo que mide' "$TMP/out.txt" && ! grep -q 'ROJO NUEVO' "$TMP/out.txt" \
  && ! grep -q 'ya estaba rojo en main.*lab-private-a' "$TMP/out.txt"; } \
  && ok "V12i: 🔴 la suite que no viaja se nombra «no corrió: no viaja» y se cuenta aparte, ni roja ni verde" \
  || no "V12i: rc=$rc · $(cat "$TMP/out.txt")"

# ── V13. Etapa 3: las suites AVISAN, el banco FRENA (decisión del dev, 2026-09-17) ──────────────
# Medido en las corridas 10569 y 10570: dos suites verdes en la Mac salieron rojas en el agente, y
# NO fueron las mismas. Con 116 suites, aun poca intermitencia deja casi todo PR en rojo por algo
# que el cambio no hizo. Lo que NO se relaja: el banco, y el minuto de lint (que corre aparte).
suites "$TMP/foto-s.json" "$(hoy)"
suites "$TMP/ahora-s.json" "$(hoy)" periodic-exam.test.js
rc=$(corre --suites-actual "$TMP/ahora-s.json" --suites-snapshot "$TMP/foto-s.json" --suites-warn)
{ [ "$rc" = 0 ] && grep -q 'MODO AVISO' "$TMP/out.txt" && grep -q 'periodic-exam' "$TMP/out.txt"; } \
  && ok "V13a: 🔴 un rojo nuevo de suite avisa y NO frena — y se sigue viendo, con la palabra" \
  || no "V13a: rc=$rc · $(cat "$TMP/out.txt")"
banco "$TMP/foto-b.json" "$(hoy)" "hook-a::caso1|claude|1"
banco "$TMP/ahora-b.json" "$(hoy)" "hook-a::caso1|claude|0"
rc=$(corre --current-bench "$TMP/ahora-b.json" --bench-snapshot "$TMP/foto-b.json" --suites-warn)
{ [ "$rc" = 1 ] && grep -q 'ROJO NUEVO' "$TMP/out.txt" && ! grep -q 'MODO AVISO' "$TMP/out.txt"; } \
  && ok "V13b: (espejo) el banco sigue frenando en el mismo modo — sin esto, la bandera apagaría todo" \
  || no "V13b: rc=$rc · $(cat "$TMP/out.txt")"
# Sin la bandera, la suite frena: la decisión es TEMPORAL y el default no cambió.
rc=$(corre --suites-actual "$TMP/ahora-s.json" --suites-snapshot "$TMP/foto-s.json")
[ "$rc" = 1 ] && ok "V13c: sin la bandera la suite frena — el modo aviso es de la Etapa 3, no el default" \
  || no "V13c: rc=$rc · $(cat "$TMP/out.txt")"

# ── V14. el reintento: las DOS pasadas quedan anotadas, y la intermitente se nombra ──────────────
# Es el dato que la Etapa 3 necesita para decidir si las suites vuelven a frenar.
node -e '
  const fs=require("fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({kind:"bash-tests",ts:new Date().toISOString(),failures:[],motivos:{},
    reintentos:{"dashboard-runs.test.sh":{primera:"rojo",segunda:"verde"},"otra.test.sh":{primera:"rojo",segunda:"rojo"}}}));
' "$TMP/ahora-s.json"
rc=$(corre --suites-actual "$TMP/ahora-s.json" --suites-snapshot "$TMP/foto-s.json" --suites-warn)
{ [ "$rc" = 0 ] && grep -q 'INTERMITENTE en el agente: dashboard-runs' "$TMP/out.txt" \
  && ! grep -q 'INTERMITENTE en el agente: otra' "$TMP/out.txt"; } \
  && ok "V14a: la suite que salió verde en la 2ª pasada se nombra intermitente; la que siguió roja, no" \
  || no "V14a: rc=$rc · $(cat "$TMP/out.txt")"
if [ -f "$YAML" ]; then
  # Story 8.26, tanda C (AC 14): el modo aviso ya no está fijo en el YAML; lo decide el interruptor de la definición
  # (scripts/ci/suites-block.js). Lo que hace cada valor lo corre pr-suites-shards.test.js con el paso real.
  { grep -q -- '--retries' "$YAML" && grep -q 'suites-block.js' "$YAML" && grep -q 'suites-block.js' "$SUITES_TEMPLATE" \
    && ! grep -qE '^[^#]*pr-verdict\.js.* --suites-warn' "$YAML" && grep -q '2ª pasada' "$SUITES_TEMPLATE"; } \
    && ok "V14b: el pipeline reintenta la suite roja y el modo aviso lo decide el interruptor, no el YAML" \
    || no "V14b: el pipeline no reintenta, o el modo aviso sigue fijo en el YAML"
  # El banco NO se reintenta: su rojo frena. (Su paso no puede nombrar el reintento.)
  BANCO_PASO=$(awk "/displayName: 'Banco de controles/{exit} /- script: \|/{buf=\"\"} {buf=buf\"\\n\"\$0} END{print buf}" "$YAML")
  echo "$BANCO_PASO" | grep -q 'reintent' \
    && no "V14c: 🔴 el paso del banco reintenta — el rojo del banco tiene que frenar" \
    || ok "V14c: el banco no se reintenta (sólo las suites)"
fi

# ── V15. R6_Pipelines_TemplatesRegexGlobsCensus (T40 de la story 8.12) ───────────────────────────
# Los yml del arnés viven en pipelines/ y la plantilla en pipelines/templates/.
# 🔴 rojo previo (a): el regex viejo de «Qué trae este cambio» nombraba la carpeta de plantillas de antes y los yml de la
#    raíz: un pull request que sólo toca pipelines/x.yml quedaba «sin código» y no corría ni banco ni suites.
# 🔴 rojo previo (b): un `- template:` sin la barra inicial. Azure resuelve una ruta relativa desde la carpeta del yml que
#    la incluye, y pipelines/pipelines/templates/… no existe: el pipeline no arranca.
if [ -f "$YAML" ]; then
  # el patrón se lee del paso real, no de una copia
  PATRON=$(awk "/- script: \|/{buf=\"\"} {buf=buf\"\\n\"\$0} /displayName: 'Qué trae este cambio'/{print buf; exit}" "$YAML" \
    | grep -E "grep -qE '[^']+' \"\\\$LISTA(_CODIGO)?\"" | sed -E "s/.*grep -qE '([^']+)'.*/\1/")
  if [ -z "$PATRON" ]; then
    no "V15a: no encontré el patrón de código en el paso «Qué trae este cambio»"
  else
    MALCLASIF=""
    for p in pipelines/azure-pipelines-lab.yml pipelines/templates/plantilla-lab.yml scripts/lab.js; do
      printf '%s\n' "$p" | grep -qE "$PATRON" || MALCLASIF="$MALCLASIF $p(no-código)"
    done
    for p in docs/lab.md guides/lab.md README.md; do
      printf '%s\n' "$p" | grep -qE "$PATRON" && MALCLASIF="$MALCLASIF $p(código)"
    done
    [ -z "$MALCLASIF" ] \
      && ok "V15a: 🔴 el regex clasifica pipelines/x.yml y pipelines/templates/x.yml como código, y docs/x.md no" \
      || no "V15a: el regex de «Qué trae este cambio» clasifica mal:$MALCLASIF"
  fi
fi
if [ -d "$AQUI/pipelines" ]; then
  : > "$TMP/plantillas.txt"
  for y in "$AQUI"/pipelines/*.yml; do
    grep -nE '^[[:space:]]*-[[:space:]]*template:' "$y" | while IFS= read -r l; do
      ruta=$(printf '%s' "$l" | sed -E 's/.*template:[[:space:]]*//; s/[[:space:]]+#.*$//; s/[[:space:]]*$//')
      case "$ruta" in
        /pipelines/templates/*) [ -f "$AQUI$ruta" ] || echo "$(basename "$y"): $ruta no existe" >> "$TMP/plantillas.txt" ;;
        *) echo "$(basename "$y"): $ruta no es /pipelines/templates/…" >> "$TMP/plantillas.txt" ;;
      esac
    done
  done
  N=$(grep -hcE '^[[:space:]]*-[[:space:]]*template:' "$AQUI"/pipelines/*.yml | awk '{s+=$1} END{print s+0}')
  { [ ! -s "$TMP/plantillas.txt" ] && [ "$N" -ge 4 ]; } \
    && ok "V15b: 🔴 los $N \`- template:\` usan /pipelines/templates/… con la barra, y el archivo existe" \
    || no "V15b: plantillas mal nombradas (${N} usos): $(tr '\n' ' ' < "$TMP/plantillas.txt")"
else
  no "V15b: no existe pipelines/ — los yml del arnés viven ahí desde la R6"
fi

# ── V16. PrPipeline_SkillsOnlyChange_CountsAsCode_BothHookParts (T14 de la story 8.18, AC 15) ────
# Desde la 8.18 el arnés trae agent-skills adentro (`agents/`, `skills/`, `packs/`). Dos formas de que un pull
# request que sólo toca skills pase sin que nadie lo mire, y las dos estaban:
#   (a) «Qué trae este cambio» no contaba `skills/` ni `packs/` como código: ni banco ni suites;
#   (b) el lint corría cada freno de nombres UNA vez, y en el repo unido cada corrida mira sólo la mitad de su
#       fuente: la de `skills/` no la miraba nadie ([DEF-8.18-lint-del-pr]).
# 🔴 El paso de lint se corre de verdad, sacado del yml por su displayName, con un `node` de juguete que anota
#    cada llamada y sale con el código que el caso le pide: lo que se mide es qué controles llama el paso y qué
#    hace con su código de salida, no los controles (cada uno tiene su suite).
# El lint NO llama al pre-commit: un hook en el servidor mira lo stageado, que ahí es nada —un verde sobre el
# vacío—. Son pasos escritos en el yml, con `--range` (precisado en el AC 15 tras la revisión adversarial).
if [ -f "$YAML" ]; then
  PATRON=$(awk "/- script: \|/{buf=\"\"} {buf=buf\"\\n\"\$0} /displayName: 'Qué trae este cambio'/{print buf; exit}" "$YAML" \
    | grep -E "grep -qE '[^']+' \"\\\$LISTA(_CODIGO)?\"" | sed -E "s/.*grep -qE '([^']+)'.*/\1/")
  if [ -z "$PATRON" ]; then
    no "V16a: no encontré el patrón de código en el paso «Qué trae este cambio»"
  else
    MALCLASIF=""
    # las rutas de la fuente lógica agent-skills (contrato C7): las tres carpetas y sus dos archivos sueltos
    for p in skills/lab-skill/SKILL.md packs/lab-pack/pack.json agents/lab-reviewer.md .tycon/post-commit-ignore .githooks/pre-commit-skills; do
      printf '%s\n' "$p" | grep -qE "$PATRON" || MALCLASIF="$MALCLASIF $p(no-código)"
    done
    # espejo: documentación, y lo que sólo se parece (otra carpeta con ese nombre adentro, otro archivo de .tycon/)
    for p in specs/story-lab.md guides/skills/lab.md docs/packs/lab.md skills-notes.md .tycon/ado-config.yaml; do
      printf '%s\n' "$p" | grep -qE "$PATRON" && MALCLASIF="$MALCLASIF $p(código)"
    done
    [ -z "$MALCLASIF" ] \
      && ok "V16a: 🔴 un cambio que toca sólo skills/, packs/ o agents/ cuenta como código (corren el banco y las suites); uno de specs/, no" \
      || no "V16a: «Qué trae este cambio» clasifica mal:$MALCLASIF"
  fi

  # el paso de lint, tal cual está en el yml, con las macros de Azure cambiadas por rutas del laboratorio
  L16="$TMP/v16"; mkdir -p "$L16/tmp" "$L16/bin" "$L16/src" "$L16/no-git"
  node -e '
    const fs = require("fs");
    const [file, display, src, tmp] = process.argv.slice(1);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const at = lines.findIndex((l) => l.includes("displayName: \x27" + display + "\x27"));
    if (at < 0) process.exit(3);
    let start = -1;
    for (let i = at; i >= 0; i--) if (/^\s*-\s+script:\s*\|\s*$/.test(lines[i])) { start = i; break; }
    if (start < 0) process.exit(3);
    const body = lines.slice(start + 1, at);
    const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
    const text = body.map((l) => l.slice(indent)).join("\n")
      .split("$(Build.SourcesDirectory)").join(src).split("$(Agent.TempDirectory)").join(tmp).split("$(baseDelCambio)").join("origin/main");
    const left = text.match(/\$\([A-Za-z]+\.[A-Za-z.]+\)|\$\([a-z][A-Za-z]+\)|\$\{\{[^}]*\}\}/g);
    if (left) { process.stderr.write("macros sin sustituir: " + [...new Set(left)].join(" ") + "\n"); process.exit(4); }
    process.stdout.write(text + "\n");
  ' "$YAML" 'Controles de lint (siempre)' "__SRC__" "$L16/tmp" > "$L16/lint.tpl" 2> "$L16/extract.err"; RC16=$?
  if [ "$RC16" != 0 ] || [ ! -s "$L16/lint.tpl" ]; then
    no "V16: no pude sacar el paso «Controles de lint (siempre)» del yml (código $RC16): $(cat "$L16/extract.err")"
  else
    # el `node` de juguete: anota la llamada y sale con lo que el caso pide para la que nombra STUB_FAIL_MATCH
    cat > "$L16/bin/node" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_LOG"
if [ -n "${STUB_FAIL_MATCH:-}" ]; then
  case "$*" in *"$STUB_FAIL_MATCH"*) exit "${STUB_FAIL_CODE:-1}" ;; esac
fi
exit 0
STUB
    chmod +x "$L16/bin/node"
    # un repo de verdad con su origin/main, para que el paso pueda preguntarle a git qué trae el cambio
    ( cd "$L16/src" && unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE && git -c init.defaultBranch=main init -q && echo uno > a.txt && git add a.txt \
      && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -q -m base && git update-ref refs/remotes/origin/main HEAD \
      && echo dos > b.txt && git add b.txt && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -q -m cambio ) \
      || no "V16: no pude armar el repo de juguete"
    lint16() { # $1=carpeta del «checkout» $2=lista de archivos (separados por espacio) [$3=llamada que falla] [$4=código] → código del paso
      local src="$1" lista="$2" match="${3:-}" code="${4:-1}"
      : > "$L16/calls.txt"; printf '%s\n' $lista > "$L16/tmp/cambiados.txt"
      sed "s|__SRC__|$src|g" "$L16/lint.tpl" > "$L16/lint.sh"
      ( unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE
        PATH="$L16/bin:$PATH" STUB_LOG="$L16/calls.txt" STUB_FAIL_MATCH="$match" STUB_FAIL_CODE="$code" bash "$L16/lint.sh" ) > "$L16/lint.txt" 2>&1
      echo $?
    }
    veces() { grep -cF -- "$1" "$L16/calls.txt"; }
    R='--range origin/main...HEAD'

    # V16b — un cambio que sólo toca skills/: cada freno de nombres corre DOS veces, una por fuente, con --range
    rc=$(lint16 "$L16/src" "skills/lab-skill/SKILL.md")
    { [ "$rc" = 0 ] && [ "$(veces "scripts/publishing/new-names.js $R --source arnes")" = 1 ] \
      && [ "$(veces "scripts/publishing/new-names.js $R --source agent-skills")" = 1 ] \
      && [ "$(veces "scripts/publishing/spanish-names.js $R --source arnes")" = 1 ] \
      && [ "$(veces "scripts/publishing/spanish-names.js $R --source agent-skills")" = 1 ]; } \
      && ok "V16b: 🔴 el lint corre cada freno de nombres dos veces, una por fuente (arnes y agent-skills), con --range" \
      || no "V16b: rc=$rc · llamadas: $(tr '\n' '|' < "$L16/calls.txt")"

    # V16c — un rojo de la corrida de agent-skills frena el lint (antes no había quién lo viera) …
    rc=$(lint16 "$L16/src" "skills/lab-skill/SKILL.md" "spanish-names.js $R --source agent-skills" 1)
    { [ "$rc" = 1 ] && grep -q '1 control(es) en rojo' "$L16/lint.txt" && grep -q 'agent-skills' "$L16/lint.txt"; } \
      && ok "V16c: 🔴 un nombre nuevo en castellano dentro de skills/ frena el lint, y la línea dice que fue la fuente agent-skills" \
      || no "V16c: rc=$rc · $(tail -3 "$L16/lint.txt" | tr '\n' ' ')"
    rc=$(lint16 "$L16/src" "skills/lab-skill/SKILL.md" "new-names.js $R --source agent-skills" 1)
    { [ "$rc" = 1 ] && grep -q '1 control(es) en rojo' "$L16/lint.txt"; } \
      && ok "V16c: …y un nombre real dentro de skills/, también" || no "V16c (nombres reales): rc=$rc · $(tail -3 "$L16/lint.txt" | tr '\n' ' ')"
    # … «no pude mirar» (2) tampoco es verde …
    rc=$(lint16 "$L16/src" "skills/lab-skill/SKILL.md" "new-names.js $R --source agent-skills" 2)
    { [ "$rc" = 1 ] && grep -q 'no pude mirar' "$L16/lint.txt"; } \
      && ok "V16c: un «no pude mirar» de la corrida de agent-skills frena igual: no medido no es verde" \
      || no "V16c (no pude mirar): rc=$rc · $(tail -3 "$L16/lint.txt" | tr '\n' ' ')"
    # … y (espejo) la corrida del arnés sigue frenando por su cuenta
    rc=$(lint16 "$L16/src" "scripts/lab.js" "spanish-names.js $R --source arnes" 1)
    { [ "$rc" = 1 ] && grep -q '1 control(es) en rojo' "$L16/lint.txt"; } \
      && ok "V16c: (espejo) la corrida de la fuente arnes sigue frenando por su cuenta" || no "V16c (espejo): rc=$rc · $(tail -3 "$L16/lint.txt" | tr '\n' ' ')"

    # V16d — «nada ajeno sin declarar», el otro control de la parte de skills del pre-commit: corre si el cambio toca
    # skills/ o agents/, no corre con uno de sólo documentación, y su rojo frena
    T3="scripts/publishing/third-party-coverage.js --repo $L16/src --skip-content"
    rc=$(lint16 "$L16/src" "skills/lab-skill/SKILL.md"); N_SI=$(veces "$T3")
    rc2=$(lint16 "$L16/src" "specs/story-lab.md"); N_NO=$(veces "third-party-coverage.js"); N_LINT=$(veces "scripts/lib/lint-story-frontmatter.js specs/story-lab.md")
    { [ "$rc" = 0 ] && [ "$N_SI" = 1 ] && [ "$rc2" = 0 ] && [ "$N_NO" = 0 ] && [ "$N_LINT" = 1 ]; } \
      && ok "V16d: el control de skills de terceros corre si el cambio toca skills/ y no corre con uno de sólo specs/ (que sí pasa por el lint de stories)" \
      || no "V16d: con skills/ rc=$rc llamadas=$N_SI · con specs/ rc=$rc2 llamadas=$N_NO lint=$N_LINT"
    rc=$(lint16 "$L16/src" "agents/lab-reviewer.md" "third-party-coverage.js" 1)
    { [ "$rc" = 1 ] && grep -q 'terceros' "$L16/lint.txt"; } \
      && ok "V16d: una skill ajena sin declarar frena el lint" || no "V16d (rojo): rc=$rc · $(tail -3 "$L16/lint.txt" | tr '\n' ' ')"
    # si git no puede decir qué trae el cambio (acá: la carpeta no es un repo), el control corre igual: nunca menos por no saber
    rc=$(lint16 "$L16/no-git" "specs/story-lab.md")
    [ "$(veces "third-party-coverage.js")" = 1 ] \
      && ok "V16d: si git no puede decir si el cambio trae un enlace simbólico, el control corre igual (falla hacia más trabajo)" \
      || no "V16d (git falla): el control no corrió (rc=$rc)"
    # un cambio que trae un enlace simbólico fuera de skills/ también lo dispara (así entra una skill ajena enlazada)
    ( cd "$L16/src" && unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE && ln -s a.txt lab-link && git add lab-link \
      && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -q -m "un enlace" ) || no "V16d: no pude commitear el enlace de juguete"
    rc=$(lint16 "$L16/src" "specs/story-lab.md")
    [ "$(veces "third-party-coverage.js")" = 1 ] \
      && ok "V16d: un cambio que trae un enlace simbólico dispara el control aunque no toque skills/" \
      || no "V16d (enlace): el control no corrió (rc=$rc)"

    # V16e — el primer par del freno de castellano es el del arnés y se sostiene solo: C-22 de githook-livefire.test.sh
    # lo saca del yml con este mismo corte y lo corre en un laboratorio
    PAR=$(awk '/spanish-names\.js --range/{p=1} p{print} p&&/falla /{exit}' "$YAML")
    { [ "$(printf '%s\n' "$PAR" | grep -c .)" = 2 ] && printf '%s\n' "$PAR" | sed -n 1p | grep -q -- '--source arnes' \
      && ! printf '%s\n' "$PAR" | grep -q 'agent-skills'; } \
      && ok "V16e: el primer par «spanish-names.js --range … / falla» es el de la fuente arnes, en dos líneas que se sostienen solas" \
      || no "V16e: el corte que usa githook-livefire C-22 ya no da el par del arnés: $(printf '%s' "$PAR" | tr '\n' '|' | cut -c1-200)"

    # V16f — el lint no llama al pre-commit (un hook en el servidor mira lo stageado: nada)
    grep -vE '^[[:space:]]*#' "$L16/lint.tpl" | grep -qE '\.githooks/pre-commit|core\.hooksPath' \
      && no "V16f: 🔴 el lint llama al pre-commit: en el servidor mira un índice vacío y sale verde sin haber mirado" \
      || ok "V16f: el lint no llama al pre-commit: sus controles son pasos del yml, con --range"
  fi
fi

# ── V17. PrPipeline_MovedFile_CountsAtBothPaths (pase adversarial del tramo 1 de la 8.18, hallazgo 12) ────────────
# La lista de archivos del cambio se armaba con `git diff --name-only`, y git detecta los renombres por defecto: un
# archivo MOVIDO aparecía sólo con su ruta de destino. Medido por el verificador con el paso real, sacado del yml:
# un pull request que hace `git mv skills/foo/SKILL.md guides/foo.md` dejaba `hayCodigo=no` —ni banco ni suites,
# contra el AC 15—, y mover algo fuera de una carpeta con `gate_only_when_touching` difería su suite. Con
# `--no-renames` salen la ruta vieja y la nueva, y lo que mira por ruta ve el cambio en la carpeta de la que salió.
# 🔴 El paso se corre de verdad, sacado del yml por su displayName, sobre un repo de juguete con su `origin` y una
#    rama de pull request. git va con la configuración AISLADA: un `diff.renames=false` del dev pondría esto en verde
#    sin haber medido nada.
if [ -f "$YAML" ]; then
  L17="$TMP/v17"; mkdir -p "$L17/tmp" "$L17/home"
  g17() { # git con el entorno limpio y la configuración de la máquina afuera
    ( unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE
      HOME="$L17/home" XDG_CONFIG_HOME="$L17/home/.config" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
        git -c user.email=t@t -c user.name=t -c commit.gpgsign=false "$@" )
  }
  # Saca un paso del yml por su displayName y le sustituye las macros de Azure. Lo que no es de la máquina de prueba sale
  # del entorno: `${{ parameters.runAll }}` → $RUN_ALL_TEST (False si no está) y `$(todoElRepo)` → $TODO_TEST (story 8.22).
  # El trabajo de suites (tramo D): `$(SUITES_SHARD)`/`$(SUITES_OF)` → $SUITES_SHARD_TEST/$SUITES_OF_TEST (1 si no están) y
  # `$(Pipeline.Workspace)` → <carpeta temporal>/workspace. `$(Build.SourcesDirectory)` es este checkout, o el de $3.
  # El paso se busca en el pipeline y en la plantilla de las suites (tramo I): en los dos archivos, uno tras otro.
  step_of_yaml() { # $1=displayName $2=carpeta temporal [$3=raíz de las fuentes]
    node -e '
    const fs = require("fs");
    const [file, template, display, tmp, sources] = process.argv.slice(1);
    const lines = [file, template].flatMap((f) => fs.readFileSync(f, "utf8").split("\n"));
    const at = lines.findIndex((l) => l.includes("displayName: \x27" + display + "\x27"));
    if (at < 0) process.exit(3);
    let start = -1;
    for (let i = at; i >= 0; i--) if (/^\s*-\s+script:\s*\|\s*$/.test(lines[i])) { start = i; break; }
    if (start < 0) process.exit(3);
    const body = lines.slice(start + 1, at);
    const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
    const subs = [["$(Agent.TempDirectory)", tmp], ["$(Build.SourceBranch)", "refs/heads/pr"], ["${{ parameters.runAll }}", "${RUN_ALL_TEST:-False}"],
      ["$(todoElRepo)", "${TODO_TEST}"], ["$(Build.SourcesDirectory)", sources], ["$(Build.ArtifactStagingDirectory)", tmp + "/staging"],
      ["${{ parameters.suiteShards }}", "2"], ["$(SUITES_SHARD)", "${SUITES_SHARD_TEST:-1}"], ["$(SUITES_OF)", "${SUITES_OF_TEST:-1}"],
      ["$(Pipeline.Workspace)", tmp + "/workspace"]];
    let text = body.map((l) => l.slice(indent)).join("\n");
    for (const [from, to] of subs) text = text.split(from).join(to);
    // una macro dentro de un comentario del paso no corre (el paso explica ahí por qué NO usa `$(System.PullRequest…)`)
    const live = text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    const left = live.match(/\$\([A-Za-z]+\.[A-Za-z.]+\)|\$\([a-z][A-Za-z]+\)|\$\{\{[^}]*\}\}/g);
    if (left) { process.stderr.write("macros sin sustituir: " + [...new Set(left)].join(" ") + "\n"); process.exit(4); }
    process.stdout.write(text + "\n");
  ' "$YAML" "$SUITES_TEMPLATE" "$1" "$2" "${3:-$AQUI}"
  }
  step_of_yaml 'Qué trae este cambio' "$L17/tmp" > "$L17/step.sh" 2> "$L17/extract.err"; RC17=$?
  if [ "$RC17" != 0 ] || [ ! -s "$L17/step.sh" ]; then
    no "V17: no pude sacar el paso «Qué trae este cambio» del yml (código $RC17): $(cat "$L17/extract.err")"
  else
    pr17() { # $1=nombre del caso; resto = el comando de git que arma la rama del pull request → deja el repo en $L17/<nombre>
      local name="$1"; shift
      local W="$L17/$name"
      g17 init -q --bare -b main "$L17/$name-origin.git" && g17 init -q -b main "$W" || return 1
      mkdir -p "$W/skills/lab-skill" "$W/guides" "$W/scripts/lab-pub"
      printf -- '---\nname: lab-skill\n---\n# Skill de laboratorio\n\nuno\ndos\ntres\ncuatro\ncinco\n' > "$W/skills/lab-skill/SKILL.md"
      printf "'use strict';\n// herramienta de laboratorio\nfunction run() { return 1; }\nmodule.exports = { run };\n// a\n// b\n// c\n" > "$W/scripts/lab-pub/lab-tool.js"
      printf '# una guía\n\nuno\ndos\ntres\ncuatro\ncinco\n' > "$W/guides/lab.md"
      g17 -C "$W" remote add origin "$L17/$name-origin.git" && g17 -C "$W" add -A && g17 -C "$W" commit -q -m base \
        && g17 -C "$W" push -q origin main && g17 -C "$W" checkout -q -b pr && g17 -C "$W" "$@" && g17 -C "$W" commit -q -m cambio
    }
    step17() { # $1=nombre del caso → corre el paso en ese repo; deja la salida en step.txt y la lista en tmp/cambiados.txt
      rm -f "$L17/tmp/cambiados.txt"
      ( cd "$L17/$1" && unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE \
        && HOME="$L17/home" XDG_CONFIG_HOME="$L17/home/.config" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
           SYSTEM_PULLREQUEST_TARGETBRANCH=refs/heads/main bash "$L17/step.sh" ) > "$L17/step.txt" 2>&1
    }
    code17() { grep -o 'variable=hayCodigo\][a-z]*' "$L17/step.txt" | sed 's/.*\]//'; }
    list17() { tr '\n' ' ' < "$L17/tmp/cambiados.txt" 2>/dev/null; }

    # V17a — mover un archivo de skills/ a una carpeta de documentación: cuenta como código, y la lista trae las dos rutas
    if pr17 moved-out mv skills/lab-skill/SKILL.md guides/lab-skill.md > "$L17/arm.txt" 2>&1; then
      step17 moved-out
      { [ "$(code17)" = si ] && grep -qx 'skills/lab-skill/SKILL.md' "$L17/tmp/cambiados.txt" && grep -qx 'guides/lab-skill.md' "$L17/tmp/cambiados.txt" \
        && grep -q 'todoElRepo\]no' "$L17/step.txt"; } \
        && ok "V17a: 🔴 un pull request que MUEVE un archivo de skills/ a guides/ cuenta como código: la lista trae la ruta vieja y la nueva" \
        || no "V17a: hayCodigo=$(code17) · lista: $(list17) · $(tail -2 "$L17/step.txt" | tr '\n' ' ')"
    else
      no "V17a: NO MEDIDO — no pude armar el repo de juguete: $(tr '\n' ' ' < "$L17/arm.txt" | cut -c1-200)"
    fi

    # V17b — (espejo) mover documentación dentro de documentación sigue sin ser código; y (control) borrar de skills/ sí lo es
    if pr17 moved-docs mv guides/lab.md guides/lab-renamed.md > "$L17/arm.txt" 2>&1 && pr17 removed rm -q skills/lab-skill/SKILL.md >> "$L17/arm.txt" 2>&1; then
      step17 moved-docs; DOCS17="$(code17)"; DOCS_LIST17="$(list17)"
      step17 removed; RM17="$(code17)"
      { [ "$DOCS17" = no ] && [ "$DOCS_LIST17" = "guides/lab-renamed.md guides/lab.md " ] && [ "$RM17" = si ]; } \
        && ok "V17b: (espejo) mover una guía a otra guía no es código (y la lista trae las dos rutas); (control) borrar un archivo de skills/ sí" \
        || no "V17b: mover documentación → hayCodigo=$DOCS17 (lista: $DOCS_LIST17) · borrar de skills/ → hayCodigo=$RM17"
    else
      no "V17b: NO MEDIDO — no pude armar los repos de juguete: $(tr '\n' ' ' < "$L17/arm.txt" | cut -c1-200)"
    fi

    # V17f — 2026-10-06 (orden del dueño): (a) una rama validada A MANO (sin pull request) se compara contra main con la
    # rama ENTERA, no corre todo; (b) un .md no es código, también bajo scripts/; (c) salvo en skills/, agents/ y packs/.
    step17m() { # como step17, pero corrida a mano: sin rama destino
      rm -f "$L17/tmp/cambiados.txt"
      ( cd "$L17/$1" && unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE SYSTEM_PULLREQUEST_TARGETBRANCH \
        && HOME="$L17/home" XDG_CONFIG_HOME="$L17/home/.config" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
           bash "$L17/step.sh" ) > "$L17/step.txt" 2>&1
    }
    base17() { # $1=nombre → el repo de juguete de pr17, en la rama pr y sin commit propio todavía
      local W="$L17/$1"
      g17 init -q --bare -b main "$L17/$1-origin.git" && g17 init -q -b main "$W" || return 1
      mkdir -p "$W/skills/lab-skill" "$W/guides" "$W/scripts/lab-pub"
      printf -- "---\nname: lab-skill\n---\n# Skill\n" > "$W/skills/lab-skill/SKILL.md"
      printf "// herramienta\n" > "$W/scripts/lab-pub/lab-tool.js"
      printf "# guía\n" > "$W/guides/lab.md"
      g17 -C "$W" remote add origin "$L17/$1-origin.git" && g17 -C "$W" add -A && g17 -C "$W" commit -q -m base \
        && g17 -C "$W" push -q origin main && g17 -C "$W" checkout -q -b pr
    }
    if { base17 manual-md && printf "# dev\n" > "$L17/manual-md/guides/dev.md" && mkdir -p "$L17/manual-md/scripts/publishing/public-files" \
        && printf "# x\n" > "$L17/manual-md/scripts/publishing/public-files/x.md" && g17 -C "$L17/manual-md" add -A && g17 -C "$L17/manual-md" commit -q -m md \
      && base17 manual-two && printf "// cambio\n" >> "$L17/manual-two/scripts/lab-pub/lab-tool.js" && g17 -C "$L17/manual-two" commit -q -am uno \
        && printf "# otra\n" > "$L17/manual-two/guides/otra.md" && g17 -C "$L17/manual-two" add -A && g17 -C "$L17/manual-two" commit -q -m dos \
      && base17 manual-skill && printf "seis\n" >> "$L17/manual-skill/skills/lab-skill/SKILL.md" && g17 -C "$L17/manual-skill" commit -q -am skill; } > "$L17/arm.txt" 2>&1; then
      step17m manual-md; MD17="$(code17)"; MDTODO17="$(grep -o 'todoElRepo\][a-z]*' "$L17/step.txt" | sed 's/.*\]//')"
      step17m manual-two; TWO17="$(code17)"; TWO_LIST17="$(list17)"
      step17m manual-skill; SKILL17="$(code17)"
      { [ "$MD17" = no ] && [ "$MDTODO17" = no ] && [ "$TWO17" = si ] && [ "$TWO_LIST17" = "guides/otra.md scripts/lab-pub/lab-tool.js " ] && [ "$SKILL17" = si ]; } \
        && ok "V17f: corrida a mano sobre una rama: se compara la rama entera contra main (no corre todo); .md (también bajo scripts/) no es código; un SKILL.md sí" \
        || no "V17f: .md → hayCodigo=$MD17 todo=$MDTODO17 · rama con el cambio en un commit anterior → hayCodigo=$TWO17 (lista: $TWO_LIST17) · SKILL.md → hayCodigo=$SKILL17 · $(tail -2 "$L17/step.txt" | tr '\n' ' ')"
    else
      no "V17f: NO MEDIDO — no pude armar los repos de juguete: $(tr '\n' ' ' < "$L17/arm.txt" | cut -c1-200)"
    fi

    # V17c — lo que mira por ruta: una suite con `gate_only_when_touching` sobre la carpeta de la que SALIÓ el archivo corre
    SK17="$(node "$AQUI/scripts/lib/skills-dir.js" --skills 2> "$L17/sk.err")" || SK17=""
    if [ -z "$SK17" ] || [ ! -f "$SK17/tycon-pipeline/scripts/lib/touched-files.js" ]; then
      no "V17c: NO MEDIDO — sin la regla del portón de las stories (touched-files.js) no hay con qué medirlo: $(cat "$L17/sk.err")"
    elif pr17 moved-gated mv scripts/lab-pub/lab-tool.js guides/lab-tool.md > "$L17/arm.txt" 2>&1; then
      step17 moved-gated
      mkdir -p "$L17/gated/tests"; echo 'exit 0' > "$L17/gated/tests/lab-pub.test.sh"
      echo '{"diarias":[{"raiz":"arnes","ruta":"tests/lab-pub.test.sh","gate_only_when_touching":["scripts/lab-pub/**"]}]}' > "$L17/gated/suites.json"
      node "$AQUI/scripts/ci/suites-for-change.js" --suites "$L17/gated/suites.json" --scripts "$L17/gated" --skills "$SK17" \
        --changed "$L17/tmp/cambiados.txt" > "$L17/plan.txt" 2> "$L17/plan.err"; RCP=$?
      # (espejo) con la lista de un cambio que no pasa por esa carpeta, la misma suite se difiere: el plan sí mira el gate
      printf 'guides/lab.md\n' > "$L17/other.txt"
      node "$AQUI/scripts/ci/suites-for-change.js" --suites "$L17/gated/suites.json" --scripts "$L17/gated" --skills "$SK17" \
        --changed "$L17/other.txt" > "$L17/plan-other.txt" 2>> "$L17/plan.err"
      { [ "$RCP" = 0 ] && [ "$(code17)" = si ] && grep -q '^RUN.*lab-pub\.test\.sh' "$L17/plan.txt" && grep -q '^SKIP.*lab-pub\.test\.sh' "$L17/plan-other.txt"; } \
        && ok "V17c: mover un archivo FUERA de una carpeta vigilada no difiere su suite (y, espejo, un cambio que no pasa por ahí sí la difiere)" \
        || no "V17c: rc=$RCP hayCodigo=$(code17) · plan: $(tr '\n\t' '| ' < "$L17/plan.txt") · espejo: $(tr '\n\t' '| ' < "$L17/plan-other.txt") · $(tr '\n' ' ' < "$L17/plan.err" | cut -c1-200)"
    else
      no "V17c: NO MEDIDO — no pude armar el repo de juguete: $(tr '\n' ' ' < "$L17/arm.txt" | cut -c1-200)"
    fi

    # V17g — (story 8.22, AC 3) lo que vino de main con un merge no cuenta: la rama a mano trae un merge de main con
    # scripts/hooks/z.js, y la lista tiene lo de la rama y no z.js
    if { base17 merged-main && printf "// cambio\n" >> "$L17/merged-main/scripts/lab-pub/lab-tool.js" && g17 -C "$L17/merged-main" commit -q -am rama \
        && g17 -C "$L17/merged-main" checkout -q main && mkdir -p "$L17/merged-main/scripts/hooks" && printf "// de main\n" > "$L17/merged-main/scripts/hooks/z.js" \
        && g17 -C "$L17/merged-main" add -A && g17 -C "$L17/merged-main" commit -q -m main && g17 -C "$L17/merged-main" push -q origin main \
        && g17 -C "$L17/merged-main" checkout -q pr && g17 -C "$L17/merged-main" merge -q --no-edit main; } > "$L17/arm.txt" 2>&1; then
      step17m merged-main
      { [ "$(code17)" = si ] && [ "$(list17)" = "scripts/lab-pub/lab-tool.js " ]; } \
        && ok "V17g: rama a mano con un merge de main: lo que vino de main (scripts/hooks/z.js) no cuenta; lo de la rama sí" \
        || no "V17g: hayCodigo=$(code17) · lista: $(list17) · $(tail -2 "$L17/step.txt" | tr '\n' ' ')"
    else
      no "V17g: NO MEDIDO — no pude armar el repo de juguete: $(tr '\n' ' ' < "$L17/arm.txt" | cut -c1-200)"
    fi

    # V17h — (story 8.22, AC 5) dos conductas que se conservan: (a) si el fetch de origin/main falla, se usa el origin/main
    # del checkout y se avisa; (b) una rama sin commits propios da una lista vacía: sólo lint
    if { base17 fetch-fails && printf "// cambio\n" >> "$L17/fetch-fails/scripts/lab-pub/lab-tool.js" && g17 -C "$L17/fetch-fails" commit -q -am rama \
        && g17 -C "$L17/fetch-fails" remote set-url origin "$L17/no-existe.git" && base17 empty-branch; } > "$L17/arm.txt" 2>&1; then
      step17m fetch-fails; FF17="$(code17)"; FF_LIST17="$(list17)"; FF_WARN17="$(grep -c 'No se pudo traer origin/main' "$L17/step.txt")"
      FF_TODO17="$(grep -o 'todoElRepo\][a-z]*' "$L17/step.txt" | sed 's/.*\]//')"
      step17m empty-branch; EMPTY17="$(code17)"; EMPTY_LIST17="$(list17)"
      { [ "$FF17" = si ] && [ "$FF_LIST17" = "scripts/lab-pub/lab-tool.js " ] && [ "$FF_WARN17" -ge 1 ] && [ "$FF_TODO17" = no ] \
        && [ "$EMPTY17" = no ] && [ -z "$EMPTY_LIST17" ]; } \
        && ok "V17h: el fetch que falla usa el origin/main del checkout y avisa; una rama sin commits propios es sólo lint" \
        || no "V17h: fetch que falla → hayCodigo=$FF17 todo=$FF_TODO17 aviso=$FF_WARN17 lista: $FF_LIST17 · rama vacía → hayCodigo=$EMPTY17 lista: $EMPTY_LIST17"
    else
      no "V17h: NO MEDIDO — no pude armar los repos de juguete: $(tr '\n' ' ' < "$L17/arm.txt" | cut -c1-200)"
    fi

    # V17k — T12 de la story 8.26, tanda C (AC 12): con un repo de GitHub como propio, el cambio se compara contra main de
    # GitHub (el origin del checkout); si main no se puede alcanzar —ni traer ni estaba en el checkout—, corre TODO: falla
    # hacia más trabajo. Los dos caminos: la rama a mano y el pedido (rama destino main).
    step17gh() { # $1=caso $2=rama destino ("" = a mano) → el paso con el proveedor GitHub
      rm -f "$L17/tmp/cambiados.txt"
      ( cd "$L17/$1" && unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE \
        && HOME="$L17/home" XDG_CONFIG_HOME="$L17/home/.config" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
           BUILD_REPOSITORY_PROVIDER=GitHub SYSTEM_PULLREQUEST_TARGETBRANCH="$2" bash "$L17/step.sh" ) > "$L17/step.txt" 2>&1
    }
    todo17() { grep -o 'todoElRepo\][a-z]*' "$L17/step.txt" | sed 's/.*\]//'; }
    if { base17 gh-no-main && printf "// cambio\n" >> "$L17/gh-no-main/scripts/lab-pub/lab-tool.js" && g17 -C "$L17/gh-no-main" commit -q -am rama \
        && g17 -C "$L17/gh-no-main" remote set-url origin "$L17/no-existe.git" && g17 -C "$L17/gh-no-main" update-ref -d refs/remotes/origin/main \
      && base17 gh-ok && printf "// cambio\n" >> "$L17/gh-ok/scripts/lab-pub/lab-tool.js" && g17 -C "$L17/gh-ok" commit -q -am rama; } > "$L17/arm.txt" 2>&1; then
      step17gh gh-no-main ""; GH_MANUAL17="$(todo17)"
      step17gh gh-no-main "refs/heads/main"; GH_PR17="$(todo17)"; GH_PR_WARN17="$(grep -c 'No se pudo acotar el cambio' "$L17/step.txt")"
      step17gh gh-ok "refs/heads/main"; GH_OK17="$(todo17)"; GH_OK_LIST17="$(list17)"
      { [ "$GH_MANUAL17" = si ] && [ "$GH_PR17" = si ] && [ "$GH_PR_WARN17" -ge 1 ] && [ "$GH_OK17" = no ] && [ "$GH_OK_LIST17" = "scripts/lab-pub/lab-tool.js " ]; } \
        && ok "V17k (T12): con GitHub como propio, sin main alcanzable corre todo (a mano y por pedido); con main, se compara la rama contra main" \
        || no "V17k (T12): a mano sin main → todo=$GH_MANUAL17 · pedido sin main → todo=$GH_PR17 aviso=$GH_PR_WARN17 · pedido con main → todo=$GH_OK17 lista: $GH_OK_LIST17"
    else
      no "V17k (T12): NO MEDIDO — no pude armar los repos de juguete: $(tr '\n' ' ' < "$L17/arm.txt" | cut -c1-200)"
    fi

    # V17j — (pase adversarial del tramo B de la 8.22) (a) una ruta con letras no ASCII sale tal cual en la lista: con la
    # configuración de fábrica de git (`core.quotePath`) salía entre comillas y con escapes octales, y con --deps no
    # coincidía con nada de lo que usan las suites; (b) la lista de código no repite lo de skills/ (salía dos veces)
    if { base17 non-ascii && mkdir -p "$L17/non-ascii/scripts/lab-pub" && printf "// año\n" > "$L17/non-ascii/scripts/lab-pub/año.js" \
        && printf "// otra\n" >> "$L17/non-ascii/skills/lab-skill/SKILL.md" && mkdir -p "$L17/non-ascii/skills/lab-skill/scripts" \
        && printf "// x\n" > "$L17/non-ascii/skills/lab-skill/scripts/x.js" && g17 -C "$L17/non-ascii" add -A && g17 -C "$L17/non-ascii" commit -q -m uno; } > "$L17/arm.txt" 2>&1; then
      step17m non-ascii
      DUP17="$(sort "$L17/tmp/cambiados-codigo.txt" 2>/dev/null | uniq -d | tr '\n' ' ')"
      { grep -qx 'scripts/lab-pub/año.js' "$L17/tmp/cambiados.txt" && grep -qx 'scripts/lab-pub/año.js' "$L17/tmp/cambiados-codigo.txt" \
        && [ -z "$DUP17" ] && [ "$(grep -c . "$L17/tmp/cambiados-codigo.txt")" = 3 ]; } \
        && ok "V17j: una ruta con «ñ» sale tal cual en las dos listas, y la lista de código no repite lo de skills/" \
        || no "V17j: lista: $(list17) · código: $(tr '\n' ' ' < "$L17/tmp/cambiados-codigo.txt" 2>/dev/null) · repetidos: «${DUP17}»"
    else
      no "V17j: NO MEDIDO — no pude armar el repo de juguete: $(tr '\n' ' ' < "$L17/arm.txt" | cut -c1-200)"
    fi

    # V17d — (story 8.22, AC 4) sin último commit: el yml no tiene ningún `HEAD^1` fuera de los comentarios, y el paso
    # «Qué suites corren», sacado del yml, con `todoElRepo=si` y sin pull request corre TODAS, sin `--changed`, con el
    # motivo de «Qué trae este cambio». 🔴 Rojo previo: caía a `git diff HEAD^1 HEAD` (el último commit).
    HEAD17="$(grep -vE '^[[:space:]]*#' "$YAML" | grep -c 'HEAD^1')"
    TOTAL17="$(node -e 'const s=require(process.argv[1]);console.log([...(s.diarias||[]),...(s.semanales||[])].filter((x)=>x&&typeof x.ruta==="string").length)' "$AQUI/scripts/tests/suites.json")"
    suites17() { # $1=todoElRepo $2=motivo → corre el paso de las suites en el checkout; deja la salida en suites.txt
      rm -rf "$L17/tmp/staging"
      ( cd "$AQUI" && unset SYSTEM_PULLREQUEST_TARGETBRANCH && TODO_TEST="$1" MOTIVOTODO="$2" bash "$L17/suites-step.sh" ) > "$L17/suites.txt" 2>&1
    }
    if ! step_of_yaml 'Qué suites corren' "$L17/tmp" > "$L17/suites-step.sh" 2> "$L17/extract-s.err"; then
      no "V17d: no pude sacar el paso «Qué suites corren» del yml: $(cat "$L17/extract-s.err")"
    else
      suites17 si 'corrida de main a mano: no hay rama destino contra la cual comparar'; RCS17=$?
      RUN17="$(grep -c . "$L17/tmp/staging/suites-plan/run.txt" 2>/dev/null || echo 0)"
      { [ "$HEAD17" = 0 ] && [ "$RCS17" = 0 ] && [ "$RUN17" = "$TOTAL17" ] && ! grep -q '^⏭' "$L17/suites.txt" \
        && grep -q 'corren todas — corrida de main a mano' "$L17/suites.txt"; } \
        && ok "V17d: sin último commit: ningún HEAD^1 en el yml; con todoElRepo=si corren las $TOTAL17 suites, con el motivo" \
        || no "V17d: HEAD^1 fuera de comentarios=$HEAD17 · rc=$RCS17 · corren $RUN17 de $TOTAL17 · $(tail -3 "$L17/suites.txt" | tr '\n' ' ' | cut -c1-300)"
    fi

    # V17i — (story 8.22, AC 6) el parámetro runAll: una rama a mano de un archivo con runAll=true corre todo, y el
    # registro dice «pedido a mano: corre todo». 🔴 Rojo previo: no había parámetro.
    if base17 run-all > "$L17/arm.txt" 2>&1 && printf "// cambio\n" >> "$L17/run-all/scripts/lab-pub/lab-tool.js" && g17 -C "$L17/run-all" commit -q -am uno >> "$L17/arm.txt" 2>&1; then
      RUN_ALL_TEST=True step17m run-all; RA_CODE17="$(code17)"
      RA_TODO17="$(grep -o 'todoElRepo\][a-z]*' "$L17/step.txt" | sed 's/.*\]//')"
      RA_MOT17="$(grep -o 'motivoTodo\].*' "$L17/step.txt" | sed 's/^motivoTodo\]//' | head -1)"
      if [ -s "$L17/suites-step.sh" ]; then suites17 "$RA_TODO17" "$RA_MOT17"; fi
      RA_RUN17="$(grep -c . "$L17/tmp/staging/suites-plan/run.txt" 2>/dev/null || echo 0)"
      { [ "$RA_CODE17" = si ] && [ "$RA_TODO17" = si ] && [ "$RA_MOT17" = 'pedido a mano: corre todo' ] && [ "$RA_RUN17" = "$TOTAL17" ] \
        && grep -q 'pedido a mano: corre todo' "$L17/suites.txt"; } \
        && ok "V17i: runAll=true en una rama de un archivo corre las $TOTAL17 suites y el registro dice «pedido a mano: corre todo»" \
        || no "V17i: hayCodigo=$RA_CODE17 todo=$RA_TODO17 motivo=«${RA_MOT17}» · corren $RA_RUN17 de $TOTAL17 · $(tail -2 "$L17/suites.txt" | tr '\n' ' ' | cut -c1-200)"
      # (espejo) sin runAll, la misma rama no corre todo
      step17m run-all
      grep -q 'todoElRepo\]no' "$L17/step.txt" \
        && ok "V17i: (espejo) sin runAll, la misma rama se compara contra main y no corre todo" \
        || no "V17i: sin runAll la rama dejó $(grep -o 'todoElRepo\][a-z]*' "$L17/step.txt")"
    else
      no "V17i: NO MEDIDO — no pude armar el repo de juguete: $(tr '\n' ' ' < "$L17/arm.txt" | cut -c1-200)"
    fi
  fi

  # V18 — (story 8.22, tramo D, AC 16-17) el tope de cada suite y los reintentos con cabeza. El paso «Correr las suites de
  # este trabajo», sacado del yml, corre en un repo de juguete con `origin/main` (ahí vive la foto nocturna) y copias de
  # los guiones que llama. Cuatro suites de juguete: una que duerme 30 s (su tope, por el piso de juguete, es de 2 s), una
  # verde, una roja que anoche ya estaba roja y una roja nueva; las rojas anotan cada pasada en un archivo.
  # 🔴 Rojo previo: sin tope, la dormida se come 30 s dos veces; y toda roja se reintenta.
  L18="$TMP/v18"; mkdir -p "$L18"
  toy18() { # $1=la foto nocturna de origin/main, en JSON ("" = sin foto) → deja el repo en $L18/repo y el paso en $L18/step.sh
    local W="$L18/repo"
    rm -rf "$W" "$L18/origin.git" "$L18/tmp" "$L18"/passes-*; mkdir -p "$L18/tmp"
    g17 init -q --bare -b main "$L18/origin.git" && g17 init -q -b main "$W" || return 1
    mkdir -p "$W/scripts/ci" "$W/scripts/lib" "$W/scripts/tests" "$W/scripts/controls-bench" "$W/as/skills"
    cp "$AQUI/scripts/ci/suites-shard.js" "$AQUI/scripts/ci/suites-exclusive.js" "$AQUI/scripts/ci/run-capped.js" "$AQUI/scripts/ci/suites-block.js" "$W/scripts/ci/" || return 1
    cp "$AQUI/scripts/lib/skills-dir.js" "$W/scripts/lib/" || return 1
    printf '{"diarias":[{"raiz":"arnes","ruta":"tests/sleeper.test.sh"},{"raiz":"arnes","ruta":"tests/green.test.sh"},{"raiz":"arnes","ruta":"tests/red-old.test.sh"},{"raiz":"arnes","ruta":"tests/red-new.test.sh"}]}\n' > "$W/scripts/tests/suites.json"
    printf '{"default":1,"weights":{},"pr":{"runs":[1],"default":1,"job_budget":100,"suite_cap":{"factor":2,"floor":2},"weights":{}}}\n' > "$W/scripts/ci/suites-weights.json"
    printf 'sleep 30\necho despierta\n' > "$W/scripts/tests/sleeper.test.sh"
    printf 'echo bien\n' > "$W/scripts/tests/green.test.sh"
    for s in red-old red-new; do printf 'echo pasada >> "%s"\necho "MAL — %s"\nexit 1\n' "$L18/passes-$s" "$s" > "$W/scripts/tests/$s.test.sh"; done
    # Story 8.26, tanda C (AC 43): la foto es la que trajo `Validar` (fetch-snapshot.yml), en la carpeta temporal, no la
    # del checkout. El checkout trae una foto VIEJA a propósito, distinta: si el paso la leyera, V18g lo vería.
    mkdir -p "$L18/tmp/snapshot"
    [ -n "$1" ] && printf '%s\n' "$1" > "$L18/tmp/snapshot/nightly-suites.json"
    printf '{"kind":"bash-tests","ts":"2026-10-01T00:00:00Z","failures":["red-new.test.sh"],"complete":true}\n' > "$W/scripts/controls-bench/ultimo-suites.json"
    g17 -C "$W" remote add origin "$L18/origin.git" && g17 -C "$W" add -A && g17 -C "$W" commit -q -m base \
      && g17 -C "$W" push -q origin main && g17 -C "$W" fetch -q origin || return 1
    mkdir -p "$L18/tmp/workspace/suites-plan/suites-plan-a1"
    printf 'sleeper.test.sh\ngreen.test.sh\nred-old.test.sh\nred-new.test.sh\n' > "$L18/tmp/workspace/suites-plan/suites-plan-a1/run.txt"
    step_of_yaml 'Correr las suites de este trabajo' "$L18/tmp" "$W" > "$L18/step.sh"
  }
  run18() { # [VAR=valor…] → corre el paso; deja la salida en $L18/out.txt y los segundos que tardó en $L18/secs
    local t0; t0=$(date +%s)
    ( cd "$L18/repo" && unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE SUITES_NO_RETRY_AFTER HARNESS_SUITES_BLOCK BUILD_REPOSITORY_PROVIDER \
      && env HOME="$L17/home" XDG_CONFIG_HOME="$L17/home/.config" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
         TYCON_SKILLS_DIR="$L18/repo/as" SUITES_JOBS=2 "$@" bash "$L18/step.sh" ) > "$L18/out.txt" 2>&1
    echo $(( $(date +%s) - t0 )) > "$L18/secs"
  }
  passes18() { grep -c . "$L18/passes-$1" 2>/dev/null || echo 0; }
  SH18="$L18/tmp/staging/suites-shard"
  FOTO18='{"kind":"bash-tests","ts":"2026-10-06T00:00:00Z","failures":["red-old.test.sh","red-new.test.sh(ausente)","green.test.sh(no-medida)"],"complete":true}'
  if toy18 "$FOTO18" > "$L18/arm.txt" 2>&1 && [ -s "$L18/step.sh" ]; then
    run18; RC18=$?; SECS18="$(cat "$L18/secs")"
    # T21 — PrSuites_SuiteOverItsCap_NotMeasuredAndJobGoesOn
    { grep -q '⏳ sleeper.test.sh — NO se midió: pasó el tope de 2 s' "$L18/out.txt" && grep -q '^✅ green.test.sh' "$L18/out.txt" \
      && grep -qx 'sleeper.test.sh(no-medida)' "$SH18/failures.txt" && grep -q 'pasó el tope de 2 s' "$SH18/red-output/sleeper.test.sh(no-medida).txt" \
      && [ -f "$SH18/finished" ] && [ "$SECS18" -lt 20 ] && ! grep -q 'sleeper.test.sh (1ª pasada)' "$L18/out.txt" \
      && [ "$(sort "$SH18/done.txt" 2>/dev/null | tr '\n' ' ')" = 'green.test.sh red-new.test.sh red-old.test.sh sleeper.test.sh ' ]; } \
      && ok "V18a (T21): la suite que pasa su tope se corta a los 2 s, sale «NO se midió» sin reintento y el trabajo sigue (${SECS18} s)" \
      || no "V18a (T21): rc=$RC18 · ${SECS18} s · fallas: $(tr '\n' ' ' < "$SH18/failures.txt" 2>/dev/null) · $(grep -E 'sleeper|green|tope' "$L18/out.txt" | tr '\n' ' ' | cut -c1-300)"
    # T22 — PrSuites_RedInNightly_NotRetried
    { [ "$(passes18 red-old)" = 1 ] && grep -q 'red-old.test.sh — roja también en el nocturno: no se reintenta' "$L18/out.txt" \
      && grep -qx 'red-old.test.sh' "$SH18/failures.txt" && [ -s "$SH18/red-output/red-old.test.sh.txt" ] \
      && node -e 'const r=require(process.argv[1]);process.exit(r["red-old.test.sh"]===undefined?0:1)' "$SH18/retries.json"; } \
      && ok "V18b (T22): la roja que anoche ya estaba roja corre una sola vez, con el motivo, y no entra en las dos pasadas" \
      || no "V18b (T22): pasadas=$(passes18 red-old) · $(grep 'red-old' "$L18/out.txt" | tr '\n' ' ' | cut -c1-200) · retries: $(tr -d '\n ' < "$SH18/retries.json" 2>/dev/null)"
    # T23 (antes del límite) — una entrada con marca en la foto («(ausente)») no excusa: la roja nueva se reintenta.
    { [ "$(passes18 red-new)" = 2 ] && grep -q 'red-new.test.sh (1ª pasada) — se reintenta una vez' "$L18/out.txt" \
      && node -e 'const r=require(process.argv[1]);process.exit(r["red-new.test.sh"]&&r["red-new.test.sh"].segunda==="rojo"?0:1)' "$SH18/retries.json"; } \
      && ok "V18c (T23): antes del límite, la roja nueva se reintenta una vez (la marca «(ausente)» de anoche no la excusa)" \
      || no "V18c (T23): pasadas=$(passes18 red-new) · $(grep 'red-new' "$L18/out.txt" | tr '\n' ' ' | cut -c1-200)"
    # T23 — PrSuites_JobPastLimit_NotRetried (con el freno de suites APAGADO: la 170, sin el interruptor)
    rm -f "$L18"/passes-*; run18 SUITES_NO_RETRY_AFTER=0
    { [ "$(passes18 red-new)" = 1 ] && grep -qE 'red-new.test.sh — el trabajo ya va [0-9]+ min: no se reintenta' "$L18/out.txt" \
      && grep -qx 'red-new.test.sh' "$SH18/failures.txt"; } \
      && ok "V18d (T23): con el freno apagado y las suites pasadas del límite, la roja nueva corre una sola vez y lo dice" \
      || no "V18d (T23): pasadas=$(passes18 red-new) · $(grep 'red-new' "$L18/out.txt" | tr '\n' ' ' | cut -c1-200)"
    # V18h — story 8.26, tanda C (AC 14): con el freno PRENDIDO una roja nueva frena el pedido, así que tiene su segunda
    # pasada aunque el trabajo vaya tarde. En la medición de la tanda, el freno falso de harness-plan.test.sh fue
    # justamente eso, tres veces: roja al final de un trabajo largo, sin reintento. Prendido por el interruptor, y por el
    # proveedor GitHub sin interruptor (falla cerrado).
    rm -f "$L18"/passes-*; run18 SUITES_NO_RETRY_AFTER=0 HARNESS_SUITES_BLOCK=1
    H1="$(passes18 red-new)"
    rm -f "$L18"/passes-*; run18 SUITES_NO_RETRY_AFTER=0 BUILD_REPOSITORY_PROVIDER=GitHub
    H2="$(passes18 red-new)"
    { [ "$H1" = 2 ] && [ "$H2" = 2 ] && [ "$(passes18 red-old)" = 1 ]; } \
      && ok "V18h: con el freno prendido (interruptor, o GitHub sin interruptor) la roja nueva tardía se reintenta; la de anoche, no" \
      || no "V18h: pasadas con el interruptor=$H1, con GitHub=$H2, red-old=$(passes18 red-old) · $(grep -E 'red-new|freno' "$L18/out.txt" | tr '\n' ' ' | cut -c1-240)"
    # Un límite mal escrito no apaga los reintentos: avisa y usa 600 s (revisor de pruebas, tramo D).
    rm -f "$L18"/passes-*; run18 SUITES_NO_RETRY_AFTER=diez
    { [ "$(passes18 red-new)" = 2 ] && grep -q 'SUITES_NO_RETRY_AFTER no es un número de segundos — uso 600' "$L18/out.txt" && grep -q '«diez»' "$L18/out.txt"; } \
      && ok "V18f: un SUITES_NO_RETRY_AFTER que no es un número avisa y usa 600 s: la roja nueva se reintenta" \
      || no "V18f: pasadas=$(passes18 red-new) · $(grep -E 'RETRY|red-new' "$L18/out.txt" | tr '\n' ' ' | cut -c1-200)"
    # (pase adversarial del tramo D; story 8.26, tanda C, AC 43) manda la foto que bajó el trabajo —la misma con la que
    # el veredicto perdona—, nunca la del checkout: el checkout de juguete trae red-new roja y aun así red-new se
    # reintentó arriba (V18c); y si la foto bajada no trae red-old, red-old se reintenta.
    printf '{"kind":"bash-tests","ts":"2026-10-06T00:00:00Z","failures":[],"complete":true}\n' > "$L18/tmp/snapshot/nightly-suites.json"
    rm -f "$L18"/passes-*; run18
    [ "$(passes18 red-old)" = 2 ] \
      && ok "V18g: la foto que manda es la bajada (la del veredicto), no la del checkout: la roja que la foto no trae se reintenta" \
      || no "V18g: pasadas=$(passes18 red-old) · $(grep -E 'foto|red-old' "$L18/out.txt" | tr '\n' ' ' | cut -c1-200)"
  else
    no "V18 (T21-T23): NO MEDIDO — no pude armar el repo de juguete o sacar el paso: $(tr '\n' ' ' < "$L18/arm.txt" | cut -c1-200)"
  fi
  # (espejo de T22) sin foto que leer en origin/main, se reintenta como siempre y se avisa.
  if toy18 "" > "$L18/arm.txt" 2>&1 && [ -s "$L18/step.sh" ]; then
    run18
    { [ "$(passes18 red-old)" = 2 ] && grep -q 'no pude leer la foto nocturna' "$L18/out.txt"; } \
      && ok "V18e: (espejo) sin foto nocturna legible, la roja se reintenta como siempre y se avisa" \
      || no "V18e: pasadas=$(passes18 red-old) · $(grep -E 'foto|red-old' "$L18/out.txt" | tr '\n' ' ' | cut -c1-200)"
  else
    no "V18e: NO MEDIDO — no pude armar el repo de juguete: $(tr '\n' ' ' < "$L18/arm.txt" | cut -c1-200)"
  fi

  # V17e — ningún `git diff --name-only` de los yml arma una lista sin `--no-renames` (los sitios de hoy y los que vengan).
  # Story 8.22: sin el último commit queda uno solo (el de «Qué trae este cambio»); se pide al menos 1. Y cada uno con
  # `core.quotePath=false` (pase adversarial del tramo B): sin eso una ruta con «ñ» sale escapada y no coincide con nada.
  DIFF_RE17='git (-c [^ ]+ )*diff[^#]*--name-only'
  SIN17="$(grep -nE "$DIFF_RE17" "$AQUI"/pipelines/*.yml "$AQUI"/pipelines/templates/*.yml 2>/dev/null | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' | grep -v -- '--no-renames' | sed "s|^$AQUI/||")"
  SINQ17="$(grep -nE "$DIFF_RE17" "$AQUI"/pipelines/azure-pipelines-pr.yml 2>/dev/null | grep -vE '^[0-9]+:[[:space:]]*#' | grep -v -- 'core.quotePath=false')"
  N17="$(grep -hE "$DIFF_RE17" "$AQUI"/pipelines/*.yml "$AQUI"/pipelines/templates/*.yml 2>/dev/null | grep -vcE '^[[:space:]]*#')"
  { [ -z "$SIN17" ] && [ -z "$SINQ17" ] && [ "${N17:-0}" -ge 1 ]; } \
    && ok "V17e: los $N17 «git diff --name-only» de los pipelines llevan --no-renames" \
    || no "V17e: hay «git diff --name-only» sin --no-renames (o no encontré ninguno: $N17): $(printf '%s' "$SIN17" | tr '\n' '|' | cut -c1-300)"
fi

echo "———"
[ "$fallos" -eq 0 ] && { echo "✅ veredicto-pr: $pasaron chequeo(s), 0 fallas"; exit 0; } \
  || { echo "❌ veredicto-pr: FALLARON $fallos de $((pasaron+fallos))"; exit 1; }
