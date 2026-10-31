'use strict';

/**
 * instinct-nightly.test.js — la noche que propone aprendizajes (scripts/instincts/instinct-nightly.js) y lo que se apaga
 * en cada máquina (el disparador, el comando y el aviso de arranque).
 *
 * Lo que no se puede perder:
 *   · Que la noche cuente sin modelo lo que se repite en el equipo, con las máquinas resueltas, y nunca nombre una.
 *   · Que «no pude leer el buzón» nunca sea «no había nada»: el informe sale `no_medido`, con `null` donde no midió.
 *   · Que el modelo escriba como mucho 20 por noche y la noche como mucho 50 propuestas nuevas, y lo que no entra salga
 *     con los números o espere a la noche siguiente.
 *   · Que lo decidido no vuelva a proponerse ni se toque, y que la noche no caiga en otro modelo si el suyo no está.
 *   · Que lo que escribe el modelo pase por el saneado antes de llegar al repo.
 *
 * Sin red: el buzón, el modelo y el guardado son funciones de prueba que se le pasan a la noche; el espejo y el árbol
 * de operaciones son carpetas temporales.
 *
 * Uso: node --test scripts/tests/instinct-nightly.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const N = require(path.join(RAIZ, 'scripts', 'instincts', 'instinct-nightly.js'));

const HOY = '2026-10-31';
const diaMenos = (n) => new Date(Date.parse(`${HOY}T12:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
const tsDe = (dia) => Math.floor(Date.parse(`${dia}T10:00:00Z`) / 1000);
const sha10 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);

function tmp(nombre) { return fs.mkdtempSync(path.join(os.tmpdir(), `nightly-${nombre}-`)); }

/** Un espejo de laboratorio: `{ carpeta: { día: [líneas] } }`, cada día como lo baja download-runs.js. */
function espejo(dir, carpetas, uniones) {
  for (const [carpeta, dias] of Object.entries(carpetas)) {
    const d = path.join(dir, carpeta, 'instincts');
    fs.mkdirSync(d, { recursive: true });
    for (const [dia, lineas] of Object.entries(dias)) {
      const texto = lineas.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
      fs.writeFileSync(path.join(d, `${dia}.jsonl.gz`), zlib.gzipSync(`${texto}\n`));
    }
  }
  if (uniones) fs.writeFileSync(path.join(dir, '.carpetas-de-maquina.json'), JSON.stringify(uniones));
}

const linea = (dia, repo, summary, extra = {}) => ({ ts: tsDe(dia), session_id: 'sesion-secreta-1', tool: 'Bash', repo, summary, status: 'ok', ...extra });
const veces = (n, dia, repo, summary, extra) => Array.from({ length: n }, () => linea(dia, repo, summary, extra));

/** El perfil y la configuración de la organización, de laboratorio. */
function perfil(dir, prendida = true) {
  const p = path.join(dir, 'team-profile.json');
  fs.writeFileSync(p, JSON.stringify({ integrations: { instincts: prendida } }));
  const t = path.join(dir, 'team-repos.json');
  fs.writeFileSync(t, JSON.stringify({ repos: [] }));
  return { profile: p, teamRepos: t };
}

const listo = () => ({ ok: true, status: 'ok', provider: 'ollama', model: 'gemma4:31b-cloud', secret: { env: 'OLLAMA_API_KEY', present: true } });
const bajado = () => async () => ({ codigo: 0, res: { estado: 'bajado', completo: true } });

/**
 * El modelo de prueba: cuenta sus llamadas y contesta una propuesta por candidato del prompt (o lo que diga `responder`).
 * La revisión contesta «none» para todas, salvo `cubre`.
 */
function modelo({ responder, cubre = {}, caido = false } = {}) {
  const m = { propuestas: [], revisiones: [] };
  m.llamar = async ({ prompt }) => {
    if (caido) return { ok: false, fallo: 'http_500' };
    if (/^You are checking proposed/.test(prompt)) {
      m.revisiones.push(prompt);
      const n = (prompt.match(/^### P\d+$/gm) || []).length;
      const ys = Array.from({ length: n }, (_, i) => `- p: ${i + 1}\n  covered_by: ${cubre[i + 1] || 'none'}\n  why: "x"`);
      return { ok: true, texto: ys.join('\n'), tokens: { entrada: 100, salida: 10 } };
    }
    m.propuestas.push(prompt);
    const n = (prompt.match(/^### Candidate \d+ /gm) || []).length;
    const items = responder ? responder(n, m.propuestas.length) : Array.from({ length: n }, (_, i) => ({ i: i + 1 }));
    const ys = items.map((x) => `- trigger: "${x.trigger || `cuando ${m.propuestas.length}-${x.i}`}"\n  action: "${x.action || `hacer ${m.propuestas.length}-${x.i}`}"\n  confidence: ${x.conf === undefined ? 0.9 : x.conf}\n  domain: "testing"\n  scope: project\n  candidate_index: ${x.idx === undefined ? x.i : x.idx}\n  tycon_artifact_suggestion: null\n  reasoning: "${x.reasoning || 'porque se repite'}"`);
    return { ok: true, texto: ys.join('\n'), tokens: { entrada: 1000, salida: 200 } };
  };
  return m;
}

/** Corre la noche con todo de laboratorio; `guardados` junta los pedidos de guardado. */
async function noche(base, { bajar = bajado(), resolver = listo, m = modelo(), guardar, today = HOY, noPush = false, prendida = true } = {}) {
  const cfg = perfil(base.dir, prendida);
  const guardados = [];
  const sincronizados = [];
  const r = await N.correrNoche({
    ...cfg, mailbox: base.espejo, ops: base.ops, today, noPush, home: '/home/lab',
    deps: {
      bajar, resolveNightly: () => resolver(), llamar: m.llamar,
      sincronizar: (rutas) => { sincronizados.push(rutas); return { ok: true }; },
      guardar: guardar || ((args) => { guardados.push(args); return { ok: true }; }),
    },
  });
  return { ...r, guardados, sincronizados, m };
}

function base(nombre) {
  const dir = tmp(nombre);
  const b = { dir, espejo: path.join(dir, 'espejo'), ops: path.join(dir, 'ops') };
  fs.mkdirSync(b.espejo, { recursive: true });
  fs.mkdirSync(b.ops, { recursive: true });
  return b;
}
const propuestasDe = (b) => {
  const d = path.join(b.ops, 'inbox', 'instincts', 'propuestas');
  try { return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))); } catch (_) { return []; }
};
const informeDe = (b, dia = HOY) => JSON.parse(fs.readFileSync(path.join(b.ops, '.dashboard', 'instincts', `instintos-${dia}.json`), 'utf8'));
const escribirPropuesta = (b, p) => {
  const d = path.join(b.ops, 'inbox', 'instincts', 'propuestas');
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, `${p.huella}.json`);
  fs.writeFileSync(f, `${JSON.stringify(p, null, 2)}\n`);
  return f;
};
const huellaDe = (repo, tool, summary) => sha10(`${repo}|${tool}|${summary.slice(0, 60).trim()}`.toLowerCase());

