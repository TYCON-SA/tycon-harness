# Arranque

**Objetivo**: las verificaciones críticas ANTES de arrancar el pipeline, más dos avisos opcionales (el de trabajo y el
del pedido en Azure DevOps). Son guardas de seguridad del flujo de trabajo, no del código. Corre antes de «Validar la
historia» (`step-02-validate-story.md`).

## Qué hace el comando y qué hace el agente

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js start --story <spec> --repo <dir> --brief [--autonomous]
```

Un solo comando hace los chequeos (PIPE-C0, C1, C2, C4, C5, el modo autónomo, el tamaño, el modelo y el tooling),
deja el marcador puesto y cierra el paso `start`. Pausa SOLO ante conflicto cross-session, rama protegida o pipeline
abandonado, y en esos casos no muta nada: la decisión es de la persona. **El agente corre el comando y actúa sobre su
salida**: pausas, avisos y las dos partes opcionales de más abajo. El paso siguiente sale de `pipeline.js next`
(`next_step`, y `start_parts` con las partes del Arranque que todavía faltan).

## Qué hacer ante cada pausa

### PIPE-C0 — la story ya tiene un pipeline vivo en OTRA sesión (CRITICAL, bloquea)

`start` lo detecta con `marker.js find-by-story <storyId>` y devuelve los marcadores de las otras sesiones. NO arrancar
de cero: se re-ejecutan pasos ya hechos, se re-preguntan decisiones, se pisan archivos y se abre un segundo registro de
horas. Mostrar la alerta (sesión, fecha de arranque, último toque, repo, pasos hechos y pendientes) y ofrecer:

- **(a) Retomar** (recomendado si la otra sesión sigue viva): buscar el resumen en engram
  (`mem_search project="<proyecto>" query="Story X.Y.Z session_summary"`), mirar `git status`, adoptar el marcador con
  `marker.js adopt-session <sessionId>` (copia completa) y seguir desde el primer paso pendiente.
- **(b) Limpiar** (la otra sesión murió): `marker.js clear-session <sessionId>` y arrancar de nuevo.
- **(c) Paralelo intencional** (raro; implica ramas distintas): dejarlo escrito en engram, poner `notes='paralelo
  intencional con <sessionId>'` en el marcador y seguir.
- **Cancelar**: terminar el pipeline.

**Stories DISTINTAS en paralelo sobre el mismo repo**: PIPE-C0 no las detecta (compara por id de story) y el árbol
compartido las contamina: un solo HEAD, el `git diff HEAD` arma mal el set de revisores y `.advisors/tests-result.json`
es único por repo. Regla del equipo: **un worktree por story**. Si `marker.js list-all` muestra otro pipeline activo
sobre este `repoPath`, crear el worktree (`~/.claude/tycon-harness/scripts/tools/tycon-worktree.sh new <slug>`) y correr
el pipeline DESDE ahí. Los recursos suman por máquina: una suite completa a la vez y el segundo pipeline con
`TYCON_5B_EARLY=0` (`step-06-run-tests.md` §Riesgo multi-sesión). Detalle: `~/.claude/tycon-harness/guides/git-worktrees.md`.

### PIPE-C1 — rama protegida (CRITICAL, bloquea)

Si la rama es `main`, `master`, `production`, `prod` o `release`, `start` pausa. Mostrar la alerta (commits directos
saltean la revisión, no se revierten sin reescribir historia) con tres opciones:

- **Crear la rama** `git checkout -b feat/{story-id}-{slug}` y seguir.
- **Continuar de todos modos** (no recomendado): sólo si la persona escribe literalmente «continuar en main». Queda
  `had_main_override: true` y la advertencia va al commit prep de `step-11-prepare-commit.md`.
- **Cancelar** el pipeline.

Rama feature/dev/bugfix: sigue sin pausar. **La historia de primera vez** (marca `origin: first-time` Y la constancia
que deja el guion de `tycon-create-story`) no pausa: `start` hace `git init` si no hay git, crea `story/<número>` y lo
dice en `actions_done`; si esa rama ya existe, pausa nombrándola. La marca sola (escrita a mano) no alcanza.

### PIPE-C5 — la story ya está `in-progress` sin marcador activo (CRITICAL, bloquea)

Es un pipeline abandonado (sesión cerrada sin «Preparar el commit»). Mostrar la fecha del último cambio del
frontmatter (`git log`) y ofrecer: **retomar** (resumen de engram, `git status`, seguir donde quedó), **reiniciar**
(`marker.js update-story-status "<STORY_PATH>" "ready-for-dev"` y volver a arrancar; lo no commiteado se pierde con un
`git checkout`) o **cancelar**.

