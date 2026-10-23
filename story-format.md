# Guia del Formato Mary+GOLD para Stories

Esta guia define como escribir stories para que un agente LLM pueda implementarlas sin ambiguedad, sin preguntas, y sin inventar nada.

Debe usarse como referencia al escribir o validar stories en cualquier proyecto que siga este formato.

El formato se llama **Mary+GOLD** porque combina:
- **Mary**: el agente analista que escribe stories ancladas a codigo real
- **GOLD**: el checklist de calidad que valida que la story sea implementable sin errores

---

## La story ES el intent

El AI-Native SDLC Playbook pide un artefacto de "intent" previo al spec. En este equipo esa capa NO se agrega:
**la story Mary+GOLD es el registro de intención Y el spec implementable a la vez** — su sección
`## Story` (como <rol> quiero <accion> para <beneficio>) es exactamente el intent, y el resto del
archivo es su elaboración verificable. Un artefacto separado sería una segunda fuente de verdad
que hay que mantener sincronizada a mano, y este arnés ya midió cómo terminan las copias dobles
(caso `~/.codex/AGENTS.md` desincronizado en 48 líneas).

La convención que completa la decisión: **las ideas pre-story viven en engram** (`mem_save` con
`type: idea`, project del repo). Una idea que madura se convierte en story con este formato; una
que no, queda buscable sin ensuciar `specs/`. No se crean archivos `intent-*.md` ni carpetas de
ideas en los repos.

---

## Estructura del Archivo

Toda story es un archivo Markdown con esta estructura exacta, en este orden:

### 1. Frontmatter YAML

```yaml
---
epic: 2
story: "2.3"
title: "POST /pedidos -- crear pedido, reservar stock, devolver el remito"
status: done          # vocabulario completo en scripts/metrics/states.json (ver abajo)
sprint: 1
priority: "P0"        # P0 = blocker, P1 = must, P2 = should, P3 = nice
approach: "[ADAPT]"   # [EXTRACT] = copiar de fuente | [ADAPT] = adaptar | [CREATE] = nuevo
depends_on: ["2.1", "2.2", "1.3"]
work_item: 12345  # auto-poblado al crear la story (ver nota abajo); id del pedido de trabajo
---
```

- `status` — **el vocabulario es UNO y está en `scripts/metrics/states.json`**.
  Los canónicos, en orden de flujo: `draft` · `backlog` · `ready-for-dev` ·
  `in-progress` · `review` · `blocked` · `done`, más los cuatro terminales **que no son una
  entrega**: `cancelled`, `abandoned`, `superseded` y `reverted`. Ese archivo trae además los
  alias de lo que ya se usa en los repos (`pending` → `backlog`, `implementation-complete` →
  `review`, `merged` → `done`, …) y el motivo escrito de cada decisión no obvia.
  - **`draft` es una historia que el validador todavía no revisó.** Una historia nueva nace en `draft`; el arnés no
    deja escribir una historia nueva en otro estado, ni pasar un borrador a `ready-for-dev`, sin que el validador de
    historias (`tycon-story-validator`) haya corrido sobre ese archivo después de su última escritura. Lo hace la skill
    `tycon-create-story` en su paso 6 (o el agente después de `story-without-bmad.js write`); saltearlo lo autoriza la
    persona con «autorizo story-skill-bypass». El pipeline no arranca sobre un borrador, y si la sesión deja uno sin
    validar, el cierre del turno le da al agente la orden de validarlo y, si no avanza, se lo dice a la persona.
  - 🔴 **La lista es CERRADA a propósito, y lo que no está NO se descarta**: sale como
    `desconocido:<valor>`, se cuenta aparte y aparece con su nombre en el tablero. Escribir un
    estado que no está en el diccionario no rompe nada y no da error — sólo hace que la story
    aparezca en la ficha «con un estado que el diccionario no reconoce», que es la lista de
    trabajo del próximo diccionario. Agregar un alias es una decisión que se toma **mirando ese
    contador**, no antes.
  - 🔴 **`pipelines[].status` (§1.1) es OTRO vocabulario**: describe el estado de una **tanda de
    entrega**, no el de la story. Se llaman igual y miden cosas distintas — el diccionario de
    estados no lo absorbe, y al revés tampoco.
  - `blocked` y `abandoned` los escribe el propio orquestador del pipeline (`marker.js`), así que
    son vocabulario oficial aunque no se tipeen a mano.
- `approach` indica cuanto se reutiliza de codigo existente vs crear nuevo:
  - `[EXTRACT]` = copiar un patron de una fuente identificada
  - `[ADAPT]` = adaptar un patron **ya resuelto** en otro lugar (proyecto hermano, feature existente)
  - `[CREATE]` = codigo nuevo, sin patron fuente
  - 🔴 **`approach` es autodeclarado — NO es lo que dispara la seccion "Patron de referencia verificado"**. Esa seccion (§9.2) es **obligatoria en toda story de backend**, sea cual sea su `approach`. Una etiqueta `[CREATE]` no exime de buscar el patron hermano: una story etiquetada `[ADAPT]` puede igual inventar el fix opuesto al patron real. Ver §9.2 + regla GOLD #9.
- `story` — 🔴 **el id de una story tiene que ser único dentro de su repo**.
  El arnés nombra con él la evidencia de cierre, las guías de QA y las carpetas de corrida, y una
  persona o un agente lo usa para decir «la story `<N.M>`». El equipo numera hoy de dos formas:
  - **Número de épica adelante** (`epic: 2` → `story: "2.3"`), con todas las stories en una
    carpeta: el id es único por construcción. **Es la recomendada para un repo nuevo**: no
    depende de dónde esté el archivo y no hay que explicarle a nadie a cuál de varias «1.1» se
    refiere.
  - **Carpeta por tema** (`.specs/<tema>/stories/`, `docs/<área>/epic-*/`), donde cada tema
    arranca de nuevo en 1.1: el número se repite entre temas.
  Si el número se repite, la evidencia de cierre se separa sola: la clave pasa a ser
  `<tema>__<número>` (`skills/tycon-pipeline/scripts/lib/evidence-key.js`; a mano:
  `pipeline.js evidence-key --story <ruta>`). Pero «la story `<N.M>`» sigue siendo ambigua para quien
  la busca, y por eso el lint del frontmatter **avisa** cada número repetido con sus rutas (no
  frena: al escribir esto había 23 en un repo y 8 en otro).
- `depends_on` lista stories que deben estar implementadas antes
- `work_item` — id del pedido de trabajo de la story en la plataforma del equipo (un work item de Azure DevOps, un issue de GitHub). El nombre viejo, `ado_work_item`, se sigue leyendo (con los dos gana `work_item`) y nadie lo escribe; el lint de frontmatter avisa si una story nueva nace con él. **Se auto-puebla al crear la story**: el hook `on-story-create.js` detecta la story nueva sin este campo e invoca el skill `tycon-story-work-item`, que crea el work item en ADO (con confirmación del dev) y escribe el id acá. Lo consumen después `tycon-pipeline` step-00c (transiciona el WI a `Active` al implementar) y step-09 (postea comment de trazabilidad con commit SHAs + CI run + PR link y lo transiciona a `Closed` al cerrar). Si el repo NO trackea en ADO (sin `.tycon/ado-config.yaml` ni env vars), el campo simplemente no aparece — el skill hace silent-skip. Detalle completo del flujo y del schema de config: `guides/integrations/ado-projects.md`.

#### 1.0 🔴 El frontmatter tiene que ser LEGIBLE — una story mal formada es una story invisible

Todas las herramientas del harness (validator, backfill de back-links, scripts de status, hook de DoD) cortan el frontmatter con `content.indexOf('\n---', 3)` y leen los escalares con `/^campo:\s*"?([^"\n]+?)"?\s*$/m`. **Cuando ese parseo falla, la story no da error: se saltea en silencio.** Deja de existir para el harness sin que nadie se entere.

