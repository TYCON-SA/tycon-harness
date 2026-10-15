# Cerrar en ADO

**Objetivo**: dejar trazabilidad regulatoria-grade en el work item de Azure DevOps al momento de marcar una story como `done`. Postea un comment con los commit SHA(s), CI run y PR link que dieron cierre a la story, y transiciona el state del WI a `Closed` / `Done`.

**Disparo**: NO se ejecuta en el flujo principal del pipeline. Se invoca cuando el dev dice explícitamente:

- "cerrá la story X en ADO"
- "marco done la story X"
- "post-DoD, cerrar ADO"
- "/tycon-pipeline close <story-path>"

Si el dev solo dice "marcá done en el frontmatter", también disparar este step (cuando la story tiene `ado_work_item:` en frontmatter — ver más abajo).

## 🔴 Pre-condiciones (NO skipear)

Antes de postear nada en ADO, validar que se cumple TODO esto:

1. **El portón de «terminado» pasó** — y el que manda es la **matriz de verificación por criterio de
   aceptación**, no una lista de chequeos sueltos:
   - `marker.js run-check acmatrix -- node <skill>/scripts/runtime-matrix.js --story <abs spec.md>`
     en VERDE. Verde quiere decir: cada AC con evidencia de EJECUCIÓN real (gate E2E o
     `smoke-run.sh` con exit code capturado), o declarado imposible en el frontmatter
     `runtime_not_verifiable:` (con `reason:` + `covered_by:`) **y firmado por el dev desde su
     terminal** con `marker.js runtime-waiver <abs spec.md>`.
   - 🔴 Un AC `SIN CORRER` **no se waivea**: lo corre el agente. Sólo los `imposibles-declarados`
     son elegibles para la firma del dev.
   - 🔴 **El registro de esa firma NO va al frontmatter.** El `ack` escribible por el agente fue el
     agujero que se cerró el 2026-07-10 y no se reintroduce: la firma la produce el comando TTY y
     vive en `.tycon/runtime-waivers.jsonl` del repo de la story.
   - Si la story es de UI, además la guía de prueba manual del tester (DODRT-C7) tiene que estar
     lista: `node <skill>/scripts/qa-guide.js --check --story <abs spec.md>`.
   - Contexto y criterio: `~/.claude/tycon-harness/guides/definition-of-done.md`.
2. **Sin deudas abiertas** — pre-condición MECÁNICA:
   ```bash
   node <skill>/scripts/pipeline.js deferrals-open --story <abs spec.md> --repo <repo>
   ```
   - exit 0 → seguir. **exit 3 → STOP** con la lista que imprime: tags `[story-{N}-*]` vivos en
     `tasks/todo.md` (ni dentro de `~~…~~` ni `[x]`; con el id tal cual o con guiones: `[story-<N.M>-…]` o
     `[story-<N>-<M>-…]`) o tandas `pipelines.X` con `status != done`. El dev cierra
     esos deferrals O los ratifica con un CR aprobado antes de continuar. **exit 1** (no pudo leer la
     story o el `todo.md`) → STOP: «no pude mirar» no es «no hay deuda».
3. *(Retirada el 2026-09-16.)* Hasta esa fecha este paso relanzaba dos revisores
   con modelo —el checker de DoD y el de cobertura de ACs en modo transición a done— sobre una story
   ya cerrada. No se relanzan: lo que contestaban es el grep del punto 2, la matriz por AC ya corrió
   en verde (punto 1), y el control local de `review → done` (hoy avisa) y el portón de CI siguen mirando. Medido: cero
   hallazgos en todo el registro.
