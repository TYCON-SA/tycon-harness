#!/usr/bin/env bash
# bench-silence.test.sh — el banco no le grita sus propias alarmas al agente que mide.
#
# El defecto que cierra: corridas de advisors bajo Codex que mueren con exit≠0 y el banco las
# etiqueta "inestables" (el revisor cambia de opinión). No es el revisor: ocurre si `advisor-runner.js`
# le pasa el entorno pelado a `codex` mientras que a `claude`, dos líneas más arriba, le pasa
# TYCON_EVAL_SANDBOX=1. Sin ese silenciador, los hooks de arranque del arnés disparan DENTRO del
# advisor y le inyectan "🔴 controls-bench EN ROJO — Correr: node .../runner.js". El advisor va y
# lo corre: bajo sandbox de solo lectura eso es permiso denegado; con el tope de tiempo del caso,
# una interrupción a los ~5 min. Un banco en rojo se mantiene en rojo solo.
#
# La auditoría es estática y gratis (no gasta una sola llamada al modelo) — por eso corre a diario
# y no como caso del banco.
#
# 🔴 Sin pipes sobre el comando: el exit code REAL es el veredicto (regla 5 de
# test-execution-discipline — un `| tail` enmascara el rojo).
set -u
TCG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node "$TCG/scripts/controls-bench/silence-audit.js" --selftest || exit 1
node "$TCG/scripts/controls-bench/silence-audit.js"
