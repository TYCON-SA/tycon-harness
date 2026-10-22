# harness-cost-tiering — patrón "executor + advisor on-demand" en TYCON

**Goal**: bajar el costo del pipeline TYCON sin perder calidad de findings, aplicando el patrón Anthropic *Advisor Strategy* — el executor barato (Sonnet/Haiku) corre la inspección mecánica, el advisor caro (Opus) entra solo en juicio sintético.

Disparado por la slide *Advisor Strategy — Give agents a cost-effective intelligence boost* (2026-05-27). Adaptado al stack TYCON: en vez de un único API request server-side con tool entry, distribuimos el patrón en capas independientes del harness (4 movimientos a la fecha).

---

## 4 movimientos implementados

### Movimiento 1 — Cost tier por advisor (frontmatter) — **path conservador Sonnet**

Cada agent `tycon-*.md` declara su modelo en el campo `model:` del frontmatter:
- **`haiku`** — grep + parse + checks binarios (sin juicio sintético).
- **`sonnet`** — razonamiento intermedio (default actual de los 3 deterministas tras la decisión 2026-05-27).
- **`opus`** — judgment sintético, cross-file synthesis, security trade-offs.

**Decisión 2026-05-27** (conservadora — Sonnet en lugar de Haiku):

- `tycon-ac-coverage-checker` — bajado de `opus` → `sonnet` (downgrade moderado, conserva juicio en casos edge "AC dice X pero código hace Y similar").
- `tycon-feature-wiring-checker` — **sin cambio** (sigue en `sonnet`, donde ya estaba).
- `tycon-deferral-tracker` — **sin cambio** (sigue en `sonnet`, donde ya estaba).

**Por qué Sonnet y no Haiku**: aunque los 3 advisors son técnicamente deterministas (grep + parse + checks binarios → tier `lean` en `pipeline.js ADVISOR_COST_TIER`), se mantiene Sonnet como default por:
- Riesgo de false negatives en casos edge (Sonnet capta matices que Haiku puede perder).
- Margen de seguridad amplio mientras se valida el patrón.
- Costo cuasi-nulo de mantener Sonnet (los 3 advisors son una parte chica del consumo total del pipeline).

**Haiku queda disponible como opt-in** vía `pipeline.js advisors --cost-tier lean` (Movimiento 2). Cualquier dev que quiera experimentar con la velocidad de Haiku puede activarlo sin modificar el frontmatter.

**NO modificados** (judgment sintético, donde Sonnet/Opus son el modelo correcto):
- `tycon-story-validator` — juzga si la evidencia es real o hand-wavy.
- `tycon-e2e-realness-checker` — juzga si un spec Playwright ejerce el flujo real o stubbea.
- ~~`tycon-sibling-pattern-reviewer`~~ → **bajado a `sonnet` el 2026-06-11** (recorte
  auditoría de costo del pipeline: 2× Opus ≈ 200K tokens por story de backend para confirmar anclas que
  VAL-C8 ya resuelve; Opus queda como excepción explícita para stories sin patrón
  hermano — ver el agent .md).
- `tycon-dod-runtime-checker` — corre bash + interpreta runtime output.
- `tycon-plugin-security-basics` — security-critical, false negatives son caros.
- `tycon-spec-first-checker` — scope creep detection requiere synthesis spec ↔ código.

**Reversible**: revertir el campo `model:` del frontmatter del advisor afectado.

**Tradeoff aceptado**: pierde el ahorro de velocidad de Haiku (~10-15s vs ~30-60s por advisor). En un pipeline completo, ~60-120s más lento que la opción agresiva Haiku.

---

### Movimiento 2 — `pipeline.js advisors --cost-tier lean` (opt-in)

El script mecánico que decide el set de advisors del Step 5 (`~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js`) ahora soporta un flag opt-in:

```bash
node pipeline.js advisors --repo <r> --story <s> --files ... [--cost-tier lean|standard|deep]
```

O via env var: `TYCON_PIPELINE_COST_TIER=lean`.

**Default (`standard` o sin flag)**: output **idéntico** al previo. Cero regresión.

