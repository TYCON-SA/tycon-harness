#!/usr/bin/env bash
# instinct-outside-tree.test.sh — el grabador de aprendizajes no escribe en un árbol que no trae su buzón (story 8.27).
#
# EL CASO (2026-10-09). El observador, el disparador del arranque y el comando de revisión creaban `inbox/instincts/`
# dentro del árbol del arnés antes de mirar nada: también por ensayar (`--dry-run`) o por listar. En un árbol que no la
# trae —una versión bajada, la copia pública— eso era una carpeta que nadie le trajo: la prueba que mide «nadie escribe
# en el árbol» fallaba siempre a la primera sobre la copia, y en un arnés instalado lo escrito se perdía al actualizar.
# Ahora se escribe en la casa de la persona (`<estado>/inbox/instincts/`), se lee en todos los lugares, y nadie crea
# una carpeta por leer. La regla vive en scripts/instincts/instinct-dirs.js; sus casos sueltos, en instinct-dirs.test.js.
#
# Qué fija (los números son los de la tabla de pruebas de la story):
#   T9   el observador en --dry-run no crea nada: ni en el árbol ni en la casa
#   T10  una corrida de verdad escribe en la casa; con buzón, en el árbol como siempre
#   T11  lo ya decidido en otro lugar no se vuelve a proponer, entra a la revisión, y el contador de un descarte
#        repetido se lee de cualquier lugar sin borrar nada fuera del lugar de escritura
#   T12  list, bulk-list, show y status ven todos los lugares y no crean nada
#   T13  approve y reject mueven el archivo dentro del lugar donde estaba
#   T14  el disparador manda el registro adonde se escribe y nunca crea inbox/ en un árbol que no la trae
#   T15  sin tycon-home.js nadie cae al árbol: el observador lo dice y sale 0, el comando de revisión sale 1
# Y de la vuelta de revisores: una carpeta que existe y no se deja leer se DICE (nunca se muestra como vacía); el
# disparador deja un registro de reserva con el motivo cuando no puede usar el suyo; la mudanza de descartados de antes
# de la 8.12 no corre en un árbol sin buzón; un borrado que falla al aprobar no pierde la decisión.
#
# Cómo corre: los guiones se COPIAN a un árbol de prueba (su raíz es ese árbol) y HOME es una carpeta de usuario de
# laboratorio, con el ambiente vacío (`env -i`). El modelo es un `claude` de mentira en el PATH: no gasta un token ni
# toca la red. Nunca escribe en el arnés ni en la carpeta de usuario real.
# Manual: bash scripts/tests/instinct-outside-tree.test.sh
set -uo pipefail
# La suite corre A PROPÓSITO con una TYCON_HOME heredada, como la tiene quien la exporta en su terminal: tycon-home.js la
# mira antes que HOME, así que un comando que no fije su ambiente (o no la saque) se iría a esa carpeta y el caso daría
# rojo. Los comandos medidos corren con `env -i`; el único que hereda el ambiente es `estado`, que la saca. (Pase
# adversarial de la story: con la variable exportada, 7 casos daban rojo falso.)
export TYCON_HOME="/una/casa/heredada/que/ningun/caso/tiene/que/usar"
TCG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fallos=0
ok()  { echo "✅ $1"; }
bad() { echo "❌ $1 — $2"; fallos=$((fallos+1)); }

LAB=$(cd "$(mktemp -d)" && pwd -P)   # la ruta real: Node resuelve el enlace del temporal y las rutas tienen que coincidir
limpiar() { pkill -9 -f "$LAB/" 2>/dev/null; chmod -R u+rwX "$LAB" 2>/dev/null; rm -rf "$LAB"; }
trap limpiar EXIT
trap 'exit 130' INT TERM HUP
con_limite() { perl -e 'alarm shift; exec @ARGV or die "no pude ejecutar $ARGV[0]\n"' "${TYCON_TEST_LIMIT_S:-60}" "$@"; }
mkdir -p "$LAB/bin" "$LAB/tmp"
ln -sf "$(command -v node)" "$LAB/bin/node"
MES=$(date -u +%Y-%m)
HOY=$(date -u +%Y%m%d)

# Un árbol de prueba con los guiones adentro. $2: buzon (trae su README.md) | sobrante (la carpeta que dejó una versión
# anterior, sin README.md) | limpio. $3 = sin-estado: no copia tycon-home.js.
arbol() {
  local A="$LAB/$1"
  mkdir -p "$A/scripts/instincts" "$A/scripts/hooks" "$A/scripts/setup/harness"
  cp "$TCG/scripts/instincts/"*.js "$A/scripts/instincts/"
  cp -R "$TCG/scripts/lib" "$A/scripts/lib"
  cp "$TCG/scripts/hooks/instinct-trigger.sh" "$A/scripts/hooks/"
  [ "${3:-}" = sin-estado ] || cp "$TCG/scripts/setup/harness/tycon-home.js" "$A/scripts/setup/harness/"
  case "${2:-limpio}" in
    buzon) mkdir -p "$A/inbox/instincts" && printf '# el buzón\n' > "$A/inbox/instincts/README.md" ;;
    sobrante) mkdir -p "$A/inbox/instincts/pending" ;;
  esac
  echo "$A"
}
# Dónde vive el estado de una carpeta de usuario: se le pregunta a tycon-home.js, no se escribe a mano. $2 = own | legacy
estado() { env -u TYCON_HOME node -e 'const TH = require(process.argv[1]); process.stdout.write(process.argv[3] === "own" ? TH.ownStateDir(process.argv[2]) : TH.legacyStateDir(process.argv[2]))' "$TCG/scripts/setup/harness/tycon-home.js" "$1" "$2"; }
# Una carpeta de usuario de laboratorio. $2: siempre (por omisión) | propia (vive en la casa propia del arnés) |
# bajada (propia, con una versión bajada). $3: el clon que declara que mantiene. Deja la carpeta en H y su casa de
# propuestas en CASA (se llama sin subshell: las dos son variables de la suite).
casa() {
  local forma="${2:-siempre}" E
  H="$LAB/$1"
  mkdir -p "$H"
  if [ "$forma" = siempre ]; then E="$(estado "$H" legacy)"; else
    E="$(estado "$H" own)"; mkdir -p "$E"
    if [ "$forma" = bajada ]; then printf '{"sources":[{"kind":"release"}]}' > "$E/harness-state.json"; else printf '{"sources":[]}' > "$E/harness-state.json"; fi
  fi
  [ -n "${3:-}" ] && { mkdir -p "$H/.tycon"; printf '{"paths":{"maintained":"%s"}}' "$3" > "$H/.tycon/config.json"; }
  CASA="$E/inbox/instincts"
}
instinto() { # $1=archivo  $2=trigger  $3..=renglones extra
  local f="$1" trig="$2"; shift 2
  mkdir -p "$(dirname "$f")"
  { echo "# Auto-generated by instinct-observer.js"; echo "trigger: \"$trig\""; echo "action: \"una acción\""; echo "project: \"Totora\""
    for extra in "$@"; do echo "$extra"; done; } > "$f"
}
hash_de() { node -e 'process.stdout.write(require("crypto").createHash("sha1").update(process.argv[1] + "::" + process.argv[2]).digest("hex").slice(0, 10))' "$1" "$2"; }
primer_nivel() { ls -A "$1" | sort | tr '\n' ' '; }
# como root los permisos no impiden leer ni borrar: los casos de «no se deja leer» no se pueden medir
ES_ROOT=0; [ "$(id -u)" = 0 ] && ES_ROOT=1
sin_inbox_en_casa() { ! find "$1" -type d -name inbox 2>/dev/null | grep -q .; }

