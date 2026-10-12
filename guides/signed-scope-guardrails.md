# Signed Scope Guardrails — Anti-regresión del firmado del cliente

> Mecanismo TYCON para garantizar que **lo firmado por el cliente es el piso de entrega**. Stories que cubren ACs firmados NO pueden moverse a otros sprints sin aprobación escrita.

## El problema que resolvemos

**Por qué:** un Change Request técnico **interno** puede mover a un sprint posterior una story que cubre un AC firmado, o crearla directamente en otro sprint, sin notificar al cliente ni obtener su aprobación escrita. Eso viola el proceso de cambio de alcance de la propuesta firmada. Y nada lo detecta: el error vive en el filesystem hasta que alguien compara a mano el plan contra la propuesta.

**Costo si no se detecta**: el cliente descubre en la demo del sprint que faltan compromisos firmados → posible reclamo contractual + pérdida de confianza.

## El sistema de guardrails (4 mecanismos)

### (1) Frontmatter `signed_for_sprint` + `signed_ac_ref` (single source of truth declarativo)

Cada story que cubre un AC firmado **DEBE** declarar en su frontmatter:

```yaml
---
epic: 2
story: "2.8"
title: "Recepción Solicitud urgente desde ERP (pedido category=VELOZ)"
status: ready-for-dev
sprint: 2                          # sprint actual asignado
signed_for_sprint: 2               # sprint firmado por cliente (cita textual abajo)
signed_ac_ref: "Sprint 2 entregable + AC §18 #15"  # cita exacta del PDF firmado
priority: "P0"
approach: "[CREATE]"
depends_on: ["2.5", "1.1"]
---
```

**Reglas**:
- `signed_for_sprint` **debe matchear** `sprint` salvo que exista `change_request_ref` apuntando a CR aprobado.
- `signed_ac_ref` debe citar verbatim el AC firmado (con número de sección/AC del PDF) — esto facilita el cross-check con la propuesta.
- Stories que NO cubren ACs firmados (ej: stories de test coverage fill-in, story splits internos como 2.5.1) **NO necesitan** estos campos. Si los tienen, deben estar vacíos o `signed_for_sprint: null`.

### (2) CR registry obligatorio (`specs/planning-artifacts/change-requests/`)

Cualquier shift de sprint que afecte una story con `signed_for_sprint != null` **requiere** un CR documentado:

```
specs/planning-artifacts/change-requests/
├── README.md                              # explica el formato
├── cr-template.md                         # template para nuevos CRs
├── cr-001-postponed-1-10.md               # ejemplos retroactivos
├── cr-002-eliminated-5-2.md
└── cr-003-ejemplo.md                      # un CR rechazado (el formato de abajo)
```

**Formato del CR** (`cr-NNN-slug.md`):

```yaml
---
cr_id: CR-003
date_proposed: 2026-05-07
date_decided: 2026-05-13
status: rejected  # one of: proposed | approved | rejected | superseded
affected_stories: ["2.8", "2.9"]
proposed_by: internal-team
decision_evidence: null  # email/firma/screenshot. null si rejected/superseded.
supersedes: null
superseded_by: null
---

## CR-003 — Postponer 2.8 + 2.9 de Sprint 2 a Sprint 3

### Propuesta original
Mover las dos stories afectadas (recepción de urgentes + Updates 200/409) de Sprint 2 a Sprint 3
alegando "Sprint 2 sobrecargado con 2.5 + 2.8 ambas de integración".

### Justificación técnica
[detalle de la sobrecarga estimada por Mary]

### Decisión cliente
**REJECTED** (2026-05-13) — la propuesta NUNCA fue presentada al cliente en su
momento. Detectada por comparación manual contra propuesta firmada (post-hoc).

### Acción ejecutada
2.8 + 2.9 retornadas a Sprint 2 firmado. Frontmatter actualizado con
`signed_for_sprint: 2`. Adversarial finding BL-S2-21 / BASE-R1 resuelto.
```

**Sin este archivo**: el validator bloquea el pipeline.

