# Instalación y mantenimiento — el arnés

> Onboarding humano de **una sola vez** (setup por máquina, setup opcional, mantenimiento
> del repo, troubleshooting). NO es contexto operativo para Claude: vive separada del README
> para no inflar el contexto que se carga por sesión. El README es lo operativo de cada sesión;
> el índice de las piezas es `guides/piezas-del-arnes.md`.

---

## Instalación (una vez por máquina nueva)


### 1. Instalar sin clonar

Tres líneas por sistema, las de la portada (`.github/README.es.md`, «2. Bajar e instalar»): bajar el guion
`get-harness.sh` / `.ps1` por la API de GitHub, sin credencial (el repo es público), leerlo, correrlo. El
guion baja la versión publicada como archivos (sin git) a una carpeta temporal y sigue con `harness.js install
--version latest`: el arnés queda en `~/.tycon/harness`, se actualiza solo, y `harness.js install` crea el enlace
estable `~/.claude/tycon-harness` (y los de las skills, los agentes y los paquetes) apuntando ahí; todo lo demás nombra
al arnés por ese enlace. Usar el arnés no necesita un clon; el clon es el modo desarrollador (portada, «Otras formas de
instalar»).

Si el enlace ya apuntaba a otro clon válido, el instalador no lo mueve y lo dice: sólo
`install-tycon-hooks.sh --link <ruta>` (`-Link` en Windows, donde es un *junction*) lo re-apunta.


### 2. El import y la línea de arranque

`harness.js install` escribe las dos: la línea `@~/.claude/tycon-harness/README.md` en `~/.claude/CLAUDE.md` (si
falta) y la línea de arranque de cada sesión en `~/.claude/settings.json`. No hay que agregar nada a mano.

### 3. Los enlaces a las skills y a los revisores (los crea el instalador)

Claude Code descubre las skills en `~/.claude/skills/` y los **subagentes advisor** (ver `guides/agent-architecture.md`)
en `~/.claude/agents/`. Esos dos enlaces, y `~/.claude/agent-skills`, **los crea el instalador** apuntando al árbol que
la máquina corre (`~/.tycon/harness` en una instalada sin clonar; tu clon, en el modo desarrollador): no hay que crearlos
a mano (crear uno encima de un enlace que ya existe deja un enlace suelto dentro del árbol).

Verificá:

```bash
ls -la ~/.claude/tycon-harness ~/.claude/agent-skills ~/.claude/skills ~/.claude/agents
# tycon-harness y agent-skills -> ~/.tycon/harness (o tu clon) · skills -> <árbol>/skills · agents -> <árbol>/agents
node ~/.claude/tycon-harness/scripts/setup/harness.js doctor    # tiene que cerrar con «nada en rojo»
```

En Windows, lo mismo en una terminal de PowerShell (el bloque de arriba es de bash y ahí no corre):

```powershell
Get-Item "$env:USERPROFILE\.claude\tycon-harness","$env:USERPROFILE\.claude\agent-skills","$env:USERPROFILE\.claude\skills","$env:USERPROFILE\.claude\agents" | Format-List Name,Attributes,Target
# los cuatro son enlaces (Attributes incluye ReparsePoint) y su Target es el árbol que corre (~/.tycon/harness, o tu clon), o una carpeta de él
node "$env:USERPROFILE\.claude\tycon-harness\scripts\setup\harness.js" doctor    # tiene que cerrar con «nada en rojo»
```

Si `~/.claude/skills` o `~/.claude/agents` ya eran carpetas tuyas (quien ya usaba Claude Code con skills o agentes
propios), el instalador **no las pisa ni las mueve**: deja adentro un enlace por cada skill y por cada revisor del
arnés, y lo tuyo queda como estaba. Una entrada tuya que se llama igual que una del arnés no se toca: el instalador la
nombra. (En Windows, el enlace a un archivo suelto pide el modo desarrollador: si falta, lo dice y no escribe.)


### 4. La actualización y los hooks

`harness.js install` escribe las dos piezas (el import y la línea de arranque) y registra en `~/.claude/settings.json` el
set de hooks del instalador (la tabla de «Los hooks que instala», más abajo), con una copia de seguridad antes de cada
cambio. En cada sesión, la línea de arranque mira si hay una versión nueva del canal «estable» y, si la hay, avisa y
pregunta: no la aplica sin que lo pidas (`node ~/.claude/tycon-harness/scripts/setup/harness.js update --yes`).
`TYCON_UPDATE=0` la apaga; `harness.js doctor` dice cómo quedó todo y `harness.js uninstall` quita sólo lo que registró.

### 5. Si trabajás con BIZUIT Extensions desde otra organización

El arnés anda sin Azure DevOps, sin Clockify y sin engram: todo eso nace apagado y nada lo pide. Tres pasos te dejan
como a un dev del equipo:

**1. Prendé el paquete bizuit** (los revisores de .NET, React y Next.js, y las guías de guides/bizuit/). Viene
apagado: sin esto el pipeline no lanza esos revisores, y no avisa. En cada repo de un plugin o de formularios (si el
archivo ya tiene una línea `packs:`, editá esa):

```bash
mkdir -p .tycon && printf 'packs: [bizuit]\n' >> .tycon/advisors.yaml
```

```powershell
New-Item -ItemType Directory -Force .tycon | Out-Null; Add-Content .tycon/advisors.yaml 'packs: [bizuit]'
```

O para todos tus repos de una vez: `"packs": { "default": "all" }` en `~/.claude/tycon.json` (o `TYCON_PACKS_DEFAULT=all`).
Con la capa del equipo instalada (`guides/mecanismo-de-instalacion.md`, «La capa del equipo sobre la versión bajada»),
si su perfil declara los paquetes, el perfil del equipo gana sobre ese archivo: ahí vale la variable, o `packs:` en el repo.
Para arrancar un plugin o un formulario nuevo, las guías de guides/bizuit/ te mandan a los templates públicos.

