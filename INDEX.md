# Índice de guías del arnés

> Esto es el índice de guías que Claude carga en cada sesión. La portada para personas es [README.es.md](README.es.md)
> (castellano) y [README.md](README.md) (English).

Este archivo se carga en cada sesión. Dice qué guía leer según la tarea: las guías no se cargan solas, se leen
cuando la tarea lo pide. Vale igual con Claude Code y con Codex. Si algo del arnés no anda, el comando
`/tycon-harness` dice la versión, si está bien instalado y si hay una nueva.


---

## Qué contiene

Cada pieza (guía, script, hook, control) con su caso y su medición: **[guides/piezas-del-arnes.md](guides/piezas-del-arnes.md)**,
a demanda; el árbol y sus reglas: [Dónde vive cada cosa](guides/piezas-del-arnes.md#dónde-vive-cada-cosa).
Recorrido completo: **[guides/que-hace-el-arnes.md](guides/que-hace-el-arnes.md)**.

## Cuándo leer cada guía

El agente lee estas guías **según la tarea**, no todas siempre. Una ruta escrita acá no se carga sola: se lee cuando
la fila aplica.

| Trabajando en... | Leer (on-demand) |
|---|---|
| Entender el arnés entero, explicárselo a alguien, o dar la charla | `guides/que-hace-el-arnes.md` |
| Entender en detalle UNA pieza — su porqué, su medición, su red de pruebas | `guides/piezas-del-arnes.md` (este archivo es el índice; el detalle está ahí) |
| Ver qué versión del arnés tenés, si está bien instalado y si hay una nueva | el comando `/tycon-harness` (sólo mira, no cambia nada) |
| Configurar el arnés para una organización: dónde vive cada repo y a quién se asignan los avisos de la noche | `harness.js team-config` (la página local; la portada, §Para una organización) |
| Crear, validar o implementar stories | `story-format.md` |
| Linkear una story nueva a la que viene a fixear/recalibrar (back-links `followup_of:` / `followed_up_by:`) | `story-format.md` §1.2 |
| Back-fillear back-links de follow-ups en stories existentes (audit periódico de un repo) | `scripts/tools/tycon-backfill-followups.js` (dry-run / `--apply` / `--render-table`) |
| Una story "no aparece" para el validator / el backfill / los scripts de status, o adoptar el lint de frontmatter en un repo | `story-format.md` §1.0 + `scripts/lib/lint-story-frontmatter.js` |
| Escribir o editar guías, skills, steps o material del sitio — cómo nombrar Claude/Codex/el agente | `guides/criterio-tres-claude.md` |
| Memoria persistente con engram (si la integración está prendida) | `guides/engram-workflow.md` |
| Commit, push, merge, cualquier cosa de git | `guides/git-commit-conventions.md` |
| Nombrar algo que ejecuta la máquina · frenó el freno de castellano · renombrar sin romper a nadie (`renames.json`) | `guides/nombres-en-ingles.md` |
| Sumar o actualizar una skill de terceros · de quién es cada cosa y con qué licencia | el manifiesto `scripts/publishing/third-party-skills.json` + `guides/publicacion-espejo.md` §«Las skills de terceros» |
| Correr 2 pipelines/stories en paralelo en el mismo repo · mergear sin congelar el working tree del dev · aislar escrituras de agentes paralelos | `guides/git-worktrees.md` (helper: `scripts/tools/tycon-worktree.sh`) |
| Planificación de cambios no triviales | `guides/workflow-orchestration.md` |
| Crear/reescribir un artefacto de planning (UX spec, navigation map, architecture, PRD) sobre dominio ya cubierto por un artefacto aprobado | `guides/workflow-orchestration.md` §12 — frontmatter `reconciles:`/`supersedes_in:` OBLIGATORIO; sin eso no pasa de `draft` (caso UX spec V7 que ignoró el catálogo firmado) |
| Story que crea/modifica layout o navegación de pantalla | `guides/workflow-orchestration.md` §11 — validar contra el artefacto de IA antes de `done` (enforced por `WIRING-C5` desde 2026-06-10) |
| Pipeline de agentes, invocar advisors, integración BMAD | `guides/agent-architecture.md` |
| Entender qué hace el pase adversarial del pipeline (paso 5b), leer las pruebas con las que confirmó un hallazgo, o promoverlas a la suite (`marker.js promote-probe`) | `skills/tycon-pipeline/steps/step-05b-adversarial-verify.md` |
| Entender por qué un advisor reportó X, agregar/retirar reglas | `guides/advisor-rules-catalog.md` |
| Cerrar una story (transición a `review`/`done`) — protocolo ACCOV-C7..C10 | `guides/accov-governance-protocol.md` |
| Configurar hooks `.claude/settings.json` en un proyecto .NET TYCON (migraciones inmutables, dotnet format) | `guides/dotnet-hooks.md` |
| Pasar una story de `review` → `done` (sign-off post-implementación) | `guides/definition-of-done.md` |
| Un formulario queda sin pruebas y el pipeline lo frena · declarar o pagar una deuda de pruebas en `pruebas-pendientes.json` | `guides/deuda-de-pruebas-formularios.md` |
| Se versionaron y redesplegaron TODOS los formularios de un repo sin motivo · por qué el detector de cambios no cuenta los merges | cabecera y bucle de `scripts/ci/forms-to-version.sh` |
| Por qué en `main` se construyen y empaquetan TODOS los formularios aunque sólo algunos suban de versión · antes de proponer «construir sólo lo que sube» | `guides/piezas-del-arnes.md` §`affected-forms.js` («construir en `main` también los que NO suben de versión… pone al día producción») |
| Un merge de **sólo documentación** construyó, desplegó a staging, subió la versión y pidió aprobación de PROD · qué rutas pueden ir en el `trigger` de un pipeline y cuáles no (`.tycon/**` no) · un sitio sin filtro de rutas | `scripts/ci/check-trigger-without-docs.js` (cabecera; se corre a mano sin argumentos) |
| **Correr CUALQUIER test** (vitest/jest/dotnet) — SIEMPRE antes de `npm test`/`dotnet test` | `guides/test-execution-discipline.md` |
| Instalar/configurar tracking de Clockify en Claude Code (opcional) | `guides/clockify-mcp.md` |
| Setup de tracking automático de tiempo (timer auto-start con confirmación + auto-close por idle) | `guides/clocki-tracking.md` |
| Instalar/configurar CodeGraph (índice de código MCP, opcional) | `guides/codegraph-mcp.md` |
| Crear stories que generen work items en Azure DevOps; configurar `.tycon/ado-config.yaml` | `guides/ado-projects.md` |
| Consultar una base de PRODUCCIÓN · te frenó el freno de producción y querés saber por qué · declarar un servidor en `.tycon/production.json` · instalar o actualizar el freno (pide `sudo`) | `guides/produccion-con-permiso.md` |
| Activar/desactivar el freno de mano del harness (bloqueo de `rm -rf /`, `--no-verify`, `curl\|bash`, `DROP DATABASE`, etc.) | `guides/safety-guard.md` |
| Setup del grabador silencioso (instinct mining) + comando `/tycon-instincts` | `guides/instinct-mining.md` |
| Bajar costo del pipeline TYCON (Haiku como executor, Opus como advisor on-demand) + flag `--cost-tier lean` + qué effort/modelo de sesión usar para una story (effort hint PIPE-C8) | `guides/harness-cost-tiering.md` |
| Adoptar la "wiki por temas" en un repo de specs, o entender/arreglar el lint story↔wiki (`scripts/tools/lint-wiki.sh`) | `guides/wiki-topics.md` |
| Un commit llegó a `main` sin pasar por los controles (otra máquina, la web de ADO, hooks salteados) · adoptar el portón de CI en un repo · entender por qué el portón pide el **registro de autoría** (quién implementó, quiénes revisaron) | `guides/ci-gate.md` |
| Apareció el aviso "el desempate por modelo abrió N permisos" · decidir si el modelo del portón se queda o se saca (`--report`) | `scripts/hooks/lane-llm-notice.js` |
| Apareció «sql: … SIN COMPILAR» o «NO compila» al commitear · configurar la base contra la que se compilan las migraciones · una migración que borra datos y hay que validarla | `scripts/ci/sql-compile.js` (cabecera) + `guides/definition-of-done.md` §1.quater |
| Apareció «retro-pending: merge(s) a main sin su archivo de retrospectiva» al cerrar el turno o al arrancar · un merge necesita su retro · se quiere la retro con modelo | `scripts/metrics/retro-heartbeat.js` (cabecera; a mano: `--repo <repo> --merge <sha> [--story <id>]`) · antes: `node scripts/hooks/retro-pending.js --judge <repo>` · con modelo: pedir «retro con modelo» |
| Escribir una story que **corrige, recalibra o extiende** otra (`followup_of:`) — qué causa declarar en `followup_reason:` · por qué el lint frena a una story nueva y a una vieja no · agregar una causa al vocabulario | `scripts/metrics/rework-causes.json` (las cuatro causas, con el motivo de cada una) + `story-format.md` §1.2 |
| Apareció "ya hay otra(s) sesión(es) viva(s) sobre este mismo checkout" al arrancar, o el freno de git te paró por otra sesión · dos chats sobre el mismo repo | `scripts/hooks/session-collision-guard.js` + `guides/git-worktrees.md` |
| Apareció «el arnés corre desde X, no desde la ruta canónica» al arrancar · un dev tiene el arnés o los proyectos en otra carpeta y pregunta si eso rompe algo | `scripts/lib/canonical-path.js` + `INSTALL.md` (el arnés y los proyectos pueden vivir en cualquier carpeta) |
| La matriz da un criterio por corrido con evidencia de otra story · evidencia huérfana | `pipeline.js evidence-key --story <ruta>` |
| Una auditoría del arnés dice «0 repos» · un revisor dice «no encontré hermanos» · querés saber dónde cree el arnés que están tus repos, o decírselo | `node scripts/lib/repos-root.js` (imprime la raíz y de dónde salió) · `TYCON_REPOS_ROOT` es la única variable, para auditorías y revisores |
| Apareció "ARNÉS ATRASADO" al arrancar, o "tu copia del arnés estaba N commits atrás" al primer prompt · un dev choca contra un freno cuyo habilitador "no está registrado" · un control nuevo no llega a una máquina aunque el clon "se actualiza solo" | `skills/tycon-pipeline/scripts/lib/guides-heal.js` |
| Backend .NET de plugins Bizuit (paquete bizuit) | guides/bizuit/bizuit-plugin-dotnet.md |
| Frontend React/TS de plugins Bizuit (paquete bizuit) | guides/bizuit/bizuit-plugin-react.md |
| Frontend Next.js (App Router) de plugins Bizuit (paquete bizuit) | guides/bizuit/bizuit-plugin-nextjs.md |
| La spec de un proceso BPMN de BIZUIT, o por qué uno «pasó todos los controles» sin sus reglas (paquete bizuit) | guides/bizuit/bizuit-bpmn-spec-contract.md |
| Mantener el arnés: publicar, el banco de controles, el catálogo de reglas, la auditoría, el costo del pipeline, el lado Codex, los procesos de la noche | `guides/mantener-el-arnes.md` |


---

## Regla siempre activa — CodeGraph

En un repo con carpeta `.codegraph/` en su raíz, o cuando la sesión tiene tools de CodeGraph
(`mcp__codegraph*`, incluidas las `codegraph-<subcarpeta>` del modo contenedor del instalador),
las preguntas sobre la estructura del código que ese índice cubre —dónde se define algo, quién lo
llama, qué rompe un cambio— se contestan primero con CodeGraph: devuelve el grafo completo, que una
búsqueda de texto no ve. La búsqueda de texto queda para lo que no es código (markdown, specs,
logs, `.json`/`.yaml`/`.sql`), strings literales, nombres de archivo, lo que el índice no cubre, y
como respaldo si CodeGraph falla. Sin índice ni tools de CodeGraph en la sesión, la regla no
aplica. Setup (opcional, por dev): `guides/codegraph-mcp.md`.

---

## Regla siempre activa — Routing Bizuit por entorno (BZURL)

**Antes de construir CUALQUIER URL contra un backend de plugin Bizuit** (curl de smoke,
script, E2E, debugging), determinar el entorno target. La ruta cambia de shape:

| Entorno | Shape de la URL |
|---|---|
| **DevHost local** (`devhost.sh`) | `http://localhost:5001/api/{ruta}` — **SIN** nombre de plugin |
| **Staging / Prod** (host Bizuit, ej. test.bizuit.example) | `https://<host>/api/plugins/{pluginName}/{ruta}` — **CON** nombre de plugin, **SIN** versión: el host sirve la versión activa |
| **Frontend** (formulario) | `${dashboardParams.pluginApiUrl}/{pluginName}/{ruta}` — la base la da el host. NUNCA `fetch('/api/…')` desde la raíz ni la versión a mano |

Señal del error en staging/prod, con un path que funciona en DevHost: **404 con body vacío** =
falta el prefijo `/plugins/{pluginName}`; **404 `{"error":"Endpoint not found"}`** = sobra algo
en la ruta del plugin, casi siempre la versión. Ninguno es un bug del endpoint. En un formulario,
**503** = `fetch` desde la raíz. Detalle: guides/bizuit/bizuit-plugin-dotnet.md §7 y
guides/bizuit/bizuit-plugin-react.md §3. Regla promovida 2026-07-15; la versión salió el
2026-10-14 (el host nunca la aceptó: con versión, 404 en todos los entornos medidos).

---

## Cheat sheet — comandos del día a día

- Implementar una story: `"implementemos la story specs/story-2-3.md"` → skill `tycon-pipeline`.
- Agentes BMAD por nombre: Amelia (dev), Winston (arquitectura), Mary (análisis), Barry (quick-flow), party mode.
- Stories: `tycon-create-story` (Mary+GOLD; crea el WI de ADO vía `tycon-ado-story-wi`), `tycon-story-validator`.
- Review: `bmad-code-review`, `security-review`, advisors `tycon-plugin-*`.
- Merge a main: `/tycon-merge-to-main`. Drift de stories: `/check-story-drift`.
- Engram (si la integración está prendida): siempre con `project:` (nombres canónicos en `guides/engram-workflow.md`).
- **Commits: el agente NUNCA commitea ni pushea sin autorización explícita.**

---

## Instalación y mantenimiento

El setup por máquina y el opcional (Clockify, CodeGraph), el mantenimiento y el troubleshooting
viven en **[INSTALL.md](INSTALL.md)**: onboarding humano de una sola vez, no contexto de cada sesión.
