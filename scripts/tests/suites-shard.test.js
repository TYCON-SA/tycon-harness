'use strict';

/**
 * suites-shard.test.js — el reparto de las suites del nocturno en trabajos paralelos.
 *
 * Las suites del nocturno, una detrás de otra en un solo carril, no entran en el tope del job.
 * `scripts/ci/suites-shard.js` las reparte en N trabajos por peso.
 *
 * Lo que no puede pasar, y es lo que se mide acá:
 *   · que una suite quede fuera de todos los trabajos, o en dos (la unión es EXACTAMENTE la lista);
 *   · que una suite nueva, sin peso medido, no entre;
 *   · que un pedido mal hecho imprima una lista vacía y se lea como «no hay suites» (sale 2, sin lista);
 *   · que las suites de un trabajo que no terminó se den por verdes o desaparezcan del reporte.
 *
 * Sin bash, sin red y sin agent-skills: todo corre sobre listas de laboratorio y carpetas temporales.
 * Lo que mira el YAML del nocturno (pipelines/, que no sale en la copia pública) vive aparte, en
 * scripts/tests/nightly-suites-shards.test.js.
 *
 * Correr: node --test scripts/tests/suites-shard.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', 'ci', 'suites-shard.js');
const REAL_SUITES = path.resolve(__dirname, 'suites.json');
const REAL_WEIGHTS = path.resolve(__dirname, '..', 'ci', 'suites-weights.json');

const LAB_SUITES = {
  diarias: [
    { raiz: 'arnes', ruta: 'tests/a-slow.test.sh', requiere: [] },
    { raiz: 'arnes', ruta: 'tests/b-fast.test.js', requiere: [] },
    { raiz: 'agent-skills', ruta: 'tycon-pipeline/scripts/tests/c-skill.test.js', requiere: [] },
    { raiz: 'arnes', ruta: 'tests/d-medium.test.sh', requiere: [] },
    { raiz: 'arnes', ruta: 'tests/e-fast.test.js', requiere: [] },
    { raiz: 'arnes', ruta: 'tests/f-new-without-weight.test.js', requiere: [] },
  ],
  semanales: [{ raiz: 'arnes', ruta: 'tests/g-weekly.test.sh', requiere: [] }],
};
const LAB_WEIGHTS = {
  default: 3,
  weights: { 'a-slow.test.sh': 100, 'd-medium.test.sh': 40, 'g-weekly.test.sh': 30, 'c-skill.test.js': 20 },
};
const ALL = ['a-slow.test.sh', 'b-fast.test.js', 'c-skill.test.js', 'd-medium.test.sh', 'e-fast.test.js', 'f-new-without-weight.test.js', 'g-weekly.test.sh'];

const labs = [];
test.after(() => { for (const d of labs) fs.rmSync(d, { recursive: true, force: true }); });

/** Una carpeta con la lista y los pesos de laboratorio (o los que se le pasen, ya como texto). */
function lab({ suites = LAB_SUITES, weights = LAB_WEIGHTS } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suites-shard-'));
  labs.push(dir);
  if (suites !== null) fs.writeFileSync(path.join(dir, 'suites.json'), typeof suites === 'string' ? suites : JSON.stringify(suites));
  if (weights !== null) fs.writeFileSync(path.join(dir, 'weights.json'), typeof weights === 'string' ? weights : JSON.stringify(weights));
  return dir;
}
function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, lines: r.stdout.split('\n').filter(Boolean) };
}
function list(dir, shard, of, extra = []) {
  return run(['list', '--shard', String(shard), '--of', String(of), '--skills', '/S/skills', '--scripts', '/R/scripts',
    '--suites', path.join(dir, 'suites.json'), '--weights', path.join(dir, 'weights.json'), ...extra]);
}
/** La lista entera, en el orden de suites.json, como la armaría un `node -e` en el YAML sin repartir: sirve de referencia. */
function legacyList(suites, skills, scripts) {
  return [...suites.diarias, ...(suites.semanales || [])].map((x) => `${x.raiz === 'agent-skills' ? skills : scripts}/${x.ruta}`);
}

// ── el reparto ───────────────────────────────────────────────────────────────────────────────────────────────────
test('SuitesShard_OneShard_PrintsTheWholeListAsTheNightlyDidBefore', () => {
  const r = list(lab(), 1, 1);
  assert.strictEqual(r.code, 0, r.err);
  assert.deepStrictEqual(r.lines, legacyList(LAB_SUITES, '/S/skills', '/R/scripts'),
    'con un solo trabajo sale la misma lista, con las mismas rutas y en el mismo orden que armaba el YAML');
});

test('SuitesShard_AnyNumberOfShards_UnionIsExactlyTheListAndNoSuiteRunsTwice', () => {
  const dir = lab();
  const whole = legacyList(LAB_SUITES, '/S/skills', '/R/scripts');
  for (const of of [1, 2, 3, 4, 7]) {
    const seen = [];
    for (let i = 1; i <= of; i += 1) {
      const r = list(dir, i, of);
      assert.strictEqual(r.code, 0, `trabajo ${i} de ${of}: ${r.err}`);
      assert.ok(r.lines.length > 0, `trabajo ${i} de ${of}: ningún trabajo queda vacío`);
      seen.push(...r.lines);
    }
    assert.strictEqual(new Set(seen).size, seen.length, `con ${of} trabajos una suite quedó en dos: ${seen.join(' ')}`);
    assert.deepStrictEqual([...seen].sort(), [...whole].sort(), `con ${of} trabajos la unión no es la lista completa`);
  }
});

test('SuitesShard_ByWeight_HeaviestGoesAloneAndTheRestFillTheLightestShard', () => {
  // Pesos: a=100, d=40, g=30, c=20 y b, e, f = 3 (por defecto). Orden: a, d, g, c, b, e, f.
  //   a → 1 (100) · d → 2 (40) · g → 2 (70) · c → 2 (90) · b → 2 (93) · e → 2 (96) · f → 2 (99)
  const dir = lab();
  const names = (r) => r.lines.map((l) => path.basename(l));
  assert.deepStrictEqual(names(list(dir, 1, 2)), ['a-slow.test.sh']);
  assert.deepStrictEqual(names(list(dir, 2, 2)),
    ['b-fast.test.js', 'c-skill.test.js', 'd-medium.test.sh', 'e-fast.test.js', 'f-new-without-weight.test.js', 'g-weekly.test.sh'],
    'cada trabajo conserva el orden de suites.json');
});

test('SuitesShard_SameInput_SameOutput_WhateverTheOrderOfTheWeightsFile', () => {
  const a = lab();
  const reversed = { default: 3, weights: Object.fromEntries(Object.entries(LAB_WEIGHTS.weights).reverse()) };
  const b = lab({ weights: reversed });
  for (let i = 1; i <= 3; i += 1) {
    const first = list(a, i, 3);
    assert.deepStrictEqual(list(a, i, 3).lines, first.lines, 'dos corridas iguales dan lo mismo');
    assert.deepStrictEqual(list(b, i, 3).lines, first.lines, 'el orden de las claves del archivo de pesos no cambia el reparto');
  }
});

test('SuitesShard_TiedWeights_AreOrderedByName', () => {
  // Cuatro suites sin peso (3 s cada una) en dos trabajos: por nombre, alternadas.
  const suites = { diarias: ['z', 'y', 'x', 'w'].map((n) => ({ raiz: 'arnes', ruta: `tests/${n}.test.js`, requiere: [] })), semanales: [] };
  const dir = lab({ suites, weights: { default: 3, weights: {} } });
  const names = (r) => r.lines.map((l) => path.basename(l));
  assert.deepStrictEqual(names(list(dir, 1, 2)), ['y.test.js', 'w.test.js'], 'w y luego y van al 1 (se imprimen en el orden de suites.json)');
  assert.deepStrictEqual(names(list(dir, 2, 2)), ['z.test.js', 'x.test.js']);
});

test('SuitesShard_NewSuiteWithoutWeight_StillRuns', () => {
  const dir = lab();
  const seen = [1, 2, 3].flatMap((i) => list(dir, i, 3).lines);
  assert.ok(seen.includes('/R/scripts/tests/f-new-without-weight.test.js'), 'una suite sin peso medido entra con el peso por defecto');
});

test('SuitesShard_Paths_SkillsRootForAgentSkillsAndScriptsRootForTheRest', () => {
  const seen = list(lab(), 1, 1).lines;
  assert.ok(seen.includes('/S/skills/tycon-pipeline/scripts/tests/c-skill.test.js'));
  assert.ok(seen.includes('/R/scripts/tests/a-slow.test.sh'));
});

test('SuitesShard_DefaultSuitesFile_IsTheOneUnderTheScriptsRoot', () => {
  // Sin --suites, la lista es la del arnés cuya raíz de scripts se nombra: <scripts>/tests/suites.json.
  const dir = lab({ suites: null });
  fs.mkdirSync(path.join(dir, 'scripts', 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'tests', 'suites.json'), JSON.stringify(LAB_SUITES));
  const scripts = path.join(dir, 'scripts');
  const r = run(['list', '--shard', '1', '--of', '1', '--skills', '/S/skills', '--scripts', scripts, '--weights', path.join(dir, 'weights.json')]);
  assert.strictEqual(r.code, 0, r.err);
  assert.deepStrictEqual(r.lines, legacyList(LAB_SUITES, '/S/skills', scripts));
});

// ── lo que se niega: sale 2, dice por qué y NO imprime lista ─────────────────────────────────────────────────────
function refuses(r, pattern, what) {
  assert.strictEqual(r.code, 2, `${what}: tenía que salir 2 (salió ${r.code})\n${r.out}\n${r.err}`);
  assert.strictEqual(r.out, '', `${what}: no puede imprimir ninguna lista`);
  assert.match(r.err, pattern, `${what}: tiene que decir por qué`);
}

