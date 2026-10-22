---
name: clocki
description: Registro automático de horas en Clockify para quien desarrolla con el arnés. Abre y cierra entries de tiempo en Clockify cuando se trabaja en una story, un fix, un refactor o una sesión de planning. Usa auto-match por nombre de carpeta para resolver project, pide confirmación antes de arrancar, y cierra timers idle (>15min sin actividad) retroactivando el end-time al último activity timestamp. Usar cuando el usuario invoca /clocki start|stop|status|config, cuando un hook inyecta system-reminder de intent de trabajo detectado, o cuando tycon-pipeline llama clocki:start con el título de la story.
---

# clocki — Clockify Time Tracking

Skill que controla un timer activo de Clockify por cwd (working directory). Diseñado para que un equipo tenga registro de horas automático sin fricción.

## Subcomandos

Cuando el usuario tipea `/clocki <subcommand>` o cuando un hook lo invoca, ejecutar:

| Subcomando | Qué hace |
|---|---|
| `start "descripción" [--project NAME]` | Abre un timer en Clockify. Si ya hay activo en este cwd, lo cierra primero (transición atómica). |
| `stop` | Cierra el timer activo de este cwd **definitivamente** (fin de jornada, fin de trabajo). NO usar si vas a empezar otra tarea inmediatamente — usar `start` en su lugar. |
| `status` | Muestra estado del timer activo (descripción, project, tiempo corrido). |
| `config` | Configura mapping manual cwd → workspace/project (override del auto-match). |
| `sweep` | Cierra timers idle >15min (lo invoca el hook, pero el dev puede correrlo a mano). |

## 🔴 Nombres de las tools de Clockify — Claude vs Codex (2026-08-24)

Las tools MCP de Clockify tienen **guiones** en el nombre (son de un paquete de terceros, no las
renombramos): `mcp__clockify__create-clockify-time-entry`, `...update-clockify-time-entry`,
`...list-clockify-projects`, `...list-clockify-workspaces`, `...list-clockify-time-entries`,
`...get-clockify-user`. En este skill y en los steps del pipeline aparecen **con guiones**.

**Bajo Codex el MISMO tool viene con GUIONES BAJOS** (`mcp__clockify__create_clockify_time_entry`,
`...list_clockify_workspaces`, etc.): Codex sanea `-`→`_` al armar el nombre de la tool. **Es la misma herramienta, sólo cambia el separador.**

🔴 **Regla operativa (agnóstica de herramienta)**: cuando este skill nombre una tool
`mcp__clockify__*` con guiones, usá la variante que EXPONGA TU SESIÓN — guiones en Claude, guiones
bajos en Codex. **NUNCA concluyas "la tool no existe" por el separador**: mirá qué tool de Clockify
está disponible y usá esa. Este es el modo de falla que apagaba el tracking en silencio bajo Codex.

## 🔴 Regla atómica close+open (anti-billing-gap)

**NUNCA usar `mcp__clockify__update-clockify-time-entry` directo para "cerrar y seguir trabajando"** — eso deja billing gap. Pattern obligatorio:

| Situación | Comando correcto | Comando INCORRECTO |
|---|---|---|
| Transición a otra tarea (sigo trabajando) | `clocki:start "nueva descripción"` (auto-cierra previa atómicamente) | ❌ `update-clockify-time-entry end=now` solo |
| Fin de jornada / fin de trabajo | `clocki:stop` | ❌ `update-clockify-time-entry end=now` solo |
| Ajustar timestamp de una entry ya cerrada | `update-clockify-time-entry` (rectificación retroactiva) | OK pero rara — usualmente innecesario |

**Verificación**: si llamás `update-clockify-time-entry` para CERRAR una entry, en el mismo bloque tool-call DEBE haber:
- Un `create-clockify-time-entry` para la nueva tarea (si trabajo continúa), Y
- Un `Write` actualizando `~/.claude/clocki/active/<sessionId>.json` con el nuevo entryId.

Si no hay (a) Y (b) → estás creando billing gap: cerrar la entry de una tarea y empezar la siguiente sin crear la entry nueva deja ese tiempo sin registrar.

## Estado local

