#!/usr/bin/env bash
# harness-eol.test.sh — los finales de línea de un clon viejo se corrigen ANTES de aplicar (T98).
#
# Por qué existe: un clon de Windows anterior a `.gitattributes` conserva `\r\n` en todo lo que el `pull` no toca (cada
# máquina del equipo). Un hook `.sh` con `\r\n` no corre: un freno así sale distinto de 2 y no frena, sin decir nada.
# `git checkout -- .` y `git reset --hard` solos no lo arreglan; la receta es `git rm --cached -r -q .` y
# `git reset --hard -q`, con el árbol limpio (`.gitattributes`, líneas 7-8).
#
# Lo que no se puede perder (T98 · Eol_NormalizeBeforeApplier_CleanTreeOnly_WindowsOnly):
#   · En Windows y en modo instalado, justo antes de lanzar el aplicador —`install`, `apply`, `startup` (también con el clon
#     ya al día) y `update`—: si hay texto con `\r\n` en disco y el árbol está limpio, lo normaliza y lo dice en una línea.
#   · Con el árbol sucio no toca nada y avisa qué correr. Si el paso falla, lo dice y el aplicador corre igual.
#   · En modo `developer` no se toca el git del dev. En Mac y Linux el paso no corre.
#
# La plataforma se simula con `TYCON_HARNESS_EOL_PLATFORM=win32` (no hay Windows acá): vale sólo para este paso; el
# aplicador que corre sigue siendo el de bash. El «clon viejo» se arma como queda uno de verdad: el archivo se saca del
# repo con `\r\n` (una regla local de atributos, que después se borra) y git lo sigue dando por no modificado.
#
# 🔴 Rojo sin el paso: el aplicador con `\r\n` no corre y `apply`,
#    `startup`, `update` e `install` fallan o dejan el clon como estaba; nada dice «finales de línea».
#
# Laboratorio: scripts/tests/lib/harness-lab.sh. Nunca ~/.claude ni el checkout real. 🔴 Sin pipes sobre el comando medido.
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
BASE="$(mktemp -d "${TMPDIR:-/tmp}/harness-eol.XXXXXX")"
node "$RAIZ/scripts/tests/lib/lab-guard.js" "$BASE" harness-eol || exit 1
trap 'chmod -R u+rwx "$BASE" 2>/dev/null; rm -rf "$BASE"' EXIT   # el chmod: un caso deja una carpeta sin permiso de escritura
REGISTRO() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness/startup.log"; }
APPLIER="scripts/install-tycon-hooks.sh"
HOOK="scripts/hooks/lab-eol.sh"

# un laboratorio cuyo arnés trae `.gitattributes` (los finales de línea los decide el repo) y un hook `.sh`
lab() { # lab <nombre>
  harness_lab_create "$BASE/$1" >/dev/null
  harness_lab_publish tree "los finales de línea los decide el repo" .gitattributes '* text=auto eol=lf'
  harness_lab_publish tree "un hook .sh de juguete" "$HOOK" $'#!/usr/bin/env bash\nexit 0'
  harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1
}
# deja ESOS archivos del clon con \r\n en disco y el árbol LIMPIO, como los tiene un clon anterior a `.gitattributes`
old_clone() { # old_clone <ruta relativa>…
  local f
  mkdir -p "$LAB_TREE/.git/info"; : > "$LAB_TREE/.git/info/attributes"
  for f in "$@"; do printf '%s text eol=crlf\n' "${f// /[[:space:]]}" >> "$LAB_TREE/.git/info/attributes"; rm -f "$LAB_TREE/$f"; done   # un espacio en el patrón separa atributos
  harness_lab_git "$LAB_TREE" checkout -q -- "$@"
  rm -f "$LAB_TREE/.git/info/attributes"
}
crlf_count() { local n; n="$(harness_lab_git "$LAB_TREE" ls-files --eol | grep -c 'w/crlf')"; echo "${n:-0}"; }
dirty() { harness_lab_git "$LAB_TREE" status --porcelain --untracked-files=no; }
has_cr() { LC_ALL=C grep -q $'\r' "$1"; }
said() { case "$1" in *"finales de línea"*) return 0 ;; *) return 1 ;; esac; }
# en el registro, la última línea del paso quedó ANTES que la última del aplicador
step_before_applier() {
  local a b
  a="$(grep -n 'finales de línea: normalic' "$(REGISTRO)" | tail -1 | cut -d: -f1)"
  b="$(grep -n 'aplicador .* → ok' "$(REGISTRO)" | tail -1 | cut -d: -f1)"
  [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]
}

# ═══ apply ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
echo "· apply"
lab t98-apply
harness install --yes >/dev/null 2>&1 || mal "T98 install previo falló"
old_clone "$APPLIER" "$HOOK"
[ "$(crlf_count)" = 2 ] && [ -z "$(dirty)" ] && has_cr "$LAB_TREE/$HOOK" && ok "T98 el laboratorio es un clon viejo: 2 archivos de texto con \\r\\n en disco y el árbol limpio" || mal "T98 el laboratorio no quedó como un clon viejo: con \\r\\n $(crlf_count), sucio «$(dirty)»"

