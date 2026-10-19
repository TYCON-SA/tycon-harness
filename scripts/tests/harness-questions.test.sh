#!/usr/bin/env bash
# harness-questions.test.sh — las preguntas de la instalación (story 8.16, tanda D · AC 30 a 33 · T43 a T46).
#
# EL CASO. Hasta la tanda C, quien instalaba sin decir nada recibía el perfil `full`, y las integraciones y el paquete del
# stack se prendían editando `~/.claude/tycon.json` a mano. El dueño decidió «que elija al instalar»: `install` pregunta
# lo que no puede decidir solo, y no tiene un valor por defecto para el perfil. Lo que estas pruebas sostienen:
#   T43 · el perfil se pregunta SIN valor por defecto: Enter vuelve a preguntar, acepta 1, 2, minimal o full, a la tercera
#         respuesta vacía (o con fin de entrada) sale 2 «sin perfil elegido»; sin terminal sale 2 con las dos opciones,
#         también con `--yes` (`--yes` acepta el plan, no elige); `--dry-run` sigue la misma regla. La HOME, igual.
#   T44 · las integraciones: se listan sólo las que la lista de efectos ofrece (clockify, engram, codegraph, codex), ninguna
#         marcada, Enter es «ninguna», un nombre desconocido (o uno que no se ofrece, como mailbox) vuelve a preguntar; el
#         paquete del stack es un sí o no. Nada se escribe de más, y el cierre dice cómo se prenden ado y telegram.
#   T45 · con `--profile`, `--integrations`, `--packs` y `--yes` no hay ninguna pregunta ni hace falta terminal; sin
#         terminal lo que no vino por opción no se escribe; un valor inválido, o una opción que contradice a su variable,
#         sale 2 sin escribir.
#   T46 · el orden es preguntas → el plan (con una cabecera que dice el perfil, las integraciones y el paquete, cada uno con
#         su origen) → la conformidad → recién ahí se escribe. Con un «no» no queda ni tycon.json; la segunda corrida no
#         pregunta nada y dice los valores con su origen; con el perfil del equipo no se pregunta nada.
#
# Laboratorio: scripts/tests/lib/harness-lab.sh (harness.js real, aplicador de juguete), sin el perfil de laboratorio
# (TYCON_PROFILE=0: una máquina de afuera) y con Codex sin fijar (para que se ofrezca). Las respuestas se escriben en la
# terminal de juguete, una por línea, todas juntas: la terminal entrega de a una línea por lectura. Nunca ~/.claude ni el
# checkout real. 🔴 Sin pipes sobre el comando medido: el exit code real es el veredicto.
# 🔴 rojo previo verificado: antes de la tanda D, `install` sin perfil instalaba `full` sin preguntar nada.
#
#   REV · (segunda vuelta: revisión adversarial y decisión del dueño del 2026-10-05, 14:10) fin de entrada en las
#         integraciones es «no» también para la conformidad (sin volver a leer); con `--yes` no se pregunta nada aunque
#         haya terminal (sin perfil sale 2); con el perfil fijado por variable o por archivo no se preguntan las
#         integraciones y el cierre da UNA línea con cómo cambiar el perfil y las integraciones; lo mismo sobre una
#         instalación que ya existe con el perfil sin elegir; `--profile` en la primera instalación con terminal sí
#         pregunta las integraciones; `install --integrations` sobre una instalación sana escribe la llave y el plan la
#         nombra; y el remedio que da sin terminal conserva las opciones recibidas.
#
#   PACKS · (story 8.29) el perfil del equipo gana sobre los paquetes elegidos al instalar: con un perfil que declara
#         los paquetes, `--packs` con otro valor no se escribe y el plan lo dice en una línea (la instalación sigue);
#         sin perfil se escribe como siempre, y cuando el perfil llega después los paquetes salen de él.
#
# Uso: bash scripts/tests/harness-questions.test.sh [--only T43|T44|T45|T46|REV|PACKS|DEFAULTS|UPGRADE]
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ONLY=""; [ "${1:-}" = "--only" ] && ONLY="${2:-}"
corre() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
T="$(mktemp -d "${TMPDIR:-/tmp}/harness-questions.XXXXXX")"; T="$(cd "$T" && pwd)"
node "$RAIZ/scripts/tests/lib/lab-guard.js" "$T" harness-questions --place || exit 1
trap 'rm -rf "$T"' EXIT

