# Step 0 — Preflight checks

**Objetivo**: validar que el repo está en condiciones para mergear. Si algo no está bien, parar antes de tocar nada.

## Acciones

### 0.1 — Es un repo git
```bash
git rev-parse --show-toplevel
```
Si falla → ABORT: "El cwd no es un repo git. Especificá `repo_path` o ejecutá desde dentro del repo."

### 0.2 — Source y target branches existen
```bash
git rev-parse --verify <source>
git rev-parse --verify <target>
```
Si alguna falla → ABORT con instrucción de crear/checkear la branch.

### 0.3 — Working tree limpio
```bash
git status --porcelain
```
Si retorna líneas → PAUSAR y preguntar:

```
Working tree tiene cambios sin commitear:
{output del git status}

Opciones:
(a) Stashear los cambios y seguir (`git stash push -m "pre-merge stash"`)
(b) Cancelar el merge — commiteá vos primero
(c) Correr el merge desde el worktree persistente de merge (`<parent>/<Repo>--merge`) —
    tu working tree queda como está, sin stash ni checkout
```

Si elige (a) → ejecutar stash y registrar `had_stash: true` para que Step 10 ofrezca `git stash pop` al final.
Si elige (b) → ABORT.
Si elige (c) → **modo worktree** (convención: `~/.claude/tycon-harness/guides/git-worktrees.md` §4):

1. Crear/reusar el worktree: `bash ~/.claude/tycon-harness/scripts/tools/tycon-worktree.sh merge-tree <target>`
   (o crudo: `git worktree add ../<Repo>--merge <target>`). Es **persistente a propósito** —
   conserva `node_modules`/`bin`/`obj` entre merges; no borrarlo al terminar.
2. **Rebindear `repo_path` al path del worktree para TODOS los steps siguientes** y registrar
   `merge_worktree: true` en el output de este step. Consecuencias:
   - Step 0.5 no aplica (el worktree ya está en `<target>`; la branch del working tree del dev
     es irrelevante — no se toca).
   - Step 5 (`checkout <target> + pull`) corre dentro del worktree — checkout es no-op.
   - Step 7 (build+tests) corre dentro del worktree: la PRIMERA vez paga `npm install` /
     `dotnet restore` completos; las siguientes son incrementales.
   - Step 10 **saltea** el `git checkout <source>` de vuelta (el working tree del dev nunca se
     movió) y `had_stash` no aplica.
3. Restricción git: si el working tree principal YA está en `<target>`, una branch no puede
   estar checkeada en dos worktrees → este modo no sirve, usar (a)/(b). El script lo detecta
   y falla con ese mensaje.
4. Secrets no trackeados (`.env`, certs) NO viajan al worktree — si el gate 7b/E2E los
   necesita, copiarlos antes de correrlo.

El modo worktree también puede pedirse con el working tree LIMPIO (env `TYCON_MERGE_WORKTREE=1`
o pedido explícito del dev) — mismo procedimiento, sin pregunta previa.

### 0.4 — Fetch refs remotos
```bash
git fetch origin <source> <target>
```
Si falla por red → ABORT con instrucción de revisar conectividad/auth. NO seguir con info desactualizada.

### 0.5 — Verificar que estamos en source branch (recomendado)

```bash
git rev-parse --abbrev-ref HEAD
```

Si NO estamos en `<source>` → preguntar:
```
Estás en branch `{current}`, no en `{source}`.

¿Procedemos con `{source} → {target}` igual? (a) sí (b) cambiar a `{source}` primero (c) cancelar
```

Esto evita el caso "querías mergear feature/X pero estás en dev y no te diste cuenta".

### 0.6 — Trabajo sin subir en el grupo de repos

**Por qué existe**: una entrega multi-repo se puede promover a medias — el frontend llega a main
llamando endpoints de un backend cuyo commit existe SOLO en la máquina del dev (el push nunca
se ejecutó). Cada repo, mirado solo, da verde. Este paso mira el conjunto.

Correr DESPUÉS del fetch del 0.4 (los refs remotos frescos son el insumo). En modo worktree
(0.3c), pasar el path del repo PRINCIPAL, no el del worktree:

```bash
node ~/.claude/tycon-harness/scripts/hooks/unpushed-work-notice.js --scan <repo> --json
```

(Override del clon de guides: `TYCON_GUIDES_DIR`. El comando ignora `TYCON_UNPUSHED_NOTICE=0`
a propósito — apagar el aviso ambiental no apaga este control.)

Interpretación del JSON:
- **`scanned: true` + algún repo con `branches` no vacío** → hay trabajo local sin subir en el
  grupo. NO abortar acá: registrar `unpushed_findings` en el output del step. El **Step 3
  (HITL #1) DEBE mostrar la tabla** con marca 🔴 antes de pedir la aprobación — repo, rama,
  cuántos commits, y si es `(wip)`. La decisión es del dev, pero es imposible aprobar sin verlo.
- **Repos con `error` (timeout/git)** → mostrarlos como "⚠ no escaneado" en el HITL #1.
  "No corrió" NUNCA se presenta como verde.
- **`discarded` no vacío** → mencionar en 1 línea qué repos quedaron fuera del grupo y por qué
  (un repo excluido en silencio es invisible justo cuando importa). Si el grupo quedó en solo
  el repo actual porque el parent tiene >12 repos, sugerir declarar `repo_group:` en
  `.tycon/advisors.yaml`.
- **El script no existe** (clon de guides ausente) → 1 línea de warning y seguir (fail-open
  ruidoso, nunca silencioso).

## Output del step

```json
{
  "source": "dev",
  "target": "main",
  "repo_path": "/abs/path",
  "had_stash": false,
  "merge_worktree": false,
  "current_branch_at_start": "dev",
  "unpushed_findings": []
}
```

Pasar al Step 1.
