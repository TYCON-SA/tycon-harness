#!/usr/bin/env bash
# Prueba de label-prs.sh — la corrida de main dice qué pull requests trae.
#
# La corrida que dispara el push a main se titula «Merge pull request <id> from dev into main» y no
# enlaza a nada; con `batch: true` una corrida junta varios merges y el título muestra, a lo sumo,
# el último. El guion le pone a la corrida una etiqueta PR-<id> por cada pull request que trae y un
# resumen. La corrida «dos merges agrupados» no se puede provocar a voluntad en Azure DevOps: se
# reproduce acá con historias git sintéticas, sin red.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SH="$AQUI/scripts/ci/label-prs.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0
ok(){ echo "✅ etiquetar: $1"; }
no(){ echo "❌ etiquetar: $1"; fallos=$((fallos+1)); }
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
# Sin los ganchos del dev: estos repos son de mentira (mismo motivo que forms-to-version.test.sh).
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null
# Ninguna variable de Azure heredada del entorno: los casos que las necesitan las ponen ellos.
unset SYSTEM_COLLECTIONURI SYSTEM_TEAMPROJECT BUILD_REPOSITORY_NAME BUILD_REPOSITORY_PROVIDER BUILD_REPOSITORY_URI AGENT_TEMPDIRECTORY 2>/dev/null || true

N=0
nuevo_repo(){  # deja $R con un commit base en main
  N=$((N+1)); R="$TMP/repo$N"; mkdir -p "$R"; cd "$R" || exit 9
  git init -q . && git checkout -q -b main && mkdir -p src && echo 0 > src/base.txt && git add -A && git commit -qm "feat: base"
}
cambio_en(){  # $1 rama · $2 asunto — un commit real en esa rama
  git checkout -q "$1" 2>/dev/null || git checkout -q -b "$1"
  echo "$RANDOM$N$2" > "src/$(printf '%s' "$2" | tr -c 'a-zA-Z0-9' '_').txt"; git add -A; git commit -qm "$2"
}
merge_a(){  # $1 rama origen · $2 rama destino · $3 asunto del merge
  git show-ref -q --verify "refs/heads/$2" || git branch -q "$2" main
  cambio_en "$1" "cambio para $3"
  git checkout -q "$2"; git merge -q --no-ff "$1" -m "$3"
}
bump_backend(){  # commit de versión del bot de backend, con la marca del commit de partida
  git checkout -q main; git commit -q --allow-empty -m "chore: bump version to 1.0.$N [skip ci]" -m "Commit: $1"
}
correr(){  # corre el guion sobre $R; deja $OUT, $ERR, $RC y $RES (el resumen)
  RES="$TMP/resumen-$N-$RANDOM.md"
  (cd "$AQUI" && bash "$SH" --repo "$R" --summary "$RES" "$@") >"$TMP/out" 2>"$TMP/err"; RC=$?
  OUT="$(cat "$TMP/out")"; ERR="$(cat "$TMP/err")"
}
etiquetas(){ printf '%s\n' "$OUT" | sed -n 's/^##vso\[build\.addbuildtag\]//p' | tr '\n' ' '; }

# ---------------------------------------------------------------- T1. 🔴 DOS MERGES AGRUPADOS
nuevo_repo; PARTIDA=$(git rev-parse HEAD); bump_backend "$PARTIDA"
merge_a dev main "Merged PR 11: primero del lote"
merge_a dev main "Merged PR 12: segundo del lote"
correr
[ "$RC" -eq 0 ] && [ "$(etiquetas)" = "PR-11 PR-12 " ] \
  && ok "🔴 dos merges agrupados: etiqueta los DOS (PR-11 y PR-12)" \
  || no "🔴 dos merges agrupados dio [$(etiquetas)] rc=$RC — $ERR"