Dos formas de romperlo, las dos vistas en producción:

| Cómo se rompe | Qué pasa |
|---|---|
| **Falta el `---` de cierre** del frontmatter | `indexOf` devuelve -1, o engancha una regla horizontal `---` del cuerpo y se traga medio archivo como si fuera frontmatter |
| **Comillas dobles dentro de un comentario inline** (típico en `status:`) | El `[^"]` del scalar corta en la primera comilla, el `$` no matchea, el campo da `null`. El colector exige `story`+`epic`+`status` no nulos → descarta la story |

```yaml
status: done  # ver "Preguntas abiertas"      # ❌ rompe el parseo del harness
status: done  # ver 'Preguntas abiertas'      # ✅ comillas simples en el comentario
```

**Por qué importa (medido en un repo):** 4 stories sin el `---` de cierre + 2 con comillas en el comentario del `status` estuvieron **invisibles ~2 meses**: el backfill veía 276 stories donde había 281. Una de ellas, además, tapaba una deuda de evidencia DoD que el hook de pre-commit no podía detectar justamente porque no podía leer el archivo.

**Enforcement**: `scripts/lib/lint-story-frontmatter.js` (0 deps) replica el parser real del harness y falla si una story no es legible. **No se copia a cada repo**: vive solo en este repo y los proyectos lo referencian por path desde su `.githooks/pre-commit` (snippet exacto en la cabecera del script). Se puede porque el onboarding clona el arnés en una ruta fija y el `SessionStart` le hace `git pull` en cada arranque, y porque un pre-commit corre siempre en local, nunca en CI. Corre solo sobre las stories que toca el commit.

> ⚠️ **El chequeo obvio no alcanza.** Buscar una línea `---` con `grep`/`awk` da falsos verdes: cualquier regla horizontal del cuerpo lo satisface. Medido: ese método encontró 2 de 4 archivos rotos; los otros 2 sólo aparecieron al intentar parsear el frontmatter de verdad. Por eso el lint replica el parser, no lo aproxima.

#### 1.1 Frontmatter — bloque `pipelines:` (opcional, para stories que se entregan en tandas)

Cuando una story es grande y se entrega en varias tandas (backend / frontend / sub-features), agregar un bloque `pipelines:` al frontmatter para que el `tycon-deferral-tracker` advisor pueda verificar que **nada quede colgando sin documentar el por qué**.

Es **opcional** — si la story se entrega de una sola vez, no se necesita. Si se difiere algo, **es obligatorio** declarar la tanda diferida con su `blocked_by` y los ACs/tasks/tests que cubre.

```yaml
---
epic: 2
story: "2.2"
title: "Generación y Confirmación del Listado de Armado"
status: in-progress
sprint: 2
priority: "P0"
approach: "[CREATE]"
depends_on: ["1.1", "1.5", "1.6", "2.1"]
pipelines:
  - name: A-backend
    status: done                      # done | in-progress | blocked | pending
    acs: [1, 2, 3, 4, 5, 6]
    tasks: [1, 2, 3, 4]
    tasks_partial:
      - id: 5
        done: [5.1, 5.2, 5.3, 5.4]
        pending: [5.5]                # subtask diferida — debe estar en algún pipeline pending/blocked
  - name: B-frontend-recepcion
    status: in-progress
    acs: [1, 2, 3, 4, 5, 6, 11]
    tasks: [6, 7, 8, 9]
  - name: C-frontend-listado
    status: blocked
    blocked_by: "Story <N.M> Task 5.5 backend — endpoint GET /api/ceibo/pedidos/{id}/listado no mergeado"
    acs_pending: [7, 9, 10]
    tasks_pending: [10, 12, 13]
    tests_pending: ["T36", "T39", "T40"]
---
```

**Schema del bloque** (validado por `tycon-story-validator` rule VAL-C6):

| Campo | Tipo | Cuándo es obligatorio |
|-------|------|----------------------|
| `name` | string | siempre. Identifica la tanda. Convención: `{letra}-{ambito}-{subtema}` (ej: `A-backend`, `B-frontend-recepcion`, `C-frontend-listado`). |
| `status` | enum `done\|in-progress\|blocked\|pending` | siempre. 🔴 Es el estado de la **tanda**, no el de la story: **otro vocabulario**, que el diccionario de `scripts/metrics/states.json` no absorbe. |
| `acs` | int[] | cuando `status: done` o `status: in-progress` (acs efectivamente cubiertos en esa tanda). |
| `tasks` | int[] | cuando `status: done` o `status: in-progress` (tasks cubiertos). |
| `tasks_partial` | list de `{id, done, pending}` | si una task se cubrió parcial — declarar subtasks done vs pending. |
| `blocked_by` | string no vacío | **obligatorio cuando `status: blocked`** (regla VAL-C6 CRITICAL si falta). Describir el bloqueo concreto (story/task/file que debe completarse primero). |
| `acs_pending` | int[] | cuando `status: blocked` o `status: pending` — ACs que NO se cubren en esa tanda. |
| `tasks_pending` | int[] | cuando `status: blocked` o `status: pending` — tasks que NO se cubren. |
| `tests_pending` | string[] | cuando `status: blocked` o `status: pending` — IDs de tests (`T36`, `T40`, etc.) que quedan sin cobertura. |

**Reglas de consistencia** (verificadas por `tycon-story-validator`):

- Todo AC declarado en `## Acceptance Criteria` debe aparecer en exactamente un `acs` (de algún pipeline `done`/`in-progress`) **o** en `acs_pending` (de algún pipeline `blocked`/`pending`). Si un AC no aparece en ningún pipeline → **VAL-W7 WARNING** (orphan AC).
- Un AC NO puede aparecer en `acs` y `acs_pending` al mismo tiempo.
- Pipeline con `status: blocked` requiere `blocked_by` no vacío → **VAL-C6 CRITICAL** si falta.
- Cuando todos los pipelines tienen `status: done`, el `status` global de la story DEBE ser `done`.

**Tracking cruzado por `tycon-deferral-tracker`**:

Cualquier AC/task/test en `acs_pending` / `tasks_pending` / `tests_pending` debe estar documentado en **al menos uno** de:
1. `tasks/todo.md` del repo (línea con `[DEF-{N.M}-{nombre}]`).
2. Engram observation `type=decision` con keyword `Story {N.M}` y type del bloqueo.

Si NO está en ninguno → **DEFTR-C1 CRITICAL** del advisor `tycon-deferral-tracker` (Sprint 1+: bloquea commit prep).

#### 1.2 Frontmatter — back-links `followup_of:` / `followed_up_by:` (cuando una story modifica a otra)

Cuando una story nueva **modifica, recalibra, fixea o extiende** lo que otra story ya entregó (típicamente la story original está en `status: done` y/o firmada con el cliente), declarar esa relación **explícitamente** en el frontmatter.

Es **distinto a `depends_on:`** — `depends_on:` es orden de implementación ("X debe estar mergeada antes que Y"). `followup_of:` es semántico ("Y cambia lo que X entregó"). Una story puede tener `depends_on:` SIN `followup_of:` (story que se construye sobre otra sin modificarla); rara vez `followup_of:` sin `depends_on:`.

##### Campo `followup_of:` — declarado en la story HIJA (la que viene a corregir)

```yaml
---
epic: 13
story: "13.3.9"
title: "CaseRecapPanel — sección INCIDENCIAS desde incidencias reales del caso"
status: backlog
sprint: 3
priority: "P1"
approach: "[MODIFY]"
depends_on: ["13.3.4"]
followup_of:
  - id: "13.3.4"
    type: "fix"              # fix | scope-change | recalibration | gap-fill | extension
    summary: "Sección INCIDENCIAS lee incidencias reales en vez de derivar del campo `estado`"
---
```

