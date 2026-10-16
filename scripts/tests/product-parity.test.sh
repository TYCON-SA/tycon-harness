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
# 2026-10-16: la lista real es de la organización y vive en su repo de operaciones. Se busca como la busca el control sin
# --config (`config-path`): en la máquina de quien mantiene el arnés, la del clon de operaciones que declara; en la CI y
# en la máquina de un dev, la copia del arnés (la marca «sin productos»). Si el control no puede decir cuál, el motivo
# es ROJO: no hay lista que medir y eso no es la copia pública.
LISTA_ORG="$(node "$CHK" config-path 2>"$TMP/lista-org.err")" || LISTA_ORG=""
if [ -z "$LISTA_ORG" ]; then ESTADO_LISTA="roto:$(head -1 "$TMP/lista-org.err" | sed 's/^🔴 //')"; else
ESTADO_LISTA="$(node -e 'try { const c=require(process.argv[1]); if (c && typeof c.sin_productos === "string" && c.sin_productos.trim()) console.log("copia"); else if (c && c.grupos && Object.keys(c.grupos).length) console.log("real"); else console.log("roto:sin grupos y sin «sin_productos»"); } catch (e) { console.log("roto:" + e.message.split("\n")[0]); }' "$LISTA_ORG")"; fi
lista_real_de_productos(){ [ "$ESTADO_LISTA" = real ]; }
# lo que dice un caso que lee la lista real cuando no la hay: NO MEDIDO en la copia, rojo si no se pudo leer
sin_lista_real(){ # <caso>
  case "$ESTADO_LISTA" in
    copia) ok "NO MEDIDO: sin la lista real de productos (copia pública) — el caso $1 lee los patrones del JSON de verdad" ;;
    *) no "🔴 el caso $1 no pudo leer la lista de productos de la organización (${ESTADO_LISTA#roto:}) — no medido NO es «copia pública»" ;;
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
JSON17="$LISTA_ORG"
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
JSON20="$LISTA_ORG"
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
JSON20="$LISTA_ORG"
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
elif ! lista_real_de_productos; then
  sin_lista_real "21 (guiones renombrados)"
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
console.log(bad.join(" · "));' "$LISTA_ORG" "$MAPA21")
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

# ---------------------------------------------------------------- las plantillas del alta de un producto (paquete bizuit)
# NewProductTemplates_RenderedProduct_PassesThePipelineControls — un producto de juguete armado con las plantillas de
# packs/bizuit/new-product-templates/ (marcadores reemplazados con nombres inventados) no deja ningún marcador vivo, y
# sus pipelines pasan los controles de pipeline del arnés. Si una plantilla se queda atrás de los productos —un
# disparador que construye con un merge de sólo documentación, un paso que publica con lo anterior en rojo—, esto lo dice
# antes del próximo alta, no después.
TPL="$AQUI/packs/bizuit/new-product-templates"
if [ ! -d "$TPL/pipelines" ]; then
  no "🔴 plantillas del alta: no está $TPL/pipelines"