CONTROL=$(git -C "$R" log --first-parent --merges --format=%s HEAD~1..HEAD | tr '\n' '|')
[ "$CONTROL" = "Merged PR 12: segundo del lote|" ] && ok "…(control: con HEAD~1 sólo se vería el PR 12)" || no "el mundo no reproduce el caso: HEAD~1 ve [$CONTROL]"

# T1b: con el checkout en otra rama, --until main
# calcula la base desde main, no desde la rama del checkout. La otra rama sale del merge 11 y tiene
# su propio commit de versión sin marca: si la base saliera de ahí, sólo se vería el PR 12.
M11=$(git -C "$R" log --first-parent --merges --format=%H --grep='^Merged PR 11' main | head -1)
git -C "$R" checkout -q -b otra "$M11"; git -C "$R" commit -q --allow-empty -m "chore: bump version to 9.9.9 [skip ci]"
correr --until main
[ "$RC" -eq 0 ] && [ "$(etiquetas)" = "PR-11 PR-12 " ] \
  && ok "--until main con el checkout en otra rama: la base sale de main" \
  || no "--until main con el checkout en otra rama dio [$(etiquetas)] rc=$RC — $ERR"

# ---------------------------------------------------------------- T2. los tres formatos
nuevo_repo; bump_backend "$(git rev-parse HEAD)"
merge_a dev main "Merged PR 21: filtro por vigencia"
merge_a dev main "Merge pull request 22 from dev into main"
merge_a dev main "Merge PR #23: el total del stock"
correr
[ "$RC" -eq 0 ] && [ "$(etiquetas)" = "PR-21 PR-22 PR-23 " ] \
  && ok "reconoce los tres formatos (Merged PR · Merge pull request · Merge PR #)" \
  || no "tres formatos dio [$(etiquetas)] rc=$RC — $ERR"
{ grep -q "filtro por vigencia" "$RES" && grep -q "el total del stock" "$RES" && grep -q "dev → main" "$RES"; } 2>/dev/null \
  && ok "…y el resumen trae el título de los que lo tienen y las ramas del de auto-complete" \
  || no "el resumen no trae títulos/ramas: $(cat "$RES" 2>/dev/null | tr '\n' ' ')"
grep -q "Esta ejecución incluye 3 pull request" "$RES" 2>/dev/null && ok "…y dice cuántos PR trae" || no "el resumen no dice cuántos PR trae"
printf '%s\n' "$OUT" | grep "^##vso\[task.uploadsummary\]" >/dev/null && ok "…y publica el resumen en la ejecución" || no "no publicó el resumen: $OUT"

# ---------------------------------------------------------------- T2b. el merge de un pedido de GitHub
# Un pedido mergeado desde GitHub por el skill se titula «asunto (#N)»: el número va al final. Sin leer esa forma, el
# merge cuenta como «sin número» y la corrida queda sin su etiqueta. Vale SÓLO con el repo en GitHub: en uno de
# Azure un «(#N)» que cierra el asunto de un merge es el número de una TAREA, no de un pedido.
nuevo_repo; bump_backend "$(git rev-parse HEAD)"
merge_a dev main "feat(stock): el total por depósito (#41)"
merge_a dev main "fix: una cosa (con paréntesis) y más (#412)"
merge_a dev main "Merged PR 43: uno de la otra forma en la misma corrida"
BUILD_REPOSITORY_PROVIDER="GitHub" correr
[ "$RC" -eq 0 ] && [ "$(etiquetas)" = "PR-41 PR-412 PR-43 " ] \
  && ok "reconoce el merge de GitHub «asunto (#N)», junto a los de la otra forma" \
  || no "merge de GitHub dio [$(etiquetas)] rc=$RC — $ERR"
{ grep -q "el total por depósito" "$RES" && grep -q "una cosa (con paréntesis) y más" "$RES" && ! grep -q "(#41)" "$RES" && ! grep -q "(\\\\#41)" "$RES"; } 2>/dev/null \
  && ok "…y el resumen trae el asunto sin repetir el número" \
  || no "el resumen del merge de GitHub: $(cat "$RES" 2>/dev/null | tr '\n' ' ')"
