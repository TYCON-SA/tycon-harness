'use strict';
/**
 * portable-report.js — lo que el escenario `portable` del pipeline de Windows hace con lo que midió: leer la salida de
 * una suite, resumir un reporte del banco de controles, y armar el «En corto» y el resumen legible.
 *
 * POR QUÉ EXISTE. La «base portable» trae la regla de finales de línea, la función que busca el
 * bash de Git y el banco de controles andando en Windows. Se escribió y se probó en una Mac: lo que pasa en un Windows
 * de verdad lo dice una corrida. `portable-probe.js` corre los comandos en el agente; acá vive todo lo que NO toca el
 * disco ni lanza un proceso, para poder probarlo con datos de juguete (`scripts/tests/windows-portable.test.js`):
 *   · `parseTap`       cuántas pruebas pasaron y cuántas fallaron en la salida de `node <suite>.test.js`;
 *   · `benchSummary`   de un reporte del banco (`runner.js --json`): un veredicto por caso —verde, rojo, no medido o
 *                      salteado con constancia—, los rojos por su nombre, y los casos de la lista que no aparecen;
 *   · `shapesSummary`  los portones que deciden por ruta, por cada forma en que llega la ruta;
 *   · `shortRows`      el «En corto»: una fila por pregunta, lo esperado contra lo medido;
 *   · `renderMarkdown` el resumen que lee una persona.
 *
 * LO ESPERADO sale de `para-medir-en-windows.md` (el informe de lo que hay que medir). Lo que depende de la máquina se calcula
 * de lo medido («todos con \r» sólo si el clon tiene `core.autocrlf=true`); los números del informe que son de ese
 * commit (cuántas pruebas trae cada suite, cuántos casos tiene el banco) van como referencia, no como condición.
 *
 * Una fila dice «sí», «NO» o «—»: «—» es «no hay nada que comparar» (no medido, o un dato que sólo informa). Un «NO»
 * no pone roja la corrida: es un hecho, y además un hallazgo del paso.
 */

const STATUS_TEXT = { measured: 'medido', 'not-measured': 'no medido', error: 'ERROR' };
// Las formas en que llega una ruta a un portón: las tres de Windows, y la de siempre (que en Windows se saltea).
const SHAPES = Object.freeze([
  { id: 'backslash', suffix: 'forma-barras-invertidas', looks: 'C:\\a\\b' },
  { id: 'slash', suffix: 'forma-barras', looks: 'C:/a/b' },
  { id: 'git-bash', suffix: 'forma-git-bash', looks: '/c/a/b' },
  { id: 'native', suffix: 'forma-nativa', looks: '/a/b (sólo Linux y Mac)' },
]);
const WINDOWS_SHAPES = SHAPES.filter((s) => s.id !== 'native');
// Lo que el informe midió en una Mac: sólo referencia.
const REFERENCE = Object.freeze({
  tests: { 'line-endings': 6, 'git-bash': 7, 'windows-support': 4, 'bench-portable': 7, 'test-scope-table': 2 },
  // las del registro de hooks, el piso de Node, los frenos y el cierre, medidas en la Mac (la de bash cuenta sus ✅)
  tests_893: { 'apply-hooks': 28, 'harness-node': 87, 'story-gate': 33, 'ledger-visible': 9, 'safety-escape': 58, 'run-close': 5, 'pipeline-unit': 332 },
  bench: 'el informe de W1 esperaba 919 casos en la lista y 721 con veredicto en Windows',
});
// Lo que el informe pide y un agente no puede dar, con su motivo. Va entero al reporte.
const NOT_MEASURED = Object.freeze([
  { what: 'el disparo real (`live-fire.js`): con qué shell lanza el asistente cada hook', why: 'abre una sesión del asistente, y el agente no tiene credencial' },
  { what: 'el examen de los revisores (`advisor-runner.js`)', why: 'abre sesiones del asistente; además lanza `/bin/bash` fijo y corre en la máquina designada' },
  { what: '`git reset --hard` con un archivo abierto por otra sesión o por el antivirus', why: 'en el agente no hay otra sesión ni antivirus de escritorio: es de una máquina real (tanda W8)' },
  { what: 'el paso que normaliza, con el clon usado a través del enlace de `~\\.claude\\`', why: 'el escenario clona sin instalar: no hay enlace. Lo cubre el escenario `update` cuando el actualizador corra el paso' },
]);

const cell = (s) => String(s === null || s === undefined || s === '' ? '—' : s).replace(/\|/g, '\\|').replace(/[\n\t]/g, ' ');
const short = (sha) => (sha ? String(sha).slice(0, 10) : '—');
const yes = (v) => (v === true ? 'sí' : (v === false ? 'NO' : '—'));
const stepOf = (report, name) => ((report && report.steps) || []).find((s) => s && s.name === name) || null;
const factsOf = (report, name) => (stepOf(report, name) || {}).facts || {};
const isWslLauncher = (p) => /[\\/](system32|sysnative|windowsapps)[\\/]bash(\.exe)?$/i.test(String(p || ''));

