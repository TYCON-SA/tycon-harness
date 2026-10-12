---
name: tycon-ado-story-wi
description: Crea el work item en Azure DevOps cuando se crea una story Mary+GOLD y escribe el `ado_work_item:` de vuelta en el frontmatter. Resuelve la config ADO del repo (.tycon/ado-config.yaml → env vars → preguntar), auto-detecta el tipo de WI por process template, pide confirmación al dev antes de crear, y linkea el WI como hijo del Epic. Usar cuando un hook emite el reminder "tycon-ado-story-wi STORY-CREATE-detect", cuando el usuario pide "crear el work item en ADO para esta story", o tras crear stories con tycon-create-story / bmad-create-epics-and-stories.
---

# tycon-ado-story-wi — Crear el Work Item en ADO al crear la story

## Propósito

Cuando se crea una story Mary+GOLD (vía `tycon-create-story`, `bmad-create-epics-and-stories`,
`gds-create-story`, o a mano), este skill crea el **work item correspondiente en Azure
DevOps** y escribe `ado_work_item: <id>` de vuelta en el frontmatter de la story.

Cierra el gap que tenía el pipeline TYCON: hasta ahora `step-00c-ado-mark-active` y
`step-09-ado-story-closure` (de `tycon-pipeline`) **consumían** `ado_work_item:` pero nadie
lo **creaba** — el dev tenía que crear el WI a mano en la web de ADO y linkearlo. Este skill
automatiza esa creación, manteniendo el dev en el loop con una confirmación.

```
tycon-create-story  ──►  story.md (sin ado_work_item)
                              │
                   hook on-story-create.js detecta
                              │
                              ▼
                   tycon-ado-story-wi  ──►  az boards work-item create
                              │                      │
                              ▼                      ▼
              ado_work_item: <id> escrito      WI en ADO (hijo del Epic)
              en el frontmatter
```

## Cuándo se ejecuta

1. **Disparado por hook** — el hook `scripts/on-story-create.js` (`PostToolUse` matcher
   `Write`) detecta una story Mary+GOLD recién creada sin `ado_work_item:` y emite el
   reminder `tycon-ado-story-wi STORY-CREATE-detect`. El agente invoca este skill.
2. **Invocación manual** — el usuario pide "crear el WI en ADO para esta story" /
   "linkeá esta story a ADO".
3. **Batch** — tras `bmad-create-epics-and-stories` (varias stories de una): invocar el
   skill UNA vez con cualquiera de las stories; escanea el directorio y procesa todas las
   que falten `ado_work_item:`.

**Argumento**: ruta absoluta de la story `.md` (la pasa el hook). Si no se pasa argumento,
preguntar al dev cuál es la story / directorio.

## Pre-condiciones

- `az` CLI instalado con la extensión `azure-devops` (`az extension add --name azure-devops`).
- `AZURE_DEVOPS_EXT_PAT` exportada (token con scope **Work Items: Read & Write**). Es la
  misma variable que usan `step-00c` y `step-09`.

Si falta el CLI o el token → **no crear el WI**. Avisar al dev una línea y terminar
(no bloquear ningún flujo: la creación del WI es importante pero no crítica).

---

## Paso 1 — Resolver la config ADO del repo

Mismo orden de prioridad que `tycon-pipeline/steps/step-00c-ado-mark-active.md` y
`step-09`. Walk-up desde la story `.md` hasta encontrar el root del repo
(`.git/` o `.tycon/`):

1. **`.tycon/ado-config.yaml`** en el root del repo — fuente de verdad preferida (un repo de
   cliente puede vivir en otra organización).
2. **La configuración del arnés** — `ado.org`:
   `node ~/.claude/tycon-harness/scripts/lib/tycon-config.js get ado.org` (lee `TYCON_ADO_ORG`,
   `~/.claude/tycon.json` y el perfil del equipo, en ese orden; exit 3 = sin organización; exit 2 =
   configuración rota, y se dice con archivo, clave y motivo). El project: `TYCON_ADO_PROJECT`, o
   preguntar al dev.
3. **Sin organización = Azure DevOps apagada en esta máquina** — decirlo en UNA línea («Azure DevOps
   apagado en esta máquina — el work item no se crea; prender: ado.org en ~/.claude/tycon.json o
   TYCON_ADO_ORG»), no llamar a `az` y terminar bien. Ya no hay un nivel «tabla por proyecto».

