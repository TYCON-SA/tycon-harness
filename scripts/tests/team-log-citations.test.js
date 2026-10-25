'use strict';

/**
 * team-log-citations.test.js — el árbol que se publica no cita el registro de incidentes del equipo.
 *
 * El registro vive en el repo del equipo: desde afuera una cita a él no lleva a nada. Lo que el texto necesitaba decir (el
 * motivo de un control, el porqué de un caso) se dice en presente, en el mismo lugar.
 *
 * Lo que no se puede perder:
 *   · Que ningún archivo versionado (código, datos, guías) nombre el registro fuera de la lista de excepciones.
 *   · Que cada excepción sea UNA cita, con su archivo, el texto exacto del renglón y el motivo: nunca una carpeta ni un
 *     archivo entero.
 *   · Que una excepción que ya no coincide con ningún renglón haga fallar la prueba: la lista no junta polvo.
 *
 * Las excepciones son tres familias: la forma del registro en el freno de historia interna y sus pruebas (el freno tiene
 * que seguir reconociéndola), los archivos del freno de producción (se copian a /opt/tycon y no se tocan), y las pruebas
 * que leen el registro real con el perfil del equipo y en el público se saltean.
 *
 * El nombre del registro se escribe por partes: este archivo también se publica.
 *
 * Uso: node --test scripts/tests/team-log-citations.test.js
 */
// stable-data: los commits de juguete van por `lab.git` del laboratorio, que fija sus fechas y apaga el mantenimiento.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const NAME = ['incident', 'log'].join('-');
const ALLOWED_REL = 'scripts/tests/fixtures/team-log-citations-allowed.json';
const ALLOWED = path.join(RAIZ, ALLOWED_REL);

/**
 * Cada renglón versionado que nombra el registro: `{ file, line, text }`. En el árbol armado de los nocturnos (lo privado
 * con el público encima) sólo cuenta lo que viaja al público: lo que trajo la superposición.
 */