4. **Merge a main hecho** (vía `/tycon-merge-to-main` o manual) — para tener el CI run definitivo y, si aplica, el PR link.
5. **Frontmatter `status:`** debe estar en `review` (post Step 8) o `done` (si dev ya lo movió manualmente). NO ejecutar Step 9 sobre `ready-for-dev`/`in-progress` — es señal de que el flujo no completó Step 8.
6. **Si la story NO tiene `ado_work_item:` en frontmatter** → NO skipear ADO con "N/A". Resolver en este orden (ver sección "Creación retroactiva del WI" abajo):
   a. Si el repo tiene `.tycon/ado-config.yaml` (integración ADO activa) → **CREAR el WI retroactivamente** (PBI hijo del Epic mapeado en `epic_links`), escribir `ado_work_item:` en el frontmatter, y continuar con el cierre normal (comment + Done + CompletedWork). NO preguntar al dev por un ID que no existe.
   b. Si el dev SABE que ya existe un WI (creado a mano fuera del flujo) → preguntar el ID, NO grep por título (puede haber WIs con títulos similares).
   c. Si el repo NO tiene `.tycon/ado-config.yaml` → ADO genuinamente N/A, skip la parte ADO (solo entonces).

   **🔴 Anti-pattern**: leer "sin `ado_work_item:` → ADO N/A" y skipear toda la parte ADO cuando el repo SÍ tiene `.tycon/ado-config.yaml` con `epic_links` (y las stories hermanas tienen WI). El skip deja stories `done` y mergeadas sin WI ni horas cargadas. **"Sin `ado_work_item:`" NO significa "ADO no aplica" — significa "falta crear el WI" cuando hay config ADO.** El fix es crear retroactivamente, no skipear.

Si alguna condición falla → STOP. Pedir al dev que complete la pre-condición faltante. No postear comment parcial.

## Inputs

- `story_path` — path al .md de la story
- `ado_work_item_id` — del frontmatter o preguntado al dev
- `commit_shas[]` — lista de commit SHAs que implementaron la story (ver "Recolección de commits")
- `ci_run` — número/link del CI run post-merge que validó el build verde (ver "Recolección de CI run")
- `pr_link` — URL del PR si la story se mergeó vía PR (opcional — algunos proyectos pushean directo a `main`)
- `ado_org` y `ado_project` — del config del repo (ver "Configuración ADO" abajo)
- `time_tracked` — suma de duraciones de las entries de Clockify que matchean la story (ver "Recolección de tiempo Clockify")

## Recolección de commits

Los commits que dieron cierre a la story son **todos los commits del implementador entre el inicio de la story y el merge a main**, NO solo el último. Story típica tiene 3-15 commits (init + iteraciones + fixes post-advisors + tests + DoD adjustments).

Estrategia:

```bash
# Si la story tiene un frontmatter `branch:` con el nombre de la branch:
git log <branch>..main --reverse --pretty=format:"%H %s" | grep -i "<story-id>"

# Si no hay branch tracking, usar fecha de creación del .md como anchor:
story_start=$(git log --reverse --pretty=format:"%aI" -- <story_path> | head -1)
git log --since="$story_start" --pretty=format:"%H %s" | grep -iE "(story <id>|<short-title>)"

# Fallback: pedir al dev los SHAs explícitamente.
```

Mostrar la lista al dev y pedir confirmación: *"Estos son los commits que detecté para esta story. ¿Correcto? ¿Falta alguno?"* — el dev SIEMPRE valida antes de postear.

## Recolección de CI run

El CI run relevante es el **post-merge a main** (ya con todo el código integrado), NO los runs de feature branch.

Estrategia según provider:

```bash
# Azure DevOps Pipelines:
az pipelines runs list --organization https://dev.azure.com/<org> --project <project> \
  --branch main --top 5 --query "[?contains(sourceVersion, '<merge-sha>')].{id:id, status:status, result:result, web:_links.web.href}"

# GitHub Actions (si aplica):
gh run list --branch main --limit 5 --json databaseId,headSha,status,conclusion,url \
  | jq '.[] | select(.headSha | startswith("<merge-sha-prefix>"))'
```

Tomar el primer run verde (`result=succeeded` / `conclusion=success`) post-merge. Si no hay run verde → STOP, dev debe arreglar CI antes de cerrar la story.

