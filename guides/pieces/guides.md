# Las guías, los paquetes y la configuración

Las fichas de este grupo de [las piezas del arnés](../harness-pieces.md). Cada una dice **qué es** la pieza,
**por qué existe**, **quién la usa** y **dónde se prueba**. El detalle de cada pieza está en
[la guía de detalle](../maintaining/pieces-in-detail.md), bajo el mismo título.

## guides/harness-pieces.md

**Qué es:** El índice de las piezas del arnés: dónde vive cada cosa y, por grupo, la lista de las piezas. Las fichas están en `guides/pieces/<grupo>.md`.

**Por qué existe:** El README se importa entero en cada sesión y en cada revisor; con las fichas adentro era enorme, y casi nadie las usaba. Acá viven completas y el README quedó como índice. Partida por grupos, cada archivo tiene su tope y la ficha nueva siempre entra.

**Quién la usa:** Quien busca el detalle de una pieza; el pre-commit sostiene el par índice y guía con `claude-md-blocks/budget.json`.

**Dónde se prueba:** `scripts/tests/pieces-cards.test.js`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidesharness-piecesmd)

## guides/what-the-harness-does.md

**Qué es:** El recorrido del arnés entero: qué se activa en cada momento de un día de trabajo y por qué existe.

**Por qué existe:** El README lista piezas ordenadas por archivo y sirve para buscar, no para contar. Sin el recorrido escrito, nadie podía explicar el arnés en detalle.

**Quién la usa:** Quien quiere entender o explicar el arnés; trae tres guiones listos para decir en voz alta.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guideswhat-the-harness-doesmd)

## artifacts/mapa-arnes.html

**Qué es:** El mapa visual del arnés en bloques: entrada del trabajo, etapas en orden, quién vigila a los controles y lo que corre sin el dev. Tiene una versión pública que se genera sola.

**Por qué existe:** Un censo exige que toda pieza esté citada en una ficha o declarada en `fuera-del-mapa.json` con su motivo, así el mapa no se desactualiza.

**Quién la usa:** Quien necesita ver dónde corre y en qué archivo vive un componente; el pre-commit regenera la versión pública.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#artifactsmapa-arneshtml)

## story-format.md

**Qué es:** El formato Mary+GOLD para escribir stories implementables sin ambigüedad, con entregas en tandas y vínculos entre stories de seguimiento.

**Por qué existe:** Una story ambigua se implementa mal. El formato fija qué lleva y cómo se enlazan las que corrigen a otra.

**Quién la usa:** Quien crea, valida o implementa stories.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#story-formatmd)

## guides/integrations/engram-workflow.md

**Qué es:** La guía de setup, la regla del nombre de proyecto y el ciclo de sesión con la memoria persistente engram.

**Por qué existe:** La memoria sólo sirve si se guarda con el proyecto correcto y en el momento justo.

**Quién la usa:** Quien usa engram, si la integración está prendida.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidesintegrationsengram-workflowmd)

## guides/git-commit-conventions.md

**Qué es:** La guía de commits: en una ejecución la persona aprueba el pull request, no el commit; fuera de una, nada sin consentimiento; formato HEREDOC, línea Co-Authored-By y `/tycon-merge-to-main`.

**Por qué existe:** Un commit sin permiso o mal armado ensucia la historia compartida.

**Quién la usa:** Quien hace commit, push o merge, persona o agente.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidesgit-commit-conventionsmd)

## guides/workflow-orchestration.md

**Qué es:** La guía de las seis reglas de workflow, los principios, la estructura de `tasks/` y la integración de BMAD con los revisores.

**Por qué existe:** Un cambio no trivial sin plan se desvía; la guía fija cómo planificar y registrar.

**Quién la usa:** Quien planifica cambios no triviales.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidesworkflow-orchestrationmd)

## packs/bizuit/guides/bizuit-plugin-dotnet.md

**Qué es:** La guía del stack .NET para plugins Bizuit: `IBackendPlugin`, `SafeQueryBuilder`, transacciones y orquestador. Es del paquete bizuit, que viaja con el perfil del equipo.

