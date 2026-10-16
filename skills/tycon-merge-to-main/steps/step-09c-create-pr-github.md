# Step 9c — Crear el pedido en GitHub, esperar su control y mergear (modo `pr`, repo en GitHub)

**Reemplaza al Step 9b** cuando el repo declara `merge.mode: pr` y su remoto `origin` es de GitHub. Llegás acá
desde el 9b (su derivación del remoto dice que no es de Azure DevOps) o directo desde el plan de abajo.

## Qué cambia respecto de Azure, y por qué

- **El servidor no siempre mergea solo.** En Azure el pedido se completa cuando sus controles dan verde. En GitHub eso
  depende del plan y de la configuración del repo, y un repo privado sin plan pago no lo tiene. Acá el skill **espera
  el control y mergea**: la aprobación humana ya ocurrió en los HITL.
- **Un pedido trae varios controles**: el de la corrida de la validación, uno por cada trabajo de esa corrida y los de
  otras herramientas. El que cuenta lo **declara el repo** en `.tycon/advisors.yaml → merge.check` (el nombre exacto);
  en un clon del repo público del arnés, que no trae ese archivo, vale el del clon de mantenimiento que declara la
  máquina (`paths.maintainers`), y el plan dice de cuál de los dos salió (`configFrom`).
  No se adivina, ni se espera «a que todos den verde», ni se toma el primero que aparezca.
- **Lo que se publica pasa por el freno antes de publicar**, que lee el `gh` que escribís en la terminal. Lee esta
  forma y ninguna otra: el `gh` **solo en su llamada**, el título **literal** y el cuerpo en un archivo **escrito
  antes, en otra llamada**, pasado con `--body-file`. Un título o un cuerpo armados por la terminal no salen.
- **El número de versión** —lo que una máquina instalada compara para saber si hay algo nuevo— existe si el repo numera
  versiones (`version.json` en la raíz de la rama destino). Si ese archivo trae `"numbering": "merge-tag"`, **el
  número lo pone el merge** (una etiqueta `v<número>` que GitHub le pone a cada merge) y el pedido no toca
  `version.json`. Sin esa marca, el número sube con cada pedido.
