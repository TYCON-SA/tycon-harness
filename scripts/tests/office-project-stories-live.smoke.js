#!/usr/bin/env node
'use strict';
// office-project-stories-live.smoke.js — las historias de tus proyectos en la oficina, con las herramientas de verdad:
// la lectura de fondo (`project-stories.js --refresh`) y la foto de la oficina (`office.js --json`), con una HOME de
// juguete sobre repos de git reales en carpetas temporales. Mira cada criterio en lo que dejan las dos: qué repos entran,
// qué historias, quién, el aviso de la lectura, el candado, que no se escribe en ningún clon y lo que no viaja al sitio.
//
//   node scripts/tests/office-project-stories-live.smoke.js     sale 0 si todo pasó; 1 si algo no
//
// stable-data: las conversaciones y el FETCH_HEAD se fechan con el reloj real a propósito: la lectura mira los últimos
// 7 días y la hora del FETCH_HEAD contra la de la máquina.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const READER = path.join(ROOT, 'scripts', 'tools', 'office', 'project-stories.js');
const OFFICE = path.join(ROOT, 'scripts', 'tools', 'office.js');
const { stateDir, claudeDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
const { pick } = require(path.join(ROOT, 'scripts', 'tools', 'office', 'fields.js'));

const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'ok ' : 'MAL'} ${what}`); if (!ok) fails.push(what); };
const HOUR = 3600e3;
const EMAIL = 'ana@acme.example';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-8185-lectura-')));
const roots = path.join(home, 'SourceCode');
const sdir = stateDir(home);
for (const d of ['active', 'adhoc', 'doing', 'coordination']) fs.mkdirSync(path.join(sdir, d), { recursive: true });
fs.writeFileSync(path.join(home, '.gitconfig'), `[user]\n\temail = ${EMAIL}\n\tname = Ana\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n[maintenance]\n\tauto = false\n`);
const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_REPOS_ROOT: roots, TYCON_OFFICE_LINK: '0', TYCON_OFFICE_NO_BROWSER: '1' };

function git(cwd, args, more = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...env, ...more } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const story = (id, status, extra = '') => `---\nstory: "${id}"\ntitle: "La historia ${id}"\nstatus: ${status}\n${extra}---\n\n# Story ${id}\n`;

/** Un repo con sus archivos commiteados por `author`, su remoto y, si `fetched`, su `origin/main`. */
function repo(name, files, { author = EMAIL, fetched = true } = {}) {
  const d = path.join(roots, name);
  fs.mkdirSync(d, { recursive: true });
  git(d, ['init', '-q']);
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text); }
  fs.writeFileSync(path.join(d, 'LEEME.md'), name);
  git(d, ['add', '-A']);
  git(d, ['-c', `user.email=${author}`, 'commit', '-qm', 'inicio']);
  git(d, ['remote', 'add', 'origin', `https://github.com/acme/${name}.git`]);
  if (fetched) git(d, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return d;
}

/** Una conversación de Claude en `cwd`, de hace `days` días, con su forma de lanzarse. */
let conv = 0;
function session(cwd, { days = 0, entrypoint = 'cli' } = {}) {
  const dir = path.join(claudeDir(home), 'projects', `p${conv}`);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `c${conv}.jsonl`);
  conv += 1;
  fs.writeFileSync(f, `${JSON.stringify({ cwd, entrypoint })}\n`);
  const t = (Date.now() - days * 24 * HOUR) / 1000;
  fs.utimesSync(f, t, t);
}

