# Workflow Orchestration — Guía TYCON

Esta guía define cómo el agente (bajo Claude Code o Codex) debe operar en los repos de TYCON (Pacara, Totora, Ebano). Consolida las reglas presentes en los distintos `CLAUDE.md` de cada proyecto para que exista un único punto de referencia.

Todo repo de TYCON debe cumplir esta guía. Si un `CLAUDE.md` específico se desvía, ese archivo debe explicar por qué.

---

## 1. Principios Fundamentales

Estos tres principios gobiernan toda decisión técnica. Si algo los viola, está mal — aunque "funcione".

### Simplicidad Primero

Cambios lo más simples posibles. Mínimo código afectado. Si hay dos formas de resolver un problema y ambas funcionan, elegir la que toca menos archivos y agrega menos conceptos. No es "rápido y sucio", es "elegante y directo": un método de 10 líneas que resuelve el problema es mejor que una abstracción de 3 clases que "podría reutilizarse".

### Causa raíz

Atacar causas raíz, no síntomas. Nada de arreglos temporales, `TODO: fix later`, o `try/catch` que traga errores. Si un test falla, entender por qué antes de tocar código. Si un bug aparece en producción, reproducirlo local antes de pushear el fix. Si algo no se entiende, leer el código — no inventar.

### Impacto Mínimo

Solo tocar lo necesario para completar la tarea pedida. No refactorizar código adyacente "de paso", no renombrar variables fuera de scope, no agregar features que nadie pidió. Si durante la tarea se descubre un problema fuera de scope, anotarlo en `tasks/lessons.md` o comentarlo al usuario — no resolverlo sin consenso.

---

## 2. Las 6 Reglas de Workflow

Estas son las reglas operativas que el agente sigue en toda sesión. Aparecen (casi) idénticas en los `CLAUDE.md` de todos los repos TYCON.

### 2.1 Planificar Primero

Para cualquier tarea no trivial (>3 pasos, múltiples archivos, o riesgo de regresión) el agente DEBE:

1. Escribir un plan en `tasks/todo.md` con items verificables
2. Presentarlo al usuario para aprobación
3. Recién entonces ejecutar

Si durante la ejecución algo sale mal o las asunciones del plan no se cumplen → **PARAR** y replanificar. Nunca improvisar sobre la marcha en tareas no triviales. Tareas triviales (fix de typo, edición de una línea, read-only) no requieren plan formal.

### 2.2 Subagentes para investigación ancha o trabajo independiente

Delegar en subagentes cuando el trabajo es ancho e independiente —buscar un patrón en todo el codebase o en varios repos, auditorías en paralelo— o cuando leerlo en el hilo principal lo llenaría de material que después no se usa (el subagente devuelve el resumen, no las 500 líneas que leyó). Unas pocas lecturas o búsquedas se hacen directo, en paralelo, sin subagente. Tope de concurrencia por la carga de la máquina: `test-execution-discipline.md`, regla 4.

**Regla:** una tarea por subagente, con el porqué y el formato de devolución en el pedido. No delegar "arreglá el bug" — delegar "buscá todos los lugares donde X es llamado y devolveme la lista".

### 2.3 Automejora Continua

Cuando el usuario corrige al agente (señala un error, pide que se rehaga algo, rechaza un approach), el agente debe: (1) entender por qué la primera aproximación estaba mal, (2) agregar la lección a `tasks/lessons.md`, (3) revisar `tasks/lessons.md` al inicio de cada sesión para no repetir errores.

Esto es **obligatorio**, no opcional. `tasks/lessons.md` es memoria institucional entre sesiones.

### 2.4 Verificar con tests antes de decir "listo"

Una tarea se da por completada cuando hay evidencia de que funciona:

- Tests del área tocada, con filtro (`dotnet test --filter`, `npx jest <patrón>`, `npx playwright test <spec>`). La suite completa corre en el portón del merge a `main`, cuando el dev la pide o al cierre del Step 4 del pipeline de stories, no en cada tarea — ver `test-execution-discipline.md`.
- En frontend: rebuild + verificar en navegador (DevHost, dev.html)
- Compartir el output real (comandos + resultados) en el Dev Agent Record

"Debería funcionar" o "los tests pasan" sin output no cuentan como evidencia. Si un test no se puede correr (ej: requiere infra externa), decirlo explícitamente.

### 2.5 Elegancia Equilibrada

Ante dos enfoques que resuelven lo mismo, gana el más simple: DRY + KISS, no sobreingeniería.

Señales de sobreingeniería: crear una abstracción porque "quizás la reutilicemos", agregar niveles de indirección sin caso de uso concreto, usar patrones de diseño sin necesidad (factory, strategy, observer sin razón).

**Regla práctica:** si el approach elegante requiere explicar más que el directo, el directo gana.

**Tres matices donde el agente suele errar**:
- **DRY es de conocimiento, no de líneas**: se unifica una regla de negocio, un formato o una constante con
  significado. Dos bloques parecidos que cambian por razones distintas quedan separados; fusionarlos con un parámetro
  booleano es sobreingeniería.
