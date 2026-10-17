#!/usr/bin/env bash
# Prueba de forms-to-version.sh — a qué formularios hay que subirles la versión.
#
# Nace de la revisión adversarial del 2026-09-02: con `batch: true` una corrida junta varios
# merges y `git diff HEAD~1` sólo ve el último, así que el formulario del primer merge no subía
# de versión y el host lo deduplicaba — el cambio nunca llegaba, en verde. Esa corrida "dos
# merges agrupados" NO se puede provocar a voluntad en Azure DevOps (hace falta un run en curso
# cuando entra el segundo merge, con 2 carriles para toda la organización): acá se reproduce con
# una historia git sintética, que es la única forma de verificarla.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SH_V="$AQUI/scripts/ci/forms-to-version.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0
ok(){ echo "✅ versionar: $1"; }
no(){ echo "❌ versionar: $1"; fallos=$((fallos+1)); }
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
# 🔴 SIN LOS GANCHOS DEL EQUIPO (2026-09-02). Los repos de esta suite son de mentira: nacen en una
# carpeta temporal, hacen nueve commits y se borran. Correrles los ganchos globales del dev
# (`core.hooksPath`) no verifica nada y cuesta ~4 s por commit — medido: 4846 ms con ganchos contra
# 1248 ms sin ellos. Esos 36 s de más caían enteros en el ARRANQUE de cada sesión, que tiene 60 s
# antes de que la extensión de VS Code se rinda (ya pasó: el arranque llegó a 59 s el 2026-09-01).
# Se apagan SÓLO acá, con una variable de entorno: la configuración del dev no se toca.
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null

# Mundo: A ← B (B importa de A), C independiente, un pipeline y un README. Historia:
#   c1 inicial → c2 "chore: update form versions" (bump) → c3 toca A (merge 1) → c4 toca C (merge 2) = HEAD
mundo(){
  R="$TMP/repo"; rm -rf "$R"; mkdir -p "$R"; cd "$R"; git init -q -b main .
  mkdir -p form-a/src form-b/src form-c/src
  for f in a b c; do echo '{"name":"form-'"$f"'","version":"1.0.0"}' > "form-$f/package.json"; done
  echo "export const x = 1;" > form-a/src/x.ts
  echo "import { x } from '../../form-a/src/x';" > form-b/src/y.ts
  echo "export const z = 3;" > form-c/src/z.ts
  echo "trigger: main" > azure-pipelines.yml; echo "# doc" > README.md
  git add -A && git commit -qm "inicial"
  echo '{"name":"form-a","version":"1.0.1"}' > form-a/package.json
  git add -A && git commit -qm "chore: update form versions [skip ci]"
  echo "export const x = 2;" > form-a/src/x.ts; git add -A && git commit -qm "Merged PR 1: cambio en A"
  echo "export const z = 4;" > form-c/src/z.ts; git add -A && git commit -qm "Merged PR 2: cambio en C"
  cd "$AQUI"
}
corre(){ bash "$SH_V" --repo "$R" "$@" 2>"$TMP/err.txt"; }

mundo
# ---------------------------------------------------------------- 1. 🔴 DOS MERGES AGRUPADOS
# HEAD~1 sólo vería a C. La base correcta (el último bump) ve a A (merge 1) y a C (merge 2), y
# suma a B, que depende de A. Los tres.
L=$(corre); rc=$?
[ "$rc" -eq 0 ] && [ "$(echo "$L" | sort | tr '\n' ' ')" = "form-a form-b form-c " ] \
  && ok "🔴 dos merges agrupados: versiona el del PRIMER merge (A), el del segundo (C) y el dependiente (B)" \
  || no "🔴 con dos merges agrupados dio [$(echo $L)] rc=$rc — $(cat "$TMP/err.txt")"
grep -qE "versión publicada|qué cambió|commit de versiones" "$TMP/err.txt" \
  && ok "…y explica de dónde saca cada base (la de qué cambió y la de la versión publicada)" \
  || no "no explicó las bases: $(cat "$TMP/err.txt")"
# y para comparar: con HEAD~1 como base sólo saldría C — es lo que el guion existe para no hacer.
SOLO_ULTIMO=$(cd "$R" && git diff --name-only HEAD~1 HEAD | cut -d/ -f1 | sort -u | tr '\n' ' ')
[ "$SOLO_ULTIMO" = "form-c " ] && ok "…(control: HEAD~1 sólo habría visto a C)" || no "el mundo de prueba no reproduce el caso: HEAD~1 ve [$SOLO_ULTIMO]"