**2. Confirmá los hooks globales de git.** El instalador los copia a `~/.git-hooks/`, pero git los usa sólo si se lo
decís, y eso no lo hace solo: es tu configuración global. Primero mirá si ya tenés una:

```bash
git config --global --get core.hooksPath
```

Si no devuelve nada, activalos (en PowerShell, la misma línea con `"$env:USERPROFILE\.git-hooks"`):

```bash
git config --global core.hooksPath ~/.git-hooks
```

Si devuelve otra carpeta (husky, hooks tuyos), no la pises: decidí vos. Sin este paso, el arnés funciona igual, pero
sin los controles que corren al commitear. `harness.js doctor` te dice si quedó.

**3. engram y Clockify son opcionales.** engram (memoria entre sesiones) se prende con `TYCON_ENGRAM=1` o
`"integrations": { "engram": true }` en `~/.claude/tycon.json`; Clockify (horas), con `TYCON_CLOCKIFY=1` y
`guides/clockify-mcp.md`. Apagados, las guías que los nombran siguen de largo y el pipeline saltea solo su paso de
Clockify. Sin Azure DevOps, el pipeline también saltea su parte (el paso 0c y el cierre en Azure DevOps) y una story
nueva no te pide crear un work item.

### 4b. La configuración del arnés: rutas e integraciones

Nada de la máquina ni de la organización está escrito en el código. Cada valor se resuelve en este orden y
`node ~/.claude/tycon-harness/scripts/lib/tycon-config.js explain` te muestra cada uno con su origen:

1. **variable de entorno** (`TYCON_REPOS_ROOT`, `TYCON_ADO_ORG`, `TYCON_TELEGRAM_CHAT_ID`, `TYCON_CLOCKIFY`, `TYCON_ENGRAM`,
   `TYCON_CODEGRAPH`, `TYCON_MAILBOX`, `TYCON_CODEX`, `TYCON_NIGHTLY` — `0`/`1`, y `detect` para Codex);
2. **el archivo de tu máquina**, `~/.claude/tycon.json` (nunca versionado; lo ven todas las sesiones, también las de la
   extensión de VS Code, que no cargan el rc del shell);
3. **el perfil del equipo**, perfil-equipo.json en la raíz del arnés, si existe (versionado: sólo valores del equipo —
   la organización de Azure DevOps y qué integraciones están prendidas; nada personal, el lector lo rechaza);
4. si nada lo dice: **apagado** o sin valor.

```json
// ~/.claude/tycon.json — lo tuyo, nunca versionado
{
  "paths": { "repos": "~/Proyectos" },
  "telegram": { "chat_id": "…" },
  "integrations": { "codegraph": true }
}
```

| Integración | Qué prende | Apagada, qué pasa |
|---|---|---|
| Azure DevOps | `ado.org` (perfil, o `TYCON_ADO_ORG`) | work items y PR abiertos no se consultan; el instalador no refresca la lista de proyectos con `az`. Los frenos que sólo leen los comandos `az` del agente siguen |
| Clockify | `integrations.clockify` | no se registran `on-prompt.js` ni `touch-activity.js`; el despachador de ediciones sigue y saltea `clocki-enforce` |
| engram | `integrations.engram` | no se registran el sync de commit ni el aviso diario; los chequeos de versión/proyecto no corren; cada comando de engram lo dice y sale 0 |
| CodeGraph | `integrations.codegraph` (informativa) | la instala cada dev con `install-codegraph.sh`; el arnés no registra nada de CodeGraph por sí mismo |
| Buzón de corridas | la llave scripts/metrics/corridas-buzon.json del arnés interno (o `integrations.mailbox`) | no se sube ni se baja nada; la vista de corridas es sólo de esta máquina |
| Codex | `integrations.codex`: `true` · `false` · `"detect"` (`TYCON_CODEX` manda) | no se despliega el lado Codex |
| Nocturnos del equipo | `integrations.nightly` | no se registran los avisos de tablero, dependencias y retro; `bench-notice` calla lo nocturno y sigue con el banco local |
| Telegram | `telegram.chat_id` (o el plugin de Telegram) | no se manda ningún aviso, y quien lo iba a mandar lo dice |

Un archivo de configuración **roto** (ilegible, clave desconocida, tipo equivocado) nunca se lee como «todo
apagado»: un comando frena nombrando archivo, clave y motivo; un hook lo dice en cada corrida, sale 0 y no hace su
parte. Verificar: `node ~/.claude/tycon-harness/scripts/lib/tycon-config.js validate`.

### Los hooks que instala

El instalador (`install-tycon-hooks.sh`, y su gemelo `.ps1`) registra en `~/.claude/settings.json` este set: una fila por
evento y script de sus dos listas, `HOOKS_CANONICAL` y `OPTIN_HOOKS`. Los de una integración se registran sólo con su
llave prendida (4b). «Bloquea» quiere decir que puede denegar una herramienta o no dejar cerrar el turno; el resto avisa o
mide. «Ninguno propio»: se saca a mano de `settings.json`, y con `TYCON_NO_AUTOINSTALL=1` el instalador deja de tocar ese
archivo. «Perfil» dice si el hook está en los dos perfiles de instalación o sólo en `full` (`install.profile` en
`~/.claude/tycon.json`, o `TYCON_INSTALL_PROFILE`; sin elegir es `full`, y el perfil del equipo fija `full`): en `minimal`
sólo quedan los que dicen «minimal y full» —entre ellos el freno de comandos destructivos, `safety-guard-pre.sh`, que se
apaga sólo con su variable en `0`—, y de los dos que nacen prendidos y son de `full` (`test-scope-guard-pre.sh`,
`telegram-zombie-sweep.sh`) sólo los que tengan su variable en `1`. Sale de
`scripts/setup/install-effects.json` (`profiles`), y una prueba cruza la columna con esa lista.