Cuando la story modifica a más de una previa (raro pero válido):

```yaml
followup_of:
  - id: "3.2"
    type: "recalibration"
    summary: "Confirmación de listado — ahora también auto-genera CodigoBarras de etiqueta"
  - id: "2.3"
    type: "extension"
    summary: "Usa RemitoBuilderService.GenerateAsync del nuevo servicio"
```

**Schema:**

| Campo | Tipo | Obligatorio | Notas |
|---|---|---|---|
| `id` | string | sí | Story id de la padre (`"3.2"`, `"13.3.4"`), exactamente como aparece en el frontmatter `story:` de la padre. NO el filename. |
| `type` | enum | sí | `fix` (corrige bug/defecto) · `scope-change` (cambio explícito de scope firmado) · `recalibration` (re-interpretación post-implementación) · `gap-fill` (cubre AC implícito no atrapado en spec original) · `extension` (suma capability sobre lo entregado). |
| `summary` | string | sí | Una línea — qué cambia respecto a lo que entregó la padre. NO repite el título de la story (eso ya está); explica el delta. |

##### Campo `followup_reason:` — POR QUÉ hubo que volver (2026-09-05)

Toda story que declara `followup_of:` dice además **la causa del reproceso**, en un escalar de
primer nivel del frontmatter — **uno por story**, aunque tenga varios padres:

```yaml
followup_of:
  - id: "13.3.4"
    type: "fix"
    summary: "Sección INCIDENCIAS lee incidencias reales en vez de derivar del campo `estado`"
followup_reason: defecto-propio
```

**No es lo mismo que `type:`.** `type` dice *qué clase de cambio es* (una extensión, un arreglo,
una recalibración); `followup_reason` dice *por qué hubo que volver*. Medido al crear el campo:
`extension` está en 136 de las 285 stories con seguimiento (48 %) y **no es reproceso** — una story `extension` puede tener causa
`cambio-de-requisito` (el cliente pidió más) o `descubrimiento` (al usarlo se vio que faltaba).

El vocabulario es **cerrado** y vive en **un** archivo, `scripts/metrics/rework-causes.json`
(con el motivo de cada causa y de cada decisión). Esta tabla lo **copia**, y un test compara los
dos — si difieren, la suite se pone roja:

| Causa | Qué significa |
|---|---|
| `defecto-propio` | Lo entregado estaba mal: un bug, una regla mal implementada, un caso que el spec sí pedía y no se manejó. |
| `cambio-de-requisito` | Lo entregado hacía lo que el spec pedía; el pedido cambió después (cliente, producto, regulación). |
| `deuda-declarada` | La story original dejó algo afuera **a propósito y lo escribió** (`pipelines:`, `TODO(Story-N-deferral)`); el seguimiento lo paga. |
| `descubrimiento` | Al usar lo entregado se vio algo que nadie sabía: un caso real que ni el spec ni el cliente contemplaban. |

**Qué lo exige y a quién.** `scripts/lib/lint-story-frontmatter.js`, en el **pre-commit de cada repo**,
lo exige **sólo a la story que nace** en ese commit — sin historial en git— y rechaza
**siempre** un valor fuera de la tabla (`fix`, `Defecto-Propio`, texto libre: no se normaliza nada).
A una story con `followup_of:` que **ya existía** sin el campo le **avisa y no la frena**: al crear
el campo había **285** en 9 repos, y exigírselo a todas habría puesto en rojo el pre-commit de todo
el equipo el día del merge — o sea, apagado el lint en una semana. Esas 285 **no se rellenan** (ni a
mano ni derivando la causa del `type`: sería inventarla); el tablero las muestra como **«sin
declarar»**, una barra propia con la palabra, desglosada por el `type` que ya traen como contexto.

**Dónde se lee.** `sdlc-stage-metrics.js` publica `rework_por_causa` en el snapshot (las cuatro
causas siempre presentes, `sin_declarar`, `fuera_de_vocabulario` con nombre, `total` = stories con
`followup_of:` en cualquier estado) y el tablero dibuja las cinco barras en la ficha *«Por qué
volvió»*. La señal a mirar, escrita en el pie: **`cambio-de-requisito` subiendo mientras
`defecto-propio` baja** — lo escribe quien causó el reproceso.

##### Campo `followed_up_by:` — back-link AUTO-MAINTENIDO en la story PADRE

Cuando se crea una story con `followup_of:`, el hook `on-story-create.js` del skill `tycon-story-followup-link` detecta el campo, identifica las padres, y emite un reminder para que el agente actualice cada padre agregándole un back-link:

```yaml
# En la story PADRE (ej. 13.3.4), agregar al frontmatter:
followed_up_by:
  - id: "13.3.9"
    date: "2026-05-18"       # fecha en que se creó la hija (ISO YYYY-MM-DD)
    type: "fix"              # mismo type que en el followup_of de la hija
    summary: "Sección INCIDENCIAS lee incidencias reales en vez de derivar del campo `estado`"
```

El back-link **debe estar sincronizado** con el `followup_of:` de la hija (mismo `id`, `type`, `summary`). El validator `tycon-story-validator` lo verifica con la regla **[VAL-W10]** (bidirectional links): si hija X declara `followup_of: [Y]` pero Y no tiene X en `followed_up_by:` → WARNING (y vice-versa).

##### Cuándo NO usar `followup_of:`

- Story que se construye **sobre otra** sin modificarla → solo `depends_on:`. Ejemplo: la story `<A>` usa el contrato de auth de la story `<B>` → `<A>` declara `depends_on: ["<B>"]`, NO `followup_of:`.
- Story que **reemplaza** una anterior (la anterior queda obsoleta) → por ahora preferir crear la nueva como `[CREATE]` y marcar la vieja como `status: superseded` en su Change Log (campo `supersedes:` queda como TODO si emerge el caso real).

##### Beneficios

1. **Auditabilidad** — abrir cualquier story original y ver de un vistazo todas las recalibraciones posteriores en su `followed_up_by:`.
2. **Cliente / propuesta firmada** — al reportar "Story `<N.M>` está done" se puede agregar "...con 5 follow-ups que entregaron X, Y, Z".
3. **Trazabilidad cross-sprint** — un follow-up de sprint 5 que modifica una story firmada en sprint 1 queda visible desde la firmada.
4. **Anti-drift** — el validator atrapa cuando se olvida la actualización bidireccional.

##### Tooling

- **Hook** (auto, al crear hija): `tycon-story-followup-link/scripts/on-story-create.js` propone el back-link.
- **Validator** (en pipeline): `tycon-story-validator` regla VAL-W10 detecta drift.
- **Back-fill masivo**: `~/.claude/tycon-harness/scripts/tools/tycon-backfill-followups.js` sincroniza repositorios completos.

#### 1.3 Frontmatter — campos extendidos (schema real)

Además de los campos base del ejemplo de §1, las stories reales usan estos campos (formalizados 2026-06-09 post-auditoría). Dos son **RECOMENDADOS-fuerte** porque hay tooling que los consume; el resto son opcionales.

