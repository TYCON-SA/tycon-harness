'use strict';
// github-issues.test.js — los avisos de dependencias como issues de GitHub (story 8.31, T9 a T14).
//
// No toca la red NUNCA: habla con un `gh` de mentira (scripts/tests/lib/fake-gh.js) que contesta desde un estado en JSON,
// guarda lo que «crea» como lo haría GitHub y anota cada llamada. Los casos giran alrededor de lo que convertiría la pieza
// en un problema: un issue duplicado en el repo de un equipo, un issue cerrado o reabierto que no era del arnés, una
// asignación que GitHub descartó en silencio, un número de issue repetido entre repos leído como otro, y una corrida
// programada que «no pudo» leída como «no había nada».
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DEP = path.join(ROOT, 'scripts', 'nightly', 'dependencies');
const WI = path.join(DEP, 'work-items.js');
const NOC = path.join(DEP, 'nightly-dependencies.js');
const FAKE = path.join(__dirname, 'lib', 'fake-gh.js');
const HOY = '2026-10-14';
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** El mundo: dos repos de GitHub (acme/web, acme/api), sus fichas, el snapshot de hoy y el estado del `gh` de mentira. */
function mundo({ issues = true, cfgExtra = {}, ops = { default: 'lider', by_project: { 'acme/web': 'dueno-web' } }, team = 'github', gh = {} } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'github-issues-'));
  dirs.push(d);
  for (const s of ['pending', 'promoted', 'archived']) fs.mkdirSync(path.join(d, 'pend', s), { recursive: true });
  fs.mkdirSync(path.join(d, 'out'));
  const cfg = { presupuesto_de_ruido: { tope_pr_por_noche: 2 }, github: { issues_enabled: issues },
    repos: [{ producto: 'Web', ruta: 'acme/web', github: 'acme/web', tipo: 'npm', activo: true },
      { producto: 'Api', ruta: 'acme/api', github: 'acme/api', tipo: 'nuget', activo: true }], ...cfgExtra };
  fs.writeFileSync(path.join(d, 'repos.json'), JSON.stringify(cfg));
  if (ops) fs.writeFileSync(path.join(d, 'operations.json'), JSON.stringify({ version: 1, owners: ops }));
  if (team) {
    const r = (repo) => ({ platform: team, org: 'acme', ...(team === 'azure' ? { project: 'P' } : {}), repo });
    fs.writeFileSync(path.join(d, 'team-repos.json'), JSON.stringify({ version: 1, public: r('harness'), profile: r('profile'), operations: r('operations') }));
  }
  fs.writeFileSync(path.join(d, 'gh.json'), JSON.stringify({ user: 'arnes-bot', now: `${HOY}T05:00:00Z`, users: ['lider', 'dueno-web'],
    collaborators: { 'acme/web': ['lider', 'dueno-web', 'arnes-bot'], 'acme/api': ['lider', 'arnes-bot'] }, issues: {}, timeline: {}, ...gh }));
  return d;
}
function ficha(d, id, { dir = 'pending', paquete = 'lodash', sev = 'high', noches = 1, repos = ['Web/web'], extra = [] } = {}) {
  fs.writeFileSync(path.join(d, 'pend', dir, `${id}.yaml`), [`id: ${id}`, 'detectado: 2026-10-12', `veredicto: ${dir === 'promoted' ? 'util' : 'pendiente'}`,
    `paquete: ${paquete}`, `severidad: ${sev}`, `noches: ${noches}`, ...extra, 'ids:', `  - ${id}`, 'repos:', ...repos.map((r) => `  - ${r}`),
    'avisos:', `  - https://github.com/advisories/GHSA-73wf-${id}`, '# pie', ''].join('\n'));
}
function snapshot(d, { presencias = [], sinMedir = [], cruce = null } = {}) {
  const repos = [['Web', 'acme/web'], ['Api', 'acme/api']].map(([producto, ruta]) => ({ producto, ruta, medido: !sinMedir.includes(ruta) }));
  fs.writeFileSync(path.join(d, 'out', `dependencias-${HOY}.json`), JSON.stringify({ fecha: HOY, corrida_completa: true, repos, presencias,
    hallazgos: [], anunciados_hoy: [], ...(cruce ? { cruce } : {}) }));
}
const pres = (id, paquete, ...repos) => ({ id, paquete, severidad: 'high', advisories: [], repos: repos.map((x) => {
  const [repo, vence] = x.split('@'); return { repo, declarada: !!vence, vence: vence || null }; }) });
