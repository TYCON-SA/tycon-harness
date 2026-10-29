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
  exam/<revisor>.json            los casos del examen (viajan con el paquete, como datos)
```

Un paquete puede traer además `skills/`, `guides/`, `templates/` y `claude-md-blocks/`. El formato completo del
manifiesto está en [agent-architecture.md](agent-architecture.md), sección «Paquetes de revisores».

**El revisor** es un `.md` con frontmatter (`name`, `tools`, `model`, `description`) y un catálogo de reglas. Cada regla
tiene un ID con el prefijo del revisor (`FASTAPI-C1` es crítica, `FASTAPI-W1` es un aviso), y cada hallazgo sale como
`- [FASTAPI-C1] archivo:línea …`. Copiá uno de los dos del ejemplo y cambiale el nombre, el prefijo y las reglas. Dos
paquetes no pueden declarar el mismo agente.

**Las instrucciones de un revisor viven en su paquete**: en `packs/<paquete>/agents/<revisor>.md`, o en la carpeta que
declare `agents` en el `pack.json`. Uno que sólo está en `agents/` de la raíz del perfil es un problema, y el pipeline lo
dice en llano: «las instrucciones de X tienen que estar en packs/<paquete>/agents/X.md (hoy están en agents/X.md)».
Para mudarlo, se mueve el archivo a la carpeta de su paquete; en los dos lugares a la vez también es un problema.

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

**Un revisor que compara con otros repos** (por ejemplo, con proyectos hermanos del tuyo) los declara en `siblings` del
manifiesto (`[{ "path": "Producto/Repo", "name": "Repo" }]`, rutas relativas a la raíz de repos). El arnés no los busca:
mira si cada uno está en su ruta esperada. En el grupo `validacion`, el `prompt` los recibe con `{siblings}`, una línea
por repo: «Repo: <ruta> (está)» o «… (NO está en esta máquina: no lo busques en otro lado)». Cualquier revisor los pide
con `node <arnés>/skills/tycon-pipeline/scripts/pipeline.js siblings --repo <repo>`. Que el revisor no rastree el disco
por su cuenta: desde una raíz como `D:\` cae en repos que no son los que querés comparar.

## Cómo se activa

**Con el perfil del equipo** (el camino de siempre):

1. Copiá `pack.json`, `agents/` y `exam/` a `packs/<tu-paquete>/` en el repo del perfil de tu equipo. No copies el
   `README.md`: la capa del equipo acepta una lista cerrada de rutas y, con un archivo fuera de ella, no se apila en
   ninguna máquina. Los casos de `exam/` viajan como datos: un nivel, sólo `.json`.
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

**Dónde viven los casos**: al lado del paquete, en `packs/<tu-paquete>/exam/` del repo del perfil. Viajan como datos y
nada los carga como instrucciones: los usa quien corre el examen.

## Si trabajás solo

Esta sección es para el agente, cuando una persona que trabaja sola le pide revisores para su stack («armame revisores
para Svelte y FastAPI»). Un paquete propio va en el repo del perfil, aunque sea de una persona: es lo único que
sobrevive a las actualizaciones.

Lo que nunca se hace: escribir el paquete en la instalación del arnés (`~/.tycon/harness/packs/`, o
`~/.claude/agent-skills/packs/`, que es lo mismo). El arnés lo niega, y la próxima actualización lo borraría. Tampoco
se pone `packs.default` en la configuración de la máquina (`~/.claude/tycon.json`) para un paquete del perfil: va en
`team-profile.json`.

1. **El perfil.** Si `harness.js doctor` no muestra un perfil del equipo, armá uno local:
   `harness.js team-init --local --name <nombre>`. Queda en `~/<nombre>-profile`, en un repo git de la máquina con un
   commit en `main`, sin cuenta ni dirección. Si ya hay un perfil, usá ése.
2. **El paquete.** Armalo en `packs/<nombre>/` del repo del perfil, con su `pack.json`, sus `agents/` y sus casos en
   `exam/`. El ejemplo `examples/packs/svelte-fastapi/` es el modelo; cambiale el nombre, los prefijos y las reglas.
3. **Activarlo.** En `team-profile.json` del perfil, `packs.default` con su nombre (`["<nombre>"]`).
4. **Commit.** `git add -A && git commit` en la carpeta del perfil. El arnés lee sólo lo commiteado en `main`.
5. **Traerlo.** `npx @tyconsa/harness@latest`, o la primera vez `harness.js install --team <carpeta del perfil>`. Después,
   `pipeline.js advisors` (como en «Cómo se valida») tiene que nombrar el paquete en `packs`.
6. **El examen.** `advisor-runner.js --pack <carpeta del perfil>/packs/<nombre> --tool claude --runs 2`, como en «Cómo
   se examina un revisor». Cuesta unos dos minutos de modelo por pasada: avisale antes a la persona.
7. **Contarle qué revisa.** Leé el catálogo de cada revisor (su `.md` en `agents/`) y decile a la persona, en castellano
   llano y sin los IDs, qué mira cada regla, cuáles frenan la historia y cuáles sólo avisan, y cuántos casos del examen
   salieron bien.
8. **La copia de respaldo, una sola vez.** Un perfil local vive sólo en esa máquina: `doctor` lo muestra como aviso. Ofrecé
   una sola vez subirlo a GitHub o a Azure DevOps: un repo privado vacío, y desde la carpeta del perfil
   `git remote add origin <dirección>` y `git push -u origin main`; después `harness.js install --team <dirección>`,
   para que el arnés lo lea de ahí. Si dice que no, no lo vuelvas a ofrecer: el aviso de `doctor` queda, y no frena nada.
