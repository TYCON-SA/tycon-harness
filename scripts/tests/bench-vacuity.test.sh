#!/usr/bin/env bash
# bench-vacuity.test.sh — corre el auditor de vacuidad del banco.
#
# 🔴 SEMANAL (lista BASH_TESTS_SEMANALES del instalador): tarda 135 s medidos
# —103 casos × 2 corridas— y corriendo a diario de fondo le saca la máquina al arranque de la
# siguiente sesión (la extensión de VS Code se rinde a los 60 s). Lo que caza es un caso vacuo
# NUEVO, y un caso entra por commit, no por día: una vez por semana alcanza.
#
# La pregunta que contesta: ¿los casos del banco prueban lo que dicen probar? Cada caso
# afirmativo se re-corre con su control reemplazado por un script que NO HACE NADA — si pasa
# igual, es vacuo: lo que asserta lo produce su propio setup (por ejemplo, asertar sobre un archivo
# que el hook jamás escribe). Sin esta corrida, el próximo
# caso vacuo entra y se cuenta como cobertura hasta la próxima auditoría manual.
#
# 🔴 Sin pipes sobre el comando: el exit code REAL es el veredicto (un `| tail` lo enmascara —
# regla 5 de test-execution-discipline).
set -u
TCG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node "$TCG/scripts/controls-bench/vacuity-audit.js" --selftest || exit 1
node "$TCG/scripts/controls-bench/vacuity-audit.js"
