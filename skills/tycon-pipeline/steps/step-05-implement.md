# Implementar

**Objetivo**: el skill BMAD elegido en «Armar el plan» ejecuta el plan aprobado en «Aprobar el plan». Después se corre el
build para verificar que el código compila. Cierra con `marker.js complete-step implement`, que aplica el freno ATDD
(pruebas antes que código). Las pruebas y el resto del cierre siguen en `step-06-run-tests.md`.

## Inputs

- `approved_plan` de «Aprobar el plan»
- `bmad_skill_name` de «Armar el plan»

> 💡 **Herramientas de código (2026-07-06)**: durante TODA la implementación, para buscar símbolos, llamadores e
> impacto usá las tools de code-intel disponibles (`mcp__codegraph__*`, `mcp__codebase_memory__*`; o sus CLIs vía Bash
> si el MCP no levantó; ver `step-03-plan.md` §«Herramientas de código disponibles» y PIPE-C9 en `step-01-start.md`) en
> vez de grep manual. Si una tool esperada FALLA a mitad del paso → 1 línea de aviso a la persona antes de degradar
> (regla TOOL.i), nunca en silencio.

## 🔴 PRE-IMPLEMENTATION GATE (Spec-First Enforcement)

**OBLIGATORIO antes de invocar BMAD execute o cualquier sesión de código de una fase posterior (L, M, N, etc.)**.

Disparador del gate: cualquier momento en que el dev decida implementar un cambio que no se discutió al aprobar el plan
(típicamente «fase L de cableado», «fase M de arreglos», «fase N de agregados» descubiertos durante el humo en
ejecución).

### Checklist forzado — responder explícitamente ANTES de codear

Para cada cambio propuesto en la fase, el ejecutor (el agente o el dev) debe responder:

1. **¿El spec describe LITERALMENTE lo que voy a implementar?** (no inferencia, literal en el texto del AC)
2. **¿Estoy cambiando un response shape / añadiendo endpoint / componente / cableado no especificado?**
3. **¿Estoy reinterpretando un AC para incluir algo que el AC no dice?**

Si **CUALQUIER** respuesta es «sí, pero…», «está implícito» o «es obvio» → **PAUSA**.

### Acción cuando se dispara la pausa

1. NO empezar a editar archivos de código.
2. Actualizar el spec primero:
   - Frontmatter `status: in-progress` o `review` (no cambiarlo).
   - Agregar/refinar el AC con el cambio explícito.
   - Agregar T-IDs de Tests nuevos si aplica.
   - Agregar Tasks / Subtasks con prefijo `N.X` / `M.X` etc.
   - Agregar una entrada de Change Log con la fase y la razón.
3. Confirmar con la persona explícitamente: «Antes de implementar X, el spec dice Y. Quiero agregar Z al AC. ¿Apruebo el
   cambio al spec primero?»
4. Esperar aprobación.
5. Recién después: aplicar los cambios al spec, commit (sin push si no se pide), y seguir con la implementación de la
   fase.

### Triggers típicos donde el gate se dispara

- «Tengo que devolver más datos del endpoint para que el frontend renderice bien» → cambio de response shape sin
  actualizar el AC.
- «Agrego este componente para que el feature sea usable» → componente no mencionado en el spec.
- «Cableo este hook al store» → patrón de integración no documentado.
- «Mapeo esta excepción a este código HTTP» → mapeo de errores no especificado en un AC.

### Anti-patterns que el gate detecta

- ❌ «Lo hago rápido y después actualizo el spec» (= terminé sin actualizar).
- ❌ «Es obvio, no hace falta documentarlo» (= deriva cuando otro dev lee).
- ❌ «El revisor está en verde, está OK» (los revisores no miden deriva del spec sin `tycon-spec-first-checker`).

### Invocación automática del revisor — `tycon-spec-first-checker`

A partir de 2026-05-13 el gate **NO es solo manual**. Antes de invocar el ejecutor BMAD, correr el revisor sobre el plan
aprobado.

**Condición de salteo mecánica (verificable, NO inferencia)**: el chequeo previo al código se SALTEA si se cumplen LAS
DOS:
1. «Validar la historia» de ESTA MISMA ejecución cerró con **0 CRITICAL** (verificar en el log:
   `grep -il critical <repo>/.advisors/pipeline-runs/<run>/step-01-validator*.md` → sin coincidencias de hallazgos abiertos, o el
   log registra el cierre limpio de la re-validación).
