#!/usr/bin/env bash
# safety-guard-pre.sh — freno de mano del harness TYCON.
#
# Hook PreToolUse matcher=Bash|PowerShell|Monitor (Monitor corre su comando en la misma consola). Intercepta comandos destructivos irreversibles
# y los BLOQUEA (exit 2) antes de que se ejecuten. Inspirado en ECC safety-guard
# pero adaptado al stack TYCON (.NET, SQL Server, monorepos, multi-tenant).
#
# 🔴 PowerShell: en Windows Claude Code corre los comandos con su herramienta PowerShell
# (`tool_name: "PowerShell"`, la misma entrada `tool_input.command`; fuente: code.claude.com/docs/en/
# tools-reference §«PowerShell tool»). Registrado sólo con matcher `Bash`, este freno no se dispararía:
# pasarían `git add -A` en agent-skills y un commit que saltea los hooks de git. Se registra con
# `Bash|PowerShell`, y cada regla que tiene una forma obvia en PowerShell la frena también (Remove-Item,
# irm | iex, Get-Content, setx…), con el MISMO id de regla: es la misma regla, escrita en otro shell.
# No hay reglas aparte. El `cwd` de Windows llega con barras invertidas: GIT-C4 lo compara normalizado.
#
# Diseño:
#   - Solo BLOCK (exit 2) — no hay WARN para evitar ruido.
#   - Denylist explícita y corta. v1 cubre los desastres irreversibles.
#   - Opt-in vía hook registrado (la guía explica cómo activarlo).
#   - Una sola salida, la emergencia: la persona la firma en su terminal para un comando, tal cual
#     (`harness.js sign emergency --reason "<por qué>" -- '<comando>'`, lib/harness-sign.js), y el freno la consume
#     cuando el agente corre ese texto exacto: un solo uso, 30 minutos. `TYCON_SAFETY_OFF=1`, en el ambiente o como
#     prefijo del comando, ya no apaga nada: el cartel lo dice.
#   - Off completo: remové el hook de settings.json.
#   - Log de bloqueos en ~/.claude/safety-guard.log para retro/audit.
#   - Fail-open: si el script crashea por cualquier motivo, NO bloquea
#     (mejor permitir que romper toda la sesión por un bug del hook).
#
# Input: JSON por stdin del PreToolUse hook (Claude Code lo pasa).
#   { "tool_input": { "command": "..." }, "cwd": "..." }
#
# Output:
#   - exit 0: comando OK, dejar pasar.
#   - exit 2: BLOCK + mensaje al stderr (Claude lo ve y reconsidera).
#   - exit 1: NO PUDE LEER la entrada; el comando pasa SIN revisar y se dice (ver abajo). También sale 1,
#     con su línea, cuando GIT-C4 no pudo mirar el árbol de las skills instaladas: el
#     comando pasa, porque sin árbol resuelto no se sabe si es el lugar, y se dice.
#
# 🔴 La entrada se lee SIN depender de `jq`: con `command -v jq || exit 0`, una máquina sin `jq` dejaría
# pasar TODO —el `rm -rf /` incluido— sin una palabra, y `jq` no es un requisito declarado del arnés
# (`node` sí). Se lee con `jq` si está y, si no está o no pudo, con `node`; el
# resultado es el mismo con los dos (casos `sin-jq-…` del banco, que corren el hook con un PATH sin
# `jq`).
#
# 🟡 Qué hace si no hay NI `jq` NI `node` (o la entrada llega vacía, no se
# pudo leer o no es JSON):
# deja pasar, AVISANDO en cada llamada, y sale 1. Por qué así y no de las otras dos formas:
#   - Frenar (exit 2) frenaría TODOS los comandos, también un `ls`: sin `node` el agente no podría
#     correr nada, ni siquiera para ayudar a arreglarlo. Y la falta de `node` suele ser del PATH con
#     el que arrancó la herramienta (un editor abierto desde el Dock no ve el `node` de nvm), no de
#     la máquina: un bloqueo total por eso enseña a apagar el freno.
#   - Salir 0 con un aviso por stderr es lo mismo que callar: con exit 0 la herramienta manda el
#     stderr de un PreToolUse al registro de depuración, y el silencio es justo el defecto.
#   - Con exit 1 la herramienta lo trata como error que NO bloquea: el comando corre y a la persona
#     le aparece el error del hook con la PRIMERA línea de stderr. Por eso el aviso es una sola línea.
# 🔴 Límite conocido: que con exit 1 el comando corre y el aviso se ve sale de la documentación de hooks de Claude
# Code; no está medido en vivo, ni en Claude Code ni en Codex. Lo único medido en las dos es que `exit 2` frena y
# llega al modelo (guides/maintaining/codex-divergence-inventory.md). Se mediría con
# `scripts/controls-bench/live-fire.js` contra un `PreToolUse` real.
# El costo, dicho: sin `jq` ni `node`, nada frena un comando destructivo, y el agente no se entera (sólo
# `exit 2` le llega al modelo). Para frenar en ese caso, se cambia el `exit 1` de
# `cannot_read` por `exit 2` y los dos casos `sin-jq-ni-node-…` del banco.
#
# Límite conocido de «el mismo resultado con `jq` y con `node`»: vale para toda entrada que sea JSON
# del estándar (lo que manda la herramienta) y para la que no es JSON (las dos no pueden leerla).
# `jq` acepta además dos cosas fuera del estándar que `node` no: `NaN` y números con cero a la
# izquierda. Con esas, sin `jq`, el hook dice «no pude leer»; nunca calla.
#
# Test manual:
#   echo '{"tool_input":{"command":"rm -rf /tmp/foo"},"cwd":"/tmp"}' | bash safety-guard-pre.sh; echo "exit=$?"
#   echo '{"tool_input":{"command":"rm -rf /"},"cwd":"/tmp"}' | bash safety-guard-pre.sh; echo "exit=$?"
#   echo '{"tool_input":{"command":"git push --force origin main"},"cwd":"/tmp"}' | bash safety-guard-pre.sh; echo "exit=$?"

set -u

# ── El reloj propio del freno ─────────────────────────────────────────────────────────────────────────
# Si algo deja esperando al freno (un lector colgado, un nieto con la salida abierta) y vence el tope de la herramienta,
# el comando corre sin mirar: medido con Claude Code, un freno que dormía más que su tope dejó correr el comando y con
# tope holgado frenó. Por eso el freno tiene un tope propio, más corto, y al vencer frena: un vigía separado del
# freno (no es su hijo, y no tiene la salida del freno abierta) le manda TERM y corta todo lo que el freno lanzó; la
# trampa de TERM sale 2. TYCON_SAFETY_TIMEOUT_S, de 1 a 50 segundos; fuera de eso, 20.
# El vigía reconoce al freno por su hora de arranque y su línea de comando, tomadas al empezar: si el número del proceso
# pasó a otro, no lo toca.
# Límites conocidos: el corte de lo lanzado usa `pgrep`; donde no está (el Git Bash de Windows), el freno sale 2 recién
# cuando termina lo que espera. Sin `ps -o` el freno se reconoce sólo por /proc/<pid>/cmdline, y sin ninguno de los
# dos el reloj no actúa.
SG_CLOCK_S="${TYCON_SAFETY_TIMEOUT_S:-20}"
# sin ceros adelante: «09» o «060» no son un número de segundos para la cuenta de bash
if ! [[ "$SG_CLOCK_S" =~ ^[1-9][0-9]?$ ]] || (( SG_CLOCK_S > 50 )); then SG_CLOCK_S=20; fi
sg_identity() {
  local s
  s="$(ps -p "$1" -o lstart=,command= 2>/dev/null)"
  if [[ -z "$s" && -r "/proc/$1/cmdline" ]]; then s="$(tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null)"; fi
  printf '%s' "$s"
}
_sg_id="$(sg_identity $$)"
sg_clock_fired() {
  echo "⛔ TYCON safety-guard: el freno no terminó de mirar el comando en ${SG_CLOCK_S} s y lo frena: pasado el tope de la herramienta, el comando correría sin mirar. Si se repite, decíselo a la persona: algo deja esperando al freno." >&2
  exit 2
}
trap 'sg_clock_fired' TERM
_sg_pid=$$
( (
  sleep "$SG_CLOCK_S"
  # el número del proceso pudo pasar a otro: sólo se corta si sigue siendo este freno
  _sg_now="$(sg_identity "$_sg_pid")"
  [[ -n "$_sg_now" && "$_sg_now" == "$_sg_id" && "$_sg_now" == *safety-guard-pre.sh* ]] || exit 0
  kill -TERM "$_sg_pid" 2>/dev/null
  _sg_tree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do _sg_tree "$c"; kill -KILL "$c" 2>/dev/null; done; }
  _sg_tree "$_sg_pid"
) </dev/null >/dev/null 2>&1 & ) </dev/null >/dev/null 2>&1

# Fail-open: cualquier error inesperado → exit 0 (no bloquear). Si una firma ya pidió la ventana de permiso, la salida
# 0 la emite igual: sin ella el comando correría sin que la persona lo apruebe.
OW_ASK_JSON=""
salida_ok() {
  if [[ -n "$OW_ASK_JSON" ]]; then printf '%s\n' "$OW_ASK_JSON"; fi
  exit 0
}
trap 'salida_ok' ERR

# `TYCON_SAFETY_OFF=1` en el ambiente ya no apaga el freno: quedó una sola salida, la emergencia. Se anota para que el
# cartel lo diga.
SAFETY_OFF_VIEJO=0
if [[ "${TYCON_SAFETY_OFF:-0}" == "1" ]]; then
  SAFETY_OFF_VIEJO=1
fi

# ============================================================
# Leer input
# ============================================================
# 🔴 Una entrada VACÍA o que no se pudo leer NO es «nada que frenar»: es «no pude leer», y va por
# `cannot_read` como el resto (más abajo, cuando ya está definida). Salir 0 acá, mudo, sería la misma
# familia que el `exit 0` sin `jq`: un fallo silencioso. Lo que sí
# es «nada que frenar» es una entrada que se lee y no trae comando: ésa sigue saliendo 0 callada.
INPUT="$(cat 2>/dev/null)" || INPUT=""

# Con qué se lee: `jq` si está (es más rápido y este hook corre en cada comando) y `node`, que es
# requisito del arnés, si `jq` no está O no pudo. Ninguno de los dos → `cannot_read`.
# El Node del arnés: el propio si está y es ejecutable; si no, el del PATH. No cambia el PATH.
# con el bash de la Mac (3.2) y `set -e`, un `.` que no encuentra el archivo corta el guion aunque lleve `||`: se mira antes
_hn="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/harness-node.sh"
{ [ -f "$_hn" ] && . "$_hn" 2>/dev/null; } || harness_node_bin() { echo node; }
HNODE="$(harness_node_bin)"
HAS_JQ=0; HAS_NODE=0
if command -v jq >/dev/null 2>&1; then HAS_JQ=1; fi
if command -v "$HNODE" >/dev/null 2>&1; then HAS_NODE=1; fi

# read_field <ruta.con.puntos> — imprime ese campo de $INPUT: el texto tal cual; nada si falta, es
# null o es false. Sale ≠ 0 si NO PUDO LEER: no hay lector, o la entrada no es UN documento JSON
# (o el camino pasa por algo que no es un objeto). Las dos ramas hacen lo mismo a propósito: `jq`
# con `-s` exige un solo documento, que es lo que `JSON.parse` acepta; con `-s` `jq` no imprime
# nada si falla, así que probar después con `node` no duplica la salida.
# Por qué se prueba con `node` cuando `jq` falla: hay JSON válido que `jq` rechaza (un `\ud800`
# suelto), y eso sería otra forma de pasar sin revisión, en silencio.
# 🔴 Si tocás una rama, tocá la otra: este bloque está copiado igual en test-scope-guard-pre.sh.
# `jq -b`: el `jq` nativo de Windows escribe cada salto de línea como `\r\n` salvo con `-b`, y ese `\r` cambiaba lo que
# las reglas leían (un comando de varios renglones pasaba sin frenar). Un `jq` que no conoce `-b` falla y lee `node`,
# que no agrega nada. Así, todo `\r` que llega al comando estaba de verdad en el comando (CMD-C1, abajo).
read_field() {
  if [[ "$HAS_JQ" == "1" ]]; then
    if printf '%s' "$INPUT" | jq -b -rs --arg p "$1" \
      'if length == 1 then (.[0] | getpath($p | split(".")) // empty) else error("la entrada no es UN documento JSON") end' 2>/dev/null
    then return 0; fi
  fi
  if [[ "$HAS_NODE" == "1" ]]; then
    printf '%s' "$INPUT" | "$HNODE" -e '
      let v;
      try { v = JSON.parse(require("fs").readFileSync(0, "utf8").replace(/^\uFEFF/, "")); } catch (e) { process.exit(1); }
      for (const k of process.argv[1].split(".")) {
        if (v === null) break;
        if (typeof v !== "object" || Array.isArray(v)) process.exit(1);
        v = Object.prototype.hasOwnProperty.call(v, k) ? v[k] : null;
      }
      if (v === null || v === false) process.exit(0);
      process.stdout.write((typeof v === "string" ? v : JSON.stringify(v, null, 2)) + "\n");
    ' "$1" 2>/dev/null
    return $?
  fi
  return 1
}

# No se pudo leer la entrada: el comando pasa SIN revisar, y se DICE (decisión a confirmar: ver el
# encabezado). Una sola línea: la herramienta le muestra a la persona la primera de stderr.
cannot_read() {
  local reason="la entrada no se pudo leer como UN documento JSON"
  if [[ -z "$INPUT" ]]; then reason="la entrada llegó vacía o no se pudo leer"
  elif [[ "$HAS_JQ" == "0" && "$HAS_NODE" == "0" ]]; then reason="no hay ni jq ni node en el PATH de este hook"; fi
  echo "⚠️ TYCON safety-guard NO REVISÓ este comando y lo dejó pasar: ${reason}. Mientras siga así NADA frena un rm -rf / ni un push forzado a main. Arreglo: que node (requisito del arnés) esté en el PATH con el que arranca la herramienta." >&2
  exit 1
}

if [[ -z "$INPUT" ]]; then cannot_read; fi
CMD="$(read_field tool_input.command)" || cannot_read
# El comando tal como llegó: es el que se muestra, se anota y se registra aunque una regla lo mire normalizado (GIT-C4).
CMD_SHOWN="$CMD"
CWD="$(read_field cwd)" || cannot_read
if [[ -z "$CMD" ]]; then exit 0; fi

# `TYCON_SAFETY_OFF=1 <cmd>` pegado al principio del comando ya no es un escape: no pide la ventana ni apaga nada. Se
# anota para que el cartel diga cuál es la salida ahora.
SAFETY_OFF_PEDIDO=0
if [[ "$CMD" =~ ^[[:space:]]*TYCON_SAFETY_OFF=1[[:space:]] ]]; then
  SAFETY_OFF_PEDIDO=1
fi

# ps_match <regex> — ¿el comando matchea, SIN distinguir mayúsculas? Para las formas de PowerShell, que
# no las distingue (`Remove-Item` = `remove-item`, `$env:` = `$Env:`). Sólo mientras mira: después
# vuelve a distinguir, como el resto de las reglas.
ps_match() {
  local r=1
  shopt -s nocasematch
  [[ "$CMD" =~ $1 ]] && r=0
  shopt -u nocasematch
  return $r
}

# tool_is_ps — ¿la entrada viene de la herramienta PowerShell? Se lee una sola vez y sólo cuando una regla lo
# necesita: leer otro campo cuesta un proceso (jq o node) y este freno corre en cada comando.
TOOL_NAME_READ=0
TOOL_NAME=""
tool_is_ps() {
  if [[ "$TOOL_NAME_READ" == "0" ]]; then TOOL_NAME="$(read_field tool_name 2>/dev/null)" || TOOL_NAME=""; TOOL_NAME_READ=1; fi
  [[ "$TOOL_NAME" == "PowerShell" ]]
}

# La forma de PowerShell del prefijo viejo: `$env:TYCON_SAFETY_OFF=1; <cmd>`. Tampoco apaga nada; se anota igual.
if ps_match '^[[:space:]]*\$env:TYCON_SAFETY_OFF[[:space:]]*=[[:space:]]*["'"'"']?1["'"'"']?[[:space:]]*;' && tool_is_ps; then
  SAFETY_OFF_PEDIDO=1
fi

# ow_gate <firma>… — la ventana de permiso (lib/owner-window.js gate): el evento va por la entrada y las firmas `freno`
# que vio este freno, con `--escape`; las firmas de los guiones las lee el propio módulo del comando. Deja OW_DECISION
# (ask, deny, allow o none), OW_TEXTO, OW_FIRMA, OW_VIA, OW_RELEVO y OW_JSON (lo que se emite para pedir la ventana).
# Sin con qué consultar, o si la consulta se cae, niega: lo que no se pudo decidir lo firma la persona en su terminal.
OW_ESCAPES=()
OW_DECISION=""; OW_TEXTO=""; OW_FIRMA=""; OW_VIA=""; OW_RELEVO=""; OW_JSON=""
ow_gate() {
  OW_DECISION=""; OW_FIRMA="${1:-}"; OW_VIA=""; OW_RELEVO=""; OW_JSON=""
  OW_TEXTO="no pude consultar la ventana de permiso. Esta firma se da en tu terminal"
  local lib out k args=()
  lib="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/owner-window.js" || lib=""
  if [[ -n "$lib" && -f "$lib" ]] && command -v "$HNODE" >/dev/null 2>&1; then
    for k in "$@"; do args+=(--escape "$k"); done
    out="$(printf '%s' "$INPUT" | "$HNODE" "$lib" gate ${args[@]+"${args[@]}"} 2>/dev/null)" || out=""
    while IFS= read -r k; do
      case "$k" in
        decision=*) OW_DECISION="${k#decision=}" ;;
        texto=*) OW_TEXTO="${k#texto=}" ;;
        firma=*) OW_FIRMA="${k#firma=}" ;;
        via=*) OW_VIA="${k#via=}" ;;
        relevo=*) OW_RELEVO="${k#relevo=}" ;;
        json=*) OW_JSON="${k#json=}" ;;
      esac
    done <<< "$out"
  fi
  case "$OW_DECISION" in ask|allow|none) ;; *) OW_DECISION="deny" ;; esac
  if [[ "$OW_DECISION" == "ask" && -z "$OW_JSON" ]]; then OW_DECISION="deny"; fi
  return 0
}

