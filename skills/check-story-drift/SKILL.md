---
name: check-story-drift
description: Detecta drift entre el frontmatter `status:` de stories Mary+GOLD y la implementación real en filesystem. Usar cuando el user pide "revisar estado de sprints", "stories implementadas sin cerrar", "drift sweep", "sweep de stories ready-for-dev", "cuáles stories están hechas pero el spec dice ready-for-dev". Implementa 4 reglas core para evitar falsos positivos por shared infrastructure (un sweep que confía en "files exist" da por hecha una story cuyos archivos creó otra).
---

# check-story-drift

Skill team-wide TYCON para detectar drift `status` ↔ filesystem en proyectos con specs Mary+GOLD. Pensado para invocarse antes de planear sprints, antes de demos, o cuando se sospecha que hay implementaciones sin cerrar el spec.

## Cuándo activarse

Invocar cuando el user dice (es/en):

- "revisar estado de sprints"
- "drift sweep" / "sweep de drift"
- "stories implementadas sin cerrar"
- "sweep stories ready-for-dev"
- "cuáles stories están done pero el spec dice ready-for-dev"
- "/check-story-drift"
- "drift check"
- "check story drift"

**NO invocar automáticamente** si el user solo pregunta "¿cómo están los sprints?" sin mencionar drift/implementación silenciosa — en ese caso, basta con leer `specs/planning-artifacts/sprint-status.yaml` + frontmatter de cada story.

## Inputs

| Input | Default | Notas |
|---|---|---|
| `specs_dir` | `specs/stories/` | path relativo al cwd que contiene los `.md` Mary+GOLD |
| `code_repos` | autodetect | Mac/Linux: hermanos del cwd actual con `.git/`. Default: scan parent dir |
| `filter` | `ready-for-dev*` | regex del frontmatter `status:` que define candidatas. Default cubre `ready-for-dev` y `ready-for-dev-FINAL` |
| `target_stories` | empty | lista explícita de story IDs para chequear (ej: `2.4, 6.1, 9.1`). Si está vacío → scan all candidates |

## Las 4 reglas core (decisión de diseño)

El skill se diferencia de un `grep` simple porque aplica estas 4 reglas que evitan los falsos positivos del approach naive:

1. **Leer el SCOPE del spec**, no solo "Files to Create". El spec describe el comportamiento único de esa story. Archivos a crear pueden ser shared infrastructure que otra story construyó antes — la existencia del archivo NO implica `done` para esa story.

2. **Distinguir shared infrastructure vs scope único**. Cuando dos stories comparten archivos, el orden de implementación importa. Si una story `done` creó los archivos antes, la otra story sigue con scope único pendiente.

3. **Cross-check con `git log --diff-filter=A`**. `git log --grep "Story X.Y"` es ruidoso (matches cruzados de commits que mencionan la story por referencia). El comando definitivo: `git log --all --oneline --diff-filter=A -- <ruta>` apunta al commit que CREÓ el archivo. Permite atribuir el archivo a la story dueña real.

4. **Dos pasadas independientes mínimo**. Un solo agent run puede fallar (por ejemplo, reportar que un archivo no existe cuando sí está). Validar con un segundo agent con prompt distinto o verificación manual antes de actuar.

## Output esperado

Reporte estructurado con 3 categorías:

```
## Drift sweep report — <proyecto>

### 🔴 DRIFT CONFIRMADO (N stories)
- Story X.Y (titulo) — implementada en commit <hash>, evidencia: <archivos clave + scope verificado>
- ...

### 🟡 INCONCLUSIVO (N stories)
- Story X.Y — archivos existen pero scope único NO verificado. Requiere read manual del spec + cross-check con commits.
- ...

### ✅ SIN DRIFT (N stories)
- Story X.Y — archivos existen como shared infra de Story Z.W (done). Scope único de X.Y NO implementado.
- Story X.Z — archivos no existen. Realmente `ready-for-dev`.
- ...
```

Para cada DRIFT CONFIRMADO, el skill propone los próximos pasos al user (cambiar frontmatter + Change Log + sprint-status.yaml) **pero NO modifica archivos sin aprobación**.

## Flujo (5 steps)

Seguí EN ORDEN los 5 steps definidos en `steps/`:

0. **step-01-start.md** — Verificar specs_dir existe + tiene archivos `.md` con frontmatter `status:`. ABORT si no.
1. **step-01-filter-candidates.md** — Listar stories cuyo `status:` matchea `ready-for-dev*`. Si `target_stories` vino explícito, intersectar.
2. **step-02-two-pass-analysis.md** — Para cada candidata, lanzar **DOS agents en paralelo** (no secuencial) con prompts distintos:
   - **Pass A — file-existence + shared infra check** — Explore agent que verifica archivos declarados + `git log --diff-filter=A` para attribution
   - **Pass B — scope verification** — Explore agent que lee el SCOPE de la spec y verifica si el comportamiento único está implementado (no solo si los archivos existen)
3. **step-03-reconcile.md** — Comparar resultados de Pass A y Pass B. Para cada candidata, asignar categoría:
   - DRIFT CONFIRMADO: ambos passes coinciden en "done"
   - INCONCLUSIVO: passes discrepan o evidencia ambigua — requiere verificación manual
   - SIN DRIFT: alguno de los passes confirma que scope único NO está hecho
4. **step-04-report.md** — Emitir reporte estructurado. NO modificar archivos.
5. **step-05-hitl-action.md** — Si hay DRIFT CONFIRMADO, PAUSA con HITL ofreciendo al user: (a) cerrar todas las DRIFT CONFIRMADO con `tycon-ac-coverage-checker` + `tycon-deferral-tracker` antes de transición a `done`, (b) revisar manualmente las INCONCLUSIVO, (c) salir sin acción.

## Anti-patterns (lo que NO hace)

- ❌ NO usa solo `git log --grep "Story X.Y"` (matches cruzados ruidosos).
- ❌ NO declara DRIFT por "files exist" sin verificar scope.
- ❌ NO actúa (modifica frontmatter, sprint-status.yaml) sin segunda pasada Y aprobación HITL.
- ❌ NO confía en un solo agent run — siempre 2 passes independientes.
- ❌ NO reabre stories `done` sin confirmar que el cambio de status tiene sentido.

## Terminación del skill

- Step 0: specs_dir vacío o sin frontmatter → ABORT temprano.
- Step 4: reporte emitido. Si 0 DRIFT CONFIRMADO → termina exitosamente sin pasar al Step 5.
- Step 5: user cancela el HITL → termina dejando el reporte como audit trail.
- Step 5: user aprueba cerrar drift → invoca `tycon-ac-coverage-checker` + `tycon-deferral-tracker` sobre cada DRIFT CONFIRMADO (mismo flow que `tycon-pipeline` Step 5). Si GREEN, propone los edits y termina dejando que el user los apruebe.

## Referencias

- Engram pattern: `pattern/drift-sweep-methodology` (en engram: el proyecto ceiboproject y el del arnés).
- Skills relacionadas: `tycon-pipeline` (post-implementación), `tycon-merge-to-main` (post-cierre).
- Guías relacionadas: `~/.claude/tycon-harness/story-format.md` (Mary+GOLD frontmatter), `guides/definition-of-done.md` (gates pre-done).
