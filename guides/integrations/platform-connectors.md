# Conectores de plataforma — cómo sumar una plataforma al arnés

El núcleo del arnés no habla con Azure DevOps, con GitHub ni con GitLab: habla con **la plataforma del equipo**, por una
capa (`scripts/lib/platform/platform.js`) que elige qué conector atiende cada operación y le pasa el pedido. Esta guía es
para quien quiere sumar otra plataforma: qué tiene que atender el conector, qué tiene que contestar y cómo se prueba que
cumple.

Los tres conectores que trae el arnés sirven de ejemplo vivo: `integrations/azure-devops/`, `integrations/github/` e
`integrations/gitlab/`. El caso de cada uno, para quien lo usa, está en `guides/integrations/ado-projects.md`, en
`guides/integrations/github-platform.md` y en `guides/integrations/gitlab-platform.md`.

---

## Qué es un conector

Una carpeta en `integrations/<nombre>/` con:

| Archivo | Para qué |
|---|---|
| `integration.json` | el manifiesto: qué operaciones atiende, qué puede, qué comandos crudos de su plataforma reconocen los frenos |
| `scripts/connector.js` | el código: exporta `run(operación, args, ctx)` y contesta dentro del contrato |
| `rules.md` (opcional) | las reglas de la plataforma que el agente tiene que saber cuando la usa |
| `notices.json` (opcional) | cuándo se le muestran esas reglas: la primera vez que usa la CLI de la plataforma en una sesión |

El núcleo nunca llama a un conector ni a su CLI directamente: los guiones, los ganchos y los pasos del agente llaman a la
capa, y la capa llama al conector que eligió la organización.

## Quién elige el conector

- Lo atado a un repo (los pedidos de cambio y la CI) va por la plataforma que ese repo declara en `team-repos.json`.
- Lo demás lo elige el perfil del equipo, `integrations.platform`: por área (`workItems`, `queue`) o su `default`.
- Sin elección, con un valor que no es un conector instalado, o con un conector que falta, la capa contesta
  `sin_plataforma` con el motivo y cómo elegirla. Nunca elige una plataforma por costumbre ni por el remoto de git.

Para ver qué eligió la organización: `node scripts/lib/platform/platform.js chosen`. Para ver qué conector atendería una
operación sin pedirle nada: `node scripts/lib/platform/platform.js choose <operación> [--repo <org/repo>]`.

---

## El manifiesto (`integration.json`)

```json
{
  "name": "acme-forge",
  "label": "Acme Forge",
  "kind": "platform",
  "connector": "scripts/connector.js",
  "operations": ["work-item.create", "work-item.read", "change-request.open", "ci.read"],
  "capabilities": { "completedHours": "comment", "estimate": "comment", "workItemType": "label", "autoComplete": "auto-or-wait" },
  "rawCommands": ["forge pr create", "forge issue close"],
  "changeRequestCommands": ["forge pr create"],
  "draftOptions": [{ "command": "forge pr create", "options": [{ "name": "--draft", "separateValue": false }, { "name": "-d", "separateValue": false }], "abbreviations": false }],
  "readyCommands": [{ "command": "forge pr ready", "unless": [{ "name": "--undo", "separateValue": false }], "abbreviations": false }],
  "settings": [{ "key": "acme-forge.token", "type": "secreto", "env": "TYCON_ACME_FORGE_TOKEN" }]
}
```

- `kind: "platform"` es lo que la convierte en conector de plataforma; el lector de integraciones
  (`scripts/lib/integrations.js`) valida el manifiesto y frena uno roto con su motivo.
- `operations` lista las que atiende. **Las que no lista, la capa las contesta `no_soportado` sin llamarlo**: se puede
  empezar con pocas.
- `capabilities` dice cómo resuelve lo que su plataforma no tiene igual que las otras, para que el paso que la usa sepa
  qué esperar:

  | Clave | Valores | Qué dice |
  |---|---|---|
  | `completedHours` | `field` · `comment` | las horas trabajadas van a un campo del pedido o a un comentario de formato fijo |
  | `estimate` | `field` · `comment` · `project-or-comment` | dónde queda la estimación vigente de la historia |
  | `workItemType` | `native` · `label` | el tipo del pedido (historia, error) es nativo o va como etiqueta |
  | `autoComplete` | `native` · `auto` · `auto-or-wait` | el pedido de cambio entra solo, o el conector espera los controles y lo mergea |