# el espejo primero (lo que NO pasa): en Linux el paso no corre — el clon queda como estaba y nada lo nombra
SALIDA="$(harness apply 2>&1)"; RC=$?
[ "$(crlf_count)" = 2 ] && ! said "$SALIDA" && ok "T98 linux: el paso no corre (el clon queda como estaba, sin una línea)" || mal "T98 linux: con \\r\\n $(crlf_count) · $SALIDA"
[ "$RC" != 0 ] && ok "T98 …y por eso importa: el aplicador con \\r\\n no corre (apply sale $RC)" || mal "T98 el aplicador con \\r\\n corrió igual (rc 0): el caso no mide lo que dice"

# Windows, árbol limpio: normaliza, lo dice en UNA línea, y el aplicador corre después, ya con \n
SALIDA="$(TYCON_HARNESS_EOL_PLATFORM=win32 harness apply 2>&1)"; RC=$?
[ "$(crlf_count)" = 0 ] && ! has_cr "$LAB_TREE/$HOOK" && ! has_cr "$LAB_TREE/$APPLIER" && ok "T98 Windows, árbol limpio: normalizado (ningún texto con \\r\\n en disco)" || mal "T98 Windows limpio: quedan $(crlf_count) con \\r\\n · $SALIDA"
case "$SALIDA" in *"finales de línea"*"2 archivo"*) ok "T98 …y lo dice, con la cuenta" ;; *) mal "T98 no dice que normalizó 2 archivos: $SALIDA" ;; esac
[ "$(printf '%s\n' "$SALIDA" | grep -c 'finales de línea')" = 1 ] && ok "T98 …en una sola línea" || mal "T98 más de una línea (o ninguna): $SALIDA"
[ "$RC" = 0 ] && ok "T98 …y el aplicador corrió después, ya con \\n (apply sale 0)" || mal "T98 apply rc $RC: $SALIDA"
step_before_applier && ok "T98 apply: en el registro, el paso queda antes que el aplicador" || mal "T98 apply: el orden en el registro: $(grep -n 'finales de línea\|aplicador' "$(REGISTRO)" | tail -4)"
[ -z "$(dirty)" ] && ok "T98 …y el árbol sigue limpio" || mal "T98 el paso dejó el árbol sucio: $(dirty)"
# ya normalizado: la corrida siguiente no tiene nada que hacer ni que decir
SALIDA="$(TYCON_HARNESS_EOL_PLATFORM=win32 harness apply 2>&1)"; RC=$?
[ "$RC" = 0 ] && ! said "$SALIDA" && ok "T98 sin \\r\\n en disco no dice nada" || mal "T98 con el clon ya normalizado: rc $RC · $SALIDA"

# ═══ árbol sucio: no toca nada y avisa qué correr ════════════════════════════════════════════════════════════════════
echo "· árbol sucio"
old_clone "$HOOK"
printf 'cambio local sin commitear\n' >> "$LAB_TREE/README.md"
SALIDA="$(TYCON_HARNESS_EOL_PLATFORM=win32 harness apply 2>&1)"; RC=$?
[ "$(crlf_count)" = 1 ] && has_cr "$LAB_TREE/$HOOK" && ok "T98 árbol sucio: el \\r\\n queda como estaba" || mal "T98 árbol sucio: tocó el clon (con \\r\\n: $(crlf_count))"
grep -q 'cambio local sin commitear' "$LAB_TREE/README.md" && ok "T98 árbol sucio: lo que estaba sin commitear sigue ahí" || mal "T98 árbol sucio: se perdió el cambio local"
case "$SALIDA" in *"finales de línea"*"rm --cached -r -q ."*"reset --hard -q"*) ok "T98 árbol sucio: avisa, con lo que hay que correr" ;; *) mal "T98 árbol sucio: no avisa qué correr: $SALIDA" ;; esac
[ "$RC" = 0 ] && ok "T98 árbol sucio: el aplicador corre igual (apply sale 0)" || mal "T98 árbol sucio: apply rc $RC: $SALIDA"
# espejo: el mismo clon, otra vez limpio → normaliza
harness_lab_git "$LAB_TREE" checkout -q -- README.md
SALIDA="$(TYCON_HARNESS_EOL_PLATFORM=win32 harness apply 2>&1)"
[ "$(crlf_count)" = 0 ] && ok "T98 espejo: limpio otra vez, normaliza" || mal "T98 espejo del árbol sucio: quedan $(crlf_count) · $SALIDA"

