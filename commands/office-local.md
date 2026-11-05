---
description: La oficina de esta máquina en la página local, aunque la máquina esté aprobada en el sitio (sólo mira, no cambia nada)
allowed-tools: Bash(node:*)
---

Abrile al usuario la oficina de esta máquina en la página local, la misma que abre `/office` sin sitio. **Sólo se mira:
este comando no limpia, no adopta ni corta nada.**

**El programa**: `<arnés>/scripts/tools/office.js`, con `<arnés>` = `$TYCON_GUIDES_DIR` si está definida y, si no,
`~/.claude/tycon-harness` (en Windows, `$env:USERPROFILE\.claude\tycon-harness`; desde la terminal de Claude Code, que
en Windows es Git Bash, `~/.claude/tycon-harness` también sirve). Si el archivo no está, decí que el arnés instalado no
trae el comando todavía y que se actualiza con `/tycon-harness`. No corras nada más.

## Qué corro

`node <arnés>/scripts/tools/office.js --open --local < /dev/null`, una sola vez, **mirando el código de salida**:

| Código | Qué significa |
|---|---|
| 0 | la oficina local quedó abierta en el navegador; la salida dice su dirección, o que ya estaba abierta |
| 1 | no pudo arrancar el proceso local: decilo con el motivo que imprimió |
| otro | el programa falló: mostrá el error tal cual |

## Qué le mostrás

Una línea: la dirección local que imprimió y que la página se actualiza sola mientras esté abierta. Si dice «ya estaba
abierta», es la misma de antes. No resumas lo que dice la página: para eso está `/wip`.

Lo que trae la página y cómo se actualiza está en `/office`: es la misma página.