# Las observaciones (un patrón repetido en Totora) y el modelo de mentira: propone lo de $LAB/<caso>.propuestas y revisa
# con $LAB/<caso>.revision; guarda el pedido de revisión que recibió en $LAB/<caso>.revision-recibida.txt
mkdir -p "$LAB/obs"
for i in 1 2 3 4 5; do
  echo "{\"ts\":\"${MES}-0${i}T10:00:00Z\",\"tool\":\"Bash\",\"project\":\"Totora\",\"summary\":\"grep -rn obtenerDetalle src/\",\"status\":\"ok\"}" >> "$LAB/obs/${MES}.jsonl"
done
T_NUEVA="PROPUESTA-NUEVA regenerar el cliente antes del typecheck"; A_NUEVA="correr la generación primero"
T_CUB="PROPUESTA-CUBIERTA buscar símbolos con grep"; A_CUB="usar el índice de código"
T_CUB2="PROPUESTA-CUBIERTA-OTRA leer el archivo entero antes de editar"; A_CUB2="usar el índice de código"
H_NUEVA=$(hash_de "$T_NUEVA" "$A_NUEVA"); H_CUB=$(hash_de "$T_CUB" "$A_CUB"); H_CUB2=$(hash_de "$T_CUB2" "$A_CUB2")
propuesta() { printf -- '- trigger: "%s"\n  action: "%s"\n  confidence: 0.95\n  project: "Totora"\n  candidate_index: 1\n' "$1" "$2"; }
modelo() { # $1=caso  $2=propuestas: las-dos | nueva | cubierta | dos-cubiertas   → imprime la carpeta con el claude de mentira
  local caso="$1" B="$LAB/bin-$1"
  mkdir -p "$B"; ln -sf "$(command -v node)" "$B/node"
  { echo '```yaml'
    case "$2" in las-dos|cubierta|dos-cubiertas) propuesta "$T_CUB" "$A_CUB" ;; esac
    case "$2" in dos-cubiertas) propuesta "$T_CUB2" "$A_CUB2" ;; esac
    case "$2" in las-dos|nueva) propuesta "$T_NUEVA" "$A_NUEVA" ;; esac
    echo '```'; } > "$LAB/$caso.propuestas"
  case "$2" in
    las-dos) printf '%s\n' '- p: 1' '  covered_by: "[aaaaaaaaaa] MARCA-APROBADO"' '  why: "mismo caso"' '- p: 2' '  covered_by: none' '  why: "nuevo"' ;;
    cubierta) printf '%s\n' '- p: 1' '  covered_by: "[aaaaaaaaaa] MARCA-APROBADO"' '  why: "mismo caso"' ;;
    dos-cubiertas) printf '%s\n' '- p: 1' '  covered_by: "[aaaaaaaaaa] MARCA-APROBADO"' '  why: "mismo caso"' '- p: 2' '  covered_by: "[aaaaaaaaaa] MARCA-APROBADO"' '  why: "mismo caso"' ;;
    nueva) printf '%s\n' '- p: 1' '  covered_by: none' '  why: "nuevo"' ;;
  esac > "$LAB/$caso.revision"
  cat > "$B/claude" <<STUB
#!/usr/bin/env bash
if [ "\$1" = "--version" ]; then echo "claude de mentira"; exit 0; fi
entrada=\$(cat)
if printf '%s' "\$entrada" | grep -q "You are checking proposed"; then
  printf '%s' "\$entrada" > "$LAB/$caso.revision-recibida.txt"
  cat "$LAB/$caso.revision"
else
  cat "$LAB/$caso.propuestas"
fi
exit 0
STUB
  chmod +x "$B/claude"
  echo "$B"
}
# $1=árbol $2=carpeta de usuario $3=carpeta del modelo $4..=argumentos del observador → rc en RC, registro en $LAB/<nombre del árbol>.log
observar() {
  local A="$1" H="$2" B="$3"; shift 3
  con_limite env -i HOME="$H" PATH="$B:/usr/bin:/bin" TMPDIR="$LAB/tmp" TYCON_INSTINCT_OBS_DIR="$LAB/obs" TYCON_OBSERVER_EXECUTOR=claude \
    node "$A/scripts/instincts/instinct-observer.js" --since "$MES" "$@" > /dev/null 2> "$LAB/$(basename "$A").log"; RC=$?
}
revisar() { # $1=árbol $2=carpeta de usuario $3..=argumentos de instinct-promote → salida en SAL, rc en RC
  local A="$1" H="$2"; shift 2
  SAL="$(con_limite env -i HOME="$H" PATH="$LAB/bin:/usr/bin:/bin" TMPDIR="$LAB/tmp" node "$A/scripts/instincts/instinct-promote.js" "$@" 2>&1)"; RC=$?
}
decidido_aprobado() { instinto "$1/promoted/20260910-a-aaaaaaaaaa.yaml" "MARCA-APROBADO buscar con el índice primero" "hash: aaaaaaaaaa" 'approved_at: "2026-09-10T00:00:00.000Z"'; }

# ═══ T9 · el observador en --dry-run no crea nada ════════════════════════════════════════════════════════════════
A=$(arbol t9); casa casa-t9; ANTES=$(primer_nivel "$A")
B=$(modelo t9 las-dos)
# la línea exacta de integrations-off: sin observaciones
con_limite env -i HOME="$H" PATH="$B:/usr/bin:/bin" TMPDIR="$LAB/tmp" TYCON_INSTINCT_NOTIFY=1 node "$A/scripts/instincts/instinct-observer.js" --notify --dry-run > /dev/null 2> "$LAB/t9a.log"; RC=$?
if [ "$RC" = 0 ] && [ "$(primer_nivel "$A")" = "$ANTES" ] && [ ! -e "$A/inbox" ] && sin_inbox_en_casa "$H"; then
  ok "T9 Observer_DryRun_TreeWithoutInbox_CreatesNothing — la línea de integrations-off (--notify --dry-run) sale 0 y no crea nada en el árbol ni en la casa"
else bad "T9 --notify --dry-run" "rc=$RC árbol=[$(primer_nivel "$A")] antes=[$ANTES] casa=[$(find "$H" -name inbox | head -2 | tr '\n' ' ')] $(tail -2 "$LAB/t9a.log" | tr '\n' ' ')"; fi
# con observaciones y un modelo que propone: el ensayo dice qué escribiría y tampoco crea nada
observar "$A" "$H" "$B" --dry-run
if [ "$RC" = 0 ] && grep -qF "[dry-run] Would write: $T_NUEVA" "$LAB/t9.log" && [ "$(primer_nivel "$A")" = "$ANTES" ] && sin_inbox_en_casa "$H"; then
  ok "T9 con propuestas del modelo, --dry-run dice qué escribiría y no crea nada"
