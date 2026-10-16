#!/usr/bin/env bash
# packs-update-keeps-pieces.test.sh — la prueba de actualización de los paquetes, en Mac (story 8.41 · T11-T16, T42).
#
# Instala en una carpeta de usuario de laboratorio una versión del arnés siguiendo la página pública, toma la lista de
# piezas que usa la máquina (cada skill y agente enlazado, cada guía del índice, cada control de commit, cada hook
# registrado y el set de revisores de dos repos de juguete), publica la versión nueva —que muda una skill y un agente del
# núcleo a un paquete—, abre sesiones y compara. Con la capa del equipo las dos listas son iguales pieza por pieza; sin
# la capa (ningún paquete activo) salen sólo las del paquete y se dice en una línea. Es el mismo ensayo que corre el 182
# en Windows (escenario `update`): éste lo corre sobre esta Mac, con el programa de verdad.
#
# Necesita git y pwsh (la página pide PowerShell 7); sin ellos se saltea con constancia. Tarda unos minutos.
# Para ver las dos listas: TYCON_WINDOWS_GUIDED_KEEP=<carpeta> bash scripts/tests/packs-update-keeps-pieces.test.sh
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
env -u NODE_TEST_CONTEXT node --test --test-reporter=tap --test-name-pattern='^PacksUpdate_' "$RAIZ/scripts/tests/windows-guided-lab.test.js"