# ---------------------------------------------------------------- 2. --base devuelve el commit del bump
B=$(corre --base); rc=$?
ESPERADO=$(cd "$R" && git log --format=%H --grep='^chore: update form versions' -1)
[ "$rc" -eq 0 ] && [ "$B" = "$ESPERADO" ] && ok "--base devuelve el commit del último bump (para leer la versión anterior desde ahí)" || no "🔴 --base dio '$B', esperaba '$ESPERADO'"

# ---------------------------------------------------------------- 3. el otro mensaje real de bump también cuenta
(cd "$R" && echo '{"name":"form-c","version":"1.0.5"}' > form-c/package.json && git add -A && git commit -qm "chore: update versions and add deployment ZIPs [skip ci]" && echo "export const x = 3;" > form-a/src/x.ts && git add -A && git commit -qm "Merged PR 3: A otra vez")
L=$(corre)
[ "$(echo "$L" | sort | tr '\n' ' ')" = "form-a form-b " ] && ok "el mensaje 'chore: update versions and add deployment ZIPs' también es base (lo usan dos productos)" || no "🔴 con el segundo mensaje de bump dio [$(echo $L)]"

# ---------------------------------------------------------------- 4. sin bump en la historia → HEAD~1
(cd "$R" && git checkout -q --orphan sin-bump && git commit -qm "inicial sin bump" && echo "export const z = 9;" > form-c/src/z.ts && git add -A && git commit -qm "Merged PR: C")
L=$(corre); rc=$?
[ "$rc" -eq 0 ] && [ "$(echo "$L" | tr '\n' ' ')" = "form-c " ] && ok "sin un commit de versiones en la historia, cae a HEAD~1" || no "🔴 sin bump dio [$(echo $L)] rc=$rc"
grep -q "HEAD~1" "$TMP/err.txt" && ok "…y lo dice" || no "no dijo que usó HEAD~1"

# ---------------------------------------------------------------- 5. sólo el pipeline / docs → nada, y sale 0
(cd "$R" && echo "trigger: none" > azure-pipelines.yml && echo "# otro" > README.md && git add -A && git commit -qm "Merged PR: pipeline")
L=$(corre); rc=$?
[ "$rc" -eq 0 ] && [ -z "$(echo "$L" | tr -d '[:space:]')" ] && ok "un merge que sólo toca el pipeline y docs no versiona a nadie (vacío + 0)" || no "🔴 sólo-pipeline dio [$(echo $L)] rc=$rc"

# ---------------------------------------------------------------- 6. 🔴 sin formularios NO es 'nada que versionar'
mkdir -p "$TMP/vacio" && (cd "$TMP/vacio" && git init -q -b main . && echo x > a.txt && git add -A && git commit -qm "uno" && echo y > a.txt && git add -A && git commit -qm "dos")
bash "$SH_V" --repo "$TMP/vacio" >"$TMP/o6.txt" 2>"$TMP/e6.txt"; rc=$?
[ "$rc" -eq 1 ] && ok "🔴 un repo sin formularios sale 1 (no pude decidir), no vacío + 0" || no "🔴 sin formularios salió $rc: $(cat "$TMP/e6.txt")"

# ---------------------------------------------------------------- 7. sin el guion hermano no decide
mkdir -p "$TMP/solo" && cp "$SH_V" "$TMP/solo/"
mundo
bash "$TMP/solo/forms-to-version.sh" --repo "$R" >"$TMP/o7.txt" 2>"$TMP/e7.txt"; rc=$?
[ "$rc" -eq 1 ] && grep -q "affected-forms.js" "$TMP/e7.txt" && ok "sin affected-forms.js al lado, sale 1 y lo dice" || no "🔴 sin el guion hermano salió $rc: $(cat "$TMP/e7.txt")"

# ---------------------------------------------------------------- T25 (7b). sin la base compartida tampoco
# La base la decide scripts/ci/run-base.sh, compartido con label-prs.sh desde la story 2.17.
# Si no está al lado, el guion no puede decidir y tiene que salir 1 diciéndolo — no vacío + 0.
mkdir -p "$TMP/sinbase" && cp "$SH_V" "$AQUI/scripts/ci/affected-forms.js" "$TMP/sinbase/"
mundo
bash "$TMP/sinbase/forms-to-version.sh" --repo "$R" >"$TMP/o7b.txt" 2>"$TMP/e7b.txt"; rc=$?
[ "$rc" -eq 1 ] && grep -q "run-base.sh" "$TMP/e7b.txt" && ok "sin run-base.sh al lado, sale 1 y lo dice" || no "🔴 sin la base compartida salió $rc: $(cat "$TMP/e7b.txt")"

