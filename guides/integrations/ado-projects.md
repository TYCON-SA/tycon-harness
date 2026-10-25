# Integración Azure DevOps — work items por story

Esta guía cubre el puente entre las stories Mary+GOLD y los work items (WI) de Azure
DevOps: **al crear una story se crea automáticamente su WI en ADO**, y los work items se
transicionan a lo largo del ciclo de vida del pipeline.

---

## Ciclo de vida ADO de una story

```
crear story  ──►  tycon-story-work-item   ──►  WI creado en ADO  +  ado_work_item: <id> en frontmatter
implementar  ──►  tycon-pipeline Arranque            ──►  WI → Active
cerrar       ──►  tycon-pipeline Cerrar la historia  ──►  WI → Closed  +  comment de trazabilidad
```

| Momento | Componente | Acción ADO |
|---|---|---|
| Se crea la story `.md` | hook `on-story-create.js` → skill `tycon-story-work-item` | **Crea** el WI, lo linkea al Epic, escribe `ado_work_item:` |
| Empieza la implementación | `tycon-pipeline` `step-01-start` | Transiciona el WI a `Active` |
| Se cierra la story (post-merge) | `tycon-pipeline` `close-work-item` | Transiciona a `Closed` + postea comment con commits/CI/PR/tiempo |

El skill `tycon-story-work-item` cierra el único eslabón que faltaba: la **creación**. Antes
era manual (web de ADO + copiar el id al frontmatter).

---

## Creación automática del WI — cómo funciona

1. El dev crea una story con `tycon-create-story` / `bmad-create-epics-and-stories` /
   `gds-create-story`, o a mano.
2. El hook `PostToolUse` (matcher `Write`) `on-story-create.js` detecta —**por contenido,
   no por path**— una story Mary+GOLD recién creada sin `ado_work_item:` y emite un
   `system-reminder`.
3. El agente invoca el skill `tycon-story-work-item`, que:
   - resuelve la config ADO del repo,
   - auto-detecta el tipo de WI por process template,
   - arma los campos desde la story (título, descripción, ACs, priority),
   - **pide confirmación al dev** (HITL — nada se crea sin un "dale"),
   - crea el WI con `az boards work-item create`,
   - lo linkea como hijo del Epic (si hay mapeo),
   - escribe `ado_work_item: <id>` de vuelta en el frontmatter.

Si el repo no trackea en ADO (sin config), el skill hace **silent-skip** — no bloquea nada.

---

## `.tycon/ado-config.yaml` — config por repo

Es la **fuente de verdad** del mapeo repo→ADO. Va en el root del repo (junto a `.git/`).
Lo leen los tres componentes (`tycon-story-work-item`, el Arranque y «Cerrar la historia»).

```yaml
# .tycon/ado-config.yaml
ado_org: https://dev.azure.com/org-del-equipo
ado_project: Ceibo

# --- creación del WI (tycon-story-work-item) ---
ado_wi_type: ""                    # override del tipo. Vacío = auto-detectar por process.
ado_area_path: "Ceibo"            # default = nombre del project.
ado_iteration_path: ""             # ej "Ceibo\\Sprint 3". Vacío = backlog del project.
ado_auto_assign: false             # true = asigna el WI a `git config user.email`.
ado_default_tags: "tycon-pipeline" # tags para todo WI creado; separados por ";".
epic_links:                        # mapeo epic (frontmatter) → WI id del Epic/Feature en ADO.
  1: 12001
  2: 12002
  3: 12003

# --- transiciones de estado (Arranque / Cerrar la historia) ---
ado_state_active: "Active"         # estado "en progreso" del process template.
ado_state_closed: "Closed"         # estado "cerrado".
```

| Campo | Obligatorio | Notas |
|---|---|---|
| `ado_org` | sí | URL completa de la organización. |
| `ado_project` | sí | Nombre del project en ADO. |
| `ado_wi_type` | no | Si está, saltea la auto-detección. |
| `ado_area_path` | no | Default = `ado_project`. |
| `ado_iteration_path` | no | Vacío → el WI cae en el backlog. |
| `ado_auto_assign` | no | Default `false`. Decide si el pedido de una story se le asigna a quien la crea o la arranca (`git config user.email`). No frena el pedido que crea la noche: ése se asigna siempre al responsable de `owners` en `operations.json`, porque no tiene autor y sin asignado nadie lo vería. |
| `ado_default_tags` | no | — |
| `epic_links` | no | Sin entrada para un epic → el WI se crea suelto + warning. |
| `ado_state_active` | no | Default `Active`. Ver tabla de process templates abajo. |
| `ado_state_closed` | no | Default `Closed`. |

