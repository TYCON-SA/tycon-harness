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

La salida **tal cual**: la tabla (trabajo, estado, fin estimado, sesión, carpeta), la línea de las sesiones libres, y si
aparecen, «Quedaron a medio camino» y «No se pudo leer». No agregues listas de terminados, ni resúmenes de lo que hace
cada sesión, ni horas que la tabla no trae: «sin datos» se deja como está.

«Entrando a los repos» es una story que cerró el pipeline y espera que entren sus pedidos (la CI, la cola, un
pedido en borrador): su sesión sigue ocupada. Se ve también después del cierre, cuando el pipeline ya borró su
marcador: el programa lee el último cierre de la sesión (de las últimas 24 h). Para saberlo, pregunta a GitHub o a
Azure DevOps (sólo lee, con topes de unos segundos); si no pudo, lo dice al pie en un solo renglón y la sesión no cuenta
como libre. Un pedido que el servidor marca en conflicto sale con «(choca con main)»: hay que traerle main antes de que
entre. Cada repo se lee una vez, aunque la story haya tocado muchas carpetas suyas, y sólo si es de la story: el de su
corrida, o uno en la misma rama o en una que la nombra (una carpeta compartida que hoy está en la rama de otra story no
cuenta). Pasada la hora estimada, el fin dice «esperando entrar desde <hora>»: no está atrasada, espera la CI o la cola.

Cada sesión tiene una sola fila. Con una story en curso o entrando, la story es lo principal, con su estado; lo otro
que hace la sesión va en el estado como «mientras tanto»: su arreglo rápido (`adhoc`), su nota (`doing`), o el repo y
la rama de lo último que tocó, si no es de la story. Una story cerrada hace más de 24 h no esconde su sesión: sale con
lo que hace hoy, o libre.

«Anotado por la sesión» es lo que una sesión sin story dijo que hace, si quiere corregir lo que el /wip deduce, con
`marker.js doing "<qué hago>"` (otro `doing` lo reemplaza; `marker.js doing clear` lo borra al terminar).
La nota no es un permiso: no deja editar código sin pipeline, como sí lo hace `adhoc`. Pasada 1 h sin tocarse, la fila pregunta
si terminó.

Los agentes internos de otras sesiones (un examen o un pase que lanza su propio Claude, en la carpeta temporal y sin
nombre puesto) no tienen fila: al pie va un renglón con cuántos hay.

«Trabajando sin pipeline» es una sesión que está haciendo algo fuera de una story (un video, una medición, una story
que todavía no armó su marcador): su archivo de sesión dice que está ocupada, o tuvo actividad hace menos de 5
minutos. Qué hace sale de los archivos que tocó en las últimas 3 h (el último que no sea de su carpeta temporal ni de
la memoria): el repo, y su rama o la primera carpeta dentro del repo; la story, de una rama `story/<id>…` o de un
archivo `specs/story-<id>-…`. Sin ninguno, sale la carpeta donde arrancó, o «no se ve qué hace» con el motivo si esa
carpeta está en su rama principal. Una nota con `doing` corrige lo deducido.
«Libres» son las que no hacen nada hace más de 5 minutos; «Sin uso hace más de 3 h», las que siguen abiertas pero
nadie usa. La última actividad sale de las fechas del archivo de sesión y de la fecha de su conversación guardada.

**Sesión** es el nombre de su archivo de sesión, el mismo que usan los mensajes entre sesiones (`-n` al abrirla o
`/rename`). Sin nombre en el archivo, el último `/rename` de su conversación guardada; en Codex, el nombre de su
sesión; sin ninguno, el id corto. De la conversación el programa lee sólo ese renglón del título, al final del
archivo: nada más de lo que dice una conversación se lee ni se guarda. Con `--json`, cada fila suma `sid`, `status` y
`nameSource` (`user` si el nombre lo puso una persona, `derived` si lo puso la herramienta).

**Carpeta** es dónde edita cada sesión: la raíz del repo o del worktree de su último archivo tocado o, sin uno, la
carpeta donde arrancó, con `~` en lugar de la carpeta personal. El repo, la rama y el servidor de cada carpeta salen de
sus archivos de git, sin lanzar git.

Si hay trabajo a medio camino, la salida trae el comando para limpiar cada uno. **No lo corras**: limpiar lo decide
quien lee.
