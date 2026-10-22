#!/usr/bin/env node
'use strict';
/**
 * lib/tmp-path.js — la ruta de un archivo temporal que un paso del pipeline escribe con bash y lee con Node. UN lugar.
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────────
 * El paso «Probar en vivo» y el aviso de `on-frontmatter-write.js` escriben la configuración de E2E con una redirección de bash y
 * la leen con Node. Con un archivo fijo bajo `/tmp` y un `require()` de esa misma ruta escrita a mano, en Mac y Linux es el
 * mismo archivo. En Windows no: el bash de Git traduce `/tmp` a la carpeta temporal del usuario, y Node, que no conoce
 * esa traducción, lee `C:\tmp\…`. El portón E2E quedaría sin configuración y el paso se saltaría sin decirlo.
 * La ruta la arma Node (que sabe cuál es la carpeta temporal de la máquina) y se guarda en una variable; quien
 * escribe y quien lee usan esa variable:
 *
 *   E2ECFG=$(node <skill>/scripts/lib/tmp-path.js e2ecfg <repo>)
 *   node <skill>/scripts/pipeline.js e2e-config --repo <repo> > "$E2ECFG"
 *   GATE=$(node -e 'process.stdout.write(require(process.argv[1]).gate||"")' "$E2ECFG")
 *
 * ── UN ARCHIVO POR REPO Y POR SESIÓN ────────────────────────────────────────────────────────────
 * El nombre lleva una huella del repo (su ruta real) y de la sesión (`lib/session-id.js`):
 * `tycon-e2ecfg-<12 hex>.json`. Con un nombre fijo, dos pipelines a la vez (dos worktrees, dos sesiones) escribirían el
 * mismo archivo, y uno correría el portón E2E y las apps del repo del otro. La huella NO depende del proceso: otra llamada de Bash de la misma sesión, sobre
 * el mismo repo, llega al mismo archivo —quien escribe y quien lee siguen viendo la misma ruta aunque estén en dos
 * bloques distintos—. Sin repo, vale la carpeta de trabajo.
 *
 * En Windows la ruta va con barras `/` (`C:/Users/…/Temp/tycon-e2ecfg-….json`): la entienden igual el bash de Git y
 * Node. La plataforma, la carpeta temporal, el repo y la sesión se inyectan (`ctx`): así se prueba sin un Windows.
 *
 * Uso: node lib/tmp-path.js <nombre> [<repo>]     → imprime la ruta (exit 2 si el nombre no es una palabra simple)
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME_RX = /^[a-z0-9][a-z0-9-]*$/i;

/** La ruta real del repo (resuelve enlaces); si no existe, la absoluta. Sin barra final. */
function repoKey(repo, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  let r = p.resolve(String(repo));
  try { r = (platform === 'win32' ? fs.realpathSync.native : fs.realpathSync)(r); } catch (_) { /* no existe: la absoluta */ }
  if (platform === 'win32') r = r.replace(/\\/g, '/').toLowerCase();   // en Windows la ruta no distingue mayúsculas
  return r.length > 1 ? r.replace(/\/+$/, '') : r;
}

/**
 * La ruta de `<carpeta temporal>/tycon-<nombre>-<huella>.json`.
 * @param {string} name  una palabra simple (letras, números y guiones): `e2ecfg`
 * @param {{platform?: string, tmpdir?: string, repo?: string, session?: string}} [ctx]  lo que no se pasa sale de la
 *   máquina: la carpeta de trabajo y la sesión de `lib/session-id.js`
 */
function tmpPath(name, ctx = {}) {
  if (typeof name !== 'string' || !NAME_RX.test(name)) {
    throw new Error(`tmp-path: el nombre tiene que ser una palabra simple (letras, números y guiones), no ${JSON.stringify(name)}`);
  }
  const platform = ctx.platform || process.platform;
  const dir = ctx.tmpdir || os.tmpdir();
  const session = ctx.session !== undefined ? String(ctx.session) : require('./session-id.js').resolveSessionId();
  const huella = crypto.createHash('sha256')
    .update(`${repoKey(ctx.repo || process.cwd(), platform)}\0${session}`)
    .digest('hex').slice(0, 12);
  const file = `tycon-${name}-${huella}.json`;
  if (platform === 'win32') return path.win32.join(dir, file).replace(/\\/g, '/');
  return path.posix.join(dir, file);
}

module.exports = { tmpPath };

if (require.main === module) {
  try {
    const [name, repo] = process.argv.slice(2);
    process.stdout.write(`${tmpPath(name, { repo: repo || undefined })}\n`);
  } catch (e) {
    process.stderr.write(`${e.message}\nuso: node tmp-path.js <nombre> [<repo>]\n`);
    process.exit(2);
  }
}
