# Cómo contribuir

Pull requests are welcome. This repository is where the harness is written, not an exported copy: send your change as a pull request to `main`. Anyone can send one with code: it runs the repository's validation, and TYCON reviews it and decides. If it is accepted, it is merged here, with your commits. A pull request from a fork runs the same validation once a maintainer approves the run (see «From a fork» below). Contributions are accepted under the Apache License 2.0, with no CLA. Issues and pull requests are welcome in English or in Spanish.

## In English, in short

- **Where**: a pull request to `main` of this repository. The harness used to live in one private repository, with the
  core and each team's own material together. When it was opened, it was split: the core lives here, and each team
  keeps its own material in its own private repository.
- **From a fork**: fork the repository, make a branch, and open a pull request to `main`. Because you are an outside
  contributor, the CI waits until a maintainer clicks «Approve and run workflows»: this is for safety, so code from
  outside does not run before someone has looked at it. After that, the CI runs as on any other pull request.
- **Big change? Open an issue first**: say what you want to do, so we can agree on it before you work. A small fix can
  go straight to a pull request.
- **Green CI**: the `public-ci` check and CodeQL code scanning must both pass. Run the CI locally with
  `bash scripts/ci/public-ci.sh` (it is long: the portable suites alone take about an hour), or only the suites near
  your change (see «Antes de abrir un pull request» below).
- **No real names**: examples, tests and docs use made-up names (`acme`, "Client A"), never a real client, person,
  server or machine. TYCON's name check (`scripts/publishing/new-names.js`) blocks them; if it flags your change, we
  ask you to swap the name for a made-up one.
- **Controls need the maintainer's approval**: a control is a check that blocks a commit or a pull request (a hook, a
  CI script, a case of the controls bench). Loosening one, or touching `.github/workflows/ci.yml`, stays red until the
  maintainer signs it, and that can take a while.
- **License**: Apache-2.0, the one in [`LICENSE`](../LICENSE).
- **Security**: never in a public issue; [SECURITY.md](SECURITY.md) has the private channels.

## Los pull requests son bienvenidos

Este repo es donde se escribe el arnés: no es una copia exportada de otro lado. Antes era un solo repo privado, con el
núcleo y lo de cada equipo juntos. Al abrirlo se dividió: el núcleo quedó acá, y lo de cada equipo, en su propio repo
privado. Por eso un cambio al núcleo va como pull request a `main` de este repo. Cualquiera puede mandar uno con código. Corre la validación del repo, y TYCON lo revisa y decide:

- **Si se acepta**, se mergea acá, con tus commits: el crédito queda en la historia del repo.
- **Si no se acepta**, se cierra con su motivo.

**Antes de un cambio grande, abrí un issue** contando qué querés hacer, así lo acordamos antes de que trabajes. Un
arreglo chico puede ir directo como pull request.

## Desde una copia del repo (un fork)

Si nunca colaboraste en este repo, el camino es éste:

1. Hacé un fork: tu propia copia del repo en tu cuenta de GitHub.
2. En tu copia, creá una rama y hacé ahí tu cambio.
3. Abrí un pull request de esa rama a `main` de este repo.
4. Esperá a que un mantenedor apruebe la corrida. Como venís de afuera, la CI no arranca sola: un mantenedor aprieta
   «Approve and run workflows». Es por seguridad, para que el código de afuera no corra sin que alguien lo mire antes.
5. Después la CI corre como en cualquier pull request, y lo que tiene que dar verde es lo mismo (la sección siguiente).

## Lo que tiene que dar verde

Para entrar a `main`, un pull request necesita dos cosas en verde:

- **`public-ci`**, el chequeo de la CI (`.github/workflows/ci.yml`). Corre `scripts/ci/public-ci.sh` partido en
  varios trabajos, más un ensayo en Windows.
- **CodeQL**, el análisis de código de GitHub. Frena el merge con una alerta de nivel error o una alerta de seguridad
  alta o crítica. Corre sólo en GitHub: no hay forma de correrlo en tu máquina.

## Antes de abrir un pull request

Lo mismo que corre la CI, desde la raíz del repo:

```bash
bash scripts/ci/public-ci.sh
```

Sale 0 sólo si todos sus pasos salen verdes, y un paso que no pudo correr cuenta como rojo. La CI lo corre en Node 22 y
24. Es largo: las suites portables solas tardan cerca de una hora.

Mientras trabajás alcanza con las suites cercanas a lo que tocaste. Cada una se corre sola, con su ruta dentro de
`scripts/` (la lista está en `scripts/tests/suites.json`):

```bash
TYCON_PORTABLE_ONLY=tests/repo-papers.test.js bash scripts/tests/portable-suites.test.sh
```

Corre esa suite con una HOME vacía, como la CI. Varias van separadas por coma. La guía
[`guides/test-execution-discipline.md`](../guides/test-execution-discipline.md) explica por qué no conviene correr todo
mientras se itera.

## Lo que se escribe

Dos reglas, las mismas que sigue el equipo:

1. **Lo que ejecuta la máquina, en inglés**: nombres de archivos, opciones, variables, claves de configuración,
   funciones. Los mensajes y los comentarios pueden ir en castellano. La guía es
   [`guides/maintaining/nombres-en-ingles.md`](../guides/maintaining/nombres-en-ingles.md). La CI lo controla en el
   paso `spanish-names`; si salta, renombrá a inglés lo que señala.
2. **Los ejemplos, con nombres inventados** (`acme`, «Cliente A»): ningún cliente, persona, servidor o máquina de
   verdad, ni en el código ni en las pruebas ni en la documentación. Lo frena el control de nombres de TYCON
   (`scripts/publishing/new-names.js`). La lista de nombres que mira es privada, así que la CI de tu pull request no la
   tiene: corre del lado de TYCON. Si salta, te pedimos que cambies el nombre por uno inventado y empujes de nuevo.

## Los cambios a un control

Un control es una comprobación que frena un commit o un pull request: un hook, un guion de `scripts/ci/`, un caso del
banco de controles. La CI juzga cada pull request con los controles de `main`, no con los que trae el propio pedido.

- **Endurecer** un control, o sumar uno nuevo, entra solo.
- **Aflojarlo** (lo que `main` frena y el pedido deja pasar) queda en rojo hasta que el mantenedor lo aprueba. Cualquier
  cambio a `.github/workflows/ci.yml` también pide esa aprobación.

La aprobación la da una persona, así que puede demorar. Conviene explicar en el pull request por qué hace falta aflojar.

## Licencia

Una contribución entra bajo la misma licencia del repo, Apache-2.0, la de [`LICENSE`](../LICENSE) (la sección 5: lo
que se envía para incluir en el trabajo queda bajo sus términos). No hay CLA que firmar.

## Idioma

Los issues y los pull requests pueden ir en castellano o en inglés.

## Conducta y seguridad

Participar en este repo es aceptar el [código de conducta](CODE_OF_CONDUCT.md). Una vulnerabilidad no se reporta en un
issue público: [SECURITY.md](SECURITY.md) dice cómo reportarla en privado.
