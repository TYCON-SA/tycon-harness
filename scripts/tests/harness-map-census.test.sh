#!/usr/bin/env bash
# harness-map-census.test.sh — toda pieza del arnés tiene lugar en el mapa (2026-09-15).
#
# Lo que se protege: que el mapa no vuelva a quedar incompleto sin que nadie lo note. Una pieza nueva
# sin ficha que la cite hace fallar esto; excluir sin motivo, o dejar una exclusión que ya no aplica,
# también. Y «no pude medir» nunca sale verde. Los casos 2 a 7 trabajan sobre un arnés de juguete en un
# directorio temporal; el 1 mide el repo real. Los casos 8 a 12 (story 8.12, tanda R7) cuidan el `tipo` de
# cada pieza: sale de la ruta de su primer archivo, y un tipo tipeado a mano distinto, o una ruta sin regla,
# no pasan; el 11 mide el mapa real. El 15 (story 8.12, tanda R4) cuida que las carpetas nuevas se censen
# solas, sin una lista fija de carpetas.
#
# El código (scripts/tools/harness-map/) vive en el repo público; el mapa interno (artifacts/mapa-arnes.html) y sus
# exclusiones (scripts/tools/harness-map/fuera-del-mapa.json), en el del equipo. Los casos que miden el mapa de verdad
# (el 1 y el 11) corren sólo donde está —el árbol del equipo con lo público encima— y sin él dicen «NO MEDIDO», que no
# cuenta como verde. El 9 trabaja sobre el mapa de juguete de scripts/tests/fixtures/harness-map/ (datos inventados).
set -uo pipefail

RAIZ="$(cd "$(dirname "$0")/../.." && pwd)"
# el mapa del arnés vive en scripts/tools/harness-map/ desde la story 8.12, tanda R4
HMAP="scripts/tools/harness-map"
CENSO="$RAIZ/$HMAP/census.js"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

BIEN=0; MAL=0; SIN=0
ok()  { echo "  ✓ $1"; BIEN=$((BIEN + 1)); }
mal() { echo "  ✗ $1"; MAL=$((MAL + 1)); }
sin_medir() { echo "  ⚠️   — $1 NO MEDIDO: este árbol no trae el mapa interno (artifacts/mapa-arnes.html, del repo del equipo). No es un verde."; SIN=$((SIN + 1)); }
# el mapa de verdad, si este árbol lo trae; y el de juguete, con su configuración pública y su selector de idioma
REAL=0; [ -f "$RAIZ/artifacts/mapa-arnes.html" ] && [ -f "$RAIZ/$HMAP/fuera-del-mapa.json" ] && REAL=1
FIX="$RAIZ/scripts/tests/fixtures/harness-map"

# arnes <dir> <citas-json> <fuera-json>: arma un arnés mínimo con un hook y un script del pipeline.
arnes() {
  local d="$1"
  mkdir -p "$d/tcg/scripts/hooks" "$d/tcg/artifacts" "$d/tcg/$HMAP" "$d/skills/tycon-pipeline/scripts"
  : > "$d/tcg/scripts/hooks/aviso.js"
  : > "$d/skills/tycon-pipeline/scripts/paso.js"
  printf 'x\nconst D = {\n  "caja": {"archivos": %s}\n};\n' "$2" > "$d/tcg/artifacts/mapa-arnes.html"
  printf '{"fuera": %s}\n' "$3" > "$d/tcg/$HMAP/fuera-del-mapa.json"
}
correr() { node "$CENSO" --tcg "$1/tcg" --skills "$1/skills" > "$1/out" 2>&1; echo $?; }
TODO='[["tcg","scripts/hooks/aviso.js"],["as","skills/tycon-pipeline/scripts/paso.js"],["as","skills/tycon-*/"]]'

echo "harness-map-census"

# C-01 · el arnés real: toda pieza está en alguna ficha o excluida con motivo.
# las skills del repo que se prueba (repo unido, story 8.18), no las de la instalación de la máquina, que puede estar atrasada
if [ "$REAL" = 1 ]; then
  node "$CENSO" --skills "$RAIZ/skills" > "$TMP/real" 2>&1
  [ $? = 0 ] && ok "C-01 toda pieza del arnés real tiene lugar en el mapa" || { mal "C-01 hay piezas sin lugar en el mapa"; cat "$TMP/real"; }