2. El plan aprobado NO toca archivos fuera de `files_to_create` + `files_to_modify` del frontmatter (comparar la lista
   de archivos del plan contra el frontmatter, diff de listas, comando concreto; si el plan agrega UN archivo no
   declarado → NO se saltea).

Razón: con la story recién validada limpia y el plan dentro del contrato de archivos, no hay superficie de scope creep
que detectar ANTES de codear; el re-chequeo posterior a la implementación en «Revisores» (que corre SIEMPRE) atrapa la
deriva real del código. Medido en una ejecución: este chequeo previo costó ~80K tokens (Opus) para devolver 0 hallazgos
sobre una story validada 5 minutos antes. Anunciar el salteo con la evidencia de ambas condiciones (regla E.i: salteo
documentado + verificable, nunca inferido).

Si alguna condición NO se cumple, invocar como siempre:

```
Agent(
  subagent_type: "tycon-spec-first-checker",
  prompt: "Pre-coding check para Story {N.M}.

  story_path: {story_path}
  repo_path: {repo_path}
  phase: pre-coding

  Plan aprobado de «Aprobar el plan» (textual o pseudo-diff):
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
- **0 hallazgos** → seguir con la fase de código.
- **Hallazgos CRITICAL** → pausar «Implementar». Mostrar el reporte a la persona. Tres caminos: (a) actualizar el spec
  primero + re-correr, (b) override con razón en engram, (c) cancelar la fase de código y volver a «Armar el plan».
- **Solo WARNINGs** → mostrar los hallazgos y seguir con la fase de código (la persona decide si frena).

### Re-chequeo posterior a la implementación

Si la fase de código pasó sin chequeo previo (por ejemplo un spike o un arreglo en ejecución no planeado), «Revisores»
(`step-07-reviewers.md`) invoca en paralelo `tycon-spec-first-checker` con `phase: post-implementation` sobre
`modified_files` para detectar deriva residual antes de preparar el commit.

### Referencias

- Revisor: `~/.claude/agent-skills/agents/tycon-spec-first-checker.md`.
- Reglas SPEC-C1..C5 + SPEC-W1..W2: `~/.claude/tycon-harness/guides/advisor-rules-catalog.md` (sección Spec-First Checker).
- Patrón de engram `advisors/tycon-spec-first-checker` (en el proyecto de engram del arnés).

## 4.0 — ATDD scaffold (test rojo primero)

> 🔴 **Esto tiene un GATE MECÁNICO desde 2026-07-27, ya no es sólo una instrucción.** `marker.js complete-step
> implement` **BLOQUEA** si el primer archivo de TEST tocado en la ejecución es posterior al primero de CÓDIGO. La
> evidencia sale de `marker.fileEvents`, que el hook `on-edit.js` ya venía registrando con `{path, ts}` por edición: no
> hace falta que hagas nada nuevo, sólo escribir los tests primero de verdad.
>
> 🔴 **Y desde 2026-07-30 es además PREVENTIVO, no sólo post-mortem**: el hook `on-atdd-preedit.js` (PreToolUse
> Edit|Write) **DENIEGA en el acto** el primer Edit/Write de código de la ejecución si todavía no se tocó ningún archivo
> de test: la edición no ocurre, sin importar qué skill esté ejecutando. Por qué: con las tareas ya implementadas antes
> de ningún test, el gate del cierre avisa cuando el trabajo ya está hecho. (El clasificador no cuenta la story `.md`
> bajo `specs/` como «test»: contarla dejaba el gate del cierre verde en todas las ejecuciones.) Escape consciente para
> refactors sobre red preexistente: `marker.js set-flag atddBypass true --reason "<por qué>"` (sin motivo se niega; el
> motivo queda en `bypass.log`). Un guion de medición de `tasks/measurement-<algo>/` que la story no declara no cuenta
> como código, y uno de `scripts/ci/pruebas/` o `scripts/ci/tests/` cuenta como prueba.
>
> **Qué NO bloquea** (calibrado para no dar falsos positivos): una story sin código (docs/specs) pasa; un refactor que
> toca código y ningún test **avisa pero pasa** (la red son los tests preexistentes); un marcador sin `fileEvents`
> avisa `unknown` y pasa. Los tres casos quedan medidos en `gates.log`.
>
> **Escape consciente**: `marker.js complete-step implement --no-atdd --reason "<por qué>"` — queda en `bypass.log` con
> el detalle y el motivo.
>
> **Por qué existe**: el ATDD era la ÚNICA regla del pipeline sin gate mecánico, y por eso era la que se salteaba. Sin
> gate, escribir código y después test, tarea por tarea, sólo lo detecta una persona leyendo el transcript. Y un test
> escrito después puede no probar lo que dice: se apoya en un dato que el propio código ya fabricó. Con el test escrito
> primero eso es **imposible por construcción**: el dato todavía no existe. Implementación y calibrado:
> `scripts/lib/atdd-order.js`; tests: `scripts/tests/unit.test.js`.

Antes de implementar, el ejecutor genera los tests declarados en la tabla `### Tests` de la story como scaffolds, con
los T-IDs/nombres del contrato AC↔test (la columna `AC` de la tabla dice qué ACs cubre cada test):

