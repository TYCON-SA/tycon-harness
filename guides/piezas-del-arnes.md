# Las piezas del arnés

Cada ficha dice, en pocas líneas, **qué es** la pieza, **por qué existe**, **quién la usa** y **dónde se prueba**,
con su guía si la tiene. Los títulos `## <ruta>` son las piezas: se buscan por nombre.
El detalle de cada pieza (cómo se calibra, qué mide, su red de pruebas) está en
[la guía de detalle](maintaining/piezas-en-detalle.md), bajo el mismo título; el porqué de cada línea, en la cabecera del código.

## Dónde vive cada cosa

El árbol del arnés como está hoy, con la ruta entera de cada carpeta.

```
INDEX.md · README.md · README.es.md · INSTALL.md · story-format.md · engram-version · team-profile.json
scripts/install-tycon-hooks.sh · .ps1   los llama la línea de arranque de cada máquina
scripts/setup/              instalar y mantener cada máquina al día
scripts/hooks/              lo que registra el instalador + los dos hooks globales de git — plano
scripts/ci/                 controles de commit y de pull request (los productos la copian entera)
scripts/nightly/            lo que corre en Azure sin nadie:
  scripts/nightly/dashboard/ · scripts/nightly/dependencies/ · scripts/nightly/open-prs/ · scripts/nightly/watcher/
scripts/instincts/          el minado de instintos: lo dispara un hook de arranque, no la noche
scripts/tools/              a mano: auditorías y utilidades
  scripts/tools/harness-map/     el mapa del arnés
scripts/lib/                bibliotecas + lo que llaman dos etapas o más
scripts/controls-bench/ · scripts/metrics/ · scripts/production/ · scripts/publishing/ · scripts/tests/
guides/                     las guías para usar el arnés
  guides/integrations/       las integraciones opcionales (Azure DevOps, Clockify, CodeGraph, engram, instintos)
  guides/maintaining/        las de quien mantiene el arnés
claude-md-blocks/ · commands/ · adapters/ · build/
mods/harness-mods/          los mods de Claude Code del arnés (el cartel de la corrida, /pipeline, /mods)
pipelines/                  los seis azure-pipelines-*.yml
  pipelines/templates/      sus pedazos compartidos
packs/                      sólo su README: los paquetes de un equipo (revisores, skills, guías, plantillas) llegan con su perfil
inbox/                      lo que espera que alguien decida
  inbox/instincts/          los instintos minados
  inbox/dependencies/ · inbox/watcher/   las fichas de los dos nocturnos
specs/ · qa/ · tasks/
onboarding/
  onboarding/mini-class/    la mini-clase
artifacts/
.engram/ · .advisors/ · .dashboard/ · .tycon/ · .githooks/ · _bmad/
```

**Las cuatro reglas**

1. **Ubicación.** Un archivo vive en la etapa donde hace su trabajo. Lo que llaman dos etapas o más va a
   `scripts/lib/`. Lo que registra el instalador y los hooks globales de git van en `scripts/hooks/`, plano: el
   instalador los busca sólo ahí.
2. **El orden** (qué corre en qué momento) vive en la lista del instalador y en el mapa del arnés. Nunca en carpetas
   numeradas.
3. **Sufijo de rol** (`-guard` frena, `-notice` avisa, `-meter` mide) sólo en lo que igual se renombra. Lo que ya está
   en inglés sin sufijo queda como está.
4. **El `tipo` de cada pieza del mapa** (skill, revisor, script, guía…) lo deriva
   el censo del mapa de su ruta. No se tipea a mano.

Las rutas viejas que se llaman desde afuera del repo siguen andando: en la ruta vieja queda un reemplazo que lanza la
nueva, hasta que se retire.

---

## guides/piezas-del-arnes.md

**Qué es:** El índice de las fichas largas de cada pieza del arnés, con el detalle de cada una.

**Por qué existe:** El README se importa entero en cada sesión y en cada revisor; con las fichas adentro era enorme, y casi nadie las usaba. Acá viven completas y el README quedó como índice.

**Quién la usa:** Quien busca el detalle de una pieza; el pre-commit sostiene el par índice y guía con `claude-md-blocks/budget.json`.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidespiezas-del-arnesmd)

## guides/que-hace-el-arnes.md

**Qué es:** El recorrido del arnés entero: qué se activa en cada momento de un día de trabajo y por qué existe.

**Por qué existe:** El README lista piezas ordenadas por archivo y sirve para buscar, no para contar. Sin el recorrido escrito, nadie podía explicar el arnés en detalle.

**Quién la usa:** Quien quiere entender o explicar el arnés; trae tres guiones listos para decir en voz alta.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesque-hace-el-arnesmd)

## artifacts/mapa-arnes.html

**Qué es:** El mapa visual del arnés en bloques: entrada del trabajo, etapas en orden, quién vigila a los controles y lo que corre sin el dev. Tiene una versión pública que se genera sola.

**Por qué existe:** Un censo exige que toda pieza esté citada en una ficha o declarada en `fuera-del-mapa.json` con su motivo, así el mapa no se desactualiza.

**Quién la usa:** Quien necesita ver dónde corre y en qué archivo vive un componente; el pre-commit regenera la versión pública.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#artifactsmapa-arneshtml)

## story-format.md

**Qué es:** El formato Mary+GOLD para escribir stories implementables sin ambigüedad, con entregas en tandas y vínculos entre stories de seguimiento.

**Por qué existe:** Una story ambigua se implementa mal. El formato fija qué lleva y cómo se enlazan las que corrigen a otra.

**Quién la usa:** Quien crea, valida o implementa stories.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#story-formatmd)

## guides/integrations/engram-workflow.md

**Qué es:** La guía de setup, la regla del nombre de proyecto y el ciclo de sesión con la memoria persistente engram.

**Por qué existe:** La memoria sólo sirve si se guarda con el proyecto correcto y en el momento justo.

**Quién la usa:** Quien usa engram, si la integración está prendida.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesintegrationsengram-workflowmd)

## guides/git-commit-conventions.md

**Qué es:** La guía de commits: no se commitea sin consentimiento, formato HEREDOC, línea Co-Authored-By y `/tycon-merge-to-main`.

**Por qué existe:** Un commit sin permiso o mal armado ensucia la historia compartida.

**Quién la usa:** Quien hace commit, push o merge, persona o agente.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesgit-commit-conventionsmd)

## guides/workflow-orchestration.md

**Qué es:** La guía de las seis reglas de workflow, los principios, la estructura de `tasks/` y la integración de BMAD con los revisores.

**Por qué existe:** Un cambio no trivial sin plan se desvía; la guía fija cómo planificar y registrar.

**Quién la usa:** Quien planifica cambios no triviales.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesworkflow-orchestrationmd)

## packs/bizuit/guides/bizuit-plugin-dotnet.md

**Qué es:** La guía del stack .NET para plugins Bizuit: `IBackendPlugin`, `SafeQueryBuilder`, transacciones y orquestador. Es del paquete bizuit, que viaja con el perfil del equipo.

**Por qué existe:** Fija las convenciones del backend de plugins para que todos escriban igual.

**Quién la usa:** Quien escribe o revisa backend .NET de plugins Bizuit.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md)

## packs/bizuit/guides/bizuit-plugin-react.md

**Qué es:** La guía del stack React/TS para plugins Bizuit: límites de Tailwind en producción, inputs `text-gray-900`, patrón fijo de modales, iconos, autenticación Bearer del SDK y pruebas con vitest. Es del paquete bizuit.

**Por qué existe:** Fija las convenciones del frontend de plugins para que todos escriban igual.

**Quién la usa:** Quien escribe o revisa frontend React de plugins Bizuit.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md)

## packs/bizuit/guides/bizuit-plugin-nextjs.md

**Qué es:** La guía del stack Next.js (App Router) para plugins Bizuit: frontera servidor/cliente, carga de datos, API de metadata, Server Actions con validación, variables de entorno, Route Handlers y seguridad de hidratación. Es del paquete bizuit.

**Por qué existe:** Fija las convenciones de Next.js para que todos escriban igual.

**Quién la usa:** Quien escribe o revisa frontend Next.js de plugins Bizuit.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md)

## packs/bizuit/guides/bizuit-bpmn-spec-contract.md

**Qué es:** La guía del contrato de las specs de proceso BPMN de BIZUIT: se escriben con la herramienta del producto (`write_spec`), no con el editor de archivos. Es del paquete bizuit.

**Por qué existe:** Escribir el archivo directo es peor que escribirlo mal: un documento sin tabla de reglas no da error, da silencio, y «0 hallazgos» se lee como «salió limpio». Un control que hay que acordarse de invocar no corre.

**Quién la usa:** Quien escribe o revisa la spec de un proceso BPMN.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md)

## guides/agent-architecture.md

**Qué es:** La guía de la arquitectura de revisores TYCON: envoltorios sobre BMAD con pipeline con humano en el circuito, niveles de severidad, modo sombra y tablero.

**Por qué existe:** Sin una arquitectura común, cada revisor se define a su manera.

**Quién la usa:** Quien invoca revisores o integra BMAD.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesagent-architecturemd)

## packs/ (agent-skills) — paquetes de revisores

_`packs/<paquete>/pack.json` (en el perfil del equipo) · `skills/tycon-pipeline/scripts/lib/packs.js` · `pipeline.js validators` · `scripts/lib/installed-packs.js` (arnés) · `guides/agent-architecture.md` §«Paquetes de revisores»_

**Qué es:** Los paquetes de revisores: los de un producto o cliente viven en manifiestos `pack.json` con vocabulario cerrado, no en el código del pipeline.

**Por qué existe:** Un revisor que deja de correr no da error, da menos hallazgos. Un manifiesto malo frena con motivo y nunca degrada a «sin ese paquete».

**Quién la usa:** `pipeline.js` (`advisors`, `validators`), `harness-audit.js` e `instinct-draft.js`.

**Dónde se prueba:** `tycon-pipeline/scripts/tests/packs.test.js`, `package-equivalence.test.js`, `scripts/tests/installed-packs.test.js`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#packs-agent-skills--paquetes-de-revisores)

## scripts/lib/tycon-config.js + team-profile.json — la configuración del arnés

_`scripts/lib/tycon-config.js` · el perfil del equipo · `~/.claude/tycon.json` · el enlace `~/.claude/tycon-harness` (`scripts/lib/canonical-path.js --ensure-link`) · agent-skills `skills/tycon-pipeline/scripts/lib/harness-path.js` · `scripts/lib/repos-root.js` · `scripts/lib/harness-repo.js` · `scripts/publishing/profile-equivalence.js` · INSTALL.md §4b_

**Qué es:** La configuración del arnés en una cadena: entorno, `~/.claude/tycon.json`, perfil del equipo, apagado.

**Por qué existe:** Con valores fijos de máquina y organización, el arnés no se instalaba afuera. Un archivo ilegible frena con motivo y no se lee como «todo apagado».

**Quién la usa:** Los hooks, el instalador y los comandos del arnés.

**Dónde se prueba:** `scripts/tests/tycon-config.test.js`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptslibtycon-configjs--team-profilejson--la-configuración-del-arnés)

## guides/reglas-para-revisores.md

**Qué es:** La sección `## Reglas para revisores` del `CLAUDE.md` de cada repo, que `pipeline.js` recorta y pega al principio del contexto de cada revisor.

**Por qué existe:** Con el `CLAUDE.md` entero el revisor ve la regla pero no la controla; con sólo la sección la detecta mucho mejor y gasta menos.

**Quién la usa:** `pipeline.js advisors` y los revisores del paso 5; el pre-commit avisa (sin frenar) de líneas nuevas fuera de la sección con `scripts/ci/reviewer-rules.js`.