| Hook | Evento | Qué hace | ¿Bloquea? | Perfil | Interruptor |
|---|---|---|---|---|---|
| `clocki/scripts/on-prompt.js` | UserPromptSubmit | Detecta en el pedido que empieza o termina un trabajo y propone abrir o cerrar el timer de Clockify | No | minimal y full | integración Clockify (`TYCON_CLOCKIFY=0`) |
| `tycon-pipeline/scripts/on-prompt.js` | UserPromptSubmit | Reconoce el pedido de implementar una story y avisa si otra sesión trabaja en lo mismo | No | minimal y full | ninguno propio |
| `clocki/scripts/touch-activity.js` | PostToolUse | Anota la última actividad, para cerrar el timer de Clockify por inactividad | No | minimal y full | integración Clockify (`TYCON_CLOCKIFY=0`) |
| `tycon-pipeline/scripts/hook-post-edit.js` | PostToolUse (Edit\|Write) | Después de editar: registra la edición para el pipeline y el timer; al escribir una story, sus pasos de alta | No | minimal y full | ninguno propio |
| `tycon-pipeline/scripts/hook-pre-edit.js` | PreToolUse (Edit\|Write) | Antes de editar: el portón de carril (código sin pipeline ni ad-hoc declarado), el frontmatter de la definición de hecho, el orden de las pruebas (ATDD), la story escrita a mano y el choque entre sesiones | Sí: deniega la edición | full | `TYCON_STORY_GATE=off` (carril) · `TYCON_STORY_SKILL_GATE=off` (story a mano) |
| `tycon-pipeline/scripts/on-skill-invoke.js` | PostToolUse (Skill) | Deja constancia de que se invocó la skill que crea stories: es la evidencia que pide el freno de la story escrita a mano | No | minimal y full | `TYCON_STORY_SKILL_GATE=off` |
| `tycon-pipeline/scripts/on-pre-commit.js` | PreToolUse (Bash) | Antes de un `git commit`: frena el de una story sin la evidencia de ejecución que pide su definición de hecho | Sí: deniega el commit | full | ninguno propio |
| `push-phantom-ref-notice.js` | PreToolUse (Bash) | Antes de subir cambios, avisa si nombran un archivo de código que no existe en el repo | No | full | `TYCON_PUSH_GHOST=0` |
| `pr-one-per-repo-guard.js` | PreToolUse (Bash) | Apagado de fábrica. Prendido, frena abrir un pull request en Azure DevOps si ese repo ya tiene uno abierto | Sí, sólo prendido | full | `TYCON_PR_ONE_PER_REPO=1` lo prende |
| `pr-auto-complete-guard.js` | PreToolUse (Bash) | Frena el pull request a `main` armado con `az` sin `--auto-complete true` y `--squash false` explícitos | Sí | full | `TYCON_PR_AUTO_COMPLETE_GUARD=0` · puntual: `TYCON_PR_BY_HAND=1` pegado al comando |
| `public-push-guard.js` | PreToolUse (Bash) | En un clon del arnés con un remoto público, frena el `gh` que publica un texto que no puede salir (un secreto, un correo, una ruta de máquina, un término de la lista privada) o que no se puede leer desde el comando | Sí | full | ninguno: de un freno falso se sale con una excepción con motivo en la lista privada |
| `tycon-pipeline/scripts/on-bash-write-gate.js` | PreToolUse (Bash) | El portón de carril por la terminal: deniega escribir código con `sed -i`, heredoc, `tee` o `cp` sin pipeline ni ad-hoc declarado | Sí | full | `TYCON_STORY_GATE=off` |
| `tycon-pipeline/scripts/on-advisor-run.js` | PreToolUse (Task\|Agent) | Anota cada subagente lanzado: es lo que cuenta el pipeline para saber qué revisores corrieron | No | minimal y full | ninguno propio |
| `tycon-pipeline/scripts/on-stop-dod-gate.js` | Stop | Con el pipeline en modo autónomo, no deja cerrar el turno con un control de la definición de hecho en rojo | Sí, sólo en modo autónomo | full | ninguno propio (fuera del modo autónomo no hace nada) |
| `response-style-meter.js` | Stop | Mide la prosa del mensaje final del turno y deja el veredicto para el turno siguiente | No | full | `TYCON_RESPONSE_METER=0` |
| `response-style-notice.js` | UserPromptSubmit | Cobra el veredicto del medidor de estilo del turno anterior | No | full | `TYCON_RESPONSE_METER=0` |
| `blocking-meter.js` | Stop | Mide la herramienta bloqueante más larga del turno y los mensajes que quedaron esperando | No | full | `TYCON_BLOCKING_METER=0` |
| `blocking-notice.js` | UserPromptSubmit | Cobra el veredicto del medidor de bloqueo del turno anterior | No | full | `TYCON_BLOCKING_METER=0` |
| `large-read-meter.js` | Stop | Mide cuánto se leyó de un solo archivo en el turno; anota y no avisa | No | full | `TYCON_READ_METER=0` |
| `harness-bootstrap-heal.sh` | SessionStart | Si la línea de arranque hace los `git pull` pero no corre el instalador, le agrega la llamada (con copia de seguridad) | No | minimal y full | `TYCON_NO_BOOTSTRAP_HEAL=1` |
| `branch-guard-notice.js` | SessionStart | Avisa si el clon del arnés o el de las skills no está en `main`, o está atrasado | No | minimal y full | `TYCON_BRANCH_GUARD=0` |
| `retro-pending.js` | PostToolUse (Bash) | Anota cada `git push` a `main` de un repo bajo el arnés | No | full | `TYCON_RETRO_PENDING=0` |
| `retro-pending.js` | Stop | No deja cerrar el turno si un merge a `main` no tiene su archivo de métricas (tope: tres veces seguidas) | Sí | full | `TYCON_RETRO_PENDING=0` |
| `retro-pending.js` | SessionStart | Lista los merges a `main` que no tienen su archivo de métricas | No | full | `TYCON_RETRO_PENDING=0` |
| `retro-staleness-notice.js` | SessionStart | Avisa si el capturador de retrospectivas lleva más de siete días sin correr | No | minimal y full | `TYCON_RETRO_STALENESS=0`; integración de los nocturnos (`TYCON_NIGHTLY=0`) |
| `bench-notice.js` | SessionStart | Avisa si la última corrida del banco de controles dejó rojos | No | full | `TYCON_BENCH_NOTICE=0` |
| `dependencies-notice.js` | SessionStart | Dice si corrió la revisión nocturna de dependencias y qué encontró | No | minimal y full | `TYCON_DEPS_NOTICE=0`; integración de los nocturnos (`TYCON_NIGHTLY=0`) |
| `dashboard-notice.js` | SessionStart | Dice de cuándo es el tablero del arnés publicado y si está completo | No | minimal y full | `TYCON_DASHBOARD_NOTICE=0`; integración de los nocturnos (`TYCON_NIGHTLY=0`) |
| `produccion-notice.js` | SessionStart | Regenera el índice de servidores de producción declarados y, en las máquinas autorizadas, avisa si el freno de producción falta | No | full | `TYCON_PRODUCTION_NOTICE=0` |
| `lane-llm-notice.js` | SessionStart | Avisa si el desempate por modelo del portón de carril abrió permisos | No | full | `TYCON_LANE_LLM_NOTICE=0` |
| `engram-drift-notice.js` | SessionStart | Revisa la memoria de engram una vez por día: proyectos sin nombre fijo, memoria repartida, observaciones sin exportar | No | minimal y full | `TYCON_ENGRAM_DRIFT=0`; integración engram (`TYCON_ENGRAM=0`) |
| `unpushed-work-notice.js` | SessionStart | Avisa las ramas del repo y de su grupo con commits que no están en el remoto | No | full | `TYCON_UNPUSHED_NOTICE=0` |
| `unpushed-work-notice.js` | PostToolUse (Bash) | Anota los repos donde se commiteó y, al subir a `main`, avisa si un repo hermano tiene trabajo sólo local | No | full | `TYCON_UNPUSHED_NOTICE=0` |
| `unpushed-work-notice.js` | Stop | Si la sesión commiteó y quedó algo sin subir, frena el cierre una vez por repo y rama | Sí, una vez | full | `TYCON_UNPUSHED_NOTICE=0` |
| `missing-path-notice.js` | PostToolUse (Bash) | Avisa cuando un comando de lectura nombró una ruta que no existe | No | full | `TYCON_MISSING_PATH_NOTICE=0` |
| `failed-query-notice.js` | PostToolUse (Bash) | Avisa cuando una consulta a un servicio volvió vacía con el código de salida tapado | No | full | `TYCON_FAILED_QUERY_NOTICE=0` |
| `rebuild-before-verify.js` | PostToolUse (Edit\|Write, Bash) | Marca el frontend como «sucio» al editar un componente y lo limpia al correr el build de desarrollo que declara el repo | No | full | `TYCON_REBUILD_VERIFY=0` |
| `rebuild-before-verify.js` | UserPromptSubmit | Con el frontend sucio, recuerda correr el build antes de pedir una verificación visual | No | full | `TYCON_REBUILD_VERIFY=0` |
| `artifact-archive.js` | PostToolUse (Artifact) | Al publicar un artefacto, copia su fuente a la carpeta artifacts del repo, sin commitear | No | full | `TYCON_ARTIFACT_ARCHIVE=0` |
| `safety-guard-pre.sh` | PreToolUse (Bash) | Freno de mano: bloquea comandos destructivos o riesgosos (`rm -rf /`, `git push --force` a `main`, `curl \| bash`, `DROP DATABASE`, leer `.env` o `.ssh`…) | Sí | minimal y full | `TYCON_SAFETY_GUARD=0` · puntual: `TYCON_SAFETY_OFF=1` pegado al comando |
| `test-scope-guard-pre.sh` | PreToolUse (Bash) | Bloquea correr pruebas sin filtro (`npm test`, `vitest run` o `dotnet test` pelados) | Sí | full | `TYCON_TEST_SCOPE_GUARD=0` · la suite completa a propósito: `TYCON_FULL_SUITE=1` pegado al comando |
| `engram-pre-commit.sh` | PreToolUse (Bash) | En un `git commit` de un repo con su archivo .engram-project, exporta la memoria y la suma al commit; frena si el commit pierde una entrada del índice de memoria | Sí, por el índice | minimal y full | `TYCON_ENGRAM_HOOK=0` · sólo el freno del índice: `TYCON_ENGRAM_MANIFEST_GUARD=0`; integración engram (`TYCON_ENGRAM=0`) |
| `telegram-zombie-sweep.sh` | SessionStart | Sólo en máquinas con el plugin oficial de Telegram: cierra sus lanzadores huérfanos | No | full | `TYCON_TG_ZOMBIE_SWEEP=0` |
| `session-collision-guard.js` | PreToolUse (Bash) | Apagado por defecto. Prendido, frena tocar git si otra sesión viva trabaja sobre el mismo checkout | Sí | minimal y full | `TYCON_SESSION_GUARD=1` lo prende |
| `session-collision-guard.js` | SessionStart | Apagado por defecto. Prendido, avisa al abrir una sesión donde ya hay otra viva | No | minimal y full | `TYCON_SESSION_GUARD=1` lo prende |