**Repo sin CI** (2026-10-05): si el repo no tiene NINGÚN archivo de CI (ni `azure-pipelines*.yml`, ni `.github/workflows/*.yml`, ni `.gitlab-ci.yml`), no hay corrida que buscar: **no es STOP**. `ci_run` queda «sin CI en el repo» y el cierre sigue con la evidencia local (build y pruebas del paso 4). El STOP de arriba vale para un repo que SÍ tiene CI y no muestra una corrida verde.

## Recolección de tiempo Clockify

Sumar TODAS las entries de Clockify (del workspace + project del repo) cuya descripción contenga el story ID o un match razonable del título, en el rango temporal del trabajo (desde el primer commit hasta el merge a main).

Estrategia:

```bash
# 1. Resolver workspaceId + projectId desde ~/.claude/clocki/project-cache.json para el cwd actual.
#    (Lectura, NO escritura — el cache es del flujo normal de clocki.)

# 2. Definir ventana temporal:
story_start=$(git log --reverse --pretty=format:"%aI" -- <story_path> | head -1)
merge_end=$(git log -1 --pretty=format:"%aI" <merge-commit-sha>)

# 3. Query Clockify entries en esa ventana, project + user actual:
#    (bajo Codex los nombres de tool van con guiones bajos, no guiones; ver clocki/SKILL.md)
#    mcp__clockify__list-clockify-time-entries con:
#      - workspaceId
#      - userId (del usuario actual; obtenido con mcp__clockify__get-clockify-user)
#      - projectId
#      - start = story_start
#      - end = merge_end + 24h (para capturar entries posteriores al merge si aplica)

# 4. Filtrar por descripción: matchear si contiene "Story <id>" (case-insensitive) o
#    una palabra clave fuerte del título (ej. "urgentes"). Mostrar todas las
#    candidatas al dev y pedir confirmación: "Estas son las entries que matcheo para
#    esta story. ¿Correcto? ¿Quitás alguna o agregás otra?"

# 5. Sumar durationSeconds de cada entry y formatear como "Xh YYm".
```

Formato del output: `Xh YYm` (ej. `4h 32m`). Si la story tomó menos de 1h, mostrar `XX min` (ej. `47 min`).

**Casos a manejar**:

- **Sin entries matcheadas**: log "no se encontró tracking Clockify para esta story". Comment va sin el campo de tiempo. NO inventar duración. NO calcular `merge_date - first_commit` (eso es wall-clock, no trabajo real).
- **Entries con descripción genérica** (ej. "fix typo" sin story ID): el dev decide en la confirmación si las incluye.
- **Workspace/project no resueltos**: skip el campo, log el motivo.
- **El dev quiere overridear el total**: aceptar override manual (ej. "ponele 5h en vez de 4h32m" — el dev sabe si hubo trabajo offline no trackeado).

## Configuración ADO

El skill necesita saber `org` + `project` para invocar `az boards`. Resolver en este orden:

1. **Config del repo** — buscar `.tycon/ado-config.yaml` en el repo root (manda: un repo de cliente puede vivir en otra organización):
   ```yaml
   ado_org: https://dev.azure.com/<organizacion>
   ado_project: Ceibo
   ```
2. **La configuración del arnés** — `ado.org`: `node ~/.claude/tycon-harness/scripts/lib/tycon-config.js get ado.org`
   (lee `TYCON_ADO_ORG`, `~/.claude/tycon.json` y el perfil del equipo, en ese orden; exit 3 = sin organización; exit 2 =
   configuración rota, y se dice con archivo, clave y motivo). El proyecto: `TYCON_ADO_PROJECT`, o preguntar al dev.
3. **Sin organización = Azure DevOps apagada en esta máquina** — el step lo dice en UNA línea («Azure DevOps apagado en
   esta máquina — el work item no se cierra; prender: ado.org en ~/.claude/tycon.json o TYCON_ADO_ORG»), no llama a `az`
   y se saltea (exit 0). Ya no hay un nivel «tabla por proyecto»: la tabla de `guides/ado-projects.md` es referencia
   para personas, no algo que el pipeline lee.

