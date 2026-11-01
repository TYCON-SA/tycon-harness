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
su escritorio (hasta diez, acomodados según cuántas haya; las demás, en las tarjetas de abajo), con su nombre, su
estado en palabras y su hora de fin. La hora se compara con la que prometió la corrida al arrancar (o, si no la anotó,
con la primera que se vio): sale en rojo si va más de 15 minutos tarde y en verde si va más de 15 minutos antes. Si el
perfil del equipo trae la dirección del sitio de la organización, el encabezado tiene «Abrir el sitio» y el cartel de
la pared también lo abre. Arriba de la etiqueta, una burbuja más chica dice lo que hace mientras
tanto.

La persona se mueve según su estado: teclea cuando trabaja, mira la pantalla cuando corre pruebas o revisores, espera
reclinada cuando su story espera entrar a los repos, levanta la mano con un aro naranja en el piso cuando la sesión
espera una respuesta o un permiso, y señala cuando es la coordinadora. Al tocarla se abre su detalle, con los pasos de
su corrida. El panel de la pared cuenta lo pendiente de la máquina (en curso, tu firma, esperan entrar, a medio camino)
y al tocarlo lo lista.

La página no necesita internet: la librería 3D y la del WebSocket vienen con el arnés. Si el navegador no puede dibujar
en 3D, lo dice y abre la tabla. Con `--json` el programa imprime los datos, y con `--out <archivo>` escribe la foto fija
de antes, sin proceso.
