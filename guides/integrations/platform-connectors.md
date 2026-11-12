# Conectores de plataforma — cómo sumar una plataforma al arnés

El núcleo del arnés no habla con Azure DevOps ni con GitHub: habla con **la plataforma del equipo**, por una capa
(`scripts/lib/platform/platform.js`) que elige qué conector atiende cada operación y le pasa el pedido. Esta guía es
para quien quiere sumar una tercera plataforma: qué tiene que atender el conector, qué tiene que contestar y cómo se
prueba que cumple.

Los dos conectores que trae el arnés sirven de ejemplo vivo: `integrations/azure-devops/` y `integrations/github/`. El
caso de cada uno, para quien lo usa, está en `guides/integrations/ado-projects.md` y en
`guides/integrations/github-platform.md`.

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
- `settings` declara sus claves de configuración; las de `type: "secreto"` no se escriben nunca en el perfil del equipo:
  cada persona las carga en su máquina.

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
| `repo` | la identidad del repo (`{ org, repo, … }`) en las operaciones atadas a un repo |
| `label` | el nombre de la plataforma para los mensajes |
| `secretState(clave)` | si un secreto está (`{ present, estado }`), nunca su valor |
| `readSecret(clave)` | el valor, sólo cuando lo va a usar |
| `configValue('sección.clave')` | un valor de la configuración de la máquina, o `undefined` |
| `configProblem(sección)` | si la configuración de esa sección no se pudo leer: «no se pudo leer» no es «falta el dato» |

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
(`FakePlatform_PassesConformance`) y pasa la misma conformidad a los dos conectores reales
(`Conformance_AzureAndGithub_DeclaredOps`). Para un conector nuevo:

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
