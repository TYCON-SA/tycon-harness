# Inventario de divergencias Claude Code ↔ Codex

**Fecha:** 2026-08-15 · Entregable de la primera etapa de la migración a Codex.
Una fila por pieza del arnés, con su categoría de divergencia y qué caso de prueba la cubre.

**Las tres categorías:**
- **① Envoltorio** — mismo concepto, distinto formato. Lo resuelve el traductor. Mecánico.
- **② Nombre** — mismo concepto, distinto identificador. Lo resuelve `build/equivalences.json`.
- **③ No existe** — hay que decidir: nivelar hacia abajo, sacarlo afuera, o declarar la asimetría.

---

## Resumen — los 4 hallazgos que cambian el plan

1. **Los nombres de las herramientas MCP cambian, y rompen en silencio.**
   > ✅ **DISUELTO para los advisors (Etapa D)**: el nombre lo fija LA ETIQUETA del server
   > (`[mcp_servers.<etiqueta>]` en el perfil) — replicando la etiqueta de Claude el nombre sale
   > byte por byte igual y la prosa no se traduce. Dos condiciones descubiertas al aplicar: la
   > etiqueta usa sólo `[a-z0-9_]` (Codex sanea `-` → `_`) y el server lleva
   > `default_tools_approval_mode = "approve"` (el default `auto` decide por anotaciones y sin
   > ellas DENIEGA en headless). Sigue vigente para lo que NO pasa por perfil de advisor
   > (CLAUDE.md, el registro de horas, skills).
   >
   > 🔴 **Gap de SKILLS cerrado (2026-08-24)**: para los advisors el nombre lo fija la etiqueta y
   > la prosa no se traduce — pero las **skills** se deployan a Codex por *symlink* (copia exacta,
   > sin traducción), así que una tool MCP con **guiones en el NOMBRE** (no en la etiqueta) rompía
   > igual. Ejemplo: las tools del MCP de horas (con guiones en el nombre) son de un paquete de
   > terceros con guiones; bajo Codex salen con `_` y el guard "si la tool no está → saltear" apagaba
   > el tracking EN SILENCIO. No se arregla con la tabla de equivalencias (sólo toca advisors): se
   > arregló con una **nota agnóstica en la prosa del skill** (el skill de horas + steps del pipeline)
   > que dice "usá la variante que exponga tu sesión, nunca concluyas 'no existe' por el separador".
   Hoy engram y codegraph
   llegan como *plugin* de Claude Code, y por eso sus tools se llaman
   `mcp__plugin_engram_engram__mem_search` y similares. En Codex corren sueltas → el nombre cambia.
   **Todo texto que nombre la tool exacta deja de funcionar**: 5 advisors la declaran en `tools:`,
   `~/.claude/CLAUDE.md` la nombra en el protocolo de memoria y en el bloque de CodeGraph, y el skill
   de horas nombra 10 veces las tools del MCP de horas. El agente no la encuentra y sigue de largo.
2. **14 de los 20 hooks funcionan escribiendo a stdout** para que la herramienta lo inyecte como
   contexto (avisos de estilo, de bloqueo, de tracking, recordatorio de rebuild). **Hay que verificar
   que Codex inyecte stdout igual** — la sonda de la Etapa A lo prueba el día 1 (go/no-go). Si no
   lo hace, esos 14 quedan inertes sin dar error — el peor modo de falla del arnés.
3. **Los 5 eventos que usamos existen todos en Codex** y el bloqueo por exit 2 funciona igual. **La
   parte más crítica —los 6 hooks que bloquean— es la más portable.** No era obvio.
4. **La deuda de "criterio en prosa" está concentrada en 5 advisors, no repartida en 28.** Los 28
   citan 286 rule IDs únicos (el catálogo documenta 306), pero la densidad va de 17,7 reglas por 100
   líneas a **cero**. Los cinco de menor densidad concentran ~1.760 líneas con 23 reglas: ahí migrar
   es reescribir, en el resto es traducir.

**Conteo global:** ① 51 piezas · ② 9 piezas · ③ 6 piezas.

---

## A. Los 20 hooks

