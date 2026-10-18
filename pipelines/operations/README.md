# Los procesos de la noche, en tu organización de Azure DevOps

Tres pipelines que corren solos cada noche sobre los repos de tu organización y guardan lo que encuentran en un repo
tuyo, el **repo de operaciones**:

| Pipeline | Qué hace | Qué deja en el repo de operaciones |
|---|---|---|
| `stage-metrics.yml` | Mide el ciclo de las stories de los repos que usan el arnés | `.dashboard/sdlc-stage-<fecha>.json` y `.dashboard/proyectos/` |
| `dependency-audit.yml` | Busca dependencias con vulnerabilidades conocidas en los repos que declares, y abre un pull request por hallazgo. Antes de mirarlas, compara los pipelines de tus productos (la paridad: ¿hacen lo mismo?) | `.dashboard/dependencias/`, `inbox/dependencies/` y `.dashboard/paridad/paridad-<día>.json` |
| `team-dashboard.yml` | Arma una página con todo lo anterior | `artifacts/tablero-del-arnes.html` |

Si tu organización vive en GitHub, los mismos tres corren como GitHub Actions: [esta otra página](github/README.md).

Esta página es para quien administra Azure DevOps. Lleva una hora la primera vez. No hace falta instalar nada en una
máquina: todo pasa en Azure.

## 1. Lo que necesitás antes

- **Permiso para crear repos y pipelines** en un proyecto de tu organización. Los ejemplos usan un proyecto llamado
  `my-project`: cambialo por el tuyo.
- **El arnés al alcance de Azure.** Dos opciones:
  - **Una copia en tu Azure DevOps** (la más simple): en el proyecto, *Repos → Import repository*, con la dirección
    del repo público del arnés en GitHub. Queda un repo, por ejemplo `harness`. Para actualizarlo, se vuelve a traer
    desde GitHub.
  - **Directo de GitHub**: una conexión de servicio de GitHub en el proyecto (*Project settings → Service
    connections → GitHub*). En los YAML, el recurso `harness` pasa a `type: github` con `endpoint:` el nombre de esa
    conexión y `name:` la organización y el repo de GitHub.
- **Que los repos a medir usen el arnés.** Las métricas sólo cuentan los repos que tienen la carpeta `.tycon/` o
  `.advisors/`. Un repo sin ninguna de las dos no se mide (no es un error).

## 2. El repo de operaciones

Creá un repo nuevo, por ejemplo `operations`, con una rama `main`. Sus archivos van en las **mismas rutas** en que los
lee el arnés (los ejemplos están en `pipelines/operations/examples/` del arnés):

| Ruta en el repo de operaciones | Qué es | Obligatorio |
|---|---|---|
| `operations.json` | A quién se asignan los pedidos de trabajo y quiénes revisan los pull requests; y, si querés, quién es quién en el sitio de la organización (`people`, más abajo). Forma: `scripts/lib/operations-config.js` | Sí, para la revisión de dependencias |
| `scripts/nightly/dependencies/repos.json` | Qué repos mira la revisión de dependencias (`ado`: `<proyecto>/<repo>`; `tipo`: `npm`, `nuget` o `pip`) | Sí, para la revisión de dependencias |
| `team-repos.json` | Opcional. Dónde vive cada repo del arnés de tu organización (forma: `scripts/lib/team-repos.js`). Si está, tiene que validar: con `operations.platform: github` los avisos de dependencias son issues de GitHub, no pedidos de trabajo; y si tu organización tiene copias del repo del arnés con stories, van en `harness_copies` (las métricas no las miden, salvo la de `maintainers` si está en la lista) | No |
| `scripts/nightly/dashboard/sources.json` | Qué fuentes espera el tablero. Usá el ejemplo: el del arnés espera fuentes que tu organización no tiene | Sí, para el tablero |
| `scripts/ci/product-parity.json` | Opcional. Los productos que tienen que hacer lo mismo en su pipeline, qué se compara y las diferencias declaradas (ejemplo: `pipelines/operations/examples/product-parity.json`). Un repo que la revisión de dependencias no clona lleva `ado: "<proyecto>/<repo>"`. Sin el archivo, la paridad sale «sin productos» | No |
| `pipelines/stage-metrics.yml`, `pipelines/dependency-audit.yml`, `pipelines/team-dashboard.yml` | Copias de los tres modelos de esta carpeta | Sí |

