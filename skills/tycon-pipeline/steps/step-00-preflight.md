# Arranque

**Objetivo**: verificaciones críticas ANTES de arrancar el pipeline. Si alguna falla, pausa para decisión del usuario.

Este step corre **antes** del Step 1 (validate-story). Guards de seguridad del workflow, no del código.

## Forma canónica (2026-06-09)

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js start --story <spec> --repo <dir> --brief [--autonomous]
```

Un solo comando ejecuta PIPE-C0/C1/C2/C4/C5 mecánicamente y pausa SOLO ante conflicto cross-session, rama protegida o pipeline abandonado (sin mutar nada en esos casos — la decisión sigue siendo del usuario). Los checks descriptos abajo quedan como **referencia/fallback** si el script no está disponible o falla.

## Checks

### PIPE-C0 — Cross-session conflict check (fix robusto 2026-05-20)

**Obligatorio, primer check.** ANTES de cualquier otro check, verificar si la story ya tiene pipeline activo en OTRA sesión.

```bash
# Extraer storyId del frontmatter del spec.
STORY_ID=$(grep -m1 '^story:' "$STORY_PATH" | sed 's/story: *//' | tr -d '"' | tr -d ' ')

# Buscar pipelines activos para esa storyId en cualquier sesión (no-stale, <24h).
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js find-by-story "$STORY_ID"
```

**Si devuelve `[]` (sin match en otras sesiones)**: OK, continuar a PIPE-C1.

**Si devuelve un array con markers de OTRA sessionId** (no la actual): PAUSAR con alerta:

```
🛑 ALERTA — Story X.Y.Z YA tiene pipeline activo en otra sesión

Detectados N markers activos en sesiones distintas a la actual:
  • sessionId=abc12345… started=<date> lastTouch=<date>
    repoPath=<path>
    hechos: Arranque, Validar la story, Armar el plan, Aprobar el plan · pendientes: Implementar y correr las pruebas, … · filesTouched=N

NO arrancar la corrida desde cero («Arranque») — vas a:
  • Re-ejecutar pasos ya hechos («Validar la story», «Armar el plan»).
  • Re-preguntar decisiones ya tomadas al user.
  • Re-implementar archivos ya creados → colisión Write.
  • Abrir 2do timer Clockify encima del 1ro (doble cobro).

Opciones:
(a) RETOMAR pipeline de la otra sesión (recomendado si sesión sigue viva):
    1. mem_search project="<proyecto>" query="Story X.Y.Z session_summary"
    2. git status en repo/s — ver archivos pending sin commit.
    3. Adoptar el marker de la otra sesión (copia COMPLETA sin pérdida:
       filesTouched, iterations, checks, dodRuntimeChecked):
       marker.js adopt-session <sessionId>
    4. Arrancar desde el primer paso pendiente (NO desde «Arranque»).

(b) Si la otra sesión está MUERTA (la sesión crasheó / el dev cerró):
    node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js clear-session <sessionId>
    después arrancar de nuevo desde «Arranque».

(c) Si querés DOS sesiones en paralelo sobre la misma story (raro — implica
    branches Git distintas):
    documentar intencionalidad en engram + setear marker con
    notes='paralelo intencional con <sessionId>'.