| Campo | Tipo | Nivel | Semántica |
|---|---|---|---|
| `files_to_create` | string[] | **RECOMENDADO-fuerte** | Rutas (relativas al repo) de los archivos que la story crea. Los consume el hook `on-edit.js` (detecta edits fuera de pipeline: tocar un archivo que ninguna story in-progress declara) y `pipeline.js risk-class` (clasifica la superficie del cambio). Mantener sincronizado con la tabla §9.5 "Archivos a crear/modificar". |
| `files_to_modify` | string[] | **RECOMENDADO-fuerte** | Ídem, pero archivos existentes que la story modifica. Mismos consumidores, más el detector de «story de pantalla» (`lib/ui-signal.js`): con archivos declarados en `files`/`files_to_create`/`files_to_modify`, deciden las listas y el título o el `driver` dejan de contar. Una story que toca pantalla declara ahí sus archivos del frente; si no, el cierre avisa en una línea que la trata como sin pantalla. |
| `driver` | string multilínea (`\|`) | opcional | Por qué existe la story: **máximo 2-3 líneas** + link a la sección del body o al issue que cuenta el incidente completo. Ver regla anti-redundancia abajo. |
| `topics` | string[] | opcional | Temas de la wiki (`specs/wiki/topics/`) que la story toca — alimenta el lint bidireccional story↔wiki. |
| `internal_scope` | bool | opcional | `true` = story interna (harness/infra/tooling), no entregable al cliente — queda fuera de los reportes de scope firmado. |
| `owner` | string | opcional | Dev humano responsable de la story (no el agente que la implementa). |
| `blocks` | string[] | opcional | Inverso de `depends_on:` — stories que no pueden arrancar hasta que esta esté done. |
| `estimated_days` | number | opcional | Estimación en días-dev, para sprint planning. |
| `signed_ac_ref` | string | opcional | Referencia al AC del documento firmado con el cliente que esta story cubre (ver `guides/signed-scope-guardrails.md`). |

**🔴 Regla anti-redundancia narrativa (`driver:` vs body):** el contexto/incidente que motiva la story vive **UNA SOLA VEZ** en el body (sección `## Origen` o equivalente); `driver:` se limita a 2-3 líneas + link a esa sección o al issue. Razón: hubo stories de 15-18K tokens que contaban el mismo incidente 3-4 veces (driver + Origen + Causa raíz + Change Log), y cada relectura por los advisors paga ese costo en cada iteración del pipeline.

### 2. Titulo (H1)

Repite el titulo del frontmatter. Formato: `Story {N}: {titulo descriptivo}`.

```markdown
# Story 2.3: POST /pedidos -- crear pedido, reservar stock, devolver el remito
```

### 3. Status

Una linea debajo del titulo:

```markdown
Status: ready-for-dev
```

### 4. Story (formato "Como X, quiero Y, para Z")

```markdown
## Story

Como [rol/sistema],
quiero [accion concreta],
para [beneficio/razon].
```

Debe ser especifica, no generica. Malos ejemplos: "Como usuario quiero hacer cosas". Buenos ejemplos: "Como backend de Acme, quiero que cuando el depósito avise que terminó de armar un pedido (ARMADO_LISTO), el sistema guarde los datos del armado en el pedido".

### 5. Acceptance Criteria

```markdown
## Acceptance Criteria
```

**Reglas:**

- Numerados secuencialmente (1, 2, 3...)
- Agrupados con H3 por tema (`### Autenticacion`, `### Flujo principal`, `### Edge cases`, etc.)
- Cada AC es **verificable** — debe poder traducirse a un test o query concreta
- **ACs de COMPORTAMIENTO en formato Given/When/Then (REQUERIDO)**: `N. **Given** <estado inicial> **When** <acción> **Then** <resultado observable>`. Ya es práctica de facto y es lo que parsea `pipeline.js mech-check` para cruzar AC↔test. ACs declarativos simples (config estática, constraint, no-regresión) pueden ser prosa numerada.
- Referencian archivos y metodos reales del codebase (con nombre de archivo y numero de linea cuando aplica)
- Nunca usan lenguaje vago: NO "deberia funcionar bien", SI "retorna 409 Conflict con mensaje descriptivo"
- Incluyen los **edge cases** y **errores** ademas del happy path
- Incluyen una seccion `### No-regresion` que lista que NO debe romperse
- **AC de modos de falla obligatorios**: por cada path "que pasa cuando X no existe / falla / esta vacio / 0 resultados / timeout / sin permisos" debe haber un AC explicito. Happy-path solo no es suficiente — la mayoria de los bugs post-merge vienen de modos de falla no especificados (copy del cell, columna que desaparece, fallback engañoso, etc).
- **AC por layout cuando hay N layouts**: si la story toca un componente con multiples renders (mobile vs desktop, light vs dark, server vs client, etc), cada layout afectado debe tener su AC explicito. NO asumir que "<Componente>" cubre todos los caminos del componente.
- **AC cross-story cuando hay integracion**: si la story depende de otra (`depends_on`) y comparten un contrato de datos (campos, body shape, eventos), incluir AC explicito de "Story A escribe X, Story B lo lee como Y". Sin esto se generan bugs de integracion silenciosos (un lado escribe el campo, el otro lado nunca lo lee).
- **AC con response discriminated union obligatorio enumerar comportamiento por status** (rule 2026-05-13): cuando un endpoint declarado devuelve un envelope con campo `status: 'A' | 'B' | 'C' | ...` (discriminated union), el AC que lista el endpoint DEBE enumerar el comportamiento esperado del frontend/consumer **para cada valor del discriminator**, incluso si N-1 de esos comportamientos estan definidos en otros ACs. La enumeracion debe estar O bien (a) en el mismo AC con bullets `status === 'X' → comportamiento Y`, O bien (b) via referencia cruzada explicita `ver AC #X para status='Y'`. NUNCA dejar implicito "los demas statuses estan cubiertos por AC #N" sin nombrar el status. Sin esta enumeracion, el advisor `tycon-spec-first-checker` no puede aplicar SPEC-W3 (que detecta consumers que ignoran el discriminator), y advisors AC-coverage no detectan dead-code UX (un componente que implementa el happy path 'ok' pero ignora `fallback-pdf-memory` pierde el PDF in-memory en un escenario real con la impresora inaccesible).

**Qué títulos y qué formas lee el arnés.** El formato de arriba es el recomendado; el arnés lee además lo que
escriben otros equipos, en un solo lugar (`skills/tycon-pipeline/scripts/lib/story-checks.js`):

- **Títulos**: `Acceptance Criteria` o `Criterios de aceptación`, y `Tests` para la tabla, con cualquier mayúscula o
  minúscula y con `##` o `###` (la tabla, de `##` a `######`). `Tests corridos` es un título de la evidencia, no la tabla.
- **Formas de criterio**, cada una con su nombre:
  - `titulo-ac`: `### AC-1 — título`
  - `numerada`: `1. **Given** … **When** … **Then** …` (la recomendada)
  - `vineta-ac`: `- **AC1**: texto`
  - `ac-negrita`: `**AC-1: título**`, sin viñeta
  - `ac-vineta-titulada`: `- **AC1 — título**: texto`
  - `gherkin`: `GIVEN` / `WHEN` / `THEN`, suelto o dentro de un bloque `gherkin`; cada `GIVEN` abre un criterio
  - `dado`: `**Dado** … **Cuando** … **Entonces** …`; cada `Dado` abre un criterio
- Las tres primeras mandan: las otras sólo cuentan si la story no usa ninguna de ellas. `gherkin` y `dado` se numeran
  1, 2, 3… en el orden en que aparecen.
- Lo que no entra en ninguna deja la story **sin criterios**: entra siempre el revisor de cobertura de criterios, y el
  commit que la pasa a `review` o `done` frena con el motivo.

### 6. Tests (tabla)

```markdown
### Tests ({N} verificaciones)

| # | Test | AC | Nivel | Escenario | Resultado esperado |
|---|------|----|-------|-----------|--------------------|
| T1 | `NombreDelTest_Descriptivo` | 1 | unit | Descripcion del escenario | Resultado concreto esperado |
| T2 | `OtroTest_Descriptivo` | 1,3 | integration | Descripcion del escenario | Resultado concreto esperado |
```

**Reglas:**

