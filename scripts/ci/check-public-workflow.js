#!/usr/bin/env node
'use strict';
/**
 * check-public-workflow.js — el control del `ci.yml` de la copia pública (épica 8, story 8.7 · AC 16).
 *
 * POR QUÉ EXISTE: el workflow de un repo público corre código de cualquiera que mande un pull request. Un cambio de una
 * línea —el disparador que corre con los permisos del repo de destino, un permiso de escritura, una acción fijada por un
 * tag que alguien puede mover— convierte «correr las pruebas de un desconocido» en «darle el repo». Y el chequeo que las
 * reglas de la rama exigen tiene nombre fijo (`public-ci`): renombrarlo deja los merges esperando un chequeo que no
 * llega. Nada de eso da error al escribirlo; por eso se lee el archivo y se verifica, regla por regla.
 *
 * CÓMO LEE: por TEXTO, línea por línea y por sangría. El repo no tiene un lector de YAML y no lo gana por esto. La
 * contracara: el control exige UNA forma de escribir cada cosa (la del `ci.yml` que hay); otra forma válida de YAML para
 * decir lo mismo sale roja, a propósito.
 *
 * LAS REGLAS (un id por regla; una línea por regla rota). Las doce primeras dicen POR QUÉ algo está mal:
 *   triggers             corre en `pull_request`, en `merge_group` (la cola de merge) y en `push` a `main`, y en nada más
 *   pull-request-target  `pull_request_target` no aparece en ninguna parte (ni en un comentario)
 *   secrets              no lee ningún secreto: ni el contexto de secretos ni el token por otro camino (ni en un comentario)
 *   uses-by-sha          cada `uses:` va fijado por el sha completo (40 hex) de su commit, con el tag como comentario
 *   permissions          un solo bloque `permissions`, arriba de todo, con `contents: read` y nada más
 *   fetch-depth          el checkout trae la historia completa (`fetch-depth: 0`): la necesita `--range`
 *   node-matrix          la matriz es Node 24 y es la que se instala; aparte, el job `installer-floor` instala Node 22 (el
 *                        piso del instalador, 2026-10-16) y es el único que no instala el de la matriz
 *   range                en un pull request y en la cola, `public-ci.sh` corre con `--range origin/<base>...HEAD`
 *   clean-machine        toda llamada a `public-ci.sh` lleva `--clean-machine`
 *   aggregate-job        el job `public-ci` corre siempre, depende de todos los demás y falla si alguno no terminó bien
 *   parts                la matriz parte la corrida en `checks` y `suites-1-of-<n>` … `suites-<n>-of-<n>`, todas, en orden y
 *                        una vez, y la parte llega a public-ci.sh desde la matriz (`TYCON_PUBLIC_CI_PART: ${{ matrix.part }}`):
 *                        una parte que falta deja suites sin correr y el veredicto igual verde (2026-10-14). La única
 *                        otra parte es la fija `installer-floor`, del job del mismo nombre
 *   after-queue          cada job se saltea en el push a main que hace la cola de merge, y SÓLO en ése: la cola ya probó
 *                        ese commit (2026-10-15). La condición es exacta: una que saltea más (todo push, o un pedido) deja
 *                        sin correr un merge directo de un administrador —la salida de urgencia—; el job `public-ci` la
 *                        suma detrás de `always()`, que en los demás eventos sigue mandando
 * …y la decimotercera es la red:
 *   shape                las líneas de código del archivo son EXACTAMENTE las de `SHAPE` (abajo), en ese orden
 *
 * 🔴 POR QUÉ `shape` (pase adversarial del 2026-10-03, 13 clases de hallazgos con la misma enfermedad). Una regla que
 *    busca «lo prohibido» por texto siempre deja pasar OTRA forma de escribirlo: la opción dentro de un comentario de
 *    shell, la llamada con otra ruta, un `|| true` que se traga el rojo, un `exclude` en la matriz, un `if:` en el paso,
 *    un job en estilo flujo (`{ … }`), el token por índice, un escape `\x65`, un retorno de carro suelto que para YAML es
 *    un salto de línea y para un lector por texto no. Perseguirlas una por una no termina. Entonces el control lleva
 *    adentro LA FORMA EXACTA del `ci.yml` que hay: sacadas las líneas vacías y las que son sólo comentario, las líneas
 *    del archivo tienen que ser ésas, literales (con su sangría, sin un comentario al final que la forma no tenga), y en
 *    ese orden. Sólo en las dos líneas `uses:` el sha (40 hex) y el tag del comentario (`# vX.Y.Z`) son un patrón. Antes
 *    de partir en líneas, un `\r` que no va seguido de `\n`, un tabulador o un carácter de control son rojo (un `\r\n`
 *    de Windows se acepta). Lo que ninguna regla con nombre ve, lo frena `shape`.
 * 🔴 CONSECUENCIA BUSCADA: cambiar el `ci.yml` obliga a cambiar `SHAPE` acá, en el mismo commit. No es un descuido que
 *    haya que arreglar relajando la regla: es el punto. Quien cambia lo que corre la CI pública lo dice dos veces, y la
 *    segunda es en un archivo que tiene sus pruebas.
 *
 * EL OTRO WORKFLOW (`--tagger`): `version-tag.yml`, el que le pone a cada merge a main la etiqueta con su número. Es el
 * único con permiso de escritura (sólo para empujar esa etiqueta): se controla con su propia forma exacta
 * (`TAGGER_SHAPE`) y con las reglas que valen para cualquier workflow de un repo público.
 *
 * EL TERCERO (`--publisher`, story 8.40): `npm-publish.yml`, el que publica el instalador de npm con trusted publishing.
 * Es el único que pide la identidad de la corrida (`id-token: write`): su forma exacta (`PUBLISHER_SHAPE`), las reglas de
 * cualquier workflow público y cinco propias (`publisher-trigger`, `publisher-enabled`, `publisher-permissions`,
 * `publisher-npm`, `publisher-stage`). `WORKFLOWS` son los únicos tres archivos que puede haber en `.github/workflows/`.
 *
 * USO:  node scripts/ci/check-public-workflow.js [--tagger|--publisher] <archivo>
 *   0 = cumple todo · 1 = alguna regla rota (una línea `❌ check-public-workflow: <regla> — <qué>` por regla) ·
 *   2 = no pude leer el archivo (no es un verde)
 * Lo corre scripts/tests/public-ci.test.sh sobre el `ci.yml` real y sobre copias alteradas: una por regla y una por cada
 * clase del pase adversarial.
 */