- **Abstraer recién con tres copias** en el repo, y sólo si la story lo pide o lo permite.
- **Que un dato inválido no se pueda construir**: validar en el borde y con tipos, no con chequeos repartidos; lo que
  llega de afuera falla con el error que el spec declara.

### 2.6 Corrección Autónoma de Errores

Ante errores de compilación, tests fallando, o bugs detectados, el agente DEBE: (1) diagnosticar la causa raíz, (2) aplicar el fix, (3) re-verificar (compilar + tests), (4) repetir hasta que todo esté verde.

**NO preguntar** "¿querés que arregle el error?" — arreglarlo. Solo pedir guía si el fix cambia el scope de la tarea original, hay múltiples approaches válidos que el usuario debe decidir, o el error revela un problema de diseño que requiere replanificación.

---

## 3. Estructura `tasks/`

Todo repo TYCON tiene una carpeta `tasks/` con dos archivos clave.

### `tasks/todo.md` — Plan de Sesión

Plan de la tarea actual. Se crea al inicio de cada tarea no trivial y se descarta/archiva al finalizar.

```markdown
# Tarea: <descripción breve>

## Plan
- [ ] Paso 1 verificable
- [ ] Paso 2 verificable

## Progreso
(se va marcando con [x] a medida que se completan pasos)

## Resultado
(resumen de cambios, archivos tocados, tests que pasan)
```

**Cuándo crearlo:** al inicio de cualquier tarea que requiera >3 pasos o toque >1 archivo significativo.
**Cuándo NO crearlo:** fixes triviales de una línea, read-only queries, respuestas a preguntas.

### `tasks/lessons.md` — Memoria Acumulada

Lecciones aprendidas que persisten **entre sesiones**. Cada entrada documenta un error cometido y cómo evitarlo.

```markdown
## YYYY-MM-DD: <título corto>
**Contexto:** qué estaba haciendo cuando surgió el error
**Error:** qué se hizo mal
**Corrección:** qué se aprendió, cómo evitarlo en el futuro
**Referencia:** archivo/story donde aplica
```

**Cuándo agregar una entrada:** cada vez que el usuario corrige al agente, o cuando el agente detecta un patrón de error propio.
**Cuándo leerlo:** al inicio de cada sesión, antes de empezar a trabajar. Buscar lecciones relevantes al área de la tarea actual.

---

## 4. Anti-patrones Prohibidos

Comportamientos que violan la guía. Si el agente cae en uno, debe reconocerlo, corregirse, y agregar una lección a `tasks/lessons.md`.

### Declarar "done" sin tests pasando

Decir "listo" sin haber corrido los tests. Variantes: "debería funcionar" sin verificar, "los tests pasan" sin mostrar el output, "compilé y está todo ok" mientras hay warnings/errores ignorados, marcar tasks `[x]` en la story sin Dev Agent Record completo.

**Correcto:** mostrar el comando ejecutado y el resultado literal (N/N PASS, 0 errores).

### Agregar features no pedidas

Implementar más de lo pedido "porque estaba a mano": refactorizar código adyacente, agregar logging/métricas sin que nadie lo pida, "mejorar" naming fuera de scope, crear abstracciones por si acaso.

**Correcto:** hacer exactamente lo pedido. Si se detecta una mejora posible, comentarla al usuario o anotarla — no implementarla.

### Ignorar lecciones previas

Repetir un error ya documentado en `tasks/lessons.md`: no leerlo al inicio de sesión, leerlo pero no aplicar las lecciones, tocar un patrón marcado como "NO hacer" sin justificar por qué esta vez es distinto.

**Correcto:** revisar lecciones relevantes antes de arrancar. Cuando una lección existente aplique a la tarea actual, citarla explícitamente.

### Inventar / asumir sin verificar

Responder con "probablemente...", "creo que...", o referenciar archivos/métodos sin confirmar que existen. Citar una línea sin leerla primero, asumir que un método existe porque "es estándar", o apoyarse en un dato leído antes en la conversación que pudo cambiar desde entonces (otro commit, otro proceso, la base).

**Correcto:** afirmar sobre lo que se leyó en el código o la base. Lo ya leído en esta sesión que no pudo cambiar desde entonces (no lo tocó otro commit, otro proceso, otra sesión sobre el mismo checkout ni la base; ante la duda, re-leer) se usa sin volver a consultarlo, salvo hallazgos o pendientes que vienen de un documento u otra sesión: esos se re-verifican contra el código de hoy antes de tocar. Si no se sabe, decirlo.

### Commit/push sin consentimiento

Ejecutar `git commit` o `git push` sin autorización explícita del usuario. Aplica incluso cuando todo está verde y el trabajo parece completo.

**Correcto:** preparar el commit (staging, mensaje), mostrarlo al usuario, esperar aprobación.

---

## 5. Checklist Rápido

Antes de decir "tarea completada", verificar:

- [ ] Plan en `tasks/todo.md` con items marcados `[x]`
- [ ] Tests relevantes ejecutados y pasando (output compartido)
- [ ] Si hubo corrección del usuario → lección en `tasks/lessons.md`
- [ ] Sin features fuera de scope
- [ ] Sin commit/push sin consentimiento
- [ ] Si la tarea era una story → Dev Agent Record completo (ver `story-format.md`, en la raíz del repo)
- [ ] Si la tarea implementó código → advisors Core corrieron (ver sección 6)