- `rawCommands` son los comandos crudos de la plataforma que no se corren a mano porque hay una operación que los
  reemplaza (crear un pedido, cerrar uno). Los frenos los leen de acá (`platform.js raw-command '<comando>'`): un
  conector nuevo no toca ningún freno, declara sus comandos.
- `changeRequestCommands` son los de `rawCommands` que crean o juntan un pedido de cambio, con sus alias. El freno de
  guardar los pasa por la ventana de la persona dentro de una ejecución, como un `git push` a una rama compartida. Cada
  uno tiene que estar en `rawCommands`: si no, el lector frena el manifiesto.
- `draftOptions` y `readyCommands` (opcionales) le dicen al freno de guardar cómo es un borrador en la plataforma. Un
  borrador no se puede mergear: antes de «Preparar el pull request» abrirlo pregunta en la ventana en vez de frenar,
  y pasarlo a listo es un pedido que pide el paso cerrado (lo cuenta `guides/firmas-del-arnes.md`, en el freno de
  guardar). Un conector sin estos campos es válido: su borrador no se reconoce y frena antes de «Preparar» como
  cualquier pedido.
  - `draftOptions`: por cada comando que crea un pedido (uno de `changeRequestCommands`), las opciones que lo hacen
    borrador (`options`) y si el programa acepta una opción larga acortada (`abbreviations`: en Azure DevOps, `--dr`
    es `--draft`).
  - `readyCommands`: los comandos que pasan un borrador a listo. Cada uno trae la opción que tiene que aparecer en
    falso para marcarlo (`"when"`: el `pr update` de Azure DevOps con `--draft false`) o la que lo descarta
    (`"unless"`: `gh pr ready --undo` vuelve a borrador). Sin ninguna de las dos, el comando siempre lo marca. No van
    en `rawCommands`: no son comandos que la capa reemplace.
  - Cada opción es `{ "name", "separateValue" }`: el nombre corto (`-d`) o largo (`--draft`), y si el programa le lee
    el valor separado (`--draft false`, en Azure DevOps) o sólo junto (`--draft=false`, en GitHub, donde
    `gh pr ready --undo 12` es la opción sola y el número del pedido).
  - Una opción de `when` puede declarar sus valores (`"values"`): entonces cuenta sólo con uno de ellos, o con uno que no
    se ve. Así se declara un `update` que completa el pedido, que es mergearlo: en Azure DevOps,
    `{ "name": "--status", "separateValue": true, "values": ["completed"] }`. Abandonarlo o reactivarlo no cuenta.
  - `argumentFiles`, en los dos campos: la letra con que empieza una palabra que el programa cambia por lo que trae un
    archivo antes de leer sus opciones (`"@"` en Azure DevOps: `az … @o.txt`). Esa palabra puede traer cualquier
    opción, también la que publica el pedido.

  La lectura es estricta. Al crear, es borrador sólo la última aparición escrita sola o con un «sí» (`true`, `yes`,
  `1`), que no pueda ser el valor de la opción de antes, y en un comando sin palabras que no se ven enteras: una
  variable, una sustitución o un archivo de argumentos pueden traer `--draft=false`. Al marcar listo, cuenta cualquier
  aparición que pueda serlo, y cualquier palabra que no se ve entera: un «no», una variable, un valor que no se
  entiende, un archivo de argumentos. GitLab no declara estos campos: un
  borrador ahí pasa a listo sacándole «Draft:» al título o con la acción rápida `/ready` en un comentario, y el freno no
  ve ninguno de los dos. Marcar listo por la API (`gh api … markPullRequestReadyForReview`) tampoco se ve.
  `scripts/lib/integrations.js` rechaza un campo mal escrito.
- `settings` declara sus claves de configuración; las de `type: "secreto"` no se escriben nunca en el perfil del equipo:
  cada persona las carga en su máquina.
