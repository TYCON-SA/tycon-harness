#!/usr/bin/env bash
# harness-layer.test.sh — la capa privada: APILAR una lista sobre el árbol (T5).
#
# Lo que no se puede perder:
#   · Cada archivo de la capa se escribe desde el blob interno, leído con UN solo `git cat-file --batch`, atómico y con
#     el modo del blob (un ejecutable sigue ejecutable); el manifiesto `layer.json` lleva el sha256 de cada uno.
#   · El bloque `# tycon-layer` de `<árbol>/.git/info/exclude` nombra la fuente y declara lo agregado (las carpetas
#     privadas enteras, los archivos sueltos uno por uno); lo de la persona fuera del bloque no se toca. Después de
#     apilar, `git status --porcelain` muestra SÓLO los pisados.
#   · Nunca un enlace simbólico: una entrada de la capa que en git es un enlace (120000) o un submódulo (160000) frena
#     todo ANTES de escribir nada (exit 2 nombrando la ruta).
#   · Una segunda corrida igual no escribe nada y lo dice.
#   · Lo editado a mano (sha256 ≠ manifiesto) no se pisa ni se borra: se avisa con la ruta. Lo que la máquina escribe
#     (harness-tree-writers.json) se escribe si falta y no se vigila: cambiado, no se avisa.
#   · Un agregado cuya ruta pasó a ser pública sale del manifiesto y del bloque y el archivo queda (igual o con otro
#     contenido); uno que el interno borró se borra sólo si su hash es el del manifiesto.
#   · Lo que sale de la lista editado a mano queda en el manifiesto marcado («held») y se avisa en cada
#     corrida; un pisado que sale de la lista vuelve al público, y editado a mano queda; el
#     bloque de exclude con CRLF, con dos bloques o con espacios al final sigue siendo uno y lo de la persona no se toca,
#     y uno sin cierre frena sin escribir nada.
# El tope de 5 s con la capa REAL lo mide harness-layer-real (T4): acá se cuenta el proceso `cat-file`, no el reloj.
#
# Laboratorio: repos de juguete en un temporal (git de verdad), el exportador de juguete y un `git` envoltorio en PATH
# que anota cada invocación. Nunca ~/.claude. 🔴 Sin pipes sobre el comando medido.
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LAYER="$RAIZ/scripts/setup/harness/layer.js"
TOY="$RAIZ/scripts/tests/fixtures/toy-exporter.js"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
BASE="$(mktemp -d)"
# el nombre viejo del lugar sale de place.js, como en el resto del arnés (no se escribe a mano)
VIEJO="$(node -p "require('${RAIZ}/scripts/setup/harness/place.js').LEGACY_PLACE_NAME")"
case "$BASE" in *"${VIEJO}"*|*agent-skills*|*/.claude*) echo "❌ harness-layer: el laboratorio cayó en ${BASE}"; exit 1 ;; esac
trap 'rm -rf "$BASE"' EXIT
for v in $(env | sed -n 's/^\(GIT_[A-Z_]*\)=.*/\1/p'); do unset "$v"; done
export GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
export GIT_AUTHOR_NAME=lab GIT_AUTHOR_EMAIL=lab@example.invalid GIT_COMMITTER_NAME=lab GIT_COMMITTER_EMAIL=lab@example.invalid

if [ ! -f "$LAYER" ]; then echo "  MAL  — no existe scripts/setup/harness/layer.js"; echo "❌ harness-layer: 1 fallo(s)"; exit 1; fi

# el envoltorio de git: anota la línea de cada invocación y llama al git real
REAL_GIT="$(command -v git)"
mkdir -p "$BASE/bin"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "${TYCON_TEST_GIT_LOG:-/dev/null}"\nexec "%s" "$@"\n' "$REAL_GIT" > "$BASE/bin/git"
chmod 755 "$BASE/bin/git"

