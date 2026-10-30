'use strict';

/**
 * estimates.test.js — el registro de estimaciones de un repo de historias (scripts/lib/estimates.js): la épica con un
 * rango, el plan con un valor por historia, la historia que lo ajusta, y el informe que compara la suma con el rango.
 *
 * Lo que no se puede perder: el registro sólo se agrega, nunca se reescribe (las versiones son el dato); cada línea trae
 * las quince claves en el mismo orden, que es el contrato que leen el sitio y la plataforma; una línea ilegible se cuenta
 * y no tira el resto; una entrada inválida sale 2 sin escribir nada; con unidades mezcladas todo pasa a horas, y si no se
 * puede (puntos sin tasa) no se marca la épica dentro ni fuera. Lo real va siempre en horas, un reintento del cierre no
 * lo duplica, y el informe dice el error de cada nivel contra lo real. Todo en laboratorios (organización acme, persona
 * acme-lider); la configuración de git de la máquina no entra (HOME y GIT_CONFIG_GLOBAL de laboratorio).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'scripts', 'lib', 'estimates.js');
const CLAVES = ['v', 'nivel', 'epica', 'historia', 'valor', 'min', 'max', 'unidad', 'supuestos', 'propuesto', 'base', 'quien', 'confirmo', 'ejecucion', 'cuando'];
const REGISTRO = path.join('.tycon', 'estimates.jsonl');

/** Un repo de historias de laboratorio: `specs/` con cinco historias de una épica, una de otra y una sin `epic:`. */
function repoDeHistorias() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'estimates-'));
  const specs = path.join(d, 'specs');
  fs.mkdirSync(specs);
  const historia = (id, epic, status = 'done') => fs.writeFileSync(path.join(specs, `story-${id}-algo.md`),
    `---\n${epic ? `epic: ${epic}\n` : ''}story: "${id}"\ntitle: "La historia ${id}"\nstatus: ${status}\n---\n\n# Story ${id}\n`);
  for (const id of ['3.1', '3.2', '3.3', '3.4']) historia(id, 3);
  historia('3.5', 3, 'ready-for-dev');
  historia('4.1', 4, 'review');
  historia('5.1', null);
  return d;
}

/** Un `team-repos.json` de laboratorio (acme), con `estimates` si se pasa. */
function org(estimates) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'estimates-org-'));
  const doc = {
    version: 1,
    public: { platform: 'github', org: 'acme', repo: 'harness' },
    profile: { platform: 'github', org: 'acme', repo: 'harness-profile' },
    operations: { platform: 'github', org: 'acme', repo: 'harness-ops' },
    ...(estimates !== undefined ? { estimates } : {}),
  };
  const file = path.join(d, 'team-repos.json');
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  return file;
}
const SIN_CLAVE = org();