# ow_vencer — un comando que no es una firma vence los pedidos de la ventana que su sesión dejó sin consumir (el «No»
# del dueño deja el pedido vivo, y un guion lanzado desde una consola disfrazada lo tomaría por el «Sí»). Sólo consulta
# a lib/owner-window.js si en las carpetas del estado hay un pedido de esta sesión; si no pudo vencerlo, frena. Las
# carpetas se buscan en la casa de la cuenta, como las escribe la ventana (un HOME cambiado no las esconde), y en HOME;
# si esa casa no se puede resolver, se consulta igual. Un comando común no abre ningún proceso: la sesión se lee sólo
# si hay algún pedido vigente.
ow_vencer() {
  local sid lib d u="${USER:-${LOGNAME:-}}" casa="" hay=0 dirs=()
  [[ -n "$u" ]] || u="$(id -un 2>/dev/null)" || u=""
  if [[ "$u" =~ ^[A-Za-z0-9._-]+$ ]]; then eval "casa=~$u"; fi
  [[ "$casa" == /* && -d "$casa" ]] || casa=""
  for d in ${casa:+"$casa"} ${HOME:+"$HOME"}; do
    # la carpeta vieja del estado, dentro de la de la herramienta, por patrón: el filtro sólo decide si se consulta
    dirs+=("$d/.tycon/state/owner-window" "$d/.*/.tycon-pipeline/owner-window")
  done
  # una casa escrita a la Windows (`C:\…`) va con barras: en el patrón, una barra invertida escapa la letra siguiente
  local th="${TYCON_HOME:-}"
  case "$th" in [A-Za-z]:*) th="${th//\\//}" ;; esac
  [[ -n "$th" ]] && dirs+=("$th/state/owner-window")
  if [[ -z "$casa" ]]; then
    hay=1
  else
    for d in "${dirs[@]}"; do compgen -G "$d/*.json" >/dev/null 2>&1 && hay=1; done
  fi
  [[ "$hay" == "1" ]] || return 0
  # la sesión se lee del texto de la entrada sin abrir un proceso: un pedido sin vencer de OTRA sesión deja `hay` en 1
  # para todas, y este freno corre en cada comando. Una cadena del comando trae sus comillas escapadas (`\"`), así que
  # la clave sin escapar es la de afuera; si aparece más de una vez, o con otra forma, se lee con jq o node
  sid=""
  local re_sid='"session_id"[[:space:]]*:[[:space:]]*"([A-Za-z0-9_-]+)"' resto="$INPUT"
  if [[ "$resto" =~ $re_sid ]]; then
    sid="${BASH_REMATCH[1]}"
    resto="${resto#*\"session_id\"}"
    [[ "$resto" == *'"session_id"'* ]] && sid=""
  fi
  [[ -n "$sid" ]] || { sid="$(read_field session_id 2>/dev/null)" || sid=""; }
  [[ "$sid" =~ ^[A-Za-z0-9_-]+$ ]] || return 0
  if [[ -n "$casa" ]]; then
    hay=0
    for d in "${dirs[@]}"; do compgen -G "$d/*--$sid.json" >/dev/null 2>&1 && hay=1; done
    [[ "$hay" == "1" ]] || return 0
  fi
  lib="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/owner-window.js" || lib=""
  if [[ -n "$lib" && -f "$lib" ]] && command -v "$HNODE" >/dev/null 2>&1 && printf '%s' "$INPUT" | "$HNODE" "$lib" sweep >/dev/null 2>&1; then return 0; fi
  block "ESC-C3" \
    "Esta sesión tiene un pedido de firma en la ventana sin consumir, y no pude vencerlo antes de este comando." \
    "Avisale a la persona: el pedido se vence solo a los 30 minutos, o lo firma ella en su terminal."
}

ESC_MOTIVO_VAR=""

# cartel_emergencia — cómo se saltea el freno: la emergencia, que la persona firma en su terminal para este comando.
cartel_emergencia() {
  echo "Saltear este freno lo decide la persona, no el agente: firma la emergencia en su terminal, para este comando tal cual,"
  echo "  node ~/.claude/tycon-harness/scripts/setup/harness.js sign emergency --reason \"<por qué>\" -- '<el comando de arriba>'"
  echo "y después se repite el mismo comando, sin cambiarle nada. Vale una vez, por 30 minutos."
}

# emergencia_vale — ¿la persona firmó la emergencia para ESTE comando, tal como llegó? La consume: un solo uso. Una
# vencida deja su motivo en EMERGENCIA_AVISO. Sin con qué mirar, no vale. Las salidas distintas de 0 van en una lista
# con `||`: así no disparan el `trap … ERR`, que dejaría pasar el comando.
EMERGENCIA_AVISO=""
emergencia_vale() {
  local lib out rc
  lib="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/harness-sign.js" || return 1
  [[ -f "$lib" ]] || return 1
  command -v "$HNODE" >/dev/null 2>&1 || return 1
  out="$(printf '%s' "$CMD_SHOWN" | "$HNODE" "$lib" consume 2>/dev/null)" && rc=0 || rc=$?
  [[ "$rc" == "0" ]] && return 0
  [[ "$rc" == "3" ]] && EMERGENCIA_AVISO="$out"
  return 1
}

# El `cwd` como lo escribe Windows (`C:\Users\…`), con barras hacia adelante: así lo leen las reglas que lo
# miran (GIT-C4 compara su texto con `/.claude/agent-skills` y lo recorre por sus `/`), y Git Bash lo entiende
# igual (`C:/Users/…`). Las rutas que el comando nombra con `cd` ya se normalizan así (git_c4_try).
CWD="${CWD//\\//}"

# Dónde empieza un comando de PowerShell: al principio, o después de `;`, `|`, `&`, `(`, `{`, `=` (`$x = …`)
# o de un salto de línea. Por POSICIÓN y no por cualquier espacio, como el freno de push: `git rm -r -q .`
# no es un Remove-Item. (Sin el salto de línea y el `=`, un Remove-Item en la segunda
# línea del comando o asignado pasaría; en bash `echo a⏎rm -rf ~` sí frena.)
_PS_NL=$'\n'
_PS_CR=$'\r'
_PS_AT="(^|[;&|({=${_PS_NL}])[[:space:]]*"
# El espacio DENTRO de un comando: blancos, o el acento grave al final de la línea que lo continúa.
_PS_SP="([[:blank:]]|\`${_PS_CR}?${_PS_NL})+"
# Remove-Item y sus alias (o con el nombre del módulo delante); entre el cmdlet y el destino, cualquier
# palabra del mismo comando: banderas abreviadas (-r, -fo) y parámetros CON valor (-ErrorAction
# SilentlyContinue, -ea 0). Aceptar sólo banderas sueltas lo esquivaría. El
# destino puede ir como `-Path:<destino>`, entre comillas, y seguido de más banderas.
_PS_DEL="${_PS_AT}"'(microsoft\.powershell\.management\\)?(remove-item|ri|rm|del|erase|rd|rmdir)('"${_PS_SP}"'[^;|&[:space:]]+)*'"${_PS_SP}"'(-[a-z]+:)?["'"'"']?'
_PS_END='["'"'"']?([[:space:]]|[;|)]|$)'

# ============================================================
# Helper: bloquear con motivo + log
# ============================================================
LOGFILE="$HOME/.claude/safety-guard.log"
mkdir -p "$(dirname "$LOGFILE")" 2>/dev/null || true

# Constancia de la decisión. Es AYUDA, NO EVIDENCIA: nunca cambia el código de
# salida ni lo que este freno decide. El comando va por STDIN — por argv lo vería cualquier
# `ps` — y de él sólo se guarda la huella.
constancia() { # $1 = regla (id del catálogo)  $2 = veredicto  [$3 = camino del escape  $4 = sesión que lo reenvió
               #  $5 = sesión del comando  $6 = nombre del escape (set-autonomous, cerrar-la-ejecucion)
               #  $7 = motivo del bloqueo, de la lista de su regla en guard-record.js]
  local lib="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/guard-record.js"
  [[ -f "$lib" ]] || return 0
  command -v "$HNODE" >/dev/null 2>&1 || return 0
  local extra=()
  [[ -n "${3:-}" ]] && extra+=(--via "$3")
  [[ -n "${4:-}" ]] && extra+=(--relay "$4")
  [[ -n "${5:-}" ]] && extra+=(--session "$5")
  [[ -n "${6:-}" ]] && extra+=(--escape "$6")
  [[ -n "${7:-}" ]] && extra+=(--reason "$7")
  printf '%s' "$CMD_SHOWN" | "$HNODE" "$lib" --guard safety-guard --rule "$1" --verdict "$2" ${extra[@]+"${extra[@]}"} --cmd-stdin >/dev/null 2>&1 || true
  return 0
}

block() {
  local rule="$1"
  local reason="$2"
  local alt="${3:-}"

  # La emergencia firmada para este comando: pasa, con la constancia de QUÉ regla se esquivó. La firma de la persona,
  # con su motivo, ya está en el registro común de firmas.
  if emergencia_vale; then
    constancia "$rule" escape persona
    exit 0
  fi
  local ts
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  {
    echo "[$ts] BLOCK rule=$rule cwd=$CWD"
    echo "  cmd: $CMD_SHOWN"
    echo "  reason: $reason"
  } >> "$LOGFILE" 2>/dev/null || true

  {
    echo "🛑 TYCON safety-guard BLOCK [$rule]"
    echo ""
    echo "Comando: $CMD_SHOWN"
    echo ""
    echo "Motivo: $reason"
    if [[ -n "$alt" ]]; then
      echo ""
      echo "Alternativa: $alt"
    fi
    echo ""
    if [[ -n "$ESC_CARTEL" ]]; then
      # ESC-C3: el cartel lo trae la regla, sin receta (el escape lo firma la persona, no es una variable)
      echo "$ESC_CARTEL"
    else
      # el motivo de la ventana ya cierra con punto: no se le suma otro
      if [[ -n "$ESC_VARIABLE" ]]; then
        _m="${ESC_MOTIVO_VAR:-la persona no lo autorizó}"
        echo "El comando trae $ESC_VARIABLE=$ESC_VALOR y no vale: ${_m%.}."
      elif [[ "$SAFETY_OFF_PEDIDO" == "1" || "$SAFETY_OFF_VIEJO" == "1" ]]; then
        echo "TYCON_SAFETY_OFF ya no apaga este freno: quedó una sola salida, la emergencia."
      fi
      if [[ -n "$EMERGENCIA_AVISO" ]]; then echo "Había una emergencia firmada para este comando y no vale: ${EMERGENCIA_AVISO%.}."; fi
      cartel_emergencia
    fi
    echo ""
    echo "Apagar este hook del todo lo decide el dev (guides/safety-guard.md)."
  } >&2

  constancia "$rule" bloqueo "" "" "" "" "${BLOCK_MOTIVO:-}"
  exit 2
}

# ============================================================
# Reglas (orden = prioridad de match)
# ============================================================

# --- CMD-C1 (copia igual en los tres frenos de shell) --------------------------
# Con el `jq -b` de la lectura, un `\r` en el comando estuvo de verdad en el comando: bash lo toma como una letra más
# (`cl\rear` no es `clear`), PowerShell como un salto de línea, y un freno no puede saber cuál de las dos lecturas
# esconde algo. Un comando legítimo no lo trae: frena siempre, con su motivo. En PowerShell, lo mismo con los otros
# separadores que no son un espacio (`\f`, `\v`, NEL, los de línea y párrafo de Unicode y todos sus espacios, del duro
# al ogham): PowerShell separa palabras con ellos y las reglas sólo miran espacio y tabulador. Los bytes van escritos
# en UTF-8 porque el bash de la Mac (3.2) no entiende `$'\u…'`. Está en los tres (safety-guard-pre.sh,
# test-scope-guard-pre.sh, engram-pre-commit.sh) porque cada uno se apaga por su lado: con uno apagado, los otros
# siguen frenando. Si tocás una copia, tocá las tres (lo cuida jq-carriage-return.test.js).
CMD_C1_POR_QUE="Bash y PowerShell lo leen distinto, y con él una parte del comando se le puede esconder a los frenos. Un comando escrito a mano no lo trae."
CMD_C1_ARREGLO="Escribí el comando sin ese carácter (un salto de línea común, o espacios) y volvé a correrlo."
cmd_c1_motivo() { # $1 = comando · $2 = herramienta → por stdout, qué carácter trae; nada si no trae ninguno
  local c
  case "$1" in *$'\r'*) printf '%s' '\r (retorno de carro)'; return 0 ;; esac
  [[ "$2" == "PowerShell" ]] || return 0
  for c in $'\f' $'\v' $'\xc2\xa0' $'\xc2\x85' $'\xe2\x80\xa8' $'\xe2\x80\xa9' $'\xe3\x80\x80' $'\xe2\x80\xaf' $'\xe2\x81\x9f' \
           $'\xe2\x80\x80' $'\xe2\x80\x81' $'\xe2\x80\x82' $'\xe2\x80\x83' $'\xe2\x80\x84' $'\xe2\x80\x85' $'\xe2\x80\x86' \
           $'\xe2\x80\x87' $'\xe2\x80\x88' $'\xe2\x80\x89' $'\xe2\x80\x8a' $'\xe1\x9a\x80'; do
    case "$1" in *"$c"*) printf '%s' 'un separador que no es un espacio (\f, \v, espacio duro o un espacio de Unicode)'; return 0 ;; esac
  done
  return 0
}
# --- fin CMD-C1 ----------------------------------------------------------------
ESC_VARIABLE=""; ESC_VALOR=""; ESC_CARTEL=""   # las lee block(); acá todavía no hay escape de la línea del comando
BLOCK_MOTIVO=""   # lo lee block(): el motivo de un bloqueo de ESC-C3, de la lista de guard-record.js
_herramienta=""; tool_is_ps && _herramienta="PowerShell"
_cmd_c1="$(cmd_c1_motivo "$CMD" "$_herramienta")"
if [[ -n "$_cmd_c1" ]]; then
  block "CMD-C1" "El comando trae ${_cmd_c1}. ${CMD_C1_POR_QUE}" "$CMD_C1_ARREGLO"
fi

# --- Escapes de los hooks de git escritos en la línea del comando ------------

# ESC-C1: `TYCON_NEW_NAMES` (el freno de nombres reales en lo que se publica) lo lee el hook de git del `git commit`,
# que hereda el ambiente del comando, y se apaga con el valor 0. Bash da 0 de muchas formas (`=0`, `=''0`, `+=0`, `=$'0'`, `=${X:-0}`, `printf -v`, el nombre
# partido con comillas), así que se frena CUALQUIER asignación a esas variables salvo `=1` literal, en cualquier parte
# del comando y con las comillas y barras invertidas sacadas; también `export`, `declare`, `typeset`, `local`,
# `readonly`, `read` y `printf -v` sobre ellas, y `$env:` en PowerShell (sin distinguir mayúsculas). Nombrarlas sin
# asignar no frena. Lo aprueba la persona en la ventana de permiso; aprobado, queda la constancia y siguen las demás reglas.
# Como GIT-C2, mira el comando crudo: un texto (un heredoc, un -m) que trae la asignación también frena. Es de más y
# nunca de menos; ignorar el cuerpo de un heredoc o las comillas se puede falsificar (ver GIT-C2). Lo que no ve: la
# asignación armada con el nombre en una variable (`declare "$n=0"`) o escrita en un guion que después se corre.
# `TYCON_TEST_GATE` (la pone test-gate.sh adentro de su proceso: escrita por el agente da un verde de pruebas que no
# corrió) y `DOD_BYPASS` (cierra un paso sin la evidencia de la prueba en vivo) van al revés: activan el escape con
# cualquier valor que no sea 0 ni vacío, así que se frena cualquier asignación salvo a 0 o a nada. El nombre se compara
# exacto (`TYCON_TEST_GATE_PART` no es ella). Su cartel no trae la receta y su constancia anota la sesión y el escape.
# `TYCON_NO_DEEP_REVIEW` (apaga el pase adversarial) sigue la misma regla de valores. `TYCON_STATUS_GATE` (apaga el
# freno que no deja pasar una historia a review o done a mano) también.
ESC_VARIABLE=""; ESC_VALOR=""; ESC_CARTEL=""
# el comando sin comillas ni barras invertidas, una sola vez (ESC-C1 y ESC-C2 lo usan). Con `tr`: en el bash de la Mac
# (3.2), `${CMD//[…]/}` crece con el cuadrado del largo y un heredoc de unos KB tardaba segundos en cada comando
# Una barra invertida con salto de línea el shell la une (`pipe\⏎line.js` es `pipeline.js`): se une antes, y sólo si
# está (el reemplazo de bash es caro en un comando largo)
_esc_bsnl=$'\\\n'; _esc_bscrlf=$'\\\r\n'; _esc_fuente="$CMD"
[[ "$_esc_fuente" == *"$_esc_bscrlf"* ]] && _esc_fuente="${_esc_fuente//$_esc_bscrlf/}"
[[ "$_esc_fuente" == *"$_esc_bsnl"* ]] && _esc_fuente="${_esc_fuente//$_esc_bsnl/}"
if command -v tr >/dev/null 2>&1; then
  _esc_cmd="$(printf '%s' "$_esc_fuente" | tr -d "\"'\\\\\`")" || _esc_cmd="${_esc_fuente//[\"\'\\\`]/}"
else
  _esc_cmd="${_esc_fuente//[\"\'\\\`]/}"
fi

# ESC-C3, `harness.js sign`: la firma en la terminal mira que haya una terminal y que alguien escriba «firmo», y un agente
# que se abre una terminal propia (`script`, un pty, `expect`) pasaría. La corre sólo la persona en su terminal, donde
# no hay freno: acá se niega siempre, sin ventana (la emergencia nunca va por la ventana), igual que la biblioteca de la
# emergencia (lib/harness-sign.js), que la consumiría. Mira el comando sin comillas (`si''gn` es `sign`). Lo que no ve:
# el nombre armado en una variable.
_sign_re='harness(\.js)?[^;&|]*[][[:space:],(]sign([][[:space:],)]|$)'
if [[ "$_esc_cmd" == *harness-sign* || "$_esc_cmd" =~ $_sign_re ]]; then
  ESC_CARTEL="Esto lo corre la persona en su terminal, no el agente: explicale qué hay que firmar y por qué, y el comando exacto."
  block "ESC-C3" \
    "Firmar con harness.js sign, o usar la biblioteca de la emergencia, lo hace la persona en su terminal: un agente no, ni abriéndose una terminal propia." \
    "Si un freno te para, mostrale a la persona el comando y el cartel: la emergencia la firma ella."
fi

# `TYCON_PROD_LINT=0` ya no apaga la revisión del catálogo de producción (la salida es la emergencia del commit): no se
# mira, porque escrita no hace nada.
for _esc in TYCON_NEW_NAMES TYCON_TEST_GATE DOD_BYPASS TYCON_NO_DEEP_REVIEW TYCON_STATUS_GATE; do
  # el filtro barato primero: sin el nombre de la variable (sin distinguir mayúsculas, por PowerShell) no hay nada que
  # mirar, y las expresiones de abajo no corren sobre un comando largo que no la nombra
  shopt -s nocasematch
  if [[ "$_esc_cmd" != *"$_esc"* ]]; then shopt -u nocasematch; continue; fi
  shopt -u nocasematch
  _esc_hit=0
  if [[ "$_esc" == "TYCON_TEST_GATE" || "$_esc" == "DOD_BYPASS" || "$_esc" == "TYCON_NO_DEEP_REVIEW" || "$_esc" == "TYCON_STATUS_GATE" ]]; then
    # éstas activan el escape con cualquier valor que no sea 0 ni vacío: se sacan las asignaciones a 0 o a nada (con
    # espacios alrededor del `=`, por PowerShell) y cualquier otra que quede frena, también un valor que no se ve (`$X`).
    # Todo en minúsculas: PowerShell no distingue mayúsculas en el nombre
    # los nombres son fijos: en minúsculas sin `tr` (una asignación suelta que falla dispararía el `trap 'exit 0' ERR`)
    case "$_esc" in
      TYCON_TEST_GATE) _esc_min="tycon_test_gate" ;;
      TYCON_NO_DEEP_REVIEW) _esc_min="tycon_no_deep_review" ;;
      TYCON_STATUS_GATE) _esc_min="tycon_status_gate" ;;
      *) _esc_min="dod_bypass" ;;
    esac
    # en bash el valor va pegado al `=` (`X= cmd` es vacío); en PowerShell puede llevar espacios, y vacío es `= ;`
    _esc_cero="${_esc_min}=0?([[:space:];)&|]|\$)"
    tool_is_ps && _esc_cero="${_esc_min}[[:space:]]*=[[:space:]]*0?[[:space:]]*([;)&|]|\$)"
    # si no se pudo pasar a minúsculas o sacar los ceros, no se puede mirar: se lee del lado que frena. Dos pasos con su
    # propio control: en un tubo sólo cuenta la salida del último, y un `tr` que falla dejaría la entrada vacía
    _esc_low="$(printf '%s' "$_esc_cmd" | tr '[:upper:]' '[:lower:]')" || _esc_low=""
    if [[ -z "$_esc_low" ]]; then
      _esc_sin0=""; _esc_hit=1
    else
      _esc_sin0="$(printf '%s' "$_esc_low" | sed -E "s/(^|[^a-z0-9_])${_esc_cero}/\1 \2/g")" || { _esc_sin0=""; _esc_hit=1; }
      if [[ -z "$_esc_sin0" ]]; then _esc_hit=1; fi
    fi
    # una comparación (`process.env.DOD_BYPASS === '1'`, `[ "$DOD_BYPASS" = 1 ]` en bash) no es una asignación: en bash
    # el `=` va pegado al nombre; en PowerShell puede llevar espacios
    _esc_asig="(^|[^a-z0-9_])${_esc_min}\+?=([^=]|\$)"
    tool_is_ps && _esc_asig="(^|[^a-z0-9_])${_esc_min}[[:space:]]*\+?=([^=]|\$)"
    _esc_decl="(^|[^a-z0-9_-])(export|declare|typeset|local|readonly|read|printf|set-item|new-item|set-variable|set-content)[[:space:]][^;&|]*${_esc_min}([^a-z0-9_]|\$)"
    # PowerShell: `${env:NOMBRE}=…` y `[Environment]::SetEnvironmentVariable('NOMBRE', …)` (sin comillas ya)
    _esc_ps2="\\\$\\{env:${_esc_min}\\}[[:space:]]*=([^=]|\$)|setenvironmentvariable\\([[:space:]]*${_esc_min}[[:space:]]*,"
    if [[ "$_esc_sin0" =~ $_esc_asig || "$_esc_sin0" =~ $_esc_decl || "$_esc_sin0" =~ $_esc_ps2 ]]; then _esc_hit=1; fi
  else
  # las asignaciones `=1` literales no apagan nada: se sacan antes de buscar las demás
  _esc_sin1="$_esc_cmd"
  for _esc_fin in ' ' ';' ')' '&' '|' $'\n' $'\t'; do _esc_sin1="${_esc_sin1//${_esc}=1${_esc_fin}/ ${_esc_fin}}"; done
  [[ "$_esc_sin1" == *"${_esc}=1" ]] && _esc_sin1="${_esc_sin1%${_esc}=1}"
  _esc_asig="(^|[^A-Za-z0-9_])${_esc}\+?="
  _esc_decl="(^|[^A-Za-z0-9_-])(export|declare|typeset|local|readonly|read|printf)[[:space:]][^;&|]*${_esc}([^A-Za-z0-9_]|\$)"
  _esc_ps="(^|[^a-z0-9_])\\\$env:${_esc}[[:space:]]*\+?="
  if [[ "$_esc_sin1" =~ $_esc_asig || "$_esc_cmd" =~ $_esc_decl ]]; then _esc_hit=1; fi
  if [[ "$_esc_hit" == "0" ]] && tool_is_ps; then
    _esc_save="$CMD"; CMD="$_esc_cmd"
    if ps_match "$_esc_ps"; then _esc_hit=1; fi
    CMD="$_esc_save"
  fi
  fi
  # la firma se da en la ventana de permiso: la decide owner-window.js junto con las demás firmas del comando (más
  # abajo, después de ESC-C7)
  if [[ "$_esc_hit" == "1" ]]; then
    OW_ESCAPES+=("escape:$_esc")
  fi
done
ESC_VARIABLE=""; ESC_VALOR=""