g() { local d="$1"; shift; "$REAL_GIT" -c core.autocrlf=false -c commit.gpgsign=false -c init.defaultBranch=main -c core.hooksPath=/dev/null -C "$d" "$@"; }
put() { mkdir -p "$(dirname "$1/$2")"; printf '%s\n' "$3" > "$1/$2"; }
sha() { python3 -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$1"; }
mtime() { python3 -c "import os,sys; print(os.stat(sys.argv[1]).st_mtime_ns)" "$1"; }
perm() { python3 -c "import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777)[2:])" "$1"; }
j() { python3 -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print($2)" "$1" 2>/dev/null; }
# el hash del árbol entero: cada archivo (fuera de .git, salvo info/exclude) con su ruta, su modo y su contenido
tree_hash() {
  python3 - "$1" <<'PY'
import hashlib, os, sys
root = sys.argv[1]; h = hashlib.sha256()
for d, dirs, files in os.walk(root):
    dirs.sort()
    if os.path.relpath(d, root) == '.': dirs[:] = [x for x in dirs if x != '.git']
    for f in sorted(files):
        p = os.path.join(d, f); st = os.lstat(p)
        h.update(os.path.relpath(p, root).encode()); h.update(str(st.st_mode).encode())
        h.update(os.readlink(p).encode() if os.path.islink(p) else open(p, 'rb').read())
ex = os.path.join(root, '.git', 'info', 'exclude')
h.update(open(ex, 'rb').read() if os.path.exists(ex) else b'-')
print(h.hexdigest())
PY
}
layer_apply() {   # layer_apply <log> <lista> [args…] → $SALIDA, $RC
  local log="$1" list="$2"; shift 2
  SALIDA="$(PATH="$BASE/bin:$PATH" TYCON_TEST_GIT_LOG="$log" node "$LAYER" apply --tree "$ARBOL" --from "$INTERNO" --list "$list" --manifest "$MANIFIESTO" "$@" 2>&1)"; RC=$?
}

# ── el interno unido de juguete ──────────────────────────────────────────────────────────────────────────────────────
INTERNO="$BASE/interno"; mkdir -p "$INTERNO"; g "$INTERNO" init -q
put "$INTERNO" .gitignore $'node_modules/\n**/.advisors/*'
put "$INTERNO" .githooks/pre-commit $'#!/usr/bin/env bash\necho despachador'
put "$INTERNO" guides/guia.md 'una guía pública'
put "$INTERNO" guides/maintaining/guia-de-quien-mantiene.md 'una guía pública de quien mantiene'
put "$INTERNO" guides/guide-update-proposals.md 'la guía de propuestas (privada, suelta en una carpeta pública)'
put "$INTERNO" guides/despues-igual.md 'privado hoy; la versión siguiente lo publica igual'
put "$INTERNO" guides/despues-distinto.md 'privado hoy; la versión siguiente lo publica con otro contenido'
put "$INTERNO" scripts/tests/suites.json $'{\n  "diarias": [],\n  "interna": true\n}'
put "$INTERNO" scripts/herramienta-privada.sh $'#!/usr/bin/env bash\necho privada'; chmod 755 "$INTERNO/scripts/herramienta-privada.sh"
put "$INTERNO" skills/publica/SKILL.md 'una skill pública'
put "$INTERNO" tasks/tarea.md 'una tarea'
put "$INTERNO" tasks/vieja.md 'la versión siguiente la borra'
put "$INTERNO" tasks/vieja-editada.md 'la versión siguiente la borra, pero alguien la editó'
put "$INTERNO" .dashboard/sdlc-stage-2026-10-01.json '{"punto":"del día"}'
# qué publica el interno: su lista blanca de juguete deja afuera lo privado suelto en guides/ y scripts/; el resto
# de lo privado (tasks/, .dashboard/, guides/maintaining/) ya lo dejan afuera las exclusiones fijas del exportador
put "$INTERNO" scripts/publishing/allowlist.json '{ "packages": { "core": {
  "arnes": { "in": ["**"], "out": [
    { "glob": "guides/despues-*.md", "reason": "privados hoy: la versión siguiente los publica" },
    { "glob": "scripts/herramienta-privada.sh", "reason": "una herramienta privada suelta en scripts/" } ] },
  "agent-skills": { "in": ["**"], "out": [] } } } }'
cp "$RAIZ/scripts/tests/fixtures/layer-lab-table.json" "$INTERNO/scripts/publishing/replacements.json"
g "$INTERNO" add -A; g "$INTERNO" commit -q -m 'interno v1'
C1="$(g "$INTERNO" rev-parse HEAD)"
PRIVADOS="tasks/,.dashboard/,guides/guide-update-proposals.md,guides/despues-igual.md,guides/despues-distinto.md,scripts/herramienta-privada.sh"
node "$TOY" --internal "$INTERNO" --out "$BASE/publico" --leave-out "$PRIVADOS" --transform scripts/tests/suites.json:suites-json >/dev/null \
  || mal "T5 el exportador de juguete falló"

ARBOL="$BASE/arbol"; MANIFIESTO="$BASE/estado/layer.json"
g "$BASE" clone -q "$BASE/publico" "$ARBOL"
printf '# lo mío\nmis-notas/\n' > "$ARBOL/.git/info/exclude"
node "$LAYER" compute --internal "$INTERNO" --public "$ARBOL" --out "$BASE/capa-1.json" >/dev/null 2>&1 || mal "T5 compute v1 no salió 0"