**`--cost-tier lean`**: el output agrega 2 campos:
- `model_hints: { advisor_name: "haiku" }` — solo para advisors `tier: lean`.
- `cost_tier: "lean"` — eco del tier.

```jsonc
{
  "base": [...],
  "completitud": [...],
  "all": [...],
  "required_count": 6,
  "model_hints": { "tycon-ac-coverage-checker": "haiku" },
  "cost_tier": "lean"
}
```

**Estado del wiring (actualizado 2026-06-11, con la auditoría de costo del pipeline)**: el modo `--cost-tier lean`
(Haiku para los lean) sigue siendo opt-in. PERO desde 2026-06-11 hay DOS mecanismos de costo
**cableados por default** — esa auditoría midió que tener esto "documentado pero no
cableado" desde 2026-05-27 costó ~7 spawns Opus + 7 spawns lean evitables en un solo run:

1. **`reloop_model_hints` mandatorios**: TODA invocación de `pipeline.js advisors`/`smart-reloop`
   con `--iter N>1` emite hints `deep → sonnet`, y el step-05/07b instruyen al orquestador a
   **pasarlos como `model:` al `Agent()`** (única excepción: el delta toca specs).
2. **MECH-2 — descuento automático**: `advisors`/`smart-reloop` corren mech-check inline y
   descuentan del set/`expected[]` a `deferral-tracker` y `ac-coverage` — **solo en re-loops
   (iter≥2)** y con mech-check limpio de su familia; en la primera iteración ambos corren siempre (su juicio
   LLM per-item/engram no es mecanizable). `feature-wiring` nunca se descuenta (mech solo
   cubre WIRING-C1). Story ilegible (ambiguo MECH) → cero descuentos.

**`--cost-tier deep`**: escape hatch — todos los advisors se sugieren con Opus. Útil para auditorías paranoicas pre-demo cliente.

**Reversible**: borrar el bloque `ADVISOR_COST_TIER` + `modelHintsForSet` de `pipeline.js`. Como el campo es aditivo y default sin flag no lo emite, no hay callers a romper.

---

### Movimiento 3 — script demo executor + advisor (retirado)

El experimento se retiró del arnés porque nadie lo llamaba. Demostraba el patrón end-to-end:

1. **Executor** (Haiku via `claude -p --model haiku --effort low`) — recibe story + diff summary, devuelve `{ findings_lean, escalations }`.
2. **Advisor** (Opus via `claude -p --model opus --effort high`) — entra solo si hay `escalations`, devuelve verdicts cortos.
3. Las dos llamadas piden salida estructurada (`--output-format json --json-schema`) y corren sin el entorno del dev (`--safe-mode --tools ""`).
4. Reporte consolidado en stdout con `elapsed` (executor_ms, advisor_ms, total_ms), `usage` y `cost_usd` por llamada; el progreso va a stderr.

Sin API key separada — usa la suscripción del dev (mismo patrón que `instinct-observer.js`).

**No es MCP porque**: agregar un MCP server más a TYCON suma superficie de fallo (engram, codegraph, telegram y la herramienta de horas ya están). Antes de wrappear como MCP, validamos el patrón con un script.

---

### Movimiento 4 — Effort hint por complejidad de story (extensión PIPE-C8, 2026-07-11)

**Problema**: el dev elige el reasoning effort de la sesión (low/medium/high/xhigh/max) a ojo,
una vez, y no lo recalibra por story. Resultado típico: o corre TODO en xhigh "por las dudas"
(el mismo patrón estructural que esa auditoría llamó "el sistema degrada al camino más caro"
— allí medido en model-hints de advisors no cableados, acá aplicado al effort de sesión), o
corre una story pesada en `medium` y paga el re-loop completo del Step 5.

