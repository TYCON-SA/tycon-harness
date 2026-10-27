# Git worktrees en el harness TYCON

**Qué es**: `git worktree add` crea un segundo directorio de trabajo del **mismo** repo
(comparten el `.git`), con su propia branch checkeada. No es un clone: cero fetch extra,
cero divergencia de historia, y los commits hechos en el worktree son visibles al instante
desde el checkout principal.

**Veredicto del análisis (2026-08-03)**: se adopta para **3 casos concretos** (tabla §1).
**NO** se adopta como default de cada corrida de pipeline — el costo por worktree
(`npm install`/`dotnet restore` desde cero, sin índice codegraph, disco) no se justifica
cuando se corre una story a la vez, que es el caso del 95% del tiempo.

---

> 🔴 **Esto se enforzó con un hook, hoy retirado**: `scripts/hooks/session-collision-guard.js`
> frena `commit`/`checkout`/`switch`/`rebase`/`stash`/`reset`/`merge`/`pull` cuando OTRA sesión tuvo
> actividad en el mismo checkout en los últimos 3 minutos, y avisa al abrir una sesión donde ya hay
> otra viva. Por qué: con dos sesiones sobre el mismo checkout, un commit puede arrastrar una deleción ajena
> del índice y otro caer en la rama de la otra sesión.
> En los dos repos donde el worktree está prohibido (éste y `agent-skills`) el consejo es coordinar,
> no abrir un worktree. Si la persona decide seguir igual porque está coordinado, el comando lleva
> `TYCON_SESSION_GUARD_OK=1` pegado adelante: pasa y queda constancia, que la revisión de la noche
> cuenta. Lo decide la persona, no el agente.
>
> **Cómo se trabaja entonces con otra sesión viva:** en un CLON
> descartable en el scratchpad de la sesión, con `origin` apuntando al remoto real, y se pushea desde
> ahí; el checkout compartido no se toca. El costo es que el checkout queda atrás y el dev no ve nada
> en su editor hasta el próximo arranque (medido: 21 commits atrás). Por eso, **al
> terminar la tanda**, si ninguna otra sesión tocó git en los últimos 3 minutos (el mismo criterio
> del freno), el agente adelanta el checkout con `git merge --ff-only --autostash origin/main` y lo
> dice; si hay actividad, lo dice y el checkout se actualiza solo al arrancar. No se permiten
> worktrees acá: habría que arreglar antes el freno de `git add -A` para que reconozca el repo por
> identidad y no por ruta, y el `.git` compartido es justo lo que dos sesiones se pisan.

## 1. Cuándo SÍ y cuándo NO

| Caso | Veredicto | Por qué |
|---|---|---|
| **2 pipelines de stories distintas, mismo repo, en paralelo** | ✅ un worktree por story (§3) | Compartiendo working tree hay un solo HEAD, el `git diff HEAD` repo-wide contamina cruzado el set de advisors y el coverage, y `.advisors/tests-result.json` es un único archivo que la 2da corrida pisa. PIPE-C0 ni siquiera lo detecta (matchea por storyId). |
| **`/tycon-merge-to-main` sin congelar el working tree del dev** | ✅ worktree persistente `--merge` (§4) | El merge hoy checkoutea `<target>` EN TU working tree, corre build+tests ahí, y recién al final te devuelve la branch. Con working tree sucio directamente aborta o stashea. |
| **Fan-outs (tool `Workflow` / `Agent`) con agentes que ESCRIBEN en paralelo** | ✅ `isolation: 'worktree'` (§5) | Aísla las escrituras de cada agente; el worktree se auto-limpia si el agente no cambió nada. |
| Advisors del Step 5 del pipeline | ❌ | Son read-only por frontmatter (`Read, Grep, Glob`; ninguno tiene `Write`/`Edit` salvo `tycon-retrospective-capturer`). No hay nada que aislar. |
| Default de todo pipeline run | ❌ | Costo fijo por worktree sin beneficio si no hay paralelismo real. |
| Worktrees de `~/.claude/agent-skills` o el arnés | ❌ | El safety-guard (GIT-C4, `git add -A` bloqueado en agent-skills) matchea por **substring literal del path** — un worktree en otra ruta lo esquiva. Y ambos repos se auto-pullean vía `SessionStart` en su ruta fija: un worktree no recibe ese sync. |

