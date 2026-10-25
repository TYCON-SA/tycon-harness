#!/usr/bin/env bash
# githook-pre-push.test.sh — el freno antes de publicar, disparado por un `git push` DE VERDAD.
#
# ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────────────────────────
# La lógica del freno se prueba en public-push-guard.test.js llamando al guion a mano. Eso no prueba el cableado, y el
# cableado es justo donde puede estar el hueco: con `core.hooksPath` global git ignora el
# `.githooks/` de cada repo, así que un `pre-push` escrito, probado y verde puede no correr NUNCA (el mismo defecto que
# githook-livefire.test.sh cuida para el `pre-commit`). Acá se empuja de verdad, con la carpeta global de hooks puesta
# como git la pone, y se mira el EFECTO: la ref remota NO cambia.
#
# Lo que no puede pasar: que el freno no corra desde un clon cualquiera; que el `pre-push` propio de la persona deje de
# correr; que un empuje de un repo que no es del arnés, o hacia un remoto que no es público, cambie en algo; que sin el
# guion o sin `node` un empuje a lo público salga; que una rama apague el freno para su propio empuje.
#
# Todo en repos de laboratorio bajo mktemp. Un repo desnudo local hace de público: su `origin` apunta a una dirección
# de GitHub (el freno sigue la cadena de `origin` de una carpeta local), así que no hace falta ninguna variable. La
# lista es inventada: ningún término sale de una lista de verdad.
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GLOBAL="$RAIZ/scripts/hooks/git-pre-push-global.sh"
REPO_HOOK="$RAIZ/.githooks/pre-push"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
[ -f "$GLOBAL" ]    || { echo "  MAL  — no encontré $GLOBAL"; exit 1; }
[ -f "$REPO_HOOK" ] || { echo "  MAL  — no encontré $REPO_HOOK"; exit 1; }

TERMINO="Zorblax"   # inventado
QUIEN=(-c user.name="Mantenedor De Prueba" -c user.email="4242+mantenedor@users.noreply.github.com" -c commit.gpgsign=false -c tag.gpgsign=false)
PIEZAS="scripts/hooks/public-push-guard.js scripts/hooks/pre-push-repo-rules.js scripts/lib/az-pr.js scripts/lib/gh-pr.js scripts/lib/harness-repo.js scripts/lib/legacy-names.js scripts/lib/guard-record.js scripts/publishing/detector.js scripts/setup/harness/tycon-home.js"

# El git del laboratorio no hereda el de la máquina (ni su carpeta global de hooks, ni su identidad).
g() { GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git "$@"; }

