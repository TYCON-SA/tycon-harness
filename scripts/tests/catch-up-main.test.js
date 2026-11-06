'use strict';
/**
 * catch-up-main.test.js — el ayudante que pone al día con main un pedido que choca sólo en los índices y las firmas.
 *
 * El caso: dos historias en paralelo suman cada una su renglón en `specs/epics.md` y `specs/sprint-status.yaml`, y su
 * firma en `.tycon/runtime-waivers.jsonl`. La que entra segunda choca en esos tres archivos, aunque los dos lados sólo
 * sumaron renglones. El ayudante trae `origin/main`, junta los dos lados de esos tres archivos y commitea el merge con
 * los controles de siempre; cualquier otro choque lo deja como estaba.
 *
 * Cada prueba arma en una carpeta temporal un remoto vacío y un clon con una rama y un main que divergen, con su propia
 * HOME y sin la configuración global de git, y corre el ayudante como lo corre una persona. Las firmas son reales
 * (`appendWaiver`), así que la cadena se verifica de verdad.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const HELPER = path.join(REPO, 'scripts', 'tools', 'catch-up-main.js');
const waiverLib = require(path.join(REPO, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'runtime-waiver.js'));
const { sinGitDelPadre } = require(path.join(REPO, 'scripts', 'lib', 'clean-git-env.js'));

const SUSTITUTO_DIR = path.join(__dirname, 'fixtures', 'git-in-spanish');
const WINDOWS = process.platform === 'win32';
const SIN_SUSTITUTO = WINDOWS ? 'el git sustituto no corre en Windows: T4 cubre el mismo camino' : false;

const FECHA = '2026-11-05T12:00:00Z';
const EPICS = 'specs/epics.md';
const SPRINT = 'specs/sprint-status.yaml';
const FIRMAS = '.tycon/runtime-waivers.jsonl';

/** La ruta del git de verdad, buscada en el PATH (sin el sustituto). */
function gitDeVerdad() {
  const nombres = WINDOWS ? ['git.exe', 'git.cmd'] : ['git'];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir || path.resolve(dir) === SUSTITUTO_DIR) continue;
    for (const n of nombres) {
      const p = path.join(dir, n);
      try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch (_) { /* sigo */ }
    }
  }
  throw new Error('no encontré git en el PATH');
}

/** El entorno de un laboratorio: su HOME, sin la configuración de la máquina ni las variables de un hook de git. */
function entorno(home, extra = {}) {
  const env = sinGitDelPadre();
  for (const k of ['LC_ALL', 'LC_MESSAGES', 'LANGUAGE', 'LANG', 'NODE_TEST_CONTEXT', 'TYCON_HOME']) delete env[k];
  return {
    ...env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA, ...extra,
  };
}

const epicsBase = [
  '# Épicas', '', '| Id | Historia | Dep | Estado |', '|---|---|---|---|',
  '| 8.0 | la primera | — | hecha |', '| 8.1 | la base | — | hecha |', '| 8.2 | la de la rama | — | lista |', '',
];
const sprintBase = ['development_status:', '  8-0-primera: done', '  8-1-base: done', '  8-2-rama: ready-for-dev', ''];

function firma(repo, story, ts) {
  waiverLib.appendWaiver({ story, acs: [1], matrixHash: 'h', approvedBy: 'deva', nowIso: ts,
    declHashByAc: { 1: waiverLib.declHashFor('razón', 'T1') }, logPath: path.join(repo, FIRMAS) });
}

/**
 * Arma el remoto y el clon. `ramaHace` y `mainHace` reciben `{ leer, escribir, git }` del clon y cambian los archivos;
 * después cada lado commitea lo suyo. main se empuja al remoto; la rama, también (sin el merge).
 */