// ---- la máquina de juguete ----
const acme = repo('acme', {
  'specs/story-1.1-lista.md': story('1.1', 'ready-for-dev', 'priority: P1\nwork_item: 6402\n'),
  'specs/story-1.2-ñandú.md': story('1.2', 'in-progress', 'priority: P0\n'),
  'specs/story-1.3-revisada.md': story('1.3', 'ready-for-review'),
  'specs/story-1.4-hecha.md': story('1.4', 'done'),
  'specs/story-1.5-borrador.md': story('1.5', 'draft'),
  'specs/story-1.6-rara.md': story('1.6', 'pensandolo'),
  'specs/story-1.7-con-ejecucion.md': story('1.7', 'in-progress'),
  'specs/story-1.8-con-fila.md': story('1.8', 'ready-for-dev'),
  'specs/story-1.9-bom.md': `\uFEFF${story('1.9', 'ready-for-dev')}`,
});
// la copia de trabajo atrasada dice lista una historia que en la rama traída está terminada
fs.writeFileSync(path.join(acme, 'specs', 'story-1.4-hecha.md'), story('1.4', 'ready-for-dev'));
const fetchHead = path.join(acme, '.git', 'FETCH_HEAD');
fs.writeFileSync(fetchHead, '');
const fetchedAt = (Date.now() - 3 * HOUR) / 1000;
fs.utimesSync(fetchHead, fetchedAt, fetchedAt);
session(acme);
// una segunda copia (worktree) del mismo repo, con su propia sesión: sigue siendo un repo
const acmeWt = path.join(roots, 'acme-wt');
git(acme, ['worktree', 'add', '-q', acmeWt, '-b', 'otra']);
session(acmeWt);
// un repo sin historias, con sesión
const empty = repo('sinhistorias', {});
session(empty);
// un repo sin sesión, con un commit propio y sin rama traída: sus historias salen de la copia
const own = repo('propio', { 'specs/story-2.1.md': story('2.1', 'review') }, { fetched: false });
// el clon con un commit ajeno: no cuenta
repo('ajeno', { 'specs/story-3.1.md': story('3.1', 'ready-for-dev') }, { author: 'otro@acme.example' });
// una ejecución automática no cuenta
const auto = repo('automatico', { 'specs/story-4.1.md': story('4.1', 'ready-for-dev') }, { author: 'otro@acme.example' });
session(auto, { entrypoint: 'sdk-cli' });
// una sesión de hace 8 días no cuenta
const old = repo('viejo', { 'specs/story-5.1.md': story('5.1', 'ready-for-dev') }, { author: 'otro@acme.example' });
session(old, { days: 8 });
// una sesión en una carpeta que ya no existe, y un repo con su lugar de historias declarado y sin clonar
session(path.join(roots, 'ya-no-esta'));
const broken = repo('roto', { '.tycon/advisors.yaml': 'stories:\n  repo: ../no-clonado\n' }, { author: 'otro@acme.example' });
session(broken);
// una ejecución viva en esta máquina, de la sesión «Alfa», sobre la historia «con ejecución»
const sessions = path.join(claudeDir(home), 'sessions');
fs.mkdirSync(sessions, { recursive: true });
fs.writeFileSync(path.join(sessions, 's1.json'), JSON.stringify({ pid: process.pid, sessionId: 's1', name: 'Alfa', status: 'busy', statusUpdatedAt: Date.now() }));
fs.writeFileSync(path.join(sdir, 'active', 's1.json'), JSON.stringify({ sessionId: 's1', storyId: '1.7', storyPath: path.join(acme, 'specs', 'story-1.7-con-ejecucion.md'), repoPath: acme, startedAt: new Date().toISOString(), stepsCompleted: [], stepsPending: ['implement'] }));
// una fila abierta del tablero nombra la historia «con fila»
fs.writeFileSync(path.join(sdir, 'coordination', 'tablero.json'), JSON.stringify({ meta: { actualizado: '2026-11-08T10:00' }, pendientes: [{ id: 'T-1', titulo: 'La fila de la 1.8', estado: 'espera', grupo: 'Hoy', orden: 1, historia: '1.8' }] }));

