'use strict';
/**
 * signatures-without-person.test.js — una firma que sale sin persona («hecho y avisado» de una pestaña sin permisos, o
 * la delegación a la coordinadora) pasa por el control previo del guion (`antes`), y sin él no sale.
 *
 * Todo en proceso, sobre una casa de juguete: el registro de la ventana se escribe a mano (como lo deja el freno, con la
 * vía que se prueba), el árbol de procesos y la hora se inyectan. La prueba de cruce lee el código del árbol: cada
 * llamada a `exigir(` y a `firmaDelDueno(` con su firma, y si pasa su `antes`.
 *
 * stable-data: las horas son las de AHORA, fija; ninguna se compara con el reloj.
 */
// sin el perfil del equipo: la prueba fija su ambiente (lib/without-team-profile.js)
require('./lib/without-team-profile.js');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const RAIZ = path.join(__dirname, '..', '..');
const ow = require('../lib/owner-window.js');
const SIG = require('../lib/signatures.js');
const { arbolDelGuion, arbolDelFreno } = require('./lib/window-passed.js');

const MARKER = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
const AHORA = Date.parse('2026-10-27T13:00:00Z');
const INICIO = 'Tue Oct 27 10:00:00 2026';
const PLAN = `node ${MARKER} complete-step approve-plan --for-session ses-a --approved "el plan"`;
const PLAN_ARGV = [MARKER, 'complete-step', 'approve-plan', '--for-session', 'ses-a', '--approved', 'el plan'];
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function casaNueva(t) {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'sin-persona-'));
  t.after(() => fs.rmSync(casa, { recursive: true, force: true }));
  const activos = path.join(casa, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(activos, { recursive: true });
  fs.writeFileSync(path.join(activos, 'ses-a.json'), JSON.stringify({ sessionId: 'ses-a', storyId: '9.99', storyPath: '/r/specs/story-9.99.md' }));
  return casa;
}

/** El registro de la ventana como lo deja el freno: `via` ausente es la ventana. */
function registrar(casa, { firma = 'plan-approval', cmd = PLAN, sesion = 'ses-coord', destino = 'ses-a', via, extra = {} } = {}) {
  fs.mkdirSync(ow.carpeta(casa), { recursive: true });
  const reg = { firma, sesion, destino, tool_use_id: 'toolu_01', sha256: sha(cmd), comando: cmd, herramienta: { pid: 100, inicio: INICIO },
    ts: new Date(AHORA).toISOString(), ...(via === undefined ? {} : { via }), ...extra };
  const archivo = path.join(ow.carpeta(casa), `${firma.replace(/[^\w-]/g, '_')}--${crypto.randomBytes(4).toString('hex')}.json`);
  fs.writeFileSync(archivo, JSON.stringify(reg));
  return archivo;
}
const vigentes = (casa) => { try { return fs.readdirSync(ow.carpeta(casa)).filter((f) => f.endsWith('.json')); } catch (_) { return []; } };
const consumidos = (casa) => { try { return fs.readdirSync(ow.carpeta(casa)).filter((f) => f.includes('.consumido-')); } catch (_) { return []; } };
const firmasDelRegistro = (casa) => { try { return fs.readFileSync(path.join(casa, '.claude', '.tycon-pipeline', 'signatures.jsonl'), 'utf8').split('\n').filter(Boolean); } catch (_) { return []; } };

/** El guion que pide la firma del registro: `exigir` con el árbol de la prueba. */
function exigirCon(casa, { firma = 'plan-approval', cmd = PLAN, argv = PLAN_ARGV, propia = 'ses-coord', ...o } = {}) {
  const renglones = [];
  const r = ow.exigir({ firma, argv, pid: 301, arbol: arbolDelGuion(casa, cmd), casa, ahora: AHORA + 60000, propia,
    anotar: (renglon) => renglones.push(renglon), notificar: () => {}, ...o });
  return { r, renglones };
}