function citations(root = RAIZ) {
  let out = '';
  try {
    // sin comillas ni escapes en las rutas con tilde: se comparan con las de la superposición, que vienen crudas
    out = execFileSync('git', ['-C', root, '-c', 'core.quotePath=false', 'grep', '-n','-I', '--fixed-strings', NAME], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (e.status === 1) return []; // git grep sale 1 cuando no encuentra nada
    throw e;
  }
  const { broughtByOverlay, OVERLAY_COMPUTED } = require(path.join(RAIZ, 'scripts', 'publishing', 'internal-history.js'));
  const brought = broughtByOverlay(root);
  if (brought && brought.size === 0) throw new Error('la superposición no trajo nada: no hay qué medir');
  // en el árbol armado, los registros que calcula la superposición nombran suites privadas: no son una cita del público
  if (brought) for (const f of OVERLAY_COMPUTED) brought.delete(f);
  // la lista de excepciones nombra el registro en cada entrada: es la lista, no una cita
  return out.split('\n').filter(Boolean).map((l) => {
    const m = /^([^:]+):(\d+):(.*)$/.exec(l);
    return { file: m[1], line: Number(m[2]), text: m[3] };
  }).filter((c) => c.file !== ALLOWED_REL && (!brought || brought.has(c.file)));
}

const allowed = JSON.parse(fs.readFileSync(ALLOWED, 'utf8')).allowed;

test('T15 PublicTree_NoIncidentLogCitation @story-8.43 @ac-13 — el árbol no nombra el registro fuera de la lista de excepciones', () => {
  const pending = allowed.map((a) => ({ ...a, used: false }));
  const loose = [];
  for (const c of citations()) {
    const hit = pending.find((a) => !a.used && a.file === c.file && c.text.includes(a.text));
    if (hit) hit.used = true;
    else loose.push(`${c.file}:${c.line}: ${c.text.trim().slice(0, 120)}`);
  }
  assert.deepStrictEqual(loose, [], 'citas al registro fuera de la lista: se reescriben sin la cita, o se declaran con su motivo');
  assert.deepStrictEqual(staleAllowed(RAIZ, pending), [], 'excepciones que ya no coinciden con ningún renglón: se sacan de la lista');
});

/** Las excepciones sin uso; en el árbol armado, la de un archivo donde el privado conserva el suyo no se midió: no está vieja. */
function staleAllowed(root, pending) {
  const brought = require(path.join(RAIZ, 'scripts', 'publishing', 'internal-history.js')).broughtByOverlay(root);
  return pending.filter((a) => !a.used && (!brought || brought.has(a.file))).map((a) => `${a.file}: «${a.text}»`);
}

test('T15e PublicTree_PrivateOwnFileException_NotStale @story-8.128 @ac-6 — en el árbol armado, la excepción de un archivo que el privado conserva no está vieja', (t) => {
  // 🔴 rojo: el privado conserva su guía, la cita del público no se mide, y la excepción salía vieja
  const { overlayLab } = require('./lib/overlay-lab.js');
  const lab = overlayLab({ privado: { 'guides/propia.md': 'sin cita\n' }, publico: { 'scripts/x.js': '// nada\n' } });
  t.after(lab.cleanup);
  const pending = [{ file: 'guides/propia.md', text: NAME, used: false }];
  assert.deepStrictEqual(staleAllowed(lab.root, pending), [], 'el archivo del privado no se midió');
  lab.git(['checkout', '--quiet', lab.tip]);
  assert.deepStrictEqual(staleAllowed(lab.root, pending), [`guides/propia.md: «${NAME}»`], 'sin superposición, la excepción sin uso está vieja');
});

test('T15c PublicTree_CitationOnlyInPrivate_DoesNotCount @story-8.112 @ac-3 — en el árbol armado, una cita sólo del privado no cuenta', (t) => {
  // 🔴 rojo: una tarea del privado que cita el registro pone en rojo una prueba del público
  const { overlayLab } = require('./lib/overlay-lab.js');
  const lab = overlayLab({ privado: { 'tasks/plan.md': `ver el ${NAME} del equipo\n` }, publico: { 'scripts/x.js': `// ver el ${NAME}\n`, 'guides/configuración.md': `ver el ${NAME}\n` } });
  t.after(lab.cleanup);
  assert.deepStrictEqual(citations(lab.root).map((c) => c.file).sort(), ['guides/configuración.md', 'scripts/x.js'], 'sólo cuenta lo que trajo el público, también con tilde en la ruta');
  lab.git(['checkout', '--quiet', lab.tip]);
  assert.deepStrictEqual(citations(lab.root).map((c) => c.file), ['tasks/plan.md'], 'sin superposición, el árbol entero');
});

test('T15d PublicTree_OverlayComputedRegistries_DoNotCount @story-8.128 @ac-2 — en el árbol armado, los registros que calcula la superposición no cuentan', (t) => {
  // 🔴 rojo: el registro de suites calculado nombra una suite privada y pone en rojo la noche
  const { overlayLab } = require('./lib/overlay-lab.js');
  const lab = overlayLab({ privado: { 'scripts/tests/suites.json': '{}\n' }, publico: { 'scripts/tests/suites.json': `{ "ruta": "tests/${NAME}.test.js" }\n`, 'scripts/x.js': `// ver el ${NAME}\n` } });
  t.after(lab.cleanup);
  assert.deepStrictEqual(citations(lab.root).map((c) => c.file), ['scripts/x.js'], 'el registro calculado no cuenta');
  lab.git(['checkout', '--quiet', lab.tip]);
  fs.writeFileSync(path.join(lab.root, 'scripts', 'tests', 'suites.json'), `{ "ruta": "tests/${NAME}.test.js" }\n`);
  lab.git(['commit', '--quiet', '-am', 'registro a mano']);
  assert.deepStrictEqual(citations(lab.root).map((c) => c.file), ['scripts/tests/suites.json'], 'sin superposición, el registro cuenta como siempre');
});

test('T15b IncidentLogAllowed_OneCitationEach @story-8.43 @ac-13 — cada excepción es una cita con su texto y su motivo', () => {
  for (const a of allowed) {
    assert.ok(a.file && !a.file.endsWith('/'), `una excepción nombra un archivo, nunca una carpeta: ${JSON.stringify(a)}`);
    assert.ok(typeof a.text === 'string' && a.text.includes(NAME), `el texto de la excepción contiene la cita: ${a.file}`);
    assert.ok(typeof a.reason === 'string' && a.reason.length >= 20, `la excepción dice su motivo: ${a.file}`);
  }
});