**Dónde se prueba:** `tycon-pipeline/scripts/tests/reviewer-rules.test.js`, `scripts/tests/reviewer-rules.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesreglas-para-revisoresmd)

## guides/maintaining/bmad-contract.md

**Qué es:** El contrato de entradas y salidas entre los revisores TYCON y las skills BMAD.

**Por qué existe:** Al actualizar BMAD hace falta un mapa para detectar cambios que rompen a los revisores.

**Quién la usa:** Quien actualiza BMAD.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesmaintainingbmad-contractmd)

## guides/advisor-rules-catalog.md

**Qué es:** El catálogo maestro de reglas de revisores, con identificadores estables (por ejemplo `SEC-C1`, `DOTNET-W3`).

**Por qué existe:** Cada hallazgo cita su identificador, así se puede explicar, agregar o retirar una regla.

**Quién la usa:** Los revisores y quien quiere saber por qué uno reportó algo.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesadvisor-rules-catalogmd)

## guides/maintaining/incident-log.md

**Qué es:** El registro de incidentes del arnés: el caso concreto que motivó cada regla, hook o revisor. No se publica.

**Por qué existe:** Las guías publicadas dicen la regla y su porqué; el caso queda acá, con la guía y la sección que lo citaban.

**Quién la usa:** Quien va a retirar o relajar una regla, antes de hacerlo.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesmaintainingincident-logmd)

## guides/accov-governance-protocol.md

**Qué es:** El protocolo de cierre de story (`ACCOV-C7` a `ACCOV-C10`): autoauditoría, meta-auditoría, convergencia y prohibición del checklist manual.

**Por qué existe:** Cerrar una story sin verificar cada criterio deja huecos invisibles.

**Quién la usa:** El orquestador del pipeline, al pasar una story a `review` o `done`.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesaccov-governance-protocolmd)

## guides/guide-update-proposals.md

**Qué es:** El buzón de propuestas de cambio a guías y catálogo que genera `tycon-retrospective-capturer`.

**Por qué existe:** Ningún cambio a una guía se aplica sin OK del dev; al aplicarlo se marca como implementado y no se borra, para dejar rastro.

**Quién la usa:** El dev que revisa y aprueba propuestas.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesguide-update-proposalsmd)

## packs/bizuit/guides/dotnet-hooks.md

**Qué es:** Un bloque de hooks de `.claude/settings.json` para proyectos .NET TYCON: bloquea migraciones SQL ya commiteadas y corre `dotnet format` sobre los `.cs`. Es del paquete bizuit.

**Por qué existe:** Una migración ya commiteada no se debe editar, y el formato debe ser parejo.

**Quién la usa:** Quien configura un proyecto .NET TYCON (se copia y pega).

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md)

## guides/definition-of-done.md

**Qué es:** La guía de la definición de terminado: el portón obligatorio para pasar una story de `review` a `done`, con humo de endpoints reales, E2E que falla fuerte y verificación cruzada.

**Por qué existe:** Que el build esté verde no alcanza para saber que la feature anda.

**Quién la usa:** Quien cierra una story.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesdefinition-of-donemd)

## guides/test-execution-discipline.md

**Qué es:** La guía de cómo correr tests sin congelar la máquina: sólo el archivo tocado al iterar, la suite completa en el portón del merge, y el tope `maxWorkers: '50%'` en `vitest.config`.

**Por qué existe:** La suite completa en una máquina chica la deja sin memoria y congela al dev.

**Quién la usa:** Cualquiera que corra tests, persona o agente.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidestest-execution-disciplinemd)

## guides/git-worktrees.md

_(guides/git-worktrees.md + scripts/tools/tycon-worktree.sh)_

**Qué es:** La guía de git worktrees: un worktree por story en paralelo, un worktree de merge persistente y aislamiento de agentes que escriben en paralelo. Nombre obligatorio `<RepoName>--wt-<slug>`.

**Por qué existe:** Compartir un árbol de trabajo contamina el diff de los revisores y pisa resultados; el worktree evita congelar el árbol del dev.

**Quién la usa:** Quien corre dos pipelines en el mismo repo o mergea sin congelar su árbol.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesgit-worktreesmd)

## scripts/lib/tycon-telegram-notify.sh

**Qué es:** Un guion que avisa por Telegram desde Claude Code o Codex: imprime el `message_id`, y `--edit <id>` reescribe el mismo aviso.

**Por qué existe:** Permite un aviso por tanda en vez de una catarata. Es sólo de salida a propósito: un segundo consumidor de entrada le rompería el canal al otro. Sin configuración sale con código 3 y lo dice.

**Quién la usa:** Cualquier sesión o proceso del arnés que deba avisar.

**Dónde se prueba:** `scripts/tests/telegram-notify.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptslibtycon-telegram-notifysh)

## scripts/ci/release-notes.sh

**Qué es:** El `release-notes.sh` canónico: arma las notas de versión que lee el administrador que instala un plugin. La bandera `--type plugin|formulario` elige el caso.

**Por qué existe:** Copiado en cada repo, nada mantiene iguales las copias, y a la que le falta un filtro le publica «Merged PR…» al administrador.

**Quién la usa:** Los pipelines de los productos.

**Dónde se prueba:** `scripts/tests/release-notes.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptscirelease-notessh)

## scripts/ci/recompute-zip-notes.sh

**Qué es:** El paso de despliegue de formularios: por cada ZIP pregunta al host qué versión está publicada y reescribe la nota adentro del paquete.

**Por qué existe:** La nota debe decir qué cambia respecto de lo instalado, no del build anterior. Sale con código 3 cuando no pudo, para que el paso quede naranja y no verde.

**Quién la usa:** Los pipelines de formularios de los productos.

**Dónde se prueba:** `scripts/tests/recompute-zip-notes.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptscirecompute-zip-notessh)

## scripts/tools/release-notes-parity.js

**Qué es:** Un control que compara el comportamiento del filtro de ruido de cada copia de `release-notes.sh` contra un corpus fijo de mensajes de commit.

**Por qué existe:** Una copia sin filtrar deja pasar ruido a la nota, o peor, borra un cambio real. Juzga contra lo esperado, no contra la mayoría, y una copia ilegible falla.

**Quién la usa:** La suite diaria, que lanza `install-tycon-hooks.sh`.

**Dónde se prueba:** `scripts/tests/release-notes-parity.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptstoolsrelease-notes-parityjs)

## scripts/ci/publish-bump.sh

**Qué es:** El guion único que commitea y publica el aumento de versión de los formularios para los cinco productos.

**Por qué existe:** Cuando dos construcciones terminan cerca, el segundo push rebota. Conserva la marca `Commit: <sha>`; sin ella un formulario puede no versionarse nunca.

**Quién la usa:** Los pipelines de los cinco productos, vía `forms-to-version.sh`.

**Dónde se prueba:** `scripts/tests/publish-bump.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptscipublish-bumpsh)

## scripts/lib/meter-backup.sh

**Qué es:** Una función que decide si el respaldo local del medidor de etapas del SDLC debe correr ahora.

**Por qué existe:** Si corre antes de que el nocturno de Azure tenga su turno, deja un archivo suelto en `.dashboard/` que rompe el `pull` del arranque.

**Quién la usa:** El instalador, que la carga.

**Dónde se prueba:** `scripts/tests/meter-backup.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptslibmeter-backupsh)

## packs/bizuit/guides/deuda-de-pruebas-formularios.md

**Qué es:** La guía para dejar un formulario sin pruebas sin que el pipeline falle: se declara en `pruebas-pendientes.json` con motivo y fecha de revisión. Es del paquete bizuit.

**Por qué existe:** Borrar la entrada sin agregar pruebas deja `main` rojo, por eso se borra en el mismo pull request.

**Quién la usa:** Cualquier dev que declare o pague una deuda de pruebas.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md)

## scripts/ci/affected-forms.js

**Qué es:** El cálculo de qué formularios probar y construir por un cambio: lo cambiado más su cono de dependientes, derivado de los imports reales.

**Por qué existe:** Probar sólo lo cambiado pierde roturas; construir todos desperdicia. En `main` se prueba y construye todo. Ante cualquier duda devuelve todos, y si no encuentra formularios sale con código 3.

**Quién la usa:** Los pipelines de formularios y `forms-to-version.sh`.

**Dónde se prueba:** `scripts/tests/affected-forms.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptsciaffected-formsjs)

## scripts/ci/forms-to-version.sh

**Qué es:** El cálculo de a qué formularios subirles la versión en una corrida.

**Por qué existe:** Mirar sólo `HEAD~1` pierde el primer merge de un lote agrupado y el cambio nunca llega. Nunca sale 0 sin poder decidir.

**Quién la usa:** Los pipelines de los cinco productos; corre en la suite diaria desde `install-tycon-hooks.sh`.

**Dónde se prueba:** su propia suite de pruebas, bajo `scripts/tests/`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptsciforms-to-versionsh)

## scripts/ci/label-prs.sh

_scripts/ci/label-prs.sh + scripts/ci/run-base.sh_

**Qué es:** El guion que etiqueta cada corrida de `main` con `PR-<id>` y escribe un resumen con el enlace a cada pull request. Comparte la base con `forms-to-version.sh` a través de `scripts/ci/run-base.sh`.

**Por qué existe:** Con `batch: true` la corrida junta varios merges y su título no dice cuáles. Es trazabilidad, no un control: sale 0 y avisa si no pudo etiquetar.

**Quién la usa:** El job de construcción de `main` de cada producto.

**Dónde se prueba:** `scripts/tests/label-prs.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptscilabel-prssh)

## scripts/ci/nightly-dod-notice.sh

**Qué es:** El aviso por Telegram de la evidencia DoD que mide el nocturno: compara el snapshot de hoy con el anterior y avisa sólo si se movió.

**Por qué existe:** Lee lo publicado en `origin/main` y no toca el checkout; leer el disco avisaba «no corrió» por error. Un envío que no llega se reintenta en la corrida siguiente.

**Quién la usa:** Un LaunchAgent en la Mac del dev.

**Dónde se prueba:** `scripts/tests/nightly-dod-notice.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptscinightly-dod-noticesh)

## scripts/ci/sql-compile.js

**Qué es:** Un control que compila sin ejecutar cada migración SQL nueva o modificada (`database/` o `BD/`) antes del commit, y avisa sin frenar.

**Por qué existe:** Un error de sintaxis frena el despliegue entero y nada más toca un `.sql` suelto. «Sin compilar» nunca se lee como «compila». Se apaga con `TYCON_SQL_COMPILE=0`.

**Quién la usa:** El pre-commit global de git.

**Dónde se prueba:** `scripts/tests/sql-compile.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptscisql-compilejs)

## scripts/ci/check-bash32-quoting.sh

**Qué es:** Un lint que marca `$variable` pegada a un carácter fuera de ASCII en guiones de shell.

**Por qué existe:** El bash 3.2 de macOS parte la variable y rompe el texto, y las suites no lo ven en otros intérpretes. Es una regla que no se puede recordar, necesita un control.

**Quién la usa:** El pre-commit (sobre lo stageado) y a mano sobre el repo.

**Dónde se prueba:** `scripts/tests/bash32-quoting.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptscicheck-bash32-quotingsh)

## scripts/ci/public-ci.sh

_scripts/ci/public-ci.sh + scripts/ci/check-public-workflow.js + el `ci.yml` de la copia_

**Qué es:** La CI del repo público en un guion que cualquiera corre en su máquina, más `scripts/ci/check-public-workflow.js`, que verifica la forma exacta del `ci.yml`. La corrida termina en un job estable llamado `public-ci`.

**Por qué existe:** El repo público acepta cambios de desconocidos y la CI no puede ser una lista de comandos sin prueba. No corta en el primer rojo, y un paso que no pudo correr es rojo.

**Quién la usa:** El workflow `ci.yml` de la copia, la prueba nocturna y quien contribuye.

**Dónde se prueba:** `scripts/tests/public-ci.test.sh`

**Guía:** [publicacion-espejo.md](maintaining/publicacion-espejo.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptscipublic-cish)

## scripts/ci/run-base-controls.sh

_(scripts/ci/run-base-controls.sh + scripts/ci/controls-from-base.json + el paso `repo-lint` de public-ci.sh con `--base`)_

**Qué es:** El guion que revisa un pedido con los controles de la base y no con los que trae el propio pedido, según el inventario `scripts/ci/controls-from-base.json`.

**Por qué existe:** Un pedido podía vaciar o aflojar el control que lo tenía que frenar y así saltearlo. Aflojar un control exige la constancia del dueño; si no se puede correr, es rojo.

**Quién la usa:** La CI de GitHub (`ci.yml` vía `public-ci.sh --base`) y la validación de pedidos del repo de mantenimiento.

**Dónde se prueba:** `scripts/tests/base-controls.test.sh`, `scripts/tests/public-ci.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptscirun-base-controlssh)

## scripts/tests/clean-machine.test.sh

_(scripts/tests/clean-machine.test.sh + scripts/tests/clean-machine/ + scripts/tests/fixtures/example-repo/)_

**Qué es:** La prueba que instala el arnés en un contenedor con sólo lo que pide la portada y comprueba que todo anda.

**Por qué existe:** Una carpeta de usuario vacía no es una máquina vacía: lo que el arnés usa sin declararlo sólo se ve donde no está. Si no puede medir, lo dice y no da verde.

**Quién la usa:** El proceso nocturno, la CI pública y quien la corre a mano con `TYCON_CLEAN_MACHINE=1`.

**Dónde se prueba:** `scripts/tests/clean-machine.test.sh`

**Guía:** [publicacion-espejo.md](maintaining/publicacion-espejo.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptstestsclean-machinetestsh)

## scripts/ci/check-artifact-paths.js

**Qué es:** Un control que marca los pipelines que LEEN de una carpeta que nunca LLENAN.

**Por qué existe:** Un despliegue a producción que busca su artefacto donde nadie lo deja falla siempre y gasta una aprobación en cada intento. El control no juzga cuál carpeta es la correcta: sólo la incoherencia dentro de un archivo.

**Quién la usa:** La CI y la suite diaria, sobre los pipelines publicados.

**Dónde se prueba:** `scripts/tests/artifact-paths.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptscicheck-artifact-pathsjs)