/** `n` patrones distintos, cada uno repetido 3 veces en dos máquinas: `n` candidatos con la misma fuerza. */
function patrones(n, dia = diaMenos(1)) {
  const a = []; const b = [];
  for (let i = 0; i < n; i++) {
    const s = `comando repetido número ${String(i).padStart(3, '0')}`;
    a.push(...veces(3, dia, 'acme/api', s));
    b.push(...veces(3, dia, 'acme/api', s));
  }
  return { 'mac-a-11111111': { [dia]: a }, 'mac-b-22222222': { [dia]: b } };
}

test('T20 Nightly_ReadsSixtyDayWindow_ResolvesMachines', async () => {
  const b = base('t20');
  const d10 = diaMenos(10); const d59 = diaMenos(59); const d61 = diaMenos(61);
  espejo(b.espejo, {
    'mac-a': { [d59]: [...veces(2, d59, 'acme/api', 'npm test -- uno')] },
    'mac-a-1234abcd': { [d10]: [...veces(2, d10, 'acme/api', 'npm test -- uno'), linea(d10, null, 'sin repo'), '{no es json'] },
    'mac-c': { [d10]: [...veces(2, d10, 'acme/api', 'npm test -- uno')], [d61]: [...veces(12, d61, 'acme/web', 'viejo de 61 días')] },
  }, { schema: 1, carpetas: { 'mac-a': { estado: 'unida', nueva: 'mac-a-1234abcd' }, 'mac-c': { estado: 'compartida', nueva: null } } });
  const r = await noche(b);
  const inf = informeDe(b);
  assert.strictEqual(r.codigo, 0);
  assert.strictEqual(inf.maquinas, 2, 'la vieja unida cuenta como su nueva; la compartida, una vez');
  assert.deepStrictEqual(inf.uniones, { unidas: 1, compartidas: 1 });
  assert.strictEqual(inf.sin_repo, 1);
  assert.strictEqual(inf.ilegibles, 1);
  const ps = propuestasDe(b);
  assert.ok(ps.every((p) => p.patron !== 'viejo de 61 días'), 'el día de hace 61 no entra');
  assert.strictEqual(ps.length, 1, 'npm test -- uno: 6 veces en dos máquinas');
  assert.strictEqual(ps[0].maquinas, 2);

  const b2 = base('t20b');
  espejo(b2.espejo, { 'mac-a': { [d10]: veces(3, d10, 'acme/api', 'x') }, 'mac-a-1234abcd': { [d10]: veces(3, d10, 'acme/api', 'x') } });
  await noche(b2);
  const inf2 = informeDe(b2);
  assert.strictEqual(inf2.uniones, 'no_medidas');
  assert.strictEqual(inf2.maquinas, 2, 'sin el archivo de uniones cada carpeta cuenta sola');
});

test('T21 Nightly_Threshold_TwoMachinesOrTenInOne', () => {
  const d = diaMenos(1);
  const conMaquina = (m, ls) => ls.map((l) => ({ ...l, maquina: m, dia: d }));
  const lineas = [
    ...conMaquina('m1', veces(2, d, 'acme/api', 'dos máquinas')), ...conMaquina('m2', veces(1, d, 'acme/api', 'dos máquinas')),
    ...conMaquina('m1', veces(9, d, 'acme/api', 'nueve en una')),
    ...conMaquina('m3', veces(10, d, 'acme/api', 'diez en una')),
    ...conMaquina('m4', veces(3, d, 'acme/api', 'misma máquina, dos carpetas')),
  ];
  const cs = N.findTeamCandidates(lineas);
  assert.deepStrictEqual(cs.map((c) => c.summary).sort(), ['diez en una', 'dos máquinas'].sort());
  const dos = cs.find((c) => c.summary === 'dos máquinas');
  assert.strictEqual(dos.maquinas, 2);
  assert.strictEqual(typeof dos.maquinas, 'number');
  assert.strictEqual(dos.veces, 3);
  assert.strictEqual(dos.desde, d);
  assert.strictEqual(cs[0].summary, 'dos máquinas', 'más máquinas primero');
  assert.strictEqual(N.huella('ACME/API|Bash|Dos Máquinas'), N.huella('acme/api|bash|dos máquinas'));
  assert.match(N.huella('a|b|c'), /^[0-9a-f]{10}$/);
});