**Por qué existe:** Para que todos escriban igual.

**Quién la usa:** Quien escribe o revisa backend .NET de plugins Bizuit.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md)

## packs/bizuit/guides/bizuit-plugin-react.md

**Qué es:** La guía del stack React/TS para plugins Bizuit: límites de Tailwind en producción, inputs `text-gray-900`, patrón fijo de modales, iconos, autenticación Bearer del SDK y pruebas con vitest. Es del paquete bizuit.

**Por qué existe:** Para que todos escriban igual.

**Quién la usa:** Quien escribe o revisa frontend React de plugins Bizuit.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md)

## packs/bizuit/guides/bizuit-plugin-nextjs.md

**Qué es:** La guía del stack Next.js (App Router) para plugins Bizuit: frontera servidor/cliente, carga de datos, API de metadata, Server Actions con validación, variables de entorno, Route Handlers y seguridad de hidratación. Es del paquete bizuit.

**Por qué existe:** Para que todos escriban igual.

**Quién la usa:** Quien escribe o revisa frontend Next.js de plugins Bizuit.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md)

## packs/bizuit/guides/bizuit-bpmn-spec-contract.md

**Qué es:** La guía del contrato de las specs de proceso BPMN de BIZUIT: se escriben con la herramienta del producto (`write_spec`), no con el editor de archivos. Es del paquete bizuit.

**Por qué existe:** Escribir el archivo directo es peor que escribirlo mal: un documento sin tabla de reglas no da error, da silencio, y «0 hallazgos» se lee como «salió limpio». Un control que hay que acordarse de invocar no corre.

**Quién la usa:** Quien escribe o revisa la spec de un proceso BPMN.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md)

## guides/agent-architecture.md

**Qué es:** La guía de la arquitectura de revisores TYCON: envoltorios sobre BMAD con pipeline con humano en el circuito, niveles de severidad, modo sombra y tablero.

**Por qué existe:** Sin una arquitectura común, cada revisor se define a su manera.

**Quién la usa:** Quien invoca revisores o integra BMAD.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidesagent-architecturemd)

## packs/ (agent-skills) — paquetes de revisores

_`packs/<paquete>/pack.json` (en el perfil del equipo) · `skills/tycon-pipeline/scripts/lib/packs.js` · `pipeline.js validators` · `scripts/lib/installed-packs.js` (arnés) · `guides/agent-architecture.md` §«Paquetes de revisores»_

**Qué es:** Los paquetes de revisores: los de un producto o cliente viven en manifiestos `pack.json` con vocabulario cerrado, no en el código del pipeline.

**Por qué existe:** Un revisor que deja de correr no da error, da menos hallazgos. Un manifiesto malo frena con motivo y nunca degrada a «sin ese paquete».

**Quién la usa:** `pipeline.js` (`advisors`, `validators`), `harness-audit.js` e `instinct-draft.js`.

**Dónde se prueba:** `tycon-pipeline/scripts/tests/packs.test.js`, `package-equivalence.test.js`, `scripts/tests/installed-packs.test.js`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#packs-agent-skills--paquetes-de-revisores)

## scripts/lib/tycon-config.js + team-profile.json — la configuración del arnés

_`scripts/lib/tycon-config.js` · el perfil · `~/.claude/tycon.json` · el enlace `~/.claude/tycon-harness` · más, en el detalle_

**Qué es:** La configuración del arnés en una cadena: entorno, `~/.claude/tycon.json`, perfil del equipo, apagado.

**Por qué existe:** Con valores fijos de máquina y organización, el arnés no se instalaba afuera. Un archivo ilegible frena con motivo y no se lee como «todo apagado».

**Quién la usa:** Los hooks, el instalador y los comandos del arnés.

**Dónde se prueba:** `scripts/tests/tycon-config.test.js`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptslibtycon-configjs--team-profilejson--la-configuración-del-arnés)

## guides/reviewer-rules.md

**Qué es:** La sección `## Reglas para revisores` del `CLAUDE.md` de cada repo, que `pipeline.js` recorta y pega al principio del contexto de cada revisor.