// ── la regla ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('T1 Exigir_WithoutBefore_NoPersonVia_Denied @story-8.255 @ac-1', (t) => {
  for (const via of ['avisado', 'delegacion']) {
    const casa = casaNueva(t);
    registrar(casa, { via });
    const { r, renglones } = exigirCon(casa);
    assert.notStrictEqual(r.codigo, 0, `${via}: no firma sin control previo`);
    assert.strictEqual(vigentes(casa).length, 1, `${via}: el pedido no se consume`);
    assert.strictEqual(consumidos(casa).length, 0, via);
    assert.deepStrictEqual(renglones, [], `${via}: sin renglón -signed`);
    assert.deepStrictEqual(firmasDelRegistro(casa), [], `${via}: nada en el registro de firmas`);
    assert.match(r.motivo, /la da una persona/, via);
    assert.match(r.motivo, /Si lo que frena es que no firma una persona/, `${via}: dice cómo aprobarla (comoAprobar)`);
  }
});

test('T2 Exigir_WithoutBefore_PersonVias_Signs @story-8.255 @ac-2', (t) => {
  for (const via of [undefined, 'click', 'mensaje']) {
    const casa = casaNueva(t);
    registrar(casa, { via });
    const { r, renglones } = exigirCon(casa);
    assert.strictEqual(r.codigo, 0, `${via || 'ventana'}: ${r.motivo}`);
    assert.strictEqual(renglones.filter((x) => x.name === 'plan-approval-signed').length, 1, `${via || 'ventana'}: un renglón -signed`);
  }
});

test('T3 Exigir_Precheck_AvisadoWithoutBefore_Denied @story-8.255 @ac-3', () => {
  for (const via of ['avisado', 'delegacion']) {
    const escrito = [];
    let salio = null;
    const r = ow.exigir({ firma: 'plan-approval', argv: PLAN_ARGV, propia: 'ses-coord', env: { [ow.PRECHEQUEO]: '1', [ow.PRECHEQUEO_VIA]: via },
      escribir: (x) => escrito.push(x), salir: (c) => { salio = c; } });
    assert.notStrictEqual(r.codigo, 0, `${via}: el chequeo previo niega sin control previo`);
    assert.ok(!escrito.join('').includes(ow.PRECHEQUEO_OK), `${via}: sin ${ow.PRECHEQUEO_OK}`);
    assert.strictEqual(salio, null, `${via}: no sale con 0`);
  }
  // con la ventana (sin vía) el chequeo previo sigue como hoy
  const escrito = [];
  ow.exigir({ firma: 'plan-approval', argv: PLAN_ARGV, propia: 'ses-coord', env: { [ow.PRECHEQUEO]: '1', [ow.PRECHEQUEO_VIA]: '' },
    escribir: (x) => escrito.push(x), salir: () => {} });
  assert.ok(escrito.join('').includes(ow.PRECHEQUEO_OK));
});

test('T4 Decidir_Avisado_PassesViaToPrecheck @story-8.255 @ac-3', (t) => {
  const casa = casaNueva(t);
  const cmd = `node ${MARKER} approve-pending --id DEF-x --repo /r`;
  const vias = [];
  const decidir = (comprobar) => ow.decidir({
    evento: { session_id: 'ses-coord', tool_use_id: 'toolu_01', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd }, permission_mode: 'bypassPermissions' },
    escapes: [], arbol: arbolDelFreno(), pid: 201, casa, ahora: AHORA, delegacion: () => ({ ok: false, motivo: 'sin delegación en la prueba' }),
    clasificar: () => null, comprobar: (o) => { vias.push(o.via); return comprobar(o); }, aprobador: () => ({ label: 'El dueño' }),
    aprobaciones: { buscar: () => ({ ok: false, motivo: 'no hay un click' }), consumir: () => ({ ok: true }), devolver: () => {}, coordinadoraConfirmada: () => null },
  });
  const r = decidir(() => ({ ok: true }));
  assert.strictEqual(r.decision, 'allow', r.texto);
  assert.strictEqual(r.via, 'avisado');
  assert.ok(vias.includes('avisado'), `el chequeo previo recibe la vía avisado (recibió ${JSON.stringify(vias)})`);
  // sin persona no sale, con ella sí: se niega con el cuadro para aprobarla con un click
  const conClick = decidir((o) => (o.via === 'avisado' ? { niega: 'falta el control' } : { ok: true }));
  assert.strictEqual(conClick.decision, 'deny', conClick.texto);
  assert.match(conClick.texto, /sin persona el control previo de la firma la niega: falta el control/);
  assert.ok(conClick.cuadro && !conClick.cuadro.error, 'trae el cuadro del click');
  // se negaría también con persona: su texto, sin cuadro
  const igual = decidir(() => ({ niega: 'el pendiente no existe' }));
  assert.strictEqual(igual.decision, 'deny', igual.texto);
  assert.match(igual.texto, /el pendiente no existe/);
  assert.ok(!igual.cuadro, 'sin cuadro: un click no lo arreglaría');
});