const snapFile = path.join(sdir, 'office', 'project-stories.json');
const officeJson = () => {
  const r = spawnSync(process.execPath, [OFFICE, '--json'], { env, encoding: 'utf8', timeout: 60000, input: '' });
  if (r.status !== 0) throw new Error(`office.js --json salió ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
};
const refresh = (more = {}) => spawnSync(process.execPath, [READER, '--refresh'], { env: { ...env, ...more }, encoding: 'utf8', timeout: 120000 });
const repoState = (d) => [git(d, ['rev-parse', 'HEAD']), git(d, ['rev-parse', '--abbrev-ref', 'HEAD']), git(d, ['status', '--porcelain']), git(d, ['for-each-ref'])].join('\n');

// AC 19: la foto sin página no lanza la lectura; AC 15: sin lectura lo dice
let data = officeJson();
check(!fs.existsSync(snapFile), 'AC 19: --json no lanza la lectura de fondo');
check(/No pude leer los pendientes de tus proyectos/.test((data.kanban.historias || {}).nota || ''), 'AC 15: sin lectura, el kanban dice «No pude leer los pendientes de tus proyectos»');

// la lectura de fondo de verdad, con el rastro de cada git que corre
const before = Object.fromEntries([acme, acmeWt, empty, own].map((d) => [d, repoState(d)]));
const fetchMtime = fs.statSync(fetchHead).mtimeMs;
const trace = path.join(home, 'git-trace.log');
const r = refresh({ GIT_TRACE: trace });
check(r.status === 0 && /"ran":true/.test(r.stdout), `la lectura de fondo corrió (${(r.stdout || r.stderr).trim()})`);
const traced = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '';
check(traced.length > 0 && !/\bgit (fetch|pull|push|ls-remote|checkout|switch|reset|commit|merge|remote update)\b/.test(traced), 'AC 11 y 20: git no sale a la red ni cambia de rama ni escribe (fetch, pull, checkout… no aparecen)');
check(fs.statSync(fetchHead).mtimeMs === fetchMtime, 'AC 11: el FETCH_HEAD no se tocó');
check(Object.entries(before).every(([d, s]) => repoState(d) === s), 'AC 20: ningún clon cambió: HEAD, rama, copia de trabajo y referencias iguales');

const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
const names = snap.proyectos.map((p) => p.nombre);
check(names.includes('acme') && names.includes('propio'), `AC 1: entran el repo con sesión y el del commit propio (${names.join(', ')})`);
check(!names.some((n) => ['ajeno', 'automatico', 'viejo'].includes(n)), 'AC 1: el clon con commit ajeno, la ejecución automática y la sesión de 8 días no cuentan');
check(names.filter((n) => n === 'acme').length === 1, 'AC 4: el repo y su worktree van en una sola fila');
const acmeRow = snap.proyectos.find((p) => p.nombre === 'acme');
const ids = acmeRow.historias.map((h) => h.id).sort();
check(JSON.stringify(ids) === JSON.stringify(['1.1', '1.2', '1.3', '1.7', '1.8', '1.9']), `AC 2 y 5: de la rama traída entran en curso, en revisión y listas, con su alias; la 1.4 terminada en main no entra aunque la copia la diga lista (${ids.join(', ')})`);
check(acmeRow.historias.some((h) => h.archivo === 'story-1.2-ñandú.md'), 'AC 2: una historia con ñ en el nombre se lee de la rama');
check(acmeRow.sinLeer === 1, 'AC 6: la del estado que el vocabulario no conoce no entra y se cuenta');
check(snap.sinHistorias.includes('sinhistorias'), 'AC 3: el repo sin historias va al aviso');
check(snap.sinHistorias.includes('roto'), 'AC 17: el repo con un lugar declarado que no está clonado no tumba la lectura y va al aviso');
check(snap.proyectos.find((p) => p.nombre === 'propio').deTuCopia === true, 'AC 16: sin rama traída, de la copia');

// la foto de la oficina con la lectura
data = officeJson();
const pend = data.tablas.pendientes;
const row = (n) => pend.filas.find((f) => f.seccion === 'De tus proyectos' && f.grupo === n);
check(Boolean(row('acme')) && /traído hace 3 h/.test(row('acme').col), `AC 12: la línea del proyecto dice cuándo se trajo (${row('acme') && row('acme').col})`);
check(Boolean(row('propio')) && /de tu copia/.test(row('propio').col) && !/traído/.test(row('propio').col), 'AC 16: la línea dice «de tu copia», sin hora');
check((pend.pie || []).some((l) => l === 'En sinhistorias no encontré sus historias'), 'AC 3: abajo dice «En sinhistorias no encontré sus historias»');
const who = Object.fromEntries(row('acme').trabajos.map((w) => [w.numero, w]));
check(/en esta máquina$/.test(who['1.7'].quien), `AC 8: la de la ejecución dice quién y «en esta máquina» (${who['1.7'].quien})`);
check(['1.1', '1.2', '1.3', '1.8', '1.9'].every((n) => who[n].quien === 'sin asignar'), 'AC 9: las demás dicen «sin asignar»');
check(who['1.1'].quien === 'sin asignar' && /pedido de trabajo 6402/.test(who['1.1'].como), 'AC 10: el pedido de trabajo se muestra y no dice de quién es');
check(who['1.3'].como === 'en revisión' && who['1.1'].como.startsWith('lista') && who['1.2'].como === 'en curso', 'AC 5: el estado en palabras');
const sinSesion = data.kanban.columnas.find((c) => c.id === 'sinEmpezar').tarjetas;
const cards = sinSesion.filter((t) => t.local === true).map((t) => t.titulo.split(' · ')[0]);
check(!cards.includes('1.7') && !cards.includes('1.8'), 'AC 7: la de la ejecución y la que nombra una fila abierta no suman tarjeta');
check(sinSesion.some((t) => t.numero === 'T-1'), 'AC 7: la fila del tablero sigue, con su número');
check(JSON.stringify(cards.filter((c) => c.startsWith('1.'))) === JSON.stringify(['1.2', '1.1', '1.3', '1.9']), `AC 21 y 22: cada historia sin ejecución tiene su tarjeta, P0, P1 y sin prioridad por número (${cards.join(', ')})`);
check(sinSesion.filter((t) => t.local === true).every((t) => t.grupo === 'Historias' && t.quien === 'sin asignar'), 'AC 21: en el grupo «Historias», «sin asignar»');
const sent = pick(data, home);
// la sesión «Alfa» corre la historia «con ejecución»: su título viaja con su escritorio, como siempre. Lo de la
// lectura no viaja
const leaks = [];
const walk = (v, at) => { if (typeof v === 'string') { if (/La historia 1\.[12389]\b/.test(v)) leaks.push(at); } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`); };
walk(sent, 'foto');
check(!leaks.length && !('historias' in sent.kanban) && !sent.tablas.pendientes.filas.some((f) => f.seccion), `AC 19: ni las filas de proyecto ni las tarjetas de historia viajan al sitio${leaks.length ? ` (${leaks.join(', ')})` : ''}`);
check(sent.kanban.columnas.find((c) => c.id === 'sinEmpezar').tarjetas.some((t) => t.numero === 'T-1'), 'AC 19: la fila del tablero viaja como siempre');

