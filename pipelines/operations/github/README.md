# Los procesos de la noche, en tu organización de GitHub

Tres workflows de GitHub Actions que corren solos cada noche sobre los repos de tu organización y guardan lo que
encuentran en un repo tuyo, el **repo de operaciones**. Es lo mismo que [los pipelines de Azure DevOps](../README.md),
para una organización que vive en GitHub:

| Workflow | Qué hace | Qué deja |
|---|---|---|
| `stage-metrics.yml` | Mide el ciclo de las stories de los repos que usan el arnés | `.dashboard/sdlc-stage-<fecha>.json` y `.dashboard/proyectos/` en el repo de operaciones |
| `dependency-audit.yml` | Busca dependencias con vulnerabilidades conocidas en los repos que declares, y abre un **issue** en el repo del producto por cada hallazgo. Antes de mirarlas, compara los workflows de tus productos (la paridad) | `.dashboard/dependencias/`, `inbox/dependencies/` y `.dashboard/paridad/paridad-<día>.json` en el repo de operaciones; los issues, en cada producto |
| `team-dashboard.yml` | Arma una página con todo lo anterior | `artifacts/tablero-del-arnes.html` en el repo de operaciones |

Esta página es para quien administra la organización de GitHub. Lleva una hora la primera vez. No hace falta instalar
nada en una máquina: todo pasa en GitHub.

## 1. Lo que necesitás antes

- **Permiso de dueño (owner) de la organización**, o de administrador del repo de operaciones y de los repos a mirar.
- **Una identidad para la noche, con su credencial.** Los workflows necesitan leer los repos de la organización y
  escribir issues en los de los productos; el token propio de un workflow sólo ve su repo. Hay dos caminos:
  - **Recomendado: una GitHub App** de la organización (punto 1.1). Cada corrida le pide a GitHub un token que vence en
    una hora, con los permisos justos para cada paso y sólo de los repos donde la App está instalada. No hay un token
    fijo que se pueda filtrar ni que venza un día cualquiera, y no ocupa una cuenta de persona.
  - **Alternativa: un usuario de máquina** (punto 1.2): una cuenta de GitHub sólo para esto, con un token de acceso
    fino.
  - **No uses tu token personal.** Con él, lo que hace la noche y lo que hacés vos salen de la misma cuenta, y la noche
    deja de poder distinguir un issue que cerraste vos de uno que cerró ella (lo marca en el texto, pero cerrar o
    etiquetar sin comentar se lee como suyo).
- **Que los repos a medir usen el arnés.** Las métricas sólo cuentan los repos que tienen la carpeta `.tycon/` o
  `.advisors/`. Un repo sin ninguna de las dos no se mide (no es un error).

### 1.1 La GitHub App (recomendado)

1. **Crearla.** En la organización: *Settings → Developer settings → GitHub Apps → New GitHub App*. Un nombre (por
   ejemplo `<tu-org>-noche`); en *Homepage URL*, la dirección del repo de operaciones. En *Webhook*, destildá
   *Active*: la App no recibe eventos. En *Where can this GitHub App be installed?*, **Only on this account**.
2. **Permisos mínimos.** En *Repository permissions*, sólo estos cinco: *Contents: Read-only*, *Issues: Read and
   write*, *Metadata: Read-only* (GitHub lo pone solo), y para la foto de despliegues del tablero (story 2.22)
   *Deployments: Read-only* y *Actions: Read-only*. Ningún permiso de organización ni de cuenta. Los workflows además
   piden cada token con menos: el que clona sólo lee, el que escribe issues sólo escribe issues, y el del tablero sólo
   lee deployments y actions. **La foto de despliegues lee los repos de producto**: la App tiene que estar instalada
   en ellos (punto 4). Qué leer se declara en `operations.json → deployments` (el ejemplo trae la forma): por
   producto, el `environment` de staging y el de producción y, si querés saber si main está roto, el `workflow` de
   staging. Sin la App, o sin declarar, cada producto sale «no medido», sin error.
3. **Los datos que van a los secretos.** En la página de la App, anotá el **Client ID**. Abajo, en *Private keys*,
   *Generate a private key*: se baja un archivo `.pem`. Esa llave es la credencial: va al secreto del punto 3 y **no
   se guarda en ninguna otra parte** (borrá el archivo cuando la cargues).
4. **Instalarla sólo donde hace falta.** *Install App* → tu organización → **Only select repositories**: los repos a
   medir y los que mira la revisión de dependencias. No hace falta el repo de operaciones (ahí escribe el token propio
   del workflow) ni el repo público del arnés.