// ── leer la salida de una suite ──────────────────────────────────────────────────────────────────────────────────

/**
 * Los totales de una corrida de `node --test` o de `node <suite>.test.js`: `{ tests, pass, fail, skipped, first_failure }`.
 * Lee las dos formas en que Node los escribe (`# pass 6` cuando la salida no es una consola, `ℹ pass 6` cuando lo es).
 * Lo que no encuentra queda en `null`: una salida sin totales no son «cero fallas».
 */
function parseTap(text) {
  const s = String(text || '');
  const num = (name) => { const m = new RegExp(`^\\s*(?:#|ℹ) ${name} (\\d+)\\s*$`, 'm').exec(s); return m ? Number(m[1]) : null; };
  const failed = /^\s*not ok \d+ - (.+)$/m.exec(s) || /^\s*✖ (.+?)(?: \(\d[\d.]*ms\))?$/m.exec(s);
  return { tests: num('tests'), pass: num('pass'), fail: num('fail'), skipped: num('skipped'), first_failure: failed ? failed[1].trim() : null };
}

/**
 * Los totales de una suite de bash del arnés, con la forma de `parseTap`: un renglón que empieza con ✅ es una
 * verificación que pasó y uno con ❌, una que falló.
 */
function parseShellSuite(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim());
  const pass = lines.filter((l) => l.startsWith('✅')).length;
  const failed = lines.filter((l) => l.startsWith('❌'));
  return { tests: pass + failed.length, pass, fail: failed.length, skipped: null, first_failure: failed.length ? failed[0].replace(/^❌\s*/, '') : null };
}

/** ¿Esa suite pasó? Salió 0 y no dice ninguna falla. Sin totales legibles no es un «sí». */
function testPassed(t) {
  return Boolean(t) && !t.error && t.exit === 0 && t.fail === 0 && typeof t.pass === 'number' && t.pass > 0;
}

// ── el banco de controles ────────────────────────────────────────────────────────────────────────────────────────

/** Las claves de los casos que imprime `runner.js --list` (`<guion>::<id> [tipo] tools=… — …`). */
function parseBenchList(text) {
  const keys = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^(\S+::\S+) \[[\w-]+\] tools=/.exec(line.trim());
    if (m) keys.push(m[1]);
  }
  return keys;
}

/** Por qué se salteó un caso, en una palabra estable. */
function skipReason(entry) {
  if (entry.so) return 'other-system';
  if (entry.motivo) return 'production-brake-installed';
  return 'other-tool';
}

/**
 * El resumen de un reporte del banco (`runner.js --json`). Función pura.
 * `{ readable, problem, totals, reported, verdicts, red, not_measured, skipped_by, red_by_script, missing }`
 * `verdicts` es el veredicto por caso: `green` · `red` · `not-measured` · `skipped`. `missing` son los casos de la
 * lista (`--list`) que el reporte no trae: un caso que desaparece no es un verde.
 */
function benchSummary(doc, { tool = 'claude', listed = null } = {}) {
  const out = {
    readable: false, problem: null, totals: { cases: 0, ran: 0, green: 0, red: 0, not_measured: 0, skipped: 0 }, reported: null,
    verdicts: {}, red: [], not_measured: [], skipped_by: {}, red_by_script: [], missing: [],
  };
  if (!doc || typeof doc !== 'object' || !doc.results || typeof doc.results !== 'object') { out.problem = 'el reporte del banco no trae «results»'; return out; }
  out.readable = true;
  out.reported = { ran: doc.ran, failed: doc.failed, skipped: doc.skipped, not_measured: doc.nomedido };
  const byScript = {};
  for (const [key, r] of Object.entries(doc.results)) {
    const e = r && r.tools ? r.tools[tool] : null;
    out.totals.cases++;
    if (!e) { out.verdicts[key] = 'not-measured'; out.totals.not_measured++; out.not_measured.push({ key, why: `el reporte no trae un resultado para ${tool}` }); continue; }
    if (e.skipped) {
      out.verdicts[key] = 'skipped'; out.totals.skipped++;
      const why = skipReason(e);
      out.skipped_by[why] = (out.skipped_by[why] || 0) + 1;
      continue;
    }
    out.totals.ran++;
    const failures = Array.isArray(e.failures) ? e.failures.map(String) : [];
    if (e.nomedido) { out.verdicts[key] = 'not-measured'; out.totals.not_measured++; out.not_measured.push({ key, why: failures[0] || 'sin motivo' }); continue; }
    if (e.pass === true) { out.verdicts[key] = 'green'; out.totals.green++; continue; }
    out.verdicts[key] = 'red'; out.totals.red++;
    const script = key.split('::')[0];
    byScript[script] = (byScript[script] || 0) + 1;
    out.red.push({ key, script, type: r.type || null, failures });
  }
  out.red_by_script = Object.entries(byScript).map(([script, count]) => ({ script, count })).sort((a, b) => b.count - a.count || a.script.localeCompare(b.script));
  if (Array.isArray(listed)) out.missing = listed.filter((k) => !(k in doc.results));
  return out;
}

