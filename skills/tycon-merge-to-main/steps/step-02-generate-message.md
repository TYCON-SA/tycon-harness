# Step 2 — Generar mensaje de merge descriptivo

**Objetivo**: armar el commit message que va a quedar en `git log` para siempre. Tiene que describir QUÉ se incluye con detalle suficiente para que un dev que mire el log un mes después entienda sin abrir cada commit.

**Esta es la responsabilidad central del skill.** Si el mensaje sale genérico, el skill falló su trabajo aunque el merge técnico haya andado.

## Plantilla

```
merge: <source> -> <target> — <subject>

<contexto general 1-2 líneas>

Cambios principales:

<grupo 1 — header descriptivo>
- <detalle técnico 1>
- <detalle técnico 2>

<grupo 2 — header descriptivo>
- <...>

<otros cambios menores>
- <fix puntual>

Tests: <resultado del Step 7 — se completa post-build>
Archivos: <N> changed (<top dirs>)

Commits incluidos:
- <hash> <subject>
- <hash> <subject>

Co-Authored-By: <el modelo exacto que implementó> <noreply@anthropic.com>
```

## Reglas de generación

### Subject de la primera línea

Sintetizar a partir del **dominant group** del Step 1:

- Si hay un `Story X.Y` dominante → `<Story X.Y descripcion> + <secondary topic si aplica>`
- Si hay varios scopes feat → `<scope1> + <scope2> features`
- Si es housekeeping (chore/docs/ci) → `housekeeping (<temas>)`
- Si es mixto → mencionar el más visible primero

Ejemplos buenos:
- `Story <N.M> (RecordingProcessor kill-switch) + DB migrations 023/027/028`
- `Voice feature 1.5 (E2E tests) + telegram notification fix`
- `housekeeping: bump versions + suprimir gitleaks falsos positivos`

Ejemplos MALOS (evitar):
- ❌ `sync N commits` — genérico
- ❌ `dev to main update` — no dice nada
- ❌ `weekly merge` — no dice qué hay

### Contexto general (1-2 líneas)

Después del subject, una línea de contexto que UNIFIQUE los grupos. Si no hay tema unificador → admitirlo: "Sync de N commits desde dev. Sin tema unificador — varios trabajos en paralelo."

### Bloques por grupo

Para cada grupo en `groups`:

1. **Header del grupo** (línea con header descriptivo, no solo el ID):
   - `Story <N.M> — RecordingProcessor:Enabled flag (2 commits)`
   - `DB migrations housekeeping (3 commits)`

2. **Bullets debajo**: 1 bullet por idea principal (NO por commit). Extraer del *body* del commit, no del subject:
   - Si el body tiene una lista → reusar esos puntos
   - Si el body es prosa → resumirlo en 1-2 bullets accionables
   - Mencionar archivos críticos cuando aplique

   Ejemplo bueno:
   ```
   Story <N.M> — RecordingProcessor:Enabled flag (2 commits)
   - Agrega prop Enabled a RecordingProcessorOptions (default false post follow-up).
   - Guard temprano en ExecuteAsync: si !Enabled → log + PushHealthSnapshot Status="Disabled" + return.
   - PushHealthSnapshot refleja _options.Enabled (antes hardcoded true).
   - plugin.json.example sincronizado con la nueva key.
   - 2 tests nuevos (35/35 worker) + helper CapturingPluginLogger.
   ```

   Ejemplo malo:
   ```
   Story <N.M> (2 commits)
   - feat(workers): add Enabled flag
   - feat(workers): default to false
   ```
   (Solo subjects, no dice qué hace cada cambio realmente.)

### Bloque "Otros cambios menores"

Si hay grupos chiquitos (1 commit) que no merece su propio bloque, agruparlos al final como bullets sueltos.

### Bloque "Tests"

Placeholder por ahora — se completa después del Step 7. En este step poné:

```
Tests: [pendiente — se completa post build+tests gate]
```

### Bloque "Archivos"

```
Archivos: <N> changed (<top dirs separados por coma>)
```

Ejemplo: `Archivos: 7 changed (src/TotoraBackend/Workers/, database/, tests/...)`.

### Bloque "Commits incluidos"

Lista cruda en orden cronológico DESC (más reciente primero, igual que `git log`):

```
- <hash> <subject>
```

Esto sirve de rastreabilidad — si querés ir al detalle de uno, sabés a qué `git show` apuntar.

### Trailer

Siempre, con **el o los modelos que implementaron**, según los trailers `Co-Authored-By:` de los
commits que entran en el merge — la sesión que mergea no es la que implementó (bajo Codex, el modelo
gpt que corresponda — regla canónica: `~/.claude/tycon-harness/guides/git-commit-conventions.md`).
Si ningún commit del rango trae la línea, va el modelo de la sesión que arma el mensaje, y se avisa
en una línea en el preview. Nunca el de un ejemplo:
```
Co-Authored-By: <modelo que implementó, según los commits> <noreply@anthropic.com>
```

## Edge cases

- **1 solo commit a mergear**: no necesitás agrupar. Mensaje queda más corto pero igual rico — copiá el body del commit como cuerpo del merge, agregá el "Tests" + "Archivos" + "Commits incluidos" (lista de 1).

- **Commits con conventional commit roto (sin tipo)**: agruparlos en un grupo `Otros cambios` al final.

- **Body de commit vacío**: usar el subject como bullet pero ampliarlo con info del diff si tenés (ej: "Touched files X, Y, Z" inferred del diff stat). NO inventar contexto que no esté en el commit.

- **Story ID detectado pero no documentado en el body**: incluir un bullet recordando "Story X.Y referenced — ver story file para contexto completo".

## Output del step

```json
{
  "subject_line": "merge: dev -> main — Story <N.M> (RecordingProcessor kill-switch) + DB migrations 023/027/028",
  "full_message": "<mensaje completo armado, con placeholder de Tests>",
  "needs_test_results_post_step_7": true
}
```

Pasar al Step 3.
