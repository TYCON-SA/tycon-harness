'use strict';
// config-tab-probe.js — arma la pestaña Configuración del sitio con un repo de operaciones y uno del perfil de mentira,
// pide /api/config y escribe en la salida, en JSON, cada texto de la respuesta que dice que algo no se pudo leer.
// Corre igual en el árbol del arnés y dentro de la imagen del sitio (site-image.test.js la monta ahí): lo que falta en
// la imagen y está en el árbol aparece sólo en la segunda.
//
//   node config-tab-probe.js   →   { "secciones": <cuántas>, "perfiles": { minimal, full }, "ilegibles": [ruta: texto] }
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const H = require('./site-harness.js');
const { validarConfiguracion } = require(path.join(ROOT, 'scripts', 'site', 'server.js'));
const ORG = require(path.join(ROOT, 'scripts', 'lib', 'org-config.js'));

const LEAD = 'lead@acme.example';
function repo(archivos) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'config-probe-'));
  const fecha = '2026-01-01T00:00:00Z';
  const env = { ...process.env, GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha };
  const g = (...a) => execFileSync('git', ['-C', d, '-c', 'maintenance.auto=false', '-c', 'user.name=probe', '-c', 'user.email=probe@acme.example', ...a], { stdio: 'ignore', env });
  g('init', '-q', '-b', 'main');
  for (const [rel, c] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), ORG.formatJson(c));
  }
  g('add', '-A'); g('commit', '-q', '--allow-empty', '-m', 'base');
  return d;
}

async function main() {
  const ops = repo({ 'operations.json': { version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD] } } });
  const perfil = repo({ 'team-profile.json': { version: 1, packs: { default: ['bizuit'] } } });
  const f = H.fuentesFijas({ config: { version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD] } } });
  f.clones = () => ({ operaciones: { dir: ops }, perfil: { dir: perfil } });
  f.dirBuzon = fs.mkdtempSync(path.join(os.tmpdir(), 'config-probe-buzon-'));
  f.exclusivo = (fn) => fn();
  const cfg = validarConfiguracion(H.envBase({ SITE_PROFILE_REPO: 'https://git.acme.example/perfil.git', SITE_PROFILE_TOKEN: ['tok', 'perfil'].join('-') })).cfg;
  const rutas = require(path.join(ROOT, 'scripts', 'site', 'tabs', 'config.js')).crearRutas({ cfg, fuentes: f, versionImagen: '2026.10.17.1' });
  const get = rutas.find((r) => r.method === 'GET' && r.path === '/api/config');
  const r = await get.handler({});
  const cuerpo = typeof r.cuerpo === 'string' ? JSON.parse(r.cuerpo) : r.cuerpo;
  const ilegibles = [];
  const recorrer = (x, donde) => {
    if (typeof x === 'string') { if (/no se pudo leer|no está en (el|este) árbol|ENOENT|MODULE_NOT_FOUND/.test(x)) ilegibles.push(`${donde}: ${x}`); return; }
    if (Array.isArray(x)) { x.forEach((y, i) => recorrer(y, `${donde}[${i}]`)); return; }
    if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) recorrer(v, `${donde}.${(x.id && k !== 'id') ? `${x.id}.${k}` : k}`);
  };
  recorrer(cuerpo, '');
  const inst = (cuerpo.secciones || []).find((s) => s.id === 'instalacion');
  const p = (inst && inst.extras && inst.extras.perfiles) || {};
  process.stdout.write(JSON.stringify({ respuesta: process.env.PROBE_FULL ? cuerpo : undefined, secciones: (cuerpo.secciones || []).length, perfiles: { minimal: (p.minimal || []).length, full: (p.full || []).length }, ilegibles }) + '\n');
}

main().catch((e) => { process.stderr.write(`config-tab-probe: ${e.stack || e.message}\n`); process.exit(2); });
