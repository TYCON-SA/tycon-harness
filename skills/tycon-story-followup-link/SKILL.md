---
name: tycon-story-followup-link
description: Mantiene los back-links bidireccionales entre stories follow-up y sus padres. Se dispara desde el hook PostToolUse Write cuando se crea una story con `followup_of:` en el frontmatter — verifica que las padres tengan el `followed_up_by:` recíproco y propone al dev actualizar las que falten. Convención Mary+GOLD §1.2.
---

# tycon-story-followup-link

Skill auxiliar de la convención `followup_of:` / `followed_up_by:` de stories Mary+GOLD. Definida en `~/.claude/tycon-harness/story-format.md` §1.2.

## Qué hace

Cuando una story declara `followup_of: [<padre>]` en su frontmatter, esta skill cierra el loop bidireccional escribiendo el back-link `followed_up_by: [<hija>]` en cada padre.

Disparada automáticamente por el hook `scripts/on-story-create.js` (PostToolUse Write). El hook NO escribe los back-links — solo emite un system-reminder que instruye al agente a:

1. Leer el frontmatter actual de cada padre listada en `followup_of:`.
2. Mostrarle al dev las padres que van a actualizarse (output del hook ya las lista).
3. Editar el frontmatter de cada padre agregando el entry en `followed_up_by:` (con `id`, `date`, `type`, `summary` sincronizados).
4. Si la padre ya tiene `followed_up_by:` con otros entries → AGREGAR el entry nuevo, NO reemplazar el bloque.
5. Pedir confirmación al dev antes de escribir cada padre.

## Cuándo se dispara

PostToolUse Write sobre archivos `.md` que:
- Tengan frontmatter Mary+GOLD válido (`epic:`, `story:`, `status:`).
- Tengan campo `followup_of:` con al menos un entry.
- Tengan al menos una padre que NO tenga el back-link `followed_up_by:` recíproco.

Si todas las padres ya tienen el back-link → silent skip (no-op, idempotente).

## Cuándo NO se dispara

- Stories sin frontmatter (markdown libre).
- Stories Mary+GOLD sin `followup_of:` (no son follow-ups — son stories independientes o solo `depends_on:`).
- Archivos bajo `~/.claude/**` o del propio arnés (docs/templates, no stories reales).
- Edits posteriores al primer Write (PostToolUse matcher es Write, no Edit) — re-escrituras no re-disparan. Si se cambia el `followup_of:` después, correr `tycon-backfill-followups.js` a mano.

## Cómo convive con `tycon-ado-story-wi`

Ambos hooks corren en PostToolUse Write y son ortogonales:

| Hook | Trigger | Acción |
|---|---|---|
| `tycon-ado-story-wi/scripts/on-story-create.js` | story SIN `work_item:` | Crear el pedido de trabajo en la plataforma del equipo |
| `tycon-story-followup-link/scripts/on-story-create.js` | story CON `followup_of:` sin back-link recíproco | Actualizar `followed_up_by:` en la padre |

Una story nueva puede disparar AMBOS reminders al mismo tiempo (si es follow-up Y no tiene WI todavía). Cada uno se procesa por separado.

## Validación complementaria

El validator `tycon-story-validator` corre la regla **[VAL-W10]** que detecta drift bidireccional:
- Hija con `followup_of: [Y]` pero Y no tiene la hija en `followed_up_by:` → WARNING.
- Padre con `followed_up_by: [X]` pero X no tiene la padre en `followup_of:` → WARNING.

El hook previene el drift al crear; el validator lo atrapa retroactivamente.

## Back-fill masivo

Para sincronizar back-links en stories existentes (creadas antes de esta convención), correr el script `scripts/tools/tycon-backfill-followups.js` del arnés:

```bash
# Dry-run (default) — reporta qué falta sin escribir
node ~/.claude/tycon-harness/scripts/tools/tycon-backfill-followups.js --dir specs/stories

# Aplicar los back-links
node ~/.claude/tycon-harness/scripts/tools/tycon-backfill-followups.js --dir specs/stories --apply

# Ver la cascada completa de una story (padre + follow-ups + nietos)
node ~/.claude/tycon-harness/scripts/tools/tycon-backfill-followups.js --dir specs/stories --story <N.M> --render-table
```

## Histórico

- 2026-05-27: convención introducida porque el patrón de follow-ups que viven en otra épica tenía linking solo hacia adelante (`depends_on:`); abrir la story padre no revelaba qué se había cambiado. El single-source-of-truth de "qué entrega esta story HOY" requería el back-link explícito.
