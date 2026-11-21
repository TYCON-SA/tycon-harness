'use strict';
/**
 * browser-test — la oferta de preparar la prueba con navegador, su constancia y el «no» de la persona que leen los
 * frenos del cierre.
 *
 * La oferta aparece cuando se cumplen las dos cosas: la historia cambia una pantalla (la misma detección que el cierre,
 * `ui-signal.js` con la regla `screen_test` de la organización) Y el repo no tiene prueba con navegador. Un repo
 * preparado no la muestra, sea la historia que sea: ahí la prueba se corre y no se exime. El «no» vale para su
 * historia: la próxima con pantalla la vuelve a recibir, hasta que el repo se prepare.
 *
 * La muestra el arnés en la pantalla de la persona (`systemMessage`), por el mismo camino que el plan
 * (`plan-display.js`): lo que el agente lee no siempre le llega a la persona.
 *
 * El «no» lo aprueba la persona en la ventana de permiso (o en su terminal), después de la oferta mostrada para esa
 * historia. La constancia sola no alcanza: cada freno del cierre busca la línea de esa firma en el registro del arnés,
 * entre la oferta y la constancia. Una constancia vieja, firmada con una cita en la conversación, ya no cuenta: el «no»
 * se pide de nuevo. La oferta se muestra siempre, también si la conversación no se puede leer.
 *
 *   · `offerText(clave)`: el texto aprobado, una sola fuente.
 *   · `repoReady(repo)`: ¿el repo resuelve un portón de navegador (`e2eConfig`) y tiene `@playwright/test` instalado
 *     donde apunta? `{ ready, missing }`.
 *   · `offerToShow({ command, sessionId, stateDir, home })`: antes de `marker.js complete-step approve-plan`, el texto y `anotar()`;
 *     si no corresponde, null. `handle(event)`: lo mismo al escribir el plan con Edit o Write (despachador de ediciones).
 *   · `lastOffer(stateDir, storyId, repo)`: la última oferta mostrada para esa historia de ese repo, o null.
 *   · `debtDeclared({ stateDir, storyPath, content, home, env })`: `{ declared, story, fecha, cita, quien }` o
 *     `{ declared: false, motivo }`. `debtLine(d)`: la línea que dicen los frenos. `recordDebtUse(...)`: la constancia
 *     de que un freno la aceptó.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OFFER_SHOWN = 'browser-test-offer-shown';
const PREPARED = 'browser-test-prepared';
const DEFERRED = 'browser-test-deferred';
const DEBT = 'browser-test-debt';
const CIERRE_DEL_PASO_3 = /\bmarker\.js["']?\s+complete-step\s+["']?3(?![\w.])/;
const PLAN_FILE = 'step-02-bmad-plan.md';
// La clave de una historia va en un nombre de archivo y en el título de una prueba: sólo letras, dígitos, punto, guion
// y guion bajo.
const CLAVE_SEGURA = /^[\w.-]+$/;

const huella = (txt) => crypto.createHash('sha256').update(String(txt).trim()).digest('hex').slice(0, 16);
const mismaRuta = (a, b) => path.resolve(String(a)).replace(/\\/g, '/').toLowerCase() === path.resolve(String(b)).replace(/\\/g, '/').toLowerCase();
const real = (p) => { try { return fs.realpathSync(p); } catch (_e) { return path.resolve(String(p)); } };

// Un renglón por párrafo: el ancho lo pone la terminal de la persona (con cortes fijos, en pantalla quedaba entrecortado).
function offerText(clave) {
  return [
    'Este repo todavía no tiene cómo probar en un navegador. ¿Lo preparo? Esta historia cambia una pantalla, y para cerrarla el arnés la prueba en un navegador de verdad. Esto es lo que haría:',
    '',
    '- Instalo Playwright, la herramienta que abre el navegador y prueba la pantalla. Va como herramienta de desarrollo del repo, en package.json, y no cambia nada de lo que usa tu app en producción.',
    '- Bajo el navegador que usa Playwright (Chromium, unos 150 MB). Queda en una carpeta de tu usuario, fuera del repo, y la comparten tus otros proyectos.',
    `- Escribo tres cosas: la configuración (playwright.config.ts), una primera prueba de esta historia (tests/e2e/${clave}.spec.ts) y una línea en .tycon/advisors.yaml que le dice al arnés dónde está la pantalla.`,
    '',
    'Para volver atrás, pedime «deshacé la preparación de la prueba con navegador»: desinstalo Playwright y borro lo que escribí.',
    '',
    'Si me decís que no, la historia sigue igual: la pruebo con la guía para probarla a mano, y la prueba con navegador queda anotada en la historia como pendiente, con tu respuesta, hasta que la prepares.',
    '',
    '¿La preparo? Contestá «sí, preparala» o «no, por ahora no».',
  ].join('\n');
}

/** Las constancias de la oferta en `gates.log`, ya leídas. Un renglón roto no tapa a los demás. */
function gates(stateDir) {
  let txt = '';
  try { txt = fs.readFileSync(path.join(stateDir, 'gates.log'), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const l of txt.split('\n')) {
    if (!l.includes('"browser-test-')) continue;
    try { out.push(JSON.parse(l)); } catch (_e) { /* renglón a medio escribir */ }
  }
  return out;
}

function anotar(stateDir, constancia) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.appendFileSync(path.join(stateDir, 'gates.log'), `${JSON.stringify(constancia)}\n`, 'utf8');
}

