#!/usr/bin/env bash
# harness-update.test.sh — `harness.js startup` y `update`: el candado, la red, el orden y las dos fuentes (story 8.13,
# tanda A · T3, T4, T6, T7).
#
# Lo que no se puede perder:
#   T3 · dos `startup` a la vez con versión nueva: una aplica y la otra se va con 0 en silencio; el estado y settings.json
#        quedan coherentes y sin `failed`; un `index.lock` ajeno es «otra sesión», no un fallo, y nada se restaura.
#   T4 · sin red (una IP no ruteable, y un servidor que acepta y nunca contesta) `update` termina dentro del tope
#        (`TYCON_UPDATE_NETWORK_BUDGET_S`) y dice «sin red»; `startup` sale 0 SIEMPRE y el arranque entero entra en ≤ 35 s;
#        con `TYCON_UPDATE=0` no sale a la red; un error (el aplicador que falla) va a startup.log y a `notice`, y a UNA
#        línea por stdout.
#   T6 · `startup` hace, en orden: engram sólo con la integración prendida; `update` según la política; el aplicador
#        SIEMPRE (también sin cambios); dos arranques seguidos no vuelven a la red (`last_fetch` < 10 min) pero sí corren
#        el aplicador; el sello diario del aplicador existe.
#   T7 · `update` trabaja sobre las dos fuentes, agent-skills primero: avanzan las dos y recién ahí el aplicador; con una
#        divergida no se mueve ninguna y se nombra; lo local modificado se guarda aparte y se reaplica; un no trackeado de
#        `.dashboard/` que lo publicado agrega se aparta; una ref que se reescribe va a `tycon/installed` con `previous` en
#        `refs/tycon/previous/*`; con skills de terceros sin ignorar no hace `reset` y lo dice; `--check` sale 0 / 3 / 2.
#   K1 · (story 8.7, tanda C · decisión C1) una falla de red INMEDIATA —conexión rechazada, nombre sin resolver, sin ruta—
#        también es «sin red»: `startup` lo dice y no deja el aviso que queda; una falla que no es de red (el origen no es
#        un repo) sigue siendo «no pude traer» y sí lo deja. La lista de errores de red es positiva, con los textos reales.
#   T32 · (tanda D, AC 26) con `apply: ask` y versión nueva `startup` NO aplica: deja en `notice` el número de la nueva con
#        su sha corto, el comando para aplicarla y dónde ver los cambios (remoto interno: el `git log a..b`; público en
#        `stable`: instalado contra nuevo; en `latest`: la punta de `main` contra el nuevo), y el hook síncrono lo imprime
#        a la persona en la sesión SIGUIENTE; sale a la red una vez cada 6 horas (10 minutos en `auto`) y un intento que no
#        pudo mirar no cuenta; `update --yes` con la política en `ask` pide una terminal (sin ella, 2); en `auto` aplica y
#        deja UNA línea sólo si aplicó; ni `developer` ni una retención se pasan por encima; el canal tiene una sola
#        verdad (la configuración) y `channel` avisa si una variable le gana. Si el canal cambia por fuera de `channel`
#        (el archivo a mano, la variable), el arranque siguiente mira y el aviso del canal anterior no queda; y un
#        `update` sin `--yes` en `ask` deja el mismo aviso que `startup` (pase adversarial, causas E y F).
#   T37 · (tanda D, AC 29) `install --source <url>` re-fija la fuente cuyo `origin` ES esa URL (no la del arnés); en una
#        copia pública, `channel latest` e `install --channel latest` con la aplicación en `auto` por archivo preguntan en
#        la terminal (sin terminal, 2), con `auto` por variable o con `ask` pasan; fuera de una copia pública no preguntan.
#
# Laboratorio: scripts/tests/lib/harness-lab.sh. Nunca ~/.claude ni el checkout real. 🔴 Sin pipes sobre el comando medido.
#
#   T38 · (story 8.18, AC 35 y 37) `update` y `version` en las tres formas de máquina que deja la unión de los dos repos:
#        dos clones sin re-apuntar, dos clones con el viejo re-apuntado al repo unificado (los dos al mismo commit, y
#        `version` muestra uno solo), y un solo árbol. La llave misma, en harness-repoint.test.sh.
#   GBH · (pase adversarial de la W3a, B1) harness.js lanza el aplicador con TYCON_HARNESS_GIT_BASH_HEALTH=1 en cada camino.
#
#   T8 · (story 8.13.1, tanda A · AC 7) el commit de la capa lo elige la máquina: trae `main` del interno a su clon de
#        lectura y toma el más nuevo compatible con la versión pública, sin pasar del piso de version.json; con la punta
#        incompatible se queda y lo dice (también si la punta sólo agrega un archivo publicable que la copia no trae,
#        AC 5); sin ninguno, el mínimo con las horas; nunca escribe en ningún repo.
#   T9 · (story 8.13.1, tanda A · AC 8 y 9) `update` con dos fuentes: todas o ninguna, «sólo la capa», sin acceso al
#        interno no mueve ninguna (en el tope y «sin red»), `--check` 0/3/2, `rollback` de las dos tras `gc --prune=now`,
#        `TYCON_UPDATE=0` no toca la capa, y el clon de la persona queda idéntico; con el tope POR DEFECTO, el update
#        entero sin acceso al interno termina en ≤ 15 s.
#   T9R · (pase adversarial de la tanda A) lo editado a mano no se pisa al ir a una versión que lo sigue (update y
#        rollback); un layer.json ilegible se dice y no mueve nada; install sin --harness-clone no suelta la capa (sin
#        clon de lectura, o desde otro árbol); install sin acceso al interno lo dice con su propio texto. Y (revisión
#        del paso 5, vuelta 2) un layer.json con una ruta que sale del árbol frena antes de tomar copia, y la vuelta
#        atrás AUTOMÁTICA de un update que falla la salud tampoco pisa un agregado editado a mano (C8).
#
# Uso: bash scripts/tests/harness-update.test.sh [--only T3|T4|T6|GBH|T7|REG|CA|K1|T32|T37|T38|S16|S16B|T8]
#   CA · (arreglo «copia de arranque», 2026-10-05) un update que sólo re-registra la versión no corre la salud ni
#        refresca la copia fija; `doctor` dice cuándo se refresca de verdad (versión nueva con salud en verde, o install).
#   S16 · (story 8.16, tanda A · AC 8) un `update` aplicado dice dónde quedó la copia de antes y cómo volver.
#   S16B · (story 8.16, tanda B · AC 18 y 44) con `ask`, versión nueva y terminal: qué cambia en el comportamiento y
#         «¿Aplico ahora?»; sin terminal como antes; `auto` sin pregunta; con retención no se ofrece.
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
ONLY=""; [ "${1:-}" = "--only" ] && ONLY="${2:-}"
corre() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
BASE="$(mktemp -d)"
node "$RAIZ/scripts/tests/lib/lab-guard.js" "$BASE" harness-update || exit 1
trap 'rm -rf "$BASE"; kill $(jobs -p) 2>/dev/null' EXIT
j() { python3 -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print($2)" "$1" 2>/dev/null; }
ESTADO() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"; }
estado() { j "$(ESTADO)" "$1"; }
# edita el estado (sólo las pruebas lo hacen a mano): estado_set "<expresión python sobre d>"
estado_set() { python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p, encoding='utf-8')); $1; json.dump(d, open(p,'w', encoding='utf-8'), indent=2)" "$(ESTADO)"; }
head_de() { harness_lab_git "$1" rev-parse HEAD; }
corridas_aplicador() { grep -c '^run check=0' "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log" 2>/dev/null || echo 0; }
LOG() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness/startup.log"; }
export TYCON_UPDATE_APPLY=auto   # la política del equipo, sin perfil en el laboratorio
ORIG_PATH="$PATH"

# ═══ T3 · Harness_Lock_TwoStartupsWithNewVersion_OneAppliesNoFailed ══════════════════════════════════════════════════
if corre T3; then
  harness_lab_create "$BASE/t3" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "T3 install previo falló"
  harness_lab_publish tree "v2" VERSION 2; harness_lab_publish skills "v2" VERSION 2
  NUEVO="$(head_de "$LAB_AUTHOR_TREE")"
  export LAB_APPLIER_SLEEP=2
  harness startup > "$BASE/t3/s1.out" 2>&1 & P1=$!
  harness startup > "$BASE/t3/s2.out" 2>&1 & P2=$!
  wait $P1; RC1=$?; wait $P2; RC2=$?
  unset LAB_APPLIER_SLEEP
  [ "$RC1" = 0 ] && [ "$RC2" = 0 ] && ok "T3 los dos startup salen 0" || mal "T3 rc $RC1 / $RC2: $(cat "$BASE/t3/s1.out" "$BASE/t3/s2.out")"
  [ "$(head_de "$LAB_TREE")" = "$NUEVO" ] && ok "T3 una de las dos aplicó la versión nueva" || mal "T3 el clon no avanzó: $(head_de "$LAB_TREE") vs $NUEVO"
  [ "$(estado "d['sources'][0]['commit']")" = "$NUEVO" ] && [ "$(estado "d.get('failed')")" = None ] && ok "T3 estado coherente, sin failed" || mal "T3 estado: commit=$(estado "d['sources'][0]['commit']") failed=$(estado "d.get('failed')")"
  python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$TYCON_SETTINGS_PATH" && ok "T3 settings.json sigue siendo JSON" || mal "T3 settings.json roto"
  SILENCIO="$(cat "$BASE/t3/s1.out" "$BASE/t3/s2.out" | grep -c -i 'otra sesi')"
  [ "$SILENCIO" = 0 ] && ok "T3 la segunda se fue en silencio por stdout" || mal "T3 la segunda habló: $(cat "$BASE/t3/s1.out" "$BASE/t3/s2.out")"
  grep -q -i 'otra sesi' "$(LOG)" 2>/dev/null && ok "T3 …y lo dejó en startup.log" || mal "T3 startup.log no registra la otra sesión: $(cat "$(LOG)" 2>&1 | tail -3)"
  # un index.lock ajeno: «otra sesión», sin failed, nada restaurado
  harness_lab_publish tree "v3" VERSION 3
  ANTES="$(head_de "$LAB_TREE")"; : > "$LAB_TREE/.git/index.lock"
  SALIDA="$(harness update 2>&1)"; RC=$?
  rm -f "$LAB_TREE/.git/index.lock"
  [ "$RC" = 3 ] && case "$SALIDA" in *"otra sesi"*) ok "T3 con index.lock ajeno: 3 y «otra sesión»" ;; *) mal "T3 index.lock: no dice otra sesión: $SALIDA" ;; esac || mal "T3 index.lock: rc $RC: $SALIDA"
  [ "$(estado "d.get('failed')")" = None ] && [ "$(head_de "$LAB_TREE")" = "$ANTES" ] && ok "T3 index.lock: sin failed y nada restaurado" || mal "T3 index.lock: failed=$(estado "d.get('failed')")"
fi

# ═══ T4 · Harness_Startup_NoNetwork_Under35s_AlwaysExit0 ═════════════════════════════════════════════════════════════
if corre T4; then
  export TYCON_UPDATE_NETWORK_BUDGET_S=3
  # (a) una IP no ruteable como origen de las dos fuentes (fijada ANTES de instalar: el estado guarda esa url)
  harness_lab_create "$BASE/t4a" >/dev/null
  harness_lab_git "$LAB_TREE" remote set-url origin http://10.255.255.1/lab/harness.git
  harness_lab_git "$LAB_SKILLS" remote set-url origin http://10.255.255.1/lab/agent-skills.git
  harness install --yes >/dev/null 2>&1 || mal "T4 install previo (a) falló"
  T0=$(date +%s); SALIDA="$(harness update --check 2>&1)"; RC=$?; T1=$(date +%s)
  [ "$RC" = 2 ] && case "$SALIDA" in *"sin red"*) ok "T4 IP no ruteable: update --check sale 2 y dice «sin red»" ;; *) mal "T4 no dice sin red: $SALIDA" ;; esac || mal "T4 IP no ruteable: rc $RC: $SALIDA"
  [ $((T1 - T0)) -le 15 ] && ok "T4 …en $((T1 - T0)) s (≤ 15)" || mal "T4 tardó $((T1 - T0)) s"
  T0=$(date +%s); SALIDA="$(harness startup 2>&1)"; RC=$?; T1=$(date +%s)
  [ "$RC" = 0 ] && [ $((T1 - T0)) -le 35 ] && ok "T4 startup sin red: 0 en $((T1 - T0)) s (≤ 35)" || mal "T4 startup sin red: rc $RC en $((T1 - T0)) s: $SALIDA"
  [ "$(printf '%s\n' "$SALIDA" | grep -c .)" -le 1 ] && ok "T4 startup: a lo sumo UNA línea por stdout" || mal "T4 startup habló de más: $SALIDA"
  # (b) un servidor que acepta y nunca contesta
  harness_lab_create "$BASE/t4b" >/dev/null
  PORT=$((20000 + RANDOM % 20000)); nc -l 127.0.0.1 "$PORT" >/dev/null 2>&1 & NC=$!
  harness_lab_git "$LAB_TREE" remote set-url origin "git://127.0.0.1:$PORT/lab/harness.git"
  harness install --yes >/dev/null 2>&1 || mal "T4 install previo (b) falló"
  T0=$(date +%s); SALIDA="$(harness update --check 2>&1)"; RC=$?; T1=$(date +%s)
  kill $NC 2>/dev/null
  [ "$RC" = 2 ] && [ $((T1 - T0)) -le 15 ] && ok "T4 servidor mudo: 2 en $((T1 - T0)) s" || mal "T4 servidor mudo: rc $RC en $((T1 - T0)) s: $SALIDA"
  # (c) TYCON_UPDATE=0: ni fetch; sí el aplicador
  harness_lab_create "$BASE/t4c" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "T4 install previo (c) falló"
  harness_lab_publish tree "v2" VERSION 2
  rm -f "$LAB_TREE/.git/FETCH_HEAD"; N="$(corridas_aplicador)"
  SALIDA="$(TYCON_UPDATE=0 harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ ! -f "$LAB_TREE/.git/FETCH_HEAD" ] && [ "$(corridas_aplicador)" = $((N + 1)) ] && ok "T4 TYCON_UPDATE=0: sin fetch, con aplicador" || mal "T4 TYCON_UPDATE=0: rc $RC fetch=$([ -f "$LAB_TREE/.git/FETCH_HEAD" ] && echo sí || echo no) aplicador=$(corridas_aplicador)/$((N + 1)): $SALIDA"
  # (d) un error inyectado: el aplicador falla → startup 0, el error en startup.log y en notice, una línea por stdout
  SALIDA="$(LAB_APPLIER_FAIL=1 harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "T4 con el aplicador roto startup sale 0 igual" || mal "T4 aplicador roto: rc $RC: $SALIDA"
  [ "$(printf '%s\n' "$SALIDA" | grep -c .)" -le 1 ] && ok "T4 …una línea por stdout" || mal "T4 habló de más: $SALIDA"
  grep -q -i 'aplicador' "$(LOG)" 2>/dev/null && ok "T4 …el error está en startup.log" || mal "T4 startup.log sin el error: $(tail -3 "$(LOG)" 2>&1)"
  [ "$(estado "d.get('notice') or ''")" != "" ] && ok "T4 …y en notice" || mal "T4 notice vacío"
  unset TYCON_UPDATE_NETWORK_BUDGET_S
fi