test('SuitesShard_ShardOutOfRange_Exits2WithoutAList', () => {
  const dir = lab();
  refuses(list(dir, 0, 3), /--shard/, 'trabajo 0');
  refuses(list(dir, 4, 3), /--shard/, 'trabajo 4 de 3');
  refuses(list(dir, -1, 3), /--shard/, 'trabajo negativo');
  refuses(list(dir, '1.5', 3), /--shard/, 'trabajo con decimales');
  refuses(list(dir, 'uno', 3), /--shard/, 'trabajo que no es un número');
  refuses(run(['list', '--of', '3', '--skills', '/S', '--scripts', '/R', '--suites', path.join(dir, 'suites.json'), '--weights', path.join(dir, 'weights.json')]),
    /--shard/, 'sin --shard');
});

test('SuitesShard_InvalidOf_Exits2WithoutAList', () => {
  const dir = lab();
  refuses(list(dir, 1, 0), /--of/, '0 trabajos');
  refuses(list(dir, 1, 'tres'), /--of/, 'un --of que no es un número');
  refuses(list(dir, 1, '2x'), /--of/, 'un --of con letras');
  refuses(list(dir, 1, 8), /--of/, 'más trabajos que suites (alguno quedaría vacío)');
  refuses(run(['list', '--shard', '1', '--skills', '/S', '--scripts', '/R', '--suites', path.join(dir, 'suites.json'), '--weights', path.join(dir, 'weights.json')]),
    /--of/, 'sin --of');
});

test('SuitesShard_UnreadableSuitesFile_Exits2WithoutAList', () => {
  refuses(list(lab({ suites: null }), 1, 3), /suites\.json/, 'sin suites.json');
  refuses(list(lab({ suites: '{ esto no es json' }), 1, 3), /suites\.json/, 'suites.json roto');
  refuses(list(lab({ suites: { semanales: [] } }), 1, 3), /diarias/, 'suites.json sin «diarias»');
  refuses(list(lab({ suites: { diarias: [], semanales: [] } }), 1, 1), /ninguna suite/, 'suites.json vacío');
  refuses(list(lab({ suites: { diarias: [{ raiz: 'arnes', requiere: [] }] } }), 1, 1), /ruta/, 'una entrada sin ruta');
  const twice = { diarias: [{ raiz: 'arnes', ruta: 'tests/x.test.js' }, { raiz: 'agent-skills', ruta: 'otra/x.test.js' }] };
  refuses(list(lab({ suites: twice }), 1, 1), /x\.test\.js/, 'dos suites con el mismo nombre (el reporte las confundiría)');
});

test('SuitesShard_BrokenWeightsFile_Exits2WithoutAList', () => {
  refuses(list(lab({ weights: null }), 1, 3), /peso/, 'sin archivo de pesos');
  refuses(list(lab({ weights: '{ roto' }), 1, 3), /peso/, 'archivo de pesos roto');
  refuses(list(lab({ weights: { weights: {} } }), 1, 3), /default/, 'sin peso por defecto');
  refuses(list(lab({ weights: { default: 0, weights: {} } }), 1, 3), /default/, 'peso por defecto en 0');
  refuses(list(lab({ weights: { default: 3, weights: { 'a-slow.test.sh': -5 } } }), 1, 3), /a-slow\.test\.sh/, 'un peso negativo');
  refuses(list(lab({ weights: { default: 3, weights: { 'a-slow.test.sh': 'mucho' } } }), 1, 3), /a-slow\.test\.sh/, 'un peso que no es un número');
});

test('SuitesShard_MissingRootsOrUnknownCommand_Exits2', () => {
  const dir = lab();
  const base = ['--suites', path.join(dir, 'suites.json'), '--weights', path.join(dir, 'weights.json')];
  refuses(run(['list', '--shard', '1', '--of', '1', '--scripts', '/R', ...base]), /--skills/, 'sin --skills');
  refuses(run(['list', '--shard', '1', '--of', '1', '--skills', '/S', ...base]), /--scripts/, 'sin --scripts');
  refuses(run(['repartir', '--of', '2', ...base]), /uso/i, 'un subcomando que no existe');
  refuses(run([]), /uso/i, 'sin subcomando');
});

// ── plan: para leer a mano ───────────────────────────────────────────────────────────────────────────────────────
test('SuitesShard_Plan_SaysHowManySuitesAndSecondsEachShardCarries', () => {
  const dir = lab();
  const r = run(['plan', '--of', '2', '--suites', path.join(dir, 'suites.json'), '--weights', path.join(dir, 'weights.json')]);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.lines[0], /trabajo 1 de 2: +1 suite\(s\) · ~100 s/);
  assert.match(r.lines[1], /trabajo 2 de 2: +6 suite\(s\) · ~99 s/);
  assert.match(r.out, /7 suite\(s\).*~199 s/, 'el total');
  assert.match(r.out, /3 sin peso medido/, 'cuántas van con el peso por defecto');
  refuses(run(['plan', '--of', '0', '--suites', path.join(dir, 'suites.json'), '--weights', path.join(dir, 'weights.json')]), /--of/, 'plan con 0 trabajos');
});

// ── --only: el control de cada cambio reparte sólo las suites que de verdad corren ─────────────────────────────────
// En la validación de los pedidos de merge (pipelines/azure-pipelines-maintainers-pr.yml) algunas suites no corren si el cambio no
// toca lo que miden (scripts/ci/suites-for-change.js). Si el reparto se hiciera sobre la lista entera, la copia pública
// —la más pesada, casi siempre salteada— quedaría sola en un trabajo y el otro se llevaría todo lo demás.
function onlyFile(dir, lines) {
  const f = path.join(dir, 'only.txt');
  fs.writeFileSync(f, lines.map((l) => `${l}\n`).join(''));
  return f;
}

test('SuitesShard_Only_PartitionsJustTheSuitesThatRunAndTheUnionIsExactlyThem', () => {
  const dir = lab();
  // Las líneas pueden ser rutas (como las que escribe suites-for-change.js) o nombres pelados.
  const only = onlyFile(dir, ['/R/scripts/tests/b-fast.test.js', 'c-skill.test.js', '/R/scripts/tests/d-medium.test.sh', 'g-weekly.test.sh']);
  const seen = [];
  for (const i of [1, 2]) {
    const r = list(dir, i, 2, ['--only', only]);
    assert.strictEqual(r.code, 0, r.err);
    seen.push(...r.lines.map((l) => path.basename(l)));
  }
  assert.deepStrictEqual([...seen].sort(), ['b-fast.test.js', 'c-skill.test.js', 'd-medium.test.sh', 'g-weekly.test.sh'],
    'la unión de los trabajos es exactamente lo que corre; a-slow (la más pesada) no le quita un trabajo a nadie');
  // d-medium (40) al 1, g-weekly (30) y c-skill (20) al 2, b-fast (3) al más liviano: el 1 (40 contra 50).
  assert.deepStrictEqual(expected(dir, 1, 2, ['--only', only]), ['b-fast.test.js', 'd-medium.test.sh'], 'el reparto se hace con los pesos de las que corren');
  const plan = run(['plan', '--of', '2', '--only', only, '--suites', path.join(dir, 'suites.json'), '--weights', path.join(dir, 'weights.json')]);
  assert.strictEqual(plan.code, 0, plan.err);
  assert.match(plan.out, /total: 4 suite\(s\) · ~93 s/, 'plan mide lo mismo que se va a correr');
});

test('SuitesShard_Only_UnknownEmptyOrUnreadable_Exits2WithoutAList', () => {
  const dir = lab();
  refuses(list(dir, 1, 2, ['--only', onlyFile(dir, ['b-fast.test.js', 'no-existe.test.sh'])]), /no-existe\.test\.sh/, 'una suite que no está en suites.json');
  refuses(list(dir, 1, 2, ['--only', onlyFile(dir, [])]), /--only/, 'una lista vacía (sería «no hay suites»)');
  refuses(list(dir, 1, 2, ['--only', path.join(dir, 'no-existe.txt')]), /--only/, 'una lista que no se deja leer');
  refuses(list(dir, 1, 2, ['--only']), /--only/, '--only sin archivo');
  refuses(list(dir, 1, 3, ['--only', onlyFile(dir, ['b-fast.test.js', 'c-skill.test.js'])]), /--of/, 'más trabajos que suites que corren');
});

test('SuitesShard_Merge_WithOnly_ExpectsTheSamePartition', () => {
  const dir = lab();
  const only = onlyFile(dir, ['b-fast.test.js', 'c-skill.test.js', 'd-medium.test.sh', 'g-weekly.test.sh']);
  artifact(dir, 1, 2, { only: ['--only', only] });
  artifact(dir, 2, 2, { only: ['--only', only] });
  const m = merge(dir, 2, ['--only', only]);
  assert.strictEqual(m.code, 0, m.err);
  assert.deepStrictEqual([...m.ran].sort(), ['b-fast.test.js', 'c-skill.test.js', 'd-medium.test.sh', 'g-weekly.test.sh']);
  assert.deepStrictEqual(m.failures, [], 'las que no corren por el cambio no son fallas ni no medidas: no estaban en la lista');
  assert.doesNotMatch(m.out, /task\.logissue/);
});

