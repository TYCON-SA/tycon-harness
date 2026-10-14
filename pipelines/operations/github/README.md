# Los procesos de la noche, en tu organización de GitHub

Tres workflows de GitHub Actions que corren solos cada noche sobre los repos de tu organización y guardan lo que
encuentran en un repo tuyo, el **repo de operaciones**. Es lo mismo que [los pipelines de Azure DevOps](../README.md),
para una organización que vive en GitHub:

| Workflow | Qué hace | Qué deja |
|---|---|---|
| `stage-metrics.yml` | Mide el ciclo de las stories de los repos que usan el arnés | `.dashboard/sdlc-stage-<fecha>.json` y `.dashboard/proyectos/` en el repo de operaciones |
| `dependency-audit.yml` | Busca dependencias con vulnerabilidades conocidas en los repos que declares, y abre un **issue** en el repo del producto por cada hallazgo | `.dashboard/dependencias/` e `inbox/dependencies/` en el repo de operaciones; los issues, en cada producto |
| `team-dashboard.yml` | Arma una página con todo lo anterior | `artifacts/tablero-del-arnes.html` en el repo de operaciones |

Esta página es para quien administra la organización de GitHub. Lleva una hora la primera vez. No hace falta instalar
nada en una máquina: todo pasa en GitHub.

## 1. Lo que necesitás antes

- **Permiso de dueño (owner) de la organización**, o de administrador del repo de operaciones y de los repos a mirar.
- **Una identidad para la noche, con su credencial.** Los workflows necesitan leer los repos de la organización y
  escribir issues en los de los productos; el token propio de un workflow sólo ve su repo. Recomendado: **un usuario de
  máquina** (una cuenta de GitHub sólo para esto, miembro de la organización) con un **token de acceso fino**
  (*Settings → Developer settings → Personal access tokens → Fine-grained tokens*), con dueño la organización, acceso a
  los repos a medir y a mirar, y estos permisos de repositorio: *Contents: Read*, *Issues: Read and write*,
  *Metadata: Read*.
  - **No uses tu token personal.** Con él, lo que hace la noche y lo que hacés vos salen de la misma cuenta, y la noche
    deja de poder distinguir un issue que cerraste vos de uno que cerró ella (lo marca en el texto, pero cerrar o
    etiquetar sin comentar se lee como suyo).
  - Un token fino **vence** (como mucho al año, o antes si la organización lo pide). El día que vence, la revisión de
    dependencias sale en rojo con «la credencial no sirve (401)» y las métricas con «No se pudieron listar los repos».
    Se renueva el token y se reemplaza el secreto (punto 3).
  - Una GitHub App también sirve para leer y escribir, pero su identidad no se puede leer con el token: declarala en
    `github.identity` de `repos.json` (punto 2).
- **Que los repos a medir usen el arnés.** Las métricas sólo cuentan los repos que tienen la carpeta `.tycon/` o
  `.advisors/`. Un repo sin ninguna de las dos no se mide (no es un error).

## 2. El repo de operaciones

Creá un repo **privado**, por ejemplo `operations`, con una rama `main`. Sus archivos van en las **mismas rutas** en que
los lee el arnés (los ejemplos están en `pipelines/operations/examples/github/` del arnés):

| Ruta en el repo de operaciones | Qué es | Obligatorio |
|---|---|---|
| `team-repos.json` | Dónde vive cada repo del arnés de tu organización. `public`: el repo público del arnés (de ahí lo traen los workflows); `operations`: este repo (si no coincide, la noche sale en rojo); `profile`: el perfil de tu equipo (si no tenés uno, poné este repo). Forma: `scripts/lib/team-repos.js` | Sí |
| `operations.json` | A quién se asignan los issues (`owners.default`, y `owners.by_project` con la clave `<dueño>/<repo>`). Identidades: usuarios de GitHub. Forma: `scripts/lib/operations-config.js` | Sí, para la revisión de dependencias |
| `scripts/nightly/dependencies/repos.json` | Qué repos mira la revisión de dependencias (`github`: `<dueño>/<repo>`; `tipo`: `npm` o `nuget`) y el bloque `github` (`issues_enabled`, `identity`) | Sí, para la revisión de dependencias |
| `scripts/nightly/dashboard/sources.json` | Qué fuentes espera el tablero. Usá el de `pipelines/operations/examples/sources.json` | Sí, para el tablero |
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

## 3. Secretos, variables y permisos del repo de operaciones

En el repo de operaciones, *Settings → Secrets and variables → Actions*:

| Tipo | Nombre | Para qué |
|---|---|---|
| Secreto | `HARNESS_ORG_TOKEN` | La credencial del punto 1. Obligatorio para las métricas y la revisión de dependencias |
| Variable | `HARNESS_REF` | La rama, el tag o el commit del arnés que corre cada noche. Vacía: `main`. **Recomendado: un tag o un commit**, y subirlo a conciencia: cada noche el arnés corre con la credencial de tu organización |
| Variable | `METRICS_OWNERS` | Los dueños cuyos repos miden las métricas, separados por `;`. Vacía: el dueño de este repo |
| Variable | `METRICS_REPO_PREFIX` | Si la organización mezcla repos de otros equipos: sólo los que empiezan así |
| Variable y secreto | `TYCON_TELEGRAM_CHAT_ID` y `TELEGRAM_BOT_TOKEN` | El resumen diario de dependencias por Telegram. Sin el chat, no se manda |

Y en *Settings → Actions → General*: *Workflow permissions* puede quedar en «Read repository contents»; cada workflow
pide para sí `contents: write` (para guardar en este repo) y nada más. Si `main` del repo de operaciones tiene reglas de
protección, el token del workflow tiene que poder empujar ahí (o los guardados salen en rojo). Si la organización
restringe qué acciones se pueden usar, permití `actions/checkout`, `actions/setup-node` y `actions/setup-dotnet`
(van fijadas por el commit).

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
- **Una corrida en rojo** dice en su primer error por qué. Las causas de siempre: la credencial (vencida o sin permiso),
  un JSON que no valida, `team-repos.json` que no nombra este repo como `operations`, o el repo de operaciones sin rama
  `main`. Lo que en Azure es «naranja» acá es un aviso amarillo con la corrida en verde: mirá los avisos.

## Diferencias con los pipelines de Azure DevOps

- Los avisos de dependencias son **issues en el repo del producto**, no Bugs de Azure Boards, y **no hay pull request por
  hallazgo** en el repo de operaciones: el issue es el lugar de decidir. Ninguna ficha pasa a `promoted/`.
- No hay buzón de corridas en el tablero: las fichas del equipo salen «no leído».
- Qué arnés corre lo dice `team-repos.json`, no una línea del YAML.