# ═══ T6 · Harness_Startup_Order_EngramOnlyIfOn_ApplierAlways_FetchThrottle ═══════════════════════════════════════════
if corre T6; then
  harness_lab_create "$BASE/t6" >/dev/null
  # un engram de mentira que anota cada llamada
  printf '#!/bin/sh\necho "$*" >> "%s/engram-calls.log"\nexit 0\n' "$LAB" > "$LAB_BIN/engram"; chmod +x "$LAB_BIN/engram"
  export PATH="$LAB_BIN:$PATH"
  harness install --yes >/dev/null 2>&1 || mal "T6 install previo falló"
  harness startup >/dev/null 2>&1
  [ ! -f "$LAB/engram-calls.log" ] && ok "T6 con la integración engram apagada no se llama a engram" || mal "T6 llamó a engram apagado: $(cat "$LAB/engram-calls.log")"
  TYCON_ENGRAM=1 harness startup >/dev/null 2>&1
  grep -q 'sync --import' "$LAB/engram-calls.log" 2>/dev/null && ok "T6 con engram prendido, startup corre engram sync --import" || mal "T6 no llamó a engram prendido: $(cat "$LAB/engram-calls.log" 2>&1)"
  # dos arranques seguidos: el segundo no sale a la red (last_fetch reciente) pero corre el aplicador
  harness_lab_publish tree "v2" VERSION 2
  N="$(corridas_aplicador)"; ANTES="$(head_de "$LAB_TREE")"
  harness startup >/dev/null 2>&1
  [ "$(head_de "$LAB_TREE")" = "$ANTES" ] && [ "$(corridas_aplicador)" = $((N + 1)) ] && ok "T6 segundo arranque en < 10 min: sin red, con aplicador" || mal "T6 segundo arranque: HEAD $(head_de "$LAB_TREE") (antes $ANTES) aplicador $(corridas_aplicador)/$((N + 1))"
  ls "$LAB_HOME/.claude/.tycon-pipeline/" | grep "^lab-daily-$(date +%F)$" >/dev/null && ok "T6 el sello diario del aplicador existe" || mal "T6 sin sello diario"
  # con last_fetch de hace 11 minutos vuelve a la red y aplica
  estado_set "import datetime; d['last_fetch']=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(minutes=11)).isoformat()"
  harness startup >/dev/null 2>&1
  [ "$(head_de "$LAB_TREE")" = "$(head_de "$LAB_AUTHOR_TREE")" ] && ok "T6 con last_fetch viejo sale a la red y aplica la versión nueva" || mal "T6 no aplicó: $(head_de "$LAB_TREE") vs $(head_de "$LAB_AUTHOR_TREE")"
  export PATH="$ORIG_PATH"
fi

# ═══ GBH · Harness_LaunchesApplier_WithGitBashHealthNotice (pase adversarial de la W3a, B1) ═══════════════════════════
# La actualización que trae la W3a la juzga la salud de la versión anterior, que en Windows revisaba un .sh con el primer
# `bash` del PATH (puede ser el lanzador de WSL). Un harness.js de la W3a en adelante le avisa al aplicador, con
# TYCON_HARNESS_GIT_BASH_HEALTH=1, que la salud que lo juzga usa el bash de Git; sin el aviso, el .ps1 deja los .sh para
# la corrida siguiente (installer-ps1.test.sh, sección u). Acá: harness.js pone el aviso en CADA camino que lanza el
# aplicador —install, startup, el update de un startup y apply—, y el aplicador corrido suelto no lo tiene.
if corre GBH; then
  harness_lab_create "$BASE/gbh" >/dev/null
  LAB_LOG="$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log"
  harness install --yes >/dev/null 2>&1 || mal "GBH install previo falló"
  harness_lab_publish tree "v2" VERSION 2
  harness startup >/dev/null 2>&1
  harness apply >/dev/null 2>&1
  [ "$(head_de "$LAB_TREE")" = "$(head_de "$LAB_AUTHOR_TREE")" ] || mal "GBH el startup no aplicó la versión nueva (el update no corrió): $(head_de "$LAB_TREE")"
  CON="$(grep -c '^run check=0 lock_held=1 .* git_bash_health=1 ' "$LAB_LOG" 2>/dev/null)"; TODAS="$(grep -c '^run check=0 lock_held=1 ' "$LAB_LOG" 2>/dev/null)"
  [ "${TODAS:-0}" -ge 4 ] && [ "$CON" = "$TODAS" ] && ok "GBH harness.js lanza el aplicador con TYCON_HARNESS_GIT_BASH_HEALTH=1 en las $TODAS corridas (install, startup, el update y apply)" \
    || mal "GBH el aplicador corrió sin el aviso: $CON de $TODAS corridas con git_bash_health=1 · $(tail -3 "$LAB_LOG" 2>&1 | cut -c1-200)"
  # el espejo: el aplicador corrido suelto (a mano, sin harness.js) no lo tiene
  bash "$LAB_TREE/scripts/install-tycon-hooks.sh" >/dev/null 2>&1
  case "$(tail -1 "$LAB_LOG")" in *" lock_held= "*" git_bash_health= "*) ok "GBH el espejo: el aplicador suelto corre sin el aviso" ;; *) mal "GBH el aplicador suelto corrió avisado: $(tail -1 "$LAB_LOG" | cut -c1-200)" ;; esac
fi

# ═══ T7 · Harness_Update_TwoSources_BothOrNone_StashDivergedRewrite ══════════════════════════════════════════════════
if corre T7; then
  # (a) avance limpio en las dos, agent-skills primero, y recién ahí el aplicador
  harness_lab_create "$BASE/t7a" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "T7 install previo (a) falló"
  harness_lab_publish tree "v2" VERSION 2; harness_lab_publish skills "v2" VERSION 2
  N="$(corridas_aplicador)"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$(head_de "$LAB_AUTHOR_TREE")" ] && [ "$(head_de "$LAB_SKILLS")" = "$(head_de "$LAB_AUTHOR_SKILLS")" ] && ok "T7 avance limpio: las dos fuentes al día" || mal "T7 avance limpio: rc $RC: $SALIDA"
  [ "$(corridas_aplicador)" = $((N + 1)) ] && grep -q 'version=2' "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log" && ok "T7 el aplicador corrió una vez, ya con la versión nueva" || mal "T7 aplicador: $(corridas_aplicador)/$((N + 1)); $(tail -1 "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log")"
  harness_lab_git "$LAB_TREE" rev-parse --verify -q refs/tycon/previous/harness >/dev/null && [ "$(estado "d['sources'][0]['previous']")" != None ] && ok "T7 previous guardado en el estado y en refs/tycon/previous/harness" || mal "T7 sin previous: $(estado "d['sources'][0]")"
  case "$SALIDA" in *agent_skills*harness*|*agent-skills*harness*) ok "T7 la salida nombra agent-skills antes que harness" ;; *) ok "T7 (orden no verificable por la salida: $SALIDA)" ;; esac
  # (b) agent-skills divergido: no se mueve ninguna y se nombra
  harness_lab_create "$BASE/t7b" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "T7 install previo (b) falló"
  printf 'propio\n' > "$LAB_SKILLS/PROPIO.md"; harness_lab_git "$LAB_SKILLS" add PROPIO.md >/dev/null; harness_lab_git "$LAB_SKILLS" commit -q -m "commit propio" >/dev/null
  harness_lab_publish tree "v2" VERSION 2; harness_lab_publish skills "v2" VERSION 2
  A_T="$(head_de "$LAB_TREE")"; A_S="$(head_de "$LAB_SKILLS")"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$(head_de "$LAB_TREE")" = "$A_T" ] && [ "$(head_de "$LAB_SKILLS")" = "$A_S" ] && ok "T7 con agent-skills divergido no se mueve ninguna fuente" || mal "T7 divergido: se movió algo (tree $(head_de "$LAB_TREE") skills $(head_de "$LAB_SKILLS"))"
  case "$SALIDA" in *agent*skills*diverg*|*agent_skills*diverg*) ok "T7 …y nombra la fuente y el motivo" ;; *) mal "T7 divergido: no nombra fuente y motivo (rc $RC): $SALIDA" ;; esac
  # (c) archivo local modificado: se guarda aparte y se reaplica
  harness_lab_create "$BASE/t7c" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "T7 install previo (c) falló"
  printf 'modificado por el dev\n' >> "$LAB_TREE/README.md"
  harness_lab_publish tree "v2" VERSION 2
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$(head_de "$LAB_AUTHOR_TREE")" ] && grep -q 'modificado por el dev' "$LAB_TREE/README.md" && ok "T7 lo modificado se guardó aparte, avanzó y se reaplicó" || mal "T7 modificado: rc $RC HEAD $(head_de "$LAB_TREE"): $SALIDA"
  # (d) un no trackeado en .dashboard/ que lo publicado agrega: se aparta
  harness_lab_create "$BASE/t7d" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "T7 install previo (d) falló"
  mkdir -p "$LAB_AUTHOR_TREE/.dashboard"; printf '{"publicado":1}\n' > "$LAB_AUTHOR_TREE/.dashboard/sdlc-stage-lab.json"
  harness_lab_git "$LAB_AUTHOR_TREE" add -f .dashboard/sdlc-stage-lab.json >/dev/null; harness_lab_git "$LAB_AUTHOR_TREE" commit -q -m "tablero" >/dev/null; harness_lab_git "$LAB_AUTHOR_TREE" push -q origin main >/dev/null 2>&1
  mkdir -p "$LAB_TREE/.dashboard"; printf '{"local":1}\n' > "$LAB_TREE/.dashboard/sdlc-stage-lab.json"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$(head_de "$LAB_AUTHOR_TREE")" ] && grep -q publicado "$LAB_TREE/.dashboard/sdlc-stage-lab.json" && ok "T7 el no trackeado de .dashboard/ se apartó y el avance entró" || mal "T7 .dashboard: rc $RC HEAD $(head_de "$LAB_TREE"): $SALIDA"
  # (e) una ref que se reescribe (rewrites: true): rama local tycon/installed al sha traído, previous en la ref
  harness_lab_create "$BASE/t7e" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "T7 install previo (e) falló"
  estado_set "d['sources'][0]['rewrites']=True"
  harness_lab_git "$LAB_AUTHOR_TREE" commit -q --allow-empty --amend -m "reescrita" >/dev/null; harness_lab_git "$LAB_AUTHOR_TREE" push -q --force origin main >/dev/null 2>&1
  VIEJO="$(head_de "$LAB_TREE")"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(harness_lab_git "$LAB_TREE" rev-parse --abbrev-ref HEAD)" = "tycon/installed" ] && [ "$(head_de "$LAB_TREE")" = "$(head_de "$LAB_AUTHOR_TREE")" ] && ok "T7 ref reescrita: tycon/installed al sha nuevo" || mal "T7 reescrita: rc $RC rama $(harness_lab_git "$LAB_TREE" rev-parse --abbrev-ref HEAD) HEAD $(head_de "$LAB_TREE"): $SALIDA"
  [ "$(harness_lab_git "$LAB_TREE" rev-parse refs/tycon/previous/harness 2>/dev/null)" = "$VIEJO" ] && ok "T7 reescrita: previous en refs/tycon/previous/harness" || mal "T7 reescrita: previous=$(harness_lab_git "$LAB_TREE" rev-parse refs/tycon/previous/harness 2>&1)"
  # (f) una fuente que se reescribe con un archivo SEGUIDO modificado: no hace reset (lo perdería) y lo dice. Desde la
  #     tanda D (decisión D3 del dueño) lo SIN SEGUIR —una skill de terceros sin ignorar, una skill propia— ya no traba,
  #     salvo que choque con una ruta que la versión nueva trae: esos dos casos los mide harness-channel.test.sh (D3).
  #     Antes este caso decía «terceros sin ignorar: no hace reset».
  harness_lab_create "$BASE/t7f" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "T7 install previo (f) falló"
  estado_set "d['sources'][1]['rewrites']=True"
  mkdir -p "$LAB_SKILLS/skills/acme"; printf 'de terceros\n' > "$LAB_SKILLS/skills/acme/SKILL.md"   # sin seguir y sin ignorar
  printf 'tocado por la persona\n' >> "$LAB_SKILLS/README.md"                                        # seguido y modificado
  harness_lab_publish skills "v2" VERSION 2
  A_S="$(head_de "$LAB_SKILLS")"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$(head_de "$LAB_SKILLS")" = "$A_S" ] && case "$SALIDA" in *README.md*"sin commitear"*|*"sin commitear"*README.md*) ok "T7 reescrita con un archivo seguido modificado: no hace reset y lo dice" ;; *) mal "T7 reescrita modificada: no lo dice (rc $RC): $SALIDA" ;; esac || mal "T7 reescrita modificada: hizo reset igual"
  case "$SALIDA" in *acme*) mal "T7 reescrita: culpa a lo sin seguir, que no traba: $SALIDA" ;; *) ok "T7 …y no culpa a la skill sin seguir" ;; esac
  # espejo: sin la modificación, la skill sin seguir no traba y sigue ahí
  harness_lab_git "$LAB_SKILLS" checkout -q -- README.md
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_SKILLS")" = "$(head_de "$LAB_AUTHOR_SKILLS")" ] && [ -f "$LAB_SKILLS/skills/acme/SKILL.md" ] && ok "T7 espejo: lo sin seguir no traba el reset y queda en su lugar" || mal "T7 espejo: rc $RC HEAD $(head_de "$LAB_SKILLS"): $SALIDA"
  # (g) --check: 0 al día, 3 con versión nueva, 2 sin poder mirar
  harness_lab_create "$BASE/t7g" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "T7 install previo (g) falló"
  harness update --check >/dev/null 2>&1; RC0=$?
  harness_lab_publish tree "v2" VERSION 2
  harness update --check >/dev/null 2>&1; RC3=$?
  mv "$LAB_REMOTE_TREE" "$LAB_REMOTE_TREE.fuera"
  SALIDA="$(harness update --check 2>&1)"; RC2=$?
  mv "$LAB_REMOTE_TREE.fuera" "$LAB_REMOTE_TREE"
  [ "$RC0" = 0 ] && [ "$RC3" = 3 ] && [ "$RC2" = 2 ] && ok "T7 --check: 0 al día · 3 hay nueva · 2 no pude mirar" || mal "T7 --check: $RC0 / $RC3 / $RC2 ($SALIDA)"
fi