Todo el estado vive en `~/.claude/clocki/` (NO commiteado, es por-dev).

### `active/<sessionId>.json` — timers activos, un archivo por sesión

Cada sesión tiene **su propio archivo** en `~/.claude/clocki/active/`,
nombrado por su `sessionId`. El archivo contiene `{ cwd: entry }` — los timers de
esa sesión, keyados por cwd. Dos sesiones en el mismo proyecto **no se pisan ni el
state ni los writes**: cada una lee/escribe solo su archivo.

```
~/.claude/clocki/active/
├── 11111111-aaaa-4aaa-8aaa-111111111111.json   ← sesión A
└── 22222222-bbbb-4bbb-8bbb-222222222222.json   ← sesión B
```

Cada archivo (`active/<sessionId>.json`):

```json
{
  "/Users/<dev>/Proyectos/Ceibo": {
    "entryId": "abc123",
    "workspaceId": "ws-xxx",
    "projectId": "prj-yyy",
    "description": "Story <N.M> — Webhook handler",
    "startedAt": "2026-05-12T11:30:00",
    "lastActivity": "2026-05-12T11:47:12",
    "source": "tycon-pipeline"
  }
}
```

`lastActivity` se actualiza con el hook `PostToolUse` (touch-activity.js) que escribe
**solo el archivo de la sesión actual**. El campo `source` es uno de: `tycon-pipeline`,
`hook-intent`, `manual`. Timestamps en **hora local bare** (ver "Reglas de timestamps").

**🔴 Por qué un archivo por sesión (fix race 2026-05-17):** el modelo anterior
(`active.json` único keyado `cwd → sessionId → entry`) resolvía la colisión de *keys*
pero no la de *escrituras*: dos `touch-activity` concurrentes hacían read-modify-write
del mismo archivo y uno pisaba al otro (un timer se perdía). Con un archivo por sesión
no hay archivo compartido → cero contención. `sweep`/`on-prompt`/`clocki-enforce` leen
**todas** las sesiones (`readdir` de `active/`); solo `touch-activity` y los flujos
`start`/`stop` escriben, y siempre el archivo propio.

**🔴 De dónde sale el `sessionId`:** los hooks reciben `session_id` en su input stdin;
`marker.js`/scripts también lo leen de `process.env.CLAUDE_CODE_SESSION_ID`. Los
reminders que emiten los hooks **incluyen el path exacto** del archivo a usar
(`~/.claude/clocki/active/<sessionId>.json`). El skill NUNCA infiere el `sessionId`.

**Formato legacy:** versiones pre-2026-05-17 usaban un único `~/.claude/clocki/active.json`
(`{cwd:entry}` o `{cwd:{sid:entry}}`). `readActive()` lo sigue **mergeando** para no
perder timers abiertos en la transición. El formato `{cwd:{sid:entry}}` conserva el
`sessionId` real; solo el formato más viejo `{cwd:entry}` (sin sessionId) aparece bajo
el sintético `_legacy`.

**🔴 Migración automática (fix 2026-05-17):** cuando `touch-activity` encuentra un timer
de su sesión que vive en el `active.json` legacy, lo **migra** al archivo per-session
(`active/<sessionId>.json`) refrescando `lastActivity`, y lo drena del legacy. Esto es
**obligatorio**: `touch-activity` solo escribe archivos per-session, así que una entry
que quedara en el legacy nunca vería su `lastActivity` actualizado → falso idle → el
sweep la cerraba **aunque la sesión estuviera viva**.
`readActive()` mergea el legacy **primero** y los per-session **después**, así la copia
per-session (fresca) gana sobre la legacy (stale) si la migración no alcanzó a drenarla.

**🔴 Regla de escritura:** una sesión SOLO lee/escribe `active/<suSessionId>.json`.
`Read` ese archivo, modificá la key `[cwd]`, `Write`. NUNCA toques el archivo de otra
sesión. NUNCA `printf '{}'` global.

### `heartbeat/<sessionId>` — señal de liveness de sesión