# ── El laboratorio: la MISMA cadena que en la máquina de quien mantiene ──────────────────────────────────────────
#   core.hooksPath global → pre-push global (el despachador) → el freno del arnés INSTALADO
montar() {
  local T="$1" p
  mkdir -p "$T/hooks" "$T/arnes" "$T/casa" "$T/publico"
  cp "$GLOBAL" "$T/hooks/pre-push"; chmod +x "$T/hooks/pre-push"
  for p in $PIEZAS; do mkdir -p "$T/arnes/$(dirname "$p")"; cp "$RAIZ/$p" "$T/arnes/$p"; done
  # el control de historia interna, si el árbol lo trae: el freno lo usa si está
  [ -f "$RAIZ/scripts/publishing/internal-history.js" ] && cp "$RAIZ/scripts/publishing/internal-history.js" "$T/arnes/scripts/publishing/"
  printf '{}\n' > "$T/arnes/perfil-equipo.json"   # una máquina del equipo: la lista es obligatoria
  printf '{ "terminos": [ { "patron": "%s", "categoria": "cliente" } ], "permitidos": [] }\n' "$TERMINO" > "$T/lista.json"
  g init -q --bare -b main "$T/publico/remoto.git"
  g -C "$T/publico/remoto.git" config remote.origin.url "https://github.com/acme/widgets.git"   # lo hace público
  g init -q --bare -b main "$T/local.git"                                                        # sin origin: local
  g init -q -b main "$T/repo"
  mkdir -p "$T/repo/scripts"; printf '#!/bin/sh\n' > "$T/repo/scripts/install-tycon-hooks.sh"; printf 'un repo de juguete\n' > "$T/repo/README.md"
  ( cd "$T/repo" && g add -A && g "${QUIEN[@]}" commit -q -m base && g remote add origin "$T/publico/remoto.git" \
      && g -c core.hooksPath=/dev/null push -q origin main ) || { echo "  MAL  — no pude armar el laboratorio"; exit 1; }
}
# Un commit en una rama nueva: rama, archivo, contenido, mensaje.
rama() {
  local T="$1" nombre="$2" archivo="$3" contenido="$4" mensaje="${5:-un cambio}"
  ( cd "$T/repo" && g checkout -q -B "$nombre" main && mkdir -p "$(dirname "$archivo")" && printf '%s\n' "$contenido" > "$archivo" \
      && g add -A && g "${QUIEN[@]}" commit -q -m "$mensaje" )
}
# Un empuje REAL, con la cadena enchufada como git la enchufa. `EMPUJE_ENV` suma variables; `EMPUJE_HOOKS`, otra carpeta.
empujar() {
  local T="$1"; shift
  ( export HOME="$T/casa" USERPROFILE="$T/casa" TYCON_GUIDES_DIR="${EMPUJE_ARNES-$T/arnes}" TYCON_PUBLISH_DENYLIST="$T/lista.json" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
    [ -n "${EMPUJE_PATH:-}" ] && export PATH="$EMPUJE_PATH"
    cd "${EMPUJE_DESDE:-$T/repo}" && git -c core.hooksPath="${EMPUJE_HOOKS:-$T/hooks}" push "$@" ) > "$T/out.txt" 2>&1
  echo $?
}
en_remoto() { g -C "$1" rev-parse -q --verify "$2" >/dev/null 2>&1; }
sin_termino() { ! grep -qi "$TERMINO" "$1"; }

# ── P-01 · 🔴 EL CASO: un término en una rama, un `git push` de verdad a lo público → NO SALE ─────────────────────
T=$(mktemp -d); montar "$T"
rama "$T" sucia guides/a.md "acá aparece $TERMINO"
RC=$(empujar "$T" origin sucia)
if [ "$RC" != "0" ] && ! en_remoto "$T/publico/remoto.git" refs/heads/sucia && grep -q 'EMPUJE FRENADO' "$T/out.txt" && grep -q 'guides/a.md:1' "$T/out.txt" && sin_termino "$T/out.txt"; then
  ok "P-01 empuje REAL con un término a un remoto público: no sale (exit $RC, la rama no está en el remoto), dice dónde y no dice qué"
else
  mal "P-01 el empuje salió o no dijo lo que debía (exit $RC)"; sed -n '1,12p' "$T/out.txt"
fi
# P-02 · el espejo: la misma cadena deja salir una rama limpia (un freno que frena todo también está roto)
rama "$T" limpia guides/b.md "una guía sin nada raro"
RC=$(empujar "$T" origin limpia)
if [ "$RC" = "0" ] && en_remoto "$T/publico/remoto.git" refs/heads/limpia; then ok "P-02 una rama limpia sale (y el freno dijo qué miró)"
else mal "P-02 una rama limpia NO salió (exit $RC)"; sed -n '1,12p' "$T/out.txt"; fi
grep -q 'freno de publicación' "$T/out.txt" || mal "P-02 el freno no dejó su línea: ¿corrió?"