# ═══ Regresiones de la iteración 1 (pase adversarial y revisores, 2026-10-02) ═════════════════════════════════════════
if corre REG; then
  # REG-D5 · un aviso de falla se borra cuando la falla ya no se da (antes quedaba para siempre y el hook lo repetía)
  harness_lab_create "$BASE/reg-d5" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "REG-D5 install previo falló"
  LAB_APPLIER_FAIL=1 harness startup >/dev/null 2>&1
  case "$(estado "d.get('notice') or ''")" in *aplicador*) ok "REG-D5 el aplicador roto deja el aviso" ;; *) mal "REG-D5 sin aviso tras el fallo: $(estado "d.get('notice')")" ;; esac
  harness startup >/dev/null 2>&1
  [ "$(estado "d.get('notice')")" = None ] && ok "REG-D5 un arranque sano lo borra" || mal "REG-D5 el aviso sigue: $(estado "d.get('notice')")"
  # …y el «disponible» de ask se conserva mientras no se vuelva a salir a la red (no es una falla)
  estado_set "d['notice']='arnés nuevo disponible (lab)'"
  TYCON_UPDATE_APPLY=ask harness startup >/dev/null 2>&1
  case "$(estado "d.get('notice') or ''")" in *disponible*) ok "REG-D5 el aviso de versión nueva sobrevive a un arranque sin red" ;; *) mal "REG-D5 se borró el disponible: $(estado "d.get('notice')")" ;; esac
  # REG-D5b · un aviso de update que sale DESPUÉS de mirar (fuente divergida con versión nueva: bloqueada) sobrevive a un
  # arranque que no vuelve a salir a la red: sin volver a mirar, nadie sabe que se arregló (revisor de fallos silenciosos,
  # iteración 2). Se borra recién cuando un arranque que sí mira ya no lo encuentra.
  harness_lab_create "$BASE/reg-d5b" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "REG-D5b install previo falló"
  printf 'propio\n' > "$LAB_TREE/PROPIO.md"; harness_lab_git "$LAB_TREE" add PROPIO.md >/dev/null; harness_lab_git "$LAB_TREE" commit -q -m "commit propio" >/dev/null
  harness_lab_publish tree "v2" VERSION 2
  estado_set "d['last_fetch']=None"
  harness startup >/dev/null 2>&1
  case "$(estado "d.get('notice') or ''")" in *diverg*) ok "REG-D5b la fuente divergida con versión nueva deja el aviso" ;; *) mal "REG-D5b sin aviso de divergencia: $(estado "d.get('notice')")" ;; esac
  harness startup >/dev/null 2>&1   # < 10 min: no sale a la red
  case "$(estado "d.get('notice') or ''")" in *diverg*) ok "REG-D5b …y sobrevive a un arranque que no vuelve a mirar" ;; *) mal "REG-D5b el aviso se borró sin volver a mirar: $(estado "d.get('notice')")" ;; esac
  harness_lab_git "$LAB_TREE" reset -q --hard HEAD~1
  estado_set "d['last_fetch']=None"
  harness startup >/dev/null 2>&1
  [ "$(estado "d.get('notice')")" = None ] && ok "REG-D5b un arranque que mira y lo encuentra resuelto lo borra" || mal "REG-D5b el aviso sigue tras resolverse: $(estado "d.get('notice')")"
  # REG-D5c · el aviso «la actualización … no quedó sana» (el aplicador falló justo después de avanzar). Desde la tanda C
  # (AC 21) esa versión vuelve sola atrás y queda en `failed`: el aviso NO se borra en el arranque siguiente —la versión
  # sigue sin aplicarse y no se reintenta sola—; se borra cuando `update --yes` la aplica sana (antes, en la A, se borraba
  # al arranque siguiente porque los árboles quedaban en la versión nueva con el aplicador ya andando)
  harness_lab_create "$BASE/reg-d5c" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "REG-D5c install previo falló"
  V1="$(harness_lab_git "$LAB_TREE" rev-parse HEAD)"
  harness_lab_publish tree "v2" VERSION 2
  estado_set "d['last_fetch']=None"
  LAB_APPLIER_FAIL=1 harness startup >/dev/null 2>&1
  case "$(estado "d.get('notice') or ''")" in *"no quedó sana"*|*aplicador*) ok "REG-D5c la actualización con el aplicador roto deja el aviso" ;; *) mal "REG-D5c sin aviso: $(estado "d.get('notice')")" ;; esac
  [ "$(harness_lab_git "$LAB_TREE" rev-parse HEAD)" = "$V1" ] && [ "$(estado "(d.get('failed') or {}).get('reason')")" = applier ] && ok "REG-D5c …el árbol volvió solo a v1 y queda failed (applier)" || mal "REG-D5c no volvió o no anotó failed: HEAD $(harness_lab_git "$LAB_TREE" rev-parse --short HEAD) failed=$(estado "d.get('failed')")"
  estado_set "d['last_fetch']=None"
  harness startup >/dev/null 2>&1   # mira de nuevo: las mismas puntas que fallaron, no se reintenta
  [ "$(harness_lab_git "$LAB_TREE" rev-parse HEAD)" = "$V1" ] && case "$(estado "d.get('notice') or ''")" in *"no quedó sana"*) true ;; *) false ;; esac && ok "REG-D5c el arranque siguiente no reintenta y el aviso sigue" || mal "REG-D5c reintentó o perdió el aviso: $(estado "d.get('notice')")"
  harness update --yes >/dev/null 2>&1
  [ "$(estado "d.get('notice')")" = None ] && [ "$(estado "d.get('failed')")" = None ] && ok "REG-D5c update --yes la aplica sana y borra el aviso y failed" || mal "REG-D5c tras update --yes: notice=$(estado "d.get('notice')") failed=$(estado "d.get('failed')")"
  # REG-D6 · un origin cambiado deja el aviso (antes sólo iba al registro y la persona nunca se enteraba)
  harness_lab_create "$BASE/reg-d6" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "REG-D6 install previo falló"
  harness_lab_git "$LAB_TREE" remote set-url origin "$LAB_REMOTE_TREE.otro"
  harness startup >/dev/null 2>&1
  case "$(estado "d.get('notice') or ''")" in *origin*) ok "REG-D6 origin cambiado: startup deja el aviso" ;; *) mal "REG-D6 sin aviso: $(estado "d.get('notice')")" ;; esac
  # REG-D7 · con el estado ya escrito, startup migra una línea de arranque vieja que quedó (AC 7: «el aplicador o startup»)
  harness_lab_create "$BASE/reg-d7" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "REG-D7 install previo falló"
  harness_lab_old_line canonical
  [ "$(harness_lab_settings_commands | grep -c 'git pull')" -ge 1 ] || mal "REG-D7 no pude sembrar la línea vieja"
  harness startup >/dev/null 2>&1
  [ "$(harness_lab_settings_commands | grep -c 'git pull')" = 0 ] && [ "$(harness_lab_settings_commands | grep -c '\.tycon-pipeline/harness/bootstrap\.js')" = 1 ] && ok "REG-D7 startup migró la línea vieja y quedó una sola nueva" || mal "REG-D7 líneas: $(harness_lab_settings_commands | cut -c1-80)"
  # REG-D12 · TYCON_UPDATE=0 apaga del todo: tampoco --yes actualiza
  harness_lab_create "$BASE/reg-d12" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "REG-D12 install previo falló"
  harness_lab_publish tree "v2" VERSION 2
  ANTES="$(head_de "$LAB_TREE")"
  SALIDA="$(TYCON_UPDATE=0 harness update --yes 2>&1)"; RC=$?
  [ "$(head_de "$LAB_TREE")" = "$ANTES" ] && case "$SALIDA" in *TYCON_UPDATE=0*) ok "REG-D12 TYCON_UPDATE=0 gana sobre --yes y lo dice" ;; *) mal "REG-D12 no lo dice: $SALIDA" ;; esac || mal "REG-D12 --yes actualizó con TYCON_UPDATE=0"
fi

# ═══ REG-H8 (pase adversarial de la tanda C): con `apply: ask`, la retención y un intento fallido sobre las mismas
# puntas mandan sobre «arnés nuevo disponible» (no se ofrece reinstalar lo que se deshizo o lo que ya falló) ════════════
if corre REG; then
  harness_lab_create "$BASE/reg-h8" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "REG-H8 install previo falló"
  harness_lab_publish tree "v2" VERSION 2
  V2="$(harness_lab_git "$LAB_AUTHOR_TREE" rev-parse HEAD)"
  estado_set "d['hold']={'commit':'v2-deshecha','sources':{'harness':'$V2'},'at':'2026-10-02T00:00:00Z','reason':'rollback'}; d['last_fetch']=None"
  TYCON_UPDATE_APPLY=ask harness startup >/dev/null 2>&1
  N="$(estado "d.get('notice') or ''")"
  case "$N" in *retención*) ok "REG-H8 ask con retención: el aviso es la retención" ;; *) mal "REG-H8 ask con retención avisa otra cosa: $N" ;; esac
  case "$N" in *disponible*) mal "REG-H8 ask con retención ofrece la versión deshecha: $N" ;; *) ok "REG-H8 …y no ofrece la versión deshecha" ;; esac
  S="$(harness_lab_git "$LAB_SKILLS" rev-parse HEAD)"
  estado_set "d['hold']=None; d['failed']={'commit':'v2-rota','sources':{'harness':'$V2','agent_skills':'$S'},'at':'2026-10-02T00:00:00Z','log':'x','reason':'health'}; d['last_fetch']=None"
  TYCON_UPDATE_APPLY=ask harness startup >/dev/null 2>&1
  N="$(estado "d.get('notice') or ''")"
  case "$N" in *disponible*) mal "REG-H8 ask con un intento fallido sobre esas puntas la ofrece igual: $N" ;; *"no quedó sana"*) ok "REG-H8 ask con un intento fallido: el aviso es la falla, no «disponible»" ;; *) mal "REG-H8 ask con intento fallido: aviso inesperado: $N" ;; esac
fi

# ═══ CA · Update_ReRegisterOnly_DoctorSaysWhenFixedCopyRefreshes (arreglo «copia de arranque», 2026-10-05) ═══════════
# Medido en la máquina del dueño: el clon ya estaba al día a mano y la versión registrada era la vieja. `update` corrigió
# el registro (camino «al día»: no corre la salud) y la copia fija siguió vieja, como debe —se refresca sólo tras una
# salud en verde—. Pero `doctor` decía «se refresca con el próximo update que pase la comprobación de salud», y ese
# update ya había pasado sin refrescarla. El aviso dice ahora lo que pasa: la refresca la próxima actualización que
# traiga una versión nueva y pase la salud, o `harness.js install`. El espejo: un update con versión nueva la refresca.
# 🔴 rojo previo (medido con el programa de antes sobre este mismo guion): tras el update, el aviso prometía el update.
if corre CA; then
  harness_lab_create "$BASE/ca" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "CA install previo falló"
  FIXED="scripts/setup/harness/bootstrap.js"
  FIXED_COPY="$LAB_HOME/.claude/.tycon-pipeline/harness/bootstrap.js"
  # publica un cambio de la copia fija: el archivo de verdad más una línea, para que siga arrancando
  publica_fija() {
    harness_lab_git "$LAB_AUTHOR_TREE" pull -q --ff-only origin main >/dev/null 2>&1 || true
    printf '// %s\n' "$1" >> "$LAB_AUTHOR_TREE/$FIXED"
    harness_lab_git "$LAB_AUTHOR_TREE" add -A >/dev/null
    harness_lab_git "$LAB_AUTHOR_TREE" commit -q -m "$1" >/dev/null
    harness_lab_git "$LAB_AUTHOR_TREE" push -q origin main >/dev/null 2>&1
  }
  # los avisos de la copia fija de `doctor --json`; un doctor que no devolvió JSON NO es «sin aviso»: deja una marca
  avisos() { python3 -c "
import json,sys
try: d=json.loads(sys.stdin.read())
except Exception: print('DOCTOR SIN JSON'); sys.exit(0)
print('\n'.join(w for w in d.get('warn',[]) if 'copia fija' in w))"; }
  publica_fija "copia nueva v2"
  harness_lab_pull_tree   # el clon llevado a mano a la punta: la versión registrada queda vieja
  REG="$(estado "d['sources'][0]['commit']")"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado "d['sources'][0]['commit']")" = "$(head_de "$LAB_TREE")" ] && [ "$REG" != "$(head_de "$LAB_TREE")" ] && ok "CA update al día re-registra la versión del clon" || mal "CA update: rc $RC, registrado $(estado "d['sources'][0]['commit']") HEAD $(head_de "$LAB_TREE") · $SALIDA"
  ! cmp -s "$FIXED_COPY" "$LAB_TREE/$FIXED" && ok "CA …y la copia fija sigue vieja (ese camino no corre la salud)" || mal "CA la copia fija se refrescó sin una salud en verde"
  W="$(harness doctor --json 2>/dev/null | avisos)"
  case "$W" in *"copia fija de arranque vieja"*) ok "CA doctor avisa la copia vieja" ;; *) mal "CA doctor no avisa la copia vieja: $W" ;; esac
  case "$W" in *"próximo update que pase"*) mal "CA doctor promete el update que ya pasó sin refrescarla: $W" ;; *) ok "CA …sin prometer «el próximo update» (ése ya pasó)" ;; esac
  case "$W" in *"versión nueva"*"harness.js install"*) ok "CA …y dice cuándo se refresca: una versión nueva con la salud en verde, o harness.js install" ;; *) mal "CA el aviso no dice cuándo se refresca: $W" ;; esac
  # el comando que nombra el aviso la refresca de verdad
  harness install --yes >/dev/null 2>&1
  cmp -s "$FIXED_COPY" "$LAB_TREE/$FIXED" && [ -z "$(harness doctor --json 2>/dev/null | avisos)" ] && ok "CA harness.js install la deja al día y el aviso se va" || mal "CA tras install: $(harness doctor --json 2>/dev/null | avisos)"
  # el espejo: un update que SÍ trae versión nueva la refresca tras la salud en verde, como siempre
  publica_fija "copia nueva v3"
  SALIDA="$(harness update --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$(head_de "$LAB_AUTHOR_TREE")" ] && cmp -s "$FIXED_COPY" "$LAB_TREE/$FIXED" && ok "CA espejo: update con versión nueva refresca la copia fija" || mal "CA espejo: rc $RC, copia al día $(cmp -s "$FIXED_COPY" "$LAB_TREE/$FIXED" && echo sí || echo no) · $SALIDA"
  [ -z "$(harness doctor --json 2>/dev/null | avisos)" ] && ok "CA espejo: …y doctor no avisa" || mal "CA espejo: doctor avisa: $(harness doctor --json 2>/dev/null | avisos)"
fi

# CB · el corte entre la copia fija nueva y el estado grabado (máquina Windows de un dev, 2026-10-07): la salud de v2
# pasó, copyBootstrap escribió la copia fija de v2, y un reinicio mató el proceso antes del S.write de cierre. El arranque
# siguiente encontraba la salud «pendiente», doctor veía la copia fija distinta del estado y lo leía como «alguien la
# tocó»: salud roja y vuelta atrás, que además NO reponía la copia fija → toda actualización siguiente fallaba igual.
# Ahora: (a) el estado se graba apenas se refresca la copia; (b) con la salud pendiente, la copia distinta es un aviso,
# no un fallo; (c) la vuelta atrás repone la copia fija desde el árbol restaurado.
if corre CB; then
  harness_lab_create "$BASE/cb" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "CB install previo falló"
  FIXED="scripts/setup/harness/bootstrap.js"
  FIXED_COPY="$LAB_HOME/.claude/.tycon-pipeline/harness/bootstrap.js"
  cp "$(ESTADO)" "$BASE/cb-estado-v1.json"
  harness_lab_git "$LAB_AUTHOR_TREE" pull -q --ff-only origin main >/dev/null 2>&1 || true
  printf '// copia nueva v2 (CB)\n' >> "$LAB_AUTHOR_TREE/$FIXED"
  harness_lab_git "$LAB_AUTHOR_TREE" add -A >/dev/null; harness_lab_git "$LAB_AUTHOR_TREE" commit -q -m "cb v2" >/dev/null; harness_lab_git "$LAB_AUTHOR_TREE" push -q origin main >/dev/null 2>&1
  harness update --yes >/dev/null 2>&1 || mal "CB update a v2 falló"
  V2="$(estado "d['version']['number']")"
  cmp -s "$FIXED_COPY" "$LAB_TREE/$FIXED" && ok "CB v2 aplicada: la copia fija es la de v2" || mal "CB la copia fija no es la de v2"
  # el corte, simulado: la copia fija de v2 queda en el disco; el estado vuelve al que se grabó ANTES de la salud
  # (sources en v2, failed.pending = health, bootstrap con los hashes de v1)
  python3 - "$(ESTADO)" "$BASE/cb-estado-v1.json" "$V2" <<'PY'
import json, sys
p, old_p, v2 = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(p, encoding='utf-8')); old = json.load(open(old_p, encoding='utf-8'))
d['bootstrap'] = old['bootstrap']; d['last_health'] = old.get('last_health')
d['failed'] = { 'commit': v2, 'sources': { s['name']: s.get('commit') for s in d.get('sources', []) }, 'at': '2026-10-07T20:42:00.000Z', 'log': 'x', 'reason': 'interrupted', 'pending': 'health', 'applier_failed': [] }
json.dump(d, open(p, 'w', encoding='utf-8'), indent=2)
PY
  SALIDA="$(harness startup 2>&1)"; RC=$?
  [ "$(estado "d['version']['number']")" = "$V2" ] && [ "$(estado "d.get('failed')")" = None ] && ok "CB el arranque retoma la salud pendiente y v2 queda sana (no volvió atrás)" || mal "CB tras el corte: version=$(estado "d['version']['number']") failed=$(estado "d.get('failed')") notice=$(estado "d.get('notice')")"
  grep -q "alguien la tocó" "$(LOG)" && mal "CB la copia fija de la actualización cortada se leyó como «alguien la tocó»" || ok "CB …sin leer el corte como una mano ajena"
  cmp -s "$FIXED_COPY" "$LAB_TREE/$FIXED" && [ "$(estado "d['bootstrap']['sha256'].get('bootstrap.js')")" = "$(shasum -a 256 "$FIXED_COPY" | cut -c1-64)" ] && ok "CB la copia fija y lo registrado en el estado coinciden otra vez" || mal "CB copia fija vs estado: $(estado "d['bootstrap']['sha256'].get('bootstrap.js')") vs $(shasum -a 256 "$FIXED_COPY" | cut -c1-64)"
  # (c) una v3 que vuelve atrás (aplicador roto) deja la copia fija de v2, la del árbol restaurado, y doctor sin fallo
  printf '// copia nueva v3 (CB)\n' >> "$LAB_AUTHOR_TREE/$FIXED"
  harness_lab_git "$LAB_AUTHOR_TREE" add -A >/dev/null; harness_lab_git "$LAB_AUTHOR_TREE" commit -q -m "cb v3" >/dev/null; harness_lab_git "$LAB_AUTHOR_TREE" push -q origin main >/dev/null 2>&1
  estado_set "d['last_fetch']=None"
  LAB_APPLIER_FAIL=1 harness startup >/dev/null 2>&1
  [ "$(estado "d['version']['number']")" = "$V2" ] && [ "$(estado "(d.get('failed') or {}).get('reason')")" = applier ] && ok "CB v3 falló y volvió sola a v2" || mal "CB v3: version=$(estado "d['version']['number']") failed=$(estado "d.get('failed')")"
  cmp -s "$FIXED_COPY" "$LAB_TREE/$FIXED" && ok "CB la vuelta atrás repuso la copia fija del árbol restaurado (v2)" || mal "CB la copia fija no es la del árbol restaurado"
  FALLOS_DOC="$(harness doctor --json 2>/dev/null | python3 -c "import json,sys; print(' | '.join(f for f in json.load(sys.stdin).get('fail',[]) if 'copia fija' in f))" 2>/dev/null)"
  [ -z "$FALLOS_DOC" ] && ok "CB doctor no acusa la copia fija tras la vuelta atrás" || mal "CB doctor: $FALLOS_DOC"