Schema completo de `.tycon/ado-config.yaml` (ver también `~/.claude/tycon-harness/guides/ado-projects.md`):

```yaml
ado_org: https://dev.azure.com/<organizacion>
ado_project: Ceibo
ado_wi_type: ""                 # opcional — override del tipo de WI. Vacío = auto-detectar.
ado_area_path: "Ceibo"         # opcional — default = nombre del project.
ado_iteration_path: ""          # opcional — override LITERAL del iteration. Si está seteado, pisa la auto-derivación desde `sprint:` del frontmatter.
ado_iteration_root: ""          # opcional — root del template Sprint N. Default = `ado_project` (ej "Ceibo"). Combinado con `sprint:` del frontmatter da `<root>\\Sprint <N>`.
ado_iteration_auto_from_frontmatter: true  # opcional — default true. Si la story tiene `sprint: N` en el frontmatter, setea automáticamente `IterationPath=<root>\\Sprint <N>`. Override con `ado_iteration_path` literal o flag en `false`.
ado_state_active: "Active"      # consumido por step-00c
ado_state_closed: "Closed"      # consumido por step-09
ado_auto_assign: false          # si true, asigna el WI a git config user.email
ado_default_tags: "tycon-pipeline"  # opcional — tags separados por ;
epic_links:                     # opcional — mapeo epic (frontmatter) → WI id del Epic/Feature en ADO
  1: 12001
  2: 12002
  3: 12003
```

**Si la config NO resuelve por ninguna vía** → log "tycon-ado-story-wi: repo sin config ADO,
WI no creado para story <id>" y terminar. No es error: hay repos TYCON que no trackean en ADO.

Si la config resuelve por env vars o por respuesta del dev (no por archivo), **ofrecer crear
`.tycon/ado-config.yaml`** con lo resuelto para que las próximas corridas no pregunten.

---

## Paso 2 — Auto-detectar el tipo de work item

Si `ado_wi_type` está seteado en la config → usar ese valor, saltar la detección.

Si no, detectar por process template del project:

```bash
process=$(az devops project show \
  --organization <ado_org> --project <ado_project> \
  --query "capabilities.processTemplate.templateName" --output tsv)
```

⚠️ Los projects TYCON suelen usar un nombre de process **custom** derivado de un base
process — ej: Ceibo reporta `Ceibo Scrum`, no `Scrum`. Por eso el mapeo es por
**substring case-insensitive**, NO por igualdad exacta:

| Si el nombre del template contiene… | Tipo de WI | `ado_state_active` | `ado_state_closed` |
|---|---|---|---|
| `Scrum` | `Product Backlog Item` | `Committed` | `Done` |
| `Agile` | `User Story` | `Active` | `Closed` |
| `CMMI`  | `Requirement` | `Active` | `Closed` |
| `Basic` | `Issue` | `Doing` | `Done` |
| (ninguno matchea) | preguntar al dev + sugerir fijar `ado_wi_type` en la config | — | — |

Si la detección falla (token, red, nombre no mapeable) → preguntar al dev el tipo y sugerir
fijarlo en `ado_wi_type` de la config. El CLI no lista los tipos de WI directo; si hace
falta enumerarlos: `az devops invoke --area wit --resource workitemtypes --route-parameters
project=<project> --organization <ado_org>`.

---

## Paso 3 — Armar los campos del WI desde la story

Parsear el frontmatter + cuerpo de la story `.md`:

| Campo ADO | Origen en la story |
|---|---|
| `System.Title` | `Story {story}: {title}` del frontmatter (ej: `Story <N.M>: POST /voice/calls ...`) |
| `System.Description` | el bloque `## Story` (el "Como X, quiero Y, para Z") + una línea `Spec: <ruta de la story .md>` |
| `Microsoft.VSTS.Common.AcceptanceCriteria` | la sección `## Acceptance Criteria` completa, convertida a HTML simple (los campos rich-text de ADO son HTML) |
| `Microsoft.VSTS.Common.Priority` | mapear `priority` del frontmatter: `P0`→`1`, `P1`→`2`, `P2`→`3`, `P3`→`4` |
| `System.AreaPath` | `ado_area_path` de la config (o el project) |
| `System.IterationPath` | ver "Resolución del IterationPath" abajo |
| `System.Tags` | `ado_default_tags` de la config + `sprint-{N}` si la story tiene `sprint:` |

