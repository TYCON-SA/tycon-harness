#!/usr/bin/env bash
# tests-without-ci.test.sh — casos de check-tests-without-ci.js: ¿un repo tiene pruebas de navegador que su pipeline
# no corre?
#
# 🔴 Por qué existe: un repo trajo dos suites nuevas y su pipeline cableó una sola; las pruebas de navegador quedaron
# escritas y sin correr casi un mes, y se descubrió de casualidad. El aviso que ya había vive en la máquina de quien usa
# la herramienta de merge y mira la declaración del portón, no el pipeline. Este control mira el pipeline, por repo.
#
# Mundo: una raíz de repos de mentira y un product-parity.json mínimo; cada repo es una carpeta (el control lee
# archivos, no historia). Sin red y sin los ganchos del equipo.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHK="$AQUI/scripts/ci/check-tests-without-ci.js"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0
ok(){ echo "✅ pruebas-sin-ci: $1"; }
no(){ echo "❌ pruebas-sin-ci: $1"; fallos=$((fallos+1)); }

# Un mundo nuevo: raíz de repos y la lista con los repos que se le pasan (nombre = carpeta).
mundo(){
  W="$TMP/$1"; shift
  mkdir -p "$W/repos"
  local lista=""
  for r in "$@"; do lista="$lista{\"producto\":\"$r\",\"ruta\":\"$r\"},"; done
  lista="${lista%,}"
  printf '{"grupos":{"frente":{"repos":[%s]}}}\n' "$lista" > "$W/parity.json"
}
escribir(){ mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"; }
corre(){ node "$CHK" --config "$W/parity.json" --root "$W/repos" "$@" >"$TMP/out.txt" 2>&1; echo $?; }
veredicto(){ node "$CHK" --config "$W/parity.json" --root "$W/repos" --json 2>/dev/null | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.resultados.find(x=>x.repo===process.argv[1]);console.log(r?r.veredicto:"(no está)");});' "$1"; }

SIN_PW='trigger:
  - main
steps:
  - script: npm ci && npm test'
CON_PW='trigger:
  - main
steps:
  - script: npm ci && npx playwright test'

# T1 ConSpecsYSinCI_LoReporta
mundo t1 acme-web
escribir "$W/repos/acme-web/playwright.config.ts" 'export default {};'
escribir "$W/repos/acme-web/e2e/a.spec.ts" 'test("a", () => {});'
escribir "$W/repos/acme-web/azure-pipelines.yml" "$SIN_PW"
v=$(veredicto acme-web); n=$(node "$CHK" --config "$W/parity.json" --root "$W/repos" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).resultados[0].specs))')
[ "$v" = "sin-ci" ] && [ "$n" = "1" ] && ok "T1 ConSpecsYSinCI_LoReporta" || no "T1 ConSpecsYSinCI_LoReporta (veredicto $v, specs $n)"

# T2 ConSpecsYConCI_SaleOk
mundo t2 acme-web
escribir "$W/repos/acme-web/playwright.config.ts" 'export default {};'
escribir "$W/repos/acme-web/e2e/a.spec.ts" 'test("a", () => {});'
escribir "$W/repos/acme-web/azure-pipelines.yml" "$CON_PW"
v=$(veredicto acme-web); rc=$(corre)
if [ "$v" = "ok" ] && ! grep -q "acme-web" "$TMP/out.txt"; then ok "T2 ConSpecsYConCI_SaleOk"; else no "T2 ConSpecsYConCI_SaleOk (veredicto $v; $(cat "$TMP/out.txt"))"; fi

# T3 SinConfig_NoAplica
mundo t3 acme-web
escribir "$W/repos/acme-web/e2e/a.spec.ts" 'test("a", () => {});'
escribir "$W/repos/acme-web/azure-pipelines.yml" "$SIN_PW"
v=$(veredicto acme-web); [ "$v" = "no-aplica" ] && ok "T3 SinConfig_NoAplica" || no "T3 SinConfig_NoAplica ($v)"