Cada sesión escribe `~/.claude/clocki/heartbeat/<sessionId>` (contenido:
timestamp local-bare) en **cada hook de clocki que corre** — `touch-activity` (cada tool
use), `on-prompt` (cada prompt), `sweep` (SessionStart), `clocki-enforce` (cada
Edit/Write). Es una señal de **liveness independiente del timer**: dice "esta sesión
ejecutó algo hace N minutos", haya timer abierto o no.

**Para qué sirve:** el `sweep` la usa como **gate** antes de cerrar un timer idle. Un
timer con `lastActivity` stale NO implica sesión muerta — el `lastActivity` puede estar
congelado por un bug (caso legacy, ver arriba) mientras la sesión trabaja activamente.
El heartbeat desambigua: **`lastActivity` stale + heartbeat fresco ⟹ sesión viva, NO
cerrar**; **`lastActivity` stale + heartbeat stale ⟹ sesión confirmada muerta, cerrable**.

El sweep limpia heartbeats con idle >24h (housekeeping). El `_legacy` sintético nunca
tiene heartbeat → `Infinity` → no protege (correcto: no es una sesión real).

### `project-cache.json` — cache de auto-match

```json
{
  "/Users/<dev>/Proyectos/Ceibo": {
    "workspaceId": "ws-xxx",
    "projectId": "prj-yyy",
    "matchedName": "Ceibo",
    "matchedAt": "2026-05-12T10:00:00Z"
  }
}
```

Evita llamar `list-clockify-projects` cada vez. Invalidable a mano borrando la entry.

### `settings.json` — config global (overrides opcionales)

```json
{
  "idleTimeoutMinutes": 15,
  "defaultWorkspaceId": null,
  "intentKeywords": [],
  "stopKeywords": []
}
```

`defaultWorkspaceId: null` → usar la default del user (primer workspace que devuelve `list-clockify-workspaces`).

**🔴 Keywords — defaults hardcoded en código (2026-05-14 fix)**

`intentKeywords` y `stopKeywords` viven en `scripts/on-prompt.js` como constantes `DEFAULT_INTENT_KEYWORDS` / `DEFAULT_STOP_KEYWORDS`. El settings.json local solo se consulta para **override**:

- Array missing o vacío en settings.json → usa defaults hardcoded (lo que el dev espera).
- Array con elementos en settings.json → **reemplaza completo** los defaults (el dev opta-in a su propia lista, asume control).

**Por qué este diseño**: si `install-clocki-hooks.sh` escribe settings.json sin `intentKeywords` y el script hace `settings.intentKeywords || []`, el array queda vacío y no sale ningún reminder: devs nuevos o máquinas nuevas terminan con el hook **mudo** sin saberlo. Por eso los defaults viven en el script. Settings.json queda como customization, no como fuente primaria.

**Cómo agregar tu propia keyword sin perder los defaults**: copiar los defaults del script + agregar la tuya en settings.json. No hay merge automático (decisión deliberada: el override es atómico para que sea predecible).

## Flujo de `start`

Cuando se invoca `clocki:start "descripción" [--project NAME]`:

1. **Leer estado**: obtené tu `sessionId` (del reminder del hook o `$CLAUDE_CODE_SESSION_ID`;
   si no, `_nosession`). `Read ~/.claude/clocki/active/<sessionId>.json` (tu archivo propio,
   forma `{ cwd: entry }`). Obtené el `cwd` actual.

2. **Cerrar timer activo previo de ESTA sesión en este cwd** (si existe):
   - Si tu archivo tiene la key `[cwd]`, llamar `mcp__clockify__update-clockify-time-entry` con `end = <tu archivo>[cwd].lastActivity` (NO `now` — el `lastActivity` representa la última vez que se trabajó, antes del idle gap. Consistente con el flujo `stop`).
   - Remover esa key del archivo (`delete [cwd]`; si el archivo queda `{}`, borralo). Es tu archivo — no afecta a otras sesiones.

3. **Resolver project** (orden de prioridad):
   - Si vino `--project NAME` explícito → buscar ese nombre en Clockify.
   - Si `project-cache.json[cwd]` existe → usarlo.
   - **Auto-match**: extraer basename del cwd (ej: `Ceibo`). Llamar `mcp__clockify__list-clockify-projects` (workspace default). Buscar match por:
     1. Match exacto case-insensitive
     2. Match parcial (basename contiene project name o viceversa)
     3. Si no hay match único → preguntar al usuario qué project usar (lista hasta 10 opciones).
   - Guardar el resultado en `project-cache.json` con `Write`.