// ── los modos de falla ───────────────────────────────────────────────────────────────────────────────────────────

test('T16 Exigir_BeforeThrows_FailsClosed @story-8.255 @ac-15', (t) => {
  const casa = casaNueva(t);
  registrar(casa, { via: 'delegacion' });
  const { r, renglones } = exigirCon(casa, { antes: () => { throw new Error('roto'); } });
  assert.strictEqual(r.codigo, 2, r.motivo);
  assert.match(r.motivo, /no pude comprobar el control previo \(roto\)/);
  assert.strictEqual(vigentes(casa).length, 1, 'el pedido no se consume');
  assert.deepStrictEqual(renglones, [], 'sin -signed');
  // en el chequeo previo, lo mismo
  const escrito = [];
  let salio = null;
  const p = ow.exigir({ firma: 'plan-approval', argv: PLAN_ARGV, propia: 'ses-coord', env: { [ow.PRECHEQUEO]: '1', [ow.PRECHEQUEO_VIA]: 'avisado' },
    antes: () => { throw new Error('roto'); }, escribir: (x) => escrito.push(x), salir: (c) => { salio = c; } });
  assert.strictEqual(p.codigo, 2, p.motivo);
  assert.match(p.motivo, /no pude comprobar el control previo \(roto\)/);
  assert.ok(!escrito.join('').includes(ow.PRECHEQUEO_OK));
  assert.strictEqual(salio, null);
});

test('T17 Verificar_UnknownVia_Denied @story-8.255 @ac-16', (t) => {
  const casa = casaNueva(t);
  registrar(casa, { via: 'otra' });
  const { r, renglones } = exigirCon(casa, { antes: () => null });
  assert.notStrictEqual(r.codigo, 0);
  assert.match(r.motivo, /vía desconocida en el registro de la ventana/);
  assert.strictEqual(vigentes(casa).length, 1, 'el pedido no se consume');
  assert.deepStrictEqual(renglones, []);
});

// ── la prueba de cruce ───────────────────────────────────────────────────────────────────────────────────────────

const RUTINA = ['pending-approval', 'save', 'plan-approval', 'adhoc-lane'];
const NIVEL = new Map(SIG.LEVELS.map((l) => [l.id, l.level]));
const cubre = (firma) => { const s = SIG.SIGNATURES.find((x) => x.id === firma); return s ? [...s.covers] : [firma]; };
const pideAntes = (firma) => RUTINA.includes(firma) || cubre(firma).some((id) => NIVEL.get(id) === 1);

/**
 * Las llamadas con la firma calculada (no literal): qué firmas puede pedir cada una, por archivo y función que la
 * encierra. `delega`: la definición de `firmaDelDueno`, cuyo `antes` lo trae cada llamada literal.
 */
