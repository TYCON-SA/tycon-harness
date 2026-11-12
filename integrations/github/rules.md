# ===================================================
# REGLAS DE GITHUB — lo que `gh` no dice solo
# ===================================================

**Principio, el mismo que en cualquier plataforma: lo que un comando no muestra no prueba que no exista, y un mensaje
que no es un error tampoco es una confirmación.** Antes de una acción con efectos (encolar, mergear, reintentar,
avisarle a alguien que algo ya está), se busca evidencia positiva del estado real.

## 1. La cola de merge esconde el auto-merge

Con una cola de merge en la rama, `gh pr merge --auto` contesta
«The merge strategy for main is set by the merge queue» y aun así deja el pedido encolado. Ese texto no dice si quedó
o no: se confirma leyendo el pedido,
`gh pr view <n> --json autoMergeRequest` (y, si la rama tiene cola, si está en ella: `isInMergeQueue` por GraphQL). Un
pedido que sale de la cola sin mergear no avisa: se mira de nuevo cuando termina su CI.

## 2. `gh pr checks` antes de concluir

Que el pedido diga que se puede mergear, o que la lista de pedidos no lo muestre trabado, no dice si la CI pasó. Antes
de afirmar que algo pasó o falló: `gh pr checks <n>`. Un control en curso no es verde, y uno que no aparece es «no
sé», nunca «pasó». Mirá el código de salida antes de cualquier tubo.

## 3. La identidad noreply en las copias de prueba

Una copia de laboratorio que hace commits usa una identidad de prueba (`lab@example.invalid`) o la noreply de GitHub
(`<usuario>@users.noreply.github.com`), nunca el correo de la persona: un commit con el correo real que llega a un repo
público lo publica, y no se borra.
