# Step 9b — Crear el Pull Request (modo `pr`)

**Reemplaza al Step 9** cuando el repo declara `merge.mode: pr`. En vez de pushear el target,
se pushea la source branch y se crea un PR `source → target` con **auto-complete**: el PR se
completa solo cuando TODAS las policies dan verde (build validation con los tests, portón de
controles). La aprobación humana ya ocurrió en los HITL de este skill — **no hay clicks extra
en Azure DevOps**.

Este step es el de un repo cuyo remoto es de **Azure DevOps**. Con un remoto de GitHub el camino
es **step-09c-create-pr-github.md**: allá el skill espera el control y mergea.

## Por qué existe

Hasta 2026-08-30 el equipo pusheaba DIRECTO a `main`. Sin PR no hay dónde colgar un control
bloqueante del lado del servidor: cuando el servidor ve el commit, ya está adentro — sólo queda
detección posterior. Tampoco queda rastro de aprobación fuera de la terminal de quien mergeó, ni
árbitro entre dos merges concurrentes (el equipo es multi-persona). Ver
`~/.claude/tycon-harness/guides/ci-gate.md`.

🔴 **El mensaje rico que armó el Step 2 NO se pierde**: pasa a ser la descripción del PR, y el
merge commit que ADO crea al completarlo lo conserva. Es el mismo valor central del skill.

## Precondición: el modo sale del plan del paso 0, no se adivina

El modo lo fijó el Step 0.7 con `merge-pr.js plan` y no cambia acá. Sale de dos cosas:
la regla de la organización en `team-repos.json → merge_suites` (si las suites las corre el
servidor, el modo es `pr`) y lo que el repo declara (la forma vieja, que sigue valiendo):

```bash
# En el repo: .tycon/advisors.yaml
merge:
  mode: pr            # `push` (default, comportamiento histórico) | `pr`
```

El modo no se lee a mano del archivo: se le pregunta al plan del arnés, que sabe de dónde sale. Casi
siempre del repo; en un clon del repo público del arnés, que no trae ese archivo, del clon de
mantenimiento que declara la máquina (`paths.maintainers`). Acá se le vuelve a preguntar con el modo
del paso 0 fijo (sin dependencias):

```bash
node "${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}/scripts/tools/merge-pr.js" plan --repo <repo> --source '<source>' --target '<target>' --keep-mode <mode del Step 0.7>
```

Del JSON: `mode`, `configFrom` (de dónde se leyó: `repo` o `maintainers`) y `suites`. Con
`mode: "push"` **este step no corre** y el flujo sigue por el Step 9 de siempre. 🔴 Si `suites` bajó
a `"machine"` (el paso 0 había dicho `server`): **volver al 7.2** y correr las suites completas en
esta máquina, sobre el merge de prueba del 7.0, antes de crear el pedido; con verde, seguir acá con
la línea `Tests:` nueva en la descripción. Si sale 2, no pudo leer la configuración (o es el clon
del público y no la encontró): decir el motivo y parar — no es `push`.