# T4 ConConfigYCeroSpecs_NoAplica
mundo t4 acme-web
escribir "$W/repos/acme-web/playwright.config.ts" 'export default {};'
mkdir -p "$W/repos/acme-web/e2e"
escribir "$W/repos/acme-web/azure-pipelines.yml" "$SIN_PW"
v=$(veredicto acme-web); [ "$v" = "no-aplica" ] && ok "T4 ConConfigYCeroSpecs_NoAplica" || no "T4 ConConfigYCeroSpecs_NoAplica ($v)"

# T5 SinNingunPipeline_EsOtroVeredicto
mundo t5 acme-web
escribir "$W/repos/acme-web/playwright.config.ts" 'export default {};'
escribir "$W/repos/acme-web/e2e/a.spec.ts" 'test("a", () => {});'
v=$(veredicto acme-web); [ "$v" = "sin-pipeline" ] && ok "T5 SinNingunPipeline_EsOtroVeredicto" || no "T5 SinNingunPipeline_EsOtroVeredicto ($v)"

# T6 DistingueQuienLoCubre
mundo t6 acme-con-porton acme-sin-porton
for r in acme-con-porton acme-sin-porton; do
  escribir "$W/repos/$r/playwright.config.ts" 'export default {};'
  escribir "$W/repos/$r/e2e/a.spec.ts" 'test("a", () => {});'
  escribir "$W/repos/$r/azure-pipelines.yml" "$SIN_PW"
done
escribir "$W/repos/acme-con-porton/.tycon/advisors.yaml" 'e2e:
  gate: scripts/e2e-gate.sh'
corre >/dev/null
if grep -q "acme-con-porton.*sólo el portón del merge" "$TMP/out.txt" && grep -q "acme-sin-porton.*no lo cubre nadie" "$TMP/out.txt"; then
  ok "T6 DistingueQuienLoCubre"
else no "T6 DistingueQuienLoCubre ($(cat "$TMP/out.txt"))"; fi

# T7 MiraTodosLosYaml_NoElPrimero — azure-pipelines-prod.yml ordena antes y no menciona Playwright
mundo t7 acme-web
escribir "$W/repos/acme-web/playwright.config.ts" 'export default {};'
escribir "$W/repos/acme-web/e2e/a.spec.ts" 'test("a", () => {});'
escribir "$W/repos/acme-web/azure-pipelines-prod.yml" "$SIN_PW"
escribir "$W/repos/acme-web/azure-pipelines.yml" "$CON_PW"
v=$(veredicto acme-web); [ "$v" = "ok" ] && ok "T7 MiraTodosLosYaml_NoElPrimero" || no "T7 MiraTodosLosYaml_NoElPrimero ($v)"

# T8 EncuentraAppsAnidadas — dos apps a 3 y 4 niveles y un señuelo en node_modules
mundo t8 acme-forms
escribir "$W/repos/acme-forms/forms/uno/app-a/playwright.config.ts" 'export default {};'
escribir "$W/repos/acme-forms/forms/uno/app-a/e2e/x.spec.ts" 'test("x", () => {});'
escribir "$W/repos/acme-forms/forms/dos/tres/app-b/playwright.config.js" 'module.exports = {};'
escribir "$W/repos/acme-forms/forms/dos/tres/app-b/e2e/y.spec.js" 'test("y", () => {});'
escribir "$W/repos/acme-forms/node_modules/pkg/playwright.config.ts" 'export default {};'
escribir "$W/repos/acme-forms/node_modules/pkg/e2e/senuelo.spec.ts" 'test("s", () => {});'
escribir "$W/repos/acme-forms/azure-pipelines.yml" "$SIN_PW"
J=$(node "$CHK" --config "$W/parity.json" --root "$W/repos" --json)
apps=$(printf '%s' "$J" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).resultados[0];console.log(r.specs+" "+r.apps.slice().sort().join(","))})')
[ "$apps" = "2 forms/dos/tres/app-b,forms/uno/app-a" ] && ok "T8 EncuentraAppsAnidadas" || no "T8 EncuentraAppsAnidadas ($apps)"