### A.1 — Eventos: los 5 que usamos existen en Codex ①

| Evento en Claude | Hooks | En Codex | Cat. |
|---|---|---|---|
| SessionStart | 4 | Existe | ① |
| PreToolUse | 6 | Existe | ① |
| UserPromptSubmit | 5 | Existe | ① |
| PostToolUse | 5 | Existe | ① |
| Stop | 3 | Existe | ① |

Codex además expone 6 eventos que Claude no tiene igual (fin de sesión, antes/después de
compactación, pedido de permiso, arranque/fin de subagente) — oportunidad, no problema.

### A.2 — Matchers por nombre de herramienta ②

| Matcher hoy | Hooks | En Codex | Cat. |
|---|---|---|---|
| `*` | 12 | Igual | ① |
| `Bash` | 5 (incluye los 3 frenos duros) | **✅ VERIFICADO 2026-08-21 (live-fire, Etapa B1)**: la tool de shell en Codex se llama literalmente `Bash` y el matcher `"Bash"` matchea (payload capturado en `controls-bench/.bench/live-fire-codex.json`) — los 5 hooks portan sin cambio de matcher | ① (verificado) |
| `Edit\|Write` | 3 | Probablemente `apply_patch` | ② |
| `Task\|Agent` | 1 (`on-advisor-run.js`) | **No es matcher: es evento propio** (`SubagentStart`). Mejor mapeo, pero cambia el mecanismo | ③ |

> Si un matcher no matchea, el hook **no se dispara nunca** y no hay error. Caso negativo obligatorio
> por cada uno de los 9 hooks con matcher.
> **Estado 2026-08-21 (Etapa B1)**: el banco (`guides/maintaining/controls-bench.md`) cubre esto en las dos
> capas — el canary del live-fire vigila el matcher-que-no-matchea dentro de cada herramienta
> (verificado en ambas: 5/5 eventos disparan, canary calla), y `--prove-detection` demuestra que
> un hook que no se dispara sale en rojo.

### A.3 — Mecanismo de salida

| Mecanismo | Hooks | En Codex | Cat. |
|---|---|---|---|
| **Exit 2 (bloquea)** | `safety-guard-pre.sh`, `test-scope-guard-pre.sh`, `on-pre-commit.js`, `on-atdd-preedit.js`, `on-dod-evidence-guard.js`, `on-frontmatter-write.js` | **Idéntico** — exit 2 con motivo por stderr | ① |
| **JSON `decision`** | `on-stop-dod-gate.js` | **✅ VERIFICADO end-to-end 2026-08-23** (`live-fire-stop.js`): las DOS herramientas HONRAN el block — el modelo no cierra, reintenta (medido con un contador de eventos Stop propio del lab: 4 intentos en claude, ≥2 en codex) y el freno anti-thrashing escala solo; la sesión benigna cierra sin trabas. Gotchas del lab que la corrida midió: con hooks de PROYECTO el SessionStart de codex puede disparar antes de cargar el `.codex/hooks.json` del cwd (el seed va en UserPromptSubmit), y `--sandbox read-only` alcanza también a los hooks (va workspace-write) | ① (verificado) |
| **`systemMessage`** | `on-advisor-run.js` | Existe | ① |
| **Solo stdout → inyectado como contexto** | `response-style-notice.js`, `blocking-notice.js`, `response-style-meter.js`, `blocking-meter.js`, `on-prompt.js` (×2), `rebuild-before-verify.js`, `retro-staleness-notice.js`, `instinct-trigger.sh`, `instinct-observe.sh`, `touch-activity.js`, `sweep.js`, `codegraph-session-hook.sh`, `engram-pre-commit.sh`, `hook-pre-edit.js`, `hook-post-edit.js`, `on-edit.js`, `on-write-collision.js`, `on-planning-artifact.js` | **✅ VERIFICADO 2026-08-20 (sonda 3, Etapa A)**: marcador por stdout de un hook `SessionStart` transcripto textual por el modelo en `codex exec` 0.149.0 — la inyección funciona. Empírico solo para `SessionStart`; doc oficial da lo mismo para `UserPromptSubmit`/`SubagentStart`, y `PostToolUse` solo vía `additionalContext` — el banco (Etapa B) verifica evento por evento. Gotcha operativo: el hook necesita trust por hash (`/hooks`) y se re-untrustea con cada cambio del script | ① (verificado) |