## scripts/ci/rollback-guard.sh

**Qué es:** El freno que impide promover a producción un paquete de versión menor que el instalado.

**Por qué existe:** Encolar a mano un run viejo promovía ese paquete y el humo salía verde igual. Corre antes de subir nada, compara con la versión instalada en el host y sale 2 si el paquete es menor. Si no puede mirar, tampoco deja pasar. No existe forzar el retroceso.

**Quién la usa:** Los cuatro pipelines de producción.

**Dónde se prueba:** `scripts/tests/rollback-guard.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptscirollback-guardsh)

## scripts/ci/smoke-plugin.sh

_(scripts/ci/smoke-plugin.sh + scripts/ci/smoke-forms.sh)_

**Qué es:** Los humos que verifican el paquete instalado en el servidor y validan todo lo que trae el paquete antes de consultar.

**Por qué existe:** El nombre, la versión o el peso que vienen en el ZIP podían alterar la URL, ejecutar comandos o dar verde sin haber verificado. Lo que no pasa la lista blanca no se consulta y el humo sale rojo; cuando un formulario falla, dice por qué.

**Quién la usa:** Los pipelines de despliegue de cada producto, que publican `scripts/ci` desde `main`.

**Dónde se prueba:** `scripts/tests/smoke.test.sh`, `scripts/tests/smoke-forms-reason.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptscismoke-pluginsh)

## scripts/ci/deploy-record.sh

**Qué es:** El ayudante que anota cada despliegue aprobado en su propia corrida, con una línea de registro y etiquetas.

**Por qué existe:** Sin esto el arnés no sabía qué llegó a cada servidor ni cuándo. Anotar nunca cambia el veredicto del humo.

**Quién la usa:** Los humos y `deploy-plugin.sh`, que lo cargan dentro de una corrida de Azure.

**Dónde se prueba:** `scripts/tests/deploy-record.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptscideploy-recordsh)

## scripts/ci/check-product-parity.js

**Qué es:** Un control que compara los pipelines de los productos y dice si hacen lo mismo, leyendo lo publicado en `origin/main`.

**Por qué existe:** Comparar a mano no alcanza y ninguna revisión encontraba las diferencias. Una diferencia legítima se declara con motivo y fecha de revisión; lo que no se pudo medir nunca sale verde.

**Quién la usa:** La revisión nocturna y la suite diaria; la lista de productos vive en `scripts/ci/product-parity.json`.

**Dónde se prueba:** `scripts/tests/product-parity.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptscicheck-product-parityjs)

## scripts/ci/check-trigger-without-docs.js

**Qué es:** Un control que prueba si un merge de sólo documentación dispararía build, despliegue y pedido de producción, y si el mismo pipeline sí dispara con código.

**Por qué existe:** Un cambio sin una línea de código subía la versión y pedía aprobación de producción, por rutas de `.tycon/**` en el filtro o por pipelines sin filtro de rutas.

**Quién la usa:** La suite diaria, sobre el disparador publicado de cada pipeline; los repos salen de `product-parity.json`.

**Dónde se prueba:** `scripts/tests/trigger-without-docs.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptscicheck-trigger-without-docsjs)

## skills/tycon-pipeline/scripts/lib/models.js — el modelo de cada trabajo del pipeline

**Qué es:** El único lugar donde se define el modelo de cada trabajo del pipeline (revisores, vueltas, pase adversarial, ayudantes y sugerencia de sesión) y cómo se resuelve con la configuración de la organización (`team-repos.json → models`).

**Por qué existe:** Estaba escrito en seis lugares y una organización no podía decir quién paga. Con `mandatory_ceiling: true` el tope baja el modelo y avisa, sin frenar.

**Quién la usa:** El pipeline, el control de lanzamientos, el despliegue de Codex, la paridad y la pestaña Configuración del sitio.

**Dónde se prueba:** `skills/tycon-pipeline/scripts/tests/models.test.js`

**Guía:** [harness-cost-tiering](harness-cost-tiering.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#skillstycon-pipelinescriptslibmodelsjs--el-modelo-de-cada-trabajo-del-pipeline)

## skills/tycon-pipeline/scripts/lib/run-size.js — el tamaño de la corrida

**Qué es:** Decide si una corrida del pipeline es liviana (la story sólo declara documentación o textos) o completa (lo demás), y estima cuánto va a tardar con las corridas anteriores de la máquina.

**Por qué existe:** Una story que sólo reescribía una guía salía con pase adversarial y cuatro horas estimadas: el riesgo contaba archivos, no lo que tocan.

**Quién la usa:** `pipeline.js` (el arranque, el riesgo, la sugerencia de modelo, el portón del pase y los revisores), `marker.js set-size` y `test-gate.sh` (las suites de una liviana).

**Dónde se prueba:** `skills/tycon-pipeline/scripts/tests/run-size.test.js` y los casos `7.32` de `unit.test.js`

**Guía:** [harness-cost-tiering](harness-cost-tiering.md#el-tamaño-de-la-corrida-liviana-o-completa)

## skills/tycon-pipeline/scripts/lib/runtime-waiver.js — el registro de firmas de la matriz

**Qué es:** El registro de firmas con el que el dev perdona un criterio que no se puede verificar corriendo, en `.tycon/runtime-waivers.jsonl`.

**Por qué existe:** Perdonar sin firma abriría la puerta a saltear la matriz. La firma sale de la terminal del dev y lleva una cadena de hash que detecta ediciones a mano. Una firma descartada se dice, con el motivo.

**Quién la usa:** El comando `marker.js runtime-waiver`, la matriz, el paso 8 y el freno del commit.

**Dónde se prueba:** `unit.test.js`, `test-runtime-matrix.js`, `dod-hook-smoke-test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#skillstycon-pipelinescriptslibruntime-waiverjs--el-registro-de-firmas-de-la-matriz)

## scripts/ci/check-stage-dependencies.js

**Qué es:** Un control que verifica que la condición de cada etapa de un pipeline diga de qué depende de verdad.

**Por qué existe:** En Azure DevOps una etapa mal enganchada no da error: puede empaquetar con las pruebas en rojo o quedar verde con la etapa anterior saltada. Sin condición explícita no hay hallazgo.

**Quién la usa:** La CI y la suite diaria, sobre los pipelines de los productos.

**Dónde se prueba:** `scripts/tests/stage-dependencies.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptscicheck-stage-dependenciesjs)

## scripts/nightly/dependencies/

_(scripts/nightly/dependencies/ + scripts/ci/audit-dependencies.js)_

**Qué es:** La revisión nocturna de dependencias: mira `main` de cada repo y abre un pull request por cada hallazgo nuevo.

**Por qué existe:** El veredicto del control de dependencias cambia sin que cambie el código, y sólo corría en pull requests. Avisa y no frena. Lo declarado no despierta, lo vencido vuelve a contar, y no medido nunca es limpio.

**Quién la usa:** Los pipelines nocturnos de Azure y GitHub, y el dev que decide cada pull request.

**Dónde se prueba:** `scripts/tests/audit-dependencies.test.sh`, `scripts/tests/nightly-dependencies.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptsnightlydependencies)

## scripts/nightly/dependencies/work-items.js

**Qué es:** El paso que crea un Bug en el proyecto de Azure DevOps del equipo dueño por cada vulnerabilidad viva, asignado y con el dev mencionado.

**Por qué existe:** El único aviso era el pull request del arnés, que ve sólo quien mantiene. Se enciende con `azure.pedidos_activos: true` en `repos.json`; nunca crea dos veces el mismo pedido y, si no pudo consultar, no crea nada.

**Quién la usa:** La revisión nocturna de dependencias, antes del commit de la noche.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptsnightlydependencieswork-itemsjs)

## work-items.js state

_(work-items.js state + el cruce de scripts/nightly/dependencies/nightly-dependencies.js)_

**Qué es:** El cruce entre el estado de cada Bug de dependencias y la medición de la noche.

**Por qué existe:** Un Bug cerrado por error dejaba la vulnerabilidad viva y el tablero decía listo. Tras una noche de gracia deja un comentario al dev y nunca cambia el estado. Un pedido no leído nunca cuenta como coincidencia.

**Quién la usa:** El nocturno de dependencias y el resumen diario.

**Dónde se prueba:** `scripts/tests/nightly-dependencies.test.sh`, `scripts/tests/daily-summary.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#work-itemsjs-state)

## scripts/nightly/dependencies/daily-summary.js

**Qué es:** El resumen diario: un único mensaje de Telegram con lo que dejaron las dos colas nocturnas, con lo que cambió arriba.

**Por qué existe:** Varias cosas no llegaban a ningún canal. Y una noche que midió bien pero no entregó el resumen se leía como que no había nada. Deja constancia de la entrega en el snapshot y el hook de arranque cobra si falta.

**Quién la usa:** Las colas de dependencias y del vigilante, y el hook `dependencies-notice.js`.

**Dónde se prueba:** `scripts/tests/daily-summary.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptsnightlydependenciesdaily-summaryjs)

## scripts/nightly/open-prs/open-prs.js

**Qué es:** El paso que lista los pull requests de toda la organización con más de 2 días abiertos y los pega al final del resumen diario.

**Por qué existe:** Un pull request con auto-completar y el build roto queda esperando un verde imposible y nadie se entera. Avisa por antigüedad, sólo al dev. Si Azure no contesta, lo dice: no medido no es cero.

**Quién la usa:** El pipeline del vigilante y `daily-summary.js deliver --extra`; con `--json` lo lee el sitio.

