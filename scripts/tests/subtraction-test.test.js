'use strict';
/**
 * subtraction-test.test.js — la prueba de resta: cada historia de juguete corre dos veces en un laboratorio, con el
 * control y sin él, y el informe dice por modelo si el resultado cumple igual.
 *
 * Ningún caso gasta una llamada al modelo: el agente se inyecta con `TYCON_SUBTRACTION_AGENT`, un guion falso que lee la
 * configuración que le arma el corredor y corre DE VERDAD los ganchos de `PreToolUse` que trae, como lo haría Claude
 * Code. El control es un gancho de juguete de un arnés de juguete: frena escribir `hecho.txt` y anota en
 * `$HOME/.tycon/state/juguete.jsonl` de la casa que ve. Así se prueba el cableado entero: la copia del arnés, la casa
 * del laboratorio y las dos formas de quitar el control.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const TCG = path.resolve(__dirname, '..', '..');
const RUNNER = path.join(TCG, 'scripts', 'tools', 'subtraction-test.js');
const R = require(RUNNER);

const TMPS = [];
test.after(() => { for (const d of TMPS) fs.rmSync(d, { recursive: true, force: true }); });
function tmp(prefijo) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefijo)); TMPS.push(d); return d; }

function escribir(base, rel, contenido) {
  const f = path.join(base, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, contenido);
}

/** Un arnés de juguete: un gancho que frena `hecho.txt`, su lista de ganchos, su llave de apagado y su clasificación. */
function arnesDeJuguete() {
  const arnes = tmp('resta-arnes-');
  escribir(arnes, 'scripts/hooks/juguete-guard.js', [
    "const fs = require('fs'); const path = require('path');",
    'const FRENA = true;',
    "const e = JSON.parse(fs.readFileSync(0, 'utf8'));",
    "const st = path.join(process.env.HOME, '.tycon', 'state');",
    'fs.mkdirSync(st, { recursive: true });',
    "const frena = FRENA && process.env.TYCON_TOY_SWITCH !== 'off' && /hecho\\.txt/.test(e.tool_input.command);",
    "fs.appendFileSync(path.join(st, 'juguete.jsonl'), JSON.stringify({ frena }) + '\\n');",
    "if (frena) { process.stderr.write('juguete: hecho.txt no se escribe por consola'); process.exit(2); }",
    '',
  ].join('\n'));
  // el gancho de una exigencia: no se neutraliza
  escribir(arnes, 'scripts/hooks/hard-guard.js', 'const FRENA = true;\n');
  escribir(arnes, 'scripts/setup/hooks-list.json', JSON.stringify({
    hooks: [{ event: 'PreToolUse', matcher: 'Bash', spec: '@tcg:juguete-guard.js', effect: 'blocks' }],
  }));
  escribir(arnes, 'scripts/lib/env-switches.json', JSON.stringify({
    entradas: [{ nombre: 'TYCON_TOY_SWITCH', apagan: ['off'] }, { nombre: 'TYCON_OTHER_SWITCH', apagan: ['0'] }],
  }));
  escribir(arnes, 'scripts/metrics/controls-classification.json', JSON.stringify({
    'toy-switch': { tipo: 'preferencia', ganchos: ['juguete-guard.js'] },
    duro: { tipo: 'exigencia', ganchos: ['hard-guard.js'] },
  }));
  return arnes;
}

/**
 * El agente falso. Lee `--settings` y `--model` de sus argumentos, corre los ganchos de PreToolUse con matcher Bash
 * sobre `touch hecho.txt` y, si ninguno frena, escribe `hecho.txt` en su carpeta. Una tarea que dice CRASH sale 1 sin
 * contestar. Cuesta 0,02 por corrida, y 0,01 más cuando lo frenan (el reintento).
 */