# T9 RepoAusente_NoEsOk
mundo t9 acme-web acme-fantasma
escribir "$W/repos/acme-web/playwright.config.ts" 'export default {};'
escribir "$W/repos/acme-web/e2e/a.spec.ts" 'test("a", () => {});'
escribir "$W/repos/acme-web/azure-pipelines.yml" "$CON_PW"
J=$(node "$CHK" --config "$W/parity.json" --root "$W/repos" --json)
r=$(printf '%s' "$J" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.ausentes+" "+j.resultados.some(x=>x.repo==="acme-fantasma"))})')
corre >/dev/null
if [ "$r" = "1 false" ] && grep -q "1 repo(s) no están en esta máquina" "$TMP/out.txt"; then ok "T9 RepoAusente_NoEsOk"; else no "T9 RepoAusente_NoEsOk ($r; $(cat "$TMP/out.txt"))"; fi

# T10 SalidaJsonEstable (el mundo de T1)
mundo t10 acme-web
escribir "$W/repos/acme-web/playwright.config.ts" 'export default {};'
escribir "$W/repos/acme-web/e2e/a.spec.ts" 'test("a", () => {});'
escribir "$W/repos/acme-web/azure-pipelines.yml" "$SIN_PW"
forma=$(node "$CHK" --config "$W/parity.json" --root "$W/repos" --json | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.resultados[0];
  const okTop=["medidos","ausentes","no_aplican","resultados"].every(k=>k in j)&&typeof j.medidos==="number"&&typeof j.ausentes==="number"&&typeof j.no_aplican==="number"&&Array.isArray(j.resultados);
  const okR=typeof r.repo==="string"&&typeof r.specs==="number"&&Array.isArray(r.apps)&&typeof r.veredicto==="string"&&typeof r.porton_del_merge==="boolean";
  console.log(okTop&&okR?"ok":"mal "+s)})')
[ "$forma" = "ok" ] && ok "T10 SalidaJsonEstable" || no "T10 SalidaJsonEstable ($forma)"

# T11 AvisaPeroNoFrena (el mundo de T1)
rc=$(corre); rcs=$(corre --strict)
[ "$rc" = "0" ] && [ "$rcs" = "1" ] && ok "T11 AvisaPeroNoFrena" || no "T11 AvisaPeroNoFrena (sin --strict $rc, con --strict $rcs)"

# T12 IndexTieneLaFila
if grep -q "scripts/ci/check-tests-without-ci.js" "$AQUI/INDEX.md" && grep -qi "pruebas de navegador" "$AQUI/INDEX.md"; then
  ok "T12 IndexTieneLaFila"
else no "T12 IndexTieneLaFila"; fi

# T13 LaListaSaleDeLaConfiguracion — mide exactamente los repos de la lista; sumar uno lo suma sin tocar el guion
mundo t13 acme-a acme-b
for r in acme-a acme-b acme-c; do
  escribir "$W/repos/$r/playwright.config.ts" 'export default {};'
  escribir "$W/repos/$r/e2e/a.spec.ts" 'test("a", () => {});'
  escribir "$W/repos/$r/azure-pipelines.yml" "$SIN_PW"
done
cuantos(){ node "$CHK" --config "$W/parity.json" --root "$W/repos" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).resultados.map(r=>r.repo).sort().join(",")))'; }
antes=$(cuantos)
printf '{"grupos":{"frente":{"repos":[{"producto":"acme-a","ruta":"acme-a"},{"producto":"acme-b","ruta":"acme-b"},{"producto":"acme-c","ruta":"acme-c"}]}}}\n' > "$W/parity.json"
despues=$(cuantos)
[ "$antes" = "acme-a,acme-b" ] && [ "$despues" = "acme-a,acme-b,acme-c" ] && ok "T13 LaListaSaleDeLaConfiguracion" || no "T13 LaListaSaleDeLaConfiguracion ($antes → $despues)"

# T14 SinRaizDeclarada_NoMideNada
mundo t14 acme-web
rc=$(node "$CHK" --config "$W/parity.json" >"$TMP/out.txt" 2>&1; echo $?)
if [ "$rc" = "2" ] && grep -q "sin raíz de repos" "$TMP/out.txt"; then ok "T14 SinRaizDeclarada_NoMideNada"; else no "T14 SinRaizDeclarada_NoMideNada (rc $rc; $(cat "$TMP/out.txt"))"; fi

