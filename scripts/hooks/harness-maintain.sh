#!/usr/bin/env bash
# harness-maintain.sh — hook de SessionStart (lado Codex) que dispara el MANTENIMIENTO del
# arnés en segundo plano y termina al instante.
#
# Por qué un envoltorio y no el instalador directo (2026-08-23, pedido del dev "Codex puede
# ser el principal"): install-tycon-hooks.sh tarda segundos-minutos (pull, suites, despliegues)
# y colgado directo del arranque BLOQUEARÍA cada sesión de codex; además el gate del banco
# exige casos por hook y el instalador completo no es testeable como caso (toca $HOME real).
# El envoltorio es trivial de asertar: termina rápido, exit 0 pase lo que pase, y dispara lo
# que se le dice — TYCON_MAINTAIN_CMD lo hace hermético para el banco.
#
# Opt-out: el propio instalador respeta TYCON_NO_AUTOINSTALL=1; acá no se duplica la lógica.
set -u

CMD="${TYCON_MAINTAIN_CMD:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/install-tycon-hooks.sh}"   # este hook vive en el arnés: su ubicación (story 8.3)
if [[ -f "$CMD" ]]; then
  # Doble fork: el subshell muere al instante y el instalador queda re-parentado a launchd/init,
  # FUERA del grupo de procesos de la sesión de codex. Sin esto, cerrar la sesión mataba al
  # instalador a mitad (SIGKILL, sin trap) y dejaba su lock huérfano 10 min (medido 2026-08-23).
  ( nohup bash "$CMD" >/dev/null 2>&1 & ) >/dev/null 2>&1
fi
# Sin output y exit 0 SIEMPRE: un hook de arranque que falla o bloquea es peor que uno que
# no corre — el mantenimiento perdido lo cobra la paridad en el próximo arranque.
exit 0