else bad "T9 --dry-run con propuestas" "rc=$RC árbol=[$(primer_nivel "$A")] casa=[$(find "$H" -name inbox | head -2 | tr '\n' ' ')] $(tail -3 "$LAB/t9.log" | tr '\n' ' ')"; fi

# ═══ T10 · una corrida de verdad escribe en la casa; con buzón, en el árbol ═════════════════════════════════════
for forma in siempre propia; do
  A=$(arbol "t10-$forma"); casa "casa-t10-$forma" "$forma"; B=$(modelo "t10-$forma" las-dos)
  decidido_aprobado "$CASA"
  observar "$A" "$H" "$B"
  if [ "$RC" = 0 ] && grep -qF "trigger: \"$T_NUEVA\"" "$CASA/pending/"*"-$H_NUEVA.yaml" 2>/dev/null \
    && grep -qF 'cubierto_por: "aaaaaaaaaa"' "$CASA/descartados/"*"-$H_CUB.yaml" 2>/dev/null \
    && [ ! -e "$A/inbox" ] && ! ls "$CASA/pending/"*"-$H_CUB.yaml" > /dev/null 2>&1; then
    ok "T10 Observer_RealRun_TreeWithoutInbox_WritesInPersonState — estado «${forma}»: la propuesta y el descarte en la casa, el árbol sin inbox/"
  else bad "T10 estado $forma" "rc=$RC casa=[$(ls "$CASA" "$CASA/pending" "$CASA/descartados" 2>&1 | tr '\n' ' ')] árbol=[$(primer_nivel "$A")] $(tail -3 "$LAB/t10-$forma.log" | tr '\n' ' ')"; fi
  # el resumen de descartadas de `list`, con UN lugar: nombra la carpeta real (la de la casa), no una del árbol
  revisar "$A" "$H" list
  if [ "$RC" = 0 ] && echo "$SAL" | grep -qF "1 propuesta(s) que la revisión del observer descartó" \
    && echo "$SAL" | grep -qF "movela de $CASA/descartados/ a $CASA/pending/" && [ ! -e "$A/inbox" ]; then
    ok "T10 estado «${forma}»: list resume la descartada y dice de qué carpeta a cuál moverla (las de la casa)"
  else bad "T10 resumen de descartadas, un lugar ($forma)" "rc=$RC $(echo "$SAL" | tail -3 | tr '\n' '|' | cut -c1-400)"; fi
done
A=$(arbol t10-buzon buzon); casa casa-t10-buzon; B=$(modelo t10-buzon las-dos)
decidido_aprobado "$A/inbox/instincts"
observar "$A" "$H" "$B"
if [ "$RC" = 0 ] && ls "$A/inbox/instincts/pending/"*"-$H_NUEVA.yaml" > /dev/null 2>&1 && ls "$A/inbox/instincts/descartados/"*"-$H_CUB.yaml" > /dev/null 2>&1 && sin_inbox_en_casa "$H"; then
  ok "T10 con buzón: la propuesta y el descarte en el árbol, como siempre, y la casa no se crea"
else bad "T10 con buzón" "rc=$RC árbol=[$(ls "$A/inbox/instincts" "$A/inbox/instincts/pending" 2>&1 | tr '\n' ' ')] casa=[$(find "$H" -name inbox | head -2 | tr '\n' ' ')]"; fi

# ═══ T11 · lo decidido en otro lugar ════════════════════════════════════════════════════════════════════════════
# (a) el hash que el modelo propone ya está rechazado en el buzón que dejó una versión anterior en el árbol
A=$(arbol t11a sobrante); casa casa-t11a; B=$(modelo t11a nueva)
instinto "$A/inbox/instincts/archived/20260901-x-$H_NUEVA.yaml" "$T_NUEVA" "hash: $H_NUEVA" 'rejected_at: "2026-09-01T00:00:00.000Z"'
observar "$A" "$H" "$B"
if [ "$RC" = 0 ] && grep -qF "already exists ($H_NUEVA)" "$LAB/t11a.log" && ! ls "$CASA/pending/"*.yaml > /dev/null 2>&1; then
  ok "T11 Observer_KnowsWhatWasDecidedElsewhere — (a) lo rechazado en el buzón sobrante del árbol no se vuelve a proponer"
else bad "T11 (a) rechazado en el árbol" "rc=$RC $(grep -c 'already exists' "$LAB/t11a.log") casa=[$(ls "$CASA/pending" 2>&1 | tr '\n' ' ')]"; fi
# (b) aprobado en el clon que la máquina declara que mantiene
CLON=$(arbol t11-clon buzon)
instinto "$CLON/inbox/instincts/promoted/20260902-y-$H_NUEVA.yaml" "$T_NUEVA" "hash: $H_NUEVA" 'approved_at: "2026-09-02T00:00:00.000Z"'
decidido_aprobado "$CLON/inbox/instincts"
A=$(arbol t11b); casa casa-t11b bajada "$CLON"; B=$(modelo t11b nueva)
observar "$A" "$H" "$B"
if [ "$RC" = 0 ] && grep -qF "already exists ($H_NUEVA)" "$LAB/t11b.log" && ! ls "$CASA/pending/"*.yaml > /dev/null 2>&1; then
  ok "T11 (b) lo aprobado en el clon mantenido no se vuelve a proponer"
else bad "T11 (b) aprobado en el clon" "rc=$RC $(tail -3 "$LAB/t11b.log" | tr '\n' ' ')"; fi
# (c) otro hash, que la revisión descarta citando un decidido que SÓLO está en el clon
A=$(arbol t11c); casa casa-t11c bajada "$CLON"; B=$(modelo t11c cubierta)
observar "$A" "$H" "$B"
if [ "$RC" = 0 ] && grep -qF "MARCA-APROBADO" "$LAB/t11c.revision-recibida.txt" 2>/dev/null \
  && grep -qF 'cubierto_por: "aaaaaaaaaa"' "$CASA/descartados/"*"-$H_CUB.yaml" 2>/dev/null && ! ls "$CASA/pending/"*.yaml > /dev/null 2>&1 \
  && ! ls "$CLON/inbox/instincts/descartados" > /dev/null 2>&1; then
  ok "T11 (c) lo decidido en el clon entra a la revisión: la cita se acepta, el descarte queda en la casa y el clon no se toca"
else bad "T11 (c) decidido sólo en el clon" "rc=$RC revisión=$(grep -c MARCA-APROBADO "$LAB/t11c.revision-recibida.txt" 2>/dev/null) casa=[$(ls "$CASA/pending" "$CASA/descartados" 2>&1 | tr '\n' ' ')] $(tail -3 "$LAB/t11c.log" | tr '\n' ' ')"; fi
# (d) un descarte repetido: la constancia anterior está en el buzón sobrante del árbol (3 veces)
A=$(arbol t11d sobrante); casa casa-t11d; B=$(modelo t11d cubierta)
decidido_aprobado "$CASA"
VIEJA="$A/inbox/instincts/descartados/${HOY}-vieja-$H_CUB.yaml"
instinto "$VIEJA" "$T_CUB" "hash: $H_CUB" "veces_descartada: 3"
observar "$A" "$H" "$B"
if [ "$RC" = 0 ] && grep -qF 'veces_descartada: 4' "$CASA/descartados/"*"-$H_CUB.yaml" 2>/dev/null && [ -f "$VIEJA" ] && grep -qF 'veces_descartada: 3' "$VIEJA"; then
  ok "T11 (d) el contador se lee de cualquier lugar (3 → 4), la nueva queda en la casa y la anterior sigue donde estaba"