**Red por si alguien prende la policy sin declarar el modo**: si el Step 9 falla por branch
protection, NO abortar como antes — ofrecer este step al dev ("este repo ya exige PR; ¿lo creo
con el mensaje que aprobaste?"). Un repo protegido cuya herramienta no sabe crear PRs deja al
equipo sin camino, y ese es el modo de falla que hay que evitar.

## De dónde salen `<org>`, `<proj>`, `<repo-name>` y si la rama se borra

🔴 **No se leen a ojo ni del nombre de la carpeta: se DERIVAN del remoto `origin`.** El nombre de la
carpeta miente (un clon descartable se llama `as`, `tcg-rota`, `scratch`), y escribirlos a mano es
cómo se termina apuntando `az` al proyecto equivocado — el mismo error que ya costó dar por vacía la
lista de pull requests de un repo que sí tenía uno (`Acme` contra `Acme Logistica`).

El parser vive en el arnés y ya entiende las tres formas de remoto que usa el equipo
(`dev.azure.com/<org>/<proj>/_git/<repo>`, la vieja `<org>.visualstudio.com/<proj>/_git/<repo>` y la
de SSH):

```bash
ARNES="${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}"
# 🔴 Se LEE con `read`, nunca con `eval`: la URL del remoto es texto de afuera.
{ read -r ORG; read -r PROJ; read -r REPO_NAME; } < <(node -e '
  // el lector del arnés por su nombre de hoy; con un arnés un pull atrás, por el de antes
  const lib = ["harness-repo.js", "repo-del-arnes.js"].map((n) => process.argv[1] + "/scripts/lib/" + n).find((p) => require("fs").existsSync(p));
  if (!lib) { console.error("no encuentro scripts/lib/harness-repo.js en el arnés: " + process.argv[1]); process.exit(3); }
  const { identidadAzure } = require(lib);
  const { execFileSync } = require("child_process");
  const url = execFileSync("git", ["-C", process.argv[2], "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  const id = identidadAzure(url);
  if (!id) { console.error("el remoto no es de Azure DevOps: " + url); process.exit(3); }
  console.log(id.org); console.log(id.proyecto); console.log(id.nombre);
' "$ARNES" "<repo>") || { echo "no pude derivar org/proyecto/repo del remoto"; exit 3; }
ORG_URL="https://dev.azure.com/$ORG"
```

- **Sale 3 = el remoto no es de Azure DevOps** ⇒ este step no aplica. Qué paso sigue lo dice el
  remoto, no una suposición: `node "$ARNES/scripts/tools/merge-pr.js" plan --repo <repo> --source
  <source> --target <target>` imprime `step`. Con un remoto de **GitHub** dice `9c` → seguir por
  **step-09c-create-pr-github.md** (crea el pedido en GitHub, espera el control declarado y
  mergea). Con cualquier otro dice `9` y por qué → avisar y usar el Step 9. Nunca inventar los
  valores.
- **Si el arnés no está en disco**, el `node` falla: decirlo y pedir los tres valores, no adivinarlos.
- `org` y `proyecto` vuelven en minúsculas y el repo con su caja real. **Medido el 2026-09-17**:
  `az repos pr list --project totora --repository backend` contesta igual que con `Totora`/`Backend`
  (devuelve los nombres con su caja). El `--repository` va con la caja real de todos modos.

### Ramas de larga vida — las únicas que NO se borran al completar

🔴 **Declarada acá y en NINGÚN otro lugar del skill.** Hasta 2026-09-17 el `--delete-source-branch`
era `false` fijo, con la justificación «`dev` es una rama de larga vida del equipo». Era cierta para
`dev` y falsa para todo lo demás: con el flujo de pull request las sources son **efímeras**
(`story/N.M`, `fix/<slug>`, `chore/<slug>`, `retro/<repo>-<sha>`) y quedaban vivas después del merge
— medido en el repo del arnés, **3 ramas `story/*` ya mergeadas seguían ahí**.

```bash
# Editar ESTA línea es lo único que hay que tocar para sumar o sacar una rama de larga vida.
RAMAS_DE_LARGA_VIDA="dev develop main master"
case " $RAMAS_DE_LARGA_VIDA " in
  *" $SOURCE "*) BORRAR_SOURCE=false ;;   # `dev → main`: dev sigue viva después del merge
  *)             BORRAR_SOURCE=true  ;;   # rama efímera: la borra ADO al completar
esac
```

`master` entra por ser de la misma clase que `main`, aunque hoy ningún repo del equipo la use como
source: el costo de tenerla de más es cero y el de que falte es una rama de larga vida borrada.

`$BORRAR_SOURCE` es lo que va en **los tres** `--delete-source-branch` de este step (el update de
9b.2, el create de 9b.3 y el update que le sigue). Que sean tres y no uno es de `az`, no una
elección: el create no siempre manda las opciones de completado (ver el hallazgo de 9b.3).

## Acciones

### 9b.1 — Pushear la source branch

En modo `pr` **no hubo merge local** (los Steps 5 y 6 se saltearon): lo que viaja es la rama
source tal cual.

```bash
git -C <repo> push origin <source>
```

Si falla por non-fast-forward → mismo tratamiento que el Step 9.2 (pull --rebase, un reintento).

### 9b.2 — ¿Ya hay un PR abierto para este par de ramas?

**Antes de nada: chequear `az`** (`command -v az`). Si falta, ir directo al edge case "az no
está instalado" — este chequeo va acá porque 9b.2 es el primer comando `az` del step y sin él
fallaba ANTES de llegar al mensaje de rescate.

Crear un segundo PR para el mismo par ensucia y confunde. Reusar si existe:

```bash
az repos pr list --org "$ORG_URL" --project "$PROJ" --repository "$REPO_NAME" \
  --source-branch <source> --target-branch <target> --status active -o json
```

Con uno activo → **actualizar título, descripción y mensaje de merge, Y re-armar el auto-complete**
(el mensaje se arma igual que en 9b.3 — ver «El mensaje de merge»):

```bash
az repos pr update --id <id> \
  --title "$(head -1 /tmp/pr-body.md)" \
  --description "$(cat /tmp/pr-body.md)" \
  --merge-commit-message "Merged PR <id>: $ASUNTO" \
  --auto-complete true --squash false --delete-source-branch "$BORRAR_SOURCE" -o json
```

🔴 El `--auto-complete true` en el update NO es opcional: un
PR activo creado a mano —o cuyo auto-complete alguien apagó— no lo tiene, y 9b.4 reportaría
"se completa solo" sobre un PR que va a quedar abierto para siempre. Después seguir en 9b.4.
Sin ninguno → 9b.3.

### 9b.3 — Crear el PR con auto-complete

El mensaje del Step 2 va como descripción. El título es su primera línea.

```bash
# El cuerpo por archivo: un mensaje largo en la línea de comandos se rompe con comillas y saltos.
printf '%s' "$MENSAJE" > /tmp/pr-body.md

az repos pr create \
  --org "$ORG_URL" --project "$PROJ" --repository "$REPO_NAME" \
  --source-branch <source> --target-branch <target> \
  --title "$(head -1 /tmp/pr-body.md)" \
  --description "$(cat /tmp/pr-body.md)" \
  --auto-complete true \
  --delete-source-branch "$BORRAR_SOURCE" \
  --squash false \
  -o json > /tmp/pr-created.json
PR_ID=$(python3 -c 'import json;print(json.load(open("/tmp/pr-created.json"))["pullRequestId"])')
```

**Enseguida, fijar el mensaje de merge** (el número del PR recién existe ahora — por eso no va en el
create). Las cuatro opciones van juntas en el mismo update:

```bash
az repos pr update --id "$PR_ID" \
  --merge-commit-message "Merged PR $PR_ID: $ASUNTO" \
  --auto-complete true --squash false --delete-source-branch "$BORRAR_SOURCE" -o json
```

#### El mensaje de merge — por qué y cómo

**Por qué.** Cuando Azure completa solo un PR y nadie fijó mensaje, el merge que llega a `main` se
llama «Merge pull request N from dev into main», y así se titula la corrida de `main`: no dice qué
trae. La pantalla de Azure propone «Merged PR N: título»; el skill ahora fija ese formato, que además
es el que filtran las notas de versión.

**Cómo se arma `$ASUNTO`** (una sola línea):
1. la primera línea del mensaje del Step 2 (el título del PR);
2. sin el prefijo `merge: <source> -> <target> — ` si lo trae (con el prefijo «Merged PR N: » serían 37
   caracteres repetidos antes del contenido);
3. sin ningún marcador de salteo de CI, sin distinguir mayúsculas: `[skip ci]`, `[ci skip]`,
   `skip-checks: true`, `skip-checks:true`, `[skip azurepipelines]`, `[azurepipelines skip]`,
   `[skip azpipelines]`, `[azpipelines skip]`, `[skip azp]`, `[azp skip]`, `***NO_CI***`. Un merge con
   uno de esos deja a `main` **sin construir**.

```bash
# python3 y no sed: el flag de mayúsculas de sed no es igual en macOS y en Linux.
ASUNTO=$(python3 - /tmp/pr-body.md <<'PY'
import re, sys
l = open(sys.argv[1], encoding="utf-8").read().split("\n", 1)[0]
l = re.sub(r"^merge: \S+ -> \S+ — ", "", l)
l = re.sub(r"\[(skip ci|ci skip|skip azurepipelines|azurepipelines skip|skip azpipelines|azpipelines skip|skip azp|azp skip)\]", "", l, flags=re.I)
l = re.sub(r"skip-checks: ?true", "", l, flags=re.I)
l = re.sub(r"\*\*\*NO_CI\*\*\*", "", l, flags=re.I)
print(re.sub(r" {2,}", " ", l).strip())
PY
)
```

**Si el update del mensaje falla** → **no abortar**: el PR ya está creado con auto-complete y se va a
completar igual. Reportar en una línea que quedó **sin mensaje de merge** (la corrida de `main` va a
decir «Merge pull request N») con el comando exacto para reintentarlo, y seguir a 9b.4.

**Evidencia (un pull request de prueba, 2026-09-15**, repo del arnés, ramas descartables que chocaban para
que no pudiera completarse; abandonado y borradas): con sólo el mensaje, y con las cuatro opciones
juntas, el auto-complete siguió puesto y `mergeStrategy` quedó `noFastForward`. `az` hace un GET del
PR y reenvía las opciones que conoce; `mergeStrategy`, que `az` no modela, igual sobrevive en el
servidor. Se mandan las cuatro juntas para no depender de cómo combina el servidor un envío parcial.

**Evidencia de las ramas efímeras (medida con un pull request de prueba**, abandonado en el acto y con la rama borrada): con
`$BORRAR_SOURCE` en `true`, `az repos pr show` devolvió `autoCompleteSetBy` con el usuario,
`completionOptions.mergeStrategy: noFastForward` y **`completionOptions.deleteSourceBranch: true`**
—donde antes iba `false`— y el mensaje de merge fijado. Dato suelto: `completionOptions.squashMerge`
vino **`null`** y no `false`; lo que sostiene el no-squash es `mergeStrategy: noFastForward`, que es
lo que hay que mirar.

🔴 **Hallazgo de esa prueba — el `--squash false` del create NO viajaba.** `az` 1.0.2 sólo manda
`completionOptions` al crear si alguna opción es verdadera o hay mensaje (`pull_request.py:223-228`):
tras el create de arriba, el pull request de prueba tenía `completionOptions: null`. El no-squash salía **de
casualidad**, porque el servidor pone `noFastForward` por defecto. El update con el mensaje es el que
ahora sí manda `squashMerge: false` explícito.

🔴 **`--squash false` es OBLIGATORIO y no es preferencia de estilo.** Con squash, los commits
individuales desaparecen de `main` y las **notas de versión de plugins y forms se rompen**:
`scripts/release-notes.sh` las arma listando los commits desde la versión publicada
(`git log ... --no-merges`), así que con squash cada release colapsa a una línea
"Merged PR N: título" y la granularidad se pierde **para siempre**. Lo mismo hay que fijar del lado de la policy de la rama.

`--delete-source-branch` ya NO es `false` fijo: sale de `$BORRAR_SOURCE` (ver «Ramas de larga vida»
arriba). La justificación vieja —«`dev` es una rama de larga vida del equipo»— valía para `dev` y para
ninguna otra source.

### 9b.4 — Reportar y NO esperar

**Antes de decir «auto-complete ON», verificarlo** (una lectura, no una suposición):

```bash
az repos pr show --id "$PR_ID" --query "{ac:autoCompleteSetBy.id, msg:completionOptions.mergeCommitMessage}" -o json
```

Sólo si `ac` trae un id **y** `msg` es el mensaje armado se reporta como abajo. Si falta cualquiera de
los dos, se dice cuál («auto-complete apagado» / «sin mensaje de merge») con el comando para arreglarlo.

El PR queda con auto-complete: se completa solo cuando las policies pasan. **No bloquear al dev
mirando el pipeline** (regla anti-espera del 7b):

```
✅ PR #<id> creado — <url>
   <source> → <target>, auto-complete ON.
   Se completa solo cuando el pipeline dé verde. No hace falta que aprueben nada a mano.
```

Si la sesión fue larga, avisar por Telegram cuando se complete (ver 9b.5). Pasar al Step 10.

### 9b.5 — Seguimiento (opcional, en background)

Si el dev quiere saber cómo terminó sin quedarse mirando:

```bash
az repos pr show --org "$ORG_URL" --project "$PROJ" --id <id> --query 'status' -o tsv
# active | completed | abandoned
```

Lanzarlo en background con un watcher; **nunca** en foreground.

## Edge cases

- **`az` no está instalado o sin login** → NO abortar el trabajo hecho: la rama ya está pusheada.
  Reportar el comando exacto para crear el PR a mano y la URL del repo. El merge no se pierde.
- **La policy exige un mínimo de revisores** → el auto-complete espera un voto que nadie va a dar.
  Detectarlo (el PR queda `active` con la policy en rojo) y avisar: o se saca el mínimo de la
  policy, o alguien vota. Para el piloto la policy va **sin mínimo de revisores** a propósito.
- **El PR se crea pero el pipeline falla** → el PR queda abierto con el rojo a la vista. Es el
  comportamiento buscado: el cambio NO entra. Reportarlo con el link al build.
- 🔴 **El PR tiene CONFLICTOS con el target** → el auto-complete **no completa nunca** y el PR queda
  `active` para siempre. No se ve como una falla: no hay build en rojo, no hay revisor esperando, y
  el skill ya reportó «se completa solo». Hasta 2026-09-17 este step sólo decía «queda abierto».

  **Cómo se detecta** (una lectura, no una suposición): `mergeStatus` del PR.

  ```bash
  az repos pr show --org "$ORG_URL" --project "$PROJ" --id "$PR_ID" \
    --query "{estado:status, merge:mergeStatus, ac:autoCompleteSetBy.id}" -o json
  ```

  `mergeStatus: conflicts` ⇒ hay que rebasar la source. **Medido, no citado de la documentación**
  (un pull request de prueba entre dos ramas descartables que chocaban a
  propósito y sin tocar `main`; abandonado y borradas): con el auto-complete puesto
  (`autoCompleteSetBy` con el id) el PR se quedó `active` con `mergeStatus: conflicts`, que es
  exactamente el modo de falla silencioso — nada rojo, nadie esperando, y el skill ya dijo «se
  completa solo».

  🔴 **No alcanza con mirar que el PR siga `active`**: medido el mismo día sobre los 200 pull
  requests más recientes de la organización, `mergeStatus` dice `succeeded` en **187** y en los
  otros 13 el campo **no viene** — o sea que «sigue abierto» y «no puede mergear» son cosas
  distintas, y un PR trabado por otra razón (un build que nunca terminó) también se ve `active`.

  **Qué proponer** — el skill NO lo hace solo (resolver conflictos no es automático, es el
  anti-pattern de siempre); lo propone y el dev decide:

  ```bash
  git -C <repo> checkout <source>
  git -C <repo> fetch origin <target>
  git -C <repo> merge origin/<target>      # si hay conflictos, los resuelve el dev
  git -C <repo> push origin <source>
  ```

  **Cómo se verifica que se destrabó** (releer, no suponer — un push con éxito no dice que ADO ya
  recalculó la mezcla):

  ```bash
  az repos pr show --org "$ORG_URL" --project "$PROJ" --id "$PR_ID" --query 'mergeStatus' -o tsv
  # queued → todavía está calculando: volver a mirar en unos segundos
  # succeeded → destrabado; el auto-complete sigue puesto y completa cuando las policies den verde
  # conflicts → siguen los conflictos: el merge de arriba no los resolvió
  ```

  🔴 **El push a la source RE-ENCOLA la validación** si la policy tiene `queueOnSourceUpdateOnly`
  (es el caso del plan): el PR vuelve a esperar el pipeline entero. Es el precio de destrabarlo, y
  hay que decirlo al proponerlo para que no parezca que se colgó.
- **Repo sin remoto en Azure DevOps** → este step no aplica. Con remoto de GitHub, el pedido se
  crea por **step-09c-create-pr-github.md**; con otro, avisar y usar el Step 9 (ver «Sale 3», más
  arriba). La detección de `org`/`project`/`repo-name` sale de `git remote get-url origin`.

## Output del step

```json
{
  "mode": "pr",
  "pr_id": 123,
  "pr_url": "https://...",
  "auto_complete": true,
  "reused_existing": false,
  "source_pushed_at": "<sha>"
}
```

Pasar al Step 10.
