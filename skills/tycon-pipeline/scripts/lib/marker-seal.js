'use strict';
/**
 * marker-seal — la única escritura del marcador de una sesión y su sello (@story-8.121).
 *
 * Cada escritura legítima del marcador (`<estado>/active/<sesión>.json`) deja en `<estado>/seals/<sesión>.json` la huella
 * (sha256) de los bytes que escribió, la huella anterior y la hora. Con el candado de la sesión tomado
 * (`seals/<sesión>.lock`), escribe primero el sello y después el marcador. Antes de escribir compara: si el marcador en
 * disco no coincide con su sello, no escribe ni sella (lo cambió algo que no es el arnés), anota `marker-seal-mismatch`
 * en `gates.log` y devuelve el motivo. Así un gancho que escribe después de un cambio a mano no lo blanquea.
 *
 * `revisar` contesta si el marcador de una ejecución sellada coincide con su sello; lo pregunta `open-runs.perdida`, y lo
 * heredan la edición, la consola, el cierre de turno y el commit. La huella anterior vale sólo mientras una escritura
 * tiene el candado: dos procesos de la misma sesión no se cruzan, y volver el marcador una escritura atrás no pasa.
 *
 * `escritoresDelMarcador` busca en el código del arnés las funciones que escriben el marcador por fuera de esta librería.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stateDir } = require('./state-dir.js');

const ESPERA_MS = 2000;          // cuánto espera una escritura el candado de otra
const CANDADO_VIEJO_MS = 10000;  // un candado más viejo es de un proceso que murió
const HUERFANO_DIAS = 7;         // un sello sin marcador más viejo se poda

// la misma clave de archivo que el marcador (marker.js, on-edit.js, on-stop-dod-gate.js): una distinta frenaría sana
const clave = (sid) => String(sid || '_nosession').replace(/[/\\]/g, '_');
const estadoDe = (estado, home) => estado || stateDir(home || os.homedir());
const marcadorDe = (estado, sid) => path.join(estado, 'active', `${clave(sid)}.json`);
const selloDe = (estado, sid) => path.join(estado, 'seals', `${clave(sid)}.json`);
const candadoDe = (estado, sid) => path.join(estado, 'seals', `${clave(sid)}.lock`);
const huella = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function dormir(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** El sello de la sesión: `{ estado: 'ausente' }`, `{ estado: 'ilegible' }` o `{ estado: 'ok', sello }`. */
function leer({ sid, estado, home } = {}) {
  let txt;
  try { txt = fs.readFileSync(selloDe(estadoDe(estado, home), sid), 'utf8'); } catch (e) {
    return e && e.code === 'ENOENT' ? { estado: 'ausente' } : { estado: 'ilegible' };
  }
  let s;
  try { s = JSON.parse(txt); } catch { return { estado: 'ilegible' }; }
  if (!s || typeof s !== 'object' || typeof s.huella !== 'string') return { estado: 'ilegible' };
  return { estado: 'ok', sello: s };
}

/** ¿Una escritura tiene ahora el candado de la sesión? Sólo un candado reciente cuenta. */
function candadoReciente({ sid, estado, home, ahora = Date.now() } = {}) {
  try { return ahora - fs.statSync(candadoDe(estadoDe(estado, home), sid)).mtimeMs < CANDADO_VIEJO_MS; } catch { return false; }
}

// → { ok, roto } — `roto`: había un candado de un proceso que murió y se sacó
function tomarCandado(estado, sid) {
  const f = candadoDe(estado, sid);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const hasta = Date.now() + ESPERA_MS;
  let roto = false;
  for (;;) {
    try {
      const fd = fs.openSync(f, 'wx', 0o600);
      fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      fs.closeSync(fd);
      return { ok: true, roto };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return { ok: false, motivo: `no pude tomar el candado del sello (${(e && e.code) || e})` };
    }
    let viejo = false;
    try { viejo = Date.now() - fs.statSync(f).mtimeMs >= CANDADO_VIEJO_MS; } catch { continue; /* se soltó recién */ }
    if (viejo) {
      try { fs.unlinkSync(f); roto = true; } catch { /* otro lo sacó primero */ }
      continue;
    }
    if (Date.now() >= hasta) return { ok: false, motivo: `el candado del sello está tomado por otra escritura desde hace más de ${ESPERA_MS / 1000} s` };
    dormir(20);
  }
}

function soltarCandado(estado, sid) {
  try { fs.unlinkSync(candadoDe(estado, sid)); } catch { /* ya no estaba */ }
}

// ¿la apertura vigente de la sesión es de una ejecución sellada? Sólo se lee con un marcador sin sello: es raro
function aperturaSellada(estado, sid) {
  const or = require('./open-runs.js');
  const r = or.leerEventos(null, path.join(estado, 'gates.log'));
  if (!r.ok) return !r.ausente;   // un registro que no se lee no prueba que la ejecución sea de antes: ante la duda, sí
  const ult = or.vigente(sid, { eventos: r.eventos });
  return !!(ult && ult.name === 'run-open' && ult.sellado === true);
}

