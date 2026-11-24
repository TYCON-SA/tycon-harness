# La máquina: la instalación, los ganchos de git y los avisos de sesión

Las fichas de este grupo de [las piezas del arnés](../piezas-del-arnes.md). Cada una dice **qué es** la pieza,
**por qué existe**, **quién la usa** y **dónde se prueba**. El detalle de cada pieza está en
[la guía de detalle](../maintaining/piezas-en-detalle.md), bajo el mismo título.

## scripts/install-tycon-hooks.sh

_(scripts/install-tycon-hooks.sh y scripts/install-tycon-hooks.ps1)_

**Qué es:** Es el auto-instalador idempotente del set canónico de hooks TYCON en `~/.claude/settings.json`; en Windows, `scripts/setup/applier-batch.js` agrupa varios pasos en un solo proceso.

**Por qué existe:** Sin él, cada hook nuevo habría que registrarlo a mano en la máquina de cada dev. Hace backup antes del primer cambio y delega en `sync-claude-md-blocks.sh`.

**Quién la usa:** El hook de `SessionStart`, tras el `git pull`. Se apaga con `TYCON_NO_AUTOINSTALL=1`.

**Dónde se prueba:** `scripts/tests/applier-batch.test.js`, `scripts/tests/installer-ps1.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptsinstall-tycon-hookssh)

## .githooks/pre-commit

_(.githooks/pre-commit + .githooks/pre-commit-checks + scripts/hooks/git-pre-commit-global.sh)_

**Qué es:** Es el único control de commit, en dos partes: la del arnés y la de las skills, que viven en `.githooks/pre-commit-checks`.

**Por qué existe:** Cada parte corre en su proceso, así que una salida temprana no saltea a la otra. Con `core.hooksPath` global git ignora los `.githooks/` y los `.git/hooks/` de cada repo, y los tres ganchos globales (`pre-commit`, `post-commit`, `pre-push`) lo cierran corriendo los del repo. Incluye el control de paridad Claude-Codex (`build/check.js`).

**Quién la usa:** Git en cada commit; la CI pública corre el mismo control (`public-ci.sh`).

**Dónde se prueba:** `scripts/tests/githook-livefire.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#githookspre-commit)

## scripts/hooks/git-post-commit-global.sh

**Qué es:** Después de cada commit avisa, en una línea, qué archivos quedaron afuera.

**Por qué existe:** Con staging selectivo, un commit no dice nada de lo que deja atrás. Nunca frena ni commitea por vos. Lo que un repo quiere excluir se declara en `.tycon/post-commit-ignore`.

**Quién la usa:** Git, desde `~/.git-hooks/post-commit`, que instala `install-tycon-hooks.sh`. El aviso se apaga con `TYCON_POST_COMMIT_NOTICE=0`; los post-commit de la persona y del repo corren igual.

**Dónde se prueba:** `scripts/tests/githook-livefire.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptshooksgit-post-commit-globalsh)

## scripts/hooks/session-collision-guard.js

**Qué es:** Avisa al abrir una sesión donde ya vive otra en el mismo checkout; con `TYCON_SESSION_GUARD=1`, frena que las dos toquen git.

**Por qué existe:** Con dos chats en el mismo clon, un commit de uno puede llevarse cambios del otro o caer en la rama que el otro acaba de cambiar, sin un solo error de git.

**Quién la usa:** Hook al abrir la sesión (aviso) y antes de un git que escribe (freno); mira el disco con `scripts/lib/live-sessions.js`.

**Dónde se prueba:** `controls-bench/cases/hooks/38-session-collision-guard.json`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptshookssession-collision-guardjs)

## scripts/lib/canonical-path.js

**Qué es:** Avisa si el clon del arnés no está en la ruta canónica donde el resto del arnés cree que está.

**Por qué existe:** Si el clon queda en otra carpeta nada falla, pero los revisores no encuentran las guías que su procedimiento les manda leer y leen menos, callados. Nunca frena.

**Quién la usa:** El instalador en cada arranque (el `.ps1` de Windows también). Se apaga con `TYCON_NO_CANONICAL_PATH=1`.

**Dónde se prueba:** `scripts/tests/canonical-path.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptslibcanonical-pathjs)