# esc_c1_negar <VARIABLE> — la ventana negó un escape por variable: frena con el motivo de esa variable. El cartel es
# lo que dijo la ventana (por qué no, y cómo se firma en la terminal), quién lo decide y, en las del pipeline, la salida
# normal de una historia que no se pudo terminar.
esc_c1_negar() {
  # las del pipeline, sin la receta: el agente no aprende a ponerse la variable
  case "$1" in
    TYCON_TEST_GATE|DOD_BYPASS|TYCON_NO_DEEP_REVIEW|TYCON_STATUS_GATE) ESC_CARTEL="$OW_TEXTO
Esto lo decide la persona, no el agente: lo aprueba ella en la ventana de permiso de la herramienta, o lo corre ella en su terminal.
Si la historia no se pudo terminar, la salida normal es dejarla como deuda: marker.js close-as-debt --reason \"<qué quedó pendiente>\" --debt <DEF-id>." ;;
    TYCON_NEW_NAMES) ESC_CARTEL="$OW_TEXTO
Saltear este freno lo decide la persona, no el agente: se repite el comando con $1=0 adelante y la persona lo aprueba en la ventana de permiso de la herramienta, o lo corre ella en su terminal." ;;
    *) ESC_CARTEL="$OW_TEXTO" ;;
  esac
  case "$1" in
    TYCON_TEST_GATE) block "ESC-C1" \
        "TYCON_TEST_GATE la pone test-gate.sh dentro de su propio proceso. Escrita por el agente, da un verde de pruebas (o un «sin medir») que no corrió." \
        "Corré la suite con test-gate.sh <repo> <ruta de la story>: el verde sale de las pruebas de verdad. Si no se puede medir, decíselo a la persona." ;;
    DOD_BYPASS) block "ESC-C1" \
        "DOD_BYPASS cierra un paso sin la evidencia de la prueba en vivo." \
        "Corré la prueba en vivo de verdad (la evidencia la escriben los guiones que corren las pruebas). Si no se puede, decíselo a la persona." ;;
    TYCON_NO_DEEP_REVIEW) block "ESC-C1" \
        "TYCON_NO_DEEP_REVIEW apaga el pase adversarial, la revisión que corre el código y más bugs encuentra." \
        "Si el portón dice que corre, lanzalo de fondo y avisá cuánto tarda; no se pregunta si correrlo. Apagarlo lo decide la persona, en la ventana de permiso." ;;
    TYCON_STATUS_GATE) block "ESC-C1" \
        "TYCON_STATUS_GATE apaga el freno que no deja pasar una historia a review o done escribiendo el archivo a mano." \
        "El estado lo cambia el orquestador, que corre los controles del cierre: node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js update-story-status <ruta de la historia> <estado>. Apagarlo lo decide la persona, en la ventana de permiso." ;;
    TYCON_NEW_NAMES) block "ESC-C1" \
        "TYCON_NEW_NAMES=0 apaga, al commitear, el freno de nombres reales (clientes, personas, servidores) en lo que se publica." \
        "Reemplazá el nombre por uno inventado, o pedí su excepción en la lista. ¿Sólo la nombrabas en un texto (un heredoc, un -m)? Este freno mira el comando entero: escribí ese texto en un archivo." ;;
    *) block "ESC-C1" \
        "El comando apaga el freno de seguridad (${1}) y la ventana de permiso no lo dejó pasar." \
        "Si la persona quiere hacerlo igual, lo corre ella en su terminal." ;;
  esac
}

# ESC-C1, el nombre armado: una asignación con el nombre de la variable en otra variable (`V=TYCON_…; export $V=1`,
# `declare -x "$V=1"`, `env "$V=1"`, `printf -v "$V"`, `read $V`, `eval "$V=1"`; en PowerShell `Set-Item env:$V` o
# `SetEnvironmentVariable($V, …)`) no nombra la variable, y la regla de arriba no la ve. En un comando que corre los
# guiones del pipeline (`marker`, `pipeline`, `test-gate.sh`) puede ser un escape: frena, sin frase (no hay variable
# que autorizar; el camino es escribir el nombre, y decide su regla). Fuera del pipeline, armar nombres no frena.
# La regla no enumera expansiones: en un programa que asigna, cualquier palabra con un `$` (o una comilla invertida)
# antes del primer `=`, o sin `=`, arma el nombre (`$1`, `${V:-x}`, `${!V}`, `${A[0]}`, `$(…)`, `TYCON_NO_$A` con el
# `=1` adentro). No cruza un salto de línea: un `export` en un renglón no se junta con un `$X=` del siguiente.
# Lo que no asigna no cuenta: la palabra del programa va sola (`readability` no es `read`), un nombre no cruza un `;`,
# un `&`, un `|` ni un paréntesis (las llaves de un código de JS entre comillas no son `{A,B}`), y una cuenta
# `$((…))` frena sólo si asigna (`$(( $V = 1 ))`, `((${V}+=1))`), no si calcula (`$((L-60))`, `$a <= 1`).
_arm_nl=$'\n'
# se mira el comando con sus comillas y comillas invertidas (sólo con la barra invertida + salto de línea unida): `tr`
# borra las comillas invertidas, y una comilla invertida también arma el nombre
_arm_txt="$_esc_fuente"
# lo que arma el nombre: un `$`, una comilla invertida o llaves que se expanden (`{A,B}`, `{1..3}`)
_arm_din="([\$\`]|\{[^}[:space:];&|()<>]*(,|\.\.))"
_arm_pal="[^[:space:]=;&|()<>]*${_arm_din}"
_arm_seg="[^;&|${_arm_nl}]"
_arm_re="(^|[\$;&|(${_arm_nl}[:space:]])(export|declare|typeset|local|readonly|eval|let|read|mapfile|readarray)([[:blank:]]${_arm_seg}*)?[[:blank:]]${_arm_pal}"
# la cuenta que asigna: un `=` (o `+=`, `-=`…) después de una palabra con `$`, sin salir del paréntesis; `==`, `<=`, `>=`
# y `!=` comparan
_arm_arit="\(\([^)]*[\$\`][^)=]*[^)=<>!]=([^=]|\$)"
# `env`: sólo cuentan las asignaciones que van antes del programa (`env X=1 node $S` no arma nada)
_arm_env="(^|[;&|(${_arm_nl}[:space:]])env([[:blank:]]+(-[^[:blank:]]+|[^[:space:]=]+=[^[:blank:]]*))*[[:blank:]]+${_arm_pal}[^[:space:]]*="
_arm_re2="(^|[;&|(${_arm_nl}[:space:]])printf[[:blank:]]+(-[A-Za-z]+[[:blank:]]+)*-v[[:blank:]]*${_arm_pal}|(^|[;&|(${_arm_nl}[:space:]])(declare|typeset|local)[[:blank:]]+-[A-Za-z]*n[A-Za-z]*${_arm_seg}*[\$\`]"
# PowerShell: el nombre con `$`, `+` o un paréntesis (`"TYCON_$V"`, `('TYCON_'+$V)`, `('env:'+$V)`), también con los alias
_arm_ps="setenvironmentvariable\([[:space:]]*[^,)]*[\$+(]|(^|[;|(${_arm_nl}[:space:]])(set-item|si|new-item|ni|set-content|sc|new-variable|nv|set-variable|sv)[[:space:]]${_arm_seg}*(env:[^;|[:space:]]*[\$+(]|-name[[:space:]]+[^;|[:space:]]*[\$+(])"
# el comando corre los guiones del pipeline, o `node`/`bun` (con o sin ruta) con un guion cuyo nombre no se lee: con un
# guion que se lee y no es del pipeline (`node server.js`), armar nombres no tiene que ver con los escapes
_arm_guion='(marker|pipeline|test-gate\.sh)'
_arm_node="(^|[[:space:];&|(]|/)(node|nodejs|bun)(\.exe)?([[:blank:]]+(-r|--require|--import|--loader|--experimental-loader|-C|--conditions)[[:blank:]]+[^[:blank:]]+|[[:blank:]]+-[^[:blank:]]*|[[:blank:]]+run)*[[:blank:]]+[^[:space:]]*([\$\`*?{]|\[)"
# sin `$`, comilla invertida ni llave no hay nombre armado; y sin lanzar procesos (este hook corre en cada comando):
# mayúsculas con `nocasematch`
_arm_hit=0
if [[ "$_arm_txt" == *[\$\`{]* ]]; then
  shopt -s nocasematch
  if [[ "$_esc_cmd" =~ $_arm_guion || "$_arm_txt" =~ $_arm_node ]]; then
    if [[ "$_arm_txt" =~ $_arm_re || "$_arm_txt" =~ $_arm_arit || "$_arm_txt" =~ $_arm_env || "$_arm_txt" =~ $_arm_re2 ]]; then _arm_hit=1
    elif tool_is_ps && [[ "$_arm_txt" =~ $_arm_ps ]]; then _arm_hit=1; fi
  fi
  shopt -u nocasematch
fi
if [[ "$_arm_hit" == "1" ]]; then
  ESC_CARTEL=""
  block "ESC-C1" \
    "El comando asigna una variable con el nombre armado (en otra variable) y corre los guiones del pipeline: el nombre de la variable no se ve, así que el freno no puede saber si es un escape." \
    "Escribí el nombre de la variable entero: si es un escape, su regla decide y la persona lo aprueba en la ventana de permiso."
fi

# ESC-C3: apagar el lazo de las pruebas o cerrar una ejecución que no terminó lo decide la persona. Con un control en
# rojo, el modo autónomo no deja cerrar el turno; `marker.js set-autonomous <valor que lo apaga>` lo apaga, y `clear`,
# `clear-session` de la propia sesión o `update-story-status <h> review|done` la cierran como si hubiera terminado.
# Frena sólo si el marcador de la sesión lo justifica (lib/run-close.js: modo autónomo prendido para apagarlo; un
# control en rojo, pasos sin correr o el pase sin cerrar para cerrar), salvo que la persona lo apruebe en la ventana de
# permiso. Aprobado, queda la constancia con la sesión y el escape (`marker.js clear` la lee para anotar quién autorizó)
# y siguen las demás reglas. `adhoc clear` y `doing clear` no tocan la ejecución: no frena.
ESC_CARTEL=""
# Declarar un control en verde a mano (`marker.js set-check … --force-manual`) o dar por corridos revisores que el arnés
# no vio (`pipeline.js check-count --trust-ran`) también lo decide la persona, y frena con la ejecución en verde: el
# escape es el verde, no cerrar en rojo. Apagar el pase adversarial (`--no-deep-review` en `pipeline.js
# start|deep-review-gate` o `marker.js mark-adversarial-skipped`) frena siempre, también antes de que exista la
# ejecución: `start` la crea.
# El comando lo lee lib/marker-command.js como lo lee el shell (comillas, renglones, `$(…)`, barras de Windows,
# mayúsculas); acá sólo se mira si nombra `marker` o `pipeline`, sin distinguir mayúsculas, para no correr node en cada
# comando.
#
# ESC-C6: aprobar el plan (`marker.js complete-step approve-plan|3 --approved "<cita>"`, `--mockup-approved`,
# `approve-mockup --approved`) es una firma del guion: la pide la ventana siempre; la cita no se busca en la conversación.
# El filtro mira el comando sin comillas ni barras invertidas (`_esc_cmd`, de ESC-C1): `pipe''line.js` es `pipeline.js`
# para el shell, y sin esto no llegaba al lector. Un comando que corre `node` o `bun` también va al lector: el nombre del
# guion puede venir armado por el shell (`pipelin?.js`, `mar$'k'er.js`), y el lector lo trata como cualquiera de los dos.
_c3_negables=(); _c3_perdida=""; _c3_sid=""
_c3_node=0; _c3_re='(^|[[:space:];&|(]|/)(node|nodejs|bun)(\.exe)?[[:space:]]'
shopt -s nocasematch
[[ "$_esc_cmd" =~ $_c3_re ]] && _c3_node=1
shopt -u nocasematch
if [[ "$_esc_cmd" == *[Mm][Aa][Rr][Kk][Ee][Rr]* || "$_esc_cmd" == *[Pp][Ii][Pp][Ee][Ll][Ii][Nn][Ee]* || "$_c3_node" == "1" ]]; then
  _c3_sid="$(read_field session_id 2>/dev/null)" || _c3_sid=""
  _c3_shell="bash"; tool_is_ps && _c3_shell="powershell"
  _c3_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/skills/tycon-pipeline/scripts/lib/run-close.js" || _c3_lib=""
  _c3_out=""; _c3_leido=0
  if [[ -n "$_c3_lib" && -f "$_c3_lib" ]] && command -v "$HNODE" >/dev/null 2>&1; then
    # el comando va por la entrada
    if _c3_out="$(printf '%s' "$CMD" | "$HNODE" "$_c3_lib" --gate --session "$_c3_sid" --command-stdin --shell "$_c3_shell" 2>/dev/null)"; then
      _c3_leido=1
    else
      _c3_out=""
    fi
  fi
  # 🔴 Sin el lector (no está el intérprete del arnés, falta run-close.js o se cayó) no se sabe qué escape trae el comando:
  # frena. No cuesta nada: los guiones del pipeline corren con ese mismo intérprete y sin él no andan.
  if [[ "$_c3_leido" == "0" ]]; then
    ESC_CARTEL=""; BLOCK_MOTIVO="lector-caido"
    block "ESC-C3" \
      "No pude leer el comando: el intérprete del arnés no está o el lector de comandos se cayó. Un comando que corre los guiones del pipeline puede traer un escape que lo decide la persona." \
      "Revisá el intérprete del arnés (el comando del arnés que muestra su versión dice si está bien instalado). Si el comando no corre el pipeline, escribilo sin nombrar marker ni pipeline."
  fi
  _c3_motivo=""; _c3_frenos=()
  while IFS= read -r _c3_l; do
    case "$_c3_l" in
      motivo=*) _c3_motivo="${_c3_l#motivo=}" ;;
      frena=*) _c3_frenos+=("${_c3_l#frena=}") ;;
    esac
  done <<< "$_c3_out"
  # Cada escape va a la ventana de permiso (más abajo, después de ESC-C7), con lo que hace falta para frenar con su
  # motivo si la ventana lo niega: «<clave>\t<escape>\t<subcomando>\t<argumento>». La salida de una ejecución perdida
  # (con `desde`: lib/open-runs.js) es la firma `lost-run`, que la ventana lee del comando; se anota aparte.
  _c3_negables=(); _c3_perdida=""
  for _c3_f in ${_c3_frenos[@]+"${_c3_frenos[@]}"}; do
    _c3_desde=""
    IFS=$'\t' read -r _c3_esc _c3_sub _c3_a1 _c3_desde <<< "$_c3_f" || true
    _c3_regla="ESC-C3"
    case "$_c3_esc" in
      "cerrar la ejecución") _c3_clave="cerrar-la-ejecucion" ;;
      "cerrar como deuda") _c3_clave="cerrar-como-deuda"; _c3_regla="ESC-C4" ;;
      *) _c3_clave="${_c3_esc// /-}" ;;
    esac
    # la salida de una ejecución perdida sin apertura visible (la sesión no está escrita literal, o no tiene apertura):
    # no se sabe de qué ejecución es lo que se firmaría. Frena sin ventana.
    if [[ "$_c3_desde" == "-" ]]; then
      ESC_CARTEL="Escribí la sesión tal cual (marker.js ${_c3_sub} <sesión>), sin variables ni comandos: sin ella no se sabe de qué ejecución es ni cuándo se abrió."
      BLOCK_MOTIVO="ejecucion-perdida"
      block "ESC-C3" \
        "Sacar una ejecución perdida (marker.js ${_c3_sub} ${_c3_a1}) sin que se vea de qué sesión es ni cuándo se abrió." \
        "Repetí el comando con la sesión escrita literal."
    fi
    if [[ -n "$_c3_desde" ]]; then
      _c3_perdida="${_c3_sub}"$'\t'"${_c3_a1}"
      continue
    fi
    OW_ESCAPES+=("escape:${_c3_clave}")
    _c3_negables+=("${_c3_clave}"$'\t'"${_c3_esc}"$'\t'"${_c3_sub}"$'\t'"${_c3_a1}")
  done
  # ESC-C6: aprobar el plan es una firma del guion; la pide la ventana siempre (más abajo).
fi
ESC_CARTEL=""

# --- La ventana de permiso: las firmas del dueño -----------------------------
# Una sola consulta a lib/owner-window.js con las firmas `freno` que juntaron ESC-C1, ESC-C3 y ESC-C4; las de los
# guiones (aprobar el plan, ESC-C6; aprobar un control, ESC-C7; eximir un crítico, la vuelta extra, …) las lee el propio
# módulo del comando. Contesta una de cuatro:
#   · deny: frena con la regla de la firma y el motivo de la ventana, que trae cómo firmarla en la terminal;
#   · ask: se guarda y se emite al salir 0 (salida_ok), así una regla posterior que frena sigue frenando;
#   · allow: una firma que el dueño delegó nombrándola en `approvals.delegated_signing` la dio quien coordina, con su
#     constancia;
#   · none: no hay firma que pedir (o la vuelta extra delegada, que la consume pipeline.js).
# Aprobar un control con `--relayed-by` ya no vale: la ventana lo niega (ESC-C7). Con el freno apagado por el ambiente
# no se consulta: los escapes ya dejaron su constancia, y los guiones sin registro de la ventana sólo firman en la
# terminal. Casos: scripts/tests/owner-window.test.js (la decisión) y scripts/tests/safety-escape.test.js (el freno).
ow_regla() { # $1 = la firma → la regla con que frena o deja constancia
  case "$1" in
    escape:TYCON_SAFETY_OFF|escape:TYCON_PROD_LINT|escape:TYCON_NEW_NAMES|escape:TYCON_TEST_GATE|escape:DOD_BYPASS|escape:TYCON_NO_DEEP_REVIEW|escape:TYCON_STATUS_GATE) echo "ESC-C1" ;;
    escape:cerrar-como-deuda) echo "ESC-C4" ;;
    plan-approval) echo "ESC-C6" ;;
    control-change|refresh-after-main) echo "ESC-C7" ;;
    *) echo "ESC-C3" ;;
  esac
}
ow_negar() { # la ventana negó: frena con el motivo de la firma
  local regla f clave esc sub a1
  regla="$(ow_regla "$OW_FIRMA")" || regla="ESC-C3"
  if [[ "$regla" == "ESC-C1" ]]; then esc_c1_negar "${OW_FIRMA#escape:}"; fi
  for f in ${_c3_negables[@]+"${_c3_negables[@]}"}; do
    IFS=$'\t' read -r clave esc sub a1 <<< "$f" || true
    [[ "escape:$clave" == "$OW_FIRMA" ]] || continue
    ESC_CARTEL="$OW_TEXTO
Primero lo que no necesita a la persona: lo de «Alternativa». Si no se puede, explicale qué falta y por qué: lo que sigue lo decide ella, entre dejar la historia como deuda (marker.js close-as-debt --reason \"<qué quedó pendiente>\" --debt <DEF-id>) o hacerlo igual."
    case "$clave" in
      cerrar-como-deuda) block "ESC-C4" \
          "Cerrar la historia como deuda (marker.js ${sub}) deja lo que no se pudo hacer como el final de la ejecución, con su deuda anotada." \
          "Si se puede terminar, terminá. Si no, explicale a la persona qué quedó pendiente y por qué." ;;
      force-manual) BLOCK_MOTIVO="force-manual"; block "ESC-C3" \
          "Declarar un control a mano (marker.js set-check … --force-manual) lo da por pasado sin correrlo; así escrito (escondido, en una variable o en una envoltura) no se firma." \
          "Corré el control de verdad: marker.js run-check <nombre> -- <comando>. Si no se puede, decíselo a la persona: si lo decide ella, la firma va en su forma exacta, sola: marker.js set-check <control> <estado> --force-manual [--for-session <D>]." ;;
      trust-ran) BLOCK_MOTIVO="trust-ran"; block "ESC-C3" \
          "Confiar en la lista de revisores que da el agente (pipeline.js check-count --trust-ran) deja la constancia de revisores que el arnés no vio correr; así escrito (escondido, en una variable o en una envoltura) no se firma." \
          "Lanzá los revisores que faltan y volvé a correr check-count. Si no se puede, decíselo a la persona: si lo decide ella, la firma va en su forma exacta, sola: pipeline.js check-count --repo <r> --story <s> --trust-ran [--for-session <D>]." ;;
      no-deep-review) BLOCK_MOTIVO="no-deep-review"; block "ESC-C3" \
          "--no-deep-review en ${sub} apaga el pase adversarial, la revisión que corre el código y más bugs encuentra." \
          "Si el portón dice que corre, lanzalo de fondo y avisá cuánto tarda; no se pregunta si correrlo. Apagarlo lo decide la persona, en la ventana de permiso." ;;
      set-autonomous) BLOCK_MOTIVO="set-autonomous"; block "ESC-C3" \
          "Apagar el modo autónomo (marker.js set-autonomous ${a1}) saca el lazo que no deja cerrar el turno con un control en rojo.${_c3_motivo:+ Hoy: ${_c3_motivo}.}" \
          "Arreglá lo que está en rojo y volvé a correr el control. Si no se puede, decíselo a la persona." ;;
      *) BLOCK_MOTIVO="cerrar-la-ejecucion"; block "ESC-C3" \
          "Cerrar la ejecución ahora (marker.js ${sub}) la archiva como si hubiera terminado, y no terminó: ${_c3_motivo:-tiene algo pendiente}." \
          "Terminá lo pendiente. Si no se puede, decíselo a la persona." ;;
    esac
  done
  ESC_CARTEL="$OW_TEXTO"
  case "$OW_FIRMA" in
    plan-approval) block "ESC-C6" \
        "Aprobar el plan es una firma de la persona, y este comando no la puede pedir en la ventana de permiso." \
        "Mostrale el plan a la persona y corré la aprobación en su forma exacta, sola, para que la apruebe en la ventana; o que la firme ella en su terminal." ;;
    control-change|refresh-after-main) block "ESC-C7" \
        "Aprobar un cambio de los controles del repo es una firma de una persona, y este comando no la puede pedir en la ventana de permiso." \
        "Corré run-base-controls.sh approve en su forma exacta, sola, para que la persona lo apruebe en la ventana; o que lo firme en su terminal." ;;
    *) [ "$regla" = "ESC-C3" ] && BLOCK_MOTIVO="firma-fuera-de-la-ventana"; block "$regla" \
        "Esto lo firma la persona, y este comando no la puede pedir en la ventana de permiso." \
        "Corré el comando de la firma en su forma exacta, solo, para que la persona lo apruebe en la ventana; o que lo firme ella en su terminal." ;;
  esac
}
_ow_mira=0
shopt -s nocasematch
if [[ ${#OW_ESCAPES[@]} -gt 0 || -n "$_c3_perdida" || "$_esc_cmd" == *marker* || "$_esc_cmd" == *pipeline* || "$_esc_cmd" == *e2e-setup* || "$_esc_cmd" == *run-base-controls* ]]; then _ow_mira=1; fi
shopt -u nocasematch
# lo que no consulta la ventana (no es una firma) vence igual los pedidos de su sesión
if [[ "$_ow_mira" != "1" ]]; then ow_vencer; fi
if [[ "$_ow_mira" == "1" ]]; then
  [[ -n "$_c3_sid" ]] || { _c3_sid="$(read_field session_id 2>/dev/null)" || _c3_sid=""; }
  ow_gate ${OW_ESCAPES[@]+"${OW_ESCAPES[@]}"}
  case "$OW_DECISION" in
    deny) ow_negar ;;
    ask)
      OW_ASK_JSON="$OW_JSON"
      for _ow_e in ${OW_ESCAPES[@]+"${OW_ESCAPES[@]}"}; do
        constancia "$(ow_regla "$_ow_e")" escape ventana "" "$_c3_sid" "${_ow_e#escape:}"
      done ;;
    allow) constancia "$(ow_regla "$OW_FIRMA")" escape delegacion "$OW_RELEVO" "$_c3_sid" "${OW_FIRMA#escape:}" ;;
    none)
      # la salida de una ejecución perdida que la ventana no reconoce como su firma (otro subcomando): no se firma acá
      if [[ -n "$_c3_perdida" ]]; then
        IFS=$'\t' read -r _c3_sub _c3_a1 <<< "$_c3_perdida" || true
        ESC_CARTEL="Esto lo decide una persona, no el agente: la salida de una ejecución perdida se firma con marker.js clear-session <sesión> --lost, en la ventana de permiso o en su terminal (--terminal)."
        BLOCK_MOTIVO="ejecucion-perdida"
        block "ESC-C3" \
          "Sacar una ejecución perdida (marker.js ${_c3_sub} ${_c3_a1}) la cierra o la rearma sin la pieza que le falta." \
          "Explicale a la persona qué pieza falta y que la firme con marker.js clear-session <sesión> --lost."
      fi ;;
  esac
