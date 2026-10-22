# Arranque: pedido en ADO

**Objetivo**: cuando el dev invoca el pipeline para trabajar una story, transicionar el work item de Azure DevOps del estado inicial (`New` / `To Do` / `Approved`) a **`Active`** (o equivalente según process template). Espejo de simetría con `step-09-ado-story-closure.md` que cierra el ciclo.

**Posición en el flujo**: corre inmediatamente DESPUÉS de `step-00b-work-start.md`. Mismo momento conceptual: ya se decidió arrancar a trabajar. **Desde 2026-07-30 corre EN PARALELO con el validator del Step 1** (fan-out del arranque — ver step-00b §Fan-out): el validator ya está lanzado en background mientras este step ejecuta inline. No comparten datos (este step solo lee frontmatter + config ADO). Si este step necesita confirmación del dev (fallback por título, WI cerrado), resolverla ANTES de procesar el reporte del validator, con la pregunta claramente rotulada como de ADO.

## Cuándo se ejecuta

- **Siempre que la story tenga `work_item:` en el frontmatter** (o su nombre viejo, `ado_work_item:`, que se sigue leyendo) (ver `~/.claude/tycon-harness/story-format.md`) → leer el id y proceder.
- Si la story NO tiene `work_item:` en el frontmatter → con Azure DevOps, **intentar la búsqueda fallback por título** antes de saltear (sección de abajo); con otra plataforma, o sin ninguna, saltear con UNA línea que diga qué falta. Nunca en silencio.

### Búsqueda fallback por título (gap fix 2026-05-13)

**Sólo con Azure DevOps.** Primero, qué plataforma atiende los pedidos de trabajo (la capa lo dice sin pedir nada):

```bash
node ~/.claude/tycon-harness/scripts/lib/platform/platform.js choose work-item update
# → {"ok": true, "value": {"connector": "azure-devops", …}}  o  {"ok": false, "reason": "sin_plataforma", "detail": "…"}
```

- `connector` distinto de `azure-devops`, o `ok: false` → no hay búsqueda por título: el paso dice en UNA línea «la historia no tiene pedido de trabajo (`work_item:`); se crea con la skill de creación o al cerrar» (o el `detail`, si no hay plataforma) y sigue.
- `azure-devops`, y la configuración del repo resuelve (`.tycon/work-items.yaml` o `.tycon/ado-config.yaml`, o `ado.org` de la máquina) → buscar por título antes de saltear:

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

- **Match único** (1 WI con `${story_id}` en el título): proponer al dev *"Encontré WI #{id} '{title}' que parece corresponder a esta story. ¿Agrego `work_item: {id}` al frontmatter y transiciono?"*. Si confirma → escribirlo con `node ~/.claude/tycon-harness/scripts/lib/platform/work-item-field.js set <story_path> {id}` + transicionar.
- **Múltiples matches** (>1 WI): mostrar lista top-5 al dev y pedir confirmación de cuál es. Misma acción post-confirmación.
- **Cero matches**: una línea "ningún WI con `${story_id}` en el título — skip transición. Considera crear el WI antes de mergear o agregar `work_item:` manualmente al frontmatter". Continuar pipeline sin transicionar.

**Por qué esta búsqueda fallback existe**: en proyectos con sprint planning ya completado en ADO (caso típico TYCON), los WIs preexisten a las stories markdown — la story se crea en specs/stories/ después y muchas veces el dev olvida linkear el id. Antes del fallback, esos casos resultaban en skip silencioso → board nunca reflejaba WIP, gap detectado solo por inspección manual. Con el fallback, el orquestador hace una propuesta detectada del link en cada arranque de pipeline.

**Por qué**: una story con el frontmatter sin `work_item:` puede tener igual un work item ya existente con su título (por ejemplo en estado `Committed`). Sin esta búsqueda fallback, el board del cliente y del PM nunca refleja que la story está en progreso.

## Pre-condiciones

1. `step-00-preflight.md` pasó (rama OK, no estamos en `main`/`master`).
2. El id del pedido de trabajo de la historia, con el lector común (lee `work_item:` y su nombre viejo `ado_work_item:`):
   `node ~/.claude/tycon-harness/scripts/lib/platform/work-item-field.js get <story_path>` (sale 3 si no tiene). Sin
   id → **NO skipear todavía**: primero la búsqueda fallback por título (sección de arriba). Sólo si esa búsqueda no
   devuelve un match único, skipear.
3. Dónde vive el pedido lo decide la capa de plataforma: la plataforma la elige el perfil del equipo
   (`integrations.platform`), y el destino, `.tycon/work-items.yaml` del repo (o `.tycon/ado-config.yaml`, el nombre
   viejo, que se sigue leyendo; con los dos gana el nuevo). El paso no arma comandos de ninguna plataforma.

