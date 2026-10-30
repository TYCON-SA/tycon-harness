# Step 9b — Abrir el pedido de cambio con auto-completar (modo `pr`)

**Reemplaza al Step 9** cuando el plan dice modo `pr`. En vez de empujar la destino, se empuja la rama de origen y se
abre un pedido `source → target` que **entra solo** cuando su control da verde. La aprobación humana ya ocurrió en los
HITL de este skill: **no hay clics extra en la plataforma**.

El pedido lo abre la capa de plataforma del arnés, igual en Azure DevOps y en GitHub:

```
node "${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}/scripts/lib/platform/platform.js" change-request open --repo '<repo>' --auto-complete --args '@<argsFile>'
```

La capa elige el conector por la plataforma del repo y devuelve un JSON: `{ ok: true, value }` o
`{ ok: false, reason, detail }`. **Leé el JSON, no lo supongas.**

- **Azure DevOps**: la misma secuencia de `az repos pr` de siempre (reusa el pedido abierto de ese par de ramas o lo
  crea, fija el mensaje de merge «Merged PR N: asunto», prende el auto-completar sin aplastar y lo verifica releyendo
  el pedido). El modo es siempre `auto`: el servidor lo completa cuando sus políticas dan verde.
- **GitHub**: abre o actualiza el pedido y, si el repo permite el auto-merge, lo prende (modo `auto`). Si no lo
  permite, espera el control declarado y mergea con un commit de merge atado a la punta (modo `espera-y-mergea`).

## Por qué existe

Sin pedido no hay dónde colgar un control bloqueante del lado del servidor: cuando el servidor ve un empuje directo,
el commit ya está adentro. Tampoco queda rastro de aprobación fuera de la terminal de quien mergeó, ni árbitro entre dos
merges a la vez. Ver `~/.claude/tycon-harness/guides/ci-gate.md`.

🔴 **El mensaje rico que armó el Step 2 NO se pierde**: es el texto del pedido, y el commit de merge lo conserva.

🔴 **Nunca se aplasta ni se reordena.** Con squash o rebase, los commits individuales desaparecen de `main`: las notas
de versión de plugins y formularios (`scripts/release-notes.sh` lista los commits desde la versión publicada) colapsan a
una línea por pedido, y el tablero y los latidos de retrospectiva pierden el trabajo por commit. Los dos conectores
mergean siempre con commit de merge.

## Acciones

### 9b.1 — El plan

El modo lo fijó el Step 0.7 con `merge-pr.js plan` y no cambia acá. Sale de la regla de la organización en
`team-repos.json → merge_suites` (si las suites las corre el servidor, el modo es `pr`) y de lo que declara el repo en
`.tycon/advisors.yaml` (`merge.mode: pr`, la forma vieja, que sigue valiendo). El modo no se lee a mano del archivo: se
le pregunta al plan, que sabe de dónde sale. Casi siempre del repo; en un clon del repo público del arnés, que no trae
ese archivo, del clon de mantenimiento que declara la máquina (`paths.maintainers`). Acá se le vuelve a preguntar con
el modo del paso 0 fijo:

```bash
node "${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}/scripts/tools/merge-pr.js" plan --repo <repo> --source '<source>' --target '<target>' --keep-mode <mode del Step 0.7>
```

Del JSON:

- `mode` y `configFrom` (de dónde se leyó: `repo` o `maintainers`). Con `mode: "push"` **este step no corre**: sigue el
  Step 9. Si sale 2, no pudo leer la configuración (o es el clon del público y no la encontró): decí el motivo y pará,
  no es `push`.
- `step`: `9b` (Azure DevOps) o `9c` (GitHub) siguen los dos por este paso. Con `9`, el plan dice por qué en `notes`
  (un `origin` de otro servidor, una carpeta local, sin `origin`): seguí el Step 9.
- `suites`: 🔴 si bajó a `"machine"` (el paso 0 había dicho `server`), **volver al 7.2** y correr las suites completas
  en esta máquina, sobre el merge de prueba del 7.0, antes de abrir el pedido; con verde, seguí acá con la línea `Tests:`
  nueva en el mensaje.