## scripts/lib/harness-repo.js

**Qué es:** Dice si un repo es uno de los repos del arnés, según su remoto `origin` y no según la carpeta.

**Por qué existe:** La exclusión estaba escrita tres veces mirando el nombre de la carpeta: un repo de producto clonado bajo una carpeta con ese nombre pasaba sin controles. Ante un remoto ilegible, la duda va hacia más control.

**Quién la usa:** `retro-pending.js`, `unpushed-work-notice.js` y `lib/story-gate.js`. Quien mantiene declara su clon privado en `paths.maintainers`.

**Dónde se prueba:** `controls-bench/cases/hooks/14-retro-pending.json`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptslibharness-repojs)

## scripts/lib/night-data.js

**Qué es:** Dice en qué clon están, en esta máquina, los datos de la noche y de cuándo es la copia que se lee.

**Por qué existe:** Los avisos buscaban en el clon equivocado, y una pieza muerta se veía igual que una sana. `resolve()` contesta por el clon de mantenimiento (`paths.maintainers`) y `resolveOperations()` por el de operaciones (`paths.operations`).

**Quién la usa:** Los avisos `dependencies-notice.js`, `bench-notice.js` y `dashboard-notice.js`, y los que escriben o leen los registros de la máquina. `scripts/ci/nightly-dod-notice.sh` trae los clones cada noche.

**Dónde se prueba:** `scripts/tests/night-notices.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptslibnight-datajs)

## scripts/lib/repos-root.js

**Qué es:** Deduce dónde están los repos de esta persona.

**Por qué existe:** Había dos variables para la misma idea y una deducción que suponía el arnés clonado al lado de los proyectos; las auditorías leían «cero repos» como «todo bien». Ahora hay una sola variable, `TYCON_REPOS_ROOT`, y la deducción sale de las sesiones de la persona.

**Quién la usa:** Las auditorías de memoria (`engram-autoheal`, `harness-audit`) y los revisores que buscan plugins hermanos.

**Dónde se prueba:** `scripts/tests/repos-root.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptslibrepos-rootjs)

## scripts/hooks/worktree-sweep.js

**Qué es:** Borra solas las carpetas de trabajo (worktrees de git) que ya se mergearon y están limpias.

**Por qué existe:** Cada story abre la suya y nadie la cierra. No toca el checkout principal ni carpetas con cambios, bloqueadas o recientes; las que tienen trabajo sin mergear sólo las nombra.

**Quién la usa:** El arranque de sesión, una vez por día, y el cierre de la story (`/tycon-pipeline close`, paso 9) con `--story`. Se apaga con `TYCON_WORKTREE_SWEEP=0`.

**Dónde se prueba:** `scripts/tests/worktree-sweep.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptshooksworktree-sweepjs)

## scripts/hooks/dev-behind-main-notice.js

**Qué es:** Avisa al abrir la sesión, en una línea, si a `dev` le faltan commits de `main` o si hay trabajo en `dev` que hace una semana no llega a `main`.

**Por qué existe:** Lo avisaba un paso que escribía en el log de una ejecución verde, que nadie abre. Calla lo que es de diseño (los commits de versión, el trabajo en curso) y dice «no sé» con datos viejos.

**Quién la usa:** El arranque de sesión, en los repos de producto. Ponerla al día sigue `guides/git-commit-conventions.md` §«Poner `dev` al día». Se apaga con `TYCON_DEV_BEHIND_NOTICE=0`.

**Dónde se prueba:** `scripts/tests/dev-behind-main-notice.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptshooksdev-behind-main-noticejs)

