# Un paquete de revisores propio

El arnés trae revisores generales: seguridad, pruebas, fallos silenciosos, cobertura de los criterios. No trae uno por
framework. Los errores propios de tu stack (un `{@html}` sin limpiar en Svelte, una llamada bloqueante en FastAPI) los
mira un revisor que tu organización escribe y trae en un **paquete**.

Hay un paquete de ejemplo para copiar en `examples/packs/svelte-fastapi/`, con dos revisores chicos y sus casos de
examen. No viene instalado ni activo.

En inglés: [reviewer-packs.en.md](reviewer-packs.en.md).

## Qué lleva un paquete

```text
mi-paquete/
  pack.json                      el manifiesto: qué revisores trae y cuándo corre cada uno
  agents/<revisor>.md            cada revisor: sus instrucciones y su catálogo de reglas
  exam/<revisor>.json            los casos del examen (no viajan con el perfil del equipo)
```

Un paquete puede traer además `skills/`, `guides/`, `templates/` y `claude-md-blocks/`. El formato completo del
manifiesto está en [agent-architecture.md](agent-architecture.md), sección «Paquetes de revisores».

**El revisor** es un `.md` con frontmatter (`name`, `tools`, `model`, `description`) y un catálogo de reglas. Cada regla
tiene un ID con el prefijo del revisor (`FASTAPI-C1` es crítica, `FASTAPI-W1` es un aviso), y cada hallazgo sale como
`- [FASTAPI-C1] archivo:línea …`. Copiá uno de los dos del ejemplo y cambiale el nombre, el prefijo y las reglas. Dos
paquetes no pueden declarar el mismo agente.

## Cuándo corre un revisor

Lo decide `when` en `pack.json`. El vocabulario es cerrado (`detection`, `files`, `added`, `all`, `any`, `no`): una clave
que no existe hace inválido al paquete.

| Condición | Corre cuando |
|---|---|
| `{ "detection": "pyModified" }` | el diff toca un `.py` (`svelteModified`, `vueModified`, `tsxModified`, `csModified`, `sourceModified`, `codeModified` y las demás banderas de la sección «Paquetes de revisores») |
| `{ "files": "(^\|/)app/routers/" }` | alguna ruta del diff coincide con la expresión regular |
| `{ "added": { "pattern": "from fastapi", "extensions": [".py"] } }` | alguna línea agregada de esos archivos coincide |
| `all`, `any`, `no` | combinan las anteriores |

El ejemplo usa una bandera sola: el revisor de FastAPI corre con cualquier `.py`, aunque el archivo no tenga nada de
FastAPI (el revisor contesta `✅ OK`). Si tu repo tiene mucho Python que no es web, acotalo:
`{ "all": [ { "detection": "pyModified" }, { "added": { "pattern": "fastapi|APIRouter", "extensions": [".py"] } } ] }`.

`surface` dice qué archivos lo vuelven a correr en cada vuelta de revisión; `depth` (`lean`, `standard`, `deep`) dice
qué tan caro es el modelo que lo corre.

## Cómo se activa

**Con el perfil del equipo** (el camino de siempre):

1. Copiá `pack.json` y `agents/` a `packs/<tu-paquete>/` en el repo del perfil de tu equipo. No copies `exam/` ni el
   `README.md`: la capa del equipo acepta una lista cerrada de rutas y, con un archivo fuera de ella, no se apila en
   ninguna máquina.
2. Activalo con `packs.default` en `team-profile.json` (`"all"` o una lista con su nombre), o en la pestaña
   Configuración del sitio, sección Paquetes.
3. Cada máquina lo recibe con su próxima actualización: el arnés lo pone en su carpeta de paquetes y enlaza sus agentes.

Un repo puede achicar la lista con `packs:` en su `.tycon/advisors.yaml` (`packs: []` es ninguno), nunca sumar.

**Para probarlo en tu máquina sin tocar el perfil**:

