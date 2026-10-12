# Auditoría de costo del pipeline — un run de 3h27 (2026-06-11)

> Qué se auditó: el pipeline completo de una story de un producto (config admin de notificaciones)
> tardó **3h27 de wall-clock** y consumió **~20% del presupuesto semanal de tokens** del dev.
> Auditoría forense sobre el transcript JSONL (timestamps + usage por llamada), los logs del
> harness (`advisor-runs/*.jsonl`, `gates.log`, evidencias DoD) y el código de los scripts.
> El objetivo: no repetir una corrida de ese costo. Este doc registra los
> hallazgos, los números y los fixes aplicados — todos cableados el mismo 2026-06-11.

## Los números del run

| Métrica | Valor |
|---|---|
| Wall-clock del trabajo | 207 min (18:15→21:42Z) |
| Trabajo productivo (impl 41' + validación spec 18' + plan 8' + preflight BD 15') | ~82 min |
| Advisors (4 iteraciones, **49 spawns**) | 55 min / **3.45M tokens** |
| Test gates BE (3 corridas full ~7' c/u — 2 evitables) | 30 min |
| Gate E2E (7 corridas, 6 rojas) | 22 min |
| Reportes/DoD/commits | 23 min |
| Main thread en el rango del pipeline | 835 turnos, output 1.26M, **cache reads 399M** (~478K relectura/turno) |
| Subagentes totales | 50 spawns / 4.19M tokens (7 a Opus ≈ 35 equivalentes Sonnet) |

Un run sano del MISMO trabajo: ~2h y menos de la mitad de los tokens — sin aflojar gates.

## La cadena causal (cada eslabón confirmado con archivo:línea)

1. **`marker.fileEvents` NUNCA se escribía**: el fix del 2026-06-09 se aplicó a
   `marker.js append-file` (código muerto, 0 callers) y NO a `on-edit.js` (el writer real).
   El SKILL.md afirmaba "smart-reloop es seguro por default" — falso en el 100% de los runs.
2. → smart-reloop degradaba a delta names-only (pierde RE-ediciones = exactamente los fixes).
3. → `--force-full-reloop` recomputaba desde `--files` SIN validar existencia; un quoting roto
   de zsh (paths como UN argumento) lo degradó a 3 advisors y PERSISTIÓ un `expected[]`
   corrupto (check-count fail-open).
4. → único escape del spec D.i.1 = set COMPLETO → **iter2 + iter3 full de 13 advisors c/u**
   (~2.2M tokens que un delta sano habría reducido a ~5-6 advisors por iteración).
5. → sin `reloop_model_hints` en esos paths → spec-first (Opus) corrió 4 veces en re-loops.
6. → mech-check existía pero `computeAdvisorSet` no lo descontaba del `expected[]` →
   ac-coverage corrió 4 veces en LLM haciendo lo que el script hace gratis.
7. **Gate E2E**: `PLAYWRIGHT_WORKERS` default 8 TAMBIÉN en scoped (el step file decía
   `--workers=1` — drift doc/código) → 4 tests que mutan estado compartido del tenant
   corriendo a 8 workers → 6 corridas rojas + forensics. Además `resolve_pw_dir()` elegía
   el PRIMER playwright.config (la raíz → suite de laboratorio) en un monorepo con 2 configs.
8. **test-gate.sh**: `dotnet test` a nivel solución → race bi-assembly conocida →
   2 corridas full rojas (~14 min) + 1 tercera secuencial manual.
9. **Multiplicador silencioso**: el pipeline corrió como cola de una sesión con 2h14 de
   trabajo previo → cada turno re-leyó ~478K de contexto cacheado × 835 turnos.

## El meta-hallazgo (la falla real del sistema)

**6 de los 9 eslabones ya estaban documentados como problema conocido** — algunos 3 veces
(workers cross-talk 2026-06-10 en el comentario del propio script; cost-tiering "NO está
cableado todavía" desde 2026-05-27; full-suites-rule 3 veces; H8 scope creep del ac-coverage
desde 2026-05-21). El patrón estructural:

> **Las reglas de SEGURIDAD del harness son mandatorias y con hooks bloqueantes; las
> optimizaciones de COSTO eran opt-in, manuales o solo documentación. Un sistema así
> degrada SIEMPRE hacia el camino más caro.**

La corrección de fondo no es "ser más cuidadoso": es cablear las optimizaciones con el mismo
rigor mecánico que los gates.

## Fixes aplicados (2026-06-11, mismos commits que este doc)

| # | Fix | Dónde |
|---|---|---|
| 1 | `on-edit.js` escribe `fileEvents` (cada edición, incl. re-ediciones, cap 500) | `skills/tycon-pipeline/scripts/on-edit.js` |
| 2 | Fallback por **mtime de filesystem** en `computeSmartReloop` para markers sin fileEvents | `scripts/pipeline.js` |
| 3 | `--files` se VALIDAN: paths fantasma → abort exit 2 (no fail-open); override `--allow-missing-files` | `scripts/pipeline.js` (advisors + smart-reloop) |
| 4 | **MECH-2**: mech-check corre inline y DESCUENTA del set/expected — deferral-tracker y ac-coverage SOLO en re-loops (iter≥2; en la primera iteración su juicio LLM per-item/engram corre siempre — recalibrado por la verificación adversarial, que atrapó que el descuento desde la primera mataba al deferral-tracker permanente); feature-wiring NUNCA (mech solo cubre WIRING-C1); story ilegible → cero descuentos | `scripts/pipeline.js` |
| 5 | `reloop_model_hints` en TODOS los paths iter>1 (smart-reloop, force-full, advisors fallback); **aplicarlos es mandatory** (step-05/07b) | `scripts/pipeline.js` + steps |
| 6 | Gate E2E: workers POR SCOPE (scoped→1, full→8, env overridea); `resolve_pw_dir` junta candidatos (subdirs primero) y desambigua por spec-filter, con warning explícito | `scripts/e2e-full-gate.sh` |
| 7 | test-gate.sh: >1 proyecto de test → corrida SECUENCIAL encadenada en un run-check; parser suma TODOS los TRX | `scripts/test-gate.sh` |
| 8 | Docs corregidos (SKILL.md SPEED-1/MECH-2/Model hints + H.i, step-05, step-07b, step-07c, agents ac-coverage/spec-first) — las afirmaciones falsas quedaron registradas como historia, no borradas | SKILL.md + steps + agents |
| 9 | **Regla H.i — SESIÓN FRESCA**: el pipeline de una story arranca en sesión nueva (o `/clear`); recomendarlo ANTES del Step 0 si la sesión ya lleva trabajo de otra cosa | SKILL.md + `~/.claude/CLAUDE.md` global |

## Qué NO se cambió (deliberado)

- **D.i.1 sigue intacta**: el set completo sigue siendo la regla ante duda — lo que se arregló
  es que la válvula de escape barata (smart-reloop) FUNCIONE, no aflojar el gate.
- **feature-wiring-checker no se descuenta nunca**: en ese run el gap real (`updateNotificacionRule`
  sin UI, AC firmado sin implementar) vivía en WIRING-C2 — territorio del advisor, no del script.
  Nota de calidad pendiente: el advisor afirmó 2 veces "todas las funciones con callsites" sin
  verificar; un prompt posterior con instrucción explícita "verificá CADA función con grep" lo
  corrigió — candidato a endurecer su agent .md (backlog).
- **Los 13 advisors del set base/completitud/condicionales siguen siendo los mismos** — el
  ahorro viene de no re-correrlos cuando un script prueba que no hace falta.

## Verificación de los fixes

- `node --check` × 3, `bash -n` × 2, guard test `test-pipeline-coverage.js` ✓, unit suite 13/13 ✓.
- Smokes funcionales: files fantasma → exit 2 ✓; iter1 mantiene ac-coverage ✓; iter2 lo
  descuenta con razón mecánica + hint spec-first→sonnet ✓; mtime-fallback detecta SOLO el
  archivo re-tocado ✓; on-edit registra re-ediciones en fileEvents ✓.
- Verificación adversarial: 5 agentes independientes intentando refutar cada dominio de fix
  (resultados en el commit message / sesión de auditoría).

## Ahorro esperado por run (estimado sobre los números de ese run)

- Re-loops: 13+13 advisors → ~5-6 c/u ≈ **-1.4M tokens, -25/30 min**.
- Opus en re-loops → Sonnet ≈ **-60-70% del costo de los spawns más caros**.
- Gate E2E scoped a 1 worker + dir correcto ≈ **-15/20 min de loop rojo falso**.
- test-gate secuencial ≈ **-14 min** (1 corrida en vez de 3).
- Sesión fresca ≈ **÷4-5 los cache reads del main thread** (el ítem más grande de todos).

## Recortes aplicados (2026-06-11, segunda pasada — "¿algo que haga el pipeline que no sea necesario?")

| # | Recorte | Skip-condition mecánica |
|---|---|---|
| R1 | `dod-runtime-checker` advisor condicional | Gate E2E verde+fresco + smoke macro PASS + self-audit presente + sin workers/transaccional/multi-pipeline en el diff → los exit codes de los scripts + los 2 hooks bloqueantes son la defensa; el advisor solo donde los scripts no llegan (step-07c §7c.2). Ahorro ~100K tokens/run. |
| R2 | `sibling-pattern-reviewer` → `sonnet` de base | Mismo movimiento que ac-coverage 2026-05-27. Opus queda como excepción explícita para stories sin patrón hermano / anclas dudosas. Ahorro ~150K tokens-equivalentes/story BE. |
| R3 | `spec-first` pre-coding skip | Step 1 cerró 0 CRITICAL en esta corrida + el plan no sale de `files_to_create/modify` → el post-impl del Step 5 (siempre corre) cubre el drift real (step-04). Ahorro ~80K tokens Opus/run. |
| R4 | Hooks ignoran contenido no-humano | task-notifications/outputs de comandos citaban texto que matcheaba los patterns (INTENT-detect disparó 2× en falso citando la propia evidencia de esta auditoría). Guard en tycon + clocki on-prompt.js. |

**NO recortado (evaluado y descartado)**: la full suite del test-gate en Step 4 — es la
"1 full pre-commit" que la regla del equipo permite, y en ese run atrapó 2 rojos reales en
tests globales (arch-tripwire + seed) que un scoped no habría corrido. Los 13 advisors,
el E2E scoped, el self-audit y los HITL quedan: cada uno tiene un incidente con nombre.