## scripts/hooks/stuck-pr-notice.js

**Qué es:** Avisa al abrir la sesión qué pedidos con auto-completar llevan más de una hora en choque, o limpios y sin entrar, y los pedidos e issues de gente de afuera en el repo público de GitHub (`scripts/lib/outside-contributions.js`).

**Por qué existe:** Un pedido con auto-completar que choca, o que no entra, no le avisa a nadie: queda abierto días mientras todos creen que entró. Si no pudo leer dice «no medido», nunca calla como si no hubiera nada.

**Quién la usa:** El arranque de sesión, en los repos del arnés. Umbral: `TYCON_STUCK_PR_HOURS` (1). Se apaga con `TYCON_STUCK_PR_NOTICE=0`.

**Dónde se prueba:** `scripts/tests/stuck-pr-notice.test.js`, `scripts/tests/outside-contributions.test.js`

## scripts/lib/outside-contributions.js

**Qué es:** Mide los pedidos y los issues abiertos de gente de afuera del equipo en el repo público, y si la CI de un pedido espera aprobación.

**Por qué existe:** Un pedido desde un fork no corre su CI hasta que alguien del equipo la aprueba, y un issue de afuera no le llega a nadie: sin aviso, el de afuera espera días. Quién es de afuera lo decide la regla del freno de pedidos de afuera (`scripts/lib/external-pr.js`). Sin red, o sin saber quién es del equipo, dice «no medido».

**Quién la usa:** `scripts/hooks/stuck-pr-notice.js` al arrancar y `scripts/nightly/open-prs/open-prs.js --outside-from` en el resumen diario.

**Dónde se prueba:** `scripts/tests/outside-contributions.test.js`

## scripts/hooks/extension-notices.js

**Qué es:** Al abrir la sesión, dice los avisos que traen los paquetes activos en su `notices.json`, sólo en los repos donde aplican y una vez por sesión. El lector es `scripts/lib/extension-notices.js`.

**Por qué existe:** Una regla que sólo sirve en los repos de un producto viajaba en las instrucciones de todas las sesiones, también en las de repos donde no aplica. Ahora la trae el paquete y el núcleo la dice donde corresponde. El aviso va en un archivo aparte del manifiesto, así un arnés anterior no se rompe al recibirlo.

**Quién la usa:** El arranque de sesión. Se apaga con `TYCON_EXTENSION_NOTICES=0`.

**Dónde se prueba:** `scripts/tests/extension-notices.test.js` y el caso 63 del banco

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptshooksextension-noticesjs)

## scripts/hooks/missing-path-notice.js

**Qué es:** Avisa cuando un comando de lectura nombró una ruta que no existe.

**Por qué existe:** Un `ls` a la carpeta equivocada devuelve vacío, y ese vacío se lee como «no hay documentación». El fallo queda silenciado por varias vías, así que el control mira el disco y no la salida. Ante la duda, calla.

**Quién la usa:** El hook que corre tras cada comando de terminal, en Claude Code y en Codex.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptshooksmissing-path-noticejs)

## scripts/hooks/deprecated-session-notice.js

**Qué es:** Al abrir la sesión, le dice al modelo qué código del repo está deprecado, con su nivel y su motivo, y la regla.

**Por qué existe:** Un agente que busca «cómo se hace X acá» encuentra el código viejo y lo copia. Si el repo lo declara (clave `deprecated` de `.tycon/advisors.yaml`, commiteada), el arranque lo dice antes de que busque. Una vez por día y repo avisa las entradas que ya no apuntan a nada o pasaron su fecha de revisión.

**Quién la usa:** El arranque de sesión, en Claude Code y en Codex.

**Dónde se prueba:** `scripts/tests/deprecated-notices.test.js` y el caso 64 del banco

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptshooksdeprecated-session-noticejs)

## scripts/hooks/deprecated-read-notice.js