test('T21b Nightly_SameKeyOtherCase_OnePattern', async () => {
  // el pase adversarial: el mismo repo o resumen con otras mayúsculas es el mismo patrón, no dos que se pisan
  const d = diaMenos(1);
  const conMaquina = (m, ls) => ls.map((l) => ({ ...l, maquina: m, dia: d }));
  const cs = N.findTeamCandidates([
    ...conMaquina('a', veces(3, d, 'Acme/App', 'dotnet test')),
    ...conMaquina('b', veces(3, d, 'acme/app', 'dotnet test')),
    ...conMaquina('c', veces(3, d, 'acme/app', 'Dotnet Test')),
  ]);
  assert.strictEqual(cs.length, 1);
  assert.strictEqual(cs[0].veces, 9);
  assert.strictEqual(cs[0].maquinas, 3);
  const b = base('t21b');
  espejo(b.espejo, {
    'mac-a-11111111': { [d]: veces(2, d, 'Acme/App', 'npm run lint') },
    'mac-b-22222222': { [d]: [...veces(1, d, 'Acme/App', 'npm run lint'), ...veces(1, d, 'acme/app', 'npm run lint')] },
    'mac-c-33333333': { [d]: veces(2, d, 'acme/app', 'npm run lint') },
  });
  await noche(b, { resolver: () => ({ ok: false, status: 'not-configured' }) });
  const ps = propuestasDe(b);
  assert.strictEqual(ps.length, 1);
  assert.strictEqual(ps[0].veces, 6);
  assert.strictEqual(ps[0].maquinas, 3);
  const inf = informeDe(b);
  assert.strictEqual(inf.candidatos, 1);
  assert.strictEqual(inf.en_espera, 0);
});

test('T20b Nightly_UnitedFolders_SameDayCountedOnce', async () => {
  // una máquina que cambió de carpeta vuelve a subir sus días a la nueva: el mismo día en las dos cuenta una vez
  const b = base('t20b-dup');
  const d = diaMenos(11);
  const lineas = veces(5, d, 'acme/app', 'npm run lint');
  espejo(b.espejo, { pc: { [d]: lineas }, 'pc-bbbbbbbb': { [d]: lineas } },
    { schema: 1, carpetas: { pc: { estado: 'unida', nueva: 'pc-bbbbbbbb' } } });
  const e = N.leerEspejo(b.espejo, HOY);
  assert.strictEqual(e.lineas.length, 5);
  assert.strictEqual(N.findTeamCandidates(e.lineas).length, 0, '5 en una máquina no llega al umbral de 10');
});

test('T22 Nightly_SkipsKnownHuellasAndDecided', async () => {
  const b = base('t22');
  const d = diaMenos(1);
  const s = ['uno con redaccion', 'dos rechazada', 'tres descartada', 'cinco hash viejo', 'seis aprobada', 'siete nueva'];
  const carp = { 'mac-a-11111111': { [d]: [] }, 'mac-b-22222222': { [d]: [] } };
  for (const x of s) { carp['mac-a-11111111'][d].push(...veces(3, d, 'acme/api', x)); carp['mac-b-22222222'][d].push(...veces(3, d, 'acme/api', x)); }
  espejo(b.espejo, carp);
  const h = (x) => huellaDe('acme/api', 'Bash', x);
  const comun = { herramienta: 'Bash', repo: 'acme/api', veces: 6, maquinas: 2, desde: d, hasta: d, propuesta_el: diaMenos(5), sin_redaccion: null, modelo: null, decision: null };
  escribirPropuesta(b, { ...comun, huella: h(s[0]), estado: 'pendiente', patron: s[0], redaccion: { trigger: 'ya', action: 'tiene', confidence: 0.9 } });
  escribirPropuesta(b, { ...comun, huella: h(s[1]), estado: 'rechazada', patron: s[1], redaccion: { trigger: 'cuando rechazada', action: 'no' }, decision: { motivo: 'no sirve para nada' } });
  escribirPropuesta(b, { ...comun, huella: h(s[2]), estado: 'descartada', patron: s[2], redaccion: null, motivo_corto: 'confianza' });
  escribirPropuesta(b, { ...comun, huella: h(s[4]), estado: 'aprobada', patron: s[4], redaccion: { trigger: 'cuando aprobada', action: 'hacer lo aprobado' }, decision: { texto: 'hacer lo aprobado' } });
  // un instinto viejo, decidido antes del sitio: su hash es el de lo que el modelo va a escribir para «cinco»
  const viejo = sha10('cuando cinco::hacer cinco');
  const arch = path.join(b.ops, 'inbox', 'instincts', 'archived');
  fs.mkdirSync(arch, { recursive: true });
  fs.writeFileSync(path.join(arch, `20260901-cuando-cinco-${viejo}.yaml`), `hash: ${viejo}\ntrigger: "cuando cinco"\nproject: "acme/api"\nrejection_reason: "ya lo hacemos"\n`);
  const m = modelo({ responder: (n) => Array.from({ length: n }, (_, i) => ({ i: i + 1 })) });
  // el prompt pide sólo «cinco» y «siete»: el modelo escribe para «cinco» lo que ya estaba decidido
  m.llamar = ((orig) => async (a) => {
    if (/^You are checking proposed/.test(a.prompt)) return orig(a);
    m.propuestas.push(a.prompt);
    // (la clave va sin mayúsculas: es la misma de la que sale la huella)
    const orden = [...a.prompt.matchAll(/^project\|tool\|summary-prefix: acme\/api\|bash\|(.*)$/gm)].map((x) => x[1]);
    const ys = orden.map((p, i) => (p === s[3]
      ? `- trigger: "cuando cinco"\n  action: "hacer cinco"\n  confidence: 0.9\n  candidate_index: ${i + 1}`
      : `- trigger: "cuando siete"\n  action: "hacer siete"\n  confidence: 0.9\n  candidate_index: ${i + 1}`));
    return { ok: true, texto: ys.join('\n'), tokens: null };
  })(m.llamar);
  await noche(b, { m });
  assert.strictEqual(m.propuestas.length, 1);
  const pedidos = [...m.propuestas[0].matchAll(/summary-prefix: acme\/api\|bash\|(.*)$/gm)].map((x) => x[1]).sort();
  assert.deepStrictEqual(pedidos, [s[3], s[5]].sort(), 'los que tienen archivo no se piden');
  const cinco = propuestasDe(b).find((p) => p.huella === h(s[3]));
  assert.strictEqual(cinco.estado, 'descartada');
  assert.strictEqual(cinco.motivo_corto, 'ya_decidida');
  assert.strictEqual(m.revisiones.length, 1);
  assert.match(m.revisiones[0], /cuando aprobada/);
  assert.match(m.revisiones[0], /cuando rechazada[^\n]*no sirve para nada/);
  assert.match(m.revisiones[0], new RegExp(viejo), 'lo decidido de antes se lee del árbol de operaciones');
  // la noche siguiente «cinco» ya tiene su archivo: no se vuelve a pedir
  const m2 = modelo();
  await noche(b, { m: m2, today: '2026-11-01' });
  assert.strictEqual(m2.propuestas.length, 0);
});

