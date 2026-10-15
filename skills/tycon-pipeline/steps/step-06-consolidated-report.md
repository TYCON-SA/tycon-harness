# Hallazgos: el informe

**Objetivo**: juntar los outputs de los 3 (o N) advisors del Step 5 en un solo reporte estructurado para el usuario. Aquí NO corre nada nuevo — es lógica del orchestrator.

## Inputs

- `advisor_reports[]`: lista de reportes individuales de Step 5
- `adversarial_confirmed[]` (si el Step 5b corrió): los findings CONFIRMED del pase reproduce-or-refute. Se
  foldean al reporte como una "fuente" más: cada uno se cita `[adversarial-verify:<lens>]` con `file:line` +
  `summary` + el `repro` observado. `severity: bug` → cuenta como **CRITICAL de correctitud**; `robustness` →
  WARNING. Disparan el re-loop D.i igual que un finding de advisor (pero el 5b NO se re-corre — ver step-05b).

## Lógica de consolidación

**Formato uniforme**: TODOS los advisors emiten el mismo formato markdown
(`# {advisor}` + `**Status**: 🔴/🟡/✅` + secciones `## 🔴 CRITICAL` / `## 🟡 WARNING` con
items `- [RULE-ID] ...`). Ya NO hay advisors que emitan JSON — el parseo es uno solo, no
"JSON o markdown según el advisor".

Para cada reporte de advisor, parsear:
- Count de `CRITICAL` (items bajo `## 🔴 CRITICAL`)
- Count de `WARNING` (items bajo `## 🟡 WARNING`)
- Lista de items `CRITICAL`
- Lista de items `WARNING`
- Lista de items `OK` (opcional en el reporte final)

## Formato del reporte consolidado (ARTEFACTO — no es el mensaje al chat)

🔴 **Leer antes de usar este formato (regla COMM.ii del SKILL.md)**: lo que sigue es el formato del
**archivo** `step-06-consolidated-report.md` que se escribe en `.advisors/pipeline-runs/<run-dir>/`.
Es la auditoría: va completo, con todos los rule IDs, `file:line` y fixes. **NO se vuelca al chat.**

Al chat va un **resumen ejecutivo de 3-6 bullets en castellano llano** (ver "Qué va al chat" abajo).
El volcado crudo de este reporte al chat es un anti-pattern explícito — enterraba el resumen real.

```markdown
# Advisor Report — Story {story_id}

**Status**: {🟢 OK / 🟡 N WARNING / 🔴 N CRITICAL}
**Advisors que corrieron**: {N}/{total}
**Tiempo total**: {s}s

---

## 🔴 CRITICAL (N)

{Por cada CRITICAL, formato "- [advisor-name] {mensaje}"}

### Ejemplos (con rule ID citado):
- [SEC-C1] `Features/Voice/PacaraService.cs:147` callId interpolado raw en URL. Fix: `Uri.EscapeDataString(callId)` + route constraint `{callId:guid}`.
- [DOTNET-C2] `Features/Auth/AuthEndpoints.cs:18` `HttpContext.User.FindFirst("sub")` usado. Fix: inyectar `IUserIdResolver` y usar `GetRequiredUserIdAsync()`.
- [TEST-C2] `PacaraService.IniciarLlamadaVozAsync` (línea 124) tiene 0% coverage. Fix: mockear `HttpMessageHandler`, no el service.

**Regla crítica del reporte consolidado**: todo finding DEBE citar su rule ID entre corchetes al inicio (ver `guides/advisor-rules-catalog.md`). Si un advisor reportó un finding sin rule ID, el consolidator lo marca como `[NO-ID]` y agrega una nota al final del reporte indicando que el advisor está mal calibrado.

## 🟡 WARNING (N)

{Agrupados por advisor, formato "### tycon-plugin-X \n - item1 \n - item2"}

### Ejemplo:
### tycon-plugin-tests-coverage
- AC3 (rate-limiting) no tiene test asociado
- Coverage de `OrderSyncHandler.cs` = 68% (threshold 75%)

### tycon-silent-failure-hunter
- `LineManager.ReleaseLineIfHeldAsync` traga la excepción sin log

## ✅ OK
- Full test suite: X/X PASS, 0 regresiones
- Sin secretos detectables
- {otros items OK resumidos}

---

**Reportes completos** en `.advisors/pipeline-runs/<clave>-<sello>/`
```

