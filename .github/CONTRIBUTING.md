# Cómo contribuir

Pull requests are welcome. Anyone can send one with code: it runs the repository's validation, and TYCON reviews it and decides. If it is accepted, it is merged here, with your commits. For now, the automatic validation does not run on pull requests from a fork, so TYCON reviews those by hand. Before opening one, run what the CI runs: `bash scripts/ci/public-ci.sh`. Contributions are accepted under the Apache License 2.0, with no CLA. Issues and pull requests are welcome in English or in Spanish.

## Los pull requests son bienvenidos

Cualquiera puede mandar un pull request con código. Corre la validación del repo, y TYCON lo revisa y decide:

- **Si se acepta**, se mergea acá, con tus commits: el crédito queda en la historia del repo.
- **Si no se acepta**, se cierra con su motivo.

Por ahora, la validación automática no corre sobre un pull request que viene de una copia del repo (un fork): esos los
revisa TYCON a mano.

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