**Qué se hizo**: **cero código nuevo**. `pipeline.js model-hint` (PIPE-C8, 2026-07-06) ya computa
mecánicamente `risk` (LOW/NORMAL vía risk-class) + `heavy` (risk NORMAL + ≥2 de 6 señales pesadas:
superficie >12 archivos, ≥10 ACs, código nuevo amplio, multi-tanda, migración+código, scope
firmado). El orquestador mapea ese MISMO output a un effort sugerido y lo anuncia en la misma
línea advisory del model hint (Step 0 preflight) — con regla anti-ruido: en banda NORMAL común
el effort sugerido (`high`) se CALLA — es el default de facto de Claude Code, y la mecánica
(silencio en NORMAL) es la misma bajo Codex aunque su default de effort difiera (asimetría
declarada); en LOW/heavy se
emite siempre, incluso solo-effort si el modelo ya matchea (la fuente canónica de la mecánica
del anuncio es `step-00-preflight.md` §PIPE-C8):

| Banda (`model_hint`) | Modelo sugerido | Effort sugerido |
|---|---|---|
| LOW | `sonnet` (opus ok) | `medium` (`low` ok si es casi-mecánica) |
| NORMAL común | `opus` | `high` ← **default de facto del pipeline** |
| NORMAL + heavy | `opus` (`fable` sólo si la organización lo declara en `session.heavy`) | `xhigh` (el anuncio ya advierte el costo) |
| — | — | `max`: **NUNCA automático** — decisión explícita del dev (debugging gnarly, arquitectura ambigua) |

**Por qué advisory y no auto**: la metadata de la story es un proxy débil de dificultad de
razonamiento — el rename de 20 archivos es "grande" pero mecánico; el algoritmo gnarly cabe en
1 archivo. El hint informa, el dev decide, el override no se re-discute. Si con el uso el hint
pifia seguido → recalibrar señales/umbrales en `computeModelHint` (`pipeline.js`), NO agregar
un scorer paralelo.

**Alcance**: sugiere el effort de la SESIÓN (Steps 2–4 corren inline). Los advisors del Step 5
mantienen su tiering propio (Movimientos 1–2 + `reloop_model_hints`) — este movimiento no los toca.

**Reversible**: borrar la sub-sección "Effort hint" de `step-00-preflight.md` §PIPE-C8 + la
extensión en SKILL.md H.iii. Sin código que revertir.

---

## De dónde sale cada modelo, y cómo lo cambia una organización

**Los valores de hoy viven en un solo lugar**: `skills/tycon-pipeline/scripts/lib/models.js` (`DEFAULTS` y `TIERS`).
El `model:` de cada `agents/*.md`, el `MODEL` de `adversarial-verify.workflow.js` y el valor por defecto de
`build/generate.js` son copias que verifica una prueba (`models.test.js`, T1). Sin configuración, nadie nota nada.

| Trabajo | Valor de hoy | Clave en `team-repos.json → models` |
|---|---|---|
| Revisores (todos / uno por uno) | `sonnet` (y `tycon-spec-first-checker` en `opus`; un revisor de la capa, el `model:` de su `.md`) | `reviewers` / `reviewer: { "<revisor>": … }` |
| Vueltas siguientes de revisores (un tope) | `sonnet` | `reviewers_reloop` |
| Pase adversarial (común / story pesada) | `sonnet` / `opus` | `adversarial.model` / `adversarial.heavy` |
| El revisor de historias, antes de programar (una pasada, sólo en historias de riesgo normal) | `sonnet` | `adversarial.story` — antes de declararla, subir `requires.harness` del perfil a la versión que la trae: el lector anterior rechaza el archivo entero |
| Ayudantes sueltos de búsqueda (SPAWN-1) | `haiku` | `helpers` |
| Sugerencia de la sesión (liviana / común / pesada) | `sonnet` / `opus` / `opus` (el arnés no sugiere `fable` solo: la organización lo elige en `session.heavy`) | `session.low` / `session.normal` / `session.heavy` |

**Quién paga decide quién manda**: con `mandatory_ceiling: true` y un `ceiling` (paga la organización), nada pasa el
techo —un pedido del dev, un valor de la organización o uno de hoy se baja al techo y se avisa una vez por corrida,
sin frenar—; el dev puede bajar. Sin techo (paga cada dev), los valores son sugerencias: el dev los cambia para arriba
o para abajo en su corrida con `marker.js set-models <trabajo>=<modelo>` (o las banderas de siempre: `--cost-tier`,
`--deep-review-opus`, `--deep-review-fable`). El modelo de la sesión nunca se fija: `start --session-model` sólo avisa
si pasa el techo.