## Qué hacer ante cada aviso

- **PIPE-C2 — `.gitignore`** (no bloquea): `start` pregunta a git qué ignora y arregla solo lo aditivo, en el repo de
  trabajo y en el de la story. Sin decisión previa agrega el bloque canónico de `.advisors/` (🔴 NUNCA `.advisors/` a
  secas: anula toda negación y la evidencia de cierre deja de viajar). Con el bloque anterior al registro de
  aprobaciones agrega sólo la línea `!**/.advisors/pipeline-runs/*/approvals.jsonl`. Si el repo ya decidió pero se traga
  lo que tiene que viajar (evidencia de cierre, `review-roster.json`, `findings.json`, `approvals.jsonl`), NO se toca:
  decir qué no viaja y que decide una persona (un repo así deja rojo al portón de CI al cerrar). Si no es repo git, no
  se toca nada y queda constancia.
- **PIPE-C3 — árbol limpio** (opcional): sólo con `--strict-working-tree`. Con cambios sin commitear, avisar que se van
  a mezclar con los de la story y preguntar si se commitea o guarda primero.
- **PIPE-C4 / marcador** (no bloquea): si el marcador no se pudo escribir, avisar; los hooks dejan de funcionar pero el
  flujo sigue (se reintenta en «Validar la historia»).
- **PIPE-C5 — `update-story-status` falló** (no bloquea): avisar; el marcador de la sesión sigue siendo el estado
  vigente, sólo se pierde la detección entre sesiones.
- **PIPE-C6 — modo autónomo** (viene PRENDIDO; se apaga con `--no-autonomous` o `TYCON_PIPELINE_NO_AUTONOMOUS=1`, que
  gana sobre cualquier flag): el Stop-hook no deja terminar el turno con un control mecánico registrado en rojo
  (build, tests, revisores, DoD), lo que fuerza el ciclo prueba-arreglo-prueba. Frenos: 6 iteraciones y 3 vueltas sin
  avance escalan a la persona; pánico: `touch ~/.claude/.tycon-pipeline/STOP_AUTONOMY` (o `STOP_AUTONOMY=1`). NO
  automatiza lo que decide una persona: aprobar el plan, aprobar o eximir hallazgos, `git commit`, `git push` ni un
  cambio de alcance firmado. Si `marker.js set-autonomous true` falla, avisar y seguir en modo con persona.
- **Tamaño de la ejecución**: `start --brief` trae `tamano`, `tamano_por`, `estimado_min` y `estimado_de` (liviana =
  sólo documentación o textos; completa = lo demás). Decirlo en UNA línea antes del primer lanzamiento: «Ejecución
  liviana: sólo documentación (12 archivos). Estimado: 40 min (mediana de 6 ejecuciones livianas de esta máquina).» Sin
  historia: «estimado sin historia». Para cambiarlo: `marker.js set-size liviana|completa --reason "<por qué>"` (a
  liviana con código queda en `bypass.log`). Qué cambia en cada paso: `guides/harness-cost-tiering.md` §El tamaño.

## PIPE-C8 — sugerencia de modelo y de effort (advisory, nunca bloquea)

«Armar el plan» e «Implementar» corren INLINE en el modelo de la sesión, que sólo la persona cambia con `/model`. La
salida de `start` trae `model_hint` (también suelto: `pipeline.js model-hint --story <spec>`):

- **LOW** → `sonnet` (`also_ok: [opus]`) · **NORMAL común** → `opus` · **NORMAL con ≥2 señales pesadas** (superficie
  >12 archivos, ≥10 ACs, código nuevo amplio, varias tandas, migración más código, alcance firmado) → `opus` con effort
  `xhigh`; `fable` sólo si la organización lo declara (`models.session.heavy`).

Comparar `recommended_session_model` (más `also_ok`) con el modelo REAL de la sesión (lo dice el prompt de sistema).
Si está en el set, seguir en silencio. Si no, UN anuncio de una línea, en ambas direcciones (más y menos potente):

```
💡 Esta story es [pesada: 3 señales — superficie grande, código nuevo amplio, varias tandas / simple].
Estás corriendo en <modelo-actual> — para esta conviene <recomendado> [~2x mejor cacería / la mitad del costo].
Cambiá con `/model <recomendado>` y seguimos (la sesión y el marcador se conservan), o decime "seguí así".
```