### A.4 — Límite de salida
Codex trunca la salida de un hook en ~2.500 tokens. Ninguno la supera hoy; el consolidado de advisors
sí puede. **Cat. ②** — se resuelve con la convención que ya tenemos (detalle al archivo, resumen al
canal), o sea que la limitación de Codex y la regla de estilo del equipo empujan al mismo lado.

---

## B. Los 28 advisors

### B.1 — Permisos declarados (`tools:`)

| Permisos hoy | Cuántos | En Codex | Cat. |
|---|---|---|---|
| `Read, Grep, Glob` | 19 | `sandbox_mode = "read-only"` | ① |
| + `Bash` | 4 (`plugin-dotnet-conventions`, `signed-scope-audit`, `silent-failure-hunter`, `dod-runtime-checker`) | Sandbox de solo lectura permite ejecutar; verificar alcance | ② |
| + tools de engram | 3 (`deferral-tracker`, `dod-runtime-checker`, `retrospective-capturer`) | `mcp_servers` por subagente — **el nombre cambia** | ② |
| + tools de codegraph | 2 (`feature-wiring-checker`, `sibling-pattern-reviewer`) | Ídem | ② |
| + `Write` | 1 (`retrospective-capturer`) | Requiere sandbox de escritura | ① |

> **Lo que no se traduce:** la lista blanca por herramienta no existe en Codex **para las tools
> built-in**. `sandbox_mode = "read-only"` **no impide** que un advisor escriba: impide que la
> escritura persista. Caso de prueba obligatorio: un advisor read-only intenta escribir y **falla
> ruidoso**. Cat. ③ declarada.
> ✅ **Media asimetría disuelta (Etapa D)**: para las tools **MCP** la lista blanca SÍ existe —
> `enabled_tools = [...]` por server; el generador la emite con las tools exactas del frontmatter
> (verificado por canario: `list_projects` no estaba en la lista del modelo).

### B.2 — Modelo y esfuerzo ①
27 declaran `sonnet`, 1 declara `opus` (`tycon-spec-first-checker`). En Codex se declaran por
subagente en su TOML — mapeo directo vía `build/equivalences.json`. **✅ Tabla fijada en Etapa C
(2026-08-21)**: `opus → gpt-5.6-terra` · `sonnet → gpt-5.6-luna` · `haiku → gpt-5.4-mini`
(slugs verificados contra `models_cache.json` de Codex 0.149.0).

### B.3 — Formato ①
Markdown con frontmatter YAML → TOML. Único generador del sistema (`build/generate.js`, Etapa C).
Detalle: `tycon-silent-failure-hunter` declara `tools:` entre corchetes y el resto sin corchetes —
el traductor tolera ambas (implementado y testeado).
**✅ Mecanismo verificado empíricamente (Etapa C, 2026-08-21)**: el `.toml` generado es un
config-overlay de Codex desplegado como `$CODEX_HOME/<name>.config.toml` e invocado con
`codex exec -p <name>` (el flag `-p/--profile` layerea ese archivo sobre la config base);
`--strict-config` acepta las claves (`model`, `sandbox_mode`, `developer_instructions`) y las
instrucciones LLEGAN al modelo — el advisor generado citó `[SEC-C2]` en el formato canónico
sobre un fixture con secreto hardcodeado (~29K tokens la corrida).

---

## C. Los 16 pasos del pipeline

