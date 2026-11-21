#!/usr/bin/env node
'use strict';
// office-topics-live.smoke.js — las tablas por tema de punta a punta, sobre una máquina de juguete con repos, pedidos y tablero de
// verdad: la foto real (`collect`), el proceso real (`topics.js --classify`) y, si la máquina tiene modelo, el modelo real. Lo que
// sólo se ve con un servicio que falla se corre con `classify` contra un servicio de juguete.
//
//   node scripts/tests/office-topics-live.smoke.js        sale 0 si todo pasó, 1 si algo no
//
// `TYCON_TREE` dice de dónde sale el modelo de la organización; sin modelo, esa parte se dice y no se cuenta como pasada.
// stable-data: las sesiones se fechan con el reloj real a propósito, porque la foto mira si una sesión está viva.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const TOPICS = path.join(ROOT, 'scripts', 'tools', 'office', 'topics.js');
const T = require(TOPICS);
const { collect, createEnvelopes, workCards } = require(path.join(ROOT, 'scripts', 'tools', 'office.js'));
const { pick } = require(path.join(ROOT, 'scripts', 'tools', 'office', 'fields.js'));
const { stateDir, claudeDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));

const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'ok ' : 'MAL'} ${what}`); if (!ok) fails.push(what); };
const git = (dir, ...args) => spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'user.name=x', '-c', 'user.email=x@x', '-C', dir, ...args], { encoding: 'utf8' });
const iso = (ms = Date.now()) => new Date(ms).toISOString();

function repoWith(url, branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-humo-repo-'));
  git(dir, 'init', '-q');
  git(dir, 'remote', 'add', 'origin', url);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'x');
  if (branch) git(dir, 'checkout', '-q', '-b', branch);
  return dir;
}

function machine() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-humo-'));
  const sdir = stateDir(home);
  for (const d of ['active', 'adhoc', 'doing', 'office', 'coordination', 'file-events']) fs.mkdirSync(path.join(sdir, d), { recursive: true });
  const sessions = path.join(claudeDir(home), 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const m = { home, sdir, sessions, office: (name) => path.join(sdir, 'office', name) };
  m.session = (sid, name, cwd, reason, status = 'busy') => {
    fs.writeFileSync(path.join(sessions, `${sid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, name, status, statusUpdatedAt: Date.now(), cwd }));
    if (reason) fs.writeFileSync(path.join(sdir, 'adhoc', `${sid}.json`), JSON.stringify({ reason, declaredAt: iso(), cwd }));
  };
  m.prs = (lecturas) => {
    fs.writeFileSync(path.join(sdir, 'stuck-prs-photo.json'), JSON.stringify({ at: iso(), lecturas }));
    fs.writeFileSync(path.join(sdir, 'own-prs.json'), JSON.stringify({ at: iso(), lecturas }));
  };
  m.board = (content) => fs.writeFileSync(path.join(sdir, 'coordination', 'tablero.json'), typeof content === 'string' ? content : JSON.stringify(content));
  m.photo = (opts = {}) => collect({ home, now: iso(), envelopes: createEnvelopes(), noTranscripts: true, siteUrl: async () => ({ code: 3, out: '' }), quietMinutes: async () => ({ code: 3, out: '' }), queryPrs: async (list) => list.map(() => ({})), ...opts });
  m.topics = (...args) => spawnSync(process.execPath, [TOPICS, ...args], { env: { ...process.env, HOME: home, USERPROFILE: home, TYCON_TREE: process.env.TYCON_TREE || path.join(os.homedir(), '.tycon', 'harness'), TYCON_OFFICE_LINK: '0', ...(m.env || {}) }, encoding: 'utf8', timeout: 90000 });
  return m;
}