test('T23 Nightly_MailboxStates_StopOrContinuePartial', async () => {
  for (const estado of ['sin_az', 'sin_sesion', 'sin_permiso', 'servicio_fallo']) {
    const b = base(`t23-${estado}`);
    espejo(b.espejo, patrones(1));
    const m = modelo();
    const r = await noche(b, { bajar: async () => ({ codigo: estado === 'servicio_fallo' ? 1 : 0, res: { estado, motivo: 'texto con una máquina mac-a' } }), m });
    assert.strictEqual(r.codigo, 1, estado);
    assert.strictEqual(m.propuestas.length, 0);
    const inf = informeDe(b);
    assert.strictEqual(inf.estado, 'no_medido');
    assert.strictEqual(inf.motivo, estado);
    assert.strictEqual(propuestasDe(b).length, 0);
  }
  for (const estado of ['sin_red', 'parcial']) {
    const b = base(`t23-${estado}`);
    espejo(b.espejo, patrones(1));
    const r = await noche(b, { bajar: async () => ({ codigo: 1, res: { estado } }) });
    assert.strictEqual(r.codigo, 0, estado);
    assert.strictEqual(informeDe(b).parcial, true);
    assert.strictEqual(propuestasDe(b).length, 1);
  }
  // la noche no necesita las conversaciones: las pide fuera, con un tope de tiempo largo; quedarse sin tiempo es a medias
  const op = base('t23-opciones');
  espejo(op.espejo, patrones(1));
  let pedido = null;
  const ro = await noche(op, { bajar: async (o) => { pedido = o; return { codigo: 0, res: { estado: 'sin_tiempo', completo: false } }; } });
  assert.strictEqual(pedido.instintos, true);
  assert.strictEqual(pedido.sinHilos, true);
  assert.ok(pedido.budgetMs >= 600000);
  assert.strictEqual(ro.codigo, 0);
  assert.strictEqual(informeDe(op).parcial, true);
  const ap = base('t23-apagada');
  let tocado = false;
  const r = await noche(ap, { prendida: false, bajar: async () => { tocado = true; return { codigo: 0, res: { estado: 'bajado' } }; } });
  assert.strictEqual(r.codigo, 0);
  assert.strictEqual(tocado, false);
  assert.strictEqual(informeDe(ap).estado, 'apagado');
  const il = base('t23-ilegible');
  const rr = await N.correrNoche({ profile: path.join(il.dir, 'no-existe.json'), teamRepos: path.join(il.dir, 'team-repos.json'), mailbox: il.espejo, ops: il.ops, today: HOY, noPush: true, deps: { bajar: bajado(), resolveNightly: listo, llamar: modelo().llamar } });
  assert.strictEqual(rr.codigo, 1);
  assert.strictEqual(informeDe(il).estado, 'no_medido');
  assert.strictEqual(informeDe(il).motivo, 'perfil_ilegible');
});

test('T24 Nightly_ModelNotReady_NumbersOnlyNoFallback', async () => {
  const casos = { 'not-configured': 'sin_modelo', 'no-model': 'sin_modelo', 'not-allowed': 'sin_modelo', 'no-secret': 'sin_llave', unreadable: 'sin_modelo' };
  for (const [status, causa] of Object.entries(casos)) {
    const b = base(`t24-${status}`);
    espejo(b.espejo, patrones(3));
    const m = modelo();
    await noche(b, { resolver: () => ({ ok: false, status, provider: status === 'no-secret' ? 'ollama' : null, model: null }), m });
    assert.strictEqual(m.propuestas.length + m.revisiones.length, 0, status);
    const ps = propuestasDe(b);
    assert.strictEqual(ps.length, 3);
    assert.ok(ps.every((p) => p.redaccion === null && p.sin_redaccion === causa && p.estado === 'pendiente'), status);
    const inf = informeDe(b);
    assert.strictEqual(inf.modelo.estado, status);
    assert.strictEqual(inf.sin_redaccion[causa], 3);
  }
});