**Qué es:** Cuando el agente lee un archivo deprecado, le agrega el motivo y que no lo use de ejemplo.

**Por qué existe:** La lista del arranque se pierde entre muchas cosas; el aviso llega justo cuando el archivo entra en la conversación. Una vez por archivo y sesión.

**Quién la usa:** El hook que corre tras cada lectura (Read) y cada comando de terminal; en Codex, sólo la terminal.

**Dónde se prueba:** `scripts/tests/deprecated-notices.test.js` y el caso 64 del banco

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptshooksdeprecated-read-noticejs)

## skills/tycon-pipeline/scripts/lib/deprecated.js

**Qué es:** Contesta «¿esta ruta está deprecada?»: la lista commiteada del repo y la marca `harness-deprecated:` en la cabecera de un archivo.

**Por qué existe:** Una sola respuesta para todos los que la necesitan: el arranque, el aviso al leer, los revisores, el validador (VAL-C9), mech-check (DEPR-W1), el freno de edición y la noche. Lo que no puede mirar no clasifica nada.

**Quién la usa:** Los avisos del código deprecado, `pipeline.js` y `on-deprecated-edit.js`.

**Dónde se prueba:** `skills/tycon-pipeline/scripts/tests/deprecated.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#skillstycon-pipelinescriptslibdeprecatedjs)

## skills/tycon-pipeline/scripts/on-deprecated-edit.js

**Qué es:** Editar código deprecado sin una historia que lo pida avisa o frena, según el repo.

**Por qué existe:** Congelado se toca sólo para arreglarlo, con una historia que lo declare y traiga `deprecated_reason:`; muerto no se toca. Borrarlo o moverlo pasa siempre: es el desenlace que se busca.

**Quién la usa:** El despachador de ediciones y la puerta de la terminal (`on-bash-write-gate.js`).

**Dónde se prueba:** `skills/tycon-pipeline/scripts/tests/deprecated-gates.test.js` y el caso 64 del banco

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#skillstycon-pipelinescriptson-deprecated-editjs)

## scripts/hooks/cover-secrets.js

**Qué es:** Cambia por `«tapado»` los valores reales de los secretos de la máquina en lo que devuelven los comandos, las lecturas y las búsquedas.

**Por qué existe:** Un `env` filtrado o un guion imprimían un token, y la conversación sube al buzón. Un freno no ve lo que hace un guion; tapar mira el resultado.

**Quién la usa:** El hook de cada herramienta; `upload-runs.js`, con la misma biblioteca (`known-secrets.js`). Se apaga con `TYCON_COVER_SECRETS=0`.

**Dónde se prueba:** `scripts/tests/cover-secrets.test.js`, `controls-bench/cases/hooks/78-cover-secrets.json`

**Detalle:** [en la guía de detalle](../maintaining/piezas-en-detalle.md#scriptshookscover-secretsjs)

## scripts/hooks/failed-query-notice.js

**Qué es:** Avisa cuando una consulta a un servicio devolvió vacío con el código de salida enmascarado, y cuando el `--project` de un comando `az` no existe.

**Por qué existe:** «No lo veo» no es «no hay»: un `az` que falla con un filtro al final deja la salida vacía, igual a «no hay ninguno».

**Quién la usa:** El hook que corre tras cada comando de terminal; en Windows también tras PowerShell. Se apaga con `TYCON_FAILED_QUERY_NOTICE=0`.

**Dónde se prueba:** `controls-bench/cases/hooks/39-consulta-fallida-notice.json`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptshooksfailed-query-noticejs)

## scripts/hooks/context-size-notice.js

**Qué es:** Pasados 300 mil tokens, pide recomendar `/clear` al terminar el paso. No frena.

**Por qué existe:** Cada mensaje re-lee todo el contexto de la sesión.

**Quién la usa:** Los hooks del mensaje y del arranque. Umbral: `context_notice.tokens`.

**Dónde se prueba:** `scripts/tests/context-size-notice.test.js`

## scripts/hooks/wait-notice.js

**Qué es:** Avisa por Telegram cuando una corrida activa del pipeline queda esperando a una persona.

**Por qué existe:** La espera por una persona es buena parte del reloj de una corrida y nada avisaba: quien la dejaba corriendo se enteraba tarde de una pregunta sin contestar. Cada espera nueva es un mensaje nuevo; sin Telegram prendido no hace nada.

**Quién la usa:** Los hooks de cierre de turno, de pregunta y de permiso. Plazo: `wait_notice.minutes`.

**Dónde se prueba:** `scripts/tests/wait-notice.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptshookswait-noticejs)