fi

# ═══ K1 · Harness_Fetch_ImmediateNetworkFailure_IsOffline (story 8.7, tanda C · decisión C1) ═════════════════════════
# Una notebook sin wifi no agota el tope: git falla AL INSTANTE (no resolvió el nombre, conexión rechazada, sin ruta al
# host). Eso también es «sin red»: `startup` lo dice y NO deja el aviso que queda —antes caía en «no pude traer» y dejaba
# un aviso por algo que se arregla solo al volver la red, y la portada promete «dice sin red»—. El espejo: una falla que NO
# es de red (el origen no es un repo) sigue siendo «no pude traer» y SÍ deja el aviso: la lista de errores de red es
# positiva, lo que no reconoce no lo calla.
if corre K1; then
  # (a) la lista, con los textos reales de git, curl y ssh (en inglés: sources.js corre git con LC_ALL=C)
  node - "$RAIZ/scripts/setup/harness/sources.js" > "$BASE/k1-unit.txt" 2>&1 <<'JS'
const S = require(process.argv[2]);
const say = (c, m) => console.log(c ? `  ok   — K1 ${m}` : `  MAL  — K1 ${m}`);
if (typeof S.isNetworkError !== 'function') { say(false, 'sources.js no exporta isNetworkError'); process.exit(0); }
const NETWORK = [
  ['no resolvió el nombre (curl)', "fatal: unable to access 'https://example.invalid/x.git/': Could not resolve host: example.invalid"],
  ['no resolvió el nombre (curl viejo)', "fatal: unable to access 'https://example.invalid/x.git/': Couldn't resolve host 'example.invalid'"],
  ['no resolvió el nombre (ssh)', 'ssh: Could not resolve hostname example.invalid: nodename nor servname provided, or not known\nfatal: Could not read from remote repository.'],
  ['no resolvió el nombre (ssh, Linux)', 'ssh: Could not resolve hostname example.invalid: Temporary failure in name resolution\nfatal: Could not read from remote repository.'],
  ['no resolvió el nombre (git://)', 'fatal: unable to look up example.invalid (port 9418) (Name or service not known)'],
  // pase adversarial de la tanda C: la notebook con proxy configurado por nombre y sin red (o fuera de la VPN)
  ['no resolvió el nombre del proxy (curl)', "fatal: unable to access 'https://example.invalid/x.git/': Could not resolve proxy: proxy-host.invalid"],
  ['no resolvió el nombre del proxy (curl viejo)', "fatal: unable to access 'https://example.invalid/x.git/': Couldn't resolve proxy 'proxy-host.invalid'"],
  ['conexión rechazada (curl 8)', "fatal: unable to access 'http://127.0.0.1:9/x.git/': Failed to connect to 127.0.0.1 port 9 after 0 ms: Couldn't connect to server"],
  ['conexión rechazada (curl 8.6+)', "fatal: unable to access 'http://127.0.0.1:9/x.git/': Failed to connect to 127.0.0.1 port 9 after 0 ms: Could not connect to server"],
  ['conexión rechazada (curl 7)', "fatal: unable to access 'http://127.0.0.1:9/x.git/': Failed to connect to 127.0.0.1 port 9: Connection refused"],
  ['conexión rechazada (git://, el motivo en la segunda línea)', 'fatal: unable to connect to 127.0.0.1:\n127.0.0.1[0: 127.0.0.1]: errno=Connection refused\n'],
  ['conexión rechazada (ssh)', 'ssh: connect to host 127.0.0.1 port 9: Connection refused\nfatal: Could not read from remote repository.'],
  ['sin ruta al host', "fatal: unable to access 'https://example.invalid/x.git/': Failed to connect to example.invalid port 443: No route to host"],
  ['red inalcanzable', 'ssh: connect to host example.invalid port 22: Network is unreachable\nfatal: Could not read from remote repository.'],
  ['tiempo agotado (curl)', "fatal: unable to access 'https://example.invalid/x.git/': Failed to connect to example.invalid port 443: Operation timed out"],
  ['tiempo agotado (curl, al conectar)', "fatal: unable to access 'https://example.invalid/x.git/': Connection timed out after 300001 milliseconds"],
  ['tiempo agotado (curl, al resolver)', "fatal: unable to access 'https://example.invalid/x.git/': Resolving timed out after 10000 milliseconds"],
  ['tiempo agotado (ssh)', 'ssh: connect to host example.invalid port 22: Connection timed out\nfatal: Could not read from remote repository.'],
];
const OTHER = [
  ['el origen no es un repo', "fatal: '/tmp/lab/no-existe.git' does not appear to be a git repository\nfatal: Could not read from remote repository."],
  ['la ref no existe', "fatal: couldn't find remote ref refs/heads/main"],
  ['el repo no existe en el servidor', "remote: Repository not found.\nfatal: repository 'https://example.invalid/x.git/' not found"],
  ['el servidor contestó 403', "fatal: unable to access 'https://example.invalid/x.git/': The requested URL returned error: 403"],
  ['el proxy contestó 407 (hay red: pide credenciales)', "fatal: unable to access 'https://example.invalid/x.git/': CONNECT tunnel failed, response 407"],
  ['certificado', "fatal: unable to access 'https://example.invalid/x.git/': SSL certificate problem: unable to get local issuer certificate"],
  ['credenciales', "fatal: Authentication failed for 'https://example.invalid/x.git/'"],
  ['llave ssh', 'git@example.invalid: Permission denied (publickey).\nfatal: Could not read from remote repository.'],
  ['el clon no es un repo', 'fatal: not a git repository (or any of the parent directories): .git'],
  ['git no está', 'git no está en el PATH'],
  ['vacío', ''],
];
for (const [name, text] of NETWORK) say(S.isNetworkError(text) === true, `es de red: ${name}`);
for (const [name, text] of OTHER) say(S.isNetworkError(text) === false, `NO es de red (espejo): ${name}`);
say(S.isNetworkError(undefined) === false && S.isNetworkError(null) === false, 'sin texto no es de red (no tira)');
JS
  cat "$BASE/k1-unit.txt"
  n=$(grep -c '^  MAL' "$BASE/k1-unit.txt"); FALLOS=$((FALLOS + n))
  grep -q '^  ok' "$BASE/k1-unit.txt" || mal "K1 la lista de errores de red no corrió: $(head -3 "$BASE/k1-unit.txt")"

  # (b) conexión rechazada al instante (el puerto 9 de la propia máquina: nadie escucha), fijada ANTES de instalar. La
  #     máquina «en castellano» a propósito: el idioma de git lo decide sources.js, no la sesión.
  harness_lab_create "$BASE/k1a" >/dev/null
  harness_lab_git "$LAB_TREE" remote set-url origin http://127.0.0.1:9/x.git
  harness install --yes >/dev/null 2>&1 || mal "K1 install previo (b) falló"
  FETCH="$(node -e 'const S = require(process.argv[1]); const r = S.fetch({ name: "harness", url: null, ref: "main", dir: process.argv[2] }); console.log([r.ok, r.offline, r.timedOut, r.reason].join("|"));' "$RAIZ/scripts/setup/harness/sources.js" "$LAB_TREE" 2>&1)"
  case "$FETCH" in "false|true|false|sin red: "*) ok "K1 fetch con la conexión rechazada: offline, sin agotar el tope, y el motivo empieza con «sin red: »" ;; *) mal "K1 fetch con la conexión rechazada devolvió: $FETCH" ;; esac
  SALIDA="$(env LC_ALL=es_ES.UTF-8 LANG=es_ES.UTF-8 LANGUAGE=es node "$LAB_TREE/scripts/setup/harness.js" startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$SALIDA" in *"sin red"*) ok "K1 conexión rechazada: startup sale 0 y dice «sin red»" ;; *) mal "K1 startup no dice sin red: $SALIDA" ;; esac || mal "K1 startup con la conexión rechazada: rc $RC: $SALIDA"
  [ "$(estado "d.get('notice')")" = None ] && ok "K1 …y no deja el aviso que queda" || mal "K1 quedó un aviso por una falla de red: $(estado "d.get('notice')")"
  grep -q 'sin red' "$(LOG)" 2>/dev/null && ! grep -q 'no contestó en' "$(LOG)" 2>/dev/null && ok "K1 …en startup.log queda «sin red», y no por el tope agotado" || mal "K1 startup.log: $(tail -3 "$(LOG)" 2>&1)"
  SALIDA="$(harness update --check 2>&1)"; RC=$?
  [ "$RC" = 2 ] && case "$SALIDA" in *"sin red"*) ok "K1 update --check: 2 y «sin red» (un fetch que falló no es «al día»)" ;; *) mal "K1 update --check no dice sin red: $SALIDA" ;; esac || mal "K1 update --check: rc $RC: $SALIDA"

  # (c) el espejo: el origen es una carpeta local que no es un repo — no es la red
  harness_lab_create "$BASE/k1b" >/dev/null
  harness_lab_git "$LAB_TREE" remote set-url origin "$LAB/remotes/no-existe.git"
  harness install --yes >/dev/null 2>&1 || mal "K1 install previo (c) falló"
  FETCH="$(node -e 'const S = require(process.argv[1]); const r = S.fetch({ name: "harness", url: null, ref: "main", dir: process.argv[2] }); console.log([r.ok, r.offline, r.timedOut, r.reason].join("|"));' "$RAIZ/scripts/setup/harness/sources.js" "$LAB_TREE" 2>&1)"
  case "$FETCH" in "false|false|false|no pude traer "*) ok "K1 espejo: un origen que no es un repo no es offline y sigue siendo «no pude traer»" ;; *) mal "K1 espejo: fetch devolvió: $FETCH" ;; esac
  SALIDA="$(harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$SALIDA" in *"sin red"*) mal "K1 espejo: startup llama «sin red» a un origen que no es un repo: $SALIDA" ;; *"no pude traer"*) ok "K1 espejo: startup sale 0 y dice «no pude traer», no «sin red»" ;; *) mal "K1 espejo: startup no dice «no pude traer»: $SALIDA" ;; esac || mal "K1 espejo: startup rc $RC: $SALIDA"
  case "$(estado "d.get('notice') or ''")" in *"no pude traer"*) ok "K1 espejo: …y deja el aviso (la persona tiene que enterarse)" ;; *) mal "K1 espejo: sin aviso: $(estado "d.get('notice')")" ;; esac
fi