/** La forma de ruta que prueba un caso, por el final de su nombre. `null` si no es un caso de formas. */
function shapeOf(key) {
  const id = String(key).split('::').pop();
  // por el FINAL del nombre: `forma-barras` es también el principio de `forma-barras-invertidas`
  const found = SHAPES.find((s) => id.endsWith(s.suffix));
  return found ? found.id : null;
}

/**
 * Los portones por ruta, forma por forma, de un reporte del banco corrido con `--only forma-`. Función pura.
 * `{ readable, problem, shapes: { <forma>: { cases, green, red, not_measured, skipped, red_cases } }, other }`
 */
function shapesSummary(doc, opts) {
  const sum = benchSummary(doc, opts);
  const blank = () => ({ cases: 0, green: 0, red: 0, not_measured: 0, skipped: 0, red_cases: [] });
  const out = { readable: sum.readable, problem: sum.problem, shapes: Object.fromEntries(SHAPES.map((s) => [s.id, blank()])), other: blank() };
  const field = { green: 'green', red: 'red', 'not-measured': 'not_measured', skipped: 'skipped' };
  for (const [key, v] of Object.entries(sum.verdicts)) {
    const slot = out.shapes[shapeOf(key)] || out.other;
    slot.cases++;
    slot[field[v]]++;
    if (v === 'red') slot.red_cases.push({ key, failures: (sum.red.find((r) => r.key === key) || {}).failures || [] });
  }
  return out;
}

// ── el «En corto» ────────────────────────────────────────────────────────────────────────────────────────────────

const scriptsText = (s) => (s && typeof s.total === 'number' ? `${s.with_cr} de ${s.total}` : 'no se pudo contar');
const testText = (t) => {
  if (!t) return 'no corrió';
  if (t.not_run) return `no corrió: ${t.not_run}`;
  if (t.error) return `no arrancó (${t.error})`;
  const totals = typeof t.pass === 'number' ? ` · ${t.pass} pasan · ${t.fail} fallan${t.skipped ? ` · ${t.skipped} salteadas` : ''}` : ' · sin totales legibles';
  return `salió ${t.exit}${totals}${t.first_failure ? ` — la primera que falla: ${t.first_failure}` : ''}`;
};
const testMatch = (t) => (!t || t.not_run ? null : testPassed(t));
const testExpected = (name) => `sale 0, sin fallas${REFERENCE.tests[name] ? ` (el informe de W1: ${REFERENCE.tests[name]} pruebas)` : REFERENCE.tests_893[name] ? ` (en la Mac: ${REFERENCE.tests_893[name]})` : ''}`;
// las suites del paso 6, en el orden en que corren: las tres de W1 y las del registro de hooks, el piso de Node, los
// frenos y el cierre
const SUITES = Object.freeze(['bench-portable', 'windows-support', 'test-scope-table', 'apply-hooks', 'harness-node', 'story-gate', 'ledger-visible', 'safety-escape', 'run-close', 'pipeline-unit', 'work-items-az']);
const REPO_TEXT = { harness: 'arnés', skills: 'agent-skills' };
const OF_REPO = { harness: 'del arnés', skills: 'de agent-skills' };

/**
 * El «En corto»: una fila por pregunta, lo esperado contra lo medido. Función pura.
 * Cada fila: `{ question, what, expected, measured, match }` con `match` en `true`, `false` o `null` (nada que comparar).
 */