## scripts/hooks/prod-access-guard.js

_(scripts/hooks/prod-access-guard.js + scripts/production/ + guides/production-with-permission.md)_

**Qué es:** Exige que una persona apruebe, de a una, cada consulta a una base de producción, y mantiene la contraseña del Llavero fuera de la conversación.

**Por qué existe:** Autorizada una lectura, el asistente podía seguir con más consultas sin pedir permiso. Un control que hay que acordarse de invocar no corre, así que el freno vive en la configuración administrada.

**Quién la usa:** El hook previo a cada comando. Cada proyecto declara sus servidores en `.tycon/production.json`; lo no declarado se trata como producción.

**Dónde se prueba:** `scripts/tests/prod-access-guard.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptshooksprod-access-guardjs)

## claude-md-blocks/budget.json

_(claude-md-blocks/budget.json + scripts/ci/check-claude-md-blocks.js)_

**Qué es:** Fija el techo, en bytes, de cada bloque del CLAUDE.md que cada máquina carga en cada sesión.

**Por qué existe:** Nada medía cuánto pesaban esos bloques. Subir un techo se escribe acá, con el motivo, en el mismo commit. En `--staged` todo se lee del índice.

**Quién la usa:** El pre-commit del arnés, con `scripts/ci/check-claude-md-blocks.js`, que frena el commit que se pasa.

**Dónde se prueba:** `scripts/tests/claude-md-blocks.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#claude-md-blocksbudgetjson)

## scripts/hooks/harness-bootstrap-heal.sh

**Qué es:** Repara la línea de arranque vieja del `settings.json` que hace los pull pero no llama al instalador.

**Por qué existe:** Esa máquina baja todo el código nuevo y no enchufa nada, sin ningún error. El arreglo no puede viajar por el camino roto, así que entra por los hooks ya registrados que viven en este repo. Repara por append, con backup.

**Quién la usa:** Los hooks ya registrados de las máquinas con la línea vieja. Se apaga con `TYCON_NO_BOOTSTRAP_HEAL=1`.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptshooksharness-bootstrap-healsh)

## tycon-pipeline/scripts/lib/guides-heal.js

_(tycon-pipeline/scripts/lib/guides-heal.js (en agent-skills) + scripts/hooks/branch-guard-notice.js)_

**Qué es:** Es la sanadora que pone al día un clon del arnés trabado.

**Por qué existe:** El pull del arranque se niega a avanzar si un archivo modificado localmente también cambió en origin, y el instalador viejo sigue corriendo sin avisar. El arreglo no puede viajar por el camino roto. Limpia solo los archivos en conflicto y nunca hace `reset --hard`.

**Quién la usa:** `on-prompt.js` (en agent-skills), una vez por sesión; `branch-guard-notice.js` avisa. Se apaga con `TYCON_GUIDES_HEAL=0`.

**Dónde se prueba:** `controls-bench/cases/hooks/37-guides-heal.json`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#tycon-pipelinescriptslibguides-healjs)

## mods/harness-mods/

_(mods/harness-mods/ + scripts/setup/harness/plugin-dirs.js)_

**Qué es:** Es un plugin de Claude Code que dibuja arriba del prompt en qué paso va la corrida del pipeline, con los comandos `/pipeline` y `/mods`.

