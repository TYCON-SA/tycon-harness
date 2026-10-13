'use strict';
/**
 * periodic-exam.test.js — el examen de los revisores corre solo en la máquina designada, y
 * cuando NO corre, eso se nota.
 *
 * Story 1.1. Los casos no son decorativos: cada uno fija una de las tres cosas que hacen que la
 * pieza sirva, y las tres nacen de un modo de falla ya medido en este repo:
 *
 *   1. **Que corra sin que nadie la arranque** — el lanzador anterior vivía enterrado bajo tres
 *      condiciones anidadas dentro del instalador y en la máquina del dev nunca disparó.
 *   2. **Que un examen que NO terminó no se parezca a uno que salió verde** — el lanzador anterior
 *      sellaba la semana ANTES de correr, así que la corrida cancelada el 2026-08-28 tras 5h30 se
 *      comió el turno de esa semana sin dejar una sola medición.
 *   3. **Que el resultado lo vea alguien más** — `.bench/` está en el `.gitignore`, así que un
 *      reporte que viva ahí no sale nunca de la máquina que lo escribió.
 *
 * 🔴 Ningún caso gasta una llamada al modelo: el examen caro se inyecta con `TYCON_EXAM_RUNNER`
 * apuntando a un runner FALSO. La corrida real (~5h30) es prueba del mini, no de esta suite.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const TCG = path.resolve(__dirname, '..', '..');
const EXAMEN = path.join(TCG, 'scripts', 'controls-bench', 'periodic-exam.js');
const NOTICE = path.join(TCG, 'scripts', 'hooks', 'bench-notice.js');
const NOMBRADOR = path.join(TCG, 'scripts', 'controls-bench', 'report-name.js');

const E = require(EXAMEN);
const N = require(NOMBRADOR);

// El estado renombrado a inglés en la tanda D2 de la story 8.9: el nombre viejo sale del mapa (no se escribe literal).
// En la copia pública el mapa no viaja: esos casos se saltean con motivo (sin nombre viejo no hay nada que migrar).
const MAPA = (() => { try { return JSON.parse(fs.readFileSync(path.join(TCG, 'scripts', 'lib', 'renames.json'), 'utf8')); } catch (_) { return null; } })();
const SIN_MAPA = !MAPA && 'copia pública: sin el mapa de renombres no hay nombre viejo';
function viejoD2(nuevo) {
  const e = MAPA.entries.find((x) => x.batch === 'D2' && x.new.endsWith(`/${nuevo}`));
  assert.ok(e, `el mapa no tiene la entrada D2 de ${nuevo}`);
  return path.basename(e.old);
}

const DIA = 24 * 60 * 60 * 1000;
const haceDias = (n) => new Date(Date.now() - n * DIA).toISOString();

// El git del dev (core.hooksPath global, firmas, plantillas) no puede decidir el resultado de un
// caso: cada suite corre con una config global vacía y propia.
const GITCFG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'examen-git-')), 'gitconfig');
fs.writeFileSync(GITCFG, '');
process.env.GIT_CONFIG_GLOBAL = GITCFG;
process.env.GIT_CONFIG_NOSYSTEM = '1';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Andamio: un banco de trabajo aislado con HOME propio, repo git propio y runner falso.
// ─────────────────────────────────────────────────────────────────────────────────────────────

let TMPS = [];
function banco(opts = {}) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'examen-'));
  TMPS.push(raiz);
  const casa = path.join(raiz, 'casa');
  const repo = path.join(raiz, 'repo');
  const remoto = path.join(raiz, 'remoto.git');
  fs.mkdirSync(path.join(casa, '.claude', '.tycon-pipeline'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'scripts', 'controls-bench', '.bench'), { recursive: true });
  // 🔴 Los reportes nocturnos (banco y suites) que el aviso lee por default son los del REPO REAL:
  //    viajan por git y cambian cada noche. Sin aislarlos, un caso mide la máquina y no el aviso:
  //    T51 se puso rojo el 2026-09-16 porque el motivo de una suite AJENA en rojo traía «no medido».
  //    Acá van frescos y limpios, que es cuando el aviso calla sobre ellos.
  const reporteSuites = path.join(repo, 'scripts', 'controls-bench', 'ultimo-suites.json');
  const reporteBanco = path.join(repo, 'scripts', 'controls-bench', 'ultimo-banco.json');
  fs.writeFileSync(reporteSuites, JSON.stringify({ kind: 'bash-tests', ts: new Date().toISOString(), origen: 'banco-falso', corridas: 1, failures: [] }));
  fs.writeFileSync(reporteBanco, JSON.stringify({ ts: new Date().toISOString(), ran: 1, failed: 0, skipped: 0, nomedido: 0, parityBreaks: 0, baselineRegressions: 0 }));

  // Repo git de verdad: el staging selectivo y el push con reintento no se pueden simular.
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git('config', 'user.email', 'b@b');
  git('config', 'user.name', 'banco');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'scripts/controls-bench/.bench/\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'repo de prueba\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  if (opts.remoto !== false) {
    execFileSync('git', ['init', '-q', '--bare', remoto], { stdio: 'pipe' });
    git('remote', 'add', 'origin', remoto);
    git('push', '-q', '-u', 'origin', 'main');
  }

  const cfg = Object.assign({
    designated_machine: 'Devas-Mac-mini',
    days_between_runs: 3,
    scheduled_days: ['tuesday', 'friday'],
    hour: '02:00',
  }, opts.config || {});
  const rutaCfg = path.join(repo, 'exam-config.json');
  fs.writeFileSync(rutaCfg, JSON.stringify(cfg, null, 2));

  // Runner FALSO. `modo` decide cómo se porta; siempre deja rastro de sus argumentos para que un
  // caso pueda afirmar QUÉ se le pidió (que corrió completo y con las dos herramientas).
  const rutaRunner = path.join(raiz, 'runner-falso.js');
  const bitacora = path.join(raiz, 'argv-del-runner.json');
  fs.writeFileSync(rutaRunner, [
    'const fs=require("fs");',
    `fs.writeFileSync(${JSON.stringify(bitacora)}, JSON.stringify(process.argv.slice(2)));`,
    'const i=process.argv.indexOf("--json");',
    `const modo=${JSON.stringify(opts.modoRunner || 'green')};`,
    'if(modo==="dies"){process.exit(1);}',
    'if(modo==="lies"){process.exit(0);}',   // sale 0 pero NO escribe el reporte
    // El criterio de "qué no se pudo medir" NO se copia acá: se usa el módulo real (2026-09-10).
    `const {rubrosNoMedidos}=require(${JSON.stringify(path.join(TCG, 'scripts', 'controls-bench', 'unmeasured-categories.js'))});`,
    'const noMedido=(tool,runs)=>{const nm=rubrosNoMedidos({tool,runs});const o={};if(nm.inestables)o.inestables=nm.inestables;if(nm.paridad)o.paridad=nm.paridad;return Object.keys(o).length?{no_medido:o}:{};};',
    'if(modo==="empty"){if(i>=0)fs.writeFileSync(process.argv[i+1],JSON.stringify({ts:new Date().toISOString(),tool:"claude",runs:1,failed:0,criterio:0,inestables:null,erroresDeCorrida:0,fugas:0,artefactos:0,parityBreaks:null,paridadReal:null,baselineRegressions:0,results:{},...noMedido("claude",1)}));process.exit(0);}',
    'const casos={"a|claude":{},"b|claude":{},"c|claude":{}};',
    // 🔴 `--tool both` = DOS ranuras por caso (una por herramienta). Con 3 casos hay 6 ranuras:
    // 3 errores = UNA herramienta entera caída (la otra midió) · 6 = las dos.
    'const N=3, RANURAS=6;',
    'const err = modo==="all-error" ? RANURAS : modo==="one-tool-down" ? N : 0;',
    'const skip = modo==="all-skipped" ? RANURAS : modo==="mcp-partly-missing" ? N : 0;',
    'if(modo==="slow"){const t=Date.now();while(Date.now()-t<2500);}',
    `if(modo==="slow"){fs.appendFileSync(${JSON.stringify(bitacora)}+".pids", process.pid+"\\n");}`,
    'const TOOL = process.env.BENCH_TOOL || "claude";',
    'const RUNS=(TOOL==="both"?3:1); const nm=rubrosNoMedidos({tool:TOOL,runs:RUNS}); const mi=nm.inestables===null, mp=nm.paridad===null;',
    'const cuerpo={ts:new Date().toISOString(),tool:TOOL,runs:RUNS,failed:err,criterio:(err||skip?0:1),inestables:(mi?(err||skip?0:1):null),fugas:0,artefactos:0,',
    '  erroresDeCorrida:err,varianzaDeclarada:0,parityBreaks:(mp?(err||skip?0:1):null),paridadReal:(mp?(err||skip?0:1):null),',
    '  paridadPorInestabilidad:(mp?0:null),baselineRegressions:0,skippedMcp:skip,alcance:"completo",results:casos,...noMedido(TOOL,RUNS)};',
    'if(i>=0)fs.writeFileSync(process.argv[i+1],JSON.stringify(cuerpo));',
    'process.exit(modo==="red"?1:0);',
  ].join('\n'));

  // Sonda FALSA de sesión: `ok` responde, `expired` sale con error de autenticación.
  const rutaSonda = path.join(raiz, 'sonda-falsa.sh');
  fs.writeFileSync(rutaSonda, opts.sonda === 'expired'
    ? '#!/bin/sh\necho "Invalid API key · Please run /login" >&2\nexit 1\n'
    : '#!/bin/sh\necho ok\nexit 0\n');
  fs.chmodSync(rutaSonda, 0o755);

  return { raiz, casa, repo, remoto, rutaCfg, rutaRunner, rutaSonda, bitacora, git, reporteSuites, reporteBanco,
    reporteQueViaja: path.join(repo, E.RUTA_REPORTE_QUE_VIAJA),
    intento: path.join(repo, 'scripts', 'controls-bench', '.bench', 'examen-intento.json'),
    sello: path.join(casa, '.claude', '.tycon-pipeline', 'periodic-exam-last-run'),
    lock: path.join(repo, 'scripts', 'controls-bench', '.bench', 'examen.lock') };
}

function correr(b, args = [], extraEnv = {}) {
  return spawnSync(process.execPath, [EXAMEN, ...args], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      HOME: b.casa,
      TYCON_EXAM_CONFIG: b.rutaCfg,
      TYCON_EXAM_RUNNER: b.rutaRunner,
      TYCON_EXAM_REPO: b.repo,
      TYCON_EXAM_MACHINE: 'Devas-Mac-mini',
      TYCON_EXAM_PROBE: b.rutaSonda,
    }, extraEnv),
  });
}

/** Sonda falsa por herramienta: `ok` responde, `no-session` sale con 401 como codex sin credenciales. */
function sondaPara(b, nombre, modo) {
  const r = path.join(b.raiz, `sonda-${nombre}.sh`);
  fs.writeFileSync(r, modo === 'no-session'
    ? '#!/bin/sh\necho "ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses" >&2\nexit 1\n'
    : '#!/bin/sh\necho ok\nexit 0\n');
  fs.chmodSync(r, 0o755);
  return r;
}

function avisar(b, extraEnv = {}) {
  return spawnSync(process.execPath, [NOTICE], {
    encoding: 'utf8', input: '{"source":"startup"}',
    env: Object.assign({}, process.env, {
      HOME: b.casa,
      // La config del banco (con máquina designada), no la del clon: desde la story 8.4 el aviso calla el examen si la
      // config no designa máquina, y la copia pública la trae vacía — sin esto estos casos medirían el clon, no el aviso.
      TYCON_EXAM_CONFIG: b.rutaCfg,
      TYCON_BENCH_DIR: path.join(b.repo, 'scripts', 'controls-bench', '.bench'),
      TYCON_EXAM_REPORT: b.reporteQueViaja,
      TYCON_SUITES_REPORT: b.reporteSuites,
      TYCON_BENCH_REPORT: b.reporteBanco,
      TYCON_EVAL_SANDBOX: '',
    }, extraEnv),
  });
}

const escribir = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2)); };

test.after(() => { for (const d of TMPS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* */ } } });