**Dónde se prueba:** `scripts/tests/open-prs.test.sh`, `scripts/tests/daily-summary.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptsnightlyopen-prsopen-prsjs)

## scripts/nightly/assigned/assigned-items.js

**Qué es:** El guion que deja cada noche lo asignado a cada persona en `.dashboard/assigned/`.

**Por qué existe:** El sitio de la organización muestra a cada dev sus pedidos abiertos sin consultar la plataforma en vivo. Guarda una lista blanca (nunca el título) y, si una consulta falla, dice no medido con el motivo.

**Quién la usa:** El nocturno del tablero y el sitio de la organización.

**Dónde se prueba:** `scripts/tests/assigned-items.test.js`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptsnightlyassignedassigned-itemsjs)

## scripts/nightly/deployments/deployments.js

**Qué es:** El guion `deployments.js` que registra qué llegó a staging y qué a producción en cada producto, leyendo el timeline de cada corrida.

**Por qué existe:** Una corrida `succeeded` no prueba nada sobre producción: sin aprobación el stage queda `skipped`. Cuenta por el identificador exacto del stage declarado en `operations.json → deployments`, nunca por texto. Sin permiso o con `az` caído, dice no medido.

**Quién la usa:** El nocturno del tablero, la ficha de despliegues y la pestaña Proyectos del sitio; la prueba corre con `nightly-deployments`.

**Dónde se prueba:** `scripts/tests/nightly-deployments.test.js`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptsnightlydeploymentsdeploymentsjs)

## scripts/site/ — el sitio de la organización

**Qué es:** una página web para toda la organización, donde cada persona entra con la cuenta de la organización y ve lo
suyo (sus pedidos, sus pull requests, sus corridas), y quienes mantienen el arnés ven todo.

**Para qué sirve:** es el punto de entrada de cada día. El aviso de la mañana trae el enlace, y quien mantiene ve ahí qué
decidir; en la pestaña **Configuración** se personaliza la organización sin clonar nada.

**Quién lo usa:** cada persona de la organización, para ver lo suyo; quienes mantienen el arnés, para verlo todo, editar
la configuración e instalarlo. Quién entra lo decide sólo la lista `site.access`, con el inicio de sesión que elija.

**Dónde leer más:** para personas, la guía: cómo se usa cada pestaña, la configuración sección por sección, qué ve
cada rol, los problemas comunes, cómo se instala y cómo está hecho por dentro, en
[guides/organization-site.md](organization-site.md) (en inglés,
[guides/organization-site.en.md](organization-site.en.md)). Sus capturas las saca
`scripts/tools/site-guide-captures.js` del sitio corriendo con una organización de laboratorio. Las piezas que lo acompañan: la imagen
(`.github/workflows/site-image.yml`), las instalaciones (`scripts/site/deploy/`: Azure Container Apps en dos fases,
Render y una máquina propia), la prueba sin sesión (`scripts/site/check-deploy.js`) y el canal del aviso
(`scripts/lib/notify.js`). Red: las suites `site-*` y `notify` de `scripts/tests/`.

**La copia de operaciones**: con `SITE_OPERATIONS_SOURCE=copy`, `pipelines/operations/site-copy.yml` sube a
un contenedor sólo lo que el sitio lee (`RUTAS` de `scripts/site/operations-copy.js`) y el sitio lo lee con su identidad,
sin permiso del repo; la edad de la copia frena como `operations.json`. Red: `site-operations-copy.test.js`. **Al día con `stable`**: la imagen llega a `stable` sólo escaneada y firmada; `scripts/site/deploy/update-site.js` la instala por huella, prueba y vuelve atrás (`site.update`). Red: `site-latest-release.test.js` y `site-update.test.js`.

## guides/integrations/ado-cola-y-listados.md

**Qué es:** La guía `guides/integrations/ado-cola-y-listados.md` con el porqué de las seis reglas del bloque de Azure DevOps de cada sesión.

**Por qué existe:** Un listado atrasado, vacío o fallido no es evidencia de lo que no muestra; las acciones con efectos se disparan por evidencia positiva. Explica cada regla con sus comandos.

**Quién la usa:** El agente y el dev cuando actúan sobre colas y corridas de Azure.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesintegrationsado-cola-y-listadosmd)

## guides/integrations/clockify-mcp.md

**Qué es:** La guía `guides/integrations/clockify-mcp.md` para instalar el MCP de Clockify en Claude Code (opcional).

**Por qué existe:** Permite el seguimiento de horas desde la sesión. Trae scripts `.sh` y `.ps1` en `scripts/`, instala a nivel de usuario y usa una clave personal por dev.

**Quién la usa:** Cada dev que quiere seguimiento de horas.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesintegrationsclockify-mcpmd)

## guides/integrations/clocki-tracking.md

**Qué es:** La guía `guides/integrations/clocki-tracking.md` del seguimiento automático de horas en Clockify.

**Por qué existe:** Abre la entrada de tiempo al arrancar trabajo y la cierra al detectar más de 15 minutos de inactividad, con la hora de fin retroactiva. Asocia carpeta y proyecto solo.

**Quién la usa:** La skill `clocki` y sus hooks, en cada máquina que la instala.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesintegrationsclocki-trackingmd)

## guides/integrations/codegraph-mcp.md

**Qué es:** La guía `guides/integrations/codegraph-mcp.md` para instalar CodeGraph como MCP (opcional).

**Por qué existe:** Es un índice del código en una base local para consultar símbolos, llamadores y dependencias sin escanear archivos. Los scripts autodetectan repo suelto o contenedor; un hook de arranque configura cada repo nuevo.

**Quién la usa:** Los agentes de la sesión y cada dev que lo instala.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesintegrationscodegraph-mcpmd)

## guides/signed-scope-guardrails.md

**Qué es:** La guía `guides/signed-scope-guardrails.md` con cuatro mecanismos contra el corrimiento no autorizado de lo firmado por el cliente.

**Por qué existe:** Sin nada que cruce el plan con lo firmado, un corrimiento de sprint pasa días sin detectarse. Usa el frontmatter `signed_for_sprint`, un registro obligatorio de cambios, el validador VAL-C7 y una auditoría periódica.

**Quién la usa:** Quien arma el plan de sprints, el validador de stories y el advisor de alcance firmado.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidessigned-scope-guardrailsmd)

## guides/integrations/ado-projects.md

**Qué es:** La guía `guides/integrations/ado-projects.md` de la integración con Azure DevOps.

**Por qué existe:** Al crear una story se crea sola su work item. Cubre el hook `on-story-create.js`, la skill `tycon-ado-story-wi`, el esquema de `.tycon/ado-config.yaml`, el tipo de work item por plantilla, el vínculo al Epic y el ciclo de vida.

**Quién la usa:** El hook de creación de stories y el dev que configura un repo.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesintegrationsado-projectsmd)

## guides/safety-guard.md

**Qué es:** La guía `guides/safety-guard.md` del freno de mano: un hook que bloquea comandos destructivos irreversibles en Bash y PowerShell.

**Por qué existe:** Frena `rm -rf /`, el push forzado a main, `curl|bash`, el borrado de bases de datos, `npm publish` o leer `.ssh`. Está prendido por defecto; se apaga con `TYCON_SAFETY_GUARD=0` y hay una salida de emergencia por comando con `TYCON_SAFETY_OFF=1`.

**Quién la usa:** El hook `PreToolUse` en cada sesión.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidessafety-guardmd)

## guides/maintaining/context-budget.md

**Qué es:** La guía `guides/maintaining/context-budget.md` de la auditoría de tokens del arnés.

**Por qué existe:** Un script de Node mide cuántos tokens gasta el arnés (skills, agentes, MCPs, `CLAUDE.md`) al abrir cada sesión, señala los que más pesan y propone recortes ordenados por ahorro.

**Quién la usa:** Quien mantiene el arnés.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesmaintainingcontext-budgetmd)

## guides/maintaining/skill-scout.md

**Qué es:** La guía `guides/maintaining/skill-scout.md` de la skill que se dispara antes de crear una skill, agente, guía o hook.

**Por qué existe:** Evita capas duplicadas que dividen el conocimiento. Busca en el catálogo local y ofrece tres caminos: usar lo que existe, extenderlo o crear algo nuevo. No busca en GitHub ni en la web.

**Quién la usa:** Quien va a crear una pieza nueva del arnés.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesmaintainingskill-scoutmd)

## guides/maintaining/rules-distill.md

**Qué es:** La guía `guides/maintaining/rules-distill.md` de la auditoría del catálogo de reglas contra los revisores que las aplican.

**Por qué existe:** Un script de Node determinista detecta cinco clases de desajuste: referencias rotas, huérfanas, zombis, dueño equivocado y reglas aplicadas por hooks. El dueño de cada regla sale de `scripts/lib/rules-catalog.js`.

**Quién la usa:** Quien mantiene el catálogo de reglas.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesmaintainingrules-distillmd)

## guides/maintaining/harness-audit.md

**Qué es:** La guía `guides/maintaining/harness-audit.md` del chequeo reproducible del arnés.

**Por qué existe:** Puntúa de 0 a 10 siete categorías (cobertura de revisores, eficiencia de contexto, controles de calidad, memoria, integridad del catálogo, guardas de seguridad, cableado del pipeline) y lista las cinco acciones prioritarias. Reemplaza la auditoría manual.

**Quién la usa:** Quien mantiene el arnés.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesmaintainingharness-auditmd)

## guides/integrations/instinct-mining.md

**Qué es:** La guía `guides/integrations/instinct-mining.md` del grabador silencioso que propone reglas atómicas (instintos).

**Por qué existe:** Un hook graba llamadas de herramientas saneadas; un observador propone instintos con el modelo y una segunda pasada descarta lo que repite algo ya decidido. El dev aprueba con `/tycon-instincts`. `scripts/instincts/instinct-dirs.js` dice dónde viven las propuestas.

**Quién la usa:** Los hooks de grabación y arranque, y el dev que revisa.

**Dónde se prueba:** `instinct-dirs.test.js`, `instinct-outside-tree.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesintegrationsinstinct-miningmd)

## guides/harness-cost-tiering.md

**Qué es:** La guía `guides/harness-cost-tiering.md` para bajar el costo del pipeline: ejecutor barato para lo mecánico, modelo caro sólo para el juicio.

**Por qué existe:** Reparte el modelo por trabajo: baja un revisor de nivel, `pipeline.js advisors --cost-tier lean` pide Haiku como opción y el orquestador sugiere un esfuerzo de sesión según la complejidad de la story. Cada movimiento se revierte por separado.

**Quién la usa:** El orquestador del pipeline y quien elige el modelo de la sesión.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesharness-cost-tieringmd)

## scripts/nightly/watcher/vigilante.js

_(scripts/nightly/watcher/vigilante.js + inbox/watcher/)_

**Qué es:** El vigilante de producción: mira producción cada noche y deja un borrador con lo que huele mal para decidir a la mañana.

**Por qué existe:** Cubre lo que quedó bajo el umbral de las alertas de Azure, con cuatro reglas (goteo, desagregación, salud y deriva). No toca nada. Cada ficha recuerda su pull request (`pr:`) y lo rechazado no vuelve a abrirse. Lo decidido se registra antes de contar.

**Quién la usa:** El nocturno del vigilante y el dev, con `/tycon-vigilante`; los dos YAML llaman a `scripts/ci/open-pr-per-finding.sh`.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptsnightlywatchervigilantejs)

## scripts/controls-bench/periodic-exam.js

**Qué es:** El examen periódico de los revisores: corre solo en la máquina designada por `exam-config.json` y denuncia cuando no corre.

**Por qué existe:** Un lanzador con condiciones anidadas dejaba de correr sin que nadie lo notara. Sella la semana al terminar, guarda dos archivos de resultado y sale 0 si midió. Lo que no pudo medir lo dice, no lo pinta de cero.

**Quién la usa:** El disparador del sistema que genera desde `exam-config.json` y el aviso de arranque; `--dry-run` diagnostica sin gastar.

**Dónde se prueba:** `periodic-exam.test.js`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptscontrols-benchperiodic-examjs)

## scripts/ci/push-nightly-data.js

**Qué es:** El guion que guarda en `main` lo que escribieron los nocturnos, con `save` y `sync`.

**Por qué existe:** Empujar `HEAD` subía un commit local que no existía en el remoto y movía el checkout. Ahora el checkout no se mueve: arma un commit sólo con las rutas del paso y no empuja si alguna comprobación falla. Nada nuevo no es todo bien, y no pude no es no hay.

**Quién la usa:** Los pipelines nocturnos y `open-pr-per-finding.sh`.

**Dónde se prueba:** `scripts/tests/push-nightly-data.test.js`, `scripts/tests/pipelines-push-guard.test.js`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptscipush-nightly-datajs)

## pipelines/azure-pipelines-banco.yml

**Qué es:** El pipeline `pipelines/azure-pipelines-banco.yml` que corre de noche el banco de controles y las suites de prueba del arnés.

**Por qué existe:** Lanzarlos desde el arranque de cada máquina los superponía y el aviso gritaba regresiones sin un defecto real. El reporte viaja por git para que todas las máquinas lean la misma foto. Un no medido es aviso naranja, nunca verde.

**Quién la usa:** El nocturno de Azure; `bench-notice.js` lee el reporte. La lista de suites vive en `scripts/tests/suites.json`.

**Dónde se prueba:** `scripts/tests/bench-unmeasured.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#pipelinesazure-pipelines-bancoyml)

## scripts/ci/suites-shard.js

_(scripts/ci/suites-shard.js + scripts/ci/suites-weights.json)_

**Qué es:** El guion que reparte las suites en trabajos paralelos por peso y junta sus resultados.

**Por qué existe:** Un solo trabajo largo se cortaba sin escribir el reporte. Un trabajo que no terminó nunca se da por verde: sus suites quedan como no medidas. Un pedido mal formado sale 2 sin lista.

**Quién la usa:** El nocturno, la validación de pedidos de merge y el veredicto `pr-verdict.js`.

**Dónde se prueba:** `scripts/tests/suites-shard.test.js`, `scripts/tests/pr-suites-shards.test.js`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptscisuites-shardjs)

## scripts/ci/suites-over-limit.json

_(scripts/ci/suites-over-limit.json + scripts/tests/lib/suite-parts.js + scripts/tests/lib/suite-parts.sh)_

**Qué es:** La lista de decisiones sobre las suites que pasan de 45 segundos en la validación de una rama.

**Por qué existe:** Sin decisión la validación se alarga. Cada suite se parte en partes, se manda al nocturno o lleva una excepción firmada por el dueño. Las del laboratorio del instalador corren en la rama sólo si el cambio toca el instalador, según `scripts/ci/heavy-suites.json`.

**Quién la usa:** La validación de ramas, `suites-for-change.js` y quien suma una suite nueva.

**Dónde se prueba:** `scripts/tests/suite-parts.test.js`, `suites-coverage.test.js`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptscisuites-over-limitjson)

## scripts/metrics/sdlc-stage-metrics.js

_(scripts/metrics/sdlc-stage-metrics.js + scripts/nightly/dashboard/dashboard.js + scripts/nightly/projects/snapshot.js + scripts/nightly/projects/state-age.js + scripts/metrics/author-concentration.js)_

**Qué es:** El medidor de etapas del SDLC y el tablero que lo muestra.

**Por qué existe:** Un número sin denominador es el problema que existe; `null` con motivo nunca se cambia por 0. Deriva el tiempo por etapa del historial de git y usa los estados de `scripts/metrics/states.json`.

**Quién la usa:** El nocturno de métricas y el tablero del equipo.

**Dónde se prueba:** `scripts/tests/sdlc-transitions.test.js`, `scripts/tests/dashboard.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptsmetricssdlc-stage-metricsjs)

## scripts/metrics/tokens-digest.js

**Qué es:** Rescata de cada corrida del pipeline su consumo y el hilo comprimido de la conversación, y los guarda junto al volcado de la corrida.