else sin_medir "C-01"; fi

# C-02 · una pieza nueva que ninguna ficha cita frena y se nombra.
arnes "$TMP/c2" '[["as","skills/tycon-pipeline/scripts/paso.js"],["as","skills/tycon-*/"]]' '[]'
rc=$(correr "$TMP/c2")
[ "$rc" = 1 ] && grep -q "scripts/hooks/aviso.js" "$TMP/c2/out" && ok "C-02 una pieza sin ficha frena y dice cuál" || { mal "C-02 la pieza sin ficha pasó (rc=$rc)"; cat "$TMP/c2/out"; }

# C-03 · excluir sin motivo no es excluir: es esconder, y no se puede medir.
arnes "$TMP/c3" '[["as","skills/tycon-pipeline/scripts/paso.js"],["as","skills/tycon-*/"]]' '[{"ruta":"scripts/hooks/aviso.js","motivo":"  "}]'
rc=$(correr "$TMP/c3")
[ "$rc" = 2 ] && grep -q "motivo" "$TMP/c3/out" && ok "C-03 una exclusión sin motivo no pasa" || { mal "C-03 la exclusión sin motivo pasó (rc=$rc)"; cat "$TMP/c3/out"; }

# C-04 · una exclusión de algo que ya no existe sobra.
arnes "$TMP/c4" "$TODO" '[{"ruta":"scripts/hooks/borrado.js","motivo":"ya no se usa"}]'
rc=$(correr "$TMP/c4")
[ "$rc" = 1 ] && grep -q "ya no existe" "$TMP/c4/out" && ok "C-04 excluir algo que ya no existe frena" || { mal "C-04 la exclusión vieja pasó (rc=$rc)"; cat "$TMP/c4/out"; }

# C-05 · una exclusión de algo que ya está en el mapa sobra.
arnes "$TMP/c5" "$TODO" '[{"ruta":"scripts/hooks/aviso.js","motivo":"antes no estaba"}]'
rc=$(correr "$TMP/c5")
[ "$rc" = 1 ] && grep -q "ya está en el mapa" "$TMP/c5/out" && ok "C-05 excluir algo que ya está en el mapa frena" || { mal "C-05 la exclusión que sobra pasó (rc=$rc)"; cat "$TMP/c5/out"; }

# C-06 · sin las skills no se puede medir, y eso nunca sale verde.
arnes "$TMP/c6" "$TODO" '[]'
rm -rf "$TMP/c6/skills"
rc=$(correr "$TMP/c6")
[ "$rc" = 2 ] && grep -q "NO MEDIDO" "$TMP/c6/out" && ok "C-06 sin skills sale «no medido», nunca verde" || { mal "C-06 sin skills no dijo «no medido» (rc=$rc)"; cat "$TMP/c6/out"; }

# C-07 · una carpeta citada con comodín cubre la carpeta, no los archivos de adentro.
arnes "$TMP/c7" '[["tcg","scripts/hooks/aviso.js"],["as","skills/tycon-*/"]]' '[]'
rc=$(correr "$TMP/c7")
[ "$rc" = 1 ] && grep -q "skills/tycon-pipeline/scripts/paso.js" "$TMP/c7/out" && ! grep -q "skills/tycon-pipeline/\$" "$TMP/c7/out" \
  && ok "C-07 el comodín de carpeta no da por citados los archivos de adentro" || { mal "C-07 el comodín cubrió de más o de menos (rc=$rc)"; cat "$TMP/c7/out"; }

# ── El tipo de cada pieza, derivado de su ruta (story 8.12, tanda R7) ─────────────────────────────
# mapa <archivo> <fichas>: un mapa mínimo con las fichas dadas (una por línea, como el real).
mapa() { printf 'x\nconst D = {\n%s\n};\ny\n' "$2" > "$1"; }
tipos() { node "$CENSO" --types --json --map "$1" 2>&1; }