4. **Crear entry**:
   - Llamar `mcp__clockify__create-clockify-time-entry` con:
     - `workspaceId`, `projectId` resueltos
     - `description` = el argumento
     - `start` = ahora en **hora LOCAL**, formato bare `YYYY-MM-DDTHH:MM:SS` (sin offset, sin `Z`) — obtener via `date "+%Y-%m-%dT%H:%M:%S"` (SIN `-u`). El MCP de Clockify recibe el timestamp en local y lo convierte a UTC al guardar. 🔴 NUNCA pases UTC (`date -u` / `toISOString()`): el MCP lo interpretaría como local → la entry queda corrida por tu offset (caso real 2026-05-17: pasé UTC `12:08:26`, Clockify guardó `15:08:26Z`, +3h en Argentina UTC-3). Ver sección "Reglas CRÍTICAS de timestamps".
     - `end` = MISMO valor que `start` (NO null, NO futuro). El MCP wrapper requiere `end` como string obligatorio. Esto crea entry con duración ~0 que se extiende en cada touch-activity update.
   - **🔴 NUNCA usar `end` en el futuro** como placeholder de "running entry" — Clockify muestra duración fake y los hours billables quedan inflados.

5. **Persistir estado**: `Read ~/.claude/clocki/active/<sessionId>.json` (o `{}` si no existe), set la key `[cwd]` con la nueva entry (`entryId, workspaceId, projectId, description, startedAt = now, lastActivity = now, source = <contexto>`), y `Write` ese archivo. Es tu archivo exclusivo — no hay otras sesiones que preservar dentro.

6. **Confirmar al usuario**: "✓ Timer abierto en Clockify: `<desc>` en project `<name>`. Cerrará automáticamente tras 15min idle o con `/clocki stop`."

## Flujo de `stop`

1. `Read ~/.claude/clocki/active/<sessionId>.json`. Buscar la key `[cwd]` (con walk-up por parents si el cwd es subdir). Si no hay entry → "No hay timer activo de esta sesión en este cwd." y terminar.
2. Llamar `mcp__clockify__update-clockify-time-entry` con `end = <tu archivo>[cwd].lastActivity` (NO `now` — usar el último activity timestamp así no contamos tiempo idle).
3. Eliminar esa key (`delete [cwd]`; si el archivo queda `{}`, borralo) y `Write`. Es tu archivo — no afecta a otras sesiones.
4. Confirmar: "✓ Timer cerrado. Duración: H:MM."

## 🔴 Reglas CRÍTICAS de timestamps (billing-grade)

Los timestamps de Clockify son **críticos para billing/trazabilidad de horas del cliente**. Errores frecuentes que se deben EVITAR:

### 🔴 Timezone — SIEMPRE hora LOCAL bare

**TODO timestamp enviado al MCP de Clockify (`start`, `end`) DEBE estar en hora LOCAL, formato bare `YYYY-MM-DDTHH:MM:SS` (sin offset, sin `Z`).**

El MCP de Clockify recibe el timestamp en hora local y **lo convierte a UTC** al guardar (su schema lo dice: `start`/`end` en "Local timezone"). Verificación empírica 2026-05-17: pasar `start=2026-05-17T12:08:26` → Clockify guardó `2026-05-17T15:08:26Z` (el MCP sumó el offset +3h de Argentina).

- Obtener "ahora" en local bare: `date "+%Y-%m-%dT%H:%M:%S"` (SIN `-u`) → `2026-05-17T09:08:26`.
- `lastActivity` / `startedAt` en `active/<sessionId>.json` se guardan en **local bare** (`nowIso()` en `lib.js` los produce así), justamente para que `end = lastActivity` se pase directo al MCP sin conversión.

**❌ NUNCA pases UTC al MCP** (`date -u` o `new Date().toISOString()` → `...Z`). El MCP interpreta lo que recibe como local → si le das UTC, le suma OTRO offset → la entry queda corrida (3 h con el offset de Argentina).