# P-03 · por la dirección, no por el nombre del remoto; una marca; y `--mirror` (publica todo lo que hay bajo refs/)
RC=$(empujar "$T" "$T/publico/remoto.git" sucia)
if [ "$RC" != "0" ] && ! en_remoto "$T/publico/remoto.git" refs/heads/sucia; then ok "P-03 empujando por la dirección (sin nombre de remoto) tampoco sale"
else mal "P-03 por la dirección salió (exit $RC)"; fi
( cd "$T/repo" && g tag "$(printf '%s' "$TERMINO" | tr '[:upper:]' '[:lower:]')-v1" limpia )
RC=$(empujar "$T" origin --tags)
if [ "$RC" != "0" ] && [ -z "$(g -C "$T/publico/remoto.git" tag -l)" ] && sin_termino "$T/out.txt"; then ok "P-03 una marca con el término en el nombre no sale, y el nombre no se imprime"
else mal "P-03 la marca salió o se imprimió su nombre (exit $RC)"; sed -n '1,8p' "$T/out.txt"; fi
( cd "$T/repo" && g tag -d "$(printf '%s' "$TERMINO" | tr '[:upper:]' '[:lower:]')-v1" >/dev/null && g checkout -q limpia && g branch -q -D sucia )
RC=$(empujar "$T" --mirror origin)
if [ "$RC" != "0" ] && grep -q 'ref-no-publicable' "$T/out.txt"; then ok "P-03 --mirror no sale: publica refs que no son ramas ni marcas (las de seguimiento)"
else mal "P-03 --mirror salió (exit $RC)"; sed -n '1,8p' "$T/out.txt"; fi
# P-04 · borrar una rama remota no publica nada
RC=$(empujar "$T" origin :limpia)
if [ "$RC" = "0" ] && ! en_remoto "$T/publico/remoto.git" refs/heads/limpia; then ok "P-04 borrar una rama remota pasa"
else mal "P-04 no pude borrar una rama remota (exit $RC)"; sed -n '1,8p' "$T/out.txt"; fi
rm -rf "$T"

# ── P-05 · desde CUALQUIER clon: uno recién hecho, sin ninguna configuración propia ───────────────────────────────
T=$(mktemp -d); montar "$T"
g clone -q "$T/publico/remoto.git" "$T/otro-clon" 2>/dev/null
( cd "$T/otro-clon" && g checkout -q -b sucia && mkdir -p guides && printf 'con %s\n' "$TERMINO" > guides/a.md && g add -A && g "${QUIEN[@]}" commit -q -m "un cambio" )
RC=$(EMPUJE_DESDE="$T/otro-clon" empujar "$T" origin sucia)
if [ "$RC" != "0" ] && ! en_remoto "$T/publico/remoto.git" refs/heads/sucia; then ok "P-05 desde un clon recién hecho tampoco sale: el freno no depende de preparar cada clon"
else mal "P-05 desde un clon nuevo salió (exit $RC)"; sed -n '1,8p' "$T/out.txt"; fi
rm -rf "$T"

# ── P-06 · el `pre-push` propio de la persona sigue corriendo: primero, con la misma entrada, y su rechazo manda ──
T=$(mktemp -d); montar "$T"
printf '#!/bin/sh\n{ echo "args: $1 $2"; cat; } > "%s/propio.txt"\nexit 0\n' "$T" > "$T/hooks/pre-push.local"; chmod +x "$T/hooks/pre-push.local"
rama "$T" limpia guides/b.md "limpio"
SHA="$(g -C "$T/repo" rev-parse refs/heads/limpia)"
RC=$(empujar "$T" origin limpia)
if [ "$RC" = "0" ] && grep -q "^args: origin $T/publico/remoto.git$" "$T/propio.txt" && grep -q "^refs/heads/limpia $SHA refs/heads/limpia 0\{40\}$" "$T/propio.txt"; then
  ok "P-06 el pre-push propio (pre-push.local) corre con los mismos argumentos y la misma entrada que le da git"
else mal "P-06 el pre-push propio no corrió igual (exit $RC)"; cat "$T/propio.txt" 2>/dev/null; sed -n '1,6p' "$T/out.txt"; fi
rama "$T" sucia guides/a.md "con $TERMINO"
RC=$(empujar "$T" origin sucia)
if [ "$RC" != "0" ] && ! en_remoto "$T/publico/remoto.git" refs/heads/sucia; then ok "P-06 y después del propio corre el freno: que el propio acepte no deja salir un término"
else mal "P-06 con un pre-push propio que acepta, el término salió (exit $RC)"; fi
printf '#!/bin/sh\ncat >/dev/null\necho "no quiero" >&2\nexit 1\n' > "$T/hooks/pre-push.local"
rama "$T" otra guides/c.md "limpio"
RC=$(empujar "$T" origin otra)
if [ "$RC" != "0" ] && ! en_remoto "$T/publico/remoto.git" refs/heads/otra && grep -q 'pre-push propio' "$T/out.txt"; then ok "P-06 si el propio rechaza, el empuje no sale y se dice quién lo frenó"
else mal "P-06 el rechazo del pre-push propio no mandó (exit $RC)"; sed -n '1,6p' "$T/out.txt"; fi
rm -rf "$T"