### 5. Verificar

Abrí una sesión nueva de Claude Code en cualquier proyecto y pedile:

> "¿Qué guías de TYCON conocés?"

Debería responder mencionando varias de las guías listadas en el README (`story-format.md`, `engram-workflow.md`, `advisor-rules-catalog.md`, etc.).

Después pedile:

> "¿Qué advisors TYCON tenés disponibles?"

Debería mencionar los advisors **Core** (los que corren en el pipeline post-implementación). La **lista canónica** vive en `guides/advisor-rules-catalog.md` y en el Step 5 de `tycon-pipeline` — NO hardcodear un número acá (drifteó históricamente). El set Core incluye: `tycon-story-validator`, `tycon-plugin-{dotnet|react|nextjs}-conventions` (según stack), `tycon-plugin-tests-coverage`, `tycon-plugin-security-basics`, `tycon-ac-coverage-checker`, `tycon-spec-first-checker`, `tycon-deferral-tracker`, `tycon-dod-runtime-checker`, `tycon-retrospective-capturer`.

Y advisors **condicionales** (se invocan solo si su trigger se cumple): `signalr-hub-reviewer`, `signalr-client-reviewer`, `migration-impact-analyzer`, `http-resilience-reviewer`, `worker-lifecycle-reviewer`, `multi-tenant-isolation-reviewer`, `drizzle-migration-reviewer`, `nextjs-app-router-security`, `llm-cost-reviewer`, `auth-session-reviewer`, **`tycon-feature-wiring-checker`** (V1 stack-specific TYCON: React 18 + Zustand + .NET 9 Minimal API + Bizuit Plugin — detecta "código done, feature dead": componentes exportados sin mount, store actions sin callsites, hooks side-effect sin invocación, keyboard handlers sin user action, endpoints sin caller frontend; por qué: advisors, builds y tests en verde no prueban que la función esté conectada), **`tycon-sibling-pattern-reviewer`** (diff toca `.cs` de un plugin Bizuit — verifica que la story de backend nazca anclada a un patrón verificado en los plugins hermanos y detecta reinvención de patrones de framework ya resueltos; reglas `XPAT-C1..C3` / `XPAT-W1..W2`; por qué: sin verificación cross-proyecto, una story puede escribirse y validarse con un fix opuesto al patrón real de los plugins hermanos), **`tycon-e2e-realness-checker`** (diff toca `**/tests/e2e/*.spec.ts` Playwright — detecta E2E "verdes" pero que NO ejercen el flujo real: API-only stubs sin clicks UI, `page.route().fulfill()` mockeando endpoints de negocio, dev seams sin asserts visuales del DOM; reglas `REAL-C1..C3` / `REAL-W1..W2` con opt-out `// @realness-exempt: <razón>`; integrado con `tycon-dod-runtime-checker` via nueva regla `DODRT-C4` que cross-checkea cada E2E declarado en `pipelines.X.tests_done` del frontmatter y BLOQUEA `status→done` si algún spec falla realness; por qué: un E2E puede dar "PASS" siendo sólo un API contract check con `page.route()` mockeando todo el backend, sin que ningún otro advisor lo detecte).

