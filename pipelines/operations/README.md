# Los procesos de la noche, en tu organización de Azure DevOps

Tres pipelines que corren solos cada noche sobre los repos de tu organización y guardan lo que encuentran en un repo
tuyo, el **repo de operaciones**:

| Pipeline | Qué hace | Qué deja en el repo de operaciones |
|---|---|---|
| `stage-metrics.yml` | Mide el ciclo de las stories de los repos que usan el arnés | `.dashboard/sdlc-stage-<fecha>.json` y `.dashboard/proyectos/` |
| `dependency-audit.yml` | Busca dependencias con vulnerabilidades conocidas en los repos que declares, y abre un pull request por hallazgo | `.dashboard/dependencias/` e `inbox/dependencies/` |
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
| `operations.json` | A quién se asignan los pedidos de trabajo y quiénes revisan los pull requests. Forma: `scripts/lib/operations-config.js` | Sí, para la revisión de dependencias |
| `scripts/nightly/dependencies/repos.json` | Qué repos mira la revisión de dependencias (`ado`: `<proyecto>/<repo>`; `tipo`: `npm` o `nuget`) | Sí, para la revisión de dependencias |
| `team-repos.json` | Opcional. Dónde vive cada repo del arnés de tu organización (forma: `scripts/lib/team-repos.js`). Si está, tiene que validar: con `operations.platform: github` los avisos de dependencias son issues de GitHub, no pedidos de trabajo | No |
| `scripts/nightly/dashboard/sources.json` | Qué fuentes espera el tablero. Usá el ejemplo: el del arnés espera fuentes que tu organización no tiene | Sí, para el tablero |
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
| `stage-metrics` | `HARNESS_COPIES`, `HARNESS_MEASURED_COPY` | Sólo si tu organización tiene copias del repo del arnés con stories: cuáles son y cuál cuenta |
| `dependency-audit` | `TYCON_TELEGRAM_CHAT_ID` y `TELEGRAM_BOT_TOKEN` (secreta) | El resumen diario por Telegram. Sin el chat, no se manda |

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