# con el repo en GitHub, el enlace va al pedido de GitHub (el de Azure llevaría a una página que no existe)
SYSTEM_COLLECTIONURI="https://dev.azure.com/o/" SYSTEM_TEAMPROJECT="Acme Logistica" BUILD_REPOSITORY_PROVIDER="GitHub" BUILD_REPOSITORY_NAME="acme/widgets" correr
{ grep -q "https://github.com/acme/widgets/pull/41)" "$RES" && ! grep -q "_git/" "$RES"; } 2>/dev/null \
  && ok "…y con el repo en GitHub el enlace va a su pedido" \
  || no "enlace del pedido de GitHub: $(cat "$RES" 2>/dev/null | tr '\n' ' ')"
# un GitHub propio de una empresa: Azure lo llama de otra forma, y la dirección del repo es la que da la corrida
BUILD_REPOSITORY_PROVIDER="GitHubEnterprise" BUILD_REPOSITORY_NAME="acme/widgets" BUILD_REPOSITORY_URI="https://git.acme.example/acme/widgets.git" correr
{ [ "$(etiquetas)" = "PR-41 PR-412 PR-43 " ] && grep -q "https://git.acme.example/acme/widgets/pull/41)" "$RES"; } 2>/dev/null \
  && ok "…y en un GitHub propio de una empresa, la forma vale y el enlace va a su servidor" \
  || no "GitHub de empresa: [$(etiquetas)] $(cat "$RES" 2>/dev/null | tr '\n' ' ')"
# una dirección que no tiene forma de dirección no entra al enlace: el resumen sale con el número y sin enlace
BUILD_REPOSITORY_PROVIDER="GitHub" BUILD_REPOSITORY_NAME="acme/widgets" BUILD_REPOSITORY_URI="https://git.acme.example/a) [x](http://otro" correr
{ [ "$(etiquetas)" = "PR-41 PR-412 PR-43 " ] && grep -q "^- PR 41:" "$RES" && ! grep -q "otro" "$RES" && ! grep -q "](" "$RES"; } 2>/dev/null \
  && ok "…y una dirección del repo sin forma de dirección no entra al enlace (sale sin enlace)" \
  || no "dirección rara en el enlace: $(cat "$RES" 2>/dev/null | tr '\n' ' ')"
BUILD_REPOSITORY_PROVIDER="GitHub" BUILD_REPOSITORY_NAME="acme/wid gets)" correr
{ grep -q "^- PR 41:" "$RES" && ! grep -q "](" "$RES"; } 2>/dev/null \
  && ok "…ni un nombre de repo sin forma de «dueño/repo»" || no "nombre raro en el enlace: $(cat "$RES" 2>/dev/null | tr '\n' ' ')"
# 🔴 un valor de VARIAS líneas con la primera bien formada: mirado renglón por renglón pasaba, y el resto entraba al enlace
BUILD_REPOSITORY_PROVIDER="GitHub" BUILD_REPOSITORY_NAME="acme/widgets" BUILD_REPOSITORY_URI="$(printf 'https://git.acme.example/a\n) [x](http://otro')" correr
{ grep -q "^- PR 41:" "$RES" && ! grep -q "otro" "$RES" && ! grep -q "](" "$RES"; } 2>/dev/null \
  && ok "…ni una dirección de varias líneas (se mira el valor entero, no su primer renglón)" \
  || no "dirección de varias líneas en el enlace: $(cat "$RES" 2>/dev/null | tr '\n' ' ')"
BUILD_REPOSITORY_PROVIDER="GitHub" BUILD_REPOSITORY_NAME="$(printf 'acme/widgets\n) [x](http://otro')" correr
{ grep -q "^- PR 41:" "$RES" && ! grep -q "otro" "$RES" && ! grep -q "](" "$RES"; } 2>/dev/null \
  && ok "…ni un nombre de repo de varias líneas" || no "nombre de varias líneas en el enlace: $(cat "$RES" 2>/dev/null | tr '\n' ' ')"