| ❌ Anti-patrón | ✅ Pattern correcto |
|---|---|
| `start`/`end` = valor UTC (`date -u`, `toISOString()`) | `date "+%Y-%m-%dT%H:%M:%S"` (local bare, SIN `-u`) |
| `end = "5:00 PM"` arbitrario | `end = active/<sessionId>.json[cwd].lastActivity` (literal del JSON, ya local bare) |
| `end = futuro` como "running placeholder" | `end = start` inicial; update periódico con `now` real |
| Update múltiple persiguiendo "timestamp perfecto" | Una sola corrección con valor real, no insistir |
| `end = now` al close (incluye idle gap) | `end = lastActivity` (excluye idle) |
| Inventar duración estimada | Solo timestamps de actividad real registrada |

**Verificación obligatoria antes de cualquier `update-clockify-time-entry`**:
1. Si `end` viene del flujo `stop` → MUST ser `active/<sessionId>.json[cwd].lastActivity` literal (ya local bare).
2. Si `end` viene del flujo `start` (cerrar previo) → MUST ser `previousEntry.lastActivity` literal (ya local bare).
3. Si `end` representa "ahora" en un running entry → MUST ser `date "+%Y-%m-%dT%H:%M:%S"` ejecutado en este momento (local bare, NO un timestamp inventado, NO UTC).
4. NUNCA `end > now`.

## Flujo de `status`

1. `Read ~/.claude/clocki/active/<sessionId>.json`.
2. Si hay entry para la key `[cwd]` (walk-up incluido) → mostrar: descripción, project, start, lastActivity, duración corrida.
3. Si no hay entry de esta sesión, opcionalmente revisá los otros `active/*.json` — si hay timers de otras sesiones en el mismo cwd → mencionarlo ("Sin timer de esta sesión. Otras sesiones activas en este cwd: <descripciones>").
4. Si no hay nada → "Sin timer activo en `<cwd>`."

## Flujo de `config`

Diálogo interactivo:
1. "¿Qué workspace? (números, listo desde `list-clockify-workspaces`)"
2. "¿Qué project? (números, listo desde `list-clockify-projects`)"
3. Persistir en `project-cache.json[cwd]` con `matchedName = <manual>`.
4. "✓ Mapping configurado. Próximo `/clocki start` usa este project sin preguntar."

## Flujo de `sweep`

Lo invocan los hooks `SessionStart` y `UserPromptSubmit` via Node.js scripts. NO requiere intervención del agente por defecto.

**🔴 POLÍTICA — 3 buckets (2026-07-25, revisión de la regla de 2026-06-05).** El sweep recorre `flattenActive` y clasifica cada timer idle >`idleTimeoutMinutes` en uno de tres:

| Bucket | Condición | Qué hace el sweep |
|---|---|---|
| **Propio** | `sessionId === session_id` del hook | Lo lista para cerrar (trim a `lastActivity`) |
| **Huérfano** | Otro `sessionId` REAL, sin heartbeat hace >`deadSessionMinutes` (default 120) | Lo lista para cerrar (trim a `lastActivity`) |
| **Vivo** | Otro `sessionId` con heartbeat reciente | 🔴 **INTOCABLE** — ni lo lista |
| **Pseudo** | `_legacy` / `_nosession` | Lo lista **pidiendo confirmación al humano** — nunca se auto-cierra |

Sin `session_id` en el input del hook, el sweep no toca nada.

**Por qué existe el bucket "huérfano":** un `sessionId` no se reusa — cerrás la ventana y ese id no vuelve. Si el sweep sólo gestionara su propia sesión y delegara los zombies a que "ESA misma sesión resuma", un timer huérfano no lo cerraría nadie jamás: queda en cero segundos, con trabajo real sin facturar, y los archivos de estado se acumulan.

**Por qué es seguro:** **`_legacy` nunca tiene heartbeat**, así que un gate que mirara `lastActivity` + heartbeat la vería siempre muerta y cerraría un `_legacy` que está vivo. Por eso el gate usa el heartbeat SOLO para `sessionId` reales y manda las pseudo-sesiones al bucket de confirmación humana. (Una sesión viva refresca su heartbeat en cada hook, así que nunca cae en "huérfano".)