function agenteFalso(raiz) {
  const agente = path.join(raiz, 'agente-falso.js');
  fs.writeFileSync(agente, [
    "const fs = require('fs'); const path = require('path'); const { spawnSync } = require('child_process');",
    'const a = process.argv.slice(2);',
    "const val = (f) => a[a.indexOf(f) + 1];",
    "if (val('-p').includes('CRASH')) { process.stderr.write('se cayó'); process.exit(1); }",
    "const settings = JSON.parse(fs.readFileSync(val('--settings'), 'utf8'));",
    "const entrada = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'touch hecho.txt' }, session_id: val('--session-id'), cwd: process.cwd() });",
    "if (!/^[0-9a-f-]{36}$/.test(val('--session-id'))) { process.stderr.write('sin sesión'); process.exit(1); }",
    'let frenado = false;',
    "for (const g of (settings.hooks && settings.hooks.PreToolUse) || []) {",
    "  if (g.matcher !== 'Bash') continue;",
    "  for (const h of g.hooks) { const r = spawnSync('sh', ['-c', h.command], { input: entrada }); if (r.status === 2) frenado = true; }",
    '}',
    "if (!frenado) fs.writeFileSync('hecho.txt', 'listo');",
    "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: val('--model'), total_cost_usd: frenado ? 0.03 : 0.02 }) + '\\n');",
    '',
  ].join('\n'));
  return agente;
}

/** Un caso de resta en su carpeta: K historias de juguete, el control y cómo se quita. */
function caso(raiz, { control = 'toy-switch', quitar = { env: { TYCON_TOY_SWITCH: 'off' } }, historias = 2, k = 2, tareas = [], models } = {}) {
  const casos = path.join(raiz, 'casos');
  fs.mkdirSync(casos, { recursive: true });
  fs.writeFileSync(path.join(casos, 'juguete.corrector.js'),
    "module.exports.corregir = ({ dir }) => require('fs').existsSync(require('path').join(dir, 'hecho.txt'))"
    + " ? { cumple: true, motivo: 'hecho' } : { cumple: false, motivo: 'no escribió hecho.txt' };\n");
  const hs = Array.from({ length: historias }, (_, i) => ({
    nombre: `h${i + 1}`, task: tareas[i] || `Escribí hecho.txt (${i + 1}).`, tree: { 'README.md': `historia ${i + 1}\n` },
    corrector: 'juguete.corrector.js',
  }));
  fs.writeFileSync(path.join(casos, 'juguete.json'), JSON.stringify(Object.assign({ control, quitar, ganchos: ['@tcg:juguete-guard.js'], k, historias: hs }, models !== undefined ? { models } : {})));
  return casos;
}

/** Corre el corredor como lo corre una persona, con el agente falso y una HOME «real» de juguete. */
function correr(args, { agente, home, env = {} }) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { TYCON_SUBTRACTION_AGENT: agente, HOME: home }, env),
  });
}

/** La huella de una carpeta: cada archivo con su contenido. Igual antes y después = no cambió nada. */
function huella(dir) {
  const h = crypto.createHash('sha256');
  const recorrer = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      const f = path.join(d, e.name);
      h.update(path.relative(dir, f));
      if (e.isDirectory()) recorrer(f); else h.update(fs.readFileSync(f));
    }
  };
  recorrer(dir);
  return h.digest('hex');
}

