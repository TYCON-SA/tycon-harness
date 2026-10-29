---
description: Qué versión del arnés tenés, si está bien instalado y si hay una versión nueva (sólo mira, no cambia nada)
allowed-tools: Bash(node:*), Read
---

Contale al usuario, en castellano llano, cómo está el arnés en esta máquina. **Sólo se mira: este comando no instala,
no actualiza ni arregla nada**, aunque encuentre algo para hacer.

**El programa**: `<arnés>/scripts/setup/harness.js`, con `<arnés>` = `$TYCON_GUIDES_DIR` si está definida y, si no,
`~/.claude/tycon-harness` (en Windows, `$env:USERPROFILE\.claude\tycon-harness`; desde la terminal de Claude Code, que
en Windows es Git Bash, `~/.claude/tycon-harness` también sirve). Si el archivo no está, decí que el arnés no está
instalado en esta máquina, y que se instala siguiendo `INSTALL.md` del repo público. No corras nada más.

## Qué corro

Los tres, cada uno **en su llamada**, con `node` y la entrada cerrada (`< /dev/null`), y **mirando el código de salida**
de cada uno:

| Orden | Para qué | Código de salida |
|---|---|---|
| `node <arnés>/scripts/setup/harness.js version` | número de versión, de dónde salió y el canal | 0 bien · otro: no está instalado o su estado no se lee (decí lo que imprimió) |
| `node <arnés>/scripts/setup/harness.js doctor` | si está sano: una línea por pieza; `✓` bien, `!` aviso, rojo lo que falla; la última línea cuenta | 0 sin rojos · 1 algo en rojo |
| `node <arnés>/scripts/setup/harness.js update --check` | si hay versión nueva; **no la baja ni la aplica** | 0 al día · 3 hay nueva (o otra sesión está actualizando: lo dice el texto) · 2 no pudo mirar |

Un `update --check` que sale 2 **no** es «estás al día»: es «no pude preguntar» (sin red, sin permiso sobre el repo).
Decilo así, con el motivo que imprimió.

## Qué le contás

Arrancá con la conclusión, en tres renglones como mucho:

1. **Versión**: el número, y si es la versión bajada (`managed`) o un clon de quien mantiene el arnés (`developer`).
2. **Salud**: «todo en orden» si `doctor` no dejó avisos ni rojos. Si dejó algo, cada uno en una línea: qué pasa,
   dicho sin jerga, y **su arreglo en una línea**, tal como lo sugiere el propio `doctor` (casi siempre es una orden de
   `harness.js`). Primero lo rojo, después los avisos. Las líneas con `✓` no se listan.
3. **Versión nueva**: si `update --check` salió 3, el número que hay y cómo se aplica:
   - Si `doctor` dice `aplicación auto`, se aplica sola en el próximo arranque de una sesión.
   - Si dice `aplicación ask`, o si el usuario la quiere ya: que corra **él** en su terminal
     `npx @tyconsa/harness@latest` (la misma línea en Mac, Linux y Windows): con el arnés instalado pregunta «¿Actualizo?» y
     actualiza. Desde Claude Code se puede escribir con `!` adelante.
   - Si algo sale mal después, `harness.js rollback` vuelve a la versión anterior sin red (lo dice `doctor` cuando hay
     una guardada).

Si el usuario pide el detalle, mostrale la salida de `doctor` tal cual.

## Reglas duras

- **Nunca** corras `update` sin `--check`, ni `apply`, `install`, `startup`, `rollback`, `relocate`, `migrate`, `link`,
  `layer` ni `uninstall`, aunque el usuario lo pida desde este comando: le das la orden para que la corra él.
- **Nunca** `doctor --fetch`: escribe en el clon. El `doctor` de este comando va sin opciones.
- No abras ni muestres archivos de configuración del arnés (`~/.tycon/config.json` puede traer credenciales). Si hace
  falta un valor, `node <arnés>/scripts/lib/tycon-config.js explain` lo dice sin secretos.
- Lo que ninguna de las tres órdenes dijo no se afirma: si una no pudo correr, lo que ella iba a decir queda «sin mirar».