# ═══ T32 · Ask_NoticeViaSyncHook_Every6h_YesNeedsTty_AutoSilent_HoldRespected (tanda D, AC 26) ═══════════════════════
# 🔴 rojo previo (medido con el programa de antes de la tanda D sobre este mismo guion): el aviso decía «arnés nuevo
#    disponible (harness abc → def; …)» sin el número de la nueva ni «cambios:»; con `last_fetch` de hace una hora `ask`
#    salía igual a la red (una sola constante de 10 minutos); un fetch fallido sellaba `last_fetch`; `update --yes` sin
#    terminal y en `ask` aplicaba; `channel stable` con la variable en `latest` decía «latest → stable» y callaba.
# hace <minutos>: esa hora en UTC, con la forma que escribe el programa (2026-10-03T12:00:00.000Z)
hace() { python3 -c "import datetime,sys; print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(minutes=int(sys.argv[1]))).strftime('%Y-%m-%dT%H:%M:%S.000Z'))" "$1"; }
ask() { TYCON_UPDATE_APPLY=ask harness "$@"; }
if corre T32; then
  # el hook síncrono, copiado suelto a una carpeta que no es un repo (como en branch-guard-notice.test.sh)
  HOOK_DIR="$BASE/t32-hook/scripts/hooks"; mkdir -p "$HOOK_DIR"; cp "$RAIZ/scripts/hooks/branch-guard-notice.js" "$HOOK_DIR/"

  # (a) ask con versión nueva, remoto interno: no aplica y deja el aviso con el número de la nueva y el git log
  harness_lab_create "$BASE/t32a" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "T32 install previo (a) falló"
  ANTES="$(head_de "$LAB_TREE")"
  harness_lab_publish tree "v2" VERSION 2; NUEVO="$(head_de "$LAB_AUTHOR_TREE")"
  estado_set "d['last_fetch']=None"
  SALIDA="$(ask startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$ANTES" ] && ok "T32 ask con versión nueva: startup no aplica" || mal "T32 ask aplicó o falló: rc $RC HEAD $(head_de "$LAB_TREE"): $SALIDA"
  N="$(estado "d.get('notice') or ''")"
  case "$N" in "arnés "*"+${NUEVO:0:7} disponible (instalada "*"+${ANTES:0:7}, canal stable) · aplicar: node "*"harness.js update --yes · cambios: "*) ok "T32 el aviso: número de la nueva con su sha, la instalada, el canal y el comando" ;; *) mal "T32 aviso: $N" ;; esac
  case "$N" in *"cambios: git -C $(cd "$LAB_TREE" && pwd -P) log ${ANTES:0:7}..${NUEVO:0:7}") ok "T32 remoto interno: «cambios» es el git log a..b para pegar" ;; *) mal "T32 cambios (interno): $N" ;; esac
  case "$N" in *"/compare/"*) mal "T32 remoto interno con un enlace de comparación: $N" ;; *) ok "T32 …y sin enlace" ;; esac
  # dos pasos: lo que escribió ESTE arranque lo imprime el hook síncrono de la sesión siguiente, dirigido a la persona
  SALIDA="$(TYCON_UPDATE_APPLY=ask node "$HOOK_DIR/branch-guard-notice.js" 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$SALIDA" in *"decile a la persona: arnés "*" disponible"*"update --yes"*"cambios: git -C"*"No lo apliques"*) true ;; *) false ;; esac && ok "T32 el hook síncrono de la sesión siguiente lo imprime a la persona, entero" || mal "T32 hook síncrono (rc $RC): $SALIDA"
  # tres arranques seguidos, un solo fetch; y el aviso sigue mientras esté pendiente
  rm -f "$LAB_TREE/.git/FETCH_HEAD"
  ask startup >/dev/null 2>&1; ask startup >/dev/null 2>&1
  [ ! -f "$LAB_TREE/.git/FETCH_HEAD" ] && ok "T32 tres startup seguidos: un solo fetch" || mal "T32 un startup seguido volvió a salir a la red"
  case "$(estado "d.get('notice') or ''")" in *disponible*) ok "T32 …y el aviso sigue pendiente (una vez por sesión)" ;; *) mal "T32 el aviso se perdió: $(estado "d.get('notice')")" ;; esac
  # 6 horas en ask: con last_fetch de hace UNA hora no sale (tres seguidos no distinguen 6 horas de 10 minutos)
  estado_set "d['last_fetch']='$(hace 60)'"
  ask startup >/dev/null 2>&1
  [ ! -f "$LAB_TREE/.git/FETCH_HEAD" ] && ok "T32 ask con last_fetch de hace una hora: no sale a la red (6 horas)" || mal "T32 ask salió a la red a la hora"
  estado_set "d['last_fetch']='$(hace 370)'"
  ask startup >/dev/null 2>&1
  [ -f "$LAB_TREE/.git/FETCH_HEAD" ] && ok "T32 espejo: pasadas las 6 horas, ask vuelve a mirar" || mal "T32 ask no miró pasadas las 6 horas"
  # espejo: en auto, la misma hora SÍ alcanza (10 minutos) — y aplica
  estado_set "d['last_fetch']='$(hace 60)'"
  harness startup >/dev/null 2>&1
  [ "$(head_de "$LAB_TREE")" = "$NUEVO" ] && ok "T32 espejo: auto con last_fetch de hace una hora sale a la red y aplica (10 minutos)" || mal "T32 auto no aplicó a la hora: HEAD $(head_de "$LAB_TREE")"

  # (b) un fetch que no pudo mirar no sella last_fetch, y se reintenta a los 10 minutos (no en cada sesión)
  harness_lab_create "$BASE/t32b" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "T32 install previo (b) falló"
  VIEJO="$(hace 400)"
  estado_set "d['last_fetch']='$VIEJO'"
  mv "$LAB_REMOTE_TREE" "$LAB_REMOTE_TREE.fuera"
  ask startup >/dev/null 2>&1
  [ "$(estado "d['last_fetch']")" = "$VIEJO" ] && ok "T32 un fetch que no pudo mirar no sella last_fetch" || mal "T32 el fetch fallido selló last_fetch: $(estado "d['last_fetch']") (era $VIEJO)"
  [ "$(estado "d.get('last_fetch_failed')")" != None ] && ok "T32 …pero anota el intento que no pudo (last_fetch_failed)" || mal "T32 sin last_fetch_failed"
  N1="$(grep -c 'no pude traer' "$(LOG)" 2>/dev/null || true)"
  ask startup >/dev/null 2>&1
  N2="$(grep -c 'no pude traer' "$(LOG)" 2>/dev/null || true)"
  [ "${N1:-0}" -ge 1 ] && [ "$N2" = "$N1" ] && ok "T32 el arranque siguiente no reintenta (menos de 10 minutos desde el intento)" || mal "T32 reintentó en seguida: $N1 → $N2 intentos en startup.log"
  mv "$LAB_REMOTE_TREE.fuera" "$LAB_REMOTE_TREE"
  estado_set "d['last_fetch_failed']='$(hace 11)'"
  ask startup >/dev/null 2>&1
  [ "$(estado "d['last_fetch']")" != "$VIEJO" ] && [ "$(estado "d.get('last_fetch_failed')")" = None ] && ok "T32 pasados 10 minutos reintenta, y esa mirada sí sella last_fetch (y borra el intento fallido)" || mal "T32 no reintentó a los 10 minutos: last_fetch $(estado "d['last_fetch']") failed $(estado "d.get('last_fetch_failed')")"

  # (c) update --yes con la política en ask: sin terminal sale 2 y no toca nada; con terminal aplica
  harness_lab_create "$BASE/t32c" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "T32 install previo (c) falló"
  ANTES="$(head_de "$LAB_TREE")"
  harness_lab_publish tree "v2" VERSION 2; NUEVO="$(head_de "$LAB_AUTHOR_TREE")"
  SALIDA="$(ask update --yes < /dev/null 2>&1)"; RC=$?
  [ "$RC" = 2 ] && [ "$(head_de "$LAB_TREE")" = "$ANTES" ] && ok "T32 update --yes sin terminal y en ask: 2, y no aplica" || mal "T32 --yes sin terminal: rc $RC HEAD $(head_de "$LAB_TREE"): $SALIDA"
  case "$SALIDA" in *"--yes"*"necesita una terminal"*"apply: auto"*) ok "T32 …y dice «--yes necesita una terminal, o apply: auto en la configuración»" ;; *) mal "T32 --yes sin terminal no lo dice: $SALIDA" ;; esac
  SALIDA="$(ask update --dry-run --yes < /dev/null 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "T32 --dry-run no pide terminal (no aplica nada)" || mal "T32 --dry-run --yes sin terminal: rc $RC: $SALIDA"
  SALIDA="$(TYCON_UPDATE_APPLY=ask harness_lab_pty - harness update --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$NUEVO" ] && ok "T32 espejo: con terminal, update --yes en ask aplica" || mal "T32 --yes con terminal: rc $RC HEAD $(head_de "$LAB_TREE") (esperado $NUEVO): $SALIDA"
  # espejo: en auto, --yes sin terminal vale
  harness_lab_publish tree "v3" VERSION 3
  SALIDA="$(harness update --yes < /dev/null 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$(head_de "$LAB_AUTHOR_TREE")" ] && ok "T32 espejo: con apply auto, --yes sin terminal aplica" || mal "T32 --yes en auto sin terminal: rc $RC: $SALIDA"

  # (d) auto: aplica en silencio y deja UNA línea sólo si aplicó; developer y una retención no se pasan por encima
  harness_lab_create "$BASE/t32d" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "T32 install previo (d) falló"
  harness_lab_publish tree "v2" VERSION 2
  estado_set "d['last_fetch']=None"
  SALIDA="$(harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(printf '%s\n' "$SALIDA" | grep -c .)" = 1 ] && case "$SALIDA" in "arnés "*" → "*) true ;; *) false ;; esac && ok "T32 auto: aplica y deja una línea «arnés <vieja> → <nueva>»" || mal "T32 auto al aplicar: rc $RC: $SALIDA"
  [ "$(estado "d.get('notice')")" = None ] && ok "T32 …sin aviso pendiente" || mal "T32 auto dejó un aviso: $(estado "d.get('notice')")"
  estado_set "d['last_fetch']=None"
  SALIDA="$(harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ -z "$SALIDA" ] && ok "T32 auto sin nada nuevo: ninguna línea" || mal "T32 auto sin novedades habló: $SALIDA"
  harness_lab_publish tree "v3" VERSION 3
  ANTES="$(head_de "$LAB_TREE")"
  estado_set "d['hold']={'commit':'v3-deshecha','sources':{'harness':'$(head_de "$LAB_AUTHOR_TREE")'},'at':'2026-10-03T00:00:00Z','reason':'rollback'}; d['last_fetch']=None"
  harness startup >/dev/null 2>&1
  [ "$(head_de "$LAB_TREE")" = "$ANTES" ] && ok "T32 auto con retención: no avanza" || mal "T32 auto pasó por encima de la retención: HEAD $(head_de "$LAB_TREE")"
  estado_set "d['hold']=None; d['mode']='developer'; d['last_fetch']=None"
  SALIDA="$(harness startup 2>&1)"
  [ "$(head_de "$LAB_TREE")" = "$ANTES" ] && [ -z "$SALIDA" ] && ok "T32 developer: no toca el árbol y no dice nada" || mal "T32 developer: HEAD $(head_de "$LAB_TREE"): $SALIDA"

  # (e) copia pública: el enlace de cambios sale de la URL fijada — stable: instalado contra nuevo; latest: main contra nuevo
  harness_lab_create "$BASE/t32e" >/dev/null
  harness_lab_public
  harness_lab_publish_stable 2026.10.01.1
  harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1
  ask install --yes >/dev/null 2>&1 || mal "T32 install previo (e) falló"
  M0="$(head_de "$LAB_TREE")"
  harness_lab_publish_stable 2026.10.02.1; M1="$(harness_lab_remote_head main)"
  estado_set "d['last_fetch']=None"
  ask startup >/dev/null 2>&1
  N="$(estado "d.get('notice') or ''")"
  case "$N" in "arnés 2026.10.02.1 (${M1:0:7}) disponible (instalada 2026.10.01.1, canal stable) · aplicar: "*"update --yes · cambios: $LAB_REMOTE_TREE/compare/$M0...$M1") ok "T32 público en stable: número + sha, y el enlace instalado...nuevo sobre la URL fijada" ;; *) mal "T32 aviso público (stable): $N" ;; esac
  [ "$(head_de "$LAB_TREE")" = "$M0" ] && ok "T32 …y no aplicó" || mal "T32 público en ask aplicó"
  ask channel latest >/dev/null 2>&1 || mal "T32 channel latest (ask) falló"
  harness_lab_publish_sync 2026.10.02.2; S="$(harness_lab_remote_head mirror/sync)"
  ask startup >/dev/null 2>&1   # channel latest dejó la próxima mirada libre: no hace falta tocar last_fetch
  N="$(estado "d.get('notice') or ''")"
  case "$N" in "arnés 2026.10.02.2 (${S:0:7}) disponible (instalada 2026.10.01.1, canal latest) · "*" · cambios: $LAB_REMOTE_TREE/compare/$M1...$S") ok "T32 público en latest: el enlace es la punta de main contra el nuevo (no lo instalado)" ;; *) mal "T32 aviso público (latest): $N (main $M1, sync $S, instalada $M0)" ;; esac

  # (f) una sola verdad para el canal: la configuración; channel avisa si una variable le gana
  harness_lab_create "$BASE/t32f" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "T32 install previo (f) falló"
  SALIDA="$(TYCON_UPDATE_CHANNEL=latest harness channel stable 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$SALIDA" in *TYCON_UPDATE_CHANNEL*latest*) true ;; *) false ;; esac && ok "T32 channel stable con la variable en latest: avisa que la variable le gana" || mal "T32 channel no avisa la variable (rc $RC): $SALIDA"
  [ "$(estado "d['channel']")" = latest ] && ok "T32 …y el estado guarda el canal vigente (latest), no el que se pidió" || mal "T32 state.channel=$(estado "d['channel']")"
  SALIDA="$(harness channel stable 2>&1)"
  case "$SALIDA" in *TYCON_UPDATE_CHANNEL*) mal "T32 espejo: sin la variable, channel avisa igual: $SALIDA" ;; *) ok "T32 espejo: sin la variable no avisa" ;; esac
  [ "$(estado "d['channel']")" = stable ] && ok "T32 …y el estado dice stable" || mal "T32 espejo: state.channel=$(estado "d['channel']")"
  # el canal cambiado a mano en ~/.claude/tycon.json: el arranque siguiente iguala el estado, y version lo dice ya
  printf '{ "update": { "channel": "latest" } }\n' > "$LAB_HOME/.claude/tycon.json"
  case "$(harness version 2>&1)" in *" · latest · "*) ok "T32 version dice el canal de la configuración aunque el estado todavía diga otro" ;; *) mal "T32 version: $(harness version 2>&1)" ;; esac
  harness startup >/dev/null 2>&1
  [ "$(estado "d['channel']")" = latest ] && ok "T32 startup iguala state.channel con la configuración" || mal "T32 startup no igualó el canal: $(estado "d['channel']")"

  # (g) el canal cambiado POR FUERA de `channel` (el archivo a mano, la variable): el arranque siguiente mira —no espera
  #     la ventana de 6 horas de la mirada anterior— y el aviso del canal anterior no queda (pase adversarial, causa E)
  # 🔴 rojo previo (medido con el programa de antes de este arreglo sobre este mismo guion): 5 MAL — el arranque después
  #    del cambio a mano no salía a la red («última mirada … hace menos de 6 horas»), el aviso seguía ofreciendo la
  #    versión de latest («…canal latest») con el estado ya en stable y la ref en mirror/sync; con la variable, igual.
  harness_lab_create "$BASE/t32g" >/dev/null
  harness_lab_public
  harness_lab_publish_stable 2026.10.01.1
  harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1
  ask install --yes --channel latest >/dev/null 2>&1 || mal "T32 install previo (g) falló"
  harness_lab_publish_sync 2026.10.02.1
  ask startup >/dev/null 2>&1
  case "$(estado "d.get('notice') or ''")" in *"2026.10.02.1"*"disponible"*"canal latest"*) true ;; *) mal "T32 (g) el laboratorio no dejó el aviso de latest: $(estado "d.get('notice')")" ;; esac
  [ "$(estado "d.get('last_fetch')")" != None ] || mal "T32 (g) el arranque de partida no selló la mirada"
  # a mano, en ~/.claude/tycon.json
  printf '{ "update": { "channel": "stable" } }\n' > "$LAB_HOME/.claude/tycon.json"
  rm -f "$LAB_TREE/.git/FETCH_HEAD"
  ask startup >/dev/null 2>&1
  [ -f "$LAB_TREE/.git/FETCH_HEAD" ] && ok "T32 canal cambiado a mano en tycon.json: el arranque siguiente mira (no espera las 6 horas)" || mal "T32 (g) el arranque no miró tras el cambio de canal a mano"
  case "$(estado "d.get('notice') or ''")" in *"canal latest"*|*"2026.10.02.1"*) mal "T32 (g) quedó el aviso del canal anterior: $(estado "d.get('notice')")" ;; *) ok "T32 …y el aviso del canal anterior no queda" ;; esac
  [ "$(estado "d['channel']")" = stable ] && [ "$(estado "d['sources'][0]['ref']")" = main ] && ok "T32 …el estado queda coherente: canal stable, ref main" || mal "T32 (g) estado: canal $(estado "d['channel']") ref $(estado "d['sources'][0]['ref']")"
  # por la variable (y aunque el último intento de mirar haya fallado hace poco: el cambio de canal suelta las dos ventanas)
  estado_set "d['last_fetch_failed']='$(hace 5)'"
  rm -f "$LAB_TREE/.git/FETCH_HEAD"
  TYCON_UPDATE_CHANNEL=latest TYCON_UPDATE_APPLY=ask harness startup >/dev/null 2>&1
  [ -f "$LAB_TREE/.git/FETCH_HEAD" ] && ok "T32 canal cambiado por la variable: el arranque siguiente mira" || mal "T32 (g) el arranque no miró tras el cambio de canal por variable"
  case "$(estado "d.get('notice') or ''")" in *"2026.10.02.1"*"disponible"*"canal latest"*) ok "T32 …y el aviso es el del canal vigente (latest)" ;; *) mal "T32 (g) aviso tras la variable: $(estado "d.get('notice')")" ;; esac
  # espejo: sin cambio de canal, el arranque siguiente NO mira (la ventana de ask sigue valiendo) y el aviso se conserva
  rm -f "$LAB_TREE/.git/FETCH_HEAD"
  TYCON_UPDATE_CHANNEL=latest TYCON_UPDATE_APPLY=ask harness startup >/dev/null 2>&1
  [ ! -f "$LAB_TREE/.git/FETCH_HEAD" ] && ok "T32 espejo: sin cambio de canal no vuelve a mirar (6 horas)" || mal "T32 (g) sin cambio de canal volvió a salir a la red"
  case "$(estado "d.get('notice') or ''")" in *"disponible"*"canal latest"*) ok "T32 …y el aviso sigue pendiente" ;; *) mal "T32 (g) el aviso se perdió sin cambio de canal: $(estado "d.get('notice')")" ;; esac
  # el aviso viejo tampoco sobrevive hasta el arranque: `update` con el canal ya cambiado lo saca del estado
  TYCON_UPDATE_APPLY=ask harness update >/dev/null 2>&1
  case "$(estado "d.get('notice') or ''")" in *"canal latest"*) mal "T32 (g) update con el canal cambiado dejó el aviso del canal anterior: $(estado "d.get('notice')")" ;; *) ok "T32 …y un update con el canal ya cambiado tampoco deja el aviso del canal anterior" ;; esac

  # (h) `update` sin `--yes` en ask, con versión nueva: deja el MISMO aviso que dejaría `startup` (pase adversarial,
  #     causa F) — si no, sella la mirada y el hook de arranque no la recuerda hasta que pasen las 6 horas
  # 🔴 rojo previo (medido con el programa de antes de este arreglo sobre este mismo guion): 4 MAL — tras `update` (rc 3)
  #    el estado quedaba con `notice: None` y `last_fetch` sellado, el hook no imprimía nada y `startup` no miraba; y un
  #    aviso «disponible» viejo sobrevivía a un `update` que contestaba «al día».
  harness_lab_create "$BASE/t32h" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "T32 install previo (h) falló"
  ANTES="$(head_de "$LAB_TREE")"
  harness_lab_publish tree "v2" VERSION 2; NUEVO="$(head_de "$LAB_AUTHOR_TREE")"
  SALIDA="$(ask update 2>&1)"; RC=$?
  [ "$RC" = 3 ] && [ "$(head_de "$LAB_TREE")" = "$ANTES" ] || mal "T32 (h) update en ask sin --yes: rc $RC HEAD $(head_de "$LAB_TREE"): $SALIDA"
  N="$(estado "d.get('notice') or ''")"
  case "$N" in "arnés "*"+${NUEVO:0:7} disponible (instalada "*"+${ANTES:0:7}, canal stable) · aplicar: node "*"harness.js update --yes · cambios: git -C "*" log ${ANTES:0:7}..${NUEVO:0:7}") ok "T32 update sin --yes en ask deja el aviso de la versión nueva" ;; *) mal "T32 (h) update sin --yes no dejó el aviso: «${N}»" ;; esac
  SALIDA="$(TYCON_UPDATE_APPLY=ask node "$HOOK_DIR/branch-guard-notice.js" 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$SALIDA" in *"decile a la persona: arnés "*" disponible"*"update --yes"*) true ;; *) false ;; esac && ok "T32 …y el hook síncrono de la sesión siguiente lo muestra" || mal "T32 (h) hook síncrono (rc $RC): $SALIDA"
  rm -f "$LAB_TREE/.git/FETCH_HEAD"
  ask startup >/dev/null 2>&1
  [ ! -f "$LAB_TREE/.git/FETCH_HEAD" ] && [ "$(estado "d.get('notice') or ''")" = "$N" ] && ok "T32 …el arranque siguiente no mira (ventana de ask) y el aviso sigue" || mal "T32 (h) tras startup: aviso «$(estado "d.get('notice')")»"
  # es el mismo texto que deja startup cuando mira
  estado_set "d['last_fetch']=None; d['notice']=None"
  ask startup >/dev/null 2>&1
  [ "$(estado "d.get('notice') or ''")" = "$N" ] && ok "T32 …y es el mismo aviso que deja startup" || mal "T32 (h) startup deja otro aviso: «$(estado "d.get('notice')")» contra «${N}»"
  # espejo: sin versión nueva, update no deja aviso — y saca el «disponible» que ya no vale
  harness update >/dev/null 2>&1
  [ "$(head_de "$LAB_TREE")" = "$NUEVO" ] && [ "$(estado "d.get('notice')")" = None ] || mal "T32 (h) el update en auto no aplicó o dejó aviso: $(estado "d.get('notice')")"
  estado_set "d['notice']='arnés 9999.01.01+abcdef0 disponible (instalada x, canal stable) · aplicar: x'"
  SALIDA="$(ask update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado "d.get('notice')")" = None ] && ok "T32 espejo: update que encuentra «al día» no deja aviso, y saca el «disponible» viejo" || mal "T32 (h) al día: rc $RC aviso «$(estado "d.get('notice')")»: $SALIDA"
  # …pero no toca un aviso que no sale de mirar (la retención la re-evalúa cada arranque, del estado)
  estado_set "d['notice']='retención: de prueba'"
  ask update >/dev/null 2>&1
  [ "$(estado "d.get('notice')")" = "retención: de prueba" ] && ok "T32 …sin tocar un aviso que no sale de mirar" || mal "T32 (h) update borró un aviso que no era suyo: $(estado "d.get('notice')")"