- La primera columna (`#`) lleva el T-ID (`T1`, `T2`, … / `E1` para E2E) — es una de las claves que `pipeline.js mech-check` usa para matchear tabla ↔ código
- Nombre del test según la regla `test_names` de la organización (`pipeline.js org-rules`): `any` (de fábrica) no
  pide estilo; `pascal` pide `PascalCase_Descriptivo` (ej: `PostPedidos_NoApiKey_Returns401`); `snake` pide
  `snake_case` (ej: `test_post_pedidos_sin_clave_da_401`)
- **Columna `AC` (OBLIGATORIA)**: lista de números de AC que cubre el test (ej: `1` o `1,3`). Todo AC debe aparecer en al menos una fila (regla GOLD #2, verificada mecánicamente por ACCOV-C5)
- **Columna `Nivel` (OBLIGATORIA)**: `unit` | `integration` | `e2e`
- El escenario describe las condiciones de entrada
- El resultado esperado es concreto (codigo HTTP, evento emitido, estado final)
- Cubren: happy path, errores, edge cases, idempotencia, no-regresion

**Contrato AC↔test en código (tagging obligatorio):** cada test implementado declara en el código a qué story y AC pertenece:

- **xUnit (.NET)**: `[Trait("Story", "N.M")]` + `[Trait("AC", "1")]` en cada test (un `Trait("AC", ...)` por AC cubierto).
- **vitest / Playwright**: tag literal `@story-N.M` y `@ac-1` en el título del `describe`/`test` (ej: `test('@story-4.5 @ac-1 rechaza payload vacío', ...)`).
- **pytest**: `@pytest.mark.story("N.M")` + `@pytest.mark.ac(1)` en la función, o `@story-N.M @ac-1` en su docstring
  o en el `-k` del nombre (ej: `def test_story_4_5_ac_1_rechaza_payload_vacio`).
- **Un corredor declarado por la organización** (Go, Maven, Gradle, Karma u otro): el T-ID o la etiqueta
  `@story-N.M @ac-1` en el nombre de la prueba, que es lo que llega al reporte JUnit.

**Por qué:** permite verificación **MECÁNICA** de cobertura — `pipeline.js mech-check` cruza la tabla `### Tests` contra el código (matchea por Trait/tag/T-ID/nombre) y aplica ACCOV-C1 (test declarado que no existe) y ACCOV-C5 (AC sin test), en vez de depender de matching semántico por LLM. Además habilita correr la cobertura de un AC puntual: `dotnet test --filter "AC=1"`.

**Sub-bloque `Given/Fixture` (OPCIONAL, para tests no triviales):** debajo de la tabla, un bullet por test que lo necesite, con los datos concretos a seedear, el payload del request y la response esperada — todo lo que un agente necesita para escribir el test ROJO **antes** del código (ATDD, sub-step 4.0 del pipeline). Formato:

```markdown
#### Given/Fixture

- **T3** — Seed: pedido `P-123` con bolsa `C-1` en etapa ARMADO, etiqueta `E-1` impresa.
  Request: `POST /api/ceibo/armados/fin { "etiquetaId": "E-1" }`.
  Response esperada: `409 Conflict { "error": "Etiqueta ya finalizada" }`.
```

#### 6.1 Regla E2E obligatoria (stories con componentes frontend)

Si la story crea o modifica **una pantalla**, la tabla `### Tests` DEBE incluir al menos **1 smoke test E2E implementado** como parte de la story — no como "planificado para después". Qué cuenta como pantalla lo dice la regla `screen_test` de la organización (`pipeline.js org-rules`): `ui` (de fábrica) = `.tsx`, `.jsx`, `.svelte` y `.vue`; `react` = sólo `.tsx` y `.jsx`; `off` = la regla no se exige, y el cierre de la story lo dice.

El test E2E debe:
- Estar en un spec file concreto **ya creado** (ej: `tests/e2e/story-N-M-descripcion.spec.ts`)
- Tener todos sus `data-testid` confirmados como existentes en el código
- Estar corriendo (sin skip) antes de pasar la story a `review`
- Verificar al menos: el componente principal monta y es visible (wiring smoke)

Formato de la fila en la tabla Tests:

```markdown
| E1 | `E2E_NombreFeature_Escenario` | 3 | e2e | `story-N-M.spec.ts::NombreFuncion` — descripcion breve | Componente visible / data-status correcto |
```

Las filas E2E usan prefijo `E` (E1, E2, …) para distinguirlas de los tests unitarios (T1, T2, …).

**Anti-pattern a evitar**: declarar E2E en un bloque "Planificados" separado sin spec file ni sprint asignado. Por qué: los tests E2E separados en "Planificados" sin owner quedan como deuda técnica indefinida (medido: 10 en una story).

### 7. Tasks / Subtasks

```markdown
## Tasks / Subtasks

- [ ] [SEQ] Task 1: Descripcion concreta
  - [ ] Subtask con detalle
- [ ] [SEQ] Task 2: Siguiente tarea
- [ ] [PAR] Task 3: Tarea paralelizable (no depende de las anteriores)
```

**Reglas:**

- `[SEQ]` = secuencial, depende de la anterior. `[PAR]` = paralelizable
- Cada task referencia los ACs que implementa: `(AC: 1-6)`
- Las subtasks son checkboxes que se marcan al completar
- La primera task SIEMPRE es **Salvaguarda de BD** o **Salvaguarda de estado**: verificar que las asunciones de la spec coinciden con la realidad del codigo/BD

### 8. Task Dependencies

```markdown
### Task Dependencies

T1 → T2 → T3 → T4 (secuencial)
T5 puede ejecutarse en paralelo con T3-T4
```

### 9. Dev Notes

La seccion mas importante. Contiene TODO el contexto que el dev agent necesita.

```markdown
## Dev Notes
```

**Convención de citas a código que la story misma modifica (2026-09-06 · `VAL-W14`):** cuando la
story cita una ubicación DENTRO de un archivo que ella va a modificar, se cita el **miembro**
(método, propiedad, clase) como identidad estable — «`ValidatePayload` en
`Boundary/PluginBoundary.cs`» — y el número de línea, si va, va como ayuda («~142»), no como
referencia autoritativa: cualquier fix que la propia story aplique sobre su diff desplaza las
líneas que cita sobre sí misma (medido: tres desincronizaciones en una corrida, una
CRITICAL en el Step 1). Las citas a archivos que la story NO modifica pueden llevar `archivo:línea`,
que ahí es estable. El validador lo avisa como `VAL-W14`; no bloquea.

#### 9.1 Que existe hoy

Dividido en dos subsecciones:

```markdown
### Que existe hoy

#### En [sistema fuente] (source of truth)

**Archivo:** `ruta/al/archivo.ts` (N lineas)
- **Que hace:** Descripcion breve
- **Metodos clave:**
  - `metodo()` linea XX → que hace
  - Logica real (con snippet de codigo):
    ```csharp
    // Codigo REAL copiado del archivo fuente
    var remito = await depositoApi.GetRemitoAsync(pedidoId);
    ```

#### En Acme (lo que ya tenemos)

- **Archivo:** `src/AcmeBackend/Features/Pedidos/PedidoStore.cs`:
  - `TryMarcarArmadoAsync(pedidoId)` linea 107 — transicion atomica, retorna bool
- **No existe:** [listar lo que hay que crear]
```

**Reglas CRITICAS:**

- Toda referencia a un archivo **DEBE existir en el codebase** — verificar antes de escribir
- Toda referencia a un metodo **DEBE incluir el nombre del archivo y la linea**
- Si un metodo NO existe, decir explicitamente "NO existe — debe crearse"
- Incluir snippets de codigo REAL (no inventado) del sistema fuente

#### 9.2 Patron de referencia verificado (OBLIGATORIA en toda story de backend)

Esta seccion es **obligatoria en toda story que implemente codigo de backend** — sin excepcion por `approach`. Su proposito: garantizar que la story nace anclada a un patron YA RESUELTO en los proyectos hermanos, y no a un fix inventado.

**Contexto del equipo TYCON**: hay 4 plugins Bizuit .NET hermanos (`NimboBackend`, `TotoraBackend`, `FRESNOBZExtBackend`, `CeiboBackend`) + el repo del framework de plugins. Casi cualquier decision estructural —registracion DI, acceso al `BizuitUserContext`, lifecycle de hubs / hosted services, transacciones, routing de endpoints, contrato del plugin loader— YA esta resuelta de forma uniforme en esos hermanos. Una story de backend que toma una decision de ese tipo SIN citar como lo hacen los hermanos esta, por definicion, inventando.

La seccion debe contener **una de dos cosas**:

**(A) El patron hermano verificado** — cuando existe (el caso normal):

```markdown
### Patron de referencia verificado

**Patron**: <que se hace y como, en una frase>

| Proyecto hermano | Ancla `archivo:linea` (o comando `grep`) | Que se verifico exactamente |
|---|---|---|
| NimboBackend | `Features/Projects/ProjectsEndpoints.cs:91` | Abri el archivo: el handler recibe `BizuitUserContext userContext` como parametro, NO por ctor. |
| TotoraBackend | `grep -rl "readonly BizuitUserContext" src/TotoraBackend` | 0 resultados — ningun servicio ctor-inyecta el contexto. Corrido 2026-05-17. |
| FRESNOBZExtBackend | idem grep | 0 resultados. |

**Conteo / evidencia dura**: <ej: "3/3 plugins hermanos: 0 servicios con ctor-injection; Ceibo es el unico outlier con 12">.
```

**(B) La afirmacion explicita de que NO aplica** — solo cuando es genuinamente cierto:

```markdown
### Patron de referencia verificado

**No aplica**: <razon concreta>. Verifique los 3 plugins hermanos (`grep ...` sobre Nimbo / Totora / FRESNO) y ninguno tiene un patron equivalente para <concern>. Esta story crea el patron por primera vez.
```

**Reglas CRITICAS de esta seccion**:

- Cada ancla `archivo:linea` (o `grep` con su comando exacto) **debe RESOLVER**: el archivo existe, la linea esta en rango, y el patron esta realmente ahi. Quien escribe la story DEBE haber abierto el archivo. El validator lo verifica (`VAL-C8`) y el advisor `tycon-sibling-pattern-reviewer` lo confirma abriendo los archivos hermanos.
- "Que se verifico exactamente" es **especifico y verificable** — NO una descripcion generica. Mal: "Nimbo maneja el user context bien". Bien: "abri `ProjectsEndpoints.cs:91`, el handler recibe `BizuitUserContext userContext` como parametro; `grep readonly BizuitUserContext` → 0".
- 🔴 **Prohibido basar esta seccion en una asuncion no verificada**. Si la fuente del patron es un research agent que dijo "asumo", "probablemente", "creo que", o "no pude confirmar" → eso NO es evidencia. Hay que ir al codigo del hermano, abrir el archivo, y confirmar. Un "(asumo)" de un research agent alcanza para que una story proponga el fix opuesto al patron real.
- La opcion (B) "no aplica" **no es un escape**: si el advisor encuentra que ≥2 plugins hermanos SI tienen el patron para ese concern, la afirmacion (B) es falsa y se reporta CRITICAL (`XPAT-C3`). Usar (B) solo tras haber buscado de verdad.

> 📌 **Modelo a seguir**: esta seccion bien escrita trae conteo por plugin, anclas concretas, y que se verifico (el ejemplo (A) de arriba). Lo contrario —una story que propone el fix OPUESTO al patron real (registrar `BizuitUserContext` en DI) sin ninguna evidencia cross-proyecto— es el caso exacto que esta regla existe para prevenir.

#### 9.3 Que hay que hacer (la delta)

Lista numerada de lo que hay que implementar, con las diferencias clave vs el sistema fuente.

```markdown
### Que hay que hacer (la delta)

1. Crear X que hace Y (en Totora esto es Z)
2. Adaptar W cambiando A por B (Totora usa A, Pacara usa B)

**Diferencias clave vs [fuente]:**
- Fuente: [como era]. Pacara: [como sera].
```

#### 9.4 Implementacion concreta (opcional, para stories complejas)

Codigo de ejemplo o pseudo-codigo que muestra el approach exacto.

```markdown
### Implementacion concreta

**CRITICO: Read-modify-write para metadata.**
```csharp
// Patron correcto:
var currentJson = await repo.GetMetadataAsync(id);
var metadata = JsonSerializer.Deserialize<Dictionary<string, object>>(currentJson);
metadata["field"] = newValue;
await repo.UpdateMetadataAsync(id, JsonSerializer.Serialize(metadata));
```
```

#### 9.5 Archivos a crear/modificar

```markdown
### Archivos a crear/modificar

| Accion | Archivo |
|--------|---------|
| Crear | `src/AcmeBackend/Features/Pedidos/Webhooks/OrderSyncHandler.cs` |
| Modificar | `src/AcmeBackend/Features/Pedidos/StockManager.cs` (agregar ReleaseReservaIfHeldAsync) |
```

#### 9.6 Lo que NO hay que hacer

Lista explícita de anti-patrones, errores comunes, y scope boundaries.

```markdown
### Lo que NO hay que hacer

- **NO usar JSON_MODIFY de SQL Server** — read-modify-write en C# (leccion de sesion anterior)
- **NO crear el registro del cliente** en Path B — ya fue creado por POST /end
- **NO implementar heartbeat** (story separada)
- **NO aceptar extension en el request** (el backend la asigna, no el frontend)
```

**Reglas:**

- Cada item explica POR QUE no hay que hacerlo
- Incluye lecciones de stories anteriores
- Define los limites de scope (que NO es parte de esta story)

#### 9.7 Como verificar que funciona

```markdown
### Como verificar que funciona

```bash
# Tests unitarios
dotnet test --filter "NombreDelTest"

# Test manual con DevHost
curl -X POST http://localhost:5002/api/... | jq
# Esperado: 201 con pedidoId
```
```

Incluye comandos **copy-paste ejecutables**, no descripciones vagas.

#### 9.8 Salvaguarda de BD (cuando aplica)

```markdown
### Salvaguarda de BD (obligatoria antes de implementar)

1. `SELECT ... FROM ... WHERE ...` — verificar que X existe
2. Si CUALQUIER asuncion no coincide → DETENERSE → corregir spec primero
```

### 10. Dev Agent Record (se completa DESPUES de implementar)

El Dev Agent Record es **obligatorio** antes de commitear. Es la evidencia de que la story fue implementada correctamente. NUNCA commitear sin completarlo.

```markdown
## Dev Agent Record

### Agent Model Used

Modelo exacto usado para implementar, tal como lo informa la sesión (el mismo que va en el `Co-Authored-By` del commit).

### Debug Log References

Resultados de compilacion y tests. Debe incluir:
- Comando de build + resultado (0 errores o lista de errores resueltos)
- Comando de tests especificos + resultado (N/N PASS)
- Suite completa: si corrió (test-gate del pipeline, portón de `/tycon-merge-to-main` o cuando el dev la pide) → comando + resultado; si no, anotar "queda para el portón" (ver `guides/test-execution-discipline.md`)
- Hallazgos/spec anchors descubiertos durante la implementacion

Ejemplo:
- Build: `dotnet build` — 0 errores
- Tests: `dotnet test --filter "OrderSync"` — 9/9 PASS
- Suite completa (`test-gate.sh` del pipeline): 2725/2725 PASS, 0 regresiones
- Spec anchor: story decia `ProviderId = 1` (el proveedor A), el proveedor B es ProviderId=2
- Spec anchor: story decia "Crear PedidosEndpoints.cs" pero ya existia de la story <N.M>

### Completion Notes List

Resumen tecnico de lo que se implemento. Una linea por cada decision o componente relevante.
No es prosa — es una lista de hechos verificables.

Ejemplo:
- OrderSyncHandler: Path A stores WebhookData + extends TTL 300s; Path B enriches metadata via read-modify-write
- ReleaseReservaIfHeldAsync added to StockManager — removes the hold (stock freed implicitly)
- Metadata merge is idempotent — warehouse data overwrites the estimates
- Order: stopPolling → observer.stop → close panel → beforeunload → DOM → removeAllListeners → store.reset

### File List

TODOS los archivos creados o modificados. Formato: `ruta/archivo.ext (NEW | MODIFIED — descripcion)`.
Si un archivo fue modificado, indicar QUE se cambio.

Ejemplo:
- src/AcmeBackend/Features/Pedidos/Webhooks/OrderSyncHandler.cs (NEW)
- src/AcmeBackend/Features/Pedidos/StockManager.cs (MODIFIED — added ReleaseReservaIfHeldAsync)
- tests/AcmeBackend.Tests/Features/Pedidos/OrderSyncHandlerTests.cs (NEW — 9 tests)

### Change Log

Una linea por sesion de trabajo. Formato: `YYYY-MM-DD: Descripcion breve (Autor/Agente)`.

Ejemplo:
- 2026-04-15: Story implementada y verificada. 9/9 tests PASS, 2725/2725 full suite PASS.
- 2026-04-16: Fix spec anchor ProviderId — era 1012 no 1. Re-tested.
```

**Reglas del Dev Agent Record:**

1. **Completar ANTES de commitear** — sin record completo, no se commitea
2. **Marcar TODAS las tasks `[x]`** en la seccion Tasks/Subtasks con resultados
3. **Spec anchors**: si durante la implementacion se descubre que la story tenia un error (archivo inexistente, metodo renombrado, ID incorrecto), documentarlo en Debug Log como "Spec anchor: story decia X, realidad es Y"
4. **File List exhaustiva**: si olvidás un archivo, el reviewer no puede verificar que la implementacion esta completa
5. **Completion Notes accionables**: no "se implemento la story" sino QUE se implemento y COMO

### 11. Follow-ups y cambios post-firma (opcional, derivado de `followed_up_by:`)

Para stories `done` o `review` que tuvieron follow-ups posteriores (recalibraciones, fixes, scope changes — declarados en `followed_up_by:` del frontmatter), agregar al final del cuerpo un bloque humano-amigable que resuma qué entrega *hoy* la story respecto a lo originalmente firmado.

Es **OPCIONAL** — el frontmatter (`followed_up_by:`) es la fuente de verdad para tooling. La tabla del body es solo para humanos que abren el archivo a leerlo (PM, cliente, auditor externo).

```markdown
## Follow-ups y cambios post-firma

> Esta story se firmó/entregó originalmente en Sprint 3 con el scope listado arriba. Las siguientes stories posteriores modifican o extienden ese entregable. Ver frontmatter `followed_up_by:` para metadata estructurada.

| # | Story | Fecha | Tipo | Qué cambia |
|---|---|---|---|---|
| 1 | [13.3.9](./13-3-9-caserecappanel-incidencias-reales.md) | 2026-05-18 | fix | INCIDENCIAS muestra incidencias reales (no derivado de `estado`) |
| 2 | [13.3.10](./13-3-10-caserecappanel-loading-error-states.md) | 2026-05-18 | gap-fill | Loading skeleton + error banner separados |
| 3 | [13.3.12](./13-3-12-uselistadostore-scope-por-pedidoid.md) | 2026-05-19 | fix | useListadoStore scope por pedidoId — fin del singleton global |
```

Para auto-generar la tabla desde el frontmatter:
```bash
node ~/.claude/tycon-harness/scripts/tools/tycon-backfill-followups.js \
  --dir specs/stories --story <N.M> --render-table
```

---

## Reglas GOLD (calidad obligatoria)

### 1. Anclaje a codigo real

- **TODA** referencia a archivos, metodos, lineas debe existir en el codebase
- Si la story referencia `PedidoStore.TryMarcarArmadoAsync()`, ese metodo DEBE existir
- Si NO existe, la story debe decir "NO existe — debe crearse en esta story"
- Verificar con `grep` antes de escribir la story

### 2. Verificabilidad

- Cada AC debe poder traducirse a un test o query concreta
- Si no podés escribir un test para un AC, el AC es vago — reescribirlo
- Los tests de la tabla deben ser suficientes para verificar TODOS los ACs

### 3. Anti-reinvencion

- Identificar codigo existente que se reutiliza (con archivo y linea)
- Si hay un helper, service, o patron existente, referenciarlo
- Nunca crear algo que ya existe — la seccion "Que existe hoy" previene esto

### 4. Prevencion de desastres

- La seccion "Lo que NO hay que hacer" anticipa errores comunes
- Incluir lecciones de stories anteriores (de `tasks/lessons.md`)
- Anticipar problemas de DI (Singleton/Scoped), locale, mocking, encoding

### 5. Optimizacion para LLM dev agent

- Clara, concisa, accionable — sin prosa innecesaria
- El dev agent SOLO tiene este archivo — todo el contexto debe estar aca
- Snippets de codigo del sistema fuente incluidos (no "ver archivo X")
- Comandos de verificacion copy-paste ejecutables

### 6. Dev validation (pre-implementacion)

Antes de implementar, el dev agent debe poder responder SI a todas:

- ¿Puedo implementar sin preguntas?
- ¿Algo se siente inventado o asumido?
- ¿Falta contexto critico?
- ¿La verificacion es ejecutable?
- ¿Los archivos referenciados existen?

Si la respuesta a cualquiera es NO → corregir la story antes de escribir codigo.

### 7. Completitud del Dev Agent Record

NUNCA commitear sin completar:

- Tasks marcadas `[x]` con resultados
- Agent Model Used
- Debug Log con hallazgos
- Completion Notes
- File List con TODOS los archivos nuevos/modificados
- Change Log con fecha

### 8. Cobertura de modos de falla

Toda story debe tener AC explicitos para los caminos donde algo no existe / falla / esta vacio. Si la story es un happy-path puro, esta incompleta.

Antes de marcar una story `ready-for-dev`, responder estas preguntas y agregar AC por cada SI:

- ¿Que pasa si la entidad referenciada no existe en el sistema (canonical sin mapping, user sin postal code, item sin price, etc)? → AC con copy/comportamiento esperado.
- ¿Que pasa si una llamada externa falla (un 5xx del proveedor, LLM timeout, region resolve fail)? → AC con fallback o mensaje al user.
- ¿Que pasa si la coleccion esta vacia (search 0 resultados, lista sin items, super sin matches)? → AC con render esperado (no asumir que "se filtra").
- ¿Que pasa si el componente se renderea en otro layout/viewport/tema? → AC por cada layout afectado.
- ¿Que pasa si la story B (que depende de esta) lee un campo que esta nueva escribe? → AC del contrato de datos.

**Regla operativa**: por cada AC happy-path, debe haber al menos 1 AC de modo de falla relacionado. Si la lista de AC es N happy-path y 0 falla, la story esta incompleta.

**Lecciones de campo**:

- Story con un solo AC `"render con cell isGeneric=true,kind='exact'"` → bug post-merge: matrix tiene 2 layouts (mobile + desktop) y solo se implemento uno. Falto AC explicito por layout.
- Story con AC `"recompare con la marca elegida"` → bug post-merge: el orchestrator nunca leyo el campo del body porque otra story (que persistia DB) tomo precedencia. Falto AC cross-story.
- Story con AC `"si el super no tiene la marca, marcar unavailable"` pero sin AC `"copy del cell unavailable cuando el motivo es por preferencia explicita"` → bug post-merge: cell mostraba copy genérico "Este super no lo vende" en lugar de "No vende {marca}". Falto AC del modo de falla con detalle del copy.

### 9. Patron de referencia verificado (anti-invencion cross-proyecto)

**Toda story de backend** debe incluir la seccion "Patron de referencia verificado" (§9.2). NO es opcional y NO depende del `approach` autodeclarado.

- Si la decision estructural de la story (DI, auth / user-context, lifecycle, transacciones, routing, contrato del plugin loader, etc.) YA esta resuelta en un proyecto hermano → la story DEBE citar ese patron con anclas `archivo:linea` (o `grep` con comando exacto) que **resuelven** y abrir el archivo para confirmarlo.
- Si genuinamente no existe patron hermano → la story DEBE afirmarlo explicitamente con la razon y la evidencia de haber buscado (opcion B de §9.2).
- **Omitir la seccion = story MAL FORMADA.** Una story de backend sin patron citado ni afirmacion "no aplica" no se puede validar — no se sabe si reutiliza o inventa.
- 🔴 Una asuncion no verificada ("asumo", "probablemente", "no pude confirmar" de un research agent) **NUNCA** es base valida de esta seccion. La verificacion es ir al codigo del hermano y abrir el archivo.

**Por qué**: un error de runtime ("Unable to resolve service for type `BizuitUserContext`") puede generar una story `[ADAPT]` cuyo fix es LO OPUESTO al patron real (registrar `BizuitUserContext` en DI; los plugins hermanos NUNCA lo hacen — lo reciben como parametro de handler). Sin esta seccion, la story se escribe y se valida sin citar ni verificar el patron hermano. Con la seccion §9.2 obligatoria, el autor abre los plugins hermanos y ve el patron real antes de escribir una linea.

---

## Ejemplo completo minimo

```markdown
---
epic: 7
story: "7.1"
title: "POST /pedidos/{pedidoId}/despachar -- pedir el retiro al transporte"
status: ready-for-dev
sprint: 5
priority: "P0"
approach: "[CREATE]"
depends_on: ["2.3"]
---

# Story 7.1: POST /pedidos/{pedidoId}/despachar -- pedir el retiro al transporte

Status: ready-for-dev

## Story

Como panel de pedidos de Acme,
quiero un endpoint POST /pedidos/{pedidoId}/despachar que pida el retiro a la API del transporte,
para que el backend inicie el despacho en vez de depender de que el operador lo cargue a mano.

## Acceptance Criteria

### Flujo principal
1. Valida que el pedido existe y esta en estado `Armado`
2. Llama a la API del transporte: `POST /v1/retiros?remito={remito}&sucursal={sucursal}&urgente=false`
3. Transiciona el pedido a `EnDespacho`
4. Retorna 200 OK con `{ pedidoId, status: "despachando" }`

### Errores
5. Pedido no encontrado → 404 Not Found
6. Pedido vencido → 410 Gone
7. Estado no es `Armado` → 409 Conflict
8. La API del transporte falla → 502 Bad Gateway

### Tests (5 verificaciones)

| # | Test | AC | Nivel | Escenario | Resultado esperado |
|---|------|----|-------|-----------|--------------------|
| T1 | `Despachar_PedidoArmado_Returns200` | 1,2,3,4 | integration | Pedido en Armado | 200 con status=despachando |
| T2 | `Despachar_PedidoNotFound_Returns404` | 5 | integration | pedidoId inexistente | 404 |
| T3 | `Despachar_PedidoVencido_Returns410` | 6 | integration | Pedido con plazo vencido | 410 |
| T4 | `Despachar_WrongState_Returns409` | 7 | integration | Pedido en Entregado | 409 |
| T5 | `Despachar_TransporteFails_Returns502` | 8 | integration | API retorna error | 502 |

## Tasks / Subtasks

- [ ] [SEQ] Task 1: Salvaguarda — verificar ITransporteService, PedidosService, PedidosEndpoints existen
- [ ] [SEQ] Task 2: Agregar PedirRetiroAsync a ITransporteService + TransporteApiService
- [ ] [SEQ] Task 3: Agregar DespacharAsync a PedidosService
- [ ] [SEQ] Task 4: Agregar endpoint POST /pedidos/{pedidoId}/despachar a PedidosEndpoints
- [ ] [SEQ] Task 5: Tests + verificacion

### Task Dependencies

T1 → T2 → T3 → T4 → T5

## Dev Notes

### Que existe hoy

#### En Acme

- **Archivo:** `src/AcmeBackend/Services/TransporteApiService.cs`
  - `MakeRequestAsync()` linea 77 — request autenticado con HMAC-SHA1 a la API del transporte
  - Patron para agregar nuevo metodo: copiar `GetCotizacionAsync()` linea 123
- **Archivo:** `src/AcmeBackend/Features/Pedidos/PedidosService.cs`
  - `CrearPedidoAsync()` linea 57 — crea el pedido, reserva stock
  - El pedido tiene `Remito` y `Sucursal` que necesitamos para pedir el retiro
- **No existe:** metodo `PedirRetiroAsync`, metodo `DespacharAsync`, endpoint `/despachar`

### Que hay que hacer (la delta)

1. `PedirRetiroAsync` en TransporteApiService: `POST /v1/retiros` con params remito, sucursal, urgente
2. `DespacharAsync` en PedidosService: get pedido → validate state → pedir retiro → transition to EnDespacho
3. Endpoint `POST /pedidos/{pedidoId}/despachar` en PedidosEndpoints: auth + error mapping

### Lo que NO hay que hacer

- **NO pedir el retiro desde el panel** — el backend lo dispara contra la API del transporte
- **NO usar urgente=true** — con urgente=false el transporte agrupa los retiros de la sucursal (un solo viaje)
- **NO cambiar el flujo de POST /pedidos** — ese endpoint sigue igual, solo crea el pedido

### Como verificar que funciona

dotnet build
dotnet test --filter "Despachar"

## Dev Agent Record

(se completa despues de implementar)
```

---

## Checklist rapido para validar una story

- [ ] Frontmatter completo (epic, story, title, status, sprint, priority, approach, depends_on)
- [ ] Frontmatter: `files_to_create` / `files_to_modify` declarados (recomendado-fuerte — los consumen `on-edit.js` y `pipeline.js risk-class`)
- [ ] Frontmatter: `driver:` de 2-3 líneas máximo + link (el incidente completo vive UNA sola vez en el body — §1.3)
- [ ] Story en formato "Como X, quiero Y, para Z"
- [ ] ACs numerados, verificables, con archivos reales referenciados
- [ ] ACs de comportamiento en formato Given/When/Then (los declarativos simples pueden ser prosa numerada)
- [ ] Tabla de tests con nombre, escenario, resultado + columnas `AC` y `Nivel` (OBLIGATORIAS — las consume `pipeline.js mech-check`)
- [ ] Todo AC cubierto por al menos un test en la columna `AC` (ACCOV-C5)
- [ ] Tasks con `[SEQ]`/`[PAR]`, primera task es salvaguarda
- [ ] Task dependencies explicitas
- [ ] Dev Notes: "Que existe hoy" con archivos y lineas reales
- [ ] Dev Notes: "Patron de referencia verificado" (OBLIGATORIA en toda story de backend) — patron hermano con anclas `archivo:linea` que resuelven, O afirmacion explicita "no aplica" con evidencia
- [ ] Dev Notes: "Que hay que hacer" con la delta
- [ ] Dev Notes: "Lo que NO hay que hacer" con razones
- [ ] Dev Notes: "Como verificar" con comandos ejecutables
- [ ] Todo archivo/metodo referenciado EXISTE en el codebase (o dice "NO existe")
- [ ] Sin prosa innecesaria — todo es accionable