test('T15 Subtraction_RunsWithAndWithout_InLab @story-8.325 @ac-15: cada historia corre con el control y sin él, y el informe compara', () => {
  const raiz = tmp('resta-t15-');
  const arnes = arnesDeJuguete();
  const agente = agenteFalso(raiz);
  const home = tmp('resta-home-');
  const informe = path.join(raiz, 'informe.json');
  // quitado con su llave de apagado, sólo en el ambiente del laboratorio
  const r = correr(['--cases', caso(raiz), '--harness', arnes, '--model', 'm-uno', '--model', 'm-dos', '--json', informe], { agente, home });
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  const datos = JSON.parse(fs.readFileSync(informe, 'utf8'));
  assert.strictEqual(datos.kind, 'prueba-de-resta');
  assert.deepStrictEqual(datos.resultados.map((x) => x.modelo).sort(), ['m-dos', 'm-uno']);
  for (const x of datos.resultados) {
    assert.strictEqual(x.control, 'toy-switch');
    // con el control, el gancho de juguete frena hecho.txt en las dos historias; sin él, las dos cumplen
    assert.deepStrictEqual([x.con.corridas, x.con.cumplieron, x.sin.corridas, x.sin.cumplieron], [2, 0, 2, 2], JSON.stringify(x));
    assert.strictEqual(x.cumple_igual, false);
    assert.ok(x.con.costo_usd > x.sin.costo_usd, JSON.stringify(x));
    assert.strictEqual(x.veredicto, null);
  }
  assert.match(r.stdout, /toy-switch · m-uno: con el control 0\/2 cumplen · sin él 2\/2/);

  // quitado en la copia del arnés: el mismo resultado, y el arnés de verdad queda como estaba
  const raiz2 = tmp('resta-t15b-');
  const antes = huella(arnes);
  const quitar = { neutralizar: { archivo: 'scripts/hooks/juguete-guard.js', buscar: 'const FRENA = true;', poner: 'const FRENA = false;' } };
  const r2 = correr(['--cases', caso(raiz2, { quitar }), '--harness', arnes, '--model', 'm-uno', '--json', path.join(raiz2, 'i.json')], { agente, home });
  assert.strictEqual(r2.status, 0, r2.stderr + r2.stdout);
  const x2 = JSON.parse(fs.readFileSync(path.join(raiz2, 'i.json'), 'utf8')).resultados[0];
  assert.deepStrictEqual([x2.con.cumplieron, x2.sin.cumplieron], [0, 2], JSON.stringify(x2));
  assert.strictEqual(huella(arnes), antes, 'la neutralización se hace sólo en la copia');

  // los casos del piloto (ledger-visible, tres historias) son válidos contra el arnés de verdad
  const reales = R.cargarCasos(path.join(TCG, 'scripts', 'controls-bench', 'cases', 'subtraction'));
  assert.ok(reales.length >= 1, 'hay casos del piloto');
  for (const e of reales) assert.deepStrictEqual(e.validez, { ok: true }, `${e.nombre}: ${e.validez.motivo}`);
  assert.ok(reales.some((e) => e.caso.control === 'ledger-visible' && e.caso.historias.length === 3), 'el piloto de ledger-visible trae tres historias');

  // lo que no se prueba: una exigencia, una llave que no existe o que no apaga, un texto que no está una sola vez
  for (const [opts, motivo] of [
    [{ control: 'duro' }, /es una exigencia/],
    // sin mayúsculas ni espacios de los bordes
    [{ control: ' Story-Gate ' }, /es una exigencia/],
    [{ control: 'esc-c1' }, /es una exigencia/],
    // un nombre de preferencia no tapa la llave de otro control
    [{ control: 'toy-switch', quitar: { env: { TYCON_OTHER_SWITCH: '0' } } }, /la llave TYCON_OTHER_SWITCH no es la de toy-switch \(sería TYCON_TOY_SWITCH\)/],
    [{ quitar: { neutralizar: { archivo: 'scripts/hooks/hard-guard.js', buscar: 'const FRENA = true;', poner: 'x' } } }, /corre una exigencia/],
    [{ quitar: { neutralizar: { archivo: 'scripts/hooks', buscar: 'x', poner: 'y' } } }, /no es un archivo común/],
    [{ models: 'm-uno' }, /models no es una lista/],
    [{ control: 'ESC-C3' }, /es una exigencia/],
    [{ control: 'story-gate' }, /es una exigencia/],
    [{ quitar: { env: { TYCON_NEW_SWITCH: 'off' } } }, /TYCON_NEW_SWITCH no es una llave del arnés/],
    [{ quitar: { env: { TYCON_TOY_SWITCH: '1' } } }, /TYCON_TOY_SWITCH=1 no la apaga/],
    [{ quitar: { neutralizar: { archivo: 'scripts/hooks/juguete-guard.js', buscar: 'no está', poner: 'x' } } }, /aparece 0 veces/],
    [{ quitar: {} }, /no dice cómo se quita/],
    [{ k: 3 }, /k \(3\) es mayor que sus historias \(2\)/],
  ]) {
    const raizN = tmp('resta-t15n-');
    const rn = correr(['--cases', caso(raizN, opts), '--harness', arnes, '--model', 'm-uno'], { agente, home });
    assert.strictEqual(rn.status, 2, `${JSON.stringify(opts)}: ${rn.stderr}`);
    assert.match(rn.stderr, motivo, JSON.stringify(opts));
  }

  // un enlace del arnés hacia afuera no se neutraliza: la copia escribiría a través de él
  const afuera = path.join(tmp('resta-afuera-'), 'ajeno.js');
  fs.writeFileSync(afuera, 'const FRENA = true;\n');
  const conEnlace = arnesDeJuguete();
  fs.symlinkSync(afuera, path.join(conEnlace, 'scripts', 'hooks', 'enlace.js'));
  const raizE = tmp('resta-t15e-');
  const quitarE = { neutralizar: { archivo: 'scripts/hooks/enlace.js', buscar: 'const FRENA = true;', poner: 'PWNED' } };
  const re = correr(['--cases', caso(raizE, { quitar: quitarE }), '--harness', conEnlace, '--model', 'm-uno'], { agente, home });
  assert.strictEqual(re.status, 2, re.stderr);
  assert.match(re.stderr, /no es un archivo común/);
  assert.strictEqual(fs.readFileSync(afuera, 'utf8'), 'const FRENA = true;\n', 'el archivo de afuera no cambió');

  // sin la clasificación del arnés no se sabe qué es una exigencia: no se corre
  const sinClasificacion = arnesDeJuguete();
  fs.rmSync(path.join(sinClasificacion, 'scripts', 'metrics', 'controls-classification.json'));
  const raizC = tmp('resta-t15c-');
  const rc = correr(['--cases', caso(raizC), '--harness', sinClasificacion, '--model', 'm-uno'], { agente, home });
  assert.strictEqual(rc.status, 2, rc.stderr);
  assert.match(rc.stderr, /no pude leer la clasificación/);
});