else
  J="$TMP/juguete"; mkdir -p "$J/back" "$J/forms" "$J/stories"
  rend(){ sed -e 's/{{PRODUCT}}/ACME/g' -e 's/{{PRODUCT_LOWER}}/acme/g' -e 's/{{PRODUCT_DESCRIPTION}}/producto de prueba/g' \
    -e 's/{{BACKEND_REPO}}/AcmeBZExtBackend/g' -e 's/{{FORMS_REPO}}/AcmeBZExtForms/g' -e 's/{{STORIES_REPO}}/AcmeProyecto/g' \
    -e 's/{{PLUGIN}}/acmebzextbackend/g' -e 's#{{ADO_ORG_URL}}#https://dev.azure.com/acme#g' -e 's/{{ADO_PROJECT}}/ACME/g' \
    -e 's/{{ADO_WORK_ITEM_TYPE}}/User Story/g' -e 's#{{SERVER_URL}}#https://staging.acme.example#g' \
    -e 's#{{PRODUCTION_URL}}#https://bizuit.acme.example#g' -e 's/{{SQL_HOST}}/localhost/g' -e 's/{{DATABASE}}/AcmeDb/g' \
    -e 's/{{TABLE_PREFIX}}/AC_/g' -e 's/{{DOTNET_SDK}}/9.0.x/g' -e 's/{{DATE}}/2026-10-14/g' "$1" > "$2"; }
  rend "$TPL/pipelines/backend-ci.yml" "$J/back/azure-pipelines.yml"
  rend "$TPL/pipelines/backend-prod.yml" "$J/back/azure-pipelines-prod.yml"
  rend "$TPL/pipelines/forms-ci.yml" "$J/forms/azure-pipelines.yml"
  rend "$TPL/pipelines/forms-prod.yml" "$J/forms/azure-pipelines-prod.yml"
  rend "$TPL/pipelines/stories-gate.yml" "$J/stories/azure-pipelines.yml"
  for d in backend forms stories common; do for f in "$TPL/$d"/*; do
    case "$f" in *.template) continue ;; esac   # el catálogo de producción se escribe con el editor, nunca con el shell
    rend "$f" "$J/$( [ "$d" = backend ] && echo back || { [ "$d" = common ] && echo stories || echo "$d"; })/$(basename "$f")"
  done; done
  rc=$(node "$AQUI/scripts/ci/check-unreplaced-placeholders.js" "$J/back" "$J/forms" "$J/stories" >"$TMP/out.txt" 2>&1; echo $?)
  [ "$rc" -eq 0 ] && ok "plantillas del alta: el producto de juguete no deja ningún marcador vivo" \
    || no "🔴 plantillas del alta: marcadores vivos (salió $rc): $(cat "$TMP/out.txt")"
  YMLS="$J/back/azure-pipelines.yml $J/back/azure-pipelines-prod.yml $J/forms/azure-pipelines.yml $J/forms/azure-pipelines-prod.yml $J/stories/azure-pipelines.yml"
  for c in check-stage-dependencies check-conditional-writes check-tolerant-steps check-artifact-paths; do
    # shellcheck disable=SC2086
    rc=$(node "$AQUI/scripts/ci/$c.js" $YMLS >"$TMP/out.txt" 2>&1; echo $?)
    [ "$rc" -eq 0 ] && ok "plantillas del alta: $c en verde sobre los cinco pipelines" \
      || no "🔴 plantillas del alta: $c salió $rc: $(tail -5 "$TMP/out.txt")"
  done
  rc=$(node "$AQUI/scripts/ci/check-trigger-without-docs.js" --file "$J/back/azure-pipelines.yml" --file "$J/forms/azure-pipelines.yml" >"$TMP/out.txt" 2>&1; echo $?)
  [ "$rc" -eq 0 ] && ok "plantillas del alta: ningún pipeline construye con un merge de sólo documentación" \
    || no "🔴 plantillas del alta: check-trigger-without-docs salió $rc: $(tail -6 "$TMP/out.txt")"
  if python3 -c 'import yaml' >/dev/null 2>&1; then
    rotos=""; for y in $YMLS; do python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]))' "$y" >/dev/null 2>&1 || rotos="$rotos $(basename "$(dirname "$y")")/$(basename "$y")"; done
    [ -z "$rotos" ] && ok "plantillas del alta: los cinco pipelines parsean" || no "🔴 plantillas del alta: no parsean:$rotos"
  else
    ok "NO MEDIDO: sin python3 con yaml no puedo parsear los pipelines de las plantillas — no es un verde"
  fi
fi

# NewProductTemplates_HonorEveryTrait — con la lista real de productos, cada rasgo que le aplica a un grupo se cumple en
# la plantilla de ese grupo (salvo las diferencias declaradas). Un producto nuevo nace igual que los que ya están al día.
if lista_real_de_productos; then
  res=$(node -e '
const fs=require("fs"),path=require("path");
const [cfgP,tpl,chk]=process.argv.slice(1);
const {bloqueRaiz,normalizarGrupo}=require(chk);
const cfg=JSON.parse(fs.readFileSync(cfgP,"utf8"));
const files={backend:["backend-ci.yml"],frontend:["forms-ci.yml"],formularios:["forms-ci.yml"],prod:["backend-prod.yml","forms-prod.yml"]};
const decl=new Set((cfg.diferencias_declaradas||[]).map(d=>d.grupo+"/"+d.rasgo));
const bad=[]; let vistos=0;
for (const [g,def] of Object.entries(cfg.grupos||{})) {
  const G=normalizarGrupo(def); if (!files[g]) continue;
  for (const r of cfg.rasgos||[]) {
    if (!(r.grupos ? r.grupos.includes(g) : !G.soloExplicitos)) continue;
    const rx=new RegExp(r.patron,"m");
    for (const f of files[g]) {
      const t=fs.readFileSync(path.join(tpl,f),"utf8"); vistos++;
      if (!rx.test(r.bloque ? (bloqueRaiz(t,r.bloque)||"") : t) && !decl.has(g+"/"+r.id)) bad.push(g+"/"+r.id+" en "+f);
    }
  }
}
if (!vistos) bad.push("no se comparó ningún rasgo: el caso no mide nada");
console.log(bad.join(" · "));' "$LISTA_ORG" "$TPL/pipelines" "$CHK")
  [ -z "$res" ] && ok "plantillas del alta: cumplen cada rasgo de la lista real de productos" \
    || no "🔴 plantillas del alta: rasgos que no cumplen: $res"
else
  sin_lista_real "plantillas-cumplen-los-rasgos"
fi

# ================================================================ story 2.25 — el resultado fechado y la lista para clonar
# La revisión nocturna de dependencias corre el control cada noche y guarda lo que dice en un archivo con fecha
# (`--out`), que lee el sitio de la organización. Lo que imprime y su código de salida no cambian (decisión 10).
# publicado <dir>: el azure-pipelines.yml de <dir> queda en un commit y en origin/main (como un clon de la noche)
publicado(){ ( cd "$1" && git init -q -b main . && git config user.email t@t && git config user.name t \
  && git add -A && git commit -qm publicado && git remote add origin . && git update-ref refs/remotes/origin/main HEAD ) >/dev/null 2>&1; }
yml(){ mkdir -p "$1"; printf '%s\n' "$2" > "$1/azure-pipelines.yml"; }   # yml <dir> <contenido>
corre_out(){ node "$CHK" --config "$1" --root "$2" "${@:3}" >"$TMP/out.txt" 2>&1; echo $?; }
# chk <archivo> <cuerpo js>: el cuerpo recibe `r` (el JSON) y `bad` (lo que falla); imprime los problemas o nada
chk(){ node -e 'const fs=require("fs"); let r; try { r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); } catch (e) { console.log("no hay archivo legible: "+String(e.message).split("\n")[0]); process.exit(0); }
const bad=[]; new Function("r","bad",process.argv[2])(r,bad); console.log(bad.join(" · "));' "$1" "$2"; }
CLAVES='["v","fecha","generated_at","estado","motivo","comparaciones","divergencias","declaradas","vencidas","grupos_sin_comparar","no_medidos","desde_disco","por_ruta","rc"]'
cfg3(){ # <archivo> <rasgos json> [diferencias json] — tres productos de backend
  cat > "$1" <<CFG
{ "grupos": { "backend": [
    { "producto": "ProdA", "ruta": "ProdA/Back" }, { "producto": "ProdB", "ruta": "ProdB/Back" }, { "producto": "ProdC", "ruta": "ProdC/Back" } ] },
  "rasgos": $2,
  "diferencias_declaradas": ${3:-[]} }
CFG
}
R_REINTENTO='[ { "id": "reintento", "que": "reintento del ingreso", "patron": "Too Many Requests" } ]'

# ---------------------------------------------------------------- T1 · Out_ClavesExactas_Medido @story-2.25 @ac-1 @ac-2
W="$TMP/w1"; rm -rf "$W"
for p in ProdA ProdB ProdC; do yml "$W/$p/Back" 'grep Too Many Requests'; publicado "$W/$p/Back"; done
cfg3 "$TMP/t1.json" "$R_REINTENTO"
rc=$(corre_out "$TMP/t1.json" "$W"); cp "$TMP/out.txt" "$TMP/t1-sin-out.txt"
[ -e "$TMP/r1" ] && no "T1 algo creó $TMP/r1 sin --out"
rc=$(corre_out "$TMP/t1.json" "$W" --out "$TMP/r1/sub/paridad.json")
res=$(chk "$TMP/r1/sub/paridad.json" "
const want=$CLAVES; const got=Object.keys(r);
if (JSON.stringify([...got].sort())!==JSON.stringify([...want].sort())) bad.push('claves: '+got.join(','));
if (r.v!==1) bad.push('v='+r.v);
if (r.fecha!==new Date().toISOString().slice(0,10)) bad.push('fecha='+r.fecha);
if (!/^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(\\.\\d+)?Z$/.test(r.generated_at||'')) bad.push('generated_at='+r.generated_at);
if (r.estado!=='medido') bad.push('estado='+r.estado);
if (r.motivo!==null) bad.push('motivo='+r.motivo);
if (r.rc!==0) bad.push('rc='+r.rc);
if (r.comparaciones!==1) bad.push('comparaciones='+r.comparaciones);
if (!Array.isArray(r.por_ruta)||r.por_ruta.length!==3) bad.push('por_ruta='+JSON.stringify(r.por_ruta));
for (const e of r.por_ruta||[]) if (e.estado!=='medido'||e.divergencias!==0||e.vencidas!==0||e.motivo!==null) bad.push('por_ruta '+JSON.stringify(e));
")
{ [ "$rc" -eq 0 ] && [ -z "$res" ]; } && ok "T1 Out_ClavesExactas_Medido: las 14 claves, medido, por_ruta con una entrada por ruta" \
  || no "🔴 T1 rc=$rc: ${res:-sin detalle} — $(tail -3 "$TMP/out.txt")"
cmp -s "$TMP/out.txt" "$TMP/t1-sin-out.txt" && ok "T1 …y la salida de texto es la misma con y sin --out" \
  || no "🔴 T1 la salida de texto cambió con --out: $(diff "$TMP/t1-sin-out.txt" "$TMP/out.txt" | head -4)"

# ---------------------------------------------------------------- T2 · Out_Divergencia_YExigidoQueNadieCumple @ac-1
W="$TMP/w2"; rm -rf "$W"
yml "$W/ProdA/Back" 'grep Too Many Requests'; yml "$W/ProdB/Back" 'sin reintento'; yml "$W/ProdC/Back" 'grep Too Many Requests'
for p in ProdA ProdB ProdC; do publicado "$W/$p/Back"; done
cfg3 "$TMP/t2.json" '[ { "id": "reintento", "que": "reintento del ingreso", "patron": "Too Many Requests" },
  { "id": "restaura", "que": "restaurar antes de escanear", "patron": "dotnet restore", "exigido": true } ]'
rc=$(corre_out "$TMP/t2.json" "$W" --out "$TMP/r2.json")
res=$(chk "$TMP/r2.json" "
const d=r.divergencias||[]; if (d.length!==2) bad.push('divergencias='+JSON.stringify(d));
const a=d.find(x=>x.rasgo==='reintento'), b=d.find(x=>x.rasgo==='restaura');
if (!a||a.grupo!=='backend'||a.que!=='reintento del ingreso'||JSON.stringify(a.tienen)!=='[\"ProdA\",\"ProdC\"]'||JSON.stringify(a.no_tienen)!=='[\"ProdB\"]'||'ninguno' in a) bad.push('reintento='+JSON.stringify(a));
if (!b||JSON.stringify(b.tienen)!=='[]'||b.ninguno!==true||(b.no_tienen||[]).length!==3) bad.push('restaura='+JSON.stringify(b));
if (r.rc!==1||r.estado!=='medido') bad.push('rc='+r.rc+' estado='+r.estado);
// cada repo cuenta los rasgos en que quedó del lado distinto: B en los dos, A y C sólo en el que nadie cumple
const pr=Object.fromEntries((r.por_ruta||[]).map(e=>[e.ruta,e.divergencias]));
if (pr['ProdB/Back']!==2||pr['ProdA/Back']!==1||pr['ProdC/Back']!==1) bad.push('por_ruta='+JSON.stringify(pr));
")
{ [ "$rc" -eq 1 ] && [ -z "$res" ]; } && ok "T2 Out_Divergencia_YExigidoQueNadieCumple: tienen/no_tienen, ninguno: true y las cantidades por ruta" \
  || no "🔴 T2 rc=$rc: ${res:-sin detalle}"

# ---------------------------------------------------------------- T3 · Out_Parcial_RepoAusenteYDesdeDisco @ac-2 @ac-4
W="$TMP/w3"; rm -rf "$W"
yml "$W/ProdA/Back" 'grep Too Many Requests'; yml "$W/ProdB/Back" 'grep Too Many Requests'; publicado "$W/ProdA/Back"; publicado "$W/ProdB/Back"
yml "$W/ProdD/Back" 'grep Too Many Requests'                  # sin origin/main: se lee del disco
mkdir -p "$W/ProdE/Back"                                      # la carpeta está, el archivo no (ni publicado ni en disco)
yml "$W/ProdF/Web" 'grep Too Many Requests'; publicado "$W/ProdF/Web"   # un grupo de un solo repo
cat > "$TMP/t3.json" <<'CFG'
{ "grupos": {
    "backend": [ { "producto": "ProdA", "ruta": "ProdA/Back" }, { "producto": "ProdB", "ruta": "ProdB/Back" },
                 { "producto": "ProdC", "ruta": "ProdC/Back" }, { "producto": "ProdD", "ruta": "ProdD/Back" },
                 { "producto": "ProdE", "ruta": "ProdE/Back" } ],
    "sitio": [ { "producto": "ProdF", "ruta": "ProdF/Web" } ] },
  "rasgos": [ { "id": "reintento", "que": "reintento del ingreso", "patron": "Too Many Requests" } ],
  "diferencias_declaradas": [] }
CFG
rc=$(corre_out "$TMP/t3.json" "$W" --out "$TMP/r3.json")
res=$(chk "$TMP/r3.json" "
if (r.estado!=='parcial'||r.rc!==0) bad.push('estado='+r.estado+' rc='+r.rc);
const nm=Object.fromEntries((r.no_medidos||[]).map(x=>[x.producto,x]));
if (!nm.ProdC||nm.ProdC.motivo!=='no está en la carpeta de los clones'||nm.ProdC.ruta!=='ProdC/Back'||nm.ProdC.grupo!=='backend') bad.push('ProdC='+JSON.stringify(nm.ProdC));
if (!nm.ProdE||nm.ProdE.motivo!=='no se pudo leer azure-pipelines.yml ni de origin/main ni del disco') bad.push('ProdE='+JSON.stringify(nm.ProdE));
if (JSON.stringify(r.desde_disco)!=='[{\"grupo\":\"backend\",\"producto\":\"ProdD\"}]') bad.push('desde_disco='+JSON.stringify(r.desde_disco));
if ((r.grupos_sin_comparar||[]).length!==1||r.grupos_sin_comparar[0].grupo!=='sitio'||!r.grupos_sin_comparar[0].motivo) bad.push('grupos_sin_comparar='+JSON.stringify(r.grupos_sin_comparar));
const pr=Object.fromEntries((r.por_ruta||[]).map(e=>[e.ruta,e.estado+'/'+e.motivo]));
const want={'ProdA/Back':'medido/null','ProdB/Back':'medido/null','ProdC/Back':'no_medido/sin_clon','ProdD/Back':'desde_disco/null','ProdE/Back':'no_medido/ilegible','ProdF/Web':'no_medido/grupo_sin_comparar'};
if (JSON.stringify(pr)!==JSON.stringify(want)) bad.push('por_ruta='+JSON.stringify(pr));
")
{ [ "$rc" -eq 0 ] && [ -z "$res" ]; } && ok "T3 Out_Parcial_RepoAusenteYDesdeDisco: parcial con salida 0, los dos motivos, desde el disco y el grupo sin comparar" \
  || no "🔴 T3 rc=$rc: ${res:-sin detalle}"

# ---------------------------------------------------------------- T4 · Out_NoMedido_ConfigRotaORasgoSinPatron @ac-2
echo '{ roto' > "$TMP/t4a.json"
cfg3 "$TMP/t4b.json" '[ { "id": "sin-patron", "que": "un rasgo sin patrón" } ]'
cfg3 "$TMP/t4c.json" "$R_REINTENTO" '[{"grupo":"backend","rasgo":"reintento","motivo":"x","fecha":"2026-09-01"}]'
t4=""
for c in a:2 b:2 c:1; do
  k="${c%%:*}"; want="${c##*:}"
  rc=$(corre_out "$TMP/t4$k.json" "$TMP/w1" --out "$TMP/r4$k.json")
  res=$(chk "$TMP/r4$k.json" "if (r.estado!=='no_medido'||typeof r.motivo!=='string'||!r.motivo||r.rc!==$want) bad.push('estado='+r.estado+' motivo='+r.motivo+' rc='+r.rc);")
  { [ "$rc" -eq "$want" ] && [ -z "$res" ]; } || t4="$t4 [$k: rc=$rc ${res}]"
done
[ -z "$t4" ] && ok "T4 Out_NoMedido_ConfigRotaORasgoSinPatron: no_medido con motivo; rc 2, 2 y 1 (los de siempre)" || no "🔴 T4$t4"

# ---------------------------------------------------------------- T5 · Out_SinProductos @ac-2 @ac-9
# La copia pública trae la marca; con la lista real debajo (repo del equipo) se usa una igual.
if [ "$ESTADO_LISTA" = copia ]; then T5CFG="$AQUI/scripts/ci/product-parity.json"; else
  T5CFG="$TMP/t5.json"; printf '%s\n' '{ "sin_productos": "copia pública", "grupos": {}, "rasgos": [], "diferencias_declaradas": [] }' > "$T5CFG"; fi
rc=$(corre_out "$T5CFG" "$TMP/w1" --out "$TMP/r5.json")
res=$(chk "$TMP/r5.json" "if (r.estado!=='sin_productos'||r.comparaciones!==0||r.rc!==0||!r.motivo) bad.push(JSON.stringify(r));")
{ [ "$rc" -eq 0 ] && [ -z "$res" ]; } && ok "T5 Out_SinProductos: sin_productos, 0 comparaciones, rc 0" || no "🔴 T5 rc=$rc: $res"

# ---------------------------------------------------------------- T6 · Vencida_NoAmparaYSigueComparando @ac-3
W="$TMP/w6"; rm -rf "$W"
yml "$W/ProdA/Back" 'grep Too Many Requests'; yml "$W/ProdB/Back" 'sin reintento'
yml "$W/ProdA/Front" 'npm audit'; yml "$W/ProdB/Front" 'nada'
for d in ProdA/Back ProdB/Back ProdA/Front ProdB/Front; do publicado "$W/$d"; done
cat > "$TMP/t6.json" <<'CFG'
{ "grupos": {
    "backend":  [ { "producto": "ProdA", "ruta": "ProdA/Back" },  { "producto": "ProdB", "ruta": "ProdB/Back" } ],
    "frontend": [ { "producto": "ProdA", "ruta": "ProdA/Front" }, { "producto": "ProdB", "ruta": "ProdB/Front" } ] },
  "rasgos": [ { "id": "reintento", "que": "reintento del ingreso", "patron": "Too Many Requests", "grupos": ["backend"] },
              { "id": "audita",    "que": "audita npm",            "patron": "npm audit",          "grupos": ["frontend"] } ],
  "diferencias_declaradas": [ { "grupo": "backend", "rasgo": "reintento", "motivo": "prueba", "fecha": "2020-01-01", "revision": "2020-06-01" } ] }
CFG
rc=$(corre_out "$TMP/t6.json" "$W" --out "$TMP/r6.json")
res=$(chk "$TMP/r6.json" "
const d=(r.divergencias||[]).map(x=>x.grupo+'/'+x.rasgo).sort().join(',');
if (d!=='backend/reintento,frontend/audita') bad.push('divergencias='+d);
if (JSON.stringify(r.vencidas)!=='[{\"grupo\":\"backend\",\"rasgo\":\"reintento\",\"revision\":\"2020-06-01\"}]') bad.push('vencidas='+JSON.stringify(r.vencidas));
if ((r.declaradas||[]).length!==0) bad.push('declaradas='+JSON.stringify(r.declaradas));
if (r.rc!==1) bad.push('rc='+r.rc);
const pr=Object.fromEntries((r.por_ruta||[]).map(e=>[e.ruta,e.vencidas]));
if (pr['ProdA/Back']!==1||pr['ProdB/Back']!==1||pr['ProdA/Front']!==0) bad.push('vencidas por ruta='+JSON.stringify(pr));
")
{ [ "$rc" -eq 1 ] && [ -z "$res" ] && grep -q 'venció el 2020-06-01' "$TMP/out.txt" && grep -q 'frontend · audita npm' "$TMP/out.txt"; } \
  && ok "T6 Vencida_NoAmparaYSigueComparando: la vencida cuenta, se dice, y el otro grupo se compara igual" \
  || no "🔴 T6 rc=$rc: ${res:-} — $(head -4 "$TMP/out.txt")"

# ---------------------------------------------------------------- T7 · Out_SinRutasAbsolutasNiTextoDeYaml @ac-5
W="$TMP/MARCA_RAIZ_7q/clones"; rm -rf "$TMP/MARCA_RAIZ_7q"
yml "$W/ProdA/Back" "$(printf '# MARCA_YAML_7q comentario\ngrep Too Many Requests')"; yml "$W/ProdB/Back" 'sin reintento'
publicado "$W/ProdA/Back"; publicado "$W/ProdB/Back"
cfg3 "$TMP/t7.json" "$R_REINTENTO"
rc=$(corre_out "$TMP/t7.json" "$W" --out "$TMP/r7.json")
if [ -f "$TMP/r7.json" ] && ! grep -Eq 'MARCA_RAIZ_7q|MARCA_YAML_7q|grep Too Many|"/(Users|home|tmp|private|var)/' "$TMP/r7.json" && ! grep -qF "$TMP" "$TMP/r7.json"; then
  ok "T7 Out_SinRutasAbsolutasNiTextoDeYaml: ni la carpeta de los clones ni el texto de los YAML"
else
  no "🔴 T7 el resultado trae rutas o texto de los YAML: $(grep -Eo 'MARCA_[A-Z_0-9a-z]+|"/[^"]*"' "$TMP/r7.json" 2>/dev/null | head -3)"
fi

# ---------------------------------------------------------------- T8 · CloneList_SoloLosQueFaltanConDireccion @ac-6
W="$TMP/w8"; rm -rf "$W"; mkdir -p "$W/Acme/Uno/.git"
cat > "$TMP/t8.json" <<'CFG'
{ "grupos": { "backend": [
    { "producto": "Uno",    "ruta": "Acme/Uno",  "ado": "Acme/Uno" },
    { "producto": "Dos",    "ruta": "Acme/Dos",  "ado": "Acme/Dos" },
    { "producto": "Tres",   "ruta": "Uno/Back", "ado": "Acme%20Uno/Back" },
    { "producto": "Cuatro", "ruta": "Acme/cuatro", "github": "acme/cuatro" },
    { "producto": "Cinco",  "ruta": "Acme/Cinco" } ],
  "prod": { "archivo": "azure-pipelines-prod.yml", "repos": [ { "producto": "Dos", "ruta": "Acme/Dos", "ado": "Acme/Dos" } ] } },
  "rasgos": [ { "id": "reintento", "que": "reintento", "patron": "x" } ], "diferencias_declaradas": [] }
CFG
out8=$(node "$CHK" clone-list --root "$W" --config "$TMP/t8.json" 2>"$TMP/err8"); rc=$?
want8="$(printf 'Acme/Dos\tAcme/Dos\nUno/Back\tAcme%%20Uno/Back\nAcme/cuatro\tacme/cuatro')"
{ [ "$rc" -eq 0 ] && [ "$out8" = "$want8" ]; } && ok "T8 CloneList_SoloLosQueFaltanConDireccion: tres líneas en orden, una vez por ruta, el %20 tal cual" \
  || no "🔴 T8 rc=$rc salida: $(printf '%s' "$out8" | tr '\t\n' '→|')"
outA=$(node "$CHK" clone-list --root "$W" --config "$TMP/t8.json" --platform azure 2>"$TMP/err8a"); rcA=$?
outG=$(node "$CHK" clone-list --root "$W" --config "$TMP/t8.json" --platform github 2>"$TMP/err8g"); rcG=$?
{ [ "$rcA" -eq 0 ] && [ "$outA" = "$(printf 'Acme/Dos\tAcme/Dos\nUno/Back\tAcme%%20Uno/Back')" ] && grep -q 'Acme/cuatro' "$TMP/err8a" \
  && [ "$rcG" -eq 0 ] && [ "$outG" = "$(printf 'Acme/cuatro\tacme/cuatro')" ] && grep -q 'Acme/Dos' "$TMP/err8g"; } \
  && ok "T8 …y con --platform, la entrada de la otra plataforma no se clona: se avisa" \
  || no "🔴 T8 --platform: azure rc=$rcA [$(printf '%s' "$outA" | tr '\t\n' '→|')] github rc=$rcG [$(printf '%s' "$outG" | tr '\t\n' '→|')] avisos: $(cat "$TMP/err8a" "$TMP/err8g" | head -2)"

# ---------------------------------------------------------------- T9 · CloneList_ConfigIlegibleOSinProductos @ac-6
out9=$(node "$CHK" clone-list --root "$W" --config "$TMP/t4a.json" 2>/dev/null); rc9=$?
out9b=$(node "$CHK" clone-list --root "$W" --config "$T5CFG" 2>/dev/null); rc9b=$?
{ [ "$rc9" -eq 2 ] && [ -z "$out9" ] && [ "$rc9b" -eq 0 ] && [ -z "$out9b" ]; } \
  && ok "T9 CloneList_ConfigIlegibleOSinProductos: ilegible sale 2 sin líneas; sin productos, 0 sin líneas" \
  || no "🔴 T9 ilegible rc=$rc9 [$out9] · sin productos rc=$rc9b [$out9b]"

# ---------------------------------------------------------------- T15 · Ejemplo_ValidaYSinNombresReales @ac-13
EJ="$AQUI/pipelines/operations/examples/product-parity.json"
if [ ! -f "$EJ" ]; then no "🔴 T15 no está el ejemplo $EJ"; else
  mkdir -p "$TMP/w15"
  rc=$(corre_out "$EJ" "$TMP/w15" --out "$TMP/r15.json")
  res=$(chk "$EJ" "
const gs=Object.entries(r.grupos||{}); if (!gs.length) bad.push('sin grupos');
for (const x of r.rasgos||[]) { if (!x.id||typeof x.patron!=='string') bad.push('rasgo sin id/patron'); else try { new RegExp(x.patron,'m'); } catch (e) { bad.push(x.id+': patrón ilegible'); } }
for (const d of r.diferencias_declaradas||[]) for (const k of ['grupo','rasgo','motivo','fecha','revision']) if (!d[k]) bad.push('declarada sin '+k);
const nombres=[]; for (const [,g] of gs) for (const e of (Array.isArray(g)?g:g.repos)||[]) nombres.push(e.producto, e.ruta, e.ado||'', e.github||'');
for (const n of nombres.filter(Boolean)) if (!/^acme/i.test(n.replace(/%20/g,' '))) bad.push('nombre que no es acme: '+n);
const conDir=gs.flatMap(([,g])=>(Array.isArray(g)?g:g.repos)||[]);
if (!conDir.some(e=>e.ado||e.github)) bad.push('el ejemplo no muestra dónde vive ningún repo (ado o github)');
if (!/github/.test(JSON.stringify(r._lea_esto_primero||''))||!/\\.github\\/workflows\\//.test(JSON.stringify(r._lea_esto_primero||''))) bad.push('el ejemplo no explica cómo compara una organización de GitHub');")
  res2=$(chk "$TMP/r15.json" "if (r.estado!=='no_medido'||/configuración|rasgo|diferencia declarada/.test(r.motivo||'')) bad.push('estado='+r.estado+' motivo='+r.motivo);")
  { [ -z "$res" ] && [ -z "$res2" ]; } && ok "T15 Ejemplo_ValidaYSinNombresReales: el control lo lee sin error de forma, sólo nombres acme" \
    || no "🔴 T15 ${res} ${res2}"
fi

# ---------------------------------------------------------------- T16 · Contrato_ParaElSitio @ac-12
t16=""
for f in r1/sub/paridad r3 r4a r4b r4c r5; do
  res=$(chk "$TMP/$f.json" "
if (!['medido','parcial','no_medido','sin_productos'].includes(r.estado)) bad.push('estado='+r.estado);
if (!Array.isArray(r.por_ruta)) { bad.push('por_ruta no es lista'); return; }
for (const e of r.por_ruta) {
  if (JSON.stringify(Object.keys(e).sort())!=='[\"divergencias\",\"estado\",\"motivo\",\"ruta\",\"vencidas\"]') bad.push('claves '+Object.keys(e));
  if (typeof e.ruta!=='string'||!['medido','desde_disco','no_medido'].includes(e.estado)) bad.push(JSON.stringify(e));
  if (![null,'sin_clon','ilegible','grupo_sin_comparar','declaracion_incompleta'].includes(e.motivo)) bad.push('motivo libre: '+e.motivo);
  if (!Number.isInteger(e.divergencias)||!Number.isInteger(e.vencidas)) bad.push('cantidades '+JSON.stringify(e));
}")
  [ -z "$res" ] || t16="$t16 [$f: $res]"
done
vistos=$(for f in r1/sub/paridad r3 r4a r5; do node -e 'try{console.log(require(process.argv[1]).estado)}catch(e){}' "$TMP/$f.json"; done | sort -u | tr '\n' ' ')
[ "$vistos" = "medido no_medido parcial sin_productos " ] || t16="$t16 [estados vistos: $vistos]"
[ -z "$t16" ] && ok "T16 Contrato_ParaElSitio: los cuatro estados, por_ruta con tipos y motivos de lista cerrada" || no "🔴 T16$t16"

# ---------------------------------------------------------------- T17 · NoRegresion_CasosDeSiempre_YEntradaConDireccion @ac-14
# (los casos de siempre son los de arriba, que siguen en este archivo). Una entrada con `ado` no le cambia nada al control
# de los disparadores.
W="$TMP/w17"; rm -rf "$W"
for p in ProdA ProdB; do yml "$W/$p/Back" "$(printf 'trigger:\n  branches:\n    include: [main]\n  paths:\n    include:\n      - src/**\n')"; publicado "$W/$p/Back"; done
cat > "$TMP/t17.json" <<'CFG'
{ "grupos": { "backend": [ { "producto": "ProdA", "ruta": "ProdA/Back", "ado": "Acme/ProdA" }, { "producto": "ProdB", "ruta": "ProdB/Back", "github": "acme/prodb" } ] },
  "rasgos": [], "diferencias_declaradas": [] }
CFG
sed -e 's/, "ado": "Acme\/ProdA"//' -e 's/, "github": "acme\/prodb"//' "$TMP/t17.json" > "$TMP/t17b.json"
node "$AQUI/scripts/ci/check-trigger-without-docs.js" --root "$W" --config "$TMP/t17.json" >"$TMP/o17a.txt" 2>&1; ra=$?
node "$AQUI/scripts/ci/check-trigger-without-docs.js" --root "$W" --config "$TMP/t17b.json" >"$TMP/o17b.txt" 2>&1; rb=$?
{ [ "$ra" -eq "$rb" ] && cmp -s "$TMP/o17a.txt" "$TMP/o17b.txt"; } && ok "T17 NoRegresion_EntradaConDireccion: el control de los disparadores ignora ado/github (rc $ra en los dos)" \
  || no "🔴 T17 con dirección rc=$ra, sin dirección rc=$rb: $(diff "$TMP/o17b.txt" "$TMP/o17a.txt" | head -3)"

# ---------------------------------------------------------------- T18 · Fuente_ParidadDeclarada @ac-17
t18=""
for f in "$AQUI/scripts/nightly/dashboard/sources.json" "$AQUI/pipelines/operations/examples/sources.json"; do
  res=$(chk "$f" "const s=(r.sources||[]).find(x=>x.id==='paridad');
if (!s||s.dir!=='paridad'||s.pattern!=='paridad-*.json'||s.required!==false||s.max_age_days!==2||!s.title||!s.written_by) bad.push(JSON.stringify(s||'sin la fuente paridad'));")
  [ -z "$res" ] || t18="$t18 [${f#$AQUI/}: $res]"
done
[ -z "$t18" ] && ok "T18 Fuente_ParidadDeclarada: sources.json público y del ejemplo declaran la fuente paridad" || no "🔴 T18$t18"

# ================================================================ story 2.25 — lo que confirmó el pase adversarial
# ---------------------------------------------------------------- A1 · un grupo al que no le aplica ningún rasgo no se cuenta como medido
# Con la lista real del equipo, el grupo de los sitios web (sólo rasgos que lo nombren, y ninguno lo nombra) salía «medido · 0»
# en por_ruta: el sitio lo mostraría «en orden» sin haberlo comparado con nada. Un repo que no está en juego no va a por_ruta
# ni a la lista para clonar.
W="$TMP/wa1"; rm -rf "$W"
for p in ProdA ProdB; do yml "$W/$p/Back" 'grep Too Many Requests'; publicado "$W/$p/Back"; done
yml "$W/Web/X" 'trigger: none'; yml "$W/Web/Y" 'trigger: [main]'; publicado "$W/Web/X"; publicado "$W/Web/Y"
cat > "$TMP/a1.json" <<'CFG'
{ "grupos": {
    "backend": [ { "producto": "ProdA", "ruta": "ProdA/Back" }, { "producto": "ProdB", "ruta": "ProdB/Back" } ],
    "sitio": { "solo_rasgos_que_lo_nombren": true, "repos": [ { "producto": "WX", "ruta": "Web/X", "ado": "Acme/X" }, { "producto": "WY", "ruta": "Web/Z", "ado": "Acme/Z" } ] } },
  "rasgos": [ { "id": "reintento", "que": "reintento", "patron": "Too Many Requests" } ],
  "diferencias_declaradas": [] }
CFG
rc=$(corre_out "$TMP/a1.json" "$W" --out "$TMP/ra1.json")
res=$(chk "$TMP/ra1.json" "const rutas=(r.por_ruta||[]).map(e=>e.ruta).join(',');
if (rutas!=='ProdA/Back,ProdB/Back') bad.push('por_ruta='+rutas); if (r.estado!=='medido'||r.rc!==0) bad.push('estado='+r.estado+' rc='+r.rc);")
cl=$(node "$CHK" clone-list --root "$W" --config "$TMP/a1.json" 2>/dev/null)
{ [ "$rc" -eq 0 ] && [ -z "$res" ] && [ -z "$cl" ]; } && ok "A1 GrupoSinRasgos_NoSaleMedido: sus repos no van a por_ruta ni a la lista para clonar" \
  || no "🔴 A1 rc=$rc: ${res} · clone-list: [$(printf '%s' "$cl" | tr '\t\n' '→|')]"

# ---------------------------------------------------------------- A2 · una revisión que no es AAAA-MM-DD no ampara para siempre
rm -rf "$TMP/w"; mundo "$TMP/w" 'grep Too Many Requests' 'sin reintento'
a2=""
for X in '"2026/09/01"' '"2026-9-1"' '20260901' '"permanente"'; do
  printf '%s\n' "{ \"grupos\": { \"backend\": [ { \"producto\": \"ProdA\", \"ruta\": \"ProdA/Back\" }, { \"producto\": \"ProdB\", \"ruta\": \"ProdB/Back\" } ] },
    \"rasgos\": [ { \"id\": \"reintento\", \"que\": \"reintento\", \"patron\": \"Too Many Requests\" } ],
    \"diferencias_declaradas\": [ { \"grupo\": \"backend\", \"rasgo\": \"reintento\", \"motivo\": \"m\", \"fecha\": \"2025-01-01\", \"revision\": $X } ] }" > "$TMP/a2.json"
  rc=$(corre_out "$TMP/a2.json" "$TMP/w" --out "$TMP/ra2.json")
  res=$(chk "$TMP/ra2.json" "if (r.estado!=='no_medido'||!/revision/.test(r.motivo||'')||r.rc!==1) bad.push('estado='+r.estado+' motivo='+r.motivo+' rc='+r.rc);")
  { [ "$rc" -eq 1 ] && [ -z "$res" ]; } || a2="$a2 [$X: rc=$rc $res]"
done
[ -z "$a2" ] && ok "A2 RevisionSinFormato_EsIncompleta: una revisión que no es AAAA-MM-DD frena como una declaración incompleta" || no "🔴 A2$a2"

# ---------------------------------------------------------------- A3 · dos repos del mismo producto en un grupo no se pisan
W="$TMP/wa3"; rm -rf "$W"
yml "$W/ProdA/Back1" 'grep Too Many Requests'; yml "$W/ProdA/Back2" 'sin reintento'; yml "$W/ProdB/Back" 'grep Too Many Requests'
for d in ProdA/Back1 ProdA/Back2 ProdB/Back; do publicado "$W/$d"; done
cat > "$TMP/a3.json" <<'CFG'
{ "grupos": { "backend": [ { "producto": "ProdA", "ruta": "ProdA/Back1" }, { "producto": "ProdA", "ruta": "ProdA/Back2" }, { "producto": "ProdB", "ruta": "ProdB/Back" } ] },
  "rasgos": [ { "id": "reintento", "que": "reintento", "patron": "Too Many Requests" } ], "diferencias_declaradas": [] }
CFG
rc=$(corre_out "$TMP/a3.json" "$W" --out "$TMP/ra3.json")
res=$(chk "$TMP/ra3.json" "const d=(r.divergencias||[])[0]||{};
if (JSON.stringify(d.no_tienen)!=='[\"ProdA (ProdA/Back2)\"]'||(d.tienen||[]).length!==2) bad.push('divergencia='+JSON.stringify(d));
const pr=Object.fromEntries((r.por_ruta||[]).map(e=>[e.ruta,e.divergencias]));
if (pr['ProdA/Back2']!==1||pr['ProdA/Back1']!==0||pr['ProdB/Back']!==0) bad.push('por_ruta='+JSON.stringify(pr));")
{ [ "$rc" -eq 1 ] && [ -z "$res" ]; } && ok "A3 ProductoRepetido_NoSePisa: los dos repos del mismo producto se comparan y se nombran por su ruta" || no "🔴 A3 rc=$rc: $res"

# ---------------------------------------------------------------- A4 · una configuración degenerada deja su archivo, sin caerse
printf '%s\n' '{ "grupos": { "backend": [ { "producto": "ProdA", "ruta": "ProdA/Back" }, { "producto": "ProdB", "ruta": "ProdB/Back" } ] }, "diferencias_declaradas": [] }' > "$TMP/a4a.json"
printf '%s\n' '{ "grupos": { "backend": [ { "producto": "ProdA" }, { "producto": "ProdB", "ruta": "ProdB/Back" } ] }, "rasgos": [], "diferencias_declaradas": [] }' > "$TMP/a4b.json"
a4=""
for k in a b; do
  rc=$(corre_out "$TMP/a4$k.json" "$TMP/w" --out "$TMP/ra4$k.json")
  res=$(chk "$TMP/ra4$k.json" "if (r.estado!=='no_medido'||!r.motivo||r.rc!==2) bad.push('estado='+r.estado+' rc='+r.rc);")
  { [ "$rc" -eq 2 ] && [ -z "$res" ] && ! grep -q 'TypeError' "$TMP/out.txt"; } || a4="$a4 [$k: rc=$rc $res $(grep -m1 Error "$TMP/out.txt")]"
done
rc=$(node "$CHK" --root "$TMP/w" --config >"$TMP/out.txt" 2>&1; echo $?)
{ [ "$rc" -eq 2 ] && ! grep -q 'TypeError' "$TMP/out.txt"; } || a4="$a4 [--config sin valor: rc=$rc $(grep -m1 Error "$TMP/out.txt")]"
[ -z "$a4" ] && ok "A4 ConfigDegenerada_DejaSuArchivo: sin rasgos, una entrada sin ruta o --config sin valor salen 2 con su motivo" || no "🔴 A4$a4"

# ---------------------------------------------------------------- A5 · una vencida sin nada que comparar sale 1 (AC 3)
cat > "$TMP/a5.json" <<'CFG'
{ "grupos": { "backend": [ { "producto": "ProdA", "ruta": "NoEsta/A" }, { "producto": "ProdB", "ruta": "NoEsta/B" } ] },
  "rasgos": [ { "id": "reintento", "que": "reintento", "patron": "Too Many Requests" } ],
  "diferencias_declaradas": [ { "grupo": "backend", "rasgo": "reintento", "motivo": "m", "fecha": "2020-01-01", "revision": "2020-06-01" } ] }
CFG
rc=$(corre_out "$TMP/a5.json" "$TMP/w" --out "$TMP/ra5.json")
res=$(chk "$TMP/ra5.json" "if (r.estado!=='no_medido'||r.rc!==1||(r.vencidas||[]).length!==1) bad.push('estado='+r.estado+' rc='+r.rc);")
{ [ "$rc" -eq 1 ] && [ -z "$res" ]; } && ok "A5 VencidaSinComparar_Sale1: no medido, y la vencida sale 1 como siempre" || no "🔴 A5 rc=$rc: $res"

# ---------------------------------------------------------------- A6 · el día del archivo es el de la noche (--today), y un temporal no queda colgado
rc=$(corre_out "$TMP/t1.json" "$TMP/w1" --today 2026-01-02 --out "$TMP/ra6.json")
res=$(chk "$TMP/ra6.json" "if (r.fecha!=='2026-01-02') bad.push('fecha='+r.fecha);")
mkdir -p "$TMP/ra6dir/ocupado/x"; : > "$TMP/ra6dir/ocupado/x/y"
node "$CHK" --config "$TMP/t1.json" --root "$TMP/w1" --out "$TMP/ra6dir/ocupado" >/dev/null 2>&1
quedo=$(ls "$TMP/ra6dir" | grep -c '\.tmp-' || true)
{ [ -z "$res" ] && [ "$quedo" -eq 0 ]; } && ok "A6 FechaDeLaNoche_YSinTemporal: --today manda en la fecha; si no se pudo escribir, no queda el temporal" \
  || no "🔴 A6 ${res} · temporales que quedaron: $quedo"
# --today también manda al vencer (una revisión entre --today y el reloj), y uno sin forma avisa y usa el día UTC
rm -rf "$TMP/w"; mundo "$TMP/w" 'grep Too Many Requests' 'sin reintento'
config "$TMP/a6b.json" '[{"grupo":"backend","rasgo":"reintento","motivo":"m","fecha":"2025-01-01","revision":"2026-01-01"}]'
rc=$(corre_out "$TMP/a6b.json" "$TMP/w" --today 2025-06-01 --out "$TMP/ra6b.json")
res=$(chk "$TMP/ra6b.json" "if ((r.vencidas||[]).length!==0||(r.declaradas||[]).length!==1||r.rc!==0) bad.push('vencidas='+JSON.stringify(r.vencidas)+' rc='+r.rc);")
rc2=$(corre_out "$TMP/t1.json" "$TMP/w1" --today 2026/01/02 --out "$TMP/ra6c.json")
res2=$(chk "$TMP/ra6c.json" "if (r.fecha!==new Date().toISOString().slice(0,10)) bad.push('fecha='+r.fecha);")
{ [ "$rc" -eq 0 ] && [ -z "$res" ] && [ -z "$res2" ] && grep -q 'no es AAAA-MM-DD' "$TMP/out.txt"; } \
  && ok "A6 …--today manda al vencer, y uno sin forma avisa y usa el día UTC" || no "🔴 A6b rc=$rc ${res} ${res2} $(grep -m1 today "$TMP/out.txt")"

# ---------------------------------------------------------------- A7 · una dirección con «.» o «..» no se clona
cat > "$TMP/a7.json" <<'CFG'
{ "grupos": { "backend": [ { "producto": "A", "ruta": "Acme/A", "ado": "../A" }, { "producto": "B", "ruta": "Acme/B", "ado": "Acme/.." }, { "producto": "C", "ruta": "Acme/C", "ado": "Acme/C" } ] },
  "rasgos": [ { "id": "reintento", "que": "reintento", "patron": "x" } ], "diferencias_declaradas": [] }
CFG
out7=$(node "$CHK" clone-list --root "$TMP/vacio7" --config "$TMP/a7.json" 2>"$TMP/err7"); rc=$?
{ [ "$rc" -eq 0 ] && [ "$out7" = "$(printf 'Acme/C\tAcme/C')" ] && grep -q '\.\./A' "$TMP/err7"; } && ok "A7 DireccionConPuntos_NoSeClona: se avisa y no se clona" \
  || no "🔴 A7 rc=$rc [$(printf '%s' "$out7" | tr '\t\n' '→|')] $(head -2 "$TMP/err7")"

# ---------------------------------------------------------------- A8 · sin --config, la lista de la organización (2026-10-16)
# La lista se mudó al repo de operaciones de cada organización. Sin --config, el control la busca en el clon que la
# máquina declara (paths.operations); si lo declara y no la trae, o si la máquina mantiene el arnés y no lo declara,
# NO mide y lo dice (2) — caer en la copia del arnés sería «sin productos» en 0. Una máquina que no declara nada usa
# la de al lado. Cada caso en una máquina de mentira (su propia TYCON_HOME), nunca la de quien corre la prueba.
maquina(){ # <dir> <config.json> → deja la casa de la máquina
  mkdir -p "$1/home/.tycon"; printf '%s\n' "$2" > "$1/home/.tycon/config.json"; }
en_maquina(){ # <dir> <args…>
  local d="$1"; shift; HOME="$d/home" TYCON_HOME="$d/home/.tycon" node "$CHK" "$@"; }
mkdir -p "$TMP/a8/ops/scripts/ci" "$TMP/a8/vacio" "$TMP/a8/mantenido"
git -C "$TMP/a8/ops" init -q . && git -C "$TMP/a8/vacio" init -q .
config "$TMP/a8/ops/scripts/ci/product-parity.json"
maquina "$TMP/a8/m1" "{\"paths\":{\"operations\":\"$TMP/a8/ops\"}}"
maquina "$TMP/a8/m2" "{\"paths\":{\"operations\":\"$TMP/a8/vacio\"}}"
maquina "$TMP/a8/m3" "{\"paths\":{\"maintained\":\"$TMP/a8/mantenido\"}}"
maquina "$TMP/a8/m4" '{}'
p1=$(en_maquina "$TMP/a8/m1" config-path 2>&1); r1=$?
rm -rf "$TMP/w"; mundo "$TMP/w" 'grep Too Many Requests' 'grep Too Many Requests'
en_maquina "$TMP/a8/m1" --root "$TMP/w" --out "$TMP/ra8a.json" >/dev/null 2>&1; ra=$?
{ [ "$r1" -eq 0 ] && [ "$p1" = "$TMP/a8/ops/scripts/ci/product-parity.json" ] && [ "$ra" -eq 0 ] \
  && [ -z "$(chk "$TMP/ra8a.json" "if (!['medido','parcial'].includes(r.estado)||!r.comparaciones) bad.push(r.estado+'/'+r.comparaciones);")" ]; } \
  && ok "A8 SinConfig_UsaLaListaDeOperaciones: config-path la nombra y el control compara con ella" \
  || no "🔴 A8a rc=$r1/$ra [$p1] $(cat "$TMP/ra8a.json" 2>/dev/null | head -c 200)"
t8=""
for m in m2 m3; do
  en_maquina "$TMP/a8/$m" --root "$TMP/w" --out "$TMP/ra8$m.json" >"$TMP/o8$m" 2>&1; rc=$?
  res=$(chk "$TMP/ra8$m.json" "if (r.estado!=='no_medido'||!/paths\\.operations/.test(r.motivo||'')||r.comparaciones) bad.push(r.estado+': '+r.motivo);")
  en_maquina "$TMP/a8/$m" clone-list --root "$TMP/w" >/dev/null 2>"$TMP/e8$m"; rc2=$?
  { [ "$rc" -eq 2 ] && [ -z "$res" ] && [ "$rc2" -eq 2 ] && grep -q 'paths.operations' "$TMP/e8$m"; } || t8="$t8 [$m: rc=$rc/$rc2 $res $(head -1 "$TMP/o8$m")]"
done
HOME="$TMP/a8/m2/home" TYCON_HOME="$TMP/a8/m2/home/.tycon" node "$AQUI/scripts/ci/check-trigger-without-docs.js" --root "$TMP/w" >"$TMP/o8t" 2>&1; rt=$?
{ [ "$rt" -eq 2 ] && grep -q 'paths.operations' "$TMP/o8t"; } || t8="$t8 [trigger: rc=$rt $(head -1 "$TMP/o8t")]"
[ -z "$t8" ] && ok "A8 SinListaEnOperaciones_NoMedidoConMotivo: clon declarado sin la lista, o máquina que mantiene sin declararlo → 2, no «sin productos»" \
  || no "🔴 A8b$t8"
# lo que la revisión del 2026-10-16 encontró sin caso: un clon mantenido declarado que ya no está (antes: la máquina de un
# dev, «sin productos» en 0), sólo el clon de mantenimiento declarado, y la configuración ilegible. Los tres: 2, con --today.
maquina "$TMP/a8/m5" "{\"paths\":{\"maintained\":\"$TMP/a8/no-esta\"}}"
maquina "$TMP/a8/m6" "{\"paths\":{\"maintainers\":\"$TMP/a8/mantenido\"}}"
maquina "$TMP/a8/m7" '{ rota'
t8=""
for m in m5 m6 m7; do
  en_maquina "$TMP/a8/$m" --root "$TMP/w" --today 2026-01-02 --out "$TMP/ra8$m.json" >"$TMP/o8$m" 2>&1; rc=$?
  res=$(chk "$TMP/ra8$m.json" "if (r.estado!=='no_medido'||!r.motivo||r.fecha!=='2026-01-02') bad.push(r.estado+'/'+r.fecha+': '+r.motivo);")
  { [ "$rc" -eq 2 ] && [ -z "$res" ]; } || t8="$t8 [$m: rc=$rc $res $(head -1 "$TMP/o8$m")]"
done
[ -z "$t8" ] && ok "A8 MantieneSinClonDeOperaciones_NoMedido: clon mantenido que ya no está, sólo el de mantenimiento, o configuración ilegible → 2 con motivo" \
  || no "🔴 A8d$t8"
# --config gana sobre lo que declara la máquina (un clon sin la lista), y el control de disparos usa la lista de operaciones
en_maquina "$TMP/a8/m2" --config "$TMP/a8/ops/scripts/ci/product-parity.json" --root "$TMP/w" >/dev/null 2>&1; rc=$?
HOME="$TMP/a8/m1/home" TYCON_HOME="$TMP/a8/m1/home/.tycon" node "$AQUI/scripts/ci/check-trigger-without-docs.js" --root "$TMP/w" >"$TMP/o8t1" 2>&1
{ [ "$rc" -eq 0 ] && ! grep -qE 'sin la lista de productos|no hay productos declarados' "$TMP/o8t1"; } \
  && ok "A8 ConfigDadaGana_YDisparosLeeOperaciones: --config manda; check-trigger-without-docs compara la lista de operaciones" \
  || no "🔴 A8e rc=$rc $(head -2 "$TMP/o8t1" | tr '\n' ' ')"
p4=$(en_maquina "$TMP/a8/m4" config-path 2>&1); r4=$?
{ [ "$r4" -eq 0 ] && [ "$p4" = "$AQUI/scripts/ci/product-parity.json" ]; } && ok "A8 MaquinaSinDeclarar_UsaLaDeAlLado: la de un dev o la CI, como siempre" \
  || no "🔴 A8c rc=$r4 [$p4]"

echo "─────────────"
if [ "$fallos" -eq 0 ]; then echo "✅ paridad-entre-productos: todo verde"; exit 0; else echo "❌ paridad-entre-productos: $fallos falla(s)"; exit 1; fi
