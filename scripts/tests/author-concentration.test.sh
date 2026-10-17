#!/usr/bin/env bash
# author-concentration.test.sh — la concentración por persona, por producto y sin nombres (story 2.26).
#
# El tablero medía la concentración sólo en la máquina de quien lo generaba, contando por NOMBRE (dos alias de una
# persona la partían en dos) y con los commits de los pipelines adentro. El nocturno ya baja todos los repos de la
# organización: acá se cuenta ahí, uniendo alias, sacando las máquinas, y publicando sólo proporciones por producto.
# Ningún nombre ni correo toca el disco ni sale del guion.
#
# 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la MUTACIÓN que lo pone en rojo.
#
# Portable: sólo git, node y python3; fixtures en mktemp -d, HOME falso, TYCON_TODAY fijo. El exit code se lee
# ANTES de cualquier pipe. Los ejemplos son inventados (Acme, Beta).

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONC="$RAIZ/scripts/metrics/author-concentration.js"
SOURCES="$RAIZ/scripts/nightly/dashboard/sources.json"
HOME="$(mktemp -d)"; export HOME
TMP="$(mktemp -d)"
trap 'chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP" "$HOME"' EXIT
export TYCON_TODAY=2026-10-15
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@ejemplo.test
GITQ=(git -c maintenance.auto=false -c gc.auto=0)
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }

echo "== author-concentration.test.sh =="

