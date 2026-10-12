# Propuesta — Etapa G: el pipeline con Codex como ejecutor de sesión

**Fecha**: 2026-08-22 · **Plan**: [codex-migration.md](../codex-migration.md) · **Estado**: ✅ DECIDIDO 2026-08-22 — las 3
preguntas resueltas por el dev con la opción recomendada: (1) advisors como AGENTS NATIVOS de
codex (2ª salida del generador, tensión con el principio 2 declarada) · (2) workflow-lite propio
para el 5b (mismo .workflow.js, resume/journal no-imitados declarados) · (3) orden G-1→G-5 con
la corrida dorada al final. Insumo: mapa de acoplamiento medido sobre el skill completo
(SKILL.md + 15 steps + pipeline.js 3194 líneas + adversarial-verify.workflow.js).

---

## Parte 0 — El hallazgo que reordena la etapa: el corte ya está limpio

El inventario §C medía el pipeline como "la pieza más acoplada del arnés" (124 rutas, 28
menciones de Workflow). El mapa real dice otra cosa:

- **`pipeline.js` es 100% mecánico**: cero LLM, cero HTTP, cero `claude`/`codex` — sus únicos
  subprocesos son `git`, `marker.js` y `which`. Sus 20 subcomandos deciden QUÉ correr (set de
  advisors, cap, modelo, expected, gates) y emiten JSON. **No se porta: no se toca.**
- **Todo el trabajo LLM vive en los `.md` de steps como instrucciones al orquestador de
  sesión**, que ejecuta con 3 tools: `Skill` (BMAD, steps 2/4), `Agent` (validator, spec-first,
  advisors del 5), `Workflow` (solo el 5b adversarial).
- El **ground truth infalseable** de `check-count` es el hook `on-advisor-run.js` (PreToolUse) —
  que la Etapa E2 YA dejó bilingüe: bajo Codex registra `collaborationspawn_agent.task_name`.
- Los 3 checkpoints HITL son **texto conversacional** — solo step-03 nombra `AskUserQuestion` y
  con "si está disponible" (el fallback de texto ya está escrito). La definición §2.3 está casi
  gratis. El sello `runtime-waiver` es TTY-only del DEV en terminal — tool-agnóstico, intacto.

Conclusión de diseño: **G no porta un orquestador — cambia QUIÉN corre la sesión.**

---

## Parte 1 — El modelo de ejecución: una sesión Codex corre EL MISMO skill

**Propuesta**: el pipeline bajo Codex es una **sesión codex interactiva que carga
`$tycon-pipeline`** — el MISMO SKILL.md y los MISMOS steps (fuente única literal: cero copia).
F2 ya probó que las skills cargan con conducta de firma; E1/F1 ya desplegaron hooks, MCPs y
skills a `~/.codex/`. La tabla de reemplazos, pieza por pieza:

| Pieza en Claude | Bajo Codex | Estado |
|---|---|---|
| `Skill(bmad-*)` steps 2/4 | `$<skill>` — mismo mecanismo de skills | ✅ Verificado (F2, 6/6 + sonda 4 punta a punta) |
| `Agent(subagent_type: tycon-*)` steps 1/4/5 | **Subagentes NATIVOS de codex** (`~/.codex/agents/*.toml`) spawneados con su mecanismo propio (`collaborationspawn_agent`) | ⚠️ Pieza nueva: 2ª salida del generador (Parte 2) |
| `Workflow` (solo step 5b) | **`workflow-lite.js`** — runner propio del MISMO `.workflow.js` (Parte 3) | ⚠️ Pieza nueva |
| `AskUserQuestion` (step 3) | Pregunta numerada en texto (§2.3 firmada) — el fallback YA escrito en el step | ✅ Casi gratis |
| `CLAUDE_CODE_SESSION_ID` (clave del marker) | Cadena de fallback neutral en `marker.js` (Parte 4) | ⚠️ Patch de 3 líneas |
| Hook ledger de spawns (`check-count`) | `on-advisor-run.js` ya escucha el spawn de codex (E2) | ✅ Hecho |
| Hooks del flujo (story-gate, atdd, dod-guard…) | Registrados por E1 en `~/.codex/hooks.json` | ✅ Hecho (trust por hash pendiente por máquina) |
| `model:` por invocación de `Agent()` | En codex el modelo se declara POR SUBAGENTE (TOML), no por llamada | ③ a declarar (Parte 5) |
| `Monitor`/`TaskStop` (menciones marginales) | No existen — los steps ya los tratan como opcionales | ① prosa tolerante |

