# Las piezas del arnés

Este es el índice de las piezas. Cada pieza tiene su ficha en el archivo de su grupo, en `guides/pieces/`; abajo está
cada grupo con la lista de sus piezas. Cada ficha dice, en pocas líneas, **qué es** la pieza, **por qué existe**,
**quién la usa** y **dónde se prueba**, con su guía si la tiene. Su título `## <ruta>` es la pieza: se busca por nombre, y en la lista va con los archivos que la acompañan.
Una ficha nueva va al grupo que le toca y se suma a su lista; un grupo lleno se parte en dos.
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
  guides/integrations/       las integraciones opcionales (Azure DevOps, el registro de horas, CodeGraph, engram, instintos)
  guides/maintaining/        las de quien mantiene el arnés
  guides/pieces/             las fichas de cada pieza, un archivo por grupo (el índice es guides/piezas-del-arnes.md)
claude-md-blocks/ · commands/ · adapters/ · build/
mods/harness-mods/          los mods de Claude Code del arnés (el cartel de la corrida, /pipeline, /mods)
pipelines/                  los seis azure-pipelines-*.yml
  pipelines/templates/      sus pedazos compartidos
packs/                      sólo su README: los paquetes de un equipo (revisores, skills, guías, plantillas) llegan con su perfil
examples/packs/             paquetes de ejemplo para copiar: no se instalan ni se activan
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

## Las guías, los paquetes y la configuración

En [pieces/guides.md](pieces/guides.md):