**Por qué existe:** El cartel vivía en una sola Mac, sin repo ni pruebas, y se perdió. Los pasos son una copia de `STEP_SEQUENCE` de `pipeline.js`.

**Quién la usa:** Todo el equipo, sólo en Claude Code. El instalador suma su carpeta a `CLAUDE_CODE_PLUGIN_DIRS` (`scripts/setup/harness/plugin-dirs.js`).

**Dónde se prueba:** `scripts/tests/harness-mods.test.js`, `scripts/tests/harness-mods-plugin.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#modsharness-mods)

## claude-md-blocks/

_(claude-md-blocks/ + scripts/setup/sync-claude-md-blocks.sh / `scripts/setup/sync-claude-md-blocks.ps1`)_

**Qué es:** Son los bloques team-wide de `~/.claude/CLAUDE.md`, versionados acá y sincronizados a cada máquina entre marcadores `TYCON_BLOCK:<nombre>`.

**Por qué existe:** `~/.claude/CLAUDE.md` no está versionado y las guías se leen a demanda, así que una regla que debe estar siempre cargada no puede vivir en `guides/`. El sync sólo reemplaza lo que está entre sus marcadores.

**Quién la usa:** `install-tycon-hooks.sh`, en cada arranque de sesión, vía `scripts/setup/sync-claude-md-blocks.sh`. Se apaga con `TYCON_NO_CLAUDEMD_SYNC=1`.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#claude-md-blocks)

## scripts/setup/harness/tools.js

_(scripts/setup/harness/tools.js + `scripts/setup/harness/tool-change.js` + `scripts/setup/agents-md-blocks.js` + `scripts/hooks/harness-startup.js`)_

**Qué es:** Detecta qué herramientas hay en la máquina (Claude Code, Codex) y enchufa el arnés a cada una.

**Por qué existe:** Quien sólo usa Codex no podía instalar el arnés. Cada herramienta tiene sus enchufes: `agents-md-blocks.js` deja los bloques en `AGENTS.md`.

**Quién la usa:** `install`, `scripts/setup/harness/tool-change.js` (sumar o sacar una herramienta) y `scripts/hooks/harness-startup.js`.

**Dónde se prueba:** `scripts/tests/harness-tools.test.sh`, `scripts/tests/agents-md-blocks.test.js`

**Guía:** [installation-mechanism](../maintaining/installation-mechanism.md)

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptssetupharnesstoolsjs)

## scripts/setup/harness/harness-node.js — el Node propio del arnés

_(scripts/setup/harness/harness-node.js + `scripts/lib/harness-node.sh` + `scripts/production/node-official.json`)_

**Qué es:** Baja y mantiene el Node 24 oficial que usa el arnés, aparte del de la máquina.

**Por qué existe:** Cada hook arrancaba con el primer `node` del PATH, a veces uno viejo que la CI no prueba. Si no puede bajarlo, el arnés sigue con el del PATH y lo dice; nunca es un rojo.

**Quién la usa:** `runApplierOnly` (`install`, `update`, `apply` y el arranque); los guiones de shell lo toman de `harness-node.sh`. La lista está en `scripts/production/node-official.json`.

**Dónde se prueba:** `scripts/tests/harness-node.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptssetupharnessharness-nodejs--el-node-propio-del-arnés)

## scripts/setup/harness/release.js — el cambio de versión con enlaces (Windows)

_(scripts/setup/harness/release.js + `tycon-home.js` + `bootstrap.js` + `bootstrap-fallback.ps1`)_

**Qué es:** Cambia la versión del arnés en Windows moviendo uniones (enlaces de carpeta) entre las versiones de `~/.tycon/versions/<versión>/`.

**Por qué existe:** Renombrar una carpeta en uso falla en Windows, y la máquina quedaba atrasada sin saberlo. Mac y Linux no cambian.