function armar(t, { ramaHace, mainHace } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-catch-up-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const remoto = path.join(base, 'remoto.git');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(home);
  const env = entorno(home);
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', ...a], { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remoto], { env, stdio: 'ignore' });
  fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main', '.');
  git('remote', 'add', 'origin', remoto);
  const ruta = (rel) => path.join(repo, rel);
  const leer = (rel) => fs.readFileSync(ruta(rel), 'utf8');
  const escribir = (rel, txt) => { fs.mkdirSync(path.dirname(ruta(rel)), { recursive: true }); fs.writeFileSync(ruta(rel), txt); };
  const sumar = (rel, renglon) => {
    const ls = leer(rel).split('\n');
    ls.splice(ls.length - 1, 0, renglon);
    escribir(rel, ls.join('\n'));
  };
  escribir(EPICS, epicsBase.join('\n'));
  escribir(SPRINT, sprintBase.join('\n'));
  escribir('codigo.js', 'module.exports = 1;\n');
  firma(repo, '8.1', '2026-11-01T10:00:00.000Z');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  git('push', '-q', 'origin', 'main');
  const lab = { base, home, remoto, repo, env, git, leer, escribir, sumar, ruta };

  git('checkout', '-q', '-b', 'rama');
  (ramaHace || ((l) => {
    l.sumar(EPICS, '| 8.3 | la nueva de la rama | — | lista |');
    l.sumar(SPRINT, '  8-3-nueva-rama: ready-for-dev');
    firma(repo, '8.3', '2026-11-05T09:00:00.000Z');
  }))(lab);
  git('add', '-A'); git('commit', '-q', '-m', 'rama');
  git('push', '-q', 'origin', 'rama');

  git('checkout', '-q', 'main');
  (mainHace || ((l) => {
    l.sumar(EPICS, '| 8.4 | la que entró a main | — | lista |');
    l.sumar(SPRINT, '  8-4-entro-a-main: ready-for-dev');
    firma(repo, '8.4', '2026-11-05T08:00:00.000Z');
  }))(lab);
  git('add', '-A'); git('commit', '-q', '-m', 'main');
  git('push', '-q', 'origin', 'main');
  git('checkout', '-q', 'rama');
  git('reset', '-q', '--hard', 'origin/rama');
  lab.antes = git('rev-parse', 'HEAD').trim();
  return lab;
}