**Por qué existe:** La conversación de Claude Code se borra sola, y sin ella no se sabe por qué costó cada corrida. El rescate la conserva, cuenta el consumo una vez por respuesta y recupera el mensaje de error de cada freno en rojo.

**Quién la usa:** El archivador del cierre (`marker.js`), el arranque de sesión y `marker.js run-check`, que guarda la cola de la salida en `gates.log`.

**Dónde se prueba:** `scripts/tests/tokens-digest.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptsmetricstokens-digestjs)

## scripts/metrics/reviewers-cost.js

**Qué es:** Mide, por corrida y por revisor, cuántos revisores se lanzaron, cuánto tardó cada uno, cuánto devolvió y cuánto consumió.

**Por qué existe:** El arnés lanzaba muchos revisores y no sabía qué costaban. Lo medido y lo estimado nunca se suman; el supuesto de la estimación vive en `reviewers-cost-assumption.json` y vence.

**Quién la usa:** Va encadenado al barrido de `tokens-digest.js` al arrancar la sesión; lo muestra la vista de corridas. A mano: `--corrida` o `--todas`.

**Dónde se prueba:** `scripts/tests/reviewers-cost.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptsmetricsreviewers-costjs)

## scripts/metrics/run-change.js

**Qué es:** Registra qué cambió cada corrida según git: los commits que creó y lo que dejó sin commitear, en cada repo donde escribió.

**Por qué existe:** La conversación guarda el comando de consola pero no el cambio que hizo, así que dejaba afuera la mayor parte. Git sí lo sabe.

**Quién la usa:** El archivador del cierre (`marker.js clear`) lo llama y deja `<volcado>.cambio.json.gz`; lo muestra la vista de corridas.

**Dónde se prueba:** `scripts/tests/run-change.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptsmetricsrun-changejs)

## scripts/metrics/retro-heartbeat.js

**Qué es:** Escribe, sin modelo y en una fracción de segundo, el archivo de retrospectiva de cada merge a main.

**Por qué existe:** Lanzar el capturador con modelo en cada merge costaba mucho tiempo y consumo para archivos casi vacíos. Acá sale la identidad del merge y la última vuelta de revisión; el resto queda en null con quién lo cubre.

**Quién la usa:** El paso 10b de `/tycon-merge-to-main`, tras consultar `retro-pending.js --judge`. El capturador queda a pedido («retro con modelo»).

**Dónde se prueba:** `scripts/tests/retro-heartbeat.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptsmetricsretro-heartbeatjs)

## pipeline.js dod-checker-needed

_(pipeline.js dod-checker-needed · deferrals-open · qa-legibilidad (AgentSkills) + la ficha «los hooks del cierre»)_

**Qué es:** Decide si el cierre de una story necesita el revisor de DoD con modelo, y anota cada decisión de los hooks del cierre.

**Por qué existe:** El cierre releía con modelo lo que ya corre código y casi nunca encontraba algo. Ahora el revisor se invoca sólo si el diff trae un worker, una transacción compleja o tandas en vuelo; ante la duda, invoca.

**Quién la usa:** El pipeline en el cierre; los hooks del cierre dejan constancia en `frenos.jsonl`, que cuenta el reductor del tablero.

**Dónde se prueba:** `scripts/tests/guard-record.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#pipelinejs-dod-checker-needed)

## scripts/lib/validator-verdict.js

_(scripts/lib/validator-verdict.js + el re-loop del validador en pipeline.js (AgentSkills))_

**Qué es:** Deja el veredicto del validador de stories al cierre de cada informe y saca al validador del re-loop tras dos veredictos limpios seguidos.

**Por qué existe:** Era el revisor más caro y los re-loops casi nunca traían algo nuevo. Ante cualquier duda se invoca igual.

**Quién la usa:** `pipeline.js` (línea `validador-reloop` en `gates.log`), el medidor de revisores y la vista de corridas.

**Dónde se prueba:** `scripts/tests/validator-verdict.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptslibvalidator-verdictjs)

## scripts/metrics/step-times.js

_(scripts/metrics/step-times.js + el carril de cada commit en scripts/hooks/unpushed-work-notice.js)_

**Qué es:** Es la única cuenta de cuánto trabajó y cuánto esperó una corrida, separando trabajo, espera humana y tiempo entre pasos; además anota por qué carril entró cada commit.

**Por qué existe:** Antes sólo se marcaba el fin de cada paso, y el tiempo muerto antes de arrancar caía entero en el paso siguiente. También permite comparar el reproceso entre carriles, con el criterio fijado en `scripts/metrics/lane-hypothesis.json`.

**Quién la usa:** La vista de corridas y el tablero; `pipeline.js next` anota el arranque de cada paso.

**Dónde se prueba:** `scripts/tests/step-times.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptsmetricsstep-timesjs)

## scripts/metrics/upload-runs.js

_(scripts/metrics/upload-runs.js + scripts/metrics/download-runs.js)_

**Qué es:** Sube las corridas de cada máquina a un buzón privado de Azure Storage donde todos escriben y sólo leen quienes tienen el rol de lectura; `download-runs.js` las baja.

**Por qué existe:** El hilo trae prompts, rutas del disco y código de cliente, así que no puede viajar por git. La llave de subida sólo crea blobs nuevos: no lee, no lista, no pisa ni borra.

**Quién la usa:** El instalador lo lanza de fondo en cada arranque, tras el barrido de `tokens-digest.js`. La vista de corridas lee lo bajado.

**Dónde se prueba:** `scripts/tests/upload-runs.test.sh`, `scripts/tests/download-runs.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptsmetricsupload-runsjs)

## scripts/lib/people.js

**Qué es:** Es la regla única de quién ve qué corridas en el sitio de la organización.

**Por qué existe:** Cada máquina informa el correo de git de su dev, y hasta que un mantenedor confirma de quién es (en `operations.json`, sólo con la huella del correo) sus corridas las ven sólo quienes mantienen. Así una máquina que cambió de manos no muestra corridas ajenas.

**Quién la usa:** El sitio de la organización, en cada pedido.

**Dónde se prueba:** `scripts/tests/people.test.js`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptslibpeoplejs)

## scripts/lib/guard-record.js

**Qué es:** Hace que cada freno previo a la herramienta deje una línea por decisión (bloqueo, paso, escape o aviso) en `frenos.jsonl`, con sólo la huella del comando.

**Por qué existe:** El tablero sabía cuántas veces se salteó un freno, pero no cuántas veces frenó, y ése es el dato que decide si una regla se retira. Si no puede escribir, el freno decide igual.

**Quién la usa:** Los frenos que corren antes de cada comando; el reductor y el tablero cuentan lo que dejan.

**Dónde se prueba:** `scripts/tests/guard-record.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptslibguard-recordjs)

## scripts/nightly/dashboard/reducer.js

**Qué es:** Cuenta los frenos y los escapes de todas las máquinas desde el buzón de corridas y publica sólo las cuentas.

**Por qué existe:** El tablero contaba una sola máquina. Como lo publicado lo ve todo el equipo, el reductor usa una lista blanca de campos y de valores (en `sources.json`), un piso mínimo y alias sin persona.

**Quién la usa:** El tablero nocturno (`dashboard.js`).

**Dónde se prueba:** `scripts/tests/reducer.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptsnightlydashboardreducerjs)

## test-gate.sh

_(test-gate.sh (AgentSkills) + la ficha «evaluaron el umbral»)_

**Qué es:** Mide la cobertura de pruebas sobre las líneas que la story agregó o modificó y evalúa el 75 % sobre ese número.

**Por qué existe:** Exigirlo sólo sobre archivos nuevos casi nunca juzgaba nada. Sin base, diff o reporte, el resultado es `null` con motivo, nunca 0. El umbral sale de `TYCON_COVERAGE_MIN`, de `team-repos.json` o del valor por defecto.

**Quién la usa:** El control de pruebas del pipeline; el reductor y el tablero cuentan las corridas. En el arnés usa `lib/coverage-wrapper.js` y `lib/node-coverage.js`.

**Dónde se prueba:** `tycon-pipeline/scripts/tests/test-coverage-parser.js`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#test-gatesh)

## scripts/nightly/dashboard/prune.js

_(scripts/nightly/dashboard/prune.js + scripts/metrics/collect-findings.js + scripts/lib/rules-catalog.js)_

**Qué es:** Reparte cada regla del catálogo en estados (candidata a retiro, rota, activa, sin probar…) cruzando hallazgos, corridas de su revisor y el banco.

**Por qué existe:** El catálogo sólo podía crecer: «nunca encontró nada» y «nadie la miró» se veían igual. Nunca retira nada: marca, y decide una persona.

**Quién la usa:** El tablero (pregunta 4). Lo alimentan `scripts/metrics/collect-findings.js`, que lanza el instalador, y `scripts/lib/rules-catalog.js`.

**Dónde se prueba:** `scripts/tests/prune.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptsnightlydashboardprunejs)

## pipelines/azure-pipelines-tablero.yml

_(pipelines/azure-pipelines-tablero.yml + scripts/nightly/dashboard/seal.js + scripts/hooks/dashboard-notice.js)_

**Qué es:** Es el pipeline nocturno de Azure DevOps que genera y publica la página del tablero del equipo, con un sello de fecha y fuentes.

**Por qué existe:** La página se generaba a mano en una máquina, quedaba vieja y mostraba datos de una sola máquina sin avisarlo.

**Quién la usa:** Azure DevOps cada noche; `scripts/hooks/dashboard-notice.js` lee el sello (`seal.js`) al arrancar la sesión y dice de cuándo es.

**Dónde se prueba:** `scripts/tests/dashboard.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#pipelinesazure-pipelines-tableroyml)

## scripts/controls-bench/report-name.js

**Qué es:** Decide el nombre del archivo de la foto del banco según el alcance de la corrida.

**Por qué existe:** Una corrida acotada escribía en el mismo archivo que la foto completa y la pisaba, y el aviso la mostraba como el estado general. Depender de que alguien pase `--json` es un control que no corre. Vive aparte porque requerir `advisor-runner.js` arranca el banco entero.

**Quién la usa:** El banco de controles (`advisor-runner.js`).

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptscontrols-benchreport-namejs)

## scripts/install-tycon-hooks.sh

_(scripts/install-tycon-hooks.sh y scripts/install-tycon-hooks.ps1)_

**Qué es:** Es el auto-instalador idempotente del set canónico de hooks TYCON en `~/.claude/settings.json`; en Windows, `scripts/setup/applier-batch.js` agrupa varios pasos en un solo proceso.

**Por qué existe:** Sin él, cada hook nuevo habría que registrarlo a mano en la máquina de cada dev. Hace backup antes del primer cambio y delega en `sync-claude-md-blocks.sh`.

**Quién la usa:** El hook de `SessionStart`, tras el `git pull`. Se apaga con `TYCON_NO_AUTOINSTALL=1`.

**Dónde se prueba:** `scripts/tests/applier-batch.test.js`, `scripts/tests/installer-ps1.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptsinstall-tycon-hookssh)

## .githooks/pre-commit

_(.githooks/pre-commit + .githooks/pre-commit-checks + scripts/hooks/git-pre-commit-global.sh)_

**Qué es:** Es el único control de commit, en dos partes: la del arnés y la de las skills, que viven en `.githooks/pre-commit-checks`.

**Por qué existe:** Cada parte corre en su proceso, así que una salida temprana no saltea a la otra. Con `core.hooksPath` global git ignora los `.githooks/` de cada repo, y `git-pre-commit-global.sh` lo cierra delegando en el del repo. Incluye el control de paridad Claude-Codex (`build/check.js`).

**Quién la usa:** Git en cada commit; la CI pública corre el mismo control (`public-ci.sh`).

**Dónde se prueba:** `scripts/tests/githook-livefire.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#githookspre-commit)

## scripts/hooks/git-post-commit-global.sh

**Qué es:** Después de cada commit avisa, en una línea, qué archivos quedaron afuera.

**Por qué existe:** Con staging selectivo, un commit no dice nada de lo que deja atrás. Nunca frena ni commitea por vos. Lo que un repo quiere excluir se declara en `.tycon/post-commit-ignore`.

**Quién la usa:** Git, desde `~/.git-hooks/post-commit`, que instala `install-tycon-hooks.sh`. Se apaga con `TYCON_POST_COMMIT_NOTICE=0`.