**Por qué sesión interactiva y no `codex exec` headless por fase**: los 3 HITL son
conversación con el dev (aprobación del plan con cita textual, decisión sobre CRITICALs, orden
de commit) — partir el flujo en N `codex exec` reconstruiría a mano la máquina de estados que
la sesión ya lleva gratis, y el marker + `pipeline.js next` ya soportan retome entre sesiones.

---

## Parte 2 — Los advisors como subagentes NATIVOS de codex (la decisión grande)

Hoy los 28 advisors tienen PERFILES (`codex exec -p <advisor>`) — el formato que el banco usa.
Pero una sesión codex no spawnea perfiles: spawnea **agents** (`~/.codex/agents/*.toml`, GA,
campos name/description/developer_instructions/model/sandbox_mode/mcp_servers — plan §7).

**Propuesta**: `build/generate.js` emite una **segunda salida por advisor** —
`adapters/codex/agents-native/<name>.toml` — desde el MISMO canónico y las MISMAS reglas
(etiquetas MCP byte-iguales, enabled_tools, apps off, cláusula de conducta). El deployer los
instala en `~/.codex/agents/`.

**Tensión declarada con el principio 2 ("un solo generador, una sola familia")**: sigue siendo
UN generador y UNA familia (los advisors) — lo que se agrega es un segundo FORMATO de salida de
la misma traducción, no una familia nueva. El precedente inverso ya existe: perfiles y agents
comparten el 95% del contenido; el generador factoriza y `check.js` verifica ambos contra el
canónico. Si esto se rechaza, la alternativa es que la sesión codex spawnee advisors por consola
(`codex exec -p` anidado vía su tool Bash) — funciona pero: (a) el hook ve `Bash`, no un spawn →
`check-count` pierde su ground truth (habría que inventar un ledger paralelo), (b) pierde el
paralelismo nativo del spawn, (c) codex anidado bajo sandbox es territorio no sondeado.

**Ledger y `check-count` quedan intactos**: el spawn nativo dispara el hook PreToolUse con
`collaborationspawn_agent.task_name` → `on-advisor-run.js` (E2) escribe la MISMA línea JSONL →
`check-count` cruza igual. El nombre underscoreado ya se normaliza.

**Riesgo a sondear ANTES de generar los 28** (sonda G-1, barata): ¿el `task_name` del spawn
nativo matchea el `name` del TOML del agent? ¿el agent hereda los MCP servers declarados? ¿el
paralelismo real (N spawns en un turno) funciona como el plan §7 dice? Una sonda con UN agent
de juguete responde las tres con verdad de consola.

---

## Parte 3 — `workflow-lite.js`: el 5b sin la tool Workflow (doctrina ③b, "sacarlo afuera")

`adversarial-verify.workflow.js` usa una superficie ACOTADA del DSL: `args`, `log()`,
`agent(prompt, {label, phase, schema, agentType, model})`, `parallel([...])`,
`pipeline(items, f, g)`. Nada de `budget`, `workflow()` anidado, ni resume.

**Propuesta**: `scripts/workflow-lite.js` — un runner node que ejecuta EL MISMO archivo
`.workflow.js` implementando esa superficie: `agent()` → spawn `codex exec` (perfil
general-purpose o prompt pelado) con el schema JSON exigido en el prompt + parseo con reintento;
`parallel`/`pipeline` → pool de promesas (el patrón ya existe en `advisor-runner.js`); `log()` →
stderr. El `.workflow.js` NO se toca (fuente única); el gotcha "args puede llegar como string"
ya está manejado adentro del script.