# shellcheck source=lib/harness-lab.sh
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
# qlab <nombre> → un laboratorio nuevo de una máquina de AFUERA que nunca instaló: sin perfil del equipo (ni el del
# laboratorio), sin ~/.claude/.tycon-pipeline, con Codex sin fijar
qlab() {
  harness_lab_create "$T/lab-$1" >/dev/null || { mal "no se pudo armar el laboratorio $1"; return 1; }
  rm -rf "$LAB_HOME/.claude/.tycon-pipeline"
  export TYCON_PROFILE=0
  unset TYCON_CODEX TYCON_INSTALL_PROFILE TYCON_CLOCKIFY TYCON_ENGRAM TYCON_CODEGRAPH TYCON_PACKS_DEFAULT
}
home_now() { harness_lab_home_hash; }
cfg() { python3 -c "
import json,sys
try: d=json.load(open(sys.argv[1], encoding='utf-8'))
except Exception: print('sin-archivo'); sys.exit(0)
print($1)" "$LAB_HOME/.claude/tycon.json"; }
# count <texto> <archivo> → cuántas veces aparece (no cuántas líneas: las respuestas escritas de antemano hacen que la
# terminal muestre varias preguntas en un mismo renglón)
count() { python3 -c "import sys; print(open(sys.argv[2], encoding='utf-8', errors='replace').read().count(sys.argv[1]))" "$1" "$2" 2>/dev/null || echo 0; }
# line_of <texto> <archivo> → el número de la primera línea que lo trae (0 si no está)
line_of() { local n; n="$(grep -n -m1 -- "$1" "$2" 2>/dev/null | cut -d: -f1)"; echo "${n:-0}"; }
# at <texto> <archivo> → la posición (en caracteres, desde 1) de su primera aparición (0 si no está)
at() { python3 -c "import sys; print(open(sys.argv[2], encoding='utf-8', errors='replace').read().find(sys.argv[1]) + 1)" "$1" "$2" 2>/dev/null || echo 0; }
NL=$'\n'

# ══ T43 · el perfil: sin valor por defecto, sin terminal 2 (también con --yes) ══════════════════════════════════════════
if corre T43; then
  echo "T43 · Install_ProfileQuestion_NoDefault_EmptyReasks_NoTtyExit2_YesDoesNotChoose"
  qlab t43a || true
  # Enter, Enter, «2» → full; después Enter a las integraciones, Enter al paquete y «s» a la conformidad
  RC=0; harness_lab_pty "${NL}${NL}2${NL}${NL}${NL}s" harness install > "$T/t43-ask.out" 2>&1 || RC=$?
  N="$(count 'Elegí 1, 2, minimal o full' "$T/t43-ask.out")"
  if [ "$RC" = 0 ] && [ "$N" = 3 ] && [ "$(cfg "(d.get('install') or {}).get('profile')")" = full ]; then ok "T43 Enter, Enter, «2»: pregunta tres veces y queda full en tycon.json"
  else mal "T43 Enter, Enter, «2»: rc ${RC}, ${N} preguntas, tycon.json $(cfg "d")"; fi
  if grep -q '^  1) minimal' "$T/t43-ask.out" && grep -q '^  2) full' "$T/t43-ask.out" && [ "$(grep -c '^     ' "$T/t43-ask.out")" -ge 2 ]; then ok "T43 muestra las dos opciones, cada una con dos renglones"
  else mal "T43 las opciones: $(grep -A1 -e '1) minimal' -e '2) full' "$T/t43-ask.out" | head -6 | tr '\n' '|')"; fi
  grep -q 'no hay uno por defecto' "$T/t43-ask.out" && ok "T43 la pregunta dice que no hay perfil por defecto" || mal "T43 la pregunta no dice que no hay valor por defecto"
  # los renglones de cada perfil salen de la lista de efectos (cuántos hooks): el de minimal nombra siete
  N7="$(python3 -c "
import json,sys
e=json.load(open(sys.argv[1], encoding='utf-8'))['effects']
print(sum(1 for x in e if x['kind']=='hook' and 'minimal' in x['profiles'] and x['when'] in ('always','optin:TYCON_SAFETY_GUARD')))" "$RAIZ/scripts/setup/install-effects.json")"
  grep -q "^  1) minimal: ${N7} hooks" "$T/t43-ask.out" && ok "T43 el renglón de minimal cuenta sus hooks desde la lista de efectos (${N7})" || mal "T43 el renglón de minimal: $(grep -m1 '1) minimal' "$T/t43-ask.out")"
  [ "$(python3 -c "import json,sys; print((json.load(open(sys.argv[1])).get('profile') or {}).get('value'))" "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json" 2>/dev/null)" = full ] \
    && ok "T43 el estado guarda el perfil elegido" || mal "T43 el estado no guarda el perfil elegido"

  for caso in "empty3|${NL}${NL}" "eof|EOF" "invalid3|3${NL}medio${NL}tres"; do
    name="${caso%%|*}"; answer="${caso#*|}"
    qlab "t43-$name" || true; ANTES="$(home_now)"
    RC=0; harness_lab_pty "$answer" harness install > "$T/t43-$name.out" 2>&1 || RC=$?
    if [ "$RC" = 2 ] && grep -q 'sin perfil elegido no escribo nada' "$T/t43-$name.out" && [ "$(home_now)" = "$ANTES" ] && [ ! -e "$LAB_HOME/.claude/.tycon-pipeline" ]; then
      ok "T43 ${name}: 2 «sin perfil elegido no escribo nada», la HOME igual"
    else mal "T43 ${name}: rc ${RC}; HOME $( [ "$(home_now)" = "$ANTES" ] && echo igual || echo CAMBIADA ); $(tail -n 2 "$T/t43-$name.out" | tr '\n' ' ')"; fi
  done
  grep -q '«medio» no es una opción' "$T/t43-invalid3.out" && ok "T43 una respuesta inválida se nombra y se vuelve a preguntar" || mal "T43 la respuesta inválida: $(grep -m2 -i 'opción' "$T/t43-invalid3.out" | tr '\n' ' ')"

  qlab t43-notty || true; ANTES="$(home_now)"
  for args in "install" "install --yes" "install --dry-run"; do
    tag="$(printf '%s' "$args" | tr ' -' '__')"
    # shellcheck disable=SC2086
    RC=0; harness $args > "$T/t43-$tag.out" 2>&1 < /dev/null || RC=$?
    if [ "$RC" = 2 ] && grep -q 'elegí el perfil: `--profile minimal` o `--profile full`' "$T/t43-$tag.out" && grep -q '^  1) minimal' "$T/t43-$tag.out" \
       && grep -q '^  2) full' "$T/t43-$tag.out" && ! grep -q 'Elegí 1, 2' "$T/t43-$tag.out" && [ "$(home_now)" = "$ANTES" ]; then
      ok "T43 sin terminal (${args}): 2 con las dos opciones, sin preguntar, la HOME igual"
    else mal "T43 sin terminal (${args}): rc ${RC}; $(head -n 3 "$T/t43-$tag.out" | tr '\n' ' ')"; fi
  done
  # --dry-run con terminal: pregunta (preguntar no es escribir), muestra el plan con el perfil elegido, 0, nada escrito
  RC=0; harness_lab_pty "minimal${NL}${NL}" harness install --dry-run > "$T/t43-dry.out" 2>&1 || RC=$?
  if [ "$RC" = 0 ] && grep -q '^perfil: minimal (respuesta)' "$T/t43-dry.out" && grep -q '^escribe:' "$T/t43-dry.out" && ! grep -q '¿Instalo?' "$T/t43-dry.out" && [ "$(home_now)" = "$ANTES" ]; then
    ok "T43 --dry-run con terminal: pregunta, «minimal» en palabras vale, el plan con «perfil: minimal (respuesta)», 0, nada escrito"
  else mal "T43 --dry-run con terminal: rc ${RC}; $(grep -m3 -e '^perfil' -e 'Instalo' -e 'escribe' "$T/t43-dry.out" | tr '\n' ' ')"; fi
fi

# ══ T44 · las integraciones y el paquete: nada marcado, sólo lo ofrecido ═════════════════════════════════════════════════
if corre T44; then
  echo "T44 · Install_IntegrationsAndPackQuestions_NothingPreselected_OnlyOffered"
  qlab t44a || true
  RC=0; harness_lab_pty "1${NL}${NL}${NL}s" harness install > "$T/t44-none.out" 2>&1 || RC=$?
  if [ "$RC" = 0 ] && [ "$(cfg "sorted(d.keys())")" = "['install']" ]; then ok "T44 Enter en las dos: sólo queda install.profile (nada escrito de más)"
  else mal "T44 Enter en las dos: rc ${RC}; tycon.json $(cfg "d"); $(tail -n 3 "$T/t44-none.out" | tr '\n' ' ')"; fi
  grep -q 'Ninguna viene marcada; Enter es «ninguna»' "$T/t44-none.out" && ok "T44 la pregunta dice que ninguna viene marcada y que Enter es «ninguna»" || mal "T44 la pregunta de integraciones: $(grep -m1 -i 'integraciones' "$T/t44-none.out")"
  OFFERED="$(sed -n '/¿Qué integraciones prendo?/,/Nombres separados por coma/p' "$T/t44-none.out" | sed -n 's/^  - \([a-z]*\):.*/\1/p' | tr '\n' ' ')"
  [ "$OFFERED" = "clockify engram codegraph codex " ] && ok "T44 se ofrecen clockify, engram, codegraph y codex, en ese orden" || mal "T44 lo ofrecido: «${OFFERED}»"
  BLOCK="$(sed -n '/¿Qué integraciones prendo?/,/Nombres separados por coma/p' "$T/t44-none.out")"
  case "$BLOCK" in *mailbox*|*nightly*|*"  - ado"*|*"  - telegram"*) mal "T44 la lista ofrece algo que no se puede usar afuera o que pide un dato: $BLOCK" ;; *) ok "T44 mailbox, nightly, ado y telegram no se ofrecen" ;; esac
  ENG="$(printf '%s\n' "$BLOCK" | grep '^  - engram:')"
  case "$ENG" in *Homebrew*TYCON_ENGRAM_AUTO_UPGRADE=0*TYCON_SQLITE_AUTO_INSTALL=0*) ok "T44 el renglón de engram dice que puede reinstalarlo con Homebrew y sus dos interruptores" ;; *) mal "T44 el renglón de engram: ${ENG}" ;; esac
  grep -q 'packs: \[bizuit\]' "$T/t44-none.out" && ok "T44 la pregunta del paquete dice la alternativa por repo (packs: [bizuit])" || mal "T44 la pregunta del paquete no dice la alternativa por repo"
  grep -q 'tycon-config.js set ado.org' "$T/t44-none.out" && grep -q 'telegram' "$T/t44-none.out" && ok "T44 el cierre dice cómo se prenden ado y telegram" || mal "T44 el cierre no nombra ado y telegram: $(tail -n 12 "$T/t44-none.out" | tr '\n' ' ')"

  qlab t44b || true
  # (story 8.23, tanda C) contestar «codex» ENCHUFA a Codex en esa misma corrida: el árbol de juguete necesita las piezas
  # de su enchufe (el árbol unido y los desplegadores), como las trae el arnés de verdad
  harness_lab_release_server && harness_lab_codex_pieces || mal "T44 no pude sumar las piezas de Codex al laboratorio"
  RC=0; harness_lab_pty "2${NL}engram, codex${NL}s${NL}s" harness install > "$T/t44-some.out" 2>&1 || RC=$?
  if [ "$RC" = 0 ] && [ "$(cfg "[(d.get('integrations') or {}).get(k) for k in ('engram','codex','clockify')] + [(d.get('packs') or {}).get('default')]")" = "[True, True, None, 'all']" ]; then
    ok "T44 «engram, codex» y «s»: las dos llaves y packs.default: all (y nada más)"
  else mal "T44 «engram, codex» y «s»: rc ${RC}; tycon.json $(cfg "d")"; fi
  # lo contestado decide también el enchufe: el estado anota a Codex y su hoja de reglas existe (antes de la tanda C se
  # elegía con la llave de ANTES de preguntar, y la respuesta recién valía en la corrida siguiente)
  TOOLS="$(harness_lab_state | python3 -c "import json,sys; print(','.join(json.load(sys.stdin).get('tools') or []))" 2>/dev/null)"
  if [ "$TOOLS" = "claude,codex" ] && [ -f "$CODEX_HOME/AGENTS.md" ]; then ok "T44 contestar «codex» lo enchufa en esa misma corrida (estado: ${TOOLS})"
  else mal "T44 contestar «codex» no lo enchufó: estado «${TOOLS}», AGENTS.md $([ -f "$CODEX_HOME/AGENTS.md" ] && echo está || echo falta)"; fi
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null

  qlab t44c || true
  RC=0; harness_lab_pty "2${NL}foo${NL}mailbox${NL}engram${NL}${NL}n" harness install > "$T/t44-unknown.out" 2>&1 || RC=$?
  N="$(count 'Nombres separados por coma' "$T/t44-unknown.out")"
  if [ "$N" = 3 ] && grep -q '«foo» no es una de las que se ofrecen' "$T/t44-unknown.out" && grep -q '«mailbox» no es una de las que se ofrecen' "$T/t44-unknown.out"; then
    ok "T44 un nombre desconocido (y mailbox, que no se ofrece) vuelve a preguntar nombrándolo"
  else mal "T44 nombre desconocido: ${N} preguntas; $(grep -m2 'no es una de' "$T/t44-unknown.out" | tr '\n' ' ')"; fi
  [ "$RC" = 0 ] && [ ! -e "$LAB_HOME/.claude/tycon.json" ] && ok "T44 …y con «n» a la conformidad no queda nada" || mal "T44 con «n»: rc ${RC}, tycon.json $(cfg "d")"