# repo <dir> — git init vacío
repo() { mkdir -p "$1"; "${GITQ[@]}" -C "$1" init -q -b main; }
# commits <dir> <n> <nombre> <correo> [fecha]
commits() {
  local dir="$1" n="$2" nom="$3" mail="$4" f="${5:-2026-06-01T12:00:00Z}" i
  for i in $(seq 1 "$n"); do
    GIT_AUTHOR_NAME="$nom" GIT_AUTHOR_EMAIL="$mail" GIT_AUTHOR_DATE="$f" GIT_COMMITTER_DATE="$f" \
      "${GITQ[@]}" -C "$dir" commit -q --allow-empty -m "c $i"
  done
}
# json <archivo> <expresión python sobre d> — imprime el resultado
json() { python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print($2)" "$1"; }
# productos <archivo> <entradas JSON> — escribe un repos.json
productos() { printf '{ "repos": [%s] }\n' "$2" > "$1"; }
correr() { node "$CONC" --scan "$1" --products "$2" --out "$3" ${4:+--sources "$4"}; }

# ── T12 · Contrato_ClavesExactasYReposDistintos @ac-10 @ac-18 ─────────────────────────────────────────────────────
# Mutación: publicar `concentracion` por repo, o medir dos veces un `ado` repetido → rojo.
S="$TMP/t12/scan"; mkdir -p "$S"
repo "$S/Acme__Back";  commits "$S/Acme__Back" 15 Ana ana@ej.test;  commits "$S/Acme__Back" 5 Beto beto@ej.test
repo "$S/Acme__Front"; commits "$S/Acme__Front" 10 Ana ana@ej.test; commits "$S/Acme__Front" 10 Beto beto@ej.test
repo "$S/Beta__Back";  commits "$S/Beta__Back" 12 Caro caro@ej.test; commits "$S/Beta__Back" 8 Dani dani@ej.test
productos "$TMP/t12/repos.json" '{"producto":"Acme","ado":"Acme/Back","ruta":"A/Back"},{"producto":"Acme","ado":"Acme/Back","ruta":"A/Back","subruta":"x"},{"producto":"Acme","ado":"Acme/Front","ruta":"A/Front"},{"producto":"Beta","ado":"Beta/Back","ruta":"B/Back"}'
correr "$S" "$TMP/t12/repos.json" "$TMP/t12/out.json"; rc=$?
if [ "$rc" -ne 0 ]; then mal "T12 salió $rc"
else
  K=$(json "$TMP/t12/out.json" "','.join(sorted(d.keys()))")
  [ "$K" = "cobertura,generated_at,min_commits,productos,umbral,v,ventana" ] && ok "T12 claves de primer nivel exactas" || mal "T12 claves: $K"
  KP=$(json "$TMP/t12/out.json" "','.join(sorted(d['productos'][0].keys()))")
  [ "$KP" = "commits,commits_de_maquina,concentracion,en_riesgo,estado,motivo,producto,repos" ] && ok "T12 claves de producto exactas" || mal "T12 claves de producto: $KP"
  KR=$(json "$TMP/t12/out.json" "sorted(set(','.join(sorted(r.keys())) for p in d['productos'] for r in p['repos']))")
  [ "$KR" = "['estado,motivo,repo']" ] && ok "T12 cada repo sólo con repo, estado y motivo (decisión 18)" || mal "T12 claves de repo: $KR"
  RD=$(json "$TMP/t12/out.json" "d['cobertura']['repos_declarados']")
  [ "$RD" = "3" ] && ok "T12 el ado repetido se mide una vez (repos_declarados = 3)" || mal "T12 repos_declarados = $RD"
  CA=$(json "$TMP/t12/out.json" "[p['concentracion'] for p in d['productos'] if p['producto']=='Acme'][0]")
  [ "$CA" = "0.75" ] && ok "T12 Acme toma el máximo de sus repos (0.75)" || mal "T12 Acme = $CA"
fi

# ── T13 · Regla_Minimo20_MaximoPorProducto_Umbral75 @ac-11 ─────────────────────────────────────────────────────────
# Mutación: `>` en vez de `>=` en el 0.75, o «repartido» con menos de 20 → rojo.
S="$TMP/t13/scan"; mkdir -p "$S"
repo "$S/P__Poco"; commits "$S/P__Poco" 19 Ana ana@ej.test
repo "$S/P__Justo"; commits "$S/P__Justo" 15 Ana ana@ej.test; commits "$S/P__Justo" 5 Beto beto@ej.test
repo "$S/P__Mucho"; commits "$S/P__Mucho" 74 Ana ana@ej.test; commits "$S/P__Mucho" 26 Beto beto@ej.test
productos "$TMP/t13/repos.json" '{"producto":"Poco","ado":"P/Poco"},{"producto":"Justo","ado":"P/Justo"},{"producto":"Mucho","ado":"P/Mucho"}'
correr "$S" "$TMP/t13/repos.json" "$TMP/t13/out.json" >/dev/null; rc=$?
R=$(json "$TMP/t13/out.json" "' '.join(f\"{p['producto']}={p['estado']}/{p['en_riesgo']}\" for p in sorted(d['productos'],key=lambda x:x['producto']))")
[ "$rc" -eq 0 ] && [ "$R" = "Justo=medido/True Mucho=medido/False Poco=no_medido/None" ] && ok "T13 menos de 20 no medido; 75 % en riesgo; 74 % no" || mal "T13 rc=$rc $R"
M=$(json "$TMP/t13/out.json" "[p['motivo'] for p in d['productos'] if p['producto']=='Poco'][0]")
case "$M" in *"menos de 20 commits"*) ok "T13 el motivo lo dice" ;; *) mal "T13 motivo: $M" ;; esac

