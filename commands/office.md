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
| 0 | la página quedó escrita y se abrió en el navegador; la salida dice dónde está |
| 2 | no existe la carpeta de estado del pipeline en esta máquina: decilo con lo que imprimió |
| otro | el programa falló: mostrá el error tal cual |

## Qué le mostrás

Una línea: dónde quedó la página (la ruta que imprimió) y que es una foto de ahora, que se actualiza corriendo
`/office` otra vez. No resumas lo que dice la página: para eso está `/wip`.

## Qué trae la página

Los datos son los mismos de `/wip`, más las firmas pendientes y la sesión coordinadora. Cada sesión es una persona en
su escritorio (hasta cinco; las demás, en las tarjetas de abajo), con su nombre, su estado en palabras y su hora de
fin. La hora se compara con la primera que se vio para esa sesión y esa story: sale en rojo si va más de 15 minutos
tarde y en verde si va más de 15 minutos antes. Arriba de la etiqueta, una burbuja más chica dice lo que hace mientras
tanto.

La persona se mueve según su estado: teclea cuando trabaja, mira la pantalla cuando corre pruebas o revisores, espera
reclinada cuando su story espera entrar a los repos, levanta la mano con un aro naranja en el piso cuando la sesión
espera una respuesta o un permiso, y señala cuando es la coordinadora. Al tocarla se abre su detalle, con los pasos de
su corrida. El panel de la pared cuenta lo pendiente de la máquina (en curso, tu firma, esperan entrar, a medio camino)
y al tocarlo lo lista.

La página no necesita internet: la librería 3D va adentro. Si el navegador no puede dibujar en 3D, lo dice y abre la
tabla. Con `--json` el programa imprime los datos en lugar de escribir la página.