¿Cómo procedemos?
```

**Respuestas del usuario**:
- **Retomar** → cargar engram summary + `marker.js adopt-session <sessionId>` + ir al primer step pending.
- **Clear-session** → ejecutar `marker.js clear-session <sid>` + continuar Step 0 fresh.
- **Paralelo intencional** → seteo marker con `notes` y continúo normal.
- **Cancelar** → terminar pipeline.

**Por qué**: el marker es por sesión (diseño anti-race multi-sesión), así que una sesión B abierta sin contexto sobre una story que la sesión A dejó a medias recibe `{}` de `marker.js get`. Sin PIPE-C0, la sesión B re-ejecuta los Steps 0-3 y las primeras tasks → colisión con files no commiteados + pérdida del spec drift documentado + doble timer Clockify. PIPE-C0 atrapa este caso ANTES de tocar archivos.

**Stories DISTINTAS en paralelo, mismo repo (2026-08-03)**: PIPE-C0 NO las detecta (matchea
por storyId) y el working tree compartido las contamina cruzado: un solo HEAD/branch, el
`git diff HEAD` repo-wide arma mal el set de advisors y el coverage de ambas, y
`.advisors/tests-result.json` es único por repo (la 2da corrida lo pisa). Regla team: **un
worktree por story** — chequear con `marker.js list-all` si hay otro pipeline activo sobre
este `repoPath`; si lo hay, crear el worktree (`~/.claude/tycon-harness/scripts/tools/tycon-worktree.sh
new <slug>`) y correr este pipeline DESDE ahí. Las reglas de recursos suman por MÁQUINA, no
por worktree: full suite en uno a la vez y el 2do pipeline con `TYCON_5B_EARLY=0` (step-04
§Riesgo multi-sesión). Detalle: `~/.claude/tycon-harness/guides/git-worktrees.md`.

### PIPE-C1 — Branch guard: ¿estamos en main?

**Obligatorio**. Chequear rama actual del repo de destino:

```bash
cd <repo_path>
git rev-parse --abbrev-ref HEAD
```

**Si la rama es `main`, `master`, `production`, `prod`, o `release` (cualquier variant de prod)**: PAUSAR el pipeline con alerta crítica:

```
🚨 ALERTA — Rama protegida detectada

Estás por implementar sobre `{branch}` directamente.

Esto es peligroso:
- Commits directos a `main` saltean review
- No hay forma de revertir sin history rewrite
- Otros devs pueden estar esperando mergear features

Opciones:
(a) Crear branch feature nueva AHORA: `git checkout -b feat/{story-id}-{slug}`
(b) Continuar de todos modos (NO recomendado — requiere confirmación explícita)
(c) Cancelar el pipeline