Notas:
- Los campos rich-text (`Description`, `AcceptanceCriteria`) son **HTML** en ADO. Convertir
  el markdown a HTML básico: párrafos `<p>`, listas `<ul><li>`, `<br>` para saltos. No hace
  falta nada sofisticado — preservar el texto y la estructura de lista.
- Escapar comillas en los valores antes de pasarlos a `--fields`.

### Resolución del IterationPath (orden de prioridad)

Para evitar que los WIs caigan en el backlog general cuando la story ya declara su sprint en el frontmatter (`sprint: N`), aplicar este orden:

1. **`ado_iteration_path` de la config** — si está seteado (string literal no vacío), usar **textual** ese valor. Es el override más fuerte (útil para sprints con nombre custom o casos especiales).
2. **Auto-derivar desde `sprint:` del frontmatter** — si `ado_iteration_auto_from_frontmatter` es `true` (default) **y** la story tiene `sprint: N` en el frontmatter (entero), construir el path:
   ```
   <ado_iteration_root o ado_project>\Sprint <N>
   ```
   Ej: con `ado_iteration_root="Ceibo"` (o `ado_project="Ceibo"`) y `sprint: 5` → `Ceibo\Sprint 5`. Asume convención TYCON `Sprint <N>` como nombre del iteration (verificable con `az boards iteration project list --project <p>`).
3. **Si nada de lo anterior aplica** → omitir el campo (cae en backlog general del project).

**Best-effort de validación**: si la auto-derivación produce un path, una vez por sesión chequear que el iteration exista (`az boards iteration project list --project <p>`). Si NO existe, fallback a backlog + warning al dev. NO bloquear creación del WI.

**Tag `sprint-<N>` sigue agregándose** independientemente del IterationPath resuelto — el tag es trazabilidad spec-side, el IterationPath es scheduling-side. Pueden divergir si el WI se mueve en ADO sin actualizar la spec.

**Por qué**: con `ado_iteration_path: ""` en la config, un WI cae en el backlog (`IterationPath=<proyecto>`) aunque la story tenga `sprint: <N>` en el frontmatter, y hay que moverlo a mano con `az boards work-item update --iteration "<proyecto>\Sprint <N>"`. Resolver el IterationPath desde el sprint de la story cierra ese gap.

---

## Paso 4 — Confirmar con el dev (OBLIGATORIO)

Antes de ejecutar `az boards work-item create`, mostrar al dev un resumen y **esperar
confirmación explícita** (`dale` / `sí` / `ok`):

```
Voy a crear este work item en Azure DevOps:

  Org / Project : <ado_org> / <ado_project>
  Tipo          : <wi_type>   (auto-detectado por process <template> | override config)
  Título        : Story <story>: <title>
  Priority      : <P0..P3 → 1..4>
  Area Path     : <area_path>
  Iteration     : <iteration_path o "(backlog)">   (origen: literal config | auto desde sprint:N | omitido)
  Parent        : Epic #<epic_wi_id>  |  (suelto — sin mapeo epic_links para epic <N>)

¿Lo creo? (dale / no)
```

Si el dev dice que no → terminar sin crear, no escribir nada en el frontmatter.

**Modo batch**: si hay varias stories, mostrar la tabla de todas y pedir UNA confirmación
para el lote (o dejar que el dev excluya algunas).

---

## Paso 5 — Crear el work item

```bash
az boards work-item create \
  --organization "<ado_org>" \
  --project "<ado_project>" \
  --type "<wi_type>" \
  --title "Story <story>: <title>" \
  --fields \
    "System.Description=<html>" \
    "Microsoft.VSTS.Common.AcceptanceCriteria=<html>" \
    "Microsoft.VSTS.Common.Priority=<1..4>" \
    "System.AreaPath=<area_path>" \
    "System.IterationPath=<iteration_path>" \
    "System.Tags=<tags>" \
  --output json
```

El JSON de respuesta trae `.id` → es el `ado_work_item`.

Si `ado_auto_assign: true` → agregar `--assigned-to "$(git config user.email)"`.