| Paso | Qué usa | Cat. | Cómo se resuelve |
|---|---|---|---|
| `step-01-start` | `Workflow` | ③ | Sale afuera: el orquestador Node ya existe |
| `step-02-validate-story` | `subagent_type` | ② | Codex tiene subagentes propios; cambia cómo se los nombra |
| `step-03-plan` | plan mode | ③ | **Sin equivalente.** Nivelar hacia abajo: plan escrito + confirmación explícita |
| `step-04-approve-plan` | **`AskUserQuestion`** | ③ | Nivelar hacia abajo: pregunta numerada en texto con opción por defecto |
| `step-05-implement` | `Workflow` + `subagent_type` | ③/② | Sale afuera |
| `step-07-reviewers` | `subagent_type` | ② | Codex paraleliza, pero **solo si se lo piden explícito** → el paso tiene que decirlo con todas las letras |
| `step-08-adversarial-pass` | `Workflow` | ③ | Sale afuera — el caso más caro |
| `step-00b`, `00c`, `06`, `07`, `07b`, `07c`, `08`, `09` | nada específico | ① | Portan directo |

**9 de 16 pasos no usan nada específico de Claude.** El riesgo está concentrado en 4.
Scripts afectados: `pipeline.js`, `marker.js`, `adversarial-verify.workflow.js`, `on-advisor-run.js`.

---

## D. Servidores MCP y plugins

| Pieza | Cómo llega hoy | En Codex | Cat. |
|---|---|---|---|
| **engram** | Doble: plugin `engram@engram` **y** servidor suelto (`/usr/local/bin/engram mcp`) | El suelto se configura igual. **El nombre de las tools cambia** al dejar de venir por plugin | ② |
| **codegraph** | Servidor suelto (`/opt/homebrew/bin/codegraph`), por proyecto | Se configura igual; nombres a verificar | ② |
| **Integración de horas** | Servidor suelto (node) | Se configura igual. *La API key viaja en claro en `~/.claude.json` — al portarla, moverla a variable de entorno en vez de duplicar el secreto* | ① |
| **spokenly** | HTTP local | Se configura igual | ① |
| **CLAUDE.md de PROYECTO** | `<repo>/CLAUDE.md`, auto-cargado por Claude Code | **✅ RESUELTA 2026-08-23 sin segunda copia**: el instalador deposita en cada repo con `CLAUDE.md` un `AGENTS.md` PUNTERO de una línea ("las reglas viven en CLAUDE.md — leelo y aplicalo"); Codex lo carga al arrancar y lee el canónico real. Nunca pisa un `AGENTS.md` existente; el dev lo commitea una vez. Antes: sin traducción (las reglas de proyecto no llegaban a Codex) | ③ resuelta |
| **Hooks de PROYECTO (dotnet-hooks)** | `<repo>/.claude/settings.json` | **Sin traducción**: el deployer de Codex sólo cubre los hooks team-wide de `~/.codex/hooks.json`. Bajo Codex el freno de migraciones y el format automático NO existen, sin error. Atenuante: ningún repo lo adoptó aún (2026-08-23) | ③ declarada |
| **Trust de hooks por hash** | `/hooks` interactivo aprueba en Claude sin fricción | Codex aprueba POR HASH y lo exige interactivo; `--dangerously-bypass-hook-trust` es la única vía headless y el clasificador de Claude la frena → esa corrida la lanza el dev. La superficie `trust` de `--parity` lo MIDE en cada arranque (deja de ser una nota: es un número). Cambiar el comando de un gancho cambia su hash: la grabadora de instintos, que pasa de `bash …/instinct-observe.sh` a `node …/instinct-observe.js`, vuelve a pedir la aprobación una vez por máquina | ③ declarada |
| **Telegram** | **Plugin de Claude Code** | **RESUELTA la salida (2026-08-22)**: `scripts/lib/tycon-telegram-notify.sh` avisa igual desde las dos herramientas — es un comando que se invoca y termina, no un servidor. **La entrada sigue siendo exclusiva de Claude Code** con `--channels`, y no por falta de ganas: recibir exige long-polling, cada update lo toma UN solo consumidor, y un segundo del mismo bot le devuelve `409` al otro — o sea que "arreglarlo" en Codex rompería el canal que hoy funciona | ③ declarada (sólo la entrada) |
| **chrome-devtools** | Servidor suelto | Se configura igual | ① |

---

## E. Configuración de sesión

