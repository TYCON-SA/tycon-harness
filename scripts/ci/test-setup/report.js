#!/usr/bin/env node
'use strict';
/**
 * El informe del detector de consultas y temporizadores vivos, por formulario. Lee lo que anotaron el detector, la prueba
 * previa de la configuración (`--probe`) y el paso de pruebas en `<results>/<formulario>-live-handles.jsonl`, y lo
 * contrasta con la lista de excepciones del repo. Sólo informa: no puede salvar un rojo que el junit ya escribió.
 *
 * 🔴 NUNCA «0» DE LO QUE NO MIRÓ. Por formulario sale uno de estos:
 *   · miró N pruebas: ninguna con algo vivo, o cuáles y qué dejaron;
 *   · sin el detector — su configuración no se pudo cargar, o el detector falló por dentro: se probó como siempre;
 *   · no mirado — el paso de pruebas lo saltó (sin configuración de jest, sin node_modules);
 *   · no medido — se lo probó y no hay ningún archivo de anotaciones.
 *
 * El modo lo declara quien llama, con su fecha, como typecheck-forms.js:
 *   · warn  — sale 0; exige `--review` (un aviso sin fecha no termina nunca: sale 2). Pasada la fecha, lo dice y el paso
 *             queda en amarillo.
 *   · block — las pruebas con algo vivo ya fallaron en jest; el informe sale 1 si el control no pudo mirar un formulario
 *             (sin el detector, no medido, o no mirado por falta de node_modules): en block el control no se apaga callado.
 *             «No mirado» por no tener configuración de jest es un aviso: a ése lo juzga «Verdict» contra la deuda.
 *
 * Uso:
 *   report.js --results <dir> --forms "<a b c>" --mode warn|block [--review AAAA-MM-DD] [--declared <json>]
 *             [--repo <dir>] [--today AAAA-MM-DD]
 * Sale 0 (sin freno) · 1 (block con un formulario sin mirar) · 2 (uso inválido).
 */
const fs = require('fs');
const path = require('path');
const declared = require('./declared.js');

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    o[k.slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : '';
  }
  return o;
}

const issue = (type, msg) => process.stdout.write(`##vso[task.logissue type=${type}]${msg}\n`);
const say = (msg) => process.stdout.write(`${msg}\n`);
const describe = (h) => (h.kind === 'fetch' ? `fetch ${h.url} ${h.where}`
  : h.kind === 'fake' ? `temporizadores simulados pendientes: ${h.count}` : `${h.kind}(${h.ms} ms) ${h.where}`);

function readRecords(file) {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_) { return { event: 'unreadable', line: l }; }
  });
}

