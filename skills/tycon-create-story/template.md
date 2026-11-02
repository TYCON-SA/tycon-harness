---
epic: {{epic_num}}
story: "{{epic_num}}.{{story_num}}"
title: "{{story_title}}"
status: ready-for-dev
sprint: {{sprint}}
priority: "{{priority}}"
approach: "{{approach}}"
depends_on: []
files_to_create: []
files_to_modify: []
---

<!--
  Formato Mary+GOLD (TYCON). Fuente de verdad: story-format.md del arnés
  (${TYCON_GUIDES_DIR:-~/.claude/tycon-harness}/story-format.md). Esta plantilla trae
  la estructura; las reglas de cada sección están en esa guía y hay que leerla antes de llenar.

  Frontmatter (story-format.md §1, §1.0, §1.3):
  - priority: P0 bloqueante · P1 must · P2 should · P3 nice.
  - approach: [EXTRACT] copiar de una fuente · [ADAPT] adaptar un patrón resuelto · [CREATE] nuevo.
  - status: vocabulario cerrado en scripts/metrics/states.json.
  - files_to_create / files_to_modify: rutas relativas al repo; iguales a la tabla de Dev Notes.
  - work_item (antes ado_work_item): NO se escribe a mano; lo agrega tycon-story-work-item al crear la story.
  - Si la story corrige, recalibra o extiende otra: agregar followup_of y followup_reason (§1.2).
  - Si se entrega en tandas: bloque pipelines (§1.1). Dos tandas sobre los mismos archivos que no sirven solas van en
    una sola; si sirven solas, cada una dice qué entrega en `delivers`.
  - Nunca comillas dobles dentro de un comentario ni en el valor de title: la story se vuelve
    invisible para el arnés sin dar error (§1.0). Usar comillas simples.
  Borrar este comentario al terminar.
-->

# Story {{epic_num}}.{{story_num}}: {{story_title}}

Status: ready-for-dev

## Story

Como {{role}},
quiero {{action}},
para {{benefit}}.

## Acceptance Criteria

### {{grupo_principal}}

1. **Given** <estado inicial> **When** <acción> **Then** <resultado observable y concreto>

### Modos de falla

2. **Given** <lo que falta, falla, está vacío o no tiene permiso> **When** <acción> **Then** <resultado concreto>

### No-regresión

3. <lo que NO debe romperse>

### Tests ({N} verificaciones)

| # | Test | AC | Nivel | Escenario | Resultado esperado |
|---|------|----|-------|-----------|--------------------|
| T1 | `NombreDelTest_Escenario` | 1 | unit | Condiciones de entrada | Resultado concreto (código HTTP, evento, estado final) |
| E1 | `E2E_Feature_Escenario` | 1 | e2e | `tests/e2e/story-{{epic_num}}-{{story_num}}-desc.spec.ts::nombreFuncion` — descripción breve | Componente visible, data-testid presente |

> Todo AC aparece en al menos una fila. Filas `T*` = unit/integration; filas `E*` = E2E Playwright,
> obligatorio si la story toca una pantalla según la regla `screen_test` de la organización (story-format.md §6.1).
> El nombre de cada test sigue la regla `test_names` (`pipeline.js org-rules`). Cada test lleva en el código su tag
> de story y AC (`[Trait("Story", "N.M")]` + `[Trait("AC", "1")]`, `@story-N.M @ac-1`, o `@pytest.mark.story`).

## Tasks / Subtasks

- [ ] [SEQ] Task 1: Salvaguarda de BD / de estado — verificar que las asunciones de la story coinciden con el código y la BD (AC: todos)
- [ ] [SEQ] Task 2: <tarea concreta> (AC: #)
  - [ ] Subtask 2.1
- [ ] [PAR] Task 3: <tarea paralelizable> (AC: #)

### Task Dependencies

T1 → T2 (secuencial) · T3 en paralelo con T2

## Dev Notes

### Que existe hoy

#### En <sistema fuente> (source of truth)

- **Archivo:** `ruta/real/al/archivo` — qué hace; métodos clave con su archivo y miembro, y snippet de código REAL.

#### En <este proyecto> (lo que ya tenemos)

- **Archivo:** `ruta/real` — `Miembro` (~línea)
- **No existe:** <lo que hay que crear>

### Patron de referencia verificado

<!-- OBLIGATORIA en toda story de backend, sea cual sea el approach (story-format.md §9.2).
     (A) tabla con proyecto hermano | ancla archivo:línea o comando grep | qué se verificó, más el conteo;
     o (B) No aplica + la búsqueda que se hizo. Sin anclas abiertas de verdad no vale. -->

### Que hay que hacer (la delta)

1. <qué se crea o adapta, y en qué difiere de la fuente>

### Archivos a crear/modificar

| Accion | Archivo |
|--------|---------|
| Crear | `ruta/nueva` |
| Modificar | `ruta/existente` (qué cambia) |

### Lo que NO hay que hacer

- **NO <anti-patrón>** — por qué.

### Como verificar que funciona

```bash
# comandos copy-paste ejecutables, con el resultado esperado
```

### Salvaguarda de BD (cuando aplica)

1. `SELECT ...` — verificar que X existe
2. Si cualquier asunción no coincide → DETENERSE → corregir la story primero

### References

- Citar la fuente de cada detalle técnico, ej. [Source: docs/<file>.md#Section]

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
