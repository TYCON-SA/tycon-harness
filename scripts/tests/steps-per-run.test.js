#!/usr/bin/env node
/**
 * steps-per-run.test.js — red de `scripts/metrics/steps-per-run.js`.
 *
 * Lo que fija, y por qué cada caso:
 *   · la mediana y los percentiles salen de las corridas MEDIDAS, no de todas;
 *   · una corrida sin consumo medido se cuenta aparte y NO se estima — «no pude preguntar» no es
 *     «no hay», que es la regla que el arnés ya se comió cara en dos medidores distintos;
 *   · la serie por mes existe (sin serie no hay forma de saber si una palanca sirvió);
 *   · un buzón vacío lo DICE en vez de publicar un cero, que es el mismo error con otra cara.
 *
 * Y desde la story 7.12, un piso más arriba: la FICHA que lo publica en el tablero de seis preguntas
 * (`pasosPorCorrida()` de dashboard.js) — denominador, fecha, serie, línea base y fuente declarada.
 *
 * Todo contra un buzón de mentira en un tmpdir: no se lee el buzón real.
 *
 * Correr: node scripts/tests/steps-per-run.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MOD = path.resolve(__dirname, '..', 'metrics', 'steps-per-run.js');

let n = 0;
let salteados = 0;
// 🔴 Un caso que no pudo correr NO es un «ok»: devuelve `salteado(motivo)`, sale con su palabra y se cuenta al pie.
//    Si saliera «ok», las dos ramas que simulan una carpeta sin permiso quedarían sin probar —el día que la suite
//    corra como root— sin que nadie lo note: el mismo silencio que esas ramas existen para evitar.
const salteado = (motivo) => ({ salteado: motivo });
function t(name, fn) {
  n++;
  try {
    const r = fn();
    if (r && r.salteado) { salteados++; console.log(`  SALTEADO ${n} - ${name}\n    ${r.salteado}`); }
    else console.log(`  ok ${n} - ${name}`);
  } catch (e) { console.error(`  FAIL ${n} - ${name}\n    ${e && e.message}`); process.exitCode = 1; }
}

function volcado(dir, { story, inicio, pasos, medido = true }) {
  const consumo = medido
    ? { estado: 'medido', respuestas: pasos, tokens: { in: 1, out: 2, cache_new: 3, cache_read: pasos * 1000 } }
    : { estado: 'no-medido', motivo: 'la conversación ya no está' };
  fs.writeFileSync(path.join(dir, `${story}-${inicio}.json`), JSON.stringify({
    archivedAt: `${inicio}T10:00:00.000Z`,
    marker: { storyId: story, repoPath: '/tmp/repo-falso', startedAt: `${inicio}T04:00:00.000Z` },
    consumo,
  }));
}

function escenario() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pasos-'));
  const b = path.join(tmp, 'buzon', 'maquina-1');
  fs.mkdirSync(b, { recursive: true });
  volcado(b, { story: '1.1', inicio: '2026-08-10', pasos: 100 });
  volcado(b, { story: '1.2', inicio: '2026-08-20', pasos: 300 });
  volcado(b, { story: '1.3', inicio: '2026-09-05', pasos: 500 });
  volcado(b, { story: '1.4', inicio: '2026-09-15', pasos: 700 });
  volcado(b, { story: '1.5', inicio: '2026-09-18', pasos: 0, medido: false });
  return path.join(tmp, 'buzon');
}

t('la mediana y los percentiles salen de las corridas medidas', () => {
  const { medir } = require(MOD);
  const r = medir({ buzon: escenario() });
  assert.strictEqual(r.corridas, 4, 'cuatro corridas con consumo medido');
  assert.strictEqual(r.pasos.mediana, 400, 'mediana de 100/300/500/700');
  assert.strictEqual(r.pasos.min, 100);
  assert.strictEqual(r.pasos.max, 700);
  assert.ok(r.pasos.p25 < r.pasos.mediana && r.pasos.mediana < r.pasos.p75, 'los percentiles ordenan');
});

t('una corrida sin consumo medido se cuenta aparte y NO se estima', () => {
  // 🔴 La regla que el arnés ya pagó dos veces: un dato que no se pudo leer no vale cero ni se
  // promedia con los demás. Si entrara al cociente, bajaría la mediana y nadie sabría por qué.
  const { medir, resumen } = require(MOD);
  const r = medir({ buzon: escenario() });
  assert.strictEqual(r.sin_medir, 1, 'la corrida sin medir se cuenta');
  assert.ok(!r.filas.some((f) => f.story === '1.5'), 'y no entra en las filas');
  assert.ok(/sin medir/i.test(resumen(r)), 'y el resumen lo dice');
});

t('hay serie por mes — sin serie no se puede saber si una palanca sirvió', () => {
  const { medir } = require(MOD);
  const r = medir({ buzon: escenario() });
  const meses = r.por_mes.map((m) => m.mes);
  assert.deepStrictEqual(meses, ['2026-08', '2026-09'], 'un punto por mes, ordenado');
  assert.strictEqual(r.por_mes[0].n, 2);
  assert.strictEqual(r.por_mes[1].mediana, 600, 'mediana de septiembre: 500 y 700');
});

t('un buzón vacío lo DICE en vez de publicar un cero', () => {
  const { medir, resumen } = require(MOD);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pasos-vacio-'));
  fs.mkdirSync(path.join(tmp, 'buzon'), { recursive: true });
  const r = medir({ buzon: path.join(tmp, 'buzon') });
  assert.strictEqual(r.corridas, 0);
  assert.strictEqual(r.pasos.mediana, null, 'sin corridas no hay mediana: null, no 0');
  assert.ok(/no hay línea base/i.test(resumen(r)), 'y el resumen lo declara');
});

t('el medidor sólo LEE: no toca el buzón', () => {
  const { medir } = require(MOD);
  const b = escenario();
  const huella = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((it) => {
    const p = path.join(d, it.name);
    return it.isDirectory() ? huella(p) : [`${p}:${fs.statSync(p).size}:${fs.statSync(p).mtimeMs}`];
  }).sort();
  const antes = huella(b);
  medir({ buzon: b });
  assert.deepStrictEqual(huella(b), antes, 'ningún archivo del buzón cambió');
});

// ─────────────── story 7.12: el medidor, cableado al tablero de seis preguntas ───────────────
// Lo que sigue ya no prueba al medidor sino a quien lo PUBLICA: `pasosPorCorrida()` de dashboard.js, que
// arma la ficha. Las mismas reglas, un piso más arriba — y es donde se rompen: el medidor puede
// devolver `null` y la página dibujar igual un cero.
const TABLERO = path.resolve(__dirname, '..', 'nightly', 'dashboard', 'dashboard.js');
const FUENTES = path.resolve(__dirname, '..', 'nightly', 'dashboard', 'sources.json');
const cfgReal = () => JSON.parse(fs.readFileSync(FUENTES, 'utf8'));
// «hoy» fijo: el escenario es de agosto-septiembre de 2026 y la fuente declara una antigüedad máxima.
const HOY = Date.parse('2026-09-20T12:00:00Z');

t('@story-7.12 @ac-2 NoMedidasSeCuentanAparte — la ficha las cuenta aparte, no entran en la mediana, y lo dice', () => {
  // 🔴 rojo previo: armar el denominador con `r.corridas` solo → la sin medir desaparece en silencio.
  const { pasosPorCorrida } = require(TABLERO);
  const f = pasosPorCorrida(cfgReal(), { estado: 'no_aplica' }, { dir: escenario(), hoy: HOY });
  assert.strictEqual(f.estado, 'medido');
  assert.strictEqual(f.valor, 400, 'la mediana sale de las 4 medidas (100/300/500/700), no de las 5');
  assert.strictEqual(f.medidos, 4, 'n = las que tienen consumo medido');
  assert.strictEqual(f.total, 5, 'de N = todas las corridas del buzón: la sin medir sigue en el denominador');
  assert.ok(/1 sin consumo medido/.test(f.detalle), `el detalle tiene que decir cuántas quedaron afuera — dice: ${f.detalle}`);
});

t('@story-7.12 @ac-4 SerieMensual — un punto por mes, con su mediana y su n', () => {
  // 🔴 rojo previo: publicar sólo la mediana global → no hay contra qué comparar la línea base.
  const { pasosPorCorrida } = require(TABLERO);
  const f = pasosPorCorrida(cfgReal(), { estado: 'no_aplica' }, { dir: escenario(), hoy: HOY });
  assert.deepStrictEqual(f.serie, [{ mes: '2026-08', n: 2, mediana: 200 }, { mes: '2026-09', n: 2, mediana: 600 }]);
  assert.ok(/2026-08: 200 \(n=2\)/.test(f.detalle) && /2026-09: 600 \(n=2\)/.test(f.detalle), `la serie tiene que verse en la ficha — dice: ${f.detalle}`);
});

t('@story-7.12 @ac-3 la ficha trae la fecha del número y la línea base contra la que se compara', () => {
  // 🔴 rojo previo: tipear «345» en el template → envejece sin que nadie lo note (y C-13 de dashboard.test.sh lo caza).
  const { pasosPorCorrida } = require(TABLERO);
  const { LINEA_BASE } = require(MOD);
  assert.strictEqual(LINEA_BASE.mediana, 345);
  assert.strictEqual(LINEA_BASE.fecha, '2026-09-20');
  const f = pasosPorCorrida(cfgReal(), { estado: 'no_aplica' }, { dir: escenario(), hoy: HOY });
  assert.strictEqual(f.fecha, '2026-09-15', 'la fecha del número es la de la corrida medida más nueva');
  assert.ok(f.detalle.includes('2026-09-15'), 'y se ve en la ficha');
  assert.ok(f.detalle.includes(`${LINEA_BASE.mediana}`) && f.detalle.includes(LINEA_BASE.fecha), 'la línea base sale del medidor, con su fecha');
  assert.ok(new RegExp(`${LINEA_BASE.mediana}`).test(fs.readFileSync(MOD, 'utf8').split("'use strict'")[0]), 'y está escrita en la cabecera del medidor (Task 6)');
});

t('@story-7.12 @ac-5 BuzonVacioNoEsCero — «no medido» con su motivo; ningún cero publicado', () => {
  // 🔴 rojo previo: `medida(r.pasos.mediana || 0, …)` → un buzón vacío publica «0 pasos».
  const { pasosPorCorrida } = require(TABLERO);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pasos-vacio-'));
  fs.mkdirSync(path.join(tmp, 'buzon'), { recursive: true });
  const vacio = pasosPorCorrida(cfgReal(), { estado: 'no_aplica' }, { dir: path.join(tmp, 'buzon'), hoy: HOY });
  assert.strictEqual(vacio.estado, 'no_medido');
  assert.strictEqual(vacio.valor, null, 'null, no 0');
  assert.ok(vacio.motivo && /buzón/i.test(vacio.motivo), `el motivo se dice — dice: ${vacio.motivo}`);

  // Y el otro borde: hay corridas, pero NINGUNA medida. Tampoco es cero, y dice cuántas hay.
  const b = path.join(tmp, 'sin-medir', 'maquina-1');
  fs.mkdirSync(b, { recursive: true });
  volcado(b, { story: '9.1', inicio: '2026-09-10', pasos: 0, medido: false });
  volcado(b, { story: '9.2', inicio: '2026-09-11', pasos: 0, medido: false });
  const sinMedir = pasosPorCorrida(cfgReal(), { estado: 'no_aplica' }, { dir: path.join(tmp, 'sin-medir'), hoy: HOY });
  assert.strictEqual(sinMedir.estado, 'no_medido');
  assert.strictEqual(sinMedir.valor, null);
  assert.ok(/2 corrida/.test(sinMedir.motivo), `dice cuántas hay sin medir — dice: ${sinMedir.motivo}`);

  // Y el tercero: la carpeta del buzón ni existe (una máquina sin permiso de lectura).
  const ausente = pasosPorCorrida(cfgReal(), { estado: 'no_aplica' }, { dir: path.join(tmp, 'no-existe'), hoy: HOY });
  assert.strictEqual(ausente.estado, 'no_medido');
  assert.ok(/no está/i.test(ausente.motivo), `una carpeta ausente no es un buzón vacío — dice: ${ausente.motivo}`);
});

t('@story-7.12 @ac-6 FuenteDeclarada — sin la entrada en sources.json, la ficha lo reporta en vez de leer igual', () => {
  // 🔴 rojo previo: leer el buzón por su ruta fija, sin mirar la lista → sacar la entrada no cambia nada.
  const { pasosPorCorrida } = require(TABLERO);
  const real = cfgReal();
  const f = real.sources.find((x) => x.id === 'pasos-corrida');
  assert.ok(f, 'sources.json declara la fuente «pasos-corrida»');
  assert.ok(Number.isFinite(f.max_age_days) && f.max_age_days > 0, 'con su antigüedad máxima');
  assert.strictEqual(f.required, false, 'no obligatoria: una máquina sin buzón no rompe el tablero');

  const sinEntrada = { ...real, sources: real.sources.filter((x) => x.id !== 'pasos-corrida') };
  const r = pasosPorCorrida(sinEntrada, { estado: 'no_aplica' }, { dir: escenario(), hoy: HOY });
  assert.strictEqual(r.estado, 'no_medido', 'con el buzón lleno y la fuente sin declarar, NO se mide');
  assert.ok(/no está declarada/i.test(r.motivo), `y dice por qué — dice: ${r.motivo}`);

  // La antigüedad máxima tiene dientes: pasado el umbral, el número se calla (una foto vieja tranquiliza).
  const viejo = pasosPorCorrida(real, { estado: 'no_aplica' }, { dir: escenario(), hoy: HOY + (f.max_age_days + 10) * 86400000 });
  assert.strictEqual(viejo.estado, 'no_medido');
  assert.ok(/2026-09-15/.test(viejo.motivo), `y dice desde cuándo no hay corridas medidas — dice: ${viejo.motivo}`);
});

t('@story-7.12 @ac-3 en el nocturno, sin el buzón leído entero, la ficha dice que no lo pudo leer', () => {
  // 🔴 rojo previo: en el nocturno caer al buzón por defecto del agente → «buzón vacío» en vez de «no pude leer».
  const { pasosPorCorrida } = require(TABLERO);
  const r = pasosPorCorrida(cfgReal(), { estado: 'no_leido', motivo: 'sin red o sin respuesta del buzón' }, { dir: escenario(), hoy: HOY, nocturno: true });
  assert.strictEqual(r.estado, 'no_medido');
  assert.ok(/no pudo leer el buzón/.test(r.motivo));
});

// ─────────────── lo que NO se pudo leer se cuenta y se dice (revisión de fallos silenciosos, iter 1) ───────────────
// El medidor saltaba callado una carpeta sin permiso y un volcado cortado: la ficha publicaba la mediana «del
// equipo» faltándole una máquina, con un denominador más chico, sin rastro. «No pude preguntar» no es «no hay».
const sinPermiso = (dir, fn) => { fs.chmodSync(dir, 0o000); try { return fn(); } finally { fs.chmodSync(dir, 0o755); } };
// A root el chmod no lo frena: esos dos casos se SALTEAN y lo dicen (no salen «ok»). Los agentes del nocturno
// (Azure, ubuntu-latest sin contenedor) no corren como root, así que hoy las dos ramas se prueban de verdad ahí.
const esRoot = typeof process.getuid === 'function' && process.getuid() === 0;

t('@story-7.12 @ac-2 una carpeta de máquina que no se puede leer se CUENTA, y la ficha se calla en vez de publicar sin ella', () => {
  // 🔴 rojo previo: `catch (_e) { return out; }` en caminar() → la máquina desaparece y sale un número igual.
  if (esRoot) return salteado('corriendo como root: chmod 000 no le quita la lectura, la rama «carpeta de máquina ilegible» NO se probó');
  const { medir } = require(MOD);
  const { pasosPorCorrida } = require(TABLERO);
  const b = escenario();
  const otra = path.join(b, 'maquina-2'); fs.mkdirSync(otra);
  volcado(otra, { story: '2.1', inicio: '2026-09-12', pasos: 9000 });
  sinPermiso(otra, () => {
    const r = medir({ buzon: b });
    assert.strictEqual(r.carpetas_ilegibles, 1, 'el medidor cuenta la carpeta que no pudo leer');
    assert.strictEqual(r.corridas, 4, 'y no inventa sus corridas');
    const f = pasosPorCorrida(cfgReal(), { estado: 'no_aplica' }, { dir: b, hoy: HOY });
    assert.strictEqual(f.estado, 'no_medido', 'sin una máquina, la mediana no es la del equipo: no se publica');
    assert.ok(/1 carpeta/.test(f.motivo) && /no se pud/.test(f.motivo), `y dice por qué — dice: ${f.motivo}`);
  });
});

t('@story-7.12 @ac-5 un buzón que EXISTE pero no se puede leer no es un buzón vacío', () => {
  // 🔴 rojo previo: existsSync da true, caminar() traga el EACCES → «el buzón está vacío», que es falso.
  if (esRoot) return salteado('corriendo como root: chmod 000 no le quita la lectura, la rama «buzón ilegible» NO se probó');
  const { medir } = require(MOD);
  const { pasosPorCorrida } = require(TABLERO);
  const b = escenario();
  sinPermiso(b, () => {
    const r = medir({ buzon: b });
    assert.strictEqual(r.legible, false, 'el medidor dice que no pudo leer la carpeta');
    assert.strictEqual(r.motivo_ilegible, 'EACCES', 'con el código del error, nunca su mensaje (trae rutas)');
    const f = pasosPorCorrida(cfgReal(), { estado: 'no_aplica' }, { dir: b, hoy: HOY });
    assert.strictEqual(f.estado, 'no_medido');
    assert.ok(/no se pudo leer/.test(f.motivo) && !/está vacío/.test(f.motivo), `no afirma que está vacío — dice: ${f.motivo}`);
    assert.ok(!f.motivo.includes(b), 'y el motivo no publica la ruta del disco');
  });
});

t('@story-7.12 @ac-2 un volcado cortado (JSON roto) sigue en el denominador y se dice; uno que no es un volcado, no cuenta', () => {
  // 🔴 rojo previo: `catch (_e) { continue; }` → el volcado desaparece de N sin contarse ni como «sin medir».
  const { medir } = require(MOD);
  const { pasosPorCorrida } = require(TABLERO);
  const b = escenario(); const m1 = path.join(b, 'maquina-1');
  fs.writeFileSync(path.join(m1, '1.9-2026-09-19.json'), '{"archivedAt":"2026-09-19T10:00:00.000Z","marker":{"storyId":"1.9"');   // subida cortada
  fs.writeFileSync(path.join(m1, 'cobertura.json'), JSON.stringify({ maquina: 'maquina-1', archivos: 3 }));   // JSON sano que NO es un volcado
  const r = medir({ buzon: b });
  assert.strictEqual(r.ilegibles, 1, 'el volcado cortado se cuenta');
  assert.strictEqual(r.corridas, 4); assert.strictEqual(r.sin_medir, 1, 'y cobertura.json no es una corrida: ni medida ni sin medir');
  const f = pasosPorCorrida(cfgReal(), { estado: 'no_aplica' }, { dir: b, hoy: HOY });
  assert.strictEqual(f.estado, 'medido'); assert.strictEqual(f.valor, 400);
  assert.strictEqual(f.total, 6, 'N = 4 medidas + 1 sin medir + 1 ilegible: no desaparece del denominador');
  assert.ok(/1 volcado\(s\) no se pudieron leer/.test(f.detalle), `y se dice — dice: ${f.detalle}`);
  assert.ok(/no se pudieron leer/.test(require(MOD).resumen(r)), 'y el resumen de consola también lo dice');
});

t('@story-7.12 @ac-6 una antigüedad máxima mal declarada NO apaga el control en silencio', () => {
  // 🔴 rojo previo: `Number.isFinite(max) && …` → con null o "14" el control de vejez se saltea entero y publica.
  const { pasosPorCorrida } = require(TABLERO);
  const real = cfgReal();
  for (const malo of [null, '14', -1, 0, undefined]) {
    const cfg = { ...real, sources: real.sources.map((x) => (x.id === 'pasos-corrida' ? { ...x, max_age_days: malo } : x)) };
    const f = pasosPorCorrida(cfg, { estado: 'no_aplica' }, { dir: escenario(), hoy: HOY + 400 * 86400000 });
    assert.strictEqual(f.estado, 'no_medido', `max_age_days=${JSON.stringify(malo)} y publicó igual, con la última corrida de hace más de un año`);
    assert.ok(/antigüedad máxima/.test(f.motivo), `dice qué está mal declarado — dice: ${f.motivo}`);
  }
});

t('@story-7.12 el motivo de una falla de carga nunca publica el mensaje del error (trae rutas del disco)', () => {
  // 🔴 rojo previo: `${e.code || e.message}` → un SyntaxError del medidor publica su mensaje en la página commiteada.
  const fuente = fs.readFileSync(TABLERO, 'utf8');
  const fn = fuente.slice(fuente.indexOf('function pasosPorCorrida('), fuente.indexOf('const ETIQUETA_ESTADO'));
  assert.ok(fn.length > 500, 'no encontré pasosPorCorrida() para mirarla');
  assert.ok(!/e\.message/.test(fn), 'pasosPorCorrida() interpola e.message en un motivo que va a la página');
});

t('@story-7.12 @ac-4 sin línea base, la vista de corridas lo DICE (con su motivo) en vez de no dibujarla y listo', () => {
  // 🔴 rojo previo: `catch (e) {}` → null → el cliente omite la línea y la frase: «no pude cargarla» se ve igual que «no hay».
  const corridas = require(path.resolve(__dirname, '..', 'nightly', 'dashboard', 'runs.js'));
  assert.strictEqual(typeof corridas.lineaBasePasos, 'function', 'runs.js exporta lineaBasePasos()');
  const ok = corridas.lineaBasePasos();
  assert.strictEqual(ok.estado, 'medida'); assert.strictEqual(ok.mediana, require(MOD).LINEA_BASE.mediana);
  const roto = corridas.lineaBasePasos(path.join(os.tmpdir(), 'no-existe-este-medidor.js'));
  assert.strictEqual(roto.estado, 'sin_linea_base');
  assert.ok(roto.motivo && /MODULE_NOT_FOUND/.test(roto.motivo), `con el código del error — dice: ${roto.motivo}`);
  assert.ok(!roto.motivo.includes(os.tmpdir()), 'y sin la ruta del disco');
  const malo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lb-')), 'medidor-malo.js');
  fs.writeFileSync(malo, "module.exports = { LINEA_BASE: { mediana: 345, fecha: 'ayer' } };");
  assert.strictEqual(corridas.lineaBasePasos(malo).estado, 'sin_linea_base', 'una fecha que no es una fecha tampoco vale');
});

// ─────────────── los dos hallazgos que el pase adversarial CONFIRMÓ corriendo el código (2026-09-20) ───────────────
// Sus pruebas originales quedaron en la carpeta de la corrida (step-05b-probes/); éstas son las de regresión.

t('@story-7.12 @ac-2 [adversarial] una carpeta de máquina que es un ENLACE se recorre; un enlace roto se cuenta', () => {
  // 🔴 rojo previo: `it.isDirectory()` del Dirent da false para un enlace → la máquina entera se saltea, sin contarse
  //    ni como corrida ni como «sin medir». runs.js ya lo resolvía (statSync); el medidor nuevo no.
  const { medir } = require(MOD);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pasos-enlace-'));
  const real = path.join(tmp, 'real-maquina'); fs.mkdirSync(real);
  volcado(real, { story: '3.1', inicio: '2026-09-10', pasos: 999 });
  const b = path.join(tmp, 'buzon'); fs.mkdirSync(b);
  fs.symlinkSync(real, path.join(b, 'maquina-enlace'), 'dir');
  let r = medir({ buzon: b });
  assert.strictEqual(r.corridas, 1, 'la corrida detrás del enlace se cuenta');
  assert.strictEqual(r.pasos.mediana, 999);
  // Un volcado suelto que es un enlace a un archivo también se lee.
  fs.symlinkSync(path.join(real, '3.1-2026-09-10.json'), path.join(b, 'suelto.json'), 'file');
  assert.strictEqual(medir({ buzon: b }).corridas, 2, 'un volcado enlazado también es un volcado');
  // Y un enlace ROTO no desaparece: no se sabe qué había, así que se cuenta como carpeta que no se pudo leer.
  fs.symlinkSync(path.join(tmp, 'no-existe'), path.join(b, 'maquina-rota'), 'dir');
  r = medir({ buzon: b });
  assert.strictEqual(r.carpetas_ilegibles, 1, 'el enlace roto se cuenta');
  // Un enlace que vuelve sobre el propio buzón no cuelga el recorrido ni duplica corridas.
  fs.unlinkSync(path.join(b, 'maquina-rota'));
  fs.symlinkSync(b, path.join(b, 'vuelta'), 'dir');
  r = medir({ buzon: b });
  assert.strictEqual(r.corridas, 2, `un ciclo de enlaces no duplica — dio ${r.corridas}`);
});

t('@story-7.12 @ac-2 [adversarial] un `respuestas` absurdo (negativo, infinito, texto) NO es una corrida medida', () => {
  // 🔴 rojo previo: `if (!pasos)` sólo atrapa 0/null/NaN — un negativo es «verdadero» en JS y entraba a la mediana.
  //    El cliente de runs.js ya exigía `> 0`; los dos lados decían tener «el mismo criterio» y no lo tenían.
  const { medir } = require(MOD);
  const { pasosPorCorrida } = require(TABLERO);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pasos-neg-'));
  const b = path.join(tmp, 'buzon', 'maquina-1'); fs.mkdirSync(b, { recursive: true });
  volcado(b, { story: '1.1', inicio: '2026-09-01', pasos: 300 });
  volcado(b, { story: '1.2', inicio: '2026-09-05', pasos: 310 });
  volcado(b, { story: '1.3', inicio: '2026-09-10', pasos: 320 });
  volcado(b, { story: '1.4', inicio: '2026-09-15', pasos: -999999 });
  volcado(b, { story: '1.5', inicio: '2026-09-16', pasos: '350' });
  volcado(b, { story: '1.6', inicio: '2026-09-17', pasos: 1e400 });   // Infinity → JSON lo escribe null
  volcado(b, { story: '1.7', inicio: '2026-09-18', pasos: 12.5 });    // media respuesta no existe
  const r = medir({ buzon: path.join(tmp, 'buzon') });
  assert.strictEqual(r.corridas, 3, `sólo las tres sanas son medidas — dio ${r.corridas}`);
  assert.strictEqual(r.sin_medir, 4, 'las absurdas se cuentan aparte, no desaparecen');
  assert.strictEqual(r.pasos.mediana, 310); assert.strictEqual(r.pasos.min, 300, 'y el mínimo no es -999999');
  const f = pasosPorCorrida(cfgReal(), { estado: 'no_aplica' }, { dir: path.join(tmp, 'buzon'), hoy: HOY });
  assert.strictEqual(f.valor, 310); assert.strictEqual(f.medidos, 3); assert.strictEqual(f.total, 7);
});

t('@story-7.12 @ac-7 MapaLoIncluye — el medidor figura en el mapa, con su archivo y dónde corre', () => {
  // 🔴 rojo previo: cablear el medidor y no anotarlo → el mapa se ve completo y no lo es (el censo lo caza).
  const RAIZ = path.resolve(__dirname, '..', '..');
  // El mapa del arnés y su censo viven en el repo de mantenimiento (el árbol armado de los nocturnos los trae); el
  // público no los publica. Sin ellos este caso no puede mirar nada, y se dice: SALTEADO con su motivo, nunca verde.
  // Para medir contra un mapa en otra ruta: TYCON_HARNESS_MAP=<ruta del .html>.
  const rutaMapa = process.env.TYCON_HARNESS_MAP ? path.resolve(process.env.TYCON_HARNESS_MAP) : path.join(RAIZ, 'artifacts', 'mapa-arnes.html');
  const censo = path.join(RAIZ, 'scripts', 'tools', 'harness-map', 'census.js');
  const faltan = [rutaMapa, censo].filter((x) => !fs.existsSync(x));
  if (faltan.length) return { salteado: `NO MEDIDO: no está ${faltan.map((x) => path.relative(RAIZ, x)).join(' ni ')} (el mapa vive en el repo de mantenimiento)` };
  const mapa = fs.readFileSync(rutaMapa, 'utf8');
  const fichas = [...mapa.matchAll(/^\s*"[\w-]+": (\{"capa".*\}),?\s*$/gm)].map((m) => JSON.parse(m[1]));
  const f = fichas.find((x) => (x.archivos || []).some((a) => a[1] === 'scripts/metrics/steps-per-run.js'));
  assert.ok(f, 'ninguna ficha del mapa cita scripts/metrics/steps-per-run.js en «Repo y archivo»');
  assert.ok(f.donde && f.cuando, 'la ficha que lo cita dice dónde corre y cuándo');
  assert.ok(/pasos/i.test(f.por), `y su descripción nombra lo que mide — dice: ${f.por}`);
  // Y el censo, que es el control de verdad, ya no lo lista entre las piezas sin lugar.
  // las skills, como en todo el arnés (TYCON_SKILLS_DIR › el propio clon si es unido › las instaladas): el censo las pide
  const skills = require('../lib/skills-dir.js').resolveSkillsDirs(process.env.TYCON_SKILLS_DIR).skills;
  const r = require('child_process').spawnSync(process.execPath, [censo, '--map', rutaMapa, '--skills', skills], { encoding: 'utf8' });
  assert.notStrictEqual(r.status, 2, `el censo no pudo medir: ${r.stderr}`);
  // que haya corrido de verdad: un `Cannot find module` también sale 1 y no nombra al medidor (pase adversarial de la
  // story 8.12, R4: el censo se mudó y esta prueba daba verde sin medir nada)
  assert.ok(/censo del mapa/.test(`${r.stdout}${r.stderr}`), `el censo no corrió (status ${r.status}): ${r.stderr.slice(0, 300)}`);
  assert.ok(!/steps-per-run\.js/.test(`${r.stdout}${r.stderr}`),'el censo sigue listando al medidor como pieza sin lugar');
});

console.log(`\n${n} casos, ${process.exitCode ? 'CON FALLAS' : salteados ? `${n - salteados} verdes y ${salteados} SALTEADO(S) — ramas sin probar, ver arriba` : 'todos verdes'}`);