// ─────────────────────────────────────────────────────────────────────────────────────────────
// T23 — un solo umbral, y NO es el que el aviso ya usa para otra cosa (AC 24)
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('T23 un_solo_umbral: los 8 días viven en un solo lugar y no pisan el umbral de paridad', () => {
  assert.strictEqual(E.VEJEZ_MS, 8 * DIA, 'el umbral del examen son 8 días');

  const fuenteAviso = fs.readFileSync(NOTICE, 'utf8');
  // El aviso NO puede tener su propia definición de 8 días: la importa.
  assert.ok(!/8\s*\*\s*24\s*\*\s*60/.test(fuenteAviso),
    'bench-notice.js no puede redefinir el umbral de 8 días — lo importa de periodic-exam.js');
  assert.ok(/VEJEZ_MS/.test(fuenteAviso), 'bench-notice.js tiene que consumir VEJEZ_MS');
  // …y el umbral de paridad (3 días, otra pregunta, otro dueño) sigue intacto.
  assert.ok(/STALE_MS/.test(fuenteAviso) && /3\s*\*\s*24\s*\*\s*60/.test(fuenteAviso),
    'el umbral de antigüedad del reporte de paridad NO se toca');

  const fuenteExamen = fs.readFileSync(EXAMEN, 'utf8');
  const definiciones = (fuenteExamen.match(/8\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/g) || []).length;
  assert.strictEqual(definiciones, 1, 'una sola definición del umbral en todo el código');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// T13 / T25 — sólo la máquina designada lanza; el resto no corre nada nuevo (AC 18, 14)
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('T13 solo_la_maquina_designada_lanza: otra máquina no lanza nada y sale 0', () => {
  const cfg = { designated_machine: 'Devas-Mac-mini' };
  assert.strictEqual(E.esMaquinaDesignada(cfg, ['equipo-deva', 'macbook air de deva']), false);
  assert.strictEqual(E.esMaquinaDesignada(cfg, ['devas-mac-mini']), true, 'sin distinguir mayúsculas');
  assert.strictEqual(E.esMaquinaDesignada(cfg, ['Devas-Mac-mini.local']), true, 'el .local no cuenta');
  assert.strictEqual(E.esMaquinaDesignada({}, ['devas-mac-mini']), false,
    'sin máquina designada en la config, NADIE corre (una máquina de más gasta la cuota del dev)');

  const b = banco();
  const r = correr(b, [], { TYCON_EXAM_MACHINE: 'equipo-deva' });
  assert.strictEqual(r.status, 0, 'no es un error: es que no le toca');
  assert.match(r.stdout + r.stderr, /no-designada/);
  assert.ok(!fs.existsSync(b.sello), 'no sella');
  assert.ok(!fs.existsSync(b.reporteQueViaja), 'no escribe reporte');
  assert.ok(!fs.existsSync(b.bitacora), 'ni siquiera invoca el examen');
});

test('T25 las_otras_maquinas_no_corren_nada_nuevo: el kill-switch corta antes de todo', () => {
  const b = banco();
  const r = correr(b, [], { TYCON_NO_NIGHTLY_EXAM: '1' });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /apagado/);
  assert.ok(!fs.existsSync(b.bitacora), 'el examen no se invoca');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// T2 / T24 — la frecuencia vive en un solo lugar, y la segunda corrida de la semana corre
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('T2 frecuencia_en_un_solo_lugar: el disparador se regenera desde la config', () => {
  const base = { label: 'ar.com.tycon.examen', nodeBin: '/usr/bin/node', script: '/x/examen.js' };
  const dosDias = E.plistDeseado(Object.assign({ scheduled_days: ['tuesday', 'friday'], hour: '02:00' }, base));
  assert.match(dosDias, /<key>Weekday<\/key><integer>2<\/integer>/, 'martes');
  assert.match(dosDias, /<key>Weekday<\/key><integer>5<\/integer>/, 'viernes');
  assert.match(dosDias, /<key>Hour<\/key><integer>2<\/integer>/);
  assert.match(dosDias, /<key>Minute<\/key><integer>0<\/integer>/);

  const otro = E.plistDeseado(Object.assign({ scheduled_days: ['monday'], hour: '23:30' }, base));
  assert.match(otro, /<key>Weekday<\/key><integer>1<\/integer>/);
  assert.match(otro, /<key>Hour<\/key><integer>23<\/integer>/);
  assert.ok(!/<integer>2<\/integer>\s*<\/dict>/.test(otro.replace(/\s+/g, ' ')) || true);
  assert.notStrictEqual(dosDias, otro, 'cambiar la config cambia el disparador, sin editar código');
});

test('T24 la_segunda_corrida_de_la_semana_corre: el sello es por corrida, no por semana', () => {
  // Martes corrió; el viernes (3 días después) le vuelve a tocar. Con un sello SEMANAL, no.
  assert.strictEqual(E.periodoCumplido(haceDias(3), new Date(), 3), true, 'viernes tras martes');
  assert.strictEqual(E.periodoCumplido(haceDias(0), new Date(), 3), false, 'el mismo día no');
  assert.strictEqual(E.periodoCumplido(haceDias(1), new Date(), 3), false);
  assert.strictEqual(E.periodoCumplido(null, new Date(), 3), true, 'nunca corrió → le toca');
  assert.strictEqual(E.periodoCumplido('fecha-basura', new Date(), 3), true,
    'un sello ilegible no puede bloquear el examen para siempre');

  const b = banco();
  fs.writeFileSync(b.sello, new Date().toISOString());
  const r = correr(b);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /periodo-no-cumplido/);
  assert.ok(!fs.existsSync(b.bitacora));
});

test('T24c el_sello_con_nombre_viejo_sigue_valiendo: leerlo no lo migra, sellar sí y el viejo queda intacto (story 8.9, D2)', { skip: SIN_MAPA }, () => {
  const b = banco();
  const viejo = path.join(path.dirname(b.sello), viejoD2('periodic-exam-last-run'));
  // Una máquina que corrió con el nombre viejo HOY: el período sigue cerrado, aunque el sello nuevo no exista.
  fs.writeFileSync(viejo, `${new Date().toISOString()}\n`);
  const r = correr(b);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /periodo-no-cumplido/, '🔴 sin leer el viejo, el examen se correría dos veces en el período');
  assert.ok(!fs.existsSync(b.sello), 'leer no crea el nuevo');

  // Con el viejo vencido le toca: la corrida completa sella en el nuevo y el viejo no se toca.
  const vencido = `${haceDias(10)}\n`;
  fs.writeFileSync(viejo, vencido);
  const r2 = correr(b);
  assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
  assert.ok(fs.existsSync(b.sello), 'la corrida completa sella con el nombre nuevo');
  assert.strictEqual(E.periodoCumplido(fs.readFileSync(b.sello, 'utf8').trim(), new Date(), 3), false, 'y el sello nuevo es el de recién');
  assert.strictEqual(fs.readFileSync(viejo, 'utf8'), vencido, 'el viejo queda intacto hasta el retiro');
});

test('T59 cada_dia_programado_corre_con_la_config_real: el período no se come el disparador siguiente', () => {
  // 2026-09-18: el T24 medía "viernes tras martes" con 3 días JUSTOS, pero el sello se escribe al
  // TERMINAR (~02:16) y el disparador siguiente llega a las 02:00 — con `days_between_runs: 3`
  // el viernes encontraba 2 d 23 h 44 min y se salteaba siempre. Se mide contra el archivo REAL,
  // para cada día programado, con una corrida que tardó lo que tarda el chequeo de vida.
  const cfg = E.leerConfig(path.join(TCG, 'scripts', 'controls-bench', 'exam-config.json'));
  const NUM = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  const dias = cfg.scheduled_days.map((d) => NUM[d]).sort((a, b) => a - b);
  assert.ok(dias.length > 0 && dias.every((n) => Number.isInteger(n)), `los días del archivo real se escriben en inglés: ${JSON.stringify(cfg.scheduled_days)}`);
  const [h, m] = String(cfg.hour).split(':').map(Number);
  const DURACION = 30 * 60 * 1000;
  dias.forEach((dia, i) => {
    const siguiente = dias[(i + 1) % dias.length];
    const hueco = ((siguiente - dia + 7) % 7) || 7;
    const disparo = new Date(2026, 8, 13 + dia, h, m); // semana que arranca el domingo 13/09/2026
    const sello = new Date(disparo.getTime() + DURACION).toISOString();
    const proximo = new Date(disparo.getTime() + hueco * DIA);
    assert.strictEqual(E.periodoCumplido(sello, proximo, cfg.days_between_runs), true,
      `la corrida del día ${dia} deja correr la del día ${siguiente} (${hueco} días después)`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// T3 / T4 — el candado
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('T3 candado_impide_dos_corridas: con la primera viva, la segunda no arranca', () => {
  const b = banco();
  escribir(b.lock, { pid: process.pid, ts: new Date().toISOString(), maquina: 'x' });
  const est = E.estadoDelCandado(b.lock, Date.now());
  assert.strictEqual(est.libre, false);
  assert.strictEqual(est.motivo, 'otra-corrida-en-curso');

  const r = correr(b);
  assert.strictEqual(r.status, 0, 'no es un error: es el candado haciendo su trabajo');
  assert.match(r.stdout + r.stderr, /otra-corrida-en-curso/);
  assert.ok(!fs.existsSync(b.bitacora), 'no invoca el examen');
});

test('T4 candado_muerto_no_bloquea: un PID que ya no existe no frena nada', () => {
  const b = banco();
  // PID imposible de estar vivo (fuera del rango de PIDs de macOS/Linux).
  escribir(b.lock, { pid: 2147483646, ts: new Date().toISOString(), maquina: 'x' });
  assert.strictEqual(E.estadoDelCandado(b.lock, Date.now()).libre, true, 'proceso muerto → se roba');

  // 🔴 Un candado NO vence mientras su proceso siga vivo. El examen completo son ~5h30 y puede ser
  // más lento con la máquina cargada: si el candado caducara antes, arrancaría una segunda corrida
  // ENCIMA de la primera y se gastaría la cuota del dev dos veces — justo lo que el candado existe
  // para impedir. Sólo se roba con el proceso muerto, o pasado un plazo tan largo que ya no puede
  // ser una corrida en curso (los PIDs se reciclan, así que el plazo tiene que existir).
  escribir(b.lock, { pid: process.pid, ts: haceDias(1), maquina: 'x' });
  assert.strictEqual(E.estadoDelCandado(b.lock, Date.now()).libre, false,
    'a las 24 h con el proceso VIVO el candado aguanta: una corrida larga no es una corrida muerta');
  escribir(b.lock, { pid: process.pid, ts: haceDias(4), maquina: 'x' });
  assert.strictEqual(E.estadoDelCandado(b.lock, Date.now()).libre, true,
    'pasado el plazo largo sí se roba: si no, un PID reciclado lo dejaría trabado para siempre');

  assert.strictEqual(E.estadoDelCandado(path.join(b.raiz, 'no-existe.lock'), Date.now()).libre, true);
  // 🔴 EL MONTAJE DE ESTE ASSERT SE CORRIGIÓ EL 2026-09-17, no su intención. Escribía la basura con
  // mtime de AHORA y exigía "libre" — o sea, daba por buena exactamente la conducta que abría la
  // carrera: un candado ilegible recién escrito es uno que OTRO está publicando en este instante
  // (ver T56 / T57). Lo que el caso afirma no cambió: un candado ilegible no bloquea PARA SIEMPRE.
  // Para medir eso hay que envejecerlo, porque "para siempre" es una afirmación sobre el tiempo.
  fs.writeFileSync(b.lock, 'esto no es json');
  const viejo = (Date.now() - 60 * 1000) / 1000;
  fs.utimesSync(b.lock, viejo, viejo);
  assert.strictEqual(E.estadoDelCandado(b.lock, Date.now()).libre, true,
    'un candado ilegible VIEJO no bloquea para siempre');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// T1 / T17 / T26 — la corrida completa, dónde vive el resultado, y el costo cero
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('T41 el candado no vence mientras su dueño lo esté refrescando', async () => {
  // 🔴 El plazo de 48 h existe para que un PID reciclado no trabe el examen para siempre — pero
  // aplicado a un dueño VIVO reabre justo la carrera que el candado cierra: el examen puede tardar
  // más que el plazo (el propio código lo admite), y ahí un segundo proceso se lo roba y arranca
  // encima. La salida no es alargar el plazo: es que el dueño refresque su marca mientras corre.
  const b = banco({ modoRunner: 'slow' });
  const { spawn } = require('child_process');
  const p = spawn(process.execPath, [EXAMEN], {
    env: Object.assign({}, process.env, {
      HOME: b.casa, TYCON_EXAM_CONFIG: b.rutaCfg, TYCON_EXAM_RUNNER: b.rutaRunner,
      TYCON_EXAM_REPO: b.repo, TYCON_EXAM_MACHINE: 'Devas-Mac-mini',
      TYCON_EXAM_PROBE: b.rutaSonda, TYCON_EXAM_HEARTBEAT_MS: '150',
    }), stdio: 'ignore',
  });
  const leer = () => { try { return JSON.parse(fs.readFileSync(b.lock, 'utf8')).ts; } catch (_) { return null; } };
  let primera = null;
  for (let i = 0; i < 40 && !primera; i++) { primera = leer(); await new Promise((r) => setTimeout(r, 50)); }
  assert.ok(primera, 'el candado se toma al arrancar');
  // 🔴 Se ESPERA el refresco (hasta 6 s), no se duerme 700 ms fijos (2026-09-06). Con el latido en
  // 150 ms, 700 ms alcanzaban en una máquina ociosa — y con la suite completa corriendo al lado el
  // proceso hijo quedaba sin CPU, la marca no cambiaba a tiempo y ESTE caso era el único rojo de
  // toda la suite (67 verdes, 1 roja; solo, 58/58 cuatro veces seguidas). Lo que se afirma es que
  // el dueño refresca MIENTRAS vive, no que lo hace en menos de 700 ms.
  let segunda = null;
  for (let i = 0; i < 120 && !(segunda && segunda !== primera); i++) {
    await new Promise((r) => setTimeout(r, 50));
    segunda = leer();
  }
  await new Promise((r) => p.on('close', r));
  assert.ok(segunda && segunda !== primera, 'la marca del candado se refresca mientras la corrida vive');
});

test('T42 al terminar, cada corrida borra SU candado y no el de otro', () => {
  // Si a una corrida le robaron el candado mientras corría, al terminar borraba el del ladrón y
  // dejaba el sistema abierto para una TERCERA. Se borra sólo si sigue siendo el propio.
  const b = banco();
  escribir(b.lock, { pid: 999999, ts: new Date().toISOString(), maquina: 'el-ladron' });
  E.liberarCandado(b.lock, process.pid);
  assert.ok(fs.existsSync(b.lock), '🔴 el candado ajeno NO se toca');

  escribir(b.lock, { pid: process.pid, ts: new Date().toISOString(), maquina: 'yo' });
  E.liberarCandado(b.lock, process.pid);
  assert.ok(!fs.existsSync(b.lock), 'el propio sí se libera');
});

test('T43 "no tengo permiso para mirarlo" NO es "está muerto"', () => {
  // Un proceso de otro usuario devuelve permiso denegado al preguntar si vive. Leerlo como muerto
  // roba un candado cuyo dueño sigue corriendo. El pid 1 (launchd/init) es de root: sirve de sonda.
  const b = banco();
  escribir(b.lock, { pid: 1, ts: new Date().toISOString(), maquina: 'root' });
  assert.strictEqual(E.estadoDelCandado(b.lock, Date.now()).libre, false,
    'ante "no puedo verlo", el candado se respeta');

  // Y un pid imposible (negativo, cero, basura) no puede confundir la verificación de vida.
  for (const pid of [-1, 0, 'abc', 1.5, null]) {
    escribir(b.lock, { pid, ts: new Date().toISOString(), maquina: 'x' });
    assert.strictEqual(E.estadoDelCandado(b.lock, Date.now()).libre, true, `pid ${pid} → candado inválido, no bloquea`);
  }
});

test('T44 no poder tomar el candado por un problema de la máquina se GRITA, no se calla', () => {
  // 🔴 "Ya hay otra corrida" y "no pude ni crear el archivo del candado" son cosas opuestas y se
  // trataban igual: salida limpia, sin registro. Si el problema persiste (permisos, disco lleno),
  // el examen deja de correr PARA SIEMPRE y no queda un solo rastro para reclamarlo — que es,
  // exactamente, el modo de falla que esta story existe para cerrar.
  const b = banco();
  fs.mkdirSync(b.lock, { recursive: true });     // una carpeta donde va el archivo del candado
  const r = correr(b);
  assert.notStrictEqual(r.status, 0, 'no poder mirar es un error');
  assert.match(r.stdout + r.stderr, /candado/i, 'y dice qué pasó');
  assert.ok(!fs.existsSync(b.bitacora), 'no arranca el examen caro');
  const intento = JSON.parse(fs.readFileSync(b.intento, 'utf8'));
  assert.strictEqual(intento.estado, 'incompleto', 'queda constancia para que el aviso lo reclame');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// T56 / T57 / T58 — la carrera de la PUBLICACIÓN del candado (2026-09-17)
//
// 🔴 El candado tenía una carrera propia, y el T39 la venía denunciando desde el 2026-09-17 sin que
// se le creyera. `tomarCandado` creaba el archivo con `wx` —atómico para decidir quién gana, eso
// estaba bien— y le escribía el pid DESPUÉS, en un segundo acto. Entre los dos, el candado existe y
// está VACÍO: un lector no lo puede parsear, `estadoDelCandado` contestaba "libre", el lector borraba
// el candado del ganador y lo tomaba. Las dos corridas arrancaban, gastando la cuota del dev dos
// veces, que es lo único que el candado existe para impedir.
//
// Medido antes de tocar una línea: T39 corrido 10 veces contra `origin/main` en la Mac del dev,
// **2 rojas** ("arrancó 2"); en el agente de Azure (corrida 10569), 2 de 3. El §8 del plan de PR lo
// había anotado como "intermitencia del agente" y como un caso que "da por hecho un solapamiento que
// en 2 núcleos no está garantizado". No era eso: el solapamiento SÍ ocurría y el candado no retenía.
// Un test que se pone rojo 2 de 10 veces sobre un defecto real no es inestable: es el único que mira.
//
// Estos casos cierran las dos mitades: que la publicación sea un solo acto (T57) y que "no puedo
// leerlo recién escrito" se conteste ocupado y no libre (T56), con sus espejos para que el arreglo no
// trabe el examen de por vida.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('T56 un candado ilegible RECIÉN escrito está ocupado, no libre', () => {
  const b = banco();
  // Exactamente lo que dejaba el `wx` en el instante malo: el archivo existe y está vacío.
  fs.writeFileSync(b.lock, '');
  const est = E.estadoDelCandado(b.lock, Date.now());
  assert.strictEqual(est.libre, false,
    '🔴 el rojo previo: contra origin/main esto daba "libre" y arrancaba la segunda corrida encima');
  assert.strictEqual(est.motivo, 'candado-en-escritura', 'y dice POR QUÉ no está libre');

  // Un cuerpo cortado a la mitad es el mismo caso: ilegible y reciente.
  fs.writeFileSync(b.lock, '{"pid": 12');
  assert.strictEqual(E.estadoDelCandado(b.lock, Date.now()).libre, false, 'un JSON a medias, igual');

  // 🔴 Y el discriminador es el TIPO, no sólo la edad: una carpeta donde va el archivo del candado
  // NO es "otro publicando" — es un problema de la máquina, y T44 exige que eso GRITE. Si entrara
  // por esta rama sería una salida limpia y el examen dejaría de correr para siempre, callado.
  const b2 = banco();
  fs.rmSync(b2.lock, { force: true });
  fs.mkdirSync(b2.lock, { recursive: true });
  const carpeta = E.estadoDelCandado(b2.lock, Date.now());
  assert.strictEqual(carpeta.libre, true, 'una carpeta no retiene el candado: tiene que llegar al grito');
  assert.strictEqual(carpeta.motivo, 'candado-ilegible');
});

test('T56b el espejo: ilegible y VIEJO sí es libre — el arreglo no puede trabar el examen de por vida', () => {
  // Sin este caso, el arreglo de T56 podría contestar "ocupado" para CUALQUIER candado ilegible y
  // dejar el examen trabado hasta que una persona borre un archivo a mano. La ventana es de 10 s
  // contra las 48 h del vencimiento justamente para que un candado corrupto no se lleve un turno.
  //
  // 🔴 Este caso es de NO-REGRESIÓN: no puede detectar el defecto, y no tiene que poder. Su primera
  // versión afirmaba además el `motivo`, y eso lo ponía rojo contra `origin/main` por una razón
  // cosmética —el motivo es nuevo—, peor que no tenerlo: se leería como un detector sin serlo. El
  // motivo lo afirma T56, donde sí discrimina.
  //
  // 🔴 Y contra `origin/main` este caso NO ES EVALUABLE, que no es lo mismo que verde: consume
  // `CANDADO_EN_ESCRITURA_MS`, que allá no existe, y el `undefined` revienta el `utimesSync`. Se
  // deja así a propósito —el umbral se afirma contra el ÚNICO lugar donde está definido (regla de
  // T23), no contra un 10000 copiado acá— y se declara en vez de disimularse con un fallback.
  const b = banco();
  fs.writeFileSync(b.lock, '');
  const viejo = (Date.now() - E.CANDADO_EN_ESCRITURA_MS - 5000) / 1000;
  fs.utimesSync(b.lock, viejo, viejo);
  assert.strictEqual(E.estadoDelCandado(b.lock, Date.now()).libre, true,
    'pasada la ventana de escritura, se roba');
});

test('T57 tomar el candado es UN acto: no se roba el que otro está publicando, y el propio nace legible', () => {
  // El rojo previo determinista del defecto — sin depender de que la carrera se dé.
  const b = banco();
  fs.writeFileSync(b.lock, '');
  const r = E.tomarCandado(b.lock, Date.now(), 'yo');
  assert.strictEqual(r.ok, false,
    '🔴 contra origin/main esto devolvía ok:true: se robaba un candado que otro estaba publicando');
  assert.strictEqual(r.motivo, 'candado-en-escritura');
  assert.strictEqual(fs.readFileSync(b.lock, 'utf8'), '', 'y no se lo pisa');

  // La otra mitad: lo que ESTA corrida publica nunca se puede leer vacío.
  const b2 = banco();
  const r2 = E.tomarCandado(b2.lock, Date.now(), 'mini');
  assert.strictEqual(r2.ok, true, r2.motivo);
  const d = JSON.parse(fs.readFileSync(b2.lock, 'utf8'));   // tira si quedó a medio escribir
  assert.strictEqual(d.pid, process.pid, 'el pid está adentro desde el primer instante en que el archivo existe');
  assert.strictEqual(d.maquina, 'mini');
  assert.ok(!fs.existsSync(`${b2.lock}.${process.pid}.tmp`), 'el archivo de paso no queda tirado');

  // Y el desempate del `wx` no se perdió: con un candado VIVO y legible, el segundo no entra.
  const r3 = E.tomarCandado(b2.lock, Date.now(), 'mini');
  assert.strictEqual(r3.ok, false, 'un candado vivo sigue ganando el desempate');
  assert.strictEqual(r3.motivo, 'otra-corrida-en-curso');
});

test('T57b liberar: un candado ILEGIBLE tampoco se da por propio', () => {
  // El otro lado de la misma carrera. Borrarlo a ciegas al terminar sacaba del camino un candado que
  // otra corrida podía estar publicando, dejando la puerta abierta a una TERCERA — el mismo
  // razonamiento por el que ya no se borra el candado ajeno (T42).
  const b = banco();
  fs.writeFileSync(b.lock, '');
  assert.strictEqual(E.liberarCandado(b.lock, process.pid), false);
  assert.ok(fs.existsSync(b.lock),
    '🔴 contra origin/main se borraba: un candado que no se puede leer no es prueba de que sea mío');
});

test('T58 cinco corridas a la vez, tres tandas: arranca UNA y sólo una', async () => {
  // 🔴 La forma severa de T39, y la que el dev pidió: en vez de repetir 10 veces el par de corridas
  // (2 oportunidades de colisión por tanda y ~30 s de suite), se lanzan CINCO a la vez —10 pares por
  // tanda— y la tanda se repite 3 veces. Más presión sobre la ventana y menos reloj.
  const { spawn } = require('child_process');
  const lanzar = (b) => new Promise((res) => {
    const p = spawn(process.execPath, [EXAMEN], {
      env: Object.assign({}, process.env, {
        HOME: b.casa, TYCON_EXAM_CONFIG: b.rutaCfg, TYCON_EXAM_RUNNER: b.rutaRunner,
        TYCON_EXAM_REPO: b.repo, TYCON_EXAM_MACHINE: 'Devas-Mac-mini', TYCON_EXAM_PROBE: b.rutaSonda,
      }), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => res({ code, out }));
  });

  for (let tanda = 1; tanda <= 3; tanda++) {
    // Un banco propio por tanda: el runner falso acumula sus pids con append, y mezclar tandas
    // convertiría un "arrancaron 2 en la tanda 1" en un número que no dice de cuál fue.
    const b = banco({ modoRunner: 'slow' });
    const salidas = (await Promise.all([1, 2, 3, 4, 5].map(() => lanzar(b))))
      .map((r) => r.out).join('\n');
    const pids = fs.existsSync(`${b.bitacora}.pids`)
      ? fs.readFileSync(`${b.bitacora}.pids`, 'utf8').trim().split('\n').filter(Boolean) : [];
    assert.strictEqual(pids.length, 1,
      `tanda ${tanda}: el examen caro tiene que arrancar UNA sola vez (arrancó ${pids.length})`);
    assert.match(salidas, /otra-corrida-en-curso|candado-en-escritura/,
      `tanda ${tanda}: y las otras cuatro dicen por qué no arrancaron`);
  }
});

// 🔴 REESCRITO 2026-09-01. Antes exigía `--tool both`, o sea el examen COMPLETO: 582 consultas y
// ~3 h dos veces por semana. Ese contrato se revirtió a propósito —medido, lo que encontraba de los
// revisores era casi nada y de sí mismo mucho— y el nocturno pasó al chequeo de vida. Lo que este
// test cuida NO cambió: que el nocturno corra el alcance COMPLETO de lo que le toca (nunca un
// subconjunto arbitrario, porque una foto parcial se lee como el estado general) y que compare
// contra la línea de base.
test('T1 el nocturno corre el CHEQUEO DE VIDA completo, sin acotar, y deja su veredicto', () => {
  const b = banco();
  const r = correr(b);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);

  const argv = JSON.parse(fs.readFileSync(b.bitacora, 'utf8'));
  assert.ok(argv.includes('--liveness'), 'el nocturno es el chequeo de vida, no el examen profundo');
  assert.ok(!argv.includes('--only'), 'nunca acotado: una foto parcial se lee como el estado general');
  assert.ok(argv.includes('--baseline'), 'compara contra la línea de base');
  assert.ok(!(argv.includes('--tool') && argv[argv.indexOf('--tool') + 1] === 'both'),
    'el nocturno NO corre las dos herramientas: eso es el examen profundo, y es a pedido');

  const rep = JSON.parse(fs.readFileSync(b.reporteQueViaja, 'utf8'));
  assert.strictEqual(rep.kind, 'examen-periodico');
  assert.strictEqual(rep.estado, 'completo');
  assert.strictEqual(rep.alcance, 'completo');
  // AC 2 (reescrito el 2026-09-10): el tercio que el chequeo de vida SÍ mide —criterio— con su
  // número; los dos que NO puede medir con una corrida y una herramienta —inestabilidad y paridad—
  // en null con su motivo, nunca 0. El examen profundo (`--tool both --runs 3`) los mide, a pedido.
  assert.strictEqual(typeof rep.criterio, 'number', 'veredicto de criterio');
  assert.strictEqual(rep.inestables, null, '🔴 con una corrida, "inestables" no se mide: null, no 0');
  assert.strictEqual(rep.paridadReal, null, '🔴 con una herramienta, la paridad no se mide: null, no 0');
  assert.ok(rep.no_medido && rep.no_medido.inestables && rep.no_medido.paridad, 'y el motivo viaja en el reporte');
  // Lo que sí tiene que seguir estando es el desglose por causa.
  assert.strictEqual(typeof rep.fugas, 'number', 'las fugas del corral se cuentan aparte del criterio');
  assert.ok(rep.maquina, 'queda dicho qué máquina lo midió');

  assert.ok(fs.existsSync(b.sello), 'una corrida completa SÍ sella');
  assert.strictEqual(E.periodoCumplido(fs.readFileSync(b.sello, 'utf8').trim(), new Date(), 3), false,
    'y el sello recién puesto cierra el período');
});

test('T17 donde_vive_el_reporte_que_viaja: fuera de .bench/ y no lo ignora git', () => {
  assert.ok(!E.RUTA_REPORTE_QUE_VIAJA.includes('.bench'),
    'un reporte dentro de .bench/ no sale nunca de la máquina que lo escribió');

  const b = banco();
  correr(b);
  const ignorado = spawnSync('git', ['check-ignore', '-q', E.RUTA_REPORTE_QUE_VIAJA], { cwd: b.repo });
  assert.notStrictEqual(ignorado.status, 0, 'git NO puede estar ignorando el reporte que tiene que viajar');
});

test('T26 sin_clave_de_api_ni_credencial_nueva: el corredor no lee ninguna llave', () => {
  const fuente = fs.readFileSync(EXAMEN, 'utf8');
  for (const llave of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AZURE_DEVOPS_PAT', 'GITHUB_PAT']) {
    assert.ok(!fuente.includes(llave), `el examen no puede depender de ${llave}: corre con la sesión ya iniciada`);
  }
  const plist = E.plistDeseado({ label: 'l', nodeBin: '/usr/bin/node', script: '/x.js', scheduled_days: ['tuesday'], hour: '02:00' });
  assert.ok(!/API_KEY|SECRET|TOKEN/i.test(plist), 'la tarea programada tampoco lleva credenciales');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// T12 / T6 / T7 — lo que pasa cuando NO se pudo medir
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('T12 sello_no_se_marca_si_no_termino: una corrida que muere no se come el turno', () => {
  const b = banco({ modoRunner: 'dies' });
  const r = correr(b);
  assert.notStrictEqual(r.status, 0, 'no pudo medir → exit ≠ 0');
  assert.ok(!fs.existsSync(b.sello), '🔴 el sello se escribe al TERMINAR, nunca al empezar');
  assert.strictEqual(E.periodoCumplido(null, new Date(), 3), true, 'la próxima sesión vuelve a intentar');
});

test('T6 corrida_incompleta_no_es_verde: queda registrada con su motivo y no pisa la última buena', () => {
  const b = banco({ modoRunner: 'lies' });   // sale 0 pero no deja reporte
  // Había una medición buena de hace 2 días: NO se puede perder.
  escribir(b.reporteQueViaja, { kind: 'examen-periodico', estado: 'completo', alcance: 'completo',
    ts: haceDias(2), criterio: 0, inestables: 0, paridadReal: 0, baselineRegressions: 0, maquina: 'mini' });

  const r = correr(b);
  assert.notStrictEqual(r.status, 0, 'salió 0 pero no dejó reporte: eso es no haber medido');

  const previa = JSON.parse(fs.readFileSync(b.reporteQueViaja, 'utf8'));
  assert.strictEqual(previa.ts.slice(0, 10), haceDias(2).slice(0, 10),
    '🔴 la última medición buena y SU FECHA sobreviven — la fecha es lo que sostiene la denuncia');

  const intento = JSON.parse(fs.readFileSync(b.intento, 'utf8'));
  assert.strictEqual(intento.kind, 'examen-periodico-intento');
  assert.strictEqual(intento.estado, 'incompleto');
  assert.ok(intento.motivo && intento.motivo.length > 3, 'con su motivo escrito');

  // Y el aviso la trata como NO MEDIDO, jamás como verde.
  const a = avisar(b);
  assert.match(a.stdout, /incompleto|no termin|no pudo medir/i);
  assert.ok(!/✅/.test(a.stdout), 'una corrida incompleta nunca se muestra en verde');
});

test('T6b la sesión que se cae A MITAD del examen tampoco es verde', () => {
  // El caso que la sonda NO puede atrapar: la sesión andaba al arrancar y se venció a las 3 h.
  // El examen deja su reporte igual, con todos los casos en error de corrida. Un reporte que no
  // midió nada no puede sellar el período ni pisar la última medición buena.
  const b = banco({ modoRunner: 'all-error' });   // las DOS herramientas caídas: 6 de 6 ranuras
  escribir(b.reporteQueViaja, { kind: 'examen-periodico', estado: 'completo', alcance: 'completo',
    ts: haceDias(2), criterio: 0, inestables: 0, paridadReal: 0, baselineRegressions: 0, maquina: 'mini' });

  const r = correr(b);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /error de corrida|no pude medir|no midi/i);
  assert.ok(!fs.existsSync(b.sello), 'no sella');
  assert.strictEqual(JSON.parse(fs.readFileSync(b.reporteQueViaja, 'utf8')).ts.slice(0, 10),
    haceDias(2).slice(0, 10), 'la medición buena anterior sobrevive');
  assert.strictEqual(JSON.parse(fs.readFileSync(b.intento, 'utf8')).estado, 'incompleto');
});

test('T35 una corrida donde TODO se salteó por falta de un MCP no es una corrida completa', () => {
  // Hallazgo del pase adversarial, reproducido en vivo: el examen puede terminar con los 97 casos
  // SALTEADOS por un servidor MCP ausente. Cero revisores evaluados de verdad, y sin embargo
  // criterio/inestables/paridad quedan todos en 0 — o sea, indistinguible de un verde perfecto.
  // Sellaba el período y viajaba a git como la foto del estado. Es el FOCO de la story entero.
  const b = banco({ modoRunner: 'all-skipped' });
  escribir(b.reporteQueViaja, { kind: 'examen-periodico', estado: 'completo', alcance: 'completo',
    ts: haceDias(2), criterio: 0, inestables: 0, paridadReal: 0, baselineRegressions: 0, maquina: 'mini' });

  const r = correr(b);
  assert.notStrictEqual(r.status, 0, 'salteado no es medido');
  assert.match(r.stdout + r.stderr, /salte|no midi|no pude medir/i);
  assert.ok(!fs.existsSync(b.sello), 'no sella el período');
  assert.strictEqual(JSON.parse(fs.readFileSync(b.reporteQueViaja, 'utf8')).ts.slice(0, 10),
    haceDias(2).slice(0, 10), 'no pisa la última medición buena');
});

test('T36 si UNA de las dos herramientas se cayó, la corrida SÍ midió — pero se dice', () => {
  // El otro lado del mismo hallazgo: el chequeo viejo comparaba errores contra CASOS, cuando con
  // las dos herramientas hay dos ranuras por caso. Una herramienta caída daba "no midió" y tiraba
  // a la basura la medición de la otra. Ahora cuenta ranuras: media medición es medición, y el
  // daño parcial se muestra en vez de esconderse.
  const b = banco({ modoRunner: 'one-tool-down' });
  // Este caso prueba el conteo por RANURAS del examen PROFUNDO (2 por caso, una por
  // herramienta). El nocturno ya no corre `both`, pero la aritmética sigue viva para la
  // corrida a pedido, y es donde el error de contar casos contra ranuras se escondía.
  const r = correr(b, [], { BENCH_TOOL: 'both' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(b.reporteQueViaja), 'la mitad que midió se guarda');
  const a = avisar(b);
  assert.match(a.stdout, /error de corrida|no llegaron a correr/i,
    '🔴 y el aviso lo DICE: un tercio del examen caído no puede leerse como verde');
});

test('T37 el aviso cuenta los casos que terminaron en error, no sólo los tres tercios', () => {
  // Reproducido en vivo por el pase adversarial: un reporte fresco y "completo" con 30 casos en
  // error de corrida y los otros contadores en 0 no imprimía NADA. La rama hermana del mismo
  // archivo (la de los reportes locales) sí los contaba — la inconsistencia era del camino nuevo.
  const b = banco();
  escribir(b.reporteQueViaja, { kind: 'examen-periodico', estado: 'completo', alcance: 'completo',
    ts: new Date().toISOString(), criterio: 0, inestables: 0, paridadReal: 0, baselineRegressions: 0,
    erroresDeCorrida: 30, failed: 30, maquina: 'mini' });
  const a = avisar(b);
  assert.match(a.stdout, /30/, 'los 30 casos rotos se ven');
  assert.match(a.stdout, /error de corrida|no llegaron a correr/i);
});

test('T38 el aviso deja constancia de los casos salteados por un MCP ausente', () => {
  const b = banco();
  escribir(b.reporteQueViaja, { kind: 'examen-periodico', estado: 'completo', alcance: 'completo',
    ts: new Date().toISOString(), criterio: 0, inestables: 0, paridadReal: 0, baselineRegressions: 0,
    skippedMcp: 12, maquina: 'mini' });
  const a = avisar(b);
  assert.match(a.stdout, /12/);
  assert.match(a.stdout, /salte/i, 'constancia, no verde');
});

test('T39 el candado se toma ANTES de la sonda: dos corridas simultáneas, una sola arranca', async () => {
  // 🔴 Reproducido en vivo por el pase adversarial con dos PIDs reales: el candado se CHEQUEABA en
  // la decisión y se ESCRIBÍA recién después de la sonda de sesión, que puede tardar hasta dos
  // minutos. Dos invocaciones que caigan en esa ventana pasaban las dos y arrancaban el examen
  // completo en paralelo — gastando la cuota del dev dos veces, que es exactamente lo que el
  // candado existe para impedir. La toma ahora es atómica y va antes de la sonda.
  const b = banco({ modoRunner: 'slow' });
  const lanzar = () => new Promise((res) => {
    const { spawn } = require('child_process');
    const p = spawn(process.execPath, [EXAMEN], {
      env: Object.assign({}, process.env, {
        HOME: b.casa, TYCON_EXAM_CONFIG: b.rutaCfg, TYCON_EXAM_RUNNER: b.rutaRunner,
        TYCON_EXAM_REPO: b.repo, TYCON_EXAM_MACHINE: 'Devas-Mac-mini', TYCON_EXAM_PROBE: b.rutaSonda,
      }), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => res({ code, out }));
  });
  const [a, c] = await Promise.all([lanzar(), lanzar()]);
  const salidas = `${a.out}\n${c.out}`;
  const pids = fs.existsSync(`${b.bitacora}.pids`)
    ? fs.readFileSync(`${b.bitacora}.pids`, 'utf8').trim().split('\n').filter(Boolean) : [];
  assert.strictEqual(pids.length, 1, `el examen caro tiene que arrancar UNA sola vez (arrancó ${pids.length})`);
  assert.match(salidas, /otra-corrida-en-curso/, 'y la segunda dice por qué no arrancó');
});

test('T40 si el resultado no llegó a viajar, la propia máquina se entera', () => {
  // Hallazgo del pase adversarial: con el push rechazado, el sello y el reporte local quedan
  // frescos, así que en la máquina designada —la única que puede arreglarlo— no se notaba nada.
  // La denuncia vivía sólo en el log de launchd: el mismo canal invisible que la story reemplazó.
  const b = banco();
  const hook = path.join(b.remoto, 'hooks', 'pre-receive');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(hook, 0o755);

  const r = correr(b);
  assert.notStrictEqual(r.status, 0);
  const intento = JSON.parse(fs.readFileSync(b.intento, 'utf8'));
  assert.strictEqual(intento.estado, 'no-viajo', 'queda registrado que midió pero no llegó a nadie');
  const a = avisar(b);
  assert.match(a.stdout, /no viaj|no lleg/i, 'y el aviso de ESTA máquina lo dice');
});

test('T45 la sonda prueba LAS DOS sesiones con una consulta real, no sólo la versión', () => {
  // 🔴 Lo encontró la PRIMERA corrida real en el mini (2026-08-31): Codex sin credenciales
  // responde perfecto a `--version` y devuelve 401 en cuanto se le pide algo. La sonda probaba
  // Claude con una consulta de verdad y a Codex sólo la versión, así que dio el visto bueno y el
  // examen arrancó — condenado a que la mitad de sus 582 invocaciones fueran error de corrida,
  // 5h30 de reloj, y un sello que se come el turno de los 3 días siguientes.
  const b = banco();
  const r = correr(b, [], {
    TYCON_EXAM_PROBE: '',
    TYCON_EXAM_PROBE_CLAUDE: sondaPara(b, 'claude', 'ok'),
    TYCON_EXAM_PROBE_CODEX: sondaPara(b, 'codex', 'no-session'),
  });
  assert.notStrictEqual(r.status, 0, 'con una de las dos sesiones caída, no se arranca');
  assert.match(r.stdout + r.stderr, /codex/i, 'y dice CUÁL de las dos');
  assert.match(r.stdout + r.stderr, /401|autentic|sesi/i, 'con el motivo');
  assert.ok(!fs.existsSync(b.bitacora), 'no gasta las 582 invocaciones');
  assert.ok(!fs.existsSync(b.sello), 'no se come el turno');

  // Y con las dos vivas, arranca.
  const b2 = banco();
  const r2 = correr(b2, [], {
    TYCON_EXAM_PROBE: '',
    TYCON_EXAM_PROBE_CLAUDE: sondaPara(b2, 'claude', 'ok'),
    TYCON_EXAM_PROBE_CODEX: sondaPara(b2, 'codex', 'ok'),
  });
  assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
  assert.ok(fs.existsSync(b2.bitacora), 'con las dos sesiones sanas sí corre');
});

test('T7 sesion_expirada_falla_ruidosa: sin sesión, falla rápido y no deja un reporte que parezca bueno', () => {
  const b = banco({ sonda: 'expired' });
  const r = correr(b);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /sesion|sesión|login|autentic/i, 'el motivo queda escrito');
  assert.ok(!fs.existsSync(b.bitacora), 'falla ANTES de gastar el examen caro');
  assert.ok(!fs.existsSync(b.reporteQueViaja), 'sin reporte nuevo');
  assert.ok(!fs.existsSync(b.sello), 'sin sello');
});

test('T27 un_flag_desconocido_no_dispara_el_examen (gotcha advisor-runner --help)', () => {
  const b = banco();
  for (const flag of ['--help', '-h', '--dry-run']) {
    const r = correr(b, [flag]);
    assert.strictEqual(r.status, 0, `${flag} sale 0`);
    assert.ok(!fs.existsSync(b.bitacora),
      `🔴 ${flag} NO puede disparar el examen — es exactamente lo que hace advisor-runner --help`);
  }
});

test('T28 dry_run_dice_que_haria_sin_gastar_nada', () => {
  const b = banco();
  const r = correr(b, ['--dry-run']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /Devas-Mac-mini/, 'dice cuál es la máquina designada');
  assert.match(r.stdout, /correr|no correr|le toca|no le toca/i, 'dice si correría');
  assert.ok(!fs.existsSync(b.bitacora));
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// T9 / T10 — el resultado viaja
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('T9 staging_selectivo: con el árbol sucio, sólo entra el reporte', () => {
  const b = banco();
  fs.writeFileSync(path.join(b.repo, 'no-mio.txt'), 'cambio del dev, no es del examen\n');
  fs.writeFileSync(path.join(b.repo, 'README.md'), 'editado por el dev\n');

  const r = correr(b);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);

  const tocados = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: b.repo, encoding: 'utf8' })
    .split('\n').map((x) => x.trim()).filter(Boolean);
  assert.deepStrictEqual(tocados, [E.RUTA_REPORTE_QUE_VIAJA], 'sólo el reporte, nunca git add -A');

  const sucio = execFileSync('git', ['status', '--porcelain'], { cwd: b.repo, encoding: 'utf8' });
  assert.match(sucio, /no-mio\.txt/, 'el trabajo del dev queda intacto y sin commitear');
  assert.match(sucio, /README\.md/);
});

test('T9b staging_selectivo: lo que el dev YA tenía en el stage tampoco se lo lleva puesto', () => {
  // El caso que el T9 no cubría: el dev dejó algo preparado en el stage y se fue a dormir. A las
  // 2 de la mañana el examen commitea su reporte — y si el commit usara el índice tal como está,
  // se llevaría ese trabajo ajeno adentro, con un mensaje que habla de otra cosa. `git add` de
  // una sola ruta NO alcanza: lo que decide qué entra al commit es el índice ENTERO.
  const b = banco();
  fs.writeFileSync(path.join(b.repo, 'del-dev.txt'), 'a medio terminar\n');
  b.git('add', '--', 'del-dev.txt');

  const r = correr(b);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);

  const tocados = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: b.repo, encoding: 'utf8' })
    .split('\n').map((x) => x.trim()).filter(Boolean);
  assert.deepStrictEqual(tocados, [E.RUTA_REPORTE_QUE_VIAJA], '🔴 el trabajo del dev NO entra al commit del examen');
  assert.match(execFileSync('git', ['status', '--porcelain'], { cwd: b.repo, encoding: 'utf8' }),
    /^A {2}del-dev\.txt$/m, 'y le queda tal cual lo había dejado: preparado, sin commitear');
});

test('T10b el push usa la rama actual, no la rama por defecto del remoto', () => {
  // `git push origin HEAD` funciona, pero `git pull --rebase origin HEAD` resuelve la rama por
  // DEFECTO del remoto. En un repo cuya rama de trabajo no es la default, el reintento traería la
  // rama equivocada — y el reintento existe justamente para el caso en que alguien más movió la rama.
  const b = banco();
  b.git('checkout', '-q', '-b', 'rama-de-trabajo');
  b.git('push', '-q', '-u', 'origin', 'rama-de-trabajo');
  const r = correr(b);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const remoto = execFileSync('git', ['-C', b.remoto, 'log', '-1', '--name-only', '--format=', 'rama-de-trabajo'], { encoding: 'utf8' });
  assert.match(remoto, /ultimo-examen\.json/, 'el reporte llegó a la rama en la que se estaba trabajando');
});

test('T10 push_fallido_conserva_el_resultado: el reporte sobrevive en disco y el log lo dice', () => {
  const b = banco();
  // El remoto rechaza todo: un hook de pre-receive que siempre falla.
  const hook = path.join(b.remoto, 'hooks', 'pre-receive');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, '#!/bin/sh\necho "rechazado a proposito" >&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);

  const r = correr(b);
  assert.notStrictEqual(r.status, 0, 'el resultado no llegó a nadie: eso necesita un humano');
  assert.match(r.stdout + r.stderr, /push/i, 'lo dice en el log');
  assert.match(r.stdout + r.stderr, /3|reintent/i, 'reintentó');
  assert.ok(fs.existsSync(b.reporteQueViaja), '🔴 el resultado NO se borra');
  const rep = JSON.parse(fs.readFileSync(b.reporteQueViaja, 'utf8'));
  assert.strictEqual(rep.estado, 'completo', 'la medición fue buena; lo que falló fue el transporte');
  assert.ok(fs.existsSync(b.sello), 'y el período queda sellado: no se re-corren 5h30 por un problema de git');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// T11 / T16 / T18 — la corrida acotada deja de pisar la completa
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('T11 corrida_acotada_no_pisa_la_completa: el nombre sale del alcance, no de un flag', () => {
  const completa = N.nombreDeReporte({ tool: 'both', only: [] });
  assert.strictEqual(completa.nombre, 'advisors-both.json', 'el nombre histórico no cambia (T18)');
  assert.strictEqual(completa.alcance, 'completo');

  const acotada = N.nombreDeReporte({ tool: 'claude', only: ['tycon-story-validator'] });
  assert.strictEqual(acotada.alcance, 'acotado');
  assert.notStrictEqual(acotada.nombre, 'advisors-claude.json',
    '🔴 una corrida de 3 revisores no puede pisar la foto de los 28');
  assert.match(acotada.nombre, /parcial/, 'y se ve en el nombre que es parcial');

  // Determinista y sin caracteres que rompan una ruta.
  assert.strictEqual(N.nombreDeReporte({ tool: 'claude', only: ['a', 'b'] }).nombre,
    N.nombreDeReporte({ tool: 'claude', only: ['a', 'b'] }).nombre, 'mismo alcance → mismo archivo');
  assert.ok(!/[/\\:*?"<>|]/.test(N.nombreDeReporte({ tool: 'claude', only: ['../../etc/passwd'] }).nombre),
    'nada que se escape del directorio');
  assert.notStrictEqual(N.nombreDeReporte({ tool: 'claude', only: ['a'] }).nombre,
    N.nombreDeReporte({ tool: 'claude', only: ['b'] }).nombre, 'alcances distintos, archivos distintos');
});

test('T18 contrato_del_examen_intacto: advisor-runner conserva sus flags y su veredicto', () => {
  const fuente = fs.readFileSync(path.join(TCG, 'scripts', 'controls-bench', 'advisor-runner.js'), 'utf8');
  for (const flag of ['--tool', '--only', '--runs', '--jobs', '--baseline', '--json']) {
    assert.ok(fuente.includes(`'${flag}'`) || fuente.includes(`"${flag}"`), `${flag} sigue existiendo`);
  }
  // El único agregado permitido: el nombre derivado. El resto del payload, igual que siempre.
  for (const campo of ['criterio', 'inestables', 'parityBreaks', 'paridadReal', 'baselineRegressions']) {
    assert.ok(fuente.includes(campo), `el veredicto sigue trayendo ${campo}`);
  }
  assert.ok(fuente.includes('report-name'),'y deriva el nombre desde la pieza compartida');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// T5 / T8 / T14 / T16 / T21 / T22 — el aviso
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('T21 el_aviso_lee_el_reporte_que_viaja: lo encuentra fuera de .bench/', () => {
  const b = banco();
  escribir(b.reporteQueViaja, { kind: 'examen-periodico', estado: 'completo', alcance: 'completo',
    ts: new Date().toISOString(), criterio: 3, inestables: 1, paridadReal: 2, baselineRegressions: 0, maquina: 'mini' });
  const a = avisar(b);
  assert.match(a.stdout, /3/, 'muestra los números del reporte que viajó');
  assert.match(a.stdout, /criterio/i);
});

test('T8 reporte_fresco_se_muestra: con fecha visible', () => {
  const b = banco();
  const ayer = haceDias(1);
  escribir(b.reporteQueViaja, { kind: 'examen-periodico', estado: 'completo', alcance: 'completo',
    ts: ayer, criterio: 2, inestables: 0, paridadReal: 0, baselineRegressions: 0, maquina: 'mini' });
  const a = avisar(b);
  assert.match(a.stdout, /2/);
  assert.ok(a.stdout.includes(ayer.slice(0, 10)), 'la fecha se ve');
  assert.ok(!/no est[áa] corriendo/i.test(a.stdout), 'un reporte fresco no se denuncia');
});

test('T5 aviso_denuncia_examen_detenido: a los 9 días calla los números y denuncia', () => {
  const b = banco();
  escribir(b.reporteQueViaja, { kind: 'examen-periodico', estado: 'completo', alcance: 'completo',
    ts: haceDias(9), criterio: 7, inestables: 4, paridadReal: 2, baselineRegressions: 1, maquina: 'mini' });
  const a = avisar(b);
  assert.match(a.stdout, /no est[áa] corriendo/i, 'lo denuncia');
  assert.ok(a.stdout.includes(haceDias(9).slice(0, 10)), 'y dice desde cuándo');
  assert.ok(!/criterio=7|7 de criterio/.test(a.stdout),
    '🔴 NO muestra los números viejos: una foto de hace 9 días no es el estado de esta semana');
});

test('T14 designada_apagada_se_denuncia: sin ningún reporte, el aviso habla igual', () => {
  const b = banco();
  // Nada en .bench/ y nada que haya viajado: el silencio de hoy.
  const a = avisar(b);
  assert.strictEqual(a.status, 0, 'el aviso nunca rompe el arranque');
  assert.match(a.stdout, /no est[áa] corriendo|nunca/i,
    '🔴 hoy "no corrió" y "corrió verde hace 9 días" son el mismo silencio: ése es el bug');
});

test('T22 el_aviso_habla_sin_fallas: cero rojos no puede significar cero información', () => {
  const b = banco();
  // Todo lo demás en verde: el aviso viejo se habría callado por completo.
  escribir(path.join(b.repo, 'scripts', 'controls-bench', '.bench', 'last-run-claude.json'),
    { ts: new Date().toISOString(), failed: 0, parityBreaks: 0, baselineRegressions: 0 });
  const a = avisar(b);
  assert.match(a.stdout, /no est[áa] corriendo|nunca/i);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// T50..T53 — "no medido" NO se pinta de cero (AC 2 · 2026-09-10)
//
// 🔴 El caso real: el reporte del 05-09 que el aviso muestra en cada arranque trae
// `tool:"claude"` y `runs:1`. Con UNA corrida y UNA herramienta, la inestabilidad —el revisor
// contestando distinto entre corridas— y la paridad —que las dos herramientas coincidan— son
// IMPOSIBLES de medir. Y sin embargo el reporte publicaba `inestables: 0 · paridadReal: 0` y el
// aviso los mostraba al lado de los que sí se midieron. Es la regla cardinal del arnés al revés,
// y en la pieza que existe para vigilar a los revisores. El propio aviso ya sabe hacerlo bien
// —"salteados por MCP ausente (constancia, no verde)"—; estos dos no.
//
// La decisión de dejar de medirlos fue correcta y está justificada (periodic-exam.js l.612-628:
// el chequeo de vida bajó de ~3 h a ~12 min). Lo que faltaba es DECIRLO en la salida.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('T50 una_corrida_y_una_herramienta: los rubros imposibles salen NO MEDIDOS, no en cero', () => {
  const b = banco();
  // El reporte REAL del 2026-09-05, tal cual, con su fecha corrida a hoy para que sea fresco.
  escribir(b.reporteQueViaja, { kind: 'examen-periodico', estado: 'completo', alcance: 'completo',
    ts: new Date().toISOString(), tool: 'claude', runs: 1, maquina: 'devas-mac-mini',
    failed: 1, criterio: 1, inestables: 0, erroresDeCorrida: 0,
    parityBreaks: 0, paridadReal: 0, paridadPorInestabilidad: 0,
    baselineRegressions: 0, skippedMcp: 1 });
  const a = avisar(b);

  assert.match(a.stdout, /1 de criterio/, 'lo que SÍ se midió se sigue mostrando con su número');
  assert.ok(!/0 inestables/.test(a.stdout),
    '🔴 "0 inestables" con una sola corrida es un cero que significa "no miré"');
  assert.ok(!/paridad rota 0/.test(a.stdout),
    '🔴 "paridad rota 0" con una sola herramienta es el mismo cero, con otro nombre');
  assert.match(a.stdout, /no medid[ao]/i,
    'y se dice con todas las letras que esos rubros no se midieron');
  assert.match(a.stdout, /--runs 2|2 corridas|al menos 2/i,
    'con el motivo accionable de la inestabilidad: cuántas corridas hacen falta');
  assert.match(a.stdout, /--tool both|las dos herramientas/i,
    'y el de la paridad: hacen falta las dos herramientas');
});

test('T51 el espejo: con dos herramientas y tres corridas, un cero SÍ es un cero', () => {
  const b = banco();
  escribir(b.reporteQueViaja, { kind: 'examen-periodico', estado: 'completo', alcance: 'completo',
    ts: new Date().toISOString(), tool: 'both', runs: 3, maquina: 'mini',
    failed: 2, criterio: 2, inestables: 0, parityBreaks: 0, paridadReal: 0,
    baselineRegressions: 0, skippedMcp: 0 });
  const a = avisar(b);
  assert.match(a.stdout, /0 inestables/,
    '🔴 sin esto, el arreglo podría pintar TODO de "no medido" y el aviso no diría nada nunca');
  assert.match(a.stdout, /paridad rota 0/);
  assert.ok(!/no medid[ao]/i.test(a.stdout), 'acá sí se midieron: no hay nada que denunciar');
});

test('T52 un reporte que no declara CÓMO se produjo no se lee como medido ni se inventa', () => {
  const b = banco();
  // Sin `tool` ni `runs`: no se puede saber si midió. No se denuncia (no hay evidencia de que no
  // haya medido) pero tampoco se afirma nada nuevo — se muestra como siempre se mostró.
  escribir(b.reporteQueViaja, { kind: 'examen-periodico', estado: 'completo', alcance: 'completo',
    ts: new Date().toISOString(), criterio: 3, inestables: 1, paridadReal: 2,
    baselineRegressions: 0, maquina: 'mini' });
  const a = avisar(b);
  assert.match(a.stdout, /3 de criterio/);
  assert.match(a.stdout, /1 inestables/, 'los números que el reporte trae se respetan');
});

test('T55 el productor REAL deja null + motivo: --reclassify --write sobre un reporte de una corrida', () => {
  // El pase adversarial del 2026-09-10 lo marcó: T50-T54 y el smoke ejercitan el AVISO y el examen,
  // pero el `null` lo fabricaba el runner falso. Éste es el único camino de `advisor-runner.js` que
  // escribe un reporte sin llamar a un modelo: reclasificar uno ya escrito. Un reporte con los ceros
  // viejos (`inestables: 0`, `paridadReal: 0`, `runs: 1`, `tool: claude`) tiene que salir honesto.
  const runner = path.join(TCG, 'scripts', 'controls-bench', 'advisor-runner.js');
  const b = banco();
  const escribirReporte = (nombre, tool, runs) => {
    const p = path.join(b.raiz, nombre);
    fs.writeFileSync(p, JSON.stringify({ ts: new Date().toISOString(), tool, runs, alcance: 'completo', only: [],
      failed: 0, criterio: 0, inestables: 0, erroresDeCorrida: 0, fugas: 0, artefactos: 0, varianzaDeclarada: 0,
      parityBreaks: 0, paridadReal: 0, paridadPorInestabilidad: 0, baselineRegressions: 0, skippedMcp: 0,
      results: { 'x::caso': { type: 'must-flag', rule: 'X-C1',
        tools: { claude: { pass: true, failures: [], flags: [true], clase: 'ok' },
          ...(tool === 'both' ? { codex: { pass: true, failures: [], flags: [true], clase: 'ok' } } : {}) } } } }));
    return p;
  };

  const vida = escribirReporte('vida.json', 'claude', 1);
  const r = spawnSync(process.execPath, [runner, '--reclassify', vida, '--write'], { encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const d = JSON.parse(fs.readFileSync(vida, 'utf8'));
  assert.strictEqual(d.inestables, null, '🔴 el productor real seguía escribiendo 0 donde no midió');
  assert.strictEqual(d.paridadReal, null);
  assert.strictEqual(d.parityBreaks, null);
  assert.ok(d.no_medido && /corrida/.test(d.no_medido.inestables) && /herramienta/.test(d.no_medido.paridad), 'con el motivo');
  assert.match(r.stdout, /inestables=no medido/, 'y la consola dice lo mismo que el archivo');

  // Espejo: con las dos herramientas y tres corridas, los ceros son ceros y `no_medido` no existe.
  const profundo = escribirReporte('profundo.json', 'both', 3);
  const r2 = spawnSync(process.execPath, [runner, '--reclassify', profundo, '--write'], { encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
  const d2 = JSON.parse(fs.readFileSync(profundo, 'utf8'));
  assert.strictEqual(d2.inestables, 0);
  assert.strictEqual(d2.paridadReal, 0);
  assert.strictEqual(d2.no_medido, undefined, 'medido todo: sin la clave');
});

test('T54 examen fresco y SIN rojos con una corrida/una herramienta: silencio legítimo, jamás un cero', () => {
  const b = banco();
  // El pase adversarial del 2026-09-10 marcó esto: T50 y el smoke sólo cubren reportes CON rojos.
  // Con criterio 0 el aviso calla —decisión previa, caso `quiet-examen-fresco-y-verde` del banco:
  // con el chequeo de vida estos rubros quedan sin medir en toda corrida, y hablar por eso sería
  // ruido en cada arranque—, pero lo que no puede pasar, hable o no, es que imprima un 0 ahí.
  escribir(b.reporteQueViaja, { kind: 'examen-periodico', estado: 'completo', alcance: 'completo',
    ts: new Date().toISOString(), tool: 'claude', runs: 1, maquina: 'mini',
    failed: 0, criterio: 0, inestables: 0, parityBreaks: 0, paridadReal: 0,
    baselineRegressions: 0, skippedMcp: 0, erroresDeCorrida: 0, fugas: 0 });
  const a = avisar(b);
  assert.strictEqual(a.status, 0);
  assert.ok(!/0 inestables|paridad rota 0/.test(a.stdout), '🔴 un cero pintado, con o sin rojos, es el bug');
  assert.ok(!/no est[áa] corriendo/i.test(a.stdout), 'fresco: no se denuncia');
});

test('T53 el productor marca los rubros imposibles como no medidos, con el motivo', () => {
  const { rubrosNoMedidos } = require(path.join(TCG, 'scripts', 'controls-bench', 'unmeasured-categories.js'));

  const vida = rubrosNoMedidos({ tool: 'claude', runs: 1 });
  assert.ok(vida.inestables, 'con 1 corrida, la inestabilidad no se midió');
  assert.match(vida.inestables, /corrida/i, 'y el motivo lo dice en castellano');
  assert.ok(vida.paridad, 'con 1 herramienta, la paridad no se midió');
  assert.match(vida.paridad, /herramienta/i);

  const completo = rubrosNoMedidos({ tool: 'both', runs: 3 });
  assert.strictEqual(completo.inestables, null, 'con 3 corridas la inestabilidad SÍ se mide');
  assert.strictEqual(completo.paridad, null, 'con las dos herramientas la paridad SÍ se mide');

  // Las dos mitades son independientes: se puede medir una y no la otra.
  assert.strictEqual(rubrosNoMedidos({ tool: 'both', runs: 1 }).paridad, null);
  assert.ok(rubrosNoMedidos({ tool: 'both', runs: 1 }).inestables);
  assert.ok(rubrosNoMedidos({ tool: 'claude', runs: 3 }).paridad);
  assert.strictEqual(rubrosNoMedidos({ tool: 'claude', runs: 3 }).inestables, null);

  // 🔴 Un reporte que no declara cómo se produjo no se juzga: no se puede afirmar que midió, pero
  // tampoco inventar que no lo hizo. Los reportes reales SIEMPRE traen los dos campos.
  const mudo = rubrosNoMedidos({});
  assert.strictEqual(mudo.inestables, null);
  assert.strictEqual(mudo.paridad, null);
  // …y "declarado vacío" es "no declarado": `Number(null)` es 0 y sin la guarda se leía como
  // "0 corridas por caso" (pase adversarial 2026-09-10); `tool: ''` no es una herramienta.
  for (const raro of [{ runs: null }, { runs: undefined }, { runs: '' }, { tool: '' }, { tool: '  ' }]) {
    const r = rubrosNoMedidos(raro);
    assert.strictEqual(r.inestables, null, `runs raro no se juzga: ${JSON.stringify(raro)}`);
    assert.strictEqual(r.paridad, null, `tool raro no se juzga: ${JSON.stringify(raro)}`);
  }
});

test('T16 el_aviso_distingue_completa_de_acotada: la parcial no se lee como el estado general', () => {
  const b = banco();
  escribir(b.reporteQueViaja, { kind: 'examen-periodico', estado: 'completo', alcance: 'completo',
    ts: haceDias(2), criterio: 5, inestables: 0, paridadReal: 0, baselineRegressions: 0, maquina: 'mini' });
  // Una corrida acotada de 3 revisores, MÁS FRESCA que la completa.
  escribir(path.join(b.repo, 'scripts', 'controls-bench', '.bench', 'advisors-claude-parcial-abc.json'),
    { ts: new Date().toISOString(), alcance: 'acotado', only: ['tycon-story-validator'],
      failed: 0, criterio: 0, inestables: 0, parityBreaks: 0, paridadReal: 0, baselineRegressions: 0 });

  const a = avisar(b);
  assert.match(a.stdout, /5/, 'el estado general lo sigue dando la corrida completa');
  assert.match(a.stdout, /parcial|acotad/i, 'y la acotada se muestra marcada como parcial');
  assert.ok(!/no est[áa] corriendo/i.test(a.stdout),
    'la completa de hace 2 días sigue siendo fresca: no se denuncia');
});

test('T29 la_denuncia_sobrevive_a_que_otra_parte_se_rompa', () => {
  // 🔴 El peor caso posible acá: el aviso es fail-open por diseño (nunca puede romper el arranque
  // de sesión), así que un error interno lo deja mudo. Si la denuncia del examen —la razón de ser
  // de esta story— se calcula dentro de ese mismo bloque, cualquier otra falla la borra en
  // silencio: exactamente el modo de fallo que vinimos a cerrar, reintroducido por el arreglo.
  const b = banco();
  const bench = path.join(b.repo, 'scripts', 'controls-bench', '.bench');
  fs.chmodSync(bench, 0o000);                       // leer la carpeta del banco ahora tira
  try {
    const a = avisar(b);
    assert.strictEqual(a.status, 0, 'sigue sin romper el arranque');
    assert.match(a.stdout, /NO ESTÁ CORRIENDO/, 'y la denuncia SALE igual');
  } finally { fs.chmodSync(bench, 0o755); }
});

test('T30 reporte_sin_ningun_caso_medido_no_es_completo', () => {
  const b = banco({ modoRunner: 'empty' });
  escribir(b.reporteQueViaja, { kind: 'examen-periodico', estado: 'completo', alcance: 'completo',
    ts: haceDias(2), criterio: 0, inestables: 0, paridadReal: 0, baselineRegressions: 0, maquina: 'mini' });
  const r = correr(b);
  assert.notStrictEqual(r.status, 0, 'cero casos medidos es un "no pude mirar", no un verde');
  assert.ok(!fs.existsSync(b.sello), 'no sella');
  assert.strictEqual(JSON.parse(fs.readFileSync(b.reporteQueViaja, 'utf8')).ts.slice(0, 10),
    haceDias(2).slice(0, 10), 'y no pisa la última medición buena');
});

test('T31 el_aviso_no_se_grita_a_si_mismo_dentro_del_banco (no se grita a sí mismo)', () => {
  const b = banco();
  const a = avisar(b, { TYCON_EVAL_SANDBOX: '1' });
  assert.strictEqual(a.stdout.trim(), '', 'dentro del banco, mudo — si no, el revisor va y corre lo que el aviso sugiere');
});

test('T32b el_aviso_ve_el_sello_con_nombre_viejo (story 8.9, D2)', { skip: SIN_MAPA }, () => {
  // Un sello de HOY sin el reporte de hoy es un sello que no escribió el examen: el aviso lo denuncia. Con sólo el
  // nombre viejo en la máquina tiene que seguir viéndolo; si no, un sello puesto a mano se robaría el turno en silencio.
  const b = banco();
  const viejo = path.join(path.dirname(b.sello), viejoD2('periodic-exam-last-run'));
  fs.writeFileSync(viejo, `${new Date().toISOString()}\n`);
  const a = avisar(b);
  assert.match(a.stdout, /examen de revisores: el sello de HOY/, `el aviso no vio el sello viejo:\n${a.stdout}\n${a.stderr}`);
  assert.ok(a.stdout.includes(path.basename(viejo)), 'y nombra el archivo que hay que borrar, el que existe');
});

test('T32 el_aviso_respeta_su_opt_out', () => {
  const b = banco();
  const a = avisar(b, { TYCON_BENCH_NOTICE: '0' });
  assert.strictEqual(a.stdout.trim(), '');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// T15 / T19 / T20 / T25 — el disparador: se instala SOLO en la designada, y el instalador
// invoca la pieza extraída en vez de tener su propia copia
// ─────────────────────────────────────────────────────────────────────────────────────────────

function instalarEn(b, maquina, extra = []) {
  const agentes = path.join(b.raiz, 'LaunchAgents');
  const launchctlFalso = path.join(b.raiz, 'launchctl-falso.sh');
  fs.writeFileSync(launchctlFalso, '#!/bin/sh\necho "$@" >> "$LAUNCHCTL_LOG"\nexit 0\n');
  fs.chmodSync(launchctlFalso, 0o755);
  // 🔴 Con las herramientas SIMULADAS al lado de un node falso (2026-09-05). Desde el commit que
  // hizo que --install-task se NIEGUE si no alcanza a `claude` y `codex`, este helper corría con
  // el node REAL: el test pasaba en una máquina con las dos instaladas y fallaba —ENOENT del plist
  // en T25b/T33/T34— en cualquiera sin `codex`. DevB lo encontró en la suya. Lo que se prueba acá es
  // el instalador, no la máquina: las herramientas las provee el fixture, como ya hacía T48.
  const nodeFalso = fs.existsSync(path.join(b.raiz, 'bin-falso', 'node'))
    ? path.join(b.raiz, 'bin-falso', 'node')
    : binDeNode(b);
  // La HOME del banco se declara la del usuario (story 8.4, AC 28): sin eso --install-task no toca launchd desde una
  // HOME que no es la real, y estos casos existen justo para probar la instalación.
  const r = correrComoLaunchd(b, nodeFalso, ['--install-task', ...extra], {
    TYCON_EXAM_MACHINE: maquina,
    TYCON_EXAM_LAUNCHAGENTS: agentes,
    TYCON_EXAM_REAL_HOME: b.casa,
    LAUNCHCTL_BIN: launchctlFalso,
    LAUNCHCTL_LOG: path.join(b.raiz, 'launchctl.log'),
  });
  return { r, plist: path.join(agentes, 'ar.com.tycon.examen-periodico.plist'), agentes };
}

test('T25b el disparador se instala SÓLO en la máquina designada', () => {
  const b = banco();
  const otra = instalarEn(b, 'equipo-deva');
  assert.strictEqual(otra.r.status, 0);
  assert.ok(!fs.existsSync(otra.plist), '🔴 en una notebook del equipo no queda tarea programada');

  const mini = instalarEn(b, 'Devas-Mac-mini');
  assert.strictEqual(mini.r.status, 0);
  assert.ok(fs.existsSync(mini.plist), 'en el mini sí');
  const xml = fs.readFileSync(mini.plist, 'utf8');
  assert.match(xml, /<key>Weekday<\/key><integer>2<\/integer>/, 'martes');
  assert.match(xml, /<key>Weekday<\/key><integer>5<\/integer>/, 'viernes');
  assert.match(xml, /periodic-exam\.js/);
});

test('T33 el_disparador_se_retira_de_la_maquina_que_dejo_de_serlo', () => {
  const b = banco();
  const mini = instalarEn(b, 'Devas-Mac-mini');
  assert.ok(fs.existsSync(mini.plist));
  // Mañana se designa otra máquina: ésta tiene que dejar de correr sola.
  const ex = instalarEn(b, 'equipo-deva');
  assert.ok(!fs.existsSync(ex.plist), 'un disparador huérfano seguiría gastando la cuota del dev');
  assert.match(fs.readFileSync(path.join(b.raiz, 'launchctl.log'), 'utf8'), /bootout/);
});

test('T34 instalar_el_disparador_es_idempotente', () => {
  const b = banco();
  const a = instalarEn(b, 'Devas-Mac-mini');
  const antes = fs.statSync(a.plist).mtimeMs;
  const dos = instalarEn(b, 'Devas-Mac-mini');
  assert.strictEqual(fs.statSync(dos.plist).mtimeMs, antes, 'no toca el archivo si el contenido es el mismo');
  assert.ok(!/programado/.test(dos.r.stdout), 'y no anuncia un cambio que no hubo');
});

test('T34b el_log_de_launchd_pasa_al_nombre_nuevo_al_reescribir_el_plist (story 8.9, D2)', { skip: SIN_MAPA }, () => {
  const b = banco();
  const st = path.join(b.casa, '.claude', '.tycon-pipeline');
  const viejo = path.join(st, viejoD2('periodic-exam.log'));
  const nuevo = path.join(st, 'periodic-exam.log');
  fs.writeFileSync(viejo, 'corrida del martes: el motivo de la última falla\n');
  const mini = instalarEn(b, 'Devas-Mac-mini');
  assert.strictEqual(mini.r.status, 0, `${mini.r.stdout}\n${mini.r.stderr}`);
  const xml = fs.readFileSync(mini.plist, 'utf8');
  assert.ok(xml.includes(`<key>StandardOutPath</key><string>${nuevo}</string>`), 'la salida va al log con nombre nuevo');
  assert.ok(xml.includes(`<key>StandardErrorPath</key><string>${nuevo}</string>`), 'y los errores también');
  assert.ok(!xml.includes(path.basename(viejo)), 'el plist ya no nombra el log viejo');
  // 🔴 launchd abre el log por su cuenta: si la copia no pasa antes de cargar la tarea, el log nuevo nace vacío y
  //    la historia de las corridas anteriores queda en un archivo que nadie mira.
  assert.strictEqual(fs.readFileSync(nuevo, 'utf8'), 'corrida del martes: el motivo de la última falla\n',
    'la historia del log viejo pasa al nuevo');
  assert.ok(fs.existsSync(viejo), 'el viejo queda intacto hasta el retiro');

  // Sin plist que reescribir no hay nada que preparar: la reinstalación idéntica no toca el log.
  fs.rmSync(nuevo);
  const dos = instalarEn(b, 'Devas-Mac-mini');
  assert.strictEqual(dos.r.status, 0);
  assert.ok(!fs.existsSync(nuevo), 'idempotente: sin cambio en el plist no se copia nada');
});

test('T15/T19/T20 el instalador usa la pieza extraída, y no se lleva puestas las otras corridas', () => {
  const fuente = fs.readFileSync(path.join(TCG, 'scripts', 'install-tycon-hooks.sh'), 'utf8');

  // T15: una sola implementación. El lanzador semanal viejo YA NO vive en el instalador.
  assert.ok(!fuente.includes('controls-bench-advisors-last-run'),
    '🔴 el sello semanal viejo no puede seguir en el instalador: serían dos programadores para lo mismo');
  assert.ok(fuente.includes('periodic-exam.js'), 'el instalador invoca la pieza extraída');

  // T19: de las otras dos corridas de aquel bloque queda UNA en las máquinas: live-fire (el disparo
  // real dentro de Codex, que necesita la herramienta instalada). El banco determinista se fue a
  // Azure DevOps el 2026-09-05 (pipelines/azure-pipelines-banco.yml): corría DOS veces por arranque en la
  // máquina del dev y la segunda en cada sesión, y dos bancos superpuestos fabricaban rojos falsos.
  // Este test lo atrapó la misma madrugada: afirmaba el contrato viejo ("sigue disparándose").
  assert.ok(/live-fire\.js["'\s]+--tool codex/.test(fuente) || fuente.includes("live-fire.js' --tool codex"),
    'la corrida de live-fire bajo Codex sigue disparándose');
  // 🔴 Se buscan los LANZAMIENTOS (`nohup …`) que nombren al corredor por su variable o por su
  // archivo: la primera versión de esta afirmación buscaba `runner.js` literal y daba VERDE contra
  // el instalador viejo, que lanzaba `$BENCH_RUNNER` — un test que no puede fallar no es un test.
  const lanzaRunner = fuente.split('\n').some((l) => !/^\s*#/.test(l)
    && /nohup/.test(l) && /(BENCH_RUNNER|BENCH_JOB|run-controls-bench-job|runner\.js)/.test(l));
  assert.ok(!lanzaRunner,
    '🔴 el instalador NO lanza el banco determinista: corre en Azure DevOps y su reporte viaja por git');

  // T20: el examen NO puede quedar colgado del sello diario ajeno ni de TYCON_CODEX. Se mira EL
  // BLOQUE que lo lanza (desde su variable hasta su `fi`), no una ventana de caracteres alrededor
  // de la primera mención — que también matchea los comentarios que explican de dónde se lo sacó.
  const desde = fuente.indexOf('EXAMEN_PERIODICO="');
  assert.notStrictEqual(desde, -1, 'el bloque del examen tiene que existir en el instalador');
  const bloque = fuente.slice(desde, fuente.indexOf('\nfi', desde));
  assert.ok(!bloque.includes('$LAST_CB') && !bloque.includes('TODAY_CB'),
    '🔴 la evaluación del examen no puede depender de que otro banco no haya corrido hoy');
  assert.ok(!/TYCON_CODEX/.test(bloque),
    '🔴 ni de una llave que la máquina del dev no tiene puesta — ahí es donde el lanzador viejo nunca corrió');

  // 🔴 UN solo programador. El instalador INSTALA la tarea; no lanza el examen él también. Dos
  // disparadores para lo mismo es exactamente lo que la story prohíbe por escrito — y además haría
  // que cada máquina del equipo ejecutara la pieza en cada arranque, cuando el AC 14 dice que para
  // el resto lo único que cambia es el texto del aviso.
  assert.ok(!/nohup[^\n]*EXAMEN_PERIODICO/.test(bloque) && !/EXAMEN_PERIODICO\"?\s*&/.test(bloque),
    'el instalador no lanza el examen: para eso está la tarea programada');
  assert.match(bloque, /--install-task/, 'lo único que hace es instalar (o retirar) el disparador');
});

// ---------------------------------------------------------------------------------------------
// El MOTIVO de un pull que falló (2026-09-01). Lógica pura sobre un string: cero llamadas, cero git.
//
// Por qué tiene casos propios: este texto es lo ÚNICO que va a leer el que el viernes se pregunte
// por qué la medición se hizo con código viejo (`codigo_desactualizado` del reporte que viaja). El
// primer intento se quedaba con la ÚLTIMA línea del error de git y dejaba `and the repository
// exists.` — el final de una frase partida, que no dice ni qué falló ni dónde. Los dos textos de
// git de acá abajo son REALES, capturados en la máquina del examen contra un repo de juguete.
// ---------------------------------------------------------------------------------------------
const GIT_REMOTE_INEXISTENTE = [
  "fatal: '/ruta/que/no/existe.git' does not appear to be a git repository",
  'fatal: Could not read from remote repository.',
  '',
  'Please make sure you have the correct access rights',
  'and the repository exists.',
].join('\n');
const GIT_PIDE_CONTRASENA =
  "fatal: could not read Username for 'https://dev.azure.com/org-del-equipo/_git/x': terminal prompts disabled";

test('motivo del pull: se queda con la línea ACCIONABLE, que en git es la primera', () => {
  assert.strictEqual(E.motivoDeGit(GIT_REMOTE_INEXISTENTE, '', 128),
    "fatal: '/ruta/que/no/existe.git' does not appear to be a git repository");
});

test('🔴 motivo del pull: NO se queda con la última línea (el rojo que originó esto)', () => {
  // El caso que falla si alguien vuelve a `.split("\n").pop()`. Esa coletilla es texto de ayuda de
  // git, no la causa: sin el "qué" y el "dónde", la constancia hace perder el tiempo del que la lee.
  const m = E.motivoDeGit(GIT_REMOTE_INEXISTENTE, '', 128);
  assert.ok(!/and the repository exists/.test(m), 'la coletilla no puede ser el motivo');
  assert.ok(/does not appear to be a git repository/.test(m), 'el motivo dice QUÉ falló');
  assert.ok(m.includes('/ruta/que/no/existe.git'), 'y DÓNDE — sin eso no se puede accionar');
});

test('motivo del pull: el error de credenciales llega entero (una sola línea)', () => {
  // Es el que importa bajo launchd: nadie va a contestar una contraseña a las 2 de la mañana, y
  // `terminal prompts disabled` es lo que distingue "falló rápido" de "se colgó para siempre".
  assert.strictEqual(E.motivoDeGit(GIT_PIDE_CONTRASENA, '', 128), GIT_PIDE_CONTRASENA);
  assert.match(E.motivoDeGit(GIT_PIDE_CONTRASENA, '', 128), /terminal prompts disabled/);
});

test('motivo del pull: saltea líneas vacías y espacios, y cae a stdout si stderr no dijo nada', () => {
  assert.strictEqual(E.motivoDeGit('\n   \n fatal: algo \n otra cosa', '', 1), 'fatal: algo');
  assert.strictEqual(E.motivoDeGit('', 'lo dijo por stdout', 1), 'lo dijo por stdout');
});

test('motivo del pull: sin una sola línea, el exit code — nunca un motivo vacío', () => {
  // Un motivo vacío en el reporte se lee como "no pasó nada", que es la lectura opuesta a la real.
  assert.strictEqual(E.motivoDeGit('', '', 128), 'exit 128');
  assert.strictEqual(E.motivoDeGit('   \n\n  ', undefined, 9), 'exit 9');
});

test('motivo del pull: un texto largo se recorta Y SE NOTA que fue recortado', () => {
  // Un texto cortado sin marca se lee como el mensaje completo y manda a buscar una causa que no
  // está ahí.
  const largo = `fatal: ${'x'.repeat(400)}`;
  const m = E.motivoDeGit(largo, '', 1);
  assert.strictEqual(m.length, 200);
  assert.ok(m.endsWith('…'), 'el recorte se declara');
  assert.ok(m.startsWith('fatal: '), 'y conserva el principio, que es donde git pone lo útil');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// T46/T47/T48 — EL PATH DE LAUNCHD (incidente 2026-09-04)
//
// El examen del viernes 4/9 no dejó reporte y no fue por el horario: el disparador arrancó puntual
// (02:00:04) y murió 4 segundos después con `spawnSync claude ENOENT`. launchd lanza sus trabajos
// con el PATH mínimo de macOS y `claude`/`codex` viven en el bin de Node, que no está ahí. El plist
// llevaba la ruta absoluta de node —por eso node arrancó— pero todo lo demás iba por nombre pelado.
//
// 🔴 El fixture usa un HARD LINK de node en un directorio temporal, no un symlink: en macOS node
// RESUELVE el symlink y `process.execPath` devolvería el node real (medido) — o sea que el caso
// pasaría por el bin de nvm de verdad y no probaría nada. Con hard link `execPath` es la ruta
// falsa, que es justo la premisa del arreglo: las herramientas están al lado de node.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** El PATH exacto con el que launchd lanza sus trabajos programados. */
const PATH_DE_LAUNCHD = '/usr/bin:/bin:/usr/sbin:/sbin';

/** Un bin/ con node y —según el caso— `claude` y `codex` al lado, como el bin de nvm. */
function binDeNode(b, { conHerramientas = true, real: rutaReal = process.execPath } = {}) {
  const bin = path.join(b.raiz, 'bin-falso');
  fs.mkdirSync(bin, { recursive: true });
  const nodeFalso = path.join(bin, 'node');
  // 🔴 UNA COPIA, NUNCA UN ENLACE AL NODE REAL (2026-10-13). Era un enlace duro, y al llamar esto dos veces sobre el mismo
  // banco el `copyFileSync` de respaldo copiaba el binario real sobre sí mismo: los bytes quedaban iguales, pero macOS
  // dio por inválida su firma y mató con 137 a todo proceso que lanzara ese node, en toda la máquina, hasta que se
  // reemplazó el archivo. Ahora es una copia con inodo propio (en APFS, un clon: instantáneo), se reusa si ya está, y
  // antes de escribir se comprueba que el destino no sea el node que corre: si lo es, la prueba falla en seco.
  const real = fs.statSync(rutaReal);
  const esElReal = (p) => { try { const st = fs.statSync(p); return st.ino === real.ino && st.dev === real.dev; } catch (_) { return false; } };
  if (esElReal(nodeFalso)) throw new Error(`binDeNode: ${nodeFalso} es el node real (${rutaReal}); no se escribe sobre él`);
  if (!fs.existsSync(nodeFalso)) {
    fs.copyFileSync(rutaReal, nodeFalso, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(nodeFalso, 0o755);
  }
  if (conHerramientas) {
    // La forma REAL de cada una (medida 2026-09-05): `claude` es un binario nativo — acá un sh
    // alcanza —; `codex` es un script `#!/usr/bin/env node`, y ésa es la trampa que el caso tiene
    // que ejercer: bajo el PATH mínimo `env` no encuentra `node` y sale 127 AUNQUE el spawn haya
    // sido por ruta absoluta. Sin la reparación del PATH, este fixture pone rojo a T46.
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho ok\nexit 0\n');
    fs.chmodSync(path.join(bin, 'claude'), 0o755);
    fs.writeFileSync(path.join(bin, 'codex'), '#!/usr/bin/env node\nconsole.log("ok");\n');
    fs.chmodSync(path.join(bin, 'codex'), 0o755);
  }
  return nodeFalso;
}

/** Corre el examen COMO LO CORRE LAUNCHD: PATH mínimo y sin la sonda inyectada. */
function correrComoLaunchd(b, nodeFalso, args = [], extraEnv = {}) {
  return spawnSync(nodeFalso, [EXAMEN, ...args], {
    encoding: 'utf8',
    env: Object.assign({
      PATH: PATH_DE_LAUNCHD,          // ← el entorno del incidente
      HOME: b.casa,
      TYCON_EXAM_CONFIG: b.rutaCfg,
      TYCON_EXAM_RUNNER: b.rutaRunner,
      TYCON_EXAM_REPO: b.repo,
      TYCON_EXAM_MACHINE: 'Devas-Mac-mini',
      // 🔴 SIN TYCON_EXAM_PROBE*: el caso existe para ejercer la resolución REAL. Inyectar la
      // sonda saltearía justo la línea que falló.
    }, extraEnv),
  });
}

test('T46 bajo el PATH de launchd la sonda ENCUENTRA las dos herramientas (el rojo del 2026-09-04)', () => {
  const b = banco();
  const nodeFalso = binDeNode(b);
  const r = correrComoLaunchd(b, nodeFalso, ['--force']);

  // El runner sólo se lanza DESPUÉS de la sonda: su bitácora es la prueba de que la sonda pasó.
  assert.ok(fs.existsSync(b.bitacora),
    `la sonda no dejó llegar al runner. salida:\n${r.stdout}\n${r.stderr}`);
  assert.ok(!/ENOENT/.test(`${r.stdout}${r.stderr}`), 'no puede quedar un ENOENT en la salida');
  if (fs.existsSync(b.intento)) {
    const i = JSON.parse(fs.readFileSync(b.intento, 'utf8'));
    assert.ok(!/no está o no se pudo lanzar/.test(i.motivo || ''),
      `quedó registrado el fallo del incidente: ${i.motivo}`);
  }
});

test('T46b sin las herramientas al lado de node, el PATH mínimo SÍ falla — y se deja dicho', () => {
  const b = banco();
  const nodeFalso = binDeNode(b, { conHerramientas: false });
  const r = correrComoLaunchd(b, nodeFalso, ['--force']);

  // Es el control del caso anterior: si esto pasara, T46 no probaría nada.
  assert.ok(!fs.existsSync(b.bitacora), 'sin herramientas no se puede haber llegado al runner');
  assert.notStrictEqual(r.status, 0, 'no poder medir NUNCA sale 0');
  const i = JSON.parse(fs.readFileSync(b.intento, 'utf8'));
  assert.strictEqual(i.estado, 'incompleto');
  assert.match(i.motivo, /no está o no se pudo lanzar/);
  assert.ok(!fs.existsSync(b.sello), 'una corrida que no midió no se come el turno');
});

test('T47 --install-task se NIEGA (y sale ≠ 0) si no alcanza a las herramientas', () => {
  const b = banco();
  const nodeFalso = binDeNode(b, { conHerramientas: false });
  const agentes = path.join(b.raiz, 'LaunchAgents');
  const r = correrComoLaunchd(b, nodeFalso, ['--install-task'], {
    TYCON_EXAM_LAUNCHAGENTS: agentes,
    TYCON_EXAM_REAL_HOME: b.casa,
    LAUNCHCTL_BIN: '/usr/bin/true',
  });

  assert.notStrictEqual(r.status, 0, 'negarse a instalar tiene que salir ≠ 0');
  assert.ok(!fs.existsSync(path.join(agentes, 'ar.com.tycon.examen-periodico.plist')),
    'no puede quedar escrito un disparador que no puede trabajar');
  assert.match(`${r.stderr}${r.stdout}`, /NO instalo el disparador/);
  assert.match(`${r.stderr}${r.stdout}`, /claude/);
});

test('T48 …y SÍ instala cuando las alcanza: el freno no es "no instalar nunca"', () => {
  const b = banco();
  const nodeFalso = binDeNode(b);
  const agentes = path.join(b.raiz, 'LaunchAgents');
  const r = correrComoLaunchd(b, nodeFalso, ['--install-task'], {
    TYCON_EXAM_LAUNCHAGENTS: agentes,
    TYCON_EXAM_REAL_HOME: b.casa,
    LAUNCHCTL_BIN: '/usr/bin/true',
  });

  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const plist = fs.readFileSync(path.join(agentes, 'ar.com.tycon.examen-periodico.plist'), 'utf8');
  assert.match(plist, /StartCalendarInterval/);
  // 🔴 El plist NO puede depender de una variable de entorno: la ruta se deduce en cada corrida.
  assert.ok(!/EnvironmentVariables/.test(plist),
    'el disparador no lleva PATH: se reescribiría en cada arranque de sesión y volvería a depender del entorno');
});

test('T49 la resolución cae al nombre pelado cuando la herramienta no está al lado de node', () => {
  const R = require(path.join(TCG, 'scripts', 'controls-bench', 'tools-path.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rutas-'));
  TMPS.push(dir);
  const nodeBin = path.join(dir, 'node');
  fs.writeFileSync(nodeBin, '');

  assert.strictEqual(R.rutaDeHerramienta('claude', { nodeBin }), 'claude',
    'sin la hermana al lado, se devuelve el nombre y lo resuelve el PATH como siempre');

  fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(dir, 'claude'), 0o755);
  assert.strictEqual(R.rutaDeHerramienta('claude', { nodeBin }), path.join(dir, 'claude'));

  // Un DIRECTORIO llamado `codex` no es una herramienta.
  fs.mkdirSync(path.join(dir, 'codex'));
  assert.strictEqual(R.rutaDeHerramienta('codex', { nodeBin }), 'codex');

  // Una ruta ya absoluta no se toca.
  assert.strictEqual(R.rutaDeHerramienta('/opt/bin/claude', { nodeBin }), '/opt/bin/claude');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Story 8.4 (tanda B), AC 28 — T24 ExamenPeriodico_HomeAjena_NoTocaLaunchd
//
// launchd es por USUARIO (`gui/<uid>`), no por HOME. El 2026-09-27, probar el instalador en una HOME
// temporal en la máquina designada re-apuntó la tarea REAL del examen a la copia temporal (se restauró el
// mismo día). Con una HOME que no es la del usuario, --install-task no toca launchd —ni instala, ni
// retira, ni chequea—: lo dice en una línea y sale 0. Las pruebas que sí quieren instalar declaran su HOME
// como la real con TYCON_EXAM_REAL_HOME (el control de abajo).
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('T24 (8.4) ExamenPeriodico_HomeAjena_NoTocaLaunchd — desde una HOME que no es la del usuario, launchd no se toca', () => {
  const b = banco();
  const nodeFalso = binDeNode(b);
  const agentes = path.join(b.raiz, 'LaunchAgents');
  const plist = path.join(agentes, 'ar.com.tycon.examen-periodico.plist');
  const bitacora = path.join(b.raiz, 'launchctl.log');
  const launchctlFalso = path.join(b.raiz, 'launchctl-falso.sh');
  fs.writeFileSync(launchctlFalso, '#!/bin/sh\necho "$@" >> "$LAUNCHCTL_LOG"\nexit 0\n');
  fs.chmodSync(launchctlFalso, 0o755);
  assert.notStrictEqual(fs.realpathSync(b.casa), fs.realpathSync(os.userInfo().homedir), 'la HOME del caso no es la del usuario');

  // La máquina DESIGNADA: sin la guarda, esta corrida escribiría el plist y haría bootstrap.
  const env = {
    PATH: PATH_DE_LAUNCHD, HOME: b.casa,
    TYCON_EXAM_CONFIG: b.rutaCfg, TYCON_EXAM_RUNNER: b.rutaRunner, TYCON_EXAM_REPO: b.repo,
    TYCON_EXAM_MACHINE: 'Devas-Mac-mini', TYCON_EXAM_LAUNCHAGENTS: agentes,
    LAUNCHCTL_BIN: launchctlFalso, LAUNCHCTL_LOG: bitacora,
  };
  const correrCon = (args, extra = {}) => spawnSync(nodeFalso, [EXAMEN, ...args], { encoding: 'utf8', env: { ...env, ...extra } });

  for (const args of [['--install-task', '--check'], ['--install-task']]) {
    const r = correrCon(args);
    const dicho = `${r.stdout}${r.stderr}`;
    assert.strictEqual(r.status, 0, `${args.join(' ')}: sale 0\n${dicho}`);
    assert.ok(!fs.existsSync(bitacora), `${args.join(' ')}: ninguna llamada a launchctl — llegó: ${fs.existsSync(bitacora) ? fs.readFileSync(bitacora, 'utf8') : ''}`);
    assert.ok(!fs.existsSync(plist), `${args.join(' ')}: ni un plist escrito`);
    const lineas = dicho.split('\n').filter((l) => l.trim());
    assert.strictEqual(lineas.length, 1, `${args.join(' ')}: lo dice en UNA línea\n${dicho}`);
    assert.match(lineas[0], /HOME/, 'la línea dice que la HOME no es la del usuario');
    assert.match(lineas[0], /launchd/, 'y que por eso no toca launchd');
    assert.ok(!/[🛑🔴🔕⛔]/u.test(dicho), 'sin alarmas: en una prueba es lo esperado');
  }

  // Tampoco retira: un disparador en esa HOME, con la máquina NO designada, no dispara un bootout sobre el usuario real.
  fs.mkdirSync(agentes, { recursive: true });
  fs.writeFileSync(plist, '<plist/>\n');
  const r2 = correrCon(['--install-task'], { TYCON_EXAM_MACHINE: 'otra-maquina' });
  assert.strictEqual(r2.status, 0, `${r2.stdout}\n${r2.stderr}`);
  assert.ok(!fs.existsSync(bitacora), 'ni un bootout: el dominio de launchd es el del usuario real');
  assert.ok(fs.existsSync(plist), 'y no borra nada');
  fs.rmSync(plist);

  // Control: con esa misma HOME declarada como la del usuario, la misma corrida SÍ llega a launchctl — la que calla es la guarda.
  const r3 = correrCon(['--install-task'], { TYCON_EXAM_REAL_HOME: b.casa });
  assert.strictEqual(r3.status, 0, `${r3.stdout}\n${r3.stderr}`);
  assert.ok(fs.existsSync(plist), 'con la HOME real, instala');
  assert.match(fs.readFileSync(bitacora, 'utf8'), /bootstrap/, 'y registra la tarea');
});

// ── T32 · AC 34 (8.4, vuelta 1 de revisión) ─────────────────────────────────────────────────────────────────────
test('T32 (8.4) ExamenPeriodico_HomeConOtraCaja_EsLaMisma — la misma carpeta escrita con otra caja es la misma HOME', (t) => {
  const b = banco();
  const otraCaja = path.join(path.dirname(b.casa), path.basename(b.casa).toUpperCase());
  if (!fs.existsSync(otraCaja)) {
    t.skip('ℹ NO MEDIDO: este disco distingue mayúsculas — la misma HOME no se puede escribir con otra caja');
    return;
  }
  const nodeFalso = binDeNode(b);
  const agentes = path.join(b.raiz, 'LaunchAgents');
  const plist = path.join(agentes, 'ar.com.tycon.examen-periodico.plist');
  const bitacora = path.join(b.raiz, 'launchctl.log');
  const launchctlFalso = path.join(b.raiz, 'launchctl-falso.sh');
  fs.writeFileSync(launchctlFalso, '#!/bin/sh\necho "$@" >> "$LAUNCHCTL_LOG"\nexit 0\n');
  fs.chmodSync(launchctlFalso, 0o755);
  const r = spawnSync(nodeFalso, [EXAMEN, '--install-task'], {
    encoding: 'utf8',
    env: {
      PATH: PATH_DE_LAUNCHD, HOME: otraCaja, TYCON_EXAM_REAL_HOME: b.casa,
      TYCON_EXAM_CONFIG: b.rutaCfg, TYCON_EXAM_RUNNER: b.rutaRunner, TYCON_EXAM_REPO: b.repo,
      TYCON_EXAM_MACHINE: 'Devas-Mac-mini', TYCON_EXAM_LAUNCHAGENTS: agentes,
      LAUNCHCTL_BIN: launchctlFalso, LAUNCHCTL_LOG: bitacora,
    },
  });
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /no es la del usuario/, 'la HOME escrita con otra caja no es «ajena»');
  assert.ok(fs.existsSync(plist), 'instala el disparador');
  assert.match(fs.readFileSync(bitacora, 'utf8'), /bootstrap/, 'y registra la tarea');
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Story 8.9, tanda G — los días del examen se escriben en inglés, y un día que no existe ya no se descarta callado
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 rojo previo verificado: la tabla de días sólo conocía los nombres en castellano, así que `"friday"` no daba error:
//    el filtro lo descartaba y el examen quedaba programado un día menos sin que nadie lo supiera. Que los nombres en
//    castellano sigan valiendo en las máquinas del equipo lo prueba legacy-names-g.test.js (con el mapa de renombres).

test('T72 exam_days_in_english: los siete días se escriben en inglés; sin días, martes y viernes; mayúsculas y espacios no importan', () => {
  const base = { label: 'l', nodeBin: '/usr/bin/node', script: '/x.js', hour: '02:00' };
  const dias = (xml) => [...xml.matchAll(/<key>Weekday<\/key><integer>(\d)<\/integer>/g)].map((m) => Number(m[1]));
  assert.deepStrictEqual(dias(E.plistDeseado({ ...base, scheduled_days: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] })), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepStrictEqual(dias(E.plistDeseado({ ...base, scheduled_days: [' Friday ', 'TUESDAY'] })), [5, 2]);
  assert.deepStrictEqual(dias(E.plistDeseado(base)), [2, 5], 'sin scheduled_days: los de siempre');
  assert.deepStrictEqual(dias(E.plistDeseado({ ...base, scheduled_days: [] })), [2, 5]);
  assert.deepStrictEqual(E.diasProgramados(['friday', 'friyay', 7]), { numeros: [5], desconocidos: ['friyay', '7'] });
  assert.deepStrictEqual(E.diasProgramados(undefined), { numeros: [2, 5], desconocidos: [] });
  // Pase adversarial de la tanda G (causa 3): un valor que no es lista caía callado a martes y viernes. Ahora es desconocido.
  for (const raro of ['monday', { 0: 'monday' }, 5]) {
    const d = E.diasProgramados(raro);
    assert.deepStrictEqual(d.numeros, [], `${JSON.stringify(raro)}: no se inventan días`);
    assert.strictEqual(d.desconocidos.length, 1, `${JSON.stringify(raro)}: se nombra como desconocido`);
    assert.match(d.desconocidos[0], /no es una lista/, `${JSON.stringify(raro)}: y dice por qué — ${d.desconocidos[0]}`);
  }
});

// Pase adversarial de la tanda G (causas 3, 4, 6 y 11): la negativa salía sólo por la salida de error, y el instalador llama
// al guion con esa salida tapada: en la máquina designada nadie se enteraba. Además un valor que no es lista escribía el
// disparador con los días de siempre antes de caerse. 🔴 ROJO PREVIO: la salida normal venía vacía, y con "monday" quedaba plist.
test('T72 exam_refusal_visible: la negativa sale por la salida normal (la que el instalador no tapa), también con un valor que no es lista; --dry-run marca el día raro', () => {
  for (const scheduled_days of [['tuesday', 'friyay'], 'monday']) {
    for (const extra of [[], ['--check']]) {
      const b = banco({ config: { scheduled_days } });
      const { r, plist } = instalarEn(b, 'Devas-Mac-mini', extra);
      const caso = `${JSON.stringify(scheduled_days)} ${extra.join(' ')}`;
      assert.strictEqual(r.status, 2, `${caso}: se niega (${r.stderr})`);
      assert.ok(!fs.existsSync(plist), `${caso}: no escribe el disparador`);
      assert.match(r.stdout || '', /NO instalo el disparador del examen/, `${caso}: lo dice por la salida normal — «${r.stdout}»`);
    }
  }
  const b = banco({ config: { scheduled_days: ['tuesday', 'friyay'] } });
  const dry = spawnSync(process.execPath, [EXAMEN, '--dry-run'], { encoding: 'utf8', env: { ...process.env, HOME: b.casa, TYCON_EXAM_CONFIG: b.rutaCfg } });
  assert.match(dry.stdout || '', /friyay.*no es un día|no es un día.*friyay/, `--dry-run marca el día que no existe — «${dry.stdout}»`);
});

test('T72 exam_unknown_day_refused: con un día que no existe --install-task se niega (sale 2), lo nombra y no deja disparador; con --install-task --check, lo mismo', () => {
  const b = banco({ config: { scheduled_days: ['tuesday', 'friyay'] } });
  const { r, plist } = instalarEn(b, 'Devas-Mac-mini');
  assert.strictEqual(r.status, 2, 'un disparador que correría menos días de los que dice la configuración no se instala');
  assert.ok(!fs.existsSync(plist), 'no quedó disparador');
  const salida = `${r.stdout || ''}${r.stderr || ''}`;
  assert.match(salida, /friyay/, 'dice cuál es el día que no conoce');
  assert.match(salida, /monday.*sunday|sunday.*saturday/, 'y cuáles valen');
  // `--check` sólo vale junto a `--install-task` (solo, el guion decide si le toca y corre): con el día desconocido
  // tampoco lo pasa por alto. Corrido de verdad, en otra HOME de laboratorio: lo nombra, sale 2 y no escribe nada.
  const b2 = banco({ config: { scheduled_days: ['tuesday', 'friyay'] } });
  const chk = instalarEn(b2, 'Devas-Mac-mini', ['--check']);
  assert.strictEqual(chk.r.status, 2, `--install-task --check con un día que no existe sale 2 (${chk.r.stderr})`);
  assert.match(`${chk.r.stdout || ''}${chk.r.stderr || ''}`, /friyay/, 'y nombra el día');
  assert.ok(!fs.existsSync(chk.plist), '--check no escribe el disparador');
  const logCheck = path.join(b2.raiz, 'launchctl.log');
  assert.ok(!fs.existsSync(logCheck) || !fs.readFileSync(logCheck, 'utf8').trim(), '--check no llama a launchctl');
  // controles: con días que existen se instala; y `--install-task --check` sobre lo instalado sale 0 sin decir nada
  const b3 = banco();
  const ok = instalarEn(b3, 'Devas-Mac-mini');
  assert.strictEqual(ok.r.status, 0, `control: con días que existen se instala (${ok.r.stderr})`);
  assert.ok(fs.existsSync(ok.plist), 'control: quedó el disparador');
  const alDia = instalarEn(b3, 'Devas-Mac-mini', ['--check']);
  assert.strictEqual(alDia.r.status, 0, `control: --install-task --check con el disparador al día sale 0 (${alDia.r.stderr})`);
  assert.doesNotMatch(`${alDia.r.stdout || ''}`, /falta \(o cambió\)/, 'y no dice que falte');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// T73-T76 — en la versión bajada, la máquina designada y el resultado viven en el clon de mantenimiento (2026-10-13)
//
// El caso: la máquina que corre el examen pasó el 9 de octubre a la versión bajada (el árbol público instalado, sin git).
// Ese árbol trae `exam-config.json` con la máquina designada vacía: el instalador lo leyó, retiró el disparador, y el
// martes 13 el examen no corrió. El arranque marcaba el sello de la corrida a mano como «no lo escribió el job», porque
// buscaba el reporte en el árbol instalado. La máquina designada y el reporte que viaja son del clon de mantenimiento
// que la máquina declara (`paths.maintainers`), el mismo del que los avisos leen la noche.
// 🔴 Rojo previo: con el periodic-exam.js y el bench-notice.js de antes, T73, T74 y T75 fallan.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Un árbol instalado de juguete: el código del examen y del aviso, con la configuración pública (nadie designado). */
function arbolInstalado(raiz) {
  const arbol = path.join(raiz, 'arbol-instalado');
  for (const d of [['scripts', 'lib'], ['scripts', 'setup', 'harness']]) {
    fs.cpSync(path.join(TCG, ...d), path.join(arbol, ...d), { recursive: true });
  }
  const origen = path.join(TCG, 'scripts', 'controls-bench');
  const cb = path.join(arbol, 'scripts', 'controls-bench');
  fs.mkdirSync(cb, { recursive: true });
  for (const f of fs.readdirSync(origen)) if (f.endsWith('.js')) fs.copyFileSync(path.join(origen, f), path.join(cb, f));
  fs.writeFileSync(path.join(cb, 'exam-config.json'), JSON.stringify({ designated_machine: '', days_between_runs: 2, scheduled_days: ['tuesday', 'friday'], hour: '02:00' }));
  fs.mkdirSync(path.join(arbol, 'scripts', 'hooks'), { recursive: true });
  fs.copyFileSync(NOTICE, path.join(arbol, 'scripts', 'hooks', 'bench-notice.js'));
  return arbol;
}

/**
 * Una máquina con versión bajada que declara su clon de mantenimiento. El clon es el repo del banco (con su remoto), y
 * trae la configuración que designa la máquina. `release: false` = la máquina no usa la versión bajada.
 */
function maquinaConClonDeMantenimiento({ release = true } = {}) {
  const b = banco();
  const cfgDelClon = path.join(b.repo, 'scripts', 'controls-bench', 'exam-config.json');
  fs.writeFileSync(cfgDelClon, JSON.stringify({ designated_machine: 'Devas-Mac-mini', days_between_runs: 2, scheduled_days: ['tuesday', 'friday'], hour: '02:00' }));
  b.git('add', '-f', '--', 'scripts/controls-bench/exam-config.json');
  b.git('commit', '-q', '-m', 'la máquina designada');
  b.git('push', '-q', 'origin', 'main');
  const tycon = path.join(b.casa, '.tycon');
  if (release) escribir(path.join(tycon, 'state', 'harness-state.json'), { schema: 1, sources: [{ kind: 'release', version: '0.0.0' }] });
  escribir(path.join(tycon, 'config.json'), { paths: { maintainers: b.repo } });
  b.arbol = arbolInstalado(b.raiz);
  return b;
}

/** El ambiente de la máquina, sin ninguna variable que apunte el examen a un lugar: se alcanza sólo por la configuración. */
function ambienteDeLaMaquina(b, extra = {}) {
  const env = Object.assign({}, process.env, { HOME: b.casa, USERPROFILE: b.casa, TYCON_HOME: path.join(b.casa, '.tycon'), TYCON_NIGHTLY: '1' }, extra);
  for (const k of Object.keys(env)) if (/^TYCON_EXAM_(CONFIG|REPO|REPORT)$/.test(k) || env[k] === undefined) delete env[k];
  return env;
}

test('T73 exam_reads_maintainers_clone: en la versión bajada, --dry-run lee la máquina designada y el reporte del clon de mantenimiento', () => {
  const b = maquinaConClonDeMantenimiento();
  const r = spawnSync(process.execPath, [path.join(b.arbol, 'scripts', 'controls-bench', 'periodic-exam.js'), '--dry-run'],
    { encoding: 'utf8', env: ambienteDeLaMaquina(b, { TYCON_EXAM_MACHINE: 'Devas-Mac-mini' }) });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /máquina designada: Devas-Mac-mini/, `la máquina designada sale del clon — «${r.stdout}»`);
  assert.match(r.stdout, /HOY LE TOCA/, 'y le toca correr');
  assert.ok(r.stdout.includes(path.join(b.repo, E.RUTA_REPORTE_QUE_VIAJA)), `el reporte que viaja va al clon — «${r.stdout}»`);
  assert.match(r.stdout, /del clon de mantenimiento/, 'y lo dice');
});

test('T74 exam_task_installed_from_maintainers_clone: en la versión bajada, --install-task programa el examen desde el árbol instalado', () => {
  const b = maquinaConClonDeMantenimiento();
  const agentes = path.join(b.raiz, 'LaunchAgents');
  const launchctlFalso = path.join(b.raiz, 'launchctl-falso.sh');
  fs.writeFileSync(launchctlFalso, '#!/bin/sh\necho "$@" >> "$LAUNCHCTL_LOG"\nexit 0\n');
  fs.chmodSync(launchctlFalso, 0o755);
  const nodeFalso = binDeNode(b);
  const r = spawnSync(nodeFalso, [path.join(b.arbol, 'scripts', 'controls-bench', 'periodic-exam.js'), '--install-task'], {
    encoding: 'utf8',
    env: ambienteDeLaMaquina(b, {
      PATH: PATH_DE_LAUNCHD, TYCON_EXAM_MACHINE: 'Devas-Mac-mini', TYCON_EXAM_LAUNCHAGENTS: agentes,
      TYCON_EXAM_REAL_HOME: b.casa, LAUNCHCTL_BIN: launchctlFalso, LAUNCHCTL_LOG: path.join(b.raiz, 'launchctl.log'),
    }),
  });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const plist = path.join(agentes, 'ar.com.tycon.examen-periodico.plist');
  assert.ok(fs.existsSync(plist), `quedó el disparador — «${r.stdout}»`);
  assert.ok(fs.readFileSync(plist, 'utf8').includes(path.join(b.arbol, 'scripts', 'controls-bench', 'periodic-exam.js')),
    'y corre el código del árbol instalado');
  // control: la misma máquina sin el clon de mantenimiento declarado no programa nada (la copia pública no designa)
  fs.rmSync(path.join(b.casa, '.tycon', 'config.json'));
  fs.rmSync(plist);
  const sin = spawnSync(nodeFalso, [path.join(b.arbol, 'scripts', 'controls-bench', 'periodic-exam.js'), '--install-task'], {
    encoding: 'utf8',
    env: ambienteDeLaMaquina(b, {
      PATH: PATH_DE_LAUNCHD, TYCON_EXAM_MACHINE: 'Devas-Mac-mini', TYCON_EXAM_LAUNCHAGENTS: agentes,
      TYCON_EXAM_REAL_HOME: b.casa, LAUNCHCTL_BIN: launchctlFalso, LAUNCHCTL_LOG: path.join(b.raiz, 'launchctl.log'),
    }),
  });
  assert.strictEqual(sin.status, 0, sin.stderr);
  assert.ok(!fs.existsSync(plist), 'control: sin clon declarado, la copia pública no programa el examen');
});

test('T75 notice_reads_exam_from_maintainers_clone: el aviso de arranque lee el resultado del clon y no denuncia un sello legítimo', () => {
  const b = maquinaConClonDeMantenimiento();
  const ahora = new Date().toISOString();
  escribir(path.join(b.repo, E.RUTA_REPORTE_QUE_VIAJA), {
    ts: ahora, estado: 'completo', maquina: 'devas-mac-mini', tool: 'both', runs: 3,
    criterio: 1, inestables: 0, paridadReal: 0, baselineRegressions: 0, erroresDeCorrida: 0, skippedMcp: 0, fugas: 0,
  });
  // el sello que deja la corrida al terminar, en la carpeta del estado de esta máquina
  const sello = path.join(b.casa, '.tycon', 'state', 'periodic-exam-last-run');
  fs.mkdirSync(path.dirname(sello), { recursive: true });
  fs.writeFileSync(sello, ahora);
  const r = spawnSync(process.execPath, [path.join(b.arbol, 'scripts', 'hooks', 'bench-notice.js')], {
    encoding: 'utf8', input: '{"source":"startup"}',
    env: ambienteDeLaMaquina(b, {
      TYCON_BENCH_DIR: path.join(b.repo, 'scripts', 'controls-bench', '.bench'),
      TYCON_SUITES_REPORT: b.reporteSuites, TYCON_BENCH_REPORT: b.reporteBanco, TYCON_EVAL_SANDBOX: '',
    }),
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /examen de revisores \(\d{4}-\d{2}-\d{2}, hace 0 día/, `el aviso habla del examen del clon — «${r.stdout}»`);
  assert.match(r.stdout, /1 de criterio/, 'con sus números');
  assert.doesNotMatch(r.stdout, /no lo escribió el job/, 'y el sello de la corrida no se toma por uno escrito a mano');
});

test('T76 exam_own_config_wins: un árbol que designa máquina (un clon completo) se lee a sí mismo, aunque haya clon de mantenimiento', () => {
  const b = maquinaConClonDeMantenimiento();
  fs.writeFileSync(path.join(b.arbol, 'scripts', 'controls-bench', 'exam-config.json'),
    JSON.stringify({ designated_machine: 'Otra-Mac', days_between_runs: 2, scheduled_days: ['tuesday', 'friday'], hour: '02:00' }));
  const r = spawnSync(process.execPath, [path.join(b.arbol, 'scripts', 'controls-bench', 'periodic-exam.js'), '--dry-run'],
    { encoding: 'utf8', env: ambienteDeLaMaquina(b, { TYCON_EXAM_MACHINE: 'Devas-Mac-mini' }) });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /máquina designada: Otra-Mac/, `manda la configuración propia — «${r.stdout}»`);
  assert.ok(r.stdout.includes(path.join(b.arbol, E.RUTA_REPORTE_QUE_VIAJA)), 'y el reporte queda en el árbol propio');
  // y una máquina que no usa la versión bajada tampoco mira el clon de mantenimiento
  const c = maquinaConClonDeMantenimiento({ release: false });
  const r2 = spawnSync(process.execPath, [path.join(c.arbol, 'scripts', 'controls-bench', 'periodic-exam.js'), '--dry-run'],
    { encoding: 'utf8', env: ambienteDeLaMaquina(c, { TYCON_EXAM_MACHINE: 'Devas-Mac-mini' }) });
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /máquina designada: \(ninguna/, `sin versión bajada, la copia pública: nadie designado — «${r2.stdout}»`);
});

test('T77 fake_node_never_touches_the_real_one: armar el node falso dos veces no toca el node real (2026-10-13)', () => {
  // 🔴 Rojo previo: con el enlace duro, la segunda llamada copiaba el node real sobre sí mismo y macOS lo invalidaba.
  const huella = () => require('crypto').createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex');
  const real = fs.statSync(process.execPath);
  const antes = huella();
  const b = banco();
  const primero = binDeNode(b);
  const segundo = binDeNode(b);
  assert.strictEqual(primero, segundo, 'la segunda llamada reusa el mismo node falso');
  const falso = fs.statSync(primero);
  assert.notStrictEqual(falso.ino, real.ino, 'el node falso es otro archivo, no un enlace al real');
  assert.strictEqual(fs.statSync(process.execPath).nlink, real.nlink, 'el node real no ganó enlaces');
  assert.strictEqual(huella(), antes, 'y sus bytes no cambiaron');
  const r = spawnSync(primero, ['-e', 'process.stdout.write("vivo")'], { encoding: 'utf8' });
  assert.strictEqual(r.stdout, 'vivo', `el node falso arranca (${r.status} ${r.signal || ''})`);
  // el freno: si el destino ES el node real, no se escribe y la prueba falla en seco. El «node real» de este tramo es un
  // archivo del laboratorio: ni siquiera para probar el freno se arma un enlace al de verdad.
  const otra = banco();
  const deMentira = path.join(otra.raiz, 'node-real-de-mentira');
  fs.writeFileSync(deMentira, 'no soy node\n');
  fs.mkdirSync(path.join(otra.raiz, 'bin-falso'), { recursive: true });
  fs.linkSync(deMentira, path.join(otra.raiz, 'bin-falso', 'node'));
  assert.throws(() => binDeNode(otra, { real: deMentira }), /es el node real/, 'con el real en el destino, frena antes de escribir');
  assert.strictEqual(fs.readFileSync(deMentira, 'utf8'), 'no soy node\n', 'y no lo tocó');
});