**Quién la usa:** El aplicador del arnés (`install`, `update`, el arranque) en Windows.

**Dónde se prueba:** `scripts/tests/harness-release-links.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptssetupharnessreleasejs--el-cambio-de-versión-con-enlaces-windows)

## scripts/lib/canonical-path.js — las carpetas de skills y agentes, siempre reales

_(scripts/lib/canonical-path.js `ensureRepoLinks` + `scripts/hooks/branch-guard-notice.js`)_

**Qué es:** Mantiene `~/.claude/skills` y `~/.claude/agents` como carpetas reales, con un enlace por cada skill y cada revisor del arnés.

**Por qué existe:** Con un enlace a la carpeta entera, lo que el dev o su cuenta creaban caía adentro del arnés y la actualización lo perdía. La forma vieja se convierte sola.

**Quién la usa:** El aplicador en cada arranque; `scripts/hooks/branch-guard-notice.js` avisa si falta PowerShell 7.

**Dónde se prueba:** `scripts/tests/repo-links-real-folders.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptslibcanonical-pathjs--las-carpetas-de-skills-y-agentes-siempre-reales)

## scripts/lib/maintainers-sync.js — el arranque pone al día el clon de mantenimiento

_(scripts/lib/maintainers-sync.js + `scripts/hooks/branch-guard-notice.js`)_

**Qué es:** Pone al día, al arrancar y de fondo, el clon del repo de mantenimiento, con `merge --ff-only` y sólo si es seguro.

**Por qué existe:** Ese clon aporta la portada privada y los avisos de la noche, y quedaba días atrás en silencio. Si hay otra rama, cambios propios o divergencia, no lo toca.

**Quién la usa:** `scripts/hooks/branch-guard-notice.js`, sólo en una máquina que declara `paths.maintainers`. Se apaga con `TYCON_MAINTAINERS_SYNC=0`.

**Dónde se prueba:** `scripts/tests/maintainers-sync.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptslibmaintainers-syncjs--el-arranque-pone-al-día-el-clon-de-mantenimiento)

## guides/response-style.md

**Qué es:** El porqué del bloque de estilo de respuesta (`claude-md-blocks/response-style.md`) que se carga en cada sesión.

**Por qué existe:** Explica la regla madre, el destino obligatorio del detalle y el medidor, y deja escrito qué se dejó en el bloque a propósito para que una poda futura no lo saque.

**Quién la usa:** Quien poda o edita el bloque de estilo, y el medidor de respuestas.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#guidesresponse-stylemd)

## engram-version

_engram-version + scripts/setup/check-engram-version.sh / `scripts/setup/check-engram-version.ps1`_

**Qué es:** Chequeo que mantiene a todo el equipo en la misma versión de engram, la anotada en `engram-version`.

**Por qué existe:** Si una máquina corre otra versión, escribe un formato que el resto no lee y no da error. Atrasada actualiza sola, adelantada avisa, y si hay una más nueva avisa una vez por semana.

**Quién la usa:** `install-tycon-hooks.sh`, en cada arranque.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#engram-version)

## scripts/setup/check-engram-project.sh

**Qué es:** Chequeo de que `.engram/config.json` y `.engram-project` declaran el mismo nombre de proyecto de engram.

**Por qué existe:** Cuando los dos archivos difieren, lo guardado y lo buscado caen en cajones distintos y la falla es silenciosa.

**Quién la usa:** El hook de arranque de sesión, instalado por `install-tycon-hooks.sh`. Avisa, nunca bloquea; con `--strict` sale 1.

**Dónde se prueba:** `scripts/tests/engram-project-check.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptssetupcheck-engram-projectsh)

## scripts/setup/install-effects.json

**Qué es:** La lista declarada de lo que la instalación cambia en la máquina y en cómo trabaja el asistente: `scripts/setup/install-effects.json`.

