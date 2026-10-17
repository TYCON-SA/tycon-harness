#!/usr/bin/env bash
# safety-guard-pre.sh — freno de mano del harness TYCON.
#
# Hook PreToolUse matcher=Bash|PowerShell. Intercepta comandos destructivos irreversibles
# y los BLOQUEA (exit 2) antes de que se ejecuten. Inspirado en ECC safety-guard
# pero adaptado al stack TYCON (.NET, SQL Server, monorepos, multi-tenant).
#
# 🔴 PowerShell (2026-10-04): en Windows Claude Code corre los comandos con su herramienta PowerShell
# (`tool_name: "PowerShell"`, la misma entrada `tool_input.command`; fuente: code.claude.com/docs/en/
# tools-reference §«PowerShell tool»). Registrado sólo con matcher `Bash`, este freno no se disparaba:
# medido ese día en una sesión real (Claude Code 2.1.289, Windows 11), pasaron `git add -A` en
# agent-skills y un commit que saltea los hooks de git. Ahora se registra con `Bash|PowerShell`, y
# cada regla que tiene una forma obvia en PowerShell la frena también (Remove-Item, irm | iex,
# Get-Content, setx…), con el MISMO id de regla: es la misma regla, escrita en otro shell. No hay
# reglas nuevas. El `cwd` de Windows llega con barras invertidas: GIT-C4 lo compara normalizado.
#
# Diseño:
#   - Solo BLOCK (exit 2) — no hay WARN para evitar ruido.
#   - Denylist explícita y corta. v1 cubre los desastres irreversibles.
#   - Opt-in vía hook registrado (la guía explica cómo activarlo).
#   - Override de emergencia por comando: `TYCON_SAFETY_OFF=1 <cmd>`.
#   - Override de sesión: `export TYCON_SAFETY_OFF=1` en .zshrc (no recomendado).
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
#     con su línea, cuando GIT-C4 no pudo mirar el árbol de las skills instaladas (story 8.18): el
#     comando pasa, porque sin árbol resuelto no se sabe si es el lugar, y se dice.
#
# 🔴 La entrada se lee SIN depender de `jq` (2026-10-03). Hasta ese día el freno hacía
# `command -v jq || exit 0`: en una máquina sin `jq` dejaba pasar TODO —el `rm -rf /` incluido— sin
# una palabra. Y `jq` no es un requisito declarado del arnés (`node` sí). Lo cazó un ensayo de
# instalación desde cero. Ahora se lee con `jq` si está y, si no está o no pudo, con `node`; el
# resultado es el mismo con los dos (casos `sin-jq-…` del banco, que corren el hook con un PATH sin
# `jq`).
#
# 🟡 DECISIÓN A CONFIRMAR — qué hace si no hay NI `jq` NI `node` (o la entrada llega vacía, no se
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
# 🔴 FALTA CONFIRMARLO CON UNA SESIÓN REAL: que con exit 1 el comando corre y el aviso se ve sale
# de la documentación de hooks de Claude Code; no se midió en vivo, ni en Claude Code ni en Codex.
# Lo único medido en las dos es que `exit 2` frena y llega al modelo
# (guides/maintaining/codex-divergence-inventory.md). Hay que correr `scripts/controls-bench/live-fire.js`
# contra un `PreToolUse` real. Deuda anotada: `[FUP-frenos-sin-jq-live-fire]` en tasks/todo.md.
# El costo, dicho: mientras dure, nada frena un comando destructivo, y el agente no se entera (sólo
# `exit 2` le llega al modelo). Si el dueño prefiere frenar, es cambiar el `exit 1` de
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

# Fail-open: cualquier error inesperado → exit 0 (no bloquear).
trap 'exit 0' ERR

# Override de emergencia. NO se sale acá: se marca y se sigue evaluando, para que la
# constancia (story 2.6) pueda anotar QUÉ regla se esquivó. El comportamiento no cambia:
# con el override puesto, block() sale 0 en vez de 2.
SAFETY_OFF=0
if [[ "${TYCON_SAFETY_OFF:-0}" == "1" ]]; then
  SAFETY_OFF=1