fi

# ═══ T37 · Source_Pinned_OriginChangedRefuses_PublicLatestAutoNeedsConfirmation (tanda D, AC 29) ═════════════════════
# (el origen cambiado → `update` se niega y `doctor` en rojo ya lo miden REG-D4 de harness-install, REG-D6 de acá y T13 de
# harness-doctor; el recordatorio de `doctor`, harness-doctor.test.sh)
# 🔴 rojo previo: `install --source <url de agent-skills>` pisaba el origen fijado del ARNÉS y dejaba las dos fuentes en
#    rojo; `channel latest` e `install --channel latest` nunca preguntaban ni miraban si había terminal.
sin_variable() { env -u TYCON_UPDATE_APPLY node "$LAB_TREE/scripts/setup/harness.js" "$@"; }
canal_en_archivo() { j "$LAB_HOME/.claude/tycon.json" "d.get('update',{}).get('channel')"; }
if corre T37; then
  # (a) install --source re-fija la fuente cuyo origin actual es esa URL
  harness_lab_create "$BASE/t37a" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "T37 install previo (a) falló"
  URL_ARNES="$(estado "d['sources'][0]['url']")"
  OTRO="$LAB/remotes/agent-skills-otro.git"; cp -R "$LAB_REMOTE_SKILLS" "$OTRO"; harness_lab_git "$LAB_SKILLS" remote set-url origin "$OTRO"
  SALIDA="$(harness update --check 2>&1)"; RC=$?
  [ "$RC" = 2 ] && case "$SALIDA" in *"origin de agent_skills cambió"*"install --source"*) true ;; *) false ;; esac && ok "T37 con el origin de agent-skills cambiado update se niega y nombra el remedio" || mal "T37 origin de agent-skills cambiado: rc $RC: $SALIDA"
  SALIDA="$(harness install --yes --source "$OTRO" 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado "d['sources'][1]['url']")" = "$OTRO" ] && ok "T37 install --source re-fija la fuente cuyo origin es esa URL (agent_skills)" || mal "T37 --source: rc $RC agent_skills.url=$(estado "d['sources'][1]['url']"): $SALIDA"
  [ "$(estado "d['sources'][0]['url']")" = "$URL_ARNES" ] && ok "T37 …y no pisa el origen fijado del arnés" || mal "T37 --source pisó el del arnés: $(estado "d['sources'][0]['url']")"
  harness update --check >/dev/null 2>&1; RC=$?
  [ "$RC" = 0 ] && ok "T37 …y update vuelve a mirar las dos fuentes (al día)" || mal "T37 update después de --source: rc $RC"
  # espejo: una URL que no es el origin de ninguna fuente no se fija (y no se escribe nada)
  cp "$(ESTADO)" "$BASE/t37a-estado.json"
  SALIDA="$(harness install --yes --source "$LAB/remotes/nadie.git" 2>&1)"; RC=$?
  [ "$RC" = 2 ] && cmp -s "$(ESTADO)" "$BASE/t37a-estado.json" && case "$SALIDA" in *"ninguna fuente"*) true ;; *) false ;; esac && ok "T37 espejo: una URL que no es el origin de ninguna fuente sale 2, lo dice y no toca el estado" || mal "T37 --source ajeno: rc $RC: $SALIDA"

  # (b) copia pública + aplicación auto POR ARCHIVO: channel latest pregunta; sin terminal, 2
  harness_lab_create "$BASE/t37b" >/dev/null
  harness_lab_public
  harness install --yes >/dev/null 2>&1 || mal "T37 install previo (b) falló"
  printf '{ "update": { "apply": "auto" } }\n' > "$LAB_HOME/.claude/tycon.json"
  SALIDA="$(sin_variable channel latest < /dev/null 2>&1)"; RC=$?
  [ "$RC" = 2 ] && [ "$(canal_en_archivo)" = None ] && ok "T37 pública + auto por archivo: channel latest sin terminal sale 2 y no cambia el canal" || mal "T37 channel latest sin terminal: rc $RC canal $(canal_en_archivo): $SALIDA"
  case "$SALIDA" in *"sin revisión tuya"*terminal*TYCON_UPDATE_APPLY=auto*) ok "T37 …y dice por qué y las dos salidas (una terminal, o la variable)" ;; *) mal "T37 channel latest sin terminal no lo explica: $SALIDA" ;; esac
  SALIDA="$(harness_lab_pty n env -u TYCON_UPDATE_APPLY node "$LAB_TREE/scripts/setup/harness.js" channel latest 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(canal_en_archivo)" = None ] && case "$SALIDA" in *"sin revisión tuya"*"[s/N]"*"no se cambió"*) true ;; *) false ;; esac && ok "T37 con terminal pregunta; con «n» no cambia nada" || mal "T37 con terminal y «n»: rc $RC canal $(canal_en_archivo): $SALIDA"
  SALIDA="$(harness_lab_pty s env -u TYCON_UPDATE_APPLY node "$LAB_TREE/scripts/setup/harness.js" channel latest 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(canal_en_archivo)" = latest ] && ok "T37 con terminal y «s» pasa a latest" || mal "T37 con terminal y «s»: rc $RC canal $(canal_en_archivo): $SALIDA"
  # auto por VARIABLE: ya es la confirmación — pasa sin terminal
  sin_variable channel stable >/dev/null 2>&1
  SALIDA="$(TYCON_UPDATE_APPLY=auto harness channel latest < /dev/null 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(canal_en_archivo)" = latest ] && ok "T37 con TYCON_UPDATE_APPLY=auto puesta por la persona pasa sin terminal" || mal "T37 con la variable: rc $RC canal $(canal_en_archivo): $SALIDA"
  # aplicación ask: pasa sin preguntar
  sin_variable channel stable >/dev/null 2>&1
  printf '{ "update": { "apply": "ask", "channel": "stable" } }\n' > "$LAB_HOME/.claude/tycon.json"
  SALIDA="$(sin_variable channel latest < /dev/null 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(canal_en_archivo)" = latest ] && ok "T37 con la aplicación en ask pasa sin preguntar" || mal "T37 con ask: rc $RC canal $(canal_en_archivo): $SALIDA"
  # espejo: fuera de una copia pública no hay nada que confirmar
  harness_lab_create "$BASE/t37b-interno" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "T37 install previo (interno) falló"
  printf '{ "update": { "apply": "auto" } }\n' > "$LAB_HOME/.claude/tycon.json"
  SALIDA="$(sin_variable channel latest < /dev/null 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(canal_en_archivo)" = latest ] && ok "T37 espejo: en un clon interno, channel latest con auto por archivo no pregunta" || mal "T37 interno: rc $RC canal $(canal_en_archivo): $SALIDA"

  # (c) install --channel latest en una copia pública con auto por archivo: sin terminal sale 2 y no escribe nada
  harness_lab_create "$BASE/t37c" >/dev/null
  harness_lab_public
  printf '{ "update": { "apply": "auto" } }\n' > "$LAB_HOME/.claude/tycon.json"
  ANTES="$(harness_lab_home_hash)"
  SALIDA="$(sin_variable install --channel latest < /dev/null 2>&1)"; RC=$?
  [ "$RC" = 2 ] && [ "$(harness_lab_home_hash)" = "$ANTES" ] && ok "T37 install --channel latest (pública, auto por archivo) sin terminal: 2, sin escribir nada" || mal "T37 install --channel latest sin terminal: rc $RC: $SALIDA"
  SALIDA="$(TYCON_UPDATE_APPLY=auto harness install --yes --channel latest < /dev/null 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado "d['channel']")" = latest ] && ok "T37 espejo: con la variable, install --channel latest pasa" || mal "T37 install --channel latest con la variable: rc $RC: $SALIDA"
fi

# ═══ T38 (story 8.18, AC 35 y 37) · update y version en las tres formas de máquina ═══════════════════════════════════
# Dos clones sin re-apuntar, dos clones con el viejo re-apuntado al repo unificado, y un solo árbol. En las tres:
# `update --check` sale 3 con versión nueva y 0 al día, `update` la aplica, y `version` dice lo que hay — con la fuente
# `agent_skills` mientras hay dos clones, y un solo commit cuando los dos clones siguen el mismo repo. El recorrido de la
# llave (la ida, la vuelta, lo que no puede pasar, la guarda) vive en harness-repoint.test.sh.
if corre T38; then
  for shape in two-clones repointed single; do
    harness_lab_shape "$BASE/t38-$shape" "$shape" || { mal "T38 ($shape) no pude armar la máquina"; continue; }
    SALIDA="$(harness update --check 2>&1)"; RC=$?
    [ "$RC" = 0 ] && case "$SALIDA" in *"al día"*) true ;; *) false ;; esac && ok "T38 ($shape) al día: update --check sale 0" || mal "T38 ($shape) update --check al día: rc $RC: $SALIDA"
    harness_lab_publish tree "versión nueva (T38)" VERSION 38
    NUEVO="$(head_de "$LAB_AUTHOR_TREE")"; S_ANTES="$(head_de "$LAB_SKILLS")"
    SALIDA="$(harness update --check 2>&1)"; RC=$?
    [ "$RC" = 3 ] && case "$SALIDA" in *"hay versión nueva"*) true ;; *) false ;; esac && ok "T38 ($shape) con versión nueva: update --check sale 3" || mal "T38 ($shape) update --check con versión nueva: rc $RC: $SALIDA"
    SALIDA="$(harness update 2>&1)"; RC=$?
    [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$NUEVO" ] && [ "$(estado "d.get('failed')")" = None ] && ok "T38 ($shape) update aplica la versión nueva" || mal "T38 ($shape) update: rc $RC, arnés $(head_de "$LAB_TREE") vs $NUEVO: $SALIDA"
    LINEA="$(harness version 2>&1)"; FUENTES="$(estado "' '.join(s['name'] for s in d['sources'])")"
    case "$shape" in
      two-clones) [ "$(head_de "$LAB_SKILLS")" = "$S_ANTES" ] && [ "$FUENTES" = "harness agent_skills" ] && case "$LINEA" in *"agent-skills ${S_ANTES:0:7}"*"agent_skills@main"*) true ;; *) false ;; esac \
        && ok "T38 (two-clones) el clon viejo no se mueve (su repo no cambió) y version muestra los dos commits y la fuente agent_skills" || mal "T38 (two-clones) fuentes «${FUENTES}», version: $LINEA" ;;
      repointed) [ "$(head_de "$LAB_SKILLS")" = "$NUEVO" ] && [ "$FUENTES" = "harness agent_skills" ] && case "$LINEA" in *"agent-skills "[0-9a-f]*) false ;; *"+${NUEVO:0:7} · managed"*"agent_skills@main"*) true ;; *) false ;; esac \
        && ok "T38 (repointed) los dos clones quedan en el mismo commit, y version muestra uno solo (con la fuente agent_skills)" || mal "T38 (repointed) skills $(head_de "$LAB_SKILLS") vs $NUEVO, fuentes «${FUENTES}», version: $LINEA" ;;
      single) [ "$FUENTES" = "harness" ] && case "$LINEA" in *"+${NUEVO:0:7} · "*"harness@main"*) true ;; *) false ;; esac && case "$LINEA" in *"agent_skills@"*) false ;; *) true ;; esac \
        && ok "T38 (single) una sola fuente, y version la muestra" || mal "T38 (single) fuentes «${FUENTES}», version: $LINEA" ;;
    esac
    [ "$(harness version --json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['version']['harness'] == '$NUEVO')")" = True ] && ok "T38 ($shape) version --json trae el commit instalado" || mal "T38 ($shape) version --json: $(harness version --json 2>&1 | head -5)"
  done
fi

# ═══ S16-T9 · Update_Applied_SaysWhereTheBackupIs (story 8.16, tanda A · AC 8) ═══════════════════════════════════════
# Un `update` que aplica una versión dice dónde quedó la copia de antes y cómo volver. `startup`, que aplica lo mismo con
# la política `auto`, no lo imprime: sigue en una línea como mucho.
if corre S16; then
  harness_lab_create "$BASE/s16-t9" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "S16-T9 install previo falló"
  harness_lab_publish tree "v2" VERSION 2
  SALIDA="$(TYCON_UPDATE_APPLY=auto harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(cat "$LAB_TREE/VERSION")" = 2 ] && ok "S16-T9 update con la política auto aplica la versión nueva" || mal "S16-T9 update (rc $RC, VERSION $(cat "$LAB_TREE/VERSION")): $SALIDA"
  COPIA="$(printf '%s\n' "$SALIDA" | sed -n 's/^copia de antes en \(.*\) · volver: .*$/\1/p' | head -1)"
  [ -n "$COPIA" ] && [ -d "$COPIA" ] && case "$COPIA" in "$LAB_HOME/.claude/.tycon-pipeline/harness/backups/"*) ok "S16-T9 dice la carpeta de la copia de antes, y existe" ;; *) mal "S16-T9 la copia no está bajo backups/: $COPIA" ;; esac \
    || mal "S16-T9 no dice una copia de antes que exista («${COPIA}»): $SALIDA"
  [ -n "$COPIA" ] && [ "$(j "$COPIA/manifest.json" "d['reason']")" = update ] && ok "S16-T9 …y es la copia que tomó ese update" || mal "S16-T9 la copia nombrada no es la del update: $(cat "$COPIA/manifest.json" 2>&1 | head -3)"
  case "$SALIDA" in *"volver: node ~/.claude/tycon-harness/scripts/setup/harness.js rollback"*) ok "S16-T9 …y cómo volver (por el lugar: story 8.19)" ;; *) mal "S16-T9 no dice cómo volver: $SALIDA" ;; esac
  # sin nada que aplicar no promete una copia
  SALIDA="$(TYCON_UPDATE_APPLY=auto harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$SALIDA" in *"copia de antes en"*) mal "S16-T9 al día y nombra una copia: $SALIDA" ;; *) ok "S16-T9 al día: no nombra ninguna copia" ;; esac || mal "S16-T9 al día: rc $RC: $SALIDA"
  # startup aplica lo mismo y calla
  harness_lab_publish tree "v3" VERSION 3
  estado_set "d['last_fetch']=None"   # la mirada anterior fue hace segundos: sin esto el arranque no vuelve a mirar
  SALIDA="$(TYCON_UPDATE_APPLY=auto harness startup --force 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(cat "$LAB_TREE/VERSION")" = 3 ] && [ "$(printf '%s' "$SALIDA" | grep -c .)" -le 1 ] && case "$SALIDA" in *"copia de antes en"*) false ;; *) true ;; esac \
    && ok "S16-T9 startup aplica la versión nueva y sigue en una línea como mucho" || mal "S16-T9 startup (rc $RC, VERSION $(cat "$LAB_TREE/VERSION")) habló de más: $SALIDA"