# ---------------------------------------------------------------- 8. fuera de un repo git, no decide
mkdir -p "$TMP/nogit"; bash "$SH_V" --repo "$TMP/nogit" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 1 ] && ok "fuera de un repo git sale 1" || no "🔴 fuera de git salió $rc"

# ---------------------------------------------------------------- 9. 🔴 EL BUMP REBASADO (2026-09-03)
# El defecto que motivó que la base sea el commit ANOTADO y no el commit del bot. La corrida A parte
# del merge 1; mientras corre entra el merge 2; el push de A rebota y su commit de versiones queda
# ENCIMA del merge 2. La corrida siguiente tomaba ese commit como base y el merge 2 caía afuera: su
# formulario nunca subía de versión, el host lo deduplicaba por versión igual, y el cambio no
# llegaba ni a staging ni a producción — TODO VERDE. Reproducido con el guion real.
D="$TMP/rebasado"; mkdir -p "$D"
( cd "$D" && git init -q -b main . && git config user.email t@t && git config user.name t
  for f in F G H; do mkdir -p "$f/src"; printf '{"name":"%s","version":"1.0.0"}\n' "$f" > "$f/package.json"; echo x > "$f/src/i.ts"; done
  git add F G H && git commit -qm init
  git commit -q --allow-empty -m "chore: update form versions [skip ci]"
  echo m1 >> F/src/i.ts && git commit -qam "Merged PR 1: F"
  SHA_A=$(git rev-parse HEAD)
  echo m2 >> G/src/i.ts && git commit -qam "Merged PR 2: G"
  printf '{"name":"F","version":"1.0.1"}\n' > F/package.json
  git commit -qam "chore: update form versions [skip ci]" -m "Commit: $SHA_A"
  echo m3 >> H/src/i.ts && git commit -qam "Merged PR 3: H" ) >/dev/null 2>&1
L=$(bash "$SH_V" --repo "$D" 2>"$TMP/e9.txt")
echo "$L" | grep -x "G" >/dev/null && ok "🔴 el bump rebasado NO esconde el merge que quedó debajo (G se versiona)" \
  || no "🔴 G NO se versiona — sale con código nuevo y versión vieja, el host lo deduplica y el cambio no llega, en verde. Dio: [$(echo $L)]"
echo "$L" | grep -x "H" >/dev/null && ok "…y el formulario de la corrida propia también (H)" || no "H no se versiona: [$(echo $L)]"

# ---------------------------------------------------------------- 9b. y NO re-versiona lo de la corrida anterior
# El gemelo del caso 9, y el que casi se me escapa: si la base es el commit del que partió la corrida
# anterior, el commit de versiones de ESA corrida cae dentro del rango. Con un diff plano, F volvería
# a versionarse en cada corrida para siempre — el arreglo del caso 9 pagado con ruido perpetuo.
echo "$L" | grep -x "F" >/dev/null \
  && no "🔴 F se re-versiona: el commit de versiones de la corrida anterior está entrando al rango" \
  || ok "…y NO vuelve a versionar lo que ya versionó la corrida anterior (F queda afuera)"

D3="$TMP/sin-rebase"; mkdir -p "$D3"
( cd "$D3" && git init -q -b main . && git config user.email t@t && git config user.name t
  for f in F G; do mkdir -p "$f/src"; printf '{"name":"%s","version":"1.0.0"}\n' "$f" > "$f/package.json"; echo x > "$f/src/i.ts"; done
  git add F G && git commit -qm init
  git commit -q --allow-empty -m "chore: update form versions [skip ci]"
  echo m1 >> F/src/i.ts && git commit -qam "Merged PR 1: F"
  SHA=$(git rev-parse HEAD)
  printf '{"name":"F","version":"1.0.1"}\n' > F/package.json
  git commit -qam "chore: update form versions [skip ci]" -m "Commit: $SHA"
  echo m2 >> G/src/i.ts && git commit -qam "Merged PR 2: G" ) >/dev/null 2>&1
L3=$(bash "$SH_V" --repo "$D3" 2>/dev/null)
[ "$(echo "$L3" | tr -d '[:space:]')" = "G" ] \
  && ok "el caso normal sin rebase versiona sólo el formulario nuevo (G), no los dos" \
  || no "🔴 el caso normal dio [$(echo $L3)] en vez de sólo G"