- El repo: en Azure DevOps `org`, `project` y `name`; en GitHub `ghRepo` (`dueño/repo`). Salen del remoto `origin`,
  nunca del nombre de la carpeta: el nombre de la carpeta miente (un clon descartable se llama `scratch`).
- En GitHub, además: `check` (el control a esperar: con `suites: "server"` y un pipeline de pruebas completas declarado
  en `team-repos.json → merge_suites`, el declarado; si no, `merge.check` del repo), `canMerge` y `version` (qué número
  subiría).
- `bodyFile`: la ruta del cuerpo en la carpeta temporal de la máquina, la misma para la terminal y para Node, también en
  Windows.

**GitHub sin `merge.check` declarado** (`canMerge: false`): el pedido **no se abre**. La capa abre siempre para entrar
sola, y sin el control declarado esperaría a todos los controles, que es elegir uno por cuenta propia. Decí que falta
declarar `merge.check` en `.tycon/advisors.yaml`, con el nombre exacto del control de la validación, y pará.

**Red por si alguien prende la política sin declarar el modo**: si el Step 9 falla porque la rama exige pedido, NO
abortes: ofrecé este paso al dev («este repo ya exige pedido; ¿lo abro con el mensaje que aprobaste?»).

### 9b.2 — Poner la rama al día y subir la versión (sólo GitHub)

En Azure DevOps este punto no aplica: seguí en el 9b.3.

En GitHub, una rama que no nació de la punta de la destino choca (en un repo que numera por pedido, todo pedido cambia
el mismo renglón de `version.json`), y una regla de rama puede exigir que el pedido esté al día:

```bash
node "${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}/scripts/tools/merge-pr.js" update-branch --repo <repo> --source '<source>' --target '<target>'
```

- **Sale 5 = hay conflictos en otros archivos.** El merge quedó deshecho y el JSON los nombra (`conflicts`). Resolver
  conflictos no es automático: decíselo al dev y pará.
- 🔴 **La única resolución que se hace sola**: si el único archivo que choca es `version.json`, el guion toma el de la
  destino y cierra el merge (`resolved`). El número se vuelve a subir enseguida.

Después, el número de versión (lo que una máquina instalada compara para saber si hay algo nuevo):

```bash
node "${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}/scripts/tools/merge-pr.js" bump-version --repo <repo> --source '<source>' --target '<target>' --write
```

- `action: "none"` → nada que commitear (el repo no numera versiones, el número lo pone el merge con
  `"numbering": "merge-tag"`, o el número de la rama ya es mayor). `reason` dice cuál.
- `action: "bump"` → cambió **sólo** el valor de `version` en `version.json`. Commitealo nombrando la ruta, para no
  arrastrar nada que ya estuviera preparado:

```bash
git -C <repo> commit -m "chore(version): <número nuevo>" -- version.json
```

Es la **única** modificación que este skill le hace a un archivo del repo. La fecha del número sale del commit de la
punta de la rama, nunca del reloj, y el número no baja.

### 9b.3 — Empujar la rama de origen

En modo `pr` **no hubo merge local** (los Steps 5 y 6 se saltearon): viaja la rama de origen.

```bash
git -C <repo> push origin '<source>'
```

Si falla por non-fast-forward: en Azure DevOps, el mismo tratamiento que el Step 9.2 (traer y un reintento). En
GitHub **no** se hace `pull --rebase`: la rama ya trae el merge de la destino del 9b.2, y un rebase lo desarma. Se dice,
y el dev decide: traer lo que hay en el remoto de la rama y volver al 9b.2, o parar.

### 9b.4 — Escribir los argumentos del pedido

**En su propia llamada, y con la herramienta de escribir archivos** (no con una redirección de la terminal). Va en
`<argsFile>`: la ruta `bodyFile` del plan, cambiando el final `.md` por `.json`. Un JSON con:

- `sourceBranch` y `targetBranch`: las ramas, tal cual;
- `text`: el mensaje aprobado en el Step 3, tal cual. Su primera línea es el título del pedido y el asunto del merge;
- `deleteSourceBranch`: `false` si la rama de origen es de larga vida, `true` si no (ver abajo);
- en GitHub, `check`: el `check` del plan del 9b.1.