- `repoShape` es la forma de un repo de la plataforma en `team-repos.json`. Lleva cuatro cosas:
  - `keys`: sus claves en orden; la última es `repo`.
  - `name`: la expresión, de `^` a `$`, de qué nombre vale.
  - `flags`: `"u"` si el nombre acepta letras de cualquier idioma.
  - `nameHint`: lo mismo dicho en palabras, para el mensaje de error.

  La pide el lector de `team-repos.json` (`scripts/lib/team-repos.js`) a cada plataforma que admite: el núcleo no
  escribe la forma de ninguna, y sin ella los repos de esa plataforma no se pueden validar.

## El código (`scripts/connector.js`)

```js
'use strict';
const OPERACIONES = { 'work-item.read': leerPedido, 'ci.read': leerCI /* … */ };

function run(operacion, args, ctx) {
  const f = OPERACIONES[operacion];
  return f ? f(args, ctx) : { ok: false, reason: 'no_soportado', detail: `Acme Forge no atiende ${operacion} todavía` };
}

module.exports = { run };
```

`run` puede devolver el resultado o una promesa. Lo que recibe en `ctx`:

| Campo | Qué es |
|---|---|
| `env` | las variables de entorno con que se llamó a la capa |
| `root` | la raíz del arnés: para reusar sus lectores (no la carpeta del conector, que puede ser otra) |
| `repo` | la identidad del repo (`{ org, repo, … }`, o `{ namespace, repo, host? }` donde el repo vive en grupos) en las operaciones atadas a un repo |
| `label` | el nombre de la plataforma para los mensajes |
| `secretState(clave)` | si un secreto está (`{ present, estado }`), nunca su valor |
| `readSecret(clave)` | el valor, sólo cuando lo va a usar |
| `configValue('sección.clave')` | un valor de la configuración de la máquina, o `undefined` |
| `configProblem(sección)` | si la configuración de esa sección no se pudo leer: «no se pudo leer» no es «falta el dato» |

### El remoto de un clon (opcional)

Una plataforma con un servidor único no necesita nada más. Una que cada organización instala en su propio servidor
exporta además `identityFromRemote(url, declarados)`: recibe la dirección del remoto `origin` de un clon y los repos de
su plataforma que declara `team-repos.json`, y devuelve la identidad del repo tal como está declarada, o `null` si el
servidor de esa dirección no es el de ninguno. La capa valida lo que devuelve como un repo del archivo. Con eso
`scripts/tools/merge-pr.js` y `scripts/tools/story-index.js` reconocen el clon sin que el núcleo conozca el servidor; un
remoto de un servidor que nadie declaró sigue siendo «de otro servidor». El ejemplo es
`integrations/gitlab/scripts/remote.js`.

### Lo que contesta

Siempre una de dos formas:

- `{ ok: true, value }`: hizo lo que se le pidió, y `value` trae lo que dice abajo;
- `{ ok: false, reason, detail }`: no lo hizo; `reason` es uno de los motivos cerrados y `detail` dice por qué, en una
  línea que se puede mostrar (sin secretos: la capa además limpia lo que parezca un token).

Una excepción, una respuesta con otra forma o un motivo inventado los convierte la capa en `no_medido`: el error no se
pierde, pero el conector quedó fuera del contrato y la prueba de conformidad lo marca.

### Los motivos de un «no»

| Motivo | Cuándo |
|---|---|
| `sin_plataforma` | no hay plataforma elegida para esa operación (lo contesta la capa) |
| `sin_credencial` | falta el token o la sesión de la CLI; el `detail` dice el comando para cargarla |
| `no_soportado` | la plataforma no tiene eso, o el conector todavía no lo atiende |
| `no_encontrado` | lo pedido no existe (un pedido por un número que no hay) |
| `rechazado` | la plataforma o el arnés lo negó: un pedido sin forma, un freno, un permiso |
| `red` | no se pudo hablar con la plataforma |
| `no_medido` | una lectura que no se completó |

**Una lectura que falló es `no_medido`, nunca una lista vacía ni un cero.** Es la regla que más importa: un control que
lee «no hay pedidos abiertos» o «la cola está libre» de una lectura cortada decide mal. Una lista se devuelve entera o
no se devuelve.