## Creación retroactiva del WI (cuando `ado_work_item:` falta + hay config ADO)

Disparado por pre-condición 6.a. Cuando la story está `done`/`review`, NO tiene
`ado_work_item:` en frontmatter, y el repo tiene `.tycon/ado-config.yaml`:

1. **Resolver config** desde `.tycon/ado-config.yaml`: `ado_org`, `ado_project`,
   `ado_wi_type`, `ado_area_path`, `ado_state_closed`, `epic_links`, `ado_default_tags`.
2. **Resolver el Epic padre**: leer `epic:` del frontmatter de la story → buscar en
   `epic_links[epic]` el WI id del Epic. Si no hay entrada → crear suelto + warning.
3. **Calcular CompletedWork** desde Clockify (ver "Recolección de tiempo Clockify").
4. **Crear el PBI**:
   ```bash
   WI=$(az boards work-item create \
     --org "$ado_org" --project "$ado_project" \
     --type "$ado_wi_type" \
     --title "Story <id>: <title>" \
     --area "$ado_area_path" \
     --fields "Microsoft.VSTS.Scheduling.CompletedWork=$hours_decimal" "System.Tags=$ado_default_tags" \
     --query "id" -o tsv)
   ```
5. **Linkear al Epic padre**:
   ```bash
   az boards work-item relation add --org "$ado_org" --id "$WI" \
     --relation-type "parent" --target-id "<epic_wi_id>"
   ```
6. **Escribir `ado_work_item: <WI>`** en el frontmatter de la story (línea tras
   `signed_for_sprint:` o `parent_story:`), via Edit. NO dispara el hook
   `on-frontmatter-write.js` (no es transición de `status:`/`pipelines.status:`).
7. **Continuar con el cierre normal** (postear comment + state Done + CompletedWork
   ya seteado en el create). El comment debe anotar "**WI creado retroactivamente**
   <fecha> (gap del pipeline corregido — la story se cerró sin tycon-ado-story-wi)".
8. **Preparar** el commit del frontmatter actualizado y **pedir autorización al dev** antes de
   ejecutarlo — igual que el Step 8, y por la misma regla (`SKILL.md` §"Anti-patterns (lo que NO
   hace)" y `guides/git-commit-conventions.md`: el pipeline NO ejecuta `git commit` ni `git push`
   sin aprobación explícita). Mensaje sugerido: `chore(story-<id>): link ado_work_item`.

**Idempotencia**: si ya existe un WI para esa story (el dev confirma ID en 6.b), saltear
la creación y usar ese ID. NO crear duplicados.

## Acción — postear closing comment

Armar el comment en este formato fijo:

```markdown
**Story cerrada — trazabilidad de implementación**

- **Story spec**: `<story_path>` (status: `done`)
- **Commits que implementaron la story** (<N> commits):
  - `<sha1>` — <subject corto>
  - `<sha2>` — <subject corto>
  - ...
- **CI run que validó** (post-merge a `main`): [<run-id>](<run-url>) — `<status>`
- **PR**: [<pr-id>](<pr-url>) <!-- omitir esta línea si la story se mergeó directo a main -->
- **Tiempo dedicado** (Clockify): `Xh YYm` sobre `<N>` entries <!-- omitir si no se encontró tracking -->
- **DoD gate**: ✅ smoke + E2E fail-loud + cross-check
- **Cerrada por**: <dev-name> el <YYYY-MM-DD>

🤖 Cierre automático vía tycon-pipeline step-09.
```

Postear a ADO:

```bash
az boards work-item update \
  --organization <ado_org> \
  --id <ado_work_item_id> \
  --discussion "<comment-text>"
```

Después transicionar state:

```bash
az boards work-item update \
  --organization <ado_org> \
  --id <ado_work_item_id> \
  --state "Closed"   # o "Done" según el process template del proyecto
```

### 🔴 Acción MANDATORY — popular `CompletedWork` con horas reales

