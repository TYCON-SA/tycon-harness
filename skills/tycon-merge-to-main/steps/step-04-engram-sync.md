# Step 4 — Engram sync (condicional)

**Objetivo**: cumplir la regla global de CLAUDE.md (`engram sync --project <name>`) cuando aplica. NO siempre aplica — solo si el repo lo declara.

## Cuándo aplica

Solo correr el sync si:

1. **Hay un directorio `.engram/` en el repo** (señal de que el repo usa engram), O
2. **CLAUDE.md del repo menciona `engram` con un project name explícito**, O
3. **El nombre del repo está en la lista canónica** (`~/.claude/CLAUDE.md` global tiene la lista: TotoraProject, TotoraBackend, TotoraCustomForms, EbanoProject, EbanoBackend, EbanoFrontend).

Si nada de eso aplica → **skip silencioso** este step y pasar al Step 5.

## Acciones (si aplica)

### 4.1 — Detectar el project name canónico

Prioridad de detección:

1. Si `<repo_path>/CLAUDE.md` define explícitamente un project name (regex `proyecto = "([^"]+)"` o similar) → usar ese.
2. Si el dir name del repo coincide con uno de los canónicos → usar el canónico (ej: `Backend` → `TotoraBackend`).
3. Si no se puede determinar → preguntar al usuario:
   ```
   ¿Cuál es el project name engram para este repo?
   Lista canónica: TotoraProject, TotoraBackend, TotoraCustomForms, EbanoProject, EbanoBackend, EbanoFrontend.
   O escribí "skip" para saltar el sync.
   ```

### 4.2 — Ejecutar sync

```bash
engram sync --project <name>
```

Output esperado:
- "Nothing new to sync..." → no hay cambios, seguir.
- "Exported N memories..." → hay nuevos chunks. Stage + commit en source branch ANTES del merge:
  ```bash
  git add .engram/
  git commit -m "chore(engram): sync pre-merge to <target>"
  git push origin <source>
  ```

### 4.3 — Refresh local del source branch si hubo commit nuevo

Si el step 4.2 commit-pusheó algo en source branch, hace falta refrescar el listado de commits del Step 1 antes de mergear (ahora hay un commit más). El Step 5 va a hacer fetch igual, así que solo dejar registrado en el state.

## Edge cases

- **`engram` CLI no instalado**: warning al usuario ("`engram` no está en PATH; saltando sync") y seguir.
- **`engram sync` falla por error de auth/red**: warning, ofrecer skip o reintentar.
- **El sync genera commits pero no se puede pushear** (porque source branch tiene branch protection): ABORT con mensaje claro — esto es bug del setup, no del skill.

## Output del step

```json
{
  "engram_synced": true|false,
  "had_new_chunks": true|false,
  "commits_added_to_source": 0|1
}
```

Pasar al Step 5.