---

## Las operaciones

Están en `OPERATIONS` de `scripts/lib/platform/contract.js`. Los argumentos que no aplican a una plataforma se
ignoran; lo que la plataforma no puede cargar vuelve en `unsupported` con su nombre, nunca se descarta en silencio.
Cada `value` puede traer `warnings`: lo que salió a medias sin ser un «no» (un comentario que no se publicó después de
crear el pedido).

### El pedido de trabajo (la historia en la plataforma)

| Operación | Recibe | Devuelve en `value` |
|---|---|---|
| `work-item.create` | `type`, `title`, `description`, `acceptance`, `tags`, `epic`, `priority`, `fields`, `assignTo`, `estimate` | `id` del pedido creado, `unsupported`, `warnings` |
| `work-item.update` | `id` y lo que cambia (`state`, `title`, `fields`, `comment`, `estimate`, `assignTo`); `reopen` para reabrir | `id`, `estado`, `previo`, `changed`; `pideReabrir: true` si está cerrado y no se pidió reabrir |
| `work-item.close` | `id`, `hours` (o `seconds`), `comment`, `fields` | `id`, `hours`, `hoursAs` (`field` o `comment`), `unsupported` |
| `work-item.find` | `tag`: la etiqueta exacta | `tag`, `ids` (abiertos y cerrados, de todas las páginas) |
| `work-item.read` | `id` | `id`, `estado`, `cerrado` (true o false) |

`estimate` tiene forma propia (`{ value, unit, hours?, level?, version? }`, con `unit` en `hours`, `days` o `points`);
la capa la valida antes de llamar al conector y una sin forma es `rechazado`. Dónde queda la decide el conector y lo
declara en `capabilities.estimate`.

### El pedido de cambio (el pull request)

| Operación | Recibe | Devuelve en `value` |
|---|---|---|
| `change-request.open` | `sourceBranch`, `targetBranch`, `text` (su primera línea es el título si no viene `title`), `deleteSourceBranch`, y opcionales `title`, `check`, `waitMinutes`, `pollSeconds`, `repoDir` | el número del pedido, cómo entra (`modo`) y si ya entró (`merged`); `conflict: true` si choca con su destino |
| `change-request.vote` | el número y el voto | lo que la plataforma registró |
| `change-request.list` | opcional `sourceBranch` (los de esa rama, cada uno leído entero), `queue: true` (con su lugar en la cola), `checks: false` | la lista de abiertos: número, autor, rama, si está en la cola (`inQueue`), si su CI corre (`ciRunning`: `null` si no se supo) |
| `change-request.read` | `number` | `number`, `state` (`open`, `merged` o `closed`), `draft`, `autoComplete`, `inQueue`, `mergedAt`, `mergeCommit`, `title`; uno que no existe es `no_encontrado` |

`change-request.open` tiene forma propia (`openProblem` del contrato): ramas sin opciones disfrazadas ni `..`, un texto
que no empiece con `-` ni `@`. La capa la valida antes de llamar al conector. Si la plataforma no tiene entrada
automática, el conector espera los controles de la punta (sólo `check`, si viene) hasta `waitMinutes` y lo mergea; los
controles que no terminan a tiempo son `no_medido`, nunca «entró».

### Lo asignado, la CI, la cola y los despliegues

| Operación | Recibe | Devuelve en `value` |
|---|---|---|
| `assigned.list` | nada | una fila por persona asignada: `tipo`, `id`, `titulo`, `estado`, `asignado`, `enlace` |
| `ci.read` | `branch` o `commit` | `state` (`succeeded`, `failed`, `running` o `none`) y `stages`: cada control con su conclusión |
| `queue.read` | opcional `repos` (si no, los del equipo en `team-repos.json`) | la lista de ejecuciones esperando o en curso, con quién disparó cada una y desde cuándo |
| `deployments.read` | `entrada` (el pipeline o repo, sus etapas, el entorno) y `entorno` | los despliegues de ese entorno |
| `branch-rules.read` | opcional `branch` (si no, la rama principal del repo) | `branch` y `approval`: la regla de aprobación mínima de esa rama (`enabled`, `blocking`, `minimum`, `creatorVoteCounts`, `resetOnSourcePush`), o `null` si no tiene; con varias, la que menos le falta |
| `security-alerts.list` | nada | las alertas abiertas del análisis de seguridad en la rama principal del repo: `number`, `rule`, `severity`, `path`, `line`, `createdAt`; un repo sin análisis es `no_soportado`. La lee el aviso de pedidos trabados: el chequeo de antes de encolar mira las referencias del pedido, y una alerta que aparece recién en main no la ve |