5. **Su identidad.** El token de una App no deja leer con qué cuenta corre. Declarala en `github.identity` de
   `repos.json` (punto 2) como `<nombre-corto-de-la-app>[bot]`: el nombre corto es el que aparece en la dirección de
   la página de la App (`.../apps/<nombre-corto>`). Sin eso, la noche no cierra ni reabre ningún issue, y lo dice.

La llave de una App no vence. Para cambiarla: generá una nueva, reemplazá el secreto y borrá la vieja en la página de
la App. Para cortarle el acceso a la noche, borrá la llave o desinstalá la App.

Con la App, las métricas miden los repos donde la App está **instalada**, privados incluidos, sea el dueño una
organización o una cuenta de usuario: instalala en todos los repos a medir. Miran **un** dueño, el del repo de
operaciones; si `METRICS_OWNERS` nombra a otros, la corrida avisa que la App no está instalada en sus repos y no los
mide; para varios dueños, usá el usuario de máquina. Si no ven ningún repo, la corrida lo dice con un aviso.

### 1.2 El usuario de máquina (alternativa)

Una cuenta de GitHub sólo para esto, miembro de la organización, con un **token de acceso fino** (*Settings → Developer
settings → Personal access tokens → Fine-grained tokens*): dueño la organización, acceso a los repos a medir y a mirar,
y estos permisos de repositorio: *Contents: Read*, *Issues: Read and write*, *Metadata: Read*.

Un token fino **vence** (como mucho al año, o antes si la organización lo pide). El día que vence, la revisión de
dependencias sale en rojo con «la credencial no sirve (401)» y las métricas con «No se pudieron listar los repos». Se
renueva el token y se reemplaza el secreto (punto 3).
## 2. El repo de operaciones

Creá un repo **privado**, por ejemplo `operations`, con una rama `main`. Sus archivos van en las **mismas rutas** en que
los lee el arnés (los ejemplos están en `pipelines/operations/examples/github/` del arnés):

| Ruta en el repo de operaciones | Qué es | Obligatorio |
|---|---|---|
| `team-repos.json` | Dónde vive cada repo del arnés de tu organización. `public`: el repo público del arnés (de ahí lo traen los workflows); `operations`: este repo (si no coincide, la noche sale en rojo); `profile`: el perfil de tu equipo (si no tenés uno, poné este repo). Forma: `scripts/lib/team-repos.js` | Sí |
| `operations.json` | A quién se asignan los issues (`owners.default`, y `owners.by_project` con la clave `<dueño>/<repo>`). Identidades: usuarios de GitHub. Y, si querés, quién es quién en el sitio de la organización (`people`, más abajo). Forma: `scripts/lib/operations-config.js` | Sí, para la revisión de dependencias |
| `scripts/nightly/dependencies/repos.json` | Qué repos mira la revisión de dependencias (`github`: `<dueño>/<repo>`; `tipo`: `npm` o `nuget`) y el bloque `github` (`issues_enabled`, `identity`) | Sí, para la revisión de dependencias |
| `scripts/nightly/dashboard/sources.json` | Qué fuentes espera el tablero. Usá el de `pipelines/operations/examples/sources.json` | Sí, para el tablero |
| `scripts/ci/product-parity.json` | Opcional. Los productos que tienen que hacer lo mismo, con `archivo: ".github/workflows/<nombre>.yml"` en cada grupo (ejemplo: `pipelines/operations/examples/product-parity.json`). Un repo que la revisión de dependencias no clona lleva `github: "<dueño>/<repo>"`. Sin el archivo, la paridad sale «sin productos» | No |
| `.github/workflows/stage-metrics.yml`, `.github/workflows/dependency-audit.yml`, `.github/workflows/team-dashboard.yml` | Copias de los tres workflows de esta carpeta, **sin cambiar nada** | Sí |

`team-repos.json` vive también en el perfil del equipo, si tenés uno: son dos copias, mantenelas iguales. Una
organización tiene **una plataforma**: con `operations.platform: github`, una entrada `ado` en `repos.json` hace salir
en rojo la revisión de dependencias.

Quien recibe un issue (`owners.*`) tiene que tener acceso al repo del producto: si no, GitHub crea el issue sin asignar,
en silencio, y la noche lo dice como fallo «asignar».

Validá los JSON antes de subirlos, desde una copia del arnés:

