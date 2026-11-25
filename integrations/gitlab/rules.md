# ===================================================
# REGLAS DE GITLAB — lo que `glab` no dice solo
# ===================================================

**Principio, el mismo que en cualquier plataforma: lo que un comando no muestra no prueba que no exista, y un mensaje
que no es un error tampoco es una confirmación.** Antes de una acción con efectos (mergear, reintentar, avisarle a
alguien que algo ya está), se busca evidencia positiva del estado real.

## 1. El servidor va siempre en la línea

Sin `--hostname`, `glab api` usa el servidor del repo de la carpeta en que corre y, fuera de un repo, el público. En una
organización con una instalación propia eso lee otro GitLab sin avisar: una lista vacía de ahí no dice nada del tuyo.
Toda llamada a mano lleva `--hostname <servidor>`, y la ruta del proyecto va codificada entera
(`projects/grupo%2Fsubgrupo%2Frepo`).

## 2. Un pedido sin pipeline se mergea en el acto

«Mergear cuando el pipeline dé verde» sólo espera si hay un pipeline corriendo en la punta. Sin ninguno, GitLab lo
mergea en ese momento. Antes de pedir la entrada de un merge request se mira su punta: su pipeline y sus estados de
commit. Una CI de afuera (Jenkins, por ejemplo) informa por estados de commit y puede tardar en poner el primero: que
todavía no haya ninguno no es «pasó».

## 3. Los estados de commit antes de concluir

Que el merge request diga que se puede mergear no dice si la CI pasó. Antes de afirmar que algo pasó o falló se leen los
estados de la punta, de todas las páginas, y de cada contexto vale el más nuevo. Los estados se piden por el commit, no
por la rama: con el nombre de una rama, la API contesta una lista vacía sin error, que no es «sin CI». Uno en curso no es verde, y uno que no
aparece es «no sé», nunca «pasó». Mirá el código de salida antes de cualquier tubo.

## 4. La identidad en las copias de prueba

Una copia de laboratorio que hace commits usa una identidad de prueba (`lab@example.invalid`) o la privada de GitLab
(`<id>-<usuario>@users.noreply.<servidor>`), nunca el correo de la persona: un commit con el correo real que llega a un
repo público lo publica, y no se borra.