**Dónde se prueba:** `scripts/tests/githook-livefire.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptshooksgit-post-commit-globalsh)

## scripts/hooks/session-collision-guard.js

**Qué es:** Impide que dos sesiones sobre el mismo checkout toquen git a la vez. Hoy está fuera del set canónico y sólo se prende con `TYCON_SESSION_GUARD=1`.

**Por qué existe:** Con dos chats en el mismo clon, un commit de uno puede llevarse cambios del otro o caer en la rama que el otro acaba de cambiar, sin un solo error de git.

**Quién la usa:** Hook previo a los comandos de git de escritura, sólo si se prende; mira el disco, no la salida.

**Dónde se prueba:** `controls-bench/cases/hooks/38-session-collision-guard.json`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptshookssession-collision-guardjs)

## scripts/lib/canonical-path.js

**Qué es:** Avisa si el clon del arnés no está en la ruta canónica donde el resto del arnés cree que está.

**Por qué existe:** Si el clon queda en otra carpeta nada falla, pero los revisores no encuentran las guías que su procedimiento les manda leer y leen menos, callados. Nunca frena.

**Quién la usa:** El instalador en cada arranque (el `.ps1` de Windows también). Se apaga con `TYCON_NO_CANONICAL_PATH=1`.

**Dónde se prueba:** `scripts/tests/canonical-path.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptslibcanonical-pathjs)

## scripts/lib/harness-repo.js

**Qué es:** Dice si un repo es uno de los repos del arnés, según su remoto `origin` y no según la carpeta.

**Por qué existe:** La exclusión estaba escrita tres veces mirando el nombre de la carpeta: un repo de producto clonado bajo una carpeta con ese nombre pasaba sin controles. Ante un remoto ilegible, la duda va hacia más control.

**Quién la usa:** `retro-pending.js`, `unpushed-work-notice.js` y `lib/story-gate.js`. Quien mantiene declara su clon privado en `paths.maintainers`.

**Dónde se prueba:** `controls-bench/cases/hooks/14-retro-pending.json`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptslibharness-repojs)

## scripts/lib/night-data.js

**Qué es:** Dice en qué clon están, en esta máquina, los datos de la noche y de cuándo es la copia que se lee.

**Por qué existe:** Los avisos buscaban en el clon equivocado, y una pieza muerta se veía igual que una sana. `resolve()` contesta por el clon de mantenimiento (`paths.maintainers`) y `resolveOperations()` por el de operaciones (`paths.operations`).

**Quién la usa:** Los avisos `dependencies-notice.js`, `bench-notice.js` y `dashboard-notice.js`, y los que escriben o leen los registros de la máquina. `scripts/ci/nightly-dod-notice.sh` trae los clones cada noche.

**Dónde se prueba:** `scripts/tests/night-notices.test.js`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptslibnight-datajs)

## scripts/lib/repos-root.js

**Qué es:** Deduce dónde están los repos de esta persona.

**Por qué existe:** Había dos variables para la misma idea y una deducción que suponía el arnés clonado al lado de los proyectos; las auditorías leían «cero repos» como «todo bien». Ahora hay una sola variable, `TYCON_REPOS_ROOT`, y la deducción sale de las sesiones de la persona.

**Quién la usa:** Las auditorías de memoria (`engram-autoheal`, `harness-audit`) y los revisores que buscan plugins hermanos.

**Dónde se prueba:** `scripts/tests/repos-root.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptslibrepos-rootjs)

## scripts/hooks/worktree-sweep.js

**Qué es:** Borra solas las carpetas de trabajo (worktrees de git) que ya se mergearon y están limpias.

**Por qué existe:** Cada story abre la suya y nadie la cierra. No toca el checkout principal ni carpetas con cambios, bloqueadas o recientes; las que tienen trabajo sin mergear sólo las nombra.

**Quién la usa:** El arranque de sesión, una vez por día, y el cierre de la story (`/tycon-pipeline close`, paso 9) con `--story`. Se apaga con `TYCON_WORKTREE_SWEEP=0`.

**Dónde se prueba:** `scripts/tests/worktree-sweep.test.js`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptshooksworktree-sweepjs)

## scripts/hooks/missing-path-notice.js

**Qué es:** Avisa cuando un comando de lectura nombró una ruta que no existe.

**Por qué existe:** Un `ls` a la carpeta equivocada devuelve vacío, y ese vacío se lee como «no hay documentación». El fallo queda silenciado por varias vías, así que el control mira el disco y no la salida. Ante la duda, calla.

**Quién la usa:** El hook que corre tras cada comando de terminal, en Claude Code y en Codex.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptshooksmissing-path-noticejs)

## scripts/hooks/failed-query-notice.js

**Qué es:** Avisa cuando una consulta a un servicio devolvió vacío con el código de salida enmascarado, y cuando el `--project` de un comando `az` no existe.

**Por qué existe:** «No lo veo» no es «no hay»: un `az` que falla con un filtro al final deja la salida vacía, igual a «no hay ninguno».

**Quién la usa:** El hook que corre tras cada comando de terminal; en Windows también tras PowerShell. Se apaga con `TYCON_FAILED_QUERY_NOTICE=0`.

**Dónde se prueba:** `controls-bench/cases/hooks/39-consulta-fallida-notice.json`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptshooksfailed-query-noticejs)

## scripts/hooks/wait-notice.js

**Qué es:** Avisa por Telegram cuando una corrida activa del pipeline queda esperando a una persona.

**Por qué existe:** La espera por una persona es buena parte del reloj de una corrida y nada avisaba: quien la dejaba corriendo se enteraba tarde de una pregunta sin contestar. Cada espera nueva es un mensaje nuevo; sin Telegram prendido no hace nada.

**Quién la usa:** Los hooks de cierre de turno, de pregunta a la persona y de pedido de permiso; manda con `tycon-telegram-notify.sh`. El plazo es `wait_notice.minutes` de `team-repos.json`.

**Dónde se prueba:** `scripts/tests/wait-notice.test.js`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptshookswait-noticejs)

## scripts/hooks/prod-access-guard.js

_(scripts/hooks/prod-access-guard.js + scripts/production/ + guides/produccion-con-permiso.md)_

**Qué es:** Exige que una persona apruebe, de a una, cada consulta a una base de producción, y mantiene la contraseña del Llavero fuera de la conversación.

**Por qué existe:** Autorizada una lectura, el asistente podía seguir con más consultas sin pedir permiso. Un control que hay que acordarse de invocar no corre, así que el freno vive en la configuración administrada.

**Quién la usa:** El hook previo a cada comando. Cada proyecto declara sus servidores en `.tycon/production.json`; lo no declarado se trata como producción.

**Dónde se prueba:** `scripts/tests/prod-access-guard.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptshooksprod-access-guardjs)

## claude-md-blocks/budget.json

_(claude-md-blocks/budget.json + scripts/ci/check-claude-md-blocks.js)_

**Qué es:** Fija el techo, en bytes, de cada bloque del CLAUDE.md que cada máquina carga en cada sesión.

**Por qué existe:** Nada medía cuánto pesaban esos bloques. Subir un techo se escribe acá, con el motivo, en el mismo commit. En `--staged` todo se lee del índice.

**Quién la usa:** El pre-commit del arnés, con `scripts/ci/check-claude-md-blocks.js`, que frena el commit que se pasa.

**Dónde se prueba:** `scripts/tests/claude-md-blocks.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#claude-md-blocksbudgetjson)

## scripts/hooks/harness-bootstrap-heal.sh

**Qué es:** Repara la línea de arranque vieja del `settings.json` que hace los pull pero no llama al instalador.

**Por qué existe:** Esa máquina baja todo el código nuevo y no enchufa nada, sin ningún error. El arreglo no puede viajar por el camino roto, así que entra por los hooks ya registrados que viven en este repo. Repara por append, con backup.

**Quién la usa:** Los hooks ya registrados de las máquinas con la línea vieja. Se apaga con `TYCON_NO_BOOTSTRAP_HEAL=1`.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptshooksharness-bootstrap-healsh)

## tycon-pipeline/scripts/lib/guides-heal.js

_(tycon-pipeline/scripts/lib/guides-heal.js (en agent-skills) + scripts/hooks/branch-guard-notice.js)_

**Qué es:** Es la sanadora que pone al día un clon del arnés trabado.

**Por qué existe:** El pull del arranque se niega a avanzar si un archivo modificado localmente también cambió en origin, y el instalador viejo sigue corriendo sin avisar. El arreglo no puede viajar por el camino roto. Limpia solo los archivos en conflicto y nunca hace `reset --hard`.

**Quién la usa:** `on-prompt.js` (en agent-skills), una vez por sesión; `branch-guard-notice.js` avisa. Se apaga con `TYCON_GUIDES_HEAL=0`.

**Dónde se prueba:** `controls-bench/cases/hooks/37-guides-heal.json`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#tycon-pipelinescriptslibguides-healjs)

## mods/harness-mods/

_(mods/harness-mods/ + scripts/setup/harness/plugin-dirs.js)_

**Qué es:** Es un plugin de Claude Code que dibuja arriba del prompt en qué paso va la corrida del pipeline, con los comandos `/pipeline` y `/mods`.

**Por qué existe:** El cartel vivía en una sola Mac, sin repo ni pruebas, y se perdió. Los pasos son una copia de `STEP_SEQUENCE` de `pipeline.js`.

**Quién la usa:** Todo el equipo, sólo en Claude Code. El instalador suma su carpeta a `CLAUDE_CODE_PLUGIN_DIRS` (`scripts/setup/harness/plugin-dirs.js`).

**Dónde se prueba:** `scripts/tests/harness-mods.test.js`, `scripts/tests/harness-mods-plugin.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#modsharness-mods)

## claude-md-blocks/

_(claude-md-blocks/ + scripts/setup/sync-claude-md-blocks.sh / `scripts/setup/sync-claude-md-blocks.ps1`)_

**Qué es:** Son los bloques team-wide de `~/.claude/CLAUDE.md`, versionados acá y sincronizados a cada máquina entre marcadores `TYCON_BLOCK:<nombre>`.

**Por qué existe:** `~/.claude/CLAUDE.md` no está versionado y las guías se leen a demanda, así que una regla que debe estar siempre cargada no puede vivir en `guides/`. El sync sólo reemplaza lo que está entre sus marcadores.

**Quién la usa:** `install-tycon-hooks.sh`, en cada arranque de sesión, vía `scripts/setup/sync-claude-md-blocks.sh`. Se apaga con `TYCON_NO_CLAUDEMD_SYNC=1`.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#claude-md-blocks)

## scripts/setup/harness/tools.js

_(scripts/setup/harness/tools.js + `scripts/setup/harness/tool-change.js` + `scripts/setup/agents-md-blocks.js` + `scripts/hooks/harness-startup.js`)_

**Qué es:** Detecta qué herramientas hay en la máquina (Claude Code, Codex) y enchufa el arnés a cada una.

**Por qué existe:** Quien sólo usa Codex no podía instalar el arnés. Cada herramienta tiene sus enchufes: `agents-md-blocks.js` deja los bloques en `AGENTS.md`.

**Quién la usa:** `install`, `scripts/setup/harness/tool-change.js` (sumar o sacar una herramienta) y `scripts/hooks/harness-startup.js`.

**Dónde se prueba:** `scripts/tests/harness-tools.test.sh`, `scripts/tests/agents-md-blocks.test.js`

**Guía:** [mecanismo-de-instalacion](maintaining/mecanismo-de-instalacion.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptssetupharnesstoolsjs)

## scripts/setup/harness/harness-node.js — el Node propio del arnés

_(scripts/setup/harness/harness-node.js + `scripts/lib/harness-node.sh` + `scripts/production/node-official.json`)_

**Qué es:** Baja y mantiene el Node 24 oficial que usa el arnés, aparte del de la máquina.

**Por qué existe:** Cada hook arrancaba con el primer `node` del PATH, a veces uno viejo que la CI no prueba. Si no puede bajarlo, el arnés sigue con el del PATH y lo dice; nunca es un rojo.

**Quién la usa:** `runApplierOnly` (`install`, `update`, `apply` y el arranque); los guiones de shell lo toman de `harness-node.sh`. La lista está en `scripts/production/node-official.json`.

**Dónde se prueba:** `scripts/tests/harness-node.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptssetupharnessharness-nodejs--el-node-propio-del-arnés)

## scripts/setup/harness/release.js — el cambio de versión con enlaces (Windows)

_(scripts/setup/harness/release.js + `tycon-home.js` + `bootstrap.js` + `bootstrap-fallback.ps1`)_

**Qué es:** Cambia la versión del arnés en Windows moviendo uniones (enlaces de carpeta) entre las versiones de `~/.tycon/versions/<versión>/`.

**Por qué existe:** Renombrar una carpeta en uso falla en Windows, y la máquina quedaba atrasada sin saberlo. Mac y Linux no cambian.

**Quién la usa:** El aplicador del arnés (`install`, `update`, el arranque) en Windows.

**Dónde se prueba:** `scripts/tests/harness-release-links.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptssetupharnessreleasejs--el-cambio-de-versión-con-enlaces-windows)

## scripts/lib/canonical-path.js — las carpetas de skills y agentes, siempre reales

_(scripts/lib/canonical-path.js `ensureRepoLinks` + `scripts/hooks/branch-guard-notice.js`)_

**Qué es:** Mantiene `~/.claude/skills` y `~/.claude/agents` como carpetas reales, con un enlace por cada skill y cada revisor del arnés.