# ═══ modo developer: no se toca el git del dev ═══════════════════════════════════════════════════════════════════════
echo "· developer"
old_clone "$HOOK"
harness link --local "$LAB_TREE" --allow-temporary >/dev/null 2>&1 || mal "T98 link --local falló"
SALIDA="$(TYCON_HARNESS_EOL_PLATFORM=win32 harness apply 2>&1)"; RC=$?
[ "$RC" = 0 ] && [ "$(crlf_count)" = 1 ] && ! said "$SALIDA" && ok "T98 developer: el paso no corre (el clon del dev queda como estaba)" || mal "T98 developer: rc $RC, con \\r\\n $(crlf_count) · $SALIDA"
harness link --managed >/dev/null 2>&1 || mal "T98 link --managed falló"
SALIDA="$(TYCON_HARNESS_EOL_PLATFORM=win32 harness apply 2>&1)"
[ "$(crlf_count)" = 0 ] && ok "T98 espejo: de vuelta en modo instalado, normaliza" || mal "T98 espejo de developer: quedan $(crlf_count) · $SALIDA"

# ═══ el paso falla: lo dice y sigue ══════════════════════════════════════════════════════════════════════════════════
echo "· el paso falla"
old_clone "$HOOK"
: > "$LAB_TREE/.git/index.lock"   # git no puede escribir el índice: `rm --cached` falla
SALIDA="$(TYCON_HARNESS_EOL_PLATFORM=win32 harness apply 2>&1)"; RC=$?
rm -f "$LAB_TREE/.git/index.lock"
said "$SALIDA" && case "$SALIDA" in *"no pude"*) true ;; *) false ;; esac && ok "T98 si el paso falla, lo dice" || mal "T98 el paso falló callado: $SALIDA"
[ "$RC" = 0 ] && ok "T98 …y no frena: el aplicador corre igual (apply sale 0)" || mal "T98 el paso que falla frenó apply: rc $RC: $SALIDA"
[ "$(crlf_count)" = 1 ] && [ -z "$(dirty)" ] && ok "T98 …y no deja el clon a medias" || mal "T98 el paso que falla dejó el clon a medias: con \\r\\n $(crlf_count), sucio «$(dirty)»"

# ═══ la corrección queda a medias: `reset --hard` no puede reescribir un archivo ═════════════════════════════════════
# Eol_ResetHardFailsMidway_SaysHowToCheck. Con un archivo que no se deja
# reemplazar (en Windows, abierto por otro programa; acá, su carpeta sin permiso de escritura: «unable to unlink»), el
# índice se recupera bien pero `git status` y `git diff` quedan LIMPIOS aunque ese archivo siga con \r\n: quien compruebe
# con `git status` no ve nada y descarta el aviso. El aviso dice cuántos siguen, cuáles, y cómo comprobarlo.
echo "· la corrección queda a medias"
if [ "$(id -u)" = 0 ]; then
  echo "  ⏭   — omitido: como root los permisos no frenan a git (no hay cómo dejar la corrección a medias)"
else
  old_clone "$HOOK" README.md
  [ "$(crlf_count)" = 2 ] || mal "la corrección a medias: el laboratorio no quedó con 2 archivos con \\r\\n ($(crlf_count))"
  chmod 555 "$LAB_TREE/scripts/hooks"
  SALIDA="$(TYCON_HARNESS_EOL_PLATFORM=win32 harness apply 2>&1)"; RC=$?
  chmod 755 "$LAB_TREE/scripts/hooks"
  [ "$(crlf_count)" = 1 ] && has_cr "$LAB_TREE/$HOOK" && [ -z "$(dirty)" ] && ok "a medias: el laboratorio reproduce la trampa (un archivo sigue con \\r\\n y git status sale limpio)" || mal "a medias: el laboratorio no reproduce la trampa: con \\r\\n $(crlf_count), sucio «$(dirty)» · $SALIDA"
  case "$SALIDA" in *"finales de línea"*"no pude"*"siguen con"*"1 (scripts/hooks/lab-eol.sh)"*) ok "a medias: lo dice, con cuántos siguen con \\r\\n (los de DESPUÉS del intento) y cuáles" ;; *) mal "a medias: no dice cuántos siguen ni cuáles: $SALIDA" ;; esac
  case "$SALIDA" in *"ls-files --eol"*"w/crlf"*) ok "a medias: dice cómo comprobarlo (git ls-files --eol, los w/crlf)" ;; *) mal "a medias: no dice cómo comprobarlo: $SALIDA" ;; esac
  case "$SALIDA" in *"git status"*) ok "a medias: avisa que git status no lo muestra" ;; *) mal "a medias: no avisa que git status sale limpio: $SALIDA" ;; esac
  case "$SALIDA" in *"rm --cached -r -q ."*"reset --hard -q"*) ok "a medias: y trae el remedio" ;; *) mal "a medias: sin el remedio: $SALIDA" ;; esac
  [ "$(printf '%s\n' "$SALIDA" | grep -c 'finales de línea')" = 1 ] && [ "$RC" = 0 ] && ok "a medias: en una sola línea, y el aplicador corre igual (apply sale 0)" || mal "a medias: rc $RC, $(printf '%s\n' "$SALIDA" | grep -c 'finales de línea') línea(s): $SALIDA"
  # espejo: el mismo clon, con el archivo ya libre → normaliza, y no habla de comprobar nada
  SALIDA="$(TYCON_HARNESS_EOL_PLATFORM=win32 harness apply 2>&1)"
  [ "$(crlf_count)" = 0 ] && case "$SALIDA" in *"normalic"*) true ;; *) false ;; esac && case "$SALIDA" in *"ls-files --eol"*) false ;; *) true ;; esac && ok "a medias, el espejo: con el archivo ya libre, normaliza y lo dice (sin pedir comprobar nada)" || mal "a medias, el espejo: quedan $(crlf_count) · $SALIDA"
