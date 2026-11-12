#!/usr/bin/env node
/**
 * unclosed-runs-notice.js — «N corridas del pipeline quedaron sin cerrar», dicho una vez por día al arrancar.
 *
 * Hook SessionStart. Una corrida cuyo marcador desapareció sin su cierre no deja volcado: antes no subía al buzón y nadie
 * se enteraba. `upload-runs.js` ahora la sube marcada «sin cerrar» (`unclosed-runs.js`); este aviso se lo dice a la
 * persona, con de qué stories son y qué hacer, para que una story que sigue se retome.
 *
 * Una vez por día: el sello (`unclosed-runs-notice.json` en la carpeta de estado) guarda el día. Sin corridas sin cerrar,
 * calla y no sella. Sólo lee: no escribe volcados (eso lo hace la subida).
 *
 * Además vive acá `debtNotice`, el aviso de la deuda de evidencia en vivo vencida, con su propio sello por día local
 * (`evidence-debt-notice.json`): una corrida que llegó al commit con criterios sin evidencia en vivo (el renglón
 * `acmatrix-debt` de `gates.log`, que anota `marker.js` al preparar el commit) y cuya fecha pasó. Mira sólo esos
 * criterios en la matriz de la historia: si alguno sigue sin evidencia, una línea; si la historia no está o la matriz no
 * se calcula, lo dice («no pude mirar»). La deuda pagada se cierra con `acmatrix-debt-paid`. No corre desde este gancho,
 * que se instala sólo con el buzón: lo llama `finished-open-notice.js`, que se instala siempre.
 *
 * Fail-open total: nunca frena el arranque ni tira; una falla de las corridas calla y sale 0, una de la deuda se dice.
 * Apagado: TYCON_UNCLOSED_NOTICE=0. El reloj: TYCON_UNCLOSED_NOW (para las pruebas).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SEAL = 'unclosed-runs-notice.json';
const DEBT_SEAL = 'evidence-debt-notice.json';

function stateDirOf(home) {
  return require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js')).stateDir(home);
}

function line(runs, script) {
  const stories = [...new Set(runs.map((r) => r.key))];
  const shown = stories.slice(0, 5).join(', ') + (stories.length > 5 ? ` y ${stories.length - 5} más` : '');
  return `⚠️ ${runs.length} ejecución(es) del pipeline quedaron sin cerrar (${shown}): se suben al buzón marcadas «sin cerrar» `
    + `con la próxima subida. Si una story sigue, retomala con el pipeline; para ver cuáles y dónde: node "${script}"`;
}

/** La fecha local `AAAA-MM-DD` de un momento: el vencimiento vale el día entero, como en `marker.js`. */
function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Lo que paga un criterio de la deuda: evidencia en vivo, o la firma de la persona sobre un criterio imposible.
const PAGA = new Set(['RUNTIME', 'WAIVED-USER']);

/**
 * Las deudas de evidencia en vivo de `gates.log`, una por historia y deuda (en una historia paraguas cada tanda trae la
 * suya): `acmatrix-debt` la abre, `acmatrix-debt-renewed` de la misma deuda le cambia la fecha y `acmatrix-debt-paid`
 * la cierra. `{ debts: [{ storyPath, storyRel, repoCommon, story, deuda, acs, until }], problems }`: un `gates.log` que
 * no se deja leer o un renglón de deuda ilegible van a `problems`, nunca son «sin deudas».
 */
