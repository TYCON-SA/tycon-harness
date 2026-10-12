# Step 6 — Merge `--no-ff` con el mensaje aprobado

**Objetivo**: ejecutar el merge real. Si hay conflict, parar — no resolver automáticamente.

## Acciones

### 6.1 — Ejecutar merge

Usar el mensaje aprobado en Step 3 (`approved_message`). Vía HEREDOC para preservar formato:

```bash
git merge --no-ff origin/<source> -m "$(cat <<'EOF'
<approved_message del Step 3>
EOF
)"
```

**Importante**: usar `--no-ff` siempre, aunque el merge podría ser fast-forward. La intención del skill es preservar la historia del merge — un commit explícito que muestre dónde se sincronizó dev a main.

### 6.2 — Detectar conflicts

Si `git merge` retorna no-zero y el output contiene `CONFLICT`:

🚫 ABORT con mensaje:

```
❌ Merge tiene conflicts. Archivos en conflicto:

<output de git status --porcelain | grep "^UU\|^AA\|^DD">

El merge quedó parcialmente aplicado. Opciones:

(a) Abortar el merge (vuelve al estado pre-merge):
    git merge --abort

(b) Resolver conflicts manualmente:
    1. Editá cada archivo, buscá los markers <<<<<<<, =======, >>>>>>>
    2. git add <archivos resueltos>
    3. git merge --continue
    4. Ejecutá el build+tests (Step 7) manualmente
    5. Volvé a invocar el skill desde el Step 8 (push approval) — actualmente no hay forma automática, abrí un issue si lo necesitás.

NO voy a resolver conflicts automáticamente. Re-corré el skill después de resolver.
```

NO ofrecer ejecutar `git merge --abort` automáticamente — es decisión del usuario.

### 6.3 — Verificar el merge commit

Si no hubo conflict:

```bash
git log -1 --pretty=format:"%h %s"
```

Verificar que:
- El subject empieza con `merge:` (sanity check).
- El hash es nuevo (distinto de `target_at` del Step 5).

Capturar el `merge_commit_hash`.

## Edge cases

- **Conflict en archivos que no aparecían en el preview del Step 1**: puede pasar si dos commits que parecían no chocar generan conflict por contexto adyacente. El mensaje de ABORT cubre esto.

- **Pre-commit hooks fallan**: si el repo tiene hooks que bloquean el merge commit (ej: signing hooks), el merge falla. Reportar el output del hook al usuario y ABORT — no usar `--no-verify` para saltarlos (ver guía git-commit-conventions).

## Output del step

```json
{
  "merge_commit_hash": "<sha>",
  "merge_succeeded": true,
  "files_changed": <N>
}
```

Pasar al Step 7.