# ── P-07 · lo que NO es asunto del freno: misma salida y mismo código que sin hook ───────────────────────────────
T=$(mktemp -d); montar "$T"
# (a) un repo que no es del arnés (un producto), con un término, a un remoto público
g init -q -b main "$T/producto"
( cd "$T/producto" && printf 'con %s\n' "$TERMINO" > a.md && g add -A && g "${QUIEN[@]}" commit -q -m base && g remote add origin "$T/publico/remoto.git" )
RC=$(EMPUJE_DESDE="$T/producto" empujar "$T" origin main:producto); cp "$T/out.txt" "$T/con-hook.txt"
( cd "$T/producto" && g push -q origin :producto >/dev/null 2>&1 )
RC0=$(EMPUJE_DESDE="$T/producto" EMPUJE_HOOKS=/dev/null empujar "$T" origin main:producto)
if [ "$RC" = "0" ] && [ "$RC0" = "0" ] && diff -q <(sed 's/[0-9a-f]\{7,\}/SHA/g' "$T/con-hook.txt") <(sed 's/[0-9a-f]\{7,\}/SHA/g' "$T/out.txt") >/dev/null; then
  ok "P-07 un repo que no es del arnés empuja igual que sin hook: mismo código, misma salida, ni una línea del freno"
else mal "P-07 el freno cambió el empuje de un repo que no es del arnés (exit $RC vs $RC0)"; diff "$T/con-hook.txt" "$T/out.txt" | sed -n '1,8p'; fi
# (b) un árbol del arnés hacia un remoto local (sin origin) y hacia Azure: sin leer la lista (está rota) y sin una línea
rama "$T" sucia guides/a.md "con $TERMINO"
printf '{ roto' > "$T/lista.json"
( cd "$T/repo" && g remote add local "$T/local.git" )
RC=$(empujar "$T" local sucia)
if [ "$RC" = "0" ] && en_remoto "$T/local.git" refs/heads/sucia && ! grep -qi 'freno\|FRENADO' "$T/out.txt"; then ok "P-07 un árbol del arnés hacia un remoto local sale sin que el freno lea la lista ni diga nada"
else mal "P-07 hacia un remoto local el freno se metió (exit $RC)"; sed -n '1,6p' "$T/out.txt"; fi
rm -rf "$T"

# ── P-08 · si el freno no se puede correr, un empuje del arnés NO sale: a lo público por el freno, a cualquier remoto
#    porque las reglas del repo tampoco se pueden correr ───────────────────────────────────────────────────────────
T=$(mktemp -d); montar "$T"
rama "$T" limpia guides/b.md "limpio"
( cd "$T/repo" && g remote add local "$T/local.git" )
mkdir -p "$T/arnes-vacio/scripts"
RC=$(EMPUJE_ARNES="$T/arnes-vacio" empujar "$T" origin limpia)
if [ "$RC" != "0" ] && ! en_remoto "$T/publico/remoto.git" refs/heads/limpia && grep -q 'no pude correr el freno' "$T/out.txt"; then ok "P-08 sin el guion del freno en el arnés instalado, un empuje a lo público no sale y lo dice"
else mal "P-08 sin el guion del freno, salió (exit $RC)"; sed -n '1,6p' "$T/out.txt"; fi
RC=$(EMPUJE_ARNES="$T/arnes-vacio" empujar "$T" local limpia)
if [ "$RC" != "0" ] && ! en_remoto "$T/local.git" refs/heads/limpia && grep -q 'no pude correr las reglas del repo' "$T/out.txt"; then ok "P-08 sin el guion, un empuje del arnés a un remoto local tampoco sale: las reglas del repo no se pudieron correr"
else mal "P-08 sin el guion, un empuje del arnés a un remoto local salió sin las reglas del repo (exit $RC)"; sed -n '1,6p' "$T/out.txt"; fi
# sin `node` en el PATH: una carpeta con sólo lo que el despachador y git necesitan
mkdir -p "$T/bin"
for herramienta in git bash sh cat dirname basename mktemp rm grep sed tr env uname printf; do
  ruta="$(command -v "$herramienta" 2>/dev/null)"; [ -n "$ruta" ] && [ -x "$ruta" ] && ln -sf "$ruta" "$T/bin/$herramienta"