En cada uno de los tres YAML cambiá **una línea**, la marcada con `← CAMBIAR`: el `name:` del recurso `harness`, con
el proyecto y el repo donde quedó el arnés (`my-project/harness`). Azure no deja poner eso en un parámetro: se escribe
en el YAML.

Validá los dos JSON antes de subirlos, desde una copia del arnés:

```bash
node scripts/lib/operations-config.js operations.json
node -e "JSON.parse(require('fs').readFileSync('scripts/nightly/dependencies/repos.json','utf8'))"
```

Lo demás (`.dashboard/`, `inbox/`, `artifacts/`) lo crean los pipelines. Un repo de operaciones recién creado no los
trae, y está bien.

**Cómo se edita `operations.json` después del alta.** Siempre por pedido revisado, nunca escribiendo `main`. Con
el sitio de la organización desplegado, su pestaña **Configuración**, sólo para los que mantienen: valida con los mismos
lectores (`operations-config.js`, `team-repos.js`) y abre el pedido desde el sitio con la identidad de escritura
(`SITE_OPERATIONS_WRITE_TOKEN`). Sin sitio, se edita el archivo y se abre el pedido a mano; la página local
`harness.js team-config` (en la máquina de quien mantiene, con los clones) muestra lo que hay, de sólo lectura, con los
problemas que ven los lectores. La pestaña no habilita «Proponer» si `main` no tiene una política que pida al menos un
revisor (punto 3). Los umbrales del tablero (`scripts/nightly/dashboard/sources.json`) se editan en el sitio recién
cuando la plantilla `ops-data.yml` dejó la marca `.dashboard/applied-config.json` con ese archivo adentro: la marca dice
qué archivos de configuración aplicó la noche de verdad, con su identificador de objeto, y se guarda sólo al final de
una noche verde. Hasta entonces la sección dice «tu nocturno todavía no lee este archivo».

### Quién es quién: la clave `people` (opcional)

`people` dice de quién es cada máquina del equipo, para que en el sitio de la organización cada persona vea sólo sus
corridas. Sin `people`, nadie ve corridas ajenas y las de una máquina sin confirmar las ve sólo quien mantiene.

- **`people.machines`**: una entrada por máquina, con el nombre de su carpeta en el buzón de corridas
  (`<nombre>-<código>`, por ejemplo `maq-uno-1a2b3c4d`). Cada máquina informa el correo de git de su dev; un
  mantenedor lo revisa y confirma la máquina escribiendo `person` (el correo de la persona en la organización, que puede
  no ser el informado), `reported_sha256`, `confirmed_by` (quién confirma) y `confirmed_on` (el día, `AAAA-MM-DD`).
- **`reported_sha256` es la huella del correo que informaba la máquina, nunca el correo.** Este archivo queda en la
  historia de git para siempre: un correo personal no tiene que quedar ahí. Quien mantiene ve el correo informado en el
  espejo del buzón. Si la máquina no informaba correo, va `null`. Si la máquina empieza a informar otro correo, la
  confirmación se cae hasta que alguien la vuelva a confirmar.
- **`people.projects`**: corrige en qué productos trabaja cada persona (los productos de `repos.json`). `add` suma
  productos a los que se deducen de sus corridas y sus pedidos; `remove` los saca. Un producto no va en las dos.

La huella se calcula así, con el correo tal como lo informa la máquina (se pasa a minúsculas y sin espacios alrededor):

```bash
node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1].trim().toLowerCase()).digest('hex'))" "<correo informado>"
```

Cada confirmación entra por pedido revisado, como cualquier cambio de este archivo. Antes de abrirlo, validalo con
`node scripts/lib/operations-config.js operations.json` de un arnés que ya conozca `people`: uno anterior lo rechaza y
frena la revisión de dependencias.

## 3. Permisos de la identidad de los pipelines

Los pipelines corren con la identidad de compilación del proyecto, `<proyecto> Build Service (<organización>)`. En
*Project settings → Repositories*:

- **Sobre el repo de operaciones**: *Contribute*, *Contribute to pull requests* y *Create branch* en «Allow». Sin eso,
  guardar y abrir pull requests salen en rojo.
- **Sobre los repos que se miden**: *Read*. Si están en otros proyectos, también ahí.

Y en *Project settings → Pipelines → Settings* del proyecto donde corren los pipelines:

- **Apagar *Protect access to repositories in YAML pipelines***. Prendido (lo trae así un proyecto nuevo), la identidad
  sólo ve los repos que el YAML nombra: las métricas ven dos repos (el arnés y operaciones) y no miden nada, y la
  revisión de dependencias no puede clonar los repos declarados.