fi

# ═══ dos ramas de error de normalizeEol que no tenían caso ═══════════════════════════════════════════════════════════
# Un `git` de laboratorio delante del PATH: UN comando falla o queda a medias (según LAB_GIT_MODE) y todo lo demás va
# al git de verdad. harness.js lo llama como `git -c core.hooksPath=/dev/null -C <dir> <comando…>`.
FAKE_BIN="$BASE/fake-bin"; mkdir -p "$FAKE_BIN"
# (la receta reescribe desde el índice con `checkout-index -f`: «checkout-leaves-crlf» sale 0 sin escribir nada, y
# «checkout-killed» sale 137 como un git terminado a la fuerza; los dos consumen la lista que les llega por stdin)
printf '%s\n' '#!/bin/sh' \
  'case "${LAB_GIT_MODE:-}|${5:-} ${6:-}" in' \
  '  "eol-unreadable|ls-files --eol") echo "fatal: laboratorio: no pude leer el indice" >&2; exit 128 ;;' \
  '  "checkout-leaves-crlf|checkout-index -f") cat > /dev/null; exit 0 ;;' \
  '  "checkout-killed|checkout-index -f") cat > /dev/null; echo "laboratorio: git terminado a la fuerza" >&2; exit 137 ;;' \
  'esac' \
  'exec "$LAB_REAL_GIT" "$@"' > "$FAKE_BIN/git"
chmod +x "$FAKE_BIN/git"
export LAB_REAL_GIT; LAB_REAL_GIT="$(command -v git)"
lab_git_apply() { LAB_GIT_MODE="$1" PATH="$FAKE_BIN:$PATH" TYCON_HARNESS_EOL_PLATFORM=win32 harness apply 2>&1; }   # <modo|''>: apply en «Windows» con el git de laboratorio

# Eol_LsFilesEolFails_NothingTouched_Said — si `git ls-files --eol` mismo falla no se pudo MIRAR: no toca nada y lo dice;
# nunca calla como si no hubiera nada que normalizar
echo "· git no puede mirar los finales de línea"
old_clone "$HOOK"
SALIDA="$(lab_git_apply eol-unreadable)"; RC=$?
said "$SALIDA" && case "$SALIDA" in *"no pude mirar"*"ls-files --eol"*) true ;; *) false ;; esac && ok "sin poder mirar: lo dice (no pudo mirar, con el comando que falló)" || mal "sin poder mirar: calló, o no dice que no pudo mirar: $SALIDA"
case "$SALIDA" in *"normalic"*) mal "sin poder mirar: dice que normalizó: $SALIDA" ;; *) ok "sin poder mirar: no dice que normalizó" ;; esac
[ "$(crlf_count)" = 1 ] && has_cr "$LAB_TREE/$HOOK" && [ -z "$(dirty)" ] && ok "sin poder mirar: no tocó nada (el \\r\\n sigue y el árbol está limpio)" || mal "sin poder mirar: tocó el clon: con \\r\\n $(crlf_count), sucio «$(dirty)»"
[ "$RC" = 0 ] && ok "sin poder mirar: el aplicador corre igual (apply sale 0)" || mal "sin poder mirar: apply rc $RC: $SALIDA"
# espejo: el mismo clon y el mismo git de laboratorio, sin la falla → mira, normaliza y lo dice
SALIDA="$(lab_git_apply '')"; RC=$?
[ "$RC" = 0 ] && [ "$(crlf_count)" = 0 ] && case "$SALIDA" in *"normalic"*) true ;; *) false ;; esac && ok "sin poder mirar, el espejo: cuando git contesta, normaliza y lo dice" || mal "sin poder mirar, el espejo: rc $RC, quedan $(crlf_count) · $SALIDA"