**Trim, siempre.** Todo cierre usa `end = lastActivity`, jamás "ahora": un huérfano de hace 3 semanas no puede inventar 3 semanas de trabajo.

**Housekeeping** (mismo hook): `cleanStaleHeartbeats()` borra heartbeats >24h y `cleanEmptyActiveFiles()` borra los `active/*.json` que quedaron en `{}` con mtime >24h. Nunca toca un archivo con contenido.

## Hook `on-prompt` — detección de intent (4 capas)

El hook `UserPromptSubmit` (`scripts/on-prompt.js`) hace 4 cosas (en orden):

### 1. Sweep (igual que SessionStart)

Cierra stale si los hay (timers idle >15min en cualquier cwd).

### 2. STOP-detection (NEW 2026-05-14) — timer activo + prompt indica fin/transición

Si HAY timer activo **de esta sesión** en este cwd Y el prompt contiene alguno de `stopKeywords`
(`listo`, `cerremos`, `ya está`, `terminamos`, `done`, `mergeado`, `pusheado`,
`merge a main`, `/clocki stop`, `ahora hagamos`, `siguiente tarea`, etc),
emite system-reminder pidiendo al agente que cierre el timer (o transicione
a uno nuevo atómicamente si el prompt indica next-task).

**Por qué:** sin esta capa el skill nunca cerraba timers al fin de tarea.

### 3. TASK-CHANGE detection (NEW 2026-05-14) — timer activo + nuevo intent distinto

Si HAY timer activo **de esta sesión** Y el prompt contiene un `intentKeyword` (start-keyword) PERO ninguna
palabra significativa (≥4 chars) de la descripción current está en el prompt, sugiere
posible transición a OTRA tarea. Emite reminder pidiendo al agente que pregunte al user
si es transición → cerrar previo + abrir nuevo en mismo tool-call.

Falsos positivos esperados: prompts genéricos como *"implementemos esto otro"* sin
referencia explícita. Por eso el reminder pide CONFIRMACIÓN al user, no cierra automático.

### 4. INTENT-START detection — sin timer activo + prompt parece trabajo

Si NO hay timer activo **de esta sesión** en el cwd Y el prompt del user contiene alguno
de `intentKeywords` (case-insensitive), emite system-reminder pidiendo al agente que
proponga abrir timer con confirmación del user. (Que otra sesión tenga un timer en el
mismo cwd NO suprime el reminder — esta sesión necesita el suyo propio.)

**Keywords (2026-05-14 audit — precision-first)**:
- ✅ Imperativos / first-person plural: `implementemos`, `implementar`, `fixeemos`,
  `arreglemos`, `refactoricemos`, `agreguemos`, `trabajemos`, `empecemos`,
  `arranquemos`, `creemos`, `let's implement`, `let's fix`, `let's refactor`,
  `let's build`, `let's add`, etc.
- ❌ Removidos (ruido extremo): `story`, `task`, `tarea`, `review`, `revisar`,
  `plan`, `planning`, `analyze`, `design`, `investigar`. Matcheaban casi cualquier
  conversación.

El agente JUZGA si corresponde abrir timer. Si sí, propone al user con confirmación.
**Nunca abre sin preguntar** (regla del usuario: "Auto pero con confirmación").

## Integración con tycon-pipeline

El pipeline no nombra a Clockify: emite el aviso de trabajo (`pipeline.js work-signal start|stop`) y esta integración
(`scripts/on-work.js`) le contesta al agente, en `action`, qué hacer con el MCP. Lo que sigue es ese «qué hacer».

### Arranque desde el pipeline (paso 0b, «Arranque: aviso de trabajo»)

La acción de `start` manda a abrir la entrada con el «Flujo de `start`» de arriba, con:
- `description` = `Story <id> — <title>` (del frontmatter; cap 100 caracteres)
- `source` = `tycon-pipeline`
- **SIN pedir confirmación** — el pipeline es intent explícito. La única pregunta posible es el proyecto, si el
  auto-match no da uno solo: se hace antes del fan-out del arranque.
