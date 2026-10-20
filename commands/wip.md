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

«Entrando a los repos» es una story que cerró el pipeline y espera que entren sus pedidos (la CI, la cola, un
pedido en borrador): su sesión sigue ocupada. Se ve también después del cierre, cuando el pipeline ya borró su
marcador: el programa lee el último cierre de la sesión (de las últimas 24 h). Para saberlo, pregunta a GitHub o a
Azure DevOps (sólo lee, con topes de unos segundos); si no pudo, lo dice al pie en un solo renglón y la sesión no cuenta
como libre. Un pedido que el servidor marca en conflicto sale con «(choca con main)»: hay que traerle main antes de que
entre. Cada repo se lee una vez, aunque la story haya tocado muchas carpetas suyas.

«Anotado por la sesión» es lo que una sesión sin story dijo que hace, con `marker.js doing "<qué hago>"` (otro
`doing` lo reemplaza; `marker.js doing clear` lo borra al terminar). La nota no es un permiso: no deja editar código
sin pipeline, como sí lo hace `adhoc`. Pasada 1 h sin tocarse, la fila pregunta si terminó.

Los agentes internos de otras sesiones (un examen o un pase que lanza su propio Claude, en la carpeta temporal y sin
nombre puesto) no tienen fila: al pie va un renglón con cuántos hay.

«Trabajando sin pipeline» es una sesión que está haciendo algo fuera de una story (un video, una medición, una story
que todavía no armó su marcador): su archivo de sesión dice que está ocupada, o tuvo actividad hace menos de 5 minutos.
Si su carpeta está en una rama de story, la fila la nombra. «Libres» son las que no hacen nada hace más de 5 minutos;
«Sin uso hace más de 3 h», las que siguen abiertas pero nadie usa. La última actividad sale de las fechas del archivo
de sesión y de la fecha de su conversación guardada: el programa no lee lo que dice ninguna conversación.

Si hay trabajo a medio camino, la salida trae el comando para limpiar cada uno. **No lo corras**: limpiar lo decide
quien lee.