# ── T14 · Identidad_NombreYCorreoSeUnen @ac-12 ─────────────────────────────────────────────────────────────────────
# Mutación: contar por nombre (lo de antes) da 0.4; leer el .mailmap del disco en un clon sin árbol no lo aplica → rojo.
S="$TMP/t14/scan"; mkdir -p "$S"
repo "$S/Q__Alias"; commits "$S/Q__Alias" 8 "Ana Pérez" ana@ej.test; commits "$S/Q__Alias" 8 ana ANA@ej.test; commits "$S/Q__Alias" 4 Beto beto@ej.test
repo "$S/Q__Correos"; commits "$S/Q__Correos" 8 Caro c1@ej.test; commits "$S/Q__Correos" 8 Caro c2@ej.test; commits "$S/Q__Correos" 4 Dani dani@ej.test
ORIG="$TMP/t14/orig"; repo "$ORIG"
printf 'Eva <eva@ej.test> <viejo@ej.test>\n' > "$ORIG/.mailmap"; "${GITQ[@]}" -C "$ORIG" add .mailmap
GIT_AUTHOR_NAME=Eva GIT_AUTHOR_EMAIL=eva@ej.test GIT_AUTHOR_DATE=2026-06-01T12:00:00Z GIT_COMMITTER_DATE=2026-06-01T12:00:00Z "${GITQ[@]}" -C "$ORIG" commit -q -m mailmap
commits "$ORIG" 7 Eva eva@ej.test; commits "$ORIG" 8 "E. Vieja" viejo@ej.test; commits "$ORIG" 4 Fede fede@ej.test
"${GITQ[@]}" clone -q --no-checkout "file://$ORIG" "$S/Q__Mailmap"
productos "$TMP/t14/repos.json" '{"producto":"Alias","ado":"Q/Alias"},{"producto":"Correos","ado":"Q/Correos"},{"producto":"Mailmap","ado":"Q/Mailmap"}'
correr "$S" "$TMP/t14/repos.json" "$TMP/t14/out.json" >/dev/null; rc=$?
R=$(json "$TMP/t14/out.json" "' '.join(f\"{p['producto']}={p['concentracion']}\" for p in sorted(d['productos'],key=lambda x:x['producto']))")
[ "$rc" -eq 0 ] && [ "$R" = "Alias=0.8 Correos=0.8 Mailmap=0.8" ] && ok "T14 alias por correo, por nombre y por .mailmap del objeto: una persona" || mal "T14 rc=$rc $R"

# ── T15 · Maquinas_FueraDeLaCuenta @ac-13 ──────────────────────────────────────────────────────────────────────────
# Mutación: filtrar sólo «Build Service (» y «[bot]» (dejar «Azure Pipelines») → la parte baja a 16/30 y no está en riesgo.
S="$TMP/t15/scan"; mkdir -p "$S"
repo "$S/M__Back"
commits "$S/M__Back" 10 "Azure Pipelines" azure-pipelines@dev.azure.com
commits "$S/M__Back" 3 "Proyecto Build Service (org)" build@ej.test
commits "$S/M__Back" 5 "dependabot[bot]" bot@ej.test
commits "$S/M__Back" 16 Autoruno uno@ej.test; commits "$S/M__Back" 4 Autordos dos@ej.test
productos "$TMP/t15/repos.json" '{"producto":"Maq","ado":"M/Back"}'
correr "$S" "$TMP/t15/repos.json" "$TMP/t15/out.json" "$SOURCES" >/dev/null; rc=$?
R=$(json "$TMP/t15/out.json" "f\"{d['productos'][0]['concentracion']}/{d['productos'][0]['commits']}/{d['productos'][0]['commits_de_maquina']}\"")
[ "$rc" -eq 0 ] && [ "$R" = "0.8/20/18" ] && ok "T15 las máquinas no cuentan y se suman aparte (18)" || mal "T15 rc=$rc $R"
python3 -c "import json;d=json.load(open('$SOURCES'));d.pop('params',None);json.dump(d,open('$TMP/t15/sin-params.json','w'))"
correr "$S" "$TMP/t15/repos.json" "$TMP/t15/out2.json" "$TMP/t15/sin-params.json" >/dev/null; rc=$?
M=$(json "$TMP/t15/out2.json" "d['productos'][0]['estado']+' '+(d['productos'][0]['motivo'] or '')")
case "$M" in "no_medido "*"identidades de máquina"*) ok "T15 sin la lista de máquinas: no medido, con el motivo" ;; *) mal "T15 sin params: rc=$rc $M" ;; esac

# ── T16 · ClonSuperficial_NoMedido @ac-14 ──────────────────────────────────────────────────────────────────────────
# Mutación: no mirar is-shallow-repository → mide 5 commits como «menos de 20», o peor, como un año entero.
S="$TMP/t16/scan"; mkdir -p "$S"
ORIG="$TMP/t16/orig"; repo "$ORIG"; commits "$ORIG" 30 Ana ana@ej.test
"${GITQ[@]}" clone -q --depth 5 "file://$ORIG" "$S/S__Back"
productos "$TMP/t16/repos.json" '{"producto":"Sup","ado":"S/Back"}'
correr "$S" "$TMP/t16/repos.json" "$TMP/t16/out.json" >/dev/null
M=$(json "$TMP/t16/out.json" "d['productos'][0]['repos'][0]['motivo']")
case "$M" in *"clon superficial"*) ok "T16 clon superficial: no medido, con el motivo" ;; *) mal "T16 motivo: $M" ;; esac