**Manejo de errores** (ninguno bloquea — log y avisar al dev):
- `401` / `403` → token vencido o sin scope Work Items R/W. Avisar "renová `AZURE_DEVOPS_EXT_PAT`".
- Campo inválido (`AreaPath`/`IterationPath` no existe en el project) → reintentar sin ese
  campo y avisar al dev qué path usar.
- Tipo de WI inválido → pedir al dev el tipo correcto y sugerir fijar `ado_wi_type` en la
  config (ver el comando `az devops invoke ... workitemtypes` del Paso 2 para enumerarlos).

---

## Paso 6 — Linkear como hijo del Epic

Si la story tiene `epic: <N>` en el frontmatter **y** la config tiene `epic_links[<N>]`:

```bash
az boards work-item relation add \
  --organization "<ado_org>" \
  --id <nuevo_wi_id> \
  --relation-type parent \
  --target-id <epic_links[N]> \
  --output json
```

Si **no** hay entrada en `epic_links` para ese epic → crear el WI **suelto** (sin parent)
y avisar al dev una línea:

```
WI #<id> creado suelto — no hay mapeo `epic_links: { <N>: ... }` en .tycon/ado-config.yaml.
Si querés la jerarquía: agregá el WI id del Epic <N> de ADO al config y re-linkeo, o
linkealo a mano en el board.
```

No bloquear por esto: el WI igual queda creado y trackeable.

---

## Paso 7 — Escribir `ado_work_item:` de vuelta en el frontmatter

Editar la story `.md`: insertar `ado_work_item: <id>` en el frontmatter. Ubicación:
inmediatamente después de la línea `depends_on:` (o antes del bloque `pipelines:` si existe,
o como última línea del frontmatter si no hay ninguno de los dos).

```yaml
depends_on: ["2.1", "2.2"]
ado_work_item: 4571          # ← agregado por tycon-ado-story-wi
```

Esto es lo que hace que `step-00c` (marcar Active al implementar) y `step-09` (cerrar con
trazabilidad) funcionen sin búsqueda fallback por título.

---

## Paso 8 — Reporte al dev

Una sola línea por story creada:

```
📋 ADO: WI #<id> creado (User Story) para Story <N.M> — hijo de Epic #<id>. Frontmatter actualizado.
```

Si hubo skip:

```
📋 ADO: skip — repo sin config ADO (.tycon/ado-config.yaml ausente, sin env vars). Story <N.M> sin WI.
```

---

## Anti-patterns

- ❌ NO crear el WI sin confirmación del dev. Stories que se descartan dejarían WIs huérfanos
  en el board del cliente.
- ❌ NO bloquear ningún flujo (creación de story, pipeline) por errores de ADO. Log + avisar
  + seguir.
- ❌ NO crear un WI si la story YA tiene `ado_work_item:`. El hook ya filtra esto, pero
  re-chequear en el skill por si se invoca a mano.
- ❌ NO inventar el WI id del Epic para el parent link. Si no está en `epic_links` → suelto + warn.
- ❌ NO duplicar: antes de crear, si la config resuelve, considerar una `az boards query` por
  el story id en el título (igual que el fallback de `step-00c`) — si ya existe un WI para
  esa story, proponer linkear ese en vez de crear uno nuevo.

## Referencia cruzada

- `tycon-pipeline/steps/step-00c-ado-mark-active.md` — transiciona el WI a `Active` al
  empezar a implementar. Consume el `ado_work_item:` que este skill escribe.
- `tycon-pipeline/steps/step-09-ado-story-closure.md` — cierra el WI con trazabilidad
  post-merge. Otro consumidor de `ado_work_item:`.
- `~/.claude/tycon-harness/guides/ado-projects.md` — schema de `.tycon/ado-config.yaml`,
  tabla de mapeo proyecto→ADO, y bloque de registro del hook.
- `~/.claude/tycon-harness/story-format.md` §1 — el campo `ado_work_item` del frontmatter.

## Por qué existe

El pipeline TYCON ya tenía los rails de **consumo** (`step-00c`, `step-09`) pero la **creación**
del WI era 100% manual — el dev abría la web de ADO, creaba el User Story, copiaba el id al
frontmatter. Este skill + su hook automatizan ese puente, manteniendo una confirmación HITL para
no ensuciar el board.
