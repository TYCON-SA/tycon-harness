# Armar el plan

**Objetivo**: el orquestador escribe el plan de implementación de la historia. En este paso no modifica archivos del
proyecto: el código se escribe en «Implementar», con el plan ya aprobado.

## Inputs

- `story_path`: path al story validado en «Validar la historia»
- `story_frontmatter`: metadata del story (parseada en «Validar la historia», incluye `approach`)

## Acción — leer la historia y su enfoque

Leer la historia entera y, si el repo lo tiene, `project-context.md`. El campo `approach` del frontmatter dice cómo se
trabaja:

| `approach` | Cómo se trabaja |
|---|---|
| `[EXTRACT]` | Copiar de la fuente que la historia nombra, cambiando sólo lo que pide |
| `[ADAPT]` | Adaptar un patrón o un código que ya existe |
| `[EXTEND]` | Sumar a un código que ya existe, sin cambiar lo que ya hace |
| `[CREATE]` | Crear código nuevo, con las convenciones del repo |
| Ausente o `quick-flow` | El camino más corto que cumple los criterios |

Si el `approach` no matchea ninguno de los anteriores, se trabaja como `[ADAPT]`.

## Paso OBLIGATORIO — Lecciones previas del repo (engram)

ANTES de escribir el plan, correr:

```
mem_search(project: "<nombre canónico del repo — ver guides/integrations/engram-workflow.md>",
           query: "<keywords del título de la story + dominio + archivos del scope>")
```

Tener en cuenta en el plan los top 3-5 gotchas/convenciones relevantes. Razón: los mismos errores conocidos del repo se atrapaban post-hoc en los revisores generando re-loops de iter 2 — considerarlos acá los previene.

Si `mem_search` no devuelve nada relevante → seguir, anunciándolo en 1 línea ("engram sin gotchas relevantes para esta story").

## Paso OBLIGATORIO — Herramientas de código disponibles (2026-07-06)

Del output de `pipeline.js start` (campo `tooling.expected`, o `pipeline.js tooling-expected --repo <dir>`), ver qué tools de code-intel están REALMENTE disponibles en tu harness (codegraph, codebase_memory — verificás vos; ver PIPE-C9) y usarlas en el plan y en la implementación. Razón: sin esto, el plan y la implementación caen a grep aunque el índice esté ahí — más lento y con peor precisión en callsites/impact.

- MCP disponible → `mcp__codegraph__*` (search/callers/impact/context) o `mcp__codebase_memory__*` (search_graph/trace_path) para TODO lookup de símbolos, en vez de grep.
- MCP caído pero binario presente (`binary_found` del tooling check) → el CLI vía Bash: `codegraph query|context|status` / `codebase-memory-mcp cli <tool>`.
- Nada disponible → grep como siempre: el aviso al user ya lo dio PIPE-C9.

## Invocación

No se invoca ninguna skill, con Claude Code y con Codex. El plan lo escribe el orquestador en esta misma sesión, directo
en `step-02-bmad-plan.md` de la carpeta de la corrida, que crea
`node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js run-dir --story <ruta> --repo <repo> --create`.
El archivo conserva ese nombre porque lo leen la revisión del plan, la firma y las corridas abiertas.

## Qué trae el plan

- Análisis de la historia (criterios, pruebas, archivos a crear o modificar)
- Tareas numeradas a ejecutar
- Lista de archivos que va a tocar
- Riesgos o ambigüedades

**El plan queda escrito** en `step-02-bmad-plan.md` antes de pasar a «Aprobar el plan». Es lo que se le muestra a la
persona, y lo que revisa la revisión automática («Aprobar el plan»). Un plan de rutina se aprueba con el «aprobado» de su
revisión, con o sin coordinadora; uno delicado, siempre una persona.

El plan escrito trae dos secciones, que son las que muestra la pregunta de la firma:

- `## Qué hace`: hasta 2 líneas llanas, para alguien que no tocó el código. El cuadro de la firma muestra 2, de hasta
  140 letras cada una, para que se lea en un teléfono; un plan de 3 líneas se firma igual, y la tercera queda en el
  detalle del cuadro.
- `## Archivos`: los archivos que toca, uno por renglón (`- ruta`). Todo lo que el plan cambia va en «## Archivos»; lo
  que sólo corre (una prueba, el gancho de commit) se escribe como el comando entero entre comillas invertidas, con su
  programa delante (`sh .githooks/pre-commit`, `node --test …`): así no vuelve delicado al plan, y la ruta sola sí.

Sin alguna de las dos, o con más de 3 líneas en «Qué hace», el comando no se frena, pero la pregunta de la firma dice
qué falta y cómo agregarlo en lugar del resumen: el dueño ve que el plan no dice qué hace.

