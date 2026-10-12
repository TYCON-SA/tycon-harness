#!/usr/bin/env bash
# Prueba de check-product-parity.js — el control que verifica que los pipelines de los
# cinco productos hagan LO MISMO.
#
# Nace del 2026-09-01: se dio un producto del equipo por alineado con otro y faltaban ONCE cosas, cuatro de ellas
# repartidas en productos YA dados por cerrados. Ninguna la encontró una revisión: las encontró el
# dev preguntando "¿me lo podés asegurar con evidencia?".
# En su PRIMERA corrida el control encontró una duodécima que nadie había visto.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHK="$AQUI/scripts/ci/check-product-parity.js"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0
ok(){ echo "✅ paridad: $1"; }
no(){ echo "❌ paridad: $1"; fallos=$((fallos+1)); }

# story 8.10.3: los casos que leen los patrones del product-parity.json DE VERDAD sólo miden con la lista real. En la copia
# pública el archivo es un sintético con «sin_productos» (antes no viajaba, y el `require` que fallaba en silencio dejaba
# esos casos en verde sin mirar nada): ahí dicen NO MEDIDO.
# Tres estados (pase de fallos silenciosos de la tanda A): `real` mide; `copia` (el sintético con «sin_productos») dice NO
# MEDIDO; y un archivo que no está o no se puede leer es ROJO con su motivo — nunca «NO MEDIDO (copia pública)», que en el
# repo del equipo taparía un product-parity.json roto.
ESTADO_LISTA="$(node -e 'try { const c=require(process.argv[1]); if (c && typeof c.sin_productos === "string" && c.sin_productos.trim()) console.log("copia"); else if (c && c.grupos && Object.keys(c.grupos).length) console.log("real"); else console.log("roto:sin grupos y sin «sin_productos»"); } catch (e) { console.log("roto:" + e.message.split("\n")[0]); }' "$AQUI/scripts/ci/product-parity.json")"
lista_real_de_productos(){ [ "$ESTADO_LISTA" = real ]; }
# lo que dice un caso que lee la lista real cuando no la hay: NO MEDIDO en la copia, rojo si no se pudo leer
sin_lista_real(){ # <caso>
  case "$ESTADO_LISTA" in
    copia) ok "NO MEDIDO: sin la lista real de productos (copia pública) — el caso $1 lee los patrones del JSON de verdad" ;;
    *) no "🔴 el caso $1 no pudo leer scripts/ci/product-parity.json (${ESTADO_LISTA#roto:}) — no medido NO es «copia pública»" ;;
  esac
}

# Un mundo de mentira: dos "productos" con su pipeline.
mundo(){ # <raiz> <contenido A> <contenido B>
  mkdir -p "$1/ProdA/Back" "$1/ProdB/Back"
  printf '%s\n' "$2" > "$1/ProdA/Back/azure-pipelines.yml"
  printf '%s\n' "$3" > "$1/ProdB/Back/azure-pipelines.yml"
}
config(){ # <archivo> [diferencias_declaradas json]
  cat > "$1" <<CFG
{
  "raiz_por_defecto": "$TMP/mundo",
  "grupos": { "backend": [
    { "producto": "ProdA", "ruta": "ProdA/Back" },
    { "producto": "ProdB", "ruta": "ProdB/Back" } ] },
  "rasgos": [ { "id": "reintento", "que": "reintento del ingreso", "patron": "Too Many Requests" } ],
  "diferencias_declaradas": ${2:-[]}
}
CFG
}
corre(){ node "$CHK" --config "$1" ${2:+--root "$2"} >"$TMP/out.txt" 2>&1; echo $?; }

# ---------------------------------------------------------------- 1. los dos iguales → verde
rm -rf "$TMP/mundo"; mundo "$TMP/mundo" 'grep Too Many Requests' 'grep Too Many Requests'
config "$TMP/c1.json"
rc=$(corre "$TMP/c1.json")
[ "$rc" -eq 0 ] && ok "dos productos que hacen lo mismo salen 0" || no "salió $rc con los dos iguales: $(cat "$TMP/out.txt")"

# ---------------------------------------------------------------- 2. EL CASO REAL: uno lo tiene y el otro no
rm -rf "$TMP/mundo"; mundo "$TMP/mundo" 'grep Too Many Requests' 'sin reintento'
config "$TMP/c2.json"
rc=$(corre "$TMP/c2.json")
[ "$rc" -eq 1 ] && ok "🔴 caza la divergencia (uno lo tiene, el otro no)" || no "🔴 dejó pasar la divergencia: salió $rc"
grep -q "lo tienen: ProdA" "$TMP/out.txt" && grep -q "NO lo tienen: ProdB" "$TMP/out.txt" \
  && ok "…y dice QUIÉN lo tiene y quién no" || no "no nombró a los productos: $(cat "$TMP/out.txt")"

