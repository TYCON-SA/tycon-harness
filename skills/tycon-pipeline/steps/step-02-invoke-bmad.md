# Armar el plan

**Objetivo**: invocar el skill BMAD apropiado según el story, pedirle que genere un plan de implementación en plan mode (NO ejecuta código todavía).

## Inputs

- `story_path`: path al story validado en Step 1
- `story_frontmatter`: metadata del story (parseada en Step 1, incluye `approach`)

## Acción — elegir skill BMAD según `approach`

Leer el campo `approach` del frontmatter del story:

| `approach` | Skill BMAD a invocar |
|---|---|
| `[EXTRACT]` (copiar de fuente) | `/bmad-dev-story` |
| `[ADAPT]` (adaptar código existente) | `/bmad-dev-story` |
| `[CREATE]` (código nuevo) | `/bmad-agent-dev` (persona Amelia) |
| Ausente o `quick-flow` | `/bmad-agent-quick-flow-solo-dev` (persona Barry) |

Si el `approach` no matchea ninguno de los anteriores, default a `/bmad-dev-story`.

## Paso OBLIGATORIO — Lecciones previas del repo (engram)

ANTES de invocar el skill BMAD, correr:

```
mem_search(project: "<nombre canónico del repo — ver guides/engram-workflow.md>",
           query: "<keywords del título de la story + dominio + archivos del scope>")
```

Armar un bloque **"Lecciones previas del repo (engram)"** con los top 3-5 gotchas/convenciones relevantes y pasarlo DENTRO del prompt/args al skill BMAD junto al `story_path`. Razón: los mismos errores conocidos del repo se atrapaban post-hoc en Step 5 generando re-loops de iter 2 — inyectarlos acá los previene.

Si `mem_search` no devuelve nada relevante → seguir sin bloque, anunciándolo en 1 línea ("engram sin gotchas relevantes para esta story").

## Paso OBLIGATORIO — Herramientas de código disponibles (2026-07-06)

Del output de `pipeline.js start` (campo `tooling.expected`, o `pipeline.js tooling-expected --repo <dir>`), armar el bloque **"Herramientas de código disponibles"** con las tools de code-intel que estén REALMENTE disponibles en tu harness (codegraph, codebase_memory — verificás vos; ver PIPE-C9) y pasarlo TAMBIÉN dentro del prompt/args al skill BMAD. Razón: sin la instrucción explícita, el plan y la implementación caen a grep aunque el índice esté ahí — más lento y con peor precisión en callsites/impact.

- MCP disponible → instruir: *"usá `mcp__codegraph__*` (search/callers/impact/context) o `mcp__codebase_memory__*` (search_graph/trace_path) para TODO lookup de símbolos, en vez de grep"*.
- MCP caído pero binario presente (`binary_found` del tooling check) → instruir el CLI vía Bash: `codegraph query|context|status` / `codebase-memory-mcp cli <tool>`.
- Nada disponible → omitir el bloque (grep como siempre) — el aviso al user ya lo dio PIPE-C9.

## Invocación

Usar la tool `Skill` (no `Agent` — los skills BMAD son skills, no subagentes):

```
Skill(
  skill: "<skill BMAD elegido>",
  args: "Cargar story en {story_path}. MODO PLAN: analizar requerimientos, proponer plan de implementación paso a paso, pero NO modificar archivos todavía. Esperar aprobación del usuario antes de ejecutar.

  Lecciones previas del repo (engram):
  {top 3-5 gotchas del mem_search — omitir el bloque si no hubo resultados relevantes}

  Herramientas de código disponibles:
  {tools de code-intel disponibles + instrucción de usarlas para lookup de símbolos en vez de grep — omitir el bloque si no hay ninguna}"
)
```

## Salida del skill BMAD

El skill BMAD en plan mode debe producir:
- Análisis de la story (ACs, tests, archivos a crear/modificar)
- Plan numerado de tasks a ejecutar
- Lista de archivos que va a tocar
- Identificación de riesgos o ambigüedades

## Guardrail — patrón de referencia verificado (stories de backend)

🔴 **Para stories de backend**, antes de pasar el plan a Step 3, el orquestador DEBE chequear:

- El plan **no puede apoyar una decisión estructural** (registración DI, acceso a `BizuitUserContext`, lifecycle de hub / hosted service, transacciones, contrato del plugin loader) en una afirmación sobre el framework que esté marcada como **no verificada** — "asumo", "probablemente", "creo que", "no pude confirmar", "(asumo)". Si un research agent o el propio plan trae el patrón con esa marca → **NO se aprueba el plan**. El orquestador fuerza la verificación directa: grep / abrir el archivo del proyecto hermano (NimboBackend / TotoraBackend / FRESNOBZExtBackend / el repo del framework) y reemplazar la asunción por la cita concreta con `archivo:línea`.
- El plan debe ser **consistente con la sección "Patrón de referencia verificado" de la story** (§9.2). Si el plan propone una decisión estructural que diverge del patrón hermano que la story citó, hay un conflicto que se resuelve ANTES de implementar — no después.

Esto es backstop: `VAL-C8` + los revisores de validación de los paquetes (`pipeline.js validators`) ya validaron la story en Step 1. Acá el orquestador solo se asegura de que el **plan de BMAD** no reintroduzca una asunción que la story ya había anclado.

## Decisiones

- **Si el skill BMAD pide clarificaciones al usuario** (típico en Amelia si el story tiene ambigüedades): dejar que el usuario responda. El plan mode puede iterar antes de pasar a Step 3.

- **Si el skill BMAD detecta que no puede implementar** (story pide algo fuera de scope, dependencias no cumplidas): no pasar a Step 3. Reportar al usuario y terminar el pipeline.

- **Si el plan se apoya en una asunción no verificada del framework** (ver Guardrail arriba): no pasar a Step 3. Forzar la verificación directa, actualizar el plan (y la story si hace falta), y re-iterar.

## Output de este step

- Plan de implementación generado por BMAD
- Lista de archivos que BMAD va a modificar

Pasar al Step 3.

## Cierre del step

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js complete-step 2
```

🔴 **Sin esto, el Step 3 se bloquea.** El freno de orden (`marker.js` §ORDEN) no deja cerrar el 3 con
el 2 todavía pendiente, y el mensaje que ves ahí no dice que lo que falta es este comando. Medido:
es el bloqueo más frecuente del pipeline.