function shortRows(report) {
  const rows = [];
  const row = (question, what, expected, measured, match) => rows.push({ question, what, expected, measured, match: match === undefined ? null : match });
  const gone = (question, what, name) => {
    const s = stepOf(report, name);
    row(question, what, '—', s ? `${STATUS_TEXT[s.status] || s.status}${s.reason ? `: ${s.reason}` : ''}` : `no corrió el paso ${name}`, null);
  };

  // 1 · el clon nuevo
  const fresh = factsOf(report, 'fresh-clone');
  if (fresh.repos) {
    for (const [name, r] of Object.entries(fresh.repos)) {
      // un «0 de 0» no es un verde: un conteo equivocado de un solo archivo diría «0 de 1»
      const ok = Boolean(r.scripts) && typeof r.scripts.total === 'number' && r.scripts.total > 0;
      row('1', `Clon nuevo ${OF_REPO[name] || `de ${name}`}: guiones de bash (.sh y hooks de git) con \\r`, ok ? `0 de ${r.scripts.total}` : '0', `${scriptsText(r.scripts)} · core.autocrlf: ${r.autocrlf || 'sin fijar'} · .gitattributes: ${r.gitattributes ? 'sí' : 'no'}`, ok ? r.scripts.with_cr === 0 : null);
    }
    const t = fresh.tests && fresh.tests['line-endings'];
    row('1', '`eol.test.js` en el clon nuevo', testExpected('line-endings'), testText(t), testMatch(t));
  } else gone('1', 'Clon nuevo: guiones de bash con \\r', 'fresh-clone');

  // 2 · el clon que ya existía
  const old = factsOf(report, 'existing-clone');
  if (old.repos) {
    for (const [name, r] of Object.entries(old.repos)) {
      const st = r.stages || {};
      const n = (id) => (st[id] && st[id].scripts && typeof st[id].scripts.total === 'number' ? st[id].scripts : null);
      const crlf = r.autocrlf === 'true';
      const who = REPO_TEXT[name] || name;
      const base = n('at-base');
      // si el «antes» ya trae el .gitattributes (una rama que sale del main actual), con eol=lf no llega ningún \r
      const attrs = Boolean(r.gitattributes_at_base);
      row('2', `Clon que ya existía ${OF_REPO[name] || `de ${name}`}, antes de traer la rama`, attrs ? 'ninguno con \\r: el antes ya trae .gitattributes' : (crlf ? 'todos con \\r (es lo que la tanda viene a arreglar)' : 'sin core.autocrlf=true en el clon, ninguno llega con \\r'), `${scriptsText(base)} · core.autocrlf: ${r.autocrlf || 'sin fijar'} · .gitattributes en el antes: ${attrs ? 'sí' : 'no'}`, !base ? null : (attrs ? base.with_cr === 0 : (crlf ? base.with_cr === base.total && base.total > 0 : null)));
      const pulled = n('after-pull');
      const clean = (id) => (st[id] && typeof st[id].status_lines === 'number' ? st[id].status_lines === 0 : null);
      row('2', `${who}: después del \`git pull\``, '`git status` limpio; lo que el pull no toca conserva su \\r', `${scriptsText(pulled)} con \\r · pull salió ${cell(r.pull ? (r.pull.error || r.pull.exit) : null)} · git status: ${clean('after-pull') === null ? 'no se pudo leer' : (clean('after-pull') ? 'limpio' : `${st['after-pull'].status_lines} línea(s)`)}`, r.pull ? (r.pull.exit === 0 && clean('after-pull') === true) : null);
      const plain = n('after-plain-restore');
      row('2', `${who}: después de \`git checkout -- .\` y \`git reset --hard\``, 'los mismos con \\r: no lo arreglan', scriptsText(plain), plain && pulled ? plain.with_cr === pulled.with_cr : null);
      const fixed = n('after-normalize');
      row('2', `${who}: después del paso que normaliza`, fixed ? `0 de ${fixed.total}, y \`git status\` limpio` : '0, y `git status` limpio', `${scriptsText(fixed)} · git status: ${clean('after-normalize') === null ? 'no se pudo leer' : (clean('after-normalize') ? 'limpio' : `${st['after-normalize'].status_lines} línea(s)`)}${r.normalize && r.normalize.some((c) => c.error || c.exit !== 0) ? ` · el paso salió ${r.normalize.map((c) => c.error || c.exit).join(' y ')}` : ''}`, fixed ? (fixed.with_cr === 0 && clean('after-normalize') === true) : null);
    }
    const before = old.tests && old.tests['before-normalize'];
    const dirty = Object.values(old.repos).some((r) => r.stages && r.stages['after-pull'] && r.stages['after-pull'].scripts && r.stages['after-pull'].scripts.with_cr > 0);
    row('2', '`eol.test.js` después del pull, antes de normalizar', dirty ? 'ROJO, nombrando los archivos con \\r\\n y el paso' : 'sale 0: no quedó ningún \\r', `${testText(before)}${dirty && before && before.says ? ` · nombra el paso: ${before.says.names_the_step ? 'sí' : 'NO'}` : ''}`, !before || before.not_run ? null : (dirty ? (before.exit !== 0 && !before.error && Boolean(before.says && before.says.names_the_step)) : testPassed(before)));
    const after = old.tests && old.tests['after-normalize'];
    row('2', '`eol.test.js` después del paso que normaliza', testExpected('line-endings'), testText(after), testMatch(after));
  } else gone('2', 'El clon que ya existía', 'existing-clone');

  // 3 · el bash de Git
  const gb = factsOf(report, 'git-bash');
  if (gb.found) {
    const f = gb.found;
    const windows = f.platform === 'win32';
    row('3', '`findGitBash()` en esta máquina', windows ? 'el bash de Git for Windows; nunca el de System32 ni el de WindowsApps' : 'el primer bash del PATH (fuera de Windows)', f.path ? `${f.path} (de: ${f.source}) · ${gb.version || 'versión no leída'}` : `no lo encontró: ${f.reason || `salió ${f.exit}`}`, Boolean(f.path) && !isWslLauncher(f.path));
    for (const v of gb.variants || []) row('3', v.what, v.expected, v.not_measured ? `no medido: ${v.not_measured}` : `${v.path || 'null'} (de: ${v.source || '—'})`, v.not_measured ? null : v.ok);
    const t = gb.tests && gb.tests['git-bash'];
    row('3', '`git-bash.test.js`', testExpected('git-bash'), testText(t), testMatch(t));
  } else gone('3', '`findGitBash()` y `git-bash.test.js`', 'git-bash');

  // 4 · el banco entero
  const bench = factsOf(report, 'bench');
  if (bench.summary) {
    const s = bench.summary;
    const t = s.totals;
    row('4', 'El banco de controles entero (`runner.js --tool claude`)', `todo caso de la lista termina con un veredicto o un salteo declarado, y ninguno queda sin medir. No se espera todo verde (${REFERENCE.bench})`,
      s.readable ? `${bench.listed === null || bench.listed === undefined ? '?' : bench.listed} en la lista · ${t.ran} corridos · ${t.green} verdes · ${t.red} rojos · ${t.not_measured} no medidos · ${t.skipped} salteados con constancia · faltan ${s.missing.length} · salió ${cell(bench.exit)}` : `no se pudo leer el reporte del banco: ${s.problem}`,
      // sin la lista leída no se sabe qué falta: «faltan 0» no se cree
      s.readable ? (s.missing.length === 0 && t.not_measured === 0 && t.ran > 0 && typeof bench.listed === 'number' && bench.listed > 0) : false);
    if (bench.user_folder) row('4', 'El banco no escribe en la carpeta de usuario de quien lo corre', 'ningún archivo nuevo', bench.user_folder.problem ? `no se pudo mirar: ${bench.user_folder.problem}` : `${bench.user_folder.appeared.length} archivo(s) nuevo(s)${bench.user_folder.appeared.length ? `: ${bench.user_folder.appeared.slice(0, 3).join(', ')}` : ''}`, bench.user_folder.problem ? null : bench.user_folder.appeared.length === 0);
    const wg = bench.without_git;
    if (wg) row('4', 'El banco sin Git for Windows', '«NO MEDIDO: falta Git for Windows», sale 2 y ningún ✅', wg.not_measured ? `no medido: ${wg.not_measured}` : `salió ${cell(wg.error || wg.exit)} · ${wg.says_not_measured ? 'dice NO MEDIDO' : 'no dice NO MEDIDO'} · ${wg.greens} ✅`, wg.not_measured ? null : (wg.exit === 2 && wg.says_not_measured && wg.greens === 0));
  } else gone('4', 'El banco de controles entero', 'bench');

  // 5 · los portones por ruta
  const ps = factsOf(report, 'path-shapes');
  if (ps.shapes) {
    for (const shape of WINDOWS_SHAPES) {
      const x = (ps.shapes.shapes || {})[shape.id];
      if (!ps.shapes.readable || !x) { row('5', `Portones por ruta, forma \`${shape.looks}\``, 'todos verdes', `no se pudo leer: ${ps.shapes.problem || 'sin datos'}`, false); continue; }
      const ran = x.green + x.red + x.not_measured;
      row('5', `Portones por ruta, forma \`${shape.looks}\``, x.cases ? `los ${x.cases} verdes` : 'todos verdes', ran ? `${x.green} verdes · ${x.red} rojos${x.not_measured ? ` · ${x.not_measured} no medidos` : ''}${x.skipped ? ` · ${x.skipped} salteados` : ''}` : (x.cases ? `no medido: los ${x.skipped} casos se saltearon (corren sólo en Windows)` : 'no medido: el banco no trae casos de esta forma'), ran ? (x.red === 0 && x.not_measured === 0) : null);
    }
    const h = ps.no_home;
    if (h) row('5', 'El aviso de ruta inexistente sin la variable HOME', '1 corrido, 0 rojos', h.readable ? `${h.ran} corridos · ${h.red} rojos · ${h.not_measured} no medidos` : `no se pudo leer: ${h.problem}`, h.readable ? (h.ran >= 1 && h.red === 0 && h.not_measured === 0) : false);
  } else gone('5', 'Los portones que deciden por ruta', 'path-shapes');

  // 6 · las suites (las que el commit no trae, o que un reporte anterior no corrió, no tienen fila)
  const su = factsOf(report, 'suites');
  if (su.tests) {
    for (const name of SUITES) {
      const t = su.tests[name];
      if (!t && name !== 'bench-portable' && name !== 'windows-support') continue;
      row('6', `\`${t && t.file && !t.not_run ? String(t.file).split('/').pop() : `${name}.test.js`}\``, testExpected(name), testText(t), testMatch(t));
    }
  } else gone('6', 'las suites de Windows (las de W1 y las del AC 21 de la story 8.93)', 'suites');
  return rows;
}