fi

# ============================================================
# Leer input
# ============================================================
# 🔴 Una entrada VACÍA o que no se pudo leer NO es «nada que frenar»: es «no pude leer», y va por
# `cannot_read` como el resto (más abajo, cuando ya está definida). Antes salía 0 acá mismo, mudo:
# la misma familia que el `exit 0` sin `jq` (revisor de fallos silenciosos, 2026-10-03). Lo que sí
# es «nada que frenar» es una entrada que se lee y no trae comando: ésa sigue saliendo 0 callada.
INPUT="$(cat 2>/dev/null)" || INPUT=""

# Con qué se lee: `jq` si está (es más rápido y este hook corre en cada comando) y `node`, que es
# requisito del arnés, si `jq` no está O no pudo. Ninguno de los dos → `cannot_read`.
# El Node del arnés (story 8.39): el propio si está y es ejecutable; si no, el del PATH. No cambia el PATH.
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
# suelto), y antes eso era otra forma de pasar sin revisión — y en silencio.
# 🔴 Si tocás una rama, tocá la otra: este bloque está copiado igual en test-scope-guard-pre.sh.
read_field() {
  if [[ "$HAS_JQ" == "1" ]]; then
    if printf '%s' "$INPUT" | jq -rs --arg p "$1" \
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
  # Con el freno apagado por el dev (TYCON_SAFETY_OFF=1 en el ambiente) no hay nada que avisar.
  if [[ "${SAFETY_OFF:-0}" == "1" ]]; then exit 0; fi
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

# Soportar inline TYCON_SAFETY_OFF=1 prefijo en el propio comando.
# Patrón: el dev/usuario inyecta `TYCON_SAFETY_OFF=1 <cmd>` para un override
# puntual (más explícito que setear la env var en .zshrc).
if [[ "$CMD" =~ ^[[:space:]]*TYCON_SAFETY_OFF=1[[:space:]] ]]; then
  SAFETY_OFF=1
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

# La forma de PowerShell del override: `$env:TYCON_SAFETY_OFF=1; <cmd>` (el prefijo de bash ahí no es
# sintaxis válida). Igual que el de bash, sólo pegado al PRINCIPIO del comando. Y sólo por la herramienta
# PowerShell (segunda vuelta, MENOR 1): por Bash ese prefijo no asigna nada y no puede apagar el freno.
if ps_match '^[[:space:]]*\$env:TYCON_SAFETY_OFF[[:space:]]*=[[:space:]]*["'"'"']?1["'"'"']?[[:space:]]*;' && tool_is_ps; then
  SAFETY_OFF=1
fi

# El `cwd` como lo escribe Windows (`C:\Users\…`), con barras hacia adelante: así lo leen las reglas que lo
# miran (GIT-C4 compara su texto con `/.claude/agent-skills` y lo recorre por sus `/`), y Git Bash lo entiende
# igual (`C:/Users/…`). Las rutas que el comando nombra con `cd` ya se normalizan así (git_c4_try).
CWD="${CWD//\\//}"

# Dónde empieza un comando de PowerShell: al principio, o después de `;`, `|`, `&`, `(`, `{`, `=` (`$x = …`)
# o de un salto de línea. Por POSICIÓN y no por cualquier espacio, como el freno de push: `git rm -r -q .`
# no es un Remove-Item. (Segunda vuelta, B1: sin el salto de línea y el `=`, un Remove-Item en la segunda
# línea del comando o asignado pasaba; en bash `echo a⏎rm -rf ~` sí frena.)
_PS_NL=$'\n'
_PS_CR=$'\r'
_PS_AT="(^|[;&|({=${_PS_NL}])[[:space:]]*"
# El espacio DENTRO de un comando: blancos, o el acento grave al final de la línea que lo continúa.
_PS_SP="([[:blank:]]|\`${_PS_CR}?${_PS_NL})+"
# Remove-Item y sus alias (o con el nombre del módulo delante); entre el cmdlet y el destino, cualquier
# palabra del mismo comando: banderas abreviadas (-r, -fo) y parámetros CON valor (-ErrorAction
# SilentlyContinue, -ea 0). Segunda vuelta, B2: sólo se aceptaban banderas sueltas y eso lo esquivaba. El
# destino puede ir como `-Path:<destino>`, entre comillas, y seguido de más banderas.
_PS_DEL="${_PS_AT}"'(microsoft\.powershell\.management\\)?(remove-item|ri|rm|del|erase|rd|rmdir)('"${_PS_SP}"'[^;|&[:space:]]+)*'"${_PS_SP}"'(-[a-z]+:)?["'"'"']?'
_PS_END='["'"'"']?([[:space:]]|[;|)]|$)'

# ============================================================
# Helper: bloquear con motivo + log
# ============================================================
LOGFILE="$HOME/.claude/safety-guard.log"
mkdir -p "$(dirname "$LOGFILE")" 2>/dev/null || true

# Constancia de la decisión (story 2.6). Es AYUDA, NO EVIDENCIA: nunca cambia el código de
# salida ni lo que este freno decide. El comando va por STDIN — por argv lo vería cualquier
# `ps` — y de él sólo se guarda la huella.
constancia() { # $1 = regla (id del catálogo)  $2 = veredicto
  local lib="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/guard-record.js"
  [[ -f "$lib" ]] || return 0
  command -v "$HNODE" >/dev/null 2>&1 || return 0
  printf '%s' "$CMD_SHOWN" | "$HNODE" "$lib" --guard safety-guard --rule "$1" --verdict "$2" --cmd-stdin >/dev/null 2>&1 || true
  return 0
}

block() {
  local rule="$1"
  local reason="$2"
  local alt="${3:-}"

  # Override puesto: se sale 0 SIN mensaje y SIN escribir el registro propio —igual que antes—,
  # pero dejando constancia de QUÉ regla se esquivó (story 2.6).
  if [[ "${SAFETY_OFF:-0}" == "1" ]]; then
    constancia "$rule" escape
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
    echo "Override por comando, sólo si el dev lo autorizó en esta conversación:"
    # por la herramienta PowerShell el prefijo de bash no corre: se dice la forma que sí
    if tool_is_ps; then
      echo "  \$env:TYCON_SAFETY_OFF=1; <comando>      (PowerShell)"
    else
      echo "  TYCON_SAFETY_OFF=1 <comando>"
    fi
    echo ""
    echo "Apagar este hook del todo lo decide el dev (guides/safety-guard.md)."
  } >&2

  constancia "$rule" bloqueo
  exit 2
}

