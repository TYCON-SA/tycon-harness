# Wiki por temas (patrón Karpathy)

Resumen vivo cross-archivo de un repo de specs, organizado **por tema** (no por sprint). Cada
página-tema resume el estado vigente + decisiones + cambios pendientes + las stories afectadas
+ links a las fuentes canónicas. Permite responder *"¿cuál es el estado de X?"* abriendo **una**
página, en vez de reconstruir desde 5-6 archivos.

> **Guía compartida desde 2026-06-27**, para que cualquier repo de specs TYCON lo adopte con la versión
> performante del lint (ver §Lint — la primera versión colgaba el pre-commit con muchas stories).

## Cuándo usarlo

Repos de **specs** (PRD / architecture / stories) donde un mismo tema se toca desde muchas
stories y reconstruir su estado vigente cuesta abrir varios archivos. **Opt-in por repo** — no
todos los proyectos lo necesitan. Hoy lo usa solo Ceibo; esta guía es para el próximo que lo adopte.

## Estructura

```
specs/wiki/topics/
├── <slug-tema-1>.md
├── <slug-tema-2>.md
└── ...
```

### Frontmatter de una topic page

```yaml
---
title: "..."
type: topic
status: vigente | vigente-con-cambio-propuesto | obsoleto
last_updated: YYYY-MM-DD
maintained_by: agente   # páginas anteriores a 2026-08-23 dicen `claude` — mismo significado, no migrar
related_stories: ["2.5", "5.4", ...]   # ids de las stories que tocan el tema
related_crs: ["CR-009", ...]
pending_decisions:
  - id: <slug>
    blocking: "Sprint N planning"
    description: "..."
---
```

### Frontmatter de la story afectada

Cada story listada en `related_stories` de un topic DEBE declarar el tema (alineación
bidireccional — el lint la enforça):

```yaml
topics: [<slug>, ...]
```

(El campo `topics` ya está documentado en `story-format.md` §frontmatter.)

## Lint (story ↔ wiki)

`scripts/tools/lint-wiki.sh` chequea 3 reglas:

1. Cada story en `related_stories` de un topic tiene `topics: [<slug>]` en su frontmatter.
2. Cada story con `topics: [<slug>]` existe como page `specs/wiki/topics/<slug>.md` y está listada ahí.
3. `pending_decisions` con `blocking` → se reportan como **warnings** (informativo, no bloquea).

Exit `0` si OK, `1` si hay errors.

> **🔴 Performance (por qué esta versión es la canónica):** la implementación original hacía
> `grep -lE` sobre TODO `stories/*.md` por **cada** related_id de **cada** topic →
> `O(topics × ids × N_stories)` + ~1300 forks. Con ~270 stories (medido) superaba
> el timeout del git pre-commit y **parecía colgado**. La versión de esta guía construye 2 índices
> con **una sola pasada `awk` cada uno** y hace los cross-checks sobre esos índices chicos
> (~16s estable vs >90s). Es **compatible con el bash 3.2 de macOS** (sin `declare -A`; usa
> comparación de string forzada en `awk` para que `"13.3" != "13.30"` — el `==` numérico de awk
> los daría iguales). **Copiar siempre esta versión; no reescribir el `grep -lE` ingenuo.**

## Setup en un repo que adopta el patrón

1. **NO copiar el script.** Vive solo en este repo; el proyecto lo referencia por path.
   Se puede porque el onboarding del equipo clona el arnés en una ruta fija
   (`~/.claude/tycon-harness`) y el hook `SessionStart` le hace `git pull` en cada
   arranque, y porque un `pre-commit` corre siempre en local, nunca en CI. El script resuelve
   el `specs/` a lintear desde la raíz del repo git donde corre (o por argumento / env
   `SPECS_DIR`). Unificado 2026-07-24 — antes se copiaba a cada repo y había que mantener
   las copias en sync a mano.

2. **Git pre-commit hook** versionado que corre el lint solo si el commit toca el wiki o stories.
   Crear `<repo>/.githooks/pre-commit`:
   ```bash
   #!/usr/bin/env bash
   set -e
   REPO_ROOT="$(git rev-parse --show-toplevel)"; cd "$REPO_ROOT"
   TYCON_GUIDES_DIR="${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}"
   WIKI_LINT="$TYCON_GUIDES_DIR/scripts/tools/lint-wiki.sh"
   if git diff --cached --name-only | grep -qE "^(specs/wiki/topics/|specs/stories/.*\.md$)"; then
     if [ ! -f "$WIKI_LINT" ]; then
       echo "⚠️  No encontré $WIKI_LINT — se saltea el wiki lint."
       echo "   Cloná el arnés (onboarding) o exportá TYCON_GUIDES_DIR."
     else
       echo "→ Wiki lint (specs/wiki/topics/ ↔ specs/stories/)..."
       bash "$WIKI_LINT" || { echo "❌ Wiki lint detectó drift. (Bypass emergencia: git commit --no-verify)"; exit 1; }
     fi
   fi
   ```
   Activar (una vez por clone): `git config core.hooksPath .githooks`.

   > Conviene cablear en el mismo hook el **lint de frontmatter de stories**
   > (`scripts/lib/lint-story-frontmatter.js`, ver `story-format.md` §1.0) — mismo criterio de
   > referencia por path, snippet en la cabecera de ese script.

3. **Documentar** el patrón + las 3 operaciones en el `CLAUDE.md` del repo.

## Operaciones (3)

- **ingest** — llega input nuevo (feedback, decisión, retro): *"ingerí esto al wiki tema X"* →
  el agente actualiza la página + suma backlinks en las stories afectadas + corre el lint.
- **query** — para entender el estado vigente de un tema: abrir la página, no reconstruir.
- **lint** — `bash ~/.claude/tycon-harness/scripts/tools/lint-wiki.sh` detecta drift entre topic pages y stories. Correr antes de
  planear cada sprint y antes de mergear feedback a main (lo enforça el pre-commit hook).