**Cerrar el work item SIN cargar las horas es un cierre incompleto.** Las horas reales
gastadas en la story van en el campo **`Microsoft.VSTS.Scheduling.CompletedWork`**
(decimal en **horas**).

- ⚠️ `CompletedWork` **NO es `Effort`**. `Effort` (`Microsoft.VSTS.Scheduling.Effort`)
  son story points — NO horas. Las horas SIEMPRE van en `CompletedWork`.
- Funciona **directo sobre el Product Backlog Item** — no hace falta crear una Task hija.
- Método canónico: `az boards work-item update --fields` (mismo `az` que el resto del
  step — NO usar curl + PAT, es más frágil).

```bash
# time_tracked "6h 23m" → 6 + 23/60 = 6.38 → redondeo a 1 decimal = 6.4
hours_decimal=$(python3 -c "print(round($total_seconds / 3600, 1))")

az boards work-item update \
  --id <ado_work_item_id> \
  --organization <ado_org> \
  --fields "Microsoft.VSTS.Scheduling.CompletedWork=$hours_decimal"
```

Se puede combinar con la transición de state en una sola invocación:

```bash
az boards work-item update --id <id> --organization <org> \
  --state "Done" \
  --fields "Microsoft.VSTS.Scheduling.CompletedWork=$hours_decimal"
```

**Caso Agile process** (en lugar de Scrum): igual `CompletedWork` para horas gastadas
(`Microsoft.VSTS.Scheduling.OriginalEstimate` para el estimado).

**Cuándo NO setear CompletedWork**:
- Si el time_tracked no se pudo calcular (skip Clockify) → omitir, no inventar valor.
- Si el proyecto declara explícitamente que `CompletedWork` se usa para otra cosa (raro
  pero posible) → respetar la decisión del proyecto, dejarlo libre.

> Por qué: transicionar el state a `Done` a mano **sin** correr este step deja el WI sin
> `CompletedWork`. Por eso esta acción es MANDATORY y `CompletedWork` figura en la checklist
> de side-effects del SKILL.md.

**Manejo de errores**:
- Si `az boards` falla con 401/403 → token vencido / sin permisos. Pedir al dev que renueve `AZURE_DEVOPS_EXT_PAT`.
- Si el state name no matchea (ej. el process usa `Resolved` en vez de `Closed`) → listar states válidos con `az boards work-item update --help` o pedir al dev qué state usar.

## Acción — cerrar clocki timer (2026-05-13)

Después de transicionar el state del WI a `Closed`, **cerrar el timer activo de Clockify para el cwd actual**. La story está done, no hay más trabajo lógico — dejar el timer abierto sería ruido en el dashboard.

Estrategia:

```bash
# 1. Leer ~/.claude/clocki/active.json. Buscar entry para cwd actual.
#    Si no hay entry → skip (no había timer activo, OK).
#
# 2. Cerrar el time entry con end=now (story terminada en este preciso momento,
#    NO usar lastActivity como hace el sweep idle — acá el cierre es explícito
#    por finalización del trabajo, no por inactividad).
#
#    mcp__clockify__update-clockify-time-entry con:
#      - timeEntryId = active.json[cwd].entryId
#      - workspaceId = active.json[cwd].workspaceId
#      - projectId = active.json[cwd].projectId
#      - description = active.json[cwd].description (preservar)
#      - start = active.json[cwd].startedAt (preservar)
#      - end = now (ISO local sin TZ suffix; el wrapper MCP lo interpreta como local)
#
# 3. Remover la entry de active.json (escribir el JSON sin el cwd actual).
#
# 4. Log al dev: "✓ Timer cerrado: duración Xh YYm".
```

**Casos a manejar**:

- **No hay timer activo**: skip silencioso, no es error.
- **Timer activo en OTRO cwd** (no el de la story): NO tocar — pertenece a otro flujo.
- **update-clockify falla** (red, 401): log warning, NO bloquear el cierre del step. La trazabilidad ADO ya quedó posteada; el timer queda abierto y el sweep idle (>15min) lo cerrará retroactivamente.