Si alguno falla, revisá:
- Path absoluto del `@import` en tu `~/.claude/CLAUDE.md` (paso 2)
- Los enlaces `~/.claude/skills` y `~/.claude/agents` (paso 3): `harness.js doctor` dice si falta alguno
- Hook corre OK (paso 4) — podés verificar con: `ls -la ~/.claude/tycon-harness/.git/FETCH_HEAD` — debería actualizarse cada sesión

### 6. Actualizar manualmente (solo si no configuraste el hook)

Si por alguna razón no querés el hook, correr cuando sepas que hubo cambios:

```bash
cd ~/.claude/tycon-harness
git pull
```

**No hace falta tocar tu CLAUDE.md personal nunca más.** Las actualizaciones llegan via `git pull` (automático o manual).

---

## Setup opcional (cada dev decide si lo activa)

Estos pasos no son obligatorios para usar el flujo TYCON estándar, pero son útiles si los necesitás.

### Clockify MCP — tracking de horas conversacional

Si trackeas horas en Clockify, podés instalar el MCP server para que Claude (en cualquier proyecto) pueda listar workspaces/projects/tasks, consultar time entries, generar summary reports, etc.

**macOS / Linux:**

```bash
bash ~/.claude/tycon-harness/scripts/setup/install-clockify-mcp.sh
```

**Windows (PowerShell):**

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude\tycon-harness\scripts\setup\install-clockify-mcp.ps1"
```

El script te pide tu API key personal (input enmascarado), corre `claude mcp add` con scope `user`, y verifica conexión. La key vive solo en tu `~/.claude.json` local — **no se commitea a ningún repo**.

Detalles, troubleshooting y casos de uso: `guides/clockify-mcp.md`.

### CodeGraph MCP — índice de código para los agentes

CodeGraph indexa el codebase (tree-sitter → SQLite local) y lo expone como MCP server, para que los agentes consulten símbolos / call graph / dependencias en vez de escanear archivos con `grep` — menos tokens, menos tool calls.

**macOS / Linux:**

```bash
bash ~/.claude/tycon-harness/scripts/setup/install-codegraph.sh /ruta/al/repo
```

**Windows (PowerShell):**

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude\tycon-harness\scripts\setup\install-codegraph.ps1" C:\ruta\al\repo
```

El script instala el CLI `codegraph`, autodetecta si el target es un repo suelto o un contenedor con subproyectos, indexa cada repo y lo registra como MCP server (machine-local, no se commitea). El índice `.codegraph/` se gitignora solo.