fi
ESC_CARTEL=""

# ESC-C5: el permiso de escribir a mano la evidencia de la prueba en vivo (`ALLOW_DOD_EVIDENCE_WRITE`) y la exención de
# esa prueba (`dod_runtime_exempt: true`) escritos por la terminal los decide la persona, que los firma con
# `marker.js sign-file` y deja la escritura al Edit o Write. Frena un comando que crea, toca o copia un archivo con ese
# nombre (`touch`, `cp`, una redirección, `tee`, un intérprete, `New-Item`, `Set-Content`, …) y uno que escribe la
# exención en un `.md` (`sed -i`, `perl -i`, `>`, `>>`, `tee`); mirarlo, buscarlo, borrarlo o sacar la exención no frena.
# Mira el comando sin comillas y en minúsculas; lo que no ve: el nombre armado en una variable o un guion que lo escribe.
# Por la herramienta de escribir archivos, la exención la mira on-frontmatter-write.js y el permiso, on-dod-evidence-guard.js.
_c5_esc=""
shopt -s nocasematch
if [[ "$_esc_cmd" == *allow_dod_evidence_write* || "$_esc_cmd" == *dod_runtime_exempt* ]]; then _c5_esc="?"; fi
shopt -u nocasematch
if [[ -n "$_c5_esc" ]]; then
  _c5_esc=""
  # en minúsculas con `tr` o, si falla, con `awk`; si no se puede, se lee del lado que frena (el permiso, que pide la frase)
  _c5_min="$(printf '%s' "$_esc_cmd" | tr '[:upper:]' '[:lower:]')" || _c5_min=""
  if [[ -z "$_c5_min" ]]; then _c5_min="$(printf '%s' "$_esc_cmd" | awk '{ print tolower($0) }')" || _c5_min=""; fi
  if [[ -z "$_c5_min" ]]; then _c5_min="touch allow_dod_evidence_write"; fi
  # pedir la firma no crea el permiso: el comando entero y solo, `node <marker.js de este arnés> sign-file
  # allow_dod_evidence_write <archivo>`, sin ningún otro carácter de la consola, no se mira como creación; la ruta tiene
  # que llevar al marker.js de este arnés, no a uno que sólo se llama igual
  # entre las palabras, sólo espacios: un salto de línea o un tab parte el comando en dos para la consola
  # se mira el comando tal como llega, no el limpio: la limpieza borra acentos graves y barras que la consola sí ejecuta
  _c5_firma="^ *node +([A-Za-z0-9_./~:-]+) +sign-file +allow_dod_evidence_write +[A-Za-z0-9_./~:@%+=,-]+ *\$"
  shopt -s nocasematch
  if [[ "$CMD" =~ $_c5_firma ]]; then
    shopt -u nocasematch
    _c5_m="${BASH_REMATCH[1]}"
    [[ "$_c5_m" == "~/"* ]] && _c5_m="$HOME/${_c5_m#\~/}"
    _c5_propio="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../skills/tycon-pipeline/scripts" 2>/dev/null && pwd -P)" || _c5_propio=""
    _c5_suyo="$(cd "$(dirname "$_c5_m")" 2>/dev/null && pwd -P)" || _c5_suyo=""
    if [[ -n "$_c5_propio" && "$_c5_suyo" == "$_c5_propio" && "${_c5_m##*/}" == "marker.js" ]]; then _c5_min="node marker.js sign-file"; fi
  fi
  shopt -u nocasematch
  _c5_crea="(^|[^a-z0-9_-])(touch|cp|mv|install|ln|tee|node|python3?|perl|ruby|deno|bun|new-item|ni|set-content|sc|add-content|ac|out-file|copy-item|move-item)([[:space:]][^;&|]*)?allow_dod_evidence_write|>[[:space:]]*[^;&|[:space:]]*allow_dod_evidence_write"
  # sacar una línea con sed (`/…dod_runtime_exempt…/d`) no la agrega
  _c5_sin_borrar="$(printf '%s' "$_c5_min" | sed -E 's#/[^/]*dod_runtime_exempt[^/]*/d##g')" || _c5_sin_borrar="$_c5_min"
  _c5_exenta="dod_runtime_exempt:[[:space:]]*true"
  # la redirección es `>` o `>>` sueltos: `=>` o `->` dentro de un código no escriben un archivo
  _c5_md="(^|[^=<>-])>>?[[:space:]]*[^;&|[:space:]>]*\.md|(^|[^a-z0-9_-])tee[[:space:]][^;&|]*\.md"
  # sed o perl que editan en el lugar: la bandera como palabra suelta (`-i`, `-Ei`, `-pi`, `-i.bak`, `--in-place`; no el
  # `-i` de un nombre como `story-1.12-…-integracion`), y un `.md` en el comando (la expresión de sed puede traer `;`)
  _c5_inplace="(^|[^a-z0-9_-])(sed|gsed|perl)[[:space:]]([^;&|]*[[:space:]])?(-[a-z]*i[a-z]*(\.[a-z0-9]*)?|--in-place)([[:space:]=]|\$)"
  _c5_un_md="\.md([^a-z0-9]|\$)"
  if [[ "$_c5_min" =~ $_c5_crea ]]; then
    _c5_esc="ALLOW_DOD_EVIDENCE_WRITE"
  elif [[ "$_c5_sin_borrar" =~ $_c5_exenta ]] && { [[ "$_c5_sin_borrar" =~ $_c5_md ]] || { [[ "$_c5_sin_borrar" =~ $_c5_inplace ]] && [[ "$_c5_sin_borrar" =~ $_c5_un_md ]]; }; }; then
    _c5_esc="dod_runtime_exempt"
  fi
  if [[ -n "$_c5_esc" ]]; then
    _c5_sid="$(read_field session_id 2>/dev/null)" || _c5_sid=""
    # por la consola frena siempre: la firma de la ventana (marker.js sign-file) la consume sólo el Edit o Write, porque
    # de un comando de consola no se sabe con certeza a qué archivo escribe
    ESC_CARTEL="Esto lo decide la persona, no el agente: explicale qué falta y por qué. Si quiere darlo, lo firma en la ventana de permiso con marker.js sign-file ${_c5_esc} <archivo>, y la escritura va después con Edit o Write, nunca por la consola. Cómo lo da ella está en guides/safety-guard.md."
    if [[ "$_c5_esc" == "ALLOW_DOD_EVIDENCE_WRITE" ]]; then
      block "ESC-C5" \
        "El permiso ALLOW_DOD_EVIDENCE_WRITE deja escribir a mano la evidencia de la prueba en vivo, que tiene que salir de una prueba que corrió." \
        "Corré la prueba en vivo con su guion (el gate E2E del proyecto o el macro del humo): la evidencia la escribe él."
    else
      block "ESC-C5" \
        "Agregar dod_runtime_exempt: true a una historia la exime de la prueba en vivo." \
        "Corré la prueba en vivo. Si la historia de verdad no tiene nada que correr, decíselo a la persona. ¿Sólo la nombrabas en un texto (un heredoc)? Este freno mira el comando entero: escribí ese texto en un archivo."
    fi
  fi
fi
ESC_CARTEL=""

# ESC-C2: escribir en las conversaciones guardadas (`~/.claude/projects/`). Ninguna firma sale de ahí, pero sí la
# constancia de que el validador corrió sobre una historia, la del plan que vio la persona y lo que una historia dice
# haber hecho: un renglón agregado a mano no está en la cadena de la conversación (lib/person-ok.js lo descarta), y
# además se frena el camino directo. Sólo mira un comando que nombra la ruta `.claude/projects/` (sin contar la memoria del agente,
# `projects/<proyecto>/memory/`, que vive ahí y se escribe legítimamente), y frena si una forma de escribir apunta a
# ella dentro del mismo tramo del comando (entre `;`, `&` o `|`):
#   · una redirección con destino en la ruta, o a un `.jsonl` por su nombre relativo después de entrar a ella con `cd`;
#   · `tee`, `sponge`, `truncate`, `dd`, `cp`, `mv`, `install`, `ln`, `rsync` o `patch` con la ruta;
#   · `sed`, `perl`, `awk` o `ruby` con su opción `-i` (`-i`, `-pi`, `-i.bak`, `-i inplace`) sobre la ruta;
#   · código en la línea que abre para escribir con la ruta adentro del llamado (`open(…, 'w'|'a'|'x')`,
#     `writeFile…(…)`, `appendFile…(…)`, `createWriteStream(…)`); abrir para leer no frena;
#   · en PowerShell, `>`, `Out-File`, `Set-Content`, `Add-Content`, `Copy-Item` o `Move-Item` con la ruta.
# Leer (`tail`, `grep`, `ls`, `wc`, un guion que sólo lee) no frena. Como GIT-C2, un texto que trae una de esas
# escrituras también frena. Lo que no ve: la ruta armada por partes o con variables, o un guion escrito en un archivo
# que después se corre (el límite de la cadena de la conversación lo cubre aparte).
_esc_c2="$_esc_cmd"
if [[ "$_esc_c2" == *".claude/projects/"* ]]; then
  while [[ "$_esc_c2" =~ (.*)\.claude/projects/[^/[:space:]\;\&\|]+/memory(.*) ]]; do _esc_c2="${BASH_REMATCH[1]}MEMORIA${BASH_REMATCH[2]}"; done
fi
_esc_hit=0
if [[ "$_esc_c2" == *".claude/projects/"* ]]; then
  _esc_dir='\.claude/projects/'
  _esc_redir=">>?[[:space:]]*[^[:space:];&|]*${_esc_dir}"
  _esc_tool="(^|[^A-Za-z0-9_-])(tee|sponge|truncate|dd|cp|mv|install|ln|rsync|patch)[[:space:]][^;&|]*${_esc_dir}"
  _esc_inpl="(^|[^A-Za-z0-9_-])(sed|perl|awk|gawk|ruby)([[:space:]]+-[A-Za-z]+)*[[:space:]]+-[A-Za-z]*i([[:space:].][^;&|]*)?${_esc_dir}"
  # entrar a la carpeta y redirigir a una conversación por su nombre relativo (`>> <sesión>.jsonl`)
  _esc_cd="(^|[;&|(]|${_PS_NL})[[:space:]]*cd[[:space:]]+[^;&|[:space:]]*${_esc_dir}[^;&|]*[;&|]+.*>>?[[:space:]]*[^[:space:];&|/~\$&0-9][^[:space:];&|]*\.jsonl"
  # abrir para escribir: `open(<ruta>, w|a|x…)` (las comillas ya no están), o las funciones que sólo escriben
  _esc_open="open\([^)]*${_esc_dir}[^)]*,[[:space:]]*(mode=)?[wax]|(writeFile[A-Za-z]*|appendFile[A-Za-z]*|createWriteStream|write_text|write_bytes)\([^)]*${_esc_dir}"
  if [[ "$_esc_c2" =~ $_esc_redir || "$_esc_c2" =~ $_esc_tool || "$_esc_c2" =~ $_esc_inpl || "$_esc_c2" =~ $_esc_cd || "$_esc_c2" =~ $_esc_open ]]; then
    _esc_hit=1
  fi
fi
# PowerShell, sobre el comando como llegó: la ruta de Windows lleva barras invertidas, que la copia de arriba saca
if [[ "$_esc_hit" == "0" ]] && tool_is_ps && ps_match "(>|out-file|set-content|add-content|copy-item|move-item)[^;|]*\.claude[\\\\/]projects[\\\\/]" \
   && ! ps_match "\.claude[\\\\/]projects[\\\\/][^\\\\/[:space:]]+[\\\\/]memory"; then
  _esc_hit=1
fi
if [[ "$_esc_hit" == "1" ]]; then
  block "ESC-C2" \
    "Escribe en las conversaciones guardadas (~/.claude/projects/). De ahí se lee que el validador corrió y qué plan vio la persona: escribirlas es fabricar lo que pasó en la conversación." \
    "Las conversaciones se leen, no se escriben. Para leer, tail, grep o un guion que sólo lee; para guardar lo leído, la salida a otra carpeta desde un guion en un archivo. ¿Sólo nombrabas la ruta en un texto? Este freno mira el comando entero: escribí ese texto en un archivo."
fi

# --- Filesystem destructivo --------------------------------------------------

# rm -rf de raíz / home / cwd / parent. Bloqueamos cualquier `rm -rf` con
# targets críticos. Detección con regex tolerante a espacios y flags mezclados.
if [[ "$CMD" =~ (^|[[:space:]])sudo[[:space:]]+rm[[:space:]] ]]; then
  block "FS-C1" \
    "sudo rm es irrecuperable y suele indicar workaround a un permission issue real." \
    "Diagnosticá el permiso o pediendo elevación puntual, no borres con sudo."
fi

# `rm -rf /` o variantes con paths críticos absolutos
if [[ "$CMD" =~ (^|[[:space:]])rm[[:space:]]+(-[rRfF]+[[:space:]]+|-[-rfRF]*[[:space:]]+)*/([[:space:]]|$|\*) ]]; then
  block "FS-C2" \
    "rm -rf sobre raíz '/'. Irreversible y catastrófico." \
    "Si querés borrar algo, especificá el path completo (ej: /tmp/foo, ~/Downloads/bar)."
fi
# …y su forma de PowerShell: Remove-Item (o un alias) sobre `/`, `\` o la raíz de una unidad (`C:\`).
if ps_match "${_PS_DEL}"'(/|\\|[a-z]:[\\/]?|\$env:SystemDrive[\\/]?|\$\{env:SystemDrive\}[\\/]?)\*?'"${_PS_END}"; then
  block "FS-C2" \
    "Remove-Item sobre la raíz ('/', '\\' o la de una unidad). Irreversible y catastrófico." \
    "Si querés borrar algo, especificá la ruta completa (ej: C:\\Users\\vos\\proyecto\\bin)."
fi

# `rm -rf ~` / `rm -rf $HOME` (raíz del home).
# El target debe ser EXACTAMENTE `~` / `~/` / `$HOME` / `$HOME/` (la raíz del home, nada después):
# `/?([[:space:]]|$)` exige que tras `~`/`$HOME` venga fin-de-token, no un path. Sin esto, un
# `rm -f ~/.cache/foo` (archivo puntual bajo $HOME) daría falso positivo.
if [[ "$CMD" =~ (^|[[:space:]])rm[[:space:]]+(-[rRfF]+[[:space:]]+)*(\~|\$HOME)/?([[:space:]]|$) ]]; then
  block "FS-C3" \
    "rm -rf sobre \$HOME. Te borra todo el laburo, ssh keys, .zshrc, etc." \
    "Si querés limpiar algo específico bajo \$HOME, nombralo (ej: ~/.cache/foo)."
fi
# …y su forma de PowerShell: Remove-Item sobre `~`, `$HOME` o `$env:USERPROFILE` (la raíz, nada después).
if ps_match "${_PS_DEL}"'(~|\$home|\$env:userprofile|\$env:home|\$\{env:userprofile\}|\$\{env:home\})[\\/]?'"${_PS_END}"; then
  block "FS-C3" \
    "Remove-Item sobre la carpeta del usuario. Te borra todo el laburo, las llaves ssh, la configuración." \
    "Si querés limpiar algo específico ahí adentro, nombralo (ej: \$HOME\\.cache\\foo)."
fi

# `rm -rf .` o `rm -rf ./` o `rm -rf ..` (cwd o parent wipe)
if [[ "$CMD" =~ (^|[[:space:]])rm[[:space:]]+(-[rRfF]+[[:space:]]+)*(\.|\.\/|\.\.|\.\.\/)([[:space:]]|$) ]]; then
  block "FS-C4" \
    "rm -rf sobre . o .. Borra el cwd completo (típicamente un repo entero)." \
    "Especificá qué borrar (ej: rm -rf node_modules, rm -rf bin obj)."
fi
# …y su forma de PowerShell: Remove-Item sobre `.` o `..` (con o sin la barra de cualquiera de los dos lados).
if ps_match "${_PS_DEL}"'(\.|\.\.)[\\/]?'"${_PS_END}"; then
  block "FS-C4" \
    "Remove-Item sobre . o .. Borra la carpeta actual completa (típicamente un repo entero)." \
    "Especificá qué borrar (ej: Remove-Item -Recurse -Force node_modules)."
fi

# `chmod -R 777` o `chmod 777 /`
if [[ "$CMD" =~ chmod[[:space:]]+(-R[[:space:]]+)?777([[:space:]]+/|[[:space:]]+\~|[[:space:]]+\$HOME)?([[:space:]]|$) ]]; then
  block "FS-C5" \
    "chmod 777 abre todos los permisos. Es señal de workaround a un permission issue mal diagnosticado." \
    "Diagnosticá quién falla con permisos y dale solo lo necesario (chmod u+x, chown deva, etc.)."
fi

# --- Git destructivo ---------------------------------------------------------

# Las OPCIONES DE GIT que pueden ir entre `git` y el subcomando. Buscar el subcomando pegado a `git`
# (`git commit`, `git clean`) dejaría pasar con exit 0 el salteo de hooks de `git -C <carpeta> commit …`
# —la forma que Claude usa normalmente—, por Bash y por PowerShell. Se admite cualquier
# cantidad de opciones, con o sin valor: `-C <ruta>`, `-c clave=valor`, `--git-dir=…`, `--work-tree …`,
# `-P`, `--no-pager`. Una ruta puede ir entre comillas simples o dobles (con espacios), con barras
# invertidas de Windows (también una al final: en PowerShell no escapan nada) o como `$(…)`.
# Casos: `gitopts-…` en scripts/controls-bench/cases/hooks/01-frenos-duros.json.
_GIT_SQ="'"
_GIT_DQ='"'
_GIT_BT='`'
_GIT_WORD="(\\\\.|\\\$\\([^)]*\\)|${_GIT_DQ}[^${_GIT_DQ}]*${_GIT_DQ}|${_GIT_SQ}[^${_GIT_SQ}]*${_GIT_SQ}|[^[:space:];&|()<>${_GIT_BT}${_GIT_DQ}${_GIT_SQ}])+"
_GIT_OPTS="(-[-A-Za-z]+(=|[[:space:]]+)${_GIT_WORD}[[:space:]]+|-[-A-Za-z]+[[:space:]]+)*"