else bad "T11 (d) contador entre lugares" "rc=$RC casa=[$(grep -h veces_descartada "$CASA/descartados/"*.yaml 2>&1 | tr '\n' ' ')] vieja=$([ -f "$VIEJA" ] && echo está || echo borrada)"; fi
# y en el lugar de escritura la constancia anterior SÍ se reemplaza: una sola por propuesta
observar "$A" "$H" "$B"
if [ "$(ls "$CASA/descartados/"*"-$H_CUB.yaml" 2>/dev/null | wc -l | tr -d ' ')" = 1 ] && grep -qF 'veces_descartada: 5' "$CASA/descartados/"*"-$H_CUB.yaml"; then
  ok "T11 (d) en el lugar de escritura queda una sola constancia por propuesta (4 → 5)"
else bad "T11 (d) una sola en la casa" "$(ls "$CASA/descartados" 2>&1 | tr '\n' ' ') $(grep -h veces_descartada "$CASA/descartados/"*.yaml 2>&1 | tr '\n' ' ')"; fi
# el resumen de `list` con descartadas en DOS lugares: la propuesta una vez, con el mayor contador, y las dos carpetas
revisar "$A" "$H" list
if [ "$RC" = 0 ] && echo "$SAL" | grep -qF "1 propuesta(s) que la revisión del observer descartó" && echo "$SAL" | grep -qF "(descartada 5 veces)" \
  && [ "$(echo "$SAL" | grep -F "Están en:" | grep -o "inbox/instincts/descartados/" | wc -l | tr -d ' ')" = 2 ] \
  && echo "$SAL" | grep -F "Están en:" | grep -qF "$CASA/descartados/" && echo "$SAL" | grep -F "Están en:" | grep -qE '(: |, )inbox/instincts/descartados/'; then
  ok "T11 (d) list resume la descartada una vez (5 veces) aunque su constancia esté en dos lugares, y nombra las dos carpetas"
else bad "T11 (d) resumen con dos lugares" "rc=$RC $(echo "$SAL" | tail -4 | tr '\n' '|' | cut -c1-500)"; fi
# (e) un lugar de lectura cuya carpeta de descartados existe y no se deja leer: el observador lo DICE y sigue
if [ "$ES_ROOT" = 1 ]; then echo "⏭️  T11 (e) descartados ilegible: NO MEDIDO — como root los permisos no impiden leer"; else
  A=$(arbol t11e sobrante); casa casa-t11e; B=$(modelo t11e dos-cubiertas)
  decidido_aprobado "$CASA"
  mkdir -p "$A/inbox/instincts/descartados"; chmod 000 "$A/inbox/instincts/descartados"
  observar "$A" "$H" "$B"
  chmod 755 "$A/inbox/instincts/descartados"
  if [ "$RC" = 0 ] && grep -F "no pude leer inbox/instincts/descartados" "$LAB/t11e.log" | grep -qF "contador" \
    && [ "$(grep -c "no pude leer inbox/instincts/descartados" "$LAB/t11e.log")" = 1 ] \
    && grep -qF 'veces_descartada: 1' "$CASA/descartados/"*"-$H_CUB.yaml" 2>/dev/null && ls "$CASA/descartados/"*"-$H_CUB2.yaml" > /dev/null 2>&1 && grep -qF "Done." "$LAB/t11e.log"; then
    ok "T11 (e) con descartados ilegible en un lugar de lectura el observador no se cae: lo dice UNA vez aunque descarte dos propuestas (el contador puede quedar corto) y deja las dos constancias en la casa"
  else bad "T11 (e) descartados ilegible" "rc=$RC $(grep -c 'no pude leer' "$LAB/t11e.log") $(tail -3 "$LAB/t11e.log" | tr '\n' ' ' | cut -c1-300)"; fi
fi
# (g) lo ya DECIDIDO en un lugar de lectura que existe y no se deja leer: el observador lo dice (puede volver a proponerse)
if [ "$ES_ROOT" = 1 ]; then echo "⏭️  T11 (g) decididos ilegibles: NO MEDIDO — como root los permisos no impiden leer"; else
  A=$(arbol t11g sobrante); casa casa-t11g; B=$(modelo t11g nueva)
  instinto "$A/inbox/instincts/promoted/20260902-y-$H_NUEVA.yaml" "$T_NUEVA" "hash: $H_NUEVA"
  chmod 000 "$A/inbox/instincts/promoted"
  observar "$A" "$H" "$B"
  chmod 755 "$A/inbox/instincts/promoted"
  if [ "$RC" = 0 ] && grep -F "no pude leer inbox/instincts/promoted" "$LAB/t11g.log" | grep -qF "puede volver a proponerse" \
    && [ "$(grep -c "no pude leer inbox/instincts/promoted" "$LAB/t11g.log")" = 1 ] && ls "$CASA/pending/"*"-$H_NUEVA.yaml" > /dev/null 2>&1; then
    ok "T11 (g) con las aprobadas de un lugar de lectura ilegibles, el observador lo dice una vez (puede volver a proponerse) y sigue"
  else bad "T11 (g) decididos ilegibles" "rc=$RC avisos=$(grep -c 'no pude leer' "$LAB/t11g.log") $(tail -3 "$LAB/t11g.log" | tr '\n' ' ' | cut -c1-300)"; fi
fi
# (h) un lugar entero sin mirar (la configuración de la máquina, rota): el observador lo anota antes de proponer
A=$(arbol t11h); casa casa-t11h bajada; printf '{ esto no es JSON' > "$H/.tycon/config.json"; B=$(modelo t11h nueva)
observar "$A" "$H" "$B"
if [ "$RC" = 0 ] && grep -F "no es JSON válido" "$LAB/t11h.log" | grep -qF "puede volver a proponerse" && ls "$CASA/pending/"*"-$H_NUEVA.yaml" > /dev/null 2>&1; then
  ok "T11 (h) con la configuración de la máquina rota, el observador anota que el clon que mantiene no se lee, y sigue"