#### Ramas de larga vida — las únicas que NO se borran al completar

🔴 **Declaradas acá y en NINGÚN otro lugar del skill:** `dev`, `develop`, `main` y `master`. Con el flujo de pedidos,
las demás ramas de origen son efímeras (`story/N.M`, `fix/<slug>`, `chore/<slug>`, `retro/<repo>-<sha>`): si no se
borran, quedan vivas después del merge. Editar esta lista es lo único que hay que tocar para sumar o sacar una rama de
larga vida. `master` entra por ser de la misma clase que `main`: tenerla de más no cuesta nada.

En Azure DevOps la rama la borra el servidor al completar. El conector de GitHub nunca borra la rama: se borra en el
9b.7.

### 9b.5 — Abrir el pedido, en segundo plano

El repo va en una línea, literal, con lo que dio el plan:

- Azure DevOps: `{"platform":"azure","org":"<org>","project":"<project>","repo":"<name>"}`;
- GitHub: `{"platform":"github","org":"<dueño>","repo":"<repo>"}`.

```bash
node "${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}/scripts/lib/platform/platform.js" change-request open --repo '<repo en JSON>' --auto-complete --args '@<argsFile>'
```

🔴 **Solo en su llamada y en segundo plano**, con el mecanismo de la herramienta (regla anti-espera del 7b): en GitHub
sin auto-merge el conector espera el control, y una validación tarda decenas de minutos. Avisá que el pedido queda
esperando su control. El tope de la espera es de 30 minutos (`--wait-minutes <n>` lo cambia); en Azure DevOps la
llamada vuelve enseguida.

`--auto-complete` va siempre en la línea: sin él la capa no abre, y los frenos lo leen ahí. Los frenos de antes de
publicar miran esta línea igual que un `az repos pr create` o un `gh pr create`: uno por repo con el control de otro
pedido corriendo, la retrospectiva pendiente al apuntar a `main`. En GitHub, el conector pasa además el título y el
texto por el freno de publicación antes de abrir: si frena, devuelve `rechazado` y dice dónde está el problema, nunca
el texto. Se corrige el mensaje y se vuelve al 9b.4. No se busca otra forma de abrirlo.

### 9b.6 — El latido de la retrospectiva, mientras espera

Es la regla 10b de `SKILL.md`, y en este paso corre **acá**: la espera puede terminar el turno, y el control de cierre
reclama la entrada que la llamada del 9b.5 acaba de dejar. Va con **la punta que anotó el registro** (la de la rama al
abrir el pedido), no con el commit de merge: en modo `pr` el registro empareja por esa punta.

```bash
node "${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}/scripts/metrics/retro-heartbeat.js" --repo <repo> --merge <la punta anotada> --story <id>
```

La punta anotada se saca como dice el 10b (del registro, no de `HEAD`). Sin entrada en el registro —un repo del arnés,
un pedido reusado que no nació en esta sesión— no hay deuda: decilo en una línea y seguí.

### 9b.7 — Leer el resultado

Con `ok: true`, el valor trae `id`, `url`, `modo`, `reused` (el pedido ya estaba abierto y se actualizó), `merged` y
`warnings`. Cada aviso de `warnings` se dice en una línea (por ejemplo, el mensaje de merge que la plataforma no guardó).
`conflict: true` es un pedido abierto que choca con la destino: ver «Conflictos», abajo.

| Resultado | Qué pasó | Qué sigue |
|---|---|---|
| `modo: auto` | el pedido entra solo cuando su control da verde | reportar y NO esperar: pasar al Step 10 |
| `modo: espera-y-mergea`, `merged: true` | GitHub: el control dio verde y el conector mergeó atado a la punta | verificar la versión y borrar la rama (abajo) |
| `rechazado` | un control terminó en rojo, un conflicto, un merge que la plataforma rechazó, el freno de publicación, o un pedido que no se pudo abrir (ya hay uno de esa rama, no hay commits de diferencia) | no entra. `detail` dice la causa y, si el pedido quedó abierto, su número y su dirección: reportarlo con el enlace |
| `no_medido` | el control no terminó en el tope | el pedido queda abierto. Volver a correr el 9b.5 lo reusa y vuelve a esperar: no se pierde nada |
| `sin_credencial` | la plataforma no aceptó la credencial (401 o 403) | decir el motivo y el comando para entrar (`az login` o `gh auth login`); la rama ya está empujada |
| `red` | la red se cayó, también después de abrir | volver a correr el 9b.5: reusa el pedido si quedó abierto |
| `sin_plataforma` | la capa no sabe la plataforma del repo, o falta su herramienta | decir el motivo; la rama ya está empujada y el pedido se puede abrir a mano |