const CALCULADAS = {
  'skills/tycon-pipeline/scripts/marker.js::firmaDelDueno': { delega: true },
  'skills/tycon-pipeline/scripts/marker.js::firmaDeLaDesignacion': { firmas: ['designation-set', 'designation-withdraw'] },
  'skills/tycon-pipeline/scripts/marker.js::cmdAdhoc': { firmas: ['adhoc-lane', 'adhoc-lane:sobre-cupo'] },
  'skills/tycon-pipeline/scripts/marker.js::cmdSignFile': { firmas: SIG.FIRMAS_DE_ARCHIVO.map((f) => `escape:${f}`) },
  'skills/tycon-pipeline/scripts/marker.js::cmdApprovePending': { firmas: ['pending-approval'] },
  'skills/tycon-pipeline/scripts/marker.js::cmdSalidaPerdida': { firmas: ['lost-run', 'lost-run:particion'] },
  'skills/tycon-pipeline/scripts/marker.js::cmdSignAdversarialSkip': { firmas: ['adversarial-skip'] },
  'skills/tycon-pipeline/scripts/lib/adversarial-skip.js::firmarSalteo': { firmas: ['adversarial-skip'] },
  'scripts/ci/run-base-controls.sh::approveByWindow': { firmas: ['refresh-after-main', 'control-change'] },
};
// las que no viven dentro de una función: se reconocen por su argumento. El `verify` de la consola, que ningún guion del
// público llama (lo mira VERIFY_SIN_LLAMADORES)
const CALCULADAS_SUELTAS = [{ archivo: 'scripts/lib/owner-window.js', args: /firma: val\('--signature'\)/, firmas: [] }];

/**
 * Los `.js` y `.sh` del árbol, sin pruebas (ni carpetas `tests/` ni archivos `*.test.*`), sin el banco, sin los
 * laboratorios de `tasks/` (el árbol que arma el portón pone el privado debajo) y sin `on-red-test-edit.js` (su
 * `firmaDelDueno` no es la de marker.js).
 */
function archivosDelArbol(raiz) {
  const out = [];
  const recorrer = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(raiz, p).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (['.git', 'node_modules', 'tests', '.advisors', 'tasks'].includes(e.name) || rel === 'scripts/controls-bench') continue;
        recorrer(p);
      } else if (/\.(js|sh)$/.test(e.name) && !/\.test\.(js|sh)$/.test(e.name) && !rel.endsWith('on-red-test-edit.js')) out.push(rel);
    }
  };
  recorrer(raiz);
  return out;
}