fi

# ══ T45 · las cuatro opciones: ninguna pregunta; un valor inválido sale 2 ════════════════════════════════════════════════
if corre T45; then
  echo "T45 · Install_Options_ZeroQuestions_InvalidExit2"
  qlab t45a || true
  RC=0; harness install --profile full --integrations engram --packs all --yes > "$T/t45-four.out" 2>&1 < /dev/null || RC=$?
  if [ "$RC" = 0 ] && ! grep -q '¿' "$T/t45-four.out" && [ "$(cfg "[(d.get('install') or {}).get('profile'), (d.get('integrations') or {}).get('engram'), (d.get('packs') or {}).get('default')]")" = "['full', True, 'all']" ]; then
    ok "T45 las cuatro opciones sin terminal: instala sin preguntar, con lo pedido en tycon.json"
  else mal "T45 las cuatro opciones: rc ${RC}; tycon.json $(cfg "d"); $(tail -n 3 "$T/t45-four.out" | tr '\n' ' ')"; fi
  grep -q '^integraciones: engram (--integrations)' "$T/t45-four.out" && ok "T45 …y el cierre dice el origen de cada una" || mal "T45 el origen de las integraciones: $(grep -m1 '^integraciones' "$T/t45-four.out")"

  qlab t45b || true
  RC=0; harness install --profile minimal --yes > "$T/t45-two.out" 2>&1 < /dev/null || RC=$?
  if [ "$RC" = 0 ] && [ "$(cfg "sorted(d.keys())")" = "['install']" ] && ! grep -q '¿' "$T/t45-two.out"; then ok "T45 sin --integrations ni --packs y sin terminal: quedan apagadas y none (no se escriben)"
  else mal "T45 sólo --profile: rc ${RC}; tycon.json $(cfg "d")"; fi

  # con terminal y las cuatro: ninguna pregunta
  qlab t45c || true
  RC=0; harness_lab_pty - harness install --profile minimal --integrations none --packs none --yes > "$T/t45-tty.out" 2>&1 || RC=$?
  [ "$RC" = 0 ] && ! grep -q '¿' "$T/t45-tty.out" && ok "T45 con terminal y las cuatro opciones: ninguna pregunta" || mal "T45 con terminal y las cuatro: rc ${RC}; $(grep -m2 '¿' "$T/t45-tty.out" | tr '\n' ' ')"

  qlab t45d || true; ANTES="$(home_now)"
  RC=0; harness install --profile full --integrations foo --yes > "$T/t45-foo.out" 2>&1 < /dev/null || RC=$?
  { [ "$RC" = 2 ] && grep -q 'clockify, engram, codegraph, codex' "$T/t45-foo.out" && grep -q 'none' "$T/t45-foo.out" && [ "$(home_now)" = "$ANTES" ]; } \
    && ok "T45 --integrations foo: 2 nombrando las válidas, nada escrito" || mal "T45 --integrations foo: rc ${RC}; $(head -c 300 "$T/t45-foo.out")"
  RC=0; harness install --profile full --integrations mailbox --yes > "$T/t45-mb.out" 2>&1 < /dev/null || RC=$?
  { [ "$RC" = 2 ] && [ "$(home_now)" = "$ANTES" ]; } && ok "T45 --integrations mailbox (no se ofrece): 2, nada escrito" || mal "T45 --integrations mailbox: rc ${RC}"
  RC=0; harness install --profile full --packs medio --yes > "$T/t45-packs.out" 2>&1 < /dev/null || RC=$?
  { [ "$RC" = 2 ] && grep -q 'all' "$T/t45-packs.out" && grep -q 'none' "$T/t45-packs.out" && [ "$(home_now)" = "$ANTES" ]; } \
    && ok "T45 --packs medio: 2 nombrando all y none, nada escrito" || mal "T45 --packs medio: rc ${RC}; $(head -c 300 "$T/t45-packs.out")"
  RC=0; TYCON_ENGRAM=0 harness install --profile full --integrations engram --yes > "$T/t45-env.out" 2>&1 < /dev/null || RC=$?
  { [ "$RC" = 2 ] && grep -q 'TYCON_ENGRAM' "$T/t45-env.out" && [ "$(home_now)" = "$ANTES" ]; } \
    && ok "T45 --integrations engram con TYCON_ENGRAM=0: 2 nombrando la variable, nada escrito" || mal "T45 opción contra variable: rc ${RC}; $(head -c 300 "$T/t45-env.out")"
  RC=0; TYCON_PACKS_DEFAULT=none harness install --profile full --packs all --yes > "$T/t45-penv.out" 2>&1 < /dev/null || RC=$?
  { [ "$RC" = 2 ] && grep -q 'TYCON_PACKS_DEFAULT' "$T/t45-penv.out" && [ "$(home_now)" = "$ANTES" ]; } \
    && ok "T45 --packs all con TYCON_PACKS_DEFAULT=none: 2 nombrando la variable, nada escrito" || mal "T45 --packs contra variable: rc ${RC}; $(head -c 300 "$T/t45-penv.out")"
