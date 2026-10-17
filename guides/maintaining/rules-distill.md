# rules-distill — auditoría estructural catalog ↔ advisors

Script Node que cruza el catálogo de reglas (`advisor-rules-catalog.md`) con los rule IDs que realmente citan los advisors en `~/.claude/agents/`. Detecta drift entre lo documentado y lo enforced.

Inspirado en [ECC rules-distill](https://github.com/affaan-m/ECC/blob/main/skills/rules-distill/SKILL.md). **Simplificado**: ECC usa LLM cross-read para extraer principios de skills sin IDs. TYCON ya tiene IDs estables (`SEC-C1`, `DOTNET-W3`, etc.), así que el check es 100% determinístico — no requiere LLM.

## Cuándo correrlo

- **Mensual** (mantenimiento de catalog).
- Después de agregar un advisor nuevo (`tycon-silent-failure-hunter`, etc.) o una skill/hook con reglas.
- Después de un refactor grande del catalog.
- Antes de un release o demo, para asegurar que la documentación pública del harness está al día con el código.

## Uso

```bash
node ~/.claude/tycon-harness/scripts/tools/rules-distill.js          # reporte
node ~/.claude/tycon-harness/scripts/tools/rules-distill.js --verbose # extra detail (todos los items, no top 20)
node ~/.claude/tycon-harness/scripts/tools/rules-distill.js --json   # output JSON
```

No requiere instalación — Node puro, sin dependencias.

## Qué detecta (5 categorías)

| Categoría | Definición | Prioridad de fix |
|---|---|---|
| **BROKEN-REFS** | catalog declara un owner que no existe en filesystem (typo, advisor renombrado o removido) | 🔴 Alta — catalog miente |
| **ORPHANS** | advisor cita rule ID pero el ID no está en catalog | 🟡 Media — regla invisible |
| **ZOMBIES** | catalog declara rule ID con owner = advisor, pero ese advisor NO la cita | 🟡 Media — regla doc sin enforcement |
| **OWNER-MISMATCH** | catalog asigna owner = X, pero X no la cita (otros sí) | 🟢 Baja — corregir asignación |
| **NON-ADVISOR ENFORCED** | catalog declara owner = hook script o skill (no advisor) | ⚪ Informativo — no es error |

Multi-owner se reporta separado (regla citada por >1 advisor) — suele ser OK si es regla compartida cross-advisor.

## Cómo funciona

### Paso 1 — Parse del catalog

Busca secciones con header `## NAME — \`owner\``. El `owner` puede ser:
- **Advisor** (`tycon-X` o `X-reviewer` que tiene archivo en `~/.claude/agents/<owner>.md`).
- **Hook script** (`.sh`/`.js`/`.ps1`/`.py` que vive en `~/.claude/tycon-harness/scripts/` o `scripts/hooks/`).
- **Skill** (que vive en `~/.claude/agent-skills/skills/<owner>/SKILL.md`).
- **Unknown** (si no matchea ninguno → broken-ref).

Por cada sección, extrae los rule IDs (regex `[A-Z]+-[CW]\d{1,2}`) con owner asignado.

Para que TUS reglas custom queden bien clasificadas, **el header de la sección DEBE tener el formato `## NAME — \`owner\``** con backticks. Si tu header NO los tiene, las reglas se "comen" en la sección anterior y el reporte sale mal.

### Paso 2 — Parse de advisors

Para cada `.md` en `~/.claude/agents/`, extrae todos los rule IDs mencionados (regex igual). No diferencia menciones legítimas vs anti-patterns ("NO inventes SEC-C1"): ambas cuentan como cita. Falsos positivos meta-textuales son raros pero esperables.

### Paso 3 — Cross-check

Para cada ID en catalog:
- Si tiene owner = advisor y el advisor NO lo cita → **ZOMBIE**.
- Si tiene owner = hook/skill → **NON-ADVISOR ENFORCED** (informativo).
- Si tiene owner = unknown → **BROKEN-REF**.

Para cada ID citado por advisor:
- Si NO está en catalog → **ORPHAN**.
- Si está pero el owner del catalog no lo cita → contribuye a OWNER-MISMATCH.

## Caso real (corrida 2026-05-23 contra catalog actual)

Primer find concreto: **74 orphans**. La cobertura real de los advisors TYCON es ~30-40% mayor que la que documenta el catalog.

Top groups orphan:
- `AUTH-C1..C6` + `AUTH-W1..W3` (10 reglas) en `auth-session-reviewer`
- `DRIZZLE-C1..C5` + `DRIZZLE-W1..W4` (9 reglas) en `drizzle-migration-reviewer`
- `LLMCOST-C1..` en `llm-cost-reviewer`
- `TENANT-*` shared entre `auth-session-reviewer` + `multi-tenant-isolation-reviewer`
- `REAL-C1..C3` en `tycon-e2e-realness-checker`
- `DODRT-C4` en `tycon-dod-runtime-checker`

Esto indica que el catalog quedó atrás de los advisors. Trabajo pendiente: agregar las 74 reglas al catalog en una pasada.

Zombies legítimas (3): `PIPE-C1..C3` con owner declarado `tycon-ac-coverage-checker` pero ese advisor NO las cita. Posibles fixes:
- Las PIPE-* son del pipeline orchestrator (`tycon-pipeline`), no de un advisor reviewer → corregir owner.
- O reasignar a otro advisor que las enforce.

## Limitations v1

- **No detecta reglas semánticamente duplicadas con IDs distintos**: si `SEC-C5` y `TENANT-C3` enforcean el mismo principio con palabras diferentes, no lo detecta. Eso requiere LLM (roadmap v2 si vale).
- **Falsos positivos meta-textuales**: una mención de `SEC-C1` en un anti-pattern ("NO inventes SEC-C1") cuenta como cita. Inspeccionar manualmente si el advisor que aparece como "owner" sospechoso solo lo menciona de forma meta.
- **Solo lee `.md` en `~/.claude/agents/`**: las skills y los hooks que enforcean reglas NO se escanean para detectar "uso real" — solo el catalog declara owner. Por eso las reglas FS-* / GIT-* / etc del safety-guard quedan en "non-advisor enforced": el script no lee el `safety-guard-pre.sh` para verificar que la regla está implementada, solo confía en que el archivo existe.
- **Header de sección con formato rígido**: requiere `## NAME — \`owner\``. Si el header tiene `\`` en otro lugar (ej: "## Foo — usa `mi-tool`"), el parser puede tomar el primer backtick como owner. Solución: mantener un solo `\`<owner>\`` después del em-dash.

## Roadmap v2

- Detectar reglas semánticamente similares con IDs distintos (vía embeddings o LLM batch).
- Escanear scripts/hooks (no solo advisors) para verificar que las reglas declaradas en catalog con owner = hook están REALMENTE implementadas ahí.
- Auto-generar PRs sugeridos para reasignar zombies / agregar orphans al catalog (output como diff).

## Referencias

- Script: [`scripts/tools/rules-distill.js`](../../scripts/tools/rules-distill.js)
- Catalog: [`guides/advisor-rules-catalog.md`](../advisor-rules-catalog.md)
- Inspiración: [ECC rules-distill](https://github.com/affaan-m/ECC/blob/main/skills/rules-distill/SKILL.md)
- Complementa: [`skill-scout`](skill-scout.md) (búsqueda PRE-creación) ↔ [`rules-distill`](rules-distill.md) (consolidación POST-creación)