**La persona decide**; cualquier respuesta vale y no se re-pregunta. Registrar `model_hint_suggested` y
`model_hint_accepted`. Pasar `--session-model <el modelo de la sesión>` a `start` y a `model-hint` para que traiga
`session_check` (`{ model, ceiling, above }`). Si la organización declaró `team-repos.json → models`: `models.session`
reemplaza la tabla (y `also_ok` queda vacío); con techo obligatorio (`mandatory_ceiling: true`) la sugerencia se recorta
al techo y, si `session_check.above` es `true`, decir la línea `session_warning` (el arnés no fija el modelo, sólo
avisa); `models.helpers` es el modelo de los ayudantes sueltos de búsqueda; `models_problem` = la configuración no se
pudo leer y se usan los valores de hoy: decirlo en una línea.

**Effort** (segunda dimensión del MISMO anuncio, nunca dos): LOW → `medium`; NORMAL común → `high`; NORMAL con señales
pesadas → `xhigh`; `max` NUNCA automático. El agente conoce su modelo pero NO el effort real de la sesión, así que:
banda NORMAL común → silencio (`high` ya es el default); banda LOW o pesada → el effort se anuncia SIEMPRE (en la misma
línea del modelo o, si el modelo ya coincide, en un anuncio de una línea sólo de effort: «Story simple. El modelo está
bien y con effort medium alcanza; si estás en high/xhigh, bajalo con `/model`»). El tamaño declarado no es dificultad
de razonamiento (un renombre de 20 archivos es grande pero mecánico): si el hint pifia seguido, se recalibra
`computeModelHint` en `pipeline.js`, no se agrega otro puntaje. Registrar `effort_hint_suggested` y `effort_hint_accepted`.

## PIPE-C9 — tooling esperado no disponible: AVISAR

El pipeline degrada a alternativas cuando falta una herramienta, y eso NUNCA pasa en silencio. `start` trae
`tooling.expected[]` (suelto: `pipeline.js tooling-expected --repo <dir>`): **codegraph** (si el repo tiene
`.codegraph/`), **engram** (siempre), **workflow-tool** (siempre; sin la tool `Workflow` no corre el pase adversarial),
cualquier MCP que el repo declare en `.mcp.json` o en la configuración del proyecto, y las skills de terceros que el
pipeline invoca por nombre (`scripts/publishing/third-party-skills.json`, `used_by: tycon-pipeline`; si falta alguna,
`start --brief` las trae en `skills_faltantes`: avisar en una línea con la acción ANTES del paso que la invoca).

Verificar si la tool está REALMENTE en la sesión (las `mcp__<prefijo>*` en la lista de tools; la tool `Workflow` en el
set base; el script no puede verlo) y, por cada entrada:

1. **Disponible** → usarla, en silencio.
2. **No disponible pero `binary_found` trae ruta** → usar su CLI por Bash en esta ejecución (`cli_fallback`: mismo
   índice, otro transporte) y avisar en una línea: «<tool> está instalada pero el MCP no levantó; esta ejecución usa su
   CLI; para dejarlo andando corré `<tool> install` y reconectá con `/mcp` (o reiniciá la sesión)».
3. **`binary_found: null`** → avisar la acción de instalación (`if_unavailable` + `raise_it`) y seguir con el
   `fallback`.
4. **`workflow-tool` no disponible** → se pierde el pase adversarial entero: PREGUNTAR «¿sigo igual?».
5. **Falla a mitad de la ejecución** → la misma escalera desde el punto 2; degradar en silencio es un error.

Registrar `tooling_checked: [{name, available, via: 'mcp'|'cli'|'fallback'}]` y los avisos emitidos.

## Salida de `start` y cómo se sigue

El resultado de los chequeos (`branch`, `branch_guard_passed`, `cross_session_passed`, `gitignore_fixed`,
`had_main_override`, `status_set_to_in_progress`, `other_active_sessions`, `autonomous`) es sólo eso: lo que sigue es
parte de este paso. Se pasa a «Validar la historia» sólo con `branch_guard_passed: true` (o `had_main_override: true`
con confirmación explícita) Y `cross_session_passed: true` (o la opción b/c de PIPE-C0).

## 🔀 Las partes opcionales corren MIENTRAS el validador ya está en vuelo

«Validar la historia» tarda 1-7 min y no depende de nada que las partes opcionales produzcan (no lee
`workSignalStarted` ni `adoMarkedActive`; su entrada es la story, cuyo frontmatter `start` ya dejó en `in-progress`,
estado que el validador tolera). Orden:

1. Correr primero el evento del aviso de trabajo (punto 1 de su parte): su acción es el ÚNICO punto que puede necesitar
   una pregunta al dev (por ejemplo, a qué proyecto cargar las horas). Si hay que preguntar, se pregunta ACÁ, antes del
   fan-out.