function anotarDesacuerdo(estado, sid, motivo) {
  try {
    fs.mkdirSync(estado, { recursive: true });
    fs.appendFileSync(path.join(estado, 'gates.log'), JSON.stringify({
      ts: new Date().toISOString(), sessionId: String(sid), name: 'marker-seal-mismatch', sesion: String(sid), motivo,
    }) + '\n', 'utf8');
  } catch { /* sin registro, la pregunta igual lo ve */ }
  return { ok: false, motivo };
}

function escribirAtomico(archivo, contenido, modo) {
  const tmp = `${archivo}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contenido, modo ? { mode: modo } : 'utf8');
  fs.renameSync(tmp, archivo);
}

/**
 * Escribe el marcador de la sesión (`marker`, como JSON con sangría, o `texto` tal cual) y su sello. → `{ ok: true, huella }`
 * o `{ ok: false, motivo }` sin escribir nada: el marcador en disco no coincide con su sello, el sello no se lee o es de
 * otra sesión, falta el sello de una ejecución sellada, o el candado no se pudo tomar.
 */
function escribir({ sid, estado, home, marker, texto } = {}) {
  const est = estadoDe(estado, home);
  const contenido = texto != null ? String(texto) : JSON.stringify(marker, null, 2) + '\n';
  const c = tomarCandado(est, sid);
  if (!c.ok) return anotarDesacuerdo(est, sid, c.motivo);
  try {
    const mp = marcadorDe(est, sid);
    let actual = null;
    try { actual = fs.readFileSync(mp); } catch (e) {
      if (!e || e.code !== 'ENOENT') return anotarDesacuerdo(est, sid, `el marcador no se puede leer (${(e && e.code) || e})`);
    }
    const s = leer({ sid, estado: est });
    if (actual !== null) {
      let problema = null;
      if (s.estado === 'ilegible') problema = 'el sello del marcador no se puede leer';
      else if (s.estado === 'ausente') problema = 'falta el sello del marcador de una ejecución sellada';
      else if (String(s.sello.sesion) !== String(sid)) problema = 'el sello del marcador es de otra sesión';
      else {
        const h = huella(actual);
        // la huella anterior, sólo si la escritura de antes murió entre el sello y el marcador (su candado era viejo)
        if (h !== s.sello.huella && !(c.roto && h === s.sello.previa)) problema = 'el marcador no coincide con su sello: se cambió por fuera del arnés';
      }
      // sólo una ejecución sellada se juzga por su sello (una de antes, o sin apertura, se escribe como siempre); el
      // registro se lee sólo en este caso, que es raro
      if (problema && aperturaSellada(est, sid)) return anotarDesacuerdo(est, sid, problema);
    }
    const nueva = huella(Buffer.from(contenido, 'utf8'));
    // una escritura que falla también queda en gates.log: los ganchos que escriben no frenan por eso y no lo dirían
    try {
      escribirAtomico(selloDe(est, sid), JSON.stringify({
        sesion: String(sid), huella: nueva, previa: s.estado === 'ok' ? s.sello.huella : null, ts: new Date().toISOString(),
      }) + '\n', 0o600);
      fs.mkdirSync(path.dirname(mp), { recursive: true });
      escribirAtomico(mp, contenido);
    } catch (e) {
      return anotarDesacuerdo(est, sid, `no pude escribir el sello o el marcador (${(e && (e.code || e.message)) || 'error'})`);
    }
    return { ok: true, huella: nueva };
  } finally {
    soltarCandado(est, sid);
  }
}

/**
 * ¿El marcador de la sesión coincide con su sello? null si coincide o si no hay marcador (eso lo ve `open-runs.perdida`), o
 * `{ falta }`: `sello`, `sello-ilegible`, `sello-ajeno` o `marcador-cambiado`. Lee sólo el marcador y el sello.
 */
function revisar({ sid, estado, home } = {}) {
  const est = estadoDe(estado, home);
  const textoDelSello = () => { try { return fs.readFileSync(selloDe(est, sid), 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? null : undefined; } };
  // el sello antes y después del marcador: si cambió en medio, otra escritura pasó por ahí y se vuelve a leer
  for (let vuelta = 0; vuelta < 5; vuelta++) {
    const antes = textoDelSello();
    let actual;
    try { actual = fs.readFileSync(marcadorDe(est, sid)); } catch (e) {
      if (e && e.code === 'ENOENT') return null;
      return { falta: 'marcador-cambiado' };
    }
    const despues = textoDelSello();
    if (antes !== despues) continue;
    if (antes === null) return { falta: 'sello' };
    let s;
    try { s = JSON.parse(antes); } catch { s = null; }
    if (!s || typeof s !== 'object' || typeof s.huella !== 'string') return { falta: 'sello-ilegible' };
    if (String(s.sesion) !== String(sid)) return { falta: 'sello-ajeno' };
    const h = huella(actual);
    if (h === s.huella) return null;
    if (h !== s.previa) return { falta: 'marcador-cambiado' };
    // la versión anterior: vale mientras una escritura tiene el candado (escribió el sello y todavía no el marcador)
    if (candadoReciente({ sid, estado: est })) return null;
    dormir(5);
  }
  return { falta: 'marcador-cambiado' };
}

/** Borra el sello de la sesión (al cerrar su ejecución). */
function borrar({ sid, estado, home } = {}) {
  try { fs.unlinkSync(selloDe(estadoDe(estado, home), sid)); } catch { /* no estaba */ }
}

/** Saca los sellos sin marcador de más de 7 días: los dejó un proceso que murió sin cerrar. → cuántos sacó. */
function podarHuerfanos({ estado, home, ahora = Date.now(), dias = HUERFANO_DIAS } = {}) {
  const est = estadoDe(estado, home);
  const dir = path.join(est, 'seals');
  let n = 0;
  let nombres = [];
  try { nombres = fs.readdirSync(dir); } catch { return 0; }
  for (const f of nombres) {
    if (!f.endsWith('.json')) continue;
    if (fs.existsSync(path.join(est, 'active', f))) continue;
    try {
      if (ahora - fs.statSync(path.join(dir, f)).mtimeMs < dias * 86400000) continue;
      fs.unlinkSync(path.join(dir, f));
      n++;
    } catch { /* otro lo sacó, o no se lee: queda */ }
  }
  return n;
}

// Lo que no es el marcador sellado, aunque la búsqueda lo marque. Cada uno con su motivo.
const NO_SON_EL_MARCADOR = {
  'skills/tycon-pipeline/scripts/lib/marker-seal.js': 'es esta librería',
  'scripts/hooks/rebuild-before-verify.js': 'escribe otro marcador: el de reconstruir antes de verificar, uno por repo',
  'scripts/lib/hour-notice.js': 'sólo mira si hay marcador; lo que escribe es su propia marca de aviso',
  'skills/tycon-pipeline/scripts/marker.js:clearMarker': 'escribe el marcador viejo de un solo archivo (active.json), sólo para sacar la entrada de la sesión',
};
const NOMBRA_EL_MARCADOR = /['"`]active['"`/]|ACTIVE_DIR|\(\)\.active\b|markerFilePath|markerPath|markerFile\b/;
const DESTINO_MARCADOR = /marker|marcador/i;
const ESCRITURA = /\bfs\.(writeFileSync|renameSync)\(\s*([^,)]+)(?:,\s*([^,)]+))?/;
const VENTANA = 25;   // renglones antes de la escritura que se miran