## Qué va al chat (regla COMM.ii)

El artefacto de arriba se escribe SIEMPRE completo. Al usuario le llega esto:

```markdown
**Advisors: {🟢 limpio | 🟡 N warnings | 🔴 N críticos}**

- {qué se revisó, en llano: "revisé seguridad, convenciones .NET, cobertura y wiring"}
- {hallazgo 1 en llano, sin rule ID ni file:line — qué pasa y por qué importa}
- {hallazgo 2 ...}
- {qué quedó OK que valga la pena decir: "la suite pasó entera, sin regresiones"}

{Si hay CRITICAL → acá manda COMM.i: resumen + pregunta + detalle. Si no hay CRITICAL → una línea:}
Detalle completo (rule IDs, archivos, fixes propuestos) en `.advisors/pipeline-runs/<run-dir>/`
— decime si querés que te lo pegue acá.
```

**Traducción obligatoria de jerga a llano** en los bullets del chat:

| En el artefacto | En el chat |
|---|---|
| `[SEC-C1] Features/Voice/X.cs:147 callId interpolado raw en URL` | "un parámetro de la URL entra sin escapar — riesgo de inyección" |
| `[TEST-C2] X.IniciarLlamadaAsync (línea 124) 0% coverage` | "el método nuevo de iniciar llamada no tiene tests" |
| `[WIRING-C2] store action sin callsites` | "el botón está hecho pero no está conectado a nada" |

