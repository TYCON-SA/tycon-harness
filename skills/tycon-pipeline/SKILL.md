---
name: tycon-pipeline
description: Orquesta el pipeline completo TYCON — valida la story con tycon-story-validator, invoca el skill BMAD apropiado (bmad-dev-story / bmad-agent-dev / bmad-agent-quick-flow-solo-dev) en plan mode, aprueba el plan con el usuario, ejecuta la implementación con build-gate, invoca los advisors en paralelo (set computado mecánicamente por `pipeline.js mech-check` + `pipeline.js advisors` — ver sección "Revisores: checklist" abajo), consolida los reportes, y prepara el commit sin ejecutarlo. Usar cuando el usuario pide "implementemos la story X", "implementar historia", "apply tycon pipeline" o equivalentes.
---

# tycon-pipeline

Orquesta el workflow TYCON completo: skills BMAD + advisors TYCON con checkpoints HITL. Este archivo tiene
las REGLAS; el porqué de cada una (con su medición) vive en el archivo de su paso. Los guiones se corren con el comando
entero, `node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js <subcomando>` (igual `marker.js`; en
Codex, `~/.codex/skills/…`): no se buscan.

## ⚠️ NO bypass del orchestrator

Toda transición de campo contractual de una story Mary+GOLD (`status:`, `sprint:`/`signed_for_sprint:`,
`pipelines.*.status:`, `work_item:`) va por este orchestrator, NUNCA con Edit/Write a mano: el
orquestador coordina side-effects atómicos (las horas, cierre del WI de ADO con `CompletedWork` ≠ `Effort`,
engram, re-corrida de advisors, verificación cross-repo).

| Operación | Cómo |
|---|---|
| `ready-for-dev → in-progress` + codear | `/tycon-pipeline implement <spec>` |
| `review → done` post-merge | `/tycon-pipeline close <N.M>` |
| Cambio de sprint | `change-requests/cr-NNN-*.md` + commit firmado, no el pipeline |
| Re-asignar `work_item` | `work-item-field.js set` + commit, no el pipeline |

"Mi caso es excepción" → NO. Si el orchestrator no cubre el caso, se extiende; no se bypasea.

## 🔴 Revisores: checklist (MANDATORY)

1. `pipeline.js mech-check --repo <r> --story <s>` primero (ACCOV-C1/C5, DEFTR-C1/C2, WIRING-C1 sin LLM).
   Descuento MECH-2: sólo en re-loops (iter≥2) sin ambiguos de su familia se descuentan ac-coverage y
   deferral-tracker; en iter 1 corren siempre. El revisor de cableado (WIRING, de su paquete) nunca se descuenta.
2. `pipeline.js advisors --repo <r> --story <s> --files <...>` → invocar EXACTAMENTE `all`, con el
   `context_file` que genera. Ventana deslizante de MÁXIMO 4 vivos (≤2 con el pase adversarial en vuelo; el
   paso manda sobre el `batch_rule`). Los triggers evalúan líneas AGREGADAS.
3. `pipeline.js check-count` al final: valida contra el `expected` persistido leyendo los spawns REALES
   del hook `on-advisor-run.js`. Falla cerrado sin spawns (`--trust-ran`: «autorizo trust-ran» de la persona).

Matriz de triggers: `computeAdvisorSet()` de `pipeline.js` (única fuente). Detalle: `steps/step-07-reviewers.md`.
- **Regla B**: antes del primer `Agent(...)` de «Revisores», anunciar el set (base + completitud +
  condicionales, skips con su razón mecánica), **los paquetes cargados** (`packs` de la salida;
  `packs: []` se dice explícito) y el total N. Sin anuncio → bug. Ningún advisor se omite
  "porque no parece necesario" (E.i).
- **Paquetes de revisores**: los revisores de un producto o de un cliente no viven en el
  código del pipeline sino en `packs/<nombre>/pack.json` (agent-skills, o `TYCON_PACKS_DIR`); los activa
  la organización (`packs.default`) y el repo puede achicar la lista con `packs:`. Un manifiesto roto, un agente
  inexistente o un paquete nombrado y no instalado FRENAN `advisors`/`smart-reloop`/`validators`
  (exit 2 con archivo · revisor · motivo): nunca se sigue «sin ese paquete». Los revisores de
  validación de «Validar la historia» salen de `pipeline.js validators`. Formato y detalle:
  `guides/agent-architecture.md` §«Paquetes de revisores».