- xUnit: `[Trait("Story","N.M")]` + `[Trait("AC","n")]` por test.
- vitest/Playwright: tags literales `@story-N.M` y `@ac-n` en el título del describe/test.

Correrlos **SCOPED** (solo los archivos de test nuevos; ver `test-execution-discipline.md`) confirmando que **FALLAN**.
Los dos rojos inválidos, ambos bloqueantes:

- **Falso verde (tautología)**: el test PASA en fase roja → no prueba nada → reescribirlo antes de seguir.
- **Falso rojo**: el test falla por un typo, un import roto, un error de compilación o una fixture ausente, no por la
  feature. Leer el mensaje de falla: rojo legítimo = **assertion fallida por ausencia de la feature** (o símbolo que la
  story declara crear y todavía no existe). Cualquier otra causa → arreglar el scaffold y re-correr hasta que el rojo
  sea el correcto.

Si el scaffold necesita mocks, leer antes `~/.claude/agent-skills/skills/test-driven-development/testing-anti-patterns.md`
(testear el mock en vez del código real es el modo de falla #1 acá).

Recién entonces implementar hasta verde. El gate verde final pasa a ser: **los MISMOS tests que estaban rojos ahora
pasan**, no otros.

**Condición de salteo**: story sin tabla `### Tests` → saltear 4.0 y anunciarlo en 1 línea («Story sin tabla ### Tests
— sin scaffold ATDD; el gate de tests cae a la suite del repo»).

> **Escape hatch (manual, NO automático)**: para ese caso existe el skill `bmad-testarch-atdd`, que **deriva** la
> estrategia de tests desde los ACs (elige nivel E2E/API/component/unit/integration/contract, arma fixtures) en vez de
> leerla de la tabla. No está cableado al pipeline a propósito: (a) con tabla `### Tests` es redundante, Mary ya hizo
> ese trabajo; (b) requiere `_bmad/tea/config.yaml` + `test_artifacts`, que hoy ningún repo TYCON tiene; (c) no conoce
> el contrato de T-IDs/traits `@story-N.M`/`@ac-n` que consume `tycon-ac-coverage-checker`, así que si se usa hay que
> agregar los traits a mano. Invocarlo sólo si el dev lo pide explícitamente.

## Ejecución liviana — las tandas van juntas

Si el marcador dice `size: liviana` (`pipeline.js next` lo recuerda en la nota), las tandas de la story se hacen en UNA
sola implementación y una sola vuelta de pruebas: no se corta por tanda. Qué pruebas corre y qué difiere el portón en
ese caso: `step-06-run-tests.md`.

## Acción — ejecución

Invocar el skill BMAD nuevamente, esta vez en modo ejecución (no plan):

```
Skill(
  skill: "<bmad_skill_name>",
  args: "Ejecutar el plan aprobado sobre story {story_path}. PROCEDER con la implementación. Modificar archivos según el plan. Iterar con los tests SCOPED (los scaffolds de las pruebas primero) hasta verde y reportar resultado — la suite completa la corre el orquestador UNA vez, en «Correr las pruebas» (test-gate.sh). Criterio de diseño: el cambio más chico que cumple la story, sin fusionar bloques parecidos que cambian por razones distintas. Nada que la story no declare — ni excepciones, campos de respuesta, filtros ni servicios nuevos; si hace falta uno, frená y proponelo al usuario para sumarlo a la story (gate de «Implementar»): no lo agregues vos. Excepción: un filtro de seguridad que falte entra igual, con entrada en el Change Log. Ningún refactor más allá del que el cambio necesita; lo demás va a tasks/todo.md con formato DEF."
)
```

El skill BMAD se encarga de:
- Escribir/modificar archivos
- Ejecutar tests unitarios que correspondan
- Actualizar el Dev Agent Record del story con file list, completion notes, debug log

**Con una maqueta aprobada** (story con pantalla, «Aprobar el plan»): la maqueta fija el contenido y los estados, no la
forma de presentarlos. La forma sale de la story y de la guía del stack del producto. Donde la maqueta marca una capa
(`presentation: "layer"`, «Se abre encima de … con …»), **se construye como capa**, que se abre con ese botón o enlace y
tiene `role="dialog"` o `aria-modal="true"`. Sólo la contradice una story que diga literalmente
«en la página» o «no modal», y entonces la maqueta se corrige y se aprueba de nuevo antes de construir. Palabras como
«panel» o «sección» no la contradicen. Donde no marca nada, la story y la guía dicen si va en la página o encima. Agregá esto a los `args`
del skill cuando la story tiene maqueta.

## Si la historia termina por su salida prevista

Algunas historias traen una salida escrita («si no se puede, queda como deuda»): una dependencia sin versión
compatible, un servicio externo que no está. Cuando se activa, la ejecución no se apaga ni se cierra a medias: se
cierra como deuda y **sigue hasta el commit**.

1. Anotar la deuda en el Dev Agent Record de la historia, con un id `DEF-…` y lo que quedó pendiente (o en
   `tasks/todo.md` del repo de la historia, si lo tiene).
2. Explicarle a la persona qué no se pudo hacer y por qué: el freno de seguridad le pide el permiso en la ventana de
   permiso al correr el paso siguiente (regla ESC-C4).
3. `node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js close-as-debt --reason "<qué quedó pendiente>" --debt <DEF-id>`.
4. Las pruebas: primero, ajustarlas para que verifiquen la deuda mantenida y documentada (verde normal). Sólo si no se
   puede, con el mismo permiso: `marker.js expect-red <control> --tests <T2,T5>`, que registra el rojo como esperado.
5. Seguir el pipeline: los revisores corren sobre lo que sí cambió (pruebas, historia, documentación), el pase
   adversarial con su regla de siempre, y «Preparar el commit» pone la línea `Deuda: <DEF-id> — <motivo>`.

Apagar el modo autónomo o cerrar la ejecución no es una salida: deja la historia como si hubiera terminado, sin deuda.

## Acción — build gate

Después de que BMAD termina la implementación, **antes de invocar a los revisores**, verificar que el código compila.

Detectar framework:

| Archivo presente en el repo | Comando de build |
|---|---|
| `*.csproj` o `*.sln` | `dotnet build` |
| `package.json` con script `build` | `npm run build` o `bun run build` |
| `package.json` sin script `build` | `tsc --noEmit` si hay `tsconfig.json` |
| No hay build definido | Saltear el build gate |

Correr el comando desde la raíz del repo, vía `marker.js run-check build -- <comando>` (execFileSync sin shell/pipes:
exit code REAL → `marker.checks.build`, provenance=run-check):

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js run-check build -- dotnet build
#   o: ... run-check build -- npm run build   /   ... run-check build -- npx tsc --noEmit
```

En modo autónomo (el default) este `run-check` es lo que hace visible el build en rojo para el portón del Stop-hook:
no se saltea (detalle en `step-06-run-tests.md` §«Modo autónomo»).

## Decisiones

- **Si el build pasa OK**: cerrar el paso (abajo) y seguir con «Correr las pruebas» (`step-06-run-tests.md`).

- **Si el build falla**:
  - **Pausar el pipeline**. Mostrar el error a la persona.
  - Preguntar: «El build falló. ¿Querés que vuelva al skill BMAD para que corrija, o revisamos manualmente?»
  - Si pide corregir → volver a invocar el skill BMAD con el error como contexto.
  - Si revisa manualmente → pausar el pipeline hasta que diga «re-run build» o similar.
  - **No seguir con el build roto**. Los revisores de calidad de código corren sobre código muerto y generan ruido.

- **Si el build se saltea** (no hay configuración): cerrar el paso con una nota en el log.

## Cerrar el paso

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js complete-step implement
```

Aplica el freno ATDD (ver 4.0). Para el escape consciente, `--no-atdd`.

## Output de este paso

- `build_status: ok | failed | skipped`
- Log del build (si corrió)
- Lista de archivos modificados por BMAD (diff git)

Seguir con «Correr las pruebas» (`step-06-run-tests.md`) si `build_status != failed`.