# ── apilar ───────────────────────────────────────────────────────────────────────────────────────────────────────────
layer_apply "$BASE/git-1.log" "$BASE/capa-1.json"
[ "$RC" = 0 ] && ok "T5 apilar sale 0" || mal "T5 apilar: rc $RC: $SALIDA"
BIEN="$(python3 - "$ARBOL" "$MANIFIESTO" <<'PY'
import hashlib, json, os, sys
tree, man = sys.argv[1], json.load(open(sys.argv[2], encoding='utf-8'))
bad = [f['path'] for f in man['files'] if hashlib.sha256(open(os.path.join(tree, f['path']), 'rb').read()).hexdigest() != f['sha256']]
print(len(man['files']), 'mal:' + ','.join(bad) if bad else 'bien')
PY
)"
[ "$BIEN" = "8 bien" ] && ok "T5 cada archivo de la capa con el sha256 del manifiesto (8)" || mal "T5 manifiesto contra el disco: $BIEN"
IGUALES=1
for p in guides/guide-update-proposals.md tasks/tarea.md scripts/tests/suites.json scripts/herramienta-privada.sh; do
  g "$INTERNO" show "$C1:$p" > "$BASE/blob"; cmp -s "$BASE/blob" "$ARBOL/$p" || { IGUALES=0; mal "T5 $p no es el blob interno"; }
done
[ "$IGUALES" = 1 ] && ok "T5 el contenido es el del blob interno (agregados y pisado)"
[ "$(j "$MANIFIESTO" "sorted(f['kind'] for f in d['files'] if f['path']=='scripts/tests/suites.json')")" = "['overwrite']" ] \
  && ok "T5 el transformado entra como overwrite" || mal "T5 suites.json en el manifiesto: $(j "$MANIFIESTO" "[f for f in d['files'] if f['path']=='scripts/tests/suites.json']")"
[ -f "$ARBOL/.dashboard/sdlc-stage-2026-10-01.json" ] && [ "$(j "$MANIFIESTO" "any(f['path'].startswith('.dashboard/') for f in d['files'])")" = False ] \
  && ok "T5 la ruta de un escritor se escribe y no entra al manifiesto con hash" || mal "T5 escritor: $(j "$MANIFIESTO" "[f['path'] for f in d['files']]")"
EXCL="$(cat "$ARBOL/.git/info/exclude")"
case "$EXCL" in *"# tycon-layer"*) ok "T5 el bloque # tycon-layer está" ;; *) mal "T5 sin bloque: $EXCL" ;; esac
[ "$(printf '%s\n' "$EXCL" | grep -c '^# fuente: internal')" = 1 ] && ok "T5 el bloque nombra la fuente" || mal "T5 el bloque no nombra la fuente: $EXCL"
[ "$(printf '%s\n' "$EXCL" | head -2)" = $'# lo mío\nmis-notas/' ] && ok "T5 lo de la persona, fuera del bloque, intacto" || mal "T5 lo de la persona cambió: $EXCL"
FALTAN=""
for l in /tasks/ /.dashboard/ /guides/guide-update-proposals.md /guides/despues-igual.md /scripts/herramienta-privada.sh; do
  printf '%s\n' "$EXCL" | grep -xF "$l" >/dev/null || FALTAN="$FALTAN $l"
done
[ -z "$FALTAN" ] && ok "T5 carpetas privadas enteras y archivos sueltos uno por uno" || mal "T5 faltan en el bloque:$FALTAN"
printf '%s\n' "$EXCL" | grep -xF /tasks/tarea.md >/dev/null && mal "T5 un archivo de una carpeta privada entera no va suelto" || ok "T5 dentro de una carpeta privada no hay líneas sueltas"
ST="$(g "$ARBOL" status --porcelain)"
[ "$ST" = " M scripts/tests/suites.json" ] && ok "T5 git status muestra sólo el pisado" || mal "T5 git status: «${ST}»"
[ "$(perm "$ARBOL/scripts/herramienta-privada.sh")" = 755 ] && [ "$(j "$MANIFIESTO" "[f['mode'] for f in d['files'] if f['path']=='scripts/herramienta-privada.sh'][0]")" = 100755 ] \
  && ok "T5 el ejecutable queda 755 (y 100755 en el manifiesto)" || mal "T5 modo: $(perm "$ARBOL/scripts/herramienta-privada.sh")"
[ -z "$(find "$ARBOL" -path "$ARBOL/.git" -prune -o -type l -print)" ] && ok "T5 ningún enlace simbólico en el árbol" || mal "T5 hay enlaces en el árbol"
NCAT="$(grep -c 'cat-file' "$BASE/git-1.log")"
[ "$NCAT" = 1 ] && ok "T5 un solo proceso cat-file para toda la capa" || mal "T5 procesos cat-file: $NCAT"
grep -q 'cat-file --batch' "$BASE/git-1.log" && ok "T5 …y es cat-file --batch" || mal "T5 no usó cat-file --batch: $(cat "$BASE/git-1.log")"

