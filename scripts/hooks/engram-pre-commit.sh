#!/usr/bin/env bash
# engram-pre-commit.sh — sync de memoria engram antes de cada commit.
#
# Hook PreToolUse matcher=Bash. Cuando el comando es `git commit`, corre
# `engram sync --project <name>` y stagea `.engram/` para que los chunks
# de memoria persistente viajen con el commit. En `git push` NO hace nada
# (ver la nota junto a la salida temprana, más abajo). Implementa
# la regla "Engram Memory System → Pre-commit Engram Sync" del CLAUDE.md global.
#
# Diseño:
#   - Opt-in POR REPO: solo actúa si la raíz del repo tiene un archivo
#     `.engram-project` cuyo contenido es el project name de engram.
#   - El repo es el del COMMIT, no el de la sesión: `cd <otro> && git commit` y
#     `git -C <otro> commit` exportan y preparan en <otro>. Ver «¿En qué repo se hace el commit?».
#   - Un commit en un clon del repo PÚBLICO del arnés no exporta nada, en ningún lado:
#     ese clon no trae `.engram-project`, así que acá no pasa nada, y lo pendiente lo exporta y lo
#     prepara el próximo commit hecho EN el clon privado de mantenimiento (`engram sync --project X`
#     exporta todo lo pendiente del proyecto, se haya guardado desde la sesión que sea). No se exporta
#     a ese otro clon desde acá: lo que queda sin preparar en un repo donde no se está
#     commiteando no viaja nunca (`stagear_lo_nuevo` prepara sólo lo de ESTA vuelta) y el commit
#     siguiente entra con el índice declarando un trozo que no está. Lo fija `Memory_NotInPublicRepo`
#     de scripts/tests/manifest-engram.test.sh.
#   - Fail-open total: cualquier condición faltante (no es repo, no hay
#     .engram-project, engram no instalado) => exit 0 sin bloquear el commit.
#   - Portable: el binario de engram se autodetecta vía PATH; overridable con
#     la env var ENGRAM_BIN si está en una ubicación no estándar.
#   - Debug: ENGRAM_HOOK_DEBUG=1 loguea cada invocación a /tmp/engram-hook.log
#
# Input: JSON por stdin del PreToolUse hook.
#   { "tool_input": { "command": "..." } }

# Dónde vive este hook: para llegar a `../lib/` (el criterio del índice y la constancia). Se
# resuelve por symlink también, porque el instalador puede enlazarlo desde ~/.claude/hooks/.
SCRIPT_DIR="$(cd "$(dirname "$(readlink "${BASH_SOURCE[0]}" || echo "${BASH_SOURCE[0]}")")" && pwd)"
LIB_MANIFEST="$SCRIPT_DIR/../lib/manifest-engram.js"
LIB_CONSTANCIA="$SCRIPT_DIR/../lib/guard-record.js"

# Autodetección del binario: env var > PATH > paths comunes (mac ARM / intel / linux).
ENGRAM_BIN="${ENGRAM_BIN:-$(command -v engram 2>/dev/null)}"
if [ -z "$ENGRAM_BIN" ]; then
  for c in /opt/homebrew/bin/engram /usr/local/bin/engram "$HOME/.local/bin/engram"; do
    [ -x "$c" ] && ENGRAM_BIN="$c" && break
  done
fi

LOG="${ENGRAM_HOOK_LOG:-/tmp/engram-hook.log}"

log() {
  [ "$ENGRAM_HOOK_DEBUG" = "1" ] && echo "[$(date '+%F %T')] $*" >> "$LOG"
}

INPUT=$(cat 2>/dev/null) || INPUT=""
log "invoked | stdin-len=${#INPUT}"

# ── Leer JSON sin depender de `jq` ──────────────────────────────────────────────
# Leer el comando con `jq` solo dejaría el comando VACÍO sin `jq`: «no era un commit», y
# saldría 0 sin sincronizar la memoria ni cruzar el índice, sin una palabra (el aviso «jq no está en
# el PATH» de `cruzar_indice` sería inalcanzable). `jq` no es un requisito declarado del arnés; `node`
# sí. Se lee con `jq` si está y, si no, con
# `node`: las dos ramas de `read_json` hacen lo mismo (casos `sin-jq-…` del banco).
# Si `jq` está pero no pudo, se prueba con `node` antes de rendirse: hay JSON válido que `jq`
# rechaza (un `\ud800` suelto). Con `-s`, `jq` no imprime nada si falla: no se duplica la salida.
# El Node del arnés: el propio si está y es ejecutable; si no, el del PATH. No cambia el PATH.
# con el bash de la Mac (3.2) y `set -e`, un `.` que no encuentra el archivo corta el guion aunque lleve `||`: se mira antes
_hn="$SCRIPT_DIR/../lib/harness-node.sh"
{ [ -f "$_hn" ] && . "$_hn" 2>/dev/null; } || harness_node_bin() { echo node; }
HNODE="$(harness_node_bin)"
HAS_JQ=0; HAS_NODE=0
if command -v jq >/dev/null 2>&1; then HAS_JQ=1; fi
if command -v "$HNODE" >/dev/null 2>&1; then HAS_NODE=1; fi