function correr(d, cmd = 'run', { args = [], env = {}, team = true } = {}) {
  const r = spawnSync(process.execPath, [WI, cmd, '--config', path.join(d, 'repos.json'), '--operations', path.join(d, 'operations.json'),
    ...(team ? ['--team-repos', path.join(d, 'team-repos.json')] : []), '--pending', path.join(d, 'pend'), '--out', path.join(d, 'out'), '--today', HOY, ...args],
  { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: d, TYCON_GH_CMD: FAKE, GH_TOKEN: 'token-de-prueba', FAKE_GH_STATE: path.join(d, 'gh.json'),
    FAKE_GH_LOG: path.join(d, 'gh.log'), ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const estado = (d) => JSON.parse(fs.readFileSync(path.join(d, 'gh.json'), 'utf8'));
const llamadas = (d) => (fs.existsSync(path.join(d, 'gh.log')) ? fs.readFileSync(path.join(d, 'gh.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
const creaciones = (d) => llamadas(d).filter((c) => c.method === 'POST' && /\/issues$/.test(c.ruta));
const snap = (d) => JSON.parse(fs.readFileSync(path.join(d, 'out', `dependencias-${HOY}.json`), 'utf8'));
const leerFicha = (d, id, dir = 'pending') => fs.readFileSync(path.join(d, 'pend', dir, `${id}.yaml`), 'utf8');
const issueMarcado = (n, extra = {}) => ({ number: n, state: 'open', state_reason: null, title: 't', body: `cuerpo\n\n<!-- arnes-nocturno:abc12345 -->`,
  labels: ['arnes-hallazgo', 'arnes:abc12345'], assignees: ['dueno-web'], user: 'arnes-bot', created_at: '2026-10-12T05:00:00Z', closed_at: null, closed_by: null, ...extra });

test('T9 GithubIssues_Create: crea el issue en el repo del producto, con etiquetas, marca, asignado y mención; lo anota en la ficha y el snapshot', () => {
  const d = mundo({});
  ficha(d, 'abc12345', { paquete: '@scope/paquete' });
  snapshot(d, { presencias: [pres('abc12345', '@scope/paquete', 'Web/web')] });
  const r = correr(d);
  assert.strictEqual(r.code, 0, r.out);
  const i = estado(d).issues['acme/web'][0];
  assert.ok(i, r.out);
  assert.deepStrictEqual(i.labels, ['arnes-hallazgo', 'arnes:abc12345']);
  assert.deepStrictEqual(i.assignees, ['dueno-web'], 'el declarado para el repo');
  assert.match(i.body, /<!-- arnes-nocturno:abc12345 -->/, 'la marca del arnés');
  assert.match(i.body, /@lider — aviso abierto/, 'el responsable de respaldo mencionado');
  assert.match(i.body, /`@scope\/paquete`/, 'el nombre de afuera va en código (no menciona a nadie)');
  assert.match(leerFicha(d, 'abc12345'), /^pedidos:\n {2}- acme\/web: 1$/m, 'la ficha guarda el issue');
  const p = snap(d).pedidos;
  assert.strictEqual(p.plataforma, 'github');
  assert.deepStrictEqual(p.creados.map((c) => [c.proyecto, c.id, c.asignado_a]), [['acme/web', 1, 'dueno-web']]);
});

test('T9b GithubIssues_Create: sin responsable declarado va al de respaldo; un asignado que GitHub descartó es un fallo «asignar»', () => {
  const d = mundo({ gh: { collaborators: { 'acme/web': ['lider'], 'acme/api': ['arnes-bot'] } } });
  ficha(d, 'abc12345', { repos: ['Web/web'] });
  ficha(d, 'def67890', { paquete: 'minimist', repos: ['Api/api'] });
  snapshot(d, { presencias: [pres('abc12345', 'lodash', 'Web/web'), pres('def67890', 'minimist', 'Api/api')] });
  const r = correr(d);
  assert.strictEqual(r.code, 0, r.out);
  const p = snap(d).pedidos;
  assert.deepStrictEqual(p.creados.map((c) => [c.proyecto, c.asignado_a]).sort(), [['acme/api', 'lider'], ['acme/web', 'dueno-web']]);
  const asignar = p.fallidos.filter((f) => f.paso === 'asignar').map((f) => f.proyecto).sort();
  assert.deepStrictEqual(asignar, ['acme/api', 'acme/web'], 'los dos quedaron sin asignar y se dice');
});

test('T10 GithubIssues_NoRepeat: anotado no crea; encontrado por etiqueta se adopta; dos o una consulta que falla no crean', () => {
  // anotado
  let d = mundo({});
  ficha(d, 'abc12345', { extra: ['pedidos:', '  - acme/web: 7'] });
  snapshot(d, { presencias: [pres('abc12345', 'lodash', 'Web/web')] });
  let r = correr(d);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(creaciones(d).length, 0, 'lo anotado se respeta');
  assert.strictEqual(snap(d).pedidos.existentes, 1);
  // adopción (el issue existe con la etiqueta; la ficha no lo tiene)
  d = mundo({ gh: { issues: { 'acme/web': [issueMarcado(3)] } } });
  ficha(d, 'abc12345');
  snapshot(d, { presencias: [pres('abc12345', 'lodash', 'Web/web')] });
  r = correr(d);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(creaciones(d).length, 0);
  assert.deepStrictEqual(snap(d).pedidos.adoptados.map((x) => x.id), [3]);
  assert.match(leerFicha(d, 'abc12345'), /- acme\/web: 3/);
  assert.match(estado(d).issues['acme/web'][0].comments[0], /la revisión nocturna lo adopta[\s\S]*<!-- arnes-nocturno:abc12345 -->/);
  // dos con la misma etiqueta
  d = mundo({ gh: { issues: { 'acme/web': [issueMarcado(3), issueMarcado(4)] } } });
  ficha(d, 'abc12345');
  snapshot(d, { presencias: [pres('abc12345', 'lodash', 'Web/web')] });
  r = correr(d);
  assert.strictEqual(creaciones(d).length, 0);
  assert.match(JSON.stringify(snap(d).pedidos.fallidos), /issues duplicados en acme\/web: #3, #4/);
  // la consulta falla: «no pude preguntar» no es «no hay»
  d = mundo({ gh: { fail: { 'GET repos/acme/web/issues?': { status: 502, message: 'Bad Gateway' } } } });
  ficha(d, 'abc12345');
  snapshot(d, { presencias: [pres('abc12345', 'lodash', 'Web/web')] });
  r = correr(d);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(creaciones(d).length, 0);
  assert.match(JSON.stringify(snap(d).pedidos.fallidos), /no pude consultar duplicados \(HTTP 502/);
});

test('T10b GithubIssues_Budget: las críticas no consumen tope, lo demás por noches; dos fichas del mismo paquete en el mismo repo no abren dos', () => {
  const d = mundo({ cfgExtra: { presupuesto_de_ruido: { tope_pr_por_noche: 1 } } });
  ficha(d, 'aaa11111', { paquete: 'p1', sev: 'critical', noches: 1 });
  ficha(d, 'bbb22222', { paquete: 'p2', noches: 5 });
  ficha(d, 'ccc33333', { paquete: 'p3', noches: 1 });
  snapshot(d, { presencias: [pres('aaa11111', 'p1', 'Web/web'), pres('bbb22222', 'p2', 'Web/web'), pres('ccc33333', 'p3', 'Web/web')] });
  let r = correr(d);
  assert.strictEqual(r.code, 0, r.out);
  const p = snap(d).pedidos;
  assert.deepStrictEqual(p.creados.map((c) => c.ficha).sort(), ['aaa11111', 'bbb22222']);
  assert.deepStrictEqual(p.postergados.map((x) => x.ficha), ['ccc33333']);
  // el mismo paquete, dos fichas vivas, mismo repo
  const e = mundo({});
  ficha(e, 'aaa11111', { paquete: 'lodash' });
  ficha(e, 'bbb22222', { paquete: 'lodash' });
  snapshot(e, { presencias: [pres('aaa11111', 'lodash', 'Web/web')] });
  r = correr(e);
  assert.strictEqual(creaciones(e).length, 1, r.out);
  assert.match(JSON.stringify(snap(e).pedidos.fallidos), /otra ficha viva del mismo paquete ya tiene issue en acme\/web: aaa11111/);
});

test('T11 GithubIssues_CloseReopenNotices: cierra lo suyo, sólo comenta lo ajeno, reabre lo que cerró, avisa la deuda y el cerrado vivo', () => {
  // ya no aparece, abierto por el arnés → se cierra
  let d = mundo({ gh: { issues: { 'acme/web': [issueMarcado(1)] } } });
  ficha(d, 'abc12345', { extra: ['pedidos:', '  - acme/web: 1'] });
  snapshot(d, { presencias: [] });
  let r = correr(d);
  assert.strictEqual(r.code, 0, r.out);
  let i = estado(d).issues['acme/web'][0];
  assert.strictEqual(i.state, 'closed'); assert.strictEqual(i.state_reason, 'completed');
  assert.match(i.comments[0], /@dueno-web @lider — Ya no aparece — medido el 2026-10-14\. Cierro este issue/);
  assert.match(leerFicha(d, 'abc12345'), /pagado_avisado:\n {2}- acme\/web \(2026-10-14, cerrado por el arnés\)/);
  // el mismo, abierto por una persona (o sin la marca) → no se cierra
  d = mundo({ gh: { issues: { 'acme/web': [issueMarcado(1, { user: 'persona' })] } } });
  ficha(d, 'abc12345', { extra: ['pedidos:', '  - acme/web: 1'] });
  snapshot(d, { presencias: [] });
  correr(d);
  i = estado(d).issues['acme/web'][0];
  assert.strictEqual(i.state, 'open', 'un issue de otra persona no se cierra solo');
  assert.match(i.comments[0], /cerralo si corresponde/);
  // volvió: lo cerró el arnés el día de su marca → se reabre
  d = mundo({ gh: { issues: { 'acme/web': [issueMarcado(1, { state: 'closed', state_reason: 'completed', closed_by: 'arnes-bot', closed_at: '2026-10-13T05:00:00Z' })] } } });
  ficha(d, 'abc12345', { extra: ['pedidos:', '  - acme/web: 1', 'pagado_avisado:', '  - acme/web (2026-10-13, cerrado por el arnés)'] });
  snapshot(d, { presencias: [pres('abc12345', 'lodash', 'Web/web')] });
  r = correr(d);
  i = estado(d).issues['acme/web'][0];
  assert.strictEqual(i.state, 'open', r.out);
  assert.match(i.comments[0], /Reabro este issue/);
  assert.deepStrictEqual(snap(d).pedidos.reabiertos.map((x) => x.id), [1]);
  assert.doesNotMatch(leerFicha(d, 'abc12345'), /pagado_avisado/);
  // ...pero si lo cerró otra persona, no
  d = mundo({ gh: { issues: { 'acme/web': [issueMarcado(1, { state: 'closed', state_reason: 'completed', closed_by: 'persona', closed_at: '2026-10-13T05:00:00Z' })] } } });
  ficha(d, 'abc12345', { extra: ['pedidos:', '  - acme/web: 1', 'pagado_avisado:', '  - acme/web (2026-10-13, cerrado por el arnés)'] });
  snapshot(d, { presencias: [pres('abc12345', 'lodash', 'Web/web')] });
  correr(d);
  assert.strictEqual(estado(d).issues['acme/web'][0].state, 'closed', 'lo cerró una persona: decide ella');
  // declarada como deuda: un comentario, una vez
  d = mundo({ gh: { issues: { 'acme/web': [issueMarcado(1)] } } });
  ficha(d, 'abc12345', { extra: ['pedidos:', '  - acme/web: 1'] });
  snapshot(d, { presencias: [pres('abc12345', 'lodash', 'Web/web@2026-12-31')] });
  correr(d); correr(d);
  i = estado(d).issues['acme/web'][0];
  assert.strictEqual((i.comments || []).length, 1);
  assert.match(i.comments[0], /Quedó declarada como deuda en este repo, vence 2026-12-31/);
  // cerrado con la vulnerabilidad viva: un comentario por episodio
  d = mundo({ gh: { issues: { 'acme/web': [issueMarcado(1, { state: 'closed', state_reason: 'not_planned' })] } } });
  ficha(d, 'abc12345', { extra: ['pedidos:', '  - acme/web: 1'] });
  snapshot(d, { presencias: [pres('abc12345', 'lodash', 'Web/web')],
    cruce: { cerrados_vivos: [{ ficha: 'abc12345', proyecto: 'acme/web', pedido: 1, clase: 'no-aplica', visto_cerrado: '2026-10-13', repos: ['Web/web'], avisar: true }] } });
  correr(d); correr(d);
  i = estado(d).issues['acme/web'][0];
  assert.strictEqual(i.comments.length, 1);
  assert.match(i.comments[0], /cerrado como no aplica desde el 2026-10-13, y la vulnerabilidad `lodash` sigue apareciendo/);
  assert.match(leerFicha(d, 'abc12345'), /avisado_cerrado_vivo:\n {2}- acme\/web \(2026-10-14\)/);
});

test('T11b GithubIssues_Simulated: con los issues apagados no escribe nada y dice qué habría creado', () => {
  const d = mundo({ issues: false });
  ficha(d, 'abc12345');
  snapshot(d, { presencias: [pres('abc12345', 'lodash', 'Web/web')] });
  const antes = leerFicha(d, 'abc12345');
  const r = correr(d);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /MODO SIMULADO/);
  assert.match(r.out, /habría creado en acme\/web \(ficha abc12345\)/);
  assert.strictEqual(llamadas(d).filter((c) => c.method !== 'GET').length, 0, 'ninguna escritura en GitHub');
  assert.strictEqual(leerFicha(d, 'abc12345'), antes, 'la ficha no se tocó');
});

test('T12 GithubIssues_FailureModes: borrado y movido son fallos sin tocar nada; una credencial que da 401 es «no pude intentar»', () => {
  let d = mundo({ gh: { issues: { 'acme/web': [issueMarcado(1)] }, gone: ['acme/web#1'] } });
  ficha(d, 'abc12345', { extra: ['pedidos:', '  - acme/web: 1'] });
  snapshot(d, { presencias: [] });
  let r = correr(d);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(JSON.stringify(snap(d).pedidos.fallidos), /fue borrado \(410\)/);
  assert.strictEqual(llamadas(d).filter((c) => c.method !== 'GET').length, 0, 'no se comenta ni se recrea');
  d = mundo({ gh: { issues: { 'acme/web': [issueMarcado(1)] }, moved: { 'acme/web#1': 'otra/cosa' } } });
  ficha(d, 'abc12345', { extra: ['pedidos:', '  - acme/web: 1'] });
  snapshot(d, { presencias: [] });
  r = correr(d);
  assert.match(JSON.stringify(snap(d).pedidos.fallidos), /está en otro repo/);
  assert.strictEqual(estado(d).issues['acme/web'][0].state, 'open', 'un issue movido no se cierra');
  d = mundo({ gh: { fail: { 'GET user': { status: 401, message: 'Bad credentials' } } } });
  ficha(d, 'abc12345');
  snapshot(d, { presencias: [pres('abc12345', 'lodash', 'Web/web')] });
  r = correr(d);
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /401/);
  assert.ok(!('pedidos' in snap(d)), 'no escribió la sección');
});

test('T12b GithubIssues_State: el volcado con plataforma, clave <repo>#<n>, categorías, quién lo tocó y los sueltos; sin credencial, 2 con consultado:false', () => {
  const d = mundo({ gh: {
    issues: {
      'acme/web': [issueMarcado(1), { ...issueMarcado(2), labels: ['arnes-hallazgo', 'arnes:zzz99999'] }],
      'acme/api': [issueMarcado(1, { labels: ['arnes-hallazgo', 'arnes:def67890'], state: 'closed', state_reason: 'not_planned', closed_at: '2026-10-13T00:00:00Z', closed_by: 'persona' })],
    },
    timeline: {
      'acme/web#1': [{ event: 'commented', actor: { login: 'arnes-bot' }, body: 'x <!-- arnes-nocturno:abc12345 -->', created_at: '2026-10-13T05:00:00Z' },
        { event: 'commented', actor: { login: 'dependabot[bot]' }, body: 'hola', created_at: '2026-10-13T09:00:00Z' }],
      'acme/api#1': [{ event: 'closed', actor: { login: 'persona' }, created_at: '2026-10-13T00:00:00Z' }],
    } } });
  ficha(d, 'abc12345', { extra: ['pedidos:', '  - acme/web: 1'] });
  ficha(d, 'def67890', { paquete: 'minimist', repos: ['Api/api'], extra: ['pedidos:', '  - acme/api: 1'] });
  const r = correr(d, 'state');
  assert.strictEqual(r.code, 0, r.out);
  const v = JSON.parse(fs.readFileSync(path.join(d, 'out', `bugs-${HOY}.json`), 'utf8'));
  assert.strictEqual(v.plataforma, 'github');
  assert.deepStrictEqual(Object.keys(v.pedidos).sort(), ['acme/api#1', 'acme/web#1'], 'el mismo número en dos repos son dos pedidos');
  assert.strictEqual(v.pedidos['acme/web#1'].categoria, 'Proposed');
  assert.strictEqual(v.pedidos['acme/web#1'].cambiado_por_persona_el, null, 'lo del arnés (con marca) y un bot no son una persona');
  assert.strictEqual(v.pedidos['acme/api#1'].categoria, 'Removed');
  assert.strictEqual(v.pedidos['acme/api#1'].motivo, 'not_planned');
  assert.strictEqual(v.pedidos['acme/api#1'].cambiado_por_persona_el, '2026-10-13T00:00:00Z');
  assert.deepStrictEqual(v.huerfanos.map((h) => [h.proyecto, h.id, h.ficha]), [['acme/web', 2, 'zzz99999']]);
  const sin = correr(d, 'state', { env: { GH_TOKEN: '' } });
  assert.strictEqual(sin.code, 2, sin.out);
  const w = JSON.parse(fs.readFileSync(path.join(d, 'out', `bugs-${HOY}.json`), 'utf8'));
  assert.strictEqual(w.consultado, false);
  assert.match(w.motivo, /sin credencial/);
});

test('T13 WorkItems_PlatformDispatch: sin team-repos o con azure, Azure; con github, los issues; roto, 2; mezcla de plataformas, 2', () => {
  // sin team-repos.json ni credencial de Azure: el camino de siempre, que pide AZURE_DEVOPS_EXT_PAT
  let d = mundo({ team: null, cfgExtra: { azure: { org: 'https://dev.azure.com/acme' }, repos: [{ producto: 'A', ruta: 'A', ado: 'P/A', tipo: 'npm' }] } });
  snapshot(d);
  let r = correr(d, 'run', { team: false });
  assert.strictEqual(r.code, 2); assert.match(r.out, /AZURE_DEVOPS_EXT_PAT/);
  d = mundo({ team: 'azure', cfgExtra: { azure: { org: 'https://dev.azure.com/acme' }, repos: [{ producto: 'A', ruta: 'A', ado: 'P/A', tipo: 'npm' }] } });
  snapshot(d);
  r = correr(d);
  assert.strictEqual(r.code, 2); assert.match(r.out, /AZURE_DEVOPS_EXT_PAT/, 'azure sigue por Azure');
  // github: corre los issues (simulado, sin nada que pedir)
  d = mundo({ issues: false });
  snapshot(d);
  r = correr(d);
  assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /Issues de dependencias/);
  // roto
  d = mundo({});
  fs.writeFileSync(path.join(d, 'team-repos.json'), '{"version":1}');
  snapshot(d);
  r = correr(d);
  assert.strictEqual(r.code, 2); assert.match(r.out, /no sirve para elegir la plataforma/);
  // mezcla: GitHub con una entrada de Azure, y Azure con una de GitHub
  d = mundo({ cfgExtra: { repos: [{ producto: 'A', ruta: 'A', ado: 'P/A', tipo: 'npm' }] } });
  snapshot(d);
  r = correr(d);
  assert.strictEqual(r.code, 2); assert.match(r.out, /una organización, una plataforma/);
  d = mundo({ team: 'azure', cfgExtra: { azure: { org: 'https://dev.azure.com/acme' } } });
  snapshot(d);
  r = correr(d, 'run', { env: { AZURE_DEVOPS_EXT_PAT: 'x' } });
  assert.strictEqual(r.code, 2); assert.match(r.out, /una organización, una plataforma/);
});

test('T14 Nightly_GithubEntries: clone-list, la identidad de la ficha y el cruce con números repetidos entre repos', () => {
  const noc = require(NOC);
  const d = mundo({});
  const cfg = JSON.parse(fs.readFileSync(path.join(d, 'repos.json'), 'utf8'));
  const cl = spawnSync(process.execPath, [NOC, 'clone-list', '--config', path.join(d, 'repos.json')], { encoding: 'utf8' });
  assert.strictEqual(cl.stdout, 'acme/web\tacme/web\nacme/api\tacme/api\n');
  assert.strictEqual(noc.proyectoDe('Web/web', cfg), 'acme/web');
  assert.strictEqual(noc.proyectoAzureDe('Api/api', cfg), 'acme/api');
  // el mismo número (1) en los dos repos, uno cerrado como completed y otro como not_planned; la vulnerabilidad viva
  ficha(d, 'abc12345', { extra: ['pedidos:', '  - acme/web: 1', 'visto_cerrado:', '  - acme/web: 2026-10-13'] });
  ficha(d, 'def67890', { paquete: 'minimist', repos: ['Api/api'], extra: ['pedidos:', '  - acme/api: 1', 'visto_cerrado:', '  - acme/api: 2026-10-13'] });
  const e = (categoria, motivo) => ({ leido: true, estado: 'closed', categoria, motivo, cambiado_por_persona_el: null });
  const volcado = { archivo: 'bugs.json', consultado: true, plataforma: 'github',
    pedidos: { 'acme/web#1': e('Completed', 'completed'), 'acme/api#1': e('Removed', 'not_planned') }, huerfanos: [], huerfanos_no_consultados: [] };
  const snapshotHoy = { repos: [{ producto: 'Web', ruta: 'acme/web', medido: true }, { producto: 'Api', ruta: 'acme/api', medido: true }],
    presencias: [pres('abc12345', 'lodash', 'Web/web'), pres('def67890', 'minimist', 'Api/api')] };
  const c = noc.cruzarPedidos({ pendingDir: path.join(d, 'pend'), hoy: HOY, snapshot: snapshotHoy, volcado, cfg, escribir: false });
  assert.deepStrictEqual(c.no_leidos, [], 'cada issue se lee por su clave <repo>#<n>');
  assert.deepStrictEqual(c.cerrados_vivos.map((x) => [x.proyecto, x.clase]).sort(), [['acme/api', 'no-aplica'], ['acme/web', 'arreglado']]);
  // sin plataforma, la clave sigue siendo el número (Azure no cambia)
  assert.strictEqual(noc.claveDePedido({}, 'P', 7), '7');
  // con los issues prendidos, una ficha sin issue no se archiva como ignorada
  const f = mundo({});
  ficha(f, 'zzz99999', { extra: [] });
  const fcfg = JSON.parse(fs.readFileSync(path.join(f, 'repos.json'), 'utf8'));
  assert.deepStrictEqual(noc.archivarIgnorados(path.join(f, 'pend'), '2026-11-30', fcfg, null), [], 'protegida: no tiene issue');
  fcfg.github.issues_enabled = false;
  assert.deepStrictEqual(noc.archivarIgnorados(path.join(f, 'pend'), '2026-11-30', fcfg, null), ['zzz99999'], 'apagados: la regla de siempre');
});