¿Cómo procedemos?
```

**Respuestas del usuario**:
- **Crear branch** → correr `git checkout -b` y continuar
- **Continuar de todos modos** → requiere que el usuario escriba explícitamente "continuar en main" (no solo "sí"). Registrar en el log del pipeline con flag `had_main_override: true` y dejar advertencia en el commit prep del Step 8.
- **Cancelar** → terminar pipeline

**Si la rama es feature/dev/bugfix/etc**: OK, continuar sin pausar.

**La historia de primera vez** (escrita por el modo primera vez de `tycon-create-story`: marca `origin: first-time` Y
la constancia que deja su guion en la carpeta de estado) no pausa: `pipeline.js start` hace `git init` si no hay git,
crea `story/<número>` en `main`/`master` y lo dice en `actions_done`. Si esa rama ya existe, pausa nombrándola. La
marca sola (escrita a mano) no alcanza: en un checkout que comparten varias sesiones, cambiar de rama solo rompe el
trabajo de la otra.

### PIPE-C2 — `.gitignore`: lo efímero no viaja, la evidencia de cierre SÍ

Lo hace `pipeline.js start` solo, preguntándole a GIT (`check-ignore`, no al texto), y en DOS repos si
la story vive en otro que el código: el de trabajo y el de la story. El bloque
canónico (`GITIGNORE_ADVISORS` en `pipeline.js`, copiado del `.gitignore` del arnés):

```gitignore
**/.advisors/*
!**/.advisors/dod-runtime/
!**/.advisors/pipeline-runs/
**/.advisors/pipeline-runs/*
!**/.advisors/pipeline-runs/*/
**/.advisors/pipeline-runs/*/*
!**/.advisors/pipeline-runs/*/review-roster.json
!**/.advisors/pipeline-runs/*/findings.json
!**/.advisors/pipeline-runs/*/approvals.jsonl
.dashboard/
```

- **Repo sin decisión** (git no ignora lo efímero): se agrega el bloque entero, sin preguntar, y se
  informa. 🔴 NUNCA `.advisors/` a secas: esa línea anula toda negación y la evidencia deja de viajar.
- **Repo que ya decidió pero se traga lo que tiene que viajar** (`.advisors/` a secas, o sin la
  re-inclusión del registro de revisores): NO se toca — se AVISA nombrando qué no viaja (evidencia de
  cierre y/o `review-roster.json` + `findings.json` + `approvals.jsonl`), y decide una persona. Un repo así deja rojo al
  portón de CI al cerrar una story.
- **Repo con el bloque de antes del registro de aprobaciones** (viaja el registro de revisores pero no
  `approvals.jsonl`, el registro de aprobaciones): se agrega SÓLO la línea
  `!**/.advisors/pipeline-runs/*/approvals.jsonl`, sin preguntar, y se informa. Es aditivo —no cambia lo que el repo
  decidió ignorar— y corre antes de toda aprobación, así que el registro viaja en el mismo commit. Sin esa línea el
  portón de CI frena la story (`sin-registro-de-aprobaciones`).
- **No se pudo preguntar** (no es repo git): no se toca nada y queda constancia. «No pude mirar» y
  «miré y falta» no se escriben igual.

### PIPE-C3 — Working tree limpio (opcional, solo si el usuario lo pide)

Este check NO se corre por default. Solo si el usuario invoca con flag `--strict-working-tree`:

```bash
git status --porcelain
```

Si hay cambios sin commitear:
- Advertencia al usuario: "Hay cambios sin commitear en el repo. El pipeline va a mezclar estos cambios con los cambios de la story. ¿Querés commitear/stashear primero?"
- Respuesta positiva del usuario → continuar
- Respuesta negativa → cancelar

Por default este check está desactivado porque muchos devs trabajan con cambios in-flight legítimos.

## Severity y bloqueo

- **PIPE-C0** (cross-session conflict) — CRITICAL. Bloquea pipeline hasta decisión explícita.
- **PIPE-C1** (branch main) — CRITICAL. Bloquea pipeline hasta decisión explícita.
- **PIPE-C2** (gitignore) — se arregla solo, no bloquea.
- **PIPE-C3** (working tree) — WARNING opcional.
- **PIPE-C4** (marker set) — WARNING si falla, no bloquea.
- **PIPE-C5** (status frontmatter) — WARNING si falla, no bloquea. CRITICAL si detecta `in-progress` sin marker activo (pipeline abandonado → decisión explícita).
- **PIPE-C6** (modo autónomo) — **DEFAULT ON** (opt-out `--no-autonomous` / `TYCON_PIPELINE_NO_AUTONOMOUS=1`). WARNING si falla, no bloquea (cae a HITL normal). Ver la sección PIPE-C6 más abajo.
- **PIPE-C8** (model-hint + effort-hint) — ADVISORY puro. Sugiere `/model` (modelo y/o reasoning effort) si la config de la sesión no matchea la complejidad de la story; el user decide, nunca bloquea.
- **PIPE-C9** (tooling esperado) — WARNING con aviso obligatorio al user si una herramienta esperada (codegraph/engram) no está disponible; para `workflow-tool` (Step 5b) pregunta antes de seguir. Nunca degradar en silencio.

## Salida de los checks mecánicos

🔴 **Esto NO es el final del step**: lo que sigue (PIPE-C4 marker, PIPE-C5 status, PIPE-C6 modo
autónomo, PIPE-C8 modelo, PIPE-C9 tooling y el Logging) es parte del Step 0 y es donde se muta el
estado. El JSON de abajo es sólo el resultado de los checks.

```json
{
  "branch": "feat/<rama>",
  "branch_guard_passed": true,
  "cross_session_passed": true,
  "gitignore_fixed": false,
  "had_main_override": false,
  "status_set_to_in_progress": true,
  "other_active_sessions": [],
  "autonomous": false
}
```

Pasar al Step 1 solo si `branch_guard_passed: true` (o `had_main_override: true` con confirmación explícita) Y `cross_session_passed: true` (o usuario eligió opción b/c en PIPE-C0).

## PIPE-C4 — Setear marker file del pipeline (MANDATORY post-2026-05-15)

Una vez que PIPE-C0, PIPE-C1 y PIPE-C2 pasaron, **setear el marker file** para que los hooks `on-prompt.js`, `on-edit.js` y `on-write-collision.js` puedan detectar bypass del orquestador (ver SKILL.md sección "Marker file"):

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js set \
  '{
    "storyId": "<X.Y.Z extraído del frontmatter story: del .md>",
    "storyPath": "<abs path al spec .md>",
    "sprint": <sprint del frontmatter>,
    "stepsPending": [1, 2, 3, 4, 5, 6, 7, 8]
  }'
```

El marker se actualiza vía `marker.js complete-step <N>` al finalizar cada step subsecuente, y se limpia con `marker.js clear` al finalizar Step 8 (commit-prep) o Step 9 (ado-closure).

**Si el marker setting falla** (permisos, disco lleno, etc.): WARNING al usuario pero NO bloquear el pipeline. Los hooks dejan de funcionar pero el resto del flujo continúa. Reintentar en Step 1.

## PIPE-C5 — Setear `status: in-progress` en el frontmatter (fix robusto 2026-05-20)

**Source of truth durable cross-sesión y cross-máquina.** Después de PIPE-C4, mutar el frontmatter de la story de `ready-for-dev` a `in-progress`:

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js update-story-status \
  "$STORY_PATH" "in-progress"
```

**Por qué este check** (defense-in-depth sobre PIPE-C0):
- El marker per-session-id (`~/.claude/.tycon-pipeline/active/<sessionId>.json`) **no sobrevive a un reboot de la máquina ni a un `marker.js clear`**.
- El `status:` del frontmatter SÍ es durable, está en git, y es la source of truth declarada por el equipo (ver CeiboProject/CLAUDE.md regla "Status de stories — single source of truth").
- Si una sesión muere sin cerrar el pipeline → próxima sesión que abra `tycon-pipeline` sobre la misma story va a leer `status: in-progress` y puede decidir si retomar o resetear.

**Caso especial — status ya es `in-progress`**:
Si al arrancar el pipeline detectás que `status:` YA es `in-progress` y PIPE-C0 no encontró marker activo (sesión muerta sin clear): tratá como "pipeline abandonado". PAUSAR con alerta:

```
🟡 ALERTA — Story X.Y.Z tiene status: in-progress sin marker activo

Esto indica un pipeline previo que NO terminó (sesión cerrada sin «Preparar el commit» ni «Cerrar en ADO»).

Last touch del frontmatter (git log): <fecha>

Opciones:
(a) RETOMAR — buscá engram session_summary del último intento, hacé git status
    para ver archivos sin commitear, y continuá desde donde quedó.
(b) RESET — el trabajo previo se descarta, volvé `status: ready-for-dev` con:
    marker.js update-story-status "<STORY_PATH>" "ready-for-dev"
    y arrancá de nuevo desde «Arranque». Cualquier archivo sin commitear se pierde si
    hacés `git checkout`.
(c) Cancelar.
```

**Si el update falla** (frontmatter sin línea `status:`, permisos, etc.): WARNING al usuario, pero NO bloquear. El marker per-session sigue siendo el state vigente para esta sesión. El frontmatter sin update no afecta la corrida actual — solo afecta detección cross-sesión futura.

## PIPE-C6 — Modo autónomo Nivel 1 (DEFAULT ON desde 2026-06-23; opt-out `--no-autonomous`)

**Viene PRENDIDO por default**. Para correr en HITL puro: pasar `--no-autonomous` en la corrida, o `export TYCON_PIPELINE_NO_AUTONOMOUS=1` (kill-switch global, gana sobre cualquier flag). `pipeline.js start` ya resuelve esto solo y empuja a `actions[]` si quedó ON u OFF.

El modo autónomo activa el **Stop-hook DoD gate** (`on-stop-dod-gate.js`): mientras esté activo, el portón NO deja al agente terminar su turno si hay un check mecánico **registrado en rojo** (build/tests/advisors/dod). Eso fuerza el loop test→fix→re-test sin que el usuario tenga que recordárselo. Frenos: cap de 6 iteraciones + detección de no-progreso (3 vueltas sin resolver) → escala al humano. Botón de pánico: `touch ~/.claude/.tycon-pipeline/STOP_AUTONOMY` (o env `STOP_AUTONOMY=1`).

```bash
# Default ON: pipeline.js start lo corre salvo --no-autonomous / TYCON_PIPELINE_NO_AUTONOMOUS=1.
# Requiere que PIPE-C4 (marker set) haya corrido antes.
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js set-autonomous true
```

**Qué NO automatiza** (sigue siendo human-gate, lo mismo que en modo HITL): aprobar el plan (Step 3), aprobar/waivear findings (Step 7), `git commit`, `git push`, y cualquier cambio de scope firmado. El gate bloquea SOLO ante un check en rojo — un fin de turno en el que el agente pausa para pedirte algo (Step 3, Step 7) NO se traba porque en ese momento no hay check rojo. La autonomía es para lo mecánico (iterar hasta verde), nunca para lo irreversible ni el juicio.

**Si `set-autonomous` falla** (sin marker, permisos): WARNING, NO bloquear — el pipeline sigue en modo HITL normal (el hook deja parar sin `autonomous:true`).

## El tamaño de la corrida — se anuncia antes de lanzar nada

`start` clasifica la story en **liviana** (sólo documentación o textos) o **completa** (lo demás) y estima el tiempo
con las corridas anteriores de la máquina. En `--brief`: `tamano`, `tamano_por`, `estimado_min`, `estimado_de`; en el
marcador: `size`, `size_reason`, `estimate_min`. El orquestador lo dice en UNA línea antes del primer lanzamiento:

> Corrida liviana: sólo documentación (12 archivos). Estimado: 40 min (mediana de 6 corridas livianas de esta máquina).

Sin historia el número es fijo y se dice «estimado sin historia». Para cambiarlo: `marker.js set-size
liviana|completa --reason "<por qué>"` (a liviana con código queda en `bypass.log`). Qué cambia en cada paso:
`guides/harness-cost-tiering.md` §El tamaño de la corrida.

## PIPE-C8 — Sugerencia de modelo + effort de sesión por complejidad

**Advisory — NUNCA bloquea.** Los Steps 2–4 (plan BMAD + implementación) corren INLINE en el main loop → su modelo es el **de la sesión**, y solo el user puede cambiarlo con `/model`. El output de `pipeline.js start` ya incluye `model_hint` (también disponible standalone: `pipeline.js model-hint --story <spec>`):

- **LOW** → `sonnet` (con `also_ok: [opus]`)
- **NORMAL común** → `opus`
- **NORMAL + ≥2 señales pesadas** (superficie >12 archivos, ≥10 ACs, código nuevo amplio, multi-tanda, migración+código, scope firmado) → `fable`

**Qué hace el orquestador**: compará `recommended_session_model` (∪ `also_ok`) con el modelo REAL de tu sesión — lo sabés por tu system prompt ("You are powered by..."). Si tu modelo **está** en el set → seguí en silencio. Si **no está** → anunciá la sugerencia en 1 línea estilo COMM.i, en AMBAS direcciones (upgrade y downgrade):

```
💡 Esta story es [pesada: 3 señales — superficie grande, código nuevo amplio, multi-tanda / simple].
Estás corriendo en <modelo-actual> — para esta conviene <recomendado> [~2x mejor cacería / la mitad del costo].
Cambiá con `/model <recomendado>` y seguimos (la sesión y el marker se conservan), o decime "seguí así".
```

**El user decide.** Cualquier respuesta ("seguí", "dale cambio", silencio + continuar) es válida — NO re-preguntar, NO bloquear. `/model` conserva la sesión y el marker: no se pierde nada del pipeline. Registrar la decisión en el log del step (`model_hint_suggested: <modelo>`, `model_hint_accepted: true|false`).

**Por qué acá**: H.i obliga a sesión fresca por pipeline → el preflight es el momento exacto para elegir modelo, antes de gastar un token de contexto caro. El mismo `model_hint.heavy` alimenta la escalación de modelo del Step 5b (`deep-review-gate`).

**El modelo de la sesión y la organización**: pasá `--session-model <el modelo de tu sesión>` a `start`
(y a `model-hint`): el de Claude (familia o id completo, con o sin `[1m]`) o el de Codex. Con eso `model_hint` trae
`session_check` (`{ model, ceiling, above }`; sin reconocerlo, `{ model: null, reason }`). Si la organización declaró
`team-repos.json → models`:
- `models.session` reemplaza la sugerencia de esta tabla (la nota lo dice y `also_ok` queda vacío);
- con techo obligatorio (`mandatory_ceiling: true`), la sugerencia se recorta al techo, y si `session_check.above` es
  `true` decí la línea que trae (`session_warning`): «la sesión corre en <x>, por encima del techo de la organización
  (<techo>): cambiá con /model o seguí; el arnés no la cambia». El arnés no fija el modelo de la sesión: sólo avisa;
- `start` trae además `models.helpers`: el modelo de los ayudantes sueltos de búsqueda (SPAWN-1 punto 3);
- `models_problem` = la configuración no se pudo leer y se usan los valores de hoy: decilo en 1 línea.

### Effort hint — segunda dimensión del MISMO anuncio

El modelo no es el único knob de sesión: el **reasoning effort** (low/medium/high/xhigh/max) también
gobierna los Steps 2–4 inline. El mapping es del **orquestador (LLM) sobre el MISMO output de
`model-hint`** — cero script nuevo, cero señal nueva:

| `model_hint` | Effort sugerido | Razón |
|---|---|---|
| `risk: LOW` | `medium` (`low` también ok si es casi-mecánica) | plan corto, superficie chica — effort alto acá es plata de más |
| `NORMAL` común | `high` | el plan es el punto de apalancamiento; `medium` pifia edge cases de wiring cross-file / schema |
| `NORMAL` + `heavy` (≥2 señales) | `xhigh` | mismas señales que justifican fable — una iteración de re-loop evitada lo paga |
| — | `max` | **NUNCA automático** — solo pedido explícito del user (debugging gnarly, decisión arquitectónica ambigua) |

**A lo sumo UN anuncio para ambos knobs** (una pausa advisory, no dos), en AMBAS direcciones
(upgrade y downgrade). ⚠️ **Asimetría de visibilidad**: el orquestador conoce su MODELO real
(system prompt "You are powered by...") pero **NO conoce el effort real de la sesión** (el
effort se muestra en la UI, no en el system prompt) — no puede "comparar y callar" como con
el modelo. Regla práctica anti-ruido:

- Banda **NORMAL común** (effort sugerido `high` = default de facto de Claude Code) →
  **silencio** sobre effort. No anunciar lo que ya es el default. La mecánica (silencio en
  NORMAL) es la misma bajo Codex aunque su default de effort difiera — asimetría declarada.
- Banda **LOW** o **heavy** → el effort sugerido **SE EMITE SIEMPRE**: si hay anuncio de
  modelo, va en esa misma línea; si el modelo ya matchea (no hay anuncio de modelo), va en
  un anuncio de 1 línea **solo-effort** — excepción explícita al "seguí en silencio" del
  model hint. Razón: el caso de ahorro más común es justamente modelo correcto + effort
  sobrado (dev clavado en `xhigh` para una story LOW); si el effort solo viajara piggyback
  del model-mismatch, ese caso nunca se atraparía.

Ejemplo (modelo mismatch + heavy — anuncio combinado):

```
💡 Story pesada (3 señales — superficie grande, código nuevo amplio, multi-tanda).
Estás en opus — para esta conviene fable con effort xhigh (una iteración de re-loop evitada lo paga).
Cambiá con `/model` y seguimos (sesión y marker se conservan), o decime "seguí así".
```

Ejemplo (modelo ya matchea + banda LOW — anuncio solo-effort):

```
💡 Story simple (risk LOW). El modelo está bien — y con effort medium alcanza; más que eso es plata de más.
Si estás en high/xhigh, bajalo con `/model` (sesión y marker se conservan), o decime "seguí así".
```

**Calibración honesta (por qué es advisory y nunca auto)**: el tamaño declarado de una story NO
es dificultad de razonamiento — un rename de 20 archivos es "grande" pero mecánico; un algoritmo
gnarly cabe en 1 archivo. El hint informa, el user decide, y su override NO se re-discute en la
corrida. Si el hint pifia seguido → recalibrar señales/umbrales en `computeModelHint`
(`pipeline.js`), NO agregar un scorer paralelo (anti tejido cicatrizal — ver
`guides/harness-cost-tiering.md` §Movimiento 4).

Registrar en el log del step, junto a los campos del model hint:
`effort_hint_suggested: <tier>`, `effort_hint_accepted: true|false`.

## PIPE-C9 — Tooling esperado no disponible → AVISAR

**El pipeline degrada a fallbacks cuando le falta una herramienta — eso NUNCA pasa en silencio.** El output de `pipeline.js start` incluye `tooling.expected[]` (también standalone: `pipeline.js tooling-expected --repo <dir>`): la lista MECÁNICA de herramientas que este repo/equipo espera —

- **codegraph** (si el repo tiene `.codegraph/`) — lookup de símbolos/call-graph; fallback: grep, más lento y menos preciso.
- **engram** (siempre — protocolo del equipo) — memoria persistente; fallback: run sin lecciones previas ni session_summary.
- **workflow-tool** (siempre) — sin la tool `Workflow` el Step 5b adversarial NO corre; fallback: cobertura reducida.
- **Cualquier MCP declarado por el repo** — en su `.mcp.json` o en la config del proyecto (`~/.claude.json`): codebase_memory, azure-devops, bizuit-bpmn-mcp-dev, context7, etc. Detección genérica: si el repo lo declara, se espera disponible.
- **Las skills de terceros que el pipeline invoca por nombre** — las entradas del manifiesto de terceros del arnés (`scripts/publishing/third-party-skills.json`) con `used_by: tycon-pipeline` (hoy `bmad-dev-story`, `bmad-agent-dev`, `bmad-agent-quick-flow-solo-dev`, `bmad-agent-analyst`, `bmad-code-review`, `test-driven-development` y la derivada `tycon-create-story`), cada una `kind: skill` con `present` (existe `<skills>/<nombre>/SKILL.md`) y, si falta, `action` («corré el instalador del arnés» o «instalá el plugin oficial»). Éstas SÍ las sabe el script: no hay que verificarlas en el harness. `start --brief` las trae en `skills_faltantes` sólo si falta alguna → avisar al user en 1 línea con la acción ANTES del step que la invoca. Sin manifiesto legible aparece una entrada `third-party-manifest` con `present: false`: se avisa y se sigue.

**Qué hace el orquestador** — escalera por cada entry (verificá si la tool está REALMENTE en TU harness: las `mcp__<prefix>*` en tu lista de tools / ToolSearch; la tool `Workflow` en tu set base — el script no puede verlo, las tools viven en tu harness, no en el shell):

1. **MCP disponible** → usarla, seguir en silencio.
2. **MCP NO disponible pero `binary_found` tiene path** → **INTENTAR LEVANTARLO** siguiendo el `raise_it` de la entry:
   - Para ESTE run: usar el **CLI vía Bash** (`cli_fallback` — mismo índice/store que el MCP: `codegraph query|context|status`, `codebase-memory-mcp cli <tool>`, `engram search`). La capacidad NO se pierde, solo cambia el transporte.
   - Para dejar el MCP cargado: el server de una sesión ya iniciada solo se recarga con `/mcp` o reiniciando la sesión — eso es acción del USER. Avisarle en 1 línea: *"<tool> está instalada pero el MCP no levantó — este run uso su CLI; para dejarlo andando corré `<tool> install` y reconectá con `/mcp` (o reiniciá la sesión)"*.
3. **`binary_found: null`** (ni MCP ni binario) → no hay forma de levantarlo acá: avisar al user con la acción concreta de instalación (`if_unavailable` + `raise_it`) y seguir con el `fallback` (grep / sin memoria).
4. **`workflow-tool` no disponible** → caso especial: se pierde el pase adversarial entero → PREGUNTAR *"¿sigo igual?"* (el user decide).
5. **Falla MID-RUN** (la tool estaba pero un invoke falla en cualquier step) → misma escalera desde el paso 2: 1 línea de aviso + CLI si hay binario. Degradar en silencio = bug (regla TOOL.i del SKILL).

Registrar en el log del step: `tooling_checked: [{name, available, via: 'mcp'|'cli'|'fallback'}]` + avisos emitidos.

## Logging

Escribir a `.advisors/pipeline-runs/<clave>-<sello>/step-00-preflight.md` con el resultado de cada check corrido (PIPE-C0 a PIPE-C9, los que apliquen — incluye `model_hint_*`/`effort_hint_*` de C8 y `tooling_checked` de C9).