```bash
node scripts/lib/team-repos.js team-repos.json
node scripts/lib/operations-config.js operations.json
node -e "JSON.parse(require('fs').readFileSync('scripts/nightly/dependencies/repos.json','utf8'))"
```

Lo demás (`.dashboard/`, `inbox/`, `artifacts/`) lo crean los workflows. Un repo de operaciones recién creado no los
trae, y está bien.

**Cómo se edita `operations.json` después del alta.** Siempre por pull request revisado, nunca escribiendo `main`.
Con el sitio de la organización desplegado, su pestaña **Configuración**, sólo para los que mantienen: valida con los
mismos lectores (`operations-config.js`, `team-repos.js`) y abre el pull request desde el sitio con un token de grano
fino sobre este repo (`SITE_OPERATIONS_WRITE_TOKEN`: `contents: write`, `pull_requests: write`). Sin sitio, se edita el
archivo y se abre el pull request a mano; la página local `harness.js team-config` (en la máquina de quien mantiene, con
los clones) muestra lo que hay, de sólo lectura, con los problemas que ven los lectores. La pestaña no habilita «Proponer» si
`main` no tiene una protección o una regla que pida revisión. Los umbrales del tablero
(`scripts/nightly/dashboard/sources.json`) se editan en el sitio recién cuando la noche dejó la marca
`.dashboard/applied-config.json` con ese archivo adentro (qué configuración aplicó de verdad, con su identificador de
objeto; sólo al final de una noche verde). En estos workflows la deja `prepare-tree.sh`, igual que la plantilla de
Azure DevOps.

### Quién es quién: la clave `people` (opcional)

`people` dice de quién es cada máquina del equipo, para que en el sitio de la organización cada persona vea sólo sus
corridas. Sin `people`, nadie ve corridas ajenas y las de una máquina sin confirmar las ve sólo quien mantiene. Acá van
**correos**, no usuarios de GitHub: el sitio compara con el correo con que la persona inicia sesión.

- **`people.machines`**: una entrada por máquina, con el nombre de su carpeta en el buzón de corridas
  (`<nombre>-<código>`, por ejemplo `maq-uno-1a2b3c4d`). Cada máquina informa el correo de git de su dev; un
  mantenedor lo revisa y confirma la máquina escribiendo `person` (el correo de la persona en la organización, que puede
  no ser el informado), `reported_sha256`, `confirmed_by` (quién confirma) y `confirmed_on` (el día, `AAAA-MM-DD`).
- **`reported_sha256` es la huella del correo que informaba la máquina, nunca el correo.** Este archivo queda en la
  historia de git para siempre: un correo personal no tiene que quedar ahí. Quien mantiene ve el correo informado en el
  espejo del buzón. Si la máquina no informaba correo, va `null`. Si la máquina empieza a informar otro correo, la
  confirmación se cae hasta que alguien la vuelva a confirmar.
- **`people.projects`**: corrige en qué productos trabaja cada persona (los productos de `repos.json`). `add` suma
  productos a los que se deducen de sus corridas y sus issues; `remove` los saca. Un producto no va en las dos.

La huella se calcula así, con el correo tal como lo informa la máquina (se pasa a minúsculas y sin espacios alrededor):

```bash
node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1].trim().toLowerCase()).digest('hex'))" "<correo informado>"
```

Cada confirmación entra por pull request revisado, como cualquier cambio de este archivo. Antes de abrirlo, validalo
con `node scripts/lib/operations-config.js operations.json` de un arnés que ya conozca `people`: uno anterior lo
rechaza y frena la revisión de dependencias.

## 3. Secretos, variables y permisos del repo de operaciones

En el repo de operaciones, *Settings → Secrets and variables → Actions*:

| Tipo | Nombre | Para qué |
|---|---|---|
| Variable | `HARNESS_APP_CLIENT_ID` | El *Client ID* de la GitHub App (punto 1.1). Con esta variable puesta, los workflows usan la App |
| Secreto | `HARNESS_APP_PRIVATE_KEY` | La llave privada de la App: el contenido entero del archivo `.pem`, con sus líneas `-----BEGIN` y `-----END` |
| Secreto | `HARNESS_ORG_TOKEN` | Sólo con el usuario de máquina (punto 1.2): su token. Si están la App y este secreto, gana la App |
| Variable | `HARNESS_REF` | La rama, el tag o el commit del arnés que corre cada noche. Vacía: `main`, igual que las máquinas de los devs. Quien quiera fijar una versión pone acá un tag o un commit, y lo sube a conciencia: cada noche el arnés corre con la credencial de tu organización |
| Variable | `METRICS_OWNERS` | Los dueños cuyos repos miden las métricas, separados por `;`. Vacía: el dueño de este repo |
| Variable | `METRICS_REPO_PREFIX` | Si la organización mezcla repos de otros equipos: sólo los que empiezan así |
| Variable y secreto | `TYCON_TELEGRAM_CHAT_ID` y `TELEGRAM_BOT_TOKEN` | El resumen diario de dependencias, si el canal es `telegram`. Usá un bot dedicado al aviso |
| Secreto | `TYCON_NOTIFY_WEBHOOK_URL` | El resumen diario, si el canal es `slack` o `teams`: la dirección del webhook entrante. La dirección ES la credencial |