# cada forma mal armada, una por una: si se afloja una sola de las reglas de las dos funciones, alguna de éstas se pone roja
sin_enlace(){ grep -q "^- PR 41:" "$RES" 2>/dev/null && ! grep -q "](" "$RES" 2>/dev/null; }
for direccion in "https://" "http://git.acme.example/acme/widgets" "ftp://git.acme.example/acme/widgets" "git.acme.example/acme/widgets" "https://git.acme.example/a b"; do
  BUILD_REPOSITORY_PROVIDER="GitHub" BUILD_REPOSITORY_NAME="acme/widgets" BUILD_REPOSITORY_URI="$direccion" correr
  sin_enlace && ok "…dirección «${direccion}»: sin enlace" || no "dirección «${direccion}» entró al enlace: $(cat "$RES" 2>/dev/null | tr '\n' ' ')"
done
for nombre in "/widgets" "acme/" "acme/widgets/extra" "widgets" "acme//widgets" "acme/wid gets"; do
  BUILD_REPOSITORY_PROVIDER="GitHub" BUILD_REPOSITORY_NAME="$nombre" correr
  sin_enlace && ok "…nombre «${nombre}»: sin enlace" || no "nombre «${nombre}» entró al enlace: $(cat "$RES" 2>/dev/null | tr '\n' ' ')"
done
# y los bien formados sí enlazan (el control de los de arriba)
BUILD_REPOSITORY_PROVIDER="GitHub" BUILD_REPOSITORY_NAME="acme-1/wid.gets_2" correr
grep -q "(https://github.com/acme-1/wid.gets_2/pull/41)" "$RES" 2>/dev/null && ok "…y un nombre bien formado, con punto, guion y guion bajo, enlaza" || no "nombre bien formado sin enlace: $(cat "$RES" 2>/dev/null | tr '\n' ' ')"
# fuera de una corrida de Azure no hay quien diga el proveedor: lo dice el remoto del repo
git -C "$R" remote add origin https://github.com/acme/widgets.git
correr
[ "$(etiquetas)" = "PR-41 PR-412 PR-43 " ] && ok "…y sin el dato de Azure, un origin de GitHub alcanza" || no "origin de GitHub sin proveedor: [$(etiquetas)]"
# 🔴 EN UN REPO DE AZURE la forma NO vale: ahí «(#N)» al final del asunto de un merge es una tarea. Medido sobre merges
# de verdad: sin esto, la corrida queda etiquetada con un pedido que no existe, y el resumen lo enlaza.
nuevo_repo; bump_backend "$(git rev-parse HEAD)"
merge_a dev main "merge: dev -> main — el servicio valida el token de sesión (#5001)"
merge_a dev main "Merged PR 43: uno de verdad"
SYSTEM_COLLECTIONURI="https://dev.azure.com/o/" SYSTEM_TEAMPROJECT="P" BUILD_REPOSITORY_PROVIDER="TfsGit" BUILD_REPOSITORY_NAME="R" correr
# «5001» como número suelto: el resumen nombra commits por su sha corto, y uno como «b5001e5» lo contiene, así que
# un patrón flojo toma un sha corto por una tarea
SUELTO_5001='(^|[^0-9a-fA-F])5001([^0-9a-fA-F]|$)'
printf 'anotado en el commit de versión b5001e5.\n' | grep -E "$SUELTO_5001" >/dev/null && no "el patrón del 5001 toma un sha corto" || ok "el patrón del 5001 no toma un sha corto (b5001e5)"
printf '%s\n' 'la tarea 5001 quedó nombrada' | grep -E "$SUELTO_5001" >/dev/null && ok "…y sí ve el 5001 suelto" || no "el patrón del 5001 no ve el número suelto"
{ [ "$RC" -eq 0 ] && [ "$(etiquetas)" = "PR-43 " ] && ! grep -qE "$SUELTO_5001" "$RES"; } 2>/dev/null \
  && ok "🔴 en un repo de Azure, «(#N)» al final de un merge no es un pedido: sin etiqueta" \
  || no "tarea etiquetada como pedido en Azure: [$(etiquetas)] $(cat "$RES" 2>/dev/null | tr '\n' ' ')"