# ---------------------------------------------------------------- 3. una diferencia DECLARADA no frena
config "$TMP/c3.json" '[{"grupo":"backend","rasgo":"reintento","motivo":"prueba","fecha":"2026-09-01","revision":"2099-01-01"}]'
rc=$(corre "$TMP/c3.json")
[ "$rc" -eq 0 ] && ok "una diferencia declarada con motivo y fecha no frena" || no "una diferencia declarada frenó igual: $(cat "$TMP/out.txt")"
grep -q "DECLARADO" "$TMP/out.txt" && ok "…pero queda a la vista, no se borra" || no "la diferencia declarada desapareció del informe"

# ---------------------------------------------------------------- 4. declarada SIN motivo = permiso, no decisión
config "$TMP/c4.json" '[{"grupo":"backend","rasgo":"reintento","fecha":"2026-09-01","revision":"2099-01-01"}]'
rc=$(corre "$TMP/c4.json")
[ "$rc" -eq 1 ] && ok "🔴 una diferencia declarada SIN motivo frena igual" || no "🔴 aceptó una excepción sin motivo (salió $rc)"

# ---------------------------------------------------------------- 5. declarada VENCIDA vuelve a frenar
config "$TMP/c5.json" '[{"grupo":"backend","rasgo":"reintento","motivo":"prueba","fecha":"2020-01-01","revision":"2020-06-01"}]'
rc=$(corre "$TMP/c5.json")
[ "$rc" -eq 1 ] && ok "una diferencia declarada VENCIDA vuelve a frenar" || no "🔴 una declaración vencida siguió tapando la divergencia"

# ---------------------------------------------------------------- 6. repo ausente NO es 'coincide'
rm -rf "$TMP/mundo"; mundo "$TMP/mundo" 'grep Too Many Requests' 'sin reintento'
rm -rf "$TMP/mundo/ProdB"
config "$TMP/c6.json"
rc=$(corre "$TMP/c6.json")
grep -q "no están en esta máquina" "$TMP/out.txt" \
  && ok "un repo que falta se DICE (no medido ≠ coincide)" || no "🔴 un repo ausente pasó en silencio: $(cat "$TMP/out.txt")"

# ---------------------------------------------------------------- 7. sin nada que comparar NO opina verde
rm -rf "$TMP/mundo"; mkdir -p "$TMP/mundo"
config "$TMP/c7.json"
rc=$(corre "$TMP/c7.json")
[ "$rc" -eq 2 ] && ok "sin repos que comparar sale 2 (no opina verde)" || no "🔴 sin nada que comparar salió $rc"

# ---------------------------------------------------------------- 8. una configuración ilegible sale 2
echo '{ roto' > "$TMP/c8.json"
rc=$(corre "$TMP/c8.json")
[ "$rc" -eq 2 ] && ok "una configuración ilegible sale 2, no 0" || no "🔴 configuración ilegible salió $rc"

# ---------------------------------------------------------------- 9. 🔴 UNANIMIDAD NO ES ACUERDO
# Este control compara los productos ENTRE SÍ, así que si los cinco dejan de hacer lo mismo a la
# vez, los cinco coinciden y sale verde. Para un rasgo con criterio ÚNICO escrito afuera (el guión
# scripts/ci/audit-dependencies.js) eso no alcanza: que NADIE restaure antes de escanear no es
# un acuerdo, es el mismo agujero en los cinco. Agregado 2026-09-01 con la revisión nocturna.
cfg_exigido(){ cat > "$1" <<CFG
{
  "raiz_por_defecto": "$TMP/mundo",
  "grupos": { "backend": [
    { "producto": "ProdA", "ruta": "ProdA/Back" },
    { "producto": "ProdB", "ruta": "ProdB/Back" } ] },
  "rasgos": [ { "id": "restaura", "que": "restaurar antes de escanear", "patron": "dotnet restore",
                "exigido": true, "criterio": "scripts/ci/audit-dependencies.js" } ],
  "diferencias_declaradas": ${2:-[]}
}
CFG
}
rm -rf "$TMP/mundo"; mundo "$TMP/mundo" 'sin restore aca' 'tampoco aca'
cfg_exigido "$TMP/c9.json"
rc=$(corre "$TMP/c9.json")
{ [ "$rc" -eq 1 ] && grep -q "NINGUNO lo hace" "$TMP/out.txt"; } \
  && ok "un rasgo EXIGIDO que nadie cumple es hallazgo, no acuerdo" \
  || no "🔴 los dos coincidieron en NO hacerlo y salió $rc (verde por unanimidad)"

# ---------------------------------------------------------------- 10. …y si los dos lo hacen, verde
rm -rf "$TMP/mundo"; mundo "$TMP/mundo" 'dotnet restore x' 'dotnet restore y'
cfg_exigido "$TMP/c10.json"
rc=$(corre "$TMP/c10.json")
[ "$rc" -eq 0 ] && ok "un rasgo exigido que todos cumplen sale verde" || no "🔴 exigido cumplido por todos salió $rc"