# read_json <modo> [<ruta.con.puntos> [<defecto>]] — lee UN documento JSON de stdin.
#   text  <ruta> <defecto>  el valor tal cual; <defecto> si falta, es null o es false
#   list  <ruta>            los elementos de la lista unidos con ", " (nada si falta)
#   count <ruta>            el valor como texto, o la palabra null si falta: «no conté» ≠ «conté 0»
#   cross                   no imprime: sale 0 sólo si es un objeto con la clave "estado"
# Sale ≠ 0 si no pudo leer (no hay lector, o no es un documento JSON) y, en `cross`, si no lo es.
# 🔴 Las dos ramas (`read_json_jq` y `read_json_node`) hacen lo mismo: si tocás una, tocá la otra.
read_json() {
  local input
  input=$(cat)
  if [ "$HAS_JQ" = "1" ] && printf '%s' "$input" | read_json_jq "$@"; then return 0; fi
  # En `cross`, un «no» de `jq` (sale 1) es una respuesta, no una falla: `node` va a decir lo mismo.
  if [ "$HAS_NODE" = "1" ]; then printf '%s' "$input" | read_json_node "$@"; return $?; fi
  return 1
}
read_json_jq() {
  case "$1" in
    # `-b`: el `jq` nativo de Windows escribe cada salto de línea como `\r\n` salvo con `-b` (un «sano\r» no es «sano»);
    # un `jq` que no lo conoce falla y lee `node`
    text)  jq -b -rs --arg p "$2" --arg d "${3:-}" 'if length == 1 then (.[0] | getpath($p | split(".")) // $d) else error("no es UN documento JSON") end' 2>/dev/null ;;
    list)  jq -b -rs --arg p "$2" 'if length == 1 then (.[0] | (getpath($p | split(".")) // []) | join(", ")) else error("no es UN documento JSON") end' 2>/dev/null ;;
    count) jq -b -rs --arg p "$2" 'if length == 1 then (.[0] | getpath($p | split(".")) | if . == null then "null" else tostring end) else error("no es UN documento JSON") end' 2>/dev/null ;;
    cross) jq -es 'length == 1 and (.[0] | type == "object" and has("estado"))' >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}
read_json_node() {
  "$HNODE" -e '
    const [mode, route, fallback] = process.argv.slice(1);
    let v;
    try { v = JSON.parse(require("fs").readFileSync(0, "utf8").replace(/^\uFEFF/, "")); } catch (e) { process.exit(1); }
    const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
    if (mode === "cross") process.exit(isObject(v) && Object.prototype.hasOwnProperty.call(v, "estado") ? 0 : 1);
    for (const k of route.split(".")) {
      if (v === null) break;
      if (!isObject(v)) process.exit(1);
      v = Object.prototype.hasOwnProperty.call(v, k) ? v[k] : null;
    }
    const asText = (x) => (typeof x === "string" ? x : JSON.stringify(x, null, 2));
    let out;
    if (mode === "text") out = (v === null || v === false) ? fallback : asText(v);
    else if (mode === "list") {
      if (v === null || v === false) v = [];
      if (!Array.isArray(v)) process.exit(1);
      out = v.map((x) => (x === null ? "" : typeof x === "string" ? x : JSON.stringify(x))).join(", ");
    } else if (mode === "count") out = v === null ? "null" : typeof v === "string" ? v : JSON.stringify(v);
    else process.exit(1);
    process.stdout.write(out + "\n");
  ' "$1" "${2:-}" "${3:-}" 2>/dev/null
}

# No se pudo leer el comando. Este hook corre en CADA comando y sólo le compete el `git commit` de
# un repo con memoria, así que avisa sólo ahí: si el texto crudo de la entrada ni nombra «commit»,
# o el repo no tiene `.engram-project`, calla (no habría hecho nada aunque pudiera leer).
# 🟡 DECISIÓN A CONFIRMAR: en ese caso NO frena y NO calla — sale 1, que la herramienta trata como
# error que no bloquea: el commit sigue y a la persona le aparece la primera línea de stderr. Con
# exit 0 ese aviso iría al registro de depuración (callar), y exit 2 frenaría todos los commits de
# una máquina sin `node`. El razonamiento completo está en el encabezado de safety-guard-pre.sh.
# 🔴 FALTA CONFIRMARLO CON UNA SESIÓN REAL: que con exit 1 el comando corre y el aviso se ve sale
# de la documentación de hooks de Claude Code; no se midió en vivo, ni en Claude Code ni en Codex.
# Lo único medido en las dos es que `exit 2` frena y llega al modelo
# (guides/maintaining/codex-divergence-inventory.md). Hay que correr `scripts/controls-bench/live-fire.js`
# contra un `PreToolUse` real.
cannot_read() {
  # 🔴 Una entrada VACÍA (o que no se pudo leer) es «no pude leer», explícito: no se le pregunta si
  # nombra «commit», porque no nombra nada. Si no, caería en el `exit 0` de abajo, mudo.
  # El filtro del texto vale sólo para una entrada que SÍ llegó.
  if [ -n "$INPUT" ]; then
    case "$INPUT" in *commit*) ;; *) log "no pude leer la entrada y no nombra commit, exit 0"; exit 0 ;; esac
  fi
  local root
  root=$(git rev-parse --show-toplevel 2>/dev/null)
  if [ -z "$root" ] || [ ! -f "$root/.engram-project" ]; then log "no pude leer la entrada; repo sin opt-in, exit 0"; exit 0; fi
  local reason="la entrada no se pudo leer como UN documento JSON"
  if [ -z "$INPUT" ]; then reason="la entrada llegó vacía o no se pudo leer"
  elif [ "$HAS_JQ" = "0" ] && [ "$HAS_NODE" = "0" ]; then reason="no hay ni jq ni node en el PATH de este hook"; fi
  log "no pude leer la entrada: ${reason}"
  echo "⚠️ tycon: engram-pre-commit NO PUDO LEER este comando: ${reason}. Si es un git commit, la memoria de esta sesión NO se exportó y el índice de memoria no se revisó. Arreglo: que node (requisito del arnés) esté en el PATH con el que arranca la herramienta." >&2
  exit 1
}