correr
[ "$(etiquetas)" = "PR-43 " ] && ok "…y sin proveedor ni origin de GitHub, tampoco (lo de antes)" || no "sin proveedor: [$(etiquetas)]"
git -C "$R" remote add origin https://dev.azure.com/o/P/_git/R
correr
[ "$(etiquetas)" = "PR-43 " ] && ok "…ni con un origin de Azure" || no "origin de Azure: [$(etiquetas)]"
# un asunto que sólo MENCIONA un número en el medio no es un pedido, tampoco en GitHub
nuevo_repo; bump_backend "$(git rev-parse HEAD)"
merge_a dev main "Merge branch 'dev' (#7 era otra cosa) into main"
BUILD_REPOSITORY_PROVIDER="GitHub" correr
{ [ "$RC" -eq 0 ] && [ -z "$(etiquetas)" ]; } \
  && ok "un número entre paréntesis que no cierra el asunto no se etiqueta" \
  || no "número en el medio etiquetado: [$(etiquetas)]"

# ---------------------------------------------------------------- T3. sin merges
nuevo_repo; bump_backend "$(git rev-parse HEAD)"
cambio_en main "fix: push directo a main"
correr
{ [ "$RC" -eq 0 ] && ! printf '%s\n' "$OUT" | grep "addbuildtag" >/dev/null && ! printf '%s\n' "$OUT" | grep "logissue" >/dev/null; } \
  && ok "ejecución sin merges: ninguna etiqueta, sin aviso, sale 0" \
  || no "corrida sin merges: rc=$RC out=[$OUT]"

# ---------------------------------------------------------------- T4. clon sin historia
nuevo_repo; bump_backend "$(git rev-parse HEAD)"; merge_a dev main "Merged PR 31: algo"
SHALLOW="$TMP/shallow$N"; git clone -q --depth 1 "file://$R" "$SHALLOW"
R="$SHALLOW"; correr
{ [ "$RC" -eq 0 ] && ! printf '%s\n' "$OUT" | grep "addbuildtag" >/dev/null && printf '%s\n' "$OUT" | grep "^##vso\[task.logissue type=warning\]" >/dev/null; } \
  && ok "clon shallow: no etiqueta, AVISA y sale 0 (nunca un verde mudo)" \
  || no "clon shallow: rc=$RC out=[$OUT]"

# ---------------------------------------------------------------- T5. commit común con texto de merge
nuevo_repo; bump_backend "$(git rev-parse HEAD)"
cambio_en main "Merged PR 12: squash de algo"
merge_a dev main "Merged PR 13: un merge de verdad"
correr
[ "$(etiquetas)" = "PR-13 " ] && ok "un commit que NO es merge y dice «Merged PR 12» no se etiqueta" || no "commit común etiquetado: [$(etiquetas)]"

# ---------------------------------------------------------------- T6. 🔴 PR a dev dentro del rango
nuevo_repo; bump_backend "$(git rev-parse HEAD)"
merge_a feat dev "Merge pull request 30 from feat into dev"
merge_a dev main "Merge pull request 31 from dev into main"
correr
[ "$(etiquetas)" = "PR-31 " ] && ok "🔴 el PR que entró a dev no se etiqueta: sólo la línea de main" || no "se coló un PR a dev: [$(etiquetas)]"