test('T25 Nightly_CapTwenty_BatchesOfFifteen', async () => {
  const b = base('t25');
  espejo(b.espejo, patrones(47));
  const m = modelo();
  await noche(b, { m });
  assert.strictEqual(m.propuestas.length, 2, 'dos tandas');
  assert.strictEqual((m.propuestas[0].match(/^### Candidate \d+ /gm) || []).length, 15);
  assert.strictEqual((m.propuestas[1].match(/^### Candidate \d+ /gm) || []).length, 5);
  const ps = propuestasDe(b);
  assert.strictEqual(ps.length, 47);
  assert.strictEqual(ps.filter((p) => p.redaccion).length, 20);
  assert.strictEqual(ps.filter((p) => p.sin_redaccion === 'tope').length, 27);
  const conRed = ps.filter((p) => p.redaccion).map((p) => p.patron).sort();
  assert.deepStrictEqual(conRed, Array.from({ length: 20 }, (_, i) => `comando repetido número ${String(i).padStart(3, '0')}`));
  assert.strictEqual(informeDe(b).con_redaccion, 20);
  assert.strictEqual(informeDe(b).sin_redaccion.tope, 27);
});

test('T26 Nightly_ReviewDiscards_RecordedNotReasked', async () => {
  const b = base('t26');
  espejo(b.espejo, patrones(4));
  // 1: baja confianza · 2: la cubre un control del árbol · 3: sin candidate_index válido · 4: buena
  const m = modelo({ responder: () => [{ i: 1, conf: 0.6 }, { i: 2 }, { i: 3, idx: 99 }, { i: 4 }], cubre: { 1: 'instinct-trigger' } });
  await noche(b, { m });
  const ps = propuestasDe(b);
  const por = (i) => ps.find((p) => p.patron === `comando repetido número ${String(i).padStart(3, '0')}`);
  assert.strictEqual(por(0).estado, 'descartada'); assert.strictEqual(por(0).motivo_corto, 'confianza');
  assert.strictEqual(por(1).estado, 'descartada'); assert.strictEqual(por(1).motivo_corto, 'cubierta'); assert.strictEqual(por(1).cita, 'instinct-trigger');
  assert.strictEqual(por(2).estado, 'descartada'); assert.strictEqual(por(2).motivo_corto, 'sin_propuesta');
  assert.strictEqual(por(3).estado, 'pendiente'); assert.ok(por(3).redaccion && por(3).redaccion.trigger);
  assert.strictEqual(informeDe(b).descartadas, 3);
  const m2 = modelo();
  await noche(b, { m: m2, today: '2026-11-01' });
  assert.strictEqual(m2.propuestas.length, 0, 'la noche siguiente no vuelve a pedirlas');
});

test('T27 Nightly_NumbersOnlyCompletedLater_DecidedNeverTouched', async () => {
  const b = base('t27');
  espejo(b.espejo, patrones(4));
  const pat = (i) => `comando repetido número ${String(i).padStart(3, '0')}`;
  const h = (i) => huellaDe('acme/api', 'Bash', pat(i));
  const comun = { herramienta: 'Bash', repo: 'acme/api', veces: 6, maquinas: 2, desde: diaMenos(1), hasta: diaMenos(1), propuesta_el: diaMenos(3), modelo: null, decision: null };
  escribirPropuesta(b, { ...comun, huella: h(0), patron: pat(0), estado: 'pendiente', redaccion: null, sin_redaccion: 'tope' });
  escribirPropuesta(b, { ...comun, huella: h(1), patron: pat(1), estado: 'pendiente', redaccion: null, sin_redaccion: 'fallo' });
  const fa = escribirPropuesta(b, { ...comun, huella: h(2), patron: pat(2), estado: 'aprobada', redaccion: { trigger: 'a', action: 'b' }, sin_redaccion: null, decision: { texto: 'b' } });
  const fr = escribirPropuesta(b, { ...comun, huella: h(3), patron: pat(3), estado: 'rechazada', redaccion: { trigger: 'c', action: 'd' }, sin_redaccion: null, decision: { motivo: 'no' } });
  const antesA = fs.readFileSync(fa); const antesR = fs.readFileSync(fr);
  // primero con el modelo caído: las pendientes siguen como estaban
  const pendAntes = fs.readFileSync(path.join(path.dirname(fa), `${h(0)}.json`));
  await noche(b, { m: modelo({ caido: true }) });
  assert.deepStrictEqual(fs.readFileSync(path.join(path.dirname(fa), `${h(0)}.json`)), pendAntes);
  // las pendientes viejas que no se pudieron completar se cuentan aparte: «sin redactar» habla de las nuevas
  assert.strictEqual(informeDe(b).sin_completar.fallo, 2);
  assert.strictEqual(informeDe(b).sin_redaccion.fallo, 0);
  // después con el modelo bueno: se completan
  const m = modelo();
  await noche(b, { m, today: '2026-11-01' });
  assert.strictEqual(m.propuestas.length, 1);
  const ps = propuestasDe(b);
  for (const i of [0, 1]) {
    const p = ps.find((x) => x.huella === h(i));
    assert.strictEqual(p.estado, 'pendiente'); assert.ok(p.redaccion); assert.strictEqual(p.sin_redaccion, null);
  }
  assert.deepStrictEqual(fs.readFileSync(fa), antesA);
  assert.deepStrictEqual(fs.readFileSync(fr), antesR);
});

test('T27b Nightly_EmptyOrGarbledAnswer_IsFailNotDiscard', async () => {
  // una respuesta 200 que no trae ninguna propuesta legible no es «el modelo no propuso nada»: es un fallo, y se reintenta
  for (const texto of ['', 'lo siento, no puedo ayudar con eso', '```yaml\n- trigger sin dos puntos\n```']) {
    const b = base('t27b');
    espejo(b.espejo, patrones(2));
    const m = modelo();
    m.llamar = async ({ prompt }) => (/^You are checking proposed/.test(prompt) ? { ok: true, texto: '' } : { ok: true, texto, tokens: null });
    await noche(b, { m });
    const ps = propuestasDe(b);
    assert.ok(ps.every((p) => p.estado === 'pendiente' && p.redaccion === null && p.sin_redaccion === 'fallo'), JSON.stringify(texto));
    const inf = informeDe(b);
    assert.strictEqual(inf.sin_redaccion.fallo, 2);
    assert.deepStrictEqual(inf.modelo.fallos, { respuesta_ilegible: 1 });
  }
  // propuestas que llegan pero ninguna con un candidate_index válido: tampoco es «no propuso nada»
  const sinIndice = base('t27b-sin-indice');
  espejo(sinIndice.espejo, patrones(2));
  const mi = modelo({ responder: () => [{ i: 1, idx: 'uno' }, { i: 2, idx: 99 }] });
  await noche(sinIndice, { m: mi });
  assert.ok(propuestasDe(sinIndice).every((p) => p.estado === 'pendiente' && p.sin_redaccion === 'fallo'));
  // «[]» es una respuesta: el modelo dijo que ninguno vale la pena, también con una frase antes o en un bloque json
  for (const texto of ['[]', 'Ninguno vale la pena:\n```yaml\n[]\n```', '```json\n[]\n```', 'Respuesta:\n[]']) {
    const b = base('t27b-vacio');
    espejo(b.espejo, patrones(2));
    const m = modelo();
    m.llamar = async () => ({ ok: true, texto, tokens: null });
    await noche(b, { m });
    assert.ok(propuestasDe(b).every((p) => p.estado === 'descartada' && p.motivo_corto === 'sin_propuesta'), JSON.stringify(texto));
  }
  // un fallo del proveedor queda contado por su código
  const c = base('t27b-caido');
  espejo(c.espejo, patrones(2));
  await noche(c, { m: modelo({ caido: true }) });
  assert.deepStrictEqual(informeDe(c).modelo.fallos, { http_500: 1 });
});

test('T27c Nightly_ReportSaysUnreadableDaysReviewAndCorruptProposals', async () => {
  const b = base('t27c');
  espejo(b.espejo, patrones(1));
  // un día del espejo que no se descomprime, y una propuesta del repo que no se lee
  fs.writeFileSync(path.join(b.espejo, 'mac-a-11111111', 'instincts', `${diaMenos(2)}.jsonl.gz`), 'no es gzip');
  const d = path.join(b.ops, 'inbox', 'instincts', 'propuestas');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'abcdefabcd.json'), '{roto');
  const m = modelo();
  m.llamar = ((orig) => async (a) => (/^You are checking proposed/.test(a.prompt) ? { ok: false, fallo: 'tiempo' } : orig(a)))(m.llamar);
  await noche(b, { m });
  const inf = informeDe(b);
  assert.strictEqual(inf.parcial, true, 'un día que no se pudo leer deja la lectura a medias');
  assert.strictEqual(inf.dias_ilegibles, 1);
  assert.strictEqual(inf.propuestas_ilegibles, 1);
  assert.strictEqual(inf.revision, 'fallo');
  assert.deepStrictEqual(inf.modelo.fallos, { tiempo: 1 }, 'el código del fallo de la revisión también se cuenta');
  // una revisión que contesta algo sin ningún veredicto no revisó nada: es un fallo, no un «ok»
  const v = base('t27c-ilegible');
  espejo(v.espejo, patrones(1));
  const m2 = modelo();
  m2.llamar = ((orig) => async (a) => (/^You are checking proposed/.test(a.prompt) ? { ok: true, texto: 'no entendí', tokens: null } : orig(a)))(m2.llamar);
  await noche(v, { m: m2 });
  assert.strictEqual(informeDe(v).revision, 'fallo');
  assert.deepStrictEqual(informeDe(v).modelo.fallos, { respuesta_ilegible: 1 });
});

test('T42 Nightly_ProposalFile_ShapeSanitizedNoMachines', async () => {
  const b = base('t42');
  const d = diaMenos(1);
  // la casa de mentira también va por partes: escrita entera tiene la forma de una ruta de una máquina real
  const CASA = ['', 'home', 'lab'].join('/');
  const s = `curl -H x ${CASA}/proyecto token=abc12345`;
  espejo(b.espejo, {
    'mac-uno-aaaaaaaa': { [d]: veces(1, d, 'acme/api', s, { session_id: 'sesion-uno', email: 'una@acme.test' }) },
    'mac-dos-bbbbbbbb': { [d]: veces(1, d, 'acme/api', s, { session_id: 'sesion-dos' }) },
    'mac-tres-cccccccc': { [d]: veces(1, d, 'acme/api', s, { session_id: 'sesion-tres' }) },
  });
  // la llave de mentira va armada por partes: escrita entera tiene la forma de una llave real
  const SK = ['sk', 'abcdefghijklmnopqrstuvwx'].join('-');
  const m = modelo({ responder: () => [{ i: 1, trigger: 'al llamar con token=s3cr3tvalor', action: `mirar ${CASA}/archivo`, reasoning: `usa ${SK}` }] });
  // los campos cortos que también escribe el modelo pasan por el saneado
  m.llamar = ((orig) => async (a) => {
    const r = await orig(a);
    if (/^You are checking proposed/.test(a.prompt)) return r;
    return { ...r, texto: r.texto.replace('domain: "testing"', `domain: "${CASA}/secreto"`).replace('tycon_artifact_suggestion: null', 'tycon_artifact_suggestion: "token=otrosecreto99"') };
  })(m.llamar);
  await noche(b, { m });
  const [p] = propuestasDe(b);
  for (const k of ['huella', 'estado', 'herramienta', 'repo', 'patron', 'veces', 'maquinas', 'desde', 'hasta', 'propuesta_el', 'redaccion', 'sin_redaccion', 'modelo', 'decision']) assert.ok(k in p, k);
  for (const k of ['trigger', 'action', 'domain', 'scope', 'confidence', 'reasoning', 'tycon_artifact_suggestion']) assert.ok(k in p.redaccion, k);
  assert.strictEqual(p.maquinas, 3);
  assert.deepStrictEqual(p.modelo, { provider: 'ollama', model: 'gemma4:31b-cloud' });
  const texto = fs.readFileSync(path.join(b.ops, 'inbox', 'instincts', 'propuestas', `${p.huella}.json`), 'utf8');
  for (const x of ['s3cr3tvalor', 'abc12345', '/home/lab', SK, 'otrosecreto99', 'mac-uno', 'mac-dos', 'mac-tres', 'sesion-', 'una@acme.test']) assert.ok(!texto.includes(x), x);
  assert.match(texto, /\$HOME/);
});

test('T43 Nightly_SaveAndReport_NoMedidoNeverEmpty', async () => {
  const claves = ['fecha', 'estado', 'motivo', 'parcial', 'uniones', 'maquinas', 'maquinas_sin_reportar', 'candidatos', 'ya_propuestas', 'nuevas', 'en_espera', 'con_redaccion', 'sin_redaccion', 'descartadas', 'pendientes_total', 'modelo', 'tokens'];
  const vacia = base('t43-vacia');
  // días bajados, pero nada se repite: una noche medida sin candidatos
  espejo(vacia.espejo, { 'mac-a-11111111': { [diaMenos(1)]: [linea(diaMenos(1), 'acme/api', 'una sola vez')] } });
  const r = await noche(vacia);
  assert.strictEqual(r.codigo, 0);
  const inf = informeDe(vacia);
  for (const k of claves) assert.ok(k in inf, k);
  assert.strictEqual(inf.candidatos, 0);
  assert.strictEqual(r.guardados.length, 1, 'una noche sin candidatos igual guarda su informe');
  assert.deepStrictEqual(r.guardados[0].rutas, ['inbox/instincts/propuestas', '.dashboard/instincts']);
  assert.deepStrictEqual(r.sincronizados[0], ['inbox/instincts/propuestas', '.dashboard/instincts']);

  const caido = base('t43-caido');
  const rc = await noche(caido, { bajar: async () => ({ codigo: 1, res: { estado: 'sin_contenedor' } }) });
  const ic = informeDe(caido);
  assert.strictEqual(rc.codigo, 1);
  for (const k of ['maquinas', 'candidatos', 'nuevas', 'con_redaccion', 'descartadas']) assert.strictEqual(ic[k], null, `${k}: null, nunca 0`);
  assert.strictEqual(rc.guardados.length, 1, 'el informe no_medido también se guarda');

  // el buzón se leyó pero no trajo ningún día de instintos: «no pude ver nada», nunca «no había nada»
  const sinDias = base('t43-sindias');
  const rs = await noche(sinDias);
  assert.strictEqual(rs.codigo, 1);
  assert.strictEqual(informeDe(sinDias).estado, 'no_medido');
  assert.strictEqual(informeDe(sinDias).motivo, 'sin_dias');

  const noViaja = base('t43-noviaja');
  espejo(noViaja.espejo, patrones(1));
  const rn = await noche(noViaja, { guardar: () => ({ ok: false, motivo: 'rechazado' }) });
  assert.strictEqual(rn.codigo, 1, '«no viajó» nunca es «no había nada»');

  const ensayo = base('t43-ensayo');
  espejo(ensayo.espejo, patrones(1));
  const re = await noche(ensayo, { noPush: true });
  assert.strictEqual(re.guardados.length + re.sincronizados.length, 0);
  assert.strictEqual(propuestasDe(ensayo).length, 1);
});

test('T44 Nightly_SilentMachines_AndNewProposalsCap', async () => {
  const b = base('t44');
  const carp = patrones(120);
  const d9 = diaMenos(9);
  carp['mac-calla-33333333'] = { [d9]: veces(1, d9, 'acme/api', 'algo suelto') };
  espejo(b.espejo, carp);
  const m = modelo();
  await noche(b, { m });
  const inf = informeDe(b);
  assert.strictEqual(inf.maquinas_sin_reportar, 1);
  const ps = propuestasDe(b);
  assert.strictEqual(ps.length, 50);
  assert.strictEqual(ps.filter((p) => p.redaccion).length, 20);
  assert.strictEqual(inf.nuevas, 50);
  assert.strictEqual(inf.en_espera, 70);
  assert.strictEqual(inf.pendientes_total, 50);
});

test('T47 Pipeline_Model_Schedule_Secrets_Effects', () => {
  const dir = path.join(RAIZ, 'pipelines', 'operations');
  const yml = fs.readFileSync(path.join(dir, 'instinct-proposals.yml'), 'utf8');
  assert.match(yml, /cron: '0 2 \* \* \*'/);
  assert.match(yml, /^trigger: none/m);
  // `fuente` y `cut` son de las copias de operaciones de una organización que superpone el arnés; el modelo, como los
  // demás de pipelines/operations/, lleva `efectos`
  for (const p of ['efectos', 'mailboxConnection']) assert.match(yml, new RegExp(`- name: ${p}\\b`), p);
  assert.match(yml, /OLLAMA_API_KEY: \$\(OLLAMA_API_KEY\)/, 'la llave llega por env desde la variable secreta');
  assert.match(yml, /ANTHROPIC_API_KEY: \$\(ANTHROPIC_API_KEY\)/);
  assert.ok(!/(OLLAMA|ANTHROPIC)_API_KEY:\s*['"]?[A-Za-z0-9]{8,}/.test(yml), 'ninguna llave escrita');
  assert.match(yml, /instinct-nightly\.js/);
  // la bajada pide la organización de Azure DevOps: en el agente sale del perfil que bajó el paso anterior
  assert.strictEqual((yml.match(/export TYCON_PROFILE="\$TEAM_PROFILE"/g) || []).length, 2, 'las dos formas de correr la noche le pasan el perfil');
  assert.match(yml, /\$\{\{ if eq\(parameters\.efectos, false\) \}\}:[\s\S]*--no-push/, 'sin efectos, la noche no guarda');
  assert.strictEqual((yml.match(/instinct-nightly\.js[^\n]*\n[^\n]*\n[^\n]*\$\(SIN_GUARDAR\)/g) || []).length, 2, 'las dos formas de correr la noche respetan efectos');
  assert.ok(!/push-nightly-data\.js save/.test(yml), 'el guardado lo hace la noche, que respeta --no-push');
  const otros = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') && f !== 'instinct-proposals.yml')
    .flatMap((f) => [...fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/cron: '([^']+)'/g)].map((x) => x[1]));
  assert.ok(otros.length > 3);
  assert.ok(!otros.includes('0 2 * * *'), 'no coincide con la hora de otro nocturno');
  const dep = fs.readFileSync(path.join(dir, 'dependency-audit.yml'), 'utf8');
  assert.match(dep, /--instincts "\$\(Build\.SourcesDirectory\)\/\.dashboard\/instincts\/instintos-\$HOY\.json"/, 'el resumen recibe el informe de hoy');
});

test('T48b Trigger_NeverLaunchesObserver_SameCommandFile', () => {
  // la prueba con procesos vive en instinct-executor.test.sh (T48); acá, que el disparador ya no nombre el lanzamiento
  const sh = fs.readFileSync(path.join(RAIZ, 'scripts', 'hooks', 'instinct-trigger.sh'), 'utf8');
  assert.ok(!/nohup[^\n]*OBSERVER_SCRIPT/.test(sh));
  assert.ok(sh.indexOf('_heal=') < sh.indexOf('exit 0'), 'la reparación de arranque va antes de cualquier salida');
});

test('T49 Command_NoRun_NoticeTextNamesTheNight', () => {
  const cmd = fs.readFileSync(path.join(RAIZ, 'commands', 'tycon-instincts.md'), 'utf8');
  assert.ok(!/\|\s*`run`\s*\|/.test(cmd), 'la tabla no ofrece run');
  assert.ok(!/\| run\]/.test(cmd), 'el argument-hint no ofrece run');
  assert.match(cmd, /pestaña Aprendizajes/);
  const notice = require(path.join(RAIZ, 'integrations', 'instincts', 'scripts', 'instincts-notice.js'));
  const st = tmp('t49');
  const d = notice.decide({ prendida: true, env: {}, stateDir: st, now: new Date(`${HOY}T10:00:00Z`) });
  assert.match(d.text, /noche de la organización/);
  assert.match(d.text, /modelo que elige la organización/);
  assert.ok(!/máquina del mantenedor|la del mantenedor/.test(d.text));
  assert.strictEqual(d.seal.schema, 2);
  // una máquina ya avisada con el texto viejo lo vuelve a ver una vez, sin mover el día desde el que sube
  fs.writeFileSync(path.join(st, notice.SEAL), JSON.stringify({ schema: 1, said_on: '2026-10-20', said_at: '2026-10-20T10:00:00.000Z', state: 'prendida' }));
  const d2 = notice.decide({ prendida: true, env: {}, stateDir: st, now: new Date(`${HOY}T10:00:00Z`) });
  assert.match(d2.text, /noche de la organización/);
  assert.strictEqual(d2.seal.said_on, '2026-10-20');
  assert.strictEqual(d2.seal.schema, 2);
  notice.seal(st, d2.seal);
  assert.strictEqual(notice.decide({ prendida: true, env: {}, stateDir: st, now: new Date(`${HOY}T11:00:00Z`) }).text, null);
  const obs = fs.readFileSync(path.join(RAIZ, 'scripts', 'instincts', 'instinct-observer.js'), 'utf8');
  assert.ok(!/TYCON_INSTINCT_MINING=0/.test(obs), 'el observador nombra TYCON_INSTINCTS=0');
});

test('T35 Promote_ApproveAndReject_UnchangedForOldProposals', () => {
  const lab = tmp('t35');
  const arbol = path.join(lab, 'arbol');
  fs.mkdirSync(path.join(arbol, 'scripts', 'instincts'), { recursive: true });
  fs.mkdirSync(path.join(arbol, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(arbol, 'scripts', 'setup', 'harness'), { recursive: true });
  for (const f of fs.readdirSync(path.join(RAIZ, 'scripts', 'instincts'))) fs.copyFileSync(path.join(RAIZ, 'scripts', 'instincts', f), path.join(arbol, 'scripts', 'instincts', f));
  for (const f of fs.readdirSync(path.join(RAIZ, 'scripts', 'lib'))) if (f.endsWith('.js')) fs.copyFileSync(path.join(RAIZ, 'scripts', 'lib', f), path.join(arbol, 'scripts', 'lib', f));
  for (const f of fs.readdirSync(path.join(RAIZ, 'scripts', 'setup', 'harness'))) if (f.endsWith('.js')) fs.copyFileSync(path.join(RAIZ, 'scripts', 'setup', 'harness', f), path.join(arbol, 'scripts', 'setup', 'harness', f));
  const buzon = path.join(arbol, 'inbox', 'instincts');
  fs.mkdirSync(path.join(buzon, 'pending'), { recursive: true });
  fs.writeFileSync(path.join(buzon, 'README.md'), 'buzón de prueba\n');
  const yaml = (h, t) => `hash: ${h}\ntrigger: "${t}"\naction: "hacer"\nconfidence: 0.9\ndomain: "testing"\nscope: project\nproject: "acme"\nevidence_count: 4\ntycon_artifact_suggestion: null\nreasoning: "r"\nproposed_at: 2026-10-01T00:00:00Z\n`;
  fs.writeFileSync(path.join(buzon, 'pending', '20261001-uno-aaaaaaaaaa.yaml'), yaml('aaaaaaaaaa', 'uno'));
  fs.writeFileSync(path.join(buzon, 'pending', '20261001-dos-bbbbbbbbbb.yaml'), yaml('bbbbbbbbbb', 'dos'));
  const home = path.join(lab, 'home');
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const run = (...a) => spawnSync(process.execPath, [path.join(arbol, 'scripts', 'instincts', 'instinct-promote.js'), ...a], { env, encoding: 'utf8' });
  const ap = run('approve', 'aaaaaaaaaa');
  assert.strictEqual(ap.status, 0, ap.stderr);
  assert.match(ap.stdout, /mem_save/);
  assert.ok(fs.readdirSync(path.join(buzon, 'promoted')).some((f) => f.includes('aaaaaaaaaa')));
  const re = run('reject', 'bbbbbbbbbb', '--reason', 'no aplica');
  assert.strictEqual(re.status, 0, re.stderr);
  const arch = fs.readdirSync(path.join(buzon, 'archived')).find((f) => f.includes('bbbbbbbbbb'));
  assert.match(fs.readFileSync(path.join(buzon, 'archived', arch), 'utf8'), /no aplica/);
});