if [ -z "$INPUT" ]; then cannot_read; fi
CMD=$(printf '%s' "$INPUT" | read_json text tool_input.command "") || cannot_read
log "parsed CMD=[$CMD]"

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
_HERR_C1=$(printf '%s' "$INPUT" | read_json text tool_name "") || _HERR_C1=""
_cmd_c1="$(cmd_c1_motivo "$CMD" "$_HERR_C1")"
if [ -n "$_cmd_c1" ]; then
  log "CMD-C1: ${_cmd_c1}, exit 2"
  echo "⛔ tycon: engram-pre-commit (CMD-C1): el comando trae ${_cmd_c1}. ${CMD_C1_POR_QUE} ${CMD_C1_ARREGLO}" >&2
  exit 2
fi

# 🔴 El match es por POSICIÓN, no por substring. Un glob
# (`*"git push"*`) daría positivo con CUALQUIER comando que contuviera ese texto en cualquier lado:
# un heredoc que escribe un caso de test, un `sed` sobre documentación, un `grep "git push"`. Un falso positivo así es un sync de más, sin costo visible.
#
# Tiene que aparecer al principio del comando o después de un separador (`;`, `&&`, `||`,
# `|`, `(`), que es donde empieza un comando de verdad. `grep -qE` y no `case`: los globs de sh no
# tienen alternación con anclas.
#
# 🔴 Entre `git` y el subcomando no alcanza aceptar sólo OPCIONES (`-[^ ]+`): se perdería todo
# lo que lleva VALOR o prefijo — formas
# que el equipo usa a diario y que tienen que disparar el hook:
#     git -C /ruta push · git -c color.ui=false push · command git push · /usr/bin/git push
# Se aceptan hasta 4 tokens cualesquiera entre `git` y el subcomando, un prefijo de ruta
# (`/usr/bin/git`) y el envoltorio `command`.
#
# El sesgo es a propósito: un falso positivo cuesta un sync de más y el staging
# ya es selectivo, mientras que un falso NEGATIVO deja la memoria de esa sesión sin exportar. Con
# ese costo asimétrico, conviene errar hacia detectar de más.
#
# Sigue sin ser un parser de shell, y no puede serlo con un regex: un `; git push` adentro de un
# string entrecomillado dispara igual. Eso es tolerable porque el efecto es sincronizar y
# stagear sólo lo que ese sync generó. Si alguna vez esta rama vuelve a bloquear, esto NO alcanza.
ES_COMMIT=0; ES_PUSH=0
# 🔴 Y con PREFIJO: `VAR=1 git commit`, `sudo git push`, `if …; then git
# commit`, `{ git push; }` tienen que reconocerse. Es el mismo criterio que `_GIT_POS` del safety-guard: lo que
# se admite antes de `git` son asignaciones, envoltorios (sudo, env, time, nohup, exec, command, timeout,
# nice) y los separadores `{`, backtick, `!`, `then`/`do`/`else`, `-c "` de un shell.
_GIT='(^|[;&|({`!]|&&|\|\||-c[[:space:]]+["'"'"']|(then|do|else)[[:space:]])[[:space:]]*(([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|sudo|env|time|nohup|exec|command|timeout|nice|-[A-Za-z]+|[0-9]+)[[:space:]]+)*([^[:space:]]*/)?git[[:space:]]+([^[:space:]]+[[:space:]]+){0,4}'
# 🔴 Los strings entrecomillados se VACÍAN antes de matchear: la rama de commit bloquea, y un
# `git log --grep="; git commit"` se trataría como commit, y un mensaje `-m "… ;
# TYCON_ENGRAM_MANIFEST_OK=1 …"` abriría el escape. Sigue sin ser un parser de shell: se borra el
# contenido de "…" y '…' (con `\"` adentro) y se matchea sobre lo que queda, que es donde viven los
# comandos de verdad. `$CMD` no se toca: el log, la constancia y el sync lo siguen viendo entero.
# Una barra invertida escapada (`\\`) se saca antes que `\"`: en `"a\\"` la comilla cierra el texto, y sacando primero
# `\"` se emparejaba con la siguiente y el `; git commit` de después quedaba adentro de un texto vaciado.
CMD_SIN_STRINGS=$(printf '%s' "$CMD" | sed -e 's/\\\\//g' -e "s/\\\\\"//g" -e "s/\"[^\"]*\"/\"\"/g" -e "s/'[^']*'/''/g")
printf '%s' "$CMD_SIN_STRINGS" | grep -qE "${_GIT}commit([[:space:]]|\$)" && ES_COMMIT=1
printf '%s' "$CMD_SIN_STRINGS" | grep -qE "${_GIT}push([[:space:]]|\$)"   && ES_PUSH=1
log "match commit=$ES_COMMIT push=$ES_PUSH"
if [ "$ES_COMMIT" = "0" ] && [ "$ES_PUSH" = "0" ]; then
  log "no match, exit 0"; exit 0
fi

# 🔴 En un `git push` NO se sincroniza: stagear lo exportado y avisar «commiteala y volvé a pushear»
# deja el manifest modificado sin commit, porque ese commit de limpieza casi nunca llega.
# El `git pull --autostash` del arranque de la sesión siguiente lo guarda aparte, trae lo
# publicado y al reaplicarlo CHOCA (cada máquina agrega su entrada al final de la misma lista); la
# limpieza del conflicto se queda con la versión publicada y descarta las entradas nuevas.
# Resultado: chunks en disco que ningún índice lista, y un chunk sin entrada NO existe para las demás máquinas
# (guides/integrations/engram-workflow.md §manifest). Sin sync en el push no hay nada que quede
# suelto: lo pendiente se exporta, se stagea y se commitea junto, en el `git commit` siguiente.
# Se pierde latencia, no memoria.
if [ "$ES_COMMIT" = "0" ]; then
  log "push: no se sincroniza (un sync en push deja .engram/ sucio sin commit), exit 0"
  exit 0