---

## 6. Integración BMAD + Advisors (TYCON)

Esta sección define **cuándo invocar subagentes advisor** en conjunto con los skills BMAD. Ver [`agent-architecture.md`](agent-architecture.md) para la explicación completa de qué son los advisors.

### Regla general

Después de invocar un skill BMAD que **implementa código** o **modifica artefactos críticos**, invocar los advisors Core correspondientes **antes de preparar el commit**.

### Skills BMAD que disparan advisors

| Skill BMAD | Advisor(s) a invocar después | Phase |
|---|---|---|
| `tycon-create-story` / `bmad-edit-prd` → genera/edita una story | `tycon-story-validator` | pre (antes de pasar a implementación) |
| `bmad-dev-story`, `bmad-quick-dev`, `bmad-agent-dev` → implementan código | `tycon-plugin-dotnet-conventions` + `tycon-plugin-tests-coverage` + `tycon-plugin-security-basics` en paralelo | during/post |
| Cualquier merge a `main` — salvo el push que trajo SÓLO tests/docs sin cerrar una story, que `retro-pending.js` exime por los ARCHIVOS del push (nunca por el mensaje) y CUENTA (`--report`); un merge de story la pide siempre, por repo. Desde 2026-09-16 la escribe un script, no un agente; el agente queda a pedido con «retro con modelo» | `scripts/metrics/retro-heartbeat.js` (latido: un segundo, sin modelo) · `tycon-retrospective-capturer` sólo a pedido | post-push (paso 10b) |

### Cómo invocar los advisors

Desde el main thread, usar la tool `Agent` con `subagent_type` = nombre del advisor:

```
Agent(subagent_type: "tycon-story-validator", prompt: "Validar story en <path>")
Agent(subagent_type: "tycon-plugin-dotnet-conventions", prompt: "Auditar diff en <repo>")
```

Cada pedido cierra con la instrucción de formato del bloque de estilo de respuesta (§«Lo que devuelve un SUBAGENTE»): resumen corto + acción, y la ruta del archivo de detalle sólo si el agente tiene `Write` — casi todos los advisors son read-only.

**Si hay varios advisors en la misma phase** (ej: los 3 plugin-* después de implementar), invocarlos **en paralelo** (un solo mensaje con múltiples tool calls).

### Shadow mode (histórico)

El shadow mode (advisors con el output a `.advisors/shadow-logs/` sin mostrarlo al dev) nunca entró en vigor: era parte de la governance formal que el equipo descartó (Camino B). Hoy los advisors corren activos y su output se muestra. Contexto: `agent-architecture.md`, nota del 2026-04-18.

### Reporte consolidado

Después de que corrieron los advisors de una phase, el agente consolida los outputs en UN solo reporte al usuario, con la forma del bloque de estilo de respuesta: primero qué encontraron y si algo bloquea (cuántos CRITICAL y WARNING, en palabras llanas), después la decisión que le toca al dev, y el detalle por advisor (items con `file:line` y el advisor que lo detectó) en un archivo del run dir del pipeline o del scratchpad de la sesión, citado por ruta. Lo que salió limpio no se enumera.

No mostrar al dev 3 reportes separados — siempre consolidar.

### HITL checkpoints

El pipeline tiene 3 puntos donde el humano aprueba explícitamente:

1. **Aprobar la story** (después de `tycon-create-story` + `tycon-story-validator`)
2. **Aprobar el plan de implementación** (después de `bmad-dev-story` en plan mode)
3. **Aprobar o pedir cambios** (después del reporte consolidado de advisors + `bmad-code-review`)

**El agente NUNCA commitea/pushea sin aprobación explícita en el paso 3**, aunque todos los advisors reporten OK. Ver [`git-commit-conventions.md`](git-commit-conventions.md).

### CRITICAL bloquea merge

Si el reporte consolidado tiene **severity CRITICAL**, el dev no puede hacer merge del PR a main hasta que:
- (a) el CRITICAL se resuelva (código cambia, advisor re-corre, ya no hay CRITICAL), o
- (b) el dev hace override explícito con comentario justificativo en el PR + aprobación de otro dev

El **commit local** no se bloquea — solo el merge. Los devs pueden trabajar y commitear libremente.

### Skip automático según tipo de proyecto

Los advisors Core skipean automático si no aplican al repo:

- `tycon-plugin-dotnet-conventions` → skipea si no hay archivos `.cs` en el diff
- `tycon-plugin-tests-coverage` → detecta framework (.csproj vs package.json) y corre el que aplique
- `tycon-plugin-security-basics` → siempre corre (secretos/inputs aplican a backend y frontend)

### Cuándo NO invocar advisors