- **Regla C**: al terminar CADA iteración, `check-count` y reportar N ejecutados vs expected. Si falta
  alguno → STOP y reportar.

## 🔴 SPAWN-1 — agentes ad-hoc (antes de los revisores)

La palanca de costo es abrir MENOS agentes (un spawn cuesta ~60-100K tokens antes de leer nada):
1. **Índice antes que agente**: con `.codegraph/`, *dónde está X / quién llama a Y / qué rompe Z* se
   contesta con `codegraph_*`. No se spawnea un agente de búsqueda en un repo indexado.
2. **Ningún agente arranca en cero**: recibe el material masticado (digest de la story, archivos, convenciones).
3. **Modelo por tarea**: buscar → `models.helpers` de `start` (o `haiku`); juzgar → el de la sesión.
4. **Tope por fase**: >5 agentes ad-hoc en una fase → parar y justificar (`on-advisor-run.js` avisa;
   `TYCON_ADHOC_SPAWN_WARN`, apagable con `TYCON_SPAWN_GOVERNANCE=0`).

## Reglas de diseño

- **COMM.i — checkpoints HITL**: resumen llano arriba (2-5 bullets sin rule IDs, `file:line` ni nombres
  de advisor) → UNA pregunta con la recomendación primero → detalle técnico abajo o diferido. Aplica a
  validar la story, aprobar el plan, «Hallazgos», dep-gate, spec-first y toda pausa HITL. En una decisión importante
  (bloque de estilo): el contexto y, por opción, lo que gana y lo que cuesta.
- **COMM.ii — cierre ejecutivo** (hallazgos, commit, cierre en ADO): qué quedó hecho en 3-6 bullets llanos (verificado
  corriendo, no leído; qué quedó pendiente), la acción del dev en UNA línea, el detalle diferido (vive en
  `.advisors/pipeline-runs/<run>/`). NUNCA volcar el informe consolidado al chat. El detalle
  sube solo si hay CRITICAL sin resolver, algo falló y el dev necesita el error crudo, o el dev lo pidió.
- **COMM.iii — pasos largos**: anunciar todo paso ≥30s y cuánto tarda (test-gate ~90s, advisor 3-7 min, pase
  adversarial 20-40 min); ≥2 min va en segundo plano salvo gates cortos de `run-check`; al volver, contestar
  PRIMERO lo que el dev escribió. **Todo `Agent(...)` del pipeline corre en segundo plano**; el pase,
  sin preguntar.
- **A.i**: siempre corren los advisors aplicables; no hay flag para saltear advisors individuales.
- **H.ii — pase adversarial** (`steps/step-08-adversarial-pass.md`): reproduce-or-refute que
  EJECUTA el código. Gate `pipeline.js deep-review-gate`: NORMAL → corre (de fondo, sin preguntar); LOW o
  liviana → skip. Apagarlo lo firma el dueño (`marker.js sign-adversarial-skip`). Overrides: `deep_review: always|auto`,
  `--deep-review`/`--ultracode`. Modelo `sonnet`; story pesada → `opus` (anunciado); **`fable` no se ofrece ni se
  pregunta**: sólo con `--deep-review-fable`, a pedido. UNA vez por corrida. Se lanza temprano al cerrar la implementación (`early_launch`; kill-switch `TYCON_5B_EARLY=0`)
  y su paso es el JOIN. Los CONFIRMED se foldean a «Hallazgos» y disparan D.i. La prueba que confirmó cada hallazgo
  se promueve a la suite: `marker.js promote-probe`; `mark-adversarial-result` exige `--tests k`
  (+ `--own p --in <rutas>`, `--deferred d --reason`), k+p+d=N. El pase se cierra con constancia
  (`mark-adversarial-result` / `mark-adversarial-skipped`), nunca a mano; `prepare-commit` frena si el
  pase se lanzó y falta su resultado.
- **B.ii**: «Hallazgos» SOLO pausa si hay CRITICAL; warnings-only auto-fluyen al commit listados en el
  reporte y en el commit. Waivers: `auto_waive` en `.tycon/advisors.yaml`; `warnings_pause: true` lo apaga.
- **C.i**: al validar la story, warnings de formato whitelisted (VAL-W1, VAL-W2, VAL-W9) auto-continúan anotados;
  cualquier otro WARNING pausa: (a) arreglar, (b) continuar, (c) cancelar.