| Ajuste | En Codex | Cat. |
|---|---|---|
| `permissions.allow` + `additionalDirectories` | Sandbox + `approval_policy` + confianza por proyecto. **Más grueso**: no hay permiso por herramienta | ③ declarada |
| `model` + `effortLevel` | Existen ambos, con otros nombres | ② |
| `enableWorkflows` | No aplica (sale afuera) | ③ |
| `statusLine` | No es del arnés TYCON (viene de orca) | — |

---

## F. Barrido de guías y skills (completado 2026-08-15)

**25 de las 33 guías mencionan algo específico de Claude Code.** Casi todo son rutas (`~/.claude`,
`CLAUDE.md`, `.claude/settings.json`) — corrección mecánica. Los focos reales:

| Archivo | Qué menciona | Cat. |
|---|---|---|
| `workflow-orchestration.md` | 6 tools + 1 mcp + 11 rutas — la más acoplada | ②/③ |
| `advisor-rules-catalog.md` | 18 rutas | ② |
| `integrations/…-tracking.md` (horas) | 16 rutas | ② |
| `dotnet-hooks.md` | 12 rutas (bloque copy-pasteable de `settings.json`) | ① necesita variante Codex |
| `codegraph-mcp.md`, `engram-workflow.md`, `README.md` | 2 tools MCP cada una | ② |
| `bmad-contract.md`, `agent-architecture.md`, `git-worktrees.md` | 2-3 tools | ② |

**Skills propias** — el acoplamiento está concentrado en dos:

| Skill | Menciones | Cat. |
|---|---|---|
| `tycon-pipeline` | 124 rutas `~/.claude` · 28 `Workflow` · 12 `subagent_type` · 12 `CLAUDE.md` · 5 tools de codebase-memory | ③ — es la pieza más acoplada del arnés |
| skill de horas | 21 rutas · 10 tools de su MCP por nombre | ② |
| `tycon-merge-to-main` | 6 `CLAUDE.md` · 3 rutas | ② |
| `tycon-skill-scout`, `tycon-story-followup-link`, `tycon-new-migration`, `check-story-drift` | 1-6 rutas cada una | ② |
| `tycon-ado-story-wi` | ninguna | ① |

**Skills BMAD que el pipeline invoca** (las únicas que hay que verificar explícitamente, no las ~100):
`bmad-dev-story`, `bmad-agent-dev`, `bmad-agent-quick-flow-solo-dev`, `bmad-code-review`,
`bmad-testarch-atdd`, `bmad-plan`.

---

## G. Criterio en prosa vs reglas con ID (completado 2026-08-15)

Medición: rule IDs únicos citados por advisor / líneas del archivo. Es el proxy de cuánto criterio
está codificado (portable) contra cuánto vive en la prosa (hay que reescribirlo).

**Los 28 citan 286 rule IDs únicos; el catálogo documenta 306.** Pero la distribución es lo que
importa:

| Advisor | Líneas | Rule IDs | Densidad | Lectura |
|---|---|---|---|---|
| `tycon-retrospective-capturer` | 143 | **0** | 0,0 | Todo el criterio en prosa |
| `tycon-signed-scope-audit` | 141 | 2 | 1,4 | Idem |
| `tycon-feature-wiring-checker` | **582** | 8 | 1,4 | El archivo más grande con menos reglas |
| `tycon-spec-first-checker` | **445** | 8 | 1,8 | Idem |
| `tycon-e2e-realness-checker` | 299 | 6 | 2,0 | Idem |
| …resto (23 advisors) | 79-357 | 7-24 | 3,5 - 17,7 | Traducir alcanza |
| `nextjs-app-router-security` | 79 | 14 | **17,7** | El mejor caso: casi todo codificado |

**Consecuencia para el plan:** el principio 3 (sacar criterio a reglas con ID) no es trabajo de los
28 — es trabajo de **5**, que suman ~1.760 líneas con 23 reglas entre todos. Ahí es donde migrar
significa reescribir; en los otros 23 significa cambiar el envoltorio. Ese trabajo tiene valor
propio aunque la migración se detenga: hoy esos 5 advisors no son auditables contra el catálogo.

---