**Dónde se ve**: `advisors`/`smart-reloop` dan `reviewer_models` (un modelo por revisor, con su origen y, en las
vueltas siguientes, `first_round`) en lugar de `model_hints`/`reloop_model_hints`; `deep-review-gate` da el `model`
con su `model_reason`; `start` da `models.helpers` y `model_hint.session_check`. Un `team-repos.json` que no se puede
leer, o un error dentro de `models`, deja los valores de hoy y lo dice (`models_problem`): nunca es «sin techo» callado
y nunca frena.

**En Codex**: el modelo de un revisor vive en su `.toml`; el despliegue escribe ahí el modelo resuelto de la
organización (primera vuelta, con techo) y la paridad lo compara con la misma resolución. El pedido por corrida y las
vueltas siguientes no aplican a los revisores de Codex (`codex_note`). Un modelo sin equivalente en
`build/equivalences.json` usa el modelo por defecto de Codex (sin `-m`, sin línea `model =`) y se dice.

**Cambiar `models` sólo por la sección validada de la configuración de la organización** (cuando exista: llega con
la pestaña Configuración del sitio, `org-config.js`). Un archivo editado a mano se salta la validación; aun así, un error dentro de `models` sólo apaga `models`
(no deja a las máquinas sin la capa del equipo). Antes de declararla, la organización sube `requires.harness` del
perfil a la versión que trae este lector: una máquina con el lector anterior rechaza el archivo entero.

---

## El tamaño de la corrida: liviana o completa

`pipeline.js start` clasifica cada story antes de lanzar nada (`lib/run-size.js`) y lo dice en una línea: tamaño,
motivo y tiempo estimado.

- **Liviana**: todos los archivos que la story declara (`files_to_create`, `files_to_modify`) son documentación o
  texto (`.md`, `.txt`, imágenes y capturas) o lo acompañan: las pruebas (`*.test.*`, fixtures), la lista de
  suites, `tasks/` y NOTICE/LICENSE. Una carpeta cuenta por sus archivos. Ninguno vive en una ruta de seguridad,
  de producción, del instalador o de la CI.
- Todo otro JSON es código; el que es un **control** (denegación, excepciones, renombres, lo que decide qué se
  publica) lo dice en el motivo. Un `.md` que el agente ejecuta (SKILL.md, CLAUDE.md, los pasos, los revisores) y
  un helper bajo `tests/` también son código.
- Cuenta lo declarado y lo que el cambio toca de verdad: una story que declara un `.md` y toca código es completa.
- **Completa**: todo lo demás. También una story sin archivos declarados, y una que toca la superficie compartida del
  repo (`deep_review_always_paths`) o un repo con `deep_review: always`.

Cuántos archivos o cuántos ACs ya no cambian el tamaño. En una completa siguen eligiendo el modelo, como antes.

Qué cambia en una liviana:

| Paso | Liviana |
|---|---|
| Implementar | las tandas de la story van juntas, en una sola corrida |
| Pruebas | `test-gate.sh` corre sólo las suites que leen algún archivo tocado; las demás quedan «diferidas por corrida liviana», con la lista |
| Revisores | todos en el modelo barato; los de completitud corren igual |
| Pase adversarial | no corre (el portón dice «corrida liviana») |
| Cierre | no se pide la validación pesada del repo, salvo que el dev la nombre (`marker.js set-flag heavyValidationRequested true`) |

Siguen igual: validar la story, aprobar el plan, los revisores de completitud y la prueba de la guía.

**El tiempo estimado** es la mediana de las corridas del mismo tamaño archivadas en esta máquina
(`~/.claude/.tycon-pipeline/timing-history/`). Las corridas anteriores a esta regla se clasifican por lo que
tocaron. Sin ninguna, un número fijo (45 min la liviana, 180 la completa), dicho como «estimado sin historia».