**Por qué existe:** Escrita a mano, la portada presentaba como completa una lista a la que le faltaban cosas. Ahora cada hook, bloque, ajuste, pieza y tarea tiene una entrada con lo que cambia para la persona.

**Quién la usa:** Las portadas, el cierre de `harness.js install`, el plan y `doctor`.

**Dónde se prueba:** `scripts/tests/install-effects.test.js`

**Guía:** [installation-mechanism.md](../maintaining/installation-mechanism.md)

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptssetupinstall-effectsjson)

## scripts/setup/harness/plan.js y prompt.js

**Qué es:** `plan.js` arma el plan que `install` muestra antes de escribir; `prompt.js` hace la única pregunta del programa.

**Por qué existe:** `install` cambia cómo contesta el asistente en todos los proyectos, así que nada se escribe sin decirlo antes y sin conformidad de la persona.

**Quién la usa:** `harness.js install` y `update`.

**Dónde se prueba:** `scripts/tests/harness-prompt.test.js`, `scripts/tests/harness-plan.test.js` y `scripts/tests/harness-plan.test.sh`

**Guía:** [installation-mechanism.md](../maintaining/installation-mechanism.md)

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptssetupharnessplanjs-y-promptjs)

## scripts/setup/harness/profile.js

**Qué es:** El perfil de instalación, `minimal` o `full`, y cómo se elige y se cambia.

**Por qué existe:** La instalación traía todo o nada, y quien viene de afuera tiene que poder elegir. `install-effects.json` dice qué trae cada perfil.

**Quién la usa:** `harness.js`, el aplicador (`.sh` y `.ps1`) y el sync de bloques.

**Dónde se prueba:** `scripts/tests/harness-profile.test.sh`

**Guía:** [installation-mechanism.md](../maintaining/installation-mechanism.md)

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptssetupharnessprofilejs)

## scripts/setup/harness/read-permissions.js

**Qué es:** Las reglas de lectura del arnés en `permissions.allow` de `~/.claude/settings.json`: el árbol, sus dos enlaces y cada skill enlazada a él.

**Por qué existe:** La primera historia frenaba en el cuadro «Allow this read?» de Claude Code al leer una guía del arnés. Las reglas dejan leer esas carpetas y nada más; editar sigue preguntando. Codex no lo necesita: lee sin preguntar.

**Quién la usa:** `harness.js` al instalar y actualizar (después del aplicador, en los dos perfiles), el registro y la desinstalación. El aplicador suelto no la usa. Interruptor: `TYCON_NO_READ_PERMISSIONS=1`.

**Dónde se prueba:** `scripts/tests/read-permissions.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptssetupharnessread-permissionsjs)

## scripts/setup/harness/questions.js

**Qué es:** Las preguntas de la instalación: perfil, integraciones y paquete del stack.

**Por qué existe:** Sin ellas, quien no decía nada recibía `full` y las integraciones se prendían editando `~/.claude/tycon.json` a mano. Ahora la persona elige al instalar.

**Quién la usa:** `installQuestions` en `harness.js`, en una primera instalación con terminal.

**Dónde se prueba:** `scripts/tests/harness-questions.test.sh`

**Guía:** [installation-mechanism.md](../maintaining/installation-mechanism.md)

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptssetupharnessquestionsjs)

## scripts/setup/get-harness.sh y get-harness.ps1

**Qué es:** Los guiones `get-harness.sh` y `get-harness.ps1`, la puerta de entrada de la portada pública.

**Por qué existe:** Para entrar había que saber elegir una carpeta y leer un error de git. Se bajan, se leen y se corren, nunca con tubería a un shell. Revisan requisitos, clonan el repo y terminan en `harness.js install`.

**Quién la usa:** Quien instala el arnés por primera vez.

**Dónde se prueba:** `scripts/tests/get-harness.test.sh`

**Guía:** [installation-mechanism.md](../maintaining/installation-mechanism.md)

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptssetupget-harnesssh-y-get-harnessps1)
