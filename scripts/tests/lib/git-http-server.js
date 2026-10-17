'use strict';
/*
 * git-http-server.js — un repo git por HTTP, local, que EXIGE la cabecera de la credencial (story 2.23, T21).
 *
 * Envuelve `git http-backend` (viene con git) en un servidor de Node en http://127.0.0.1:<puerto>. Todo pedido sin la
 * cabecera `Authorization` esperada contesta 401; con `caido = true`, 503. NUNCA habla con la red.
 *
 *   const s = await arrancarRepoHttp({ raiz, cabecera });   // raiz: carpeta con <nombre>.git bare
 *   s.url('ops.git') · s.pedidos (ruta, con o sin la cabecera) · s.caido = true · await s.cerrar()
 */
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

/** ¿Este git trae `http-backend`? Contesta a un pedido de un repo que no existe con su cabecera CGI («Status: 404»). */
function tieneHttpBackend(git) {
  const r = spawnSync(git, ['http-backend'], { env: { ...process.env, REQUEST_METHOD: 'GET', GIT_PROJECT_ROOT: path.join(path.sep, 'nonexistent'), PATH_INFO: '/x/info/refs' }, encoding: 'utf8', timeout: 10000 });
  return !r.error && /Status:|Content-Type/.test(`${r.stdout}`);
}

let gitServidor;
/**
 * El git con el que se sirve el repo: el del PATH si trae `http-backend`; si no, en Windows, otro de la máquina que sí
 * lo traiga (el agente de CI pone primero en el PATH un git mínimo sin él, y Git para Windows completo queda después).
 * null si no hay ninguno.
 */
function gitConBackend() {
  if (gitServidor !== undefined) return gitServidor;
  const candidatos = ['git'];
  if (process.platform === 'win32') {
    const w = spawnSync('where.exe', ['git'], { encoding: 'utf8', timeout: 10000 });
    candidatos.push(...String(w.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
    for (const base of [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) candidatos.push(path.join(base, 'Git', 'cmd', 'git.exe'));
  }
  gitServidor = candidatos.find((g) => tieneHttpBackend(g)) || null;
  return gitServidor;
}

function hayHttpBackend() {
  return gitConBackend() !== null;
}

async function arrancarRepoHttp({ raiz, cabecera }) {
  const pedidos = [];
  const estado = { caido: false };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const conCabecera = req.headers.authorization === cabecera;
    pedidos.push({ ruta: u.pathname, conCabecera, auth: req.headers.authorization || null, query: u.search });
    if (estado.caido) { res.writeHead(503); res.end('caído'); return; }
    if (!conCabecera) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="ops"' }); res.end('sin credencial'); return; }
    const cgi = spawn(gitConBackend() || 'git', ['http-backend'], {
      env: { ...process.env, GIT_PROJECT_ROOT: raiz, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1), REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] || '', REMOTE_USER: 'prueba', REMOTE_ADDR: '127.0.0.1', HTTP_CONTENT_ENCODING: req.headers['content-encoding'] || '', HTTP_GIT_PROTOCOL: req.headers['git-protocol'] || '' },
    });
    req.pipe(cgi.stdin);
    let cab = Buffer.alloc(0); let cabLista = false;
    cgi.stdout.on('data', (c) => {
      if (cabLista) { res.write(c); return; }
      cab = Buffer.concat([cab, c]);
      const i = cab.indexOf('\r\n\r\n');
      const j = i < 0 ? cab.indexOf('\n\n') : -1;
      const corte = i >= 0 ? i : j;
      if (corte < 0) return;
      const sep = i >= 0 ? 4 : 2;
      const lineas = cab.slice(0, corte).toString('utf8').split(/\r?\n/);
      let status = 200; const headers = {};
      for (const l of lineas) {
        const k = l.indexOf(':');
        if (k < 0) continue;
        const n = l.slice(0, k).trim(); const v = l.slice(k + 1).trim();
        if (n.toLowerCase() === 'status') status = Number(v.split(' ')[0]) || 200; else headers[n] = v;
      }
      res.writeHead(status, headers);
      cabLista = true;
      res.write(cab.slice(corte + sep));
    });
    cgi.on('close', () => res.end());
    cgi.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, pedidos,
    url: (nombre) => `${base}/${nombre}`,
    get caido() { return estado.caido; },
    set caido(v) { estado.caido = v; },
    cerrar: () => new Promise((r) => { server.close(() => r()); if (server.closeAllConnections) server.closeAllConnections(); }),
  };
}

/** Un repo bare `<raiz>/<nombre>` con una rama main y los archivos dados ({ ruta: contenido }). Devuelve el clon de trabajo. */
function repoConArchivos(raiz, nombre, archivos, trabajo) {
  // fechas fijas (el sha sale siempre igual) y sin el mantenimiento automático de git, que tocaría el .git del laboratorio
  const g = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@acme.example', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@acme.example', GIT_AUTHOR_DATE: '2026-10-15T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-15T12:00:00Z' } }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout; };
  const bare = path.join(raiz, nombre);
  g(raiz, 'init', '-q', '--bare', '-b', 'main', bare);
  g(bare, 'config', 'http.receivepack', 'true');
  g(raiz, 'init', '-q', '-b', 'main', trabajo);
  escribir(trabajo, archivos);
  g(trabajo, 'add', '-A'); g(trabajo, 'commit', '-q', '-m', 'base');
  g(trabajo, 'remote', 'add', 'origin', bare);
  g(trabajo, 'push', '-q', 'origin', 'main');
  return {
    bare, trabajo,
    /** Un commit más con estos archivos (null borra), empujado a main. */
    cambiar(cambios) { escribir(trabajo, cambios); g(trabajo, 'add', '-A'); g(trabajo, 'commit', '-q', '-m', 'cambio'); g(trabajo, 'push', '-q', 'origin', 'main'); },
  };
}

function escribir(dir, archivos) {
  const fs = require('fs');
  for (const [rel, contenido] of Object.entries(archivos)) {
    const p = path.join(dir, rel);
    if (contenido === null) { fs.rmSync(p, { force: true }); continue; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof contenido === 'string' ? contenido : `${JSON.stringify(contenido, null, 2)}\n`);
  }
}

module.exports = { arrancarRepoHttp, repoConArchivos, hayHttpBackend };