Lo que le falta a una regla de aprobación lo decide el contrato (`approvalFaults`): sirve la que está prendida, frena,
pide al menos una aprobación, cuenta el voto de quien abrió el pedido y borra las aprobaciones con cada empuje nuevo. Lo
usa `scripts/tools/branch-approval.js`, que relee la regla al terminar el alta de un producto y que `harness.js doctor
--fetch` corre sobre los repos que declara la organización. Una lectura que no se pudo hacer es `no_medido`, nunca «sin
regla».

Lo que un control concluye de `ci.read` y de `queue.read` lo decide el contrato (`verdictOf`): verde **sólo** con una
ejecución que terminó bien. Un «no» de cualquier motivo, también `no_soportado`, es `no_medido`. Un control verde no es un
despliegue: eso lo dice `deployments.read`.

---

## La prueba de conformidad

```bash
node -e "require('./scripts/lib/platform/platform.js').conformance('acme-forge').then((r) => console.log(r))"
```

`conformance(nombre)` llama a cada operación que el manifiesto declara con un pedido de prueba y mira que cada
respuesta tenga la forma del contrato: `{ ok: true, value }` o `{ ok: false, reason, detail }` con un motivo de la lista.
Devuelve `{ problems: [] }` si cumple, o cada operación con su problema. No necesita credenciales: sin ellas, la
respuesta correcta es `sin_credencial` con el comando para cargarlas, y eso también cumple.

**El ejemplo es el conector de mentira de las pruebas**, `scripts/tests/lib/fake-platform/`: declara todas las
operaciones menos votar, pide un token secreto (sin él contesta `sin_credencial`, como uno real) y contesta lo que le
digan las pruebas. `scripts/tests/platform-contract.test.js` lo usa para probar la capa entera
(`FakePlatform_PassesConformance`) y pasa la misma conformidad a los conectores de Azure DevOps y de GitHub
(`Conformance_AzureAndGithub_DeclaredOps`); la del de GitLab está con sus casos, en
`scripts/tests/platform-gitlab.test.js`. Para un conector nuevo:

1. copiar `fake-platform/` a `integrations/<nombre>/` y cambiar el manifiesto;
2. reemplazar cada respuesta de mentira por la llamada a la plataforma, operación por operación;
3. sumar su nombre a la prueba de conformidad de los conectores reales y correrla:
   `node --test scripts/tests/platform-contract.test.js`.

Para probar contra la capa sin instalar el conector en el árbol, `TYCON_INTEGRATIONS_DIR` apunta a otra carpeta de
integraciones.

## Las reglas de la plataforma (`rules.md` y `notices.json`)

Lo que el agente tiene que saber de una plataforma (que un listado atrasado no prueba que algo no pasó, cómo entra un
pedido a la rama principal) no va al `CLAUDE.md` de todas las sesiones: viaja con su conector y aparece la primera vez
que el agente usa la CLI de esa plataforma en la sesión.

```json
{ "notices": [ { "id": "reglas-de-la-plataforma", "text": "rules.md", "when": "after-command", "commands": ["forge pr", "forge run"] } ] }
```

- `when: "after-command"` lo muestra después del primer comando que empieza con alguno de `commands` (la CLI y una de
  sus primeras palabras), una vez por sesión; vuelve a aparecer si la conversación se compacta o se limpia.
- Sólo aparece si la organización eligió esa plataforma para algo (`platform.js chosen`): la regla de una plataforma que
  el equipo no usa no se muestra nunca.
- `text` es el archivo, dentro de la carpeta del conector. Las reglas se escriben como las del `CLAUDE.md`: qué hacer,
  qué no, y por qué en una línea.