- [guides/piezas-del-arnes.md](pieces/guides.md#guidespiezas-del-arnesmd)
- [guides/what-the-harness-does.md](pieces/guides.md#guideswhat-the-harness-doesmd)
- [artifacts/mapa-arnes.html](pieces/guides.md#artifactsmapa-arneshtml)
- [story-format.md](pieces/guides.md#story-formatmd)
- [guides/integrations/engram-workflow.md](pieces/guides.md#guidesintegrationsengram-workflowmd)
- [guides/git-commit-conventions.md](pieces/guides.md#guidesgit-commit-conventionsmd)
- [guides/workflow-orchestration.md](pieces/guides.md#guidesworkflow-orchestrationmd)
- [packs/bizuit/guides/bizuit-plugin-dotnet.md](pieces/guides.md)
- [packs/bizuit/guides/bizuit-plugin-react.md](pieces/guides.md)
- [packs/bizuit/guides/bizuit-plugin-nextjs.md](pieces/guides.md)
- [packs/bizuit/guides/bizuit-bpmn-spec-contract.md](pieces/guides.md)
- [guides/agent-architecture.md](pieces/guides.md#guidesagent-architecturemd)
- [packs/ (agent-skills) — paquetes de revisores](pieces/guides.md#packs-agent-skills--paquetes-de-revisores)
- [scripts/lib/tycon-config.js + team-profile.json — la configuración del arnés](pieces/guides.md#scriptslibtycon-configjs--team-profilejson--la-configuración-del-arnés)
- [guides/reviewer-rules.md](pieces/guides.md#guidesreviewer-rulesmd)
- [guides/maintaining/bmad-contract.md](pieces/guides.md#guidesmaintainingbmad-contractmd)
- [guides/advisor-rules-catalog.md](pieces/guides.md#guidesadvisor-rules-catalogmd)
- [guides/accov-governance-protocol.md](pieces/guides.md#guidesaccov-governance-protocolmd)
- [guides/guide-update-proposals.md](pieces/guides.md#guidesguide-update-proposalsmd)
- [packs/bizuit/guides/dotnet-hooks.md](pieces/guides.md#packsbizuitguidesdotnet-hooksmd)
- [guides/definition-of-done.md](pieces/guides.md#guidesdefinition-of-donemd)
- [guides/test-execution-discipline.md](pieces/guides.md#guidestest-execution-disciplinemd)
- [guides/git-worktrees.md](pieces/guides.md#guidesgit-worktreesmd) _(guides/git-worktrees.md + scripts/tools/tycon-worktree.sh)_

## Los controles de CI, las versiones y los despliegues

En [pieces/ci.md](pieces/ci.md):

- [scripts/lib/tycon-telegram-notify.sh](pieces/ci.md#scriptslibtycon-telegram-notifysh)
- [scripts/ci/release-notes.sh](pieces/ci.md#scriptscirelease-notessh)
- [scripts/ci/recompute-zip-notes.sh](pieces/ci.md#scriptscirecompute-zip-notessh)
- [scripts/tools/release-notes-parity.js](pieces/ci.md#scriptstoolsrelease-notes-parityjs)
- [scripts/ci/publish-bump.sh](pieces/ci.md#scriptscipublish-bumpsh)
- [scripts/lib/meter-backup.sh](pieces/ci.md#scriptslibmeter-backupsh)
- [packs/bizuit/guides/deuda-de-pruebas-formularios.md](pieces/ci.md#packsbizuitguidesdeuda-de-pruebas-formulariosmd)
- [scripts/ci/affected-forms.js](pieces/ci.md#scriptsciaffected-formsjs)
- [scripts/ci/typecheck-forms.js](pieces/ci.md#scriptscitypecheck-formsjs)
- [scripts/ci/forms-to-version.sh](pieces/ci.md#scriptsciforms-to-versionsh)
- [scripts/ci/backend-to-version.sh](pieces/ci.md#scriptscibackend-to-versionsh)
- [scripts/ci/label-prs.sh](pieces/ci.md#scriptscilabel-prssh)
- [scripts/ci/nightly-dod-notice.sh](pieces/ci.md#scriptscinightly-dod-noticesh)
- [scripts/ci/sql-compile.js](pieces/ci.md#scriptscisql-compilejs)
- [scripts/ci/check-bash32-quoting.sh](pieces/ci.md#scriptscicheck-bash32-quotingsh)
- [scripts/ci/public-ci.sh](pieces/ci.md#scriptscipublic-cish)
- [scripts/ci/run-base-controls.sh](pieces/ci.md#scriptscirun-base-controlssh) _(scripts/ci/run-base-controls.sh + scripts/ci/controls-from-base.json + scripts/ci/bench-against-base.js + el paso `repo-lint` de public-ci.sh con `--base`)_
- [scripts/tests/clean-machine.test.sh](pieces/ci.md#scriptstestsclean-machinetestsh) _(scripts/tests/clean-machine.test.sh + scripts/tests/clean-machine/ + scripts/tests/fixtures/example-repo/)_
- [scripts/ci/check-artifact-paths.js](pieces/ci.md#scriptscicheck-artifact-pathsjs)
- [scripts/ci/rollback-guard.sh](pieces/ci.md#scriptscirollback-guardsh)
- [scripts/ci/smoke-plugin.sh](pieces/ci.md#scriptscismoke-pluginsh) _(scripts/ci/smoke-plugin.sh + scripts/ci/smoke-forms.sh)_
- [scripts/ci/deploy-plugin.sh](pieces/ci.md#scriptscideploy-pluginsh)
- [scripts/ci/deploy-record.sh](pieces/ci.md#scriptscideploy-recordsh)
- [scripts/ci/check-product-parity.js](pieces/ci.md#scriptscicheck-product-parityjs)
- [scripts/ci/check-trigger-without-docs.js](pieces/ci.md#scriptscicheck-trigger-without-docsjs)
- [scripts/ci/check-tests-without-ci.js](pieces/ci.md#scriptscicheck-tests-without-cijs)
- [scripts/tests/hidden-window.test.js](pieces/ci.md#scriptstestshidden-windowtestjs)

## Las bibliotecas del pipeline

En [pieces/pipeline.md](pieces/pipeline.md):

- [skills/tycon-pipeline/scripts/lib/first-story.js — la primera historia de la máquina](pieces/pipeline.md#skillstycon-pipelinescriptslibfirst-storyjs--la-primera-historia-de-la-máquina)
- [skills/tycon-pipeline/scripts/lib/models.js — el modelo de cada trabajo del pipeline](pieces/pipeline.md#skillstycon-pipelinescriptslibmodelsjs--el-modelo-de-cada-trabajo-del-pipeline)
- [scripts/lib/models-env.js — las variables de Claude Code sobre otro proveedor](pieces/pipeline.md#scriptslibmodels-envjs--las-variables-de-claude-code-sobre-otro-proveedor)
- [scripts/lib/nightly-model.js — el modelo del proceso de la noche](pieces/pipeline.md#scriptslibnightly-modeljs--el-modelo-del-proceso-de-la-noche)
- [skills/tycon-pipeline/scripts/lib/run-size.js — el tamaño de la ejecución](pieces/pipeline.md#skillstycon-pipelinescriptslibrun-sizejs--el-tamaño-de-la-corrida)
- [skills/tycon-pipeline/scripts/lib/suite-times.js — tiempos y suites a la vez](pieces/pipeline.md#skillstycon-pipelinescriptslibsuite-timesjs--tiempos-y-suites-a-la-vez)
- [skills/tycon-pipeline/scripts/lib/story-review-record.js — la revisión de la historia antes de programar](pieces/pipeline.md#skillstycon-pipelinescriptslibstory-review-recordjs--la-revisión-de-la-historia-antes-de-programar)
- [skills/tycon-pipeline/scripts/lib/runtime-waiver.js — el registro de firmas de la matriz](pieces/pipeline.md#skillstycon-pipelinescriptslibruntime-waiverjs--el-registro-de-firmas-de-la-matriz)

## Los procesos de la noche y el sitio

En [pieces/nightly.md](pieces/nightly.md):

- [scripts/ci/check-stage-dependencies.js](pieces/nightly.md#scriptscicheck-stage-dependenciesjs)
- [scripts/nightly/dependencies/](pieces/nightly.md#scriptsnightlydependencies) _(scripts/nightly/dependencies/ + scripts/ci/audit-dependencies.js)_
- [scripts/nightly/dependencies/work-items.js](pieces/nightly.md#scriptsnightlydependencieswork-itemsjs)
- [work-items.js state](pieces/nightly.md#work-itemsjs-state) _(work-items.js state + el cruce de scripts/nightly/dependencies/nightly-dependencies.js)_
- [scripts/nightly/dependencies/daily-summary.js](pieces/nightly.md#scriptsnightlydependenciesdaily-summaryjs)
- [scripts/nightly/open-prs/open-prs.js](pieces/nightly.md#scriptsnightlyopen-prsopen-prsjs)
- [scripts/nightly/assigned/assigned-items.js](pieces/nightly.md#scriptsnightlyassignedassigned-itemsjs)
- [scripts/nightly/deployments/deployments.js](pieces/nightly.md#scriptsnightlydeploymentsdeploymentsjs)
- [scripts/site/ — el sitio de la organización](pieces/nightly.md#scriptssite--el-sitio-de-la-organización)

## Las integraciones y las guías de quien mantiene

En [pieces/integrations.md](pieces/integrations.md):

- [guides/integrations/ado-queue-and-listings.md](pieces/integrations.md#guidesintegrationsado-queue-and-listingsmd)
- [guides/integrations/clockify-mcp.md](pieces/integrations.md#guidesintegrationsclockify-mcpmd)
- [guides/integrations/clocki-tracking.md](pieces/integrations.md#guidesintegrationsclocki-trackingmd)
- [guides/integrations/codegraph-mcp.md](pieces/integrations.md#guidesintegrationscodegraph-mcpmd)
- [guides/signed-scope-guardrails.md](pieces/integrations.md#guidessigned-scope-guardrailsmd)
- [guides/integrations/ado-projects.md](pieces/integrations.md#guidesintegrationsado-projectsmd)
- [guides/safety-guard.md](pieces/integrations.md#guidessafety-guardmd)
- [guides/maintaining/context-budget.md](pieces/integrations.md#guidesmaintainingcontext-budgetmd)
- [guides/maintaining/skill-scout.md](pieces/integrations.md#guidesmaintainingskill-scoutmd)
- [guides/maintaining/rules-distill.md](pieces/integrations.md#guidesmaintainingrules-distillmd)
- [guides/maintaining/harness-audit.md](pieces/integrations.md#guidesmaintainingharness-auditmd)
- [guides/integrations/instinct-mining.md](pieces/integrations.md#guidesintegrationsinstinct-miningmd)
- [guides/harness-cost-tiering.md](pieces/integrations.md#guidesharness-cost-tieringmd)

## La medición: el banco, las métricas, la oficina y el tablero

En [pieces/metrics.md](pieces/metrics.md):

- [scripts/nightly/watcher/vigilante.js](pieces/metrics.md#scriptsnightlywatchervigilantejs) _(scripts/nightly/watcher/vigilante.js + inbox/watcher/)_
- [scripts/controls-bench/periodic-exam.js](pieces/metrics.md#scriptscontrols-benchperiodic-examjs)
- [scripts/ci/push-nightly-data.js](pieces/metrics.md#scriptscipush-nightly-datajs)
- [scripts/lib/result-travel.js](pieces/metrics.md#scriptslibresult-traveljs)
- [scripts/ci/carry-night-results.js](pieces/metrics.md#scriptscicarry-night-resultsjs)
- [pipelines/azure-pipelines-banco.yml](pieces/metrics.md#pipelinesazure-pipelines-bancoyml)
- [scripts/ci/suites-shard.js](pieces/metrics.md#scriptscisuites-shardjs) _(scripts/ci/suites-shard.js + scripts/ci/suites-weights.json)_
- [scripts/ci/suites-over-limit.json](pieces/metrics.md#scriptscisuites-over-limitjson) _(scripts/ci/suites-over-limit.json + scripts/tests/lib/suite-parts.js + scripts/tests/lib/suite-parts.sh)_
- [scripts/tests/lib/product-lab.js](pieces/metrics.md#scriptstestslibproduct-labjs) _(scripts/tests/lib/product-lab.js + scripts/tests/product-lab-known-gaps.json + scripts/tools/compare-matrix.js)_
- [scripts/metrics/sdlc-stage-metrics.js](pieces/metrics.md#scriptsmetricssdlc-stage-metricsjs) _(scripts/metrics/sdlc-stage-metrics.js + scripts/nightly/dashboard/dashboard.js + scripts/nightly/projects/snapshot.js + scripts/nightly/projects/state-age.js + scripts/metrics/author-concentration.js)_
- [scripts/metrics/tokens-digest.js](pieces/metrics.md#scriptsmetricstokens-digestjs)
- [scripts/metrics/reviewers-cost.js](pieces/metrics.md#scriptsmetricsreviewers-costjs)
- [scripts/metrics/run-change.js](pieces/metrics.md#scriptsmetricsrun-changejs)
- [scripts/metrics/retro-heartbeat.js](pieces/metrics.md#scriptsmetricsretro-heartbeatjs)
- [pipeline.js dod-checker-needed](pieces/metrics.md#pipelinejs-dod-checker-needed) _(pipeline.js dod-checker-needed · deferrals-open · qa-legibilidad (AgentSkills) + la ficha «los hooks del cierre»)_
- [scripts/lib/validator-verdict.js](pieces/metrics.md#scriptslibvalidator-verdictjs) _(scripts/lib/validator-verdict.js + el re-loop del validador en pipeline.js (AgentSkills))_
- [scripts/metrics/step-times.js](pieces/metrics.md#scriptsmetricsstep-timesjs) _(scripts/metrics/step-times.js + el carril de cada commit en scripts/hooks/unpushed-work-notice.js)_
- [scripts/lib/office-messages.js](pieces/metrics.md#scriptsliboffice-messagesjs) _(scripts/lib/office-messages.js + la ruta de la oficina scripts/tools/office/messages.js + los ganchos scripts/hooks/office-inbox-watch.js y office-message-rule.js + scripts/tools/office-message.js)_
- [scripts/tools/work-in-progress.js](pieces/metrics.md#scriptstoolswork-in-progressjs) _(scripts/tools/work-in-progress.js + commands/wip.md; en 3D y en vivo: scripts/tools/office.js; el estado de cada sesión: scripts/hooks/session-state.js)_
- [scripts/hooks/office-link-start.js](pieces/metrics.md#scriptshooksoffice-link-startjs) _(scripts/hooks/office-link-start.js + `harness.js team-refresh`; la conexión: scripts/tools/office/site-link.js)_
- [scripts/metrics/upload-runs.js](pieces/metrics.md#scriptsmetricsupload-runsjs) _(scripts/metrics/upload-runs.js + scripts/metrics/download-runs.js)_
- [scripts/lib/merge-metrics.js](pieces/metrics.md#scriptslibmerge-metricsjs)
- [scripts/lib/people.js](pieces/metrics.md#scriptslibpeoplejs)
- [scripts/lib/guard-record.js](pieces/metrics.md#scriptslibguard-recordjs)
- [scripts/metrics/controls-table.js](pieces/metrics.md#scriptsmetricscontrols-tablejs) _(scripts/metrics/controls-table.js + scripts/metrics/controls-classification.json + scripts/lib/session-model.js)_
- [scripts/nightly/dashboard/reducer.js](pieces/metrics.md#scriptsnightlydashboardreducerjs)
- [lib/installed-tree.js](pieces/metrics.md#libinstalled-treejs)
- [test-gate.sh](pieces/metrics.md#test-gatesh) _(test-gate.sh (AgentSkills) + la ficha «evaluaron el umbral»)_
- [scripts/nightly/dashboard/prune.js](pieces/metrics.md#scriptsnightlydashboardprunejs) _(scripts/nightly/dashboard/prune.js + scripts/metrics/collect-findings.js + scripts/lib/rules-catalog.js)_
- [pipelines/azure-pipelines-tablero.yml](pieces/metrics.md#pipelinesazure-pipelines-tableroyml) _(pipelines/azure-pipelines-tablero.yml + scripts/nightly/dashboard/seal.js + scripts/hooks/dashboard-notice.js)_
- [scripts/controls-bench/report-name.js](pieces/metrics.md#scriptscontrols-benchreport-namejs)

## La máquina: la instalación, los ganchos de git y los avisos de sesión

En [pieces/machine.md](pieces/machine.md):

- [scripts/install-tycon-hooks.sh](pieces/machine.md#scriptsinstall-tycon-hookssh) _(scripts/install-tycon-hooks.sh y scripts/install-tycon-hooks.ps1)_
- [.githooks/pre-commit](pieces/machine.md#githookspre-commit) _(.githooks/pre-commit + .githooks/pre-commit-checks + scripts/hooks/git-pre-commit-global.sh)_
- [scripts/hooks/git-post-commit-global.sh](pieces/machine.md#scriptshooksgit-post-commit-globalsh)
- [scripts/hooks/session-collision-guard.js](pieces/machine.md#scriptshookssession-collision-guardjs)
- [scripts/lib/canonical-path.js](pieces/machine.md#scriptslibcanonical-pathjs)
- [scripts/lib/harness-repo.js](pieces/machine.md#scriptslibharness-repojs)
- [scripts/lib/night-data.js](pieces/machine.md#scriptslibnight-datajs)
- [scripts/lib/repos-root.js](pieces/machine.md#scriptslibrepos-rootjs)
- [scripts/hooks/worktree-sweep.js](pieces/machine.md#scriptshooksworktree-sweepjs)
- [scripts/hooks/dev-behind-main-notice.js](pieces/machine.md#scriptshooksdev-behind-main-noticejs)
- [scripts/hooks/stuck-pr-notice.js](pieces/machine.md#scriptshooksstuck-pr-noticejs)
- [scripts/lib/outside-contributions.js](pieces/machine.md#scriptsliboutside-contributionsjs)
- [scripts/hooks/extension-notices.js](pieces/machine.md#scriptshooksextension-noticesjs)
- [scripts/hooks/missing-path-notice.js](pieces/machine.md#scriptshooksmissing-path-noticejs)
- [scripts/hooks/deprecated-session-notice.js](pieces/machine.md#scriptshooksdeprecated-session-noticejs)
- [scripts/hooks/deprecated-read-notice.js](pieces/machine.md#scriptshooksdeprecated-read-noticejs)
- [skills/tycon-pipeline/scripts/lib/deprecated.js](pieces/machine.md#skillstycon-pipelinescriptslibdeprecatedjs)
- [skills/tycon-pipeline/scripts/on-deprecated-edit.js](pieces/machine.md#skillstycon-pipelinescriptson-deprecated-editjs)
- [scripts/hooks/cover-secrets.js](pieces/machine.md#scriptshookscover-secretsjs)
- [scripts/hooks/failed-query-notice.js](pieces/machine.md#scriptshooksfailed-query-noticejs)
- [scripts/hooks/context-size-notice.js](pieces/machine.md#scriptshookscontext-size-noticejs)
- [scripts/hooks/wait-notice.js](pieces/machine.md#scriptshookswait-noticejs)
- [scripts/hooks/prod-access-guard.js](pieces/machine.md#scriptshooksprod-access-guardjs) _(scripts/hooks/prod-access-guard.js + scripts/production/ + guides/production-with-permission.md)_
- [claude-md-blocks/budget.json](pieces/machine.md#claude-md-blocksbudgetjson) _(claude-md-blocks/budget.json + scripts/ci/check-claude-md-blocks.js)_
- [scripts/hooks/harness-bootstrap-heal.sh](pieces/machine.md#scriptshooksharness-bootstrap-healsh)
- [tycon-pipeline/scripts/lib/guides-heal.js](pieces/machine.md#tycon-pipelinescriptslibguides-healjs) _(tycon-pipeline/scripts/lib/guides-heal.js (en agent-skills) + scripts/hooks/branch-guard-notice.js)_
- [mods/harness-mods/](pieces/machine.md#modsharness-mods) _(mods/harness-mods/ + scripts/setup/harness/plugin-dirs.js)_
- [claude-md-blocks/](pieces/machine.md#claude-md-blocks) _(claude-md-blocks/ + scripts/setup/sync-claude-md-blocks.sh / `scripts/setup/sync-claude-md-blocks.ps1`)_
- [scripts/setup/harness/tools.js](pieces/machine.md#scriptssetupharnesstoolsjs) _(scripts/setup/harness/tools.js + `scripts/setup/harness/tool-change.js` + `scripts/setup/agents-md-blocks.js` + `scripts/hooks/harness-startup.js`)_
- [scripts/setup/harness/harness-node.js — el Node propio del arnés](pieces/machine.md#scriptssetupharnessharness-nodejs--el-node-propio-del-arnés) _(scripts/setup/harness/harness-node.js + `scripts/lib/harness-node.sh` + `scripts/production/node-official.json`)_
- [scripts/setup/harness/release.js — el cambio de versión con enlaces (Windows)](pieces/machine.md#scriptssetupharnessreleasejs--el-cambio-de-versión-con-enlaces-windows) _(scripts/setup/harness/release.js + `tycon-home.js` + `bootstrap.js` + `bootstrap-fallback.ps1`)_
- [scripts/lib/canonical-path.js — las carpetas de skills y agentes, siempre reales](pieces/machine.md#scriptslibcanonical-pathjs--las-carpetas-de-skills-y-agentes-siempre-reales) _(scripts/lib/canonical-path.js `ensureRepoLinks` + `scripts/hooks/branch-guard-notice.js`)_
- [scripts/lib/maintainers-sync.js — el arranque pone al día el clon de mantenimiento](pieces/machine.md#scriptslibmaintainers-syncjs--el-arranque-pone-al-día-el-clon-de-mantenimiento) _(scripts/lib/maintainers-sync.js + `scripts/hooks/branch-guard-notice.js`)_
- [guides/response-style.md](pieces/machine.md#guidesresponse-stylemd)
- [engram-version](pieces/machine.md#engram-version)
- [scripts/setup/check-engram-project.sh](pieces/machine.md#scriptssetupcheck-engram-projectsh)
- [scripts/setup/install-effects.json](pieces/machine.md#scriptssetupinstall-effectsjson)
- [scripts/setup/harness/plan.js y prompt.js](pieces/machine.md#scriptssetupharnessplanjs-y-promptjs)
- [scripts/setup/harness/profile.js](pieces/machine.md#scriptssetupharnessprofilejs)
- [scripts/setup/harness/read-permissions.js](pieces/machine.md#scriptssetupharnessread-permissionsjs)
- [scripts/setup/harness/questions.js](pieces/machine.md#scriptssetupharnessquestionsjs)
- [scripts/setup/get-harness.sh y get-harness.ps1](pieces/machine.md#scriptssetupget-harnesssh-y-get-harnessps1)

## Las historias, el portón y la publicación

En [pieces/stories-and-publishing.md](pieces/stories-and-publishing.md):

- [scripts/tools/tycon-backfill-followups.js](pieces/stories-and-publishing.md#scriptstoolstycon-backfill-followupsjs)
- [scripts/lib/lint-story-frontmatter.js](pieces/stories-and-publishing.md#scriptsliblint-story-frontmatterjs)
- [guides/wiki-topics.md](pieces/stories-and-publishing.md#guideswiki-topicsmd)
- [scripts/hooks/engram-pre-commit.sh](pieces/stories-and-publishing.md#scriptshooksengram-pre-commitsh)
- [scripts/lib/manifest-engram.js](pieces/stories-and-publishing.md#scriptslibmanifest-engramjs)
- [guides/ci-gate.md](pieces/stories-and-publishing.md#guidesci-gatemd)
- [scripts/hooks/lane-llm-notice.js](pieces/stories-and-publishing.md#scriptshookslane-llm-noticejs)
- [guides/maintaining/controls-bench.md](pieces/stories-and-publishing.md#guidesmaintainingcontrols-benchmd)
- [build/](pieces/stories-and-publishing.md#build)
- [guides/maintaining/codex-divergence-inventory.md](pieces/stories-and-publishing.md#guidesmaintainingcodex-divergence-inventorymd)
- [scripts/publishing/detector.js](pieces/stories-and-publishing.md#scriptspublishingdetectorjs)
- [scripts/publishing/third-party-skills.json](pieces/stories-and-publishing.md#scriptspublishingthird-party-skillsjson)
- [scripts/publishing/export.js](pieces/stories-and-publishing.md#scriptspublishingexportjs)
- [scripts/publishing/mirror.js](pieces/stories-and-publishing.md#scriptspublishingmirrorjs)
- [pipelines/azure-pipelines-public-leak-check.yml](pieces/stories-and-publishing.md#pipelinesazure-pipelines-public-leak-checkyml)
- [scripts/hooks/public-push-guard.js](pieces/stories-and-publishing.md#scriptshookspublic-push-guardjs)
- [scripts/tools/merge-pr.js](pieces/stories-and-publishing.md#scriptstoolsmerge-prjs)
- [scripts/ci/version-tag.js](pieces/stories-and-publishing.md#scriptsciversion-tagjs)
- [scripts/setup/npm/index.js](pieces/stories-and-publishing.md#scriptssetupnpmindexjs)
- [.github/workflows/npm-publish.yml](pieces/stories-and-publishing.md#githubworkflowsnpm-publishyml)
- [scripts/ci/npm-package-version.js](pieces/stories-and-publishing.md#scriptscinpm-package-versionjs)
- [scripts/setup/harness/team-init.js](pieces/stories-and-publishing.md#scriptssetupharnessteam-initjs)
- [scripts/setup/harness/team-local.js](pieces/stories-and-publishing.md#scriptssetupharnessteam-localjs)
- [scripts/publishing/new-names.js](pieces/stories-and-publishing.md#scriptspublishingnew-namesjs)
- [scripts/lib/legacy-names.js](pieces/stories-and-publishing.md#scriptsliblegacy-namesjs)
- [scripts/ci/legacy-options.sh y legacy-options.js](pieces/stories-and-publishing.md#scriptscilegacy-optionssh-y-legacy-optionsjs)
- [scripts/publishing/spanish-names.js](pieces/stories-and-publishing.md#scriptspublishingspanish-namesjs)
- [scripts/publishing/internal-history.js](pieces/stories-and-publishing.md#scriptspublishinginternal-historyjs)
- [scripts/lib/estimates.js](pieces/stories-and-publishing.md#scriptslibestimatesjs)
- [scripts/lib/similar-stories.js](pieces/stories-and-publishing.md#scriptslibsimilar-storiesjs)
- [skills/tycon-pipeline/scripts/lib/real-hours.js](pieces/stories-and-publishing.md#skillstycon-pipelinescriptslibreal-hoursjs)
