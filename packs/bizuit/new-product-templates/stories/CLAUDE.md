# CLAUDE.md — {{STORIES_REPO}}

Guía para trabajar en este repo. Es el canónico multi-herramienta: `AGENTS.md` es un puntero acá.

## 🚨 REGLA CRÍTICA: NO COMMIT/PUSH SIN CONSENTIMIENTO 🚨

**Nunca `git commit` ni `git push` sin que el dev lo pida explícitamente.**

## Reglas para revisores

- **El frontmatter de cada historia tiene que ser completo y parseable.** Una historia con
  frontmatter roto NO da error: el validador, los scripts de estado y el portón la **saltean en
  silencio**. El hook de pre-commit corre el mismo parser que esas herramientas.
- **Cada historia declara CUÁNTAS pruebas y el NOMBRE de cada una.** Una historia que dice "se
  agregan pruebas" no es verificable.
- **Una historia que corrige, recalibra o extiende otra lleva `followup_of:` y su causa en
  `followup_reason:`.** Sin eso el reproceso no se puede medir.
- **Un épico nuevo se anota en `.tycon/ado-config.yaml` → `epic_links` en el MISMO cambio.** Si no
  está, las historias se crean sin vincular al épico y hay que linkearlas a mano después.
- 🔴 **Una historia cuya implementación toca datos lleva su plan de vuelta atrás escrito.** Staging
  la ensaya; producción la recibe con la misma migración, y lo que no se escribió no se improvisa.
- **Ninguna credencial en las historias**, ni de prueba, ni "de ejemplo".

## Qué es este repo

Las **historias (specs) de {{PRODUCT}}** — el {{PRODUCT_DESCRIPTION}}. Acá no hay código:
hay especificaciones, y son el ancla de todo lo demás.

| repo | qué tiene |
|---|---|
| `{{STORIES_REPO}}` (este) | las historias, en `.specs/` |
| `{{BACKEND_REPO}}` | el plugin .NET del backend |
| `{{FORMS_REPO}}` | los formularios y plugins frontend |

## 🔴 Por qué el portón de controles vive ACÁ

El portón (`tycon-ci-gate.js`) revisa las historias que un cambio declara `review`/`done` y exige
su evidencia. Si se instalara sólo en los repos de código, no encontraría nada que mirar y saldría
**verde permanente vigilando nada** — que es el modo de falla exacto contra el que el arnés
escribe sus reglas: "0 hallazgos" se lee como "salió limpio" cuando en realidad no había nada.

Medido el 2026-09-01 en un producto del equipo que escribió esta plantilla: más de cien historias
en el repo de specs y **cero** en sus repos de código.

Este pipeline no construye ni despliega: sólo el portón, y lo encola la política de rama cuando se
abre un pull request contra `main`.

## Spec primero, código después

- **Nunca se implementa sin historia aprobada.** Si aparece algo nuevo durante la implementación,
  se actualiza la historia PRIMERO y después se codea.
- Cada historia declara **cuántas** pruebas y el **nombre** de cada una. Después de escribirlas se
  verifica el número real contra el declarado.
- Antes de empezar a implementar, la historia pasa por una revisión adversarial: completitud,
  consistencia, dependencias, cobertura. Lo crítico se arregla antes de codear.

Formato completo: `story-format.md` del arnés. Cierre de una historia:
`guides/definition-of-done.md`.

## Azure DevOps

Las historias crean work items en el proyecto `{{ADO_PROJECT}}`. La config está en
`.tycon/ado-config.yaml`, con el tipo de work item, el área y las iteraciones consultados del
proyecto en el alta. Cuando nazca el
primer épico hay que anotarlo en `epic_links` del mismo archivo, o las historias se crean sin
vincular.