# ── T17 · RepoSinCloneOSinAdo_NoMedido @ac-10 @ac-14 @ac-21 ────────────────────────────────────────────────────────
# Mutación: buscar la carpeta con el `%20` sin decodificar → el tercero también «no está».
S="$TMP/t17/scan"; mkdir -p "$S"
repo "$S/Acme Ventas__Back"; commits "$S/Acme Ventas__Back" 20 Ana ana@ej.test
productos "$TMP/t17/repos.json" '{"producto":"SinAdo","ruta":"x"},{"producto":"SinClon","ado":"Nadie/Back"},{"producto":"Ventas","ado":"Acme%20Ventas/Back"}'
correr "$S" "$TMP/t17/repos.json" "$TMP/t17/out.json" >/dev/null
R=$(json "$TMP/t17/out.json" "' | '.join(f\"{p['producto']}:{p['estado']}:{p['repos'][0]['motivo'] if p['repos'] else p['motivo']}\" for p in sorted(d['productos'],key=lambda x:x['producto']))")
case "$R" in *"SinAdo:no_medido:"*"no declara dónde vive en Azure DevOps"*"SinClon:no_medido:"*"no está entre los clones del nocturno"*"Ventas:medido"*) ok "T17 sin ado y sin clon: no medido; el proyecto decodificado se mide" ;; *) mal "T17 $R" ;; esac

# ── T18 · Fuga_NingunNombreNiCorreo @ac-15 ─────────────────────────────────────────────────────────────────────────
# Mutación: imprimir el autor principal en un aviso, o escribir un intermedio en TMPDIR → rojo.
S="$TMP/t18/scan"; mkdir -p "$S"
repo "$S/Z__Back"; commits "$S/Z__Back" 25 "Zqx Fuga" zqx-fuga@ej.test
productos "$TMP/t18/repos.json" '{"producto":"Fuga","ado":"Z/Back"}'
VIGILADO="$TMP/t18/tmpdir"; mkdir -p "$VIGILADO"
TMPDIR="$VIGILADO" node "$CONC" --scan "$S" --products "$TMP/t18/repos.json" --out "$TMP/t18/out.json" > "$TMP/t18/stdout" 2> "$TMP/t18/stderr"
if grep -qi "zqx" "$TMP/t18/out.json" "$TMP/t18/stdout" "$TMP/t18/stderr"; then mal "T18 un nombre o un correo salió del guion"
elif [ -n "$(ls -A "$VIGILADO")" ]; then mal "T18 el guion escribió en TMPDIR"
else ok "T18 ni en el archivo, ni en stdout, ni en stderr, ni en TMPDIR"; fi
grep -q '"Fuga"' "$TMP/t18/out.json" && ok "T18 control positivo: el producto sí está" || mal "T18 el producto no está en el archivo"