else bad "T11 (h) configuración rota" "rc=$RC $(tail -3 "$LAB/t11h.log" | tr '\n' ' ' | cut -c1-300)"; fi
# (f) la mudanza de descartados de antes de la 8.12 no corre en un árbol que no trae su buzón: nada pasa a inbox/
V_CARPETA=""
[ -f "$TCG/scripts/lib/renames.json" ] && V_CARPETA=$(node -e '
  const l = require(process.argv[1]);
  const e = l.usableEntries(l.loadMap()).find((x) => x.kind === "folder" && x.new === "inbox/instincts");
  process.stdout.write(e ? e.old : "");' "$TCG/scripts/lib/legacy-names.js" 2>/dev/null)
if [ -z "$V_CARPETA" ]; then echo "⏭️  T11 (f) la mudanza de descartados sin buzón: NO MEDIDO — copia pública sin el mapa de renombres"; else
  A=$(arbol t11f); casa casa-t11f; B=$(modelo t11f nueva)
  instinto "$A/$V_CARPETA/descartados/20260901-v-9a9a9a9a9a.yaml" "DESCARTE-DE-ANTES" "hash: 9a9a9a9a9a" "veces_descartada: 2"
  observar "$A" "$H" "$B"; RC_O=$RC
  revisar "$A" "$H" list
  if [ "$RC_O" = 0 ] && [ "$RC" = 0 ] && [ ! -e "$A/inbox" ] && [ -f "$A/$V_CARPETA/descartados/20260901-v-9a9a9a9a9a.yaml" ] \
    && ! ls "$CASA/descartados/"*9a9a9a9a9a* > /dev/null 2>&1 && ! grep -qF "Llevé" "$LAB/t11f.log"; then
    ok "T11 (f) sin buzón, la mudanza de descartados de antes de la 8.12 no corre (ni con el observador ni con list): el árbol no gana inbox/ y lo viejo queda donde estaba"
  else bad "T11 (f) mudanza sin buzón" "rc=$RC_O/$RC árbol=[$(primer_nivel "$A")] $(grep -c Llevé "$LAB/t11f.log")"; fi
fi

# ═══ T12 · list, bulk-list, show y status ven todos los lugares y no crean nada ═════════════════════════════════
A=$(arbol t12 sobrante); casa casa-t12 bajada
instinto "$A/inbox/instincts/pending/20261001-arbol-b1b1b1b1b1.yaml" "MARCA-DEL-ARBOL" "hash: b1b1b1b1b1" "confidence: 0.9"
instinto "$CASA/pending/20261002-casa-c2c2c2c2c2.yaml" "MARCA-DE-LA-CASA" "hash: c2c2c2c2c2" "confidence: 0.9"
instinto "$CASA/pending/20261003-rep-d3d3d3d3d3.yaml" "MARCA-REPETIDA" "hash: d3d3d3d3d3" "confidence: 0.9"
instinto "$A/inbox/instincts/pending/20261003-rep-d3d3d3d3d3.yaml" "MARCA-REPETIDA" "hash: d3d3d3d3d3" "confidence: 0.9"
revisar "$A" "$H" list; LISTA="$SAL"; RC_L=$RC
revisar "$A" "$H" bulk-list; BULK="$SAL"
if [ "$RC_L" = 0 ] && echo "$LISTA" | grep -qF "MARCA-DEL-ARBOL" && echo "$LISTA" | grep -qF "MARCA-DE-LA-CASA" \
  && [ "$(echo "$LISTA" | grep -c 'trigger: MARCA-REPETIDA')" = 1 ] && echo "$LISTA" | grep -qF "también en inbox/instincts" \
  && echo "$LISTA" | grep -qF "$CASA" && echo "$LISTA" | grep -qF "3 instincts pending" \
  && [ "$(echo "$BULK" | grep -c .)" = 3 ] && [ "$(echo "$BULK" | grep -c d3d3d3d3d3)" = 1 ]; then
  ok "T12 Promote_ListShowStatus_AllPlaces_CreateNothing — list y bulk-list traen lo del árbol y lo de la casa, el hash repetido una vez con su nota, y dicen de qué lugar es cada grupo"
else bad "T12 list en todos los lugares" "rc=$RC_L $(echo "$LISTA" | head -14 | tr '\n' '|' | cut -c1-500) bulk=$(echo "$BULK" | tr '\n' '|')"; fi
revisar "$A" "$H" show b1b1b1b1b1; S1="$SAL"; R1=$RC
revisar "$A" "$H" show c2c2c2c2c2; S2="$SAL"; R2=$RC
if [ "$R1" = 0 ] && [ "$R2" = 0 ] && echo "$S1" | grep -qF "# File: $A/inbox/instincts/pending/20261001-arbol-b1b1b1b1b1.yaml" && echo "$S2" | grep -qF "# File: $CASA/pending/20261002-casa-c2c2c2c2c2.yaml"; then
  ok "T12 show encuentra la del árbol y la de la casa e imprime la ruta de cada una"
else bad "T12 show" "rc=$R1/$R2 $(echo "$S1" | head -1) · $(echo "$S2" | head -1)"; fi
# show también encuentra lo decidido y lo descartado, en cualquiera de los lugares
instinto "$A/inbox/instincts/promoted/20260920-ap-e5e5e5e5e5.yaml" "MARCA-APROBADA-EN-EL-ARBOL" "hash: e5e5e5e5e5"
instinto "$CASA/archived/20260921-re-f6f6f6f6f6.yaml" "MARCA-RECHAZADA-EN-LA-CASA" "hash: f6f6f6f6f6"
instinto "$A/inbox/instincts/descartados/20260922-de-a7a7a7a7a7.yaml" "MARCA-DESCARTADA-EN-EL-ARBOL" "hash: a7a7a7a7a7"
OKS=0
for par in "e5e5e5e5e5|$A/inbox/instincts/promoted/20260920-ap-e5e5e5e5e5.yaml" "f6f6f6f6f6|$CASA/archived/20260921-re-f6f6f6f6f6.yaml" "a7a7a7a7a7|$A/inbox/instincts/descartados/20260922-de-a7a7a7a7a7.yaml"; do
  revisar "$A" "$H" show "${par%%|*}"
  [ "$RC" = 0 ] && echo "$SAL" | grep -qF "# File: ${par#*|}" && OKS=$((OKS+1))
done
[ "$OKS" = 3 ] && ok "T12 show encuentra una aprobada y una descartada del árbol y una rechazada de la casa" \
  || bad "T12 show en los demás estados" "encontró $OKS de 3"
rm -f "$A/inbox/instincts/promoted/"*.yaml "$CASA/archived/"*.yaml "$A/inbox/instincts/descartados/"*.yaml
revisar "$A" "$H" status
if [ "$RC" = 0 ] && echo "$SAL" | grep -F "$CASA" | grep -qE '^\* .*pending 2 · promoted 0 · archived 0 · drafts 0 · descartados 0.*acá se escribe' \
  && echo "$SAL" | grep -F "inbox/instincts — " | grep -v "$CASA" | grep -qE '^  .*pending 2 ' && echo "$SAL" | grep -qF "paths.maintained"; then
  ok "T12 status: una línea por lugar con sus cuentas, el de escritura marcado, y dice que la versión bajada no declara el clon que mantiene"
else bad "T12 status" "rc=$RC $(echo "$SAL" | tr '\n' '|' | cut -c1-500)"; fi
# una carpeta de pendientes que EXISTE y no se deja leer no es «no hay pendientes»: list lo dice y status pone «?»
if [ "$ES_ROOT" = 1 ]; then echo "⏭️  T12 carpeta ilegible: NO MEDIDO — como root los permisos no impiden leer"; else
  chmod 000 "$A/inbox/instincts/pending"
  revisar "$A" "$H" list; L_SAL="$SAL"; L_RC=$RC
  revisar "$A" "$H" status
  chmod 755 "$A/inbox/instincts/pending"
  if [ "$L_RC" = 0 ] && echo "$L_SAL" | grep -qF "no pude leer inbox/instincts/pending" && echo "$L_SAL" | grep -qF "MARCA-DE-LA-CASA" \
    && [ "$RC" = 0 ] && echo "$SAL" | grep -F "inbox/instincts — " | grep -v "$CASA" | grep -qF "pending ? ·" && echo "$SAL" | grep -qF "? = esa carpeta existe y no la pude leer"; then
    ok "T12 una carpeta de pendientes ilegible se dice: list avisa (y muestra lo de la casa) y status pone «?» en vez de 0"
  else bad "T12 carpeta ilegible" "list rc=$L_RC [$(echo "$L_SAL" | grep -c 'no pude leer')] status=[$(echo "$SAL" | tr '\n' '|' | cut -c1-400)]"; fi
  # lo mismo para los demás comandos que leen: show y approve avisan y dicen «no encontrado», sin traza; y el resumen
  # de descartadas de list avisa su carpeta ilegible
  mkdir -p "$A/inbox/instincts/descartados"; chmod 000 "$A/inbox/instincts/pending" "$A/inbox/instincts/descartados"
  revisar "$A" "$H" show b1b1b1b1b1; S_SAL="$SAL"; S_RC=$RC
  revisar "$A" "$H" approve b1b1b1b1b1; A_SAL="$SAL"; A_RC=$RC
  revisar "$A" "$H" list
  chmod 755 "$A/inbox/instincts/pending" "$A/inbox/instincts/descartados"; rmdir "$A/inbox/instincts/descartados"
  if [ "$S_RC" = 1 ] && echo "$S_SAL" | grep -qF "no pude leer inbox/instincts/pending" && echo "$S_SAL" | grep -qF "no encontrado" && ! echo "$S_SAL" | grep -qE '^\s+at ' \
    && [ "$A_RC" = 1 ] && echo "$A_SAL" | grep -qF "no pude leer inbox/instincts/pending" && ! echo "$A_SAL" | grep -qE '^\s+at ' \
    && [ -f "$A/inbox/instincts/pending/20261001-arbol-b1b1b1b1b1.yaml" ] && echo "$SAL" | grep -qF "no pude leer inbox/instincts/descartados"; then
    ok "T12 show y approve sobre una carpeta ilegible avisan y dicen «no encontrado» (sin traza, sin tocar nada), y list avisa los descartados ilegibles"
  else bad "T12 show/approve/resumen con carpeta ilegible" "show rc=$S_RC [$(echo "$S_SAL" | head -2 | tr '\n' '|')] approve rc=$A_RC [$(echo "$A_SAL" | head -2 | tr '\n' '|')] list=[$(echo "$SAL" | grep -c 'descartados')]"; fi
fi
# status dice por qué NO lee el clon que la máquina declara: no existe, no trae buzón, o la configuración está rota
CLON_SIN=$(arbol t12-clon-sin-buzon sobrante)
for caso in "no-existe|$LAB/un-clon-que-no-esta|esa carpeta no existe" "sin-buzon|$CLON_SIN|no trae su buzón"; do
  nombre="${caso%%|*}"; resto="${caso#*|}"
  A2=$(arbol "t12-nota-$nombre"); casa "casa-t12-nota-$nombre" bajada "${resto%%|*}"
  revisar "$A2" "$H" status
  if [ "$RC" = 0 ] && echo "$SAL" | grep -F "! " | grep -qF "${resto#*|}" && ! echo "$SAL" | grep -qF "no declara el clon" && [ "$(echo "$SAL" | grep -c ' — pending ')" = 1 ]; then
    ok "T12 status, clon declarado que $nombre: no lo suma y dice por qué"
  else bad "T12 status, clon $nombre" "rc=$RC $(echo "$SAL" | tr '\n' '|' | cut -c1-400)"; fi
done
A2=$(arbol t12-nota-rota); casa casa-t12-nota-rota bajada; printf '{ esto no es JSON' > "$H/.tycon/config.json"
revisar "$A2" "$H" status; S_SAL="$SAL"; S_RC=$RC
revisar "$A2" "$H" list
if [ "$S_RC" = 0 ] && echo "$S_SAL" | grep -F "! " | grep -qF "no es JSON válido" && ! echo "$S_SAL" | grep -qF "no declara el clon" \
  && [ "$RC" = 0 ] && echo "$SAL" | grep -qF "no es JSON válido" && echo "$SAL" | grep -qF "No hay instincts pending."; then
  ok "T12 con la configuración rota, status y list lo dicen (no «no declara el clon», ni «no hay pendientes» a secas)"
else bad "T12 configuración rota" "status rc=$S_RC [$(echo "$S_SAL" | tr '\n' '|' | cut -c1-300)] list=[$(echo "$SAL" | tr '\n' '|' | cut -c1-200)]"; fi
# con todo vacío, ninguno crea nada
A=$(arbol t12-vacio); casa casa-t12-vacio; ANTES=$(primer_nivel "$A")
RCS=""
for cmd in list bulk-list status "show ffffffffff"; do
  # shellcheck disable=SC2086
  revisar "$A" "$H" $cmd; RCS="$RCS$RC"
done
if [ "$RCS" = 0001 ] && [ "$(primer_nivel "$A")" = "$ANTES" ] && sin_inbox_en_casa "$H"; then
  ok "T12 con todo vacío, list, bulk-list, status y show no crean ninguna carpeta (árbol y casa iguales)"
else bad "T12 nada creado por leer" "rcs=$RCS árbol=[$(primer_nivel "$A")] casa=[$(find "$H" -name inbox | head -2 | tr '\n' ' ')]"; fi

# ═══ T13 · approve y reject mueven dentro del lugar donde estaba ════════════════════════════════════════════════
CLON=$(arbol t13-clon buzon)
A=$(arbol t13 sobrante); casa casa-t13 bajada "$CLON"
instinto "$CASA/pending/20261002-casa-c2c2c2c2c2.yaml" "MARCA-DE-LA-CASA" "hash: c2c2c2c2c2" "confidence: 0.95" "engram_promoted: false" 'tycon_artifact_suggestion: "advisor:NOEXISTE-C1"'
instinto "$A/inbox/instincts/pending/20261001-arbol-b1b1b1b1b1.yaml" "MARCA-DEL-ARBOL" "hash: b1b1b1b1b1"
instinto "$CLON/inbox/instincts/pending/20261004-clon-e4e4e4e4e4.yaml" "MARCA-DEL-CLON" "hash: e4e4e4e4e4" "engram_promoted: false"
instinto "$CASA/pending/20261003-rep-d3d3d3d3d3.yaml" "MARCA-REPETIDA" "hash: d3d3d3d3d3" "engram_promoted: false"
instinto "$A/inbox/instincts/pending/20261003-rep-d3d3d3d3d3.yaml" "MARCA-REPETIDA" "hash: d3d3d3d3d3" "engram_promoted: false"
revisar "$A" "$H" approve c2c2c2c2c2; AP="$SAL"; R_AP=$RC
if [ "$R_AP" = 0 ] && [ -f "$CASA/promoted/20261002-casa-c2c2c2c2c2.yaml" ] && [ ! -e "$CASA/pending/20261002-casa-c2c2c2c2c2.yaml" ] \
  && [ -f "$CASA/drafts/c2c2c2c2c2-advisor-noexiste-c1.md" ] && echo "$AP" | grep -qF "Archivo: $CASA/drafts/c2c2c2c2c2-advisor-noexiste-c1.md" \
  && ! echo "$AP" | grep -qi "commite" && [ ! -e "$A/inbox/instincts/promoted" ] && [ ! -e "$A/inbox/instincts/drafts" ]; then
  ok "T13 Promote_ApproveReject_StayInTheirPlace — aprobar la de la casa la mueve dentro de la casa; el borrador nace ahí, con su ruta completa y sin el consejo de commitear"
else bad "T13 approve en la casa" "rc=$R_AP casa=[$(ls "$CASA" "$CASA/promoted" "$CASA/drafts" 2>&1 | tr '\n' ' ')] $(echo "$AP" | grep -i 'archivo\|commit' | tr '\n' '|')"; fi
revisar "$A" "$H" reject b1b1b1b1b1 --reason "prueba"; R_RE=$RC
revisar "$A" "$H" approve e4e4e4e4e4; R_CL=$RC
if [ "$R_RE" = 0 ] && [ -f "$A/inbox/instincts/archived/20261001-arbol-b1b1b1b1b1.yaml" ] && [ ! -e "$CASA/archived" ] \
  && [ "$R_CL" = 0 ] && [ -f "$CLON/inbox/instincts/promoted/20261004-clon-e4e4e4e4e4.yaml" ] && [ ! -e "$CASA/promoted/20261004-clon-e4e4e4e4e4.yaml" ]; then
  ok "T13 rechazar la del árbol la deja en el árbol, y aprobar la del clon mantenido la deja en el clon"
else bad "T13 reject en el árbol / approve en el clon" "rc=$R_RE/$R_CL árbol=[$(ls "$A/inbox/instincts" 2>&1 | tr '\n' ' ')] clon=[$(ls "$CLON/inbox/instincts" "$CLON/inbox/instincts/promoted" 2>&1 | tr '\n' ' ')]"; fi
revisar "$A" "$H" approve d3d3d3d3d3
if [ "$RC" = 0 ] && [ -f "$CASA/promoted/20261003-rep-d3d3d3d3d3.yaml" ] && [ -f "$A/inbox/instincts/pending/20261003-rep-d3d3d3d3d3.yaml" ] \
  && echo "$SAL" | grep -F "otra copia" | grep -qF "inbox/instincts/pending/20261003-rep-d3d3d3d3d3.yaml"; then
  ok "T13 el mismo hash en dos lugares: actúa sobre el primero (el de escritura) y dice dónde quedó la otra copia"
else bad "T13 hash repetido" "rc=$RC $(echo "$SAL" | grep -i 'copia' | head -2 | tr '\n' '|') casa=[$(ls "$CASA/promoted" 2>&1 | tr '\n' ' ')]"; fi

# si la pendiente no se puede borrar después de escribir la decisión, la decisión no se pierde: se dice y se sigue
if [ "$ES_ROOT" = 1 ]; then echo "⏭️  T13 borrado que falla: NO MEDIDO — como root los permisos no impiden borrar"; else
  A=$(arbol t13-borrado); casa casa-t13-borrado
  instinto "$CASA/pending/20261005-bo-b8b8b8b8b8.yaml" "MARCA-SIN-BORRAR" "hash: b8b8b8b8b8" "engram_promoted: false"
  mkdir -p "$CASA/promoted"; chmod 555 "$CASA/pending"
  revisar "$A" "$H" approve b8b8b8b8b8
  chmod 755 "$CASA/pending"
  if [ "$RC" = 0 ] && [ -f "$CASA/promoted/20261005-bo-b8b8b8b8b8.yaml" ] && echo "$SAL" | grep -qF "no pude borrar" \
    && echo "$SAL" | grep -qF "Borrala a mano" && echo "$SAL" | grep -qF 'topic_key: "instinct-b8b8b8b8b8"' && ! echo "$SAL" | grep -qE '^\s+at '; then
    ok "T13 si la pendiente no se puede borrar, la aprobación queda escrita, se dice y la memoria a guardar sale igual (sin traza)"
  else bad "T13 borrado que falla" "rc=$RC $(echo "$SAL" | head -6 | tr '\n' '|' | cut -c1-400)"; fi
  # y lo mismo al rechazar
  instinto "$CASA/pending/20261006-re-c9c9c9c9c9.yaml" "MARCA-SIN-BORRAR-AL-RECHAZAR" "hash: c9c9c9c9c9"
  mkdir -p "$CASA/archived"; chmod 555 "$CASA/pending"
  revisar "$A" "$H" reject c9c9c9c9c9 --reason "prueba"
  chmod 755 "$CASA/pending"
  if [ "$RC" = 0 ] && grep -qF 'rejection_reason: "prueba"' "$CASA/archived/20261006-re-c9c9c9c9c9.yaml" 2>/dev/null && echo "$SAL" | grep -qF "no pude borrar" \
    && echo "$SAL" | grep -qF "Borrala a mano" && ! echo "$SAL" | grep -qE '^\s+at '; then
    ok "T13 lo mismo al rechazar: el rechazo queda escrito con su motivo, y se dice que la pendiente no se pudo borrar"
  else bad "T13 borrado que falla al rechazar" "rc=$RC $(echo "$SAL" | head -4 | tr '\n' '|' | cut -c1-300)"; fi
fi

# ═══ T14 · el disparador manda el registro adonde se escribe ════════════════════════════════════════════════════
observador_de_mentira() { cat > "$1/scripts/instincts/instinct-observer.js" <<'EOF'
require('fs').writeFileSync(require('path').join(__dirname, '..', '..', 'corrio.txt'), process.argv.slice(2).join(' '));
console.log('LINEA-DEL-OBSERVADOR');
EOF
}
disparar() { con_limite env -i HOME="$2" PATH="$LAB/bin:/usr/bin:/bin" TMPDIR="$LAB/tmp" TYCON_INSTINCT_OBSERVER=1 TYCON_NO_BOOTSTRAP_HEAL=1 bash "$1/scripts/hooks/instinct-trigger.sh" < /dev/null > /dev/null 2>&1; RC=$?; }
esperar() { for _ in $(seq 1 100); do grep -qF -- "$2" "$1" 2>/dev/null && return 0; sleep 0.1; done; return 1; }
A=$(arbol t14); casa casa-t14; observador_de_mentira "$A"
disparar "$A" "$H"; esperar "$CASA/observer.log" LINEA-DEL-OBSERVADOR; esperar "$A/corrio.txt" "--notify"
if [ "$RC" = 0 ] && grep -qF LINEA-DEL-OBSERVADOR "$CASA/observer.log" 2>/dev/null && [ "$(cat "$A/corrio.txt" 2>/dev/null)" = "--notify" ] && [ ! -e "$A/inbox" ] \
  && [ ! -e "$H/.claude/instinct-observer.fallback.log" ]; then
  ok "T14 Trigger_LogGoesWhereItWrites — árbol sin buzón: el registro del observador queda en la casa y el árbol no gana inbox/"
else bad "T14 sin buzón" "rc=$RC casa=[$(ls "$CASA" 2>&1 | tr '\n' ' ')] árbol=[$(primer_nivel "$A")]"; fi
A=$(arbol t14-buzon buzon); casa casa-t14-buzon; observador_de_mentira "$A"
disparar "$A" "$H"; esperar "$A/inbox/instincts/observer.log" LINEA-DEL-OBSERVADOR
if [ "$RC" = 0 ] && grep -qF LINEA-DEL-OBSERVADOR "$A/inbox/instincts/observer.log" 2>/dev/null && sin_inbox_en_casa "$H" \
  && [ ! -e "$H/.claude/instinct-observer.fallback.log" ]; then
  ok "T14 con buzón: el registro en el árbol, como siempre, y la casa no se crea"
else bad "T14 con buzón" "rc=$RC árbol=[$(ls "$A/inbox/instincts" 2>&1 | tr '\n' ' ')]"; fi
# Tres formas de no poder usar el registro: la pieza no está, la pieza sale 1 (aunque imprima algo), y la pieza da una
# ruta que bash no puede abrir (una carpeta). En las tres el observador corre igual, nada se crea en el árbol, y el
# registro va a uno de RESERVA al lado del sello, con el motivo: nunca se pierde callado.
for forma in sin-la-pieza pieza-que-falla registro-que-no-abre; do
  A=$(arbol "t14-$forma"); casa "casa-t14-$forma"; observador_de_mentira "$A"
  RESERVA="$H/.claude/instinct-observer.fallback.log"
  case "$forma" in
    sin-la-pieza) rm -f "$A/scripts/instincts/instinct-dirs.js"; MOTIVO="instinct-dirs.js" ;;
    pieza-que-falla) printf 'process.stderr.write("MOTIVO-DE-LA-PIEZA\\n"); process.stdout.write("una/ruta/que/no/vale\\n"); process.exit(1);\n' > "$A/scripts/instincts/instinct-dirs.js"; MOTIVO="MOTIVO-DE-LA-PIEZA" ;;
    registro-que-no-abre) mkdir -p "$LAB/soy-una-carpeta-$forma"; printf 'process.stdout.write(process.argv[1] ? %s + "\\n" : "");\n' "'$LAB/soy-una-carpeta-$forma'" > "$A/scripts/instincts/instinct-dirs.js"; MOTIVO="no pude abrir $LAB/soy-una-carpeta-$forma" ;;
  esac
  disparar "$A" "$H"; esperar "$A/corrio.txt" "--notify"; esperar "$RESERVA" LINEA-DEL-OBSERVADOR
  if [ "$RC" = 0 ] && [ "$(cat "$A/corrio.txt" 2>/dev/null)" = "--notify" ] && [ ! -e "$A/inbox" ] && [ ! -e "$A/una" ] && sin_inbox_en_casa "$H" \
    && grep -F "de reserva" "$RESERVA" 2>/dev/null | grep -qF -- "$MOTIVO" && grep -qF LINEA-DEL-OBSERVADOR "$RESERVA"; then
    ok "T14 $forma: el observador corre igual, nada se crea en el árbol, y el registro de reserva trae el motivo y lo que dijo el observador"
  else bad "T14 $forma" "rc=$RC corrió=$(cat "$A/corrio.txt" 2>/dev/null || echo no) árbol=[$(primer_nivel "$A")] reserva=[$(head -c 300 "$RESERVA" 2>&1 | tr '\n' '|')]"; fi