- **Si NINGUNA tool de Clockify está disponible** → saltear con `⚠ Clockify: MCP no disponible, sigo sin registrar`.
  🔴 Chequeá las DOS variantes de nombre: bajo Codex vienen con **guiones bajos**
  (`mcp__clockify__list_clockify_workspaces`), no con guiones — ver «Nombres de las tools de Clockify». No saltees sólo
  porque no encontrás el nombre EXACTO con guiones: eso apagaba el registro en silencio bajo Codex.

🔴 **Regla atómica**: cerrar la previa de este cwd (paso 2 del flujo), crear la nueva (paso 4) y persistir (paso 5) van
en el MISMO bloque de llamadas. Si se cierra y no se abre la sucesora, el tiempo entre una y otra queda sin registrar:
el pipeline sigue, pero se avisa como CRITICAL. Después de persistir, verificar que el `entryId` del archivo de la
sesión sea el de la respuesta de `create`.

Lo que deja escrito en `.advisors/pipeline-runs/<clave>-<sello>/step-01-start.md`: integración `clockify`, la
acción (`entryId`, `projectId`, `description`, `startedAt`) y el status.

### Cierre desde el pipeline (paso 9, «Cerrar la historia»)

La acción de `stop` manda a:

1. **Cerrar la entrada abierta** de esta sesión en el cwd de la story, si hay una, con
   `mcp__clockify__update-clockify-time-entry` y `end = ahora` en hora local (no `lastActivity`: el cierre es explícito
   por finalización del trabajo). Sacarla del archivo de la sesión. Si falla (red, 401): un aviso de una línea; el
   sweep la cierra después.
2. **Sumar las entradas de la historia** para `CompletedWork`, aunque no hubiera ninguna abierta (las que cerró el sweep
   por inactividad también son trabajo de la story):
   - workspace y proyecto, de `~/.claude/clocki/project-cache.json` para el cwd (sólo lectura);
   - ventana: desde el primer commit de la story (`git log --reverse --pretty=format:"%aI" -- <story_path> | head -1`)
     hasta el merge a main más 24 h;
   - `mcp__clockify__list-clockify-time-entries` con `workspaceId`, `userId` (de `mcp__clockify__get-clockify-user`),
     `projectId` y la ventana;
   - quedarse con las que dicen `Story <id>` (sin distinguir mayúsculas) o una palabra fuerte del título, mostrarle al
     dev las candidatas y pedir confirmación (las de descripción genérica, como «fix typo», las decide él);
   - sumar `durationSeconds`. Sin ninguna, no hay tiempo: no se inventa. Workspace o proyecto sin resolver: sin tiempo,
     con el motivo.

El cierre de la entrada ocurre en estas 4 condiciones (en orden de precedencia):

1. **Step 9 del pipeline la cierra** (2026-05-13) cuando el dev invoca el step de cierre ADO (`"cerrá la story X en ADO"` / `"marco done la story X"` / `/tycon-pipeline close <path>`): la acción de `stop` de arriba, con `end=now`.
2. El dev empieza otra cosa (nuevo `clocki:start` cierra el previo).
3. Idle > 15min sin actividad (sweep cierra retroactivamente con `end=lastActivity`).
4. El dev tipea `/clocki stop` manualmente (cierra con `end=lastActivity`).

**Nota: el commit + push + revisión post-pipeline también es trabajo en esa story** — el timer sigue corriendo durante ese período. Solo cuando el dev marca explícitamente `done` en ADO (que es post-merge + post-DoD), step-09 lo cierra.

## Multi-sesión en el mismo cwd

**Escenario:** dos (o más) sesiones corriendo en simultáneo sobre el mismo proyecto (mismo cwd), cada una con su tarea, ambas billables. Ejemplo: sesión A implementando una story con `tycon-pipeline`; sesión B cargando stories en ADO en paralelo.

**Desde 2026-05-17 esto funciona out-of-the-box.** No hay pattern manual, no hay "retroactive entry". Cada sesión abre y cierra su propio timer con el flujo normal de `start`/`stop`.

### Por qué funciona — dos hechos clave

