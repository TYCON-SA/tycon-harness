# Arranque: pedido en ADO

**Objetivo**: cuando el dev invoca el pipeline para trabajar una story, transicionar el work item de Azure DevOps del estado inicial (`New` / `To Do` / `Approved`) a **`Active`** (o equivalente según process template). Espejo de simetría con `step-09-ado-story-closure.md` que cierra el ciclo.

**Posición en el flujo**: corre inmediatamente DESPUÉS de `step-00b-work-start.md`. Mismo momento conceptual: ya se decidió arrancar a trabajar. **Desde 2026-07-30 corre EN PARALELO con el validator del Step 1** (fan-out del arranque — ver step-00b §Fan-out): el validator ya está lanzado en background mientras este step ejecuta inline. No comparten datos (este step solo lee frontmatter + config ADO). Si este step necesita confirmación del dev (fallback por título, WI cerrado), resolverla ANTES de procesar el reporte del validator, con la pregunta claramente rotulada como de ADO.

## Cuándo se ejecuta

- **Siempre que la story tenga `ado_work_item:` en el frontmatter** (ver `~/.claude/tycon-harness/story-format.md`) → leer el id y proceder.
- Si la story NO tiene `ado_work_item:` en el frontmatter → **intentar búsqueda fallback por título** ANTES de skipear (ver sección "Búsqueda fallback por título" abajo). Solo skipear silenciosamente si la búsqueda fallback no encuentra match único.

### Búsqueda fallback por título (gap fix 2026-05-13)

Si el frontmatter no tiene `ado_work_item:` pero la config ADO sí resuelve (`.tycon/ado-config.yaml` del repo, o `ado.org` de la configuración del arnés — ver «Pre-condiciones»), ejecutar `az boards query` por título antes de skipear:

```bash
# Extraer story_id del frontmatter (ej: "2.9") + título corto
story_id=$(yq '.story' <(sed -n '/^---$/,/^---$/p' <story_path>))
story_title=$(yq '.title' <(sed -n '/^---$/,/^---$/p' <story_path>))

az boards query \
  --organization <ado_org> \
  --project <ado_project> \
  --wiql "SELECT [System.Id], [System.Title], [System.State] FROM workitems WHERE [System.TeamProject] = '<ado_project>' AND [System.Title] CONTAINS '${story_id}'" \
  --output json
```

Decisión post-query:

- **Match único** (1 WI con `${story_id}` en el título): proponer al dev *"Encontré WI #{id} '{title}' que parece corresponder a esta story. ¿Agrego `ado_work_item: {id}` al frontmatter y transiciono?"*. Si confirma → editar el `.md` de la story + transicionar.
- **Múltiples matches** (>1 WI): mostrar lista top-5 al dev y pedir confirmación de cuál es. Misma acción post-confirmación.
- **Cero matches**: log "ningún WI con `${story_id}` en el título — skip transición. Considera crear el WI antes de mergear o agregar `ado_work_item:` manualmente al frontmatter". Continuar pipeline sin transicionar.

**Por qué esta búsqueda fallback existe**: en proyectos con sprint planning ya completado en ADO (caso típico TYCON), los WIs preexisten a las stories markdown — la story se crea en specs/stories/ después y muchas veces el dev olvida linkear el id. Antes del fallback, esos casos resultaban en skip silencioso → board nunca reflejaba WIP, gap detectado solo por inspección manual. Con el fallback, el orquestador hace una propuesta detectada del link en cada arranque de pipeline.

**Por qué**: una story con el frontmatter sin `ado_work_item:` puede tener igual un work item ya existente con su título (por ejemplo en estado `Committed`). Sin esta búsqueda fallback, el board del cliente y del PM nunca refleja que la story está en progreso.

## Pre-condiciones

1. `step-00-preflight.md` pasó (rama OK, no estamos en `main`/`master`).
2. Frontmatter de la story leído. Si falta `ado_work_item:` → **NO skipear todavía**: primero la
   búsqueda fallback por título (sección de arriba). Sólo si esa búsqueda no devuelve un match
   único, skipear.
3. Config ADO resuelto (mismo orden de prioridad que step-09):
   - `.tycon/ado-config.yaml` en el repo → `ado_org` + `ado_project` (manda: un repo de cliente puede vivir en otra organización)
   - la configuración del arnés → `ado.org`: `node ~/.claude/tycon-harness/scripts/lib/tycon-config.js get ado.org`
     (lee `TYCON_ADO_ORG`, `~/.claude/tycon.json` y el perfil del equipo, en ese orden; exit 3 = sin organización; exit 2 =
     configuración rota, y se dice con archivo, clave y motivo); el proyecto, de `TYCON_ADO_PROJECT` o preguntando al dev
   - **sin organización = Azure DevOps apagada en esta máquina**: el step lo dice en UNA línea («Azure DevOps apagado en
     esta máquina — el work item no se toca; prender: ado.org en ~/.claude/tycon.json o TYCON_ADO_ORG»), no llama a `az`
     y se saltea (exit 0). Ya no hay un nivel «tabla por proyecto»: la tabla de `guides/integrations/ado-projects.md` es
     referencia para personas, no algo que el pipeline lee.

Si config ADO no resuelve (Azure DevOps apagada) → skip con esa línea (no bloquea pipeline). Log el motivo en `.advisors/pipeline-runs/<clave>-<sello>/step-00c-ado.md`.

## Idempotencia

Antes de transicionar, leer el state actual del WI:

```bash
az boards work-item show \
  --organization <ado_org> \
  --id <ado_work_item_id> \
  --query "fields.\"System.State\"" \
  --output tsv
```