// ── la lista y los pesos de verdad ───────────────────────────────────────────────────────────────────────────────
test('SuitesShard_RealList_UnionIsExactlyTheListForTwoToFiveShards', () => {
  const suites = JSON.parse(fs.readFileSync(REAL_SUITES, 'utf8'));
  const whole = legacyList(suites, '/S/skills', '/R/scripts');
  for (const of of [2, 3, 4, 5]) {
    const seen = [];
    for (let i = 1; i <= of; i += 1) {
      const r = run(['list', '--shard', String(i), '--of', String(of), '--skills', '/S/skills', '--scripts', '/R/scripts', '--suites', REAL_SUITES]);
      assert.strictEqual(r.code, 0, `trabajo ${i} de ${of}: ${r.err}`);
      seen.push(...r.lines);
    }
    assert.strictEqual(new Set(seen).size, seen.length, `con ${of} trabajos una suite quedó en dos`);
    assert.deepStrictEqual([...seen].sort(), [...whole].sort(), `con ${of} trabajos la unión no es la lista completa`);
  }
});

test('SuitesShard_RealWeights_AreReadableAndPositive', () => {
  const w = JSON.parse(fs.readFileSync(REAL_WEIGHTS, 'utf8'));
  assert.ok(Number.isFinite(w.default) && w.default > 0, 'el peso por defecto es un número mayor que 0');
  assert.ok(Object.keys(w.weights).length >= 6, 'trae al menos las suites más largas');
  for (const [name, seconds] of Object.entries(w.weights)) assert.ok(Number.isFinite(seconds) && seconds > 0, `${name}: ${seconds}`);
});

// ── el juego de pesos de la validación ─────────────────────────────────────────────────────────
// El nocturno y la validación de cada rama (la 170) no tardan lo mismo: clean-machine son minutos en el nocturno y ~3 s
// en la 170, y export-real ~391 s en la 170 contra los 1439 anotados. La 170 pide su juego con --weight-set pr.
test('SuitesWeights_PrSetHasMeasuredValues', () => {
  const pr = JSON.parse(fs.readFileSync(REAL_WEIGHTS, 'utf8')).pr;
  assert.ok(pr && typeof pr === 'object', 'suites-weights.json trae el juego `pr` de la validación');
  assert.ok(Array.isArray(pr.runs) && pr.runs.length > 0 && pr.runs.every((n) => Number.isInteger(n) && n > 0),
    `el juego cita las corridas de la 170 de donde salen sus pesos: ${JSON.stringify(pr.runs)}`);
  assert.ok(Number.isFinite(pr.default) && pr.default > 0, 'el juego trae su peso por defecto');
  // (export-real, que pesa distinto en la validación y de noche, no está: la copia armada no existe;
  // que cada juego use sus pesos lo mide el caso de juguete de SuitesShard_PrWeightsOnlyInPr)
  for (const [name, seconds] of Object.entries(pr.weights)) assert.ok(Number.isFinite(seconds) && seconds > 0, `${name}: ${seconds}`);
});

test('SuitesShard_PrWeightsOnlyInPr', () => {
  // a-slow hace de clean-machine: 433 en el juego del nocturno, 5 en el de la 170. d-medium no está en el de la 170.
  const dir = lab({ weights: { ...LAB_WEIGHTS, weights: { ...LAB_WEIGHTS.weights, 'a-slow.test.sh': 433 },
    pr: { runs: [12181], default: 2, weights: { 'a-slow.test.sh': 5 } } } });
  const plan = (names, extra = []) => run(['plan', '--of', '1', '--only', onlyFile(dir, names),
    '--suites', path.join(dir, 'suites.json'), '--weights', path.join(dir, 'weights.json'), ...extra]);
  const pr = ['--weight-set', 'pr'];
  const withPr = plan(['a-slow.test.sh'], pr);
  assert.strictEqual(withPr.code, 0, withPr.err);
  assert.match(withPr.out, /total: 1 suite\(s\) · ~5 s/, 'con el juego de la 170 pesa lo de la 170');
  assert.match(plan(['a-slow.test.sh']).out, /total: 1 suite\(s\) · ~433 s/, 'sin el parámetro, el juego del nocturno como siempre');
  assert.match(plan(['d-medium.test.sh'], pr).out, /total: 1 suite\(s\) · ~40 s/, 'la que el juego no trae toma el peso del nocturno');
  assert.match(plan(['b-fast.test.js'], pr).out, /total: 1 suite\(s\) · ~2 s/, 'sin peso en ninguno, el por defecto del juego pedido');

  // El reparto cambia con el juego, y list y merge lo tienen que pedir igual que plan.
  assert.deepStrictEqual(expected(dir, 1, 2), ['a-slow.test.sh'], 'con el del nocturno, a-slow va sola');
  assert.deepStrictEqual(expected(dir, 1, 2, pr), ['a-slow.test.sh', 'b-fast.test.js', 'd-medium.test.sh', 'e-fast.test.js', 'f-new-without-weight.test.js'],
    'con el de la 170: d (40) al 1, g (30) y c (20) al 2, a (5) y las de 2 s al más liviano');
  artifact(dir, 1, 2, { only: pr });
  artifact(dir, 2, 2, { only: pr });
  const same = merge(dir, 2, pr);
  assert.strictEqual(same.code, 0, same.err);
  assert.deepStrictEqual(same.failures, [], 'con el mismo juego, merge reconoce el reparto de los trabajos');

  refuses(plan(['a-slow.test.sh'], ['--weight-set', 'nocturno-viejo']), /nocturno-viejo/, 'un juego que no existe');
  refuses(plan(['a-slow.test.sh'], ['--weight-set']), /--weight-set/, '--weight-set sin nombre');
  const broken = lab({ weights: { ...LAB_WEIGHTS, pr: { runs: [1], default: 2, weights: { 'a-slow.test.sh': 'mucho' } } } });
  refuses(run(['plan', '--of', '1', '--suites', path.join(broken, 'suites.json'), '--weights', path.join(broken, 'weights.json'), ...pr]),
    /a-slow\.test\.sh/, 'un peso roto en el juego pedido');
  const noDefault = lab({ weights: { ...LAB_WEIGHTS, pr: { runs: [1], weights: {} } } });
  refuses(run(['plan', '--of', '1', '--suites', path.join(noDefault, 'suites.json'), '--weights', path.join(noDefault, 'weights.json'), ...pr]),
    /default/, 'un juego sin peso por defecto');
});

// ── cuántos trabajos ───────────────────────────────────────────────────────────────────────
test('SuitesShard_JobCountFromPlanWeight', () => {
  // El juego de la 170 trae cuánto peso entra en un trabajo. Con 60 s: 4 s → 1, 100 s → 2, 196 s → 4, que el máximo deja en 3.
  const dir = lab({ weights: { ...LAB_WEIGHTS, pr: { runs: [12181], default: 2, job_budget: 60, weights: {} } } });
  const jobs = (names, extra = []) => run(['jobs', '--max', '3', ...(names ? ['--only', onlyFile(dir, names)] : []), '--weight-set', 'pr',
    '--suites', path.join(dir, 'suites.json'), '--weights', path.join(dir, 'weights.json'), ...extra]);
  const small = jobs(['b-fast.test.js', 'e-fast.test.js']);
  assert.strictEqual(small.code, 0, small.err);
  assert.deepStrictEqual(small.lines, ['1'], 'un plan chico pide un solo trabajo');
  assert.match(small.err, /1 trabajo\(s\) de un máximo de 3 · ~4 s de peso · 60 s por trabajo/, 'y dice por qué');
  assert.deepStrictEqual(jobs(['a-slow.test.sh']).lines, ['1'], 'una sola suite, un solo trabajo: no se puede partir');
  assert.deepStrictEqual(jobs(['a-slow.test.sh', 'b-fast.test.js']).lines, ['2'], 'un plan mediano, dos');
  assert.deepStrictEqual(jobs(null).lines, ['3'], 'uno grande, el máximo');
  assert.deepStrictEqual(jobs(['a-slow.test.sh', 'b-fast.test.js'], ['--budget', '500']).lines, ['1'], '--budget pisa el del juego');

  refuses(jobs(['a-slow.test.sh'], ['--budget', '0']), /--budget/, 'un presupuesto que no es un número mayor que 0');
  refuses(run(['jobs', '--max', 'x', '--weight-set', 'pr', '--suites', path.join(dir, 'suites.json'), '--weights', path.join(dir, 'weights.json')]),
    /--max/, 'un máximo que no es un entero mayor que 0');
  const noBudget = lab({ weights: { ...LAB_WEIGHTS, pr: { runs: [1], default: 2, weights: {} } } });
  refuses(run(['jobs', '--max', '2', '--weight-set', 'pr', '--suites', path.join(noBudget, 'suites.json'), '--weights', path.join(noBudget, 'weights.json')]),
    /job_budget/, 'un juego sin presupuesto: no se adivina');
  refuses(run(['jobs', '--max', '2', '--suites', path.join(dir, 'suites.json'), '--weights', path.join(dir, 'weights.json')]),
    /job_budget/, 'el juego del nocturno no trae presupuesto');

  // La matriz que lee Azure, y el número que cada paso saca de ella.
  const m = run(['matrix', '--of', '2']);
  assert.strictEqual(m.code, 0, m.err);
  assert.deepStrictEqual(JSON.parse(m.out), { shard_1: { SUITES_SHARD: '1', SUITES_OF: '2' }, shard_2: { SUITES_SHARD: '2', SUITES_OF: '2' } });
  assert.strictEqual(m.lines.length, 1, 'en una sola línea: es el valor de una variable');
  assert.deepStrictEqual(run(['of', '--matrix', m.out.trim()]).lines, ['2'], 'la vuelta da el mismo número');
  refuses(run(['matrix', '--of', '0']), /--of/, 'una matriz de 0 trabajos');
  for (const [broken, why] of [['', 'vacía'], ['{', 'que no es JSON'], ['{}', 'sin trabajos'],
    ['{"shard_1":{"SUITES_SHARD":"1","SUITES_OF":"2"}}', 'a la que le falta un trabajo'],
    ['{"shard_1":{"SUITES_SHARD":"1","SUITES_OF":"2"},"shard_2":{"SUITES_SHARD":"2","SUITES_OF":"3"}}', 'con dos cuentas distintas'],
    ['{"shard_1":{"SUITES_SHARD":"2","SUITES_OF":"2"},"shard_2":{"SUITES_SHARD":"1","SUITES_OF":"2"}}', 'con los números cruzados']]) {
    refuses(run(['of', '--matrix', broken]), /--matrix/, `una matriz ${why}`);
  }
});