function correr(lab, args = [], extra = {}) {
  const r = spawnSync(process.execPath, [HELPER, '--repo', lab.repo, ...args], { encoding: 'utf8', env: { ...lab.env, ...extra } });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const enCurso = (lab) => fs.existsSync(path.join(lab.repo, '.git', 'MERGE_HEAD'));
const sinMarcas = (txt) => !/^(<<<<<<<|=======|>>>>>>>)/m.test(txt);
const cuenta = (txt, re) => txt.split('\n').filter((l) => re.test(l)).length;

/** Lo que se espera de T4: un merge commiteado con los renglones y las firmas de los dos lados. */
function comprobarT4(lab, r) {
  assert.equal(r.code, 0, r.out);
  assert.equal(enCurso(lab), false, 'no queda un merge en curso');
  const padres = lab.git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ');
  assert.equal(padres.length, 3, 'HEAD es un commit de merge');
  assert.equal(padres[1], lab.antes);
  const epics = lab.leer(EPICS);
  const sprint = lab.leer(SPRINT);
  for (const txt of [epics, sprint, lab.leer(FIRMAS)]) assert.ok(sinMarcas(txt), txt);
  assert.match(epics, /\| 8\.3 \|/); assert.match(epics, /\| 8\.4 \|/);
  assert.match(sprint, /8-3-nueva-rama:/); assert.match(sprint, /8-4-entro-a-main:/);
  assert.match(r.out, /specs\/epics\.md/);
  const msg = lab.git('log', '-1', '--format=%B');
  for (const f of [EPICS, SPRINT, FIRMAS]) assert.ok(msg.includes(f), `el mensaje nombra ${f}:\n${msg}`);
}

test('T4 Ayudante_ChocaSoloEnLosTres_ResuelveYCommitea', (t) => {
  const lab = armar(t);
  comprobarT4(lab, correr(lab));
  assert.equal(lab.git('rev-parse', 'origin/rama').trim(), lab.antes, 'sin --push no empuja');
});

test('T5 Ayudante_RenglonPropioCambiado_QuedaElDeLaRama', (t) => {
  const lab = armar(t, {
    ramaHace: (l) => {
      l.escribir(EPICS, l.leer(EPICS).replace('| 8.2 | la de la rama | — | lista |', '| 8.2 | la de la rama | — | en revisión |'));
      l.escribir(SPRINT, l.leer(SPRINT).replace('8-2-rama: ready-for-dev', '8-2-rama: review'));
    },
  });
  const r = correr(lab);
  assert.equal(r.code, 0, r.out);
  const epics = lab.leer(EPICS);
  const sprint = lab.leer(SPRINT);
  assert.equal(cuenta(epics, /^\| 8\.2 \|/), 1, epics);
  assert.match(epics, /\| 8\.2 \| la de la rama \| — \| en revisión \|/);
  assert.equal(cuenta(sprint, /^\s*8-2-rama:/), 1, sprint);
  assert.match(sprint, /8-2-rama: review/);
  assert.match(epics, /\| 8\.4 \|/);
});

test('T6 Ayudante_RepetidoQueYaVeniaDeMain_NoSeToca', (t) => {
  const lab = armar(t, {
    ramaHace: (l) => {
      l.escribir(EPICS, l.leer(EPICS).replace('| 8.2 | la de la rama | — | lista |', '| 8.2 | la de la rama | — | en revisión |'));
    },
    mainHace: (l) => {
      // una copia de 8.0 arriba, lejos del choque, y un renglón al lado del de la rama
      l.escribir(EPICS, l.leer(EPICS).replace('| 8.0 | la primera | — | hecha |', '| 8.0 | la primera | — | hecha |\n| 8.0 | la primera, copia | — | hecha |'));
      l.sumar(EPICS, '| 8.4 | la que entró a main | — | lista |');
    },
  });
  const r = correr(lab);
  assert.equal(r.code, 0, r.out);
  const epics = lab.leer(EPICS);
  assert.equal(cuenta(epics, /^\| 8\.0 \|/), 2, `la repetida de main sigue con sus dos copias:\n${epics}`);
  assert.equal(cuenta(epics, /^\| 8\.2 \|/), 1, epics);
  assert.match(epics, /\| 8\.2 \| la de la rama \| — \| en revisión \|/);
});

test('T7 Ayudante_Firmas_TodasYEnOrden', (t) => {
  const lab = armar(t);
  const r = correr(lab);
  assert.equal(r.code, 0, r.out);
  const lineas = lab.leer(FIRMAS).split('\n').filter(Boolean);
  const filas = lineas.map((l) => JSON.parse(l));
  assert.deepEqual(filas.map((f) => f.story), ['8.1', '8.4', '8.3'], 'las tres, en orden de ts');
  assert.equal(new Set(lineas).size, lineas.length, 'ninguna repetida');
  const v = waiverLib.verifyChain(lab.ruta(FIRMAS));
  assert.equal(v.ok, true, JSON.stringify(v.discarded));
  assert.equal(v.entries.length, 3);
});

test('T8 Ayudante_ChoqueEnOtroArchivo_NoTocaNada', async (t) => {
  await t.test('además choca un .js', (t) => {
    const lab = armar(t, {
      ramaHace: (l) => { l.sumar(EPICS, '| 8.3 | la nueva de la rama | — | lista |'); l.escribir('codigo.js', 'module.exports = 2;\n'); },
      mainHace: (l) => { l.sumar(EPICS, '| 8.4 | la que entró a main | — | lista |'); l.escribir('codigo.js', 'module.exports = 3;\n'); },
    });
    const r = correr(lab);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /codigo\.js/);
    assert.equal(lab.git('rev-parse', 'HEAD').trim(), lab.antes);
    assert.equal(enCurso(lab), false);
    assert.equal(lab.git('status', '--porcelain').trim(), '');
  });
  await t.test('main borró sprint-status.yaml y la rama lo cambió', (t) => {
    const lab = armar(t, {
      ramaHace: (l) => { l.escribir(SPRINT, l.leer(SPRINT).replace('8-2-rama: ready-for-dev', '8-2-rama: review')); },
      mainHace: (l) => { fs.rmSync(l.ruta(SPRINT)); },
    });
    const r = correr(lab);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /sprint-status\.yaml/);
    assert.equal(lab.git('rev-parse', 'HEAD').trim(), lab.antes);
    assert.equal(enCurso(lab), false);
    assert.equal(lab.git('status', '--porcelain').trim(), '');
  });
});

