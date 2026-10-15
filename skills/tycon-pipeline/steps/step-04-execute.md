# Step 4 — Ejecutar implementación + build gate

**Objetivo**: el skill BMAD elegido en Step 2 ahora ejecuta el plan aprobado en Step 3. Después se corre build para verificar que el código compila antes de invocar advisors.

## Inputs

- `approved_plan` del Step 3
- `bmad_skill_name` del Step 2

> 💡 **Herramientas de código (2026-07-06)**: durante TODA la implementación, para lookup de símbolos /
> callers / impact usá las tools de code-intel disponibles (`mcp__codegraph__*`, `mcp__codebase_memory__*`;
> o sus CLIs vía Bash si el MCP no levantó — ver step-02 §"Herramientas de código disponibles" y PIPE-C9)
> en vez de grep manual. Si una tool esperada FALLA a mitad del step → 1 línea de aviso al user antes de
> degradar (regla TOOL.i), nunca en silencio.

## 🔴 PRE-IMPLEMENTATION GATE (Spec-First Enforcement)

**OBLIGATORIO antes de invocar BMAD execute o cualquier coding session de una phase post-impl (L, M, N, etc.)**.

Disparador del gate: cualquier momento en que el dev decida implementar un cambio que no se discutió en Step 3 plan approval (típicamente "Phase L wiring", "Phase M fixes", "Phase N additions" descubiertos durante runtime smoke).

### Checklist forzado — responder explícitamente ANTES de codear

Para cada cambio propuesto en la phase, el ejecutor (el agente o el dev) debe responder:

1. **¿El spec describe LITERALMENTE lo que voy a implementar?** (no inferencia, literal en el AC text)
2. **¿Estoy cambiando un response shape / añadiendo endpoint / componente / wire-up no especificado?**
3. **¿Estoy reinterpretando un AC para incluir algo que el AC no dice?**

Si **CUALQUIER** respuesta es "sí, pero..." o "está implícito" o "es obvio" → **PAUSA**.

### Acción cuando se dispara la pausa

1. NO empezar a editar archivos de código.
2. Update el spec primero:
   - Frontmatter `status: in-progress` o `review` (no cambiarlo).
   - Agregar/refinar el AC con el cambio explícito.
   - Agregar Tests T-IDs nuevos si aplica.
   - Agregar Tasks / Subtasks con prefix `N.X` / `M.X` etc.
   - Agregar Change Log entry con la phase + razón.
3. Confirmar con el usuario explícitamente: "Antes de implementar X, el spec dice Y. Quiero agregar Z al AC. ¿Apruebo el cambio al spec primero?"
4. Esperar aprobación.
5. Recién después de aprobación: aplicar cambios al spec, commit (sin push si no se pide), y proceder a la implementación de la phase.

### Triggers típicos donde el gate se dispara

- "Tengo que devolver más data del endpoint para que el frontend renderice bien" → cambio response shape sin AC update.
- "Agrego este componente para hacer el feature usable" → componente no mencionado en spec.
- "Wire este hook al store" → integración pattern no documentada.
- "Mapeo este exception a este HTTP code" → error mapping no especificado en AC.

### Anti-patterns que el gate detecta

- ❌ "Lo hago rápido y después actualizo el spec" (= terminé sin actualizar).
- ❌ "Es obvio, no hace falta documentarlo" (= drift cuando otro dev lee).
- ❌ "El advisor está GREEN, está OK" (= advisors no miden spec drift sin tycon-spec-first-checker).

### Invocación automática del advisor — `tycon-spec-first-checker`

A partir de 2026-05-13 el gate **NO es solo manual**. Antes de invocar el BMAD ejecutor, correr el advisor sobre el plan aprobado.

**Skip-condition mecánica (verificable, NO inferencia)**:
el pre-coding check se SALTEA si se cumplen LAS DOS:
1. El Step 1 de ESTA MISMA corrida cerró con **0 CRITICAL** (verificar en el log:
   `grep -il critical <repo>/.advisors/pipeline-runs/<run>/step-01*.md` → sin matches
   de findings abiertos, o el log registra el cierre limpio de la re-validación).
