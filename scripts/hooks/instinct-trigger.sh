#!/usr/bin/env bash
# instinct-trigger.sh — SessionStart hook que dispara el observer
# si pasaron >12h desde la última corrida.
#
# Diseño:
#   - Throttle vía timestamp en ~/.claude/instinct-observer.last
#   - Spawn DETACHED (nohup &) → no bloquea el inicio de sesión
#   - Fail-open: cualquier error exit 0 silencioso
#   - Opt-in: TYCON_INSTINCT_OBSERVER != "1" → exit 0
#
# El observer mismo (scripts/instincts/instinct-observer.js) se encarga de:
#   - Leer JSONL local de esta máquina
#   - Llamar Haiku via `claude` CLI
#   - Escribir pending/ + Telegram notify
#
# Si querés correr manual (sin esperar el throttle):
#   node ~/.claude/tycon-harness/scripts/instincts/instinct-observer.js --notify


# ── Reparación de la línea de arranque del arnés ────────────────────────────────────
# Este hook es uno de los POCOS que una instalación vieja del arnés sí tiene registrados, y su
# código sí se actualiza con el `git pull` que esas máquinas sí hacen. Por eso entra por acá el
# reparador: el arreglo de "tu línea de arranque no llama al instalador" no puede viajar por el
# instalador que no se llama. Sale en silencio y en un grep si ya está sano.
# Off: TYCON_NO_BOOTSTRAP_HEAL=1
_heal="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
for _c in "$_heal/hooks/harness-bootstrap-heal.sh" "$_heal/harness-bootstrap-heal.sh"; do
  [ -f "$_c" ] && { bash "$_c" || true; break; }
done
unset _heal _c


set -u

# Opt-in: solo en máquinas marcadas como observer
if [[ "${TYCON_INSTINCT_OBSERVER:-0}" != "1" ]]; then
  exit 0
fi

THROTTLE_SECONDS="${TYCON_INSTINCT_THROTTLE_SECONDS:-43200}"  # default 12h
LAST_FILE="$HOME/.claude/instinct-observer.last"
TYCON_GUIDES="${TYCON_GUIDES_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"   # este hook vive en el arnés: su ubicación
OBSERVER_SCRIPT="$TYCON_GUIDES/scripts/instincts/instinct-observer.js"
DIRS_SCRIPT="$TYCON_GUIDES/scripts/instincts/instinct-dirs.js"           # la pieza que sabe dónde se escribe

# Repo / script disponibles?
[[ -f "$OBSERVER_SCRIPT" ]] || exit 0

# Throttle check
NOW=$(date +%s)
if [[ -f "$LAST_FILE" ]]; then
  LAST=$(cat "$LAST_FILE" 2>/dev/null || echo "0")
  DELTA=$((NOW - LAST))
  if [[ $DELTA -lt $THROTTLE_SECONDS ]]; then
    # Aún no toca correr
    exit 0
  fi
fi

# Update timestamp ANTES de spawn (evita doble-dispatch si SessionStart corre 2x rápido)
mkdir -p "$(dirname "$LAST_FILE")"
echo "$NOW" > "$LAST_FILE"

# Spawn detached. El SessionStart no espera al observer.
# El registro va adonde el observador escribe: `inbox/instincts/` del árbol si el árbol trae su buzón; si no, la casa de
# la persona. Lo decide instinct-dirs.js, que crea ese lugar y el archivo; este hook NUNCA arma la ruta ni hace `mkdir`
# en el árbol (en un arnés instalado crearía una carpeta que nadie le trajo). Se pregunta recién acá, después
# del freno y del sello: un arranque que no lanza nada no corre node ni crea nada.
# Si la pieza no está, falla, o el archivo no se puede abrir, el observador corre igual y su registro va a uno de
# RESERVA al lado del sello (la carpeta de usuario, nunca el árbol), con el motivo en la primera línea: sin eso el
# grabador puede quedar sin grabar por meses sin dejar una sola línea (lo que diga el observador —«no sé dónde
# escribir»— se pierde con el registro). Sólo si tampoco ése se puede abrir, el registro se descarta.
RESERVA_LOG="${LAST_FILE%.last}.fallback.log"
LOG_FILE=""
# el Node del arnés si está; si no, el del PATH. No cambia el PATH.
# con el bash de la Mac (3.2) y `set -e`, un `.` que no encuentra el archivo corta el guion aunque lleve `||`: se mira antes
_hn="$TYCON_GUIDES/scripts/lib/harness-node.sh"
{ [ -f "$_hn" ] && . "$_hn" 2>/dev/null; } || harness_node_bin() { echo node; }
HNODE="$(harness_node_bin)"
if [[ -f "$DIRS_SCRIPT" ]]; then
  DIRS_OUT="$("$HNODE" "$DIRS_SCRIPT" --prepare-log 2>&1)" && LOG_FILE="${DIRS_OUT##*$'\n'}"
else
  DIRS_OUT="falta $DIRS_SCRIPT (la pieza que dice dónde se escribe)"
fi
if [[ -z "$LOG_FILE" ]] || ! : >> "$LOG_FILE" 2>/dev/null; then
  MOTIVO="${DIRS_OUT:-la pieza no dijo nada}"
  [[ -n "$LOG_FILE" ]] && MOTIVO="no pude abrir $LOG_FILE"
  MOTIVO="${MOTIVO//$'\n'/ · }"   # el motivo, en un renglón
  LOG_FILE="$RESERVA_LOG"
  if ! printf '%s instinct-trigger: el registro del observador va acá, de reserva — %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$MOTIVO" >> "$LOG_FILE" 2>/dev/null; then
    LOG_FILE=/dev/null
  fi
fi

# nohup + & + redirect = totally detached
nohup "$HNODE" "$OBSERVER_SCRIPT" --notify >> "$LOG_FILE" 2>&1 &
disown 2>/dev/null || true

exit 0