- **El commit de merge se titula «asunto (#N)»**: el asunto primero y el número del pedido al final.

Las partes mecánicas las hace un guion del arnés, `scripts/tools/merge-pr.js`. Cada orden imprime un JSON y sale con
su código; **leé el JSON, no lo supongas**. Sale 2 = no pudo leer algo: decilo con su motivo y pará.

En los bloques de abajo, lo que va entre `<` y `>` lo reemplazás por su valor **literal** antes de correr. Donde el
bloque lo trae entre **comillas simples** (el título, el asunto, las ramas, el repo), dejalas: adentro de comillas
simples la terminal no expande nada (ni `$(…)`, ni comillas invertidas, ni `$variable`), así que el texto llega a `gh`
tal cual lo aprobó el dev. Si el texto trae una comilla simple, se escribe `'\''` en su lugar. Con comillas dobles, un
asunto como «arregla `$(…)` en el lector» correría esa orden.

## Acciones

### 9c.1 — El plan

```bash
node "${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}/scripts/tools/merge-pr.js" plan --repo <repo> --source '<source>' --target '<target>' --keep-mode <mode del Step 0.7>
```

🔴 **Siempre con `--keep-mode`**: el modo quedó fijo en el Step 0.7. Si `suites` bajó a
`"machine"` (el paso 0 había dicho `server`): **volver al 7.2** y correr las suites completas en esta
máquina, sobre el merge de prueba del 7.0, antes de crear el pedido; con verde, seguir acá con la
línea `Tests:` nueva en el `bodyFile`.

Del JSON salen: `step` (tiene que decir `9c`; si dice `9b` o `9`, seguí ese paso y contá por qué: `notes`), `ghRepo`
(`<dueño/repo>`), `check` (el control a esperar: con `suites: "server"` y un pipeline de pruebas completas declarado en
`team-repos.json → merge_suites`, el declarado; si no, `merge.check` del repo), `canMerge`, `bodyFile` y `mergeBodyFile` (dónde escribir el cuerpo
del pedido y el del merge: en la carpeta temporal de la máquina, la misma para la terminal y para el freno, también en
Windows) y `version` (qué número subiría).

**Sin `merge.check` declarado** (`canMerge: false`): se hace hasta el 9c.7 inclusive —el pedido queda creado y su
latido corrido— y se termina diciéndolo: falta declarar `merge.check` en `.tycon/advisors.yaml`, con el nombre exacto del control de la
validación. El pedido **no se mergea**.

### 9c.2 — Poner la rama al día con la destino

```bash
node "${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}/scripts/tools/merge-pr.js" update-branch --repo <repo> --source '<source>' --target '<target>'
```

Trae `origin/<target>` y la mergea en la rama. Si ya estaba al día, no hace nada. Hace falta siempre: en un repo que
numera por pedido, todo pedido cambia el mismo renglón de `version.json`, así que una rama que no nació de la punta de
la destino choca; y una regla de rama puede exigir, además, que el pedido esté al día.

- **Sale 5 = hay conflictos en otros archivos.** El merge quedó deshecho y el JSON los nombra (`conflicts`). Resolver
  conflictos no es automático: se lo decís al dev y parás.
- 🔴 **La única resolución que se hace sola**: si el único archivo que choca es `version.json`, el guion toma el de la
  destino y cierra el merge (`resolved`). El número se vuelve a subir en el paso que sigue.

### 9c.3 — Subir la versión (sólo si el repo numera versiones)

```bash
node "${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}/scripts/tools/merge-pr.js" bump-version --repo <repo> --source '<source>' --target '<target>' --write
```

- `action: "none"` → no hay nada que commitear (el repo no numera versiones, el número lo pone el merge, o el número
  de la rama ya es mayor). `reason` dice cuál.
- `action: "bump"` → cambió **sólo** el valor de `version` en `version.json`. Commitealo nombrando la ruta, para no
  arrastrar nada que ya estuviera preparado:

```bash
git -C <repo> commit -m "chore(version): <número nuevo>" -- version.json
```

Es la **única** modificación que este skill le hace a un archivo del repo. La fecha del número sale del commit de la
punta de la rama, nunca del reloj, y nunca es anterior a la del número ya publicado: el número no baja.

### 9c.4 — Empujar la rama

```bash
git -C <repo> push origin '<source>'
```

Si falla por non-fast-forward (alguien empujó a esa rama desde otro lado) → **no** se hace `pull --rebase`: acá la
rama ya trae el merge de la destino, y un rebase lo desarma. Se dice, y el dev decide: traer lo que hay en el remoto de
la rama y volver al 9c.2, o parar.

### 9c.5 — Escribir el cuerpo del pedido

**En su propia llamada, y con la herramienta de escribir archivos** (no con una redirección de la terminal): el
mensaje aprobado en el Step 3, tal cual, en la ruta `bodyFile` del plan. El título del pedido es su primera línea.

### 9c.6 — Reusar el pedido abierto, o crearlo

¿Ya hay un pedido abierto para este par de ramas? (lectura)

```bash
gh pr list --repo '<dueño/repo>' --head '<source>' --base '<target>' --state open --json number,headRefOid,url
```

Con uno abierto → actualizarle el título y el cuerpo, **solo en su llamada**:

```bash
gh pr edit <n> --repo '<dueño/repo>' --title '<la primera línea del mensaje, literal>' --body-file '<bodyFile>'
```

Sin ninguno → crearlo, **solo en su llamada**:

```bash
gh pr create --repo '<dueño/repo>' --base '<target>' --head '<source>' --title '<la primera línea del mensaje, literal>' --body-file '<bodyFile>'
```

`--head` y `--base` van siempre: sin `--head`, `gh` puede preguntar a dónde empujar, y sin `--base` usa la rama por
defecto del repo. Si el freno antes de publicar frena el comando, dice **dónde** está el problema (nunca el texto):
se corrige el mensaje y se vuelve al 9c.5. No se busca otra forma de crearlo.

### 9c.7 — El latido de la retrospectiva, antes de esperar

Es la regla 10b de `SKILL.md`, y en este paso corre **acá**: la espera de abajo termina el turno, y el control de
cierre reclama la entrada que el `gh pr create` acaba de dejar. Va con **la punta que anotó el registro** (la de la
rama al crear el pedido), no con el commit de merge: en modo `pr` el registro empareja por esa punta.

```bash
node "${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}/scripts/metrics/retro-heartbeat.js" --repo <repo> --merge <la punta anotada> --story <id>
```

La punta anotada se saca como dice el 10b (del registro, no de `HEAD`). Sin entrada en el registro —un repo del
arnés, un pedido reusado que no nació en esta sesión— no hay deuda: decilo en una línea y seguí.

### 9c.8 — Esperar el control, en segundo plano

Sin `merge.check` (9c.1) no se espera nada: el paso termina acá, con el pedido creado y sin mergear.

```bash
node "${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}/scripts/tools/merge-pr.js" wait-checks --repo <repo> --pr <n> --head <la punta empujada> --target '<target>' --check '<check del plan del 9c.1>'
```

Con `--check` y el `check` del plan del 9c.1, tal cual: el control que se espera es el mismo que el plan dijo (el de
pruebas completas, si las suites las corre el servidor). Sin `--check`, el guion lo vuelve a calcular igual.

🔴 **En segundo plano**, con el mecanismo de la herramienta (regla anti-espera del 7b): una validación tarda decenas
de minutos. Avisá que el pedido queda esperando su control y cuánto suele tardar. `<la punta empujada>` es el commit
completo de la rama después del 9c.4 (`git -C <repo> rev-parse '<source>'`).

El guion pregunta cada 30 segundos y **nunca mergea**. Cómo termina, por su código:

| Código | Qué pasó | Qué sigue |
|---|---|---|
| 0 | el control declarado está en verde sobre esa punta, el pedido se puede mergear y su número de versión es mayor que el de la destino | 9c.9 |
| 1 | el control terminó y no es verde (el JSON trae su estado y su enlace) | no se mergea; el pedido queda abierto con el rojo a la vista. Reportarlo con el enlace |
| 2 | no se pudo preguntar (`gh` no contestó tres veces seguidas, o falta `merge.check`) | no se mergea; decir el motivo. «No pude preguntar» no es «está en verde» |
| 3 | el control no llegó o no terminó en el plazo (90 minutos) | no se mergea; mirar si la validación arrancó. Se puede volver a esperar |
| 4 | el pedido ya no está abierto | nada que mergear; decir cómo quedó |
| 5 | el pedido tiene conflictos con la destino | volver al 9c.2 |
| 6 | la punta del pedido se movió | lo validado no es lo que se iba a mergear: no se mergea. Alguien empujó a la rama después: decirlo; retomar (desde el 9c.2, con la punta nueva) lo decide el dev |
| 7 | la versión quedó atrás: entró otro pedido con ese número | volver al 9c.2 (trae la destino, sube de nuevo y valida de nuevo) |
| 8 | el pedido está en borrador | no se mergea; marcarlo listo es decisión del dev |
| 9 | el control está en verde, pero la rama quedó atrás de la destino o la regla de la rama no deja mergear | atrás: volver al 9c.2. Bloqueada: decir qué exige la regla |

Volver al 9c.2 **re-encola la validación** (hay commits nuevos): decirlo al proponerlo, para que no parezca que se
colgó. Con tandas en paralelo los merges quedan en fila, de a uno.

### 9c.9 — Mergear (sólo con código 0)

Primero, el texto del commit de merge:

```bash
node "${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}/scripts/tools/merge-pr.js" message --pr <n> --from '<bodyFile>' --to '<mergeBodyFile>'
```

Devuelve `subject` —«asunto (#N)», ya sin el prefijo `merge: a -> b — `— y deja en `mergeBodyFile` el cuerpo. A los
dos les saca toda marca que haga que una CI no corra (un merge con una de ésas deja la rama principal sin construir).

Después, el merge, **solo en su llamada** y enseguida (entre el verde y el merge no se hace otra cosa):

```bash
gh pr merge <n> --repo '<dueño/repo>' --merge --match-head-commit <la punta empujada> --subject '<subject, literal>' --body-file '<mergeBodyFile>'
```

🔴 **Siempre `--merge`: un commit de merge.** Nunca aplastado ni reordenado: los commits individuales desaparecerían de
la rama principal, y el tablero, los latidos de retrospectiva y las notas de versión identifican el trabajo por commit.
`--match-head-commit` ata el merge a la punta que se validó: si alguien empujó después, GitHub lo rechaza. Tampoco se
saltea la regla de la rama, ni se le pide a `gh` que borre la rama (borra también la local y cambia de rama el árbol
de trabajo).

Si `gh` rechaza el merge, decirlo **con su motivo** y parar: el pedido queda abierto y en verde.

### 9c.10 — Verificar, y cerrar

Releer el pedido (una lectura, no una suposición) para decir el commit de merge:

```bash
gh pr view <n> --repo '<dueño/repo>' --json state,mergeCommit,url
```

Traer la destino y comprobar que su número de versión subió respecto del merge anterior:

```bash
git -C <repo> fetch origin '<target>'
```

```bash
node "${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}/scripts/tools/merge-pr.js" check-version --repo <repo> --base 'origin/<target>^1' --head 'origin/<target>'
```

- Sale 0 → la versión subió, el repo no numera versiones, o el número lo pone el merge: en ese caso la etiqueta
  `v<número>` aparece sola en un minuto (`git ls-remote --tags origin 'v*'`) y no hay nada más que hacer.
- **Sale 1 → el número quedó igual al de antes**: entre el verde y el merge entró otro pedido con el mismo número. Las
  máquinas instaladas no van a ver este cambio hasta el próximo merge que suba el número. **Avisarlo**, no taparlo.

Si la rama **no** es de larga vida (la lista está declarada en el 9b, «Ramas de larga vida», y en ningún otro lado),
borrar la rama remota:

```bash
git -C <repo> push origin --delete '<source>'
```

Reportar:

```
✅ Pedido #<n> mergeado — <url>
   <source> → <target>, commit de merge <sha>, versión <número>.
```

Pasar al Step 10 (el latido ya corrió en el 9c.7: en el 10b no se repite).

## Edge cases

- **`gh` no está instalado o sin sesión** → NO abortar el trabajo hecho: la rama ya está empujada. Reportar el comando
  exacto para crear el pedido a mano y la dirección del repo.
- **La sesión se cierra antes de que el control termine** → el pedido queda abierto. Al volver a correr el skill, el
  9c.6 lo reusa y el 9c.8 vuelve a esperar: no se pierde nada.
- **El repo no declara `merge.mode: pr`** (un clon que no trae `.tycon/advisors.yaml`) → el plan dice `step: "9"`. Si
  la rama principal exige pedido, el empuje del Step 9 falla: no reintentar; decir que falta la configuración.
- **Un clon del repo público del arnés** (no trae `.tycon/advisors.yaml`) → el plan lee el modo y el control del clon
  de mantenimiento que declara la máquina (`configFrom: "maintainers"`). Si no los encuentra **sale 2** con lo que
  falta (por ejemplo, declarar `paths.maintainers`): parar con ese motivo. Nunca seguir por el Step 9.
- **El pedido se crea desde una copia ajena del repo** (`--head dueño:rama`) → este paso no lo cubre: la rama se
  empuja a `origin`.
- **Un `origin` que no es de GitHub ni de Azure DevOps** → el plan dice `step: "9"` y por qué: en ese servidor el
  skill no sabe crear pedidos.

## Output del step

```json
{
  "mode": "pr",
  "host": "github",
  "pr_number": 12,
  "pr_url": "https://...",
  "merged": true,
  "merge_commit": "<sha>",
  "version": "<número>",
  "reused_existing": false,
  "source_pushed_at": "<sha>"
}
```

Pasar al Step 10.