# ---------------------------------------------------------------- 11. un rasgo sin patrón NO pasa
# `new RegExp(undefined)` compila sin quejarse y no matchea nunca: sumaría una comparación que en
# realidad no se hizo, inflando el "todos coinciden" con una medición fantasma.
rm -rf "$TMP/mundo"; mundo "$TMP/mundo" 'x' 'x'
cat > "$TMP/c11.json" <<CFG
{ "raiz_por_defecto": "$TMP/mundo",
  "grupos": { "backend": [ { "producto": "ProdA", "ruta": "ProdA/Back" }, { "producto": "ProdB", "ruta": "ProdB/Back" } ] },
  "rasgos": [ { "que": "un comentario que se coló en la lista de rasgos" } ],
  "diferencias_declaradas": [] }
CFG
rc=$(corre "$TMP/c11.json")
[ "$rc" -eq 2 ] && ok "un rasgo sin id/patrón sale 2 (no se saltea en silencio)" || no "🔴 rasgo sin patrón salió $rc"

# ---------------------------------------------------------------- 12. 🔴 EL FALSO NEGATIVO REAL: el rasgo estaba en `pr:`, no en `trigger:`
# El backend de un producto del equipo (2026-09-02): `- tests/**` y `azure-pipelines.yml` aparecían en el archivo… dentro del
# bloque `pr:`, que para Azure Repos es inerte. El `trigger:` no los tenía, un merge sólo de
# pruebas NO construía en main, y el control decía "los cinco coinciden" porque buscaba en el
# archivo entero. Un rasgo con `bloque` mira SÓLO ese bloque de nivel raíz.
cfg_bloque(){ cat > "$1" <<CFG
{
  "raiz_por_defecto": "$TMP/mundo",
  "grupos": { "backend": [
    { "producto": "ProdA", "ruta": "ProdA/Back" },
    { "producto": "ProdB", "ruta": "ProdB/Back" } ] },
  "rasgos": [
    { "id": "dispara-tests",    "que": "dispara al tocar sólo las pruebas",  "patron": "^\\\\s*- tests?/\\\\*\\\\*", "bloque": "trigger" },
    { "id": "dispara-pipeline", "que": "dispara al tocar el propio pipeline", "patron": "^\\\\s*- azure-pipelines\\\\.yml", "bloque": "trigger" } ],
  "diferencias_declaradas": []
}
CFG
}
rm -rf "$TMP/mundo"
mundo "$TMP/mundo" \
"$(printf 'trigger:\n  paths:\n    include:\n      - src/**\n      - tests/**\n      - azure-pipelines.yml\npr: none\n')" \
"$(printf 'trigger:\n  paths:\n    include:\n      - src/**\n\n# comentario\npr:\n  paths:\n    include:\n      - src/**\n      - tests/**\n      - azure-pipelines.yml\n')"
cfg_bloque "$TMP/c12.json"
rc=$(corre "$TMP/c12.json")
[ "$rc" -eq 1 ] && ok "🔴 un rasgo que sólo está en el bloque pr: NO cuenta como presente (el caso FRESNO)" || no "🔴 dio por igual un trigger que no dispara con pruebas: salió $rc — $(cat "$TMP/out.txt")"
grep -q "sólo las pruebas" "$TMP/out.txt" && grep -q "propio pipeline" "$TMP/out.txt" \
  && ok "…y lo caza para los DOS rasgos (pruebas y pipeline)" || no "🔴 le faltó uno de los dos rasgos: $(cat "$TMP/out.txt")"
grep -q "NO lo tienen: ProdB" "$TMP/out.txt" && ok "…y señala al que lo tiene en el lugar equivocado" || no "no señaló a ProdB"

# ---------------------------------------------------------------- 13. …y con el rasgo en trigger: en los dos, verde
rm -rf "$TMP/mundo"
mundo "$TMP/mundo" \
"$(printf 'trigger:\n  paths:\n    include:\n      - tests/**\n      - azure-pipelines.yml\n')" \
"$(printf 'trigger:\n  branches:\n    include:\n      - main\n  paths:\n    include:\n      - tests/**\n      - azure-pipelines.yml\npr: none\n')"
cfg_bloque "$TMP/c13.json"
rc=$(corre "$TMP/c13.json")
[ "$rc" -eq 0 ] && ok "con el rasgo dentro de trigger: en los dos, verde (el bloque se lee entero hasta la próxima clave raíz)" || no "🔴 falso positivo con bloque: $(cat "$TMP/out.txt")"