done
if PATH="$T/bin" command -v node >/dev/null 2>&1; then
  mal "P-08 no pude armar un PATH sin node: el caso no mide"
else
  RC=$(EMPUJE_PATH="$T/bin" empujar "$T" origin limpia)
  if [ "$RC" != "0" ] && ! en_remoto "$T/publico/remoto.git" refs/heads/limpia && grep -q 'no pude correr el freno' "$T/out.txt" && grep -q 'node' "$T/out.txt"; then ok "P-08 sin node, un empuje a lo público no sale y dice que falta node"
  else mal "P-08 sin node, salió (exit $RC)"; sed -n '1,6p' "$T/out.txt"; fi
fi
rm -rf "$T"

# ── P-09 · una rama no apaga el freno para su propio empuje: corre el del arnés INSTALADO, no el del árbol ────────
T=$(mktemp -d); montar "$T"
( cd "$T/repo" && g checkout -q -B saboteada main && mkdir -p scripts/hooks guides && printf 'process.exit(0);\n' > scripts/hooks/public-push-guard.js \
    && printf 'con %s\n' "$TERMINO" > guides/a.md && g add -A && g "${QUIEN[@]}" commit -q -m "un cambio" )
RC=$(empujar "$T" origin saboteada)
if [ "$RC" != "0" ] && ! en_remoto "$T/publico/remoto.git" refs/heads/saboteada; then ok "P-09 una rama que trae su propio freno (que sale siempre 0) no cambia el veredicto"
else mal "P-09 la rama se juzgó con su propio freno y salió (exit $RC)"; fi
rm -rf "$T"

# ── P-10 · un clon con carpeta de hooks propia (`core.hooksPath` = .githooks): el del repo llama al mismo freno ───
T=$(mktemp -d); montar "$T"
mkdir -p "$T/repo/.githooks"; cp "$REPO_HOOK" "$T/repo/.githooks/pre-push"; chmod +x "$T/repo/.githooks/pre-push"
mkdir -p "$T/arnes/scripts/hooks"; cp "$GLOBAL" "$T/arnes/scripts/hooks/git-pre-push-global.sh"
( cd "$T/repo" && g add -A && g "${QUIEN[@]}" commit -q -m "el hook del repo" && g -c core.hooksPath=/dev/null push -q origin main )
rama "$T" sucia guides/a.md "con $TERMINO"
RC=$(EMPUJE_HOOKS="$T/repo/.githooks" empujar "$T" origin sucia)
if [ "$RC" != "0" ] && ! en_remoto "$T/publico/remoto.git" refs/heads/sucia && grep -q 'EMPUJE FRENADO' "$T/out.txt"; then ok "P-10 con la carpeta de hooks del repo (.githooks/pre-push) el término tampoco sale"
else mal "P-10 con .githooks/pre-push el término salió (exit $RC)"; sed -n '1,8p' "$T/out.txt"; fi
rama "$T" limpia guides/b.md "limpio"
RC=$(EMPUJE_HOOKS="$T/repo/.githooks" empujar "$T" origin limpia)
if [ "$RC" = "0" ] && en_remoto "$T/publico/remoto.git" refs/heads/limpia; then ok "P-10 y una rama limpia sale"
else mal "P-10 con .githooks/pre-push una rama limpia no salió (exit $RC)"; sed -n '1,8p' "$T/out.txt"; fi
# sin arnés instalado (alguien de afuera con su copia): corre el freno del propio árbol, que es lo único que hay
mkdir -p "$T/repo/scripts/hooks" "$T/repo/scripts/lib" "$T/repo/scripts/publishing" "$T/repo/scripts/setup/harness"
for p in $PIEZAS; do cp "$RAIZ/$p" "$T/repo/$p"; done
cp "$GLOBAL" "$T/repo/scripts/hooks/git-pre-push-global.sh"
( cd "$T/repo" && g checkout -q main && g add -A && g "${QUIEN[@]}" commit -q -m "el freno en el árbol" && g -c core.hooksPath=/dev/null push -q origin main )
TOKEN="gh""p_$(printf 'a1B2%.0s' 1 2 3 4 5 6 7 8 9)"
rama "$T" con-token scripts/x.js "const t = '$TOKEN';"
RC=$(EMPUJE_ARNES="$T/arnes-vacio" EMPUJE_HOOKS="$T/repo/.githooks" empujar "$T" origin con-token)
if [ "$RC" != "0" ] && ! en_remoto "$T/publico/remoto.git" refs/heads/con-token && grep -q 'secreto' "$T/out.txt"; then ok "P-10 sin arnés instalado, el hook del repo usa el freno del propio árbol (frena un token)"
else mal "P-10 sin arnés instalado el token salió (exit $RC)"; sed -n '1,8p' "$T/out.txt"; fi
rm -rf "$T"

