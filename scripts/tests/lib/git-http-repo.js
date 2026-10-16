'use strict';
/*
 * git-http-repo.js — un repo git local servido por HTTP que ANOTA cada empuje (story 2.29, T15, T18, T26, T27).
 *
 * Envuelve lib/git-http-server.js (el `git http-backend` que exige la cabecera) y le suma lo que las pruebas de la
 * propuesta por rama y pedido necesitan ver: qué refs se empujaron, desde qué commit hasta cuál y si fue forzado. Lo
 * anota un hook `post-receive` del repo bare, que escribe una línea JSON por ref en `<bare>/empujes.jsonl`; `empujes`
 * la lee. «Forzado» = el commit anterior de la ref no es ancestro del nuevo (`git merge-base --is-ancestor`).
 *
 *   const r = await crearRepoHttp({ raiz, nombre: 'ops.git', archivos: { 'operations.json': {...} }, cabecera });
 *   r.url · r.bare · r.trabajo · r.empujes · r.pedidos · r.ref(nombre) · r.oidDe(ref, ruta) · r.archivoEn(ref, ruta)
 *   r.cambiar({ ruta: contenido | null }) · r.rechazarEmpuje = 403 · await r.cerrar()
 *
 * `rechazarEmpuje`: con un código, el servidor contesta ESE código a todo pedido de `git-receive-pack` (el empuje), sin
 * tocar las lecturas: es el «403 al crear la rama» del AC 18. Se hace con un servidor de adelante que reenvía al de
 * git-http-server.js, así ese archivo no cambia. NUNCA habla con la red.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { arrancarRepoHttp, repoConArchivos, hayHttpBackend } = require('./git-http-server.js');

const CERO = '0000000000000000000000000000000000000000';
/** Los empujes locales de `cambiar` (la prueba moviendo main) no se anotan: el hook mira esta variable. */
const SILENCIO = 'GIT_HTTP_REPO_SILENCIO';

function escribirHook(bare) {
  const archivo = path.join(bare, 'empujes.jsonl');
  const hook = `#!/bin/bash
# anota cada ref empujada: antes, después y si fue forzado (lib/git-http-repo.js)
[ -n "\${${SILENCIO}:-}" ] && exit 0
while read -r antes despues ref; do
  forzado=false
  if [ "$antes" != "${CERO}" ] && [ "$despues" != "${CERO}" ]; then
    git merge-base --is-ancestor "$antes" "$despues" 2>/dev/null || forzado=true
  fi
  if [ "$antes" = "${CERO}" ]; then antes_json=null; else antes_json="\\"$antes\\""; fi
  printf '{"ref":"%s","antes":%s,"despues":"%s","forzado":%s}\\n' "$ref" "$antes_json" "$despues" "$forzado" >> "${archivo}"
done
exit 0
`;
  fs.mkdirSync(path.join(bare, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(bare, 'hooks', 'post-receive'), hook, { mode: 0o755 });
  // 🔴 un `core.hooksPath` global de la máquina (los hooks del dev) taparía el hook del bare: se fija el del repo
  const r = spawnSync('git', ['-C', bare, 'config', 'core.hooksPath', path.join(bare, 'hooks')], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git config core.hooksPath: ${r.stderr}`);
  return archivo;
}

async function crearRepoHttp({ raiz, nombre = 'ops.git', archivos = {}, cabecera }) {
  const repo = repoConArchivos(raiz, nombre, archivos, path.join(raiz, `${nombre.replace(/\.git$/, '')}-trabajo`));
  const archivoEmpujes = escribirHook(repo.bare);
  const interno = await arrancarRepoHttp({ raiz, cabecera });
  const estado = { rechazarEmpuje: null };
  const ipInterno = new URL(interno.base);
  // el servidor de adelante: reenvía todo al interno, salvo el empuje cuando `rechazarEmpuje` tiene un código
  const frente = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const esEmpuje = /\/git-receive-pack$/.test(u.pathname) || u.searchParams.get('service') === 'git-receive-pack';
    if (esEmpuje && estado.rechazarEmpuje) {
      interno.pedidos.push({ ruta: u.pathname, conCabecera: req.headers.authorization === cabecera, auth: req.headers.authorization || null, query: u.search, rechazado: estado.rechazarEmpuje });
      req.resume();
      res.writeHead(estado.rechazarEmpuje, { 'Content-Type': 'text/plain' }); res.end('sin permiso para escribir');
      return;
    }
    const p = http.request({ host: ipInterno.hostname, port: ipInterno.port, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(p);
  });
  await new Promise((r) => frente.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${frente.address().port}`;
  const g = (args, env = {}) => spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { cwd: repo.trabajo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@acme.example', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@acme.example', GIT_AUTHOR_DATE: '2026-10-15T13:00:00Z', GIT_COMMITTER_DATE: '2026-10-15T13:00:00Z', ...env } });
  const enBare = (args) => spawnSync('git', ['-C', repo.bare, ...args], { encoding: 'utf8' });
  return {
    url: `${base}/${nombre}`,
    base,
    bare: repo.bare,
    trabajo: repo.trabajo,
    pedidos: interno.pedidos,
    get empujes() {
      let t = '';
      try { t = fs.readFileSync(archivoEmpujes, 'utf8'); } catch { return []; }
      return t.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    get rechazarEmpuje() { return estado.rechazarEmpuje; },
    set rechazarEmpuje(v) { estado.rechazarEmpuje = v || null; },
    /** El sha de una ref del bare, o null. */
    ref(nombreRef) { const r = enBare(['rev-parse', '--verify', '--quiet', `${nombreRef}^{commit}`]); return r.status === 0 ? r.stdout.trim() : null; },
    /** El identificador de objeto de un archivo en una ref, o null. */
    oidDe(nombreRef, ruta) { const r = enBare(['rev-parse', '--verify', '--quiet', `${nombreRef}:${ruta}`]); return r.status === 0 ? r.stdout.trim() : null; },
    /** El contenido de un archivo en una ref (`git show`), o null. */
    archivoEn(nombreRef, ruta) { const r = enBare(['show', `${nombreRef}:${ruta}`]); return r.status === 0 ? r.stdout : null; },
    /** Un commit más en main con estos archivos (null borra), empujado al bare sin anotarse como empuje. */
    cambiar(cambios) {
      for (const [rel, contenido] of Object.entries(cambios)) {
        const p = path.join(repo.trabajo, rel);
        if (contenido === null) { fs.rmSync(p, { force: true }); continue; }
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, typeof contenido === 'string' ? contenido : `${JSON.stringify(contenido, null, 2)}\n`);
      }
      for (const args of [['add', '-A'], ['commit', '-q', '-m', 'cambio'], ['push', '-q', 'origin', 'main']]) {
        const r = g(args, { [SILENCIO]: '1' });
        if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      }
    },
    cerrar: async () => {
      await new Promise((r) => { frente.close(() => r()); if (frente.closeAllConnections) frente.closeAllConnections(); });
      await interno.cerrar();
    },
  };
}

module.exports = { crearRepoHttp, hayHttpBackend };