# ── segunda corrida igual ────────────────────────────────────────────────────────────────────────────────────────────
ANTES="$(tree_hash "$ARBOL")"; M_ANTES="$(mtime "$MANIFIESTO")"; E_ANTES="$(mtime "$ARBOL/.git/info/exclude")"
layer_apply "$BASE/git-2.log" "$BASE/capa-1.json"
[ "$RC" = 0 ] && case "$SALIDA" in *"nada que escribir"*) ok "T5 segunda ejecución: «nada que escribir»" ;; *) mal "T5 segunda ejecución no lo dice: $SALIDA" ;; esac || mal "T5 segunda ejecución rc $RC"
[ "$(tree_hash "$ARBOL")" = "$ANTES" ] && [ "$(mtime "$MANIFIESTO")" = "$M_ANTES" ] && [ "$(mtime "$ARBOL/.git/info/exclude")" = "$E_ANTES" ] \
  && ok "T5 segunda ejecución: no escribió nada (árbol, manifiesto y exclude)" || mal "T5 la segunda ejecución escribió"

# ── editado a mano y escritores ──────────────────────────────────────────────────────────────────────────────────────
printf 'a mano\n' >> "$ARBOL/scripts/tests/suites.json"
printf 'a mano\n' >> "$ARBOL/tasks/tarea.md"
printf 'a mano\n' >> "$ARBOL/tasks/vieja-editada.md"
printf '{"punto":"otro"}\n' > "$ARBOL/.dashboard/sdlc-stage-2026-10-01.json"
S1="$(sha "$ARBOL/scripts/tests/suites.json")"; S2="$(sha "$ARBOL/tasks/tarea.md")"; S3="$(sha "$ARBOL/.dashboard/sdlc-stage-2026-10-01.json")"
layer_apply "$BASE/git-3.log" "$BASE/capa-1.json"
[ "$RC" = 0 ] && ok "T5 con editados a mano sale 0 (avisa, no frena)" || mal "T5 editados: rc $RC: $SALIDA"
[ "$(sha "$ARBOL/scripts/tests/suites.json")" = "$S1" ] && [ "$(sha "$ARBOL/tasks/tarea.md")" = "$S2" ] \
  && ok "T5 el pisado y el agregado editados a mano quedan intactos" || mal "T5 pisó algo editado a mano"
case "$SALIDA" in *"scripts/tests/suites.json"*"tasks/tarea.md"*|*"tasks/tarea.md"*"scripts/tests/suites.json"*) ok "T5 …y se avisan con la ruta" ;; *) mal "T5 no avisa los editados: $SALIDA" ;; esac
[ "$(sha "$ARBOL/.dashboard/sdlc-stage-2026-10-01.json")" = "$S3" ] && case "$SALIDA" in *sdlc-stage*) mal "T5 avisó la ruta de un escritor: $SALIDA" ;; *) ok "T5 la ruta de un escritor cambiada: intacta y sin aviso" ;; esac \
  || mal "T5 pisó la ruta de un escritor"
SALIDA_V="$(node "$LAYER" verify --tree "$ARBOL" --manifest "$MANIFIESTO" 2>&1)"; RC_V=$?
[ "$RC_V" = 1 ] && case "$SALIDA_V" in *tasks/tarea.md*) ok "T5 verify sale 1 y nombra lo editado a mano" ;; *) mal "T5 verify no lo nombra: $SALIDA_V" ;; esac || mal "T5 verify rc $RC_V: $SALIDA_V"

# ── la versión siguiente: dos agregados pasan a ser públicos, el interno borra dos ────────────────────────────────────
g "$INTERNO" rm -q tasks/vieja.md tasks/vieja-editada.md; g "$INTERNO" commit -q -m 'interno v2'
C2="$(g "$INTERNO" rev-parse HEAD)"
node "$TOY" --internal "$INTERNO" --out "$BASE/publico2" --version 2026.10.06.2 --leave-out "tasks/,.dashboard/,guides/guide-update-proposals.md,scripts/herramienta-privada.sh" \
  --transform scripts/tests/suites.json:suites-json >/dev/null || mal "T5 el exportador de juguete (v2) falló"