fi

# ══ T46 · el orden: preguntas → plan → conformidad → escritura ══════════════════════════════════════════════════════════
if corre T46; then
  echo "T46 · Install_Order_QuestionsPlanConsentWrite_DeclinedLeavesNothing_RerunAsksNothing"
  qlab t46a || true; ANTES="$(home_now)"
  RC=0; harness_lab_pty "2${NL}engram${NL}s${NL}n" harness install > "$T/t46-no.out" 2>&1 || RC=$?
  { [ "$RC" = 0 ] && grep -q 'no se instaló nada' "$T/t46-no.out" && [ ! -e "$LAB_HOME/.claude/tycon.json" ] && [ "$(home_now)" = "$ANTES" ]; } \
    && ok "T46 todo contestado y «n» al final: no queda ni tycon.json, la HOME igual" || mal "T46 con «n»: rc ${RC}; tycon.json $(cfg "d")"
  P="$(at 'Elegí 1, 2, minimal o full' "$T/t46-no.out")"; I="$(at 'Nombres separados por coma' "$T/t46-no.out")"
  K="$(at 'paquete del stack en todos tus repos' "$T/t46-no.out")"; E="$(at "${NL}escribe:" "$T/t46-no.out")"; C="$(at '¿Instalo?' "$T/t46-no.out")"
  if [ "$P" -gt 0 ] && [ "$P" -lt "$I" ] && [ "$I" -lt "$K" ] && [ "$K" -lt "$E" ] && [ "$E" -lt "$C" ]; then ok "T46 el orden: perfil → integraciones → paquete → plan → conformidad"
  else mal "T46 el orden (posiciones): perfil ${P} · integraciones ${I} · paquete ${K} · plan ${E} · conformidad ${C}"; fi

  qlab t46b || true
  RC=0; harness_lab_pty "2${NL}engram${NL}s${NL}s" harness install > "$T/t46-yes.out" 2>&1 || RC=$?
  E="$(line_of '^escribe:' "$T/t46-yes.out")"
  HP="$(line_of '^perfil: full (respuesta)' "$T/t46-yes.out")"; HI="$(line_of '^integraciones: engram (respuesta)' "$T/t46-yes.out")"; HK="$(line_of '^paquete del stack por defecto: all (respuesta)' "$T/t46-yes.out")"
  if [ "$RC" = 0 ] && [ "$HP" -gt 0 ] && [ "$HI" -gt 0 ] && [ "$HK" -gt 0 ] && [ "$HP" -lt "$E" ] && [ "$HI" -lt "$E" ] && [ "$HK" -lt "$E" ]; then
    ok "T46 la cabecera del plan dice el perfil, las integraciones y el paquete, cada uno con su origen"
  else mal "T46 la cabecera del plan: rc ${RC}; $(sed -n '1,/^escribe:/p' "$T/t46-yes.out" | grep -e '^perfil' -e '^integraciones' -e '^paquete' | tr '\n' '|')"; fi

  RC=0; harness_lab_pty - harness install > "$T/t46-again.out" 2>&1 || RC=$?
  if [ "$RC" = 0 ] && ! grep -q '¿' "$T/t46-again.out" && grep -q '^perfil: full (~/.claude/tycon.json)' "$T/t46-again.out" \
     && grep -q '^integraciones: engram (~/.claude/tycon.json)' "$T/t46-again.out" && grep -q '^paquete del stack por defecto: all (~/.claude/tycon.json)' "$T/t46-again.out"; then
    ok "T46 segunda corrida: no pregunta nada y dice los valores con su origen"
  else mal "T46 segunda corrida: rc ${RC}; $(grep -e '¿' -e '^perfil' -e '^integraciones' -e '^paquete' "$T/t46-again.out" | head -5 | tr '\n' '|')"; fi

  # con el perfil del equipo (lo que fija el perfil no se pregunta nunca): sólo la conformidad de siempre. La copia
  # pública no trae el perfil del equipo: ahí NO MEDIDO (en el repo interno, que falte sigue siendo rojo).
  if [ ! -f "$RAIZ/perfil-equipo.json" ] && [ ! -f "$RAIZ/scripts/publishing/public-repos.json" ]; then
    echo "  ⏭   — T46 perfil del equipo: NO MEDIDO en la copia — no trae perfil-equipo.json"
  else
  qlab t46c || true; export TYCON_PROFILE="$RAIZ/perfil-equipo.json"
  RC=0; harness_lab_pty s harness install > "$T/t46-team.out" 2>&1 || RC=$?
  if [ "$RC" = 0 ] && ! grep -q -e 'Elegí 1, 2' -e 'Nombres separados por coma' -e 'paquete del stack en todos tus repos' "$T/t46-team.out" && [ ! -e "$LAB_HOME/.claude/tycon.json" ] \
     && grep -q '^perfil: full (perfil)' "$T/t46-team.out"; then ok "T46 con el perfil del equipo: ninguna pregunta de la instalación guiada, tycon.json sin tocar"
  else mal "T46 perfil del equipo: rc ${RC}; $(grep -m3 -e 'Elegí' -e 'Nombres' -e '^perfil' "$T/t46-team.out" | tr '\n' '|')"; fi
  fi
fi

