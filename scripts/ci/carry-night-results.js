#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/*
 * carry-night-results.js — lleva al disco de un checkout de main los resultados pendientes de la rama `night-results`.
 * Casos: scripts/tests/carry-night-results.test.js.
 *
 * POR QUÉ EXISTE. La máquina del examen no puede empujar a main: publica cada resultado como una entrada de
 * `night-results` (scripts/lib/result-travel.js). Este guion lo corre un nocturno que sí guarda en main, entre
 * `push-nightly-data.js sync` y `push-nightly-data.js save` de las mismas rutas. No empuja nada: escribe en el disco.
 *
 * QUÉ HACE. Trae la rama, y aplica las entradas que `.dashboard/night-results/carried.json` no anota, de la más vieja a
 * la más nueva. Un archivo entero (`replace`) se escribe si su fecha es mayor que la del disco: de dos noches queda el
 * más nuevo, y uno más viejo que el de main no lo pisa. Las secciones de la revisión semanal (`append`) van al final de
 * la lista, salvo las que ya están por su marca. Cada entrada tratada queda anotada en `carried.json`, que viaja en el
 * mismo commit que los resultados: si el guardado falla, nada queda anotado y la noche siguiente reintenta.
 *
 * LO QUE NO TIENE FORMA DE RESULTADO NO ENTRA. Cualquiera con permiso de escritura puede empujar a la rama, y este
 * guion escribe en main. Una entrada con una ruta fuera de las cuatro permitidas, un JSON roto o de otro tipo, una
 * sección sin encabezado y marca, o un archivo de más de 2 MB no se aplica en nada: queda anotada como rechazada, con su
 * motivo, y la corrida lo avisa.
 *
 * `carried.json` se escribe siempre, aunque vacío: el guardado lo exige (`--require`), y «nada nuevo» tiene que poder
 * comprobarlo en main.
 *
 * Uso:    node scripts/ci/carry-night-results.js --repo <checkout> [--remote origin]
 * Salida: 0 hecho, también sin rama o sin nada pendiente · 1 no pude leer la rama o la anotación · 2 uso.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const RT = require(path.join(__dirname, '..', 'lib', 'result-travel.js'));

const MAX_BYTES = 2 * 1024 * 1024;
const TIP_REF = `refs/night-results/tip`;

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', timeout: 120000, maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { ok: r.status === 0, status: r.status, raw: String(r.stdout || ''), out: String(r.stdout || '').trim(), err: String(r.stderr || (r.error && r.error.message) || '').trim() };
}
// lo que dijo git, para mostrarlo sin que la plataforma de la corrida lo lea como una orden suya
const quiet = (t) => RT.clean(t).replace(/##(?=vso|\[)/gi, '## ');
const warn = (t) => console.log(`##vso[task.logissue type=warning]${quiet(t)}`);

function args(argv) {
  const a = { repo: null, remote: 'origin', error: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') a.repo = argv[++i];
    else if (argv[i] === '--remote') a.remote = argv[++i];
    else a.error = `opción desconocida: ${argv[i]}`;
  }
  if (!a.error && !a.repo) a.error = 'falta --repo <checkout>';
  return a;
}

/** La fecha de un archivo entero, según su regla; NaN si no es un resultado de esa ruta. */
function dateOf(rule, text) {
  let d;
  try { d = JSON.parse(text); } catch (_) { return { ok: false, why: 'no es JSON' }; }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, why: 'no es un objeto' };
  if (rule.kind && d.kind !== rule.kind) return { ok: false, why: `su tipo no es ${rule.kind}` };
  if (rule.schema && d.schema !== rule.schema) return { ok: false, why: `su schema no es ${rule.schema}` };
  const t = Date.parse(d[rule.date]);
  return Number.isFinite(t) ? { ok: true, t } : { ok: false, why: `no trae ${rule.date}` };
}

// Un archivo entero con fecha más allá de la corrida ganaría siempre la comparación de fechas y dejaría afuera a los
// resultados reales que lleguen después: se rechaza. El día de margen cubre relojes de máquina corridos.
const FUTURE_MARGIN_MS = 24 * 60 * 60 * 1000;

/** Valida una entrada entera; devuelve lo que se aplicaría, o el motivo para rechazarla. */
function check(id, entryText, readFile, now = Date.now()) {
  let e;
  try { e = JSON.parse(entryText); } catch (_) { return { why: 'entry.json no es JSON' }; }
  if (!e || e.schema !== 1 || e.id !== id || !RT.PIECES[e.piece] || !Array.isArray(e.files)) return { why: 'entry.json no tiene la forma de una entrada' };
  const files = [];
  for (const f of e.files) {
    const rule = f && RT.ALLOWED[f.path];
    if (!rule || rule.piece !== e.piece || rule.mode !== f.mode) return { why: `la ruta ${String(f && f.path).slice(0, 120)} no está permitida para ${e.piece}` };
    const body = readFile(f.path);
    if (body === null) return { why: `falta el archivo de ${f.path}` };
    if (Buffer.byteLength(body) > MAX_BYTES) return { why: `${f.path} pesa más de 2 MB` };
    if (f.mode === 'replace') {
      const d = dateOf(rule, body);
      if (!d.ok) return { why: `${f.path}: ${d.why}` };
      if (d.t > now + FUTURE_MARGIN_MS) return { why: `${f.path}: su fecha es posterior a esta ejecución (fecha futura)` };
      files.push({ ...f, body, t: d.t, rule });
    } else {
      const sections = RT.sectionsOf(body);
      const prose = body.replace(/\s+/g, '');
      if (!sections.length || sections.some((s) => !s.marker || s.date !== RT.MARKER.exec(s.marker)[1])) return { why: `${f.path}: una sección no trae su encabezado y su marca` };
      // nada fuera de las secciones: lo que precede al primer encabezado no es una propuesta
      if (prose !== sections.map((s) => s.text).join('').replace(/\s+/g, '')) return { why: `${f.path}: trae texto fuera de las secciones` };
      files.push({ ...f, sections });
    }
  }
  return { files };
}