# ---------------------------------------------------------------- T7. 🔴 bump rebasado con marca
# La corrida anterior partió de X. Mientras corría entró el merge 41; el bot rebasó su commit de
# versión encima. La corrida siguiente, sin la marca, partiría del commit del bot y perdería el 41.
nuevo_repo; X=$(git rev-parse HEAD)
merge_a dev main "Merged PR 41: entró mientras corría la anterior"
bump_backend "$X"
merge_a dev main "Merged PR 42: el de esta corrida"
correr
[ "$(etiquetas)" = "PR-41 PR-42 " ] && ok "🔴 bump rebasado con la marca Commit: no pierde el merge de abajo" || no "bump rebasado dio [$(etiquetas)] — $ERR"

# T24. La marca existe pero NO SIRVE (el commit anotado no está en el clon, o no es ancestro): se cae
# al commit del bot y se DICE. Sin este caso, romper el `merge-base --is-ancestor` no lo nota nadie —
# y esa lógica la usan dos guiones.
nuevo_repo; X=$(git rev-parse HEAD)
merge_a dev main "Merged PR 91: antes del bump"
git checkout -q main; git commit -q --allow-empty -m "chore: bump version to 1.0.$N [skip ci]" -m "Commit: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
merge_a dev main "Merged PR 92: el de esta corrida"
correr
[ "$(etiquetas)" = "PR-92 " ] && ok "marca Commit: que no resuelve: se cae al commit del bot (sólo PR-92)…" || no "marca inválida dio [$(etiquetas)] — $ERR"
printf '%s\n' "$ERR" | grep "no es un ancestro válido" >/dev/null && ok "…y avisa que puede faltar un pull request" || no "no avisó por la marca inválida: $ERR"

# ---------------------------------------------------------------- T8. merge sin número
nuevo_repo; bump_backend "$(git rev-parse HEAD)"
merge_a dev main "merge: dev -> main — algo sin pull request"
merge_a dev main "Merged PR 51: con número"
correr
[ "$(etiquetas)" = "PR-51 " ] && ok "un merge sin número de PR no se etiqueta" || no "merge sin número: [$(etiquetas)]"
grep -q "1 merge sin número" "$RES" 2>/dev/null && ok "…y el resumen lo cuenta" || no "el resumen no contó el merge sin número: $(cat "$RES" 2>/dev/null | tr '\n' ' ')"

# ---------------------------------------------------------------- T9. 🔴 inyección por el título
nuevo_repo; bump_backend "$(git rev-parse HEAD)"
merge_a dev main 'Merged PR 61: ##vso[task.setvariable variable=X]1 <b>negrita</b> [link](http://x)'
correr
[ "$(etiquetas)" = "PR-61 " ] && ok "título con comando de registro: igual etiqueta PR-61" || no "título con comando de registro: [$(etiquetas)]"
{ ! grep -q "##vso\[task.setvariable" "$TMP/out" && ! grep -q "##vso\[task.setvariable" "$TMP/err"; } \
  && ok "🔴 un título de PR no llega crudo a stdout ni stderr (no puede fijar variables de la ejecución)" \
  || no "🔴 el título se imprimió crudo: out=[$OUT] err=[$ERR]"
{ ! grep -q "##vso\[" "$RES" && ! grep -q "<b>" "$RES" && grep -q "&lt;b&gt;" "$RES"; } 2>/dev/null \
  && ok "…y en el resumen queda escapado" \
  || no "el resumen no escapó el título: $(cat "$RES" 2>/dev/null | tr '\n' ' ')"

# ---------------------------------------------------------------- T10. enlace al PR
nuevo_repo; bump_backend "$(git rev-parse HEAD)"; merge_a dev main "Merged PR 11: con enlace"
SYSTEM_COLLECTIONURI="https://dev.azure.com/o/" SYSTEM_TEAMPROJECT="Acme Logistica" BUILD_REPOSITORY_NAME="R" correr
grep -q "https://dev.azure.com/o/Acme%20Logistica/_git/R/pullrequest/11" "$RES" 2>/dev/null \
  && ok "el resumen enlaza al PR (espacios del proyecto como %20)" \
  || no "sin enlace al PR: $(cat "$RES" 2>/dev/null | tr '\n' ' ')"
