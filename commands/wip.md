---
description: El trabajo en curso de esta máquina en una tabla — qué hace cada sesión, en qué paso va y a qué hora termina (sólo mira, no cambia nada)
allowed-tools: Bash(node:*)
---

Mostrale al usuario el trabajo en curso de esta máquina. **Sólo se mira: este comando no limpia, no adopta ni corta
nada**, aunque la salida diga cómo hacerlo.

**El programa**: `<arnés>/scripts/tools/work-in-progress.js`, con `<arnés>` = `$TYCON_GUIDES_DIR` si está definida y, si no,
`~/.claude/tycon-harness` (en Windows, `$env:USERPROFILE\.claude\tycon-harness`; desde la terminal de Claude Code, que
en Windows es Git Bash, `~/.claude/tycon-harness` también sirve). Si el archivo no está, decí que el arnés instalado no
trae el comando todavía y que se actualiza con `/tycon-harness`. No corras nada más.

## Qué corro

`node <arnés>/scripts/tools/work-in-progress.js < /dev/null`, una sola vez, **mirando el código de salida**:

| Código | Qué significa |
|---|---|
| 0 | la tabla salió (aunque haya cosas que no se pudieron leer: van al pie, con su motivo) |
| 2 | no existe la carpeta de estado del pipeline en esta máquina: decilo con lo que imprimió |
| otro | el programa falló: mostrá el error tal cual |

## Qué le mostrás

La salida **tal cual**: la tabla (trabajo, estado, fin estimado, sesión), la línea de las sesiones libres, y si
aparecen, «Quedaron a medio camino» y «No se pudo leer». No agregues listas de terminados, ni resúmenes de lo que hace
cada sesión, ni horas que la tabla no trae: «sin datos» se deja como está.

Si hay trabajo a medio camino, la salida trae el comando para limpiar cada uno. **No lo corras**: limpiar lo decide
quien lee.