- **Si los repos a medir están en otros proyectos, apagar también *Limit job authorization scope to current project
  for non-release pipelines***. Prendido, los repos de otros proyectos no se pueden leer: el pipeline lo dice como
  «NO MEDIDO» o «Repos NO medidos».

### La política de rama de `main` del repo de operaciones

Ponela **antes** de publicar el sitio de la organización. Sin ella, cualquiera que pueda empujar a `main` se hace
mantenedor del sitio (cambia la lista `site.access`) o cambia el YAML de un nocturno y se lleva sus secretos.

**La receta recomendada.** En *Project settings → Repositories → el repo de operaciones → Policies → Branch Policies →
main*:

1. **Require a minimum number of reviewers** (en la API, «Minimum number of reviewers»): en 1, con *Allow requestors to
   approve their own changes* apagado y *Reset code reviewer votes when there are new changes* prendido. Sobre toda la
   rama.
2. En *Security* del repo de operaciones, **Bypass policies when pushing** en «Allow» **sólo** para la identidad de
   compilación de los nocturnos (la de esta sección; mirá cuál es en una corrida). Los nocturnos guardan empujando a
   `main`; sin la excepción, su guardado rebota. Nadie más la tiene.
3. Encolar y editar los tres pipelines, sólo quienes mantienen (*Pipelines → el pipeline → Manage security*).

Con eso, un empuje directo de una persona a `main` rebota (`TF402455`) y todo cambio va por un pedido con un revisor que
no es el autor.

**La alternativa: el filtro por ruta.** «Required reviewers» (*Automatically included reviewers*, obligatorio) en 1, con
el filtro de ruta `/operations.json;/pipelines/*`, el grupo de quienes mantienen como revisor y *Allow requestors to
approve their own changes* apagado. La documentación de Azure DevOps dice que una rama con una política obligatoria no
acepta empujes directos, sin distinguir rutas: la identidad de los nocturnos sigue necesitando la excepción del punto 2.
Con el filtro, la pestaña Configuración del sitio habilita «Proponer» **archivo por archivo**: sólo en las secciones
cuyo archivo cubre el filtro; las demás dicen «la política de main no cubre <archivo>».

La pestaña Configuración lee estas políticas: sin ninguna de las dos, «Proponer» queda apagado con el motivo, y desde el
sitio sólo se valida y se descarga. Ningún nocturno guarda `operations.json` ni nada bajo `pipelines/`.

**La foto de despliegues** (el tablero, story 2.22) lee las corridas y el timeline de los pipelines de producto que
declarás en `operations.json → deployments` (abajo). Qué identidad lee depende de la opción anterior: con *Limit job
authorization scope* apagada es la de la **colección**, `Project Collection Build Service (<organización>)`; prendida, la
del proyecto. Esa identidad necesita, en *Pipelines → Security* de **cada proyecto de producto**, **View builds** y
**View build pipeline**. Sin esos permisos el tablero se genera igual y cada pipeline sale «no medido» con
`sin_permiso`, nunca «sin despliegue».

Qué declarar: el proveedor y, por producto, los pipelines de `staging` y de `production` con el **identificador
exacto** de cada stage que despliega (el nombre del stage en el YAML, no el que se ve en la pantalla). La pestaña
Configuración del sitio los propone leyendo la última corrida terminada de main, y guarda sólo lo que confirmás. El
ejemplo `examples/operations.json` trae la forma. Un producto sin declarar sale «no medido».

## 4. Dar de alta los tres pipelines

Por cada YAML: *Pipelines → New pipeline → Azure Repos Git → operations → Existing Azure Pipelines YAML file*, elegí la
ruta (`/pipelines/stage-metrics.yml`) y *Save* (no *Run*). Nombres sugeridos: `stage-metrics`, `dependency-audit`,
`team-dashboard`. Con la línea de comandos es lo mismo:

```bash
az pipelines create --name stage-metrics --repository operations --repository-type tfsgit --branch main \
  --yml-path pipelines/stage-metrics.yml --skip-first-run --project my-project
```

Variables opcionales de cada definición (*Edit → Variables*):

