# Arranque

**Objetivo**: las verificaciones críticas ANTES de arrancar el pipeline, más dos avisos opcionales (el de trabajo y el
del pedido de trabajo). Son guardas de seguridad del flujo de trabajo, no del código. Corre antes de «Validar la
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
  (build, tests, revisores, DoD), lo que fuerza el ciclo prueba-arreglo-prueba. Frenos: 6 iteraciones, o la primera
  vuelta que no resuelve ninguno de los fallos de la anterior, escalan a la persona con el rojo tal cual; pánico: `touch ~/.claude/.tycon-pipeline/STOP_AUTONOMY` (o `STOP_AUTONOMY=1`). NO
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

## Lo que falta antes de arrancar: AVISAR

Si la salida de `start` trae `missing_before_start`, se le dice a la persona antes de seguir, una línea por cosa: qué
falta (`falta`), qué hace el pipeline sin eso (`sin_eso`) y cómo se instala (`como`). Son tres: el programa de la
plataforma del pedido de trabajo, la configuración de BMAD del repo y el servidor MCP de la herramienta de horas. No
frena: la parte que no puede correr se declara con `start-warning` cuando le toca, y el plan sin BMAD lo arma el
orquestador. Sin la clave, no se dice nada.

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
   parte opcional y el resultado del validador en el mismo mensaje sin rotular cuál es cuál; si la parte del pedido de
   trabajo necesita confirmación (búsqueda por título, pedido cerrado), resolverla ANTES de procesar el reporte.

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
   Sin acción y sin avisos, el comando deja la parte marcada: no hay nada más que hacer.
2. **Hacer la acción, si vino una**: una herramienta que maneja el agente (con su servidor de MCP) devuelve en `action`
   lo que hay que hacer, con las referencias a la skill de su integración. Hacerla **SIN pedir confirmación al dev** (el
   pipeline es intención explícita), salvo lo que la propia acción diga que se pregunta. Una herramienta que la
   integración maneja sola (por su API) no devuelve acción: ya quedó hecho.
3. **Cerrar la acción**: `node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js work-signal start --action-done "<id que devolvió la herramienta>"`.
   El arnés busca en la conversación de la sesión la llamada a la herramienta cuyo resultado trae ese id, y recién ahí
   marca la parte. La bandera no se escribe con `marker.js set-flag`: ese comando la rechaza. Sin la bandera, un retome
   entre sesiones o `pipeline.js next` vuelven a avisar.
4. Una línea a stdout: `✓ Aviso de trabajo: <integración> · <lo que hizo>`. No pausar.

**Si falla** (el evento avisa un problema, la acción no se puede hacer):
`node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js start-warning time-tracking "<motivo>"` y seguir.
El Arranque igual queda cerrado, no frena el pipeline (registrar horas no es camino crítico) y el aviso sale en `next`,
en el cartel y en el cierre.

**Lo que NO hace**: NO cierra el registro al final del pipeline (lo cierra `close-work-item.md`, la propia integración
por inactividad o el dev; la lista está en `step-11-prepare-commit.md` §«NO cerrar el registro de horas») y NO nombra
ninguna herramienta: lo propio de cada una vive en su integración.

## Parte opcional: el pedido de trabajo

Cuando el dev invoca el pipeline, pasa el pedido de trabajo de la historia del estado inicial al activo. Es la simetría
de `close-work-item.md`, que cierra el ciclo. El paso no arma comandos de ninguna plataforma: lo hace la capa de
plataforma (`scripts/lib/platform/platform.js`), y la plataforma la elige el perfil del equipo (`integrations.platform`).

**El id**, con el lector común (lee `work_item:` y su nombre viejo `ado_work_item:`, que se sigue leyendo):
`node ~/.claude/tycon-harness/scripts/lib/platform/work-item-field.js get <story_path>` (sale 3 si no tiene).

**Dónde vive**: `.tycon/work-items.yaml` del repo (o `.tycon/ado-config.yaml`, el nombre viejo, que se sigue leyendo;
con los dos gana el nuevo); si no, `ado.org` de la configuración del arnés (lee `TYCON_ADO_ORG`, `~/.claude/tycon.json`
y el perfil del equipo, en ese orden; exit 2 = configuración rota, que se dice con archivo, clave y motivo) y el
proyecto de `TYCON_ADO_PROJECT`. Overrides en ese archivo: `state_active`, `state_closed` (lo usa `close-work-item.md`)
y `auto_assign: true`.