# ============================================================
# Reglas (orden = prioridad de match)
# ============================================================

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
# Fix 2026-06-18: el target debe ser EXACTAMENTE `~` / `~/` / `$HOME` / `$HOME/`
# (la raíz del home, nada después). Antes `(\~|\$HOME)([[:space:]]|/|$)` matcheaba
# `~/` y daba falso positivo en `rm -f ~/.cache/foo` (archivo puntual bajo $HOME).
# Ahora `/?([[:space:]]|$)` exige que tras `~`/`$HOME` venga fin-de-token, no un path.
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

# Las OPCIONES DE GIT que pueden ir entre `git` y el subcomando (2026-10-05). Las reglas de abajo buscaban
# el subcomando pegado a `git` (`git commit`, `git clean`; la de push admitía un solo `-C` sin espacios),
# y `git -C <carpeta> commit …` —la forma que Claude usa normalmente— dejaba pasar el salteo de hooks con
# exit 0, por Bash y por PowerShell (medido en Windows y reproducido en Mac). Ahora se admite cualquier
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
# Fix 2026-06-18: el force-flag Y la branch se chequean SOLO dentro de cada segmento
# `git push ...` (hasta el próximo separador ; && || |), NO sobre todo el comando.
# Antes un `-f` de OTRO subcomando en la misma cadena (ej: `git add -f x && git push
# origin dev`) disparaba el block aunque el push fuera un fast-forward normal sin force.
# 🔴 Por POSICIÓN, no por substring (SAFETY-GIT-C1-FALSO-POSITIVO-1, 2026-09-06). El segmentador
# viejo era `git[[:space:]]+push[^;&|]*`: cualquier MENCIÓN de un push —en un echo, en el cuerpo de
# un heredoc, en un grep— abría un segmento que se comía párrafos enteros hasta el próximo `;`,
# y ahí alcanzaba un `-f` de un `[ -f ]` y la palabra `main` para bloquear. Pasó tres veces
# seguidas el 2026-08-31, una de ellas sobre el comando que intentaba reproducirlo. Y este freno
# BLOQUEA: cada falsa alarma enseña `TYCON_SAFETY_OFF=1`, que apaga también el `rm -rf /`.
# Ahora un `git push` cuenta sólo si ARRANCA un comando: al principio, o después de `;`, `&&`,
# `||`, `|`, `(`, con o sin `command`/ruta. Es el mismo criterio que engram-pre-commit.sh (`_GIT`)
# usa desde el 2026-08-25 por el mismo error. Un push real tras `&&`, `;` o `(` sigue frenando
# (casos block-force-push-main-encadenado / -tras-cd / -en-subshell del banco).
# 🔴 Y el comando puede tener PREFIJO (revisión adversarial 2026-09-06, hallazgo BLOQUEA): la primera
# versión posicional sólo admitía `command` o una ruta antes de `git`, así que `VAR=1 git push -f`,
# `sudo git push -f`, `if …; then git push -f`, `{ git push -f; }`, `bash -c "git push -f …"`,
# `git -C /x push -f` y `HEAD:main` pasaban (exit 0) donde antes frenaban — 22 formas medidas. La
# peor: `TYCON_SESSION_GUARD_OK=1 git push --force origin main`, que es exactamente la forma que el
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
  # 🔴 FALSO POSITIVO CONOCIDO, y por qué NO se arregla matcheando más fino (2026-09-01): el
  # match mira TODO el comando, así que también salta cuando la bandera aparece dentro del MENSAJE
  # de un commit — un heredoc, o un `-m "..."`. Pasó dos veces la misma noche, escribiendo el
  # commit de un control que habla de ella (la segunda, editando ESTE archivo).
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

