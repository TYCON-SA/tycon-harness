---
description: El trabajo en curso de esta máquina dibujado como una oficina en 3D — una persona por sesión, con su estado, su hora de fin y sus pasos (sólo mira, no cambia nada)
allowed-tools: Bash(node:*)
---

Abrile al usuario la oficina del trabajo en curso de esta máquina. **Sólo se mira: este comando no limpia, no adopta ni
corta nada.**

**El programa**: `<arnés>/scripts/tools/office.js`, con `<arnés>` = `$TYCON_GUIDES_DIR` si está definida y, si no,
`~/.claude/tycon-harness` (en Windows, `$env:USERPROFILE\.claude\tycon-harness`; desde la terminal de Claude Code, que
en Windows es Git Bash, `~/.claude/tycon-harness` también sirve). Si el archivo no está, decí que el arnés instalado no
trae el comando todavía y que se actualiza con `/tycon-harness`. No corras nada más.

## Qué corro

`node <arnés>/scripts/tools/office.js --open < /dev/null`, una sola vez, **mirando el código de salida**:

| Código | Qué significa |
|---|---|
| 0 | la oficina quedó abierta en el navegador; la salida dice su dirección, o que ya estaba abierta |
| 1 | no pudo arrancar el proceso local: decilo con el motivo que imprimió |
| otro | el programa falló: mostrá el error tal cual |

## Qué le mostrás

Una línea: la dirección que imprimió y que la página se actualiza sola mientras esté abierta. Si dice «ya estaba
abierta», es la misma de antes. No resumas lo que dice la página: para eso está `/wip`.

## Cómo se actualiza

Mientras la página está abierta, un proceso local (uno solo por máquina, sólo en esta máquina y con un token) vigila
las carpetas del arnés y le manda cada cambio a la página por WebSocket: una sesión que cambia de paso, espera algo o
termina se ve sin volver a correr nada. No consulta nada cada tantos segundos; los pedidos de git, Azure DevOps y
GitHub se preguntan a lo sumo una vez por minuto. La página no le puede mandar órdenes al proceso. El proceso se cierra
solo a los 2 minutos sin la página abierta y a las 8 horas; entonces la página dice «La oficina se cerró. Corré /office
otra vez para verla al día.» y deja la última foto.

## Qué trae la página

Los datos son los mismos de `/wip`, más las firmas pendientes y la sesión coordinadora. Cada sesión es una persona en
su escritorio (hasta diez, acomodados según cuántas haya; con más, primero las que trabajan, y las demás en las tarjetas
de abajo), con su nombre, su estado en palabras y su hora de fin. El estado sale de si la sesión trabaja, no de su paso:
«Trabajando», «Parada» o «Tu firma» cuando espera algo del dueño. La hora se calcula al entrar a cada paso y queda fija
hasta el próximo: sale en rojo si va más de 15 minutos tarde. El detalle dice además la hora que prometió la corrida al
arrancar. Una hora de fin que pasó no es un pronóstico: dice «se pasó de la hora» y desde cuándo no hay novedades; la del trabajo que cambió dice «sin hora: el trabajo cambió». Una sesión sin pipeline anota su hora con `marker.js doing --until HH:MM`, se compara con la primera que prometió, y un aviso se lo recuerda si no la tiene; con `--waiting-for` dice qué espera y desde cuándo, sin hora. «Corriendo pruebas» se dice sólo si la sesión tiene pruebas corriendo entre sus procesos; si no se puede saber, lo dice. Si el perfil del
equipo trae la dirección del sitio de la organización, el encabezado tiene «Abrir el sitio» y el cartel de la pared también
lo abre. Arriba de la etiqueta, una burbuja más chica dice lo que hace mientras tanto, si lo tocó en la última hora. Una
sesión sin pipeline dice su encargo, lo que está haciendo y su última acción, leídos sólo del principio y del final de su
conversación: nada de eso se guarda ni sale de la máquina. Su título es lo que ella anotó que hace, o su último mensaje; el
encargo se muestra como encargo. La tarjeta y el panel al tocar a la persona dicen lo mismo.

Las tablas «Hoy» y «Pendientes» se arman solas de las mismas tarjetas que el kanban: nadie las escribe. Tienen una fila por
tema, con una línea de estado contada de las tarjetas, y al tocarla se abren sus trabajos. El tema de cada trabajo lo elige
una vez el modelo de la noche de la organización, de fondo y sólo con la página abierta: armar la foto no lo espera, y se le
manda sólo el título. Sin modelo, el tema sale de los títulos de los pedidos recientes. Si un tema quedó mal, se corrige con
`tema` en la fila del tablero. Cuánto gastó: `node scripts/tools/office/topics.js --report`.

La sala se dibuja con ritmo para no cargar la máquina: más rápido mientras la tocás, a un ritmo tranquilo si hay personas que se
mueven, muy de vez en cuando si nadie se mueve, y nada si no se ve.

La persona se mueve según su estado: teclea cuando trabaja, mira la pantalla cuando corre pruebas o revisores, se queda
quieta cuando está parada, espera reclinada cuando su story espera entrar a los repos, levanta la mano con un aro naranja
en el piso cuando la sesión espera algo del dueño, y señala cuando es la coordinadora. Al tocarla se abre su detalle, con
los pasos de su corrida. Abajo, los pendientes son un kanban de cinco columnas (Tu firma, En curso, Esperan entrar, Sin
sesión, Hechos), con lo que quedó a medio camino plegado debajo. El panel de la pared cuenta esas columnas y al tocarlo
las lista.

La página no necesita internet: la librería 3D y la del WebSocket vienen con el arnés. Si el navegador no puede dibujar
en 3D, lo dice y abre la tabla. Con `--json` el programa imprime los datos, y con `--out <archivo>` escribe la foto fija
de antes, sin proceso.