done
# ni el registro ni el de reserva se pueden abrir (el de reserva es una carpeta): recién ahí el registro se descarta —
# y el observador corre igual, sale 0 y nada se crea en el árbol
A=$(arbol t14-sin-reserva); casa casa-t14-sin-reserva; observador_de_mentira "$A"
rm -f "$A/scripts/instincts/instinct-dirs.js"; mkdir -p "$H/.claude/instinct-observer.fallback.log"
disparar "$A" "$H"; esperar "$A/corrio.txt" "--notify"
if [ "$RC" = 0 ] && [ "$(cat "$A/corrio.txt" 2>/dev/null)" = "--notify" ] && [ ! -e "$A/inbox" ] && sin_inbox_en_casa "$H" \
  && [ -d "$H/.claude/instinct-observer.fallback.log" ] && [ -z "$(ls -A "$H/.claude/instinct-observer.fallback.log")" ]; then
  ok "T14 sin registro y sin reserva: el observador corre igual, sale 0 y nada se crea en el árbol"
else bad "T14 sin reserva" "rc=$RC corrió=$(cat "$A/corrio.txt" 2>/dev/null || echo no) árbol=[$(primer_nivel "$A")]"; fi
# con el freno de 12 horas sin vencer no se lanza nada: ni node, ni la casa. La ausencia se mira varias veces (el
# observador corre desprendido: con la máquina cargada, una sola mirada temprana daría verde aunque después apareciera)
A=$(arbol t14-freno); casa casa-t14-freno; observador_de_mentira "$A"
mkdir -p "$H/.claude"; date +%s > "$H/.claude/instinct-observer.last"
disparar "$A" "$H"
APARECIO=0; for _ in $(seq 1 20); do [ -e "$A/corrio.txt" ] && { APARECIO=1; break; }; sleep 0.1; done
if [ "$RC" = 0 ] && [ "$APARECIO" = 0 ] && [ ! -e "$A/corrio.txt" ] && [ ! -e "$A/inbox" ] && sin_inbox_en_casa "$H"; then
  ok "T14 con el freno sin vencer: no corre el observador y no se crea ni la casa"
