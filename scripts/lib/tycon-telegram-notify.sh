#!/usr/bin/env bash
# tycon-telegram-notify.sh — avisar por Telegram desde CUALQUIER herramienta, sin escuchar nada.
#
# POR QUÉ EXISTE
# El canal de Telegram del arnés es un plugin de Claude Code: del lado de Codex no hay tool, ni
# siquiera vía MCP, y hasta hoy eso figuraba como asimetría declarada en el inventario. Esto la
# cierra para la única dirección que el equipo realmente usa desde un agente: **avisar** (Claude o
# Codex → Telegram) cuando termina una tarea larga, cuando algo queda esperando input, o cuando el
# dev lo pide. La dirección inversa (Telegram → agente) NO se implementa acá, y no por falta de
# ganas: ver el párrafo siguiente.
#
# 🔴 POR QUÉ ES SOLO SALIDA — y por qué eso no es una limitación, es el diseño
# Recibir mensajes de Telegram exige *long-polling* (`getUpdates`), y **cada update lo recibe UN
# solo consumidor**: si dos procesos consultan con el mismo bot, Telegram le devuelve `409 Conflict`
# al perdedor. Ese incidente ya ocurrió una vez con dos launchers del mismo plugin (uno huérfano,
# ppid=1, robándole los updates al vivo — troubleshooting en el bloque de Telegram del CLAUDE.md).
# Un segundo consumidor "para Codex" reproduciría exactamente esa falla y se llevaría puesto el
# canal del lado Claude, que hoy funciona.
#
# Mandar, en cambio, es un POST suelto a `sendMessage`: no abre sesión, no compite con nadie, no
# puede causar un 409. De ahí la forma de esta pieza — un script que se invoca y termina, no un
# servidor que queda escuchando. Es la asimetría aceptada a propósito: **las dos herramientas
# avisan igual; recibir sigue siendo exclusivo de Claude Code con `--channels`.**
#
# USO
#   tycon-telegram-notify.sh "texto del aviso"                 # manda; imprime el message_id
#   tycon-telegram-notify.sh --edit <message_id> "texto nuevo" # reescribe un aviso ya mandado
#   tycon-telegram-notify.sh --chat-id <id> "texto"            # a otro destinatario
#   tycon-telegram-notify.sh --dry-run "texto"                 # no manda: imprime qué mandaría
#
# El message_id que imprime es lo que habilita el patrón del arnés para tareas largas: UN aviso por
# tanda, actualizado con --edit, en vez de una catarata de mensajes nuevos.
#
# CONFIGURACIÓN (nada se hardcodea, nada se commitea)
#   Token:  $TELEGRAM_BOT_TOKEN, o la línea TELEGRAM_BOT_TOKEN= de
#           ~/.claude/channels/telegram/.env (el mismo archivo que ya usa el plugin, permisos 600).
#   Chat:   $TYCON_TELEGRAM_CHAT_ID, o el primer id de `allowFrom` en
#           ~/.claude/channels/telegram/access.json.
#
# SALIDA: 0 mandado · 2 error de uso · 3 no se pudo mandar (falta config, o Telegram rechazó).
# El 3 es deliberado y no es fail-open: quien avisa tiene que poder distinguir "avisé" de "creí que
# avisaba". Un aviso perdido en silencio es peor que ninguno — el agente que lo llame decide si eso
# corta su flujo (casi nunca debería).

set -uo pipefail

CHANNEL_DIR="${TYCON_TELEGRAM_DIR:-$HOME/.claude/channels/telegram}"
API="${TYCON_TELEGRAM_API:-https://api.telegram.org}"
DRY_RUN=0
EDIT_ID=""
CHAT_ID="${TYCON_TELEGRAM_CHAT_ID:-}"

die_usage() { echo "uso: $(basename "$0") [--edit <message_id>] [--chat-id <id>] [--dry-run] \"texto\"" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --edit)     EDIT_ID="${2:-}"; [ -n "$EDIT_ID" ] || die_usage; shift 2 ;;
    --chat-id)  CHAT_ID="${2:-}"; [ -n "$CHAT_ID" ] || die_usage; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  sed -n '2,45p' "$0"; exit 0 ;;
    --)         shift; break ;;
    -*)         echo "opción desconocida: $1" >&2; die_usage ;;
    *)          break ;;
  esac
done

TEXT="${1:-}"
[ -n "$TEXT" ] || die_usage

# ── Token ────────────────────────────────────────────────────────────────────────────────────
TOKEN="${TELEGRAM_BOT_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -r "$CHANNEL_DIR/.env" ]; then
  # Se lee sólo la línea que interesa y sin `source`, para no ejecutar lo que haya en el archivo.
  TOKEN="$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$CHANNEL_DIR/.env" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' \r')"
fi
if [ -z "$TOKEN" ]; then
  echo "⚠ telegram-notify: no hay token (ni \$TELEGRAM_BOT_TOKEN ni $CHANNEL_DIR/.env) — NO se mandó el aviso." >&2
  exit 3
fi

# ── Destinatario ─────────────────────────────────────────────────────────────────────────────
if [ -z "$CHAT_ID" ] && [ -r "$CHANNEL_DIR/access.json" ]; then
  CHAT_ID="$(python3 -c "
import json,sys
try:
    d=json.load(open('$CHANNEL_DIR/access.json'))
    a=d.get('allowFrom') or []
    print(str(a[0]) if a else '')
except Exception: print('')
" 2>/dev/null)"
fi
if [ -z "$CHAT_ID" ]; then
  echo "⚠ telegram-notify: no hay destinatario (ni \$TYCON_TELEGRAM_CHAT_ID ni allowFrom en access.json) — NO se mandó el aviso." >&2
  exit 3
fi

METHOD="sendMessage"
[ -n "$EDIT_ID" ] && METHOD="editMessageText"

if [ "$DRY_RUN" -eq 1 ]; then
  # El token NUNCA se imprime, ni siquiera en dry-run: esta salida termina en logs y en el banco.
  echo "DRY-RUN método=$METHOD chat_id=$CHAT_ID${EDIT_ID:+ message_id=$EDIT_ID} texto=${TEXT}"
  exit 0
fi

RESP="$(curl -sS -m 15 -X POST "$API/bot$TOKEN/$METHOD" \
  --data-urlencode "chat_id=$CHAT_ID" \
  --data-urlencode "text=$TEXT" \
  ${EDIT_ID:+--data-urlencode "message_id=$EDIT_ID"} 2>&1)"

# La respuesta puede traer el token de vuelta en un mensaje de error de curl (URL completa) — se
# tapa antes de imprimir nada.
SAFE_RESP="${RESP//$TOKEN/<token>}"

if printf '%s' "$RESP" | grep '"ok":true' >/dev/null; then
  MSG_ID="$(printf '%s' "$RESP" | python3 -c "
import json,sys
try: print(json.load(sys.stdin)['result']['message_id'])
except Exception: print('')
" 2>/dev/null)"
  echo "${MSG_ID:-ok}"
  exit 0
fi

echo "⚠ telegram-notify: Telegram rechazó el envío — $SAFE_RESP" >&2
exit 3