### (3) Validator `tycon-story-validator` — regla VAL-C7

Extiende el advisor `tycon-story-validator` con la siguiente regla:

> **VAL-C7** (CRITICAL): Signed scope mismatch — `sprint` actual difiere de `signed_for_sprint` sin `change_request_ref` apuntando a CR aprobado.

Tres caminos válidos para resolver VAL-C7:
1. Revertir `sprint` al `signed_for_sprint` (la story vuelve al sprint firmado).
2. Crear `change-requests/cr-NNN-*.md` con `status: approved` + `decision_evidence` (email/firma) Y agregar `change_request_ref: CR-NNN` al frontmatter.
3. Si la divergencia es legítima y no requiere CR (ej: story-internal split), agregar `signed_scope_notes: "razón"` al frontmatter — el validator acepta esto pero **emite WARNING** para auditabilidad.

**VAL-W8** (WARNING): Story cubre AC firmado pero no declara `signed_for_sprint` — backfill recomendado.

### (4) Audit periódico `tycon-signed-scope-audit`

Skill invocable que cross-checkea el plan actual vs propuesta firmada:

```bash
/tycon-signed-scope-audit [--proposal PATH] [--plan PATH]
```

- Default proposal: el PDF firmado de `specs/planning-artifacts/comercial/` (por ejemplo `propuesta-firmada.pdf`)
- Default plan: el plan de sprints publicado en `specs/demos/` (por ejemplo `plan-de-sprints.pdf`) + `specs/planning-artifacts/sprint-plan.md`
- Reporta divergencias en formato tabla: story | sprint planificado | sprint firmado | tipo (added | moved | removed) | tiene CR? | severidad

Recomendado correr:
- Antes de cada demo comercial (sanity check pre-demo)
- Post-cada cambio en sprint-plan.md (CI hook opcional)
- En el sprint kick-off mensual

## Anti-patterns (lo que NO permite el sistema)

- ❌ Mover stories firmadas a sprints posteriores SIN CR aprobado escrito.
- ❌ Crear stories NUEVAS que cubren ACs firmados y asignarlas a sprints distintos al firmado.
- ❌ Documentar un CR en sprint-plan.md como nota markdown sin entry formal en `change-requests/`.
- ❌ "Adversarial finding XYZ" detectado y luego ignorado — todos los findings de scope drift son CRITICAL y bloquean pipeline.
- ❌ Dejar `signed_for_sprint` vacío en stories de ACs firmados "para arreglarlo después".

## Casos válidos sin CR

- Story splits **internos** que no cambian scope cliente (ej: 2.5 → 2.5 + 2.5.1 followup tests). El followup hereda el `signed_for_sprint` del padre.
- Stories de test coverage / refactor que no estaban en V1 firmada — no necesitan `signed_for_sprint` (campo ausente está OK).
- Bug fixes de funcionalidad ya entregada (§16 propuesta: "Correcciones de bugs en funcionalidad ya entregada" no es cambio de alcance).
- Ajustes menores de configuración (§16 propuesta: textos, colores, orden de campos).

## Cómo aplicar a un proyecto existente

1. **Backfill frontmatter**: identificar todas las stories que cubren ACs firmados y agregar `signed_for_sprint` + `signed_ac_ref`. Priorizar las del sprint actual + próximos 2 sprints.
2. **Crear `change-requests/` folder** con README + template + entries retroactivas para todos los shifts históricos documentables.
3. **Activar VAL-C7 en pipeline** — corre automático en `tycon-pipeline` step 1.
4. **Correr audit inicial** — `/tycon-signed-scope-audit` para detectar divergencias retroactivas.
5. **Crear CRs retroactivos** para divergencias legítimas o revertir las no-legítimas.

## Referencias

- Catálogo advisor rules: `~/.claude/tycon-harness/guides/advisor-rules-catalog.md` (VAL-C7, VAL-W8).
- Story format: `~/.claude/tycon-harness/story-format.md` (sección frontmatter).