/** ¿`@playwright/test` se resuelve desde `dir`, sin salir del repo? */
function playwrightInstalado(dir, repo) {
  let d = path.resolve(dir);
  const tope = path.resolve(repo);
  for (;;) {
    if (fs.existsSync(path.join(d, 'node_modules', '@playwright', 'test', 'package.json'))) return true;
    if (mismaRuta(d, tope)) return false;
    const up = path.dirname(d);
    if (up === d) return false;
    d = up;
  }
}

function repoReady(repo) {
  const cfg = require('../pipeline.js').e2eConfig(repo);
  if (!cfg || !cfg.gate) return { ready: false, missing: ['e2e'] };
  const dirs = cfg.frontend_dirs && cfg.frontend_dirs.length ? cfg.frontend_dirs : [cfg.frontend_dir || repo];
  const sin = dirs.filter((d) => !playwrightInstalado(d, repo));
  return sin.length ? { ready: false, missing: ['playwright'], dirs: sin } : { ready: true, missing: [] };
}

function leerFrontmatter(content) {
  const m = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : '';
}

function storyIdDe(content, storyPath) {
  const m = leerFrontmatter(content).match(/^story:\s*["']?([^"'\n]+?)["']?\s*$/m);
  return m ? m[1] : path.basename(String(storyPath || ''), '.md');
}

/** La clave de la historia (la de su evidencia), o null si no sirve como nombre de archivo. */
function claveDe(storyPath, content) {
  const id = storyIdDe(content, storyPath);
  let clave = id;
  try { clave = (require('./evidence-key.js').evidenceKey(path.resolve(storyPath)) || {}).key || id; } catch (e) {
    process.stderr.write(`⚠️  no pude calcular la clave de la evidencia de ${storyPath} (${e.message}): uso el número ${id}\n`);
  }
  return CLAVE_SEGURA.test(String(id)) && CLAVE_SEGURA.test(String(clave)) ? String(clave) : null;
}

function screenRule() {
  try { return require('./stack-config.js').orgRules().rules.screen_test.value; } catch (e) {
    process.stderr.write(`⚠️  no pude leer la regla de pantallas de la organización (${e.message}): uso la de fábrica (ui)\n`);
    return 'ui';
  }
}

/** ¿La historia cambia una pantalla? La misma detección que los frenos del cierre. */
function storyHasScreen(content, repo) {
  return require('./ui-signal.js').applyScreenRule(content, repo, screenRule()).ui === true;
}

/** La raíz git de la historia: el repo al que pertenece. */
function repoDe(storyPath) {
  return require('./evidence-config.js').discoverRepoRoot(path.resolve(storyPath));
}

function rutaDeLaStory(marker) {
  if (!marker || !marker.storyPath) return null;
  const p = path.isAbsolute(marker.storyPath) ? marker.storyPath : path.join(marker.repoPath || process.cwd(), marker.storyPath);
  return fs.existsSync(p) ? p : null;
}

