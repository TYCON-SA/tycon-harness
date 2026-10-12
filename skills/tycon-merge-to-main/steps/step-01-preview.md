# Step 1 — Preview commits + delta

**Objetivo**: recolectar la info que va a alimentar el Step 2 (generación del mensaje). Listar commits, leer bodies, agrupar.

## Acciones

> **CRÍTICO — siempre comparar contra `origin/<target>`, NO `<target>` local.** El branch local del target puede estar desactualizado (otros devs pushearon vía PRs / pipelines de CI directos a main). Comparar contra el remoto evita sobreestimar la lista de commits pendientes (caso típico: el dev cree que faltan 8 commits cuando en realidad 7 ya están en `origin/main` y el único pendiente es el suyo). Hacer `git fetch origin` antes para asegurar refs frescas.

### 1.1 — Lista de commits a mergear

```bash
git log origin/<target>..origin/<source> --oneline
```

Si vacío → exit `nothing-to-merge` y terminar el skill con mensaje:
```
✅ Nada que mergear. `origin/<target>` ya tiene todos los commits de `origin/<source>`.
```

### 1.2 — Subjects + bodies completos

```bash
git log origin/<target>..origin/<source> --pretty=format:"COMMIT %h%nSUBJECT %s%nBODY%n%b%n---END---"
```

Parsear cada bloque y armar una estructura:

```
[
  { hash: "ea6fee9", subject: "feat(workers): ...", body: "..." },
  ...
]
```

### 1.3 — Stat de archivos cambiados

```bash
git diff --stat origin/<target>..origin/<source>
```

Capturar:
- N archivos cambiados
- Lista de directorios top-level más impactados (ej: `src/TotoraBackend/Workers/`, `database/`, `tests/...`)

### 1.4 — Categorización heurística

Para cada commit:

1. **Detectar story ID** (regex sobre subject + body):
   - `Story (\d+\.\d+)` → "Story <N.M>"
   - `story-(\d+\.\d+)` → "Story <N.M>"
   - `#(\d+)` → "Issue #123"
   - `([A-Z]+-\d+)` → "ABC-456"

2. **Detectar conventional commit type + scope** del subject:
   - Regex: `^(feat|fix|chore|docs|test|refactor|ci|build|perf|style)(\(([^)]+)\))?:`
   - `feat(workers): foo` → type=`feat`, scope=`workers`

3. **Asignar grupo**:
   - Si tiene story ID → grupo = `Story X.Y`
   - Si no, pero tiene scope → grupo = `<type>(<scope>)`
   - Si no → grupo = `<type>`

### 1.5 — Detectar grupo dominante

El grupo con más commits, o el que tiene el feat más impactante (heurística: si hay `feat:` con story, ese gana).

Esto va a alimentar el subject del mensaje en Step 2.

## Output del step

```json
{
  "commits": [
    {
      "hash": "ea6fee9",
      "subject": "feat(workers): add Enabled flag to InvoiceExportWorker (Story <N.M>)",
      "body": "Precondicion para Story <otra N.M>...",
      "type": "feat",
      "scope": "workers",
      "story_id": "Story <N.M>",
      "group": "Story <N.M>"
    },
    ...
  ],
  "files_changed": 7,
  "top_dirs": ["src/TotoraBackend/Workers/", "database/", "tests/..."],
  "groups": {
    "Story <N.M>": [<2 commits>],
    "feat(database)": [<3 commits>]
  },
  "dominant_group": "Story <N.M>"
}
```

Pasar al Step 2.