# ---------------------------------------------------------------- 10. sin la anotación, avisa (no se calla)
D2="$TMP/sin-anotacion"; mkdir -p "$D2"
( cd "$D2" && git init -q -b main . && git config user.email t@t && git config user.name t
  mkdir -p F/src && printf '{"name":"F","version":"1.0.0"}\n' > F/package.json && echo x > F/src/i.ts
  git add F && git commit -qm init
  git commit -q --allow-empty -m "chore: update form versions [skip ci]"
  echo m >> F/src/i.ts && git commit -qam "Merged PR 1: F" ) >/dev/null 2>&1
bash "$SH_V" --repo "$D2" >/dev/null 2>"$TMP/e10.txt"
grep -q "AVISO.*no anota de qué commit partió" "$TMP/e10.txt" \
  && ok "un commit de versiones sin la anotación AVISA en vez de callarse" \
  || no "🔴 sin la anotación se cae al modo viejo EN SILENCIO: $(cat "$TMP/e10.txt")"

# ---------------------------------------------------------------- 11. 🔴 DOS PREGUNTAS, DOS BASES
# El primer intento del 2026-09-03 usó UNA base para las dos preguntas y ROMPIÓ el caso normal
# mientras arreglaba el raro: `--base` devolvía el commit del que partió la corrida anterior, así que
# el pipeline leía de ahí la "versión anterior" — o sea la ANTERIOR AL BUMP. El número nuevo repetía
# el que la corrida previa ya había publicado, el host lo deduplicaba, el humo lo aprobaba porque la
# versión coincide, y el cambio NO LLEGABA NUNCA. Lo cazó el revisor de formularios el mismo día.
D4="$TMP/dos-bases"; mkdir -p "$D4"
( cd "$D4" && git init -q -b main . && git config user.email t@t && git config user.name t
  mkdir -p A/src B/src
  printf '{"name":"A","version":"1.0.4"}\n' > A/package.json; echo x > A/src/i.ts
  printf '{"name":"B","version":"2.0.0"}\n' > B/package.json; echo x > B/src/i.ts
  git add A B && git commit -qm init
  echo m0 >> A/src/i.ts && git commit -qam "Merged PR 0: A"
  SHA0=$(git rev-parse HEAD)
  printf '{"name":"A","version":"1.0.5"}\n' > A/package.json
  git commit -qam "chore: update form versions [skip ci]" -m "Commit: $SHA0"
  echo m1 >> A/src/i.ts && git commit -qam "Merged PR 1: A otra vez" ) >/dev/null 2>&1