# git push --force / -f a branches protegidas (main, master, dev, release/*).
# NO bloqueamos --force-with-lease a feature branches propias (caso legítimo).
# El force-flag Y la branch se chequean SOLO dentro de cada segmento
# `git push ...` (hasta el próximo separador ; && || |), NO sobre todo el comando: un `-f` de OTRO
# subcomando en la misma cadena (ej: `git add -f x && git push origin dev`) no debe disparar el block
# si el push es un fast-forward normal sin force.
# 🔴 Por POSICIÓN, no por substring. Un segmentador `git[[:space:]]+push[^;&|]*` haría que cualquier
# MENCIÓN de un push —en un echo, en el cuerpo de un heredoc, en un grep— abriera un segmento que se
# come párrafos enteros hasta el próximo `;`, y ahí alcanzaría un `-f` de un `[ -f ]` y la palabra
# `main` para bloquear. Y este freno BLOQUEA: cada falsa alarma enseña a pedir la emergencia.
# Un `git push` cuenta sólo si ARRANCA un comando: al principio, o después de `;`, `&&`,
# `||`, `|`, `(`, con o sin `command`/ruta. Es el mismo criterio que engram-pre-commit.sh (`_GIT`).
# Un push real tras `&&`, `;` o `(` sigue frenando
# (casos block-force-push-main-encadenado / -tras-cd / -en-subshell del banco).
# 🔴 Y el comando puede tener PREFIJO: admitir sólo `command` o una ruta antes de `git` dejaría pasar
# (exit 0) `VAR=1 git push -f`, `sudo git push -f`, `if …; then git push -f`, `{ git push -f; }`,
# `bash -c "git push -f …"`, `git -C /x push -f` y `HEAD:main`. La peor:
# `TYCON_SESSION_GUARD_OK=1 git push --force origin main`, que es exactamente la forma que el
# session-collision-guard exige como escape. Lo que se admite antes de `git`: asignaciones
# `VAR=valor`, las palabras que envuelven un comando (sudo, env, time, nohup, exec, command,
# timeout, nice, y sus banderas/números), y como separador también `{`, el backtick, `!`, las
# palabras `then`/`do`/`else`, y `-c "` / `-c '` de un shell (bash -c). Una comilla SOLA no abre
# un comando: `echo "git push -f origin main"` sigue siendo prosa (caso pass-echo-entre-comillas).
# Residual sabido: una línea de heredoc que ARRANCA con el push frena igual (caso
# pass-heredoc-cuya-linea-arranca…, declarado como must-block a propósito).
_GIT_POS='(^|[;&|({`!=]|&&|\|\||-c[[:space:]]+["'"'"']|(then|do|else)[[:space:]])[[:space:]]*(([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|sudo|env|time|nohup|exec|command|timeout|nice|-[A-Za-z]+|[0-9]+)[[:space:]]+)*([^[:space:]]*/)?git[[:space:]]+'"${_GIT_OPTS}"
while IFS= read -r _push_seg; do
  [[ -z "$_push_seg" ]] && continue
  # Forzado = `--force`/`-f`… o el refspec `+rama` (que fuerza sin bandera). La rama protegida
  # puede venir tras un espacio o tras `:` (`HEAD:main`, `dev:main`).
  _forzado=0
  [[ "$_push_seg" =~ (--force|--force-with-lease|-f)([[:space:]]|=|$) ]] && _forzado=1
  [[ "$_push_seg" =~ [[:space:]]\+(main|master|dev|release/) ]] && _forzado=1
  if [[ "$_forzado" == 1 ]] && \
     [[ "$_push_seg" =~ (origin|upstream)?([[:space:]]+|:)\+?(main|master|dev|release/) ]]; then
    block "GIT-C1" \
      "git push --force a main/master/dev/release. Re-escribe historia compartida." \
      "Si necesitás reescribir historia en main, hablalo en el equipo. Para una feature branch propia: usá --force-with-lease."
  fi
done < <(printf '%s\n' "$CMD" | grep -oiE "${_GIT_POS}push[^;&|]*" || true)

# `--no-verify` en git commit / push / merge. Saltea hooks (pre-commit, etc).
if [[ "$CMD" =~ git[[:space:]]+${_GIT_OPTS}(commit|push|merge|rebase)[[:space:]] ]] && \
   [[ "$CMD" =~ --no-verify([[:space:]]|$) ]]; then
  # 🔴 FALSO POSITIVO CONOCIDO, y por qué NO se arregla matcheando más fino: el
  # match mira TODO el comando, así que también salta cuando la bandera aparece dentro del MENSAJE
  # de un commit — un heredoc, o un `-m "..."` (por ejemplo, el commit de un control que habla de ella).
  #
  # Y NO se arregla enseñándole a ignorar "el cuerpo de un heredoc": eso es spoofeable — alcanza
  # con envolver el comando real entre dos líneas que parezcan las marcas del heredoc para que el
  # salteo de verdad pase por debajo. Y este guard es fail-open ante un error del parser, o sea
  # que un bug del detector nuevo lo apagaría ENTERO, en silencio. Aflojar un freno para ganar
  # comodidad en un caso raro es mal negocio.
  #
  # La salida no es tocar el match: es sacar el texto del comando. Y eso se DICE acá abajo, en el
  # mensaje — una convención que hay que acordarse es una convención que no se usa.
  block "GIT-C2" \
    "--no-verify saltea hooks (pre-commit, formatters, security checks). Si un hook falla, el problema es real." \
    "Arreglá lo que el hook reporta. Si el hook está roto, fixeá el hook, no lo bypaseés.
   ¿Sólo la MENCIONABAS en el texto del commit? Este freno mira el comando entero y no distingue
   usar la bandera de escribir sobre ella. Escribí el mensaje en un archivo y pasalo con -F: el
   texto deja de estar en el comando y el freno deja de verlo."
fi

# Las otras dos formas de saltear los hooks de git (GIT-C2):
# 1. `git commit -n`, la forma corta. SÓLO en `commit`: en `push` es «simular» y en `merge` «sin estadísticas».
#    Suelta o agrupada (`-nm "x"`, `-an`), pero antes de una letra que lleva valor: en `-mn` la `n` ES el mensaje.
#    Mira sólo los `git commit` que ARRANCAN un comando (como el freno de push), y el texto entre comillas no cuenta:
#    `git commit -m "-n en el mensaje"` pasa.
# 2. Apuntar los hooks a otra carpeta para ese comando: `git -c core.hooksPath=<lo que sea> commit|push|merge|rebase`,
#    `--config-env=core.hooksPath=…`, o las variables GIT_CONFIG_KEY_<n> / GIT_CONFIG_PARAMETERS que lo nombran (por
#    texto: bash o PowerShell). La clave de git no distingue mayúsculas: se compara sin distinguirlas.
#    Fuera de alcance, a propósito: `git config core.hooksPath …` persistente (husky lo usa de forma legítima).
# Casos: `gitn-…` en scripts/controls-bench/cases/hooks/01-frenos-duros.json.
_GIT_C2_ALT="Arreglá lo que el hook reporta. Si el hook está roto, fixeá el hook, no lo bypaseés."
while IFS= read -r _commit_seg; do
  [[ -z "$_commit_seg" ]] && continue
  # lo que va entre comillas es texto (un mensaje), no banderas. Con bash puro: el freno corre también con un PATH
  # mínimo (casos `sin-jq-…` del banco: bash, node, cat, date, mkdir, dirname, grep), sin sed ni tr
  _GIT_QUOTED="(${_GIT_DQ}[^${_GIT_DQ}]*${_GIT_DQ}|${_GIT_SQ}[^${_GIT_SQ}]*${_GIT_SQ})"
  while [[ "$_commit_seg" =~ $_GIT_QUOTED ]]; do _commit_seg="${_commit_seg/"${BASH_REMATCH[0]}"/Q}"; done
  if [[ "$_commit_seg" =~ [[:space:]]-[abdeghijklopqrsvwxyzABDEGHIJKLMNOPQRTUVWXYZ]*n[A-Za-z]*([[:space:]]|$) ]]; then
    block "GIT-C2" \
      "git commit -n es la forma corta de --no-verify: saltea los hooks (pre-commit, formatters, security checks). Si un hook falla, el problema es real." \
      "$_GIT_C2_ALT"
  fi
done < <(printf '%s\n' "$CMD" | grep -oE "${_GIT_POS}commit([[:space:]][^;&|]*)?" || true)
_GIT_HP="(${_GIT_DQ}core\\.hookspath=[^${_GIT_DQ}]*${_GIT_DQ}|${_GIT_SQ}core\\.hookspath=[^${_GIT_SQ}]*${_GIT_SQ}|core\\.hookspath=(${_GIT_WORD})?)"
_GIT_HOOKS_SUB="git[[:space:]]+${_GIT_OPTS}(commit|push|merge|rebase)([[:space:]]|\$)"
_GIT_HP_OPT="git[[:space:]]+${_GIT_OPTS}(-c[[:space:]]+|--config-env(=|[[:space:]]+))${_GIT_HP}[[:space:]]+${_GIT_OPTS}(commit|push|merge|rebase)([[:space:]]|\$)"
_GIT_HP_ENV="git_config_(key_[0-9]+|parameters)[[:space:]]*=[^;&|]*core\\.hookspath"
_git_hp=0
shopt -s nocasematch   # la clave de git no distingue mayúsculas (bash 3.2 también lo respeta en =~)
[[ "$CMD" =~ $_GIT_HP_OPT ]] && _git_hp=1
if [[ "$CMD" =~ $_GIT_HP_ENV ]] && [[ "$CMD" =~ $_GIT_HOOKS_SUB ]]; then _git_hp=1; fi
shopt -u nocasematch
if [[ "$_git_hp" == 1 ]]; then
  block "GIT-C2" \
    "core.hooksPath apuntado a otra carpeta para un commit/push/merge/rebase saltea los hooks del repo, igual que --no-verify. Si un hook falla, el problema es real." \
    "$_GIT_C2_ALT"
fi

# git clean -fdx (borra incluso archivos gitignored — puede llevarse .env, builds locales)
if [[ "$CMD" =~ git[[:space:]]+${_GIT_OPTS}clean[[:space:]] ]] && \
   [[ "$CMD" =~ -[fFdDxX]*x[fFdDxX]*([[:space:]]|$) ]]; then
  block "GIT-C3" \
    "git clean -fdx borra archivos gitignored (.env, builds locales, secretos). Suele perderse trabajo." \
    "Sin -x: git clean -fd. Para inspeccionar primero: git clean -ndx."
fi

# GIT-C4: staging masivo en el repo AgentSkills.
# ~/.claude/agent-skills mezcla lo propio del equipo (tycon-*) con ~100 archivos
# bmad-* en drift permanente (M esperado, NUNCA se commitea). `git add -A`/`.`
# ahí stagea el drift entero → commits que pisan BMAD. Staging selectivo SIEMPRE.
#
# 🔴 El árbol del que salen las skills instaladas, sea cual sea su carpeta.
# Con el arnés y agent-skills en UN repo, las skills de la máquina no salen por fuerza de
# ~/.claude/agent-skills: salen del árbol al que resuelve ~/.claude/skills, que puede ser el clon
# del repo unido en cualquier carpeta. Mirar sólo si la ruta dice `/.claude/agent-skills` dejaría pasar
# `git add -A` parado en ese clon, con todo lo ajeno que vive en ese árbol. Frena:
#   · donde la ruta dice `/.claude/agent-skills` (no se le saca nada), y
#   · en el árbol de las skills instaladas: ~/.claude/skills enlazada a <árbol>/skills, o una carpeta
#     real con un enlace por skill (ahí decide la entrada tycon-pipeline). Tiene que ser un clon
#     (trae .git) y no ~/.claude mismo: skills que son una carpeta real de la HOME no tienen «árbol».
# En un clon de trabajo cualquiera NO frena: ahí no hay nada ajeno que stagear.
# Sólo lo que trae bash: `cd`, `pwd -P`, `[[ … ]]` (con `-d`, `-L`, `-e` y `-ef`), expansión de parámetros
# y comparación de texto. Sin `jq`, sin `node`, sin ninguna herramienta del PATH; corre en el bash 3.2 de Mac.
# Casos: `git-c4-…` en scripts/controls-bench/cases/hooks/01-frenos-duros.json.
#
# 🔴 Dos huecos que la regla cierra, los dos acá adentro:
#
# 1. EL `cd` EN EL MISMO COMANDO. Decidir sólo por el `cwd` que reporta el hook dejaría pasar
#    `cd ~/.claude/agent-skills && git add -A` corrido desde otra carpeta, y lo mismo
#    `cd <árbol>; git add --all`, `(cd <árbol> && git add .)` y `git -C <árbol> add -A`. Las dos
#    últimas exigen reconocer el `git add` masivo con el `-C` en el medio, y con un espacio o el
#    final después del `.` (en el subshell viene un `)`).
#    Además del `cwd`, se mira CADA carpeta que el propio comando nombra con `cd <dir>`,
#    `pushd <dir>` o `git -C <dir>`: con comillas simples o dobles, con `~`, `$HOME` o `${HOME}`
#    literales al principio, y relativa al `cwd` (y a la del `cd` anterior) si no es absoluta. Si
#    CUALQUIERA cae en un árbol frenado, frena. Conservador a propósito: es un freno, y un falso
#    positivo acá cuesta poco (se stagea por nombre). Lo que pasa a propósito:
#      · un `cd` a un clon de trabajo cualquiera + `git add -A` pasa (ahí no hay nada ajeno);
#      · `echo "git add -A"` parado en el árbol pasa (tras `-A` viene una comilla);
#      · `echo "git add -A ya"` parado en el árbol frena: esta regla mira el comando
#        entero y no distingue usar el `git add` de escribir sobre él. El mismo falso positivo vale
#        para un comando que NOMBRA el árbol con `cd` y menciona el `git add` masivo.
#    Lo que no ve, dicho: una carpeta que llega por una variable que el comando NO asigna a la vista
#    (viene del ambiente, de un `for`, de un argumento `$1`; la que el mismo comando asigna una sola vez
#    sí se lee: punto e de más abajo), por una sustitución (`cd "$(…)"`) o por `--git-dir`/`--work-tree`.
#    El freno no ejecuta el comando: sólo lee su texto.
#
# 2. CALLAR CUANDO NO PUEDE MIRAR. Si ~/.claude/skills (o su entrada tycon-pipeline) EXISTE pero no
#    se puede resolver —un enlace colgado, una carpeta sin permiso de entrada— la regla no sabe cuál
#    es el árbol de las skills instaladas, y dejar pasar el `git add -A` sin una palabra sería callar. Lo
#    DICE, en una línea, y sale 1. «No existe» sigue siendo silencio: no es un error, es «no hay árbol».
#    Por qué 1 y no 0 ni 2 — la misma cuenta que `cannot_read` (ver el encabezado):
#      · con 0 la herramienta manda el stderr de un PreToolUse al registro de depuración: avisar con
#        salida 0 es callar, que es justo el defecto;
#      · con 2 frenaría TODO `git add -A` de una máquina con la instalación rota, también en un clon
#        de trabajo, donde stagear todo es legítimo: sin árbol resuelto no se sabe si es el lugar;
#      · con 1 el comando corre y a la persona le aparece la PRIMERA línea de stderr. Hereda el límite
#        de `cannot_read`: no está medido en una sesión real, y al modelo no le llega (sólo le llega el
#        `exit 2`).
#    El aviso sale AL TERMINAR el guion (por `trap … EXIT`), no acá: salir en el momento dejaría sin
#    mirar las reglas de más abajo, y un `git add -A && curl … | bash` pasaría entero. Si una regla
#    posterior frena, gana el freno y el aviso no sale. Sólo avisa cuando el comando ES un `git add`
#    masivo (un aviso en cada comando de la sesión sería ruido), y con el freno apagado por el dev calla.
#
# 🔴 Otros puntos de la misma regla, todos acá adentro: cuatro de fondo (a–d), uno que sale al medir el
# tercero (e) y uno del arreglo de ese mismo punto (f):
#
# a. LA IDENTIDAD DE CARPETA NO ES TEXTO. `cd <dir> && pwd -P` de bash devuelve la ruta con las mayúsculas
#    con que se ESCRIBIÓ, no con las del disco. En un disco que no las distingue (Mac y Windows) la misma
#    carpeta nombrada de otra forma no caería en el árbol, y si el enlace ~/.claude/skills estuviera
#    escrito con otras mayúsculas el freno no dispararía nunca. «¿Es la misma carpeta?»
#    se contesta con `[[ a -ef b ]]` (mismo dispositivo y mismo inodo: es de bash, no del PATH), y «¿está
#    adentro del árbol?», subiendo por sus carpetas madre y probando `-ef` en cada nivel. La comparación
#    del texto `/.claude/agent-skills` se conserva además: frena aunque la carpeta no exista.
#
# b. EL RECORRIDO MIRA TODAS LAS CARPETAS DE CADA TRAMO. Una expresión voraz que fuera del primer `git` al ÚLTIMO
#    ` -C ` sin `;`, `&` ni `|` en el medio —el salto de línea no cortaría— dejaría sin mirar todo `cd`/`-C` del
#    medio cuando hay dos `-C` en el mismo `git` (git los encadena: `-C a -C b` es a/b) o un guion de varias
#    líneas. Y «la carpeta del `cd` anterior» como una sola cadena no alcanza: tras un `cd` que no deja al shell
#    ahí (subshell, `pushd`/`popd`, `cd -`), dos `cd` relativos tienen que probarse contra el `cwd`. Se
#    saca CADA `cd <dir>`, `pushd <dir>` y `-C <dir>`, uno por vuelta, de izquierda a derecha. Como leyendo
#    el texto no se puede saber en qué carpeta queda el shell, las candidatas son un SUPERCONJUNTO: una
#    ruta absoluta, tal cual; una relativa, contra el `cwd` del hook y contra cada carpeta nombrada antes.
#    Con que UNA caiga en el árbol, frena. Cuenta todo ` -C <palabra>`, sea de git o no (`tar -C`, `grep
#    -C 3`): de más, nunca de menos.
#
# c. NO FRENAR POR EL `cwd` SI EL COMANDO SE LLEVA EL `git add` A OTRO REPO.
#    En una máquina de un solo árbol el `cwd` de toda sesión del arnés es el checkout del que salen las
#    skills: `cd <clon de trabajo> && git add -A` y `git -C <clon de trabajo> add -A` frenarían siempre.
#    El `cwd` cuenta sólo si algún `git add` masivo del
#    comando corre «donde está»: sin un `-C` propio y sin un `cd`/`pushd` ANTES de él, en el texto, a
#    una carpeta que se pudo leer. Un `cd` que viene después, o el `-C` de otro comando, no lo sueltan.
#    Tampoco un `cd` que sólo está escrito: tiene que ARRANCAR un comando (una comilla no abre uno:
#    `echo "cd <otro>"` es texto; `$(cd <otro> && pwd)` es un subshell) y no estar en el cuerpo de un
#    heredoc todavía abierto.
#    «Se pudo leer» = está escrita entera (punto e) y EXISTE, o es una ruta absoluta que todavía no existe
#    y el propio comando crea antes (`mkdir -p <dir> && cd <dir>`, `git clone … <dir>; cd <dir>`). Un
#    `cd "$D"` sin valor a la vista no prueba que el comando se vaya, y un `cd` a una carpeta que NO existe
#    tampoco: es el clon descartable que se borró (o que se llevó un reinicio), el `cd` falla y, si el
#    comando sigue con `;`, el `git add -A` corre en el árbol. Parado en el árbol, frena.
#    🟡 LÍMITE QUE QUEDA, a propósito: parado en el árbol, pasa un comando cuyo texto dice que se va y
#    cuyo shell NO se va, o vuelve sin nombrar el árbol: `cd <otro>; cd -; git add -A`, `(cd <otro> && …);
#    git add -A`, `pushd <otro>; …; popd; git add -A`, un `cd <otro>` que no llega a correr (`cd <no
#    existe> && cd <otro>; git add -A`), una función que hace el `cd` y nadie llama. Para
#    cerrarlo habría que ejecutar el comando, y el freno sólo lee su texto. Caso que lo declara:
#    `git-c4-pass-cd-elsewhere-then-cd-dash-then-add-all-known-limit`. El otro límite, hacia el lado
#    contrario (frena de más): por el superconjunto del punto b, alcanza con que el comando NOMBRE el
#    árbol en cualquier parte, aunque sea después del `git add`; y parado en el árbol, `cd <otro> &&
#    cd <sub>` frena si <sub> existe también adentro del árbol.
#
# d. FORMAS DEL `git add` MASIVO QUE TAMBIÉN SE RECONOCEN: `git add ./`, y `-A`/`--all`/`.` pegados a una
#    redirección (`git add -A>/dev/null`) o al acento grave que cierra una sustitución.
#
# e. LA CARPETA QUE LLEGA POR UNA VARIABLE DEL MISMO COMANDO. Aplicar el punto c sólo a rutas escritas
#    a mano no alcanza: la forma habitual es `S=<ruta>; cd $S/<clon>`. Una variable con UNA sola
#    asignación escrita antes en el mismo comando se reemplaza por su valor (git_c4_expand), para los dos
#    lados: `D=<árbol>; cd "$D" && git add -A` frena desde cualquier carpeta, y `S=<otro>; cd $S/<clon>`
#    cuenta como irse. Y de una ruta absoluta con un final que no se lee (`$S/foto-$r` en un lazo) alcanza
#    con su carpeta madre, si existe y no está en el árbol ni lo tiene adentro (y el comando no trae
#    ningún `..`). Siguen frenados: funciones con `$1`, guiones escritos con un heredoc que traen su
#    propio `git add`, `bash -c '…'`, lazos con `cd`, y el que de verdad nombra ~/.claude/agent-skills.
#
# f. EL RECORRIDO TIENE QUE VER LAS COMILLAS (es un esquive posible del punto c). Para decidir si un `cd`
#    arranca un comando, mirar sólo el carácter anterior no sabe si está dentro de una comilla abierta.
#    Parado en el árbol pasarían `echo "; cd /tmp" >/dev/null; git add -A` (el `cd` es texto del `echo`)
#    y `git -c x=" -C /tmp" add -A` (el `-C` es el valor de otra opción). Hay dos lecturas del mismo comando:
#      · para FRENAR, el comando crudo: toda carpeta nombrada cuenta, aunque esté entre
#        comillas (frena de más, a propósito);
#      · para DESCONTAR la carpeta de la sesión, una copia enmascarada (git_c4_mask): sólo cuenta el `cd`,
#        el `pushd`, el `-C`, la asignación `S=<ruta>` y el `mkdir` que están FUERA de toda comilla
#        (simples, dobles, `$'…'`), de todo comentario y del cuerpo de todo heredoc. La comilla que
#        envuelve el ARGUMENTO no molesta: `cd "<ruta con espacios>/clon" && git add -A` sigue descontando.
#    🟡 `bash -c "cd <otro> && git add -A"` (y `sh -c`, `eval "…"`) NO descuenta. Ese `cd` sí
#    correría, pero leer el texto de un `-c` como comando es reabrir este mismo esquive. Parado en el
#    árbol frena; se sale escribiendo el `cd` afuera. Caso: `git-c4-block-shell-dash-c-string-with-cd-…`.
#    Para que eso valga, `bash -c "git add -A"` parado en el árbol también frena: tras `-A` viene la comilla
#    que cierra, y eso no se tomaría por un `git add` masivo. Con
#    un shell `-c` o un `eval` en el comando, la comilla que cierra también cierra el `git add`.
#    Lo que sigue sin verse, de la familia del límite del punto c: `$(…; cd <otro>)` y los acentos graves
#    son subshells que no se enmascaran.
#
# Tope: se siguen hasta 64 carpetas distintas que existan (GIT_C4_MAX) y se resuelven hasta 512 candidatas
# en total (GIT_C4_MAX_TRIES: cada una cuesta un proceso, y sin esto un comando armado para eso colgaría
# el freno). Un comando con un `git add` masivo que pasa de ahí frena, y lo dice: lo que no se pudo mirar
# no pasa callado.