## Acción

```bash
node ~/.claude/tycon-harness/scripts/lib/platform/platform.js work-item update \
  --args '{"repoDir": "<repo de la historia>", "id": <id>}'
# → {"ok": true, "value": {"id", "estado", "previo", "changed", "warnings"}, "summary": "…"}
#   o {"ok": false, "reason": "sin_plataforma|sin_credencial|no_encontrado|…", "detail": "…", "summary": "…"}
```

La capa lee el estado actual y lo pasa al activo, sin tocar nada si ya estaba:

- **Ya activo** → `changed: false`, no se toca.
- **Cerrado** (`Closed` / `Resolved` / `Done`, o el issue cerrado en GitHub) → `changed: false` y un aviso en `warnings`:
  **preguntarle al dev** si reabrirlo (*"El pedido {id} está en `{estado}`. ¿Reabrirlo? Puede romper la trazabilidad si la
  story estaba cerrada por otro motivo."*). Si confirma, repetir con `"reopen": true` en los argumentos.
- **Inicial** → pasa al activo. En Azure DevOps, según la plantilla de proceso (Basic `To Do` → `Doing`; Agile `New` /
  `Approved` → `Active`; CMMI `Proposed` → `Active`; Scrum `New` → `Committed`, declarado con `state_active`); en GitHub,
  la etiqueta `estado:<state_active>` (por defecto `estado:activo`). Lo que diga `state_active` en la configuración
  del repo manda.
- **Asignación**: con `auto_assign: true` en la configuración, sumar `"assignTo": "<git config user.email>"` a los
  argumentos. **No por default** — algunos equipos asignan por separado.

**Si la transición fue exitosa** (o el pedido ya estaba activo), registrar el flag en el marker para que un resume
cross-session / `pipeline.js next` NO re-transicionen el pedido:

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js set-flag adoMarkedActive true
```

**Un «no» NO bloquea el pipeline**: `ok: false` (sin plataforma elegida, sin credencial, pedido no encontrado, la
plataforma lo rechazó) → mostrar el `summary` en UNA línea (dice qué falta y cómo ponerlo) y seguir sin transicionar.

**Por qué NO bloquear**: el pipeline tiene que poder funcionar aunque la plataforma esté caída, la credencial vencida o el
pedido se haya movido. La trazabilidad es **importante pero no crítica** para implementar la story (a diferencia de
step-04 build-gate que sí es crítico).

## Output

Log a `.advisors/pipeline-runs/<clave>-<sello>/step-00c-ado.md`:

```markdown
# step-00c — ADO mark active

- Pedido de trabajo: <id>
- State previo: <previous_state>
- State nuevo: <new_state>
- Asignado a: <user-email o "no cambiado">
- Resultado: ok | skipped-already-active | skipped-no-config | warned-was-closed | error-<descripcion>
```

Mensaje sucinto al dev (parte del header general del pipeline, NO un mensaje aparte):

- Si transicionado: el `summary` de la capa (`pedido de trabajo #{id} en <plataforma>: {previo} → {estado}`).
- Si skipped: una sola línea contextual o nada (no inundar al dev al inicio del pipeline).

## Anti-patterns

- ❌ NO **preguntarle al dev** por un `work_item:` que falta — eso lo resuelve el step-09 al
  cerrar. Acá: fallback por título (sólo con Azure DevOps), y si no hay match único, saltear con una línea que lo diga.
- ❌ NO bloquear el pipeline por errores ADO. La implementación de la story no depende de ADO.
- ❌ NO reabrir WIs cerrados sin confirmación explícita del dev.
- ❌ NO transicionar a estados intermedios desconocidos sin mapping documentado (defaultear a `Active` y loggear el state name detectado para que el dev pueda agregar override si su template usa otro nombre).
- ❌ NO duplicar este step en step-04 ("execution starts") — al momento de step-04, el WI ya está en `Active` desde acá. Re-transicionar es ruido en el history del WI.

## Por qué existe

Es la simetría de step-09 (cierre con trazabilidad): que el INICIO del trabajo también se refleje en ADO. Sin este step, el board muestra todos los WIs en `New` aunque el dev esté implementando — el cliente y el PM no pueden ver el WIP real desde el board.

## Referencia cruzada

- `step-00b-work-start.md` — le avisa el trabajo a la herramienta de horas. Step-00c es su simétrico ADO: ambos disparan al iniciar, ambos son opcionales-silent-skip si no hay config.
- `step-09-ado-story-closure.md` — cierra el WI con trazabilidad (commits + CI run + PR link). Step-00c y step-09 son los extremos del ciclo de vida ADO de la story.