**Cuándo no corre** (no aparece en `start_parts` de `next`, o se saltea con una línea): la historia no tiene id y la
búsqueda por título no da un match único, o no hay plataforma elegida. **Azure DevOps apagado** (sin organización: ni
`ado.org` en la configuración del arnés ni la del repo) es ese caso: la parte lo dice en UNA línea («Azure DevOps
apagado en esta máquina — el pedido no se toca; prender: ado.org en ~/.claude/tycon.json o TYCON_ADO_ORG»), no llama a
`az` y se saltea (exit 0). NO preguntar por un `work_item:` que falta: eso
lo resuelve `close-work-item.md` al cerrar. Nunca en silencio: una línea que diga qué falta.

**Qué hacer**:

1. **Sin id, buscar por título** antes de saltear (los pedidos suelen preexistir a las stories y el dev olvida
   enlazarlos). Sólo con Azure DevOps; primero, qué plataforma atiende los pedidos:
   ```bash
   node ~/.claude/tycon-harness/scripts/lib/platform/platform.js choose work-item update
   # → {"ok": true, "value": {"connector": "azure-devops", …}}  o  {"ok": false, "reason": "sin_plataforma", "detail": "…"}
   ```
   Otro `connector`, u `ok: false` → una línea («la historia no tiene pedido de trabajo (`work_item:`); se crea con la
   skill de creación o al cerrar», o el `detail`) y seguir. Con `azure-devops`:
   ```bash
   az boards query --organization <ado_org> --project <ado_project> --output json \
     --wiql "SELECT [System.Id], [System.Title], [System.State] FROM workitems WHERE [System.TeamProject] = '<ado_project>' AND [System.Title] CONTAINS '<story_id>'"
   ```
   Un match único → proponer «Encontré el pedido #{id} '{title}' que parece corresponder a esta story. ¿Agrego
   `work_item: {id}` al frontmatter y lo paso a activo?»; si confirma, escribirlo con
   `node ~/.claude/tycon-harness/scripts/lib/platform/work-item-field.js set <story_path> {id}` y seguir. Varios →
   mostrar los cinco primeros y pedir cuál. Cero → una línea («ningún pedido con `<story_id>` en el título; considerá
   crearlo o agregar `work_item:` a mano») y seguir sin transicionar.
2. **Transicionar y marcar**: `node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js ado-mark-active`
   (con `auto_assign: true`, sumar `--assign-to "<git config user.email>"`; no por default: algunos equipos asignan por
   separado). Pide a la capa (`platform.js work-item update`), que lee el estado actual y lo pasa al activo sin tocar nada si ya
   estaba: en Azure DevOps según la plantilla de proceso (Basic `To Do` → `Doing`; Agile `New`/`Approved` → `Active`;
   CMMI `Proposed` → `Active`; Scrum `New` → `Committed`, declarado con `state_active`); en GitHub, la etiqueta
   `estado:<state_active>` (por defecto `estado:activo`). Recién con la respuesta de la capa marca la parte: la bandera
   no se escribe con `marker.js set-flag`, que la rechaza. Sale 0 marcado, 1 si la capa dijo que no (el `summary` dice
   qué falta) y 3 si el pedido está **cerrado** (`pideReabrir`): ADVERTIR antes de tocar («El pedido {id} está en
   `{estado}`. ¿Reabrirlo? Puede romper la trazabilidad si la story estaba cerrada por otro motivo.»), esperar, y con el
   sí correr `ado-mark-active --reopen`.
3. Una línea al dev, parte del encabezado general y no un mensaje aparte: el `summary` de la capa que imprime el comando
   (`pedido de trabajo #{id} en <plataforma>: {previo} → {estado}`). Si se salteó: una línea contextual o nada.

**Si falla** (`ok: false`: sin plataforma elegida, sin credencial —con Azure DevOps, la sesión de `az` venció: `az
login` o renovar `AZURE_DEVOPS_EXT_PAT`—, pedido no encontrado, la plataforma lo rechazó):
mostrar el `summary` en UNA línea (dice qué falta y cómo ponerlo),
`node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js start-warning ado "<motivo>"` y seguir. No frena el
pipeline: la implementación no depende de la plataforma (a diferencia del build gate de `step-05-implement.md`).

**Anti-patterns**: NO reabrir pedidos cerrados sin confirmación explícita; NO duplicar esta transición en
`step-05-implement.md` (re-transicionar es ruido en el historial del pedido).

## Logging

Escribir a `.advisors/pipeline-runs/<clave>-<sello>/step-01-start.md` el resultado de cada check corrido (PIPE-C0 a
PIPE-C9, los que apliquen; incluye `model_hint_*`/`effort_hint_*` y `tooling_checked`) y, por cada parte opcional,
`integración | pedido` · acción · avisos · `status: ok | skipped (<razón>) | failed (<razón>)`. El detalle de la parte
del pedido de trabajo va a `step-01-start-ado.md` de la misma carpeta (WI ID, estado previo y nuevo, asignado a, resultado).
