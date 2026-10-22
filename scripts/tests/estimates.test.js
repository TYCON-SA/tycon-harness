'use strict';

/**
 * estimates.test.js — el registro de estimaciones de un repo de historias (scripts/lib/estimates.js): la épica con un
 * rango, el plan con un valor por historia, la historia que lo ajusta, y el informe que compara la suma con el rango.
 *
 * Lo que no se puede perder: el registro sólo se agrega, nunca se reescribe (las versiones son el dato); cada línea trae
 * las quince claves en el mismo orden, que es el contrato que leen el sitio y la plataforma; una línea ilegible se cuenta
 * y no tira el resto; una entrada inválida sale 2 sin escribir nada; con unidades mezcladas todo pasa a horas, y si no se
 * puede (puntos sin tasa) no se marca la épica dentro ni fuera. Todo en laboratorios (organización acme, persona
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
  const codigo = fs.readFileSync(CLI, 'utf8');
  assert.doesNotMatch(codigo, /execSync|shell\s*:\s*true/);
  assert.doesNotMatch(codigo, /azure|github|clockify/i);
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