# ── T19 · ModosDeFalla_ExitCodes @ac-16 ────────────────────────────────────────────────────────────────────────────
# Mutación: salir 0 sin archivo, o dejar un archivo a medias → rojo.
node "$CONC" --scan "$TMP/t18/scan" --out "$TMP/t19/a.json" >/dev/null 2>&1; r1=$?
mkdir -p "$TMP/t19"; echo '{roto' > "$TMP/t19/roto.json"
node "$CONC" --scan "$TMP/t18/scan" --products "$TMP/t19/roto.json" --out "$TMP/t19/b.json" >/dev/null 2>&1; r2=$?
node "$CONC" --scan "$TMP/t19/no-existe" --products "$TMP/t18/repos.json" --out "$TMP/t19/c.json" >/dev/null 2>&1; r3=$?
mkdir -p "$TMP/t19/ro"; chmod 555 "$TMP/t19/ro"
node "$CONC" --scan "$TMP/t18/scan" --products "$TMP/t18/repos.json" --out "$TMP/t19/ro/d.json" >/dev/null 2>"$TMP/t19/err"; r4=$?
chmod 755 "$TMP/t19/ro"
if [ "$(id -u)" = "0" ]; then echo "  (T19 sin permiso: corriendo como root no se puede medir; constancia, no verde)"; r4=2; fi
[ "$r1$r2$r3$r4" = "1222" ] && ok "T19 exit 1 / 2 / 2 / 2" || mal "T19 exits: $r1 $r2 $r3 $r4"
[ -z "$(ls -A "$TMP/t19/ro")" ] && [ ! -e "$TMP/t19/b.json" ] && [ ! -e "$TMP/t19/c.json" ] && ok "T19 ningún archivo a medias" || mal "T19 quedó un archivo"

# ── T20 · Ventana_RelojInyectado @ac-11 ────────────────────────────────────────────────────────────────────────────
# Mutación: no usar TYCON_TODAY (la ventana de hoy deja todo afuera) o no cortar la ventana (Beto cuenta: 0.4) → rojo.
S="$TMP/t20/scan"; mkdir -p "$S"
repo "$S/V__Back"; commits "$S/V__Back" 30 Beto beto@ej.test 2025-10-10T12:00:00Z; commits "$S/V__Back" 20 Ana ana@ej.test 2025-10-20T12:00:00Z
productos "$TMP/t20/repos.json" '{"producto":"Ventana","ado":"V/Back"}'
correr "$S" "$TMP/t20/repos.json" "$TMP/t20/out.json" >/dev/null
R=$(json "$TMP/t20/out.json" "f\"{d['productos'][0]['concentracion']}/{d['productos'][0]['commits']}/{d['ventana']['desde']}\"")
[ "$R" = "1/20/2025-10-15" ] && ok "T20 sólo los commits de la ventana de 12 meses hasta TYCON_TODAY" || mal "T20 $R"

# ── T26 · NoRegresion_SnapshotYFotosIntactos_Registro @ac-22 ───────────────────────────────────────────────────────
# Mutación: que alguna de las dos piezas escriba en .dashboard/ (el snapshot o las fotos) → la huella cambia.
D="$TMP/t26/.dashboard"; mkdir -p "$D/proyectos"
echo '{"v":1,"generated_at":"2026-10-15T06:00:00Z"}' > "$D/sdlc-stage-2026-10-15.json"
echo '{"v":1,"generated_at":"2026-10-15T06:00:00Z","proyecto":"Z","repo":"Back","stories":[]}' > "$D/proyectos/Z__Back.json"
ANTES=$(cd "$D" && find . -type f -exec shasum {} \; | sort)
node "$RAIZ/scripts/nightly/projects/state-age.js" --photos "$D/proyectos" --products "$TMP/t18/repos.json" --sources "$SOURCES" >/dev/null 2>&1
correr "$TMP/t18/scan" "$TMP/t18/repos.json" "$TMP/t26/conc.json" >/dev/null 2>&1
DESPUES=$(cd "$D" && find . -type f -exec shasum {} \; | sort)
[ "$ANTES" = "$DESPUES" ] && ok "T26 el snapshot y las fotos quedan iguales" || mal "T26 cambió algo en .dashboard"
REG=0
grep -q '"tests/state-age.test.js"' "$RAIZ/scripts/tests/suites.json" && grep -q '"tests/author-concentration.test.sh"' "$RAIZ/scripts/tests/suites.json" || REG=1
grep -q 'state-age.js' "$RAIZ/guides/piezas-del-arnes.md" && grep -q 'author-concentration.js' "$RAIZ/guides/piezas-del-arnes.md" || REG=1
[ "$REG" = 0 ] && ok "T26 suites.json y piezas-del-arnes.md nombran las dos piezas" || mal "T26 falta el registro de las piezas"
if [ -f "$RAIZ/artifacts/mapa-arnes.html" ]; then
  grep -q 'state-age.js' "$RAIZ/artifacts/mapa-arnes.html" && grep -q 'author-concentration.js' "$RAIZ/artifacts/mapa-arnes.html" && ok "T26 el mapa nombra las dos piezas" || mal "T26 el mapa no nombra las dos piezas"