const fs = require('fs');

const INVOCATION = /\bbash\s+scripts\/ci\/public-ci\.sh\b/;

/**
 * La condición de cada job: verdadera en todo evento menos el push a main que hace la cola de merge al entrar un pedido
 * (quien empuja es su bot). Ese commit ya lo probó la cola; cualquier otro push a main corre entero.
 */
const AFTER_QUEUE = "github.event_name != 'push' || github.actor != 'github-merge-queue[bot]'";

/** Una línea `uses:` de la forma: la acción es fija; el sha completo y el tag del comentario son un patrón. */
const pinned = (prefix, action) => ({
  re: new RegExp(`^${`${prefix}${action}`.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}@[0-9a-f]{40} # v\\d+\\.\\d+\\.\\d+$`),
  shown: `${prefix}${action}@<sha de 40 hex> # vX.Y.Z`,
});

/**
 * LA FORMA del `ci.yml`: sus líneas de código (ni las vacías ni las que son sólo comentario), literales y en orden.
 * Cambiar el `ci.yml` es cambiar esto en el mismo commit (ver la cabecera).
 */
const SHAPE = [
  'name: public-ci',
  'on:',
  '  pull_request:',
  '  push:',
  '    branches: [main]',
  '  merge_group:',
  'concurrency:',
  '  group: public-ci-${{ github.ref }}',
  '  cancel-in-progress: true',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  checks:',
  '    name: Node ${{ matrix.node }} · ${{ matrix.part }}',
  `    if: ${AFTER_QUEUE}`,
  '    runs-on: ubuntu-latest',
  '    timeout-minutes: 90',
  '    strategy:',
  '      fail-fast: false',
  '      matrix:',
  '        node: [24]',
  '        part: [checks, suites-1-of-5, suites-2-of-5, suites-3-of-5, suites-4-of-5, suites-5-of-5]',
  '    steps:',
  pinned('      - uses: ', 'actions/checkout'),
  '        with:',
  '          fetch-depth: 0',
  '          persist-credentials: false',
  pinned('      - uses: ', 'actions/setup-node'),
  '        with:',
  '          node-version: ${{ matrix.node }}',
  '      - name: Los pasos de la CI pública que le tocan a esta parte',
  '        env:',
  '          TYCON_PUBLIC_CI_OUT: ${{ runner.temp }}/public-ci',
  '          TYCON_PUBLIC_CI_PART: ${{ matrix.part }}',
  '          BASE_REF: ${{ github.base_ref || github.event.merge_group.base_ref }}',
  '        run: |',
  '          if [ "${GITHUB_EVENT_NAME}" = "pull_request" ] || [ "${GITHUB_EVENT_NAME}" = "merge_group" ]; then',
  '            bash scripts/ci/public-ci.sh --clean-machine --range "origin/${BASE_REF#refs/heads/}...HEAD"',
  '          else',
  '            bash scripts/ci/public-ci.sh --clean-machine',
  '          fi',
  '      - name: La salida completa de cada paso (sólo si algo quedó en rojo)',
  '        if: failure()',
  '        env:',
  '          TYCON_PUBLIC_CI_OUT: ${{ runner.temp }}/public-ci',
  '        run: |',
  '          for f in "${TYCON_PUBLIC_CI_OUT}"/*.log "${TYCON_PUBLIC_CI_OUT}"/agent-skills-suites/*.log; do',
  '            [ -f "${f}" ] || continue',
  '            echo "::group::${f##*/}"',
  '            cat "${f}"',
  '            echo "::endgroup::"',
  '          done',
  '  installer-floor:',
  '    name: Node 22 · installer-floor',
  `    if: ${AFTER_QUEUE}`,
  '    runs-on: ubuntu-latest',
  '    timeout-minutes: 60',
  '    steps:',
  pinned('      - uses: ', 'actions/checkout'),
  '        with:',
  '          fetch-depth: 0',
  '          persist-credentials: false',
  pinned('      - uses: ', 'actions/setup-node'),
  '        with:',
  '          node-version: 22',
  '      - name: Las suites de la instalación y la actualización, con el Node más viejo que acepta el instalador',
  '        env:',
  '          TYCON_PUBLIC_CI_OUT: ${{ runner.temp }}/public-ci',
  '          TYCON_PUBLIC_CI_PART: installer-floor',
  '        run: bash scripts/ci/public-ci.sh --clean-machine',
  '      - name: La salida completa de cada paso (sólo si algo quedó en rojo)',
  '        if: failure()',
  '        env:',
  '          TYCON_PUBLIC_CI_OUT: ${{ runner.temp }}/public-ci',
  '        run: |',
  '          for f in "${TYCON_PUBLIC_CI_OUT}"/*.log; do',
  '            [ -f "${f}" ] || continue',
  '            echo "::group::${f##*/}"',
  '            cat "${f}"',
  '            echo "::endgroup::"',
  '          done',
  '  public-ci:',
  `    if: always() && (${AFTER_QUEUE})`,
  '    needs: [checks, installer-floor]',
  '    runs-on: ubuntu-latest',
  '    timeout-minutes: 5',
  '    steps:',
  '      - name: Todos los jobs terminaron bien',
  '        env:',
  "          RESULTS: ${{ join(needs.*.result, ' ') }}",
  '        run: |',
  '          echo "resultados: ${RESULTS}"',
  '          [ -n "${RESULTS}" ] || exit 1',
  '          for r in ${RESULTS}; do',
  '            [ "${r}" = "success" ] || exit 1',
  '          done',
];