# ---------------------------------------------------------------- 14. un grupo puede leer OTRO archivo (producción)
# Los 4 pipelines de producción viven en azure-pipelines-prod.yml; hasta el 2026-09-02 el control
# sólo leía azure-pipelines.yml y ningún rasgo de producción podía ponerse rojo.
rm -rf "$TMP/mundo"; mkdir -p "$TMP/mundo/ProdA/Back" "$TMP/mundo/ProdB/Back"
printf 'nada que ver\n' > "$TMP/mundo/ProdA/Back/azure-pipelines.yml"
printf 'nada que ver\n' > "$TMP/mundo/ProdB/Back/azure-pipelines.yml"
printf 'rollback-guard.sh\n' > "$TMP/mundo/ProdA/Back/azure-pipelines-prod.yml"
printf 'sube sin mirar\n' > "$TMP/mundo/ProdB/Back/azure-pipelines-prod.yml"
cat > "$TMP/c14.json" <<CFG
{
  "raiz_por_defecto": "$TMP/mundo",
  "grupos": {
    "backend": [ { "producto": "ProdA", "ruta": "ProdA/Back" }, { "producto": "ProdB", "ruta": "ProdB/Back" } ],
    "prod": { "archivo": "azure-pipelines-prod.yml", "solo_rasgos_que_lo_nombren": true,
              "repos": [ { "producto": "ProdA", "ruta": "ProdA/Back" }, { "producto": "ProdB", "ruta": "ProdB/Back" } ] } },
  "rasgos": [
    { "id": "retroceso", "que": "guarda de retroceso", "patron": "rollback-guard", "grupos": ["prod"] },
    { "id": "porton",    "que": "portón (sólo CI)",    "patron": "HarnessGate" } ],
  "diferencias_declaradas": []
}
CFG
rc=$(corre "$TMP/c14.json")
[ "$rc" -eq 1 ] && grep -q "prod · guarda de retroceso" "$TMP/out.txt" \
  && ok "🔴 un grupo con archivo propio (producción) se lee y puede ponerse rojo" || no "🔴 el grupo de producción no se evaluó: salió $rc — $(cat "$TMP/out.txt")"
grep -q "prod · portón" "$TMP/out.txt" && no "🔴 le pidió el portón a producción (solo_rasgos_que_lo_nombren no se respetó)" \
  || ok "…y a producción NO se le piden los rasgos que no lo nombran"

# ---------------------------------------------------------------- 15. llamar al criterio único cumple los tres rasgos NuGet
# (2026-09-02) Ese producto dejó de tener el bloque copiado y llama a audit-dependencies.js. El guion
# restaura, no pierde el fallo y frena por construcción: cumple los tres por definición.
cfg_nuget(){ cat > "$1" <<CFG
{
  "raiz_por_defecto": "$TMP/mundo",
  "grupos": { "backend": [ { "producto": "ProdA", "ruta": "ProdA/Back" }, { "producto": "ProdB", "ruta": "ProdB/Back" } ] },
  "rasgos": [
    { "id": "deps-restore-antes", "que": "restaurar antes", "patron": "(dotnet restore[\\\\s\\\\S]{0,800}?dotnet list[^\\\\n]*--vulnerable|audit-dependencies\\\\.js[^\\\\n]*--type nuget)", "exigido": true },
    { "id": "deps-fallo-nuget",   "que": "no perder el fallo", "patron": "(dotnet list[^\\\\n]*--vulnerable[\\\\s\\\\S]{0,300}?PIPESTATUS|audit-dependencies\\\\.js[^\\\\n]*--type nuget)", "exigido": true },
    { "id": "deps-frena-nuget",   "que": "frenar",            "patron": "(dotnet list[^\\\\n]*--vulnerable[\\\\s\\\\S]{0,900}?exit 1|audit-dependencies\\\\.js[^\\\\n]*--type nuget[^\\\\n]*--block)", "exigido": true } ],
  "diferencias_declaradas": []
}
CFG
}
INLINE="$(printf 'dotnet restore x.csproj\ndotnet list x.csproj package --vulnerable | tee r.txt\nLIST_EXIT=\${PIPESTATUS[0]}\nif grep High r.txt; then exit 1; fi\n')"
GUION="$(printf 'node tcg/scripts/ci/audit-dependencies.js --repo . --type nuget --project x.csproj --block\n')"
rm -rf "$TMP/mundo"; mundo "$TMP/mundo" "$INLINE" "$GUION"; cfg_nuget "$TMP/c15.json"
rc=$(corre "$TMP/c15.json")
[ "$rc" -eq 0 ] && ok "uno con el bloque copiado y otro que llama al guion único coinciden en los tres rasgos NuGet" || no "🔴 el que llama al guion salió como divergente: $(cat "$TMP/out.txt")"
GUION_SIN_FRENO="$(printf 'node tcg/scripts/ci/audit-dependencies.js --repo . --type nuget --project x.csproj\n')"
rm -rf "$TMP/mundo"; mundo "$TMP/mundo" "$INLINE" "$GUION_SIN_FRENO"; cfg_nuget "$TMP/c15b.json"
rc=$(corre "$TMP/c15b.json")
{ [ "$rc" -eq 1 ] && grep -q "frenar" "$TMP/out.txt"; } && ok "…pero llamarlo SIN --block no cuenta como frenar" || no "🔴 el guion sin --block pasó como si frenara: $(cat "$TMP/out.txt")"

