#!/usr/bin/env bash
# trigger-without-docs.test.sh — casos de check-trigger-without-docs.js: ¿un merge de SÓLO
# documentación construye, despliega y pide producción?
#
# 🔴 EL CASO QUE LE DA SENTIDO (2026-09-24): un pull request del backend de un producto del equipo —29 archivos,
# ninguno de código— entró a main y el CI compiló, desplegó a staging, subió la versión y encoló el
# pedido de aprobación de PRODUCCIÓN. La causa era `.tycon/**` en el `paths.include` de once
# pipelines (el pipeline TYCON escribe `.tycon/runtime-waivers.jsonl` en casi toda story), y los
# sitios sin filtro de rutas construían con cualquier commit. El día anterior se había parchado a
# mano UN pipeline; el problema vivía en todos.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHK="$AQUI/scripts/ci/check-trigger-without-docs.js"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0
ok(){ echo "✅ disparador: $1"; }
no(){ echo "❌ disparador: $1"; fallos=$((fallos+1)); }
corre(){ node "$CHK" "$@" >"$TMP/out.txt" 2>&1; echo $?; }

# El trigger REAL de un backend TYCON (un producto del equipo, 2026-09-24), con `.tycon/**`.
BACKEND_REAL='trigger:
  batch: true
  branches:
    include:
      - main
  paths:
    include:
      - src/**
      - database/**
      - plugin.json
      - plugin.json.example
      - scripts/**
      - package.json
      - azure-pipelines.yml
      # 🔴 2026-09-01: FALTABA `tests/**`.
      - tests/**
      - .tycon/**

pr: none

stages:
  - stage: Build'

# ---------------------------------------------------------------- 1. EL CASO REAL: `.tycon/**` en include
printf '%s\n' "$BACKEND_REAL" > "$TMP/real.yml"
rc=$(corre --file "$TMP/real.yml")
[ "$rc" -eq 1 ] && ok "🔴 el caso real: con \`.tycon/**\` en include, un merge de sólo docs construye (sale 1)" || no "🔴 dejó pasar el caso real: salió $rc — $(cat "$TMP/out.txt")"
grep -q 'runtime-waivers.jsonl' "$TMP/out.txt" && ok "…y nombra el archivo que lo dispara (runtime-waivers.jsonl)" || no "no nombró el archivo: $(cat "$TMP/out.txt")"
grep -q 'por `.tycon/\*\*`' "$TMP/out.txt" && ok "…y el patrón del include que lo incluye" || no "no nombró el patrón: $(cat "$TMP/out.txt")"
grep -q 'sacar `.tycon/\*\*`' "$TMP/out.txt" && ok "…y dice qué cambiar" || no "no dijo qué cambiar: $(cat "$TMP/out.txt")"

# ---------------------------------------------------------------- 2. el arreglo: sin `.tycon/**`, limpio
grep -v '\.tycon/\*\*' "$TMP/real.yml" > "$TMP/arreglado.yml"
rc=$(corre --file "$TMP/arreglado.yml")
[ "$rc" -eq 0 ] && ok "sin \`.tycon/**\` el mismo pipeline no construye por docs (sale 0)" || no "el arreglado salió $rc: $(cat "$TMP/out.txt")"
grep -q 'todos disparan con código' "$TMP/out.txt" && ok "…y sigue disparando con código (contra-prueba)" || no "no verificó la contra-prueba: $(cat "$TMP/out.txt")"

# ---------------------------------------------------------------- 3. sin filtro de rutas: la raíz está incluida
cat > "$TMP/sinfiltro.yml" <<'YML'
trigger:
  branches:
    include:
      - main

pool:
  name: 'SelfHostedPool'
YML
rc=$(corre --file "$TMP/sinfiltro.yml")
[ "$rc" -eq 1 ] && ok "🔴 sin filtro de rutas construye con cualquier commit (sale 1)" || no "🔴 un pipeline sin filtro salió $rc"
grep -q 'la raíz está incluida' "$TMP/out.txt" && ok "…y explica que la raíz está incluida por defecto" || no "no explicó la raíz: $(cat "$TMP/out.txt")"
grep -q 'agregar `paths.exclude`' "$TMP/out.txt" && ok "…y sugiere el exclude" || no "no sugirió el exclude"

# ---------------------------------------------------------------- 4. el exclude canónico completo lo apaga
cat > "$TMP/excl-completo.yml" <<'YML'
trigger:
  branches:
    include:
      - main
  paths:
    exclude:
      - README.md
      - CLAUDE.md
      - AGENTS.md
      - .engram-project
      - docs
      - specs
      - qa
      - tasks
      - .advisors
      - .engram
      - .tycon
      - .claude
      - .vscode
YML
rc=$(corre --file "$TMP/excl-completo.yml")
[ "$rc" -eq 0 ] && ok "con el exclude canónico completo, sin lista include, no construye por docs y sí con código" || no "el exclude completo salió $rc: $(cat "$TMP/out.txt")"

# ---------------------------------------------------------------- 5. el parche de ayer (TotoraWebSite): exclude PARCIAL
cat > "$TMP/excl-parcial.yml" <<'YML'
trigger:
  branches:
    include:
      - main
  paths:
    exclude:
      - README.md
      - CLAUDE.md
      - AGENTS.md
      - .engram-project
      - docs
YML
rc=$(corre --file "$TMP/excl-parcial.yml")
[ "$rc" -eq 1 ] && ok "🔴 un exclude parcial (el parche a mano del 23-09) sigue construyendo por lo que no excluye" || no "🔴 el exclude parcial salió $rc"
grep -q 'specs/' "$TMP/out.txt" && ok "…y dice qué se le escapa (specs/…)" || no "no nombró lo que se escapa: $(cat "$TMP/out.txt")"
grep -v 'agregar `paths.exclude`' "$TMP/out.txt" | grep -q 'README.md' && no "🔴 acusó a README.md, que SÍ está excluido" || ok "…sin acusar a lo que sí excluye (README.md)"

# ---------------------------------------------------------------- 6. gana el más específico: include ancho + exclude fino
cat > "$TMP/especifico.yml" <<'YML'
trigger:
  branches:
    include:
      - main
  paths:
    include:
      - src/**
      - .tycon/**
    exclude:
      - .tycon/runtime-waivers.jsonl
      - .tycon/dod-scenarios
YML
rc=$(corre --file "$TMP/especifico.yml")
[ "$rc" -eq 0 ] && ok "un exclude más profundo que el include gana (la regla de Azure): no construye por docs" || no "🔴 no aplicó 'gana el más específico': salió $rc — $(cat "$TMP/out.txt")"

# ---------------------------------------------------------------- 7. contra-prueba: un filtro que apaga TODO también está roto
cat > "$TMP/apagado.yml" <<'YML'
trigger:
  branches:
    include:
      - main
  paths:
    include:
      - carpeta-que-no-existe/**
YML
rc=$(corre --file "$TMP/apagado.yml")
[ "$rc" -eq 1 ] && ok "🔴 un include que no cubre ningún código sale 1 (no dispara ni con código)" || no "🔴 un filtro que apaga todo salió $rc"
grep -q 'NO dispara ni con código' "$TMP/out.txt" && ok "…y lo dice con esas palabras" || no "no lo explicó: $(cat "$TMP/out.txt")"

# ---------------------------------------------------------------- 8. `trigger: none` no aplica (lo dispara otro)
cat > "$TMP/none.yml" <<'YML'
trigger: none   # obligatorio: si no, cada push a main correría este pipeline dos veces
pr: none

resources:
  pipelines:
    - pipeline: ci
      source: 'Totora Backend'
      trigger:
        branches:
          include:
            - main
        paths:
          include:
            - .tycon/**
YML
rc=$(corre --file "$TMP/none.yml")
[ "$rc" -eq 2 ] && ok "\`trigger: none\` solo no se mide (sale 2: nada medido, no opina verde)" || no "un trigger: none salió $rc: $(cat "$TMP/out.txt")"
grep -q 'heredan el veredicto del CI' "$TMP/out.txt" && ok "…y dice que hereda el veredicto del CI" || no "no lo explicó: $(cat "$TMP/out.txt")"
grep -q 'construye con un merge' "$TMP/out.txt" && no "🔴 leyó el \`trigger:\` de resources.pipelines como si fuera el de push" || ok "…sin confundir el trigger anidado de resources con el de push"

# ---------------------------------------------------------------- 9. comodines: `*` no cruza carpetas, `*/src/**` es un formulario
cat > "$TMP/comodines.yml" <<'YML'
trigger:
  branches:
    include:
      - main
  paths:
    include:
      - '*/src/**'           # Changes in source of any form
      - '*/package.json'     # Changes in package.json of forms
      - 'build-form.js'      # Changes in shared build script
      - 'package.json'