**Por qué existe:** Con un enlace a la carpeta entera, lo que el dev o su cuenta creaban caía adentro del arnés y la actualización lo perdía. La forma vieja se convierte sola.

**Quién la usa:** El aplicador en cada arranque; `scripts/hooks/branch-guard-notice.js` avisa si falta PowerShell 7.

**Dónde se prueba:** `scripts/tests/repo-links-real-folders.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptslibcanonical-pathjs--las-carpetas-de-skills-y-agentes-siempre-reales)

## scripts/lib/maintainers-sync.js — el arranque pone al día el clon de mantenimiento

_(scripts/lib/maintainers-sync.js + `scripts/hooks/branch-guard-notice.js`)_

**Qué es:** Pone al día, al arrancar y de fondo, el clon del repo de mantenimiento, con `merge --ff-only` y sólo si es seguro.

**Por qué existe:** Ese clon aporta la portada privada y los avisos de la noche, y quedaba días atrás en silencio. Si hay otra rama, cambios propios o divergencia, no lo toca.

**Quién la usa:** `scripts/hooks/branch-guard-notice.js`, sólo en una máquina que declara `paths.maintainers`. Se apaga con `TYCON_MAINTAINERS_SYNC=0`.

**Dónde se prueba:** `scripts/tests/maintainers-sync.test.js`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptslibmaintainers-syncjs--el-arranque-pone-al-día-el-clon-de-mantenimiento)

## guides/response-style.md

**Qué es:** El porqué del bloque de estilo de respuesta (`claude-md-blocks/response-style.md`) que se carga en cada sesión.

**Por qué existe:** Explica la regla madre, el destino obligatorio del detalle y el medidor, y deja escrito qué se dejó en el bloque a propósito para que una poda futura no lo saque.

**Quién la usa:** Quien poda o edita el bloque de estilo, y el medidor de respuestas.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesresponse-stylemd)

## engram-version

_engram-version + scripts/setup/check-engram-version.sh / `scripts/setup/check-engram-version.ps1`_

**Qué es:** Chequeo que mantiene a todo el equipo en la misma versión de engram, la anotada en `engram-version`.

**Por qué existe:** Si una máquina corre otra versión, escribe un formato que el resto no lee y no da error. Atrasada actualiza sola, adelantada avisa, y si hay una más nueva avisa una vez por semana.

**Quién la usa:** `install-tycon-hooks.sh`, en cada arranque.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#engram-version)

## scripts/setup/check-engram-project.sh

**Qué es:** Chequeo de que `.engram/config.json` y `.engram-project` declaran el mismo nombre de proyecto de engram.

**Por qué existe:** Cuando los dos archivos difieren, lo guardado y lo buscado caen en cajones distintos y la falla es silenciosa.

**Quién la usa:** El hook de arranque de sesión, instalado por `install-tycon-hooks.sh`. Avisa, nunca bloquea; con `--strict` sale 1.

**Dónde se prueba:** `scripts/tests/engram-project-check.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptssetupcheck-engram-projectsh)

## scripts/setup/install-effects.json

**Qué es:** La lista declarada de lo que la instalación cambia en la máquina y en cómo trabaja el asistente: `scripts/setup/install-effects.json`.

**Por qué existe:** Escrita a mano, la portada presentaba como completa una lista a la que le faltaban cosas. Ahora cada hook, bloque, ajuste, pieza y tarea tiene una entrada con lo que cambia para la persona.

**Quién la usa:** Las portadas, el cierre de `harness.js install`, el plan y `doctor`.

**Dónde se prueba:** `scripts/tests/install-effects.test.js`

**Guía:** [mecanismo-de-instalacion.md](maintaining/mecanismo-de-instalacion.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptssetupinstall-effectsjson)

## scripts/setup/harness/plan.js y prompt.js

**Qué es:** `plan.js` arma el plan que `install` muestra antes de escribir; `prompt.js` hace la única pregunta del programa.

**Por qué existe:** `install` cambia cómo contesta el asistente en todos los proyectos, así que nada se escribe sin decirlo antes y sin conformidad de la persona.

**Quién la usa:** `harness.js install` y `update`.

**Dónde se prueba:** `scripts/tests/harness-prompt.test.js`, `scripts/tests/harness-plan.test.js` y `scripts/tests/harness-plan.test.sh`

**Guía:** [mecanismo-de-instalacion.md](maintaining/mecanismo-de-instalacion.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptssetupharnessplanjs-y-promptjs)

## scripts/setup/harness/profile.js

**Qué es:** El perfil de instalación, `minimal` o `full`, y cómo se elige y se cambia.

**Por qué existe:** La instalación traía todo o nada, y quien viene de afuera tiene que poder elegir. `install-effects.json` dice qué trae cada perfil.

**Quién la usa:** `harness.js`, el aplicador (`.sh` y `.ps1`) y el sync de bloques.

**Dónde se prueba:** `scripts/tests/harness-profile.test.sh`

**Guía:** [mecanismo-de-instalacion.md](maintaining/mecanismo-de-instalacion.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptssetupharnessprofilejs)

## scripts/setup/harness/questions.js

**Qué es:** Las preguntas de la instalación: perfil, integraciones y paquete del stack.

**Por qué existe:** Sin ellas, quien no decía nada recibía `full` y las integraciones se prendían editando `~/.claude/tycon.json` a mano. Ahora la persona elige al instalar.

**Quién la usa:** `installQuestions` en `harness.js`, en una primera instalación con terminal.

**Dónde se prueba:** `scripts/tests/harness-questions.test.sh`

**Guía:** [mecanismo-de-instalacion.md](maintaining/mecanismo-de-instalacion.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptssetupharnessquestionsjs)

## scripts/publishing/public-files/scripts/setup/get-harness.sh y get-harness.ps1

**Qué es:** Los guiones `get-harness.sh` y `get-harness.ps1`, la puerta de entrada de la portada pública.

**Por qué existe:** Para entrar había que saber elegir una carpeta y leer un error de git. Se bajan, se leen y se corren, nunca con tubería a un shell. Revisan requisitos, clonan el repo y terminan en `harness.js install`.

**Quién la usa:** Quien instala el arnés por primera vez.

**Dónde se prueba:** `scripts/tests/get-harness.test.sh`

**Guía:** [mecanismo-de-instalacion.md](maintaining/mecanismo-de-instalacion.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptspublishingpublic-filesscriptssetupget-harnesssh-y-get-harnessps1)

## scripts/tools/tycon-backfill-followups.js

**Qué es:** Script Node sin dependencias que sincroniza los back-links `followed_up_by:` de las stories padre a partir del `followup_of:` de las hijas. Tiene modo de ensayo, `--apply` y `--render-table`.

**Por qué existe:** Una story firmada puede juntar follow-ups en otra épica sin un back-link visible desde la padre.

**Quién la usa:** Quien mantiene stories; complementa al hook `tycon-story-followup-link` y a la regla del validador de stories.

**Dónde se prueba:** `scripts/tests/backfill-discovery.test.js`

**Guía:** [story-format.md](../story-format.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptstoolstycon-backfill-followupsjs)

## scripts/lib/lint-story-frontmatter.js

**Qué es:** Script Node sin dependencias que verifica que el frontmatter de cada story sea legible por el arnés, con el mismo criterio que usan las demás herramientas.

**Por qué existe:** Cuando el frontmatter no se puede leer, las herramientas saltean la story en silencio. Decide por la identidad declarada, no por el nombre del archivo.

**Quién la usa:** El `.githooks/pre-commit` de cada repo, sobre las stories del commit.

**Dónde se prueba:** `scripts/tests/lint-story-detector.test.sh`

**Guía:** [story-format.md](../story-format.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptsliblint-story-frontmatterjs)

## guides/wiki-topics.md

_guides/wiki-topics.md + scripts/tools/lint-wiki.sh_

**Qué es:** Patrón de wiki por temas: un resumen vivo del repo de specs, con alineación en ambos sentidos entre story y tema, controlada por `lint-wiki.sh`.

**Por qué existe:** Mantiene el resumen del repo alineado con sus stories sin copiar el script a cada repo.

**Quién la usa:** El `.githooks/pre-commit` de los repos de specs que lo adoptan.

**Dónde se prueba:** sin suite propia

**Guía:** [wiki-topics.md](wiki-topics.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guideswiki-topicsmd)

## scripts/hooks/engram-pre-commit.sh

**Qué es:** Hook `PreToolUse` que, antes de `git commit`, corre `engram sync --project <name>` y agrega `.engram/` al commit.

**Por qué existe:** Para que los chunks de memoria viajen con el commit. Sólo actúa si el repo tiene `.engram-project`, y falla abierto. En `git push` no hace nada. Cruza el índice contra sus archivos con `scripts/lib/manifest-engram.js`.

**Quién la usa:** El instalador `install-tycon-hooks.sh` lo registra; corre solo ante cada commit.

**Dónde se prueba:** sin suite propia

**Guía:** [engram-workflow.md](integrations/engram-workflow.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptshooksengram-pre-commitsh)

## scripts/lib/manifest-engram.js

**Qué es:** `scripts/lib/manifest-engram.js`, el criterio único de si el índice de memoria declara todos sus archivos.

**Por qué existe:** Un archivo de memoria sin entrada en el índice no existe para las demás máquinas y no da error. Tiene un comando de reparación que rescata la entrada exacta de la historia de git.

**Quién la usa:** El hook del commit, el aviso diario y el chequeo del portón de CI.

**Dónde se prueba:** su propia suite y el caso `04-rebuild-engram.json` del banco

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptslibmanifest-engramjs)

## guides/ci-gate.md

_guides/ci-gate.md + scripts/ci/tycon-ci-gate.js_

**Qué es:** El portón de CI: los controles del arnés que se pueden decidir con el repo y nada más.

**Por qué existe:** Los controles locales dependen de la máquina; un commit desde la web o sin el arnés los saltea. Chequea frontmatter, evidencia de cierre y constancia de revisores.

**Quién la usa:** Los pipelines de los repos de specs y su `.githooks/pre-commit` (con `--staged`).

**Dónde se prueba:** sin suite propia

**Guía:** [ci-gate.md](ci-gate.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesci-gatemd)

## scripts/hooks/lane-llm-notice.js

**Qué es:** El medidor del clasificador por modelo del portón de carril, con `--report`.

**Por qué existe:** El clasificador decide solo y deja su rastro en un archivo que nadie leería. Este medidor grita sólo cuando el modelo abrió lo que el freno había cerrado.

**Quién la usa:** El hook de arranque y quien decide si el clasificador se queda. Se apaga con `TYCON_LANE_LLM_NOTICE=0`.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptshookslane-llm-noticejs)

## guides/maintaining/controls-bench.md

_guides/maintaining/controls-bench.md + scripts/controls-bench/_

**Qué es:** El banco de pruebas de los controles del arnés, en Claude Code y en Codex.

**Por qué existe:** Un control que hay que acordarse de invocar no corre; los controles necesitan su propio control. Corre casos deterministas (`runner.js`) y disparo real (`live-fire.js`).

**Quién la usa:** Quien mantiene el arnés; el instalador lo chequea a diario y `bench-notice.js` avisa al arranque.

**Dónde se prueba:** `scripts/controls-bench/`

**Guía:** [controls-bench.md](maintaining/controls-bench.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesmaintainingcontrols-benchmd)

## build/

_build/ + adapters/_

**Qué es:** El generador de la migración a Codex: `build/generate.js` traduce los advisors canónicos a configuraciones de Codex.

**Por qué existe:** Los advisors se escriben una vez y Codex los consume traducidos. `build/equivalences.json` es la única tabla de nombres.

**Quién la usa:** El pre-commit del arnés y del repo de skills; `build/check.js` verifica la frescura y `build/check-hook-coverage.js` exige casos en el banco.

**Dónde se prueba:** sin suite propia

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#build)

## guides/maintaining/codex-divergence-inventory.md

**Qué es:** El inventario pieza por pieza de lo que cambia entre Claude Code y Codex: hooks, advisors, pasos, servidores MCP, guías y skills.

**Por qué existe:** Clasifica cada pieza como envoltorio, nombre o inexistente, para que ninguna asimetría exista sin estar escrita.

**Quién la usa:** Quien porta una pieza a Codex, antes de portarla.

**Dónde se prueba:** sin suite propia

**Guía:** [codex-divergence-inventory.md](maintaining/codex-divergence-inventory.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#guidesmaintainingcodex-divergence-inventorymd)

## scripts/publishing/detector.js

_scripts/publishing/_

**Qué es:** El detector de lo que no puede salir en una publicación de código abierto: términos de la lista de denegación privada y patrones genéricos como credenciales, rutas de máquina y emails reales.

**Por qué existe:** Revisarlo a ojo antes de cada publicación no escala. Sale 0 limpio, 1 con hallazgos, 2 si no pudo mirar.

**Quién la usa:** El exportador, la CI del repo público y los frenos de publicación.

**Dónde se prueba:** `scripts/tests/publishing-detector.test.js`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptspublishingdetectorjs)