# Eol_StillCrlfAfterNormalize_NamedNotNormalized — la receta corrió sin error y aun así queda algún archivo con \r\n: no
# dice «normalicé»; dice cuántos quedaron, los nombra, y cómo comprobarlo
echo "· después de normalizar todavía queda alguno"
old_clone "$HOOK" README.md
SALIDA="$(lab_git_apply checkout-leaves-crlf)"; RC=$?
[ "$(crlf_count)" = 2 ] && [ -z "$(dirty)" ] || mal "queda alguno: el laboratorio no dejó los 2 archivos con \\r\\n y el árbol limpio (con \\r\\n $(crlf_count), sucio «$(dirty)»)"
case "$SALIDA" in *"finales de línea"*"quedaron 2"*"README.md"*"scripts/hooks/lab-eol.sh"*) ok "queda alguno: lo dice, con cuántos quedaron y sus nombres" ;; *) mal "queda alguno: no dice cuántos quedaron ni cuáles: $SALIDA" ;; esac
case "$SALIDA" in *"normalicé"*) mal "queda alguno: dice que normalizó: $SALIDA" ;; *) ok "queda alguno: no dice «normalicé»" ;; esac
case "$SALIDA" in *"ls-files --eol"*"w/crlf"*) ok "queda alguno: dice cómo comprobarlo" ;; *) mal "queda alguno: no dice cómo comprobarlo: $SALIDA" ;; esac
[ "$RC" = 0 ] && [ "$(printf '%s\n' "$SALIDA" | grep -c 'finales de línea')" = 1 ] && ok "queda alguno: una línea, y el aplicador corre igual (apply sale 0)" || mal "queda alguno: rc $RC: $SALIDA"
# espejo: sin la falla, la receta deja todo con \n y lo dice
SALIDA="$(lab_git_apply '')"
[ "$(crlf_count)" = 0 ] && case "$SALIDA" in *"normalicé"*) true ;; *) false ;; esac && ok "queda alguno, el espejo: cuando la receta funciona, dice «normalicé» y no queda ninguno" || mal "queda alguno, el espejo: quedan $(crlf_count) · $SALIDA"

# ═══ B3 · un archivo con un cambio que `git status` no ve: no se toca nada ═══════════════════════════════════════════
# Eol_HiddenLocalChange_AssumeUnchangedOrSkipWorktree_NothingTouched. «Árbol limpio» no se
# decide con `git status`, que no ve un archivo marcado `--assume-unchanged`: la receta pisaría su cambio local y diría
# «normalicé». Con `--skip-worktree` sobreviviría, pero el paso saldría `failed` en cada corrida. Por eso, con cualquiera de las
# dos marcas en algún archivo, no se toca nada y se dice cuáles (hasta tres nombres y la cuenta) y qué correr.
echo "· un cambio que git status no ve"
tracked() { harness_lab_git "$LAB_TREE" ls-files | wc -l | tr -d ' '; }
for flag in assume-unchanged skip-worktree; do
  old_clone "$HOOK"
  harness_lab_git "$LAB_TREE" update-index "--$flag" README.md
  printf 'MI CAMBIO LOCAL\n' >> "$LAB_TREE/README.md"
  [ -z "$(dirty)" ] || mal "$flag: el laboratorio no esconde el cambio (git status: «$(dirty)»)"
  SALIDA="$(TYCON_HARNESS_EOL_PLATFORM=win32 harness apply 2>&1)"; RC=$?
  grep -q 'MI CAMBIO LOCAL' "$LAB_TREE/README.md" && [ "$(crlf_count)" = 1 ] && has_cr "$LAB_TREE/$HOOK" && ok "$flag: no tocó nada (el cambio local sigue y el \\r\\n también)" || mal "$flag: tocó el clon (cambio local: $(grep -c 'MI CAMBIO LOCAL' "$LAB_TREE/README.md"), con \\r\\n $(crlf_count)) · $SALIDA"
  case "$SALIDA" in *"finales de línea"*"README.md"*"--no-$flag"*"rm --cached -r -q ."*) ok "$flag: lo dice, con el archivo, cómo quitarle la marca y la receta" ;; *) mal "$flag: no lo dice con el archivo y qué correr: $SALIDA" ;; esac
  case "$SALIDA" in *"normalic"*) mal "$flag: dice que normalizó: $SALIDA" ;; *) ok "$flag: no dice «normalicé»" ;; esac
  [ "$RC" = 0 ] && ok "$flag: el aplicador corre igual (apply sale 0)" || mal "$flag: apply rc $RC: $SALIDA"
  harness_lab_git "$LAB_TREE" update-index "--no-$flag" README.md
  harness_lab_git "$LAB_TREE" checkout -q -- README.md
done
# hasta tres nombres y la cuenta
old_clone "$HOOK"
for f in a.txt b.txt c.txt d.txt; do harness_lab_publish tree "archivo de juguete $f" "$f" "$f"; done
harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1   # lo publicado, no un commit propio: update lo sigue aceptando
harness_lab_git "$LAB_TREE" update-index --assume-unchanged a.txt b.txt c.txt d.txt
SALIDA="$(TYCON_HARNESS_EOL_PLATFORM=win32 harness apply 2>&1)"
case "$SALIDA" in *"4 archivo(s)"*"a.txt"*"b.txt"*"c.txt"*"y 1 más"*) ok "con cuatro marcados: nombra tres y dice la cuenta" ;; *) mal "con cuatro marcados: no nombra tres con la cuenta: $SALIDA" ;; esac
harness_lab_git "$LAB_TREE" update-index --no-assume-unchanged a.txt b.txt c.txt d.txt
# el espejo: sin marcas, el mismo clon se normaliza
SALIDA="$(TYCON_HARNESS_EOL_PLATFORM=win32 harness apply 2>&1)"
[ "$(crlf_count)" = 0 ] && case "$SALIDA" in *"normalicé"*) true ;; *) false ;; esac && ok "el espejo: sin marcas, normaliza y lo dice" || mal "el espejo sin marcas: quedan $(crlf_count) · $SALIDA"