| Pipeline | Variable | Para qué |
|---|---|---|
| `stage-metrics` | `METRICS_PROJECTS` | Los proyectos a medir, separados por `;`. Vacía: todos los que la identidad puede ver |
| `dependency-audit` | `TYCON_TELEGRAM_CHAT_ID` y `TELEGRAM_BOT_TOKEN` (secreta) | El resumen diario, si el canal es `telegram`. Usá un bot dedicado al aviso: el token de un bot sirve para mandar a cualquier chat y para leer lo que le escriben |
| `dependency-audit` | `TYCON_NOTIFY_WEBHOOK_URL` (secreta) | El resumen diario, si el canal es `slack` o `teams`: la dirección del webhook entrante (en Teams, la de un flujo de trabajo «When a Teams webhook request is received»). La dirección ES la credencial: nunca va en un archivo |

**El canal del aviso.** Lo elige `operations.json → notify`: `{ "channel": "telegram" }`, `"slack"` o `"teams"`. **Sin
`notify`, no se manda**, y la constancia de la noche lo dice («canal sin configurar en operations.json → notify»). El
destino (el chat, el token, el webhook) va sólo en las variables secretas de arriba. El aviso lleva sólo cantidades y,
si `operations.json → site.url` está y el sitio pasó esa mañana la prueba sin sesión, el enlace al sitio.

Las copias del repo del arnés ya no van en variables de la definición: van en `team-repos.json` (punto 2). Si tu
definición de `stage-metrics` todavía tiene `HARNESS_COPIES` o `HARNESS_MEASURED_COPY`, borralas: la corrida lo avisa, y
sale en rojo mientras `team-repos.json` no declare las copias.

El tablero tiene un parámetro opcional, `mailboxConnection`: la conexión de servicio de Azure con lectura sobre un buzón
de corridas, si tu organización junta los registros de las máquinas. Sin buzón, las fichas del equipo salen «no leído».

Los pedidos de trabajo (un Bug por proyecto con hallazgos) se prenden en `repos.json`, `azure.pedidos_activos: true`.
Antes, la identidad necesita en esos proyectos permiso para crear y comentar work items y para leer grupos. Apagados, los
dos pasos que hablan con Azure Boards no corren.

## 5. La primera corrida: sin efectos

Corré cada pipeline a mano con el parámetro **efectos** destildado (*Run pipeline → efectos*). Mide y escribe en el
disco del agente, pero no guarda nada ni abre pull requests. La primera vez Azure pide permiso para usar el repo del
arnés (*This pipeline needs permission to access a resource*): *Permit*.

Mirá que termine en verde. Si sale «NO MEDIDO» o «Repos NO medidos», es un permiso de lectura que falta (punto 3).

## 6. La primera corrida de verdad, en orden

Con efectos, a mano, en este orden (es el mismo de la noche):

1. `stage-metrics` — deja el punto del día. El tablero lo necesita.
2. `dependency-audit` — deja la foto de la noche. **La primera noche es la línea base**: lista lo que encuentra y no
   abre nada, porque no hay con qué comparar. Desde la segunda abre un pull request por cada hallazgo (como mucho dos
   por noche, más las críticas: `presupuesto_de_ruido` en `repos.json`). La cola de fichas (`inbox/dependencies/`) la
   crea la primera corrida.
3. `team-dashboard` — arma la página y la guarda.

Después quedan programados solos: métricas 06:00 UTC, dependencias 04:00 UTC, tablero 08:30 UTC. Para cambiar el
horario, el `cron` de cada YAML.

## 7. Qué mirar después

- **Los pull requests de la revisión de dependencias**, en el repo de operaciones. Aprobar es «lo vimos, se arregla»;
  rechazar pide el motivo, y esa decisión la registra la noche siguiente.
- **La página del tablero**: `artifacts/tablero-del-arnes.html` del repo de operaciones (bajala y abrila en el
  navegador).
- **Lo que deja la noche para el sitio de la organización** (story 2.23): `team-dashboard` corre además dos productores
  y los guarda con la página: `.dashboard/open-prs/open-prs-<día>.json` (los pull requests abiertos: número, proyecto,
  repo, días, la identidad del autor y el enlace) y `.dashboard/assigned/assigned-<día>.json` (los pedidos abiertos con
  alguien asignado, de los proyectos de `repos.json`: id, tipo, estado, la identidad del asignado, días en el estado,
  enlace y si es un Bug de dependencias). **Nunca títulos.** El sitio lee sólo el repo de operaciones (y el buzón): no
  consulta Azure DevOps. Si una consulta falla, el archivo dice `no_medido` y el paso avisa sin frenar la página. La
  clave `site` de `operations.json` (mantenedores, buzón, refresco) la lee el sitio; ver el ejemplo.