Un «no pude preguntar» nunca es «está en verde».

**Con `modo: auto`, reportar sin esperar:**

```
✅ Pedido #<id> abierto — <url>
   <source> → <target>, auto-completar ON.
   Entra solo cuando el control dé verde. No hace falta que aprueben nada a mano.
```

**Con `merged: true` (GitHub)**, traer la destino y comprobar que su número de versión subió:

```bash
git -C <repo> fetch origin '<target>'
```

```bash
node "${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}/scripts/tools/merge-pr.js" check-version --repo <repo> --base 'origin/<target>^1' --head 'origin/<target>'
```

- Sale 0 → la versión subió, el repo no numera versiones, o el número lo pone el merge: en ese caso la etiqueta
  `v<número>` aparece sola en un minuto (`git ls-remote --tags origin 'v*'`).
- **Sale 1 → el número quedó igual al de antes**: entre el verde y el merge entró otro pedido con el mismo número. Las
  máquinas instaladas no van a ver este cambio hasta el próximo merge que suba el número. **Avisarlo**, no taparlo.

Si `deleteSourceBranch` era `true`, borrar la rama remota:

```bash
git -C <repo> push origin --delete '<source>'
```

En GitHub con `modo: auto` la rama queda viva hasta que alguien la borre, salvo que el repo borre solo las ramas
mergeadas: decirlo en una línea.

## Edge cases

- **`az` o `gh` no está instalado o sin sesión** → NO abortar el trabajo hecho: la rama ya está empujada. Reportar el
  motivo de la capa y la dirección del repo para abrir el pedido a mano.
- **La política exige un mínimo de revisores** (Azure DevOps) → el auto-completar espera un voto que nadie va a dar. El
  pedido queda abierto con la política en rojo: o se saca el mínimo de la política, o alguien vota.
- 🔴 **Conflictos con la destino** (`conflict: true`, o `rechazado` por conflicto) → el auto-completar no completa
  nunca y el pedido queda abierto sin nada en rojo: el modo de falla silencioso. Resolver conflictos no es automático:
  el skill lo propone y el dev decide. En Azure DevOps:

  ```bash
  git -C <repo> checkout '<source>'
  git -C <repo> fetch origin '<target>'
  git -C <repo> merge 'origin/<target>'
  git -C <repo> push origin '<source>'
  ```

  En GitHub, volver al 9b.2. 🔴 El empuje a la rama **re-encola la validación**: decirlo al proponerlo, para que no
  parezca que se colgó. Volver a correr el 9b.5 relee el pedido (`reused: true`).
- **La sesión se cierra antes de que el control termine** → el pedido queda abierto. Al volver a correr el skill, el
  9b.5 lo reusa y vuelve a esperar.
- **Un clon del repo público del arnés** (no trae `.tycon/advisors.yaml`) → el plan lee el modo y el control del clon de
  mantenimiento (`configFrom: "maintainers"`). Si no los encuentra **sale 2** con lo que falta (por ejemplo, declarar
  `paths.maintainers`): parar con ese motivo. Nunca seguir por el Step 9.
- **Un `origin` que no es de Azure DevOps ni de GitHub** → el plan dice `step: "9"` y por qué: en ese servidor el skill
  no sabe abrir pedidos.

## Output del step

```json
{
  "mode": "pr",
  "platform": "azure | github",
  "pr_id": 123,
  "pr_url": "https://...",
  "modo": "auto | espera-y-mergea",
  "merged": false,
  "reused_existing": false,
  "source_pushed_at": "<sha>"
}
```

Pasar al Step 10 (el latido ya corrió en el 9b.6: en el 10b no se repite).