- **Spikes / prototipos exploratorios**: si el usuario marca la tarea como spike, los advisors no aplican. Advisors son para código que va a producción.
- **Hotfixes P0 off-hours**: el dev puede saltear el pipeline completo con override explícito. El retrospective-capturer lo registra.
- **Tareas puramente no-código**: refactor de documentación, actualización de guías, cambios de config que no tocan lógica ejecutable.
- **Retrospectiva de un push sólo de tests/docs**: desde 2026-09-16 la decide el hook `retro-pending.js` y no el agente — exento si TODO lo que trajo el push vive bajo `tests/`/`__tests__/`, es `.md`, `.dashboard/` o `.engram/` y no cierra una story (nada bajo `.advisors/`, ningún `status:` que cambie); deja constancia en el ledger (`exento: 'solo-tests-docs'`) y el aviso de arranque cuenta exentos vs con retrospectiva. La regla 10b («una retro por repo en cada merge») no cambia: un merge de story la pide siempre — y esa retro es el latido de un segundo (`retro-heartbeat.js`), no un agente. Medido antes: 30 días, 346 de 1812 pushes eran de ese tipo y 82 de 119 retrospectivas no tenían story.

### Skill orchestrator `tycon-pipeline`

Para implementar una story se invoca el skill `tycon-pipeline`: encapsula BMAD → advisors → reporte consolidado → checkpoints HITL, y calcula él mismo qué advisors corren (`pipeline.js mech-check` + `pipeline.js advisors`). Para una story, esta sección describe lo que el skill orquesta y no se coordina a mano (§9.3). El código fuera de una story (p. ej. `bmad-quick-dev` en el carril ad-hoc) sigue la regla general: los revisores Core se invocan a mano antes del commit.

---

## 7. Skills orquestadores — regla anti-skip por inferencia

Esta regla aplica a **todos los skills orquestadores TYCON**: `tycon-pipeline`, `tycon-merge-to-main`, `check-story-drift`, futuros. Cubre la diferencia entre "skipear porque la skip-condition documentada se cumple" vs "skipear porque el agente cree que el step no aplica".

### Regla 7.1 — NO skipear steps declarados por inferencia desde contexto conversacional

Cuando un skill orquestador declara una secuencia de steps (`step-00`, `step-00b`, `step-01`, ...), **ningún step se saltea por inferencia del agente**. Solo se saltea si la **skip-condition documentada DENTRO del step** se cumple.

**Ejemplos de skip legítimo** (lo que SÍ se acepta):
- Step de inicio del registro de horas dice "saltear si el MCP de la herramienta de horas no está disponible" → verificás que el MCP no responde → skip OK.
- Step `ado-mark-active` dice "saltear si el frontmatter no tiene `ado_work_item:`" → leíste el frontmatter y no está → skip OK.
- Step `build-gate` dice "saltear si no hay archivos `.cs`/`.ts` modificados" → verificás el diff y no hay → skip OK.

**Ejemplos de skip por inferencia** (lo que NO se acepta):
- "El hook UserPromptSubmit firó 3 veces sin engagement del user, ergo el user no quiere el step" → ❌ el hook es un canal distinto del orquestador. Inferir intent del user desde el canal hook es bug.
- "El user dijo 'arrancá rápido', ergo saltea checkpoints HITL" → ❌ "arrancá rápido" no es override de los checkpoints declarados.
- "El user no mencionó X step explícitamente, ergo asumo que no lo quiere" → ❌ silencio del user no es opt-out. El orquestador ejecuta lo declarado.

### Regla 7.2 — Si dudás, ejecutá el step; el usuario puede vetar

Si la skip-condition documentada no es claramente aplicable, **default: ejecutar el step**. El usuario puede vetar en tiempo real con un mensaje explícito ("paráme acá", "skipeá el registro de horas"). Inferir el veto desde silencio es asimétrico contra el contrato del orquestador.

### Regla 7.3 — Si la skip-condition documentada tiene un gap, el fix es al spec, no a la ejecución

Si en una corrida descubrís que la skip-condition documentada de un step tiene un gap (ej: "saltear si frontmatter no tiene `ado_work_item:`" pero el WI existe en ADO con título matcheable), el fix NO es saltear igual y arrancar el pipeline. El fix es:

1. Detectar el gap y reportarlo al user.
2. Proponer un fix al spec del step (búsqueda fallback, query alternativa, etc.).
3. Aplicar el fix sistémico AL SPEC primero.
4. Re-ejecutar el step con el spec corregido.

Esto preserva la propiedad de que **el spec declarado ES la fuente de verdad** del comportamiento del orquestador. Si la ejecución diverge del spec sin actualizar el spec, perdés la propiedad de reproducibilidad.

### Por qué

El patrón que estas reglas cierran, con `tycon-pipeline`:

1. El hook UserPromptSubmit del registro de horas dispara 3+ veces en la conversación.
2. El user no menciona el registro de horas explícitamente.
3. El agente **infiere** que el user no lo quiere y **anuncia** "skip registro de horas" antes de invocar el skill.
4. Pero el skill `tycon-pipeline` declara `Step 0b — Arranque: aviso de trabajo` con skip-condition "saltear si MCP no está disponible", y el MCP está disponible.
5. El agente salta Step 0b por inferencia conversacional, contradiciendo la spec.
6. Mismo patrón con Step 0c (ADO mark-active): el frontmatter de la story no tiene `ado_work_item:`, el agente skipea silencioso — pero el WI **existe** en ADO con título matcheable. La skip-condition documentada (falta del campo) es correcta literal pero tiene un gap (no consulta ADO directamente).