# Una PALABRA del shell: trozos entre comillas, caracteres escapados, o texto sin espacios ni separadores.
GIT_C4_SQ="'"
GIT_C4_DQ='"'
GIT_C4_BS='\'
GIT_C4_BT='`'
GIT_C4_MAX=64
GIT_C4_MAX_TRIES=512
GIT_C4_WORD="(${GIT_C4_BS}${GIT_C4_BS}.|${GIT_C4_DQ}[^${GIT_C4_DQ}]*${GIT_C4_DQ}|${GIT_C4_SQ}[^${GIT_C4_SQ}]*${GIT_C4_SQ}|[^${GIT_C4_BS}[:space:];&|()<>${GIT_C4_BT}${GIT_C4_DQ}${GIT_C4_SQ}])+"
# Un `git add` masivo: entre `git` y `add` sólo puede haber opciones de git (con o sin valor: `-C <dir>`,
# `-c k=v`, `--no-pager`), y después de `-A`/`--all`/`.`/`./` viene un espacio, un separador, una
# redirección, el acento grave que cierra o el final.
GIT_C4_MASS_ADD="git[[:space:]]+(-[-A-Za-z]+(=|[[:space:]]+)${GIT_C4_WORD}[[:space:]]+|-[-A-Za-z]+[[:space:]]+)*add[[:space:]]+(-A|--all|\\.|\\./)([[:space:];&|)<>${GIT_C4_BT}]|\$)"
# La misma, con la comilla que cierra como final: vale sólo cuando el comando trae un shell con `-c` o un
# `eval` (GIT_C4_SHELL_STRING), que es cuando el texto entre comillas ES un comando (`bash -c "git add -A"`).
# En cualquier otro comando la comilla no cierra: `echo "git add -A"` es texto y pasa, como pasaba.
GIT_C4_MASS_ADD_IN_STRING="git[[:space:]]+(-[-A-Za-z]+(=|[[:space:]]+)${GIT_C4_WORD}[[:space:]]+|-[-A-Za-z]+[[:space:]]+)*add[[:space:]]+(-A|--all|\\.|\\./)([[:space:];&|)<>${GIT_C4_BT}${GIT_C4_DQ}${GIT_C4_SQ}]|\$)"
GIT_C4_SHELL_STRING="(^|[^A-Za-z0-9_.-])((bash|sh|zsh|dash|ksh)[[:blank:]]+(-[-A-Za-z]+[[:blank:]]+)*-[A-Za-z]*c|eval)[[:blank:]]"
# Dónde el comando nombra una carpeta: `cd`/`pushd` como palabra entera, o un `-C` suelto. UNA por
# coincidencia, sin tramo en el medio: el recorrido avanza de a una (ver el punto b). Tras `cd` o `-C`
# van espacios o tabulaciones, no un salto de línea: un `cd` solo en su renglón no nombra nada.
GIT_C4_NAV="(^|[^A-Za-z0-9_./-])(cd|pushd)[[:blank:]]+|(^|[[:space:]])-C[[:blank:]]+"
# De una ruta absoluta, el tramo que se lee entero: desde la raíz (`/` o, en Windows, `C:/`) hasta la última
# `/` anterior a la primera variable, sustitución o comodín.
GIT_C4_KNOWN_HEAD='^(/|[A-Za-z]:/)[^$`*?[]*/'
# Cuándo un `cd`/`pushd` ARRANCA un comando (y entonces puede mover al shell): lo que tiene delante termina
# en el principio, un separador, un salto de línea, o una palabra que abre un bloque. Una comilla no abre
# un comando (`echo "cd <otro>"` es texto); `$(` tampoco cuenta: es un subshell, el shell de afuera no se mueve.
GIT_C4_NL=$'\n'
GIT_C4_STARTS="(^|[;&|({!${GIT_C4_NL}])[[:blank:]]*\$"
GIT_C4_STARTS_WORD="(^|[[:space:];&|(])(then|do|else|command|builtin|time)[[:blank:]]+\$"
GIT_C4_SUBST='[$][(][[:blank:]]*$'
# Lo que el enmascarador (git_c4_mask) tiene que mirar de a uno: comillas, barra invertida, `#`, `<`, `$`
# y salto de línea; qué cierra unas comillas dobles o un `$'…'`; y la palabra de cierre de un heredoc
# (`<<'EOF'`, `<<EOF`, `<<"EOF"`, `<<\EOF`).
GIT_C4_SPECIAL="[${GIT_C4_SQ}${GIT_C4_DQ}${GIT_C4_BS}${GIT_C4_BS}#<\$${GIT_C4_NL}]"
GIT_C4_IN_DQ="[${GIT_C4_DQ}${GIT_C4_BS}${GIT_C4_BS}]"
GIT_C4_IN_ANSI="[${GIT_C4_SQ}${GIT_C4_BS}${GIT_C4_BS}]"
GIT_C4_HEREDOC_TAG="^[${GIT_C4_DQ}${GIT_C4_SQ}${GIT_C4_BS}${GIT_C4_BS}]?([A-Za-z0-9_.-]+)[${GIT_C4_DQ}${GIT_C4_SQ}]?"
GIT_C4_MASK_MAX=12000