# ---------------------------------------------------------------- 16. la ventana del freno npm no puede castigar al que declara deuda
# (2026-09-02) Con ventana de 900, los formularios de ese producto salían como "no frena" — y es el ÚNICO que
# declara deuda, o sea el más completo: su bloque de deuda mete ~600 caracteres entre el análisis
# y el primer `exit 1`. El control medía DISTANCIA, no conducta.
cfg_npm(){ cat > "$1" <<CFG
{
  "raiz_por_defecto": "$TMP/mundo",
  "grupos": { "frontend": [ { "producto": "ProdA", "ruta": "ProdA/Back" }, { "producto": "ProdB", "ruta": "ProdB/Back" } ] },
  "rasgos": [ { "id": "deps-frena-npm", "que": "frenar ante alto/crítico (npm)", "grupos": ["frontend"],
                "patron": "npm audit[^\\\\n]*[\\\\s\\\\S]{0,2000}?exit 1", "exigido": true } ],
  "diferencias_declaradas": []
}
CFG
}
SIMPLE="$(printf 'npm audit --audit-level=moderate\nif grep high r.txt; then\n  exit 1\nfi\n')"
RELLENO="$(head -c 600 /dev/zero | tr '\0' '#' | fold -w 80 | sed 's/^/# /')"
CON_DEUDA="$(printf 'npm audit --audit-level=moderate\n%s\nif grep high r.txt; then\n  exit 1\nfi\n' "$RELLENO")"
rm -rf "$TMP/mundo"; mundo "$TMP/mundo" "$SIMPLE" "$CON_DEUDA"; cfg_npm "$TMP/c16.json"
rc=$(corre "$TMP/c16.json")
[ "$rc" -eq 0 ] && ok "🔴 el que declara deuda (bloque largo antes del corte) NO sale como si no frenara" || no "🔴 falso positivo por distancia: salió $rc — $(cat "$TMP/out.txt")"
# …y el que DE VERDAD no frena sigue saliendo rojo
SIN_FRENO="$(printf 'npm audit --audit-level=moderate\nif grep high r.txt; then\n  echo aviso\nfi\n')"
rm -rf "$TMP/mundo"; mundo "$TMP/mundo" "$SIMPLE" "$SIN_FRENO"; cfg_npm "$TMP/c16b.json"
rc=$(corre "$TMP/c16b.json")
[ "$rc" -eq 1 ] && ok "…y el que sólo avisa sigue saliendo rojo" || no "🔴 dejó pasar a uno que no frena: salió $rc"