# ═══ B4 · la receta no vacía el índice, y un índice vacío no es «limpio» ═════════════════════════════════════════════
# Eol_RecipeKilled_IndexNeverEmptied / Eol_EmptyIndexWithHead_IsBroken_Said. Una receta
# que vacíe el índice (`rm --cached -r .`) y lo rearme (`reset --hard`) deja el índice vacío si el segundo paso muere:
# el paso siguiente leería «nada con \r\n» y contestaría `clean` callado para siempre. La receta reescribe SÓLO
# los archivos con \r\n desde el índice, sin vaciarlo; y un índice vacío con un HEAD que tiene archivos se dice.
echo "· la receta muere a mitad"
old_clone "$HOOK" README.md
N0="$(tracked)"
SALIDA="$(lab_git_apply checkout-killed)"; RC=$?
[ "$(tracked)" = "$N0" ] && [ -z "$(dirty)" ] && ok "git terminado a la fuerza a mitad de la receta: el índice sigue entero ($N0 archivos) y el árbol limpio" || mal "receta matada: el índice quedó con $(tracked) de $N0, sucio «$(dirty)»"
said "$SALIDA" && case "$SALIDA" in *"no pude"*) true ;; *) false ;; esac && [ "$RC" = 0 ] && ok "…lo dice, y el aplicador corre igual" || mal "receta matada: rc $RC · $SALIDA"
SALIDA="$(lab_git_apply '')"
[ "$(crlf_count)" = 0 ] && case "$SALIDA" in *"normalicé"*) true ;; *) false ;; esac && ok "…y la ejecución siguiente, con git sano, normaliza (no contesta «limpio» callado)" || mal "tras la receta matada: quedan $(crlf_count) · $SALIDA"
echo "· un índice vacío con HEAD lleno"
old_clone "$HOOK"
harness_lab_git "$LAB_TREE" rm --cached -r -q .   # lo que dejaba la receta vieja si moría entre sus dos pasos
SALIDA="$(TYCON_HARNESS_EOL_PLATFORM=win32 harness apply 2>&1)"; RC=$?
case "$SALIDA" in *"finales de línea"*"índice"*"vacío"*"reset -q"*) ok "índice vacío con HEAD lleno: no es «limpio», lo dice con la receta para recuperarlo (git reset -q)" ;; *) mal "índice vacío con HEAD lleno: no lo dice: $SALIDA" ;; esac
[ "$(tracked)" = 0 ] && has_cr "$LAB_TREE/$HOOK" && [ "$RC" = 0 ] && ok "…no toca nada más, y el aplicador corre igual" || mal "índice vacío: tocó algo (en el índice $(tracked)), rc $RC"
TYCON_UPDATE=0 TYCON_HARNESS_EOL_PLATFORM=win32 harness startup >/dev/null 2>&1
DOC="$(TYCON_HARNESS_EOL_PLATFORM=win32 harness doctor 2>&1)"
case "$DOC" in *"finales de línea"*"índice"*"vacío"*) ok "…y doctor lo muestra (el aviso del paso queda en notice)" ;; *) mal "índice vacío: doctor no lo muestra: $(printf '%s\n' "$DOC" | grep -i 'aviso' | head -3)" ;; esac
# el espejo: recuperado el índice con la receta que da el aviso, normaliza
harness_lab_git "$LAB_TREE" reset -q
SALIDA="$(TYCON_HARNESS_EOL_PLATFORM=win32 harness apply 2>&1)"
[ "$(crlf_count)" = 0 ] && [ "$(tracked)" = "$N0" ] && case "$SALIDA" in *"normalicé"*) true ;; *) false ;; esac && ok "el espejo: con el índice rearmado (git reset -q), normaliza" || mal "el espejo del índice vacío: quedan $(crlf_count), en el índice $(tracked) · $SALIDA"
# un nombre con espacio y eñe: la lista va por -z (sin -z git lo citaría y la receta no lo encontraría)
old_clone "$HOOK"
harness_lab_publish tree "un nombre con espacio y eñe" "año nuevo.txt" 'linea'
harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1
old_clone "$HOOK" "año nuevo.txt"
SALIDA="$(TYCON_HARNESS_EOL_PLATFORM=win32 harness apply 2>&1)"
[ "$(crlf_count)" = 0 ] && ! has_cr "$LAB_TREE/año nuevo.txt" && [ -z "$(dirty)" ] && ok "un archivo con espacio y eñe en el nombre también se normaliza" || mal "nombre con espacio y eñe: quedan $(crlf_count), sucio «$(dirty)» · $SALIDA"