/** El texto entre el paréntesis que abre en `i` y el que lo cierra, saltando comillas. */
function argumentos(texto, i) {
  let prof = 0;
  let comilla = null;
  for (let k = i; k < texto.length; k++) {
    const c = texto[k];
    if (comilla) {
      if (c === '\\') { k++; continue; }
      if (c === comilla) comilla = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') comilla = c;
    else if (c === '(') prof++;
    else if (c === ')' && --prof === 0) return texto.slice(i + 1, k);
  }
  return texto.slice(i + 1);
}

/** Cada llamada de firma del archivo: `{ archivo, linea, funcion, firma | null, conAntes }`. Los comentarios no cuentan. */
function llamadasDe(raiz, rel) {
  const texto = fs.readFileSync(path.join(raiz, rel), 'utf8');
  const lineas = texto.split('\n');
  const out = [];
  const re = /\b(exigir|firmaDelDueno)\(/g;
  let m;
  while ((m = re.exec(texto))) {
    const antesDelMatch = texto.slice(0, m.index);
    const n = antesDelMatch.split('\n').length;
    const linea = lineas[n - 1];
    const enLaLinea = linea.slice(0, m.index - (antesDelMatch.lastIndexOf('\n') + 1));
    // un comentario (//, /* */, una línea de JSDoc o de shell) o la definición no es una llamada
    if (/^\s*(\*|\/\*|#)/.test(linea) || enLaLinea.includes('//') || /\bfunction\s+$/.test(enLaLinea)) continue;
    const args = argumentos(texto, m.index + m[0].length - 1);
    const literal = (/^\s*'([^']+)'/.exec(args) || /^\s*"([^"]+)"/.exec(args) || /\bfirma:\s*'([^']+)'/.exec(args) || [])[1] || null;
    let funcion = null;
    for (let k = n - 1; k >= 0 && !funcion; k--) funcion = (/^\s*(?:async\s+)?function\s+([\w$]+)\s*\(/.exec(lineas[k]) || [])[1] || null;
    out.push({ archivo: rel, linea: n, funcion, firma: literal, args, conAntes: /\bantes\b/.test(args) });
  }
  return out;
}

/** Lo que la prueba de cruce no deja pasar, uno por renglón. */
function problemasDelCruce(raiz, archivos) {
  const problemas = [];
  for (const rel of archivos) {
    for (const c of llamadasDe(raiz, rel)) {
      const donde = `${c.archivo}:${c.linea}`;
      if (c.firma) {
        if (pideAntes(c.firma) && !c.conAntes) problemas.push(`${donde} pide «${c.firma}» sin antes`);
        continue;
      }
      const fila = CALCULADAS_SUELTAS.find((s) => s.archivo === c.archivo && s.args.test(c.args)) || CALCULADAS[`${c.archivo}::${c.funcion}`];
      if (!fila) { problemas.push(`${donde} (${c.funcion}) pide una firma calculada que no está en la tabla de la prueba`); continue; }
      if (fila.delega) continue;
      const sinAntes = fila.firmas.filter(pideAntes);
      if (sinAntes.length && !c.conAntes) problemas.push(`${donde} (${c.funcion}) puede pedir ${sinAntes.join(', ')} sin antes`);
    }
  }
  return problemas;
}

test('T15 CrossCheck_EveryNoPersonSignatureHasBefore @story-8.255 @ac-13', (t) => {
  const archivos = archivosDelArbol(RAIZ);
  assert.ok(archivos.includes('skills/tycon-pipeline/scripts/marker.js') && archivos.includes('scripts/lib/owner-window.js'), 'recorre el árbol del arnés');
  // las llamadas de siempre se encuentran, con su firma
  const delMarker = llamadasDe(RAIZ, 'skills/tycon-pipeline/scripts/marker.js');
  for (const f of ['plan-approval', 'compare-waiver', 'save']) assert.ok(delMarker.some((c) => c.firma === f), `encuentra la llamada de ${f}`);
  assert.ok(!delMarker.some((c) => c.funcion === null), 'cada llamada sabe en qué función está');
  assert.deepStrictEqual(problemasDelCruce(RAIZ, archivos), [], 'toda firma que sale sin persona pasa su antes');
  // el verify de la consola no tiene llamadores
  const VERIFY_SIN_LLAMADORES = archivos.filter((rel) => rel !== 'scripts/lib/owner-window.js'
    && /verify --signature|'verify',\s*'--signature'/.test(fs.readFileSync(path.join(RAIZ, rel), 'utf8')));
  assert.deepStrictEqual(VERIFY_SIN_LLAMADORES, [], 'un llamador del verify de la consola necesita su fila en la tabla');
  // un archivo de juguete sin antes: la prueba lo nombra
  const juguete = fs.mkdtempSync(path.join(os.tmpdir(), 'cruce-'));
  t.after(() => fs.rmSync(juguete, { recursive: true, force: true }));
  fs.mkdirSync(path.join(juguete, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(juguete, 'scripts', 'nuevo.js'), [
    '// firmaDelDueno(\'save\', x) en un comentario no cuenta',
    'function hacer() {',
    '  const f = firmaDelDueno(\'compare-waiver\', \'eximir\');',
    '  const g = ow.exigir({ firma: elegida, argv });',
    '  return firmaDelDueno(\'critical-waiver\', \'nivel 2: no necesita antes\');',
    '}', ''].join('\n'));
  const p = problemasDelCruce(juguete, archivosDelArbol(juguete));
  assert.strictEqual(p.length, 2, p.join('\n'));
  assert.match(p[0], /scripts\/nuevo\.js:3 pide «compare-waiver» sin antes/);
  assert.match(p[1], /scripts\/nuevo\.js:4 \(hacer\) pide una firma calculada que no está en la tabla/);
});