```bash
export TYCON_PACKS_DIR=<carpeta que contiene tu paquete>   # p. ej. la que tiene mi-paquete/
export TYCON_PACKS_DEFAULT=<tu-paquete>
```

Con esas dos variables el pipeline elige tus revisores. Para lanzarlos, tu herramienta tiene que encontrar sus `.md`:
en Claude Code, copialos a `~/.claude/agents/` o a `.claude/agents/` del repo. Con el perfil del equipo eso lo hace el
arnés.

## Cómo se valida y se ve cuándo corre

`pipeline.js advisors` valida el paquete y dice qué revisores corren para los archivos que le pases. Un paquete roto
sale con código 2 nombrando el archivo, el revisor y el motivo. Hacelo en un repo de prueba y fuera de una corrida del
pipeline: el comando anota el arranque de los revisores en el registro de la sesión. `<arnés>` es la carpeta donde está
instalado el arnés (por defecto `~/.tycon/harness`).

```bash
mkdir /tmp/prueba && cd /tmp/prueba && git init -q && mkdir app && echo 'x = 1' > app/util.py
TYCON_PACKS_DIR=<carpeta> TYCON_PACKS_DEFAULT=<tu-paquete> \
  node <arnés>/skills/tycon-pipeline/scripts/pipeline.js advisors --repo /tmp/prueba --files app/util.py
```

En la salida, `all` trae el set de revisores y `packs` dice qué paquetes cargó.

## Cómo se examina un revisor

Un revisor es un pedido a un modelo: se prueba con casos. Por cada regla, un caso que la tiene que marcar
(`must-flag`) y su gemelo corregido, que no (`must-not-flag`). Cada caso trae sus archivos y aprueba por la presencia
o ausencia del ID de la regla en el reporte. Marcá un par como `"canario": true`. El formato está en
`exam/*.json` del ejemplo: cada archivo declara su `advisor` y cada caso su `id`, su `type` (`must-flag` o
`must-not-flag`), su `rule` y sus `files` (rutas relativas que no salen de la carpeta del caso, contenido de texto); como
opcionales, `git_commits`, `prompt`, `canario` y `nota`, y nada más. Un caso fuera de ese formato frena el examen con el
motivo, y un examen que no juzgó todos sus casos no sale verde.

```bash
cd <arnés>
node scripts/controls-bench/advisor-runner.js --pack <carpeta de tu paquete> --list            # qué casos corre
node scripts/controls-bench/advisor-runner.js --pack <carpeta de tu paquete> --tool claude --runs 2
```

`--pack` corre sólo los casos de `<paquete>/exam/`, con los agentes de la carpeta del paquete; el informe queda en
`scripts/controls-bench/.bench/pack-<nombre>-<huella>-claude.json` (la primera línea de la salida dice cuál). Corre
sólo con Claude, sin `--baseline` ni `--liveness`. Si no queda ningún caso para correr (un `--only` que no coincide,
un archivo de casos vacío), frena: un examen que no corrió nada nunca sale verde. Cada pasada cuesta unos dos minutos
de modelo.

**Examiná sólo paquetes que leíste**: `--pack` corre los revisores del paquete con tu usuario y con las herramientas que
cada revisor declara en su frontmatter (`tools`). El examen rechaza los casos que escriben fuera de su carpeta o plantan
configuración de git o de la herramienta, pero un revisor que declara una herramienta para correr comandos la usa.

**Rojo antes, verde después**: escribí los casos de una regla nueva antes que la regla y corrélos. Los `must-flag`
tienen que salir en rojo, porque el revisor todavía no la conoce. Después escribí la regla y volvé a correrlos: los dos
casos tienen que salir en verde. Un `must-flag` que sale verde antes de escribir la regla no prueba nada: el caso es
demasiado obvio o se apoya en otra regla.

**Dónde viven los casos**: en el repo donde tu organización arma y examina el paquete, no en el perfil del equipo. Los
usa quien mantiene el paquete, no cada máquina.