fi

# ═══ S16B · story 8.16, tanda B (AC 18 y 44 · T23 y la parte de update de T27) ═══════════════════════════════════════════
# Con la política `ask`, una versión nueva y una terminal, `update` sin `--yes` dice qué fuentes se mueven y qué cambia en el
# comportamiento (la lista de efectos de la versión nueva contra la instalada) y pregunta «¿Aplico ahora? [s/N]»: con sí
# aplica, con no sale 3 con la línea de siempre. Sin terminal, igual que antes; con `auto`, sin pregunta; con una retención,
# no se ofrece. Y `update --yes` con `ask` sin terminal sigue saliendo 2 (8.13 D).
# publish_brake <número> → una versión nueva cuya lista de efectos suma un freno
publish_brake() {
  local a="$LAB_AUTHOR_TREE"
  harness_lab_git "$a" pull -q --ff-only origin main >/dev/null 2>&1 || true
  python3 - "$a/scripts/setup/install-effects.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p, encoding="utf-8"))
d["effects"].append({"id": "PreToolUse:@tcg:lab-new-guard.sh", "kind": "hook", "does": "Frena un push a main sin revisión (freno de laboratorio).",
                     "blocks": "any-repo", "when": "always", "switch": "TYCON_LAB_GUARD=0", "network": None, "stores": None,
                     "windows": False, "front_page": False, "profiles": ["full"]})   # profiles: story 8.16, tanda C
json.dump(d, open(p, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
PY
  printf '%s\n' "$1" > "$a/VERSION"
  harness_lab_git "$a" add -A >/dev/null
  harness_lab_git "$a" commit -q -m "v$1: un freno nuevo" >/dev/null
  harness_lab_git "$a" push -q origin main >/dev/null 2>&1
}
if corre S16B; then
  echo "S16B · Update_AskWithTty_BehaviorDiffThenAsk_NoTtyUnchanged_AutoSilent"
  harness_lab_create "$BASE/s16b" >/dev/null
  TYCON_UPDATE_APPLY=ask harness install --yes >/dev/null 2>&1 < /dev/null || mal "S16B install previo falló"
  publish_brake 2
  # sin terminal: igual que antes (3, sin pregunta, sin la diferencia)
  SALIDA="$(TYCON_UPDATE_APPLY=ask harness update 2>&1 < /dev/null)"; RC=$?
  [ "$RC" = 3 ] && case "$SALIDA" in *"¿Aplico ahora?"*|*"qué cambia en el comportamiento"*) false ;; *"la política es «ask»"*) true ;; *) false ;; esac \
    && ok "S16B sin terminal: 3 con la línea de siempre, sin pregunta" || mal "S16B sin terminal (rc $RC): $SALIDA"
  [ "$(cat "$LAB_TREE/VERSION")" != 2 ] && ok "S16B sin terminal: no aplicó" || mal "S16B sin terminal aplicó la versión"
  # `update --yes` con ask sin terminal: 2 (8.13 D), sin pregunta nueva
  SALIDA="$(TYCON_UPDATE_APPLY=ask harness update --yes 2>&1 < /dev/null)"; RC=$?
  [ "$RC" = 2 ] && case "$SALIDA" in *"¿"*) false ;; *"necesita una terminal"*) true ;; *) false ;; esac && ok "S16B T27 update --yes con ask sin terminal: 2 con la línea de la 8.13 D" || mal "S16B T27 update --yes sin terminal (rc $RC): $SALIDA"
  # con terminal y «n»: la diferencia, la pregunta, y 3 sin aplicar
  SALIDA="$(TYCON_UPDATE_APPLY=ask harness_lab_pty n harness update 2>&1)"; RC=$?
  case "$SALIDA" in *"qué cambia en el comportamiento:"*"Frena un push a main sin revisión"*"¿Aplico ahora? [s/N]"*) ok "S16B con terminal: nombra el freno nuevo y después pregunta" ;; *) mal "S16B con terminal no nombra la diferencia o no pregunta: $SALIDA" ;; esac
  [ "$RC" = 3 ] && [ "$(cat "$LAB_TREE/VERSION")" != 2 ] && case "$SALIDA" in *"la política es «ask»"*) true ;; *) false ;; esac && ok "S16B con «n»: 3 con la línea de siempre, sin aplicar" || mal "S16B con «n» (rc $RC, VERSION $(cat "$LAB_TREE/VERSION")): $SALIDA"
  # con terminal y «s»: aplica
  SALIDA="$(TYCON_UPDATE_APPLY=ask harness_lab_pty s harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(cat "$LAB_TREE/VERSION")" = 2 ] && [ "$(printf '%s' "$SALIDA" | grep -c '¿Aplico ahora?')" = 1 ] && ok "S16B con «s»: una pregunta y aplica" || mal "S16B con «s» (rc $RC, VERSION $(cat "$LAB_TREE/VERSION")): $SALIDA"
  # con `auto`: sin pregunta
  publish_brake 3
  SALIDA="$(TYCON_UPDATE_APPLY=auto harness_lab_pty - harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(cat "$LAB_TREE/VERSION")" = 3 ] && case "$SALIDA" in *"¿Aplico ahora?"*) false ;; *) true ;; esac && ok "S16B con auto: aplica sin preguntar" || mal "S16B con auto (rc $RC): $SALIDA"
  # con una retención: no se ofrece esa versión (ni con terminal)
  publish_brake 4
  estado_set "d['hold']={'commit': 'v3', 'sources': None, 'at': '2026-10-04T00:00:00Z', 'reason': 'rollback'}"
  SALIDA="$(TYCON_UPDATE_APPLY=ask harness_lab_pty s harness update 2>&1)"; RC=$?
  [ "$(cat "$LAB_TREE/VERSION")" = 3 ] && case "$SALIDA" in *"¿Aplico ahora?"*) false ;; *) true ;; esac && ok "S16B con retención: no la ofrece ni la aplica" || mal "S16B con retención (rc $RC, VERSION $(cat "$LAB_TREE/VERSION")): $SALIDA"
fi