test('T15c Subtraction_PrepareKnowsItsSide @story-8.325 @ac-15: preparar recibe la llave del lado «sin», y nada del lado «con»', () => {
  // un control que el caso cablea él mismo (el pre-commit de git de un repo de juguete) sabe de qué lado está por `env`
  const raiz = tmp('resta-t15c-');
  const casos = path.join(raiz, 'casos');
  fs.mkdirSync(casos);
  fs.writeFileSync(path.join(casos, 'lado.corrector.js'), [
    "const fs = require('fs'); const path = require('path');",
    "module.exports.preparar = ({ dir, env }) => fs.writeFileSync(path.join(dir, 'lado.json'), JSON.stringify(env));",
    "module.exports.corregir = ({ dir }) => ({ cumple: fs.readFileSync(path.join(dir, 'lado.json'), 'utf8') === '{}', motivo: 'lado' });",
    '',
  ].join('\n'));
  const hs = [1, 2].map((i) => ({ nombre: `h${i}`, task: `Escribí hecho.txt (${i}).`, corrector: 'lado.corrector.js' }));
  fs.writeFileSync(path.join(casos, 'lado.json'), JSON.stringify({ control: 'toy-switch', quitar: { env: { TYCON_TOY_SWITCH: 'off' } }, ganchos: [], k: 2, historias: hs }));
  const r = correr(['--cases', casos, '--harness', arnesDeJuguete(), '--model', 'm-uno'], { agente: agenteFalso(raiz), home: tmp('resta-home-') });
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  // del lado «con» llega {} (cumple); del lado «sin», la llave (no cumple)
  assert.match(r.stdout, /con el control 2\/2 cumplen · sin él 0\/2/);

  // corregir mira con el control entero: de los dos lados recibe la copia del lado «con», también cuando el «sin» está
  // neutralizado
  const raiz2 = tmp('resta-t15c2-');
  const casos2 = path.join(raiz2, 'casos');
  fs.mkdirSync(casos2);
  fs.writeFileSync(path.join(casos2, 'vara.corrector.js'), [
    "const fs = require('fs'); const path = require('path');",
    "module.exports.corregir = ({ arnes }) => ({ cumple: fs.readFileSync(path.join(arnes, 'scripts/hooks/juguete-guard.js'), 'utf8').includes('const FRENA = true;'), motivo: 'vara' });",
    '',
  ].join('\n'));
  const quitar = { neutralizar: { archivo: 'scripts/hooks/juguete-guard.js', buscar: 'const FRENA = true;', poner: 'const FRENA = false;' } };
  const hs2 = [1, 2].map((i) => ({ nombre: `h${i}`, task: `Escribí hecho.txt (${i}).`, corrector: 'vara.corrector.js' }));
  fs.writeFileSync(path.join(casos2, 'vara.json'), JSON.stringify({ control: 'toy-switch', quitar, ganchos: [], k: 2, historias: hs2 }));
  const r2 = correr(['--cases', casos2, '--harness', arnesDeJuguete(), '--model', 'm-uno'], { agente: agenteFalso(raiz2), home: tmp('resta-home-') });
  assert.strictEqual(r2.status, 0, r2.stderr + r2.stdout);
  assert.match(r2.stdout, /con el control 2\/2 cumplen · sin él 2\/2/);
});