/** Corre el comando con un ambiente de laboratorio; `--org-config` sin la clave salvo que el caso pase otro. */
function correr(args, { orgConfig = SIN_CLAVE, env = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'estimates-home-'));
  const r = spawnSync(process.execPath, [CLI, ...args, '--org-config', orgConfig, '--json'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', ...env },
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { /* no es JSON */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
/** `real` en el mismo proceso, como lo llama `pipeline.js estimate-real`: por la línea de comandos se niega. */
function realEnProceso(args, { orgConfig = SIN_CLAVE } = {}) {
  const E = require(CLI);
  try { return { status: 0, json: E.run(['real', ...args, '--org-config', orgConfig]) }; } catch (e) {
    if (typeof e.code !== 'number') throw e;
    return { status: e.code, json: { ok: false, reason: e.message } };
  }
}
function lineas(repo) {
  const f = path.join(repo, REGISTRO);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
function escribirRegistro(repo, filas) {
  fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(repo, REGISTRO), filas.map((f) => (typeof f === 'string' ? f : JSON.stringify(f))).join('\n') + '\n');
}
/** Una línea completa de laboratorio con las quince claves. */
function fila(campos) {
  const base = Object.fromEntries(CLAVES.map((k) => [k, null]));
  return { ...base, v: 1, unidad: 'hours', quien: 'acme-lider', cuando: '2026-10-22T10:00:00.000Z', ...campos };
}

test('T1 Epic_CreaRegistroYGitattributes @story-2.75 @ac-1', () => {
  const repo = repoDeHistorias();
  const args = ['epic', '--repo', repo, '--epic', '3', '--min', '40', '--max', '70', '--assumptions', 'sin migración de datos', '--who', 'acme-lider'];
  const r = correr(args);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  const [l] = lineas(repo);
  assert.deepStrictEqual(Object.keys(l), CLAVES, 'las quince claves, en orden');
  assert.deepStrictEqual(
    [l.v, l.nivel, l.epica, l.historia, l.valor, l.min, l.max, l.unidad, l.supuestos, l.propuesto, l.base, l.quien, l.confirmo, l.ejecucion],
    [1, 'epica', '3', null, null, 40, 70, 'hours', 'sin migración de datos', null, null, 'acme-lider', null, null]);
  assert.ok(!Number.isNaN(Date.parse(l.cuando)), 'cuando es una fecha ISO');
  assert.ok(r.json && r.json.ok, 'el JSON dice ok');
  // se repite: una línea más, y el atributo sigue una sola vez
  assert.strictEqual(correr(args).status, 0);
  assert.strictEqual(lineas(repo).length, 2);
  const attrs = fs.readFileSync(path.join(repo, '.gitattributes'), 'utf8').split('\n').filter((x) => x.trim() === '.tycon/estimates.jsonl merge=union');
  assert.strictEqual(attrs.length, 1, '.gitattributes con la línea una sola vez');
  // un .gitattributes ajeno sin salto final no se rompe
  const otro = repoDeHistorias();
  fs.writeFileSync(path.join(otro, '.gitattributes'), '*.sh text eol=lf');
  assert.strictEqual(correr(['epic', '--repo', otro, '--epic', '3', '--min', '1', '--max', '2', '--who', 'acme-lider']).status, 0);
  assert.deepStrictEqual(fs.readFileSync(path.join(otro, '.gitattributes'), 'utf8').split('\n').filter(Boolean),
    ['*.sh text eol=lf', '.tycon/estimates.jsonl merge=union']);
  // quién: sin --who, user.name de git del repo; sin ninguno, null (no frena)
  const conGit = repoDeHistorias();
  spawnSync('git', ['init', '-q', conGit]);
  spawnSync('git', ['-C', conGit, 'config', 'user.name', 'acme-dev']);
  assert.strictEqual(correr(['epic', '--repo', conGit, '--epic', '3', '--min', '1', '--max', '2']).status, 0);
  const sinGit = repoDeHistorias();
  assert.strictEqual(correr(['epic', '--repo', sinGit, '--epic', '3', '--min', '1', '--max', '2']).status, 0, 'sin persona no frena');
  assert.strictEqual(lineas(conGit)[0].quien, 'acme-dev');
  assert.strictEqual(lineas(sinGit)[0].quien, null);
});

test('T2 PlanEHistoria_SoloAgrega @story-2.75 @ac-2', () => {
  const repo = repoDeHistorias();
  assert.strictEqual(correr(['epic', '--repo', repo, '--epic', '3', '--min', '40', '--max', '70', '--who', 'acme-lider']).status, 0);
  const antes = fs.readFileSync(path.join(repo, REGISTRO), 'utf8');
  assert.strictEqual(correr(['plan', '--repo', repo, '--story', '3.2', '--value', '12', '--who', 'acme-lider']).status, 0);
  assert.strictEqual(correr(['story', '--repo', repo, '--story', '3.2', '--value', '16', '--who', 'acme-lider']).status, 0);
  const despues = fs.readFileSync(path.join(repo, REGISTRO), 'utf8');
  assert.ok(despues.startsWith(antes), 'la línea anterior, byte a byte igual');
  const [, plan, hist] = lineas(repo);
  assert.deepStrictEqual([plan.nivel, plan.epica, plan.historia, plan.valor], ['plan', '3', '3.2', 12]);
  assert.deepStrictEqual([hist.nivel, hist.epica, hist.historia, hist.valor], ['historia', '3', '3.2', 16]);
  assert.deepStrictEqual(Object.keys(plan), CLAVES);
});

test('T3 Vigente_EsLaUltima @story-2.75 @ac-3', () => {
  const E = require(CLI);
  const filas = [
    fila({ nivel: 'plan', epica: '3', historia: '3.2', valor: 12 }),
    fila({ nivel: 'historia', epica: '3', historia: '3.2', valor: 14 }),
    fila({ nivel: 'historia', epica: '3', historia: '3.3', valor: 9 }),
    fila({ nivel: 'historia', epica: '3', historia: '3.2', valor: 16 }),
  ];
  assert.strictEqual(E.current(filas, { nivel: 'historia', historia: '3.2' }).valor, 16);
  assert.deepStrictEqual(E.history(filas, { nivel: 'historia', historia: '3.2' }).map((f) => f.valor), [14, 16]);
  assert.strictEqual(E.current(filas, { nivel: 'historia', historia: '9.9' }), null);
  const epicas = [fila({ nivel: 'epica', epica: '3', min: 10, max: 20 }), fila({ nivel: 'epica', epica: '3', min: 30, max: 50 })];
  assert.strictEqual(E.current(epicas, { nivel: 'epica', epica: '3' }).min, 30, 'la épica vigente, también la última');
});

test('T4 Report_EpicaContraRango @story-2.75 @ac-4', () => {
  const repo = repoDeHistorias();
  escribirRegistro(repo, [
    fila({ nivel: 'epica', epica: '3', min: 40, max: 70, supuestos: 'sin migración' }),
    fila({ nivel: 'plan', epica: '3', historia: '3.1', valor: 12 }),
    fila({ nivel: 'plan', epica: '3', historia: '3.2', valor: 20 }),
    fila({ nivel: 'plan', epica: '3', historia: '3.3', valor: 30 }),
    fila({ nivel: 'historia', epica: '3', historia: '3.1', valor: 45 }),
    fila({ nivel: 'plan', epica: '4', historia: '4.1', valor: 99 }),
  ]);
  const r = correr(['report', '--repo', repo, '--epic', '3']);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  const j = r.json;
  assert.deepStrictEqual([j.ok, j.epica, j.rango.min, j.rango.max, j.unidad], [true, '3', 40, 70, 'hours']);
  assert.deepStrictEqual([j.suma_plan, j.suma_vigente, j.dentro, j.fuera, j.por], [62, 95, false, 'encima', 25]);
  assert.deepStrictEqual(j.historias.map((h) => [h.historia, h.vigente.valor, h.vigente.nivel, h.versiones.length]),
    [['3.1', 45, 'historia', 2], ['3.2', 20, 'plan', 1], ['3.3', 30, 'plan', 1]]);
  // dentro y debajo
  escribirRegistro(repo, [fila({ nivel: 'epica', epica: '3', min: 40, max: 70 }), fila({ nivel: 'plan', epica: '3', historia: '3.1', valor: 50 })]);
  assert.deepStrictEqual((({ dentro, fuera, por }) => [dentro, fuera, por])(correr(['report', '--repo', repo, '--epic', '3']).json), [true, null, 0]);
  escribirRegistro(repo, [fila({ nivel: 'epica', epica: '3', min: 40, max: 70 }), fila({ nivel: 'plan', epica: '3', historia: '3.1', valor: 10 })]);
  assert.deepStrictEqual((({ dentro, fuera, por }) => [dentro, fuera, por])(correr(['report', '--repo', repo, '--epic', '3']).json), [false, 'debajo', 30]);
});

test('T5 Unidad_DeLaOrganizacion @story-2.75 @ac-5', () => {
  const repo = repoDeHistorias();
  const enDias = org({ unit: 'days', hours_per_day: 6 });
  assert.strictEqual(correr(['epic', '--repo', repo, '--epic', '3', '--min', '5', '--max', '8', '--who', 'acme-lider'], { orgConfig: enDias }).status, 0);
  assert.strictEqual(correr(['plan', '--repo', repo, '--story', '3.1', '--value', '2', '--who', 'acme-lider'], { orgConfig: enDias }).status, 0);
  assert.strictEqual(correr(['plan', '--repo', repo, '--story', '3.2', '--value', '3', '--who', 'acme-lider']).status, 0);
  assert.deepStrictEqual(lineas(repo).map((l) => l.unidad), ['days', 'days', 'hours'], 'cada línea guarda su unidad; sin la clave, hours');
  // una clave mal escrita: se dice y no se escribe (no se adivina la unidad)
  const mal = org({ unit: 'weeks' });
  const r = correr(['plan', '--repo', repo, '--story', '3.3', '--value', '3', '--who', 'acme-lider'], { orgConfig: mal });
  assert.strictEqual(r.status, 3, r.stdout);
  assert.match(r.json.reason, /estimates\.unit/);
  assert.strictEqual(lineas(repo).length, 3, 'no escribió');
  // el lector del árbol acepta la clave (si no, el archivo entero se descartaba)
  const TR = require(path.join(ROOT, 'scripts', 'lib', 'team-repos.js'));
  const ok = TR.parse(fs.readFileSync(enDias, 'utf8'));
  assert.ok(ok.ok && !ok.sectionProblems, JSON.stringify(ok.problems));
  assert.deepStrictEqual(ok.data.estimates, { unit: 'days', hours_per_day: 6 });
});

test('T6 Entradas_Invalidas_Sale2 @story-2.75 @ac-6', () => {
  const repo = repoDeHistorias();
  assert.strictEqual(correr(['epic', '--repo', repo, '--epic', '3', '--min', '40', '--max', '70', '--who', 'acme-lider']).status, 0);
  const antes = fs.readFileSync(path.join(repo, REGISTRO), 'utf8');
  const casos = [
    [['plan', '--repo', repo, '--story', '3.2', '--value', '-3'], /--value/],
    [['plan', '--repo', repo, '--story', '3.2', '--value', '0'], /--value/],
    [['story', '--repo', repo, '--story', '3.2', '--value', 'doce'], /--value/],
    [['epic', '--repo', repo, '--epic', '3', '--min', '70', '--max', '40'], /--min/],
    [['plan', '--repo', repo, '--story', '9.9', '--value', '5'], /9\.9/],
    [['plan', '--repo', repo, '--story', '5.1', '--value', '5'], /epic/],
    [['sprint', '--repo', repo, '--story', '3.2', '--value', '5'], /sprint/],
  ];
  for (const [args, motivo] of casos) {
    const r = correr([...args, '--who', 'acme-lider']);
    assert.strictEqual(r.status, 2, `${args[0]} ${args.slice(-1)}: ${r.stdout}`);
    assert.strictEqual(r.json.ok, false);
    assert.match(r.json.reason, motivo);
  }
  assert.strictEqual(fs.readFileSync(path.join(repo, REGISTRO), 'utf8'), antes, 'el archivo no cambió');
});

test('T7 Registro_LineaIlegible @story-2.75 @ac-7', () => {
  const repo = repoDeHistorias();
  escribirRegistro(repo, [
    fila({ nivel: 'epica', epica: '3', min: 40, max: 70 }),
    '{"v":1,"nivel":',
    fila({ nivel: 'plan', epica: '3', historia: '3.1', valor: 12 }),
    fila({ v: 9, nivel: 'plan', epica: '3', historia: '3.2', valor: 99 }),
    fila({ nivel: 'plan', epica: '3', historia: '3.3', valor: 8 }),
  ]);
  const antes = fs.readFileSync(path.join(repo, REGISTRO), 'utf8');
  const E = require(CLI);
  const leido = E.read(repo);
  assert.deepStrictEqual(leido.unreadable, [2, 4]);
  assert.strictEqual(leido.lines.length, 3);
  const r = correr(['report', '--repo', repo, '--epic', '3']);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual([r.json.unreadable, r.json.suma_plan], [[2, 4], 20], 'el informe lo dice y lee el resto');
  // escribir con líneas ilegibles agrega, no reescribe
  assert.strictEqual(correr(['plan', '--repo', repo, '--story', '3.4', '--value', '3', '--who', 'acme-lider']).status, 0);
  assert.ok(fs.readFileSync(path.join(repo, REGISTRO), 'utf8').startsWith(antes));
});

test('T8 Linea_ClavesFijas @story-2.75 @ac-8', () => {
  const E = require(CLI);
  assert.deepStrictEqual(E.CLAVES, CLAVES);
  const epica = E.linea({ nivel: 'epica', epica: '3', min: 1, max: 2, unidad: 'hours', quien: 'acme-lider', cuando: 'x' });
  const plan = E.linea({ nivel: 'plan', epica: '3', historia: '3.1', valor: 4, unidad: 'days', cuando: 'x' });
  const historia = E.linea({ historia: '3.1', nivel: 'historia', epica: '3', valor: 5, propuesto: 4, base: ['3.2'], confirmo: 'acme-lider', unidad: 'points', cuando: 'x' });
  const real = E.linea({ nivel: 'real', epica: '3', historia: '3.1', valor: 6.5, unidad: 'hours', ejecucion: 'r1', cuando: 'x' });
  for (const l of [epica, plan, historia, real]) {
    assert.deepStrictEqual(Object.keys(l), CLAVES, l.nivel);
    assert.strictEqual(l.v, 1);
  }
  assert.deepStrictEqual([plan.min, plan.max, plan.supuestos, plan.propuesto, plan.base, plan.quien, plan.ejecucion], [null, null, null, null, null, null, null]);
  assert.deepStrictEqual([epica.historia, epica.valor], [null, null]);
  // la línea serializada sale con las claves en ese orden
  assert.strictEqual(JSON.stringify(historia).indexOf('"historia"') < JSON.stringify(historia).indexOf('"valor"'), true);
});

test('T9 SinShell_Y_SinHerramientas @story-2.75 @ac-33', () => {
  for (const archivo of [CLI, path.join(ROOT, 'scripts', 'lib', 'similar-stories.js')]) {
    const codigo = fs.readFileSync(archivo, 'utf8');
    assert.doesNotMatch(codigo, /execSync|shell\s*:\s*true/, archivo);
    assert.doesNotMatch(codigo, /azure|github|clockify/i, archivo);
  }
});

test('T15 Confirmacion_GuardaPropuestoYValor @story-2.75 @ac-12', () => {
  const repo = repoDeHistorias();
  const r = correr(['story', '--repo', repo, '--story', '3.5', '--proposed', '14', '--value', '16', '--base', '3.1,2.4', '--confirmed-by', 'acme-lider', '--who', 'acme-lider']);
  assert.strictEqual(r.status, 0, r.stdout);
  const [l] = lineas(repo);
  assert.deepStrictEqual([l.nivel, l.historia, l.propuesto, l.valor, l.base, l.confirmo], ['historia', '3.5', 14, 16, ['3.1', '2.4'], 'acme-lider']);
  assert.deepStrictEqual(Object.keys(l), CLAVES);
});

test('T37 Report_UnidadesMezcladas @story-2.75 @ac-34', () => {
  const repo = repoDeHistorias();
  escribirRegistro(repo, [
    fila({ nivel: 'epica', epica: '3', min: 30, max: 40, unidad: 'hours' }),
    fila({ nivel: 'historia', epica: '3', historia: '3.1', valor: 2, unidad: 'days' }),
    fila({ nivel: 'historia', epica: '3', historia: '3.2', valor: 5, unidad: 'points' }),
  ]);
  const conTasa = correr(['report', '--repo', repo, '--epic', '3'], { orgConfig: org({ unit: 'hours', hours_per_day: 6, hours_per_point: 4 }) });
  assert.strictEqual(conTasa.status, 0, conTasa.stdout);
  assert.deepStrictEqual([conTasa.json.unidad, conTasa.json.suma_vigente, conTasa.json.dentro, conTasa.json.fuera], ['hours', 32, true, null], '2 días × 6 + 5 puntos × 4');
  const sinTasa = correr(['report', '--repo', repo, '--epic', '3'], { orgConfig: org({ unit: 'hours', hours_per_day: 6 }) });
  assert.strictEqual(sinTasa.status, 0, sinTasa.stdout);
  const j = sinTasa.json;
  assert.deepStrictEqual([j.suma_vigente, j.dentro, j.fuera, j.por], [null, null, null, null], 'sin marca de rango');
  assert.deepStrictEqual(j.sumas_por_unidad, { days: 2, points: 5 });
  assert.match(j.motivo, /hours_per_point/);
  // sin la clave, 8 horas por día
  escribirRegistro(repo, [fila({ nivel: 'epica', epica: '3', min: 10, max: 20 }), fila({ nivel: 'plan', epica: '3', historia: '3.1', valor: 2, unidad: 'days' })]);
  assert.deepStrictEqual([correr(['report', '--repo', repo, '--epic', '3']).json.suma_plan], [16]);
});

test('T39 Report_EpicaSinLineas @story-2.75 @ac-4', () => {
  const repo = repoDeHistorias();
  const r = correr(['report', '--repo', repo, '--epic', '9']);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual([r.json.ok, r.json.sin_estimaciones, r.json.suma_plan, r.json.suma_vigente], [true, true, null, null], 'no ceros');
  assert.ok(!fs.existsSync(path.join(repo, REGISTRO)), 'leer no crea el registro');
});

// ── los bordes del registro: campos rotos, épicas que cambian, configuración que no carga ───────

test('Adversarial_HistoriaQueCambiaDeEpica_CuentaEnLaNueva @story-2.75 @ac-4', () => {
  const E = require(CLI);
  const reg = { unreadable: [], lines: [
    fila({ nivel: 'epica', epica: '3', min: 10, max: 20 }),
    fila({ nivel: 'epica', epica: '4', min: 1, max: 2 }),
    fila({ nivel: 'plan', epica: '3', historia: '3.1', valor: 8 }),
    fila({ nivel: 'plan', epica: '3', historia: '3.2', valor: 8 }),
    fila({ nivel: 'historia', epica: '4', historia: '3.1', valor: 30 }),
  ] };
  const tres = E.report(reg, '3', E.DEFAULTS);
  assert.deepStrictEqual([tres.historias.map((h) => h.historia), tres.suma_plan, tres.suma_vigente, tres.dentro], [['3.2'], 8, 8, false]);
  const cuatro = E.report(reg, '4', E.DEFAULTS);
  assert.deepStrictEqual([cuatro.historias.map((h) => h.historia), cuatro.suma_plan, cuatro.suma_vigente, cuatro.fuera], [['3.1'], null, 30, 'encima']);
});

test('Adversarial_LineaLegibleConCamposRotos_EsIlegible @story-2.75 @ac-7', () => {
  const repo = repoDeHistorias();
  escribirRegistro(repo, [
    `﻿${JSON.stringify(fila({ nivel: 'epica', epica: '3', min: 10, max: 20 }))}`,
    fila({ nivel: 'plan', epica: '3', historia: '3.1', valor: null }),
    fila({ nivel: 'plan', epica: '3', historia: '3.2', valor: 'doce' }),
    fila({ nivel: 'epica', epica: '3', min: 30, max: 5 }),
    fila({ nivel: 'plan', epica: '3', historia: null, valor: 4 }),
    fila({ nivel: 'plan', epica: null, historia: '3.3', valor: 4 }),
    fila({ nivel: 'plan', epica: '3', historia: '3.4', valor: 4, unidad: 'weeks' }),
    fila({ nivel: 'plan', epica: '3', historia: '3.5', valor: 12 }),
  ]);
  const r = correr(['report', '--repo', repo, '--epic', '3']);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual(r.json.unreadable, [2, 3, 4, 5, 6, 7], 'el BOM no rompe la primera; los campos rotos sí');
  assert.deepStrictEqual([r.json.rango.min, r.json.suma_plan, r.json.suma_vigente, r.json.dentro], [10, 12, 12, true]);
});

test('Adversarial_RegistroSinSaltoFinal_NoPegaLineas @story-2.75 @ac-2', () => {
  const repo = repoDeHistorias();
  fs.mkdirSync(path.join(repo, '.tycon'));
  fs.writeFileSync(path.join(repo, REGISTRO), JSON.stringify(fila({ nivel: 'epica', epica: '3', min: 10, max: 20 })));
  assert.strictEqual(correr(['plan', '--repo', repo, '--story', '3.1', '--value', '5', '--who', 'acme-lider']).status, 0);
  assert.deepStrictEqual(lineas(repo).map((l) => l.nivel), ['epica', 'plan']);
});

test('Adversarial_BusquedaDeHistoriasIncompleta_NoEsInexistente @story-2.75 @ac-6', () => {
  const E = require(CLI);
  const repo = repoDeHistorias();
  const incompleta = { discoverStories: () => ({ stories: [], partial: true }) };
  assert.throws(() => E.epicaDe(repo, '3.1', incompleta), (e) => e.code === 3 && /no terminó|incompleta/.test(e.message));
  assert.strictEqual(E.epicaDe(repo, '3.1'), '3', 'con la búsqueda real, la épica');
});

test('Adversarial_PlanViejoEnPuntosSinTasa_NoFrenaLaVigente @story-2.75 @ac-34', () => {
  const E = require(CLI);
  const reg = { unreadable: [], lines: [
    fila({ nivel: 'epica', epica: '3', min: 10, max: 20, unidad: 'hours' }),
    fila({ nivel: 'plan', epica: '3', historia: '3.1', valor: 5, unidad: 'points' }),
    fila({ nivel: 'historia', epica: '3', historia: '3.1', valor: 10, unidad: 'hours' }),
    fila({ nivel: 'plan', epica: '3', historia: '3.2', valor: 4, unidad: 'hours' }),
  ] };
  const r = E.report(reg, '3', E.DEFAULTS);
  assert.deepStrictEqual([r.suma_vigente, r.dentro, r.suma_plan], [14, true, null], 'la vigente se compara; el plan no se suma');
  assert.match(r.motivo, /plan/);
});

test('Adversarial_OrgConfig_ComentarioRutaRelativaYLectorRoto @story-2.75 @ac-5', () => {
  const repo = repoDeHistorias();
  // un comentario de un guion bajo vale, como en las demás secciones
  assert.strictEqual(correr(['plan', '--repo', repo, '--story', '3.1', '--value', '2', '--who', 'acme-lider'], { orgConfig: org({ unit: 'days', _nota: 'acme estima en días' }) }).status, 0);
  // una ruta relativa cuyo árbol trae su propio lector
  const arbol = path.dirname(org({ unit: 'days' }));
  fs.mkdirSync(path.join(arbol, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'lib', 'team-repos.js'), path.join(arbol, 'scripts', 'lib', 'team-repos.js'));
  const rel = spawnSync(process.execPath, [CLI, 'plan', '--repo', repo, '--story', '3.2', '--value', '3', '--who', 'acme-lider', '--org-config', path.join(path.basename(arbol), 'team-repos.json'), '--json'],
    { cwd: path.dirname(arbol), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: arbol } });
  assert.strictEqual(rel.status, 0, rel.stderr || rel.stdout);
  // un lector del árbol que no carga: salida 3 con el motivo, sin traza
  fs.writeFileSync(path.join(arbol, 'scripts', 'lib', 'team-repos.js'), 'throw new Error("lector roto de acme")');
  const roto = correr(['plan', '--repo', repo, '--story', '3.3', '--value', '3', '--who', 'acme-lider'], { orgConfig: path.join(arbol, 'team-repos.json') });
  assert.strictEqual(roto.status, 3, roto.stderr || roto.stdout);
  assert.match(roto.json.reason, /lector roto de acme/);
  assert.doesNotMatch(roto.stderr, /at Object\.|node:internal/);
  assert.deepStrictEqual(lineas(repo).map((l) => [l.historia, l.unidad]), [['3.1', 'days'], ['3.2', 'days']]);
});

test('Escribir_RegistroQueNoSeLee_Sale3 @story-2.75 @ac-7', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const repo = repoDeHistorias();
  escribirRegistro(repo, [fila({ nivel: 'epica', epica: '3', min: 10, max: 20 })]);
  const registro = path.join(repo, REGISTRO);
  const E = require(CLI);
  fs.chmodSync(registro, 0o200);
  try {
    // agregar a un registro que no se puede leer no adivina si le falta el salto final: lo dice
    assert.throws(() => E.append(repo, E.linea({ nivel: 'plan', epica: '3', historia: '3.1', valor: 5, unidad: 'hours', cuando: 'x' })),
      (e) => e.code === 3 && /no pude leer/.test(e.message));
  } finally { fs.chmodSync(registro, 0o644); }
  assert.strictEqual(lineas(repo).length, 1, 'no escribió');
});

test('Escribir_UnidadQueElLectorViejoNoValida_Sale3 @story-2.75 @ac-5', () => {
  const repo = repoDeHistorias();
  const arbol = path.dirname(org());
  fs.mkdirSync(path.join(arbol, 'scripts', 'lib'), { recursive: true });
  // un lector anterior a la clave: la deja pasar sin mirarla
  fs.writeFileSync(path.join(arbol, 'scripts', 'lib', 'team-repos.js'),
    'module.exports = { parse: () => ({ ok: true, data: { estimates: { unit: "weeks" } }, problems: [] }) };');
  const r = correr(['plan', '--repo', repo, '--story', '3.1', '--value', '5', '--who', 'acme-lider'], { orgConfig: path.join(arbol, 'team-repos.json') });
  assert.strictEqual(r.status, 3, r.stdout);
  assert.match(r.json.reason, /weeks/);
  assert.ok(!fs.existsSync(path.join(repo, REGISTRO)), 'no escribió');
  // y lo mismo con las tasas: una rota daría un total NaN que el informe leería como «dentro del rango»
  for (const estimates of [{ unit: 'days', hours_per_day: 'ocho' }, { unit: 'points', hours_per_point: -2 }]) {
    fs.writeFileSync(path.join(arbol, 'scripts', 'lib', 'team-repos.js'),
      `module.exports = { parse: () => ({ ok: true, data: { estimates: ${JSON.stringify(estimates)} }, problems: [] }) };`);
    const t = correr(['report', '--repo', repo, '--epic', '3'], { orgConfig: path.join(arbol, 'team-repos.json') });
    assert.strictEqual(t.status, 3, t.stdout);
    assert.match(t.json.reason, /hours_per_(day|point)/);
  }
});

test('Real_SiempreEnHoras @story-2.75 @ac-7', () => {
  const E = require(CLI);
  assert.strictEqual(E.legible(fila({ nivel: 'real', epica: '3', historia: '3.1', valor: 4, unidad: 'hours', ejecucion: 'r1' })), true);
  assert.strictEqual(E.legible(fila({ nivel: 'real', epica: '3', historia: '3.1', valor: 4, unidad: 'days', ejecucion: 'r1' })), false, 'lo real en otra unidad es ilegible');
  // y no se escribe en otra unidad: con la organización en puntos, lo real va en horas
  const repo = repoDeHistorias();
  const r = realEnProceso(['--repo', repo, '--story', '3.1', '--hours', '4', '--run', 'r1', '--who', 'acme-lider'], { orgConfig: org({ unit: 'points', hours_per_point: 3 }) });
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual(lineas(repo).map((l) => [l.nivel, l.unidad, l.valor]), [['real', 'hours', 4]]);
});

test('Confirmacion_BaseYPersonaConForma_Sale2 @story-2.75 @ac-12', () => {
  const repo = repoDeHistorias();
  const casos = [
    [['--base', '3.1,$(rm -rf x)'], /--base/],
    [['--confirmed-by', 'acme;lider'], /--confirmed-by/],
    [['--confirmed-by', 'x'.repeat(81)], /--confirmed-by/],
    [['--who', 'acme\nlider'], /--who/],
  ];
  for (const [extra, motivo] of casos) {
    const r = correr(['story', '--repo', repo, '--story', '3.5', '--value', '5', '--who', 'acme-lider', ...extra]);
    assert.strictEqual(r.status, 2, `${extra.join(' ')}: ${r.stdout}`);
    assert.match(r.json.reason, motivo);
  }
  assert.ok(!fs.existsSync(path.join(repo, REGISTRO)), 'no escribió');
  const ok = correr(['story', '--repo', repo, '--story', '3.5', '--value', '5', '--who', 'María Pérez', '--confirmed-by', 'acme.lider@acme.example', '--base', '3.1,2-4']);
  assert.strictEqual(ok.status, 0, ok.stdout);
});

// ── lo real: anotarlo al cerrar y el error de cada nivel ────────────────────────────────────────────────────────────

test('T17 Real_SeAnota @story-2.75 @ac-15', () => {
  const repo = repoDeHistorias();
  const r = realEnProceso(['--repo', repo, '--story', '3.2', '--hours', '18.5', '--run', 'r1', '--who', 'acme-lider'], { orgConfig: org({ unit: 'days', hours_per_day: 6 }) });
  assert.strictEqual(r.status, 0, JSON.stringify(r.json));
  const [l] = lineas(repo);
  assert.deepStrictEqual(Object.keys(l), CLAVES);
  assert.deepStrictEqual([l.nivel, l.historia, l.epica, l.valor, l.unidad, l.ejecucion], ['real', '3.2', '3', 18.5, 'hours', 'r1']);
  assert.strictEqual(r.json.ok, true);
  // por la línea de comandos, no: lo real lo anota estimate-real
  assert.strictEqual(correr(['real', '--repo', repo, '--story', '3.2', '--hours', '1', '--run', 'r2', '--who', 'acme-lider']).status, 2);
  assert.strictEqual(lineas(repo).length, 1);
});

test('T18 Report_ErrorPorNivel @story-2.75 @ac-17', () => {
  const repo = repoDeHistorias();
  const filas = [
    fila({ nivel: 'epica', epica: '3', min: 40, max: 70 }),
    fila({ nivel: 'plan', epica: '3', historia: '3.2', valor: 12 }),
    fila({ nivel: 'historia', epica: '3', historia: '3.2', valor: 14 }),
    fila({ nivel: 'historia', epica: '3', historia: '3.2', valor: 16 }),
    fila({ nivel: 'real', epica: '3', historia: '3.2', valor: 20, ejecucion: 'r1' }),
    fila({ nivel: 'plan', epica: '3', historia: '3.3', valor: 30 }),
    fila({ nivel: 'historia', epica: '3', historia: '3.3', valor: 50 }),
  ];
  escribirRegistro(repo, [...filas, fila({ nivel: 'real', epica: '3', historia: '3.3', valor: 55, ejecucion: 'r2' })]);
  const h = correr(['report', '--repo', repo, '--story', '3.2']);
  assert.strictEqual(h.status, 0, h.stderr || h.stdout);
  const n = h.json.niveles;
  assert.deepStrictEqual([h.json.historia, h.json.epica, h.json.real.horas, h.json.real.cierres], ['3.2', '3', 20, 1]);
  assert.deepStrictEqual([n.plan.error, n.historia_primera.error, n.historia_ultima.error], [-0.4, -0.3, -0.2]);
  assert.deepStrictEqual([n.plan.horas, n.historia_primera.horas, n.historia_ultima.horas], [12, 14, 16]);
  const e = correr(['report', '--repo', repo, '--epic', '3']).json.real;
  assert.deepStrictEqual([e.cerrada, e.historias, e.faltan, e.suma, e.dentro, e.fuera, e.por], [true, 2, 0, 75, false, 'encima', 5]);
  // sin el real de la segunda historia, la épica está abierta y no se compara
  escribirRegistro(repo, filas);
  const a = correr(['report', '--repo', repo, '--epic', '3']).json.real;
  assert.deepStrictEqual([a.cerrada, a.faltan, a.suma, a.dentro], [false, 1, null, null]);
  // y adentro, la distancia al borde más cercano
  escribirRegistro(repo, [...filas, fila({ nivel: 'real', epica: '3', historia: '3.3', valor: 30, ejecucion: 'r2' })]);
  const d = correr(['report', '--repo', repo, '--epic', '3']).json.real;
  assert.deepStrictEqual([d.suma, d.dentro, d.fuera, d.por], [50, true, null, 10]);
  // un nivel sin línea, y una historia sin real
  escribirRegistro(repo, [fila({ nivel: 'historia', epica: '3', historia: '3.4', valor: 8 }), fila({ nivel: 'real', epica: '3', historia: '3.4', valor: 10, ejecucion: 'r3' })]);
  const s = correr(['report', '--repo', repo, '--story', '3.4']).json.niveles;
  assert.deepStrictEqual([s.plan.error, s.plan.motivo, s.historia_ultima.error], [null, 'sin plan', -0.2]);
  const sinReal = correr(['report', '--repo', repo, '--story', '3.1']).json;
  assert.deepStrictEqual([sinReal.real.horas, sinReal.niveles.plan.error, sinReal.niveles.plan.motivo], [null, null, 'sin horas reales']);
});

test('Report_RealDeLaEpica_BordesYTexto @story-2.75 @ac-17', () => {
  const repo = repoDeHistorias();
  const plan = [fila({ nivel: 'plan', epica: '3', historia: '3.2', valor: 12 }), fila({ nivel: 'real', epica: '3', historia: '3.2', valor: 40, ejecucion: 'r1' })];
  // cerrada y sin rango: la suma, sin marca
  escribirRegistro(repo, plan);
  const sin = correr(['report', '--repo', repo, '--epic', '3']).json.real;
  assert.deepStrictEqual([sin.cerrada, sin.suma, sin.dentro, sin.motivo], [true, 40, null, 'la épica no tiene rango: no se compara']);
  // justo en el borde: adentro, a 0 del borde
  escribirRegistro(repo, [fila({ nivel: 'epica', epica: '3', min: 40, max: 70 }), ...plan]);
  const borde = correr(['report', '--repo', repo, '--epic', '3']);
  assert.deepStrictEqual([borde.json.real.dentro, borde.json.real.por], [true, 0]);
  // sin --json, el texto también dice lo real
  const texto = spawnSync(process.execPath, [CLI, 'report', '--repo', repo, '--epic', '3', '--org-config', SIN_CLAVE], { encoding: 'utf8' }).stdout;
  assert.match(texto, /real 40 h · dentro del rango/);
  // una línea real ilegible: la épica abierta lo dice, no parece una historia sin cerrar
  escribirRegistro(repo, [fila({ nivel: 'epica', epica: '3', min: 40, max: 70 }), plan[0], JSON.stringify({ ...plan[1], unidad: 'days' })]);
  const rota = correr(['report', '--repo', repo, '--epic', '3']).json.real;
  assert.strictEqual(rota.cerrada, false);
  assert.match(rota.motivo, /ilegible/);
});

test('T21 Unidades_PuntosSinTasaYDias @story-2.75 @ac-18 @ac-19', () => {
  const repo = repoDeHistorias();
  escribirRegistro(repo, [
    fila({ nivel: 'plan', epica: '3', historia: '3.2', valor: 5, unidad: 'points' }),
    fila({ nivel: 'historia', epica: '3', historia: '3.2', valor: 2, unidad: 'days' }),
    fila({ nivel: 'real', epica: '3', historia: '3.2', valor: 8, ejecucion: 'r1' }),
    fila({ nivel: 'real', epica: '3', historia: '3.2', valor: 12, ejecucion: 'r2' }),
  ]);
  const r = correr(['report', '--repo', repo, '--story', '3.2'], { orgConfig: org({ unit: 'days', hours_per_day: 6 }) });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  const n = r.json.niveles;
  assert.deepStrictEqual([n.plan.estimado, n.plan.unidad, n.plan.horas, n.plan.error, n.plan.motivo], [5, 'points', null, null, 'sin tasa de horas por punto']);
  assert.deepStrictEqual([n.historia_ultima.horas, n.historia_ultima.error], [12, -0.4]);
  assert.deepStrictEqual([r.json.real.horas, r.json.real.cierres, r.json.real.varios_cierres], [20, 2, true]);
});

test('T41 Org_EstimatesNoObjeto @story-2.75 @ac-37', () => {
  const repo = repoDeHistorias();
  const arbol = path.dirname(org());
  fs.mkdirSync(path.join(arbol, 'scripts', 'lib'), { recursive: true });
  for (const estimates of ['hours', [], null, 5]) {
    // un lector anterior a la clave: la deja pasar tal cual
    fs.writeFileSync(path.join(arbol, 'scripts', 'lib', 'team-repos.js'),
      `module.exports = { parse: () => ({ ok: true, data: { estimates: ${JSON.stringify(estimates)} }, problems: [] }) };`);
    const r = correr(['report', '--repo', repo, '--epic', '3'], { orgConfig: path.join(arbol, 'team-repos.json') });
    assert.strictEqual(r.status, 3, `${JSON.stringify(estimates)}: ${r.stdout}`);
    assert.match(r.json.reason, /estimates: tiene que ser un objeto/);
  }
});

test('Real_EntradasYReintento @story-2.75 @ac-16 @ac-35', () => {
  const repo = repoDeHistorias();
  const real = (extra) => realEnProceso(['--repo', repo, '--story', '3.2', '--who', 'acme-lider', ...extra]);
  // por la línea de comandos no se anota lo real: las horas tienen que venir de la constancia del cierre
  const consola = correr(['real', '--repo', repo, '--story', '3.2', '--hours', '3', '--run', 'r1', '--who', 'acme-lider']);
  assert.strictEqual(consola.status, 2, consola.stdout);
  assert.match(consola.json.reason, /estimate-real/);
  // sin --run sale 2 aunque falten también las horas
  assert.strictEqual(real([]).status, 2);
  assert.match(real(['--hours', '3']).json.reason, /--run/);
  for (const sin of [['--run', 'r1'], ['--run', 'r1', '--hours', '0']]) {
    const r = real(sin);
    assert.deepStrictEqual([r.status, r.json.ok, r.json.reason], [0, false, 'sin_horas'], sin.join(' '));
  }
  for (const malo of [['--run', 'r1', '--hours', 'doce'], ['--run', 'r1;x', '--hours', '3']]) assert.strictEqual(real(malo).status, 2, malo.join(' '));
  assert.strictEqual(realEnProceso(['--repo', repo, '--story', '5.1', '--hours', '3', '--run', 'r1']).status, 2, 'sin epic:');
  // sin horas gana: una historia sin epic: y sin horas no frena el cierre
  assert.deepStrictEqual(realEnProceso(['--repo', repo, '--story', '5.1', '--run', 'r1']).json.reason, 'sin_horas');
  assert.deepStrictEqual(lineas(repo), [], 'nada escrito');
  assert.strictEqual(real(['--run', 'r1', '--hours', '3']).json.ok, true);
  const otra = real(['--run', 'r1', '--hours', '5']);
  assert.deepStrictEqual([otra.status, otra.json.ok, otra.json.reason], [0, true, 'ya_anotado']);
  assert.strictEqual(lineas(repo).length, 1, 'el reintento no duplica');
});

// ── lo que confirmó el pase adversarial ────────────────────────────────────────────────────────────────────────────

test('Adversarial_IdRepetido_LaEpicaSaleDelSpec @story-2.75 @ac-15 @ac-6', () => {
  const repo = repoDeHistorias();
  const otra = path.join(repo, 'specs', 'features', 'story-3.2-otra.md');
  fs.mkdirSync(path.dirname(otra), { recursive: true });
  fs.writeFileSync(otra, '---\nepic: phone\nstory: "3.2"\ntitle: "Otra 3.2"\nstatus: done\n---\n');
  // con el spec, la épica es la suya; sin él, dos historias con el mismo id no se adivinan
  const r = realEnProceso(['--repo', repo, '--story', '3.2', '--spec', otra, '--hours', '2', '--run', 'r1', '--who', 'acme-lider']);
  assert.strictEqual(r.status, 0, JSON.stringify(r.json));
  assert.strictEqual(lineas(repo)[0].epica, 'phone');
  const p = correr(['plan', '--repo', repo, '--story', '3.2', '--value', '4', '--who', 'acme-lider']);
  assert.strictEqual(p.status, 2, p.stdout);
  assert.match(p.json.reason, /--spec/);
  assert.strictEqual(correr(['plan', '--repo', repo, '--story', '3.2', '--spec', otra, '--value', '4', '--who', 'acme-lider']).status, 0);
});

test('Adversarial_EpicaConComentario_SinElComentario @story-2.75 @ac-2', () => {
  const repo = repoDeHistorias();
  fs.writeFileSync(path.join(repo, 'specs', 'story-3.1-algo.md'), '---\nepic: 3  # la del motor\nstory: "3.1"\ntitle: "x"\nstatus: done\n---\n');
  assert.strictEqual(correr(['plan', '--repo', repo, '--story', '3.1', '--value', '4', '--who', 'acme-lider']).status, 0);
  assert.strictEqual(lineas(repo)[0].epica, '3');
});

test('Adversarial_RealPorConsola_ConOpcionesAntes @story-2.75 @ac-15', () => {
  const repo = repoDeHistorias();
  for (const args of [['--json', 'real', '--repo', repo], ['--repo', repo, 'real']]) {
    const r = spawnSync(process.execPath, [CLI, ...args, '--story', '3.2', '--hours', '5', '--run', 'r1', '--who', 'acme-lider', '--org-config', SIN_CLAVE], { encoding: 'utf8' });
    assert.strictEqual(r.status, 2, `${args.join(' ')}: ${r.stdout}`);
  }
  assert.deepStrictEqual(lineas(repo), []);
});

test('Adversarial_PlanEnOtraUnidad_NoCancelaLaComparacion @story-2.75 @ac-34', () => {
  const repo = repoDeHistorias();
  escribirRegistro(repo, [
    fila({ nivel: 'epica', epica: '3', min: 10, max: 20, unidad: 'points' }),
    fila({ nivel: 'plan', epica: '3', historia: '3.1', valor: 2, unidad: 'days' }),
    fila({ nivel: 'historia', epica: '3', historia: '3.1', valor: 12, unidad: 'points' }),
  ]);
  const j = correr(['report', '--repo', repo, '--epic', '3']).json;
  assert.deepStrictEqual([j.unidad, j.suma_vigente, j.dentro], ['points', 12, true]);
  assert.strictEqual(j.suma_plan, null, 'el plan en otra unidad, sin tasa, no se suma');
});

test('Adversarial_HistoriaQueCambiaDeEpica_LoRealCuentaEnLaSuya @story-2.75 @ac-17', () => {
  const repo = repoDeHistorias();
  escribirRegistro(repo, [
    fila({ nivel: 'epica', epica: '1', min: 1, max: 10 }),
    fila({ nivel: 'epica', epica: '2', min: 1, max: 10 }),
    fila({ nivel: 'plan', epica: '1', historia: '1.1', valor: 5 }),
    fila({ nivel: 'historia', epica: '2', historia: '1.1', valor: 5 }),
    fila({ nivel: 'real', epica: '2', historia: '1.1', valor: 7, ejecucion: 'a' }),
  ]);
  const uno = correr(['report', '--repo', repo, '--epic', '1']).json.real;
  assert.deepStrictEqual([uno.historias, uno.cerrada, uno.suma], [0, false, null]);
  const dos = correr(['report', '--repo', repo, '--epic', '2']).json.real;
  assert.deepStrictEqual([dos.historias, dos.cerrada, dos.suma], [1, true, 7]);
});

/**
 * Las claves y líneas que nombran una estimación en lo que una organización sin `estimates` ya ve hoy, o que las
 * estimaciones suman a propósito. Una clave o una línea con «estim» fuera de esta lista es una salida que cambió sin que nadie
 * lo pidiera.
 */
const ESTIM_PERMITIDAS = {
  // el tamaño de la corrida y su tiempo estimado, del arranque del pipeline: no dependen de `estimates`
  claves: new Set(['estimado_min', 'estimado_de', 'estimate_min', 'estimate_source', 'estimates',
    // la foto de Proyectos (AC 24): el estado del registro y la estimación de cada épica, null sin registro
    'estimaciones', 'estimacion']),
  // la línea entera de la corrida, de punta a punta: lo que se le pegue después no queda tapado
  lineas: [/^TAMAÑO: corrida \w+ \([^)\n]*\) · estimado \d+ min( \([^\n]*\))?$/],
};
// las carpetas de la máquina (el clon del arnés, la temporal, el laboratorio) viajan en la salida y pueden llamarse
// como la historia: se tapan antes de buscar, para que el nombre de una carpeta no ponga la prueba roja
function sinRutas(texto, rutas) {
  return rutas.reduce((t, r) => t.split(r).join('<ruta>'), texto);
}