YML
rc=$(corre --file "$TMP/comodines.yml")
[ "$rc" -eq 0 ] && ok "el trigger de formularios ('*/src/**', con comillas y comentarios) no construye por docs y sí con Formulario/src/App.tsx" || no "el trigger de formularios salió $rc: $(cat "$TMP/out.txt")"
cat > "$TMP/md-raiz.yml" <<'YML'
trigger:
  branches:
    include:
      - main
  paths:
    exclude:
      - '*.md'
YML
rc=$(corre --file "$TMP/md-raiz.yml")
[ "$rc" -eq 1 ] && grep -q 'se escapan .*docs/' "$TMP/out.txt" \
  && ok "'*.md' excluye sólo la raíz: docs/ sigue disparando (el comodín no cruza carpetas)" \
  || no "🔴 trató '*.md' como si cruzara carpetas: rc=$rc — $(cat "$TMP/out.txt")"

# ---------------------------------------------------------------- 10. sin `trigger:` en el YAML, Azure dispara con todo
cat > "$TMP/sintrigger.yml" <<'YML'
pool:
  vmImage: 'ubuntu-latest'
steps:
  - script: echo hola
YML
rc=$(corre --file "$TMP/sintrigger.yml")
[ "$rc" -eq 1 ] && ok "sin \`trigger:\` cuenta como sin filtro (Azure dispara con cualquier push)" || no "un YAML sin trigger salió $rc"

