# Cómo contribuir

This repository is a mirror: it is regenerated from the team's internal repositories, so pull requests are never merged on GitHub. If a change is accepted, it goes into the internal repository and comes back here with the next sync, and the pull request is closed with a link to that sync; if it is not accepted, it is closed with the reason. Credit is a link to your original pull request in the sync pull request (no `Co-authored-by` trailer). Before opening one, run what the CI runs: `bash scripts/ci/public-ci.sh`. Contributions are accepted under the Apache License 2.0, with no CLA. Issues and pull requests are welcome in English or in Spanish.

## El repo es un espejo

Este repo es una copia que se regenera desde los repos internos del equipo: es un **espejo**. Lo que ves acá sale de
ahí en cada sincronización, así que un pull request **no se mergea en GitHub**:

- **Si se acepta**, el cambio entra al repo interno y vuelve acá en la próxima sincronización. El pull request se cierra
  citándola.
- **Si no se acepta**, se cierra con su motivo.

El crédito es el enlace al pull request original, que queda en el pull request de sincronización. No se agrega una
línea `Co-authored-by` al commit: el crédito es ese enlace, sin `Co-authored-by`.

## Antes de abrir un pull request

Corré lo mismo que corre la CI, desde la raíz del repo:

```bash
bash scripts/ci/public-ci.sh
```

Sale 0 sólo si todos sus pasos salen verdes, y un paso que no pudo correr cuenta como rojo. La CI lo corre en Node 22 y
24.

## Lo que se escribe

Dos reglas, las mismas que sigue el equipo:

1. **Lo que ejecuta la máquina, en inglés**: nombres de archivos, opciones, variables, claves de configuración,
   funciones. Los mensajes y los comentarios pueden ir en castellano. La guía es
   [`guides/nombres-en-ingles.md`](../guides/nombres-en-ingles.md).
2. **Los ejemplos, con nombres inventados** (`acme`, «Cliente A»): ningún cliente, persona, servidor o máquina de
   verdad, ni en el código ni en las pruebas ni en la documentación.

## Licencia

Una contribución entra bajo la misma licencia del repo, Apache-2.0 (la sección 5 de la licencia: lo que se envía para
incluir en el trabajo queda bajo sus términos). No hay CLA que firmar.

## Idioma

Los issues y los pull requests pueden ir en castellano o en inglés.

## Conducta y seguridad

Participar en este repo es aceptar el [código de conducta](CODE_OF_CONDUCT.md). Una vulnerabilidad no se reporta en un
issue público: [SECURITY.md](SECURITY.md) dice cómo reportarla en privado.