// ── el resumen legible ───────────────────────────────────────────────────────────────────────────────────────────

function commandsTable(M, commands) {
  if (!commands || !commands.length) return;
  M.push('| Comando | Salió | Duró (s) | Tope (s) | Salida guardada |', '|---|---|---|---|---|');
  for (const c of commands) M.push(`| ${cell(c.what)}<br>\`${cell(c.line)}\` | ${cell(c.timed_out ? `venció el tope (${c.error})` : (c.error || c.exit))} | ${cell(c.seconds)} | ${cell(c.cap_s)} | ${cell(c.saved)} |`);
  M.push('');
}
function findingsList(M, step) {
  const list = (step && step.findings) || [];
  if (!list.length) return;
  M.push(`**Lo que no salió como se esperaba (${list.length})**`, '');
  for (const f of list.slice(0, 40)) M.push(`- \`${f.id}\` — ${f.detail}`);
  if (list.length > 40) M.push(`- … y ${list.length - 40} más: están en \`steps/${step.name}.json\``);
  M.push('');
}
function scriptsRows(M, title, s) {
  M.push(`| ${title} | ${s && typeof s.total === 'number' ? `${s.with_cr} de ${s.total}` : `no se pudo contar: ${cell(s && s.problem)}`} | ${cell(s && s.first && s.first.length ? s.first.slice(0, 5).join(', ') : null)} |`);
}