2. El plan aprobado NO toca archivos fuera de `files_to_create` + `files_to_modify`
   del frontmatter (comparar la lista de archivos del plan contra el frontmatter —
   diff de listas, comando concreto; si el plan agrega UN archivo no declarado → NO skip).

Razón: con la story recién validada limpia y el plan dentro del contrato de archivos,
no hay superficie de scope creep que detectar ANTES de codear — el re-check
post-implementation del Step 5 (que corre SIEMPRE) atrapa el drift real del código.
Medido en una corrida: este pre-check costó ~80K tokens (Opus) para devolver 0 findings sobre
una story validada 5 minutos antes. Anunciar el skip con la evidencia de ambas
condiciones (regla E.i: skip documentado + verificable, nunca inferido).

Si alguna condición NO se cumple, invocar como siempre:

```
Agent(
  subagent_type: "tycon-spec-first-checker",
  prompt: "Pre-coding check para Story {N.M}.

  story_path: {story_path}
  repo_path: {repo_path}
  phase: pre-coding

  Plan aprobado del Step 3 (textual o pseudo-diff):
  ---
  {approved_plan}
  ---

  Validar SPEC-C1 (endpoint REST nuevo sin AC), SPEC-C2 (componente UI nuevo sin AC),
  SPEC-C3 (cambio de response shape sin update de AC), SPEC-C4 (reinterpretación AC),
  SPEC-C5 (exception/error mapping nuevo sin AC), SPEC-C7 (hook/store action/servicio nuevo sin AC),
  SPEC-C8 (contrato de entrada nuevo o cambiado sin AC), SPEC-C9 (filtro/scoping agregado a una consulta
  sin AC), SPEC-W1 (TODO update spec en código),
  SPEC-W2 (spec menciona algo no implementado).

  Reportar findings con rule IDs del catálogo en
  ~/.claude/tycon-harness/guides/advisor-rules-catalog.md.

  Si hay CRITICAL → bloquear coding phase hasta resolución."
)
```

**Decisión post-output**:
- **0 findings** → proceder a coding phase.
- **CRITICAL findings** → pausar Step 4. Mostrar reporte al usuario. Tres caminos: (a) actualizar spec primero + re-correr, (b) override con razón en engram, (c) cancelar coding phase y volver a Step 2.
- **Solo WARNINGs** → mostrar findings, proceder con coding phase (usuario decide si frenar).

### Re-check post-implementation

Si la coding phase pasó sin pre-flight (e.g. spike, fix de runtime no planeado), Step 5 paralelo invoca `tycon-spec-first-checker` con `phase: post-implementation` sobre `modified_files` para detectar drift residual antes de commit prep.

### Referencias

- Advisor: `~/.claude/agent-skills/agents/tycon-spec-first-checker.md`.
- Reglas SPEC-C1..C5 + SPEC-W1..W2: `~/.claude/tycon-harness/guides/advisor-rules-catalog.md` (sección Spec-First Checker).
- Engram pattern `advisors/tycon-spec-first-checker` (en el proyecto de engram del arnés).

## 4.0 — ATDD scaffold (test rojo primero)