# C-08 · T46 Censo_TipoDerivadoDeLaRuta: una pieza de cada tipo (con el tipo bien puesto), una mal tipeada y
# una con ruta sin regla: --check nombra sólo esas dos.
mkdir -p "$TMP/c8"
mapa "$TMP/c8/m.html" '  "rev": {"nombre":"r","tipo":"revisor","archivos":[["as","agents/uno.md"]]},
  "pack": {"nombre":"p","tipo":"revisor","archivos":[["as","packs/bizuit/pack.json"]]},
  "hook": {"nombre":"h","tipo":"control de sesión","archivos":[["tcg","scripts/hooks/aviso.js"]]},
  "freno": {"nombre":"f","tipo":"control de sesión","archivos":[["as","skills/tycon-pipeline/scripts/on-story-gate.js"]]},
  "horas": {"nombre":"c","tipo":"control de sesión","archivos":[["as","skills/clocki/scripts/sweep.js"]]},
  "skill": {"nombre":"s","tipo":"skill","archivos":[["as","skills/tycon-pipeline/scripts/pipeline.js (model-hint)"]]},
  "guia": {"nombre":"g","tipo":"guía","archivos":[["tcg","guides/incident-log.md"]]},
  "bloque": {"nombre":"b","tipo":"bloque","archivos":[["tcg","claude-md-blocks/"]]},
  "cmd": {"nombre":"k","tipo":"comando","archivos":[["tcg","commands/tycon-vigilante.md"]]},
  "yml": {"nombre":"y","tipo":"pipeline","archivos":[["tcg","azure-pipelines-lab.yml"]]},
  "plantilla": {"nombre":"t","tipo":"pipeline","archivos":[["tcg","pipelines/azure-pipelines-lab.yml"]]},
  "mudado": {"nombre":"m","tipo":"pipeline","archivos":[["tcg","pipelines/templates/traer-repos.yml"]]},
  "script": {"nombre":"x","tipo":"script","archivos":[["tcg","build/generate.js"]]},
  "spec": {"nombre":"e","tipo":"especificación","archivos":[["specs","specs/story-*.md"]]},
  "pin": {"nombre":"v","tipo":"configuración","archivos":[["tcg","engram-version"]]},
  "arranque": {"nombre":"a","tipo":"configuración","archivos":[["local","~/.claude/settings.json (línea de arranque)"]]},
  "dev": {"nombre":"d","tipo":"externo","archivos":[]},
  "maltipeada": {"nombre":"z","tipo":"guía","archivos":[["tcg","scripts/ci/tycon-ci-gate.js"]]},
  "sinregla": {"nombre":"w","archivos":[["tcg","otra-cosa/nueva.txt"]]}'
node "$CENSO" --types --map "$TMP/c8/m.html" > "$TMP/c8/tabla" 2>&1
todos=1
for t in "revisor" "control de sesión" "skill" "guía" "bloque" "comando" "pipeline" "script" "especificación" "configuración" "externo"; do
  grep -q "$t" "$TMP/c8/tabla" || { todos=0; echo "    falta «${t}» en la tabla"; }
done
J="$(tipos "$TMP/c8/m.html")"
esperado='rev=revisor pack=revisor hook=control de sesión freno=control de sesión horas=control de sesión skill=skill guia=guía bloque=bloque cmd=comando yml=pipeline plantilla=pipeline mudado=pipeline script=script spec=especificación pin=configuración arranque=configuración dev=externo maltipeada=script sinregla=null'
obtenido="$(printf '%s' "$J" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).map(p=>p.ficha+"="+p.tipo).join(" "))}catch(e){console.log("NO-JSON")}})')"
node "$CENSO" --check --map "$TMP/c8/m.html" > "$TMP/c8/check" 2>&1; rc=$?
[ "$todos" = 1 ] && [ "$obtenido" = "$esperado" ] && [ "$rc" = 1 ] \
  && grep -q "maltipeada" "$TMP/c8/check" && grep -q "otra-cosa/nueva.txt" "$TMP/c8/check" && [ "$(grep -c '^   · ' "$TMP/c8/check")" = 2 ] \
  && ok "C-08 T46 el tipo sale de la ruta; --check nombra la pieza mal tipeada y la ruta sin regla" \
  || { mal "C-08 T46 tipo derivado (rc=$rc)"; echo "    obtenido: $obtenido"; cat "$TMP/c8/tabla" "$TMP/c8/check"; }

