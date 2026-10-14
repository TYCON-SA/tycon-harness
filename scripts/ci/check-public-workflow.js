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
 * LAS REGLAS (un id por regla; una línea por regla rota). Las diez primeras dicen POR QUÉ algo está mal:
 *   triggers             corre en `pull_request` y en `push` a `main`, y en nada más
 *   pull-request-target  `pull_request_target` no aparece en ninguna parte (ni en un comentario)
 *   secrets              no lee ningún secreto: ni el contexto de secretos ni el token por otro camino (ni en un comentario)
 *   uses-by-sha          cada `uses:` va fijado por el sha completo (40 hex) de su commit, con el tag como comentario
 *   permissions          un solo bloque `permissions`, arriba de todo, con `contents: read` y nada más
 *   fetch-depth          el checkout trae la historia completa (`fetch-depth: 0`): la necesita `--range`
 *   node-matrix          la matriz es Node 22 y 24, y es la que se instala
 *   range                en un pull request, `public-ci.sh` corre con `--range origin/<base>...HEAD`
 *   clean-machine        toda llamada a `public-ci.sh` lleva `--clean-machine`
 *   aggregate-job        el job `public-ci` corre siempre, depende de todos los demás y falla si alguno no terminó bien
 * …y la undécima es la red:
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
 * USO:  node scripts/ci/check-public-workflow.js <archivo>
 *   0 = cumple todo · 1 = alguna regla rota (una línea `❌ check-public-workflow: <regla> — <qué>` por regla) ·
 *   2 = no pude leer el archivo (no es un verde)
 * Lo corre scripts/tests/public-ci.test.sh sobre el `ci.yml` real y sobre copias alteradas: una por regla y una por cada
 * clase del pase adversarial.
 */

const fs = require('fs');

const INVOCATION = /\bbash\s+scripts\/ci\/public-ci\.sh\b/;

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
  'concurrency:',
  '  group: public-ci-${{ github.ref }}',
  '  cancel-in-progress: true',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  checks:',
  '    name: Node ${{ matrix.node }}',
  '    runs-on: ubuntu-26.04',
  '    timeout-minutes: 90',
  '    strategy:',
  '      fail-fast: false',
  '      matrix:',
  '        node: [22, 24]',
  '    steps:',
  pinned('      - uses: ', 'actions/checkout'),
  '        with:',
  '          fetch-depth: 0',
  '          persist-credentials: false',
  pinned('      - uses: ', 'actions/setup-node'),
  '        with:',
  '          node-version: ${{ matrix.node }}',
  '      - name: Todos los pasos de la CI pública',
  '        env:',
  '          TYCON_PUBLIC_CI_OUT: ${{ runner.temp }}/public-ci',
  '          BASE_REF: ${{ github.base_ref }}',
  '        run: |',
  '          if [ "${GITHUB_EVENT_NAME}" = "pull_request" ]; then',
  '            bash scripts/ci/public-ci.sh --clean-machine --range "origin/${BASE_REF}...HEAD"',
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
  '  public-ci:',
  '    if: always()',
  '    needs: [checks]',
  '    runs-on: ubuntu-26.04',
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
 * Un `\r` que no va seguido de `\n`, un tabulador o un carácter de control: los de C0 menos `\n` y `\r`, DEL, y los tres
 * saltos de línea de Unicode (NEL, separador de línea y separador de párrafo: 0x85, 0x2028 y 0x2029). Los dos últimos se
 * arman por código para que este archivo no los lleve escritos.
 */
const ODD_CHARACTER = new RegExp(`\\r(?!\\n)|[\\x00-\\x09\\x0B\\x0C\\x0E-\\x1F\\x7F\\x85${String.fromCharCode(0x2028, 0x2029)}]`);

/** Lo primero que el archivo tiene distinto de la forma, dicho para una persona; null si coincide. */
function shapeProblem(text) {
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
  for (let k = 0; k < Math.max(code.length, SHAPE.length); k++) {
    const have = code[k];
    const want = SHAPE[k];
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

const RULES = [
  {
    id: 'triggers',
    check(lines) {
      const i = topLevel(lines, 'on');
      if (i < 0) return 'no hay un único `on:` arriba de todo';
      if (valueOf(lines[i].body)) return `\`on:\` se escribe como bloque, con un disparador por línea (línea ${lines[i].n})`;
      const kids = childrenOf(blockOf(lines, i));
      const names = kids.map((l) => l.body.replace(/\s*:.*$/, '')).sort();
      if (names.join(',') !== 'pull_request,push') return `los disparadores son pull_request y push, y hay: ${names.join(', ') || 'ninguno'}`;
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
      if (versions.join(',') !== '22,24') return `la matriz es \`node: [22, 24]\`${matrix.length ? ` (línea ${at(matrix)})` : ''}`;
      // la lista tiene que colgar de `strategy: matrix:`; en cualquier otra clave es una lista suelta y el job corre una sola vez
      const parents = [parentOf(lines, lines.indexOf(matrix[0]))];
      parents.push(parents[0] ? parentOf(lines, lines.indexOf(parents[0])) : null);
      if (!parents[0] || !/^matrix\s*:$/.test(parents[0].body.replace(/\s+#.*$/, '')) || !parents[1] || !/^strategy\s*:$/.test(parents[1].body.replace(/\s+#.*$/, ''))) {
        return `\`node: [22, 24]\` no cuelga de \`strategy: matrix:\` (línea ${at(matrix)}): así no es una matriz`;
      }
      const installed = lines.filter((l) => l.code && /^node-version\s*:/.test(l.body));
      const bad = installed.filter((l) => !/^\$\{\{\s*matrix\.node\s*\}\}$/.test(valueOf(l.body)));
      if (!installed.length || bad.length) return `el Node que se instala es el de la matriz: \`node-version: \${{ matrix.node }}\`${bad.length ? ` (línea ${at(bad)})` : ''}`;
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
      if (!cond || !/^(\$\{\{\s*)?always\(\)(\s*\}\})?$/.test(valueOf(cond.body))) return 'el job `public-ci` lleva `if: always()`: sin eso se saltea cuando otro falla, y un chequeo salteado cuenta como aprobado';
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
    // la red: lo que ninguna regla de arriba ve (ver la cabecera). Mira el texto entero, no las líneas ya partidas.
    id: 'shape',
    check(_lines, text) {
      const problem = shapeProblem(text);
      return problem ? `${problem}. El archivo no tiene la forma exacta que este control lleva adentro: si el cambio es a propósito, cambiá \`SHAPE\` en scripts/ci/check-public-workflow.js en el mismo commit` : null;
    },
  },
];

/** @returns {{rule: string, detail: string}[]} las reglas rotas, en el orden de RULES */
function check(text) {
  const lines = read(text);
  const broken = [];
  for (const rule of RULES) {
    let detail = null;
    try { detail = rule.check(lines, text); } catch (e) { detail = `no pude evaluarla (${e.message})`; }
    if (detail) broken.push({ rule: rule.id, detail });
  }
  return broken;
}

function main(argv) {
  const file = argv[0];
  if (!file || argv.length !== 1) {
    process.stderr.write('uso: node scripts/ci/check-public-workflow.js <archivo>\n');
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
  const broken = check(text);
  for (const b of broken) console.log(`❌ check-public-workflow: ${b.rule} — ${b.detail}`);
  if (broken.length) {
    console.log(`❌ check-public-workflow: ${file}: ${broken.length} de ${RULES.length} reglas rotas`);
    return 1;
  }
  console.log(`✅ check-public-workflow: ${file} cumple las ${RULES.length} reglas`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { check, RULES, SHAPE };