// un servicio local de juguete, para lo que no se puede pedirle al de verdad
const service = (chat) => async (url) => (String(url).endsWith('/api/tags') ? { ok: true, status: 200, json: async () => ({ models: [{ name: 'gemma-chico-cloud' }] }) } : chat());
const answer = (content, tokens = { prompt_eval_count: 10, eval_count: 5 }) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ message: { content: JSON.stringify(content) }, ...tokens }) });
function toyModel(pending) {
  const m = machine();
  m.orgConfig = path.join(m.home, 'team-repos.json');
  fs.writeFileSync(m.orgConfig, JSON.stringify({ version: 1, public: { platform: 'github', org: 'acme', repo: 'harness' }, profile: { platform: 'github', org: 'acme', repo: 'harness-profile' }, operations: { platform: 'github', org: 'acme', repo: 'harness-ops' }, models: { nightly: { provider: 'ollama', level: 'economy' }, providers: { ollama: { economy: 'gemma-chico' } } } }));
  T.writePending(m.sdir, pending);
  m.opts = (fetchImpl, more = {}) => ({ sdir: m.sdir, orgConfig: m.orgConfig, env: {}, fetchImpl, namesFile: null, ...more });
  return m;
}
const work = (titulo) => ({ clave: T.workKey({ titulo }), titulo });