function rutasDeLaMaquina(...extra) {
  const todas = [ROOT, os.tmpdir(), ...extra].flatMap((r) => { try { return [r, fs.realpathSync(r)]; } catch { return [r]; } });
  return [...new Set(todas)].sort((a, b) => b.length - a.length);
}

/** Las rutas de clave o de texto con «estim» que la lista cerrada no conoce, con las carpetas de `rutas` tapadas. */
function estimFueraDeLista(valor, ruta = '$', rutas = []) {
  const fuera = [];
  if (typeof valor === 'string') {
    valor = sinRutas(valor, rutas);
    // la línea permitida se saca entera; lo que siga después de ella se mira igual
    const resto = ESTIM_PERMITIDAS.lineas.reduce((t, rx) => t.replace(rx, ''), valor);
    if (/estim/i.test(resto)) fuera.push(`${ruta}: ${valor.slice(0, 120)}`);
  } else if (Array.isArray(valor)) {
    valor.forEach((v, i) => fuera.push(...estimFueraDeLista(v, `${ruta}[${i}]`, rutas)));
  } else if (valor && typeof valor === 'object') {
    for (const [k, v] of Object.entries(valor)) {
      if (/estim/i.test(k) && !ESTIM_PERMITIDAS.claves.has(k)) fuera.push(`${ruta}.${k}`);
      // el texto de una clave permitida es suyo (el tiempo estimado de la corrida dice de dónde sale)
      if (!(typeof v === 'string' && ESTIM_PERMITIDAS.claves.has(k))) fuera.push(...estimFueraDeLista(v, `${ruta}.${k}`, rutas));
    }
  }
  return fuera;
}

