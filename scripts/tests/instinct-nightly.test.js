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

const ES_RECOMENDACION = /^Sos quien revisa cada noche/;

/**
 * El modelo de prueba: cuenta sus llamadas y contesta una propuesta por candidato del prompt (o lo que diga `responder`).
 * La revisión contesta «none» para todas, salvo `cubre`. El pedido de recomendación contesta «approve» para todas, o lo
 * que diga `recomendar(i)`; `recomendacionCruda` reemplaza la respuesta entera.
 */
function modelo({ responder, cubre = {}, caido = false, recomendar, recomendacionCruda } = {}) {
  const m = { propuestas: [], revisiones: [], recomendaciones: [] };
  m.llamar = async ({ prompt }) => {
    if (caido) return { ok: false, fallo: 'http_500' };
    if (/^You are checking proposed/.test(prompt)) {
      m.revisiones.push(prompt);
      const n = (prompt.match(/^### P\d+$/gm) || []).length;
      const ys = Array.from({ length: n }, (_, i) => `- p: ${i + 1}\n  covered_by: ${cubre[i + 1] || 'none'}\n  why: "x"`);
      return { ok: true, texto: ys.join('\n'), tokens: { entrada: 100, salida: 10 } };
    }
    if (ES_RECOMENDACION.test(prompt)) {
      m.recomendaciones.push(prompt);
      if (recomendacionCruda !== undefined) return { ok: true, texto: recomendacionCruda, tokens: { entrada: 50, salida: 5 } };
      const n = (prompt.match(/^### P\d+$/gm) || []).length;
      const ys = Array.from({ length: n }, (_, i) => {
        const r = { recommend: 'approve', why: 'Le sirve a todo el equipo', ...(recomendar ? recomendar(i + 1) : {}) };
        return `- p: ${i + 1}\n  recommend: ${r.recommend}\n  why: "${r.why}"`;
      });
      return { ok: true, texto: ys.join('\n'), tokens: { entrada: 50, salida: 5 } };
    }
    m.propuestas.push(prompt);
    const n = (prompt.match(/^### Candidate \d+ /gm) || []).length;
    const items = responder ? responder(n, m.propuestas.length) : Array.from({ length: n }, (_, i) => ({ i: i + 1 }));
    const ys = items.map((x) => `- trigger: "${x.trigger || `cuando ${m.propuestas.length}-${x.i}`}"\n  action: "${x.action || `hacer ${m.propuestas.length}-${x.i}`}"\n  confidence: ${x.conf === undefined ? 0.9 : x.conf}\n  domain: "testing"\n  scope: ${x.scope || 'global'}\n  candidate_index: ${x.idx === undefined ? x.i : x.idx}\n  tycon_artifact_suggestion: null\n  reasoning: "${x.reasoning || 'porque se repite'}"`);
    return { ok: true, texto: ys.join('\n'), tokens: { entrada: 1000, salida: 200 } };
  };
  return m;
}

/** Corre la noche con todo de laboratorio; `guardados` junta los pedidos de guardado. */
async function noche(base, { bajar = bajado(), resolver = listo, m = modelo(), guardar, today = HOY, noPush = false, prendida = true, home = '/home/lab' } = {}) {
  const cfg = perfil(base.dir, prendida);
  const guardados = [];
  const sincronizados = [];
  const r = await N.correrNoche({
    ...cfg, mailbox: base.espejo, ops: base.ops, today, noPush, home,
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
  await noche(b);
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
    if (/^You are checking proposed/.test(a.prompt) || ES_RECOMENDACION.test(a.prompt)) return orig(a);
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
    assert.strictEqual(propuestasDe(b).length, 0, `${status}: una propuesta nueva nace redactada o no nace`);
    const inf = informeDe(b);
    assert.strictEqual(inf.modelo.estado, status);
    assert.strictEqual(inf.en_espera, 3);
    assert.strictEqual(inf.en_espera_por[causa], 3);
    assert.strictEqual(inf.sin_redaccion[causa], 0);
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
  assert.strictEqual(ps.length, 20, 'las que el tope no alcanzó no tienen archivo');
  assert.strictEqual(ps.filter((p) => p.redaccion).length, 20);
  const conRed = ps.filter((p) => p.redaccion).map((p) => p.patron).sort();
  assert.deepStrictEqual(conRed, Array.from({ length: 20 }, (_, i) => `comando repetido número ${String(i).padStart(3, '0')}`));
  assert.strictEqual(informeDe(b).con_redaccion, 20);
  assert.strictEqual(informeDe(b).en_espera_por.tope, 27);
  assert.strictEqual(informeDe(b).sin_redaccion.tope, 0);
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
    assert.strictEqual(propuestasDe(b).length, 0, `${JSON.stringify(texto)}: esperan a otra noche, sin archivo`);
    const inf = informeDe(b);
    assert.strictEqual(inf.en_espera_por.fallo, 2);
    assert.strictEqual(inf.sin_redaccion.fallo, 0);
    assert.deepStrictEqual(inf.modelo.fallos, { respuesta_ilegible: 1 });
  }
  // propuestas que llegan pero ninguna con un candidate_index válido: tampoco es «no propuso nada»
  const sinIndice = base('t27b-sin-indice');
  espejo(sinIndice.espejo, patrones(2));
  const mi = modelo({ responder: () => [{ i: 1, idx: 'uno' }, { i: 2, idx: 99 }] });
  await noche(sinIndice, { m: mi });
  assert.strictEqual(propuestasDe(sinIndice).length, 0);
  assert.strictEqual(informeDe(sinIndice).en_espera_por.fallo, 2);
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
  assert.strictEqual(ps.length, 20);
  assert.strictEqual(ps.filter((p) => p.redaccion).length, 20);
  assert.strictEqual(inf.nuevas, 20);
  assert.strictEqual(inf.en_espera, 100);
  assert.strictEqual(inf.pendientes_total, 20);
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

test('T17 4.13-Nightly_ReadsSiteDecision_NotReaskedAndInReview @story-4.13 @ac-15 — lo que escribe el sitio, lo lee la noche', async () => {
  const b = base('t17');
  const d = diaMenos(1);
  const s = ['aprobada por el sitio', 'rechazada por el sitio', 'aprobada sin redaccion', 'una nueva'];
  const carp = { 'mac-a-11111111': { [d]: [] }, 'mac-b-22222222': { [d]: [] } };
  for (const x of s) { carp['mac-a-11111111'][d].push(...veces(3, d, 'acme/api', x)); carp['mac-b-22222222'][d].push(...veces(3, d, 'acme/api', x)); }
  espejo(b.espejo, carp);
  const h = (x) => huellaDe('acme/api', 'Bash', x);
  const comun = { herramienta: 'Bash', repo: 'acme/api', veces: 6, maquinas: 2, desde: d, hasta: d, propuesta_el: diaMenos(5), estado: 'pendiente', sin_redaccion: null, modelo: null, decision: null };
  const dir = path.join(b.ops, 'inbox', 'instincts', 'propuestas');
  fs.mkdirSync(dir, { recursive: true });
  // los tres archivos, escritos con la misma función que usa el sitio
  const escritos = [
    [{ ...comun, huella: h(s[0]), patron: s[0], redaccion: { trigger: 'cuando sitio aprueba', action: 'hacer la sugerida' } }, { estado: 'aprobada', por: 'lead@acme.example', el: diaMenos(2), texto: 'Texto confirmado por quien mantiene', pedido: 'https://github.example/acme/perfil/pull/3' }],
    [{ ...comun, huella: h(s[1]), patron: s[1], redaccion: { trigger: 'cuando sitio rechaza', action: 'no' } }, { estado: 'rechazada', por: 'lead@acme.example', el: diaMenos(2), motivo: 'Motivo del rechazo del sitio' }],
    [{ ...comun, huella: h(s[2]), patron: s[2], redaccion: null, sin_redaccion: 'tope' }, { estado: 'aprobada', por: 'lead@acme.example', el: diaMenos(2), texto: 'Regla escrita a mano sin redaccion', pedido: null }],
  ].map(([p, dec]) => {
    const f = path.join(dir, `${p.huella}.json`);
    fs.writeFileSync(f, N.archivoDecidido(p, dec));
    return f;
  });
  const antes = escritos.map((f) => fs.readFileSync(f));
  const decidido = JSON.parse(antes[0]);
  assert.strictEqual(decidido.estado, 'aprobada');
  assert.deepStrictEqual(decidido.decision, { por: 'lead@acme.example', el: diaMenos(2), texto: 'Texto confirmado por quien mantiene', pedido: 'https://github.example/acme/perfil/pull/3' });
  assert.throws(() => N.archivoDecidido(comun, { estado: 'pendiente' }), /estado/);
  const m = modelo();
  await noche(b, { m });
  assert.strictEqual(m.propuestas.length, 1);
  const pedidos = [...m.propuestas[0].matchAll(/summary-prefix: acme\/api\|bash\|(.*)$/gm)].map((x) => x[1]);
  assert.deepStrictEqual(pedidos, [s[3]], 'ninguna decidida se vuelve a pedir');
  assert.strictEqual(m.revisiones.length, 1);
  assert.match(m.revisiones[0], /cuando sitio aprueba[^\n]*Texto confirmado por quien mantiene/);
  assert.match(m.revisiones[0], /cuando sitio rechaza[^\n]*Motivo del rechazo del sitio/);
  assert.doesNotMatch(m.revisiones[0], /Regla escrita a mano sin redaccion/, 'la que no tiene redacción no entra a la revisión');
  escritos.forEach((f, i) => assert.deepStrictEqual(fs.readFileSync(f), antes[i], `${path.basename(f)} queda byte por byte`));
});

// ── 4.14: la noche no propone ruido y recomienda cada propuesta ──────────────────────────────────────────────────────────

const recomendacionesDe = (b) => JSON.parse(fs.readFileSync(path.join(b.ops, '.dashboard', 'instincts', 'recomendaciones.json'), 'utf8'));
const entradaDe = (b, h) => recomendacionesDe(b).por_huella[h];
const archivoDe = (b, h) => path.join(b.ops, 'inbox', 'instincts', 'propuestas', `${h}.json`);
const bytesDe = (b, hs) => hs.map((h) => fs.readFileSync(archivoDe(b, h)));
const redaccion = (trigger = 'cuando pasa algo', action = 'hacer lo que corresponde', scope = 'global') => ({ trigger, action, domain: 'testing', scope, confidence: 0.9, reasoning: 'se repite', tycon_artifact_suggestion: null });
const hashDe = (r) => sha10(`${r.trigger}::${r.action}`);
/** Una propuesta `pendiente` de antes; devuelve su huella. */
function vieja(b, patron, { repo = 'acme/api', tool = 'Bash', ...extra } = {}) {
  const huella = huellaDe(repo, tool, patron);
  escribirPropuesta(b, { huella, estado: 'pendiente', herramienta: tool, repo, patron, veces: 6, maquinas: 2, desde: diaMenos(9), hasta: diaMenos(9),
    propuesta_el: diaMenos(9), redaccion: null, sin_redaccion: 'tope', modelo: null, decision: null, ...extra });
  return huella;
}
/** Candidatos de la lista `[repo, resumen, herramienta?]`, cada uno 3 veces en dos máquinas. */
function candidatos(lista, dia = diaMenos(1)) {
  const lineas = lista.flatMap(([repo, resumen, tool = 'Bash']) => veces(3, dia, repo, resumen, { tool }));
  return { 'mac-a-11111111': { [dia]: lineas }, 'mac-b-22222222': { [dia]: lineas } };
}
const pedidosDe = (prompts) => prompts.flatMap((p) => [...p.matchAll(/^project\|tool\|summary-prefix: [^|]*\|[^|]*\|(.*)$/gm)].map((x) => x[1]));
const proyectosConReglas = (b, nombres) => {
  const f = path.join(b.ops, 'inbox', 'instincts', 'proyectos-con-reglas.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ proyectos: nombres }));
};

test('T1 4.14-Filter_EmptySummary_IsCountWithoutLesson @story-4.14 @ac-1 @ac-7 — una herramienta sin contenido no llega al modelo ni a un archivo', async () => {
  const b = base('414-t1');
  const d = diaMenos(1);
  const sinContenido = ['CronDelete', 'TaskStop', 'mcp__externo__hacer'].flatMap((tool) => veces(12, d, 'acme/api', '', { tool }));
  espejo(b.espejo, { 'mac-a-11111111': { [d]: [...sinContenido, ...veces(12, d, 'acme/api', 'npm run lint')] } });
  const m = modelo();
  await noche(b, { m });
  assert.deepStrictEqual(pedidosDe(m.propuestas), ['npm run lint']);
  assert.deepStrictEqual(propuestasDe(b).map((p) => p.patron), ['npm run lint']);
  assert.strictEqual(informeDe(b).filtradas.conteo_sin_leccion, 3);
  assert.strictEqual(informeDe(b).en_espera, 0, 'lo filtrado no queda en espera');
});

test('T2 4.14-Filter_WorktreeTempAndHarnessState @story-4.14 @ac-2 @ac-7 — carpetas de trabajo, temporales y estado del arnés, sin falsos positivos', async () => {
  const ruido = ['cat acme--wt-uno/specs/x.md', 'ls .claude/worktrees/dos/', 'cd /private/tmp/x', 'rm /var/folders/a/T/x', 'type AppData\\Local\\Temp\\x',
    'cat $HOME/.tycon/state/advisor-context/x', 'ls .advisors/x'];
  for (const summary of ruido) assert.strictEqual(N.motivoDeRuido({ repo: 'acme/api', summary }), 'carpeta_de_trabajo', summary);
  assert.strictEqual(N.motivoDeRuido({ repo: 'acme--wt-tres', summary: 'npm test' }), 'carpeta_de_trabajo', 'el repo también cuenta');
  const pasan = ['cat $HOME/acme/tmp/x.md', 'node build/var/folders.js'];
  for (const summary of pasan) assert.strictEqual(N.motivoDeRuido({ repo: 'acme/api', summary }), null, summary);
  // el punto de .claude sigue siendo un punto: otra letra en su lugar no es la carpeta de Claude
  assert.strictEqual(N.motivoDeRuido({ repo: 'acme/api', summary: 'ls acme/.claude/worktrees/dos/' }), 'carpeta_de_trabajo');
  assert.strictEqual(N.motivoDeRuido({ repo: 'acme/api', summary: 'ls acme/xclaude/worktrees/dos/' }), null);
  const b = base('414-t2');
  // 25 de ruido no ocupan el tope de 20: lo que sirve se redacta igual
  const muchos = Array.from({ length: 25 }, (_, i) => ['acme/api', `cd /private/tmp/caso-${i}`]);
  espejo(b.espejo, candidatos([...muchos, ['acme--wt-tres', 'npm test'], ...pasan.map((s) => ['acme/api', s])]));
  const m = modelo();
  await noche(b, { m });
  assert.deepStrictEqual(pedidosDe(m.propuestas).sort(), pasan.map((s) => s.toLowerCase()).sort());
  assert.strictEqual(informeDe(b).filtradas.carpeta_de_trabajo, 26);
  assert.strictEqual(informeDe(b).en_espera, 0);
});

test('T3 4.14-Filter_MachinePathsOutsideHome @story-4.14 @ac-3 — rutas de una unidad o de la casa de otra persona', () => {
  // las casas ajenas van por partes: escritas enteras tienen la forma de una ruta de una máquina real
  const otraMac = ['', 'Users', 'otra', 'x'].join('/');
  const otroLinux = ['', 'home', 'otra', 'x'].join('/');
  for (const summary of ['cd /c/Proyectos/acme', 'type C:\\Proyectos\\acme\\x.cs', 'd:/work/x', `cat ${otraMac}`, otroLinux]) {
    assert.strictEqual(N.motivoDeRuido({ repo: 'acme/api', summary }), 'ruta_de_una_maquina', summary);
  }
  for (const summary of ['cat $HOME/repos/acme/x.md', 'ls ~/repos/acme', 'ls $HOME/src/c/y', 'cat /etc/hosts']) {
    assert.strictEqual(N.motivoDeRuido({ repo: 'acme/api', summary }), null, summary);
  }
  // lo que sólo se parece a una ruta de una máquina es un patrón del equipo: una ruta de API, una dirección de awk o sed
  for (const summary of ['curl -s -X GET /users/42/orders', 'grep -rn "/users/:id/" src', "awk '/a/ {print}' f", "sed -i '/x/d' f", 'ls /a/b', 'curl x://acme']) {
    assert.strictEqual(N.motivoDeRuido({ repo: 'acme/api', summary }), null, summary);
  }
  assert.strictEqual(N.motivoDeRuido({ repo: 'acme/api', summary: `${'x'.repeat(60)} cd /c/y` }), null, 'sólo cuentan los 60 caracteres de la clave');
});

test('T4 4.14-SingleProject_DiscardedUnlessOptedIn @story-4.14 @ac-4 — una regla de un solo proyecto, salvo que ese proyecto la pida', async () => {
  const preparar = (nombre) => {
    const b = base(nombre);
    espejo(b.espejo, candidatos([['acme', 'npm run nueva'], ['src/beta', 'npm run beta'], ['acme', 'npm run vieja']]));
    return { b, h: { nueva: huellaDe('acme', 'Bash', 'npm run nueva'), beta: huellaDe('src/beta', 'Bash', 'npm run beta'), vieja: vieja(b, 'npm run vieja', { repo: 'acme' }) } };
  };
  const deProyecto = () => modelo({ responder: (n) => Array.from({ length: n }, (_, i) => ({ i: i + 1, scope: 'project' })) });
  const estado = (b, h) => JSON.parse(fs.readFileSync(archivoDe(b, h), 'utf8'));
  const { b, h } = preparar('414-t4');
  proyectosConReglas(b, [' Beta ']);
  const m = deProyecto();
  await noche(b, { m });
  assert.match(m.propuestas[0], /Beta/, 'el pedido nombra el proyecto que pidió sus reglas');
  assert.strictEqual(estado(b, h.nueva).estado, 'descartada');
  assert.strictEqual(estado(b, h.nueva).motivo_corto, 'un_solo_proyecto');
  assert.strictEqual(estado(b, h.beta).estado, 'pendiente', 'el repo se compara por su último segmento y sin mayúsculas');
  assert.strictEqual(estado(b, h.vieja).estado, 'pendiente', 'lo que ya estaba pendiente no se descarta solo');
  assert.strictEqual(entradaDe(b, h.vieja).recomendacion.regla, 'un_solo_proyecto');
  assert.strictEqual(informeDe(b).filtradas.un_solo_proyecto, 1);
  // sin el archivo, nadie pidió sus reglas
  const sinLista = preparar('414-t4-sin');
  await noche(sinLista.b, { m: deProyecto() });
  assert.strictEqual(estado(sinLista.b, sinLista.h.nueva).estado, 'descartada');
  assert.strictEqual(estado(sinLista.b, sinLista.h.beta).estado, 'descartada');
  // un archivo que no se lee no es «nadie pidió nada»: esa noche la regla no se aplica
  const rota = preparar('414-t4-rota');
  fs.mkdirSync(path.join(rota.b.ops, 'inbox', 'instincts'), { recursive: true });
  fs.writeFileSync(path.join(rota.b.ops, 'inbox', 'instincts', 'proyectos-con-reglas.json'), '{ esto no es json');
  await noche(rota.b, { m: deProyecto() });
  assert.strictEqual(estado(rota.b, rota.h.nueva).estado, 'pendiente');
  assert.strictEqual(informeDe(rota.b).filtradas.un_solo_proyecto, null);
  // el repo entra a la lista: vuelve lo que descartó la noche por esa regla, y sólo eso
  const porConfianza = vieja(b, 'npm run floja', { repo: 'acme', estado: 'descartada', motivo_corto: 'confianza', sin_redaccion: null });
  const antes = fs.readFileSync(archivoDe(b, porConfianza));
  proyectosConReglas(b, ['Beta', 'ACME--wt-uno']);
  await noche(b, { m: modelo(), today: '2026-11-01' });
  assert.strictEqual(estado(b, h.nueva).estado, 'pendiente');
  assert.strictEqual(estado(b, h.nueva).motivo_corto, undefined);
  assert.deepStrictEqual(fs.readFileSync(archivoDe(b, porConfianza)), antes);
  assert.strictEqual(entradaDe(b, h.vieja).recomendacion.por, 'modelo', 'la vieja deja de recomendarse por la regla');
  assert.strictEqual(entradaDe(b, h.nueva).recomendacion.por, 'modelo');
});

test('T5 4.14-OldPending_GetRuleRecommendation_NotDiscarded @story-4.14 @ac-5 @ac-10 — lo pendiente recibe la recomendación de su regla sin que se toque su archivo', async () => {
  const b = base('414-t5');
  espejo(b.espejo, candidatos([['acme/api', 'npm run lint']]));
  const conModelo = redaccion('cuando otra cosa', 'hacer otra cosa');
  const pendientes = {
    conteo_sin_leccion: vieja(b, '', { tool: 'CronDelete' }),
    carpeta_de_trabajo: vieja(b, 'cd /private/tmp/x'),
    ruta_de_una_maquina: vieja(b, 'cd /c/Proyectos/acme'),
    un_solo_proyecto: vieja(b, 'npm run uno', { redaccion: redaccion('cuando uno', 'hacer uno', 'project'), sin_redaccion: null }),
  };
  const fueraDeVentana = vieja(b, 'ls .advisors/viejo');
  const yaRecomendada = vieja(b, 'cd /tmp/y', { redaccion: conModelo, sin_redaccion: null });
  const aprobada = vieja(b, 'cd /tmp/aprobada', { estado: 'aprobada', redaccion: redaccion('cuando apruebo', 'aprobar'), sin_redaccion: null, decision: { texto: 'aprobar' } });
  const f = path.join(b.ops, '.dashboard', 'instincts', 'recomendaciones.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ fecha: diaMenos(1), por_huella: { [yaRecomendada]: { recomendacion: { accion: 'aprobar', por: 'modelo', modelo: 'm', porque: 'Sirve', el: diaMenos(1), de: hashDe(conModelo) }, sin_recomendacion: null } } }));
  const todas = [...Object.values(pendientes), fueraDeVentana, yaRecomendada, aprobada];
  const antes = bytesDe(b, todas);
  for (const today of [HOY, '2026-11-01']) {
    const m = modelo();
    await noche(b, { m, today });
    for (const [regla, h] of Object.entries(pendientes)) {
      assert.strictEqual(entradaDe(b, h).recomendacion.por, 'regla', regla);
      assert.strictEqual(entradaDe(b, h).recomendacion.regla, regla);
      assert.strictEqual(entradaDe(b, h).recomendacion.accion, 'rechazar');
      assert.ok(entradaDe(b, h).recomendacion.porque.length > 10, `${regla}: dice por qué`);
    }
    assert.strictEqual(entradaDe(b, fueraDeVentana).recomendacion.regla, 'carpeta_de_trabajo', 'también la que ya no es candidata');
    assert.strictEqual(entradaDe(b, yaRecomendada).recomendacion.por, 'regla', 'la regla manda sobre la del modelo');
    assert.strictEqual(entradaDe(b, aprobada), undefined, 'lo decidido no tiene entrada');
    assert.ok(!m.recomendaciones.some((p) => /private\/tmp|npm run uno|cd \/tmp/.test(p)), 'por ellas no se llama al modelo');
    assert.deepStrictEqual(bytesDe(b, todas), antes, 'ningún archivo de propuesta cambia');
  }
});

test('T6 4.14-NewOnlyIfDrafted_OldPendingFirst @story-4.14 @ac-6 — primero lo pendiente, y lo nuevo nace redactado', async () => {
  const pat = (i) => `comando repetido número ${String(i).padStart(3, '0')}`;
  const b = base('414-t6');
  espejo(b.espejo, patrones(35));
  // las viejas son las últimas de la lista de candidatos: sólo pasan adelante si la noche las pone primero
  const viejas = [30, 31, 32, 33, 34].map((i) => vieja(b, pat(i)));
  const m = modelo();
  await noche(b, { m });
  const pedidos = pedidosDe(m.propuestas);
  assert.strictEqual(pedidos.length, 20);
  assert.deepStrictEqual(pedidos.slice(0, 5), [30, 31, 32, 33, 34].map(pat));
  const ps = propuestasDe(b);
  assert.strictEqual(ps.length, 20, '5 viejas y 15 nuevas');
  assert.ok(ps.every((p) => p.redaccion), 'ninguna sin redacción');
  assert.ok(viejas.every((h) => ps.find((p) => p.huella === h).redaccion));
  const inf = informeDe(b);
  assert.strictEqual(inf.nuevas, 15);
  assert.strictEqual(inf.en_espera, 15);
  assert.strictEqual(inf.en_espera_por.tope, 15);
  assert.strictEqual(inf.sin_redaccion.tope, 0);
  // con la tanda caída y sin llave, ningún archivo nuevo
  const caida = base('414-t6-caida');
  espejo(caida.espejo, patrones(3));
  await noche(caida, { m: modelo({ caido: true }) });
  assert.strictEqual(propuestasDe(caida).length, 0);
  assert.strictEqual(informeDe(caida).en_espera_por.fallo, 3);
  const sinLlave = base('414-t6-llave');
  espejo(sinLlave.espejo, patrones(3));
  await noche(sinLlave, { resolver: () => ({ ok: false, status: 'no-secret', provider: 'ollama', model: null }) });
  assert.strictEqual(propuestasDe(sinLlave).length, 0);
  assert.strictEqual(informeDe(sinLlave).en_espera_por.sin_llave, 3);
  // una pendiente que el modelo no redacta o descarta al completarla sigue pendiente (D1)
  const d1 = base('414-t6-d1');
  espejo(d1.espejo, patrones(2));
  const floja = vieja(d1, pat(0));
  const sinPropuesta = vieja(d1, pat(1));
  await noche(d1, { m: modelo({ responder: () => [{ i: 1, conf: 0.6 }] }) });
  const de = (h) => JSON.parse(fs.readFileSync(archivoDe(d1, h), 'utf8'));
  assert.strictEqual(de(floja).estado, 'pendiente');
  assert.strictEqual(de(floja).rechazo_sugerido.motivo, 'confianza');
  assert.ok(de(floja).redaccion, 'con la redacción que hubo');
  assert.strictEqual(de(sinPropuesta).estado, 'pendiente');
  assert.strictEqual(de(sinPropuesta).rechazo_sugerido.motivo, 'sin_propuesta');
  assert.strictEqual(entradaDe(d1, floja).recomendacion.regla, 'confianza');
  assert.strictEqual(entradaDe(d1, sinPropuesta).recomendacion.regla, 'sin_propuesta');
  assert.strictEqual(informeDe(d1).descartadas, 0);
  const m2 = modelo();
  await noche(d1, { m: m2, today: '2026-11-01' });
  assert.strictEqual(m2.propuestas.length, 0, 'no se vuelven a mandar a completar');
});

test('T7 4.14-Recommend_ModelApproveReject_Saved @story-4.14 @ac-8 — el modelo recomienda, y lo vigente no se vuelve a pedir', async () => {
  const b = base('414-t7');
  espejo(b.espejo, candidatos([['acme/api', 'npm run uno']]));
  const r1 = redaccion('cuando uno', 'hacer uno');
  const r2 = redaccion('cuando dos', 'hacer dos');
  const uno = vieja(b, 'npm run uno', { redaccion: r1, sin_redaccion: null, maquinas: 3 });
  const dos = vieja(b, 'npm run dos', { redaccion: r2, sin_redaccion: null });
  const antes = bytesDe(b, [uno, dos]);
  const m = modelo({ recomendar: (i) => (i === 1 ? { recommend: 'approve', why: 'Le sirve a todo el equipo' } : { recommend: 'reject', why: 'Ya lo cubre otra regla' }) });
  await noche(b, { m });
  assert.strictEqual(m.recomendaciones.length, 1);
  assert.deepStrictEqual(entradaDe(b, uno), { recomendacion: { accion: 'aprobar', por: 'modelo', modelo: 'gemma4:31b-cloud', porque: 'Le sirve a todo el equipo', el: HOY, de: hashDe(r1) }, sin_recomendacion: null });
  assert.deepStrictEqual(entradaDe(b, dos), { recomendacion: { accion: 'rechazar', por: 'modelo', modelo: 'gemma4:31b-cloud', porque: 'Ya lo cubre otra regla', el: HOY, de: hashDe(r2) }, sin_recomendacion: null });
  assert.deepStrictEqual(bytesDe(b, [uno, dos]), antes, 'recomendar no toca las propuestas');
  const m2 = modelo();
  await noche(b, { m: m2, today: '2026-11-01' });
  assert.strictEqual(m2.recomendaciones.length, 0, 'lo vigente no se vuelve a pedir');
  assert.strictEqual(entradaDe(b, uno).recomendacion.el, HOY, 'y se conserva como estaba');
  // con otra redacción, la recomendación era de otra cosa
  vieja(b, 'npm run dos', { redaccion: redaccion('cuando dos', 'hacer otra cosa'), sin_redaccion: null });
  const m3 = modelo();
  await noche(b, { m: m3, today: '2026-11-02' });
  assert.strictEqual(m3.recomendaciones.length, 1);
  assert.match(m3.recomendaciones[0], /hacer otra cosa/);
  assert.doesNotMatch(m3.recomendaciones[0], /hacer uno/);
});

test('T8 4.14-Recommend_UnsafeOrBadAnswer_NoRecommendation @story-4.14 @ac-9 — lo que no se puede mostrar no se guarda', async () => {
  const b = base('414-t8');
  espejo(b.espejo, patrones(1));
  const hs = [1, 2, 3, 4, 5].map((i) => vieja(b, `npm run caso${i}`, { redaccion: redaccion(`cuando ${i}`, `hacer ${i}`), sin_redaccion: null, maquinas: 9 - i }));
  const malas = { 1: { why: 'Mirar /etc/hosts antes' }, 2: { why: 'Ver https://acme.example/a' }, 3: { why: 'El pedido 1234567 lo cubre' }, 4: { recommend: 'archivar', why: 'Sirve' }, 5: { recommend: 'constructor', why: 'Sirve' } };
  const m = modelo({ recomendar: (i) => malas[i] || {} });
  await noche(b, { m });
  for (const h of hs) assert.deepStrictEqual(entradaDe(b, h), { recomendacion: null, sin_recomendacion: 'respuesta_ilegible' }, h);
  const m2 = modelo({ recomendacionCruda: 'no sé qué contestar' });
  await noche(b, { m: m2, today: '2026-11-01' });
  assert.ok(m2.recomendaciones.join('\n').includes('hacer 1'), 'se vuelve a pedir otra noche');
  for (const h of hs) assert.strictEqual(entradaDe(b, h).sin_recomendacion, 'respuesta_ilegible');
  assert.strictEqual(informeDe(b, '2026-11-01').modelo.fallos.respuesta_ilegible >= 1, true);
  // un motivo guardado que no es ninguna regla no se recomienda, aunque se llame como algo que todo objeto trae
  const b2 = base('414-t8-motivo');
  espejo(b2.espejo, patrones(1));
  const rara = vieja(b2, 'npm run rara', { rechazo_sugerido: { motivo: 'constructor', cita: null } });
  await noche(b2, { m: modelo() });
  assert.deepStrictEqual(entradaDe(b2, rara), { recomendacion: null, sin_recomendacion: 'sin_redaccion' });
});

test('T9 4.14-Recommend_NoModelNoKeyDownCap @story-4.14 @ac-9 — sin modelo, sin llave, caído o fuera del tope, se dice por qué y no se inventa nada', async () => {
  const preparar = (nombre, n) => {
    const b = base(nombre);
    espejo(b.espejo, candidatos([['acme/api', 'npm run lint']]));
    const hs = Array.from({ length: n }, (_, i) => vieja(b, `npm run caso${String(i).padStart(2, '0')}`, { redaccion: redaccion(`cuando ${i}`, `hacer ${i}`), sin_redaccion: null, veces: 100 - i }));
    return { b, hs };
  };
  const casos = [['sin_modelo', { resolver: () => ({ ok: false, status: 'not-configured' }) }], ['sin_llave', { resolver: () => ({ ok: false, status: 'no-secret', provider: 'ollama', model: null }) }], ['fallo', { m: modelo({ caido: true }) }]];
  for (const [motivo, o] of casos) {
    const { b, hs } = preparar(`414-t9-${motivo}`, 2);
    await noche(b, o);
    for (const h of hs) assert.deepStrictEqual(entradaDe(b, h), { recomendacion: null, sin_recomendacion: motivo }, motivo);
    assert.strictEqual(informeDe(b).sin_recomendacion[motivo], 2);
  }
  // el tope: 30 por noche, en tandas de 15
  const { b, hs } = preparar('414-t9-tope', 35);
  const sinRedaccion = vieja(b, 'npm run sin redactar');
  const m = modelo();
  await noche(b, { m });
  assert.strictEqual(m.recomendaciones.length, 2, '30 en tandas de 15');
  assert.strictEqual(hs.filter((h) => entradaDe(b, h).sin_recomendacion === 'tope').length, 5);
  assert.strictEqual(informeDe(b).recomendadas.modelo, 30);
  assert.strictEqual(informeDe(b).sin_recomendacion.tope, 6);
  assert.strictEqual(entradaDe(b, sinRedaccion).sin_recomendacion, 'sin_redaccion');
  // lo vigente sobrevive a una noche sin modelo
  const vigente = hs[0];
  const antes = entradaDe(b, vigente);
  await noche(b, { resolver: () => ({ ok: false, status: 'not-configured' }), today: '2026-11-01' });
  assert.deepStrictEqual(entradaDe(b, vigente), antes);
  assert.strictEqual(entradaDe(b, hs[34]).sin_recomendacion, 'sin_modelo');
});

test('T10 4.14-Report_HasFilteredAndRecommended @story-4.14 @ac-6 @ac-7 @ac-11 — el informe cuenta lo filtrado, lo recomendado y lo que espera', async () => {
  const b = base('414-t10');
  espejo(b.espejo, candidatos([['acme/api', ''], ['acme/api', 'cd /private/tmp/a'], ['acme/api', 'cd /c/acme'], ['acme/api', 'npm run lint'], ['acme/api', 'npm run deploy']]));
  vieja(b, 'npm run sin redactar');
  vieja(b, 'cd /tmp/vieja');
  await noche(b, { m: modelo({ responder: () => [{ i: 1, scope: 'project' }, { i: 2 }] }) });
  const inf = informeDe(b);
  assert.deepStrictEqual(inf.filtradas, { conteo_sin_leccion: 1, carpeta_de_trabajo: 1, ruta_de_una_maquina: 1, un_solo_proyecto: 1 });
  assert.deepStrictEqual(inf.recomendadas, { regla: 1, modelo: 1 });
  assert.deepStrictEqual(inf.sin_recomendacion, { fallo: 0, sin_modelo: 0, sin_llave: 0, tope: 0, sin_redaccion: 1, respuesta_ilegible: 0 });
  assert.deepStrictEqual(inf.en_espera_por, { tope: 0, fallo: 0, sin_modelo: 0, sin_llave: 0 });
  // lo que no se midió es null, y el archivo de la noche anterior no se toca
  const antes = fs.readFileSync(path.join(b.ops, '.dashboard', 'instincts', 'recomendaciones.json'));
  await noche(b, { bajar: async () => ({ codigo: 0, res: { estado: 'sin_az' } }), today: '2026-11-01' });
  const sinMedir = informeDe(b, '2026-11-01');
  for (const k of ['filtradas', 'recomendadas', 'sin_recomendacion', 'en_espera_por']) assert.strictEqual(sinMedir[k], null, k);
  assert.deepStrictEqual(fs.readFileSync(path.join(b.ops, '.dashboard', 'instincts', 'recomendaciones.json')), antes);
});

test('T11 4.14-Recommend_TextIsSanitized @story-4.14 @ac-10 — el porqué del modelo pasa por el saneado antes de escribirse', async () => {
  // una casa sin barras: pasa el filtro de frases, que rechaza toda ruta, y sólo la saca el saneado
  const CASA = 'casa-lab-9';
  const b = base('414-t11');
  espejo(b.espejo, patrones(1));
  const h = vieja(b, 'npm run uno', { redaccion: redaccion(), sin_redaccion: null, maquinas: 9 });
  await noche(b, { home: CASA, m: modelo({ recomendar: () => ({ why: `Revisar ${CASA} antes de aprobar` }) }) });
  assert.strictEqual(entradaDe(b, h).recomendacion.porque, 'Revisar $HOME antes de aprobar');
  assert.ok(!fs.readFileSync(path.join(b.ops, '.dashboard', 'instincts', 'recomendaciones.json'), 'utf8').includes(CASA));
});

test('T40 4.14-Filter_PathsGluedToShellSigns — una temporal o la ruta de una máquina pegada a un signo del shell también es ruido', () => {
  const otraMac = ['', 'Users', 'otra', 'x'].join('/');
  const temporales = ['echo x >/tmp/out', 'tee >/private/tmp/y', 'cat (/tmp/z)', 'a;/var/folders/b/T/x', 'a|/tmp/x', 'echo `ls /tmp`', 'cd /tmp', 'ls /private/tmp',
    'cat ${TMPDIR}/x', 'rm -rf "${TMPDIR}"', 'cat $TMPDIR/x'];
  for (const summary of temporales) assert.strictEqual(N.motivoDeRuido({ repo: 'acme/api', summary }), 'carpeta_de_trabajo', summary);
  for (const summary of [`cat >${otraMac}`, `a;${otraMac}`, 'a|C:\\Proyectos\\x', 'x>(d:/work/y)']) {
    assert.strictEqual(N.motivoDeRuido({ repo: 'acme/api', summary }), 'ruta_de_una_maquina', summary);
  }
  // lo que sólo se parece sigue pasando
  // la carpeta temporal de una sesión de Claude Code
  for (const summary of ['ls $HOME/.claude/jobs/ab12cd34/tmp/x', 'cat $CLAUDE_JOB_DIR/tmp/y']) {
    assert.strictEqual(N.motivoDeRuido({ repo: 'acme/api', summary }), 'carpeta_de_trabajo', summary);
  }
  // una expresión regular o una etiqueta no son una ruta
  for (const summary of ['node -e "s.match(/x/g)"', "awk '(/a/){print}' f", "grep -E 'foo|/v/12' src", 'grep -n "</tmp>" config.xml']) {
    assert.strictEqual(N.motivoDeRuido({ repo: 'acme/api', summary }), null, summary);
  }
  for (const summary of ['node build/tmpfile.js', 'ls acme/tmp/x', 'echo $TMPDIRS', 'cat ./tmp/y', 'npm run tmp']) {
    assert.strictEqual(N.motivoDeRuido({ repo: 'acme/api', summary }), null, summary);
  }
});