# ═══ startup, con el clon ya al día ══════════════════════════════════════════════════════════════════════════════════
echo "· startup"
old_clone "$APPLIER" "$HOOK"
SALIDA="$(TYCON_HARNESS_EOL_PLATFORM=win32 harness startup 2>&1)"; RC=$?
[ "$RC" = 0 ] && [ "$(crlf_count)" = 0 ] && ok "T98 startup con el clon ya al día: normaliza" || mal "T98 startup: rc $RC, quedan $(crlf_count) · $SALIDA"
step_before_applier && ok "T98 startup: el paso queda antes que el aplicador" || mal "T98 startup: el orden en el registro: $(grep -n 'finales de línea\|aplicador' "$(REGISTRO)" | tail -4)"

# Eol_StartupNotice_ReachesNotice_NotStderr. En `startup` la línea de arranque es async:
# su salida no llega a la conversación, sólo `notice` del estado (lo imprime el hook síncrono en la sesión). El aviso del
# paso —árbol sucio, o el paso falló— va a `notice`, junto a otro aviso si lo hay (no lo pisa), y NO a stderr (ahí nadie
# lo ve y el ensayo de Windows lo cuenta como ruido de la línea de arranque). En install/apply/update, en una terminal,
# sigue saliendo por stderr (los casos de arriba lo miden con `apply 2>&1`).
echo "· startup: el aviso llega a notice"
notice() { node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(s.notice==null?"":s.notice)' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json" 2>&1; }
old_clone "$HOOK"
printf 'cambio local sin commitear\n' >> "$LAB_TREE/README.md"
TYCON_UPDATE=0 TYCON_HARNESS_EOL_PLATFORM=win32 harness startup > "$BASE/b2.out" 2> "$BASE/b2.err"; RC=$?
case "$(notice)" in *"finales de línea"*"cambios sin commitear"*"rm --cached -r -q ."*) ok "startup, árbol sucio: el aviso del paso queda en notice, con lo que hay que correr" ;; *) mal "startup, árbol sucio: notice no trae el aviso del paso: «$(notice)»" ;; esac
[ "$RC" = 0 ] && ! grep -q 'finales de línea' "$BASE/b2.err" "$BASE/b2.out" && ok "startup, árbol sucio: …y no sale por stderr ni por stdout" || mal "startup, árbol sucio: rc $RC, salió por la salida: $(cat "$BASE/b2.out" "$BASE/b2.err" | grep 'finales de línea' | cut -c1-200)"
# con otro aviso a la vez (el aplicador falla): los dos, juntos
LAB_APPLIER_FAIL=1 TYCON_UPDATE=0 TYCON_HARNESS_EOL_PLATFORM=win32 harness startup > "$BASE/b2b.out" 2> "$BASE/b2b.err"
case "$(notice)" in *"el aplicador falló"*"finales de línea"*"cambios sin commitear"*) ok "startup con el aplicador que falla y el árbol sucio: notice trae los dos avisos, sin pisar ninguno" ;; *) mal "startup con dos avisos: «$(notice)»" ;; esac
[ "$(printf '%s' "$(notice)" | grep -o 'finales de línea:' | wc -l | tr -d ' ')" = 1 ] && ok "…y el de finales de línea una sola vez (el del arranque anterior no se arrastra)" || mal "el aviso de finales de línea se repite: «$(notice)»"
# el espejo: limpio otra vez, el paso normaliza y el aviso se va de notice
harness_lab_git "$LAB_TREE" checkout -q -- README.md
TYCON_UPDATE=0 TYCON_HARNESS_EOL_PLATFORM=win32 harness startup > "$BASE/b2c.out" 2> "$BASE/b2c.err"; RC=$?
[ "$RC" = 0 ] && [ "$(crlf_count)" = 0 ] && case "$(notice)" in *"finales de línea"*) false ;; *) true ;; esac && ok "el espejo: limpio otra vez, startup normaliza y notice ya no trae el aviso" || mal "el espejo: rc $RC, quedan $(crlf_count), notice «$(notice)»"
! grep -q 'finales de línea' "$BASE/b2c.err" && ok "el espejo: …y tampoco dice «normalicé» por stderr en startup (va al registro)" || mal "el espejo: startup escribió por stderr: $(cut -c1-200 "$BASE/b2c.err")"

# ═══ update, con versión nueva ═══════════════════════════════════════════════════════════════════════════════════════
echo "· update"
old_clone "$APPLIER" "$HOOK"
harness_lab_publish tree "versión 2" VERSION 2
V2="$(harness_lab_git "$LAB_AUTHOR_TREE" rev-parse HEAD)"
SALIDA="$(TYCON_UPDATE_APPLY=auto TYCON_HARNESS_EOL_PLATFORM=win32 harness update 2>&1)"; RC=$?
[ "$RC" = 0 ] && [ "$(harness_lab_git "$LAB_TREE" rev-parse HEAD)" = "$V2" ] && ok "T98 update: la versión nueva quedó aplicada" || mal "T98 update: rc $RC HEAD $(harness_lab_git "$LAB_TREE" rev-parse HEAD) (punta $V2): $SALIDA"
[ "$(crlf_count)" = 0 ] && step_before_applier && ok "T98 update: normaliza lo que el avance no tocó, antes del aplicador" || mal "T98 update: quedan $(crlf_count) · $(grep -n 'finales de línea\|aplicador' "$(REGISTRO)" | tail -4)"