Aplicación de las reglas:

- 7.1 → no skipear Step 0b. Ejecutarlo como declarado.
- 7.2 → en caso de duda, ejecutar.
- 7.3 → reportar el gap del Step 0c (frontmatter incompleto) + proponer fix sistémico al spec (búsqueda fallback por título) + ejecutar el step corregido.

---

## 8. Transiciones de campos contractuales de stories — SOLO via orchestrator

Por qué: si el dev (Claude) edita manualmente `status: review → done` en el frontmatter de la story Mary+GOLD, salteando el orchestrator `tycon-pipeline close N.M`, la entrada de horas queda en 0 segundos, el ADO WI nunca se cierra, y la transición no queda trazable.

### Regla 8.1 — Campos contractuales NO se editan manualmente

Los siguientes campos del frontmatter de `specs/stories/N-M-*.md` son **contractuales** — su transición tiene side-effects en el registro de horas + ADO + engram + advisors. NO se editan con `Edit` ni `Write`:

| Campo | Side-effects que coordina el orchestrator | Skill que lo maneja |
|---|---|---|
| `status:` (`ready-for-dev` → `in-progress` → `review` → `done`) | inicio/cierre del registro de horas + ADO WI state transition + engram session summary + advisors re-run | `/tycon-pipeline implement` / `/tycon-pipeline close N.M` |
| `sprint:` y `signed_for_sprint:` | scope firmado del cliente, CR registry | `change-requests/cr-NNN-*.md` + commit firmado |
| `pipelines.*.status:` (transiciones de pipelines declaradas en frontmatter) | Cross-check con tests/code presentes | `/tycon-pipeline close N.M` (coordina con advisors) |
| `ado_work_item:` (vínculo a ADO WI) | Audit trail bidireccional ADO ↔ spec | step-00c de `tycon-pipeline` |

### Regla 8.2 — Enforcement mecánico (hook PreToolUse)

Cada repo de specs (`CeiboProject`, `Totora/specs`, `FRESNO/specs`, etc.) DEBE tener un hook `PreToolUse` en `.claude/settings.json` que bloquee `Edit`/`Write` sobre `specs/stories/*.md` si el cambio toca un campo contractual.