# ── lo que encontró el pase adversarial y lo que marcaron los revisores ─────────────────────────────────────────────
# Un repo con config y specs y un pipeline dado; devuelve el veredicto y la cuenta de specs.
repo_con(){ # <mundo> <yaml del pipeline>
  mundo "$1" acme-web
  escribir "$W/repos/acme-web/playwright.config.ts" 'export default {};'
  escribir "$W/repos/acme-web/e2e/a.spec.ts" 'test("a", () => {});'
  escribir "$W/repos/acme-web/azure-pipelines.yml" "$2"
}

# T16 UnPasoComentado_NoCorre
repo_con t16 'steps:
  - script: npm ci
  # - script: npx playwright test   # apagado hasta tener entorno'
v=$(veredicto acme-web); [ "$v" = "sin-ci" ] && ok "T16 UnPasoComentado_NoCorre" || no "T16 UnPasoComentado_NoCorre ($v)"

# T17 SoloInstalarNavegadores_NoCorre (y un displayName que dice «playwright tests»)
repo_con t17 'steps:
  - script: npx playwright install --with-deps
    displayName: Preparar playwright tests'
v=$(veredicto acme-web); [ "$v" = "sin-ci" ] && ok "T17 SoloInstalarNavegadores_NoCorre" || no "T17 SoloInstalarNavegadores_NoCorre ($v)"

# T18 CadaFormaDeCorrerlas_Sola — `npx playwright test` y `playwright test` (por npx o por un script), cada una sola
for forma in 'npx playwright test --workers=2' 'npx --no-install playwright test' 'node_modules/.bin/playwright test'; do
  repo_con t18 "steps:
  - script: $forma"
  v=$(veredicto acme-web)
  [ "$v" = "ok" ] && ok "T18 CadaFormaDeCorrerlas_Sola ($forma)" || no "T18 CadaFormaDeCorrerlas_Sola ($forma → $v)"
done

# T19 SigueLasPlantillasDelRepo
repo_con t19 'steps:
  - template: ci-templates/e2e-steps.yml'
escribir "$W/repos/acme-web/ci-templates/e2e-steps.yml" 'steps:
  - script: npx playwright test'
v=$(veredicto acme-web); [ "$v" = "ok" ] && ok "T19 SigueLasPlantillasDelRepo" || no "T19 SigueLasPlantillasDelRepo ($v)"

# T20 SpecsMasHondosQueLaConfig_SeCuentan — config a 3 niveles, specs 3 carpetas más abajo
mundo t20 acme-forms
escribir "$W/repos/acme-forms/packages/forms/app-x/playwright.config.ts" 'export default {};'
escribir "$W/repos/acme-forms/packages/forms/app-x/tests/e2e/flows/a.spec.ts" 'test("a", () => {});'
escribir "$W/repos/acme-forms/azure-pipelines.yml" "$SIN_PW"
v=$(veredicto acme-forms); [ "$v" = "sin-ci" ] && ok "T20 SpecsMasHondosQueLaConfig_SeCuentan" || no "T20 SpecsMasHondosQueLaConfig_SeCuentan ($v)"

# T21 ConfigsAnidadas_CadaSpecUnaVez
mundo t21 acme-web
escribir "$W/repos/acme-web/a/playwright.config.ts" 'export default {};'
escribir "$W/repos/acme-web/a/e2e/x.spec.ts" 'test("x", () => {});'
escribir "$W/repos/acme-web/a/b/playwright.config.ts" 'export default {};'
escribir "$W/repos/acme-web/a/b/e2e/y.spec.ts" 'test("y", () => {});'
escribir "$W/repos/acme-web/azure-pipelines.yml" "$SIN_PW"
n=$(node "$CHK" --config "$W/parity.json" --root "$W/repos" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).resultados[0].specs))')
[ "$n" = "2" ] && ok "T21 ConfigsAnidadas_CadaSpecUnaVez" || no "T21 ConfigsAnidadas_CadaSpecUnaVez (specs $n)"

# T22 ConfigConSufijo_SeReconoce, y una config en la raíz con apps anidadas cuenta cada spec una vez
mundo t22 acme-web
escribir "$W/repos/acme-web/playwright.config.e2e.ts" 'export default {};'
escribir "$W/repos/acme-web/e2e/a.spec.ts" 'test("a", () => {});'
escribir "$W/repos/acme-web/app/playwright.config.ts" 'export default {};'
escribir "$W/repos/acme-web/app/e2e/b.spec.ts" 'test("b", () => {});'
escribir "$W/repos/acme-web/azure-pipelines.yml" "$SIN_PW"
r=$(node "$CHK" --config "$W/parity.json" --root "$W/repos" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s).resultados[0];console.log(x.veredicto+" "+x.specs)})')
[ "$r" = "sin-ci 2" ] && ok "T22 ConfigConSufijo_SeReconoce" || no "T22 ConfigConSufijo_SeReconoce ($r)"