**Por qué `end=now` y no `end=lastActivity`**: el sweep idle usa `lastActivity` para no contar tiempo idle (consistente con su propósito: detectar abandono). Acá el cierre es **explícito por finalización del trabajo** — el dev acaba de pasar la story a `done`, todo el tiempo hasta ahora es trabajo real (incluyendo el closing en ADO).

## Acción — setear `status: done` en el frontmatter (MANDATORY fix robusto 2026-05-20)

Tras postear el comment en ADO y transicionar el WI a `Closed`, **mutar el frontmatter de la story a `status: done`**. Source of truth durable cross-sesión:

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js update-story-status \
  "$STORY_PATH" "done"
```

**Idempotente** — si el dev ya lo seteó manual a `done` antes de invocar Step 9, el comando re-escribe el mismo valor sin error.

**Garantiza** que el cierre ADO y el frontmatter quedan en lockstep. Una sesión futura que abra `tycon-pipeline` sobre esta story va a leer `done` y NO va a re-arrancar el pipeline (PIPE-C5 del Step 0 lo detecta y rechaza).

**Después de esto, `marker.js clear`** para limpiar el marker per-session de esta sesión:

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js clear
```

(Si Step 8 ya lo había cleaneado y Step 9 viene independiente, el clear acá es no-op silencioso.)

## Output

Mensaje al dev al final:

```
✅ Story <id> cerrada en ADO.
- Work item: <ado_org>/<ado_project>/_workitems/edit/<wi_id>
- Comment posteado con: <N> commits + CI run #<run-id> + PR <pr-id-o-N/A> + tiempo <Xh YYm>
- State: → Closed
- Timer Clockify cerrado: duración total <Xh YYm>   (omitir línea si no había timer activo)
- Frontmatter `.md` → status: done (source of truth durable).
- Marker pipeline → cleared.

Listo.
```

## Anti-patterns

- ❌ NO postear el comment ANTES del merge a main — los SHAs y CI run no están disponibles aún.
- ❌ NO inventar SHAs ni CI runs. Si no podés obtenerlos automáticamente, preguntá al dev.
- ❌ NO transicionar state sin postear comment — el comment es la evidencia de auditoría.
- ❌ NO postear comment sin confirmar la lista de commits con el dev — falsos positivos del grep llenan ADO de basura.
- ❌ NO cerrar work items que NO sean User Story (Epic, Feature, Task siguen reglas distintas — este step es específico a stories).
- ❌ NO ejecutar este step sobre una story en `ready-for-dev` o `in-progress` — es señal de que el flujo no completó el Step 8. `review` (lo normal, post Step 8) y `done` (si el dev ya lo movió a mano) son los DOS estados válidos de entrada, y están en la pre-condición 5.
- ❌ NO inventar `time_tracked` cuando Clockify no devuelve entries. Mejor omitir el campo que postear un número fabricado — la trazabilidad de horas es billing-grade.
- ❌ NO usar wall-clock (`merge_date - first_commit_date`) como sustituto del tiempo Clockify. Eso es lead time, NO trabajo real.

## Por qué existe

El nivel de trazabilidad que se deja al cerrar es commit SHA(s) + CI run + PR link, como mínimo regulatorio (hay clientes con requirements de auditoría). El step está documentado acá para que sea consistente entre stories y no dependa de la memoria del dev.


## Timing dump del run (automático desde 2026-06-11)

`marker.js clear` (el cierre del pipeline) archiva automáticamente el marker completo +
los gates de la sesión en `~/.claude/.tycon-pipeline/timing-history/<storyId>-<ts>.json`
y una copia en `<repo>/.advisors/pipeline-runs/<run>/timing-dump-<ts>.json` — la curva de
costo por run (steps, iteraciones, gates con duración) sin auditoría forense. Citarlo en
el comment de cierre de ADO / la retro si el run fue anómalo. `pipeline.js timing-report`
sigue disponible para el desglose human-readable DURANTE la corrida.