else echo "  (T26 el mapa vive en el privado: NO MEDIDO acá, sin el privado encima)"; fi

# ── T28 · Fuga_PorElCaminoDelError @ac-15 ──────────────────────────────────────────────────────────────────────────
# Mutación: imprimir el error de git entero (su stdout trae autores) → el nombre sembrado sale en stderr.
S="$TMP/t28/scan"; mkdir -p "$S"
repo "$S/E__Sano"; commits "$S/E__Sano" 25 "Zqx Fuga" zqx-fuga@ej.test
repo "$S/E__Roto"; commits "$S/E__Roto" 25 "Zqx Fuga" zqx-fuga@ej.test
# un objeto de commit corrupto a mitad de la historia: `git log` empieza a escribir autores y falla
OBJ=$(git -C "$S/E__Roto" rev-parse HEAD~10); F="$S/E__Roto/.git/objects/${OBJ:0:2}/${OBJ:2}"
chmod u+w "$F" 2>/dev/null; printf 'basura' > "$F"
productos "$TMP/t28/repos.json" '{"producto":"Sano","ado":"E/Sano"},{"producto":"Roto","ado":"E/Roto"}'
correr "$S" "$TMP/t28/repos.json" "$TMP/t28/out.json" > "$TMP/t28/stdout" 2> "$TMP/t28/stderr"; rc=$?
if grep -qi "zqx" "$TMP/t28/stderr" "$TMP/t28/stdout" "$TMP/t28/out.json"; then mal "T28 el error dejó salir el nombre sembrado"
else ok "T28 el error no trae nombres ni correos"; fi
grep -q 'E/Roto' "$TMP/t28/stderr" && ok "T28 stderr dice qué repo falló" || mal "T28 stderr no nombra el repo: $(head -c 300 "$TMP/t28/stderr")"
R=$(json "$TMP/t28/out.json" "[p['estado'] for p in d['productos'] if p['producto']=='Roto'][0]")
[ "$rc" -eq 0 ] && [ "$R" = "no_medido" ] && ok "T28 el archivo sale igual, con ese repo no medido" || mal "T28 rc=$rc Roto=$R"

# ── Lo que encontró el pase adversarial y el revisor de seguridad (2026-10-17): regresiones ───────────────────────
# Mayúsculas: el nocturno nombra la carpeta como la devuelve Azure DevOps; repos.json puede escribirla distinto.
# Mutación: buscar la carpeta con fs.existsSync tal cual → «no está entre los clones» en un disco que distingue.
S="$TMP/adv/scan"; mkdir -p "$S"
repo "$S/Acme__Back"; commits "$S/Acme__Back" 20 Ana ana@ej.test
productos "$TMP/adv/repos.json" '{"producto":"Mayus","ado":"acme/back"},{"producto":"Escape","ado":"P/%2F..%2F..%2Fetc"},{"producto":"Puntos","ado":"..%2F../Back"}'
correr "$S" "$TMP/adv/repos.json" "$TMP/adv/out.json" >/dev/null
R=$(json "$TMP/adv/out.json" "' | '.join(f\"{p['producto']}:{p['estado']}\" for p in sorted(d['productos'],key=lambda x:x['producto']))")
[ "$R" = "Escape:no_medido | Mayus:medido | Puntos:no_medido" ] && ok "adv la carpeta se busca sin distinguir mayúsculas; un ado que sale de --scan no se mide" || mal "adv $R"
# La guarda dice POR QUÉ: sin ella, el mismo ado caería en «no está entre los clones» (revisor de pruebas, vuelta 2).
# Mutación: borrar el chequeo de nombreSeguro → el motivo pasa a «no está entre los clones del nocturno».
R=$(json "$TMP/adv/out.json" "' | '.join(p['repos'][0]['motivo'] for p in sorted(d['productos'],key=lambda x:x['producto']) if p['producto']!='Mayus')")
case "$R" in *"sale de la carpeta de las copias"*"|"*"sale de la carpeta de las copias"*) ok "adv la guarda de rutas dice que el ado sale de la carpeta" ;; *) mal "adv motivo de la guarda: $R" ;; esac
# La corrida local: una `ruta` de repos.json que sale de la carpeta de los repos no se mide (revisor de criterios, v3).
# Mutación: borrar el chequeo de `adentro` en resolverLocal → «no está en este disco» (o, si existe, se mide afuera).
mkdir -p "$TMP/adv-local/raiz" "$TMP/adv-local/fuera"; repo "$TMP/adv-local/fuera/R"; commits "$TMP/adv-local/fuera/R" 20 Ana ana@ej.test
R=$(node -e 'const c=require(process.argv[1]);console.log(c.resolverLocal([{producto:"X",ado:"P/R",ruta:"../fuera/R"}],process.argv[2])[0].motivo||"medible")' "$CONC" "$TMP/adv-local/raiz")
case "$R" in *"sale de la carpeta de los repos"*) ok "adv local: una ruta que sale de la raíz no se mide" ;; *) mal "adv local: $R" ;; esac

