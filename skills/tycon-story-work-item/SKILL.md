---
name: tycon-story-work-item
description: Crea el work item en Azure DevOps cuando se crea una story Mary+GOLD y escribe el `work_item:` de vuelta en el frontmatter (el nombre viejo `ado_work_item:` se sigue leyendo). Resuelve el destino del pedido en la configuración del repo (.tycon/work-items.yaml o su nombre viejo → la máquina → preguntar), auto-detecta el tipo de WI por process template, pide confirmación al dev antes de crear, y linkea el WI como hijo del Epic. Usar cuando un hook emite el reminder "tycon-story-work-item STORY-CREATE-detect", cuando el usuario pide "crear el work item en ADO para esta story", o tras crear stories con tycon-create-story / bmad-create-epics-and-stories.
---

# tycon-story-work-item — Crear el pedido de trabajo al crear la story

> Se llamaba `tycon-ado-story-wi` hasta el 2026-10-22: el nombre viejo sigue andando, con un reemplazo
> que manda acá.

## Propósito

Cuando se crea una story Mary+GOLD (vía `tycon-create-story`, `bmad-create-epics-and-stories`,
`gds-create-story`, o a mano), este skill crea el **work item correspondiente en Azure
DevOps** (o la plataforma que elige el perfil del equipo) y escribe `work_item: <id>` de vuelta en el frontmatter de la story.

Cierra el gap que tenía el pipeline TYCON: hasta ahora `step-01-start` y
`close-work-item` (de `tycon-pipeline`) **consumían** el id del pedido pero nadie
lo **creaba** — el dev tenía que crear el WI a mano en la web de ADO y linkearlo. Este skill
automatiza esa creación, manteniendo el dev en el loop con una confirmación.

```
tycon-create-story  ──►  story.md (sin work_item)
                              │
                   hook on-story-create.js detecta
                              │
                              ▼
                   tycon-story-work-item  ──►  platform.js work-item create
                              │                      │
                              ▼                      ▼
              work_item: <id> escrito          WI en ADO (hijo del Epic)
              en el frontmatter
```

## Cuándo se ejecuta

1. **Disparado por hook** — el hook de la integración de ADO,
   `integrations/azure-devops/scripts/on-story-create.js` (`PostToolUse` matcher `Write`, lo lanza el despachador
   del pipeline), detecta una story Mary+GOLD recién creada sin `work_item:` (ni el nombre viejo) y emite el
   reminder `tycon-story-work-item STORY-CREATE-detect`. El agente invoca este skill.
2. **Invocación manual** — el usuario pide "crear el WI en ADO para esta story" /
   "linkeá esta story a ADO".
3. **Batch** — tras `bmad-create-epics-and-stories` (varias stories de una): invocar el
   skill UNA vez con cualquiera de las stories; escanea el directorio y procesa todas las
   que falten `work_item:`.

**Argumento**: ruta absoluta de la story `.md` (la pasa el hook). Si no se pasa argumento,
preguntar al dev cuál es la story / directorio.

## Pre-condiciones

- La plataforma del equipo con su credencial en la máquina. Con Azure DevOps, el CLI y su permiso de pedidos de trabajo
  están en `~/.claude/tycon-harness/guides/integrations/ado-en-el-nucleo.md`, §«La skill de creación: lo que pide»; con GitHub, `gh` con sesión.

Si falta el CLI o el token → **no crear el WI**. Avisar al dev una línea y terminar
(no bloquear ningún flujo: la creación del WI es importante pero no crítica).

---

## Pasos 1 a 3 — Resolver el destino, el tipo y los campos

Dónde se crea el pedido, de qué tipo y con qué campos depende de la plataforma que eligió el perfil del equipo
(`integrations.platform`); la configuración del repo es `.tycon/work-items.yaml` (o su nombre viejo de Azure DevOps).
Con Azure DevOps, los tres pasos (la configuración y su orden de resolución, el tipo por la plantilla de proceso, los
campos y la iteración) están en `~/.claude/tycon-harness/guides/integrations/ado-en-el-nucleo.md`, §«La skill de creación»: seguilos tal cual.
Con GitHub, el tipo va como la etiqueta `tipo:<Tipo>` y el resto lo resuelve el conector
(`~/.claude/tycon-harness/guides/integrations/github-platform.md`). Si la configuración no resuelve por ninguna vía,
una línea («repo sin destino para el pedido de trabajo; story <N.M> sin pedido») y terminar, sin bloquear nada.

## Paso 4 — Confirmar con el dev (OBLIGATORIO)

Antes de pedir la creación a la capa, mostrar al dev un resumen y **esperar
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

## Paso 5 — Crear el pedido de trabajo (y colgarlo de su Epic)

La skill no arma comandos de la plataforma: le pide a la capa de plataforma, que crea el pedido donde lo elige el perfil
del equipo (`integrations.platform`), con el destino de la configuración del repo (`.tycon/work-items.yaml`, o
su nombre viejo de Azure DevOps).

Primero, la estimación vigente de la historia (la última que se escribió al estimarla, o la del plan):

```bash
node ~/.claude/tycon-harness/scripts/lib/estimates.js work-item --repo <repo> --story <story> --json
# → {"ok": true, "estimate": {"value", "unit", "hours", "level", "version"}}  ·  {"ok": true, "estimate": null}
#   (con "motivo" si no pudo leer la configuración o el registro: decirlo en una línea y crear igual, sin estimación)
```