# ── P-11 · «del arnés» no es sólo «el árbol de trabajo trae el instalador» ───────────────────────────────────────
# Decidir mirando UN archivo del árbol de trabajo falla: parado en una rama que no lo trae, o en un repo sin
# árbol, una rama del arnés saldría sin que el freno corriera. Por eso decide el freno, por lo que SE EMPUJA.
T=$(mktemp -d); montar "$T"
rama "$T" sucia guides/a.md "con $TERMINO"
( cd "$T/repo" && g checkout -q --orphan otra-cosa && g rm -rfq . && printf 'nada del arnés\n' > nota.md && g add -A && g "${QUIEN[@]}" commit -q -m "otra cosa" )
RC=$(empujar "$T" origin sucia)
if [ "$RC" != "0" ] && ! en_remoto "$T/publico/remoto.git" refs/heads/sucia && grep -q 'EMPUJE FRENADO' "$T/out.txt"; then ok "P-11 una rama del arnés empujada parado en OTRA rama (sin el instalador en el árbol) tampoco sale"
else mal "P-11 parado en una rama sin el instalador, la rama del arnés salió (exit $RC)"; sed -n '1,6p' "$T/out.txt"; fi
g clone -q --bare "$T/repo" "$T/desnudo.git" 2>/dev/null
g -C "$T/desnudo.git" remote set-url origin "$T/publico/remoto.git"
RC=$(EMPUJE_DESDE="$T/desnudo.git" empujar "$T" origin sucia)
if [ "$RC" != "0" ] && ! en_remoto "$T/publico/remoto.git" refs/heads/sucia; then ok "P-11 desde un repo desnudo (sin árbol de trabajo) tampoco sale"
else mal "P-11 desde un repo desnudo la rama del arnés salió (exit $RC)"; sed -n '1,6p' "$T/out.txt"; fi
# el espejo: la rama que NO es del arnés sale desde ese mismo árbol, sin una línea del freno
RC=$(empujar "$T" origin otra-cosa)
if [ "$RC" = "0" ] && en_remoto "$T/publico/remoto.git" refs/heads/otra-cosa && ! grep -qi 'FRENADO' "$T/out.txt"; then ok "P-11 y una rama que no trae nada del arnés sale"
else mal "P-11 una rama ajena al arnés no salió (exit $RC)"; sed -n '1,6p' "$T/out.txt"; fi
# sin el guion del freno, la misma pregunta la contesta el despachador: la rama del arnés no sale, la ajena sí
mkdir -p "$T/arnes-vacio/scripts"
( cd "$T/repo" && g push -q origin :otra-cosa >/dev/null 2>&1 )
RC=$(EMPUJE_ARNES="$T/arnes-vacio" empujar "$T" origin sucia)
if [ "$RC" != "0" ] && ! en_remoto "$T/publico/remoto.git" refs/heads/sucia && grep -q 'no pude correr el freno' "$T/out.txt"; then ok "P-11 sin el guion del freno, la rama del arnés empujada desde otra rama no sale"
else mal "P-11 sin el guion, la rama del arnés salió desde otra rama (exit $RC)"; sed -n '1,6p' "$T/out.txt"; fi
RC=$(EMPUJE_ARNES="$T/arnes-vacio" empujar "$T" origin otra-cosa)
if [ "$RC" = "0" ] && en_remoto "$T/publico/remoto.git" refs/heads/otra-cosa; then ok "P-11 sin el guion, lo que no es del arnés sale (un producto no depende del freno)"
else mal "P-11 sin el guion, una rama ajena al arnés no salió (exit $RC)"; sed -n '1,6p' "$T/out.txt"; fi
rm -rf "$T"