node "$LAYER" compute --internal "$INTERNO" --internal-commit "$C2" --public "$BASE/publico2" --out "$BASE/capa-2.json" >/dev/null 2>&1 || mal "T5 compute v2 no salió 0"
put "$BASE/publico2" guides/despues-distinto.md 'publicado con otro contenido'
g "$BASE/publico2" commit -q -am 'la versión publica el archivo con otro contenido'
g "$ARBOL" fetch -q "$BASE/publico2" main && g "$ARBOL" reset -q --hard FETCH_HEAD
VIEJA_EDITADA="$(sha "$ARBOL/tasks/vieja-editada.md")"
layer_apply "$BASE/git-4.log" "$BASE/capa-2.json"
[ "$RC" = 0 ] && ok "T5 apilar la versión siguiente sale 0" || mal "T5 v2: rc $RC: $SALIDA"
[ -f "$ARBOL/guides/despues-igual.md" ] && [ -f "$ARBOL/guides/despues-distinto.md" ] && [ "$(cat "$ARBOL/guides/despues-distinto.md")" = 'publicado con otro contenido' ] \
  && ok "T5 los dos que pasaron a ser públicos quedan (igual y con otro contenido)" || mal "T5 los publicados no quedaron"
[ "$(j "$MANIFIESTO" "[f['path'] for f in d['files'] if f['path'].startswith('guides/despues-')]")" = "[]" ] \
  && ok "T5 …y salen del manifiesto" || mal "T5 siguen en el manifiesto: $(j "$MANIFIESTO" "[f['path'] for f in d['files']]")"
EXCL="$(cat "$ARBOL/.git/info/exclude")"
printf '%s\n' "$EXCL" | grep despues- >/dev/null && mal "T5 siguen en el bloque: $EXCL" || ok "T5 …y del bloque de exclude"
[ ! -e "$ARBOL/tasks/vieja.md" ] && [ "$(j "$MANIFIESTO" "any(f['path']=='tasks/vieja.md' for f in d['files'])")" = False ] \
  && ok "T5 el agregado que el interno borró se borra (su hash era el del manifiesto)" || mal "T5 tasks/vieja.md sigue"
[ -f "$ARBOL/tasks/vieja-editada.md" ] && [ "$(sha "$ARBOL/tasks/vieja-editada.md")" = "$VIEJA_EDITADA" ] \
  && case "$SALIDA" in *tasks/vieja-editada.md*) ok "T5 el borrado editado a mano queda y se avisa" ;; *) mal "T5 no avisa el borrado editado: $SALIDA" ;; esac \
  || mal "T5 borró un archivo editado a mano"
P2A="$(g "$BASE/publico2" rev-parse HEAD~1)"
[ "$(j "$MANIFIESTO" "d['sources'] == [dict(name='harness', commit='$P2A'), dict(name='internal', commit='$C2')]")" = True ] \
  && ok "T5 el manifiesto lleva los commits de la lista nueva" || mal "T5 sources: $(j "$MANIFIESTO" "d['sources']")"
ST="$(g "$ARBOL" status --porcelain)"
[ "$ST" = " M scripts/tests/suites.json" ] && ok "T5 v2: git status sigue mostrando sólo el pisado" || mal "T5 v2 git status: «${ST}»"

# ── el agregado que el interno borró y la persona editó no se pierde de vista ──────────────
# Si se avisara UNA vez y saliera del manifiesto, la carpeta seguiría excluida y nadie lo vería más. Queda en el
# manifiesto marcado («held») y se avisa en cada corrida (y verify sale 1), hasta que la persona lo resuelve.
layer_apply "$BASE/git-5.log" "$BASE/capa-2.json"
case "$SALIDA" in *tasks/vieja-editada.md*) ok "T5 clase 6: la ejecución siguiente sigue avisando el borrado editado a mano" ;; *) mal "T5 clase 6: dejó de avisarlo: $SALIDA" ;; esac
[ "$(j "$MANIFIESTO" "[f.get('held') for f in d['files'] if f['path']=='tasks/vieja-editada.md']")" = "[True]" ] \
  && ok "T5 clase 6: …queda en el manifiesto, marcado" || mal "T5 clase 6: en el manifiesto: $(j "$MANIFIESTO" "[f for f in d['files'] if f['path']=='tasks/vieja-editada.md']")"