/**
 * LA FORMA de `version-tag.yml` (`--tagger`): el workflow que le pone a cada merge a `main` la etiqueta con su número
 * (scripts/ci/version-tag.js). Es el ÚNICO con permiso de escritura, y sólo en su job: corre en un push a `main` o a
 * mano (nunca con el código de un pedido), una corrida por vez, y no lee ningún secreto (empuja la etiqueta con la credencial que
 * deja el checkout). Cambiarlo es cambiar esto en el mismo commit, como el `ci.yml`.
 */
const TAGGER_SHAPE = [
  'name: version-tag',
  'on:',
  '  push:',
  '    branches: [main]',
  '  workflow_dispatch:',
  'concurrency:',
  '  group: version-tag',
  '  cancel-in-progress: false',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  tag:',
  '    runs-on: ubuntu-latest',
  '    timeout-minutes: 10',
  '    permissions:',
  '      contents: write',
  '    steps:',
  // con permiso de escritura, las acciones van con el sha EXACTO (no un patrón: uno de un fork también tiene 40 hex):
  // cambiar de versión es cambiar esto
  '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
  '        with:',
  '          fetch-depth: 0',
  '      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0',
  '        with:',
  '          node-version: 24',
  '      - name: La etiqueta con el número de este merge',
  '        run: node scripts/ci/version-tag.js tag --sha "${GITHUB_SHA}"',
];

/**
 * LA FORMA de `npm-publish.yml` (`--publisher`, story 8.40): el workflow que publica el instalador de npm
 * (scripts/setup/npm/) con trusted publishing. Es el ÚNICO que pide la identidad de la corrida (`id-token: write`), y sólo
 * en su job: corre en un push a `main` que toca la carpeta del paquete o a mano sobre `main`, nunca en un pedido; se
 * habilita con la variable de repositorio `NPM_PUBLISH_ENABLED=true` (sin ella, salteado en verde con un aviso; con ella,
 * cualquier error es rojo); no lee ningún secreto; instala npm en una versión EXACTA; mira lo ya publicado antes de
 * publicar y publica EN ETAPAS (`npm stage publish`: la aprueba una persona con 2FA). Sus pasos de shell los corre
 * npm-publish-workflow.test.js con un npm de mentira. Cambiarlo es cambiar esto en el mismo commit.
 */
const NPM_PINNED = '11.19.1';   // ≥ 11.15.0 (lo pide `npm stage publish`); nunca @latest: es la cadena de suministro
const PUBLISHER_SHAPE = [
  'name: npm-publish',
  'on:',
  '  push:',
  '    branches: [main]',
  '    paths:',
  "      - 'scripts/setup/npm/**'",
  '  workflow_dispatch:',
  'concurrency:',
  '  group: npm-publish',
  '  cancel-in-progress: false',
  'permissions:',
  '  contents: read',
  'jobs:',
  // la habilitación: una VARIABLE de repositorio (no un secreto), leída en un job sin la identidad de la corrida; sin ella
  // el que publica sale salteado, en verde, con el aviso de qué falta configurar
  '  enabled:',
  "    if: github.ref == 'refs/heads/main'",
  '    runs-on: ubuntu-latest',
  '    timeout-minutes: 5',
  '    outputs:',
  '      enabled: ${{ steps.flag.outputs.enabled }}',
  '    steps:',
  '      - name: La publicación está habilitada',
  '        id: flag',
  '        env:',
  '          ENABLED: ${{ vars.NPM_PUBLISH_ENABLED }}',
  '        run: |',
  '          set -euo pipefail',
  '          if [ "${ENABLED:-}" = "true" ]; then',
  '            echo "enabled=yes" >> "${GITHUB_OUTPUT}"',
  '            exit 0',
  '          fi',
  '          echo "::warning::falta configurar npm: la organización tycon-sa, el publicador de confianza (TYCON-SA / tycon-harness / npm-publish.yml, sólo en etapas) y la variable de repositorio NPM_PUBLISH_ENABLED=true. No se publica nada (tareas del dueño, story 8.40)"',
  '          echo "enabled=no" >> "${GITHUB_OUTPUT}"',
  '  publish:',
  '    needs: enabled',
  "    if: needs.enabled.outputs.enabled == 'yes'",
  '    runs-on: ubuntu-latest',
  '    timeout-minutes: 15',
  '    permissions:',
  '      contents: read',
  '      id-token: write',
  '    steps:',
  // con la identidad de la corrida, las acciones van con el sha EXACTO, como en el que etiqueta
  '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
  '        with:',
  '          persist-credentials: false',
  '      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0',
  '        with:',
  '          node-version: 24',
  '      - name: npm en una versión exacta',
  '        run: |',
  '          set -euo pipefail',
  `          npm install -g npm@${NPM_PINNED}`,
  '          have="$(npm --version)"',
  `          if [ "\${have}" != "${NPM_PINNED}" ]; then`,
  `            echo "::error::npm viejo o distinto: hay \${have} y la publicación en etapas pide npm ${NPM_PINNED} (11.15.0 o más)"`,
  '            exit 1',
  '          fi',
  '          echo "npm ${have}"',
  '      - name: El paquete, la versión y lo que ya está publicado',
  '        id: preflight',
  '        run: |',
  '          set -euo pipefail',
  '          cp LICENSE scripts/setup/npm/LICENSE',
  '          cd scripts/setup/npm',
  "          name=\"$(node -p \"require('./package.json').name\")\"",
  "          version=\"$(node -p \"require('./package.json').version\")\"",
  // ¿la versión ya está? La lista de versiones del paquete: E404 es «el paquete no existe» (la primera publicación, que
  // también va en etapas); otro error, o una respuesta que no se entiende, es rojo; listada, se compara la integridad
  '          if ! npm view "${name}" versions --json > "${RUNNER_TEMP}/npm-versions.json" 2> "${RUNNER_TEMP}/npm-view.err"; then',
  "            if grep -q 'E404' \"${RUNNER_TEMP}/npm-versions.json\" \"${RUNNER_TEMP}/npm-view.err\"; then",
  '              echo "${name} todavía no existe en npm: es la primera publicación, en etapas"',
  '              echo "publish=yes" >> "${GITHUB_OUTPUT}"',
  '              exit 0',
  '            fi',
  '            echo "::error::no pude preguntarle al registro por ${name}: $(head -c 400 "${RUNNER_TEMP}/npm-view.err")"',
  '            exit 1',
  '          fi',
  '          listed=0',
  `          node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit([].concat(v).includes(process.argv[2])?0:3)' "\${RUNNER_TEMP}/npm-versions.json" "\${version}" || listed=$?`,
  '          if [ "${listed}" = 3 ]; then',
  '            echo "${name}@${version} es nueva: se publica en etapas"',
  '            echo "publish=yes" >> "${GITHUB_OUTPUT}"',
  '            exit 0',
  '          fi',
  '          if [ "${listed}" != 0 ]; then',
  '            echo "::error::no entiendo la lista de versiones de ${name} que contestó el registro: $(head -c 400 "${RUNNER_TEMP}/npm-versions.json")"',
  '            exit 1',
  '          fi',
  '          seen="$(npm view "${name}@${version}" dist.integrity)"',
  "          mine=\"$(npm pack --dry-run --json | node -e 'let s=\"\";process.stdin.on(\"data\",(d)=>{s+=d}).on(\"end\",()=>{process.stdout.write(JSON.parse(s)[0].integrity)})')\"",
  '          if [ -n "${seen}" ] && [ "${mine}" = "${seen}" ]; then',
  '            echo "${name}@${version} ya publicada con este mismo contenido: no hay nada que publicar"',
  '            echo "publish=no" >> "${GITHUB_OUTPUT}"',
  '            exit 0',
  '          fi',
  '          echo "::error::${name}@${version} ya está publicada con otro contenido: subí version en scripts/setup/npm/package.json"',
  '          exit 1',
  '      - name: Publicar en etapas (la aprueba una persona con 2FA)',
  "        if: steps.preflight.outputs.publish == 'yes'",
  '        working-directory: scripts/setup/npm',
  // con la publicación habilitada, CUALQUIER error es rojo (también la identidad que npm no acepta: E401/E403/OIDC)
  '        run: |',
  '          set -euo pipefail',
  '          npm stage publish',
];