# Las otras dos formas de saltear los hooks de git (GIT-C2, 2026-10-05):
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

# GIT-C4 (2026-06-10, hallazgo H20 #5): staging masivo en el repo AgentSkills.
# ~/.claude/agent-skills mezcla lo propio del equipo (tycon-*) con ~100 archivos
# bmad-* en drift permanente (M esperado, NUNCA se commitea). `git add -A`/`.`
# ahí stagea el drift entero → commits que pisan BMAD. Staging selectivo SIEMPRE.
#
# 🔴 El árbol del que salen las skills instaladas, sea cual sea su carpeta (story 8.18, 2026-10-04).
# Con el arnés y agent-skills en UN repo, las skills de la máquina ya no salen por fuerza de
# ~/.claude/agent-skills: salen del árbol al que resuelve ~/.claude/skills, que puede ser el clon
# del repo unido en cualquier carpeta. La regla miraba sólo si la ruta decía `/.claude/agent-skills`:
# parado en ese clon, `git add -A` pasaba, con todo lo ajeno que vive en ese árbol. Ahora frena:
#   · donde frenaba siempre (la ruta dice `/.claude/agent-skills`: no se le saca nada), y
#   · en el árbol de las skills instaladas: ~/.claude/skills enlazada a <árbol>/skills, o una carpeta
#     real con un enlace por skill (ahí decide la entrada tycon-pipeline). Tiene que ser un clon
#     (trae .git) y no ~/.claude mismo: skills que son una carpeta real de la HOME no tienen «árbol».
# En un clon de trabajo cualquiera NO frena: ahí no hay nada ajeno que stagear.
# Sólo lo que trae bash: `cd`, `pwd -P`, `[[ … ]]` (con `-d`, `-L`, `-e` y `-ef`), expansión de parámetros
# y comparación de texto. Sin `jq`, sin `node`, sin ninguna herramienta del PATH; corre en el bash 3.2 de Mac.
# Casos: `git-c4-…` en scripts/controls-bench/cases/hooks/01-frenos-duros.json.
#
# 🔴 Dos huecos que encontró la revisión de esa misma story (2026-10-04), los dos acá adentro:
#
# 1. SE ESQUIVABA CON UN `cd` EN EL MISMO COMANDO. La regla decidía sólo por el `cwd` que reporta el
#    hook: `cd ~/.claude/agent-skills && git add -A` corrido desde otra carpeta pasaba, y lo mismo
#    `cd <árbol>; git add --all`, `(cd <árbol> && git add .)` y `git -C <árbol> add -A`. Las dos
#    últimas ni siquiera se reconocían como un `git add` masivo: la expresión pedía `git add` pegados
#    (el `-C` va en el medio) y un espacio o el final después del `.` (en el subshell viene un `)`).
#    Ahora, además del `cwd`, se mira CADA carpeta que el propio comando nombra con `cd <dir>`,
#    `pushd <dir>` o `git -C <dir>`: con comillas simples o dobles, con `~`, `$HOME` o `${HOME}`
#    literales al principio, y relativa al `cwd` (y a la del `cd` anterior) si no es absoluta. Si
#    CUALQUIERA cae en un árbol frenado, frena. Conservador a propósito: es un freno, y un falso
#    positivo acá cuesta poco (se stagea por nombre). Lo que NO cambia, medido antes de tocar:
#      · un `cd` a un clon de trabajo cualquiera + `git add -A` pasa (ahí no hay nada ajeno);
#      · `echo "git add -A"` parado en el árbol pasa, como pasaba (tras `-A` viene una comilla);
#      · `echo "git add -A ya"` parado en el árbol frena, como frenaba: esta regla mira el comando
#        entero y no distingue usar el `git add` de escribir sobre él. El mismo falso positivo vale
#        ahora para un comando que NOMBRA el árbol con `cd` y menciona el `git add` masivo.
#    Lo que no ve, dicho: una carpeta que llega por una variable que el comando NO asigna a la vista
#    (viene del ambiente, de un `for`, de un argumento `$1`; la que el mismo comando asigna una sola vez
#    sí se lee: punto e de más abajo), por una sustitución (`cd "$(…)"`) o por `--git-dir`/`--work-tree`.
#    El freno no ejecuta el comando: sólo lee su texto.
#
# 2. CALLABA CUANDO NO PODÍA MIRAR. Si ~/.claude/skills (o su entrada tycon-pipeline) EXISTE pero no
#    se puede resolver —un enlace colgado, una carpeta sin permiso de entrada— la regla no sabe cuál
#    es el árbol de las skills instaladas, y dejaba pasar el `git add -A` sin una palabra. Ahora lo
#    DICE, en una línea, y sale 1. «No existe» sigue siendo silencio: no es un error, es «no hay árbol».
#    Por qué 1 y no 0 ni 2 — la misma cuenta que `cannot_read` (ver el encabezado):
#      · con 0 la herramienta manda el stderr de un PreToolUse al registro de depuración: avisar con
#        salida 0 es callar, que es justo el defecto;
#      · con 2 frenaría TODO `git add -A` de una máquina con la instalación rota, también en un clon
#        de trabajo, donde stagear todo es legítimo: sin árbol resuelto no se sabe si es el lugar;
#      · con 1 el comando corre y a la persona le aparece la PRIMERA línea de stderr. Hereda la deuda
#        de `cannot_read`: no está medido en una sesión real (`[FUP-frenos-sin-jq-live-fire]`), y al
#        modelo no le llega (sólo le llega el `exit 2`).
#    El aviso sale AL TERMINAR el guion (por `trap … EXIT`), no acá: salir en el momento dejaría sin
#    mirar las reglas de más abajo, y un `git add -A && curl … | bash` pasaría entero. Si una regla
#    posterior frena, gana el freno y el aviso no sale. Sólo avisa cuando el comando ES un `git add`
#    masivo (un aviso en cada comando de la sesión sería ruido), y con el freno apagado por el dev calla.
#
# 🔴 El pase adversarial de esa story (2026-10-04) confirmó nueve hallazgos más, todos acá adentro. Son
# cuatro defectos de fondo (a–d), uno que apareció al medir el arreglo del tercero (e) y uno que el
# revisor de seguridad encontró en ese mismo arreglo (f):
#
# a. LA IDENTIDAD DE CARPETA ERA TEXTO. `cd <dir> && pwd -P` de bash devuelve la ruta con las mayúsculas
#    con que se ESCRIBIÓ, no con las del disco. En un disco que no las distingue (Mac y Windows: los del
#    equipo) la misma carpeta nombrada de otra forma no caía en el árbol, y si el enlace ~/.claude/skills
#    había quedado escrito con otras mayúsculas el freno no disparaba nunca. Ahora «¿es la misma carpeta?»
#    se contesta con `[[ a -ef b ]]` (mismo dispositivo y mismo inodo: es de bash, no del PATH), y «¿está
#    adentro del árbol?», subiendo por sus carpetas madre y probando `-ef` en cada nivel. La comparación
#    del texto `/.claude/agent-skills` se conserva además: frena aunque la carpeta no exista.
#
# b. EL RECORRIDO MIRABA UNA SOLA CARPETA POR TRAMO. Una expresión voraz iba del primer `git` al ÚLTIMO
#    ` -C ` sin `;`, `&` ni `|` en el medio —el salto de línea no cortaba—: con dos `-C` en el mismo `git`
#    (git los encadena: `-C a -C b` es a/b), o en un guion de varias líneas, todo `cd`/`-C` del medio no
#    se miraba. Y «la carpeta del `cd` anterior» era una sola cadena: tras un `cd` que no deja al shell
#    ahí (subshell, `pushd`/`popd`, `cd -`), dos `cd` relativos no se probaban contra el `cwd`. Ahora se
#    saca CADA `cd <dir>`, `pushd <dir>` y `-C <dir>`, uno por vuelta, de izquierda a derecha. Como leyendo
#    el texto no se puede saber en qué carpeta queda el shell, las candidatas son un SUPERCONJUNTO: una
#    ruta absoluta, tal cual; una relativa, contra el `cwd` del hook y contra cada carpeta nombrada antes.
#    Con que UNA caiga en el árbol, frena. Cuenta todo ` -C <palabra>`, sea de git o no (`tar -C`, `grep
#    -C 3`): de más, nunca de menos.
#
# c. FRENABA POR EL `cwd` AUNQUE EL COMANDO SE LLEVARA EL `git add` A OTRO REPO (el único marcado como bug).
#    En una máquina de un solo árbol el `cwd` de toda sesión del arnés es el checkout del que salen las
#    skills: `cd <clon de trabajo> && git add -A` y `git -C <clon de trabajo> add -A` frenaban siempre
#    (179 de 180 comandos reales medidos). Ahora el `cwd` cuenta sólo si algún `git add` masivo del
#    comando corre «donde está»: sin un `-C` propio y sin un `cd`/`pushd` ANTES de él, en el texto, a
#    una carpeta que se pudo leer. Un `cd` que viene después, o el `-C` de otro comando, no lo sueltan.
#    Tampoco un `cd` que sólo está escrito: tiene que ARRANCAR un comando (una comilla no abre uno:
#    `echo "cd <otro>"` es texto; `$(cd <otro> && pwd)` es un subshell) y no estar en el cuerpo de un
#    heredoc todavía abierto.
#    «Se pudo leer» = está escrita entera (punto e) y EXISTE, o es una ruta absoluta que todavía no existe
#    y el propio comando crea antes (`mkdir -p <dir> && cd <dir>`, `git clone … <dir>; cd <dir>`). Un
#    `cd "$D"` sin valor a la vista no prueba que el comando se vaya, y un `cd` a una carpeta que NO existe
#    tampoco: es el clon descartable que se borró (o que se llevó un reinicio), el `cd` falla y, si el
#    comando sigue con `;`, el `git add -A` corre en el árbol. Parado en el árbol, frena igual que antes.
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
# d. FORMAS DEL `git add` MASIVO QUE NO SE RECONOCÍAN: `git add ./`, y `-A`/`--all`/`.` pegados a una
#    redirección (`git add -A>/dev/null`) o al acento grave que cierra una sustitución.
#
# e. LA CARPETA QUE LLEGA POR UNA VARIABLE DEL MISMO COMANDO. Arreglar el punto c sólo para rutas escritas
#    a mano no arreglaba casi nada: medido sobre unos 180 comandos reales con `git add` masivo, 123 seguían
#    frenados, y 122 de ésos empezaban con `S=<ruta>; cd $S/<clon>`. Ahora una variable con UNA sola
#    asignación escrita antes en el mismo comando se reemplaza por su valor (git_c4_expand), para los dos
#    lados: `D=<árbol>; cd "$D" && git add -A` frena desde cualquier carpeta, y `S=<otro>; cd $S/<clon>`
#    cuenta como irse. Y de una ruta absoluta con un final que no se lee (`$S/foto-$r` en un lazo) alcanza
#    con su carpeta madre, si existe y no está en el árbol ni lo tiene adentro (y el comando no trae
#    ningún `..`). Con todo, de 181 comandos reales quedan frenados 11 (antes 176): funciones con `$1`,
#    guiones escritos con un heredoc que traen su propio `git add`, `bash -c '…'`, lazos con `cd`, y uno
#    que de verdad nombra ~/.claude/agent-skills. (Medido parado en el árbol y con las carpetas temporales
#    de aquellas sesiones recreadas: hoy ya no existen. Parado en un clon de trabajo: 1, igual que antes.)
#
# f. EL RECORRIDO ERA CIEGO A LAS COMILLAS (revisor de seguridad, vuelta 2, 2026-10-04: un esquive real de lo
#    que agregó el punto c). Para decidir si un `cd` arranca un comando se miraba el carácter anterior, sin
#    saber si estaba dentro de una comilla abierta. Parado en el árbol pasaban `echo "; cd /tmp" >/dev/null;
#    git add -A` (el `cd` es texto del `echo`) y `git -c x=" -C /tmp" add -A` (el `-C` es el valor de otra
#    opción). Ahora hay dos lecturas del mismo comando:
#      · para FRENAR, el comando crudo, como antes: toda carpeta nombrada cuenta, aunque esté entre
#        comillas (frena de más, a propósito);
#      · para DESCONTAR la carpeta de la sesión, una copia enmascarada (git_c4_mask): sólo cuenta el `cd`,
#        el `pushd`, el `-C`, la asignación `S=<ruta>` y el `mkdir` que están FUERA de toda comilla
#        (simples, dobles, `$'…'`), de todo comentario y del cuerpo de todo heredoc. La comilla que
#        envuelve el ARGUMENTO no molesta: `cd "<ruta con espacios>/clon" && git add -A` sigue descontando.
#    🟡 DECISIÓN: `bash -c "cd <otro> && git add -A"` (y `sh -c`, `eval "…"`) NO descuenta. Ese `cd` sí
#    correría, pero leer el texto de un `-c` como comando es reabrir este mismo esquive. Parado en el
#    árbol frena; se sale escribiendo el `cd` afuera. Caso: `git-c4-block-shell-dash-c-string-with-cd-…`.
#    Para que eso valga hizo falta cerrar un hueco viejo: `bash -c "git add -A"` parado en el árbol pasaba
#    desde siempre (tras `-A` viene la comilla que cierra, y eso no se tomaba por un `git add` masivo). Con
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
# De una ruta absoluta, el tramo que se lee entero: desde la raíz hasta la última `/` anterior a la primera
# variable, sustitución o comodín.
GIT_C4_KNOWN_HEAD='^/[^$`*?[]*/'
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
# Por qué (revisor de seguridad, vuelta 2 de la story 8.18): el recorrido era ciego a las comillas. Parado en
# el árbol, `echo "; cd /tmp" >/dev/null; git add -A` pasaba: el `cd` del texto se tomaba por un movimiento
# real y descontaba la carpeta de la sesión. Lo mismo `git -c x=" -C /tmp" add -A`. Ahora, para DESCONTAR
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