test('T15b Subtraction_ToyCorrector_TestsUntouched @story-8.325 @ac-15: el corrector de los casos del piloto no da «cumple» si el agente tocó las pruebas', () => {
  const dirCasos = path.join(TCG, 'scripts', 'controls-bench', 'cases', 'subtraction');
  const piloto = R.cargarCasos(dirCasos).find((e) => e.caso.control === 'ledger-visible');
  const historia = piloto.caso.historias.find((h) => h.nombre === 'renombrar');
  const corrector = require(path.join(dirCasos, historia.corrector));
  const cambiar = (dir) => {
    for (const f of fs.readdirSync(path.join(dir, 'src'))) {
      const p = path.join(dir, 'src', f);
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').split('calcularTotal').join('sumarTotal'));
    }
  };
  for (const [que, hacer, cumple] of [
    ['sin tocar nada', () => {}, false],
    ['la tarea hecha', cambiar, true],
    // reescribir las pruebas y borrar el nombre viejo no es hacer la tarea
    ['las pruebas reescritas', (dir) => {
      fs.writeFileSync(path.join(dir, 'test.js'), "console.log('ok');\n");
      for (const f of fs.readdirSync(path.join(dir, 'src'))) {
        const p = path.join(dir, 'src', f);
        fs.writeFileSync(p, fs.readFileSync(p, 'utf8').split('calcularTotal').join('x'));
      }
    }, false],
    ['la tarea hecha y la historia tocada', (dir) => { cambiar(dir); fs.appendFileSync(path.join(dir, 'specs', 'story-9.9-juguete.md'), 'listo\n'); }, false],
  ]) {
    const dir = R.armarArbol(historia);
    const casa = tmp('resta-casa-t15b-');
    try {
      corrector.preparar({ dir, casa, arnes: TCG, sesion: '11111111-2222-3333-4444-555555555555' });
      hacer(dir);
      const nota = corrector.corregir({ dir, casa });
      assert.strictEqual(nota.cumple, cumple, `${que}: ${nota.motivo}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('T16 Subtraction_NeverTouchesRealMachine @story-8.325 @ac-16: el control se quita sólo en el laboratorio', () => {
  const raiz = tmp('resta-t16-');
  const arnes = arnesDeJuguete();
  const agente = agenteFalso(raiz);
  // la HOME «real» de juguete, con su carpeta de estado y su configuración
  const home = tmp('resta-home-real-');
  escribir(home, '.claude/settings.json', '{"hooks":{}}\n');
  escribir(home, '.tycon/state/frenos.jsonl', '{"freno":"juguete"}\n');
  const antesHome = huella(home);
  const antesArnes = huella(arnes);
  const r = correr(['--cases', caso(raiz), '--harness', arnes, '--model', 'm-uno'], { agente, home });
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  // el gancho corrió (frenó con el control: 0 de 2) y anotó en SU casa, no en la de la persona
  assert.match(r.stdout, /con el control 0\/2 cumplen/);

  // la llave puesta en el ambiente de quien corre no apaga el control del lado «con»: los dos lados darían igual
  const rl = correr(['--cases', caso(tmp('resta-t16l-')), '--harness', arnes, '--model', 'm-uno'], { agente, home, env: { TYCON_TOY_SWITCH: 'off' } });
  assert.strictEqual(rl.status, 0, rl.stderr + rl.stdout);
  assert.match(rl.stdout, /con el control 0\/2 cumplen · sin él 2\/2/);
  assert.strictEqual(R.ambienteDelAgente(['TYCON_TOY_SWITCH'], { TYCON_TOY_SWITCH: 'off', PATH: '/bin' }).TYCON_TOY_SWITCH, undefined);
  assert.strictEqual(huella(home), antesHome, 'la HOME de la persona no cambió');
  assert.strictEqual(huella(arnes), antesArnes, 'el arnés no cambió');

  // la casa del laboratorio vive en la carpeta temporal y nunca es la HOME de quien corre
  const casa = R.casaDelLaboratorio({ home });
  try {
    assert.ok(casa.startsWith(fs.realpathSync(os.tmpdir())) || casa.startsWith(os.tmpdir()), casa);
    assert.notStrictEqual(path.resolve(casa), path.resolve(home));
  } finally { fs.rmSync(casa, { recursive: true, force: true }); }
  assert.throws(() => R.casaDelLaboratorio({ home: os.tmpdir() }), /la casa del laboratorio no puede ser la HOME/);

  // los ganchos del laboratorio apuntan a la copia del arnés y a la casa del laboratorio
  const s = R.settingsDelLaboratorio({ ganchos: ['@tcg:juguete-guard.js'], lista: JSON.parse(fs.readFileSync(path.join(arnes, 'scripts/setup/hooks-list.json'), 'utf8')), copia: '/lab/arnes', casa: '/lab/casa', env: { TYCON_TOY_SWITCH: 'off' } });
  // los comandos del agente también ven la casa del laboratorio; la llave de quitar va sólo a los ganchos
  assert.deepStrictEqual(s.env, { HOME: '/lab/casa', TYCON_GUIDES_DIR: '/lab/arnes', TYCON_EVAL_SANDBOX: '1' });
  const cmd = s.hooks.PreToolUse[0].hooks[0].command;
  assert.match(cmd, /HOME='\/lab\/casa'/);
  assert.match(cmd, /TYCON_TOY_SWITCH='off'/);
  assert.match(cmd, /TYCON_GUIDES_DIR='\/lab\/arnes'/);
  assert.match(cmd, /'\/lab\/arnes\/scripts\/hooks\/juguete-guard\.js'/);
  assert.doesNotMatch(cmd, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('T17 Subtraction_TooFewRuns_NotEnough @story-8.325 @ac-17: con menos de K corridas medidas por lado no alcanza para decidir', () => {
  // la cuenta, sola
  const lado = (cumplen) => cumplen.map((c) => ({ medida: true, cumple: c, costo_usd: 0.02 }));
  const corto = R.resumir({ control: 'juguete', modelo: 'm', k: 3, con: lado([true, true]), sin: lado([true, true, true]) });
  assert.strictEqual(corto.veredicto, 'no alcanza para decidir');
  assert.strictEqual(corto.cumple_igual, null);
  const justo = R.resumir({ control: 'juguete', modelo: 'm', k: 2, con: lado([true, false]), sin: lado([true, false]) });
  assert.strictEqual(justo.veredicto, null);
  assert.strictEqual(justo.cumple_igual, true);
  // una corrida que no se pudo medir no cuenta como «no cumple»: se cuenta aparte
  const caida = R.resumir({ control: 'juguete', modelo: 'm', k: 2, con: [...lado([true]), { medida: false, motivo: 'se cayó' }], sin: lado([true, true]) });
  assert.deepStrictEqual([caida.con.corridas, caida.sin_medir, caida.veredicto], [1, 1, 'no alcanza para decidir']);

  // de punta a punta: una historia se cae en los dos lados y quedan 1 de 2 medidas
  const raiz = tmp('resta-t17-');
  const r = correr(['--cases', caso(raiz, { tareas: ['Escribí hecho.txt.', 'CRASH'] }), '--harness', arnesDeJuguete(), '--model', 'm-uno', '--json', path.join(raiz, 'i.json')],
    { agente: agenteFalso(raiz), home: tmp('resta-home-') });
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /no alcanza para decidir/);
  const x = JSON.parse(fs.readFileSync(path.join(raiz, 'i.json'), 'utf8')).resultados[0];
  assert.deepStrictEqual([x.con.corridas, x.sin.corridas, x.sin_medir], [1, 1, 2]);
});