# ── P-12 · el pre-push propio que no se puede ejecutar se DICE; y el freno del árbol no se presta por una variable ─
T=$(mktemp -d); montar "$T"
printf '#!/bin/sh\ncat >/dev/null\nexit 1\n' > "$T/hooks/pre-push.local"; chmod -x "$T/hooks/pre-push.local"
rama "$T" limpia guides/b.md "limpio"
RC=$(empujar "$T" origin limpia)
if [ "$RC" = "0" ] && grep -q 'pre-push propio .* no se puede ejecutar' "$T/out.txt"; then ok "P-12 un pre-push.local sin permiso de ejecución no corre, y se dice (no queda callado)"
else mal "P-12 un pre-push.local sin permiso de ejecución quedó callado (exit $RC)"; sed -n '1,6p' "$T/out.txt"; fi
rm -f "$T/hooks/pre-push.local"
# un freno falso (sale siempre 0) ofrecido por una variable de entorno: sin arnés instalado, no se usa
mkdir -p "$T/falso/scripts/hooks" "$T/arnes-vacio/scripts"; printf 'process.exit(0);\n' > "$T/falso/scripts/hooks/public-push-guard.js"
rama "$T" sucia guides/a.md "con $TERMINO"
RC=$(TYCON_PRE_PUSH_TREE="$T/falso" EMPUJE_ARNES="$T/arnes-vacio" empujar "$T" origin sucia)
if [ "$RC" != "0" ] && ! en_remoto "$T/publico/remoto.git" refs/heads/sucia && grep -q 'no pude correr el freno' "$T/out.txt"; then ok "P-12 ninguna variable le presta un freno al despachador: sin arnés instalado, no sale"
else mal "P-12 una variable le prestó un freno falso al despachador y el término salió (exit $RC)"; sed -n '1,6p' "$T/out.txt"; fi
rm -rf "$T"