**Por qué existe este inventario:** un relevamiento de media hora no alcanza como base del plan
de migración. El modo de falla de un inventario incompleto es exactamente el que
el arnés ya combate: un control que no se dispara se ve igual que un control que salió limpio.


---

## Directorio de trabajo del shell entre llamadas (2026-08-27) — ③ asimetría DECLARADA

**Claude Code**: el `cd` de una llamada Bash **persiste** en la siguiente. **Codex**: no — cada
llamada arranca en la raíz del proyecto (verificado en vivo: `cd /usr` y después `pwd` contestó la
raíz). Por qué importa: tras un `cd` anterior, un listado con ruta relativa mira otra carpeta y
devuelve vacío sin error.

**Resolución**: se nivela hacia el comportamiento de Codex, con la variable canónica
`CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` que el instalador escribe en el bloque `env` de
`settings.json`. Codex no necesita nada. **No queda deuda**: tras la variable, las dos herramientas
se comportan igual, y el control que depende de saber el directorio (`missing-path-notice.js`)
resuelve rutas relativas correctamente en ambas — sin la variable, en Claude Code ese control
resolvería contra un directorio que no es el del shell.


---

## stdout de los hooks como canal al modelo — VERIFICADO PARCIAL (2026-08-27)

El inventario decía *"14 de 20 hooks dependen de que stdout se inyecte como contexto, sin
verificar"*. La verificación llegó por la vía cara: un control nuevo (`missing-path-notice`,
PostToolUse·Bash) nació INERTE — corría, imprimía, y el agente jamás lo veía. Contra la doc oficial
de Claude Code:

- **stdout se inyecta al contexto SOLO en** `UserPromptSubmit`, `UserPromptExpansion` y
  `SessionStart`. En el resto (PostToolUse incluido) va **al debug log**.
- El canal de PostToolUse que SÍ llega al modelo: **stderr con `exit 2`** (la herramienta ya
  corrió — no bloquea, sólo hace visible el aviso).

Arreglados el mismo día (stderr + exit 2): `missing-path-notice.js` · `retro-pending.js` (el
registro de push a main) · `unpushed-work-notice.js` (el grito al promover a main). El aviso de
`unpushed-work-notice` de **SessionStart quedó en stdout a propósito** (igual que `dev-behind-main-notice`, que
sólo corre en SessionStart y en las dos herramientas) — ahí stdout es el canal
correcto, y el banco cazó el error de "arreglarlo" también (exit 2 en SessionStart rompería el
arranque). **Verificado también en Codex** (2026-08-27, misma tarde): `live-fire.js` sumó una sonda del
canal stderr+exit2 (una segunda entrada de PostToolUse que emite su código por stderr y sale 2) y
las DOS herramientas repitieron el token — el canal de los avisos migrados funciona en ambas, y el
contrato quedó medido, no apostado. De paso la corrida re-confirmó el resto de la tabla E3
(SessionStart/UserPromptSubmit inyectan stdout · PreToolUse no inyecta en ninguna · PostToolUse
inyecta vía envelope `additionalContext`). Evidencia: `.bench/live-fire-claude.json` y
`.bench/live-fire-codex.json`. **Pendiente que queda**: auditar los hooks advisory restantes de la
lista de 14 contra esta tabla (los que emiten en PreToolUse siguen siendo silencio en ambas).

## Freno de producción — ③ asimetría DECLARADA (2026-09-15)

**Claude Code**: el freno vive en la **configuración administrada** de root
(`managed-settings.d/tycon-production.json`) con matcher `Bash|Monitor|PowerShell`, y junto a él van
las **reglas de preguntar** que abren el cuadro de aprobación de cada sentencia.

**Codex**: no lee esa configuración ni tiene reglas `ask` equivalentes. Se registra el mismo hook con
matcher `Bash` (Codex no emite `Monitor` ni `PowerShell`), y del lado Codex el freno **también frena
la forma canónica de la puerta**: sin cuadro que respalde la sentencia, la consulta la corre el dev.
El hook reconoce Codex por el `turn_id` del payload (mismo criterio que `on-skill-invoke.js`).