# ---------------------------------------------------------------- 11. por configuración: lee lo PUBLICADO (origin/main), no el disco
mundo="$TMP/mundo"; mkdir -p "$mundo/ProdA"
git -c init.defaultBranch=main init -q "$mundo/ProdA/Back"
grep -v '\.tycon/\*\*' "$TMP/real.yml" > "$mundo/ProdA/Back/azure-pipelines.yml"      # publicado: arreglado
printf 'trigger: none\n' > "$mundo/ProdA/Back/azure-pipelines-prod.yml"               # producción: lo encola el CI
git -C "$mundo/ProdA/Back" -c user.email=t@t -c user.name=t add -A
git -C "$mundo/ProdA/Back" -c user.email=t@t -c user.name=t commit -q -m 'pipeline arreglado'
git clone -q --bare "$mundo/ProdA/Back" "$TMP/remoto.git"
git -C "$mundo/ProdA/Back" remote add origin "$TMP/remoto.git"
git -C "$mundo/ProdA/Back" fetch -q origin
cp "$TMP/real.yml" "$mundo/ProdA/Back/azure-pipelines.yml"                          # disco: el malo, sin commitear
cat > "$TMP/cfg.json" <<CFG
{ "raiz_por_defecto": "$mundo",
  "grupos": { "backend": [ { "producto": "ProdA", "ruta": "ProdA/Back" } ],
              "prod":    { "archivo": "azure-pipelines-prod.yml", "solo_rasgos_que_lo_nombren": true,
                           "repos": [ { "producto": "ProdA", "ruta": "ProdA/Back" } ] } },
  "rasgos": [], "diferencias_declaradas": [] }
CFG
rc=$(corre --config "$TMP/cfg.json")
[ "$rc" -eq 0 ] && ok "se juzga lo publicado en origin/main (arreglado), no el disco (roto): sale 0" || no "🔴 juzgó el disco en vez de lo publicado: rc=$rc — $(cat "$TMP/out.txt")"
grep -q 'desde el DISCO' "$TMP/out.txt" && no "avisó lectura desde el disco habiendo leído lo publicado" || ok "…sin aviso de lectura desde el disco"
grep -q 'trigger: none' "$TMP/out.txt" && ok "…y el de producción (trigger: none) se cuenta como 'no aplica', no como medido" || no "no explicó el trigger: none de producción: $(cat "$TMP/out.txt")"

# ---------------------------------------------------------------- 12. sin remoto, el disco es el plan B — AVISANDO
mkdir -p "$mundo/ProdB/Back"; cp "$TMP/real.yml" "$mundo/ProdB/Back/azure-pipelines.yml"
cat > "$TMP/cfg2.json" <<CFG
{ "raiz_por_defecto": "$mundo",
  "grupos": { "backend": [ { "producto": "ProdB", "ruta": "ProdB/Back" } ] },
  "rasgos": [], "diferencias_declaradas": [] }