fi

# ── ¿En qué repo se hace el commit? ──────────────────────────────────────────────
# Este hook corre parado en la carpeta de la SESIÓN, y elegir el repo con `git rev-parse` desde
# ahí falla si el comando commitea en OTRO repo (`cd <clon> && git commit`, `git -C <clon> commit`):
# entonces el sync exportaría la memoria a la carpeta de la sesión y la dejaría PREPARADA ahí, el
# commit saldría sin su memoria, y la carpeta de la sesión —con el índice modificado sin commitear—
# dejaría de actualizarse sola. Y de la carpeta compartida del arnés lee su lista el freno de
# publicación: atrasada, frena empujes.
#
# El criterio NO se escribe acá: es el de scripts/lib/git-target.js (el `cd` arrastrado y el `-C`
# de cada git), el mismo que usan el freno de sesiones y el registro de retrospectivas, llamado
# como lo llama retro-pending.js (sin los cuerpos de heredoc que son texto, con envoltorios).
#   · un destino resuelto      → se trabaja AHÍ (una vuelta de este hook por repo distinto);
#   · un commit que no se puede ubicar (`git -C "$VAR" commit` con una variable que el comando no
#     define; un `cd` o un `-C` en una máquina sin node o sin el criterio) → se DICE y no se escribe
#     en ningún lado. Nunca en la carpeta de la sesión por descarte: ése es el defecto;
#   · ningún git con forma de commit (el filtro de arriba lo vio en el cuerpo de un heredoc): el
#     comando HABLA de un commit, no lo hace. No se sincroniza y no se avisa; lo pendiente viaja en
#     el commit de verdad que siga. (Mismo recorte que retro-pending.js, que lo midió: avisar por
#     cada mención es la vía corta a que el control se apague.)
LIB_TARGET="$SCRIPT_DIR/../lib/git-target.js"
LIB_SHELL="$SCRIPT_DIR/../lib/shell-parse.js"
SESSION_DIR=$(printf '%s' "$INPUT" | read_json text cwd "") || SESSION_DIR=""
if [ -z "$SESSION_DIR" ] || [ ! -d "$SESSION_DIR" ]; then SESSION_DIR="$PWD"; fi

# Una línea por destino: «dir<TAB>carpeta», «unknown<TAB>la sentencia» o «error<TAB>motivo».
commit_dirs() {
  local missing=""
  if [ "$HAS_NODE" = "0" ]; then missing="node no está en el PATH"
  elif [ ! -f "$LIB_TARGET" ] || [ ! -f "$LIB_SHELL" ]; then missing="falta el criterio ($LIB_TARGET)"; fi
  if [ -n "$missing" ]; then
    # Sin con qué resolver. Si el comando no trae ni un `cd` ni un `-C`, no hay nada que resolver: el
    # commit es en la carpeta de la sesión, y el hook sigue como siempre (sin node valida con python3
    # y el cruce dice que no pudo medir: manifest-engram.test.sh, T35b). Si trae alguno, no se
    # adivina: es «no sé». No es otro criterio: es preguntar si hay algo que el criterio tenga que mirar.
    if printf '%s' "$CMD_SIN_STRINGS" | grep -qE '(^|[;&|({[:space:]])cd([[:space:]]|$)|[[:space:]]-C([[:space:]]|$)'; then
      printf 'error\t%s\n' "$missing"
    else
      printf 'dir\t%s\n' "$SESSION_DIR"
    fi
    return 0
  fi
  printf '%s' "$CMD" | "$HNODE" -e '
    const [target, shell, base] = process.argv.slice(1);
    let cmd = "";
    process.stdin.on("data", (d) => { cmd += d; }).on("end", () => {
      try {
        const gt = require(target);
        const { sinHeredocs } = require(shell);
        const found = gt.destinos(sinHeredocs(cmd, { salvoShell: true }), base, gt.regexDeGit("commit"), { envoltorios: true });
        const seen = new Set();
        for (const d of found) {
          const line = d.resuelto ? "dir\t" + d.dir : "unknown\t" + String(d.st).replace(/\s+/g, " ").slice(0, 120);
          if (!seen.has(line)) { seen.add(line); console.log(line); }
        }
      } catch (e) { console.log("error\t" + String((e && e.message) || e).split("\n")[0]); }
    });
  ' "$LIB_TARGET" "$LIB_SHELL" "$SESSION_DIR" 2>/dev/null || printf 'error\tnode no pudo correr el criterio\n'
}

# Se avisa sólo si la carpeta de la sesión guarda memoria: es donde habría
# escrito. En cualquier otro lado este hook no hace nada ni dice nada.
unknown_target() { # $1 = qué no se pudo ubicar
  local root
  root=$(git -C "$SESSION_DIR" rev-parse --show-toplevel 2>/dev/null)
  if [ -z "$root" ] || [ ! -f "$root/.engram-project" ]; then log "no pude ubicar el commit ($1); la carpeta de la sesión no guarda memoria: callado"; return 1; fi
  log "no pude ubicar el commit: $1"
  echo "⚠️ tycon: engram-pre-commit NO PUDO SABER en qué repo se hace este commit ($1). No exporté la memoria de esta sesión ni preparé nada, en ningún repo: no se escribe en la carpeta de la sesión por descarte. Si el repo del commit guarda memoria, parado ahí: engram sync --project \"\$(cat .engram-project)\" && git add .engram/ — y sumalo al commit." >&2
  return 0
}

if [ -n "${ENGRAM_HOOK_COMMIT_DIR:-}" ]; then
  # Una vuelta por repo: la invocación de arriba ya resolvió dónde, y esta vuelta trabaja ahí.
  cd "$ENGRAM_HOOK_COMMIT_DIR" 2>/dev/null || { log "la carpeta del commit no existe todavía ($ENGRAM_HOOK_COMMIT_DIR), exit 0"; exit 0; }
