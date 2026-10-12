# harness-audit — check-up reproducible del harness TYCON

Script Node que evalúa el estado del harness contra 7 categorías con score 0-10 cada una. Determinístico (sin LLM), reproducible (mismo commit → mismo score), corre en ~500ms.

Reemplaza la auditoría manual ad-hoc, que encuentra las regresiones a mano. Inspirado en [ECC harness-audit](https://github.com/affaan-m/ECC/blob/main/commands/harness-audit.md), categorías adaptadas al stack TYCON.

## Cuándo correrlo

- **Mensual** — health check del harness.
- Antes de **demos** importantes a cliente — confirma que el harness está sano.
- Después de **cambios estructurales** (agregar advisor, mover hooks, refactor del catalog).
- Cuando un **dev nuevo** se incorpora — le da una foto inicial del estado.
- Si **notás algo raro** — primer diagnóstico antes de meterte a investigar manual.

## Uso

```bash
node ~/.claude/tycon-harness/scripts/lib/harness-audit.js          # reporte text
node ~/.claude/tycon-harness/scripts/lib/harness-audit.js --verbose # detalle por check
node ~/.claude/tycon-harness/scripts/lib/harness-audit.js --json   # output JSON
```

No requiere instalación — Node puro, sin dependencias externas. **Internamente invoca `rules-distill.js`** para la categoría Catalog Integrity, así que ese script tiene que estar funcional.

## Las 7 categorías

### 1. Advisor Coverage

¿Tenés los advisors esperados? Score por:
- Cada uno de los **9 advisors Core** instalados (`tycon-plugin-*`, `tycon-story-validator`, `tycon-ac-coverage-checker`, `tycon-deferral-tracker`, `tycon-spec-first-checker`).
- **≥12 advisors condicionales** del set conocido (signalr, http-resilience, worker-lifecycle, drizzle, multi-tenant, auth, llm-cost, e2e-realness, dod-runtime, retrospective, silent-failure, etc.).

### 2. Context Efficiency

¿Cuánto del context window consume el harness en cada sesión nueva?
- **Overhead total < 25%** del presupuesto de contexto que se fija el arnés (200K tokens: la ventana de Haiku 4.5; Sonnet 5, Opus 5 y Fable 5.1 traen 1M).
- **MCP overhead < 35,000 tokens** (los MCPs son el biggest lever).
- **Skills count < 100** (skill bloat — muchos off-stack indican que el catálogo no se está manteniendo).

Heurística: chars/4 sobre descriptions de skills + agents + 500 tokens por tool schema MCP (hardcoded para servers conocidos).

### 3. Quality Gates

¿Los hooks bloqueantes del pipeline están instalados?
- Hook **PreToolUse Edit|Write** para DoD frontmatter gate (`hook-pre-edit.js` o `on-frontmatter-write.js`).
- Hook **PreToolUse Bash** para DoD pre-commit gate (`on-pre-commit.js`).
- Hook **PreToolUse Task|Agent** para advisor logging (`on-advisor-run.js`).
- Hook **Stop** para autonomous DoD gate (`on-stop-dod-gate.js`).
- Guía `definition-of-done.md` existe.

### 4. Memory Persistence

¿Engram está configurado y se usa?
- Engram MCP configurado en `~/.claude/settings.json`.
- Guía `engram-workflow.md` existe.
- Memory activity en los últimos 7 días (proxy: archivos modificados en `~/.claude/projects/*/memory/`).

### 5. Catalog Integrity

Invoca `rules-distill.js` internamente. Score por:
- **0 BROKEN-REFS** (catalog no cita owners inexistentes).
- **0 ORPHANS** (toda regla enforced está documentada).
- **≤5 ZOMBIES** (catalog tiene pocas reglas sin advisor que las cite).
- **0 OWNER-MISMATCH**.
- Catalog tiene **≥200 rule IDs** activos.

### 6. Security Guardrails

¿Los mecanismos defensivos están activos?
- `safety-guard` hook en `settings.json` (freno destructivo).
- Guía `safety-guard.md` existe.
- Guía `dotnet-hooks.md` existe (anti-mutación de migraciones).
- Guía `signed-scope-guardrails.md` existe (protección de scope firmado con cliente).
- Guía `git-commit-conventions.md` existe (anti `--no-verify`).

### 7. Pipeline Wiring

¿El pipeline orchestrator está coherente entre sus 3 archivos?
- `tycon-pipeline/SKILL.md` existe.
- `tycon-pipeline/steps/step-05-advisors-parallel.md` existe.
- `tycon-pipeline/scripts/pipeline.js` existe.
- Para advisors típicos (`tycon-e2e-realness-checker`, `tycon-silent-failure-hunter`, `http-resilience-reviewer`): el advisor está mencionado en los **3 archivos** simultáneamente. Por qué: un advisor que está solo en SKILL.md y falta en pipeline.js es una regresión.

## Lectura del score

| Score | Interpretación |
|---|---|
| **9-10/10** ✓ | Categoría sana. |
| **5-8/10** ⚠ | Hay gaps. Mirar los failed checks puntuales. |
| **0-4/10** ✗ | Acción inmediata. |

**Score total** = average de las 7 categorías. Es un proxy del estado general:
- **>80%**: harness en buena forma.
- **60-80%**: usable con gaps. Atacar lo del top-5 acciones.
- **<60%**: necesita revisión profunda.

## Ejemplo de una corrida

```
Score total: 58/70 (83%)

Advisor Coverage    10/10  ✓
Context Efficiency   0/10  ✗ overhead 29.5%, MCP 48.5K
Quality Gates       10/10  ✓
Memory Persistence  10/10  ✓
Catalog Integrity   10/10  ✓ (0 orphans + 0 broken-refs post fix)
Security Guardrails  8/10  ⚠ falta activar safety-guard hook
Pipeline Wiring     10/10  ✓
```

Acciones priorizadas (failed checks por severity):

1. **🟡 Context Efficiency — Overhead 29.5%** — el script asume connectors Anthropic prendidos (no detecta los apagados en cuenta). Real: probablemente ~21% si la cuenta refleja Wix+Gamma off. Win adicional: evaluar `chrome-devtools` (12.5K tokens).
2. **🟡 Context Efficiency — MCP 48.5K > target 35K** — biggest lever del context efficiency.
3. **🟡 Security Guardrails — safety-guard hook no instalado** — fix: `bash ~/.claude/tycon-harness/scripts/install-tycon-hooks.sh` con `TYCON_SAFETY_GUARD` no seteado (default ON).
4. **⚪ Context Efficiency — 159 skills (target <100)** — limpieza de skills off-stack. Ataque futuro con `tycon-skill-stocktake` (item pendiente del roadmap ECC).

## Limitations v1

- **No detecta connectors Anthropic apagados en cuenta**. Asume todos prendidos. Real overhead suele ser menor que el reportado.
- **MCP tool counts hardcoded**. Si Anthropic agrega tools al connector Wix, mi count queda desactualizado.
- **Heurística chars/4 ±15%** vs tokenizer real.
- **Pipeline wiring solo probe 3 advisors** (e2e-realness, silent-failure, http-resilience). Para coherencia exhaustiva de los 26 advisors, usar `rules-distill` + extender este script.
- **No mide quality del CONTENIDO de los advisors** — solo existencia + coherencia. Un advisor mal escrito pero presente cuenta como 10/10 en su check de existencia.

## Roadmap v2

- Categoría **Eval Coverage** — cuando tengamos eval-harness portado (golden set de stories TYCON).
- Detección automática de connectors Anthropic activos (query a API claude.ai si hay endpoint público).
- Pipeline wiring coverage exhaustiva (todos los advisors, no solo probe).
- Diff tracking — comparar score actual vs último mes para detectar regresión.
- CI gate — fail si score baja > 5 puntos vs baseline (signal de regresión estructural).

## Referencias

- Script: [`scripts/lib/harness-audit.js`](../scripts/lib/harness-audit.js)
- Categoría Catalog Integrity: usa internamente [`scripts/tools/rules-distill.js`](../scripts/tools/rules-distill.js)
- Categoría Context Efficiency: lógica equivalente a [`scripts/tools/context-budget.js`](../scripts/tools/context-budget.js)
- Categoría Security Guardrails: chequea [`guides/safety-guard.md`](safety-guard.md) + [`guides/dotnet-hooks.md`](dotnet-hooks.md) + [`guides/signed-scope-guardrails.md`](signed-scope-guardrails.md)
- Inspiración: [ECC harness-audit command](https://github.com/affaan-m/ECC/blob/main/commands/harness-audit.md)


## `--parity` — la paridad de instalación Claude↔Codex (2026-08-23)

El scorecard de arriba mide el lado CLAUDE. `node scripts/lib/harness-audit.js --parity` responde la
otra pregunta: **¿el lado Codex de esta máquina refleja lo que el canónico dice?** Once
superficies de estado de disco (advisors desplegados al día · hooks registrados · skills
linkeadas · MCPs según el intent del deployer · AGENTS.md espejado · la tabla de nombres
consistente con la realidad · binario+login de codex · la llave en el rc · writable_roots ·
aprobaciones de hooks vigentes · todo deployer con superficie que lo mida). Sin LLM, ~0.3s.

Reglas de diseño (de la revisión adversarial que endureció la primera versión): la política vive
en los DEPLOYERS y el audit la importa, nunca la re-deriva · predicados con alcance, no
substrings · lo que el deployer respeta a propósito no es rojo · una superficie que crashea es
un rojo con causa, y el reporte se escribe siempre.

Cableado: corre solo en cada arranque (instalador, de fondo, tras el sync de bloques), escribe
`scripts/controls-bench/.bench/harness-parity.json`, y el rojo lo cobra `bench-notice` en el
arranque siguiente — incluido el caso "el reporte quedó viejo", que significa que la paridad
dejó de correr. Máquina sin lado Codex desplegado → "no desplegado", cero rojos. Con `--json`
devuelve el reporte crudo (schema distinto al del scorecard). Red del productor:
`scripts/tests/harness-parity.test.sh` (diaria); del consumidor: casos en el banco (suite 08).