test('T9 Ayudante_Empuje_NormalYSinForzar', async (t) => {
  await t.test('con --push empuja la rama', (t) => {
    const lab = armar(t);
    const r = correr(lab, ['--push']);
    assert.equal(r.code, 0, r.out);
    const local = lab.git('rev-parse', 'HEAD').trim();
    const remota = execFileSync('git', ['--git-dir', lab.remoto, 'rev-parse', 'refs/heads/rama'], { env: lab.env, encoding: 'utf8' }).trim();
    assert.equal(remota, local);
  });
  await t.test('con el remoto adelantado sale 3 y no lo pisa', (t) => {
    const lab = armar(t);
    // otro empuja a la rama remota antes: un commit que el clon no tiene
    const otro = path.join(lab.base, 'otro');
    execFileSync('git', ['clone', '-q', '-b', 'rama', lab.remoto, otro], { env: lab.env, stdio: 'ignore' });
    fs.writeFileSync(path.join(otro, 'otro.txt'), 'de otro\n');
    execFileSync('git', ['add', 'otro.txt'], { cwd: otro, env: lab.env });
    execFileSync('git', ['-c', 'maintenance.auto=false', 'commit', '-q', '-m', 'otro'], { cwd: otro, env: lab.env });
    execFileSync('git', ['push', '-q', 'origin', 'rama'], { cwd: otro, env: lab.env, stdio: 'ignore' });
    const delOtro = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: otro, env: lab.env, encoding: 'utf8' }).trim();
    const r = correr(lab, ['--push']);
    assert.equal(r.code, 3, r.out);
    const remota = execFileSync('git', ['--git-dir', lab.remoto, 'rev-parse', 'refs/heads/rama'], { env: lab.env, encoding: 'utf8' }).trim();
    assert.equal(remota, delOtro, 'la rama remota no cambió');
  });
});

test('T10 Ayudante_AlDiaOSucia_NoEmpieza', async (t) => {
  await t.test('al día', (t) => {
    const lab = armar(t);
    lab.git('merge', '-q', '--no-edit', 'origin/main', '-X', 'ours');
    const antes = lab.git('rev-parse', 'HEAD').trim();
    const r = correr(lab);
    assert.equal(r.code, 0, r.out);
    assert.equal(lab.git('rev-parse', 'HEAD').trim(), antes);
    assert.equal(enCurso(lab), false);
  });
  await t.test('con un cambio sin commitear', (t) => {
    const lab = armar(t);
    lab.escribir('codigo.js', 'module.exports = 9;\n');
    const r = correr(lab);
    assert.equal(r.code, 2, r.out);
    assert.equal(lab.git('rev-parse', 'HEAD').trim(), lab.antes);
    assert.equal(enCurso(lab), false);
    assert.equal(lab.leer('codigo.js'), 'module.exports = 9;\n');
  });
});

test('T11 Ayudante_GitEnCastellano_IgualQueEnIngles', { skip: SIN_SUSTITUTO }, (t) => {
  const lab = armar(t);
  const registro = path.join(lab.base, 'llamadas.log');
  const r = correr(lab, [], {
    GIT_DE_VERDAD: gitDeVerdad(), GIT_SUSTITUTO_LOG: registro, LANG: 'es_AR.UTF-8',
    PATH: `${SUSTITUTO_DIR}${path.delimiter}${process.env.PATH || ''}`,
  });
  comprobarT4(lab, r);
  // una línea por llamada, `<idioma>\t<argumentos>`; un argumento de varias líneas (el mensaje del commit) sigue sin tab
  const llamadas = fs.readFileSync(registro, 'utf8').split('\n').filter((l) => l.includes('\t'));
  assert.ok(llamadas.length > 0, 'el ayudante pasó por el git sustituto');
  assert.deepEqual(llamadas.filter((l) => !l.startsWith('C\t')), [], 'todas las llamadas con el idioma fijo');
});