else
  TARGETS=$(commit_dirs)
  if [ -z "$TARGETS" ]; then
    log "ningún git con forma de commit fuera de los heredocs: el comando lo menciona, no lo hace. No se sincroniza, exit 0"
    exit 0
  fi
  COMMIT_DIRS=$(printf '%s\n' "$TARGETS" | awk -F'\t' '$1 == "dir" { print $2 }')
  UNKNOWN=$(printf '%s\n' "$TARGETS" | awk -F'\t' '$1 != "dir" { print $2 }' | tr '\n' ';' | sed 's/;$//')
  log "destinos del commit: [$(printf '%s' "$COMMIT_DIRS" | tr '\n' ' ')] · sin ubicar: [$UNKNOWN]"
  WARNED=0
  if [ -n "$UNKNOWN" ] && unknown_target "$UNKNOWN"; then WARNED=1; fi
  if [ -z "$COMMIT_DIRS" ]; then
    # Con exit 1 el comando sigue y el aviso se ve (el mismo criterio que `cannot_read`, arriba).
    exit "$WARNED"
  fi
  if [ "$WARNED" = "0" ] && [ "$(printf '%s\n' "$COMMIT_DIRS" | grep -c .)" = "1" ]; then
    cd "$COMMIT_DIRS" 2>/dev/null || { log "la carpeta del commit no existe todavía ($COMMIT_DIRS), exit 0"; exit 0; }
  else
    # Más de un repo en el mismo comando (o uno ubicado y otro no): una vuelta de este hook por repo.
    # Si alguna frena (el índice de ESE repo pierde entradas), el comando se frena.
    WORST="$WARNED"
    while IFS= read -r d; do
      [ -n "$d" ] || continue
      printf '%s' "$INPUT" | ENGRAM_HOOK_COMMIT_DIR="$d" bash "${BASH_SOURCE[0]}"; rc=$?
      if [ "$rc" = "2" ]; then WORST=2; elif [ "$rc" != "0" ] && [ "$WORST" = "0" ]; then WORST=1; fi
    done <<EOF_DIRS
$COMMIT_DIRS
EOF_DIRS
    exit "$WORST"
  fi
fi

REPO=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO" ]; then
  log "not a git repo, exit 0"
  exit 0
fi
log "repo=$REPO"

if [ ! -f "$REPO/.engram-project" ]; then
  log "no .engram-project file, exit 0"
  exit 0
fi

PROJECT=$(tr -d '[:space:]' < "$REPO/.engram-project")
if [ -z "$PROJECT" ]; then
  log ".engram-project empty, exit 0"
  exit 0
fi
log "project=$PROJECT"

# ── La configuración del arnés ─────────────────────────────────────────────
# Un `~/.claude/tycon.json` (o un perfil) roto NO se lee como «engram apagado» ni frena el commit:
# se dice en CADA corrida —sin sello, sin silencio— y esta invocación no sincroniza. Nunca sale ≠ 0
# por esto: un PreToolUse que sale con 2 deja la sesión sin Bash. El lector vive al lado de este hook.
CONFIG_JS="$SCRIPT_DIR/../lib/tycon-config.js"
if [ -f "$CONFIG_JS" ] && command -v "$HNODE" >/dev/null 2>&1; then
  # Se decide por el VEREDICTO del lector (la primera línea de su aviso), no por «hay algo en stderr»: un warning
  # ajeno del runtime (ExperimentalWarning, nvm, NODE_OPTIONS) NO apaga el sync.
  CONFIG_AVISO="$("$HNODE" "$CONFIG_JS" validate --hook 2>&1 >/dev/null)" || true
  if printf '%s' "$CONFIG_AVISO" | grep -q 'tycon: la configuración del arnés está ROTA'; then
    printf '%s\n' "$CONFIG_AVISO" >&2
    log "configuración del arnés rota: no se sincroniza, exit 0"
    exit 0
  fi
  # ── Su integración, mirada por el propio hook ─────────────
  # Del lado Claude Code, con engram apagada este hook no se registra; pero puede quedar registrado en Codex, o en un
  # settings.json viejo, y sincronizaría igual. Con engram apagada no hace nada. Manda el mismo interruptor que usa
  # el aplicador (`override` de scripts/setup/hooks-list.json): TYCON_ENGRAM_HOOK=1 lo prende y =0 lo apaga.
  ENGRAM_STATE="$("$HNODE" "$CONFIG_JS" key engram --hook --switch TYCON_ENGRAM_HOOK 2>/dev/null)" || ENGRAM_STATE=""
  if [ "$ENGRAM_STATE" = "apagada" ]; then
    log "integración engram apagada (TYCON_ENGRAM_HOOK=1 la fuerza): no se sincroniza, exit 0"
    exit 0
  fi
fi

if [ -z "$ENGRAM_BIN" ] || [ ! -x "$ENGRAM_BIN" ]; then
  log "engram binary not found (set ENGRAM_BIN to override), exit 0"
  exit 0
fi

cd "$REPO" || exit 0