# ── PowerShell (segunda vuelta, B3): las carpetas como las escribe Windows ─────────────────────────────────
# Por la herramienta PowerShell, `cd ~\.claude\agent-skills; git add -A`, `cd $env:USERPROFILE\…`,
# `Set-Location …`, `sl …`, `Push-Location …` y `git -C ~\… add -A` pasaban: el recorrido de abajo lee la
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
    if [[ "$GIT_C4_KNOWN" == "0" && "$GIT_C4_AMBIGUOUS" == "0" && "$CMD" != *..* && "$GIT_C4_DIR" =~ $GIT_C4_KNOWN_HEAD ]]; then
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
  if [[ -n "$GIT_C4_BLIND" && "${SAFETY_OFF:-0}" != "1" ]]; then
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
# Segunda vuelta, C2: también `curl.exe`/`wget.exe` (en PowerShell `curl` es un alias de Invoke-WebRequest y
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
# `Invoke-Expression -Command (irm …)`, `iex "& { $(irm …) }"` (segunda vuelta, C2). Hasta el `;` o `|`.
if ps_match "(^|[^a-z-])${_PS_IEX}([[:space:]]|\()[^;|]*(^|[^a-z.-])(invoke-webrequest|iwr|invoke-restmethod|irm|curl|wget|downloadstring|new-object)([^a-z-]|$)"; then
  block "SUP-C2" \
    "Invoke-Expression sobre una descarga. Ejecuta código no auditado en tu sesión actual." \
    "Mismo que SUP-C1: bajalo, inspeccionalo, después ejecutalo."
