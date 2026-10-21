#!/usr/bin/env bash
# telegram-zombie-sweep.sh — SessionStart hook: cierra los bots de Telegram HUÉRFANOS del plugin
# oficial de Claude Code (claude-plugins-official/telegram).
#
# El plugin levanta por sesión un lanzador
# `bun run --cwd <plugin> ... start` + un hijo `bun server.ts` que hace long-polling a Telegram.
# Cuando el `claude` que lo lanzó muere, el lanzador NO siempre muere con él: queda huérfano
# (ppid=1), pelea el token con el bot válido (409 Conflict), pierde mensajes y quema CPU
# (varios zombies de horas o días, con mucho CPU cada uno). El plugin solo mata UN poller viejo (el
# de bot.pid) — con tres, quedan dos. Esto es de Anthropic; este hook es la mitigación nuestra.
#
# Criterio (el único seguro con varias sesiones vivas): lanzador del plugin con ppid=1
# ⟹ el CLI que lo lanzó murió ⟹ matar lanzador + hijos. `bot.pid` NO sirve solo: con dos sesiones
# vivas, el bot más viejo es legítimo. `bun server.ts` sueltos (ppid=1) se matan solo si su cwd
# es el plugin (lsof) — sin lsof no se tocan.
#
# Fail-open total: sin plugin en la máquina → exit 0 silencioso. Habla SOLO si mató algo (stdout
# se inyecta como contexto en SessionStart). Off: TYCON_TG_ZOMBIE_SWEEP=0.
#
# Banco: TYCON_TZS_PS_FILE=<archivo con `pid ppid command`> reemplaza a `ps`;
#        TYCON_TZS_DRY_RUN=1 imprime en vez de matar.
set -u
[[ "${TYCON_TG_ZOMBIE_SWEEP:-1}" == "0" ]] && exit 0
PLUGIN_DIR="$HOME/.claude/plugins/cache/claude-plugins-official/telegram"
[[ -d "$PLUGIN_DIR" ]] || exit 0

DRY="${TYCON_TZS_DRY_RUN:-0}"
if [[ -n "${TYCON_TZS_PS_FILE:-}" ]]; then
  PS_TABLE="$(cat "$TYCON_TZS_PS_FILE" 2>/dev/null)"
else
  PS_TABLE="$(ps -axo pid=,ppid=,command= 2>/dev/null)"
fi
[[ -n "$PS_TABLE" ]] || exit 0

BOT_PID="$(cat "$HOME/.claude/channels/telegram/bot.pid" 2>/dev/null | tr -dc '0-9')"

# Lanzadores huérfanos: ppid=1 + comando del plugin de ESTE home (no matchea el de otro sandbox).
ORPHANS="$(printf '%s\n' "$PS_TABLE" | awk -v dir="$PLUGIN_DIR" '$2==1 && index($0, dir) && /bun run/ {print $1}')"

KILLED=()
for L in $ORPHANS; do
  KIDS="$(printf '%s\n' "$PS_TABLE" | awk -v p="$L" '$2==p {print $1}')"
  for P in $L $KIDS; do
    [[ -n "$BOT_PID" && "$P" == "$BOT_PID" ]] && continue   # nunca el poller válido
    if [[ "$DRY" == "1" ]]; then KILLED+=("$P"); continue; fi
    kill -9 "$P" 2>/dev/null && KILLED+=("$P")
  done
done

# server.ts sueltos (ppid=1, sin lanzador): solo si lsof confirma que su cwd es el plugin.
if command -v lsof >/dev/null 2>&1 && [[ -z "${TYCON_TZS_PS_FILE:-}" ]]; then
  STRAYS="$(printf '%s\n' "$PS_TABLE" | awk '$2==1 && /bun server\.ts/ {print $1}')"
  for S in $STRAYS; do
    [[ -n "$BOT_PID" && "$S" == "$BOT_PID" ]] && continue
    CWD_S="$(lsof -a -p "$S" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    case "$CWD_S" in
      "$PLUGIN_DIR"*)
        if [[ "$DRY" == "1" ]]; then KILLED+=("$S"); else kill -9 "$S" 2>/dev/null && KILLED+=("$S"); fi ;;
    esac
  done
fi

if [[ ${#KILLED[@]} -gt 0 ]]; then
  VERB="cerrados"; [[ "$DRY" == "1" ]] && VERB="a cerrar (dry-run)"
  echo "🧹 tycon: ${#KILLED[@]} proceso(s) de bots de Telegram huérfanos $VERB (pids: ${KILLED[*]}) — bug del plugin oficial. Off: TYCON_TG_ZOMBIE_SWEEP=0."
fi
exit 0