# 🔴 Foto de `.engram/` ANTES del sync. El `git add .engram/`
# incondicional stagearía TODO lo que hubiera ahí — incluidos chunks que el dev tenía sin commitear
# de antes, o que dejó a propósito fuera del commit. Un falso positivo del matcher
# stagearía un `.engram/chunks/manual.jsonl.gz` preexistente. Por eso se stagea sólo lo que ESTA
# invocación creó o tocó; si no se pudo tomar la foto, no se stagea nada (ver `stagear_lo_nuevo`).
# `foto_engram` lista cada archivo con su tamaño y su mtime. Se usa `cksum` y no `stat`, que tiene
# banderas distintas en BSD y en GNU — el hook corre en macOS y en Linux, y una bandera que no
# existe habría devuelto vacío, que acá significa "no se pudo" y frena el staging.
foto_engram() {
  [ -d "$REPO/.engram" ] || return 0
  find "$REPO/.engram" -type f 2>/dev/null | sort | while IFS= read -r f; do
    printf '%s %s\n' "$f" "$(cksum < "$f" 2>/dev/null | awk '{print $1"-"$2}')"
  done
}
# Se cuentan los ARCHIVOS previos, no si la carpeta existía. Un `.engram/` recién creado —o con
# `chunks/` vacío— da una foto vacía que es CORRECTA, y confundirla con "no pude sacar la foto"
# haría que el hook se negara a stagear justo en el caso normal del primer sync.
ARCHIVOS_ANTES=$(find "$REPO/.engram" -type f 2>/dev/null | wc -l | tr -d ' ')
ANTES_FOTO=$(foto_engram)

"$ENGRAM_BIN" sync --project "$PROJECT" >/dev/null 2>&1
SYNC_RC=$?
log "engram sync rc=$SYNC_RC"
# 🔴 Un sync que falla deja stdout/stderr vacíos y el commit/push sigue como si nada
# El rc sólo va al log de debug, que nadie mira. No se
# bloquea —el sync no es el trabajo del dev— pero se DICE: si no exportó, la memoria de esta
# sesión no viaja, y eso tiene que ser visible en el momento, no descubrirse tres semanas después.
if [ "$SYNC_RC" != "0" ]; then
  echo "⚠️  tycon: \`engram sync --project $PROJECT\` falló (código $SYNC_RC) — la memoria de esta sesión NO se exportó." >&2
  echo "    El commit/push sigue. Revisalo con: engram sync --project $PROJECT" >&2
fi

# Stagea SÓLO los archivos de `.engram/` que esta invocación creó o modificó. Si no se pudo tomar
# la foto previa, NO se stagea nada: ante la duda, no tocar el índice del dev.
stagear_lo_nuevo() {
  AHORA_FOTO=$(foto_engram)
  # Si HABÍA archivos y la foto previa salió vacía, algo falló al tomarla: NO se stagea. Ante la
  # duda no se toca el índice del dev — es su working tree, no el nuestro.
  if [ "${ARCHIVOS_ANTES:-0}" -gt 0 ] && [ -z "$ANTES_FOTO" ]; then
    log "no se pudo tomar la foto previa de .engram/ — NO se stagea"
    echo "⚠️  tycon: no pude determinar qué generó el sync en .engram/, así que no stageé nada (para no tocar tu índice). Revisá con: git status .engram/" >&2
    return 0
  fi
  # Cada línea de la foto es «<ruta> <suma>»: la ruta es todo menos el último campo. Con `$1` de awk
  # una ruta con espacios se cortaría en el primero y el `git add` fallaría callado: el sync exportaría y
  # nada quedaría preparado.
  NUEVOS=$(comm -13 <(printf '%s\n' "$ANTES_FOTO") <(printf '%s\n' "$AHORA_FOTO") 2>/dev/null | awk 'NF' | sed 's/ [^ ]*$//')
  if [ -z "$NUEVOS" ]; then log "el sync no cambió nada en .engram/"; return 0; fi
  printf '%s\n' "$NUEVOS" | while IFS= read -r f; do
    [ -n "$f" ] && git add -- "$f" 2>/dev/null
  done
  log "staged (sólo lo del sync): $(printf '%s' "$NUEVOS" | tr '\n' ' ')"
}

# ── El cruce del índice contra sus archivos ─────────────────────────────
# `engram sync --import` lee el ÍNDICE, no la carpeta: un chunk sin entrada no existe para las
# demás máquinas y NO da error. Un commit puede entrar con 205 entradas para 210
# archivos sin que se note si el hook sólo valida marcadores y JSON, no completitud. Una entrada
# perdida no vuelve sola.
#
# Qué frena y qué no: frena SÓLO lo que ESTE commit rompe —entradas que HEAD
# declara y el índice a commitear ya no, o chunks nuevos sin entrada—; lo heredado avisa; lo que no
# se pudo medir se dice y deja pasar. Un freno que muerde por algo que rompió otro se apaga en una
# semana. Y no repara: la reparación es un comando que este mensaje nombra, para que el cambio al
# índice lo haga una persona y se vea.
# ¿Parsea como JSON? Con NODE primero: es la dependencia dura del
# cruce y del resto del arnés, así que el camino que corre el 100 % de las veces es el que TODOS los
# casos del banco ejercitan. python3 queda de respaldo. Al revés, sin python3 un índice
# PERFECTO se declararía «NO parsea», no se stagearía nada del sync y el cruce no llegaría a correr —
# y ese camino no lo prueba nadie. Sin ninguno de los dos, se asume válido: el cruce, que exige
# node, va a decir «no pude medir».
json_valido() {
  if command -v "$HNODE" >/dev/null 2>&1; then "$HNODE" -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$1" 2>/dev/null; return $?; fi
  if command -v python3 >/dev/null 2>&1; then python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$1" 2>/dev/null; return $?; fi
  return 0
}

constancia() { # $1 regla · $2 veredicto — es AYUDA, no evidencia: nunca cambia el veredicto.
  [ -f "$LIB_CONSTANCIA" ] && command -v "$HNODE" >/dev/null 2>&1 || return 0
  printf '%s' "$CMD" | "$HNODE" "$LIB_CONSTANCIA" --guard engram-manifest --rule "$1" --verdict "$2" --cmd-stdin >/dev/null 2>&1 || true
}

