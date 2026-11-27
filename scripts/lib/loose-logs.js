'use strict';
// loose-logs.js — dónde van los registros sueltos de los hooks (el registro del freno, la grabadora de instintos, los
// medidores): en una máquina que vive en la casa propia del arnés, en la carpeta del estado; si no, en la carpeta de
// Claude Code, donde estuvieron siempre. La regla es la de tycon-home.js; su gemela en shell es scripts/lib/state-dir.sh
// (`tycon_logs_dir`), y las compara scripts/tests/state-dir-parity.test.js.
//
// Sin tycon-home.js al lado (un árbol roto) devuelve null: quien escribe no escribe y quien lee no encuentra nada. Un
// registro es ayuda, nunca evidencia, y no hay ruta de respaldo escrita a mano.
//
// `node loose-logs.js --move-old` muda una vez a la carpeta del estado los registros que los hooks dejaron en la carpeta
// de Claude Code antes de que pidieran su casa, para que sus lectores lo encuentren. Lo llama el aplicador
// (install-tycon-hooks.sh). Una integración suma los suyos en su manifiesto (`looseStores`), y con `linkOld` el lugar
// viejo queda como enlace a la carpeta nueva, para lo que de afuera todavía lo nombra.
const fs = require('fs');
const path = require('path');

let TH = null;
try { TH = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js')); } catch (_) { TH = null; }

/** Los registros sueltos que esta regla lleva a la carpeta del estado (los de HOOK_STORES de uninstall.js, menos los de
 *  las integraciones, que los declara cada una en su manifiesto). */
const STORES = ['safety-guard.log', 'tycon-observations', 'blocking-meter', 'lectura-grande', 'response-style', '.tycon-retro-staleness-last-notice'];

/**
 * Los registros sueltos que declaran las integraciones del árbol en su `integration.json`:
 * `"looseStores": [{ "name": "<carpeta o archivo>", "linkOld": true }]`. Con `linkOld`, la mudanza deja en el lugar viejo
 * un enlace (una unión en Windows). Un nombre con barras o que empieza con un punto no se toma. Con `writer` (un guion de
 * la integración), ese registro lo escribe ese comando: el freno de la carpeta del estado lo nombra al frenar una escritura.
 */
function integrationStores(root = path.join(__dirname, '..', '..')) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(path.join(root, 'integrations'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch (_) { return out; }
  for (const d of dirs) {
    let m = null;
    try { m = JSON.parse(fs.readFileSync(path.join(root, 'integrations', d, 'integration.json'), 'utf8')); } catch (_) { continue; }
    for (const s of Array.isArray(m && m.looseStores) ? m.looseStores : []) {
      if (!s || typeof s.name !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(s.name)) continue;
      // `writer`: el comando de la integración que escribe ese registro (relativo a su carpeta, sin subir de ella)
      let writer = typeof s.writer === 'string' && /^[A-Za-z0-9_][A-Za-z0-9._/-]*\.js$/.test(s.writer) && !s.writer.split('/').includes('..')
        ? path.join(root, 'integrations', d, s.writer) : null;
      // un comando que no está no se nombra
      if (writer && !fs.existsSync(writer)) writer = null;
      // el nombre va al mensaje del freno: una línea, corta, de letras comunes
      const label = String(typeof m.label === 'string' ? m.label : d).replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 40) || d;
      out.push({ name: s.name, linkOld: s.linkOld === true, ...(writer ? { writer, label } : {}) });
    }
  }
  return out;
}

/** La carpeta de los registros sueltos para `home` (por defecto, la del usuario), o null sin tycon-home.js. */
function looseLogsDir(home) {
  if (!TH) return null;
  return TH.livesInOwnHome(home) ? TH.ownStateDir(home) : TH.claudeDir(home);
}

/** La ruta de un registro suelto (`name` relativo a esa carpeta), o null. */
function looseLogPath(name, home) {
  const dir = looseLogsDir(home);
  return dir ? path.join(dir, name) : null;
}

const lstat = (p) => { try { return fs.lstatSync(p); } catch (_) { return null; } };

/**
 * Muda a la carpeta del estado cada registro suelto que siga en la carpeta de Claude Code, en una máquina que vive en la
 * casa propia. Renombra (en el mismo disco no copia nada). Nunca pisa ni borra: si el destino ya existe, el viejo queda
 * donde está y se dice. Un enlace no se muda. Un renombre que falla (otro disco, una carpeta en uso) deja el viejo donde
 * está, y el aplicador lo reintenta la próxima vez que corre.
 *
 * Los de una integración con `linkOld` dejan un enlace en el lugar viejo. Si el enlace falla, el renombre se deshace,
 * para que nada quede mirando un lugar vacío. Si el lugar viejo reapareció entre el renombre y el enlace (un gancho de
 * la versión anterior que estaba corriendo), queda la carpeta nueva y el viejo no se toca.
 *
 * `ops` cambia el renombre y el enlace (las pruebas inyectan sus fallas). Devuelve
 * `{ moved: [[desde, hasta, nota]], kept: [[desde, hasta, motivo]] }`.
 */
function moveOld(home, ops = {}) {
  const rename = ops.rename || fs.renameSync;
  const link = ops.link || ((target, at) => TH.makeLink(target, at));
  const out = { moved: [], kept: [] };
  if (!TH || !TH.livesInOwnHome(home)) return out;
  const from = TH.claudeDir(home);
  const to = TH.ownStateDir(home);
  const linked = new Set(integrationStores().filter((s) => s.linkOld).map((s) => s.name));
  for (const name of [...STORES, ...integrationStores().map((s) => s.name)]) {
    const src = path.join(from, name);
    const st = lstat(src);
    if (!st || st.isSymbolicLink()) continue;
    const dst = path.join(to, name);
    if (lstat(dst)) { out.kept.push([src, dst, `${dst} ya existe`]); continue; }
    try { rename(src, dst); } catch (e) { out.kept.push([src, dst, `no pude moverlo (${e.code || e.message}); el aplicador lo reintenta la próxima vez que corra`]); continue; }
    if (!linked.has(name)) { out.moved.push([src, dst, '']); continue; }
    if (lstat(src)) { out.moved.push([src, dst, `; ${src} reapareció mientras lo mudaba: no lo toco ni lo enlazo, juntalos a mano si querés`]); continue; }
    try {
      link(dst, src);
      out.moved.push([src, dst, `; en ${src} queda un enlace a la carpeta nueva`]);
    } catch (e) {
      try { rename(dst, src); out.kept.push([src, dst, `no pude dejar el enlace (${e.code || e.message}): lo devolví a su lugar; el aplicador lo reintenta la próxima vez que corra`]); } catch (e2) { out.moved.push([src, dst, `; no pude dejar el enlace (${e.code || e.message}) ni devolverlo (${e2.code || e2.message}): quedó sólo en la carpeta nueva`]); }
    }
  }
  return out;
}

/**
 * El arranque como programa: con `--move-old`, la mudanza, una línea por registro. Devuelve 0 siempre: nunca frena al
 * aplicador. La corre también la tanda del aplicador de Windows (scripts/setup/applier-batch.js), con la misma respuesta.
 */
function cli(argv) {
  if (!argv.includes('--move-old')) return 0;
  try {
    const r = moveOld();
    for (const [src, dst, note] of r.moved) process.stdout.write(`✓ tycon: mudé ${src} a ${dst} (el historial de un hook, a la carpeta del estado)${note}\n`);
    for (const [src, , why] of r.kept) process.stdout.write(`⚠ tycon: ${src} quedó donde está: ${why} — no piso ni borro historial; juntalos a mano si querés\n`);
  } catch (e) { process.stdout.write(`⚠ tycon: no pude mudar el historial de los hooks (${e.message})\n`); }
  return 0;
}

module.exports = { looseLogsDir, looseLogPath, moveOld, STORES, integrationStores, cli };

if (require.main === module && process.argv.includes('--move-old')) process.exit(cli(process.argv.slice(2)));
