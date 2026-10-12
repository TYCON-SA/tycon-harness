# Step 5 — Checkout target + pull `--ff-only`

**Objetivo**: dejar la branch `<target>` local al día con `origin/<target>` antes del merge. Si el target divergió, parar — el skill no resuelve eso solo.

## Acciones

### 5.1 — Checkout target

```bash
git checkout <target>
```

Si falla (ej: working tree dirty post-Step 0) → ABORT, debería ser imposible si Step 0 anduvo bien. Si pasa, instruir al usuario a investigar.

> **Modo worktree** (`merge_worktree: true` del Step 0): todo este step corre DENTRO del
> worktree de merge (`repo_path` ya rebindeado) — el 5.1 es un no-op (el worktree ya está en
> `<target>`), el 5.2/5.3 corren igual. El working tree del dev no se toca.

### 5.2 — Pull fast-forward only

```bash
git fetch origin <target>
git pull origin <target> --ff-only
```

**Si la pull falla** con `non-fast-forward` o similar → significa que `<target>` local divergió de `origin/<target>` (alguien hizo commits locales en target, o un rebase, etc.). 🚫 ABORT con mensaje:

```
❌ El target local `<target>` divergió de `origin/<target>` y no se puede fast-forward.

Causas comunes:
- Hiciste commits locales en `<target>` que no están en remote.
- Alguien hizo force-push a `origin/<target>`.

Para resolver:
- Si tus commits locales son nuevos y los querés conservar: `git push origin <target>` primero (asumiendo que sos el único que escribe ahí).
- Si querés descartar tus commits locales y alinear con remote: `git reset --hard origin/<target>` (DESTRUCTIVO, perdés cambios locales).

Después re-corré el merge.
```

NO ofrecer hacerlo automáticamente. Es decisión del usuario.

### 5.3 — Verificar que origin/<source> tiene los commits del Step 1

```bash
git log origin/<target>..origin/<source> --oneline | wc -l
```

El número debería coincidir con el conteo del Step 1 (o ser +1 si Step 4 hizo engram commit). Si no coincide → algo cambió en el remote durante el flow → re-fetchear y revalidar.

> **Nota**: comparar contra `origin/<target>` (no `<target>` local) — consistente con Step 1.1.

Si el conteo bajó a 0 → "alguien mergeó mientras vos hacías el HITL" → exit limpio:
```
✅ El target ya tiene todos los commits del source. Otro proceso/dev mergeó mientras esperabas. No hay nada que hacer.
```

## Output del step

```json
{
  "target_checked_out": true,
  "target_at": "<sha>",
  "commits_to_merge_count": <N>
}
```

Pasar al Step 6.