# $1 = motivo de por qué no se pudo medir. Nunca dice «sano»: no medir y estar bien son distintos.
no_pude_medir() {
  echo "⚠️  tycon: no pude medir si el índice de memoria (.engram/manifest.json) está completo — $1" >&2
  echo "    El commit sigue. Esto NO es «está todo bien»: es «no sé»." >&2
  constancia no-pude-medir aviso
}

cruzar_indice() {
  if ! command -v "$HNODE" >/dev/null 2>&1; then no_pude_medir "node no está en el PATH"; return 0; fi
  if [ ! -f "$LIB_MANIFEST" ]; then no_pude_medir "falta el criterio ($LIB_MANIFEST)"; return 0; fi

  # 🔴 Se cruza LO QUE GIT VA A COMMITEAR, no el disco: el índice de
  # git. Con un índice truncado stageado y el árbol de trabajo sano —o al revés— el cruce del disco
  # mediría otra cosa: el hook quedaría MUDO y el commit entraría con el defecto exacto que existe para
  # frenar (p. ej. 2 entradas para 3 chunks, hook rc=0). Por
  # eso el cruce corre DESPUÉS de `stagear_lo_nuevo`: lo del sync ya está en el índice.
  # La excepción es `-a`/`--all`: ahí git stagea todo lo modificado en el momento del commit, o sea
  # que lo que va a viajar es el DISCO — y se mira el disco.
  if printf '%s' "$CMD_SIN_STRINGS" | grep -qE "${_GIT}commit([[:space:]]+[^[:space:]]+)*[[:space:]]+(-a|--all|-[a-zA-Z]*a[a-zA-Z]*)([[:space:]]|\$)"; then
    log "commit -a: se cruza el árbol de trabajo (es lo que -a va a stagear)"
    CRUCE=$("$HNODE" "$LIB_MANIFEST" cross --repo "$REPO" --json 2>/dev/null)
  else
    CRUCE=$("$HNODE" "$LIB_MANIFEST" cross --repo "$REPO" --staged --json 2>/dev/null)
  fi
  if [ -z "$CRUCE" ]; then no_pude_medir "el criterio no devolvió nada"; return 0; fi
  # 🔴 Que la salida PAREZCA algo no alcanza: tiene que parsear
  # Con una salida corrupta —un stack trace a medias, por ejemplo— cada
  # `jq -r '.x // "default"'` devuelve vacío por su cuenta, ESTADO queda en "" y el flujo caería en la
  # rama de AVISO: el commit pasaría con un mensaje sobre una deriva que nadie midió, y una
  # pérdida real nunca habría llegado al bloqueo. Se valida una vez, acá.
  if ! printf '%s' "$CRUCE" | read_json cross; then
    no_pude_medir "el criterio devolvió algo que no es un resultado válido"; return 0
  fi

  ESTADO=$(printf '%s' "$CRUCE" | read_json text estado "no-medido")
  REGLA=$(printf '%s' "$CRUCE" | read_json text regla "no-pude-medir")
  # 🔴 Un repo con `.engram/` pero SIN un solo archivo de memoria todavía no tiene nada que
  # proteger: se calla y no anota. Sin esto, «no pude medir» saldría en CADA commit de un repo que
  # sólo tiene la carpeta creada. Un aviso que aparece siempre y no se puede accionar es el que
  # enseña a ignorar los otros. Con UN archivo ya hay memoria en juego y el cruce habla.
  # 🔴 `null` NO es `0`: `archivos: null` es «no pude contar los
  # archivos» (la carpeta no está o no se pudo leer) y `0` es «conté y hay cero». Con `// 0` los dos
  # caerían en el silencio, y un índice que declara N entradas sin su carpeta de chunks saldría mudo.
  ARCHIVOS=$(printf '%s' "$CRUCE" | read_json count archivos)
  if [ "$ESTADO" = "no-medido" ] && [ "$ARCHIVOS" = "0" ]; then
    log "repo con .engram/ pero sin archivos de memoria — nada que cruzar"
    return 0
  fi
  if [ "$ESTADO" = "no-medido" ]; then
    no_pude_medir "$(printf '%s' "$CRUCE" | read_json text motivo "sin motivo")"
    return 0
  fi
  if [ "$ESTADO" = "sano" ]; then constancia sano paso; return 0; fi

  NUEVOS=$(printf '%s' "$CRUCE" | read_json list huerfanosNuevos)
  PERDIDAS=$(printf '%s' "$CRUCE" | read_json list perdidas)
  SUELTOS=$(printf '%s' "$CRUCE" | read_json list chunksSinEntrada)
  HEREDADOS=$(printf '%s' "$CRUCE" | read_json list huerfanosHeredados)
  FANTASMAS=$(printf '%s' "$CRUCE" | read_json list fantasmas)
  DUPLICADOS=$(printf '%s' "$CRUCE" | read_json list duplicados)
  ARREGLO="node \"$(cd "$(dirname "$LIB_MANIFEST")" && pwd)/$(basename "$LIB_MANIFEST")\" repair --apply --repo \"$REPO\""

  if [ -z "$NUEVOS" ]; then
    # Deriva que este commit no causó: se avisa con el arreglo y NO se frena.
    # 🔴 Dos motivos distintos para no frenar, y el mensaje NO los mezcla: o se comparó contra la
    # referencia y esto ya venía así, o no se pudo comparar y entonces no se sabe. Decir «ya venía
    # incompleto» cuando no hubo con qué comparar es afirmar algo que no se midió — el mismo pecado
    # que este control persigue. (Ejemplo: el PRIMER commit de memoria de un repo, donde el índice
    # todavía no existe en HEAD.)
    COMPARABLE=$(printf '%s' "$CRUCE" | read_json text contra.legible "false")
    if [ "$COMPARABLE" = "true" ]; then
      echo "⚠️  tycon: el índice de memoria (.engram/manifest.json) de este repo ya venía incompleto — este commit no lo empeora." >&2
    else
      MOTIVO_REF=$(printf '%s' "$CRUCE" | read_json text contra.motivo "sin motivo")
      echo "⚠️  tycon: el índice de memoria (.engram/manifest.json) de este repo no cierra, y NO pude compararlo con el commit anterior ($MOTIVO_REF), así que no sé si lo rompe este commit. No freno." >&2
    fi
    if [ -n "$HEREDADOS" ]; then
      [ "$COMPARABLE" = "true" ] \
        && echo "    archivos sin entrada (de antes): $HEREDADOS" >&2 \
        || echo "    archivos sin entrada: $HEREDADOS" >&2
    fi
    [ -n "$FANTASMAS" ]  && echo "    entradas cuyo archivo no está: $FANTASMAS" >&2
    [ -n "$DUPLICADOS" ] && echo "    entradas declaradas más de una vez: $DUPLICADOS" >&2
    echo "    Esa memoria no la importa ninguna otra máquina. Reparación: $ARREGLO" >&2
    constancia deriva-heredada aviso
    return 0
  fi

  echo "🛑 tycon: el índice de memoria (.engram/manifest.json) que estás por commitear PERDIÓ entradas." >&2
  [ -n "$PERDIDAS" ] && echo "    entradas que HEAD declara y el índice actual ya no, con su archivo todavía en .engram/chunks/: $PERDIDAS" >&2
  [ -n "$SUELTOS" ]  && echo "    archivos nuevos que este commit dejaría sin declarar: $SUELTOS" >&2
  echo "    Si entra así, esa memoria queda en el repo pero ninguna otra máquina la importa — y no da error." >&2
  echo "    Reparación (rescata las entradas exactas de git, nunca inventa, y las deja stageadas):" >&2
  echo "      $ARREGLO" >&2
  echo "    Después volvé a commitear. Escape (queda registrado): TYCON_ENGRAM_MANIFEST_OK=1 git commit …" >&2
  echo "    Más en guides/integrations/engram-workflow.md §manifest" >&2

  # Los dos escapes. Ninguno apaga el sync ni las validaciones de siempre: sólo el bloqueo.
  if [ "${TYCON_ENGRAM_MANIFEST_GUARD:-1}" = "0" ]; then constancia "$REGLA" aviso; return 0; fi
  # El escape pegado al comando, con el mismo criterio POSICIONAL que `_GIT`: vale para ESE commit,
  # no para toda la sesión. Un `echo "TYCON_ENGRAM_MANIFEST_OK=1"` adentro de otro comando no cuenta.
  if printf '%s' "$CMD_SIN_STRINGS" | grep -qE "(^|[;&|({\`!]|&&|\|\|)[[:space:]]*TYCON_ENGRAM_MANIFEST_OK=1[[:space:]]"; then
    constancia "$REGLA" escape; return 0
  fi
  constancia "$REGLA" bloqueo
  exit 2
}