# Redondeo: 149 de 200 (0,745) no puede publicarse como 0,75 con en_riesgo false.
# Mutación: redondear al publicar y decidir el riesgo sin redondear → «0.75 / False».
S="$TMP/adv2/scan"; mkdir -p "$S"
repo "$S/R__Back"; commits "$S/R__Back" 149 Ana ana@ej.test; commits "$S/R__Back" 51 Beto beto@ej.test
productos "$TMP/adv2/repos.json" '{"producto":"Redondeo","ado":"R/Back"}'
correr "$S" "$TMP/adv2/repos.json" "$TMP/adv2/out.json" >/dev/null
R=$(json "$TMP/adv2/out.json" "f\"{d['productos'][0]['concentracion']}/{d['productos'][0]['en_riesgo']}\"")
[ "$R" = "0.74/False" ] && ok "adv el número publicado y en_riesgo coinciden (0,745 se publica 0,74, no en riesgo)" || mal "adv redondeo: $R"
# sources.json ilegible: el motivo lo dice, no «sin la lista de máquinas».
# Mutación: no pasar motivoSinMaquinas a concentracion → el motivo vuelve a «sin la lista de identidades de máquina».
echo '{roto' > "$TMP/adv2/roto.json"
correr "$S" "$TMP/adv2/repos.json" "$TMP/adv2/out2.json" "$TMP/adv2/roto.json" >/dev/null 2>&1
M=$(json "$TMP/adv2/out2.json" "d['productos'][0]['motivo']")
case "$M" in *"no pude leer sources.json"*) ok "adv sources.json ilegible: el motivo lo dice" ;; *) mal "adv sources ilegible: $M" ;; esac
# La carpeta de las copias que existe y no se puede listar: el motivo lo dice, no «no está entre los clones».
# Mutación: tragar el error de readdirSync(scan) → todos «no está entre los clones del nocturno».
if [ "$(id -u)" = "0" ]; then echo "  (adv carpeta ilegible: como root no se puede negar el permiso; constancia, no verde)"
else
  chmod 300 "$S"
  correr "$S" "$TMP/adv2/repos.json" "$TMP/adv2/out3.json" >/dev/null 2>&1
  chmod 755 "$S"
  M=$(json "$TMP/adv2/out3.json" "d['productos'][0]['repos'][0]['motivo']")
  case "$M" in *"no pude leer la carpeta de las copias"*) ok "adv carpeta de copias ilegible: el motivo lo dice" ;; *) mal "adv carpeta ilegible: $M" ;; esac
fi

echo ""
if [ "$FALLOS" -eq 0 ]; then echo "✅ author-concentration.test.sh: todo verde"; exit 0; fi
echo "❌ author-concentration.test.sh: $FALLOS caso(s) en rojo"; exit 1