async function endToEnd() {
  const m = machine();
  const repo = repoWith('https://github.com/acme/repo.git', 'fix/propio');
  const other = repoWith('https://github.com/otra/ajeno.git');
  m.prs({ 'acme/repo': { ok: true, value: [{ number: 901, sourceBranch: 'fix/propio', title: 'fix(frenos): el pedido de Paz' }] } });
  m.session('s1', 'Paz', repo, 'Arreglar el freno de escrituras de la oficina');
  m.session('s2', 'Mesa', other, 'SECRETO del otro proyecto');
  m.session('s3', 'Rojas', repo, null);
  m.board({ pendientes: [{ titulo: 'Tope de la oficina', estado: 'curso', quien: 'Rojas' }, { titulo: 'La página de firmas', estado: 'espera', pronosticoIso: iso(Date.now() + 86400000).slice(0, 16) }, { titulo: 'Con tema a mano', estado: 'espera', tema: 'Tema de la fila' }] });

  const before = await m.photo();
  const pending = T.readPending(m.sdir).map((w) => w.titulo);
  check(pending.includes('Arreglar el freno de escrituras de la oficina'), 'AC 6: la foto deja lo nuevo por clasificar');
  check(!pending.some((t) => /SECRETO/.test(t)), 'AC 9: el título de otro proyecto no queda para el modelo');
  check(!pending.includes('Con tema a mano'), 'AC 8: lo que ya tiene tema en su fila no se pregunta');
  const sent = JSON.stringify(pick({ tablas: before.tablas }, m.home).tablas);
  check(!/SECRETO/.test(sent) && /SECRETO/.test(JSON.stringify(before.tablas)), 'AC 26: el título de otro proyecto se ve en la máquina y no viaja al sitio');
  check(T.readRowPrs(m.sdir).filas['titulo:tope de la oficina'] && T.readRowPrs(m.sdir).filas['titulo:tope de la oficina'].numero === 901, 'AC 18: se recuerda el pedido para la única fila que nombra a esa sesión');

  const first = m.topics('--classify');
  const state = T.readState(m.sdir).state;
  if (state.sinModelo) {
    console.log(`-- sin modelo en esta máquina (${state.motivo}): la parte del modelo real no se midió`);
    fails.push('no se pudo medir con el modelo real');
    return;
  }
  check(first.status === 0, 'AC 12: el proceso corre con el modelo de la organización');
  const temas = T.readTopics(m.sdir).temas;
  check(Boolean(temas['titulo:arreglar el freno de escrituras de la oficina']), 'AC 6: el tema queda guardado');
  check(!Object.keys(temas).some((k) => /secreto/.test(k)), 'AC 9: el modelo no recibió el título de otro proyecto');
  const report = m.topics('--report').stdout;
  check(/tokens \(\d+ de entrada, \d+ de salida\), \d+ llamadas?/.test(report), `AC 14: --report dice lo gastado (${report.trim()})`);
  // hasta que no quede nada: de a 30 títulos por pasada
  for (let i = 0; i < 3 && T.pendingWorks(workCards((await m.photo()).kanban), T.readTopics(m.sdir).temas).length; i += 1) m.topics('--classify');
  const calls = () => Object.values(T.readUsage(m.sdir).dias)[0].llamadas;
  const before2 = calls();
  const after = await m.photo();
  m.topics('--classify');
  check(calls() === before2, 'AC 7 y 27: lo ya clasificado no se pregunta otra vez, y sin nada pendiente no hay llamada');
  check(after.tablas.hoy.filas.every((f) => f.grupo && f.col), 'AC 1 y 2: cada fila con su tema y su línea');

  // la espera que nombra un pedido, y la sesión que siguió trabajando
  const w = machine();
  w.prs({ 'acme/repo': { ok: true, value: [] } });
  const since = Date.now() - 30 * 60000;
  w.session('s1', 'Paz', repo, null);
  fs.writeFileSync(path.join(w.sdir, 'doing', 's1.json'), JSON.stringify({ text: 'Su trabajo', at: iso(since), waitingFor: 'que entre el #913', waitingSince: iso(since) }));
  const mergedAt = iso(since + 60000);
  const fell = await w.photo({ queryPrs: async (list) => list.map(() => ({ pr: { state: 'merged', mergedAt } })) });
  const paz = fell.agents.find((a) => a.nombre === 'Paz');
  check(paz && paz.estado !== 'esperando', 'AC 16: entró el pedido que esperaba: la espera se cae');
  const q = machine();
  q.prs({ 'acme/repo': { ok: true, value: [{ number: 913, title: 'x', sourceBranch: 'otra' }] } });
  q.session('s1', 'Paz', repo, null, 'idle');
  fs.writeFileSync(path.join(q.sdir, 'doing', 's1.json'), JSON.stringify({ text: 'Su trabajo', at: iso(since), waitingFor: 'que entre el #913', waitingSince: iso(since) }));
  const quiet = (await q.photo()).agents.find((a) => a.nombre === 'Paz');
  check(quiet && quiet.estado === 'esperando', 'AC 17: quieta y con su pedido abierto, sigue esperando');
  fs.writeFileSync(path.join(q.sdir, 'file-events', 's1.jsonl'), `${JSON.stringify({ path: path.join(repo, 'a.js'), ts: iso(since + 20 * 60000) })}\n`);
  const worked = (await q.photo()).agents.find((a) => a.nombre === 'Paz');
  check(worked && worked.estado !== 'esperando', 'AC 17: tocó archivos después de anotarla: la espera se cae');

  // las filas sin tarjeta
  const u = machine();
  u.prs({ 'acme/repo': { ok: true, value: [] } });
  const text = JSON.stringify({ pendientes: [], tablas: { hoy: [{ grupo: 'G', que: 'Algo que no tiene tarjeta' }] } });
  u.board(text);
  const out = u.topics('--unmatched');
  check(/Algo que no tiene tarjeta/.test(out.stdout) && fs.readFileSync(path.join(u.sdir, 'coordination', 'tablero.json'), 'utf8') === text && !fs.existsSync(u.office('promises.json')), 'AC 20: --unmatched imprime y no toca nada');
}

