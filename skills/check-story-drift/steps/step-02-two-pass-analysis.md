# Step 2 — Análisis en 2 pasadas independientes (Pass A + Pass B)

## Objetivo

Para cada candidate, lanzar **DOS agents en paralelo** con prompts ortogonales que ataquen el problema desde ángulos distintos. Un solo agent run no es confiable: puede reportar como inexistente un archivo que sí existe.

## Reglas core aplicadas en este step

| Regla | Pass donde aplica |
|---|---|
| 1. Leer SCOPE del spec, no solo "Files to Create" | Pass B |
| 2. Distinguir shared infra vs scope único | Pass A + Pass B (reconcile) |
| 3. Cross-check con `git log --diff-filter=A` | Pass A |
| 4. Dos pasadas independientes | El step mismo |

## Pass A — File existence + attribution check

**Subagent**: `Explore` (read-only, fast).

**Prompt template** (parametrizar por candidate):

```
Tu tarea: verificar si los archivos declarados en la story Mary+GOLD <story_file>
existen en filesystem, Y atribuir cada archivo al commit que lo CREÓ (no que lo
modificó o mencionó).

**Acciones obligatorias**:

1. Leer la sección "## Files" / "## Files to Create" / "## Implementation Plan"
   del spec `<specs_dir>/<story_file>` y listar TODOS los archivos a crear.

2. Para cada archivo a crear, en cada code repo (<code_repos>), ejecutar:
   ```
   if [ -f "<repo>/<path>" ]; then
     git -C <repo> log --all --oneline --diff-filter=A -- "<path>" | head -1
   fi
   ```
   Esto retorna el commit que CREÓ el archivo. Capturar hash + subject.

3. Por cada archivo encontrado, determinar:
   - Si el commit subject menciona "Story X.Y" (la candidate) → atribuido a la candidate.
   - Si el commit subject menciona OTRA story → atribuido a esa otra (shared infra).
   - Si el commit subject no menciona ninguna story → inconcluso.

4. Reportar:
   ```
   Story X.Y file attribution:
   - <path1>: created in <hash> (subject: "...") → attributed_to: <story-or-other>
   - <path2>: not found in filesystem
   - <path3>: created in <hash> → shared infra of Story Z.W
   ```

**Reportá conciso, <300 palabras.** NO interpretes el resultado — solo reportá hechos.
```

## Pass B — Scope verification

**Subagent**: `Explore` (read-only).

**Prompt template** (parametrizar por candidate):

```
Tu tarea: verificar si el SCOPE UNICO de la story Mary+GOLD <story_file> está
implementado, independientemente de qué archivos existan.

**Acciones obligatorias**:

1. Leer el spec completo `<specs_dir>/<story_file>`. Identificar:
   - Los 3-5 comportamientos UNICOS de esa story (no compartidos con otras).
     Ej: "view read-only con masked customer name", "ZPL printing con Plan B PDF
     fallback", "P3 lista de pendientes con devolución", etc.
   - El endpoint principal o componente principal que entrega ese comportamiento.
     (Ignorar archivos que probablemente sean shared infra.)

2. Para cada comportamiento único, hacer un grep dirigido en los code repos
   buscando la implementación específica:
   - Endpoint específico de la story.
   - Componente con nombre derivado de la story.
   - String literal del comportamiento (ej: "[Restringido]" para el AC #1 de la story).

3. Reportar:
   ```
   Story X.Y scope verification:
   - Behavior 1 (descripción): IMPLEMENTED in <path:line>
   - Behavior 2 (descripción): NOT FOUND — grep '<pattern>' returned 0 matches
   - Behavior 3 (descripción): PARTIAL — found in <path> but missing <subscope>
   ```

**Reportá conciso, <300 palabras.** Foco en el SCOPE, no en archivos.
```

## Ejecutar en paralelo

Los 2 agents para cada candidate se lanzan **en un solo message con múltiples tool calls** (NO secuencial). Si hay N candidates, son 2N agents totales — lanzar en batches de máximo 6-8 paralelos por message para no saturar (cada Agent block consume contexto).

## Captura de resultados

Cada agent retorna un único message. Guardar Pass A y Pass B por candidate para reconciliar en Step 3:

```yaml
results:
  "2.4":
    pass_a:
      files_found: 2
      files_missing: 3
      attribution:
        - RemitoBuilderService.cs: attributed_to "Story <otra N.M>" (commit <sha>)
        - IRemitoBuilderService.cs: attributed_to "Story <otra N.M>"
    pass_b:
      behaviors_implemented: 0
      behaviors_partial: 1
      behaviors_missing: 4
      notes: "RemitoBuilderService arma el número pero NO hay plantilla del remito, NO endpoint de impresión, NO respaldo en PDF"
```

## Anti-patterns

- ❌ NO lanzar los 2 passes en serie (perdés la independencia).
- ❌ NO usar el mismo prompt para ambos passes (necesitan ángulos distintos).
- ❌ NO confiar en un solo agent si los 2 passes coinciden — chequear que los prompts realmente difieran (un copy-paste accidental no cuenta como 2 passes independientes).
- ❌ NO interpretar resultados en el Step 2 — eso es trabajo del Step 3.