[ "$(sha "$ARBOL/tasks/vieja-editada.md")" = "$VIEJA_EDITADA" ] && ok "T5 clase 6: …y el archivo, intacto" || mal "T5 clase 6: tocó el archivo editado"
SALIDA_V="$(node "$LAYER" verify --tree "$ARBOL" --manifest "$MANIFIESTO" 2>&1)"; RC_V=$?
[ "$RC_V" = 1 ] && case "$SALIDA_V" in *tasks/vieja-editada.md*) ok "T5 clase 6: verify sale 1 y lo nombra" ;; *) mal "T5 clase 6: verify no lo nombra: $SALIDA_V" ;; esac || mal "T5 clase 6: verify rc $RC_V: $SALIDA_V"
rm "$ARBOL/tasks/vieja-editada.md"
layer_apply "$BASE/git-6.log" "$BASE/capa-2.json"
case "$SALIDA" in *tasks/vieja-editada.md*) mal "T5 clase 6: lo sigue avisando después de que la persona lo borró: $SALIDA" ;; *) ok "T5 clase 6: la persona lo borra → no se avisa más" ;; esac
[ "$(j "$MANIFIESTO" "any(f['path']=='tasks/vieja-editada.md' for f in d['files'])")" = False ] \
  && ok "T5 clase 6: …y sale del manifiesto" || mal "T5 clase 6: sigue en el manifiesto"

# ── un pisado que sale de la lista vuelve al contenido público ───────────────────
# Si saliera del manifiesto como si hubiera pasado a ser público, el archivo quedaría con el contenido interno viejo
# (git status « M», verify «todo en su lugar», doctor lo llamaría «editado a mano» y el update siguiente se trabaría).
# (el interno lo borra; que quede igual al público pasa por el mismo camino —sale de la lista— y el suites.json de
# juguete transformado no es JSON válido, así que la clasificación del exportador no lo dejaría calcular)
g "$INTERNO" rm -q scripts/tests/suites.json; g "$INTERNO" commit -q -m 'interno v3: sin suites.json'
C3="$(g "$INTERNO" rev-parse HEAD)"
node "$LAYER" compute --internal "$INTERNO" --internal-commit "$C3" --public "$BASE/publico2" --public-commit "$P2A" --out "$BASE/capa-3.json" >/dev/null 2>&1 \
  || mal "T5 clase 11: compute v3 no salió 0"
layer_apply "$BASE/git-7.log" "$BASE/capa-3.json"
[ "$RC" = 0 ] && ok "T5 clase 11: apilar con el pisado fuera de la lista sale 0" || mal "T5 clase 11: rc $RC: $SALIDA"
g "$ARBOL" diff --quiet -- scripts/tests/suites.json && ok "T5 clase 11: el pisado que sale de la lista vuelve al contenido público" \
  || mal "T5 clase 11: suites.json quedó con el contenido interno viejo: $(g "$ARBOL" status --porcelain)"
[ -z "$(g "$ARBOL" status --porcelain)" ] && ok "T5 clase 11: …y git status queda limpio" || mal "T5 clase 11: git status: «$(g "$ARBOL" status --porcelain)»"
[ "$(j "$MANIFIESTO" "any(f['path']=='scripts/tests/suites.json' for f in d['files'])")" = False ] \
  && ok "T5 clase 11: …y sale del manifiesto" || mal "T5 clase 11: sigue en el manifiesto"
case "$SALIDA" in *"1 volvieron al público"*) ok "T5 clase 11: …y lo dice" ;; *) mal "T5 clase 11: no dice que volvió al público: $SALIDA" ;; esac
# editado a mano: no se toca, se avisa y queda marcado hasta que la persona lo resuelve
layer_apply "$BASE/git-8.log" "$BASE/capa-2.json"
printf 'a mano otra vez\n' >> "$ARBOL/scripts/tests/suites.json"
S_MANO="$(sha "$ARBOL/scripts/tests/suites.json")"
layer_apply "$BASE/git-9.log" "$BASE/capa-3.json"
[ "$(sha "$ARBOL/scripts/tests/suites.json")" = "$S_MANO" ] && case "$SALIDA" in *scripts/tests/suites.json*) ok "T5 clase 13: el pisado editado a mano que sale de la lista no se toca y se avisa" ;; *) mal "T5 clase 13: no lo avisa: $SALIDA" ;; esac \
  || mal "T5 clase 13: pisó el pisado editado a mano"
[ "$(j "$MANIFIESTO" "[f.get('held') for f in d['files'] if f['path']=='scripts/tests/suites.json']")" = "[True]" ] \
  && ok "T5 clase 13: …queda en el manifiesto, marcado" || mal "T5 clase 13: en el manifiesto: $(j "$MANIFIESTO" "[f for f in d['files'] if f['path']=='scripts/tests/suites.json']")"
layer_apply "$BASE/git-10.log" "$BASE/capa-3.json"
case "$SALIDA" in *scripts/tests/suites.json*) ok "T5 clase 13: …y se sigue avisando en la ejecución siguiente" ;; *) mal "T5 clase 13: dejó de avisarlo: $SALIDA" ;; esac
g "$ARBOL" checkout -q -- scripts/tests/suites.json
layer_apply "$BASE/git-11.log" "$BASE/capa-3.json"
[ "$(j "$MANIFIESTO" "any(f['path']=='scripts/tests/suites.json' for f in d['files'])")" = False ] && [ -z "$(g "$ARBOL" status --porcelain)" ] \
  && ok "T5 clase 13: la persona lo vuelve al público → sale del manifiesto, árbol limpio" || mal "T5 clase 13: después del checkout: $(g "$ARBOL" status --porcelain)"