**El canal del aviso.** Lo elige `operations.json → notify`: `{ "channel": "telegram" }`, `"slack"` o `"teams"`. **Sin
`notify`, no se manda**, y la constancia de la noche lo dice («canal sin configurar en operations.json → notify»). El
aviso lleva sólo cantidades y, si `operations.json → site.url` está y el sitio pasó esa mañana la prueba sin sesión, el
enlace al sitio.

**La protección de `operations.json` y de los workflows.** Ponela **antes** de publicar el sitio de la organización: sin
ella, cualquiera que pueda empujar a `main` se hace mantenedor del sitio o cambia un workflow y se lleva sus secretos. En
*Settings → Rules → Rulesets → New push ruleset* (repos privados o internos), la regla **Restrict file paths** sobre
`operations.json` y `.github/workflows/**`, con el equipo de quienes mantienen como única excepción (*Bypass list*). Los
nocturnos no necesitan excepción: guardan con el token del workflow y ninguno toca esas rutas. Esa regla frena todo
empuje que toque esas rutas en **cualquier** rama, también la de una propuesta: **el sitio no propone** cambios a
`operations.json` en GitHub. La pestaña Configuración valida y descarga el archivo, y quien mantiene abre el pull request
a mano. (Una regla de rama que pida pull request sobre todo `main` dejaría proponer al sitio, pero frena los guardados de
los nocturnos; ponerle de excepción a GitHub Actions dejaría a cualquiera con escritura empujar un workflow que escriba
`main`.)

Y en *Settings → Actions → General*: *Workflow permissions* puede quedar en «Read repository contents»; cada workflow
pide para sí `contents: write` (para guardar en este repo) y nada más. Si `main` del repo de operaciones tiene reglas de
protección, el token del workflow tiene que poder empujar ahí (o los guardados salen en rojo). Si la organización
restringe qué acciones se pueden usar, permití `actions/checkout`, `actions/setup-node`, `actions/setup-dotnet` y
`actions/create-github-app-token` (van fijadas por el commit).

## 4. La primera corrida: sin efectos

En *Actions*, cada workflow → *Run workflow*, con **effects** destildado. Mide y escribe en el disco del runner, pero no
guarda nada, no crea ni comenta issues y no manda el resumen. `harness_ref` deja probar otra versión del arnés sin
cambiar la variable.

Mirá que termine en verde. Si dice «Repos NO medidos» o «NO MEDIDO», es la credencial: no puede leer esos repos.

## 5. La primera corrida de verdad, en orden

Con efectos, a mano, en este orden (es el mismo de la noche):

1. `stage-metrics` — deja el punto del día. El tablero lo necesita.
2. `dependency-audit` — deja la foto de la noche. **La primera noche es la línea base**: lista lo que encuentra y no
   avisa nada, porque no hay con qué comparar. Desde la segunda, cada hallazgo nuevo es una ficha en
   `inbox/dependencies/` y, con los issues prendidos, un issue en el repo del producto (como mucho dos por noche, más
   las críticas: `presupuesto_de_ruido` en `repos.json`).
3. `team-dashboard` — arma la página y la guarda.

Los issues nacen **apagados**: con `github.issues_enabled: false` la revisión no habla con los issues. Prendelos
(`true`) cuando la credencial ya esté probada.

Después quedan programados solos: dependencias 04:17 UTC, métricas 06:17 UTC, tablero 08:47 UTC (minutos no redondos:
GitHub demora o saltea las programaciones en punto cuando tiene carga). Para cambiar el horario, el `cron` de cada
workflow. GitHub deja una sola corrida esperando por workflow: una corrida a mano mientras otra espera reemplaza a la
que esperaba.

## 6. Qué mirar después