BASE_V=$(bash "$SH_V" --repo "$D4" --base 2>/dev/null)
VER_EN_BASE=$(cd "$D4" && git show "$BASE_V":A/package.json 2>/dev/null | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
[ "$VER_EN_BASE" = "1.0.5" ] \
  && ok "🔴 --base apunta a donde está la versión PUBLICADA (1.0.5), no a la anterior al bump" \
  || no "🔴 --base da la versión $VER_EN_BASE: el pipeline calcularía un número YA PUBLICADO, el host lo deduplica y el cambio no llega"

# Y el rango de "qué cambió" sigue siendo el amplio: A tiene que estar.
echo "$(bash "$SH_V" --repo "$D4" 2>/dev/null)" | grep -x "A" >/dev/null \
  && ok "…y el rango de qué cambió sigue viendo el merge (A se versiona)" \
  || no "🔴 al separar las bases se perdió el formulario del merge"

# ---------------------------------------------------------------- 12. …y el número final es el correcto
VER_PUB=$(cd "$D4" && git show "$BASE_V":A/package.json | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
IFS='.' read -r MA MI PA <<< "$VER_PUB"; ESPERADO="$MA.$MI.$((PA+1))"
[ "$ESPERADO" = "1.0.6" ] \
  && ok "el número que sale de esa base es 1.0.6 — supera a la publicada, así que el cambio llega" \
  || no "🔴 el número calculado sería $ESPERADO"

# ---------------------------------------------------------------- 13. 🔴 LA MARCA VACÍA
# Cuando una corrida no deja cambio de versión —una persona la subió a mano en el pull request, o un
# formulario nuevo nació en 1.0.0— el bot no tenía nada que commitear y NO dejaba rastro. La corrida
# siguiente partía de una base VIEJA y proponía un número YA PUBLICADO: el host lo deduplicaba, el
# humo lo aprobaba porque la versión coincide, y el cambio del cliente no llegaba nunca, EN VERDE.
# Desde el 2026-09-03 el bot deja igual un commit VACÍO con la anotación. Este caso prueba que ese
# commit vacío sirve para las dos preguntas: la versión publicada se lee bien de él, y el rango de
# "qué cambió" arranca donde debe.
D5="$TMP/marca-vacia"; mkdir -p "$D5"
( cd "$D5" && git init -q -b main . && git config user.email t@t && git config user.name t
  mkdir -p A/src; printf '{"name":"A","version":"1.0.4"}\n' > A/package.json; echo x > A/src/i.ts
  git add A && git commit -qm init
  echo m0 >> A/src/i.ts && git commit -qam "Merged PR 0: A"
  # una persona sube la versión a mano en ESE merge
  printf '{"name":"A","version":"1.1.0"}\n' > A/package.json && git commit -qam "Merged PR 0b: subo la version a mano"
  SHA=$(git rev-parse HEAD)
  # el bot no tiene nada que commitear, pero deja la marca VACÍA
  git commit -q --allow-empty -m "chore: update form versions [skip ci]" -m "Commit: $SHA"
  echo m1 >> A/src/i.ts && git commit -qam "Merged PR 1: A" ) >/dev/null 2>&1
BV=$(bash "$SH_V" --repo "$D5" --base 2>/dev/null)
VER=$(cd "$D5" && git show "$BV":A/package.json 2>/dev/null | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
[ "$VER" = "1.1.0" ] \
  && ok "🔴 la marca VACÍA sirve: la versión publicada se lee de ella (1.1.0, la que subió la persona)" \
  || no "🔴 la versión publicada salió '$VER' en vez de 1.1.0 — el número siguiente repetiría lo ya publicado y el cambio no llegaría"
echo "$(bash "$SH_V" --repo "$D5" 2>/dev/null)" | grep -x "A" >/dev/null \
  && ok "…y el rango de qué cambió ve el merge posterior a la marca" \
  || no "🔴 con la marca vacía se perdió el formulario del merge siguiente"

# ================================================================ MERGES REALES (story 1.9)
# 🔴 UN MERGE NO VERSIONA LO QUE YA ESTABA VERSIONADO (2026-09-21). El bucle recorría TODOS los
# commits del rango y además diffeaba cada merge contra su primer padre: ahí re-aparecía el commit
# de versiones del bot, que vive sólo en `main` y vuelve a entrar a `dev` con cada merge (rama de
# feature cortada de `main`, o «chore: bajar main a dev»). Resultado real en un repo de formularios: las
# cuatro corridas de `main` de septiembre versionaron y redesplegaron los 33 formularios con 1 a 3
# cambiados de verdad. Los dos casos de abajo son las dos variantes, con merges de git reales.
# Medición: tasks/medicion-1.9-merges-que-reversionan-2026-09-21.md
#
# Mundo común: tres formularios INDEPENDIENTES en 1.0.0 (así "sólo form-c" no depende del grafo de
# imports) y el commit del bot que los sube a 1.0.1 con su marca `Commit: <inicial>` — o sea, la
# base de "qué cambió" es el commit inicial y el commit del bot cae DENTRO del rango.
INIT=""
mundo_merges(){          # $1 = carpeta; deja el sha del commit inicial en $INIT
  local MM="$1"; rm -rf "$MM"; mkdir -p "$MM"
  ( cd "$MM" && git init -q -b main .
    for f in a b c; do
      mkdir -p "form-$f/src"
      printf '{"name":"form-%s","version":"1.0.0"}\n' "$f" > "form-$f/package.json"
      echo "export const $f = 1;" > "form-$f/src/i.ts"
    done
    echo "trigger: main" > azure-pipelines.yml
    git add -A && git commit -qm "inicial"
    I=$(git rev-parse HEAD)
    for f in a b c; do printf '{"name":"form-%s","version":"1.0.1"}\n' "$f" > "form-$f/package.json"; done
    git add -A && git commit -qm "chore: update form versions [skip ci]" -m "Commit: $I" ) >/dev/null 2>&1
  INIT=$(cd "$MM" && git rev-parse HEAD~1)
}

# ---------------------------------------------------------------- T1. 🔴 RAMA CORTADA DE MAIN
# La variante del build 10816: `feature/g-12` nació de `main` (que ya tenía el commit del bot) y se
# mergeó a `dev` (que no lo tenía). El diff de ESE merge contra su primer padre re-muestra los tres
# package.json. Sólo se tocó form-c: sólo form-c tiene que versionarse.
T1D="$TMP/t1-rama-desde-main"; mundo_merges "$T1D"
( cd "$T1D"
  git checkout -q -b dev "$INIT"
  git checkout -q -b feat main
  echo "export const c = 2;" > form-c/src/i.ts && git commit -qam "feat: C"
  git checkout -q dev && git merge -q --no-ff feat -m "Merge pull request 1 from feat into dev"
  git checkout -q main && git merge -q --no-ff dev -m "Merge pull request 2 from dev into main" ) >/dev/null 2>&1
# control de que el fixture reproduce el caso: el merge a dev SÍ re-muestra los 3 package.json del bot
RUIDO=$(cd "$T1D" && git diff --name-only 'dev^' dev | grep -c 'package.json')
[ "$RUIDO" -eq 3 ] && ok "T1 (control): el merge a dev re-muestra los 3 package.json del bot — el fixture reproduce el caso" \
  || no "🔴 T1: el fixture NO reproduce el caso (el merge a dev muestra $RUIDO package.json, esperaba 3)"
L=$(bash "$SH_V" --repo "$T1D" 2>"$TMP/e-t1.txt")
[ "$(echo "$L" | tr '\n' ' ')" = "form-c " ] \
  && ok "🔴 T1 rama cortada de main y mergeada a dev: versiona SÓLO el formulario tocado (form-c)" \
  || no "🔴 T1 dio [$(echo $L)] en vez de form-c — un merge está volviendo a versionar lo que la corrida anterior ya versionó"
grep -qF "] 1 archivo(s) cambiado(s)" "$TMP/e-t1.txt" \
  && ok "…y la cuenta de archivos no incluye lo que sólo el merge mostraba (1, no 4)" \
  || no "🔴 T1: la cuenta de archivos salió [$(grep -F 'archivo(s) cambiado' "$TMP/e-t1.txt")], esperaba 1"

# ---------------------------------------------------------------- T2. 🔴 BAJAR MAIN A DEV
# La otra variante (corrida del 16/09): nadie corta de `main`, pero `dev` baja `main` con un merge
# para ponerse al día y ese merge trae el commit del bot. Mismo daño, misma cuenta.
T2D="$TMP/t2-bajar-main-a-dev"; mundo_merges "$T2D"
( cd "$T2D"
  git checkout -q -b dev "$INIT"
  echo "# doc" > README.md && git add -A && git commit -qm "docs: readme"
  git merge -q --no-ff main -m "chore: bajar main a dev (queda al dia) [skip ci]"
  git checkout -q -b feat
  echo "export const c = 2;" > form-c/src/i.ts && git commit -qam "feat: C"
  git checkout -q dev && git merge -q --no-ff feat -m "Merge pull request 1 from feat into dev"
  git checkout -q main && git merge -q --no-ff dev -m "Merge pull request 2 from dev into main" ) >/dev/null 2>&1
# control: el merge «bajar main a dev» SÍ re-muestra los 3 package.json del bot
BAJA=$(cd "$T2D" && git log --format=%H --grep='bajar main a dev' -1)
RUIDO=$(cd "$T2D" && git diff --name-only "${BAJA}^" "$BAJA" | grep -c 'package.json')
[ -n "$BAJA" ] && [ "$RUIDO" -eq 3 ] && ok "T2 (control): el merge «bajar main a dev» re-muestra los 3 package.json — el fixture reproduce el caso" \
  || no "🔴 T2: el fixture NO reproduce el caso (el merge de sincronización muestra $RUIDO package.json, esperaba 3)"
L=$(bash "$SH_V" --repo "$T2D" 2>"$TMP/e-t2.txt")
[ "$(echo "$L" | tr '\n' ' ')" = "form-c " ] \
  && ok "🔴 T2 «bajar main a dev» por merge: versiona SÓLO form-c, no los tres" \
  || no "🔴 T2 dio [$(echo $L)] en vez de form-c — la propia sincronización de dev está re-versionando"

# ---------------------------------------------------------------- T3. el package.json con cambio REAL sigue contando
# Lo que se saltea es el MERGE, no el archivo: si una rama toca de verdad un package.json (una
# dependencia nueva, no sólo el número de versión), su formulario se versiona igual.
T3D="$TMP/t3-package-real"; mundo_merges "$T3D"
( cd "$T3D"
  git checkout -q -b dev "$INIT"
  git checkout -q -b feat main
  echo "export const c = 2;" > form-c/src/i.ts
  printf '{"name":"form-c","version":"1.0.1","dependencies":{"algo":"1.0.0"}}\n' > form-c/package.json
  git commit -qam "feat: C con dependencia nueva"
  git checkout -q dev && git merge -q --no-ff feat -m "Merge pull request 1 from feat into dev"
  git checkout -q main && git merge -q --no-ff dev -m "Merge pull request 2 from dev into main" ) >/dev/null 2>&1
# control: el merge a dev re-muestra los package.json del bot Y el cambio real convive con ellos
RUIDO=$(cd "$T3D" && git diff --name-only 'dev^' dev | grep -c 'package.json')
[ "$RUIDO" -eq 3 ] && ok "T3 (control): el merge a dev re-muestra los 3 package.json — el cambio real hay que distinguirlo de ese ruido" \
  || no "🔴 T3: el fixture NO reproduce el caso (el merge a dev muestra $RUIDO package.json, esperaba 3)"
L=$(bash "$SH_V" --repo "$T3D" 2>/dev/null)
[ "$(echo "$L" | tr '\n' ' ')" = "form-c " ] \
  && ok "T3 un package.json con cambio real (dependencia nueva) sigue versionando: se saltea el merge, no el archivo" \
  || no "🔴 T3 dio [$(echo $L)] en vez de form-c"

# ---------------------------------------------------------------- T4. conflicto resuelto en el merge
# El límite declarado del arreglo: la resolución en sí no suma ni resta, pero el formulario en
# conflicto se versiona igual porque lo aportan los dos commits que lo causaron (los dos del rango).
T4D="$TMP/t4-conflicto"; mundo_merges "$T4D"
( cd "$T4D"
  git checkout -q -b feat main
  echo "export const a = 2;" > form-a/src/i.ts && git commit -qam "feat: A vale 2"
  git checkout -q main
  echo "export const a = 3;" > form-a/src/i.ts && git commit -qam "fix: A vale 3"
  git merge --no-ff feat -m "Merge pull request 1 from feat into main (conflicto resuelto)"
  echo "export const a = 23;" > form-a/src/i.ts && git add -A
  git commit -qm "Merge pull request 1 from feat into main (conflicto resuelto)" ) >/dev/null 2>&1
# control: HEAD es un merge de verdad y la resolución no es ninguno de los dos lados
ESMERGE=$(cd "$T4D" && git rev-parse -q --verify 'HEAD^2' >/dev/null 2>&1 && echo si || echo no)
RESUELTO=$(cd "$T4D" && cat form-a/src/i.ts)
[ "$ESMERGE" = "si" ] && [ "$RESUELTO" = "export const a = 23;" ] \
  && ok "T4 (control): HEAD es un merge con dos padres y la resolución es propia del merge — el fixture reproduce el conflicto" \
  || no "🔴 T4: el fixture no reproduce el conflicto (merge=$ESMERGE, resolución=[$RESUELTO])"
L=$(bash "$SH_V" --repo "$T4D" 2>/dev/null)
[ "$(echo "$L" | tr '\n' ' ')" = "form-a " ] \
  && ok "T4 un conflicto resuelto en el merge no pierde el formulario: lo versionan los commits que lo causaron (form-a)" \
  || no "🔴 T4 dio [$(echo $L)] en vez de form-a"

# ---------------------------------------------------------------- T7. una RAÍZ dentro del rango se saltea
# El AC 9 pide dos cosas y son distintas: (a) que un commit cuyo primer padre no resuelve se saltee
# como siempre, y (b) que eso pase ANTES de mirar el segundo padre. Ojo con el caso 4 (`--orphan`):
# ahí la raíz es la BASE, así que queda FUERA del rango `BASE..HEAD` y no ejercita nada. Para meter
# una raíz DENTRO del rango hace falta una historia con DOS raíces: la huérfana entra por un merge
# con `--allow-unrelated-histories` y es alcanzable desde HEAD pero no desde la base.
T7D="$TMP/t7-raiz-en-el-rango"; mundo_merges "$T7D"
( cd "$T7D"
  git checkout -q --orphan huerfana
  git rm -rq --cached .
  rm -rf form-a form-b form-c azure-pipelines.yml
  mkdir -p form-b/src && echo "export const extra = 1;" > form-b/src/extra.ts
  git add -A && git commit -qm "raiz huerfana: archivo nuevo en form-b"
  git checkout -q main
  git merge -q --no-ff --allow-unrelated-histories huerfana -m "Merge pull request 9 from huerfana into main"
  echo "export const c = 2;" > form-c/src/i.ts && git commit -qam "feat: C" ) >/dev/null 2>&1
# control: la raíz huérfana está DENTRO del rango y de verdad no tiene primer padre
RAIZ=$(cd "$T7D" && git log --format=%H "$INIT..HEAD" --grep='raiz huerfana' | head -1)
[ -n "$RAIZ" ] && ! (cd "$T7D" && git rev-parse -q --verify "${RAIZ}^" >/dev/null 2>&1) \
  && ok "T7 (control): hay una raíz sin primer padre DENTRO del rango — el guard se ejercita de verdad" \
  || no "🔴 T7: el fixture no mete una raíz sin primer padre en el rango (raíz: ${RAIZ:-ninguna})"
L=$(bash "$SH_V" --repo "$T7D" 2>"$TMP/e-t7.txt"); rc=$?
[ "$rc" -eq 0 ] && [ "$(echo "$L" | tr '\n' ' ')" = "form-c " ] \
  && ok "T7 una raíz dentro del rango se saltea sin error y el resto se sigue contando (form-c)" \
  || no "🔴 T7 dio [$(echo $L)] rc=$rc — $(cat "$TMP/e-t7.txt")"
grep -q "no pude" "$TMP/e-t7.txt" \
  && no "🔴 T7 el guion avisó que no pudo decidir con una raíz en el rango: $(cat "$TMP/e-t7.txt")" \
  || ok "…y no se queja de no poder decidir"
# y (b): el orden vive en el código — un commit sin primer padre tampoco tiene segundo, así que el
# orden de los dos chequeos no es observable por comportamiento; se verifica donde vive.
LN_P1=$(grep -nF 'verify "${C}^"' "$SH_V" | head -1 | cut -d: -f1)
LN_P2=$(grep -nF 'verify "${C}^2"' "$SH_V" | head -1 | cut -d: -f1)
[ -n "$LN_P1" ] && [ -n "$LN_P2" ] && [ "$LN_P1" -lt "$LN_P2" ] \
  && ok "…y el chequeo del primer padre va ANTES del segundo" \
  || no "🔴 T7 el orden de los chequeos de padres no es el esperado (primero: $LN_P1, segundo: $LN_P2)"

# ---------------------------------------------------------------- T9. el guion dice que saltea los merges
grep -qF 'para que un merge cuente lo que trajo' "$SH_V" \
  && no "🔴 T9 la cabecera sigue diciendo «para que un merge cuente lo que trajo» — es justo lo que se retira" \
  || ok "T9 la frase «para que un merge cuente lo que trajo» ya no está"
grep -qF 'segundo padre' "$SH_V" && grep -qF '2026-09-21' "$SH_V" \
  && ok "…y el guion explica que los merges se saltean, con la fecha del caso" \
  || no "🔴 T9 el guion no explica el salteo de merges (falta «segundo padre» o la fecha 2026-09-21)"

# ---------------------------------------------------------------- T10. queda registrado dónde leerlo
# El índice de «cuándo leer cada guía» vive en INDEX.md desde 2026-10-14 (antes, en el README).
grep -qF 'Se versionaron y redesplegaron TODOS los formularios' "$AQUI/INDEX.md" \
  && ok "T10 el índice (INDEX.md) tiene la fila para «se versionaron todos los formularios sin motivo»" \
  || no "🔴 T10 falta la fila en la tabla «Cuándo leer cada guía» de INDEX.md"
# El registro de incidentes del equipo no se publica: el público trae un reemplazo sin casos (y no trae
# public-repos.json). Ahí la entrada no se puede medir y se dice; en el repo de mantenimiento, que falte es rojo.
if [ ! -f "$AQUI/scripts/publishing/public-repos.json" ]; then
  echo "⏭ versionar: T10 la entrada del incident-log: NO MEDIDO en el público (trae un reemplazo del registro, sin casos)"
else
grep -qF '## merges-que-reversionan-2026-09-21' "$AQUI/guides/maintaining/incident-log.md" \
  && ok "…y el incident-log tiene la entrada del caso" \
  || no '🔴 T10 falta la entrada "## merges-que-reversionan-2026-09-21" en guides/maintaining/incident-log.md'
fi

echo "─────────────"
if [ "$fallos" -eq 0 ]; then echo "✅ forms-to-version: todo verde"; exit 0; else echo "❌ forms-to-version: $fallos falla(s)"; exit 1; fi