1. **Cada sesión tiene su propio archivo `active/<sessionId>.json`.** Dos sesiones en `/Users/x/Ceibo` viven en `active/sess-A.json` y `active/sess-B.json`. No colisionan en keys NI en escrituras — `touch-activity` de cada sesión escribe solo su archivo. Cero contención, cero race.
2. **clocki NUNCA crea entries "running" en Clockify.** El flujo `start` crea la entry con `end = start` (entry *completa* de duración ~0) y la extiende vía `update-clockify-time-entry`. Una entry completa NO es un "running timer" — Clockify permite cuantas quieras coexistiendo. La vieja restricción "un solo timer running por usuario" **no aplica** al mecanismo de clocki. Dos sesiones extienden sus dos entries independientemente.

### Reglas para no romper multi-sesión

- ✅ Una sesión lee/escribe SOLO `active/<suSessionId>.json`. El `sessionId` viene en el reminder del hook (o `$CLAUDE_CODE_SESSION_ID`) — nunca lo inventes.
- ✅ `start` / `stop` operan SOLO sobre el archivo de tu sesión. El timer de la otra sesión queda intacto — está en otro archivo.
- ✅ El `sweep` puede cerrar timers de cualquier sesión, pero SOLO los que pasan el **gate de liveness**: `lastActivity` idle >15min **Y** heartbeat de la sesión idle >15min. Si el heartbeat está fresco, la sesión está viva → el sweep lo excluye y NO lo lista. El agente solo cierra lo que el reminder del sweep lista (= ya filtrado por el gate).
- ❌ NUNCA escribas `active/*.json` de OTRA sesión (excepto el `_nosession`/`_legacy` drainado por el sweep).
- ❌ NUNCA cierres un timer porque su `lastActivity` luzca idle, si NO vino listado por el sweep. El `lastActivity` idle por sí solo NO prueba sesión muerta (puede estar congelado por bug) — el gate de heartbeat es la prueba.

**Por qué el diseño es así:**
- **Colisión de keys**: keyear `active.json` solo por cwd da una sola slot por cwd, y el flujo `start` de una sesión cierra el timer de la otra. Por eso el keying es por `sessionId`.
- **Colisión de escrituras**: con un `active.json` único, dos `touch-activity` concurrentes hacen read-modify-write del mismo archivo y uno pierde su update — un timer desaparece. Por eso hay **un archivo por sesión** (`active/<sessionId>.json`) — no hay archivo compartido, no hay race.

## Cross-platform

Toda la lógica que el agente ejecuta es agnóstica (lectura/escritura de archivos + MCP tools). Los scripts Node.js (`sweep.js`, `on-prompt.js`, `touch-activity.js`) usan `os.homedir()`, `path.join()` y normalización de cwd para funcionar igual en Mac/Linux/Windows.

## Pre-requisito

El Clockify MCP server debe estar instalado (`bash integrations/clockify/scripts/install-mcp.sh` desde el arnés). Si no está, el skill falla con "Clockify MCP no instalado — ver guides/integrations/clockify-mcp.md".

## Anti-patterns (lo que NO hace)

- ❌ NO arranca timers sin confirmación del user (excepto cuando lo invoca `tycon-pipeline` con una story).
- ❌ NO cierra timers usando `now` como end-time si el timer estuvo idle — usa `lastActivity` para reflejar trabajo real.
- ❌ NO duplica timers (siempre cierra el previo de **tu sesión** antes de abrir uno nuevo en el mismo cwd).
- ❌ NO requiere config previa: la primera vez en un repo, auto-match resuelve. Si falla, pregunta.
- ❌ NO loguea API key ni datos sensibles en los archivos `active/*.json` ni en logs.
- ❌ NO escribe el archivo `active/*.json` de otra sesión — cada sesión solo toca el suyo. Ver sección **Multi-sesión en el mismo cwd**.
- ❌ NO cierra entries de otra sesión salvo que el `sweep` las liste como **huérfanas** (= `lastActivity` idle >`idleTimeoutMinutes` **Y** sin heartbeat hace >`deadSessionMinutes`, default 120, **Y** `sessionId` real — no `_legacy`/`_nosession`). Un `lastActivity` idle por sí solo NO basta: puede estar congelado por bug mientras la sesión trabaja (incidente 2026-05-17). Las pseudo-sesiones se listan aparte y requieren confirmación del humano (incidente 2026-06-05).