2. Abrir `steps/step-02-validate-story.md` y lanzar sus `Agent(...)` TAL CUAL están escritos, incluidos los
   `lanzamientos` que devuelve `pipeline.js validators` (con su `prompt` y su `modelo` ya resueltos). Es la ÚNICA
   excepción al «leé SOLO este paso» de `pipeline.js next`: se lee ese archivo para lanzar y se vuelve a este para el
   join. Si el prompt no se puede reproducir textualmente, NO improvisarlo: caer al orden secuencial.
3. Completar las dos partes mientras el validador corre.
4. El join es la notificación del validador: recién ahí se procesa su reporte. 🔴 Nunca presentar una pregunta de una
   parte opcional y el resultado del validador en el mismo mensaje sin rotular cuál es cuál; si la parte del pedido en
   ADO necesita confirmación (búsqueda por título, pedido cerrado), resolverla ANTES de procesar el reporte.

Si el fan-out se complica (por ejemplo, la acción espera una respuesta que no llega), el orden secuencial (partes,
después validar) sigue valiendo: el fan-out es una optimización, no un requisito.

## Parte opcional: el aviso de trabajo

Le avisa a la herramienta de horas que eligió la organización que el trabajo en esta story arranca. El pipeline no
sabe cuál es: emite el evento neutro de trabajo (`scripts/lib/work-signal.js` del arnés) y la integración elegida
(`integrations/<nombre>/`) lo atiende. Corre después de `start` (si `start` abortó, por ejemplo por estar en `main`,
no hay trabajo que avisar).

**Cuándo no corre**: sin herramienta de horas elegida (`integrations.timeTracking` ausente o `none`; o
`TYCON_TIME_TRACKING=none` en la máquina), o con una desconocida o el manifiesto roto. Entonces la parte NO aparece en
`start_parts` de `pipeline.js next` (que la da por salteada con el motivo) y no se marca la bandera: diría «aviso dado»
sin aviso.

1. **Emitir el evento**: `node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js work-signal start`.
   Toma del marcador la historia, su `title:`, el repo y la sesión; devuelve `{ ran, action?, warnings }` y cada aviso
   sale también por la salida de errores, en una línea.
2. **Hacer la acción, si vino una**: una herramienta que maneja el agente (con su servidor de MCP) devuelve en `action`
   lo que hay que hacer, con las referencias a la skill de su integración. Hacerla **SIN pedir confirmación al dev** (el
   pipeline es intención explícita), salvo lo que la propia acción diga que se pregunta. Una herramienta que la
   integración maneja sola (por su API) no devuelve acción: ya quedó hecho.
3. **Marcarla hecha**: `node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js set-flag workSignalStarted true`
   (el nombre viejo de la bandera se sigue aceptando y escribe la nueva). Sin la bandera, un retome entre sesiones o
   `pipeline.js next` vuelven a avisar.
4. Una línea a stdout: `✓ Aviso de trabajo: <integración> · <lo que hizo>`. No pausar.

**Si falla** (el evento avisa un problema, la acción no se puede hacer):
`node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js start-warning time-tracking "<motivo>"` y seguir.
El Arranque igual queda cerrado, no frena el pipeline (registrar horas no es camino crítico) y el aviso sale en `next`,
en el cartel y en el cierre.

**Lo que NO hace**: NO cierra el registro al final del pipeline (lo cierra `close-work-item.md`, la propia integración
por inactividad o el dev; la lista está en `step-11-prepare-commit.md` §«NO cerrar el registro de horas») y NO nombra
ninguna herramienta: lo propio de cada una vive en su integración.

## Parte opcional: el pedido en ADO

Cuando el dev invoca el pipeline, pasa el work item de Azure DevOps del estado inicial (`New` / `To Do` / `Approved`) a
`Active` (o su equivalente según el proceso). Es la simetría de `close-work-item.md`, que cierra el ciclo.

**Cuándo no corre** (no aparece en `start_parts` de `next`, o se saltea con una línea):

- **Azure DevOps apagado**: sin organización (`ado.org` ausente en la configuración del arnés; exit 3 de
  `node ~/.claude/tycon-harness/scripts/lib/tycon-config.js get ado.org`), la parte lo dice en UNA línea («Azure DevOps
  apagado en esta máquina — el work item no se toca; prender: ado.org en ~/.claude/tycon.json o TYCON_ADO_ORG»), no
  llama a `az` y se saltea (exit 0). La tabla de `guides/integrations/ado-projects.md` es referencia para personas, no
  algo que el pipeline lea.