# ═══ install, sobre un clon viejo ════════════════════════════════════════════════════════════════════════════════════
echo "· install"
lab t98-install
old_clone "$APPLIER" "$HOOK"
SALIDA="$(TYCON_HARNESS_EOL_PLATFORM=win32 harness install --yes 2>&1)"; RC=$?
[ "$RC" = 0 ] && [ "$(crlf_count)" = 0 ] && ok "T98 install sobre un clon viejo: normaliza y queda instalado" || mal "T98 install: rc $RC, quedan $(crlf_count) · $SALIDA"
said "$SALIDA" && step_before_applier && ok "T98 install: lo dice, y el paso queda antes que el aplicador" || mal "T98 install: $SALIDA · $(grep -n 'finales de línea\|aplicador' "$(REGISTRO)" | tail -4)"
# espejo: una instalación en Linux sobre el mismo clon viejo no lo toca
lab t98-install-linux
old_clone "$HOOK"
SALIDA="$(harness install --yes 2>&1)"; RC=$?
[ "$RC" = 0 ] && [ "$(crlf_count)" = 1 ] && ! said "$SALIDA" && ok "T98 espejo: install en Linux no toca los finales de línea" || mal "T98 install en Linux: rc $RC, con \\r\\n $(crlf_count) · $SALIDA"

# ═══ doctor después de normalizar: la copia fija no sale «vieja» por un \r\n ═════════════════════════════════════════
# Eol_DoctorAfterNormalize_FixedCopyNotStale (medido en Windows).
# La copia fija de arranque se toma del árbol en la instalación y se refresca sólo tras una salud en verde (es la red
# para volver atrás). En un clon viejo se toma con \r\n; el paso de finales de línea deja el árbol con \n y `doctor`
# diría «copia fija de arranque vieja respecto del árbol» en cada sesión, aunque el contenido fuera el mismo. Un
# cambio de verdad en el árbol tiene que seguir dando el aviso (el espejo).
# 🔴 Rojo si doctor da el aviso tras normalizar.
echo "· doctor después de normalizar"
lab eol-doctor
FIXED="scripts/setup/harness/bootstrap.js"
FIXED_COPY="$LAB_HOME/.claude/.tycon-pipeline/harness/bootstrap.js"
old_clone "$FIXED" scripts/setup/harness.js
harness install --yes >/dev/null 2>&1 || mal "doctor: install previo falló"
has_cr "$FIXED_COPY" && ok "doctor: la copia fija se tomó del clon viejo, con \\r\\n" || mal "doctor: la copia fija no quedó con \\r\\n (el caso no mide lo que dice)"
stale() { case "$1" in *"copia fija de arranque vieja"*) return 0 ;; *) return 1 ;; esac; }
DOC="$(harness doctor 2>&1)"
! stale "$DOC" && ok "doctor: antes de normalizar, la copia fija está al día" || mal "doctor: ya antes de normalizar sale vieja: $(printf '%s\n' "$DOC" | grep 'copia fija')"
TYCON_HARNESS_EOL_PLATFORM=win32 harness apply >/dev/null 2>&1
[ "$(crlf_count)" = 0 ] && has_cr "$FIXED_COPY" && ok "doctor: el árbol quedó con \\n y la copia fija sigue con \\r\\n (no se refresca fuera de una salud en verde)" || mal "doctor: con \\r\\n en el árbol $(crlf_count); copia fija con \\r\\n: $(has_cr "$FIXED_COPY" && echo sí || echo no)"
DOC="$(harness doctor 2>&1)"
! stale "$DOC" && ok "doctor: si lo único distinto es \\r\\n → \\n, no dice que la copia fija está vieja" || mal "doctor: aviso falso tras normalizar: $(printf '%s\n' "$DOC" | grep 'copia fija')"
# el espejo: un cambio de verdad en el árbol (otro contenido, no sólo los finales de línea) sí da el aviso
printf '// un cambio de verdad\n' >> "$LAB_TREE/$FIXED"
DOC="$(harness doctor 2>&1)"
case "$DOC" in *"copia fija de arranque vieja"*"bootstrap.js"*) ok "doctor, el espejo: con otro contenido en el árbol, sí avisa que la copia fija está vieja" ;; *) mal "doctor, el espejo: un cambio real no da el aviso: $(printf '%s\n' "$DOC" | grep 'copia fija')" ;; esac
harness_lab_git "$LAB_TREE" checkout -q -- "$FIXED"

if [ "$FALLOS" = 0 ]; then echo "✅ harness-eol: todo verde"; exit 0; fi
echo "❌ harness-eol: $FALLOS fallo(s)"; exit 1
