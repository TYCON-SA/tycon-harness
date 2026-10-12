---
name: tycon-merge-to-main
description: Mergea una source branch (default `dev`) a una target branch (default `main`) generando un mensaje de commit descriptivo y rico — agrupado por story/scope, con detalle técnico de qué se incluye, lista completa de commits, stats de archivos y resultado de tests. Incluye build+tests gate paranoico y 2 checkpoints HITL (preview+mensaje, push approval). Usar cuando el usuario pide "merge a main", "mergear dev a main", "/tycon-merge-to-main", "sync dev a main", "merge to main".
---

# tycon-merge-to-main

Skill team-wide para mergear branches con un mensaje de commit que describe **lo que realmente se incluye** — no genérico. Pensado para sustituir el `git merge` manual de la regla CLAUDE.md "Merge a main: usar skill `/merge`".

## Cuándo activarse

Invocar este skill cuando el usuario dice (es/en):

- "merge a main"
- "mergear dev a main"
- "sync dev a main"
- "/tycon-merge-to-main"
- "merge to main"
- "merge dev → main"

**No invocar automáticamente** si el usuario solo dice "merge" sin contexto de branch (puede ser `/merge` built-in que invoca review). Pedir clarificación.

## Inputs

| Input | Default | Notas |
|---|---|---|
| `source` | `dev` | branch de origen |
| `target` | `main` | branch destino |
| `repo_path` | `cwd` | path al repo (debe ser git) |
| `mode` | `push` | `push` = merge local + push al target (histórico) · `pr` = crear Pull Request (en Azure DevOps, con auto-complete; en GitHub, el skill espera el control declarado en `merge.check` y mergea). **Se DECLARA**, no se adivina: `.tycon/advisors.yaml → merge.mode: pr`, en el repo. Única excepción: un clon del repo público del arnés, que no trae ese archivo — ahí vale el del clon de mantenimiento que declara la máquina (`paths.maintainers`). De dónde salió lo dice `merge-pr.js plan` (`configFrom`) |

Si el usuario no especifica, asumir defaults `dev → main` en `cwd`.

## Los dos modos

**`push` (default)** — el flujo histórico: merge local `--no-ff` y push del target. Sigue siendo
correcto en repos sin protección de rama.

**`pr`** — para repos donde el target exige Pull Request (política de rama). Cambia sólo el final
del flujo: **se saltean los Steps 5 y 6** (no hay checkout ni merge local — no se puede pushear el
target) y el Step 9 se reemplaza por **step-09b-create-pr.md**, que pushea la source y crea el PR
con auto-complete, usando el mensaje del Step 2 como descripción. Detección del modo y edge cases:
ver ese step.