---

## 2. Convención de naming y ubicación

```
<parent>/<RepoName>--wt-<slug>      # worktree de trabajo (efímero, por story/tarea)
<parent>/<RepoName>--merge          # worktree de merge (persistente, §4)
```

- **Sibling del checkout principal**, nunca adentro del repo.
- **El nombre del repo va adelante, siempre**. No es estética: el registro de horas
  asocia el proyecto por **basename del cwd** (match exacto → parcial), así que
  `<repo>--wt-story-3-2` sigue registrando en el proyecto correcto. Un worktree llamado
  `story-3-2` a secas rompe el registro en silencio.
- **Branch**: la de la story (`feat/...`) o `wt/<slug>`. Git prohíbe la misma branch
  checkeada en dos worktrees — eso es un guardrail, no un problema.
- **Helper** (mac/linux): `scripts/tools/tycon-worktree.sh` de este repo. En Windows, los
  comandos crudos — son git puro, idénticos en todas las plataformas:

```bash
git worktree add -b wt/<slug> ../<RepoName>--wt-<slug>   # branch nueva desde HEAD
git worktree add ../<RepoName>--wt-<slug> <branch>       # branch existente
git worktree list
git worktree remove ../<RepoName>--wt-<slug> && git worktree prune
```

---

## 3. Pipelines en paralelo (la regla de recursos NO desaparece)

Un worktree por story resuelve la **contaminación de estado** (HEAD, diff, `.advisors/`),
no la **máquina compartida**. Las reglas de `test-execution-discipline.md` aplican
**sumadas entre worktrees**, porque los cores y la RAM son los mismos:

1. **Full suite en UN worktree a la vez** — el cap `maxWorkers: '50%'` es por proceso;
   dos procesos vitest concurrentes = 100% de cores = el swap thrash documentado.
2. **El 2do pipeline arranca con `TYCON_5B_EARLY=0`** (regla ya existente de `step-06-run-tests.md`
   §Riesgo multi-sesión — el cap de subagentes es por máquina, no por pipeline).
3. **Gates runtime NO simultáneos**: DevHost/E2E usan puertos fijos (`:5001`); dos
   worktrees no pueden levantar la app a la vez sin override de puerto.

Lo que ya funciona **sin tocar nada** (verificado 2026-08-03): los markers del pipeline
son per-sessionId con `repoPath` propio; `on-write-collision.js` compara paths absolutos
(dos worktrees = paths distintos = cero falsas colisiones); `.advisors/` y `.tycon/` viven
por worktree (el aislamiento de `tests-result.json` pasa a ser correcto de fábrica); y el
story-discovery de `pipeline.js` ya soporta `.git` como archivo (que es lo que un worktree
tiene) — con test unitario que lo cubre.

---

## 4. El worktree de merge persistente

```bash
scripts/tools/tycon-worktree.sh merge-tree            # crea/reusa <parent>/<RepoName>--merge en main
```

Persistente **a propósito**: conserva `node_modules/`, `bin/`, `obj/` entre merges, así el
gate de build+tests del `/tycon-merge-to-main` no paga un install completo cada vez. El
skill lo ofrece como opción cuando el working tree del dev está sucio (opción (c) de su
primer paso) y en ese modo **rebindea `repo_path` al worktree**: tu checkout se queda en `dev`,
intacto, mientras el merge y su gate corren al lado.

Restricción de git: si tu working tree principal **ya está** en `<target>`, el worktree no
puede checkoutear esa branch → usar el modo normal.

---

## 5. Aislamiento de escrituras en fan-outs

- Tool `Agent`: `isolation: "worktree"` — el agente corre en un worktree propio,
  auto-removido si no cambió nada.