function main(argv) {
  const o = args(argv);
  const mode = o.mode;
  if (mode !== 'warn' && mode !== 'block') {
    say(`report.js: --mode tiene que ser warn o block (llegó «${mode || ''}»)`);
    return 2;
  }
  const forms = String(o.forms || '').trim().split(/\s+/).filter(Boolean);
  const results = o.results || 'test-results';
  const all = new Map(forms.map((f) => [f, readRecords(path.join(results, `${f}-live-handles.jsonl`))]));
  // La fecha con la que jest juzgó las excepciones (la anotó el detector), así el informe no cambia de día a mitad de camino.
  const noted = [...all.values()].flat().find((r) => r && r.event === 'file' && declared.isDate(r.today));
  const day = declared.isDate(o.today) ? o.today : noted ? noted.today : declared.today();
  if (mode === 'warn' && !declared.isDate(o.review)) {
    issue('error', 'consultas vivas: modo aviso sin fecha de revisión (liveHandlesReview AAAA-MM-DD): un aviso sin fecha no es una decisión');
    return 2;
  }
  const repo = o.repo || '.';
  const list = declared.read(o.declared);
  if (list.error) issue('warning', `consultas vivas: ${list.error} — ninguna excepción ampara`);

  let stops = 0;
  const flaggedTotal = [];
  const ran = new Map(); // `${form} ${file}` -> nombres vistos
  const excusedSeen = new Set();
  say(`🔎 Consultas y temporizadores vivos — modo ${mode}${mode === 'warn' ? ` hasta el ${o.review}` : ''}`);
  for (const f of forms) {
    const recs = all.get(f);
    const stop = (msg) => { if (mode === 'block') { issue('error', msg); stops++; } else issue('warning', msg); };
    if (!recs) { stop(`${f}: no medido — se probó y no dejó anotaciones: no es «0 pruebas con algo vivo»`); continue; }
    const notLooked = recs.find((r) => r.event === 'not-looked');
    if (notLooked) {
      if (/configuración de jest/.test(notLooked.reason || '')) issue('warning', `${f}: no mirado — ${notLooked.reason} (lo juzga «Verdict» contra la deuda declarada)`);
      else stop(`${f}: no mirado — ${notLooked.reason}`);
      continue;
    }
    const noDetector = recs.find((r) => r.event === 'no-detector');
    if (noDetector) { stop(`${f}: sin el detector — ${noDetector.reason}; se probó como siempre`); continue; }
    // Una línea que no se puede leer pudo ser una prueba marcada: no es «limpio».
    const unreadable = recs.filter((r) => r.event === 'unreadable').length;
    if (unreadable) { stop(`${f}: ${unreadable} anotación(es) ilegibles — no se puede decir que no quedó nada vivo`); continue; }
    for (const r of recs.filter((x) => x.event === 'no-detector-file')) stop(`${f}: ${r.file} — sin el detector: ${r.reason}`);
    const internal = recs.filter((r) => r.event === 'internal-error');
    const looked = recs.filter((r) => r.event === 'looked');
    for (const l of looked) ran.set(`${f} ${l.file}`, new Set(l.tests || []));
    const count = looked.reduce((n, l) => n + (l.count || 0), 0);
    const flagged = recs.filter((r) => r.event === 'test');
    const outside = recs.filter((r) => r.event === 'outside');
    if (recs.some((r) => r.event === 'no-testing-library')) say(`  ${f}: sin Testing Library — mira igual, sin desmontar`);
    if (internal.length) stop(`${f}: sin el detector: error interno — ${internal[0].message}`);
    if (!looked.length && !internal.length) { stop(`${f}: no medido — el detector arrancó y no terminó ningún archivo`); continue; }
    const live = flagged.filter((r) => !r.excused);
    for (const r of flagged.filter((x) => x.excused)) excusedSeen.add(`${f} ${r.file} ${r.test}`);
    if (!live.length && !outside.length) {
      say(`  ✅ ${f}: miró ${count} prueba(s), ninguna con algo vivo`);
    } else {
      if (live.length) say(`  ${f}: ${live.length} prueba(s) con algo vivo de ${count}`);
      for (const r of live) {
        flaggedTotal.push(`${f} › ${r.file} › ${r.test}`);
        const line = `${f}: ${r.file} › ${r.test} — ${r.handles.map(describe).join(' · ')}`;
        if (mode === 'warn') issue('warning', `habría fallado: ${line}`); else say(`    ❌ ${line}`);
      }
      for (const r of outside) {
        const line = `${f}: ${r.file} — creado fuera de una prueba: ${r.handles.map(describe).join(' · ')}`;
        if (mode === 'warn') issue('warning', line); else say(`    ❌ ${line}`);
      }
    }
  }

  const mine = list.entries.filter((e) => e && forms.includes(e.form));
  if (mine.length) say('\nExcepciones (pending-live-handles.json):');
  for (const e of mine) {
    const key = `${e.form}: ${declared.normalize(e.file)} › ${e.test}`;
    const st = declared.status(e, day);
    if (st.state === 'malformed') { issue('warning', `${key}: no ampara — ${st.why}`); continue; }
    if (st.state === 'expired') { issue('warning', `${key}: vencida — ${st.why}; ya no ampara`); continue; }
    if (excusedSeen.has(`${e.form} ${declared.normalize(e.file)} ${e.test}`)) { say(`  ⚠️ ${key}: vigente, usada (${st.why})`); continue; }
    if (!fs.existsSync(path.join(repo, e.form, declared.normalize(e.file)))) { issue('warning', `${key}: no existe — ese archivo no está en el formulario; no ampara a nadie`); continue; }
    const seen = ran.get(`${e.form} ${declared.normalize(e.file)}`);
    if (seen && !seen.has(e.test)) { issue('warning', `${key}: no se vio en esta ejecución — el archivo corrió sin esa prueba`); continue; }
    say(`  ${key}: vigente (${st.why})${seen ? ', sin nada vivo esta vez' : ', su archivo no corrió en esta ejecución'}`);
  }

  if (mode === 'warn') {
    if (o.review < day) {
      issue('warning', `venció la revisión del modo aviso el ${o.review}: decidir si las consultas vivas pasan a frenar (liveHandlesMode: block), o renovar la fecha con su motivo`);
      say('##vso[task.complete result=SucceededWithIssues;]');
    }
    say(`\nModo aviso hasta el ${o.review}: no frena. ${flaggedTotal.length} prueba(s) habrían fallado.`);
    return 0;
  }
  if (stops) { say(`\n${stops} formulario(s) sin mirar: en modo freno el control no se apaga callado.`); return 1; }
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main };