# C-09 · T47 Censo_TipoWriteAndPublicInherits: sobre una copia del mapa de juguete sin tipos, --write pone sólo
# el tipo; --check pasa; la pública generada de esa copia (con la configuración pública y el selector de idioma de
# juguete) trae el mismo tipo en cada ficha.
mkdir -p "$TMP/c9"
sin_tipo() { node -e '
const fs=require("fs");const h=fs.readFileSync(process.argv[1],"utf8");const M="const D = ",i=h.indexOf(M),f=h.indexOf("\n};\n",i);
const D=JSON.parse(h.slice(i+M.length,f+2));for(const v of Object.values(D))delete v.tipo;
const b="{\n"+Object.entries(D).map(([k,v])=>"  "+JSON.stringify(k)+": "+JSON.stringify(v)).join(",\n")+"\n}";
fs.writeFileSync(process.argv[2],h.slice(0,i+M.length)+b+h.slice(f+2));' "$1" "$2"; }
sin_tipo "$FIX/internal-map.html" "$TMP/c9/m.html"
cp "$TMP/c9/m.html" "$TMP/c9/antes.html"
node "$CENSO" --check --map "$TMP/c9/m.html" > "$TMP/c9/check0" 2>&1; rc0=$?
node "$CENSO" --types --write --map "$TMP/c9/m.html" > "$TMP/c9/write" 2>&1; rcw=$?
node "$CENSO" --check --map "$TMP/c9/m.html" > "$TMP/c9/check1" 2>&1; rc1=$?
sin_tipo "$TMP/c9/m.html" "$TMP/c9/despues-sin-tipo.html"
node "$RAIZ/$HMAP/public-version.js" --input "$TMP/c9/m.html" --config "$FIX/public-config.json" --i18n "$FIX/i18n/inject.js" \
  --output "$TMP/c9/pub.html" > "$TMP/c9/pub.out" 2>&1; rcp=$?
hereda="$(node -e '
const fs=require("fs");const d=(p)=>{const h=fs.readFileSync(p,"utf8");const M="const D = ",i=h.indexOf(M),f=h.indexOf("\n};\n",i);return JSON.parse(h.slice(i+M.length,f+2));};
const a=d(process.argv[1]),b=d(process.argv[2]);const ks=Object.keys(a);
const mal=ks.filter(k=>!a[k].tipo||!b[k]||b[k].tipo!==a[k].tipo);console.log(mal.length?"MAL "+mal.join(","):"OK "+ks.length);' "$TMP/c9/m.html" "$TMP/c9/pub.html" 2>&1)"
[ "$rc0" = 1 ] && [ "$rcw" = 0 ] && [ "$rc1" = 0 ] && [ "$rcp" = 0 ] && cmp -s "$TMP/c9/antes.html" "$TMP/c9/despues-sin-tipo.html" && [ "${hereda%% *}" = OK ] \
  && ok "C-09 T47 --write pone sólo el tipo, --check pasa y la pública lo hereda ($hereda)" \
  || { mal "C-09 T47 write/pública (check antes=$rc0 write=$rcw check después=$rc1 pública=$rcp · $hereda)"; cat "$TMP/c9/write" "$TMP/c9/check1" "$TMP/c9/pub.out"; }

# C-10 · T48 Censo_TipoFirstFileWins: un hook y su biblioteca — manda el primero de la lista, y la cabecera lo dice.
mkdir -p "$TMP/c10"
mapa "$TMP/c10/m.html" '  "hook-primero": {"nombre":"a","archivos":[["tcg","scripts/hooks/aviso.js"],["tcg","scripts/lib/aviso-lib.js"]]},
  "lib-primero": {"nombre":"b","archivos":[["tcg","scripts/lib/aviso-lib.js"],["tcg","scripts/hooks/aviso.js"]]}'
obtenido="$(tipos "$TMP/c10/m.html" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).map(p=>p.ficha+"="+p.tipo).join(" "))}catch(e){console.log("NO-JSON")}})')"
[ "$obtenido" = "hook-primero=control de sesión lib-primero=script" ] && grep -q "manda el primero" "$CENSO" \
  && ok "C-10 T48 con archivos de dos tipos manda el primero, y la cabecera lo dice" \
  || { mal "C-10 T48 primer archivo (obtenido: $obtenido)"; }

# C-11 · el mapa real tiene el tipo de cada pieza al día.
if [ "$REAL" = 1 ]; then
  node "$CENSO" --check > "$TMP/c11" 2>&1
  [ $? = 0 ] && grep -q "tipos del mapa" "$TMP/c11" && ok "C-11 cada pieza del mapa real tiene el tipo que le da su ruta" || { mal "C-11 el mapa real tiene tipos que no coinciden"; cat "$TMP/c11"; }
else sin_medir "C-11"; fi

# C-12 · un mapa ilegible no se puede tipar: «no medido», nunca verde.
printf 'sin fichas\n' > "$TMP/ilegible.html"
node "$CENSO" --check --map "$TMP/ilegible.html" > "$TMP/c12" 2>&1; rc=$?
[ "$rc" = 2 ] && grep -q "tipos del mapa — NO MEDIDO" "$TMP/c12" && ok "C-12 --check sobre un mapa ilegible sale «no medido»" || { mal "C-12 mapa ilegible (rc=$rc)"; cat "$TMP/c12"; }

# ── Las carpetas que estrena la tanda R2 (story 8.12, AC 5): scripts/instincts/ e inbox/ ──────────────────
# C-13 · una pieza en scripts/instincts/ sin ficha frena y se nombra (si el censo no recorriera la carpeta, la pieza
# movida ahí desaparecería en silencio), y un ejecutable que cae en el buzón inbox/ —que sólo guarda datos— también.
arnes "$TMP/c13" "$TODO" '[]'
mkdir -p "$TMP/c13/tcg/scripts/instincts" "$TMP/c13/tcg/inbox/instincts/pending"
: > "$TMP/c13/tcg/scripts/instincts/observador.js"
: > "$TMP/c13/tcg/inbox/instincts/suelto.js"
: > "$TMP/c13/tcg/inbox/instincts/pending/propuesta.yaml"
rc=$(correr "$TMP/c13")
[ "$rc" = 1 ] && grep -q "scripts/instincts/observador.js" "$TMP/c13/out" && grep -q "inbox/instincts/suelto.js" "$TMP/c13/out" \
  && ! grep -q "propuesta.yaml" "$TMP/c13/out" \
  && ok "C-13 el censo recorre scripts/instincts/ e inbox/ (y los datos del buzón no son piezas)" \
  || { mal "C-13 scripts/instincts/ o inbox/ fuera del censo (rc=$rc)"; cat "$TMP/c13/out"; }

# C-14 · T20 R2_AdvisorDemo_Decision: el experimento del ejecutor barato se borró (pregunta 4 decidida): no está en el
# árbol ni en las exclusiones del mapa, el índice (INDEX.md) no lo lista y la guía de costos dice que se retiró sin nombrar el
# guion (nunca como algo para correr). Hasta la tanda G2 de la story 8.26 la guía decía hasta qué commit vivió: un
# commit de la historia interna no va en una guía que se publica, y `git log` lo sigue sabiendo.
demo=scripts/tycon-advisor-demo.js
guia="$RAIZ/guides/harness-cost-tiering.md"
vivas="$(grep -n "tycon-advisor-demo" "$guia" || true)"
# las exclusiones del mapa viven con el mapa, en el repo del equipo: se miran si este árbol las trae
fuera_limpio=1; [ -f "$RAIZ/$HMAP/fuera-del-mapa.json" ] && grep -q "tycon-advisor-demo" "$RAIZ/$HMAP/fuera-del-mapa.json" && fuera_limpio=0
[ ! -e "$RAIZ/$demo" ] && [ "$fuera_limpio" = 1 ] \
  && ! grep -q "tycon-advisor-demo" "$RAIZ/INDEX.md" && grep -q "El experimento se retiró del arnés" "$guia" && [ -z "$vivas" ] \
  && ok "C-14 T20 el experimento del ejecutor barato está retirado y la guía lo dice sin mandarlo a correr" \
  || { mal "C-14 T20 el retiro de $demo no es coherente"; [ -n "$vivas" ] && echo "$vivas"; }

# ── Las carpetas de la tanda R4 (story 8.12, AC 27): sin lista fija de carpetas ─────────────────────────────────
# C-15 · T31 R4_HarnessMap_PreCommitAndCensusFolders (mitad del censo): una pieza en scripts/nightly/watcher/ y otra en
# scripts/tools/harness-map/ que ninguna ficha cita salen 1 y se nombran —las recorren los bucles de scripts/nightly/* y
# scripts/tools/*, así que la lista fija ya no las necesita—, y lo mismo una definición de pipeline en pipelines/ o
# pipelines/templates/ (la carpeta que estrena la R6). Las exclusiones se leen de la carpeta nueva del mapa.
arnes "$TMP/c15" "$TODO" '[]'
mkdir -p "$TMP/c15/tcg/scripts/nightly/watcher" "$TMP/c15/tcg/pipelines/templates"
: > "$TMP/c15/tcg/scripts/nightly/watcher/guion-lab.js"
: > "$TMP/c15/tcg/$HMAP/herramienta-lab.js"
: > "$TMP/c15/tcg/pipelines/azure-pipelines-lab.yml"
: > "$TMP/c15/tcg/pipelines/templates/plantilla-lab.yml"
rc=$(correr "$TMP/c15")
[ "$rc" = 1 ] && grep -q "scripts/nightly/watcher/guion-lab.js" "$TMP/c15/out" && grep -q "$HMAP/herramienta-lab.js" "$TMP/c15/out" \
  && grep -q "pipelines/azure-pipelines-lab.yml" "$TMP/c15/out" && grep -q "pipelines/templates/plantilla-lab.yml" "$TMP/c15/out" \
  && [ "$(grep -c '^   · ' "$TMP/c15/out")" = 4 ] \
  && ok "C-15 T31 el censo recorre scripts/nightly/watcher/, $HMAP/ y pipelines/ sin lista fija, y nombra cada pieza sin ficha" \
  || { mal "C-15 T31 carpetas de la R4 fuera del censo (rc=$rc)"; cat "$TMP/c15/out"; }
# y el espejo: citadas, el mismo arnés sale 0 (sin él, un censo que frena siempre también daría verde arriba)
arnes "$TMP/c15b" '[["tcg","scripts/hooks/aviso.js"],["as","skills/tycon-pipeline/scripts/paso.js"],["as","skills/tycon-*/"],["tcg","scripts/nightly/watcher/guion-lab.js"],["tcg","'"$HMAP"'/herramienta-lab.js"],["tcg","pipelines/azure-pipelines-lab.yml"],["tcg","pipelines/templates/plantilla-lab.yml"]]' '[]'
mkdir -p "$TMP/c15b/tcg/scripts/nightly/watcher" "$TMP/c15b/tcg/pipelines/templates"
: > "$TMP/c15b/tcg/scripts/nightly/watcher/guion-lab.js"
: > "$TMP/c15b/tcg/$HMAP/herramienta-lab.js"
: > "$TMP/c15b/tcg/pipelines/azure-pipelines-lab.yml"
: > "$TMP/c15b/tcg/pipelines/templates/plantilla-lab.yml"
rc=$(correr "$TMP/c15b")
[ "$rc" = 0 ] && ok "C-15 T31 con las cuatro citadas el censo sale 0" || { mal "C-15 T31 citadas y aun así frena (rc=$rc)"; cat "$TMP/c15b/out"; }

echo "  $BIEN bien · $MAL mal · $SIN sin medir"
[ "$MAL" = 0 ]