CFG
rc=$(corre --config "$TMP/cfg2.json")
[ "$rc" -eq 1 ] && ok "sin remoto se juzga el disco y el caso real sale 1" || no "sin remoto salió $rc: $(cat "$TMP/out.txt")"
grep -q 'desde el DISCO' "$TMP/out.txt" && ok "…AVISANDO que se leyó del disco y no de lo publicado" || no "🔴 leyó del disco en silencio: $(cat "$TMP/out.txt")"

# ---------------------------------------------------------------- 13. repo ausente NO es 'no construye'
cat > "$TMP/cfg3.json" <<CFG
{ "raiz_por_defecto": "$mundo",
  "grupos": { "backend": [ { "producto": "ProdA", "ruta": "ProdA/Back" }, { "producto": "Fantasma", "ruta": "Fantasma/Back" } ] },
  "rasgos": [], "diferencias_declaradas": [] }
CFG
rc=$(corre --config "$TMP/cfg3.json")
grep -q 'no están en esta máquina' "$TMP/out.txt" && ok "un repo que falta se DICE (no medido ≠ no construye)" || no "🔴 un repo ausente pasó en silencio: $(cat "$TMP/out.txt")"
cat > "$TMP/cfg4.json" <<CFG
{ "raiz_por_defecto": "$mundo",
  "grupos": { "backend": [ { "producto": "Fantasma", "ruta": "Fantasma/Back" } ] },
  "rasgos": [], "diferencias_declaradas": [] }
CFG
rc=$(corre --config "$TMP/cfg4.json")
[ "$rc" -eq 2 ] && ok "sin nada medido sale 2 (no opina verde)" || no "🔴 sin nada medido salió $rc"

# ---------------------------------------------------------------- 14. --json para quien lo consuma
rc=$(corre --file "$TMP/real.yml" --json)
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(j.medidos!==1||j.resultados[0].veredicto!=="docs") process.exit(1)' "$TMP/out.txt" \
  && ok "--json trae medidos y el veredicto por pipeline" || no "--json no trae lo esperado: $(cat "$TMP/out.txt")"

# ---------------------------------------------------------------- 15. el pipeline de publicación del arnés (story 8.18, AC 27)
# No es un pipeline de producto: no construye, no despliega y no pide producción. Lleva la copia pública, y ahí la
# documentación ES contenido: una guía o el README salen en la copia. Por eso NO filtra por rutas, a propósito —la lista
# del exportador y la de un disparador serían dos listas que se separan solas—, y un merge que no cambia la copia termina
# en «sin cambios», sin empujar nada. Lo que se fija acá, sobre el YAML de verdad:
#   · lo que era de agent-skills (agents/, skills/, packs/) dispara, igual que lo demás: desde la unión vive en este repo;
#   · una guía, el README y un guion disparan: con el exclude que este control sugiere, el README esperaría a la corrida diaria;
#   · y queda DICHO que este control, corrido a mano sobre ese YAML, da 1. Es la excepción declarada, no un descuido: el
#     día que alguien le ponga un filtro, este caso se pone rojo y obliga a mirar qué deja afuera.
PUB="$AQUI/pipelines/azure-pipelines-publicacion.yml"
# fires <archivo…> → 0 si el trigger del pipeline de publicación incluye a TODOS; si no, 1 y los nombra en $TMP/out.txt
fires(){
  node -e '
    const rules = require(process.argv[1]);
    const trigger = rules.leerTrigger(require("fs").readFileSync(process.argv[2], "utf8"));
    const left = trigger.tipo === "none" ? process.argv.slice(3) : process.argv.slice(3).filter((f) => rules.incluido(trigger, f) === null);
    if (left.length) { console.log(`no disparan: ${left.join(", ")}`); process.exit(1); }
  ' "$CHK" "$PUB" "$@" >"$TMP/out.txt" 2>&1
}
if [ ! -f "$PUB" ]; then
  echo "ℹ️ disparador: el pipeline de publicación no está en esta copia (pipelines/ no viaja): su caso no aplica"