**Se corre una sola vez por máquina.** Además del setup del repo indicado, instala un hook `SessionStart` que de ahí en adelante auto-configura CodeGraph en cualquier *otro* repo que abras — no hay que volver a correr nada. Para optar por no usar el hook: `--no-auto` (`-NoAuto` en Windows).

Que los agentes usen CodeGraph *por defecto* ya está cubierto: la sección "Regla siempre activa — CodeGraph" de este README se carga en toda sesión (self-gating — solo aplica a repos con `.codegraph/`).

Detalles, modo automático y troubleshooting: `guides/codegraph-mcp.md`.

---

### Lado Codex — el MISMO arnés bajo el asistente de OpenAI

El arnés corre igual en Claude Code y en Codex: Claude Code es el CANÓNICO (el markdown manda) y
Codex consume una traducción automática — advisors, hooks, servidores MCP, skills y el archivo de
reglas se despliegan y se mantienen solos. Migración completa y verificada (2026-08): tres
corridas doradas punta a punta con paridad medida por regla objetivo.

**Requisitos**: `codex` en el PATH y logueado (`codex login`).

**Activar (una vez)**:

```bash
# 1. La llave de opt-in, persistente (sin ella NADA del lado Codex se instala ni se mantiene):
echo 'export TYCON_CODEX=1' >> ~/.zshrc && source ~/.zshrc

# 2. Desplegar ahora (después se mantiene solo en cada arranque de sesión):
bash ~/.claude/tycon-harness/scripts/install-tycon-hooks.sh

# 3. Verificar:
node ~/.claude/tycon-harness/scripts/lib/harness-audit.js --parity
```

**El paso manual irreducible**: abrir una sesión interactiva de `codex`, correr `/hooks` y
APROBAR. Codex aprueba hooks POR HASH y lo exige interactivo por seguridad propia — sin esa
aprobación los hooks NO corren y no dan error. Se repite cuando el instalador avise "TRUST"
(significa que los hooks cambiaron).

**Secretos**: los servidores MCP bajo Codex leen sus secretos del AMBIENTE (el deployer jamás
los copia a archivos). Si falta un export (p. ej. `CLOCKIFY_API_KEY`), el despliegue grita la
instrucción exacta en cada arranque hasta que esté. **En Mac, las apps gráficas** (el panel
de Codex en VSCode) no pasan por `~/.zshrc`: el instalador deja un LaunchAgent
(`ar.com.tycon.harness-env`) que en cada login publica la llave y los secretos MCP para ellas,
leyéndolos de `~/.claude.json` — sin copiarlos a ningún archivo nuevo (opt-out:
`TYCON_NO_GUI_ENV=1`). Al instalarse, macOS avisa "se agregaron elementos en segundo plano" —
es este agente; y VSCode hay que **reabrirlo entero** una vez para que vea las variables. En
**Windows** la vía equivalente son las variables de usuario del registro, permanentes y
visibles por las apps gráficas: el onboarding (PASO 7) deja así la llave y los secretos con
`[Environment]::SetEnvironmentVariable(..., 'User')` — un `$PROFILE` de PowerShell NO
alcanza (las apps gráficas tampoco lo leen). **Linux**: sin cubrir (asimetría declarada — no
hay devs Linux; si aparece uno, la vía es un `environment.d` de systemd).

**Un instalador por vez** (Mac/Linux): desde que el mantenimiento corre también desde el
arranque de Codex, dos sesiones abriéndose juntas lanzarían dos instaladores; un lock por
máquina deja correr uno solo (el otro se va en silencio) — sin eso la paridad medía a mitad de
escritura y daba un rojo transitorio en cada reinicio. **Asimetría declarada en Windows**: el
`.ps1` no tiene lock, y bajo Codex el hook de mantenimiento invoca al `.sh` vía Git Bash
mientras Claude corre el `.ps1` — dos instaladores distintos sin lock común. Se cierra en la
verificación F3 (máquina Windows real); hasta entonces, si un dev Windows ve un rojo de
paridad justo al reiniciar, es este caso: se cura solo en el arranque siguiente.

**El mapa de la máquina** — dónde vive cada pieza. Del lado Claude **nada se movió**: la
migración solo agregó piezas GENERADAS dentro de `~/.codex/` — que es el home de Codex: su
estado propio y lo tuyo quedan intactos (los despliegues son quirúrgicos). Lo que el arnés
escribió no se edita a mano: se edita el canónico, que lo re-pisa. Todo se mantiene solo:

| Pieza | Lado Claude (canónico) | Lado Codex (generado) | Lo despliega |
|---|---|---|---|
| Reglas globales | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` (espejo del global + su propia tabla de nombres) | `sync-claude-md-blocks.sh` |
| Reglas de proyecto | `CLAUDE.md` de cada repo | `AGENTS.md` puntero de una línea en el mismo repo ("leé CLAUDE.md") — sin copia; se commitea al repo | el instalador lo deposita si falta |
| 28 advisors | `~/.claude/agent-skills/agents/*.md` | `~/.codex/<name>.config.toml` (perfiles, `codex exec -p <name>`) **y** `~/.codex/agents/<name>.toml` (subagentes nativos) | `build/generate.js --deploy` |
| ~20 hooks | scripts reales en los repos del equipo (el arnés y `agent-skills`), registrados en `~/.claude/settings.json` | los MISMOS scripts, registrados en `~/.codex/hooks.json` (merge quirúrgico — lo tuyo queda intacto) | `build/deploy-codex-hooks.js` |
| Servidores MCP | el registro de TU máquina (`~/.claude.json`; los que vienen por plugin, de la tabla de equivalencias) | `[mcp_servers]` de `~/.codex/config.toml` + los `writable_roots` del sandbox (secretos jamás al archivo) | `build/deploy-codex-mcp.js` |
| ~160 skills (BMAD incluido) | `~/.claude/agent-skills/skills/` | `~/.codex/skills/*` → symlinks — BMAD se instala UNA vez, del lado Claude, SIEMPRE | `build/deploy-shared-skills.js` |

Las cuatro filas `build/` las orquesta `build/deploy-codex-all.js` (lo invoca el instalador
en cada arranque, con huella digital: solo re-despliega si algo cambió); las reglas de
`AGENTS.md` las escribe `scripts/setup/agents-md-blocks.js` desde los bloques del arnés, entre sus
marcas (lo que vos escribís fuera de las marcas no se toca). Y el mantenimiento corre desde el
arranque de **cualquiera de las dos herramientas**: en Codex, su hook de arranque
(`harness-startup.js`) corre la misma copia fija que la línea de arranque de Claude Code y
actualiza el arnés — un dev puede usar Codex como principal, o solo. Y todo lo audita
`harness-audit.js --parity`, que corre solo en cada arranque — el rojo te lo grita el
arranque siguiente.

Dos gotchas: (a) si el instalador imprime "TRUST", re-aprobar con `/hooks`; (b) `--parity` con
rojos te dice exactamente qué y cómo — un rojo que no entiendas se consulta, no se silencia.
Detalle de diseño y asimetrías declaradas: `guides/codex-migration.md` y
`guides/codex-divergence-inventory.md`.


## Mantenimiento (para el que mantiene el repo)

### Agregar una guía nueva

1. Crear el archivo `.md` en `guides/` con contenido en español y ejemplos copy-pasteables.
2. Agregar la sección `## guides/nueva-guia.md` en **`guides/piezas-del-arnes.md`** —que es el índice
   de las piezas—, con la línea en cursiva de sus rutas y el detalle: por qué existe,
   cómo se midió, su red de pruebas. El caso con nombre va al registro de incidentes, no a la guía. 🔴 **El README ya no lista piezas**: se importa ENTERO en
   cada sesión y en cada subagente y tiene techo en bytes (`claude-md-blocks/budget.json` →
   `imported`); agregarle una ficha es volver a inflar lo que se podó. Si el README
   enlaza una sección de la guía, el ancla es el nombre de la sección en minúsculas, sin los caracteres
   que no sean letra, dígito, espacio, `-` o `_`, y con los espacios en `-`; un enlace sin destino
   frena el commit.
3. Agregar **una fila** en la tabla "Cuándo leer cada guía":
   ```markdown
   | Trabajando en X | `@guides/nueva-guia.md` |
   ```
4. Commit + push.

Los devs reciben la guía automáticamente con `git pull`. Nadie toca su CLAUDE.md personal.

### Modificar una guía existente

1. Editá el archivo.
2. Commit descriptivo (`docs: aclarar regla X en engram-workflow`).
3. Push.

Si el cambio es mayor (ej: cambio de formato, regla nueva que cambia comportamiento), considerá:
- Anotar en la sección `## Changelog` de la guía (si tiene una).
- Mencionarlo en un mensaje de Slack/Teams para que el equipo sepa.

### Descontinuar una guía

1. Remover el archivo.
2. Remover las referencias: la fila de la tabla «Cuándo leer cada guía» y su sección de
   `guides/piezas-del-arnes.md` (si el README la enlazaba, sacar también el enlace: uno sin destino
   frena el commit).
3. Commit: `docs: descontinuar <guía> (motivo)`.

### Agregar una skill team-wide (custom TYCON o encontrada en internet)

Las **skills** viven en este mismo repo, en su carpeta `skills/` (los revisores, en `agents/`):


- **Path local:** la carpeta de skills de tu clon, `~/.claude/tycon-harness/skills/`
- **Cómo las descubre Claude Code:** escanea `~/.claude/skills/` (el enlace que deja el instalador, paso 3) al iniciar sesión.

**Una skill encontrada en internet NO se copia al repo: se declara.** Lo ajeno se referencia, no se copia:
va una entrada en el manifiesto de terceros del arnés, `scripts/publishing/third-party-skills.json` (sección
`third_party`), con su `origin` (URL del repo), el `commit` exacto (40 hexadecimales: nunca una rama ni un tag), el
`path` dentro del origen, el `tree` (el hash de árbol que tiene que quedar: `git rev-parse <commit>:<path>` en un clon
del origen), `omit` si sobra algo, su licencia con de dónde se leyó, `install: download` y el porqué. El paso del
instalador la pone en cada máquina en el próximo arranque —verificada por árbol, sin pisar nada— y el pre-commit del
repo frena si alguien la copia al árbol sin declararla. El detalle: `guides/publicacion-espejo.md` §«Las skills
de terceros». Lo que sigue es para una skill **del equipo**.

**Flujo para agregar una skill nueva del equipo:**

1. Crear la carpeta de la skill con el skill `/skill-creator`:
   ```bash
   mkdir -p ~/.claude/tycon-harness/skills/mi-skill
   # crear SKILL.md y los archivos necesarios adentro
   ```
2. Validar que `SKILL.md` tenga frontmatter `name` + `description` — sin esto Claude Code no la ve. Si su nombre no
   entra en un glob de `own` del manifiesto de terceros (`skills/tycon-*`, …), se suma ahí: el pre-commit del
   repo frena toda carpeta que no esté declarada en ningún universo.
3. Commit + push:
   ```bash
   cd ~/.claude/tycon-harness
   git add skills/mi-skill
   git commit -m "feat(skills): add mi-skill — <descripción breve + fuente si aplica>"
   git push
   ```
4. Reiniciar la sesión de Claude Code (las skills se descubren al arranque).

**Cómo la reciben los otros devs:**

La línea de arranque (paso 4 de instalación) trae la versión nueva del repo en cada sesión nueva. **Nadie tiene que acordarse de nada** — la skill aparece disponible la próxima vez que abren Claude Code.

**Eliminar una skill:**

```bash
cd ~/.claude/tycon-harness
git rm -r skills/skill-a-eliminar
git commit -m "chore(skills): remove skill-a-eliminar (motivo)"
git push
```

**Qué NO va en `skills/`:**

- Skills de BMAD (`bmad-*`, `gds-*`, `wds-*`, `cis-*`, `tea-*`) — esas las genera el installer del repo BMAD, no se tocan a mano.
- Guías / documentos de referencia — van en `guides/`.

### Reglas de contenido

- **Los tres "Claude"** (multi-modelo): la herramienta canónica se nombra (Claude Code), el
  actor de runtime y el modelo son genéricos ("el agente"/"el modelo" — también en cópulas:
  "Claude es un…"), las primitivas son de quien son. Criterio completo y disparador:
  [guides/criterio-tres-claude.md](guides/criterio-tres-claude.md).
- **Español** (idioma default del equipo).
- **Copy-pasteable**: comandos y snippets ejecutables, no pseudocódigo.
- **Sin detalles proyecto-específicos**: los nombres de proyectos concretos solo aparecen en tablas ilustrativas. Las reglas deben ser universales para todos los proyectos TYCON.
- **Anti-patrones explícitos**: cada guía debería tener una sección "lo que NO hay que hacer" con razones.
- **Referencias cruzadas**: si una guía menciona otra, linkearla con path relativo (`../story-format.md`).

### Contrato de contexto — qué se carga vs. qué se lee on-demand (H3 + H20)

Regla que evita dos bugs históricos: reglas duplicadas que inflan el contexto (H3) y reglas
que viven solo en una guía y el modelo nunca ve (H20).

**Qué se carga SIEMPRE en contexto (cada sesión):**
- El `README.md` de este repo (vía el `@import` del `~/.claude/CLAUDE.md` del dev).
- El `~/.claude/CLAUDE.md` personal del dev.
- Las inyecciones automáticas de los MCP servers (engram "PROACTIVE SAVE", codegraph
  "don't grep first", telegram) — el server las mete solo, no hace falta repetirlas.

**Qué NO se carga (lectura on-demand):**
- Todas las guías de `guides/` y `story-format.md`. Un `` `path.md` `` en backticks NO es un
  import (verificado 2026-05-21). El modelo las abre con `Read` cuando aplica el trigger de
  la tabla "Cuándo leer cada guía", o cuando un step del pipeline las referencia.

**Las dos reglas que se derivan:**
1. **H20 — no escondas reglas operativas solo en guías.** Si una regla la necesita el modelo
   en TODA sesión → va en el README (que se carga). Las guías son para profundidad/detalle
   topical. Y si un step del pipeline o un advisor DEPENDE de una guía, ese step DEBE
   referenciarla explícitamente (ej: `step-07c` → `definition-of-done.md`, `step-01` →
   `story-format.md`) para que se lea on-demand al ejecutarse.
2. **H3 — una sola fuente canónica por regla.** Cada regla vive textual en UN solo archivo;
   el resto la referencia con un puntero (`Ver guides/X.md`), NO la re-escribe. **Y la copia
   canónica debe estar en un archivo que SÍ carga** (README/CLAUDE.md) si es una regla
   always-on — si no, el dedup la vuelve invisible. No dupliques en contexto lo que un MCP
   server ya inyecta solo.


---

## Por qué este repo

Antes, las mismas convenciones (engram, commits, workflow) estaban copiadas literalmente en 10+ `CLAUDE.md` de proyectos. Cada cambio implicaba editar N archivos y pedir N PRs. Si un proyecto se quedaba con una versión vieja, Claude actuaba inconsistente entre repos.

Ahora:

- **Una fuente de verdad.** Cada convención vive en un solo archivo.
- **Cero actualizaciones en proyectos.** Los `CLAUDE.md` de proyecto no contienen estas reglas.
- **Onboarding de 2 minutos.** El guion de la portada (bajar, leer, correr) y listo: sin clonar nada.
- **Versionado independiente.** El repo evoluciona sin tocar el fork de BMAD ni los proyectos.

---

## Troubleshooting

**Claude no aplica las reglas de una guía:**
- Las guías **NO se cargan solas** en contexto. Lo único que se importa es el **README**, vía el `@import` de tu `~/.claude/CLAUDE.md`. Las guías son lectura **on-demand**: Claude las abre con `Read` cuando aplica el trigger de la tabla "Cuándo leer cada guía". Si no las está aplicando, pedíle explícitamente que lea la guía.
- Verificá el path absoluto del `@import` del README en tu `~/.claude/CLAUDE.md`.
- `cd ~/.claude/tycon-harness && git pull` — puede que alguien haya modificado la guía.
- Reiniciá la sesión de Claude Code (el `@import` del README se carga al inicio).

**"Context too large" al iniciar sesión:**
- Lo único que se carga siempre es el **README** (vía el `@import` de CLAUDE.md). Las guías y `story-format.md` **NO** se importan: un path en backticks dentro de la tabla "Cuándo leer" es texto, **no** un import (verificado empíricamente 2026-05-21 — un `@path` en un code-span nunca fue resuelto como import). Por eso este `INSTALL.md` existe: el onboarding humano se sacó del README para que el contexto por sesión sea mínimo.
- Si igual se infla, revisá qué reglas/secciones agregaste al README y considerá moverlas a una guía on-demand.

**Quiero sugerir un cambio a una guía:**
- PR al repo. Los Project Administrators (el dev, otro dev) revisan y mergean.