> 🔴 **Esto tiene un GATE MECÁNICO desde 2026-07-27 — ya no es sólo una instrucción.** `marker.js
> complete-step 4` **BLOQUEA** si el primer archivo de TEST tocado en la corrida es posterior al
> primero de CÓDIGO. La evidencia sale de `marker.fileEvents`, que el hook `on-edit.js` ya venía
> registrando con `{path, ts}` por edición — no hace falta que hagas nada nuevo, sólo escribir los
> tests primero de verdad.
>
> 🔴 **Y desde 2026-07-30 es además PREVENTIVO, no sólo post-mortem**: el hook `on-atdd-preedit.js`
> (PreToolUse Edit|Write) **DENIEGA en el acto** el primer Edit/Write de código de la corrida si
> todavía no se tocó ningún archivo de test — la edición no ocurre, sin importar qué skill esté
> ejecutando. Por qué: con las tareas ya implementadas antes de ningún test, el gate del cierre avisa
> cuando el trabajo ya está hecho. (El clasificador no cuenta la story `.md` bajo `specs/` como "test":
> contarla dejaba el gate del cierre verde en todas las corridas.) Escape consciente para refactors sobre
> red preexistente: `marker.js set-flag atddBypass true` (queda en `bypass.log`).
>
> **Qué NO bloquea** (calibrado para no dar falsos positivos): una story sin código (docs/specs) pasa;
> un refactor que toca código y ningún test **avisa pero pasa** (la red son los tests preexistentes);
> un marker sin `fileEvents` avisa `unknown` y pasa. Los tres casos quedan medidos en `gates.log`.
>
> **Escape consciente**: `marker.js complete-step 4 --no-atdd` — queda en `bypass.log` con el detalle.
>
> **Por qué existe**: el ATDD era la ÚNICA regla del pipeline sin gate mecánico, y por eso era la que
> se salteaba. Sin gate, escribir código y después test, tarea por tarea, sólo lo detecta una persona
> leyendo el transcript. Y un test escrito después puede no probar lo que dice: se apoya en un dato
> que el propio código ya fabricó.
> Con el test escrito primero eso es **imposible por construcción** — el dato todavía no existe.
> Implementación y calibrado: `scripts/lib/atdd-order.js`; tests: `scripts/tests/unit.test.js`.

Antes de implementar, el ejecutor genera los tests declarados en la tabla `### Tests` de la story como scaffolds, con los T-IDs/nombres del contrato AC↔test (la columna `AC` de la tabla dice qué ACs cubre cada test):

- xUnit: `[Trait("Story","N.M")]` + `[Trait("AC","n")]` por test.
- vitest/Playwright: tags literales `@story-N.M` y `@ac-n` en el título del describe/test.

Correrlos **SCOPED** (solo los archivos de test nuevos — ver `test-execution-discipline.md`) confirmando que **FALLAN**. Los dos rojos inválidos, ambos bloqueantes:

- **Falso verde (tautología)**: el test PASA en fase roja → no prueba nada → reescribirlo antes de seguir.
- **Falso rojo**: el test falla por un typo, un import roto, un compile error o una fixture ausente — no por la feature. Leer el mensaje de falla: rojo legítimo = **assertion fallida por ausencia de la feature** (o símbolo que la story declara crear y todavía no existe). Cualquier otra causa → arreglar el scaffold y re-correr hasta que el rojo sea el correcto.