function leerMarcador(stateDir, sessionId) {
  let txt;
  try { txt = fs.readFileSync(path.join(stateDir, 'active', `${sessionId}.json`), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  return JSON.parse(txt);
}

/** La última oferta mostrada para esa historia de ese repo, o null. */
function lastOffer(stateDir, storyId, repo) {
  const rs = gates(stateDir).filter((g) => g.name === OFFER_SHOWN && g.story === String(storyId) && g.repoPath && mismaRuta(real(g.repoPath), real(repo)));
  return rs.length ? rs[rs.length - 1] : null;
}

/** Una decisión ya tomada para esa historia de ese repo: la preparación, o un «no» que todavía se puede comprobar. */
function decidida(stateDir, storyId, repo, storyPath) {
  const prep = gates(stateDir).some((g) => g.name === PREPARED && g.story === String(storyId) && g.repoPath && mismaRuta(real(g.repoPath), real(repo)));
  if (prep) return true;
  return gates(stateDir).some((g) => g.name === DEFERRED && g.story === String(storyId) && g.storyPath && mismaRuta(g.storyPath, real(storyPath)));
}

function offerToShow({ command, sessionId, stateDir, home = os.homedir() }) {
  if (!command || !CIERRE_DEL_PASO_3.test(String(command))) return null;
  return mostrar({ sessionId, stateDir, home });
}

function handle(event, opts = {}) {
  const tool = event && event.tool_name;
  if (tool !== 'Write' && tool !== 'Edit') return null;
  const file = event.tool_input && event.tool_input.file_path;
  if (!file || path.basename(String(file)) !== PLAN_FILE) return null;
  const { resolveSessionId } = require('./session-id.js');
  const r = mostrar({
    sessionId: resolveSessionId(event.session_id), stateDir: opts.stateDir || require('./story-gate-io.js').DEFAULT_STATE_DIR,
    home: opts.home,
  });
  return r ? { systemMessage: r.systemMessage, alMostrar: r.anotar } : null;
}

function mostrar({ sessionId, stateDir, home = os.homedir() }) {
  if (!sessionId) return null;
  const marker = leerMarcador(stateDir, sessionId);
  if (!marker || !marker.storyId) return null;
  if (require('./steps.js').isDone(marker, 'approve-plan')) return null;
  const story = rutaDeLaStory(marker);
  if (!story) return null;
  const repo = marker.repoPath || path.dirname(story);
  const content = fs.readFileSync(story, 'utf8');
  if (!storyHasScreen(content, repo)) return null;
  if (repoReady(repo).ready) return null;
  const id = String(marker.storyId);
  if (decidida(stateDir, id, repo, story)) return null;
  if (gates(stateDir).some((g) => g.name === OFFER_SHOWN && g.sessionId === sessionId && g.story === id)) return null;
  // con un número que no sirve de nombre de archivo la preparación no se puede cumplir: no se ofrece
  const clave = claveDe(story, content);
  if (!clave) return null;
  const constancia = { ts: new Date().toISOString(), sessionId, repoPath: repo, name: OFFER_SHOWN, status: 'ok', story: id };
  return { systemMessage: offerText(clave), constancia, anotar: () => anotar(stateDir, constancia) };
}

/** Las dos llaves de la historia: `{ marcada, fecha, cita }`. */
function marcaDeLaHistoria(content) {
  const fm = leerFrontmatter(content);
  const marcada = /^browser_test:\s*["']?deferred["']?\s*$/m.test(fm);
  const r = fm.match(/^browser_test_reason:\s*"((?:[^"\\]|\\.)*)"\s*$/m);
  const motivo = r ? r[1].replace(/\\(.)/g, '$1') : '';
  const fecha = (motivo.match(/^(\d{4}-\d{2}-\d{2})\b/) || [])[1] || null;
  const cita = (motivo.match(/«([^»]*)»\s*$/) || [])[1] || null;
  return { marcada, fecha, cita };
}

function firmaQueNoAparece(g, filas) {
  const desde = Date.parse(g.offerTs || '');
  const hasta = Date.parse(g.ts || '');
  const ok = filas.some((f) => f.name === 'browser-test-signed' && f.via === g.via && f.destino === g.sessionId
    && Date.parse(f.ts) >= desde && Date.parse(f.ts) <= hasta);
  return ok ? null : 'no hay constancia de que la persona lo haya aprobado en la ventana de permiso o en su terminal';
}

function debtDeclared({ stateDir, storyPath, content = null, home = os.homedir(), env = process.env }) {
  let txt = content;
  if (txt == null) {
    try { txt = fs.readFileSync(storyPath, 'utf8'); } catch (e) { return { declared: false, motivo: `no pude leer la historia (${e.code || e.message})` }; }
  }
  const id = storyIdDe(txt, storyPath);
  const marca = marcaDeLaHistoria(txt);
  if (!marca.marcada || !marca.cita || !marca.fecha) return { declared: false, motivo: 'la historia no declara la prueba con navegador pendiente', story: id };
  let repo = null;
  try { repo = repoDe(storyPath); } catch (e) { return { declared: false, motivo: `no pude saber a qué repo pertenece la historia (${e.message})`, story: id }; }
  if (!repo) return { declared: false, motivo: 'no pude saber a qué repo pertenece la historia', story: id };
  if (repoReady(repo).ready) return { declared: false, motivo: 'el repo ya tiene prueba con navegador: se corre, no se exime', story: id };
  const sha = huella(marca.cita);
  const rs = gates(stateDir).filter((g) => g.name === DEFERRED && g.story === id && g.quoteSha === sha && g.storyPath && mismaRuta(g.storyPath, real(storyPath)));
  if (!rs.length) return { declared: false, motivo: 'la historia dice que la prueba con navegador quedó pendiente, pero no hay constancia de que lo haya dicho la persona', story: id };
  const g = rs[rs.length - 1];
  const ofertas = gates(stateDir).filter((o) => o.name === OFFER_SHOWN && o.story === id && o.sessionId === g.sessionId && o.ts === g.offerTs);
  if (!ofertas.length) return { declared: false, motivo: 'no hay constancia de la oferta a la que contestó la persona', story: id };
  // firmada en la ventana, con el click o el «aprobado» de la persona, por la delegación o en la terminal: vale la línea
  // de la firma, entre la oferta y la constancia. Una vieja, firmada con una cita en la conversación, ya no cuenta: se pide de nuevo
  const falta = ['ventana', 'click', 'mensaje', 'delegacion', 'terminal'].includes(g.via) ? firmaQueNoAparece(g, gates(stateDir))
    : 'el «no» se dio con una cita en la conversación, que ya no cuenta: pedilo de nuevo en la ventana';
  if (falta) return { declared: false, motivo: falta, story: id };
  // la fecha que se dice es la de la constancia, no la que trae la historia (que se puede editar)
  return { declared: true, story: id, fecha: String(g.ts || marca.fecha).slice(0, 10), cita: marca.cita, quien: g.approvedBy || null };
}

function debtLine(d) {
  return `Prueba con navegador pendiente en la historia ${d.story} (la persona dijo que no el ${d.fecha}: «${d.cita}»). Para prepararla: pedí «prepará la prueba con navegador».`;
}

/** La cita en un solo renglón: sin saltos que agreguen llaves al frontmatter, y la misma para la huella. */
function citaEnUnRenglon(cita) {
  return String(cita || '').replace(/[«»"]/g, '').replace(/\s+/g, ' ').trim();
}

function recordDebtUse(stateDir, d, donde) {
  try {
    anotar(stateDir, { ts: new Date().toISOString(), name: DEBT, status: 'accepted', story: d.story, where: donde });
  } catch (e) {
    process.stderr.write(`⚠️  no pude anotar en gates.log que se aceptó la prueba con navegador pendiente de la historia ${d.story} (${e.code || e.message})\n`);
  }
}

module.exports = {
  OFFER_SHOWN, PREPARED, DEFERRED, DEBT, PLAN_FILE, CLAVE_SEGURA, huella, offerText, repoReady, storyHasScreen, storyIdDe,
  claveDe, lastOffer, offerToShow, handle, debtDeclared, debtLine, citaEnUnRenglon, recordDebtUse, anotar, gates,
};