El plan de una historia con código (algún archivo de «## Archivos» es código de implementación) trae una tercera:

- `## Suposiciones sobre el código`: lo que el plan da por cierto del código, un renglón por cosa, cada uno con el
  `archivo:línea` donde lo comprobaste. Por ejemplo:

  ```markdown
  ## Suposiciones sobre el código
  - `skills/tycon-pipeline/scripts/lib/steps.js:27` — el paso del plan se llama `plan`
  - `scripts/lib/signature-sources.js:80-86` — `seccion` devuelve null si el título no está
  ```

Sin ella, vacía, con un renglón sin su `archivo:línea`, o con un archivo o una línea que no existen en el repo,
`complete-step plan` no cierra y dice en una línea qué falta y cómo se escribe. Un plan de puro texto (guías,
historias, configuración) no la lleva. La ruta va relativa a la raíz de su repo: el de la ejecución o un hermano (una
historia del repo de historias cita el código del repo hermano). Un plan que no da nada por cierto, porque sólo crea
archivos nuevos, lo dice con un único renglón `- Ninguna: <por qué>`.

## Pasada de suposiciones, antes de cerrar el plan

La revisión del plan busca «suposición falsa»: lo que el plan cree del código y no es cierto. Esa lente corre recién en
«Aprobar el plan», y un plan rechazado ahí cuesta una vuelta entera. Por eso, antes de cerrar el plan, el orquestador
hace su propia pasada:

1. **Lista lo que el plan da por cierto del código**: que una función, un archivo, una opción o un campo existe; qué
   devuelve o qué hace; quién lo llama; en qué orden corre algo; qué lee una prueba.
2. **Comprueba cada una en el repo**, no en la memoria ni en la historia: abre el archivo o busca la definición (con
   CodeGraph si el repo lo tiene). Una suposición se da por buena con su `archivo:línea`.
3. **Lo que no se pudo comprobar**, o resultó falso, se arregla en el plan antes de cerrarlo: se cambia la tarea, o va
   en «Riesgos o ambigüedades» con lo que falta saber. Nunca queda como un hecho.

En un plan con código, lo comprobado queda escrito en «## Suposiciones sobre el código», con su `archivo:línea`: es
lo que mira el cierre del paso. La revisión del plan sigue corriendo igual: esta pasada la abarata, no la reemplaza.

## Guardrail — patrón de referencia verificado (stories de backend)

🔴 **Para stories de backend**, antes de pasar el plan a «Aprobar el plan», el orquestador DEBE chequear:

- El plan **no puede apoyar una decisión estructural** (registración DI, acceso a `BizuitUserContext`, lifecycle de hub / hosted service, transacciones, contrato del plugin loader) en una afirmación sobre el framework que esté marcada como **no verificada** — "asumo", "probablemente", "creo que", "no pude confirmar", "(asumo)". Si un research agent o el propio plan trae el patrón con esa marca → **NO se aprueba el plan**. El orquestador fuerza la verificación directa: grep / abrir el archivo del proyecto hermano (NimboBackend / TotoraBackend / FRESNOBZExtBackend / el repo del framework) y reemplazar la asunción por la cita concreta con `archivo:línea`.
- El plan debe ser **consistente con la sección "Patrón de referencia verificado" de la story** (§9.2). Si el plan propone una decisión estructural que diverge del patrón hermano que la story citó, hay un conflicto que se resuelve ANTES de implementar — no después.

Esto es backstop: `VAL-C8` + los revisores de validación de los paquetes (`pipeline.js validators`) ya validaron la story en «Validar la historia». Acá el orquestador solo se asegura de que el plan no reintroduzca una asunción que la story ya había anclado.

## Decisiones

- **Si la historia es ambigua**: el orquestador consulta a la persona antes de seguir. El plan puede iterar antes de pasar a «Aprobar el plan».

- **Si la historia no se puede implementar** (pide algo fuera de alcance, dependencias no cumplidas): no pasa a «Aprobar el plan», lo informa y termina el pipeline.

- **Si el plan se apoya en una asunción no verificada del framework** (ver Guardrail arriba): no pasar a «Aprobar el plan». Forzar la verificación directa, actualizar el plan (y la story si hace falta), y re-iterar.

## Output de este step

- El plan de implementación, en `step-02-bmad-plan.md`
- La lista de archivos que va a modificar

Pasar a «Aprobar el plan».

## Cierre del step

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js complete-step plan
```

🔴 **Sin esto, «Aprobar el plan» se bloquea.** El freno de orden (`marker.js` §ORDEN) no deja cerrar `approve-plan` con
el 2 todavía pendiente, y el mensaje que ves ahí no dice que lo que falta es este comando. Medido:
es el bloqueo más frecuente del pipeline.