- **Los issues** de la revisión de dependencias, en cada repo de producto, con la etiqueta `arnes-hallazgo`. Ahí se
  decide: **arreglarlo** (subir el paquete: cuando la noche deja de verlo en `main`, cierra el issue sola), **declararlo
  como deuda** (en el `vulnerabilidades-pendientes.json` del repo; el issue queda abierto), o **cerrarlo como «not
  planned»** si no aplica (la noche lo va a decir una vez mientras la vulnerabilidad siga en `main`: la salida sin
  arreglo es declarar la deuda). La noche reabre un issue que cerró ella si la vulnerabilidad vuelve; uno que cerró una
  persona, no.
- **La página del tablero**: `artifacts/tablero-del-arnes.html` del repo de operaciones (bajala y abrila en el navegador).
- **Una corrida en rojo** dice en su primer error por qué. Las causas de siempre: la credencial (el token vencido, sin
  permiso, o la App sin instalar en ese repo), un JSON que no valida, `team-repos.json` que no nombra este repo como
  `operations`, o el repo de operaciones sin rama `main`. Lo que en Azure es «naranja» acá es un aviso amarillo con la
  corrida en verde: mirá los avisos.

## 7. La copia para el sitio de la organización (opcional)

Si el sitio de la organización vive en Azure, puede leer este repo **sin ninguna credencial de GitHub**: el workflow
`site-copy.yml` copia lo que el sitio lee a un contenedor de almacenamiento, y el sitio lo lee con su identidad
administrada (`SITE_OPERATIONS_SOURCE=copy`). Qué forma conviene, y lo que cuesta cada una: la guía del sitio
(`guides/organization-site.md`, «De dónde lee operaciones»).

1. **El contenedor**: lo crea el alta del sitio (`azure-container-apps.js`), en una cuenta con la llave apagada.
2. **La credencial federada**: una aplicación de Entra con una credencial federada para este repo y el entorno
   `site-copy` (*Certificates & secrets → Federated credentials → GitHub Actions*), y el rol «Storage Blob Data
   Contributor» sobre **ese contenedor** y nada más. **Ningún secreto en GitHub.**
3. **El workflow**: copiá `site-copy.yml` a `.github/workflows/`, creá el entorno `site-copy` (*Settings → Environments*)
   y cargá las variables `SITE_COPY_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `SITE_COPY_ACCOUNT` y
   `SITE_COPY_CONTAINER`. Corre en cada push a `main`, al terminar cada nocturno (su guardado no dispara un `push`) y
   una vez por día.
4. **La primera corrida** tiene que salir verde y decir «subida la foto de <commit>». Recién entonces el sitio pasa a
   `SITE_OPERATIONS_SOURCE=copy`.

## 8. El sitio al día con stable (opcional)

El workflow `site-update.yml` mantiene el sitio de la organización al día con la etiqueta `stable` de su imagen. Corre
cada noche, antes de dependencias. Qué hace y cómo se elige automático o sólo aviso: la guía del sitio («Cómo se
mantiene al día»).

1. **Azure**: una aplicación de Entra propia con una credencial federada para este repo y el entorno `site-update`, y
   un rol propio sobre la aplicación del sitio y nada más (la guía trae el rol). Variables: `SITE_UPDATE_CLIENT_ID`,
   `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `SITE_IMAGE_NAME`, `SITE_RESOURCE_GROUP`, `SITE_APP` y `SITE_URL`.
2. **Render**: `SITE_PLATFORM=render`, `SITE_IMAGE_NAME` y el secreto `SITE_RENDER_DEPLOY_HOOK`, el único secreto.
3. **El workflow**: copiá `site-update.yml` a `.github/workflows/` y creá el entorno `site-update`.

## Diferencias con los pipelines de Azure DevOps

- Los avisos de dependencias son **issues en el repo del producto**, no Bugs de Azure Boards, y **no hay pull request por
  hallazgo** en el repo de operaciones: el issue es el lugar de decidir. Ninguna ficha pasa a `promoted/`.
- No hay buzón de corridas en el tablero: las fichas del equipo salen «no leído».
- Lo que deja la noche para el sitio de la organización (story 2.23): `team-dashboard` escribe igual
  `.dashboard/open-prs/open-prs-<día>.json` y `.dashboard/assigned/assigned-<día>.json`, los dos con `estado: no_medido`
  y «los pull requests y los pedidos de GitHub todavía no se leen». El sitio lo muestra así, nunca como cero.
- Qué arnés corre lo dice `team-repos.json`, no una línea del YAML.