# lo que vuelve al público ya no traba nada después: lo pisado sigue siendo del mecanismo hasta que sale
layer_apply "$BASE/git-12.log" "$BASE/capa-2.json"
layer_apply "$BASE/git-13.log" "$BASE/capa-3.json"
SALIDA_V="$(node "$LAYER" verify --tree "$ARBOL" --manifest "$MANIFIESTO" 2>&1)"
g "$ARBOL" diff --quiet -- scripts/tests/suites.json && case "$SALIDA_V" in *suites.json*) mal "T5 clase 7: verify todavía lo nombra: $SALIDA_V" ;; *) ok "T5 clase 7: apilar, sacar y volver a apilar deja el árbol en el público, sin restos" ;; esac \
  || mal "T5 clase 7: $(g "$ARBOL" status --porcelain)"
cp "$BASE/capa-3.json" "$BASE/capa-4.json"

# ── el bloque # tycon-layer con CRLF, espacios al final o sin cierre ─────────────────
# Un fin con «\r» o con espacios se reconoce igual; si no, la primera corrida agregaría otro bloque y la segunda se comería
# las líneas de la persona que quedan entre los dos. Los bloques sobrantes se juntan
# en uno, y un bloque que empieza y no cierra frena antes de escribir nada (nunca se adivina dónde termina).
EXF="$ARBOL/.git/info/exclude"
begins() { grep -c '^# tycon-layer begin' "$EXF"; }
own_lines() { grep -c -e '^mis-cosas/' -e '^# lo mío' -e '^mis-notas/' "$EXF"; }
layer_apply "$BASE/git-14.log" "$BASE/capa-4.json"
cp "$EXF" "$BASE/exclude-bien"
python3 - "$EXF" <<'PY'
import sys
p = sys.argv[1]; t = open(p, encoding='utf-8').read() + 'mis-cosas/\n'
open(p, 'w', encoding='utf-8', newline='').write(t.replace('\n', '\r\n'))
PY
layer_apply "$BASE/git-15.log" "$BASE/capa-4.json"
E1="$(mtime "$EXF")"
layer_apply "$BASE/git-16.log" "$BASE/capa-4.json"
[ "$(begins)" = 1 ] && [ "$(own_lines)" = 3 ] && ok "T5 clase 4: con CRLF, un solo bloque y las líneas de la persona intactas (dos ejecuciones)" \
  || mal "T5 clase 4: CRLF: $(begins) bloques, $(own_lines) líneas de la persona: $(cat -A "$EXF" 2>/dev/null || cat "$EXF")"
[ "$(mtime "$EXF")" = "$E1" ] && ok "T5 clase 4: con CRLF, la segunda ejecución no reescribe el exclude" || mal "T5 clase 4: con CRLF, la segunda ejecución reescribió el exclude"
[ -z "$(g "$ARBOL" status --porcelain)" ] && ok "T5 clase 4: con CRLF, el bloque sigue excluyendo" || mal "T5 clase 4: git status con CRLF: «$(g "$ARBOL" status --porcelain)»"
# lo que dejó la versión anterior: dos bloques completos con una línea de la persona en el medio
{ cat "$BASE/exclude-bien"; printf 'mis-cosas/\n'; sed -n '/^# tycon-layer begin/,/^# tycon-layer end/p' "$BASE/exclude-bien"; } > "$EXF"
layer_apply "$BASE/git-17.log" "$BASE/capa-4.json"
[ "$(begins)" = 1 ] && [ "$(own_lines)" = 3 ] && ok "T5 clase 14: dos bloques completos quedan en uno, sin tocar lo de la persona" \
  || mal "T5 clase 14: dos bloques: $(begins) bloques, $(own_lines) líneas de la persona: $(cat "$EXF")"
# el fin con espacios al final
{ sed 's/^# tycon-layer end$/# tycon-layer end   /' "$BASE/exclude-bien"; printf 'mis-cosas/\n'; } > "$EXF"
layer_apply "$BASE/git-18.log" "$BASE/capa-4.json"
layer_apply "$BASE/git-19.log" "$BASE/capa-4.json"
[ "$(begins)" = 1 ] && [ "$(own_lines)" = 3 ] && ok "T5 clase 14: un fin con espacios al final se reconoce (dos ejecuciones)" \
  || mal "T5 clase 14: fin con espacios: $(begins) bloques, $(own_lines) líneas de la persona: $(cat "$EXF")"