function evidenceDebts(gatesLog) {
  let text = '';
  try { text = fs.readFileSync(gatesLog, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { debts: [], problems: [] };
    return { debts: [], problems: [`no pude leer ${gatesLog} (${e.code || e.message})`] };
  }
  const key = (l) => `${l.storyPath}\0${l.deuda || ''}`;
  const byDebt = new Map();
  let unreadable = 0;
  for (const raw of text.split('\n')) {
    if (!raw.includes('acmatrix-debt')) continue;
    let l;
    try { l = JSON.parse(raw); } catch (_) { unreadable++; continue; }
    if (!l || !['acmatrix-debt', 'acmatrix-debt-renewed', 'acmatrix-debt-paid'].includes(l.name)) continue;
    if (typeof l.storyPath !== 'string') { unreadable++; continue; }
    if (l.name === 'acmatrix-debt-paid') { byDebt.delete(key(l)); continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(l.until || ''))) { unreadable++; continue; }
    if (l.name === 'acmatrix-debt') {
      if (!Array.isArray(l.acs)) { unreadable++; continue; }
      byDebt.set(key(l), { storyPath: l.storyPath, storyRel: l.storyRel || null, repoCommon: l.repoCommon || null, story: l.story, deuda: l.deuda, acs: l.acs, until: l.until });
    } else if (byDebt.has(key(l))) byDebt.get(key(l)).until = l.until;
  }
  return { debts: [...byDebt.values()], problems: unreadable ? [`${unreadable} renglón(es) de deuda de evidencia ilegibles en ${gatesLog}`] : [] };
}

/**
 * Dónde está hoy la historia de una deuda: en su ruta, o, si esa carpeta de trabajo ya no está (se borra después del
 * merge), en la misma ruta relativa de otra carpeta de su repo (`git worktree list`), primero el checkout principal.
 */
function storyOf(d) {
  if (fs.existsSync(d.storyPath)) return d.storyPath;
  if (!d.repoCommon || !d.storyRel) return null;
  const r = require('child_process').spawnSync('git', ['--git-dir', d.repoCommon, 'worktree', 'list', '--porcelain'],
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0) return null;
  for (const m of String(r.stdout).matchAll(/^worktree (.+)$/gm)) {
    const c = path.join(m[1], d.storyRel);
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Cómo está una deuda hoy: `{ paid }` si sus criterios ya tienen evidencia en vivo o la firma de la persona (o la
 * matriz entera está verde, también por la historia eximida); `{ line }` si venció y no está pagada, o no se pudo mirar;
 * `{}` si no venció y no está pagada.
 */
function debtState(d, today) {
  const vencida = today > d.until;
  const head = `🔴 deuda de evidencia en vivo vencida el ${d.until}: ${path.basename(d.storyPath)} (${d.deuda || 'sin id'}, AC ${d.acs.join(', ')})`;
  const story = storyOf(d);
  if (!story) return vencida ? { line: `${head} — no pude mirar: la historia ya no está en ${d.storyPath}${d.repoCommon ? ' ni en las carpetas de su repo' : ''}` } : {};
  let m;
  try { m = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'runtime-matrix.js')).compute({ storyPath: story }); } catch (e) {
    return vencida ? { line: `${head} — no pude mirar: la matriz no se calculó (${e.message})` } : {};
  }
  if (m.structuralError) return vencida ? { line: `${head} — no pude mirar: ${m.structuralError}` } : {};
  const pending = m.green ? [] : d.acs.filter((n) => !m.perAc || !m.perAc[n] || !PAGA.has(m.perAc[n].verdict));
  if (!pending.length) return { paid: true };
  return vencida ? { line: `${head} — siguen sin evidencia en vivo: AC ${pending.join(', ')}. Corré la evidencia (smoke-run.sh o el portón E2E).` } : {};
}

/** Las líneas de las deudas vencidas cuyos criterios siguen sin evidencia en vivo (o que no se pudieron mirar). */
function expiredDebtLines(debts, today) {
  return debts.map((d) => debtState(d, today).line).filter(Boolean);
}

/**
 * El aviso de la deuda de evidencia en vivo, una vez por día local (el mismo reloj que el vencimiento). Mira cada deuda
 * abierta: la pagada se cierra con un `acmatrix-debt-paid` en `gates.log` (después de pagada, que el código cambie no la
 * reabre: la frescura la mide la próxima corrida), la vencida sin pagar se dice. Lo llama `finished-open-notice.js`, que
 * se instala siempre.
 */
