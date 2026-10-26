---
description: El estado de la máquina para la sesión coordinadora — quién trabaja contra el tope, quién espera, el pase adversarial en vuelo, las firmas pendientes y las sesiones sin nombre (sólo mira, no cambia nada)
allowed-tools: Bash(node:*)
---

Mostrale al usuario el estado de la máquina para coordinar sus sesiones. **Sólo se mira: este comando no abre, no
designa, no firma ni corta nada**, aunque la salida diga cómo hacerlo.

**El programa**: `<arnés>/scripts/tools/coordination.js`, con `<arnés>` = `$TYCON_GUIDES_DIR` si está definida y, si no,
`~/.claude/tycon-harness` (en Windows, `$env:USERPROFILE\.claude\tycon-harness`; desde la terminal de Claude Code, que
en Windows es Git Bash, `~/.claude/tycon-harness` también sirve). Si el archivo no está, decí que el arnés instalado no
trae el comando todavía y que se actualiza con `/tycon-harness`. No corras nada más.

## Qué corro

`node <arnés>/scripts/tools/coordination.js coordinate < /dev/null`, una sola vez, **mirando el código de salida**:

| Código | Qué significa |
|---|---|
| 0 | esta sesión es la coordinadora designada: salió el estado de la máquina |
| 1 | esta sesión no coordina (no está designada, la organización no usa una coordinadora, o es Codex): la salida dice por qué y qué hace falta |
| otro | el programa falló: mostrá el error tal cual |

## Qué le mostrás

- **Código 0**: la salida tal cual, y después leé `<arnés>/guides/coordination.md`: son las reglas con las que la
  coordinadora decide, abre sesiones, da turnos y pide firmas. Si la línea «Sin nombre puesto por una persona» trae
  nombres, pedile al dueño que les ponga nombre con `/rename` en cada una.
- **Código 1**: la salida tal cual, y no sigas. Si dice que hace falta la frase del dueño para designar esta sesión,
  **no la escribas ni designes nada**: la escribe el dueño en este chat, y recién con su cita se corre
  `designate-relay`.