# un bloque que empieza y no cierra: frena antes de escribir nada
{ grep -v '^# tycon-layer end' "$BASE/exclude-bien"; printf 'mis-cosas/\n'; } > "$EXF"
rm -f "$ARBOL/tasks/tarea.md"
ANTES="$(tree_hash "$ARBOL")"; M_ANTES="$(mtime "$MANIFIESTO")"
layer_apply "$BASE/git-20.log" "$BASE/capa-4.json"
[ "$RC" = 2 ] && case "$SALIDA" in *"no cierra"*exclude*|*exclude*"no cierra"*) ok "T5 clase 14: un bloque sin cierre frena (exit 2) y dice dónde" ;; *) mal "T5 clase 14: sin cierre, el mensaje no lo dice: $SALIDA" ;; esac \
  || mal "T5 clase 14: sin cierre: rc $RC: $SALIDA"
[ "$(tree_hash "$ARBOL")" = "$ANTES" ] && [ "$(mtime "$MANIFIESTO")" = "$M_ANTES" ] && [ "$(own_lines)" = 3 ] \
  && ok "T5 clase 14: …sin escribir nada (ni el agregado que falta, ni el manifiesto, ni el exclude)" || mal "T5 clase 14: sin cierre, escribió algo: $(cat "$EXF")"

# ── un enlace o un submódulo en la capa frenan todo antes de escribir ────────────────────────────────────────────────
ENL="$BASE/interno-enlaces"; mkdir -p "$ENL"; g "$ENL" init -q
put "$ENL" guides/guia.md 'pública'
put "$ENL" tasks/normal.md 'un agregado normal'
mkdir -p "$ENL/scripts/publishing"
cp "$RAIZ/scripts/tests/fixtures/layer-lab-allowlist.json" "$ENL/scripts/publishing/allowlist.json"
cp "$RAIZ/scripts/tests/fixtures/layer-lab-table.json" "$ENL/scripts/publishing/replacements.json"
g "$ENL" add -A
BLOB_LINK="$(printf 'guides/guia.md' | g "$ENL" hash-object -w --stdin)"
g "$ENL" update-index --add --cacheinfo "120000,$BLOB_LINK,tasks/enlace"
g "$ENL" commit -q -m base
g "$ENL" update-index --add --cacheinfo "160000,$(g "$ENL" rev-parse HEAD),tasks/modulo"
g "$ENL" commit -q -m 'con un submódulo'
node "$TOY" --internal "$ENL" --out "$BASE/publico-enlaces" --leave-out tasks/ >/dev/null || mal "T5 el exportador de juguete (enlaces) falló"
node "$LAYER" compute --internal "$ENL" --public "$BASE/publico-enlaces" --out "$BASE/capa-enl.json" >/dev/null 2>&1 || mal "T5 compute con enlaces no salió 0"
for caso in "tasks/enlace:enlace" "tasks/modulo:submódulo"; do
  RUTA="${caso%%:*}"; QUE="${caso#*:}"
  python3 - "$BASE/capa-enl.json" "$RUTA" "$BASE/capa-$QUE.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
d['entries'] = [e for e in d['entries'] if e['path'] in (sys.argv[2], 'tasks/normal.md')]
open(sys.argv[3], 'w', encoding='utf-8').write(json.dumps(d))
PY
  rm -rf "$BASE/arbol-enl"; g "$BASE" clone -q "$BASE/publico-enlaces" "$BASE/arbol-enl"
  ANTES="$(tree_hash "$BASE/arbol-enl")"
  SALIDA="$(node "$LAYER" apply --tree "$BASE/arbol-enl" --from "$ENL" --list "$BASE/capa-$QUE.json" --manifest "$BASE/estado-enl/layer.json" 2>&1)"; RC=$?
  [ "$RC" = 2 ] && case "$SALIDA" in *"$RUTA"*) ok "T5 un $QUE en la capa: exit 2 nombrando la ruta" ;; *) mal "T5 $QUE: no nombra la ruta: $SALIDA" ;; esac || mal "T5 $QUE: rc $RC: $SALIDA"
  [ "$(tree_hash "$BASE/arbol-enl")" = "$ANTES" ] && [ ! -e "$BASE/estado-enl/layer.json" ] && [ ! -e "$BASE/arbol-enl/tasks/normal.md" ] \
    && ok "T5 …sin escribir nada (ni el agregado normal, ni el manifiesto)" || mal "T5 $QUE: escribió algo antes de frenar"
done

if [ "$FALLOS" = 0 ]; then echo "✅ harness-layer: todo verde"; exit 0; fi
echo "❌ harness-layer: $FALLOS fallo(s)"; exit 1