# ══ REV · la segunda vuelta (revisión adversarial y decisión del dueño, 2026-10-05) ════════════════════════════════════
# 🔴 rojo previo verificado: con el código de la primera vuelta, `--yes` en una terminal preguntaba, no había línea de
# «cómo cambiarlo», y el remedio sin terminal perdía las opciones; los otros cuatro casos fijan conductas que ya estaban
# (los mutantes de la revisión los dejaban pasar).
HINT='para cambiar el perfil o las integraciones:'
if corre REV; then
  echo "REV · segunda vuelta: fin de entrada, --yes, perfil fijado, instalación existente, --integrations, el remedio"
  # (C1·1) ^D en las integraciones: no, y la conformidad no vuelve a leer la terminal (sin esto se quedaría esperando)
  qlab rev-eof || true; ANTES="$(home_now)"
  RC=0; harness_lab_pty "2${NL}"$'\x04' harness install > "$T/rev-eof.out" 2>&1 || RC=$?
  { [ "$RC" = 0 ] && grep -q 'no se instaló nada' "$T/rev-eof.out" && ! grep -q '¿Instalo?' "$T/rev-eof.out" && [ "$(home_now)" = "$ANTES" ]; } \
    && ok "REV ^D en las integraciones: «no se instaló nada», sin pedir la conformidad, la HOME igual" || mal "REV ^D en las integraciones: rc ${RC}; $(tail -n 3 "$T/rev-eof.out" | tr '\n' ' ')"
  # (3) --yes en una terminal: ninguna pregunta; sin perfil sale 2 como sin terminal
  qlab rev-yes || true; ANTES="$(home_now)"
  RC=0; harness_lab_pty - harness install --yes > "$T/rev-yes-noprof.out" 2>&1 || RC=$?
  { [ "$RC" = 2 ] && grep -q 'elegí el perfil' "$T/rev-yes-noprof.out" && ! grep -q 'Elegí 1, 2' "$T/rev-yes-noprof.out" && [ "$(home_now)" = "$ANTES" ]; } \
    && ok "REV --yes en una terminal sin perfil: 2 pidiendo --profile, sin preguntar" || mal "REV --yes sin perfil en terminal: rc ${RC}; $(head -n 3 "$T/rev-yes-noprof.out" | tr '\n' ' ')"
  RC=0; harness_lab_pty - harness install --profile minimal --yes > "$T/rev-yes.out" 2>&1 || RC=$?
  { [ "$RC" = 0 ] && ! grep -q '¿' "$T/rev-yes.out" && [ "$(cfg "sorted(d.keys())")" = "['install']" ] && grep -q "$HINT" "$T/rev-yes.out"; } \
    && ok "REV install --profile minimal --yes en una terminal: ninguna pregunta, nada de más escrito, y la línea de cómo cambiarlo" \
    || mal "REV --profile minimal --yes en terminal: rc ${RC}; $(grep -m2 -e '¿' -e "$HINT" "$T/rev-yes.out" | tr '\n' '|'); tycon.json $(cfg "d")"
  # (4) --profile en la primera instalación con terminal SÍ pregunta las integraciones (no viene de la configuración)
  qlab rev-opt || true
  RC=0; harness_lab_pty "${NL}${NL}n" harness install --profile full > "$T/rev-opt.out" 2>&1 || RC=$?
  { [ "$RC" = 0 ] && grep -q 'Nombres separados por coma' "$T/rev-opt.out" && grep -q 'paquete del stack en todos tus repos' "$T/rev-opt.out" && ! grep -q 'Elegí 1, 2' "$T/rev-opt.out"; } \
    && ok "REV --profile en la primera instalación con terminal: pregunta las integraciones y el paquete, no el perfil" || mal "REV --profile con terminal: rc ${RC}; $(grep -m3 -e 'Nombres' -e 'paquete' -e 'Elegí' "$T/rev-opt.out" | tr '\n' '|')"
  # (C1·3 y 2) el perfil fijado por variable o por archivo: no pregunta las integraciones, y la línea de cómo cambiarlo
  for via in env file; do
    qlab "rev-fixed-$via" || true
    if [ "$via" = env ]; then export TYCON_INSTALL_PROFILE=minimal; else mkdir -p "$LAB_HOME/.claude"; printf '{ "install": { "profile": "minimal" } }\n' > "$LAB_HOME/.claude/tycon.json"; fi
    RC=0; harness_lab_pty s harness install > "$T/rev-fixed-$via.out" 2>&1 || RC=$?
    unset TYCON_INSTALL_PROFILE
    { [ "$RC" = 0 ] && ! grep -q -e 'Elegí 1, 2' -e 'Nombres separados por coma' -e 'paquete del stack en todos tus repos' "$T/rev-fixed-$via.out" \
      && [ "$(grep -c "$HINT" "$T/rev-fixed-$via.out")" = 1 ] && grep -q 'install --profile minimal|full --integrations <lista|none>' "$T/rev-fixed-$via.out"; } \
      && ok "REV perfil fijado por ${via}: no pregunta las integraciones y da UNA línea con cómo cambiar perfil e integraciones" \
      || mal "REV perfil fijado por ${via}: rc ${RC}; $(grep -m3 -e 'Nombres' -e "$HINT" -e 'Elegí' "$T/rev-fixed-$via.out" | tr '\n' '|')"
  done
  # (C1·2 y 2) una instalación que ya existe con el perfil sin elegir: no pregunta nada y dice cómo cambiarlo
  qlab rev-existing || true
  TYCON_INSTALL_PROFILE=full harness install --yes >/dev/null 2>&1 < /dev/null || mal "REV instalación previa falló"
  RC=0; harness_lab_pty - harness install > "$T/rev-existing.out" 2>&1 || RC=$?
  { [ "$RC" = 0 ] && ! grep -q -e 'Elegí 1, 2' -e 'Nombres separados por coma' "$T/rev-existing.out" && grep -q 'perfil: full (sin elegir)' "$T/rev-existing.out" && grep -q "$HINT" "$T/rev-existing.out"; } \
    && ok "REV instalación existente sin perfil elegido: no pregunta, dice «full (sin elegir)» y cómo cambiarlo" || mal "REV instalación existente: rc ${RC}; $(tail -n 6 "$T/rev-existing.out" | tr '\n' ' ')"
  # (C1·4) sobre esa instalación sana, --integrations escribe la llave y el plan la nombra
  RC=0; harness install --integrations codegraph --dry-run > "$T/rev-int-dry.out" 2>&1 < /dev/null || RC=$?
  grep -q 'tycon.json: .*respuesta de la instalación' "$T/rev-int-dry.out" && ok "REV install --integrations sobre una instalación sana: el plan nombra la escritura en tycon.json" || mal "REV el plan de --integrations: rc ${RC}; $(grep -m3 -e 'escribe' -e 'tycon.json' -e 'sin cambios' "$T/rev-int-dry.out" | tr '\n' '|')"
  RC=0; harness install --integrations codegraph --yes > "$T/rev-int.out" 2>&1 < /dev/null || RC=$?
  { [ "$RC" = 0 ] && [ "$(cfg "(d.get('integrations') or {}).get('codegraph')")" = True ]; } && ok "REV …y con --yes escribe integrations.codegraph" || mal "REV --integrations codegraph --yes: rc ${RC}; tycon.json $(cfg "d")"
  # (C4) sin terminal y sin --yes, el remedio conserva las opciones recibidas
  qlab rev-remedy || true
  RC=0; harness install --profile full --packs all > "$T/rev-remedy.out" 2>&1 < /dev/null || RC=$?
  { [ "$RC" = 2 ] && grep -q 'harness.js install --profile full --packs all --yes' "$T/rev-remedy.out"; } && ok "REV el remedio sin terminal conserva --profile y --packs" || mal "REV el remedio: rc ${RC}; $(tail -n 1 "$T/rev-remedy.out")"
fi