**Si no hay `.tycon/ado-config.yaml`**, la config se intenta resolver por env vars
(`TYCON_ADO_ORG` + `TYCON_ADO_PROJECT`) y, en última instancia, preguntando al dev. Cuando
se resuelve por env/pregunta, el skill ofrece **crear el archivo** para que las próximas
corridas no pregunten.

---

## Tipo de WI por process template

`tycon-story-work-item` detecta el process del project (`az devops project show ... --query
capabilities.processTemplate.templateName`) y elige el tipo. El match es por **substring
case-insensitive** del nombre del template — los projects TYCON usan nombres custom
(ej: Ceibo reporta `Ceibo Scrum`, no `Scrum`):

| El nombre del template contiene… | Tipo de WI creado | `ado_state_active` | `ado_state_closed` |
|---|---|---|---|
| `Scrum` | `Product Backlog Item` | `Committed` | `Done` |
| `Agile` | `User Story` | `Active` | `Closed` |
| `CMMI` | `Requirement` | `Active` | `Closed` |
| `Basic` | `Issue` | `Doing` | `Done` |

Si el nombre no matchea ninguno, fijar `ado_wi_type` + `ado_state_active` +
`ado_state_closed` a mano en la config.

---

## Tabla de referencia proyecto→ADO

Referencia para completar los `.tycon/ado-config.yaml` de cada repo. **La fila autoritativa
es siempre la del archivo en el repo** — esta tabla es solo orientativa y se completa a
medida que se cablea cada proyecto. **El pipeline no la lee** (desde 2026-09-26): sin
`.tycon/ado-config.yaml`, la organización sale de `ado.org` de la configuración del arnés
(`TYCON_ADO_ORG`, `~/.claude/tycon.json` o el perfil del equipo), y sin eso Azure DevOps está
apagada en esa máquina — el paso lo dice en una línea y se saltea. El «default por proyecto
conocido» que antes citaban el Arranque y el cierre en ADO ya no existe.

La tabla de los proyectos del equipo (organización, `ado_project`, process y repos con `.tycon/ado-config.yaml`) vive
en los datos internos del equipo («Proyectos de Azure DevOps»). El `.tycon/ado-config.yaml` va en el root de **cada
git repo que contiene stories** (el skill hace walk-up hasta el primer `.git/`); un repo que no trackea en ADO no
necesita config (silent-skip).

---

## Registro del hook (una vez por máquina)

El **script** del hook viaja por git en `~/.claude/agent-skills` (repo `AgentSkills`), pero
el **registro** en `~/.claude/settings.json` se hace a mano por dev — igual que el bloque
`SessionStart` del README. Agregar dentro del objeto `"hooks"`:

```json
"PostToolUse": [
  {
    "matcher": "Write",
    "hooks": [
      {
        "type": "command",
        "command": "node \"/Users/<TU_USUARIO>/.claude/agent-skills/skills/tycon-story-work-item/scripts/on-story-create.js\""
      }
    ]
  }
]
```

Reemplazá `<TU_USUARIO>` por tu usuario. Si ya tenés un array `PostToolUse`, agregá solo el
objeto `{ "matcher": "Write", "hooks": [...] }` adentro.

El hook es no-bloqueante (`exit 0` siempre) y barato: filtra por contenido del archivo y
solo emite cuando detecta una story Mary+GOLD nueva sin `ado_work_item:`.

---

## Requisitos

- `az` CLI con la extensión `azure-devops`: `az extension add --name azure-devops`.
- `AZURE_DEVOPS_EXT_PAT` exportada — token con scope **Work Items: Read & Write**. Es la
  misma variable que usan el Arranque y «Cerrar la historia».

Sin CLI o sin token, el skill avisa una línea y termina — no bloquea la creación de stories
ni el pipeline.

---

## Anti-patterns

- ❌ Hardcodear el id de un Epic para el parent link. Usar `epic_links` en la config; sin
  mapeo → WI suelto + warning.
- ❌ Crear el WI sin confirmación del dev. Stories descartadas dejan WIs huérfanos.
- ❌ Bloquear la creación de la story o el pipeline por un error de ADO. Siempre log + seguir.
- ❌ Asumir que todos los projects usan process Agile. Auto-detectar o fijar `ado_wi_type`.

## Por qué existe

Para que el pipe de creación de historias, para todos los devs en
todos los proyectos, cree el work item en ADO cada vez que se crea una story. El pipeline ya
tenía el **consumo** del `ado_work_item:` (el Arranque y «Cerrar la historia»); faltaba la **creación**.