fi

# --- Publicación accidental --------------------------------------------------

if [[ "$CMD" =~ (^|[[:space:]])npm[[:space:]]+publish([[:space:]]|$) ]]; then
  block "PUB-C1" \
    "npm publish — publicación a registry público. Suele ser accidente cuando se intentaba 'npm pack' o 'npm version'." \
    "Si el dev confirma que hay que publicar: TYCON_SAFETY_OFF=1 npm publish. Y revisá que el package no contenga secretos."
fi

if [[ "$CMD" =~ (^|[[:space:]])yarn[[:space:]]+publish([[:space:]]|$) ]]; then
  block "PUB-C2" \
    "yarn publish — publicación a registry público." \
    "Mismo que PUB-C1."
fi

if [[ "$CMD" =~ dotnet[[:space:]]+nuget[[:space:]]+push ]]; then
  block "PUB-C3" \
    "dotnet nuget push — publicación a NuGet feed. Solo CI/release pipeline debería hacer esto." \
    "Si el dev confirma que es manual a propósito (raro): TYCON_SAFETY_OFF=1 <cmd>. Confirmá que el .nupkg sea el correcto."
fi

# --- SQL destructivo (sqlcmd / dotnet ef / inline) ---------------------------

# DROP DATABASE — las bases de los clientes (acmebase, acmebase_dev, etc.).
# Drop accidental es catastrófico.
if [[ "$CMD" =~ DROP[[:space:]]+DATABASE ]]; then
  block "SQL-C1" \
    "DROP DATABASE. Te llevás esquema + datos + historial." \
    "Si el dev confirma que hay que recrear la DB (típicamente *_DEV): TYCON_SAFETY_OFF=1 <cmd>, después restaurás backup."
fi

# DROP TABLE — block solo si NO está en un .sql migration file (esos son legítimos).
# Heurística: si el comando incluye 'DROP TABLE' y NO incluye un path .sql, block.
if [[ "$CMD" =~ DROP[[:space:]]+TABLE ]] && [[ ! "$CMD" =~ \.sql ]]; then
  block "SQL-C2" \
    "DROP TABLE inline (no en una migration file). Las modificaciones de schema en TYCON van por migration numerada." \
    "Creá una migration nueva con tycon-new-migration y dropéa la tabla ahí. Si es exploratorio en *_DEV y el dev lo confirma: TYCON_SAFETY_OFF=1 <cmd>."
fi

# --- El arnés no se apaga a sí mismo -----------------------------------------

# HARNESS-C1 (2026-08-25, §5.3 del plan de controles apagables): PERSISTIR un kill-switch del
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
# Sin match → permitir.
# ============================================================
exit 0