# T23 ConfigAlLimiteDeProfundidad — a 5 niveles se ve, a 6 no
mundo t23 acme-cinco acme-seis
escribir "$W/repos/acme-cinco/n1/n2/n3/n4/n5/playwright.config.ts" 'export default {};'
escribir "$W/repos/acme-cinco/n1/n2/n3/n4/n5/e2e/a.spec.ts" 'test("a", () => {});'
escribir "$W/repos/acme-cinco/azure-pipelines.yml" "$SIN_PW"
escribir "$W/repos/acme-seis/n1/n2/n3/n4/n5/n6/playwright.config.ts" 'export default {};'
escribir "$W/repos/acme-seis/n1/n2/n3/n4/n5/n6/e2e/a.spec.ts" 'test("a", () => {});'
escribir "$W/repos/acme-seis/azure-pipelines.yml" "$SIN_PW"
v5=$(veredicto acme-cinco); v6=$(veredicto acme-seis)
[ "$v5" = "sin-ci" ] && [ "$v6" = "no-aplica" ] && ok "T23 ConfigAlLimiteDeProfundidad" || no "T23 ConfigAlLimiteDeProfundidad (5 → $v5, 6 → $v6)"

# T24 PipelineIlegible_NoMedido
repo_con t24 "$SIN_PW"
escribir "$W/repos/acme-web/azure-pipelines-prod.yml" "$CON_PW"
chmod 000 "$W/repos/acme-web/azure-pipelines-prod.yml"
if [ -r "$W/repos/acme-web/azure-pipelines-prod.yml" ]; then
  echo "⏭ pruebas-sin-ci: T24 PipelineIlegible_NoMedido SALTADO — se corre como un usuario que lee todo (no es un verde)"
else
  v=$(veredicto acme-web); rc=$(corre --strict)
  [ "$v" = "no-medido" ] && [ "$rc" = "2" ] && grep -q "NO MEDIDO" "$TMP/out.txt" && ok "T24 PipelineIlegible_NoMedido" || no "T24 PipelineIlegible_NoMedido ($v, rc $rc)"
fi
chmod 644 "$W/repos/acme-web/azure-pipelines-prod.yml"

# T25 TodosAusentes_NoPuedeOpinar
mundo t25 acme-fantasma
rc=$(corre)
[ "$rc" = "2" ] && grep -q "no puedo opinar" "$TMP/out.txt" && ok "T25 TodosAusentes_NoPuedeOpinar" || no "T25 TodosAusentes_NoPuedeOpinar (rc $rc)"

# T26 SinProductosAProposito_DiceQueNoMidio (la copia pública) y la marca contradictoria
mundo t26 acme-web
printf '{"sin_productos":"copia pública","grupos":{}}\n' > "$W/parity.json"
rc=$(corre); rcj=$(node "$CHK" --config "$W/parity.json" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).sin_productos))')
printf '{"sin_productos":"x","grupos":{"g":["a"]}}\n' > "$W/parity.json"
rc2=$(corre)
[ "$rc" = "0" ] && [ "$rcj" = "copia pública" ] && [ "$rc2" = "2" ] && ok "T26 SinProductosAProposito_DiceQueNoMidio" || no "T26 SinProductosAProposito_DiceQueNoMidio (rc $rc, json $rcj, contradicción $rc2)"

# T27 ListaMalArmada_NoSeSaltea — una entrada sin ruta, una ruta que no es texto y un archivo `null`
mundo t27 acme-web
printf '{"grupos":{"frente":{"repos":[{"producto":"acme-web"}]}}}\n' > "$W/parity.json"; a=$(corre --strict)
printf '{"grupos":{"frente":{"repos":[{"producto":"acme-web","ruta":7}]}}}\n' > "$W/parity.json"; b=$(corre --strict)
printf 'null\n' > "$W/parity.json"; c=$(corre --strict)
[ "$a" = "2" ] && [ "$b" = "2" ] && [ "$c" = "2" ] && ok "T27 ListaMalArmada_NoSeSaltea" || no "T27 ListaMalArmada_NoSeSaltea (sin ruta $a, ruta no texto $b, null $c)"