// AC 18: con un candado de un minuto no corre; AC 15: una lectura de dos horas no se muestra y dice la hora
const lock = path.join(sdir, 'office', 'project-stories.lock');
fs.writeFileSync(lock, 'otra');
const snapMtime = fs.statSync(snapFile).mtimeMs;
const locked = refresh();
check(/"ran":false/.test(locked.stdout) && fs.statSync(snapFile).mtimeMs === snapMtime, 'AC 18: con otra lectura en curso, la segunda no corre');
fs.unlinkSync(lock);
const aged = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
aged.at = new Date(Date.now() - 2 * HOUR).toISOString();
fs.writeFileSync(snapFile, JSON.stringify(aged));
data = officeJson();
check(/se leyeron a las \d\d:\d\d/.test((data.kanban.historias || {}).nota || '') && !data.kanban.columnas.find((c) => c.id === 'sinEmpezar').tarjetas.some((t) => t.local === true), 'AC 15: una lectura de dos horas no se muestra y dice a qué hora se leyó');

// AC 23: las guías dicen qué sale solo, que lo sin historia va con board.js, y el límite
const guides = { 'guides/coordination.md': [/sale sola/, /board\.js/, /otra máquina/], 'guides/coordination.en.md': [/shows up on its own/, /board\.js/, /another machine/], 'guides/working-with-a-coordinator.md': [/sale sola/, /board\.js/, /otra máquina/], 'guides/working-with-a-coordinator.en.md': [/shows up on its own/, /board\.js/, /another machine/] };
check(Object.entries(guides).every(([g, res]) => { const t = fs.readFileSync(path.join(ROOT, g), 'utf8'); return res.every((re) => re.test(t)); }), 'AC 23: las cuatro guías lo dicen');

fs.rmSync(home, { recursive: true, force: true });
console.log(fails.length ? `8.185 lectura: FALLA (${fails.length})` : '8.185 lectura: OK');
process.exitCode = fails.length ? 1 : 0;