// ── el tope de cada suite ───────────────────────────────────────────────────────────────────
test('SuitesShard_CapsFromWeightWithFloor', () => {
  // El tope es el doble del peso del juego pedido, con un piso. a-slow pesa 100 → 200; d-medium (sólo en el nocturno,
  // 40) → 80, que el piso deja en 90; b-fast (sin peso en ninguno, el default 2) → el piso.
  const dir = lab({ weights: { ...LAB_WEIGHTS, pr: { runs: [12181], default: 2, suite_cap: { factor: 2, floor: 90 }, weights: { 'a-slow.test.sh': 100 } } } });
  const caps = (names, extra = []) => run(['caps', '--only', onlyFile(dir, names), '--weight-set', 'pr',
    '--suites', path.join(dir, 'suites.json'), '--weights', path.join(dir, 'weights.json'), ...extra]);
  const r = caps(['a-slow.test.sh', 'b-fast.test.js', 'd-medium.test.sh']);
  assert.strictEqual(r.code, 0, r.err);
  assert.deepStrictEqual(r.lines, ['a-slow.test.sh\t200', 'b-fast.test.js\t90', 'd-medium.test.sh\t90'],
    'una línea por suite de la lista, en el orden de suites.json: el nombre y su tope en segundos');
  const all = run(['caps', '--weight-set', 'pr', '--suites', path.join(dir, 'suites.json'), '--weights', path.join(dir, 'weights.json')]);
  assert.strictEqual(all.lines.length, ALL.length, 'sin --only, todas');

  // Sin regla no hay tope que adivinar: sale 2 y sin lista (quien llama corre sin tope y lo dice).
  const noRule = lab({ weights: { ...LAB_WEIGHTS, pr: { runs: [1], default: 2, weights: {} } } });
  refuses(run(['caps', '--weight-set', 'pr', '--suites', path.join(noRule, 'suites.json'), '--weights', path.join(noRule, 'weights.json')]),
    /suite_cap/, 'un juego sin suite_cap');
  refuses(run(['caps', '--suites', path.join(dir, 'suites.json'), '--weights', path.join(dir, 'weights.json')]),
    /suite_cap/, 'el juego del nocturno no trae tope');
  for (const [rule, why] of [[{ factor: 0, floor: 90 }, 'un factor de 0'], [{ factor: 2 }, 'sin piso'], [{ factor: 'x', floor: 9 }, 'un factor que no es número'], [[2, 90], 'una lista']]) {
    const broken = lab({ weights: { ...LAB_WEIGHTS, pr: { runs: [1], default: 2, suite_cap: rule, weights: {} } } });
    refuses(run(['caps', '--weight-set', 'pr', '--suites', path.join(broken, 'suites.json'), '--weights', path.join(broken, 'weights.json')]),
      /suite_cap/, why);
  }
  // Un suite_cap roto rompe el juego entero también para plan: es el mismo archivo y la misma lectura.
  const broken = lab({ weights: { ...LAB_WEIGHTS, pr: { runs: [1], default: 2, suite_cap: { factor: -1, floor: 9 }, weights: {} } } });
  refuses(run(['plan', '--of', '1', '--weight-set', 'pr', '--suites', path.join(broken, 'suites.json'), '--weights', path.join(broken, 'weights.json')]),
    /suite_cap/, 'plan con un suite_cap roto');
});

test('SuitesWeights_NightlySetMeasuredAndCapped', () => {
  // El tope por suite rige también en el nocturno. Sus pesos son lo medido (harness-update tarda ~869 s: con un peso
  // viejo de 96 s, su tope la cortaría todas las noches). Ninguna suite lleva tope propio en el nocturno: el tope de
  // todas es el doble de su peso.
  const real = JSON.parse(fs.readFileSync(REAL_WEIGHTS, 'utf8'));
  assert.deepStrictEqual(real.suite_cap, { factor: 2, floor: 180 });
  assert.deepStrictEqual(real.runs, [12240, 12216, 12196], 'el nocturno cita los bancos de donde salen sus pesos');
  const hu = real.weights['harness-update.test.sh'];
  assert.ok(hu >= 600 && hu <= 1200, `harness-update pesa lo medido en el nocturno (~869 s): ${hu}`);

  // `caps` sin juego: el tope del nocturno. per_suite manda sobre el doble del peso.
  const dir = lab({ weights: { ...LAB_WEIGHTS, suite_cap: { factor: 2, floor: 90, per_suite: { 'a-slow.test.sh': 1000 } } } });
  const caps = run(['caps', '--only', onlyFile(dir, ['a-slow.test.sh', 'd-medium.test.sh', 'b-fast.test.js']),
    '--suites', path.join(dir, 'suites.json'), '--weights', path.join(dir, 'weights.json')]);
  assert.strictEqual(caps.code, 0, caps.err);
  assert.deepStrictEqual(caps.lines, ['a-slow.test.sh\t1000', 'b-fast.test.js\t90', 'd-medium.test.sh\t90'],
    'a-slow (100 s) lleva su tope propio; d-medium (40 s) y b-fast, el piso');
  // El juego de la 170 tiene su propia regla: no hereda el per_suite del nocturno.
  const both = lab({ weights: { ...LAB_WEIGHTS, suite_cap: { factor: 2, floor: 90, per_suite: { 'a-slow.test.sh': 1000 } },
    pr: { runs: [1], default: 2, suite_cap: { factor: 3, floor: 10 }, weights: {} } } });
  assert.deepStrictEqual(run(['caps', '--only', onlyFile(both, ['a-slow.test.sh']), '--weight-set', 'pr',
    '--suites', path.join(both, 'suites.json'), '--weights', path.join(both, 'weights.json')]).lines, ['a-slow.test.sh\t300']);
  for (const [perSuite, why] of [[[1000], 'una lista'], [{ 'a-slow.test.sh': 0 }, 'un tope de 0'], [{ 'a-slow.test.sh': 'mucho' }, 'un tope que no es número']]) {
    const broken = lab({ weights: { ...LAB_WEIGHTS, suite_cap: { factor: 2, floor: 90, per_suite: perSuite } } });
    refuses(run(['caps', '--suites', path.join(broken, 'suites.json'), '--weights', path.join(broken, 'weights.json')]), /per_suite/, why);
  }
  // un tope propio para una suite que no está en suites.json —un renombre, un error de tipeo— frena:
  // si no, la suite de verdad vuelve en silencio al doble de su peso. También con --only, aunque esa suite no esté en
  // la lista del trabajo.
  const stale = lab({ weights: { ...LAB_WEIGHTS, suite_cap: { factor: 2, floor: 90, per_suite: { 'a-slow-renombrada.test.sh': 1000 } } } });
  refuses(run(['caps', '--suites', path.join(stale, 'suites.json'), '--weights', path.join(stale, 'weights.json')]),
    /a-slow-renombrada\.test\.sh/, 'un tope propio de una suite que no existe');
  refuses(run(['caps', '--only', onlyFile(stale, ['b-fast.test.js']), '--suites', path.join(stale, 'suites.json'), '--weights', path.join(stale, 'weights.json')]),
    /a-slow-renombrada\.test\.sh/, 'con --only, igual');
});

test('SuitesWeights_PrSetHasTheConfirmedSuiteCap', () => {
  const pr = JSON.parse(fs.readFileSync(REAL_WEIGHTS, 'utf8')).pr;
  const { per_suite: own, ...rule } = pr.suite_cap;
  assert.deepStrictEqual(rule, { factor: 2, floor: 180 }, 'la regla que confirmó el dueño: el doble del peso, con piso de 3 min');
  // Los únicos topes propios de la validación: dos suites que corren solas y ahí tardan 1 y 3 s. Con el piso de 180 s
  // cada una, el trabajo del banco no entra en sus 40 min (pr-suites-shards, T48). Un tope propio más es una decisión
  // aparte, no un atajo para que una suite lenta deje de cortarse.
  assert.deepStrictEqual(own, { 'clean-machine.test.sh': 60, 'instinct-executor.test.sh': 60 });
  // Con pesos bajos (161 y 95 s), el tope cortaría sanas a harness-update y harness-doctor, que en el nocturno tardan
  // ~870 y ~275 s. Su tope tiene que pasar lo que tardan.
  assert.ok(pr.weights['harness-update.test.sh'] * pr.suite_cap.factor > 1373, `harness-update: ${pr.weights['harness-update.test.sh']}`);
  assert.ok(pr.weights['harness-doctor.test.sh'] * pr.suite_cap.factor > 416, `harness-doctor: ${pr.weights['harness-doctor.test.sh']}`);
});

// ── merge: juntar lo que dejó cada trabajo ───────────────────────────────────────────────────────────────────────
const MOTIVE = (i) => `no medida: el trabajo ${i} no terminó`;
const BROKEN = (i) => `no medida: lo que publicó el trabajo ${i} está incompleto`;

/** Lo que el trabajo `i` de `of` tenía que correr, por nombre. */
function expected(dir, i, of, extra = []) { return list(dir, i, of, extra).lines.map((l) => path.basename(l)); }

