# Step 5 — HITL action (solo si hay DRIFT CONFIRMADO)

## Objetivo

Si el Step 4 detectó ≥1 DRIFT CONFIRMADO, ofrecer al user 3 opciones de acción mediante HITL. NUNCA modificar archivos sin aprobación.

## Trigger

Solo entrar a este step si `categorization.drift_confirmed.length > 0`. Si no, el skill terminó en Step 4.

## HITL prompt

```
He detectado <N> stories con DRIFT CONFIRMADO. ¿Cómo procedo?

(a) Cerrar todas las DRIFT CONFIRMADO — para cada una, correr en paralelo
    tycon-ac-coverage-checker + tycon-deferral-tracker (los 2 DoD gates) y, si
    GREEN, proponer edits (frontmatter status:done, Status line, Change Log,
    sprint-status.yaml). Aprobás los edits antes de aplicar.

(b) Revisar manualmente — me das una lista de las que querés cerrar (subset)
    y arranco solo con esas con el mismo flow (gates + propuesta).

(c) Solo dejar el reporte como audit trail — sin acciones. Cerrás manualmente
    después.
```

## Si user elige (a) — cerrar todas

Para cada story en `drift_confirmed`:

1. **Lanzar los 2 advisors DoD en paralelo**:
   - `tycon-ac-coverage-checker` con el path del spec
   - `tycon-deferral-tracker` con el path del spec

2. **Si ambos GREEN** (0 CRITICAL):
   - Proponer edits:
     - `<specs_dir>/<file>`: frontmatter `status: done` + Status line + sección Change Log con entry "DoD gates GREEN + drift closure"
     - `<specs_dir>/../planning-artifacts/sprint-status.yaml`: actualizar entry de la story a `done`
   - Pedir aprobación user antes de aplicar.

3. **Si alguno CRITICAL**:
   - NO cerrar esa story. Reportar al user: "Story X.Y tiene findings CRITICAL en advisors — no se puede cerrar a done sin resolver. ¿Querés que profundice o saltamos?"

4. **Reporte final**:
   ```
   ## Drift closure summary
   - Cerradas: <n> stories (review→done)
   - Bloqueadas por CRITICAL: <m> stories
   - Saltadas: <k> stories
   ```

## Si user elige (b) — subset

Mismo flow que (a) pero solo con las stories que el user listó. El resto queda en el reporte como audit trail.

## Si user elige (c) — solo audit

Skill termina sin tocar archivos. Engram memory ya quedó guardada en Step 4 con el resumen.

## Reglas críticas

1. **NUNCA modificar archivos sin HITL aprobación** — ni siquiera si los 2 gates están GREEN. El user es el que decide cerrar.

2. **NUNCA cerrar una story `done` ya existente** — el sweep solo opera sobre `ready-for-dev*`. Si por error una candidate aparece como `done`, abortar con warning.

3. **Engram sync antes de commit** si el user pide que se commitee post-cierre — seguir las reglas del proyecto (regla #0 del global CLAUDE.md: NO commitea sin autorización).

4. **Si el sweep está corriendo dentro de tycon-pipeline (composition)** — los edits se proponen pero el commit lo maneja el pipeline padre, no este skill.

## Output

```yaml
hitl_outcome:
  option_chosen: "a"  # o "b" o "c"
  stories_closed:
    - "1.11"  # ejemplo
  stories_blocked_by_critical: []
  stories_skipped: []
  files_modified:
    - "specs/stories/1-11-...md"
    - "specs/planning-artifacts/sprint-status.yaml"
```

## Anti-patterns

- ❌ NO saltear el HITL (auto-aplicar edits) aunque parezcan "obvios".
- ❌ NO mezclar `done` ya existentes con candidates del sweep.
- ❌ NO ejecutar commit/push desde este skill — eso es decisión del user post-edits.