test('T35 SinNada_IgualQueHoy @story-2.75 @ac-32', () => {
  // 🔴 rojo: una organización sin `estimates` y un repo sin registro ven algo de estimaciones que AC 32 no lista
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't35-sin-nada-'));
  const rutas = rutasDeLaMaquina(base);
  try {
    const home = path.join(base, 'home');
    const repo = path.join(base, 'repo');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.symlinkSync(ROOT, path.join(home, '.claude', 'agent-skills'));
    fs.symlinkSync(ROOT, path.join(home, '.claude', 'tycon-harness'));
    fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src'));
    const git = (...a) => {
      const fecha = '2026-01-01T00:00:00Z';
      const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a],
        { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha } });
      assert.strictEqual(r.status, 0, `git ${a[0]}: ${r.stderr}`);
    };
    git('init', '-q', '-b', 'feat/x');
    git('config', 'user.email', 'acme@example.com');
    git('config', 'user.name', 'acme');
    const story = path.join(repo, 'specs', 'story-3.2-algo.md');
    fs.writeFileSync(story, ['---', 'epic: 3', 'story: "3.2"', 'title: "La historia 3.2"', 'status: ready-for-dev',
      'files_to_modify:', '  - src/a.js', '---', '# Story 3.2', '', '### Tests', '', '| # | Test |', '|---|---|', '| T1 | a |', ''].join('\n'));
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
    git('add', '.');
    git('commit', '-qm', 'inicio');
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 't35-sin-nada', TYCON_LANE_LLM: '0',
      TYCON_HOME: '', TYCON_TIME_TRACKING: 'none', TYCON_MUTATION_CHECK: 'off', TYCON_WAIT_NOTICE: '' };
    const pipeline = (args) => {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'pipeline.js'), ...args],
        { encoding: 'utf8', env, input: '', cwd: repo });
      assert.strictEqual(r.status, 0, `${args[0]}: ${r.stderr}${r.stdout}`);
      return JSON.parse(r.stdout);
    };

    // el pipeline: el arranque (lo breve y lo completo) y el set de revisores
    const breve = pipeline(['start', '--story', story, '--repo', repo, '--brief']);
    const completo = JSON.parse(fs.readFileSync(breve.completo, 'utf8'));
    const revisores = pipeline(['advisors', '--repo', repo, '--story', story, '--files', path.join(repo, 'src', 'a.js')]);
    for (const [nombre, salida] of [['start --brief', breve], ['start', completo], ['advisors', revisores]]) {
      assert.deepStrictEqual(estimFueraDeLista(salida, '$', rutas), [], `${nombre}: nombra estimaciones que AC 32 no lista`);
    }

    // la noche: la foto de Proyectos dice «sin estimaciones» y ninguna épica trae una
    const SNAP = require(path.join(ROOT, 'scripts', 'nightly', 'projects', 'snapshot.js'));
    const foto = SNAP.fotoDeRepo(repo, { budgetMs: 20000, sdlc: null, sdlcError: 'sin métricas en la prueba', orgConfig: SIN_CLAVE });
    assert.strictEqual(foto.cobertura.estimaciones.estado, 'sin_registro');
    assert.ok(foto.epicas.every((e) => e.estimacion === null), JSON.stringify(foto.epicas));
    assert.deepStrictEqual(estimFueraDeLista(foto, '$', rutas), [], 'la foto de Proyectos');

    // el sitio: la sección de estimaciones muestra el valor por defecto, sin motivo
    const ORG = require(path.join(ROOT, 'scripts', 'lib', 'org-config.js'));
    const E = require(CLI);
    assert.deepStrictEqual(ORG.estimacionesDeHoy(path.dirname(SIN_CLAVE)), { hoy: { ...E.DEFAULTS }, motivo: null });

    // el cierre: sin constancia de horas, estimate-real dice sin_horas y no escribe
    const real = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'real-hours.js'))
      .estimateReal({ storyPath: story, run: 'abc123', repo, home, env });
    assert.deepStrictEqual([real.code, real.result.reason], [0, 'sin_horas']);
    assert.strictEqual(fs.existsSync(path.join(repo, REGISTRO)), false, 'sin horas no se crea el registro');

    // el pedido de trabajo: sin registro, la línea del paso que lo marca activo no nombra la estimación
    const capa = path.join(base, 'platform.js');
    fs.writeFileSync(capa, "process.stdout.write(JSON.stringify({ ok: true, value: { id: 7, estado: 'Active', previo: 'New', changed: true }, summary: 'pedido de trabajo #7: New → Active' }) + '\\n');");
    const FLAGS = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'external-flags.js'));
    const marcado = FLAGS.adoMarkActive({ workItem: 7, repoDir: repo, storyId: '3.2', platformJs: capa, estimatesJs: CLI, orgConfig: SIN_CLAVE });
    assert.strictEqual(marcado.marked, true);
    assert.doesNotMatch(marcado.line, /estim/i);

    // la lista es cerrada: una clave con «estim» inventada la pone roja
    assert.deepStrictEqual(estimFueraDeLista({ ...breve, estimacion_inventada: 1 }, '$', rutas), ['$.estimacion_inventada']);
    assert.deepStrictEqual(estimFueraDeLista({ acciones: ['estimado a ojo: 3 días'] }), ['$.acciones[0]: estimado a ojo: 3 días']);
    const tam = 'TAMAÑO: corrida liviana (sin código) · estimado 12 min';
    assert.deepStrictEqual(estimFueraDeLista({ t: tam }), []);
    assert.deepStrictEqual(estimFueraDeLista({ t: `${tam} · estimación del pedido: 8 h` }).length, 1);
    // una carpeta con el nombre de la historia no cuenta; lo que dice el texto fuera de la carpeta, sí
    const clon = '/x/wt-2.75-estimaciones';
    assert.deepStrictEqual(estimFueraDeLista({ packs_dir: `${clon}/packs` }, '$', [clon]), []);
    assert.deepStrictEqual(estimFueraDeLista({ nota: `${clon}/packs: estimado a ojo` }, '$', [clon]), ['$.nota: <ruta>/packs: estimado a ojo']);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('T35 CarpetaConElNombre_NoDaRojo @story-2.75 @ac-32', () => {
  // 🔴 rojo: con la carpeta temporal llamada como la historia, T35 sale roja sin que el código cambie
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't35-carpeta-'));
  try {
    const conNombre = path.join(tmp, 'estimaciones-tmp');
    fs.mkdirSync(conNombre);
    const env = { ...process.env, TMPDIR: conNombre, TMP: conNombre, TEMP: conNombre };
    delete env.NODE_TEST_CONTEXT; // dentro de otra corrida de node --test, el hijo le reportaría al padre y no a su salida
    const r = spawnSync(process.execPath, ['--test', '--test-name-pattern=SinNada_IgualQueHoy', __filename], { encoding: 'utf8', env });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /pass 1/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('T36 Censo @story-2.75 @ac-33', () => {
  // 🔴 rojo: una pieza nueva sin ficha ni suite, o con un shell que el arnés no usa
  const piezas = ['scripts/lib/estimates.js', 'scripts/lib/similar-stories.js', 'skills/tycon-pipeline/scripts/lib/real-hours.js'];
  for (const p of piezas) {
    const codigo = fs.readFileSync(path.join(ROOT, p), 'utf8');
    assert.doesNotMatch(codigo, /execSync|shell\s*:\s*true/, p);
  }
  for (const p of piezas.slice(0, 2)) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, p), 'utf8'), /azure|github|clockify|solidtime/i, p);
  const guia = fs.readFileSync(path.join(ROOT, 'guides', 'piezas-del-arnes.md'), 'utf8');
  const detalle = fs.readFileSync(path.join(ROOT, 'guides', 'maintaining', 'piezas-en-detalle.md'), 'utf8');
  for (const p of piezas) {
    assert.match(guia, new RegExp(`^## ${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), `${p}: sin ficha en piezas-del-arnes.md`);
    assert.match(detalle, new RegExp(`^## ${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), `${p}: sin detalle en piezas-en-detalle.md`);
  }
  const suites = JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'tests', 'suites.json'), 'utf8')));
  for (const ruta of ['tests/estimates.test.js', 'tests/similar-stories.test.js', 'tycon-pipeline/scripts/tests/estimate-real.test.js', 'tests/platform-estimate.test.js']) {
    assert.ok(suites.includes(`"${ruta}"`), `${ruta}: sin su suite en suites.json`);
  }
});