async function withToyService() {
  const NOW = Date.now();
  // el tope del día
  const cap = toyModel([work('Uno'), work('Dos')]);
  let called = 0;
  const counted = service(async () => { called += 1; return answer(['Tema', 'Tema'], { prompt_eval_count: 900, eval_count: 200 })(); });
  await T.classify(cap.opts(counted, { nowMs: NOW, env: { TYCON_OFFICE_TOPICS_TOKENS: '1000' } }));
  T.writePending(cap.sdir, [work('Tres')]);
  await T.classify(cap.opts(counted, { nowMs: NOW + 1000, env: { TYCON_OFFICE_TOPICS_TOKENS: '1000' } }));
  check(called === 1 && T.tableNote(T.readState(cap.sdir).state, NOW + 1000) === T.NOTE_CAP, 'AC 15: llegó al tope: no llama más hoy, y la tabla lo dice');
  // proveedor sin tokens
  const titles = toyModel([work('Uno')]);
  await T.classify(titles.opts(service(answer(['Tema'], {})), { nowMs: NOW }));
  check(/tokens no medidos/.test(T.report(titles.sdir)), 'AC 14: sin tokens del proveedor, cuenta títulos y dice que no se midió');
  // sin modelo
  const none = toyModel([work('Uno')]);
  await T.classify(none.opts(async () => ({ ok: false, status: 500 }), { nowMs: NOW }));
  check(T.tableNote(T.readState(none.sdir).state, NOW) === T.NOTE_NO_MODEL && !T.readTopics(none.sdir).temas['titulo:uno'], 'AC 13: sin modelo lo dice, y no guarda nada');
  check(T.topicOf({ titulo: 'Arreglo del freno' }, { sinModelo: true, prs: T.prScopes(['fix(freno): algo']) }) === 'Freno', 'AC 13: el tema sale de los títulos de los pedidos');
  // el modelo falla: nada guardado, cinco minutos de espera
  const down = toyModel([work('Uno')]);
  let tries = 0;
  const failing = service(async () => { tries += 1; return { ok: false, status: 500 }; });
  await T.classify(down.opts(failing, { nowMs: NOW }));
  await T.classify(down.opts(failing, { nowMs: NOW + 1000 }));
  check(tries === 1 && T.readState(down.sdir).state.nextAt === NOW + T.BACKOFF_MS && !T.readTopics(down.sdir).temas['titulo:uno'], 'AC 21: si falla no guarda nada y no vuelve a llamar por 5 minutos');
  // una respuesta con menos temas, o un tema de más de tres palabras
  const partial = toyModel([work('Uno'), work('Dos'), work('Tres')]);
  await T.classify(partial.opts(service(answer(['Tema bueno', 'Un tema de muchas palabras de más']))));
  check(T.readTopics(partial.sdir).temas['titulo:uno'] === 'Tema bueno' && Object.keys(T.readTopics(partial.sdir).temas).length === 1, 'AC 22: sólo se guardan los temas válidos');
  // archivos rotos
  const broken = toyModel([work('Uno')]);
  fs.writeFileSync(broken.office('topics.json'), '{ roto');
  check(Boolean(T.readTopics(broken.sdir).problem), 'AC 23: un archivo roto se dice y no tira');
  await T.classify(broken.opts(service(answer(['Tema']))));
  check(fs.readdirSync(path.join(broken.sdir, 'office')).some((f) => f.startsWith('topics.json.roto-')) && T.readTopics(broken.sdir).temas['titulo:uno'] === 'Tema', 'AC 23: antes de reescribirlo deja una copia');
  // dos a la vez
  const locked = toyModel([work('Uno')]);
  fs.writeFileSync(locked.office('topics.lock'), '');
  const second = await T.classify(locked.opts(service(answer(['Tema']))));
  const late = await T.classify(locked.opts(service(answer(['Tema'])), { nowMs: Date.now() + 3 * 60000 }));
  check(second.ran === false && late.ran === true, 'AC 24: con el candado tomado no corre; a los 2 minutos vence');
  // la tarjeta sin título anotado no se manda
  check(T.pendingWorks([{ clave: 'k', titulo: 'Lo que dice su conversación', sinTitulo: true }], {}).length === 0, 'AC 10: lo que dice la conversación no se manda');
}

(async () => {
  await endToEnd();
  await withToyService();
  console.log(fails.length ? `FALLA (${fails.length})` : 'OK');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