**Por qué existe:** Con el `CLAUDE.md` entero el revisor ve la regla pero no la controla; con sólo la sección la detecta mucho mejor y gasta menos.

**Quién la usa:** `pipeline.js advisors` y los revisores del paso 5; el pre-commit avisa (sin frenar) de líneas nuevas fuera de la sección con `scripts/ci/reviewer-rules.js`.

**Dónde se prueba:** `tycon-pipeline/scripts/tests/reviewer-rules.test.js`, `scripts/tests/reviewer-rules.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidesreviewer-rulesmd)

## guides/maintaining/bmad-contract.md

**Qué es:** El contrato de entradas y salidas entre los revisores TYCON y las skills BMAD.

**Por qué existe:** Al actualizar BMAD hace falta un mapa para detectar cambios que rompen a los revisores.

**Quién la usa:** Quien actualiza BMAD.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidesmaintainingbmad-contractmd)

## guides/advisor-rules-catalog.md

**Qué es:** El catálogo maestro de reglas de revisores, con identificadores estables (por ejemplo `SEC-C1`, `DOTNET-W3`).

**Por qué existe:** Cada hallazgo cita su identificador, así se puede explicar, agregar o retirar una regla.

**Quién la usa:** Los revisores y quien quiere saber por qué uno reportó algo.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidesadvisor-rules-catalogmd)

## guides/accov-governance-protocol.md

**Qué es:** El protocolo de cierre de story (`ACCOV-C7` a `ACCOV-C10`): autoauditoría, meta-auditoría, convergencia y prohibición del checklist manual.

**Por qué existe:** Cerrar una story sin verificar cada criterio deja huecos invisibles.

**Quién la usa:** El orquestador del pipeline, al pasar una story a `review` o `done`.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidesaccov-governance-protocolmd)

## guides/guide-update-proposals.md

**Qué es:** El buzón de propuestas de cambio a guías y catálogo que genera `tycon-retrospective-capturer`.

**Por qué existe:** Ningún cambio a una guía se aplica sin OK del dev; al aplicarlo se marca como implementado y no se borra, para dejar rastro.

**Quién la usa:** El dev que revisa y aprueba propuestas.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidesguide-update-proposalsmd)

## packs/bizuit/guides/dotnet-hooks.md

**Qué es:** Un bloque de hooks de `.claude/settings.json` para proyectos .NET TYCON: bloquea migraciones SQL ya commiteadas y corre `dotnet format` sobre los `.cs`. Es del paquete bizuit.

**Por qué existe:** Una migración ya commiteada no se debe editar, y el formato debe ser parejo.

**Quién la usa:** Quien configura un proyecto .NET TYCON (se copia y pega).

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md)

## guides/definition-of-done.md

**Qué es:** La guía de la definición de terminado: el portón obligatorio para pasar una story de `review` a `done`, con humo de endpoints reales, E2E que falla fuerte y verificación cruzada.

**Por qué existe:** Que el build esté verde no alcanza para saber que la feature anda.

**Quién la usa:** Quien cierra una story.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidesdefinition-of-donemd)

## guides/test-execution-discipline.md

**Qué es:** La guía de cómo correr tests sin congelar la máquina: sólo el archivo tocado al iterar, la suite completa en el portón del merge, y el tope `maxWorkers: '50%'` en `vitest.config`.

**Por qué existe:** La suite completa en una máquina chica la deja sin memoria y congela al dev.

**Quién la usa:** Cualquiera que corra tests, persona o agente.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidestest-execution-disciplinemd)

## guides/git-worktrees.md

_(guides/git-worktrees.md + scripts/tools/tycon-worktree.sh)_

**Qué es:** La guía de git worktrees: un worktree por story en paralelo, un worktree de merge persistente y aislamiento de agentes que escriben en paralelo. Nombre obligatorio `<RepoName>--wt-<slug>`.

**Por qué existe:** Compartir un árbol de trabajo contamina el diff de los revisores y pisa resultados; el worktree evita congelar el árbol del dev.

**Quién la usa:** Quien corre dos pipelines en el mismo repo o mergea sin congelar su árbol.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#guidesgit-worktreesmd)