Si el scaffold necesita mocks, leer antes `~/.claude/agent-skills/skills/test-driven-development/testing-anti-patterns.md` (testear el mock en vez del código real es el modo de falla #1 acá).

Recién entonces implementar hasta verde. El gate verde final pasa a ser: **los MISMOS tests que estaban rojos ahora pasan** — no otros.

**Skip-condition**: story sin tabla `### Tests` → saltear 4.0 y anunciarlo en 1 línea ("Story sin tabla ### Tests — sin scaffold ATDD; el gate de tests cae a la suite del repo").

> **Escape hatch (manual, NO automático)**: para ese caso existe el skill `bmad-testarch-atdd`, que **deriva** la estrategia de tests desde los ACs (elige nivel E2E/API/component/unit/integration/contract, arma fixtures) en vez de leerla de la tabla. No está cableado al pipeline a propósito: (a) con tabla `### Tests` es redundante — Mary ya hizo ese trabajo; (b) requiere `_bmad/tea/config.yaml` + `test_artifacts`, que hoy ningún repo TYCON tiene; (c) no conoce el contrato de T-IDs/traits `@story-N.M`/`@ac-n` que consume `tycon-ac-coverage-checker`, así que si se usa hay que agregar los traits a mano. Invocarlo sólo si el dev lo pide explícitamente.

## Acción — ejecución

Invocar el skill BMAD nuevamente, esta vez en modo ejecución (no plan):

```
Skill(
  skill: "<bmad_skill_name>",
  args: "Ejecutar el plan aprobado sobre story {story_path}. PROCEDER con la implementación. Modificar archivos según el plan. Iterar con los tests SCOPED (los scaffolds del sub-step 4.0) hasta verde y reportar resultado — la suite completa la corre el orquestador UNA vez al cierre del step (test-gate.sh). Criterio de diseño: el cambio más chico que cumple la story, sin fusionar bloques parecidos que cambian por razones distintas. Nada que la story no declare — ni excepciones, campos de respuesta, filtros ni servicios nuevos; si hace falta uno, frená y proponelo al usuario para sumarlo a la story (gate del paso 4): no lo agregues vos. Excepción: un filtro de seguridad que falte entra igual, con entrada en el Change Log. Ningún refactor más allá del que el cambio necesita; lo demás va a tasks/todo.md con formato DEF."
)
```

El skill BMAD se encarga de:
- Escribir/modificar archivos
- Ejecutar tests unitarios que correspondan
- Actualizar el Dev Agent Record del story con file list, completion notes, debug log

## Acción — build gate

Después de que BMAD termina la implementación, **antes de invocar advisors**, verificar que el código compila.

Detectar framework:

| Archivo presente en el repo | Comando de build |
|---|---|
| `*.csproj` o `*.sln` | `dotnet build` |
| `package.json` con `build` script | `npm run build` o `bun run build` |
| `package.json` sin `build` script | `tsc --noEmit` si hay `tsconfig.json` |
| No hay build definido | Skip build gate |

Correr el comando desde el repo root, vía `marker.js run-check build -- <comando>` (execFileSync sin shell/pipes — exit code REAL → `marker.checks.build`, provenance=run-check):

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js run-check build -- dotnet build
#   o: ... run-check build -- npm run build   /   ... run-check build -- npx tsc --noEmit
```

## Decisiones

- **Si build pasa OK**: proceder al cierre del step (test gate, abajo) y de ahí a Step 5 (invocar advisors sobre el código compilado).

- **Si build falla**:
  - **Pausar el pipeline**. Mostrar el output del error al usuario.
  - Preguntar al usuario: "El build falló. ¿Querés que vuelva al BMAD skill para que corrija, o revisamos manualmente?"
  - Si el usuario pide corregir → volver a invocar el skill BMAD con el error como contexto.
  - Si el usuario revisa manualmente → pausar el pipeline hasta que diga "re-run build" o similar.
  - **No proceder a Step 5 con build roto**. Los advisors de code quality corren sobre código muerto y generan ruido.

- **Si build se skipea** (no hay config): pasar al cierre del step con nota en el log.

## Cierre del Step 4 — test gate (suite + coverage UNA sola vez)

Con build verde, cerrar el step corriendo:

```bash
bash ~/.claude/agent-skills/skills/tycon-pipeline/scripts/test-gate.sh <repo_path> <story_path>
```

🔴 **Pasar la RUTA de la story, no el id**. Con la ruta, el gate
deduce solo qué proyecto testear a partir de lo que la story declara (`files_to_create` /
`files_to_modify`) y saca el id del frontmatter. Con un id no tiene de dónde deducir y, en un repo
con más de un proyecto, **frena** (ver abajo).

En una sola corrida: suite de tests + coverage, exit code REAL → `marker.checks.tests` (vía `run-check`), y escribe `<repo>/.advisors/tests-result.json` (totals + coverage por archivo NUEVO + `meets_threshold` 75% + `scope`/`scope_source`: qué proyecto se miró y quién lo decidió). **El advisor `tycon-plugin-tests-coverage` del Step 5 ya NO corre tests él mismo: LEE ese artefacto** — NO re-correr la suite después de esto (regla `test-execution-discipline.md`: suite completa máximo 1 vez).

Si test-gate reporta rojo → mismo tratamiento que build fallido: pausar, mostrar el resultado, corregir y re-correr.

**Story de dos repos**: si la story declara en `files_to_create`/`files_to_modify` archivos de un repo
hermano (`.tycon/advisors.yaml → evidence.companion_repos`; escritos relativos al hermano o con `<nombre>/` adelante),
el gate corre al terminar el mismo gate sobre ese hermano, con el alcance deducido de esos archivos. Su resultado va a
`companions` de `tests-result.json` y `all_green` dice el total; la salida es la del repo si falló, si no la del primer
hermano rojo (un repo sin pruebas con el hermano verde sale `0`), y un total rojo deja el check `tests` en rojo. La
copia sellada de evidencia es sólo la del repo de la story.

**Repos con `scripts/tests/suites.json` (el arnés):** las suites corren en paralelo (la mitad
de los núcleos; `TYCON_SUITES_MAX_WORKERS=N` lo cambia, `=1` es la serie de antes), las `exclusive` corren
solas al final, y las que declaran `gate_only_when_touching` se DIFIEREN si la story no toca esas carpetas
(hoy export-real: sólo corre si la story toca `scripts/publishing/**`). Lo diferido queda en
`tests-result.json` → `totals.deferred_suites`, con el motivo. Si el gate no puede saber qué toca la story,
corre todo. `TYCON_GATE_ALL_SUITES=1` corre todo como antes. El nocturno y el control del PR no cambian.

### 🔴 El verde de `tests` tiene que venir de ACÁ, y de la suite COMPLETA

**`marker.js complete-step 4` BLOQUEA si `checks.tests` está verde y no lo puso este gate.** O sea:
NO cerrar el step con un `run-check tests -- node --test <lista de archivos de la story>` a mano.

Por qué, medido en el cierre de una story: el check quedó verde con
**872 de 2400** tests — los que la story declaraba. La suite completa salía en **rojo con 13 fallas,
dos de la propia story que se estaba cerrando**. La diferencia entre "los tests que la story declara"
y "todos" es exactamente donde se esconden las regresiones que la story causó en otro lado. Cuesta
~2 min; aparecer todas juntas recién en el merge cuesta mucho más.

- El gate exporta `TYCON_TEST_GATE=1` → `run-check` anota `provenance=test-gate`.
- Escape consciente (el repo no tiene suite completa, o hay que cerrar igual):
  `marker.js set-check tests green --force-manual` — queda en `gates.log`.

### Salidas del gate

| exit | qué pasó | qué hacer |
|---|---|---|
| `0` | suite verde | seguir |
| `!=0` (1,2,…) | suite roja | pausar, corregir, re-correr |
| `3` | el repo no tiene stack de tests detectable | anotarlo; no hay suite que correr |
| `4` | **FRENO**: el repo tiene más de un proyecto testeable y no se pudo deducir cuál | pasar el alcance a mano: `test-gate.sh <repo> <story> <subdir>` |
| `5` | **no pude correr las pruebas**: falta el corredor (`npx`, `dotnet`, `npm`), o el shell lo ve pero no se puede lanzar. No se corrió nada (`halted: true`, `missing_tool`) | NO tocar las pruebas: instalar la herramienta o abrir la sesión con un PATH que la vea, y re-correr el gate |
| `6` | la suite salió 0 pero **no corrió ninguna prueba** (o no dejó un resumen que las cuente): no es verde | mirar `no_tests_run` en `tests-result.json`: alcance vacío, todas saltadas o `todo`, o un resumen ilegible; corregir eso y re-correr |

El `4`, el `5` y el `6` dejan además el check `tests` del marcador en **rojo** con su código: un verde de
una corrida anterior no queda en pie cuando esta corrida no pudo correr o no contó nada.

El `4` **no corre ninguna suite** y deja `tests-result.json` con `halted: true` — constancia del
freno, no de un resultado. Avisar por stderr y correr igual el stack equivocado deja una constancia
en rojo, con el id de la story puesto, de código que la story jamás tocó. Un control que avisa y sigue se aprende a ignorar,
y una constancia del proyecto equivocado es peor que ninguna porque **parece** verificación.

## Modo autónomo — registrar checks build + tests (Nivel 1)

**Esta sección corre por DEFAULT** (`marker.autonomous === true`, que es lo que PIPE-C6 deja puesto
salvo `--no-autonomous`). 🔴 **No la saltees «porque no viste el flag»**: el Stop-hook del modo
autónomo sólo mira los checks REGISTRADOS, así que un build en rojo sin su `run-check build` le
queda **invisible al portón** y el turno cierra como si todo hubiera pasado. Si la corrida es HITL
explícita (`marker.autonomous !== true`), saltear.

Tras correr el build gate **y** el test gate del cierre, los checks quedan registrados con el resultado REAL (exit code capturado, NO lo que "parece"):

```bash
# build: ground-truth vía run-check (execFileSync sin shell — exit code real → marker.checks.build=green|red:exit=N).
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js run-check build -- dotnet build
#   o: ... run-check build -- npm run build  /  ... run-check build -- npx tsc --noEmit
#   (si no hay build definido → ... set-check build green --manual — skip no-bloqueante, queda
#    logueado como provenance=manual)

# tests: los registra test-gate.sh del cierre del step (run-check interno → marker.checks.tests).
#   NO usar set-check directo para tests — set-check queda solo para excepciones con --manual.
```

🔴 **Ground-truth**: el status sale del exit code real del comando capturado por `run-check` (provenance=run-check + entry en gates.log), no del self-report del LLM (mismo principio que CF-2). Si build/tests quedan en `red:...`, el Stop-hook DoD gate va a **bloquear el cierre del turno** y forzar el loop: el agente arregla, vuelve a correr build/tests, y re-registra el check. Cuando ambos pasan a `green`, el portón deja avanzar.

## Dep-gate — dependencias nuevas no declaradas (adopción BMAD 2026-07-02)

Con build verde, ANTES de Step 5, correr el gate mecánico de dependencias nuevas. Adopta el
HALT de `bmad-dev-story` (*"new dependencies beyond story specifications → need user approval"*)
que TYCON no tenía: los advisors de seguridad atrapan un paquete **vulnerable**, no un paquete
**legítimo que nadie aprobó**.

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js dep-gate \
  --repo <repo_path> --story <story_path>
```

Diffea las dependencias AGREGADAS (`package.json` / `*.csproj` / `Directory.Packages.props`)
vs HEAD contra el texto de la story. Un paquete es **nuevo** solo si su nombre aparece en
líneas `+` pero no en `−` (filtra churn de coma y bumps de versión). "Declarado" = el nombre
del paquete aparece textualmente en la story (match conservador, verificable — no inferencia).

**Decisión post-output**:
- **`gate: pass`** (exit 0) → proceder a Step 5.
- **`gate: skip`** (repo sin git) → proceder, anotarlo en el log.
- **`gate: pause`** (exit 2, hay `undeclared[]`) → **PAUSAR**. Mostrar la lista al user:
  *"La implementación agregó estas dependencias no declaradas en la story: {undeclared}.
  ¿Las aprobás? Si sí, las agrego al spec antes del commit."* Tres caminos: (a) aprobar +
  agregar al spec (frontmatter/AC) y re-correr, (b) override consciente si es falso positivo
  (paquete mencionado con otro nombre) anotándolo, (c) revertir la dependencia.

**Skip-condition** (verificable, no inferencia — regla E.i): el gate devuelve `skip` solo si el
repo no tiene git o `git diff HEAD` falla. NO se saltea "porque parece que no agregó nada" —
si no agregó nada, el propio comando devuelve `pass` con `new_deps: []`.

## 🔀 Lanzamiento TEMPRANO del pase adversarial 5b (Fase B paralelización, 2026-07-30 — DEFAULT ON)

**Prendido por defecto**, con las mitigaciones ya
cableadas (cap 2 de ventana en Step 5, skeptics en chunks de 3, candado anti-full-suite en los
hunters). Kill-switch: `export TYCON_5B_EARLY=0` → lanzamiento clásico en step-05b. El switch es
MECÁNICO: `deep-review-gate` lee la env y devuelve **`early_launch: true|false`** en su JSON.
**`early_launch: false` → saltear esta sección entera.** 🔴 **La primera corrida NORMAL con esto
activo ES la corrida de medición**: contar procesos pesados simultáneos (no solo cronometrar) y
con eso ajustar el cap 2 del Step 5 — si la máquina sufre, `TYCON_5B_EARLY=0` y se recalibra.

**Precondiciones duras, en este orden** (cada una puede cambiar el diff o frenar — lanzar antes
de resolverlas quema el único lanzamiento sobre un diff que va a cambiar):
build verde → `test-gate.sh` verde → `dep-gate` resuelto (es una PAUSA HITL: si el dev revierte
una dependencia, el diff cambia) → **`marker.js complete-step 4` VERDE** (su gate ATDD puede
bloquear y forzar más edits — el mismo comando que el `note` de `pipeline.js next` pide; corrido
acá, `next` sigue coherente). **Solo con los CUATRO resueltos, lanzar.**

1. Evaluar el gate: `pipeline.js deep-review-gate --repo <r> --story <s> --files <archivos de
   código del diff>`. **`run: false`** → anunciar el skip en 1 línea y anotarlo con
   `node .../scripts/marker.js mark-adversarial-skipped --files <los mismos archivos>`: el comando le
   vuelve a preguntar al portón y sólo anota si el portón dice que no corre (salteo + cierre del 5b en
   una sola escritura, línea `adversarial-skip` en `gates.log`). Dejar además el `reason` en
   `<RUN_DIR>/step-05b-adversarial.md` (el step-05b no se alcanza — `next` lo da por atendido; es el
   no-op esperado). 🔴 La bandera del 5b no se escribe a mano, y `complete-step 8`
   frena sin esta constancia. **`run: true` + `early_launch: true`** → seguir.
2. Si el gate devuelve `fable_upsell` → hacer la pregunta de 1 línea AHORA (ver step-05b) antes
   de lanzar.
3. 🔴 **Validar `files` NO vacío y de CÓDIGO antes de invocar**: si la lista quedó vacía o mal
   armada, el workflow retorna un no-op instantáneo y el lanzamiento se quema (el guard bloquea
   relanzar sin `--relaunch`). La lista debe ser **EXACTAMENTE la misma que después se pasa a
   `pipeline.js advisors` en el Step 5** — si divergen, el 5b audita otro diff que los advisors,
   en silencio.
4. Invocar la tool `Workflow` (args idénticos a step-05b §Acción — incluido `runDir`, el RUN_DIR
   de esta corrida: sin él las pruebas que confirman los hallazgos caen en una carpeta genérica) e
   **INMEDIATAMENTE después
   (mismo turno)** registrar el estado con el runId que devolvió la tool:
   ```bash
   node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js mark-adversarial-launched <runId> 4
   ```
   Sin este registro, un retome de sesión no puede detectar el workflow huérfano y el join de
   step-05b se rompe. Exit 2 = ya se lanzó en esta sesión (guard). Relanzamiento LEGÍTIMO (no-op
   por files vacío, diff stale): repetir con `--relaunch` — queda auditado en `bypass.log`.
5. **Cancelación del pipeline con el 5b en vuelo**: intentar `TaskStop` sobre el task del
   Workflow. ⚠️ No está verificado que `TaskStop` cancele Workflows — si no lo cancela, anotar en
   el log "workflow huérfano, termina solo y su resultado se descarta" y seguir con la
   cancelación normal (no es bloqueante).

**Consecuencia para el Step 5** (ver step-05 §Cap reducido): mientras el workflow esté en vuelo,
la ventana de advisors baja a ≤2 (el workflow son 6 hunters + skeptics en chunks de 3, no 1
proceso).

**Riesgo asumido — multi-sesión**: PIPE-C0 detecta conflicto de STORY, no de recursos; no hay
cap cross-sesión (mecanismo nuevo, fuera de alcance). Regla operativa mientras tanto: **no correr
dos pipelines con 5b temprano a la vez en la misma máquina** — si ya hay otro pipeline activo
(`marker.js list-all`), exportar `TYCON_5B_EARLY=0` en esta corrida. Y si el otro pipeline corre
sobre el MISMO repo, el cap no alcanza: **un worktree por story** (working tree compartido =
`git diff HEAD` contaminado + `.advisors/tests-result.json` pisado) — ver PIPE-C0 §Stories
distintas en paralelo y `~/.claude/tycon-harness/guides/git-worktrees.md`.

## Output de este step

- `build_status: ok | failed | skipped`
- Log del build (si ran)
- Lista de archivos modificados por BMAD (diff git)
- `<repo>/.advisors/tests-result.json` (artefacto de test-gate.sh — lo consume el Step 5)

Pasar al Step 5 si `build_status != failed` y `marker.checks.tests` quedó green (o el test gate se skipeó por no haber suite — anotarlo en el log).