# git_c4_mask — deja en GIT_C4_MASK una copia de $CMD, DEL MISMO LARGO (cada posición de una es la misma
# posición de la otra), con lo que el shell NO va a ejecutar acá reemplazado por un relleno sin espacios ni
# separadores (`x`): el contenido de las comillas simples, de las dobles y de `$'…'`, el carácter que sigue
# a una barra invertida, los comentarios y el cuerpo de los heredocs. Las comillas mismas quedan.
# Por qué: un recorrido ciego a las comillas dejaría pasar, parado en el árbol, `echo "; cd /tmp" >/dev/null;
# git add -A`: el `cd` del texto se tomaría por un movimiento real y descontaría la carpeta de la sesión. Lo
# mismo `git -c x=" -C /tmp" add -A`. Para DESCONTAR
# (lo que deja pasar) sólo cuenta lo que en esta copia sigue a la vista; para FRENAR se sigue mirando el
# comando crudo, que es de más y nunca de menos.
# Una comilla que queda abierta tapa todo lo que sigue; un heredoc cuya palabra de cierre no se puede leer
# (`<< $x`), también; y un comando de más de GIT_C4_MASK_MAX caracteres se tapa entero (el recorrido es
# cuadrático: medido, 25 ms con 4.000 caracteres de un guion común, 0,3–0,5 s en los peores 4.000 armados
# a propósito). Tapar de más es no descontar: frena, nunca suelta.
# Sólo expansión de parámetros y `[[ … ]]`: nada del PATH.
git_c4_mask() {
  local rest="$CMD" out="" chunk="" ch="" closer="" inside="" fill="xxxxxxxxxxxxxxxx" pending="" word="" strip="" bare="" tab=$'\t'
  while (( ${#fill} < ${#CMD} )); do fill="${fill}${fill}"; done
  if (( ${#CMD} > GIT_C4_MASK_MAX )); then GIT_C4_MASK="${fill:0:${#CMD}}"; return 0; fi
  while [[ -n "$rest" ]]; do
    chunk="${rest%%$GIT_C4_SPECIAL*}"
    out="${out}${chunk}"
    rest="${rest:${#chunk}}"
    if [[ -z "$rest" ]]; then break; fi
    ch="${rest:0:1}"
    closer=""
    case "$ch" in
      "$GIT_C4_BS")
        # `\x`: el carácter escapado no abre ni cierra ni separa nada.
        if (( ${#rest} > 1 )); then out="${out}${GIT_C4_BS}x"; else out="${out}${GIT_C4_BS}"; fi
        rest="${rest:2}"
        ;;
      "$GIT_C4_SQ")
        # Comillas simples: hasta la próxima, sin escapes.
        rest="${rest:1}"
        chunk="${rest%%${GIT_C4_SQ}*}"
        if [[ "$chunk" == "$rest" ]]; then
          out="${out}${GIT_C4_SQ}${fill:0:${#rest}}"
          rest=""
        else
          out="${out}${GIT_C4_SQ}${fill:0:${#chunk}}${GIT_C4_SQ}"
          rest="${rest:$(( ${#chunk} + 1 ))}"
        fi
        ;;
      "$GIT_C4_DQ")
        closer="$GIT_C4_DQ"
        inside="$GIT_C4_IN_DQ"
        out="${out}${GIT_C4_DQ}"
        rest="${rest:1}"
        ;;
      '$')
        # `$'…'`: ahí adentro `\'` NO cierra. Cualquier otro `$` queda como está.
        if [[ "${rest:1:1}" == "$GIT_C4_SQ" ]]; then
          closer="$GIT_C4_SQ"
          inside="$GIT_C4_IN_ANSI"
          out="${out}\$${GIT_C4_SQ}"
          rest="${rest:2}"
        else
          out="${out}\$"
          rest="${rest:1}"
        fi
        ;;
      '#')
        # Un comentario: el `#` que arranca una palabra, hasta el fin del renglón. (`a#b`, `$#`, `${#x}` no lo son.)
        bare=""
        if [[ -n "$out" ]]; then bare="${out:$(( ${#out} - 1 )):1}"; fi
        if [[ -z "$bare" || "$bare" == [[:space:]\;\&\|\(\)] ]]; then
          chunk="${rest%%${GIT_C4_NL}*}"
          out="${out}${fill:0:${#chunk}}"
          rest="${rest:${#chunk}}"
        else
          out="${out}#"
          rest="${rest:1}"
        fi
        ;;
      '<')
        # Un heredoc (`<<`, no el `<<<` de una cadena): se anota su palabra de cierre; el cuerpo arranca
        # en el renglón siguiente.
        if [[ "$rest" == '<<<'* ]]; then
          out="${out}<<<"
          rest="${rest:3}"
        elif [[ "$rest" == '<<'* ]]; then
          out="${out}<<"
          rest="${rest:2}"
          strip=0
          if [[ "$rest" == -* ]]; then strip=1; out="${out}-"; rest="${rest:1}"; fi
          while [[ "$rest" == [[:blank:]]* ]]; do out="${out}${rest:0:1}"; rest="${rest:1}"; done
          if [[ "$rest" =~ $GIT_C4_HEREDOC_TAG ]]; then
            pending="${pending}${strip}${BASH_REMATCH[1]}${GIT_C4_NL}"
            out="${out}${fill:0:${#BASH_REMATCH[0]}}"
            rest="${rest:${#BASH_REMATCH[0]}}"
          else
            out="${out}${fill:0:${#rest}}"
            rest=""
          fi
        else
          out="${out}<"
          rest="${rest:1}"
        fi
        ;;
      "$GIT_C4_NL")
        # Fin de renglón: si hay heredocs anotados, lo que sigue es su cuerpo, hasta el renglón que es
        # sólo la palabra de cierre (con `<<-`, sin sus tabulaciones de adelante).
        out="${out}${GIT_C4_NL}"
        rest="${rest:1}"
        while [[ -n "$pending" && -n "$rest" ]]; do
          word="${pending%%${GIT_C4_NL}*}"
          pending="${pending#*${GIT_C4_NL}}"
          strip="${word:0:1}"
          word="${word:1}"
          while [[ -n "$rest" ]]; do
            chunk="${rest%%${GIT_C4_NL}*}"
            bare="$chunk"
            if [[ "$strip" == "1" ]]; then
              while [[ "$bare" == "$tab"* ]]; do bare="${bare:1}"; done
            fi
            out="${out}${fill:0:${#chunk}}"
            rest="${rest:${#chunk}}"
            if [[ -n "$rest" ]]; then out="${out}${GIT_C4_NL}"; rest="${rest:1}"; fi
            if [[ "$bare" == "$word" ]]; then break; fi
          done
        done
        ;;
      *)
        out="${out}${ch}"
        rest="${rest:1}"
        ;;
    esac
    # El cuerpo de unas comillas dobles o de un `$'…'`: hasta la comilla que cierra; `\x` no cierra.
    while [[ -n "$closer" ]]; do
      chunk="${rest%%$inside*}"
      out="${out}${fill:0:${#chunk}}"
      rest="${rest:${#chunk}}"
      if [[ -z "$rest" ]]; then break; fi
      if [[ "${rest:0:1}" == "$closer" ]]; then
        out="${out}${closer}"
        rest="${rest:1}"
        break
      fi
      if (( ${#rest} > 1 )); then out="${out}xx"; else out="${out}x"; fi
      rest="${rest:2}"
    done
  done
  # Si algo salió mal y las dos copias no miden lo mismo, no se confía en ninguna posición: se tapa todo.
  if (( ${#out} != ${#CMD} )); then out="${fill:0:${#CMD}}"; fi
  GIT_C4_MASK="$out"
  return 0
}

# git_c4_is_tree <carpeta> — sale 0 si ES (mismo dispositivo e inodo) la raíz de un árbol frenado:
# $SKILLS_TREE o ~/.claude/agent-skills. Con una carpeta que no existe, `-ef` da falso.
git_c4_is_tree() {
  if [[ -n "$SKILLS_TREE" && "$1" -ef "$SKILLS_TREE" ]]; then return 0; fi
  if [[ "$1" -ef "${HOME}/.claude/agent-skills" ]]; then return 0; fi
  return 1
}

# git_c4_in_tree <carpeta> — sale 0 si esa carpeta cae en un árbol frenado: la ruta dice
# `/.claude/agent-skills` (tal cual o ya resuelta), o ella o alguna de sus carpetas madre ES la raíz de
# uno (git_c4_is_tree). De una carpeta que no existe se mira la carpeta madre más honda que sí exista:
# no es un error, el `cd` del comando va a fallar solo.
git_c4_in_tree() {
  local dir="$1" up="" real="" walk="" steps=0
  if [[ -z "$dir" ]]; then return 1; fi
  if [[ "$dir" == *"/.claude/agent-skills"* ]]; then return 0; fi
  # Sólo se resuelve una ruta absoluta: con una relativa, `cd` podría irse por CDPATH a otra carpeta.
  case "$dir" in
    /*|[A-Za-z]:*) ;;
    *) return 1 ;;
  esac
  up="$dir"
  while [[ ! -d "$up" && "$up" == */* ]]; do up="${up%/*}"; done
  if [[ -z "$up" ]]; then up="/"; fi
  if [[ ! -d "$up" ]]; then return 1; fi
  # Como la lee `cd` (los `..` se resuelven por el texto, antes de seguir enlaces): la ruta física de
  # donde queda el shell, y sus carpetas madre recortando el texto.
  real="$(cd "$up" 2>/dev/null && pwd -P)" || real=""
  if [[ "$real" == *"/.claude/agent-skills"* ]]; then return 0; fi
  walk="$real"
  while [[ -n "$walk" ]]; do
    if git_c4_is_tree "$walk"; then return 0; fi
    if [[ "$walk" != */* ]]; then break; fi
    walk="${walk%/*}"
  done
  # Como la lee `git -C` (el sistema resuelve los `..` después de seguir enlaces): sólo difiere de la
  # anterior si la ruta trae un `..` detrás de un enlace. Las carpetas madre se piden con `/..`.
  if [[ -z "$real" || ! "$real" -ef "$up" ]]; then
    walk="$up"
    while (( steps < GIT_C4_MAX )); do
      if git_c4_is_tree "$walk"; then return 0; fi
      if [[ ! -d "${walk}/.." || "${walk}/.." -ef "$walk" ]]; then break; fi
      walk="${walk}/.."
      steps=$((steps + 1))
    done
  fi
  return 1
}

# git_c4_holds_tree <carpeta> — sale 0 si un árbol frenado está ADENTRO de esa carpeta (o es ella): se
# sube desde la raíz de cada árbol probando `-ef`. Una carpeta que no existe no tiene nada adentro.
git_c4_holds_tree() {
  local root="" walk="" steps=0
  for root in "$SKILLS_TREE" "${HOME}/.claude/agent-skills"; do
    if [[ -z "$root" || ! -d "$root" ]]; then continue; fi
    walk="$root"
    steps=0
    while (( steps < GIT_C4_MAX )); do
      if [[ "$walk" -ef "$1" ]]; then return 0; fi
      if [[ ! -d "${walk}/.." || "${walk}/.." -ef "$walk" ]]; then break; fi
      walk="${walk}/.."
      steps=$((steps + 1))
    done
  done
  return 1
}

# git_c4_expand <el comando HASTA la palabra> — reemplaza en GIT_C4_DIR cada `$NOMBRE` / `${NOMBRE}` por
# su valor: HOME, por la carpeta de la persona; cualquier otra, por lo que el MISMO comando le asigna antes
# (`S=<ruta>; cd $S/<clon>`: es la forma en que el equipo escribe casi todos estos comandos). Deja
# GIT_C4_KNOWN=0 si no se puede saber qué vale: no hay asignación a la vista, o hay MÁS de una (el freno
# no ejecuta el comando y no sabe cuál rige; se usa la última para mirar si cae en el árbol, pero no
# prueba nada: GIT_C4_AMBIGUOUS=1). Lo mismo si la asignación está sólo ESCRITA —entre comillas, en un
# comentario, en el cuerpo de un heredoc (`echo "S=<otro>"; cd $S`)—: en la copia enmascarada no está a la
# vista. Sólo expresiones de bash: ni `eval`, ni el valor que tenga la variable en este proceso.
git_c4_expand() {
  local before="$1" ref="" name="" rest="" value="" count=0 rounds=0 set_re="" open='{' close='}' at=0
  local ref_re='[$]([{][A-Za-z_][A-Za-z0-9_]*[}]|[A-Za-z_][A-Za-z0-9_]*)'
  while (( rounds < 12 )) && [[ "$GIT_C4_DIR" =~ $ref_re ]]; do
    rounds=$((rounds + 1))
    ref="${BASH_REMATCH[0]}"
    name="${BASH_REMATCH[1]}"
    name="${name#"$open"}"
    name="${name%"$close"}"
    if [[ "$name" == "HOME" ]]; then
      value="$HOME"
    else
      set_re="(^|[[:space:];&|(])${name}="
      rest="$before"
      count=0
      value=""
      while [[ "$rest" =~ $set_re ]]; do
        rest="${rest#*"${BASH_REMATCH[0]}"}"
        count=$((count + 1))
        # Dónde quedó ese `NOMBRE=` en el comando, y si en la copia enmascarada sigue a la vista.
        at=$(( ${#before} - ${#rest} - ${#name} - 1 ))
        if [[ "${GIT_C4_MASK:at:$(( ${#name} + 1 ))}" != "${name}=" ]]; then GIT_C4_KNOWN=0; GIT_C4_AMBIGUOUS=1; fi
        if [[ "$rest" =~ ^$GIT_C4_WORD ]]; then value="${BASH_REMATCH[0]}"; else value=""; fi
      done
      if (( count == 0 )); then GIT_C4_KNOWN=0; return 0; fi
      if (( count > 1 )); then GIT_C4_KNOWN=0; GIT_C4_AMBIGUOUS=1; fi
      value="${value//${GIT_C4_DQ}/}"
      value="${value//${GIT_C4_SQ}/}"
      value="${value//\\ / }"
      case "$value" in "~"|"~/"*) value="${HOME}${value:1}" ;; esac
    fi
    GIT_C4_DIR="${GIT_C4_DIR%%"$ref"*}${value}${GIT_C4_DIR#*"$ref"}"
  done
  return 0
}

# git_c4_made_before <ruta absoluta que no existe> — sale 0 si el propio comando la crea antes de entrar
# (`mkdir -p <dir> && cd <dir>`, `git clone … <dir>; cd <dir>`): antes del `cd` hay un comando de los que
# crean carpetas (mkdir, git clone / init / worktree, cp, mv, rsync, tar, unzip) y en ese mismo comando
# aparece la palabra del `cd`, o una ruta que termina en el nombre de la primera carpeta que falta. Es lo
# único que distingue «todavía no existe» de «ya no existe»: un `cd` a un clon descartable que se borró
# falla, y si el comando sigue con `;` el `git add` corre donde estaba el shell. Nombrarla en otro lado
# (`S=<ruta>; git -C $S/<clon> status; cd $S/<clon>`) no la crea. Y el comando que crea tiene que estar a
# la vista en la copia enmascarada: un `mkdir` escrito dentro de un `echo "…"` no crea nada. Los cortes
# entre comandos y la palabra `mkdir` se leen de la copia enmascarada; la ruta, del comando crudo (puede
# ir entre comillas: `mkdir -p "$D"`).
git_c4_made_before() {
  local missing="$1" rest="${GIT_C4_MASK:0:GIT_C4_AT}" seen="" part="" at=0 name="" needle="" newline=$'\n'
  local maker_re='(^|[[:blank:]])(mkdir|clone|init|worktree|cp|mv|rsync|tar|unzip)[[:blank:]]'
  while [[ "$missing" == */*/* && ! -d "${missing%/*}" ]]; do missing="${missing%/*}"; done
  name="${missing##*/}"
  if [[ -n "$name" ]]; then name="/${name}"; fi
  # De a un comando por vuelta: el texto se corta en cada `;`, `&`, `|` o salto de línea.
  while [[ -n "$rest" ]]; do
    seen="${rest%%[;&|${newline}]*}"
    part="${CMD:at:${#seen}}"
    at=$(( at + ${#seen} + 1 ))
    if [[ "$seen" == "$rest" ]]; then rest=""; else rest="${rest:$(( ${#seen} + 1 ))}"; fi
    if [[ ! "$seen" =~ $maker_re ]]; then continue; fi
    part="${part//${GIT_C4_DQ}/}"
    part="${part//${GIT_C4_SQ}/}"
    for needle in "$GIT_C4_RAW" "$name"; do
      if [[ -z "$needle" ]]; then continue; fi
      case "$part" in
        *"$needle"|*"$needle"[!A-Za-z0-9_.-]*) return 0 ;;
      esac
    done
  done
  return 1
}

# git_c4_try <candidata> <1 si es una ruta absoluta escrita en el comando> <1 si sirve de prueba de que el
# comando se va a otra carpeta> — mira UNA carpeta candidata de la que el recorrido acaba de sacar del
# comando. Deja SKILLS_TREE_HIT=1 si cae en un árbol frenado. Si no cae y existe, la guarda como base
# para las relativas que vengan después (sin repetir: dos textos de la misma carpeta son una) y, si
# sirve de prueba, deja GIT_C4_RESOLVED=1. Una que NO existe no prueba nada, salvo que sea una ruta
# absoluta que el propio comando crea antes (git_c4_made_before); y sólo frena si es absoluta y su
# carpeta madre más honda que existe cae en el árbol.
git_c4_try() {
  local cand="$1" kind="git" i=0
  if [[ "$SKILLS_TREE_HIT" == "1" || "$GIT_C4_OVERFLOW" == "1" ]]; then return 0; fi
  if [[ "$cand" == *"/.claude/agent-skills"* ]]; then SKILLS_TREE_HIT=1; return 0; fi
  if [[ ! -d "$cand" && "$2" != "1" ]]; then return 0; fi
  # El otro tope: cuántas candidatas se resuelven en total (cada una cuesta un proceso).
  GIT_C4_TRIES=$((GIT_C4_TRIES + 1))
  if (( GIT_C4_TRIES > GIT_C4_MAX_TRIES )); then GIT_C4_OVERFLOW=1; return 0; fi
  if [[ ! -d "$cand" ]]; then
    if git_c4_in_tree "$cand"; then SKILLS_TREE_HIT=1; elif git_c4_made_before "$cand"; then GIT_C4_RESOLVED=1; fi
    return 0
  fi
  if git_c4_in_tree "$cand"; then SKILLS_TREE_HIT=1; return 0; fi
  # Sólo lo que MUEVE al shell (un `cd`/`pushd` que corre, apoyado en el `cwd` o en otro `cd`) sirve
  # después de base a un `cd` relativo como prueba; la carpeta de un `-C` vale para su comando y nada más.
  if [[ "$3" == "1" ]]; then
    GIT_C4_RESOLVED=1
    if [[ "$GIT_C4_KIND" == "cd" && "$GIT_C4_RUNS" == "1" ]]; then kind="cd"; fi
  fi
  while (( i < GIT_C4_COUNT )); do
    if [[ "${GIT_C4_CAND[i]}" -ef "$cand" ]]; then
      if [[ "$kind" == "cd" ]]; then GIT_C4_CAND_KIND[i]="cd"; fi
      return 0
    fi
    i=$((i + 1))
  done
  if (( GIT_C4_COUNT >= GIT_C4_MAX )); then GIT_C4_OVERFLOW=1; return 0; fi
  GIT_C4_CAND[GIT_C4_COUNT]="$cand"
  GIT_C4_CAND_KIND[GIT_C4_COUNT]="$kind"
  GIT_C4_COUNT=$((GIT_C4_COUNT + 1))
  return 0
}

# git_c4_blind_notice <código con el que termina el guion> — el aviso del punto 2. Una sola línea: la
# herramienta le muestra a la persona la primera de stderr. Si el guion ya termina frenando (2), no toca nada.
git_c4_blind_notice() {
  if [[ "$1" != "0" ]]; then return 0; fi
  echo "⚠️ TYCON safety-guard [GIT-C4] NO PUDO MIRAR el árbol de las skills instaladas y dejó pasar este git add masivo sin saber si cae ahí: ${GIT_C4_BLIND}. Si cae en ese árbol, va a stagear todo lo ajeno que vive ahí: mirá git status antes de commitear. Arreglo: que ~/.claude/skills vuelva a apuntar a una carpeta que exista y se pueda leer." >&2
  exit 1
}

# ── PowerShell: las carpetas como las escribe Windows ─────────────────────────────────
# Por la herramienta PowerShell, `cd ~\.claude\agent-skills; git add -A`, `cd $env:USERPROFILE\…`,
# `Set-Location …`, `sl …`, `Push-Location …` y `git -C ~\… add -A` pasarían sin esto: el recorrido de abajo lee la
# barra invertida como un escape de bash y sólo conoce `cd`, `pushd` y `-C`. Para esa herramienta GIT-C4 mira una
# copia del comando con las barras hacia adelante (en PowerShell la `\` no escapa nada: el escape es el acento
# grave), `$env:USERPROFILE`/`$env:HOME` (también entre llaves) como `$HOME`, y Set-Location / sl / chdir como `cd`
# y Push-Location como `pushd` (sin su `-Path`/`-LiteralPath`). Sin distinguir mayúsculas, como PowerShell.
# El comando que se muestra y se anota sigue siendo el original (CMD_SHOWN); al salir del bloque CMD vuelve.
# Sólo se lee de qué herramienta viene si el comando tiene un `add`: leerlo cuesta un proceso.
# _ps_ireplace <texto> <regex> <cd|pushd|home> → el texto con cada coincidencia reemplazada (lo de delante de la
# palabra, BASH_REMATCH[1], queda). Pura expansión de parámetros.
_ps_ireplace() {
  local rest="$1" out="" m pre rep
  shopt -s nocasematch
  while [[ -n "$rest" && "$rest" =~ $2 ]]; do
    m="${BASH_REMATCH[0]}"
    if [[ "$3" == "home" ]]; then rep='$HOME'; else rep="${BASH_REMATCH[1]}$3 "; fi
    pre="${rest%%"$m"*}"
    out="${out}${pre}${rep}"
    rest="${rest:$(( ${#pre} + ${#m} ))}"
  done
  shopt -u nocasematch
  printf '%s' "${out}${rest}"
}
if [[ "$CMD" =~ (^|[^A-Za-z0-9_-])add[[:space:]] ]] && tool_is_ps; then
  _PS_GC4="${CMD//\\//}"
  _PS_GC4="$(_ps_ireplace "$_PS_GC4" '\$\{env:(userprofile|home)\}|\$env:(userprofile|home)' home)"
  _PS_GC4="$(_ps_ireplace "$_PS_GC4" '(^|[^a-z0-9_.-])(set-location|sl|chdir)([[:blank:]]+-(literal)?path)?[[:blank:]]+' cd)"
  _PS_GC4="$(_ps_ireplace "$_PS_GC4" '(^|[^a-z0-9_.-])(push-location)([[:blank:]]+-(literal)?path)?[[:blank:]]+' pushd)"
  CMD="$_PS_GC4"
fi
if [[ "$CMD" =~ $GIT_C4_SHELL_STRING ]]; then GIT_C4_MASS_ADD="$GIT_C4_MASS_ADD_IN_STRING"; fi
if [[ "$CMD" =~ $GIT_C4_MASS_ADD ]]; then
  # --- 1. Cuál es el árbol de las skills instaladas (si hay) ---
  SKILLS_TREE=""
  SKILLS_PROBE=""
  GIT_C4_BLIND=""
  GIT_C4_SKILLS="${HOME}/.claude/skills"
  GIT_C4_ENTRY="${GIT_C4_SKILLS}/tycon-pipeline"
  # Lo que no existe no es un error del freno: es «no hay árbol», y se calla. Lo que EXISTE y no se
  # puede resolver es «no pude mirar», y se dice (GIT_C4_BLIND). El `2>/dev/null` de cada `cd` no
  # tapa nada: el fallo se lee por su código de salida, y el texto de `cd` le ganaría la primera
  # línea de stderr al aviso.
  # El árbol es la carpeta madre de `skills` (o de `skills/tycon-pipeline`). Que la sonda termine en esos
  # nombres se prueba por identidad (`-ef`), no por texto: el enlace pudo quedar escrito `…/SKILLS`.
  if [[ -d "$GIT_C4_ENTRY" ]] && SKILLS_PROBE="$(cd "$GIT_C4_ENTRY" 2>/dev/null && pwd -P)"; then
    if [[ "$SKILLS_PROBE" == */*/* && "${SKILLS_PROBE%/*/*}/skills/tycon-pipeline" -ef "$SKILLS_PROBE" ]]; then SKILLS_TREE="${SKILLS_PROBE%/*/*}"; fi
  elif [[ -L "$GIT_C4_SKILLS" ]] && SKILLS_PROBE="$(cd "$GIT_C4_SKILLS" 2>/dev/null && pwd -P)"; then
    if [[ "$SKILLS_PROBE" == */* && "${SKILLS_PROBE%/*}/skills" -ef "$SKILLS_PROBE" ]]; then SKILLS_TREE="${SKILLS_PROBE%/*}"; fi
  elif [[ -L "$GIT_C4_SKILLS" && ! -d "$GIT_C4_SKILLS" ]]; then
    GIT_C4_BLIND="~/.claude/skills es un enlace que no lleva a ninguna carpeta (¿el clon se movió o se borró?)"
  elif [[ -d "$GIT_C4_SKILLS" ]] && ! ( cd "$GIT_C4_SKILLS" ) 2>/dev/null; then
    GIT_C4_BLIND="no se puede entrar a ~/.claude/skills (permisos)"
  elif [[ -L "$GIT_C4_ENTRY" && ! -d "$GIT_C4_ENTRY" ]]; then
    GIT_C4_BLIND="~/.claude/skills/tycon-pipeline es un enlace que no lleva a ninguna carpeta (¿el clon se movió o se borró?)"
  elif [[ -d "$GIT_C4_ENTRY" ]]; then
    GIT_C4_BLIND="no se puede entrar a ~/.claude/skills/tycon-pipeline (permisos)"
  elif [[ -d "${HOME}/.claude" ]] && ! ( cd "${HOME}/.claude" ) 2>/dev/null; then
    GIT_C4_BLIND="no se puede entrar a ~/.claude (permisos)"
  fi
  # Tiene que ser un clon (trae .git) y no ~/.claude mismo: si no, no hay «árbol».
  if [[ -n "$SKILLS_TREE" ]] && [[ ! -e "${SKILLS_TREE}/.git" || "$SKILLS_TREE" -ef "${HOME}/.claude" ]]; then SKILLS_TREE=""; fi

  # --- 2. Cada carpeta que el propio comando nombra, de izquierda a derecha (punto b de arriba) ---
  # Las carpetas se sacan del comando CRUDO (para frenar: de más, nunca de menos). Si cada una prueba que
  # el comando se va, se decide con la copia enmascarada (punto f): ahí lo que está entre comillas, en un
  # comentario o en el cuerpo de un heredoc ya no está a la vista.
  git_c4_mask
  SKILLS_TREE_HIT=0
  GIT_C4_OVERFLOW=0
  GIT_C4_TRIES=0
  GIT_C4_COUNT=0   # candidatas que existen y no caen en el árbol: GIT_C4_CAND[] y, en paralelo, GIT_C4_CAND_KIND[]
  GIT_C4_NAVS=0    # carpetas nombradas que se pudieron leer y no caen en el árbol: GIT_C4_NAV_AT[] (dónde
                   # empiezan en el comando) y GIT_C4_NAV_KIND[] (`cd`: mueve al shell; `git`: un `-C`)
  GIT_C4_REST="$CMD"
  while [[ "$SKILLS_TREE_HIT" == "0" && "$GIT_C4_OVERFLOW" == "0" && "$GIT_C4_REST" =~ $GIT_C4_NAV ]]; do
    GIT_C4_MATCH="${BASH_REMATCH[0]}"
    GIT_C4_KIND="cd"
    case "$GIT_C4_MATCH" in *-C*) GIT_C4_KIND="git" ;; esac
    GIT_C4_PRE="${GIT_C4_REST%%"$GIT_C4_MATCH"*}"
    GIT_C4_AT=$(( ${#CMD} - ${#GIT_C4_REST} + ${#GIT_C4_PRE} ))
    GIT_C4_REST="${GIT_C4_REST#*"$GIT_C4_MATCH"}"
    # ¿Este `cd` / este `-C` corre de verdad? Sólo si en la copia enmascarada sigue a la vista (no está
    # entre comillas, ni en un comentario, ni en el cuerpo de un heredoc) y, si es un `cd`, además arranca
    # un comando: lo que tiene delante —leído también de la copia enmascarada, donde un `;` entre comillas
    # ya no es un separador— termina en un separador o en una palabra que abre un bloque. Si no, se mira
    # igual adónde apunta (por si es el árbol), pero no prueba que el comando se vaya (GIT_C4_RUNS=0).
    GIT_C4_RUNS=1
    if [[ "$GIT_C4_KIND" == "cd" ]]; then
      GIT_C4_LEAD="${GIT_C4_MATCH%%[cp]*}"
      GIT_C4_KEY_AT=$(( GIT_C4_AT + ${#GIT_C4_LEAD} ))
      GIT_C4_LEAD="${GIT_C4_MASK:0:GIT_C4_KEY_AT}"
      if [[ "${GIT_C4_MASK:GIT_C4_KEY_AT:2}" != "cd" && "${GIT_C4_MASK:GIT_C4_KEY_AT:5}" != "pushd" ]]; then GIT_C4_RUNS=0; fi
      if [[ ! "$GIT_C4_LEAD" =~ $GIT_C4_STARTS && ! "$GIT_C4_LEAD" =~ $GIT_C4_STARTS_WORD ]]; then GIT_C4_RUNS=0; fi
      if [[ "$GIT_C4_LEAD" =~ $GIT_C4_SUBST ]]; then GIT_C4_RUNS=0; fi
      # Las opciones de `cd` (`-P`, `-L`, `--`) no son la carpeta: se saltean. Un `-` solo no es una opción.
      while [[ "$GIT_C4_REST" =~ ^-[-A-Za-z@]+[[:blank:]]+ ]]; do GIT_C4_REST="${GIT_C4_REST#"${BASH_REMATCH[0]}"}"; done
    else
      GIT_C4_LEAD="${GIT_C4_MATCH%%-C*}"
      GIT_C4_KEY_AT=$(( GIT_C4_AT + ${#GIT_C4_LEAD} ))
      if [[ "${GIT_C4_MASK:GIT_C4_KEY_AT:2}" != "-C" ]]; then GIT_C4_RUNS=0; fi
    fi
    if [[ ! "$GIT_C4_REST" =~ ^$GIT_C4_WORD ]]; then continue; fi
    GIT_C4_DIR="${BASH_REMATCH[0]}"
    # La palabra, como la va a leer el shell: sin comillas, `\ ` como espacio, `~` al principio como la
    # carpeta de la persona, y las variables por su valor (git_c4_expand). (Entre comillas simples el
    # shell NO expande `$HOME`: acá se expande igual. Es un freno: prefiere mirar una carpeta de más.)
    GIT_C4_DIR="${GIT_C4_DIR//${GIT_C4_DQ}/}"
    GIT_C4_DIR="${GIT_C4_DIR//${GIT_C4_SQ}/}"
    GIT_C4_DIR="${GIT_C4_DIR//\\ / }"
    GIT_C4_RAW="$GIT_C4_DIR"
    case "$GIT_C4_DIR" in "~"|"~/"*) GIT_C4_DIR="${HOME}${GIT_C4_DIR:1}" ;; esac
    GIT_C4_KNOWN=1
    GIT_C4_AMBIGUOUS=0
    git_c4_expand "${CMD:0:GIT_C4_AT}"
    # `cd -` vuelve a la carpeta anterior sin nombrarla, y `cd ""` no va a ningún lado: no nombran nada.
    if [[ -z "$GIT_C4_DIR" || "$GIT_C4_DIR" == "-" ]]; then continue; fi
    # ¿Se puede leer adónde va? Si quedó una variable sin valor a la vista, una sustitución o un comodín,
    # no: sus candidatas se miran igual (por si caen en el árbol), pero no prueban que el comando se vaya.
    case "$GIT_C4_DIR" in *'$'*|*"${GIT_C4_BT}"*|*'*'*|*'?'*|*'['*) GIT_C4_KNOWN=0 ;; esac
    # Salvo que alcance con su carpeta madre: de una ruta absoluta con un final que no se lee
    # (`<ruta>/foto-$r`, en un lazo sobre varios clones) se sabe que queda ADENTRO de la última carpeta
    # escrita entera. Si ésa existe y no está en el árbol ni tiene al árbol adentro, el comando se va a
    # otro lado, valga lo que valga lo que falta. No vale si el comando trae un `..` en cualquier parte (lo
    # que no se lee podría salir de esa carpeta) ni si la ruta se armó con una variable asignada más de una vez.
    GIT_C4_HEAD_PROOF=0
    GIT_C4_SLASHED="$GIT_C4_DIR"
    case "$GIT_C4_SLASHED" in [A-Za-z]:*) GIT_C4_SLASHED="${GIT_C4_SLASHED//\\//}" ;; esac
    if [[ "$GIT_C4_KNOWN" == "0" && "$GIT_C4_AMBIGUOUS" == "0" && "$CMD" != *..* && "$GIT_C4_SLASHED" =~ $GIT_C4_KNOWN_HEAD ]]; then
      GIT_C4_HEAD="${BASH_REMATCH[0]%/}"
      if [[ -d "$GIT_C4_HEAD" ]] && ! git_c4_in_tree "$GIT_C4_HEAD" && ! git_c4_holds_tree "$GIT_C4_HEAD"; then GIT_C4_HEAD_PROOF=1; fi
    fi
    GIT_C4_RESOLVED=0
    GIT_C4_BEFORE="$GIT_C4_COUNT"
    case "$GIT_C4_DIR" in
      # Absoluta (también `C:/…` y `C:\…`: corre en Windows por Git Bash): vale tal cual.
      /*) git_c4_try "$GIT_C4_DIR" 1 1 ;;
      [A-Za-z]:*) git_c4_try "${GIT_C4_DIR//\\//}" 1 1 ;;
      # Relativa: contra el `cwd` del hook y contra CADA carpeta nombrada antes (`cd a && cd b` entra en
      # a/b; `(cd a); cd b`, en b; `git -C a -C b`, en a/b).
      *)
        if [[ -n "$CWD" ]]; then git_c4_try "${CWD}/${GIT_C4_DIR}" 0 1; fi
        GIT_C4_I=0
        while (( GIT_C4_I < GIT_C4_BEFORE )); do
          GIT_C4_PROOF=1
          if [[ "$GIT_C4_KIND" == "cd" && "${GIT_C4_CAND_KIND[GIT_C4_I]}" != "cd" ]]; then GIT_C4_PROOF=0; fi
          git_c4_try "${GIT_C4_CAND[GIT_C4_I]}/${GIT_C4_DIR}" 0 "$GIT_C4_PROOF"
          GIT_C4_I=$((GIT_C4_I + 1))
        done
        ;;
    esac
    if [[ "$GIT_C4_KNOWN" == "1" && "$GIT_C4_RESOLVED" == "1" ]]; then GIT_C4_HEAD_PROOF=1; fi
    if [[ "$SKILLS_TREE_HIT" == "0" && "$GIT_C4_HEAD_PROOF" == "1" && "$GIT_C4_RUNS" == "1" ]]; then
      GIT_C4_NAV_AT[GIT_C4_NAVS]="$GIT_C4_AT"
      GIT_C4_NAV_KIND[GIT_C4_NAVS]="$GIT_C4_KIND"
      GIT_C4_NAVS=$((GIT_C4_NAVS + 1))
    fi
  done

  # --- 3. El `cwd` del hook: cuenta si algún `git add` masivo corre «donde está» (punto c de arriba) ---
  if [[ "$SKILLS_TREE_HIT" == "0" && "$GIT_C4_OVERFLOW" == "0" ]]; then
    GIT_C4_CWD_COUNTS=0
    GIT_C4_REST="$CMD"
    while [[ "$GIT_C4_CWD_COUNTS" == "0" && "$GIT_C4_REST" =~ $GIT_C4_MASS_ADD ]]; do
      GIT_C4_MATCH="${BASH_REMATCH[0]}"
      GIT_C4_PRE="${GIT_C4_REST%%"$GIT_C4_MATCH"*}"
      GIT_C4_AT=$(( ${#CMD} - ${#GIT_C4_REST} + ${#GIT_C4_PRE} ))
      GIT_C4_END=$(( GIT_C4_AT + ${#GIT_C4_MATCH} ))
      GIT_C4_REST="${GIT_C4_REST#*"$GIT_C4_MATCH"}"
      # ¿Este `git add` se va a otra carpeta? Sí, si lleva un `-C` propio o si ANTES de él hay un `cd`/`pushd`.
      GIT_C4_MOVED=0
      GIT_C4_I=0
      while (( GIT_C4_I < GIT_C4_NAVS )); do
        if [[ "${GIT_C4_NAV_KIND[GIT_C4_I]}" == "cd" ]]; then
          if (( ${GIT_C4_NAV_AT[GIT_C4_I]} < GIT_C4_AT )); then GIT_C4_MOVED=1; fi
        elif (( ${GIT_C4_NAV_AT[GIT_C4_I]} >= GIT_C4_AT && ${GIT_C4_NAV_AT[GIT_C4_I]} < GIT_C4_END )); then
          GIT_C4_MOVED=1
        fi
        GIT_C4_I=$((GIT_C4_I + 1))
      done
      if [[ "$GIT_C4_MOVED" == "0" ]]; then GIT_C4_CWD_COUNTS=1; fi
    done
    if [[ "$GIT_C4_CWD_COUNTS" == "1" ]] && git_c4_in_tree "$CWD"; then SKILLS_TREE_HIT=1; fi
  fi

  if [[ "$SKILLS_TREE_HIT" == "1" ]]; then
    block "GIT-C4"     "git add -A / git add . en el árbol del que salen las skills instaladas (~/.claude/agent-skills, o el clon al que resuelve ~/.claude/skills) stagea todo lo ajeno que vive ahí: el drift bmad-* completo (~100 archivos M que NUNCA se commitean). Cuenta cada carpeta que el propio comando nombra con cd, pushd o -C y, si el comando no se va a otra carpeta antes del git add, la carpeta donde corre."     "Staging selectivo: git add skills/tycon-pipeline skills/<tu-skill> agents/tycon-*.md — solo lo propio. Ver guides/git-commit-conventions.md."
  fi
  if [[ "$GIT_C4_OVERFLOW" == "1" ]]; then
    block "GIT-C4"     "Este comando trae un git add -A / git add . y nombra más de ${GIT_C4_MAX} carpetas distintas con cd, pushd o -C (o tantas, encadenadas, que dan más de ${GIT_C4_MAX_TRIES} combinaciones): el freno no las puede seguir a todas, y no pudo saber si el git add cae en el árbol del que salen las skills instaladas. Lo que no se pudo mirar no pasa callado."     "Partí el comando en dos, o stageá por nombre (git add <archivo>)."
  fi
  # No frenó, y no pudo mirar el árbol: se dice al terminar el guion (ver el punto 2 de arriba).
  # Con una firma esperando la ventana de permiso no hay nada que avisar: el aviso sale con código 1, que haría correr
  # el comando sin la ventana, y la persona ya mira el comando en ella.
  if [[ -n "$GIT_C4_BLIND" && -z "$OW_ASK_JSON" ]]; then
    trap 'git_c4_blind_notice "$?"' EXIT
  fi
fi
CMD="$CMD_SHOWN"   # las reglas de abajo miran el comando tal como llegó

# --- Supply chain ------------------------------------------------------------

# curl ... | bash | sh — install pattern de scripts no auditados.
if [[ "$CMD" =~ (curl|wget)[[:space:]] ]] && \
   [[ "$CMD" =~ \|[[:space:]]*(bash|sh|zsh)([[:space:]]|$) ]]; then
  block "SUP-C1" \
    "curl|bash o wget|sh ejecuta código remoto sin auditarlo. Vector clásico de supply chain attack." \
    "Bajá el script primero (curl -o /tmp/x.sh URL), inspeccionalo, después corré bash /tmp/x.sh."
fi

# `eval $(curl ...)` — peor variante
if [[ "$CMD" =~ eval[[:space:]]+.*\$\((curl|wget)[[:space:]] ]]; then
  block "SUP-C2" \
    "eval con curl/wget remoto. Ejecuta código no auditado en tu shell actual." \
    "Mismo que SUP-C1: bajalo, inspeccionalo, después ejecutalo."
fi

# …y sus formas de PowerShell. SUP-C1: una descarga (Invoke-WebRequest / Invoke-RestMethod y sus alias,
# o WebClient) entubada a Invoke-Expression (`irm https://x | iex`). SUP-C2: Invoke-Expression sobre una
# descarga (`iex (iwr https://x).Content`, `iex ((New-Object Net.WebClient).DownloadString('…'))`).
# También `curl.exe`/`wget.exe` (en PowerShell `curl` es un alias de Invoke-WebRequest y
# el programa se escribe con su .exe) y la descarga entubada a otro PowerShell (`| powershell -`, `| pwsh`) o
# a bash.
_PS_GET='(invoke-webrequest|iwr|invoke-restmethod|irm|curl(\.exe)?|wget(\.exe)?|downloadstring)'
_PS_IEX='(invoke-expression|iex)'
if ps_match "(^|[^a-z-])${_PS_GET}([[:space:]]|\()" && ps_match "\|[[:space:]]*&?[[:space:]]*(${_PS_IEX}|(powershell|pwsh)(\.exe)?|bash|sh)([[:space:];)]|$)"; then
  block "SUP-C1" \
    "irm | iex (o iwr | Invoke-Expression) ejecuta código remoto sin auditarlo. Vector clásico de supply chain attack." \
    "Bajá el guion primero (Invoke-WebRequest URL -OutFile \$env:TEMP\\x.ps1), inspeccionalo, después corrélo."
fi
# SUP-C2: Invoke-Expression con una descarga en su argumento, escrito como sea: `iex (iwr …)`, `iex $(irm …)`,
# `Invoke-Expression -Command (irm …)`, `iex "& { $(irm …) }"` Hasta el `;` o `|`.
if ps_match "(^|[^a-z-])${_PS_IEX}([[:space:]]|\()[^;|]*(^|[^a-z.-])(invoke-webrequest|iwr|invoke-restmethod|irm|curl|wget|downloadstring|new-object)([^a-z-]|$)"; then
  block "SUP-C2" \
    "Invoke-Expression sobre una descarga. Ejecuta código no auditado en tu sesión actual." \
    "Mismo que SUP-C1: bajalo, inspeccionalo, después ejecutalo."
fi

# --- Publicación accidental --------------------------------------------------

if [[ "$CMD" =~ (^|[[:space:]])npm[[:space:]]+publish([[:space:]]|$) ]]; then
  block "PUB-C1" \
    "npm publish — publicación a registry público. Suele ser accidente cuando se intentaba 'npm pack' o 'npm version'." \
    "Revisá que el paquete no contenga secretos. Si hay que publicar a mano, lo autoriza la persona (abajo)."
fi

if [[ "$CMD" =~ (^|[[:space:]])yarn[[:space:]]+publish([[:space:]]|$) ]]; then
  block "PUB-C2" \
    "yarn publish — publicación a registry público." \
    "Mismo que PUB-C1."
fi

if [[ "$CMD" =~ dotnet[[:space:]]+nuget[[:space:]]+push ]]; then
  block "PUB-C3" \
    "dotnet nuget push — publicación a NuGet feed. Solo CI/release pipeline debería hacer esto." \
    "Confirmá que el .nupkg sea el correcto. Si tiene que ser a mano (raro), lo autoriza la persona (abajo)."
fi

# --- SQL destructivo (sqlcmd / dotnet ef / inline) ---------------------------

# DROP DATABASE — las bases de los clientes (acmebase, acmebase_dev, etc.).
# Drop accidental es catastrófico. SQL no distingue mayúsculas y acepta comentarios entre las dos palabras:
# `drop database`, `Drop Database`, `DROP /* x */ DATABASE` y `drop -- x` + salto + `database` borran igual.
# Esas formas cuentan donde corre SQL (un cliente de base en el comando); en mayúsculas, en cualquier comando, como
# siempre. La prosa en minúscula de un mensaje o de un `grep | head` no borra nada.
# Un buscador de texto solo (`grep -rn "DROP DATABASE" scripts/`), sin tuberías, redirecciones ni sustituciones,
# sólo lee: no se frena.
_sql_c1_re=$'(^|[^[:alnum:]_])drop([[:space:]]|/\\*([^*]|\\*+[^*/])*\\*+/|--[^\n]*\n)+database([^[:alnum:]_]|$)'
_sql_c1_solo_busca() {
  local c="${CMD#"${CMD%%[![:space:]]*}"}"
  [[ "$c" =~ ^(grep|egrep|fgrep|rg|ag|ack|git[[:space:]]+grep)[[:space:]] ]] || return 1
  [[ "$c" == *[\|\;\&\`\<\>]* || "$c" == *'$('* || "$c" == *$'\n'* || "$c" == *--pre* ]] && return 1
  # las opciones con las que el buscador ejecuta otro programa: ahí el texto corre. git y ag aceptan la opción larga
  # abreviada (`--open`, `--pag`) y la corta pegada a otras (`-iO`)
  [[ "$c" == *--pag* || "$c" == *--op* || "$c" == *--ho* || "$c" =~ [[:space:]]-[[:alnum:]]*O ]] && return 1
  return 0
}
_sql_c1_cliente_re='(^|[^[:alnum:]_-])(sqlcmd|osql|isql|psql|mysql|mariadb|sqlite3|bcp|invoke-sqlcmd|mssql-cli|usql|sqlpackage)([^[:alnum:]_-]|$)'
_sql_c1=0
if [[ "$CMD" =~ DROP[[:space:]]+DATABASE ]]; then
  _sql_c1=1
else
  shopt -s nocasematch
  [[ "$CMD" =~ $_sql_c1_cliente_re && "$CMD" =~ $_sql_c1_re ]] && _sql_c1=1
  shopt -u nocasematch
fi
if [ "$_sql_c1" = 1 ] && ! _sql_c1_solo_busca; then
  block "SQL-C1" \
    "DROP DATABASE. Te llevás esquema + datos + historial." \
    "Si hay que recrear la base (típicamente *_DEV), lo autoriza la persona (abajo); después se restaura el backup."
fi

# DROP TABLE — block solo si NO está en un .sql migration file (esos son legítimos).
# Heurística: si el comando incluye 'DROP TABLE' y NO incluye un path .sql, block.
if [[ "$CMD" =~ DROP[[:space:]]+TABLE ]] && [[ ! "$CMD" =~ \.sql ]]; then
  block "SQL-C2" \
    "DROP TABLE inline (no en una migration file). Las modificaciones de schema en TYCON van por migration numerada." \
    "Creá una migration nueva con tycon-new-migration y dropéa la tabla ahí. Si es exploratorio en *_DEV, lo autoriza la persona (abajo)."
fi

# --- El arnés no se apaga a sí mismo -----------------------------------------

# HARNESS-C1: PERSISTIR un kill-switch del
# arnés en el archivo de arranque del shell. Los interruptores TYCON_* son la escotilla del DEV
# —por sesión y a la vista—; escribirlos al rc los vuelve permanentes, invisibles y heredados por
# TODAS las sesiones futuras, incluido TYCON_NO_AUTOINSTALL=1, que apaga al instalador que re-sana
# el resto. Reproducido: `echo 'export TYCON_SAFETY_GUARD=0' >> ~/.zshrc` pasaba sin un solo
# aviso — el mismo patrón de C1 (.tycon/advisors.yaml), un piso más abajo. Editar el rc para
# cualquier otra cosa sigue libre: la regla exige TYCON_ + valor de apagado + el rc como DESTINO
# de una escritura (redirección/tee/sed -i pegados al path), las tres juntas.
#
# 🔴 El rc como DESTINO, no como mención (ajustado a los 10 minutos de nacer): la primera versión
# matcheaba las tres piezas SUELTAS en el texto del comando, y bloqueó la escritura de su PROPIO
# archivo de casos — el JSON trae el comando de ataque como dato. Residual asumido y aceptado: un
# heredoc cuyo contenido incluya el par redirección+rc literal sigue matcheando (raro; para eso
# está el override por comando, que queda auditado en el log).
if [[ "$CMD" =~ (\>|tee[[:space:]]+(-a[[:space:]]+)?|sed[[:space:]]+-i[^\|\;\&]*[[:space:]])[[:space:]]*[\"\']?[^[:space:]\"\']*(\.zshrc|\.bashrc|\.zprofile|\.bash_profile|\.profile|\.zshenv) ]] && \
   [[ "$CMD" =~ TYCON_[A-Z_]+=(\"?\'?)(0|off|OFF)|TYCON_(NO|SAFETY_OFF)[A-Z_]*=(\"?\'?)(1|on) ]]; then
  block "HARNESS-C1" \
    "Persistir un kill-switch TYCON_* en el rc del shell apaga ese control para TODAS las sesiones futuras, sin rastro y sin vencimiento — incluido el instalador que re-sana a los demás." \
    "Si el dev quiere apagar un control: por sesión (TYCON_X=0 <cmd>) o que lo escriba él en su rc a mano. El agente no persiste apagados."
fi
# …y sus formas de Windows, donde el «rc» es la variable de usuario o de máquina y el perfil de PowerShell:
# `setx TYCON_X 0`, `[Environment]::SetEnvironmentVariable('TYCON_X', '0', 'User'|'Machine')` y una
# escritura a `$PROFILE` que pone un apagado. Las tres piezas juntas, como arriba: un TYCON_ con valor de
# apagado y un destino que persiste. `setx` de otra variable, o de un TYCON_ que PRENDE, pasa.
_PS_Q='["'"'"']?'
_PS_OFF="TYCON_[a-z_]+${_PS_Q}[[:space:]]*(,[[:space:]]*)?${_PS_Q}(0|off)${_PS_Q}|TYCON_(no|safety_off)[a-z_]*${_PS_Q}[[:space:]]*(,[[:space:]]*)?${_PS_Q}(1|on)${_PS_Q}"
if ps_match "${_PS_AT}setx[[:space:]]+(${_PS_OFF})([[:space:]]|;|$)" \
   || ps_match "setenvironmentvariable[[:space:]]*\([[:space:]]*${_PS_Q}(${_PS_OFF})[[:space:]]*,[[:space:]]*${_PS_Q}(\[?(system\.)?environmentvariabletarget\]?::)?(user|machine)" \
   || { ps_match "(add-content|set-content|out-file|>)[[:space:]]*(-(file)?path[[:space:]]+)?\\\$profile" \
        && ps_match "\\\$env:TYCON_[a-z_]+[[:space:]]*=[[:space:]]*${_PS_Q}(0|off)|\\\$env:TYCON_(no|safety_off)[a-z_]*[[:space:]]*=[[:space:]]*${_PS_Q}(1|on)"; }; then
  block "HARNESS-C1" \
    "Persistir un kill-switch TYCON_* (setx, SetEnvironmentVariable de usuario o de máquina, o el perfil de PowerShell) apaga ese control para TODAS las sesiones futuras, sin rastro y sin vencimiento — incluido el instalador que re-sana a los demás." \
    "Si el dev quiere apagar un control: por sesión (\$env:TYCON_X=0; <cmd>) o que lo persista él a mano. El agente no persiste apagados."
fi

# HARNESS-C2: sacar un control del arnés de la configuración de la herramienta (`.claude/settings.json` o
# `.claude/settings.local.json`): prender `disableAllHooks`, poner en `env` un interruptor que apaga, sacar un hook del
# arnés, o borrar, mover o reemplazar entera una configuración que los tiene. Lo decide lib/controls-off.js, la misma
# pieza que mira las ediciones (on-controls-off.js), y que sabe cuáles son esas configuraciones. Sólo corre si el
# comando nombra un `settings*.json` (también entrando antes a su carpeta): el resto no paga el proceso.
# Sin el lector no se sabe qué hace el comando, y pasa con su constancia: este freno no puede trabar a quien lee su
# configuración.
shopt -s nocasematch
if [[ "$CMD" == *settings*.json* ]]; then
  shopt -u nocasematch
  _c2_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/skills/tycon-pipeline/scripts/lib/controls-off.js" || _c2_lib=""
  _c2_out=""; _c2_leido=0; _c2_shell=bash; tool_is_ps && _c2_shell=powershell
  if [[ -n "$_c2_lib" && -f "$_c2_lib" ]] && command -v "$HNODE" >/dev/null 2>&1; then
    if _c2_out="$(printf '%s' "$CMD" | "$HNODE" "$_c2_lib" --command-stdin --cwd "$CWD" --shell "$_c2_shell" 2>/dev/null)"; then _c2_leido=1; else _c2_out=""; fi
  fi
  if [[ "$_c2_leido" == "0" ]]; then
    constancia HARNESS-C2 sin-lector
  else
    _c2_motivos=""
    while IFS= read -r _c2_l; do
      [[ "$_c2_l" == frena=* ]] && _c2_motivos+="${_c2_motivos:+; }${_c2_l#frena=}"
    done <<< "$_c2_out"
    if [[ -n "$_c2_motivos" ]]; then
      block "HARNESS-C2" \
        "El comando saca un control del arnés de la configuración de la herramienta: ${_c2_motivos}." \
        "Apagar un control lo decide el dev, y lo hace él a mano: el agente no saca controles. Si el control molesta, decíselo a la persona con el caso. Cualquier otro cambio a la configuración pasa."
    fi
  fi
fi
shopt -u nocasematch

# --- Secret reading ----------------------------------------------------------
# Lectura de secretos vía cat / less. Read tool de Claude es harder to block from Bash
# matcher — eso requiere matcher=Read (v2).
if [[ "$CMD" =~ (^|[[:space:]])(cat|less|more|head|tail)[[:space:]]+.*(\~/\.ssh/|/\.ssh/id_|/\.aws/credentials|/\.aws/config) ]]; then
  block "SEC-C1" \
    "Lectura de secretos (.ssh keys / .aws/credentials). Aunque sea para 'mirar', queda en el contexto de la sesión y puede leakear." \
    "Si necesitás verificar la existencia: ls -la ~/.ssh/. Para el contenido: usá un wrapper que no exponga."
fi

# .env de cualquier proyecto, incluyendo .env.local / .env.production
if [[ "$CMD" =~ (^|[[:space:]])(cat|less|more|head|tail)[[:space:]]+[^[:space:]]*\.env(\.|[[:space:]]|$) ]]; then
  block "SEC-C2" \
    "Lectura de archivo .env. Los .env contienen secrets que no deben quedar en el contexto del LLM." \
    "Si querés saber QUÉ keys define: grep -E '^[A-Z_]+=' .env | cut -d= -f1. Eso solo lista nombres, no valores."
fi

# …y sus formas de PowerShell: Get-Content (o sus alias gc / type, o cat) con las rutas escritas con
# cualquiera de las dos barras.
_PS_READ='(^|[[:space:]])(get-content|gc|type|cat)[[:space:]]+(-(literal)?path[[:space:]]+)?'
if ps_match "${_PS_READ}"'.*((~|\$home|\$env:userprofile)[\\/]\.ssh[\\/]|[\\/]\.ssh[\\/]id_|[\\/]\.aws[\\/](credentials|config))'; then
  block "SEC-C1" \
    "Lectura de secretos (.ssh keys / .aws/credentials). Aunque sea para 'mirar', queda en el contexto de la sesión y puede leakear." \
    "Si necesitás verificar la existencia: Get-ChildItem \$HOME\\.ssh. Para el contenido: usá un wrapper que no exponga."
fi
if ps_match "${_PS_READ}"'[^[:space:]]*\.env(\.|[[:space:]]|$)'; then
  block "SEC-C2" \
    "Lectura de archivo .env. Los .env contienen secrets que no deben quedar en el contexto del LLM." \
    "Si querés saber QUÉ keys define: Select-String '^[A-Z_]+=' .env | ForEach-Object { (\$_.Line -split '=')[0] }. Eso solo lista nombres, no valores."
fi

# ============================================================
# Sin match → permitir (con la ventana de permiso, si una firma la pidió).
# ============================================================
salida_ok