**Lo que se DECLARA y no se imita**: resume por runId (el join huérfano cross-sesión del step
5b cae, bajo codex, en la rama "relanzar" que el step YA contempla) · el journal de la tool ·
el tope de concurrencia queda fijo (el del script: chunks de 3). El step 5b no cambia: su
lógica de join por marker es agnóstica de quién corrió el workflow.

**Verificación**: el mismo pase adversarial sobre un diff sintético con bug plantado — el
finding CONFIRMADO tiene que salir por las dos vías (Workflow real en claude · workflow-lite en
codex), con el veredicto por regla objetivo (§2.2), no por conteo.

---

## Parte 4 — El session id del marker, neutral

`marker.js` clava `process.env.CLAUDE_CODE_SESSION_ID` (sentinel `_nosession`). Patch mínimo:
cadena `CLAUDE_CODE_SESSION_ID || TYCON_SESSION_ID || _nosession`. El lado codex EXPORTA
`TYCON_SESSION_ID` — fuente: el `session_id` que codex ya manda en cada payload de hook
(verificado B1); el hook de SessionStart del arnés puede persistirlo al ambiente del flujo, o
el arranque del pipeline lo fija. Detalle a resolver en implementación; el contrato del marker
(un archivo por sesión, anti-race multi-sesión) no cambia. `adversarial_is_ours` usa la misma
clave → sigue funcionando.

---

## Parte 5 — Asimetrías que se DECLARAN (no se imitan)

1. **`model:` por invocación** (reloop_model_hints dinámicos del step 7b): en codex el modelo
   del subagente vive en su TOML. v1: los hints dinámicos se degradan a advisory-log bajo codex
   (el set reducido del smart-reloop se conserva — eso lo computa pipeline.js). Si la sonda G-1
   muestra que el spawn acepta overrides, se nivela después.
2. **`fable_upsell` del deep-review-gate**: concepto Claude-only; bajo codex el gate elige entre
   los modelos gpt del mapeo (equivalences ya los tiene).
3. **Superficie visual del plan (`visual_plan`)**: usa `open` + copy-paste — tool-agnóstica, se
   conserva tal cual.
4. **Workflow resume/journal** (Parte 3).

Todo va al registro de asimetrías del plan (§3) — la asimetría se permite; el silencio no.

---

## Parte 6 — Tandas, orden y verificación (checkpoints dorados)

| Tanda | Qué | Verificación |
|---|---|---|
| **G-1 — Sonda del spawn nativo** | 1 agent de juguete en `~/.codex/agents/` + spawn desde sesión codex | task_name↔name, MCP heredado, paralelismo, hook ledgereando — verdad de consola |
| **G-2 — Generador: salida agents-native** | Los 28 TOML nativos + deploy + `check.js` extendido | Estáticos + 2-3 advisors spawneados nativos citando su rule ID (banco reusa casos B2) |
| **G-3 — workflow-lite** | El runner + el 5b sintético con bug plantado | Mismo finding confirmado por ambas vías |
| **G-4 — marker neutral + prosa de steps** | Patch session id + las menciones marginales (§2.3 ya libre) | Selftest marker + lint de steps sin tools inexistentes en codex |
| **G-5 — La corrida dorada** | Story sintética fija (mecánica del plan: worktree aislado, checkpoints dorados) corrida punta a punta en codex; después una story real | ¿Validó la story? ¿qué advisors corrió (ledger)? ¿bloqueó donde debía? ¿qué rule IDs reportó? — comparado contra la corrida claude de la misma story |

Costo estimado: G-1 2-3 sondas ($) · G-2 estáticos + ~6-9 corridas · G-3 ~10-15 corridas ·
G-5 dos corridas completas de pipeline (la parte cara, al final y una vez, como siempre).

## Parte 7 — Las preguntas que deciden el diseño (en orden)

1. **¿OK la segunda salida del generador (agents nativos)** con la tensión del principio 2
   declarada — o preferís el camino consola-anidada con ledger paralelo?
2. **¿OK `workflow-lite` propio para el 5b** — o en v1 el 5b bajo codex se declara asimetría
   (el pase adversarial corre solo cuando el driver es claude) y se nivela después?
3. **¿OK el orden G-1→G-5** con la corrida dorada al final?