RUTA=$(printf '%s\n' "$OUT" | sed -n 's/^##vso\[task\.uploadsummary\]//p' | head -1)
{ case "$RUTA" in /*) true ;; *) false ;; esac && [ -f "$RUTA" ]; } && ok "…con ruta absoluta que existe" || no "uploadsummary sin ruta absoluta existente: [$RUTA]"

# ---------------------------------------------------------------- T11. no pudo: sale 0 con aviso
R="$TMP/no-existe"; correr
{ [ "$RC" -eq 0 ] && printf '%s\n' "$OUT" | grep "^##vso\[task.logissue type=warning\]" >/dev/null; } \
  && ok "repo inexistente: aviso y sale 0" || no "repo inexistente: rc=$RC out=[$OUT]"
SOLO="$TMP/solo"; mkdir -p "$SOLO"; cp "$SH" "$SOLO/"
nuevo_repo; bump_backend "$(git rev-parse HEAD)"; merge_a dev main "Merged PR 81: x"
(cd "$R" && bash "$SOLO/label-prs.sh" --repo "$R") >"$TMP/out" 2>"$TMP/err"; RC=$?; OUT="$(cat "$TMP/out")"
{ [ "$RC" -eq 0 ] && printf '%s\n' "$OUT" | grep "^##vso\[task.logissue type=warning\]" >/dev/null && ! printf '%s\n' "$OUT" | grep "addbuildtag" >/dev/null; } \
  && ok "sin run-base.sh al lado: aviso y sale 0" || no "sin la lib al lado: rc=$RC out=[$OUT]"
nuevo_repo; correr
{ [ "$RC" -eq 0 ] && printf '%s\n' "$OUT" | grep "^##vso\[task.logissue type=warning\]" >/dev/null; } \
  && ok "historia de un solo commit (sin base): aviso y sale 0" || no "sin base: rc=$RC out=[$OUT]"

# ---------------------------------------------------------------- T12. sin commit del bot
nuevo_repo
merge_a dev main "Merged PR 71: primero"
merge_a dev main "Merged PR 72: segundo"
correr
[ "$(etiquetas)" = "PR-72 " ] && ok "sin commit de versión del bot: cae a HEAD~1 (sólo PR-72)…" || no "sin commit del bot: [$(etiquetas)]"
printf '%s\n' "$ERR" | grep "HEAD~1" >/dev/null && ok "…y lo dice" || no "no dijo que cayó a HEAD~1: $ERR"

# ---------------------------------------------------------------- T20. el skill fija el mensaje de merge
SKILLS="${TYCON_SKILLS_DIR:-$HOME/.claude/agent-skills/skills}"
PASO="$SKILLS/tycon-merge-to-main/steps/step-09b-create-pr.md"
if [ ! -f "$PASO" ]; then
  no "NO MEDIDO: no encontré $PASO (TYCON_SKILLS_DIR) — sin el skill no se puede verificar la capa 1"
else
  PISTA="el skill no tiene el update de la story 2.17 con sus cuatro opciones: mergeá agent-skills ANTES que el arnés, o corré esta suite con TYCON_SKILLS_DIR apuntando al clon donde está el cambio"
  # 🔴 `--delete-source-branch` se verifica PRESENTE, no fijo en `false`. El valor sale de `$BORRAR_SOURCE`, que es
  # `false` para dev↔main y `true` para una rama de un solo uso. Anclar el literal dejaría la suite roja
  # ante un cambio legítimo del skill; lo que importa es que la opción VIAJE en el update (el `--squash false` del
  # create no llega, medido con un pull request de prueba), no su valor.
  DSB='--delete-source-branch ("?\$BORRAR_SOURCE"?|false|true)'
  S93=$(awk '/^### 9b\.3/{f=1} /^### 9b\.4/{f=0} f' "$PASO")
  S92=$(awk '/^### 9b\.2/{f=1} /^### 9b\.3/{f=0} f' "$PASO")
  UPD93=$(printf '%s\n' "$S93" | awk '/az repos pr update/{f=1} f{print} f&&!/\\$/{f=0}')
  { printf '%s' "$UPD93" | grep -- "--merge-commit-message" >/dev/null && printf '%s' "$UPD93" | grep -- "--auto-complete true" >/dev/null \
    && printf '%s' "$UPD93" | grep -- "--squash false" >/dev/null && printf '%s' "$UPD93" | grep -E -- "$DSB" >/dev/null; } \
    && ok "skill 9b.3: después de crear, un update fija el mensaje con las cuatro opciones juntas" \
    || no "skill 9b.3 sin el update con --merge-commit-message y las cuatro opciones — $PISTA"
  UPD92=$(printf '%s\n' "$S92" | awk '/az repos pr update/{f=1} f{print} f&&!/\\$/{f=0}')
  { printf '%s' "$UPD92" | grep -- "--title" >/dev/null && printf '%s' "$UPD92" | grep -- "--merge-commit-message" >/dev/null \
    && printf '%s' "$UPD92" | grep -E -- "$DSB" >/dev/null; } \
    && ok "skill 9b.2: el update del PR reusado alinea título, descripción y mensaje" \
    || no "skill 9b.2 sin --title / --merge-commit-message / --delete-source-branch — $PISTA"
  { grep -q "Merged PR" "$PASO" && grep -q 'merge: <source> -> <target>' "$PASO" && grep -qF '[skip ci]' "$PASO" && grep -qF '***NO_CI***' "$PASO"; } \
    && ok "skill: arma «Merged PR <id>: <asunto>» sin el prefijo del Step 2 y sin marcadores de salteo de CI" \
    || no "skill: falta el armado del mensaje (prefijo o marcadores de salteo) — $PISTA"
  { grep -q "sin mensaje de merge" "$PASO" && grep -q "completionOptions" "$PASO"; } \
    && ok "skill: la falla del update no aborta y se verifica antes de reportar" \
    || no "skill: falta la rama de falla o la verificación con completionOptions — $PISTA"
  { grep -q "completionOptions: null" "$PASO" && grep -qi "no viajaba\|no llega\|no llegaba" "$PASO"; } \
    && ok "skill: documenta la prueba (completionOptions: null) y que el --squash false del create no viajaba" \
    || no "skill: no documenta la evidencia (completionOptions: null / --squash false del create) — $PISTA"
fi

# ---------------------------------------------------------------- T22. registro
node -e 'const d=require(process.argv[1]);const t=[...d.diarias,...(d.semanales||[])];process.exit(t.some(x=>x.raiz==="arnes"&&x.ruta==="tests/label-prs.test.sh")?0:1)' "$AQUI/scripts/tests/suites.json" \
  && ok "la suite está registrada en suites.json" || no "la suite no está en suites.json"
# El índice de piezas vive en guides/piezas-del-arnes.md y el README no las
# lista: la pieza tiene que estar nombrada en alguno de los dos (mismo criterio que readme-index.test.js).
grep -q "scripts/ci/label-prs.sh" "$AQUI/guides/piezas-del-arnes.md" "$AQUI/README.md" \
  && ok "la guía de piezas (o el README) nombra el guion" \
  || no "ni guides/piezas-del-arnes.md ni README.md nombran scripts/ci/label-prs.sh"

echo "─────────────"
[ $fallos -eq 0 ] && { echo "✅ label-prs: todo verde"; exit 0; } || { echo "❌ label-prs: $fallos falla(s)"; exit 1; }