else bad "T14 freno sin vencer" "rc=$RC corrió=$([ -e "$A/corrio.txt" ] && echo sí || echo no) casa=[$(find "$H" -name inbox | head -2 | tr '\n' ' ')]"; fi

# ═══ T15 · sin tycon-home.js nadie cae al árbol ═════════════════════════════════════════════════════════════════
A=$(arbol t15 limpio sin-estado); casa casa-t15; B=$(modelo t15 las-dos); ANTES=$(primer_nivel "$A")
observar "$A" "$H" "$B"; RC_O=$RC
revisar "$A" "$H" list
if [ "$RC_O" = 0 ] && grep -qF "tycon-home.js" "$LAB/t15.log" && [ "$(grep -c . "$LAB/t15.log")" = 1 ] && [ "$(primer_nivel "$A")" = "$ANTES" ] && sin_inbox_en_casa "$H" \
  && [ "$RC" = 1 ] && echo "$SAL" | grep -qF "tycon-home.js" && ! echo "$SAL" | grep -qE '^\s+at '; then
  ok "T15 NoStateResolver_ObserverSaysIt_PromoteExits1 — sin tycon-home.js: el observador lo dice en una línea y sale 0 sin escribir; el comando de revisión sale 1 con el motivo, sin traza"
else bad "T15 sin tycon-home.js" "observador rc=$RC_O [$(tail -2 "$LAB/t15.log" | tr '\n' ' ')] · list rc=$RC [$(echo "$SAL" | head -3 | tr '\n' '|')] árbol=[$(primer_nivel "$A")]"; fi

echo
if [ "$fallos" = 0 ]; then echo "instinct-outside-tree: todo verde"; exit 0; fi
echo "instinct-outside-tree: $fallos en rojo"; exit 1