Reglas:

- Si el state actual ya es `Active` (o equivalente) → no hacer nada, log "WI {id} ya en Active, skip".
- Si el state actual es `Closed` / `Resolved` / `Done` → **ADVERTIR al dev** antes de transicionar: *"El WI {id} está en `{state}`. ¿Reabrir a `Active`? Esto puede romper trazabilidad si la story estaba cerrada por otro motivo."* Esperar confirmación.
- Si el state es `New` / `To Do` / `Approved` / `Committed` → transicionar a `Active`.

## Mapping de estados (process templates ADO)

ADO tiene varios process templates con state names distintos. El step debe detectar y mapear:

| Process Template | Initial states (que cuentan como "no started") | Active equivalent |
|---|---|---|
| **Basic** | `To Do` | `Doing` |
| **Agile** | `New`, `Approved` | `Active` |
| **Scrum** | `New` | `Committed` |
| **CMMI** | `Proposed` | `Active` |

Detección: el primer `az boards work-item show` devuelve el state actual. Si está en alguno de la columna izquierda, transicionar al equivalente de la columna derecha.

**Override del dev**: si el proyecto usa un process custom, permitir override via `.tycon/ado-config.yaml`:

```yaml
ado_org: https://dev.azure.com/<organizacion>
ado_project: Ceibo
ado_state_active: "Active"   # default
ado_state_closed: "Closed"   # default (consumido por step-09)
```

## Acción

```bash
# 1. Detectar state actual (idempotencia + warning si ya cerrado)
current_state=$(az boards work-item show --organization <ado_org> --id <wi_id> \
  --query "fields.\"System.State\"" --output tsv)

# 2. Decidir: skip / warn-and-confirm / transicionar (ver Idempotencia arriba)

# 3. Transicionar
az boards work-item update \
  --organization <ado_org> \
  --id <wi_id> \
  --state "Active"   # o el mapping correspondiente al process template
```

**Si la transición fue exitosa** (o el WI ya estaba en `Active`), registrar el flag en el marker para que un resume cross-session / `pipeline.js next` NO re-transicionen el WI:

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js set-flag adoMarkedActive true
```

**Manejo de errores** (todos NO bloquean el pipeline — log y continuar):

- 401/403: token vencido → log "renueva AZURE_DEVOPS_EXT_PAT", continuar pipeline sin transicionar.
- 404: WI no existe → log "ado_work_item {id} no encontrado en {org}/{project}; ¿campo desactualizado en frontmatter?", continuar.
- State name inválido (proyecto usa nombres custom no mapeados) → log con la lista de states válidos del WI, continuar.

**Por qué NO bloquear**: el pipeline TYCON tiene que poder funcionar incluso si ADO está caído / el token venció / el WI fue movido. La trazabilidad ADO es **importante pero no crítica** para implementar la story (a diferencia de step-04 build-gate que sí es crítico).

## Asignación del WI al dev (opcional)

Si el dev quiere que además del state, se asigne el WI a sí mismo:

```bash
az boards work-item update \
  --organization <ado_org> \
  --id <wi_id> \
  --assigned-to "<email-del-dev>"
```

El email se resuelve de `git config user.email`. **No hacerlo por default** — algunos equipos manejan asignaciones por separado (ej. dueño técnico vs implementador). Activar via `ado_auto_assign: true` en `.tycon/ado-config.yaml`.

## Output

Log a `.advisors/pipeline-runs/<clave>-<sello>/step-00c-ado.md`:

```markdown
# step-00c — ADO mark active

- WI ID: <ado_work_item_id>
- State previo: <previous_state>
- State nuevo: <new_state>
- Asignado a: <user-email o "no cambiado">
- Resultado: ok | skipped-already-active | skipped-no-config | warned-was-closed | error-<descripcion>
```

Mensaje sucinto al dev (parte del header general del pipeline, NO un mensaje aparte):

- Si transicionado: `📋 ADO WI #{id}: {previous_state} → {new_state}.`
- Si skipped: una sola línea contextual o nada (no inundar al dev al inicio del pipeline).

## Anti-patterns

- ❌ NO **preguntarle al dev** por un `ado_work_item:` que falta — eso lo resuelve el step-09 al
  cerrar. Acá: fallback por título (ver Pre-condiciones §2), y si no hay match único, skip silencioso.
- ❌ NO bloquear el pipeline por errores ADO. La implementación de la story no depende de ADO.
- ❌ NO reabrir WIs cerrados sin confirmación explícita del dev.
- ❌ NO transicionar a estados intermedios desconocidos sin mapping documentado (defaultear a `Active` y loggear el state name detectado para que el dev pueda agregar override si su template usa otro nombre).
- ❌ NO duplicar este step en step-04 ("execution starts") — al momento de step-04, el WI ya está en `Active` desde acá. Re-transicionar es ruido en el history del WI.

## Por qué existe

Es la simetría de step-09 (cierre con trazabilidad): que el INICIO del trabajo también se refleje en ADO. Sin este step, el board muestra todos los WIs en `New` aunque el dev esté implementando — el cliente y el PM no pueden ver el WIP real desde el board.

## Referencia cruzada

- `step-00b-work-start.md` — le avisa el trabajo a la herramienta de horas. Step-00c es su simétrico ADO: ambos disparan al iniciar, ambos son opcionales-silent-skip si no hay config.
- `step-09-ado-story-closure.md` — cierra el WI con trazabilidad (commits + CI run + PR link). Step-00c y step-09 son los extremos del ciclo de vida ADO de la story.