- **Una corrida en rojo** dice en su primer error por qué. Las causas de siempre: un permiso del punto 3, un JSON que no
  valida, o el repo de operaciones sin rama `main`.

## 8. El vigilante de producción (apagado de fábrica)

El cuarto nocturno, `scripts/nightly/watcher/vigilante.js`, mira la API de administración de los hosts de BIZUIT
Extensions de la organización, agrupa lo que huele mal por debajo de las alertas de la nube y deja un borrador por
hallazgo en `inbox/watcher/pending/` para que una persona decida (`/tycon-vigilante`). **No toca nada.**

Viene apagado: sin configuración no mira nada, lo dice en una línea y sale 0. Para prenderlo:

- copiá `examples/hosts.json` a `scripts/nightly/watcher/hosts.json` del repo de operaciones, con un producto por host
  (`env_user`/`env_pass` NOMBRAN las variables de entorno con las credenciales; nunca las traen);
- en el pipeline que lo corra, pasale `--config` con esa ruta, `--out .dashboard/vigilante` y
  `--pending inbox/watcher`, y las credenciales como variables secretas.

El modelo de ese pipeline todavía no está en esta carpeta: es lo siguiente.

## 9. La copia para el sitio de la organización (opcional)

Si el sitio de la organización vive en Azure, puede leer el repo de operaciones **sin ninguna credencial del repo**: un
pipeline más, `site-copy.yml`, copia lo que el sitio lee a un contenedor de almacenamiento, y el sitio lo lee con su
identidad administrada (`SITE_OPERATIONS_SOURCE=copy`). Qué forma conviene según dónde vive el sitio, y lo que cuesta
cada una: la guía del sitio (`guides/organization-site.md`, «De dónde lee operaciones»).

1. **El contenedor**: lo crea el alta del sitio (`azure-container-apps.js`), en una cuenta con la llave apagada.
2. **La conexión de servicio del trabajo que copia** (*Project settings → Service connections → Azure Resource Manager,
   Workload identity federation*), con el rol «Storage Blob Data Contributor» sobre **ese contenedor** y nada más. Es
   propia: ni la del sitio, que sólo lee, ni ninguna que vea el buzón de corridas.
3. **El pipeline**: copiá `site-copy.yml` a `pipelines/` del repo de operaciones, cambiá las dos líneas marcadas (el
   recurso `harness` y `azureSubscription` con el nombre de la conexión) y cargá las variables `SITE_COPY_ACCOUNT` y
   `SITE_COPY_CONTAINER`. Corre en cada push a `main` (también el que hacen los nocturnos al guardar) y una vez por día.
4. **La primera corrida** tiene que salir verde y decir «subida la foto de <commit>». Recién entonces el sitio pasa a
   `SITE_OPERATIONS_SOURCE=copy`.

Si una corrida falla, el índice queda como estaba y el sitio sigue con la copia anterior. Con una copia de más de 24
horas, quienes mantienen ven la banda; con más de 48, el sitio se frena, como cuando el repo no se puede leer.

## 10. El sitio al día con stable (opcional)

Un pipeline más, `site-update.yml`, mantiene el sitio de la organización al día con la etiqueta `stable` de su imagen
(la que el arnés mueve sólo cuando la imagen pasó el escáner y tiene su firma). Corre cada noche a las 03:00 UTC, una
hora antes de dependencias, que prueba el sitio y arma el resumen de la mañana. Qué hace en cada caso y cómo se elige
automático o sólo aviso: la guía del sitio («Cómo se mantiene al día»).

1. **La conexión de servicio del nocturno** («site-update», Workload identity federation), autorizada sólo para este
   pipeline, con un **rol propio** sobre la aplicación del sitio y nada más. La guía trae el rol y la orden que lo crea.
   Es propia: ni la de la copia de operaciones, ni la del buzón, ni la de dependencias.
2. **El pipeline**: copiá `site-update.yml` a `pipelines/` del repo de operaciones y cambiá las dos líneas marcadas. Las
   variables son `SITE_PLATFORM` (`azure`), `SITE_IMAGE_NAME`, `SITE_RESOURCE_GROUP`, `SITE_APP` y `SITE_URL`. En
   Render: `SITE_PLATFORM=render` y la variable secreta `SITE_RENDER_DEPLOY_HOOK`.
3. **El modo**: sin `site.update` en `operations.json`, sólo aviso. `"auto"` se elige desde la pestaña Configuración,
   después de una actualización a mano que salió bien.