# ══ PACKS · story 8.29: el perfil del equipo gana sobre los paquetes elegidos al instalar (AC 7 y 8 · T7 y T8) ═════════
# La página pública instala con `--packs all`. Sin perfil del equipo eso se escribe en el archivo de la máquina, como
# siempre. Con un perfil que declara los paquetes, lo que diga `--packs` no se escribe: el perfil gana al leer, y una
# escritura que no hace efecto sería una mentira en el archivo de la persona. La instalación no se frena por eso.
# 🔴 rojo previo verificado: antes de la 8.29, `--packs all` contra un perfil en none escribía `all` en tycon.json.
if corre PACKS; then
  echo "8.29 · T7 Install_PacksOption_AgainstProfile_NotWritten · T8 Install_PacksOption_NoProfile_WritesAsToday"
  printf '{ "packs": { "default": "none" } }\n' > "$T/profile-none.json"
  printf '{ "packs": { "default": "all" } }\n' > "$T/profile-all.json"

  # (T7) la referencia: la misma instalación, con ese perfil, sin la opción
  qlab packs-ref || true; export TYCON_PROFILE="$T/profile-none.json"
  REF=0; harness install --profile full --integrations none --yes > "$T/packs-ref.out" 2>&1 < /dev/null || REF=$?
  # con --dry-run: el plan lo dice, no se escribe nada y sale como el mismo simulacro sin la opción
  qlab packs-dry || true; export TYCON_PROFILE="$T/profile-none.json"; ANTES="$(home_now)"
  REFDRY=0; harness install --profile full --integrations none --dry-run > "$T/packs-refdry.out" 2>&1 < /dev/null || REFDRY=$?
  RC=0; harness install --profile full --integrations none --packs all --dry-run > "$T/packs-dry.out" 2>&1 < /dev/null || RC=$?
  if [ "$RC" = "$REFDRY" ] && [ "$RC" = 0 ] && grep -q 'el perfil del equipo lo fija en none' "$T/packs-dry.out" && grep -q -- '--packs all no se escribe' "$T/packs-dry.out" \
     && grep -q '^paquete del stack por defecto: none (perfil)' "$T/packs-dry.out" && [ "$(home_now)" = "$ANTES" ]; then
    ok "T7 --packs all contra un perfil en none, con --dry-run: el plan dice que el perfil lo fija y que no se escribe, y sale como sin la opción (${RC})"
  else mal "T7 con --dry-run: rc ${RC} (sin la opción: ${REFDRY}); $(grep -e 'perfil del equipo' -e '^paquete' "$T/packs-dry.out" | head -3 | tr '\n' '|')"; fi
  ! grep -q 'no se escribe' "$T/packs-refdry.out" && ok "T7 sin la opción no hay nada que avisar" || mal "T7 sin --packs igual avisa: $(grep -m1 'no se escribe' "$T/packs-refdry.out")"
  # de verdad: instala, no escribe los paquetes, y sale como la instalación sin la opción
  RC=0; harness install --profile full --integrations none --packs all --yes > "$T/packs-yes.out" 2>&1 < /dev/null || RC=$?
  if [ "$RC" = "$REF" ] && [ "$RC" = 0 ] && [ "$(cfg "(d.get('packs') or {}).get('default')")" = None ] \
     && grep -q 'el perfil del equipo lo fija en none' "$T/packs-yes.out" && grep -q -- '--packs all no se escribe' "$T/packs-yes.out" \
     && grep -q 'TYCON_PACKS_DEFAULT' "$T/packs-yes.out"; then
    ok "T7 …y con --yes: instala, no escribe los paquetes en tycon.json y nombra la variable"
  else mal "T7 con --yes: rc ${RC} (sin la opción: ${REF}); tycon.json $(cfg "d"); $(grep -m2 'perfil del equipo' "$T/packs-yes.out" | tr '\n' '|')"; fi
  # la misma opción con el valor que el perfil ya dice: nada que escribir y nada que avisar
  qlab packs-same || true; export TYCON_PROFILE="$T/profile-all.json"
  RC=0; harness install --profile full --integrations none --packs all --yes > "$T/packs-same.out" 2>&1 < /dev/null || RC=$?
  { [ "$RC" = 0 ] && [ "$(cfg "(d.get('packs') or {}).get('default')")" = None ] && ! grep -q 'no se escribe' "$T/packs-same.out"; } \
    && ok "T7 --packs all con un perfil en all: no escribe y no avisa" || mal "T7 con el mismo valor: rc ${RC}; tycon.json $(cfg "d")"
  # un árbol de ANTES de la regla (su lector no declara dónde gana el perfil, y ahí la máquina todavía le gana): la opción
  # se escribe como siempre y no se avisa nada — el instalador no promete un orden que ese lector no cumple
  qlab packs-old || true; export TYCON_PROFILE="$T/profile-none.json"
  LECTOR="$LAB_TREE/scripts/lib/tycon-config.js"
  # la lista vacía, traiga lo que traiga hoy (la story 7.19 le sumó `adversarial.model_question`)
  sed -e "s/^const PROFILE_WINS = Object.freeze(\[.*\]);\$/const PROFILE_WINS = Object.freeze([]);/" "$LECTOR" > "$LECTOR.old" \
    && printf '\ndelete module.exports.PROFILE_WINS;\n' >> "$LECTOR.old" && mv "$LECTOR.old" "$LECTOR"
  if [ "$(node -p "typeof require(process.argv[1]).PROFILE_WINS" "$LECTOR" 2>/dev/null)" != undefined ] || ! grep -q '^const PROFILE_WINS = Object.freeze(\[\]);$' "$LECTOR"; then
    mal "T7 árbol anterior: no pude dejar el lector del laboratorio como uno de antes de la regla"
  else
    RC=0; harness install --profile full --integrations none --packs all --yes > "$T/packs-old.out" 2>&1 < /dev/null || RC=$?
    { [ "$RC" = 0 ] && [ "$(cfg "(d.get('packs') or {}).get('default')")" = all ] && ! grep -q 'no se escribe' "$T/packs-old.out"; } \
      && ok "T7 con un lector anterior a la regla: --packs all se escribe como siempre y no se avisa" \
      || mal "T7 árbol anterior: rc ${RC}; tycon.json $(cfg "d"); $(grep -m2 -e 'perfil del equipo' -e 'no se escribe' "$T/packs-old.out" | tr '\n' '|')"
  fi

  # (T8) sin perfil del equipo, como manda la página pública: se escribe, como hoy
  qlab packs-page || true
  RC=0; harness install --profile full --integrations none --packs all --yes > "$T/packs-page.out" 2>&1 < /dev/null || RC=$?
  { [ "$RC" = 0 ] && [ "$(cfg "(d.get('packs') or {}).get('default')")" = all ] && ! grep -q 'no se escribe' "$T/packs-page.out"; } \
    && ok "T8 sin perfil, --packs all se escribe en tycon.json como siempre" || mal "T8 sin perfil: rc ${RC}; tycon.json $(cfg "d")"
  # …y cuando después llega el perfil del equipo (la capa), los paquetes salen del perfil y el archivo queda como estaba
  SUMA="$(cksum < "$LAB_HOME/.claude/tycon.json")"
  RC=0; TYCON_PROFILE="$T/profile-all.json" node "$LAB_TREE/scripts/lib/tycon-config.js" explain > "$T/packs-explain.out" 2>&1 < /dev/null || RC=$?
  { [ "$RC" = 0 ] && grep -q 'packs.default = all (perfil)' "$T/packs-explain.out" && [ "$(cksum < "$LAB_HOME/.claude/tycon.json")" = "$SUMA" ]; } \
    && ok "T8 …con el perfil del equipo después: los paquetes salen del perfil y tycon.json no cambió" \
    || mal "T8 con el perfil después: rc ${RC}; $(grep -m1 'packs.default' "$T/packs-explain.out")"