**`pr` con el repo en GitHub** — el mismo modo, otro servidor: el Step 9 se reemplaza por
**step-09c-create-pr-github.md**. Cuál de los dos corre lo decide el remoto `origin` (lo dice
`scripts/tools/merge-pr.js plan` del arnés), no una suposición. Lo que cambia allá: el servidor no
siempre mergea solo, así que el skill **espera el control que el repo declara** en
`.tycon/advisors.yaml → merge.check` y recién entonces mergea, con un commit de merge titulado
«asunto (#N)»; antes pone la rama al día con el target; y si el repo numera versiones
(`version.json` en la raíz), deja en la rama un commit que sube el número. Sin `merge.check`
declarado, crea el pedido y no lo mergea.

🔴 **Step 7 en modo `pr`: las SUITES COMPLETAS locales SE SALTEAN** (la validación del PR corre
esas mismas suites —jest de forms en FrontEnd, unit +
integración con cobertura en Backend— sobre el merge previo con el target, que es más autoritativo
que la source local; y con la expiración inmediata de la policy, un verde viejo no puede colarse).
Lo que el Step 7 CONSERVA en modo `pr`: el **build rápido local** de la source (para no quemar un
ciclo de CI con algo que ni compila) y el gate E2E crítico del 7b-1 cuando aplica — el pipeline
del PR no corre Playwright. Ése es el trato: la full suite vive en el servidor, tu máquina no se
funde más por un merge.

## Filosofía del mensaje de commit

El **valor central** del skill es el mensaje del merge commit. La regla:

> Un dev que lee `git log --oneline` un mes después del merge debe poder reconstruir QUÉ se incluyó y POR QUÉ con solo leer el subject + body del merge commit, sin tener que abrir cada commit individual.

Por eso el Step 2 (generar mensaje) tiene heurísticas específicas: detección de story IDs, agrupación por scope, extracción del *body* (no solo subject) de cada commit, stats de archivos, resultado de tests.

## Configuración de diseño

- **HITL #1** (Step 3): siempre pausa. Muestra preview + mensaje generado. Permite editar el mensaje antes de mergear.
- **HITL #2** (Step 8): siempre pausa antes de `git push`. Última oportunidad de cancelar (sin perder el merge commit local).
- **Build+tests gate** (Step 7): **hard fail**. Si rojo → propone `git merge --abort`, NO push.
- **Engram sync** (Step 4): condicional — solo si el repo lo declara o tiene `.engram/`.
- **Notificaciones externas**: NO. El skill no manda Telegram/Slack/email. Output va al usuario en el chat.

## Stack support (v1)

- **.NET** (`*.sln` o `*.csproj` en root): `dotnet build && dotnet test --filter "Category!=Integration&Category!=EdgeCase"`
- **Node.js** (`package.json` con script `test`): `npm install --no-audit --prefer-offline && TYCON_FULL_SUITE=1 npm test`

Si no detecta stack → preguntar al usuario qué corre o saltar Step 7 con confirmación explícita.

## Flujo (10 steps)

Seguí EN ORDEN los 10 steps definidos en `steps/`:

0. **step-00-preflight.md** — repo git, branches existen, working tree limpio, `git fetch`, y **0.6: scan de trabajo sin subir en el GRUPO de repos** (`~/.claude/tycon-harness/scripts/hooks/unpushed-work-notice.js --scan` — sin él se puede promover el front con el backend commiteado sólo en la máquina del dev; el hallazgo se muestra en el HITL #1, la decisión es del dev). ABORT si dirty.
1. **step-01-preview.md** — listar commits + diff stat + categorizar por tipo/story.
2. **step-02-generate-message.md** — armar mensaje rico (heurística de agrupación + extracción de body).
3. **step-03-hitl-confirm-merge.md** — HITL #1: mostrar preview + mensaje, opción de editar mensaje. Aprobar.
4. **step-04-engram-sync.md** — sync condicional según repo.
5. **step-05-checkout-pull.md** — `git checkout <target> && git pull --ff-only`. ABORT si target divergió.
6. **step-06-merge.md** — `git merge --no-ff origin/<source> -m "<mensaje>"`. ABORT si conflict.
7. **step-07-build-tests.md** — gate paranoico (build + unit/vitest = gates BLOQUEANTES). ABORT con `git merge --abort` propuesto si rojo.
   **7b — E2E del PROYECTO (agnóstico vía `.tycon/advisors.yaml` → `e2e.gate`)**: el gate E2E lo OWNea cada repo (script + specs + stack viven en SU repo); este skill lo RESUELVE y no conoce puertos/specs de ningún proyecto. Resolver primero y volcar a un archivo para extraer campos:
   ```bash
   # Archivos que ESTA entrega tocó (repo-relativos).
   # 🔴 En modo `pr` usar SIEMPRE el rango de ramas — NUNCA ORIG_HEAD (pase adversarial
   # 2026-08-30, H3): en modo pr no hubo merge local, pero ORIG_HEAD casi siempre existe
   # igual (lo deja cualquier pull/merge previo en dev), así que el fallback-por-fallo no
   # se activaba y el diff salía de un rango VIEJO → apps E2E elegidas mal en silencio.
   if [ "$MODE" = "pr" ]; then
     CHANGED=$(git -C <repo> diff --name-only origin/<target>...origin/<source>)
   else
     # ORIG_HEAD lo deja el `git merge` del paso 6.
     CHANGED=$(git -C <repo> diff --name-only ORIG_HEAD HEAD 2>/dev/null \
               || git -C <repo> diff --name-only origin/<target>...origin/<source>)
   fi
   # La ruta del archivo sale de tmp-path.js: la misma para bash (que escribe) y Node (que lee) en Mac, Linux y Windows,
   # y una por repo y por sesión (dos merges a la vez no se pisan la configuración).
   E2ECFG=$(node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/lib/tmp-path.js e2ecfg <repo>)
   node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js e2e-config --repo <repo> \
     --changed $(echo "$CHANGED" | tr '\n' ' ') > "$E2ECFG"
   # si la configuración no se puede leer, se DICE (antes un catch vacío lo volvía «sin gate configurado»)
   GATE=$(node -e 'try{process.stdout.write(require(process.argv[1]).gate||"")}catch(e){process.stderr.write("⚠️ no pude leer la configuración de E2E ("+process.argv[1]+"): "+e.message+"\n")}' "$E2ECFG")
   GAP=$(node -e 'try{process.stdout.write(require(process.argv[1]).warning||"")}catch(e){process.stderr.write("⚠️ no pude leer la configuración de E2E ("+process.argv[1]+"): "+e.message+"\n")}' "$E2ECFG")
   # Las apps a ejercer: las que la entrega TOCÓ (una línea por app, absolutas).
   APPS=$(node -e 'const c=require(process.argv[1]);process.stdout.write((c.frontend_dirs_selected||[c.frontend_dir].filter(Boolean)).join("\n"))' "$E2ECFG")
   ```

   🔴 **`APPS` puede traer MÁS DE UNA.** Un monorepo declara varias
   apps con Playwright en `e2e.frontend_dirs` y el gate corre **una vez por app tocada**. Leer un
   único `frontend_dir` escalar corre los E2E de OTRA app: no falla, ejerce otra cosa, que es peor,
   porque un control que mira la app equivocada se lee igual que uno que anda.
   - `APPS` vacío (la entrega no tocó ninguna app declarada) → saltear 7b-1 con 1 línea.
   - `CHANGED` vacío o no computable → el resolver devuelve TODAS (fail-safe): correr de más cuesta
     minutos, correr de menos deja pasar la regresión.
   - Repos con el `frontend_dir:` escalar de siempre → `APPS` trae esa sola app. Nada que migrar.
   - Si `GAP` no está vacío (el JSON trae `gap:true`) → el repo **TIENE specs Playwright pero NO declaró el gate** → **avisar FUERTE al user** (no skip silencioso): relayear `$GAP` ("E2E sin gate declarado — no va a frenar el merge; declaralo en `.tycon/advisors.yaml`"). Seguir el merge (no abortar por config faltante), pero el aviso queda visible.
   - Si `GATE` y `GAP` vacíos (el repo de verdad no tiene E2E, JSON `{}`) → SKIP silencioso 7b-1 (1 línea).
   - Si `GATE` no vacío (gate declarado) → correr 7b-1 (7b-2 no se lanza, ver abajo):

   **7b-1 — Tier CRÍTICO (BLOQUEANTE, sync)** — sin él ningún E2E frena el merge. Si `e2e.critical_specs` no está vacío, correr ESOS specs del flujo core en FOREGROUND ANTES del push. Set curado verde-confiable → corre rápido (~2-3 min). **Exit != 0 → ABORTAR el push** (proponer `git merge --abort` o esperar fix). Pasar los specs con `xargs` (shell-agnóstico — zsh NO word-splittea un var sin comillas):
   ```bash
   # Una corrida POR APP tocada. Falla cualquiera → abortar el push (se registra cuál).
   echo "$APPS" | while read -r FE; do
     [ -n "$FE" ] || continue
     node -e 'const c=require(process.argv[1]);process.stdout.write((c.critical_specs||[]).join("\n"))' "$E2ECFG" \
       | xargs bash "$GATE" "$FE" merge-critical-<target> <repo>/.advisors/dod-runtime || exit 1
   done
   ```
   Sin `critical_specs` (o vacío) → no hay tier crítico, saltear 7b-1.
   🔴 **Un exit != 0 no siempre es "los tests fallaron"** (el gate genérico, desde 2026-09-27): **1**
   = rojo real · **3** = el stack no levantó · **2** y **4** = `verdict=SIN_EJERCER`, el gate corrió y
   **no ejerció ni un flujo** (2: el filtro no matcheó ningún spec; 4: los specs se saltearon solos
   porque el entorno no tiene los datos que consumen). Los cuatro frenan el push igual, pero al user
   se le dice CUÁL: con 4 no hay nada que arreglar en el código, faltan datos. `xargs` colapsa el
   código a 1 o 123, así que el número real se lee en la evidencia (`verdict=` y la línea `motivo:`).
   Con varias apps, **anunciar cuáles se van a correr y por qué** (qué archivos las tocaron) antes de
   arrancar: si el dev ve correr una app que no esperaba, eso es información, no ruido.

   **7b-2 — Suite FULL: NO se lanza (desde 2026-09-16).** Hasta esa fecha corría en
   segundo plano como información. **Condición de vuelta: vuelve cuando el gate del proyecto tenga aislamiento por worker.**
   Por qué: la última corrida medida (2026-06-10, 272 tests / 79 specs) tardó más de 80 min y dio 143
   rojos BASURA por interferencia entre workers; un resultado informativo que da ruido no lo lee nadie
   y ocupa la máquina del dev una hora. La regresión cruzada la cubren la validación del pull request (modo `pr`) y el gate de build y
   pruebas del paso 7 del merge (modo `push`); el **tier crítico (7b-1)** sigue siendo la señal E2E que
   frena.
   Skip-condition verificable: repo sin `e2e.gate` en `.tycon/advisors.yaml` (anunciarlo en 1 línea).
   **🔴 Regla general anti-espera (misma decisión)**: NINGÚN paso del skill puede dejar al user mirando una consola por >2-3 min. Toda espera larga (E2E full, CI post-push, deploys) va a background con watcher + aviso al completar. Si un resultado es prerequisito de un paso posterior, el skill entrega el control al user y retoma cuando llega la notificación.
8. **step-08-hitl-push.md** — HITL #2: confirmar push. Cancelar deja merge local sin push.
   (En modo `pr` no hay merge local: cancelar acá simplemente no pushea la source ni crea el PR.)
9. **step-09-push.md** — push + retry una vez si race condition. **(modo `push`)**
9b. **step-09b-create-pr.md** — **(modo `pr`)** push de la source + PR con auto-complete y el
    mensaje del Step 2 como descripción. `--squash false` es obligatorio: con squash se rompen
    las notas de versión de plugins y forms. `org`, `proyecto` y
    `repo` se **derivan del remoto `origin`** con `identidadAzure()` del arnés, nunca a ojo ni del
    nombre de la carpeta. Y la **rama source se borra al completar** salvo que sea de larga vida: la
    lista está declarada en 9b y en ningún otro lado — no se repite acá a propósito, porque dos copias
    de la misma lista se separan solas.
9c. **step-09c-create-pr-github.md** — **(modo `pr`, remoto de GitHub)** pone la rama al día con el
    target, sube `version.json` si el repo numera versiones, pushea la source y crea el pedido con
    `gh` (el título literal y el cuerpo por archivo: es la forma que lee el freno antes de publicar);
    corre el latido del 10b; espera **en segundo plano** el control declarado en `merge.check` y, con
    ese control en verde, mergea con un commit de merge atado a la punta validada. Nunca aplasta ni
    reordena commits. Las partes mecánicas las hace `scripts/tools/merge-pr.js` del arnés.
10. **step-10-summary.md** — `git checkout <source>` + resumen final. (En modo `pr` nunca se
    salió de la source: el checkout es un no-op, solo va el resumen.)
    **10b — Latido de la retrospectiva (post-push — sin modelo desde 2026-09-16)**: 🔴 **por CADA repo mergeado en la sesión** (con dos repos mergeados, una sola retrospectiva deja a uno sin la suya). El hook `retro-pending.js` registra cada push a main y su Stop-gate no deja cerrar el turno hasta que **cada merge tenga su archivo de métricas** (`.dashboard/metrics-*.json` con ese repo y ese commit); el aviso de arranque reclama los que quedaron sin cubrir. Por cada repo, en este orden:
    (a) **Preguntar si hace falta — SÓLO en modo `push`**: `node <arnés>/scripts/hooks/retro-pending.js --judge <repo>` (`<arnés>` = `~/.claude/tycon-harness`, o `TYCON_GUIDES_DIR`). Si `exento` no es null (el push trajo sólo tests/docs sin cerrar story), decirlo en UNA línea y no correr nada más para ese repo — el hook ya dejó la constancia. 🔴 **En modo `pr` NO se pregunta**: la exención se calcula sobre el rango que movió el push a `main`, y en modo `pr` esta máquina nunca pushea `main` (el merge lo hace Azure). `--judge` termina leyendo la ventana del último `fetch` — medido sobre un checkout real: 334 commits, ninguno de este merge —, y un `exento` salido de ahí saltearía el latido con la deuda viva. En modo `pr` lo que decide es si el hook dejó entrada en el ledger: si la dejó, va (b).
    (b) **Correr el latido**: `node <arnés>/scripts/metrics/retro-heartbeat.js --repo <repo> --merge <sha> [--story <id>]` — un segundo, sin modelo; `--story` si el merge cierra una story (así cuenta sus vueltas de revisión).
        🔴 **Qué sha va en `--merge` — NO es el mismo en los dos modos.** El archivo paga la deuda sólo si su `merge_commit` es **el que anotó el ledger** (`retro-pending.js` empareja repo + sha). En modo `push` ese sha es el del merge que acabás de pushear. En modo **`pr` es LA PUNTA DE LA SOURCE** al crear el PR: el merge lo hace Azure después y su sha todavía no existe. (Con el repo en GitHub vale lo mismo —el registro anota la punta al crear el pedido— y el latido corre en el 9c.7, ANTES de la espera del control, que termina el turno: acá no se repite.) Con el sha del merge de Azure el gate **sigue bloqueando** hasta agotar los 3 bloqueos y queda un `metrics-*.json` de más en la serie que leen el nocturno SDLC (`first_pass_ratio`) y la vista de corridas (reproducido sobre un clon real). Tampoco sirve `git rev-parse HEAD`: si commiteaste algo en la source después de crear el PR, la punta se movió y el ledger no. El sha correcto ya viene impreso en el aviso que el hook dejó al crear el PR y en el bloqueo del Stop; si no lo tenés a mano, sale del ledger:
        ```bash
        node -e 'const fs=require("fs"),os=require("os"),p=require("path");const r=fs.realpathSync(process.argv[1]);const e=fs.readFileSync(p.join(os.homedir(),".claude/.tycon-pipeline/retro-pending.jsonl"),"utf8").split("\n").filter(Boolean).map(JSON.parse).filter(x=>!x.exento&&(()=>{try{return fs.realpathSync(x.repoPath)===r}catch{return false}})()).pop();if(!e){console.error("sin entrada en el ledger para "+r);process.exit(3)}console.log(e.sha)' <repo>
        ```
        Sale 3 = no hay entrada = **no hay deuda que pagar**: decilo en una línea y seguí. Nunca inventes un sha.
        Imprime la ruta del archivo; commitearlo con un título que empiece con `chore(retro ` — p. ej. `chore(retro 2.6): latido del merge` — y pushearlo. No es estilo: `retro-pending.js` exime de pedir OTRA retrospectiva sólo al push cuyos commits son **todos** de ese tipo; con cualquier otro título, subir la salida de una retro pide otra, y no se mezcla ese commit con otro cambio.
    (c) **El agente `tycon-retrospective-capturer` NO se lanza por default**: sólo si el dev lo pide con «retro con modelo» (correlaciones y propuestas al inbox). Medido: 87 lanzamientos en 30 días, 8,3 h y 12,5 M tokens para archivos casi todos en null. Lanzarlo tampoco paga la deuda del gate: la paga el archivo.
    (d) **Si el script no está en disco** (arnés atrasado): avisar «latido ausente: el merge queda pendiente de retrospectiva» y seguir con el cierre del skill — el aviso de arranque lo reclama cuando el arnés se actualice. Nunca abortar el merge por esto.

## Anti-patterns (lo que NO hace)

- ❌ NO promueve media entrega multi-repo en silencio: si un repo del grupo tiene commits que no están en el remoto, el HITL #1 lo muestra ANTES de pedir aprobación (step 0.6).
- ❌ NO usa `git merge` con fast-forward (`--ff`) — siempre `--no-ff` para preservar la historia del merge.
- ❌ NO saltea build+tests gate (los BLOQUEANTES: build + unit/vitest).
- ❌ NO pushea si hay tests rojos en los gates bloqueantes (la suite E2E completa no se lanza en el merge — ver 7b-2).
- ❌ NO deja al user esperando un proceso largo en foreground (E2E full, CI, deploys → background + notificación; regla anti-espera del 7b).
- ❌ NO resuelve conflicts automáticamente — paraliza y pide intervención manual. Única excepción, en el 9c: un choque **sólo** en `version.json` al traer el target (todo pedido cambia ese renglón) se resuelve tomando el del target, y el número se sube de nuevo.
- ❌ NO modifica `.gitignore`, `package.json`, ni ningún archivo del repo durante el merge (excepto los que vengan del source branch). Única excepción, en el 9c: el número de `version.json`, en un repo de GitHub que numera versiones.
- ❌ NO ejecuta `git push --force` ni nada que pueda reescribir historia.
- ❌ NO manda notificaciones a Telegram/Slack/email durante el flujo HITL normal. Excepción (2026-06-10): cuando un resultado ASYNC (E2E full / CI post-push) llega después de que el user siguió con otra cosa, avisar por el canal disponible (chat + Telegram si la espera fue larga).

## Terminación del skill

Termina exitosamente en Step 10. Termina anticipado (con código apropiado) en cualquiera de estos casos:

- Step 0: working tree dirty + usuario no quiere stashearlo
- Step 1: no hay commits para mergear (nothing to merge)
- Step 3: usuario cancela en HITL #1
- Step 5: target divergió (no fast-forward)
- Step 6: conflict no resuelto
- Step 7: tests fallan
- Step 8: usuario cancela el push (deja merge local)
- Step 9: race condition no resuelta tras retry

En todos los casos, el skill deja el repo en estado consistente — **nunca** queda merge a medio aplicar sin avisar.

## Referencias

- Convención de mensajes: `~/.claude/tycon-harness/guides/git-commit-conventions.md` (HEREDOC, Co-Authored-By trailer, etc.).
- Regla global pre-commit (engram sync): `~/.claude/CLAUDE.md`.