## scripts/publishing/third-party-skills.json

_scripts/publishing/ + guides/maintaining/publicacion-espejo.md_

**Qué es:** El manifiesto `third-party-skills.json` de las skills de terceros: de quién es cada carpeta y, para lo ajeno, repo de origen, commit y hash de árbol.

**Por qué existe:** Lo ajeno se referencia y no se copia, porque la copia pública no puede llevarlo (algunas tienen licencia propietaria) y cada máquina debe tener el mismo contenido.

**Quién la usa:** `third-party-coverage.js`, `install-third-party.js` (dentro de `install-tycon-hooks.sh`) y `pipeline.js tooling-expected`.

**Dónde se prueba:** `third-party-skills.test.js`, `install-third-party.test.sh`, `third-party-real.test.sh` y `third-party-origin.test.sh`

**Guía:** [publicacion-espejo.md](maintaining/publicacion-espejo.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptspublishingthird-party-skillsjson)

## scripts/publishing/export.js

_scripts/publishing/ + guides/maintaining/publicacion-espejo.md_

**Qué es:** El exportador de la copia pública: arma en una carpeta local una copia sin nombres reales, a partir de los objetos de git. No publica.

**Por qué existe:** Los repos internos siguen siendo la fuente y la historia no se puede publicar. Copia sólo lo que cubre `allowlist.json` y reemplaza nombres reales por anónimos según `replacements.json`.

**Quién la usa:** `mirror.js` y la CI del repo público.

**Dónde se prueba:** `scripts/tests/export.test.js`

**Guía:** [publicacion-espejo.md](maintaining/publicacion-espejo.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptspublishingexportjs)

## scripts/publishing/mirror.js

_scripts/publishing/ + guides/maintaining/publicacion-espejo.md_

**Qué es:** `mirror.js` lleva la copia del exportador al repo público de GitHub por un solo camino, con los subcomandos `plan`, `first`, `sync` y `verify`.

**Por qué existe:** Evita pushes a mano y nombres que se cuelen. El nombre del repo público sale de `public-repos.json`; el token, de `TYCON_MIRROR_TOKEN`.

**Quién la usa:** El pipeline de publicación, con su token emitido por `scripts/publishing/github-app-token.js`.

**Dónde se prueba:** `scripts/tests/mirror.test.js`

**Guía:** [publicacion-espejo.md](maintaining/publicacion-espejo.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptspublishingmirrorjs)

## pipelines/azure-pipelines-public-leak-check.yml

_pipelines/azure-pipelines-public-leak-check.yml + scripts/tests/mirror-pipeline.test.sh + scripts/ci/verify-notice.js + guides/maintaining/publicacion-espejo.md_

**Qué es:** El pipeline que corre `mirror.js`, en dos etapas: una decide y otra publica o verifica.

**Por qué existe:** Nadie publica desde su máquina ni tiene la credencial. La etapa que usa la llave sólo arranca si la primera lo autoriza.

**Quién la usa:** Cada merge a `main`, la corrida diaria y quien lo encola a mano. `scripts/ci/verify-notice.js` arma el aviso por Telegram.

**Dónde se prueba:** `scripts/tests/mirror-pipeline.test.sh`

**Guía:** [publicacion-espejo.md](maintaining/publicacion-espejo.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#pipelinesazure-pipelines-public-leak-checkyml)

## scripts/hooks/public-push-guard.js

_scripts/hooks/public-push-guard.js + scripts/hooks/git-pre-push-global.sh + .githooks/pre-push + scripts/lib/gh-pr.js + scripts/ci/pr-texts.js + guides/maintaining/publicacion-espejo.md_

**Qué es:** El freno antes de publicar: un `pre-push` de git y un freno de `gh` que revisan lo que va a un remoto público.

**Por qué existe:** Con el arnés escrito directo en el repo público, una rama empujada ya es pública y no hay exportador en el medio.

**Quién la usa:** Git en cada empuje (hook global), el freno de `gh` y la validación de cada pedido, en modo `range`.

**Dónde se prueba:** `scripts/tests/public-push-guard.test.js`, `scripts/tests/githook-pre-push.test.sh` y `scripts/tests/gh-pr.test.js`

**Guía:** [publicacion-espejo.md](maintaining/publicacion-espejo.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptshookspublic-push-guardjs)

## scripts/tools/merge-pr.js

_scripts/tools/merge-pr.js + scripts/tests/merge-pr.test.js + skills/tycon-merge-to-main/steps/step-09c-create-pr-github.md + scripts/setup/harness/version-order.js_

**Qué es:** Herramienta con seis órdenes (`plan`, `update-branch`, `bump-version`, `wait-checks`, `message`, `check-version`) que el skill de merge usa cuando el repo vive en GitHub. No crea ni mergea el pedido.

**Por qué existe:** En GitHub el servidor no completa solo un pedido y el número de versión lo pone el merge. Además dice dónde corren las suites completas, según `merge_suites` en `team-repos.json`.

**Quién la usa:** El skill `tycon-merge-to-main`.

**Dónde se prueba:** `scripts/tests/merge-pr.test.js` y `scripts/tests/team-repos.test.js`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptstoolsmerge-prjs)

## scripts/ci/version-tag.js

_scripts/ci/version-tag.js + .github/workflows/version-tag.yml + scripts/setup/harness/version-order.js + scripts/tests/version-by-merge.test.js_

**Qué es:** `version-tag.js tag` pone la etiqueta `v<número>` en la punta de `main` cuando entra un merge.

**Por qué existe:** El número de versión lo pone el merge y no cada pedido: así dos pedidos en paralelo nunca toman el mismo número.

**Quién la usa:** El workflow `version-tag.yml`; las máquinas instaladas leen la etiqueta al buscar novedades.

**Dónde se prueba:** `scripts/tests/version-by-merge.test.js`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptsciversion-tagjs)

## scripts/setup/npm/index.js

_scripts/setup/npm/index.js + home-paths.json + package.json + README.md_

**Qué es:** El instalador del paquete de npm `@tyconsa/harness` (binario `tycon-harness`), que corre con `npx`.

**Por qué existe:** Da una sola línea de instalación igual en Windows, Mac y Linux. El paquete no trae el arnés: lo baja de GitHub y termina en `harness.js install`.

**Quién la usa:** Quien prueba el arnés desde otra organización.

**Dónde se prueba:** `scripts/tests/npx-installer.test.sh` y `scripts/tests/npm-package.test.js`

**Guía:** [paquete-npm.md](maintaining/paquete-npm.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptssetupnpmindexjs)

## .github/workflows/npm-publish.yml

_.github/workflows/npm-publish.yml + scripts/ci/check-public-workflow.js `--publisher` + scripts/tests/npm-publish-workflow.test.js_

**Qué es:** Workflow que publica el paquete del instalador desde la CI pública, sin token guardado, con la constancia de procedencia de npm.

**Por qué existe:** Evita guardar credenciales. Publica en etapas: la versión espera la aprobación de una persona con 2FA. Se habilita con la variable `NPM_PUBLISH_ENABLED`.

**Quién la usa:** La CI pública, en cada push a `main` que toca `scripts/setup/npm/**` o a mano.

**Dónde se prueba:** `scripts/tests/npm-publish-workflow.test.js`

**Guía:** [paquete-npm.md](maintaining/paquete-npm.md)

**Guía:** [guides/maintaining/paquete-npm.md](maintaining/paquete-npm.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#githubworkflowsnpm-publishyml)

## scripts/ci/npm-package-version.js

_scripts/ci/npm-package-version.js + el paso `version` de scripts/ci/public-ci.sh_

**Qué es:** Regla que exige subir la versión semver del paquete de npm cuando un pedido toca `scripts/setup/npm/`.

**Por qué existe:** npm rechaza republicar una versión, y conviene enterarse en el pedido y no después del merge.

**Quién la usa:** El paso `version` de la CI pública.

**Dónde se prueba:** `scripts/tests/npm-package.test.js` y `scripts/tests/public-ci.test.sh`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptscinpm-package-versionjs)

## scripts/setup/harness/team-init.js

_scripts/setup/harness/team-init.js + el comando `harness.js team-init` + getting-started/reference.md_

**Qué es:** El alta guiada de una organización: arma el repo del perfil del equipo con `team-layer.json`, `team-profile.json` y `team-repos.json`.

**Por qué existe:** Copiar el ejemplo a mano es fácil de romper y el error aparece recién al instalar con `--team`. Valida con los mismos lectores que apilan la capa y no escribe nada si algo falla.

**Quién la usa:** Quien da de alta una organización.

**Dónde se prueba:** `scripts/tests/harness-team-init.test.sh` y `scripts/tests/team-stories-templates.test.js`

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptssetupharnessteam-initjs)

## scripts/publishing/new-names.js

_scripts/publishing/ + guides/maintaining/publicacion-espejo.md_

**Qué es:** El freno de nombres reales nuevos en lo que se publica.

**Por qué existe:** Un commit que mete un nombre de cliente, persona, servidor o máquina en un archivo público no se crea. Mira lo neto por archivo, para no frenar retoques. Se apaga con `TYCON_NEW_NAMES=0`.

**Quién la usa:** El pre-commit del arnés y de agent-skills, y el diff de cada pedido. Qué sale lo decide el exportador.

**Dónde se prueba:** `scripts/tests/new-names.test.js`

**Guía:** [publicacion-espejo.md](maintaining/publicacion-espejo.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptspublishingnew-namesjs)

## scripts/lib/legacy-names.js

_scripts/lib/legacy-names.js/.sh/.ps1 + scripts/lib/renames.json + guides/maintaining/nombres-en-ingles.md_

**Qué es:** Biblioteca que hace que un nombre viejo siga andando mientras dura el renombre a inglés, según el mapa `renames.json`.

**Por qué existe:** Renombrar sin romper a nadie: variables, opciones, archivos y claves viejos hacen lo mismo que los nuevos hasta `retire_after`.

**Quién la usa:** Los guiones renombrados y el instalador, que reescribe las rutas viejas de la máquina con `--migrate-machine`.

**Dónde se prueba:** `scripts/tests/legacy-names.test.js` y `scripts/tests/legacy-names-install.test.sh`

**Guía:** [nombres-en-ingles.md](maintaining/nombres-en-ingles.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptsliblegacy-namesjs)

## scripts/ci/legacy-options.sh y legacy-options.js

_scripts/ci/legacy-options.sh/.js + guides/maintaining/nombres-en-ingles.md_

**Qué es:** Traductor que pasa las opciones viejas de los pipelines de producto a las nuevas en los guiones de `scripts/ci`.

**Por qué existe:** Las opciones viejas siguen andando hasta el retiro, también desde el artefacto `arnes-ci`, que no lleva la biblioteca general.

**Quién la usa:** Los guiones de `scripts/ci` llamados por los pipelines de los productos.

**Dónde se prueba:** sin suite propia

**Guía:** [nombres-en-ingles.md](maintaining/nombres-en-ingles.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptscilegacy-optionssh-y-legacy-optionsjs)

## scripts/publishing/spanish-names.js

_scripts/publishing/ + scripts/lib/spanish-words.json + guides/maintaining/nombres-en-ingles.md_

**Qué es:** El freno de nombres nuevos en castellano en lo que ejecuta la máquina: rutas, opciones, subcomandos, variables y claves.

**Por qué existe:** Alguien de afuera tiene que poder usar el núcleo sin leer castellano. Un nombre castellano que ya existía pasa y se renombra por tandas. Se apaga con `TYCON_SPANISH_NAMES=0`.

**Quién la usa:** El pre-commit del arnés y de agent-skills, y el diff de cada pedido.

**Dónde se prueba:** `scripts/tests/spanish-names.test.js`

**Guía:** [nombres-en-ingles.md](maintaining/nombres-en-ingles.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptspublishingspanish-namesjs)

## scripts/publishing/internal-history.js

_scripts/publishing/internal-history.js + internal-history.json + guides/maintaining/publicacion-espejo.md_

**Qué es:** El control de historia interna en la prosa que se publica, y en los comentarios con `--zone comment`.

**Por qué existe:** Un número de story, un código de tanda o un caso con su enlace no llevan a nada desde afuera. Al escribir directo en el repo público, lo escrito es lo que sale.

**Quién la usa:** El pre-commit y el diff de cada pedido de cambio.

**Dónde se prueba:** `scripts/tests/internal-history-guard.test.js` y `scripts/tests/code-comments.test.js`

**Guía:** [publicacion-espejo.md](maintaining/publicacion-espejo.md)

**Detalle:** [en la guía de detalle](maintaining/piezas-en-detalle.md#scriptspublishinginternal-historyjs)