# T28 OpcionDesconocida_NoSeIgnora — una opción que el control no conoce (un --strict mal escrito, por ejemplo) no deja
# el modo aviso callado
repo_con t28 "$SIN_PW"
a=$(corre --verbose); b=$(node "$CHK" --config "$W/parity.json" --root >/dev/null 2>&1; echo $?)
[ "$a" = "2" ] && [ "$b" = "2" ] && ok "T28 OpcionDesconocida_NoSeIgnora" || no "T28 OpcionDesconocida_NoSeIgnora (opción desconocida $a, --root sin valor $b)"

# T29 PlantillaFueraDelRepo_NoSeSigue — `template: ../fuera.yml` no lee archivos de otro lado
repo_con t29 'steps:
  - template: ../fuera.yml'
escribir "$W/repos/fuera.yml" 'steps:
  - script: npx playwright test'
v=$(veredicto acme-web); corre >/dev/null
[ "$v" = "sin-ci" ] && grep -q "fuera del repo" "$TMP/out.txt" && ok "T29 PlantillaFueraDelRepo_NoSeSigue" || no "T29 PlantillaFueraDelRepo_NoSeSigue ($v; $(cat "$TMP/out.txt"))"

# T30 AppEnlazada_NoDesapareceCallada — una carpeta enlazada se sigue
mundo t30 acme-web
escribir "$TMP/t30-afuera/app/playwright.config.ts" 'export default {};'
escribir "$TMP/t30-afuera/app/e2e/a.spec.ts" 'test("a", () => {});'
mkdir -p "$W/repos/acme-web"; ln -s "$TMP/t30-afuera/app" "$W/repos/acme-web/app"
escribir "$W/repos/acme-web/azure-pipelines.yml" "$SIN_PW"
v=$(veredicto acme-web); [ "$v" = "sin-ci" ] && ok "T30 AppEnlazada_NoDesapareceCallada" || no "T30 AppEnlazada_NoDesapareceCallada ($v)"

# T31 CarpetaIlegibleConSpecs_SeAvisa, y un repo sin permiso de lectura no es «ausente»
mundo t31 acme-web acme-cerrado
escribir "$W/repos/acme-web/playwright.config.ts" 'export default {};'
escribir "$W/repos/acme-web/e2e/a.spec.ts" 'test("a", () => {});'
escribir "$W/repos/acme-web/e2e/privado/b.spec.ts" 'test("b", () => {});'
escribir "$W/repos/acme-web/azure-pipelines.yml" "$SIN_PW"
mkdir -p "$W/repos/acme-cerrado/sub"
chmod 000 "$W/repos/acme-web/e2e/privado"; chmod 000 "$W/repos/acme-cerrado"
if [ -r "$W/repos/acme-web/e2e/privado" ]; then
  echo "⏭ pruebas-sin-ci: T31 CarpetaIlegibleConSpecs_SeAvisa SALTADO — se corre como un usuario que lee todo (no es un verde)"
else
  J=$(node "$CHK" --config "$W/parity.json" --root "$W/repos" --json)
  r=$(printf '%s' "$J" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const w=j.resultados.find(x=>x.repo==="acme-web");const c=j.resultados.find(x=>x.repo==="acme-cerrado");console.log(j.ausentes+" "+((w.avisos||[]).length>0)+" "+(c?c.veredicto:"(no está)"))})')
  [ "$r" = "0 true no-medido" ] && ok "T31 CarpetaIlegibleConSpecs_SeAvisa" || no "T31 CarpetaIlegibleConSpecs_SeAvisa (ausentes, aviso, cerrado: $r)"
fi
chmod 755 "$W/repos/acme-web/e2e/privado" "$W/repos/acme-cerrado"

echo
if [ "$fallos" -eq 0 ]; then echo "pruebas-sin-ci: todo verde"; exit 0; fi
echo "pruebas-sin-ci: $fallos caso(s) en rojo"; exit 1