- **D.i — re-loop post-fix (HARD)**: todo fix de código después de «Hallazgos» obliga a re-correr «Revisores»
  sobre el diff actualizado antes del commit, hasta que no haya fixes nuevos o los CRITICAL estén waived.
  - **D.i.1**: nada se recorta por inferencia; el único recorte válido es mecánico:
    `pipeline.js smart-reloop --iter N` (SPEED-1: delta por `marker.fileEvents` contra la
    `audited_surface` de cada advisor; anuncia `rerun` y `skipped` con razón). `--force-full-reloop`
    devuelve el set completo.
  - **Foto de la iteración**: la toma el arnés sola al lanzar el último revisor (aviso `📸`). No
    repetirla después de arreglar (`snapshot-iter` se niega o conserva). Sólo sin aviso, a mano ANTES de
    tocar código: `marker.js snapshot-iter <N>` (o `--date-at-last-reviewer`). Un `delta_files: []`
    en un re-loop = foto mal fechada; con `suspect_late_snapshot: true` el delta ya se recalculó.
  - **Model hints en re-loops (mandatory)**: pasar `model:` de `reviewer_models` (o `reloop_model_hints`) a
    cada `Agent()`, salvo que el delta toque specs (`first_round`, anunciarlo) o `--cost-tier deep`.
  - **D.i.2 — cerrá la CLASE**: un finding de clase (mismo hazard, varios sitios) se cierra en TODOS los
    sitios en un batch antes del re-loop; si el reporte trae un solo sitio, pedir el barrido.
  - **D.i.3 — gating**: re-loop por CRITICAL o WARNING dentro del diff de la story; un WARNING ínfimo FUERA
    del diff es follow-up documentado (engram `type: project` + nota en la spec), no re-loop.
  - **D.i.4 — tercera vuelta**: sin su nota (`marker.js rethink --iter N`) no hay set.