function main() {
  const a = args(process.argv.slice(2));
  if (a.error) { console.error(`carry-night-results: ${a.error}`); return 2; }
  const repo = path.resolve(a.repo);
  const carriedFile = path.join(repo, ...RT.CARRIED.split('/'));
  let carried = { schema: 1, entries: {} };
  if (fs.existsSync(carriedFile)) {
    try {
      const d = JSON.parse(fs.readFileSync(carriedFile, 'utf8'));
      if (!d || d.schema !== 1 || !d.entries || typeof d.entries !== 'object' || Array.isArray(d.entries)) throw new Error('no tiene la forma esperada');
      carried = d;
    } catch (e) {
      // 🔴 no se reescribe una anotación que no se pudo leer: se perdería lo ya llevado y todo entraría dos veces
      console.error(`carry-night-results: no pude leer ${RT.CARRIED}: ${e.message}`);
      return 1;
    }
  }
  const save = () => {
    fs.mkdirSync(path.dirname(carriedFile), { recursive: true });
    const sorted = Object.fromEntries(Object.keys(carried.entries).sort().map((k) => [k, carried.entries[k]]));
    fs.writeFileSync(carriedFile, `${JSON.stringify({ schema: 1, entries: sorted }, null, 2)}\n`);
  };

  const ls = git(repo, ['ls-remote', '--exit-code', a.remote, `refs/heads/${RT.BRANCH}`]);
  if (!ls.ok && ls.status === 2) { save(); console.log(`no hay rama ${RT.BRANCH}: nada que llevar`); return 0; }
  if (!ls.ok) { console.error(`carry-night-results: no pude mirar ${RT.BRANCH}: ${quiet(ls.err)}`); return 1; }
  const f = git(repo, ['fetch', '--quiet', a.remote, `+refs/heads/${RT.BRANCH}:${TIP_REF}`]);
  if (!f.ok) { console.error(`carry-night-results: no pude traer ${RT.BRANCH}: ${quiet(f.err)}`); return 1; }
  // una rama sin `runs/` (alguien empujó otra cosa) es «nada que llevar», igual que una rama que no existe, pero se
  // advierte: una rama vaciada o reescrita a la fuerza no es lo mismo que «no hay rama», y el aviso de arranque tarda 36 h
  const top = git(repo, ['ls-tree', '--name-only', TIP_REF]);
  if (!top.ok) { console.error(`carry-night-results: no pude listar la rama: ${quiet(top.err)}`); return 1; }
  if (!top.out.split('\n').includes('runs')) {
    save();
    warn(`la rama ${RT.BRANCH} existe sin runs/: nada que llevar, pero alguien la vació o la reescribió`);
    console.log(`${RT.BRANCH} no trae entradas: nada que llevar`);
    return 0;
  }
  const list = git(repo, ['ls-tree', '--name-only', `${TIP_REF}:runs`]);
  if (!list.ok) { console.error(`carry-night-results: no pude listar las entradas: ${quiet(list.err)}`); return 1; }

  const now = new Date().toISOString();
  let applied = 0;
  let rejected = 0;
  for (const id of list.out.split('\n').filter(Boolean).sort()) {
    if (carried.entries[id]) continue;
    const show = (rel) => { const r = git(repo, ['show', `${TIP_REF}:runs/${id}/${rel}`]); return r.ok ? r.raw : null; };
    const entryText = show('entry.json');
    const c = entryText === null ? { why: 'no tiene entry.json' } : check(id, entryText, (p) => show(`files/${p}`));
    if (c.why) {
      carried.entries[id] = { status: 'rejected', reason: c.why, at: now };
      rejected++;
      warn(`resultados de la noche: rechacé la entrada ${id}: ${c.why}`);
      continue;
    }
    const done = [];
    const skipped = [];
    for (const x of c.files) {
      const file = path.join(repo, ...x.path.split('/'));
      if (x.mode === 'replace') {
        let current = null;
        try { current = fs.readFileSync(file, 'utf8'); } catch (_) { /* no está: entra */ }
        const mine = current === null ? { ok: false } : dateOf(x.rule, current);
        if (mine.ok && mine.t >= x.t) { skipped.push(x.path); continue; }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, x.body);
        done.push(x.path);
      } else {
        let current = '';
        try { current = fs.readFileSync(file, 'utf8'); } catch (_) { /* sin lista: se arma con lo que llega */ }
        const fresh = x.sections.filter((s) => !current.includes(s.marker));
        if (!fresh.length) { skipped.push(x.path); continue; }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${current.replace(/\s*$/, '\n')}\n${fresh.map((s) => s.text).join('\n')}`);
        done.push(x.path);
      }
    }
    carried.entries[id] = { status: 'carried', at: now, applied: done, ...(skipped.length ? { superseded: skipped } : {}) };
    applied++;
  }
  save();
  console.log(`resultados de la noche: ${applied} entrada(s) llevada(s), ${rejected} rechazada(s)`);
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { check, dateOf };