if [ "$ES_COMMIT" = "1" ]; then
    if [ -d "$REPO/.engram" ]; then
      # Un `git add` incondicional dejaría pasar un
      # manifest con MARCADORES DE CONFLICTO adentro — no valida contenido,
      # solo saca el path de la lista de unmerged, y el commit pasaría con JSON roto. Antes de
      # stagear: el manifest no debe traer marcadores Y debe parsear como JSON. Si está roto, NO
      # se agrega (el conflicto queda visible y git bloquea el commit como corresponde) y se avisa
      # a los gritos con la maniobra de recuperación (guides/integrations/engram-workflow.md §manifest).
      MANIFEST="$REPO/.engram/manifest.json"
      if [ -f "$MANIFEST" ] && grep -qE '^(<{7} |={7}$|>{7} )' "$MANIFEST"; then
        log "manifest con marcadores de conflicto — NO se stagea"
        echo "🛑 tycon: .engram/manifest.json tiene MARCADORES DE CONFLICTO — no lo stageo (el commit va a fallar hasta resolver). Recuperación: guides/integrations/engram-workflow.md §manifest. 🔴 NO borres el manifest esperando que se regenere: \`engram sync\` EXPORTA lo pendiente, no reconstruye el índice (medido 2026-08-22 — dejó 1 entrada con 19 chunks en disco, sin dar error)." >&2
        no_pude_medir "el índice tiene marcadores de conflicto (ya avisado arriba)"
      elif [ -f "$MANIFEST" ] && ! json_valido "$MANIFEST"; then
        log "manifest JSON inválido — NO se stagea"
        echo "🛑 tycon: .engram/manifest.json NO parsea como JSON — no lo stageo. Recuperación: guides/integrations/engram-workflow.md §manifest. 🔴 NO borres el manifest: \`engram sync\` no lo reconstruye." >&2
        no_pude_medir "el índice no parsea como JSON (ya avisado arriba)"
      else
        # 🔴 El ORDEN importa: se MIDE acá —después del sync, que es quien escribe la
        # entrada nueva— pero se DECIDE después de stagear. Si se frenara antes del staging, lo que
        # el sync acaba de exportar quedaría sin stagear; y en el reintento la foto previa y la de
        # después salen iguales, así que `stagear_lo_nuevo` no lo agarraría nunca y esa memoria se
        # perdería del commit. Que es, exactamente, el daño que este freno existe para evitar.
        CRUCE_PENDIENTE=1
        stagear_lo_nuevo
      fi
    else
      log "no .engram/ dir to stage"
    fi
    # La decisión, con lo del sync ya stageado. `cruzar_indice` sale 2 si este commit rompe algo.
    [ "${CRUCE_PENDIENTE:-0}" = "1" ] && cruzar_indice
fi

# En un push el hook sale antes del sync — ver la salida temprana junto al matcher.


exit 0