/** Los únicos workflows del repo público: la CI, el que etiqueta y el que publica el instalador de npm. Otro archivo en
 *  `.github/workflows/` es rojo (lo mira scripts/tests/version-by-merge.test.js). */
const WORKFLOWS = ['ci.yml', 'version-tag.yml', 'npm-publish.yml'];

/**
 * Un `\r` que no va seguido de `\n`, un tabulador o un carácter de control: los de C0 menos `\n` y `\r`, DEL, y los tres
 * saltos de línea de Unicode (NEL, separador de línea y separador de párrafo: 0x85, 0x2028 y 0x2029). Los dos últimos se
 * arman por código para que este archivo no los lleve escritos.
 */
const ODD_CHARACTER = new RegExp(`\\r(?!\\n)|[\\x00-\\x09\\x0B\\x0C\\x0E-\\x1F\\x7F\\x85${String.fromCharCode(0x2028, 0x2029)}]`);

/** Lo primero que el archivo tiene distinto de la forma, dicho para una persona; null si coincide. */
function shapeProblem(text, shape = SHAPE) {
  // Antes de partir en líneas: lo que YAML lee distinto que un lector por texto. Para YAML un `\r` suelto (y U+0085,
  // U+2028, U+2029 en algunos lectores) es un salto de línea: detrás de un comentario esconde una línea entera.
  const odd = ODD_CHARACTER.exec(text);
  if (odd) {
    const n = text.slice(0, odd.index).split('\n').length;
    const what = odd[0] === '\r' ? 'un retorno de carro suelto (sin `\\n` detrás)' : odd[0] === '\t' ? 'un tabulador'
      : `un carácter de control (U+${odd[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')})`;
    return `línea ${n}: hay ${what}; YAML lo lee distinto que un lector por texto`;
  }
  // sólo espacios cuentan como sangría: una línea que «parece» vacía o comentario con otro blanco adelante es código
  const code = [];
  text.split(/\r?\n/).forEach((raw, i) => { if (!/^ *(#|$)/.test(raw)) code.push({ n: i + 1, raw }); });
  const shown = (w) => (typeof w === 'string' ? w : w.shown);
  for (let k = 0; k < Math.max(code.length, shape.length); k++) {
    const have = code[k];
    const want = shape[k];
    if (!want) return `línea ${have.n}: sobra «${have.raw}» (la forma termina en la línea anterior)`;
    if (!have) return `falta «${shown(want)}» después de la línea ${code.length ? code[code.length - 1].n : 0} (el archivo termina antes que la forma)`;
    if (!(typeof want === 'string' ? have.raw === want : want.re.test(have.raw))) return `línea ${have.n}: hay «${have.raw}» y la forma espera «${shown(want)}»`;
  }
  return null;
}

/** El archivo, línea por línea: número, sangría, texto sin los bordes, y si es código (ni vacía ni sólo comentario). */
function read(text) {
  return text.split(/\r?\n/).map((raw, i) => {
    const body = raw.trim();
    return { n: i + 1, raw, body, indent: raw.length - raw.trimStart().length, code: body !== '' && !body.startsWith('#') };
  });
}

/** El valor de una línea `clave: valor`, sin el comentario del final. */
const valueOf = (body) => body.replace(/^[^:]*:/, '').replace(/\s+#.*$/, '').trim();
const unquote = (s) => s.trim().replace(/^["']|["']$/g, '');

/** Las líneas de código que cuelgan de la línea `i` (más sangría), hasta la primera con igual o menos sangría. */
function blockOf(lines, i) {
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (!lines[j].code) continue;
    if (lines[j].indent <= lines[i].indent) break;
    out.push(lines[j]);
  }
  return out;
}
/** La línea de código de la que cuelga la línea `i`: la anterior más cercana con menos sangría; null si no hay. */
function parentOf(lines, i) {
  for (let j = i - 1; j >= 0; j--) if (lines[j].code && lines[j].indent < lines[i].indent) return lines[j];
  return null;
}
/** De un bloque, las líneas hijas directas (las de menor sangría); de un bloque vacío, ninguna. */
function childrenOf(block) {
  if (!block.length) return [];
  const min = Math.min(...block.map((l) => l.indent));
  return block.filter((l) => l.indent === min);
}
/** El índice de la línea de código, sin sangría, que abre la clave `key` (con o sin comillas); -1 si no hay una sola. */
function topLevel(lines, key) {
  const re = new RegExp(`^["']?${key}["']?\\s*:`);
  const found = lines.filter((l) => l.code && l.indent === 0 && re.test(l.body));
  return found.length === 1 ? lines.indexOf(found[0]) : -1;
}
/** Una lista escrita en la misma línea (`[a, b]`), suelta (`a`) o como bloque (`- a`), debajo de la línea `i`. */
function listAt(lines, i) {
  const v = valueOf(lines[i].body);
  if (v.startsWith('[') && v.endsWith(']')) return v.slice(1, -1).split(',').map(unquote).filter(Boolean);
  if (v) return [unquote(v)];
  return blockOf(lines, i).filter((l) => l.body.startsWith('- ')).map((l) => unquote(l.body.slice(2).replace(/\s+#.*$/, '')));
}
const at = (ls) => ls.map((l) => l.n).join(', ');

/** Las líneas del job `id` (vacío si no está). */
function jobBlock(lines, id) {
  const i = topLevel(lines, 'jobs');
  if (i < 0) return [];
  const job = childrenOf(blockOf(lines, i)).find((l) => unquote(l.body.replace(/\s*:.*$/, '')) === id);
  return job ? blockOf(lines, lines.indexOf(job)) : [];
}

const RULES = [
  {
    id: 'triggers',
    check(lines) {
      const i = topLevel(lines, 'on');
      if (i < 0) return 'no hay un único `on:` arriba de todo';
      if (valueOf(lines[i].body)) return `\`on:\` se escribe como bloque, con un disparador por línea (línea ${lines[i].n})`;
      const kids = childrenOf(blockOf(lines, i));
      const names = kids.map((l) => l.body.replace(/\s*:.*$/, '')).sort();
      if (names.join(',') !== 'merge_group,pull_request,push') return `los disparadores son pull_request, merge_group y push, y hay: ${names.join(', ') || 'ninguno'}`;
      const push = lines.indexOf(kids.find((l) => l.body.startsWith('push')));
      const inPush = childrenOf(blockOf(lines, push));
      const keys = inPush.map((l) => l.body.replace(/\s*:.*$/, ''));
      if (keys.join(',') !== 'branches') return `\`push\` lleva sólo \`branches: [main]\` (línea ${lines[push].n})`;
      const branches = listAt(lines, lines.indexOf(inPush[0]));
      if (branches.join(',') !== 'main') return `\`push\` corre sólo en main, y dice: ${branches.join(', ') || 'nada'} (línea ${inPush[0].n})`;
      return null;
    },
  },
  {
    id: 'pull-request-target',
    check(lines) {
      const hits = lines.filter((l) => /pull_request_target/i.test(l.raw));
      return hits.length ? `aparece \`pull_request_target\` (línea ${at(hits)}): corre el código del pull request con los permisos del repo` : null;
    },
  },
  {
    id: 'secrets',
    check(lines) {
      // el contexto de secretos, y el token por cualquier camino: con punto, por índice, o volcando el contexto entero
      const hits = lines.filter((l) => /\bsecrets\b/i.test(l.raw) || /\bgithub\s*\.\s*token\b/i.test(l.raw)
        || /\bgithub\s*\[/i.test(l.raw) || /\btojson\s*\(\s*github\s*\)/i.test(l.raw));
      return hits.length ? `lee un secreto (línea ${at(hits)}): la CI pública no usa ninguno` : null;
    },
  },
  {
    id: 'uses-by-sha',
    check(lines) {
      // la clave `uses` venga detrás de lo que venga (un espacio, `{`, `[`, una coma, una comilla): no una lista de formas
      const uses = lines.filter((l) => l.code && /(^|[^A-Za-z0-9_-])uses["']?\s*:/.test(l.body));
      const pinned = /^(?:-\s+)?uses:\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}\s+#\s*v\d+(?:\.\d+){0,2}$/;
      const bad = uses.filter((l) => !pinned.test(l.body));
      return bad.length ? `\`uses:\` sin fijar por el sha completo de su commit con el tag como comentario (línea ${at(bad)})` : null;
    },
  },
  {
    id: 'permissions',
    check(lines) {
      const all = lines.filter((l) => l.code && /^(?:-\s+)?["']?permissions["']?\s*:/.test(l.body));
      if (all.length !== 1 || all[0].indent !== 0) {
        return all.length ? `\`permissions\` va una sola vez y arriba de todo (línea ${at(all)})` : 'falta `permissions: contents: read` arriba de todo';
      }
      const i = lines.indexOf(all[0]);
      const inside = blockOf(lines, i).map((l) => l.body.replace(/\s+#.*$/, ''));
      if (valueOf(all[0].body) || inside.length !== 1 || !/^contents:\s*read$/.test(inside[0])) {
        return `\`permissions\` lleva \`contents: read\` y nada más (línea ${all[0].n})`;
      }
      return null;
    },
  },
  {
    id: 'fetch-depth',
    check(lines) {
      const checkouts = lines.filter((l) => l.code && /uses:\s+actions\/checkout@/.test(l.body));
      if (!checkouts.length) return 'no hay un paso con actions/checkout';
      const bad = checkouts.filter((l) => {
        // el paso: desde el `- ` que lo abre (puede ser esta misma línea) hasta la próxima línea con su sangría o menos
        let start = lines.indexOf(l);
        while (start > 0 && !(lines[start].code && lines[start].body.startsWith('- ') && lines[start].indent <= l.indent)) start--;
        return !blockOf(lines, start).some((x) => /^fetch-depth:\s*0$/.test(x.body.replace(/\s+#.*$/, '')));
      });
      return bad.length ? `el checkout no trae la historia completa: falta \`fetch-depth: 0\` (línea ${at(bad)})` : null;
    },
  },
  {
    id: 'node-matrix',
    check(lines) {
      const matrix = lines.filter((l) => l.code && /^node:\s*\[.*\]/.test(l.body));
      const versions = matrix.length === 1 ? listAt(lines, lines.indexOf(matrix[0])).sort() : [];
      if (versions.join(',') !== '24') return `la matriz es \`node: [24]\`${matrix.length ? ` (línea ${at(matrix)})` : ''}`;
      // la lista tiene que colgar de `strategy: matrix:`; en cualquier otra clave es una lista suelta y el job corre una sola vez
      const parents = [parentOf(lines, lines.indexOf(matrix[0]))];
      parents.push(parents[0] ? parentOf(lines, lines.indexOf(parents[0])) : null);
      if (!parents[0] || !/^matrix\s*:$/.test(parents[0].body.replace(/\s+#.*$/, '')) || !parents[1] || !/^strategy\s*:$/.test(parents[1].body.replace(/\s+#.*$/, ''))) {
        return `\`node: [24]\` no cuelga de \`strategy: matrix:\` (línea ${at(matrix)}): así no es una matriz`;
      }
      // el piso del instalador (2026-10-16): un solo `node-version: 22`, y sólo dentro del job `installer-floor`
      const floorJob = jobBlock(lines, 'installer-floor');
      const installed = lines.filter((l) => l.code && /^node-version\s*:/.test(l.body));
      const floor = installed.filter((l) => valueOf(l.body) === '22');
      if (floor.length !== 1 || !floorJob.includes(floor[0])) return `el job \`installer-floor\` instala Node 22 (el piso del instalador), una vez y sólo ahí${floor.length ? ` (línea ${at(floor)})` : ''}`;
      const bad = installed.filter((l) => l !== floor[0] && !/^\$\{\{\s*matrix\.node\s*\}\}$/.test(valueOf(l.body)));
      if (installed.length < 2 || bad.length) return `el Node que se instala es el de la matriz: \`node-version: \${{ matrix.node }}\`${bad.length ? ` (línea ${at(bad)})` : ''}`;
      return null;
    },
  },
  {
    id: 'range',
    check(lines) {
      const calls = lines.filter((l) => l.code && INVOCATION.test(l.body));
      const ranged = calls.filter((l) => /--range[ =]["']?origin\/\S+\.\.\.HEAD\b/.test(l.body));
      const onPr = lines.some((l) => l.code && /(GITHUB_EVENT_NAME|github\.event_name)\b.*=.*\bpull_request\b/.test(l.body));
      if (!ranged.length) return 'ninguna llamada a public-ci.sh lleva `--range origin/<base>...HEAD`';
      if (!onPr) return 'no se ve que `--range` se pase cuando el evento es pull_request';
      // la cola de merge prueba lo mismo que un pedido: sin `--range` ahí, el freno de nombres no corre antes de main
      const onQueue = lines.some((l) => l.code && /(GITHUB_EVENT_NAME|github\.event_name)\b.*=.*\bmerge_group\b/.test(l.body));
      if (!onQueue) return 'no se ve que `--range` se pase cuando el evento es merge_group (la cola de merge)';
      return null;
    },
  },
  {
    id: 'clean-machine',
    check(lines) {
      const calls = lines.filter((l) => l.code && INVOCATION.test(l.body));
      if (!calls.length) return 'ningún paso corre `bash scripts/ci/public-ci.sh`';
      const bad = calls.filter((l) => !/\s--clean-machine(\s|$)/.test(l.body));
      return bad.length ? `una llamada a public-ci.sh va sin \`--clean-machine\` (línea ${at(bad)})` : null;
    },
  },
  {
    id: 'aggregate-job',
    check(lines) {
      const tolerant = lines.filter((l) => l.code && /continue-on-error/.test(l.body));
      if (tolerant.length) return `\`continue-on-error\` deja pasar un rojo (línea ${at(tolerant)})`;
      const i = topLevel(lines, 'jobs');
      if (i < 0) return 'no hay un único `jobs:` arriba de todo';
      const jobs = childrenOf(blockOf(lines, i));
      const ids = jobs.map((l) => unquote(l.body.replace(/\s*:.*$/, '')));
      const job = jobs[ids.indexOf('public-ci')];
      if (!job) return `falta el job \`public-ci\`, el chequeo con nombre estable (hay: ${ids.join(', ') || 'ninguno'})`;
      const block = blockOf(lines, lines.indexOf(job));
      const kids = childrenOf(block);
      const kid = (key) => kids.find((l) => new RegExp(`^${key}\\s*:`).test(l.body));
      const name = kid('name');
      if (name && unquote(valueOf(name.body)) !== 'public-ci') return `el job \`public-ci\` se muestra con otro nombre (línea ${name.n}): el chequeo exigido dejaría de llegar`;
      const cond = kid('if');
      if (!cond || !/^(\$\{\{\s*)?always\(\)(\s*&&.*?)?(\s*\}\})?$/.test(valueOf(cond.body))) return 'el job `public-ci` lleva `if: always()`: sin eso se saltea cuando otro falla, y un chequeo salteado cuenta como aprobado';
      const needs = kid('needs');
      const waits = needs ? listAt(lines, lines.indexOf(needs)) : [];
      const missing = ids.filter((id) => id !== 'public-ci' && !waits.includes(id));
      if (missing.length) return `el job \`public-ci\` no depende (\`needs\`) de: ${missing.join(', ')}`;
      const text = block.map((l) => l.body).join('\n');
      const looks = /needs\.\*\.result/.test(text) || ids.filter((id) => id !== 'public-ci').every((id) => text.includes(`needs.${id}.result`));
      if (!looks || !/\bsuccess\b/.test(text) || !/\bexit 1\b/.test(text)) return 'el job `public-ci` no mira el resultado de cada job (`needs.*.result`) ni falla si alguno no dio `success`';
      return null;
    },
  },
  {
    id: 'parts',
    check(lines) {
      const decl = lines.filter((l) => l.code && /^part\s*:/.test(l.body));
      if (decl.length !== 1) {
        return decl.length ? `hay más de una lista \`part:\` (línea ${at(decl)})` : 'falta la lista `part:` de la matriz: la corrida no se reparte en partes que juntas sean la entera';
      }
      const parts = listAt(lines, lines.indexOf(decl[0]));
      const n = parts.filter((p) => p !== 'checks').length;
      const want = ['checks', ...Array.from({ length: n }, (_, k) => `suites-${k + 1}-of-${n}`)];
      if (!n || parts.join(',') !== want.join(',')) {
        return `la matriz parte la corrida en \`checks\` y \`suites-1-of-<n>\` … \`suites-<n>-of-<n>\`, todas, en orden y una vez (una que falta deja suites sin correr), y dice: ${parts.join(', ') || 'nada'} (línea ${decl[0].n})`;
      }
      const all = lines.filter((l) => l.code && /^TYCON_PUBLIC_CI_PART\s*:/.test(l.body));
      // la única parte fija es la del piso del instalador, dentro de su job (2026-10-16)
      const floorJob = jobBlock(lines, 'installer-floor');
      const fixed = all.filter((l) => valueOf(l.body) === 'installer-floor' && floorJob.includes(l));
      const env = all.filter((l) => !fixed.includes(l));
      if (env.length !== 1 || !/^\$\{\{\s*matrix\.part\s*\}\}$/.test(valueOf(env[0].body))) {
        return `la parte que corre cada trabajo sale de la matriz: \`TYCON_PUBLIC_CI_PART: \${{ matrix.part }}\`${env.length ? ` (línea ${at(env)})` : ''}`;
      }
      return null;
    },
  },
  {
    id: 'after-queue',
    check(lines) {
      const i = topLevel(lines, 'jobs');
      if (i < 0) return 'no hay un único `jobs:` arriba de todo';
      const jobs = childrenOf(blockOf(lines, i));
      if (!jobs.length) return 'no hay ningún job';
      const bad = jobs.filter((job) => {
        const id = unquote(job.body.replace(/\s*:.*$/, ''));
        const cond = childrenOf(blockOf(lines, lines.indexOf(job))).find((l) => /^if\s*:/.test(l.body));
        const want = id === 'public-ci' ? `always() && (${AFTER_QUEUE})` : AFTER_QUEUE;
        return !cond || valueOf(cond.body) !== want;
      });
      return bad.length ? `el job ${bad.map((l) => `\`${unquote(l.body.replace(/\s*:.*$/, ''))}\``).join(', ')} no lleva \`if: ${AFTER_QUEUE}\` (en \`public-ci\`, detrás de \`always() && \`): se saltea sólo el push a main de la cola, que ya probó ese commit (línea ${at(bad)})` : null;
    },
  },
  {
    // la red: lo que ninguna regla de arriba ve (ver la cabecera). Mira el texto entero, no las líneas ya partidas.
    id: 'shape',
    check(_lines, text) {
      const problem = shapeProblem(text);
      return problem ? `${problem}. El archivo no tiene la forma exacta que este control lleva adentro: si el cambio es a propósito, cambiá \`SHAPE\` en scripts/ci/check-public-workflow.js en el mismo commit` : null;
    },
  },
];

/**
 * Las reglas del workflow que etiqueta: las que valen para cualquier workflow de un repo público (sin el disparador
 * peligroso, sin secretos, acciones por sha) y su forma exacta.
 */
const TAGGER_RULES = [
  ...RULES.filter((r) => ['pull-request-target', 'secrets', 'uses-by-sha'].includes(r.id)),
  {
    id: 'shape',
    check(_lines, text) {
      const problem = shapeProblem(text, TAGGER_SHAPE);
      return problem ? `${problem}. El archivo no tiene la forma exacta que este control lleva adentro: si el cambio es a propósito, cambiá \`TAGGER_SHAPE\` en scripts/ci/check-public-workflow.js en el mismo commit` : null;
    },
  },
];

/**
 * Las reglas del workflow que publica en npm: las de cualquier workflow público, cuatro que dicen POR QUÉ algo está mal
 * (cuándo corre, qué permisos pide, qué npm instala, cómo publica) y su forma exacta.
 */
const PUBLISHER_RULES = [
  ...RULES.filter((r) => ['pull-request-target', 'secrets', 'uses-by-sha'].includes(r.id)),
  {
    id: 'publisher-trigger',
    check(lines, text) {
      if (/\bpull_request\b/.test(text)) return 'corre en un pedido (`pull_request`): publicar es sólo desde main';
      if (!/^ {2}push:\n {4}branches: \[main\]\n {4}paths:\n {6}- 'scripts\/setup\/npm\/\*\*'\n {2}workflow_dispatch:$/m.test(text.replace(/\r\n/g, '\n'))) {
        return 'corre en un push a main que toca `scripts/setup/npm/**` y a mano (`workflow_dispatch`), y en nada más';
      }
      if (!lines.some((l) => l.code && l.raw === "    if: github.ref == 'refs/heads/main'")) return "el job lleva `if: github.ref == 'refs/heads/main'`: a mano, sólo sobre main";
      return null;
    },
  },
  {
    id: 'publisher-enabled',
    check(lines) {
      // la publicación se habilita con una VARIABLE de repositorio, leída en un job aparte; el que publica depende de él
      const has = (raw) => lines.some((l) => l.code && l.raw === raw);
      if (!has('          ENABLED: ${{ vars.NPM_PUBLISH_ENABLED }}')) return 'la habilitación se lee de la variable de repositorio `NPM_PUBLISH_ENABLED` (`vars.`, no un secreto)';
      if (!/^ {4}needs: enabled\n {4}if: needs\.enabled\.outputs\.enabled == 'yes'$/m.test(lines.map((l) => l.raw).join('\n'))) {
        return "el job que publica lleva `needs: enabled` e `if: needs.enabled.outputs.enabled == 'yes'`: sin la variable sale salteado";
      }
      return null;
    },
  },
  {
    id: 'publisher-permissions',
    check(_lines, text) {
      const t = text.replace(/\r\n/g, '\n');
      const all = t.split('\n').filter((l) => /^\s*permissions\s*:/.test(l));
      if (all.length !== 2 || !/^permissions:\n {2}contents: read\njobs:/m.test(t) || !/^ {4}permissions:\n {6}contents: read\n {6}id-token: write\n {4}steps:/m.test(t)) {
        return '`permissions: contents: read` arriba y, en el job, `contents: read` e `id-token: write` y nada más';
      }
      return null;
    },
  },
  {
    id: 'publisher-npm',
    check(lines) {
      const inst = lines.filter((l) => l.code && /\bnpm (install|i)\b.*\bnpm@/.test(l.body));
      const m = inst.length === 1 && /^npm install -g npm@(\d+)\.(\d+)\.(\d+)$/.exec(inst[0].body);
      if (!m) return `npm se instala UNA vez y en una versión exacta (\`npm install -g npm@x.y.z\`), nunca @latest ni un rango${inst.length ? ` (línea ${at(inst)})` : ''}`;
      const [maj, min] = [Number(m[1]), Number(m[2])];
      if (maj < 11 || (maj === 11 && min < 15)) return `npm ${m.slice(1).join('.')} es viejo: \`npm stage publish\` pide 11.15.0 o más (línea ${inst[0].n})`;
      return null;
    },
  },
  {
    id: 'publisher-stage',
    check(lines, text) {
      if (/\bnpm (publish|pub)\b/.test(text.replace(/npm stage publish/g, ''))) return 'publica con `npm publish` directo: va en etapas (`npm stage publish`), la aprueba una persona con 2FA';
      if (!/npm stage publish/.test(text)) return 'falta `npm stage publish`';
      if (!lines.some((l) => l.raw === '        working-directory: scripts/setup/npm')) return 'publica desde la carpeta del paquete (`working-directory: scripts/setup/npm`)';
      if (!/cp LICENSE scripts\/setup\/npm\/LICENSE/.test(text)) return 'copia LICENSE a la carpeta del paquete antes de empaquetar (npm no empaqueta rutas de afuera)';
      const code = lines.filter((l) => l.code).map((l) => l.raw).join('\n');   // el orden de los PASOS, no el de la cabecera
      if (!(code.indexOf('dist.integrity') >= 0 && code.indexOf('dist.integrity') < code.indexOf('npm stage publish'))) return 'mira lo ya publicado (`dist.integrity`) antes de publicar';
      return null;
    },
  },
  {
    id: 'shape',
    check(_lines, text) {
      const problem = shapeProblem(text, PUBLISHER_SHAPE);
      return problem ? `${problem}. El archivo no tiene la forma exacta que este control lleva adentro: si el cambio es a propósito, cambiá \`PUBLISHER_SHAPE\` en scripts/ci/check-public-workflow.js en el mismo commit` : null;
    },
  },
];

/** Lo que hay en `.github/workflows/` y no es uno de los workflows conocidos (`WORKFLOWS`). */
function strayWorkflows(names) { return (names || []).filter((n) => !WORKFLOWS.includes(n)).sort(); }

/** @returns {{rule: string, detail: string}[]} las reglas rotas, en el orden de RULES (o de TAGGER_RULES / PUBLISHER_RULES) */
function check(text, { tagger = false, publisher = false } = {}) {
  const lines = read(text);
  const broken = [];
  for (const rule of publisher ? PUBLISHER_RULES : tagger ? TAGGER_RULES : RULES) {
    let detail = null;
    try { detail = rule.check(lines, text); } catch (e) { detail = `no pude evaluarla (${e.message})`; }
    if (detail) broken.push({ rule: rule.id, detail });
  }
  return broken;
}

function main(argv) {
  const tagger = argv[0] === '--tagger';
  const publisher = argv[0] === '--publisher';
  const args = tagger || publisher ? argv.slice(1) : argv;
  const file = args[0];
  if (!file || args.length !== 1) {
    process.stderr.write('uso: node scripts/ci/check-public-workflow.js [--tagger|--publisher] <archivo>\n');
    return 2;
  }
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    process.stderr.write(`⛔ check-public-workflow: no pude leer ${file} (${e.code || e.message})\n`);
    return 2;
  }
  if (!text.trim()) {
    process.stderr.write(`⛔ check-public-workflow: ${file} está vacío\n`);
    return 2;
  }
  const broken = check(text, { tagger, publisher });
  const total = (publisher ? PUBLISHER_RULES : tagger ? TAGGER_RULES : RULES).length;
  for (const b of broken) console.log(`❌ check-public-workflow: ${b.rule} — ${b.detail}`);
  if (broken.length) {
    console.log(`❌ check-public-workflow: ${file}: ${broken.length} de ${total} reglas rotas`);
    return 1;
  }
  console.log(`✅ check-public-workflow: ${file} cumple las ${total} reglas`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { check, RULES, SHAPE, TAGGER_RULES, TAGGER_SHAPE, PUBLISHER_RULES, PUBLISHER_SHAPE, NPM_PINNED, WORKFLOWS, strayWorkflows };