/** El resumen legible del reporte del escenario `portable`. */
function renderMarkdown(report) {
  const v = report.verdict || {};
  const run = report.run || {};
  const M = [];
  M.push('# El arnés en Windows — la base portable (story 8.17, W1)', '');
  M.push(`Ejecución **${run.id === null || run.id === undefined ? 'sin número' : run.id}**${run.number ? ` (${run.number})` : ''} · escenario \`${run.scenario || '—'}\` · ${run.platform || '—'}${run.lab_mode ? ' — **modo de laboratorio: esto NO es un Windows**' : ''} · Node ${run.node || '—'}`, '');
  if (run.commits) {
    M.push('| Repo | Lo que se mide | Antes (de donde arranca el clon que ya existía) | Commits en el medio |', '|---|---|---|---|');
    // un repo por cada uno que se midió: con un solo repo (las skills adentro) no hay fila de un segundo
    for (const [name, title] of [['harness', 'arnés'], ['skills', 'agent-skills']].filter(([key]) => run.commits[key])) {
      const c = run.commits[name] || {};
      M.push(`| ${title} | \`${short(c.today)}\` (${cell(c.today_ref)}) | \`${short(c.base)}\` (${cell(c.base_from)}) | ${cell(c.since_base)} |`);
    }
    M.push('');
  }
  M.push(`## Veredicto: ${v.color === 'green' ? 'VERDE' : 'ROJO'} — ${v.color === 'green' ? 'se pudo medir' : 'NO se pudo medir'}`, '');
  M.push('El color dice si la medición PUDO CORRER, no si Windows anda bien: lo que encontró está abajo, esperado contra medido.', '');
  const bullets = (title, items) => { if (items && items.length) { M.push(`**${title} (${items.length})**`, ''); for (const i of items) M.push(`- ${i}`); M.push(''); } };
  bullets('No pude medir', v.errors);
  bullets('Pasos que faltan', v.missing_steps);
  bullets('Pasos no medidos', v.not_measured);

  const rows = shortRows(report);
  M.push('## En corto', '', '| # | Pregunta | Esperado | Medido | ¿Coincide? |', '|---|---|---|---|---|');
  for (const r of rows) M.push(`| ${r.question} | ${cell(r.what)} | ${cell(r.expected)} | ${cell(r.measured)} | ${yes(r.match)} |`);
  M.push('', `Coinciden ${rows.filter((r) => r.match === true).length} · no coinciden **${rows.filter((r) => r.match === false).length}** · sin nada que comparar ${rows.filter((r) => r.match === null).length}.`, '');

  M.push('## Los pasos', '', '| Paso | Estado | Hallazgos | Duró (s) | Tope (s) | Motivo |', '|---|---|---|---|---|---|');
  for (const s of report.steps || []) M.push(`| ${s.name} | ${STATUS_TEXT[s.status] || s.status} | ${(s.findings || []).length} | ${cell(s.wall_seconds)} | ${cell(s.cap_s)} | ${cell(s.reason)} |`);
  M.push('', 'La salida entera de cada comando está en `steps/<paso>/`, y todo lo medido en `steps/<paso>.json`.', '');

  // 1 · el clon nuevo
  const fresh = stepOf(report, 'fresh-clone');
  if (fresh) {
    M.push('## 1 · El clon nuevo: finales de línea', '');
    const f = fresh.facts || {};
    if (f.repos) {
      M.push('| Clon | Guiones de bash con \\r | Los primeros | core.autocrlf (de dónde sale) | .gitattributes |', '|---|---|---|---|---|');
      for (const [name, r] of Object.entries(f.repos)) M.push(`| ${name} \`${short(r.head)}\` | ${scriptsText(r.scripts)} | ${cell(r.scripts && r.scripts.first && r.scripts.first.slice(0, 4).join(', '))} | ${cell((r.autocrlf_origin || []).join(' · ') || 'sin fijar')} | ${r.gitattributes ? 'sí' : 'no'} |`);
      M.push('', 'Los demás archivos de texto (ninguno con \\r\\n, ni en el índice ni en el árbol) y los binarios sin declarar los mira `eol.test.js`, que corre sobre este mismo clon.', '');
    }
    if (f.bash_reads) M.push(`\`bash -n\` sobre \`${f.bash_reads.file}\`, con el bash que encontró el arnés: ${f.bash_reads.not_measured ? `no medido (${f.bash_reads.not_measured})` : `salió ${cell(f.bash_reads.error || f.bash_reads.exit)}`}. No alcanza como detector: da 0 sobre un guion con \\r\\n que al correr falla; la medición es el conteo.`, '');
    commandsTable(M, f.commands);
    findingsList(M, fresh);
  }
  // 2 · el clon que ya existía
  const old = stepOf(report, 'existing-clone');
  if (old) {
    M.push('## 2 · El clon que ya existía', '');
    const f = old.facts || {};
    for (const [name, r] of Object.entries(f.repos || {})) {
      const st = r.stages || {};
      M.push(`**${name}** — de \`${short(r.base)}\` a \`${short(r.target)}\` · core.autocrlf: ${cell((r.autocrlf_origin || []).join(' · ') || 'sin fijar')} · .gitattributes antes: ${r.gitattributes_at_base ? 'sí' : 'no'}, después: ${r.gitattributes_after_pull ? 'sí' : 'no'}`, '');
      M.push('| Momento | Guiones de bash con \\r | Los primeros |', '|---|---|---|');
      for (const [id, title] of [['at-base', 'antes de traer la rama'], ['after-pull', 'después del `git pull`'], ['after-plain-restore', 'después de `git checkout -- .` y `git reset --hard`'], ['after-normalize', 'después del paso que normaliza']]) if (st[id]) scriptsRows(M, title, st[id].scripts);
      M.push('');
      for (const id of ['after-pull', 'after-normalize']) if (st[id] && st[id].status_lines) M.push(`\`git status\` ${id === 'after-pull' ? 'después del pull' : 'después de normalizar'}: ${st[id].status_lines} línea(s) — ${cell((st[id].status_first || []).join(' · '))}`, '');
    }
    if (f.normalize_step) M.push(`El paso que normaliza: \`${f.normalize_step}\` (con el árbol limpio; descarta los cambios locales sin commitear de archivos versionados).`, '');
    const before = f.tests && f.tests['before-normalize'];
    if (before && before.tail) M.push('Lo que dijo `eol.test.js` antes de normalizar (principio y final):', '', '```text', before.tail, '```', '');
    commandsTable(M, f.commands);
    findingsList(M, old);
  }
  // 3 · el bash de Git
  const gb = stepOf(report, 'git-bash');
  if (gb) {
    M.push('## 3 · El bash de Git', '');
    const f = gb.facts || {};
    if (f.found) M.push(`\`findGitBash()\`: ${f.found.path ? `\`${f.found.path}\` (de: ${f.found.source})` : `no lo encontró — ${cell(f.found.reason)}`} · ${cell(f.version)}`, '');
    if (f.variants && f.variants.length) {
      M.push('| Caso | Esperado | Devolvió | De | ¿Coincide? |', '|---|---|---|---|---|');
      for (const x of f.variants) M.push(x.not_measured ? `| ${cell(x.what)} | ${cell(x.expected)} | no medido: ${cell(x.not_measured)} | — | — |` : `| ${cell(x.what)} | ${cell(x.expected)} | ${cell(x.path || 'null')} | ${cell(x.source)} | ${yes(x.ok)} |`);
      M.push('');
    }
    commandsTable(M, f.commands);
    findingsList(M, gb);
  }
  // 6 va antes que 4: si `bench-portable` falla, el banco no es de fiar
  const su = stepOf(report, 'suites');
  if (su) {
    M.push('## 6 · Las suites `bench-portable`, `windows-support` y `test-scope-table`', '');
    const f = su.facts || {};
    const bp = f.tests && f.tests['bench-portable'];
    if (bp && !testPassed(bp)) M.push('🔴 `bench-portable.test.js` no pasó: lo que diga el banco entero (punto 4) NO es de fiar hasta arreglar eso.', '');
    for (const [name, t] of Object.entries(f.tests || {})) if (!testPassed(t) && t.tail) M.push(`Lo que dijo \`${name}.test.js\` (principio y final):`, '', '```text', t.tail, '```', '');
    commandsTable(M, f.commands);
    findingsList(M, su);
  }
  // 4 · el banco
  const bench = stepOf(report, 'bench');
  if (bench) {
    M.push('## 4 · El banco de controles entero', '');
    const f = bench.facts || {};
    const s = f.summary;
    if (s && s.readable) {
      const t = s.totals;
      M.push('| En la lista | Con veredicto | Verdes | Rojos | No medidos | Salteados con constancia | Faltan |', '|---|---|---|---|---|---|---|');
      M.push(`| ${cell(f.listed)} | ${t.ran} | ${t.green} | ${t.red} | ${t.not_measured} | ${t.skipped} | ${s.missing.length} |`, '');
      const why = { 'other-system': 'declarados para otro sistema', 'other-tool': 'no son de esta herramienta', 'production-brake-installed': 'el freno de producción está instalado' };
      if (Object.keys(s.skipped_by).length) M.push(`Salteados: ${Object.entries(s.skipped_by).map(([k, n]) => `${n} ${why[k] || k}`).join(' · ')}.`, '');
      if (s.missing.length) M.push(`**Casos de la lista que el reporte no trae (${s.missing.length})**: ${s.missing.slice(0, 30).map((k) => `\`${k}\``).join(', ')}${s.missing.length > 30 ? ' …' : ''}`, '');
      if (s.not_measured.length) { M.push(`**No medidos (${s.not_measured.length})** — ni verdes ni rojos:`, ''); for (const n of s.not_measured.slice(0, 30)) M.push(`- \`${n.key}\` — ${n.why}`); M.push(''); }
      if (s.red.length) {
        M.push(`**Rojos por guion (${s.red.length} casos)**`, '', '| Guion | Rojos |', '|---|---|');
        for (const r of s.red_by_script) M.push(`| ${cell(r.script)} | ${r.count} |`);
        M.push('', '**Los rojos, por su nombre** (cada uno va a `known-gaps.json` con la tanda que lo cierra):', '');
        for (const r of s.red.slice(0, 80)) M.push(`- \`${r.key}\` — ${cell(String(r.failures[0] || 'sin motivo').slice(0, 300))}`);
        if (s.red.length > 80) M.push(`- … y ${s.red.length - 80} más: todos en \`steps/bench/verdicts.json\``);
        M.push('');
      }
      M.push('El veredicto de cada caso: `steps/bench/verdicts.json`. El reporte del banco tal cual: `steps/bench/bench.json`. Su salida: `steps/bench/`.', '');
    } else if (s) M.push(`No se pudo leer el reporte del banco: ${s.problem}`, '');
    if (f.user_folder && !f.user_folder.problem && f.user_folder.appeared.length) M.push(`**Archivos que aparecieron en la carpeta de usuario de quien corre el banco (${f.user_folder.appeared.length})**: ${f.user_folder.appeared.slice(0, 20).map((x) => `\`${x}\``).join(', ')}`, '');
    commandsTable(M, f.commands);
    findingsList(M, { name: 'bench', findings: (bench.findings || []).filter((x) => !/^bench:red:/.test(x.id)) });
  }
  // 5 · los portones por ruta
  const ps = stepOf(report, 'path-shapes');
  if (ps) {
    M.push('## 5 · Los portones que deciden por ruta', '');
    const f = ps.facts || {};
    if (f.shapes && f.shapes.readable) {
      M.push('| Forma | Casos | Verdes | Rojos | No medidos | Salteados |', '|---|---|---|---|---|---|');
      for (const shape of SHAPES) { const x = f.shapes.shapes[shape.id]; M.push(`| \`${shape.looks}\` | ${x.cases} | ${x.green} | ${x.red} | ${x.not_measured} | ${x.skipped} |`); }
      const o = f.shapes.other;
      if (o.cases) M.push(`| otros casos cuyo nombre trae «forma-» | ${o.cases} | ${o.green} | ${o.red} | ${o.not_measured} | ${o.skipped} |`);
      M.push('');
      const reds = [...SHAPES.flatMap((shape) => f.shapes.shapes[shape.id].red_cases), ...o.red_cases];
      if (reds.length) { M.push('**Los rojos** — cada uno nombra un portón que no entiende esa forma de ruta:', ''); for (const r of reds) M.push(`- \`${r.key}\` — ${cell(String(r.failures[0] || 'sin motivo').slice(0, 300))}`); M.push(''); }
    } else if (f.shapes) M.push(`No se pudo leer el reporte: ${f.shapes.problem}`, '');
    commandsTable(M, f.commands);
    findingsList(M, { name: 'path-shapes', findings: (ps.findings || []).filter((x) => !/^path-shapes:red:/.test(x.id)) });
  }

  const inv = stepOf(report, 'inventory');
  if (inv && inv.facts && inv.facts.tools) {
    M.push('## Qué trae la máquina', '', '| Herramienta | Dónde | Versión |', '|---|---|---|');
    for (const name of ['git', 'node', 'pwsh', 'powershell', 'bash', 'python3', 'python', 'jq']) {
      const t = inv.facts.tools[name];
      if (t) M.push(`| ${name} | ${t.state === 'present' ? cell((t.locations || []).join(' → ')) : (t.state === 'absent' ? 'no está' : `no pude preguntar: ${cell(t.reason)}`)} | ${cell(t.version)} |`);
    }
    M.push('');
  }
  const skipped = [...NOT_MEASURED];
  for (const s of report.steps || []) for (const n of (s.facts && s.facts.not_measured) || []) skipped.push({ what: n.what, why: n.why });
  M.push('## No medido', '', '| Qué | Por qué no |', '|---|---|');
  for (const n of skipped) M.push(`| ${cell(n.what)} | ${cell(n.why)} |`);
  M.push('', 'Tampoco lo puede medir un agente: una máquina común (el agente corre como administrador y trae herramientas de más), un perfil dentro de OneDrive, un antivirus, una política de empresa.', '');
  return `${M.join('\n')}\n`;
}

module.exports = { SHAPES, WINDOWS_SHAPES, REFERENCE, NOT_MEASURED, SUITES, parseTap, parseShellSuite, testPassed, parseBenchList, benchSummary, shapeOf, shapesSummary, shortRows, renderMarkdown, isWslLauncher };
