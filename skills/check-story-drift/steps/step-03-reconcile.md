# Step 3 — Reconciliar Pass A + Pass B

## Objetivo

Combinar los resultados de Pass A (file attribution) y Pass B (scope verification) en una decisión por candidate. Cada candidate cae en una de 3 categorías.

## Matriz de decisión

| Pass A (archivos) | Pass B (scope) | Categoría | Acción siguiente |
|---|---|---|---|
| Archivos atribuidos a la candidate Y ≥80% files exist | Scope único IMPLEMENTED ≥80% | 🔴 **DRIFT CONFIRMADO** | Proponer transición review→done en Step 5 |
| Archivos existen pero atribuidos a OTRA story (shared infra) | Scope único NOT FOUND o PARTIAL | ✅ **SIN DRIFT (shared infra)** | No acción — scope único pendiente |
| Archivos NO existen | Scope único NOT FOUND | ✅ **SIN DRIFT (real ready-for-dev)** | No acción |
| Pass A y Pass B discrepan | Cualquier discrepancia | 🟡 **INCONCLUSIVO** | Verificación manual antes de actuar |

## Casos edge

### Caso 1: Archivos existen y atribuidos a la candidate, pero scope único parcial

```yaml
pass_a: 5/5 files exist, all attributed to "Story <N.M>"
pass_b: 3/5 behaviors implemented, 2 partial
```

→ Categoría: 🟡 **INCONCLUSIVO**. La implementación arrancó pero no está completa. Reportar como "implementación parcial — story debería pasar a `in-progress`, no a `done`".

### Caso 2: Pass A dice "files don't exist" pero Pass B encuentra el comportamiento implementado en otros archivos

```yaml
pass_a: 0/4 files exist (paths declarados en spec no coinciden con realidad)
pass_b: 4/4 behaviors implemented in DIFFERENT paths (probable refactor o rename post-spec)
```

→ Categoría: 🟡 **INCONCLUSIVO**. Investigar: el spec quedó desactualizado vs la estructura real del code. Recomendar actualizar el spec (Files section) Y cerrar a `done` si scope verificado.

### Caso 3: Pass A dice "files exist, attributed to candidate" pero Pass B dice "scope NOT FOUND"

```yaml
pass_a: 3/3 files exist, attributed to "Story <N.M>"
pass_b: 0/4 behaviors implemented
```

→ Categoría: 🟡 **INCONCLUSIVO**. Posible scaffold sin lógica. NO cerrar a done. Investigar manualmente.

### Caso 4: Story sin sección "Files to Create" (spec antigua)

Si Pass A no puede listar archivos por el formato del spec, basarse solo en Pass B + atribución por componentes principales (clase, hook, endpoint).

→ Categoría: igual matriz pero con confianza menor. Marcar como `low_confidence: true` en el reporte.

## Output

```yaml
categorization:
  drift_confirmed:
    - story_id: "1.11"
      confidence: high
      evidence: "5/5 files exist + 12/12 ACs implemented + 26 tests pass"
      attribution_commits:
        - <sha> (feat(audit): Story <N.M> — BitacoraLateral events list)
  inconclusive:
    - story_id: "3.1"
      reason: "ListadoEditor exists (shared infra from 2.2 Pipeline D) but P3 pending list + devolución scope NOT FOUND"
      recommended_action: "Manual review — possible partial implementation"
  no_drift:
    - story_id: "6.1"
      reason: "Files exist as shared infra of Story <otra N.M> — read-only view + masked customer + traceability search NOT IMPLEMENTED"
    - story_id: "10.4"
      reason: "AgregarArticuloButton.tsx exists (scaffold by Story <otra N.M> AC #9) — returns flow scope NOT IMPLEMENTED"
```

## Anti-patterns

- ❌ NO declarar DRIFT CONFIRMED si Pass A o Pass B tiene confianza media/baja.
- ❌ NO mezclar shared infra con drift real — siempre verificar attribution.
- ❌ NO actuar (Step 5) sin pasar por Step 4 (reporte al user primero).