- **La story no tiene `ado_work_item:` y la búsqueda por título no da un match único**: salteo silencioso. NO preguntar
  por un `ado_work_item:` que falta: eso lo resuelve `close-work-item.md` al cerrar.

**Configuración** (en este orden): `.tycon/ado-config.yaml` del repo (`ado_org` y `ado_project`; manda, porque un repo de
cliente puede vivir en otra organización); si no, `ado.org` de la configuración del arnés (lee `TYCON_ADO_ORG`,
`~/.claude/tycon.json` y el perfil del equipo, en ese orden; exit 2 = configuración rota, que se dice con archivo, clave
y motivo) y el proyecto de `TYCON_ADO_PROJECT` o preguntando al dev. Overrides en `.tycon/ado-config.yaml`:
`ado_state_active` (default `Active`), `ado_state_closed` (lo usa `close-work-item.md`) y `ado_auto_assign: true`.

**Qué hacer**:

1. **Sin `ado_work_item:` en el frontmatter, buscar por título** antes de saltear (los work items suelen preexistir a
   las stories y el dev olvida enlazarlos):
   ```bash
   az boards query --organization <ado_org> --project <ado_project> --output json \
     --wiql "SELECT [System.Id], [System.Title], [System.State] FROM workitems WHERE [System.TeamProject] = '<ado_project>' AND [System.Title] CONTAINS '<story_id>'"
   ```
   Un match único → proponer «Encontré el pedido #{id} '{title}' que parece corresponder a esta story. ¿Agrego
   `ado_work_item: {id}` al frontmatter y lo paso a Active?»; si confirma, editar la story y seguir. Varios → mostrar
   los cinco primeros y pedir cuál. Cero → una línea («ningún pedido con `<story_id>` en el título; considerá crearlo
   o agregar `ado_work_item:` a mano») y seguir sin transicionar.
2. **Leer el estado actual** (idempotencia):
   `az boards work-item show --organization <ado_org> --id <id> --query "fields.\"System.State\"" --output tsv`.
   Ya `Active` (o equivalente) → no hacer nada y decirlo. `Closed` / `Resolved` / `Done` → ADVERTIR antes de tocar:
   «El pedido {id} está en `{state}`. ¿Reabrir a `Active`? Puede romper la trazabilidad si la story estaba cerrada por
   otro motivo.» y esperar. `New` / `To Do` / `Approved` / `Committed` → transicionar.
3. **Transicionar** con el equivalente del proceso: Basic `To Do` → `Doing`; Agile `New`/`Approved` → `Active`; Scrum
   `New` → `Committed`; CMMI `Proposed` → `Active`. Un estado intermedio desconocido va a `Active` y se anota su nombre
   para que el dev agregue el override:
   `az boards work-item update --organization <ado_org> --id <id> --state "Active"`.
4. **Asignar**, sólo con `ado_auto_assign: true`: `--assigned-to "<git config user.email>"`. No por default: algunos
   equipos asignan por separado.
5. **Marcarla hecha** (también si el pedido ya estaba en `Active`):
   `node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js set-flag adoMarkedActive true`. Sin la bandera,
   un retome o `pipeline.js next` vuelven a transicionar.
6. Una línea al dev, parte del encabezado general y no un mensaje aparte: `📋 ADO WI #{id}: {previo} → {nuevo}.` Si se
   salteó: una línea contextual o nada.

**Si falla** (401/403 token vencido: «renová AZURE_DEVOPS_EXT_PAT»; 404 el pedido no existe: ¿`ado_work_item`
desactualizado?; estado inválido: listar los válidos del pedido):
`node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js start-warning ado "<motivo>"` y seguir. No frena el
pipeline: la implementación no depende de ADO (a diferencia del build gate de `step-05-implement.md`).

**Anti-patterns**: NO reabrir pedidos cerrados sin confirmación explícita; NO duplicar esta transición en
`step-05-implement.md` (re-transicionar es ruido en el historial del pedido).

## Logging

Escribir a `.advisors/pipeline-runs/<clave>-<sello>/step-01-start.md` el resultado de cada check corrido (PIPE-C0 a
PIPE-C9, los que apliquen; incluye `model_hint_*`/`effort_hint_*` y `tooling_checked`) y, por cada parte opcional,
`integración | pedido` · acción · avisos · `status: ok | skipped (<razón>) | failed (<razón>)`. El detalle de la parte
del pedido en ADO va a `step-01-start-ado.md` de la misma carpeta (WI ID, estado previo y nuevo, asignado a, resultado).