# ---------------------------------------------------------------- 17. los patrones REALES de NuGet aceptan el guion único con la ruta en una variable
# (2026-09-02) El backend de ese producto guarda la ruta en GUION="…/audit-dependencies.js" y lo invoca en OTRA
# línea: `node "$GUION" --repo . --type nuget … --block`. Con un patrón que exigía nombre e
# invocación en la MISMA línea, los tres rasgos daban a FRESNO por "no lo tiene" el mismo día que lo
# estrenó — y tres declaraciones viejas lo tapaban. Este caso lee los patrones del JSON de verdad.
JSON17="$(cd "$(dirname "${BASH_SOURCE[0]}")/../ci" && pwd)/product-parity.json"
# Entre la ruta y la invocación va lo que FRESNO tiene de verdad: ~1000 caracteres de comentarios.
RELLENO17="$(head -c 1000 /dev/zero | tr '\0' 'x' | fold -w 90 | sed 's/^/              # /')"
FIX17="$(printf 'GUION="$(Build.SourcesDirectory)/tycon-claude-guides/scripts/ci/audit-dependencies.js"\nif [ ! -f "$GUION" ]; then exit 1; fi\n%s\nnode "$GUION" --repo . --type nuget --project src/X.csproj --declared vulnerabilidades-pendientes.json --block\nrc=$?\n' "$RELLENO17")"
FIX17_SIN_FRENO="${FIX17/ --block/}"
if lista_real_de_productos; then
res17=$(node -e '
const c=require(process.argv[1]); const conFreno=process.argv[2], sinFreno=process.argv[3];
const ids=["deps-restore-antes","deps-fallo-nuget","deps-frena-nuget"]; const bad=[];
const rasgos=c.rasgos.filter(r=>ids.includes(r.id));
if (rasgos.length!==3) bad.push("faltan rasgos NuGet en el JSON");
for (const r of rasgos) {
  const re=new RegExp(r.patron);
  if (!re.test(conFreno)) bad.push(r.id+" no reconoce la invocación en dos líneas");
  if (r.id==="deps-frena-nuget" && re.test(sinFreno)) bad.push(r.id+" da por freno una invocación sin --block");
}
console.log(bad.join(" · "));' "$JSON17" "$FIX17" "$FIX17_SIN_FRENO")
[ -z "$res17" ] && ok "🔴 los 3 rasgos NuGet reales reconocen el guion único con la ruta en una variable (y el freno exige --block)" || no "🔴 $res17"
else
  sin_lista_real "17 (rasgos NuGet reales)"
fi

# ---------------------------------------------------------------- 18. 🔴 SE COMPARA LO PUBLICADO, NO EL DISCO
# La pregunta es "¿los cinco productos hacen lo mismo?", y eso se decide sobre lo que CORRE, o sea
# origin/main. El control leía el árbol de trabajo, así que un checkout parado en otra rama —lo
# normal: el dev trabaja en `dev`— se reportaba como divergencia del PRODUCTO. Medido el 2026-09-03:
# el backend de Lapacho, 29 commits atrás, producía CUATRO divergencias que en origin/main no
# existen. Un control que da falsas alarmas se apaga.
rm -rf "$TMP/mundo"; mundo "$TMP/mundo" 'grep Too Many Requests' 'grep Too Many Requests'
for r in ProdA ProdB; do
  ( cd "$TMP/mundo/$r/Back" && git init -q -b main . && git config user.email t@t && git config user.name t \
    && git add azure-pipelines.yml && git commit -qm publicado \
    && git remote add origin . && git update-ref refs/remotes/origin/main HEAD ) >/dev/null 2>&1
done
# el disco de ProdB se va a otra rama y PIERDE el rasgo — pero lo publicado lo sigue teniendo
( cd "$TMP/mundo/ProdB/Back" && git checkout -q -b dev && printf 'sin reintento\n' > azure-pipelines.yml \
  && git commit -qam "trabajo en curso" ) >/dev/null 2>&1
config "$TMP/c18.json"
rc=$(corre "$TMP/c18.json")
[ "$rc" -eq 0 ] && ok "🔴 un checkout parado en otra rama NO se reporta como divergencia del producto" \
  || no "🔴 el disco atrasado dio divergencia falsa (rc=$rc): $(grep -E '🔴' "$TMP/out.txt" | head -2)"

# ---------------------------------------------------------------- 19. …y si no hay nada publicado, se dice
rm -rf "$TMP/mundo"; mundo "$TMP/mundo" 'grep Too Many Requests' 'grep Too Many Requests'
config "$TMP/c19.json"
rc=$(corre "$TMP/c19.json")
grep -q "se compararon desde el DISCO" "$TMP/out.txt" \
  && ok "…y cuando no pudo leer lo publicado, lo DICE en vez de hacerlo pasar por medido" \
  || no "🔴 leyó el disco sin avisar: $(cat "$TMP/out.txt" | tail -3)"

# ---------------------------------------------------------------- 19b. 🔴 EN origin/main PERO NO EN EL DISCO → SE COMPARA IGUAL
# (2026-09-04, revisión de cierre.) El arreglo del caso 18 —"se lee lo publicado"— estaba ANULADO
# para el caso más común: había un `if (!fs.existsSync(f)) { ausentes++; continue; }` JUSTO ANTES de
# leer origin/main. O sea que un archivo que existe en lo publicado pero no en el árbol de trabajo
# —el clon parado en `dev`, que es donde trabaja el dev— sacaba al repo de la comparación ENTERA, en
# silencio, contándolo como "no está en esta máquina".
# Medido ese día: los pipelines de PRODUCCIÓN de FRESNO y de TIMBO no se compararon con nada, ni siquiera
# el freno de retroceso que está marcado `exigido`. El control decía "1 divergencia sobre 55"
# habiendo dejado dos repos afuera. "No medido" no puede leerse como "coincide".
rm -rf "$TMP/mundo"; mundo "$TMP/mundo" 'grep Too Many Requests' 'grep Too Many Requests'
for r in ProdA ProdB; do
  ( cd "$TMP/mundo/$r/Back" && git init -q -b main . && git config user.email t@t && git config user.name t \
    && git add azure-pipelines.yml && git commit -qm publicado \
    && git remote add origin . && git update-ref refs/remotes/origin/main HEAD ) >/dev/null 2>&1
done
# 🔴 ProdB BORRA el archivo del árbol de trabajo (como un clon en otra rama que no lo tiene todavía),
# pero lo publicado lo sigue teniendo, CON el rasgo.
rm -f "$TMP/mundo/ProdB/Back/azure-pipelines.yml"
config "$TMP/c19b.json"
rc=$(corre "$TMP/c19b.json")
if [ "$rc" -eq 0 ] && ! grep -q "no están en esta máquina" "$TMP/out.txt"; then
  ok "🔴 un archivo que está en origin/main pero no en el disco SE COMPARA (no se cuenta como ausente)"
else
  no "🔴 lo dejó afuera de la comparación (rc=$rc): $(grep -E 'no están en esta máquina|🔴' "$TMP/out.txt" | head -2)"
fi

# ---------------------------------------------------------------- 20. los patrones REALES de npm aceptan el guion único sobre la RAÍZ — y el de formularios sigue exigiendo el bucle
# (2026-09-03) El análisis de la raíz de los cinco formularios pasó a llamar a audit-dependencies.js
# (`--repo . --type npm … --block`) en vez del bloque `npm audit | tee` + grep copiado. Los tres
# rasgos de la raíz tienen que reconocerlo (como los de NuGet reconocen `--type nuget`), el de freno
# NO puede darse por cumplido sin `--block`, y `deps-por-formulario` —que antes se reconocía por el
# NOMBRE del guion— ya no puede: la raíz también lo llama ahora, así que ese patrón probaría el bucle
# por formulario con sólo tener el de la raíz. Este caso lee los patrones del JSON de verdad.
JSON20="$(cd "$(dirname "${BASH_SOURCE[0]}")/../ci" && pwd)/product-parity.json"
RAIZ20="$(printf 'AUD="$(Agent.TempDirectory)/arnes-ci/audit-dependencies.js"\n[ -f "$AUD" ] || exit 1\nnode "$AUD" --repo . --type npm --declared vulnerabilidades-pendientes.json --block\nRC=$?\n')"
RAIZ20_SIN_FRENO="${RAIZ20/ --block/}"
FORM20="$(printf 'for f in $FORMS; do\n  node "$AUD" --repo "$f" --type npm --declared ../vulnerabilidades-formularios-pendientes.json --block || FALLAS=1\ndone\n')"
if lista_real_de_productos; then
res20=$(node -e '
const c=require(process.argv[1]); const [raiz, raizSinFreno, form]=process.argv.slice(2); const bad=[];
for (const id of ["deps-fallo-npm","deps-frena-npm","audit-raiz-no-aprueba-sin-poder-mirar"]) {
  const r=c.rasgos.find(x=>x.id===id); if(!r){bad.push("falta "+id);continue;}
  const re=new RegExp(r.patron);
  if(!re.test(raiz)) bad.push(id+" no reconoce al guion único sobre la raíz");
  if(id==="deps-frena-npm" && re.test(raizSinFreno)) bad.push(id+" da por freno una invocación sin --block");
}
const pf=c.rasgos.find(x=>x.id==="deps-por-formulario");
if(!pf) bad.push("falta deps-por-formulario");
else { const re=new RegExp(pf.patron);
  if(!re.test(form)) bad.push("deps-por-formulario no reconoce el bucle por formulario");
  if(re.test(raiz)) bad.push("🔴 deps-por-formulario se da por cumplido con SOLO el análisis de la raíz"); }
console.log(bad.join(" · "));' "$JSON20" "$RAIZ20" "$RAIZ20_SIN_FRENO" "$FORM20")
[ -z "$res20" ] && ok "🔴 los patrones npm reales aceptan el guion único sobre la raíz, exigen --block, y el de formularios sigue exigiendo el bucle" \
  || no "🔴 patrones npm reales: $res20"
else
  sin_lista_real "20 (patrones npm reales)"
fi

# ---------------------------------------------------------------- 20. los rasgos del DESPLIEGUE de plugins
# (2026-09-03) El control daba los cinco productos coincidiendo mientras otro producto subía el paquete
# marcándolo como actual en el mismo pedido —el modo que deja al host sin ninguna versión cargada
# ante una migración pendiente— desde hacía meses. No lo levantaba porque NINGUNO de sus 53 rasgos
# miraba cómo despliega cada uno. Lo encontró una pregunta del dev, no el control. Estos dos rasgos
# cierran ese hueco: desplegar por el guion compartido, y pasarle al humo el identificador de
# compilación (que la versión sola no distingue dos builds del mismo número).
JSON20="$(cd "$(dirname "${BASH_SOURCE[0]}")/../ci" && pwd)/product-parity.json"
BUENO20="$(printf -- 'bash "$DESPLEGAR" \\\n  --url "$(URL)" --zip "$ZIP" --environment staging\nbash "$HUMO" "$(URL)" u p "$NOMBRE" "$VERSION" "$HASH"\n')"
VIEJO20="$(printf -- 'curl -F "file=@$ZIP" -F "setAsDefault=true"\nbash "$HUMO" "$(URL)" u p "$NOMBRE" "$VERSION"\n')"
if lista_real_de_productos; then
res20=$(node -e '
const c=require(process.argv[1]); const [bueno,viejo]=process.argv.slice(2); const bad=[];
for (const id of ["despliegue-por-guion-compartido","humo-con-identificador-de-build"]) {
  const r=c.rasgos.find(x=>x.id===id);
  if(!r){bad.push("falta el rasgo "+id);continue;}
  const re=()=>new RegExp(r.patron);
  if(!re().test(bueno)) bad.push(id+" no reconoce la forma canónica");
  if(re().test(viejo)) bad.push("🔴 "+id+" da por bueno el pipeline viejo");
}
console.log(bad.join(" · "));' "$JSON20" "$BUENO20" "$VIEJO20")
[ -z "$res20" ] && ok "🔴 los rasgos del despliegue distinguen la forma canónica de la que tenía Ceibo" \
  || no "🔴 rasgos del despliegue: $res20"
else
  sin_lista_real "20b (rasgos del despliegue reales)"
fi

# ---------------------------------------------------------------- 21. un rasgo que nombra un guion renombrado acepta LOS DOS nombres
# (story 8.9, tanda C2) Los guiones de scripts/ci pasaron al inglés. Los pipelines de los productos de hoy siguen
# llamando al nombre viejo (su reemplazo los atiende hasta el retiro) y un producto nuevo nace con el nuevo: un patrón
# que aceptara uno solo pondría roja la paridad entre productos que no cambiaron nada, o dejaría afuera al producto
# nuevo. Este caso lee los patrones del JSON de verdad y arma los nombres desde el mapa de renombres (no literales).
MAPA21="$AQUI/scripts/lib/renames.json"
if [ ! -f "$MAPA21" ]; then
  ok "NO MEDIDO: sin el mapa de renombres (copia pública) — el caso 21 no aplica"
else
  res21=$(node -e '
const c=require(process.argv[1]); const m=require(process.argv[2]); const path=require("path"); const bad=[]; let vistos=0;
const pares=m.entries.filter(e=>e&&e.kind==="file"&&typeof e.old==="string"&&e.old.startsWith("scripts/ci/")&&typeof e.new==="string")
  .map(e=>[path.posix.basename(e.old), path.posix.basename(e.new)]);
for (const r of c.rasgos) {
  if (typeof r.patron!=="string") continue;
  for (const [viejo,nuevo] of pares) {
    // un paso de pipeline que llama al guion por el artefacto, con nombre de paso adelante (un rasgo puede anclarse a él)
    const paso=(g)=>"  name: ChangedForms\n    bash \"$(Agent.TempDirectory)/arnes-ci/"+g+"\"\n";
    const re=new RegExp(r.patron);
    const conViejo=re.test(paso(viejo)), conNuevo=re.test(paso(nuevo));
    if (!conViejo && !conNuevo) continue;
    vistos++;
    if (conViejo!==conNuevo) bad.push(r.id+" acepta "+(conViejo?viejo:nuevo)+" y no "+(conViejo?nuevo:viejo));
  }
}
if (!vistos) bad.push("ningún rasgo nombra un guion renombrado de scripts/ci: el caso no mide nada");
console.log(bad.join(" · "));' "$AQUI/scripts/ci/product-parity.json" "$MAPA21")
  [ -z "$res21" ] && ok "🔴 cada rasgo que nombra un guion renombrado acepta el nombre viejo (productos de hoy) y el nuevo (producto nuevo)" \
    || no "🔴 rasgos con un solo nombre: $res21"
fi

# ---------------------------------------------------------------- 8.10.3 A · T2 (AC 3): «sin productos» declarado a propósito
# ParityControl_ExplicitNoProducts_ExitsZeroAndSaysSo — la copia pública trae un product-parity.json sintético sin productos:
# el control dice que no comparó nada y sale 0, pero SÓLO con la marca explícita; sin ella, lo de siempre (2).
cat > "$TMP/c810a.json" <<'CFG'
{ "sin_productos": "copia pública: los productos del equipo no viajan", "grupos": {}, "rasgos": [], "diferencias_declaradas": [] }
CFG
rc=$(cd "$TMP" && node "$CHK" --config "$TMP/c810a.json" >"$TMP/out.txt" 2>&1; echo $?)
{ [ "$rc" -eq 0 ] && grep -q 'no hay productos declarados' "$TMP/out.txt"; } \
  && ok "8.10.3 · sin productos declarados a propósito: sale 0 y lo dice" || no "🔴 8.10.3 · sin productos a propósito salió $rc: $(cat "$TMP/out.txt")"
cat > "$TMP/c810b.json" <<'CFG'
{ "grupos": {}, "rasgos": [], "diferencias_declaradas": [] }
CFG
rc=$(cd "$TMP" && node "$CHK" --config "$TMP/c810b.json" >"$TMP/out.txt" 2>&1; echo $?)
[ "$rc" -eq 2 ] && ok "8.10.3 · grupos vacíos SIN la marca siguen saliendo 2" || no "🔴 8.10.3 · grupos vacíos sin la marca salieron $rc"
printf '%s\n' '{ "sin_productos": "  ", "grupos": {}, "rasgos": [], "diferencias_declaradas": [] }' > "$TMP/c810v.json"
rc=$(cd "$TMP" && node "$CHK" --config "$TMP/c810v.json" >"$TMP/out.txt" 2>&1; echo $?)
[ "$rc" -eq 2 ] && ok "8.10.3 · una marca sin motivo (vacía) sale 2" || no "🔴 8.10.3 · marca vacía salió $rc"
cat > "$TMP/c810c.json" <<CFG
{ "sin_productos": "x", "raiz_por_defecto": "$TMP/mundo", "grupos": { "backend": [ { "producto": "ProdA", "ruta": "ProdA/Back" } ] }, "rasgos": [], "diferencias_declaradas": [] }
CFG
rc=$(cd "$TMP" && node "$CHK" --config "$TMP/c810c.json" >"$TMP/out.txt" 2>&1; echo $?)
[ "$rc" -eq 2 ] && ok "8.10.3 · la marca con grupos es una contradicción: sale 2" || no "🔴 8.10.3 · marca con grupos salió $rc"

echo "─────────────"
if [ "$fallos" -eq 0 ]; then echo "✅ paridad-entre-productos: todo verde"; exit 0; else echo "❌ paridad-entre-productos: $fallos falla(s)"; exit 1; fi