Con **más de 5-6 hallazgos**, no los listes uno por uno: agrupá por tema ("4 cosas de cobertura,
2 de convenciones") y ofrecé el detalle. La lista exhaustiva es exactamente lo que el artefacto
ya guarda.

## `findings.json` estructurado — write DETERMINISTA

Además del `.md`, el step ESCRIBE `findings.json` en el dir de pipeline-runs: un array de
`{rule_id, severity, advisor, file, disposition, reason}` con `disposition` ∈
`"fixed" | "waived" | "deferred" | "open"`. Es el insumo del `tycon-retrospective-capturer`
para las métricas `advisor_warnings_per_story` / `actioned_ratio` (determinista, sin LLM).

🔴 **NO lo escribas a mano** (un write manual del orquestador se olvida, y sin el archivo el conteo
se rompe). Usá el comando, que
valida el schema y resuelve/crea el run dir solo:

```bash
# El array de findings va por --findings (archivo JSON o '-' = stdin).
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js write-findings \
  --story <story_path> --repo <repo> --findings <array.json | ->
```

### 🔴 El `advisor` se ELIGE de los que corrieron — no se escribe libre

`write-findings` valida el firmante de cada hallazgo contra el `review-roster.json` de ESA corrida.
No hay que hacer nada nuevo: se escribe el nombre del advisor y el comando resuelve el resto.

- **Vale**: un revisor de la ronda del paso 5, un agente de los pasos previos (paso 1, validación de
  la story), o una fuente propia del pipeline (`mech-check`, `pase adversarial`, `orquestador`,
  `runtime-matrix`, `e2e-runtime`, `ensayo runtime`, `adversarial-verify`, `pipeline`).
- **No vale**: cualquier otro texto. El comando FALLA, nombra el valor que recibió, lista los
  firmantes válidos de la corrida y **no escribe nada**. Si el hallazgo lo firmó el propio pipeline
  (no un subagente), la firma es una fuente propia — típicamente `orquestador`.
- **La anotación se puede seguir escribiendo** y no se pierde: `tycon-silent-failure-hunter (iter 3)`
  se guarda como `advisor: "tycon-silent-failure-hunter"` + `iter: 3`. El modelo va a `model` y
  cualquier otra cosa a `nota`. Además cada hallazgo queda con su `tramo`
  (`revision` | `previo` | `pipeline`), que es contra qué lista lo compara el portón.
- **Si el roster todavía no existe** (se escribe cuando el hook cierra la ronda de revisores), o es
  ilegible, o no trae lista de revisores: **no frena** — escribe igual y AVISA cuál de los tres casos
  es. Un control que no puede correr no aprueba, pero tampoco deja al dev sin anotar lo que encontró.

Por qué: el nombre se escribía en dos lados con dos criterios (el roster, mecánico desde el ledger
de spawns; el `advisor`, tipeado) y el cruce del portón los comparaba letra por letra: frenaba
stories sanas con hallazgos que eran del propio control.

- Cada finding: `{rule_id, severity(CRITICAL|WARNING), advisor, file, disposition(fixed|waived|deferred|open|refuted), reason}`
  (+ `tramo`, y `iter`/`model`/`nota` cuando el nombre traía anotación — los pone el comando, no vos).
  🔴 **Un hallazgo de `mech-check` que el advisor especializado de esa misma regla confirma como FALSO**
  (limitación del matcher, no gap real — por ejemplo ACCOV-C1 sobre una suite bash) va con
  `disposition: refuted` y la razón del advisor como `reason`. NO es `open` (no queda deuda) ni `waived`
  (nadie lo aceptó: se refutó). `false-positive` se acepta como sinónimo. Con `open` la story queda
  penalizada en `advisor_warnings_actioned_ratio` por un hallazgo que sí se investigó y cerró.
  Tolera `ruleId`/`rule`/`summary` como alias; normaliza severity/disposition inválidos.
- `disposition: fixed` = resuelto en esta corrida; `waived` = aceptado por el user / refutado; `deferred`
  = follow-up documentado; `open` = accionable sin resolver.
- Escribe `<run-dir>/findings.json` (mismo dir que `step-06-consolidated-report.md`). Devuelve counts
  (critical/warning + por disposition). Un run con 0 findings igual escribe `[]` (el artefacto SIEMPRE existe).
- **Enforcement**: Step 8 corre `pipeline.js findings-status` como pre-condición (exit 3 si falta) — no
  se puede llegar al commit-prep sin el artefacto.

```json
[
  { "rule_id": "SEC-W1", "severity": "WARNING", "advisor": "tycon-plugin-security-basics",
    "file": "Features/Armado/ArmadoService.cs", "disposition": "waived", "reason": "auto_waive en .tycon/advisors.yaml" }
]
```

## Persistir Review Follow-ups EN la story (adopción BMAD 2026-07-02)

Después de escribir `findings.json`, persistir los findings **no resueltos** (disposition
`waived` / `deferred` / `open`) como sección checkbox DENTRO de la story. Es la mejor idea de
`bmad-dev-story`: el ciclo dev↔review vive en el artefacto y sobrevive sesiones — si el
pipeline muere post-Step 6 con un CRITICAL waived o WARNINGs abiertos, la próxima sesión los
ve en la story (Step 0/1 los detecta), no hay que arqueologizar `.advisors/pipeline-runs/`.

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js write-followups \
  --story <story_path> \
  --findings <repo>/.advisors/pipeline-runs/<clave>-<sello>/findings.json
```

- **Idempotente por `fkey` (`ruleId|file`)**: en re-loops (Step 7b → Step 5 → Step 6) re-correr
  esto NO duplica ni pierde el estado — preserva los `[x]` que el dev marcó al resolver, agrega
  los findings nuevos abiertos, y conserva los ya resueltos como historial.
- **`disposition: fixed` → `[x]`** automático (finding ya resuelto en esta corrida). `waived` /
  `deferred` / `open` → `[ ]` (accionables).
- **Solo toca el BODY** de la story (sección `## Review Follow-ups (Advisors)`). NUNCA el
  frontmatter contractual — esa transición sigue siendo exclusiva del orquestador vía `marker.js`.
- Anunciar al user el conteo (`open` / `resolved`) que devuelve el comando.

## Decisiones

- **Orden de CRITICAL primero**: los CRITICALs van al tope del reporte, antes que warnings. El usuario debe verlos primero.

- **Agrupar por advisor** en WARNINGs ayuda a entender contexto. En CRITICALs no se agrupa porque cada uno es importante individual.

- **Si algún advisor falló**: incluir una sección "⚠️ Advisors que no pudieron correr" al final con la razón.

## Cierre del step

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js complete-step 6
```

## Output de este step

- `consolidated_report` (markdown completo)
- `findings.json` (array estructurado en el dir de pipeline-runs — ver arriba)
- `has_critical: true|false`
- `has_warning: true|false`
- `total_issues: N`

Pasar al Step 7.