# ── P-13 · el despachador llamado a mano, donde git no llega: entrada ilegible, y el respaldo cuando no hay freno ──
# git siempre le pasa un remoto, una dirección y las líneas de las refs. Estos casos lo llaman como git, pero con lo
# que git no produce: sirven para que «no pude leer» no termine en verde por ninguna rama del guion.
T=$(mktemp -d); montar "$T"
rama "$T" limpia guides/b.md "limpio"
SHA="$(g -C "$T/repo" rev-parse refs/heads/limpia)"
PUB="$T/publico/remoto.git"
llamar() { # <arnés> <carpeta> [args…] — la entrada la da quien llama; deja la salida en out.txt y dice el código
  local arnes="$1" dir="$2"; shift 2
  ( export HOME="$T/casa" USERPROFILE="$T/casa" TYCON_GUIDES_DIR="$arnes" TYCON_PUBLISH_DENYLIST="$T/lista.json" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
    [ -n "${LLAMAR_PATH:-}" ] && export PATH="$LLAMAR_PATH"
    cd "$dir" && bash "$T/hooks/pre-push" "$@" ) > "$T/out.txt" 2>&1
  echo $?
}
LINEA="refs/heads/limpia $SHA refs/heads/limpia $(printf '%040d' 0)"
# (a) el despachador no puede LEER su entrada: su `cat` falla (acá, uno de mentira delante en el PATH que sale 1;
# cerrarle la entrada no sirve para probarlo: el guion se queda esperando). Con el freno: «no pude mirar» (2).
mkdir -p "$T/sin-cat"; printf '#!/bin/sh\nexit 1\n' > "$T/sin-cat/cat"; chmod +x "$T/sin-cat/cat"
RC=$(printf '%s\n' "$LINEA" | LLAMAR_PATH="$T/sin-cat:$PATH" llamar "$T/arnes" "$T/repo" origin "$PUB")
if [ "$RC" = "2" ] && grep -q 'no pude leer lo que git le pasó' "$T/out.txt"; then ok "P-13 con la entrada ilegible el despachador se lo DICE al freno, que no lo toma por «nada que empujar»"
else mal "P-13 con la entrada ilegible el empuje salió verde (exit $RC)"; sed -n '1,4p' "$T/out.txt"; fi
RC=$(printf '%s\n' "$LINEA" | llamar "$T/arnes" "$T/repo" origin "$PUB")
if [ "$RC" = "0" ]; then ok "P-13 y el gemelo: la misma llamada con su entrada pasa"
else mal "P-13 la llamada sana no pasó (exit $RC)"; sed -n '1,4p' "$T/out.txt"; fi
mkdir -p "$T/arnes-vacio/scripts"
g init -q -b main "$T/producto-ilegible"
( cd "$T/producto-ilegible" && printf 'x\n' > a.md && g add -A && g "${QUIEN[@]}" commit -q -m base )
RC=$(printf '%s\n' "$LINEA" | LLAMAR_PATH="$T/sin-cat:$PATH" llamar "$T/arnes-vacio" "$T/producto-ilegible" origin "$PUB")
if [ "$RC" != "0" ] && grep -q 'no pude correr el freno' "$T/out.txt"; then ok "P-13 sin el freno y con la entrada ilegible, hacia lo público no sale ni desde un repo que no es del arnés (no se sabe qué se empuja)"
else mal "P-13 sin el freno y con la entrada ilegible salió (exit $RC)"; fi
# (b) sin el freno, sin remoto ni dirección: una dirección vacía no es «una carpeta local»
RC=$(printf '%s\n' "$LINEA" | llamar "$T/arnes-vacio" "$T/repo")
if [ "$RC" != "0" ]; then ok "P-13 sin el freno y sin dirección no sale (vacía no es «local»)"
else mal "P-13 sin el freno y sin dirección salió"; fi
# (c) sin el freno, en un repo que NO es del arnés: borrar una ref remota pasa; una línea que no se sabe leer, no
g init -q -b main "$T/producto"
( cd "$T/producto" && printf 'x\n' > a.md && g add -A && g "${QUIEN[@]}" commit -q -m base )
PSHA="$(g -C "$T/producto" rev-parse HEAD)"
RC=$(printf '(delete) %040d refs/heads/vieja %s\n' 0 "$PSHA" | llamar "$T/arnes-vacio" "$T/producto" origin "$PUB")
if [ "$RC" = "0" ]; then ok "P-13 sin el freno, borrar una ref remota desde un repo que no es del arnés pasa"
else mal "P-13 sin el freno, borrar una ref remota no pasó (exit $RC)"; fi
RC=$(printf 'refs/heads/main %s refs/heads/main %040d\n' "$PSHA" 0 | llamar "$T/arnes-vacio" "$T/producto" origin "$PUB")
if [ "$RC" = "0" ]; then ok "P-13 sin el freno, un repo que no es del arnés empuja"
else mal "P-13 sin el freno, un producto no empujó (exit $RC)"; fi
RC=$(printf 'esto no es una línea de git\n' | llamar "$T/arnes-vacio" "$T/producto" origin "$PUB")
if [ "$RC" != "0" ]; then ok "P-13 sin el freno, una línea que no se sabe leer no es «no es del arnés»"
else mal "P-13 sin el freno, una línea ilegible salió verde"; fi
RC=$(printf 'refs/heads/x %s refs/heads/x %040d\n' "$(printf 'e%.0s' $(seq 1 40))" 0 | llamar "$T/arnes-vacio" "$T/producto" origin "$PUB")
if [ "$RC" != "0" ]; then ok "P-13 sin el freno, una punta que git no puede leer tampoco"
else mal "P-13 sin el freno, una punta ilegible salió verde"; fi
rm -rf "$T"

echo "─────────────"
if [ "$FALLOS" -eq 0 ]; then echo "✅ githook-pre-push: todo verde"; exit 0; fi
echo "❌ githook-pre-push: $FALLOS caso(s) en rojo"; exit 1