fi

# ══ DEFAULTS · `--defaults`: lo que nadie fijó se contesta solo; el plan corto, contado desde la lista de efectos ══════════
if corre DEFAULTS; then
  echo "8.46 · T4 Defaults_SinPreguntas · T5 PerfilDelEquipoGana · T6 OpcionExplicitaGana · T7 Clon_SinDefaultsPregunta · T8/T9 PlanCorto"
  # (T4) con terminal y nada fijado: ninguna de las tres preguntas; queda minimal, ninguna conexión y sin paquete
  qlab d4 || true
  RC=0; harness_lab_pty "s" harness install --defaults > "$T/d4.out" 2>&1 || RC=$?
  if [ "$RC" = 0 ] && [ "$(count 'Elegí 1, 2' "$T/d4.out")" = 0 ] && [ "$(count 'integraciones prendo' "$T/d4.out")" = 0 ] \
     && [ "$(count 'paquete del stack en todos' "$T/d4.out")" = 0 ] && [ "$(cfg "sorted(d.keys())")" = "['install']" ] \
     && [ "$(cfg "(d.get('install') or {}).get('profile')")" = minimal ]; then
    ok "T4 --defaults con terminal: ninguna pregunta, sólo install.profile = minimal en tycon.json"
  else mal "T4 --defaults: rc ${RC}; tycon.json $(cfg "d"); $(grep -m3 -e 'Elegí' -e 'integraciones prendo' -e 'paquete del stack' "$T/d4.out" | tr '\n' '|')"; fi
  grep -q 'perfil: minimal (por defecto)' "$T/d4.out" && ok "T4 el plan dice que la mínima vino por defecto" || mal "T4 el plan: $(grep -m1 '^perfil' "$T/d4.out")"
  # …y sin terminal con --yes: ya no frena pidiendo el perfil
  qlab d4y || true
  RC=0; harness install --defaults --yes > "$T/d4y.out" 2>&1 < /dev/null || RC=$?
  { [ "$RC" = 0 ] && [ "$(cfg "(d.get('install') or {}).get('profile')")" = minimal ] && ! grep -q 'elegí el perfil' "$T/d4y.out"; } \
    && ok "T4 --defaults --yes sin terminal: instala la mínima sin pedir --profile" || mal "T4 --defaults --yes: rc ${RC}; $(head -n 2 "$T/d4y.out" | tr '\n' ' ')"

  # (T5) el perfil del equipo fija full y all: rige lo del equipo, nada se escribe en el archivo de la máquina
  printf '{ "install": { "profile": "full" }, "packs": { "default": "all" } }\n' > "$T/profile-d5.json"
  qlab d5 || true; export TYCON_PROFILE="$T/profile-d5.json"
  RC=0; harness install --defaults --yes > "$T/d5.out" 2>&1 < /dev/null || RC=$?
  STP="$(python3 -c "import json,sys; print((json.load(open(sys.argv[1])).get('profile') or {}).get('value'))" "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json" 2>/dev/null)"
  { [ "$RC" = 0 ] && [ "$STP" = full ] && [ "$(cfg "(d.get('install') or {}).get('profile')")" != minimal ] && grep -q 'paquete del stack por defecto: all (perfil)' "$T/d5.out"; } \
    && ok "T5 con el perfil del equipo en full y all: rige el equipo (full, all) y la mínima no se escribe" \
    || mal "T5 perfil del equipo: rc ${RC}; estado ${STP}; tycon.json $(cfg "d"); $(grep -m1 'paquete del stack' "$T/d5.out")"
  export TYCON_PROFILE=0

  # (T6) una opción explícita gana sobre el defecto
  qlab d6 || true
  RC=0; harness install --defaults --profile full --packs all --integrations engram --yes > "$T/d6.out" 2>&1 < /dev/null || RC=$?
  { [ "$RC" = 0 ] && [ "$(cfg "(d.get('install') or {}).get('profile')")" = full ] && [ "$(cfg "(d.get('packs') or {}).get('default')")" = all ] && [ "$(cfg "(d.get('integrations') or {}).get('engram')")" = True ]; } \
    && ok "T6 --defaults --profile full --packs all --integrations engram: full, all y engram prendida" || mal "T6 opción explícita: rc ${RC}; tycon.json $(cfg "d")"

  # (T7) el clon sin --defaults pregunta el perfil como hoy
  qlab d7 || true
  RC=0; harness_lab_pty "minimal${NL}${NL}${NL}n" harness install > "$T/d7.out" 2>&1 || RC=$?
  { [ "$RC" = 0 ] && [ "$(count 'Elegí 1, 2, minimal o full' "$T/d7.out")" = 1 ] && grep -q 'no hay uno por defecto' "$T/d7.out"; } \
    && ok "T7 sin --defaults el clon pregunta el perfil como hoy" || mal "T7 sin --defaults: rc ${RC}; $(grep -m1 'perfil' "$T/d7.out")"

  # (T8) el plan corto: cinco renglones, con cómo cambiarlo y cómo sacarlo
  PC="$(node -e '
const Q = require(process.argv[1] + "/scripts/setup/harness/questions.js");
const eff = require(process.argv[1] + "/scripts/setup/install-effects.json").effects;
const L = Q.shortPlan({ effects: eff, profile: "minimal", version: "2026.10.18.1", tree: "/h/.tycon/harness", home: "/h", tools: ["claude"], integrations: [], packs: "none" });
process.stdout.write(JSON.stringify(L));' "$RAIZ" 2>&1)"
  N="$(printf '%s' "$PC" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).length)}catch(_){console.log(-1)}})')"
  if [ "$N" = 5 ] && printf '%s' "$PC" | grep 'harness.js config' >/dev/null && printf '%s' "$PC" | grep 'harness.js uninstall' >/dev/null \
     && printf '%s' "$PC" | grep '~/.tycon/harness' >/dev/null && printf '%s' "$PC" | grep 'Claude Code' >/dev/null && printf '%s' "$PC" | grep 'mínima' >/dev/null; then
    ok "T8 el plan corto de la mínima: 5 renglones, carpeta con ~, Claude Code, cómo cambiarlo y cómo sacarlo"
  else mal "T8 el plan corto: ${N} renglones; ${PC}"; fi
  printf '%s' "$PC" | grep 'índice de guías del arnés' >/dev/null && printf '%s' "$PC" | grep 'no toca git ni las reglas de cómo te contesta' >/dev/null \
    && ok "T8 la mínima de hoy: lee el índice de guías; no toca git ni las reglas de cómo contesta tu agente" || mal "T8 el renglón de lo que toca: ${PC}"

  # (T9) contado, no escrito: una mínima de juguete con un hook global de git lo dice; la completa real dice lo que toca
  PC9="$(node -e '