```bash
node ~/.claude/tycon-harness/scripts/lib/platform/platform.js work-item create --args @<archivo>.json
# <archivo>.json:
#   {"repoDir": "<repo>", "title": "Story <story>: <title>", "description": "<html>", "acceptance": "<html>",
#    "priority": <1..4>, "epic": "<epic del frontmatter>", "sprint": <sprint>, "tags": [<etiquetas de la story>]}
#   (+ "assignTo": "<git config user.email>" si la configuración dice auto_assign: true)
#   (+ "estimate": {…} tal como lo devolvió estimates.js, sólo si no es null)
# → {"ok": true, "value": {"id", "url", "warnings", "unsupported", "estimateAs", "estimateFallback"}, "summary": "…"}
```

La estimación va donde la plataforma la puede guardar, y `estimateAs` dice dónde quedó: en Azure DevOps, en el campo
(`OriginalEstimate` con las horas, `StoryPoints` con los puntos, o el que declare `fields.estimate`); en GitHub, en el
campo numérico del proyecto que declare `github.project`, o como comentario. Si el proyecto no se pudo usar,
`estimateFallback` trae el motivo y el `summary` lo dice: mostrárselo al dev, el pedido igual quedó creado.

En Azure DevOps crea el work item con el tipo, el área, la iteración y las etiquetas de la configuración y lo cuelga
del Epic mapeado en `epic_links` (los mismos comandos `az` que escribía esta skill); en GitHub abre un issue con la
etiqueta `tipo:<Tipo>`. Lo que la plataforma no tiene (la prioridad o un campo propio en GitHub) vuelve en
`unsupported` y el `summary` lo dice: mostrárselo al dev en el reporte, nunca callarlo.

**Sin mapeo de la épica**: la capa crea el pedido **suelto** y lo dice en `warnings` (agregar el Epic a `epic_links` y
vincularlo, o hacerlo en el tablero). No bloquear por esto: el pedido igual queda creado y trackeable.

**Un «no»** (`ok: false`: sin plataforma, sin credencial, la plataforma lo rechazó): el `summary` en una línea y seguir;
no bloquea nada. Un campo inválido o un tipo que el proyecto no tiene vuelven como `rechazado` con el motivo de la
plataforma: corregir la configuración del repo y reintentar.

---

## Paso 7 — Escribir el id de vuelta en el frontmatter

```bash
node ~/.claude/tycon-harness/scripts/lib/platform/work-item-field.js set <story.md> <id>
```

Escribe `work_item: <id>` (nunca el nombre viejo `ado_work_item`): en la línea del campo si ya estaba, si no después de
`depends_on:` (y su lista), antes del bloque `pipelines:`, o al final del frontmatter.

```yaml
depends_on: ["2.1", "2.2"]
work_item: 4571          # ← agregado por tycon-story-work-item
```

Esto es lo que hace que `step-00c` (marcar activo al implementar) y `step-09` (cerrar con
trazabilidad) funcionen sin búsqueda fallback por título.

---

## Paso 8 — Reporte al dev

Una sola línea por story creada:

```
📋 ADO: WI #<id> creado (User Story) para Story <N.M> — hijo de Epic #<id>. Frontmatter actualizado.
```

Si hubo skip:

```
📋 pedido de trabajo: skip — repo sin destino (sin `.tycon/work-items.yaml` ni su nombre viejo, sin la organización en la máquina). Story <N.M> sin pedido.
```

---

## Anti-patterns

- ❌ NO crear el WI sin confirmación del dev. Stories que se descartan dejarían WIs huérfanos
  en el board del cliente.
- ❌ NO bloquear ningún flujo (creación de story, pipeline) por errores de ADO. Log + avisar
  + seguir.
- ❌ NO crear un WI si la story YA tiene `work_item:` (o el nombre viejo `ado_work_item:`). El hook ya filtra esto, pero
  re-chequear en el skill por si se invoca a mano.
- ❌ NO inventar el WI id del Epic para el parent link. Si no está en `epic_links` → suelto + warn.
- ❌ NO duplicar: antes de crear, buscar un pedido con el story id en el título (con Azure DevOps, la consulta de
  `~/.claude/tycon-harness/guides/integrations/ado-en-el-nucleo.md` §«El Arranque») — si ya existe un pedido para esa story, proponer linkear ese en vez de crear uno nuevo.

## Referencia cruzada

- `tycon-pipeline/steps/step-01-start.md` — transiciona el WI a `Active` al
  empezar a implementar. Consume el `work_item:` que este skill escribe.
- `tycon-pipeline/steps/close-work-item.md` — cierra el WI con trazabilidad
  post-merge. Otro consumidor de `work_item:`.
- `~/.claude/tycon-harness/guides/integrations/ado-projects.md` — schema de la configuración del pedido (`.tycon/work-items.yaml` y su nombre viejo),
  tabla de mapeo proyecto→ADO, y bloque de registro del hook.
- `~/.claude/tycon-harness/story-format.md` §1 — el campo `work_item` del frontmatter (antes `ado_work_item`).

## Por qué existe

El pipeline TYCON ya tenía los rails de **consumo** (`step-00c`, `step-09`) pero la **creación**
del WI era 100% manual — el dev abría la web de ADO, creaba el User Story, copiaba el id al
frontmatter. Este skill + su hook automatizan ese puente, manteniendo una confirmación HITL para
no ensuciar el board.