- **E.i — no-skip-by-inference (HARD)**: ningún paso se saltea por inferencia conversacional ("no lo
  mencionó", "arrancá rápido"). Sólo por la skip-condition documentada en el paso y
  verificable; si la condición tiene un gap, se arregla el paso, no se saltea.
- **F.i — DoD runtime gate (HARD)**: sin «Probar en vivo» (`steps/step-10-live-check.md`) no hay commit ni
  `pipelines.X.status: done`. Hooks de respaldo: `on-frontmatter-write.js` y `on-pre-commit.js`. Un run
  que cablea UI nueva exige probar en vivo aunque la story quede in-progress: smoke DRIVEN de la UI (Playwright contra
  la app real, cada AC de UI) — ver DODRT-C5. Nunca narrar "probado / DoD complete" antes
  del gate en verde; las guías marcan `✅ verificado-por-mí` vs `🔲 para-que-lo-pruebe-el-user` (ACCOV-C7).
  Para UI, `prepare-commit` exige `checks.dod` verde con provenance `run-check`
  (`run-check dod -- npx playwright test <spec> --workers=1`); `set-check dod --manual` está rechazado;
  `--force-manual` (en `set-check`) lo decide la persona. No-UI: `mark-dod-runtime-checked` con evidencia.
- **F.ii — matriz runtime por AC (DODRT-C6, HARD)**: `marker.js run-check acmatrix -- node
  <skill>/scripts/runtime-matrix.js --story <abs spec>`; `prepare-commit` la exige verde (run-check). Cada
  AC queda RUNTIME / CODE-ONLY / SIN-EVIDENCIA. `NOT-RUN` → lo corre el agente (E2E, o smoke vía
  `scripts/smoke-run.sh`, que es lo único que cuenta como evidencia); `NOT-VERIFIABLE` (declarado en
  `runtime_not_verifiable:` con `reason:` + `covered_by:`) → decide una persona; el agente nunca firma por su cuenta: `runtime-waiver` lo aprueba el dev: ventana,
  click, «aprobado» o `--terminal`; ni cita ni reenvío. Un CRITICAL, igual: `waive-critical`. Presentar CADA NOT-VERIFIABLE en el chat, en llano,
  con razón y test que lo cubre, y pedir decisión AC por AC — nunca sólo el comando o un link. El checkpoint
  de «Hallazgos» lleva el resumen: «Corrido de verdad: N de T. Sin correr (bloquean, los corro yo): [lista].
  Imposibles-declarados (esperan tu decisión): [lista]». Narrar «listo / probado» con la matriz roja es la violación. Un verbo de
  acción mal clasificado se declara EN el AC: `@runtime-exempt(DODRT-C8): <motivo>`.
- **F.iii**: `runtime-matrix` resuelve `storyPath` a absoluto; `marker.js set` preserva los campos no
  enumerados; la evidencia sale del repo de la story (+ `evidence.companion_repos` declarados en
  `.tycon/advisors.yaml`), nunca de hermanos por vecindad.
- **F.iv — ADVISORS-GATE**: a `done` no se llega sin constancia de advisors en este repo (run dir con
  reportes de «Revisores» o `check=advisors green` con el `repoPath`). Escapes del dev:
  `advisors_exempt: true` + `advisors_exempt_reason:`, o `TYCON_ADVISORS_GATE=off`.
- **G.i**: ningún plan se aprueba solo: una persona, o la coordinadora con el «aprobado» de la revisión que ella lanza
  (`plan-review`); uno delicado (`risk-class`), siempre el dev. Push y scope firmado: human-gate.
- **G.ii**: con `visual_plan: true` (o `--visual-plan`) y risk NORMAL, plan visual offline con
  `scripts/visual-plan.js render`. Default OFF.
- **H.i — sesión fresca**: el pipeline corre en sesión nueva o tras `/clear`; si la conversación ya lleva
  trabajo sustancial ajeno, recomendarlo ANTES del «Arranque» (el user decide; el estado vive en el marker).
- **TOOL.i**: tooling esperado y ausente se AVISA en 1 línea: binario presente → su CLI vía Bash para este
  run + cómo levantar el MCP; sin binario → acción de instalación y recién ahí degradar. Sin la tool
  `Workflow` → la salida aprobada. Lista: `pipeline.js tooling-expected`.
- **H.iii — model/effort hint**: `pipeline.js start --session-model <el de la sesión>` trae `model_hint`
  (LOW → sonnet · si no, opus; fable sólo si la organización lo pide) y el effort (tabla en PIPE-C8;
  `max` nunca automático). Si no matchea, sugerir `/model` en 1 línea;
  `session_check` avisa del techo. Advisory; nunca bloquea.
- **I.i — ATDD con gate mecánico**: los tests se escriben ANTES del código. `on-atdd-preedit.js` deniega
  el primer Edit/Write de código si no se tocó ningún test (story con tabla `### Tests`, marker activo,
  implementación abierta); `implement` bloquea si el primer test es posterior al primer código (evidencia:
  `marker.fileEvents` + `file-events/<sid>.jsonl`). Sin código → pasa; código sin tests → avisa. Escape
  único: `marker.js set-flag atddBypass true --reason "<por qué>"` (auditado). Fuera del pipeline, `on-pre-commit.js` avisa
  (`.tycon/atdd-gate` con `block` para frenar). La guía de QA se pide sólo si hay superficie operable a
  mano (`qa_guide: auto|off|always`). Un smoke corrido a mano no cuenta: va por `smoke-run.sh`.
- **I.ii — mutantes**: `run-tests` corre `scripts/mutation-check.js` sobre los archivos que la story
  declara; bloquea sólo si NINGÚN mutante murió; sobrevivientes → aviso. Escapes (persona):
  `TYCON_MUTATION_CHECK=off` / `--no-mutation`. Corre sólo `node --test`.
- **Modo autónomo Nivel 1 (default ON)**: el Stop-hook `on-stop-dod-gate.js` no deja cerrar el turno con
  un check registrado en rojo (cap 6 iteraciones, no-progreso → escala). Opt-out `--no-autonomous` /
  `TYCON_PIPELINE_NO_AUTONOMOUS=1`; pánico `touch ~/.claude/.tycon-pipeline/STOP_AUTONOMY`. Los checks se
  pueblan con `marker.js run-check <name> -- <cmd>`; `set-check` exige `--manual`. No automatiza aprobar
  CRITICAL, commit, push ni scope firmado.

## Referencia rápida (ids, comandos, flags, env)

- **Preflight** (`pipeline.js start`): PIPE-C0 conflicto cross-sesión · PIPE-C1 rama protegida · PIPE-C2
  .gitignore · PIPE-C4 marker · PIPE-C5 story → in-progress · PIPE-C6 modo autónomo · PIPE-C7 gap de E2E
  declarado · PIPE-C8 model/effort hint · PIPE-C9 tooling esperado.
- **DoD / QA**: DODRT-C1 smoke curl · DODRT-C5 UI con E2E diferido · DODRT-C5.1 `set-check dod --manual`
  rechazado en UI · DODRT-C6 matriz por AC · DODRT-C7 guía del tester: `node <skill>/scripts/qa-guide.js --story <abs spec> [--open]`
  genera la guía; `prepare-commit` corre `qa-guide.js --check` y bloquea si falta
  `<carpeta-story>/../qa/<sid>-pasos.md` (`## AC N`, pasos en criollo sin jerga, `Usuario por defecto:` o
  `Usuario:` por AC) o `<sid>-legibilidad.md` con `veredicto: OK` (review de un sub-agente "tester no técnico";
  anotar `pipeline.js qa-readability --story <s> --repo <r> --marks <n>`), o `<sid>-legibilidad-ui.md` (la misma
  pasada sobre los textos y capturas de la pantalla, `--ui-texts`; sus marcas se arreglan EN LA PANTALLA; `--scope ui`)
  · DODRT-C8 AC de acción ejecutado.
  Aprobaciones viejas de la matriz (del home al repo): `scripts/migrate-waivers-to-repo.js --repos <dirs> [--apply]` — `--apply` vuelve a firmar: lo corre el DEV en su terminal (pide `/dev/tty`); el agente, sólo el dry-run.
- **ATDD fuera del pipeline** (I.i.b · I.i.c + I.i.c.1 · I.i.d + I.i.d.1 · I.i.e): `on-pre-commit.js` avisa inversión test/código por eventos del repo
  (`TYCON_ATDD_COMMIT_GATE=block|off`); las stories se descubren por frontmatter (`lib/story-discovery.js`,
  `TYCON_STORY_SCAN_BUDGET_MS`; diagnóstico `node lib/story-discovery.js --doctor [--budget <ms>]`); aviso de guía de QA faltante o vieja; `lib/story-evidence-gate.js` avisa ACs
  sin correr. Portón preventivo: `TYCON_ATDD_PREEDIT_GATE=off`. Escape del gate del cierre: `complete-step implement --no-atdd`.
- **marker.js**: `get` · `set` · `start-step <paso>` · `complete-step <paso>` · `start-warning` · `run-check <n> -- <cmd>` ·
  `set-check <n> green --manual` · `set-flag <f> true` · `set-autonomous true` ·
  `snapshot-iter N` · `mark-adversarial-launched <runId> 4` · `mark-adversarial-result` ·
  `mark-adversarial-skipped --files …` · `promote-probe` · `mark-dod-runtime-checked '{evidencePath,verdict}'` ·
  `runtime-waiver <spec>` (TTY) · `adhoc set|get|clear|clear-orphan` · `adopt-session` · `list-all` · `find-by-story` ·
  `clear-session` · `update-story-status` · `update-pipeline-status` · `clear`.
- **pipeline.js**: `start` · `next` · `next-story` · `risk-class` · `model-hint` · `tooling-expected` ·
  `mech-check` · `advisors` · `validators` (validar la story; omite lo ya validado en verde) · `validation-record` · `smart-reloop` · `check-count` (lee spawns reales, CF-2) · `deep-review-gate` ·
  `dep-gate` · `e2e-config` · `evidence-dir` · `run-dir` · `followups-status` · `write-findings` (findings.json de «Hallazgos»,
  obligatorio: `prepare-commit` lo exige) · `write-followups` · `dod-checker-needed` · `qa-readability` ·
  `timing-report`.
- **Flags**: `--no-autonomous`/`--autonomous` · `--deep-review`/`--no-deep-review`/`--ultracode`/
  `--deep-review-fable` · `--cost-tier lean|deep` · `--visual-plan` · `--force-full-reloop` ·
  `--out-of-order` · `--relaunch` · `--no-atdd` · `--no-mutation` · `--max-mutants N` · `--evidence-dir` ·
  `--brief` (sólo `start`: lo que el orquestador consume + la RUTA del JSON entero).
- **Env**: `TYCON_PIPELINE_NO_AUTONOMOUS` · `STOP_AUTONOMY` · `TYCON_NO_DEEP_REVIEW` · `TYCON_5B_EARLY` ·
  `TYCON_PACKS_DIR` · `TYCON_AGENTS_DIR` (paquetes de revisores y carpeta de agentes) ·
  `TYCON_READ_METER` · `TYCON_READ_MAX_CHARS` ·
  `TYCON_STORY_GATE` · `TYCON_ADVISORS_GATE` · `TYCON_MUTATION_CHECK` ·
  `TYCON_ATDD_COMMIT_GATE` · `TYCON_ATDD_PREEDIT_GATE` · `TYCON_SPAWN_GOVERNANCE` · `TYCON_ADHOC_SPAWN_WARN` ·
  `DOD_BYPASS` (bypass logueado de gates del commit; NO abre la matriz runtime ni la guía de QA).

## Cuándo activarse

"implementemos la story X", "implementar historia X", "correr el pipeline TYCON para X", "apply tycon
pipeline". No con un "implementá X" suelto sin story/pipeline. Sin path: `pipeline.js next-story
[--specs-dir] [--repo]` devuelve la próxima `ready-for-dev` (orden numérico) o un menú; el user confirma
antes de arrancar.

Inputs: path a la story (.md) y repo (default cwd).

## Gate E2E del proyecto (`.tycon/advisors.yaml`)

```yaml
e2e:
  gate: scripts/e2e-gate.sh           # contrato: <frontend-dir> <story-id> <evidence-dir> [spec-filter...]
  frontend_dir: .                     # o frontend_dirs: [app1, app2] en monorepos
  critical_manifest: tests/e2e/critical-specs.txt
  required_env: [E2E_AUDIT_REQUIRED]   # llaves fail-loud por dominio (REAL-C8): el gate las prende
```
**La llave exigente** la prende el gate SIEMPRE, sin configurar nada: exporta `E2E_REQUIRED=1`
más lo que el repo declare en `e2e.required_env`. Un spec que se
saltea solo cuando el entorno no le da lo que necesita tiene que **lanzar** con esa llave prendida
(convención de `guides/definition-of-done.md` §2, regla `REAL-C8`), porque contar salteos no cierra
el hueco: el gate ya frena si se saltearon TODOS, pero 1 de 4 ejercidos sigue siendo verde. Mientras
un spec no la honre, el gate no frena por eso —nombra los salteos en la salida y en la evidencia
(`- llave_exigente:`), que es la deuda visible.
El script escribe `<story-id>-e2e-gate-<ts>.md` con `## Playwright Run`; exit 0 = PASS, 1 = FAIL,
**2 y 4 = `SIN_EJERCER`** (no ejerció nada: 2 el filtro no matcheó, 4 todos los tests se saltearon
solos — no son verdes), 3 = el stack no levantó. Resolver:
`pipeline.js e2e-config --repo <r> [--changed <archivos>]`.

`packs: [bizuit]` en el mismo archivo achica la lista que activa la organización
(`packs.default`); uno no activado frena. `pipeline.js lint-config` avisa
si nombra uno que no está instalado.

## Flujo

Arranque: `pipeline.js start --story <spec> --repo <dir> --brief [--no-autonomous]` (preflight PIPE-C0/C1/C2/C4/C5;
PAUSA sin mutar ante conflicto cross-sesión, rama protegida o pipeline abandonado). Entre pasos,
`pipeline.js next` da el próximo (`step_name`: su nombre llano) y su archivo: leer SOLO ése. El orden:

1 Arranque (`start`; opcionales: aviso de trabajo, pedido en ADO) · 2 Validar la historia (`validate-story`) ·
3 Armar el plan (`plan`, BMAD) · 4 Aprobar el plan (`approve-plan`) · 5 Implementar (`implement`: pruebas primero,
build-gate) · 6 Correr las pruebas (`run-tests`: `test-gate.sh <repo> <story_path>` —con la RUTA— suite completa una
vez: 0 verde · ≠0 rojo · 3 sin medir · 4 FRENO sin deducir el proyecto: `test-gate.sh <repo> <story> <subdir>` · 5 falta el
corredor · 6 salió 0 sin correr pruebas; después `pipeline.js dep-gate`) · 7 Revisores (`reviewers`; vuelta N si hubo
arreglos) · 8 Pase adversarial (`adversarial-pass`, join) · 9 Hallazgos (`findings`: `write-findings` + `write-followups`;
frena con CRITICAL) · 10 Probar en vivo (`live-check`) · 11 Preparar el commit (`prepare-commit`, NO commitea) ·
post-merge: `close-work-item`.

## Marker

Estado persistente por sesión en `~/.claude/.tycon-pipeline/active/<sessionId>.json` (`marker.js` saca el
`sessionId` de `CLAUDE_CODE_SESSION_ID`; los hooks, del evento). Un marker nuevo sin «Aprobar el plan» queda en
`bypass.log` como `MARKER_SKIPS_PLAN`.

- Cerrar pasos EN ORDEN y POR NOMBRE: `marker.js complete-step <nombre>` (un número se niega: es ambiguo);
  `approve-plan` con `--approved "<cita del user>"`. Freno de orden
  `lib/steps.js` ORDER_REQUIRES (`--out-of-order` queda logueado). `reviewers` exige `checks.advisors` verde por
  run-check de esta vuelta. Parte del Arranque que falla: `marker.js start-warning <time-tracking|ado> "<motivo>"`.
- `pipeline.js next` anota el arranque del paso: cerrar el anterior → `next` → trabajar.
- Checks: `marker.js run-check <name> -- <cmd>` (exit code real).
- Recovery: `marker.js adopt-session <sid-viejo>` · `list-all` · `find-by-story <id>` ·
  `clear-session <sid>` · `update-story-status <spec> <estado>`.
- Preparar el commit: arma el mensaje (NO commitea) y termina con `marker.js clear` + `marker.js update-story-status <spec> review` (las horas NO se cierran ahí).

Hooks: `on-prompt.js` (intención de story, conflicto cross-sesión, "listo" con pasos pendientes),
`on-edit.js` (registra ediciones), `on-write-collision.js`, `on-story-gate.js` + `on-bash-write-gate.js`
(portón de carril), `on-advisor-run.js`, `on-pre-commit.js`, `on-frontmatter-write.js`, `on-stop-dod-gate.js`.

## 🔒 Portón de carril

En un repo bajo el arnés, un archivo de CÓDIGO no se edita sin (a) pipeline activo o (b) carril ad-hoc
declarado: `marker.js adhoc set '{"reason":"<qué y por qué>"}'` (cupo 8 archivos, `adhoc.log`), que el dueño
aprueba en la ventana, con click o «aprobado» (firma `adhoc-lane`; o `--terminal`). La designada de la
máquina lo declara por otra pestaña con `--for-session <id>` si el perfil lo delega. Con marker y el plan sin
aprobar, no se edita código. Escrituras directas a
`~/.claude/.tycon-pipeline/` se deniegan siempre. El carril lo elige el USER: si no lo dijo, preguntar.
Kill-switches del dev: `TYCON_STORY_GATE=off` (apaga el portón de edición, no la firma),
`.tycon/advisors.yaml → pipeline.story_gate: false` (commiteado).

## Terminación y logging

Termina en: CRITICAL al validar la story sin override, BMAD no puede implementar, user cancela al aprobar el
plan o en «Hallazgos», build roto sin continuar, o el commit preparado. Lo que no se pudo, antes `close-as-debt` («Implementar»); después, `marker.js clear`.

Run dir `.advisors/pipeline-runs/<clave>-<sello>/` — lo da `pipeline.js run-dir --story <s> --repo <r> --create`,
nunca a mano (con número repetido la clave es `<tema>__<número>`): `step-01-start.md`, `step-01-validator.md`
(contrato: lo lee el validator), `step-02-bmad-plan.md`, `step-05-advisor-reports/` (contrato: evidencia de
DoD para `on-pre-commit.js`), `step-05b-adversarial.md`, `step-06-consolidated-report.md` + `findings.json`,
`step-07c-dod-gate.md`. Evidence dir `.advisors/dod-runtime/`: `<sid>-runtime-matrix.md`,
`<sid>-manual-test-plan.md`, `<sid>-e2e-gate-<ts>.md`. QA: `<carpeta-story>/../qa/<sid>-pasos.md` y
`<sid>-legibilidad.md`.

## Anti-patterns

Nunca `git commit`/`git push` sin aprobación explícita · no modifica skills BMAD · no saltea advisors a
pedido · no saltea checkpoints HITL que corresponden · no reemplaza el juicio del dev.

Post-pipeline: la retro del merge la escribe `retro-heartbeat.js` en `/tycon-merge-to-main`; los aprendizajes
van a engram al preparar el commit.