const Q = require(process.argv[1] + "/scripts/setup/harness/questions.js");
const eff = require(process.argv[1] + "/scripts/setup/install-effects.json").effects;
const toy = [...eff, { kind: "git-hook", when: "always", profiles: ["minimal", "full"], id: "toy", blocks: "no" }];
const a = Q.shortPlan({ effects: toy, profile: "minimal", version: "1", tree: "/h/t", home: "/h", tools: ["codex"], integrations: [], packs: "none" });
const b = Q.shortPlan({ effects: eff, profile: "full", version: "1", tree: "/h/t", home: "/h", tools: ["claude", "codex"], integrations: ["engram"], packs: "all" });
process.stdout.write(JSON.stringify({ a, b }));' "$RAIZ" 2>&1)"
  if printf '%s' "$PC9" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const {a,b}=JSON.parse(s);const ok=a.length===5&&b.length===5&&/hooks globales de git/.test(a[2])&&!/no toca git/.test(a[2])&&/hooks globales de git/.test(b[2])&&/todos tus proyectos/.test(b[2])&&/engram/.test(b[3])&&/all|todos/.test(b[3])&&/Claude Code y Codex/.test(b[0]);process.exit(ok?0:1)})' 2>/dev/null; then
    ok "T9 contado desde la lista: la mínima con un hook de git lo dice; la completa nombra hooks de git, bloques, conexiones y paquete"
  else mal "T9 el plan corto contado: ${PC9}"; fi
  # (T9) más casos: el repo del equipo, ninguna herramienta, un paquete activo con un bloque de reglas, configState
  # directo, y sin la lista de efectos el plan corto no se arma (shortPlanOf da null: se muestra el detallado)
  R9="$(node -e '
const Q = require(process.argv[1] + "/scripts/setup/harness/questions.js");
const RL = require(process.argv[1] + "/scripts/setup/harness/release.js");
const eff = require(process.argv[1] + "/scripts/setup/install-effects.json").effects;
const t = Q.shortPlan({ effects: eff, profile: "minimal", version: "1", tree: "/h/t", home: "/h", tools: [], team: "acme/equipo", integrations: [], packs: "none" });
const pk = Q.shortPlan({ effects: [...eff, { kind: "block", id_pattern: "^TYCON_BLOCK:packs/x$", when: "always", profiles: ["minimal"] }], profile: "minimal", version: "1", tree: "/h/t", home: "/h", tools: ["claude"], integrations: [], packs: "bizuit" });
const cs = Q.configState({ valores: { integraciones: { engram: true, codex: "detect" }, packs: { default: "all" } }, origenes: { "integraciones.engram": "maquina", "packs.default": "perfil" } }, { "integraciones.clockify": { value: true, via: "--integrations" } }, ["clockify", "engram", "codex", "codegraph"]);
const H = { profileOf: () => ({ ok: false, reason: "rota" }) };
const sinLista = RL.shortPlanOf({ opts: {}, home: "/h" }, H, "/no/existe", { version: "1", tree: "/h/t", tools: ["claude"], team: null, asked: {} });
const sinPerfil = RL.shortPlanOf({ opts: {}, home: "/h" }, H, process.argv[1], { version: "1", tree: "/h/t", tools: ["claude"], team: null, asked: {} });
const ok = /con el repo del equipo acme\/equipo/.test(t[0]) && /ninguna herramienta/.test(t[0]) && /bloques? de reglas/.test(pk[2]) && /bizuit/.test(pk[3])
  && cs.on.map((x) => x.key).join() === "clockify,engram,codex" && /detect/.test(cs.on[2].text) && cs.off.join() === "codegraph" && cs.packs.value === "all"
  && sinLista === null && sinPerfil === null;
process.stdout.write(ok ? "ok" : JSON.stringify({ t, pk, cs, sinLista, sinPerfil }));' "$RAIZ" 2>&1)"
  [ "$R9" = ok ] && ok "T9 equipo, ninguna herramienta, paquete activo, configState directo; sin lista o sin perfil, el plan corto no se arma" || mal "T9 casos extra: ${R9}"
fi

# ══ UPGRADE · la oferta de la instalación completa: tres renglones contados desde la lista de efectos ═══════
if corre UPGRADE; then
  echo "8.54 · T9 UpgradeOffer_Contado"
  # la lista real: qué suma la completa (frenos, bloques, hooks globales de git), dónde rige y la orden exacta para volver;
  # una lista de juguete cuya completa no trae hooks de git no los nombra (contado, no escrito)
  U9="$(node -e '
const Q = require(process.argv[1] + "/scripts/setup/harness/questions.js");
const eff = require(process.argv[1] + "/scripts/setup/install-effects.json").effects;
const a = Q.upgradeOffer({ effects: eff, tree: "/h/.tycon/harness", home: "/h" });
const toy = eff.filter((e) => e.kind !== "git-hook");
const b = Q.upgradeOffer({ effects: toy, tree: "/h/.tycon/harness", home: "/h" });
const w = Q.upgradeOffer({ effects: eff, tree: "/h/.tycon/harness", home: "/h", shownHarness: "\"C:/Users/x/.tycon/harness/scripts/setup/harness.js\"" });
if (!(w[2].includes("node \"C:/Users/x/.tycon/harness/scripts/setup/harness.js\" install --profile minimal --yes") && !w[2].includes("~"))) { process.stdout.write(JSON.stringify({ w })); process.exit(0); }
const ok = Array.isArray(a) && a.length === 3 && /frenos?/.test(a[0]) && /bloques? de reglas/.test(a[0]) && /hooks globales de git/.test(a[0])
  && /todos tus repos/.test(a[1]) && /tu agente de código/.test(a[1])
  && /install --profile minimal --yes/.test(a[2]) && /~\/\.tycon\/harness\/scripts\/setup\/harness\.js/.test(a[2])
  && b.length === 3 && !/git/.test(b[0]) && !/todos tus repos/.test(b[1]);
process.stdout.write(ok ? "ok" : JSON.stringify({ a, b }));' "$RAIZ" 2>&1)"
  [ "$U9" = ok ] && ok "T9 la oferta: tres renglones contados (frenos, bloques, hooks de git; dónde; cómo volver); sin hooks de git en la lista, no los nombra" \
    || mal "T9 la oferta contada: ${U9}"
  # (T7, el camino del clon) la primera instalación escribe first_install fresca; volver a instalar no la cambia
  qlab u7 || true
  fi_of() { python3 -c "import json,sys; print(json.dumps(json.load(open(sys.argv[1])).get('first_install'), sort_keys=True))" "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json" 2>/dev/null; }
  RC=0; harness install --defaults --yes > "$T/u7.out" 2>&1 < /dev/null || RC=$?
  F1="$(fi_of)"
  RC2=0; harness install --profile full --yes > "$T/u7b.out" 2>&1 < /dev/null || RC2=$?
  F2="$(fi_of)"
  { [ "$RC" = 0 ] && [ "$RC2" = 0 ] && printf '%s' "$F1" | grep '"fresh": true' >/dev/null && [ "$F1" = "$F2" ]; } \
    && ok "T7 desde un clon: la primera instalación deja first_install fresca y reinstalar no la cambia" \
    || mal "T7 first_install desde el clon: rc ${RC}/${RC2}; antes ${F1}; después ${F2}"
fi

echo
if [ "$FALLOS" -eq 0 ]; then echo "harness-questions: verde"; exit 0; fi
echo "harness-questions: ${FALLOS} fallo(s)"; exit 1
