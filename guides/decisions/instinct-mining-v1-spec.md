# instinct-mining v1 — spec (PROPUESTA, no implementada)

**Estado**: SPEC pre-implementación. NO existe código todavía. Documento de diseño para resolver decisiones abiertas antes de implementar.

**Por qué**: el análisis ECC → TYCON (2026-05-23) identificó instinct mining como el item de mayor impacto pero también el de mayor riesgo. Esta spec captura las decisiones abiertas para que la próxima sesión sea ejecución, no diseño.

**Referencia**: [ECC continuous-learning-v2](https://github.com/affaan-m/ECC/blob/main/skills/continuous-learning-v2/SKILL.md).

---

## Goal

**Que el harness aprenda solo, sin depender de que el agente se acuerde de `mem_save`.**

Hoy: cuando me corregís ("no, así no, hacelo distinto"), si yo no me acuerdo de guardarlo en engram, se pierde. Vos lo viviste con feedbacks como "explicame sin jerga", "los advisors no van cherry-pick", "demos Playwright reproducibles" — los escribiste vos a mano.

Mañana: un *grabador silencioso* atrás. Cada vez que terminás una sesión, otro Claude más barato (Haiku) lee lo que pasó y propone "mirá, esto pasó 3 veces — lo guardo como regla?". Vos decís sí o no.

## Mecánica (overview)

```
┌─────────────────────────────────────────────────────────────┐
│  En CADA sesión TYCON (transparente, sin intervención):     │
│                                                              │
│   Tool call ──→ PostToolUse hook ──→ observe.sh             │
│                                              │              │
│                                              ▼              │
│                                  observations.jsonl         │
│                          (prompt, tool, outcome, ts, proj)  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ (batch nightly o post-sesión)
┌─────────────────────────────────────────────────────────────┐
│  Observer (Haiku background subagent):                       │
│                                                              │
│   - Lee observations.jsonl del último período                │
│   - Detecta patrones (corrección repetida, workaround, etc) │
│   - Score confidence 0.3-0.9                                 │
│   - Genera atomic instincts YAML                             │
│                                                              │
│  ──→ inbox/instincts/pending/                                │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ (review HITL semanal)
┌─────────────────────────────────────────────────────────────┐
│  Vos revisás los instincts pending:                          │
│                                                              │
│   - Aprobar → promoter a engram observation                  │
│   - Rechazar → archivar con razón                            │
│   - Editar → fixear el shape antes de promote               │
│                                                              │
│  Instincts con >=2 observaciones + conf >=0.8 → engram     │
└─────────────────────────────────────────────────────────────┘
```

---

## Decisiones abiertas (resolver ANTES de implementar)

### D1 — ¿Cuándo dispara el observer?

| Opción | Pros | Cons | Costo estimado |
|---|---|---|---|
| **(A) Hook `Stop` en cada sesión** | Captura mientras está fresco | Cada cierre paga el costo del Haiku | ~USD 0.10-0.30/sesión |
| **(B) Cron nightly** | Batch eficiente, 1 sola corrida/día | Hasta 24h de delay para ver insights | ~USD 0.50-1/día |
| **(C) Manual `/tycon-observe`** | Cero costo automático; vos decidís | Probable que se olvide → falla por falta de uso | ~USD 0/sesión hasta que invoques |

**Recomendación tentativa**: **(B) cron nightly** para v1. Mejor batch que pago por sesión. Si después de 1 mes vemos que el delay duele, migrar a (A) selectivo (solo sesiones >2h).

**Tu input requerido**: ¿(A), (B), o (C)?

### D2 — ¿Qué se logguea en observations.jsonl?

Opciones:

| Opción | Privacidad | Útil para patterns |
|---|---|---|
| **(A) Todo el tool call + outcome** | ⚠ leak risk (paths, secrets) | Máximo signal |
| **(B) Solo tool name + estado + duración** | ✓ no leak | Mínimo signal — no captura corrections semánticas |
| **(C) Tool name + outcome + sanitized prompt** (sin paths absolutos, sin secrets) | ✓ low leak | Balance recomendado |

**Recomendación tentativa**: **(C)** con sanitization explícita en `observe.sh`:
- Reemplazar paths absolutos por placeholders (`/Users/<usuario>/` → `$HOME/`).
- Filtrar líneas que matcheen patterns de secrets (regex genérica).
- Truncar prompts >500 chars al body.

**Tu input requerido**: ¿(A), (B), o (C) + nivel de sanitization?

### D3 — ¿Quién es el observer Haiku?

| Opción | Costo | Latencia |
|---|---|---|
| **(A) Subagent via Task tool desde el Stop hook** | Caro (un Task call por sesión) | ~10-30s al cerrar sesión |
| **(B) CLI script externo invocando Haiku via API** | Mismo costo, sin bloquear Claude Code | ~10-30s en background |
| **(C) Local LLM (Ollama / Llama)** | Cero | Más lento, calidad menor |

**Recomendación tentativa**: **(B)** Node script `scripts/instincts/instinct-observer.js` que invoca Anthropic API directamente. Aislado del flujo Claude Code, ejecutable via cron, fácil de loggear.

**Tu input requerido**: ¿(A), (B), o (C)?

### D4 — ¿Cuál es el formato del "instinct"?

ECC usa YAML con:
```yaml
trigger: "user dice 'X'"
action: "hacer Y"
confidence: 0.85
domain: "auth"
evidence: ["session-abc", "session-xyz"]
scope: project  # o global
```

**Recomendación**: usar este shape literal, agregar `proposed_at: ISO`, `engram_promoted: bool`.

**Pregunta abierta**: ¿queremos un campo `tycon_artifact_suggestion`? Por ejemplo: "este patrón debería convertirse en una skill / advisor / hook". Si SÍ → el `/tycon-evolve` (futuro) lee esto y propone crear el artifact.

**Tu input requerido**: ¿agregar `tycon_artifact_suggestion`?

### D5 — ¿Threshold de promoción a engram?

ECC sugiere: aparece en ≥2 proyectos + confidence ≥0.8.

**Problema para TYCON**: tenés 1-2 proyectos activos típicos (Ceibo dominante + alguno secundario). El threshold "2 proyectos" rara vez se cumple → todos los instincts quedan pending eternamente.

**Recomendación TYCON**: aparece ≥3 veces en CUALQUIER proyecto + confidence ≥0.85.

**Tu input requerido**: ¿confirmás el threshold o querés ajustar?

### D6 — ¿Dónde viven los instincts pending y promoted?

Opciones:

| Opción | Pros | Cons |
|---|---|---|
| **(A) `tycon-claude-guides/inbox/instincts/{pending,promoted,archived}/`** | Versionado con git | Pollution del repo, sensible (sanitization importa) |
| **(B) `~/.claude/projects/<hash>/`, subcarpeta `instincts`** | Local-only, no commiteado | No se comparte cross-machine ni cross-dev |
| **(C) `~/.tycon/`, subcarpeta `instincts`** | Local-only, neutral path | Igual que (B) |

**Recomendación tentativa**: **(B)** — local-only, scope per-proyecto, no commitea. Solo cuando promotís a engram, el insight cruza máquinas vía engram MCP.

**Tu input requerido**: ¿(A), (B), o (C)?

### D7 — ¿Review HITL: cómo te aviso?

Opciones:

| Opción | UX |
|---|---|
| **(A) Telegram message diario con N instincts pending** | Notificación push, podés revisar mobile |
| **(B) Comando manual `/tycon-instincts review`** | Vos decidís cuándo, sin push |
| **(C) Banner al arrancar sesión** | Friction in-flow, podés ignorarlo |

**Recomendación tentativa**: **(A) Telegram** — ya tenés el bot configurado, push notifications funcionan, y revisás 5 minutos un domingo a la semana.

**Tu input requerido**: ¿(A), (B), o (C)?

---

## Costo estimado total

Asumiendo:
- 5-10 sesiones TYCON / día
- Promedio 50-200 tool calls / sesión
- observations.jsonl: ~5-20 KB / sesión
- Observer batch nightly: lee el JSONL del día, genera N instincts
- Input al Haiku: ~10-50K tokens (logs concatenados sanitizados)
- Output del Haiku: ~2-5K tokens (instincts YAML + razonamiento)
- Modelo: `claude-haiku-4-5-20251001` (~USD 1/M input, USD 5/M output)

**Costo diario estimado**:
- Input: 50K × $1/M = USD 0.05
- Output: 5K × $5/M = USD 0.025
- **Total: ~USD 0.07/día = USD 2.10/mes**

Para 1 dev. Para 2-3 devs TYCON: ~USD 5-8/mes.

**Valor estimado**: si captura 1 feedback/semana que sino se perdía + lo convierte en regla aplicada en sesiones futuras = ahorrás minutos de re-explicar lo mismo. Conservador: 30 min ahorrados/mes/dev. A USD 50/hora dev = USD 25/mes de valor.

**Ratio**: ~10x valor vs costo. Vale la pena implementarlo SI se usa. Si nadie revisa los pending = feature dead = costo sin valor.

**Mitigación riesgo "feature dead"**:
- Empezar opt-in (`TYCON_INSTINCT_MINING=1` env var).
- Métrica: contar `instincts_promoted_per_month` en `harness-audit.js` v2. Si <2/mes durante 3 meses → desactivar.
- Telegram reminder: si hay >5 pending desde hace >7 días → push.

---

## Plan de implementación (próxima sesión)

**Pre-flight (vos)**:
- Resolver D1-D7 (6 decisiones de diseño).
- Estimar realísticamente cuántas sesiones TYCON tenés por semana.

**Sesión de implementación (~3h estimadas)**:

1. **Hook `observe.sh` + observations.jsonl** (30 min)
   - PostToolUse hook que escribe a JSONL.
   - Sanitization según D2.

2. **Observer Node script** (1h)
   - `scripts/instincts/instinct-observer.js`.
   - Anthropic API call (Haiku).
   - Prompt template para detección de patterns.
   - Output YAML al directorio decidido en D6.

3. **Cron / Stop hook según D1** (30 min)
   - Configurar trigger.

4. **Review flow** (30 min)
   - Comando `/tycon-instincts review` o equivalente según D7.
   - Promoter a engram para approvals.

5. **Spec inicial probada** (15 min)
   - Correr 1 día con observaciones reales.
   - Verificar que el observer produce algo útil.

6. **Doc + smoke test** (15 min)
   - `guides/instinct-mining.md`.
   - Update README + harness-audit (nueva categoría "Learning Loop"?).

**Total tentativo: 3h. Si validás D1-D7 antes, son 3h de ejecución continua sin re-diseño.**

---

## Riesgos identificados

| Riesgo | Mitigación |
|---|---|
| **Costo del observer >> valor** | Métrica de promoted_per_month, opt-out simple |
| **Sanitization incompleta → leak de secrets en JSONL** | Regex tests + review manual del primer JSONL antes de habilitar observer |
| **Observer Haiku produce instincts triviales o ruido** | Threshold confidence + review HITL antes de promotar |
| **Devs ignoran los pending** | Telegram reminder + visibilidad en harness-audit |
| **JSONL crece sin límite** | Rotación: archivar a `observations.archive/` tras 30 días |
| **Privacidad / specs de cliente en JSONL** | Path-based exclusion (specs/clients/*.md no se logguea) |

---

## Preguntas para vos antes de implementar

**Bloque A — diseño (6 decisiones)**:
- D1: ¿(A) Stop hook, (B) cron nightly, (C) manual? **Recomendado: (B)**
- D2: ¿(A) todo, (B) mínimo, (C) sanitized? **Recomendado: (C)**
- D3: ¿(A) subagent Task, (B) Node script, (C) local LLM? **Recomendado: (B)**
- D4: ¿agregar `tycon_artifact_suggestion`? **Recomendado: SÍ**
- D5: ¿threshold 3+ apariciones + 0.85 confidence? **Recomendado: confirmá**
- D6: ¿(A) repo git, (B) local-only `~/.claude/projects/`, (C) `~/.tycon/`? **Recomendado: (B)**
- D7: ¿(A) Telegram, (B) comando manual, (C) banner sesión? **Recomendado: (A)**

**Bloque B — uso real**:
- ¿Cuántas sesiones TYCON tenés/semana aproximadamente?
- ¿Vas a tener tiempo de revisar los pending (5 min/semana)?
- ¿Querés que esto corra en tus 2 máquinas o solo en la principal?

**Bloque C — alcance**:
- ¿Empezamos solo con tu proyecto Ceibo o multi-proyecto desde día 1?
- ¿Querés que el observer también capte feedbacks "explica mejor" / "sin jerga" para auto-actualizar memorias `feedback-*`?

---

## Cierre del spec

Si respondés los 6 puntos del Bloque A + los 3 del Bloque B y C, la próxima sesión es **ejecución pura** ~3h. Sin re-diseño in-flight, sin "y si hacemos X?". Eso es lo que diferencia esta sesión de la de hoy donde porteamos 7 patterns mecánicamente.

**Status**: SPEC ABIERTA — esperando input del dev (el dev) sobre Bloques A/B/C.

**Cuando esté cerrada**: este file pasa a `guides/instinct-mining.md` (sin `-v1-spec`) y se reemplaza con la documentación final post-implementación.

## Referencias

- ECC continuous-learning-v2: [github.com/affaan-m/ECC/blob/main/skills/continuous-learning-v2/SKILL.md](https://github.com/affaan-m/ECC/blob/main/skills/continuous-learning-v2/SKILL.md)
- Análisis ECC → TYCON 2026-05-23: engram observations del día (8 decisiones tipo "Portado X ECC → TYCON v1")
- Items completados del roadmap previos a éste: safety-guard, context-budget, silent-failure-hunter, skill-scout, rules-distill, resolver-orphans, harness-audit