- Tool `Workflow`: `agent(prompt, { isolation: 'worktree' })` — **caro** (~200-500ms de
  setup + disco por agente): usarlo SOLO cuando ≥2 agentes **mutan archivos** en paralelo
  (migraciones masivas, codemods por lote). No aplica a los revisores ni al pase adversarial del pipeline: los
  hunters compilan y corren probes pero no editan el repo.

---

## 6. Setup por worktree — checklist y gotchas

| Qué | Estado en un worktree recién creado | Acción |
|---|---|---|
| `node_modules/`, `bin/`, `obj/`, `dist/` | **No existen** (no son parte del checkout) | `npm install` / `dotnet restore` ANTES de cualquier gate o suite |
| `.codegraph/` | No existe (gitignored; 61 MB en un repo del equipo) | **NO inicializar** en worktrees efímeros. Sin `.codegraph/` la regla CodeGraph no aplica → grep/Grep permitidos (la excepción ya está prevista en el README) |
| Registro de horas | Cache de proyecto keyed por **path absoluto** → primer uso en el worktree re-matchea por basename | Nada, si respetaste el naming §2. Puede pedir UNA confirmación la primera vez |
| `.tycon/` (`advisors.yaml`, `runtime-waivers.jsonl`), `.engram-project`, `.engram/` | **Trackeados** → viajan solos con el checkout | Nada. Los waivers firmados en el worktree se commitean ahí y llegan por el merge de la branch |
| `.advisors/`, `.dashboard/` | Nacen vacíos por worktree | Nada — ese aislamiento es exactamente el beneficio |
| `tasks/todo.md` | Por worktree (efímero) | Nada |
| `.env` / secrets NO trackeados | **No viajan** | Copiarlos a mano si el gate runtime los necesita |
| Hooks `SessionStart` (git pull de guides/agent-skills, installer) | Globales, con paths absolutos al checkout principal | Indiferentes al worktree — funcionan igual |

---

## 7. Cleanup

```bash
scripts/tools/tycon-worktree.sh rm <slug>    # se niega si el worktree tiene cambios sin commitear
```

`git worktree remove` + `git worktree prune`. La **branch queda** (se borra aparte con
`git branch -d` cuando ya mergeó). Un worktree olvidado no rompe nada, pero ocupa disco y
ensucia `git worktree list` — limpiar al cerrar la story.

**Se limpian solos** (2026-10-16, pedido del dueño: ese día había 30 worktrees y 28 ya estaban mergeados).
`scripts/hooks/worktree-sweep.js` hace dos cosas con el mismo criterio —borra sólo lo que está **limpio** y con su
HEAD **ya en origin/main**, con `git worktree remove` sin `--force` y `git branch -d`—:

- **Al cerrar la story** (`/tycon-pipeline close`, paso 9): `node <arnés>/scripts/hooks/worktree-sweep.js --story <N.M>`
  trae origin y borra los worktrees cuya rama nombra la story. Los que tienen cambios o commits sin mergear los nombra
  y no los toca.
- **Al arrancar sesión**, una vez por día, en todos los repos conocidos: lo mismo, más dos resguardos para no pisar a
  otra sesión viva — no toca un worktree usado en las últimas 4 horas (`TYCON_WORKTREE_SWEEP_IDLE_HOURS`) ni uno recién
  creado sin trabajo propio. Lo que deja con trabajo lo nombra en una línea.

Nunca toca el checkout principal, uno bloqueado (`git worktree lock`) ni el de la sesión. Apagar:
`TYCON_WORKTREE_SWEEP=0`. Ver qué haría: `--force --dry-run`.

---

**Por qué**: el pipeline ya es parcialmente worktree-safe (story-discovery
tolera `.git` file, markers per-session con `repoPath`, colisiones por path absoluto).
El bloqueo real para paralelizar stories no es el pipeline: es **compartir el
working tree** (HEAD único, diff repo-wide contaminado, `tests-result.json` pisado). El
merge-to-main es el otro costo silencioso: cada merge congela el working tree del dev
durante todo el gate.