**Forzar a mano**: `marker.js set-size liviana|completa --reason "<por qué>"`. Sin motivo no se escribe. Forzar a
liviana una story que declara código apaga el pase adversarial a sabiendas: queda en `bypass.log`
(`SIZE_FORCED_LIGHT_WITH_CODE`).

---

## Roadmap de adopción (sin compromiso de fechas)

| Fase | Qué se hace | Cuándo |
|---|---|---|
| 1 (ya hecho) | Movement 1 + 2 + 3 desplegados — default conservador Sonnet, Haiku como opt-in | 2026-05-27 |
| 1b (ya hecho) | Movimiento 4 desplegado — effort hint por complejidad (docs-only, extensión PIPE-C8) | 2026-07-11 |
| 2 | Monitoreo informal de los 3 advisors en Sonnet por 1-2 sprints (verificar que el cambio de `ac-coverage` de Opus a Sonnet no degrada la calidad) | semanas siguientes |
| 3 | Si Fase 2 OK + dev quiere experimentar Haiku: setear `TYCON_PIPELINE_COST_TIER=lean` en su `~/.zshrc` y cablear el orchestrator para que lea `model_hints` (cambio mecánico chico, pero requiere validación cuidadosa del orchestrator) | post-validación |
| 4 | Si Movement 3 demuestra ahorro: wrappear como MCP `tycon-advisor` | futuro |
| 5 (rollback) | Si aparecen regresiones: revertir frontmatter del advisor afectado a `opus` (en el caso de `ac-coverage`) | reactivo |

---

## Rollback rápido por movimiento

| Movement | Cómo revertir |
|---|---|
| 1 | Editar el frontmatter del advisor afectado: `model: haiku` → `model: sonnet` o `model: opus`. Commit + push. Propaga al equipo. |
| 2 | Default ya es sin cambios. Solo afecta callers que pasan `--cost-tier lean` explícito. Para limpiar: borrar `ADVISOR_COST_TIER` + `modelHintsForSet` + branch del handler `advisors`. |
| 3 | Ya retirado (ver Movimiento 3). |
| 4 | Borrar la sub-sección "Effort hint" de `step-00-preflight.md` §PIPE-C8 + la extensión en SKILL.md H.iii. Docs-only, sin código. |

---

## Anti-patterns / lo que NO se hizo

- **NO** se modificó el orchestrator del pipeline (skill `tycon-pipeline`) **en los Movimientos 1–3**. Movement 2 es metadata aditiva; la decisión de honrar el hint queda en mano del orchestrator cuando se decida hacerlo. (El Movimiento 4 SÍ extiende los docs del skill — SKILL.md H.iii + step-00 §PIPE-C8 — pero es advisory puro, sin código.)
- **NO** se bajaron a Haiku advisors con judgment sintético. Falsos negativos en security/spec-first/realness son caros — no vale el ahorro.
- **NO** se agregó un MCP server. Movement 3 es un script standalone para validar el patrón antes de pagar el costo de un MCP nuevo.
- **NO** se compartió tracking de costos hacia un dashboard.

---

## Referencias

- Slide disparadora: Anthropic *Advisor Strategy — Give agents a cost-effective intelligence boost* (2026-05-27).
- Pattern related: [instinct-mining.md](integrations/instinct-mining.md) — mismo patrón "Haiku silencioso, Opus al pedir aprobación" para learnings del harness.
- Pipeline orchestrator: `~/.claude/agent-skills/skills/tycon-pipeline/SKILL.md`.
- Catálogo de advisors: `~/.claude/agent-skills/agents/tycon-*.md`.
- Script Movement 2: `~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js` (función `modelHintsForSet`, tabla `ADVISOR_COST_TIER`).
- Movement 4 (fuente canónica de la mecánica del anuncio): `~/.claude/agent-skills/skills/tycon-pipeline/steps/step-00-preflight.md` §PIPE-C8 + SKILL.md H.iii (`computeModelHint` en `pipeline.js` es la señal mecánica).
