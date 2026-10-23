'use strict';

/**
 * deprecated-notices.test.js — los avisos del código deprecado: al arrancar, al leer y en la foto de la noche.
 *
 * El arranque le da al modelo la lista con su regla, y avisa una vez por día y repo de las entradas podridas. Al leer
 * un archivo deprecado (Read, o `cat`/`sed -n`/`head` por la terminal, también desde Codex) el arnés agrega el aviso una
 * vez por archivo y sesión. La noche suma las entradas podridas a la foto del repo.
 *
 * Cada caso corre con su propia casa (HOME y USERPROFILE): el estado de los avisos nunca toca el de la máquina.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SESSION = path.join(ROOT, 'scripts', 'hooks', 'deprecated-session-notice.js');
const READ = path.join(ROOT, 'scripts', 'hooks', 'deprecated-read-notice.js');

// fechas fijas y sin el mantenimiento automático de git: el mismo repo de juguete en cada corrida
const GIT_ENV = { ...process.env, GIT_AUTHOR_DATE: '2026-10-22T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-22T12:00:00Z' };
function git(dir, ...args) { spawnSync('git', ['-C', dir, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { stdio: 'ignore', env: GIT_ENV }); }

function repo(yaml, archivos = {}) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deprec-av-')));
  fs.mkdirSync(path.join(d, '.tycon'), { recursive: true });
  git(d, 'init', '-q', '-b', 'main', '.');
  for (const [rel, txt] of Object.entries({ 'README.md': 'x\n', ...archivos })) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), txt);
  }
  if (yaml != null) fs.writeFileSync(path.join(d, '.tycon', 'advisors.yaml'), yaml);
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'base');
  return d;
}

function casa() { return fs.mkdtempSync(path.join(os.tmpdir(), 'deprec-casa-')); }

function correr(script, home, evento, env = {}) {
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify(evento),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ...env },
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function entradas(n, { desde = 0 } = {}) {
  const out = ['deprecated:', '  paths:'];
  for (let i = desde; i < desde + n; i++) out.push(`    - path: "src/viejo${i}/**"`, '      level: frozen', `      reason: "motivo ${i}"`);
  return out.join('\n') + '\n';
}

function archivosPara(n) {
  const a = {};
  for (let i = 0; i < n; i++) a[`src/viejo${i}/a.js`] = 'x\n';
  return a;
}

test('Arranque_InstruccionDesdeLaLista', () => {
  const tres = repo(entradas(3), archivosPara(3));
  const r3 = correr(SESSION, casa(), { cwd: tres, session_id: 's1', hook_event_name: 'SessionStart' }, { TYCON_TODAY: '2026-10-22' });
  assert.equal(r3.code, 0);
  for (let i = 0; i < 3; i++) assert.match(r3.stdout, new RegExp(`src/viejo${i}/\\*\\* — congelado: motivo ${i}`));
  assert.match(r3.stdout, /no lo tomes de ejemplo/);
  assert.match(r3.stdout, /deprecated_reason:/);

  const veinticinco = repo(entradas(25), archivosPara(25));
  const r25 = correr(SESSION, casa(), { cwd: veinticinco, session_id: 's1' }, { TYCON_TODAY: '2026-10-22' });
  assert.equal((r25.stdout.match(/ — congelado: /g) || []).length, 20);
  assert.match(r25.stdout, /faltan 5/);
  assert.match(r25.stdout, /\.tycon\/advisors\.yaml/);

  const sinLista = repo(null);
  const r0 = correr(SESSION, casa(), { cwd: sinLista, session_id: 's1' });
  assert.equal(r0.code, 0);
  assert.equal(r0.stdout.trim(), '');
});

test('Arranque_ListaPodrida_AvisaUnaVezPorDia', () => {
  const yaml = [
    'deprecated:',
    '  paths:',
    '    - path: src/ya-no-esta',
    '      level: dead',
    '      reason: "se borró"',
    '    - path: "src/vencido/**"',
    '      level: frozen',
    '      reason: "hay que decidir"',
    '      review_by: 2026-01-31',
    '    - path: "src/sano/**"',
    '      level: frozen',
    '      reason: "todavía no"',
    '      review_by: 2027-01-31',
  ].join('\n') + '\n';
  const d = repo(yaml, { 'src/vencido/a.js': 'x\n', 'src/sano/b.js': 'x\n' });
  const h = casa();
  const primero = correr(SESSION, h, { cwd: d, session_id: 's1' }, { TYCON_TODAY: '2026-10-22' });
  assert.match(primero.stdout, /src\/ya-no-esta: la ruta ya no alcanza ningún archivo/);
  assert.match(primero.stdout, /src\/vencido\/\*\*: pasó su fecha de revisión \(2026-01-31\)/);
  assert.doesNotMatch(primero.stdout, /src\/sano\/\*\*:/);
  const segundo = correr(SESSION, h, { cwd: d, session_id: 's2' }, { TYCON_TODAY: '2026-10-22' });
  assert.doesNotMatch(segundo.stdout, /ya no alcanza|pasó su fecha/, 'el mismo día, una sola vez');
  assert.match(segundo.stdout, /no lo tomes de ejemplo/, 'la instrucción sí va en cada arranque');
  const otroDia = correr(SESSION, h, { cwd: d, session_id: 's3' }, { TYCON_TODAY: '2026-10-23' });
  assert.match(otroDia.stdout, /ya no alcanza/);
});

const LISTA = 'deprecated:\n  paths:\n    - path: "src/legacy/**"\n      level: frozen\n      reason: "reemplazado por src/billing"\n';

function contexto(r) {
  if (!r.stdout.trim()) return '';
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

test('Leer_ArchivoDeprecado_AgregaElAviso', () => {
  const d = repo(LISTA, { 'src/legacy/x.js': 'x\n' });
  const r = correr(READ, casa(), {
    hook_event_name: 'PostToolUse', session_id: 's1', cwd: d,
    tool_name: 'Read', tool_input: { file_path: path.join(d, 'src/legacy/x.js') },
  });
  assert.equal(r.code, 0);
  const c = contexto(r);
  assert.match(c, /deprecado \(congelado\): reemplazado por src\/billing — no lo uses de ejemplo/);
  assert.match(c, /src\/legacy\/x\.js/);
});

test('Leer_UnaVezPorArchivo', () => {
  const d = repo(LISTA, { 'src/legacy/x.js': 'x\n', 'src/vivo.js': 'x\n' });
  const h = casa();
  const ev = (f, sid = 's1') => ({ hook_event_name: 'PostToolUse', session_id: sid, cwd: d, tool_name: 'Read', tool_input: { file_path: path.join(d, f) } });
  assert.notEqual(contexto(correr(READ, h, ev('src/legacy/x.js'))), '');
  assert.equal(contexto(correr(READ, h, ev('src/legacy/x.js'))), '', 'la segunda lectura en la sesión, nada');
  assert.notEqual(contexto(correr(READ, h, ev('src/legacy/x.js', 's2'))), '', 'otra sesión, de nuevo');
  assert.equal(contexto(correr(READ, h, ev('src/vivo.js'))), '', 'un archivo vivo, nada');
});

test('Leer_PorLaTerminal_TambienEnCodex', () => {
  const d = repo(LISTA, { 'src/legacy/a.js': 'x\n', 'src/legacy/b.js': 'x\n', 'src/legacy/c.js': 'x\n' });
  const comandos = ['cat src/legacy/a.js', "sed -n '1,20p' src/legacy/b.js", 'head -40 src/legacy/c.js'];
  for (const herramienta of ['claude', 'codex']) {
    const h = casa();
    for (const command of comandos) {
      const ev = { hook_event_name: 'PostToolUse', session_id: `s-${herramienta}`, cwd: d, tool_name: 'Bash', tool_input: { command } };
      if (herramienta === 'codex') ev.turn_id = 't1';
      const c = contexto(correr(READ, h, ev));
      assert.match(c, /deprecado \(congelado\)/, `${herramienta}: ${command}`);
    }
  }
  // `sed -i` es escribir, no leer: no trae el aviso de lectura, sino el de escritura (modo warn)
  const r = correr(READ, casa(), { hook_event_name: 'PostToolUse', session_id: 's9', cwd: d, tool_name: 'Bash', tool_input: { command: 'sed -i s/x/y/ src/legacy/a.js' } });
  assert.doesNotMatch(contexto(r), /— no lo uses de ejemplo/);
  assert.match(contexto(r), /Ojo: src\/legacy\/a\.js está deprecado/);
});

test('Noche_ListaPodridaEnElResumen', () => {
  const story = [
    '---', 'epic: 1', 'story: "1.1"', 'title: "una"', 'status: ready-for-dev', '---', '', '# Story 1.1', '',
  ].join('\n');
  const yaml = 'deprecated:\n  paths:\n    - path: src/ya-no-esta\n      level: dead\n      reason: "se borró"\n';
  const d = repo(yaml, { 'specs/story-1.1-una.md': story });
  const r = spawnSync(process.execPath, ['-e', `
    const s = require(${JSON.stringify(path.join(ROOT, 'scripts', 'nightly', 'projects', 'snapshot.js'))});
    const f = s.fotoDeRepo(${JSON.stringify(d)}, {});
    process.stdout.write(JSON.stringify(f.alertas || f));
  `], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: casa(), TYCON_TODAY: '2026-10-22' } });
  const alertas = JSON.parse(r.stdout);
  const podrida = alertas.find((a) => a.tipo === 'deprecado_podrido');
  assert.ok(podrida, `la foto trae la entrada podrida: ${r.stdout}${r.stderr}`);
  assert.match(podrida.detalle, /src\/ya-no-esta/);
});

test('Adversarial_EscribirPorLaTerminalEnWarn_LeLlegaAlModelo', () => {
  const d = repo('deprecated:\n  paths:\n    - path: docs/viejo\n      level: dead\n      reason: "no se usa"\n', { 'docs/viejo/n.txt': 'a\n' });
  const r = correr(READ, casa(), { hook_event_name: 'PostToolUse', session_id: 's1', cwd: d, tool_name: 'Bash', tool_input: { command: 'sed -i s/a/b/ docs/viejo/n.txt' } });
  assert.match(contexto(r), /docs\/viejo\/n\.txt está deprecado \(muerto\): no se usa/);
  const bloqueado = repo('deprecated:\n  edit: block\n  paths:\n    - path: docs/viejo\n      level: dead\n      reason: "no se usa"\n', { 'docs/viejo/n.txt': 'a\n' });
  const r2 = correr(READ, casa(), { hook_event_name: 'PostToolUse', session_id: 's1', cwd: bloqueado, tool_name: 'Bash', tool_input: { command: 'sed -i s/a/b/ docs/viejo/n.txt' } });
  assert.equal(contexto(r2), '', 'con block el comando no corrió: no hay nada que avisar después');
});

function foto(d) {
  const r = spawnSync(process.execPath, ['-e', `
    const s = require(${JSON.stringify(path.join(ROOT, 'scripts', 'nightly', 'projects', 'snapshot.js'))});
    process.stdout.write(JSON.stringify(s.fotoDeRepo(${JSON.stringify(d)}, {}).alertas));
  `], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: casa(), TYCON_TODAY: '2026-10-22' } });
  return JSON.parse(r.stdout);
}

test('Noche_FechaVencidaYListaIlegible', () => {
  const story = ['---', 'epic: 1', 'story: "1.1"', 'title: "una"', 'status: ready-for-dev', '---', ''].join('\n');
  const vencida = repo('deprecated:\n  paths:\n    - path: "src/v/**"\n      level: frozen\n      reason: "r"\n      review_by: 2026-01-01\n',
    { 'specs/story-1.1-una.md': story, 'src/v/a.js': 'x\n' });
  assert.ok(foto(vencida).some((a) => a.tipo === 'deprecado_podrido' && /2026-01-01/.test(a.detalle)));
  const ilegible = repo('deprecated:\n  paths:\n\t- path: x\n', { 'specs/story-1.1-una.md': story });
  const a = foto(ilegible).find((x) => x.tipo === 'deprecado_no_medido');
  assert.ok(a, '«no pude mirar» no se ve igual que «está sana»');
  assert.match(a.detalle, /tabulador/);
});

test('Arranque_ListaIlegible_LoDiceUnaVezPorDiaYQuedaAnotado', () => {
  const d = repo('deprecated:\n  paths:\n\t- path: x\n');
  const h = casa();
  const r = correr(SESSION, h, { cwd: d, session_id: 's1' }, { TYCON_TODAY: '2026-10-22' });
  assert.match(r.stdout, /no se pudo leer/);
  assert.match(r.stdout, /tabulador/);
  assert.doesNotMatch(correr(SESSION, h, { cwd: d, session_id: 's2' }, { TYCON_TODAY: '2026-10-22' }).stdout, /no se pudo leer/);
  const log = fs.readdirSync(h, { recursive: true }).find((f) => String(f).endsWith('gates.log'));
  assert.ok(log && /unknown-config-ilegible/.test(fs.readFileSync(path.join(h, log), 'utf8')), 'queda en gates.log');
});
