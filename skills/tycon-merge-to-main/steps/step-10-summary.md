# Step 10 — Volver a source + summary final

**Objetivo**: dejar el repo en estado consistente (rama original) y dar al usuario un resumen accionable de lo que pasó.

## Acciones

### 10.1 — Volver a source branch

> **Modo worktree** (`merge_worktree: true` del Step 0): SALTEAR 10.1 y 10.2 — el working
> tree del dev nunca se movió y no hubo stash. NO borrar el worktree de merge (es
> persistente a propósito — amortiza `node_modules`/`bin`/`obj` entre merges).

```bash
git checkout <source>
```

Si el `current_branch_at_start` del Step 0 era distinto de `<source>` → volver a esa branch original:
```bash
git checkout <current_branch_at_start>
```

### 10.2 — Restaurar stash si hubo

Si Step 0 hizo `had_stash: true`:

```bash
git stash list | head -1
```

Si hay un stash con el message "pre-merge stash" → preguntar al usuario:
```
Tenés un stash de pre-merge:
<output del git stash list -1>

¿Restaurarlo ahora con `git stash pop`? (a) sí (b) no, lo manejo manual
```

Si elige (a) → ejecutar `git stash pop`. Si pop falla por conflict → avisar y dejarlo así (el usuario maneja).

### 10.3 — Generar summary final

Output al usuario:

```
✅ Merge completado

🌿 <source> → <target>

📦 Commit: <merge_commit_hash> (rama <target>)
   <subject_line>

🚀 Pushed: <remote_target_at> (origin/<target>)

📝 Cambios incluidos:
<lista de commits, mismo formato del Step 8>

✅ Build: OK
✅ Tests: <N>/<N> PASS, 0 regresiones

📁 Archivos cambiados: <N>

Volviste a `<current_branch_at_start>`.
```

Si hubo race retry en Step 9, agregar nota:
```
ℹ️ Hubo un race condition durante el push (alguien pushear al target mientras hacías HITL).
   Resuelto con rebase + retry. El merge commit final integra ambos lados.
```

Si hubo engram sync con commits nuevos:
```
ℹ️ Engram sync agregó <N> commits a `<source>` antes del merge (ver `chore(engram): sync pre-merge`).
```

### 10.4 — Sugerencias de siguiente paso (opcional)

Solo mencionar si aplica:

- Si el merge incluyó stories con ACs operacionales pendientes (ej: SQL UPDATE en BD post-deploy) — sugerir revisar la story y ejecutar esos pasos.
- Si el repo tiene CI configurado — recordar que el ZIP/build se está regenerando en CI ahora.
- NO sugerir "tareas que el usuario podría hacer" si no hay señal concreta.

## Output del step

```json
{
  "skill_completed": true,
  "final_branch": "<source>",
  "merge_commit_hash": "<sha>",
  "remote_target_at": "<sha>",
  "duration_seconds": <N>
}
```

Fin del skill.