**Lo que Codex NO cubre, dicho y no prometido**: la aprobación por sentencia. Ahí el control es «no
se consulta producción desde Codex». Caso del banco: `codex-frena-tambien-la-puerta`
(`40-prod-access-guard.json`), y la divergencia está declarada en `adapters/codex/hooks.json`.

**El firewall de la puerta** (`--open-firewall` / `--close-firewall`): en Codex tampoco se abre una regla.
Además del cuadro, le falta un evento de fin de sesión (sus hooks son PreToolUse, PostToolUse,
SessionStart, Stop y UserPromptSubmit, y `Stop` es fin de turno, no de sesión), así que nadie cerraría la
regla. El freno corta la forma como a toda invocación de la puerta. Caso del banco:
`codex-frena-abrir-firewall` (`40-prod-access-guard.json`). La consulta desde un archivo (`--file`) tampoco: sin el
cuadro no hay quién mire lo que el freno muestra en pantalla. Caso: `codex-frena-archivo`.

**Windows**: el binario lee `%PROGRAMDATA%\ClaudeCode\managed-settings.json`; el aviso de arranque
(`produccion-notice.js`) se registra por el `.ps1`, pero el `.ps1` **no instala hooks de git**, así
que el lint del catálogo (`.tycon/production.json`) no corre ahí — deuda ya declarada del instalador
de Windows, no nueva de este freno.

## Revisores sin el CLAUDE.md — ③ asimetría DECLARADA (2026-09-19)

**Claude Code**: 26 de los 28 revisores declaran `omitClaudeMd: true` en su definición
(`agents/*.md`): al lanzarse como subagente no cargan el `CLAUDE.md` global, el README del arnés
importado ni el `CLAUDE.md` del repo. Las reglas propias del repo les llegan por otro lado: la
sección `## Reglas para revisores` de ese `CLAUDE.md`, que `pipeline.js` recorta y pega al principio
del `context_file` como «reglas a verificar» (`guides/reglas-para-revisores.md`).
`tycon-retrospective-capturer` y `tycon-dod-runtime-checker` quedan sin el campo a propósito.

**Codex**: no hay equivalente de `omitClaudeMd`. El generador ignora la clave (parser plano de
`build/generate.js`) y el revisor de Codex **sigue cargando su `AGENTS.md`** —que en los repos con
`CLAUDE.md` es el puntero de una línea al canónico (§D)—. Lo que **sí llega a los dos** es la
sección en el contexto: la arma `pipeline.js`, que es el mismo en las dos herramientas. Los
«Límites de ejecución» que se sumaron al cuerpo de los 5 revisores con `Bash` viajan también a
Codex (están en el cuerpo, no en el frontmatter).

**Lo que Codex NO tiene, dicho y no prometido**: el ahorro de tokens del revisor (−27 % a −51 %
medido en Claude Code). La detección de las reglas del repo sí, porque viene del contexto.

## Aviso de espera — ③ asimetría DECLARADA (2026-10-17)

**Claude Code**: `wait-notice.js` se registra en seis momentos. El cierre de turno (`Stop`) y la pregunta a la persona
(`PreToolUse` de `AskUserQuestion`, `ExitPlanMode` y la pregunta por voz) abren la espera, y también el pedido de
permiso (`Notification` con `permission_prompt`). La respuesta (`PostToolUse` de esas tres y `UserPromptSubmit`) la
cierra, y `SessionEnd` la cierra sin avisar.

**Codex**: se registra **sólo en `Stop`** (`adapters/codex/hooks.json`). Codex no tiene el cuadro de opciones ni la
aprobación del plan como herramientas, ni el evento `Notification`. El cierre de turno sí abre la espera, y el proceso
del plazo decide igual que del lado Claude, contando los registros de verdad del hilo.

**Lo que Codex NO cubre, dicho y no prometido**: el aviso por un pedido de permiso, y el cierre inmediato de la espera
cuando la persona contesta. Sin `UserPromptSubmit` registrado, la vuelta la detecta el proceso del plazo por el hilo:
cierra con `answered` o `kept-working` y no avisa. Caso: T19 de `scripts/tests/wait-notice.test.js`.
