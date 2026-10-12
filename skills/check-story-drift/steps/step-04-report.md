# Step 4 — Emitir reporte estructurado

## Objetivo

Comunicar al user los resultados del sweep en formato estructurado y accionable, sin modificar archivos.

## Template del reporte

```markdown
## Drift sweep report — <proyecto> (<fecha>)

**Candidates scaneadas**: <N>
**Code repos**: <lista>
**Reglas aplicadas**: 4 (scope reading, shared infra distinction, --diff-filter=A, 2 passes independientes)

---

### 🔴 DRIFT CONFIRMADO (<n> stories)

Stories implementadas que no cerraron el spec. Candidatas a transición review→done.

| Story | Implementada en | Evidencia |
|---|---|---|
| X.Y (titulo) | commit <hash> (<fecha>) | <files> + <scope verified> + <tests> |
| ... | ... | ... |

**Próximos pasos** (Step 5): correr `tycon-ac-coverage-checker` + `tycon-deferral-tracker` sobre cada una, y si GREEN, proponer edits para cerrar.

---

### 🟡 INCONCLUSIVO (<n> stories)

Stories donde Pass A y Pass B discrepan o la evidencia es ambigua. Requieren verificación manual.

| Story | Pass A | Pass B | Hipótesis |
|---|---|---|---|
| X.Y | files exist | scope partial | implementación arrancó pero no completa — posible in-progress |
| ... | ... | ... | ... |

**Próximos pasos**: leer manualmente el spec + verificar implementación. NO actuar sin investigar.

---

### ✅ SIN DRIFT (<n> stories)

Stories realmente `ready-for-dev`. Los hits de grep iniciales (si hubo) fueron shared infrastructure de stories ya done.

| Story | Razón |
|---|---|
| X.Y | files exist como shared infra de Story Z.W (done). Scope único no implementado. |
| X.Z | files no existen. Realmente ready-for-dev. |
| ... | ... |

---

### Resumen ejecutivo

- **DRIFT confirmado**: <n> stories — cierre formal pendiente.
- **INCONCLUSIVO**: <n> stories — verificación manual.
- **SIN DRIFT**: <n> stories — sin acción.
- **Tiempo del sweep**: <duración>.
- **Confianza overall**: alta / media / baja (basada en cuántos casos tuvieron `low_confidence: true`).
```

## Reglas de formato

1. **Si <n>=0 en DRIFT CONFIRMADO**, omitir la sección entera con un mensaje claro: "No se detectaron drifts. Todas las candidates están correctamente en `ready-for-dev`."

2. **Si <n>=0 en INCONCLUSIVO Y <n>=0 en DRIFT CONFIRMADO**, terminar el skill aquí. No pasar a Step 5.

3. **Si <n>>0 en DRIFT CONFIRMADO**, mostrar el reporte y pasar a Step 5 con HITL.

4. **Auto-emitir engram memory** al final del Step 4 si el sweep encontró ≥1 drift:
   ```
   mem_save(project=<proyecto>, type=discovery, title="Drift sweep <fecha> — <n> stories confirmadas")
   ```
   Esto deja audit trail futuro: "el último sweep fue en X fecha y encontró Y drifts".

## Output

El reporte se imprime directamente al user (no se persiste a archivo salvo pedido explícito).

## Anti-patterns

- ❌ NO mezclar las 3 categorías en una sola lista — la separación visual importa para que el user vea de un vistazo qué necesita acción.
- ❌ NO ocultar INCONCLUSIVO debajo de DRIFT CONFIRMADO — ambos requieren atención distinta.
- ❌ NO terminar el skill sin emitir reporte (aunque sea "0 drift detectado").