/**
 * Las funciones del código del arnés (`skills/` y `scripts/` de `raiz`, sin pruebas, banco ni dependencias) que escriben
 * el marcador por fuera de esta librería: escriben (`writeFileSync`, `renameSync`) y, en la misma función, nombran la
 * carpeta del marcador o escriben a un destino que se llama marcador. → `[{ archivo, funcion, renglon }]`.
 */
function escritoresDelMarcador(raiz) {
  const out = [];
  const recorrer = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', 'tests', 'test', 'controls-bench', '.git'].includes(e.name)) continue;
        recorrer(p);
      } else if (e.isFile() && e.name.endsWith('.js')) {
        revisarArchivo(p);
      }
    }
  };
  const revisarArchivo = (archivo) => {
    const rel = path.relative(raiz, archivo).split(path.sep).join('/');
    if (NO_SON_EL_MARCADOR[rel]) return;
    let lineas;
    try { lineas = fs.readFileSync(archivo, 'utf8').split('\n'); } catch { return; }
    let inicio = 0;
    let nombre = '(archivo)';
    const vistos = new Set();
    lineas.forEach((l, i) => {
      const f = /^(?:async\s+)?function\s+(\w+)/.exec(l);
      if (f) { inicio = i; nombre = f[1]; }
      const w = ESCRITURA.exec(l);
      if (!w) return;
      const destino = w[1] === 'renameSync' ? (w[3] || '') : w[2];
      // lo que la función dice cerca de la escritura: una función larga nombra el marcador para otra cosa
      const cuerpo = lineas.slice(Math.max(inicio, i - VENTANA), i + 1).join('\n');
      if (!NOMBRA_EL_MARCADOR.test(cuerpo) && !DESTINO_MARCADOR.test(destino)) return;
      const id = `${rel}:${nombre}`;
      if (NO_SON_EL_MARCADOR[id] || vistos.has(id)) return;
      vistos.add(id);
      out.push({ archivo: rel, funcion: nombre, renglon: i + 1 });
    });
  };
  for (const d of ['skills', 'scripts']) recorrer(path.join(raiz, d));
  return out;
}

module.exports = { escribir, revisar, leer, borrar, podarHuerfanos, candadoReciente, escritoresDelMarcador, huella, NO_SON_EL_MARCADOR };