function noticeDebts({ dir, now, write }) {
  const day = localDate(now);
  const sealFile = path.join(dir, DEBT_SEAL);
  try { if (JSON.parse(fs.readFileSync(sealFile, 'utf8')).day === day) return; } catch (_) { /* sin sello: se mira */ }
  const gatesLog = path.join(dir, 'gates.log');
  const { debts, problems } = evidenceDebts(gatesLog);
  if (!debts.length && !problems.length) return;
  const lines = [];
  for (const d of debts) {
    const s = debtState(d, day);
    if (s.paid) fs.appendFileSync(gatesLog, JSON.stringify({ ts: new Date(now).toISOString(), name: 'acmatrix-debt-paid', story: d.story, storyPath: d.storyPath, deuda: d.deuda, acs: d.acs }) + '\n', 'utf8');
    else if (s.line) lines.push(s.line);
  }
  for (const p of problems) lines.push(`🔴 deuda de evidencia en vivo: no pude mirar del todo — ${p}`);
  // primero se sella, después se dice (como el aviso de las corridas); con deudas abiertas se sella aunque no diga nada,
  // para no recalcular sus matrices en cada arranque del día
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sealFile, JSON.stringify({ day, debts: debts.length, lines: lines.length }), 'utf8');
  for (const l of lines) write(l);
}

/** La entrada del aviso de la deuda: el reloj de las pruebas es `TYCON_UNCLOSED_NOW`; una falla se dice, no se calla. */
function debtNotice({ env = process.env, home = os.homedir(), write = (t) => console.log(t) } = {}) {
  const now = env.TYCON_UNCLOSED_NOW ? Date.parse(env.TYCON_UNCLOSED_NOW) : Date.now();
  try { noticeDebts({ dir: stateDirOf(home), now, write }); } catch (e) {
    write(`🔴 deuda de evidencia en vivo: no pude mirar (${String((e && e.message) || e).split('\n')[0]})`);
  }
}

function main({ env = process.env, home = os.homedir(), write = (t) => console.log(t) } = {}) {
  if (String(env.TYCON_UNCLOSED_NOTICE || '').trim() === '0') return 0;
  const now = env.TYCON_UNCLOSED_NOW ? Date.parse(env.TYCON_UNCLOSED_NOW) : Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const dir = stateDirOf(home);
  const sealFile = path.join(dir, SEAL);
  try { if (JSON.parse(fs.readFileSync(sealFile, 'utf8')).day === day) return 0; } catch (_) { /* sin sello: se mira */ }
  const script = path.join(__dirname, '..', 'metrics', 'unclosed-runs.js');
  const { runs, problems } = require(script).findUnclosed({ home, stateDir: dir, now, env });
  if (!runs.length && !problems.length) return 0;
  // primero se sella, después se dice: si el estado no se deja escribir, calla (un aviso de cada arranque se deja de leer)
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sealFile, JSON.stringify({ day, runs: runs.length, problems: problems.length }), 'utf8');
  // «no pude mirar» no es «no hay»: se dice, con dónde está el detalle
  const partial = problems.length ? `${problems.length} cosa(s) no se pudieron mirar (${problems[0]}${problems.length > 1 ? '; …' : ''}); el detalle: node "${script}"` : '';
  if (runs.length) write(line(runs, script) + (partial ? ` · Además, ${partial}` : ''));
  else write(`⚠️ No pude mirar del todo si quedaron ejecuciones del pipeline sin cerrar: ${partial}`);
  return 0;
}

module.exports = { main, line, SEAL, DEBT_SEAL, evidenceDebts, expiredDebtLines, debtNotice };

if (require.main === module) {
  try { process.exitCode = main(); } catch (_) { process.exitCode = 0; }
}