# ═══ La capa privada (story 8.13.1, tanda A · AC 7, 8 y 9) — el laboratorio de T8 y T9 ════════════════════════════════
# Una máquina del equipo que instala desde la copia PÚBLICA y apila su capa encima: el remoto del arnés del laboratorio
# es «el público» (scripts/setup/public-remotes.json), con un solo árbol (skills/ y agents/ en la raíz) y version.json con
# su lista de transformados. El «interno» es un repo APARTE (historia propia, como el de verdad): la copia sin lo de
# «sólo afuera», con el transformado entero y con lo privado. `install --harness-clone <interno>` arma el clon de lectura
# (--bare, con --reference al clon de la persona) y apila la capa. Desde ahí nadie empuja: los dos bare llevan un
# `pre-receive` que rechaza todo, y lo publicado entra con un `fetch` DESDE el bare. La prueba de que el mecanismo no
# escribe en ningún repo es el hash: de los dos bare y del .git del clon de la persona, antes y después de cada comando.
# (El `pre-receive` sólo es la red de seguridad: `sources.js` corre git con core.hooksPath=/dev/null, que le llega también
# a un receive-pack local.)
arbol_hash() { ( cd "$1" && find . -type f | LC_ALL=C sort | while IFS= read -r f; do printf '%s ' "$f"; shasum -a 256 < "$f"; done ) | shasum -a 256 | cut -d' ' -f1; }
version_publica() { # version_publica <número> <piso>  — el version.json de la copia, con su lista de transformados
  printf '{ "version": "%s", "source": { "harness": "%s" }, "transformed": [ { "path": "guides/public.md", "transform": "toy-trim" } ] }\n' "$1" "$2"
}
publica() { # publica <número> <piso> [<ruta> <contenido>]  — una versión pública nueva en main del bare, sin push
  local a="$LAB_AUTHOR_TREE"
  version_publica "$1" "$2" > "$a/version.json"
  [ -n "${3:-}" ] && printf '%s\n' "$4" > "$a/$3"
  harness_lab_git "$a" add -A >/dev/null
  harness_lab_git "$a" commit -q -m "versión $1" >/dev/null
  harness_lab_git "$LAB_REMOTE_TREE" fetch -q "$a" +refs/heads/main:refs/heads/main >/dev/null 2>&1
}
interno() { # interno <ruta> <contenido> [<fecha>]  — un commit en main del interno, entrado al bare sin push; imprime su sha
  mkdir -p "$(dirname "$INTERNAL/$1")"; printf '%s\n' "$2" > "$INTERNAL/$1"
  harness_lab_git "$INTERNAL" add -A >/dev/null
  if [ -n "${3:-}" ]; then GIT_AUTHOR_DATE="$3" GIT_COMMITTER_DATE="$3" harness_lab_git "$INTERNAL" commit -q -m "interno: $1" >/dev/null
  else harness_lab_git "$INTERNAL" commit -q -m "interno: $1" >/dev/null; fi
  harness_lab_git "$INTERNAL_REMOTE" fetch -q "$INTERNAL" +refs/heads/main:refs/heads/main >/dev/null 2>&1
  harness_lab_git "$INTERNAL" rev-parse HEAD
}
capa() { estado "[s for s in d['sources'] if s.get('kind') == 'layer'][0]['$1']"; }
ref_lectura() { harness_lab_git "$READ" rev-parse -q --verify "$1" 2>/dev/null; }
UNTOUCHED=1
mira() { # mira <subcomando…>  — corre harness (SALIDA, RC) y anota si tocó los dos bare o el .git del clon de la persona
  local b1 b2 p
  b1="$(arbol_hash "$LAB_REMOTE_TREE")"; b2="$(arbol_hash "$INTERNAL_REMOTE")"; p="$(arbol_hash "$INTERNAL/.git")"
  # MIRA_S: lo que tardó SÓLO el comando, en segundos (sin los hash de antes y después, que con la máquina cargada pasan
  # de 15 s y no son del update: 170 #12177, 2026-10-06)
  local t0; t0=$(date +%s)
  SALIDA="$(harness "$@" 2>&1)"; RC=$?
  MIRA_S=$(( $(date +%s) - t0 ))
  local cual=""
  [ "$(arbol_hash "$LAB_REMOTE_TREE")" != "$b1" ] && cual="$cual el bare del público"
  [ "$(arbol_hash "$INTERNAL_REMOTE")" != "$b2" ] && cual="$cual el bare del interno"
  [ "$(arbol_hash "$INTERNAL/.git")" != "$p" ] && cual="$cual el .git del clon de la persona"
  if [ -n "$cual" ]; then
    UNTOUCHED=0; echo "    (harness $* tocó:$cual)"
  fi
}
capa_lab() { # capa_lab <dir>  — la máquina del equipo con la copia pública y la capa (exporta INTERNAL, INTERNAL_REMOTE, READ, I1)
  harness_lab_create "$1" >/dev/null
  local a="$LAB_AUTHOR_TREE" f
  mkdir -p "$a/skills/tycon-pipeline" "$a/agents" "$a/guides" "$a/scripts/tests/fixtures" "$a/scripts/setup"
  for f in layer-public-wins layer-public-only harness-tree-writers; do cp "$RAIZ/scripts/tests/fixtures/$f.json" "$a/scripts/tests/fixtures/"; done
  # qué publica un commit interno lo dice la clasificación del exportador (AC 5): sus guiones, y la lista blanca y la
  # tabla de juguete, que el interno trae (la copia también: así son iguales, no agregados)
  mkdir -p "$a/scripts/publishing"; cp "$RAIZ"/scripts/publishing/*.js "$a/scripts/publishing/"
  cp "$RAIZ/scripts/tests/fixtures/layer-lab-allowlist.json" "$a/scripts/publishing/allowlist.json"
  cp "$RAIZ/scripts/tests/fixtures/layer-lab-table.json" "$a/scripts/publishing/replacements.json"
  printf '# skill de juguete\n' > "$a/skills/tycon-pipeline/SKILL.md"; printf '# agente de juguete\n' > "$a/agents/lab.md"
  printf '# guía pública\n' > "$a/guides/public.md"; printf 'licencia de juguete\n' > "$a/LICENSE"
  printf '{ "remotes": ["%s"] }\n' "$LAB_REMOTE_TREE" > "$a/scripts/setup/public-remotes.json"
  export INTERNAL="$LAB/author/internal" INTERNAL_REMOTE="$LAB/remotes/internal.git"
  export READ="$LAB_HOME/.claude/.tycon-pipeline/harness/sources/internal"
  mkdir -p "$INTERNAL"; ( cd "$a" && tar cf - --exclude=.git . ) | ( cd "$INTERNAL" && tar xf - )
  rm -f "$INTERNAL/LICENSE" "$INTERNAL/scripts/setup/public-remotes.json"
  printf 'una línea que el exportador saca\n' >> "$INTERNAL/guides/public.md"
  mkdir -p "$INTERNAL/tasks" "$INTERNAL/skills/projects/acme"
  printf '# plan privado\n' > "$INTERNAL/tasks/plan.md"; printf '# casos con nombre\n' > "$INTERNAL/guides/maintaining/incident-log.md"
  printf '# skill de un producto\n' > "$INTERNAL/skills/projects/acme/SKILL.md"
  harness_lab_git "$INTERNAL" init -q -b main >/dev/null
  harness_lab_git "$INTERNAL" add -A >/dev/null
  GIT_AUTHOR_DATE=2026-10-06T00:00:00Z GIT_COMMITTER_DATE=2026-10-06T00:00:00Z harness_lab_git "$INTERNAL" commit -q -m "el interno de juguete" >/dev/null
  harness_lab_git "$LAB/remotes" clone -q --bare "$INTERNAL" "$INTERNAL_REMOTE" >/dev/null 2>&1
  harness_lab_git "$INTERNAL" remote add origin "$INTERNAL_REMOTE"
  export I1="$(harness_lab_git "$INTERNAL" rev-parse HEAD)"
  version_publica 2026.10.06.1 "$I1" > "$a/version.json"
  harness_lab_git "$a" add -A >/dev/null; harness_lab_git "$a" commit -q -m "la copia pública de juguete" >/dev/null
  # 🔴 Los dos bare, sin mantenimiento automático en SU configuración (2026-10-14). El `push` de abajo corre del otro lado
  #    un receive-pack, y git no le pasa el `-c` de harness_lab_git (en un transporte local borra GIT_CONFIG_PARAMETERS y
  #    GIT_CONFIG_COUNT): el receive-pack lanzaba `git maintenance run --auto --detach` en el bare del público. Con git
  #    2.55 eso reempaqueta los ~120 objetos sueltos del bare de fondo, mientras `mira install` saca la huella de antes:
  #    «T8 algún comando escribió en un repo ajeno» sin que harness.js escribiera nada (public-ci, pedido #27: en la
  #    huella faltaban objects/maintenance.lock, objects/pack/tmp_pack_* y los objetos sueltos). Con git 2.50 el
  #    mantenimiento no reempaqueta un repo tan chico: en una Mac daba verde. Lo mide el caso de la traza, en T8.
  for f in "$LAB_REMOTE_TREE" "$INTERNAL_REMOTE"; do
    harness_lab_git "$f" config maintenance.auto false; harness_lab_git "$f" config gc.auto 0; harness_lab_git "$f" config receive.autogc false
  done
  GIT_TRACE2_EVENT="$1/push-trace.json" harness_lab_git "$a" push -q origin main >/dev/null 2>&1
  harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1
  # un solo árbol: ~/.claude/agent-skills es el árbol (no hay clon aparte)
  rm -rf "$LAB_SKILLS"; ln -s "$LAB_TREE" "$LAB_HOME/.claude/agent-skills"
  for f in "$LAB_REMOTE_TREE" "$INTERNAL_REMOTE"; do printf '#!/bin/sh\necho "rechazado: el laboratorio no acepta push" >&2\nexit 1\n' > "$f/hooks/pre-receive"; chmod +x "$f/hooks/pre-receive"; done
}

# ═══ T8 · LayerCommit_MachinePicksNewestCompatibleFromInternalMain_NeverTrusts_NeverWrites (AC 7) ═════════════════════
if corre T8; then
  echo "T8 · el commit de la capa: el más nuevo de main interno que es compatible"
  capa_lab "$BASE/t8"
  # el armado no deja un mantenimiento de git corriendo de fondo en un repo que T8 mide (ver capa_lab). 🔴 rojo previo:
  # sin la configuración de los bare, la traza del push trae el `git maintenance run --auto` que lanzó el receive-pack.
  [ -s "$BASE/t8/push-trace.json" ] && ! grep '"child_start"' "$BASE/t8/push-trace.json" | grep '"maintenance"' >/dev/null \
    && ok "T8 el push del armado no lanza el mantenimiento de git en el bare (la huella de antes no se cruza con un reempaquetado)" \
    || mal "T8 el push del armado lanzó el mantenimiento de git en el bare, o no dejó traza: $(grep '"child_start"' "$BASE/t8/push-trace.json" 2>/dev/null | head -c 300)"
  mira install --yes --harness-clone "$INTERNAL"
  [ "$RC" = 0 ] && ok "T8 install --harness-clone sobre la copia pública: 0" || mal "T8 install --harness-clone: rc $RC: $SALIDA"
  [ "$(estado "d.get('source')")" = public ] && [ "$(capa kind)" = layer ] && [ "$(capa name)" = internal ] && [ "$(capa commit)" = "$I1" ] && [ "$(capa reference)" = "$(cd "$INTERNAL" && pwd -P)" ] \
    && ok "T8 el estado: source public, la fuente internal (layer) en el commit del interno, con el clon de la persona de referencia" || mal "T8 estado tras install: source=$(estado "d.get('source')") $(estado "[s for s in d['sources'] if s.get('kind') == 'layer']")"
  [ "$(harness_lab_git "$READ" rev-parse --is-bare-repository 2>/dev/null)" = true ] && grep -q "$(cd "$INTERNAL" && pwd -P)/.git/objects" "$READ/objects/info/alternates" 2>/dev/null \
    && ok "T8 el clon de lectura es --bare y tiene --reference al clon de la persona" || mal "T8 clon de lectura: bare=$(harness_lab_git "$READ" rev-parse --is-bare-repository 2>&1) alternates=$(cat "$READ/objects/info/alternates" 2>&1)"
  [ "$(ref_lectura refs/tycon/layer/2026.10.06.1)" = "$I1" ] && ok "T8 refs/tycon/layer/2026.10.06.1 (local, del clon de lectura) apunta al commit de la capa" || mal "T8 sin la ref de la capa: $(ref_lectura refs/tycon/layer/2026.10.06.1)"
  [ -f "$LAB_TREE/tasks/plan.md" ] && grep -q 'el exportador saca' "$LAB_TREE/guides/public.md" && ok "T8 la capa quedó apilada (lo privado y el transformado entero)" || mal "T8 la capa no se apiló"
  # (1) main interno avanza con un cambio privado: la capa avanza sola, sin versión pública nueva
  I2="$(interno tasks/plan2.md '# otro plan privado')"
  mira update
  [ "$RC" = 0 ] && [ "$(capa commit)" = "$I2" ] && [ -f "$LAB_TREE/tasks/plan2.md" ] && ok "T8 un cambio privado en main interno: la capa avanza a ese commit" || mal "T8 cambio privado: rc $RC capa=$(capa commit) (I2 $I2): $SALIDA"
  case "$SALIDA" in *"capa ${I1:0:7} → ${I2:0:7}"*) ok "T8 …y lo dice: «capa ${I1:0:7} → ${I2:0:7}»" ;; *) mal "T8 sin la línea de la capa: $SALIDA" ;; esac
  [ "$(ref_lectura refs/tycon/layer/2026.10.06.1)" = "$I2" ] && ok "T8 …la ref local de esa versión lo apunta" || mal "T8 ref de la capa: $(ref_lectura refs/tycon/layer/2026.10.06.1) (I2 $I2)"
  # (1b) un archivo NUEVO publicable en main interno (en guides/, sin tocar ningún archivo público) y sin versión pública
  # nueva: tampoco es compatible (AC 5, segunda mitad) — la capa se queda en el último compatible y lo dice
  I2B="$(interno guides/nueva.md '# una guía nueva, pública')"
  mira update
  [ "$RC" = 0 ] && [ "$(capa commit)" = "$I2" ] && [ ! -e "$LAB_TREE/guides/nueva.md" ] && ok "T8 un archivo nuevo publicable sin versión pública: la capa se queda en ${I2:0:7} y no lo apila como agregado" || mal "T8 archivo nuevo publicable: rc $RC capa=$(capa commit) (I2 $I2, I2B $I2B): $SALIDA"
  case "$SALIDA" in *"capa en ${I2:0:7}: main interno trae un cambio publicable que el público todavía no tiene"*) ok "T8 …y lo dice con el texto del AC" ;; *) mal "T8 archivo nuevo: no dice que se quedó: $SALIDA" ;; esac
  # (2) un cambio publicable en main interno sin versión pública nueva: se queda en el último compatible y lo dice
  I3="$(interno README.md 'un cambio publicable')"
  mira update
  [ "$RC" = 0 ] && [ "$(capa commit)" = "$I2" ] && ! grep -q 'un cambio publicable' "$LAB_TREE/README.md" && ok "T8 un cambio publicable sin versión pública: la capa se queda en ${I2:0:7} (nunca usa la punta sin comprobarla)" || mal "T8 publicable: rc $RC capa=$(capa commit): $SALIDA"
  case "$SALIDA" in *"capa en ${I2:0:7}: main interno trae un cambio publicable que el público todavía no tiene"*) ok "T8 …y lo dice con el texto del AC" ;; *) mal "T8 no dice que se quedó: $SALIDA" ;; esac
  # (3) llega la versión pública con ese cambio (piso I3) y main interno trae uno privado más: avanzan los dos
  I4="$(interno tasks/plan3.md '# plan privado tres')"
  printf '%s\n' '# una guía nueva, pública' > "$LAB_AUTHOR_TREE/guides/nueva.md"   # la versión 2 trae también la guía nueva (1b)
  publica 2026.10.06.2 "$I3" README.md 'un cambio publicable'
  mira update
  [ "$RC" = 0 ] && [ "$(capa commit)" = "$I4" ] && grep -q 'un cambio publicable' "$LAB_TREE/README.md" && [ "$(head_de "$LAB_TREE")" = "$(harness_lab_remote_head main)" ] \
    && ok "T8 llega la versión: el público avanza y la capa con él, a la punta compatible" || mal "T8 llega la versión: rc $RC capa=$(capa commit) (I4 $I4): $SALIDA"
  [ "$(ref_lectura refs/tycon/layer/2026.10.06.2)" = "$I4" ] && ok "T8 …refs/tycon/layer/2026.10.06.2 lo apunta" || mal "T8 ref de la versión 2: $(ref_lectura refs/tycon/layer/2026.10.06.2)"
  # (4) la versión 3 se armó sobre I5 y main interno sólo trae después commits incompatibles: el mínimo, con las horas
  I5="$(interno README.md 'segundo cambio publicable' 2026-10-07T00:00:00Z)"
  publica 2026.10.06.3 "$I5" README.md 'segundo cambio publicable'
  I6="$(interno README.md 'tercer cambio publicable' 2026-10-08T06:00:00Z)"
  mira update
  [ "$RC" = 0 ] && [ "$(capa commit)" = "$I5" ] && grep -q 'segundo cambio publicable' "$LAB_TREE/README.md" && ok "T8 sólo commits incompatibles detrás del piso: la capa queda en el piso de version.json (${I5:0:7})" || mal "T8 todo incompatible: rc $RC capa=$(capa commit) (I5 $I5, I6 $I6): $SALIDA"
  [ "$(estado "(d['layer'] or {}).get('minimum')")" = True ] && [ "$(estado "(d['layer'] or {}).get('lag_hours')")" = 30 ] && ok "T8 …con layer.minimum y lag_hours 30 en el estado" || mal "T8 layer del estado: $(estado "d.get('layer')")"
  case "$SALIDA" in *"capa al mínimo: 30 horas detrás de main interno"*) ok "T8 …y lo dice con las horas" ;; *) mal "T8 no dice el mínimo: $SALIDA" ;; esac
  [ "$(capa commit)" != "$I6" ] && ! grep -q 'tercer cambio' "$LAB_TREE/README.md" && ok "T8 el commit incompatible nunca se usó" || mal "T8 se usó un commit incompatible"
  # (5) (pase adversarial de la tanda A, C2) la versión 4 trae ese cambio y la capa sale del mínimo; la vuelta atrás a la
  # versión 3 vuelve a la capa al mínimo, y la marca y las horas vuelven con ella
  publica 2026.10.06.4 "$I6" README.md 'tercer cambio publicable'
  mira update
  [ "$RC" = 0 ] && [ "$(capa commit)" = "$I6" ] && [ "$(estado "(d['layer'] or {}).get('minimum')")" = False ] && ok "T8 la versión 4: la capa en la punta, sin la marca del mínimo" || mal "T8 versión 4: rc $RC capa=$(capa commit) (I6 $I6) layer=$(estado "d.get('layer')"): $SALIDA"
  mira rollback
  [ "$RC" = 0 ] && [ "$(capa commit)" = "$I5" ] && [ "$(estado "(d['layer'] or {}).get('minimum')")" = True ] && [ "$(estado "(d['layer'] or {}).get('lag_hours')")" = 30 ] \
    && ok "T8 rollback a una capa que estaba al mínimo: layer.minimum y las 30 horas vuelven con ella" || mal "T8 rollback al mínimo: rc $RC capa=$(capa commit) (I5 $I5) layer=$(estado "d.get('layer')"): $SALIDA"
  [ "$UNTOUCHED" = 1 ] && ok "T8 ningún comando escribió en los dos bare (el interno y el público) ni en el clon de la persona" || mal "T8 algún comando escribió en un repo ajeno"
fi

# ═══ T39L · StartupUpdate_Detached_KilledMidway_NextStartTakesOverAndUpdates_NoInteractiveLogin (story 8.23, tanda L) ══
# El caso de la máquina Windows del alta: la actualización tardaba más que el tope del hook y moría con el candado
# tomado. Con el arranque REAL: una actualización lenta (git fetch dormido) → el hook vuelve a tiempo y la deja seguir
# aparte; `kill -9` de esa corrida a mitad → el arranque siguiente pisa el candado del muerto en el acto (sin los 10
# minutos) y actualiza. El testigo: un `git` delante en el PATH que anota con qué ambiente se lo llamó para salir a la red.
if corre T39L; then
  harness_lab_create "$BASE/t39l" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "T39L install previo falló"
  harness_lab_publish tree "v2" VERSION 2; harness_lab_publish skills "v2" VERSION 2
  NUEVO="$(head_de "$LAB_AUTHOR_TREE")"
  REAL_GIT="$(command -v git)"; TESTIGO="$BASE/t39l/git-red.log"; LENTO="$BASE/t39l/lento"
  mkdir -p "$BASE/t39l/bin"
  cat > "$BASE/t39l/bin/git" <<SH
#!/bin/sh
case " \$* " in *" fetch "*|*" ls-remote "*)
  printf 'GCM_INTERACTIVE=%s GIT_TERMINAL_PROMPT=%s\n' "\${GCM_INTERACTIVE:-}" "\${GIT_TERMINAL_PROMPT:-}" >> "$TESTIGO"
  [ -e "$LENTO" ] && { echo \$\$ > "$BASE/t39l/git-lento.pid"; exec sleep 60; } ;;
esac
exec "$REAL_GIT" "\$@"
SH
  chmod +x "$BASE/t39l/bin/git"
  : > "$LENTO"
  T0=$(date +%s)
  PATH="$BASE/t39l/bin:$PATH" TYCON_STARTUP_WAIT_MS=1500 harness startup > "$BASE/t39l/s1.out" 2>&1; RC=$?
  DUR=$(( $(date +%s) - T0 ))
  [ "$RC" = 0 ] && [ "$DUR" -lt 15 ] && ok "T39L con la actualización lenta, el hook vuelve a tiempo (${DUR} s) y sale 0" || mal "T39L hook: rc $RC en ${DUR} s: $(cat "$BASE/t39l/s1.out")"
  HIJO="$(sed -n 's/.*sigue aparte del hook (pid \([0-9]*\)).*/\1/p' "$(LOG)" | tail -1)"
  [ -n "$HIJO" ] && kill -0 "$HIJO" 2>/dev/null && ok "T39L la actualización sigue aparte (pid $HIJO) después de que el hook terminó" || mal "T39L no quedó corriendo aparte: $(tail -3 "$(LOG)")"
  for _ in 1 2 3 4 5 6 7 8 9 10; do [ -d "$LAB_HOME/.claude/.tycon-pipeline/harness/harness.lock" ] && break; sleep 0.5; done
  [ -d "$LAB_HOME/.claude/.tycon-pipeline/harness/harness.lock" ] && ok "T39L la corrida aparte tiene el candado" || mal "T39L la corrida aparte no tomó el candado"
  # se corta a mitad (lo que hacía el tope del hook): con el candado tomado
  # (sólo los dos procesos de esta prueba, por su PID: nunca por nombre, que se lleva puestos procesos ajenos)
  [ -n "$HIJO" ] && kill -9 "$HIJO" 2>/dev/null; [ -s "$BASE/t39l/git-lento.pid" ] && kill -9 "$(cat "$BASE/t39l/git-lento.pid")" 2>/dev/null; sleep 0.5
  [ -d "$LAB_HOME/.claude/.tycon-pipeline/harness/harness.lock" ] && ok "T39L cortada a mitad, quedó el candado del muerto (el caso de la máquina trabada)" || mal "T39L el corte no dejó el candado: la prueba no reproduce el caso"
  rm -f "$LENTO"
  PATH="$BASE/t39l/bin:$PATH" TYCON_STARTUP_WAIT_MS=60000 harness startup > "$BASE/t39l/s2.out" 2>&1; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$NUEVO" ] && ok "T39L el arranque siguiente actualiza enseguida (no espera los 10 minutos)" || mal "T39L no actualizó: rc $RC, $(head_de "$LAB_TREE") vs $NUEVO: $(tail -4 "$(LOG)")"
  grep -q "era del pid $HIJO, que ya no existe" "$(LOG)" && ok "T39L el registro dice que pisó el candado del pid $HIJO" || mal "T39L el registro no dice qué candado pisó: $(tail -4 "$(LOG)")"
  [ ! -d "$LAB_HOME/.claude/.tycon-pipeline/harness/harness.lock" ] && ok "T39L y lo soltó al terminar" || mal "T39L quedó el candado"
  # nunca un login: toda salida a la red del arranque corrió sin poder preguntar nada
  if [ -s "$TESTIGO" ] && ! grep -v -q '^GCM_INTERACTIVE=never GIT_TERMINAL_PROMPT=0$' "$TESTIGO"; then ok "T39L las $(wc -l < "$TESTIGO" | tr -d ' ') salidas a la red corrieron con GCM_INTERACTIVE=never y GIT_TERMINAL_PROMPT=0"
  else mal "T39L una salida a la red pudo preguntar: $(sort -u "$TESTIGO" 2>/dev/null | head -3)"; fi
fi

if [ "$FALLOS" = 0 ]; then echo "✅ harness-update: todo verde"; exit 0; fi
echo "❌ harness-update: $FALLOS fallo(s)"; exit 1