else
  fires agents/un-revisor.md skills/una-skill/SKILL.md packs/un-paquete/pack.json \
    && ok "publicación: un merge que sólo toca agents/, skills/ o packs/ dispara (PublicationPipeline_NoCrossResource_TriggerPaths_LinkTemplate)" \
    || no "🔴 publicación: el disparador deja afuera lo que era de agent-skills — $(cat "$TMP/out.txt")"
  fires guides/una-guia.md README.md scripts/un-guion.js \
    && ok "publicación: una guía, el README y un guion disparan: lo que sale en la copia no espera a la corrida diaria" \
    || no "🔴 publicación: el disparador deja afuera contenido que se publica — $(cat "$TMP/out.txt")"
  rc=$(corre --file "$PUB")
  { [ "$rc" -eq 1 ] && grep -q 'la raíz está incluida' "$TMP/out.txt"; } \
    && ok "publicación: sin filtro de rutas, a propósito — este control, corrido a mano sobre su YAML, da 1 y queda declarado (no construye ni pide producción: un disparo que no cambia la copia termina en «sin cambios»)" \
    || no "🔴 publicación: el control dio $rc sobre su YAML y se esperaba 1 (sin filtro). Si ahora filtra por rutas: revisar que no deje afuera nada de lo que se publica, y actualizar este caso y guides/publicacion-espejo.md — $(cat "$TMP/out.txt")"
fi

# ---------------------------------------------------------------- 8.10.3 A · T3 (AC 3): «sin productos» declarado a propósito
# TriggerControl_ExplicitNoProducts_ExitsZeroAndSaysSo — la copia pública trae un product-parity.json sintético sin productos:
# el control dice que no comparó nada y sale 0, pero SÓLO con la marca explícita; sin ella, lo de siempre (2).
cat > "$TMP/t810a.json" <<'CFG'
{ "sin_productos": "copia pública: los productos del equipo no viajan", "grupos": {}, "rasgos": [], "diferencias_declaradas": [] }
CFG
rc=$(cd "$TMP" && node "$CHK" --config "$TMP/t810a.json" >"$TMP/out.txt" 2>&1; echo $?)
{ [ "$rc" -eq 0 ] && grep -q 'no hay productos declarados' "$TMP/out.txt"; } \
  && ok "8.10.3 · sin productos declarados a propósito: sale 0 y lo dice" || no "🔴 8.10.3 · sin productos a propósito salió $rc: $(cat "$TMP/out.txt")"
cat > "$TMP/t810b.json" <<'CFG'
{ "grupos": {}, "rasgos": [], "diferencias_declaradas": [] }
CFG
rc=$(cd "$TMP" && node "$CHK" --config "$TMP/t810b.json" >"$TMP/out.txt" 2>&1; echo $?)
[ "$rc" -eq 2 ] && ok "8.10.3 · grupos vacíos SIN la marca siguen saliendo 2" || no "🔴 8.10.3 · grupos vacíos sin la marca salieron $rc"
printf '%s\n' '{ "sin_productos": "  ", "grupos": {}, "rasgos": [], "diferencias_declaradas": [] }' > "$TMP/t810v.json"
rc=$(cd "$TMP" && node "$CHK" --config "$TMP/t810v.json" >"$TMP/out.txt" 2>&1; echo $?)
[ "$rc" -eq 2 ] && ok "8.10.3 · una marca sin motivo (vacía) sale 2" || no "🔴 8.10.3 · marca vacía salió $rc"
rc=$(cd "$TMP" && node "$CHK" --config "$TMP/t810a.json" --json >"$TMP/out.txt" 2>&1; echo $?)
{ [ "$rc" -eq 0 ] && node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(j.medidos===0&&Array.isArray(j.resultados)&&!j.resultados.length&&typeof j.sin_productos==="string"?0:1)' "$TMP/out.txt"; } \
  && ok "8.10.3 · con --json, sin productos a propósito: la forma de siempre (medidos 0) más el motivo en sin_productos" \
  || no "🔴 8.10.3 · --json sin productos salió $rc: $(head -c 300 "$TMP/out.txt")"
cat > "$TMP/t810c.json" <<CFG
{ "sin_productos": "x", "raiz_por_defecto": "$TMP/mundo", "grupos": { "backend": [ { "producto": "ProdA", "ruta": "ProdA/Back" } ] }, "rasgos": [], "diferencias_declaradas": [] }
CFG
rc=$(cd "$TMP" && node "$CHK" --config "$TMP/t810c.json" >"$TMP/out.txt" 2>&1; echo $?)
[ "$rc" -eq 2 ] && ok "8.10.3 · la marca con grupos es una contradicción: sale 2" || no "🔴 8.10.3 · marca con grupos salió $rc"

echo
if [ "$fallos" -eq 0 ]; then echo "✅ disparador-sin-docs: todos los casos pasan"; exit 0; fi
echo "❌ disparador-sin-docs: $fallos caso(s) en rojo"; exit 1