/**
 * Deja en `<dir>/artifacts/suites-shard-<i>-a<intento>/` lo que publica un trabajo: la lista de las que corrió, las
 * fallas, la salida de cada roja y, si terminó, la marca (cuántas corrió y cuántas fallas anotó). `ran` por defecto es
 * su lista entera. `mark` pisa el texto de la marca; `drop` borra archivos después de escribirlos (una bajada a medias).
 */
function artifact(dir, i, of, { ran, failures = [], red = {}, finished = true, attempt = 1, mark, drop = [], retries, only = [] } = {}) {
  const a = path.join(dir, 'artifacts', `suites-shard-${i}-a${attempt}`);
  fs.mkdirSync(path.join(a, 'red-output'), { recursive: true });
  const didRun = ran || expected(dir, i, of, only);
  // Las dos pasadas de cada roja (sólo el control de cada cambio reintenta): texto tal cual, o un objeto.
  if (retries !== undefined) fs.writeFileSync(path.join(a, 'retries.json'), typeof retries === 'string' ? retries : JSON.stringify(retries));
  fs.writeFileSync(path.join(a, 'ran.txt'), didRun.map((n) => `${n}\n`).join(''));
  fs.writeFileSync(path.join(a, 'failures.txt'), failures.map((n) => `${n}\n`).join(''));
  for (const [name, text] of Object.entries(red)) fs.writeFileSync(path.join(a, 'red-output', `${name}.txt`), text);
  if (finished) fs.writeFileSync(path.join(a, 'finished'), mark !== undefined ? mark : `${didRun.length} ${failures.length}\n`);
  for (const f of drop) fs.rmSync(path.join(a, f));
  return a;
}
function merge(dir, of, extra = []) {
  const out = path.join(dir, 'merged');
  const r = run(['merge', '--of', String(of), '--artifacts', path.join(dir, 'artifacts'), '--out', out,
    '--suites', path.join(dir, 'suites.json'), '--weights', path.join(dir, 'weights.json'), ...extra]);
  const read = (f) => (fs.existsSync(path.join(out, f)) ? fs.readFileSync(path.join(out, f), 'utf8').split('\n').filter(Boolean) : null);
  const retries = fs.existsSync(path.join(out, 'retries.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'retries.json'), 'utf8')) : null;
  return { ...r, dir: out, ran: read('ran.txt'), failures: read('failures.txt'), retries };
}

test('SuitesShard_Merge_AllShardsFinishedGreen_EverySuiteRanAndNothingFailed', () => {
  const dir = lab();
  for (const i of [1, 2, 3]) artifact(dir, i, 3);
  const m = merge(dir, 3);
  assert.strictEqual(m.code, 0, m.err);
  assert.deepStrictEqual([...m.ran].sort(), ALL);
  assert.deepStrictEqual(m.failures, []);
  assert.doesNotMatch(m.out, /task\.logissue/, 'una noche entera no levanta ningún aviso');
});

test('SuitesShard_Merge_RedAndAbsentSuites_KeepTheirNameAndTheirOutput', () => {
  const dir = lab();
  const two = expected(dir, 2, 2);
  artifact(dir, 1, 2);
  artifact(dir, 2, 2, {
    ran: two.filter((n) => n !== 'e-fast.test.js'),
    failures: ['d-medium.test.sh', 'e-fast.test.js(ausente)'],
    red: { 'd-medium.test.sh': 'MAL  — el chequeo 3\nFALLARON 1\n' },
  });
  const m = merge(dir, 2);
  assert.strictEqual(m.code, 0, m.err);
  assert.deepStrictEqual(m.failures, ['d-medium.test.sh', 'e-fast.test.js(ausente)']);
  assert.ok(!m.ran.includes('e-fast.test.js'), 'la ausente no corrió');
  assert.strictEqual(fs.readFileSync(path.join(m.dir, 'red-output', 'd-medium.test.sh.txt'), 'utf8'), 'MAL  — el chequeo 3\nFALLARON 1\n');
  assert.doesNotMatch(m.out, /task\.logissue type=error/, 'una roja no es un trabajo sin terminar');
});

test('SuitesShard_Merge_SuiteCutByItsCap_IsNotMeasuredWithItsMotive', () => {
  // El trabajo corta una suite que pasó su tope y la anota él mismo como no medida, con el motivo.
  // Eso no es una bajada a medias: el trabajo terminó y lo demás vale.
  const dir = lab();
  const two = expected(dir, 2, 2);
  const cut = two[0];
  artifact(dir, 1, 2);
  artifact(dir, 2, 2, { failures: [`${cut}(no-medida)`], red: { [`${cut}(no-medida)`]: 'NO se midió: pasó el tope de 200 s\n' } });
  const m = merge(dir, 2);
  assert.strictEqual(m.code, 0, m.err);
  assert.deepStrictEqual(m.failures, [`${cut}(no-medida)`], 'la cortada, una sola vez y con su marca');
  assert.ok(m.ran.includes(two[1]), 'lo demás del trabajo vale');
  assert.strictEqual(fs.readFileSync(path.join(m.dir, 'red-output', `${cut}(no-medida).txt`), 'utf8'), 'NO se midió: pasó el tope de 200 s\n',
    'el motivo es el del trabajo, no «no terminó»');
  assert.doesNotMatch(m.out, /task\.logissue type=error/, 'una suite cortada no es un trabajo sin terminar');

  // Sin el archivo del motivo, el de siempre.
  fs.rmSync(path.join(dir, 'artifacts'), { recursive: true, force: true });
  artifact(dir, 1, 2);
  artifact(dir, 2, 2, { failures: [`${cut}(no-medida)`] });
  const bare = merge(dir, 2);
  assert.deepStrictEqual(bare.failures, [`${cut}(no-medida)`]);
  assert.match(fs.readFileSync(path.join(bare.dir, 'red-output', `${cut}(no-medida).txt`), 'utf8'), /no medida/);

  // Una «no medida» que el trabajo no corrió, o que no era de su lista, no cuadra: no se le cree a nada del trabajo.
  for (const [name, ran, what] of [[cut, two.slice(1), 'que no figura entre las corridas'], [expected(dir, 1, 2)[0], two, 'ajena']]) {
    fs.rmSync(path.join(dir, 'artifacts'), { recursive: true, force: true });
    artifact(dir, 1, 2);
    artifact(dir, 2, 2, { ran, failures: [`${name}(no-medida)`] });
    const m2 = merge(dir, 2);
    assert.strictEqual(fs.readFileSync(path.join(m2.dir, 'red-output', `${two[1]}(no-medida).txt`), 'utf8').trim(), BROKEN(2), what);
  }
});

test('SuitesShard_Merge_ShardWithoutArtifact_ItsSuitesAreNotMeasuredNeverGreen', () => {
  const dir = lab();
  artifact(dir, 1, 2);
  const m = merge(dir, 2);   // el trabajo 2 no publicó nada
  assert.strictEqual(m.code, 0, 'juntó: el reporte sale, con las no medidas adentro');
  const two = expected(dir, 2, 2);
  assert.deepStrictEqual(m.failures, two.map((n) => `${n}(no-medida)`), 'cada suite del trabajo ausente cuenta como falla');
  assert.deepStrictEqual(m.ran, ['a-slow.test.sh'], 'y ninguna se da por corrida');
  for (const n of two) {
    assert.strictEqual(fs.readFileSync(path.join(m.dir, 'red-output', `${n}(no-medida).txt`), 'utf8').trim(), MOTIVE(2));
  }
  assert.match(m.out, /##vso\[task\.logissue type=error\].*trabajo 2 de 2/, 'y lo denuncia como error de la corrida');
});

test('SuitesShard_Merge_ShardCutHalfway_KeepsWhatItMeasuredAndTheRestIsNotMeasured', () => {
  // El trabajo 2 corrió b (verde) y c (roja), arrancó d y lo cortaron: sin marca de terminado.
  const dir = lab();
  artifact(dir, 1, 2);
  artifact(dir, 2, 2, {
    ran: ['b-fast.test.js', 'c-skill.test.js', 'd-medium.test.sh'],
    failures: ['c-skill.test.js'],
    red: { 'c-skill.test.js': 'not ok 1 - algo\n' },
    finished: false,
  });
  const m = merge(dir, 2);
  assert.strictEqual(m.code, 0, m.err);
  assert.deepStrictEqual(m.failures, ['c-skill.test.js', 'd-medium.test.sh(no-medida)', 'e-fast.test.js(no-medida)',
    'f-new-without-weight.test.js(no-medida)', 'g-weekly.test.sh(no-medida)'],
    'la roja sigue roja; la que estaba corriendo cuando se cortó y las que no llegaron a arrancar, no medidas');
  assert.ok(m.ran.includes('b-fast.test.js') && !m.failures.some((f) => f.startsWith('b-fast')), 'la que terminó verde antes del corte sigue verde');
  assert.match(m.out, /##vso\[task\.logissue type=error\].*trabajo 2 de 2/);
});

test('SuitesShard_Merge_ShardCutWithSeveralRunning_EveryUnfinishedOneIsNotMeasured', () => {
  // Las suites corren de a varias (xargs -P) y ran.txt se escribe al ARRANCAR cada una. Al cortar el trabajo, b y d
  // pueden estar corriendo a la vez: «la última de ran.txt» dejaría a b como verde sin haber terminado.
  // Con done.txt (cada suite que termina, de cualquier forma) se sabe cuáles no terminaron.
  const dir = lab();
  artifact(dir, 1, 2);
  const a = artifact(dir, 2, 2, {
    ran: ['b-fast.test.js', 'c-skill.test.js', 'd-medium.test.sh'],
    failures: ['c-skill.test.js'],
    red: { 'c-skill.test.js': 'not ok 1 - algo\n' },
    finished: false,
  });
  fs.writeFileSync(path.join(a, 'done.txt'), 'c-skill.test.js\n');
  const m = merge(dir, 2);
  assert.strictEqual(m.code, 0, m.err);
  assert.deepStrictEqual(m.failures, ['c-skill.test.js', 'b-fast.test.js(no-medida)', 'd-medium.test.sh(no-medida)', 'e-fast.test.js(no-medida)',
    'f-new-without-weight.test.js(no-medida)', 'g-weekly.test.sh(no-medida)'],
    'b y d arrancaron y no terminaron: las dos no medidas, no sólo la última');

  // Con done.txt y la marca de terminado, done.txt no cambia nada: el trabajo pasó por toda su lista.
  fs.rmSync(path.join(dir, 'artifacts'), { recursive: true, force: true });
  artifact(dir, 1, 2);
  const b = artifact(dir, 2, 2);
  fs.writeFileSync(path.join(b, 'done.txt'), expected(dir, 2, 2).map((n) => `${n}\n`).join(''));
  assert.deepStrictEqual(merge(dir, 2).failures, [], 'un trabajo terminado y verde sigue verde');
});

test('SuitesShard_Merge_ShardSaysFinishedButSkippedSuites_ThoseAreNotMeasured', () => {
  // La marca está, pero el trabajo no pasó por toda su lista: la marca no alcanza para darlas por verdes.
  const dir = lab();
  artifact(dir, 1, 2);
  artifact(dir, 2, 2, { ran: ['b-fast.test.js', 'c-skill.test.js'] });
  const m = merge(dir, 2);
  assert.strictEqual(m.code, 0, m.err);
  assert.deepStrictEqual(m.failures, ['d-medium.test.sh(no-medida)', 'e-fast.test.js(no-medida)',
    'f-new-without-weight.test.js(no-medida)', 'g-weekly.test.sh(no-medida)']);
  assert.ok(m.ran.includes('c-skill.test.js') && !m.failures.some((f) => f.startsWith('c-skill')), 'con la marca puesta, la última que corrió terminó');
  assert.match(m.out, /##vso\[task\.logissue type=error\]/);
});

// ── lo que publicó un trabajo no se cree sin mirar ─────────────────────────────────
/** Todas las suites del trabajo `i` quedaron no medidas, con el motivo «incompleto», y la corrida lo denuncia. */
function wholeShardUnmeasured(m, dir, i, of, what) {
  assert.strictEqual(m.code, 0, m.err);
  const its = expected(dir, i, of);
  for (const n of its) {
    assert.ok(m.failures.includes(`${n}(no-medida)`), `${what}: ${n} tenía que quedar no medida — ${m.failures}`);
    assert.ok(!m.ran.includes(n), `${what}: ${n} no puede figurar entre las corridas`);
    assert.strictEqual(fs.readFileSync(path.join(m.dir, 'red-output', `${n}(no-medida).txt`), 'utf8').trim(), BROKEN(i));
  }
  assert.strictEqual(m.failures.length, its.length, `${what}: sólo las de ese trabajo — ${m.failures}`);
  assert.match(m.out, new RegExp(`##vso\\[task\\.logissue type=error\\].*trabajo ${i} de ${of}`), `${what}: la corrida lo denuncia`);
}

test('SuitesShard_Merge_ArtifactWithoutItsFailuresFile_IsNotReadAsGreen', () => {
  // Una bajada a medias: la carpeta está, con su marca, pero falta la lista de fallas. «No hay archivo» no es «no hubo fallas».
  const dir = lab();
  artifact(dir, 1, 2);
  artifact(dir, 2, 2, { failures: ['d-medium.test.sh'], red: { 'd-medium.test.sh': 'MAL\n' }, drop: ['failures.txt'] });
  wholeShardUnmeasured(merge(dir, 2), dir, 2, 2, 'sin failures.txt');
});

test('SuitesShard_Merge_ArtifactWithoutItsRanFile_IsNotReadAsGreen', () => {
  const dir = lab();
  artifact(dir, 1, 2);
  artifact(dir, 2, 2, { drop: ['ran.txt'] });
  wholeShardUnmeasured(merge(dir, 2), dir, 2, 2, 'sin ran.txt');
  const cut = lab();
  artifact(cut, 1, 2);
  artifact(cut, 2, 2, { finished: false, drop: ['failures.txt'] });
  wholeShardUnmeasured(merge(cut, 2), cut, 2, 2, 'cortado y sin failures.txt');
});

test('SuitesShard_Merge_FinishedMarkThatDoesNotMatchWhatWasPublished_IsNotBelieved', () => {
  // La marca dice cuántas corrió y cuántas fallas anotó. Si lo publicado trae otra cuenta, algo se perdió en el camino.
  for (const [what, options] of [
    ['la marca dice 5 corridas y hay 6', { mark: '5 0\n' }],
    ['la marca dice 1 falla y no hay ninguna (la roja se perdió)', { mark: '6 1\n' }],
    ['la marca no trae la cuenta', { mark: 'listo\n' }],
    ['la marca está vacía', { mark: '' }],
  ]) {
    const dir = lab();
    artifact(dir, 1, 2);
    artifact(dir, 2, 2, options);
    wholeShardUnmeasured(merge(dir, 2), dir, 2, 2, what);
  }
});

test('SuitesShard_Merge_NamesThatWereNotInItsList_AreNotCounted', () => {
  // Un nombre que el trabajo no tenía en su lista no suma a las corridas: lo publicado no es de este reparto.
  const dir = lab();
  artifact(dir, 1, 2);
  artifact(dir, 2, 2, { ran: [...expected(dir, 2, 2), 'a-slow.test.sh', 'inventada.test.sh'] });
  const m = merge(dir, 2);
  wholeShardUnmeasured(m, dir, 2, 2, 'un nombre ajeno en ran.txt');
  assert.deepStrictEqual(m.ran, ['a-slow.test.sh'], 'sólo lo del trabajo 1, y una sola vez');
  const red = lab();
  artifact(red, 1, 2);
  artifact(red, 2, 2, { failures: ['e-fast.test.js', 'inventada.test.sh'] });
  wholeShardUnmeasured(merge(red, 2), red, 2, 2, 'una falla ajena en failures.txt');
  const never = lab();
  artifact(never, 1, 2);
  artifact(never, 2, 2, { ran: ['b-fast.test.js'], failures: ['c-skill.test.js'], finished: false });
  wholeShardUnmeasured(merge(never, 2), never, 2, 2, 'una roja que no figura entre las corridas');
});

// ── un trabajo reintentado desde Azure publica otro artefacto ──────────────────────
test('SuitesShard_Merge_RetriedShard_TakesItsLatestAttempt', () => {
  // El intento 1 se cortó; alguien lo reintentó y el intento 2 corrió todo: la noche queda entera.
  const dir = lab();
  artifact(dir, 1, 2);
  artifact(dir, 2, 2, { ran: ['b-fast.test.js'], finished: false, attempt: 1 });
  artifact(dir, 2, 2, { failures: ['d-medium.test.sh'], red: { 'd-medium.test.sh': 'MAL  — el del intento 2\n' }, attempt: 2 });
  const m = merge(dir, 2);
  assert.strictEqual(m.code, 0, m.err);
  assert.deepStrictEqual([...m.ran].sort(), ALL);
  assert.deepStrictEqual(m.failures, ['d-medium.test.sh'], 'vale lo del último intento, entero');
  assert.match(fs.readFileSync(path.join(m.dir, 'red-output', 'd-medium.test.sh.txt'), 'utf8'), /intento 2/);
  assert.doesNotMatch(m.out, /task\.logissue/, 'un reintento que terminó no deja ningún aviso');
  assert.match(m.out, /trabajo 2 de 2 \(intento 2\)/, 'y dice qué intento leyó');
});

test('SuitesShard_Merge_RetriedShard_TheLatestAttemptRulesEvenIfItIsWorse', () => {
  // El último intento es lo último que se supo de ese trabajo: no se elige el intento que conviene. Y es por número: 10 > 9.
  const dir = lab();
  artifact(dir, 1, 2);
  artifact(dir, 2, 2, { attempt: 9 });
  artifact(dir, 2, 2, { ran: ['b-fast.test.js', 'c-skill.test.js'], finished: false, attempt: 10 });
  const m = merge(dir, 2);
  assert.deepStrictEqual(m.failures, ['c-skill.test.js(no-medida)', 'd-medium.test.sh(no-medida)', 'e-fast.test.js(no-medida)',
    'f-new-without-weight.test.js(no-medida)', 'g-weekly.test.sh(no-medida)']);
  assert.match(m.out, /##vso\[task\.logissue type=error\].*trabajo 2 de 2 \(intento 10\)/);
});

test('SuitesShard_Merge_FoldersWithAnotherName_AreNotArtifactsOfAShard', () => {
  // Sólo cuenta `suites-shard-<i>-a<intento>`: una carpeta con otro nombre no es lo que publicó un trabajo.
  const dir = lab();
  artifact(dir, 1, 2);
  const real = artifact(dir, 2, 2);
  for (const name of ['suites-shard-2', 'suites-shard-2-a', 'suites-shard-2-a1x', 'suites-shard-02-a1', 'suites-shard-2-a1-copia']) {
    fs.cpSync(real, path.join(dir, 'artifacts', name), { recursive: true });
  }
  fs.rmSync(real, { recursive: true });
  const m = merge(dir, 2);
  assert.strictEqual(m.code, 0, m.err);
  assert.deepStrictEqual(m.failures, expected(dir, 2, 2).map((n) => `${n}(no-medida)`));
  assert.strictEqual(fs.readFileSync(path.join(m.dir, 'red-output', 'b-fast.test.js(no-medida).txt'), 'utf8').trim(), MOTIVE(2), 'no publicó: el motivo de siempre');
});

test('SuitesShard_Merge_NoArtifactsAtAll_EverySuiteIsNotMeasured', () => {
  const dir = lab();
  const m = merge(dir, 3);
  assert.strictEqual(m.code, 0, m.err);
  assert.deepStrictEqual(m.ran, []);
  assert.deepStrictEqual([...m.failures].sort(), ALL.map((n) => `${n}(no-medida)`));
  assert.strictEqual((m.out.match(/##vso\[task\.logissue type=error\]/g) || []).length, 3, 'un error por trabajo');
});

test('SuitesShard_Merge_EverySuiteEndsInTheReportOneWayOrAnother', () => {
  // La garantía entera: pase lo que pase con cada trabajo, ninguna suite de la lista queda sin nombrar.
  const scenarios = [
    (d) => { artifact(d, 1, 3); artifact(d, 2, 3); artifact(d, 3, 3); },
    (d) => { artifact(d, 1, 3); artifact(d, 3, 3, { finished: false }); },
    (d) => { artifact(d, 2, 3, { ran: [] , finished: false }); },
    () => {},
  ];
  for (const [k, prepare] of scenarios.entries()) {
    const dir = lab();
    prepare(dir);
    const m = merge(dir, 3);
    assert.strictEqual(m.code, 0, m.err);
    const named = new Set([...m.ran, ...m.failures.map((f) => f.replace(/\((ausente|no-medida)\)$/, ''))]);
    assert.deepStrictEqual([...named].sort(), ALL, `escenario ${k}: alguna suite no quedó ni corrida ni en la lista de fallas`);
  }
});

// ── las dos pasadas de cada roja (sólo el control de cada cambio reintenta) ───────────────────────────────────────
test('SuitesShard_Merge_Retries_AreJoinedFromEveryShard', () => {
  const dir = lab();
  const [one, two] = [expected(dir, 1, 2), expected(dir, 2, 2)];
  artifact(dir, 1, 2, { failures: [one[0]], retries: { [one[0]]: { primera: 'rojo', segunda: 'rojo' } } });
  artifact(dir, 2, 2, { retries: { [two[1]]: { primera: 'rojo', segunda: 'verde' } } });
  const m = merge(dir, 2);
  assert.strictEqual(m.code, 0, m.err);
  assert.deepStrictEqual(m.retries, { [one[0]]: { primera: 'rojo', segunda: 'rojo' }, [two[1]]: { primera: 'rojo', segunda: 'verde' } },
    'la firme y la intermitente, cada una de su trabajo, en un solo archivo');
  assert.deepStrictEqual(m.failures, [one[0]], 'la intermitente no es una falla: pasó en la 2ª');
});

test('SuitesShard_Merge_WithoutRetries_TheJoinedFileIsEmpty', () => {
  // El nocturno no reintenta y no publica el archivo: eso no es «lo publicado está incompleto».
  const dir = lab();
  artifact(dir, 1, 2);
  artifact(dir, 2, 2);
  const m = merge(dir, 2);
  assert.strictEqual(m.code, 0, m.err);
  assert.deepStrictEqual(m.retries, {});
  assert.doesNotMatch(m.out, /task\.logissue/);
});

test('SuitesShard_Merge_RetriesThatDoNotAddUp_TheWholeShardIsNotBelieved', () => {
  // Las dos pasadas tienen que cuadrar con lo publicado: una firme que no figura como falla, una intermitente que sí
  // figura, una suite que no corrió, una que no era de su lista o un archivo roto son una bajada a medias o un error.
  const dir = lab();
  const [one, two] = [expected(dir, 1, 2), expected(dir, 2, 2)];
  const bad = [
    ['{roto', 'no se deja leer'],
    [JSON.stringify([1, 2]), 'no es un objeto'],
    [{ [one[0]]: { primera: 'rojo', segunda: 'rojo' } }, 'firme sin falla'],
    [{ [two[0]]: { primera: 'rojo', segunda: 'verde' } }, 'ajena (del otro trabajo)'],
    [{ [one[0]]: { primera: 'rojo', segunda: 'quizás' } }, 'pasada sin sentido'],
  ];
  for (const [retries, what] of bad) {
    fs.rmSync(path.join(dir, 'artifacts'), { recursive: true, force: true });
    artifact(dir, 1, 2, { retries });
    artifact(dir, 2, 2);
    const m = merge(dir, 2);
    assert.strictEqual(m.code, 0, `${what}: ${m.err}`);
    for (const name of one) assert.ok(m.failures.includes(`${name}(no-medida)`), `${what}: ${name} no puede darse por medida — ${m.failures}`);
    assert.strictEqual(fs.readFileSync(path.join(m.dir, 'red-output', `${one[0]}(no-medida).txt`), 'utf8').trim(), BROKEN(1), what);
    assert.deepStrictEqual(m.retries, {}, `${what}: de un trabajo que no se cree no se toma nada`);
  }
  // Y la intermitente que figura como falla también se niega (verde en la 2ª y anotada roja: no cuadra).
  fs.rmSync(path.join(dir, 'artifacts'), { recursive: true, force: true });
  artifact(dir, 1, 2, { failures: [one[0]], retries: { [one[0]]: { primera: 'rojo', segunda: 'verde' } } });
  artifact(dir, 2, 2);
  assert.ok(merge(dir, 2).failures.includes(`${one[0]}(no-medida)`), 'intermitente anotada como falla');
});

test('SuitesShard_Merge_BadRequest_Exits2AndWritesNothing', () => {
  const dir = lab();
  artifact(dir, 1, 2);
  const out = path.join(dir, 'merged');
  const base = ['--suites', path.join(dir, 'suites.json'), '--weights', path.join(dir, 'weights.json')];
  const bad = run(['merge', '--of', '0', '--artifacts', path.join(dir, 'artifacts'), '--out', out, ...base]);
  refuses(bad, /--of/, 'merge con 0 trabajos');
  refuses(run(['merge', '--of', '2', '--out', out, ...base]), /--artifacts/, 'merge sin --artifacts');
  refuses(run(['merge', '--of', '2', '--artifacts', path.join(dir, 'artifacts'), ...base]), /--out/, 'merge sin --out');
  refuses(run(['merge', '--of', '2', '--artifacts', path.join(dir, 'artifacts'), '--out', out, '--suites', path.join(dir, 'no-existe.json'), '--weights', path.join(dir, 'weights.json')]),
    /suites\.json|no-existe\.json/, 'merge sin lista de suites');
  assert.ok(!fs.existsSync(path.join(out, 'ran.txt')) && !fs.existsSync(path.join(out, 'failures.txt')), 'un pedido negado no deja un resultado a medias');
});

// ── las suites que corren solas pasan al trabajo del banco (`--exclusive-apart`) ─────────────────
// En la validación de una rama, una suite `exclusive` corre SOLA al final de un trabajo de suites, y el trabajo del
// banco termina antes y deja su carril ocioso. Con `--exclusive-apart` las exclusivas salen del reparto y forman la
// lista del trabajo del banco
// (`--shard bench`). El nocturno no pasa la opción: para él no cambia nada.
const APART = ['--exclusive-apart'];
const EXCL_SUITES = {
  diarias: LAB_SUITES.diarias.map((s) => (/a-slow|e-fast/.test(s.ruta) ? { ...s, exclusive: true } : s)),
  semanales: LAB_SUITES.semanales,
};
const EXCL = ['a-slow.test.sh', 'e-fast.test.js'];
const names = (r) => r.lines.map((l) => path.basename(l));

test('T47 SuitesShard_ExclusiveSuitesGoToTheBenchJob — las que corren solas salen del reparto y forman la lista del trabajo del banco', () => {
  const dir = lab({ suites: EXCL_SUITES });
  for (const of of [1, 2, 3]) {
    const seen = [];
    for (let i = 1; i <= of; i += 1) {
      const r = list(dir, i, of, APART);
      assert.strictEqual(r.code, 0, `trabajo ${i} de ${of}: ${r.err}`);
      for (const n of names(r)) { assert.ok(!EXCL.includes(n), `${n} corre sola: no va en un trabajo de suites`); seen.push(n); }
    }
    const bench = list(dir, 'bench', of, APART);
    assert.strictEqual(bench.code, 0, bench.err);
    assert.deepStrictEqual(names(bench), EXCL, 'la lista del trabajo del banco: las exclusivas, en el orden de suites.json');
    assert.deepStrictEqual([...seen, ...names(bench)].sort(), [...ALL].sort(), `con ${of} trabajo(s): entre todos corren la lista entera, y ninguna dos veces`);
  }
  // el reparto de las que quedan es el de siempre, sobre ellas: por peso (40 · 30 · 20 · 3 · 3), sin contar las que salieron
  const two = [1, 2].map((i) => names(list(dir, i, 2, APART)));
  assert.deepStrictEqual(two, [['b-fast.test.js', 'd-medium.test.sh', 'f-new-without-weight.test.js'], ['c-skill.test.js', 'g-weekly.test.sh']],
    'd-medium (40) con las dos livianas; g-weekly (30) con c-skill (20): 46 y 50 s');
  // sin la opción, nada cambió: la exclusiva más pesada sigue cayendo en un trabajo de suites (el nocturno)
  assert.ok([1, 2].some((i) => names(list(dir, i, 2)).includes('a-slow.test.sh')), 'sin --exclusive-apart, a-slow va en un trabajo, como siempre');
  refuses(list(dir, 'bench', 2), /--shard/, '«bench» sin --exclusive-apart no es un trabajo');
});

test('T47 SuitesShard_ExclusiveApart_JobsCountsTheWeightOfTheRest — cuántos trabajos sale del peso de las que quedan', () => {
  const dir = lab({ suites: EXCL_SUITES });
  const jobs = (extra) => run(['jobs', '--max', '3', '--budget', '60', '--suites', path.join(dir, 'suites.json'), '--weights', path.join(dir, 'weights.json'), ...extra]);
  // todo el plan: 100 + 40 + 30 + 20 + 3·3 = 199 s → 4, con tope 3. Sin a-slow (100) ni e-fast (3): 96 s → 2.
  assert.strictEqual(jobs([]).out.trim(), '3', 'sin la opción cuenta todo');
  const apart = jobs(APART);
  assert.strictEqual(apart.code, 0, apart.err);
  assert.strictEqual(apart.out.trim(), '2', 'con la opción cuenta sólo las que corren en los trabajos de suites');
  assert.match(apart.err, /2 suite\(s\) que corren solas van al trabajo del banco/, 'y lo dice');
  const plan = run(['plan', '--of', '2', '--suites', path.join(dir, 'suites.json'), '--weights', path.join(dir, 'weights.json'), ...APART]);
  assert.strictEqual(plan.code, 0, plan.err);
  assert.match(plan.out, /trabajo del banco: 2 suite\(s\) que corren solas · ~103 s/, plan.out);
});

test('T47 SuitesShard_ExclusiveApart_NoExclusiveSuites_SamePartitionAsBefore — sin exclusivas el reparto y la matriz son los de antes', () => {
  const dir = lab();
  for (const of of [1, 2, 3]) {
    for (let i = 1; i <= of; i += 1) assert.deepStrictEqual(list(dir, i, of, APART).lines, list(dir, i, of).lines, `trabajo ${i} de ${of}`);
  }
  const base = ['--max', '3', '--budget', '60', '--suites', path.join(dir, 'suites.json'), '--weights', path.join(dir, 'weights.json')];
  assert.strictEqual(run(['jobs', ...base, ...APART]).out, run(['jobs', ...base]).out, 'el mismo número de trabajos');
  // el trabajo del banco no tiene suites: lo dice con su propio código (3), sin lista — ni error ni «lista vacía»
  const bench = list(dir, 'bench', 2, APART);
  assert.strictEqual(bench.code, 3, `sale 3: no le toca ninguna (salió ${bench.code}) ${bench.err}`);
  assert.strictEqual(bench.out, '', 'sin lista');
  assert.match(bench.err, /ninguna suite corre sola en este plan/);
});

test('T47 SuitesShard_ExclusiveApart_EverythingIsExclusive_OneEmptySuitesJob — si todo corre solo, un trabajo de suites vacío y el del banco con todo', () => {
  const dir = lab({ suites: EXCL_SUITES });
  const only = path.join(dir, 'only.txt');
  fs.writeFileSync(only, `${EXCL.join('\n')}\n`);
  const base = ['--suites', path.join(dir, 'suites.json'), '--weights', path.join(dir, 'weights.json'), '--only', only, ...APART];
  const jobs = run(['jobs', '--max', '3', '--budget', '60', ...base]);
  assert.strictEqual(jobs.code, 0, jobs.err);
  assert.strictEqual(jobs.out.trim(), '1', 'un trabajo de suites igual: la matriz no puede quedar sin patas');
  const one = list(dir, 1, 1, ['--only', only, ...APART]);
  assert.strictEqual(one.code, 3, `el trabajo de suites no tiene nada que correr: sale 3 (salió ${one.code}) ${one.err}`);
  assert.strictEqual(one.out, '');
  assert.match(one.err, /todas las suites de este plan corren solas/);
  assert.deepStrictEqual(names(list(dir, 'bench', 1, ['--only', only, ...APART])), EXCL);
  refuses(list(dir, 1, 2, ['--only', only, ...APART]), /--of 2 pasa la cantidad/, 'dos trabajos de suites para ninguna suite');
});

test('T47 SuitesShard_ExclusiveApart_MergeJoinsTheBenchJob — el veredicto junta lo del trabajo del banco, y si falta son no medidas', () => {
  const dir = lab({ suites: EXCL_SUITES });
  const bench = (extra = {}) => {
    const a = path.join(dir, 'artifacts', `suites-shard-bench-a${extra.attempt || 1}`);
    fs.mkdirSync(path.join(a, 'red-output'), { recursive: true });
    const ran = extra.ran || EXCL; const failures = extra.failures || [];
    fs.writeFileSync(path.join(a, 'ran.txt'), ran.map((n) => `${n}\n`).join(''));
    fs.writeFileSync(path.join(a, 'failures.txt'), failures.map((n) => `${n}\n`).join(''));
    for (const n of failures) fs.writeFileSync(path.join(a, 'red-output', `${n}.txt`), 'salió roja\n');
    if (extra.finished !== false) fs.writeFileSync(path.join(a, 'finished'), `${ran.length} ${failures.length}\n`);
  };
  const shards = () => { for (const i of [1, 2]) artifact(dir, i, 2, { only: APART }); };
  // todo publicado y verde
  shards(); bench();
  let m = merge(dir, 2, APART);
  assert.strictEqual(m.code, 0, m.err);
  assert.deepStrictEqual([...m.ran].sort(), [...ALL].sort(), 'corrieron todas: las de los trabajos de suites y las del banco');
  assert.deepStrictEqual(m.failures, []);
  assert.match(m.out, /trabajo del banco: terminó · 2 corrida\(s\)/);
  // una exclusiva roja en el trabajo del banco conserva su nombre y su salida
  fs.rmSync(path.join(dir, 'artifacts'), { recursive: true, force: true });
  shards(); bench({ failures: ['a-slow.test.sh'] });
  m = merge(dir, 2, APART);
  assert.deepStrictEqual(m.failures, ['a-slow.test.sh']);
  assert.ok(fs.existsSync(path.join(m.dir, 'red-output', 'a-slow.test.sh.txt')));
  // el trabajo del banco no publicó sus suites: no medidas, con su motivo, y se denuncia — nunca verdes ni «no corrieron»
  fs.rmSync(path.join(dir, 'artifacts'), { recursive: true, force: true });
  shards();
  m = merge(dir, 2, APART);
  assert.strictEqual(m.code, 0, m.err);
  assert.deepStrictEqual([...m.failures].sort(), EXCL.map((n) => `${n}(no-medida)`).sort(), 'sin lo del banco, sus exclusivas son no medidas');
  assert.strictEqual(fs.readFileSync(path.join(m.dir, 'red-output', 'a-slow.test.sh(no-medida).txt'), 'utf8').trim(), 'no medida: el trabajo del banco no terminó');
  assert.match(m.out, /##vso\[task\.logissue type=error\]El trabajo del banco de las suites no terminó: no publicó lo que midió/);
  // cortado a mitad de camino: lo que midió vale, lo demás no se midió
  fs.rmSync(path.join(dir, 'artifacts'), { recursive: true, force: true });
  shards(); bench({ ran: ['a-slow.test.sh'], finished: false });
  m = merge(dir, 2, APART);
  assert.ok(m.failures.includes('e-fast.test.js(no-medida)'), `la que no llegó a correr: ${m.failures}`);
  // el intento más alto del trabajo del banco es el que vale
  fs.rmSync(path.join(dir, 'artifacts'), { recursive: true, force: true });
  shards(); bench({ failures: ['a-slow.test.sh'] }); bench({ attempt: 2 });
  assert.deepStrictEqual(merge(dir, 2, APART).failures, [], 'el segundo intento, verde, pisa al primero');
  // sin exclusivas en el plan, el veredicto no espera nada del banco
  const plain = lab();
  for (const i of [1, 2]) artifact(plain, i, 2);
  m = merge(plain, 2, APART);
  assert.deepStrictEqual(m.failures, [], 'un plan sin exclusivas no pide lo del banco');
  assert.doesNotMatch(m.out, /trabajo del banco/);
});

test('T47 SuitesShard_ExclusiveApart_RealList_ExportRealRunsInTheBenchJob — con la lista de verdad, export-real deja los trabajos de suites', () => {
  const real = ['--suites', REAL_SUITES, '--weights', REAL_WEIGHTS, '--weight-set', 'pr', '--skills', '/S', '--scripts', '/R'];
  const bench = names(run(['list', '--shard', 'bench', '--of', '2', ...real, ...APART]));
  const config = JSON.parse(fs.readFileSync(REAL_SUITES, 'utf8'));
  // export-real es del interno: la copia pública no la trae en su suites.json (la saca el exportador). Ahí se mide el
  // resto (la lista del banco son las exclusive de la lista), no su presencia.
  const exportRealListed = [...config.diarias, ...(config.semanales || [])].some((s) => path.posix.basename(s.ruta) === 'export-real.test.sh');
  if (exportRealListed) assert.ok(bench.includes('export-real.test.sh'), `export-real corre en el trabajo del banco: ${bench}`);
  const exclusive = [...config.diarias, ...(config.semanales || [])].filter((s) => s.exclusive).map((s) => path.posix.basename(s.ruta));
  assert.deepStrictEqual([...bench].sort(), [...exclusive].sort(), 'la lista del banco son exactamente las exclusive de suites.json');
  for (const i of [1, 2]) {
    const mine = names(run(['list', '--shard', String(i), '--of', '2', ...real, ...APART]));
    assert.ok(mine.length > 50 && !mine.some((n) => exclusive.includes(n)), `el trabajo ${i} no lleva ninguna exclusiva`);
  }
});