Snippet copy-pasteable (incluido en `dotnet-hooks.md` para .NET proyectos + adaptable para frontend):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "input=$(cat); file=$(echo \"$input\" | jq -r '.tool_input.file_path // .tool_input.path // empty'); case \"$file\" in */specs/stories/*.md|*/stories/*.md) old=$(echo \"$input\" | jq -r '.tool_input.old_string // empty'); new=$(echo \"$input\" | jq -r '.tool_input.new_string // empty'); old_status=$(echo \"$old\" | grep -E '^status:' | head -1); new_status=$(echo \"$new\" | grep -E '^status:' | head -1); if [ -n \"$old_status\" ] && [ -n \"$new_status\" ] && [ \"$old_status\" != \"$new_status\" ]; then echo 'BLOCKED: edit manual de status: en story Mary+GOLD. Las transiciones DEBEN ir via /tycon-pipeline close N.M (orchestrator).' >&2; exit 2; fi ;; esac; exit 0"
          }
        ]
      }
    ]
  }
}
```

### Regla 8.3 — Si el orchestrator NO cubre tu caso, extendé el orchestrator

Si tu caso de edición legítima de un campo contractual NO está cubierto por ningún skill orchestrator, el fix es **extender el orchestrator** (issue + PR al repo `AgentSkills`), NO bypassear con edit manual.

Ejemplos de extensiones futuras válidas:

- `/tycon-pipeline reopen <N.M>` — revertir `done → review` cuando un fix post-merge requiere re-trabajo.
- `/tycon-pipeline reassign-sprint <N.M> --from <X> --to <Y>` — coordina con CR registry.

### Anti-pattern documentado

Edit manual de `status: review → done` → registro de horas en 0s + ADO WI sin cerrar + transición no trazable. Fix mecánico aplicado: hook `PreToolUse` bloqueante (sección 8.2) + banner en `tycon-pipeline` SKILL.md anti-pattern + esta sección.

---

## Sección 9 — Marker file + hooks (post-2026-05-15)

### Regla 9.1 — Cada invocación de orchestrator escribe un marker file

El skill `tycon-pipeline` mantiene un marker file en `~/.claude/.tycon-pipeline/active.json` durante toda la vida del pipeline. Schema:

```json
{
  "storyId": "1.7.1",
  "storyPath": "/abs/path/to/spec.md",
  "repoPath": "/abs/path/to/repo",
  "sprint": 3,
  "startedAt": "ISO",
  "lastTouch": "ISO",
  "stepsCompleted": [0, 1, 2, 3, 4],
  "stepsPending": [5, 6, 7, 8],
  "filesTouched": ["/abs/path/file1", "/abs/path/file2"]
}
```

Lifecycle:
- **Step 0 (preflight, PIPE-C4)** setea el marker.
- **Cada `complete-step <N>`** actualiza `stepsCompleted` y `stepsPending`.
- **Cada Edit/Write** appende `file_path` a `filesTouched` (via hook `on-edit.js`).
- **Step 8 (commit-prep)** o **Step 9 (ado-closure)** limpian el marker.

Utility: `node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js <cmd> [arg]`.

### Regla 9.2 — Hooks que consultan el marker

Cuatro hooks operan sobre el marker (todos en `~/.claude/agent-skills/skills/tycon-pipeline/scripts/`):

| Hook | Trigger | Comportamiento |
|---|---|---|
| `on-prompt.js` | UserPromptSubmit | INTENT-detect: prompt matchea "implementemos la story N.M" sin marker propio → reminder "USE Skill(tycon-pipeline)". **CROSS-SESSION-CONFLICT (2026-05-20)**: si la story tiene marker en OTRA sesión activa, reminder distinto "Story N.M YA tiene pipeline en sessionId X, retomá NO arranques fresh". STOP-detect: prompt matchea "listo/done/cerrá" con marker + steps pending → reminder bloqueante "NO declarar done sin advisors". |
| `on-edit.js` | PostToolUse Edit\|Write | Si hay marker: auto-append `file_path` a `filesTouched`. Si no hay marker pero el archivo está en `files_to_*` de alguna story Mary+GOLD: reminder "estás editando sin pipeline activo". |
| **`on-write-collision.js` (2026-05-20)** | PreToolUse Edit\|Write | HIGH collision: `file_path` está en `filesTouched` de OTRA sesión activa → reminder fuerte "vas a sobreescribir trabajo no commiteado". LOW collision: archivo ya existe + hay otra sesión activa → reminder suave. Defense-in-depth sobre `on-prompt.js` cross-session detect. |
| `marker.js` | No es hook, utility CLI | set / get / touch / complete-step / append-file / clear / is-active / **list-all / find-by-story / clear-session / update-story-status** (2026-05-20). |

Wireados en `~/.claude/settings.json` bajo `UserPromptSubmit`, `PostToolUse`, y `PreToolUse` matchers.

### Regla 9.3 — Por qué el marker

El user pide "implementemos la `<N.M>`" y el orchestrator (Claude) **va paso a paso manual** en lugar de invocar `Skill(skill="tycon-pipeline")`. Resultado:
- Step 0 preflight skipped.
- Step 1 validate-story corre a mano.
- Steps 2-4 (BMAD plan + approve + execute) reemplazados por edición directa.
- **Step 5 advisors NO se corren**, y nadie lo nota hasta el cierre.

Causa raíz: el skill activa solo con invocación explícita; si el agente no la reconoce, todo el flujo se salta. Sin un mecanismo persistente, nada dice "estás mid-impl de una story". Solución implementada: marker + hooks (Reglas 9.1, 9.2).

### Regla 9.3b — Por qué el discovery cross-session

La sesión A implementa una task de backend de una story, con build verde y spec drift documentado en la story. El usuario abre la sesión B sin contexto y pide "implementemos la story `<N.M>`". La sesión B invoca `marker.js get` → devuelve `{}` (marker per-session-id introducido 2026-05-17 como fix anti-race-condition multi-sesión).

**Sin discovery cross-sesión, la sesión B va a**:
- Re-ejecutar Step 0-3 desde cero.
- Re-correr Step 1 validator + Step 2 BMAD plan (Amelia).
- Re-preguntar al user las decisiones ya tomadas.
- Re-implementar archivos ya creados en la sesión A → colisión Write sobre archivos no commiteados.
- Re-escribir código con el spec drift no detectado (columnas asumidas que no existen en el schema real).
- Abrir 2do timer de horas encima del 1ro → doble cobro.

**Solución implementada (Reglas 9.4 - 9.6)**:

### Regla 9.4 — `marker.js list-all` + `find-by-story` para cross-session discovery (2026-05-20)

```bash
node marker.js list-all                       # JSON array con TODOS los markers activos (no-stale, <24h)
node marker.js find-by-story <N.M>            # JSON array con markers que tengan storyId==<N.M>
node marker.js clear-session <sessionId>      # Borra marker de OTRA sesión (recovery/admin); sin marker, lo dice y sale 1
node marker.js adhoc clear-orphan <sessionId> # Borra el ad-hoc de OTRA sesión: sólo si no está viva y lleva >24 h sin tocarse
node marker.js update-story-status <path> <s> # Muta frontmatter status: atómicamente
```

Estos comandos son llamados por:
- **PIPE-C0 del Step 0 preflight** (primer check del pipeline) — antes de setear su propio marker.
- **`on-prompt.js`** CROSS-SESSION-CONFLICT mode — al detectar intent.
- **`on-write-collision.js`** — al chequear Write/Edit collisions.

### Regla 9.5 — `status:` frontmatter como source of truth durable (2026-05-20)

El marker per-session-id es efímero (no sobrevive a reboot ni a `marker.js clear`). El **`status:` del frontmatter de la story SÍ es durable** (en git, la source of truth).

Lifecycle del `status:` orquestado por el pipeline:

| Transición | Step | Cómo |
|---|---|---|
| `ready-for-dev` → `in-progress` | Step 0 PIPE-C5 | `marker.js update-story-status <path> "in-progress"` |
| `in-progress` → `review` | Step 8 commit-prep | `marker.js update-story-status <path> "review"` |
| `review` → `done` | Step 9 ado-closure | `marker.js update-story-status <path> "done"` |

Si una sesión muere sin completar Step 8/9 → próxima sesión que abra `tycon-pipeline` lee `status: in-progress` y trata como "pipeline abandonado": ofrece (a) retomar / (b) reset a `ready-for-dev`.

### Regla 9.6 — PreToolUse hook `on-write-collision.js` como defense-in-depth (2026-05-20)

Si el user ignoró el reminder de `on-prompt.js` CROSS-SESSION-CONFLICT y arrancó igual, este hook lo atrapa al primer `Write`/`Edit`:

- **HIGH collision** — el `file_path` está en `filesTouched` de OTRA sesión: reminder bloqueante (advisory, no exit 2 — el agente decide).
- **LOW collision** — archivo ya existe + otra sesión activa, pero no en su filesTouched: warning suave (podría ser race window).

Wireado en `~/.claude/settings.json`:
```json
"PreToolUse": [
  ...
  {
    "matcher": "Write|Edit",
    "hooks": [{
      "type": "command",
      "command": "node \"/Users/<usuario>/.claude/agent-skills/skills/tycon-pipeline/scripts/on-write-collision.js\""
    }]
  }
]
```

### Regla 9.7 — Override / excepciones permitidas

Hotfix < 50 LOC, refactor independiente, cleanup ad-hoc → ignorar el reminder es válido. Los reminders son advisory (exit 0), no bloqueantes. Lo bloqueante es la sub-regla D.i del skill (no cherry-pick advisors en re-loop), no los hooks.

Si el caso es legítimamente atípico (ej. dev quiere correr el pipeline pero sin marker porque está debugging algo), invocar:
```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js clear
```
y documentar el motivo en `tasks/lessons.md` del repo.

**Paralelo intencional cross-sesión** (caso muy raro, ej: branches Git distintas trabajando la misma story): setear el marker en la 2da sesión con `notes='paralelo intencional con sessionId X'`. PIPE-C0 detecta esa nota y NO bloquea.

---

## Sección 10 — Deferrals con ticket future obligatorio (post-2026-05-15)

### Regla 10.1 — Ninguna story declara `deferred-to-future` sin crear el ticket future en el mismo PR

Si una story Mary+GOLD declara que algún AC, comportamiento o pieza de scope se difiere a "una story futura", "V2", "cuando exista routing", "cuando aparezca el caller", etc., **debe crear la story future ANTES de mergear el PR donde se declara el deferral**. Mismo PR, mismo commit batch — no "lo creamos después".

**Validación mecánica** — un deferral es válido si:

1. El comentario / sección que lo declara identifica la story futura por número: `Story <N.M>`. NO acepta texto vago tipo "V2", "futuro sprint", "cuando exista X".
2. El archivo `specs/stories/{N-M-titulo}.md` referenciado EXISTE en el filesystem como parte del mismo PR (status mínimo `ready-for-dev`).
3. El `tasks/todo.md` tiene una entry trazada con tag `[DEF-{N.M}-{slug}]` que linkea ambos lados.

Si alguno falta → el PR NO se mergea hasta que se cierre el loop.

### Regla 10.2 — Cross-story deferral audit pre-sprint

Antes de cerrar el sprint plan (o antes de arrancar el sprint si es retroactivo), ejecutar un **deferral audit** sobre `specs/stories/*.md` (medido: ~30 min). Mecánica:

```bash
# 1. Grep frases canónicas de deferral
grep -rn -E "(V2|V1\.[0-9]|future story|story futura|cuando exista|deferred to|diferid[oa] a)" specs/stories/

# 2. Para cada hit, verificar que apunta a una story numerada existente
# 3. Output: lista de deferrals con (origen, target, target-existe? yes/no)
```

El audit puede correr como advisor TYCON (`tycon-deferral-tracker` ya cubre parte del scope — agregar la regla 10.1 a su catálogo). El advisor falla CRITICAL si:
- Encuentra deferral sin target numerado.
- Target numerado pero el archivo `specs/stories/{target}.md` no existe.
- Target existe pero su frontmatter `status` está como `unplanned` indefinido.

### Regla 10.3 — Por qué

**3 stories distintas** pueden declarar cada una "se resuelve cuando exista routing" o equivalente:

- Una, en un comentario: "V2 (cuando exista routing): este componente se reemplaza por React Router".
- Otra, en una task: "P2 sigue usando ListadoEditor mode=edit (route real V2 cuando exista router)".
- La tercera hereda el componente provisorio.

**Ninguna crea la story V2.** El sprint plan firma las 3 features asumiendo que se conectarían solas, y la integración nunca queda planificada explícitamente. Medido: el gap apareció **6 semanas después**, y hubo que crear retroactivamente la story que las integra.

### Regla 10.4 — Excepción única — deferral a sprint future explícito

Aceptable: `deferred-to: Sprint 5` SIN número de story específica, SOLO si:

1. El sprint future ya existe en `sprint-plan.md` con asignación de capacity.
2. El deferral se agrega al `sprint-plan.md` de ese sprint como "pull-in pending" con story name draft.
3. Hay fecha límite para crear la story formal (`create-story-by: 2026-MM-DD`).

Esto cubre el caso "sé que esto va a Sprint 5 pero todavía no diseñé la story" — válido para planning, no para evadir la regla 10.1.

---

## Sección 11 — Validación de layout/navegación contra el artefacto de IA (post-2026-05-15)

### Regla 11.1 — Toda story de UI valida su layout contra el artefacto de IA antes de `done`

Si una story crea o modifica **layout, navegación o estructura de pantalla** (componentes tipo `*Layout`, `*Nav`, `Sidebar*`, routing, drawers, paneles), antes de transicionar a `done` debe verificar que su implementación es **consistente con el artefacto de IA del proyecto** — el `navigation-map.md` (si existe) y/o la sección de layout/navegación del UX spec.

**Si la implementación diverge intencionalmente** del artefacto de IA (el dev tomó una decisión de diseño mejor durante la implementación): la divergencia se **ratifica en el artefacto fuente en el MISMO PR** — no en uno futuro, no "después". El artefacto de IA y el código nunca quedan en desacuerdo silencioso.

Puede correr como check del advisor `tycon-feature-wiring-checker` o `tycon-story-validator` post-implementation.

### Regla 11.2 — Por qué

Una story puede implementar un layout con un modelo (un panel lateral superpuesto + sidebar de drawer-tools) **distinto del catálogo de pantallas aprobado por el cliente** (lista de pendientes = pantalla propia). La divergencia puede ser una decisión de implementación razonable, pero si **nunca vuelve al artefacto fuente**, las stories siguientes se construyen encima. Medido: 6 semanas y 3 stories después, un pipeline chocó contra el drift y hubo que crear una story para reconciliar. Sin la Regla 11, el drift se descubre cuando ya hay N stories construidas encima.

---

## Sección 12 — Reconciliación de artefactos de planning (post-2026-05-15)

### Regla 12.1 — Artefacto de planning nuevo declara `supersedes:` / `reconciles:`

Todo artefacto de planning nuevo o reescrito (UX spec, mapa de IA, architecture doc, PRD) que toque un dominio ya cubierto por un artefacto **aprobado** previo, DEBE declarar en su frontmatter:

```yaml
reconciles:
  - "<path artefacto previo> (<estado: aprobado-cliente / interno>)"
supersedes_in:        # opcional — qué secciones reemplaza
  - "<artefacto> §<sección>"
```

Y resolver **explícitamente** cada divergencia con el artefacto previo (sección "Reconciliación" o equivalente). **Sin ese bloque, el artefacto no pasa de `draft`.**

### Regla 12.2 — Por qué

Un UX spec nuevo puede escribirse **ignorando** el catálogo de pantallas APROBADO POR EL CLIENTE: define un modelo de navegación distinto (lista de pendientes como panel permanente vs como pantalla propia) sin declararlo, sin reconciliarlo, sin re-aprobación. La cadena de drift tiene tres eslabones: catálogo aprobado → UX spec nuevo (lo ignora) → una story (implementa un tercero). Si ningún artefacto referencia al anterior, el drift es invisible hasta que un pipeline choca contra él.

La Regla 11 atrapa el drift implementación↔spec. La Regla 12 atrapa el drift spec-nuevo↔spec-aprobado-previo — el eslabón que la Regla 11 no cubre.

### Regla 12.3 — Cambio de modelo en artefacto nuevo que toca scope firmado

Si el artefacto nuevo cambia un modelo (navegación, layout, flujo) que estaba en un artefacto **firmado por el cliente**, ese cambio requiere CR registrado (ver `signed-scope-guardrails.md`). Redefinir en un spec interno algo que el cliente firmó, sin CR, es cambio de scope firmado no autorizado — aunque "solo sea un documento".


## §13 — Alta de pipeline de CI en repo nuevo: el `trigger.paths.include` se revisa contra el repo ENTERO

**Medido: 3 veces en 4 meses, en 3 repos distintos**, el mismo bug con el mismo final: un
`azure-pipelines.yml` nuevo con `paths.include` que cubre `*/src/**` y poco más, y un commit
legítimo que se mergea a `main` **sin que corra un solo pipeline** — sin error, sin aviso, porque
un trigger que no matchea no falla: no existe. Un commit que arregla un bug real de
`shared/` entra sin CI; se verifica con `az pipelines runs show` (el commit no aparece en NINGÚN
run). Y cada vez se redescubre desde cero.

**Checklist al crear o clonar un `azure-pipelines.yml`** — cotejar `trigger.paths.include` contra
`git ls-tree -d HEAD` (las carpetas REALES del repo), con los sospechosos ya vistos tres veces:

- [ ] Carpetas de **código compartido** entre apps del monorepo (`shared/`, `common/`, `lib/`).
- [ ] **El propio `azure-pipelines.yml`** (si no, el yml no se dispara a sí mismo).
- [ ] Scripts de build auxiliares (`build-*.js`, `scripts/`).
- [ ] Tests que corren en un stage separado (integración, E2E).
- [ ] Configs del arnés que afectan el build (`.tycon/`).

No es un advisor a propósito: 3 casos en 4 meses no justifican el costo de falsos positivos sobre
YAMLs legítimamente distintos entre repos.