test('T12 Ayudante_ControlRechazaElCommit_DeshaceYSale4', { skip: WINDOWS ? 'un gancho de shell no corre igual en Windows' : false }, (t) => {
  const lab = armar(t);
  const gancho = path.join(lab.repo, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(gancho, '#!/bin/sh\necho "control de laboratorio: este commit no pasa" >&2\nexit 1\n');
  fs.chmodSync(gancho, 0o755);
  const r = correr(lab);
  assert.equal(r.code, 4, r.out);
  assert.match(r.out, /control de laboratorio: este commit no pasa/);
  assert.equal(lab.git('rev-parse', 'HEAD').trim(), lab.antes);
  assert.equal(enCurso(lab), false);
  assert.equal(lab.git('status', '--porcelain').trim(), '');
});

test('T13 Ayudante_SinRemotoOSinRelacion_Sale5', async (t) => {
  await t.test('un remoto que no existe', (t) => {
    const lab = armar(t);
    lab.git('remote', 'set-url', 'origin', path.join(lab.base, 'no-existe.git'));
    const r = correr(lab);
    assert.equal(r.code, 5, r.out);
    assert.match(r.out, /no-existe\.git|does not appear|not a git repository/i);
    assert.equal(enCurso(lab), false);
    assert.equal(lab.git('rev-parse', 'HEAD').trim(), lab.antes);
  });
  await t.test('una rama sin historia común con main', (t) => {
    const lab = armar(t);
    const ajeno = path.join(lab.base, 'ajeno');
    fs.mkdirSync(ajeno);
    const g = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', ...a], { cwd: ajeno, env: lab.env, stdio: 'ignore' });
    g('init', '-q', '-b', 'main', '.');
    fs.writeFileSync(path.join(ajeno, 'otra.txt'), 'otra historia\n');
    g('add', '-A'); g('commit', '-q', '-m', 'otra');
    g('push', '-q', '--force', lab.remoto, 'main:main');
    const r = correr(lab);
    assert.equal(r.code, 5, r.out);
    assert.match(r.out, /unrelated/i);
    assert.equal(enCurso(lab), false);
    assert.equal(lab.git('rev-parse', 'HEAD').trim(), lab.antes);
  });
});

test('Ayudante_MergeYaEnCurso_NoEmpieza', (t) => {
  const lab = armar(t);
  lab.git('fetch', '-q', 'origin');
  try { lab.git('merge', '--no-commit', '--no-ff', 'origin/main'); } catch (_) { /* choca: queda en curso */ }
  assert.equal(enCurso(lab), true);
  const r = correr(lab);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /merge en curso/);
  assert.equal(enCurso(lab), true, 'no toca el merge de la persona');
});

// Con los índices generados (la cabecera de story-index.js en la versión de main), el choque en los dos índices no se
// une: se regeneran desde el frontmatter mezclado. Las firmas siguen por unión.
test('CatchUpMain_RegeneratesIndexesInsteadOfUnion (T15) @story-8.226 @ac-10', (t) => {
  const INDEX = path.join(REPO, 'scripts', 'tools', 'story-index.js');
  const historia = (n, titulo) => `---\nepic: 8\nstory: "${n}"\ntitle: "${titulo}"\nstatus: ready-for-dev\n---\n\n# Story ${n}: ${titulo}\n`;
  const generar = (l) => {
    const r = spawnSync(process.execPath, [INDEX, '--repo', l.repo, '--write'], { encoding: 'utf8', env: l.env });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  };
  const lab = armar(t, {
    ramaHace: (l) => { l.escribir('specs/story-8.3-nueva-rama.md', historia('8.3', 'La nueva de la rama')); generar(l); firma(l.repo, '8.3', '2026-11-05T09:00:00.000Z'); },
    mainHace: (l) => { l.escribir('specs/story-8.4-entro-a-main.md', historia('8.4', 'La que entró a main')); generar(l); firma(l.repo, '8.4', '2026-11-05T08:00:00.000Z'); },
  });
  const r = correr(lab);
  assert.equal(r.code, 0, r.out);
  assert.equal(enCurso(lab), false, 'el merge quedó commiteado');
  const sprint = lab.leer(SPRINT);
  assert.ok(sinMarcas(sprint) && sinMarcas(lab.leer(EPICS)));
  assert.match(sprint, /^ {2}8-3-nueva-rama: ready-for-dev\n {2}8-4-entro-a-main: ready-for-dev$/m, 'regenerado desde las dos historias');
  assert.ok(sprint.startsWith('# Generado por scripts/tools/story-index.js'), 'con la cabecera del generado, no una unión');
  const chk = spawnSync(process.execPath, [INDEX, '--repo', lab.repo, '--check'], { encoding: 'utf8', env: lab.env });
  assert.equal(chk.status, 0, `el índice commiteado es el generado: ${chk.stdout}`);
  assert.equal(cuenta(lab.leer(FIRMAS), /"story":"8\.[34]"/), 2, 'las firmas siguen por unión');
  assert.match(r.out, /se regeneraron desde el frontmatter/);
});

test('Ayudante_FirmaSinHora_NoResuelveYDejaLaRama', (t) => {
  const lab = armar(t, {
    mainHace: (l) => {
      l.sumar(EPICS, '| 8.4 | la que entró a main | — | lista |');
      fs.appendFileSync(l.ruta(FIRMAS), '{"story":"8.4","acs":[1]}\n');
    },
  });
  const r = correr(lab);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /runtime-waivers\.jsonl/);
  assert.match(r.out, /Dejé la rama como estaba/);
  assert.equal(lab.git('rev-parse', 'HEAD').trim(), lab.antes);
  assert.equal(enCurso(lab), false);
  assert.equal(lab.git('status', '--porcelain').trim(), '');
});
